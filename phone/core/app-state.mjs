import { BUILTIN_PRESETS } from '../presets/index.mjs';
import { DEFAULT_TEMPLATE } from './constants.mjs';
import {
  normalizeTemplate,
  isValidTargetCameras,
  isValidActiveParticipants,
} from './formatters.mjs';

export function createInitialAppState({ connected = false, initialSoundEnabled = true } = {}) {
  return {
    connected: Boolean(connected),
    connecting: false,
    syncingLog: false,
    statusSoundEnabled: initialSoundEnabled,
    lastStatusReceivedAt: 0,
    activeView: 'shoot', // 'list' | 'shoot' | 'records'
    desktopMode: false,
    viewScrollTop: { shoot: 0, list: 0, records: 0 },
    template: normalizeTemplate(DEFAULT_TEMPLATE),
    templateVersion: 1,
    searchQuery: '',
    groupFilter: 'all',
    typeFilter: 'all',
    statusFilter: 'all',
    coupleStepperToFilters: false,
    expandedChecklistActionId: null,
    shootTakesExpanded: false,
    shootTakesPointFilter: 'all',
    expandedShootTakeIds: new Set(),
    recordsFilter: 'all',
    selectedRecordTakeIds: new Set(),
    expandedRecordTakeIds: new Set(),
    activeDiagCam: 'a',
    selectedInitPresetId: BUILTIN_PRESETS[0]?.template_id || '',
    pendingSelect: null,
    pendingStartCommandId: null,
    editingReassignTakeId: null,
    editingReassignTakeIds: [],
    editingReassignProjectId: '',
    reassignSurface: 'records',
    reassignDrafts: new Map(),
    lastBackupPayload: null,
    lastErrorCode: '',
    templateSaveError: false,
    templateLoadError: null,
    ledgerReadError: null,
    ledgerSyncError: null,
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
      progress: new Map(),
      takesByBucket: new Map(),
    },
  };
}

export function createInitialRuntimeState() {
  return {
    pendingStart: null,
    pendingStop: null,
    pendingStopStartedAt: 0,
    stopFeedbackContext: null,
    pendingTakeEdits: new Map(),
    syncingTakeEdits: new Set(),
    batchOperationInFlight: null,
    isSyncLogStreamActive: false,
    lastSyncLogActivityAt: 0,
    prevFullRecordingObs: { bootId: '', takeId: -1, mask: 0, localStartedAt: 0, full: false },
    activeLocalStartAt: 0,
    wasActiveCaptureMode: false,
    startCooldownUntil: 0,
    startCooldownTimer: null,
    reassignReturnFocus: null,
    statusVersion: 0,
    connectionVersion: 0,
    projectVersion: 0,
    destroyed: false,
    hardwareClockAnchor: null,
    shootDetailsContext: null,
    hasEnteredReadyWorkbench: false,
    wasUnexpectedDropInReady: false,
    smartLandedSessionKey: '',
    lastShootActionForExpand: '',
    offlineRecordsBrowse: false,
    contiguousLocalSelectSeq: 0,
    manualDisconnecting: false,
  };
}

export function applyStatusSnapshotToState({ state, rt, snapshot, frameNow }) {
  rt.statusVersion += 1;
  state.lastStatusReceivedAt = frameNow;
  const prevPhase = state.status.phase;
  const prevProjectId = state.status.project_id;
  const prevBootId = state.status.boot_id;

  if (typeof snapshot.project_id === 'string') state.status.project_id = snapshot.project_id;
  if (typeof snapshot.template_id === 'string') state.status.template_id = snapshot.template_id;
  else if (prevProjectId !== state.status.project_id) state.status.template_id = '';
  if (prevProjectId !== state.status.project_id) {
    state.pendingSelect = null;
  }

  const hasValidTarget = isValidTargetCameras(snapshot.target_cameras);
  const hasValidActive = isValidActiveParticipants(snapshot.active_participants);
  state.status.selectionSupported = Boolean(hasValidTarget && hasValidActive);
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
    rt.projectVersion += 1;
    rt.contiguousLocalSelectSeq = 0;
    rt.hardwareClockAnchor = null;
    rt.stopFeedbackContext = null;
    rt.wasActiveCaptureMode = false;
    rt.startCooldownUntil = 0;
    rt.activeLocalStartAt = 0;
    rt.prevFullRecordingObs = { bootId: '', takeId: -1, mask: 0, localStartedAt: 0, full: false };
    if (prevProjectId !== state.status.project_id) {
      rt.smartLandedSessionKey = '';
    }
  }
  if (state.status.boot_id && Number.isFinite(snapshot.mono_ms)) {
    rt.hardwareClockAnchor = { bootId: state.status.boot_id, monoMs: snapshot.mono_ms, receivedAt: frameNow };
  }
  if (state.status.phase === 'idle' && !rt.pendingStart) {
    state.pendingStartCommandId = null;
  }
  if (prevProjectId !== state.status.project_id || (prevBootId && prevBootId !== state.status.boot_id)) {
    state.editingReassignTakeId = null;
    state.editingReassignTakeIds = [];
    state.editingReassignProjectId = '';
    state.reassignSurface = 'records';
    rt.reassignReturnFocus = null;
    state.reassignDrafts.clear();
    rt.pendingTakeEdits.clear();
    rt.syncingTakeEdits.clear();
  }

  return { prevPhase, prevProjectId, prevBootId };
}
