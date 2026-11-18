import { AUDIO_CUE_PATTERNS } from './constants.mjs';
import { setTextIfChanged, setHiddenIfChanged } from './dom-utils.mjs';
import { isValidTargetCameras } from './formatters.mjs';

export function createAudioCueController({
  doc,
  win,
  el,
  state,
  rt,
  staleMs,
  monotonicNow,
  audioContextClass,
  getRecordControlState,
  currentLedgerFailure,
}) {
  let audioCtx = null;
  let audioUnavailable = false;
  let activeAudioNodes = [];
  let audioWarnTimer = null;
  let activeAudioSegment = null;
  let audioScope = {
    scopeId: '',
    baselineSet: false,
    baselineTakeId: 0,
    baselineActiveTakeId: 0,
    baselineEndedTakes: new Set(),
    takeCues: new Map(),
  };

  function getAudioContextCtor() {
    return audioContextClass ||
      win?.AudioContext ||
      win?.webkitAudioContext ||
      globalThis.AudioContext ||
      globalThis.webkitAudioContext ||
      null;
  }

  function renderSoundControls() {
    const chk = el('input-status-sound');
    if (chk && chk.checked !== Boolean(state.statusSoundEnabled)) {
      chk.checked = Boolean(state.statusSoundEnabled);
    }
    const note = el('status-sound-note');
    if (note) {
      const showUnavailable = Boolean(state.statusSoundEnabled && audioUnavailable);
      setHiddenIfChanged(note, !showUnavailable);
      setTextIfChanged(note, showUnavailable ? '声音不可用，以屏幕状态为准' : '');
    }
  }

  function stopActiveAudioCue() {
    for (const node of activeAudioNodes) {
      try { node.osc?.stop?.(); } catch {}
      try { node.osc?.disconnect?.(); } catch {}
      try { node.gain?.disconnect?.(); } catch {}
    }
    activeAudioNodes = [];
  }

  function ensureAudioContext() {
    if (rt.destroyed || !state.statusSoundEnabled) return null;
    const AudioCtor = getAudioContextCtor();
    if (!AudioCtor) {
      audioUnavailable = true;
      renderSoundControls();
      return null;
    }
    if (!audioCtx) {
      try {
        audioCtx = new AudioCtor();
        audioUnavailable = false;
      } catch {
        audioCtx = null;
        audioUnavailable = true;
        renderSoundControls();
        return null;
      }
    }
    return audioCtx;
  }

  function unlockStatusAudio() {
    if (rt.destroyed || !state.statusSoundEnabled) return false;
    const ctx = ensureAudioContext();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        Promise.resolve(ctx.resume()).catch(() => {
          if (!rt.destroyed) {
            audioUnavailable = true;
            renderSoundControls();
          }
        });
      }
      renderSoundControls();
      return true;
    } catch {
      audioUnavailable = true;
      renderSoundControls();
      return false;
    }
  }

  function playStatusCue(kind) {
    const pattern = AUDIO_CUE_PATTERNS[kind];
    if (!pattern || rt.destroyed || !state.statusSoundEnabled || doc?.visibilityState === 'hidden') return false;
    stopActiveAudioCue();
    const ctx = ensureAudioContext();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        Promise.resolve(ctx.resume()).catch(() => {
          if (!rt.destroyed) {
            audioUnavailable = true;
            renderSoundControls();
          }
        });
      }
      const startTime = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
      const toneSec = 0.12;
      const strideSec = 0.18;
      const fadeSec = 0.01;
      for (let i = 0; i < pattern.length; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = startTime + i * strideSec;
        const tEnd = t0 + toneSec;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(pattern[i], t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(0.08, t0 + fadeSec);
        gain.gain.setValueAtTime(0.08, tEnd - fadeSec);
        gain.gain.linearRampToValueAtTime(0.0001, tEnd);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(tEnd);
        activeAudioNodes.push({ osc, gain });
      }
      return true;
    } catch {
      stopActiveAudioCue();
      audioUnavailable = true;
      renderSoundControls();
      return false;
    }
  }

  function clearAudioSegmentTimer() {
    if (audioWarnTimer !== null) {
      win?.clearTimeout?.(audioWarnTimer);
      audioWarnTimer = null;
    }
    activeAudioSegment = null;
  }

  function resetAudioScope(scopeId = `${rt.connectionVersion}|${state.status.project_id || ''}|${state.status.boot_id || ''}`) {
    clearAudioSegmentTimer();
    audioScope = {
      scopeId,
      baselineSet: false,
      baselineTakeId: 0,
      baselineActiveTakeId: 0,
      baselineEndedTakes: new Set(),
      takeCues: new Map(),
    };
  }

  function getTakeCueRecord(takeId) {
    const key = `${rt.connectionVersion}|${state.status.project_id || ''}|${state.status.boot_id || ''}|${Number(takeId || 0)}`;
    let rec = audioScope.takeCues.get(key);
    if (!rec) {
      rec = { startedPlayed: false, stoppedPlayed: false, warnings: new Set() };
      audioScope.takeCues.set(key, rec);
    }
    return rec;
  }

  function fireTakeWarning(takeId, category) {
    const rec = getTakeCueRecord(takeId);
    if (rec.warnings.has(category)) return false;
    rec.warnings.add(category);
    return playStatusCue('warning');
  }

  function updateStatusCues(control = getRecordControlState()) {
    if (rt.destroyed) return;
    const scopeId = `${rt.connectionVersion}|${state.status.project_id || ''}|${state.status.boot_id || ''}`;
    if (audioScope.scopeId !== scopeId) {
      resetAudioScope(scopeId);
    }
    if (!state.connected) {
      clearAudioSegmentTimer();
      return;
    }

    const cams = Array.isArray(state.status.cameras) ? state.status.cameras : [];
    const activeTakeId = state.status.active_take_id || (rt.pendingStart ? state.status.take_id : 0) || (state.status.phase !== 'idle' ? state.status.take_id : 0) || 0;
    const activeTaking = Boolean(
      rt.pendingStart ||
      (control.mode === 'stop' && (
        control.stage === 'starting' ||
        control.stage === 'partial' ||
        control.stage === 'recording' ||
        control.stage === 'recording_stale'
      ))
    );
    const activeMask = control.activeMask;
    const validActiveParticipants = isValidTargetCameras(state.status.active_participants)
      ? state.status.active_participants
      : 0;
    const allTargetsRecording = Boolean(
      activeTaking &&
      !control.stopInFlight &&
      control.hasFreshStatus &&
      validActiveParticipants > 0 &&
      (control.observedMask & validActiveParticipants) === validActiveParticipants
    );

    if (!audioScope.baselineSet) {
      audioScope.baselineSet = true;
      audioScope.baselineTakeId = state.status.take_id || 0;
      audioScope.baselineActiveTakeId = (state.status.phase !== 'idle' || state.status.active_take_id > 0)
        ? (state.status.active_take_id || state.status.take_id || 0)
        : 0;
      if (!state.ledgerReadError && state.ledger.project_id === state.status.project_id) {
        for (const tk of state.ledger.takes) {
          if (tk.ended) audioScope.baselineEndedTakes.add(tk.take_id);
        }
      }
      if (activeTakeId > 0) {
        const rec = getTakeCueRecord(activeTakeId);
        if (allTargetsRecording) rec.startedPlayed = true;
      }
      if (!activeTaking) return;
    }

    if (activeTaking) {
      const segKey = scopeId;
      if (!activeAudioSegment || activeAudioSegment.scopeId !== segKey ||
          (activeAudioSegment.takeId > 0 && activeTakeId > 0 && activeAudioSegment.takeId !== activeTakeId)) {
        clearAudioSegmentTimer();
        activeAudioSegment = {
          scopeId: segKey,
          takeId: activeTakeId,
          startedAt: monotonicNow(),
          hadFreshActive: false,
        };
        if (win?.setTimeout) {
          const capturedSegment = activeAudioSegment;
          audioWarnTimer = win.setTimeout(() => {
            audioWarnTimer = null;
            if (!rt.destroyed && state.connected && activeAudioSegment === capturedSegment) {
              updateStatusCues();
            }
          }, 3000);
          audioWarnTimer?.unref?.();
        }
      } else if (activeAudioSegment.takeId === 0 && activeTakeId > 0) {
        activeAudioSegment.takeId = activeTakeId;
      }

      if (control.hasFreshStatus && validActiveParticipants > 0 && (control.observedMask & validActiveParticipants) !== 0 && !control.stopInFlight) {
        activeAudioSegment.hadFreshActive = true;
      }

      const trackedTakeId = activeAudioSegment.takeId || activeTakeId || 0;
      const takeCueRec = getTakeCueRecord(trackedTakeId);
      let warnedThisTick = false;
      if (allTargetsRecording) {
        if (audioWarnTimer !== null) {
          win?.clearTimeout?.(audioWarnTimer);
          audioWarnTimer = null;
        }
        if (!takeCueRec.startedPlayed) {
          takeCueRec.startedPlayed = true;
          playStatusCue('started');
        }
      } else if (
        !control.stopInFlight &&
        !takeCueRec.startedPlayed &&
        (monotonicNow() - activeAudioSegment.startedAt) >= 3000
      ) {
        warnedThisTick = fireTakeWarning(trackedTakeId, 'start_timeout_3s');
      }

      const syncLogActivelyStreaming = rt.isSyncLogStreamActive &&
        rt.lastSyncLogActivityAt > 0 &&
        (monotonicNow() - rt.lastSyncLogActivityAt) <= staleMs;
      if (!syncLogActivelyStreaming && activeAudioSegment.hadFreshActive && !control.stopInFlight && isValidTargetCameras(activeMask)) {
        const selectedLost = !control.hasFreshStatus || [0, 1].some(idx =>
          (activeMask & (1 << idx)) && (!cams[idx]?.connected || cams[idx]?.fresh === false)
        );
        if (selectedLost) {
          if (warnedThisTick) {
            takeCueRec.warnings.add('stale_during_active');
          } else {
            fireTakeWarning(trackedTakeId, 'stale_during_active');
          }
        }
      }
    } else if (control.stage !== 'stopping' && control.stage !== 'stop_pending') {
      clearAudioSegmentTimer();
    }

    if (!state.ledgerReadError && state.ledger.project_id === state.status.project_id) {
      for (const tk of state.ledger.takes) {
        if (!tk.ended || audioScope.baselineEndedTakes.has(tk.take_id)) continue;
        const cueKey = `${rt.connectionVersion}|${state.status.project_id || ''}|${state.status.boot_id || ''}|${Number(tk.take_id || 0)}`;
        const wasKnownInSession = audioScope.takeCues.has(cueKey);
        const isHistorical = tk.take_id <= audioScope.baselineTakeId &&
          tk.take_id !== audioScope.baselineActiveTakeId &&
          !wasKnownInSession;
        audioScope.baselineEndedTakes.add(tk.take_id);
        if (!isHistorical && tk.complete === false) {
          fireTakeWarning(tk.take_id, 'abnormal_end');
        }
      }
    }

    if (rt.stopFeedbackContext) {
      const ctx = rt.stopFeedbackContext;
      const ledgerFailure = currentLedgerFailure();
      const ledgerOk = !state.ledgerReadError && state.ledger.project_id === ctx.projectId && !ledgerFailure;
      const syncedTake = ledgerOk && ctx.takeId > 0
        ? state.ledger.takes.find(t => t.take_id === ctx.takeId) || null
        : null;
      const participatingMask = isValidTargetCameras(syncedTake?.participants)
        ? syncedTake.participants
        : (isValidTargetCameras(ctx.participants) ? ctx.participants : control.activeMask);
      const camsIdle = control.hasFreshStatus && isValidTargetCameras(participatingMask) && [0, 1].every(idx =>
        !(participatingMask & (1 << idx)) ||
        (cams[idx]?.connected && cams[idx]?.fresh !== false && cams[idx]?.recording === false)
      );
      const hardwareIdleConfirmed = Boolean(
        !rt.pendingStop &&
        state.status.phase === 'idle' &&
        (state.status.active_take_id || 0) === 0 &&
        camsIdle &&
        ((syncedTake?.ended && syncedTake.complete === true) ||
          (ctx.ackReceived && Boolean(ledgerFailure) && ctx.takeId > 0))
      );
      if (hardwareIdleConfirmed) {
        const cueTakeId = syncedTake?.take_id || ctx.takeId;
        audioScope.baselineEndedTakes.add(cueTakeId);
        const rec = getTakeCueRecord(cueTakeId);
        if (!rec.stoppedPlayed) {
          rec.stoppedPlayed = true;
          playStatusCue('stopped');
        }
      }
    }
  }

  function destroy() {
    stopActiveAudioCue();
    clearAudioSegmentTimer();
    try { void audioCtx?.close?.(); } catch {}
    audioCtx = null;
  }

  return {
    renderSoundControls,
    stopActiveAudioCue,
    unlockStatusAudio,
    playStatusCue,
    clearAudioSegmentTimer,
    resetAudioScope,
    updateStatusCues,
    isBaselineSet: () => audioScope.baselineSet,
    destroy,
  };
}
