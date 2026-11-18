import { BleClientError } from '../ble-client.mjs';
import {
  createCommandId,
  isValidTargetCameras,
  isValidActiveParticipants,
} from '../core/formatters.mjs';

export function createCaptureActionsController({
  state,
  rt,
  client,
  now,
  monotonicNow,
  rejectTemplateMismatch,
  isReceiptStale,
  getRecordControlState,
  syncCaptureTransitionState,
  syncCaptureFeedback,
  syncCurrentProject,
  setBanner,
  handleError,
  getBannerTone,
  unlockStatusAudio,
  acquireWakeLock,
  playKeepAliveVideo,
  onRender,
}) {
  function clearPendingCaptureRequests() {
    rt.pendingStop = null;
    rt.pendingStopStartedAt = 0;
    if (rt.pendingStart) {
      const startCtx = rt.pendingStart;
      rt.pendingStart = null;
      state.pendingStartCommandId = null;
      startCtx.finish?.();
    } else {
      state.pendingStartCommandId = null;
    }
    rt.stopFeedbackContext = null;
  }

  async function startRecording() {
    if (rejectTemplateMismatch()) return null;
    if (rt.pendingStart || rt.pendingStop || state.pendingSelect || state.pendingInit) return null;
    const control = getRecordControlState();
    if (!state.connected) {
      handleError('开始录像', new BleClientError('not_connected', 'Not connected'));
      return null;
    }
    if (control.mode === 'stop') {
      setBanner('开始录像失败：请先停止录像。', {
        tone: 'error',
        code: 'recording_active',
      });
      onRender();
      return null;
    }
    if (control.inCooldown || control.unackedEditBlocked) {
      return null;
    }
    if (state.status.selectionSupported === false || !isValidTargetCameras(state.status.target_cameras)) {
      setBanner('开始录像失败：当前遥控器固件暂不支持相机选择，请先升级遥控器固件。', {
        tone: 'error',
        code: 'unsupported_firmware',
      });
      onRender();
      return null;
    }
    if (!state.status.project_id) {
      handleError('开始录像', new BleClientError('project_uninitialized', 'Project uninitialized'));
      return null;
    }
    if (!state.status.action_id) {
      handleError('开始录像', new BleClientError('no_action_selected', 'No action selected'));
      return null;
    }
    if (state.status.writable === false || state.status.storage_error) {
      const code = state.status.storage_error || 'storage_full';
      setBanner(
        `开始录像失败：遥控器存储不可写${state.status.storage_error ? `（${state.status.storage_error}）` : ''}，无法开始新录像。`,
        { tone: 'error', code }
      );
      onRender();
      return null;
    }
    if (!control.hasFreshStatus) {
      setBanner('开始录像失败：遥控器状态已过期，请等待最新状态后再试。', {
        tone: 'error',
        code: 'stale_status',
      });
      onRender();
      return null;
    }
    if (!control.selectedReady || !control.canStart) {
      setBanner('开始录像失败：所选相机尚未就绪，或有相机正在录像。', {
        tone: 'error',
        code: 'start_rejected_or_storage_full',
      });
      onRender();
      return null;
    }
    rt.stopFeedbackContext = null;
    unlockStatusAudio();
    void acquireWakeLock();
    void playKeepAliveVideo();
    const commandId = createCommandId(now());
    const abortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
    const context = {
      projectId: state.status.project_id,
      targetCameras: state.status.target_cameras,
      connection: rt.connectionVersion,
      statusVersion: rt.statusVersion,
      cancelRequested: false,
      cancelRequestedAt: 0,
      abortCtrl,
    };
    context.finished = new Promise(resolve => { context.finish = resolve; });
    rt.pendingStart = context;
    state.pendingStartCommandId = commandId;
    setBanner('正在通知相机开始录像…', { tone: 'busy', code: 'START' });
    onRender();
    try {
      const reply = await client.request(
        {
          cmd: 'START',
          project_id: context.projectId,
          command_id: commandId,
          target_cameras: context.targetCameras,
        },
        abortCtrl ? { signal: abortCtrl.signal } : undefined
      );
      if (rt.connectionVersion !== context.connection || state.status.project_id !== context.projectId) return null;
      if (reply?.ok !== true) {
        throw new BleClientError(reply?.error || 'request_rejected', 'START rejected', { reply });
      }
      const newerStatus = rt.statusVersion !== context.statusVersion &&
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
      rt.pendingStart = null;
      state.pendingStartCommandId = null;
      syncCaptureTransitionState();
      void syncCurrentProject(context.projectId, { silent: true, skipInitialRender: true });
      const postNow = monotonicNow();
      const postStale = isReceiptStale(postNow);
      const postControl = getRecordControlState(postStale, postNow);
      if (context.cancelRequested) {
        if (!newerStatus || state.status.phase !== 'idle') await stopRecording();
        else syncCaptureFeedback(postControl);
      } else if (
        !newerStatus &&
        postControl.stage === 'starting' &&
        (postControl.observedMask & postControl.activeMask) === 0
      ) {
        setBanner('开始请求已收到，正在等待相机确认录像', {
          tone: 'warn',
          code: 'START_ACK',
        });
      } else {
        syncCaptureFeedback(postControl);
      }
      return reply;
    } catch (error) {
      if (rt.connectionVersion === context.connection && state.status.project_id === context.projectId) {
        if (error?.code === 'cancelled') {
          setBanner('已取消本次开始请求', { tone: 'ok', code: 'START_CANCELLED' });
        } else {
          handleError('开始录像', error);
        }
      }
      return null;
    } finally {
      if (rt.pendingStart === context) {
        rt.pendingStart = null;
        state.pendingStartCommandId = null;
      }
      syncCaptureTransitionState();
      context.finish();
      if (!rt.destroyed) onRender();
    }
  }

  async function stopRecording() {
    unlockStatusAudio();
    if (rt.pendingStart) {
      rt.pendingStart.cancelRequested = true;
      if (!rt.pendingStart.cancelRequestedAt) rt.pendingStart.cancelRequestedAt = monotonicNow();
      rt.pendingStart.abortCtrl?.abort?.();
      setBanner('已请求停止，正在等待遥控器确认本条编号…', { tone: 'busy', code: 'STOP' });
      onRender();
      return rt.pendingStart.finished;
    }
    if (rt.pendingStop) return rt.pendingStop;
    const preControl = getRecordControlState();
    const targetTakeId = state.status.active_take_id || state.status.take_id;
    const ctxTakeId = state.status.active_take_id > 0
      ? state.status.active_take_id
      : (preControl.stage === 'safety_stop' ? 0 : targetTakeId);
    const projectId = state.status.project_id;
    const bootId = state.status.boot_id || '';
    const connection = rt.connectionVersion;
    const project = rt.projectVersion;
    const version = rt.statusVersion;
    const stopCtx = {
      projectId,
      bootId,
      takeId: ctxTakeId,
      participants: preControl.activeMask,
      ackReceived: false,
      settled: false,
      phaseShown: 'sent',
    };
    rt.stopFeedbackContext = stopCtx;
    rt.pendingStopStartedAt = monotonicNow();
    if (getBannerTone() !== 'error') {
      setBanner('正在通知相机停止录像…', { tone: 'busy', code: 'STOP' });
    }
    const operation = Promise.resolve().then(async () => {
      try {
        const reply = await client.request(
          {
            cmd: 'STOP',
            project_id: projectId,
            take_id: targetTakeId,
          },
          { priority: 'safety' }
        );
        if (rt.connectionVersion !== connection || rt.projectVersion !== project || state.status.project_id !== projectId) return null;
        if (reply?.ok !== true) {
          throw new BleClientError(reply?.error || 'request_rejected', 'STOP rejected', { reply });
        }
        state.pendingStartCommandId = null;
        const newerStatus = rt.statusVersion !== version &&
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
        if (rt.stopFeedbackContext === stopCtx && !stopCtx.settled) {
          stopCtx.ackReceived = true;
          if (Number.isSafeInteger(reply.take_id) && reply.take_id > 0 && ctxTakeId > 0) {
            stopCtx.takeId = Math.max(stopCtx.takeId, reply.take_id);
          }
          if (isValidTargetCameras(reply.active_participants)) {
            stopCtx.participants = reply.active_participants;
          }
        }
        void syncCurrentProject(projectId, { silent: true, skipInitialRender: true });
        return reply;
      } catch (error) {
        if (rt.stopFeedbackContext === stopCtx) {
          rt.stopFeedbackContext = null;
        }
        if (rt.connectionVersion === connection && rt.projectVersion === project && state.status.project_id === projectId) {
          handleError('停止录像', error);
        }
        return null;
      } finally {
        if (rt.pendingStop === operation) {
          rt.pendingStop = null;
          rt.pendingStopStartedAt = 0;
        }
        if (!rt.destroyed) {
          syncCaptureTransitionState();
          const frameNow = monotonicNow();
          const receiptStale = isReceiptStale(frameNow);
          const control = getRecordControlState(receiptStale, frameNow);
          syncCaptureFeedback(control);
          onRender({ frameNow, receiptStale, control });
        }
      }
    });
    rt.pendingStop = operation;
    onRender();
    return operation;
  }

  return {
    clearPendingCaptureRequests,
    startRecording,
    stopRecording,
  };
}
