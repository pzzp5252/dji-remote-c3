import { SCREEN_KEEPALIVE_VIDEO } from './constants.mjs';
import { setTextIfChanged } from './dom-utils.mjs';

export function createWakeLockController({ doc, win, el, rt, isConnected }) {
  let screenAwakeMessage = '未启用';
  let screenAwakeDetail = '未申请保持亮屏';
  let wakeLockSentinel = null;
  let wakeLockRequest = null;
  let keepAliveVideoEl = null;
  let keepAlivePlay = null;
  let wakeLockWanted = false;
  let wakeLockGeneration = 0;

  function setScreenAwakeNotice(mode, shortMessage, detailMessage = shortMessage) {
    screenAwakeMessage = shortMessage;
    screenAwakeDetail = detailMessage || shortMessage;
    const notice = el('screen-awake-notice');
    if (notice) {
      notice.dataset.mode = mode;
      notice.hidden = false;
      setTextIfChanged(notice, shortMessage);
    }
    const btnAwake = el('btn-screen-awake');
    if (btnAwake) {
      btnAwake.dataset.mode = mode;
      btnAwake.setAttribute('aria-label', `屏幕常亮：${shortMessage}${screenAwakeDetail && screenAwakeDetail !== shortMessage ? `（${screenAwakeDetail}）` : ''}`);
    }
  }

  function showManualScreenNotice(reason = '请手动保持屏幕常亮') {
    if (wakeLockSentinel && !wakeLockSentinel.released) return;
    setScreenAwakeNotice('manual', '请手动常亮', reason);
  }

  function playKeepAliveVideo() {
    if (keepAlivePlay) return keepAlivePlay;
    if (doc?.visibilityState === 'hidden') return Promise.resolve(false);
    if (keepAliveVideoEl?.paused === false) return Promise.resolve(true);
    const nav = win?.navigator;
    if (/jsdom/i.test(nav?.userAgent || '') || !doc?.body) return Promise.resolve(false);
    const generation = wakeLockGeneration;
    try {
      if (!keepAliveVideoEl) {
        const video = doc.createElement('video');
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        video.muted = true;
        video.loop = true;
        video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none';
        video.src = SCREEN_KEEPALIVE_VIDEO;
        doc.body.appendChild(video);
        keepAliveVideoEl = video;
      }
      const video = keepAliveVideoEl;
      const playback = video.play();
      if (!playback || typeof playback.then !== 'function') {
        showManualScreenNotice('辅助保活视频无法启动播放，请手动保持屏幕常亮');
        return Promise.resolve(false);
      }
      const operation = Promise.resolve(playback).then(() => {
        if (rt.destroyed || generation !== wakeLockGeneration || !wakeLockWanted || doc?.visibilityState === 'hidden') {
          video.pause?.();
          video.remove?.();
          return false;
        }
        if (!wakeLockSentinel) setScreenAwakeNotice('video', '辅助常亮', '辅助视频已播放，防息屏请现场确认');
        return true;
      }, err => {
        if (!rt.destroyed && generation === wakeLockGeneration && wakeLockWanted) {
          showManualScreenNotice(`辅助视频播放被拒绝${err?.message ? `（${err.message}）` : ''}，请手动保持屏幕常亮`);
        }
        return false;
      }).finally(() => {
        if (keepAlivePlay === operation) keepAlivePlay = null;
      });
      keepAlivePlay = operation;
      return operation;
    } catch (err) {
      showManualScreenNotice(`辅助视频异常${err?.message ? `（${err.message}）` : ''}，请手动保持屏幕常亮`);
      return Promise.resolve(false);
    }
  }

  function acquireWakeLock() {
    if (rt.destroyed || !isConnected() || doc?.visibilityState === 'hidden') return Promise.resolve(false);
    wakeLockWanted = true;
    if (wakeLockSentinel && !wakeLockSentinel.released) return Promise.resolve(true);
    if (wakeLockRequest) return wakeLockRequest;
    const generation = wakeLockGeneration;
    const nav = win?.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav?.wakeLock?.request) return playKeepAliveVideo();
    const operation = (async () => {
      try {
        const sentinel = await nav.wakeLock.request('screen');
        if (rt.destroyed || !wakeLockWanted || generation !== wakeLockGeneration || doc?.visibilityState === 'hidden') {
          await sentinel.release();
          return false;
        }
        wakeLockSentinel = sentinel;
        sentinel.addEventListener?.('release', () => {
          if (wakeLockSentinel === sentinel) {
            wakeLockSentinel = null;
            if (wakeLockWanted && doc?.visibilityState !== 'hidden') {
              showManualScreenNotice('系统屏幕常亮已被系统释放，请手动保持屏幕常亮或点顶栏重试');
            }
          }
        });
        setScreenAwakeNotice('system', '常亮中', '已申请系统保持亮屏');
        return true;
      } catch (err) {
        if (!rt.destroyed && wakeLockWanted && generation === wakeLockGeneration && doc?.visibilityState !== 'hidden') {
          const played = await playKeepAliveVideo();
          if (!played && err?.message) {
            showManualScreenNotice(`系统常亮申请失败（${err.message}），请手动保持屏幕常亮`);
          }
          return played;
        }
        return false;
      }
    })();
    wakeLockRequest = operation;
    void operation.finally(() => { if (wakeLockRequest === operation) wakeLockRequest = null; });
    return operation;
  }

  async function releaseWakeLock() {
    wakeLockWanted = false;
    wakeLockGeneration += 1;
    wakeLockRequest = null;
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    const video = keepAliveVideoEl;
    keepAliveVideoEl = null;
    keepAlivePlay = null;
    if (video) {
      try { video.pause?.(); video.remove?.(); } catch {}
    }
    setScreenAwakeNotice('idle', '未启用', '未申请保持亮屏');
    if (sentinel) { try { await sentinel.release(); } catch {} }
  }

  function getScreenAwakeDetail() {
    return screenAwakeDetail || screenAwakeMessage;
  }

  return {
    setScreenAwakeNotice,
    getScreenAwakeDetail,
    playKeepAliveVideo,
    acquireWakeLock,
    releaseWakeLock,
  };
}
