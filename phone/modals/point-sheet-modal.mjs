import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setAttrIfChanged,
  setClassIfChanged,
} from '../core/dom-utils.mjs';
import {
  formatHumanSeq,
  formatHumanPointName,
  getProgressEntryKey,
} from '../core/formatters.mjs';

export function createPointSheetModalController({
  doc,
  win,
  el,
  state,
  rt,
  isProgressAvailable,
  templateMatchesDevice,
  openDialog,
  closeDialog,
  selectAction,
  showPointDialog,
  render: triggerRender,
}) {
  const pointPillCache = {
    signature: '',
    nodesByPointId: new Map(),
  };
  let pointRevealRaf = null;
  let pointRevealPending = false;
  let pointRevealIdentity = '';
  let pointFocusRaf = null;

  function updatePointOverflowMarkers() {
    const rail = el('point-pills');
    const frame = el('point-rail-frame');
    if (!rail || !frame) return;
    frame.dataset.overflowStart = rail.scrollLeft > 1 ? 'true' : 'false';
    frame.dataset.overflowEnd = rail.scrollWidth - rail.clientWidth - rail.scrollLeft > 1 ? 'true' : 'false';
  }

  function revealButtonInRail(rail, button) {
    if (!rail || !button || rt.destroyed || !el('modal-point-list')?.open) return;
    button.scrollIntoView?.({ block: 'nearest' });
    updatePointOverflowMarkers();
  }

  function schedulePointReveal() {
    pointRevealPending = true;
    const pointDlg = el('modal-point-list');
    if (pointRevealRaf !== null || rt.destroyed || !pointDlg?.open) return;
    const reveal = () => {
      pointRevealRaf = null;
      if (rt.destroyed || !el('modal-point-list')?.open) return;
      pointRevealPending = false;
      const rail = el('point-pills');
      const button = pointPillCache.nodesByPointId.get(state.status.point_id || '');
      if (rail && button) {
        revealButtonInRail(rail, button);
      } else {
        updatePointOverflowMarkers();
      }
    };
    if (typeof win?.requestAnimationFrame === 'function') pointRevealRaf = win.requestAnimationFrame(reveal);
    else reveal();
  }

  const onPointFocusIn = e => {
    const button = e.target?.closest?.('.point-pill');
    const rail = el('point-pills');
    if (!button || !rail || rt.destroyed || !el('modal-point-list')?.open || !rail.contains(button)) return;
    if (pointFocusRaf !== null && typeof win?.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(pointFocusRaf);
      pointFocusRaf = null;
    }
    const reveal = () => {
      pointFocusRaf = null;
      if (rt.destroyed || !el('modal-point-list')?.open) return;
      revealButtonInRail(rail, button);
    };
    if (typeof win?.requestAnimationFrame === 'function') {
      pointFocusRaf = win.requestAnimationFrame(reveal);
    } else {
      reveal();
    }
  };

  function render(confirmedAction, control) {
    const templateMatches = templateMatchesDevice();
    const progressAvailable = isProgressAvailable();
    const confirmedActionProgress = confirmedAction && progressAvailable
      ? state.ledger.progress.get(getProgressEntryKey(state.template.template_id, confirmedAction.action_id))
      : null;

    setTextIfChanged(
      el('point-list-subtitle'),
      confirmedAction ? `${formatHumanSeq(confirmedAction, { compact: true })} · ${confirmedAction.name}` : ''
    );
    const pointSheetAddBtn = el('btn-point-sheet-add');
    if (pointSheetAddBtn) {
      setDisabledIfChanged(pointSheetAddBtn, Boolean(!state.connected || !templateMatches || control.mode === 'stop'));
    }

    const pointPillsEl = el('point-pills');
    if (pointPillsEl) {
      if (!confirmedAction) {
        if (pointPillCache.signature !== '') {
          pointPillsEl.replaceChildren();
          pointPillCache.nodesByPointId.clear();
          pointPillCache.signature = '';
        }
      } else {
        const points = confirmedAction.points || [];
        const allPoints = [{ point_id: '', name: '不指定拍摄位置' }, ...points];
        const sig = `${confirmedAction.action_id}::${allPoints.map(p => `${p.point_id}=${p.name}=${Boolean(p.orphan)}`).join('|')}`;
        if (pointPillCache.signature !== sig) {
          pointPillsEl.replaceChildren();
          pointPillCache.nodesByPointId.clear();
          for (const pt of allPoints) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'point-pill';
            btn.dataset.pointId = pt.point_id;
            const progressMark = doc.createElement('span');
            progressMark.className = 'point-progress-mark';
            progressMark.setAttribute('aria-hidden', 'true');
            const label = doc.createElement('span');
            label.className = 'point-pill-label';
            const mark = doc.createElement('span');
            mark.className = 'point-orphan-mark';
            mark.textContent = '补名';
            btn.append(progressMark, label, mark);
            btn.addEventListener('click', () => {
              const targetActionId = state.status.action_id;
              const dlg = el('modal-point-list');
              if (dlg?.open) void closeDialog(dlg);
              if (targetActionId) {
                void selectAction(targetActionId, pt.point_id);
              }
            });
            pointPillCache.nodesByPointId.set(pt.point_id, btn);
            pointPillsEl.appendChild(btn);
          }
          pointPillCache.signature = sig;
          schedulePointReveal();
        }
        for (const pt of allPoints) {
          const btn = pointPillCache.nodesByPointId.get(pt.point_id);
          if (!btn) continue;
          const isCurrent = (state.status.point_id || '') === pt.point_id;
          const isPendingThis = Boolean(
            state.pendingSelect &&
            state.pendingSelect.action_id === confirmedAction.action_id &&
            (state.pendingSelect.point_id || '') === pt.point_id
          );
          const progressMark = btn.querySelector('.point-progress-mark');
          let shotAria = '';
          if (progressMark) {
            if (!pt.point_id || !progressAvailable) {
              setHiddenIfChanged(progressMark, true);
              delete progressMark.dataset.shot;
              setTextIfChanged(progressMark, '');
              if (pt.point_id && !progressAvailable) shotAria = ' · 完成度未知';
            } else {
              const ptStats = confirmedActionProgress?.points?.get(pt.point_id);
              let shotState = 'unshot';
              let shotGlyph = '';
              let statusLabel = '未拍';
              if ((ptStats?.completeCount || 0) > 0) {
                shotState = 'complete';
                shotGlyph = '✓';
                statusLabel = '已完成';
              } else if ((ptStats?.abnormalCount || 0) > (ptStats?.localAckCount || 0)) {
                shotState = 'abnormal';
                shotGlyph = '!';
                statusLabel = '有异常';
              } else if ((ptStats?.localAckCount || 0) > 0) {
                shotState = 'manual_ok';
                shotGlyph = '◐';
                statusLabel = '已确认有效';
              } else if ((ptStats?.unfinishedCount || 0) > 0) {
                shotState = 'unfinished';
                shotGlyph = '…';
                statusLabel = '未结束';
              }
              setHiddenIfChanged(progressMark, shotGlyph === '');
              progressMark.dataset.shot = shotState;
              setTextIfChanged(progressMark, shotGlyph);
              shotAria = ` · ${statusLabel}`;
            }
          }
          setClassIfChanged(btn, 'is-active', isCurrent);
          setClassIfChanged(btn, 'is-orphan', Boolean(pt.orphan));
          setHiddenIfChanged(btn.querySelector('.point-orphan-mark'), !pt.orphan);
          const humanName = pt.point_id ? (pt.orphan ? '未收录名称' : pt.name || '未收录名称') : '未指定点位';
          setAttrIfChanged(btn, 'aria-label', `${humanName}${shotAria}${pt.orphan ? ' · 待补中文名' : ''}`);
          setAttrIfChanged(btn, 'aria-pressed', isCurrent ? 'true' : 'false');
          setDisabledIfChanged(btn, Boolean(
            !state.connected ||
            !templateMatches ||
            !state.status.selectionSupported ||
            state.pendingSelect ||
            control.mode === 'stop'
          ));
          const displayLabel = pt.point_id ? formatHumanPointName(pt, pt.point_id) : '不指定拍摄位置';
          setTextIfChanged(
            btn.querySelector('.point-pill-label'),
            isPendingThis ? '正在切换…' : displayLabel
          );
        }
      }
    }

    const revealIdentity = `${state.status.project_id}/${state.status.action_id}/${state.status.point_id || ''}`;
    if (pointRevealIdentity !== revealIdentity) {
      pointRevealIdentity = revealIdentity;
      schedulePointReveal();
    } else if (pointRevealPending && el('modal-point-list')?.open) schedulePointReveal();
    updatePointOverflowMarkers();
  }

  const btnOpen = el('btn-open-point-sheet');
  const btnSheetAdd = el('btn-point-sheet-add');
  const btnClose = el('btn-point-list-close');
  const pointPills = el('point-pills');

  const onOpen = () => {
    const dlg = el('modal-point-list');
    if (!dlg) return;
    openDialog(dlg, { returnFocus: btnOpen });
    triggerRender();
    dlg.querySelector('.point-pill.is-active, .point-pill')?.focus?.({ preventScroll: true });
  };
  const onSheetAdd = async () => {
    await closeDialog(el('modal-point-list'), { immediate: true });
    showPointDialog({ returnFocus: btnOpen });
  };
  const onClose = () => { void closeDialog(el('modal-point-list')); };

  function mount() {
    btnOpen?.addEventListener('click', onOpen);
    btnSheetAdd?.addEventListener('click', onSheetAdd);
    btnClose?.addEventListener('click', onClose);
    pointPills?.addEventListener('scroll', updatePointOverflowMarkers, { passive: true });
    pointPills?.addEventListener('focusin', onPointFocusIn, { passive: true });
  }

  function destroy() {
    if (pointRevealRaf !== null) win?.cancelAnimationFrame?.(pointRevealRaf);
    if (pointFocusRaf !== null) win?.cancelAnimationFrame?.(pointFocusRaf);
    btnOpen?.removeEventListener('click', onOpen);
    btnSheetAdd?.removeEventListener('click', onSheetAdd);
    btnClose?.removeEventListener('click', onClose);
    pointPills?.removeEventListener('scroll', updatePointOverflowMarkers);
    pointPills?.removeEventListener('focusin', onPointFocusIn);
    pointPillCache.nodesByPointId.clear();
  }

  return {
    mount,
    render,
    schedulePointReveal,
    destroy,
  };
}
