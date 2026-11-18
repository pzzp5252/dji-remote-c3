import { applyStatusSnapshotToState } from '../core/app-state.mjs';
import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setAttrIfChanged,
  setClassIfChanged,
} from '../core/dom-utils.mjs';

export function createWorkbenchRenderController({
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
}) {
  function switchView(viewName, { preserveScroll = false } = {}) {
    if (viewName !== 'shoot' && viewName !== 'list' && viewName !== 'records') return;
    if (state.activeView !== viewName && !state.desktopMode) {
      const prevEl = el(`view-${state.activeView}`);
      if (prevEl) state.viewScrollTop[state.activeView] = prevEl.scrollTop || 0;
    }
    state.activeView = viewName;
    if (viewName === 'records' && !state.connected) {
      rt.offlineRecordsBrowse = true;
    } else if (viewName === 'shoot') {
      rt.offlineRecordsBrowse = false;
    }
    render();
    if (!state.desktopMode && !preserveScroll) {
      const nextEl = el(`view-${viewName}`);
      if (nextEl && Number.isFinite(state.viewScrollTop[viewName])) {
        nextEl.scrollTop = state.viewScrollTop[viewName];
        win?.scrollTo?.(0, state.viewScrollTop[viewName]);
      }
    }
  }

  function buildViewModel(
    frameNow = monotonicNow(),
    receiptStale = captureState.isReceiptStale(frameNow),
    control = captureState.getRecordControlState(receiptStale, frameNow)
  ) {
    const confirmedAction = templateLedger.currentTemplateAction();
    const templateMatches = templateLedger.templateMatchesDevice();
    const progressAvailable = templateLedger.isProgressAvailable();
    const orderedActions = templateLedger.getOrderedTemplateActions();
    const stepperHardBlocked = Boolean(
      !state.connected ||
      !templateMatches ||
      !state.status.selectionSupported ||
      control.mode === 'stop'
    );
    const actionSwitchBlocked = Boolean(stepperHardBlocked || state.pendingSelect);
    const recentWaitingSync = Boolean(
      !state.ledgerReadError &&
      state.status.project_id &&
      takeEdits.isWaitingLatestTakeSync()
    );
    return {
      nowMs: frameNow,
      receiptStale,
      control,
      connected: state.connected,
      connecting: state.connecting,
      syncingLog: state.syncingLog,
      activeView: state.activeView,
      desktopMode: state.desktopMode,
      status: state.status,
      template: state.template,
      ledger: state.ledger,
      templateMatches,
      templateMismatchMessage: templateLedger.templateMismatchMessage(),
      progressAvailable,
      confirmedAction,
      orderedActions,
      stepperHardBlocked,
      actionSwitchBlocked,
      searchQuery: state.searchQuery,
      groupFilter: state.groupFilter,
      typeFilter: state.typeFilter,
      statusFilter: state.statusFilter,
      expandedActionId: state.expandedChecklistActionId,
      shootTakesExpanded: state.shootTakesExpanded,
      shootTakesPointFilter: state.shootTakesPointFilter,
      expandedShootTakeIds: state.expandedShootTakeIds,
      recordsFilter: state.recordsFilter,
      selectedRecordTakeIds: state.selectedRecordTakeIds,
      expandedRecordTakeIds: state.expandedRecordTakeIds,
      batchOperationInFlight: rt.batchOperationInFlight,
      pendingSelect: state.pendingSelect,
      pendingStart: rt.pendingStart,
      pendingStop: rt.pendingStop,
      pendingStopStartedAt: rt.pendingStopStartedAt,
      hardwareClockAnchor: rt.hardwareClockAnchor,
      activeLocalStartAt: rt.activeLocalStartAt,
      lastStatusReceivedAt: state.lastStatusReceivedAt,
      activeDiagCam: state.activeDiagCam,
      ledgerReadError: state.ledgerReadError,
      ledgerSyncBlocked: takeEdits.isTakeEditBlockedBySync(state.status.project_id),
      localLedgerIncomplete: templateLedger.localLedgerIncomplete(),
      recentWaitingSync,
      hasTakeEditInProgress: takeEdits.hasTakeEditInProgress,
      getPendingTakeEdit: takeEdits.getPendingTakeEdit,
      isReassignLocked: takeEdits.isReassignLocked,
    };
  }

  function render({
    frameNow = monotonicNow(),
    receiptStale = captureState.isReceiptStale(frameNow),
    control: providedControl = null,
  } = {}) {
    const control = providedControl || captureState.getRecordControlState(receiptStale, frameNow);
    return dialogManager.withFrameControl(control, () => {
      templateLedger.renderLedgerStorageNotice();
      shootDetailsModal.closeStaleShootDetails(control);

      if (state.editingReassignTakeId !== null || state.editingReassignTakeIds.length > 0) {
        const targetIds = state.editingReassignTakeIds.length > 0
          ? state.editingReassignTakeIds
          : [state.editingReassignTakeId];
        const hasReadableProject = !state.ledgerReadError &&
          Boolean(state.status.project_id) &&
          state.ledger.project_id === state.status.project_id;
        const allValid = hasReadableProject && targetIds.every(id => {
          const tk = state.ledger.takes.find(t => t.take_id === id);
          return Boolean(tk?.ended && tk.template_id === state.template.template_id);
        });
        if (
          !state.connected ||
          !templateLedger.templateMatchesDevice() ||
          !allValid ||
          state.editingReassignProjectId !== state.status.project_id
        ) {
          state.editingReassignTakeId = null;
          state.editingReassignTakeIds = [];
          state.editingReassignProjectId = '';
          state.reassignSurface = 'records';
        }
      }

      if (state.selectedRecordTakeIds.size > 0 && !state.ledgerReadError && state.ledger.project_id === state.status.project_id) {
        const validIds = new Set(state.ledger.takes.map(t => t.take_id));
        for (const id of Array.from(state.selectedRecordTakeIds)) {
          if (!validIds.has(id)) state.selectedRecordTakeIds.delete(id);
        }
      }

      const desktopMode = isDesktopLayout();
      state.desktopMode = desktopMode;

      const curShootActKey = `${state.status.project_id || ''}::${state.status.action_id || ''}`;
      if (curShootActKey !== rt.lastShootActionForExpand) {
        rt.lastShootActionForExpand = curShootActKey;
        state.shootTakesExpanded = false;
        state.shootTakesPointFilter = 'all';
      }

      const templateMatches = templateLedger.templateMatchesDevice();
      if (state.connected && state.status.project_id && templateMatches) {
        rt.hasEnteredReadyWorkbench = true;
        const sessionKey = `${rt.connectionVersion}::${state.status.project_id}::${state.status.template_id}`;
        if (rt.smartLandedSessionKey !== sessionKey) {
          rt.smartLandedSessionKey = sessionKey;
          if (!desktopMode && !rt.offlineRecordsBrowse) {
            state.activeView = (state.status.action_id || control.mode === 'stop') ? 'shoot' : 'list';
          }
        }
      } else if (!state.connected) {
        rt.smartLandedSessionKey = '';
        if (!rt.wasUnexpectedDropInReady && control.mode !== 'stop' && !rt.offlineRecordsBrowse) {
          state.activeView = 'shoot';
        }
      } else {
        rt.hasEnteredReadyWorkbench = false;
        rt.wasUnexpectedDropInReady = false;
        rt.smartLandedSessionKey = '';
        if (!desktopMode && control.mode !== 'stop') {
          state.activeView = 'shoot';
        }
      }

      for (const viewKey of ['list', 'shoot', 'records']) {
        const panelEl = el(`view-${viewKey}`);
        if (panelEl) {
          setHiddenIfChanged(panelEl, desktopMode ? false : (state.activeView !== viewKey));
        }
        const navBtn = el(`nav-btn-${viewKey}`);
        if (navBtn) {
          const isActive = state.activeView === viewKey;
          setClassIfChanged(navBtn, 'is-active', isActive);
          setAttrIfChanged(navBtn, 'aria-pressed', isActive ? 'true' : 'false');
        }
      }
      const bottomNavEl = el('bottom-view-nav');
      if (bottomNavEl) setHiddenIfChanged(bottomNavEl, desktopMode);

      const isProjectEmpty = state.status.project_id === '' && (state.status.take_id ?? 0) === 0 && state.status.phase === 'idle';
      const showStopOverride = control.mode === 'stop';
      const keepReadyOnUnexpectedDrop = Boolean(
        !state.connected &&
        rt.wasUnexpectedDropInReady &&
        state.status.project_id &&
        templateMatches
      );
      const showS1 = !state.connected && !showStopOverride && !keepReadyOnUnexpectedDrop;
      const showS2 = state.connected && isProjectEmpty && !showStopOverride;
      const showS2b = state.connected && !isProjectEmpty && !templateMatches && !showStopOverride;
      const showS3 = !showS1 && !showS2 && !showS2b;

      setHiddenIfChanged(el('shoot-stage-connect'), !showS1);
      setHiddenIfChanged(el('shoot-stage-init'), !showS2);
      setHiddenIfChanged(el('shoot-stage-mismatch'), !showS2b);
      setHiddenIfChanged(el('shoot-stage-ready'), !showS3);
      setHiddenIfChanged(el('usb-reset-notice'), isProjectEmpty);

      const confirmedAction = templateLedger.currentTemplateAction();
      settingsStage.render({ showS1, showS2, showS2b, confirmedAction, templateMatches });
      pointSheetModal.render(confirmedAction, control);

      const vm = buildViewModel(frameNow, receiptStale, control);
      boardView.render(vm);
      const obsText = shootView.render(vm);
      recordsView.render(vm);

      dialogManager.relocateGlobalRecordStrip(control);
      const globalStrip = el('global-record-strip');
      const globalRecordText = el('global-record-text');
      const btnGlobalStop = el('btn-global-stop');
      if (globalStrip) {
        if (!globalStrip.hidden && globalRecordText) {
          setTextIfChanged(globalRecordText, obsText || '');
        }
        if (btnGlobalStop) setDisabledIfChanged(btnGlobalStop, !control.canStop);
      }

      reassignModal.render(control);
      audioCues.renderSoundControls();
      audioCues.updateStatusCues(control);
    });
  }

  function renderStalenessTick() {
    const frameNow = monotonicNow();
    const receiptStale = captureState.isReceiptStale(frameNow);
    const control = captureState.getRecordControlState(receiptStale, frameNow);
    return dialogManager.withFrameControl(control, () => {
      feedback.syncCaptureFeedback(control);
      const vm = buildViewModel(frameNow, receiptStale, control);
      const obsText = shootView.tick(vm);
      dialogManager.relocateGlobalRecordStrip(control);
      const globalStrip = el('global-record-strip');
      const globalRecordText = el('global-record-text');
      const btnGlobalStop = el('btn-global-stop');
      if (globalStrip) {
        if (!globalStrip.hidden && globalRecordText) {
          setTextIfChanged(globalRecordText, obsText || '');
        }
        if (btnGlobalStop) setDisabledIfChanged(btnGlobalStop, !control.canStop);
      }
      audioCues.updateStatusCues(control);
    });
  }

  function applyStatusSnapshot(snapshot) {
    if (rt.destroyed || !snapshot || typeof snapshot !== 'object') return;
    const frameNow = monotonicNow();
    const { prevPhase, prevProjectId } = applyStatusSnapshotToState({ state, rt, snapshot, frameNow });
    if (state.status.phase === 'recording' && !rt.pendingStop && !rt.pendingStart?.cancelRequested) {
      void wakeLock.acquireWakeLock();
    }
    if (prevProjectId !== state.status.project_id || state.ledger.project_id !== state.status.project_id) {
      templateLedger.refreshLocalLedger(state.status.project_id);
    }
    captureState.syncCaptureTransitionState(frameNow);
    const shouldAutoSync = Boolean(
      state.status.project_id && (
        (prevPhase !== 'recording' && state.status.phase === 'recording') ||
        ((prevPhase === 'recording' || prevPhase === 'stopping' || prevPhase === 'closing') && state.status.phase === 'idle')
      )
    );
    if (shouldAutoSync) {
      void bleSession.syncCurrentProject(state.status.project_id, { silent: true, skipInitialRender: true });
    }
    // Single-call control snapshot for this frame shared across feedback & all views
    const receiptStale = false;
    const control = captureState.getRecordControlState(receiptStale, frameNow);
    feedback.syncCaptureFeedback(control);
    render({ frameNow, receiptStale, control });
  }

  return {
    switchView,
    buildViewModel,
    render,
    renderStalenessTick,
    applyStatusSnapshot,
  };
}
