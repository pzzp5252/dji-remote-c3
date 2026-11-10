"""Behavior tests for the read-only inspector (stdlib unittest, no media fixtures)."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


TOOL = Path(__file__).resolve().parents[1] / "tools" / "inspect_mp4.py"
SPEC = importlib.util.spec_from_file_location("inspect_mp4", TOOL)
mp4 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mp4)


def box(kind, payload=b"", large=False, to_end=False):
    if isinstance(kind, str):
        kind = kind.encode("ascii")
    if large:
        return struct.pack(">I4sQ", 1, kind, 16 + len(payload)) + payload
    return struct.pack(">I4s", 0 if to_end else 8 + len(payload), kind) + payload


def timing(kind, version=0, creation=123456789, modification=123456999,
           timescale=1000, duration=10001):
    length = (112 if version else 100) if kind == "mvhd" else (36 if version else 24)
    data = bytearray(length)
    data[0] = version
    struct.pack_into(">QQIQ" if version else ">IIII", data, 4,
                     creation, modification, timescale, duration)
    if kind == "mdhd":
        struct.pack_into(">H", data, 32 if version else 20, (5 << 10) | (14 << 5) | 7)
    return box(kind, bytes(data))


def track_header(version=0, creation=123456789, modification=123456999, duration=10001):
    data = bytearray(96 if version else 84)
    data[0] = version
    data[3] = 1
    struct.pack_into(">QQI" if version else ">III", data, 4, creation, modification, 7)
    struct.pack_into(">Q" if version else ">I", data, 28 if version else 20, duration)
    struct.pack_into(">II", data, 88 if version else 76, 1920 << 16, 1080 << 16)
    return box("tkhd", bytes(data))


def handler(kind="vide", name=b"Video\0"):
    return box("hdlr", bytes(8) + kind.encode("ascii") + bytes(12) + name)


def sample_description(timecode=False):
    if timecode:
        payload = bytes(6) + struct.pack(">HIIII", 1, 0, 1, 30000, 1001) + bytes((30, 0))
        payload += box("name", b"Camera original timecode\0")
        entry = box("tmcd", payload)
    else:
        entry = box("avc1", bytes(78))
    return box("stsd", bytes(4) + struct.pack(">I", 1) + entry)


def movie(version=0, creation=123456789, modification=123456999,
          timescale=1000, duration=10001, timecode=False, large=False):
    media = timing("mdhd", version, creation, modification, timescale, duration)
    media += handler("tmcd" if timecode else "vide")
    media += box("minf", box("stbl", sample_description(timecode)))
    track = track_header(version, creation, modification, duration) + box("mdia", media)
    if timecode:
        track += box("tref", box("tmcd", struct.pack(">I", 9)))
    return box("moov", timing("mvhd", version, creation, modification, timescale, duration)
               + box("trak", track, large=large), large=large)


def media_file(**kwargs):
    return (box("ftyp", b"isom" + bytes(4) + b"isommp42") +
            box("mdat", b"not inspected") + movie(**kwargs))


class InspectorBehavior(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def source(self, content, name="clip.mp4"):
        path = self.root / name
        path.write_bytes(content)
        return path

    def run_main(self, arguments):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = mp4.main([str(value) for value in arguments])
        return status, json.loads(stdout.getvalue()) if stdout.getvalue() else None

    def test_v0_timestamps_exact_durations_and_layout(self):
        path = self.source(media_file())
        result = mp4.inspect_file(path, camera="A")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["path"], str(path))
        self.assertEqual(result["name"], "clip.mp4")
        self.assertEqual(result["file_size"], path.stat().st_size)
        self.assertEqual(result["camera"], "A")
        self.assertEqual([item["type"] for item in result["top_level_boxes"]],
                         ["ftyp", "mdat", "moov"])
        self.assertEqual(result["top_level_boxes"][1]["offset"], 24)
        self.assertEqual(result["movie"]["creation_time"]["raw_seconds_since_1904"], 123456789)
        self.assertEqual(result["movie"]["creation_time"]["iso_calendar_unverified"],
                         "1907-11-29T21:33:09")
        self.assertFalse(result["movie"]["creation_time"]["iso_calendar_unverified"].endswith("Z"))
        self.assertEqual(result["movie"]["duration"],
                         {"numerator": 10001, "timescale": 1000, "is_unknown": False})
        track = result["tracks"][0]
        self.assertEqual(track["header"]["track_id"], 7)
        self.assertEqual(track["header"]["duration"]["timescale"], 1000)
        self.assertEqual(track["header"]["modification_time"]["raw_seconds_since_1904"], 123456999)
        self.assertEqual(track["media"]["language_iso_639_2"], "eng")
        self.assertEqual(track["handler"]["type"], "vide")
        self.assertEqual(track["sample_descriptions"][0]["type"], "avc1")
        self.assertFalse(result["native_tmcd_present"])

    def test_v1_64_bit_values_and_large_box_headers(self):
        creation = 5000000000
        duration = (1 << 40) + 17
        result = mp4.inspect_file(self.source(media_file(
            version=1, creation=creation, modification=creation + 1,
            duration=duration, large=True)))
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["top_level_boxes"][-1]["size_encoding"], "64")
        for header in (result["movie"], result["tracks"][0]["header"], result["tracks"][0]["media"]):
            self.assertEqual(header["version"], 1)
            self.assertEqual(header["creation_time"]["raw_seconds_since_1904"], creation)
            self.assertEqual(header["duration"]["numerator"], duration)
        self.assertEqual(result["tracks"][0]["header"]["width_fixed_16_16"], 1920 << 16)

    def test_out_of_calendar_range_and_unknown_duration_stay_raw(self):
        result = mp4.inspect_file(self.source(media_file(
            version=1, creation=(1 << 64) - 1, duration=(1 << 64) - 1)))
        self.assertEqual(result["errors"], [])
        self.assertIsNone(result["movie"]["creation_time"]["iso_calendar_unverified"])
        self.assertEqual(result["movie"]["creation_time"]["raw_seconds_since_1904"], (1 << 64) - 1)
        self.assertTrue(result["movie"]["duration"]["is_unknown"])

    def test_native_timecode_metadata_and_references(self):
        result = mp4.inspect_file(self.source(media_file(timecode=True)))
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["native_tmcd_present"])
        track = result["tracks"][0]
        self.assertEqual(track["handler"]["type"], "tmcd")
        self.assertEqual(track["native_tmcd"]["referenced_track_ids"], [9])
        value = track["sample_descriptions"][0]["timecode"]
        self.assertEqual((value["timescale"], value["frame_duration"], value["number_of_frames"]),
                         (30000, 1001, 30))
        self.assertTrue(value["drop_frame"])
        self.assertIn(b"Camera original timecode".hex(), value["extension_hex"])

    def test_size_zero_extends_to_enclosing_end(self):
        valid = movie()
        result = mp4.inspect_file(self.source(valid + box("free", b"padding", to_end=True)))
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["top_level_boxes"][-1]["size_encoding"], "to_end")
        self.assertEqual(result["top_level_boxes"][-1]["size"], 15)
        hidden = mp4.inspect_file(self.source(box("mdat", valid, to_end=True)))
        self.assertIn("missing_moov", {error["code"] for error in hidden["errors"]})

    def test_malformed_and_truncated_boxes_and_no_moov(self):
        cases = [b"", b"not an mp4", box("mdat", b"payload"), b"\0\0\0",
                 struct.pack(">I4s", 7, b"free"), struct.pack(">I4s", 64, b"moov"),
                 struct.pack(">I4s", 1, b"moov") + b"\0\0",
                 struct.pack(">I4sQ", 1, b"moov", (1 << 64) - 1),
                 box("moov", box("mvhd", b"\0")),
                 box("moov", box("mvhd", b"\x02" + bytes(111))),
                 box("ftyp", b"isom" + bytes(4) + b"x") + movie()]
        for index, content in enumerate(cases):
            with self.subTest(index=index):
                result = mp4.inspect_file(self.source(content))
                self.assertTrue(result["errors"])
                json.dumps(result, allow_nan=False)

    def test_zero_timescale_retains_exact_numerator_and_reports_error(self):
        path = self.source(media_file(timescale=0))
        result = mp4.inspect_file(path)
        self.assertIn("zero_timescale", {error["code"] for error in result["errors"]})
        self.assertEqual(result["movie"]["duration"]["numerator"], 10001)
        self.assertEqual(result["movie"]["duration"]["timescale"], 0)
        status, report = self.run_main([path])
        self.assertEqual(status, 1)
        self.assertTrue(report["files"][0]["errors"])

    def test_sparse_large_mdat_is_never_read(self):
        path = self.root / "sparse.mp4"
        prefix = box("ftyp", b"isom" + bytes(4))
        mdat_size = 512 * 1024 * 1024 + 16
        with path.open("wb") as stream:
            stream.write(prefix)
            stream.write(struct.pack(">I4sQ", 1, b"mdat", mdat_size))
            stream.seek(len(prefix) + mdat_size)
            stream.write(movie())
        original_open = open
        reads = []

        class GuardedReader:
            def __init__(self, wrapped):
                self.wrapped = wrapped

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.wrapped.close()

            def fileno(self):
                return self.wrapped.fileno()

            def seek(self, offset):
                return self.wrapped.seek(offset)

            def read(self, size=-1):
                offset = self.wrapped.tell()
                reads.append((offset, size))
                if size < 0 or size > mp4.MAX_READ:
                    raise AssertionError("unbounded source read")
                if (offset < len(prefix) + mdat_size and
                        offset + size > len(prefix) + 16):
                    raise AssertionError("mdat payload was read")
                return self.wrapped.read(size)

        with mock.patch.object(mp4, "open", side_effect=lambda *a, **kw:
                               GuardedReader(original_open(*a, **kw)), create=True):
            result = mp4.inspect_file(path)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["file_size"], path.stat().st_size)
        self.assertLess(sum(length for _, length in reads), 2048)
        self.assertEqual(result["top_level_boxes"][1]["size"], mdat_size)

    def test_large_names_and_box_counts_are_bounded(self):
        track = track_header() + box("mdia", timing("mdhd") + handler(name=b"x" * 100000))
        path = self.source(box("moov", timing("mvhd") + box("trak", track)))
        result = mp4.inspect_file(path)
        self.assertEqual(result["errors"], [])
        self.assertTrue(result["tracks"][0]["handler"]["name_truncated"])
        self.assertEqual(len(result["tracks"][0]["handler"]["name"]), 1024)
        self.assertLess(result["metadata_bytes_read"], 2048)
        with mock.patch.object(mp4, "MAX_BOXES", 4):
            result = mp4.inspect_file(self.source(box("free") * 10 + movie()))
        self.assertIn("metadata_limit", {error["code"] for error in result["errors"]})

    def test_metadata_read_budget_is_reported(self):
        with mock.patch.object(mp4, "MAX_METADATA_BYTES", 16):
            result = mp4.inspect_file(self.source(media_file()))
        self.assertTrue(result["errors"])
        self.assertLessEqual(result["metadata_bytes_read"], 16)

    def test_unicode_paths_output_and_repeatable_json(self):
        path = self.source(media_file(), "相机 A — 片段.mp4")
        first_status, first = self.run_main(["--camera", "B", path])
        second_status, second = self.run_main(["--camera", "B", path])
        self.assertEqual(first_status, 0)
        self.assertEqual(second_status, 0)
        self.assertEqual(first, second)
        self.assertEqual(first["files"][0]["name"], path.name)
        output = self.root / "报告.json"
        status, stdout = self.run_main([path, "--output", output])
        self.assertEqual(status, 0)
        self.assertIsNone(stdout)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["files"][0]["path"], str(path))
        self.assertEqual(path.read_bytes(), media_file())

    def test_output_source_collision_and_aliases_never_truncate(self):
        path = self.source(media_file())
        aliases = [path]
        if hasattr(os, "link"):
            hardlink = self.root / "hardlink.json"
            os.link(path, hardlink)
            aliases.append(hardlink)
        if hasattr(os, "symlink"):
            symlink = self.root / "symlink.json"
            symlink.symlink_to(path)
            aliases.append(symlink)
        for output in aliases:
            with self.subTest(output=output):
                status, report = self.run_main([path, "--output", output])
                self.assertEqual(status, 1)
                self.assertEqual(report["errors"][-1]["code"], "output_error")
                self.assertEqual(path.read_bytes(), media_file())

    def test_directories_optional_recursion_and_explicit_invalid_files(self):
        self.source(media_file(), "b.MOV")
        self.source(media_file(), "a.mp4")
        invalid = self.source(b"arbitrary unsupported file", "not-media.txt")
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "c.mp4").write_bytes(media_file())
        shallow, errors = mp4.discover([str(self.root)], False)
        self.assertEqual(errors, [])
        self.assertEqual([Path(path).name for path in shallow], ["a.mp4", "b.MOV"])
        recursive, errors = mp4.discover([str(self.root)], True)
        self.assertEqual(errors, [])
        self.assertEqual([Path(path).name for path in recursive], ["a.mp4", "b.MOV", "c.mp4"])
        status, report = self.run_main([invalid])
        self.assertEqual(status, 1)
        self.assertTrue(report["files"][0]["errors"])

    def test_cli_multi_file_failure_continues_and_reports_nonzero(self):
        bad = self.source(b"broken", "bad.mp4")
        good = self.source(media_file(), "good.mp4")
        missing = self.root / "missing.mp4"
        process = subprocess.run([sys.executable, str(TOOL), str(bad), str(good), str(missing)],
                                 capture_output=True, text=True, check=False)
        self.assertEqual(process.returncode, 1)
        report = json.loads(process.stdout)
        self.assertEqual(len(report["files"]), 3)
        self.assertTrue(report["files"][0]["errors"])
        self.assertFalse(report["files"][1]["errors"])
        self.assertTrue(report["files"][2]["errors"])
        self.assertEqual(process.stderr, "")

    def test_ffprobe_is_optional_and_preserves_tags_timecodes_and_nonzero(self):
        path = self.source(media_file())
        with mock.patch.object(mp4, "enrich_ffprobe") as enrich:
            self.assertEqual(mp4.inspect_file(path)["errors"], [])
            enrich.assert_not_called()

        class Process:
            def __init__(self, *args, **kwargs):
                self.returncode = 7
                self.stdout = io.BytesIO(json.dumps({
                    "format": {"tags": {"creation_time": "camera-local", "timecode": "01:02:03:04"}},
                    "streams": [{"tags": {"timecode": "01:02:03:04"}}]
                }).encode())
                self.stderr = io.BytesIO(b"native metadata warning\n")

            def wait(self, timeout=None):
                return self.returncode

        with mock.patch.object(mp4.subprocess, "Popen", Process):
            result = mp4.inspect_file(path, ffprobe=True)
        self.assertEqual(result["ffprobe"]["exit_code"], 7)
        self.assertEqual(result["ffprobe"]["stderr"], "native metadata warning\n")
        self.assertEqual(result["ffprobe"]["data"]["format"]["tags"]["timecode"], "01:02:03:04")
        self.assertIn("ffprobe_failed", {error["code"] for error in result["errors"]})
        with mock.patch.object(mp4.subprocess, "Popen", side_effect=FileNotFoundError("no ffprobe")):
            result = mp4.inspect_file(path, ffprobe=True)
        self.assertIn("ffprobe_unavailable", {error["code"] for error in result["errors"]})


if __name__ == "__main__":
    unittest.main()
