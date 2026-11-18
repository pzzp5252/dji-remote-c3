import { TEMPLATE_CACHE_KEY, POINT_NAME_MAX_LENGTH } from '../core/constants.mjs';
import { setTextIfChanged } from '../core/dom-utils.mjs';
import {
  isValidAsciiId,
  deduceNextPointId,
  isValidPointId,
  normalizeTemplate,
} from '../core/formatters.mjs';

export function createAddPointModalController({
  doc,
  el,
  state,
  rt,
  storage,
  templateMatchesDevice,
  rejectTemplateMismatch,
  currentTemplateAction,
  detailIdentityMatches,
  openDialog,
  closeDialog,
  setDialogReturnFocus,
  isDialogClosing,
  setBanner,
  selectAction,
  onRender,
  onShowShootDetails,
}) {
  const modalAddPoint = el('modal-add-point');
  const btnTriggerAddPoint = el('btn-trigger-add-point');
  const btnCancelAddPoint = el('btn-cancel-add-point');
  const btnRenamePoint = el('btn-rename-point');
  const formAddPoint = el('form-add-point');
  const inputAddPointId = el('input-add-point-id');
  const inputAddPointName = el('input-add-point-name');
  const msgAddPointError = el('msg-add-point-error');

  let isNameComposing = false;
  let pointDialogContext = null;

  function showPointDialog({ actionId = state.status.action_id, pointId = null, returnFocus = doc.activeElement } = {}) {
    if (rejectTemplateMismatch()) return;
    const action = currentTemplateAction(actionId);
    if (!action) {
      setBanner('请先选择拍摄项后再添加点位', { tone: 'warn' });
      onRender();
      return;
    }
    const rename = pointId !== null;
    const point = rename ? action.points.find(p => p.point_id === pointId && p.orphan) : null;
    if (rename && !point) return;
    if (!modalAddPoint || modalAddPoint.open || isDialogClosing(modalAddPoint)) return;
    pointDialogContext = {
      deviceTemplateId: state.status.template_id,
      projectId: state.status.project_id,
      actionId: action.action_id,
      templateId: state.template.template_id,
      pointId: point?.point_id ?? null,
    };
    inputAddPointId.value = point?.point_id ?? deduceNextPointId(action.points);
    inputAddPointId.readOnly = rename;
    inputAddPointId.maxLength = rename ? 31 : 16;
    inputAddPointId.pattern = rename ? '^[A-Za-z0-9_.\\-]+$' : '^[A-Za-z0-9_\\-]+$';
    inputAddPointName.maxLength = POINT_NAME_MAX_LENGTH;
    inputAddPointName.required = rename;
    inputAddPointName.value = '';
    setTextIfChanged(el('modal-add-point-title'), rename ? `给 ${point.point_id} 补中文名` : '现场新增点位');
    setTextIfChanged(el('btn-confirm-add-point'), rename ? '保存中文名' : '保存并选中');
    setTextIfChanged(msgAddPointError, '');
    openDialog(modalAddPoint, { returnFocus });
    inputAddPointName.focus();
  }

  const onCompStart = () => { isNameComposing = true; };
  const onCompEnd = () => { isNameComposing = false; };
  const onNameKeydown = e => {
    if (e.key === 'Enter' && isNameComposing) e.preventDefault();
  };
  const onTriggerAdd = () => showPointDialog();
  const onRenameClick = () => {
    const action = state.template.actions.find(a => a.action_id === state.status.action_id);
    const selected = action?.points.find(p => p.point_id === state.status.point_id && p.orphan);
    if (selected) showPointDialog({ pointId: selected.point_id });
    else onShowShootDetails({ focusOrphans: true });
  };
  const onCancel = () => { void closeDialog(modalAddPoint); };
  const onSubmit = async e => {
    e.preventDefault();
    if (isNameComposing || !pointDialogContext || isDialogClosing(modalAddPoint)) return;
    const context = pointDialogContext;
    const rename = context.pointId !== null;
    const rawId = inputAddPointId.value.trim();
    if (!(rename ? rawId === context.pointId && isValidAsciiId(rawId, 31) : isValidPointId(rawId))) {
      setTextIfChanged(msgAddPointError, '点位编号仅支持 1-16 位英文字母、数字、下划线及短横线 (ASCII)');
      return;
    }
    if (!templateMatchesDevice() || !detailIdentityMatches(context)) {
      setTextIfChanged(msgAddPointError, '拍摄清单已切换，请取消后重新打开');
      return;
    }
    const candidate = normalizeTemplate(state.template);
    const action = candidate.actions.find(a => a.action_id === context.actionId);
    if (!action) { setTextIfChanged(msgAddPointError, '未找到当前拍摄项，请重新选择'); return; }
    const existing = action.points.find(p => p.point_id.toUpperCase() === rawId.toUpperCase());
    if (existing && (!rename || !existing.orphan)) {
      setTextIfChanged(msgAddPointError, `点位编号 ${rawId} 已存在，请使用其他编号`);
      return;
    }
    if (rename && !existing) { setTextIfChanged(msgAddPointError, '待补名点位已变更，请重新打开'); return; }
    const rawName = inputAddPointName.value.trim() || (rename ? '' : rawId);
    if (!rawName || rawName.length > POINT_NAME_MAX_LENGTH) {
      setTextIfChanged(msgAddPointError, `请填写不超过 ${POINT_NAME_MAX_LENGTH} 字符的点位名称`);
      return;
    }
    if (rename) { existing.name = rawName; delete existing.orphan; }
    else action.points.push({ point_id: rawId, name: rawName });
    try {
      storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(candidate));
    } catch {
      setTextIfChanged(msgAddPointError, '点位未保存，请腾出手机存储空间后再试；输入已保留');
      return;
    }
    state.template = candidate;
    state.templateVersion += 1;
    if (rename) setDialogReturnFocus(modalAddPoint, el('btn-current-details'));
    await closeDialog(modalAddPoint);
    if (rt.destroyed) return;
    if (rename) {
      setBanner(`已保存 ${rawId} 的中文名`, { tone: 'ok' });
    } else {
      const reply = detailIdentityMatches(context) && state.status.action_id === context.actionId
        ? await selectAction(context.actionId, rawId) : null;
      if (reply?.ok === true) setBanner(`已添加并选中点位 ${rawName}`, { tone: 'ok' });
      else setBanner(`点位 ${rawName} 已保存，但设备未选中，请稍后点选`, { tone: 'warn' });
    }
    onRender();
  };

  function mount() {
    inputAddPointName?.addEventListener('compositionstart', onCompStart);
    inputAddPointName?.addEventListener('compositionend', onCompEnd);
    inputAddPointName?.addEventListener('keydown', onNameKeydown);
    if (btnTriggerAddPoint) {
      btnTriggerAddPoint.setAttribute('aria-haspopup', 'dialog');
      btnTriggerAddPoint.addEventListener('click', onTriggerAdd);
    }
    btnRenamePoint?.addEventListener('click', onRenameClick);
    btnCancelAddPoint?.addEventListener('click', onCancel);
    formAddPoint?.addEventListener('submit', onSubmit);
  }

  function destroy() {
    inputAddPointName?.removeEventListener('compositionstart', onCompStart);
    inputAddPointName?.removeEventListener('compositionend', onCompEnd);
    inputAddPointName?.removeEventListener('keydown', onNameKeydown);
    btnTriggerAddPoint?.removeEventListener('click', onTriggerAdd);
    btnRenamePoint?.removeEventListener('click', onRenameClick);
    btnCancelAddPoint?.removeEventListener('click', onCancel);
    formAddPoint?.removeEventListener('submit', onSubmit);
  }

  return { mount, showPointDialog, destroy };
}
