import { BleClientError } from '../ble-client.mjs';
import {
  LED_LABELS,
  TARGET_CAMERA_LABELS,
  PRESET_PROJECT_PREFIX,
} from './constants.mjs';

let commandSeqCounter = 0;

export function describeLed(led) {
  return LED_LABELS[led] ?? '未知状态';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `约 ${(bytes / 1024).toFixed(1)} KB`;
  return `约 ${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function createCommandId(nowMs = Date.now()) {
  commandSeqCounter = (commandSeqCounter + 1) % 1296;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  const suffix = commandSeqCounter.toString(36);
  const raw = `BLE_${Number(nowMs).toString(36)}_${rand}${suffix}`;
  return raw.slice(0, 63);
}

export function isValidAsciiId(value, maxBytes = 63) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxBytes) return false;
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

export function isValidTargetCameras(value) {
  return Number.isInteger(value) && value >= 1 && value <= 3;
}

export function isValidActiveParticipants(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

export function describeTargetCameras(mask) {
  return TARGET_CAMERA_LABELS[mask] ?? '未指定相机';
}

export function computeCameraAdmission(cameras = [], targetCameras = 3) {
  const list = Array.isArray(cameras) ? cameras : [];
  const anyConnectedRecording = list.some(c => Boolean(c?.connected && c?.recording === true));
  let readyMask = 0;
  for (let i = 0; i < 2; i++) {
    const cam = list[i];
    if (cam?.connected && cam?.fresh !== false && cam?.video !== false &&
        !cam?.sleeping && !cam?.recording && cam?.ready === true) {
      readyMask |= (i === 0 ? 1 : 2);
    }
  }
  const targetValid = isValidTargetCameras(targetCameras);
  const selectedStale = targetValid && [0, 1].some(i => {
    const bit = i === 0 ? 1 : 2;
    const cam = list[i];
    return Boolean((targetCameras & bit) && cam?.connected && cam?.fresh === false);
  });
  const targetReady = targetValid && !anyConnectedRecording && ((readyMask & targetCameras) === targetCameras);
  return {
    readyMask,
    anyConnectedRecording,
    selectedStale,
    targetReady,
  };
}

export function computeNextTargetMask(currentTarget, clickedBit) {
  if (clickedBit !== 1 && clickedBit !== 2) {
    return isValidTargetCameras(currentTarget) ? currentTarget : 3;
  }
  if (!isValidTargetCameras(currentTarget)) return 3;
  if (currentTarget === 3) return 3 ^ clickedBit;
  if (currentTarget === clickedBit) return 3 ^ clickedBit; // anti-zero swap to other camera
  return 3;
}

export function isDemoTemplateId(templateId) {
  return templateId === 'CLEANROOM_SMOKE_V1' || templateId === 'HARDWARE_ACCEPTANCE_V1';
}

export function describeStorageErrorCode(code) {
  const clean = String(code || '').trim();
  if (!clean) return '';
  if (clean === 'storage_full' || clean === 'QuotaExceededError') return `空间已满 ${clean}`;
  if (clean === 'read_only' || clean === 'sd_readonly') return `只读保护 ${clean}`;
  return `写入异常 ${clean}`;
}

export function formatTakeCameraSummary(cam, camLetter, takeParticipants = 0, slotIndex = 0, clipSeq = null) {
  const slotBit = slotIndex === 0 ? 1 : 2;
  const bitParticipated = isValidTargetCameras(takeParticipants)
    ? Boolean(takeParticipants & slotBit)
    : true;
  const clipSuffix = Number.isSafeInteger(clipSeq) && clipSeq > 0
    ? ` · 观察段次 ${camLetter}${clipSeq}`
    : '';
  if (!cam) {
    if (isValidTargetCameras(takeParticipants) && !bitParticipated) {
      return `相机${camLetter}：本条未参与${clipSuffix}`;
    }
    return `相机${camLetter}：等待拍摄结果${clipSuffix}`;
  }
  const participated = cam.participating !== undefined ? Boolean(cam.participating) : bitParticipated;
  const hadActivity = Boolean(
    cam.seen_recording || cam.start_sent || cam.start_failed ||
    cam.stop_sent || cam.stop_failed || cam.final_recording
  );
  if (!participated && !hadActivity) {
    return `相机${camLetter}：本条未参与${clipSuffix}`;
  }
  return `相机${camLetter}：${cam.seen_recording ? '已观察到录像' : '未确认开始录像'}，${cam.stop_confirmed ? '已停止' : '未确认停止'}${clipSuffix}`;
}

export function getTakeDurationMs(take) {
  if (!take?.boot_id || !take.end_boot_id || take.boot_id !== take.end_boot_id ||
      !Number.isFinite(take.begin_mono_ms) || !Number.isFinite(take.end_mono_ms) ||
      take.end_mono_ms < take.begin_mono_ms) return null;
  return take.end_mono_ms - take.begin_mono_ms;
}

export function formatElapsedMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function findTemplateAction(template, templateId, actionId) {
  if (!templateId || templateId !== template?.template_id) return null;
  return template.actions?.find(action => action.action_id === actionId) || null;
}

export function deduceNextPointId(existingPoints = []) {
  let maxNum = 0;
  let useTwoDigits = true;
  for (const pt of existingPoints) {
    const pid = typeof pt === 'string' ? pt : (pt?.point_id || '');
    const m = pid.match(/^P(\d+)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxNum) maxNum = num;
      if (m[1].length === 1 && maxNum < 10) useTwoDigits = false;
    }
  }
  const nextNum = maxNum + 1;
  return useTwoDigits && nextNum < 10 ? `P0${nextNum}` : `P${nextNum}`;
}

export function isValidPointId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length < 1 || trimmed.length > 16) return false;
  return /^[A-Za-z0-9_\-]+$/.test(trimmed);
}

export function deriveRoomKey(group) {
  const text = String(group ?? '').trim();
  if (!text) return '默认分组';
  if (text.includes('→') && text.includes('孔洞')) return '房间孔洞';
  const match = text.match(/CLZ-[A-Za-z]?\d+/i);
  if (match) return match[0].toUpperCase();
  return text;
}

export function normalizeTemplate(rawTemplate) {
  if (!rawTemplate || typeof rawTemplate !== 'object' ||
      typeof rawTemplate.template_id !== 'string' || !rawTemplate.template_id.trim() ||
      !Array.isArray(rawTemplate.actions)) {
    throw new BleClientError('invalid_template', 'Invalid actions template');
  }
  const actions = rawTemplate.actions
    .filter(item => item && typeof item === 'object' && typeof item.action_id === 'string' && item.action_id.trim())
    .map((item, idx) => {
      const group = typeof item.group === 'string' && item.group.trim() ? item.group.trim() : '默认分组';
      return {
        action_id: item.action_id.trim(),
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.action_id.trim(),
        type: item.type === 'static'
          ? 'static'
          : item.type === 'dynamic'
            ? 'dynamic'
            : (item.action_id.trim().toUpperCase().startsWith('S') ? 'static' : 'dynamic'),
        group,
        room_key: typeof item.room_key === 'string' && item.room_key.trim() ? item.room_key.trim() : deriveRoomKey(group),
        description: typeof item.description === 'string' ? item.description.trim() : '',
        ...(typeof item.criteria === 'string' && item.criteria.trim() ? { criteria: item.criteria.trim() } : {}),
        doc_ref: item.doc_ref && typeof item.doc_ref === 'object'
          ? { section: String(item.doc_ref.section ?? '').trim(), seq: String(item.doc_ref.seq ?? '').trim() }
          : null,
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : idx + 1,
        points: Array.isArray(item.points)
          ? item.points
              .filter(p => p && typeof p.point_id === 'string' && p.point_id.trim())
              .map(p => ({
                point_id: p.point_id.trim(),
                name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.point_id.trim(),
                ...(p.orphan === true ? { orphan: true } : {}),
              }))
          : [],
      };
    })
    .sort((a, b) => a.order - b.order || a.action_id.localeCompare(b.action_id));

  return {
    schema_version: Number(rawTemplate.schema_version) || 1,
    template_id: rawTemplate.template_id.trim(),
    template_name: typeof rawTemplate.template_name === 'string' && rawTemplate.template_name.trim()
      ? rawTemplate.template_name.trim()
      : rawTemplate.template_id.trim(),
    ...(typeof rawTemplate.area_name === 'string' && rawTemplate.area_name.trim()
      ? { area_name: rawTemplate.area_name.trim() }
      : {}),
    ...(typeof rawTemplate.source_doc === 'string' && rawTemplate.source_doc.trim()
      ? { source_doc: rawTemplate.source_doc.trim() }
      : {}),
    default_criteria: typeof rawTemplate.default_criteria === 'string' ? rawTemplate.default_criteria.trim() : '',
    actions,
  };
}

export function formatHumanAreaName(action, template) {
  if (template?.area_name && String(template.area_name).trim()) {
    return String(template.area_name).trim();
  }
  const sec = String(action?.doc_ref?.section || '');
  if (sec.includes('后超滤')) return '后超滤灭活区';
  if (sec.includes('球蛋白超滤')) return '球蛋白超滤灭活区';
  if (sec.includes('融浆区')) return '融浆区';
  const tplName = String(template?.template_name || '');
  for (const area of ['分装一区', '分装二区', '分装三区', '后超滤灭活区', '球蛋白超滤灭活区', '融浆区']) {
    if (tplName.includes(area)) return area;
  }
  const stripped = tplName.replace(/层流气流流型确认.*$/, '').trim();
  return stripped || '当前区域';
}

export function formatHumanSeq(action, { compact = false } = {}) {
  if (!action) return compact ? '未选' : '未选择';
  const phase = action.type === 'static' ? (compact ? '静' : '静态') : (compact ? '动' : '动态');
  const rawNum = String(action.doc_ref?.seq || '').trim() ||
    String(action.action_id || '').replace(/^[SD]/i, '').replace(/^0+/, '') ||
    String(action.order || '');
  if (!rawNum) return phase;
  if (compact) {
    const padded = /^\d+$/.test(rawNum) ? rawNum.padStart(2, '0') : rawNum;
    return `${phase} ${padded}`;
  }
  return `${phase} 第 ${rawNum} 项`;
}

export function formatRoomAndHood(action) {
  const raw = String(action?.group || '').trim();
  const cdMatch = raw.match(/^(CLZ-[^（(]+)[（(]([^）)]+)[）)]$/i);
  if (cdMatch) {
    const room = cdMatch[2].trim();
    const hood = cdMatch[1].trim();
    return { room, hood, display: `${room} · ${hood}` };
  }
  const areaMatch = raw.match(/^([^（(]+)[（(]([^）)]+)[）)]$/);
  if (areaMatch) {
    const room = areaMatch[1].trim();
    const hood = areaMatch[2].trim();
    return { room, hood, display: `${room} · ${hood}` };
  }
  return { room: raw, hood: String(action?.room_key || '').trim(), display: raw };
}

export function formatHumanPointName(pointObj, pointId) {
  if (!pointId) return '';
  if (pointObj && !pointObj.orphan && pointObj.name && pointObj.name !== pointId) {
    return pointObj.name;
  }
  return pointId;
}

export function extractActionDiffParts(action, peersInGroup = []) {
  const full = String(action?.description || '').trim();
  if (!action || !full || !Array.isArray(peersInGroup)) {
    return { hasDiff: false, full, commonPrefix: '', core: full, commonSuffix: '', snippet: full };
  }
  const sameNamePeers = peersInGroup.filter(peer =>
    peer &&
    peer.name === action.name &&
    (!action.group || !peer.group || peer.group === action.group) &&
    typeof peer.description === 'string' &&
    peer.description.trim()
  );
  if (sameNamePeers.length < 2) {
    return { hasDiff: false, full, commonPrefix: '', core: full, commonSuffix: '', snippet: full };
  }

  const allCharArrays = sameNamePeers.map(p => Array.from(p.description.trim()));
  const distinctCount = new Set(allCharArrays.map(arr => arr.join(''))).size;
  if (distinctCount < 2) {
    return { hasDiff: false, full, commonPrefix: '', core: full, commonSuffix: '', snippet: full };
  }

  const minLen = Math.min(...allCharArrays.map(arr => arr.length));
  let lcp = 0;
  while (lcp < minLen && allCharArrays.every(arr => arr[lcp] === allCharArrays[0][lcp])) {
    lcp += 1;
  }
  // Back up slightly if we split right after an opening parenthesis so pairing remains readable.
  if (lcp > 0 && (allCharArrays[0][lcp - 1] === '（' || allCharArrays[0][lcp - 1] === '(')) {
    lcp -= 1;
  }

  let lcs = 0;
  while (
    lcp + lcs < minLen &&
    allCharArrays.every(arr => arr[arr.length - 1 - lcs] === allCharArrays[0][allCharArrays[0].length - 1 - lcs])
  ) {
    lcs += 1;
  }
  // Only strip common suffix when it's meaningful boilerplate (>= 4 chars).
  // Short noun tails like "气流" stay intact so the diff phrase reads naturally.
  const effectiveLcs = lcs >= 4 ? lcs : 0;

  const myChars = Array.from(full);
  const commonPrefix = myChars.slice(0, lcp).join('');
  const commonSuffix = effectiveLcs > 0 ? myChars.slice(myChars.length - effectiveLcs).join('') : '';
  const core = myChars.slice(lcp, myChars.length - effectiveLcs).join('');

  let lead = '';
  let body = core;
  let tail = '';

  if (lcp >= 2) {
    lead = '…';
    if (Array.from(core).length === 0) {
      lead += Array.from(commonPrefix).slice(-4).join('');
    } else if (Array.from(core).length < 6 && lcp >= 4) {
      lead += Array.from(commonPrefix).slice(-4).join('');
    } else {
      body = body.replace(/^[，,、；;：:]+/, '');
    }
  } else if (lcp > 0) {
    lead = commonPrefix;
  }

  if (effectiveLcs >= 4) {
    if (Array.from(core).length === 0) {
      tail = Array.from(commonSuffix).slice(0, 4).join('') + '…';
    } else {
      tail = '…';
    }
  } else {
    tail = commonSuffix;
  }

  const snippet = `${lead}${body}${tail}`.trim() || full;
  return {
    hasDiff: Boolean(lcp > 0 || effectiveLcs > 0),
    full,
    commonPrefix,
    core,
    commonSuffix,
    snippet,
  };
}

export function computeActionDiffSnippet(action, peersInGroup = []) {
  return extractActionDiffParts(action, peersInGroup).snippet;
}

export function getProgressEntryKey(templateId, actionId) {
  return JSON.stringify([templateId, actionId]);
}

export function summarizeActionProgress(action, templateId, progress) {
  const requiredPoints = Array.isArray(action?.points)
    ? action.points.filter(p => p && p.orphan !== true)
    : [];
  const totalPoints = requiredPoints.length;
  if (!action?.action_id || typeof templateId !== 'string' || !templateId || !(progress instanceof Map)) {
    return {
      state: 'unshot',
      completeCount: 0,
      abnormalCount: 0,
      localAckCount: 0,
      unfinishedCount: 0,
      completedPoints: 0,
      coveredPoints: 0,
      totalPoints,
    };
  }
  const entry = progress.get(getProgressEntryKey(templateId, action.action_id));
  if (!entry) {
    return {
      state: 'unshot',
      completeCount: 0,
      abnormalCount: 0,
      localAckCount: 0,
      unfinishedCount: 0,
      completedPoints: 0,
      coveredPoints: 0,
      totalPoints,
    };
  }
  const completeCount = entry.completeCount || 0;
  const abnormalCount = entry.abnormalCount || 0;
  const localAckCount = entry.localAckCount || 0;
  const unfinishedCount = entry.unfinishedCount || 0;
  let completedPoints = 0;
  let coveredPoints = 0;
  if (totalPoints > 0 && entry.points instanceof Map) {
    for (const pt of requiredPoints) {
      const ptEntry = entry.points.get(pt.point_id);
      const hasComplete = (ptEntry?.completeCount || 0) > 0;
      const hasLocalAck = (ptEntry?.localAckCount || 0) > 0;
      if (hasComplete) completedPoints += 1;
      if (hasComplete || hasLocalAck) coveredPoints += 1;
    }
  }
  let state = 'unshot';
  if (totalPoints > 0) {
    if (completedPoints === totalPoints) state = 'complete';
    else if (abnormalCount > localAckCount) state = 'abnormal';
    else if (coveredPoints === totalPoints) state = 'manual_ok';
    else if (coveredPoints > 0) state = 'partial';
    else if (unfinishedCount > 0) state = 'unfinished';
  } else {
    if (completeCount > 0) state = 'complete';
    else if (localAckCount > 0) state = 'manual_ok';
    else if (abnormalCount > 0) state = 'abnormal';
    else if (unfinishedCount > 0) state = 'unfinished';
  }
  return {
    state,
    completeCount,
    abnormalCount,
    localAckCount,
    unfinishedCount,
    completedPoints,
    coveredPoints,
    totalPoints,
  };
}

export function getPresetPrefix(templateId) {
  return PRESET_PROJECT_PREFIX[String(templateId ?? '').trim()] || 'GMP';
}

export function matchesActionQuery(action, rawQuery) {
  const q = (rawQuery ?? '').trim();
  if (!q) return true;
  const lower = q.toLowerCase();
  const idLower = action.action_id.toLowerCase();

  // Single-digit queries stay ID-exact (e.g. "1" -> S01/D01, not CLZ-11).
  // Queries of >= 2 digits also check room_key / group (e.g. "13" -> D13 + CLZ-13).
  if (/^\d+$/.test(q)) {
    const num = Number(q);
    const padded2 = q.padStart(2, '0');
    const padded3 = q.padStart(3, '0');
    const idDigitsMatch = action.action_id.match(/(\d+)/);
    if (idDigitsMatch) {
      const digits = idDigitsMatch[1];
      if (Number(digits) === num || digits === padded2 || digits === padded3 || digits.includes(padded2)) {
        return true;
      }
    }
    if (idLower === `s${padded2}` || idLower === `d${padded2}` || idLower.includes(padded2)) {
      return true;
    }
    if (q.length >= 2) {
      if ((action.room_key || '').toLowerCase().includes(lower)) return true;
      if ((action.group || '').toLowerCase().includes(lower)) return true;
    }
    return false;
  }

  const compactSeq = formatHumanSeq(action, { compact: true }).toLowerCase();
  const fullSeq = formatHumanSeq(action).toLowerCase();
  if (compactSeq.includes(lower) || compactSeq.replace(/\s+/g, '').includes(lower.replace(/\s+/g, ''))) return true;
  if (fullSeq.includes(lower) || fullSeq.replace(/\s+/g, '').includes(lower.replace(/\s+/g, ''))) return true;
  if (idLower.includes(lower)) return true;
  if ((action.name || '').toLowerCase().includes(lower)) return true;
  if ((action.group || '').toLowerCase().includes(lower)) return true;
  if ((action.room_key || '').toLowerCase().includes(lower)) return true;
  if ((action.description || '').toLowerCase().includes(lower)) return true;
  if ((action.doc_ref?.seq || '').toLowerCase().includes(lower)) return true;
  if ((action.doc_ref?.section || '').toLowerCase().includes(lower)) return true;
  if (Array.isArray(action.points)) {
    for (const pt of action.points) {
      if ((pt.point_id || '').toLowerCase().includes(lower) || (pt.name || '').toLowerCase().includes(lower)) {
        return true;
      }
    }
  }
  return false;
}

export function filterActions(actions = [], { query = '', group = 'all', typeFilter = 'all', statusFilter = 'all', progress = new Map(), templateId = '' } = {}) {
  const sorted = [...actions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.action_id.localeCompare(b.action_id));
  return sorted.filter(action => {
    if (group && group !== 'all' && group !== '全部') {
      if (action.room_key !== group && action.group !== group) return false;
    }
    if (typeFilter === 'static') {
      if (action.type !== 'static') return false;
    } else if (typeFilter === 'dynamic') {
      if (action.type !== 'dynamic') return false;
    }
    if (statusFilter === 'shot' || statusFilter === 'unshot' || statusFilter === 'abnormal') {
      const summary = summarizeActionProgress(action, templateId, progress);
      if (statusFilter === 'shot' && summary.state !== 'complete' && summary.state !== 'manual_ok') return false;
      if (statusFilter === 'unshot' && (summary.state === 'complete' || summary.state === 'manual_ok')) return false;
      if (statusFilter === 'abnormal' && (summary.abnormalCount - summary.localAckCount) <= 0) return false;
    }
    return matchesActionQuery(action, query);
  });
}
