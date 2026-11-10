"""Consumer-visible archive behavior with synthetic media and no hardware access."""

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from test_inspect_mp4 import media_file
from tools.archive_project import archive_project, write_xlsx
from tools.convert_actions import convert_table_to_actions, main as convert_main
from tools.match_media import (load_journal, scan_media, calibrate_camera_offset,
                               group_split_parts, match_single_camera, match_project)
from tools.usb_manage import USBManager, backup_tuple

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
EPOCH = 1700000000
DELTA = 2082844800


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


class FakeSerial:
    def __init__(self, wire):
        self.wire = bytearray(wire)
        self.commands = []

    def read(self, count):
        value = bytes(self.wire[:count])
        del self.wire[:count]
        return value

    def write(self, raw):
        self.commands.append(json.loads(raw))
        return len(raw)

    def flush(self):
        pass


class Fixture:
    def __init__(self, root):
        self.root = Path(root)
        self.a, self.b, self.output = self.root / "A", self.root / "B", self.root / "output"
        self.a.mkdir(); self.b.mkdir()
        self.log = self.root / "project.jsonl"
        self.actions_path = self.root / "actions.json"
        self.actions = {"schema_version": 1, "template_id": "TPL", "template_name": "洁净室烟雾验证",
                        "actions": [
                            {"action_id": "S01", "name": "静态<气流>&检查", "type": "static", "group": "静态区", "order": 1},
                            {"action_id": "D27", "name": "动态烟雾检查", "type": "dynamic", "group": "灌装区", "order": 2,
                             "points": [{"point_id": "P01", "name": "操作口"}, {"point_id": "P02", "name": "传递口"}]}]}
        self.actions_path.write_bytes(json_bytes(self.actions))
        self.events = []
        self.originals = {}
        self.take_count = 0

    def event(self, kind, mono, boot="boot1", **values):
        row = {"schema_version": 1, "project_id": "PROJECT", "template_id": "TPL",
               "event_seq": len(self.events) + 1, "type": kind, "boot_id": boot,
               "mono_ms": mono, "time_anchor": None, **values}
        self.events.append(row)
        self.flush()
        return row

    def flush(self):
        self.log.write_bytes(b"".join(json_bytes(event) for event in self.events))

    def clip(self, camera, name, start_utc, duration, end_creation=False):
        offset = 3600 if camera == "A" else -7200
        creation = int(start_utc + offset + (duration if end_creation else 0) + DELTA)
        data = media_file(creation=creation, modification=creation, duration=int(duration * 1000))
        path = (self.a if camera == "A" else self.b) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.originals[path] = data
        return path

    def take(self, action="D27", duration=10, cameras=("A", "B"), point="", parts=None, boot="boot1", source="boot"):
        self.take_count += 1
        take_id = self.take_count
        mono = take_id * 100000
        participants = (1 if "A" in cameras else 0) | (2 if "B" in cameras else 0)
        self.event("TAKE_BEGIN", mono, boot, take_id=take_id, action_id=action, point_id=point,
                   source=source, command_id="CMD%d" % take_id, participants=participants)
        evidence = []
        for camera in ("A", "B"):
            participating = camera in cameras
            first = mono + (2000 if camera == "A" else 3000)
            evidence.append({"participating": participating, "start_sent": participating,
                             "seen_recording": participating, "stop_confirmed": participating,
                             "start_ms": mono if participating else None,
                             "stop_ms": mono + duration * 1000 + 20000 if participating else None,
                             "first_record_ms": first if participating else None,
                             "last_record_ms": first + duration * 1000 if participating else None,
                             "record_time": (duration if camera == "A" else duration * 1000) if participating else 0,
                             "unknown": False, "disconnected": False, "stale": False,
                             "unexpected_stop": False, "restarted": False})
            if participating:
                intervals = parts if camera == "A" and parts else [duration]
                elapsed = 0
                for part_index, part_duration in enumerate(intervals, 1):
                    name = "take%d_part%d.MP4" % (take_id, part_index) if len(intervals) > 1 else "take%d.MP4" % take_id
                    self.clip(camera, name, EPOCH + first / 1000 + elapsed, part_duration, camera == "B")
                    elapsed += part_duration
        self.event("TAKE_END", mono + duration * 1000 + 25000, boot, take_id=take_id, action_id=action,
                   point_id=point, begin_boot_id=boot, begin_mono_ms=mono, complete=True, reason="stopped", cameras=evidence)
        return take_id

    def late_anchor(self, boot="boot1", utc=EPOCH):
        event = next(event for event in reversed(self.events) if event["boot_id"] == boot)
        event["time_anchor"] = {"boot_id": boot, "mono_ms": 0, "utc_ms": utc * 1000}
        self.flush()

    def revise(self, kind, take_id, **values):
        return self.event(kind, (self.take_count + 1) * 100000, take_id=take_id, **values)

    def archive(self, **kwargs):
        return archive_project(self.log, self.a, self.b, self.actions_path, self.output, **kwargs)

    def assert_sources(self, test):
        for path, original in self.originals.items():
            test.assertEqual(path.read_bytes(), original)


def workbook_rows(path):
    result = {}
    with zipfile.ZipFile(path) as archive:
        for member in archive.namelist():
            if member.endswith(".xml") or member.endswith(".rels"):
                ET.fromstring(archive.read(member))
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.get("Id"): item.get("Target") for item in relationships}
        for sheet in workbook.findall("s:sheets/s:sheet", NS):
            target = targets[sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")]
            worksheet = ET.fromstring(archive.read("xl/" + target))
            rows = []
            for row in worksheet.findall("s:sheetData/s:row", NS):
                values = []
                for cell in row.findall("s:c", NS):
                    if cell.get("t") == "inlineStr":
                        value = "".join(node.text or "" for node in cell.findall("s:is/s:t", NS))
                    elif cell.get("t") == "b":
                        value = cell.find("s:v", NS).text == "1"
                    else:
                        text = cell.find("s:v", NS).text
                        value = float(text) if "." in text or "e" in text.lower() else int(text)
                    column = 0
                    for char in cell.get("r"):
                        if not char.isalpha():
                            break
                        column = column * 26 + ord(char) - ord("A") + 1
                    while len(values) < column:
                        values.append(None)
                    values[column - 1] = value
                rows.append(values)
            result[sheet.get("name")] = rows
    return result


class ConverterBehavior(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_csv_encodings_chinese_aliases_and_repeated_points(self):
        text = "测试编号,测试内容,类别,所属区域,点位编号,点位名称\nD27,动态烟雾检查,动态,灌装区,P01,操作口\nD27,动态烟雾检查,动态,灌装区,P02,传递口\nS01,静态检查,静态,静态区,,\n"
        expected = [{"point_id": "P01", "name": "操作口"}, {"point_id": "P02", "name": "传递口"}]
        for encoding in ("utf-8", "utf-8-sig", "gb18030"):
            with self.subTest(encoding=encoding):
                path = self.root / (encoding + ".csv")
                path.write_bytes(text.encode(encoding))
                result = convert_table_to_actions(path, "TPL", "烟雾模板")
                self.assertEqual(result["actions"][0]["points"], expected)
                self.assertEqual([action["type"] for action in result["actions"]], ["dynamic", "static"])
                self.assertEqual([action["order"] for action in result["actions"]], [1, 2])
                self.assertEqual(result["actions"][0]["group"], "灌装区")
        output = self.root / "actions.json"
        self.assertEqual(convert_main([str(path), "--template-id", "TPL", "--template-name", "烟雾模板", "--output", str(output)]), 0)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["actions"][0]["points"], expected)
        original = path.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()):
            status = convert_main([str(path), "--template-id", "TPL", "--template-name", "模板", "--output", str(path)])
        self.assertEqual(status, 1)
        self.assertEqual(path.read_bytes(), original)

    def test_sparse_xlsx_first_sheet_shared_and_inline_strings(self):
        path = self.root / "input.xlsx"
        namespace = NS["s"]
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("xl/workbook.xml", '<workbook xmlns="%s" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="first" sheetId="9" r:id="chosen"/></sheets></workbook>' % namespace)
            archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="chosen" Target="worksheets/sheet9.xml"/></Relationships>')
            archive.writestr("xl/sharedStrings.xml", '<sst xmlns="%s"><si><t>条目编号</t></si><si><r><t>动作</t></r><r><t>名称</t></r></si><si><t>S01</t></si></sst>' % namespace)
            archive.writestr("xl/worksheets/sheet9.xml", '<worksheet xmlns="%s"><sheetData><row r="1"><c r="B1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row><row r="3"><c r="B3" t="s"><v>2</v></c><c r="D3" t="inlineStr"><is><t>静态中文检查</t></is></c></row></sheetData></worksheet>' % namespace)
        action = convert_table_to_actions(path, "TPL", "模板")["actions"][0]
        self.assertEqual((action["action_id"], action["name"], action["type"], action["group"]),
                         ("S01", "静态中文检查", "static", "默认分组"))

    def test_docx_multiple_tables_points_and_conflicting_metadata(self):
        path = self.root / "input.docx"
        def row(values):
            return "<w:tr>" + "".join("<w:tc><w:p><w:r><w:t>" + value + "</w:t></w:r></w:p></w:tc>" for value in values) + "</w:tr>"
        with zipfile.ZipFile(path, "w") as archive:
            header = row(["编号", "名称", "点位编号", "点位名称"])
            archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>' + header + row(["D27", "动态检查", "P01", "操作口"]) + '</w:tbl><w:tbl>' + header + row(["D27", "动态检查", "P02", "传递口"]) + '</w:tbl></w:body></w:document>')
        self.assertEqual(convert_table_to_actions(path, "TPL", "模板")["actions"][0]["points"][1], {"point_id": "P02", "name": "传递口"})
        conflict = self.root / "conflict.csv"
        conflict.write_text("编号,名称\nD27,动作一\nD27,动作二\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            convert_table_to_actions(conflict, "TPL", "模板")


class USBBackupBehavior(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.fixture = Fixture(self.temp.name)
        self.fixture.take(duration=10); self.fixture.take(duration=30)
        self.fixture.late_anchor()
        self.data = self.fixture.log.read_bytes()
        self.info = dict(ok=True, template_id="TPL", **backup_tuple(self.data))
        self.backup = Path(self.temp.name) / "backup.jsonl"

    def wire(self, data=None, begin=None, end=None):
        return (b"boot diagnostics\n" + json_bytes(self.info) + json_bytes(begin or dict(self.info, frame="LOG_BEGIN")) +
                (self.data if data is None else data) + json_bytes(end or {"frame": "LOG_END", "ok": True, "event_seq": self.info["event_seq"]}))

    def test_export_preserves_original_bytes_and_reset_uses_verified_tuple(self):
        transport = FakeSerial(self.wire())
        result = USBManager(transport).export(self.backup)
        self.assertEqual(self.backup.read_bytes(), self.data)
        self.assertEqual(result["bytes"], len(self.data))
        self.assertEqual([command["cmd"] for command in transport.commands], ["GET_LOG_INFO", "EXPORT_LOG"])
        transport = FakeSerial(json_bytes(self.info) + json_bytes({"ok": True, "project_id": "", "take_id": 0, "event_seq": 0}))
        self.assertTrue(USBManager(transport).reset(self.backup, confirm=True)["ok"])
        self.assertEqual(transport.commands[-1], dict(cmd="RESET_PROJECT", confirm=True, **backup_tuple(self.data)))

    def test_bad_frames_tuple_lf_and_stale_backup_never_succeed(self):
        bad_data = [self.data[:-1], self.data.replace(b"\n", b"\r\n"), self.data.replace(b'"PROJECT"', b'"OTHERXX"'),
                    self.data.replace(b'"take_id":2', b'"take_id":3'),
                    self.data.replace(b'"event_seq":2', b'"event_seq":1')]
        wires = [self.wire(data=data) for data in bad_data]
        wires += [self.wire(begin=dict(self.info, frame="LOG_BEGIN", bytes=len(self.data) + 1)),
                  self.wire(end={"frame": "LOG_END", "ok": False, "event_seq": self.info["event_seq"]}),
                  self.wire(end={"frame": "LOG_END", "ok": True, "event_seq": 999})]
        for wire in wires:
            with self.subTest(wire_length=len(wire)):
                with self.assertRaises((ValueError, TimeoutError)):
                    USBManager(FakeSerial(wire), timeout=0.01).export(self.backup)
                self.assertFalse(self.backup.exists())
        self.backup.write_bytes(self.data)
        transport = FakeSerial(json_bytes(dict(self.info, event_seq=self.info["event_seq"] + 1)))
        with self.assertRaises(ValueError):
            USBManager(transport).reset(self.backup, confirm=True)
        self.assertEqual([command["cmd"] for command in transport.commands], ["GET_LOG_INFO"])
        transport = FakeSerial(b"")
        with self.assertRaises(ValueError):
            USBManager(transport).reset(self.backup)
        self.assertEqual(transport.commands, [])
        with self.assertRaises(ValueError):
            USBManager(FakeSerial(self.wire())).export(self.backup)
        self.assertEqual(self.backup.read_bytes(), self.data)


class PipelineBehavior(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = Fixture(self.temp.name)

    def chronology(self):
        fixture = self.fixture
        fixture.take(duration=10)
        fixture.take(duration=30)
        fixture.revise("MARK_DISCARD", 2, discard=True)
        fixture.take(duration=20, cameras=("A",))
        fixture.take(duration=40, cameras=("A",), parts=[25, 15])
        fixture.take(action="S01", duration=15)
        fixture.take(duration=50, cameras=("A",), point="P01")
        fixture.late_anchor()
        return fixture

    def test_public_matching_apis_independent_clocks_and_conserved_parts(self):
        fixture = self.chronology()
        journal = load_journal(fixture.log)
        required = {"take_id", "initial_action_id", "initial_point_id", "action_id", "point_id",
                    "discarded", "source", "boot_id", "begin_mono_ms", "end_mono_ms",
                    "time_anchor", "complete", "reason", "cameras"}
        self.assertTrue(all(required <= take.keys() and len(take["cameras"]) == 2 for take in journal["takes"]))
        self.assertEqual(journal["takes"][0]["begin_utc_sec"], EPOCH + 100)
        self.assertEqual(journal["takes"][0]["duration_sec"], 10)
        self.assertEqual(journal["takes"][0]["controller_duration_sec"], 35)
        inventory = scan_media(fixture.a, fixture.b)
        offsets = [calibrate_camera_offset(journal["takes"], inventory[camera]["files"], index)
                   for index, camera in enumerate(("A", "B"))]
        self.assertEqual(offsets, [3600, -7200])
        self.assertTrue(all(isinstance(value, float) for value in offsets))
        for index, camera, hypothesis in ((0, "A", "start"), (1, "B", "end")):
            groups = group_split_parts(inventory[camera]["files"], hypothesis)
            matched = match_single_camera(journal["takes"], groups, index, offsets[index])
            self.assertEqual(matched["matches"][0]["status"], "matched")
            self.assertEqual(sum(len(group["parts"]) for group in matched["clip_groups"]), len(inventory[camera]["files"]))
        report = match_project(fixture.log, fixture.a, fixture.b, fixture.actions_path)
        self.assertEqual(report["cameras"]["A"]["calibration"]["timestamp_hypothesis"], "start")
        self.assertEqual(report["cameras"]["B"]["calibration"]["timestamp_hypothesis"], "end")
        self.assertEqual([take["segment_no"] for take in report["takes"]], [1, None, 2, 3, 1, 4])
        self.assertEqual(report["takes"][2]["camera_matches"]["B"]["status"], "not_participating")
        self.assertEqual(report["takes"][3]["camera_matches"]["A"]["clip_group"]["paths"],
                         [str(fixture.a / "take4_part1.MP4"), str(fixture.a / "take4_part2.MP4")])
        a_groups = report["cameras"]["A"]["clip_groups"]
        missing = match_single_camera(journal["takes"], a_groups[:1], 0, offsets[0])
        self.assertEqual(missing["matches"][1]["status"], "missing")
        pending = match_single_camera(journal["takes"], a_groups, 0, None)
        self.assertEqual({row["status"] for row in pending["matches"]}, {"pending_confirm"})

    def test_big_split_metadata_and_ambiguous_continuations_are_conservative(self):
        def clip(name, start, size=100):
            return {"path": name, "name": name, "camera": "A", "creation_raw": DELTA + start,
                    "duration_sec": 10, "file_size": size, "errors": []}
        clips = [clip("first.MP4", 100, 14 * 1024 ** 3), clip("second.MP4", 110), clip("separate.MP4", 500)]
        groups = group_split_parts(clips)
        self.assertEqual(groups[0]["paths"], ["first.MP4", "second.MP4"])
        self.assertEqual(groups[0]["duration_sec"], 20)
        clips.append(clip("another-second.MP4", 110))
        ambiguous = group_split_parts(clips)
        self.assertEqual(sorted(path for group in ambiguous for path in group["paths"]), sorted(clip["path"] for clip in clips))
        self.assertTrue(all(len(group["parts"]) == 1 for group in ambiguous))
        self.assertTrue(any(group["anomalies"] for group in ambiguous))

    def test_late_anchors_are_boot_scoped_and_last_revisions_win(self):
        fixture = self.fixture
        fixture.take(duration=10)
        fixture.take(duration=30)
        fixture.revise("MARK_DISCARD", 1, discard=True)
        fixture.revise("MARK_DISCARD", 1, discard=False)
        fixture.revise("REASSIGN", 1, action_id="S01", point_id="")
        fixture.late_anchor()
        take = load_journal(fixture.log)["takes"][0]
        self.assertFalse(take["discarded"])
        self.assertEqual((take["initial_action_id"], take["action_id"]), ("D27", "S01"))
        self.assertEqual(take["time_anchor"]["boot_id"], "boot1")
        # Recovery END uptime is unrelated to its BEGIN's monotonic clock.
        events = copy.deepcopy(fixture.events[:2])
        events[1].update(boot_id="boot2", mono_ms=50, complete=False, reason="power_loss",
                         time_anchor={"boot_id": "boot2", "mono_ms": 0, "utc_ms": (EPOCH + 9000) * 1000})
        recovered_path = fixture.root / "recovered.jsonl"
        recovered_path.write_bytes(b"".join(json_bytes(event) for event in events))
        recovered = load_journal(recovered_path)["takes"][0]
        self.assertIsNone(recovered["begin_utc_sec"])
        self.assertIsNone(recovered["time_anchor"])
        self.assertIsNone(recovered["controller_duration_sec"])
        self.assertIsNone(recovered["camera_timing"]["A"]["start_utc_sec"])
        self.assertEqual(recovered["end_mono_ms"], 50)
        self.assertIn("cross_boot_end", {item["code"] for item in recovered["anomalies"]})

    def test_no_anchor_and_double_candidates_stay_pending_and_all_originals_survive(self):
        fixture = self.fixture
        fixture.take(duration=10); fixture.take(duration=30)
        no_anchor = fixture.archive()
        self.assertTrue(all(row["destination"].startswith("_待确认/") for row in no_anchor["files"]))
        self.assertEqual([take["status"] for take in no_anchor["mapping"]["takes"]], ["pending_confirm"] * 2)
        fixture.late_anchor()
        fixture.clip("A", "duplicate.MP4", EPOCH + 102, 10)
        fixture.clip("A", "wild.MP4", EPOCH + 9999, 77)
        corrupt = fixture.a / "broken.MP4"
        corrupt.write_bytes(b"not an mp4")
        fixture.originals[corrupt] = corrupt.read_bytes()
        result = fixture.archive()
        self.assertEqual(result["mapping"]["takes"][0]["camera_matches"]["A"]["status"], "pending_confirm")
        rows = {row["original_name"]: row for row in result["files"] if row["camera"] == "A"}
        for name in ("take1.MP4", "duplicate.MP4", "wild.MP4", "broken.MP4"):
            self.assertTrue(rows[name]["destination"].startswith("_待确认/"))
        self.assertFalse(rows["broken.MP4"]["verified"])
        self.assertEqual(result["counts"]["unverified"], 1)
        self.assertIn("corrupt_media", {item["code"] for item in result["anomalies"]})
        self.assertEqual(len({(row["camera"], row["source"]) for row in result["files"]}), len(result["files"]))
        fixture.assert_sources(self)

    def test_complete_archive_chronology_ledger_and_semantic_rerun(self):
        fixture = self.chronology()
        first = fixture.archive()
        root = Path(first["project_dir"])
        self.assertEqual(root.name, "洁净室烟雾验证_PROJECT_层流烟雾流型验证")
        expected = {
            "D27_动态烟雾检查/D27_第01段_A机.mp4",
            "D27_动态烟雾检查/D27_第01段_B机.mp4",
            "_废片备查/D27_T0002_A机.mp4",
            "_废片备查/D27_T0002_B机.mp4",
            "D27_动态烟雾检查/D27_第02段_A机.mp4",
            "D27_动态烟雾检查/D27_第03段_A机_part01.mp4",
            "D27_动态烟雾检查/D27_第03段_A机_part02.mp4",
            "D27_动态烟雾检查/D27_P01_第04段_A机.mp4",
        }
        actual = {row["destination"] for row in first["files"]}
        self.assertTrue(expected <= actual)
        self.assertNotIn("D27_动态烟雾检查/D27_第02段_B机.mp4", actual)
        self.assertEqual(len(first["files"]), 10)
        self.assertTrue(all(row["verified"] for row in first["files"]))
        self.assertEqual((root / "_台账" / "原始日志.jsonl").read_bytes(), fixture.log.read_bytes())
        self.assertEqual((root / "_台账" / "actions.json").read_bytes(), fixture.actions_path.read_bytes())
        sheets = workbook_rows(first["workbook_path"])
        self.assertEqual(set(sheets), {"拍摄汇总", "文件映射", "异常与修订"})
        headers = sheets["拍摄汇总"][0]
        rows = [dict(zip(headers, row)) for row in sheets["拍摄汇总"][1:]]
        self.assertEqual([row["segment_no"] for row in rows], [1, None, 2, 3, 1, 4])
        self.assertTrue(rows[1]["discarded"])
        self.assertEqual(rows[2]["B状态"], "not_participating")
        self.assertEqual(rows[5]["点位名称"], "操作口")
        self.assertEqual(rows[0]["A时长秒"], 10)
        self.assertIn("MARK_DISCARD", [row[1] for row in sheets["异常与修订"][1:]])
        mapping_bytes = Path(first["mapping_path"]).read_bytes()
        second = fixture.archive()
        self.assertFalse(second["mapping_changed"])
        self.assertEqual(second["counts"]["copied"], 0)
        self.assertEqual(second["counts"]["skipped"], 10)
        self.assertEqual(Path(second["mapping_path"]).read_bytes(), mapping_bytes)
        self.assertFalse((root / "_台账" / "归档映射.v1.json").exists())
        fixture.assert_sources(self)

    def test_revisions_preserve_previous_map_and_renumber_without_reusing_other_takes(self):
        fixture = self.chronology()
        first = fixture.archive()
        first_bytes = Path(first["mapping_path"]).read_bytes()
        root = Path(first["project_dir"])
        old_target = root / "D27_动态烟雾检查" / "D27_第01段_A机.mp4"
        old_bytes = old_target.read_bytes()
        fixture.revise("REASSIGN", 1, action_id="S01", point_id="")
        fixture.revise("MARK_DISCARD", 2, discard=False)
        fixture.revise("MARK_DISCARD", 3, discard=True)
        revised = fixture.archive()
        self.assertTrue(revised["mapping_changed"])
        self.assertEqual(Path(revised["previous_mapping_path"]).name, "归档映射.v1.json")
        self.assertEqual(Path(revised["previous_mapping_path"]).read_bytes(), first_bytes)
        self.assertEqual([take["segment_no"] for take in revised["mapping"]["takes"]], [1, 1, None, 2, 2, 3])
        self.assertEqual(old_target.read_bytes(), old_bytes)
        take2 = next(row for row in revised["files"] if row["take_id"] == 2 and row["camera"] == "A")
        self.assertEqual(take2["destination"], "D27_动态烟雾检查/D27_第01段_A机_v2.mp4")
        self.assertEqual((root / take2["destination"]).read_bytes(), (fixture.a / "take2.MP4").read_bytes())
        rows = workbook_rows(revised["workbook_path"])["异常与修订"][1:]
        reassigned = next(row for row in rows if row[1] == "REASSIGN")
        self.assertEqual((reassigned[4], reassigned[6]), ("D27", "S01"))
        self.assertEqual(sum(row[1] == "MARK_DISCARD" for row in rows), 3)
        self.assertFalse(fixture.archive()["mapping_changed"])
        fixture.assert_sources(self)

    def test_size_and_same_size_unreadable_conflicts_never_overwrite(self):
        fixture = self.fixture
        fixture.take(duration=10); fixture.take(duration=30); fixture.late_anchor()
        first = fixture.archive()
        root = Path(first["project_dir"])
        a_row = next(row for row in first["files"] if row["camera"] == "A" and row["take_id"] == 1)
        target = root / a_row["destination"]
        target.write_bytes(b"occupied")
        result = fixture.archive()
        self.assertEqual(target.read_bytes(), b"occupied")
        alternate = next(row for row in result["files"] if row["camera"] == "A" and row["take_id"] == 1)
        self.assertTrue(alternate["destination"].endswith("_v2.mp4"))
        self.assertTrue(alternate["verified"])
        self.assertEqual((root / alternate["destination"]).read_bytes(), Path(alternate["source"]).read_bytes())
        self.assertIn("destination_size_conflict", {item["code"] for item in result["anomalies"]})
        # Corrupt a different output without changing its byte count.
        b_row = next(row for row in result["files"] if row["camera"] == "B" and row["take_id"] == 1)
        b_target = root / b_row["destination"]
        corrupt = b"x" * b_row["file_size"]
        b_target.write_bytes(corrupt)
        result = fixture.archive()
        self.assertEqual(b_target.read_bytes(), corrupt)
        new_b = next(row for row in result["files"] if row["camera"] == "B" and row["take_id"] == 1)
        self.assertTrue(new_b["destination"].endswith("_v2.mp4"))
        self.assertTrue(new_b["verified"])
        self.assertIn("destination_unreadable_conflict", {item["code"] for item in result["anomalies"]})
        fixture.assert_sources(self)

    def test_recursive_dedup_pending_collisions_and_external_attribution(self):
        fixture = self.fixture
        fixture.take(duration=10); fixture.take(duration=30)
        fixture.take(action="", duration=17, source="external")
        fixture.late_anchor()
        fixture.clip("A", "wild.MP4", EPOCH + 9000, 77)
        fixture.clip("A", "other/wild.MP4", EPOCH + 9500, 77)
        alias = fixture.a / "aliases" / "take1.MP4"
        alias.parent.mkdir()
        alias.write_bytes((fixture.a / "take1.MP4").read_bytes())
        flat = scan_media(fixture.a, fixture.b)
        recursive = scan_media(fixture.a, fixture.b, recursive=True)
        self.assertEqual(len(recursive["A"]["duplicates"]), 1)
        self.assertEqual(len(recursive["A"]["files"]), len(flat["A"]["files"]) + 1)
        result = fixture.archive(recursive=True)
        wild = [row for row in result["files"] if row["original_name"] == "wild.MP4"]
        self.assertEqual({row["destination"] for row in wild}, {"_待确认/A机_wild.MP4", "_待确认/A机_wild_v2.MP4"})
        external = [row for row in result["files"] if row["take_id"] == 3]
        self.assertEqual(len(external), 2)
        self.assertTrue(all(row["destination"].startswith("_待确认/") for row in external))
        self.assertIn("unclassified_external", {item["code"] for item in result["anomalies"]})
        self.assertEqual(len([row for row in result["files"] if row["original_name"] == "take1.MP4"]), 2)
        fixture.assert_sources(self)

    def test_output_sanitization_project_collision_and_input_alias_refusal(self):
        fixture = self.fixture
        fixture.take(duration=10); fixture.take(duration=30); fixture.late_anchor()
        first = fixture.archive(project_name="../中文:项目/CON")
        root = Path(first["project_dir"])
        self.assertTrue(root.is_relative_to(fixture.output.resolve()))
        self.assertNotIn(":", root.name)
        self.assertNotIn("/", root.name)
        for event in fixture.events:
            event["project_id"] = "ANOTHER"
        fixture.flush()
        other = fixture.archive(project_name="../中文:项目/CON")
        self.assertNotEqual(other["project_dir"], first["project_dir"])
        self.assertEqual(json.loads(Path(first["mapping_path"]).read_text())["project_id"], "PROJECT")
        with self.assertRaises(ValueError):
            archive_project(fixture.log, fixture.a, fixture.b, fixture.actions_path, fixture.a)
        # A hard-link output alias must never truncate or overwrite the original log.
        ledger_log = Path(other["project_dir"]) / "_台账" / "原始日志.jsonl"
        ledger_log.unlink()
        try:
            os.link(fixture.log, ledger_log)
        except OSError as exc:
            self.skipTest("filesystem does not support hard links: " + str(exc))
        original_log = fixture.log.read_bytes()
        with self.assertRaises(ValueError):
            fixture.archive(project_name="../中文:项目/CON")
        self.assertEqual(fixture.log.read_bytes(), original_log)
        fixture.assert_sources(self)

    def test_xlsx_is_complete_typed_unicode_and_formula_safe(self):
        path = self.fixture.root / "typed.xlsx"
        text = '中文 <烟雾> & \"核对\"'
        write_xlsx(path, {"拍摄汇总": [["名称", "整数", "秒数", "布尔"], [text, 7, 1.25, True]],
                          "文件映射": [["=SUM(A1:A2)", False]], "异常与修订": [["空列", None, "保留位置"]]})
        sheets = workbook_rows(path)
        self.assertEqual(sheets["拍摄汇总"][1], [text, 7, 1.25, True])
        self.assertEqual(sheets["文件映射"][0], ["=SUM(A1:A2)", False])
        self.assertEqual(sheets["异常与修订"][0], ["空列", None, "保留位置"])
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(set(archive.namelist()), {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
                "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml",
                "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"})
            self.assertIsNone(ET.fromstring(archive.read("xl/worksheets/sheet2.xml")).find(".//s:f", NS))

    def test_archive_script_cli_writes_formal_outputs(self):
        fixture = self.fixture
        fixture.take(duration=10); fixture.take(duration=30); fixture.late_anchor()
        process = subprocess.run([sys.executable, "tools/archive_project.py", "--log", str(fixture.log),
                                  "--cam-a", str(fixture.a), "--cam-b", str(fixture.b),
                                  "--actions", str(fixture.actions_path), "-o", str(fixture.output),
                                  "--project-name", "CLI中文项目"], capture_output=True, text=True, check=False)
        self.assertEqual(process.returncode, 0, process.stderr)
        report = json.loads(process.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["counts"]["copied"], 4)
        self.assertEqual(workbook_rows(report["workbook_path"])["拍摄汇总"][1][0], 1)
        fixture.assert_sources(self)


if __name__ == "__main__":
    unittest.main()
