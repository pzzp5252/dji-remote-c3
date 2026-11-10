#!/usr/bin/env python3
"""Conservative, read-only journal/media matching; no camera clock is assumed UTC."""

import argparse
import bisect
import copy
import json
import math
from pathlib import Path
import re
import statistics
import sys

if __package__:
    from .inspect_mp4 import discover, inspect_file, write_report
    from .usb_manage import backup_tuple
else:
    from inspect_mp4 import discover, inspect_file, write_report
    from usb_manage import backup_tuple

EPOCH_1904_TO_UNIX = 2082844800
SPLIT_BYTES = 14 * 1024 ** 3
START_TOLERANCE = 15.0


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _anomaly(code, **fields):
    return {"code": code, **fields}


def _utc(anchors, boot_id, mono_ms):
    if not _number(mono_ms) or not anchors.get(boot_id):
        return None
    anchor = min(anchors[boot_id], key=lambda item: abs(item["mono_ms"] - mono_ms))
    return (anchor["utc_ms"] + mono_ms - anchor["mono_ms"]) / 1000.0


def load_journal(jsonl_path):
    """Fold complete JSONL, applying last discard/reassign and late same-boot anchors.

    Return project_id/template_id/events/takes/anchors/anomalies/backup_tuple.
    Each take retains begin/end events and original and final action attribution.
    """
    data = Path(jsonl_path).read_bytes()
    identity = backup_tuple(data)
    events = [json.loads(line) for line in data.splitlines()]
    anchors, takes, anomalies = {}, {}, []
    template_id = events[0]["template_id"] if events else ""
    for event in events:
        if not isinstance(event.get("boot_id"), str) or not _number(event.get("mono_ms")):
            raise ValueError("invalid event boot/monotonic time")
        anchor = event.get("time_anchor")
        if anchor is not None:
            if (not isinstance(anchor, dict) or anchor.get("boot_id") != event["boot_id"] or
                    not _number(anchor.get("mono_ms")) or not _number(anchor.get("utc_ms"))):
                raise ValueError("invalid or cross-boot time anchor")
            known = anchors.setdefault(anchor["boot_id"], [])
            if anchor not in known:
                known.append(copy.deepcopy(anchor))
        kind = event["type"]
        if kind == "SELECT_ACTION":
            continue
        take_id = event.get("take_id")
        if kind == "TAKE_BEGIN":
            if take_id in takes:
                raise ValueError("duplicate TAKE_BEGIN: " + str(take_id))
            takes[take_id] = {
                "take_id": take_id, "project_id": identity["project_id"],
                "template_id": template_id,
                "initial_action_id": event.get("action_id", ""),
                "initial_point_id": event.get("point_id", ""),
                "action_id": event.get("action_id", ""), "point_id": event.get("point_id", ""),
                "source": event.get("source"), "participants": event.get("participants", 0),
                "boot_id": event["boot_id"], "begin_boot_id": event["boot_id"],
                "begin_mono_ms": event["mono_ms"], "end_boot_id": None, "end_mono_ms": None,
                "begin": copy.deepcopy(event), "end": None, "discarded": False,
                "time_anchor": None,
                "complete": False, "reason": "missing_end", "cameras": [{}, {}],
                "history": [], "anomalies": [],
            }
            continue
        if take_id not in takes:
            raise ValueError("event references a take without BEGIN: " + str(take_id))
        take = takes[take_id]
        if kind == "TAKE_END":
            if take["end"] is not None:
                raise ValueError("duplicate TAKE_END: " + str(take_id))
            if (event.get("begin_boot_id") != take["boot_id"] or
                    event.get("begin_mono_ms") != take["begin_mono_ms"]):
                raise ValueError("TAKE_END begin identity mismatch")
            cameras = event.get("cameras")
            if not isinstance(cameras, list) or len(cameras) != 2 or not all(isinstance(c, dict) for c in cameras):
                raise ValueError("TAKE_END must contain A/B camera evidence")
            take.update(end=copy.deepcopy(event), end_boot_id=event["boot_id"],
                        end_mono_ms=event["mono_ms"], complete=event.get("complete") is True,
                        reason=event.get("reason"), cameras=copy.deepcopy(cameras))
        elif kind == "MARK_DISCARD":
            if type(event.get("discard")) is not bool:
                raise ValueError("invalid discard flag")
            take["discarded"] = event["discard"]
            take["history"].append(copy.deepcopy(event))
        elif kind == "REASSIGN":
            take["action_id"] = event.get("action_id", "")
            take["point_id"] = event.get("point_id", "")
            take["history"].append(copy.deepcopy(event))
    for boot_id, values in anchors.items():
        offsets = [item["utc_ms"] - item["mono_ms"] for item in values]
        if max(offsets) - min(offsets) > 2000:
            anomalies.append(_anomaly("anchor_clock_adjustment", boot_id=boot_id, offsets_ms=offsets))
    for take in takes.values():
        take["begin_utc_sec"] = _utc(anchors, take["boot_id"], take["begin_mono_ms"])
        take["end_utc_sec"] = _utc(anchors, take["end_boot_id"], take["end_mono_ms"])
        take["time_anchors"] = copy.deepcopy(anchors.get(take["boot_id"], []))
        if take["time_anchors"]:
            take["time_anchor"] = copy.deepcopy(min(take["time_anchors"],
                key=lambda anchor: abs(anchor["mono_ms"] - take["begin_mono_ms"])))
        if take["end"] is None:
            take["anomalies"].append(_anomaly("missing_end"))
        if take["end_boot_id"] == take["boot_id"] and take["end_mono_ms"] >= take["begin_mono_ms"]:
            take["controller_duration_sec"] = (take["end_mono_ms"] - take["begin_mono_ms"]) / 1000.0
        else:
            take["controller_duration_sec"] = None
            if take["end"]:
                take["anomalies"].append(_anomaly("cross_boot_end"))
        take["camera_timing"] = {}
        for camera, evidence in zip(("A", "B"), take["cameras"]):
            timing = _observed_timing(evidence)
            # Evidence belongs to the BEGIN boot, including a recovered END.
            timing["start_utc_sec"] = _utc(anchors, take["boot_id"], timing["start_mono_ms"])
            timing["end_utc_sec"] = _utc(anchors, take["boot_id"], timing["end_mono_ms"])
            take["camera_timing"][camera] = timing
        observed_durations = [timing["duration_sec"] for timing in take["camera_timing"].values()
                              if timing["observed"] and timing["duration_sec"] is not None and
                              timing["duration_source"] != "missing_recording_observations_fallback"]
        take["duration_sec"] = (statistics.median(observed_durations) if observed_durations
                                else take["controller_duration_sec"])
        take["duration_source"] = ("recording_observations" if observed_durations
                                   else "controller_begin_end_fallback")
    return {"schema_version": 1, "project_id": identity["project_id"], "template_id": template_id,
            "events": events, "takes": sorted(takes.values(), key=lambda item: item["take_id"]),
            "anchors": anchors, "anomalies": anomalies, "backup_tuple": identity}


def _scan_camera(inputs, camera, recursive):
    """Inspect one camera without conflating its clock or candidate identity."""
    if isinstance(inputs, (str, Path)):
        inputs = [str(inputs)]
    paths, errors = discover([str(item) for item in inputs], recursive)
    files, duplicates, seen = [], [], {}
    for path in paths:
        report = inspect_file(path, camera=camera)
        movie = report.get("movie") or {}
        timing = movie.get("duration") or {}
        duration = None
        if timing.get("timescale") and not timing.get("is_unknown"):
            duration = timing["numerator"] / timing["timescale"]
        creation = (movie.get("creation_time") or {}).get("raw_seconds_since_1904")
        modification = (movie.get("modification_time") or {}).get("raw_seconds_since_1904")
        report.update(creation_raw=creation, modification_raw=modification, duration_sec=duration,
                      creation_unix_sec=creation - EPOCH_1904_TO_UNIX if creation is not None else None,
                      duplicate_paths=[])
        key = (camera, report["name"], report["file_size"], creation,
               round(duration, 3) if duration is not None else None)
        report["dedup_key"] = list(key)
        # An unreadable container is never collapsed into an apparently healthy one.
        if not report["errors"] and key in seen:
            canonical = seen[key]
            canonical["duplicate_paths"].append(report["path"])
            duplicates.append({"path": report["path"], "canonical_path": canonical["path"], "dedup_key": list(key)})
        else:
            files.append(report)
            if not report["errors"]:
                seen[key] = report
    return {"camera": camera, "files": files, "duplicates": duplicates, "errors": errors}


def scan_media(paths_a, paths_b, recursive=False):
    """Return independent A/B inventories, each with files/duplicates/errors."""
    return {"A": _scan_camera(paths_a, "A", recursive),
            "B": _scan_camera(paths_b, "B", recursive)}


def _part_name(name):
    stem = Path(name).stem
    match = re.match(r"^(.*?)[_. -](?:part|segment|seg)[_. -]?(\d+)(.*)$", stem, re.I)
    if match:
        return (match[1].casefold(), match[3].casefold()), int(match[2])
    match = re.match(r"^(DJI_\d{14})_(\d{3,4})(_[A-Za-z]+)?$", stem, re.I)
    if match:
        return (match[1].casefold(), (match[3] or "").casefold()), int(match[2])
    return None


def _file_start(file, hypothesis):
    stamp = file.get("creation_unix_sec")
    if stamp is None and file.get("creation_raw") is not None:
        stamp = file["creation_raw"] - EPOCH_1904_TO_UNIX
    if stamp is None or not _number(file.get("duration_sec")):
        return None
    return stamp - file["duration_sec"] if hypothesis == "end" else stamp


def group_split_parts(clips, timestamp_hypothesis="start"):
    """Return conservative clip groups; every canonical input file occurs exactly once.

    Continuity requires <=2s absolute end/start gap plus a >=14GiB preceding
    part or same explicit segment family with consecutive segment numbers.
    """
    if timestamp_hypothesis not in ("start", "end"):
        raise ValueError("timestamp hypothesis must be start or end")
    files = clips
    ordered = sorted(files, key=lambda item: (item.get("camera", "unknown"),
                     _file_start(item, timestamp_hypothesis) is None,
                     _file_start(item, timestamp_hypothesis) or 0, item["path"]))
    following, preceding = {}, {}
    for index, previous in enumerate(ordered):
        start = _file_start(previous, timestamp_hypothesis)
        if start is None or previous.get("errors"):
            continue
        end = start + previous["duration_sec"]
        for other_index in range(index + 1, len(ordered)):
            current = ordered[other_index]
            if current.get("camera") != previous.get("camera"):
                break
            current_start = _file_start(current, timestamp_hypothesis)
            if current_start is None or current_start > end + 2:
                break
            if current.get("errors") or abs(current_start - end) > 2:
                continue
            a, b = _part_name(previous["name"]), _part_name(current["name"])
            named = a is not None and b is not None and a[0] == b[0] and b[1] == a[1] + 1
            if (previous.get("file_size") or 0) >= SPLIT_BYTES or named:
                following.setdefault(index, []).append(other_index)
                preceding.setdefault(other_index, []).append(index)
    links = {i: values[0] for i, values in following.items()
             if len(values) == 1 and len(preceding.get(values[0], [])) == 1}
    consumed, groups = set(), []
    for index, file in enumerate(ordered):
        if index in consumed:
            continue
        parts, part_indices, cursor = [], [], index
        while cursor not in consumed:
            consumed.add(cursor)
            part_indices.append(cursor)
            parts.append(ordered[cursor])
            if cursor not in links:
                break
            cursor = links[cursor]
        starts = [_file_start(part, timestamp_hypothesis) for part in parts]
        valid = all(value is not None for value in starts)
        durations = [part.get("duration_sec") for part in parts]
        usable = valid and all(_number(value) and value > 0 for value in durations)
        errors = [error for part in parts for error in part.get("errors", [])]
        anomalies = []
        if any(len(following.get(part_index, [])) > 1 or
               len(preceding.get(part_index, [])) > 1 for part_index in part_indices):
            anomalies.append(_anomaly("ambiguous_split_continuation"))
        groups.append({"group_id": "{}:{:04d}".format(file.get("camera", "unknown"), len(groups) + 1),
                       "camera": file.get("camera", "unknown"), "parts": parts,
                       "paths": [part["path"] for part in parts],
                       "duration_sec": sum(durations) if usable else None,
                       "camera_start_sec": starts[0] if usable else None,
                       "camera_end_sec": starts[-1] + durations[-1] if usable else None,
                       "timestamp_hypothesis": timestamp_hypothesis, "errors": errors,
                       "anomalies": anomalies, "status": "corrupt" if errors else "candidate"})
    return groups


def _camera_name(camera_idx):
    if type(camera_idx) is not int or camera_idx not in (0, 1):
        raise ValueError("camera_idx must be 0 (A) or 1 (B)")
    return ("A", "B")[camera_idx]


def _observed_timing(evidence):
    """Prefer recording observations; retain raw camera timer without guessing units."""
    observed = evidence.get("seen_recording") is True
    first = evidence.get("first_record_ms") if observed else None
    last = evidence.get("last_record_ms") if observed else None
    first = first if _number(first) else None
    last = last if _number(last) else None
    raw_timer = evidence.get("record_time")
    duration = None
    duration_source = None
    start, stop = first, last
    start_source = "first_record_ms" if first is not None else None
    stop_source = "last_record_ms" if last is not None else None
    if first is not None and last is not None and last >= first:
        duration = (last - first) / 1000.0
        duration_source = "recording_observation_span"
        # record_time's units are not a firmware contract. Use a seconds reading
        # only when corroborated by a nonzero observed recording interval.
        if (duration > 0 and _number(raw_timer) and raw_timer > 0 and
                abs(raw_timer - duration) <= max(5.0, duration * 0.25)):
            duration = float(raw_timer)
            duration_source = "record_time_seconds_corroborated_by_observations"
    if start is None:
        start = evidence.get("start_ms")
        start = start if _number(start) else None
        start_source = "start_ms_fallback" if start is not None else None
    if stop is None:
        for key in ("stopped_ms", "stop_ms"):
            value = evidence.get(key)
            if _number(value):
                stop, stop_source = value, key + "_fallback"
                break
    if duration is None and start is not None and stop is not None and stop >= start:
        duration = (stop - start) / 1000.0
        duration_source = "missing_recording_observations_fallback"
    return {"start_mono_ms": start, "end_mono_ms": stop,
            "duration_sec": duration, "observed": observed,
            "start_source": start_source, "end_source": stop_source,
            "duration_source": duration_source, "record_time_raw": raw_timer}


def _timing(take, camera):
    evidence = take.get("cameras", [{}, {}])[0 if camera == "A" else 1]
    anchor = take.get("time_anchor")
    anchors = {take["boot_id"]: [anchor]} if anchor and anchor.get("boot_id") == take["boot_id"] else {}
    timing = take.get("camera_timing", {}).get(camera)
    if timing is None:
        timing = _observed_timing(evidence)
        timing["start_utc_sec"] = _utc(anchors, take["boot_id"], timing["start_mono_ms"])
    start = timing.get("start_utc_sec")
    start_source = timing.get("start_source")
    if start is None:
        start = _utc(anchors, take["boot_id"], take.get("begin_mono_ms"))
        start_source = "take_begin_fallback"
    duration = timing.get("duration_sec")
    duration_source = timing.get("duration_source")
    if duration is None and take.get("end_boot_id", take["boot_id"]) == take["boot_id"]:
        begin, end = take.get("begin_mono_ms"), take.get("end_mono_ms")
        if _number(begin) and _number(end) and end >= begin:
            duration = (end - begin) / 1000.0
            duration_source = "controller_begin_end_fallback"
    participants = take.get("participants", 0)
    participating = evidence.get("participating", bool(participants & (1 if camera == "A" else 2)))
    observed = timing.get("observed", evidence.get("seen_recording") is True)
    return {"participating": participating, "observed": observed, "start": start, "duration": duration,
            "start_source": start_source, "duration_source": duration_source,
            "healthy": take.get("complete") is True and evidence.get("stop_confirmed") is True and observed and
                       not any(evidence.get(key) for key in ("unknown", "disconnected", "stale", "unexpected_stop", "restarted"))}


def _duration_ok(actual, expected, calibration=False):
    return (_number(actual) and _number(expected) and actual > 0 and expected > 0 and
            abs(actual - expected) <= max(5.0 if calibration else 4.0,
                                          (0.25 if calibration else 0.20) * expected))


def _chain(candidates):
    """One maximum strictly monotonic sparse chain, O(edges log groups)."""
    ends, paths = [], []
    staged = []
    last_take = None
    def commit():
        for group_index, chain in staged:
            index = bisect.bisect_left(ends, group_index)
            if index == len(ends):
                ends.append(group_index)
                paths.append(chain)
            elif group_index < ends[index]:
                ends[index], paths[index] = group_index, chain
        staged.clear()
    for candidate in sorted(candidates, key=lambda item: (item[0], item[1])):
        i, j = candidate[:2]
        if last_take is not None and last_take != i:
            commit()
        previous = bisect.bisect_left(ends, j) - 1
        staged.append((j, (paths[previous] if previous >= 0 else []) + [candidate]))
        last_take = i
    commit()
    return paths[-1] if paths else []


def _calibrate_camera(takes, clips, camera):
    """Infer one camera's offset (camera calendar minus controller UTC).

    Compare start/end-creation hypotheses by median offsets and residual variance
    on healthy, observed duration-compatible takes. Competing equally supported
    offset clusters remain pending; a single observation never calibrates clocks.
    """
    takes = sorted(takes, key=lambda take: take["take_id"])
    models = []
    for hypothesis in ("start", "end"):
        groups = group_split_parts(clips, hypothesis)
        candidates = []
        for i, take in enumerate(takes):
            timing = _timing(take, camera)
            if not timing["healthy"] or timing["start"] is None:
                continue
            for j, group in enumerate(groups):
                if group["errors"] or group["camera_start_sec"] is None:
                    continue
                if _duration_ok(group["duration_sec"], timing["duration"], True):
                    candidates.append((i, j, group["camera_start_sec"] - timing["start"]))
        # Nearby buckets produce the same offset fit; retain distinct supported fits.
        centers = sorted({round(item[2] / START_TOLERANCE) * START_TOLERANCE for item in candidates})
        fits = []
        for center in centers:
            chain = _chain([item for item in candidates if abs(item[2] - center) <= START_TOLERANCE])
            if len(chain) < 2:
                continue
            offset = statistics.median(item[2] for item in chain)
            residuals = [item[2] - offset for item in chain]
            variance = statistics.mean(value * value for value in residuals)
            fits.append({"timestamp_hypothesis": hypothesis, "offset_sec": offset,
                         "variance_sec2": variance, "samples": len(chain),
                         "evidence": [{"take_id": takes[i]["take_id"], "group_id": groups[j]["group_id"],
                                       "offset_sec": delta} for i, j, delta in chain]})
        if fits:
            best_samples = max(fit["samples"] for fit in fits)
            fits = [fit for fit in fits if fit["samples"] == best_samples]
            fits.sort(key=lambda fit: fit["variance_sec2"])
            best = fits[0]
            competing = [fit for fit in fits if abs(fit["offset_sec"] - best["offset_sec"]) > START_TOLERANCE and
                         fit["variance_sec2"] <= best["variance_sec2"] + 1.0]
            best["ambiguous_offset"] = bool(competing)
            best["competing_offsets_sec"] = sorted({fit["offset_sec"] for fit in competing})
            models.append(best)
    usable = [model for model in models if not model["ambiguous_offset"]]
    if not usable:
        return {"camera": camera, "status": "pending_confirm", "offset_sec": None,
                "timestamp_hypothesis": "start", "samples": 0, "hypotheses": models,
                "reason": "ambiguous_offset" if models else "insufficient_anchored_observations"}
    usable.sort(key=lambda model: (-model["samples"], model["variance_sec2"], model["timestamp_hypothesis"] != "start"))
    best = usable[0]
    # Large scatter is evidence against a single stable camera clock.
    if best["variance_sec2"] > START_TOLERANCE ** 2:
        return {"camera": camera, "status": "pending_confirm", "offset_sec": None,
                "timestamp_hypothesis": best["timestamp_hypothesis"], "samples": best["samples"],
                "hypotheses": models, "reason": "unstable_camera_clock"}
    return {"camera": camera, "status": "calibrated", **best, "hypotheses": models,
            "timestamp_hypothesis_distinguished": len(usable) == 1 or
                usable[1]["samples"] < best["samples"] or usable[1]["variance_sec2"] > best["variance_sec2"] + 1.0}


def calibrate_camera_offset(takes, clips, camera_idx):
    """Return camera-calendar minus controller-UTC offset seconds, or None."""
    camera = _camera_name(camera_idx)
    selected = [clip for clip in clips if clip.get("camera", camera) == camera]
    return _calibrate_camera(takes, selected, camera)["offset_sec"]


def _unique_alignment(count_takes, count_groups, edges):
    """Find pairs present in EVERY maximum-cardinality monotonic alignment.

    No nearest/index tie breaker may resolve an ambiguous take or an omitted take.
    Return forced pairs and all pairs occurring in an optimal alignment.
    """
    edge_set = set(edges)
    forward = [[0] * (count_groups + 1) for _ in range(count_takes + 1)]
    for i in range(count_takes):
        for j in range(count_groups):
            forward[i + 1][j + 1] = max(forward[i][j + 1], forward[i + 1][j],
                                        forward[i][j] + ((i, j) in edge_set))
    backward = [[0] * (count_groups + 1) for _ in range(count_takes + 1)]
    for i in range(count_takes - 1, -1, -1):
        for j in range(count_groups - 1, -1, -1):
            backward[i][j] = max(backward[i + 1][j], backward[i][j + 1],
                                  backward[i + 1][j + 1] + ((i, j) in edge_set))
    score = forward[-1][-1]
    eligible = [(i, j) for i, j in edge_set if forward[i][j] + 1 + backward[i + 1][j + 1] == score]
    by_take = {}
    for i, j in eligible:
        by_take.setdefault(i, []).append(j)
    forced = []
    for i, choices in by_take.items():
        if len(choices) != 1:
            continue
        can_skip = max(forward[i][j] + backward[i + 1][j] for j in range(count_groups + 1)) == score
        if not can_skip:
            forced.append((i, choices[0]))
    return sorted(forced), sorted(eligible)


def match_single_camera(takes, clip_groups, camera_idx, offset_sec):
    """Match already-grouped clips with a scalar offset, retaining all evidence.

    Returns camera/offset_sec/clip_groups/matches/unclassified/anomalies.
    Input group order and chosen timestamp hypothesis are preserved.
    """
    camera = _camera_name(camera_idx)
    if offset_sec is not None and not _number(offset_sec):
        raise ValueError("offset_sec must be finite or None")
    takes = sorted(takes, key=lambda take: take["take_id"])
    groups = copy.deepcopy(clip_groups)
    offset = offset_sec
    edges, reasons, timing_by_take = [], {}, []
    for i, take in enumerate(takes):
        timing = _timing(take, camera)
        timing_by_take.append(timing)
        if not timing["participating"] and not timing["observed"]:
            reasons[i] = "not_participating"
            continue
        if offset is None:
            reasons[i] = "uncalibrated_camera_clock"
            continue
        for j, group in enumerate(groups):
            if group["errors"] or group["camera_start_sec"] is None:
                continue
            if not _duration_ok(group["duration_sec"], timing["duration"]):
                continue
            if timing["start"] is not None:
                if abs(group["camera_start_sec"] - offset - timing["start"]) <= START_TOLERANCE:
                    edges.append((i, j))
            else:
                # Duration/order can constrain an unanchored take, but never index it.
                edges.append((i, j))
        if timing["start"] is None:
            reasons[i] = "no_same_boot_anchor"
    forced, eligible = _unique_alignment(len(takes), len(groups), edges)
    # An unanchored inference needs bounding matched takes, or a globally unique
    # duration candidate; unrelated boot clocks are never compared.
    forced_map = dict(forced)
    anchored = [(i, j) for i, j in forced if timing_by_take[i]["start"] is not None]
    for i, j in list(forced_map.items()):
        if timing_by_take[i]["start"] is not None:
            continue
        options = [other for ti, other in edges if ti == i]
        competitors = [ti for ti, other in edges if other == j]
        bounded = any(ti < i and gj < j for ti, gj in anchored) and any(ti > i and gj > j for ti, gj in anchored)
        if not bounded and not (len(options) == 1 and len(competitors) == 1):
            del forced_map[i]
    matches, assigned = [], set()
    candidates_by_take = {}
    for i, j in eligible:
        candidates_by_take.setdefault(i, []).append(groups[j]["group_id"])
    for i, take in enumerate(takes):
        timing = timing_by_take[i]
        row = {"take_id": take["take_id"], "camera": camera, "discarded": take.get("discarded", False),
               "status": "pending_confirm", "group_id": None, "clip_group": None,
               "candidate_group_ids": sorted(candidates_by_take.get(i, [])), "anomalies": []}
        row["timing_evidence"] = {"start_source": timing["start_source"],
                                  "duration_source": timing["duration_source"]}
        if i in forced_map:
            j = forced_map[i]
            group = groups[j]
            assigned.add(j)
            group.update(status="matched", take_id=take["take_id"])
            row.update(status="matched", group_id=group["group_id"], clip_group=group,
                       inferred_without_anchor=timing["start"] is None,
                       start_delta_sec=(group["camera_start_sec"] - offset - timing["start"])
                           if timing["start"] is not None else None,
                       duration_delta_sec=group["duration_sec"] - timing["duration"])
            if not timing["healthy"]:
                row["anomalies"].append(_anomaly("incomplete_camera_evidence"))
        elif reasons.get(i) == "not_participating":
            row.update(status="not_participating", reason="camera_not_participating")
        elif candidates_by_take.get(i):
            row["reason"] = "ambiguous_candidates"
        elif offset is None or timing["start"] is None or timing["duration"] is None:
            row["reason"] = reasons.get(i, "insufficient_timing_evidence")
        else:
            row.update(status="missing", reason="no_compatible_media")
        matches.append(row)
    unclassified = []
    for j, group in enumerate(groups):
        if j not in assigned:
            group["status"] = "corrupt" if group["errors"] else "unclassified"
            group["candidate_take_ids"] = [takes[i]["take_id"] for i, gj in eligible if gj == j]
            unclassified.append(group)
    anomalies = []
    for group in groups:
        anomalies.extend({**item, "group_id": group["group_id"]} for item in group["anomalies"])
        if group["errors"]:
            anomalies.append(_anomaly("corrupt_media", group_id=group["group_id"], errors=group["errors"]))
    return {"camera": camera, "offset_sec": offset, "clip_groups": groups,
            "matches": matches, "unclassified": unclassified, "anomalies": anomalies}


def match_project(jsonl_path, dir_a, dir_b, actions_path=None, recursive=False):
    """Load paths, independently match A/B, then join and number final-action takes."""
    journal = load_journal(jsonl_path)
    inventory = scan_media(dir_a, dir_b, recursive)
    actions = None
    if actions_path is not None:
        actions = json.loads(Path(actions_path).read_text(encoding="utf-8-sig"))
        if (not isinstance(actions, dict) or actions.get("schema_version") != 1 or
                actions.get("template_id") != journal["template_id"] or
                not isinstance(actions.get("actions"), list)):
            raise ValueError("actions dictionary schema/template does not match journal")
    cameras = {}
    for camera_idx, camera in enumerate(("A", "B")):
        calibration = _calibrate_camera(journal["takes"], inventory[camera]["files"], camera)
        groups = group_split_parts(inventory[camera]["files"], calibration["timestamp_hypothesis"])
        report = match_single_camera(journal["takes"], groups, camera_idx, calibration["offset_sec"])
        report["calibration"] = calibration
        report["anomalies"] = inventory[camera]["errors"] + report["anomalies"]
        cameras[camera] = report
    lookup = {camera: {row["take_id"]: row for row in report["matches"]}
              for camera, report in cameras.items()}
    takes, counters = [], {}
    for original in journal["takes"]:
        take = copy.deepcopy(original)
        action = take["action_id"]
        if not take["discarded"] and action:
            counters[action] = counters.get(action, 0) + 1
            take["segment_no"] = counters[action]
        else:
            take["segment_no"] = None
        take["camera_matches"] = {camera: lookup[camera][take["take_id"]] for camera in ("A", "B")}
        rows = list(take["camera_matches"].values())
        if not action:
            take["status"] = "unclassified"
        elif any(row["status"] == "pending_confirm" for row in rows):
            take["status"] = "pending_confirm"
        elif any(row["status"] == "matched" for row in rows):
            take["status"] = "matched"
        else:
            take["status"] = "missing"
        takes.append(take)
    return {"schema_version": 1, "tool": "match_media", "project_id": journal["project_id"],
            "template_id": journal["template_id"], "takes": takes, "cameras": cameras,
            "unclassified": {camera: report["unclassified"] for camera, report in cameras.items()},
            "anomalies": journal["anomalies"] + [dict(item, camera=camera)
                for camera, report in cameras.items() for item in report["anomalies"]],
            "inventory": inventory, "actions": actions,
            "time_semantics": "Camera creation is unverified local calendar evidence; offsets are per camera, never shared."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", required=True)
    parser.add_argument("--cam-a", required=True)
    parser.add_argument("--cam-b", required=True)
    parser.add_argument("--actions")
    parser.add_argument("-o")
    parser.add_argument("--recursive", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = match_project(args.log, args.cam_a, args.cam_b, args.actions, args.recursive)
        text = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if args.o:
            sources = [args.log] + ([args.actions] if args.actions else [])
            sources += [item["path"] for inventory in report["inventory"].values() for item in inventory["files"]]
            sources += [item["path"] for inventory in report["inventory"].values() for item in inventory["duplicates"]]
            write_report(args.o, text, sources)
        else:
            print(text, end="")
        return 1 if report["anomalies"] else 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
