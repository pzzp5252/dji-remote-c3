import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setAttrIfChanged,
  setDataIfChanged,
} from '../core/dom-utils.mjs';
import {
  formatHumanSeq,
  formatHumanPointName,
  summarizeActionProgress,
} from '../core/formatters.mjs';
import { createShootDeck } from './shoot-deck.mjs';
import { createShootTakes } from './shoot-takes.mjs';
import { createShootQueue } from './shoot-queue.mjs';

export function createShootView({ root, doc, win, storage, callbacks }) {
  const el = id => root.querySelector(`#${id}`);

  const deck = createShootDeck({ el });
  const takes = createShootTakes({ el, doc, win, storage, callbacks });
  const queue = createShootQueue({ el, doc, callbacks });

  function mount() {
    takes.mount();
    queue.mount();
  }

  function destroy() {
    takes.destroy();
    queue.destroy();
  }

  function renderHeroAndPointDrawer(vm) {
    const {
      confirmedAction,
      status,
      template,
      ledger,
      progressAvailable,
      control,
      actionSwitchBlocked,
      orderedActions,
    } = vm;

    const confirmedSummary = confirmedAction && progressAvailable
      ? summarizeActionProgress(confirmedAction, template.template_id, ledger.progress)
      : null;

    const confirmedActionIdEl = el('confirmed-action-id');
    if (confirmedActionIdEl) {
      setDataIfChanged(confirmedActionIdEl, 'rawActionId', status.action_id || '');
      setTextIfChanged(
        confirmedActionIdEl,
        confirmedAction
          ? formatHumanSeq(confirmedAction)
          : (status.action_id ? '未收录动作' : '未选择')
      );
    }

    const heroEl = el('confirmed-action-hero');
    if (heroEl) {
      const heroState = control.mode === 'stop'
        ? 'recording'
        : !confirmedAction
          ? 'disconnected'
          : !progressAvailable
            ? 'unshot'
            : (confirmedSummary.state === 'complete' || confirmedSummary.state === 'manual_ok')
              ? 'ready'
              : (confirmedSummary.state === 'abnormal' || confirmedSummary.state === 'unfinished' || confirmedSummary.state === 'partial')
                ? 'warn'
                : 'unshot';
      setDataIfChanged(heroEl, 'heroState', heroState);
    }

    const curProgressBadge = el('current-action-progress-badge');
    if (curProgressBadge) {
      if (control.mode === 'stop') {
        setHiddenIfChanged(curProgressBadge, false);
        setDataIfChanged(curProgressBadge, 'state', 'recording');
        setTextIfChanged(curProgressBadge, '● 绑定录制中');
      } else if (!confirmedAction) {
        setHiddenIfChanged(curProgressBadge, true);
        setTextIfChanged(curProgressBadge, '');
      } else if (!progressAvailable) {
        setHiddenIfChanged(curProgressBadge, false);
        setDataIfChanged(curProgressBadge, 'state', 'disconnected');
        setTextIfChanged(curProgressBadge, '进度未知');
      } else {
        setHiddenIfChanged(curProgressBadge, false);
        if (confirmedSummary.state === 'complete') {
          setDataIfChanged(curProgressBadge, 'state', 'ready');
          setTextIfChanged(curProgressBadge, confirmedSummary.totalPoints > 0
            ? `✓ 已拍齐 ${confirmedSummary.completedPoints}/${confirmedSummary.totalPoints}`
            : `✓ 有效 ${confirmedSummary.completeCount} 条`);
        } else if (confirmedSummary.state === 'manual_ok') {
          setDataIfChanged(curProgressBadge, 'state', 'warn');
          setTextIfChanged(curProgressBadge, confirmedSummary.totalPoints > 0
            ? `◐ 已确认齐 ${confirmedSummary.coveredPoints ?? confirmedSummary.completedPoints}/${confirmedSummary.totalPoints}`
            : `◐ 已确认有效 ${confirmedSummary.localAckCount} 条`);
        } else if (confirmedSummary.state === 'abnormal') {
          const unacked = Math.max(1, confirmedSummary.abnormalCount - confirmedSummary.localAckCount);
          setDataIfChanged(curProgressBadge, 'state', 'warn');
          setTextIfChanged(curProgressBadge, `! 有异常 ${unacked} 条`);
        } else if (confirmedSummary.state === 'partial') {
          const covered = confirmedSummary.coveredPoints ?? confirmedSummary.completedPoints;
          setDataIfChanged(curProgressBadge, 'state', 'warn');
          setTextIfChanged(curProgressBadge, `✓ 已拍 ${covered}/${confirmedSummary.totalPoints} 点位`);
        } else if (confirmedSummary.state === 'unfinished') {
          setDataIfChanged(curProgressBadge, 'state', 'warn');
          setTextIfChanged(curProgressBadge, `未结束 ${confirmedSummary.unfinishedCount} 条`);
        } else {
          setDataIfChanged(curProgressBadge, 'state', 'disconnected');
          setTextIfChanged(curProgressBadge, '○ 未拍');
        }
      }
    }

    const actionGroupLine = el('confirmed-action-group-line');
    if (actionGroupLine) {
      const gText = confirmedAction ? (confirmedAction.group || '') : '';
      setTextIfChanged(actionGroupLine, gText);
      setHiddenIfChanged(actionGroupLine, !gText);
    }

    setTextIfChanged(
      el('confirmed-action-name'),
      confirmedAction
        ? confirmedAction.name
        : (status.action_id ? '未收录动作' : '请从看板或下方按钮选用第 1 项')
    );

    const actionDescEl = el('confirmed-action-desc');
    if (actionDescEl) {
      const descText = confirmedAction?.description || '';
      setTextIfChanged(actionDescEl, descText);
      setHiddenIfChanged(actionDescEl, !descText);
    }

    const customCriteriaEl = el('confirmed-action-custom-criteria');
    if (customCriteriaEl) {
      const hasCustom = Boolean(
        confirmedAction?.criteria &&
        confirmedAction.criteria !== template.default_criteria
      );
      setHiddenIfChanged(customCriteriaEl, !hasCustom);
      setTextIfChanged(customCriteriaEl, hasCustom ? `本项专用标准：${confirmedAction.criteria}` : '');
    }

    const confirmedPointIdEl = el('confirmed-point-id');
    if (confirmedPointIdEl) {
      const ptObj = confirmedAction?.points?.find(p => p.point_id === status.point_id);
      const ptDisplay = status.point_id ? formatHumanPointName(ptObj, status.point_id) : '不指定拍摄位置';
      setTextIfChanged(confirmedPointIdEl, ptDisplay);
      setAttrIfChanged(confirmedPointIdEl, 'aria-label', ptDisplay);
    }

    setDisabledIfChanged(el('btn-current-details'), !status.action_id);
    setDisabledIfChanged(el('btn-trigger-add-point'), !vm.connected || !vm.templateMatches);

    const renamePointBtn = el('btn-rename-point');
    if (renamePointBtn) {
      const orphanCount = confirmedAction?.points.filter(p => p.orphan).length || 0;
      setHiddenIfChanged(renamePointBtn, orphanCount === 0);
      setDisabledIfChanged(renamePointBtn, !vm.connected || !vm.templateMatches);
      setTextIfChanged(renamePointBtn, `补名 ${orphanCount}`);
    }

    const pendingBadgeEl = el('action-pending-badge');
    if (pendingBadgeEl) {
      setHiddenIfChanged(pendingBadgeEl, !vm.pendingSelect);
      setTextIfChanged(pendingBadgeEl, '正在切换拍摄项，请稍候');
    }

    const pointsContainer = el('points-container');
    const explicitActionPoints = confirmedAction?.points || [];
    const showPointDrawer = Boolean(confirmedAction && (explicitActionPoints.length > 0 || Boolean(status.point_id)));
    if (pointsContainer) {
      setHiddenIfChanged(pointsContainer, !showPointDrawer);
      const pointTriggerBtn = el('btn-open-point-sheet');
      if (pointTriggerBtn) {
        setDisabledIfChanged(pointTriggerBtn, Boolean(
          !vm.connected ||
          !vm.templateMatches ||
          !status.selectionSupported ||
          control.mode === 'stop'
        ));
      }
      setTextIfChanged(
        el('point-drawer-count'),
        explicitActionPoints.length > 0 ? `共 ${explicitActionPoints.length} 个点位 ›` : '切换点位 ›'
      );
    }

    const unselectedCta = el('unselected-action-cta');
    if (unselectedCta) {
      const firstAction = orderedActions[0] || null;
      const showUnselected = Boolean(
        vm.connected &&
        status.project_id &&
        vm.templateMatches &&
        !status.action_id &&
        firstAction &&
        control.mode !== 'stop'
      );
      setHiddenIfChanged(unselectedCta, !showUnselected);
      if (showUnselected && firstAction) {
        setDisabledIfChanged(unselectedCta, actionSwitchBlocked);
        setTextIfChanged(unselectedCta, `选用第 1 项（${formatHumanSeq(firstAction)} · ${firstAction.name}）开始`);
        setDataIfChanged(unselectedCta, 'actionId', firstAction.action_id);
      }
    }
  }

  function render(vm) {
    const obsText = deck.render(vm);
    renderHeroAndPointDrawer(vm);
    takes.render(vm);
    queue.render(vm);
    return obsText;
  }

  function tick(vm) {
    return deck.tick(vm);
  }

  return { mount, render, tick, destroy };
}
