#!/usr/bin/env python3
"""Read-only original-media archiving and a standard-library XLSX audit ledger."""

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

if __package__:
    from .inspect_mp4 import inspect_file
    from .match_media import match_project
else:
    from inspect_mp4 import inspect_file
    from match_media import match_project

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def _xml_text(value):
    text = str(value)
    if any(not (char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF or
                    0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF)
           for char in text):
        raise ValueError("cell contains a character XML 1.0 cannot represent")
    return text


def _xml(root):
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _column(index):
    value = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        value = chr(65 + remainder) + value
    return value


def _safe_directory(path):
    path = Path(path).absolute()
    for part in reversed((path, *path.parents)):
        if part.is_symlink():
            raise ValueError("output directory contains a symlink: " + str(part))
        if part.exists() and not part.is_dir():
            raise ValueError("output parent is not a directory: " + str(part))
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_xlsx(path, sheets):
    """Write named row sequences as inline-string OpenXML worksheets atomically.

    sheets is an insertion-ordered mapping, or sequence of (name, rows) pairs.
    Numbers and booleans retain their Excel types; strings never become formulas.
    """
    items = list(sheets.items() if isinstance(sheets, dict) else sheets)
    names = [str(name) for name, rows in items]
    if (not names or len(set(name.casefold() for name in names)) != len(names) or
            any(not name or len(name) > 31 or re.search(r"[\[\]:*?/\\]", name) for name in names)):
        raise ValueError("invalid or duplicate worksheet name")
    output = Path(path).absolute()
    _safe_directory(output.parent)
    if output.is_symlink() or (output.exists() and not output.is_file()):
        raise ValueError("workbook output must be a regular non-symlink file")
    fd, temporary = tempfile.mkstemp(prefix=".ledger-", suffix=".xlsx", dir=output.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            types = ET.Element("Types", xmlns=CONTENT)
            for extension, content_type in (("rels", "application/vnd.openxmlformats-package.relationships+xml"),
                                             ("xml", "application/xml")):
                ET.SubElement(types, "Default", Extension=extension, ContentType=content_type)
            ET.SubElement(types, "Override", PartName="/xl/workbook.xml",
                          ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")
            ET.SubElement(types, "Override", PartName="/xl/styles.xml",
                          ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml")
            root_rels = ET.Element("Relationships", xmlns=PACKAGE_REL)
            ET.SubElement(root_rels, "Relationship", Id="rId1", Type=REL + "/officeDocument", Target="xl/workbook.xml")
            workbook = ET.Element("workbook", xmlns=MAIN, attrib={"xmlns:r": REL})
            sheet_list = ET.SubElement(workbook, "sheets")
            relationships = ET.Element("Relationships", xmlns=PACKAGE_REL)
            for number, (name, rows) in enumerate(items, 1):
                ET.SubElement(sheet_list, "sheet", name=_xml_text(name), sheetId=str(number),
                              attrib={"r:id": "rId" + str(number)})
                ET.SubElement(relationships, "Relationship", Id="rId" + str(number),
                              Type=REL + "/worksheet", Target="worksheets/sheet%d.xml" % number)
                ET.SubElement(types, "Override", PartName="/xl/worksheets/sheet%d.xml" % number,
                              ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml")
                worksheet = ET.Element("worksheet", xmlns=MAIN)
                data = ET.SubElement(worksheet, "sheetData")
                for row_index, values in enumerate(rows, 1):
                    if row_index > 1048576:
                        raise ValueError("worksheet exceeds Excel row limit")
                    row = ET.SubElement(data, "row", r=str(row_index))
                    for column_index, value in enumerate(values, 1):
                        if column_index > 16384:
                            raise ValueError("worksheet exceeds Excel column limit")
                        if value is None:
                            continue
                        cell = ET.SubElement(row, "c", r=_column(column_index) + str(row_index))
                        if isinstance(value, bool):
                            cell.set("t", "b")
                            ET.SubElement(cell, "v").text = "1" if value else "0"
                        elif isinstance(value, (int, float)):
                            if isinstance(value, float) and not math.isfinite(value):
                                raise ValueError("non-finite numeric cell")
                            cell.set("t", "n")
                            ET.SubElement(cell, "v").text = str(value)
                        else:
                            cell.set("t", "inlineStr")
                            text = _xml_text(value)
                            if len(text) > 32767:
                                raise ValueError("cell exceeds Excel text limit")
                            ET.SubElement(ET.SubElement(cell, "is"), "t", attrib={XML_SPACE: "preserve"}).text = text
                archive.writestr("xl/worksheets/sheet%d.xml" % number, _xml(worksheet))
            ET.SubElement(relationships, "Relationship", Id="rStyles", Type=REL + "/styles", Target="styles.xml")
            styles = ET.Element("styleSheet", xmlns=MAIN)
            fonts = ET.SubElement(styles, "fonts", count="1")
            font = ET.SubElement(fonts, "font")
            ET.SubElement(font, "sz", val="11")
            ET.SubElement(font, "name", val="Calibri")
            fills = ET.SubElement(styles, "fills", count="2")
            for pattern in ("none", "gray125"):
                ET.SubElement(ET.SubElement(fills, "fill"), "patternFill", patternType=pattern)
            borders = ET.SubElement(styles, "borders", count="1")
            border = ET.SubElement(borders, "border")
            for side in ("left", "right", "top", "bottom", "diagonal"):
                ET.SubElement(border, side)
            for tag in ("cellStyleXfs", "cellXfs"):
                ET.SubElement(ET.SubElement(styles, tag, count="1"), "xf", numFmtId="0", fontId="0", fillId="0", borderId="0")
            ET.SubElement(ET.SubElement(styles, "cellStyles", count="1"), "cellStyle", name="Normal", xfId="0", builtinId="0")
            archive.writestr("[Content_Types].xml", _xml(types))
            archive.writestr("_rels/.rels", _xml(root_rels))
            archive.writestr("xl/workbook.xml", _xml(workbook))
            archive.writestr("xl/_rels/workbook.xml.rels", _xml(relationships))
            archive.writestr("xl/styles.xml", _xml(styles))
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _component(value):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip(" .")
    if not text:
        text = "_"
    if text.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *("COM%d" % i for i in range(1, 10)),
                                     *("LPT%d" % i for i in range(1, 10))}:
        text = "_" + text
    if len(text.encode("utf-8")) > 180:
        extension = Path(text).suffix
        extension = extension if re.fullmatch(r"\.[A-Za-z0-9]{1,10}", extension) else ""
        prefix = text[:-len(extension)] if extension else text
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]
        budget = 180 - len(extension.encode("utf-8")) - 9
        text = prefix.encode("utf-8")[:budget].decode("utf-8", errors="ignore") + "_" + digest + extension
    return text


def _source_identities(sources):
    identities, resolved = set(), set()
    for source in sources:
        path = Path(source)
        resolved.add(path.resolve())
        try:
            info = path.stat()
        except OSError:
            continue
        identities.add((info.st_dev, info.st_ino))
    return identities, resolved


def _protect(path, identities, resolved):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("output is a symlink: " + str(path))
    if path.resolve() in resolved:
        raise ValueError("output aliases an input source: " + str(path))
    if path.exists():
        info = path.stat()
        if (info.st_dev, info.st_ino) in identities:
            raise ValueError("output hard-links an input source: " + str(path))
        if not path.is_file():
            raise ValueError("output must be a regular file: " + str(path))


def _write_bytes(path, data, identities, resolved, exclusive=False):
    path = Path(path)
    _safe_directory(path.parent)
    _protect(path, identities, resolved)
    if exclusive:
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        return
    if path.exists() and path.read_bytes() == data:
        return
    descriptor, temporary = tempfile.mkstemp(prefix=".ledger-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        _protect(path, identities, resolved)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _project_directory(output_root, title, project_id, template_id, media_dirs):
    base = _component(title)
    output_root = Path(output_root).absolute()
    index = 1
    while True:
        stem = base if index == 1 else base + "_v" + str(index)
        candidate = output_root / (stem + "_层流烟雾流型验证")
        # Repeated recursive scans must never ingest this tool's own output.
        for media_dir in media_dirs:
            if isinstance(media_dir, (str, Path)) and Path(media_dir).is_dir():
                source = Path(media_dir).resolve()
                target = candidate.resolve()
                if target.is_relative_to(source) or source.is_relative_to(target):
                    raise ValueError("archive output overlaps a media input directory")
        if candidate.is_symlink():
            raise ValueError("project output is a symlink")
        if candidate.exists():
            if not candidate.is_dir():
                index += 1
                continue
            mapping_path = candidate / "_台账" / "归档映射.json"
            if mapping_path.is_symlink():
                raise ValueError("existing mapping is a symlink")
            if mapping_path.exists():
                previous = json.loads(mapping_path.read_text(encoding="utf-8"))
                if previous.get("project_id") == project_id and previous.get("template_id") == template_id:
                    return _safe_directory(candidate), previous
            elif not any(candidate.iterdir()):
                return _safe_directory(candidate), None
            index += 1
        else:
            return _safe_directory(candidate), None


def _plans(report):
    actions = {item["action_id"]: item for item in report["actions"]["actions"]}
    planned, anomalies = {}, []

    def add(part, camera, relative, take=None, part_index=1, candidates=None):
        key = (camera, str(Path(part["path"]).resolve()))
        if key in planned:
            return
        planned[key] = {
            "source": str(Path(part["path"]).resolve()), "original_name": part["name"],
            "camera": camera, "file_size": part["file_size"], "creation_raw": part.get("creation_raw"),
            "creation_time": ((part.get("movie") or {}).get("creation_time") or {}).get("iso_calendar_unverified"),
            "duration_sec": part.get("duration_sec"), "dedup_key": part.get("dedup_key"),
            "duplicate_paths": part.get("duplicate_paths", []), "source_errors": part.get("errors", []),
            "take_id": take["take_id"] if take else None,
            "segment_no": take["segment_no"] if take else None,
            "action_id": take["action_id"] if take else None,
            "point_id": take["point_id"] if take else None,
            "discarded": take["discarded"] if take else False,
            "part_index": part_index, "requested_destination": relative.as_posix(),
            "candidate_take_ids": candidates or [],
        }

    for take in report["takes"]:
        action = actions.get(take["action_id"])
        if take["source"] == "external" or not take["action_id"]:
            anomalies.append({"code": "unclassified_external", "take_id": take["take_id"],
                              "action_id": take["action_id"]})
        if take["action_id"] and action is None:
            anomalies.append({"code": "unknown_action", "take_id": take["take_id"],
                              "action_id": take["action_id"]})
        for camera, match in take["camera_matches"].items():
            if match["status"] in ("missing", "pending_confirm"):
                anomalies.append({"code": match["status"], "take_id": take["take_id"], "camera": camera,
                                  "reason": match.get("reason"), "candidate_group_ids": match["candidate_group_ids"],
                                  "no_same_boot_anchor": take["time_anchor"] is None})
            if match["status"] != "matched":
                continue
            parts = match["clip_group"]["parts"]
            formal = action is not None and take["action_id"] and take["source"] != "external"
            for index, part in enumerate(parts, 1):
                suffix = "_part%02d" % index if len(parts) > 1 else ""
                identity = take["action_id"] + ("_" + take["point_id"] if take["point_id"] else "")
                if formal and take["discarded"]:
                    destination = Path("_废片备查") / _component("%s_T%04d_%s机%s.mp4" %
                        (identity, take["take_id"], camera, suffix))
                elif formal and take["segment_no"] is not None:
                    destination = Path(_component(take["action_id"] + "_" + action["name"])) / _component(
                        "%s_第%02d段_%s机%s.mp4" % (identity, take["segment_no"], camera, suffix))
                else:
                    destination = Path("_待确认") / _component(camera + "机_" + part["name"])
                add(part, camera, destination, take, index)
    for camera, groups in report["unclassified"].items():
        for group in groups:
            anomalies.append({"code": "corrupt_media" if group["errors"] else "unclassified_media",
                              "camera": camera, "group_id": group["group_id"], "paths": group["paths"],
                              "candidate_take_ids": group.get("candidate_take_ids", [])})
            for index, part in enumerate(group["parts"], 1):
                add(part, camera, Path("_待确认") / _component(camera + "机_" + part["name"]),
                    part_index=index, candidates=group.get("candidate_take_ids", []))
    return sorted(planned.values(), key=lambda row: (row["camera"], row["source"])), anomalies


def _copy_video(plan, root, reserved, previous, identities, resolved):
    requested = Path(plan["requested_destination"])
    if requested.is_absolute() or ".." in requested.parts:
        raise ValueError("unsafe relative archive destination")
    source = Path(plan["source"])
    expected_size = plan["file_size"]
    if not source.is_file():
        return dict(plan, destination=None, copy_status="failed", verified=False,
                    verification="unverified", verification_errors=[{"code": "source_not_regular_file"}], conflicts=[])
    previous_row = previous.get((plan["camera"], plan["source"], plan["requested_destination"]))
    conflicts = []
    version = 1
    while True:
        relative = requested if version == 1 else requested.with_name(
            requested.stem + "_v%d" % version + requested.suffix)
        destination = root / relative
        _safe_directory(destination.parent)
        _protect(destination, identities, resolved)
        key = relative.as_posix()
        owner = reserved.get(key)
        if owner is not None and owner != (plan["camera"], plan["source"]):
            conflicts.append({"code": "filename_collision", "source": plan["source"], "destination": key})
            version += 1
            continue
        if destination.exists():
            probe = inspect_file(destination, camera=plan["camera"])
            readable = probe["movie"] is not None and not probe["errors"]
            same_size = probe["file_size"] == expected_size
            if same_size and readable:
                status = "skipped"
                verified = not plan["source_errors"]
                errors = [] if verified else plan["source_errors"]
                break
            if (same_size and previous_row and previous_row["destination"] == key and
                    previous_row.get("verified") is False):
                # Preserve known corrupt output without falsely counting it processed.
                status, verified, errors = "unverified_retained", False, probe["errors"]
                break
            conflicts.append({"code": "destination_size_conflict" if not same_size else "destination_unreadable_conflict",
                              "source": plan["source"], "destination": key,
                              "expected_size": expected_size, "existing_size": probe["file_size"]})
            version += 1
            continue
        before = source.stat()
        with destination.open("xb"):
            pass
        try:
            shutil.copy2(source, destination)
        except OSError:
            # This path was exclusively created by this call; remove only our partial copy.
            destination.unlink()
            raise
        after = source.stat()
        probe = inspect_file(destination, camera=plan["camera"])
        unchanged = (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
        verified = (unchanged and before.st_size == expected_size and probe["file_size"] == expected_size and
                    probe["movie"] is not None and not probe["errors"] and not plan["source_errors"])
        errors = list(probe["errors"])
        if not unchanged or before.st_size != expected_size or probe["file_size"] != expected_size:
            errors.append({"code": "source_changed_or_copy_size_mismatch"})
        status = "copied"
        break
    reserved[key] = (plan["camera"], plan["source"])
    row = dict(plan, destination=key, copy_status=status, verified=verified,
               verification="size_and_container_metadata_only" if verified else "unverified",
               verification_errors=errors, conflicts=conflicts)
    return row


def _semantic(value):
    if isinstance(value, dict):
        return {key: _semantic(item) for key, item in value.items() if key not in ("copy_status", "counts")}
    if isinstance(value, list):
        return [_semantic(item) for item in value]
    return value


def _revision_rows(events, takes):
    state = {take["take_id"]: [take["initial_action_id"], take["initial_point_id"], False] for take in takes}
    rows = []
    for event in events:
        if event["type"] not in ("MARK_DISCARD", "REASSIGN"):
            continue
        current = state[event["take_id"]]
        old = list(current)
        if event["type"] == "MARK_DISCARD":
            current[2] = event["discard"]
        else:
            current[0], current[1] = event["action_id"], event.get("point_id", "")
        rows.append([event["event_seq"], event["type"], event["take_id"], None, old[0], old[1],
                     current[0], current[1], current[2], None, None,
                     json.dumps({"old_discarded": old[2], "new_discarded": current[2]}, ensure_ascii=False)])
    return rows


def _ledger_sheets(mapping):
    actions = {action["action_id"]: action for action in mapping["actions"]["actions"]}
    summary = [["take_id", "project_id", "action_id", "动作名称", "point_id", "点位名称", "分组",
                "discarded", "segment_no", "source", "boot_id", "A状态", "A时长秒", "B状态", "B时长秒", "匹配等级"]]
    for take in mapping["takes"]:
        action = actions.get(take["action_id"], {})
        points = {point["point_id"]: point["name"] for point in action.get("points", [])}
        a, b = take["camera_matches"]["A"], take["camera_matches"]["B"]
        summary.append([take["take_id"], mapping["project_id"], take["action_id"], action.get("name"),
                        take["point_id"], points.get(take["point_id"]), action.get("group"), take["discarded"],
                        take["segment_no"], take["source"], take["boot_id"],
                        a["status"], (a.get("clip_group") or {}).get("duration_sec"),
                        b["status"], (b.get("clip_group") or {}).get("duration_sec"), take["status"]])
    files = [["目标相对路径", "相机", "原始完整路径", "原始文件名", "file_size", "MP4创建时间", "创建原始1904秒",
              "时长秒", "take_id", "segment_no", "part_index", "复制核对"]]
    for row in mapping["files"]:
        files.append([row["destination"], row["camera"], row["source"], row["original_name"], row["file_size"],
                      row["creation_time"], row["creation_raw"], row["duration_sec"], row["take_id"],
                      row["segment_no"], row["part_index"], row["verification"]])
    anomalies = [["事件序号", "类型", "take_id", "相机", "旧动作", "旧点位", "新动作", "新点位", "废片", "原始路径", "目标路径", "详情"]]
    anomalies.extend(_revision_rows(mapping["events"], mapping["takes"]))
    for anomaly in mapping["anomalies"]:
        anomalies.append([anomaly.get("event_seq"), anomaly["code"], anomaly.get("take_id"), anomaly.get("camera"),
                          None, None, None, None, None, anomaly.get("source"), anomaly.get("destination"),
                          json.dumps(anomaly, ensure_ascii=False, sort_keys=True)])
    return {"拍摄汇总": summary, "文件映射": files, "异常与修订": anomalies}


def archive_project(jsonl_path, dir_a, dir_b, actions_path, output_root, project_name=None, recursive=False):
    """Copy original clips without overwrite; return mapping, outcomes and ledger paths."""
    report = match_project(jsonl_path, dir_a, dir_b, actions_path, recursive)
    actions = report["actions"]
    if not actions or not isinstance(actions.get("template_name"), str):
        raise ValueError("archive requires an action dictionary with template_name")
    log_bytes, actions_bytes = Path(jsonl_path).read_bytes(), Path(actions_path).read_bytes()
    events = [json.loads(line) for line in log_bytes.splitlines()]
    sources = [jsonl_path, actions_path]
    for inventory in report["inventory"].values():
        sources.extend(part["path"] for part in inventory["files"])
        sources.extend(part["path"] for part in inventory["duplicates"])
    identities, resolved = _source_identities(sources)
    title = project_name if project_name is not None else actions["template_name"] + "_" + report["project_id"]
    root, previous_mapping = _project_directory(output_root, title, report["project_id"], report["template_id"], (dir_a, dir_b))
    ledger = _safe_directory(root / "_台账")
    map_path = ledger / "归档映射.json"
    workbook_path = ledger / "拍摄归档与核对总表.xlsx"
    for path in (map_path, workbook_path, ledger / "原始日志.jsonl", ledger / "actions.json"):
        _protect(path, identities, resolved)
    plans, extra_anomalies = _plans(report)
    previous = {(row["camera"], row["source"], row["requested_destination"]): row
                for row in (previous_mapping or {}).get("files", [])}
    owners = copy.deepcopy((previous_mapping or {}).get("destination_owners", {}))
    if previous_mapping and not owners:
        owners = {row["destination"]: [row["camera"], row["source"]]
                  for row in previous_mapping.get("files", []) if row["destination"] is not None}
    files = []
    reserved = {destination: tuple(owner) for destination, owner in owners.items()}
    anomalies = copy.deepcopy(report["anomalies"]) + extra_anomalies
    for plan in plans:
        row = _copy_video(plan, root, reserved, previous, identities, resolved)
        files.append(row)
        anomalies.extend(dict(conflict, camera=row["camera"], take_id=row["take_id"]) for conflict in row["conflicts"])
        if not row["verified"]:
            anomalies.append({"code": "copy_unverified", "camera": row["camera"], "take_id": row["take_id"],
                              "source": row["source"], "destination": row["destination"],
                              "errors": row["verification_errors"]})
    mapping = {"schema_version": 1, "tool": "archive_project", "project_id": report["project_id"],
               "template_id": report["template_id"], "project_name": title,
               "source_log": str(Path(jsonl_path).resolve()), "source_actions": str(Path(actions_path).resolve()),
               "actions": actions, "events": events, "takes": report["takes"], "cameras": report["cameras"],
               "files": files, "anomalies": anomalies, "unclassified": report["unclassified"],
               "destination_owners": {destination: list(owner) for destination, owner in sorted(reserved.items())},
               "time_semantics": report["time_semantics"],
               "verification_limit": "Exact byte count and readable container metadata only; no full-content hash or decode."}
    changed = previous_mapping is None or _semantic(mapping) != _semantic(previous_mapping)
    previous_version = None
    if changed and previous_mapping is not None:
        version = 1
        while (ledger / ("归档映射.v%d.json" % version)).exists():
            version += 1
        previous_version = ledger / ("归档映射.v%d.json" % version)
        _write_bytes(previous_version, map_path.read_bytes(), identities, resolved, exclusive=True)
    _write_bytes(ledger / "原始日志.jsonl", log_bytes, identities, resolved)
    _write_bytes(ledger / "actions.json", actions_bytes, identities, resolved)
    if changed:
        _write_bytes(map_path, (json.dumps(mapping, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
                     identities, resolved)
    write_xlsx(workbook_path, _ledger_sheets(mapping))
    counts = {"copied": sum(row["copy_status"] == "copied" for row in files),
              "skipped": sum(row["copy_status"] == "skipped" and row["verified"] for row in files),
              "unverified": sum(not row["verified"] for row in files),
              "conflicts": sum(len(row["conflicts"]) for row in files)}
    return {"project_dir": str(root), "mapping_path": str(map_path), "workbook_path": str(workbook_path),
            "mapping_changed": changed, "previous_mapping_path": str(previous_version) if previous_version else None,
            "counts": counts, "mapping": mapping, "files": files, "anomalies": anomalies,
            "ok": not anomalies and not counts["unverified"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", required=True)
    parser.add_argument("--cam-a", required=True)
    parser.add_argument("--cam-b", required=True)
    parser.add_argument("--actions", required=True)
    parser.add_argument("-o", required=True)
    parser.add_argument("--project-name")
    parser.add_argument("--recursive", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = archive_project(args.log, args.cam_a, args.cam_b, args.actions, args.o, args.project_name, args.recursive)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0 if result["ok"] else 1
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
