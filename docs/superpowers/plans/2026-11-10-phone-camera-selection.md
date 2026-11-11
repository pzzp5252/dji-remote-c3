# Phone Camera Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the phone's long page with a field-shooting workbench and let phone/BOOT explicitly record A, B, or both without silent fallback.

**Architecture:** Extend the existing five-event journal and control owner; do not add a server, another camera state machine, or concurrent takes. The coordinator owns firmware/protocol/integration; native AGY owns phone presentation, mock controller and DOM behavior tests. Existing durable-before-START, confirmed action changes, cancellation, raw log persistence and source-media protection remain intact.

**Tech Stack:** ESP-IDF 5.5.2/C11/cJSON, native browser ESM/CSS/PWA, Node 24/jsdom, Python standard-library archive tools.

**Spec:** The user-reviewed AGY revision at `~/.gemini/antigravity-cli/brain/443076f8-33b9-441a-831a-38f16b676975/implementation_plan.md`; the concrete cross-component contract is frozen below. Execution method remains native AGY for phone work and coordinator-native firmware/integration; no replacement model or new helpers.

## Global Constraints

- No flashing, device reset, pairing changes, real recording commands, or original-media access in this stage. Preserve existing uncommitted work and board journal/pairing partitions.
- Plain Chinese operator UI, collapsed diagnostics, monochrome SVG controls, minimum 48×48px controls, 64px main record control, light/dark themes.
- Phone views: 现场拍摄 / 拍摄清单 / 已拍记录. Initialization appears only when needed; settings can reopen it. Desktop adapts to multiple columns.
- Do not promise no scrolling for every display. Verify 375×667, 375×812 and desktop; long labels, many positions and large text remain accessible through natural vertical scrolling, with fixed navigation clearance.
- Firmware replies, not command submission, establish effective selection. Actual camera feedback establishes recording/stopped state. No automatic recording retries/reconnects.
- Preserve old on-device JSONL bytes. Missing selection fields in historical SELECT_ACTION rows retain the previous target, beginning with default 3; external TAKE_BEGIN must never change the configured target.

## Frozen Wire Contract

- `target_cameras`: integer 1=A, 2=B, 3=both. This is persistent configured intent, never a success indicator. Initial/fresh/reset project value is 3.
- `SELECT_ACTION` accepts optional `target_cameras`, with the existing project/action/position identity. Omission retains the current target. Persist the effective target on every newly emitted SELECT_ACTION event before ACK. Reject booleans, strings, null, fractions, 0 and values >3 without changing selection.
- All control ACKs, GET_LOG_INFO and STATUS return `target_cameras`. STATUS additionally returns `active_participants`: the current admitted take's mask, or 0 when idle. Never overload either field with camera success counts.
- `START` may carry `target_cameras` as an expected-selection guard. An invalid value is `invalid_request`; a value different from the committed target is `target_mismatch`. Reject before allocating a new take or dispatching. Omitting it (USB/BOOT) uses committed intent. Latest-command deduplication must never create another take.
- Phone START always includes its confirmed `target_cameras`. The new phone does not assume that a live firmware lacking valid target/active fields supports selection: disable selection/START and explain firmware support is required; preserve STOP for an already active recording. Historical journal compatibility is separate from live firmware capability.
- For controlled starts, require `(capture_ready_mask(samples, now) & target_cameras) == target_cameras`; BEGIN participants equals the admitted target. A or B alone must not start the other slot. Any connected camera's cached recording bit still vetoes a new controlled take.
- External recordings retain their actual observed mask without overwriting configuration. Freeze configuration during any active/unfinished take.
- STOP covers participating/observed-recording cameras and any currently recording camera, not an uninvolved idle camera; preserve safety-stop behavior during END-write failure.
- Existing TAKE_BEGIN.participants and TAKE_END camera evidence retain their meanings and identities. UI history says 本段未参与 only for an unselected/unobserved camera, not a failed participating camera.

## Review Focus

1. External A-only recording must not change a stored dual-camera target.
2. A-only selection must work with B offline, asleep or stale, but must not start A when a connected B reports recording.
3. A missing/invalid target in a live ACK cannot make the UI claim a new selection was saved.
4. Restoring old journal rows and failed selection writes cannot reset/publish a target incorrectly.
5. Navigation/status updates must not discard search or reassignment drafts, and STOP remains accessible during pending START or unsupported selection capability.

## Task 1 — Durable selection and strict control admission (coordinator)

**Files:** `main/headless/{capture.h,capture.c,journal.h,journal.c,control_service.c}`, existing capture/journal/control tests, new behavior-focused `tests/test_camera_selection.c`, `tests/run_host_tests.sh`, `schema/{events.md,phone-ble.md}`.

**Interfaces:** Add a final `uint8_t target_cameras` parameter to `capture_begin`; migrate every caller, no wrapper alias. Add `uint8_t target_cameras` to `journal_state_t`. Public control-service entrypoints stay unchanged.

- [x] Extend existing behavior tests for strict dual rejection, A/B-only dispatch, STOP isolation, persistent restore, invalid masks, same-command deduplication and consistent USB/BLE/BOOT behavior. Update former automatic-single-ready assumptions to explicit single-camera selection.
- [x] Implement journal defaults/replay and durable effective selection. BEGIN/external events do not mutate the configured target; failed appends do not publish it.
- [x] Implement target validation, ACK/STATUS fields, expected-target guard and capture admission; migrate source/test callers. Preserve START cancellation, recovery and prior media evidence.
- [x] Run the narrow C capture/journal/control/phone-service tests with Clang/ASan/UBSan. Required result: all assertions pass, no command reaches an unselected idle slot, rejected starts consume no take ID.

## Task 2 — Three-view phone operator UI (native AGY)

**Files owned by AGY:** `phone/{app.mjs,styles.css,index.html,sw.js}` and `tests/test_phone_ui.mjs` only. Retain no-build native ESM and the current injectable `createApp`/deterministic mock API. Do not edit firmware, schemas, archive tools, dependencies or shared documentation.

**Interfaces:** Consume/emit Frozen Wire Contract. `SELECT_ACTION` always carries the current action, point and intended target; START carries confirmed target. Fake transport must enforce the same strict mask rules and not claim the unselected camera recorded.

- [x] Add three lightweight views using stable DOM nodes; concentrate action/target/record controls on the shooting view. Provide obvious list/history entry and return paths, per-view scroll restoration and settings access without resetting drafts.
- [x] Add A/B/both selector with pending vs confirmed state, locked selection while recording, target-aware camera readiness and honest history labels. Unknown/live unsupported firmware cannot fake successful selection; STOP and current recording evidence remain usable.
- [x] Extend DOM behavior tests for target ACK/failure, independent camera readiness, non-participation summaries, strict dual admission, view transitions, drafts/focus and unchanged cancellation/persistence invariants. No fixed-copy/source-text tests.
- [x] Maintain PWA cache correctness for changed static resources; do not add a new framework or CDN. Report changed files and consumer-visible behavior through Orca.

## Task 3 — Integration and acceptance (coordinator)

**Files:** `tests/test_archive_pipeline.py` only if the added optional event field reveals a real consumer gap; `docs/{development-handoff.md,headless-c3.md}`, `CHANGELOG.md` and schema documentation.

- [x] Run the complete host entry with Homebrew cJSON flags after integration. Check phone selection and archive handling of actual A/B/non-participation evidence, including old JSONL inputs; do not weaken source-file protections.
- [x] Exercise real browser production/demo entries, all three views, A/B/dual cases, pending/failed selection, START cancellation, STOP, history changes, long/many positions, large text, light/dark themes and mobile/desktop layouts. Verify actual viewport dimensions, target sizes, no horizontal overflow and no lost drafts.
- [x] Verify offline reload/reopen with the changed PWA bundle. Stop throwaway services/remove probes; update docs with only observed verification and explicit remaining real-phone/camera/media boundaries.

No automatic commit/push or device deployment is part of this stage.
