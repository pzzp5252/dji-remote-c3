import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { encodeMessage, MessageReassembler } from '../phone/ble-client.mjs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  DjiBleClient, BleClientError, KINDS,
  createApp, createMockBleClient, createMemoryStorage,
  TEMPLATE_CACHE_KEY, SOUND_CACHE_KEY, ledgerEventKey, ledgerCursorKey, loadProjectLedger,
  escapeCsvCell, exportLedgerCsv, deduceNextPointId, isValidPointId,
  filterActions, foldEventsToTakes, formatTakeCameraSummary,
  BUILTIN_PRESETS, getBuiltinPreset, matchesActionQuery, normalizeTemplate,
  formatHumanAreaName, formatHumanSeq, formatRoomAndHood, suggestDefaultProjectId,
  setTakeLocallyAcked, listLocalOperatorAcks, isTakeLocallyAcked, summarizeActionProgress,
  computeActionDiffSnippet, extractActionDiffParts, summarizeGroupQueue, getTakesForAction,
} from '../phone/app.mjs';

// Only browser/BLE boundaries are supplied: rendering, handlers, storage writes,
// event folding, filters and backup serialization are the production app.
const template = {
  schema_version: 1, template_id: 'T', template_name: '现场清单',
  actions: [
    { action_id: 'S01', name: '静态检查', type: 'static', group: '一区', order: 1 },
    { action_id: 'S27', name: '静态烟流', type: 'static', group: '二区', order: 2 },
    { action_id: 'D27', name: '人员操作', type: 'dynamic', group: '一区', order: 3,
      points: [{ point_id: 'P1', name: '传递口' }, { point_id: 'P2', name: '操作口' }] },
    { action_id: 'D28', name: '开门检查', type: 'dynamic', group: '二区', order: 4 },
  ],
};
const event = (seq, type, extra = {}, project = 'P') => ({
  schema_version: 1, project_id: project, template_id: 'T', event_seq: seq,
  type, boot_id: 'boot-one', mono_ms: seq * 1000, ...extra,
});
const completedTake = (project = 'P') => [
  event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '',
    command_id: 'start-001', source: 'ble', participants: 3,
    time_anchor: { boot_id: 'boot-one', mono_ms: 900, utc_ms: 1800000000000 } }, project),
  event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', point_id: '',
    begin_boot_id: 'boot-one', begin_mono_ms: 1000, complete: true,
    reason: 'stopped', observation_lost: false,
    cameras: [
      { seen_recording: true, stop_confirmed: true, record_time: 8, battery: 83, start_ms: 1010, stopped_ms: 1990 },
      { seen_recording: true, stop_confirmed: true, record_time: 8, battery: 79, start_ms: 1020, stopped_ms: 1995 },
    ] }, project),
];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate, label = 'UI operation') {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(`${label} did not settle through the microtask queue`);
}
function replaceGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  });
}
async function fixture(t, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: options.url || 'https://field.example/phone/',
  });
  const scrolls = [];
  dom.window.innerWidth = options.innerWidth ?? 375;
  dom.window.innerHeight = options.innerHeight ?? 667;
  dom.window.scrollTo = (x = 0, y = 0) => {
    const left = typeof x === 'object' && x !== null ? Number(x.left ?? 0) : Number(x ?? 0);
    const top = typeof x === 'object' && x !== null ? Number(x.top ?? 0) : Number(y ?? 0);
    dom.window.scrollX = left;
    dom.window.scrollY = top;
    dom.window.document.documentElement.scrollTop = top;
    scrolls.push({ left, top });
  };
  dom.window.matchMedia = query => {
    const minMatch = String(query).match(/\(min-width:\s*(\d+)px\)/);
    const maxMatch = String(query).match(/\(max-width:\s*(\d+)px\)/);
    let matches = false;
    if (minMatch) matches = dom.window.innerWidth >= Number(minMatch[1]);
    else if (maxMatch) matches = dom.window.innerWidth <= Number(maxMatch[1]);
    return { matches, media: String(query), addEventListener() {}, removeEventListener() {} };
  };
  if (dom.window.HTMLDialogElement && !dom.window.HTMLDialogElement.prototype.showModal) {
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (dom.window.HTMLDialogElement && !dom.window.HTMLDialogElement.prototype.close) {
    dom.window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new dom.window.Event('close'));
    };
  }
  options.configureWindow?.(dom.window);
  replaceGlobal(t, 'location', dom.window.location);
  replaceGlobal(t, 'localStorage', dom.window.localStorage);
  options.initBrowserStorage?.(dom.window.localStorage);
  const client = options.client || createMockBleClient({
    projectId: 'P', templateId: 'T', ackDelayMs: 0,
    autoConfirmRecordingMs: 0, initialEvents: options.events || [],
  });
  let clock = 1800000000000;
  const downloads = [];
  const copies = [];
  const root = dom.window.document.getElementById('root');
  const app = createApp({
    root, ...(options.autoClient ? {} : { client }),
    ...(options.defaultStorage ? {} : { storage: options.storage || createMemoryStorage() }),
    fetchImpl: async () => ({ ok: true, json: async () => structuredClone(template) }),
    now: () => clock,
    monotonicNow: () => clock,
    ...(options.audioContextClass ? { audioContextClass: options.audioContextClass } : {}),
    clipboard: { writeText: async text => { copies.push(text); } },
    download: (name, text, mime) => downloads.push({ name, text, mime }),
    share: options.share ?? null,
  });
  t.after(() => { app.destroy(); app.client.disconnect(); dom.window.close(); });
  await app.ready;
  const q = selector => {
    const node = root.querySelector(selector);
    assert.ok(node, `Missing DOM control ${selector}`);
    return node;
  };
  const change = (selector, value, type = 'change') => {
    const node = q(selector);
    node.value = value;
    node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    return node;
  };
  const resize = (width, height = 667) => {
    dom.window.innerWidth = width;
    dom.window.innerHeight = height;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
  };
  return { app, client: app.client, dom, root, q, change, resize, scrolls, downloads, copies,
    advance: ms => { clock += ms; app.renderStalenessTick(); },
    elapse: ms => { clock += ms; } };
}
async function connect(f) {
  f.q('#btn-connect').click();
  await until(() => f.app.state.connected && !f.app.state.connecting &&
    f.app.state.status.time_synced && !f.app.state.syncingLog &&
    f.q('#status-banner').dataset.tone === 'ok', 'connection and initial log sync');
}
const rows = f => [...f.root.querySelectorAll('#action-list [data-action-id]')].map(n => n.dataset.actionId);
const count = (f, id) => Number(f.q(`#action-list [data-action-id="${id}"] [data-take-count]`).dataset.takeCount);
function holdReply(client, command) {
  const original = client.request.bind(client);
  const reached = deferred();
  const release = deferred();
  let used = false;
  const timer = setTimeout(() => {
    reached.reject(new Error(`holdReply(${command}) timed out (check settled_cooldown or command block)`));
  }, 3000);
  timer?.unref?.();
  client.request = async request => {
    if (request.cmd !== command || used) return original(request);
    used = true;
    clearTimeout(timer);
    const result = await original(request);
    reached.resolve(result);
    await release.promise;
    return result;
  };
  return { reached: reached.promise, release: release.resolve, reject: release.reject };
}

test('imported template, group/type/shot filters and numeric 27 search combine in the DOM', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  assert.deepEqual(rows(f), ['S01', 'S27', 'D27', 'D28']);
  f.q('[data-group-filter="一区"]').click();
  assert.deepEqual(rows(f), ['S01', 'D27']);
  f.q('[data-type-filter="dynamic"]').click();
  assert.deepEqual(rows(f), ['D27']);
  f.q('[data-group-filter="all"]').click();
  f.q('[data-type-filter="static"]').click();
  assert.deepEqual(rows(f), ['S01', 'S27']);
  f.q('[data-status-filter="shot"]').click();
  assert.deepEqual(rows(f), ['S01']);
  f.q('[data-status-filter="unshot"]').click();
  assert.deepEqual(rows(f), ['S27']);
  f.change('#input-action-search', '27', 'input');
  assert.deepEqual(rows(f), ['S27']);
  f.q('[data-type-filter="static"]').click();
  assert.deepEqual(rows(f), ['S27']);
  f.q('[data-type-filter="all"]').click();
  assert.equal(f.root.querySelector('#filter-status-pills [data-status-filter="all"]'), null);
  f.q('[data-status-filter="unshot"]').click(); // toggle off back to all statuses
  f.change('#input-action-search', '传递口', 'input');
  assert.deepEqual(rows(f), ['D27']);
  f.change('#input-action-search', '没有这项', 'input');
  assert.deepEqual(rows(f), []);
});

test('selection keeps the confirmed action and position until success, and rolls back rejection', async t => {
  const f = await fixture(t);
  await connect(f);
  const gate = holdReply(f.client, 'SELECT_ACTION');
  // Step 1: clicking action row expands inline details without sending SELECT_ACTION
  const cmdsBeforeExpand = f.client.mockState.commands.length;
  f.q('[data-action-id="D27"]').click();
  assert.equal(f.client.mockState.commands.length, cmdsBeforeExpand);
  // Step 2: clicking green confirm button sends SELECT_ACTION
  f.q('[data-select-confirm="D27"]').click();
  await gate.reached;
  assert.equal(f.q('#confirmed-action-id').textContent, '静态 第 1 项');
  assert.equal(f.q('#action-pending-badge').hidden, false);
  // Even a status packet received before the command reply is not its ACK.
  f.client.emitStatus();
  assert.equal(f.q('#confirmed-action-id').textContent, '静态 第 1 项');
  gate.release();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.q('#confirmed-action-id').textContent, '动态 第 27 项');
  assert.equal(f.q('#confirmed-action-id').dataset.rawActionId, 'D27');
  assert.equal(f.app.state.status.point_id, 'P1');
  const pointGate = holdReply(f.client, 'SELECT_ACTION');
  f.q('#btn-open-point-sheet').click();
  assert.equal(f.q('#modal-point-list').open, true);
  f.q('[data-point-id="P2"]').click();
  await pointGate.reached;
  assert.equal(f.app.state.status.point_id, 'P1');
  pointGate.release();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.app.state.status.point_id, 'P2');
  const request = f.client.request.bind(f.client);
  f.client.request = cmd => cmd.cmd === 'SELECT_ACTION'
    ? Promise.reject(Object.assign(new Error('device full'), { code: 'storage_full' })) : request(cmd);
  f.q('[data-action-id="S27"]').click();
  f.q('[data-select-confirm="S27"]').click();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.q('#confirmed-action-id').textContent, '动态 第 27 项');
  assert.equal(f.app.state.status.point_id, 'P2');
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.equal(f.q('#action-pending-badge').hidden, true);
});

test('recording blocks row, queue/jumper and point changes without writing selection events', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27', 'P1');
  f.q('[data-action-id="S27"]').click();
  await f.app.startRecording();
  f.client.confirmRecording();
  const before = f.client.mockState.events.length;
  f.q('[data-select-confirm="S27"]').click();
  assert.equal(f.q('#btn-open-action-list').disabled, true);
  assert.equal(f.q('#shoot-group-queue-list [data-queue-action-id="S01"]').disabled, true);
  f.q('#shoot-group-queue-list [data-queue-action-id="S01"]').click();
  f.q('[data-point-id="P2"]').click();
  assert.equal(f.q('#confirmed-action-id').textContent, '动态 第 27 项');
  assert.equal(f.app.state.status.point_id, 'P1');
  assert.equal(f.client.mockState.events.length, before);
});

test('a second tap cancels pending START using the new take ID, not another START or an old take', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  const gate = holdReply(f.client, 'START');
  f.q('#btn-record-main').click();
  await gate.reached;
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  const selectionsBefore = f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length;
  f.q('[data-action-id="S27"]').click();
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length, selectionsBefore);
  assert.notEqual(f.q('#phase-badge').dataset.state, 'recording');
  f.q('#btn-record-main').click();
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'STOP').length, 0);
  gate.release();
  await until(() => f.client.mockState.commands.some(c => c.cmd === 'STOP') &&
    f.app.state.status.phase === 'idle' && !f.app.state.pendingStartCommandId, 'pending START cancellation');
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'START').length, 1);
  const stops = f.client.mockState.commands.filter(c => c.cmd === 'STOP');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].take_id, 2);
  assert.equal(f.q('#btn-record-main').dataset.mode, 'start');
});

test('a late START reply cannot resurrect a take already confirmed stopped by fresh status', async t => {
  const f = await fixture(t);
  await connect(f);
  const gate = holdReply(f.client, 'START');
  const start = f.app.startRecording();
  await gate.reached;
  f.client.emitStatus({ phase: 'idle', active_take_id: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: false, ready: true })) });
  gate.release();
  await start;
  assert.equal(f.q('#btn-record-main').dataset.mode, 'start');
  assert.notEqual(f.q('#phase-badge').dataset.state, 'recording');
  assert.equal(f.app.state.status.active_take_id, 0);
});

test('START and STOP acknowledgments do not invent camera confirmation, and stale/disconnected states are honest', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.startRecording();
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  assert.notEqual(f.q('#phase-badge').dataset.state, 'recording');
  assert.notEqual(f.q('#cam-a-badge').dataset.state, 'recording');
  f.client.confirmRecording();
  assert.equal(f.q('#phase-badge').dataset.state, 'recording');
  assert.equal(f.q('#cam-a-badge').dataset.state, 'recording');
  const request = f.client.request.bind(f.client);
  f.client.request = cmd => cmd.cmd === 'STOP'
    ? Promise.resolve({ ok: true, take_id: 1, event_seq: 1 }) : request(cmd);
  await f.app.stopRecording();
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  assert.notEqual(f.q('#cam-a-badge').dataset.state, 'ready');
  f.advance(4000);
  assert.equal(f.q('#cam-a-badge').dataset.state, 'stale');
  assert.notEqual(f.q('#phase-badge').dataset.state, 'recording');
  assert.notEqual(f.q('#phase-badge').dataset.state, 'ready');
  f.client.emitStatus({ phase: 'idle', active_take_id: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: false, ready: true })) });
  assert.equal(f.q('#btn-record-main').dataset.mode, 'start');
  assert.equal(f.q('#cam-a-badge').dataset.state, 'ready');
  f.app.disconnect();
  assert.equal(f.q('#cam-a-badge').dataset.state, 'disconnected');
  assert.notEqual(f.q('#phase-badge').dataset.state, 'ready');
});

test('reconnect resumes incrementally and switching projects keeps independent records and cursors', async t => {
  const storage = createMemoryStorage();
  const writes = [];
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, value) => { writes.push([key, value]); set(key, value); };
  const f = await fixture(t, { storage, events: completedTake() });
  await connect(f);
  for (let seq = 1; seq <= 2; seq++) {
    const saved = writes.findIndex(([key]) => key === ledgerEventKey('P', seq));
    const advanced = writes.findIndex(([key, value]) => key === ledgerCursorKey('P') && value === String(seq));
    assert.ok(saved >= 0 && advanced > saved, 'raw event must be saved before its cursor');
  }
  f.app.disconnect();
  f.client.mockState.events.push(event(3, 'MARK_DISCARD', { take_id: 1, discard: true }));
  await connect(f);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'GET_LOG').at(-1).after_seq, 2);
  assert.equal(f.q('[data-take-id="1"].take-item').classList.contains('is-discarded'), true);
  f.app.disconnect();
  Object.assign(f.client.mockState, { project_id: 'Q', events: completedTake('Q'), take_id: 1 });
  await connect(f);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'GET_LOG').at(-1).after_seq, 0);
  assert.equal(f.q('[data-take-id="1"].take-item').classList.contains('is-discarded'), false);
  assert.equal(count(f, 'S01'), 1);
  assert.equal(loadProjectLedger(storage, 'P').takes[0].discarded, true);
  assert.equal(storage.getItem(ledgerCursorKey('P')), '3');
  assert.equal(storage.getItem(ledgerCursorKey('Q')), '2');
  assert.equal(f.app.buildBackupPayload().project_id, 'Q');
});

test('an empty project clears the previous visible ledger and drafts without deleting its backup', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  f.q('[data-action="open-reassign"]').click();
  assert.equal(f.q('#modal-reassign').open, true);
  f.q('[data-reassign-option="D27"]').click();
  f.q('[data-reassign-point="P2"]').click();
  f.app.applyStatusSnapshot({
    project_id: '', event_seq: 0, take_id: 0, active_take_id: 0,
    action_id: '', point_id: '', phase: 'idle',
  });
  assert.equal(f.root.querySelector('.take-item'), null);
  assert.equal(f.q('#modal-reassign').open, false);
  assert.equal(f.app.state.editingReassignTakeId, null);
  assert.equal(f.q('#btn-record-main').disabled, true);
  assert.equal(f.app.state.reassignDrafts.size, 0);
  assert.equal(f.app.buildBackupPayload().project_id, '');
  assert.deepEqual(f.app.buildBackupPayload().events, []);
  assert.equal(loadProjectLedger(f.app.storage, 'P').takes[0].action_id, 'S01');
});

test('failed event persistence never advances past missing data and reconnect retries from the saved cursor', async t => {
  const storage = createMemoryStorage();
  const set = storage.setItem.bind(storage);
  let fail = true;
  storage.setItem = (key, value) => {
    if (fail && key === ledgerEventKey('P', 2)) throw new Error('quota exceeded');
    set(key, value);
  };
  const f = await fixture(t, { storage, events: completedTake() });
  // Connection succeeds but its log update reports the storage failure.
  f.q('#btn-connect').click();
  await until(() => f.client.mockState.commands.some(c => c.cmd === 'GET_LOG') &&
    !f.app.state.syncingLog && f.q('#status-banner').getAttribute('role') === 'alert');
  assert.equal(storage.getItem(ledgerCursorKey('P')), '1');
  assert.equal(storage.getItem(ledgerEventKey('P', 2)), null);
  f.app.disconnect();
  fail = false;
  await connect(f);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'GET_LOG').at(-1).after_seq, 1);
  assert.equal(storage.getItem(ledgerCursorKey('P')), '2');
  assert.equal(f.app.state.ledger.takes[0].complete, true);
});

test('discard, restore and reassignment fold the real ledger, counts and full JSON backup', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  assert.equal(count(f, 'S01'), 1);
  f.q('[data-action="toggle-discard"]').click();
  await until(() => f.app.state.ledger.takes[0]?.discarded === true && !f.q('[data-action="toggle-discard"]').disabled);
  assert.equal(count(f, 'S01'), 0);
  f.q('[data-status-filter="shot"]').click();
  assert.deepEqual(rows(f), []);
  f.q('[data-action="toggle-discard"]').click();
  await until(() => f.app.state.ledger.takes[0]?.discarded === false && !f.q('[data-action="toggle-discard"]').disabled);
  assert.deepEqual(rows(f), ['S01']);
  f.q('[data-action="open-reassign"]').click();
  f.q('[data-reassign-option="D27"]').click();
  f.q('[data-reassign-point="P2"]').click();
  f.q('#btn-reassign-confirm').click();
  await until(() => f.app.state.ledger.takes[0]?.action_id === 'D27');
  // D27 requires both P1 and P2, so 1 completed take on P2 leaves it in unshot/incomplete, not shot.
  assert.deepEqual(rows(f), []);
  f.q('[data-status-filter="unshot"]').click();
  assert.deepEqual(rows(f), ['S01', 'S27', 'D27', 'D28']);
  assert.equal(count(f, 'D27'), 1);
  assert.equal(f.q('[data-take-action]').dataset.takeAction, 'D27');
  f.q('#btn-backup-download').click();
  assert.equal(f.downloads.length, 1);
  assert.match(f.downloads[0].name, /\.json$/);
  const payload = JSON.parse(f.downloads[0].text);
  assert.deepEqual(Object.keys(payload).sort(), [
    'after_seq', 'events', 'exported_at', 'local_operator_acks', 'project_id', 'takes', 'template_id', 'template_snapshot',
  ]);
  assert.equal(payload.project_id, 'P');
  assert.equal(payload.template_id, 'T');
  assert.equal(payload.after_seq, 5);
  assert.equal(payload.exported_at, new Date(1800000000000).toISOString());
  assert.deepEqual(payload.events.map(e => e.type), ['TAKE_BEGIN', 'TAKE_END', 'MARK_DISCARD', 'MARK_DISCARD', 'REASSIGN']);
  assert.equal(payload.events[0].command_id, 'start-001');
  assert.equal(payload.events[0].time_anchor.utc_ms, 1800000000000);
  assert.equal(payload.events[1].cameras[1].battery, 79);
  const take = payload.takes[0];
  assert.equal(take.initial_action_id, 'S01');
  assert.equal(take.action_id, 'D27');
  assert.equal(take.point_id, 'P2');
  assert.equal(take.project_id, 'P');
  assert.equal(take.discarded, false);
  assert.equal(take.reassigned, true);
  assert.equal(take.complete, true);
  assert.equal(take.begin_mono_ms, 1000);
  assert.equal(take.end_mono_ms, 2000);
  assert.equal(take.cameras[0].stop_confirmed, true);
  await f.app.copyBackup();
  assert.deepEqual(JSON.parse(f.copies[0]), payload);
});

test('search focus and reassignment action/position drafts survive status and timer renders', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  const search = f.change('#input-action-search', '27', 'input');
  search.focus();
  search.setSelectionRange(1, 2);
  f.client.emitStatus();
  f.advance(1000);
  assert.equal(f.dom.window.document.activeElement, search);
  assert.equal(search.value, '27');
  assert.equal(search.selectionStart, 1);
  assert.equal(search.selectionEnd, 2);
  f.q('[data-action="open-reassign"]').click();
  assert.equal(f.q('#modal-reassign').open, true);
  const reassignSearch = f.q('#input-reassign-search');
  assert.equal(f.dom.window.document.activeElement, reassignSearch);
  f.change('#input-reassign-search', '27', 'input');
  f.q('[data-reassign-option="D27"]').click();
  f.q('[data-reassign-point="P2"]').click();
  f.client.emitStatus();
  f.advance(4000);
  f.app.render();
  assert.equal(f.dom.window.document.activeElement, reassignSearch);
  assert.equal(reassignSearch.value, '27');
  assert.equal(f.q('[data-reassign-option="D27"]').classList.contains('is-active'), true);
  assert.equal(f.q('[data-reassign-point="P2"]').classList.contains('is-active'), true);
  assert.equal(f.q('#modal-reassign').open, true);
  assert.equal(f.app.state.ledger.takes[0].action_id, 'S01', 'unsaved draft must not alter ledger');
  f.q('#btn-reassign-confirm').click();
  await until(() => f.app.state.ledger.takes[0].point_id === 'P2');
  assert.equal(f.app.state.ledger.takes[0].action_id, 'D27');
});

test('file-imported names, groups and positions remain literal text throughout rendering and reassignment', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  const attack = '<img src=x onerror="globalThis.compromised=true">';
  const imported = structuredClone(template);
  imported.template_name = attack;
  imported.actions[0].name = attack;
  imported.actions[0].group = attack;
  imported.actions[0].points = [{ point_id: 'P9', name: attack }];
  const fileInput = f.q('#input-template-file');
  Object.defineProperty(fileInput, 'files', { configurable: true,
    value: [{ text: async () => JSON.stringify(imported) }] });
  fileInput.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  await until(() => f.app.state.template.template_name === attack);
  assert.equal(f.q('.action-row-title').textContent, attack);
  assert.ok(f.q('#template-subtitle').textContent.includes(attack));
  assert.ok(f.q('#confirmed-action-name').textContent.includes(attack));
  assert.ok([...f.root.querySelectorAll('[data-group-filter]')].some(n => n.textContent === attack));
  f.q('[data-action="open-reassign"]').click();
  assert.ok(f.q('[data-reassign-option="S01"]').textContent.includes(attack));
  assert.ok(f.q('[data-reassign-point="P9"]').textContent.includes(attack));
  assert.equal(f.root.querySelector('img'), null);
  assert.equal(f.root.querySelector('[onerror]'), null);
  assert.equal(f.dom.window.compromised, undefined);
  assert.equal(JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY)).template_name, attack);
});

test('mock URL uses an isolated store and project identity instead of the browser real-project cache', async t => {
  const realTemplate = { ...template, template_name: '真实项目私有清单' };
  const f = await fixture(t, {
    url: 'https://field.example/phone/?mock=1', autoClient: true, defaultStorage: true,
    initBrowserStorage(storage) {
      storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(realTemplate));
      storage.setItem(ledgerCursorKey('REAL_PROJECT'), '1');
      storage.setItem(ledgerEventKey('REAL_PROJECT', 1), JSON.stringify(event(1, 'TAKE_BEGIN', { take_id: 1 }, 'REAL_PROJECT')));
    },
  });
  assert.equal(f.app.state.template.template_name, template.template_name);
  const before = { ...f.dom.window.localStorage };
  assert.notEqual(f.app.storage, f.dom.window.localStorage);
  assert.equal(f.app.storage.getItem(ledgerCursorKey('REAL_PROJECT')), null);
  assert.notEqual(f.client.mockState.project_id, 'REAL_PROJECT');
  assert.match(f.client.mockState.project_id, /^MOCK_/);
  // Avoid real mock-preview delays: use its already-defined deterministic state
  // and synchronous app snapshot entry point, not a timer-dependent connection.
  f.app.applyStatusSnapshot(f.client.emitStatus());
  f.app.importTemplateObject({ ...template, template_name: '演示清单' });
  f.app.storage.setItem(ledgerEventKey(f.client.mockState.project_id, 1),
    JSON.stringify(event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27' }, f.client.mockState.project_id)));
  f.app.storage.setItem(ledgerCursorKey(f.client.mockState.project_id), '1');
  const backup = f.app.buildBackupPayload();
  assert.equal(backup.project_id, 'MOCK_PREVIEW_01');
  assert.equal(backup.takes[0].action_id, 'D27');
  assert.deepEqual({ ...f.dom.window.localStorage }, before);
  assert.equal(f.q('#mock-notice').hidden, false);
});

test('explicitly injected storage remains usable in mock URL mode, including initial template and persisted events', async t => {
  const storage = createMemoryStorage();
  storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify({ ...template, template_name: '测试注入清单' }));
  const f = await fixture(t, { storage, url: 'https://field.example/phone/?mock=1', events: completedTake() });
  assert.equal(f.app.storage, storage);
  assert.ok(f.q('#template-subtitle').textContent.includes('测试注入清单'));
  await connect(f);
  assert.equal(storage.getItem(ledgerCursorKey('P')), '2');
  assert.equal(count(f, 'S01'), 1);
  assert.equal(f.app.buildBackupPayload().takes[0].command_id, 'start-001');
});

test('a failed STOP is visible, does not retry automatically, and allows a later explicit stop', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.startRecording();
  f.client.confirmRecording();
  const request = f.client.request.bind(f.client);
  let attempts = 0;
  f.client.request = command => {
    if (command.cmd === 'STOP' && ++attempts === 1) {
      throw Object.assign(new Error('transport write failed'), { code: 'write_failed' });
    }
    return request(command);
  };
  await f.app.stopRecording();
  assert.equal(attempts, 1);
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  assert.equal(f.q('#cam-a-badge').dataset.state, 'recording');
  await f.app.stopRecording();
  assert.equal(attempts, 2);
  assert.equal(f.q('#btn-record-main').dataset.mode, 'start');
  await f.app.syncCurrentProject();
  assert.equal(f.app.state.ledger.takes[0].complete, true);
  assert.equal(f.app.state.ledger.events.filter(e => e.type === 'TAKE_END').length, 1);
});

test('three-view workbench navigates cleanly, exposes settings sheet globally, and preserves scroll, filters and drafts', async t => {
  const f = await fixture(t, { events: completedTake() });
  // Before connecting: shoot view is active (Stage S1), settings sheet is closed by default.
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#shoot-stage-connect').hidden, false);
  assert.equal(f.q('#view-list').hidden, true);
  assert.equal(f.q('#view-records').hidden, true);
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'false');
  assert.equal(f.q('#btn-toggle-settings').textContent.trim(), '设备');

  // Open settings sheet from topbar, close via sheet close button; Stage S2 holds init project draft.
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'true');
  const projInput = f.change('#input-init-project-id', 'DRAFT_PROJ', 'input');
  f.q('#btn-settings-close').click();
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'false');

  await connect(f);
  // Once connected, button text stays 设备 without auto-opening modal.
  assert.equal(f.q('#btn-toggle-settings').textContent.trim(), '设备');
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'false');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'true');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, false);

  // Switch to action list view via shoot-view jumper modal button, set search/filter & scrollTop.
  f.q('#btn-open-action-list').click();
  assert.equal(f.q('#modal-action-jumper').open, true);
  f.q('#btn-jumper-open-board').click();
  assert.equal(f.q('#modal-action-jumper').open, false);
  assert.equal(f.q('#view-list').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  assert.equal(f.q('#nav-btn-list').getAttribute('aria-pressed'), 'true');
  f.change('#input-action-search', '27', 'input');
  f.q('[data-group-filter="一区"]').click();
  f.q('#view-list').scrollTop = 140;

  // Return to shoot view, then switch to records view and record reassign draft.
  f.q('#nav-btn-shoot').click();
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-list').hidden, true);
  f.q('#view-shoot').scrollTop = 85;

  f.q('#nav-btn-records').click();
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  assert.equal(f.q('#nav-btn-records').getAttribute('aria-pressed'), 'true');
  f.q('[data-action="open-reassign"]').click();
  assert.equal(f.q('#modal-reassign').open, true);
  f.q('[data-reassign-option="D27"]').click();
  f.q('[data-reassign-point="P1"]').click();
  await f.app.closeDialog(f.q('#modal-reassign'), { immediate: true });
  f.q('#view-records').scrollTop = 210;

  // Navigate back to list and records: scroll positions, filters, search query and reassign drafts survive.
  f.q('#nav-btn-list').click();
  assert.equal(f.q('#view-list').hidden, false);
  assert.equal(f.q('#view-list').scrollTop, 140);
  assert.equal(f.q('#input-action-search').value, '27');
  assert.deepEqual(rows(f), ['D27']);

  f.q('#nav-btn-records').click();
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#view-records').scrollTop, 210);
  f.q('[data-action="open-reassign"]').click();
  assert.equal(f.q('#modal-reassign').open, true);
  assert.equal(f.q('[data-reassign-option="D27"]').classList.contains('is-active'), true);
  assert.equal(f.q('[data-reassign-point="P1"]').classList.contains('is-active'), true);
  await f.app.closeDialog(f.q('#modal-reassign'), { immediate: true });

  f.q('#nav-btn-shoot').click();
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-shoot').scrollTop, 85);
  assert.equal(f.scrolls.at(-1)?.top, 85);
  assert.equal(projInput.value, 'DRAFT_PROJ');

  // Responsive resize to >=960px and height >=560px exposes all 3 panels semantically and hides bottom nav,
  // while narrow or short viewports (768x900 or 844x390 landscape) remain single-view mobile without losing drafts.
  f.q('#nav-btn-records').click();
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  f.resize(768, 900);
  assert.equal(f.app.state.desktopMode, false);
  assert.equal(f.q('#bottom-view-nav').hidden, false);
  f.resize(844, 390);
  assert.equal(f.app.state.desktopMode, false);
  f.resize(1200, 900);
  assert.equal(f.app.state.desktopMode, true);
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-list').hidden, false);
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#bottom-view-nav').hidden, true);
  f.resize(375, 667);
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  assert.equal(f.q('#view-list').hidden, true);
  assert.equal(f.q('#bottom-view-nav').hidden, false);
  assert.equal(f.q('#input-action-search').value, '27');
  assert.equal(projInput.value, 'DRAFT_PROJ');

  // Empty project shows Stage S2 wizard directly on shoot view without auto-opening settings modal.
  f.q('#nav-btn-shoot').click();
  f.app.applyStatusSnapshot({
    project_id: '', template_id: 'T', action_id: '', point_id: '',
    target_cameras: 3, active_participants: 0, event_seq: 0, take_id: 0, active_take_id: 0, phase: 'idle',
  });
  assert.equal(f.q('#shoot-stage-init').hidden, false);
  assert.equal(f.q('#modal-settings').open, false);
});

test('target camera selection waits for ACK with valid target_cameras, rolls back on rejection or malformed reply, and blocks during active take', async t => {
  const f = await fixture(t);
  await connect(f);
  assert.equal(f.app.state.status.target_cameras, 3);
  assert.equal(f.q('#btn-cam-toggle-a').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-cam-toggle-b').getAttribute('aria-pressed'), 'true');

  // Hold SELECT_ACTION reply after clicking B card to deselect B -> target_cameras 1 (A only)
  const gate = holdReply(f.client, 'SELECT_ACTION');
  f.q('#btn-cam-toggle-b').click();
  await gate.reached;
  assert.equal(f.app.state.status.target_cameras, 3);
  assert.equal(f.q('#btn-cam-toggle-b').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-cam-toggle-b').classList.contains('is-pending'), true);
  f.client.emitStatus();
  assert.equal(f.app.state.status.target_cameras, 3);
  gate.release();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.app.state.status.target_cameras, 1);
  assert.equal(f.q('#btn-cam-toggle-a').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-cam-toggle-b').getAttribute('aria-pressed'), 'false');
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').at(-1).target_cameras, 1);

  // Malformed SELECT_ACTION reply missing valid target_cameras is rejected and anti-zero swap (A -> B) rolls back.
  const originalReq = f.client.request.bind(f.client);
  f.client.request = cmd => cmd.cmd === 'SELECT_ACTION'
    ? Promise.resolve({ ok: true, project_id: 'P', action_id: 'S01', point_id: '' })
    : originalReq(cmd);
  f.q('#btn-cam-toggle-a').click();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.app.state.status.target_cameras, 1);
  assert.equal(f.q('#btn-cam-toggle-a').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-cam-toggle-b').getAttribute('aria-pressed'), 'false');
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.equal(f.q('#status-banner').dataset.errorCode, 'invalid_select_ack');
  f.client.request = originalReq;

  // When no action_id is selected, clicking camera target does not send SELECT_ACTION with empty action_id.
  f.client.emitStatus({ action_id: '', point_id: '' });
  const selectCountBefore = f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length;
  await f.app.selectTargetCameras(2);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length, selectCountBefore);
  assert.equal(f.q('#status-banner').dataset.errorCode, 'no_action_selected');

  // Restore action_id and verify active recording locks target camera toggle controls.
  await f.app.selectAction('S01', '', 2);
  assert.equal(f.app.state.status.target_cameras, 2);
  await f.app.startRecording();
  f.client.confirmRecording();
  assert.equal(f.q('#btn-cam-toggle-a').disabled, true);
  assert.equal(f.q('#btn-cam-toggle-b').disabled, true);
  assert.equal(f.q('#btn-cam-diag-a').disabled, false);
  const eventsBefore = f.client.mockState.events.length;
  await f.app.selectTargetCameras(1);
  assert.equal(f.app.state.status.target_cameras, 2);
  assert.equal(f.client.mockState.events.length, eventsBefore);
});

test('strict readiness blocks dual mode when one camera is unready, allows independent A-only or B-only takes, and blocks when an unselected camera is recording', async t => {
  const f = await fixture(t);
  await connect(f);

  // Camera B goes offline while in dual mode (target_cameras = 3): START is disabled and rejected.
  f.client.emitStatus({
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, ready: true, recording: false },
      { ...f.client.mockState.cameras[1], connected: false, fresh: false, ready: false, recording: false, led: 0 },
    ],
  });
  assert.equal(f.q('#btn-record-main').disabled, true);
  assert.match(f.q('#record-observation-text').textContent, /B 机未连接/);
  const rejectedDual = await f.app.startRecording();
  assert.equal(rejectedDual, null);
  assert.equal(f.client.mockState.take_id, 0);
  assert.equal(f.q('#status-banner').dataset.errorCode, 'start_rejected_or_storage_full');

  // Deselect Camera B (click B card -> target_cameras = 1): Camera A is ready so recording is enabled even with Camera B offline.
  f.q('#btn-cam-toggle-b').click();
  await until(() => f.app.state.status.target_cameras === 1 && !f.app.state.pendingSelect);
  assert.equal(f.q('#btn-record-main').disabled, false);
  assert.equal(f.q('#phase-badge').dataset.state, 'ready');
  assert.equal(f.q('#card-cam-b').classList.contains('is-unselected'), true);
  assert.match(f.q('#cam-b-badge-text').textContent, /本条不拍/);

  // Record and stop an A-only take (Take 1).
  f.q('#btn-record-main').click();
  await until(() => f.app.state.status.phase === 'starting');
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'START').at(-1).target_cameras, 1);
  assert.equal(f.app.state.status.active_participants, 1);
  f.client.confirmRecording();
  assert.equal(f.q('#cam-a-badge').dataset.state, 'recording');
  assert.notEqual(f.q('#cam-b-badge').dataset.state, 'recording');
  await f.app.stopRecording();
  await f.app.syncCurrentProject();

  const take1 = f.app.state.ledger.takes.find(tk => tk.take_id === 1);
  assert.equal(take1.participants, 1);
  assert.equal(take1.complete, true);
  assert.equal(take1.cameras[0].participating, true);
  assert.equal(take1.cameras[0].seen_recording, true);
  assert.equal(take1.cameras[1].participating, false);
  assert.equal(take1.cameras[1].seen_recording, false);
  const take1El = f.q('[data-take-id="1"].take-item');
  assert.equal(take1El.querySelector('[data-take-participants]').textContent, '只拍 A 机');
  assert.match(take1El.textContent, /相机A：已观察到录像，已停止/);
  assert.match(take1El.textContent, /相机B：本条未参与/);

  // Now Camera A sleeps and Camera B is ready: click active A card to anti-zero swap to B-only (target_cameras = 2) and record Take 2.
  f.advance(1500);
  f.client.emitStatus({
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, sleeping: true, ready: false, recording: false },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, sleeping: false, video: true, ready: true, recording: false, led: 1 },
    ],
  });
  assert.equal(f.q('#btn-record-main').disabled, true);
  f.q('#btn-cam-toggle-a').click();
  await until(() => f.app.state.status.target_cameras === 2 && !f.app.state.pendingSelect);
  assert.equal(f.q('#btn-record-main').disabled, false);
  await f.app.startRecording();
  f.client.confirmRecording();
  assert.equal(f.q('#cam-b-badge').dataset.state, 'recording');
  await f.app.stopRecording();
  await f.app.syncCurrentProject();

  const take2 = f.app.state.ledger.takes.find(tk => tk.take_id === 2);
  assert.equal(take2.participants, 2);
  const take2El = f.q('[data-take-id="2"].take-item');
  assert.equal(take2El.querySelector('[data-take-participants]').textContent, '只拍 B 机');
  assert.match(take2El.textContent, /相机A：本条未参与/);
  assert.match(take2El.textContent, /相机B：已观察到录像，已停止/);

  // If unselected Camera A is connected and reporting recording: true (even with fresh: false cached state), new START is blocked!
  f.client.emitStatus({
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: false, sleeping: false, ready: false, recording: true, led: 2 },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, sleeping: false, video: true, ready: true, recording: false, led: 1 },
    ],
  });
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  assert.equal(f.q('#btn-record-main').disabled, false);
  assert.match(f.q('#record-observation-text').textContent, /本条已结案，但仍检测到相机录像/);
  const blockedByUnselectedRec = await f.app.startRecording();
  assert.equal(blockedByUnselectedRec, null);
  assert.equal(f.client.mockState.take_id, 2);
});

test('missing or invalid target_cameras/active_participants in live STATUS disables selection and new START while keeping STOP enabled for active takes', async t => {
  const f = await fixture(t);
  await connect(f);

  // Simulate older/incompatible firmware STATUS missing target_cameras while idle.
  f.client.emitStatus({ target_cameras: undefined, active_participants: undefined });
  assert.equal(f.app.state.status.selectionSupported, false);
  assert.equal(f.q('#btn-cam-toggle-a').disabled, true);
  assert.equal(f.q('#btn-cam-toggle-b').disabled, true);
  assert.equal(f.q('#btn-cam-toggle-a').getAttribute('aria-pressed'), 'false');
  assert.equal(f.q('#btn-record-main').dataset.mode, 'start');
  assert.equal(f.q('#btn-record-main').disabled, true);
  assert.match(f.q('#record-observation-text').textContent, /升级固件/);

  const cmdCountBefore = f.client.mockState.commands.length;
  await f.app.selectTargetCameras(1);
  await f.app.startRecording();
  assert.equal(f.client.mockState.commands.length, cmdCountBefore);
  assert.equal(f.q('#status-banner').dataset.errorCode, 'unsupported_firmware');

  // Restore valid fields, start a recording, then emit STATUS with invalid target_cameras during active recording: STOP must remain enabled!
  f.client.emitStatus({ target_cameras: 3, active_participants: 0 });
  assert.equal(f.app.state.status.selectionSupported, true);
  await f.app.startRecording();
  f.client.confirmRecording();
  f.client.emitStatus({ target_cameras: 0, active_participants: 99 });
  assert.equal(f.app.state.status.selectionSupported, false);
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  assert.equal(f.q('#btn-record-main').disabled, false);
  f.q('#btn-record-main').click();
  await until(() => f.client.mockState.phase === 'idle');
  assert.equal(f.app.state.status.phase, 'idle');
});

test('history distinguishes non-participating cameras from participating start failures, handles cancelled pending START, and preserves participants across discard and reassign', async t => {
  const failureEvents = [
    event(1, 'TAKE_BEGIN', {
      take_id: 1, action_id: 'S01', point_id: '',
      command_id: 'dual-fail-1', source: 'ble', participants: 3,
    }),
    event(2, 'TAKE_END', {
      take_id: 1, action_id: 'S01', point_id: '',
      begin_boot_id: 'boot-one', begin_mono_ms: 1000, complete: false,
      reason: 'start_timeout', observation_lost: false,
      cameras: [
        { participating: true, start_sent: true, seen_recording: true, stop_confirmed: true, record_time: 4, battery: 90 },
        { participating: true, start_sent: true, start_failed: true, seen_recording: false, stop_confirmed: false, record_time: 0, battery: 88 },
      ],
    }),
  ];
  const f = await fixture(t, { events: failureEvents });
  await connect(f);

  // Take 1 was dual (participants = 3) where Camera B failed to start: must NEVER say 本条未参与.
  const take1El = f.q('[data-take-id="1"].take-item');
  assert.match(take1El.textContent, /相机A：已观察到录像，已停止/);
  assert.match(take1El.textContent, /相机B：未确认开始录像，未确认停止/);
  assert.doesNotMatch(take1El.textContent, /相机B：本条未参与/);

  // Select A-only (target_cameras = 1), start Take 2, and stop immediately while still in 'starting' before confirmRecording().
  await f.app.selectTargetCameras(1);
  await f.app.startRecording();
  assert.equal(f.app.state.status.phase, 'starting');
  await f.app.stopRecording();
  await f.app.syncCurrentProject();

  const take2 = f.app.state.ledger.takes.find(tk => tk.take_id === 2);
  assert.equal(take2.participants, 1);
  assert.equal(take2.complete, false);
  assert.equal(take2.reason, 'cancelled');
  assert.equal(take2.cameras[0].participating, true);
  assert.equal(take2.cameras[0].seen_recording, false);
  assert.equal(take2.cameras[1].participating, false);
  assert.equal(take2.cameras[1].seen_recording, false);
  const take2El = f.q('[data-take-id="2"].take-item');
  assert.match(take2El.textContent, /相机A：未确认开始录像，已停止/);
  assert.match(take2El.textContent, /相机B：本条未参与/);

  // Discard, restore, and reassign Take 2: participants (1) is preserved in ledger, DOM, and backup.
  await f.app.markDiscard(2, true);
  assert.equal(f.app.state.ledger.takes.find(tk => tk.take_id === 2).participants, 1);
  await f.app.markDiscard(2, false);
  await f.app.reassignTake(2, 'D27', 'P2');
  const reassignedTake2 = f.app.state.ledger.takes.find(tk => tk.take_id === 2);
  assert.equal(reassignedTake2.action_id, 'D27');
  assert.equal(reassignedTake2.point_id, 'P2');
  assert.equal(reassignedTake2.participants, 1);
  assert.equal(f.q('[data-take-id="2"].take-item [data-take-participants]').textContent, '只拍 A 机');
  const backup = f.app.buildBackupPayload();
  assert.equal(backup.takes.find(tk => tk.take_id === 2).participants, 1);
});

test('a partial dual-camera recording never borrows observation evidence from the other camera', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.startRecording();
  f.client.emitStatus({
    phase: 'recording',
    cameras: f.client.mockState.cameras.map((cam, i) => ({ ...cam, recording: i === 0 })),
  });
  await f.app.stopRecording();
  await f.app.syncCurrentProject();
  const take = f.app.state.ledger.takes.find(tk => tk.take_id === 1);
  assert.equal(take.participants, 3);
  assert.equal(take.cameras[0].seen_recording, true);
  assert.equal(take.cameras[1].participating, true);
  assert.equal(take.cameras[1].seen_recording, false);
  assert.equal(take.complete, false);
  assert.equal(f.app.buildBackupPayload().takes[0].cameras[1].seen_recording, false);
});

test('project initialization cannot invent selection capability on a legacy controller', async t => {
  const client = createMockBleClient({ projectId: '', templateId: 'T', ackDelayMs: 0,
    targetCameras: 3, autoConfirmRecordingMs: 0 });
  client.mockState.target_cameras = undefined;
  client.mockState.active_participants = undefined;
  const request = client.request.bind(client);
  client.request = cmd => cmd.cmd === 'INIT_PROJECT'
    ? Promise.resolve({ ok: true, project_id: 'NEW', template_id: 'T', take_id: 0, event_seq: 0 })
    : request(cmd);
  const f = await fixture(t, { client });
  await connect(f);
  await f.app.initProject('NEW', 'T');
  assert.equal(f.app.state.status.project_id, 'NEW');
  assert.equal(f.app.state.status.selectionSupported, false);
  assert.equal(f.q('#btn-cam-toggle-a').getAttribute('aria-pressed'), 'false');
  assert.equal(f.q('#btn-cam-toggle-a').disabled, true);
  assert.equal(f.q('#btn-cam-toggle-b').disabled, true);
  const before = client.mockState.commands.length;
  await f.app.selectAction('D27');
  assert.equal(client.mockState.commands.length, before);
  client.emitStatus({ project_id: 'NEW', target_cameras: 3, active_participants: 0 });
  assert.equal(f.q('#btn-cam-toggle-a').disabled, false);
});

test('demo identity stays visible after connection and across all three views', async t => {
  const f = await fixture(t, { url: 'https://field.example/phone/?mock=1' });
  await connect(f);
  for (const view of ['shoot', 'list', 'records']) {
    f.q(`#nav-btn-${view}`).click();
    assert.equal(f.q('#mock-notice').closest('[hidden]'), null);
  }
});

test('idle recording evidence retains a safety STOP without rewriting the completed take', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  const before = JSON.stringify(f.app.state.ledger.takes);
  const seq = f.client.mockState.events.length;
  f.client.emitStatus({ phase: 'idle', active_take_id: 0, active_participants: 0,
    cameras: f.client.mockState.cameras.map((cam, i) => ({ ...cam, recording: i === 0, fresh: false })) });
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  assert.equal(f.q('#btn-record-main').disabled, false);
  f.q('#btn-record-main').click();
  await until(() => f.client.mockState.cameras[0].recording === false);
  await f.app.syncCurrentProject();
  assert.equal(f.client.mockState.events.length, seq);
  assert.equal(JSON.stringify(f.app.state.ledger.takes), before);
});

// === Test 25 ~ Test 34: Mobile UI Streamline & Data Integrity Tests ===

test('silent auto-sync concurrency isolation (no blocking UI/START and single-flight coalescing)', async t => {
  const f = await fixture(t);
  await connect(f);
  let syncCalls = 0;
  let concurrentSyncs = 0;
  let maxConcurrentSyncs = 0;
  const originalSyncLog = f.client.syncLog.bind(f.client);
  const defSync = deferred();
  f.client.syncLog = async (afterSeq, projectId, onEvent) => {
    syncCalls++;
    concurrentSyncs++;
    maxConcurrentSyncs = Math.max(maxConcurrentSyncs, concurrentSyncs);
    try {
      await defSync.promise;
      return await originalSyncLog(afterSeq, projectId, onEvent);
    } finally {
      concurrentSyncs--;
    }
  };

  // Trigger two concurrent silent syncs
  const p1 = f.app.syncCurrentProject('P', { silent: true });
  const p2 = f.app.syncCurrentProject('P', { silent: true });

  assert.equal(f.app.state.syncingLog, true);
  // Banner must NOT be overwritten with '正在更新拍摄记录…' because silent: true
  assert.notEqual(f.q('#status-banner').textContent, '正在更新拍摄记录…');
  // Record CTA is NOT disabled just because silent sync is running in background
  assert.equal(f.q('#btn-record-main').disabled, false);

  // Both concurrent calls return the single in-flight promise
  assert.equal(p1, p2);
  await until(() => syncCalls === 1);
  const started = await f.app.startRecording();
  assert.equal(started?.ok, true, 'START must settle while log transport is held');
  f.client.confirmRecording();
  const stopped = await f.app.stopRecording();
  assert.equal(stopped?.ok, true, 'STOP must settle while log transport is held');

  defSync.resolve();
  await Promise.all([p1, p2]);

  assert.equal(f.app.state.syncingLog, false);
  assert.equal(maxConcurrentSyncs, 1);
  assert.equal(syncCalls, 2, 'requests during the frozen stream require one trailing sync');
  assert.equal(f.app.state.ledger.takes.at(-1)?.ended, true);
});

test('point ID ASCII validation strictly rejects spaces, Chinese, symbols, empty, and excessive length', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27');

  f.q('#btn-trigger-add-point').click();
  const modal = f.q('#modal-add-point');
  assert.equal(modal.hasAttribute('open'), true);

  const errorEl = f.q('#msg-add-point-error');
  const d27 = f.app.state.template.actions.find(a => a.action_id === 'D27');
  const initialPointsCount = d27.points.length;

  const testCases = [
    { id: 'P 01', reason: 'space' },
    { id: '点位1', reason: 'Chinese' },
    { id: 'P@01', reason: 'symbol' },
    { id: '', reason: 'empty' },
    { id: '   ', reason: 'whitespace' },
    { id: 'P12345678901234567', reason: 'over 16 chars' },
  ];

  for (const tc of testCases) {
    f.q('#input-add-point-id').value = tc.id;
    f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
    assert.equal(modal.hasAttribute('open'), true, `Modal should remain open for invalid ID: ${tc.reason}`);
    assert.match(errorEl.textContent, /1-16 位/, `Error message should explain ASCII requirement for ${tc.reason}`);
    assert.equal(d27.points.length, initialPointsCount);
  }

  // Valid ASCII point ID
  f.q('#input-add-point-id').value = 'P03';
  f.q('#input-add-point-name').value = '新加采样口';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  await until(() => !modal.hasAttribute('open'));
  await until(() => f.app.state.status.point_id === 'P03');

  const savedAction = f.app.state.template.actions.find(a => a.action_id === 'D27');
  assert.equal(savedAction.points.length, initialPointsCount + 1);
  const added = savedAction.points.find(p => p.point_id === 'P03');
  assert.ok(added);
  assert.equal(added.name, '新加采样口');
  assert.equal(f.app.state.status.point_id, 'P03');
});

test('point ID deduplication against current template action is case-insensitive', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27');

  f.q('#btn-trigger-add-point').click();
  const modal = f.q('#modal-add-point');
  const errorEl = f.q('#msg-add-point-error');

  // Existing point in D27 is P1 and P2
  f.q('#input-add-point-id').value = 'P1';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  assert.equal(modal.hasAttribute('open'), true);
  assert.match(errorEl.textContent, /已存在/);

  // Case-insensitive duplicate 'p1'
  f.q('#input-add-point-id').value = 'p1';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  assert.equal(modal.hasAttribute('open'), true);
  assert.match(errorEl.textContent, /已存在/);

  // Non-duplicate 'P99'
  f.q('#input-add-point-id').value = 'P99';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  await until(() => !modal.hasAttribute('open'));
  const d27 = f.app.state.template.actions.find(a => a.action_id === 'D27');
  assert.ok(d27.points.some(p => p.point_id === 'P99'));
});

test('target camera alert bar reacts to target cameras, readiness and disconnection', async t => {
  const f = await fixture(t);
  await connect(f);
  const obsBar = f.q('#record-observation-text');

  // Initially dual mode (target_cameras: 3), both ready
  assert.equal(f.app.getRecordControlState().stage, 'ready');
  assert.match(obsBar.textContent, /已就绪/);

  // Dual mode: Cam A unready
  f.client.emitStatus({
    cameras: [
      { connected: true, ready: false, recording: false, fresh: true, video: true, battery: 80 },
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.match(obsBar.textContent, /A 机未就绪/);

  // Dual mode: Cam B disconnected
  f.client.emitStatus({
    cameras: [
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.match(obsBar.textContent, /B 机未连接/);

  // Switch to single A mode (target_cameras: 1)
  await f.app.selectTargetCameras(1);
  // Both connected & ready
  f.client.emitStatus({
    target_cameras: 1,
    cameras: [
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'ready');
  assert.match(obsBar.textContent, /已就绪/);

  // Single A mode: Cam A disconnected
  f.client.emitStatus({
    target_cameras: 1,
    cameras: [
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.match(obsBar.textContent, /A 机未连接/);

  // Single B mode: Cam B disconnected
  await f.app.selectTargetCameras(2);
  f.client.emitStatus({
    target_cameras: 2,
    cameras: [
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.match(obsBar.textContent, /B 机未连接/);
});

test('target camera alert hides on controller disconnect', async t => {
  const f = await fixture(t);
  await connect(f);
  const obsBar = f.q('#record-observation-text');

  // Trigger camera warning in Channel 1
  f.client.emitStatus({
    cameras: [
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.match(obsBar.textContent, /A 机未连接/);

  // Unexpected BLE drop keeps ready stage mounted with Z3 reconnect recovery, while manual disconnect returns to Stage S1 connect wizard
  f.client.disconnect();
  await until(() => !f.app.state.connected);
  assert.equal(f.q('#shoot-stage-ready').hidden, false);
  assert.equal(f.q('#shoot-z3-slot').hidden, false);
  assert.equal(f.q('#btn-dock-reconnect').hidden, false);
  assert.match(obsBar.textContent, /未连接遥控器，无法从手机发送停止命令/);

  await f.app.disconnect();
  assert.equal(f.q('#shoot-stage-connect').hidden, false);
  assert.equal(f.q('#shoot-stage-ready').hidden, true);
});

test('REASSIGN option preservation preserves orphan actions and points without resetting to defaults', async t => {
  const orphanTakeEvents = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'A_ORPHAN', point_id: 'P_ORPHAN',
      command_id: 'start-001', source: 'ble', participants: 3,
      time_anchor: { boot_id: 'boot-one', mono_ms: 900, utc_ms: 1800000000000 } }, 'P'),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'A_ORPHAN', point_id: 'P_ORPHAN',
      begin_boot_id: 'boot-one', begin_mono_ms: 1000, complete: true,
      reason: 'stopped', observation_lost: false,
      cameras: [
        { seen_recording: true, stop_confirmed: true, record_time: 5, battery: 80 },
        { seen_recording: true, stop_confirmed: true, record_time: 5, battery: 80 },
      ] }, 'P'),
  ];
  const f = await fixture(t, { events: orphanTakeEvents });
  await connect(f);

  // Navigate to records view
  f.q('#nav-btn-records').click();
  assert.equal(f.q('#view-records').hidden, false);

  f.q('[data-action="open-reassign"]').click();
  assert.equal(f.q('#modal-reassign').open, true);

  const orphanActionOpt = f.q('[data-reassign-option="A_ORPHAN"]');
  assert.equal(orphanActionOpt.classList.contains('is-active'), true);
  assert.match(orphanActionOpt.textContent, /现场保留动作·未命名/);

  const orphanPointOpt = f.q('[data-reassign-point="P_ORPHAN"]');
  assert.equal(orphanPointOpt.classList.contains('is-active'), true);
  assert.match(orphanPointOpt.textContent, /现场保留点位·未命名/);

  // Draft must not be cleared or corrupted
  const draft = f.app.state.reassignDrafts.get(JSON.stringify(['P', 1]));
  assert.equal(draft.action_id, 'A_ORPHAN');
  assert.equal(draft.point_id, 'P_ORPHAN');
});

test('reverse harvesting engine automatically imports unrecorded point_id from historical takes', async t => {
  const harvestEvents = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27', point_id: 'P_HARVEST',
      command_id: 'start-001', source: 'ble', participants: 3,
      time_anchor: { boot_id: 'boot-one', mono_ms: 900, utc_ms: 1800000000000 } }, 'P'),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'D27', point_id: 'P_HARVEST',
      begin_boot_id: 'boot-one', begin_mono_ms: 1000, complete: true,
      reason: 'stopped', observation_lost: false,
      cameras: [
        { seen_recording: true, stop_confirmed: true, record_time: 5, battery: 80 },
        { seen_recording: true, stop_confirmed: true, record_time: 5, battery: 80 },
      ] }, 'P'),
  ];
  const f = await fixture(t, { events: harvestEvents });
  await connect(f);

  const d27 = f.app.state.template.actions.find(a => a.action_id === 'D27');
  const harvestedPoint = d27.points.find(p => p.point_id === 'P_HARVEST');
  assert.ok(harvestedPoint, 'Point P_HARVEST should have been harvested into D27');
  assert.equal(harvestedPoint.orphan, true);

  // Select D27 and check point pills
  await f.app.selectAction('D27');
  const pillBtn = f.q('#point-pills [data-point-id="P_HARVEST"]');
  assert.ok(pillBtn, 'Pill button for P_HARVEST should exist in DOM');

  // Pill click selects the harvested point
  pillBtn.click();
  await until(() => f.app.state.status.point_id === 'P_HARVEST');
  assert.equal(f.app.state.status.point_id, 'P_HARVEST');
});

test('wakeLock acquires on connect, stays active across idle/recording cycles, recovers on visibilitychange, and releases on disconnect', async t => {
  const f = await fixture(t);
  let lockRequested = 0;
  let lockReleased = 0;
  let activeSentinel = null;

  f.dom.window.navigator.wakeLock = {
    request: async (type) => {
      assert.equal(type, 'screen');
      lockRequested++;
      const listeners = [];
      const sentinel = {
        released: false,
        release: async () => {
          if (!sentinel.released) {
            sentinel.released = true;
            lockReleased++;
            listeners.forEach(cb => cb());
          }
        },
        addEventListener: (event, cb) => {
          if (event === 'release') listeners.push(cb);
        },
      };
      activeSentinel = sentinel;
      return sentinel;
    },
  };

  await connect(f);
  assert.equal(lockRequested, 1, 'WakeLock should be requested upon connecting while visible');
  assert.equal(f.q('#btn-screen-awake').dataset.mode, 'system');
  await f.app.selectAction('S01');

  // Start recording -> sentinel remains held cleanly without duplicate release
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  assert.equal(lockRequested, 1);
  assert.equal(lockReleased, 0);

  // Simulate tab switching: browser releases lock when hidden
  Object.defineProperty(f.dom.window.document, 'visibilityState', {
    value: 'hidden',
    configurable: true,
  });
  await activeSentinel.release();
  assert.equal(lockReleased, 1);

  // Simulate returning to tab while recording -> recovers WakeLock
  Object.defineProperty(f.dom.window.document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  });
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  await until(() => lockRequested >= 2);
  assert.equal(lockRequested, 2, 'WakeLock should be re-acquired on tab becoming visible');

  // Stop recording -> stays awake in foreground rather than releasing on STOP/idle
  await f.app.stopRecording();
  f.client.emitStatus({
    phase: 'idle',
    active_take_id: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: false, ready: true })),
  });
  await until(() => f.app.state.status.phase === 'idle');
  assert.equal(lockReleased, 1, 'WakeLock stays acquired after returning to idle while connected');

  // Explicit disconnect releases WakeLock
  f.app.disconnect();
  await until(() => lockReleased === 2);
  assert.equal(f.q('#btn-screen-awake').dataset.mode, 'idle');
});

test('IME composition guard blocks Enter key and form submit during active composition', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27');

  f.q('#btn-trigger-add-point').click();
  const modal = f.q('#modal-add-point');
  const inputId = f.q('#input-add-point-id');
  const inputName = f.q('#input-add-point-name');
  const form = f.q('#form-add-point');

  inputId.value = 'P08';
  inputName.value = 'ce';

  // Start IME composition (e.g. typing pinyin)
  inputName.dispatchEvent(new f.dom.window.Event('compositionstart'));

  // Press Enter key while composing
  const enterEvent = new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  inputName.dispatchEvent(enterEvent);
  assert.equal(enterEvent.defaultPrevented, true, 'Enter key default should be prevented during composition');

  // Attempt form submission while composing
  form.dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  assert.equal(modal.hasAttribute('open'), true, 'Modal must not close during active IME composition');

  const d27 = f.app.state.template.actions.find(a => a.action_id === 'D27');
  assert.equal(d27.points.some(p => p.point_id === 'P08'), false, 'Point must not be created during composition');

  // End IME composition
  inputName.dispatchEvent(new f.dom.window.Event('compositionend'));
  inputName.value = '测';

  // Now submit form
  form.dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  await until(() => !modal.hasAttribute('open'));

  const savedAction = f.app.state.template.actions.find(a => a.action_id === 'D27');
  assert.equal(savedAction.points.some(p => p.point_id === 'P08'), true);
  assert.equal(savedAction.points.find(p => p.point_id === 'P08').name, '测');
});

test('RFC 4180 + UTF-8 BOM + CWE-1236 CSV export sanitizes formulas, whitespace, and handles edge cases', async t => {
  // Unit test escapeCsvCell
  assert.equal(escapeCsvCell('Simple'), '"Simple"');
  assert.equal(escapeCsvCell('Hello, World'), '"Hello, World"');
  assert.equal(escapeCsvCell('He said "quote"'), '"He said ""quote"""');
  assert.equal(escapeCsvCell(null), '""');
  assert.equal(escapeCsvCell(undefined), '""');

  // CWE-1236 Formula injection defenses
  assert.equal(escapeCsvCell('=1+1'), '"\'=1+1"');
  assert.equal(escapeCsvCell('+SUM(A1:A10)'), '"\'+SUM(A1:A10)"');
  assert.equal(escapeCsvCell('-100'), '"\'-100"');
  assert.equal(escapeCsvCell('@HYPERLINK("http://attacker.com")'), '"\'@HYPERLINK(""http://attacker.com"")"');
  assert.equal(escapeCsvCell('\tcmd'), '"\'\tcmd"');
  assert.equal(escapeCsvCell('|dir'), '"\'|dir"');

  // Multiline & whitespace leading injection
  assert.equal(escapeCsvCell('\r\n=1+1'), '"\'=1+1"');
  assert.equal(escapeCsvCell('   =2+2   '), '"\'=2+2"');

  // Export full ledger CSV
  const fakeLedger = {
    project_id: 'TEST_PROJ',
    takes: [
      {
        take_id: 1,
        template_id: 'T',
        action_id: 'S01',
        point_id: 'P01',
        participants: 3,
        complete: true,
        discarded: false,
        reason: 'normal',
        time_anchor: { utc_ms: 1800000000000 },
        boot_id: 'boot-one',
        end_boot_id: 'boot-one',
        begin_mono_ms: 1000,
        end_mono_ms: 6000,
        cameras: [
          { seen_recording: true, battery: 85 },
          { seen_recording: true, battery: 82 },
        ],
      },
      {
        take_id: 2,
        template_id: 'T',
        action_id: 'S01',
        point_id: '=MALICIOUS',
        participants: 1,
        complete: false,
        discarded: true,
        reason: 'aborted\r\nline2',
        time_anchor: { utc_ms: NaN }, // Invalid timestamp edge case
        cameras: [],
      },
    ],
  };

  const csv = exportLedgerCsv(fakeLedger, template);
  // UTF-8 BOM assertion
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'CSV must start with UTF-8 BOM 0xFEFF');
  assert.ok(csv.startsWith('\uFEFF"take_id","action_id"'));

  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 3); // Header + 2 rows
  const parseCsvLine = line => line.slice(1, -1).split('","').map(cell => cell.replace(/""/g, '"'));
  const headers = parseCsvLine(lines[0]);
  assert.equal(headers.length, 19);
  assert.deepEqual(headers.slice(0, 15), [
    'take_id', 'action_id', 'action_name', 'point_id', 'point_name',
    'participants', 'complete', 'discarded', 'reason', 'time_anchor_utc',
    'duration_s', 'cam_a_recording', 'cam_a_battery', 'cam_b_recording', 'cam_b_battery',
  ]);
  assert.deepEqual(headers.slice(15), ['cam_a_clip_seq', 'cam_b_clip_seq', 'segment_no', 'action_description']);

  const row1 = Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(lines[1])[i]]));
  assert.equal(row1.take_id, '1');
  assert.equal(row1.action_id, 'S01');
  assert.equal(row1.action_name, '静态检查');
  assert.equal(row1.point_id, 'P01');
  assert.equal(row1.point_name, 'P01 (现场点位)');
  assert.equal(row1.participants, '双机同拍');
  assert.equal(row1.complete, '是');
  assert.equal(row1.discarded, '有效');
  assert.equal(row1.reason, 'normal');
  assert.equal(row1.time_anchor_utc, '2027-01-15T08:00:00.000Z');
  assert.equal(row1.duration_s, '5.0');
  assert.equal(row1.cam_a_recording, '已录制');
  assert.equal(row1.cam_a_battery, '85');
  assert.equal(row1.cam_b_recording, '已录制');
  assert.equal(row1.cam_b_battery, '82');
  assert.equal(row1.cam_a_clip_seq, '');
  assert.equal(row1.cam_b_clip_seq, '');

  const row2 = Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(lines[2])[i]]));
  assert.equal(row2.take_id, '2');
  assert.equal(row2.point_id, "'=MALICIOUS");
  assert.equal(row2.participants, '只拍A机');
  assert.equal(row2.complete, '否');
  assert.equal(row2.discarded, '废片');
  assert.equal(row2.reason, 'aborted line2');
  assert.equal(row2.time_anchor_utc, '');
  assert.equal(row2.duration_s, '');
  assert.equal(row2.cam_a_recording, '未录制');
  assert.equal(row2.cam_a_battery, '');
  assert.equal(row2.cam_b_recording, '未录制');
  assert.equal(row2.cam_b_battery, '');
  assert.equal(row2.cam_a_clip_seq, '');
  assert.equal(row2.cam_b_clip_seq, '');

  // Test UI trigger via button
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  f.q('#nav-btn-records').click();

  const btnBackupCsv = f.q('#btn-backup-csv');
  assert.ok(btnBackupCsv);
  btnBackupCsv.click();

  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].name, 'P_ledger.csv');
  assert.equal(f.downloads[0].mime, 'text/csv;charset=utf-8');
  assert.equal(f.downloads[0].text.charCodeAt(0), 0xFEFF);
});

test('a synchronous cursor read failure releases sync ownership and a later call recovers', async t => {
  const storage = createMemoryStorage();
  const f = await fixture(t, { storage });
  await connect(f);
  const get = storage.getItem.bind(storage);
  let failing = true;
  storage.getItem = key => {
    if (failing && key === ledgerCursorKey('P')) throw new Error('read unavailable');
    return get(key);
  };
  assert.equal(await f.app.syncCurrentProject('P', { silent: true }), null);
  failing = false;
  await f.app.selectAction('D27');
  await f.app.syncCurrentProject();
  assert.ok(f.app.state.ledger.events.some(e => e.type === 'SELECT_ACTION' && e.action_id === 'D27'));
  assert.equal(f.app.state.syncingLog, false);
});

test('closing to idle fetches the final END after an earlier frozen snapshot', async t => {
  const f = await fixture(t, { events: [event(1, 'TAKE_BEGIN', {
    take_id: 1, action_id: 'S01', participants: 3,
  })] });
  await connect(f);
  f.app.applyStatusSnapshot({ phase: 'closing', active_take_id: 1 });
  await f.app.syncCurrentProject();
  assert.equal(f.app.state.ledger.takes.at(-1).ended, false);
  // Firmware retries the END append while closing; it becomes available only now.
  f.client.mockState.events.push(event(2, 'TAKE_END', {
    take_id: 1, begin_boot_id: 'boot-one', begin_mono_ms: 1000,
    action_id: 'S01', complete: true,
  }));
  f.app.applyStatusSnapshot({ phase: 'idle', active_take_id: 0, event_seq: 2 });
  await until(() => !f.app.state.syncingLog);
  assert.equal(f.app.state.ledger.takes.at(-1).ended, true);
});

test('normal fresh recording with firmware ready=false produces no dual-camera alarm', async t => {
  const f = await fixture(t);
  await connect(f);
  f.client.emitStatus({ phase: 'recording', active_participants: 3, cameras: [0, 1].map(() => ({
    connected: true, fresh: true, recording: true, ready: false, video: true, sleeping: false,
  })) });
  assert.equal(f.app.getRecordControlState().stage, 'recording');
  f.advance(4000);
  assert.equal(f.app.getRecordControlState().stage, 'recording_stale');
  assert.match(f.q('#record-observation-text').textContent, /尚未结案.*3\.5 秒未更新/);
  assert.equal(f.q('#cam-a-badge').dataset.state, 'stale');
});

test('pending wake lock is single flight and late locks are released after disconnect or destroy', async t => {
  for (const mode of ['disconnect', 'destroy']) {
    await t.test(mode, async t => {
    const f = await fixture(t);
    await connect(f);
    const pending = deferred();
    let requests = 0, releases = 0;
    f.dom.window.navigator.wakeLock = { request() { requests++; return pending.promise; } };
    f.app.applyStatusSnapshot({ phase: 'recording' });
    f.app.applyStatusSnapshot({ phase: 'recording' });
    assert.equal(requests, 1);
    if (mode === 'destroy') f.app.destroy();
    else f.app.disconnect();
    pending.resolve({ released: false, addEventListener() {}, async release() { releases++; } });
    await until(() => releases === 1);
    assert.equal(requests, 1);
    });
  }
});

test('template identity gates harvesting and legal historical IDs survive cache reload and local renaming', async t => {
  const pid = 'P.' + 'x'.repeat(29);
  const events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27', point_id: 'FOREIGN', template_id: 'OTHER' }),
    event(2, 'TAKE_BEGIN', { take_id: 2, action_id: 'D27', point_id: pid }),
  ];
  const f = await fixture(t, { events });
  await connect(f);
  let action = f.app.state.template.actions.find(a => a.action_id === 'D27');
  assert.equal(action.points.some(p => p.point_id === 'FOREIGN'), false);
  assert.equal(action.points.find(p => p.point_id === pid)?.orphan, true);
  f.app.importTemplateObject(JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY)));
  action = f.app.state.template.actions.find(a => a.action_id === 'D27');
  assert.equal(action.points.find(p => p.point_id === pid)?.orphan, true);
  await f.app.selectAction('D27', 'P1');
  const originalEvents = JSON.stringify(f.app.state.ledger.events);
  let selections = 0;
  const request = f.client.request.bind(f.client);
  f.client.request = req => { if (req.cmd === 'SELECT_ACTION') selections++; return request(req); };
  f.q('#btn-rename-point').click();
  assert.equal(f.q('#modal-shoot-details').open, true);
  f.q(`[data-rename-point-id="${pid}"]`).click();
  await until(() => f.q('#modal-add-point').open);
  assert.equal(f.q('#modal-shoot-details').open, false);
  f.q('#input-add-point-name').value = '历史点位中文名';
  const set = f.app.storage.setItem.bind(f.app.storage);
  f.app.storage.setItem = (key, value) => { if (key === TEMPLATE_CACHE_KEY) throw new Error('quota'); set(key, value); };
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  assert.equal(f.q('#modal-add-point').open, true);
  assert.equal(f.q('#input-add-point-name').value, '历史点位中文名');
  assert.equal(f.app.state.template.actions.find(a => a.action_id === 'D27').points.find(p => p.point_id === pid).orphan, true);
  f.app.storage.setItem = set;
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  await until(() => !f.q('#modal-add-point').open);
  assert.equal(f.app.state.template.actions.find(a => a.action_id === 'D27').points.find(p => p.point_id === pid).name, '历史点位中文名');
  assert.equal(selections, 0);
  assert.equal(f.app.state.status.point_id, 'P1');
  assert.equal(f.dom.window.document.activeElement, f.q('#btn-current-details'));
  assert.equal(JSON.stringify(f.app.state.ledger.events), originalEvents);
  f.app.importTemplateObject(JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY)));
  assert.equal(f.app.state.template.actions.find(a => a.action_id === 'D27').points.find(p => p.point_id === pid).name, '历史点位中文名');
});

test('failed point persistence retains dialog input and does not select or mutate the dictionary', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27');
  const before = JSON.stringify(f.app.state.template);
  const set = f.app.storage.setItem.bind(f.app.storage);
  f.app.storage.setItem = (key, value) => {
    if (key === TEMPLATE_CACHE_KEY) throw new Error('quota');
    set(key, value);
  };
  f.q('#btn-trigger-add-point').click();
  f.q('#input-add-point-id').value = 'NEW';
  f.q('#input-add-point-name').value = '需要保留';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  assert.equal(f.q('#modal-add-point').open, true);
  assert.equal(f.q('#input-add-point-name').value, '需要保留');
  assert.equal(JSON.stringify(f.app.state.template), before);
  assert.notEqual(f.app.state.status.point_id, 'NEW');
  assert.ok(f.q('#msg-add-point-error').textContent);
});

test('harvest persistence failure is explicit and never installs an unsaved dictionary', async t => {
  const storage = createMemoryStorage();
  const f = await fixture(t, { storage, events: [event(1, 'TAKE_BEGIN', {
    take_id: 1, action_id: 'D27', point_id: 'P_UNSAVED',
  })] });
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, value) => { if (key === TEMPLATE_CACHE_KEY) throw new Error('quota'); set(key, value); };
  f.q('#btn-connect').click();
  await until(() => f.app.state.status.time_synced && !f.app.state.syncingLog && f.q('#status-banner').dataset.tone === 'error');
  assert.equal(f.app.state.template.actions.find(a => a.action_id === 'D27').points.some(p => p.point_id === 'P_UNSAVED'), false);
  assert.equal(f.q('#status-banner').dataset.tone, 'error');
});

test('CSV durations require matching begin and end boot identities and nonnegative monotonic time', async t => {
  const f = await fixture(t, { events: [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', mono_ms: 90000 }),
    event(2, 'TAKE_END', { take_id: 1, begin_boot_id: 'boot-one', begin_mono_ms: 90000, boot_id: 'boot-two', mono_ms: 120000, reason: 'power_loss' }),
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S01', mono_ms: 90000 }),
    event(4, 'TAKE_END', { take_id: 2, mono_ms: 80000 }),
    event(5, 'TAKE_BEGIN', { take_id: 3, action_id: 'S01', mono_ms: 1000 }),
    event(6, 'TAKE_END', { take_id: 3, mono_ms: 6000 }),
  ] });
  await connect(f);
  const records = exportLedgerCsv(f.app.state.ledger, template).slice(1).split('\r\n').slice(1);
  assert.deepEqual(records.map(line => line.split(',')[10]), ['""', '""', '"5.0"']);
  assert.equal(f.app.state.ledger.takes[0].end_boot_id, 'boot-two');
});

test('field stopwatch anchors to same-boot TAKE_BEGIN and fresh hardware status, not camera record_time', async t => {
  const f = await fixture(t, { events: [event(1, 'TAKE_BEGIN', {
    take_id: 1, action_id: 'S01', mono_ms: 1000,
  })] });
  await connect(f);
  const cameras = [0, 1].map(() => ({ connected: true, fresh: true, recording: true, ready: false, record_time: 99999 }));
  f.app.applyStatusSnapshot({ ...f.app.state.status, phase: 'recording', active_take_id: 1, active_participants: 3,
    boot_id: 'boot-one', mono_ms: 65000, cameras });
  assert.match(f.q('#record-elapsed').textContent, /01:04/);
  f.advance(60000);
  assert.match(f.q('#record-elapsed').textContent, /02:04/);
  assert.equal(f.q('#record-elapsed').dataset.state, 'stale');
  f.app.applyStatusSnapshot({ ...f.app.state.status, mono_ms: 72000 });
  assert.match(f.q('#record-elapsed').textContent, /01:11/);
  f.app.applyStatusSnapshot({ ...f.app.state.status, boot_id: 'boot-two', mono_ms: 73000 });
  assert.match(f.q('#record-elapsed').textContent, /待确认/);
});

test('late log completion cannot replace a new project or disconnected status', async t => {
  for (const changeProject of [false, true]) {
    await t.test(changeProject ? 'new project' : 'disconnected', async t => {
    const f = await fixture(t);
    await connect(f);
    const gate = deferred();
    const reached = deferred();
    const original = f.client.syncLog.bind(f.client);
    f.client.syncLog = async (after, project, persist) => {
      if (project !== 'P') return original(after, project, persist);
      reached.resolve();
      await gate.promise;
      return { snapshot: { event_seq: 900, take_id: 900 } };
    };
    const syncing = f.app.syncCurrentProject('P', { silent: true });
    await reached.promise;
    if (changeProject) {
      f.client.emitStatus({ project_id: 'Q', event_seq: 0, take_id: 0, events: [] });
      void f.app.syncCurrentProject('Q', { silent: true });
    } else f.app.disconnect();
    gate.resolve();
    await syncing;
    assert.equal(f.app.state.status.take_id, 0);
    assert.equal(f.app.state.status.event_seq, 0);
    assert.equal(f.app.state.ledger.project_id, changeProject ? 'Q' : 'P');
    });
  }
});

test('old wake lock release completion cannot erase a newly acquired sentinel', async t => {
  const f = await fixture(t);
  await connect(f);
  const release = deferred();
  let requests = 0;
  f.dom.window.navigator.wakeLock = { request: async () => {
    requests++;
    return { released: false, addEventListener() {}, release: () => requests === 1 ? release.promise : Promise.resolve() };
  } };
  await f.app.acquireWakeLock();
  const releasing = f.app.releaseWakeLock();
  await f.app.acquireWakeLock();
  release.resolve();
  await releasing;
  await f.app.acquireWakeLock();
  assert.equal(requests, 2);
});

test('fallback media play happens in the START gesture and rejected play remains an explicit manual-screen notice', async t => {
  const playback = deferred();
  let video = null;
  let plays = 0;
  const f = await fixture(t, { configureWindow(win) {
    Object.defineProperty(win.navigator, 'userAgent', { value: 'Bluefy', configurable: true });
    win.HTMLMediaElement.prototype.play = function () { plays++; video = this; return playback.promise; };
    win.HTMLMediaElement.prototype.pause = function () {};
  } });
  await connect(f);
  const ack = holdReply(f.client, 'START');
  const starting = f.app.startRecording();
  assert.equal(plays, 1, 'play must be invoked before awaiting START ACK');
  const media = Buffer.from(video.src.split(',')[1], 'base64');
  assert.ok(media.includes(Buffer.from('trak')), 'embedded media must contain a real track');
  assert.ok(media.includes(Buffer.from('avc1')), 'embedded media must contain the H.264 video sample entry');
  playback.reject(new Error('NotAllowedError'));
  await until(() => /手动/.test(f.q('#screen-awake-notice').textContent));
  ack.release();
  await starting;
  assert.match(f.q('#screen-awake-notice').textContent, /手动/);
});

test('a saved point survives a rejected device selection and overlong names are not truncated', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27');
  f.q('#btn-trigger-add-point').click();
  f.q('#input-add-point-id').value = 'P_NEW';
  f.q('#input-add-point-name').value = '界'.repeat(63) + '😀';
  const submit = () => f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  submit();
  assert.equal(f.q('#modal-add-point').open, true);
  assert.equal(f.app.state.template.actions.find(a => a.action_id === 'D27').points.some(p => p.point_id === 'P_NEW'), false);
  const original = f.client.request.bind(f.client);
  f.client.request = req => req.cmd === 'SELECT_ACTION' ? Promise.reject(new Error('device unavailable')) : original(req);
  const name = '界'.repeat(62) + '😀';
  f.q('#input-add-point-name').value = name;
  submit();
  await until(() => /未选中/.test(f.q('#status-banner-text').textContent));
  assert.equal(JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY)).actions.find(a => a.action_id === 'D27').points.find(p => p.point_id === 'P_NEW').name, name);
  assert.notEqual(f.app.state.status.point_id, 'P_NEW');
});

test('native sheet tracks visible viewport, restores focus and limits swipe dismissal to its handle', async t => {
  const viewportListeners = new Map();
  const viewport = { height: 320, offsetTop: 45,
    addEventListener(name, fn) { viewportListeners.set(name, fn); },
    removeEventListener(name, fn) { if (viewportListeners.get(name) === fn) viewportListeners.delete(name); },
  };
  const f = await fixture(t, { configureWindow(win) {
    Object.defineProperty(win, 'visualViewport', { value: viewport });
    win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
  } });
  await connect(f);
  await f.app.selectAction('D27');
  assert.equal(f.root.querySelectorAll('#btn-record-main').length, 1);
  const trigger = f.q('#btn-trigger-add-point');
  trigger.focus();
  trigger.click();
  const sheet = f.q('#modal-add-point');
  assert.equal(sheet.open, true);
  assert.equal(sheet.style.getPropertyValue('--sheet-viewport-height'), '320px');
  assert.equal(sheet.style.getPropertyValue('--sheet-viewport-top'), '45px');
  viewport.offsetTop = 70;
  viewportListeners.get('scroll')();
  assert.equal(sheet.style.getPropertyValue('--sheet-viewport-top'), '70px');
  viewport.height = 180;
  viewportListeners.get('resize')();
  assert.equal(sheet.style.getPropertyValue('--sheet-viewport-height'), '180px');
  const pointer = (node, type, y) => {
    const event = new f.dom.window.Event(type, { bubbles: true });
    Object.assign(event, { pointerId: 1, clientX: 10, clientY: y, button: 0 });
    node.dispatchEvent(event);
  };
  pointer(f.q('#form-add-point'), 'pointerdown', 0);
  pointer(f.q('#form-add-point'), 'pointermove', 100);
  pointer(f.q('#form-add-point'), 'pointerup', 100);
  assert.equal(sheet.open, true);
  const handle = sheet.querySelector('.sheet-handle');
  pointer(handle, 'pointerdown', 0);
  pointer(handle, 'pointermove', 100);
  pointer(handle, 'pointerup', 100);
  assert.equal(sheet.open, false);
  assert.equal(f.dom.window.document.activeElement, trigger);
  f.app.destroy();
  assert.equal(viewportListeners.size, 0);
});

test('a corrupt target-project cache hides the previous ledger and blocks all backup and stale edit paths until repaired', async t => {
  const shares = [];
  const f = await fixture(t, { events: completedTake(), share: async payload => { shares.push(payload); } });
  await connect(f);
  const oldDiscard = f.q('[data-action="toggle-discard"]');
  const oldReassign = f.q('[data-action="open-reassign"]');
  const pEvents = JSON.stringify(f.app.state.ledger.events);
  f.app.storage.setItem(ledgerCursorKey('Q'), '1');
  f.app.storage.setItem(ledgerEventKey('Q', 1), '{broken');
  const qEvents = completedTake('Q').map(e => ({ ...e, action_id: 'D27' }));
  f.client.emitStatus({ project_id: 'Q', events: qEvents, take_id: 1 });
  assert.equal(f.app.state.ledger.project_id, 'Q');
  assert.equal(f.app.state.ledgerReadError?.project_id, 'Q');
  assert.equal(f.app.state.ledger.takes.length, 0);
  assert.equal(f.root.querySelector('.take-item'), null);
  assert.equal(f.app.state.ledger.progress.size, 0);
  assert.ok(f.q('#ledger-storage-notice').textContent);
  const before = f.client.mockState.commands.length;
  oldDiscard.click();
  oldReassign.click();
  await f.app.markDiscard(1, true);
  await f.app.reassignTake(1, 'S01');
  assert.equal(f.client.mockState.commands.length, before);
  assert.equal(f.app.state.editingReassignTakeId, null);
  assert.equal(f.app.buildBackupPayload(), null);
  for (const id of ['btn-backup-copy', 'btn-backup-share', 'btn-backup-download', 'btn-backup-csv']) {
    f.q(`#${id}`).click();
    await Promise.resolve();
    assert.notEqual(f.q('#status-banner').dataset.tone, 'ok');
  }
  assert.equal(await f.app.copyBackup(), null);
  assert.equal(await f.app.shareBackup(), null);
  assert.equal(f.app.downloadBackup(), null);
  assert.equal(f.app.downloadCsv(), null);
  assert.equal(f.app.state.lastBackupPayload, null);
  assert.equal(f.copies.length, 0);
  assert.equal(shares.length, 0);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.app.storage.getItem(ledgerEventKey('Q', 1)), '{broken');
  assert.equal(JSON.stringify(loadProjectLedger(f.app.storage, 'P').events), pEvents);
  // The storage owner repairs the bad bytes; the app must not reset or skip them itself.
  f.app.storage.setItem(ledgerEventKey('Q', 1), JSON.stringify(qEvents[0]));
  assert.ok(await f.app.syncCurrentProject('Q'));
  assert.equal(f.app.state.ledgerReadError, null);
  assert.equal(f.app.state.ledger.takes[0].action_id, 'D27');
  assert.equal(f.app.state.ledger.events.every(e => e.project_id === 'Q'), true);
  const commandsAfterRecovery = f.client.mockState.commands.length;
  oldDiscard.click();
  oldReassign.click();
  assert.equal(f.client.mockState.commands.length, commandsAfterRecovery);
  assert.equal(f.app.state.editingReassignTakeId, null);
  f.q('#btn-backup-download').click();
  f.q('#btn-backup-csv').click();
  assert.equal(JSON.parse(f.downloads[0].text).project_id, 'Q');
  assert.equal(JSON.parse(f.downloads[0].text).events.every(e => e.project_id === 'Q'), true);
  assert.match(f.downloads[1].text, /D27/);
  assert.doesNotMatch(f.downloads[1].text, /静态检查/);
});

test('device discard and reassign stay visibly unsynced after event writes fail, including silent sync and local-copy exports', async t => {
  const shares = [];
  const f = await fixture(t, { events: completedTake(), share: async payload => { shares.push(payload); } });
  await connect(f);
  const set = f.app.storage.setItem.bind(f.app.storage);
  let rejectEventWrites = true;
  f.app.storage.setItem = (key, value) => {
    if (rejectEventWrites && key.startsWith(ledgerEventKey('P', 1).replace(/1$/, ''))) {
      const error = new Error('event storage quota');
      error.name = 'QuotaExceededError';
      throw error;
    }
    set(key, value);
  };
  const discard = await f.app.markDiscard(1, true);
  assert.equal(discard?.ok, true, 'device commit is distinct from local sync');
  assert.equal(f.client.mockState.events.at(-1).discard, true);
  assert.equal(f.app.state.ledger.after_seq, 2);
  assert.equal(f.app.state.ledger.takes[0].discarded, false);
  assert.equal(f.app.state.ledgerSyncError?.project_id, 'P');
  assert.notEqual(f.q('#status-banner').dataset.tone, 'ok');
  assert.ok(f.q('#ledger-storage-notice').textContent);
  // While local copy is unsynced, repeat discard/reassign is blocked until synced
  assert.equal(await f.app.markDiscard(1, false), null);
  assert.equal(await f.app.reassignTake(1, 'D27', 'P2'), null);
  assert.equal(await f.app.syncCurrentProject('P', { silent: true }), null);
  assert.equal(f.q('#status-banner').dataset.tone, 'error', 'silent suppresses progress only');
  for (const id of ['btn-backup-copy', 'btn-backup-share', 'btn-backup-download', 'btn-backup-csv']) {
    f.q(`#${id}`).click();
    await until(() => f.q('#status-banner').dataset.tone === 'warn');
    assert.match(f.q('#status-banner-text').textContent, /本地副本|未更新|不完整/);
    assert.ok(f.q('#ledger-storage-notice').textContent);
  }
  assert.equal(JSON.parse(f.copies[0]).after_seq, 2);
  assert.equal(JSON.parse(shares[0].text).after_seq, 2);
  for (const file of f.downloads.filter(file => file.name.endsWith('.json'))) {
    const payload = JSON.parse(file.text);
    assert.equal(payload.project_id, 'P');
    assert.equal(payload.after_seq, 2);
    assert.equal(payload.takes[0].discarded, false);
  }
  const csv = f.downloads.find(file => file.name.endsWith('.csv'));
  assert.ok(csv);
  assert.match(csv.text, /S01/);
  assert.doesNotMatch(csv.text, /D27/);
  rejectEventWrites = false;
  assert.ok(await f.app.syncCurrentProject('P', { silent: true }));
  assert.equal(f.app.state.ledger.after_seq, 3);
  assert.equal(f.app.state.ledger.takes[0].discarded, true);

  // Now fail storage on reassignTake too and verify local-copy stays S01 until recovery
  rejectEventWrites = true;
  const reassigned = await f.app.reassignTake(1, 'D27', 'P2');
  assert.equal(reassigned?.ok, true);
  assert.equal(f.client.mockState.events.at(-1).type, 'REASSIGN');
  assert.equal(f.app.state.ledger.takes[0].action_id, 'S01');
  assert.notEqual(f.q('#status-banner').dataset.tone, 'ok');
  f.q('#btn-backup-csv').click();
  await until(() => f.q('#status-banner').dataset.tone === 'warn');
  const staleCsv = f.downloads.filter(file => file.name.endsWith('.csv')).at(-1);
  assert.doesNotMatch(staleCsv.text, /D27/);
  rejectEventWrites = false;
  assert.ok(await f.app.syncCurrentProject('P', { silent: true }));
  assert.equal(f.app.state.ledgerSyncError, null);
  assert.equal(f.app.state.ledgerReadError, null);
  assert.equal(f.app.state.ledger.after_seq, 4);
  assert.equal(f.app.state.ledger.takes[0].discarded, true);
  assert.equal(f.app.state.ledger.takes[0].action_id, 'D27');
  assert.equal(f.q('#ledger-storage-notice').hidden, true);
  f.q('#btn-backup-download').click();
  assert.equal(f.q('#status-banner').dataset.tone, 'ok');
  assert.equal(JSON.parse(f.downloads.at(-1).text).after_seq, 4);
});

// These controls model native dialog/animation boundaries only. All identities,
// rendering, dictionary writes, focus choices and command decisions remain real.
function sheetBoundary({ reducedMotion = false, animated = true } = {}) {
  const exits = [];
  return {
    exits,
    configureWindow(win) {
      const match = win.matchMedia;
      win.matchMedia = query => query === '(prefers-reduced-motion: reduce)'
        ? { matches: reducedMotion } : match(query);
      win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      win.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new win.Event('close'));
      };
      if (animated) win.Element.prototype.animate = function () {
        const completion = deferred();
        const exit = { node: this, finish: completion.resolve, cancelled: false };
        exits.push(exit);
        return { finished: completion.promise, cancel() { exit.cancelled = true; completion.reject(new Error('cancelled')); } };
      };
    },
  };
}

test('recent identity uses ledger point and comparable END duration, and opens the existing project-aware editor', async t => {
  const events = completedTake().map((e, i) => ({ ...e, action_id: 'D27', point_id: 'P1', mono_ms: i ? 6500 : 1000 }));
  const f = await fixture(t, { events });
  await connect(f);
  await f.app.selectAction('D27', 'P1');
  const row1 = f.q('#shoot-action-takes-list [data-take-id="1"]');
  assert.match(row1.textContent, /#1.*归档第 1 条.*✓ 有效/);
  assert.match(row1.textContent, /双机.*传递口.*00:05/);
  const before = f.client.mockState.commands.length;
  row1.querySelector('.shoot-take-main-btn').click();
  const reassignBtn = row1.querySelector('[data-action="shoot-open-reassign"]');
  reassignBtn.click();
  // Homepage reassign opens searchable #modal-reassign without switching away from shoot view
  assert.equal(f.q('#view-records').hidden, true);
  assert.equal(f.q('#modal-reassign').open, true);
  assert.equal(f.app.state.reassignSurface, 'shoot');
  assert.equal(f.q('[data-reassign-option="D27"]').classList.contains('is-active'), true);
  assert.equal(f.q('[data-reassign-point="P1"]').classList.contains('is-active'), true);
  assert.equal(f.dom.window.document.activeElement, f.q('#input-reassign-search'));
  assert.equal(f.client.mockState.commands.length, before);
  f.q('[data-reassign-option="S01"]').click();
  f.q('#btn-reassign-confirm').click();
  await until(() => f.app.state.ledger.takes[0].action_id === 'S01');
  assert.equal(f.q('#modal-reassign').open, false);
  const command = f.client.mockState.commands.filter(c => c.cmd === 'REASSIGN').at(-1);
  assert.equal(command.project_id, 'P');
  assert.equal(command.action_id, 'S01');
});

test('recent timing never invents cross-boot, missing END or negative durations and preserves zero', async t => {
  for (const scenario of ['zero', 'crossboot', 'unfinished', 'negative', 'abnormal', 'discard']) {
    await t.test(scenario, async t => {
      let events = completedTake().map(e => ({ ...e, action_id: 'D27', point_id: 'P1' }));
      if (scenario === 'zero') events[1].mono_ms = 1000;
      if (scenario === 'crossboot') events[1].boot_id = 'other-boot';
      if (scenario === 'unfinished') events = events.slice(0, 1);
      if (scenario === 'negative') events[1].mono_ms = 500;
      if (scenario === 'abnormal') events[1].complete = false;
      if (scenario === 'discard') events.push(event(3, 'MARK_DISCARD', { take_id: 1, discard: true }));
      const f = await fixture(t, { events });
      await connect(f);
      await f.app.selectAction('D27', 'P1');
      const row1 = f.q('#shoot-action-takes-list [data-take-id="1"]');
      const rowText = row1.textContent;
      if (scenario === 'zero') {
        assert.match(rowText, /00:00/);
        const csv = exportLedgerCsv(f.app.state.ledger, f.app.state.template);
        const columns = csv.split('\r\n');
        const durationCell = columns[1].split(',')[10].replace(/^"|"$/g, '');
        assert.notEqual(durationCell, '');
        assert.equal(Number(durationCell), 0);
      } else if (['crossboot', 'negative'].includes(scenario)) {
        assert.match(rowText, /计时待确认/);
        assert.doesNotMatch(rowText, /\d+:\d+/);
      } else if (scenario === 'unfinished') {
        assert.doesNotMatch(rowText, /\d+:\d+/);
        assert.match(rowText, /未结束/);
        const reassignBtn = row1.querySelector('[data-action="shoot-open-reassign"]');
        assert.equal(reassignBtn.disabled, true);
        const before = f.client.mockState.commands.length;
        reassignBtn.click();
        f.q('[data-action="open-reassign"]').click();
        assert.equal(f.app.state.editingReassignTakeId, null);
        assert.equal(f.client.mockState.commands.length, before);
      } else assert.match(rowText, scenario === 'discard' ? /废片/ : /异常/);
      assert.match(rowText, /双机/);
    });
  }
});

test('recent edit refuses stale project and unreadable ledger identities without commands', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  const staleBtn = f.q('#shoot-action-takes-list [data-take-id="1"] [data-action="shoot-open-reassign"]');
  f.app.storage.setItem(ledgerCursorKey('Q'), '1');
  f.app.storage.setItem(ledgerEventKey('Q', 1), '{broken');
  f.client.emitStatus({ project_id: 'Q', events: [], take_id: 0 });
  const before = f.client.mockState.commands.length;
  // Project P button is now detached because key includes projectId ('P:1') and project Q failed storage read
  assert.equal(staleBtn.isConnected, false);
  staleBtn.dispatchEvent(new f.dom.window.Event('click'));
  assert.equal(await f.app.openTakeReassign(1, 'P', { surface: 'shoot', returnFocus: null }), false);
  assert.equal(f.app.state.editingReassignTakeId, null);
  assert.equal(f.q('#view-records').hidden, true);
  assert.equal(f.client.mockState.commands.length, before);
});

test('healthy single-camera choice stays quiet while selected disconnect and stale observations remain visible', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectTargetCameras(1);
  assert.equal(f.app.getRecordControlState().stage, 'ready');
  assert.match(f.q('#record-observation-text').textContent, /已就绪/);
  f.client.emitStatus({ cameras: f.client.mockState.cameras.map((cam, index) => index ? cam : { ...cam, connected: false }) });
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.match(f.q('#record-observation-text').textContent, /A 机未连接/);
  f.client.emitStatus({ cameras: f.client.mockState.cameras.map((cam, index) => index ? cam : { ...cam, connected: true, fresh: false }) });
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.match(f.q('#record-observation-text').textContent, /状态待确认/);
});

test('sheet cancel keeps its native modal open until completion and restores focus once', async t => {
  const boundary = sheetBoundary();
  const f = await fixture(t, boundary);
  await connect(f);
  await f.app.selectAction('D27');
  const trigger = f.q('#btn-trigger-add-point');
  trigger.focus(); trigger.click();
  const dialog = f.q('#modal-add-point');
  const cancel = new f.dom.window.Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(dialog.open, true);
  const pending = f.app.closeDialog(dialog);
  assert.equal(f.app.closeDialog(dialog), pending);
  boundary.exits.at(-1).finish();
  await pending;
  assert.equal(dialog.open, false);
  assert.equal(f.dom.window.document.activeElement, trigger);
  f.q('#btn-toggle-settings').focus();
  await f.app.closeDialog(dialog);
  assert.equal(f.dom.window.document.activeElement, f.q('#btn-toggle-settings'));
});

test('details-to-rename waits for exit and rename success returns focus to the stable details entry', async t => {
  const boundary = sheetBoundary();
  const f = await fixture(t, { ...boundary, events: [event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27', point_id: 'LOST' })] });
  await connect(f);
  await f.app.selectAction('D27', 'P1');
  f.q('#btn-rename-point').click();
  f.q('[data-rename-point-id="LOST"]').click();
  assert.equal(f.q('#modal-shoot-details').open, true);
  assert.equal(f.q('#modal-add-point').open, false);
  boundary.exits.at(-1).finish();
  await until(() => f.q('#modal-add-point').open);
  assert.equal(f.q('#modal-shoot-details').open, false);
  f.q('#input-add-point-name').value = '补名';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  assert.equal(f.q('#modal-add-point').open, true);
  boundary.exits.at(-1).finish();
  await until(() => !f.q('#modal-add-point').open);
  assert.equal(f.dom.window.document.activeElement, f.q('#btn-current-details'));
  assert.equal(f.app.state.status.point_id, 'P1');
});

test('add persists before exit but does not select the old action after project change during exit', async t => {
  const boundary = sheetBoundary();
  const f = await fixture(t, boundary);
  await connect(f);
  await f.app.selectAction('D27', 'P1');
  f.q('#btn-trigger-add-point').click();
  f.q('#input-add-point-id').value = 'NEW';
  f.q('#input-add-point-name').value = '保留原清单';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));
  assert.equal(f.q('#modal-add-point').open, true);
  assert.ok(JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY)).actions.find(a => a.action_id === 'D27').points.some(p => p.point_id === 'NEW'));
  const before = f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length;
  f.client.emitStatus({ project_id: 'Q', events: [], take_id: 0, action_id: 'S01', point_id: '' });
  boundary.exits.at(-1).finish();
  await until(() => !f.q('#modal-add-point').open && f.q('#status-banner').dataset.tone === 'warn');
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length, before);
  assert.equal(f.app.state.status.project_id, 'Q');
  assert.ok(JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY)).actions.find(a => a.action_id === 'D27').points.some(p => p.point_id === 'NEW'));
});

test('no animation and reduced motion close immediately, and destroy prevents late modal or focus blockers', async t => {
  for (const mode of ['no-animation', 'reduced-motion', 'destroy']) {
    await t.test(mode, async t => {
      const boundary = sheetBoundary({ animated: mode !== 'no-animation', reducedMotion: mode === 'reduced-motion' });
      const f = await fixture(t, boundary);
      await connect(f);
      await f.app.selectAction('D27');
      f.q('#btn-current-details').click();
      const dialog = f.q('#modal-shoot-details');
      const closing = f.app.closeDialog(dialog);
      if (mode === 'destroy') {
        assert.equal(dialog.open, true);
        f.app.destroy();
        assert.equal(dialog.open, false);
        f.q('#btn-toggle-settings').focus();
        boundary.exits.at(-1).finish();
      } else assert.equal(dialog.open, false);
      await closing;
      if (mode === 'destroy') assert.equal(f.dom.window.document.activeElement, f.q('#btn-toggle-settings'));
    });
  }
});

test('success feedback expires at the UI boundary and a replaced error survives its old timer', async t => {
  const timers = new Map();
  let nextTimer = 0;
  const f = await fixture(t, { configureWindow(win) {
    win.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
    win.clearTimeout = id => { timers.delete(id); };
  } });
  f.app.setBanner('成功', { tone: 'ok' });
  const first = [...timers.values()].at(-1);
  assert.equal(first.delay, 2000);
  assert.equal(f.q('#status-banner').hidden, false);
  first.callback();
  assert.equal(f.q('#status-banner').hidden, true);
  f.app.setBanner('再次成功', { tone: 'ok' });
  const obsolete = [...timers.keys()].at(-1);
  const obsoleteCallback = timers.get(obsolete).callback;
  f.app.setBanner('实际错误', { tone: 'error', code: 'boundary_failure', detail: '完整错误' });
  assert.equal(timers.has(obsolete), false);
  obsoleteCallback();
  assert.equal(f.q('#status-banner').hidden, false);
  assert.equal(f.q('#status-banner-code').textContent, 'boundary_failure');
  f.q('#btn-dismiss-feedback').click();
  assert.equal(f.q('#status-banner').hidden, true);
  assert.equal(f.app.state.lastErrorCode, 'boundary_failure');
});

test('pending sync is quiet and persistent storage failure stays available across views and dismissal until recovery', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  const originalSync = f.client.syncLog.bind(f.client);
  const reached = deferred(), release = deferred();
  f.client.syncLog = async (...args) => { reached.resolve(); await release.promise; return originalSync(...args); };
  const syncing = f.app.syncCurrentProject();
  await reached.promise;
  assert.equal(f.q('#ledger-storage-details').hidden, true);
  assert.equal(f.q('#nav-btn-records').dataset.syncState, 'pending');
  assert.ok(f.q('#records-sync-hint').textContent);
  assert.equal(f.q('#conn-badge').dataset.state, 'connected');
  release.resolve(); await syncing;
  f.client.syncLog = originalSync;
  const set = f.app.storage.setItem.bind(f.app.storage);
  let failing = true;
  f.app.storage.setItem = (key, value) => {
    if (failing && key === ledgerEventKey('P', 3)) {
      const error = new Error('完整存储故障 '.repeat(80)); error.name = 'QuotaExceededError'; throw error;
    }
    set(key, value);
  };
  await f.app.markDiscard(1, true);
  assert.equal(f.q('#ledger-storage-details').hidden, false);
  assert.equal(f.q('#nav-btn-records').dataset.syncState, 'failed');
  for (const view of ['list', 'records', 'shoot']) {
    f.app.switchView(view);
    assert.equal(f.q('#ledger-storage-details').hidden, false);
  }
  f.client.emitStatus({ action_id: '', point_id: '' });
  assert.equal(f.q('#btn-current-details').disabled, true);
  f.q('#btn-ledger-details').click();
  assert.equal(f.q('#modal-shoot-details').open, true);
  assert.match(f.q('#shoot-details-content').textContent, /完整存储故障/);
  assert.equal(f.q('#shoot-orphan-points').hidden, true);
  f.q('#btn-shoot-details-close').click();
  f.q('#btn-dismiss-feedback').click();
  assert.equal(f.q('#ledger-storage-details').hidden, false);
  f.app.downloadBackup();
  assert.equal(f.q('#status-banner').hidden, false);
  assert.equal(f.q('#status-banner').dataset.tone, 'warn');
  assert.equal(f.q('#ledger-storage-details').hidden, false);
  failing = false;
  await f.app.syncCurrentProject();
  assert.equal(f.q('#ledger-storage-details').hidden, true);
  assert.equal(f.q('#nav-btn-records').dataset.syncState, 'clean');
});

test('confirmed point reveal moves only its rail and leaves manual scrolling alone on clock ticks', async t => {
  const frames = new Map();
  let frameId = 0;
  const f = await fixture(t, { configureWindow(win) {
    win.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    win.cancelAnimationFrame = id => frames.delete(id);
  } });
  const flush = () => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback();
  };
  await connect(f);
  const expanded = structuredClone(template);
  expanded.actions.find(a => a.action_id === 'D27').points = Array.from({ length: 12 }, (_, i) => ({ point_id: `P${i + 1}`, name: `点位${i + 1}` }));
  f.app.importTemplateObject(expanded);
  await f.app.selectAction('D27', 'P1');
  assert.equal(f.q('#points-container').hidden, false);
  assert.match(f.q('#confirmed-point-id').textContent, /点位1/);

  // Style 2.2-B: open point sheet drawer, track scrollIntoView on confirmed status change without scrolling shoot panel
  f.q('#btn-open-point-sheet').click();
  assert.equal(f.q('#modal-point-list').open, true);
  flush();
  const rail = f.q('#point-pills');
  let revealedPointId = '';
  for (const button of rail.querySelectorAll('[data-point-id]')) {
    button.scrollIntoView = () => { revealedPointId = button.dataset.pointId; };
  }
  const pageScrolls = f.scrolls.length;
  f.client.emitStatus({ point_id: 'P12' });
  flush();
  assert.equal(revealedPointId, 'P12');
  assert.equal(f.scrolls.length, pageScrolls);

  // Ticks do not override or send SELECT_ACTION
  const cmdsBefore = f.client.mockState.commands.length;
  revealedPointId = '';
  f.advance(1000);
  flush();
  assert.equal(revealedPointId, '');
  assert.equal(f.client.mockState.commands.length, cmdsBefore);
  assert.equal(f.app.state.status.point_id, 'P12');

  // Selecting a point inside the sheet sends SELECT_ACTION and closes the sheet
  f.q('#point-pills [data-point-id="P2"]').click();
  await until(() => !f.app.state.pendingSelect && f.app.state.status.point_id === 'P2');
  assert.equal(f.q('#modal-point-list').open, false);
});

test('mobile 3-bay layout has no legacy is-overflow-layout toggle and cleanly transitions to desktop columns', async t => {
  const f = await fixture(t);
  const view = f.q('#view-shoot');
  assert.ok(f.q('#shoot-camera-status'));
  assert.ok(f.q('#card-current-action'));
  assert.ok(f.q('#shoot-record-controls'));
  assert.equal(view.classList.contains('is-overflow-layout'), false);
  assert.equal(f.root.classList.contains('is-overflow-layout'), false);
  f.resize(320, 568);
  assert.equal(view.classList.contains('is-overflow-layout'), false);
  f.resize(1024, 800);
  assert.equal(f.app.state.desktopMode, true);
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-list').hidden, false);
  assert.equal(f.q('#view-records').hidden, false);
});

test('shoot details keep full imported names and close immediately when their captured identity changes', async t => {
  const boundary = sheetBoundary();
  const f = await fixture(t, boundary);
  await connect(f);
  const imported = structuredClone(template);
  const action = imported.actions.find(a => a.action_id === 'D27');
  action.name = '动作'.repeat(40);
  action.points[0].name = '界'.repeat(62) + '😀';
  f.app.importTemplateObject(imported);
  await f.app.selectAction('D27', 'P1');
  assert.equal(f.q('#confirmed-action-name').textContent, action.name);
  f.q('#btn-current-details').click();
  const values = [...f.q('#shoot-details-content').querySelectorAll('dd')].map(node => node.textContent);
  assert.ok(values.includes(action.name));
  assert.ok(values.includes(action.points[0].name));
  const commands = f.client.mockState.commands.length;
  f.client.emitStatus({ action_id: 'S01', point_id: '' });
  assert.equal(f.q('#modal-shoot-details').open, false);
  assert.equal(f.client.mockState.commands.length, commands);
});

function foreignTemplate() {
  const foreign = structuredClone(template);
  foreign.template_id = 'OTHER_TEMPLATE';
  foreign.template_name = '另一份清单';
  for (const action of foreign.actions) {
    action.name = `外来动作${action.action_id}`;
    for (const point of action.points || []) point.name = `外来点位${point.point_id}`;
  }
  return foreign;
}

test('template identity: foreign import cannot relabel takes or send selection START or REASSIGN, and matching recovery preserves STOP', async t => {
  const events = completedTake().map(e => ({ ...e, action_id: 'D27', point_id: 'P1' }));
  const f = await fixture(t, { events });
  await connect(f);
  await f.app.selectAction('D27', 'P1');
  await f.app.syncCurrentProject();
  f.q('#btn-current-details').click();
  assert.equal(f.q('#modal-shoot-details').open, true);
  const eventsBefore = JSON.stringify(f.app.state.ledger.events);
  f.app.importTemplateObject(foreignTemplate());
  assert.equal(f.q('#modal-shoot-details').open, false);
  assert.equal(f.app.state.status.template_id, 'T');
  assert.equal(f.app.state.template.template_id, 'OTHER_TEMPLATE');
  assert.doesNotMatch(f.q('#confirmed-action-name').textContent, /外来动作/);
  assert.doesNotMatch(f.q('#confirmed-point-id').textContent, /外来点位/);
  assert.doesNotMatch(f.q('[data-take-action="D27"]').textContent, /外来动作|人员操作/);
  for (const selector of ['#record-observation-text', '#template-subtitle']) {
    const text = f.q(selector).textContent;
    assert.ok(text.includes('T') && text.includes('OTHER_TEMPLATE'));
  }
  assert.equal(f.q('#btn-record-main').disabled, true);
  assert.doesNotMatch(f.q('#record-observation-text').textContent, /可以开始录像/);
  f.q('#action-list [data-action-id="S01"]').click();
  assert.equal(f.q('#action-list [data-select-confirm="S01"]').disabled, true);
  assert.equal(f.q('#btn-trigger-add-point').disabled, true);
  assert.equal(f.q('#shoot-action-takes-section').hidden, true);
  assert.equal(f.q('#recent-takes-list [data-take-id="1"] [data-action="open-reassign"]').disabled, true);
  f.q('#btn-current-details').click();
  assert.doesNotMatch(f.q('#shoot-details-content').textContent, /外来动作|外来点位/);
  f.q('#btn-shoot-details-close').click();
  const commandsBefore = f.client.mockState.commands.length;
  assert.equal(await f.app.selectAction('S01'), null);
  assert.equal(await f.app.startRecording(), null);
  assert.equal(await f.app.reassignTake(1, 'S01'), null);
  f.q('#recent-takes-list [data-take-id="1"] [data-action="open-reassign"]').dispatchEvent(new f.dom.window.Event('click'));
  f.q('#btn-trigger-add-point').dispatchEvent(new f.dom.window.Event('click'));
  assert.equal(f.q('#modal-add-point').open, false);
  assert.equal(f.app.state.editingReassignTakeId, null);
  assert.equal(f.client.mockState.commands.length, commandsBefore);
  assert.equal(JSON.stringify(f.app.state.ledger.events), eventsBefore);
  const csv = exportLedgerCsv(f.app.buildBackupPayload(), f.app.state.template);
  assert.match(csv, /D27/);
  assert.doesNotMatch(csv, /外来动作|外来点位|人员操作|传递口/);
  assert.equal((await f.app.markDiscard(1, true))?.ok, true);
  assert.equal(f.app.buildBackupPayload().takes[0].discarded, true);
  f.q('#btn-dismiss-feedback').click();
  assert.ok(f.q('#record-observation-text').textContent.includes('OTHER_TEMPLATE'));
  f.app.importTemplateObject(structuredClone(template));
  assert.equal(f.q('#confirmed-action-name').textContent, '人员操作');
  assert.equal(f.q('#btn-record-main').disabled, false);
  assert.equal((await f.app.selectAction('S01'))?.ok, true);
  assert.equal((await f.app.reassignTake(1, 'S01'))?.ok, true);
  assert.equal((await f.app.startRecording())?.ok, true);
  f.client.emitStatus({ phase: 'recording', cameras: f.client.mockState.cameras.map(cam => ({ ...cam, recording: true, fresh: true, ready: false })) });
  f.app.importTemplateObject(foreignTemplate());
  assert.equal(f.q('#btn-record-main').dataset.mode, 'stop');
  assert.equal(f.q('#btn-record-main').disabled, false);
  const stopsBefore = f.client.mockState.commands.filter(command => command.cmd === 'STOP').length;
  assert.equal((await f.app.stopRecording())?.ok, true);
  assert.equal(f.client.mockState.commands.filter(command => command.cmd === 'STOP').length, stopsBefore + 1);
});

test('template identity: foreign cached preload and device template or project transitions do not borrow names', async t => {
  const storage = createMemoryStorage();
  storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify(foreignTemplate()));
  const f = await fixture(t, { storage, events: completedTake() });
  assert.equal(f.app.state.template.template_id, 'OTHER_TEMPLATE');
  await connect(f);
  assert.doesNotMatch(f.q('#confirmed-action-name').textContent, /外来动作/);
  assert.doesNotMatch(f.q('[data-take-action="S01"]').textContent, /外来动作/);
  assert.equal(f.q('#btn-record-main').disabled, true);
  const before = f.client.mockState.commands.length;
  await f.app.startRecording();
  assert.equal(f.client.mockState.commands.length, before);
  f.client.emitStatus({ template_id: 'OTHER_TEMPLATE' });
  assert.equal(f.q('#confirmed-action-name').textContent, '外来动作S01');
  assert.equal(f.q('#btn-record-main').disabled, false);
  // The device now matches, but this historical take still belongs to T.
  assert.doesNotMatch(f.q('[data-take-action="S01"]').textContent, /外来动作/);
  f.q('#btn-current-details').click();
  f.client.emitStatus({ template_id: 'T' });
  assert.equal(f.q('#modal-shoot-details').open, false);
  assert.doesNotMatch(f.q('#confirmed-action-name').textContent, /外来动作/);
  f.client.emitStatus({ project_id: 'Q', template_id: 'T', events: completedTake('Q'), take_id: 1 });
  await f.app.syncCurrentProject();
  assert.doesNotMatch(f.q('[data-take-action="S01"]').textContent, /外来动作/);
  assert.equal(f.q('#btn-record-main').disabled, true);
  f.client.emitStatus({ template_id: '' });
  assert.doesNotMatch(f.q('#confirmed-action-name').textContent, /外来动作/);
  assert.equal(f.q('#btn-record-main').disabled, true);
  f.app.importTemplateObject(structuredClone(template));
  assert.equal(f.q('#btn-record-main').disabled, true);
  f.client.emitStatus({ template_id: 'T' });
  assert.equal(f.q('#confirmed-action-name').textContent, '静态检查');
  assert.match(f.q('[data-take-action="S01"]').textContent, /静态检查/);
  assert.equal(f.q('#btn-record-main').disabled, false);
});

test('template identity: each historical take requires its own nonempty matching identity for row and CSV names', async t => {
  const events = ['OTHER_TEMPLATE', '', 'T'].flatMap((templateId, index) =>
    completedTake().map((entry, offset) => ({ ...entry, event_seq: index * 2 + offset + 1,
      take_id: index + 1, template_id: templateId, action_id: 'D27', point_id: 'P1' })));
  const f = await fixture(t, { events });
  await connect(f);
  assert.equal(f.app.state.status.template_id, 'T');
  assert.equal(f.app.state.template.template_id, 'T');
  for (const takeId of [1, 2]) {
    const row = f.q(`.take-item[data-take-id="${takeId}"] [data-take-action]`).textContent;
    assert.match(row, /D27.*P1/);
    assert.doesNotMatch(row, /人员操作|传递口/);
  }
  assert.match(f.q('.take-item[data-take-id="3"] [data-take-action]').textContent, /人员操作/);
  const csvRows = exportLedgerCsv(f.app.buildBackupPayload(), f.app.state.template).split('\r\n').slice(1);
  for (const row of csvRows.slice(0, 2)) {
    assert.match(row, /D27.*P1/);
    assert.doesNotMatch(row, /人员操作|传递口/);
  }
  assert.match(csvRows[2], /人员操作.*传递口/);
});

test('storage initialization: denied preferences and template cache cannot leave connected controls ready after STATUS stops', async t => {
  const intervals = new Map();
  let timerId = 0;
  replaceGlobal(t, 'setInterval', callback => { const id = ++timerId; intervals.set(id, callback); return id; });
  replaceGlobal(t, 'clearInterval', id => intervals.delete(id));
  const backing = createMemoryStorage();
  let denied = true;
  const storage = Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(method => [method, (...args) => {
    if (denied) throw new DOMException('storage denied by browser', 'SecurityError');
    return backing[method](...args);
  }]));
  const f = await fixture(t, { storage, events: completedTake() });
  assert.equal(f.app.state.template.template_id, 'T');
  assert.ok(f.app.state.templateLoadError);
  assert.match(f.q('#template-subtitle').textContent, /storage denied by browser/);
  const initialTheme = f.dom.window.document.documentElement.getAttribute('data-theme');
  f.q('#btn-theme-toggle').click();
  assert.notEqual(f.dom.window.document.documentElement.getAttribute('data-theme'), initialTheme);
  f.q('#btn-connect').click();
  await until(() => f.app.state.connected && f.app.state.status.time_synced && !f.app.state.syncingLog);
  assert.ok(f.app.state.ledgerReadError);
  assert.equal(f.q('#ledger-storage-details').hidden, false);
  assert.equal(f.app.buildBackupPayload(), null);
  // Advance the clock without directly rendering: only the browser timer boundary
  // delivers the application's existing periodic safety update.
  f.elapse(4600);
  for (const callback of [...intervals.values()]) callback();
  assert.equal(f.q('#btn-record-main').disabled, true);
  assert.notEqual(f.app.getRecordControlState().stage, 'ready');
  assert.match(f.q('#record-observation-text').textContent, /等待相机状态/);
  assert.notEqual(f.q('#phase-badge').dataset.state, 'ready');
  denied = false;
  await f.app.syncCurrentProject();
  f.app.importTemplateObject(structuredClone(template));
  f.client.emitStatus();
  assert.equal(f.app.state.templateLoadError, null);
  assert.equal(f.app.state.ledgerReadError, null);
  assert.equal(f.app.state.ledgerSyncError, null);
  assert.equal(f.q('#ledger-storage-details').hidden, true);
  assert.equal(f.q('#btn-record-main').disabled, false);
  assert.equal(f.app.buildBackupPayload().takes.length, 1);
});

test('storage initialization: invalid template bytes survive denied removal and ready settles with an honest recoverable error', async t => {
  const backing = createMemoryStorage();
  backing.setItem(TEMPLATE_CACHE_KEY, '{invalid template');
  const storage = {
    getItem: key => backing.getItem(key),
    setItem: (key, value) => backing.setItem(key, value),
    removeItem() { throw new DOMException('removal denied by browser', 'SecurityError'); },
  };
  const f = await fixture(t, { storage });
  assert.equal(f.app.state.template.template_id, 'T');
  assert.ok(f.app.state.templateLoadError);
  assert.equal(backing.getItem(TEMPLATE_CACHE_KEY), '{invalid template');
  assert.ok(f.q('#template-subtitle').textContent.includes(f.app.state.templateLoadError.message));
  await connect(f);
  assert.equal(f.q('#btn-record-main').disabled, false);
  assert.ok(f.app.state.templateLoadError);
  f.app.importTemplateObject(structuredClone(template));
  assert.equal(f.app.state.templateLoadError, null);
  assert.equal(JSON.parse(backing.getItem(TEMPLATE_CACHE_KEY)).template_id, 'T');
});

test('shoot 1B queue shows exact group only, jumper switches actions inline, and board filters stay decoupled', async t => {
  const f = await fixture(t);
  await connect(f);
  // Full template actions: S01 (一区, order 1), S27 (二区, order 2), D27 (一区, order 3), D28 (二区, order 4)
  assert.equal(f.app.state.status.action_id, 'S01');
  assert.equal(f.root.querySelector('#btn-prev-action'), null);
  assert.equal(f.root.querySelector('#btn-next-action'), null);

  // Shoot exact-group queue under S01 (一区) renders only S01 & D27, plus next-group CTA for 二区 (S27)
  const queueIds = [...f.root.querySelectorAll('#shoot-group-queue-list [data-queue-action-id]')].map(n => n.dataset.queueActionId);
  assert.deepEqual(queueIds, ['S01', 'D27']);
  assert.match(f.q('#shoot-queue-heading').textContent, /本组队列 · 一区/);
  assert.match(f.q('#shoot-queue-stats').textContent, /待拍 2.*共 2 项/);
  assert.equal(f.q('#btn-next-group-preview').hidden, false);
  assert.match(f.q('#btn-next-group-preview').textContent, /二区/);

  // Clicking board dynamic filter in #view-list keeps #shoot-group-queue-list decoupled on 一区
  f.q('#nav-btn-list').click();
  f.q('[data-type-filter="dynamic"]').click();
  assert.deepEqual(rows(f), ['D27', 'D28']);
  f.q('#nav-btn-shoot').click();
  assert.deepEqual(
    [...f.root.querySelectorAll('#shoot-group-queue-list [data-queue-action-id]')].map(n => n.dataset.queueActionId),
    ['S01', 'D27']
  );

  // Step boundaries at first/last template actions keep commands intact
  const cmdsBefore = f.client.mockState.commands.length;
  assert.equal(await f.app.stepAction(-1), null);
  assert.equal(f.client.mockState.commands.length, cmdsBefore);

  // Open #modal-action-jumper via #btn-open-action-list, filter, and switch directly to D28
  assert.match(f.q('#btn-open-action-list').textContent, /全部 4/);
  f.q('#btn-open-action-list').click();
  assert.equal(f.q('#modal-action-jumper').open, true);
  f.change('#input-jumper-search', 'D28', 'input');
  const jumperItem = f.q('#action-jumper-list [data-jumper-action-id="D28"]');
  jumperItem.click();
  await until(() => f.app.state.status.action_id === 'D28' && !f.q('#modal-action-jumper').open);
  assert.equal(f.app.state.activeView, 'shoot');
  assert.equal(await f.app.stepAction(1), null);
});

test('disconnected state disables action/point controls; unfinished take prevents reassignment; finished take reassigns', async t => {
  const beginEvt = event(1, 'TAKE_BEGIN', {
    take_id: 1, action_id: 'D27', point_id: 'P1',
    command_id: 'start-start-1', source: 'ble', participants: 3,
    time_anchor: { boot_id: 'boot-one', mono_ms: 1000, utc_ms: 1800000000000 }
  });
  const f = await fixture(t, { events: [beginEvt] });
  // While disconnected:
  assert.equal(f.app.state.connected, false);
  assert.equal(f.q('#btn-open-action-list').disabled, true);
  assert.equal(f.q('#btn-trigger-add-point').disabled, true);
  assert.equal(await f.app.stepAction(1), null);
  assert.equal(await f.app.selectAction('D28'), null);

  // Connect: initial log sync delivers the unfinished take
  await connect(f);
  assert.equal(f.app.state.ledger.takes.length, 1);
  assert.equal(f.app.state.ledger.takes[0].ended, false);

  // In records view, reassign button for unfinished take is disabled and displays 结束后可修改
  f.q('#nav-btn-records').click();
  const reassignBtn = f.q('[data-action="open-reassign"]');
  assert.equal(reassignBtn.disabled, true);
  assert.ok(reassignBtn.textContent.includes('结束后可修改'));

  // Direct reassignTake call returns null and rejects modification
  const reassignResult = await f.app.reassignTake(1, 'D28');
  assert.equal(reassignResult, null);
  assert.equal(f.app.state.ledger.takes[0].action_id, 'D27');

  // Complete the take with TAKE_END delivered via mock BLE events and real sync
  const endEvt = event(2, 'TAKE_END', {
    take_id: 1, action_id: 'D27', point_id: 'P1',
    begin_boot_id: 'boot-one', begin_mono_ms: 1000, complete: true,
    reason: 'stopped', observation_lost: false,
    cameras: [
      { seen_recording: true, stop_confirmed: true, record_time: 5, battery: 80, start_ms: 1010, stopped_ms: 1990 },
      { seen_recording: true, stop_confirmed: true, record_time: 5, battery: 80, start_ms: 1020, stopped_ms: 1995 },
    ]
  });
  f.client.mockState.events.push(endEvt);
  await f.app.syncCurrentProject();
  assert.equal(f.app.state.ledger.takes[0].ended, true);

  // Reassign button is now enabled and displays 修改拍摄项
  assert.equal(reassignBtn.disabled, false);
  assert.ok(reassignBtn.textContent.includes('修改拍摄项'));

  // Reassignment succeeds via #modal-reassign
  f.q('[data-action="open-reassign"]').click();
  assert.equal(f.q('#modal-reassign').open, true);
  f.q('[data-reassign-option="D28"]').click();
  f.q('#btn-reassign-confirm').click();
  await until(() => f.app.state.ledger.takes[0]?.action_id === 'D28');
  assert.equal(f.app.state.ledger.takes[0].action_id, 'D28');
});

test('settings sheet native lifecycle works across shoot, list and records views without view switch or state loss, and avoids stacking', async t => {
  const f = await fixture(t);
  await connect(f);

  // 1. Shoot view: open and close settings
  assert.equal(f.app.state.activeView, 'shoot');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'true');
  assert.equal(f.app.state.activeView, 'shoot');
  f.q('#btn-settings-close').click();
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'false');
  assert.equal(f.app.state.activeView, 'shoot');

  // 2. List view: enter search query, open settings, verify view & query intact
  f.q('#nav-btn-list').click();
  assert.equal(f.app.state.activeView, 'list');
  f.change('#input-action-search', '烟流', 'input');
  assert.equal(f.q('#input-action-search').value, '烟流');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  assert.equal(f.app.state.activeView, 'list');
  assert.equal(f.q('#input-action-search').value, '烟流');
  f.q('#btn-settings-close').click();
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.app.state.activeView, 'list');
  assert.equal(f.q('#input-action-search').value, '烟流');

  // 3. Records view: open settings, verify view unchanged
  f.q('#nav-btn-records').click();
  assert.equal(f.app.state.activeView, 'records');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  assert.equal(f.app.state.activeView, 'records');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.app.state.activeView, 'records');

  // 4. Non-stacking: opening details sheet closes settings sheet without stacking
  f.q('#nav-btn-shoot').click();
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  f.q('#btn-current-details').click();
  assert.equal(f.q('#modal-shoot-details').open, true);
  assert.equal(f.q('#modal-settings').open, false);
  f.q('#btn-shoot-details-close').click();
  assert.equal(f.q('#modal-shoot-details').open, false);
});

test('cross-view active capture displays global-record-strip and stop button in list and records views with single-flight idempotency', async t => {
  const f = await fixture(t);
  await connect(f);

  // Start recording: ACK pending is not observed recording
  await f.app.startRecording();
  assert.equal(f.app.state.status.phase, 'starting');

  // While starting, global strip shows transitional observation feedback in list view
  f.q('#nav-btn-list').click();
  assert.equal(f.q('#global-record-strip').hidden, false);
  assert.match(f.q('#global-record-text').textContent, /正在等待.*开始录像/);

  // Mock confirmRecording establishes observed recording
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  assert.match(f.q('#global-record-text').textContent, /正在录像/);
  const listStopBtn = f.q('#btn-global-stop');
  assert.equal(listStopBtn.disabled, false);

  // In mobile shoot view: global strip is hidden to avoid duplicate STOP buttons
  f.q('#nav-btn-shoot').click();
  assert.equal(f.q('#global-record-strip').hidden, true);

  // Switch to records view: global strip remains visible with recording state
  f.q('#nav-btn-records').click();
  assert.equal(f.q('#global-record-strip').hidden, false);
  assert.match(f.q('#global-record-text').textContent, /正在录像/);

  // Click global stop button: executes single-flight idempotency on mock protocol STOP
  const stopCmdsBefore = f.client.mockState.commands.filter(c => c.cmd === 'STOP').length;
  listStopBtn.click();
  listStopBtn.click(); // Concurrent duplicate click
  await until(() => f.app.state.status.phase === 'idle');
  const stopCmdsAfter = f.client.mockState.commands.filter(c => c.cmd === 'STOP').length;
  assert.equal(stopCmdsAfter - stopCmdsBefore, 1);

  // Resulting capture and ledger state settles back to idle
  assert.equal(f.app.state.status.phase, 'idle');
  assert.equal(f.app.state.status.active_take_id, 0);
  assert.equal(f.q('#global-record-strip').hidden, true);
  f.q('#nav-btn-list').click();
  assert.equal(f.q('#global-record-strip').hidden, true);
});

test('take duration formats valid zero, positive, cross-boot and unfinished durations correctly in records view', async t => {
  const f = await fixture(t, {
    events: [
      // Take 1: Normal completed take (1000ms -> 6000ms = 5s)
      event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', boot_id: 'b1', mono_ms: 1000 }),
      event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 1000, boot_id: 'b1', mono_ms: 6000, complete: true }),
      // Take 2: Cross-boot take
      event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S27', point_id: '', boot_id: 'b1', mono_ms: 2000 }),
      event(4, 'TAKE_END', { take_id: 2, action_id: 'S27', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 2000, boot_id: 'b2', mono_ms: 7000, complete: true }),
      // Take 3: Valid zero duration
      event(5, 'TAKE_BEGIN', { take_id: 3, action_id: 'D27', point_id: 'P1', boot_id: 'b1', mono_ms: 3000 }),
      event(6, 'TAKE_END', { take_id: 3, action_id: 'D27', point_id: 'P1', begin_boot_id: 'b1', begin_mono_ms: 3000, boot_id: 'b1', mono_ms: 3000, complete: true }),
      // Take 4: Unfinished take
      event(7, 'TAKE_BEGIN', { take_id: 4, action_id: 'D28', point_id: '', boot_id: 'b1', mono_ms: 4000 }),
    ]
  });
  await connect(f);
  f.q('#nav-btn-records').click();

  const durationSpans = [...f.root.querySelectorAll('.take-duration')];
  assert.equal(durationSpans.length, 4);
  // Take 4 is top (most recent): unfinished -> ''
  assert.equal(durationSpans[0].textContent.trim(), '');
  // Take 3: valid zero -> '00:00'
  assert.equal(durationSpans[1].textContent.trim(), '00:00');
  // Take 2: cross-boot -> '计时待确认'
  assert.equal(durationSpans[2].textContent.trim(), '计时待确认');
  // Take 1: 5s -> '00:05'
  assert.equal(durationSpans[3].textContent.trim(), '00:05');

  // Reversible discard state invariants without wording pins
  const discardBtns = [...f.root.querySelectorAll('[data-action="toggle-discard"]')];
  discardBtns[3].click();
  await until(() => f.app.state.ledger.takes.find(t => t.take_id === 1)?.discarded === true && !discardBtns[3].disabled);
  discardBtns[3].click();
  await until(() => f.app.state.ledger.takes.find(t => t.take_id === 1)?.discarded === false && !discardBtns[3].disabled);
});

test('native-compatible point input accepts hyphenated ID P-01 and rejects invalid characters without persistence or commands', async t => {
  // Unit test on isValidPointId
  assert.equal(isValidPointId('P-01'), true);
  assert.equal(isValidPointId('P_01'), true);
  assert.equal(isValidPointId('P1'), true);
  assert.equal(isValidPointId('Point-12_A'), true);
  assert.equal(isValidPointId('P.01'), false);
  assert.equal(isValidPointId('P 01'), false);
  assert.equal(isValidPointId('P#1'), false);
  assert.equal(isValidPointId('P/01'), false);
  assert.equal(isValidPointId(''), false);

  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27');

  // Open add point dialog
  f.q('#btn-trigger-add-point').click();
  assert.equal(f.q('#modal-add-point').open, true);

  // Submit valid hyphenated point ID
  f.q('#input-add-point-id').value = 'P-01';
  f.q('#input-add-point-name').value = '测点一';
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));

  // Point is persisted and selected
  const cached = JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY));
  const d27Points = cached.actions.find(a => a.action_id === 'D27').points;
  assert.ok(d27Points.some(p => p.point_id === 'P-01' && p.name === '测点一'));

  // Attempt to add invalid point ID with whitespace or dots
  f.q('#btn-trigger-add-point').click();
  f.q('#input-add-point-id').value = 'P.INVALID';
  f.q('#input-add-point-name').value = '非法测点';
  const cmdsCount = f.client.mockState.commands.length;
  f.q('#form-add-point').dispatchEvent(new f.dom.window.Event('submit', { cancelable: true }));

  // Not added to template, no commands sent
  const cachedAfter = JSON.parse(f.app.storage.getItem(TEMPLATE_CACHE_KEY));
  const pointsAfter = cachedAfter.actions.find(a => a.action_id === 'D27').points;
  assert.equal(pointsAfter.some(p => p.point_id === 'P.INVALID'), false);
  assert.equal(f.client.mockState.commands.length, cmdsCount);
});

test('AC09: action and point completion requires ended complete non-discarded takes with matching template and handles unknown/incomplete states', async t => {
  const events = [
    // Foreign template complete take for S01 must never mark S01 complete in template T
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', template_id: 'OTHER' }),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', point_id: '', template_id: 'OTHER', complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000 }),
    // S27 has only an unfinished take -> unfinished, not complete
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S27', point_id: '' }),
    // D27 P1 complete, P2 abnormal, empty point_id complete, orphan P_ORPHAN complete
    event(4, 'TAKE_BEGIN', { take_id: 3, action_id: 'D27', point_id: 'P1' }),
    event(5, 'TAKE_END', { take_id: 3, action_id: 'D27', point_id: 'P1', complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 4000 }),
    event(6, 'TAKE_BEGIN', { take_id: 4, action_id: 'D27', point_id: 'P2' }),
    event(7, 'TAKE_END', { take_id: 4, action_id: 'D27', point_id: 'P2', complete: false, begin_boot_id: 'boot-one', begin_mono_ms: 6000 }),
    event(8, 'TAKE_BEGIN', { take_id: 5, action_id: 'D27', point_id: 'P_ORPHAN' }),
    event(9, 'TAKE_END', { take_id: 5, action_id: 'D27', point_id: 'P_ORPHAN', complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 8000 }),
    event(10, 'TAKE_BEGIN', { take_id: 6, action_id: 'D27', point_id: '' }),
    event(11, 'TAKE_END', { take_id: 6, action_id: 'D27', point_id: '', complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 9000 }),
  ];
  const f = await fixture(t, { events });
  await connect(f);

  // Initially nothing is complete in template T; S27 has unfinished badge
  f.q('[data-status-filter="shot"]').click();
  assert.deepEqual(rows(f), []);
  f.q('[data-status-filter="unshot"]').click();
  assert.deepEqual(rows(f), ['S01', 'S27', 'D27', 'D28']);
  assert.match(f.q('[data-action-id="S27"] .action-row-status-inline').textContent, /未结 1 条/);

  // Select D27 and verify point progress marks without confusing active with complete or rebuilding on tick
  await f.app.selectAction('D27', 'P2');
  const p1BtnBefore = f.q('#point-pills [data-point-id="P1"]');
  const p1Mark = f.q('#point-pills [data-point-id="P1"] .point-progress-mark');
  const p2Mark = f.q('#point-pills [data-point-id="P2"] .point-progress-mark');
  const orphanMark = f.q('#point-pills [data-point-id="P_ORPHAN"] .point-progress-mark');
  assert.equal(p1Mark.dataset.shot, 'complete');
  assert.equal(p2Mark.dataset.shot, 'abnormal');
  assert.equal(orphanMark.dataset.shot, 'complete');
  assert.equal(f.q('#point-pills [data-point-id=""] .point-progress-mark').hidden, true);
  assert.match(f.q('#point-pills [data-point-id="P1"]').getAttribute('aria-label'), /已完成/);
  assert.match(f.q('#point-pills [data-point-id="P2"]').getAttribute('aria-label'), /有异常/);
  f.advance(1000);
  assert.equal(f.q('#point-pills [data-point-id="P1"]'), p1BtnBefore);

  // Discard P1 -> empty-point_id take on D27 cannot satisfy P1/P2 (stays 0/2)
  await f.app.markDiscard(3, true);
  assert.equal(p1Mark.dataset.shot, 'unshot');
  assert.match(f.q('[data-action-id="D27"] .action-row-status-inline').textContent, /0\/2/);
  // Add an unfinished take on P1 -> pill shows unfinished without marking complete
  let nextSeq = f.client.mockState.events.length + 1;
  f.client.mockState.events.push(event(nextSeq, 'TAKE_BEGIN', { take_id: 7, action_id: 'D27', point_id: 'P1' }));
  f.app.applyStatusSnapshot({ event_seq: nextSeq, take_id: 7 });
  await f.app.syncCurrentProject();
  assert.equal(p1Mark.dataset.shot, 'unfinished');
  assert.match(f.q('#point-pills [data-point-id="P1"]').getAttribute('aria-label'), /未结束/);

  await f.app.markDiscard(3, false);
  assert.equal(p1Mark.dataset.shot, 'complete');
  assert.match(f.q('[data-action-id="D27"] .action-row-status-inline').textContent, /1\/2.*异常 1/);

  // Complete P2 -> D27 becomes complete and enters 'shot' filter while keeping abnormal count visible
  nextSeq = f.client.mockState.events.length + 1;
  f.client.mockState.events.push(
    event(nextSeq, 'TAKE_BEGIN', { take_id: 8, action_id: 'D27', point_id: 'P2' }),
    event(nextSeq + 1, 'TAKE_END', { take_id: 8, action_id: 'D27', point_id: 'P2', complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 10000 }),
  );
  f.app.applyStatusSnapshot({ event_seq: nextSeq + 1, take_id: 8 });
  await f.app.syncCurrentProject();
  assert.ok(f.app.state.ledger.takes.some(tk => tk.take_id === 8 && tk.ended));

  assert.equal(p2Mark.dataset.shot, 'complete');
  f.q('[data-status-filter="shot"]').click();
  assert.deepEqual(rows(f), ['D27']);
  assert.match(f.q('[data-action-id="D27"] .action-row-status-inline').textContent, /已拍齐 2\/2.*异常 1/);

  // Partial sync shows '副本待更新' without wiping known progress
  f.app.applyStatusSnapshot({ event_seq: 999 });
  assert.equal(f.q('#list-progress-status').hidden, false);
  assert.equal(f.q('#list-progress-status').textContent, '副本待更新');
  assert.deepEqual(rows(f), ['D27']);

  // Template mismatch shows '完成度未知' and does not filter out actions via saved statusFilter='shot'
  f.app.applyStatusSnapshot({ template_id: 'OTHER' });
  assert.equal(f.q('#list-progress-status').hidden, false);
  assert.equal(f.q('#list-progress-status').textContent, '完成度未知');
  assert.deepEqual(rows(f), ['S01', 'S27', 'D27', 'D28']);
  assert.equal(f.app.state.statusFilter, 'shot');

  // Recovering matching template & synced seq restores saved 'shot' filter automatically
  f.app.applyStatusSnapshot({ template_id: 'T', event_seq: f.app.state.ledger.after_seq });
  assert.equal(f.q('#list-progress-status').hidden, true);
  assert.deepEqual(rows(f), ['D27']);

  // ledgerReadError hides completion on both list and point pills without mutating statusFilter
  f.app.storage.setItem(ledgerCursorKey('Q'), '1');
  f.app.storage.setItem(ledgerEventKey('Q', 1), '{broken');
  f.app.applyStatusSnapshot({ project_id: 'Q', template_id: 'T', event_seq: 1 });
  assert.equal(f.q('#list-progress-status').hidden, false);
  assert.equal(f.q('#list-progress-status').textContent, '完成度未知');
  assert.deepEqual(rows(f), ['S01', 'S27', 'D27', 'D28']);
  assert.equal(f.q('#point-pills [data-point-id="P1"] .point-progress-mark').hidden, true);
  assert.match(f.q('#point-pills [data-point-id="P1"]').getAttribute('aria-label'), /完成度未知/);
});

test('AC11: clip sequences track per-camera seen_recording without renumbering on discard/reassign and export at CSV tail', async t => {
  const events = [
    // Take 1: dual seen_recording
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', participants: 3, mono_ms: 1000 }),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 5000, complete: true,
      cameras: [{ seen_recording: true, stop_confirmed: true, battery: 90 }, { seen_recording: true, stop_confirmed: true, battery: 88 }] }),
    // Take 2: A-only seen_recording, then discarded
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'D27', point_id: 'P1', participants: 3, mono_ms: 6000 }),
    event(4, 'TAKE_END', { take_id: 2, action_id: 'D27', point_id: 'P1', begin_boot_id: 'boot-one', begin_mono_ms: 6000, mono_ms: 8000, complete: false,
      cameras: [{ seen_recording: true, stop_confirmed: true, battery: 89 }, { seen_recording: false, stop_confirmed: false, battery: 87 }] }),
    event(5, 'MARK_DISCARD', { take_id: 2, discard: true }),
    // Take 3: dual seen_recording
    event(6, 'TAKE_BEGIN', { take_id: 3, action_id: 'D27', point_id: 'P2', participants: 3, mono_ms: 9000 }),
    event(7, 'TAKE_END', { take_id: 3, action_id: 'D27', point_id: 'P2', begin_boot_id: 'boot-one', begin_mono_ms: 9000, mono_ms: 14000, complete: true,
      cameras: [{ seen_recording: true, stop_confirmed: true, battery: 86 }, { seen_recording: true, stop_confirmed: true, battery: 84 }] }),
    // Take 4: unfinished BEGIN only (no END)
    event(8, 'TAKE_BEGIN', { take_id: 4, action_id: 'S27', participants: 3, mono_ms: 15000 }),
  ];
  const f = await fixture(t, { events });
  await connect(f);

  let takes = f.app.state.ledger.takes;
  assert.equal(takes[0].cam_a_clip_seq, 1);
  assert.equal(takes[0].cam_b_clip_seq, 1);
  assert.equal(takes[1].cam_a_clip_seq, 2);
  assert.equal(takes[1].cam_b_clip_seq, null);
  assert.equal(takes[2].cam_a_clip_seq, 3);
  assert.equal(takes[2].cam_b_clip_seq, 2);
  assert.equal(takes[3].cam_a_clip_seq, null);
  assert.equal(takes[3].cam_b_clip_seq, null);

  // Reassign and restore take 2: sequences stay invariant
  await f.app.reassignTake(2, 'S27', '');
  await f.app.markDiscard(2, false);
  takes = f.app.state.ledger.takes;
  assert.equal(takes[2].cam_a_clip_seq, 3);
  assert.equal(takes[2].cam_b_clip_seq, 2);

  // Records DOM shows 观察段次 A3 / B2 on take 3, and incomplete warning when seq lags
  const take3Text = f.q('.take-item[data-take-id="3"] .take-cam-summary').textContent;
  assert.match(take3Text, /观察段次 A3/);
  assert.match(take3Text, /观察段次 B2/);
  assert.equal(f.q('#records-clip-incomplete-note').hidden, true);
  f.app.applyStatusSnapshot({ event_seq: 99 });
  assert.equal(f.q('#records-clip-incomplete-note').hidden, false);

  // CSV parses by header: first 15 columns preserved, clip seqs appended at end, null -> empty string
  const csv = exportLedgerCsv(f.app.buildBackupPayload(), f.app.state.template);
  const lines = csv.slice(1).split('\r\n');
  const parseCsvLine = line => line.slice(1, -1).split('","').map(c => c.replace(/""/g, '"'));
  const headers = parseCsvLine(lines[0]);
  assert.deepEqual(headers.slice(0, 15), [
    'take_id', 'action_id', 'action_name', 'point_id', 'point_name',
    'participants', 'complete', 'discarded', 'reason', 'time_anchor_utc',
    'duration_s', 'cam_a_recording', 'cam_a_battery', 'cam_b_recording', 'cam_b_battery',
  ]);
  assert.deepEqual(headers.slice(15), ['cam_a_clip_seq', 'cam_b_clip_seq', 'segment_no', 'action_description']);
  const rowsByTake = lines.slice(1).map(l => Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(l)[i]])));
  assert.equal(rowsByTake[1].cam_a_clip_seq, '2');
  assert.equal(rowsByTake[1].cam_b_clip_seq, '');
  assert.equal(rowsByTake[2].cam_a_clip_seq, '3');
  assert.equal(rowsByTake[2].cam_b_clip_seq, '2');
  assert.equal(rowsByTake[3].cam_a_clip_seq, '');
  assert.equal(rowsByTake[3].cam_b_clip_seq, '');

  // New project restarts clip sequence from 1; TAKE_END without BEGIN & 1-cam array handled safely
  const newProjTakes = foldEventsToTakes([
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01' }, 'Q'),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', complete: true,
      cameras: [{ seen_recording: true }, { seen_recording: true }] }, 'Q'),
    event(3, 'TAKE_END', { take_id: 2, action_id: 'S01', complete: false,
      cameras: [{ seen_recording: true }] }, 'Q'),
  ]);
  assert.equal(newProjTakes[0].cam_a_clip_seq, 1);
  assert.equal(newProjTakes[0].cam_b_clip_seq, 1);
  assert.equal(newProjTakes[1].cam_a_clip_seq, 2);
  assert.equal(newProjTakes[1].cam_b_clip_seq, null);
  assert.match(formatTakeCameraSummary(null, 'A', 3, 0, null), /等待拍摄结果/);
});

test('AC01: getRecordControlState derives all 11 stages cleanly, blocks writable=false/storage_error START, and syncs START_ACK lifecycle', async t => {
  const f = await fixture(t);
  assert.equal(f.app.getRecordControlState().stage, 'disconnected');
  assert.equal(f.app.getRecordControlState().mode, 'start');
  assert.equal(f.app.getRecordControlState().canStart, false);
  assert.equal(f.app.getRecordControlState().canStop, false);
  assert.match(f.q('#record-observation-text').textContent, /无法从手机发送停止命令/);

  await connect(f);
  await f.app.selectAction('S01');
  assert.equal(f.app.getRecordControlState().stage, 'ready');
  assert.equal(f.app.getRecordControlState().canStart, true);

  // free_bytes=0 alone must NOT invent a byte-threshold block
  f.app.applyStatusSnapshot({ ...f.app.state.status, free_bytes: 0, writable: true, storage_error: '' });
  assert.equal(f.app.getRecordControlState().stage, 'ready');
  assert.equal(f.app.getRecordControlState().canStart, true);

  // writable=false or storage_error blocks START while leaving free_bytes innocent
  f.app.applyStatusSnapshot({ ...f.app.state.status, writable: false, storage_error: 'sd_readonly' });
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.equal(f.app.getRecordControlState().canStart, false);
  assert.match(f.q('#record-observation-text').textContent, /sd_readonly/);
  const blockedCmds = f.client.mockState.commands.length;
  const blockedReply = await f.app.startRecording();
  assert.equal(blockedReply, null);
  assert.equal(f.client.mockState.commands.length, blockedCmds);

  f.app.applyStatusSnapshot({ ...f.app.state.status, writable: true, storage_error: '' });
  assert.equal(f.app.getRecordControlState().stage, 'ready');
  assert.match(f.q('#btn-record-meta').textContent, /双机同拍 · .*静 01/);

  // Hold START reply to inspect starting -> partial -> recording -> recording_stale
  const startHold = holdReply(f.client, 'START');
  const startPromise = f.app.startRecording();
  await startHold.reached;
  assert.equal(f.app.getRecordControlState().stage, 'starting');
  assert.equal(f.q('#status-banner').dataset.tone, 'busy');
  startHold.release();
  await startPromise;

  // After START ACK with 0 observed cameras: START_ACK shown & stage is 'starting'
  assert.equal(f.app.getRecordControlState().stage, 'starting');
  assert.equal(f.q('#status-banner').hidden, false);

  // Only Camera A confirmed fresh recording -> stage 'partial', START_ACK banner dismissed
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'recording',
    active_take_id: f.app.state.status.take_id,
    active_participants: 3,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: true, ready: false, led: 2 },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: false, ready: true, led: 1 },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'partial');
  assert.equal(f.app.getRecordControlState().observedMask, 1);
  assert.match(f.q('#record-observation-text').textContent, /仅A机录像，B机未确认/);
  assert.equal(f.q('#status-banner').hidden, true);
  assert.equal(f.q('#btn-cam-toggle-a').disabled, true);
  assert.equal(f.q('#btn-cam-toggle-b').disabled, true);
  assert.equal(f.q('#btn-open-action-list').disabled, true);

  // Both cameras confirmed -> stage 'recording'
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'recording',
    active_take_id: f.app.state.status.take_id,
    active_participants: 3,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: true, ready: false, led: 2 },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: true, ready: false, led: 2 },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'recording');
  assert.equal(f.app.getRecordControlState().observedMask, 3);
  assert.match(f.q('#record-observation-text').textContent, /双机录像中/);

  // Stale during full confirmed recording -> stage 'recording_stale' with canStop still true
  f.advance(4000);
  assert.equal(f.app.getRecordControlState().stage, 'recording_stale');
  assert.equal(f.app.getRecordControlState().canStop, true);
  assert.match(f.q('#phase-badge').textContent, /状态未更新/);
  // Fresh snapshot restores 'recording'
  f.app.applyStatusSnapshot({ ...f.app.state.status, phase: 'recording' });
  assert.equal(f.app.getRecordControlState().stage, 'recording');

  // Pending STOP vs settled_cooldown vs stopping vs safety_stop stages
  const stopHold = holdReply(f.client, 'STOP');
  const stopPromise = f.app.stopRecording();
  await stopHold.reached;
  assert.equal(f.app.getRecordControlState().stage, 'stop_pending');
  assert.equal(f.app.getRecordControlState().canStop, false);
  assert.equal(f.q('#btn-record-main').disabled, true);
  stopHold.release();
  await stopPromise;
  // Right after settling back to idle, 1500ms cooldown blocks START until f.advance(1500)
  assert.equal(f.app.getRecordControlState().stage, 'settled_cooldown');
  assert.equal(f.app.getRecordControlState().canStart, false);
  assert.equal(f.q('#btn-record-main').disabled, true);
  f.advance(1500);
  assert.equal(f.app.getRecordControlState().stage, 'ready');
  assert.equal(f.app.getRecordControlState().canStart, true);

  // In mock, verify stopping & safety_stop via snapshots
  f.app.applyStatusSnapshot({ ...f.app.state.status, phase: 'stopping', active_take_id: f.app.state.status.take_id });
  assert.equal(f.app.getRecordControlState().stage, 'stopping');
  assert.equal(f.app.getRecordControlState().canStop, true);
  assert.match(f.q('#record-observation-text').textContent, /停止请求已接收，等待相机确认/);

  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: true, ready: false },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: false, ready: true },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'safety_stop');
  assert.equal(f.app.getRecordControlState().mode, 'stop');
  assert.equal(f.app.getRecordControlState().canStop, true);
  assert.equal(f.q('#btn-cam-toggle-a').disabled, true);
});

test('AC02: STOP ACK uses STOP_WAIT, requires idle + fresh camera idle + synced TAKE_END.complete=true for STOP_OK, and guards late/abnormal/failed sync', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('S01');

  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  const takeId = f.app.state.status.active_take_id;

  // Custom request handler to inspect STOP ACK before idle arrives, and defer TAKE_END sync
  const origRequest = f.client.request.bind(f.client);
  f.client.request = async req => {
    if (req.cmd === 'STOP') {
      return { ok: true, cmd: 'STOP', phase: 'stopping', take_id: takeId, active_participants: 3, event_seq: f.app.state.status.event_seq };
    }
    return origRequest(req);
  };
  await f.app.stopRecording();
  assert.equal(f.q('#status-banner').dataset.tone, 'busy');
  assert.notEqual(f.q('#status-banner').dataset.tone, 'ok');
  assert.match(f.q('#status-banner').textContent, /等待相机确认停录/);

  // Phase=idle + active_take_id=0 + fresh cameras idle, BEFORE TAKE_END synced -> "相机已确认停录，场记待同步"
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    active_participants: 0,
    take_id: takeId,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: false, ready: true, led: 1 },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: false, ready: true, led: 1 },
    ],
  });
  assert.equal(f.q('#status-banner').dataset.tone, 'busy');
  assert.match(f.q('#status-banner').textContent, /相机已确认停录，场记待同步/);

  // Now persist TAKE_END(complete: true) into storage & sync -> upgrades to STOP_OK (tone=ok)
  f.client.mockState.phase = 'idle';
  f.client.mockState.active_take_id = 0;
  f.client.mockState.active_participants = 0;
  f.client.mockState.cameras = [
    { ...f.client.mockState.cameras[0], recording: false, ready: true, led: 1 },
    { ...f.client.mockState.cameras[1], recording: false, ready: true, led: 1 },
  ];
  const endSeq = f.client.mockState.events.length + 1;
  f.client.mockState.events.push(event(endSeq, 'TAKE_END', {
    take_id: takeId,
    action_id: 'S01',
    point_id: '',
    participants: 3,
    complete: true,
    begin_boot_id: f.client.mockState.boot_id,
    begin_mono_ms: 1000,
    boot_id: f.client.mockState.boot_id,
    mono_ms: 4000,
  }));
  await f.app.syncCurrentProject(f.app.state.status.project_id, { silent: true });
  assert.equal(f.q('#status-banner').dataset.tone, 'ok');
  assert.match(f.q('#status-banner').textContent, /已记录到场记/);

  // Abnormal stop (complete=false) must NOT emit STOP_OK
  f.client.request = origRequest;
  f.advance(1500);
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  const abnTakeId = f.app.state.status.active_take_id;
  f.client.request = async req => {
    if (req.cmd === 'STOP') {
      return { ok: true, cmd: 'STOP', phase: 'stopping', take_id: abnTakeId, active_participants: 3, event_seq: f.app.state.status.event_seq };
    }
    return origRequest(req);
  };
  await f.app.stopRecording();
  const abnSeq = f.client.mockState.events.length + 1;
  f.client.mockState.events.push(event(abnSeq, 'TAKE_END', {
    take_id: abnTakeId,
    action_id: 'S01',
    point_id: '',
    participants: 3,
    complete: false,
    reason: 'cam_b_dropped',
    begin_boot_id: f.client.mockState.boot_id,
    begin_mono_ms: 5000,
    boot_id: f.client.mockState.boot_id,
    mono_ms: 7000,
  }));
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    take_id: abnTakeId,
    event_seq: abnSeq,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: false, ready: true, led: 1 },
      { ...f.client.mockState.cameras[1], connected: false, fresh: true, recording: false, ready: false, led: 0 },
    ],
  });
  await f.app.syncCurrentProject(f.app.state.status.project_id, { silent: true });
  assert.equal(f.q('#status-banner').dataset.tone, 'warn');
  assert.match(f.q('#status-banner').textContent, /拍摄有异常/);

  // Late STOP ACK must not resurrect cleared feedback when newer STATUS settled first
  f.client.request = origRequest;
  f.client.mockState.phase = 'idle';
  f.client.mockState.active_take_id = 0;
  f.client.mockState.active_participants = 0;
  f.client.mockState.cameras = f.client.mockState.cameras.map(cam => ({
    ...cam,
    connected: true,
    fresh: true,
    recording: false,
    ready: true,
    led: 1,
  }));
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    active_participants: 0,
    cameras: f.client.mockState.cameras,
  });
  f.advance(1500);
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  const lateTakeId = f.app.state.status.active_take_id;
  const lateStopHold = holdReply(f.client, 'STOP');
  const lateStopPromise = f.app.stopRecording();
  await lateStopHold.reached;
  const lateSeq = f.client.mockState.events.length + 1;
  f.client.mockState.phase = 'idle';
  f.client.mockState.active_take_id = 0;
  f.client.mockState.cameras = [
    { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: false, ready: true, led: 1 },
    { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: false, ready: true, led: 1 },
  ];
  f.client.mockState.events.push(event(lateSeq, 'TAKE_END', {
    take_id: lateTakeId,
    action_id: 'S01',
    point_id: '',
    participants: 3,
    complete: true,
    begin_boot_id: f.client.mockState.boot_id,
    begin_mono_ms: 8000,
    boot_id: f.client.mockState.boot_id,
    mono_ms: 9500,
  }));
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    take_id: lateTakeId,
    event_seq: lateSeq,
    cameras: f.client.mockState.cameras,
  });
  await f.app.syncCurrentProject(f.app.state.status.project_id, { silent: true });
  assert.equal(f.q('#status-banner').dataset.tone, 'ok');
  lateStopHold.release();
  await lateStopPromise;
  // Late ACK must keep settled OK (not revert to STOP_WAIT)
  assert.equal(f.q('#status-banner').dataset.tone, 'ok');
  assert.match(f.q('#status-banner').textContent, /已记录到场记/);

  // Failed sync (syncLog failure) during STOP settlement keeps non-ok state until retry succeeds
  f.client.request = origRequest;
  const origSyncLog = f.client.syncLog.bind(f.client);
  f.client.mockState.phase = 'idle';
  f.client.mockState.active_take_id = 0;
  f.client.mockState.active_participants = 0;
  f.client.mockState.cameras = f.client.mockState.cameras.map(cam => ({
    ...cam,
    connected: true,
    fresh: true,
    recording: false,
    ready: true,
    led: 1,
  }));
  f.advance(1500);
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  const retryTakeId = f.app.state.status.active_take_id;
  f.client.request = async req => {
    if (req.cmd === 'STOP') {
      return { ok: true, cmd: 'STOP', phase: 'stopping', take_id: retryTakeId, active_participants: 3, event_seq: f.app.state.status.event_seq };
    }
    return origRequest(req);
  };
  f.client.syncLog = async afterSeq => ({ after_seq: afterSeq, events: [], snapshot: { event_seq: f.app.state.status.event_seq } });
  await f.app.stopRecording();
  const retrySeq = f.client.mockState.events.length + 1;
  f.client.mockState.phase = 'idle';
  f.client.mockState.active_take_id = 0;
  f.client.mockState.active_participants = 0;
  f.client.mockState.cameras = f.client.mockState.cameras.map(cam => ({
    ...cam,
    connected: true,
    fresh: true,
    recording: false,
    ready: true,
    led: 1,
  }));
  f.client.mockState.events.push(event(retrySeq, 'TAKE_END', {
    take_id: retryTakeId,
    action_id: 'S01',
    point_id: '',
    participants: 3,
    complete: true,
    begin_boot_id: f.client.mockState.boot_id,
    begin_mono_ms: 10000,
    boot_id: f.client.mockState.boot_id,
    mono_ms: 11500,
  }));
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    active_participants: 0,
    take_id: retryTakeId,
    event_seq: retrySeq,
    cameras: f.client.mockState.cameras,
  });
  await f.app.syncCurrentProject(f.app.state.status.project_id, { silent: true });
  assert.notEqual(f.q('#status-banner').dataset.tone, 'ok');
  assert.equal(f.app.state.ledgerSyncError?.code, 'sync_incomplete');
  f.client.syncLog = origSyncLog;
  await f.app.syncCurrentProject(f.app.state.status.project_id);
  assert.equal(f.q('#status-banner').dataset.tone, 'ok');
  assert.match(f.q('#status-banner').textContent, /已记录到场记/);
});

test('AC03: homepage #btn-reconnect-controller and #btn-import-matching-template recover connection and template mismatch', async t => {
  const storage = createMemoryStorage();
  storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify({ ...template, template_id: 'OTHER_TPL' }));
  const f = await fixture(t, { storage });
  f.client.mockState.template_id = 'T';
  const btnReconnect = f.q('#btn-reconnect-controller');
  assert.equal(btnReconnect.hidden, false);
  assert.equal(btnReconnect.disabled, false);

  // Clicking #btn-reconnect-controller starts connection synchronously via connectFromGesture and disables both entries while connecting
  let resolveConnect;
  const origConnect = f.client.connect.bind(f.client);
  f.client.connect = () => new Promise(resolve => {
    resolveConnect = async () => {
      const info = await origConnect();
      resolve(info);
    };
  });
  btnReconnect.click();
  assert.equal(btnReconnect.disabled, true);
  assert.equal(f.q('#btn-connect').disabled, true);
  await resolveConnect();
  await until(() => f.app.state.connected && f.app.state.status.project_id === 'P');
  assert.equal(btnReconnect.hidden, true);

  // Template mismatch shows #btn-import-matching-template naming the required device template_id
  const btnImportMatching = f.q('#btn-import-matching-template');
  assert.equal(btnImportMatching.hidden, false);
  assert.match(btnImportMatching.textContent, /T/);
  let fileClickCount = 0;
  f.q('#input-template-file').click = () => { fileClickCount += 1; };
  btnImportMatching.click();
  assert.equal(fileClickCount, 1);
  // Cancel without file leaves mismatch intact
  assert.equal(f.app.getRecordControlState().canStart, false);

  // Importing matching template hides #btn-import-matching-template and restores START without clearing project
  const projBefore = f.app.state.status.project_id;
  await f.app.importTemplateObject(template);
  await f.app.selectAction('S01');
  assert.equal(btnImportMatching.hidden, true);
  assert.equal(f.app.state.status.project_id, projBefore);
  assert.equal(f.app.getRecordControlState().canStart, true);
});

test('AC04: single #global-record-strip stays in host, hides on shoot/modal/desktop, and appears on list/records', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('S01');

  const strip = f.q('#global-record-strip');
  const host = f.q('#global-record-host');
  assert.equal(strip.parentElement, host);
  assert.equal(strip.hidden, true);

  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');

  // Mobile shoot view: hidden (primary STOP button is on screen)
  assert.equal(f.root.querySelectorAll('#global-record-strip').length, 1);
  assert.equal(strip.parentElement, host);
  assert.equal(strip.hidden, true);

  // Mobile list & records views: visible in host
  f.q('#nav-btn-list').click();
  assert.equal(strip.parentElement, host);
  assert.equal(strip.hidden, false);

  // Open settings modal: moves single #global-record-strip into open dialog's stop slot
  const modalSettings = f.q('#modal-settings');
  f.app.openDialog(modalSettings);
  assert.equal(f.root.querySelectorAll('#global-record-strip').length, 1);
  assert.equal(strip.parentElement, modalSettings.querySelector('[data-sheet-stop-slot]'));
  assert.equal(modalSettings.contains(strip), true);
  assert.equal(strip.hidden, false);

  // Close settings modal: returns to host on list view
  await f.app.closeDialog(modalSettings, { immediate: true });
  assert.equal(strip.parentElement, host);
  assert.equal(strip.hidden, false);

  // Desktop: hidden when no dialog is open, moves into open modal when recording
  f.resize(1080);
  assert.equal(f.app.state.desktopMode, true);
  assert.equal(strip.parentElement, host);
  assert.equal(strip.hidden, true);

  const modalDetails = f.q('#modal-shoot-details');
  f.app.openDialog(modalDetails);
  assert.equal(f.root.querySelectorAll('#global-record-strip').length, 1);
  assert.equal(modalDetails.contains(strip), true);
  assert.equal(strip.hidden, false);

  // Pending STOP disables #btn-global-stop identically inside state
  await f.app.closeDialog(modalDetails, { immediate: true });
  assert.equal(strip.parentElement, host);
  f.resize(390, 844);
  assert.equal(f.app.state.desktopMode, false);
  assert.equal(strip.hidden, false);
  const stopHold = holdReply(f.client, 'STOP');
  const stopPromise = f.app.stopRecording();
  await stopHold.reached;
  assert.equal(f.q('#btn-global-stop').disabled, true);
  stopHold.release();
  await stopPromise;
  await f.app.closeDialog(modalDetails, { immediate: true });
  assert.equal(strip.parentElement, host);
  assert.equal(strip.hidden, true);
});

test('Stage 2 red-team regressions: stop failure preserves stage, partial respects activeMask, camera cards warn when unconfirmed, disconnect clears pending, non-control errors survive, and file import / dialog switches behave safely', async t => {
  const storage = createMemoryStorage();
  storage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify({ ...template, template_id: 'OTHER_TPL' }));
  const f = await fixture(t, { storage });
  f.client.mockState.template_id = 'T';

  // Input file must sit outside closed modal-settings
  assert.equal(f.q('#input-template-file').closest('#modal-settings'), null);

  // Reconnect error recovery
  const realConnect = f.client.connect.bind(f.client);
  f.client.connect = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  f.q('#btn-reconnect-controller').click();
  await until(() => !f.app.state.connecting);
  assert.equal(f.q('#btn-reconnect-controller').disabled, false);
  assert.equal(f.q('#status-banner').dataset.errorCode, 'NotAllowedError');
  f.client.connect = realConnect;
  f.q('#btn-reconnect-controller').click();
  await until(() => f.app.state.connected && f.app.state.status.project_id === 'P' &&
    f.app.state.status.time_synced && !f.app.state.syncingLog);

  // Bad JSON & invalid template schema via #input-template-file keep mismatch intact and send zero commands
  const cmdsBeforeImport = f.client.mockState.commands.length;
  const fileInput = f.q('#input-template-file');
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [{ text: async () => '{bad json' }],
  });
  fileInput.dispatchEvent(new f.dom.window.Event('change'));
  await until(() => f.q('#status-banner').dataset.errorCode === 'SyntaxError');
  assert.equal(f.q('#btn-import-matching-template').hidden, false);
  assert.equal(f.client.mockState.commands.length, cmdsBeforeImport);

  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [{ text: async () => JSON.stringify({ schema_version: 1, actions: [] }) }],
  });
  fileInput.dispatchEvent(new f.dom.window.Event('change'));
  await until(() => f.q('#status-banner').dataset.errorCode === 'invalid_template');
  assert.equal(f.q('#btn-import-matching-template').hidden, false);
  assert.equal(f.client.mockState.commands.length, cmdsBeforeImport);

  // Import matching template cleanly
  await f.app.importTemplateObject(template);
  await f.app.selectAction('S01');
  await f.app.selectTargetCameras(1); // Only A

  // Non-target B recording during A-only starting must NOT turn stage into partial or clear START_ACK
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'starting',
    active_take_id: 9,
    take_id: 9,
    active_participants: 1,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: false, ready: true },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: true, ready: false },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'starting');
  assert.equal(f.q('#cam-a-badge').dataset.state, 'warn');
  assert.match(f.q('#cam-a-badge-text').textContent, /等待确认/);

  // Stale receipt during starting shows "状态待确认"
  f.advance(6000);
  assert.match(f.q('#record-observation-text').textContent, /状态待确认/);

  // Failed STOP must NOT overwrite safety_stop stage with 'stopping'
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    active_participants: 0,
    target_cameras: 2, // Only B selected while unselected A is still recording
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: true, ready: false },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: false, ready: true },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'safety_stop');
  const origReq = f.client.request.bind(f.client);
  f.client.request = async req => {
    if (req.cmd === 'STOP') throw new Error('stop_failed');
    return origReq(req);
  };
  await f.app.stopRecording();
  assert.equal(f.app.getRecordControlState().stage, 'safety_stop');

  // If STOP ACK succeeds in safety_stop while A is STILL recording, STOP_OK must NOT fire!
  f.client.request = async req => {
    if (req.cmd === 'STOP') return { ok: true, cmd: 'STOP', phase: 'idle', event_seq: f.app.state.status.event_seq };
    return origReq(req);
  };
  await f.app.stopRecording();
  assert.notEqual(f.q('#status-banner').dataset.tone, 'ok');
  assert.equal(f.app.getRecordControlState().stage, 'safety_stop');

  // Preserve non-control error banner when STOP settles via idle + synced TAKE_END
  f.client.request = origReq;
  f.client.mockState.target_cameras = 3;
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    target_cameras: 3,
    phase: 'idle',
    active_take_id: 0,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: false, ready: true },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: false, ready: true },
    ],
  });
  f.advance(1500);
  const startHold = holdReply(f.client, 'START');
  const pStart = f.app.startRecording();
  await startHold.reached;
  // Disconnect mid-START must clear pendingStart cleanly
  f.app.disconnect();
  assert.equal(f.app.getRecordControlState().stopInFlight, false);
  startHold.release();
  await pStart;

  // Dialog switching & Escape cancel & external mode=stop starting while modal already open
  f.client.mockState.phase = 'idle';
  f.client.mockState.active_take_id = 0;
  f.client.mockState.active_participants = 0;
  await connect(f);
  await f.app.selectAction('S01');
  const modalSettings = f.q('#modal-settings');
  const modalAddPoint = f.q('#modal-add-point');
  f.app.openDialog(modalSettings);
  // External recording starts while settings modal is already open
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'recording',
    active_take_id: 1,
    active_participants: 3,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: true, ready: false })),
  });
  const strip = f.q('#global-record-strip');
  const host = f.q('#global-record-host');
  assert.equal(modalSettings.contains(strip), true);
  assert.equal(strip.hidden, false);

  // Switch directly from modal-settings -> modal-add-point while recording active
  f.app.openDialog(modalAddPoint);
  assert.equal(modalAddPoint.contains(strip), true);
  assert.equal(strip.hidden, false);

  // Dismiss modal-add-point via Escape 'cancel' event -> strip returns to host (hidden on shoot, shown on list)
  modalAddPoint.dispatchEvent(new f.dom.window.Event('cancel'));
  await until(() => !modalAddPoint.open);
  assert.equal(strip.parentElement, host);
  assert.equal(strip.hidden, true);
  f.q('#nav-btn-list').click();
  assert.equal(strip.hidden, false);
  f.q('#nav-btn-shoot').click();
  assert.equal(strip.hidden, true);
});

test('AC06: homepage discard, abnormal evidence, take_id>latest guard, single-flight edit lock, and 2-step retake flow', async t => {
  const f = await fixture(t, {
    events: [
      event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3, mono_ms: 1000 }),
      event(2, 'TAKE_END', {
        take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3, complete: true,
        begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 4000,
        cameras: [
          { seen_recording: true, stop_confirmed: true, record_time: 3 },
          { seen_recording: true, stop_confirmed: true, record_time: 3 },
        ],
      }),
      event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'D27', point_id: 'P2', participants: 3, mono_ms: 5000 }),
      event(4, 'TAKE_END', {
        take_id: 2, action_id: 'D27', point_id: 'P2', participants: 3, complete: false,
        begin_boot_id: 'boot-one', begin_mono_ms: 5000, mono_ms: 8000,
        cameras: [
          { seen_recording: true, stop_confirmed: true, record_time: 3 },
          { seen_recording: false, stop_confirmed: false, reason: 'cam_b_not_confirmed' },
        ],
      }),
    ],
  });
  await connect(f);
  await f.app.selectAction('D27', 'P2');

  // Abnormal recent take in #shoot-action-takes-section highlights with expandable per-camera evidence and "标为废片"
  const row2 = f.q('#shoot-action-takes-list [data-take-id="2"]');
  const btnDiscard2 = row2.querySelector('[data-action="shoot-toggle-discard"]');
  assert.equal(row2.dataset.tier, 'abnormal');
  row2.querySelector('.shoot-take-main-btn').click();
  assert.equal(row2.querySelector('.shoot-take-details').hidden, false);
  assert.match(row2.querySelector('.shoot-take-details').textContent, /未确认开始录像/);
  assert.equal(btnDiscard2.textContent, '标为废片');

  // Guard: when controller reports take_id > latest.take_id, shoot shows sync-wait note and disables shoot action edits while records row 1 stays operable
  f.client.emitStatus({ take_id: 3 });
  assert.equal(f.q('#shoot-takes-sync-note').hidden, false);
  assert.match(f.q('#shoot-takes-sync-note').textContent, /#3 记录同步中/);
  assert.equal(btnDiscard2.disabled, true);
  assert.equal(row2.querySelector('[data-action="shoot-open-reassign"]').disabled, true);
  assert.equal(f.q('#recent-takes-list [data-take-id="1"] [data-action="toggle-discard"]').disabled, false);
  f.client.emitStatus({ take_id: 2 });

  // Single-flight edit lock prevents duplicate MARK_DISCARD across shoot and records row (scoped per-row, not whole-list)
  const hold = holdReply(f.client, 'MARK_DISCARD');
  const selectBefore = f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION' || c.cmd === 'START').length;
  btnDiscard2.click();
  await hold.reached;
  assert.equal(btnDiscard2.disabled, true);
  assert.equal(btnDiscard2.textContent, '提交中…');
  assert.equal(row2.dataset.pendingTakeId, '2');
  assert.equal(f.q('[data-take-id="2"] [data-action="toggle-discard"]').disabled, true);
  assert.equal(f.q('[data-take-id="1"] [data-action="toggle-discard"]').disabled, false);
  // Programmatic double invoke must also return null without issuing a 2nd command
  assert.equal(await f.app.markDiscard(2, false), null);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'MARK_DISCARD').length, 1);
  hold.release();
  await until(() => f.app.state.ledger.takes.find(tk => tk.take_id === 2)?.discarded === true && !btnDiscard2.disabled);

  assert.equal(btnDiscard2.textContent, '恢复有效');
  assert.match(row2.textContent, /废片/);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION' || c.cmd === 'START').length, selectBefore);
  assert.equal(f.app.state.status.action_id, 'D27');
  assert.equal(f.app.state.status.point_id, 'P2');
  assert.equal(f.app.state.status.target_cameras, 3);

  // Switch confirmed identity away from take 2 -> #shoot-action-takes-section strictly scopes to confirmed action_id ('S01'), hiding D27's take 2
  await f.app.selectAction('S01', '');
  assert.equal(f.q('#shoot-action-takes-section').hidden, true);
  assert.ok(f.q('#recent-takes-list [data-take-id="2"]'));
  await f.app.markDiscard(2, false);

  // Switch back to D27/P2, discard take 2, then click #btn-record-main directly -> two-step retake with preserved clip seq
  await f.app.selectAction('D27', 'P2');
  f.q('#shoot-action-takes-list [data-take-id="2"] [data-action="shoot-toggle-discard"]').click();
  await until(() => f.app.state.ledger.takes.find(tk => tk.take_id === 2)?.discarded === true && !f.q('#shoot-action-takes-list [data-take-id="2"] [data-action="shoot-toggle-discard"]').disabled);
  f.q('#btn-record-main').click();
  await until(() => f.app.state.status.phase === 'starting' && !f.q('#btn-record-main').disabled);
  f.client.confirmRecording();
  await f.app.stopRecording();
  await f.app.syncCurrentProject('P');
  const take3 = f.app.state.ledger.takes.find(tk => tk.take_id === 3);
  assert.equal(take3.cam_a_clip_seq, 3);
  assert.equal(take3.cam_b_clip_seq, 2);
});

test('AC07: storage failure after edit ACK blocks repeat toggle until sync and isolates new project from in-flight edits', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  const origSet = f.app.storage.setItem.bind(f.app.storage);
  let failWrites = true;
  f.app.storage.setItem = (k, v) => {
    if (failWrites && k.startsWith(ledgerEventKey('P', 1).replace(/1$/, ''))) {
      const e = new Error('disk full');
      e.name = 'QuotaExceededError';
      throw e;
    }
    origSet(k, v);
  };
  await f.app.markDiscard(1, true);
  assert.equal(f.q('#status-banner').dataset.tone, 'error');
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.match(f.q('#status-banner').textContent, /本地存储空间不足/);
  assert.equal(f.app.storage.getItem(ledgerCursorKey('P')), '2');
  assert.equal(f.q('#btn-record-main').disabled, false);
  const row1Shoot = f.q('#shoot-action-takes-list [data-take-id="1"]');
  const shootDiscard = row1Shoot.querySelector('[data-action="shoot-toggle-discard"]');
  const shootReassign = row1Shoot.querySelector('[data-action="shoot-open-reassign"]');
  assert.equal(shootDiscard.disabled, true);
  assert.equal(shootReassign.disabled, true);
  assert.equal(f.q('[data-action="toggle-discard"]').disabled, true);
  assert.equal(await f.app.markDiscard(1, false), null);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'MARK_DISCARD').length, 1);

  failWrites = false;
  await f.app.syncCurrentProject('P');
  assert.equal(f.app.state.ledger.takes[0].discarded, true);
  assert.equal(f.q('#shoot-action-takes-list [data-take-id="1"] [data-action="shoot-toggle-discard"]').disabled, false);

  // Project transition during an in-flight MARK_DISCARD leaves new project P2 clean, independent, and lock-safe
  const hold = holdReply(f.client, 'MARK_DISCARD');
  const pDiscard = f.app.markDiscard(1, false, 'P');
  await hold.reached;
  f.client.mockState.project_id = 'P2';
  f.client.mockState.events = completedTake('P2');
  f.client.emitStatus({ project_id: 'P2', event_seq: 2, take_id: 1 });
  await f.app.syncCurrentProject('P2');
  assert.equal(f.app.state.ledger.project_id, 'P2');
  const p2DiscardBtn = () => f.q('#shoot-action-takes-list [data-take-id="1"] [data-action="shoot-toggle-discard"]');
  assert.equal(p2DiscardBtn().disabled, false);
  // Start a new MARK_DISCARD on P2 while old P request is still unresolved -> old finally must not clear P2's lock
  const holdP2 = holdReply(f.client, 'MARK_DISCARD');
  const p2Discard = f.app.markDiscard(1, true, 'P2');
  await holdP2.reached;
  assert.equal(p2DiscardBtn().disabled, true);
  hold.release();
  await pDiscard;
  assert.equal(p2DiscardBtn().disabled, true);
  holdP2.release();
  await p2Discard;
  assert.equal(f.app.state.ledger.takes[0].discarded, true);
  assert.equal(p2DiscardBtn().disabled, false);
});

test('AC08: searchable #modal-reassign preserves [projectId, takeId] drafts, shows stop strip on external recording, pins takeId, and rejects foreign takes', async t => {
  const f = await fixture(t, {
    events: [
      ...completedTake().map((e, i) => ({ ...e, action_id: 'D27', point_id: 'P1', mono_ms: i ? 5000 : 1000 })),
    ],
  });
  await connect(f);
  await f.app.selectAction('D27', 'P2');

  f.q('#shoot-action-takes-list [data-take-id="1"] .shoot-take-main-btn').click();
  const btnHomeReassign = f.q('#shoot-action-takes-list [data-take-id="1"] [data-action="shoot-open-reassign"]');
  btnHomeReassign.focus();
  btnHomeReassign.click();
  assert.equal(f.q('#view-records').hidden, true);
  const modalReassign = f.q('#modal-reassign');
  assert.equal(modalReassign.open, true);
  assert.match(f.q('#reassign-context-title').textContent, /#1/);

  const searchEl = f.q('#input-reassign-search');
  assert.equal(f.dom.window.document.activeElement, searchEl);
  f.change('#input-reassign-search', 'S01', 'input');
  f.q('[data-reassign-option="S01"]').click();

  // Survives STATUS ticks, 1s timer ticks, and opening/closing another dialog preserves draft
  f.client.emitStatus({ cameras: f.client.mockState.cameras });
  f.advance(1000);
  assert.equal(modalReassign.open, true);
  assert.equal(f.app.state.reassignDrafts.get(JSON.stringify(['P', 1]))?.action_id, 'S01');
  assert.equal(f.app.state.reassignDrafts.get(JSON.stringify(['P', 1]))?.query, 'S01');

  // Closing & reopening from records preserves same [projectId, takeId] draft & search query
  await f.app.closeDialog(modalReassign, { immediate: true });
  f.q('#nav-btn-records').click();
  f.q('#recent-takes-list [data-take-id="1"] [data-action="open-reassign"]').click();
  assert.equal(modalReassign.open, true);
  assert.equal(f.q('#input-reassign-search').value, 'S01');
  assert.equal(f.q('[data-reassign-option="S01"]').classList.contains('is-active'), true);

  // Back to shoot surface preserves draft
  await f.app.closeDialog(modalReassign, { immediate: true });
  f.q('#nav-btn-shoot').click();
  btnHomeReassign.click();
  assert.equal(f.app.state.reassignSurface, 'shoot');
  assert.equal(f.q('#input-reassign-search').value, 'S01');

  // External recording start keeps #modal-reassign & draft open, moves STOP strip into modal slot, and disables confirm
  f.client.emitStatus({
    phase: 'recording',
    active_take_id: 2,
    active_participants: 3,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: true, ready: false })),
  });
  assert.equal(modalReassign.open, true);
  assert.equal(modalReassign.contains(f.q('#global-record-strip')), true);
  assert.equal(f.q('#global-record-strip').hidden, false);
  assert.equal(f.q('#btn-reassign-confirm').disabled, true);
  assert.match(f.q('#reassign-lock-hint').textContent, /录像中暂不能修改/);
  assert.equal(f.app.state.reassignDrafts.get(JSON.stringify(['P', 1]))?.action_id, 'S01');
  f.client.emitStatus({
    phase: 'idle',
    active_take_id: 0,
    active_participants: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: false, ready: true })),
  });
  assert.equal(f.q('#btn-reassign-confirm').disabled, false);

  // Save -> updates take 1 without sending SELECT_ACTION or changing D27/P2, closes modal, and removes take 1 from D27 shoot takes list
  const selectBefore = f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION' || c.cmd === 'START').length;
  f.q('#btn-reassign-confirm').click();
  await until(() =>
    f.app.state.ledger.takes[0].action_id === 'S01' &&
    !modalReassign.open &&
    !f.app.state.syncingLog &&
    !f.q('#recent-takes-list [data-take-id="1"] [data-action="open-reassign"]').disabled
  );
  const reassignCmd = f.client.mockState.commands.filter(c => c.cmd === 'REASSIGN').at(-1);
  assert.deepEqual(reassignCmd, { cmd: 'REASSIGN', project_id: 'P', take_id: 1, action_id: 'S01', point_id: '' });
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION' || c.cmd === 'START').length, selectBefore);
  assert.equal(modalReassign.open, false);
  assert.equal(f.app.state.status.action_id, 'D27');
  assert.equal(f.app.state.status.point_id, 'P2');
  assert.equal(f.q('#shoot-action-takes-section').hidden, true);
  assert.equal(btnHomeReassign.isConnected, false);

  // Cancel closes modal and restores focus cleanly to records opener (expand row 1 first so button is visible/focusable)
  f.q('#nav-btn-records').click();
  f.q('#recent-takes-list [data-take-id="1"] [data-action="toggle-take-expand"]').click();
  const recReassignBtn = f.q('#recent-takes-list [data-take-id="1"] [data-action="open-reassign"]');
  recReassignBtn.focus();
  recReassignBtn.click();
  assert.equal(f.dom.window.document.activeElement, f.q('#input-reassign-search'));
  f.q('#btn-reassign-cancel').click();
  await until(() => !modalReassign.open);
  assert.equal(f.dom.window.document.activeElement, recReassignBtn);

  // REASSIGN rejection leaves take unchanged, keeps modal open, and surfaces error
  recReassignBtn.click();
  f.q('[data-reassign-option="D27"]').click();
  const origReqReassign = f.client.request.bind(f.client);
  f.client.request = async req => req.cmd === 'REASSIGN'
    ? { ok: false, error: 'busy' }
    : origReqReassign(req);
  f.q('#btn-reassign-confirm').click();
  await until(() => f.q('#status-banner').dataset.tone === 'error');
  assert.equal(f.app.state.ledger.takes[0].action_id, 'S01');
  assert.equal(modalReassign.open, true);
  f.q('#btn-reassign-cancel').click();
  await until(() => !modalReassign.open);
  f.client.request = origReqReassign;

  // Pinned takeId stays bound to take 1 even if a newer synced take arrives in records during open edit
  f.q('#nav-btn-records').click();
  f.q('#recent-takes-list [data-take-id="1"] [data-action="open-reassign"]').click();
  f.client.mockState.events.push(
    event(4, 'TAKE_BEGIN', { take_id: 2, action_id: 'D28', point_id: '', participants: 3, mono_ms: 6000 }),
    event(5, 'TAKE_END', { take_id: 2, action_id: 'D28', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 6000, mono_ms: 8000 })
  );
  f.client.mockState.take_id = 2;
  f.client.emitStatus({ take_id: 2, event_seq: 5 });
  await f.app.syncCurrentProject('P');
  assert.equal(f.app.state.editingReassignTakeId, 1);
  assert.equal(modalReassign.open, true);

  // Foreign historical take (take.template_id !== template.template_id) cannot be reassigned even when device template matches
  const fForeign = await fixture(t, {
    events: [
      { ...event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3 }), template_id: 'FOREIGN_TPL' },
      { ...event(2, 'TAKE_END', { take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 3000 }), template_id: 'FOREIGN_TPL' },
    ],
  });
  await connect(fForeign);
  assert.equal(fForeign.q('#shoot-action-takes-section').hidden, true);
  assert.equal(fForeign.q('#recent-takes-list [data-take-id="1"] [data-action="open-reassign"]').disabled, true);
  assert.equal(await fForeign.app.reassignTake(1, 'S01'), null);
});

test('AC10: single-ACK list selection with getDefaultPointId, invalid_select_ack guard, mobile auto-return, desktop stay, and exact-group queue advance', async t => {
  // Desktop stays on workbench; mobile returns to shoot only after valid ACK on green confirm button
  const events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3, mono_ms: 1000 }),
    event(2, 'TAKE_END', {
      take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3, complete: true,
      begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 3000,
    }),
  ];
  // First verify getDefaultPointId picks P1 when no points are complete and target_cameras=1 is preserved
  const fFresh = await fixture(t, { innerWidth: 390, innerHeight: 844 });
  await connect(fFresh);
  await fFresh.app.selectTargetCameras(1);
  assert.equal(fFresh.app.getDefaultPointId(template.actions.find(a => a.action_id === 'D27')), 'P1');
  fFresh.q('#nav-btn-list').click();
  fFresh.q('#action-list [data-action-id="D27"]').click();
  assert.equal(fFresh.q('#view-list').hidden, false);
  fFresh.q('[data-select-confirm="D27"]').click();
  await until(() => !fFresh.app.state.pendingSelect && fFresh.q('#view-shoot').hidden === false);
  assert.equal(fFresh.app.state.status.action_id, 'D27');
  assert.equal(fFresh.app.state.status.point_id, 'P1');
  assert.equal(fFresh.app.state.status.target_cameras, 1);
  // In shoot group queue: next pending item in 一区 is D27 (partially shot), and next-group preview points to 二区 (S27)
  assert.equal(fFresh.q('#btn-next-group-preview').dataset.targetActionId, 'S27');
  fFresh.q('#btn-next-group-preview').click();
  await until(() => !fFresh.app.state.pendingSelect && fFresh.app.state.status.action_id === 'S27');
  assert.equal(fFresh.app.state.status.target_cameras, 1);

  const f = await fixture(t, { events, innerWidth: 390, innerHeight: 844 });
  await connect(f);

  // Switch to list view and tap D27 -> inline preview opens first; only green CTA sends SELECT_ACTION & returns on mobile
  f.q('#nav-btn-list').click();
  assert.equal(f.q('#view-list').hidden, false);
  const hold = holdReply(f.client, 'SELECT_ACTION');
  f.q('#action-list [data-action-id="D27"]').click();
  f.q('[data-select-confirm="D27"]').click();
  await hold.reached;
  assert.equal(f.q('#view-list').hidden, false, 'must wait for ACK before returning on mobile');
  assert.equal(f.app.state.status.action_id, 'S01');
  hold.release();
  await until(() => !f.app.state.pendingSelect && f.q('#view-shoot').hidden === false);
  assert.equal(f.app.state.status.action_id, 'D27');
  assert.equal(f.app.state.status.point_id, 'P2');

  // Unsynced controller event_seq beyond local SELECT_ACTION ACKs still lets explicit group queue rows work, and jumper lists full scope
  f.q('#shoot-group-queue-list [data-queue-action-id="S01"]').click();
  await until(() => !f.app.state.pendingSelect && f.app.state.status.action_id === 'S01');

  // Complete all actions S01, S27, D27/P2, D28 -> 一区 pending queue becomes empty and moves items into completed fold
  let seqCursor = f.client.mockState.events.length + 1;
  let takeCursor = f.client.mockState.take_id + 1;
  for (const [actId, ptId] of [['S01', ''], ['S27', ''], ['D27', 'P2'], ['D28', '']]) {
    f.client.mockState.events.push(
      event(seqCursor++, 'TAKE_BEGIN', { take_id: takeCursor, action_id: actId, point_id: ptId, participants: 3 }),
      event(seqCursor++, 'TAKE_END', { take_id: takeCursor, action_id: actId, point_id: ptId, participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 2000 })
    );
    takeCursor += 1;
  }
  f.client.mockState.take_id = takeCursor - 1;
  f.app.applyStatusSnapshot({ ...f.app.state.status, event_seq: seqCursor - 1, take_id: takeCursor - 1 });
  await f.app.syncCurrentProject('P');
  assert.equal(f.q('#shoot-group-queue-list').hidden, true);
  assert.equal(f.q('#shoot-group-completed-fold').hidden, false);

  // Desktop mode does not switch activeView away from list when clicking green confirm CTA
  f.resize(1280, 800);
  f.q('#nav-btn-list').click();
  f.q('#action-list [data-action-id="S01"]').click();
  f.q('[data-select-confirm="S01"]').click();
  await until(() => !f.app.state.pendingSelect && f.app.state.status.action_id === 'S01');
  assert.equal(f.app.state.activeView, 'list');

  // Mismatched SELECT_ACTION reply across action/point/target/project -> invalid_select_ack and keeps old confirmed selection
  const origReq = f.client.request.bind(f.client);
  for (const badAck of [
    { ok: true, project_id: 'P', action_id: 'WRONG_ACT', point_id: '', target_cameras: 3 },
    { ok: true, project_id: 'P', action_id: 'S27', point_id: 'WRONG_PT', target_cameras: 3 },
    { ok: true, project_id: 'P', action_id: 'S27', point_id: '', target_cameras: 1 },
    { ok: true, project_id: 'WRONG_PROJ', action_id: 'S27', point_id: '', target_cameras: 3 },
  ]) {
    f.client.request = async req => (req.cmd === 'SELECT_ACTION' ? badAck : origReq(req));
    const badRes = await f.app.selectAction('S27', '', 3);
    assert.equal(badRes, null);
    assert.equal(f.app.state.status.action_id, 'S01');
    assert.equal(f.q('#status-banner').dataset.errorCode, 'invalid_select_ack');
  }

  // Stale project change while SELECT_ACTION is pending discards late ACK safely
  f.client.request = origReq;
  const staleHold = holdReply(f.client, 'SELECT_ACTION');
  const pSelect = f.app.selectAction('D27', 'P1');
  await staleHold.reached;
  f.client.mockState.project_id = 'P2';
  f.app.applyStatusSnapshot({ ...f.app.state.status, project_id: 'P2', action_id: 'S27', point_id: '' });
  staleHold.release();
  assert.equal(await pSelect, null);
  assert.equal(f.app.state.status.action_id, 'S27');
});

test('AC05: foreground wakeLock, #btn-screen-awake retry, visibility status/ledger sync, and status audio cues', async t => {
  const cues = [];
  let audioCtxClosed = false;
  class FakeAudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = 'running'; }
    async close() { audioCtxClosed = true; }
    createOscillator() {
      const freqParam = { value: 0, setValueAtTime(v) { this.value = v; } };
      const node = { frequency: freqParam, type: 'sine', connect() {}, start() {}, stop() {}, disconnect() {} };
      cues.push(freqParam);
      return node;
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime(v) { this.value = v; },
          linearRampToValueAtTime(v) { this.value = v; },
          exponentialRampToValueAtTime(v) { this.value = v; },
        },
        connect() {},
        disconnect() {},
      };
    }
  }

  let wakeRequests = 0;
  let shouldFailWake = true;
  let lastSentinel = null;
  const f = await fixture(t, {
    events: completedTake(),
    audioContextClass: FakeAudioContext,
    configureWindow(win) {
      win.navigator.wakeLock = {
        async request() {
          wakeRequests++;
          if (shouldFailWake) throw new Error('denied');
          const listeners = [];
          const sentinel = {
            released: false,
            addEventListener: (ev, cb) => { if (ev === 'release') listeners.push(cb); },
            release: async () => {
              if (!sentinel.released) {
                sentinel.released = true;
                listeners.forEach(cb => cb());
              }
            },
          };
          lastSentinel = sentinel;
          return sentinel;
        },
      };
    },
  });

  // Topbar wakeLock indicator stays short; fallback/manual message shown cleanly without blocking controls
  await connect(f);
  assert.equal(wakeRequests, 1);
  assert.equal(f.q('#btn-screen-awake').dataset.mode, 'manual');
  assert.equal(f.q('#screen-awake-notice').textContent, '请手动常亮');
  // Baseline historical completed take on connect must NOT replay stopped sound
  assert.equal(cues.length, 0);

  // Clicking #btn-screen-awake retries WakeLock inside gesture and switches to system state when granted
  shouldFailWake = false;
  f.q('#btn-screen-awake').click();
  await until(() => wakeRequests === 2 && f.q('#btn-screen-awake').dataset.mode === 'system');
  assert.equal(f.q('#screen-awake-notice').textContent, '常亮中');

  // Visibility hidden->visible while connected refreshes WakeLock AND triggers getStatus + sync
  let statusCalls = 0;
  const origGetStatus = f.client.getStatus.bind(f.client);
  f.client.getStatus = () => { statusCalls++; return origGetStatus(); };
  const syncBefore = f.client.mockState.commands.filter(c => c.cmd === 'GET_LOG').length;
  Object.defineProperty(f.dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  await lastSentinel.release();
  Object.defineProperty(f.dom.window.document, 'visibilityState', { value: 'visible', configurable: true });
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  await until(() =>
    statusCalls >= 1 &&
    f.client.mockState.commands.filter(c => c.cmd === 'GET_LOG').length > syncBefore &&
    wakeRequests >= 3
  );

  // Start recording -> started cue fires once when all targets are confirmed recording
  await f.app.selectAction('S27');
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  assert.equal(cues.length, 2, 'started cue plays 2-tone ascending pattern once');
  assert.deepEqual(cues.slice(0, 2).map(x => x.value), [880, 1320]);

  // Stop recording and settle TAKE_END -> stopped cue plays once on complete settle
  await f.app.stopRecording();
  await until(() => f.app.state.status.phase === 'idle' && cues.length === 4);
  assert.deepEqual(cues.slice(2, 4).map(x => x.value), [660, 440]);

  // Start without confirmation for >= 3s -> fires warning cue once
  const beforeWarn = cues.length;
  f.advance(1500);
  await f.app.startRecording();
  f.advance(3000);
  f.app.updateStatusCues();
  assert.equal(cues.length - beforeWarn, 3, 'warning cue plays 3-tone pattern on 3s unconfirmed timeout');
  assert.deepEqual(cues.slice(beforeWarn).map(x => x.value), [330, 330, 330]);
  // Re-evaluating same condition must not spam warning
  f.app.updateStatusCues();
  assert.equal(cues.length - beforeWarn, 3);
  await f.app.stopRecording();
  await until(() => f.app.state.status.phase === 'idle');

  // Unexpected connection drop while connected plays warning; manual disconnect does not
  const beforeDrop = cues.length;
  f.client.disconnect();
  await until(() => !f.app.state.connected);
  assert.equal(cues.length - beforeDrop, 3);

  await connect(f);
  const beforeManualDrop = cues.length;
  f.app.disconnect();
  await until(() => !f.app.state.connected);
  assert.equal(cues.length - beforeManualDrop, 0);

  // Sound mute toggle persists in storage and silences future cues
  await connect(f);
  f.q('#input-status-sound').checked = false;
  f.q('#input-status-sound').dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(f.app.storage.getItem(SOUND_CACHE_KEY), 'off');
  const mutedCount = cues.length;
  f.app.playStatusCue('started');
  assert.equal(cues.length, mutedCount);

  // Hidden page suppresses cues
  f.q('#input-status-sound').checked = true;
  f.q('#input-status-sound').dispatchEvent(new f.dom.window.Event('change'));
  Object.defineProperty(f.dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  f.app.playStatusCue('started');
  assert.equal(cues.length, mutedCount);

  // Unavailable AudioContext shows honest non-blocking note without failing shoot
  const fNoAudio = await fixture(t, { audioContextClass: null, configureWindow(win) { delete win.AudioContext; delete win.webkitAudioContext; } });
  const prevAudio = globalThis.AudioContext;
  const prevWebkitAudio = globalThis.webkitAudioContext;
  globalThis.AudioContext = undefined;
  globalThis.webkitAudioContext = undefined;
  try {
    fNoAudio.app.playStatusCue('started');
    fNoAudio.app.render();
    assert.equal(fNoAudio.q('#status-sound-note').hidden, false);
    assert.match(fNoAudio.q('#status-sound-note').textContent, /声音不可用，以屏幕状态为准/);
  } finally {
    globalThis.AudioContext = prevAudio;
    globalThis.webkitAudioContext = prevWebkitAudio;
  }

  f.app.destroy();
  assert.equal(audioCtxClosed, true);
});

test('AC12: V4 stage DOM structure, Style 1 camera dock & diag modal, 3B button-embedded timer, and board disclosure filters', async t => {
  const f = await fixture(t);

  // Bottom nav tab order is [看板 · 现场 · 记录]
  const navIds = [...f.root.querySelectorAll('#bottom-view-nav .view-nav-btn')].map(b => b.id);
  assert.deepEqual(navIds, ['nav-btn-list', 'nav-btn-shoot', 'nav-btn-records']);

  // Ready stage separates #shoot-z3-slot, #shoot-middle-scroll (#card-current-action + #shoot-action-takes-section + #shoot-group-queue-section), and #shoot-record-controls
  assert.equal(f.root.querySelector('#search-help-details'), null);
  const readyStage = f.q('#shoot-stage-ready');
  assert.ok(readyStage.contains(f.q('#shoot-z3-slot')));
  assert.ok(readyStage.contains(f.q('#shoot-middle-scroll')));
  assert.ok(f.q('#shoot-middle-scroll').contains(f.q('#card-current-action')));
  assert.ok(f.q('#shoot-middle-scroll').contains(f.q('#shoot-group-queue-section')));
  assert.ok(readyStage.contains(f.q('#shoot-record-controls')));
  assert.ok(f.q('#btn-record-main').contains(f.q('#record-elapsed')));

  // Style 1 camera cards sit inside #shoot-camera-status with toggle & [ⓘ] diagnostics opening #modal-cam-diag
  assert.ok(f.q('#shoot-camera-status').contains(f.q('#btn-cam-toggle-a')));
  assert.ok(f.q('#card-cam-a').contains(f.q('#cam-a-fresh')));
  assert.ok(f.q('#card-cam-a').contains(f.q('#cam-a-battery')));
  f.q('#btn-cam-diag-a').click();
  assert.equal(f.q('#modal-cam-diag').open, true);
  assert.match(f.q('#diag-cam-title').textContent, /相机 A/);
  f.q('#btn-cam-diag-close').click();

  // #cam-a-details and #cam-b-details live inside #modal-settings #device-details (never inside #card-cam-a)
  assert.equal(f.q('#card-cam-a').querySelector('#cam-a-details'), null);
  assert.ok(f.q('#modal-settings #device-details').contains(f.q('#cam-a-details')));
  assert.ok(f.q('#modal-settings #device-details').contains(f.q('#cam-b-details')));

  // Search placeholder and room filter disclosure in #view-list
  assert.equal(f.q('#input-action-search').getAttribute('placeholder'), '搜序号、关键字或层流罩号');
  assert.equal(f.q('#action-region-filter').tagName.toLowerCase(), 'details');
  assert.equal(f.q('#action-region-filter').open, false);
  assert.equal(f.q('#action-region-filter-summary').textContent, '房间：全部 ▾');
  f.q('[data-group-filter="一区"]').click();
  assert.equal(f.q('#action-region-filter-summary').textContent, '房间：一区 ▾');

  // #btn-record-meta tracks confirmed target + action + archive ordinal; Z3 is hidden on healthy ready & recording (3B)
  await connect(f);
  await f.app.selectAction('D27', 'P1', 1);
  assert.equal(f.q('#shoot-z3-slot').hidden, true);
  assert.equal(f.q('#btn-record-meta').hidden, false);
  assert.match(f.q('#btn-record-meta').textContent, /只拍 A 机 · .*动 27.*传递口.*拍本项归档第 1 条/);

  f.client.emitStatus({
    cameras: [
      { ...f.client.mockState.cameras[0], ready: false, video: false },
      { ...f.client.mockState.cameras[1], ready: false, sleeping: true },
    ],
  });
  assert.equal(f.q('#cam-a-badge-text').textContent, '切录像档');
  assert.equal(f.q('#cam-b-badge-text').textContent, '本条不拍');
  assert.equal(f.q('#shoot-z3-slot').hidden, false);
  f.client.emitStatus({
    target_cameras: 2,
    cameras: [
      { ...f.client.mockState.cameras[0], ready: true, video: true, sleeping: false },
      { ...f.client.mockState.cameras[1], ready: false, video: true, sleeping: true },
    ],
  });
  assert.equal(f.q('#cam-b-badge-text').textContent, '休眠中');

  // Recover and start recording -> Z3 hides again, #record-elapsed is visible inside #btn-record-main with data-state='recording', meta shows #N · 本项第 1 条
  f.client.emitStatus({
    target_cameras: 3,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, ready: true, video: true, sleeping: false })),
  });
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording' && f.q('#record-elapsed').dataset.state === 'recording');
  assert.equal(f.q('#shoot-z3-slot').hidden, true);
  assert.equal(f.q('#record-elapsed').hidden, false);
  assert.equal(f.q('#record-elapsed').dataset.state, 'recording');
  assert.match(f.q('#btn-record-meta').textContent, /^#\d+ · 本项第 1 条 · 双机同拍$/);

  // selectionSupported=false must not fabricate target description inside #btn-record-meta
  f.client.emitStatus({
    phase: 'idle',
    active_take_id: 0,
    target_cameras: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: false, ready: true })),
  });
  assert.equal(f.q('#btn-record-meta').hidden, true);
  assert.equal(f.q('#record-elapsed').hidden, true);
});

test('Stage 4 red-team regressions: visibility project switch sync, historical abnormal silence, stopInFlight cue suppression, and active_participants gate', async t => {
  const cues = [];
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    async resume() {}
    async close() {}
    createOscillator() {
      const freqParam = { value: 0, setValueAtTime(v) { this.value = v; } };
      const node = { frequency: freqParam, type: 'sine', connect() {}, start() {}, stop() {}, disconnect() {} };
      cues.push(freqParam);
      return node;
    }
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    }
  }

  // 1. Historical abnormal take on initial connect must NOT replay warning cues
  const histAbnormal = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', command_id: 's1', source: 'ble', participants: 3 }),
    event(2, 'TAKE_END', { take_id: 1, reason: 'cancelled', complete: false, cameras: [{ participating: true, seen_recording: false, stop_confirmed: false }, { participating: true, seen_recording: false, stop_confirmed: false }] }),
  ];
  const f = await fixture(t, { events: histAbnormal, audioContextClass: FakeAudioContext });
  await connect(f);
  assert.equal(cues.length, 0, 'historical incomplete take on connect must not play warning cue');

  // 2. Visibility hidden->visible when device changed boot_id/project_id while hidden STILL syncs new project
  Object.defineProperty(f.dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  f.client.mockState.project_id = 'P_REBOOT';
  f.client.mockState.boot_id = 'boot-two';
  f.client.mockState.events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S27', point_id: '', boot_id: 'boot-two' }, 'P_REBOOT'),
  ];
  f.client.mockState.take_id = 1;
  const syncBefore = f.client.mockState.commands.filter(c => c.cmd === 'GET_LOG' && c.project_id === 'P_REBOOT').length;
  Object.defineProperty(f.dom.window.document, 'visibilityState', { value: 'visible', configurable: true });
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  await until(() =>
    f.client.mockState.commands.some(c => c.cmd === 'GET_LOG' && c.project_id === 'P_REBOOT') &&
    f.app.state.ledger.project_id === 'P_REBOOT' &&
    f.app.state.ledger.takes.length === 1
  );
  assert.ok(
    f.client.mockState.commands.filter(c => c.cmd === 'GET_LOG' && c.project_id === 'P_REBOOT').length > syncBefore
  );
  assert.equal(cues.length, 0, 'switching/syncing project on visibility return stays quiet for old ended takes');

  // 3. Invalid active_participants=0 blocks 'started' chime even if cameras appear recording
  await f.app.selectAction('S01');
  f.client.mockState.cameras = f.client.mockState.cameras.map(c => ({ ...c, recording: true, ready: false }));
  f.client.emitStatus({
    phase: 'recording',
    take_id: 2,
    active_take_id: 2,
    active_participants: 0,
    cameras: f.client.mockState.cameras,
  });
  assert.equal(cues.length, 0, 'invalid active_participants must not play started cue');
  f.client.emitStatus({
    phase: 'idle',
    active_take_id: 0,
    active_participants: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: false, ready: true })),
  });

  // 4. Stop requested while START is still in flight (stopInFlight=true) suppresses started & 3s warning cues
  f.advance(1500);
  const heldStart = holdReply(f.client, 'START');
  const pStart = f.app.startRecording();
  await heldStart.reached;
  const cuesBeforeCancel = cues.length;
  const pStop = f.app.stopRecording(); // sets pendingStart.cancelRequested = true -> stopInFlight = true
  f.advance(3000);
  f.app.updateStatusCues();
  assert.equal(cues.length, cuesBeforeCancel, 'stopInFlight suppresses 3s warning while cancelling start');
  heldStart.release();
  await pStart;
  await pStop;

  // 5. After startedPlayed=true, going stale fires stale_during_active ONLY once (not double start_timeout_3s)
  await f.app.selectAction('S01');
  const beforeRec = cues.length;
  f.advance(1500);
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  assert.equal(cues.length - beforeRec, 2); // started chime
  const beforeStale = cues.length;
  f.advance(6000); // > STALE_STATUS_MS AND > 3s
  f.app.updateStatusCues();
  assert.equal(cues.length - beforeStale, 3, 'exactly one warning burst played on post-start staleness');
});

test('Wave A pure contract: 6 GMP area presets, human formatting, segment_no alignment, local operator acks, 19-col CSV, and room/description search', () => {
  assert.equal(BUILTIN_PRESETS.length, 6);
  assert.deepEqual(
    BUILTIN_PRESETS.map(p => [p.template_id, p.actions.length]),
    [
      ['GMP_SMOKE_AREA1_2026R1', 57],
      ['GMP_SMOKE_AREA2_2026R1', 64],
      ['GMP_SMOKE_AREA3_2026R1', 70],
      ['GMP_SMOKE_POST_UF_2026R1', 6],
      ['GMP_SMOKE_GLOB_UF_2026R1', 4],
      ['GMP_SMOKE_THAW_2026R1', 2],
    ]
  );
  assert.equal(getBuiltinPreset('GMP_SMOKE_CD_2026R1')?.actions.length, 12);
  const globUf = normalizeTemplate(getBuiltinPreset('GMP_SMOKE_GLOB_UF_2026R1'));
  assert.equal(formatHumanAreaName(globUf.actions[0], globUf), '球蛋白超滤灭活区');
  assert.equal(formatHumanSeq(globUf.actions[1]), '静态 第 2 项');
  assert.equal(formatHumanSeq(globUf.actions[1], { compact: true }), '静 02');
  assert.equal(formatRoomAndHood(globUf.actions[1]).display, '2-F30过滤间 · CLZ-03');
  assert.match(suggestDefaultProjectId('GMP_SMOKE_POST_UF_2026R1', createMemoryStorage(), Date.UTC(2026, 10, 17)), /^POST_UF_202611/);

  const area2 = normalizeTemplate(getBuiltinPreset('GMP_SMOKE_AREA2_2026R1'));
  assert.ok(area2.default_criteria.includes('单向流'));
  assert.equal(area2.actions.find(a => a.action_id === 'D09')?.room_key, 'CLZ-13');
  assert.deepEqual(area2.actions.filter(a => matchesActionQuery(a, '蠕动泵')).map(a => a.action_id).includes('D09'), true);
  assert.equal(matchesActionQuery(area2.actions.find(a => a.action_id === 'S11'), '1'), false);
  assert.equal(matchesActionQuery(area2.actions.find(a => a.action_id === 'D09'), '13'), true);
  assert.equal(matchesActionQuery(area2.actions.find(a => a.action_id === 'D09'), 'CLZ-13'), true);
  assert.equal(matchesActionQuery(area2.actions.find(a => a.action_id === 'S01'), '1'), true);

  // segment_no mirrors match_media.py [1, null, 2, 3, 1, 4]
  const ev = (seq, type, extra) => ({
    schema_version: 1, project_id: 'SEG', template_id: area2.template_id,
    event_seq: seq, type, boot_id: 'b1', mono_ms: seq * 1000, ...extra,
  });
  const segEvents = [
    ev(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', participants: 3 }),
    ev(2, 'TAKE_END', { take_id: 1, action_id: 'S01', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 1000, complete: true, reason: 'stopped', cameras: [{ seen_recording: true }, { seen_recording: true }] }),
    ev(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S01', point_id: '', participants: 3 }),
    ev(4, 'TAKE_END', { take_id: 2, action_id: 'S01', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 3000, complete: true, reason: 'stopped', cameras: [{ seen_recording: true }, { seen_recording: true }] }),
    ev(5, 'MARK_DISCARD', { take_id: 2, discard: true }),
    ev(6, 'TAKE_BEGIN', { take_id: 3, action_id: 'S01', point_id: '', participants: 3 }),
    ev(7, 'TAKE_END', { take_id: 3, action_id: 'S01', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 6000, complete: false, reason: 'unexpected_stop', cameras: [{ seen_recording: true }, { seen_recording: false }] }),
    ev(8, 'TAKE_BEGIN', { take_id: 4, action_id: 'S01', point_id: '', participants: 3, source: 'external' }),
    ev(9, 'TAKE_END', { take_id: 4, action_id: 'S01', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 8000, complete: true, reason: 'stopped', cameras: [{ seen_recording: true }, { seen_recording: true }] }),
    ev(10, 'TAKE_BEGIN', { take_id: 5, action_id: 'S01', point_id: '', participants: 3 }),
    ev(11, 'TAKE_END', { take_id: 5, action_id: 'S01', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 10000, complete: true, reason: 'stopped', cameras: [{ seen_recording: true }, { seen_recording: true }] }),
    ev(12, 'REASSIGN', { take_id: 5, action_id: 'D01', point_id: '' }),
    ev(13, 'TAKE_BEGIN', { take_id: 6, action_id: 'S01', point_id: '', participants: 3 }),
    ev(14, 'TAKE_END', { take_id: 6, action_id: 'S01', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 13000, complete: true, reason: 'stopped', cameras: [{ seen_recording: true }, { seen_recording: true }] }),
  ];
  const folded = foldEventsToTakes(segEvents);
  assert.deepEqual(folded.map(t => t.segment_no), [1, null, 2, 3, 1, 4]);

  const storage = createMemoryStorage();
  for (const e of segEvents) storage.setItem(ledgerEventKey('SEG', e.event_seq), JSON.stringify(e));
  storage.setItem(ledgerCursorKey('SEG'), '14');
  // Abnormal item D09 with one abnormal take confirmed via local operator ack -> manual_ok
  const ackStorage = createMemoryStorage();
  const ackEvents = [
    ev(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D09', point_id: '', participants: 3 }),
    ev(2, 'TAKE_END', { take_id: 1, action_id: 'D09', point_id: '', begin_boot_id: 'b1', begin_mono_ms: 1000, complete: false, reason: 'cam_b_stop_timeout', cameras: [{ seen_recording: true }, { seen_recording: true }] }),
  ];
  for (const e of ackEvents) ackStorage.setItem(ledgerEventKey('SEG', e.event_seq), JSON.stringify(e));
  ackStorage.setItem(ledgerCursorKey('SEG'), '2');
  assert.equal(summarizeActionProgress(area2.actions.find(a => a.action_id === 'D09'), area2.template_id, loadProjectLedger(ackStorage, 'SEG').progress).state, 'abnormal');
  setTakeLocallyAcked(ackStorage, 'SEG', 1, true);
  assert.equal(isTakeLocallyAcked(ackStorage, 'SEG', 1), true);
  assert.deepEqual(listLocalOperatorAcks(ackStorage, 'SEG'), [1]);
  const ackLedger = loadProjectLedger(ackStorage, 'SEG');
  const d09Prog = summarizeActionProgress(area2.actions.find(a => a.action_id === 'D09'), area2.template_id, ackLedger.progress);
  assert.equal(d09Prog.state, 'manual_ok');
  assert.equal(d09Prog.localAckCount, 1);

  const csv = exportLedgerCsv(loadProjectLedger(storage, 'SEG'), area2);
  const parseCsvLine = line => line.slice(1, -1).split('","').map(c => c.replace(/""/g, '"'));
  const csvLines = csv.slice(1).split('\r\n');
  const csvHeaders = parseCsvLine(csvLines[0]);
  const row1 = Object.fromEntries(csvHeaders.map((h, i) => [h, parseCsvLine(csvLines[1])[i]]));
  assert.equal(row1.segment_no, '1');
  assert.equal(row1.action_description, area2.actions[0].description);
});

test('Stage 2 adversarial #1: real DjiBleClient + fake GATT QuotaExceededError on seq 2 keeps BLE connected, allows STOP ACK, holds cursor=1, keeps alert, and plays stopped cue', async t => {
  const cues = [];
  class FakeAudioCtx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { type: 'sine', frequency: { setValueAtTime: v => cues.push(v) }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
  }
  const ev1 = event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, mono_ms: 1000 });
  const ev2 = event(2, 'TAKE_END', {
    take_id: 1, action_id: 'S01', point_id: '', begin_boot_id: 'boot-one', begin_mono_ms: 1000,
    complete: true, reason: 'stopped',
    cameras: [{ seen_recording: true, stop_confirmed: true }, { seen_recording: true, stop_confirmed: true }],
  });
  const eventsSnapshot = [ev1, ev2];
  const rawBytes = eventsSnapshot.reduce((s, e) => s + new TextEncoder().encode(JSON.stringify(e)).length + 1, 0);
  const listeners = new Map();
  let curStatus = {
    project_id: 'P', template_id: 'T', action_id: 'S01', point_id: '',
    target_cameras: 3, active_participants: 3, event_seq: 2, take_id: 1, active_take_id: 1,
    phase: 'recording', boot_id: 'boot-one', mono_ms: 5000, writable: true,
    cameras: [
      { connected: true, fresh: true, recording: true, ready: false, led: 2, video: true },
      { connected: true, fresh: true, recording: true, ready: false, led: 2, video: true },
    ],
  };
  const txChar = {
    addEventListener: (n, fn) => { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); },
    removeEventListener: (n, fn) => listeners.get(n)?.delete(fn),
    startNotifications: async () => {},
  };
  const emitTx = (kind, id, payload) => {
    for (const pkt of encodeMessage(kind, id, payload)) {
      const value = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
      for (const fn of listeners.get('characteristicvaluechanged') || []) fn({ target: Object.assign(txChar, { value }) });
    }
  };
  const rxParser = new MessageReassembler();
  const rxChar = {
    writeValueWithResponse: async packet => {
      const msg = rxParser.push(packet);
      if (!msg) return;
      const { requestId: id, data } = msg;
      queueMicrotask(() => {
        if (data.cmd === 'GET_STATUS') {
          emitTx(KINDS.REPLY, id, { ok: true, ...curStatus });
        } else if (data.cmd === 'GET_LOG') {
          const slice = eventsSnapshot.slice(data.after_seq || 0);
          emitTx(KINDS.LOG_BEGIN, id, {
            project_id: 'P', template_id: 'T', event_seq: 2, take_id: 1,
            lines: 2, bytes: rawBytes, after_seq: data.after_seq || 0,
          });
          let sent = 0;
          for (const e of slice) {
            sent += new TextEncoder().encode(JSON.stringify(e)).length + 1;
            emitTx(KINDS.LOG_EVENT, id, e);
          }
          emitTx(KINDS.LOG_END, id, { ok: true, project_id: 'P', event_seq: 2, through_seq: 2, sent_lines: slice.length, sent_bytes: sent });
        } else if (data.cmd === 'STOP') {
          curStatus = {
            ...curStatus, phase: 'idle', active_take_id: 0, active_participants: 0,
            cameras: curStatus.cameras.map(c => ({ ...c, recording: false, ready: true, led: 1 })),
          };
          emitTx(KINDS.REPLY, id, { ok: true, phase: 'idle', take_id: 1, active_participants: 3, event_seq: 2 });
          emitTx(KINDS.STATUS, 0, curStatus);
        } else {
          emitTx(KINDS.REPLY, id, { ok: true });
        }
      });
    },
  };
  const infoChar = {
    readValue: async () => new TextEncoder().encode(JSON.stringify({
      protocol: 1, header_bytes: 8, max_command_bytes: 767, max_message_bytes: 4096, default_packet_bytes: 20,
    })),
  };
  const fakeDevice = {
    id: 'real-ble-dev',
    addEventListener() {}, removeEventListener() {},
    gatt: {
      connected: true,
      connect: async () => fakeDevice.gatt,
      disconnect: () => { fakeDevice.gatt.connected = false; },
      getPrimaryService: async () => ({
        getCharacteristic: async uuid => uuid.endsWith('1001-7fbe-4dbf-9f6a-307ca69c6bc5') ? rxChar
          : uuid.endsWith('1002-7fbe-4dbf-9f6a-307ca69c6bc5') ? txChar : infoChar,
      }),
    },
  };
  const bleClient = new DjiBleClient({ bluetooth: { requestDevice: async () => fakeDevice } });
  const storage = createMemoryStorage();
  const origSet = storage.setItem.bind(storage);
  storage.setItem = (k, v) => {
    if (k === ledgerEventKey('P', 2)) {
      const err = new Error('quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    }
    origSet(k, v);
  };
  const f = await fixture(t, { client: bleClient, storage, audioContextClass: FakeAudioCtx });
  f.q('#btn-connect').click();
  await until(() => f.app.state.connected && !f.app.state.syncingLog && f.app.state.ledgerSyncError?.code === 'QuotaExceededError', 'real BLE QuotaExceededError sync');
  assert.equal(bleClient.connected, true, 'BLE must stay connected when seq=2 triggers QuotaExceededError');
  assert.equal(storage.getItem(ledgerCursorKey('P')), '1');
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.equal(f.q('#status-banner').hidden, false);

  const cuesBeforeStop = cues.length;
  const stopReply = await f.app.stopRecording();
  assert.equal(stopReply?.ok, true);
  assert.equal(bleClient.connected, true);
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.equal(f.q('#status-banner').hidden, false);
  await until(() => cues.length - cuesBeforeStop === 2);
  assert.deepEqual(cues.slice(cuesBeforeStop), [660, 440], 'stopped chime plays even when local storage is full');
});

test('Stage 2 adversarial #3, #4, #6, #7, #8, #9 + >10s camera shutter copy', async t => {
  const cues = [];
  class FakeAudioCtx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { type: 'sine', frequency: { setValueAtTime: v => cues.push(v) }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; }
  }
  const f = await fixture(t, { audioContextClass: FakeAudioCtx });
  await connect(f);
  await f.app.selectAction('S01');

  // #8: 1.5s cooldown blocks double-tap START (0 BLE commands) until advance(1500)
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');

  // #3: recording command whitelist rejects non-STOP mutations at service layer with 0 BLE sends
  const cmdsBeforeWhitelist = f.client.mockState.commands.length;
  assert.equal(await f.app.initProject('NEW_PROJ', 'T'), null);
  assert.equal(await f.app.selectAction('S27'), null);
  assert.equal(await f.app.markDiscard(1, true), null);
  assert.equal(await f.app.reassignTake(1, 'S27'), null);
  assert.equal(f.client.mockState.commands.length, cmdsBeforeWhitelist);

  // #4: dialog closing animation immediately returns #global-record-strip to host BEFORE animation finishes
  const modalSettings = f.q('#modal-settings');
  const strip = f.q('#global-record-strip');
  const host = f.q('#global-record-host');
  let animFinish;
  modalSettings.animate = () => ({ finished: new Promise(r => { animFinish = r; }), cancel() {} });
  f.app.openDialog(modalSettings);
  assert.equal(modalSettings.contains(strip), true);
  assert.equal(strip.hidden, false);
  f.q('#nav-btn-list').click();
  const closing = f.app.closeDialog(modalSettings);
  assert.equal(strip.parentElement, host, 'strip leaves closing modal immediately before animation ends');
  assert.equal(strip.hidden, false);
  animFinish();
  await closing;
  f.q('#nav-btn-shoot').click();

  // >10s stop_pending displays camera screen/shutter guidance with zero BOOT mention
  const holdStop = holdReply(f.client, 'STOP');
  const pStop = f.app.stopRecording();
  await holdStop.reached;
  f.advance(10500);
  assert.match(f.q('#record-observation-text').textContent, /按相机机身快门键停止/);
  assert.doesNotMatch(f.q('#record-observation-text').textContent, /BOOT/i);
  holdStop.release();
  await pStop;
  await until(() => f.app.state.status.phase === 'idle');
  // Controller pushes fresh idle status upon stop completion
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'idle',
    active_take_id: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, connected: true, fresh: true, recording: false, ready: true })),
  });

  const startsBeforeCooldown = f.client.mockState.commands.filter(c => c.cmd === 'START').length;
  assert.equal(f.app.getRecordControlState().stage, 'settled_cooldown');
  assert.equal(await f.app.startRecording(), null);
  assert.equal(await f.app.startRecording(), null);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'START').length, startsBeforeCooldown);
  f.advance(1500);
  assert.equal(f.app.getRecordControlState().stage, 'ready');

  // #7: partial going stale NEVER promotes to recording_stale or recording
  await f.app.startRecording();
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'recording',
    active_take_id: f.app.state.status.take_id,
    active_participants: 3,
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, recording: true, ready: false },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, recording: false, ready: true },
    ],
  });
  assert.equal(f.app.getRecordControlState().stage, 'partial');
  f.advance(4000);
  assert.notEqual(f.app.getRecordControlState().stage, 'recording_stale');
  assert.equal(f.app.getRecordControlState().stage, 'starting');
  await f.app.stopRecording();
  await until(() => f.app.state.status.phase === 'idle');
  f.advance(1500);

  // #6: fresh full recording -> recording_stale -> recording warns once and does not replay started chime
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');
  const cuesAtRec = cues.length;
  f.advance(4000);
  assert.equal(f.app.getRecordControlState().stage, 'recording_stale');
  f.app.applyStatusSnapshot({
    ...f.app.state.status,
    phase: 'recording',
    active_take_id: f.app.state.status.take_id,
    active_participants: 3,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, connected: true, fresh: true, recording: true, ready: false })),
  });
  // Resume recording: only warning burst happened at stale, NO replay of [880, 1320] started chime
  assert.deepEqual(cues.slice(cuesAtRec), [330, 330, 330]);
  await f.app.stopRecording();
  await until(() => f.app.state.status.phase === 'idle');
  f.advance(1500);

  // #9: edit lock blocks START only while waiting for MARK_DISCARD ACK, NOT during post-ACK sync
  const holdDiscard = holdReply(f.client, 'MARK_DISCARD');
  const discardP = f.app.markDiscard(1, true);
  await holdDiscard.reached;
  assert.equal(f.app.getRecordControlState().stage, 'blocked');
  assert.equal(await f.app.startRecording(), null);
  const origSyncLog = f.client.syncLog.bind(f.client);
  const syncGate = deferred();
  const syncReached = deferred();
  f.client.syncLog = async (after, proj, cb) => {
    syncReached.resolve();
    await syncGate.promise;
    return origSyncLog(after, proj, cb);
  };
  holdDiscard.release();
  await syncReached.promise;
  assert.equal(f.app.getRecordControlState().stage, 'ready', 'START unblocks immediately once MARK_DISCARD ACK received');
  assert.equal(f.q('#btn-record-main').disabled, false);
  syncGate.resolve();
  await discardP;
});

test('V2 adversarial #5/#11/#12/#13/#14: DOM stability, project reuse & demo warning, empty-action lock, pendingInit single-flight, and sw.js precache check', async t => {
  // #5: 10 consecutive render() + renderStalenessTick() cycles keep main & global STOP button identity and focus
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('S01');
  await f.app.startRecording();
  f.client.confirmRecording();
  await until(() => f.app.state.status.phase === 'recording');

  const btnMain = f.q('#btn-record-main');
  const mainParent = btnMain.parentElement;
  btnMain.focus();
  for (let i = 0; i < 10; i++) {
    f.advance(200);
    f.client.emitStatus();
    f.app.render();
    assert.equal(f.q('#btn-record-main'), btnMain);
    assert.equal(btnMain.parentElement, mainParent);
    assert.equal(f.dom.window.document.activeElement, btnMain);
  }
  // Switch to list view -> #global-record-strip stays stable across ticks too
  f.q('#nav-btn-list').click();
  const btnGlobalStop = f.q('#btn-global-stop');
  const stopParent = btnGlobalStop.parentElement;
  btnGlobalStop.focus();
  for (let i = 0; i < 10; i++) {
    f.advance(200);
    f.client.emitStatus();
    f.app.render();
    assert.equal(f.q('#btn-global-stop'), btnGlobalStop);
    assert.equal(btnGlobalStop.parentElement, stopParent);
    assert.equal(f.dom.window.document.activeElement, btnGlobalStop);
  }
  await f.app.stopRecording();
  await until(() => f.app.state.status.phase === 'idle');
  f.advance(1500);

  // #11: Project ID reuse block + demo template warning
  f.app.storage.setItem(ledgerCursorKey('OLD_PROJ'), '1');
  const fInit = await fixture(t, { storage: f.app.storage });
  fInit.client.mockState.project_id = '';
  fInit.client.mockState.take_id = 0;
  fInit.client.mockState.action_id = '';
  await connect(fInit);
  const initBefore = fInit.client.mockState.commands.filter(c => c.cmd === 'INIT_PROJECT').length;
  const reused = await fInit.app.initProject('OLD_PROJ', 'T');
  assert.equal(reused, null);
  assert.equal(fInit.client.mockState.commands.filter(c => c.cmd === 'INIT_PROJECT').length, initBefore);
  assert.equal(fInit.q('#status-banner').dataset.errorCode, 'project_id_exists_locally');

  // Demo warning shows on CLEANROOM_SMOKE_V1 and hides on GMP_SMOKE_AREA1_2026R1
  fInit.app.importTemplateObject({
    schema_version: 1,
    template_id: 'CLEANROOM_SMOKE_V1',
    template_name: '示例清单',
    actions: [{ action_id: 'S01', name: '示例', type: 'static', group: '一区', order: 1 }],
  });
  assert.equal(fInit.q('#demo-template-warning').hidden, false);
  const area1 = getBuiltinPreset('GMP_SMOKE_AREA1_2026R1');
  assert.ok(area1);
  fInit.app.importTemplateObject(area1);
  assert.equal(fInit.q('#demo-template-warning').hidden, true);

  // #13: pendingInit single-flight lock prevents duplicate INIT_PROJECT and disables S2 preset/input controls
  const holdInit = holdReply(fInit.client, 'INIT_PROJECT');
  fInit.change('#input-init-project-id', 'FRESH_GMP_01', 'input');
  fInit.q('#btn-init-project').click();
  await until(() => fInit.app.state.pendingInit === true);
  assert.equal(fInit.q('#btn-init-project').disabled, true);
  assert.equal(fInit.q('#btn-init-import-json').disabled, true);
  assert.equal(fInit.q('#input-init-project-id').disabled, true);
  assert.equal(fInit.q('[data-preset-id="GMP_SMOKE_AREA1_2026R1"]').disabled, true);
  assert.equal(await fInit.app.initProject('ANOTHER_02', area1.template_id), null);
  holdInit.release();
  await until(() => fInit.app.state.pendingInit === false && fInit.app.state.status.project_id === 'FRESH_GMP_01');
  assert.equal(fInit.client.mockState.commands.filter(c => c.cmd === 'INIT_PROJECT').length, initBefore + 1);

  // #12: Option 1A lands initialized empty-action project on 'list' (看板); switching to 'shoot' disables Style 1 camera toggles and shows first-action CTA
  assert.equal(fInit.app.state.status.action_id, '');
  assert.equal(fInit.app.state.activeView, 'list');
  fInit.q('#nav-btn-shoot').click();
  assert.equal(fInit.q('#shoot-stage-ready').hidden, false);
  assert.equal(fInit.q('#btn-cam-toggle-a').disabled, true);
  assert.equal(fInit.q('#btn-cam-toggle-b').disabled, true);
  assert.equal(fInit.q('#cam-a-badge-text').textContent, '未选拍摄项');
  assert.equal(fInit.q('#unselected-action-cta').hidden, false);
  fInit.q('#unselected-action-cta').click();
  await until(() => !fInit.app.state.pendingSelect && fInit.app.state.status.action_id === 'S01');
  assert.equal(fInit.q('#unselected-action-cta').hidden, true);
  assert.equal(fInit.q('#btn-cam-toggle-a').disabled, false);

  // #14: phone/sw.js PRECACHE_URLS cache v16, self-contained inside phone/, includes core/* & views/*, every entry resolves on disk
  const swText = fs.readFileSync(path.resolve('phone/sw.js'), 'utf8');
  assert.match(swText, /CACHE_NAME\s*=\s*['"]dji-field-ui-v16['"]/);
  const blockMatch = swText.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(blockMatch, 'PRECACHE_URLS array must exist in phone/sw.js');
  const precacheEntries = [...blockMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(precacheEntries.includes('./core/shell-template.mjs'));
  assert.ok(precacheEntries.includes('./views/shoot-view.mjs'));
  assert.ok(precacheEntries.includes('./presets.mjs'));
  assert.ok(precacheEntries.includes('./presets/GMP_SMOKE_AREA1_2026R1.mjs'));
  assert.ok(precacheEntries.includes('./presets/GMP_SMOKE_POST_UF_2026R1.mjs'));
  assert.ok(precacheEntries.includes('./presets/GMP_SMOKE_GLOB_UF_2026R1.mjs'));
  assert.ok(precacheEntries.includes('./presets/GMP_SMOKE_THAW_2026R1.mjs'));
  for (const rel of precacheEntries) {
    assert.doesNotMatch(rel, /\.\.\//, `PRECACHE_URLS must stay self-contained inside phone/: ${rel}`);
    const resolved = rel === './' ? path.resolve('phone/index.html') : path.resolve('phone', rel);
    assert.equal(fs.existsSync(resolved), true, `Missing precache target on disk: ${rel}`);
  }
});

test('V4 Step 6a: same-group same-name diff extraction differentiates all AREA1/AREA2/AREA3 duplicate items cleanly', async t => {
  for (const presetId of ['GMP_SMOKE_AREA1_2026R1', 'GMP_SMOKE_AREA2_2026R1', 'GMP_SMOKE_AREA3_2026R1']) {
    const preset = getBuiltinPreset(presetId);
    assert.ok(preset, `Preset ${presetId} must exist`);
    const byGroupAndName = new Map();
    for (const act of preset.actions) {
      const k = `${act.group}|||${act.name}`;
      if (!byGroupAndName.has(k)) byGroupAndName.set(k, []);
      byGroupAndName.get(k).push(act);
    }
    let dupPairs = 0;
    for (const items of byGroupAndName.values()) {
      if (items.length < 2) continue;
      dupPairs += 1;
      const peers = preset.actions.filter(a => a.group === items[0].group);
      const snippets = items.map(it => computeActionDiffSnippet(it, peers));
      assert.equal(new Set(snippets).size, items.length, `Snippets must stay distinct in ${presetId} (${items[0].name})`);
      for (const s of snippets) {
        assert.ok(s && s.length > 0);
        assert.doesNotMatch(s, /^[…]*[，,、；;：:]/, `Diff snippet must trim leading separator punctuation: ${s}`);
      }
    }
    assert.ok(dupPairs > 0, `${presetId} should exercise duplicate pairs`);
  }

  // Verify live queue DOM highlights "差异：..." for duplicate pairs inside AREA1 CLZ-09-2-J10
  const area1 = getBuiltinPreset('GMP_SMOKE_AREA1_2026R1');
  const dupTarget = area1.actions.find(a => a.group === '灌装间（CLZ-09-2-J10）' &&
    area1.actions.filter(p => p.group === a.group && p.name === a.name).length >= 2);
  assert.ok(dupTarget);
  const clientArea1 = createMockBleClient({
    projectId: 'AREA1_PROJ',
    templateId: area1.template_id,
    ackDelayMs: 0,
    autoConfirmRecordingMs: 0,
  });
  const f = await fixture(t, { client: clientArea1 });
  f.app.importTemplateObject(area1);
  await connect(f);
  await f.app.selectAction(dupTarget.action_id);
  const queueDesc = f.q(`#shoot-group-queue-list [data-queue-action-id="${dupTarget.action_id}"] .group-queue-desc`);
  assert.equal(queueDesc.classList.contains('is-diff'), true);
  assert.match(queueDesc.textContent, /^差异：/);
});

test('V4 Step 6b: exact group denominator isolates CLZ-09-2-J10 (27) from room_key=CLZ-09 (32), omits relatedGroups on 房间孔洞, and applies 1A smart landing', async () => {
  const area1 = getBuiltinPreset('GMP_SMOKE_AREA1_2026R1');
  const j10Item = area1.actions.find(a => a.group === '灌装间（CLZ-09-2-J10）');
  const holesItem = area1.actions.find(a => a.room_key === '房间孔洞');
  assert.ok(j10Item);
  assert.ok(holesItem);

  const qJ10 = summarizeGroupQueue(area1, j10Item, new Map(), area1.template_id);
  assert.equal(qJ10.exactGroup, '灌装间（CLZ-09-2-J10）');
  assert.equal(qJ10.totalCount, 27);
  assert.equal(qJ10.relatedGroups.length > 0, true);
  const relatedSum = qJ10.relatedGroups.reduce((s, r) => s + r.totalCount, 0);
  assert.equal(qJ10.totalCount + relatedSum, 32);

  const qHoles = summarizeGroupQueue(area1, holesItem, new Map(), area1.template_id);
  assert.equal(qHoles.relatedGroups.length, 0);

  // Option 1A: existing action_id mock preset lands directly on 'shoot'; empty action_id lands on 'list'
  assert.notEqual(area1.actions[0].action_id, '');
});

test('V4 Step 6b2: Option 1A smart landing routes no-action initialized project to list and active recording / existing action to shoot', async t => {
  const area1 = getBuiltinPreset('GMP_SMOKE_AREA1_2026R1');
  const clientNoAction = createMockBleClient({
    projectId: 'PROJ_EMPTY_ACT',
    templateId: area1.template_id,
    ackDelayMs: 0,
    autoConfirmRecordingMs: 0,
  });
  clientNoAction.mockState.action_id = '';
  clientNoAction.mockState.point_id = '';
  const f1 = await fixture(t, { client: clientNoAction });
  f1.app.importTemplateObject(area1);
  await connect(f1);
  assert.equal(f1.app.state.activeView, 'list');

  const clientWithAction = createMockBleClient({
    projectId: 'PROJ_WITH_ACT',
    templateId: area1.template_id,
    ackDelayMs: 0,
    autoConfirmRecordingMs: 0,
  });
  clientWithAction.mockState.action_id = area1.actions[0].action_id;
  const f2 = await fixture(t, { client: clientWithAction });
  f2.app.importTemplateObject(area1);
  await connect(f2);
  assert.equal(f2.app.state.activeView, 'shoot');
});

test('V4 Step 6c: 3.5s staleness boundary (3500ms vs 3501ms), 3B button-embedded elapsed timer, and Z3 hidden during healthy states', async t => {
  const f = await fixture(t);
  await connect(f);
  assert.equal(f.q('#shoot-z3-slot').hidden, true);
  await f.app.startRecording();
  f.client.confirmRecording();
  await f.app.syncCurrentProject('P');
  f.advance(1000);
  assert.equal(f.app.getRecordControlState().stage, 'recording');
  assert.equal(f.q('#shoot-z3-slot').hidden, true);
  assert.equal(f.q('#record-elapsed').hidden, false);
  assert.ok(f.q('#btn-record-main').contains(f.q('#record-elapsed')));

  // Advance to exactly 3500ms since last status -> still fresh ('recording')
  f.advance(2500);
  assert.equal(f.app.getRecordControlState().stage, 'recording');
  assert.equal(f.q('#shoot-z3-slot').hidden, true);

  // At 3501ms -> transitions cleanly to 'recording_stale', reveals Z3 without wiping middle scroll cards
  f.advance(1);
  assert.equal(f.app.getRecordControlState().stage, 'recording_stale');
  assert.equal(f.q('#shoot-z3-slot').hidden, false);
  assert.equal(f.q('#card-current-action').hidden, false);
  assert.equal(f.q('#shoot-group-queue-section').hidden, false);
  assert.equal(f.q('#record-elapsed').dataset.state, 'stale');
});

test('V4 Step 6d: observation_lost renders amber warning (never pure green) and manual 确认有效 counts toward progress', async t => {
  const events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, mono_ms: 1000 }),
    event(2, 'TAKE_END', {
      take_id: 1, action_id: 'S01', point_id: '', participants: 3, complete: true,
      observation_lost: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 4000,
      cameras: [
        { seen_recording: true, stop_confirmed: true, record_time: 3 },
        { seen_recording: true, stop_confirmed: true, record_time: 3 },
      ],
    }),
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S27', point_id: '', participants: 3, mono_ms: 5000 }),
    event(4, 'TAKE_END', {
      take_id: 2, action_id: 'S27', point_id: '', participants: 3, complete: false,
      observation_lost: false, begin_boot_id: 'boot-one', begin_mono_ms: 5000, mono_ms: 8000,
      cameras: [
        { seen_recording: true, stop_confirmed: true, record_time: 3 },
        { seen_recording: false, stop_confirmed: false },
      ],
    }),
  ];
  const f = await fixture(t, { events });
  await connect(f);

  // S01 has complete=true & observation_lost=true -> amber '⚠ 相机信号曾闪断' in shoot & records, never pure green ready pill
  const shootTake1 = f.q('#shoot-action-takes-list [data-take-id="1"]');
  const shootPill1 = shootTake1.querySelector('.status-pill');
  assert.equal(shootTake1.dataset.tier, 'obs_lost');
  assert.equal(shootPill1.dataset.tone, 'warn');
  assert.match(shootPill1.textContent, /相机信号曾闪断/);

  const recPill1 = f.q('#recent-takes-list [data-take-id="1"] .status-pill');
  assert.equal(recPill1.dataset.tone, 'warn');
  assert.match(recPill1.textContent, /相机信号曾闪断/);

  // S27 is abnormal before confirmation -> click '确认有效' on records -> turns cyan '已确认有效' and counts as manual_ok in progress
  const s27Before = summarizeActionProgress(
    f.app.state.template.actions.find(a => a.action_id === 'S27'),
    'T',
    f.app.state.ledger.progress
  );
  assert.equal(s27Before.state, 'abnormal');
  f.q('#nav-btn-records').click();
  f.q('#recent-takes-list [data-take-id="2"] [data-action="toggle-local-ack"]').click();
  assert.equal(f.q('#recent-takes-list [data-take-id="2"] .status-pill').dataset.tone, 'acked');
  assert.match(f.q('#recent-takes-list [data-take-id="2"] .status-pill').textContent, /已确认有效/);
  const s27After = summarizeActionProgress(
    f.app.state.template.actions.find(a => a.action_id === 'S27'),
    'T',
    f.app.state.ledger.progress
  );
  assert.equal(s27After.state, 'manual_ok');
  assert.match(f.q('#kpi-board-done').textContent, /2 \/ 4/);
  assert.match(f.q('#kpi-board-abnormal').textContent, /异常 0 项/);
});

test('V4 Step 6e: records multi-select batch discard/restore/reassign and row-scoped sync_pending without locking sibling rows', async t => {
  const events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, mono_ms: 1000 }),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 4000 }),
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S27', point_id: '', participants: 3, mono_ms: 5000 }),
    event(4, 'TAKE_END', { take_id: 2, action_id: 'S27', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 5000, mono_ms: 8000 }),
    event(5, 'TAKE_BEGIN', { take_id: 3, action_id: 'D28', point_id: '', participants: 3, mono_ms: 9000 }),
    event(6, 'TAKE_END', { take_id: 3, action_id: 'D28', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 9000, mono_ms: 12000 }),
  ];
  const f = await fixture(t, { events });
  await connect(f);
  f.q('#nav-btn-records').click();

  // Hold MARK_DISCARD on take 1 to verify per-row pending outline only locks take 1 while take 3 remains operable
  const holdDiscard = holdReply(f.client, 'MARK_DISCARD');
  f.q('#recent-takes-list [data-take-id="1"] [data-action="toggle-discard"]').click();
  await holdDiscard.reached;
  assert.equal(f.q('#recent-takes-list [data-take-id="1"]').dataset.pendingTakeId, '1');
  assert.equal(f.q('#recent-takes-list [data-take-id="3"]').dataset.pendingTakeId, undefined);
  assert.equal(f.q('#recent-takes-list [data-take-id="3"] [data-action="toggle-discard"]').disabled, false);
  holdDiscard.release();
  await until(() => f.app.state.ledger.takes.find(tk => tk.take_id === 1)?.discarded === true);

  // Select take 2 & take 3 (valid takes) -> sticky batch bar reads "标为废片 (2)" and "修改拍摄项 (2)"
  for (const id of [2, 3]) {
    const cb = f.q(`#recent-takes-list [data-take-select="${id}"]`);
    cb.checked = true;
    cb.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  }
  assert.equal(f.q('#records-batch-count').textContent, '已选 2 条');
  assert.equal(f.q('#btn-batch-discard-toggle').textContent, '标为废片 (2)');
  assert.equal(f.q('#btn-batch-reassign').textContent, '修改拍摄项 (2)');

  // Batch discard both takes 2 and 3
  f.q('#btn-batch-discard-toggle').click();
  await until(() =>
    f.app.state.ledger.takes.find(tk => tk.take_id === 2)?.discarded === true &&
    f.app.state.ledger.takes.find(tk => tk.take_id === 3)?.discarded === true &&
    f.app.state.selectedRecordTakeIds.size === 0
  );

  // Select discarded takes 2 & 3 -> batch bar flips to "恢复有效 (2)"
  for (const id of [2, 3]) {
    const cb = f.q(`#recent-takes-list [data-take-select="${id}"]`);
    cb.checked = true;
    cb.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  }
  assert.equal(f.q('#btn-batch-discard-toggle').textContent, '恢复有效 (2)');
  f.q('#btn-batch-discard-toggle').click();
  await until(() =>
    f.app.state.ledger.takes.find(tk => tk.take_id === 2)?.discarded === false &&
    f.app.state.ledger.takes.find(tk => tk.take_id === 3)?.discarded === false &&
    f.app.state.selectedRecordTakeIds.size === 0 &&
    f.q('#btn-batch-discard-toggle').textContent === '请先勾选记录'
  );

  // Batch reassign takes 2 & 3 to S01
  for (const id of [2, 3]) {
    const cb = f.q(`#recent-takes-list [data-take-select="${id}"]`);
    cb.checked = true;
    cb.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  }
  await until(() => !f.q('#btn-batch-reassign').disabled);
  f.q('#btn-batch-reassign').click();
  assert.equal(f.q('#modal-reassign').open, true);
  assert.match(f.q('#reassign-context-title').textContent, /批量修改拍摄项（已选 2 条/);
  f.q('[data-reassign-option="S01"]').click();
  f.q('#btn-reassign-confirm').click();
  await until(() =>
    f.app.state.ledger.takes.find(tk => tk.take_id === 2)?.action_id === 'S01' &&
    f.app.state.ledger.takes.find(tk => tk.take_id === 3)?.action_id === 'S01'
  );
  assert.equal(f.q('#modal-reassign').open, false);
});

test('V4 Step 6f: multi-point local ack progress accuracy, unended take honest count/lock, empty search hints, and Z3 failed reconnect preservation', async t => {
  // 1. Multi-point action D27 (P1 + P2): confirming P1 abnormal must stay partial (1/2) until P2 is also covered
  const events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3, mono_ms: 1000 }),
    event(2, 'TAKE_END', {
      take_id: 1, action_id: 'D27', point_id: 'P1', participants: 3, complete: false,
      observation_lost: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 4000,
    }),
    // Take 2 on S01 is unended (!ended)
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S01', point_id: '', participants: 3, mono_ms: 5000 }),
  ];
  const f = await fixture(t, { events });
  await connect(f);
  await f.app.selectAction('D27', 'P1');

  // Unended take 2 on S01 is NOT counted as valid in shoot-takes-heading when S01 is selected, and discard is disabled in records
  assert.equal(f.q('#recent-takes-list [data-take-id="2"] [data-action="toggle-discard"]').disabled, true);
  await f.app.selectAction('S01', '');
  assert.equal(f.q('#shoot-takes-heading').textContent, '本项已拍记录（共 1 条 · 有效 0）');

  // Confirm take 1 (D27 P1) valid -> D27 stays 'partial' (1/2 coveredPoints), default point advances to P2, point modal marks P1 as manual_ok
  await f.app.selectAction('D27', 'P1');
  f.q('#shoot-action-takes-list [data-take-id="1"] [data-action="shoot-toggle-local-ack"]').click();
  const d27Act = f.app.state.template.actions.find(a => a.action_id === 'D27');
  const d27Partial = summarizeActionProgress(d27Act, 'T', f.app.state.ledger.progress);
  assert.equal(d27Partial.state, 'partial');
  assert.equal(d27Partial.coveredPoints, 1);
  assert.equal(f.q('#point-pills [data-point-id="P1"] .point-progress-mark').dataset.shot, 'manual_ok');
  assert.equal(f.q('[data-action-id="D27"] .action-row-status-inline').textContent, '1/2 点位');
  await f.app.selectAction('S01', '');
  assert.equal(f.app.getDefaultPointId(d27Act), 'P2');

  // Empty point-filter takes & empty jumper search display explicit hints rather than blank voids
  await f.app.selectAction('D27', 'P2');
  f.q('#btn-takes-filter-point').click();
  assert.match(f.q('#shoot-action-takes-list').textContent, /当前点位尚无已拍记录/);
  f.q('#btn-open-action-list').click();
  f.change('#input-jumper-search', 'NONEXISTENT_QUERY', 'input');
  assert.match(f.q('#action-jumper-list').textContent, /没有找到匹配的拍摄项/);
  f.q('#btn-action-jumper-close').click();

  // Complete D27 P2 -> D27 transitions from partial to manual_ok (2/2) and counts done
  const nextSeq = f.client.mockState.events.length + 1;
  f.client.mockState.events.push(
    event(nextSeq, 'TAKE_BEGIN', { take_id: 3, action_id: 'D27', point_id: 'P2', participants: 3, mono_ms: 8000 }),
    event(nextSeq + 1, 'TAKE_END', { take_id: 3, action_id: 'D27', point_id: 'P2', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 8000, mono_ms: 10000 }),
  );
  f.app.applyStatusSnapshot({ event_seq: nextSeq + 1, take_id: 3 });
  await f.app.syncCurrentProject();
  const d27Done = summarizeActionProgress(d27Act, 'T', f.app.state.ledger.progress);
  assert.equal(d27Done.state, 'manual_ok');
  assert.match(f.q('#current-action-progress-badge').textContent, /已确认齐 2\/2/);

  // 2. Unexpected BLE drop in ready stage preserves #shoot-stage-ready & Z3 even if user cancels a reconnect attempt
  const origConnect = f.client.connect.bind(f.client);
  f.client.mockState.connected = false;
  await f.client.onConnection({ connected: false, error: new BleClientError('disconnected', 'drop') });
  assert.equal(f.q('#shoot-stage-ready').hidden, false);
  assert.equal(f.q('#shoot-z3-slot').hidden, false);
  assert.equal(f.q('#btn-dock-reconnect').hidden, false);
  f.client.connect = async () => { throw new BleClientError('cancelled', 'User cancelled Bluetooth picker'); };
  f.q('#btn-dock-reconnect').click();
  await until(() => f.app.state.connecting === false);
  assert.equal(f.q('#shoot-stage-ready').hidden, false, 'failed reconnect must keep #shoot-stage-ready mounted');
  assert.equal(f.q('#btn-dock-reconnect').hidden, false);
  f.client.connect = origConnect;
});

test('V4 Round 2: #takes-count-badge uses real countValid, applyStatusSnapshot evaluates control once per frame, and sw.js precaches all phone modules', async t => {
  // 1. Records #takes-count-badge valid count consistency across valid, unended, unacked abnormal, acked abnormal, and discarded takes
  const events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, mono_ms: 1000 }),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 4000 }),
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S01', point_id: '', participants: 3, mono_ms: 5000 }),
    event(4, 'TAKE_BEGIN', { take_id: 3, action_id: 'S27', point_id: '', participants: 3, mono_ms: 6000 }),
    event(5, 'TAKE_END', { take_id: 3, action_id: 'S27', point_id: '', participants: 3, complete: false, begin_boot_id: 'boot-one', begin_mono_ms: 6000, mono_ms: 9000 }),
    event(6, 'TAKE_BEGIN', { take_id: 4, action_id: 'D28', point_id: '', participants: 3, mono_ms: 10000 }),
    event(7, 'TAKE_END', { take_id: 4, action_id: 'D28', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 10000, mono_ms: 12000 }),
    event(8, 'MARK_DISCARD', { take_id: 4, discard: true }),
  ];
  const f = await fixture(t, { events });
  await connect(f);
  f.q('#nav-btn-records').click();

  assert.equal(f.q('#takes-count-badge').textContent, '有效 1 / 共 4 条');
  assert.equal(f.q('[data-records-filter="valid"]').textContent, '有效 1');
  assert.equal(f.q('[data-records-filter="discarded"]').textContent, '废片 1');
  assert.equal(f.q('[data-records-filter="abnormal"]').textContent, '异常 2');

  // Confirm take 3 locally -> badge and filter pill both rise to 2
  f.q('#recent-takes-list [data-take-id="3"] [data-action="toggle-local-ack"]').click();
  assert.equal(f.q('#takes-count-badge').textContent, '有效 2 / 共 4 条');
  assert.equal(f.q('[data-records-filter="valid"]').textContent, '有效 2');
  assert.equal(f.q('[data-records-filter="abnormal"]').textContent, '异常 1');

  // Discard take 1 -> badge and filter pill both drop back to 1 (unended take 2 never counts as valid)
  f.q('#recent-takes-list [data-take-id="1"] [data-action="toggle-discard"]').click();
  await until(() => f.app.state.ledger.takes.find(tk => tk.take_id === 1)?.discarded === true);
  assert.equal(f.q('#takes-count-badge').textContent, '有效 1 / 共 4 条');
  assert.equal(f.q('[data-records-filter="valid"]').textContent, '有效 1');

  // 2. applyStatusSnapshot evaluates frameNow / getRecordControlState strictly once per steady snapshot (no second call inside render())
  let monoCalls = 0;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://field.example/phone/' });
  dom.window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} });
  const app2 = createApp({
    root: dom.window.document.getElementById('root'),
    client: createMockBleClient({ projectId: 'P', templateId: 'T', ackDelayMs: 0 }),
    storage: createMemoryStorage(),
    fetchImpl: async () => ({ ok: true, json: async () => structuredClone(template) }),
    now: () => 1800000000000,
    monotonicNow: () => {
      monoCalls += 1;
      return 1800000000000;
    },
  });
  t.after(() => { app2.destroy(); app2.client.disconnect(); dom.window.close(); });
  await app2.ready;
  await app2.client.connect();
  app2.state.connected = true;
  monoCalls = 0;
  app2.applyStatusSnapshot({
    project_id: 'P',
    template_id: 'T',
    action_id: 'S01',
    point_id: '',
    target_cameras: 3,
    active_participants: 0,
    phase: 'idle',
    boot_id: 'boot-one',
    mono_ms: 1000,
    event_seq: 0,
    take_id: 0,
    active_take_id: 0,
    writable: true,
    cameras: [
      { connected: true, fresh: true, recording: false, ready: true, led: 1, video: true },
      { connected: true, fresh: true, recording: false, ready: true, led: 1, video: true },
    ],
  });
  assert.equal(monoCalls, 1, 'applyStatusSnapshot must compute frame control state once and reuse it in render()');

  // Even when #modal-shoot-details is open and closes due to action change during applyStatusSnapshot, control is computed once
  dom.window.document.getElementById('btn-current-details').click();
  assert.equal(dom.window.document.getElementById('modal-shoot-details').open, true);
  monoCalls = 0;
  app2.applyStatusSnapshot({
    project_id: 'P',
    template_id: 'T',
    action_id: 'S27',
    point_id: '',
    target_cameras: 3,
    active_participants: 0,
    phase: 'idle',
    boot_id: 'boot-one',
    mono_ms: 1100,
    event_seq: 0,
    take_id: 0,
    active_take_id: 0,
    writable: true,
    cameras: [
      { connected: true, fresh: true, recording: false, ready: true, led: 1, video: true },
      { connected: true, fresh: true, recording: false, ready: true, led: 1, video: true },
    ],
  });
  assert.equal(dom.window.document.getElementById('modal-shoot-details').open, false);
  assert.equal(monoCalls, 1, 'closing stale dialog inside applyStatusSnapshot must reuse frame control without re-evaluating');

  // 3. Every .mjs file inside phone/ is precached in phone/sw.js and modular line counts stay clean
  const swText = fs.readFileSync(path.resolve('phone/sw.js'), 'utf8');
  const blockMatch = swText.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
  const precacheSet = new Set([...blockMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]));
  const walkMjs = dirRel => {
    const out = [];
    for (const ent of fs.readdirSync(path.resolve('phone', dirRel), { withFileTypes: true })) {
      const rel = dirRel === '.' ? `./${ent.name}` : `./${dirRel}/${ent.name}`;
      if (ent.isDirectory()) out.push(...walkMjs(dirRel === '.' ? ent.name : `${dirRel}/${ent.name}`));
      else if (ent.name.endsWith('.mjs')) out.push(rel);
    }
    return out;
  };
  for (const rel of walkMjs('.')) {
    assert.equal(precacheSet.has(rel), true, `Module ${rel} must be listed in phone/sw.js PRECACHE_URLS`);
    if (!rel.startsWith('./presets/')) {
      const lineCount = fs.readFileSync(path.resolve('phone', rel), 'utf8').split('\n').length;
      assert.ok(lineCount <= 700, `Module ${rel} should stay modular and concise (got ${lineCount} lines)`);
    }
  }
});

test('V4 Review Fix: partial batch failure syncs committed items cleanly and shoot-takes locks during batchOperationInFlight', async t => {
  const events = [
    event(1, 'TAKE_BEGIN', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, mono_ms: 1000 }),
    event(2, 'TAKE_END', { take_id: 1, action_id: 'S01', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 1000, mono_ms: 3000 }),
    event(3, 'TAKE_BEGIN', { take_id: 2, action_id: 'S01', point_id: '', participants: 3, mono_ms: 4000 }),
    event(4, 'TAKE_END', { take_id: 2, action_id: 'S01', point_id: '', participants: 3, complete: true, begin_boot_id: 'boot-one', begin_mono_ms: 4000, mono_ms: 6000 }),
  ];
  const f = await fixture(t, { events });
  await connect(f);

  const origRequest = f.client.request.bind(f.client);
  let resolveSecond;
  let discardCalls = 0;
  f.client.request = async cmd => {
    if (cmd.cmd === 'MARK_DISCARD') {
      discardCalls += 1;
      if (discardCalls === 2) {
        return new Promise((_, reject) => {
          resolveSecond = () => reject(new BleClientError('write_failed', 'Second discard failed'));
        });
      }
    }
    return origRequest(cmd);
  };

  // Trigger batch discard on [1, 2]; while #2 is in-flight, shoot-takes row controls must be disabled
  const batchPromise = f.app.batchMarkDiscard([1, 2], true, 'P');
  await until(() => discardCalls === 2);
  const shootTakeRow1 = f.q('#shoot-action-takes-list [data-take-id="1"]');
  assert.equal(shootTakeRow1.querySelector('[data-action="shoot-toggle-discard"]').disabled, true);
  assert.equal(shootTakeRow1.querySelector('[data-action="shoot-open-reassign"]').disabled, true);

  resolveSecond();
  const batchResult = await batchPromise;
  assert.equal(batchResult, null);

  // Take 1 was mutated before #2 failed and must now be synced cleanly while error banner stays visible
  assert.equal(f.app.state.ledger.takes.find(tk => tk.take_id === 1)?.discarded, true);
  assert.equal(f.app.state.ledger.takes.find(tk => tk.take_id === 2)?.discarded, false);
  assert.equal(f.q('#status-banner').dataset.tone, 'error');
  assert.equal(f.q('#status-banner').hidden, false);
  assert.equal(f.app.state.ledgerSyncError, null);
  assert.equal(shootTakeRow1.querySelector('[data-action="shoot-toggle-discard"]').disabled, false);
});
