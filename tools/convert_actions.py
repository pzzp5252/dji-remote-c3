#!/usr/bin/env python3
"""Convert CSV, XLSX or DOCX tables to the V1 action dictionary."""

from collections import Counter
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
GMP_RECORD4_HEADERS = ("序号", "测试房间/编号", "测试项目", "测试描述")
SHEET = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def derive_room_key(group):
    """Extract canonical laminar hood / room filter key (e.g. CLZ-13, 房间孔洞)."""
    text = str(group or "").strip()
    if not text:
        return "默认分组"
    if "→" in text and "孔洞" in text:
        return "房间孔洞"
    match = re.search(r"CLZ-[A-Za-z]?\d+", text, re.IGNORECASE)
    if match:
        return match.group(0).upper()
    return text


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


def _load_corrections(corrections, template_id):
    if not corrections:
        return {}
    if isinstance(corrections, (str, Path)):
        payload = json.loads(Path(corrections).read_text(encoding="utf-8"))
    elif isinstance(corrections, dict):
        payload = corrections
    else:
        raise ValueError("corrections must be a path or mapping")
    templates = payload.get("templates", {}) if isinstance(payload, dict) else {}
    entry = templates.get(template_id, {}) if isinstance(templates, dict) else {}
    actions = entry.get("actions", {}) if isinstance(entry, dict) else {}
    return actions if isinstance(actions, dict) else {}


def _apply_action_corrections(action, patch):
    if not patch:
        return action
    for old, new in patch.get("text_replace", ()):
        for field in ("group", "name", "description"):
            if field in action and isinstance(action[field], str):
                action[field] = action[field].replace(old, new)
    for key, field in (("group_replace", "group"), ("name_replace", "name"),
                       ("description_replace", "description")):
        for old, new in patch.get(key, ()):
            if field in action and isinstance(action[field], str):
                action[field] = action[field].replace(old, new)
    for field, val in patch.get("set", {}).items():
        action[field] = val
    return action


def _extract_docx_cell_text(cell):
    return "".join(node.text or "" for node in cell.iter(WORD + "t")).strip()


def _extract_gmp_doc_ref(archive, input_path, body_texts):
    candidates = []
    for name in sorted(archive.namelist()):
        if ("header" in name or "footer" in name) and name.endswith(".xml"):
            root = ET.fromstring(archive.read(name))
            txt = "".join(node.text or "" for node in root.iter(WORD + "t")).strip()
            if txt:
                candidates.append(txt)
    candidates.extend(body_texts[:6])
    for text in candidates:
        match = re.search(r"([A-Z]{2,6}[-/][A-Za-z0-9./-]{3,})", text)
        if match:
            return match.group(1)
    return Path(input_path).stem


def _table_has_gmp_headers(table):
    rows = table.findall(WORD + "tr")
    if not rows:
        return False
    first = [_extract_docx_cell_text(cell) for cell in rows[0].findall(WORD + "tc")]
    return (
        len(first) >= 4
        and tuple(first[:4]) == GMP_RECORD4_HEADERS
        and (len(first) < 5 or first[4] in ("可接受标准要求", "可接受标准"))
    )


def _convert_gmp_record4_docx(input_path, template_id, template_name, *, corrections=None, section_filter=None, area_name=None):
    with zipfile.ZipFile(input_path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        body = root.find(WORD + "body")
        if body is None:
            raise ValueError("DOCX body missing")
        children = list(body)
        all_texts = ["".join(n.text or "" for n in c.iter(WORD + "t")).strip()
                     for c in children if c.tag == WORD + "p"]
        joined_top = "\n".join(all_texts)
        has_record4_tables = any(_table_has_gmp_headers(c) for c in children if c.tag == WORD + "tbl")
        if not has_record4_tables:
            if "确认方案" in joined_top or "确认方案" in Path(input_path).name:
                raise ValueError("检测到输入为《确认方案》或不含记录4测试表格，请改为传入《确认记录.docx》")
            return None

        in_record4 = False
        current_kind = None
        current_section = ""
        seen_record4 = False
        rows_out = []
        static_count = 0
        dynamic_count = 0

        for child in children:
            if child.tag == WORD + "p":
                text = "".join(node.text or "" for node in child.iter(WORD + "t")).strip()
                if not text:
                    continue
                if re.search(r"记录\s*4", text):
                    in_record4 = True
                    seen_record4 = True
                    current_kind = None
                    current_section = ""
                    continue
                if in_record4 and re.search(r"^记录\s*(?:[5-9]|[1-9]\d)", text):
                    break
                if in_record4:
                    match = re.search(r"(静态|动态)测试$", text)
                    if match:
                        current_kind = "static" if match.group(1) == "静态" else "dynamic"
                        current_section = re.sub(r"^.*复核人/日期[：:]\s*", "", text).strip()
            elif child.tag == WORD + "tbl" and in_record4:
                if not _table_has_gmp_headers(child):
                    continue
                if section_filter and section_filter not in current_section:
                    continue
                trs = child.findall(WORD + "tr")
                header = [_extract_docx_cell_text(tc) for tc in trs[0].findall(WORD + "tc")]
                criteria_idx = next((i for i, h in enumerate(header) if h in ("可接受标准要求", "可接受标准")), None)
                carry = {}
                for tr in trs[1:]:
                    tcs = tr.findall(WORD + "tc")
                    if not tcs:
                        continue
                    has_span = False
                    row_vals = []
                    for col_idx, tc in enumerate(tcs):
                        tc_pr = tc.find(WORD + "tcPr")
                        grid_span = tc_pr.find(WORD + "gridSpan") if tc_pr is not None else None
                        if grid_span is not None:
                            span_val = int(grid_span.get(WORD + "val") or grid_span.get("val") or "1")
                            if span_val > 1:
                                has_span = True
                                break
                        txt = _extract_docx_cell_text(tc)
                        v_merge = tc_pr.find(WORD + "vMerge") if tc_pr is not None else None
                        if v_merge is not None:
                            vm_val = v_merge.get(WORD + "val") or v_merge.get("val") or "continue"
                            if vm_val == "restart" or txt:
                                carry[col_idx] = txt
                            else:
                                txt = carry.get(col_idx, "")
                        else:
                            carry[col_idx] = txt
                        row_vals.append(txt)
                    if has_span or len(row_vals) < 4:
                        continue
                    seq_val, group_val, name_val, desc_val = (v.strip() for v in row_vals[:4])
                    if not (seq_val.isdigit() and int(seq_val) > 0) or not (group_val and name_val):
                        continue
                    if current_kind not in ("static", "dynamic"):
                        raise ValueError(f"Record 4 row missing preceding (静态|动态)测试 section heading: {seq_val} {name_val}")
                    if current_kind == "static":
                        static_count += 1
                        action_id = f"S{static_count:02d}"
                    else:
                        dynamic_count += 1
                        action_id = f"D{dynamic_count:02d}"
                    criteria_val = row_vals[criteria_idx].strip() if criteria_idx is not None and criteria_idx < len(row_vals) else ""
                    rows_out.append({
                        "action_id": action_id,
                        "name": name_val,
                        "type": current_kind,
                        "group": group_val,
                        "description": desc_val,
                        "doc_ref": {"section": current_section, "seq": seq_val},
                        "order": len(rows_out) + 1,
                        "points": [],
                        "_criteria": criteria_val,
                    })

        if not seen_record4 or not rows_out:
            raise ValueError("DOCX contains 记录4 headers but no valid Record 4 test rows")

        patch_map = _load_corrections(corrections, template_id)
        for item in rows_out:
            _apply_action_corrections(item, patch_map.get(item["action_id"]))
            item["room_key"] = derive_room_key(item["group"])

        criteria_counts = Counter(item["_criteria"] for item in rows_out if item["_criteria"])
        default_criteria = criteria_counts.most_common(1)[0][0] if criteria_counts else ""

        cleaned_actions = []
        for item in rows_out:
            crit = item.pop("_criteria")
            if crit and crit != default_criteria:
                item["criteria"] = crit
            cleaned_actions.append(item)

        payload = {
            "schema_version": 1,
            "template_id": template_id,
            "template_name": template_name,
            "source_doc": _extract_gmp_doc_ref(archive, input_path, all_texts),
        }
        if area_name and str(area_name).strip():
            payload["area_name"] = str(area_name).strip()
        if default_criteria:
            payload["default_criteria"] = default_criteria
        payload["actions"] = cleaned_actions
        return payload


def convert_table_to_actions(input_path, template_id, template_name, *, corrections=None, section_filter=None, area_name=None):
    """Return a validated schema_version=1 dictionary; preserve first action order."""
    _identifier(template_id, 63)
    if not template_name.strip():
        raise ValueError("template_name must not be empty")
    if Path(input_path).suffix.lower() == ".docx":
        gmp_result = _convert_gmp_record4_docx(
            input_path,
            template_id,
            template_name,
            corrections=corrections,
            section_filter=section_filter,
            area_name=area_name,
        )
        if gmp_result is not None:
            return gmp_result
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
    parser.add_argument("--corrections")
    parser.add_argument("--section-filter")
    parser.add_argument("--area-name")
    args = parser.parse_args(argv)
    try:
        if Path(args.output).resolve() == Path(args.input).resolve() or (
                Path(args.output).exists() and Path(args.output).samefile(args.input)):
            raise ValueError("output must not overwrite input")
        result = convert_table_to_actions(
            args.input,
            args.template_id,
            args.template_name,
            corrections=args.corrections,
            section_filter=args.section_filter,
            area_name=args.area_name,
        )
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0
    except (OSError, ValueError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
