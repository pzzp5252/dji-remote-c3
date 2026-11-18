import { BUILTIN_PRESETS, getBuiltinPreset } from '../presets/index.mjs';
import { TEMPLATE_CACHE_KEY, DEFAULT_TEMPLATE } from '../core/constants.mjs';
import { setTextIfChanged, setHiddenIfChanged } from '../core/dom-utils.mjs';
import {
  isValidAsciiId,
  findTemplateAction,
  normalizeTemplate,
  getProgressEntryKey,
  summarizeActionProgress,
  filterActions,
} from '../core/formatters.mjs';
import { loadProjectLedger } from '../core/ledger.mjs';

export function createTemplateLedgerController({
  el,
  state,
  rt,
  storage,
  fetchFn,
  isMockUrl,
  mockEmptyParam,
  mockPresetParam,
  currentLedgerFailure,
  setBanner,
  handleError,
  renderFeedbackVisibility,
  onTemplateImported,
  onRender,
}) {
  function templateMatchesDevice() {
    return !state.status.project_id || Boolean(state.status.template_id &&
      state.template.template_id === state.status.template_id);
  }

  function currentTemplateAction(actionId = state.status.action_id) {
    return findTemplateAction(
      state.template,
      state.status.project_id ? state.status.template_id : state.template.template_id,
      actionId
    );
  }

  function templateMismatchMessage() {
    return `清单不匹配：设备 ${state.status.template_id || '未知'}，手机 ${state.template.template_id}；请载入与设备一致的清单后再拍摄或修改拍摄项`;
  }

  function rejectTemplateMismatch() {
    if (templateMatchesDevice()) return false;
    setBanner(templateMismatchMessage(), { tone: 'warn' });
    onRender();
    return true;
  }

  function harvestOrphanPointsFromLedger() {
    state.templateSaveError = false;
    if (!state.ledger?.takes || !state.template?.actions) return true;
    const candidate = normalizeTemplate(state.template);
    let harvestedAny = false;
    for (const take of state.ledger.takes) {
      const cleanPid = typeof take.point_id === 'string' ? take.point_id : '';
      if (take.template_id !== candidate.template_id || !isValidAsciiId(cleanPid, 31)) continue;
      const action = candidate.actions.find(a => a.action_id === take.action_id);
      if (action && !action.points.some(p => p.point_id.toUpperCase() === cleanPid.toUpperCase())) {
        action.points.push({ point_id: cleanPid, name: `${cleanPid} (现场补录)`, orphan: true });
        harvestedAny = true;
      }
    }
    if (harvestedAny) {
      try {
        storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(candidate));
      } catch (error) {
        state.templateSaveError = true;
        setBanner('历史点位未保存，请腾出手机存储空间后同步记录', {
          tone: 'error', code: 'template_not_saved', detail: error?.message || '',
        });
        return false;
      }
      state.template = candidate;
      state.templateVersion += 1;
    }
    return true;
  }

  function refreshLocalLedger(projectId = state.status.project_id) {
    if (state.ledger.project_id !== projectId) {
      state.ledgerReadError = null;
      state.ledgerSyncError = null;
      state.lastBackupPayload = null;
      state.editingReassignTakeId = null;
      state.editingReassignTakeIds = [];
      state.editingReassignProjectId = '';
      state.reassignSurface = 'records';
      rt.reassignReturnFocus = null;
      state.reassignDrafts.clear();
      state.selectedRecordTakeIds.clear();
      state.expandedRecordTakeIds.clear();
      state.expandedShootTakeIds.clear();
      rt.pendingTakeEdits.clear();
      rt.syncingTakeEdits.clear();
    }
    if (!projectId) {
      state.ledger = { project_id: '', after_seq: 0, events: [], takes: [], progress: new Map(), takesByBucket: new Map() };
      state.ledgerReadError = null;
      return state.ledger;
    }
    try {
      state.ledger = loadProjectLedger(storage, projectId);
      state.ledgerReadError = null;
      harvestOrphanPointsFromLedger();
    } catch (error) {
      state.ledger = { project_id: projectId, after_seq: 0, events: [], takes: [], progress: new Map(), takesByBucket: new Map() };
      state.ledgerReadError = {
        project_id: projectId, code: error?.code || error?.name || 'ledger_read_failed',
        message: error?.message || '',
      };
      state.lastBackupPayload = null;
      state.editingReassignTakeId = null;
      state.editingReassignTakeIds = [];
      state.editingReassignProjectId = '';
      state.reassignSurface = 'records';
      rt.reassignReturnFocus = null;
      state.reassignDrafts.clear();
      state.selectedRecordTakeIds.clear();
      handleError('读取拍摄记录', error);
    }
    return state.ledger;
  }

  function localLedgerIncomplete() {
    return Boolean(state.ledgerSyncError || state.syncingLog ||
      state.status.event_seq > state.ledger.after_seq);
  }

  function renderLedgerStorageNotice() {
    const failure = currentLedgerFailure();
    const notice = el('ledger-storage-notice');
    const row = el('ledger-storage-details');
    if (row) setHiddenIfChanged(row, !failure);
    if (notice) {
      setHiddenIfChanged(notice, !failure);
      setTextIfChanged(notice, state.ledgerReadError ? '手机记录读取失败' : failure ? '手机记录未同步' : '');
    }
    const syncState = state.ledgerReadError ? 'unreadable' : failure ? 'failed' : localLedgerIncomplete() ? 'pending' : 'clean';
    const navRecords = el('nav-btn-records');
    if (navRecords) navRecords.dataset.syncState = syncState;
    const hint = state.syncingLog ? '同步中' : syncState === 'pending' ? '待同步' : '';
    setTextIfChanged(el('records-sync-hint'), hint);
    setTextIfChanged(el('records-sync-status'), hint);
    renderFeedbackVisibility();
  }

  function isProgressAvailable() {
    if (state.ledgerReadError) return false;
    return state.ledger.project_id === state.status.project_id && templateMatchesDevice();
  }

  function getOrderedTemplateActions() {
    return [...state.template.actions].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.action_id.localeCompare(b.action_id)
    );
  }

  function getStepperCandidates() {
    if (!state.coupleStepperToFilters) return getOrderedTemplateActions();
    const known = isProgressAvailable();
    return filterActions(state.template.actions, {
      query: state.searchQuery,
      group: state.groupFilter,
      typeFilter: state.typeFilter,
      statusFilter: known ? state.statusFilter : 'all',
      progress: known ? state.ledger.progress : new Map(),
      templateId: known ? state.template.template_id : '',
    });
  }

  function getDefaultPointId(action) {
    if (!action) return '';
    if (templateMatchesDevice() && state.status.action_id === action.action_id) {
      return state.status.point_id || '';
    }
    const explicitPoints = (action.points || []).filter(pt => pt && pt.point_id && !pt.orphan);
    if (explicitPoints.length === 0) return '';
    if (!isProgressAvailable()) return explicitPoints[0].point_id;
    const actionProgress = state.ledger.progress.get(
      getProgressEntryKey(state.template.template_id, action.action_id)
    );
    const firstUnshot = explicitPoints.find(pt => {
      const ptStats = actionProgress?.points?.get(pt.point_id);
      return (ptStats?.completeCount || 0) === 0 && (ptStats?.localAckCount || 0) === 0;
    });
    return (firstUnshot || explicitPoints[0]).point_id;
  }

  function getNextUnshotSelection() {
    if (!isProgressAvailable()) return null;
    const templateId = state.template.template_id;
    const currentAction = currentTemplateAction();
    if (currentAction) {
      const explicitPoints = (currentAction.points || []).filter(pt => pt && pt.point_id && !pt.orphan);
      if (explicitPoints.length > 0) {
        const actProgress = state.ledger.progress.get(getProgressEntryKey(templateId, currentAction.action_id));
        const curPtIdx = state.status.point_id
          ? explicitPoints.findIndex(pt => pt.point_id === state.status.point_id)
          : -1;
        const startAt = curPtIdx >= 0 ? curPtIdx + 1 : 0;
        for (let i = startAt; i < explicitPoints.length; i++) {
          const ptId = explicitPoints[i].point_id;
          const ptStats = actProgress?.points?.get(ptId);
          if ((ptStats?.completeCount || 0) === 0 && (ptStats?.localAckCount || 0) === 0) {
            return { actionId: currentAction.action_id, pointId: ptId };
          }
        }
      }
    }
    const orderedAll = getOrderedTemplateActions();
    const candidates = getStepperCandidates();
    if (candidates.length === 0) return null;
    const allIndexMap = new Map(orderedAll.map((a, idx) => [a.action_id, idx]));
    const curAllIdx = state.status.action_id ? (allIndexMap.get(state.status.action_id) ?? -1) : -1;
    const curCandIdx = state.status.action_id
      ? candidates.findIndex(a => a.action_id === state.status.action_id)
      : -1;
    let firstAfterOffset = 0;
    if (curCandIdx !== -1) {
      firstAfterOffset = (curCandIdx + 1) % candidates.length;
    } else if (curAllIdx !== -1) {
      const nextIdx = candidates.findIndex(a => (allIndexMap.get(a.action_id) ?? -1) > curAllIdx);
      firstAfterOffset = nextIdx !== -1 ? nextIdx : 0;
    }
    for (let offset = 0; offset < candidates.length; offset++) {
      const cand = candidates[(firstAfterOffset + offset) % candidates.length];
      if (cand.action_id === state.status.action_id) continue;
      const summary = summarizeActionProgress(cand, templateId, state.ledger.progress);
      if (summary.state === 'complete' || summary.state === 'manual_ok') continue;
      const explicitPoints = (cand.points || []).filter(pt => pt && pt.point_id && !pt.orphan);
      if (explicitPoints.length === 0) {
        return { actionId: cand.action_id, pointId: '' };
      }
      const candProgress = state.ledger.progress.get(getProgressEntryKey(templateId, cand.action_id));
      const firstUnshotPt = explicitPoints.find(pt => {
        const ptStats = candProgress?.points?.get(pt.point_id);
        return (ptStats?.completeCount || 0) === 0 && (ptStats?.localAckCount || 0) === 0;
      });
      return { actionId: cand.action_id, pointId: firstUnshotPt ? firstUnshotPt.point_id : explicitPoints[0].point_id };
    }
    return null;
  }

  function importTemplateObject(rawObj, { persist = true, announce = true } = {}) {
    const normalized = normalizeTemplate(rawObj);
    if (persist) {
      storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(normalized));
      state.templateLoadError = null;
    }
    state.template = normalized;
    state.templateVersion += 1;
    state.selectedInitPresetId = normalized.template_id;
    state.expandedChecklistActionId = null;
    onTemplateImported?.();
    const validRooms = new Set(normalized.actions.map(a => a.room_key || a.group).filter(Boolean));
    if (state.groupFilter !== 'all' && !validRooms.has(state.groupFilter)) {
      state.groupFilter = 'all';
    }
    if (announce) {
      setBanner(`已载入拍摄清单，共 ${normalized.actions.length} 项`, {
        tone: 'ok',
        code: 'TEMPLATE_OK',
      });
    }
    onRender();
    return normalized;
  }

  async function loadInitialTemplate() {
    if (isMockUrl && (mockEmptyParam || mockPresetParam)) {
      const targetPreset = getBuiltinPreset(mockPresetParam) || getBuiltinPreset(BUILTIN_PRESETS[0]?.template_id);
      if (targetPreset) {
        importTemplateObject(targetPreset, { persist: false, announce: false });
        return state.template;
      }
    }
    try {
      const cached = storage.getItem(TEMPLATE_CACHE_KEY);
      if (cached) {
        importTemplateObject(JSON.parse(cached), { persist: false, announce: false });
        return state.template;
      }
    } catch (error) {
      state.templateLoadError = { code: error?.code || error?.name || 'template_cache_unavailable', message: error?.message || '' };
      handleError('读取拍摄清单缓存', error);
    }
    if (typeof fetchFn === 'function') {
      try {
        const res = await fetchFn('../schema/actions.json');
        if (res && res.ok) {
          const data = await res.json();
          importTemplateObject(data, { persist: false, announce: false });
          return state.template;
        }
      } catch {
        // Fallback below
      }
    }
    importTemplateObject((!isMockUrl && BUILTIN_PRESETS[0]) ? BUILTIN_PRESETS[0] : DEFAULT_TEMPLATE, { persist: false, announce: false });
    return state.template;
  }

  return {
    templateMatchesDevice,
    currentTemplateAction,
    templateMismatchMessage,
    rejectTemplateMismatch,
    harvestOrphanPointsFromLedger,
    refreshLocalLedger,
    localLedgerIncomplete,
    renderLedgerStorageNotice,
    isProgressAvailable,
    getOrderedTemplateActions,
    getStepperCandidates,
    getDefaultPointId,
    getNextUnshotSelection,
    importTemplateObject,
    loadInitialTemplate,
  };
}
