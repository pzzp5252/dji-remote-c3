import { BleClientError } from '../ble-client.mjs';
import {
  isValidAsciiId,
  isValidTargetCameras,
} from '../core/formatters.mjs';
import {
  loadCursor,
  persistEventToStorage,
  hasExistingLocalProject,
} from '../core/ledger.mjs';

export function createBleSessionController({
  el,
  win,
  state,
  rt,
  client,
  storage,
  now,
  monotonicNow,
  templateMatchesDevice,
  rejectTemplateMismatch,
  refreshLocalLedger,
  getDefaultPointId,
  getStepperCandidates,
  isReceiptStale,
  getRecordControlState,
  clearStartCooldownTimer,
  syncCaptureTransitionState,
  syncCaptureFeedback,
  setBanner,
  handleError,
  getBannerTone,
  getFeedbackCode,
  acquireWakeLock,
  releaseWakeLock,
  unlockStatusAudio,
  playStatusCue,
  clearAudioSegmentTimer,
  resetAudioScope,
  isAudioBaselineSet,
  clearPendingCaptureRequests,
  onRender,
}) {
  let activeSyncPromise = null;
  let hasPendingSyncRequest = false;
  let nextSyncProject = '';

  function syncCurrentProject(explicitProjectId = state.status.project_id, { silent = false, skipInitialRender = false } = {}) {
    if (rt.destroyed) return Promise.resolve(null);
    const projectId = explicitProjectId || state.status.project_id;
    if (!projectId) {
      refreshLocalLedger('');
      if (!skipInitialRender) onRender();
      return Promise.resolve(null);
    }
    nextSyncProject = projectId;
    if (activeSyncPromise) {
      hasPendingSyncRequest = true;
      return activeSyncPromise;
    }
    state.syncingLog = true;
    if (!skipInitialRender) onRender();

    activeSyncPromise = Promise.resolve().then(async () => {
      let finalResult = null;
      let firstPass = true;
      try {
        do {
          if (!firstPass) hasPendingSyncRequest = false;
          firstPass = false;
          const currentProj = nextSyncProject;
          const connection = rt.connectionVersion;
          const project = rt.projectVersion;
          const isCurrent = () => !rt.destroyed && state.connected &&
            connection === rt.connectionVersion && project === rt.projectVersion &&
            state.status.project_id === currentProj;
          try {
            const afterSeq = loadCursor(storage, currentProj);
            if (!silent && isCurrent()) setBanner('正在同步拍摄记录…', { tone: 'busy', code: 'GET_LOG' });
            let replicaError = null;
            rt.isSyncLogStreamActive = true;
            rt.lastSyncLogActivityAt = monotonicNow();
            let result;
            try {
              result = await client.syncLog(afterSeq, currentProj, async (event, context) => {
                rt.lastSyncLogActivityAt = monotonicNow();
                if (event?.project_id !== currentProj) throw new BleClientError('invalid_log_event', 'Unexpected project in log stream');
                if (replicaError) return;
                try {
                  await persistEventToStorage(storage, event, context);
                } catch (err) {
                  replicaError = err;
                }
              });
            } finally {
              rt.isSyncLogStreamActive = false;
            }
            finalResult = result;
            if (isCurrent()) {
              const recovering = Boolean(state.ledgerReadError || (state.ledgerSyncError && state.ledgerSyncError.code !== 'sync_pending'));
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
              if (replicaError) {
                finalResult = null;
                const errCode = replicaError?.code || replicaError?.name || 'replica_write_failed';
                state.ledgerSyncError = { project_id: currentProj, code: errCode, message: replicaError?.message || '' };
                if (errCode === 'cached_event_conflict') {
                  setBanner('手机本地副本与遥控器主账记录不一致，停止覆盖。主账安全保存在遥控器中，请导出/更换设备或改用新项目编号。', {
                    tone: 'error', code: 'cached_event_conflict', detail: replicaError?.message || '',
                  });
                } else {
                  setBanner('手机本地存储空间不足或无法写入，本地副本暂停更新；遥控器主账不受影响，录像与停止仍可正常控制。', {
                    tone: 'error', code: 'ledger_sync_failed', detail: replicaError?.message || '',
                  });
                }
              } else if (state.ledger.after_seq < state.status.event_seq) {
                state.ledgerSyncError = { project_id: currentProj, code: 'sync_incomplete', message: '手机记录尚未同步完整' };
                finalResult = null;
                setBanner('手机拍摄记录尚未同步完整，请稍后同步拍摄记录', { tone: 'warn', code: 'ledger_not_updated' });
              } else {
                state.ledgerSyncError = null;
              }
              if (!state.ledgerSyncError && !state.templateSaveError && (!silent || recovering)) {
                setBanner(`拍摄记录已同步，共 ${state.ledger.takes.length} 条`, { tone: 'ok', code: 'SYNC_OK' });
              }
            }
          } catch (error) {
            finalResult = null;
            if (isCurrent()) {
              refreshLocalLedger(currentProj);
              state.ledgerSyncError = { project_id: currentProj, code: error?.code || error?.name || 'sync_failed', message: error?.message || '' };
              setBanner('手机拍摄记录同步失败；设备记录可能已修改，本地副本尚未同步完整', {
                tone: 'error', code: 'ledger_sync_failed', detail: error?.message || '',
              });
            }
          }
        } while (hasPendingSyncRequest && state.connected && !rt.destroyed);
        return finalResult;
      } finally {
        state.syncingLog = false;
        activeSyncPromise = null;
        hasPendingSyncRequest = false;
        if (!rt.destroyed) {
          const frameNow = monotonicNow();
          const receiptStale = isReceiptStale(frameNow);
          const control = getRecordControlState(receiptStale, frameNow);
          syncCaptureFeedback(control);
          onRender({ frameNow, receiptStale, control });
        }
      }
    });
    return activeSyncPromise;
  }

  async function runConnectSequence(connectPromise, applyStatusSnapshot) {
    rt.manualDisconnecting = false;
    rt.offlineRecordsBrowse = false;
    resetAudioScope();
    state.connecting = true;
    setBanner('正在连接遥控器…', { tone: 'busy', code: 'CONNECT' });
    onRender();
    try {
      await connectPromise;
      rt.wasUnexpectedDropInReady = false;
      state.connected = true;
      state.connecting = false;
      void acquireWakeLock();
      setBanner('已连接，正在查看相机状态…', { tone: 'busy', code: 'GET_STATUS' });
      onRender();

      const status = await client.getStatus();
      applyStatusSnapshot(status);

      if (getRecordControlState().mode !== 'stop') {
        setBanner('正在校准遥控器时间…', { tone: 'busy', code: 'TIME_SYNC' });
        await client.syncTime(now());
        state.status.time_synced = true;
        onRender();
      }

      if (status?.project_id) {
        await syncCurrentProject(status.project_id);
      } else {
        setBanner('已连接。请先新建拍摄项目。', { tone: 'ok', code: 'CONNECTED' });
      }
      onRender();
      return status;
    } catch (error) {
      state.connecting = false;
      state.connected = Boolean(client.connected);
      handleError('连接遥控器', error);
      return null;
    }
  }

  function connectFromGesture(applyStatusSnapshot) {
    if (rt.destroyed || state.connected || state.connecting) return;
    unlockStatusAudio();
    let connectPromise;
    try {
      connectPromise = client.connect();
    } catch (syncErr) {
      connectPromise = Promise.reject(syncErr);
    }
    void runConnectSequence(connectPromise, applyStatusSnapshot);
  }

  function disconnect() {
    try {
      rt.manualDisconnecting = true;
      rt.hasEnteredReadyWorkbench = false;
      rt.wasUnexpectedDropInReady = false;
      rt.smartLandedSessionKey = '';
      rt.offlineRecordsBrowse = false;
      rt.connectionVersion += 1;
      clearAudioSegmentTimer();
      client.disconnect();
      void releaseWakeLock();
      rt.hardwareClockAnchor = null;
      clearPendingCaptureRequests();
      rt.pendingTakeEdits.clear();
      rt.syncingTakeEdits.clear();
      rt.batchOperationInFlight = null;
      rt.contiguousLocalSelectSeq = 0;
      state.pendingSelect = null;
      state.connected = false;
      state.connecting = false;
      setBanner('已断开遥控器', { tone: 'idle', code: 'DISCONNECTED' });
      onRender();
    } catch (error) {
      handleError('断开连接', error);
    }
  }

  function rejectIfRecordingActive(actionLabel) {
    if (getRecordControlState().mode !== 'stop') return false;
    setBanner(`${actionLabel}失败：正在录像中，请先停止录像。`, {
      tone: 'error',
      code: 'recording_active',
    });
    onRender();
    return true;
  }

  async function initProject(projectIdInput, templateIdInput) {
    if (rejectIfRecordingActive('新建项目')) return null;
    if (state.pendingInit) return null;
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
    if (hasExistingLocalProject(storage, projectId)) {
      setBanner(`新建项目失败：手机本地已存在项目“${projectId}”的历史副本，禁止复用旧项目编号以免冲突，请改用新编号。`, {
        tone: 'error',
        code: 'project_id_exists_locally',
      });
      onRender();
      return null;
    }
    if (state.status.project_id !== '' || (state.status.take_id ?? 0) > 0 || state.status.phase !== 'idle') {
      setBanner('新建项目失败：已有项目不能在手机上清空，请先在电脑上备份并清空', {
        tone: 'error',
        code: 'project_not_empty',
      });
      return null;
    }

    state.pendingInit = true;
    setBanner('正在新建拍摄项目…', { tone: 'busy' });
    onRender();
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
      rt.smartLandedSessionKey = '';
      refreshLocalLedger(state.status.project_id);
      setBanner(`项目 ${state.status.project_id} 已创建`, { tone: 'ok' });
      onRender();
      return reply;
    } catch (error) {
      handleError('新建项目', error);
      return null;
    } finally {
      state.pendingInit = false;
      if (!rt.destroyed) onRender();
    }
  }

  async function selectAction(actionId, pointId = '', targetCameras = state.status.target_cameras, { toggledSlotBit = 0 } = {}) {
    if (rejectTemplateMismatch()) return null;
    if (getRecordControlState().mode === 'stop') {
      setBanner('保存拍摄项失败：请先停止录像。拍完的记录可通过“修改拍摄项”更正。', {
        tone: 'error',
        code: 'recording_active',
      });
      onRender();
      return null;
    }
    if (state.connected && state.lastStatusReceivedAt > 0 && state.status.selectionSupported === false) {
      setBanner('保存拍摄项失败：当前遥控器固件暂不支持相机选择，请先升级遥控器固件。', {
        tone: 'error',
        code: 'unsupported_firmware',
      });
      onRender();
      return null;
    }
    if (state.pendingSelect) return null;
    if (!actionId) return null;

    const requestedTarget = targetCameras !== undefined && targetCameras !== null
      ? targetCameras
      : (isValidTargetCameras(state.status.target_cameras) ? state.status.target_cameras : 3);
    if (!isValidTargetCameras(requestedTarget)) {
      setBanner('保存拍摄项失败：请选择有效的拍摄相机（双机、只拍 A 机或只拍 B 机）。', {
        tone: 'error',
        code: 'invalid_request',
      });
      onRender();
      return null;
    }

    const pending = {
      action_id: actionId,
      point_id: pointId ?? '',
      target_cameras: requestedTarget,
      toggledSlotBit,
    };
    const connection = rt.connectionVersion;
    const project = rt.projectVersion;
    const projectId = state.status.project_id;
    const templateId = state.template.template_id;
    state.pendingSelect = pending;
    const slowSelectBannerTimer = win?.setTimeout
      ? win.setTimeout(() => {
          if (!rt.destroyed && state.pendingSelect === pending) {
            setBanner('正在切换拍摄项，请稍候', { tone: 'busy' });
          }
        }, 280)
      : null;
    onRender();

    try {
      const reply = await client.request({
        cmd: 'SELECT_ACTION',
        project_id: projectId,
        action_id: actionId,
        point_id: pointId ?? '',
        target_cameras: requestedTarget,
      });
      if (
        rt.destroyed ||
        connection !== rt.connectionVersion ||
        project !== rt.projectVersion ||
        projectId !== state.status.project_id ||
        templateId !== state.template.template_id ||
        !templateMatchesDevice()
      ) {
        return null;
      }
      if (!reply || reply.ok !== true) {
        throw new BleClientError(reply?.error || 'request_rejected', 'SELECT_ACTION rejected', { reply });
      }
      if (
        !isValidTargetCameras(reply.target_cameras) ||
        reply.target_cameras !== requestedTarget ||
        (reply.project_id !== undefined && reply.project_id !== projectId) ||
        (reply.action_id !== undefined && reply.action_id !== actionId) ||
        (reply.point_id !== undefined && String(reply.point_id) !== String(pointId ?? ''))
      ) {
        throw new BleClientError('invalid_select_ack', 'SELECT_ACTION reply did not match request', { reply });
      }
      if (state.pendingSelect === pending) state.pendingSelect = null;
      state.status.action_id = reply.action_id ?? actionId;
      state.status.point_id = reply.point_id ?? (pointId ?? '');
      state.status.target_cameras = reply.target_cameras;
      if (Number.isSafeInteger(reply.event_seq)) {
        if (reply.event_seq === Math.max(state.ledger.after_seq, rt.contiguousLocalSelectSeq) + 1) {
          rt.contiguousLocalSelectSeq = reply.event_seq;
        }
        state.status.event_seq = reply.event_seq;
      }
      if (Number.isSafeInteger(reply.take_id)) state.status.take_id = reply.take_id;
      if (
        getBannerTone() === 'busy' ||
        ['invalid_select_ack', 'no_action_selected', 'invalid_request', 'recording_active', 'unsupported_firmware'].includes(getFeedbackCode())
      ) {
        setBanner('', { tone: 'idle' });
      }
      onRender();
      return reply;
    } catch (error) {
      if (state.pendingSelect === pending) state.pendingSelect = null;
      if (
        !rt.destroyed &&
        connection === rt.connectionVersion &&
        project === rt.projectVersion &&
        projectId === state.status.project_id
      ) {
        handleError('切换拍摄项', error);
      } else {
        onRender();
      }
      return null;
    } finally {
      if (slowSelectBannerTimer !== null) win?.clearTimeout?.(slowSelectBannerTimer);
      if (state.pendingSelect === pending) {
        state.pendingSelect = null;
        if (!rt.destroyed) onRender();
      }
    }
  }

  async function selectTargetCameras(targetCameras, { toggledSlotBit = 0 } = {}) {
    if (getRecordControlState().mode === 'stop') {
      setBanner('切换相机失败：请先停止录像。本条参与相机已锁定。', {
        tone: 'error',
        code: 'recording_active',
      });
      onRender();
      return null;
    }
    if (state.connected && state.lastStatusReceivedAt > 0 && state.status.selectionSupported === false) {
      setBanner('切换相机失败：当前遥控器固件暂不支持相机选择，请先升级遥控器固件。', {
        tone: 'error',
        code: 'unsupported_firmware',
      });
      onRender();
      return null;
    }
    if (state.pendingSelect) return null;
    if (!state.status.action_id) {
      setBanner('切换相机失败：请先选择当前拍摄项。', {
        tone: 'error',
        code: 'no_action_selected',
      });
      onRender();
      return null;
    }
    if (!isValidTargetCameras(targetCameras)) {
      setBanner('切换相机失败：请选择双机、只拍 A 机或只拍 B 机。', {
        tone: 'error',
        code: 'invalid_request',
      });
      onRender();
      return null;
    }
    return selectAction(state.status.action_id, state.status.point_id || '', targetCameras, { toggledSlotBit });
  }

  function stepAction(direction = 1) {
    if (rejectTemplateMismatch()) return Promise.resolve(null);
    const control = getRecordControlState();
    if (!state.connected || control.mode === 'stop' || state.pendingSelect || !state.status.selectionSupported) {
      if (state.connected && control.mode === 'stop') {
        setBanner('请先停止录像。拍完的记录可通过“修改拍摄项”更正。', {
          tone: 'error',
          code: 'recording_active',
        });
        onRender();
      }
      return Promise.resolve(null);
    }
    const candidates = getStepperCandidates();
    if (candidates.length === 0) return Promise.resolve(null);
    const curIdx = candidates.findIndex(a => a.action_id === state.status.action_id);
    const target = curIdx === -1
      ? (direction < 0 ? candidates.at(-1) : candidates[0])
      : (direction < 0 ? (curIdx > 0 ? candidates[curIdx - 1] : null) : (curIdx < candidates.length - 1 ? candidates[curIdx + 1] : null));
    if (!target || target.action_id === state.status.action_id) {
      return Promise.resolve(null);
    }
    return selectAction(target.action_id, getDefaultPointId(target), state.status.target_cameras);
  }

  function bindClientEvents(applyStatusSnapshot) {
    const prevOnStatus = client.onStatus;
    client.onStatus = async status => {
      const connection = rt.connectionVersion;
      const project = rt.projectVersion;
      if (typeof prevOnStatus === 'function') await prevOnStatus(status);
      if (rt.destroyed || !state.connected || connection !== rt.connectionVersion || project !== rt.projectVersion) return;
      applyStatusSnapshot(status);
    };

    const prevOnConnection = client.onConnection;
    client.onConnection = async info => {
      if (typeof prevOnConnection === 'function') await prevOnConnection(info);
      rt.connectionVersion += 1;
      const wasCaptureInFlight = Boolean(
        rt.pendingStop || rt.pendingStart?.cancelRequested || rt.wasActiveCaptureMode ||
        (state.status.phase && state.status.phase !== 'idle') || (state.status.active_take_id || 0) > 0
      );
      state.connected = Boolean(info?.connected);
      state.connecting = false;
      if (info?.connected) {
        rt.manualDisconnecting = false;
        rt.wasUnexpectedDropInReady = false;
        rt.offlineRecordsBrowse = false;
      } else {
        const unexpectedDrop = !rt.manualDisconnecting;
        rt.manualDisconnecting = false;
        if (unexpectedDrop && rt.hasEnteredReadyWorkbench && state.status.project_id && templateMatchesDevice()) {
          rt.wasUnexpectedDropInReady = true;
        } else {
          rt.hasEnteredReadyWorkbench = false;
          rt.wasUnexpectedDropInReady = false;
        }
        rt.smartLandedSessionKey = '';
        clearAudioSegmentTimer();
        void releaseWakeLock();
        rt.hardwareClockAnchor = null;
        clearPendingCaptureRequests();
        rt.pendingTakeEdits.clear();
        rt.syncingTakeEdits.clear();
        rt.batchOperationInFlight = null;
        rt.wasActiveCaptureMode = false;
        rt.startCooldownUntil = 0;
        rt.activeLocalStartAt = 0;
        rt.prevFullRecordingObs = { bootId: '', takeId: -1, mask: 0, localStartedAt: 0, full: false };
        clearStartCooldownTimer();
        rt.contiguousLocalSelectSeq = 0;
        state.syncingLog = false;
        state.pendingSelect = null;
        if (unexpectedDrop && isAudioBaselineSet()) {
          playStatusCue('warning');
        }
        if (unexpectedDrop && wasCaptureInFlight) {
          setBanner(
            '录像期间蓝牙连接已断开。请直接查看 A/B 相机屏幕与指示灯确认是否仍在录像；若仍在录像请直接按相机机身快门键停止（切勿盲按遥控器按键，以免误开新录像）。',
            { tone: 'error', code: info?.error?.code || 'disconnected_during_capture', detail: info?.error?.message || '' }
          );
        } else if (info?.error && info.error.code && info.error.code !== 'disconnected') {
          handleError('连接中断', info.error);
        } else {
          setBanner('连接已断开，请重新连接遥控器', { tone: 'warn', code: 'disconnected' });
        }
      }
      onRender();
    };

    const prevOnError = client.onError;
    client.onError = error => {
      if (typeof prevOnError === 'function') prevOnError(error);
      handleError('通信异常', error);
    };
  }

  return {
    syncCurrentProject,
    runConnectSequence,
    connectFromGesture,
    disconnect,
    rejectIfRecordingActive,
    initProject,
    selectAction,
    selectTargetCameras,
    stepAction,
    bindClientEvents,
  };
}
