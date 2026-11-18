import { ICONS } from '../core/constants.mjs';
import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setAttrIfChanged,
  setDataIfChanged,
  setClassIfChanged,
  reconcileChildOrder,
  reconcileKeyedList,
} from '../core/dom-utils.mjs';
import {
  describeTargetCameras,
  formatTakeCameraSummary,
  getTakeDurationMs,
  formatElapsedMs,
  findTemplateAction,
  formatHumanSeq,
  formatHumanPointName,
  isValidTargetCameras,
} from '../core/formatters.mjs';
import { isTakeLocallyAcked } from '../core/ledger.mjs';

export function createRecordsView({ root, doc, storage, callbacks }) {
  const el = id => root.querySelector(`#${id}`);

  const handoffCellCache = new Map();
  const filterPillCache = new Map();
  const takeItemCache = new Map();
  let emptyTakesHintEl = null;

  const btnSync = el('btn-records-sync');
  const btnSelectAll = el('btn-records-select-all');
  const btnClearSel = el('btn-records-clear-selection');
  const btnBatchDiscard = el('btn-batch-discard-toggle');
  const btnBatchReassign = el('btn-batch-reassign');

  let lastVm = null;

  const onSyncClick = () => callbacks.onSyncProject();
  const onSelectAllClick = () => {
    if (!lastVm) return;
    callbacks.onSelectAllFiltered(lastVm._filteredTakeIds || []);
  };
  const onClearSelClick = () => callbacks.onClearSelection();
  const onBatchDiscardClick = () => {
    if (!lastVm || btnBatchDiscard?.disabled) return;
    const mode = btnBatchDiscard.dataset.batchMode;
    const ids = lastVm._selectedTakeIds || [];
    if (!ids.length) return;
    callbacks.onBatchDiscard(ids, mode !== 'restore');
  };
  const onBatchReassignClick = () => {
    if (!lastVm || btnBatchReassign?.disabled) return;
    const ids = lastVm._selectedTakeIds || [];
    if (!ids.length) return;
    callbacks.onOpenBatchReassign(ids, btnBatchReassign);
  };

  function mount() {
    btnSync?.addEventListener('click', onSyncClick);
    btnSelectAll?.addEventListener('click', onSelectAllClick);
    btnClearSel?.addEventListener('click', onClearSelClick);
    btnBatchDiscard?.addEventListener('click', onBatchDiscardClick);
    btnBatchReassign?.addEventListener('click', onBatchReassignClick);
  }

  function destroy() {
    btnSync?.removeEventListener('click', onSyncClick);
    btnSelectAll?.removeEventListener('click', onSelectAllClick);
    btnClearSel?.removeEventListener('click', onClearSelClick);
    btnBatchDiscard?.removeEventListener('click', onBatchDiscardClick);
    btnBatchReassign?.removeEventListener('click', onBatchReassignClick);
    handoffCellCache.clear();
    filterPillCache.clear();
    takeItemCache.clear();
    emptyTakesHintEl = null;
  }

  function getOrCreateTakeItem(rowKey, takeId) {
    let entry = takeItemCache.get(rowKey);
    if (entry) return entry;

    const itemEl = doc.createElement('div');
    itemEl.className = 'take-item';
    itemEl.setAttribute('role', 'listitem');
    itemEl.dataset.takeId = String(takeId);

    const compactRow = doc.createElement('div');
    compactRow.className = 'take-row-compact';

    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'take-select-checkbox';
    checkbox.dataset.takeSelect = String(takeId);
    checkbox.setAttribute('aria-label', `勾选记录 #${takeId}`);

    const mainCol = doc.createElement('div');
    mainCol.className = 'take-row-main';

    const titleLine = doc.createElement('div');
    titleLine.className = 'take-row-title-line';
    const idSpan = doc.createElement('span');
    idSpan.className = 'take-id-label';
    const attrSpan = doc.createElement('span');
    attrSpan.className = 'take-attr-label';
    titleLine.append(idSpan, attrSpan);

    const subLine = doc.createElement('div');
    subLine.className = 'take-subline';
    const participantsSpan = doc.createElement('span');
    participantsSpan.className = 'take-participants-label';
    participantsSpan.dataset.takeParticipants = '';
    const subRestSpan = doc.createElement('span');
    subLine.append(participantsSpan, subRestSpan);
    mainCol.append(titleLine, subLine);

    const rightCol = doc.createElement('div');
    rightCol.className = 'take-row-right';
    const durationSpan = doc.createElement('span');
    durationSpan.className = 'take-duration';
    const statusPill = doc.createElement('span');
    statusPill.className = 'status-pill';
    rightCol.append(durationSpan, statusPill);

    const expandBtn = doc.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'btn take-expand-btn';
    expandBtn.dataset.action = 'toggle-take-expand';
    expandBtn.dataset.takeId = String(takeId);
    expandBtn.setAttribute('aria-label', `展开记录 #${takeId} 逐机明细`);
    expandBtn.setAttribute('aria-expanded', 'false');
    expandBtn.innerHTML = ICONS.chevronDown;

    compactRow.append(checkbox, mainCol, rightCol, expandBtn);

    const detailsBox = doc.createElement('div');
    detailsBox.className = 'take-item-details';
    detailsBox.hidden = true;

    const camSummaryDiv = doc.createElement('div');
    camSummaryDiv.className = 'take-cam-summary';
    const camASpan = doc.createElement('span');
    const camBSpan = doc.createElement('span');
    const obsNoteSpan = doc.createElement('span');
    obsNoteSpan.hidden = true;
    camSummaryDiv.append(camASpan, camBSpan, obsNoteSpan);

    const detailActions = doc.createElement('div');
    detailActions.className = 'take-detail-actions';

    const btnLocalAck = doc.createElement('button');
    btnLocalAck.type = 'button';
    btnLocalAck.className = 'btn btn-outline-acked';
    btnLocalAck.dataset.action = 'toggle-local-ack';
    btnLocalAck.dataset.takeId = String(takeId);
    btnLocalAck.hidden = true;

    const btnDiscard = doc.createElement('button');
    btnDiscard.type = 'button';
    btnDiscard.className = 'btn';
    btnDiscard.dataset.action = 'toggle-discard';
    btnDiscard.dataset.takeId = String(takeId);
    const btnDiscardLabel = doc.createElement('span');
    btnDiscard.appendChild(btnDiscardLabel);

    const btnReassign = doc.createElement('button');
    btnReassign.type = 'button';
    btnReassign.className = 'btn';
    btnReassign.dataset.action = 'open-reassign';
    btnReassign.dataset.takeId = String(takeId);
    const btnReassignLabel = doc.createElement('span');
    btnReassignLabel.textContent = '修改拍摄项';
    btnReassign.appendChild(btnReassignLabel);

    detailActions.append(btnLocalAck, btnDiscard, btnReassign);
    detailsBox.append(camSummaryDiv, detailActions);
    itemEl.append(compactRow, detailsBox);

    checkbox.addEventListener('change', () => {
      if (!itemEl.isConnected) return;
      callbacks.onToggleRecordSelect(takeId, Boolean(checkbox.checked));
    });
    expandBtn.addEventListener('click', () => {
      if (!itemEl.isConnected) return;
      callbacks.onToggleRecordExpand(takeId);
    });
    btnLocalAck.addEventListener('click', () => {
      if (!itemEl.isConnected) return;
      callbacks.onToggleLocalAck(takeId);
    });
    btnDiscard.addEventListener('click', () => {
      if (!itemEl.isConnected) return;
      callbacks.onToggleDiscard(takeId);
    });
    btnReassign.addEventListener('click', () => {
      if (!itemEl.isConnected) return;
      callbacks.onOpenReassign(takeId, 'records', btnReassign);
    });

    entry = {
      itemEl,
      checkbox,
      idSpan,
      attrSpan,
      subLine,
      participantsSpan,
      subRestSpan,
      durationSpan,
      statusPill,
      expandBtn,
      detailsBox,
      camASpan,
      camBSpan,
      obsNoteSpan,
      btnLocalAck,
      btnDiscard,
      btnDiscardLabel,
      btnReassign,
      btnReassignLabel,
    };
    takeItemCache.set(rowKey, entry);
    return entry;
  }

  function render(vm) {
    const {
      status,
      template,
      ledger,
      connected,
      syncingLog,
      ledgerReadError,
      ledgerSyncBlocked,
      localLedgerIncomplete,
      control,
      recordsFilter,
      selectedRecordTakeIds,
      expandedRecordTakeIds,
      batchOperationInFlight,
      hasTakeEditInProgress,
      getPendingTakeEdit,
      isReassignLocked,
    } = vm;

    const projectId = status.project_id;
    const ledgerProjectOk = Boolean(!ledgerReadError && projectId && ledger.project_id === projectId);
    const takesDesc = [...ledger.takes].sort((a, b) => b.take_id - a.take_id);

    // Filter counts & valid count (never count unended or unacked abnormal takes as valid)
    let countValid = 0;
    let countDiscarded = 0;
    let countAbnormal = 0;
    for (const tk of takesDesc) {
      if (tk.discarded) {
        countDiscarded += 1;
      } else {
        const acked = tk.ended && !tk.complete && isTakeLocallyAcked(storage, ledger.project_id, tk.take_id);
        if (!tk.ended || (!tk.complete && !acked) || tk.observation_lost) {
          countAbnormal += 1;
        }
        if (tk.ended && (tk.complete || acked)) {
          countValid += 1;
        }
      }
    }

    setTextIfChanged(el('takes-count-badge'), `有效 ${countValid} / 共 ${takesDesc.length} 条`);
    setHiddenIfChanged(el('records-clip-incomplete-note'), !localLedgerIncomplete);
    setDisabledIfChanged(btnSync, !connected || syncingLog || !projectId);

    const navRecordsLabel = el('nav-records-label');
    if (navRecordsLabel) {
      setTextIfChanged(navRecordsLabel, takesDesc.length > 0 ? `记录 ${takesDesc.length}` : '记录');
    }

    // Handoff Summary (keyed in-place updates — zero replaceChildren!)
    const handoffEl = el('records-handoff-summary');
    if (handoffEl) {
      const abnormalUnacked = takesDesc.filter(
        t => t.ended && !t.complete && !t.discarded && !isTakeLocallyAcked(storage, ledger.project_id, t.take_id)
      ).length;
      const localAckedTotal = takesDesc.filter(
        t => t.ended && !t.complete && !t.discarded && isTakeLocallyAcked(storage, ledger.project_id, t.take_id)
      ).length;
      const orphanPointsTotal = template.actions.reduce(
        (sum, act) => sum + (act.points?.filter(pt => pt.orphan)?.length || 0), 0
      );
      const cells = [
        { key: 'dev', label: '设备总条数', val: `${status.take_id ?? 0} 条` },
        { key: 'local', label: '本机已存', val: `${takesDesc.length} 条` },
        { key: 'abn', label: '异常 / 已确认', val: `${abnormalUnacked} 未确认 / ${localAckedTotal} 已确认` },
        { key: 'orphan', label: '待补中文点位', val: `${orphanPointsTotal} 个` },
      ];
      reconcileKeyedList(
        handoffEl,
        cells,
        handoffCellCache,
        c => c.key,
        () => {
          const box = doc.createElement('div');
          box.className = 'handoff-kv';
          const kl = doc.createElement('span');
          kl.className = 'kv-label';
          const vl = doc.createElement('span');
          vl.className = 'kv-value';
          box.append(kl, vl);
          return { box, kl, vl };
        },
        (entry, c) => {
          setTextIfChanged(entry.kl, c.label);
          setTextIfChanged(entry.vl, c.val);
        },
        entry => entry.box
      );
    }

    const filterDefs = [
      { key: 'all', label: `全部 ${takesDesc.length}` },
      { key: 'valid', label: `有效 ${countValid}` },
      { key: 'discarded', label: `废片 ${countDiscarded}` },
      { key: 'abnormal', label: `异常 ${countAbnormal}` },
    ];
    const filterPillsEl = el('records-filter-pills');
    if (filterPillsEl) {
      reconcileKeyedList(
        filterPillsEl,
        filterDefs,
        filterPillCache,
        f => f.key,
        f => {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-btn status-chip-btn';
          btn.dataset.recordsFilter = f.key;
          btn.addEventListener('click', () => callbacks.onRecordsFilter(f.key));
          return btn;
        },
        (btn, f) => {
          setTextIfChanged(btn, f.label);
          const active = recordsFilter === f.key;
          setClassIfChanged(btn, 'is-active', active);
          setAttrIfChanged(btn, 'aria-pressed', active ? 'true' : 'false');
        }
      );
    }

    const filteredTakes = takesDesc.filter(tk => {
      if (recordsFilter === 'discarded') return Boolean(tk.discarded);
      if (recordsFilter === 'valid') {
        if (tk.discarded) return false;
        const acked = tk.ended && !tk.complete && isTakeLocallyAcked(storage, ledger.project_id, tk.take_id);
        return Boolean(tk.ended && (tk.complete || acked));
      }
      if (recordsFilter === 'abnormal') {
        if (tk.discarded) return false;
        const acked = tk.ended && !tk.complete && isTakeLocallyAcked(storage, ledger.project_id, tk.take_id);
        return Boolean(!tk.ended || (!tk.complete && !acked) || tk.observation_lost);
      }
      return true;
    });

    const filteredTakeIds = filteredTakes.map(t => t.take_id);
    setDisabledIfChanged(btnSelectAll, filteredTakes.length === 0);
    setDisabledIfChanged(btnClearSel, selectedRecordTakeIds.size === 0);

    const takesListEl = el('recent-takes-list');
    if (takesListEl) {
      if (filteredTakes.length === 0) {
        if (!emptyTakesHintEl) {
          emptyTakesHintEl = doc.createElement('p');
          emptyTakesHintEl.className = 'empty-hint';
        }
        setTextIfChanged(
          emptyTakesHintEl,
          ledgerReadError
            ? '手机记录读取失败，已暂停显示片段；请保留缓存并修复后同步记录。'
            : takesDesc.length > 0
              ? '当前筛选条件下没有拍摄记录'
              : '还没有拍摄记录。拍完后点击“同步”查看。'
        );
        reconcileChildOrder(takesListEl, [emptyTakesHintEl]);
      } else {
        reconcileKeyedList(
          takesListEl,
          filteredTakes,
          takeItemCache,
          tk => `${projectId || ''}:${tk.take_id}`,
          tk => getOrCreateTakeItem(`${projectId || ''}:${tk.take_id}`, tk.take_id),
          (entry, take) => {
            const isSelected = selectedRecordTakeIds.has(take.take_id);
            const isExpanded = expandedRecordTakeIds.has(take.take_id);
            const editInProgress = hasTakeEditInProgress(projectId, take.take_id);
            const pendingEdit = getPendingTakeEdit(projectId, take.take_id);
            const isAbnKeepEligible = Boolean(
              !ledgerReadError &&
              ledgerProjectOk &&
              take.ended &&
              !take.complete &&
              !take.discarded
            );
            const isLocallyAcked = isAbnKeepEligible && isTakeLocallyAcked(storage, ledger.project_id, take.take_id);
            const isAbnormal = Boolean(take.ended && !take.complete && !take.discarded && !isLocallyAcked);

            setClassIfChanged(entry.itemEl, 'is-selected', isSelected);
            setClassIfChanged(entry.itemEl, 'is-discarded', Boolean(take.discarded));
            setClassIfChanged(entry.itemEl, 'is-abnormal-take', isAbnormal);
            setDataIfChanged(entry.itemEl, 'participants', String(take.participants || 0));
            setDataIfChanged(entry.itemEl, 'pendingTakeId', editInProgress ? String(take.take_id) : null);

            if (entry.checkbox.checked !== isSelected) {
              entry.checkbox.checked = isSelected;
            }
            setAttrIfChanged(entry.expandBtn, 'aria-expanded', isExpanded ? 'true' : 'false');

            const tplAction = findTemplateAction(template, take.template_id, take.action_id);
            const ptObj = tplAction?.points?.find(p => p.point_id === take.point_id);
            const actionLabel = tplAction
              ? `${formatHumanSeq(tplAction, { compact: true })} ${tplAction.name}`
              : (take.action_id || '尚未选择拍摄项');
            const pointLabel = take.point_id
              ? (tplAction
                ? ` · ${formatHumanPointName(ptObj, take.point_id)}`
                : ` · 点位 ${take.point_id}`)
              : '';
            const origTplAct = take.reassigned && take.initial_action_id !== take.action_id
              ? findTemplateAction(template, take.template_id, take.initial_action_id)
              : null;
            const reassignHint = take.reassigned && take.initial_action_id !== take.action_id
              ? ` · 原为${origTplAct ? formatHumanSeq(origTplAct, { compact: true }) : `${take.initial_action_id}${take.initial_point_id ? '/' + take.initial_point_id : ''}`}`
              : '';

            setTextIfChanged(entry.idSpan, `#${take.take_id}`);
            setDataIfChanged(entry.attrSpan, 'takeAction', take.action_id || '');
            setTextIfChanged(entry.attrSpan, `${actionLabel}${pointLabel}`);

            const camDesc = isValidTargetCameras(take.participants) ? describeTargetCameras(take.participants) : '未记录相机';
            const clipParts = [
              take.cam_a_clip_seq ? `A${take.cam_a_clip_seq}` : '',
              take.cam_b_clip_seq ? `B${take.cam_b_clip_seq}` : '',
            ].filter(Boolean);
            const clipTag = clipParts.length > 0 ? ` · ${clipParts.join('/')}` : '';
            const archiveTag = !take.discarded && Number.isSafeInteger(take.segment_no) && take.segment_no > 0
              ? ` · 归档第 ${take.segment_no} 条`
              : ' · 不计入归档';
            setDataIfChanged(entry.participantsSpan, 'takeParticipants', String(take.participants || 0));
            setTextIfChanged(entry.participantsSpan, camDesc);
            setTextIfChanged(entry.subRestSpan, `${clipTag}${archiveTag}${reassignHint}`);

            const duration = take.ended ? getTakeDurationMs(take) : null;
            const durationText = take.ended ? (duration !== null ? formatElapsedMs(duration) : '计时待确认') : '';
            setTextIfChanged(entry.durationSpan, durationText);

            if (take.discarded) {
              setTextIfChanged(entry.statusPill, '废片');
              setDataIfChanged(entry.statusPill, 'tone', 'muted');
            } else if (!take.ended) {
              setTextIfChanged(entry.statusPill, '未结束');
              setDataIfChanged(entry.statusPill, 'tone', 'warn');
            } else if (take.complete) {
              if (take.observation_lost) {
                setTextIfChanged(entry.statusPill, '⚠ 相机信号曾闪断');
                setDataIfChanged(entry.statusPill, 'tone', 'warn');
              } else {
                setTextIfChanged(entry.statusPill, '有效');
                setDataIfChanged(entry.statusPill, 'tone', 'ready');
              }
            } else if (isLocallyAcked) {
              setTextIfChanged(entry.statusPill, '已确认有效');
              setDataIfChanged(entry.statusPill, 'tone', 'acked');
            } else {
              setTextIfChanged(entry.statusPill, take.observation_lost ? '异常 · 相机信号曾闪断' : '异常');
              setDataIfChanged(entry.statusPill, 'tone', 'error');
            }

            // On-demand detail drawer (kept in DOM for consistent accessibility & summaries, hidden unless expanded)
            setHiddenIfChanged(entry.detailsBox, !isExpanded);
            setTextIfChanged(entry.camASpan, formatTakeCameraSummary(take.cameras?.[0], 'A', take.participants, 0, take.cam_a_clip_seq ?? null));
            setTextIfChanged(entry.camBSpan, formatTakeCameraSummary(take.cameras?.[1], 'B', take.participants, 1, take.cam_b_clip_seq ?? null));
            setHiddenIfChanged(entry.obsNoteSpan, !take.observation_lost);
            if (take.observation_lost) {
              setTextIfChanged(entry.obsNoteSpan, '过程提示：相机信号曾闪断，建议抽查视频连续性');
            }

            setHiddenIfChanged(entry.btnLocalAck, !isAbnKeepEligible);
            setDisabledIfChanged(entry.btnLocalAck, !isAbnKeepEligible);
            setAttrIfChanged(entry.btnLocalAck, 'aria-pressed', isLocallyAcked ? 'true' : 'false');
            setClassIfChanged(entry.btnLocalAck, 'is-active', isLocallyAcked);
            setTextIfChanged(entry.btnLocalAck, isLocallyAcked ? '取消确认' : '确认有效');

            const rowDiscardDisabled = Boolean(
              !connected ||
              !ledgerProjectOk ||
              ledgerSyncBlocked ||
              !take.ended ||
              editInProgress ||
              batchOperationInFlight ||
              control.mode === 'stop'
            );
            setDisabledIfChanged(entry.btnDiscard, rowDiscardDisabled);
            setAttrIfChanged(entry.btnDiscard, 'title', !take.ended ? '结束后可操作' : '');
            if (pendingEdit?.kind === 'discard' || (editInProgress && pendingEdit?.kind !== 'reassign')) {
              entry.btnDiscard.className = 'btn';
              setTextIfChanged(entry.btnDiscardLabel, '正在提交…');
            } else if (take.discarded) {
              entry.btnDiscard.className = 'btn btn-outline-ready';
              setTextIfChanged(entry.btnDiscardLabel, '恢复有效');
            } else {
              entry.btnDiscard.className = 'btn btn-outline-danger';
              setTextIfChanged(entry.btnDiscardLabel, '标为废片');
            }

            const reassignDisabled = isReassignLocked(take) || control.mode === 'stop' || batchOperationInFlight;
            setDisabledIfChanged(entry.btnReassign, reassignDisabled);
            setAttrIfChanged(entry.btnReassign, 'title', !take.ended ? '结束后可修改' : '修改拍摄项');
            setTextIfChanged(
              entry.btnReassignLabel,
              !take.ended
                ? '结束后可修改'
                : (pendingEdit?.kind === 'reassign' ? '正在提交…' : '修改拍摄项')
            );
          },
          entry => entry.itemEl
        );
      }
    }

    // Batch Bottom Bar
    const selectedTakes = takesDesc.filter(t => selectedRecordTakeIds.has(t.take_id));
    const selectedIds = selectedTakes.map(t => t.take_id);
    const hasSelection = selectedTakes.length > 0;

    setTextIfChanged(el('records-batch-count'), hasSelection ? `已选 ${selectedTakes.length} 条` : '未选记录');
    const batchIdsEl = el('records-batch-ids');
    if (batchIdsEl) {
      setHiddenIfChanged(batchIdsEl, !hasSelection);
      if (hasSelection) {
        const preview = selectedIds.slice(0, 4).map(id => `#${id}`).join(' · ');
        setTextIfChanged(batchIdsEl, selectedIds.length > 4 ? `${preview} 等` : preview);
      }
    }

    const anySelectedBusy = selectedTakes.some(t => hasTakeEditInProgress(projectId, t.take_id));
    const anySelectedUnended = selectedTakes.some(t => !t.ended);
    const batchBaseLocked = Boolean(
      !hasSelection ||
      !connected ||
      !ledgerProjectOk ||
      ledgerSyncBlocked ||
      control.mode === 'stop' ||
      anySelectedBusy ||
      batchOperationInFlight
    );

    if (btnBatchDiscard) {
      if (!hasSelection) {
        setDisabledIfChanged(btnBatchDiscard, true);
        btnBatchDiscard.className = 'btn';
        delete btnBatchDiscard.dataset.batchMode;
        setTextIfChanged(btnBatchDiscard, '请先勾选记录');
      } else {
        const allDiscarded = selectedTakes.every(t => t.discarded);
        const batchMode = allDiscarded ? 'restore' : 'discard';
        setDisabledIfChanged(btnBatchDiscard, Boolean(batchBaseLocked || anySelectedUnended));
        setDataIfChanged(btnBatchDiscard, 'batchMode', batchMode);
        btnBatchDiscard.className = batchMode === 'restore' ? 'btn btn-outline-ready' : 'btn btn-outline-danger';
        setTextIfChanged(
          btnBatchDiscard,
          batchOperationInFlight === 'discard'
            ? '正在批量提交…'
            : (batchMode === 'restore' ? `恢复有效 (${selectedTakes.length})` : `标为废片 (${selectedTakes.length})`)
        );
      }
    }

    if (btnBatchReassign) {
      const reassignBlocked = Boolean(
        batchBaseLocked ||
        anySelectedUnended ||
        !vm.templateMatches ||
        selectedTakes.some(t => isReassignLocked(t))
      );
      setDisabledIfChanged(btnBatchReassign, reassignBlocked);
      setTextIfChanged(
        btnBatchReassign,
        batchOperationInFlight === 'reassign'
          ? '正在批量改项…'
          : (hasSelection ? `修改拍摄项 (${selectedTakes.length})` : '修改拍摄项')
      );
    }

    lastVm = {
      ...vm,
      _filteredTakeIds: filteredTakeIds,
      _selectedTakeIds: selectedIds,
    };
  }

  return { mount, render, destroy };
}
