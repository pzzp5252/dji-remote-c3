import { getBuiltinPreset } from '../presets/index.mjs';
import {
  DEFAULT_TEMPLATE,
  SOUND_CACHE_KEY,
  THEME_CACHE_KEY,
} from '../core/constants.mjs';
import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setAttrIfChanged,
  setClassIfChanged,
} from '../core/dom-utils.mjs';
import {
  formatBytes,
  describeStorageErrorCode,
  computeNextTargetMask,
  isDemoTemplateId,
  formatHumanAreaName,
} from '../core/formatters.mjs';
import { suggestDefaultProjectId } from '../core/ledger.mjs';

export function createSettingsStageController({
  root,
  doc,
  win,
  el,
  state,
  rt,
  storage,
  now,
  isMockMode,
  templateMatchesDevice,
  templateMismatchMessage,
  openDialog,
  closeDialog,
  render: onRender,
  connectFromGesture,
  disconnect,
  syncCurrentProject,
  initProject,
  importTemplateObject,
  handleError,
  startRecording,
  stopRecording,
  selectAction,
  selectTargetCameras,
  getDefaultPointId,
  getOrderedTemplateActions,
  switchView,
  acquireWakeLock,
  unlockStatusAudio,
  playStatusCue,
  renderSoundControls,
  stopActiveAudioCue,
  copyBackup,
  shareBackup,
  downloadBackup,
  downloadCsv,
}) {
  const cleanups = [];
  const listen = (node, evt, fn) => {
    if (!node) return;
    node.addEventListener(evt, fn);
    cleanups.push(() => node.removeEventListener(evt, fn));
  };

  function applyInitialTheme() {
    let savedTheme = null;
    try { savedTheme = storage.getItem(THEME_CACHE_KEY); } catch {}
    if (savedTheme === 'light' || savedTheme === 'dark') {
      doc?.documentElement?.setAttribute('data-theme', savedTheme);
    }
  }

  function render({ showS1, showS2, showS2b, confirmedAction, templateMatches }) {
    const connBadge = el('conn-badge');
    const connBadgeText = el('conn-badge-text');
    if (connBadge && connBadgeText) {
      const mockPrefix = isMockMode ? '演示 · ' : '';
      if (state.connecting) {
        connBadge.dataset.state = 'connecting';
        setTextIfChanged(connBadgeText, `${mockPrefix}连接中`);
      } else if (state.connected) {
        connBadge.dataset.state = 'connected';
        setTextIfChanged(connBadgeText, `${mockPrefix}已连`);
      } else {
        connBadge.dataset.state = 'disconnected';
        setTextIfChanged(connBadgeText, `${mockPrefix}未连`);
      }
    }

    const topbarProjSummary = el('topbar-project-summary');
    if (topbarProjSummary) {
      if (!state.connected) {
        setTextIfChanged(topbarProjSummary, '请先连接遥控器');
        topbarProjSummary.removeAttribute('title');
      } else if (!state.status.project_id) {
        setTextIfChanged(topbarProjSummary, '尚未新建项目');
        topbarProjSummary.removeAttribute('title');
      } else if (templateMatches) {
        setTextIfChanged(topbarProjSummary, formatHumanAreaName(confirmedAction, state.template));
        topbarProjSummary.title = `项目 ${state.status.project_id}`;
      } else {
        setTextIfChanged(topbarProjSummary, `项目 ${state.status.project_id}`);
        topbarProjSummary.title = `项目 ${state.status.project_id}`;
      }
    }

    const templateSummary = templateMatches
      ? `拍摄清单：${state.template.template_name} · ${state.template.template_id}`
      : templateMismatchMessage();
    setTextIfChanged(el('template-subtitle'), state.templateLoadError
      ? `${templateSummary} · 手机清单缓存不可用（${state.templateLoadError.code}：${state.templateLoadError.message}）`
      : templateSummary);
    setTextIfChanged(el('meta-project-id'), state.status.project_id || '尚未创建');
    setTextIfChanged(el('meta-template-id'), state.status.template_id || state.template.template_id);
    setTextIfChanged(el('meta-event-seq'), `${state.status.event_seq ?? 0} / ${state.ledger.after_seq ?? 0}`);
    setTextIfChanged(el('meta-take-id'), String(state.status.take_id ?? 0));
    setTextIfChanged(el('meta-free-bytes'), formatBytes(state.status.free_bytes));
    const mockNotice = el('mock-notice');
    if (mockNotice) setHiddenIfChanged(mockNotice, !isMockMode);

    const metaTime = el('meta-time-sync');
    if (metaTime) {
      if (!state.connected) {
        setTextIfChanged(metaTime, '未连接');
      } else {
        const timeLabel = state.status.time_synced ? '时间已校准' : '时间未校准';
        const writeLabel = state.status.writable === false ? '暂时无法保存记录' : '可以保存记录';
        const errText = describeStorageErrorCode(state.status.storage_error);
        const errSuffix = errText ? `（${errText}）` : '';
        setTextIfChanged(metaTime, `${timeLabel} / ${writeLabel}${errSuffix}`);
      }
    }

    const btnConnectEl = el('btn-connect');
    if (btnConnectEl) {
      btnConnectEl.className = state.connected ? 'btn' : 'btn btn-primary';
      setDisabledIfChanged(btnConnectEl, state.connecting);
    }
    setTextIfChanged(
      el('btn-connect-label'),
      state.connected ? '断开遥控器' : state.connecting ? '正在连接…' : '连接遥控器'
    );

    const syncDisabled = !state.connected || state.syncingLog || !state.status.project_id;
    setDisabledIfChanged(el('btn-sync-log'), syncDisabled);

    const btnReconnect = el('btn-reconnect-controller');
    if (btnReconnect) {
      setHiddenIfChanged(btnReconnect, state.connected);
      setDisabledIfChanged(btnReconnect, state.connecting);
      setTextIfChanged(el('btn-reconnect-label') || btnReconnect, state.connecting ? '正在连接…' : '连接双机录像遥控器');
    }

    if (showS1) {
      let localProjectCount = 0;
      if (typeof storage?.length === 'number' && typeof storage?.key === 'function') {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (typeof k === 'string' && k.startsWith('dji-ledger:') && k.endsWith(':cursor')) {
            localProjectCount += 1;
          }
        }
      }
      const storageDegraded = Boolean(
        state.templateLoadError ||
        state.templateSaveError ||
        state.ledgerSyncError?.code === 'QuotaExceededError'
      );
      const s1NoteEl = el('s1-local-replica-note');
      const s1BtnRecords = el('btn-s1-open-records');
      if (s1NoteEl) {
        setTextIfChanged(
          s1NoteEl,
          storageDegraded
            ? '本次浏览器不保存记录或本地存储异常，请连接后及时导出备份。'
            : localProjectCount > 0
              ? `本机已缓存 ${localProjectCount} 个项目的本地记录副本（连接后自动核对同步）。`
              : '连接遥控器后将自动读取项目与拍摄记录。'
        );
      }
      if (s1BtnRecords) {
        setHiddenIfChanged(s1BtnRecords, state.ledger.takes.length === 0);
      }
    }

    const activeInitTplId = state.template.template_id || state.selectedInitPresetId;
    for (const presetBtn of root.querySelectorAll('#init-preset-grid [data-preset-id]')) {
      const isSelected = presetBtn.dataset.presetId === activeInitTplId;
      setClassIfChanged(presetBtn, 'is-active', isSelected);
      setAttrIfChanged(presetBtn, 'aria-pressed', isSelected ? 'true' : 'false');
      setDisabledIfChanged(presetBtn, Boolean(state.pendingInit));
    }
    setDisabledIfChanged(el('btn-init-import-json'), Boolean(state.pendingInit));
    const initProjInput = el('input-init-project-id');
    if (initProjInput) {
      setDisabledIfChanged(initProjInput, Boolean(state.pendingInit));
      if (showS2 && initProjInput.dataset.userEdited !== 'true') {
        const suggested = suggestDefaultProjectId(activeInitTplId, storage, now());
        if (initProjInput.value !== suggested) {
          initProjInput.value = suggested;
        }
      }
    }
    const initTplInputEl = el('input-init-template-id');
    if (initTplInputEl) {
      setDisabledIfChanged(initTplInputEl, Boolean(state.pendingInit));
      if (initTplInputEl.dataset.userEdited !== 'true' && state.template?.template_id) {
        if (initTplInputEl.value !== state.template.template_id) {
          initTplInputEl.value = state.template.template_id;
        }
      }
    }
    const initSubmitBtn = el('btn-init-project');
    if (initSubmitBtn) {
      setDisabledIfChanged(initSubmitBtn, Boolean(state.pendingInit));
      const activeAreaLabel = formatHumanAreaName(null, state.template);
      setTextIfChanged(
        initSubmitBtn,
        state.pendingInit ? '正在创建项目…' : `创建「${activeAreaLabel}」项目并进入 →`
      );
    }

    const btnImportMatching = el('btn-import-matching-template');
    if (btnImportMatching) {
      const showImportMatching = Boolean(state.connected && state.status.project_id && !templateMatches);
      setHiddenIfChanged(btnImportMatching, !showImportMatching);
      if (showImportMatching) {
        setTextIfChanged(btnImportMatching.querySelector('span') || btnImportMatching, `导入匹配清单 (${state.status.template_id || '未知'})`);
      }
    }
    if (showS2b) {
      const devTplId = state.status.template_id || '';
      const builtinMatch = getBuiltinPreset(devTplId) ||
        (devTplId === DEFAULT_TEMPLATE.template_id ? DEFAULT_TEMPLATE : null);
      setTextIfChanged(
        el('mismatch-device-summary'),
        `遥控器项目「${state.status.project_id}」绑定的清单为「${devTplId || '未知'}」，手机当前载入「${state.template.template_id}」。`
      );
      const btnBuiltinMatch = el('btn-load-builtin-matching-template');
      if (btnBuiltinMatch) {
        setHiddenIfChanged(btnBuiltinMatch, !builtinMatch);
        if (builtinMatch) {
          setTextIfChanged(btnBuiltinMatch, `一键载入本机内置清单《${builtinMatch.template_name}》`);
        }
      }
      setTextIfChanged(
        el('mismatch-readonly-desc'),
        `遥控器当前已有项目 ${state.status.project_id}（${state.status.take_id ?? 0} 条），手机端禁止清空。请先连接电脑用归档工具备份并清空，再重连建新项目。`
      );
    }

    const demoWarningEl = el('demo-template-warning');
    if (demoWarningEl) {
      setHiddenIfChanged(demoWarningEl, !isDemoTemplateId(state.template.template_id));
    }

    const modalSettings = el('modal-settings');
    const btnToggleSettings = el('btn-toggle-settings');
    if (btnToggleSettings) {
      const isExpanded = Boolean(modalSettings?.open);
      setAttrIfChanged(btnToggleSettings, 'aria-expanded', isExpanded ? 'true' : 'false');
      setClassIfChanged(btnToggleSettings, 'is-active', isExpanded);
      setTextIfChanged(el('btn-toggle-settings-label'), '设备');
    }
  }

  function mount() {
    applyInitialTheme();

    listen(el('btn-toggle-settings'), 'click', () => {
      const modalSettings = el('modal-settings');
      if (!modalSettings) return;
      if (modalSettings.open) {
        void closeDialog(modalSettings);
      } else {
        for (const id of ['modal-add-point', 'modal-shoot-details']) {
          const other = el(id);
          if (other?.open) void closeDialog(other, { immediate: true });
        }
        openDialog(modalSettings, { returnFocus: el('btn-toggle-settings') });
        onRender();
      }
    });
    listen(el('btn-settings-close'), 'click', () => {
      void closeDialog(el('modal-settings'));
    });

    for (const navEl of root.querySelectorAll('[data-view-nav]')) {
      listen(navEl, 'click', () => {
        const targetView = navEl.dataset.viewNav;
        if (targetView) switchView(targetView);
      });
    }

    listen(el('unselected-action-cta'), 'click', () => {
      const firstAction = getOrderedTemplateActions()[0];
      if (!firstAction) return;
      void selectAction(firstAction.action_id, getDefaultPointId(firstAction), state.status.target_cameras);
    });

    listen(el('btn-s1-open-records'), 'click', () => {
      switchView('records');
    });

    for (const camToggleBtn of root.querySelectorAll('[data-cam-slot]')) {
      listen(camToggleBtn, 'click', () => {
        const slotBit = Number(camToggleBtn.dataset.camSlot);
        if (slotBit !== 1 && slotBit !== 2) return;
        const nextTarget = computeNextTargetMask(state.status.target_cameras, slotBit);
        void selectTargetCameras(nextTarget, { toggledSlotBit: slotBit });
      });
    }

    for (const diagBtn of root.querySelectorAll('[data-cam-diag]')) {
      listen(diagBtn, 'click', () => {
        const cam = diagBtn.dataset.camDiag === 'b' ? 'b' : 'a';
        state.activeDiagCam = cam;
        const dlg = el('modal-cam-diag');
        if (!dlg) return;
        openDialog(dlg, { returnFocus: diagBtn });
        onRender();
        el('btn-cam-diag-close')?.focus?.({ preventScroll: true });
      });
    }
    listen(el('btn-cam-diag-close'), 'click', () => {
      void closeDialog(el('modal-cam-diag'));
    });

    listen(el('btn-screen-awake'), 'click', () => {
      if (rt.destroyed) return;
      unlockStatusAudio();
      if (state.connected) {
        void acquireWakeLock();
      }
    });

    const inputStatusSound = el('input-status-sound');
    listen(inputStatusSound, 'change', () => {
      state.statusSoundEnabled = Boolean(inputStatusSound.checked);
      try { storage.setItem(SOUND_CACHE_KEY, state.statusSoundEnabled ? 'on' : 'off'); } catch {}
      if (state.statusSoundEnabled) {
        unlockStatusAudio();
      } else {
        stopActiveAudioCue();
      }
      renderSoundControls();
    });

    listen(el('btn-test-sound'), 'click', () => {
      unlockStatusAudio();
      playStatusCue('started');
    });

    listen(el('btn-connect'), 'click', () => {
      if (state.connected) {
        disconnect();
        return;
      }
      connectFromGesture();
    });
    listen(el('btn-reconnect-controller'), 'click', () => connectFromGesture());
    listen(el('btn-dock-reconnect'), 'click', () => connectFromGesture());

    for (const presetBtn of root.querySelectorAll('#init-preset-grid [data-preset-id]')) {
      listen(presetBtn, 'click', () => {
        if (state.pendingInit) return;
        const presetId = presetBtn.dataset.presetId;
        const preset = getBuiltinPreset(presetId);
        if (!preset) return;
        const initTpl = el('input-init-template-id');
        if (initTpl) {
          initTpl.dataset.userEdited = 'false';
          initTpl.value = preset.template_id;
        }
        const initProj = el('input-init-project-id');
        if (initProj && initProj.dataset.userEdited !== 'true') {
          initProj.value = suggestDefaultProjectId(preset.template_id, storage, now());
        }
        state.selectedInitPresetId = preset.template_id;
        importTemplateObject(preset, { persist: true, announce: true });
      });
    }

    listen(el('btn-load-builtin-matching-template'), 'click', () => {
      const devTplId = state.status.template_id || '';
      const matched = getBuiltinPreset(devTplId) ||
        (devTplId === DEFAULT_TEMPLATE.template_id ? DEFAULT_TEMPLATE : null);
      if (matched) {
        importTemplateObject(matched, { persist: true, announce: true });
      }
    });

    const fileInput = el('input-template-file');
    listen(el('btn-import-matching-template'), 'click', () => fileInput?.click());
    listen(el('btn-init-import-json'), 'click', () => {
      if (state.pendingInit) return;
      fileInput?.click();
    });
    listen(el('btn-sync-log'), 'click', () => {
      void syncCurrentProject(state.status.project_id);
    });
    listen(el('btn-import-template'), 'click', () => fileInput?.click());
    listen(fileInput, 'change', async event => {
      const file = event.target?.files?.[0];
      if (!file) return;
      try {
        const text = typeof file.text === 'function'
          ? await file.text()
          : await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(reader.error || new Error('file_read_failed'));
              reader.readAsText(file, 'utf-8');
            });
        const parsed = JSON.parse(text);
        importTemplateObject(parsed, { persist: true, announce: true });
      } catch (error) {
        handleError('导入拍摄清单', error);
      } finally {
        fileInput.value = '';
      }
    });

    const initProjInputEl = el('input-init-project-id');
    listen(initProjInputEl, 'input', () => {
      initProjInputEl.dataset.userEdited = 'true';
    });
    const initTplInput = el('input-init-template-id');
    listen(initTplInput, 'input', () => {
      initTplInput.dataset.userEdited = 'true';
    });
    listen(el('btn-init-project'), 'click', () => {
      void initProject();
    });

    listen(el('btn-record-main'), 'click', () => {
      if (el('btn-record-main')?.dataset.mode === 'start') {
        void startRecording();
      } else {
        void stopRecording();
      }
    });
    listen(el('btn-global-stop'), 'click', () => {
      void stopRecording();
    });

    listen(el('btn-backup-copy'), 'click', () => { void copyBackup(); });
    listen(el('btn-backup-share'), 'click', () => { void shareBackup(); });
    listen(el('btn-backup-download'), 'click', () => { downloadBackup(); });
    listen(el('btn-backup-csv'), 'click', () => { downloadCsv(); });

    listen(el('btn-theme-toggle'), 'click', () => {
      const rootDocEl = doc?.documentElement;
      if (!rootDocEl) return;
      const mm = win?.matchMedia || (typeof matchMedia === 'function' ? matchMedia : null);
      const current = rootDocEl.getAttribute('data-theme') ||
        (typeof mm === 'function' && mm('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'dark' ? 'light' : 'dark';
      rootDocEl.setAttribute('data-theme', next);
      try { storage.setItem(THEME_CACHE_KEY, next); } catch {}
    });
  }

  function destroy() {
    while (cleanups.length > 0) cleanups.pop()();
  }

  return { mount, render, destroy };
}
