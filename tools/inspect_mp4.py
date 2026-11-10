#!/usr/bin/env python3
"""Read-only, bounded ISO BMFF metadata inspection; see schema/inspect-mp4.md."""

import argparse
import datetime
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import threading


EXTENSIONS = {".mp4", ".mov", ".m4v", ".m4a", ".3gp", ".3g2", ".qt"}
MAX_BOXES = 10000
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_READ = 65536
MAX_FFPROBE_BYTES = 1024 * 1024
TIME_SEMANTICS = (
    "ISO calendar rendering uses the 1904-01-01 epoch without a timezone suffix. "
    "Container timezone semantics are unverified; these values are not verified UTC "
    "or recording-start timestamps."
)


class InvalidBox(ValueError):
    pass


def problem(code, message, offset=None):
    result = {"code": code, "message": str(message)}
    if offset is not None:
        result["offset"] = offset
    return result


def fourcc(value):
    return value.decode("latin-1")


def timestamp(seconds):
    try:
        rendered = (datetime.datetime(1904, 1, 1) +
                    datetime.timedelta(seconds=seconds)).isoformat()
    except (OverflowError, ValueError):
        rendered = None
    return {"raw_seconds_since_1904": seconds, "iso_calendar_unverified": rendered}


class Inspector:
    def __init__(self, stream, size, result):
        self.stream = stream
        self.size = size
        self.result = result
        self.box_count = 0
        self.bytes_read = 0
        self.exhausted = False

    def error(self, code, message, offset=None):
        self.result["errors"].append(problem(code, message, offset))

    def read_at(self, offset, length):
        if length < 0 or length > MAX_READ or offset < 0 or offset + length > self.size:
            raise InvalidBox("metadata read exceeds bounds")
        if self.bytes_read + length > MAX_METADATA_BYTES:
            self.exhausted = True
            raise InvalidBox("metadata read budget exceeded")
        self.bytes_read += length
        self.stream.seek(offset)
        value = self.stream.read(length)
        if len(value) != length:
            raise InvalidBox("file truncated while reading metadata")
        return value

    def boxes(self, start, end):
        offset = start
        while offset < end and not self.exhausted:
            if self.box_count >= MAX_BOXES:
                self.exhausted = True
                self.error("metadata_limit", "box count limit exceeded", offset)
                return
            self.box_count += 1
            try:
                if end - offset < 8:
                    raise InvalidBox("truncated box header")
                raw_size, kind = struct.unpack(">I4s", self.read_at(offset, 8))
                header_size = 8
                if raw_size == 1:
                    if end - offset < 16:
                        raise InvalidBox("truncated 64-bit box header")
                    size = struct.unpack(">Q", self.read_at(offset + 8, 8))[0]
                    header_size = 16
                elif raw_size == 0:
                    size = end - offset
                else:
                    size = raw_size
                if kind == b"uuid":
                    header_size += 16
                if size < header_size:
                    raise InvalidBox("box size is smaller than its header")
                if size > end - offset:
                    raise InvalidBox("box extends beyond its enclosing boundary")
                yield {"type": fourcc(kind), "offset": offset, "size": size,
                       "header_size": header_size, "size_encoding": (
                           "to_end" if raw_size == 0 else "64" if raw_size == 1 else "32")}
                offset += size
            except InvalidBox as exc:
                self.error("invalid_box", exc, offset)
                return

    def payload(self, box, length, relative=0):
        if relative < 0 or relative + length > box["size"] - box["header_size"]:
            raise InvalidBox("truncated " + box["type"] + " metadata")
        return self.read_at(box["offset"] + box["header_size"] + relative, length)

    def children(self, box):
        return self.boxes(box["offset"] + box["header_size"], box["offset"] + box["size"])

    def guarded(self, box, operation):
        try:
            operation()
        except (InvalidBox, struct.error) as exc:
            self.error("invalid_metadata", exc, box["offset"])

    def duration(self, numerator, timescale, offset, unknown=False):
        if timescale == 0:
            self.error("zero_timescale", "duration has a zero timescale", offset)
        return {"numerator": numerator, "timescale": timescale, "is_unknown": unknown}

    def timing(self, box):
        version = self.payload(box, 1)[0]
        if version not in (0, 1):
            raise InvalidBox("unsupported " + box["type"] + " version " + str(version))
        is_movie = box["type"] == "mvhd"
        minimum = (112 if version else 100) if is_movie else (36 if version else 24)
        data = self.payload(box, minimum)
        if version:
            creation, modification, timescale, duration = struct.unpack_from(">QQIQ", data, 4)
        else:
            creation, modification, timescale, duration = struct.unpack_from(">IIII", data, 4)
        result = {"version": version, "creation_time": timestamp(creation),
                  "modification_time": timestamp(modification),
                  "duration": self.duration(duration, timescale, box["offset"],
                                            duration == (1 << (64 if version else 32)) - 1)}
        if not is_movie:
            language = struct.unpack_from(">H", data, 32 if version else 20)[0]
            result["language_raw"] = language
            codes = [(language >> shift) & 31 for shift in (10, 5, 0)]
            result["language_iso_639_2"] = (
                "".join(chr(value + 96) for value in codes)
                if all(1 <= value <= 26 for value in codes) else None)
        return result

    def track_header(self, box):
        version = self.payload(box, 1)[0]
        if version not in (0, 1):
            raise InvalidBox("unsupported tkhd version " + str(version))
        data = self.payload(box, 96 if version else 84)
        if version:
            creation, modification, track_id = struct.unpack_from(">QQI", data, 4)
            duration = struct.unpack_from(">Q", data, 28)[0]
        else:
            creation, modification, track_id = struct.unpack_from(">III", data, 4)
            duration = struct.unpack_from(">I", data, 20)[0]
        width, height = struct.unpack_from(">II", data, 88 if version else 76)
        return {"version": version, "track_id": track_id,
                "flags": int.from_bytes(data[1:4], "big"),
                "creation_time": timestamp(creation), "modification_time": timestamp(modification),
                "duration": {"numerator": duration, "timescale": None,
                             "is_unknown": duration == (1 << (64 if version else 32)) - 1},
                "width_fixed_16_16": width, "height_fixed_16_16": height}

    def handler(self, box):
        data = self.payload(box, 24)
        if data[0] != 0:
            raise InvalidBox("unsupported hdlr version " + str(data[0]))
        name_size = box["size"] - box["header_size"] - 24
        name = self.payload(box, min(name_size, 1024), 24)
        return {"type": fourcc(data[8:12]),
                "name": name.rstrip(b"\0").decode("utf-8", errors="replace"),
                "name_truncated": name_size > 1024}

    def sample_descriptions(self, box, track):
        data = self.payload(box, 8)
        if data[0] != 0:
            raise InvalidBox("unsupported stsd version " + str(data[0]))
        expected = struct.unpack_from(">I", data, 4)[0]
        count = 0
        for entry in self.boxes(box["offset"] + box["header_size"] + 8,
                                box["offset"] + box["size"]):
            count += 1
            description = {"type": entry["type"], "size": entry["size"]}
            track["sample_descriptions"].append(description)
            if entry["type"] == "tmcd":
                track["native_tmcd"]["present"] = True
                def parse_timecode():
                    value = self.payload(entry, 26)
                    flags, timescale, frame_duration = struct.unpack_from(">III", value, 12)
                    extra_size = entry["size"] - entry["header_size"] - 26
                    description["timecode"] = {
                        "data_reference_index": struct.unpack_from(">H", value, 6)[0],
                        "flags": flags, "drop_frame": bool(flags & 1),
                        "timescale": timescale, "frame_duration": frame_duration,
                        "number_of_frames": value[24],
                        "extension_hex": self.payload(entry, min(extra_size, 1024), 26).hex(),
                        "extension_truncated": extra_size > 1024,
                    }
                    if timescale == 0:
                        self.error("zero_timescale", "tmcd has a zero timescale", entry["offset"])
                self.guarded(entry, parse_timecode)
        if count != expected:
            self.error("sample_description_count", "stsd entry count does not match payload",
                       box["offset"])

    def track_children(self, parent, track, context="trak"):
        # Only these fixed container paths are walked, never arbitrary nesting or sample data.
        for box in self.children(parent):
            def parse():
                kind = box["type"]
                if context == "trak" and kind == "tkhd":
                    if track["header"] is not None:
                        raise InvalidBox("duplicate tkhd")
                    track["header"] = self.track_header(box)
                elif context == "trak" and kind in ("mdia", "tref"):
                    self.track_children(box, track, kind)
                elif context == "mdia" and kind == "mdhd":
                    if track["media"] is not None:
                        raise InvalidBox("duplicate mdhd")
                    track["media"] = self.timing(box)
                elif context == "mdia" and kind == "hdlr":
                    if track["handler"] is not None:
                        raise InvalidBox("duplicate hdlr")
                    track["handler"] = self.handler(box)
                    if track["handler"]["type"] == "tmcd":
                        track["native_tmcd"]["present"] = True
                elif context == "mdia" and kind == "minf":
                    self.track_children(box, track, kind)
                elif context == "minf" and kind == "stbl":
                    self.track_children(box, track, kind)
                elif context == "stbl" and kind == "stsd":
                    self.sample_descriptions(box, track)
                elif context == "tref" and kind == "tmcd":
                    track["native_tmcd"]["present"] = True
                    size = box["size"] - box["header_size"]
                    if size % 4:
                        raise InvalidBox("tmcd reference length is not a multiple of four")
                    if size > MAX_READ:
                        raise InvalidBox("tmcd reference metadata exceeds limit")
                    values = self.payload(box, size)
                    track["native_tmcd"]["referenced_track_ids"].extend(
                        item[0] for item in struct.iter_unpack(">I", values))
            self.guarded(box, parse)

    def movie(self, box):
        for child in self.children(box):
            def parse():
                if child["type"] == "mvhd":
                    if self.result["movie"] is not None:
                        raise InvalidBox("duplicate mvhd")
                    self.result["movie"] = self.timing(child)
                elif child["type"] == "trak":
                    track = {"offset": child["offset"], "header": None, "media": None,
                             "handler": None, "sample_descriptions": [],
                             "native_tmcd": {"present": False, "referenced_track_ids": []}}
                    self.result["tracks"].append(track)
                    self.track_children(child, track)
                    for field in ("header", "media", "handler"):
                        if track[field] is None:
                            self.error("missing_track_metadata", "track is missing " + field,
                                       child["offset"])
            self.guarded(child, parse)

    def inspect(self):
        moov_count = 0
        for box in self.boxes(0, self.size):
            self.result["top_level_boxes"].append(box)
            def parse():
                nonlocal moov_count
                if box["type"] == "ftyp":
                    data = self.payload(box, 8)
                    compatible_size = box["size"] - box["header_size"] - 8
                    if compatible_size % 4:
                        raise InvalidBox("ftyp compatible brands are truncated")
                    brands = self.payload(box, min(compatible_size, 1024), 8)
                    self.result["file_types"].append({
                        "major_brand": fourcc(data[:4]), "minor_version": int.from_bytes(data[4:], "big"),
                        "compatible_brands": [fourcc(brands[i:i + 4]) for i in range(0, len(brands), 4)],
                        "compatible_brands_truncated": compatible_size > 1024})
                elif box["type"] == "moov":
                    moov_count += 1
                    if moov_count > 1:
                        raise InvalidBox("multiple moov boxes are unsupported")
                    self.movie(box)
            self.guarded(box, parse)
        if moov_count == 0:
            self.error("missing_moov", "no moov box; not a supported complete MP4/MOV")
        if self.result["movie"] is None:
            self.error("missing_mvhd", "no readable movie header")
        else:
            timescale = self.result["movie"]["duration"]["timescale"]
            for track in self.result["tracks"]:
                if track["header"] is not None:
                    track["header"]["duration"]["timescale"] = timescale
        self.result["native_tmcd_present"] = any(
            track["native_tmcd"]["present"] for track in self.result["tracks"])
        self.result["metadata_bytes_read"] = self.bytes_read


def enrich_ffprobe(path):
    result = {"exit_code": None, "data": None, "stderr": "", "errors": []}
    try:
        # Disable stream analysis; do not request packets, frames or data dumps.
        process = subprocess.Popen(
            ["ffprobe", "-v", "error", "-nofind_stream_info", "-show_format", "-show_streams",
             "-of", "json", "-i", str(Path(path).resolve())],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as exc:
        result["errors"].append(problem("ffprobe_unavailable", exc))
        return result
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()

    def collect(stream, target):
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                remaining = MAX_FFPROBE_BYTES - len(target)
                target.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    overflow.set()
                    process.kill()
                    break
        finally:
            stream.close()

    threads = [threading.Thread(target=collect, args=(stream, target), daemon=True)
               for stream, target in zip((process.stdout, process.stderr), buffers)]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        result["errors"].append(problem("ffprobe_timeout", "ffprobe exceeded 60 seconds"))
    for thread in threads:
        thread.join()
    result["exit_code"] = process.returncode
    result["stderr"] = buffers[1].decode("utf-8", errors="replace")
    if overflow.is_set():
        result["errors"].append(problem("ffprobe_output_limit", "ffprobe output exceeded limit"))
    if process.returncode:
        result["errors"].append(problem("ffprobe_failed", "ffprobe returned a nonzero exit status"))
    def reject_nonfinite(value):
        raise ValueError("non-finite JSON constant: " + value)

    try:
        result["data"] = json.loads(buffers[0], parse_constant=reject_nonfinite)
        if not isinstance(result["data"], dict):
            raise ValueError("ffprobe JSON is not an object")
    except (ValueError, UnicodeError) as exc:
        result["data"] = None
        result["errors"].append(problem("ffprobe_invalid_json", exc))
    return result


def inspect_file(path, camera="unknown", ffprobe=False):
    result = {"path": os.fspath(path), "name": Path(path).name, "file_size": None,
              "camera": camera, "file_types": [], "top_level_boxes": [], "movie": None,
              "tracks": [], "native_tmcd_present": False, "errors": [], "ffprobe": None,
              "metadata_bytes_read": 0}
    try:
        if not stat.S_ISREG(os.stat(path).st_mode):
            raise OSError("source is not a regular file")
        with open(path, "rb", buffering=0) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise OSError("source is not a regular file")
            result["file_size"] = info.st_size
            Inspector(stream, info.st_size, result).inspect()
    except (OSError, InvalidBox) as exc:
        result["errors"].append(problem("file_error", exc))
    if ffprobe and result["file_size"] is not None:
        result["ffprobe"] = enrich_ffprobe(path)
        result["errors"].extend(result["ffprobe"]["errors"])
    return result


def discover(inputs, recursive):
    paths = []
    errors = []
    seen = set()

    def add(path):
        key = os.path.abspath(path)
        if key not in seen:
            seen.add(key)
            paths.append(os.fspath(path))

    for original in inputs:
        path = Path(original)
        if not path.is_dir():
            add(original)
            continue
        count_before = len(paths)
        found = 0
        try:
            if recursive:
                def walk_error(exc):
                    errors.append(problem("discovery_error", exc))
                for root, dirs, files in os.walk(path, followlinks=False, onerror=walk_error):
                    dirs.sort()
                    for name in sorted(files):
                        candidate = Path(root) / name
                        if candidate.suffix.lower() in EXTENSIONS:
                            found += 1
                            add(candidate)
            else:
                for candidate in sorted(path.iterdir(), key=lambda value: value.name):
                    if candidate.suffix.lower() in EXTENSIONS and candidate.is_file():
                        found += 1
                        add(candidate)
        except OSError as exc:
            errors.append(problem("discovery_error", exc))
        if found == 0 and len(paths) == count_before:
            errors.append(problem("no_candidates", "no supported media filenames in " + original))
    return paths, errors


def write_report(path, text, sources):
    output = Path(path)
    output_resolved = output.resolve()
    identities = set()
    for source in sources:
        source_path = Path(source)
        if source_path.resolve() == output_resolved:
            raise ValueError("output path is an input source: " + str(source))
        try:
            info = source_path.stat()
            identities.add((info.st_dev, info.st_ino))
        except OSError:
            pass
    # Never truncate before checking the opened descriptor (also catches hard links).
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NONBLOCK", 0), 0o666)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("output must be a regular file")
        if (info.st_dev, info.st_ino) in identities:
            raise ValueError("output aliases an input source")
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n", closefd=False) as stream:
            stream.truncate(0)
            stream.write(text)
    finally:
        os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", help="files or directories (explicit files need no extension)")
    parser.add_argument("-r", "--recursive", action="store_true", help="recurse into directories")
    parser.add_argument("--camera", choices=("A", "B", "unknown"), default="unknown")
    parser.add_argument("--output", help="write JSON here instead of stdout; never overwrite a source")
    parser.add_argument("--ffprobe", action="store_true", help="optionally enrich using ffprobe from PATH")
    args = parser.parse_args(argv)
    paths, errors = discover(args.inputs, args.recursive)
    report = {"schema_version": 1, "tool": "inspect_mp4", "time_semantics": TIME_SEMANTICS,
              "limits": {"max_boxes_per_file": MAX_BOXES,
                         "max_metadata_bytes_per_file": MAX_METADATA_BYTES,
                         "max_single_read_bytes": MAX_READ},
              "files": [inspect_file(path, args.camera, args.ffprobe) for path in paths],
              "errors": errors}
    text = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    if args.output:
        try:
            write_report(args.output, text, paths)
        except (OSError, ValueError, RuntimeError) as exc:
            report["errors"].append(problem("output_error", exc))
            # A refused/unwritable output still yields a machine-readable report.
            sys.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True,
                                        indent=2, allow_nan=False) + "\n")
    else:
        sys.stdout.write(text)
    return 1 if report["errors"] or any(file["errors"] for file in report["files"]) else 0


if __name__ == "__main__":
    sys.exit(main())
