import { setTextIfChanged } from '../core/dom-utils.mjs';
import { formatHumanSeq } from '../core/formatters.mjs';

export function createShootDetailsModalController({
  doc,
  el,
  state,
  rt,
  currentTemplateAction,
  currentLedgerFailure,
  detailIdentityMatches,
  getScreenAwakeDetail,
  openDialog,
  closeDialog,
  isDialogClosing,
  onShowPointDialog,
}) {
  function showShootDetails({ kind = 'shoot', focusOrphans = false } = {}) {
    if (kind !== 'shoot' && kind !== 'ledger') return;
    if (kind === 'shoot' && !state.status.action_id) return;
    const dialog = el('modal-shoot-details');
    if (!dialog || dialog.open || isDialogClosing(dialog)) return;
    const context = {
      kind,
      projectId: state.status.project_id,
      templateId: state.template.template_id,
      deviceTemplateId: state.status.template_id,
      actionId: state.status.action_id,
      pointId: state.status.point_id || '',
      failure: currentLedgerFailure(),
    };
    rt.shootDetailsContext = context;
    const content = el('shoot-details-content');
    const type = el('confirmed-action-type');
    const group = el('confirmed-action-group');
    content.replaceChildren();
    const add = (label, value, node = null) => {
      const dt = doc.createElement('dt');
      dt.textContent = label;
      const dd = node || doc.createElement('dd');
      dd.hidden = false;
      dd.textContent = value;
      content.append(dt, dd);
    };
    const orphans = el('shoot-orphan-points');
    orphans.replaceChildren();
    orphans.hidden = kind === 'ledger';
    if (kind === 'ledger') {
      setTextIfChanged(el('shoot-details-title'), '手机记录详情');
      add('项目', context.projectId || '未创建项目');
      add('代码', context.failure?.code || '');
      add('完整信息', context.failure?.message || '手机记录已同步');
      type.hidden = true;
      group.hidden = true;
      content.append(type, group);
    } else {
      const action = currentTemplateAction(context.actionId);
      const point = action?.points.find(p => p.point_id === context.pointId);
      setTextIfChanged(el('shoot-details-title'), '拍摄项详情');
      add('项目序号', action ? formatHumanSeq(action) : '未收录动作');
      add('拍摄项名称', action?.name || '未收录名称');
      if (action?.description) add('操作描述', action.description);
      const criteriaText = action?.criteria || state.template.default_criteria || '';
      if (criteriaText) add('合格标准', criteriaText);
      const srcParts = [
        state.template.source_doc || '',
        action?.doc_ref?.section ? `${action.doc_ref.section}${action.doc_ref.seq ? ` 第 ${action.doc_ref.seq} 项` : ''}` : '',
      ].filter(Boolean).join(' · ');
      if (srcParts) add('参考出处', srcParts);
      if (context.pointId || (action?.points?.length || 0) > 0) {
        add('当前点位', context.pointId ? (point && !point.orphan ? point.name : '未收录名称') : '不指定拍摄位置');
      }
      add('类型', action ? (action.type === 'static' ? '静态' : '动态') : '未收录名称', type);
      add('位置', action?.group || '未收录名称', group);
      add('保持亮屏', getScreenAwakeDetail());
      for (const p of action?.points.filter(pt => pt.orphan) || []) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.dataset.renamePointId = p.point_id;
        button.dataset.actionId = context.actionId;
        button.textContent = `给 ${p.point_id} 补名`;
        button.addEventListener('click', async () => {
          await closeDialog(dialog);
          const target = state.template.actions.find(a => a.action_id === context.actionId)?.points.find(pt => pt.point_id === p.point_id && pt.orphan);
          if (!detailIdentityMatches(context) || state.status.action_id !== context.actionId || !target) return;
          onShowPointDialog({ actionId: context.actionId, pointId: p.point_id, returnFocus: el('btn-current-details') });
        });
        orphans.append(button);
      }
    }
    openDialog(dialog);
    if (focusOrphans) orphans.querySelector('button')?.focus();
  }

  function closeStaleShootDetails(control = null) {
    const context = rt.shootDetailsContext;
    const dlg = el('modal-shoot-details');
    if (!context || !dlg?.open) return;
    const stale = context.kind === 'shoot'
      ? !detailIdentityMatches(context) || context.actionId !== state.status.action_id || context.pointId !== (state.status.point_id || '')
      : context.projectId !== state.status.project_id || !currentLedgerFailure();
    if (stale) void closeDialog(dlg, { immediate: true, control });
  }

  const btnShootDetails = el('btn-current-details');
  const btnLedgerDetails = el('btn-ledger-details');
  const btnClose = el('btn-shoot-details-close');
  const onOpenShoot = () => showShootDetails();
  const onOpenLedger = () => showShootDetails({ kind: 'ledger' });
  const onClose = () => { void closeDialog(el('modal-shoot-details')); };

  function mount() {
    btnShootDetails?.addEventListener('click', onOpenShoot);
    btnLedgerDetails?.addEventListener('click', onOpenLedger);
    btnClose?.addEventListener('click', onClose);
  }

  function destroy() {
    btnShootDetails?.removeEventListener('click', onOpenShoot);
    btnLedgerDetails?.removeEventListener('click', onOpenLedger);
    btnClose?.removeEventListener('click', onClose);
  }

  return { mount, showShootDetails, closeStaleShootDetails, destroy };
}
