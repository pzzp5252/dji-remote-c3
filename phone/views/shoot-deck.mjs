import { ICONS } from '../core/constants.mjs';
import {
  setTextIfChanged,
  setHiddenIfChanged,
  setDisabledIfChanged,
  setAttrIfChanged,
  setDataIfChanged,
  setClassIfChanged,
} from '../core/dom-utils.mjs';
import {
  describeLed,
  describeTargetCameras,
  describeStorageErrorCode,
  computeCameraAdmission,
  formatElapsedMs,
  formatHumanSeq,
  formatHumanPointName,
  isValidTargetCameras,
} from '../core/formatters.mjs';
import { getTakesForAction } from '../core/ledger.mjs';

export function buildCameraDiagSnapshot(camera, vm) {
  const idx = camera === 'b' ? 1 : 0;
  const camLetter = idx === 0 ? 'A' : 'B';
  const slotBit = idx === 0 ? 1 : 2;
  const cam = vm.status.cameras?.[idx];
  const isTakeActive = (vm.status.phase && vm.status.phase !== 'idle') || Boolean(vm.pendingStart) || (vm.status.active_take_id > 0);
  const activeOrTargetMask = isTakeActive
    ? (isValidTargetCameras(vm.status.active_participants) ? vm.status.active_participants : vm.status.target_cameras)
    : vm.status.target_cameras;
  const isSelectedForTake = !isValidTargetCameras(activeOrTargetMask) ? true : Boolean(activeOrTargetMask & slotBit);
  const connected = Boolean(vm.connected && cam?.connected);
  const stale = Boolean(vm.connected && (vm.receiptStale || (cam?.connected && cam?.fresh === false)));
  const recording = connected && !stale && Boolean(cam?.recording);
  const showConnectedDetails = connected || stale;
  const ledCode = Number.isInteger(cam?.led) ? cam.led : 0;
  const modeLabel = !showConnectedDetails ? '未连接'
    : recording ? '正在录像'
    : stale ? '状态待确认'
    : !isSelectedForTake ? '本条不拍'
    : cam?.sleeping ? '休眠中'
    : cam?.video === false ? '请切到录像模式'
    : cam?.ready ? '可以拍摄' : '未就绪';
  const freshText = !vm.connected || !connected ? '未连接'
    : stale ? '超过 3.5 秒未更新'
    : Number.isFinite(cam?.status_age_ms)
      ? (cam.status_age_ms >= 1000 ? `${(cam.status_age_ms / 1000).toFixed(1)} 秒前` : `${cam.status_age_ms} 毫秒前`)
      : '刚刚';
  const batText = !showConnectedDetails ? '—'
    : (connected && Number.isFinite(cam?.battery) ? `${cam.battery}%` : '—（电量未知）');
  const hintText = !connected ? `相机 ${camLetter} 尚未连上遥控器，请检查相机开机状态与蓝牙配对。`
    : stale ? '遥测状态暂时未刷新，请等待遥控器下一次状态推送。'
    : recording ? '相机当前正在录像，停止录像前不能切换机位。'
    : cam?.sleeping ? `相机 ${camLetter} 处于休眠，请唤醒相机后拍摄。`
    : cam?.video === false ? `相机 ${camLetter} 当前不在录像档位，请在机身上切到录像模式。`
    : cam?.ready ? `相机 ${camLetter} 状态正常；关闭弹窗后点击左侧相机卡可切换本条是否拍摄。`
    : `相机 ${camLetter} 暂时未就绪，请检查存储卡与机身提示。`;
  return {
    camLetter,
    participation: vm.connected ? (isSelectedForTake ? '参与本条拍摄' : '本条不拍') : '未连接',
    modeLabel,
    batText,
    freshText,
    recordTime: String(cam?.record_time ?? 0),
    ledCode,
    ledLabel: describeLed(ledCode),
    hintText,
  };
}

export function computeRecordObservationText(vm) {
  const cams = Array.isArray(vm.status.cameras) ? vm.status.cameras : [];
  const { stage, activeMask, observedMask, hasFreshStatus, selectedReady } = vm.control;
  const selectionSupported = vm.status.selectionSupported !== false;
  const targetCameras = vm.status.target_cameras;
  const effectiveTarget = isValidTargetCameras(targetCameras) ? targetCameras : 3;
  const admission = computeCameraAdmission(cams, effectiveTarget);
  const writableOk = vm.status.writable !== false && !vm.status.storage_error;
  const phase = vm.status.phase || 'idle';
  const activeId = vm.status.active_take_id || (phase !== 'idle' ? vm.status.take_id : 0);

  const describeStopCam = (cam, label) => {
    if (!hasFreshStatus || !cam?.connected || cam?.fresh === false) return `${label}未知`;
    return cam.recording ? `${label}仍录` : `${label}已确认空闲`;
  };

  if (stage === 'disconnected') {
    return '未连接遥控器，无法从手机发送停止命令；若刚才正在录像，请直接查看相机屏幕确认';
  }
  if (stage === 'stop_pending') {
    const stopWaitStart = vm.pendingStopStartedAt || vm.pendingStart?.cancelRequestedAt || 0;
    const stopWaitMs = stopWaitStart > 0 ? Math.max(0, vm.nowMs - stopWaitStart) : 0;
    if (stopWaitMs >= 10000) {
      return '遥控器暂未回报停录结果。请直接查看 A/B 相机屏幕与指示灯确认是否仍在录像；若相机仍在录像，请直接按相机机身快门键停止（切勿盲按遥控器按键，以免在已停状态下误开新录像）。';
    }
    if (stopWaitMs >= 3000) {
      return `正在等待遥控器确认停止（已等 ${Math.floor(stopWaitMs / 1000)} 秒）…`;
    }
    return vm.pendingStart?.cancelRequested ? '等待本条编号后停止…' : '正在发送停止…';
  }
  if (stage === 'stopping') {
    const camParts = [];
    if (activeMask & 1) camParts.push(describeStopCam(cams[0], 'A机'));
    if (activeMask & 2) camParts.push(describeStopCam(cams[1], 'B机'));
    return `停止请求已接收，等待相机确认（${camParts.join('，')}）`;
  }
  if (stage === 'recording') {
    if (activeMask === 1) return '只拍 A 机 · 正在录像';
    if (activeMask === 2) return '只拍 B 机 · 正在录像';
    return '双机录像中 · 正在录像';
  }
  if (stage === 'recording_stale') {
    return `#${activeId || vm.status.take_id || '?'} 尚未结案 · 状态超过 3.5 秒未更新（点击下方可发送停止）`;
  }
  if (stage === 'partial') {
    const camARec = Boolean(observedMask & 1);
    const camBRec = Boolean(observedMask & 2);
    if (camARec && !camBRec) return '仅A机录像，B机未确认（点下方可发送停止）';
    if (!camARec && camBRec) return '仅B机录像，A机未确认（点下方可发送停止）';
    return '仅部分相机录像（点下方可发送停止）';
  }
  if (stage === 'starting') {
    if (!hasFreshStatus) return '已发送开始命令，状态待确认（点下方可取消并停止）';
    const targetLabel = activeMask === 1 ? ' A ' : activeMask === 2 ? ' B ' : 'A/B';
    return `正在等待${targetLabel}开始录像（点下方可取消并停止）`;
  }
  if (stage === 'safety_stop') {
    return '本条已结案，但仍检测到相机录像，请先安全停止';
  }
  if (stage === 'settled_cooldown') {
    return '已停止录像 · 防误触冷却中';
  }
  if (stage === 'ready') {
    return '已就绪';
  }

  // blocked
  if (!hasFreshStatus) return '等待相机状态';
  if (!selectionSupported) return '当前遥控器固件暂不支持相机选择，请先升级固件';
  if (!vm.status.project_id) return '请先新建拍摄项目';
  if (!vm.templateMatches) return vm.templateMismatchMessage;
  if (!writableOk) {
    const errDetail = vm.status.storage_error ? `（${describeStorageErrorCode(vm.status.storage_error)}）` : '';
    return `遥控器存储不可写${errDetail}，暂不能开始录像`;
  }
  if (!vm.status.action_id) return '请先选择当前拍摄项（选定后可点下方开关参与拍摄的相机）';
  if (vm.pendingSelect) return '正在保存拍摄项与相机设置，请稍候…';
  if (vm.control.unackedEditBlocked) return '正在等待遥控器确认上一条修改，请稍候…';
  if (!selectedReady) {
    const aReady = Boolean(admission.readyMask & 1);
    const bReady = Boolean(admission.readyMask & 2);
    if (admission.selectedStale) return '相机状态待确认，请等待更新';
    if (effectiveTarget === 3 && !aReady && bReady) {
      return !cams[0]?.connected ? 'A 机未连接，点 A 机卡可暂切“只拍 B 机”' : 'A 机未就绪，点 A 机卡可暂切“只拍 B 机”';
    }
    if (effectiveTarget === 3 && aReady && !bReady) {
      return !cams[1]?.connected ? 'B 机未连接，点 B 机卡可暂切“只拍 A 机”' : 'B 机未就绪，点 B 机卡可暂切“只拍 A 机”';
    }
    if (effectiveTarget === 1) {
      return !cams[0]?.connected ? 'A 机未连接，请检查 A 机或点 A 机卡切“只拍 B 机”' : 'A 机未就绪，请检查 A 机或点 A 机卡切“只拍 B 机”';
    }
    if (effectiveTarget === 2) {
      return !cams[1]?.connected ? 'B 机未连接，请检查 B 机或点 B 机卡切“只拍 A 机”' : 'B 机未就绪，请检查 B 机或点 B 机卡切“只拍 A 机”';
    }
    if (!cams[0]?.connected || !cams[1]?.connected) {
      return !cams[0]?.connected && !cams[1]?.connected ? 'A/B 相机未连接' : !cams[0]?.connected ? 'A 机未连接' : 'B 机未连接';
    }
  }
  return '请检查相机';
}

export function createShootDeck({ el }) {
  function renderCameraDiagModal(vm) {
    const dlg = el('modal-cam-diag');
    if (!dlg || !dlg.open) return;
    const info = buildCameraDiagSnapshot(vm.activeDiagCam, vm);
    setTextIfChanged(el('diag-cam-title'), `相机 ${info.camLetter} 诊断详情`);
    setTextIfChanged(el('diag-cam-participation'), info.participation);
    setTextIfChanged(el('diag-cam-mode'), info.modeLabel);
    setTextIfChanged(el('diag-cam-battery'), info.batText);
    setTextIfChanged(el('diag-cam-fresh'), info.freshText);
    setTextIfChanged(el('diag-cam-record-time'), `${info.recordTime}（机内计时数值，不作录影时长）`);
    const diagLedEl = el('diag-cam-led');
    if (diagLedEl) {
      setTextIfChanged(diagLedEl, info.ledLabel);
      setDataIfChanged(diagLedEl, 'state', info.ledCode === 2 ? 'recording' : info.ledCode === 1 ? 'ready' : info.ledCode === 3 ? 'warn' : 'disconnected');
    }
    setTextIfChanged(el('diag-cam-ready-hint'), info.hintText);
  }

  function renderCameraCard(prefix, cam, vm) {
    const camSuffix = prefix === 'cam-a' ? 'a' : 'b';
    const camLetter = camSuffix === 'a' ? 'A' : 'B';
    const slotBit = camSuffix === 'a' ? 1 : 2;
    const cardEl = el(`card-${prefix}`);
    const toggleBtn = el(`btn-cam-toggle-${camSuffix}`);
    const badgeEl = el(`${prefix}-badge`);
    const badgeTextEl = el(`${prefix}-badge-text`);
    const metricsEl = el(`${prefix}-metrics`);
    const freshEl = el(`${prefix}-fresh`);
    const recTimeEl = el(`${prefix}-record-time`);
    const batEl = el(`${prefix}-battery`);
    const modeEl = el(`${prefix}-mode`);
    const ledEl = el(`${prefix}-led`);

    const isTakeActive = (vm.status.phase && vm.status.phase !== 'idle') || Boolean(vm.pendingStart) || (vm.status.active_take_id > 0);
    const activeOrTargetMask = isTakeActive
      ? (isValidTargetCameras(vm.status.active_participants) ? vm.status.active_participants : vm.status.target_cameras)
      : vm.status.target_cameras;
    const selectionSupported = vm.status.selectionSupported !== false;
    const confirmedMaskValid = selectionSupported && isValidTargetCameras(activeOrTargetMask);
    const isSelectedForTake = !confirmedMaskValid ? false : Boolean(activeOrTargetMask & slotBit);

    const connected = Boolean(vm.connected && cam?.connected);
    const stale = Boolean(vm.connected && (vm.receiptStale || (cam?.connected && cam?.fresh === false)));
    const recording = connected && !stale && Boolean(cam?.recording);
    const cachedRecording = connected && stale && Boolean(cam?.recording);
    const showConnectedDetails = connected || stale;

    const stage = vm.control?.stage;
    const desiredMode = vm.control?.mode || 'start';
    const isStoppingPhase = stage === 'stopping' || stage === 'stop_pending' ||
      vm.status.phase === 'stopping' || vm.status.phase === 'closing' || Boolean(vm.pendingStop || vm.pendingStart?.cancelRequested);
    const hasActionSelected = Boolean(vm.status.action_id);
    const isPendingThis = Boolean(
      vm.pendingSelect &&
      isValidTargetCameras(vm.pendingSelect.target_cameras) &&
      vm.pendingSelect.action_id === vm.status.action_id &&
      (vm.pendingSelect.toggledSlotBit === slotBit ||
        ((vm.pendingSelect.target_cameras ^ (isValidTargetCameras(vm.status.target_cameras) ? vm.status.target_cameras : 0)) & slotBit) !== 0)
    );
    const camHardDisabled = Boolean(
      !vm.connected ||
      !selectionSupported ||
      !vm.templateMatches ||
      !vm.status.project_id ||
      !hasActionSelected ||
      desiredMode === 'stop'
    );
    const toggleDisabled = Boolean(camHardDisabled || vm.pendingSelect);

    if (cardEl) {
      setClassIfChanged(cardEl, 'is-disconnected', !showConnectedDetails);
      setClassIfChanged(cardEl, 'is-stale', stale);
      setClassIfChanged(cardEl, 'is-recording', recording || cachedRecording);
      setClassIfChanged(cardEl, 'is-unselected', Boolean(vm.connected && (!confirmedMaskValid || !isSelectedForTake) && !recording && !cachedRecording));
      setClassIfChanged(cardEl, 'is-ready', Boolean(showConnectedDetails && !stale && !recording && isSelectedForTake && cam?.ready && !cam?.sleeping && cam?.video !== false && hasActionSelected));
      setClassIfChanged(cardEl, 'is-action-unselected', Boolean(vm.connected && vm.status.project_id && vm.templateMatches && !hasActionSelected && !isTakeActive));
      setDataIfChanged(cardEl, 'selected', isSelectedForTake ? 'true' : 'false');
    }
    if (toggleBtn) {
      setDisabledIfChanged(toggleBtn, toggleDisabled);
      setDataIfChanged(toggleBtn, 'transientLock', (!camHardDisabled && Boolean(vm.pendingSelect)) ? 'true' : 'false');
      setAttrIfChanged(toggleBtn, 'aria-pressed', isSelectedForTake ? 'true' : 'false');
      setClassIfChanged(toggleBtn, 'is-active', isSelectedForTake);
      setClassIfChanged(toggleBtn, 'is-pending', isPendingThis);
    }
    if (metricsEl) setHiddenIfChanged(metricsEl, false);

    let badgeLabel = '未连接';
    let badgeState = 'disconnected';
    if (recording) {
      badgeLabel = '正在录像';
      badgeState = 'recording';
    } else if (!showConnectedDetails) {
      badgeLabel = vm.connected && confirmedMaskValid && !isSelectedForTake ? '本条不拍' : '未连接';
      badgeState = 'disconnected';
    } else if (stale) {
      badgeLabel = cachedRecording ? '未确认停' : isSelectedForTake ? '待确认' : '本条不拍';
      badgeState = 'stale';
    } else if (isTakeActive && isSelectedForTake && !isStoppingPhase) {
      badgeLabel = stage === 'partial' ? '尚未确认' : '等待确认';
      badgeState = 'warn';
    } else if (isStoppingPhase && isSelectedForTake) {
      badgeLabel = '已停录';
      badgeState = 'ready';
    } else if (vm.connected && vm.status.project_id && vm.templateMatches && !hasActionSelected) {
      badgeLabel = '未选拍摄项';
      badgeState = 'warn';
    } else if (confirmedMaskValid && !isSelectedForTake) {
      badgeLabel = '本条不拍';
      badgeState = 'unselected';
    } else if (!selectionSupported) {
      badgeLabel = '未就绪';
      badgeState = 'warn';
    } else if (cam?.ready && !cam?.sleeping && cam?.video !== false) {
      badgeLabel = '可以拍摄';
      badgeState = 'ready';
    } else {
      badgeLabel = cam?.sleeping ? '休眠中' : cam?.video === false ? '切录像档' : '未就绪';
      badgeState = 'warn';
    }

    if (badgeEl) {
      setTextIfChanged(badgeTextEl || badgeEl, badgeLabel);
      setDataIfChanged(badgeEl, 'state', badgeState);
    }

    if (toggleBtn) {
      setAttrIfChanged(toggleBtn, 'aria-label', `${camLetter} 机：${badgeLabel}${toggleDisabled ? '（已锁定）' : '，点击切换本条是否拍摄'}`);
    }

    let freshText = '';
    if (freshEl) {
      if (!vm.connected || !connected) {
        freshText = '';
      } else if (stale) {
        const ageMs = vm.lastStatusReceivedAt > 0 ? Math.max(0, vm.nowMs - vm.lastStatusReceivedAt) : 0;
        freshText = ageMs >= 1000 ? `${Math.round(ageMs / 1000)}秒前` : (ageMs > 0 ? `${ageMs}毫秒` : '待更新');
      } else {
        freshText = Number.isFinite(cam?.status_age_ms)
          ? (cam.status_age_ms >= 1000 ? `${(cam.status_age_ms / 1000).toFixed(1)}s` : `${cam.status_age_ms}ms`)
          : '刚刚';
      }
      setTextIfChanged(freshEl, freshText);
    }

    setTextIfChanged(recTimeEl, String(cam?.record_time ?? 0));
    setTextIfChanged(
      batEl,
      !showConnectedDetails
        ? ''
        : (connected && Number.isFinite(cam?.battery)
            ? `${cam.battery}%`
            : (freshText ? '—' : '— 电量未知'))
    );

    if (modeEl) {
      setTextIfChanged(modeEl,
        !showConnectedDetails ? '未连接' :
        recording ? '正在录像' :
        stale ? '暂时无法确认' :
        !isSelectedForTake ? '本条不拍' :
        cam?.sleeping ? '休眠中' :
        cam?.video === false ? '请切到录像模式' :
        cam?.ready ? '可以拍摄' : '暂时无法确认');
    }

    if (ledEl) {
      const ledCode = Number.isInteger(cam?.led) ? cam.led : 0;
      setTextIfChanged(ledEl, describeLed(ledCode));
      setDataIfChanged(ledEl, 'state', ledCode === 2 ? 'recording' : ledCode === 1 ? 'ready' : ledCode === 3 ? 'warn' : 'disconnected');
    }
    if (vm.activeDiagCam === camSuffix) {
      renderCameraDiagModal(vm);
    }
  }

  function renderRecordElapsed(vm) {
    const take = vm.ledger.project_id === vm.status.project_id
      ? vm.ledger.takes.find(t => t.take_id === vm.status.active_take_id) : null;
    const mask = vm.status.active_participants;
    const observedRecording = isValidTargetCameras(mask) && vm.status.cameras.some((cam, i) =>
      (mask & (1 << i)) && cam?.connected && cam?.fresh !== false && cam?.recording === true);
    const control = vm.control;
    let text = '待确认';
    let elapsedState = 'idle';
    const anchor = vm.hardwareClockAnchor;
    const hasHardwareAnchor = Boolean(
      vm.connected &&
      take && !take.ended && take.boot_id && take.boot_id === vm.status.boot_id &&
      anchor?.bootId === take.boot_id && Number.isFinite(take.begin_mono_ms) &&
      anchor.monoMs >= take.begin_mono_ms
    );
    if (!vm.receiptStale && observedRecording && vm.status.phase === 'recording' && hasHardwareAnchor) {
      elapsedState = 'recording';
      text = formatElapsedMs(anchor.monoMs - take.begin_mono_ms + Math.max(0, vm.nowMs - anchor.receivedAt));
    } else if (control.stage === 'recording_stale') {
      elapsedState = 'stale';
      if (hasHardwareAnchor) {
        text = formatElapsedMs(anchor.monoMs - take.begin_mono_ms + Math.max(0, vm.nowMs - anchor.receivedAt));
      } else if (vm.activeLocalStartAt > 0) {
        text = `约 ${formatElapsedMs(vm.nowMs - vm.activeLocalStartAt)}`;
      }
    }
    const elapsedEl = el('record-elapsed');
    if (elapsedEl) {
      setTextIfChanged(elapsedEl, text);
      // 3B: embed elapsed inside STOP button when actively timing or stale; keep '待确认' text for unanchored checks
      setHiddenIfChanged(elapsedEl, elapsedState === 'idle');
      setDataIfChanged(elapsedEl, 'state', elapsedState);
    }
  }

  function renderRecordDeckAndZ3(vm) {
    const phase = vm.status.phase || 'idle';
    const phaseBadge = el('phase-badge');
    const btnRecordMain = el('btn-record-main');
    const btnRecordIcon = el('btn-record-icon');
    const btnRecordLabel = el('btn-record-label');
    const btnRecordMeta = el('btn-record-meta');
    const obsTextEl = el('record-observation-text');
    const z3El = el('shoot-z3-slot');

    const { mode: desiredMode, stage, activeMask, hasFreshStatus, selectedReady, canStart, canStop } = vm.control;
    const selectionSupported = vm.status.selectionSupported !== false;
    const writableOk = vm.status.writable !== false && !vm.status.storage_error;

    if (phaseBadge) {
      if (stage === 'disconnected') {
        setTextIfChanged(phaseBadge, '状态：未连接');
        setDataIfChanged(phaseBadge, 'state', 'disconnected');
      } else if (stage === 'stop_pending' || stage === 'stopping') {
        setTextIfChanged(phaseBadge, '状态：正在停止');
        setDataIfChanged(phaseBadge, 'state', 'warn');
      } else if (stage === 'recording') {
        setTextIfChanged(phaseBadge, '状态：正在录像');
        setDataIfChanged(phaseBadge, 'state', 'recording');
      } else if (stage === 'recording_stale') {
        setTextIfChanged(phaseBadge, '状态：状态未更新');
        setDataIfChanged(phaseBadge, 'state', 'stale');
      } else if (stage === 'partial') {
        setTextIfChanged(phaseBadge, '状态：部分确认');
        setDataIfChanged(phaseBadge, 'state', 'warn');
      } else if (stage === 'starting') {
        setTextIfChanged(phaseBadge, '状态：等待相机状态');
        setDataIfChanged(phaseBadge, 'state', 'warn');
      } else if (stage === 'safety_stop') {
        setTextIfChanged(phaseBadge, '状态：相机录像中');
        setDataIfChanged(phaseBadge, 'state', 'recording');
      } else if (stage === 'settled_cooldown') {
        setTextIfChanged(phaseBadge, '状态：已停止录像');
        setDataIfChanged(phaseBadge, 'state', 'ready');
      } else if (stage === 'ready') {
        setTextIfChanged(phaseBadge, '状态：待机');
        setDataIfChanged(phaseBadge, 'state', 'ready');
      } else if (!hasFreshStatus) {
        setTextIfChanged(phaseBadge, '状态：等待相机状态');
        setDataIfChanged(phaseBadge, 'state', 'stale');
      } else if (!selectionSupported) {
        setTextIfChanged(phaseBadge, '状态：需升级固件');
        setDataIfChanged(phaseBadge, 'state', 'warn');
      } else {
        setTextIfChanged(phaseBadge, '状态：请检查相机');
        setDataIfChanged(phaseBadge, 'state', 'warn');
      }
    }

    const obsText = computeRecordObservationText(vm);
    if (obsTextEl) {
      setTextIfChanged(obsTextEl, obsText);
    }

    const activeId = vm.status.active_take_id || (phase !== 'idle' ? vm.status.take_id : 0);
    const readyExceptPendingSelect = Boolean(
      desiredMode === 'start' &&
      vm.pendingSelect &&
      vm.connected &&
      hasFreshStatus &&
      selectionSupported &&
      vm.status.project_id &&
      vm.status.action_id &&
      vm.templateMatches &&
      writableOk &&
      !vm.control.unackedEditBlocked &&
      selectedReady
    );

    // 3B: Z3 stays 0px (hidden) on healthy ready, healthy recording, and settled_cooldown
    const z3Visible = Boolean(
      stage !== 'ready' &&
      stage !== 'recording' &&
      stage !== 'settled_cooldown' &&
      !readyExceptPendingSelect
    );
    if (z3El) {
      setHiddenIfChanged(z3El, !z3Visible);
      const z3Tone = stage === 'disconnected'
        ? 'disconnected'
        : (stage === 'stop_pending' || stage === 'safety_stop' || stage === 'partial')
          ? 'error'
          : 'warn';
      setDataIfChanged(z3El, 'tone', z3Tone);
    }

    const btnDockReconnect = el('btn-dock-reconnect');
    if (btnDockReconnect) {
      const showDockReconnect = !vm.connected;
      setHiddenIfChanged(btnDockReconnect, !showDockReconnect);
      setDisabledIfChanged(btnDockReconnect, vm.connecting);
      setTextIfChanged(btnDockReconnect, vm.connecting ? '正在连接…' : '重新连接遥控器');
    }
    const recoveryRow = el('record-recovery-actions');
    if (recoveryRow) {
      setHiddenIfChanged(recoveryRow, Boolean(btnDockReconnect?.hidden ?? true));
    }

    if (btnRecordMain) {
      setDisabledIfChanged(btnRecordMain, desiredMode === 'start' ? !canStart : !canStop);
      setDataIfChanged(btnRecordMain, 'transientLock', (desiredMode === 'start' && !canStart && readyExceptPendingSelect) ? 'true' : 'false');
      const desiredClass = stage === 'settled_cooldown'
        ? 'btn record-cta-btn is-cooldown'
        : desiredMode === 'start'
          ? 'btn btn-ready record-cta-btn'
          : 'btn btn-danger record-cta-btn';
      if (btnRecordMain.dataset.mode !== desiredMode || btnRecordMain.className !== desiredClass) {
        btnRecordMain.dataset.mode = desiredMode;
        btnRecordMain.className = desiredClass;
        if (btnRecordIcon) {
          btnRecordIcon.innerHTML = desiredMode === 'start' ? ICONS.record : ICONS.stop;
        }
      }
      const nextLabel = stage === 'settled_cooldown'
        ? '已停止录像（稍候可拍下一条）'
        : desiredMode === 'start'
          ? '开始录像'
          : stage === 'stop_pending'
            ? (vm.pendingStart?.cancelRequested ? '等待本条编号后停止…' : '正在发送停止…')
            : stage === 'starting'
              ? '取消并停止'
              : stage === 'safety_stop'
                ? '安全停止录像'
                : '停止录像';
      setTextIfChanged(btnRecordLabel, nextLabel);

      let metaText = '';
      if (stage === 'settled_cooldown') {
        metaText = '';
      } else if (desiredMode === 'start' && vm.connected && vm.status.project_id &&
          vm.status.action_id && vm.templateMatches && selectionSupported &&
          isValidTargetCameras(vm.status.target_cameras)) {
        const curAct = vm.confirmedAction;
        const ptObj = curAct?.points?.find(p => p.point_id === vm.status.point_id);
        const ptTag = vm.status.point_id
          ? `（${formatHumanPointName(ptObj, vm.status.point_id)}）`
          : '';
        const actionTag = curAct
          ? `${formatHumanSeq(curAct, { compact: true })}${ptTag}`
          : '未收录动作';
        if (!vm.ledgerReadError && vm.ledger.project_id === vm.status.project_id) {
          const validActionTakes = getTakesForAction(
            vm.ledger, vm.status.project_id, vm.template.template_id, vm.status.action_id
          ).filter(t => !t.discarded).length;
          metaText = `${describeTargetCameras(vm.status.target_cameras)} · ${actionTag} · 拍本项归档第 ${validActionTakes + 1} 条`;
        } else {
          metaText = `${describeTargetCameras(vm.status.target_cameras)} · ${actionTag}`;
        }
      } else if (desiredMode === 'stop' && activeId > 0) {
        const activeTakeObj = vm.ledger.project_id === vm.status.project_id
          ? vm.ledger.takes.find(t => t.take_id === activeId)
          : null;
        let segPart = '';
        if (activeTakeObj && !activeTakeObj.discarded && Number.isSafeInteger(activeTakeObj.segment_no) && activeTakeObj.segment_no > 0) {
          segPart = ` · 本项第 ${activeTakeObj.segment_no} 条`;
        } else if (!vm.ledgerReadError && vm.ledger.project_id === vm.status.project_id && vm.status.action_id && vm.templateMatches) {
          const existingValid = getTakesForAction(
            vm.ledger, vm.status.project_id, vm.template.template_id, vm.status.action_id
          ).filter(t => !t.discarded && t.take_id !== activeId).length;
          segPart = ` · 本项第 ${existingValid + 1} 条`;
        }
        const camTag = isValidTargetCameras(activeMask) ? ` · ${describeTargetCameras(activeMask)}` : '';
        const staleTag = stage === 'recording_stale' ? ' · 状态未更新' : '';
        metaText = `#${activeId}${segPart}${camTag}${staleTag}`;
      }
      if (btnRecordMeta) {
        setTextIfChanged(btnRecordMeta, metaText);
        setHiddenIfChanged(btnRecordMeta, !metaText);
      }
      setAttrIfChanged(btnRecordMain, 'aria-label', metaText ? `${nextLabel}，${metaText}` : nextLabel);
    }

    renderRecordElapsed(vm);
    return obsText;
  }

  function render(vm) {
    renderCameraCard('cam-a', vm.status.cameras?.[0], vm);
    renderCameraCard('cam-b', vm.status.cameras?.[1], vm);
    return renderRecordDeckAndZ3(vm);
  }

  return {
    render,
    tick: render,
    renderCameraDiagModal,
  };
}
