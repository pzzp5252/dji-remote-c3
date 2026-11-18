import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setDataIfChanged,
  setClassIfChanged,
  reconcileChildOrder,
  reconcileKeyedList,
} from '../core/dom-utils.mjs';
import {
  formatHumanSeq,
  extractActionDiffParts,
  summarizeActionProgress,
  filterActions,
} from '../core/formatters.mjs';
import { summarizeGroupQueue } from '../core/ledger.mjs';

export function createShootQueue({ el, doc, callbacks }) {
  const queueRowCache = new Map();
  const completedRowCache = new Map();
  const relatedRowCache = new Map();
  const jumperRowCache = new Map();

  let jumperQuery = '';
  let lastJumperTemplateId = '';
  let emptyJumperHintEl = null;
  let lastVm = null;

  const btnNextGroupPreview = el('btn-next-group-preview');
  const btnOpenJumper = el('btn-open-action-list');
  const modalJumper = el('modal-action-jumper');
  const inputJumperSearch = el('input-jumper-search');
  const btnJumperOpenBoard = el('btn-jumper-open-board');
  const btnJumperClose = el('btn-action-jumper-close');

  const onNextGroupClick = () => {
    const targetId = btnNextGroupPreview?.dataset.targetActionId;
    if (targetId) callbacks.onSelectAction(targetId);
  };
  const onOpenJumper = () => {
    if (btnOpenJumper?.disabled) return;
    callbacks.onOpenJumper(btnOpenJumper);
  };
  const onJumperSearch = () => {
    jumperQuery = inputJumperSearch?.value || '';
    if (lastVm) renderActionJumper(lastVm);
  };
  const onJumperOpenBoard = () => {
    callbacks.onCloseJumperAndOpenBoard();
  };
  const onJumperClose = () => {
    callbacks.onCloseJumper();
  };

  function mount() {
    btnNextGroupPreview?.addEventListener('click', onNextGroupClick);
    btnOpenJumper?.addEventListener('click', onOpenJumper);
    inputJumperSearch?.addEventListener('input', onJumperSearch);
    btnJumperOpenBoard?.addEventListener('click', onJumperOpenBoard);
    btnJumperClose?.addEventListener('click', onJumperClose);
  }

  function destroy() {
    btnNextGroupPreview?.removeEventListener('click', onNextGroupClick);
    btnOpenJumper?.removeEventListener('click', onOpenJumper);
    inputJumperSearch?.removeEventListener('input', onJumperSearch);
    btnJumperOpenBoard?.removeEventListener('click', onJumperOpenBoard);
    btnJumperClose?.removeEventListener('click', onJumperClose);
    queueRowCache.clear();
    completedRowCache.clear();
    relatedRowCache.clear();
    jumperRowCache.clear();
    emptyJumperHintEl = null;
  }

  function renderGroupQueueSection(vm) {
    const queueSection = el('shoot-group-queue-section');
    if (!queueSection) return;

    const { template, confirmedAction, ledger, progressAvailable, actionSwitchBlocked } = vm;
    const q = summarizeGroupQueue(
      template,
      confirmedAction,
      progressAvailable ? ledger.progress : null,
      template.template_id
    );

    setTextIfChanged(
      el('shoot-queue-heading'),
      q.exactGroup ? `本组队列 · ${q.exactGroup}` : '本组队列'
    );
    const statParts = [];
    if (q.totalCount > 0) {
      statParts.push(`待拍 ${q.pendingCount}`);
      if (q.staticTotal > 0) statParts.push(`静 ${q.staticDone}/${q.staticTotal}`);
      if (q.dynamicTotal > 0) statParts.push(`动 ${q.dynamicDone}/${q.dynamicTotal}`);
      statParts.push(`共 ${q.totalCount} 项`);
    }
    setTextIfChanged(el('shoot-queue-stats'), statParts.join(' · '));

    if (btnOpenJumper) {
      setDisabledIfChanged(btnOpenJumper, actionSwitchBlocked);
      setDataIfChanged(btnOpenJumper, 'transientLock', (!vm.stepperHardBlocked && Boolean(vm.pendingSelect)) ? 'true' : 'false');
      setTextIfChanged(btnOpenJumper, `全部 ${template.actions.length} ▾`);
    }

    const queueListEl = el('shoot-group-queue-list');
    if (queueListEl) {
      setHiddenIfChanged(queueListEl, q.pendingItems.length === 0);
      reconcileKeyedList(
        queueListEl,
        q.pendingItems,
        queueRowCache,
        item => item.action.action_id,
        item => {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'btn group-queue-row';
          btn.dataset.queueActionId = item.action.action_id;

          const mainCol = doc.createElement('span');
          mainCol.className = 'group-queue-main';

          const titleLine = doc.createElement('span');
          titleLine.className = 'group-queue-title-line';
          const seqSpan = doc.createElement('span');
          seqSpan.className = 'group-queue-seq';
          const nameSpan = doc.createElement('span');
          nameSpan.className = 'group-queue-name';
          titleLine.append(seqSpan, nameSpan);

          const descSpan = doc.createElement('span');
          descSpan.className = 'group-queue-desc';
          mainCol.append(titleLine, descSpan);

          const badgeSpan = doc.createElement('span');
          badgeSpan.className = 'group-queue-badge';

          btn.append(mainCol, badgeSpan);
          btn.addEventListener('click', () => {
            const targetId = btn.dataset.queueActionId;
            if (targetId) callbacks.onSelectAction(targetId);
          });
          return { btn, seqSpan, nameSpan, descSpan, badgeSpan };
        },
        (entry, item) => {
          const act = item.action;
          const isCurrent = confirmedAction?.action_id === act.action_id;
          const isAbnormal = item.summary.state === 'abnormal';
          setDisabledIfChanged(entry.btn, actionSwitchBlocked);
          setClassIfChanged(entry.btn, 'is-current', isCurrent);
          setDataIfChanged(entry.btn, 'state', isAbnormal ? 'abnormal' : 'pending');
          setTextIfChanged(entry.seqSpan, formatHumanSeq(act, { compact: true }));
          setDataIfChanged(entry.seqSpan, 'kind', act.type);
          setTextIfChanged(entry.nameSpan, act.name);

          const diff = extractActionDiffParts(act, q.groupActions);
          if (diff.hasDiff) {
            setClassIfChanged(entry.descSpan, 'is-diff', true);
            setTextIfChanged(entry.descSpan, `差异：${diff.snippet}`);
            setHiddenIfChanged(entry.descSpan, false);
          } else if (act.description) {
            setClassIfChanged(entry.descSpan, 'is-diff', false);
            setTextIfChanged(entry.descSpan, act.description);
            setHiddenIfChanged(entry.descSpan, false);
          } else {
            setHiddenIfChanged(entry.descSpan, true);
            setTextIfChanged(entry.descSpan, '');
          }

          setTextIfChanged(
            entry.badgeSpan,
            isCurrent ? '当前项' : (isAbnormal ? '! 异常 ›' : '待拍 ›')
          );
        },
        entry => entry.btn
      );
    }

    const completedFold = el('shoot-group-completed-fold');
    const completedList = el('shoot-group-completed-list');
    if (completedFold && completedList) {
      setHiddenIfChanged(completedFold, q.completedItems.length === 0);
      if (q.completedItems.length > 0) {
        setTextIfChanged(
          el('shoot-group-completed-summary'),
          `✓ 本组已完成 ${q.completedItems.length} 项（点按展开可重进补拍）`
        );
        reconcileKeyedList(
          completedList,
          q.completedItems,
          completedRowCache,
          item => item.action.action_id,
          item => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'btn group-queue-row';
            btn.dataset.queueCompletedId = item.action.action_id;

            const mainCol = doc.createElement('span');
            mainCol.className = 'group-queue-main';
            const titleLine = doc.createElement('span');
            titleLine.className = 'group-queue-title-line';
            const seqSpan = doc.createElement('span');
            seqSpan.className = 'group-queue-seq';
            const nameSpan = doc.createElement('span');
            nameSpan.className = 'group-queue-name';
            titleLine.append(seqSpan, nameSpan);
            mainCol.appendChild(titleLine);

            const badgeSpan = doc.createElement('span');
            badgeSpan.className = 'group-queue-badge';
            badgeSpan.textContent = '补拍 ›';

            btn.append(mainCol, badgeSpan);
            btn.addEventListener('click', () => {
              const targetId = btn.dataset.queueCompletedId;
              if (targetId) callbacks.onSelectAction(targetId);
            });
            return { btn, seqSpan, nameSpan };
          },
          (entry, item) => {
            setDisabledIfChanged(entry.btn, actionSwitchBlocked);
            setClassIfChanged(entry.btn, 'is-current', confirmedAction?.action_id === item.action.action_id);
            setTextIfChanged(entry.seqSpan, formatHumanSeq(item.action, { compact: true }));
            setDataIfChanged(entry.seqSpan, 'kind', item.action.type);
            setTextIfChanged(entry.nameSpan, item.action.name);
          },
          entry => entry.btn
        );
      }
    }

    const relatedFold = el('shoot-related-groups-fold');
    const relatedList = el('shoot-related-groups-list');
    if (relatedFold && relatedList) {
      setHiddenIfChanged(relatedFold, q.relatedGroups.length === 0);
      if (q.relatedGroups.length > 0) {
        setTextIfChanged(
          el('shoot-related-groups-summary'),
          `同编码关联分组另有 ${q.relatedTotalCount} 项（待拍 ${q.relatedPendingCount} · 不混入本组 ${q.totalCount} 项分母）`
        );
        reconcileKeyedList(
          relatedList,
          q.relatedGroups,
          relatedRowCache,
          rel => rel.group,
          () => {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'btn group-queue-row';
            const mainCol = doc.createElement('span');
            mainCol.className = 'group-queue-main';
            const nameSpan = doc.createElement('span');
            nameSpan.className = 'group-queue-name';
            const subSpan = doc.createElement('span');
            subSpan.className = 'group-queue-desc';
            mainCol.append(nameSpan, subSpan);
            const badgeSpan = doc.createElement('span');
            badgeSpan.className = 'group-queue-badge';
            btn.append(mainCol, badgeSpan);
            btn.addEventListener('click', () => {
              const targetId = btn.dataset.targetActionId;
              if (targetId) callbacks.onSelectAction(targetId);
            });
            return { btn, nameSpan, subSpan, badgeSpan };
          },
          (entry, rel) => {
            const targetAct = rel.firstPendingAction || rel.firstAction;
            setDisabledIfChanged(entry.btn, actionSwitchBlocked || !targetAct);
            setDataIfChanged(entry.btn, 'targetActionId', targetAct?.action_id || '');
            setTextIfChanged(entry.nameSpan, rel.group);
            setTextIfChanged(entry.subSpan, `共 ${rel.totalCount} 项 · 待拍 ${rel.pendingCount} 项`);
            setTextIfChanged(entry.badgeSpan, rel.pendingCount > 0 ? '去拍 ›' : '重进 ›');
          },
          entry => entry.btn
        );
      }
    }

    if (btnNextGroupPreview) {
      if (!q.nextGroup) {
        setHiddenIfChanged(btnNextGroupPreview, true);
        setDataIfChanged(btnNextGroupPreview, 'targetActionId', '');
      } else {
        const nextTarget = q.nextGroup.firstPendingAction || q.nextGroup.firstAction;
        setHiddenIfChanged(btnNextGroupPreview, false);
        setDisabledIfChanged(btnNextGroupPreview, actionSwitchBlocked || !nextTarget);
        setDataIfChanged(btnNextGroupPreview, 'targetActionId', nextTarget?.action_id || '');
        setTextIfChanged(
          btnNextGroupPreview,
          q.nextGroup.allDone
            ? `本组完成后 → ${q.nextGroup.group} · 共 ${q.nextGroup.totalCount} 项（已全部完成） ›`
            : `本组完成后 → ${q.nextGroup.group} · 共 ${q.nextGroup.totalCount} 项（待拍 ${q.nextGroup.pendingCount} 项） ›`
        );
      }
    }

    const criteriaFold = el('shoot-criteria-source-fold');
    if (criteriaFold) {
      const defCrit = template.default_criteria || '';
      const srcDoc = template.source_doc || '';
      const docRefText = confirmedAction?.doc_ref?.section
        ? `${confirmedAction.doc_ref.section}${confirmedAction.doc_ref.seq ? ` 第 ${confirmedAction.doc_ref.seq} 项` : ''}`
        : '';
      const hasCriteriaInfo = Boolean(defCrit || srcDoc || docRefText);
      setHiddenIfChanged(criteriaFold, !hasCriteriaInfo);
      if (hasCriteriaInfo) {
        const critEl = el('shoot-default-criteria-text');
        const srcEl = el('shoot-source-doc-text');
        setHiddenIfChanged(critEl, !defCrit);
        setTextIfChanged(critEl, defCrit ? `通用合格标准：${defCrit}` : '');
        const fullSrc = [srcDoc, docRefText].filter(Boolean).join(' · ');
        setHiddenIfChanged(srcEl, !fullSrc);
        setTextIfChanged(srcEl, fullSrc ? `文件来源：${fullSrc}` : '');
      }
    }
  }

  function renderActionJumper(vm) {
    if (vm.template.template_id !== lastJumperTemplateId) {
      lastJumperTemplateId = vm.template.template_id;
      jumperQuery = '';
    }
    if (!modalJumper || !modalJumper.open) return;
    const listEl = el('action-jumper-list');
    if (!listEl) return;
    if (inputJumperSearch && inputJumperSearch.value !== jumperQuery) {
      inputJumperSearch.value = jumperQuery;
    }
    const filtered = filterActions(vm.template.actions, { query: jumperQuery });
    if (filtered.length === 0) {
      if (!emptyJumperHintEl) {
        emptyJumperHintEl = doc.createElement('p');
        emptyJumperHintEl.className = 'empty-hint';
        emptyJumperHintEl.textContent = '没有找到匹配的拍摄项';
      }
      reconcileChildOrder(listEl, [emptyJumperHintEl]);
      return;
    }
    reconcileKeyedList(
      listEl,
      filtered,
      jumperRowCache,
      act => act.action_id,
      act => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'btn jumper-item-btn';
        btn.dataset.jumperActionId = act.action_id;

        const seqSpan = doc.createElement('span');
        seqSpan.className = 'group-queue-seq';
        const infoSpan = doc.createElement('span');
        infoSpan.className = 'group-queue-main';
        const nameSpan = doc.createElement('span');
        nameSpan.className = 'group-queue-name';
        const grpSpan = doc.createElement('span');
        grpSpan.className = 'group-queue-desc';
        infoSpan.append(nameSpan, grpSpan);

        const badgeSpan = doc.createElement('span');
        badgeSpan.className = 'group-queue-badge';

        btn.append(seqSpan, infoSpan, badgeSpan);
        btn.addEventListener('click', () => {
          callbacks.onCloseJumper();
          callbacks.onSelectAction(act.action_id);
        });
        return { btn, seqSpan, nameSpan, grpSpan, badgeSpan };
      },
      (entry, act) => {
        const isCurrent = vm.status.action_id === act.action_id;
        setClassIfChanged(entry.btn, 'is-current', isCurrent);
        setDisabledIfChanged(entry.btn, vm.actionSwitchBlocked);
        setTextIfChanged(entry.seqSpan, formatHumanSeq(act, { compact: true }));
        setDataIfChanged(entry.seqSpan, 'kind', act.type);
        setTextIfChanged(entry.nameSpan, act.name);
        setTextIfChanged(entry.grpSpan, act.group || '');
        if (vm.progressAvailable) {
          const s = summarizeActionProgress(act, vm.template.template_id, vm.ledger.progress);
          const lbl = isCurrent ? '当前' : (s.state === 'complete' || s.state === 'manual_ok') ? '✓ 已拍' : s.state === 'abnormal' ? '! 异常' : '○ 待拍';
          setTextIfChanged(entry.badgeSpan, lbl);
        } else {
          setTextIfChanged(entry.badgeSpan, isCurrent ? '当前' : '前往');
        }
      },
      entry => entry.btn
    );
  }

  function render(vm) {
    lastVm = vm;
    renderGroupQueueSection(vm);
    renderActionJumper(vm);
  }

  return { mount, render, destroy };
}
