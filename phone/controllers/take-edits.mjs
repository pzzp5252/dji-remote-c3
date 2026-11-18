import { BleClientError } from '../ble-client.mjs';

export function takeEditKey(projectId, takeId) {
  return JSON.stringify([String(projectId || ''), Number(takeId)]);
}

export function reassignDraftKey(projectId, takeId) {
  return JSON.stringify([String(projectId || ''), Number(takeId)]);
}

export function createTakeEditsController({
  doc,
  el,
  state,
  rt,
  client,
  templateMatchesDevice,
  rejectTemplateMismatch,
  rejectIfRecordingActive,
  refreshLocalLedger,
  syncCurrentProject,
  getRecordControlState,
  openDialog,
  closeDialog,
  setBanner,
  handleError,
  onRender,
}) {
  function getPendingTakeEdit(projectId, takeId) {
    return rt.pendingTakeEdits.get(takeEditKey(projectId, takeId)) || null;
  }

  function isTakeEditBlockedBySync(projectId = state.status.project_id) {
    return Boolean(
      projectId &&
      state.ledgerSyncError &&
      state.ledgerSyncError.project_id === projectId &&
      state.ledgerSyncError.code !== 'sync_pending'
    );
  }

  function isTakeTemplateEditable(take) {
    return Boolean(take && templateMatchesDevice() && take.template_id === state.template.template_id);
  }

  function isWaitingLatestTakeSync() {
    const latestTakeId = state.ledger.takes.reduce((max, t) => Math.max(max, t.take_id || 0), 0);
    return Boolean((state.status.take_id || 0) > latestTakeId);
  }

  function hasTakeEditInProgress(projectId, takeId) {
    const key = takeEditKey(projectId, takeId);
    return rt.pendingTakeEdits.has(key) || rt.syncingTakeEdits.has(key);
  }

  function isReassignLocked(take) {
    if (!take || !take.ended) return true;
    const projectId = state.status.project_id;
    return Boolean(
      !state.connected ||
      !projectId ||
      !isTakeTemplateEditable(take) ||
      Boolean(state.ledgerReadError) ||
      isTakeEditBlockedBySync(projectId) ||
      state.ledger.project_id !== projectId ||
      hasTakeEditInProgress(projectId, take.take_id)
    );
  }

  function isNodeVisibleForFocus(node) {
    return Boolean(node && node.isConnected && !node.disabled && !node.hidden && !node.closest('[hidden]'));
  }

  function restoreReassignFocus() {
    const target = rt.reassignReturnFocus;
    rt.reassignReturnFocus = null;
    if (isNodeVisibleForFocus(target)) {
      target.focus({ preventScroll: true });
      return;
    }
    const fallbacks = state.activeView === 'records' && !state.desktopMode
      ? [el('btn-batch-reassign'), el('nav-btn-records'), el('btn-toggle-settings')]
      : [el('nav-btn-shoot'), el('btn-toggle-settings')];
    for (const candidate of fallbacks) {
      if (isNodeVisibleForFocus(candidate)) {
        candidate.focus({ preventScroll: true });
        return;
      }
    }
  }

  function openTakeReassign(takeId, projectId, opts = {}) {
    const { surface = 'records', returnFocus = doc.activeElement } = opts || {};
    if (rejectTemplateMismatch()) return false;
    if (rt.destroyed || !state.connected || !projectId || projectId !== state.status.project_id) return false;
    if (isTakeEditBlockedBySync(projectId) || hasTakeEditInProgress(projectId, takeId)) return false;
    const nextSurface = surface === 'shoot' ? 'shoot' : 'records';
    if (nextSurface === 'shoot' && (getRecordControlState().mode === 'stop' || isWaitingLatestTakeSync())) return false;
    refreshLocalLedger(projectId);
    if (state.ledgerReadError || state.ledger.project_id !== projectId) return false;
    const take = state.ledger.takes.find(t => t.take_id === takeId && t.ended);
    if (!take || !isTakeTemplateEditable(take)) return false;
    state.editingReassignTakeId = takeId;
    state.editingReassignTakeIds = [takeId];
    state.editingReassignProjectId = projectId;
    state.reassignSurface = nextSurface;
    rt.reassignReturnFocus = returnFocus || null;
    const draftKey = reassignDraftKey(projectId, takeId);
    if (!state.reassignDrafts.has(draftKey)) {
      state.reassignDrafts.set(draftKey, {
        action_id: take.action_id || state.template.actions[0]?.action_id || '',
        point_id: take.point_id || '',
        query: '',
        scrollTop: 0,
      });
    }
    const modalReassign = el('modal-reassign');
    openDialog(modalReassign, { returnFocus });
    onRender();
    el('input-reassign-search')?.focus?.({ preventScroll: true });
    const bodyEl = el('reassign-sheet-body');
    const draft = state.reassignDrafts.get(draftKey);
    if (bodyEl && Number.isFinite(draft?.scrollTop)) {
      bodyEl.scrollTop = draft.scrollTop;
    }
    return true;
  }

  function openBatchTakeReassign(takeIds = [], projectId = state.status.project_id, { returnFocus = doc.activeElement } = {}) {
    const cleanIds = [...new Set(takeIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (cleanIds.length === 0) return false;
    if (cleanIds.length === 1) {
      return openTakeReassign(cleanIds[0], projectId, { surface: 'records', returnFocus });
    }
    if (rejectTemplateMismatch()) return false;
    if (rt.destroyed || !state.connected || !projectId || projectId !== state.status.project_id) return false;
    if (isTakeEditBlockedBySync(projectId) || rt.batchOperationInFlight) return false;
    if (getRecordControlState().mode === 'stop') return false;
    refreshLocalLedger(projectId);
    if (state.ledgerReadError || state.ledger.project_id !== projectId) return false;
    const takes = cleanIds.map(id => state.ledger.takes.find(t => t.take_id === id && t.ended)).filter(Boolean);
    if (takes.length !== cleanIds.length || takes.some(t => !isTakeTemplateEditable(t) || hasTakeEditInProgress(projectId, t.take_id))) {
      return false;
    }
    state.editingReassignTakeId = cleanIds[0];
    state.editingReassignTakeIds = cleanIds;
    state.editingReassignProjectId = projectId;
    state.reassignSurface = 'records';
    rt.reassignReturnFocus = returnFocus || null;
    const draftKey = JSON.stringify([String(projectId), 'batch', ...cleanIds]);
    if (!state.reassignDrafts.has(draftKey)) {
      state.reassignDrafts.set(draftKey, {
        action_id: takes[0].action_id || state.template.actions[0]?.action_id || '',
        point_id: '',
        query: '',
        scrollTop: 0,
      });
    }
    openDialog(el('modal-reassign'), { returnFocus });
    onRender();
    el('input-reassign-search')?.focus?.({ preventScroll: true });
    return true;
  }

  function canEditTake(takeId, projectId, { requireTemplateMatch = false, requireEnded = false } = {}) {
    if (!state.connected || !projectId || projectId !== state.status.project_id) return false;
    if (rt.pendingTakeEdits.has(takeEditKey(projectId, takeId))) return false;
    if (isTakeEditBlockedBySync(projectId)) {
      setBanner('设备已修改，手机待同步；请先同步拍摄记录', {
        tone: 'warn',
        code: state.ledgerSyncError?.code || 'ledger_not_updated',
      });
      onRender();
      return false;
    }
    refreshLocalLedger(projectId);
    const take = state.ledger.takes.find(t => t.take_id === takeId);
    if (state.ledgerReadError || state.ledger.project_id !== projectId || !take) {
      setBanner('手机记录无法读取或找不到本条，未向设备发送修改；请先同步拍摄记录', {
        tone: 'error', code: 'ledger_unavailable',
      });
      onRender();
      return false;
    }
    if (requireEnded && !take.ended) return false;
    if (requireTemplateMatch && !isTakeTemplateEditable(take)) return false;
    return true;
  }

  async function markDiscard(takeId, discard, projectId = state.status.project_id) {
    if (rejectIfRecordingActive('修改记录状态')) return null;
    if (!canEditTake(takeId, projectId)) return null;
    const editKey = takeEditKey(projectId, takeId);
    if (hasTakeEditInProgress(projectId, takeId)) return null;
    const connection = rt.connectionVersion;
    const project = rt.projectVersion;
    const editLock = { kind: 'discard', projectId, takeId, connection, project };
    rt.pendingTakeEdits.set(editKey, editLock);
    setBanner(`正在${discard ? '标为废片' : '恢复有效'} #${takeId}…`, { tone: 'busy', code: 'MARK_DISCARD' });
    onRender();
    try {
      const reply = await client.request({ cmd: 'MARK_DISCARD', project_id: projectId, take_id: takeId, discard: Boolean(discard) });
      if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) return reply;
      if (reply?.ok !== true) throw new BleClientError(reply?.error || 'request_rejected', 'MARK_DISCARD rejected', { reply });
      if (rt.pendingTakeEdits.get(editKey) === editLock) rt.pendingTakeEdits.delete(editKey);
      rt.syncingTakeEdits.add(editKey);
      if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
      state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机待同步' };
      onRender();
      const synced = await syncCurrentProject(projectId);
      rt.syncingTakeEdits.delete(editKey);
      if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) return reply;
      if (synced && !state.ledgerReadError && !isTakeEditBlockedBySync(projectId)) {
        setBanner(`#${takeId} 已${discard ? '标为废片' : '恢复有效'}`, { tone: 'ok', code: 'DISCARD_OK' });
      } else if (!state.ledgerSyncError || state.ledgerSyncError.code === 'sync_incomplete' || state.ledgerSyncError.code === 'sync_pending') {
        setBanner('设备已修改，手机待同步；请先同步拍摄记录', { tone: 'warn', code: 'ledger_not_updated' });
      }
      onRender();
      return reply;
    } catch (error) {
      if (connection === rt.connectionVersion && project === rt.projectVersion) handleError('修改记录状态', error);
      return null;
    } finally {
      if (rt.pendingTakeEdits.get(editKey) === editLock) rt.pendingTakeEdits.delete(editKey);
      rt.syncingTakeEdits.delete(editKey);
      if (!rt.destroyed) onRender();
    }
  }

  async function batchMarkDiscard(takeIds = [], discard = true, projectId = state.status.project_id) {
    if (rejectIfRecordingActive('批量修改记录状态')) return null;
    if (rt.batchOperationInFlight) return null;
    const cleanIds = [...new Set(takeIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (cleanIds.length === 0) return null;
    if (cleanIds.length === 1) {
      return markDiscard(cleanIds[0], discard, projectId);
    }
    const connection = rt.connectionVersion;
    const project = rt.projectVersion;
    rt.batchOperationInFlight = 'discard';
    const submitted = [];
    onRender();
    try {
      for (const takeId of cleanIds) {
        if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) break;
        if (getRecordControlState().mode === 'stop') break;
        if (!canEditTake(takeId, projectId)) break;
        const editKey = takeEditKey(projectId, takeId);
        if (hasTakeEditInProgress(projectId, takeId)) continue;
        const editLock = { kind: 'discard', projectId, takeId, connection, project };
        rt.pendingTakeEdits.set(editKey, editLock);
        setBanner(`正在批量${discard ? '标为废片' : '恢复有效'} #${takeId}（${submitted.length + 1}/${cleanIds.length}）…`, { tone: 'busy', code: 'MARK_DISCARD' });
        onRender();
        const reply = await client.request({ cmd: 'MARK_DISCARD', project_id: projectId, take_id: takeId, discard: Boolean(discard) });
        if (rt.pendingTakeEdits.get(editKey) === editLock) rt.pendingTakeEdits.delete(editKey);
        if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) return submitted;
        if (reply?.ok !== true) throw new BleClientError(reply?.error || 'request_rejected', 'MARK_DISCARD rejected', { reply });
        rt.syncingTakeEdits.add(editKey);
        if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
        submitted.push(takeId);
      }
      if (submitted.length > 0 && connection === rt.connectionVersion && project === rt.projectVersion && projectId === state.status.project_id) {
        state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机待同步' };
        const synced = await syncCurrentProject(projectId);
        for (const id of submitted) rt.syncingTakeEdits.delete(takeEditKey(projectId, id));
        rt.batchOperationInFlight = null;
        if (synced && !state.ledgerReadError && !isTakeEditBlockedBySync(projectId)) {
          state.selectedRecordTakeIds.clear();
          setBanner(`已批量${discard ? '标为废片' : '恢复有效'} ${submitted.length} 条记录`, { tone: 'ok', code: 'DISCARD_OK' });
        }
      }
      return submitted;
    } catch (error) {
      const hasSubmitted = submitted.length > 0 && connection === rt.connectionVersion && project === rt.projectVersion && projectId === state.status.project_id;
      if (hasSubmitted) {
        state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机待同步' };
      }
      if (connection === rt.connectionVersion && project === rt.projectVersion) handleError('批量修改记录状态', error);
      if (hasSubmitted) {
        await syncCurrentProject(projectId, { silent: true });
      }
      return null;
    } finally {
      for (const id of cleanIds) {
        const k = takeEditKey(projectId, id);
        if (rt.pendingTakeEdits.get(k)?.connection === connection) rt.pendingTakeEdits.delete(k);
        rt.syncingTakeEdits.delete(k);
      }
      rt.batchOperationInFlight = null;
      if (!rt.destroyed) onRender();
    }
  }

  async function reassignTake(takeId, actionId, pointId = '', projectId = state.status.project_id) {
    if (rejectTemplateMismatch()) return null;
    if (rejectIfRecordingActive('修改拍摄项')) return null;
    if (!actionId || !canEditTake(takeId, projectId, { requireTemplateMatch: true, requireEnded: true })) return null;
    const editKey = takeEditKey(projectId, takeId);
    if (hasTakeEditInProgress(projectId, takeId)) return null;
    const connection = rt.connectionVersion;
    const project = rt.projectVersion;
    const editLock = { kind: 'reassign', projectId, takeId, connection, project };
    rt.pendingTakeEdits.set(editKey, editLock);
    setBanner(`正在修改 #${takeId} 拍摄项…`, { tone: 'busy', code: 'REASSIGN' });
    onRender();
    try {
      const reply = await client.request({ cmd: 'REASSIGN', project_id: projectId, take_id: takeId, action_id: actionId, point_id: pointId ?? '' });
      if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) return reply;
      if (reply?.ok !== true) throw new BleClientError(reply?.error || 'request_rejected', 'REASSIGN rejected', { reply });
      if (rt.pendingTakeEdits.get(editKey) === editLock) rt.pendingTakeEdits.delete(editKey);
      rt.syncingTakeEdits.add(editKey);
      const wasShootSurface = state.reassignSurface === 'shoot';
      state.editingReassignTakeId = null;
      state.editingReassignTakeIds = [];
      state.editingReassignProjectId = '';
      state.reassignSurface = 'records';
      state.reassignDrafts.delete(reassignDraftKey(projectId, takeId));
      const modalReassign = el('modal-reassign');
      if (modalReassign?.open) {
        await closeDialog(modalReassign, { immediate: true });
      }
      if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
      state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机待同步' };
      onRender();
      const synced = await syncCurrentProject(projectId);
      rt.syncingTakeEdits.delete(editKey);
      if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) return reply;
      if (synced && !state.ledgerReadError && !isTakeEditBlockedBySync(projectId)) {
        setBanner(`#${takeId} 已修改拍摄项`, { tone: 'ok', code: 'REASSIGN_OK' });
      } else if (!state.ledgerSyncError || state.ledgerSyncError.code === 'sync_incomplete' || state.ledgerSyncError.code === 'sync_pending') {
        setBanner('设备已修改，手机待同步；请先同步拍摄记录', { tone: 'warn', code: 'ledger_not_updated' });
      }
      onRender();
      if (wasShootSurface || rt.reassignReturnFocus) restoreReassignFocus();
      return reply;
    } catch (error) {
      if (connection === rt.connectionVersion && project === rt.projectVersion) handleError('修改拍摄项', error);
      return null;
    } finally {
      if (rt.pendingTakeEdits.get(editKey) === editLock) rt.pendingTakeEdits.delete(editKey);
      rt.syncingTakeEdits.delete(editKey);
      if (!rt.destroyed) onRender();
    }
  }

  async function reassignTakes(takeIds = [], actionId, pointId = '', projectId = state.status.project_id) {
    const cleanIds = [...new Set(takeIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (cleanIds.length === 0) return null;
    if (cleanIds.length === 1) {
      return reassignTake(cleanIds[0], actionId, pointId, projectId);
    }
    if (rejectTemplateMismatch()) return null;
    if (rejectIfRecordingActive('批量修改拍摄项')) return null;
    if (!actionId || rt.batchOperationInFlight) return null;
    const connection = rt.connectionVersion;
    const project = rt.projectVersion;
    rt.batchOperationInFlight = 'reassign';
    const submitted = [];
    const draftKey = JSON.stringify([String(projectId), 'batch', ...cleanIds]);
    onRender();
    try {
      for (const takeId of cleanIds) {
        if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) break;
        if (getRecordControlState().mode === 'stop') break;
        if (!canEditTake(takeId, projectId, { requireTemplateMatch: true, requireEnded: true })) break;
        const editKey = takeEditKey(projectId, takeId);
        if (hasTakeEditInProgress(projectId, takeId)) continue;
        const editLock = { kind: 'reassign', projectId, takeId, connection, project };
        rt.pendingTakeEdits.set(editKey, editLock);
        setBanner(`正在批量修改拍摄项 #${takeId}（${submitted.length + 1}/${cleanIds.length}）…`, { tone: 'busy', code: 'REASSIGN' });
        onRender();
        const reply = await client.request({ cmd: 'REASSIGN', project_id: projectId, take_id: takeId, action_id: actionId, point_id: pointId ?? '' });
        if (rt.pendingTakeEdits.get(editKey) === editLock) rt.pendingTakeEdits.delete(editKey);
        if (connection !== rt.connectionVersion || project !== rt.projectVersion || projectId !== state.status.project_id) return submitted;
        if (reply?.ok !== true) throw new BleClientError(reply?.error || 'request_rejected', 'REASSIGN rejected', { reply });
        rt.syncingTakeEdits.add(editKey);
        if (Number.isSafeInteger(reply.event_seq)) state.status.event_seq = Math.max(state.status.event_seq, reply.event_seq);
        submitted.push(takeId);
      }
      if (submitted.length > 0 && connection === rt.connectionVersion && project === rt.projectVersion && projectId === state.status.project_id) {
        state.editingReassignTakeId = null;
        state.editingReassignTakeIds = [];
        state.editingReassignProjectId = '';
        state.reassignSurface = 'records';
        state.reassignDrafts.delete(draftKey);
        const modalReassign = el('modal-reassign');
        if (modalReassign?.open) await closeDialog(modalReassign, { immediate: true });
        state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机待同步' };
        const synced = await syncCurrentProject(projectId);
        for (const id of submitted) rt.syncingTakeEdits.delete(takeEditKey(projectId, id));
        if (synced && !state.ledgerReadError && !isTakeEditBlockedBySync(projectId)) {
          state.selectedRecordTakeIds.clear();
          setBanner(`已批量修改 ${submitted.length} 条记录的拍摄项`, { tone: 'ok', code: 'REASSIGN_OK' });
        }
        restoreReassignFocus();
      }
      return submitted;
    } catch (error) {
      const hasSubmitted = submitted.length > 0 && connection === rt.connectionVersion && project === rt.projectVersion && projectId === state.status.project_id;
      if (hasSubmitted) {
        state.ledgerSyncError = { project_id: projectId, code: 'sync_pending', message: '设备已修改，手机待同步' };
      }
      if (connection === rt.connectionVersion && project === rt.projectVersion) handleError('批量修改拍摄项', error);
      if (hasSubmitted) {
        await syncCurrentProject(projectId, { silent: true });
      }
      return null;
    } finally {
      for (const id of cleanIds) {
        const k = takeEditKey(projectId, id);
        if (rt.pendingTakeEdits.get(k)?.connection === connection) rt.pendingTakeEdits.delete(k);
        rt.syncingTakeEdits.delete(k);
      }
      rt.batchOperationInFlight = null;
      if (!rt.destroyed) onRender();
    }
  }

  return {
    getPendingTakeEdit,
    isTakeEditBlockedBySync,
    isTakeTemplateEditable,
    isWaitingLatestTakeSync,
    hasTakeEditInProgress,
    isReassignLocked,
    openTakeReassign,
    openBatchTakeReassign,
    markDiscard,
    batchMarkDiscard,
    reassignTake,
    reassignTakes,
  };
}
