import { setHiddenIfChanged } from './dom-utils.mjs';

export const DIALOG_REGISTRY = [
  'modal-settings',
  'modal-shoot-details',
  'modal-add-point',
  'modal-cam-diag',
  'modal-point-list',
  'modal-action-jumper',
  'modal-reassign',
];

export function createDialogManager({ root, doc, win, el, state, rt, getRecordControlState, onDialogClosed }) {
  const sheetViewport = win?.visualViewport || null;
  const dialogRecords = new WeakMap();
  let unbindSheets = [];
  let activeFrameControl = null;

  function withFrameControl(control, fn) {
    const prev = activeFrameControl;
    activeFrameControl = control;
    try {
      return fn();
    } finally {
      activeFrameControl = prev;
    }
  }

  function updateSheetViewport() {
    const h = Number.isFinite(sheetViewport?.height) && sheetViewport.height > 0 ? sheetViewport.height : null;
    const top = Number.isFinite(sheetViewport?.offsetTop) ? Math.max(0, sheetViewport.offsetTop) : 0;
    for (const id of DIALOG_REGISTRY) {
      const dlg = el(id);
      if (!dlg) continue;
      if (h !== null) {
        dlg.style.setProperty('--sheet-viewport-height', `${h}px`);
        dlg.style.setProperty('--sheet-viewport-top', `${top}px`);
      } else {
        dlg.style.removeProperty('--sheet-viewport-height');
        dlg.style.removeProperty('--sheet-viewport-top');
      }
    }
  }

  function getOpenSheetDialog() {
    for (const id of DIALOG_REGISTRY) {
      const dlg = el(id);
      if (dlg?.open && !dialogRecords.get(dlg)?.closingPromise) return dlg;
    }
    return null;
  }

  function relocateGlobalRecordStrip(control = activeFrameControl || getRecordControlState()) {
    const globalHost = el('global-record-host');
    const globalStrip = el('global-record-strip');
    const btnGlobalStop = el('btn-global-stop');
    const bannerWrap = el('status-banner-wrap');
    if (!globalHost || !globalStrip) return;
    const openDialogEl = getOpenSheetDialog();
    if (bannerWrap) {
      const targetBannerSlot = openDialogEl?.querySelector('[data-sheet-banner-slot]') || null;
      if (targetBannerSlot) {
        if (bannerWrap.parentElement !== targetBannerSlot) {
          targetBannerSlot.appendChild(bannerWrap);
        }
      } else if (bannerWrap.parentElement !== root) {
        root.insertBefore(bannerWrap, root.firstChild);
      }
    }
    const targetSlot = control.mode === 'stop' && openDialogEl
      ? (openDialogEl.querySelector('[data-sheet-stop-slot]') || openDialogEl)
      : globalHost;
    const isStripVisible = Boolean(
      control.mode === 'stop' &&
      (openDialogEl || (!state.desktopMode && state.activeView !== 'shoot'))
    );
    const restoreFocus = Boolean(btnGlobalStop && doc?.activeElement === btnGlobalStop);
    if (globalStrip.parentElement !== targetSlot) {
      targetSlot.appendChild(globalStrip);
    }
    setHiddenIfChanged(globalStrip, !isStripVisible);
    if (restoreFocus && isStripVisible && btnGlobalStop && !btnGlobalStop.disabled) {
      btnGlobalStop.focus?.({ preventScroll: true });
    }
  }

  function openDialog(dialog, { returnFocus = doc.activeElement, control = activeFrameControl } = {}) {
    if (!dialog || rt.destroyed) return;
    const prev = dialogRecords.get(dialog);
    if (prev?.closingPromise) {
      prev.animation?.cancel?.();
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
    }
    for (const otherId of DIALOG_REGISTRY) {
      if (otherId === dialog.id) continue;
      const other = el(otherId);
      if (other?.open) void closeDialog(other, { immediate: true, control });
    }
    dialogRecords.set(dialog, { returnFocus, closingPromise: null, animation: null });
    updateSheetViewport();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (dialog.id === 'modal-settings') {
      const btn = el('btn-toggle-settings');
      if (btn) {
        btn.setAttribute('aria-expanded', 'true');
        btn.classList.add('is-active');
      }
    }
    relocateGlobalRecordStrip(control || getRecordControlState());
  }

  function closeDialog(dialog, { immediate = false, control = activeFrameControl } = {}) {
    if (!dialog) return Promise.resolve();
    const record = dialogRecords.get(dialog);
    const finish = () => {
      if (record && dialogRecords.get(dialog) !== record) return;
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else { dialog.removeAttribute('open'); dialog.dispatchEvent(new win.Event('close')); }
      }
      if (dialog.id === 'modal-settings') {
        const btn = el('btn-toggle-settings');
        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
          btn.classList.remove('is-active');
        }
      }
      relocateGlobalRecordStrip(control || activeFrameControl || getRecordControlState());
    };
    if (immediate) {
      record?.animation?.cancel?.();
      finish();
      return record?.closingPromise || Promise.resolve();
    }
    if (record?.closingPromise) {
      relocateGlobalRecordStrip(control || activeFrameControl || getRecordControlState());
      return record.closingPromise;
    }
    if (!dialog.open || !record || typeof dialog.animate !== 'function' ||
        win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      finish();
      return Promise.resolve();
    }
    const computed = win.getComputedStyle(dialog);
    try {
      record.animation = dialog.animate([
        { transform: computed.transform === 'none' ? 'translateY(0)' : computed.transform, opacity: computed.opacity || '1' },
        { transform: 'translateY(100%)', opacity: '0' },
      ], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      record.closingPromise = Promise.resolve(record.animation.finished).catch(() => {}).then(() => {
        finish();
        record.animation?.cancel?.();
      });
      relocateGlobalRecordStrip(control || activeFrameControl || getRecordControlState());
      return record.closingPromise;
    } catch { finish(); return Promise.resolve(); }
  }

  function bindSheetInteractions(dialog) {
    if (!dialog) return () => {};
    const handle = dialog.querySelector('.sheet-handle');
    let drag = null;
    if (handle) handle.style.touchAction = 'pinch-zoom';
    const reset = () => {
      if (drag && handle?.hasPointerCapture?.(drag.id)) handle.releasePointerCapture(drag.id);
      drag = null;
      dialog.style.transform = '';
    };
    const onDown = e => {
      if (e.isPrimary === false || (e.button !== undefined && e.button !== 0) || dialogRecords.get(dialog)?.closingPromise) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, distance: 0 };
      handle.setPointerCapture?.(e.pointerId);
    };
    const onMove = e => {
      if (!drag || drag.id !== e.pointerId) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(e.clientX - drag.x) > Math.max(16, dy)) { reset(); return; }
      drag.distance = Math.max(0, dy);
      if (!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) dialog.style.transform = `translateY(${drag.distance}px)`;
    };
    const onUp = e => {
      if (!drag || drag.id !== e.pointerId) return;
      const shouldClose = drag.distance >= 72;
      if (shouldClose) void closeDialog(dialog);
      reset();
    };
    const onCancel = e => { e.preventDefault(); void closeDialog(dialog); };
    const onBackdrop = e => {
      if (e.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) void closeDialog(dialog);
    };
    const onClose = () => {
      if (dialog.open) return;
      reset();
      const record = dialogRecords.get(dialog);
      if (!record) return;
      dialogRecords.delete(dialog);
      record.animation?.cancel?.();
      onDialogClosed?.(dialog);
      if (dialog.id === 'modal-settings') {
        const btn = el('btn-toggle-settings');
        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
          btn.classList.remove('is-active');
        }
      }
      if (rt.destroyed) return;
      relocateGlobalRecordStrip();
      const target = record.returnFocus;
      let visible = Boolean(target?.isConnected && !target.disabled && !target.closest('[hidden]'));
      for (let node = target; visible && node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') visible = false;
      }
      (visible ? target : el('btn-toggle-settings'))?.focus?.();
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('click', onBackdrop);
    dialog.addEventListener('close', onClose);
    handle?.addEventListener('pointerdown', onDown);
    handle?.addEventListener('pointermove', onMove);
    handle?.addEventListener('pointerup', onUp);
    handle?.addEventListener('pointercancel', reset);
    return () => {
      reset();
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('click', onBackdrop);
      dialog.removeEventListener('close', onClose);
      handle?.removeEventListener('pointerdown', onDown);
      handle?.removeEventListener('pointermove', onMove);
      handle?.removeEventListener('pointerup', onUp);
      handle?.removeEventListener('pointercancel', reset);
    };
  }

  function setDialogReturnFocus(dialog, target) {
    const rec = dialogRecords.get(dialog);
    if (rec) rec.returnFocus = target;
  }

  function isDialogClosing(dialog) {
    return Boolean(dialogRecords.get(dialog)?.closingPromise);
  }

  function mount() {
    sheetViewport?.addEventListener?.('resize', updateSheetViewport, { passive: true });
    sheetViewport?.addEventListener?.('scroll', updateSheetViewport, { passive: true });
    unbindSheets = DIALOG_REGISTRY.map(id => bindSheetInteractions(el(id)));
  }

  function destroy() {
    sheetViewport?.removeEventListener?.('resize', updateSheetViewport);
    sheetViewport?.removeEventListener?.('scroll', updateSheetViewport);
    for (const id of DIALOG_REGISTRY) {
      void closeDialog(el(id), { immediate: true });
    }
    for (const unbind of unbindSheets) unbind();
    unbindSheets = [];
  }

  return {
    mount,
    destroy,
    withFrameControl,
    updateSheetViewport,
    getOpenSheetDialog,
    relocateGlobalRecordStrip,
    openDialog,
    closeDialog,
    setDialogReturnFocus,
    isDialogClosing,
  };
}
