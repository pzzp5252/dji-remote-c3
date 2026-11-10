#!/usr/bin/env python3
"""USB status/info/export/reset with byte-exact, verified JSONL backups."""

import argparse
import json
from pathlib import Path
import sys
import time

TUPLE_FIELDS = ("project_id", "event_seq", "take_id", "lines", "bytes")
EVENT_TYPES = {"SELECT_ACTION", "TAKE_BEGIN", "TAKE_END", "MARK_DISCARD", "REASSIGN"}


def _integer(value):
    return type(value) is int and value >= 0


def backup_tuple(data, project_id=None, template_id=None):
    """Validate original UTF-8 JSONL bytes and return the firmware backup tuple."""
    if not isinstance(data, bytes):
        raise ValueError("backup must be bytes")
    if data and not data.endswith(b"\n"):
        raise ValueError("backup has an incomplete final line")
    rows = data.splitlines(keepends=True)
    max_take = 0
    template = template_id
    for sequence, raw in enumerate(rows, 1):
        if not raw.endswith(b"\n") or b"\r" in raw:
            raise ValueError("backup must use original LF line endings")
        event = json.loads(raw.decode("utf-8"))
        if not isinstance(event, dict) or event.get("schema_version") != 1 or event.get("type") not in EVENT_TYPES:
            raise ValueError("invalid journal event at line " + str(sequence))
        if type(event.get("event_seq")) is not int or event["event_seq"] != sequence:
            raise ValueError("journal sequence is not contiguous")
        if project_id is None:
            project_id = event.get("project_id")
        if not isinstance(project_id, str) or not project_id or event.get("project_id") != project_id:
            raise ValueError("journal project mismatch")
        if template is None:
            template = event.get("template_id")
        if not isinstance(template, str) or not template or event.get("template_id") != template:
            raise ValueError("journal template mismatch")
        if event["type"] != "SELECT_ACTION" and "take_id" not in event:
            raise ValueError("take event is missing take_id")
        if "take_id" in event:
            if not _integer(event["take_id"]) or event["take_id"] == 0:
                raise ValueError("invalid journal take_id")
            max_take = max(max_take, event["take_id"])
    return {"project_id": project_id or "", "event_seq": len(rows), "take_id": max_take,
            "lines": len(rows), "bytes": len(data)}


def _info_tuple(info):
    if info.get("ok") is not True or not isinstance(info.get("project_id"), str):
        raise ValueError("device returned invalid log info")
    for key in TUPLE_FIELDS[1:]:
        if not _integer(info.get(key)):
            raise ValueError("device returned invalid " + key)
    return {key: info[key] for key in TUPLE_FIELDS}


class USBManager:
    """A synchronous client; transport provides binary read/write/flush methods."""

    def __init__(self, transport, timeout=15):
        self.transport = transport
        self.timeout = timeout
        self.pending = bytearray()

    def _send(self, command):
        raw = (json.dumps(command, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
        count = self.transport.write(raw)
        if count != len(raw):
            raise OSError("short serial write")
        self.transport.flush()

    def _line(self, deadline):
        while True:
            newline = self.pending.find(b"\n")
            if newline >= 0:
                raw = bytes(self.pending[:newline + 1])
                del self.pending[:newline + 1]
                return raw
            if time.monotonic() >= deadline:
                raise TimeoutError("serial response timed out")
            raw = self.transport.read(1)
            if raw:
                self.pending.extend(raw)
            if len(self.pending) > 1024 * 1024:
                raise ValueError("serial response line exceeds 1 MiB")

    def _response(self, deadline):
        while True:
            raw = self._line(deadline)
            try:
                value = json.loads(raw.decode("utf-8"))
            except (UnicodeError, ValueError):
                continue  # Boot and diagnostic text exists outside export framing.
            if not isinstance(value, dict) or "ok" not in value:
                continue
            if value.get("ok") is not True:
                raise ValueError("device rejected command: " + str(value.get("error", value)))
            return value

    def request(self, command):
        self._send(command)
        return self._response(time.monotonic() + self.timeout)

    def status(self):
        return self.request({"cmd": "GET_STATUS"})

    def info(self):
        value = self.request({"cmd": "GET_LOG_INFO"})
        _info_tuple(value)
        return value

    def export(self, output):
        """Return verified info only after exclusive creation and durable backup write."""
        output = Path(output)
        if output.exists() or output.is_symlink():
            raise ValueError("backup destination already exists")
        info = self.info()
        expected = _info_tuple(info)
        self._send({"cmd": "EXPORT_LOG"})
        deadline = time.monotonic() + self.timeout
        begin = self._response(deadline)
        if begin.get("frame") != "LOG_BEGIN" or _info_tuple(begin) != expected:
            raise ValueError("LOG_BEGIN differs from GET_LOG_INFO")
        if begin.get("template_id") != info.get("template_id"):
            raise ValueError("LOG_BEGIN template mismatch")
        chunks = []
        received = 0
        while True:
            raw = self._line(time.monotonic() + self.timeout)
            try:
                value = json.loads(raw.decode("utf-8"))
            except (UnicodeError, ValueError) as exc:
                raise ValueError("invalid UTF-8 JSON inside export") from exc
            if isinstance(value, dict) and value.get("frame") == "LOG_END":
                if value.get("ok") is not True or value.get("event_seq") != expected["event_seq"]:
                    raise ValueError("export did not finish successfully")
                break
            received += len(raw)
            if received > expected["bytes"]:
                raise ValueError("export exceeds advertised byte count")
            chunks.append(raw)
        data = b"".join(chunks)
        if backup_tuple(data, expected["project_id"], info.get("template_id")) != expected:
            raise ValueError("export does not match advertised backup tuple")
        import os
        try:
            with output.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except OSError:
            # A partially written backup must never masquerade as a successful export.
            raise
        return info

    def reset(self, backup, confirm=False):
        if confirm is not True:
            raise ValueError("reset requires --confirm")
        data = Path(backup).read_bytes()
        local = backup_tuple(data)
        info = self.info()
        if local != _info_tuple(info):
            raise ValueError("backup tuple differs from current project; reset refused")
        # Empty journals cannot establish project identity from local bytes.
        if not data:
            raise ValueError("empty backup has no project identity; reset refused")
        backup_tuple(data, info["project_id"], info.get("template_id"))
        return self.request({"cmd": "RESET_PROJECT", **local, "confirm": True})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--timeout", type=float, default=15)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("info")
    export = sub.add_parser("export")
    export.add_argument("--output", required=True)
    reset = sub.add_parser("reset")
    reset.add_argument("--backup", required=True)
    reset.add_argument("--confirm", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.timeout <= 0:
            raise ValueError("timeout must be positive")
        import serial
        with serial.Serial(args.port, args.baud, timeout=min(args.timeout, 0.2), write_timeout=args.timeout,
                           bytesize=8, parity="N", stopbits=1, rtscts=False, dsrdtr=False) as transport:
            manager = USBManager(transport, args.timeout)
            if args.command == "export":
                result = manager.export(args.output)
            elif args.command == "reset":
                result = manager.reset(args.backup, args.confirm)
            else:
                result = getattr(manager, args.command)()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, UnicodeError, ImportError, TimeoutError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
