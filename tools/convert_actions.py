#!/usr/bin/env python3
"""Convert CSV, XLSX or DOCX tables to the V1 action dictionary."""

import argparse
import csv
import io
import json
from pathlib import Path
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

ALIASES = {
    "action_id": ("action_id", "编号", "条目编号", "测试编号"),
    "name": ("name", "动作名称", "测试项目", "测试内容", "名称"),
    "type": ("type", "类别", "类型"),
    "group": ("group", "分组", "区域", "工位", "所属区域"),
    "point_id": ("point_id", "点位编号"),
    "point_name": ("point_name", "点位名称"),
}
SHEET = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _identifier(value, limit):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", value) or len(value) > limit:
        raise ValueError("invalid identifier: " + repr(value))
    return value


def _xlsx(path):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.itertext()) for node in root.findall(SHEET + "si")]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        first = workbook.find(SHEET + "sheets/" + SHEET + "sheet")
        if first is None:
            raise ValueError("XLSX contains no worksheet")
        rid = first.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next((item.get("Target") for item in relations if item.get("Id") == rid), None)
        if not target:
            raise ValueError("first worksheet relationship is missing")
        member = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
        root = ET.fromstring(archive.read(member))
        rows = []
        for row in root.findall(".//" + SHEET + "sheetData/" + SHEET + "row"):
            values = []
            for cell in row.findall(SHEET + "c"):
                address = cell.get("r", "")
                letters = re.match(r"([A-Za-z]+)", address)
                index = len(values)
                if letters:
                    index = 0
                    for char in letters[1].upper():
                        index = index * 26 + ord(char) - ord("A") + 1
                    index -= 1
                if index > 16383:
                    raise ValueError("XLSX column exceeds worksheet limit")
                while len(values) <= index:
                    values.append("")
                node = cell.find(SHEET + "v")
                value = (node.text or "") if node is not None else ""
                if cell.get("t") == "s":
                    value = shared[int(value)]
                elif cell.get("t") == "inlineStr":
                    inline = cell.find(SHEET + "is")
                    value = "".join(inline.itertext()) if inline is not None else ""
                values[index] = value
            rows.append(values)
        return [rows]


def _tables(path):
    suffix = Path(path).suffix.lower()
    if suffix == ".csv":
        raw = Path(path).read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("gb18030")
        return [list(csv.reader(io.StringIO(text)))]
    if suffix == ".xlsx":
        return _xlsx(path)
    if suffix == ".docx":
        with zipfile.ZipFile(path) as archive:
            root = ET.fromstring(archive.read("word/document.xml"))
        return [[["".join(node.text or "" for node in cell.iter(WORD + "t"))
                  for cell in row.findall(WORD + "tc")]
                 for row in table.findall(WORD + "tr")]
                for table in root.iter(WORD + "tbl")]
    raise ValueError("expected .csv, .xlsx or .docx input")


def convert_table_to_actions(input_path, template_id, template_name):
    """Return a validated schema_version=1 dictionary; preserve first action order."""
    _identifier(template_id, 63)
    if not template_name.strip():
        raise ValueError("template_name must not be empty")
    actions = {}
    found_header = False
    for rows in _tables(input_path):
        columns = None
        for row in rows:
            row = [str(value).strip() for value in row]
            mapped = {key: next((i for i, name in enumerate(row) if name.casefold() in aliases), None)
                      for key, aliases in ALIASES.items()}
            if mapped["action_id"] is not None and mapped["name"] is not None:
                columns = mapped
                found_header = True
                continue
            if columns is None or not any(row):
                continue
            def value(key):
                index = columns[key]
                return row[index] if index is not None and index < len(row) else ""
            action_id, name = value("action_id"), value("name")
            if not action_id or not name:
                raise ValueError("every action row requires action_id and name")
            _identifier(action_id, 31)
            kind = value("type").casefold()
            kind = {"静态": "static", "动态": "dynamic"}.get(kind, kind)
            if not kind:
                kind = "static" if action_id.upper().startswith("S") else "dynamic"
            if kind not in ("static", "dynamic"):
                raise ValueError("unknown action type: " + kind)
            group = value("group") or "默认分组"
            if action_id not in actions:
                actions[action_id] = {"action_id": action_id, "name": name, "type": kind,
                                      "group": group, "order": len(actions) + 1}
            action = actions[action_id]
            if (action["name"], action["type"], action["group"]) != (name, kind, group):
                raise ValueError("conflicting repeated action: " + action_id)
            point_id, point_name = value("point_id"), value("point_name")
            if point_id or point_name:
                _identifier(point_id, 31)
                if not point_name:
                    raise ValueError("point requires point_name: " + point_id)
                points = action.setdefault("points", [])
                previous = next((point for point in points if point["point_id"] == point_id), None)
                if previous is not None and previous["name"] != point_name:
                    raise ValueError("conflicting repeated point: " + point_id)
                if previous is None:
                    points.append({"point_id": point_id, "name": point_name})
    if not found_header or not actions:
        raise ValueError("no action table with action_id/name headers and rows")
    return {"schema_version": 1, "template_id": template_id, "template_name": template_name,
            "actions": list(actions.values())}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("--template-id", required=True)
    parser.add_argument("--template-name", required=True)
    parser.add_argument("--output", default="actions.json")
    args = parser.parse_args(argv)
    try:
        if Path(args.output).resolve() == Path(args.input).resolve() or (
                Path(args.output).exists() and Path(args.output).samefile(args.input)):
            raise ValueError("output must not overwrite input")
        result = convert_table_to_actions(args.input, args.template_id, args.template_name)
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0
    except (OSError, ValueError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
