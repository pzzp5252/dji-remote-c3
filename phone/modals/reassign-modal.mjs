import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setAttrIfChanged,
  setClassIfChanged,
  reconcileChildOrder,
} from '../core/dom-utils.mjs';
import {
  findTemplateAction,
  formatHumanSeq,
  formatRoomAndHood,
  formatHumanPointName,
  matchesActionQuery,
  filterActions,
} from '../core/formatters.mjs';
import { reassignDraftKey } from '../controllers/take-edits.mjs';

export function createReassignModalController({
  doc,
  el,
  state,
  rt,
  getRecordControlState,
  templateMatchesDevice,
  isTakeTemplateEditable,
  isTakeEditBlockedBySync,
  hasTakeEditInProgress,
  getPendingTakeEdit,
  isReassignLocked,
  closeDialog,
  reassignTake,
  reassignTakes,
}) {
  const reassignOptionCache = new Map();
  const reassignPointCache = new Map();

  function clearCaches() {
    reassignOptionCache.clear();
    reassignPointCache.clear();
  }

  function resolveCurrentTarget() {
    const projId = state.editingReassignProjectId || state.status.project_id;
    const ids = state.editingReassignTakeIds.length > 0
      ? state.editingReassignTakeIds
      : (state.editingReassignTakeId !== null ? [state.editingReassignTakeId] : []);
    return { projId, ids };
  }

  function resolveDraftKey(projId, ids) {
    return ids.length > 1
      ? JSON.stringify([String(projId), 'batch', ...ids])
      : reassignDraftKey(projId, ids[0]);
  }

  function render(control = getRecordControlState()) {
    const dlg = el('modal-reassign');
    if (!dlg || !dlg.open) return;
    const { projId: projectId, ids: targetIds } = resolveCurrentTarget();
    const takeId = targetIds[0] ?? null;
    const ledgerValid = !state.ledgerReadError && projectId && state.ledger.project_id === projectId;
    const targetTakes = ledgerValid
      ? targetIds.map(id => state.ledger.takes.find(t => t.take_id === id && t.ended)).filter(Boolean)
      : [];
    const allEditable = targetTakes.length === targetIds.length && targetTakes.length > 0 && targetTakes.every(t => isTakeTemplateEditable(t));

    if (
      !state.connected ||
      !projectId ||
      projectId !== state.status.project_id ||
      !templateMatchesDevice() ||
      !allEditable
    ) {
      state.editingReassignTakeId = null;
      state.editingReassignTakeIds = [];
      state.editingReassignProjectId = '';
      void closeDialog(dlg, { immediate: true, control });
      return;
    }

    const isBatch = targetTakes.length > 1;
    const take = targetTakes[0];
    const key = resolveDraftKey(projectId, targetIds);
    let draft = state.reassignDrafts.get(key);
    if (!draft) {
      draft = {
        action_id: take.action_id || state.template.actions[0]?.action_id || '',
        point_id: isBatch ? '' : (take.point_id ?? ''),
        query: '',
        scrollTop: 0,
      };
      state.reassignDrafts.set(key, draft);
    }

    const origAction = findTemplateAction(state.template, take.template_id, take.action_id);
    const origLabel = origAction
      ? `${formatHumanSeq(origAction, { compact: true })} ${origAction.name}`
      : (take.action_id || '尚未选择');
    if (isBatch) {
      const idText = targetIds.slice(0, 4).map(id => `#${id}`).join('、');
      setTextIfChanged(
        el('reassign-context-title'),
        `批量修改拍摄项（已选 ${targetIds.length} 条：${idText}${targetIds.length > 4 ? '…' : ''}）`
      );
    } else {
      setTextIfChanged(el('reassign-context-title'), `项目 ${projectId} · #${take.take_id}（当前：${origLabel}）`);
    }

    const recordingActive = control.mode === 'stop';
    const syncBlocked = isTakeEditBlockedBySync(projectId);
    const editPending = targetIds.some(id => hasTakeEditInProgress(projectId, id)) || rt.batchOperationInFlight === 'reassign';
    const lockHint = el('reassign-lock-hint');
    if (lockHint) {
      if (recordingActive) {
        setHiddenIfChanged(lockHint, false);
        setTextIfChanged(lockHint, '录像中暂不能修改，请先停止录像');
      } else if (syncBlocked) {
        setHiddenIfChanged(lockHint, false);
        setTextIfChanged(lockHint, '设备记录与本地副本未同步，请先同步记录后再修改');
      } else {
        setHiddenIfChanged(lockHint, true);
        setTextIfChanged(lockHint, '');
      }
    }

    const searchEl = el('input-reassign-search');
    if (searchEl && searchEl.value !== (draft.query || '')) {
      searchEl.value = draft.query || '';
    }

    let matchingActions = filterActions(state.template.actions, { query: draft.query || '' });
    if (draft.action_id && !state.template.actions.some(a => a.action_id === draft.action_id)) {
      const orphanAct = {
        action_id: draft.action_id,
        name: '(现场保留动作·未命名)',
        group: '现场保留',
        room_key: '现场保留',
        description: '',
        points: [],
        orphan: true,
      };
      if (!draft.query || matchesActionQuery(orphanAct, draft.query)) {
        matchingActions = [orphanAct, ...matchingActions];
      }
    }
    const listEl = el('reassign-action-list');
    if (listEl) {
      const nodes = [];
      for (const act of matchingActions) {
        let btn = reassignOptionCache.get(act.action_id);
        if (!btn) {
          btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'reassign-option-btn';
          btn.dataset.reassignOption = act.action_id;
          const topLine = doc.createElement('span');
          topLine.className = 'reassign-opt-head';
          const descLine = doc.createElement('span');
          descLine.className = 'reassign-opt-desc';
          btn.append(topLine, descLine);
          btn.addEventListener('click', () => {
            const cur = resolveCurrentTarget();
            if (!cur.projId || cur.ids.length === 0) return;
            const dKey = resolveDraftKey(cur.projId, cur.ids);
            const curDraft = state.reassignDrafts.get(dKey) || { action_id: '', point_id: '', query: '', scrollTop: 0 };
            curDraft.action_id = act.action_id;
            curDraft.point_id = '';
            state.reassignDrafts.set(dKey, curDraft);
            render();
          });
          reassignOptionCache.set(act.action_id, btn);
        }
        const selected = draft.action_id === act.action_id;
        setClassIfChanged(btn, 'is-active', selected);
        setAttrIfChanged(btn, 'aria-selected', selected ? 'true' : 'false');
        setAttrIfChanged(btn, 'aria-pressed', selected ? 'true' : 'false');
        const head = btn.querySelector('.reassign-opt-head');
        const desc = btn.querySelector('.reassign-opt-desc');
        const headSeq = act.orphan ? act.action_id : formatHumanSeq(act, { compact: true });
        const headPlace = formatRoomAndHood(act).display || act.group;
        setTextIfChanged(head, `${headSeq} · ${act.name} · ${headPlace}`);
        setTextIfChanged(desc, act.description || '');
        if (desc) setHiddenIfChanged(desc, !act.description);
        nodes.push(btn);
      }
      reconcileChildOrder(listEl, nodes);
    }

    const selectedAct = state.template.actions.find(a => a.action_id === draft.action_id) || null;
    const ptSection = el('reassign-point-section');
    const ptListEl = el('reassign-point-list');
    const pts = selectedAct?.points || [];
    if (ptSection && ptListEl) {
      if (pts.length === 0 && !draft.point_id) {
        setHiddenIfChanged(ptSection, true);
        ptListEl.replaceChildren();
      } else {
        setHiddenIfChanged(ptSection, false);
        const pointOptions = [{ point_id: '', name: '不指定拍摄位置' }, ...pts];
        if (draft.point_id && !pointOptions.some(p => p.point_id === draft.point_id)) {
          pointOptions.push({ point_id: draft.point_id, name: '(现场保留点位·未命名)', orphan: true });
        }
        const ptNodes = [];
        for (const pt of pointOptions) {
          let pBtn = reassignPointCache.get(pt.point_id);
          if (!pBtn) {
            pBtn = doc.createElement('button');
            pBtn.type = 'button';
            pBtn.className = 'reassign-option-btn';
            pBtn.dataset.reassignPoint = pt.point_id;
            pBtn.addEventListener('click', () => {
              const cur = resolveCurrentTarget();
              if (!cur.projId || cur.ids.length === 0) return;
              const dKey = resolveDraftKey(cur.projId, cur.ids);
              const curDraft = state.reassignDrafts.get(dKey) || { action_id: '', point_id: '', query: '', scrollTop: 0 };
              curDraft.point_id = pBtn.dataset.reassignPoint || '';
              state.reassignDrafts.set(dKey, curDraft);
              render();
            });
            reassignPointCache.set(pt.point_id, pBtn);
          }
          pBtn.dataset.reassignPoint = pt.point_id;
          const ptSel = (draft.point_id || '') === pt.point_id;
          setClassIfChanged(pBtn, 'is-active', ptSel);
          setAttrIfChanged(pBtn, 'aria-pressed', ptSel ? 'true' : 'false');
          const ptText = pt.point_id ? formatHumanPointName(pt, pt.point_id) : pt.name;
          setTextIfChanged(pBtn, pt.orphan && pt.name && !ptText.includes(pt.name) ? `${pt.point_id} · ${pt.name}` : ptText);
          ptNodes.push(pBtn);
        }
        reconcileChildOrder(ptListEl, ptNodes);
      }
    }

    const previewEl = el('reassign-change-preview');
    const ptSelectedObj = selectedAct?.points?.find(p => p.point_id === draft.point_id);
    const ptPreviewSuffix = draft.point_id
      ? `（${formatHumanPointName(ptSelectedObj, draft.point_id)}）`
      : '';
    const targetLabel = selectedAct
      ? `${formatHumanSeq(selectedAct, { compact: true })} ${selectedAct.name}${ptPreviewSuffix}`
      : (draft.action_id || '未选择');
    const changed = Boolean(
      draft.action_id &&
      (isBatch
        ? targetTakes.some(tk => draft.action_id !== (tk.action_id || '') || (draft.point_id || '') !== (tk.point_id || ''))
        : (draft.action_id !== (take.action_id || '') || (draft.point_id || '') !== (take.point_id || '')))
    );
    if (previewEl) {
      setTextIfChanged(
        previewEl,
        changed
          ? (isBatch
              ? `将把已选 ${targetTakes.length} 条记录统一改归至「${targetLabel}」（归档序号将重新排列）`
              : `将由「${origLabel}」改为「${targetLabel}」（两项的归档序号将重新排列）`)
          : '请从上方选择与当前不同的拍摄项或点位'
      );
    }

    const confirmBtn = el('btn-reassign-confirm');
    if (confirmBtn) {
      const pendingEdit = getPendingTakeEdit(projectId, takeId);
      const anyLocked = targetTakes.some(tk => isReassignLocked(tk));
      setDisabledIfChanged(confirmBtn, Boolean(recordingActive || anyLocked || !changed || editPending));
      setTextIfChanged(confirmBtn, (pendingEdit?.kind === 'reassign' || rt.batchOperationInFlight === 'reassign') ? '正在提交…' : '确认修改');
    }
  }

  const inputSearch = el('input-reassign-search');
  const sheetBody = el('reassign-sheet-body');
  const btnConfirm = el('btn-reassign-confirm');
  const btnCancel = el('btn-reassign-cancel');

  const onSearchInput = () => {
    const cur = resolveCurrentTarget();
    if (!cur.projId || cur.ids.length === 0) return;
    const draftKey = resolveDraftKey(cur.projId, cur.ids);
    const draft = state.reassignDrafts.get(draftKey) || { action_id: '', point_id: '', query: '', scrollTop: 0 };
    draft.query = inputSearch.value;
    state.reassignDrafts.set(draftKey, draft);
    render();
  };
  const onBodyScroll = e => {
    const cur = resolveCurrentTarget();
    if (!cur.projId || cur.ids.length === 0) return;
    const draft = state.reassignDrafts.get(resolveDraftKey(cur.projId, cur.ids));
    if (draft) draft.scrollTop = e.target.scrollTop;
  };
  const onConfirm = () => {
    const cur = resolveCurrentTarget();
    if (!cur.projId || cur.ids.length === 0) return;
    const draft = state.reassignDrafts.get(resolveDraftKey(cur.projId, cur.ids));
    if (!draft?.action_id) return;
    if (cur.ids.length > 1) {
      void reassignTakes(cur.ids, draft.action_id, draft.point_id ?? '', cur.projId);
    } else {
      void reassignTake(cur.ids[0], draft.action_id, draft.point_id ?? '', cur.projId);
    }
  };
  const onCancel = () => {
    const cur = resolveCurrentTarget();
    if (cur.projId && cur.ids.length > 0) {
      state.reassignDrafts.delete(resolveDraftKey(cur.projId, cur.ids));
    }
    state.editingReassignTakeId = null;
    state.editingReassignTakeIds = [];
    state.editingReassignProjectId = '';
    state.reassignSurface = 'records';
    void closeDialog(el('modal-reassign'));
  };

  function mount() {
    inputSearch?.addEventListener('input', onSearchInput);
    sheetBody?.addEventListener('scroll', onBodyScroll, { passive: true });
    btnConfirm?.addEventListener('click', onConfirm);
    btnCancel?.addEventListener('click', onCancel);
  }

  function destroy() {
    inputSearch?.removeEventListener('input', onSearchInput);
    sheetBody?.removeEventListener('scroll', onBodyScroll);
    btnConfirm?.removeEventListener('click', onConfirm);
    btnCancel?.removeEventListener('click', onCancel);
    clearCaches();
  }

  return { mount, render, clearCaches, destroy };
}
