# Security model — dji-remote-c3

This is the threat model used by Devin security scans. It is shared across pzzp5252's five repositories (claude-code-sourcemap, dji-remote-c3, hvac-validation-docs, opencode-gmp-skills, web-slide-fps), which are unrelated systems scanned separately. This file covers **dji-remote-c3**. Facts marked **(owner)** come from the repository owner; the rest is read from the code. No infrastructure repository exists: these are local tools, firmware and research code, nothing hosted **(owner)**.

## Components

| Component | Code | Trust boundary |
|---|---|---|
| DJI-Firmware | `ble/`, `protocol/`, `gps/`, `logic/`, `main/` (incl. `main/headless/phone_gatt.c`, `phone_service.c`, `phone_wire.c`, `control_service.c`, `dual_control.c`, `journal.c`, `capture.c`) | BLE radio (phone GATT service, DJI cameras), GPS UART, USB serial |
| DJI-Phone-PWA | `phone/` (Web Bluetooth ESM app, `sw.js`, presets) | Data from the device over BLE; static files from the serving host |
| DJI-PC-Tools | `tools/` (`usb_manage.py`, `serve_https.py`, `archive_project.py`, `match_media.py`, `convert_actions.py`, `inspect_mp4.py`) | USB serial device, media files, LAN clients of `serve_https.py` |
| DJI-CI | `.github/workflows/` (`headless-c3.yml`, `release.yml`) | GitHub Actions, release artifacts |

## System overview and entry points

ESP32/ESP32-C3 firmware that controls up to three DJI Osmo Action cameras over BLE, forwards GPS, keeps a LittleFS JSONL journal (take ledger), and exposes a phone GATT service used by the V4 phone PWA.

- The BLE security manager is configured with `sm_bonding = 0`, `sm_mitm = 0`, `sm_sc = 0` (`ble/ble.c`): links are unauthenticated and unencrypted. The phone RX characteristic is a plain `BLE_GATT_CHR_F_WRITE` (`main/headless/phone_gatt.c`) and carries JSON commands (`cmd`, `project_id`, `take_id`, `template_id`, `after_seq`, ...) parsed with cJSON in `phone_service.c`.
- Camera notifications (1D02/1D06 protocol) are parsed in `protocol/`; GPS NMEA from UART in `gps/`.
- USB serial maintenance protocol (status/info/export/reset with backup-tuple guard) driven by `tools/usb_manage.py`.
- `tools/serve_https.py` serves `phone/` over HTTPS and binds `0.0.0.0` by default.

## Attacker profiles that matter

1. **Anyone within Bluetooth radio range of the device or phone at a shoot** — in scope **(owner)**. Needs no credentials (no bonding). Can connect to the phone GATT service, send JSON commands, observe or inject unencrypted traffic, and spoof a camera or the phone.
2. **Someone on the same LAN** while `serve_https.py` is running (inferred; binds all interfaces).
3. **Someone with physical access** to the controller (GPS serial wires, USB) — lower priority (inferred).
4. **Supply chain / CI** — npm dev dependencies, ESP-IDF components in `dependencies.lock`, GitHub Actions workflows (inferred).

## Assets

- **Camera control and take/journal integrity in the field**: recording start/stop, take ledger, project reset/backup **(owner, critical)**.
- **Developer workstations** running `tools/` **(owner)**.
- Lower: footage files handled by the PC tools; GPS location of the operator.

## Existing controls

- USB-exclusive backup-tuple guard for project reset; `reset` requires `--confirm` in `usb_manage.py`.
- Safety STOP lane in the BLE client.
- Host tests with ASan/UBSan.

## Open questions

- Is `serve_https.py` ever run on untrusted networks (venue Wi-Fi)?

## Owner priorities across all repositories

- Integrity of GMP validation records and reports (data integrity, ALCOA+) **(owner, critical)**.
- Camera control and take/journal integrity in the field **(owner, critical)**.
- Developer/QA workstations that run these tools **(owner)**.

## Finding tags

- `Component` (table above), `CVE` for known dependency vulnerabilities, `GMP-relevance` = yes when the finding could affect GMP record/report or data integrity (ALCOA+), otherwise no **(owner)**.
