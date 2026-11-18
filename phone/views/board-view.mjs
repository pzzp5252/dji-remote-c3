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
  formatHumanAreaName,
  formatHumanSeq,
  formatRoomAndHood,
  filterActions,
  summarizeActionProgress,
} from '../core/formatters.mjs';
import { getTakesForAction, isTakeLocallyAcked } from '../core/ledger.mjs';

export function createBoardView({ root, doc, storage, callbacks }) {
  const el = id => root.querySelector(`#${id}`);

  const groupPillCache = new Map();
  const typePillCache = new Map();
  const statusPillCache = new Map();
  const actionRowCache = new Map();
  let emptyActionHintEl = null;

  let lastState = null;

  const searchInput = el('input-action-search');
  const onSearchInput = () => {
    if (!searchInput) return;
    callbacks.onSearchChange(searchInput.value);
  };

  function mount() {
    searchInput?.addEventListener('input', onSearchInput);
  }

  function destroy() {
    searchInput?.removeEventListener('input', onSearchInput);
    groupPillCache.clear();
    typePillCache.clear();
    statusPillCache.clear();
    actionRowCache.clear();
    emptyActionHintEl = null;
  }

  function formatTakeBadgeText(take, projectId) {
    const segPart = !take.discarded && Number.isSafeInteger(take.segment_no) && take.segment_no > 0
      ? `归档第 ${take.segment_no} 条`
      : '不计入归档';
    if (take.discarded) {
      return { text: `#${take.take_id} · 废片 · ${segPart}`, tone: 'muted' };
    }
    if (!take.ended) {
      return { text: `#${take.take_id} · 未结束 · ${segPart}`, tone: 'warn' };
    }
    if (take.complete) {
      if (take.observation_lost) {
        return { text: `#${take.take_id} · ⚠ 相机信号曾闪断 · ${segPart}`, tone: 'warn' };
      }
      return { text: `#${take.take_id} · ✓ 有效 · ${segPart}`, tone: 'ready' };
    }
    const acked = isTakeLocallyAcked(storage, projectId, take.take_id);
    if (acked) {
      return { text: `#${take.take_id} · 已确认有效 · ${segPart}`, tone: 'acked' };
    }
    return { text: `#${take.take_id} · 异常 · ${segPart}`, tone: 'error' };
  }

  function getOrCreateActionRow(actionId) {
    let entry = actionRowCache.get(actionId);
    if (entry) return entry;

    const cardEl = doc.createElement('div');
    cardEl.className = 'action-row-card';
    cardEl.setAttribute('role', 'listitem');
    cardEl.dataset.actionCard = actionId;

    const rowBtn = doc.createElement('button');
    rowBtn.type = 'button';
    rowBtn.className = 'action-row-btn';
    rowBtn.dataset.actionId = actionId;

    const leftSpan = doc.createElement('span');
    leftSpan.className = 'action-row-left';

    const idCol = doc.createElement('span');
    idCol.className = 'action-row-id-col';

    const idSpan = doc.createElement('span');
    idSpan.className = 'action-row-id';
    idCol.appendChild(idSpan);

    const infoSpan = doc.createElement('span');
    infoSpan.className = 'action-row-info';

    const titleSpan = doc.createElement('span');
    titleSpan.className = 'action-row-title';

    const metaSpan = doc.createElement('span');
    metaSpan.className = 'action-row-meta';
    const placeSpan = doc.createElement('span');
    placeSpan.className = 'action-row-place';
    const sepSpan = doc.createElement('span');
    sepSpan.textContent = ' · ';
    const statusSpan = doc.createElement('span');
    statusSpan.className = 'action-row-status-inline';
    metaSpan.append(placeSpan, sepSpan, statusSpan);

    infoSpan.append(titleSpan, metaSpan);
    leftSpan.append(idCol, infoSpan);
    rowBtn.appendChild(leftSpan);

    const goBtn = doc.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'btn action-row-go-btn';
    goBtn.dataset.selectConfirm = actionId;

    const expandPanel = doc.createElement('div');
    expandPanel.className = 'action-row-expand';
    expandPanel.hidden = true;

    const expandDesc = doc.createElement('p');
    expandDesc.className = 'action-expand-desc';

    const expandCriteria = doc.createElement('p');
    expandCriteria.className = 'action-expand-criteria';

    const expandTakes = doc.createElement('div');
    expandTakes.className = 'action-expand-takes';

    expandPanel.append(expandDesc, expandCriteria, expandTakes);
    cardEl.append(rowBtn, goBtn, expandPanel);

    rowBtn.addEventListener('click', () => {
      const currentActionId = rowBtn.dataset.actionId || '';
      if (currentActionId) callbacks.onToggleExpand(currentActionId);
    });

    goBtn.addEventListener('click', () => {
      const currentActionId = goBtn.dataset.selectConfirm || '';
      if (currentActionId) callbacks.onSelectAction(currentActionId);
    });

    entry = {
      cardEl,
      rowBtn,
      idSpan,
      titleSpan,
      placeSpan,
      statusSpan,
      goBtn,
      expandPanel,
      expandDesc,
      expandCriteria,
      expandTakes,
      takeTagCache: new Map(),
    };
    actionRowCache.set(actionId, entry);
    return entry;
  }

  function render(vm) {
    lastState = vm;
    const {
      template,
      ledger,
      progressAvailable,
      templateMatches,
      status,
      searchQuery,
      groupFilter,
      typeFilter,
      statusFilter,
      expandedActionId,
      pendingSelect,
      actionSwitchBlocked,
      localLedgerIncomplete,
    } = vm;

    if (searchInput && searchInput.value !== (searchQuery || '')) {
      searchInput.value = searchQuery || '';
    }

    const totalActs = template.actions.length;
    let completedTotal = 0;
    let unshotTotal = 0;
    let abnormalTotal = 0;
    let abnormalUncompletedTotal = 0;
    let stTotal = 0;
    let stDone = 0;
    let dyTotal = 0;
    let dyDone = 0;

    for (const act of template.actions) {
      if (act.type === 'static') stTotal += 1;
      else dyTotal += 1;
      if (progressAvailable) {
        const s = summarizeActionProgress(act, template.template_id, ledger.progress);
        const isDone = s.state === 'complete' || s.state === 'manual_ok';
        const unackedAbnormal = Math.max(0, s.abnormalCount - s.localAckCount);
        if (isDone) completedTotal += 1;
        else unshotTotal += 1;
        if (unackedAbnormal > 0) {
          abnormalTotal += 1;
          if (!isDone) abnormalUncompletedTotal += 1;
        }
        if (act.type === 'static' && isDone) stDone += 1;
        else if (act.type !== 'static' && isDone) dyDone += 1;
      }
    }

    const hasFilters = Boolean(
      String(searchQuery || '').trim() ||
      groupFilter !== 'all' ||
      typeFilter !== 'all' ||
      statusFilter !== 'all'
    );

    const groups = ['all', ...new Set(template.actions.map(a => a.room_key || a.group).filter(Boolean))];
    setTextIfChanged(
      el('action-region-filter-summary'),
      groupFilter === 'all' ? '房间：全部 ▾' : `房间：${groupFilter} ▾`
    );

    const groupPillsEl = el('filter-group-pills');
    if (groupPillsEl) {
      reconcileKeyedList(
        groupPillsEl,
        groups,
        groupPillCache,
        g => g,
        g => {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-btn';
          btn.dataset.groupFilter = g;
          btn.addEventListener('click', () => {
            const det = el('action-region-filter');
            if (det) det.open = false;
            callbacks.onGroupFilter(g);
          });
          return btn;
        },
        (btn, g) => {
          setTextIfChanged(btn, g === 'all' ? '全部房间' : g);
          const active = groupFilter === g;
          setClassIfChanged(btn, 'is-active', active);
          setAttrIfChanged(btn, 'aria-pressed', active ? 'true' : 'false');
        }
      );
    }

    const typeFilters = [
      { key: 'all', label: '全项' },
      { key: 'static', label: '静态' },
      { key: 'dynamic', label: '动态' },
    ];
    const typePillsEl = el('filter-type-pills');
    if (typePillsEl) {
      reconcileKeyedList(
        typePillsEl,
        typeFilters,
        typePillCache,
        tf => tf.key,
        tf => {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-btn segment-btn';
          btn.dataset.typeFilter = tf.key;
          btn.addEventListener('click', () => callbacks.onTypeFilter(tf.key));
          return btn;
        },
        (btn, tf) => {
          setTextIfChanged(btn, tf.label);
          const active = typeFilter === tf.key;
          setClassIfChanged(btn, 'is-active', active);
          setAttrIfChanged(btn, 'aria-pressed', active ? 'true' : 'false');
        }
      );
    }

    const statusFilters = [
      { key: 'unshot', label: '待拍' },
      { key: 'shot', label: '已拍' },
      { key: 'abnormal', label: '异常' },
    ];
    const statusPillsEl = el('filter-status-pills');
    if (statusPillsEl) {
      reconcileKeyedList(
        statusPillsEl,
        statusFilters,
        statusPillCache,
        sf => sf.key,
        sf => {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'pill-btn status-chip-btn';
          btn.dataset.statusFilter = sf.key;
          btn.addEventListener('click', () => {
            callbacks.onStatusFilter(lastState?.statusFilter === sf.key ? 'all' : sf.key);
          });
          return btn;
        },
        (btn, sf) => {
          const active = statusFilter === sf.key;
          setClassIfChanged(btn, 'is-active', active);
          setAttrIfChanged(btn, 'aria-pressed', active ? 'true' : 'false');
          if (sf.key === 'abnormal') {
            setHiddenIfChanged(btn, Boolean(progressAvailable && abnormalTotal === 0 && !active));
          } else {
            setHiddenIfChanged(btn, false);
          }
          const chipCount = !progressAvailable
            ? ''
            : sf.key === 'unshot'
              ? ` ${unshotTotal}`
              : sf.key === 'shot'
                ? ` ${completedTotal}`
                : ` ${abnormalTotal}`;
          setTextIfChanged(btn, `${sf.label}${chipCount}`);
        }
      );
    }

    const listProgressStatus = el('list-progress-status');
    if (listProgressStatus) {
      if (!progressAvailable) {
        setHiddenIfChanged(listProgressStatus, false);
        setDataIfChanged(listProgressStatus, 'state', 'warn');
        setTextIfChanged(listProgressStatus, '完成度未知');
      } else if (localLedgerIncomplete) {
        setHiddenIfChanged(listProgressStatus, false);
        setDataIfChanged(listProgressStatus, 'state', 'warn');
        setTextIfChanged(listProgressStatus, '副本待更新');
      } else {
        setHiddenIfChanged(listProgressStatus, true);
        setTextIfChanged(listProgressStatus, '');
      }
    }

    const filteredActions = filterActions(template.actions, {
      query: searchQuery,
      group: groupFilter,
      typeFilter,
      statusFilter: progressAvailable ? statusFilter : 'all',
      progress: progressAvailable ? ledger.progress : new Map(),
      templateId: progressAvailable ? template.template_id : '',
    });

    const areaName = formatHumanAreaName(null, template);
    setTextIfChanged(el('list-area-progress-title'), areaName);
    setTextIfChanged(
      el('action-count-badge'),
      hasFilters
        ? `筛选 ${filteredActions.length} / ${totalActs} 项`
        : (progressAvailable && stTotal > 0 && dyTotal > 0
          ? `静 ${stDone}/${stTotal} · 动 ${dyDone}/${dyTotal}`
          : `${totalActs} 项`)
    );

    const denom = Math.max(1, totalActs);
    const pct = progressAvailable ? Math.round((completedTotal / denom) * 100) : 0;
    setTextIfChanged(
      el('kpi-board-done'),
      progressAvailable ? `已完成 ${completedTotal} / ${totalActs} (${pct}%)` : `共 ${totalActs} 项`
    );
    setTextIfChanged(
      el('kpi-board-pending'),
      progressAvailable ? `待拍 ${unshotTotal} 项` : '待拍 —'
    );
    const abnKpiEl = el('kpi-board-abnormal');
    setTextIfChanged(
      abnKpiEl,
      progressAvailable ? `异常 ${abnormalTotal} 项` : '异常 —'
    );
    if (abnKpiEl) {
      setDataIfChanged(abnKpiEl, 'tone', progressAvailable && abnormalTotal > 0 ? 'warn' : 'neutral');
    }

    const fillOkEl = el('list-progress-fill-ok');
    const fillWarnEl = el('list-progress-fill-warn');
    if (fillOkEl && fillWarnEl) {
      const okPct = progressAvailable ? Math.min(100, (completedTotal / denom) * 100) : 0;
      const warnPct = progressAvailable ? Math.min(100 - okPct, (abnormalUncompletedTotal / denom) * 100) : 0;
      const okW = `${okPct.toFixed(1)}%`;
      const warnW = `${warnPct.toFixed(1)}%`;
      if (fillOkEl.style.width !== okW) fillOkEl.style.width = okW;
      if (fillWarnEl.style.width !== warnW) fillWarnEl.style.width = warnW;
    }

    const navListLabel = el('nav-list-label');
    if (navListLabel) {
      setTextIfChanged(
        navListLabel,
        progressAvailable && status.project_id ? `看板 ${completedTotal}/${totalActs}` : '看板'
      );
    }

    const actionListEl = el('action-list');
    if (actionListEl) {
      if (filteredActions.length === 0) {
        if (!emptyActionHintEl) {
          emptyActionHintEl = doc.createElement('p');
          emptyActionHintEl.className = 'empty-hint';
          emptyActionHintEl.textContent = '没有找到，试试其他关键字或切换筛选范围';
        }
        reconcileChildOrder(actionListEl, [emptyActionHintEl]);
      } else {
        const desiredNodes = [];
        for (const item of filteredActions) {
          const entry = getOrCreateActionRow(item.action_id);
          const isConfirmed = templateMatches && status.action_id === item.action_id;
          const isPending = pendingSelect?.action_id === item.action_id;
          const isExpanded = expandedActionId === item.action_id;
          const summary = progressAvailable
            ? summarizeActionProgress(item, template.template_id, ledger.progress)
            : null;
          const isDone = Boolean(summary && (summary.state === 'complete' || summary.state === 'manual_ok'));

          setClassIfChanged(entry.cardEl, 'is-confirmed', isConfirmed);
          setClassIfChanged(entry.cardEl, 'is-expanded', isExpanded);
          setClassIfChanged(entry.rowBtn, 'is-confirmed', isConfirmed);
          setClassIfChanged(entry.rowBtn, 'is-pending', isPending);
          setAttrIfChanged(entry.rowBtn, 'aria-expanded', isExpanded ? 'true' : 'false');
          setDataIfChanged(entry.rowBtn, 'actionId', item.action_id);

          setTextIfChanged(entry.idSpan, formatHumanSeq(item, { compact: true }));
          setDataIfChanged(entry.idSpan, 'kind', item.type);
          setTextIfChanged(entry.titleSpan, item.name);
          const typeLabel = item.type === 'static' ? '静态' : '动态';
          setTextIfChanged(entry.placeSpan, formatRoomAndHood(item).display || `${item.group} · ${typeLabel}`);

          if (!progressAvailable) {
            setDataIfChanged(entry.statusSpan, 'state', 'disconnected');
            setDataIfChanged(entry.statusSpan, 'progressState', 'unknown');
            setDataIfChanged(entry.statusSpan, 'takeCount', null);
            setTextIfChanged(entry.statusSpan, '进度未知');
          } else {
            setDataIfChanged(entry.statusSpan, 'progressState', summary.state);
            setDataIfChanged(
              entry.statusSpan,
              'state',
              summary.state === 'complete' ? 'ready' : summary.state === 'unshot' ? 'disconnected' : 'warn'
            );
            setDataIfChanged(entry.statusSpan, 'takeCount', String(summary.completeCount));
            if (summary.totalPoints > 0) {
              const coveredPts = summary.coveredPoints ?? summary.completedPoints;
              const unackedAbnormal = Math.max(0, summary.abnormalCount - summary.localAckCount);
              const ptParts = [
                summary.state === 'complete'
                  ? `✓ 已拍齐 ${summary.completedPoints}/${summary.totalPoints}`
                  : summary.state === 'manual_ok'
                    ? `◐ 已确认齐 ${coveredPts}/${summary.totalPoints}`
                    : `${coveredPts}/${summary.totalPoints} 点位`,
              ];
              if (unackedAbnormal > 0) ptParts.push(`异常 ${unackedAbnormal}`);
              if (summary.unfinishedCount > 0) ptParts.push(`未结 ${summary.unfinishedCount}`);
              setTextIfChanged(entry.statusSpan, ptParts.join(' · '));
            } else if (summary.state === 'complete') {
              setTextIfChanged(entry.statusSpan, `✓ 有效 ${summary.completeCount} 条`);
            } else if (summary.state === 'manual_ok') {
              setTextIfChanged(entry.statusSpan, `◐ 已确认有效 ${summary.localAckCount} 条`);
            } else if (summary.state === 'abnormal') {
              setTextIfChanged(entry.statusSpan, `! 异常 ${summary.abnormalCount} 条`);
            } else if (summary.state === 'unfinished') {
              setTextIfChanged(entry.statusSpan, `未结 ${summary.unfinishedCount} 条`);
            } else {
              setTextIfChanged(entry.statusSpan, '○ 待拍');
            }
          }

          setDisabledIfChanged(entry.goBtn, actionSwitchBlocked);
          setDataIfChanged(entry.goBtn, 'selectConfirm', item.action_id);
          if (isPending) {
            setDataIfChanged(entry.goBtn, 'goMode', 'current');
            setTextIfChanged(entry.goBtn, '切换中…');
          } else if (isDone) {
            setDataIfChanged(entry.goBtn, 'goMode', 'retake');
            setTextIfChanged(entry.goBtn, '补拍 ›');
          } else if (isConfirmed) {
            setDataIfChanged(entry.goBtn, 'goMode', 'current');
            setTextIfChanged(entry.goBtn, '当前 ›');
          } else {
            setDataIfChanged(entry.goBtn, 'goMode', 'go');
            setTextIfChanged(entry.goBtn, '去拍 ›');
          }
          setAttrIfChanged(entry.goBtn, 'aria-label', `${isDone ? '补拍' : '去拍'} ${item.name}`);

          setHiddenIfChanged(entry.expandPanel, !isExpanded);
          if (isExpanded) {
            const fullDesc = item.description ? `测试描述：${item.description}` : `测试项目：${item.name}（${item.group}）`;
            const criteriaVal = item.criteria || template.default_criteria || '';
            setTextIfChanged(entry.expandDesc, fullDesc);
            setTextIfChanged(entry.expandCriteria, criteriaVal ? `合格标准：${criteriaVal}` : '');
            setHiddenIfChanged(entry.expandCriteria, !criteriaVal);

            const itemTakes = progressAvailable
              ? getTakesForAction(ledger, ledger.project_id, template.template_id, item.action_id, { descending: false })
              : [];
            if (itemTakes.length > 0) {
              reconcileKeyedList(
                entry.expandTakes,
                itemTakes,
                entry.takeTagCache,
                tk => `tk:${tk.take_id}`,
                () => {
                  const tag = doc.createElement('span');
                  tag.className = 'badge expand-take-tag';
                  return tag;
                },
                (tag, tk) => {
                  const info = formatTakeBadgeText(tk, ledger.project_id);
                  setDataIfChanged(tag, 'state', info.tone);
                  setTextIfChanged(tag, info.text);
                }
              );
            } else {
              entry.takeTagCache.clear();
              let noneEl = entry.expandTakes.querySelector('.expand-none-hint');
              if (!noneEl) {
                noneEl = doc.createElement('span');
                noneEl.className = 'card-subtitle expand-none-hint';
                noneEl.textContent = '本项尚无已拍记录';
              }
              reconcileChildOrder(entry.expandTakes, [noneEl]);
            }
          }

          desiredNodes.push(entry.cardEl);
        }
        reconcileChildOrder(actionListEl, desiredNodes);
      }
    }
  }

  return { mount, render, destroy };
}
