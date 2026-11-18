import { BleClientError } from '../ble-client.mjs';
import {
  isValidAsciiId,
  isValidTargetCameras,
  computeCameraAdmission,
} from './formatters.mjs';

const utf8Encoder = new TextEncoder();

export function createMockBleClient({
  projectId = 'MOCK_PREVIEW_01',
  templateId = 'CLEANROOM_SMOKE_V1',
  actionId = 'S01',
  pointId = '',
  targetCameras = 3,
  ackDelayMs = 20,
  autoConfirmRecordingMs = 30,
  heartbeatMs = 0,
  initialEvents = [],
} = {}) {
  let heartbeatTimer = null;
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
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
      stopHeartbeat();
      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (!state.connected) return;
          state.mono_ms += heartbeatMs;
          if (state.phase === 'recording' && Array.isArray(state.cameras)) {
            const stepSec = Math.max(1, Math.round(heartbeatMs / 1000));
            for (let i = 0; i < state.cameras.length; i++) {
              if (state.cameras[i]?.recording) {
                state.cameras[i] = { ...state.cameras[i], record_time: (state.cameras[i].record_time || 0) + stepSec };
              }
            }
          }
          client.emitStatus();
        }, heartbeatMs);
        heartbeatTimer?.unref?.();
      }
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
      stopHeartbeat();
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
