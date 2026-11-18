// Browser-native ESM mobile workbench controller for DJI Osmo Action 6 Dual-Camera Field Controller.
// Zero external dependencies; reuses DjiBleClient from ./ble-client.mjs.

import { DjiBleClient } from './ble-client.mjs';
import { SOUND_CACHE_KEY, STALE_STATUS_MS } from './core/constants.mjs';
import { isValidTargetCameras } from './core/formatters.mjs';
import { isTakeLocallyAcked, setTakeLocallyAcked } from './core/ledger.mjs';
import { createMockBleClient, createMemoryStorage } from './core/mock-client.mjs';
import { getAppShellMarkup } from './core/shell-template.mjs';
import {
  createInitialAppState,
  createInitialRuntimeState,
} from './core/app-state.mjs';
import { createWakeLockController } from './core/wake-lock.mjs';
import { createAudioCueController } from './core/audio-cues.mjs';
import { createFeedbackController } from './core/feedback.mjs';
import { createCaptureStateController } from './core/capture-state.mjs';
import { createDialogManager } from './core/dialog-manager.mjs';
import { createBackupController } from './core/backup-export.mjs';
import { createTemplateLedgerController } from './controllers/template-ledger.mjs';
import { createBleSessionController } from './controllers/ble-session.mjs';
import { createCaptureActionsController } from './controllers/capture-actions.mjs';
import { createTakeEditsController } from './controllers/take-edits.mjs';
import { createWorkbenchRenderController } from './controllers/workbench-render.mjs';
import { createSettingsStageController } from './modals/settings-stage-view.mjs';
import { createReassignModalController } from './modals/reassign-modal.mjs';
import { createPointSheetModalController } from './modals/point-sheet-modal.mjs';
import { createAddPointModalController } from './modals/add-point-modal.mjs';
import { createShootDetailsModalController } from './modals/shoot-details-modal.mjs';
import { createBoardView } from './views/board-view.mjs';
import { createShootView } from './views/shoot-view.mjs';
import { createRecordsView } from './views/records-view.mjs';

export { DjiBleClient, BleClientError, UUIDS, KINDS } from './ble-client.mjs';
export { BUILTIN_PRESETS, BUILTIN_PRESETS_BY_ID, getBuiltinPreset, getBuiltinPreset as loadPresetTemplate } from './presets/index.mjs';
export {
  TEMPLATE_CACHE_KEY, THEME_CACHE_KEY, SOUND_CACHE_KEY, STALE_STATUS_MS,
  DEFAULT_TEMPLATE, LED_LABELS, TARGET_CAMERA_LABELS,
} from './core/constants.mjs';
export {
  describeLed, formatBytes, createCommandId, isValidAsciiId, isValidTargetCameras,
  isValidActiveParticipants, describeTargetCameras, computeCameraAdmission,
  computeNextTargetMask, isDemoTemplateId, formatTakeCameraSummary, deduceNextPointId,
  isValidPointId, deriveRoomKey, normalizeTemplate, formatHumanAreaName, formatHumanSeq,
  formatRoomAndHood, formatHumanPointName, extractActionDiffParts, computeActionDiffSnippet,
  summarizeActionProgress, matchesActionQuery, filterActions,
} from './core/formatters.mjs';
export {
  ledgerPrefix, ledgerEventKey, ledgerCursorKey, localAckPrefix, localAckKey, localAckListKey,
  listLocalOperatorAcks, isTakeLocallyAcked, setTakeLocallyAcked, hasExistingLocalProject,
  readCursorValue, loadCursor, persistEventToStorage, foldEventsToTakes, loadProjectLedger,
  buildLedgerBucketIndex, getTakesForAction, summarizeGroupQueue, suggestDefaultProjectId,
  escapeCsvCell, exportLedgerCsv,
} from './core/ledger.mjs';
export { createMockBleClient, createMemoryStorage, getAppShellMarkup };

// === Main Application Factory ===

export function createApp({
  root = typeof document !== 'undefined' ? document.getElementById('app-root') : null,
  client: injectedClient = null,
  storage: injectedStorage = null,
  fetchImpl: injectedFetch = null,
  now = () => Date.now(),
  monotonicNow: injectedMonotonicNow = null,
  audioContextClass = null,
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
  const el = id => root.querySelector(`#${id}`);
  const monotonicNow = typeof injectedMonotonicNow === 'function'
    ? injectedMonotonicNow
    : (() => (win?.performance?.now?.() ?? Date.now()) + 1);

  function isDesktopLayout() {
    if (!win) return false;
    if (typeof win.matchMedia === 'function') {
      const mql = win.matchMedia('(min-width: 960px) and (min-height: 560px)');
      if (mql && typeof mql.matches === 'boolean') return mql.matches;
    }
    return Number.isFinite(win.innerWidth) && Number.isFinite(win.innerHeight) &&
      win.innerWidth >= 960 && win.innerHeight >= 560;
  }

  if (!root.querySelector('[data-bento-grid="true"]')) {
    root.innerHTML = getAppShellMarkup();
  }

  const searchParams = typeof globalThis.location?.search === 'string'
    ? new URLSearchParams(globalThis.location.search)
    : null;
  const isMockUrl = searchParams?.get('mock') === '1';
  const mockPresetParam = isMockUrl ? (searchParams.get('preset') || '').trim() : '';
  const mockEmptyParam = isMockUrl && searchParams.get('empty') === '1';

  const client = injectedClient || (isMockUrl
    ? createMockBleClient(
        mockEmptyParam
          ? { projectId: '', templateId: '', actionId: '', heartbeatMs: 1000 }
          : mockPresetParam
            ? { projectId: 'GMP_DEMO_01', templateId: mockPresetParam, actionId: 'S01', heartbeatMs: 1000 }
            : { heartbeatMs: 1000 }
      )
    : new DjiBleClient());
  const isMockMode = isMockUrl || Boolean(client?.mockState);
  const storage = injectedStorage || (
    isMockUrl
      ? createMemoryStorage()
      : (typeof localStorage !== 'undefined' ? localStorage : createMemoryStorage())
  );

  let initialSoundEnabled = true;
  try {
    initialSoundEnabled = storage.getItem(SOUND_CACHE_KEY) !== 'off';
  } catch {
    initialSoundEnabled = true;
  }

  const state = createInitialAppState({
    connected: Boolean(client.connected),
    initialSoundEnabled,
  });
  const rt = createInitialRuntimeState();

  // === Wire Modular Controllers ===
  let workbenchRender;
  const render = opts => workbenchRender.render(opts);
  const switchView = (viewName, opts) => workbenchRender.switchView(viewName, opts);
  const applyStatusSnapshot = snapshot => workbenchRender.applyStatusSnapshot(snapshot);

  const feedback = createFeedbackController({
    el, win, state, rt,
    onRender: () => render(),
  });

  const wakeLock = createWakeLockController({
    doc, win, el, rt,
    isConnected: () => state.connected,
  });

  let templateLedger;
  let captureState;
  let audioCues;
  let dialogManager;
  let bleSession;
  let captureActions;
  let takeEdits;
  let backup;
  let reassignModal;
  let pointSheetModal;
  let addPointModal;
  let shootDetailsModal;
  let settingsStage;

  templateLedger = createTemplateLedgerController({
    el, state, rt, storage, fetchFn, isMockUrl, mockEmptyParam, mockPresetParam,
    currentLedgerFailure: feedback.currentLedgerFailure,
    setBanner: feedback.setBanner,
    handleError: feedback.handleError,
    renderFeedbackVisibility: feedback.renderFeedbackVisibility,
    onTemplateImported: () => reassignModal?.clearCaches(),
    onRender: () => render(),
  });

  captureState = createCaptureStateController({
    win, state, rt, staleMs, monotonicNow,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    onCooldownEnd: () => render(),
  });

  audioCues = createAudioCueController({
    doc, win, el, state, rt, staleMs, monotonicNow, audioContextClass,
    getRecordControlState: captureState.getRecordControlState,
    currentLedgerFailure: feedback.currentLedgerFailure,
  });

  dialogManager = createDialogManager({
    root, doc, win, el, state, rt,
    getRecordControlState: captureState.getRecordControlState,
    onDialogClosed: dlg => {
      if (dlg.id === 'modal-shoot-details') rt.shootDetailsContext = null;
      if (dlg.id === 'modal-reassign') {
        state.editingReassignTakeId = null;
        state.editingReassignTakeIds = [];
        state.editingReassignProjectId = '';
        state.reassignSurface = 'records';
      }
    },
  });

  captureActions = createCaptureActionsController({
    state, rt, client, now, monotonicNow,
    rejectTemplateMismatch: templateLedger.rejectTemplateMismatch,
    isReceiptStale: captureState.isReceiptStale,
    getRecordControlState: captureState.getRecordControlState,
    syncCaptureTransitionState: captureState.syncCaptureTransitionState,
    syncCaptureFeedback: feedback.syncCaptureFeedback,
    syncCurrentProject: (pid, opts) => bleSession.syncCurrentProject(pid, opts),
    setBanner: feedback.setBanner,
    handleError: feedback.handleError,
    getBannerTone: feedback.getBannerTone,
    unlockStatusAudio: audioCues.unlockStatusAudio,
    acquireWakeLock: wakeLock.acquireWakeLock,
    playKeepAliveVideo: wakeLock.playKeepAliveVideo,
    onRender: opts => render(opts),
  });

  bleSession = createBleSessionController({
    el, win, state, rt, client, storage, now, monotonicNow,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    rejectTemplateMismatch: templateLedger.rejectTemplateMismatch,
    refreshLocalLedger: templateLedger.refreshLocalLedger,
    getDefaultPointId: templateLedger.getDefaultPointId,
    getStepperCandidates: templateLedger.getStepperCandidates,
    isReceiptStale: captureState.isReceiptStale,
    getRecordControlState: captureState.getRecordControlState,
    clearStartCooldownTimer: captureState.clearStartCooldownTimer,
    syncCaptureTransitionState: captureState.syncCaptureTransitionState,
    syncCaptureFeedback: feedback.syncCaptureFeedback,
    setBanner: feedback.setBanner,
    handleError: feedback.handleError,
    getBannerTone: feedback.getBannerTone,
    getFeedbackCode: feedback.getFeedbackCode,
    acquireWakeLock: wakeLock.acquireWakeLock,
    releaseWakeLock: wakeLock.releaseWakeLock,
    unlockStatusAudio: audioCues.unlockStatusAudio,
    playStatusCue: audioCues.playStatusCue,
    clearAudioSegmentTimer: audioCues.clearAudioSegmentTimer,
    resetAudioScope: audioCues.resetAudioScope,
    isAudioBaselineSet: audioCues.isBaselineSet,
    clearPendingCaptureRequests: captureActions.clearPendingCaptureRequests,
    onRender: opts => render(opts),
  });

  takeEdits = createTakeEditsController({
    doc, el, state, rt, client,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    rejectTemplateMismatch: templateLedger.rejectTemplateMismatch,
    rejectIfRecordingActive: bleSession.rejectIfRecordingActive,
    refreshLocalLedger: templateLedger.refreshLocalLedger,
    syncCurrentProject: bleSession.syncCurrentProject,
    getRecordControlState: captureState.getRecordControlState,
    openDialog: dialogManager.openDialog,
    closeDialog: dialogManager.closeDialog,
    setBanner: feedback.setBanner,
    handleError: feedback.handleError,
    onRender: () => render(),
  });

  backup = createBackupController({
    doc, state, storage, now, clipboard, share, download,
    refreshLocalLedger: templateLedger.refreshLocalLedger,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    localLedgerIncomplete: templateLedger.localLedgerIncomplete,
    setBanner: feedback.setBanner,
    handleError: feedback.handleError,
    renderLedgerStorageNotice: templateLedger.renderLedgerStorageNotice,
    render: () => render(),
  });

  reassignModal = createReassignModalController({
    doc, el, state, rt,
    getRecordControlState: captureState.getRecordControlState,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    isTakeTemplateEditable: takeEdits.isTakeTemplateEditable,
    isTakeEditBlockedBySync: takeEdits.isTakeEditBlockedBySync,
    hasTakeEditInProgress: takeEdits.hasTakeEditInProgress,
    getPendingTakeEdit: takeEdits.getPendingTakeEdit,
    isReassignLocked: takeEdits.isReassignLocked,
    closeDialog: dialogManager.closeDialog,
    reassignTake: takeEdits.reassignTake,
    reassignTakes: takeEdits.reassignTakes,
  });

  const detailIdentityMatches = context => !rt.destroyed &&
    context.projectId === state.status.project_id &&
    context.templateId === state.template.template_id &&
    context.deviceTemplateId === state.status.template_id;

  addPointModal = createAddPointModalController({
    doc, el, state, rt, storage,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    rejectTemplateMismatch: templateLedger.rejectTemplateMismatch,
    currentTemplateAction: templateLedger.currentTemplateAction,
    detailIdentityMatches,
    openDialog: dialogManager.openDialog,
    closeDialog: dialogManager.closeDialog,
    setDialogReturnFocus: dialogManager.setDialogReturnFocus,
    isDialogClosing: dialogManager.isDialogClosing,
    setBanner: feedback.setBanner,
    selectAction: bleSession.selectAction,
    onRender: () => render(),
    onShowShootDetails: opts => shootDetailsModal.showShootDetails(opts),
  });

  shootDetailsModal = createShootDetailsModalController({
    doc, el, state, rt,
    currentTemplateAction: templateLedger.currentTemplateAction,
    currentLedgerFailure: feedback.currentLedgerFailure,
    detailIdentityMatches,
    getScreenAwakeDetail: wakeLock.getScreenAwakeDetail,
    openDialog: dialogManager.openDialog,
    closeDialog: dialogManager.closeDialog,
    isDialogClosing: dialogManager.isDialogClosing,
    onShowPointDialog: opts => addPointModal.showPointDialog(opts),
  });

  pointSheetModal = createPointSheetModalController({
    doc, win, el, state, rt,
    isProgressAvailable: templateLedger.isProgressAvailable,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    openDialog: dialogManager.openDialog,
    closeDialog: dialogManager.closeDialog,
    selectAction: bleSession.selectAction,
    showPointDialog: addPointModal.showPointDialog,
    render: () => render(),
  });

  settingsStage = createSettingsStageController({
    root, doc, win, el, state, rt, storage, now, isMockMode,
    templateMatchesDevice: templateLedger.templateMatchesDevice,
    templateMismatchMessage: templateLedger.templateMismatchMessage,
    openDialog: dialogManager.openDialog,
    closeDialog: dialogManager.closeDialog,
    render: () => render(),
    connectFromGesture: () => bleSession.connectFromGesture(applyStatusSnapshot),
    disconnect: bleSession.disconnect,
    syncCurrentProject: bleSession.syncCurrentProject,
    initProject: bleSession.initProject,
    importTemplateObject: templateLedger.importTemplateObject,
    handleError: feedback.handleError,
    startRecording: captureActions.startRecording,
    stopRecording: captureActions.stopRecording,
    selectAction: bleSession.selectAction,
    selectTargetCameras: bleSession.selectTargetCameras,
    getDefaultPointId: templateLedger.getDefaultPointId,
    getOrderedTemplateActions: templateLedger.getOrderedTemplateActions,
    switchView,
    acquireWakeLock: wakeLock.acquireWakeLock,
    unlockStatusAudio: audioCues.unlockStatusAudio,
    playStatusCue: audioCues.playStatusCue,
    renderSoundControls: audioCues.renderSoundControls,
    stopActiveAudioCue: audioCues.stopActiveAudioCue,
    copyBackup: backup.copyBackup,
    shareBackup: backup.shareBackup,
    downloadBackup: backup.downloadBackup,
    downloadCsv: backup.downloadCsv,
  });

  // === Mount Views ===
  const boardView = createBoardView({
    root, doc, storage,
    callbacks: {
      onSearchChange(query) { state.searchQuery = query; render(); },
      onGroupFilter(group) { state.groupFilter = group; render(); },
      onTypeFilter(typeFilter) { state.typeFilter = typeFilter; render(); },
      onStatusFilter(statusFilter) { state.statusFilter = statusFilter; render(); },
      onToggleExpand(actionId) {
        state.expandedChecklistActionId = state.expandedChecklistActionId === actionId ? null : actionId;
        render();
      },
      async onSelectAction(actionId) {
        const actionObj = templateLedger.currentTemplateAction(actionId) ||
          templateLedger.getOrderedTemplateActions().find(a => a.action_id === actionId) || null;
        const defaultPoint = actionObj
          ? templateLedger.getDefaultPointId(actionObj)
          : (state.status.action_id === actionId ? (state.status.point_id || '') : '');
        const confirmedTarget = isValidTargetCameras(state.status.target_cameras)
          ? state.status.target_cameras
          : 3;
        const reply = await bleSession.selectAction(actionId, defaultPoint, confirmedTarget);
        if (reply && !rt.destroyed && !state.desktopMode && state.activeView === 'list') {
          switchView('shoot');
        }
      },
    },
  });

  const shootView = createShootView({
    root, doc, win, storage,
    callbacks: {
      onSelectAction(actionId) {
        const actionObj = templateLedger.currentTemplateAction(actionId);
        const defaultPoint = actionObj ? templateLedger.getDefaultPointId(actionObj) : '';
        void bleSession.selectAction(actionId, defaultPoint, state.status.target_cameras);
      },
      onToggleTakesExpand() { state.shootTakesExpanded = !state.shootTakesExpanded; render(); },
      onTakesPointFilter(filterVal) {
        state.shootTakesPointFilter = filterVal === 'current_point' ? 'current_point' : 'all';
        render();
      },
      onToggleShootTakeExpand(takeId) {
        if (state.expandedShootTakeIds.has(takeId)) state.expandedShootTakeIds.delete(takeId);
        else state.expandedShootTakeIds.add(takeId);
        render();
      },
      onToggleLocalAck(takeId) {
        const projectId = state.status.project_id;
        if (state.ledgerReadError || !projectId || projectId !== state.ledger.project_id) return;
        const nextAcked = !isTakeLocallyAcked(storage, projectId, takeId);
        setTakeLocallyAcked(storage, projectId, takeId, nextAcked);
        templateLedger.refreshLocalLedger(projectId);
        render();
      },
      onToggleDiscard(takeId) {
        const projectId = state.status.project_id;
        if (!state.connected || state.ledgerReadError || !projectId || projectId !== state.ledger.project_id) return;
        if (takeEdits.hasTakeEditInProgress(projectId, takeId)) return;
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId);
        if (!currentTake) return;
        void takeEdits.markDiscard(takeId, !currentTake.discarded, projectId);
      },
      onOpenReassign(takeId, surface, returnFocus) {
        const projectId = state.status.project_id;
        if (!projectId) return;
        takeEdits.openTakeReassign(takeId, projectId, { surface, returnFocus });
      },
      onOpenJumper(returnFocus) {
        const dlg = el('modal-action-jumper');
        if (!dlg) return;
        dialogManager.openDialog(dlg, { returnFocus });
        render();
        el('input-jumper-search')?.focus?.({ preventScroll: true });
      },
      onCloseJumperAndOpenBoard() {
        void dialogManager.closeDialog(el('modal-action-jumper'), { immediate: true });
        if (!rt.destroyed && !state.desktopMode) switchView('list');
      },
      onCloseJumper() {
        void dialogManager.closeDialog(el('modal-action-jumper'));
      },
    },
  });

  const recordsView = createRecordsView({
    root, doc, storage,
    callbacks: {
      onSyncProject() { void bleSession.syncCurrentProject(state.status.project_id); },
      onRecordsFilter(filterKey) { state.recordsFilter = filterKey; render(); },
      onToggleRecordSelect(takeId, checked) {
        if (checked) state.selectedRecordTakeIds.add(takeId);
        else state.selectedRecordTakeIds.delete(takeId);
        render();
      },
      onSelectAllFiltered(takeIds) {
        for (const id of takeIds) state.selectedRecordTakeIds.add(id);
        render();
      },
      onClearSelection() { state.selectedRecordTakeIds.clear(); render(); },
      onToggleRecordExpand(takeId) {
        if (state.expandedRecordTakeIds.has(takeId)) state.expandedRecordTakeIds.delete(takeId);
        else state.expandedRecordTakeIds.add(takeId);
        render();
      },
      onToggleLocalAck(takeId) {
        const projectId = state.status.project_id;
        if (state.ledgerReadError || !projectId || projectId !== state.ledger.project_id) return;
        const nextAcked = !isTakeLocallyAcked(storage, projectId, takeId);
        setTakeLocallyAcked(storage, projectId, takeId, nextAcked);
        templateLedger.refreshLocalLedger(projectId);
        render();
      },
      onToggleDiscard(takeId) {
        const projectId = state.status.project_id;
        if (!state.connected || state.ledgerReadError || !projectId || projectId !== state.ledger.project_id) return;
        if (takeEdits.hasTakeEditInProgress(projectId, takeId)) return;
        const currentTake = state.ledger.takes.find(t => t.take_id === takeId);
        if (!currentTake) return;
        void takeEdits.markDiscard(takeId, !currentTake.discarded, projectId);
      },
      onOpenReassign(takeId, surface, returnFocus) {
        const projectId = state.status.project_id;
        if (!projectId) return;
        takeEdits.openTakeReassign(takeId, projectId, { surface, returnFocus });
      },
      onBatchDiscard(takeIds, discard) {
        void takeEdits.batchMarkDiscard(takeIds, discard, state.status.project_id);
      },
      onOpenBatchReassign(takeIds, returnFocus) {
        takeEdits.openBatchTakeReassign(takeIds, state.status.project_id, { returnFocus });
      },
    },
  });

  workbenchRender = createWorkbenchRenderController({
    el,
    win,
    state,
    rt,
    monotonicNow,
    isDesktopLayout,
    templateLedger,
    captureState,
    takeEdits,
    feedback,
    wakeLock,
    bleSession,
    audioCues,
    dialogManager,
    settingsStage,
    pointSheetModal,
    shootDetailsModal,
    reassignModal,
    boardView,
    shootView,
    recordsView,
  });

  const onVisibilityChange = () => {
    rt.hardwareClockAnchor = null;
    const frameNow = monotonicNow();
    const control = captureState.getRecordControlState(true, frameNow);
    shootView.tick(workbenchRender.buildViewModel(frameNow, true, control));
    if (doc?.visibilityState === 'hidden') {
      audioCues.stopActiveAudioCue();
      return;
    }
    if (doc?.visibilityState === 'visible' && state.connected) {
      void wakeLock.acquireWakeLock();
      const connection = rt.connectionVersion;
      const projBeforeStatus = rt.projectVersion;
      void client.getStatus().then(snapshot => {
        if (rt.destroyed || !state.connected || connection !== rt.connectionVersion) return;
        if (projBeforeStatus !== rt.projectVersion) return;
        applyStatusSnapshot(snapshot);
        const targetProj = snapshot?.project_id || state.status.project_id;
        if (targetProj) {
          void bleSession.syncCurrentProject(targetProj, { silent: true });
        }
      }).catch(error => {
        if (!rt.destroyed) feedback.handleError('更新相机状态', error);
        if (!rt.destroyed && state.connected && connection === rt.connectionVersion && state.status.project_id) {
          void bleSession.syncCurrentProject(state.status.project_id, { silent: true });
        }
      });
    }
  };

  const onWindowResize = () => {
    dialogManager.updateSheetViewport();
    render();
    pointSheetModal.schedulePointReveal();
  };

  boardView.mount();
  shootView.mount();
  recordsView.mount();
  feedback.mount();
  dialogManager.mount();
  reassignModal.mount();
  pointSheetModal.mount();
  addPointModal.mount();
  shootDetailsModal.mount();
  settingsStage.mount();
  bleSession.bindClientEvents(applyStatusSnapshot);

  doc?.addEventListener?.('visibilitychange', onVisibilityChange);
  win?.addEventListener?.('resize', onWindowResize);

  const staleTimer = setInterval(() => {
    if (state.connected && state.lastStatusReceivedAt > 0) {
      workbenchRender.renderStalenessTick();
    }
  }, 1000);
  staleTimer?.unref?.();

  wakeLock.setScreenAwakeNotice('idle', '未启用', '未申请保持亮屏');
  render();
  const readyPromise = templateLedger.loadInitialTemplate();

  return {
    root,
    client,
    storage,
    state,
    ready: readyPromise,
    render,
    renderStalenessTick: workbenchRender.renderStalenessTick,
    getRecordControlState: captureState.getRecordControlState,
    setBanner: feedback.setBanner,
    switchView,
    applyStatusSnapshot,
    refreshLocalLedger: templateLedger.refreshLocalLedger,
    syncCurrentProject: bleSession.syncCurrentProject,
    initProject: bleSession.initProject,
    selectAction: bleSession.selectAction,
    selectTargetCameras: bleSession.selectTargetCameras,
    stepAction: bleSession.stepAction,
    startRecording: captureActions.startRecording,
    stopRecording: captureActions.stopRecording,
    markDiscard: takeEdits.markDiscard,
    batchMarkDiscard: takeEdits.batchMarkDiscard,
    openTakeReassign: takeEdits.openTakeReassign,
    openBatchTakeReassign: takeEdits.openBatchTakeReassign,
    reassignTake: takeEdits.reassignTake,
    reassignTakes: takeEdits.reassignTakes,
    getDefaultPointId: templateLedger.getDefaultPointId,
    getStepperCandidates: templateLedger.getStepperCandidates,
    getNextUnshotSelection: templateLedger.getNextUnshotSelection,
    importTemplateObject: templateLedger.importTemplateObject,
    buildBackupPayload: backup.buildBackupPayload,
    copyBackup: backup.copyBackup,
    shareBackup: backup.shareBackup,
    downloadBackup: backup.downloadBackup,
    downloadCsv: backup.downloadCsv,
    openDialog: dialogManager.openDialog,
    closeDialog: dialogManager.closeDialog,
    acquireWakeLock: wakeLock.acquireWakeLock,
    releaseWakeLock: wakeLock.releaseWakeLock,
    unlockStatusAudio: audioCues.unlockStatusAudio,
    playStatusCue: audioCues.playStatusCue,
    updateStatusCues: audioCues.updateStatusCues,
    disconnect: bleSession.disconnect,
    destroy() {
      rt.destroyed = true;
      captureActions.clearPendingCaptureRequests();
      rt.pendingTakeEdits.clear();
      rt.syncingTakeEdits.clear();
      rt.batchOperationInFlight = null;
      captureState.clearStartCooldownTimer();
      rt.contiguousLocalSelectSeq = 0;
      state.pendingSelect = null;
      rt.reassignReturnFocus = null;
      audioCues.destroy();
      feedback.destroy();
      pointSheetModal.destroy();
      reassignModal.destroy();
      addPointModal.destroy();
      shootDetailsModal.destroy();
      settingsStage.destroy();
      rt.hardwareClockAnchor = null;
      dialogManager.destroy();
      boardView.destroy();
      shootView.destroy();
      recordsView.destroy();
      clearInterval(staleTimer);
      win?.removeEventListener?.('resize', onWindowResize);
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
      void wakeLock.releaseWakeLock();
    },
  };
}

if (typeof document !== 'undefined' && document.getElementById('app-root') && !globalThis.__DJI_SKIP_AUTO_BOOT__) {
  globalThis.__DJI_APP__ = createApp({ root: document.getElementById('app-root') });
}
