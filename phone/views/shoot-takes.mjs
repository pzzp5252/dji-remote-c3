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
  formatHumanPointName,
  isValidTargetCameras,
} from '../core/formatters.mjs';
import {
  getTakesForAction,
  isTakeLocallyAcked,
} from '../core/ledger.mjs';

export function createShootTakes({ el, doc, win, storage, callbacks }) {
  const takeRowCache = new Map();
  let lastActionIdentity = '';
  let lastTakesCountForAutoScroll = 0;
  let emptyTakesFilterHintEl = null;

  const btnExpandTakes = el('btn-shoot-takes-expand');
  const btnFilterAll = el('btn-takes-filter-all');
  const btnFilterPoint = el('btn-takes-filter-point');

  const onExpandTakes = () => callbacks.onToggleTakesExpand();
  const onFilterAll = () => callbacks.onTakesPointFilter('all');
  const onFilterPoint = () => callbacks.onTakesPointFilter('current_point');

  function mount() {
    btnExpandTakes?.addEventListener('click', onExpandTakes);
    btnFilterAll?.addEventListener('click', onFilterAll);
    btnFilterPoint?.addEventListener('click', onFilterPoint);
  }

  function destroy() {
    btnExpandTakes?.removeEventListener('click', onExpandTakes);
    btnFilterAll?.removeEventListener('click', onFilterAll);
    btnFilterPoint?.removeEventListener('click', onFilterPoint);
    takeRowCache.clear();
    emptyTakesFilterHintEl = null;
  }

  function renderTakeStatusMeta(tk, vm) {
    const projId = vm.ledger.project_id;
    const acked = !tk.complete && !tk.discarded && isTakeLocallyAcked(storage, projId, tk.take_id);
    if (tk.discarded) {
      return { tier: 'discarded', pillText: '废片', pillTone: 'muted', hint: '' };
    }
    if (!tk.ended) {
      return { tier: 'unfinished', pillText: '未结束', pillTone: 'warn', hint: '正在拍摄或未收到结束确认' };
    }
    if (tk.complete) {
      if (tk.observation_lost) {
        return { tier: 'obs_lost', pillText: '⚠ 相机信号曾闪断', pillTone: 'warn', hint: '已录完但中途信号曾闪断，建议抽查确认' };
      }
      return { tier: 'valid', pillText: '✓ 有效', pillTone: 'ready', hint: '' };
    }
    if (acked) {
      return { tier: 'acked', pillText: '已确认有效', pillTone: 'acked', hint: '已由现场人员确认有效并计入完成进度' };
    }
    const reasonText = tk.observation_lost ? '相机信号曾闪断' : (tk.reason === 'cancelled' ? '已取消' : '未确认停录');
    return { tier: 'abnormal', pillText: `异常 · ${reasonText}`, pillTone: 'error', hint: '点左侧行区展开逐机证据' };
  }

  function getOrCreateTakeRow(rowKey, takeId) {
    let entry = takeRowCache.get(rowKey);
    if (entry) return entry;

    const rowEl = doc.createElement('div');
    rowEl.className = 'shoot-take-row';
    rowEl.setAttribute('role', 'listitem');
    rowEl.dataset.takeId = String(takeId);

    const topGrid = doc.createElement('div');
    topGrid.className = 'shoot-take-top';

    const mainBtn = doc.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'shoot-take-main-btn';

    const headLine = doc.createElement('div');
    headLine.className = 'shoot-take-head-line';
    const idSpan = doc.createElement('span');
    idSpan.className = 'shoot-take-id';
    const segSpan = doc.createElement('span');
    segSpan.className = 'shoot-take-seg';
    const pillSpan = doc.createElement('span');
    pillSpan.className = 'status-pill';
    headLine.append(idSpan, segSpan, pillSpan);

    const metaLine = doc.createElement('div');
    metaLine.className = 'shoot-take-meta-line';

    mainBtn.append(headLine, metaLine);

    const actionsBox = doc.createElement('div');
    actionsBox.className = 'shoot-take-actions';

    const ackBtn = doc.createElement('button');
    ackBtn.type = 'button';
    ackBtn.className = 'btn btn-outline-acked';
    ackBtn.dataset.action = 'shoot-toggle-local-ack';
    ackBtn.dataset.takeId = String(takeId);
    ackBtn.hidden = true;

    const discardBtn = doc.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'btn';
    discardBtn.dataset.action = 'shoot-toggle-discard';
    discardBtn.dataset.takeId = String(takeId);

    actionsBox.append(ackBtn, discardBtn);
    topGrid.append(mainBtn, actionsBox);

    const detailsBox = doc.createElement('div');
    detailsBox.className = 'shoot-take-details';
    detailsBox.hidden = true;

    const camALine = doc.createElement('span');
    camALine.className = 'shoot-take-cam-line';
    const camBLine = doc.createElement('span');
    camBLine.className = 'shoot-take-cam-line';
    const obsNoteLine = doc.createElement('span');
    obsNoteLine.className = 'shoot-take-cam-line';
    obsNoteLine.hidden = true;

    const reassignBtn = doc.createElement('button');
    reassignBtn.type = 'button';
    reassignBtn.className = 'btn';
    reassignBtn.dataset.action = 'shoot-open-reassign';
    reassignBtn.dataset.takeId = String(takeId);
    reassignBtn.textContent = '修改拍摄项';

    detailsBox.append(camALine, camBLine, obsNoteLine, reassignBtn);
    rowEl.append(topGrid, detailsBox);

    mainBtn.addEventListener('click', () => {
      if (!rowEl.isConnected) return;
      callbacks.onToggleShootTakeExpand(takeId);
    });
    ackBtn.addEventListener('click', () => {
      if (!rowEl.isConnected) return;
      callbacks.onToggleLocalAck(takeId);
    });
    discardBtn.addEventListener('click', () => {
      if (!rowEl.isConnected) return;
      callbacks.onToggleDiscard(takeId);
    });
    reassignBtn.addEventListener('click', () => {
      if (!rowEl.isConnected) return;
      callbacks.onOpenReassign(takeId, 'shoot', reassignBtn);
    });

    entry = {
      rowEl,
      mainBtn,
      idSpan,
      segSpan,
      pillSpan,
      metaLine,
      ackBtn,
      discardBtn,
      detailsBox,
      camALine,
      camBLine,
      obsNoteLine,
      reassignBtn,
    };
    takeRowCache.set(rowKey, entry);
    return entry;
  }

  function render(vm) {
    const section = el('shoot-action-takes-section');
    if (!section) return;

    const { confirmedAction, status, template, ledger, control } = vm;
    const projectId = status.project_id;
    const ledgerProjectOk = Boolean(!vm.ledgerReadError && projectId && ledger.project_id === projectId);
    const hasAction = Boolean(projectId && status.action_id && vm.templateMatches);

    const allActionTakes = (ledgerProjectOk && hasAction)
      ? getTakesForAction(ledger, projectId, template.template_id, status.action_id, { descending: true })
      : [];

    const hasPointFilter = Boolean(confirmedAction && (confirmedAction.points?.length || 0) > 0 && status.point_id);
    const pointFilterBox = el('shoot-takes-point-filter');
    if (pointFilterBox) {
      setHiddenIfChanged(pointFilterBox, !hasPointFilter || allActionTakes.length === 0);
      if (hasPointFilter) {
        const ptObj = confirmedAction.points.find(p => p.point_id === status.point_id);
        const ptLabel = formatHumanPointName(ptObj, status.point_id);
        const ptCount = allActionTakes.filter(t => (t.point_id || '') === status.point_id).length;
        setTextIfChanged(btnFilterAll, `全部 ${allActionTakes.length}`);
        setTextIfChanged(btnFilterPoint, `${ptLabel} ${ptCount}`);
        const isPointMode = vm.shootTakesPointFilter === 'current_point';
        setClassIfChanged(btnFilterAll, 'is-active', !isPointMode);
        setAttrIfChanged(btnFilterAll, 'aria-pressed', !isPointMode ? 'true' : 'false');
        setClassIfChanged(btnFilterPoint, 'is-active', isPointMode);
        setAttrIfChanged(btnFilterPoint, 'aria-pressed', isPointMode ? 'true' : 'false');
      }
    }

    const visibleTakes = hasPointFilter && vm.shootTakesPointFilter === 'current_point'
      ? allActionTakes.filter(t => (t.point_id || '') === status.point_id)
      : allActionTakes;

    const shouldShowSection = Boolean(
      hasAction && (
        visibleTakes.length > 0 ||
        (allActionTakes.length > 0 && hasPointFilter) ||
        vm.recentWaitingSync ||
        vm.ledgerReadError
      )
    );
    setHiddenIfChanged(section, !shouldShowSection);
    if (!shouldShowSection) {
      const emptyListEl = el('shoot-action-takes-list');
      if (emptyListEl) {
        reconcileKeyedList(
          emptyListEl,
          [],
          takeRowCache,
          tk => `${projectId || ''}:${tk.take_id}`,
          tk => getOrCreateTakeRow(`${projectId || ''}:${tk.take_id}`, tk.take_id),
          () => {},
          entry => entry.rowEl
        );
      }
      return;
    }

    const validTakesCount = allActionTakes.filter(t => !t.discarded && t.ended && (t.complete || isTakeLocallyAcked(storage, projectId, t.take_id))).length;
    setTextIfChanged(
      el('shoot-takes-heading'),
      `本项已拍记录（共 ${allActionTakes.length} 条 · 有效 ${validTakesCount}）`
    );
    setTextIfChanged(
      el('shoot-takes-subtitle'),
      control.mode === 'stop' ? '录制期间锁定改写，可看历史' : '点行左侧展开逐机证据 / 修改拍摄项'
    );

    const syncNote = el('shoot-takes-sync-note');
    if (syncNote) {
      if (vm.ledgerReadError) {
        setHiddenIfChanged(syncNote, false);
        setTextIfChanged(syncNote, '手机记录读取失败，请先核对或同步');
      } else if (vm.recentWaitingSync) {
        setHiddenIfChanged(syncNote, false);
        setTextIfChanged(syncNote, `#${status.take_id} 记录同步中，请稍候…`);
      } else {
        setHiddenIfChanged(syncNote, true);
        setTextIfChanged(syncNote, '');
      }
    }

    const isShortHeight = Number.isFinite(win?.innerHeight) && win.innerHeight < 700;
    const collapseLimit = control.mode === 'stop' ? 1 : 2;
    const needsCollapse = isShortHeight && visibleTakes.length > collapseLimit;
    const isExpandedAll = Boolean(vm.shootTakesExpanded);
    const renderedTakes = needsCollapse && !isExpandedAll
      ? visibleTakes.slice(0, collapseLimit)
      : visibleTakes;

    if (btnExpandTakes) {
      setHiddenIfChanged(btnExpandTakes, !needsCollapse);
      if (needsCollapse) {
        setTextIfChanged(
          btnExpandTakes,
          isExpandedAll ? `收起（仅看最新 ${collapseLimit} 条） ▴` : `看全部 ${visibleTakes.length} 条 ▾`
        );
      }
    }

    const listEl = el('shoot-action-takes-list');
    if (listEl) {
      if (renderedTakes.length === 0) {
        if (!vm.recentWaitingSync && !vm.ledgerReadError) {
          if (!emptyTakesFilterHintEl) {
            emptyTakesFilterHintEl = doc.createElement('p');
            emptyTakesFilterHintEl.className = 'empty-hint';
            emptyTakesFilterHintEl.textContent = '当前点位尚无已拍记录（可切换“全部”查看）';
          }
          reconcileChildOrder(listEl, [emptyTakesFilterHintEl]);
        } else {
          reconcileChildOrder(listEl, []);
        }
      } else {
        reconcileKeyedList(
          listEl,
          renderedTakes,
          takeRowCache,
          tk => `${projectId || ''}:${tk.take_id}`,
          tk => getOrCreateTakeRow(`${projectId || ''}:${tk.take_id}`, tk.take_id),
          (entry, tk) => {
            const meta = renderTakeStatusMeta(tk, vm);
            const isExpanded = vm.expandedShootTakeIds.has(tk.take_id);
            const editInProgress = vm.hasTakeEditInProgress(projectId, tk.take_id);
            const pendingEdit = vm.getPendingTakeEdit(projectId, tk.take_id);

            setDataIfChanged(entry.rowEl, 'tier', meta.tier);
            setDataIfChanged(entry.rowEl, 'pendingTakeId', editInProgress ? String(tk.take_id) : null);
            setAttrIfChanged(entry.mainBtn, 'aria-expanded', isExpanded ? 'true' : 'false');

            setTextIfChanged(entry.idSpan, `#${tk.take_id}`);
            setTextIfChanged(
              entry.segSpan,
              !tk.discarded && Number.isSafeInteger(tk.segment_no) && tk.segment_no > 0
                ? `· 归档第 ${tk.segment_no} 条`
                : '· 不计入归档'
            );
            setTextIfChanged(entry.pillSpan, meta.pillText);
            setDataIfChanged(entry.pillSpan, 'tone', meta.pillTone);

            const camDesc = isValidTargetCameras(tk.participants) ? describeTargetCameras(tk.participants) : '未记录相机';
            const ptObj = confirmedAction?.points?.find(p => p.point_id === tk.point_id);
            const ptSuffix = tk.point_id ? ` · ${formatHumanPointName(ptObj, tk.point_id)}` : '';
            const durMs = tk.ended ? getTakeDurationMs(tk) : null;
            const durSuffix = tk.ended ? ` · ${durMs !== null ? formatElapsedMs(durMs) : '计时待确认'}` : '';
            const hintSuffix = meta.hint ? ` · ${meta.hint}` : '';
            setTextIfChanged(entry.metaLine, `${camDesc}${ptSuffix}${durSuffix}${hintSuffix}`);

            const lockedRecording = control.mode === 'stop';
            const globalBlocked = Boolean(
              !vm.connected ||
              !ledgerProjectOk ||
              vm.ledgerSyncBlocked ||
              vm.recentWaitingSync ||
              editInProgress ||
              vm.batchOperationInFlight ||
              lockedRecording
            );

            const showAck = Boolean(!lockedRecording && ledgerProjectOk && tk.ended && !tk.complete && !tk.discarded);
            setHiddenIfChanged(entry.ackBtn, !showAck);
            if (showAck) {
              const acked = isTakeLocallyAcked(storage, projectId, tk.take_id);
              setDisabledIfChanged(entry.ackBtn, false);
              setAttrIfChanged(entry.ackBtn, 'aria-pressed', acked ? 'true' : 'false');
              setClassIfChanged(entry.ackBtn, 'is-active', acked);
              setTextIfChanged(entry.ackBtn, acked ? '取消确认' : '确认有效');
            }

            if (lockedRecording) {
              setHiddenIfChanged(entry.discardBtn, false);
              setDisabledIfChanged(entry.discardBtn, true);
              entry.discardBtn.className = 'btn btn-muted-outline';
              setTextIfChanged(entry.discardBtn, '录制锁定');
            } else if (!tk.ended) {
              setHiddenIfChanged(entry.discardBtn, true);
            } else {
              setHiddenIfChanged(entry.discardBtn, false);
              setDisabledIfChanged(entry.discardBtn, globalBlocked);
              if (pendingEdit?.kind === 'discard' || (editInProgress && pendingEdit?.kind !== 'reassign')) {
                entry.discardBtn.className = 'btn';
                setTextIfChanged(entry.discardBtn, '提交中…');
              } else if (tk.discarded) {
                entry.discardBtn.className = 'btn btn-outline-ready';
                setTextIfChanged(entry.discardBtn, '恢复有效');
              } else {
                entry.discardBtn.className = 'btn btn-outline-danger';
                setTextIfChanged(entry.discardBtn, '标为废片');
              }
            }

            setHiddenIfChanged(entry.detailsBox, !isExpanded);
            setTextIfChanged(entry.camALine, formatTakeCameraSummary(tk.cameras?.[0], 'A', tk.participants, 0, tk.cam_a_clip_seq ?? null));
            setTextIfChanged(entry.camBLine, formatTakeCameraSummary(tk.cameras?.[1], 'B', tk.participants, 1, tk.cam_b_clip_seq ?? null));
            setHiddenIfChanged(entry.obsNoteLine, !tk.observation_lost);
            if (tk.observation_lost) {
              setTextIfChanged(entry.obsNoteLine, '过程提示：相机信号曾闪断，建议抽查视频连续性');
            }
            const reassignDisabled = vm.isReassignLocked(tk) || lockedRecording || vm.recentWaitingSync || Boolean(vm.batchOperationInFlight);
            setDisabledIfChanged(entry.reassignBtn, reassignDisabled);
            setTextIfChanged(
              entry.reassignBtn,
              !tk.ended ? '结束后可修改' : (pendingEdit?.kind === 'reassign' ? '正在提交…' : '修改拍摄项')
            );
          },
          entry => entry.rowEl
        );
      }
    }

    const actionKey = `${projectId}::${status.action_id}`;
    const midEl = el('shoot-middle-scroll');
    if (actionKey !== lastActionIdentity) {
      lastActionIdentity = actionKey;
      lastTakesCountForAutoScroll = allActionTakes.length;
      if (midEl && vm.activeView === 'shoot') midEl.scrollTop = 0;
    } else if (allActionTakes.length > lastTakesCountForAutoScroll) {
      lastTakesCountForAutoScroll = allActionTakes.length;
      if (midEl && vm.activeView === 'shoot' && midEl.scrollTop < 48) {
        midEl.scrollTop = 0;
      }
    }
  }

  return { mount, render, destroy };
}
