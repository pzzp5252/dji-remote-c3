// Browser-native ESM mobile Bento UI for DJI Osmo Action 6 Dual-Camera Field Controller.
// Zero external dependencies; reuses DjiBleClient from ./ble-client.mjs.

import { DjiBleClient, BleClientError, UUIDS, KINDS } from './ble-client.mjs';

export { DjiBleClient, BleClientError, UUIDS, KINDS };

export const TEMPLATE_CACHE_KEY = 'dji-template-current';
export const THEME_CACHE_KEY = 'dji-ui-theme';
export const STALE_STATUS_MS = 3500;
// Offline H.264 Baseline video: one black 16×16 frame, 1 second, no audio.
const SCREEN_KEEPALIVE_VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMObW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABQwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAKGAAAAAQAAABRzdGNvAAAAAAAAAAEAAAM+AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAACjm1kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAADmWIhAV///8PRQABQt+A';
const POINT_NAME_MAX_LENGTH = 64;

export const DEFAULT_TEMPLATE = Object.freeze({
  schema_version: 1,
  template_id: 'CLEANROOM_SMOKE_V1',
  template_name: '洁净室层流烟雾气流流型验证示例',
  actions: Object.freeze([
    Object.freeze({
      action_id: 'S01',
      name: '静态气流流型检查',
      type: 'static',
      group: '分装区',
      order: 1,
      points: Object.freeze([]),
    }),
    Object.freeze({
      action_id: 'D27',
      name: '人员操作期间气流流型检查',
      type: 'dynamic',
      group: '灌装线',
      order: 2,
      points: Object.freeze([
        Object.freeze({ point_id: 'P01', name: '操作口' }),
        Object.freeze({ point_id: 'P02', name: '物料传递口' }),
      ]),
    }),
  ]),
});

export const LED_LABELS = Object.freeze({
  0: '熄灭（未连接）',
  1: '常亮（可以拍摄）',
  2: '慢闪（正在录像）',
  3: '快闪（请检查）',
});

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

let commandSeqCounter = 0;

export function describeLed(led) {
  return LED_LABELS[led] ?? '未知状态';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `约 ${(bytes / 1024).toFixed(1)} KB`;
  return `约 ${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function createCommandId(nowMs = Date.now()) {
  commandSeqCounter = (commandSeqCounter + 1) % 1296;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  const suffix = commandSeqCounter.toString(36);
  const raw = `BLE_${Number(nowMs).toString(36)}_${rand}${suffix}`;
  return raw.slice(0, 63);
}

export function isValidAsciiId(value, maxBytes = 63) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxBytes) return false;
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

export function isValidTargetCameras(value) {
  return Number.isInteger(value) && value >= 1 && value <= 3;
}

export function isValidActiveParticipants(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

export const TARGET_CAMERA_LABELS = Object.freeze({
  1: '只拍 A 机',
  2: '只拍 B 机',
  3: '双机同拍',
});

export function describeTargetCameras(mask) {
  return TARGET_CAMERA_LABELS[mask] ?? '未指定相机';
}

export function computeCameraAdmission(cameras = [], targetCameras = 3) {
  const list = Array.isArray(cameras) ? cameras : [];
  const anyConnectedRecording = list.some(c => Boolean(c?.connected && c?.recording === true));
  let readyMask = 0;
  for (let i = 0; i < 2; i++) {
    const cam = list[i];
    if (cam?.connected && cam?.fresh !== false && cam?.video !== false &&
        !cam?.sleeping && !cam?.recording && cam?.ready === true) {
      readyMask |= (i === 0 ? 1 : 2);
    }
  }
  const targetValid = isValidTargetCameras(targetCameras);
  const selectedStale = targetValid && [0, 1].some(i => {
    const bit = i === 0 ? 1 : 2;
    const cam = list[i];
    return Boolean((targetCameras & bit) && cam?.connected && cam?.fresh === false);
  });
  const targetReady = targetValid && !anyConnectedRecording && ((readyMask & targetCameras) === targetCameras);
  return {
    readyMask,
    anyConnectedRecording,
    selectedStale,
    targetReady,
  };
}

export function formatTakeCameraSummary(cam, camLetter, takeParticipants = 0, slotIndex = 0) {
  const slotBit = slotIndex === 0 ? 1 : 2;
  const bitParticipated = isValidTargetCameras(takeParticipants)
    ? Boolean(takeParticipants & slotBit)
    : true;
  if (!cam) {
    if (isValidTargetCameras(takeParticipants) && !bitParticipated) {
      return `相机${camLetter}：本段未参与`;
    }
    return `相机${camLetter}：等待拍摄结果`;
  }
  const participated = cam.participating !== undefined ? Boolean(cam.participating) : bitParticipated;
  const hadActivity = Boolean(
    cam.seen_recording || cam.start_sent || cam.start_failed ||
    cam.stop_sent || cam.stop_failed || cam.final_recording
  );
  if (!participated && !hadActivity) {
    return `相机${camLetter}：本段未参与`;
  }
  return `相机${camLetter}：${cam.seen_recording ? '已观察到录像' : '未确认开始录像'}，${cam.stop_confirmed ? '已停止' : '未确认停止'}`;
}

// === Local Ledger Storage & Folding (Strict schema/phone-ble.md Contract) ===

export const ledgerPrefix = projectId => `dji-ledger:${encodeURIComponent(projectId)}:`;
export const ledgerEventKey = (projectId, seq) => `${ledgerPrefix(projectId)}event:${seq}`;
export const ledgerCursorKey = projectId => `${ledgerPrefix(projectId)}cursor`;

export function readCursorValue(storage, projectId) {
  const raw = storage.getItem(ledgerCursorKey(projectId)) ?? '0';
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BleClientError('invalid_local_cursor', 'Invalid local cursor', { project_id: projectId });
  }
  return n;
}

export function loadCursor(storage, projectId) {
  if (!projectId) return 0;
  const claimed = readCursorValue(storage, projectId);
  for (let seq = 1; seq <= claimed; seq++) {
    const raw = storage.getItem(ledgerEventKey(projectId, seq));
    if (raw === null) return seq - 1; // Continuous-prefix recovery; never trust gap after missing event.
    let event;
    try {
      event = JSON.parse(raw);
    } catch (cause) {
      throw new BleClientError('invalid_cached_ledger_json', 'Invalid cached ledger JSON', {
        cause,
        project_id: projectId,
        event_seq: seq,
      });
    }
    if (!event || typeof event !== 'object' || event.project_id !== projectId || event.event_seq !== seq) {
      throw new BleClientError('invalid_cached_ledger_identity', 'Invalid cached ledger identity', {
        project_id: projectId,
        event_seq: seq,
      });
    }
  }
  return claimed;
}

export async function persistEventToStorage(storage, event, { after_seq = event?.event_seq, raw } = {}) {
  if (!event || typeof event.project_id !== 'string' || !event.project_id ||
      !Number.isSafeInteger(event.event_seq) || event.event_seq < 1) {
    throw new BleClientError('invalid_log_event', 'Invalid log event identity');
  }
  const key = ledgerEventKey(event.project_id, event.event_seq);
  const bytes = raw instanceof Uint8Array
    ? raw
    : (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw))
      ? new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length)
      : utf8Encoder.encode(JSON.stringify(event));
  const text = utf8Decoder.decode(bytes);
  const previous = storage.getItem(key);
  if (previous !== null && previous !== text) {
    throw new BleClientError('cached_event_conflict', 'Cached event conflict', {
      project_id: event.project_id,
      event_seq: event.event_seq,
    });
  }
  // Write raw event first, then advance project cursor.
  storage.setItem(key, text);
  const next = Math.max(readCursorValue(storage, event.project_id), after_seq);
  storage.setItem(ledgerCursorKey(event.project_id), String(next));
}

export function foldEventsToTakes(events = []) {
  const takesById = new Map();
  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    const takeId = evt.take_id;
    if (!Number.isSafeInteger(takeId) || takeId < 1) continue;
    if (evt.type === 'TAKE_BEGIN') {
      const existing = takesById.get(takeId);
      takesById.set(takeId, {
        take_id: takeId,
        project_id: evt.project_id || existing?.project_id || '',
        template_id: evt.template_id || existing?.template_id || '',
        initial_action_id: evt.action_id ?? existing?.initial_action_id ?? '',
        initial_point_id: evt.point_id ?? existing?.initial_point_id ?? '',
        action_id: existing?.reassigned ? existing.action_id : (evt.action_id ?? ''),
        point_id: existing?.reassigned ? existing.point_id : (evt.point_id ?? ''),
        command_id: evt.command_id || existing?.command_id || '',
        source: evt.source || existing?.source || '',
        participants: isValidActiveParticipants(evt.participants) ? evt.participants : (existing?.participants ?? 0),
        boot_id: evt.boot_id || existing?.boot_id || '',
        begin_mono_ms: evt.mono_ms ?? existing?.begin_mono_ms ?? null,
        end_mono_ms: existing?.end_mono_ms ?? null,
        end_boot_id: existing?.end_boot_id ?? '',
        time_anchor: evt.time_anchor ?? existing?.time_anchor ?? null,
        discarded: existing?.discarded ?? false,
        reassigned: existing?.reassigned ?? false,
        ended: existing?.ended ?? false,
        complete: existing?.complete ?? false,
        reason: existing?.reason ?? '',
        observation_lost: existing?.observation_lost ?? false,
        cameras: existing?.cameras ?? null,
      });
    } else if (evt.type === 'TAKE_END') {
      const existing = takesById.get(takeId) || {
        take_id: takeId,
        project_id: evt.project_id || '',
        template_id: evt.template_id || '',
        initial_action_id: evt.action_id ?? '',
        initial_point_id: evt.point_id ?? '',
        action_id: evt.action_id ?? '',
        point_id: evt.point_id ?? '',
        command_id: '',
        source: '',
        participants: 0,
        boot_id: evt.begin_boot_id || '',
        begin_mono_ms: evt.begin_mono_ms ?? null,
        end_mono_ms: null,
        time_anchor: null,
        discarded: false,
        reassigned: false,
        ended: false,
        complete: false,
        reason: '',
        observation_lost: false,
        cameras: null,
      };
      existing.ended = true;
      existing.end_mono_ms = evt.mono_ms ?? null;
      existing.end_boot_id = evt.boot_id || '';
      existing.complete = Boolean(evt.complete);
      existing.reason = evt.reason || '';
      existing.observation_lost = Boolean(evt.observation_lost);
      if (!existing.time_anchor && evt.time_anchor) existing.time_anchor = evt.time_anchor;
      if (!existing.action_id && evt.action_id) existing.action_id = evt.action_id;
      if (!existing.point_id && evt.point_id) existing.point_id = evt.point_id;
      existing.cameras = Array.isArray(evt.cameras) ? evt.cameras.map(cam => ({ ...cam })) : [];
      if (!isValidTargetCameras(existing.participants) && existing.cameras.length >= 2) {
        const inferred = (existing.cameras[0]?.participating ? 1 : 0) | (existing.cameras[1]?.participating ? 2 : 0);
        if (isValidTargetCameras(inferred)) existing.participants = inferred;
      }
      takesById.set(takeId, existing);
    } else if (evt.type === 'MARK_DISCARD') {
      const existing = takesById.get(takeId);
      if (existing) {
        existing.discarded = Boolean(evt.discard);
      }
    } else if (evt.type === 'REASSIGN') {
      const existing = takesById.get(takeId);
      if (existing) {
        existing.action_id = evt.action_id ?? '';
        existing.point_id = evt.point_id ?? '';
        existing.reassigned = true;
      }
    }
  }
  return [...takesById.values()].sort((a, b) => a.take_id - b.take_id);
}

export function loadProjectLedger(storage, projectId) {
  if (!projectId) {
    return { project_id: '', after_seq: 0, events: [], takes: [], validCounts: new Map() };
  }
  const cursor = loadCursor(storage, projectId);
  const events = [];
  for (let seq = 1; seq <= cursor; seq++) {
    const raw = storage.getItem(ledgerEventKey(projectId, seq));
    if (raw === null) break;
    events.push(JSON.parse(raw));
  }
  const takes = foldEventsToTakes(events);
  const validCounts = new Map();
  for (const take of takes) {
    if (!take.discarded && take.action_id) {
      validCounts.set(take.action_id, (validCounts.get(take.action_id) || 0) + 1);
    }
  }
  return { project_id: projectId, after_seq: cursor, events, takes, validCounts };
}

// === GMP RFC 4180 CSV Export & Anti-Formula Injection (CWE-1236) ===

export function escapeCsvCell(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val).replace(/[\r\n]+/g, ' ').replace(/^[ ]+|[ ]+$/g, '');
  // CWE-1236 Formula injection guard: prepend single quote if cell starts with formula characters (=, +, -, @, \t, |)
  if (/^[=+\-@\t|]/.test(str)) {
    str = "'" + str;
  }
  // RFC 4180 double-quote escaping
  str = str.replace(/"/g, '""');
  return `"${str}"`;
}

function getTakeDurationMs(take) {
  if (!take?.boot_id || !take.end_boot_id || take.boot_id !== take.end_boot_id ||
      !Number.isFinite(take.begin_mono_ms) || !Number.isFinite(take.end_mono_ms) ||
      take.end_mono_ms < take.begin_mono_ms) return null;
  return take.end_mono_ms - take.begin_mono_ms;
}

function formatElapsedMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function findTemplateAction(template, templateId, actionId) {
  if (!templateId || templateId !== template?.template_id) return null;
  return template.actions?.find(action => action.action_id === actionId) || null;
}

export function exportLedgerCsv(ledger, template, { now = Date.now } = {}) {
  const takes = Array.isArray(ledger?.takes) ? ledger.takes : [];

  const headers = [
    'take_id',
    'action_id',
    'action_name',
    'point_id',
    'point_name',
    'participants',
    'complete',
    'discarded',
    'reason',
    'time_anchor_utc',
    'duration_s',
    'cam_a_recording',
    'cam_a_battery',
    'cam_b_recording',
    'cam_b_battery',
  ];

  const rows = [headers.map(escapeCsvCell).join(',')];

  for (const take of takes) {
    const act = findTemplateAction(template, take.template_id, take.action_id);
    const actName = act?.name || take.action_id || '';
    const pt = act?.points?.find(p => p.point_id === take.point_id);
    const ptName = pt?.name || (take.point_id ? `${take.point_id} (现场点位)` : '未指定');

    let participantsDesc = '未知';
    if (take.participants === 3) participantsDesc = '双机同拍';
    else if (take.participants === 1) participantsDesc = '只拍A机';
    else if (take.participants === 2) participantsDesc = '只拍B机';

    const camA = take.cameras?.[0];
    const camB = take.cameras?.[1];

    const durationMs = getTakeDurationMs(take);
    const durationSec = durationMs !== null ? (durationMs / 1000).toFixed(1) : '';

    let timeAnchorUtc = '';
    if (Number.isFinite(take.time_anchor?.utc_ms) && take.time_anchor.utc_ms > 0) {
      try {
        timeAnchorUtc = new Date(take.time_anchor.utc_ms).toISOString();
      } catch {
        timeAnchorUtc = '';
      }
    }

    const row = [
      take.take_id,
      take.action_id || '',
      actName,
      take.point_id || '',
      ptName,
      participantsDesc,
      take.complete ? '是' : '否',
      take.discarded ? '不使用' : '保留',
      take.reason || '',
      timeAnchorUtc,
      durationSec,
      camA?.seen_recording ? '已录制' : '未录制',
      camA?.battery ?? '',
      camB?.seen_recording ? '已录制' : '未录制',
      camB?.battery ?? '',
    ];
    rows.push(row.map(escapeCsvCell).join(','));
  }

  // Prepend UTF-8 BOM \uFEFF to eliminate Windows Excel Mojibake
  return '\uFEFF' + rows.join('\r\n');
}

// === Point Validation & Auto-Deduction Engine ===

export function deduceNextPointId(existingPoints = []) {
  let maxNum = 0;
  let useTwoDigits = true;
  for (const pt of existingPoints) {
    const pid = typeof pt === 'string' ? pt : (pt?.point_id || '');
    const m = pid.match(/^P(\d+)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxNum) maxNum = num;
      if (m[1].length === 1 && maxNum < 10) useTwoDigits = false;
    }
  }
  const nextNum = maxNum + 1;
  return useTwoDigits && nextNum < 10 ? `P0${nextNum}` : `P${nextNum}`;
}

export function isValidPointId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length < 1 || trimmed.length > 16) return false;
  return /^[A-Za-z0-9_\-]+$/.test(trimmed);
}

// === Template Normalization & Search/Filter ===

export function normalizeTemplate(rawTemplate) {
  if (!rawTemplate || typeof rawTemplate !== 'object' ||
      typeof rawTemplate.template_id !== 'string' || !rawTemplate.template_id.trim() ||
      !Array.isArray(rawTemplate.actions)) {
    throw new BleClientError('invalid_template', 'Invalid actions template');
  }
  const actions = rawTemplate.actions
    .filter(item => item && typeof item === 'object' && typeof item.action_id === 'string' && item.action_id.trim())
    .map((item, idx) => ({
      action_id: item.action_id.trim(),
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.action_id.trim(),
      type: item.type === 'static'
        ? 'static'
        : item.type === 'dynamic'
          ? 'dynamic'
          : (item.action_id.trim().toUpperCase().startsWith('S') ? 'static' : 'dynamic'),
      group: typeof item.group === 'string' && item.group.trim() ? item.group.trim() : '默认分组',
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : idx + 1,
      points: Array.isArray(item.points)
        ? item.points
            .filter(p => p && typeof p.point_id === 'string' && p.point_id.trim())
            .map(p => ({
              point_id: p.point_id.trim(),
              name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.point_id.trim(),
              ...(p.orphan === true ? { orphan: true } : {}),
            }))
        : [],
    }))
    .sort((a, b) => a.order - b.order || a.action_id.localeCompare(b.action_id));

  return {
    schema_version: Number(rawTemplate.schema_version) || 1,
    template_id: rawTemplate.template_id.trim(),
    template_name: typeof rawTemplate.template_name === 'string' && rawTemplate.template_name.trim()
      ? rawTemplate.template_name.trim()
      : rawTemplate.template_id.trim(),
    actions,
  };
}

export function matchesActionQuery(action, rawQuery) {
  const q = (rawQuery ?? '').trim();
  if (!q) return true;
  const lower = q.toLowerCase();
  const idLower = action.action_id.toLowerCase();

  // Numeric zero-padding: e.g. "27" -> D27/S27; "1" -> S01/D01
  if (/^\d+$/.test(q)) {
    const num = Number(q);
    const padded2 = q.padStart(2, '0');
    const padded3 = q.padStart(3, '0');
    const idDigitsMatch = action.action_id.match(/(\d+)/);
    if (idDigitsMatch) {
      const digits = idDigitsMatch[1];
      if (Number(digits) === num || digits === padded2 || digits === padded3 || digits.includes(padded2)) {
        return true;
      }
    }
    return idLower === `s${padded2}` || idLower === `d${padded2}` || idLower.includes(padded2);
  }

  if (idLower.includes(lower)) return true;
  if ((action.name || '').toLowerCase().includes(lower)) return true;
  if ((action.group || '').toLowerCase().includes(lower)) return true;
  if (Array.isArray(action.points)) {
    for (const pt of action.points) {
      if ((pt.point_id || '').toLowerCase().includes(lower) || (pt.name || '').toLowerCase().includes(lower)) {
        return true;
      }
    }
  }
  return false;
}

export function filterActions(actions = [], { query = '', group = 'all', typeFilter = 'all', statusFilter = 'all', validCounts = new Map() } = {}) {
  const sorted = [...actions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.action_id.localeCompare(b.action_id));
  return sorted.filter(action => {
    if (group && group !== 'all' && group !== '全部' && action.group !== group) {
      return false;
    }
    if (typeFilter === 'static') {
      if (action.type !== 'static') return false;
    } else if (typeFilter === 'dynamic') {
      if (action.type !== 'dynamic') return false;
    }
    const count = validCounts.get(action.action_id) || 0;
    if (statusFilter === 'unshot') {
      if (count > 0) return false;
    } else if (statusFilter === 'shot') {
      if (count === 0) return false;
    }
    return matchesActionQuery(action, query);
  });
}

// === Deterministic Mock BLE Client (for ?mock=1 preview and Wave 2 tests) ===

export function createMockBleClient({
  projectId = 'MOCK_PREVIEW_01',
  templateId = 'CLEANROOM_SMOKE_V1',
  actionId = 'S01',
  pointId = '',
  targetCameras = 3,
  ackDelayMs = 20,
  autoConfirmRecordingMs = 30,
  initialEvents = [],
} = {}) {
  const state = {
    connected: false,
    boot_id: 'mockboot20261110',
    mono_ms: 120000,
    time_anchor: null,
    project_id: projectId,
    template_id: templateId,
    action_id: actionId,
    point_id: pointId,
    target_cameras: isValidTargetCameras(targetCameras) ? targetCameras : 3,
    active_participants: 0,
    phase: 'idle',
    take_id: 0,
    active_take_id: 0,
    time_synced: false,
    writable: true,
    storage_error: '',
    free_bytes: 1982464,
    last_command_id: '',
    last_command_take_id: 0,
    activeTakeCameras: null,
    cameras: [
      {
        connected: true,
        fresh: true,
        recording: false,
        record_time: 0,
        battery: 96,
        led: 1,
        video: true,
        sleeping: false,
        status_age_ms: 48,
        ready: true,
      },
      {
        connected: true,
        fresh: true,
        recording: false,
        record_time: 0,
        battery: 92,
        led: 1,
        video: true,
        sleeping: false,
        status_age_ms: 64,
        ready: true,
      },
    ],
    events: [],
    commands: [],
  };

  function appendEvent(type, payload) {
    const seq = state.events.length + 1;
    state.mono_ms += 150;
    const evt = {
      schema_version: 1,
      project_id: state.project_id,
      template_id: state.template_id,
      event_seq: seq,
      type,
      boot_id: state.boot_id,
      mono_ms: state.mono_ms,
      time_anchor: state.time_anchor ? { ...state.time_anchor } : null,
      ...payload,
    };
    state.events.push(evt);
    return evt;
  }

  for (const seed of initialEvents) {
    state.events.push({ ...seed, event_seq: state.events.length + 1 });
    if (seed.take_id && seed.take_id > state.take_id) state.take_id = seed.take_id;
    if (seed.type === 'SELECT_ACTION' && isValidTargetCameras(seed.target_cameras)) {
      state.target_cameras = seed.target_cameras;
    }
  }

  function snapshotStatus() {
    const rawBytes = state.events.reduce((sum, e) => sum + utf8Encoder.encode(JSON.stringify(e)).length + 1, 0);
    return {
      ok: true,
      project_id: state.project_id,
      template_id: state.template_id,
      action_id: state.action_id,
      point_id: state.point_id,
      target_cameras: state.target_cameras,
      event_seq: state.events.length,
      take_id: state.take_id,
      lines: state.events.length,
      bytes: rawBytes,
      writable: state.writable,
      phase: state.phase,
      boot_id: state.boot_id,
      mono_ms: state.mono_ms,
      active_take_id: state.active_take_id,
      active_participants: state.active_participants,
      time_synced: state.time_synced,
      storage_error: state.storage_error,
      free_bytes: state.free_bytes,
      cameras: state.cameras.map(c => ({ ...c })),
    };
  }

  const wait = ms => (ms > 0 ? new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t?.unref?.();
  }) : Promise.resolve());

  const client = {
    onStatus: null,
    onConnection: null,
    onError: null,
    mockState: state,
    get connected() {
      return state.connected;
    },
    emitStatus(overrides = {}) {
      Object.assign(state, overrides);
      const snap = snapshotStatus();
      if (typeof client.onStatus === 'function') {
        void Promise.resolve(client.onStatus(snap));
      }
      return snap;
    },
    confirmRecording() {
      if (!state.connected || state.phase === 'idle') return;
      state.phase = 'recording';
      const mask = isValidTargetCameras(state.active_participants)
        ? state.active_participants
        : (isValidTargetCameras(state.target_cameras) ? state.target_cameras : 3);
      for (let i = 0; i < 2; i++) {
        const bit = i === 0 ? 1 : 2;
        if (mask & bit) {
          state.cameras[i] = { ...state.cameras[i], recording: true, led: 2, record_time: 1 };
          if (state.activeTakeCameras?.[i]) {
            state.activeTakeCameras[i].seen_recording = true;
            state.activeTakeCameras[i].record_time = 5;
            if (state.activeTakeCameras[i].first_record_ms === null) {
              state.activeTakeCameras[i].first_record_ms = state.mono_ms + (i === 0 ? 300 : 320);
            }
          }
        }
      }
      client.emitStatus();
    },
    async connect() {
      await wait(ackDelayMs);
      state.connected = true;
      if (typeof client.onConnection === 'function') {
        void Promise.resolve(client.onConnection({ connected: true, deviceId: 'mock-c3-controller' }));
      }
      return Object.freeze({
        protocol: 1,
        header_bytes: 8,
        max_command_bytes: 767,
        max_message_bytes: 4096,
        default_packet_bytes: 20,
      });
    },
    disconnect() {
      if (!state.connected) return;
      state.connected = false;
      const err = new BleClientError('disconnected', 'disconnected');
      if (typeof client.onConnection === 'function') {
        void Promise.resolve(client.onConnection({ connected: false, error: err }));
      }
    },
    async getStatus() {
      if (!state.connected) throw new BleClientError('disconnected');
      await wait(ackDelayMs);
      return snapshotStatus();
    },
    async syncTime(utcMs = Date.now()) {
      if (!state.connected) throw new BleClientError('disconnected');
      state.commands.push({ cmd: 'TIME_SYNC', utc_ms: utcMs });
      await wait(ackDelayMs);
      state.time_synced = true;
      state.time_anchor = { boot_id: state.boot_id, mono_ms: state.mono_ms, utc_ms: utcMs };
      return {
        ok: true,
        utc_ms: utcMs,
        target_cameras: state.target_cameras,
        event_seq: state.events.length,
        take_id: state.take_id,
      };
    },
    async request(command) {
      if (!state.connected) throw new BleClientError('disconnected');
      if (!command || typeof command.cmd !== 'string') throw new BleClientError('invalid_command');
      if (command.cmd === 'GET_LOG') throw new BleClientError('use_sync_log');
      state.commands.push({ ...command });
      await wait(ackDelayMs);
      if (!state.connected) throw new BleClientError('disconnected');

      if (command.cmd === 'RESET_PROJECT' || command.cmd === 'EXPORT_LOG') {
        const reply = { ok: false, error: 'usb_only' };
        throw new BleClientError('usb_only', 'usb_only', { reply });
      }
      if (command.cmd === 'GET_STATUS') {
        return snapshotStatus();
      }
      if (command.cmd === 'TIME_SYNC') {
        state.time_synced = true;
        state.time_anchor = { boot_id: state.boot_id, mono_ms: state.mono_ms, utc_ms: command.utc_ms };
        return {
          ok: true,
          target_cameras: state.target_cameras,
          event_seq: state.events.length,
          take_id: state.take_id,
        };
      }
      if (command.cmd === 'INIT_PROJECT') {
        if (state.project_id !== '' || state.take_id > 0 || state.phase !== 'idle') {
          const reply = { ok: false, error: 'project_not_empty' };
          throw new BleClientError('project_not_empty', 'project_not_empty', { reply });
        }
        state.project_id = command.project_id;
        state.template_id = command.template_id;
        state.target_cameras = 3;
        state.active_participants = 0;
        return {
          ok: true,
          project_id: state.project_id,
          template_id: state.template_id,
          target_cameras: state.target_cameras,
          event_seq: state.events.length,
          take_id: state.take_id,
        };
      }
      if (command.cmd === 'SELECT_ACTION') {
        if (state.phase !== 'idle') {
          const reply = { ok: false, error: 'recording_active' };
          throw new BleClientError('recording_active', 'recording_active', { reply });
        }
        const pointIdVal = command.point_id ?? '';
        if (!isValidAsciiId(command.action_id, 63) || (pointIdVal !== '' && !isValidAsciiId(pointIdVal, 63))) {
          const reply = { ok: false, error: 'invalid_request' };
          throw new BleClientError('invalid_request', 'invalid_request', { reply });
        }
        if (command.target_cameras !== undefined && !isValidTargetCameras(command.target_cameras)) {
          const reply = { ok: false, error: 'invalid_request' };
          throw new BleClientError('invalid_request', 'invalid_request', { reply });
        }
        state.action_id = command.action_id;
        state.point_id = pointIdVal;
        if (command.target_cameras !== undefined) {
          state.target_cameras = command.target_cameras;
        } else if (!isValidTargetCameras(state.target_cameras)) {
          state.target_cameras = 3;
        }
        appendEvent('SELECT_ACTION', {
          action_id: state.action_id,
          point_id: state.point_id,
          target_cameras: state.target_cameras,
        });
        return {
          ok: true,
          project_id: state.project_id,
          template_id: state.template_id,
          action_id: state.action_id,
          point_id: state.point_id,
          target_cameras: state.target_cameras,
          event_seq: state.events.length,
          take_id: state.take_id,
        };
      }
      if (command.cmd === 'START') {
        if (!state.project_id) {
          throw new BleClientError('project_uninitialized', 'project_uninitialized', {
            reply: { ok: false, error: 'project_uninitialized' },
          });
        }
        if (!state.action_id) {
          throw new BleClientError('no_action_selected', 'no_action_selected', {
            reply: { ok: false, error: 'no_action_selected' },
          });
        }
        if (command.target_cameras !== undefined && !isValidTargetCameras(command.target_cameras)) {
          throw new BleClientError('invalid_request', 'invalid_request', {
            reply: { ok: false, error: 'invalid_request' },
          });
        }
        if (command.command_id && command.command_id === state.last_command_id && state.last_command_take_id > 0) {
          return {
            ok: true,
            project_id: state.project_id,
            take_id: state.last_command_take_id,
            target_cameras: state.target_cameras,
            event_seq: state.events.length,
            duplicate: true,
          };
        }
        if (command.target_cameras !== undefined && command.target_cameras !== state.target_cameras) {
          throw new BleClientError('target_mismatch', 'target_mismatch', {
            reply: { ok: false, error: 'target_mismatch' },
          });
        }
        const admission = computeCameraAdmission(state.cameras, state.target_cameras);
        if (state.phase !== 'idle' || !admission.targetReady) {
          throw new BleClientError('start_rejected_or_storage_full', 'start_rejected_or_storage_full', {
            reply: { ok: false, error: 'start_rejected_or_storage_full' },
          });
        }
        const participants = isValidTargetCameras(state.target_cameras) ? state.target_cameras : 3;
        state.take_id += 1;
        state.active_take_id = state.take_id;
        state.active_participants = participants;
        state.last_command_id = command.command_id || '';
        state.last_command_take_id = state.take_id;
        state.phase = 'starting';
        const beginEvt = appendEvent('TAKE_BEGIN', {
          take_id: state.take_id,
          action_id: state.action_id,
          point_id: state.point_id,
          command_id: command.command_id || '',
          source: 'ble',
          participants,
        });
        state.activeTakeCameras = [0, 1].map(idx => {
          const bit = idx === 0 ? 1 : 2;
          const participating = Boolean(participants & bit);
          if (participating) {
            state.cameras[idx] = { ...state.cameras[idx], recording: false, led: 3, record_time: 0 };
          }
          return {
            participating,
            start_sent: participating,
            start_failed: false,
            stop_sent: false,
            stop_failed: false,
            seen_recording: false,
            stop_confirmed: false,
            disconnected: false,
            reconnected: false,
            stale: false,
            unexpected_stop: false,
            restarted: false,
            unknown: false,
            final_connected: Boolean(state.cameras[idx]?.connected),
            final_recording: false,
            disconnect_count: 0,
            reconnect_count: 0,
            record_time: 0,
            battery: state.cameras[idx]?.battery ?? null,
            start_ms: participating ? beginEvt.mono_ms + (idx === 0 ? 20 : 22) : null,
            stop_ms: null,
            first_record_ms: null,
            last_record_ms: null,
            stopped_ms: null,
            last_sample_ms: state.cameras[idx]?.connected ? state.mono_ms : null,
          };
        });
        if (autoConfirmRecordingMs > 0) {
          const timer = setTimeout(() => {
            if (state.connected && state.phase === 'starting') {
              client.confirmRecording();
            }
          }, autoConfirmRecordingMs);
          timer?.unref?.();
        }
        return {
          ok: true,
          project_id: state.project_id,
          template_id: state.template_id,
          action_id: state.action_id,
          point_id: state.point_id,
          target_cameras: state.target_cameras,
          take_id: state.take_id,
          active_take_id: state.active_take_id,
          active_participants: state.active_participants,
          phase: state.phase,
          event_seq: state.events.length,
        };
      }
      if (command.cmd === 'STOP') {
        const targetTakeId = command.take_id || state.active_take_id || state.take_id;
        if (state.phase === 'idle' && !state.active_take_id) {
          state.cameras = state.cameras.map(cam => cam.connected && cam.recording
            ? { ...cam, recording: false, led: 1, record_time: 0 }
            : cam);
          client.emitStatus();
          return { ok: true, project_id: state.project_id, target_cameras: state.target_cameras,
            take_id: targetTakeId, active_take_id: 0, phase: 'idle', event_seq: state.events.length };
        }
        const beginEvt = [...state.events].reverse().find(e => e.type === 'TAKE_BEGIN' && e.take_id === targetTakeId);
        const participants = isValidTargetCameras(beginEvt?.participants)
          ? beginEvt.participants
          : (isValidTargetCameras(state.active_participants) ? state.active_participants : 3);
        const endCameras = [0, 1].map(idx => {
          const bit = idx === 0 ? 1 : 2;
          const participating = Boolean(participants & bit);
          const tracked = state.activeTakeCameras?.[idx];
          if (!participating) {
            return {
              participating: false,
              start_sent: false,
              start_failed: false,
              stop_sent: false,
              stop_failed: false,
              seen_recording: false,
              stop_confirmed: false,
              disconnected: false,
              reconnected: false,
              stale: false,
              unexpected_stop: false,
              restarted: false,
              unknown: false,
              final_connected: Boolean(state.cameras[idx]?.connected),
              final_recording: Boolean(state.cameras[idx]?.recording),
              disconnect_count: 0,
              reconnect_count: 0,
              record_time: 0,
              battery: state.cameras[idx]?.battery ?? null,
              start_ms: null,
              stop_ms: null,
              first_record_ms: null,
              last_record_ms: null,
              stopped_ms: null,
              last_sample_ms: state.cameras[idx]?.connected ? state.mono_ms : null,
            };
          }
          const seenRec = Boolean(tracked?.seen_recording || state.cameras[idx]?.recording);
          state.cameras[idx] = {
            ...state.cameras[idx],
            recording: false,
            led: state.cameras[idx]?.connected ? 1 : 0,
            record_time: 0,
          };
          return {
            participating: true,
            start_sent: true,
            start_failed: false,
            stop_sent: true,
            stop_failed: false,
            seen_recording: seenRec,
            stop_confirmed: true,
            disconnected: false,
            reconnected: false,
            stale: false,
            unexpected_stop: false,
            restarted: false,
            unknown: false,
            final_connected: Boolean(state.cameras[idx]?.connected),
            final_recording: false,
            disconnect_count: 0,
            reconnect_count: 0,
            record_time: seenRec ? 5 : 0,
            battery: state.cameras[idx]?.battery ?? null,
            start_ms: (beginEvt?.mono_ms ?? state.mono_ms) + (idx === 0 ? 20 : 22),
            stop_ms: state.mono_ms - (idx === 0 ? 100 : 98),
            first_record_ms: seenRec ? (beginEvt?.mono_ms ?? state.mono_ms) + (idx === 0 ? 300 : 320) : null,
            last_record_ms: seenRec ? state.mono_ms - (idx === 0 ? 120 : 110) : null,
            stopped_ms: state.mono_ms,
            last_sample_ms: state.mono_ms,
          };
        });
        const allParticipatingRecorded = endCameras.every(c => !c.participating || (c.seen_recording && c.stop_confirmed));
        state.phase = 'idle';
        state.active_take_id = 0;
        state.active_participants = 0;
        state.activeTakeCameras = null;
        appendEvent('TAKE_END', {
          take_id: targetTakeId,
          action_id: beginEvt?.action_id ?? state.action_id,
          point_id: beginEvt?.point_id ?? state.point_id,
          begin_boot_id: beginEvt?.boot_id ?? state.boot_id,
          begin_mono_ms: beginEvt?.mono_ms ?? (state.mono_ms - 4000),
          reason: allParticipatingRecorded ? 'stopped' : 'cancelled',
          complete: allParticipatingRecorded,
          observation_lost: false,
          cameras: endCameras,
        });
        client.emitStatus();
        return {
          ok: true,
          project_id: state.project_id,
          target_cameras: state.target_cameras,
          take_id: targetTakeId,
          active_take_id: 0,
          phase: 'idle',
          event_seq: state.events.length,
        };
      }
      if (command.cmd === 'MARK_DISCARD') {
        appendEvent('MARK_DISCARD', {
          take_id: command.take_id,
          discard: Boolean(command.discard),
        });
        return {
          ok: true,
          project_id: state.project_id,
          target_cameras: state.target_cameras,
          take_id: command.take_id,
          discard: Boolean(command.discard),
          event_seq: state.events.length,
        };
      }
      if (command.cmd === 'REASSIGN') {
        appendEvent('REASSIGN', {
          take_id: command.take_id,
          action_id: command.action_id,
          point_id: command.point_id ?? '',
        });
        return {
          ok: true,
          project_id: state.project_id,
          target_cameras: state.target_cameras,
          take_id: command.take_id,
          action_id: command.action_id,
          point_id: command.point_id ?? '',
          event_seq: state.events.length,
        };
      }
      throw new BleClientError('unsupported_command', `Unsupported command: ${command.cmd}`);
    },
    async syncLog(afterSeq, reqProjectId, onEvent) {
      if (!state.connected) throw new BleClientError('disconnected');
      state.commands.push({ cmd: 'GET_LOG', project_id: reqProjectId, after_seq: afterSeq });
      await wait(ackDelayMs);
      if (reqProjectId !== state.project_id) {
        throw new BleClientError('invalid_log_begin', 'Project mismatch');
      }
      const snapshotEvents = state.events.slice();
      const totalBytes = snapshotEvents.reduce((sum, e) => sum + utf8Encoder.encode(JSON.stringify(e)).length + 1, 0);
      const slice = snapshotEvents.slice(afterSeq);
      let cursor = afterSeq;
      let sentBytes = 0;
      for (const evt of slice) {
        const raw = utf8Encoder.encode(JSON.stringify(evt));
        await onEvent(evt, { project_id: reqProjectId, after_seq: evt.event_seq, raw });
        cursor = evt.event_seq;
        sentBytes += raw.length + 1;
      }
      return {
        after_seq: cursor,
        snapshot: {
          project_id: state.project_id,
          template_id: state.template_id,
          target_cameras: state.target_cameras,
          event_seq: snapshotEvents.length,
          take_id: state.take_id,
          lines: snapshotEvents.length,
          bytes: totalBytes,
          after_seq: afterSeq,
        },
        sent_lines: slice.length,
        sent_bytes: sentBytes,
      };
    },
  };

  return client;
}

// === Memory Storage Fallback ===

export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
  };
}

// === Monochrome Inline SVG Icons (Stroke 1.75, aria-hidden="true") ===

const ICONS = Object.freeze({
  bluetooth: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"></polyline></svg>`,
  sync: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`,
  upload: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  camera: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  step: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 8 16 12 12 16"></polyline><line x1="8" y1="12" x2="16" y2="12"></line></svg>`,
  prev: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`,
  next: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
  search: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  list: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`,
  history: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  settings: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  record: `<svg class="icon icon-lg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4"></circle></svg>`,
  stop: `<svg class="icon icon-lg" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`,
  copy: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  share: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`,
  download: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  theme: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`,
  alert: `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
});

// === Canonical App Shell Template ===

export function getAppShellMarkup() {
  return `
    <header class="status-banner-wrap">
      <div id="status-banner" class="status-banner" role="status" aria-live="polite" data-tone="idle" data-error-code="">
        <div class="status-banner-main">
          ${ICONS.alert}
          <span id="status-banner-text" class="status-banner-text">请先连接遥控器</span>
        </div>
        <details id="status-banner-details" class="banner-details" hidden>
          <summary>查看详情</summary>
          <code id="status-banner-code" class="status-banner-code"></code>
          <span id="status-banner-detail"></span>
        </details>
      </div>
      <button id="btn-dismiss-feedback" type="button" class="btn" aria-label="关闭提示">关闭</button>
    </header>
    <main class="bento-grid workbench-shell" data-bento-grid="true">
      <section id="topbar-summary" class="topbar-summary bento-span-2" aria-label="遥控器与项目概览">
        <div class="topbar-summary-left">
          <span id="conn-badge" class="badge" data-state="disconnected">
            <span class="badge-dot"></span><span id="conn-badge-text">未连接</span>
          </span>
          <span id="topbar-project-summary" class="topbar-meta-text">未创建项目</span>
        </div>
        <div class="topbar-summary-actions">
          <button id="btn-toggle-settings" type="button" class="btn" aria-haspopup="dialog" aria-expanded="false">${ICONS.settings}<span id="btn-toggle-settings-label">连接与设置</span></button>
          <button id="btn-theme-toggle" type="button" class="btn btn-icon-only" aria-label="切换明暗主题">${ICONS.theme}</button>
        </div>
        <div id="global-record-strip" class="global-record-strip" hidden>
          <span id="global-record-text"></span>
          <button id="btn-global-stop" type="button" class="btn btn-danger">停止录像</button>
        </div>
        <p id="mock-notice" class="mock-notice" hidden>演示模式 · 不会连接真实设备</p>
        <div id="ledger-storage-details" hidden><p id="ledger-storage-notice" role="status"></p><button id="btn-ledger-details" type="button" class="btn">详情</button></div>
      </section>
      <div class="workbench-columns">
        <div id="view-shoot" class="view-panel" data-view-panel="shoot">
          <section id="card-record-ledger" class="bento-card bento-span-2 bento-card-primary" aria-labelledby="title-record-ledger">
            <div id="shoot-scroll-area">
              <div id="shoot-camera-status">
                <div class="card-header">
                  <div class="card-title-group">${ICONS.record}<h2 id="title-record-ledger" class="card-title">录像与相机控制</h2></div>
                  <span id="phase-badge" class="badge" data-state="disconnected">状态：待机</span>
                </div>
                <div id="target-alert-bar" class="target-alert-bar" role="alert" aria-live="polite" hidden></div>
                <div class="camera-pair-grid">
                  ${['a', 'b'].map((camera, index) => {
                    const camLetter = index === 0 ? 'A' : 'B';
                    return `
                  <section id="card-cam-${camera}" class="bento-card bento-span-1 is-disconnected" aria-label="相机 ${camLetter}">
                    <div class="card-header">
                      <div id="cam-${camera}-title-wrap" class="card-title-group">${ICONS.camera}<h2 id="title-cam-${camera}" class="card-title">${camLetter}</h2></div>
                      <span id="cam-${camera}-badge" class="badge" data-state="disconnected"><span class="badge-dot"></span><span id="cam-${camera}-badge-text">${camLetter}机未连接</span></span>
                    </div>
                    <div id="cam-${camera}-metrics" class="cam-metrics" hidden>
                      <div class="kv-item"><span class="kv-label">电量</span><span id="cam-${camera}-battery" class="kv-value"></span></div>
                    </div>
                    <details id="cam-${camera}-details" class="device-details" hidden>
                      <summary>相机详情</summary>
                      <div class="kv-grid">
                        <div class="kv-item"><span class="kv-label">拍摄状态</span><span id="cam-${camera}-mode" class="kv-value">未连接</span></div>
                        <div class="kv-item"><span class="kv-label">最近一次状态更新</span><span id="cam-${camera}-fresh" class="kv-value">未连接</span></div>
                        <div class="kv-item"><span class="kv-label">相机返回的计时数值</span><span id="cam-${camera}-record-time" class="kv-value">0</span></div>
                      </div>
                      <p class="card-subtitle">计时单位尚未确认，这个数值不作为录像时长。</p>
                      <div class="cam-led-box"><span>遥控器指示灯</span><span id="cam-${camera}-led" class="badge"></span></div>
                    </details>
                  </section>`;
                  }).join('')}
                </div>
              </div>
            </div>
            <section id="card-current-action" class="bento-card bento-span-2 bento-card-primary" aria-labelledby="title-current-action">
              <div class="card-header">
                <div class="card-title-group">${ICONS.step}<h2 id="title-current-action" class="card-title visually-hidden">当前拍摄内容</h2></div>
                <div class="card-header-actions">
                  <span id="action-pending-badge" class="badge" data-state="warn" hidden>正在保存动作，请稍候</span>
                </div>
              </div>
              <div class="current-action-hero">
                <div class="current-action-top">
                  <div class="current-action-badges"><span id="confirmed-action-id" class="current-action-code">未选择</span><span id="confirmed-point-id" class="badge" hidden>不指定拍摄位置</span></div>
                  <button id="btn-current-details" type="button" class="btn" aria-haspopup="dialog">展开</button>
                </div>
                <p id="confirmed-action-name" class="current-action-name">请从拍摄清单中选择一项</p>
              </div>
              <div class="button-row">
                <button id="btn-prev-action" type="button" class="btn">${ICONS.prev}<span id="btn-prev-label">上一项</span></button>
                <button id="btn-open-action-list" type="button" class="btn">挑动作</button>
                <button id="btn-next-action" type="button" class="btn"><span id="btn-next-label">下一项</span>${ICONS.next}</button>
              </div>
              <div id="points-container" hidden>
                <div class="card-header" style="margin-bottom: 4px;">
                  <span class="kv-label">拍摄位置</span>
                  <button id="btn-rename-point" type="button" class="btn btn-rename-point" hidden>补中文名</button>
                  <button id="btn-trigger-add-point" type="button" class="btn-add-point" aria-label="现场新增点位">+ 新增</button>
                </div>
                <div id="point-rail-frame" data-overflow-start="false" data-overflow-end="false"><div id="point-pills" class="pill-strip"></div></div>
              </div>
            </section>
            <div id="shoot-record-controls">
            <div id="target-camera-strip" class="target-camera-strip" role="group" aria-label="选择本段使用的相机">
              <button id="btn-target-both" type="button" class="target-cam-btn is-active" data-target-cameras="3" aria-pressed="true">双机同拍</button>
              <button id="btn-target-a" type="button" class="target-cam-btn" data-target-cameras="1" aria-pressed="false">只拍 A 机</button>
              <button id="btn-target-b" type="button" class="target-cam-btn" data-target-cameras="2" aria-pressed="false">只拍 B 机</button>
            </div>
            <div class="record-phase-bar"><span id="record-observation-text">请先连接遥控器</span><span id="active-take-badge" class="badge" hidden></span><span id="record-elapsed" aria-label="本段计时">本段计时：待确认</span></div>
            <button id="btn-record-main" type="button" class="btn btn-ready record-cta-btn" data-mode="start">
              <span id="btn-record-icon">${ICONS.record}</span><span id="btn-record-label">开始录像</span>
            </button>
            <p id="screen-awake-notice" class="card-subtitle" role="status"></p>
            <div id="recent-take-bar" class="recent-take-bar">
              <span id="recent-take-summary" class="recent-take-text"><span id="recent-take-identity">最近：还没有拍摄记录</span><span id="recent-take-result"></span></span>
              <button id="btn-open-records" type="button" class="btn">${ICONS.history}<span>改归属</span></button>
            </div>
            </div>
          </section>
        </div>
        <div id="view-list" class="view-panel" data-view-panel="list" hidden>
          <section id="card-action-search" class="bento-card bento-span-2" aria-labelledby="title-action-search">
            <div class="card-header">
              <div class="card-title-group">${ICONS.search}<h2 id="title-action-search" class="card-title">拍摄清单</h2></div>
              <div class="card-header-actions">
                <span id="action-count-badge" class="badge">0 项</span>
                <button id="btn-list-back-shoot" type="button" class="btn">${ICONS.prev}<span>返回现场拍摄</span></button>
              </div>
            </div>
            <div id="list-selection-return-bar" class="list-return-bar">
              <span id="list-selected-summary" class="topbar-meta-text">当前动作：未选择</span>
              <button id="btn-after-select-return" type="button" class="btn btn-primary">去拍摄此项</button>
            </div>
            <div class="search-box-wrap">${ICONS.search}<input id="input-action-search" type="search" class="input-field search-input" placeholder="搜索编号或拍摄内容" aria-label="搜索编号或拍摄内容" /></div>
            <details id="search-help-details" class="search-help-details">
              <summary>搜索帮助</summary>
              <p class="search-help-text">输入 27 即可找到 D27，也可输入拍摄内容名称、区域或位置进行查找。</p>
            </details>
            <div id="filter-group-pills" class="pill-strip" role="group" aria-label="按区域筛选"></div>
            <div id="filter-type-pills" class="pill-strip" role="group" aria-label="按动作类型筛选"></div>
            <div id="filter-status-pills" class="pill-strip" role="group" aria-label="按拍摄状态筛选"></div>
            <div id="action-list" class="action-list" role="list"></div>
          </section>
        </div>
        <div id="view-records" class="view-panel" data-view-panel="records" hidden>
          <section id="card-records-history" class="bento-card bento-span-2" aria-labelledby="title-records-history">
            <div class="card-header">
              <div class="card-title-group">${ICONS.history}<h2 id="title-records-history" class="card-title">已拍记录</h2></div>
              <div class="card-header-actions">
                <span id="takes-count-badge" class="badge">共 0 段</span>
                <button id="btn-records-sync" type="button" class="btn" disabled>${ICONS.sync}<span>更新拍摄记录</span></button><span id="records-sync-status" role="status"></span>
                <button id="btn-records-back-shoot" type="button" class="btn">${ICONS.prev}<span>返回现场拍摄</span></button>
              </div>
            </div>
            <div id="recent-takes-list" class="takes-list"></div>
            <div class="backup-section">
              <h3 class="backup-title">备份拍摄记录</h3>
              <p class="card-subtitle">备份文件只包含拍摄记录，不包含相机里的视频。</p>
              <div class="button-row">
                <button id="btn-backup-copy" type="button" class="btn btn-muted-outline">${ICONS.copy}<span>复制备份</span></button>
                <button id="btn-backup-share" type="button" class="btn btn-muted-outline">${ICONS.share}<span>分享备份</span></button>
                <button id="btn-backup-download" type="button" class="btn btn-muted-outline">${ICONS.download}<span>保存备份文件</span></button>
                <button id="btn-backup-csv" type="button" class="btn btn-muted-outline">${ICONS.download}<span>导出 CSV 表格</span></button>
              </div>
            </div>
          </section>
        </div>
      </div>
      <nav id="bottom-view-nav" class="bottom-view-nav" aria-label="工作台视图切换">
        <button id="nav-btn-shoot" type="button" class="view-nav-btn is-active" data-view-nav="shoot" aria-pressed="true">${ICONS.record}<span>现场拍摄</span></button>
        <button id="nav-btn-list" type="button" class="view-nav-btn" data-view-nav="list" aria-pressed="false">${ICONS.list}<span>拍摄清单</span></button>
        <button id="nav-btn-records" type="button" class="view-nav-btn" data-view-nav="records" aria-pressed="false">${ICONS.history}<span>已拍记录</span><span id="records-sync-hint" role="status"></span></button>
      </nav>
      <dialog id="modal-settings" class="ios-bottom-sheet" aria-labelledby="title-connection">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-header">
          <button id="btn-settings-close" type="button" class="btn" aria-label="关闭设置">关闭</button>
        </div>
        <section id="card-connection" class="bento-card bento-span-2" aria-labelledby="title-connection">
          <div class="card-header">
            <div class="card-title-group">
              ${ICONS.bluetooth}
              <div>
                <h2 id="title-connection" class="card-title">设备连接与项目设置</h2>
                <p id="template-subtitle" class="card-subtitle"></p>
              </div>
            </div>
          </div>
          <div class="kv-grid">
            <div class="kv-item"><span class="kv-label">当前项目</span><span id="meta-project-id" class="kv-value">尚未创建</span></div>
            <div class="kv-item"><span class="kv-label">记录段数</span><span id="meta-take-id" class="kv-value">0</span></div>
          </div>
          <div class="button-row">
            <button id="btn-connect" type="button" class="btn btn-primary">${ICONS.bluetooth}<span id="btn-connect-label">连接遥控器</span></button>
            <button id="btn-sync-log" type="button" class="btn" disabled>${ICONS.sync}<span>更新拍摄记录</span></button>
            <button id="btn-import-template" type="button" class="btn">${ICONS.upload}<span>导入拍摄清单</span></button>
            <input id="input-template-file" type="file" accept=".json,application/json" aria-label="选择拍摄清单文件" class="visually-hidden" />
          </div>
          <div id="init-project-box" class="init-box" hidden>
            <h3 class="card-title">新建拍摄项目</h3>
            <p class="card-subtitle">给这次拍摄起一个编号，方便之后在电脑上整理视频。可使用字母、数字、下划线或短横线。</p>
            <div class="form-grid">
              <label class="field-label" for="input-init-project-id"><span>项目编号</span><input id="input-init-project-id" type="text" class="input-field" maxlength="63" placeholder="输入本次拍摄的编号" /></label>
              <label class="field-label" for="input-init-template-id"><span>拍摄清单编号</span><input id="input-init-template-id" type="text" class="input-field" maxlength="63" placeholder="输入拍摄清单编号" /></label>
            </div>
            <button id="btn-init-project" type="button" class="btn btn-primary">新建项目</button>
          </div>
          <details id="device-details" class="device-details">
            <summary>设备详情</summary>
            <div class="kv-grid">
              <div class="kv-item"><span class="kv-label">拍摄清单编号</span><span id="meta-template-id" class="kv-value"></span></div>
              <div class="kv-item"><span class="kv-label">设备已保存 / 手机已保存</span><span id="meta-event-seq" class="kv-value">0 / 0</span></div>
              <div class="kv-item"><span class="kv-label">遥控器剩余空间</span><span id="meta-free-bytes" class="kv-value">未知</span></div>
              <div class="kv-item"><span class="kv-label">时间校准与记录保存</span><span id="meta-time-sync" class="kv-value">未连接</span></div>
            </div>
            <div id="usb-reset-notice" class="notice-box" hidden>
              <span>需要清空项目？</span>
              <span class="card-subtitle">请先在电脑上备份，再连接电脑清空遥控器。手机上不能清空项目。</span>
            </div>
          </details>
        </section>
      </dialog>
      <dialog id="modal-add-point" class="ios-bottom-sheet" aria-labelledby="modal-add-point-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <h3 id="modal-add-point-title" class="sheet-title">现场新增点位</h3>
        <form id="form-add-point" class="sheet-form" method="dialog">
          <label class="field-label" for="input-add-point-id">
            <span>点位编号 (如 P01, P02, 必填 ASCII 字母数字)</span>
            <input id="input-add-point-id" type="text" class="input-field" maxlength="16" placeholder="P01" autocomplete="off" pattern="^[A-Za-z0-9_\-]+$" inputmode="text" aria-describedby="msg-add-point-error" required />
          </label>
          <label class="field-label" for="input-add-point-name">
            <span>点位名称 (可选，如 传递口操作面)</span>
            <input id="input-add-point-name" type="text" class="input-field" maxlength="64" placeholder="未命名点位" autocomplete="off" />
          </label>
          <div id="msg-add-point-error" class="sheet-error-msg" role="alert" aria-live="polite"></div>
          <div class="button-row">
            <button id="btn-cancel-add-point" type="button" class="btn btn-muted-outline">取消</button>
            <button id="btn-confirm-add-point" type="submit" class="btn btn-primary">保存并选中</button>
          </div>
        </form>
      </dialog>
      <dialog id="modal-shoot-details" class="ios-bottom-sheet" aria-labelledby="shoot-details-title">
        <div class="sheet-handle" aria-hidden="true"></div>
        <h3 id="shoot-details-title" class="sheet-title"></h3>
        <dl id="shoot-details-content"><dt>类型</dt><dd id="confirmed-action-type"></dd><dt>区域</dt><dd id="confirmed-action-group"></dd></dl>
        <div id="shoot-orphan-points"></div>
        <button id="btn-shoot-details-close" type="button" class="btn">关闭</button>
      </dialog>
    </main>
  `;
}

// === Reconcile Child Order Without Detaching Unchanged Nodes ===

function reconcileChildOrder(container, desiredNodes) {
  if (!container) return;
  const current = Array.from(container.children);
  if (current.length === desiredNodes.length && current.every((node, idx) => node === desiredNodes[idx])) {
    return;
  }
  const desiredSet = new Set(desiredNodes);
  for (const child of current) {
    if (!desiredSet.has(child)) {
      child.remove();
    }
  }
  for (let i = 0; i < desiredNodes.length; i++) {
    const node = desiredNodes[i];
    const existingAtPos = container.children[i];
    if (existingAtPos !== node) {
      container.insertBefore(node, existingAtPos || null);
    }
  }
}

// === Main Application Factory ===

export function createApp({
  root = typeof document !== 'undefined' ? document.getElementById('app-root') : null,
  client: injectedClient = null,
  storage: injectedStorage = null,
  fetchImpl: injectedFetch = null,
  now = () => Date.now(),
  clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null,
  share = typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? navigator.share.bind(navigator) : null,
  download = null,
  staleMs = STALE_STATUS_MS,
} = {}) {
  if (!root) {
    throw new Error('createApp requires a root DOM element');
  }

  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const win = doc?.defaultView || null;
  const fetchFn = injectedFetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  function isDesktopLayout() {
    if (!win) return false;
    if (typeof win.matchMedia === 'function') {
      const mql = win.matchMedia('(min-width: 768px)');
      if (mql && typeof mql.matches === 'boolean') {
        return mql.matches;
      }
    }
    return Number.isFinite(win.innerWidth) && win.innerWidth >= 768;
  }

  if (!root.querySelector('[data-bento-grid="true"]')) {
    root.innerHTML = getAppShellMarkup();
  }

  const isMockUrl = typeof globalThis.location?.search === 'string' &&
    new URLSearchParams(globalThis.location.search).get('mock') === '1';

  const client = injectedClient || (isMockUrl ? createMockBleClient() : new DjiBleClient());
  const isMockMode = isMockUrl || Boolean(client?.mockState);
  const storage = injectedStorage || (
    isMockUrl
      ? createMemoryStorage()
      : (typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage())
  );

  const state = {
    connected: Boolean(client.connected),
    connecting: false,
    syncingLog: false,
    lastStatusReceivedAt: 0,
    activeView: 'shoot', // 'shoot' | 'list' | 'records'
    desktopMode: false,
    viewScrollTop: { shoot: 0, list: 0, records: 0 },
    template: normalizeTemplate(DEFAULT_TEMPLATE),
    templateVersion: 1,
    searchQuery: '',
    groupFilter: 'all',
    typeFilter: 'all',
    statusFilter: 'all',
    pendingSelect: null, // { action_id, point_id, target_cameras } while awaiting SELECT_ACTION ACK
    pendingStartCommandId: null,
    editingReassignTakeId: null,
    reassignDrafts: new Map(), // take_id -> { action_id, point_id }
    lastBackupPayload: null,
    lastErrorCode: '',
    templateSaveError: false,
    templateLoadError: null,
    ledgerReadError: null, // { project_id, code, message }; cleared only by a successful local read
    ledgerSyncError: null, // same shape; cleared only after the current project is fully synced
    status: {
      project_id: '',
      template_id: DEFAULT_TEMPLATE.template_id,
      action_id: '',
      point_id: '',
      target_cameras: 3,
      active_participants: 0,
      selectionSupported: true,
      event_seq: 0,
      take_id: 0,
      active_take_id: 0,
      phase: 'idle',
      boot_id: '',
      mono_ms: 0,
      time_synced: false,
      writable: true,
      storage_error: '',
      free_bytes: null,
      cameras: [
        { connected: false, fresh: false, recording: false, record_time: 0, battery: null, led: 0, video: false, sleeping: false, status_age_ms: null, ready: false },
        { connected: false, fresh: false, recording: false, record_time: 0, battery: null, led: 0, video: false, sleeping: false, status_age_ms: null, ready: false },
      ],
    },
    ledger: {
      project_id: '',
      after_seq: 0,
      events: [],
      takes: [],
      validCounts: new Map(),
    },
  };

  function templateMatchesDevice() {
    return !state.status.project_id || Boolean(state.status.template_id &&
      state.template.template_id === state.status.template_id);
  }
  function currentTemplateAction(actionId = state.status.action_id) {
    return findTemplateAction(state.template,
      state.status.project_id ? state.status.template_id : state.template.template_id, actionId);
  }
  function templateMismatchMessage() {
    return `清单不匹配：设备 ${state.status.template_id || '未知'}，手机 ${state.template.template_id}；请导入设备项目对应的清单后再拍摄或修改归属`;
  }
  function rejectTemplateMismatch() {
    if (templateMatchesDevice()) return false;
    setBanner(templateMismatchMessage(), { tone: 'warn' });
    render();
    return true;
  }

  let pendingStart = null;
  let pendingStop = null;
  let statusVersion = 0;
  let connectionVersion = 0;
  let projectVersion = 0;
  let destroyed = false;
  let hardwareClockAnchor = null;
  let shootDetailsContext = null;
  const monotonicNow = () => win?.performance?.now?.() ?? 0;

  // Keyed DOM caches so interactive controls are NEVER destroyed on tick/STATUS
  const pointPillCache = {
    signature: '',
    nodesByPointId: new Map(),
  };
  let pointRevealRaf = null;
  let pointRevealPending = false;
  let pointRevealIdentity = '';
  let pointFocusRaf = null;
  function updatePointOverflowMarkers() {
    const rail = el('point-pills');
    const frame = el('point-rail-frame');
    if (!rail || !frame) return;
    frame.dataset.overflowStart = rail.scrollLeft > 1 ? 'true' : 'false';
    frame.dataset.overflowEnd = rail.scrollWidth - rail.clientWidth - rail.scrollLeft > 1 ? 'true' : 'false';
  }
  function revealButtonInRail(rail, button) {
    if (!rail || !button || destroyed || el('view-shoot')?.hidden) return;
    const outer = rail.getBoundingClientRect();
    const inner = button.getBoundingClientRect();
    const outerWidth = outer.width ?? (outer.right - outer.left);
    const innerWidth = inner.width ?? (inner.right - inner.left);
    if (!outerWidth || !innerWidth) return;
    const left = outer.left + 12 - inner.left;
    const right = inner.right - (outer.right - 12);
    if (left > 0) rail.scrollLeft -= left;
    else if (right > 0) rail.scrollLeft += right;
    updatePointOverflowMarkers();
  }
  function schedulePointReveal() {
    pointRevealPending = true;
    if (pointRevealRaf !== null || destroyed || el('view-shoot').hidden) return;
    const reveal = () => {
      pointRevealRaf = null;
      if (destroyed || el('view-shoot').hidden) return;
      pointRevealPending = false;
      const rail = el('point-pills');
      const button = pointPillCache.nodesByPointId.get(state.status.point_id || '');
      if (rail && button) {
        revealButtonInRail(rail, button);
      } else {
        updatePointOverflowMarkers();
      }
    };
    if (typeof win?.requestAnimationFrame === 'function') pointRevealRaf = win.requestAnimationFrame(reveal);
    else reveal();
  }
  const onPointFocusIn = e => {
    const button = e.target?.closest?.('.point-pill');
    const rail = el('point-pills');
    if (!button || !rail || destroyed || el('view-shoot')?.hidden || !rail.contains(button)) return;
    if (pointFocusRaf !== null && typeof win?.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(pointFocusRaf);
      pointFocusRaf = null;
    }
    const reveal = () => {
      pointFocusRaf = null;
      if (destroyed || el('view-shoot')?.hidden) return;
      revealButtonInRail(rail, button);
    };
    if (typeof win?.requestAnimationFrame === 'function') {
      pointFocusRaf = win.requestAnimationFrame(reveal);
    } else {
      reveal();
    }
  };
  const groupPillCache = {
    signature: '',
    nodesByGroup: new Map(),
  };
  const typePillNodes = new Map();
  const statusPillNodes = new Map();
  const actionRowCache = new Map(); // action_id -> { btn, idSpan, titleSpan, metaSpan, pendingBadge, countBadge }
  let emptyActionHintEl = null;
  const takeItemCache = new Map(); // take_id -> { itemEl, idSpan, attrSpan, participantsBadge, discardBadge, endBadge, camASpan, camBSpan, btnDiscard, btnDiscardLabel, btnReassign, panel, actionSelect, pointSelect, confirmBtn, cancelBtn, populatedTemplateVersion, populatedActionId }
  let emptyTakesHintEl = null;

  // Query DOM elements inside root
  const el = id => root.querySelector(`#${id}`);
  const bannerEl = el('status-banner');
  const bannerTextEl = el('status-banner-text');
  const bannerCodeEl = el('status-banner-code');

  function setTextIfChanged(node, text) {
    if (!node) return;
    const str = String(text ?? '');
    if (node.textContent !== str) {
      node.textContent = str;
    }
  }

  let feedbackTimer = null;
  let feedbackDismissed = false;
  let feedbackCode = '';
  let feedbackVersion = 0;
  function renderFeedbackVisibility() {
    if (!bannerEl) return;
    const duplicate = Boolean(currentLedgerFailure()) &&
      ['ledger_sync_failed', 'ledger_not_updated', 'ledger_unavailable'].includes(feedbackCode);
    const hidden = feedbackDismissed || bannerEl.dataset.tone === 'idle' || duplicate;
    bannerEl.hidden = hidden;
    bannerEl.parentElement.hidden = hidden;
    updateShootOverflowMode();
  }
  el('btn-dismiss-feedback')?.addEventListener('click', () => {
    feedbackDismissed = true;
    if (feedbackTimer !== null) win?.clearTimeout(feedbackTimer);
    feedbackTimer = null;
    renderFeedbackVisibility();
  });

  function setBanner(message, { tone = 'idle', code = '', detail = '' } = {}) {
    if (!bannerEl) return;
    if (feedbackTimer !== null) win?.clearTimeout(feedbackTimer);
    feedbackTimer = null;
    feedbackDismissed = false;
    feedbackCode = code;
    const version = ++feedbackVersion;
    const isError = tone === 'error';
    const errCode = isError ? (code || '') : '';
    const errDetail = isError ? (detail || '') : '';
    bannerEl.dataset.tone = tone;
    bannerEl.dataset.errorCode = errCode;
    bannerEl.setAttribute('role', isError ? 'alert' : 'status');
    setTextIfChanged(bannerTextEl, message);
    setTextIfChanged(bannerCodeEl, errCode);
    setTextIfChanged(el('status-banner-detail'), errDetail);
    const details = el('status-banner-details');
    if (details) {
      const showDetails = Boolean(isError && (errCode || errDetail));
      details.hidden = !showDetails;
      if (!showDetails) {
        details.open = false;
      }
    }
    if (isError && errCode) state.lastErrorCode = errCode;
    renderFeedbackVisibility();
    if (tone === 'ok') feedbackTimer = win?.setTimeout(() => {
      if (destroyed || version !== feedbackVersion) return;
      feedbackTimer = null;
      feedbackDismissed = true;
      renderFeedbackVisibility();
    }, 2000) ?? null;
  }

  function handleError(contextLabel, error) {
    const code = error?.code || error?.reply?.error || error?.name || 'unknown_error';
    const reasons = {
      disconnected: '连接已断开，请重新连接遥控器。',
      not_connected: '请先连接遥控器。',
      timeout: '没有收到确认，请先更新拍摄记录，不要重复点击。',
      recording_active: '请先停止录像，再修改拍摄内容或相机选择。',
      usb_only: '这个操作需要连接电脑完成。',
      storage_full: '遥控器空间不足，请先在电脑上备份。',
      start_rejected_or_storage_full: '所选相机尚未就绪，或有相机正在录像、遥控器空间不足。',
      target_mismatch: '相机选择尚未同步到遥控器，请重新确认所选相机后再试。',
      invalid_request: '请求内容无效，请检查拍摄内容与相机选择。',
      invalid_select_ack: '遥控器未确认所选相机，请重试或升级遥控器固件。',
      unsupported_firmware: '当前遥控器固件暂不支持相机选择，请先升级遥控器固件。',
      NotFoundError: '没有选中遥控器。',
      NotAllowedError: '请允许浏览器使用蓝牙。',
      project_uninitialized: '请先新建拍摄项目。',
      no_action_selected: '请先选择当前拍摄内容。',
      project_not_empty: '已有项目不能在手机上清空，请先在电脑上备份并清空。',
      invalid_template: '拍摄清单格式不正确，请重新选择文件。',
    };
    setBanner(`${contextLabel}失败：${reasons[code] || '请展开查看详情了解原因。'}`, {
      tone: 'error', code, detail: error?.message || '',
    });
    render();
    return code;
  }

  function switchView(viewName) {
    if (viewName !== 'shoot' && viewName !== 'list' && viewName !== 'records') return;
    const prevView = state.activeView;
    const prevPanel = el(`view-${prevView}`);
    const prevScroll = prevPanel?.scrollTop || win?.scrollY || doc?.documentElement?.scrollTop || 0;
    state.viewScrollTop[prevView] = prevScroll;
    state.activeView = viewName;
    render();
    if (viewName === 'shoot') schedulePointReveal();
    const nextScroll = state.viewScrollTop[viewName] ?? 0;
    const nextPanel = el(`view-${viewName}`);
    if (state.desktopMode && nextPanel && win) {
      const bannerHeight = el('status-banner')?.parentElement?.getBoundingClientRect().height || 0;
      win.scrollTo(0, Math.max(0, nextPanel.getBoundingClientRect().top + (win.scrollY || 0) - bannerHeight));
      return;
    }
    if (nextPanel) nextPanel.scrollTop = nextScroll;
    if (win && typeof win.scrollTo === 'function') {
      win.scrollTo(0, nextScroll);
    }
  }

  let shootResizeObserver = null;
  function updateShootOverflowMode() {
    const view = el('view-shoot');
    const controls = el('shoot-record-controls');
    const currentAction = el('card-current-action');
    if (!view || !controls || !currentAction) return;
    let overflow = false;
    if (!isDesktopLayout() && !view.hidden) {
      const fontSize = parseFloat(win?.getComputedStyle?.(doc.documentElement).fontSize);
      if (view.clientHeight <= 0 || !Number.isFinite(fontSize)) return;
      overflow = controls.scrollHeight + currentAction.scrollHeight + 8 * fontSize > view.clientHeight;
    }
    if (view.classList.contains('is-overflow-layout') !== overflow) {
      view.classList.toggle('is-overflow-layout', overflow);
      root.classList.toggle('is-overflow-layout', overflow);
    }
  }
  if (typeof win?.ResizeObserver === 'function') {
    shootResizeObserver = new win.ResizeObserver(updateShootOverflowMode);
    shootResizeObserver.observe(el('view-shoot'));
    shootResizeObserver.observe(el('shoot-record-controls'));
    shootResizeObserver.observe(el('card-current-action'));
  }

  const dialogRecords = new WeakMap();
  const sheetViewport = win?.visualViewport;
  function updateSheetViewport() {
    for (const id of ['modal-add-point', 'modal-shoot-details', 'modal-settings']) {
      const sheet = el(id);
      sheet?.style.setProperty('--sheet-viewport-height', `${sheetViewport?.height ?? win?.innerHeight ?? 0}px`);
      sheet?.style.setProperty('--sheet-viewport-top', `${sheetViewport?.offsetTop ?? 0}px`);
    }
  }
  sheetViewport?.addEventListener?.('resize', updateSheetViewport);
  sheetViewport?.addEventListener?.('scroll', updateSheetViewport);
  function openDialog(dialog, { returnFocus = doc.activeElement } = {}) {
    if (!dialog || destroyed || dialog.open || dialogRecords.get(dialog)?.closingPromise) return;
    for (const otherId of ['modal-add-point', 'modal-shoot-details', 'modal-settings']) {
      if (otherId === dialog.id) continue;
      const other = el(otherId);
      if (other?.open) void closeDialog(other, { immediate: true });
    }
    dialogRecords.set(dialog, { returnFocus, closingPromise: null, animation: null });
    updateSheetViewport();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (dialog.id === 'modal-settings') {
      const btn = el('btn-toggle-settings');
      if (btn) {
        btn.setAttribute('aria-expanded', 'true');
        btn.classList.add('is-active');
      }
    }
  }
  function closeDialog(dialog, { immediate = false } = {}) {
    if (!dialog) return Promise.resolve();
    const record = dialogRecords.get(dialog);
    const finish = () => {
      if (record && dialogRecords.get(dialog) !== record) return;
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else { dialog.removeAttribute('open'); dialog.dispatchEvent(new win.Event('close')); }
      }
      if (dialog.id === 'modal-settings') {
        const btn = el('btn-toggle-settings');
        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
          btn.classList.remove('is-active');
        }
      }
    };
    if (immediate) {
      record?.animation?.cancel?.();
      finish();
      return record?.closingPromise || Promise.resolve();
    }
    if (record?.closingPromise) return record.closingPromise;
    if (!dialog.open || !record || typeof dialog.animate !== 'function' ||
        win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      finish();
      return Promise.resolve();
    }
    const computed = win.getComputedStyle(dialog);
    try {
      record.animation = dialog.animate([
        { transform: computed.transform === 'none' ? 'translateY(0)' : computed.transform, opacity: computed.opacity || '1' },
        { transform: 'translateY(100%)', opacity: '0' },
      ], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      record.closingPromise = Promise.resolve(record.animation.finished).catch(() => {}).then(() => {
        finish();
        record.animation?.cancel?.();
      });
      return record.closingPromise;
    } catch { finish(); return Promise.resolve(); }
  }

  let screenAwakeMode = 'idle';
  let screenAwakeMessage = '';
  function setScreenAwakeNotice(mode, message) {
    screenAwakeMode = mode;
    screenAwakeMessage = message;
    const notice = el('screen-awake-notice');
    if (notice) {
      notice.dataset.mode = mode;
      notice.hidden = mode === 'idle' || mode === 'system';
      setTextIfChanged(notice, message);
    }
  }
  let wakeLockSentinel = null;
  let wakeLockRequest = null;
  let keepAliveVideoEl = null;
  let keepAlivePlay = null;
  let wakeLockWanted = false;
  let wakeLockGeneration = 0;

  function showManualScreenNotice() {
    if (wakeLockSentinel && !wakeLockSentinel.released) return;
    setScreenAwakeNotice('manual', '请手动保持屏幕常亮');
  }

  // Invoke play synchronously in the START gesture, before awaiting BLE or WakeLock.
  function playKeepAliveVideo() {
    if (keepAlivePlay) return keepAlivePlay;
    if (keepAliveVideoEl?.paused === false) return Promise.resolve(true);
    const nav = win?.navigator;
    if (/jsdom/i.test(nav?.userAgent || '') || !doc?.body) return Promise.resolve(false);
    const generation = wakeLockGeneration;
    try {
      if (!keepAliveVideoEl) {
        const video = doc.createElement('video');
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        video.muted = true;
        video.loop = true;
        video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none';
        video.src = SCREEN_KEEPALIVE_VIDEO;
        doc.body.appendChild(video);
        keepAliveVideoEl = video;
      }
      const video = keepAliveVideoEl;
      const playback = video.play();
      if (!playback || typeof playback.then !== 'function') {
        showManualScreenNotice();
        return Promise.resolve(false);
      }
      const operation = Promise.resolve(playback).then(() => {
        if (destroyed || generation !== wakeLockGeneration || !wakeLockWanted) {
          video.pause?.();
          video.remove?.();
          return false;
        }
        // Playback is observable; Bluefy's screen-awake effect still needs a real device.
        if (!wakeLockSentinel) setScreenAwakeNotice('video', '辅助视频已播放，防息屏请现场确认');
        return true;
      }, () => {
        if (!destroyed && generation === wakeLockGeneration && wakeLockWanted) showManualScreenNotice();
        return false;
      }).finally(() => {
        if (keepAlivePlay === operation) keepAlivePlay = null;
      });
      keepAlivePlay = operation;
      return operation;
    } catch {
      showManualScreenNotice();
      return Promise.resolve(false);
    }
  }

  function acquireWakeLock() {
    if (destroyed || !state.connected) return Promise.resolve(false);
    wakeLockWanted = true;
    if (wakeLockSentinel && !wakeLockSentinel.released) return Promise.resolve(true);
    if (wakeLockRequest) return wakeLockRequest;
    const generation = wakeLockGeneration;
    const nav = win?.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav?.wakeLock?.request) return playKeepAliveVideo();
    // request is called now; ownership is installed before any awaited completion.
    const operation = (async () => {
      try {
        const sentinel = await nav.wakeLock.request('screen');
        if (destroyed || !wakeLockWanted || generation !== wakeLockGeneration) {
          await sentinel.release();
          return false;
        }
        wakeLockSentinel = sentinel;
        sentinel.addEventListener?.('release', () => {
          if (wakeLockSentinel === sentinel) {
            wakeLockSentinel = null;
            if (wakeLockWanted) showManualScreenNotice();
          }
        });
        setScreenAwakeNotice('system', '已申请系统保持亮屏');
        return true;
      } catch {
        if (!destroyed && wakeLockWanted && generation === wakeLockGeneration) return playKeepAliveVideo();
        return false;
      }
    })();
    wakeLockRequest = operation;
    void operation.finally(() => { if (wakeLockRequest === operation) wakeLockRequest = null; });
    return operation;
  }

  async function releaseWakeLock() {
    wakeLockWanted = false;
    wakeLockGeneration += 1;
    // Detach ownership before await so old release cannot clear a newer sentinel.
    wakeLockRequest = null;
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    const video = keepAliveVideoEl;
    keepAliveVideoEl = null;
    keepAlivePlay = null;
    if (video) {
      try { video.pause?.(); video.remove?.(); } catch {}
    }
    setScreenAwakeNotice('idle', '未申请保持亮屏');
    if (sentinel) { try { await sentinel.release(); } catch {} }
  }

  function harvestOrphanPointsFromLedger() {
    state.templateSaveError = false;
    if (!state.ledger?.takes || !state.template?.actions) return true;
    const candidate = normalizeTemplate(state.template);
    let harvestedAny = false;
    for (const take of state.ledger.takes) {
      const cleanPid = typeof take.point_id === 'string' ? take.point_id : '';
      if (take.template_id !== candidate.template_id || !isValidAsciiId(cleanPid, 31)) continue;
      const action = candidate.actions.find(a => a.action_id === take.action_id);
      if (action && !action.points.some(p => p.point_id.toUpperCase() === cleanPid.toUpperCase())) {
        action.points.push({ point_id: cleanPid, name: `${cleanPid} (现场补录)`, orphan: true });
        harvestedAny = true;
      }
    }
    if (harvestedAny) {
      try {
        storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(candidate));
      } catch (error) {
        state.templateSaveError = true;
        setBanner('历史点位未保存，请腾出手机存储空间后更新记录', {
          tone: 'error', code: 'template_not_saved', detail: error?.message || '',
        });
        return false;
      }
      state.template = candidate;
      state.templateVersion += 1;
    }
    return true;
  }

  function refreshLocalLedger(projectId = state.status.project_id) {
    if (state.ledger.project_id !== projectId) {
      state.ledgerReadError = null;
      state.ledgerSyncError = null;
      state.lastBackupPayload = null;
      state.editingReassignTakeId = null;
      state.reassignDrafts.clear();
      takeItemCache.clear();
    }
    if (!projectId) {
      state.ledger = { project_id: '', after_seq: 0, events: [], takes: [], validCounts: new Map() };
      state.ledgerReadError = null;
      return state.ledger;
    }
    try {
      state.ledger = loadProjectLedger(storage, projectId);
      state.ledgerReadError = null;
      harvestOrphanPointsFromLedger();
    } catch (error) {
      // Never leave another project's rows/controls visible after a failed read.
      // Keep the broken bytes in storage so explicit repair can recover the ledger.
      state.ledger = { project_id: projectId, after_seq: 0, events: [], takes: [], validCounts: new Map() };
      state.ledgerReadError = {
        project_id: projectId, code: error?.code || error?.name || 'ledger_read_failed',
        message: error?.message || '',
      };
      state.lastBackupPayload = null;
      state.editingReassignTakeId = null;
      state.reassignDrafts.clear();
      takeItemCache.clear();
      handleError('读取拍摄记录', error);
    }
    return state.ledger;
  }

  function localLedgerIncomplete() {
    return Boolean(state.ledgerSyncError || state.syncingLog ||
      state.status.event_seq > state.ledger.after_seq);
  }

  function renderLedgerStorageNotice() {
    const failure = currentLedgerFailure();
    const notice = el('ledger-storage-notice');
    const row = el('ledger-storage-details');
    if (row) row.hidden = !failure;
    if (notice) {
      notice.hidden = !failure;
      setTextIfChanged(notice, state.ledgerReadError ? '手机记录读取失败' : failure ? '手机记录未同步' : '');
    }
    const syncState = state.ledgerReadError ? 'unreadable' : failure ? 'failed' : localLedgerIncomplete() ? 'pending' : 'clean';
    el('nav-btn-records').dataset.syncState = syncState;
    const hint = state.syncingLog ? '更新中' : syncState === 'pending' ? '待更新' : '';
    setTextIfChanged(el('records-sync-hint'), hint);
    setTextIfChanged(el('records-sync-status'), hint);
    renderFeedbackVisibility();
  }

  function applyStatusSnapshot(snapshot) {
    if (destroyed || !snapshot || typeof snapshot !== 'object') return;
    statusVersion += 1;
    state.lastStatusReceivedAt = now();
    const prevPhase = state.status.phase;
    const prevProjectId = state.status.project_id;
    const prevBootId = state.status.boot_id;
    if (typeof snapshot.project_id === 'string') state.status.project_id = snapshot.project_id;
    if (typeof snapshot.template_id === 'string') state.status.template_id = snapshot.template_id;
    else if (prevProjectId !== state.status.project_id) state.status.template_id = '';
    const hasValidTarget = isValidTargetCameras(snapshot.target_cameras);
    const hasValidActive = isValidActiveParticipants(snapshot.active_participants);
    state.status.selectionSupported = Boolean(hasValidTarget && hasValidActive);
    // Do NOT overwrite confirmed action or target_cameras from status if a SELECT_ACTION request is mid-flight
    if (!state.pendingSelect) {
      if (typeof snapshot.action_id === 'string') state.status.action_id = snapshot.action_id;
      if (typeof snapshot.point_id === 'string') state.status.point_id = snapshot.point_id;
      state.status.target_cameras = hasValidTarget ? snapshot.target_cameras : null;
    } else if (!hasValidTarget) {
      state.status.target_cameras = null;
    }
    state.status.active_participants = hasValidActive ? snapshot.active_participants : null;
    if (Number.isSafeInteger(snapshot.event_seq)) state.status.event_seq = snapshot.event_seq;
    if (Number.isSafeInteger(snapshot.take_id)) state.status.take_id = snapshot.take_id;
    if (Number.isSafeInteger(snapshot.active_take_id)) state.status.active_take_id = snapshot.active_take_id;
    if (typeof snapshot.phase === 'string') state.status.phase = snapshot.phase;
    if (typeof snapshot.boot_id === 'string') state.status.boot_id = snapshot.boot_id;
    if (Number.isFinite(snapshot.mono_ms)) state.status.mono_ms = snapshot.mono_ms;
    if (typeof snapshot.time_synced === 'boolean') state.status.time_synced = snapshot.time_synced;
    if (typeof snapshot.writable === 'boolean') state.status.writable = snapshot.writable;
    if (typeof snapshot.storage_error === 'string') state.status.storage_error = snapshot.storage_error;
    if (snapshot.free_bytes !== undefined) state.status.free_bytes = snapshot.free_bytes;
    if (Array.isArray(snapshot.cameras) && snapshot.cameras.length >= 2) {
      state.status.cameras = [
        { ...state.status.cameras[0], ...snapshot.cameras[0] },
        { ...state.status.cameras[1], ...snapshot.cameras[1] },
      ];
    }
    if (prevProjectId !== state.status.project_id || prevBootId !== state.status.boot_id) {
      projectVersion += 1;
      hardwareClockAnchor = null;
    }
    if (state.status.boot_id && Number.isFinite(snapshot.mono_ms)) {
      hardwareClockAnchor = { bootId: state.status.boot_id, monoMs: snapshot.mono_ms, receivedAt: monotonicNow() };
    }
    if (state.status.phase === 'idle' && !pendingStart) {
      state.pendingStartCommandId = null;
    }
    if (state.status.phase === 'recording' && !pendingStop && !pendingStart?.cancelRequested) {
      void acquireWakeLock();
    } else if (state.status.phase === 'idle') {
      void releaseWakeLock();
    }
    if (prevPhase !== 'recording' && state.status.phase === 'recording' && state.status.project_id) {
      void syncCurrentProject(state.status.project_id, { silent: true });
    }
    if ((prevPhase === 'recording' || prevPhase === 'stopping' || prevPhase === 'closing') && state.status.phase === 'idle' && state.status.project_id) {
      void syncCurrentProject(state.status.project_id, { silent: true });
    }
    if (prevProjectId !== state.status.project_id) {
      state.editingReassignTakeId = null;
      state.reassignDrafts.clear();
    }
    if (prevProjectId !== state.status.project_id || state.ledger.project_id !== state.status.project_id) {
      refreshLocalLedger(state.status.project_id);
    }
    render();
  }

  // Attach callbacks to client while preserving any existing handlers
  const prevOnStatus = client.onStatus;
  client.onStatus = async status => {
    const connection = connectionVersion;
    const project = projectVersion;
    if (typeof prevOnStatus === 'function') await prevOnStatus(status);
    if (destroyed || !state.connected || connection !== connectionVersion || project !== projectVersion) return;
    applyStatusSnapshot(status);
  };

  const prevOnConnection = client.onConnection;
  client.onConnection = async info => {
    if (typeof prevOnConnection === 'function') await prevOnConnection(info);
    connectionVersion += 1;
    state.connected = Boolean(info?.connected);
    state.connecting = false;
    if (!info?.connected) {
      void releaseWakeLock();
      hardwareClockAnchor = null;
      state.syncingLog = false;
      state.pendingSelect = null;
      if (info?.error && info.error.code && info.error.code !== 'disconnected') {
        handleError('连接中断', info.error);
      } else {
        setBanner('连接已断开，请重新连接遥控器', { tone: 'warn', code: 'disconnected' });
      }
    }
    render();
  };

  const prevOnError = client.onError;
  client.onError = error => {
    if (typeof prevOnError === 'function') prevOnError(error);
    handleError('通信异常', error);
  };

  // === Targeted DOM Rendering Helpers (Safe DOM APIs, Zero Untrusted innerHTML) ===

  function isReceiptStale() {
    if (!state.connected || state.lastStatusReceivedAt <= 0) return false;
    return (now() - state.lastStatusReceivedAt) > staleMs;
  }

  function renderCameraCard(prefix, cam, receiptStale) {
    const camLetter = prefix === 'cam-a' ? 'A' : 'B';
    const slotBit = prefix === 'cam-a' ? 1 : 2;
    const cardEl = el(`card-${prefix}`);
    const titleWrapEl = el(`${prefix}-title-wrap`);
    const badgeEl = el(`${prefix}-badge`);
    const badgeTextEl = el(`${prefix}-badge-text`);
    const metricsEl = el(`${prefix}-metrics`);
    const detailsEl = el(`${prefix}-details`);
    const freshEl = el(`${prefix}-fresh`);
    const recTimeEl = el(`${prefix}-record-time`);
    const batEl = el(`${prefix}-battery`);
    const modeEl = el(`${prefix}-mode`);
    const ledEl = el(`${prefix}-led`);

    const isTakeActive = (state.status.phase && state.status.phase !== 'idle') || Boolean(pendingStart);
    const activeOrTargetMask = isTakeActive
      ? (isValidTargetCameras(state.status.active_participants) ? state.status.active_participants : state.status.target_cameras)
      : state.status.target_cameras;
    const isSelectedForTake = !isValidTargetCameras(activeOrTargetMask) ? true : Boolean(activeOrTargetMask & slotBit);

    const connected = Boolean(state.connected && cam?.connected);
    const stale = Boolean(state.connected && (receiptStale || (cam?.connected && cam?.fresh === false)));
    const recording = connected && !stale && Boolean(cam?.recording);
    const cachedRecording = connected && stale && Boolean(cam?.recording);
    const showConnectedDetails = connected || stale;

    if (cardEl) {
      cardEl.classList.toggle('is-disconnected', !showConnectedDetails);
      cardEl.classList.toggle('is-stale', stale);
      cardEl.classList.toggle('is-recording', recording || cachedRecording);
      cardEl.classList.toggle('is-unselected', Boolean(state.connected && !isSelectedForTake && !recording && !cachedRecording));
      cardEl.dataset.selected = isSelectedForTake ? 'true' : 'false';
    }
    if (titleWrapEl) titleWrapEl.hidden = false;
    if (metricsEl) metricsEl.hidden = false;
    if (detailsEl) {
      detailsEl.hidden = !showConnectedDetails;
      if (!showConnectedDetails) detailsEl.open = false;
    }

    if (badgeEl) {
      const targetTextEl = badgeTextEl || badgeEl;
      if (recording) {
        setTextIfChanged(targetTextEl, '正在录像');
        badgeEl.dataset.state = 'recording';
      } else if (!showConnectedDetails) {
        setTextIfChanged(
          targetTextEl,
          state.connected && !isSelectedForTake ? `${camLetter}机未连接（本段不用）` : `${camLetter}机未连接`
        );
        badgeEl.dataset.state = 'disconnected';
      } else if (stale) {
        setTextIfChanged(targetTextEl, cachedRecording ? '上次状态：录像中（待确认）' : isSelectedForTake ? '暂时无法确认' : '状态未更新（本段不用）');
        badgeEl.dataset.state = 'stale';
      } else if (cam?.ready && !cam?.sleeping && cam?.video !== false) {
        setTextIfChanged(targetTextEl, isSelectedForTake ? '可以拍摄' : '本段不用');
        badgeEl.dataset.state = 'ready';
      } else {
        setTextIfChanged(targetTextEl, isSelectedForTake ? '暂时无法确认' : '本段不用');
        badgeEl.dataset.state = 'warn';
      }
    }

    if (freshEl) {
      if (!state.connected) {
        setTextIfChanged(freshEl, '未连接');
      } else if (stale) {
        const ageMs = state.lastStatusReceivedAt > 0 ? Math.max(0, now() - state.lastStatusReceivedAt) : 0;
        setTextIfChanged(freshEl, ageMs > 0 ? `已超过 ${ageMs} 毫秒未更新` : '状态未更新');
      } else if (!connected) {
        setTextIfChanged(freshEl, '未连接');
      } else {
        const age = Number.isFinite(cam?.status_age_ms) ? `${cam.status_age_ms} 毫秒前` : '刚刚';
        setTextIfChanged(freshEl, age);
      }
    }

    setTextIfChanged(recTimeEl, String(cam?.record_time ?? 0));
    setTextIfChanged(
      batEl,
      !showConnectedDetails
        ? '电量未知'
        : (connected && Number.isFinite(cam?.battery) ? `${cam.battery}%` : '暂时无法确认')
    );

    if (modeEl) {
      setTextIfChanged(modeEl,
        !showConnectedDetails ? '未连接' :
        recording ? '正在录像' :
        stale ? '暂时无法确认' :
        !isSelectedForTake ? '本段不用' :
        cam?.sleeping ? '休眠中' :
        cam?.video === false ? '请切到录像模式' :
        cam?.ready ? '可以拍摄' : '暂时无法确认');
    }

    if (ledEl) {
      const ledCode = Number.isInteger(cam?.led) ? cam.led : 0;
      setTextIfChanged(ledEl, describeLed(ledCode));
      ledEl.dataset.state = ledCode === 2 ? 'recording' : ledCode === 1 ? 'ready' : ledCode === 3 ? 'warn' : 'disconnected';
    }
  }

  function renderRecordStatusHeader(receiptStale) {
    const phase = state.status.phase || 'idle';
    const phaseBadge = el('phase-badge');
    const btnRecordMain = el('btn-record-main');
    const btnRecordIcon = el('btn-record-icon');
    const btnRecordLabel = el('btn-record-label');
    const obsTextEl = el('record-observation-text');
    const activeTakeBadge = el('active-take-badge');

    const cams = Array.isArray(state.status.cameras) ? state.status.cameras : [];
    const hasFreshStatus = state.connected && state.lastStatusReceivedAt > 0 && !receiptStale;
    const selectionSupported = state.status.selectionSupported !== false;
    const targetCameras = state.status.target_cameras;
    const effectiveTarget = isValidTargetCameras(targetCameras) ? targetCameras : 3;
    const admission = computeCameraAdmission(cams, effectiveTarget);
    const anyCamRecording = hasFreshStatus && cams.some(c => c?.connected && c?.fresh !== false && c?.recording === true);
    const anyConnectedRecording = admission.anyConnectedRecording;
    const isTakeActive = phase !== 'idle' || Boolean(pendingStart) || (state.status.active_take_id > 0);
    const activeMask = isTakeActive
      ? (isValidTargetCameras(state.status.active_participants) ? state.status.active_participants : effectiveTarget)
      : effectiveTarget;
    const anySelectedStale = !hasFreshStatus || admission.selectedStale;
    const selectedReady = hasFreshStatus && selectionSupported && isValidTargetCameras(targetCameras) && admission.targetReady;
    const desiredMode = (phase === 'idle' && !pendingStart && !(state.status.active_take_id > 0) && !anyConnectedRecording)
      ? 'start'
      : 'stop';

    const targetTrack = el('target-camera-strip');
    const confirmedTarget = selectionSupported && isValidTargetCameras(targetCameras);
    targetTrack?.classList.toggle('has-confirmed-target', confirmedTarget);
    if (confirmedTarget) targetTrack?.style.setProperty('--target-index', String({ 3: 0, 1: 1, 2: 2 }[targetCameras]));
    else targetTrack?.style.removeProperty('--target-index');

    // 3-way target camera buttons
    const targetBtns = [
      { id: 'btn-target-both', value: 3 },
      { id: 'btn-target-a', value: 1 },
      { id: 'btn-target-b', value: 2 },
    ];
    for (const item of targetBtns) {
      const btn = el(item.id);
      if (!btn) continue;
      const isConfirmed = selectionSupported && state.status.target_cameras === item.value;
      const isPending = Boolean(state.pendingSelect && state.pendingSelect.target_cameras === item.value);
      btn.classList.toggle('is-active', isConfirmed);
      btn.classList.toggle('is-pending', isPending);
      btn.setAttribute('aria-pressed', isConfirmed ? 'true' : 'false');
      btn.disabled = !state.connected || !selectionSupported || !templateMatchesDevice() || Boolean(state.pendingSelect || pendingStart || phase !== 'idle');
    }

    if (phaseBadge) {
      if (phase === 'stopping' || phase === 'closing' || pendingStart?.cancelRequested) {
        setTextIfChanged(phaseBadge, '状态：正在停止');
        phaseBadge.dataset.state = 'warn';
      } else if (anyCamRecording && isTakeActive) {
        setTextIfChanged(phaseBadge, '状态：正在录像');
        phaseBadge.dataset.state = 'recording';
      } else if (phase !== 'idle' || pendingStart) {
        setTextIfChanged(phaseBadge, '状态：等待相机状态');
        phaseBadge.dataset.state = 'warn';
      } else if (!state.connected) {
        setTextIfChanged(phaseBadge, '状态：未连接');
        phaseBadge.dataset.state = 'disconnected';
      } else if (!selectionSupported) {
        setTextIfChanged(phaseBadge, '状态：需升级固件');
        phaseBadge.dataset.state = 'warn';
      } else if (anyConnectedRecording) {
        setTextIfChanged(phaseBadge, '状态：相机录像中');
        phaseBadge.dataset.state = 'recording';
      } else if (anySelectedStale) {
        setTextIfChanged(phaseBadge, '状态：等待相机状态');
        phaseBadge.dataset.state = 'stale';
      } else if (selectedReady) {
        setTextIfChanged(phaseBadge, '状态：待机');
        phaseBadge.dataset.state = 'ready';
      } else {
        setTextIfChanged(phaseBadge, '状态：请检查相机');
        phaseBadge.dataset.state = 'warn';
      }
    }

    if (activeTakeBadge) {
      const activeId = state.status.active_take_id || (phase !== 'idle' ? state.status.take_id : 0);
      activeTakeBadge.hidden = activeId <= 0;
      setTextIfChanged(activeTakeBadge, activeId > 0 ? `第 ${activeId} 段` : '');
    }

    if (btnRecordMain) {
      btnRecordMain.disabled = !state.connected ||
        Boolean(pendingStop || pendingStart?.cancelRequested) ||
        (desiredMode === 'start' && (
          !selectionSupported ||
          !templateMatchesDevice() ||
          !state.status.project_id ||
          !state.status.action_id ||
          Boolean(state.pendingSelect) ||
          !selectedReady
        ));
      if (btnRecordMain.dataset.mode !== desiredMode || !btnRecordLabel) {
        btnRecordMain.dataset.mode = desiredMode;
        btnRecordMain.className = desiredMode === 'start'
          ? 'btn btn-ready record-cta-btn'
          : 'btn btn-danger record-cta-btn';
        if (btnRecordIcon && btnRecordLabel) {
          btnRecordIcon.innerHTML = desiredMode === 'start' ? ICONS.record : ICONS.stop;
          setTextIfChanged(btnRecordLabel, desiredMode === 'start' ? '开始录像' : '停止录像');
        } else {
          btnRecordMain.innerHTML = `<span id="btn-record-icon">${desiredMode === 'start' ? ICONS.record : ICONS.stop}</span><span id="btn-record-label">${desiredMode === 'start' ? '开始录像' : '停止录像'}</span>`;
        }
      }
    }

    if (obsTextEl) {
      if (!state.connected) {
        setTextIfChanged(obsTextEl, '请先连接遥控器');
      } else if (phase === 'stopping' || phase === 'closing' || pendingStart?.cancelRequested) {
        setTextIfChanged(obsTextEl, '正在停止录像，请稍候…');
      } else if (anyCamRecording && isTakeActive) {
        const camARec = Boolean(cams[0]?.connected && cams[0]?.fresh !== false && cams[0]?.recording);
        const camBRec = Boolean(cams[1]?.connected && cams[1]?.fresh !== false && cams[1]?.recording);
        if (activeMask === 1) {
          setTextIfChanged(obsTextEl, camARec ? '正在录像（只拍 A 机，A机录像中）' : '正在等待 A 机开始录像…');
        } else if (activeMask === 2) {
          setTextIfChanged(obsTextEl, camBRec ? '正在录像（只拍 B 机，B机录像中）' : '正在等待 B 机开始录像…');
        } else if (camARec && camBRec) {
          setTextIfChanged(obsTextEl, '正在录像（A机、B机录像中）');
        } else {
          setTextIfChanged(obsTextEl, `正在录像（${camARec ? 'A机录像中，B机等待确认' : 'B机录像中，A机等待确认'}）`);
        }
      } else if (phase !== 'idle' || state.pendingStartCommandId) {
        const targetLabel = activeMask === 1 ? ' A 机' : activeMask === 2 ? ' B 机' : '相机';
        setTextIfChanged(obsTextEl, anySelectedStale ? '等待相机状态' : `正在等待${targetLabel}开始录像…`);
      } else if (!selectionSupported) {
        setTextIfChanged(obsTextEl, '当前遥控器固件暂不支持相机选择，请先升级固件');
      } else if (anyConnectedRecording) {
        setTextIfChanged(obsTextEl, '检测到相机正在录像，请先停止后再开始新一段');
      } else if (anySelectedStale) {
        setTextIfChanged(obsTextEl, '等待相机状态');
      } else if (!state.status.project_id) {
        setTextIfChanged(obsTextEl, '请先新建拍摄项目');
      } else if (!state.status.action_id) {
        setTextIfChanged(obsTextEl, '请先选择当前拍摄内容');
      } else if (state.pendingSelect) {
        setTextIfChanged(obsTextEl, '正在保存动作与相机设置，请稍候…');
      } else if (!selectedReady) {
        const aReady = Boolean(admission.readyMask & 1);
        const bReady = Boolean(admission.readyMask & 2);
        if (effectiveTarget === 3 && !aReady && bReady) {
          setTextIfChanged(obsTextEl, 'A 机未就绪，请检查 A 机或改选“只拍 B 机”');
        } else if (effectiveTarget === 3 && aReady && !bReady) {
          setTextIfChanged(obsTextEl, 'B 机未就绪，请检查 B 机或改选“只拍 A 机”');
        } else if (effectiveTarget === 1) {
          setTextIfChanged(obsTextEl, 'A 机未就绪，请检查 A 机连接与模式');
        } else if (effectiveTarget === 2) {
          setTextIfChanged(obsTextEl, 'B 机未就绪，请检查 B 机连接与模式');
        } else {
          setTextIfChanged(obsTextEl, '请检查相机');
        }
      } else if (!templateMatchesDevice()) {
        setTextIfChanged(obsTextEl, `相机已就绪（${describeTargetCameras(effectiveTarget)}），暂不能开始录像`);
      } else {
        setTextIfChanged(obsTextEl, `已就绪（${describeTargetCameras(effectiveTarget)}），可以开始录像`);
      }
    }

    if (obsTextEl && !templateMatchesDevice()) {
      setTextIfChanged(obsTextEl, `${obsTextEl.textContent} · ${templateMismatchMessage()}`);
    }

    const globalStrip = el('global-record-strip');
    const globalRecordText = el('global-record-text');
    const btnGlobalStop = el('btn-global-stop');
    if (globalStrip) {
      const isStripVisible = (state.activeView === 'list' || state.activeView === 'records') && desiredMode === 'stop';
      globalStrip.hidden = !isStripVisible;
      if (isStripVisible) {
        if (globalRecordText && obsTextEl) {
          setTextIfChanged(globalRecordText, obsTextEl.textContent);
        }
        if (btnGlobalStop) {
          btnGlobalStop.disabled = !state.connected || Boolean(pendingStop || pendingStart?.cancelRequested);
        }
      }
    }

    const targetAlertBar = el('target-alert-bar');
    if (targetAlertBar) {
      const alerts = [];
      if (state.connected && isValidTargetCameras(targetCameras)) {
        const mask = isTakeActive ? activeMask : targetCameras;
        const mode = mask === 3 ? '双机模式下 ' : mask === 1 ? '只拍 A 机模式下 ' : '只拍 B 机模式下 ';
        for (let i = 0; i < 2; i++) {
          if (!(mask & (1 << i))) continue;
          const cam = cams[i];
          const name = i === 0 ? 'A 机' : 'B 机';
          if (!cam?.connected) alerts.push(`${mode}${name} 未连接`);
          else if (!hasFreshStatus || cam.fresh === false) alerts.push(`${name}状态待确认，请等待更新`);
          else if (cam.sleeping || cam.video === false) alerts.push(`${name}未处于可录像模式`);
          else if (cam.recording === true) { /* ready includes !recording in firmware. */ }
          else if (isTakeActive) {
            if (phase === 'recording') alerts.push(`${name}尚未观察到录像`);
          } else if (!cam.ready) alerts.push(`${mode}${name} 未就绪`);
        }
      }
      targetAlertBar.hidden = alerts.length === 0;
      setTextIfChanged(targetAlertBar, alerts.join('；'));
    }
    renderRecordElapsed(receiptStale);
  }

  function renderRecordElapsed(receiptStale) {
    const take = state.ledger.project_id === state.status.project_id
      ? state.ledger.takes.find(t => t.take_id === state.status.active_take_id) : null;
    const mask = state.status.active_participants;
    const observedRecording = isValidTargetCameras(mask) && state.status.cameras.some((cam, i) =>
      (mask & (1 << i)) && cam?.connected && cam?.fresh !== false && cam?.recording === true);
    let text = '本段计时：待确认';
    const anchor = hardwareClockAnchor;
    if (state.connected && !receiptStale && observedRecording && state.status.phase === 'recording' &&
        take && !take.ended && take.boot_id && take.boot_id === state.status.boot_id &&
        anchor?.bootId === take.boot_id && Number.isFinite(take.begin_mono_ms) &&
        anchor.monoMs >= take.begin_mono_ms) {
      text = `本段计时：${formatElapsedMs(anchor.monoMs - take.begin_mono_ms +
        Math.max(0, monotonicNow() - anchor.receivedAt))}`;
    }
    setTextIfChanged(el('record-elapsed'), text);
  }

  // Targeted tick update for staleness timer — never touches action/filter/take interactive lists
  function renderStalenessTick() {
    const receiptStale = isReceiptStale();
    renderCameraCard('cam-a', state.status.cameras?.[0], receiptStale);
    renderCameraCard('cam-b', state.status.cameras?.[1], receiptStale);
    renderRecordStatusHeader(receiptStale);
  }

  function getFilteredActions() {
    return filterActions(state.template.actions, {
      query: state.searchQuery,
      group: state.groupFilter,
      typeFilter: state.typeFilter,
      statusFilter: state.statusFilter,
      validCounts: state.ledger.validCounts,
    });
  }

  function getOrCreateActionRow(item) {
    let entry = actionRowCache.get(item.action_id);
    if (!entry) {
      const rowBtn = doc.createElement('button');
      rowBtn.type = 'button';
      rowBtn.className = 'action-row-btn';
      rowBtn.dataset.actionId = item.action_id;

      const leftSpan = doc.createElement('span');
      leftSpan.className = 'action-row-left';

      const idSpan = doc.createElement('span');
      idSpan.className = 'action-row-id';

      const infoSpan = doc.createElement('span');
      infoSpan.className = 'action-row-info';

      const titleSpan = doc.createElement('span');
      titleSpan.className = 'action-row-title';

      const metaSpan = doc.createElement('span');
      metaSpan.className = 'action-row-meta';

      infoSpan.appendChild(titleSpan);
      infoSpan.appendChild(metaSpan);
      leftSpan.appendChild(idSpan);
      leftSpan.appendChild(infoSpan);

      const rightSpan = doc.createElement('span');
      rightSpan.className = 'action-row-right';

      const pendingBadge = doc.createElement('span');
      pendingBadge.className = 'badge';
      pendingBadge.dataset.state = 'warn';
      pendingBadge.textContent = '切换中...';
      pendingBadge.hidden = true;

      const countBadge = doc.createElement('span');
      countBadge.className = 'badge';

      rightSpan.appendChild(pendingBadge);
      rightSpan.appendChild(countBadge);

      rowBtn.appendChild(leftSpan);
      rowBtn.appendChild(rightSpan);

      rowBtn.addEventListener('click', () => {
        const currentActionId = rowBtn.dataset.actionId || '';
        const isConfirmed = state.status.action_id === currentActionId;
        const defaultPoint = isConfirmed ? (state.status.point_id || '') : '';
        void selectAction(currentActionId, defaultPoint);
      });

      entry = { rowBtn, idSpan, titleSpan, metaSpan, pendingBadge, countBadge };
      actionRowCache.set(item.action_id, entry);
    }
    return entry;
  }

  function syncReassignSelectOptions(entry, take) {
    entry.actionSelect.disabled = !templateMatchesDevice();
    entry.pointSelect.disabled = !templateMatchesDevice();
    entry.confirmBtn.disabled = !templateMatchesDevice();
    if (!templateMatchesDevice()) return;
    const takeId = take.take_id;
    let draft = state.reassignDrafts.get(takeId);
    if (!draft) {
      draft = {
        action_id: take.action_id || state.template.actions[0]?.action_id || '',
        point_id: take.point_id ?? '',
      };
      state.reassignDrafts.set(takeId, draft);
    }

    if (entry.populatedTemplateVersion !== state.templateVersion) {
      entry.actionSelect.replaceChildren();
      for (const act of state.template.actions) {
        const opt = doc.createElement('option');
        opt.value = act.action_id;
        opt.textContent = `${act.action_id} — ${act.name}`;
        entry.actionSelect.appendChild(opt);
      }
      entry.populatedTemplateVersion = state.templateVersion;
      entry.populatedActionId = null;
    }

    if (draft.action_id && Array.from(entry.actionSelect.options).some(o => o.value === draft.action_id)) {
      if (entry.actionSelect.value !== draft.action_id) {
        entry.actionSelect.value = draft.action_id;
      }
    } else if (draft.action_id) {
      const orphanActOpt = doc.createElement('option');
      orphanActOpt.value = draft.action_id;
      orphanActOpt.textContent = `${draft.action_id} — (现场保留动作·未命名)`;
      entry.actionSelect.appendChild(orphanActOpt);
      entry.actionSelect.value = draft.action_id;
    } else if (entry.actionSelect.options.length > 0) {
      draft.action_id = entry.actionSelect.options[0].value;
      entry.actionSelect.value = draft.action_id;
    }

    if (entry.populatedActionId !== draft.action_id) {
      entry.pointSelect.replaceChildren();
      const noneOpt = doc.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '不指定拍摄位置';
      entry.pointSelect.appendChild(noneOpt);
      const targetAct = state.template.actions.find(a => a.action_id === draft.action_id);
      for (const pt of targetAct?.points || []) {
        const opt = doc.createElement('option');
        opt.value = pt.point_id;
        opt.textContent = `${pt.point_id} — ${pt.name}`;
        entry.pointSelect.appendChild(opt);
      }
      entry.populatedActionId = draft.action_id;
    }

    if (Array.from(entry.pointSelect.options).some(o => o.value === (draft.point_id ?? ''))) {
      if (entry.pointSelect.value !== (draft.point_id ?? '')) {
        entry.pointSelect.value = draft.point_id ?? '';
      }
    } else if (draft.point_id) {
      const orphanOpt = doc.createElement('option');
      orphanOpt.value = draft.point_id;
      orphanOpt.textContent = `${draft.point_id} — (现场保留点位·未命名)`;
      entry.pointSelect.appendChild(orphanOpt);
      entry.pointSelect.value = draft.point_id;
    } else {
      draft.point_id = '';
      entry.pointSelect.value = '';
    }
  }

  function getOrCreateTakeItem(take) {
    const takeId = take.take_id;
    const takeProjectId = state.ledger.project_id;
    let entry = takeItemCache.get(takeId);
    if (!entry) {
      const itemEl = doc.createElement('div');
      itemEl.className = 'take-item';
      itemEl.dataset.takeId = String(takeId);

      const headerDiv = doc.createElement('div');
      headerDiv.className = 'take-item-header';

      const headerLeft = doc.createElement('div');
      const idSpan = doc.createElement('span');
      idSpan.className = 'take-id-label';
      const attrSpan = doc.createElement('span');
      attrSpan.style.fontWeight = '600';
      attrSpan.style.marginLeft = '8px';
      headerLeft.appendChild(idSpan);
      headerLeft.appendChild(attrSpan);

      const headerRight = doc.createElement('div');
      headerRight.style.display = 'flex';
      headerRight.style.gap = '6px';
      headerRight.style.flexWrap = 'wrap';
      const participantsBadge = doc.createElement('span');
      participantsBadge.className = 'badge';
      const discardBadge = doc.createElement('span');
      discardBadge.className = 'badge';
      const endBadge = doc.createElement('span');
      endBadge.className = 'badge';
      const durationSpan = doc.createElement('span');
      durationSpan.className = 'take-duration';
      headerRight.appendChild(participantsBadge);
      headerRight.appendChild(discardBadge);
      headerRight.appendChild(endBadge);
      headerRight.appendChild(durationSpan);

      headerDiv.appendChild(headerLeft);
      headerDiv.appendChild(headerRight);

      const camSummaryDiv = doc.createElement('div');
      camSummaryDiv.className = 'take-cam-summary';
      const camASpan = doc.createElement('span');
      const camBSpan = doc.createElement('span');
      camSummaryDiv.appendChild(camASpan);
      camSummaryDiv.appendChild(camBSpan);

      const btnRow = doc.createElement('div');
      btnRow.className = 'button-row';

      const btnDiscard = doc.createElement('button');
      btnDiscard.type = 'button';
      btnDiscard.className = 'btn';
      btnDiscard.dataset.action = 'toggle-discard';
      btnDiscard.dataset.takeId = String(takeId);
      const btnDiscardLabel = doc.createElement('span');
      btnDiscard.appendChild(btnDiscardLabel);

      const btnReassign = doc.createElement('button');
      btnReassign.type = 'button';
      btnReassign.className = 'btn';
      btnReassign.dataset.action = 'open-reassign';
      btnReassign.dataset.takeId = String(takeId);
      const btnReassignLabel = doc.createElement('span');
      btnReassignLabel.textContent = '改归属';
      btnReassign.appendChild(btnReassignLabel);

      btnRow.appendChild(btnDiscard);
      btnRow.appendChild(btnReassign);

      // Persistent inline reassign panel (hidden until opened)
      const panel = doc.createElement('div');
      panel.className = 'reassign-panel';
      panel.dataset.reassignPanel = String(takeId);
      panel.hidden = true;

      const actionSelect = doc.createElement('select');
      actionSelect.className = 'select-field';
      actionSelect.setAttribute('aria-label', '选择拍摄内容');
      actionSelect.dataset.reassignActionSelect = String(takeId);

      const pointSelect = doc.createElement('select');
      pointSelect.className = 'select-field';
      pointSelect.setAttribute('aria-label', '选择拍摄位置');
      pointSelect.dataset.reassignPointSelect = String(takeId);

      const panelBtns = doc.createElement('div');
      panelBtns.className = 'button-row';

      const confirmBtn = doc.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn btn-primary';
      confirmBtn.dataset.reassignConfirm = String(takeId);
      confirmBtn.textContent = '保存修改';

      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.textContent = '取消';

      panelBtns.appendChild(confirmBtn);
      panelBtns.appendChild(cancelBtn);
      panel.appendChild(actionSelect);
      panel.appendChild(pointSelect);
      panel.appendChild(panelBtns);

      itemEl.appendChild(headerDiv);
      itemEl.appendChild(camSummaryDiv);
      itemEl.appendChild(btnRow);
      itemEl.appendChild(panel);

      entry = {
        itemEl,
        idSpan,
        attrSpan,
        participantsBadge,
        discardBadge,
        endBadge,
        durationSpan,
        camASpan,
        camBSpan,
        btnDiscard,
        btnDiscardLabel,
        btnReassign,
        btnReassignLabel,
        panel,
        actionSelect,
        pointSelect,
        confirmBtn,
        cancelBtn,
        populatedTemplateVersion: 0,
        populatedActionId: null,
      };

      btnDiscard.addEventListener('click', () => {
        if (!state.connected || state.ledgerReadError || takeProjectId !== state.status.project_id) return;
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId);
        const currentDiscarded = Boolean(currentTake?.discarded);
        void markDiscard(takeId, !currentDiscarded, takeProjectId);
      });

      btnReassign.addEventListener('click', () => {
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId);
        if (!state.connected || !currentTake?.ended || takeProjectId !== state.status.project_id || state.ledgerReadError) return;
        if (state.editingReassignTakeId === takeId) {
          state.editingReassignTakeId = null;
          state.reassignDrafts.delete(takeId);
        } else {
          openTakeReassign(takeId, takeProjectId);
          return;
        }
        render();
      });

      actionSelect.addEventListener('change', () => {
        if (!templateMatchesDevice() || takeProjectId !== state.status.project_id || state.ledgerReadError) return;
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId) || take;
        const nextActionId = actionSelect.value;
        state.reassignDrafts.set(takeId, {
          action_id: nextActionId,
          point_id: '',
        });
        syncReassignSelectOptions(entry, currentTake);
      });

      pointSelect.addEventListener('change', () => {
        if (!templateMatchesDevice() || takeProjectId !== state.status.project_id || state.ledgerReadError) return;
        const draft = state.reassignDrafts.get(takeId) || {
          action_id: actionSelect.value,
          point_id: '',
        };
        draft.point_id = pointSelect.value;
        state.reassignDrafts.set(takeId, draft);
      });

      confirmBtn.addEventListener('click', () => {
        const draft = state.reassignDrafts.get(takeId);
        const targetAction = actionSelect.value || draft?.action_id || '';
        const targetPoint = pointSelect.value ?? draft?.point_id ?? '';
        void reassignTake(takeId, targetAction, targetPoint, takeProjectId);
      });

      cancelBtn.addEventListener('click', () => {
        if (takeProjectId !== state.status.project_id) return;
        state.editingReassignTakeId = null;
        state.reassignDrafts.delete(takeId);
        render();
      });

      takeItemCache.set(takeId, entry);
    }
    return entry;
  }

  function render() {
    renderLedgerStorageNotice();
    closeStaleShootDetails();
    if (!templateMatchesDevice()) state.editingReassignTakeId = null;
    el('btn-trigger-add-point').disabled = !state.connected || !templateMatchesDevice();
    el('btn-rename-point').disabled = !state.connected || !templateMatchesDevice();
    const receiptStale = isReceiptStale();
    const desktopMode = isDesktopLayout();
    state.desktopMode = desktopMode;

    // View panels & bottom navigation
    for (const viewKey of ['shoot', 'list', 'records']) {
      const panelEl = el(`view-${viewKey}`);
      if (panelEl) {
        panelEl.hidden = desktopMode ? false : (state.activeView !== viewKey);
      }
      const navBtn = el(`nav-btn-${viewKey}`);
      if (navBtn) {
        const isActive = state.activeView === viewKey;
        navBtn.classList.toggle('is-active', isActive);
        navBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      }
    }
    const bottomNavEl = el('bottom-view-nav');
    if (bottomNavEl) {
      bottomNavEl.hidden = desktopMode;
    }

    updateShootOverflowMode();

    // Card 1: Connection & Project / Template
    const connBadge = el('conn-badge');
    const connBadgeText = el('conn-badge-text');
    if (connBadge && connBadgeText) {
      if (state.connecting) {
        connBadge.dataset.state = 'connecting';
        setTextIfChanged(connBadgeText, '连接中');
      } else if (state.connected) {
        connBadge.dataset.state = 'connected';
        setTextIfChanged(connBadgeText, '已连接');
      } else {
        connBadge.dataset.state = 'disconnected';
        setTextIfChanged(connBadgeText, '未连接');
      }
    }

    const topbarProjSummary = el('topbar-project-summary');
    if (topbarProjSummary) {
      if (!state.connected) {
        setTextIfChanged(topbarProjSummary, '请先连接遥控器');
      } else if (!state.status.project_id) {
        setTextIfChanged(topbarProjSummary, '尚未新建拍摄项目');
      } else {
        setTextIfChanged(topbarProjSummary, `项目 ${state.status.project_id}`);
      }
    }

    const templateSummary = templateMatchesDevice()
      ? `拍摄清单：${state.template.template_name} · ${state.template.template_id}`
      : templateMismatchMessage();
    setTextIfChanged(el('template-subtitle'), state.templateLoadError
      ? `${templateSummary} · 手机清单缓存不可用（${state.templateLoadError.code}：${state.templateLoadError.message}）`
      : templateSummary);
    setTextIfChanged(el('meta-project-id'), state.status.project_id || '尚未创建');
    setTextIfChanged(el('meta-template-id'), state.status.template_id || state.template.template_id);
    setTextIfChanged(el('meta-event-seq'), `${state.status.event_seq ?? 0} / ${state.ledger.after_seq ?? 0}`);
    setTextIfChanged(el('meta-take-id'), String(state.status.take_id ?? 0));
    setTextIfChanged(el('meta-free-bytes'), formatBytes(state.status.free_bytes));
    const mockNotice = el('mock-notice');
    if (mockNotice) mockNotice.hidden = !isMockMode;

    const metaTime = el('meta-time-sync');
    if (metaTime) {
      if (!state.connected) {
        setTextIfChanged(metaTime, '未连接');
      } else {
        const timeLabel = state.status.time_synced ? '时间已校准' : '时间未校准';
        const writeLabel = state.status.writable === false ? '暂时无法保存记录' : '可以保存记录';
        const errSuffix = state.status.storage_error ? ` (${state.status.storage_error})` : '';
        setTextIfChanged(metaTime, `${timeLabel} / ${writeLabel}${errSuffix}`);
      }
    }

    const btnConnectEl = el('btn-connect');
    if (btnConnectEl) {
      btnConnectEl.className = state.connected ? 'btn' : 'btn btn-primary';
    }
    setTextIfChanged(
      el('btn-connect-label'),
      state.connected ? '断开遥控器' : state.connecting ? '正在连接…' : '连接遥控器'
    );

    const syncDisabled = !state.connected || state.syncingLog || !state.status.project_id;
    const btnSync = el('btn-sync-log');
    if (btnSync) {
      btnSync.disabled = syncDisabled;
    }
    const btnRecordsSync = el('btn-records-sync');
    if (btnRecordsSync) {
      btnRecordsSync.disabled = syncDisabled;
    }

    // Empty project vs Non-empty project notice & on-demand setup card visibility
    const isProjectEmpty = state.status.project_id === '' && (state.status.take_id ?? 0) === 0 && state.status.phase === 'idle';
    const initBox = el('init-project-box');
    const usbNotice = el('usb-reset-notice');
    if (initBox) initBox.hidden = !state.connected || !isProjectEmpty;
    if (usbNotice) usbNotice.hidden = isProjectEmpty;

    const modalSettings = el('modal-settings');
    const btnToggleSettings = el('btn-toggle-settings');
    if (btnToggleSettings) {
      const isExpanded = Boolean(modalSettings?.open);
      btnToggleSettings.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      btnToggleSettings.classList.toggle('is-active', isExpanded);
      setTextIfChanged(el('btn-toggle-settings-label'), state.connected ? '设置' : '连接与设置');
    }

    // Card 2 & Card 3: Camera A & Camera B
    renderCameraCard('cam-a', state.status.cameras?.[0], receiptStale);
    renderCameraCard('cam-b', state.status.cameras?.[1], receiptStale);

    // Card 4: Current Confirmed Action & Stepper
    const confirmedAction = currentTemplateAction();
    setTextIfChanged(el('confirmed-action-id'), state.status.action_id || '未选择');

    const confirmedPointIdEl = el('confirmed-point-id');
    if (confirmedPointIdEl) {
      confirmedPointIdEl.hidden = !confirmedAction && !state.status.point_id;
      const ptObj = confirmedAction?.points?.find(p => p.point_id === state.status.point_id);
      setTextIfChanged(
        confirmedPointIdEl,
        state.status.point_id
          ? `${state.status.point_id} · ${ptObj && !ptObj.orphan ? ptObj.name : '未收录名称'}`
          : '未指定点位'
      );
    }

    if (confirmedPointIdEl) confirmedPointIdEl.setAttribute('aria-label', confirmedPointIdEl.textContent);
    el('btn-current-details').disabled = !state.status.action_id;
    setTextIfChanged(
      el('confirmed-action-name'),
      confirmedAction
        ? confirmedAction.name
        : (state.status.action_id ? '未收录名称' : '请从拍摄清单中选择一项')
    );

    const listSelectedSummary = el('list-selected-summary');
    if (listSelectedSummary) {
      if (!state.connected) {
        setTextIfChanged(listSelectedSummary, '未连接遥控器');
      } else if (state.status.phase === 'stopping' || state.status.phase === 'closing' || pendingStart?.cancelRequested) {
        setTextIfChanged(listSelectedSummary, '正在停止录像，暂时无法切换动作');
      } else if (state.status.phase !== 'idle' || state.pendingStartCommandId || (state.status.active_take_id > 0)) {
        setTextIfChanged(listSelectedSummary, '正在录像中，请先停止录像再切换动作');
      } else if (state.pendingSelect) {
        setTextIfChanged(listSelectedSummary, '正在保存动作设置，请稍候…');
      } else {
        setTextIfChanged(
          listSelectedSummary,
          confirmedAction
            ? `当前动作：${confirmedAction.action_id} ${confirmedAction.name}`
            : (state.status.action_id ? `当前动作：${state.status.action_id}` : '当前动作：未选择')
        );
      }
    }

    const renamePointButton = el('btn-rename-point');
    if (renamePointButton) {
      const point = confirmedAction?.points?.find(p => p.point_id === state.status.point_id);
      const orphanCount = confirmedAction?.points.filter(p => p.orphan).length || 0;
      renamePointButton.hidden = orphanCount === 0;
      setTextIfChanged(renamePointButton, point?.orphan ? `给 ${point.point_id} 补中文名` : `补名 ${orphanCount}`);
    }

    const pendingBadgeEl = el('action-pending-badge');
    if (pendingBadgeEl) {
      if (state.pendingSelect) {
        pendingBadgeEl.hidden = false;
        setTextIfChanged(pendingBadgeEl, '正在保存动作，请稍候');
      } else {
        pendingBadgeEl.hidden = true;
        setTextIfChanged(pendingBadgeEl, '正在保存动作，请稍候');
      }
    }

    // Point capsules for current confirmed action (keyed by point_id, updated in-place)
    const pointsContainer = el('points-container');
    const pointPillsEl = el('point-pills');
    if (pointsContainer && pointPillsEl) {
      if (!confirmedAction) {
        pointsContainer.hidden = true;
        if (pointPillCache.signature !== '') {
          pointPillsEl.replaceChildren();
          pointPillCache.nodesByPointId.clear();
          pointPillCache.signature = '';
        }
      } else {
        pointsContainer.hidden = false;
        const points = confirmedAction.points || [];
        const allPoints = [{ point_id: '', name: '未指定' }, ...points];
        const sig = `${confirmedAction.action_id}::${allPoints.map(p => `${p.point_id}=${p.name}=${Boolean(p.orphan)}`).join('|')}`;
        if (pointPillCache.signature !== sig) {
          pointPillsEl.replaceChildren();
          pointPillCache.nodesByPointId.clear();
          for (const pt of allPoints) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'point-pill';
            btn.dataset.pointId = pt.point_id;
            const label = doc.createElement('span');
            label.className = 'point-pill-label';
            const mark = doc.createElement('span');
            mark.className = 'point-orphan-mark';
            mark.textContent = '补名';
            btn.append(label, mark);
            btn.addEventListener('click', () => {
              const targetActionId = state.status.action_id;
              if (targetActionId) {
                void selectAction(targetActionId, pt.point_id);
              }
            });
            pointPillCache.nodesByPointId.set(pt.point_id, btn);
            pointPillsEl.appendChild(btn);
          }
          pointPillCache.signature = sig;
          schedulePointReveal();
        }
        for (const pt of allPoints) {
          const btn = pointPillCache.nodesByPointId.get(pt.point_id);
          if (!btn) continue;
          const isCurrent = (state.status.point_id || '') === pt.point_id;
          const isPendingThis = Boolean(
            state.pendingSelect &&
            state.pendingSelect.action_id === confirmedAction.action_id &&
            (state.pendingSelect.point_id || '') === pt.point_id
          );
          btn.classList.toggle('is-active', isCurrent);
          btn.classList.toggle('is-orphan', Boolean(pt.orphan));
          btn.querySelector('.point-orphan-mark').hidden = !pt.orphan;
          btn.setAttribute('aria-label', `${pt.point_id ? `${pt.point_id} · ${pt.orphan ? '未收录名称' : pt.name || '未收录名称'}` : '未指定点位'}${pt.orphan ? ' · 待补中文名' : ''}`);
          btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
          btn.disabled = Boolean(
            !state.connected ||
            !templateMatchesDevice() ||
            !state.status.selectionSupported ||
            state.pendingSelect ||
            pendingStart ||
            state.status.phase !== 'idle'
          );
          let displayLabel = '不指定位置';
          if (pt.point_id) {
            if (pt.orphan || !pt.name || pt.name === pt.point_id) {
              displayLabel = pt.point_id;
            } else if (pt.name.startsWith(pt.point_id)) {
              displayLabel = pt.name;
            } else {
              displayLabel = `${pt.point_id} ${pt.name}`;
            }
          }
          setTextIfChanged(
            btn.querySelector('.point-pill-label'),
            isPendingThis ? '正在切换…' : displayLabel
          );
        }
      }
    }

    const revealIdentity = `${state.status.project_id}/${state.status.action_id}/${state.status.point_id || ''}`;
    if (pointRevealIdentity !== revealIdentity) {
      pointRevealIdentity = revealIdentity;
      schedulePointReveal();
    } else if (pointRevealPending && !el('view-shoot').hidden) schedulePointReveal();
    updatePointOverflowMarkers();

    const btnPrev = el('btn-prev-action');
    const btnNext = el('btn-next-action');
    const actionSwitchBlocked = Boolean(
      !state.connected ||
      !templateMatchesDevice() ||
      !state.status.selectionSupported ||
      state.pendingSelect ||
      pendingStart ||
      state.status.phase !== 'idle'
    );
    const stepperActions = [...state.template.actions].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.action_id.localeCompare(b.action_id)
    );
    const stepperCurrentIdx = stepperActions.findIndex(a => a.action_id === state.status.action_id);
    const isFirstAction = stepperCurrentIdx === 0;
    const isLastAction = stepperCurrentIdx !== -1 && stepperCurrentIdx === stepperActions.length - 1;
    const btnOpenActionList = el('btn-open-action-list');
    if (btnPrev) btnPrev.disabled = actionSwitchBlocked || stepperActions.length === 0 || isFirstAction;
    if (btnNext) btnNext.disabled = actionSwitchBlocked || stepperActions.length === 0 || isLastAction;
    if (btnOpenActionList) btnOpenActionList.disabled = actionSwitchBlocked;
    setTextIfChanged(el('btn-prev-label'), state.pendingSelect ? '正在切换…' : '上一项');
    setTextIfChanged(el('btn-next-label'), state.pendingSelect ? '正在切换…' : '下一项');

    // Card 5: Fast Group Search & Filter List (keyed in-place updates)
    const groups = ['all', ...new Set(state.template.actions.map(a => a.group).filter(Boolean))];
    const groupSig = groups.join('\u0000');
    const groupPillsEl = el('filter-group-pills');
    if (groupPillsEl) {
      if (groupPillCache.signature !== groupSig) {
        groupPillsEl.replaceChildren();
        groupPillCache.nodesByGroup.clear();
        for (const g of groups) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-btn';
          btn.dataset.groupFilter = g;
          btn.textContent = g === 'all' ? '全部区域' : g;
          btn.addEventListener('click', () => {
            state.groupFilter = g;
            render();
          });
          groupPillCache.nodesByGroup.set(g, btn);
          groupPillsEl.appendChild(btn);
        }
        groupPillCache.signature = groupSig;
      }
      for (const g of groups) {
        const btn = groupPillCache.nodesByGroup.get(g);
        if (!btn) continue;
        const active = state.groupFilter === g;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    const typeFilters = [
      { key: 'all', label: '全部' },
      { key: 'static', label: '静态' },
      { key: 'dynamic', label: '动态' },
    ];
    const typePillsEl = el('filter-type-pills');
    if (typePillsEl) {
      if (typePillNodes.size === 0) {
        typePillsEl.replaceChildren();
        for (const tf of typeFilters) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-btn';
          btn.dataset.typeFilter = tf.key;
          btn.textContent = tf.label;
          btn.addEventListener('click', () => {
            state.typeFilter = tf.key;
            render();
          });
          typePillNodes.set(tf.key, btn);
          typePillsEl.appendChild(btn);
        }
      }
      for (const tf of typeFilters) {
        const btn = typePillNodes.get(tf.key);
        if (!btn) continue;
        const active = state.typeFilter === tf.key;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    const statusFilters = [
      { key: 'all', label: '全部' },
      { key: 'shot', label: '有记录' },
      { key: 'unshot', label: '无记录' },
    ];
    const statusPillsEl = el('filter-status-pills');
    if (statusPillsEl) {
      if (statusPillNodes.size === 0) {
        statusPillsEl.replaceChildren();
        for (const sf of statusFilters) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-btn';
          btn.dataset.statusFilter = sf.key;
          btn.textContent = sf.label;
          btn.addEventListener('click', () => {
            state.statusFilter = sf.key;
            render();
          });
          statusPillNodes.set(sf.key, btn);
          statusPillsEl.appendChild(btn);
        }
      }
      for (const sf of statusFilters) {
        const btn = statusPillNodes.get(sf.key);
        if (!btn) continue;
        const active = state.statusFilter === sf.key;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }

    const filteredActions = getFilteredActions();
    setTextIfChanged(el('action-count-badge'), `${filteredActions.length} / ${state.template.actions.length} 项`);

    const actionListEl = el('action-list');
    if (actionListEl) {
      if (filteredActions.length === 0) {
        if (!emptyActionHintEl) {
          emptyActionHintEl = doc.createElement('p');
          emptyActionHintEl.className = 'empty-hint';
          emptyActionHintEl.textContent = '没有找到，试试其他编号或名称';
        }
        reconcileChildOrder(actionListEl, [emptyActionHintEl]);
      } else {
        const desiredActionNodes = [];
        for (const item of filteredActions) {
          const entry = getOrCreateActionRow(item);
          const count = state.ledger.validCounts.get(item.action_id) || 0;
          const isConfirmed = templateMatchesDevice() && state.status.action_id === item.action_id;
          const isPending = state.pendingSelect?.action_id === item.action_id;
          const typeLabel = item.type === 'static' ? '静态' : '动态';
          const pointsHint = item.points?.length
            ? ` · 点位: ${item.points.map(p => p.point_id).join('/')}`
            : '';

          entry.rowBtn.classList.toggle('is-confirmed', isConfirmed);
          entry.rowBtn.setAttribute('aria-pressed', isConfirmed ? 'true' : 'false');
          entry.rowBtn.classList.toggle('is-pending', isPending);
          entry.rowBtn.dataset.actionId = item.action_id;
          entry.rowBtn.disabled = actionSwitchBlocked;

          setTextIfChanged(entry.idSpan, item.action_id);
          setTextIfChanged(entry.titleSpan, item.name);
          setTextIfChanged(entry.metaSpan, `${item.group} · ${typeLabel}${pointsHint}`);

          entry.pendingBadge.hidden = !isPending;
          entry.countBadge.dataset.state = count > 0 ? 'ready' : 'disconnected';
          entry.countBadge.dataset.takeCount = String(count);
          setTextIfChanged(entry.countBadge, `记录 ${count} 段`);

          desiredActionNodes.push(entry.rowBtn);
        }
        reconcileChildOrder(actionListEl, desiredActionNodes);
      }
    }

    // Card 6: Record Control & Recent Takes
    renderRecordStatusHeader(receiptStale);

    const takesDesc = [...state.ledger.takes].sort((a, b) => b.take_id - a.take_id);
    const validTotal = state.ledger.takes.filter(t => !t.discarded).length;
    setTextIfChanged(el('takes-count-badge'), `保留 ${validTotal} / 共 ${state.ledger.takes.length} 段`);

    const latest = takesDesc[0];
    const recentButton = el('btn-open-records');
    recentButton.dataset.projectId = state.ledger.project_id || '';
    recentButton.dataset.takeId = latest ? String(latest.take_id) : '';
    recentButton.disabled = !templateMatchesDevice() || !latest?.ended || !state.connected || Boolean(state.ledgerReadError) ||
      state.ledger.project_id !== state.status.project_id;
    if (!latest) {
      setTextIfChanged(el('recent-take-identity'), state.ledgerReadError ? '手机拍摄记录读取失败' : '最近：还没有拍摄记录');
      setTextIfChanged(el('recent-take-result'), '');
    } else {
      const duration = latest.ended ? getTakeDurationMs(latest) : null;
      const elapsed = latest.ended ? ` · ${duration !== null ? formatElapsedMs(duration) : '计时待确认'}` : '';
      setTextIfChanged(el('recent-take-identity'), `最近：第${latest.take_id}段 · ${latest.action_id || '未指定'}${latest.point_id ? '/' + latest.point_id : ''}${elapsed}`);
      const cameras = isValidTargetCameras(latest.participants) ? describeTargetCameras(latest.participants) : '未记录相机';
      const result = latest.discarded ? '不使用' : latest.ended ? latest.complete ? '已拍完' : '有异常' : '尚未结束';
      setTextIfChanged(el('recent-take-result'), `${cameras} · ${result}`);
    }

    const takesListEl = el('recent-takes-list');
    if (takesListEl) {
      if (takesDesc.length === 0) {
        if (!emptyTakesHintEl) {
          emptyTakesHintEl = doc.createElement('p');
          emptyTakesHintEl.className = 'empty-hint';
          emptyTakesHintEl.textContent = '还没有拍摄记录。拍完后点击“更新拍摄记录”查看。';
        }
        setTextIfChanged(emptyTakesHintEl, state.ledgerReadError ? '手机记录读取失败，已暂停显示片段；请保留缓存并修复后更新记录。' : '还没有拍摄记录。拍完后点击“更新拍摄记录”查看。');
        reconcileChildOrder(takesListEl, [emptyTakesHintEl]);
      } else {
        const desiredTakeNodes = [];
        for (const take of takesDesc) {
          const entry = getOrCreateTakeItem(take);
          const reassignDisabled = Boolean(
            !templateMatchesDevice() ||
            !take.ended ||
            !state.connected ||
            Boolean(state.ledgerReadError) ||
            state.ledger.project_id !== state.status.project_id
          );
          entry.btnReassign.disabled = reassignDisabled;
          entry.btnReassign.title = !take.ended ? '结束后可改归属' : '改归属';
          setTextIfChanged(entry.btnReassignLabel, !take.ended ? '结束后可改归属' : '改归属');
          entry.actionSelect.disabled = reassignDisabled;
          entry.pointSelect.disabled = reassignDisabled;
          entry.confirmBtn.disabled = reassignDisabled;

          entry.btnDiscard.disabled = !state.connected || Boolean(state.ledgerReadError);
          entry.itemEl.classList.toggle('is-discarded', Boolean(take.discarded));
          entry.itemEl.dataset.participants = String(take.participants || 0);

          const tplAction = findTemplateAction(state.template, take.template_id, take.action_id);
          const actionLabel = tplAction ? `${take.action_id} ${tplAction.name}` : (take.action_id || '尚未选择拍摄内容');
          const pointLabel = take.point_id ? ` · 点位 ${take.point_id}` : '';
          const reassignHint = take.reassigned && take.initial_action_id !== take.action_id
            ? ` (原: ${take.initial_action_id}${take.initial_point_id ? '/' + take.initial_point_id : ''})`
            : '';

          setTextIfChanged(entry.idSpan, `第 ${take.take_id} 段`);
          entry.attrSpan.dataset.takeAction = take.action_id || '';
          setTextIfChanged(entry.attrSpan, `${actionLabel}${pointLabel}${reassignHint}`);

          entry.participantsBadge.dataset.takeParticipants = String(take.participants || 0);
          entry.participantsBadge.dataset.state = isValidTargetCameras(take.participants) ? 'ready' : 'disconnected';
          setTextIfChanged(
            entry.participantsBadge,
            isValidTargetCameras(take.participants) ? describeTargetCameras(take.participants) : '未记录相机'
          );

          entry.discardBadge.dataset.state = take.discarded ? 'error' : 'ready';
          setTextIfChanged(entry.discardBadge, take.discarded ? '不使用' : '保留');
          setTextIfChanged(
            entry.endBadge,
            take.ended ? (take.complete ? '已拍完' : '拍摄有异常，请检查') : '尚未结束'
          );

          const camA = take.cameras?.[0];
          const camB = take.cameras?.[1];
          const camASummary = formatTakeCameraSummary(camA, 'A', take.participants, 0);
          const camBSummary = formatTakeCameraSummary(camB, 'B', take.participants, 1);

          setTextIfChanged(entry.camASpan, camASummary);
          setTextIfChanged(entry.camBSpan, camBSummary);
          setTextIfChanged(entry.btnDiscardLabel, take.discarded ? '保留这段' : '标记不用');

          const duration = take.ended ? getTakeDurationMs(take) : null;
          const durationText = take.ended ? (duration !== null ? formatElapsedMs(duration) : '计时待确认') : '';
          setTextIfChanged(entry.durationSpan, durationText);

          const isEditingThis = state.editingReassignTakeId === take.take_id;
          entry.panel.hidden = !isEditingThis;
          if (isEditingThis) {
            syncReassignSelectOptions(entry, take);
          }

          desiredTakeNodes.push(entry.itemEl);
        }
        reconcileChildOrder(takesListEl, desiredTakeNodes);
      }
    }
    updateShootOverflowMode();
  }

  // === Core Operations & BLE Flows ===

  let activeSyncPromise = null;
  let hasPendingSyncRequest = false;
  let nextSyncProject = '';

  function syncCurrentProject(explicitProjectId = state.status.project_id, { silent = false } = {}) {
    if (destroyed) return Promise.resolve(null);
    const projectId = explicitProjectId || state.status.project_id;
    if (!projectId) {
      refreshLocalLedger('');
      render();
      return Promise.resolve(null);
    }
    nextSyncProject = projectId;
    if (activeSyncPromise) {
      hasPendingSyncRequest = true;
      return activeSyncPromise;
    }
    state.syncingLog = true;
    render();

    // Install ownership before loadCursor (or any other synchronous failure).
    activeSyncPromise = Promise.resolve().then(async () => {
      let finalResult = null;
      let firstPass = true;
      try {
        do {
          if (!firstPass) hasPendingSyncRequest = false;
          firstPass = false;
          const currentProj = nextSyncProject;
          const connection = connectionVersion;
          const project = projectVersion;
          const isCurrent = () => !destroyed && state.connected &&
            connection === connectionVersion && project === projectVersion &&
            state.status.project_id === currentProj;
          try {
            const afterSeq = loadCursor(storage, currentProj);
            if (!silent && isCurrent()) setBanner('正在更新拍摄记录…', { tone: 'busy', code: 'GET_LOG' });
            const result = await client.syncLog(afterSeq, currentProj, async (event, context) => {
              if (event?.project_id !== currentProj) throw new BleClientError('invalid_log_event', 'Unexpected project in log stream');
              await persistEventToStorage(storage, event, context);
            });
            finalResult = result;
            if (isCurrent()) {
              const recovering = Boolean(state.ledgerReadError || state.ledgerSyncError);
              refreshLocalLedger(currentProj);
              if (state.ledgerReadError) {
                finalResult = null;
                state.ledgerSyncError = { ...state.ledgerReadError };
                continue;
              }
              if (Number.isSafeInteger(result?.snapshot?.event_seq)) {
                state.status.event_seq = Math.max(state.status.event_seq, result.snapshot.event_seq);
              }
              if (Number.isSafeInteger(result?.snapshot?.take_id)) {
                state.status.take_id = Math.max(state.status.take_id, result.snapshot.take_id);
              }
              if (state.ledger.after_seq < state.status.event_seq) {
                state.ledgerSyncError = { project_id: currentProj, code: 'sync_incomplete', message: '手机记录尚未更新完整' };
                finalResult = null;
                setBanner('手机拍摄记录尚未更新完整，请稍后更新拍摄记录', { tone: 'warn', code: 'ledger_not_updated' });
              } else {
                state.ledgerSyncError = null;
              }
              if (!state.ledgerSyncError && !state.templateSaveError && (!silent || recovering)) {
                setBanner(`拍摄记录已更新，共 ${state.ledger.takes.length} 段`, { tone: 'ok', code: 'SYNC_OK' });
              }
            }
          } catch (error) {
            finalResult = null;
            if (isCurrent()) {
              refreshLocalLedger(currentProj);
              state.ledgerSyncError = { project_id: currentProj, code: error?.code || error?.name || 'sync_failed', message: error?.message || '' };
              setBanner('手机拍摄记录更新失败；设备记录可能已修改，本地副本尚未更新完整', {
                tone: 'error', code: 'ledger_sync_failed', detail: error?.message || '',
              });
            }
          }
        } while (hasPendingSyncRequest && state.connected && !destroyed);
        return finalResult;
      } finally {
        state.syncingLog = false;
        activeSyncPromise = null;
        hasPendingSyncRequest = false;
        if (!destroyed) render();
      }
    });
    return activeSyncPromise;
  }

  async function runConnectSequence(connectPromise) {
    state.connecting = true;
    setBanner('正在连接遥控器…', { tone: 'busy', code: 'CONNECT' });
    render();
    try {
      await connectPromise;
      state.connected = true;
      state.connecting = false;
      setBanner('已连接，正在查看相机状态…', { tone: 'busy', code: 'GET_STATUS' });
      render();

      const status = await client.getStatus();
      applyStatusSnapshot(status);

      setBanner('正在校准遥控器时间…', { tone: 'busy', code: 'TIME_SYNC' });
      await client.syncTime(now());
      state.status.time_synced = true;
      render();

      if (status?.project_id) {
        await syncCurrentProject(status.project_id);
      } else {
        setBanner('已连接。请先新建拍摄项目。', { tone: 'ok', code: 'CONNECTED' });
      }
      render();
      return status;
    } catch (error) {
      state.connecting = false;
      state.connected = Boolean(client.connected);
      handleError('连接遥控器', error);
      return null;
    }
  }

  function disconnect() {
    try {
      client.disconnect();
      void releaseWakeLock();
      hardwareClockAnchor = null;
      state.connected = false;
      state.connecting = false;
      setBanner('已断开遥控器', { tone: 'idle', code: 'DISCONNECTED' });
      render();
    } catch (error) {
      handleError('断开连接', error);
    }
  }

  async function initProject(projectIdInput, templateIdInput) {
    const projectId = (projectIdInput ?? el('input-init-project-id')?.value ?? '').trim();
    const rawTplVal = (el('input-init-template-id')?.value ?? '').trim();
    const templateId = (templateIdInput ?? (rawTplVal || state.template.template_id)).trim();

    if (!isValidAsciiId(projectId, 63)) {
      setBanner('新建项目失败：项目编号需要填写 1 到 63 个字母、数字、下划线或短横线', {
        tone: 'error',
        code: 'invalid_project_id',
      });
      return null;
    }
    if (!isValidAsciiId(templateId, 63)) {
      setBanner('新建项目失败：拍摄清单编号需要填写 1 到 63 个字母、数字、下划线或短横线', {
        tone: 'error',
        code: 'invalid_template_id',
      });
      return null;
    }
    if (state.status.project_id !== '' || (state.status.take_id ?? 0) > 0 || state.status.phase !== 'idle') {
      setBanner('新建项目失败：已有项目不能在手机上清空，请先在电脑上备份并清空', {
        tone: 'error',
        code: 'project_not_empty',
      });
      return null;
    }

    setBanner('正在新建拍摄项目…', { tone: 'busy' });
    try {
      const reply = await client.request({
        cmd: 'INIT_PROJECT',
        project_id: projectId,
        template_id: templateId,
      });
      state.status.project_id = reply.project_id ?? projectId;
      state.status.template_id = reply.template_id ?? templateId;
      const validTarget = isValidTargetCameras(reply.target_cameras);
      state.status.target_cameras = validTarget ? reply.target_cameras : null;
      state.status.selectionSupported = state.status.selectionSupported && validTarget;
      state.status.active_participants = state.status.selectionSupported ? 0 : null;
      if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = reply.event_seq;
      if (Number.isSafeInteger(reply.take_id)) state.status.take_id = reply.take_id;
      refreshLocalLedger(state.status.project_id);
      setBanner(`项目 ${state.status.project_id} 已创建`, { tone: 'ok' });
      render();
      return reply;
    } catch (error) {
      handleError('新建项目', error);
      return null;
    }
  }

  async function selectAction(actionId, pointId = '', targetCameras = state.status.target_cameras) {
    if (rejectTemplateMismatch()) return null;
    // Recording guard: strictly block switching action or camera target when not idle!
    if (state.status.phase !== 'idle' || pendingStart) {
      setBanner('保存动作失败：请先停止录像。拍完的片段可通过“改归属”更正。', {
        tone: 'error',
        code: 'recording_active',
      });
      render();
      return null;
    }
    if (state.connected && state.lastStatusReceivedAt > 0 && state.status.selectionSupported === false) {
      setBanner('保存动作失败：当前遥控器固件暂不支持相机选择，请先升级遥控器固件。', {
        tone: 'error',
        code: 'unsupported_firmware',
      });
      render();
      return null;
    }
    if (state.pendingSelect) return null;
    if (!actionId) return null;

    const requestedTarget = targetCameras !== undefined && targetCameras !== null
      ? targetCameras
      : (isValidTargetCameras(state.status.target_cameras) ? state.status.target_cameras : 3);
    if (!isValidTargetCameras(requestedTarget)) {
      setBanner('保存动作失败：请选择有效的拍摄相机（双机、只拍 A 机或只拍 B 机）。', {
        tone: 'error',
        code: 'invalid_request',
      });
      render();
      return null;
    }

    state.pendingSelect = {
      action_id: actionId,
      point_id: pointId ?? '',
      target_cameras: requestedTarget,
    };
    setBanner('正在保存动作，请稍候', {
      tone: 'busy',
    });
    render();

    try {
      const reply = await client.request({
        cmd: 'SELECT_ACTION',
        project_id: state.status.project_id,
        action_id: actionId,
        point_id: pointId ?? '',
        target_cameras: requestedTarget,
      });
      if (!reply || reply.ok !== true) {
        throw new BleClientError(reply?.error || 'request_rejected', 'SELECT_ACTION rejected', { reply });
      }
      if (!isValidTargetCameras(reply.target_cameras)) {
        throw new BleClientError('invalid_select_ack', 'SELECT_ACTION reply missing valid target_cameras', { reply });
      }
      // Update confirmed action & target_cameras ONLY after Promise resolves with reply.ok === true and valid target_cameras
      state.pendingSelect = null;
      state.status.action_id = reply.action_id ?? actionId;
      state.status.point_id = reply.point_id ?? (pointId ?? '');
      state.status.target_cameras = reply.target_cameras;
      if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = reply.event_seq;
      if (Number.isSafeInteger(reply.take_id)) state.status.take_id = reply.take_id;
      setBanner('已保存', {
        tone: 'ok',
      });
      render();
      return reply;
    } catch (error) {
      state.pendingSelect = null;
      handleError('保存动作', error);
      return null;
    }
  }

  async function selectTargetCameras(targetCameras) {
    if (state.status.phase !== 'idle' || pendingStart) {
      setBanner('切换相机失败：请先停止录像。本段参与相机已锁定。', {
        tone: 'error',
        code: 'recording_active',
      });
      render();
      return null;
    }
    if (state.connected && state.lastStatusReceivedAt > 0 && state.status.selectionSupported === false) {
      setBanner('切换相机失败：当前遥控器固件暂不支持相机选择，请先升级遥控器固件。', {
        tone: 'error',
        code: 'unsupported_firmware',
      });
      render();
      return null;
    }
    if (state.pendingSelect) return null;
    if (!state.status.action_id) {
      setBanner('切换相机失败：请先选择当前拍摄内容。', {
        tone: 'error',
        code: 'no_action_selected',
      });
      render();
      return null;
    }
    if (!isValidTargetCameras(targetCameras)) {
      setBanner('切换相机失败：请选择双机、只拍 A 机或只拍 B 机。', {
        tone: 'error',
        code: 'invalid_request',
      });
      render();
      return null;
    }
    return selectAction(state.status.action_id, state.status.point_id || '', targetCameras);
  }

  function stepAction(direction = 1) {
    if (rejectTemplateMismatch()) return Promise.resolve(null);
    if (!state.connected || state.status.phase !== 'idle' || pendingStart || state.pendingSelect) {
      if (state.status.phase !== 'idle' || pendingStart) {
        setBanner('请先停止录像。拍完的片段可通过“改归属”更正。', {
          tone: 'error',
          code: 'recording_active',
        });
        render();
      }
      return Promise.resolve(null);
    }
    const candidates = [...state.template.actions].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.action_id.localeCompare(b.action_id)
    );
    if (candidates.length === 0) return Promise.resolve(null);

    const currentIdx = candidates.findIndex(a => a.action_id === state.status.action_id);
    let targetIdx;
    if (currentIdx === -1) {
      targetIdx = direction >= 0 ? 0 : candidates.length - 1;
    } else {
      if (direction < 0 && currentIdx === 0) {
        return Promise.resolve(null);
      }
      if (direction > 0 && currentIdx === candidates.length - 1) {
        return Promise.resolve(null);
      }
      targetIdx = currentIdx + direction;
      if (targetIdx < 0 || targetIdx >= candidates.length) {
        return Promise.resolve(null);
      }
    }
    const target = candidates[targetIdx];
    if (target.action_id === state.status.action_id) {
      return Promise.resolve(null);
    }
    return selectAction(target.action_id, '', state.status.target_cameras);
  }

  async function startRecording() {
    if (rejectTemplateMismatch()) return null;
    if (state.status.phase !== 'idle' || pendingStart || pendingStop || state.pendingSelect) return null;
    if (state.status.selectionSupported === false || !isValidTargetCameras(state.status.target_cameras)) {
      setBanner('开始录像失败：当前遥控器固件暂不支持相机选择，请先升级遥控器固件。', {
        tone: 'error',
        code: 'unsupported_firmware',
      });
      render();
      return null;
    }
    void acquireWakeLock();
    void playKeepAliveVideo();
    const commandId = createCommandId(now());
    const context = {
      projectId: state.status.project_id,
      targetCameras: state.status.target_cameras,
      connection: connectionVersion,
      statusVersion,
      cancelRequested: false,
    };
    context.finished = new Promise(resolve => { context.finish = resolve; });
    pendingStart = context;
    state.pendingStartCommandId = commandId;
    setBanner('正在通知相机开始录像…', { tone: 'busy', code: 'START' });
    render();
    try {
      const reply = await client.request({
        cmd: 'START',
        project_id: context.projectId,
        command_id: commandId,
        target_cameras: context.targetCameras,
      });
      if (connectionVersion !== context.connection || state.status.project_id !== context.projectId) return null;
      if (reply?.ok !== true) {
        throw new BleClientError(reply?.error || 'request_rejected', 'START rejected', { reply });
      }
      const newerStatus = statusVersion !== context.statusVersion &&
        state.status.event_seq >= (reply.event_seq ?? 0);
      if (Number.isSafeInteger(reply.take_id)) {
        state.status.take_id = Math.max(state.status.take_id, reply.take_id);
        if (!newerStatus) state.status.active_take_id = reply.active_take_id ?? reply.take_id;
      }
      if (Number.isSafeInteger(reply.event_seq)) {
        state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
      }
      if (!newerStatus) {
        state.status.phase = reply.phase || 'starting';
        if (isValidTargetCameras(reply.target_cameras)) {
          state.status.target_cameras = reply.target_cameras;
        }
        if (isValidActiveParticipants(reply.active_participants)) {
          state.status.active_participants = reply.active_participants;
        } else if (state.status.phase !== 'idle') {
          state.status.active_participants = context.targetCameras;
        }
      }
      pendingStart = null;
      state.pendingStartCommandId = null;
      void syncCurrentProject(context.projectId, { silent: true });
      if (context.cancelRequested) {
        // Wait for the admitted take ID rather than stopping an older take or
        // sending an unbound STOP while START is still in flight.
        if (!newerStatus || state.status.phase !== 'idle') await stopRecording();
      } else if (!newerStatus) {
        setBanner('开始请求已收到，正在等待相机确认录像', {
          tone: 'warn',
          code: 'START_ACK',
        });
      }
      render();
      return reply;
    } catch (error) {
      if (connectionVersion === context.connection && state.status.project_id === context.projectId) {
        void releaseWakeLock();
        handleError('开始录像', error);
      }
      return null;
    } finally {
      if (pendingStart === context) {
        pendingStart = null;
        state.pendingStartCommandId = null;
      }
      context.finish();
      render();
    }
  }

  async function stopRecording() {
    void releaseWakeLock();
    if (pendingStart) {
      pendingStart.cancelRequested = true;
      setBanner('已请求停止，正在等待遥控器确认本段编号…', { tone: 'busy' });
      render();
      return pendingStart.finished;
    }
    if (pendingStop) return pendingStop;
    const targetTakeId = state.status.active_take_id || state.status.take_id;
    const projectId = state.status.project_id;
    const connection = connectionVersion;
    const version = statusVersion;
    state.status.phase = 'stopping';
    setBanner('正在通知相机停止录像…', { tone: 'busy', code: 'STOP' });
    const operation = Promise.resolve().then(async () => {
      try {
        const reply = await client.request({
          cmd: 'STOP',
          project_id: projectId,
          take_id: targetTakeId,
        });
        if (connectionVersion !== connection || state.status.project_id !== projectId) return null;
        if (reply?.ok !== true) {
          throw new BleClientError(reply?.error || 'request_rejected', 'STOP rejected', { reply });
        }
        state.pendingStartCommandId = null;
        const newerStatus = statusVersion !== version &&
          state.status.event_seq >= (reply.event_seq ?? 0);
        if (!newerStatus && typeof reply.phase === 'string') {
          state.status.phase = reply.phase;
          if (reply.phase === 'idle') {
            void releaseWakeLock();
            state.status.active_take_id = 0;
            if (state.status.selectionSupported) state.status.active_participants = 0;
          }
        }
        if (Number.isSafeInteger(reply.event_seq)) {
          state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
        }
        setBanner('停止请求已收到，请查看相机是否已停止', { tone: 'ok', code: 'STOP_ACK' });
        void syncCurrentProject(projectId, { silent: true });
        return reply;
      } catch (error) {
        if (connectionVersion === connection && state.status.project_id === projectId) {
          handleError('停止录像', error);
        }
        return null;
      } finally {
        pendingStop = null;
        render();
      }
    });
    pendingStop = operation;
    render();
    return operation;
  }

  function openTakeReassign(takeId, projectId) {
    if (rejectTemplateMismatch()) return false;
    if (destroyed || !state.connected || !projectId || projectId !== state.status.project_id) return false;
    refreshLocalLedger(projectId);
    if (state.ledgerReadError || state.ledger.project_id !== projectId) return false;
    const take = state.ledger.takes.find(t => t.take_id === takeId && t.ended);
    if (!take) return false;
    state.editingReassignTakeId = takeId;
    state.reassignDrafts.set(takeId, { action_id: take.action_id || state.template.actions[0]?.action_id || '', point_id: take.point_id || '' });
    switchView('records');
    const entry = takeItemCache.get(takeId);
    if (!entry) return false;
    entry.actionSelect.focus({ preventScroll: true });
    const viewport = el('view-records');
    const panelRect = entry.panel.getBoundingClientRect();
    const viewRect = viewport.getBoundingClientRect();
    if (panelRect.bottom > viewRect.bottom) viewport.scrollTop += panelRect.bottom - viewRect.bottom;
    if (panelRect.top < viewRect.top) viewport.scrollTop -= viewRect.top - panelRect.top;
    return true;
  }

  function canEditTake(takeId, projectId) {
    if (!state.connected || projectId !== state.status.project_id) return false;
    refreshLocalLedger(projectId);
    if (state.ledgerReadError || state.ledger.project_id !== projectId ||
        !state.ledger.takes.some(take => take.take_id === takeId)) {
      setBanner('手机记录无法读取或找不到本段，未向设备发送修改；请先更新拍摄记录', {
        tone: 'error', code: 'ledger_unavailable',
      });
      render();
      return false;
    }
    return true;
  }

  async function markDiscard(takeId, discard, projectId = state.status.project_id) {
    if (!canEditTake(takeId, projectId)) return null;
    const connection = connectionVersion;
    const project = projectVersion;
    setBanner(`正在${discard ? '标记不使用' : '重新保留'}第 ${takeId} 段…`, { tone: 'busy', code: 'MARK_DISCARD' });
    try {
      const reply = await client.request({ cmd: 'MARK_DISCARD', project_id: projectId, take_id: takeId, discard: Boolean(discard) });
      if (connection !== connectionVersion || project !== projectVersion || projectId !== state.status.project_id) return reply;
      if (reply?.ok !== true) throw new BleClientError(reply?.error || 'request_rejected', 'MARK_DISCARD rejected', { reply });
      if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
      state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机记录尚未更新' };
      const synced = await syncCurrentProject(projectId);
      if (connection !== connectionVersion || project !== projectVersion || projectId !== state.status.project_id) return reply;
      if (synced && !state.ledgerReadError && !state.ledgerSyncError) {
        setBanner(`第 ${takeId} 段已${discard ? '标记为不使用' : '重新保留'}`, { tone: 'ok', code: 'DISCARD_OK' });
      } else {
        setBanner('设备已修改片段用途，手机记录尚未更新；请稍后更新拍摄记录', { tone: 'warn', code: 'ledger_not_updated' });
      }
      render();
      return reply;
    } catch (error) {
      if (connection === connectionVersion && project === projectVersion) handleError('修改片段用途', error);
      return null;
    }
  }

  async function reassignTake(takeId, actionId, pointId = '', projectId = state.status.project_id) {
    if (rejectTemplateMismatch()) return null;
    if (!actionId || !canEditTake(takeId, projectId)) return null;
    const take = state.ledger.takes.find(t => t.take_id === takeId);
    if (!take?.ended) return null;
    const connection = connectionVersion;
    const project = projectVersion;
    setBanner(`正在修改第 ${takeId} 段归属…`, { tone: 'busy', code: 'REASSIGN' });
    try {
      const reply = await client.request({ cmd: 'REASSIGN', project_id: projectId, take_id: takeId, action_id: actionId, point_id: pointId ?? '' });
      if (connection !== connectionVersion || project !== projectVersion || projectId !== state.status.project_id) return reply;
      if (reply?.ok !== true) throw new BleClientError(reply?.error || 'request_rejected', 'REASSIGN rejected', { reply });
      state.editingReassignTakeId = null;
      state.reassignDrafts.delete(takeId);
      if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
      state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机记录尚未更新' };
      const synced = await syncCurrentProject(projectId);
      if (connection !== connectionVersion || project !== projectVersion || projectId !== state.status.project_id) return reply;
      if (synced && !state.ledgerReadError && !state.ledgerSyncError) {
        setBanner(`第 ${takeId} 段已修改归属`, { tone: 'ok', code: 'REASSIGN_OK' });
      } else {
        setBanner('设备已修改片段归属，手机记录尚未更新；请稍后更新拍摄记录', { tone: 'warn', code: 'ledger_not_updated' });
      }
      render();
      return reply;
    } catch (error) {
      if (connection === connectionVersion && project === projectVersion) handleError('改归属', error);
      return null;
    }
  }

  function importTemplateObject(rawObj, { persist = true, announce = true } = {}) {
    const normalized = normalizeTemplate(rawObj);
    if (persist) {
      storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(normalized));
      state.templateLoadError = null;
    }
    state.template = normalized;
    state.templateVersion += 1;
    if (announce) {
      setBanner(`已载入拍摄清单，共 ${normalized.actions.length} 项`, {
        tone: 'ok',
        code: 'TEMPLATE_OK',
      });
    }
    render();
    return normalized;
  }

  async function loadInitialTemplate() {
    try {
      const cached = storage.getItem(TEMPLATE_CACHE_KEY);
      if (cached) {
        importTemplateObject(JSON.parse(cached), { persist: false, announce: false });
        return state.template;
      }
    } catch (error) {
      // Cache failure must not interrupt safety setup or erase the original bytes.
      state.templateLoadError = { code: error?.code || error?.name || 'template_cache_unavailable', message: error?.message || '' };
      handleError('读取拍摄清单缓存', error);
    }
    if (typeof fetchFn === 'function') {
      try {
        const res = await fetchFn('../schema/actions.json');
        if (res && res.ok) {
          const data = await res.json();
          importTemplateObject(data, { persist: false, announce: false });
          return state.template;
        }
      } catch {
        // Fallback to built-in CLEANROOM_SMOKE_V1
      }
    }
    importTemplateObject(DEFAULT_TEMPLATE, { persist: false, announce: false });
    return state.template;
  }

  function buildBackupPayload() {
    const projectId = state.status.project_id;
    refreshLocalLedger(projectId);
    if (state.ledgerReadError || state.ledger.project_id !== projectId) {
      state.lastBackupPayload = null;
      render();
      return null;
    }
    const payload = {
      exported_at: new Date(now()).toISOString(),
      project_id: projectId,
      template_id: state.status.template_id || state.template.template_id,
      after_seq: state.ledger.after_seq,
      events: state.ledger.events,
      takes: state.ledger.takes,
    };
    state.lastBackupPayload = payload;
    return payload;
  }

  function triggerDownload(filename, text, mimeType = 'application/json;charset=utf-8') {
    if (typeof download === 'function') {
      download(filename, text, mimeType);
      return;
    }
    if (!doc || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return;
    }
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    doc.body?.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000)?.unref?.();
  }

  function announceBackup(message, code, payload, tone = 'ok') {
    if (state.status.project_id !== payload.project_id) return;
    if (state.ledgerReadError) {
      setBanner('手机记录读取失败，请修复后再导出', { tone: 'error', code: 'ledger_unavailable' });
    } else if (localLedgerIncomplete() || payload.after_seq < state.ledger.after_seq || payload.after_seq < state.status.event_seq) {
      setBanner(`${message}；仅为同项目已有本地副本，手机记录尚未更新完整`, { tone: 'warn', code: 'local_copy_incomplete' });
    } else {
      setBanner(message, { tone, code });
    }
    renderLedgerStorageNotice();
  }

  async function copyBackup() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const json = JSON.stringify(payload, null, 2);
    try {
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new BleClientError('clipboard_unavailable', 'Clipboard API unavailable');
      }
      await clipboard.writeText(json);
      announceBackup('备份已复制', 'COPY_OK', payload);
      return payload;
    } catch (error) {
      handleError('复制备份', error);
      return null;
    }
  }

  function downloadBackup() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const json = JSON.stringify(payload, null, 2);
    const safeProj = (payload.project_id || 'uninitialized').replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger_backup.json`;
    triggerDownload(filename, json);
    announceBackup('备份文件已生成，请留意浏览器的保存提示', 'DOWNLOAD_OK', payload);
    return payload;
  }

  async function shareBackup() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const json = JSON.stringify(payload, null, 2);
    const safeProj = (payload.project_id || 'uninitialized').replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger_backup.json`;
    if (typeof share === 'function') {
      try {
        await share({
          title: `拍摄记录备份 ${payload.project_id || ''}`,
          text: json,
        });
        announceBackup('已打开分享窗口', 'SHARE_OK', payload);
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          announceBackup('已取消分享', 'SHARE_CANCELLED', payload, 'warn');
          return payload;
        }
      }
    }
    if (state.status.project_id !== payload.project_id || state.ledgerReadError) return null;
    triggerDownload(filename, json);
    announceBackup('此浏览器不能分享，已为你生成备份文件', 'SHARE_FALLBACK_DOWNLOAD', payload, 'warn');
    return payload;
  }

  // === Bind DOM Events ===

  const btnToggleSettings = el('btn-toggle-settings');
  if (btnToggleSettings) {
    btnToggleSettings.addEventListener('click', () => {
      const modalSettings = el('modal-settings');
      if (!modalSettings) return;
      if (modalSettings.open) {
        void closeDialog(modalSettings);
      } else {
        for (const id of ['modal-add-point', 'modal-shoot-details']) {
          const other = el(id);
          if (other?.open) void closeDialog(other, { immediate: true });
        }
        openDialog(modalSettings, { returnFocus: btnToggleSettings });
        render();
      }
    });
  }
  const btnSettingsClose = el('btn-settings-close');
  if (btnSettingsClose) {
    btnSettingsClose.addEventListener('click', () => {
      void closeDialog(el('modal-settings'));
    });
  }

  for (const navEl of root.querySelectorAll('[data-view-nav]')) {
    navEl.addEventListener('click', () => {
      const targetView = navEl.dataset.viewNav;
      if (targetView) switchView(targetView);
    });
  }

  const btnOpenActionList = el('btn-open-action-list');
  if (btnOpenActionList) {
    btnOpenActionList.addEventListener('click', () => {
      if (btnOpenActionList.disabled) return;
      switchView('list');
    });
  }

  const btnListBackShoot = el('btn-list-back-shoot');
  if (btnListBackShoot) {
    btnListBackShoot.addEventListener('click', () => {
      switchView('shoot');
    });
  }

  const btnAfterSelectReturn = el('btn-after-select-return');
  if (btnAfterSelectReturn) {
    btnAfterSelectReturn.addEventListener('click', () => {
      switchView('shoot');
    });
  }

  const btnOpenRecords = el('btn-open-records');
  if (btnOpenRecords) {
    btnOpenRecords.addEventListener('click', () => {
      openTakeReassign(Number(btnOpenRecords.dataset.takeId), btnOpenRecords.dataset.projectId);
    });
  }

  const btnRecordsBackShoot = el('btn-records-back-shoot');
  if (btnRecordsBackShoot) {
    btnRecordsBackShoot.addEventListener('click', () => {
      switchView('shoot');
    });
  }

  const btnRecordsSync = el('btn-records-sync');
  if (btnRecordsSync) {
    btnRecordsSync.addEventListener('click', () => {
      void syncCurrentProject(state.status.project_id);
    });
  }

  for (const camBtn of root.querySelectorAll('[data-target-cameras]')) {
    camBtn.addEventListener('click', () => {
      const val = Number(camBtn.dataset.targetCameras);
      void selectTargetCameras(val);
    });
  }

  const btnConnect = el('btn-connect');
  if (btnConnect) {
    btnConnect.addEventListener('click', () => {
      if (state.connected) {
        disconnect();
        return;
      }
      // Must call client.connect() synchronously inside user click gesture!
      let connectPromise;
      try {
        connectPromise = client.connect();
      } catch (syncErr) {
        connectPromise = Promise.reject(syncErr);
      }
      void runConnectSequence(connectPromise);
    });
  }

  const btnSync = el('btn-sync-log');
  if (btnSync) {
    btnSync.addEventListener('click', () => {
      void syncCurrentProject(state.status.project_id);
    });
  }

  const btnImportTemplate = el('btn-import-template');
  const fileInput = el('input-template-file');
  if (btnImportTemplate && fileInput) {
    btnImportTemplate.addEventListener('click', () => {
      fileInput.click();
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', async event => {
      const file = event.target?.files?.[0];
      if (!file) return;
      try {
        const text = typeof file.text === 'function'
          ? await file.text()
          : await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(reader.error || new Error('file_read_failed'));
              reader.readAsText(file, 'utf-8');
            });
        const parsed = JSON.parse(text);
        importTemplateObject(parsed, { persist: true, announce: true });
      } catch (error) {
        handleError('导入拍摄清单', error);
      } finally {
        fileInput.value = '';
      }
    });
  }

  const initTplInput = el('input-init-template-id');
  if (initTplInput) {
    initTplInput.addEventListener('input', () => {
      initTplInput.dataset.userEdited = 'true';
    });
  }

  const btnInitProject = el('btn-init-project');
  if (btnInitProject) {
    btnInitProject.addEventListener('click', () => {
      void initProject();
    });
  }

  const btnPrev = el('btn-prev-action');
  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      void stepAction(-1);
    });
  }

  const btnNext = el('btn-next-action');
  if (btnNext) {
    btnNext.addEventListener('click', () => {
      void stepAction(1);
    });
  }

  const searchInput = el('input-action-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      render();
    });
  }

  const btnRecordMain = el('btn-record-main');
  if (btnRecordMain) {
    btnRecordMain.addEventListener('click', () => {
      if (el('btn-record-main')?.dataset.mode === 'start') {
        void startRecording();
      } else {
        void stopRecording();
      }
    });
  }

  const btnGlobalStop = el('btn-global-stop');
  if (btnGlobalStop) {
    btnGlobalStop.addEventListener('click', () => {
      void stopRecording();
    });
  }

  const btnCopy = el('btn-backup-copy');
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      void copyBackup();
    });
  }

  const btnShare = el('btn-backup-share');
  if (btnShare) {
    btnShare.addEventListener('click', () => {
      void shareBackup();
    });
  }

  const btnDownload = el('btn-backup-download');
  if (btnDownload) {
    btnDownload.addEventListener('click', () => {
      downloadBackup();
    });
  }

  function downloadCsv() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const projectId = payload.project_id || 'uninitialized';
    const csvContent = exportLedgerCsv(payload, state.template, { now });
    const safeProj = projectId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger.csv`;
    triggerDownload(filename, csvContent, 'text/csv;charset=utf-8');
    announceBackup('CSV 拍摄记录已生成，请留意浏览器的保存提示', 'CSV_DOWNLOAD_OK', payload);
    return csvContent;
  }

  const btnBackupCsv = el('btn-backup-csv');
  if (btnBackupCsv) {
    btnBackupCsv.addEventListener('click', () => {
      downloadCsv();
    });
  }

  const modalAddPoint = el('modal-add-point');
  const btnTriggerAddPoint = el('btn-trigger-add-point');
  const btnCancelAddPoint = el('btn-cancel-add-point');
  const formAddPoint = el('form-add-point');
  const inputAddPointId = el('input-add-point-id');
  const inputAddPointName = el('input-add-point-name');
  const msgAddPointError = el('msg-add-point-error');

  let isNameComposing = false;
  if (inputAddPointName) {
    inputAddPointName.addEventListener('compositionstart', () => { isNameComposing = true; });
    inputAddPointName.addEventListener('compositionend', () => { isNameComposing = false; });
    inputAddPointName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isNameComposing) {
        e.preventDefault();
      }
    });
  }

  function detailIdentityMatches(context) {
    return !destroyed && context.projectId === state.status.project_id &&
      context.templateId === state.template.template_id && context.deviceTemplateId === state.status.template_id;
  }
  function currentLedgerFailure() {
    return state.ledgerReadError || (state.ledgerSyncError?.code !== 'sync_pending' ? state.ledgerSyncError : null);
  }
  function showShootDetails({ kind = 'shoot', focusOrphans = false } = {}) {
    if (kind !== 'shoot' && kind !== 'ledger') return;
    if (kind === 'shoot' && !state.status.action_id) return;
    const dialog = el('modal-shoot-details');
    if (dialog.open || dialogRecords.get(dialog)?.closingPromise) return;
    const context = {
      kind, projectId: state.status.project_id, templateId: state.template.template_id, deviceTemplateId: state.status.template_id,
      actionId: state.status.action_id, pointId: state.status.point_id || '',
      failure: currentLedgerFailure(),
    };
    shootDetailsContext = context;
    const content = el('shoot-details-content');
    const type = el('confirmed-action-type');
    const group = el('confirmed-action-group');
    content.replaceChildren();
    const add = (label, value, node = null) => {
      const dt = doc.createElement('dt');
      dt.textContent = label;
      const dd = node || doc.createElement('dd');
      dd.hidden = false;
      dd.textContent = value;
      content.append(dt, dd);
    };
    const orphans = el('shoot-orphan-points');
    orphans.replaceChildren();
    orphans.hidden = kind === 'ledger';
    if (kind === 'ledger') {
      setTextIfChanged(el('shoot-details-title'), '手机记录详情');
      add('项目', context.projectId || '未创建项目');
      add('代码', context.failure?.code || '');
      add('完整信息', context.failure?.message || '手机记录已更新');
      // Preserve the original semantic nodes without showing shoot fields in ledger details.
      type.hidden = true; group.hidden = true;
      content.append(type, group);
    } else {
      const action = currentTemplateAction(context.actionId);
      const point = action?.points.find(p => p.point_id === context.pointId);
      setTextIfChanged(el('shoot-details-title'), '拍摄详情');
      add('动作编号', context.actionId);
      add('动作名称', action?.name || '未收录名称');
      add('点位编号', context.pointId || '未指定点位');
      add('点位名称', context.pointId ? point && !point.orphan ? point.name : '未收录名称' : '未指定点位');
      add('类型', action ? action.type === 'static' ? '静态' : '动态' : '未收录名称', type);
      add('区域', action?.group || '未收录名称', group);
      add('保持亮屏', screenAwakeMode === 'idle' ? '未申请保持亮屏' : screenAwakeMessage);
      for (const point of action?.points.filter(p => p.orphan) || []) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.dataset.renamePointId = point.point_id;
        button.dataset.actionId = context.actionId;
        button.textContent = `给 ${point.point_id} 补名`;
        button.addEventListener('click', async () => {
          await closeDialog(dialog);
          const target = state.template.actions.find(a => a.action_id === context.actionId)?.points.find(p => p.point_id === point.point_id && p.orphan);
          if (!detailIdentityMatches(context) || state.status.action_id !== context.actionId || !target) return;
          showPointDialog({ actionId: context.actionId, pointId: point.point_id, returnFocus: el('btn-current-details') });
        });
        orphans.append(button);
      }
    }
    openDialog(dialog);
    if (focusOrphans) orphans.querySelector('button')?.focus();
  }
  function closeStaleShootDetails() {
    const context = shootDetailsContext;
    if (!context || !el('modal-shoot-details').open) return;
    const stale = context.kind === 'shoot'
      ? !detailIdentityMatches(context) || context.actionId !== state.status.action_id || context.pointId !== (state.status.point_id || '')
      : context.projectId !== state.status.project_id || !currentLedgerFailure();
    if (stale) void closeDialog(el('modal-shoot-details'), { immediate: true });
  }
  let pointDialogContext = null;
  function showPointDialog({ actionId = state.status.action_id, pointId = null, returnFocus = doc.activeElement } = {}) {
    if (rejectTemplateMismatch()) return;
    const action = currentTemplateAction(actionId);
    if (!action) {
      setBanner('请先选择拍摄动作后再添加点位', { tone: 'warn' });
      render();
      return;
    }
    const rename = pointId !== null;
    const point = rename ? action.points.find(p => p.point_id === pointId && p.orphan) : null;
    if (rename && !point) return;
    if (modalAddPoint.open || dialogRecords.get(modalAddPoint)?.closingPromise) return;
    pointDialogContext = { deviceTemplateId: state.status.template_id, projectId: state.status.project_id, actionId: action.action_id, templateId: state.template.template_id, pointId: point?.point_id ?? null };
    inputAddPointId.value = point?.point_id ?? deduceNextPointId(action.points);
    inputAddPointId.readOnly = rename;
    inputAddPointId.maxLength = rename ? 31 : 16;
    inputAddPointId.pattern = rename ? '^[A-Za-z0-9_.\\-]+$' : '^[A-Za-z0-9_\\-]+$';
    inputAddPointName.maxLength = POINT_NAME_MAX_LENGTH;
    inputAddPointName.required = rename;
    inputAddPointName.value = '';
    setTextIfChanged(el('modal-add-point-title'), rename ? `给 ${point.point_id} 补中文名` : '现场新增点位');
    setTextIfChanged(el('btn-confirm-add-point'), rename ? '保存中文名' : '保存并选中');
    setTextIfChanged(msgAddPointError, '');
    openDialog(modalAddPoint, { returnFocus });
    inputAddPointName.focus();
  }
  if (btnTriggerAddPoint) {
    btnTriggerAddPoint.setAttribute('aria-haspopup', 'dialog');
    btnTriggerAddPoint.addEventListener('click', () => showPointDialog());
  }
  el('btn-current-details')?.addEventListener('click', () => showShootDetails());
  el('btn-ledger-details')?.addEventListener('click', () => showShootDetails({ kind: 'ledger' }));
  el('btn-shoot-details-close')?.addEventListener('click', () => { void closeDialog(el('modal-shoot-details')); });
  el('btn-rename-point')?.addEventListener('click', () => {
    const action = state.template.actions.find(a => a.action_id === state.status.action_id);
    const selected = action?.points.find(p => p.point_id === state.status.point_id && p.orphan);
    if (selected) showPointDialog({ pointId: selected.point_id });
    else showShootDetails({ focusOrphans: true });
  });
  btnCancelAddPoint?.addEventListener('click', () => { void closeDialog(modalAddPoint); });
  function bindSheetInteractions(dialog) {
    if (!dialog) return () => {};
    const handle = dialog.querySelector('.sheet-handle');
    let drag = null;
    if (handle) handle.style.touchAction = 'pinch-zoom';
    const reset = () => {
      if (drag && handle?.hasPointerCapture?.(drag.id)) handle.releasePointerCapture(drag.id);
      drag = null;
      dialog.style.transform = '';
    };
    const onDown = e => {
      if (e.isPrimary === false || (e.button !== undefined && e.button !== 0) || dialogRecords.get(dialog)?.closingPromise) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, distance: 0 };
      handle.setPointerCapture?.(e.pointerId);
    };
    const onMove = e => {
      if (!drag || drag.id !== e.pointerId) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(e.clientX - drag.x) > Math.max(16, dy)) { reset(); return; }
      drag.distance = Math.max(0, dy);
      if (!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) dialog.style.transform = `translateY(${drag.distance}px)`;
    };
    const onUp = e => {
      if (!drag || drag.id !== e.pointerId) return;
      const shouldClose = drag.distance >= 72;
      if (shouldClose) void closeDialog(dialog);
      reset();
    };
    const onCancel = e => { e.preventDefault(); void closeDialog(dialog); };
    const onBackdrop = e => {
      if (e.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) void closeDialog(dialog);
    };
    const onClose = () => {
      if (dialog.open) return;
      reset();
      const record = dialogRecords.get(dialog);
      if (!record) return;
      dialogRecords.delete(dialog);
      record.animation?.cancel?.();
      if (dialog.id === 'modal-shoot-details') shootDetailsContext = null;
      if (dialog.id === 'modal-settings') {
        const btn = el('btn-toggle-settings');
        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
          btn.classList.remove('is-active');
        }
      }
      if (destroyed) return;
      const target = record.returnFocus;
      let visible = Boolean(target?.isConnected && !target.disabled && !target.closest('[hidden]'));
      for (let node = target; visible && node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') visible = false;
      }
      (visible ? target : el('btn-toggle-settings'))?.focus?.();
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('click', onBackdrop);
    dialog.addEventListener('close', onClose);
    handle?.addEventListener('pointerdown', onDown);
    handle?.addEventListener('pointermove', onMove);
    handle?.addEventListener('pointerup', onUp);
    handle?.addEventListener('pointercancel', reset);
    return () => {
      reset();
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('click', onBackdrop);
      dialog.removeEventListener('close', onClose);
      handle?.removeEventListener('pointerdown', onDown);
      handle?.removeEventListener('pointermove', onMove);
      handle?.removeEventListener('pointerup', onUp);
      handle?.removeEventListener('pointercancel', reset);
    };
  }
  const unbindSheets = [modalAddPoint, el('modal-shoot-details'), el('modal-settings')].map(bindSheetInteractions);

  formAddPoint?.addEventListener('submit', async e => {
    e.preventDefault();
    if (isNameComposing || !pointDialogContext || dialogRecords.get(modalAddPoint)?.closingPromise) return;
    const context = pointDialogContext;
    const rename = context.pointId !== null;
    const rawId = inputAddPointId.value.trim();
    if (!(rename ? rawId === context.pointId && isValidAsciiId(rawId, 31) : isValidPointId(rawId))) {
      setTextIfChanged(msgAddPointError, '点位编号仅支持 1-16 位英文字母、数字、下划线及短横线 (ASCII)');
      return;
    }
    if (!templateMatchesDevice() || !detailIdentityMatches(context)) {
      setTextIfChanged(msgAddPointError, '拍摄清单已切换，请取消后重新打开');
      return;
    }
    const candidate = normalizeTemplate(state.template);
    const action = candidate.actions.find(a => a.action_id === context.actionId);
    if (!action) { setTextIfChanged(msgAddPointError, '未找到当前动作，请重新选择'); return; }
    const existing = action.points.find(p => p.point_id.toUpperCase() === rawId.toUpperCase());
    if (existing && (!rename || !existing.orphan)) {
      setTextIfChanged(msgAddPointError, `点位编号 ${rawId} 已存在，请使用其他编号`);
      return;
    }
    if (rename && !existing) { setTextIfChanged(msgAddPointError, '待补名点位已变更，请重新打开'); return; }
    const rawName = inputAddPointName.value.trim() || (rename ? '' : rawId);
    // Match the input's UTF-16 limit; reject overlong values rather than truncating Unicode.
    if (!rawName || rawName.length > POINT_NAME_MAX_LENGTH) {
      setTextIfChanged(msgAddPointError, `请填写不超过 ${POINT_NAME_MAX_LENGTH} 字符的点位名称`);
      return;
    }
    if (rename) { existing.name = rawName; delete existing.orphan; }
    else action.points.push({ point_id: rawId, name: rawName });
    try {
      storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(candidate));
    } catch (error) {
      setTextIfChanged(msgAddPointError, '点位未保存，请腾出手机存储空间后再试；输入已保留');
      return;
    }
    state.template = candidate;
    state.templateVersion += 1;
    if (rename) dialogRecords.get(modalAddPoint).returnFocus = el('btn-current-details');
    await closeDialog(modalAddPoint);
    if (destroyed) return;
    if (rename) {
      setBanner(`已保存 ${rawId} 的中文名`, { tone: 'ok' });
    } else {
      // A local dictionary save survives a rejected/busy device selection.
      const reply = detailIdentityMatches(context) && state.status.action_id === context.actionId
        ? await selectAction(context.actionId, rawId) : null;
      if (reply?.ok === true) setBanner(`已添加并选中点位 ${rawId}`, { tone: 'ok' });
      else setBanner(`点位 ${rawId} 已保存，但设备未选中，请稍后点选`, { tone: 'warn' });
    }
    render();
  });

  const onVisibilityChange = () => {
    hardwareClockAnchor = null;
    renderRecordElapsed(true);
    if (doc?.visibilityState === 'visible') {
      if (state.status.phase === 'recording') {
        void acquireWakeLock();
      }
      if (state.connected && state.status.project_id) {
        const connection = connectionVersion;
        const project = projectVersion;
        void client.getStatus().then(snapshot => {
          if (!destroyed && state.connected && connection === connectionVersion && project === projectVersion) applyStatusSnapshot(snapshot);
        }).catch(error => { if (!destroyed) handleError('更新相机状态', error); });
        void syncCurrentProject(state.status.project_id, { silent: true });
      }
    }
  };
  doc?.addEventListener?.('visibilitychange', onVisibilityChange);

  const btnTheme = el('btn-theme-toggle');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const rootDocEl = doc?.documentElement;
      if (!rootDocEl) return;
      const current = rootDocEl.getAttribute('data-theme') ||
        (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'dark' ? 'light' : 'dark';
      rootDocEl.setAttribute('data-theme', next);
      try { storage.setItem(THEME_CACHE_KEY, next); } catch {
        // Theme is optional; changing it never depends on durable storage.
      }
    });
  }

  // Restore saved theme if present
  let savedTheme = null;
  try { savedTheme = storage.getItem(THEME_CACHE_KEY); } catch {
    // Optional preferences must not prevent core monitor/cleanup initialization.
  }
  if (savedTheme === 'light' || savedTheme === 'dark') {
    doc?.documentElement?.setAttribute('data-theme', savedTheme);
  }

  const onWindowResize = () => {
    updateSheetViewport();
    render();
    schedulePointReveal();
  };
  win?.addEventListener?.('resize', onWindowResize);
  el('point-pills')?.addEventListener('scroll', updatePointOverflowMarkers, { passive: true });
  el('point-pills')?.addEventListener('focusin', onPointFocusIn, { passive: true });

  // Periodic staleness monitor: updates only camera freshness and record status header
  const staleTimer = setInterval(() => {
    if (state.connected && state.lastStatusReceivedAt > 0) {
      renderStalenessTick();
    }
  }, 1000);
  staleTimer?.unref?.();

  // Initialize template and initial render
  setScreenAwakeNotice('idle', '未申请保持亮屏');
  render();
  const readyPromise = loadInitialTemplate();

  return {
    root,
    client,
    storage,
    state,
    ready: readyPromise,
    render,
    renderStalenessTick,
    setBanner,
    switchView,
    applyStatusSnapshot,
    refreshLocalLedger,
    syncCurrentProject,
    initProject,
    selectAction,
    selectTargetCameras,
    stepAction,
    startRecording,
    stopRecording,
    markDiscard,
    reassignTake,
    importTemplateObject,
    buildBackupPayload,
    copyBackup,
    shareBackup,
    downloadBackup,
    downloadCsv,
    openDialog,
    closeDialog,
    acquireWakeLock,
    releaseWakeLock,
    disconnect,
    destroy() {
      destroyed = true;
      shootResizeObserver?.disconnect();
      if (feedbackTimer !== null) win?.clearTimeout(feedbackTimer);
      feedbackVersion += 1;
      if (pointRevealRaf !== null) win?.cancelAnimationFrame?.(pointRevealRaf);
      if (pointFocusRaf !== null) win?.cancelAnimationFrame?.(pointFocusRaf);
      el('point-pills')?.removeEventListener('scroll', updatePointOverflowMarkers);
      el('point-pills')?.removeEventListener('focusin', onPointFocusIn);
      hardwareClockAnchor = null;
      sheetViewport?.removeEventListener?.('resize', updateSheetViewport);
      sheetViewport?.removeEventListener?.('scroll', updateSheetViewport);
      void closeDialog(modalAddPoint, { immediate: true });
      void closeDialog(el('modal-shoot-details'), { immediate: true });
      void closeDialog(el('modal-settings'), { immediate: true });
      for (const unbind of unbindSheets) unbind();
      clearInterval(staleTimer);
      win?.removeEventListener?.('resize', onWindowResize);
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
      void releaseWakeLock();
    },
  };
}

// Auto-boot in browser when #app-root is present
if (typeof document !== 'undefined' && document.getElementById('app-root') && !globalThis.__DJI_SKIP_AUTO_BOOT__) {
  globalThis.__DJI_APP__ = createApp({ root: document.getElementById('app-root') });
}
