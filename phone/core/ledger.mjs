import { BleClientError } from '../ble-client.mjs';
import {
  isValidTargetCameras,
  isValidActiveParticipants,
  getTakeDurationMs,
  findTemplateAction,
  getProgressEntryKey,
  summarizeActionProgress,
  getPresetPrefix,
} from './formatters.mjs';

export { summarizeActionProgress };

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

export const ledgerPrefix = projectId => `dji-ledger:${encodeURIComponent(projectId)}:`;
export const ledgerEventKey = (projectId, seq) => `${ledgerPrefix(projectId)}event:${seq}`;
export const ledgerCursorKey = projectId => `${ledgerPrefix(projectId)}cursor`;
export const localAckPrefix = projectId => `dji-ack:${encodeURIComponent(projectId)}:`;
export const localAckKey = (projectId, takeId) => `${localAckPrefix(projectId)}${takeId}`;
export const localAckListKey = projectId => `dji-ack-list:${encodeURIComponent(projectId)}`;

export function getTakeBucketKey(projectId, templateId, actionId) {
  return JSON.stringify([String(projectId || ''), String(templateId || ''), String(actionId || '')]);
}

export function listLocalOperatorAcks(storage, projectId) {
  if (!storage || typeof storage.getItem !== 'function' || typeof projectId !== 'string' || !projectId) {
    return [];
  }
  const found = new Set();
  const rawList = storage.getItem(localAckListKey(projectId));
  if (rawList) {
    try {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const id = Number(item);
          if (Number.isSafeInteger(id) && id > 0 && storage.getItem(localAckKey(projectId, id)) === '1') {
            found.add(id);
          }
        }
      }
    } catch {
      // Ignore malformed local ack list index; per-take keys remain authoritative if enumerable.
    }
  }
  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    const prefix = localAckPrefix(projectId);
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (typeof k === 'string' && k.startsWith(prefix)) {
        const id = Number(k.slice(prefix.length));
        if (Number.isSafeInteger(id) && id > 0 && storage.getItem(k) === '1') {
          found.add(id);
        }
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function isTakeLocallyAcked(storage, projectId, takeId) {
  if (!storage || typeof storage.getItem !== 'function' || !projectId || !Number.isSafeInteger(takeId) || takeId <= 0) {
    return false;
  }
  return storage.getItem(localAckKey(projectId, takeId)) === '1';
}

export function setTakeLocallyAcked(storage, projectId, takeId, acked = true) {
  if (!storage || typeof storage.setItem !== 'function' || !projectId || !Number.isSafeInteger(takeId) || takeId <= 0) {
    return [];
  }
  const current = new Set(listLocalOperatorAcks(storage, projectId));
  if (acked) {
    storage.setItem(localAckKey(projectId, takeId), '1');
    current.add(takeId);
  } else {
    storage.removeItem?.(localAckKey(projectId, takeId));
    current.delete(takeId);
  }
  const next = [...current].sort((a, b) => a - b);
  storage.setItem(localAckListKey(projectId), JSON.stringify(next));
  return next;
}

export function hasExistingLocalProject(storage, projectId) {
  if (!storage || typeof storage.getItem !== 'function' || typeof projectId !== 'string' || !projectId.trim()) {
    return false;
  }
  const id = projectId.trim();
  return (
    storage.getItem(ledgerCursorKey(id)) !== null ||
    storage.getItem(ledgerEventKey(id, 1)) !== null ||
    listLocalOperatorAcks(storage, id).length > 0
  );
}

export function suggestDefaultProjectId(templateId, storage, ts = Date.now()) {
  const prefix = getPresetPrefix(templateId);
  const d = new Date(ts);
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const base = `${prefix}_${y}${m}${day}`;
  try {
    if (!storage || !hasExistingLocalProject(storage, base)) return base;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${base}_${i}`;
      if (!hasExistingLocalProject(storage, candidate)) return candidate;
    }
  } catch {
    return base;
  }
  return `${base}_${ts % 10000}`;
}

export function readCursorValue(storage, projectId) {
  const raw = storage.getItem(ledgerCursorKey(projectId)) ?? '0';
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BleClientError('invalid_local_cursor', 'Invalid local cursor', { project_id: projectId });
  }
  return n;
}

export function loadCursor(storage, projectId) {
  if (!projectId) return 0;
  const claimed = readCursorValue(storage, projectId);
  for (let seq = 1; seq <= claimed; seq++) {
    const raw = storage.getItem(ledgerEventKey(projectId, seq));
    if (raw === null) return seq - 1; // Continuous-prefix recovery; never trust gap after missing event.
    let event;
    try {
      event = JSON.parse(raw);
    } catch (cause) {
      throw new BleClientError('invalid_cached_ledger_json', 'Invalid cached ledger JSON', {
        cause,
        project_id: projectId,
        event_seq: seq,
      });
    }
    if (!event || typeof event !== 'object' || event.project_id !== projectId || event.event_seq !== seq) {
      throw new BleClientError('invalid_cached_ledger_identity', 'Invalid cached ledger identity', {
        project_id: projectId,
        event_seq: seq,
      });
    }
  }
  return claimed;
}

export async function persistEventToStorage(storage, event, { after_seq = event?.event_seq, raw } = {}) {
  if (!event || typeof event.project_id !== 'string' || !event.project_id ||
      !Number.isSafeInteger(event.event_seq) || event.event_seq < 1) {
    throw new BleClientError('invalid_log_event', 'Invalid log event identity');
  }
  const key = ledgerEventKey(event.project_id, event.event_seq);
  const bytes = raw instanceof Uint8Array
    ? raw
    : (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw))
      ? new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length)
      : utf8Encoder.encode(JSON.stringify(event));
  const text = utf8Decoder.decode(bytes);
  const previous = storage.getItem(key);
  if (previous !== null && previous !== text) {
    throw new BleClientError('cached_event_conflict', 'Cached event conflict', {
      project_id: event.project_id,
      event_seq: event.event_seq,
    });
  }
  // Write raw event first, then advance project cursor.
  storage.setItem(key, text);
  const next = Math.max(readCursorValue(storage, event.project_id), after_seq);
  storage.setItem(ledgerCursorKey(event.project_id), String(next));
}

export function foldEventsToTakes(events = []) {
  const takesById = new Map();
  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    const takeId = evt.take_id;
    if (!Number.isSafeInteger(takeId) || takeId < 1) continue;
    if (evt.type === 'TAKE_BEGIN') {
      const existing = takesById.get(takeId);
      takesById.set(takeId, {
        take_id: takeId,
        project_id: evt.project_id || existing?.project_id || '',
        template_id: evt.template_id || existing?.template_id || '',
        initial_action_id: evt.action_id ?? existing?.initial_action_id ?? '',
        initial_point_id: evt.point_id ?? existing?.initial_point_id ?? '',
        action_id: existing?.reassigned ? existing.action_id : (evt.action_id ?? ''),
        point_id: existing?.reassigned ? existing.point_id : (evt.point_id ?? ''),
        command_id: evt.command_id || existing?.command_id || '',
        source: evt.source || existing?.source || '',
        participants: isValidActiveParticipants(evt.participants) ? evt.participants : (existing?.participants ?? 0),
        boot_id: evt.boot_id || existing?.boot_id || '',
        begin_mono_ms: evt.mono_ms ?? existing?.begin_mono_ms ?? null,
        end_mono_ms: existing?.end_mono_ms ?? null,
        end_boot_id: existing?.end_boot_id ?? '',
        time_anchor: evt.time_anchor ?? existing?.time_anchor ?? null,
        discarded: existing?.discarded ?? false,
        reassigned: existing?.reassigned ?? false,
        ended: existing?.ended ?? false,
        complete: existing?.complete ?? false,
        reason: existing?.reason ?? '',
        observation_lost: existing?.observation_lost ?? false,
        cameras: existing?.cameras ?? null,
      });
    } else if (evt.type === 'TAKE_END') {
      const existing = takesById.get(takeId) || {
        take_id: takeId,
        project_id: evt.project_id || '',
        template_id: evt.template_id || '',
        initial_action_id: evt.action_id ?? '',
        initial_point_id: evt.point_id ?? '',
        action_id: evt.action_id ?? '',
        point_id: evt.point_id ?? '',
        command_id: '',
        source: '',
        participants: 0,
        boot_id: evt.begin_boot_id || '',
        begin_mono_ms: evt.begin_mono_ms ?? null,
        end_mono_ms: null,
        time_anchor: null,
        discarded: false,
        reassigned: false,
        ended: false,
        complete: false,
        reason: '',
        observation_lost: false,
        cameras: null,
      };
      existing.ended = true;
      existing.end_mono_ms = evt.mono_ms ?? null;
      existing.end_boot_id = evt.boot_id || '';
      existing.complete = Boolean(evt.complete);
      existing.reason = evt.reason || '';
      existing.observation_lost = Boolean(evt.observation_lost);
      if (!existing.time_anchor && evt.time_anchor) existing.time_anchor = evt.time_anchor;
      if (!existing.action_id && evt.action_id) existing.action_id = evt.action_id;
      if (!existing.point_id && evt.point_id) existing.point_id = evt.point_id;
      existing.cameras = Array.isArray(evt.cameras) ? evt.cameras.map(cam => ({ ...cam })) : [];
      if (!isValidTargetCameras(existing.participants) && existing.cameras.length >= 2) {
        const inferred = (existing.cameras[0]?.participating ? 1 : 0) | (existing.cameras[1]?.participating ? 2 : 0);
        if (isValidTargetCameras(inferred)) existing.participants = inferred;
      }
      takesById.set(takeId, existing);
    } else if (evt.type === 'MARK_DISCARD') {
      const existing = takesById.get(takeId);
      if (existing) {
        existing.discarded = Boolean(evt.discard);
      }
    } else if (evt.type === 'REASSIGN') {
      const existing = takesById.get(takeId);
      if (existing) {
        existing.action_id = evt.action_id ?? '';
        existing.point_id = evt.point_id ?? '';
        existing.reassigned = true;
      }
    }
  }
  const sortedTakes = [...takesById.values()].sort((a, b) => a.take_id - b.take_id);
  let camASeq = 0;
  let camBSeq = 0;
  const actionSegCounters = new Map();
  for (const take of sortedTakes) {
    const camAObserved = take.cameras?.[0]?.seen_recording === true;
    const camBObserved = take.cameras?.[1]?.seen_recording === true;
    take.cam_a_clip_seq = camAObserved ? ++camASeq : null;
    take.cam_b_clip_seq = camBObserved ? ++camBSeq : null;
    if (!take.discarded && take.action_id) {
      const nextSeg = (actionSegCounters.get(take.action_id) || 0) + 1;
      actionSegCounters.set(take.action_id, nextSeg);
      take.segment_no = nextSeg;
    } else {
      take.segment_no = null;
    }
  }
  return sortedTakes;
}

export function buildLedgerBucketIndex(takes = [], projectId = '') {
  const takesByBucket = new Map();
  for (const take of takes) {
    if (!take || (projectId && take.project_id !== projectId)) continue;
    const key = getTakeBucketKey(take.project_id, take.template_id, take.action_id);
    let bucket = takesByBucket.get(key);
    if (!bucket) {
      bucket = [];
      takesByBucket.set(key, bucket);
    }
    bucket.push(take);
  }
  return takesByBucket;
}

export function getTakesForAction(ledger, projectId, templateId, actionId, { pointId = null, descending = true } = {}) {
  if (!ledger || !projectId || !templateId || !actionId) return [];
  const key = getTakeBucketKey(projectId, templateId, actionId);
  let list;
  if (ledger.takesByBucket instanceof Map) {
    list = ledger.takesByBucket.get(key) || [];
  } else {
    list = (ledger.takes || []).filter(t =>
      t.project_id === projectId && t.template_id === templateId && t.action_id === actionId
    );
  }
  const filtered = pointId !== null && pointId !== undefined
    ? list.filter(t => (t.point_id || '') === pointId)
    : list;
  if (!descending) return [...filtered];
  return [...filtered].sort((a, b) => b.take_id - a.take_id);
}

export function loadProjectLedger(storage, projectId) {
  if (!projectId) {
    return {
      project_id: '',
      after_seq: 0,
      events: [],
      takes: [],
      progress: new Map(),
      takesByBucket: new Map(),
      local_operator_acks: [],
    };
  }
  const cursor = loadCursor(storage, projectId);
  const events = [];
  for (let seq = 1; seq <= cursor; seq++) {
    const raw = storage.getItem(ledgerEventKey(projectId, seq));
    if (raw === null) break;
    events.push(JSON.parse(raw));
  }
  const takes = foldEventsToTakes(events);
  const localAckIds = listLocalOperatorAcks(storage, projectId);
  const localAcks = new Set(localAckIds);
  const progress = new Map();
  const takesByBucket = new Map();
  const bumpStats = (bucket, take) => {
    if (take.ended && take.complete) bucket.completeCount += 1;
    else if (take.ended && !take.complete) {
      bucket.abnormalCount += 1;
      if (localAcks.has(take.take_id)) bucket.localAckCount += 1;
    } else if (!take.ended) {
      bucket.unfinishedCount += 1;
    }
  };
  for (const take of takes) {
    if (take.project_id !== projectId) continue;
    const bucketKey = getTakeBucketKey(take.project_id, take.template_id, take.action_id);
    let bucketList = takesByBucket.get(bucketKey);
    if (!bucketList) {
      bucketList = [];
      takesByBucket.set(bucketKey, bucketList);
    }
    bucketList.push(take);

    if (take.discarded || !take.action_id || typeof take.template_id !== 'string' || !take.template_id) continue;
    const key = getProgressEntryKey(take.template_id, take.action_id);
    let entry = progress.get(key);
    if (!entry) {
      entry = { completeCount: 0, abnormalCount: 0, localAckCount: 0, unfinishedCount: 0, points: new Map() };
      progress.set(key, entry);
    }
    bumpStats(entry, take);
    const pointId = typeof take.point_id === 'string' ? take.point_id : '';
    let pointEntry = entry.points.get(pointId);
    if (!pointEntry) {
      pointEntry = { completeCount: 0, abnormalCount: 0, localAckCount: 0, unfinishedCount: 0 };
      entry.points.set(pointId, pointEntry);
    }
    bumpStats(pointEntry, take);
  }
  return {
    project_id: projectId,
    after_seq: cursor,
    events,
    takes,
    progress,
    takesByBucket,
    local_operator_acks: localAckIds,
  };
}

export function summarizeGroupQueue(template, currentAction, progress, templateId = template?.template_id || '') {
  const orderedAll = [...(template?.actions || [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.action_id.localeCompare(b.action_id)
  );
  if (!currentAction) {
    return {
      exactGroup: '',
      groupActions: [],
      pendingItems: [],
      completedItems: [],
      staticTotal: 0,
      staticDone: 0,
      dynamicTotal: 0,
      dynamicDone: 0,
      pendingCount: 0,
      totalCount: 0,
      relatedGroups: [],
      relatedTotalCount: 0,
      relatedPendingCount: 0,
      nextGroup: null,
    };
  }

  const hasProg = Boolean(progress instanceof Map && templateId && templateId === template?.template_id);
  const exactGroup = currentAction.group || '';
  const groupActions = orderedAll.filter(a => a.group === exactGroup);

  let staticTotal = 0;
  let staticDone = 0;
  let dynamicTotal = 0;
  let dynamicDone = 0;
  const rawPending = [];
  const completedItems = [];

  for (const act of groupActions) {
    const summary = hasProg ? summarizeActionProgress(act, templateId, progress) : {
      state: 'unshot', completeCount: 0, abnormalCount: 0, localAckCount: 0, unfinishedCount: 0, completedPoints: 0, totalPoints: 0,
    };
    const isDone = summary.state === 'complete' || summary.state === 'manual_ok';
    if (act.type === 'static') {
      staticTotal += 1;
      if (isDone) staticDone += 1;
    } else {
      dynamicTotal += 1;
      if (isDone) dynamicDone += 1;
    }
    if (isDone) {
      completedItems.push({ action: act, summary });
    } else {
      rawPending.push({ action: act, summary });
    }
  }

  // Rotate pending items so currentAction (if pending) comes first, then subsequent pending items in order, then earlier pending items.
  const curIdxInGroup = groupActions.findIndex(a => a.action_id === currentAction.action_id);
  const pendingItems = [];
  if (rawPending.length > 0) {
    const afterCurrent = [];
    const beforeCurrent = [];
    for (const item of rawPending) {
      const idx = groupActions.findIndex(a => a.action_id === item.action.action_id);
      if (curIdxInGroup === -1 || idx >= curIdxInGroup) {
        afterCurrent.push(item);
      } else {
        beforeCurrent.push(item);
      }
    }
    pendingItems.push(...afterCurrent, ...beforeCurrent);
  }

  // Related groups sharing room_key (strictly excluding 房间孔洞 and 默认分组)
  const roomKey = String(currentAction.room_key || '').trim();
  const relatedGroups = [];
  let relatedTotalCount = 0;
  let relatedPendingCount = 0;
  if (roomKey && roomKey !== '房间孔洞' && roomKey !== '默认分组') {
    const relMap = new Map();
    for (const act of orderedAll) {
      if (act.room_key === roomKey && act.group !== exactGroup) {
        if (!relMap.has(act.group)) relMap.set(act.group, []);
        relMap.get(act.group).push(act);
      }
    }
    for (const [grpName, acts] of relMap) {
      let pendingInRel = 0;
      let firstPendingAction = null;
      for (const act of acts) {
        const s = hasProg ? summarizeActionProgress(act, templateId, progress) : { state: 'unshot' };
        const isDone = s.state === 'complete' || s.state === 'manual_ok';
        if (!isDone) {
          pendingInRel += 1;
          if (!firstPendingAction) firstPendingAction = act;
        }
      }
      relatedGroups.push({
        group: grpName,
        actions: acts,
        totalCount: acts.length,
        pendingCount: pendingInRel,
        firstPendingAction,
        firstAction: acts[0] || null,
      });
      relatedTotalCount += acts.length;
      relatedPendingCount += pendingInRel;
    }
  }

  // Next group preview in template order
  const groupOrder = [];
  const byGroup = new Map();
  for (const act of orderedAll) {
    if (!byGroup.has(act.group)) {
      byGroup.set(act.group, []);
      groupOrder.push(act.group);
    }
    byGroup.get(act.group).push(act);
  }
  let nextGroup = null;
  if (groupOrder.length > 1) {
    const curGrpIdx = groupOrder.indexOf(exactGroup);
    const startOffset = curGrpIdx >= 0 ? curGrpIdx + 1 : 0;
    let firstFallback = null;
    for (let offset = 0; offset < groupOrder.length; offset++) {
      const grpName = groupOrder[(startOffset + offset) % groupOrder.length];
      if (grpName === exactGroup) continue;
      const acts = byGroup.get(grpName) || [];
      let pendingInNext = 0;
      let firstPendingAction = null;
      for (const act of acts) {
        const s = hasProg ? summarizeActionProgress(act, templateId, progress) : { state: 'unshot' };
        const isDone = s.state === 'complete' || s.state === 'manual_ok';
        if (!isDone) {
          pendingInNext += 1;
          if (!firstPendingAction) firstPendingAction = act;
        }
      }
      const info = {
        group: grpName,
        totalCount: acts.length,
        pendingCount: pendingInNext,
        firstPendingAction,
        firstAction: acts[0] || null,
        allDone: pendingInNext === 0,
      };
      if (!firstFallback) firstFallback = info;
      if (pendingInNext > 0) {
        nextGroup = info;
        break;
      }
    }
    if (!nextGroup) nextGroup = firstFallback;
  }

  return {
    exactGroup,
    groupActions,
    pendingItems,
    completedItems,
    staticTotal,
    staticDone,
    dynamicTotal,
    dynamicDone,
    pendingCount: rawPending.length,
    totalCount: groupActions.length,
    relatedGroups,
    relatedTotalCount,
    relatedPendingCount,
    nextGroup,
  };
}

// === GMP RFC 4180 CSV Export & Anti-Formula Injection (CWE-1236) ===

export function escapeCsvCell(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val).replace(/[\r\n]+/g, ' ').replace(/^[ ]+|[ ]+$/g, '');
  if (/^[=+\-@\t|]/.test(str)) {
    str = "'" + str;
  }
  str = str.replace(/"/g, '""');
  return `"${str}"`;
}

export function exportLedgerCsv(ledger, template, { now = Date.now } = {}) {
  const takes = Array.isArray(ledger?.takes) ? ledger.takes : [];

  const headers = [
    'take_id',
    'action_id',
    'action_name',
    'point_id',
    'point_name',
    'participants',
    'complete',
    'discarded',
    'reason',
    'time_anchor_utc',
    'duration_s',
    'cam_a_recording',
    'cam_a_battery',
    'cam_b_recording',
    'cam_b_battery',
    'cam_a_clip_seq',
    'cam_b_clip_seq',
    'segment_no',
    'action_description',
  ];

  const rows = [headers.map(escapeCsvCell).join(',')];

  for (const take of takes) {
    const act = findTemplateAction(template, take.template_id, take.action_id);
    const actName = act?.name || take.action_id || '';
    const pt = act?.points?.find(p => p.point_id === take.point_id);
    const ptName = pt?.name || (take.point_id ? `${take.point_id} (现场点位)` : '未指定');

    let participantsDesc = '未知';
    if (take.participants === 3) participantsDesc = '双机同拍';
    else if (take.participants === 1) participantsDesc = '只拍A机';
    else if (take.participants === 2) participantsDesc = '只拍B机';

    const camA = take.cameras?.[0];
    const camB = take.cameras?.[1];

    const durationMs = getTakeDurationMs(take);
    const durationSec = durationMs !== null ? (durationMs / 1000).toFixed(1) : '';

    let timeAnchorUtc = '';
    if (Number.isFinite(take.time_anchor?.utc_ms) && take.time_anchor.utc_ms > 0) {
      try {
        timeAnchorUtc = new Date(take.time_anchor.utc_ms).toISOString();
      } catch {
        timeAnchorUtc = '';
      }
    }

    const row = [
      take.take_id,
      take.action_id || '',
      actName,
      take.point_id || '',
      ptName,
      participantsDesc,
      take.complete ? '是' : '否',
      take.discarded ? '废片' : '有效',
      take.reason || '',
      timeAnchorUtc,
      durationSec,
      camA?.seen_recording ? '已录制' : '未录制',
      camA?.battery ?? '',
      camB?.seen_recording ? '已录制' : '未录制',
      camB?.battery ?? '',
      Number.isSafeInteger(take.cam_a_clip_seq) && take.cam_a_clip_seq > 0 ? take.cam_a_clip_seq : '',
      Number.isSafeInteger(take.cam_b_clip_seq) && take.cam_b_clip_seq > 0 ? take.cam_b_clip_seq : '',
      Number.isSafeInteger(take.segment_no) && take.segment_no > 0 ? take.segment_no : '',
      act?.description || '',
    ];
    rows.push(row.map(escapeCsvCell).join(','));
  }

  return '\uFEFF' + rows.join('\r\n');
}
