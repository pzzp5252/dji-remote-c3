# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- C3 take lifecycle with independent camera evidence, durable-before-start admission,
  cancellation during START, explicit single-camera continuation and revised LEDs.
- LittleFS five-event JSONL journal, 8 KiB admission reserve, streaming recovery,
  latest-BEGIN command deduplication, USB JSON management and atomic project reset.
- Separate project/template identities and per-boot UTC anchors; unanchored boots
  remain eligible for manual confirmation rather than invented timestamps.
- `schema/actions.json`, event contract, read-only bounded MP4 metadata inspector,
  and behavior regression coverage for capture, journal and command recovery.
- C3 phone GATT service alongside both camera links, bounded versioned fragments,
  session isolation, status indications and nonblocking snapshot log streaming.
- Browser-native `phone/ble-client.mjs` with incremental durable-storage callbacks,
  cancellation and reconnect isolation; UI handoff in `schema/phone-ble.md`.
- Standard-library CSV/XLSX/DOCX action-template conversion, byte-exact USB
  export and backup-tuple guarded reset, plus independent A/B media matching.
  Matching retains discarded takes in the timeline, applies final attribution,
  skips discarded segment numbers and leaves ambiguous footage for confirmation.
- Source-preserving formal video archiving with split-part names, discard/pending
  directories, provenance-safe collision alternatives and versioned mapping history.
- Dependency-free three-sheet XLSX shooting/file/revision ledger, with 16 passing
  synthetic pipeline behavior tests; real camera-media acceptance remains separate.
- Phone operator UI with plain-Chinese controls, collapsed diagnostics, isolated
  demo storage, stable editing focus/drafts and 24 DOM/ledger behavior regressions.
- Static PWA manifest, self-contained icons and versioned offline app/template
  cache; background network failures do not produce unhandled rejections.
- Persistent A/B/both camera intent shared by phone, USB and BOOT, strict selected-
  camera admission, START intent guard and separate active-take participation.
- Three-view phone workbench for shooting, action selection and recorded takes;
  single-camera history distinguishes non-participation from failed recording.

### Changed

- C3 uses `partitions.c3.csv`, preserving NVS/factory offsets and allocating
  approximately 1.94 MiB to LittleFS; automatic power management disabled.
  The headless application does not initialize/start Wi-Fi; the SDK's internal
  ESP_WIFI_ENABLED capability flag is not a runtime radio switch.
- Recording console requests use explicit JSON commands, not text toggle.
- POSIX build/test scripts use LF on Windows checkouts.
- USB, BOOT and BLE share the control owner; BLE takes retain their source.
  Destructive project reset and legacy text export remain USB-only.

### Fixed

- Preserve the last observed recording timer in TAKE_END instead of overwriting
  it with the camera's post-stop idle zero; found during the real dual-camera test.
- Phone START cancellation now waits for the admitted take identity before one
  STOP; pending requests cannot duplicate START or overwrite fresher camera state.
  STOP acknowledgment alone no longer invents idle confirmation. Empty-project
  transitions clear visible old records/drafts without deleting their backups.
- A stale cached recording status remains a safety veto, but no longer appears as
  fresh recording confirmation on the phone.
- Explicit STOP now covers newly recording peers during shutdown without
  extending its deadline, and journal-unavailable safety STOP leaves idle peers
  alone. A matching STOP after an ended timeout can still stop a recording camera
  without rewriting closed evidence.
- Tablet shortcuts reach their target panels, project initialization preserves
  unsupported firmware capability, and demo identity remains visible across views.
- Mac host-test portability: Darwin extension declarations and canonical owned
  temporary fixture roots, with production output-symlink protection unchanged.

### Verified

- Built the C3 application, bootloader and journal partition table with official
  ESP-IDF 5.5.2, RISC-V GCC 14.2.0 and LittleFS 1.23.1; application is 629888 bytes.
- esptool validated ESP32-C3/4 MB/DIO/40 MHz headers, checksums and image digests.
- Flashed a CORE-ESP32-C3 v0.4 while preserving pairing/log partitions; both
  Action 6 cameras confirmed a single guarded short take and stopped.
- Verified latest-command deduplication, exact 2052-byte/3-event USB export,
  incremental export, persistent recovery and idle reconnect after app update.
  Timer fix passed host regression and was deployed without another recording.
  Existing camera media was not accessed or modified.
- Phone wire/service host regressions and 26 ESM client tests passed; updated
  C3 application was flashed at 0x10000 with device-side hash verification.
- Read-only native Windows BLE smoke passed while both Action 6 cameras remained
  connected and idle: fragmented commands, concurrent status/log traffic,
  USB-only restrictions, reconnect and incremental resume. The current 7-event,
  5737-byte ledger matches pre-update backup and post-update USB export exactly.
  No recording or camera-media commands were sent in this phone integration stage.
  This did not validate actual phone Web Bluetooth or background lifecycle.
- Mac complete host suite passed with Apple Clang 21/ASan/UBSan, cJSON 1.7.19,
  Python 3.14.2 and Node 24.12.0, including 15 MP4, 26 BLE-client, 24 phone-UI and
  16 archive behavior tests, legacy status tests and all 9 handshake scenarios.
- Browser smoke covered operator interactions, pending START cancellation,
  record revisions, collapsed error details, 48px targets, themes and responsive
  layouts. After a full isolated Chrome process restart with its HTTP server
  stopped, cached navigation, reload, template loading and demo connection worked
  offline with no page errors/unhandled rejections. Missing precache assets
  rejected installation without activating an incomplete shell.
  Actual mobile HTTPS/install/BLE, real camera-media matching and prolonged field
  use remain unverified. This Mac stage did not touch firmware or real devices.
- New camera-selection source changes passed Clang/ASan/UBSan integration
  coverage for strict admission, durable intent and isolated dispatch. Corrected
  phone layouts passed browser checks at 375x667, 375x812, 768x900 and 1440x900;
  v4 cached navigation/demo interaction worked after full Chrome restart with
  the HTTP server stopped. The new protocol has not been deployed or exercised
  on the ESP32/cameras; no device, pairing or original-media data was changed.

## [v1.2.0]

### Added

- **Waveshare ESP32-S3-LCD-1.9 support** — New HAL, ESP32-S3 target,
  320x170 landscape IPS display (ST7789V2).
- **Dual-target release builds** — Two merged binaries produced per release,
  one per hardware target.
- **UI layout for 320x170** — Adaptive layout system supporting both
  320x240 (M5Stack) and 320x170 (Waveshare) screen resolutions.
- **GPS Kconfig** — GPS UART pins and baud rate configurable per board
  via Kconfig (no hardcoded pin assignments).

### Removed

- **Manual flash ZIP and scripts** — Web-flash only from this release onward.

## [v1.1.0]

### Added

- **LVGL 9.5.0 UI rendering** — All screens replaced with LVGL widget-based
  rendering via esp_lvgl_port 2.7.2. Replaces manual TFT/SPI drawing.
- **NimBLE BLE stack** — Apache NimBLE replaces Bluedroid as the GATT client
  stack.
- **Boot splash screen** — LVGL-rendered splash screen replaces the raw bitmap
  boot logo.
- **Release packaging automation** — GitHub Actions workflow and
  `build_release.sh` produce merged binary and ZIP for every tagged release.

### Fixed

- **NimBLE scan fixes** — Device names now shown during scan; duplicate filter
  disabled; reconnect-on-unpair prevented.

### Changed

- **Production log level** — Default log level set to ERROR for production
  builds.

## [v1.0.0]

Initial public release. Firmware for M5Stack Basic V2.7 (ESP32).

### Features

- Control up to three DJI Osmo Action cameras simultaneously over BLE
- Live GPS forwarding to all connected cameras (10 Hz)
- Start/stop recording, highlight tags, sleep/wake, snapshot-while-sleeping
- Mode switching via QS button emulation
- Automatic boot-time scanning and reconnection
- Multi-camera action coordination with sequential wake queue
- Optional external hardware buttons (GPIO26, GPIO21, GPIO22)
- Supported cameras: Action 4, Action 5 Pro, Action 6, Osmo 360
