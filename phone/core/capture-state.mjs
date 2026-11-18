import {
  isValidTargetCameras,
  computeCameraAdmission,
} from './formatters.mjs';

export function createCaptureStateController({
  win,
  state,
  rt,
  staleMs,
  monotonicNow,
  templateMatchesDevice,
  onCooldownEnd,
}) {
  function clearStartCooldownTimer() {
    if (rt.startCooldownTimer !== null) {
      win?.clearTimeout?.(rt.startCooldownTimer);
      rt.startCooldownTimer = null;
    }
  }

  function scheduleStartCooldownRender() {
    clearStartCooldownTimer();
    const remaining = rt.startCooldownUntil - monotonicNow();
    if (remaining > 0 && win?.setTimeout) {
      rt.startCooldownTimer = win.setTimeout(() => {
        rt.startCooldownTimer = null;
        if (!rt.destroyed) onCooldownEnd();
      }, remaining + 1);
      rt.startCooldownTimer?.unref?.();
    }
  }

  function hasUnackedTakeEdits(projectId = state.status.project_id) {
    if (!projectId) return false;
    for (const edit of rt.pendingTakeEdits.values()) {
      if (
        edit.connection === rt.connectionVersion &&
        edit.project === rt.projectVersion &&
        edit.projectId === projectId
      ) {
        return true;
      }
    }
    return false;
  }

  function syncCaptureTransitionState(nowMs = monotonicNow()) {
    if (!state.connected) {
      rt.wasActiveCaptureMode = false;
      rt.activeLocalStartAt = 0;
      rt.prevFullRecordingObs = { bootId: '', takeId: -1, mask: 0, localStartedAt: 0, full: false };
      return;
    }
    const cams = Array.isArray(state.status.cameras) ? state.status.cameras : [];
    const anyCamRec = cams.some(c => Boolean(c?.connected && c?.fresh !== false && c?.recording === true));
    const phase = state.status.phase || 'idle';
    const activeTakeId = state.status.active_take_id || 0;
    const isHardwareActive = phase !== 'idle' || activeTakeId > 0 || anyCamRec;
    if (isHardwareActive) {
      rt.wasActiveCaptureMode = true;
      if (!rt.activeLocalStartAt) rt.activeLocalStartAt = nowMs;
    } else if (!rt.pendingStart && !rt.pendingStop) {
      rt.activeLocalStartAt = 0;
      rt.prevFullRecordingObs = { bootId: '', takeId: -1, mask: 0, localStartedAt: 0, full: false };
      if (rt.wasActiveCaptureMode) {
        rt.wasActiveCaptureMode = false;
        rt.startCooldownUntil = nowMs + 1500;
        scheduleStartCooldownRender();
      }
    }
  }

  function isReceiptStale(nowMs = monotonicNow()) {
    if (!state.connected || state.lastStatusReceivedAt <= 0) return false;
    return (nowMs - state.lastStatusReceivedAt) > staleMs;
  }

  function getRecordControlState(receiptStale = isReceiptStale(), nowMs = monotonicNow()) {
    const phase = state.status.phase || 'idle';
    const cams = Array.isArray(state.status.cameras) ? state.status.cameras : [];
    const hasFreshStatus = Boolean(state.connected && state.lastStatusReceivedAt > 0 && !receiptStale);
    const selectionSupported = state.status.selectionSupported !== false;
    const targetCameras = state.status.target_cameras;
    const effectiveTarget = isValidTargetCameras(targetCameras) ? targetCameras : 3;
    const admission = computeCameraAdmission(cams, effectiveTarget);
    const anyConnectedRecording = admission.anyConnectedRecording;
    const observedMask = hasFreshStatus
      ? ((cams[0]?.connected && cams[0]?.fresh !== false && cams[0]?.recording === true ? 1 : 0) |
         (cams[1]?.connected && cams[1]?.fresh !== false && cams[1]?.recording === true ? 2 : 0))
      : 0;
    const activeTakeId = state.status.active_take_id || 0;
    const isTakeActive = phase !== 'idle' || Boolean(rt.pendingStart) || activeTakeId > 0;
    const hasValidActiveMask = isValidTargetCameras(state.status.active_participants);
    const activeMask = isTakeActive
      ? (hasValidActiveMask ? state.status.active_participants : effectiveTarget)
      : effectiveTarget;
    const curBootId = state.status.boot_id || '';
    if (!state.connected || !isTakeActive) {
      rt.prevFullRecordingObs = { bootId: '', takeId: -1, mask: 0, localStartedAt: 0, full: false };
      if (!isTakeActive) rt.activeLocalStartAt = 0;
    } else {
      if (!rt.activeLocalStartAt) rt.activeLocalStartAt = nowMs;
      if (
        rt.prevFullRecordingObs.bootId !== curBootId ||
        (activeTakeId > 0 && rt.prevFullRecordingObs.takeId > 0 && rt.prevFullRecordingObs.takeId !== activeTakeId) ||
        rt.prevFullRecordingObs.mask !== activeMask
      ) {
        rt.prevFullRecordingObs = {
          bootId: curBootId,
          takeId: activeTakeId,
          mask: activeMask,
          localStartedAt: rt.activeLocalStartAt,
          full: false,
        };
      } else if (rt.prevFullRecordingObs.takeId === 0 && activeTakeId > 0) {
        rt.prevFullRecordingObs.takeId = activeTakeId;
      }
      if (hasFreshStatus) {
        if (observedMask !== 0 && (observedMask & activeMask) === activeMask) {
          rt.prevFullRecordingObs.full = true;
        } else {
          rt.prevFullRecordingObs.full = false;
        }
      }
    }
    const mode = (phase === 'idle' && !rt.pendingStart && activeTakeId <= 0 && !anyConnectedRecording)
      ? 'start'
      : 'stop';
    const selectedReady = Boolean(
      hasFreshStatus &&
      selectionSupported &&
      isValidTargetCameras(targetCameras) &&
      admission.targetReady
    );
    const writableOk = state.status.writable !== false && !state.status.storage_error;
    const stopInFlight = Boolean(rt.pendingStop || rt.pendingStart?.cancelRequested);
    const inCooldown = Boolean(state.connected && mode === 'start' && nowMs < rt.startCooldownUntil);
    const unackedEditBlocked = hasUnackedTakeEdits();
    const canStart = Boolean(
      state.connected &&
      hasFreshStatus &&
      selectionSupported &&
      Boolean(state.status.project_id) &&
      Boolean(state.status.action_id) &&
      templateMatchesDevice() &&
      !state.pendingSelect &&
      !state.pendingInit &&
      !rt.pendingStart &&
      !rt.pendingStop &&
      !unackedEditBlocked &&
      !inCooldown &&
      mode === 'start' &&
      selectedReady &&
      writableOk
    );
    const canStop = Boolean(state.connected && mode === 'stop' && !stopInFlight);
    const prevWasFullRec = Boolean(
      rt.prevFullRecordingObs.full &&
      rt.prevFullRecordingObs.bootId === curBootId &&
      (rt.prevFullRecordingObs.takeId === activeTakeId || activeTakeId === 0) &&
      rt.prevFullRecordingObs.mask === activeMask
    );

    let stage;
    if (!state.connected) {
      stage = 'disconnected';
    } else if (stopInFlight) {
      stage = 'stop_pending';
    } else if (phase === 'stopping' || phase === 'closing') {
      stage = 'stopping';
    } else if (isTakeActive && hasFreshStatus && observedMask !== 0 && (observedMask & activeMask) === activeMask) {
      stage = 'recording';
    } else if (isTakeActive && hasFreshStatus && (observedMask & activeMask) !== 0) {
      stage = 'partial';
    } else if (isTakeActive && receiptStale && prevWasFullRec) {
      stage = 'recording_stale';
    } else if (isTakeActive) {
      stage = 'starting';
    } else if (anyConnectedRecording) {
      stage = 'safety_stop';
    } else if (inCooldown) {
      stage = 'settled_cooldown';
    } else if (canStart) {
      stage = 'ready';
    } else {
      stage = 'blocked';
    }

    return Object.freeze({
      mode,
      stage,
      activeMask,
      observedMask,
      hasFreshStatus,
      selectedReady,
      canStart,
      canStop,
      stopInFlight,
      inCooldown,
      unackedEditBlocked,
    });
  }

  return {
    clearStartCooldownTimer,
    scheduleStartCooldownRender,
    hasUnackedTakeEdits,
    syncCaptureTransitionState,
    isReceiptStale,
    getRecordControlState,
  };
}
