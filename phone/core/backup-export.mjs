import { BleClientError } from '../ble-client.mjs';
import { listLocalOperatorAcks, exportLedgerCsv } from './ledger.mjs';

export function createBackupController({
  doc,
  state,
  storage,
  now,
  clipboard,
  share,
  download,
  refreshLocalLedger,
  templateMatchesDevice,
  localLedgerIncomplete,
  setBanner,
  handleError,
  renderLedgerStorageNotice,
  render,
}) {
  function buildBackupPayload() {
    const projectId = state.status.project_id;
    refreshLocalLedger(projectId);
    if (state.ledgerReadError || state.ledger.project_id !== projectId) {
      state.lastBackupPayload = null;
      render();
      return null;
    }
    const payload = {
      exported_at: new Date(now()).toISOString(),
      project_id: projectId,
      template_id: state.status.template_id || state.template.template_id,
      after_seq: state.ledger.after_seq,
      events: state.ledger.events,
      takes: state.ledger.takes,
      local_operator_acks: listLocalOperatorAcks(storage, projectId),
      ...(templateMatchesDevice() ? { template_snapshot: state.template } : {}),
    };
    state.lastBackupPayload = payload;
    return payload;
  }

  function triggerDownload(filename, text, mimeType = 'application/json;charset=utf-8') {
    if (typeof download === 'function') {
      download(filename, text, mimeType);
      return;
    }
    if (!doc || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return;
    }
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    doc.body?.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000)?.unref?.();
  }

  function announceBackup(message, code, payload, tone = 'ok') {
    if (state.status.project_id !== payload.project_id) return;
    if (state.ledgerReadError) {
      setBanner('手机记录读取失败，请修复后再导出', { tone: 'error', code: 'ledger_unavailable' });
    } else if (localLedgerIncomplete() || payload.after_seq < state.ledger.after_seq || payload.after_seq < state.status.event_seq) {
      setBanner(`${message}；仅为同项目已有本地副本，手机记录尚未同步完整`, { tone: 'warn', code: 'local_copy_incomplete' });
    } else {
      setBanner(message, { tone, code });
    }
    renderLedgerStorageNotice();
  }

  async function copyBackup() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const json = JSON.stringify(payload, null, 2);
    try {
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new BleClientError('clipboard_unavailable', 'Clipboard API unavailable');
      }
      await clipboard.writeText(json);
      announceBackup('备份已复制', 'COPY_OK', payload);
      return payload;
    } catch (error) {
      handleError('复制备份', error);
      return null;
    }
  }

  function downloadBackup() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const json = JSON.stringify(payload, null, 2);
    const safeProj = (payload.project_id || 'uninitialized').replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger_backup.json`;
    triggerDownload(filename, json);
    announceBackup('备份文件已生成，请留意浏览器的保存提示', 'DOWNLOAD_OK', payload);
    return payload;
  }

  async function shareBackup() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const json = JSON.stringify(payload, null, 2);
    const safeProj = (payload.project_id || 'uninitialized').replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger_backup.json`;
    if (typeof share === 'function') {
      try {
        await share({
          title: `拍摄记录备份 ${payload.project_id || ''}`,
          text: json,
        });
        announceBackup('已打开分享窗口', 'SHARE_OK', payload);
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          announceBackup('已取消分享', 'SHARE_CANCELLED', payload, 'warn');
          return payload;
        }
      }
    }
    if (state.status.project_id !== payload.project_id || state.ledgerReadError) return null;
    triggerDownload(filename, json);
    announceBackup('此浏览器不能分享，已为你生成备份文件', 'SHARE_FALLBACK_DOWNLOAD', payload, 'warn');
    return payload;
  }

  function downloadCsv() {
    const payload = buildBackupPayload();
    if (!payload) return null;
    const projectId = payload.project_id || 'uninitialized';
    const csvContent = exportLedgerCsv(payload, state.template, { now });
    const safeProj = projectId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const filename = `${safeProj}_ledger.csv`;
    triggerDownload(filename, csvContent, 'text/csv;charset=utf-8');
    announceBackup('CSV 拍摄记录已生成，请留意浏览器的保存提示', 'CSV_DOWNLOAD_OK', payload);
    return csvContent;
  }

  return {
    buildBackupPayload,
    copyBackup,
    downloadBackup,
    shareBackup,
    downloadCsv,
  };
}
