// Browser-native ESM mobile Bento UI for DJI Osmo Action 6 Dual-Camera Field Controller.
// Zero external dependencies; reuses DjiBleClient from ./ble-client.mjs.

import { DjiBleClient, BleClientError, UUIDS, KINDS } from './ble-client.mjs';

export { DjiBleClient, BleClientError, UUIDS, KINDS };

export const TEMPLATE_CACHE_KEY = 'dji-template-current';
export const THEME_CACHE_KEY = 'dji-ui-theme';
export const STALE_STATUS_MS = 3500;

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
        boot_id: evt.begin_boot_id || evt.boot_id || '',
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

export function filterActions(actions = [], { query = '', group = 'all', statusFilter = 'all', validCounts = new Map() } = {}) {
  const sorted = [...actions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.action_id.localeCompare(b.action_id));
  return sorted.filter(action => {
    if (group && group !== 'all' && group !== '全部' && action.group !== group) {
      return false;
    }
    const count = validCounts.get(action.action_id) || 0;
    if (statusFilter === 'static' || statusFilter === '静态') {
      if (action.type !== 'static') return false;
    } else if (statusFilter === 'dynamic' || statusFilter === '动态') {
      if (action.type !== 'dynamic') return false;
    } else if (statusFilter === 'unshot' || statusFilter === '未拍') {
      if (count > 0) return false;
    } else if (statusFilter === 'shot' || statusFilter === '已拍') {
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
    </header>
    <main class="bento-grid workbench-shell" data-bento-grid="true">
      <p id="mock-notice" class="mock-notice" hidden>演示模式 · 不会连接真实设备</p>
      <section id="topbar-summary" class="topbar-summary bento-span-2" aria-label="遥控器与项目概览">
        <div class="topbar-summary-left">
          <span id="conn-badge" class="badge" data-state="disconnected">
            <span class="badge-dot"></span><span id="conn-badge-text">未连接</span>
          </span>
          <span id="topbar-project-summary" class="topbar-meta-text">未创建项目</span>
        </div>
        <div class="topbar-summary-actions">
          <button id="btn-toggle-settings" type="button" class="btn" aria-expanded="false">${ICONS.settings}<span id="btn-toggle-settings-label">设备与项目</span></button>
          <button id="btn-theme-toggle" type="button" class="btn btn-icon-only" aria-label="切换明暗主题">${ICONS.theme}</button>
        </div>
      </section>
      <div class="workbench-columns">
        <div id="view-shoot" class="view-panel" data-view-panel="shoot">
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
              <div class="kv-item"><span class="kv-label">已拍段数</span><span id="meta-take-id" class="kv-value">0</span></div>
            </div>
            <div class="button-row">
              <button id="btn-connect" type="button" class="btn btn-primary">${ICONS.bluetooth}<span id="btn-connect-label">连接遥控器</span></button>
              <button id="btn-sync-log" type="button" class="btn" disabled>${ICONS.sync}<span>更新拍摄记录</span></button>
              <label for="input-template-file" class="file-upload-label" role="button" tabindex="0">${ICONS.upload}<span>导入拍摄清单</span></label>
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
          <section id="card-current-action" class="bento-card bento-span-2 bento-card-primary" aria-labelledby="title-current-action">
            <div class="card-header">
              <div class="card-title-group">${ICONS.step}<h2 id="title-current-action" class="card-title">当前拍摄内容</h2></div>
              <div class="card-header-actions">
                <span id="action-pending-badge" class="badge" data-state="warn" hidden>正在保存动作，请稍候</span>
                <button id="btn-open-action-list" type="button" class="btn">${ICONS.list}<span>挑动作 / 清单</span></button>
              </div>
            </div>
            <div class="current-action-hero">
              <div class="current-action-top">
                <div class="current-action-badges"><span id="confirmed-action-id" class="current-action-code">未选择</span><span id="confirmed-point-id" class="badge" hidden>不指定拍摄位置</span></div>
                <div class="current-action-badges"><span id="confirmed-action-type" class="badge" hidden></span><span id="confirmed-action-group" class="badge" hidden></span></div>
              </div>
              <p id="confirmed-action-name" class="current-action-name">请从拍摄清单中选择一项</p>
            </div>
            <div id="points-container" hidden><span class="kv-label">拍摄位置</span><div id="point-pills" class="pill-strip"></div></div>
            <div class="button-row">
              <button id="btn-prev-action" type="button" class="btn">${ICONS.prev}<span id="btn-prev-label">上一项</span></button>
              <button id="btn-next-action" type="button" class="btn"><span id="btn-next-label">下一项</span>${ICONS.next}</button>
            </div>
          </section>
          <section id="card-record-ledger" class="bento-card bento-span-2 bento-card-primary" aria-labelledby="title-record-ledger">
            <div class="card-header">
              <div class="card-title-group">${ICONS.record}<h2 id="title-record-ledger" class="card-title">录像与相机控制</h2></div>
              <span id="phase-badge" class="badge" data-state="disconnected">状态：待机</span>
            </div>
            <div id="target-camera-strip" class="target-camera-strip" role="group" aria-label="选择本段使用的相机">
              <button id="btn-target-both" type="button" class="target-cam-btn is-active" data-target-cameras="3" aria-pressed="true">双机同拍</button>
              <button id="btn-target-a" type="button" class="target-cam-btn" data-target-cameras="1" aria-pressed="false">只拍 A 机</button>
              <button id="btn-target-b" type="button" class="target-cam-btn" data-target-cameras="2" aria-pressed="false">只拍 B 机</button>
            </div>
            <div class="record-phase-bar"><span id="record-observation-text">请先连接遥控器</span><span id="active-take-badge" class="badge" hidden></span></div>
            <button id="btn-record-main" type="button" class="btn btn-ready record-cta-btn" data-mode="start">
              <span id="btn-record-icon">${ICONS.record}</span><span id="btn-record-label">开始录像</span>
            </button>
            <div class="camera-pair-grid">
              ${['a', 'b'].map((camera, index) => {
                const camLetter = index === 0 ? 'A' : 'B';
                return `
              <section id="card-cam-${camera}" class="bento-card bento-span-1 is-disconnected" aria-labelledby="title-cam-${camera}">
                <div class="card-header">
                  <div id="cam-${camera}-title-wrap" class="card-title-group" hidden>${ICONS.camera}<h2 id="title-cam-${camera}" class="card-title">相机 ${camLetter}</h2></div>
                  <span id="cam-${camera}-badge" class="badge" data-state="disconnected"><span class="badge-dot"></span><span id="cam-${camera}-badge-text">${camLetter}机未连接</span></span>
                </div>
                <div id="cam-${camera}-metrics" class="cam-metrics" hidden>
                  <div class="kv-item"><span class="kv-label">电量</span><span id="cam-${camera}-battery" class="kv-value"></span></div>
                  <div class="kv-item"><span class="kv-label">拍摄状态</span><span id="cam-${camera}-mode" class="kv-value">未连接</span></div>
                </div>
                <details id="cam-${camera}-details" class="device-details" hidden>
                  <summary>相机详情</summary>
                  <div class="kv-grid">
                    <div class="kv-item"><span class="kv-label">最近一次状态更新</span><span id="cam-${camera}-fresh" class="kv-value">未连接</span></div>
                    <div class="kv-item"><span class="kv-label">相机返回的计时数值</span><span id="cam-${camera}-record-time" class="kv-value">0</span></div>
                  </div>
                  <p class="card-subtitle">计时单位尚未确认，这个数值不作为录像时长。</p>
                  <div class="cam-led-box"><span>遥控器指示灯</span><span id="cam-${camera}-led" class="badge"></span></div>
                </details>
              </section>`;
              }).join('')}
            </div>
            <div id="recent-take-bar" class="recent-take-bar">
              <span id="recent-take-summary" class="recent-take-text">最近一段：还没有拍摄记录</span>
              <button id="btn-open-records" type="button" class="btn">${ICONS.history}<span>已拍记录</span></button>
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
            <div id="filter-status-pills" class="pill-strip" role="group" aria-label="按类别和已拍情况筛选"></div>
            <div id="action-list" class="action-list" role="list"></div>
          </section>
        </div>
        <div id="view-records" class="view-panel" data-view-panel="records" hidden>
          <section id="card-records-history" class="bento-card bento-span-2" aria-labelledby="title-records-history">
            <div class="card-header">
              <div class="card-title-group">${ICONS.history}<h2 id="title-records-history" class="card-title">已拍记录</h2></div>
              <div class="card-header-actions">
                <span id="takes-count-badge" class="badge">共 0 段</span>
                <button id="btn-records-sync" type="button" class="btn" disabled>${ICONS.sync}<span>更新拍摄记录</span></button>
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
              </div>
            </div>
          </section>
        </div>
      </div>
      <nav id="bottom-view-nav" class="bottom-view-nav" aria-label="工作台视图切换">
        <button id="nav-btn-shoot" type="button" class="view-nav-btn is-active" data-view-nav="shoot" aria-pressed="true">${ICONS.record}<span>现场拍摄</span></button>
        <button id="nav-btn-list" type="button" class="view-nav-btn" data-view-nav="list" aria-pressed="false">${ICONS.list}<span>拍摄清单</span></button>
        <button id="nav-btn-records" type="button" class="view-nav-btn" data-view-nav="records" aria-pressed="false">${ICONS.history}<span>已拍记录</span></button>
      </nav>
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
    settingsExpanded: false,
    template: normalizeTemplate(DEFAULT_TEMPLATE),
    templateVersion: 1,
    searchQuery: '',
    groupFilter: 'all',
    statusFilter: 'all',
    pendingSelect: null, // { action_id, point_id, target_cameras } while awaiting SELECT_ACTION ACK
    pendingStartCommandId: null,
    editingReassignTakeId: null,
    reassignDrafts: new Map(), // take_id -> { action_id, point_id }
    lastBackupPayload: null,
    lastErrorCode: '',
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

  let pendingStart = null;
  let pendingStop = null;
  let statusVersion = 0;
  let connectionVersion = 0;

  // Keyed DOM caches so interactive controls are NEVER destroyed on tick/STATUS
  const pointPillCache = {
    signature: '',
    nodesByPointId: new Map(),
  };
  const groupPillCache = {
    signature: '',
    nodesByGroup: new Map(),
  };
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

  function setBanner(message, { tone = 'idle', code = '', detail = '' } = {}) {
    if (!bannerEl) return;
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

  function refreshLocalLedger(projectId = state.status.project_id) {
    if (!projectId) {
      state.ledger = { project_id: '', after_seq: 0, events: [], takes: [], validCounts: new Map() };
      return state.ledger;
    }
    try {
      state.ledger = loadProjectLedger(storage, projectId);
    } catch (error) {
      handleError('读取拍摄记录', error);
    }
    return state.ledger;
  }

  function applyStatusSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    statusVersion += 1;
    state.lastStatusReceivedAt = now();
    const prevProjectId = state.status.project_id;
    if (typeof snapshot.project_id === 'string') state.status.project_id = snapshot.project_id;
    if (typeof snapshot.template_id === 'string' && snapshot.template_id) state.status.template_id = snapshot.template_id;
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
    if (state.status.phase === 'idle' && !pendingStart) {
      state.pendingStartCommandId = null;
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
    if (typeof prevOnStatus === 'function') await prevOnStatus(status);
    applyStatusSnapshot(status);
  };

  const prevOnConnection = client.onConnection;
  client.onConnection = async info => {
    if (typeof prevOnConnection === 'function') await prevOnConnection(info);
    connectionVersion += 1;
    state.connected = Boolean(info?.connected);
    state.connecting = false;
    if (!info?.connected) {
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
    if (titleWrapEl) titleWrapEl.hidden = !showConnectedDetails;
    if (metricsEl) metricsEl.hidden = !showConnectedDetails;
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
        ? ''
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
      btn.disabled = !state.connected || !selectionSupported || Boolean(state.pendingSelect || pendingStart || phase !== 'idle');
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
      const desiredMode = (phase === 'idle' && !pendingStart && !(state.status.active_take_id > 0) && !anyConnectedRecording)
        ? 'start'
        : 'stop';
      btnRecordMain.disabled = !state.connected ||
        Boolean(pendingStop || pendingStart?.cancelRequested) ||
        (desiredMode === 'start' && (
          !selectionSupported ||
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
      } else {
        setTextIfChanged(obsTextEl, `已就绪（${describeTargetCameras(effectiveTarget)}），可以开始录像`);
      }
    }
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
    } else {
      draft.point_id = '';
      entry.pointSelect.value = '';
    }
  }

  function getOrCreateTakeItem(take) {
    const takeId = take.take_id;
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
      headerRight.appendChild(participantsBadge);
      headerRight.appendChild(discardBadge);
      headerRight.appendChild(endBadge);

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
      btnReassignLabel.textContent = '修改拍摄内容';
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
        camASpan,
        camBSpan,
        btnDiscard,
        btnDiscardLabel,
        btnReassign,
        panel,
        actionSelect,
        pointSelect,
        confirmBtn,
        cancelBtn,
        populatedTemplateVersion: 0,
        populatedActionId: null,
      };

      btnDiscard.addEventListener('click', () => {
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId);
        const currentDiscarded = Boolean(currentTake?.discarded);
        void markDiscard(takeId, !currentDiscarded);
      });

      btnReassign.addEventListener('click', () => {
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId) || take;
        if (state.editingReassignTakeId === takeId) {
          state.editingReassignTakeId = null;
          state.reassignDrafts.delete(takeId);
        } else {
          state.editingReassignTakeId = takeId;
          state.reassignDrafts.set(takeId, {
            action_id: currentTake.action_id || state.template.actions[0]?.action_id || '',
            point_id: currentTake.point_id ?? '',
          });
          syncReassignSelectOptions(entry, currentTake);
        }
        render();
      });

      actionSelect.addEventListener('change', () => {
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId) || take;
        const nextActionId = actionSelect.value;
        state.reassignDrafts.set(takeId, {
          action_id: nextActionId,
          point_id: '',
        });
        syncReassignSelectOptions(entry, currentTake);
      });

      pointSelect.addEventListener('change', () => {
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
        void reassignTake(takeId, targetAction, targetPoint);
      });

      cancelBtn.addEventListener('click', () => {
        state.editingReassignTakeId = null;
        state.reassignDrafts.delete(takeId);
        render();
      });

      takeItemCache.set(takeId, entry);
    }
    return entry;
  }

  function render() {
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

    // Card 1: Connection & Project / Template
    const connBadge = el('conn-badge');
    const connBadgeText = el('conn-badge-text');
    if (connBadge && connBadgeText) {
      if (state.syncingLog) {
        connBadge.dataset.state = 'syncing';
        setTextIfChanged(connBadgeText, '正在更新记录');
      } else if (state.connecting) {
        connBadge.dataset.state = 'syncing';
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
        setTextIfChanged(topbarProjSummary, `项目 ${state.status.project_id} · 已拍 ${state.status.take_id ?? 0} 段`);
      }
    }

    setTextIfChanged(el('template-subtitle'), `拍摄清单：${state.template.template_name}`);
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

    const mustShowSetupCard = !state.connected || state.connecting || isProjectEmpty;
    const cardConnEl = el('card-connection');
    if (cardConnEl) {
      cardConnEl.hidden = !mustShowSetupCard && !state.settingsExpanded;
    }
    const btnToggleSettings = el('btn-toggle-settings');
    if (btnToggleSettings) {
      const isExpanded = mustShowSetupCard || state.settingsExpanded;
      btnToggleSettings.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      btnToggleSettings.classList.toggle('is-active', isExpanded);
    }

    // Card 2 & Card 3: Camera A & Camera B
    renderCameraCard('cam-a', state.status.cameras?.[0], receiptStale);
    renderCameraCard('cam-b', state.status.cameras?.[1], receiptStale);

    // Card 4: Current Confirmed Action & Stepper
    const confirmedAction = state.template.actions.find(a => a.action_id === state.status.action_id) || null;
    setTextIfChanged(el('confirmed-action-id'), state.status.action_id || '未选择');

    const confirmedPointIdEl = el('confirmed-point-id');
    if (confirmedPointIdEl) {
      confirmedPointIdEl.hidden = !confirmedAction && !state.status.point_id;
      const ptObj = confirmedAction?.points?.find(p => p.point_id === state.status.point_id);
      setTextIfChanged(
        confirmedPointIdEl,
        state.status.point_id
          ? `位置：${ptObj?.name || state.status.point_id}`
          : '不指定拍摄位置'
      );
    }

    const confirmedTypeEl = el('confirmed-action-type');
    if (confirmedTypeEl) {
      confirmedTypeEl.hidden = !confirmedAction;
      setTextIfChanged(
        confirmedTypeEl,
        confirmedAction ? (confirmedAction.type === 'static' ? '静态' : '动态') : ''
      );
    }
    const confirmedGroupEl = el('confirmed-action-group');
    if (confirmedGroupEl) {
      confirmedGroupEl.hidden = !confirmedAction;
      setTextIfChanged(confirmedGroupEl, confirmedAction?.group || '');
    }
    setTextIfChanged(
      el('confirmed-action-name'),
      confirmedAction
        ? confirmedAction.name
        : (state.status.action_id ? `清单中没有 ${state.status.action_id}，请检查所选清单` : '请从拍摄清单中选择一项')
    );

    const listSelectedSummary = el('list-selected-summary');
    if (listSelectedSummary) {
      setTextIfChanged(
        listSelectedSummary,
        confirmedAction
          ? `当前动作：${confirmedAction.action_id} ${confirmedAction.name}`
          : (state.status.action_id ? `当前动作：${state.status.action_id}` : '当前动作：未选择')
      );
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
      const points = confirmedAction?.points || [];
      if (points.length === 0) {
        pointsContainer.hidden = true;
        if (pointPillCache.signature !== '') {
          pointPillsEl.replaceChildren();
          pointPillCache.nodesByPointId.clear();
          pointPillCache.signature = '';
        }
      } else {
        pointsContainer.hidden = false;
        const allPoints = [{ point_id: '', name: '未指定' }, ...points];
        const sig = `${confirmedAction.action_id}::${allPoints.map(p => `${p.point_id}=${p.name}`).join('|')}`;
        if (pointPillCache.signature !== sig) {
          pointPillsEl.replaceChildren();
          pointPillCache.nodesByPointId.clear();
          for (const pt of allPoints) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'point-pill';
            btn.dataset.pointId = pt.point_id;
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
          btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
          btn.disabled = Boolean(
            !state.status.selectionSupported ||
            state.pendingSelect ||
            pendingStart ||
            state.status.phase !== 'idle'
          );
          setTextIfChanged(
            btn,
            isPendingThis
              ? '正在切换…'
              : (pt.point_id ? `${pt.point_id} ${pt.name}` : '不指定位置')
          );
        }
      }
    }

    const btnPrev = el('btn-prev-action');
    const btnNext = el('btn-next-action');
    const actionSwitchBlocked = Boolean(
      !state.status.selectionSupported ||
      state.pendingSelect ||
      pendingStart ||
      state.status.phase !== 'idle'
    );
    if (btnPrev) btnPrev.disabled = actionSwitchBlocked || state.template.actions.length === 0;
    if (btnNext) btnNext.disabled = actionSwitchBlocked || state.template.actions.length === 0;
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

    const statusFilters = [
      { key: 'all', label: '全部' },
      { key: 'static', label: '静态' },
      { key: 'dynamic', label: '动态' },
      { key: 'unshot', label: '未拍' },
      { key: 'shot', label: '已拍' },
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
          const isConfirmed = state.status.action_id === item.action_id;
          const isPending = state.pendingSelect?.action_id === item.action_id;
          const typeLabel = item.type === 'static' ? '静态' : '动态';
          const pointsHint = item.points?.length
            ? ` · 点位: ${item.points.map(p => p.point_id).join('/')}`
            : '';

          entry.rowBtn.classList.toggle('is-confirmed', isConfirmed);
          entry.rowBtn.classList.toggle('is-pending', isPending);
          entry.rowBtn.dataset.actionId = item.action_id;
          entry.rowBtn.disabled = actionSwitchBlocked;

          setTextIfChanged(entry.idSpan, item.action_id);
          setTextIfChanged(entry.titleSpan, item.name);
          setTextIfChanged(entry.metaSpan, `${item.group} · ${typeLabel}${pointsHint}`);

          entry.pendingBadge.hidden = !isPending;
          entry.countBadge.dataset.state = count > 0 ? 'ready' : 'disconnected';
          entry.countBadge.dataset.takeCount = String(count);
          setTextIfChanged(entry.countBadge, `已拍 ${count} 段`);

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

    const recentTakeSummaryEl = el('recent-take-summary');
    if (recentTakeSummaryEl) {
      if (takesDesc.length === 0) {
        setTextIfChanged(recentTakeSummaryEl, '最近一段：还没有拍摄记录');
      } else {
        const latest = takesDesc[0];
        const latestTargetLabel = isValidTargetCameras(latest.participants)
          ? describeTargetCameras(latest.participants)
          : '未记录相机';
        const latestStateLabel = latest.discarded
          ? '不使用'
          : (latest.ended ? (latest.complete ? '已拍完' : '有异常') : '尚未结束');
        setTextIfChanged(
          recentTakeSummaryEl,
          `最近：第 ${latest.take_id} 段 · ${latest.action_id || '未指定'} · ${latestTargetLabel} · ${latestStateLabel}`
        );
      }
    }

    const takesListEl = el('recent-takes-list');
    if (takesListEl) {
      if (takesDesc.length === 0) {
        if (!emptyTakesHintEl) {
          emptyTakesHintEl = doc.createElement('p');
          emptyTakesHintEl.className = 'empty-hint';
          emptyTakesHintEl.textContent = '还没有拍摄记录。拍完后点击“更新拍摄记录”查看。';
        }
        reconcileChildOrder(takesListEl, [emptyTakesHintEl]);
      } else {
        const desiredTakeNodes = [];
        for (const take of takesDesc) {
          const entry = getOrCreateTakeItem(take);
          entry.itemEl.classList.toggle('is-discarded', Boolean(take.discarded));
          entry.itemEl.dataset.participants = String(take.participants || 0);

          const tplAction = state.template.actions.find(a => a.action_id === take.action_id);
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
          setTextIfChanged(entry.btnDiscardLabel, take.discarded ? '保留这段' : '不用这段');

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
  }

  // === Core Operations & BLE Flows ===

  async function syncCurrentProject(explicitProjectId = state.status.project_id) {
    const projectId = explicitProjectId || state.status.project_id;
    if (!projectId) {
      refreshLocalLedger('');
      render();
      return null;
    }
    state.syncingLog = true;
    render();
    try {
      const afterSeq = loadCursor(storage, projectId);
      setBanner('正在更新拍摄记录…', { tone: 'busy', code: 'GET_LOG' });
      const result = await client.syncLog(
        afterSeq,
        projectId,
        async (event, context) => {
          await persistEventToStorage(storage, event, context);
        }
      );
      refreshLocalLedger(projectId);
      if (result?.snapshot && Number.isSafeInteger(result.snapshot.event_seq)) {
        state.status.event_seq = Math.max(state.status.event_seq, result.snapshot.event_seq);
      }
      if (result?.snapshot && Number.isSafeInteger(result.snapshot.take_id)) {
        state.status.take_id = Math.max(state.status.take_id, result.snapshot.take_id);
      }
      setBanner(`拍摄记录已更新，共 ${state.ledger.takes.length} 段`, {
        tone: 'ok',
        code: 'SYNC_OK',
      });
      return result;
    } catch (error) {
      refreshLocalLedger(projectId);
      handleError('更新拍摄记录', error);
      return null;
    } finally {
      state.syncingLog = false;
      render();
    }
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
      state.settingsExpanded = false;
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
    // Recording guard: strictly block switching action or camera target when not idle!
    if (state.status.phase !== 'idle' || pendingStart) {
      setBanner('保存动作失败：请先停止录像。拍完的片段可通过“修改拍摄内容”更正。', {
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
    if (state.status.phase !== 'idle' || pendingStart) {
      setBanner('请先停止录像。拍完的片段可通过“修改拍摄内容”更正。', {
        tone: 'error',
        code: 'recording_active',
      });
      render();
      return Promise.resolve(null);
    }
    const list = getFilteredActions();
    const candidates = list.length > 0 ? list : state.template.actions;
    if (candidates.length === 0) return Promise.resolve(null);

    const currentIdx = candidates.findIndex(a => a.action_id === state.status.action_id);
    let targetIdx;
    if (currentIdx === -1) {
      targetIdx = direction >= 0 ? 0 : candidates.length - 1;
    } else {
      targetIdx = (currentIdx + direction + candidates.length) % candidates.length;
    }
    const target = candidates[targetIdx];
    return selectAction(target.action_id, '', state.status.target_cameras);
  }

  async function startRecording() {
    if (state.status.phase !== 'idle' || pendingStart || pendingStop || state.pendingSelect) return null;
    if (state.status.selectionSupported === false || !isValidTargetCameras(state.status.target_cameras)) {
      setBanner('开始录像失败：当前遥控器固件暂不支持相机选择，请先升级遥控器固件。', {
        tone: 'error',
        code: 'unsupported_firmware',
      });
      render();
      return null;
    }
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
            state.status.active_take_id = 0;
            if (state.status.selectionSupported) state.status.active_participants = 0;
          }
        }
        if (Number.isSafeInteger(reply.event_seq)) {
          state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
        }
        setBanner('停止请求已收到，请查看相机是否已停止', { tone: 'ok', code: 'STOP_ACK' });
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

  async function markDiscard(takeId, discard) {
    setBanner(`正在${discard ? '标记不使用' : '重新保留'}第 ${takeId} 段…`, {
      tone: 'busy',
      code: 'MARK_DISCARD',
    });
    try {
      const reply = await client.request({
        cmd: 'MARK_DISCARD',
        project_id: state.status.project_id,
        take_id: takeId,
        discard: Boolean(discard),
      });
      await syncCurrentProject(state.status.project_id);
      setBanner(`第 ${takeId} 段已${discard ? '标记为不使用' : '重新保留'}`, {
        tone: 'ok',
        code: 'DISCARD_OK',
      });
      render();
      return reply;
    } catch (error) {
      handleError('修改片段用途', error);
      return null;
    }
  }

  async function reassignTake(takeId, actionId, pointId = '') {
    if (!actionId) return null;
    setBanner(`正在修改第 ${takeId} 段的拍摄内容…`, {
      tone: 'busy',
      code: 'REASSIGN',
    });
    try {
      const reply = await client.request({
        cmd: 'REASSIGN',
        project_id: state.status.project_id,
        take_id: takeId,
        action_id: actionId,
        point_id: pointId ?? '',
      });
      state.editingReassignTakeId = null;
      state.reassignDrafts.delete(takeId);
      await syncCurrentProject(state.status.project_id);
      setBanner(`第 ${takeId} 段的拍摄内容已修改`, {
        tone: 'ok',
        code: 'REASSIGN_OK',
      });
      render();
      return reply;
    } catch (error) {
      handleError('修改拍摄内容', error);
      return null;
    }
  }

  function importTemplateObject(rawObj, { persist = true, announce = true } = {}) {
    const normalized = normalizeTemplate(rawObj);
    state.template = normalized;
    state.templateVersion += 1;
    if (persist) {
      storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(normalized));
    }
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
    const cached = storage.getItem(TEMPLATE_CACHE_KEY);
    if (cached) {
      try {
        importTemplateObject(JSON.parse(cached), { persist: false, announce: false });
        return state.template;
      } catch {
        storage.removeItem(TEMPLATE_CACHE_KEY);
      }
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
    const projectId = state.status.project_id || state.ledger.project_id || '';
    if (projectId) refreshLocalLedger(projectId);
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

  function triggerDownload(filename, text) {
    if (typeof download === 'function') {
      download(filename, text);
      return;
    }
    if (!doc || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return;
    }
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
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

  async function copyBackup() {
    const payload = buildBackupPayload();
    const json = JSON.stringify(payload, null, 2);
    try {
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new BleClientError('clipboard_unavailable', 'Clipboard API unavailable');
      }
      await clipboard.writeText(json);
      setBanner('备份已复制', {
        tone: 'ok',
        code: 'COPY_OK',
      });
      return payload;
    } catch (error) {
      handleError('复制备份', error);
      return null;
    }
  }

  function downloadBackup() {
    const payload = buildBackupPayload();
    const json = JSON.stringify(payload, null, 2);
    const safeProj = (payload.project_id || 'uninitialized').replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger_backup.json`;
    triggerDownload(filename, json);
    setBanner('备份文件已生成，请留意浏览器的保存提示', { tone: 'ok', code: 'DOWNLOAD_OK' });
    return payload;
  }

  async function shareBackup() {
    const payload = buildBackupPayload();
    const json = JSON.stringify(payload, null, 2);
    const safeProj = (payload.project_id || 'uninitialized').replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger_backup.json`;
    if (typeof share === 'function') {
      try {
        await share({
          title: `拍摄记录备份 ${payload.project_id || ''}`,
          text: json,
        });
        setBanner('已打开分享窗口', { tone: 'ok', code: 'SHARE_OK' });
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          setBanner('已取消分享', { tone: 'warn', code: 'SHARE_CANCELLED' });
          return payload;
        }
      }
    }
    triggerDownload(filename, json);
    setBanner('此浏览器不能分享，已为你生成备份文件', {
      tone: 'warn',
      code: 'SHARE_FALLBACK_DOWNLOAD',
    });
    return payload;
  }

  // === Bind DOM Events ===

  const btnToggleSettings = el('btn-toggle-settings');
  if (btnToggleSettings) {
    btnToggleSettings.addEventListener('click', () => {
      state.settingsExpanded = !state.settingsExpanded;
      if (state.settingsExpanded && state.activeView !== 'shoot') {
        switchView('shoot');
      } else {
        render();
      }
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
      switchView('records');
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

  const fileInput = el('input-template-file');
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

  const btnTheme = el('btn-theme-toggle');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const rootDocEl = doc?.documentElement;
      if (!rootDocEl) return;
      const current = rootDocEl.getAttribute('data-theme') ||
        (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'dark' ? 'light' : 'dark';
      rootDocEl.setAttribute('data-theme', next);
      storage.setItem(THEME_CACHE_KEY, next);
    });
  }

  // Restore saved theme if present
  const savedTheme = storage.getItem(THEME_CACHE_KEY);
  if (savedTheme === 'light' || savedTheme === 'dark') {
    doc?.documentElement?.setAttribute('data-theme', savedTheme);
  }

  const onWindowResize = () => {
    render();
  };
  win?.addEventListener?.('resize', onWindowResize);

  // Periodic staleness monitor: updates only camera freshness and record status header
  const staleTimer = setInterval(() => {
    if (state.connected && state.lastStatusReceivedAt > 0) {
      renderStalenessTick();
    }
  }, 1000);
  staleTimer?.unref?.();

  // Initialize template and initial render
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
    disconnect,
    destroy() {
      clearInterval(staleTimer);
      win?.removeEventListener?.('resize', onWindowResize);
    },
  };
}

// Auto-boot in browser when #app-root is present
if (typeof document !== 'undefined' && document.getElementById('app-root') && !globalThis.__DJI_SKIP_AUTO_BOOT__) {
  globalThis.__DJI_APP__ = createApp({ root: document.getElementById('app-root') });
}
