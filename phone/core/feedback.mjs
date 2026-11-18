import { CAPTURE_FEEDBACK_CODES, ERROR_REASONS } from './constants.mjs';
import { setTextIfChanged, setHiddenIfChanged } from './dom-utils.mjs';
import { isValidTargetCameras } from './formatters.mjs';

export function createFeedbackController({ el, win, state, rt, onRender }) {
  const bannerEl = el('status-banner');
  const bannerTextEl = el('status-banner-text');
  const bannerCodeEl = el('status-banner-code');
  const btnDismiss = el('btn-dismiss-feedback');

  let feedbackTimer = null;
  let feedbackDismissed = false;
  let feedbackCode = '';
  let feedbackVersion = 0;

  function currentLedgerFailure() {
    return state.ledgerReadError || (state.ledgerSyncError?.code !== 'sync_pending' ? state.ledgerSyncError : null);
  }

  function renderFeedbackVisibility() {
    if (!bannerEl) return;
    const duplicate = bannerEl.dataset.tone !== 'error' &&
      Boolean(currentLedgerFailure()) &&
      ['ledger_sync_failed', 'ledger_not_updated', 'ledger_unavailable'].includes(feedbackCode);
    const hidden = feedbackDismissed || bannerEl.dataset.tone === 'idle' || duplicate;
    setHiddenIfChanged(bannerEl, hidden);
    if (bannerEl.parentElement) setHiddenIfChanged(bannerEl.parentElement, hidden);
  }

  const onDismissClick = () => {
    feedbackDismissed = true;
    if (feedbackTimer !== null) win?.clearTimeout(feedbackTimer);
    feedbackTimer = null;
    renderFeedbackVisibility();
  };

  function mount() {
    btnDismiss?.addEventListener('click', onDismissClick);
  }

  function destroy() {
    btnDismiss?.removeEventListener('click', onDismissClick);
    if (feedbackTimer !== null) win?.clearTimeout(feedbackTimer);
    feedbackTimer = null;
    feedbackVersion += 1;
  }

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
    if (bannerEl.parentElement) {
      bannerEl.parentElement.dataset.bannerKind = (tone === 'warn' || tone === 'error') ? 'alert' : 'transient';
    }
    bannerEl.setAttribute('role', isError ? 'alert' : 'status');
    setTextIfChanged(bannerTextEl, message);
    setTextIfChanged(bannerCodeEl, errCode);
    setTextIfChanged(el('status-banner-detail'), errDetail);
    const details = el('status-banner-details');
    if (details) {
      const showDetails = Boolean(isError && (errCode || errDetail));
      setHiddenIfChanged(details, !showDetails);
      if (!showDetails) {
        details.open = false;
      }
    }
    if (isError && errCode) state.lastErrorCode = errCode;
    renderFeedbackVisibility();
    if (tone === 'ok') {
      feedbackTimer = win?.setTimeout(() => {
        if (rt.destroyed || version !== feedbackVersion) return;
        feedbackTimer = null;
        feedbackDismissed = true;
        renderFeedbackVisibility();
      }, 2000) ?? null;
    }
  }

  function handleError(contextLabel, error) {
    const code = error?.code || error?.reply?.error || error?.name || 'unknown_error';
    const friendly = ERROR_REASONS[code] || error?.message || '请稍后重试。';
    setBanner(`${contextLabel}失败：${friendly}`, {
      tone: 'error',
      code: String(code),
      detail: error?.message && error.message !== friendly ? error.message : '',
    });
    onRender();
  }

  function clearCaptureFeedback(allowedCodes = CAPTURE_FEEDBACK_CODES) {
    if (!bannerEl || !allowedCodes.has(feedbackCode)) return;
    if (feedbackTimer !== null) win?.clearTimeout(feedbackTimer);
    feedbackTimer = null;
    feedbackCode = '';
    feedbackDismissed = true;
    bannerEl.dataset.tone = 'idle';
    bannerEl.dataset.errorCode = '';
    renderFeedbackVisibility();
  }

  function syncCaptureFeedback(control) {
    if (!rt.pendingStart && (feedbackCode === 'START' || feedbackCode === 'START_ACK')) {
      const hasObservedTargetCam = (control.observedMask & control.activeMask) !== 0;
      if (control.stage !== 'starting' || hasObservedTargetCam) {
        clearCaptureFeedback(new Set(['START', 'START_ACK']));
      }
    }

    if (!rt.stopFeedbackContext) return;
    const ctx = rt.stopFeedbackContext;
    if (
      rt.destroyed ||
      !state.connected ||
      state.status.project_id !== ctx.projectId ||
      state.status.boot_id !== ctx.bootId ||
      rt.pendingStart
    ) {
      rt.stopFeedbackContext = null;
      clearCaptureFeedback(new Set(['STOP', 'STOP_WAIT']));
      return;
    }
    if (ctx.settled) return;

    const ledgerMatches = !state.ledgerReadError && state.ledger.project_id === ctx.projectId;
    const syncedTake = ledgerMatches && ctx.takeId > 0
      ? state.ledger.takes.find(t => t.take_id === ctx.takeId) || null
      : null;
    const participatingMask = isValidTargetCameras(syncedTake?.participants)
      ? syncedTake.participants
      : (isValidTargetCameras(ctx.participants) ? ctx.participants : control.activeMask);
    const cams = Array.isArray(state.status.cameras) ? state.status.cameras : [];
    let camsFreshIdle = false;
    if (ctx.takeId <= 0) {
      camsFreshIdle = Boolean(
        control.hasFreshStatus &&
        control.mode === 'start' &&
        !cams.some(c => c?.connected && (c?.fresh === false || c?.recording === true))
      );
    } else if (control.hasFreshStatus && isValidTargetCameras(participatingMask)) {
      camsFreshIdle = true;
      for (let i = 0; i < 2; i++) {
        if (!(participatingMask & (1 << i))) continue;
        const cam = cams[i];
        if (!cam?.connected || cam?.fresh === false || cam?.recording !== false) {
          camsFreshIdle = false;
          break;
        }
      }
    }

    const takeIdMatched = ctx.takeId <= 0 || state.status.take_id >= ctx.takeId;
    const isIdleConfirmed =
      !rt.pendingStop &&
      state.status.phase === 'idle' &&
      (state.status.active_take_id || 0) === 0 &&
      takeIdMatched;
    const ledgerFailure = currentLedgerFailure();
    const canShowCaptureBanner = () => bannerEl?.dataset.tone !== 'error' &&
      (CAPTURE_FEEDBACK_CODES.has(feedbackCode) || feedbackCode === 'SYNC_OK' || feedbackDismissed || bannerEl?.dataset.tone === 'idle');

    if (isIdleConfirmed && syncedTake?.ended && syncedTake.complete === false) {
      ctx.settled = true;
      clearCaptureFeedback(new Set(['STOP', 'STOP_WAIT']));
      if (canShowCaptureBanner()) {
        setBanner(
          camsFreshIdle
            ? '已停止录像，但本条拍摄有异常，请检查场记记录'
            : `#${ctx.takeId || '?'} 拍摄有异常，相机现况未知（请直接核对相机屏幕）`,
          { tone: 'warn', code: 'STOP_ABNORMAL' }
        );
      }
      return;
    }

    if (isIdleConfirmed && camsFreshIdle) {
      if (ctx.takeId <= 0) {
        ctx.settled = true;
        clearCaptureFeedback(new Set(['STOP', 'STOP_WAIT']));
        if (canShowCaptureBanner()) {
          setBanner('相机已确认停止录像', { tone: 'ok', code: 'STOP_OK' });
        }
        return;
      }
      if (control.mode !== 'start') {
        clearCaptureFeedback(new Set(['STOP', 'STOP_WAIT']));
        return;
      }
      if (syncedTake?.ended && syncedTake.complete === true && !ledgerFailure) {
        ctx.settled = true;
        if (canShowCaptureBanner()) {
          setBanner('相机已确认停录，本条已记录到场记', { tone: 'ok', code: 'STOP_OK' });
        } else {
          clearCaptureFeedback(new Set(['STOP', 'STOP_WAIT']));
        }
        return;
      }
      if (ledgerFailure) {
        if (state.ledgerReadError || state.ledgerSyncError?.code !== 'sync_incomplete') {
          ctx.settled = true;
          clearCaptureFeedback(new Set(['STOP', 'STOP_WAIT']));
          if (canShowCaptureBanner()) {
            setBanner('相机已确认停录，遥控器已保存本条（手机副本暂停更新）', { tone: 'ok', code: 'STOP_OK' });
          }
          return;
        }
        clearCaptureFeedback(new Set(['STOP', 'STOP_WAIT']));
        return;
      }
      if (ctx.phaseShown !== 'wait_ledger') {
        ctx.phaseShown = 'wait_ledger';
        if (canShowCaptureBanner()) {
          setBanner('相机已确认停录，场记待同步', { tone: 'busy', code: 'STOP_WAIT' });
        }
      }
      return;
    }

    if (!rt.pendingStop && ctx.ackReceived && ctx.phaseShown !== 'wait_cams') {
      ctx.phaseShown = 'wait_cams';
      if (canShowCaptureBanner()) {
        setBanner('停止请求已收到，正在等待相机确认停录…', { tone: 'busy', code: 'STOP_WAIT' });
      }
    }
  }

  return {
    mount,
    destroy,
    currentLedgerFailure,
    renderFeedbackVisibility,
    setBanner,
    handleError,
    clearCaptureFeedback,
    syncCaptureFeedback,
    getBannerTone: () => bannerEl?.dataset.tone || 'idle',
    getFeedbackCode: () => feedbackCode,
  };
}
