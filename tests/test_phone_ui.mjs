import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  createApp, createMockBleClient, createMemoryStorage,
  TEMPLATE_CACHE_KEY, ledgerEventKey, ledgerCursorKey, loadProjectLedger,
  escapeCsvCell, exportLedgerCsv, deduceNextPointId, isValidPointId,
  filterActions,
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
  client.request = async request => {
    if (request.cmd !== command || used) return original(request);
    used = true;
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
  f.q('[data-status-filter="all"]').click();
  f.change('#input-action-search', '传递口', 'input');
  assert.deepEqual(rows(f), ['D27']);
  f.change('#input-action-search', '没有这项', 'input');
  assert.deepEqual(rows(f), []);
});

test('selection keeps the confirmed action and position until success, and rolls back rejection', async t => {
  const f = await fixture(t);
  await connect(f);
  const gate = holdReply(f.client, 'SELECT_ACTION');
  f.q('[data-action-id="D27"]').click();
  await gate.reached;
  assert.equal(f.q('#confirmed-action-id').textContent, 'S01');
  assert.equal(f.q('#action-pending-badge').hidden, false);
  // Even a status packet received before the command reply is not its ACK.
  f.client.emitStatus();
  assert.equal(f.q('#confirmed-action-id').textContent, 'S01');
  gate.release();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.q('#confirmed-action-id').textContent, 'D27');
  const pointGate = holdReply(f.client, 'SELECT_ACTION');
  f.q('[data-point-id="P2"]').click();
  await pointGate.reached;
  assert.equal(f.app.state.status.point_id, '');
  pointGate.release();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.app.state.status.point_id, 'P2');
  const request = f.client.request.bind(f.client);
  f.client.request = cmd => cmd.cmd === 'SELECT_ACTION'
    ? Promise.reject(Object.assign(new Error('device full'), { code: 'storage_full' })) : request(cmd);
  f.q('[data-action-id="S27"]').click();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.q('#confirmed-action-id').textContent, 'D27');
  assert.equal(f.app.state.status.point_id, 'P2');
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.equal(f.q('#action-pending-badge').hidden, true);
});

test('recording blocks row, stepper and point changes without writing selection events', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectAction('D27', 'P1');
  await f.app.startRecording();
  f.client.confirmRecording();
  const before = f.client.mockState.events.length;
  f.q('[data-action-id="S27"]').click();
  f.q('#btn-next-action').click();
  f.q('[data-point-id="P2"]').click();
  assert.equal(f.q('#confirmed-action-id').textContent, 'D27');
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
  f.change('[data-reassign-action-select="1"]', 'D27');
  f.change('[data-reassign-point-select="1"]', 'P2');
  f.app.applyStatusSnapshot({
    project_id: '', event_seq: 0, take_id: 0, active_take_id: 0,
    action_id: '', point_id: '', phase: 'idle',
  });
  assert.equal(f.root.querySelector('.take-item'), null);
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
  await until(() => f.app.state.ledger.takes[0]?.discarded === true);
  assert.equal(count(f, 'S01'), 0);
  f.q('[data-status-filter="shot"]').click();
  assert.deepEqual(rows(f), []);
  f.q('[data-action="toggle-discard"]').click();
  await until(() => f.app.state.ledger.takes[0]?.discarded === false);
  assert.deepEqual(rows(f), ['S01']);
  f.q('[data-action="open-reassign"]').click();
  f.change('[data-reassign-action-select="1"]', 'D27');
  f.change('[data-reassign-point-select="1"]', 'P2');
  f.q('[data-reassign-confirm="1"]').click();
  await until(() => f.app.state.ledger.takes[0]?.action_id === 'D27');
  assert.deepEqual(rows(f), ['D27']);
  assert.equal(count(f, 'D27'), 1);
  assert.equal(f.q('[data-take-action]').dataset.takeAction, 'D27');
  f.q('#btn-backup-download').click();
  assert.equal(f.downloads.length, 1);
  assert.match(f.downloads[0].name, /\.json$/);
  const payload = JSON.parse(f.downloads[0].text);
  assert.deepEqual(Object.keys(payload).sort(), ['after_seq', 'events', 'exported_at', 'project_id', 'takes', 'template_id']);
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
  const action = f.change('[data-reassign-action-select="1"]', 'D27');
  const point = f.change('[data-reassign-point-select="1"]', 'P2');
  point.focus();
  f.client.emitStatus();
  f.advance(4000);
  f.app.render();
  assert.equal(f.dom.window.document.activeElement, point);
  assert.equal(f.q('[data-reassign-action-select="1"]'), action);
  assert.equal(f.q('[data-reassign-point-select="1"]'), point);
  assert.equal(action.value, 'D27');
  assert.equal(point.value, 'P2');
  assert.equal(f.q('[data-reassign-panel="1"]').hidden, false);
  assert.equal(f.app.state.ledger.takes[0].action_id, 'S01', 'unsaved draft must not alter ledger');
  f.q('[data-reassign-confirm="1"]').click();
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
  assert.ok(f.q('[data-reassign-action-select="1"]').options[0].textContent.includes(attack));
  assert.ok(f.q('[data-reassign-point-select="1"]').options[1].textContent.includes(attack));
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
  // Before connecting: shoot view is active, settings sheet is closed by default.
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-list').hidden, true);
  assert.equal(f.q('#view-records').hidden, true);
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'false');
  assert.equal(f.q('#btn-toggle-settings').textContent.trim(), '连接与设置');

  // Open settings sheet from topbar, enter draft project ID, close via sheet close button.
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'true');
  const projInput = f.change('#input-init-project-id', 'DRAFT_PROJ', 'input');
  f.q('#btn-settings-close').click();
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'false');

  await connect(f);
  // Once connected, button text updates to 设置 without auto-opening modal.
  assert.equal(f.q('#btn-toggle-settings').textContent.trim(), '设置');
  assert.equal(f.q('#modal-settings').open, false);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'false');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, true);
  assert.equal(f.q('#btn-toggle-settings').getAttribute('aria-expanded'), 'true');
  f.q('#btn-toggle-settings').click();
  assert.equal(f.q('#modal-settings').open, false);

  // Switch to action list view via shoot-view shortcut button, set search/filter & scrollTop.
  f.q('#btn-open-action-list').click();
  assert.equal(f.q('#view-list').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  assert.equal(f.q('#nav-btn-list').getAttribute('aria-pressed'), 'true');
  f.change('#input-action-search', '27', 'input');
  f.q('[data-group-filter="一区"]').click();
  f.q('#view-list').scrollTop = 140;

  // Return to shoot view via list return button, then switch to records view.
  f.q('#btn-after-select-return').click();
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-list').hidden, true);
  f.q('#view-shoot').scrollTop = 85;

  f.q('#nav-btn-records').click();
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  assert.equal(f.q('#nav-btn-records').getAttribute('aria-pressed'), 'true');
  f.q('[data-action="open-reassign"]').click();
  f.change('[data-reassign-action-select="1"]', 'D27');
  f.change('[data-reassign-point-select="1"]', 'P1');
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
  assert.equal(f.q('[data-reassign-panel="1"]').hidden, false);
  assert.equal(f.q('[data-reassign-action-select="1"]').value, 'D27');
  assert.equal(f.q('[data-reassign-point-select="1"]').value, 'P1');

  f.q('#btn-records-back-shoot').click();
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-shoot').scrollTop, 85);
  assert.equal(f.scrolls.at(-1)?.top, 85);
  assert.equal(projInput.value, 'DRAFT_PROJ');

  // Responsive resize to >=768px exposes all 3 panels semantically (hidden=false) and hides bottom nav,
  // and resizing back to mobile (<768px) restores single-view hidden state without duplicating DOM or losing drafts.
  f.q('#nav-btn-records').click();
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  f.resize(768, 900);
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-list').hidden, false);
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#bottom-view-nav').hidden, true);
  f.resize(1200, 900);
  assert.equal(f.q('#view-shoot').hidden, false);
  assert.equal(f.q('#view-list').hidden, false);
  assert.equal(f.q('#view-records').hidden, false);
  f.resize(375, 667);
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('#view-shoot').hidden, true);
  assert.equal(f.q('#view-list').hidden, true);
  assert.equal(f.q('#bottom-view-nav').hidden, false);
  assert.equal(f.q('#input-action-search').value, '27');
  assert.equal(f.q('[data-reassign-action-select="1"]').value, 'D27');
  assert.equal(f.q('[data-reassign-point-select="1"]').value, 'P1');
  assert.equal(projInput.value, 'DRAFT_PROJ');

  // Empty project keeps init box visible inside sheet without auto-opening modal.
  f.app.applyStatusSnapshot({
    project_id: '', template_id: 'T', action_id: '', point_id: '',
    target_cameras: 3, active_participants: 0, event_seq: 0, take_id: 0, active_take_id: 0, phase: 'idle',
  });
  assert.equal(f.q('#init-project-box').hidden, false);
  assert.equal(f.q('#modal-settings').open, false);
});

test('target camera selection waits for ACK with valid target_cameras, rolls back on rejection or malformed reply, and blocks during active take', async t => {
  const f = await fixture(t);
  await connect(f);
  assert.equal(f.app.state.status.target_cameras, 3);
  assert.equal(f.q('#btn-target-both').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-target-a').getAttribute('aria-pressed'), 'false');

  // Hold SELECT_ACTION reply: confirmed target stays 3 until resolved.
  const gate = holdReply(f.client, 'SELECT_ACTION');
  f.q('#btn-target-a').click();
  await gate.reached;
  assert.equal(f.app.state.status.target_cameras, 3);
  assert.equal(f.q('#btn-target-both').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-target-a').classList.contains('is-pending'), true);
  f.client.emitStatus();
  assert.equal(f.app.state.status.target_cameras, 3);
  gate.release();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.app.state.status.target_cameras, 1);
  assert.equal(f.q('#btn-target-a').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-target-both').getAttribute('aria-pressed'), 'false');
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').at(-1).target_cameras, 1);

  // Malformed SELECT_ACTION reply missing valid target_cameras is rejected and rolled back.
  const originalReq = f.client.request.bind(f.client);
  f.client.request = cmd => cmd.cmd === 'SELECT_ACTION'
    ? Promise.resolve({ ok: true, project_id: 'P', action_id: 'S01', point_id: '' })
    : originalReq(cmd);
  f.q('#btn-target-b').click();
  await until(() => !f.app.state.pendingSelect);
  assert.equal(f.app.state.status.target_cameras, 1);
  assert.equal(f.q('#btn-target-a').getAttribute('aria-pressed'), 'true');
  assert.equal(f.q('#btn-target-b').getAttribute('aria-pressed'), 'false');
  assert.equal(f.q('#status-banner').getAttribute('role'), 'alert');
  assert.equal(f.q('#status-banner').dataset.errorCode, 'invalid_select_ack');
  f.client.request = originalReq;

  // When no action_id is selected, clicking camera target does not send SELECT_ACTION with empty action_id.
  f.client.emitStatus({ action_id: '', point_id: '' });
  const selectCountBefore = f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length;
  await f.app.selectTargetCameras(2);
  assert.equal(f.client.mockState.commands.filter(c => c.cmd === 'SELECT_ACTION').length, selectCountBefore);
  assert.equal(f.q('#status-banner').dataset.errorCode, 'no_action_selected');

  // Restore action_id and verify active recording locks target camera controls.
  await f.app.selectAction('S01', '', 2);
  assert.equal(f.app.state.status.target_cameras, 2);
  await f.app.startRecording();
  f.client.confirmRecording();
  assert.equal(f.q('#btn-target-a').disabled, true);
  assert.equal(f.q('#btn-target-b').disabled, true);
  assert.equal(f.q('#btn-target-both').disabled, true);
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
  assert.match(f.q('#record-observation-text').textContent, /B 机未就绪/);
  const rejectedDual = await f.app.startRecording();
  assert.equal(rejectedDual, null);
  assert.equal(f.client.mockState.take_id, 0);
  assert.equal(f.q('#status-banner').dataset.errorCode, 'start_rejected_or_storage_full');

  // Switch to A-only (target_cameras = 1): Camera A is ready so recording is enabled even with Camera B offline.
  f.q('#btn-target-a').click();
  await until(() => f.app.state.status.target_cameras === 1 && !f.app.state.pendingSelect);
  assert.equal(f.q('#btn-record-main').disabled, false);
  assert.equal(f.q('#phase-badge').dataset.state, 'ready');
  assert.equal(f.q('#card-cam-b').classList.contains('is-unselected'), true);
  assert.match(f.q('#cam-b-badge-text').textContent, /本段不用/);

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
  assert.match(take1El.textContent, /相机B：本段未参与/);

  // Now Camera A sleeps and Camera B is ready: switch to B-only (target_cameras = 2) and record Take 2.
  f.client.emitStatus({
    cameras: [
      { ...f.client.mockState.cameras[0], connected: true, fresh: true, sleeping: true, ready: false, recording: false },
      { ...f.client.mockState.cameras[1], connected: true, fresh: true, sleeping: false, video: true, ready: true, recording: false, led: 1 },
    ],
  });
  assert.equal(f.q('#btn-record-main').disabled, true);
  f.q('#btn-target-b').click();
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
  assert.match(take2El.textContent, /相机A：本段未参与/);
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
  assert.match(f.q('#record-observation-text').textContent, /检测到相机正在录像/);
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
  assert.equal(f.q('#btn-target-both').disabled, true);
  assert.equal(f.q('#btn-target-a').disabled, true);
  assert.equal(f.q('#btn-target-b').disabled, true);
  assert.equal(f.q('#btn-target-both').getAttribute('aria-pressed'), 'false');
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

  // Take 1 was dual (participants = 3) where Camera B failed to start: must NEVER say 本段未参与.
  const take1El = f.q('[data-take-id="1"].take-item');
  assert.match(take1El.textContent, /相机A：已观察到录像，已停止/);
  assert.match(take1El.textContent, /相机B：未确认开始录像，未确认停止/);
  assert.doesNotMatch(take1El.textContent, /相机B：本段未参与/);

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
  assert.match(take2El.textContent, /相机B：本段未参与/);

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
  assert.equal(f.q('#btn-target-both').getAttribute('aria-pressed'), 'false');
  assert.equal(f.q('#btn-target-a').disabled, true);
  const before = client.mockState.commands.length;
  await f.app.selectAction('D27');
  assert.equal(client.mockState.commands.length, before);
  client.emitStatus({ project_id: 'NEW', target_cameras: 3, active_participants: 0 });
  assert.equal(f.q('#btn-target-a').disabled, false);
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
  const alertBar = f.q('#target-alert-bar');

  // Initially dual mode (target_cameras: 3), both ready
  assert.equal(alertBar.hidden, true);

  // Dual mode: Cam A unready
  f.client.emitStatus({
    cameras: [
      { connected: true, ready: false, recording: false, fresh: true, video: true, battery: 80 },
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(alertBar.hidden, false);
  assert.match(alertBar.textContent, /A 机.*未就绪/);

  // Dual mode: Cam B disconnected
  f.client.emitStatus({
    cameras: [
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(alertBar.hidden, false);
  assert.match(alertBar.textContent, /B 机.*未连接/);

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
  assert.equal(alertBar.hidden, true);

  // Single A mode: Cam A disconnected
  f.client.emitStatus({
    target_cameras: 1,
    cameras: [
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(alertBar.hidden, false);
  assert.match(alertBar.textContent, /A 机.*未连接/);

  // Single B mode: Cam B disconnected
  await f.app.selectTargetCameras(2);
  f.client.emitStatus({
    target_cameras: 2,
    cameras: [
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(alertBar.hidden, false);
  assert.match(alertBar.textContent, /B 机.*未连接/);
});

test('target camera alert hides on controller disconnect', async t => {
  const f = await fixture(t);
  await connect(f);
  const alertBar = f.q('#target-alert-bar');

  // Trigger alert
  f.client.emitStatus({
    cameras: [
      { connected: false, ready: false, recording: false, fresh: true, video: true, battery: 80 },
      { connected: true, ready: true, recording: false, fresh: true, video: true, battery: 80 },
    ],
  });
  assert.equal(alertBar.hidden, false);

  // Disconnect controller
  f.client.disconnect();
  await until(() => !f.app.state.connected);
  assert.equal(alertBar.hidden, true);
  assert.equal(alertBar.textContent, '');
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

  const actionSelect = f.q('[data-reassign-action-select="1"]');
  const pointSelect = f.q('[data-reassign-point-select="1"]');

  assert.equal(actionSelect.value, 'A_ORPHAN');
  assert.equal(pointSelect.value, 'P_ORPHAN');

  const actionOptions = Array.from(actionSelect.options);
  const orphanActionOption = actionOptions.find(o => o.value === 'A_ORPHAN');
  assert.ok(orphanActionOption);
  assert.match(orphanActionOption.textContent, /现场保留动作·未命名/);

  const pointOptions = Array.from(pointSelect.options);
  const orphanPointOption = pointOptions.find(o => o.value === 'P_ORPHAN');
  assert.ok(orphanPointOption);
  assert.match(orphanPointOption.textContent, /现场保留点位·未命名/);

  // Draft must not be cleared or corrupted
  const draft = f.app.state.reassignDrafts.get(1);
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

test('wakeLock acquisition and release cycles with recording phase and recovers on visibilitychange', async t => {
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
  await f.app.selectAction('S01');

  // Start recording
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

  // Simulate returning to tab: visibilityState becomes visible while recording
  Object.defineProperty(f.dom.window.document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  });
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  await until(() => lockRequested >= 2);
  assert.equal(lockRequested, 2, 'WakeLock should be re-acquired on tab becoming visible while recording');

  // Stop recording
  await f.app.stopRecording();
  f.client.emitStatus({
    phase: 'idle',
    active_take_id: 0,
    cameras: f.client.mockState.cameras.map(c => ({ ...c, recording: false, ready: true })),
  });
  await until(() => f.app.state.status.phase === 'idle');
  assert.equal(lockReleased, 2, 'WakeLock should be released upon stopping recording');
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

  // Row 1 assertions
  assert.match(lines[1], /^"1","S01","静态检查","P01","P01 \(现场点位\)","双机同拍","是","保留","normal","2027-01-15T08:00:00.000Z","5.0","已录制","85","已录制","82"$/);

  // Row 2 assertions: formula injection neutralized, line breaks stripped, NaN timestamp produces empty string
  assert.match(lines[2], /^"2","S01","静态检查","'=MALICIOUS",".*","只拍A机","否","不使用","aborted line2","","","未录制","","未录制",""$/);

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
  assert.equal(f.q('#target-alert-bar').hidden, true);
  f.advance(4000);
  assert.equal(f.q('#target-alert-bar').hidden, false);
});

test('pending wake lock is single flight and late locks are released after idle or destroy', async t => {
  for (const destroy of [false, true]) {
    await t.test(destroy ? 'destroy' : 'idle', async t => {
    const f = await fixture(t);
    await connect(f);
    const pending = deferred();
    let requests = 0, releases = 0;
    f.dom.window.navigator.wakeLock = { request() { requests++; return pending.promise; } };
    f.app.applyStatusSnapshot({ phase: 'recording' });
    f.app.applyStatusSnapshot({ phase: 'recording' });
    assert.equal(requests, 1);
    if (destroy) f.app.destroy();
    else f.app.applyStatusSnapshot({ phase: 'idle' });
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
  assert.match(f.q('#record-elapsed').textContent, /待确认/);
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
  assert.equal(f.app.state.ledger.validCounts.size, 0);
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
  const reassigned = await f.app.reassignTake(1, 'D27', 'P2');
  assert.equal(reassigned?.ok, true);
  assert.equal(f.client.mockState.events.at(-1).type, 'REASSIGN');
  assert.equal(f.app.state.ledger.takes[0].action_id, 'S01');
  assert.notEqual(f.q('#status-banner').dataset.tone, 'ok');
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
  assert.match(f.q('#recent-take-identity').textContent, /D27\/P1.*00:05/);
  assert.match(f.q('#recent-take-result').textContent, /双机.*已拍完/);
  const before = f.client.mockState.commands.length;
  f.q('#btn-open-records').click();
  assert.equal(f.q('#view-records').hidden, false);
  assert.equal(f.q('[data-reassign-action-select="1"]').value, 'D27');
  assert.equal(f.q('[data-reassign-point-select="1"]').value, 'P1');
  assert.equal(f.dom.window.document.activeElement, f.q('[data-reassign-action-select="1"]'));
  assert.equal(f.client.mockState.commands.length, before);
  f.change('[data-reassign-action-select="1"]', 'S01');
  f.q('[data-reassign-confirm="1"]').click();
  await until(() => f.app.state.ledger.takes[0].action_id === 'S01');
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
      const identity = f.q('#recent-take-identity').textContent;
      const result = f.q('#recent-take-result').textContent;
      if (scenario === 'zero') {
        assert.match(identity, /00:00/);
        const csv = exportLedgerCsv(f.app.state.ledger, f.app.state.template);
        const columns = csv.split('\r\n');
        const durationCell = columns[1].split(',')[10].replace(/^"|"$/g, '');
        assert.notEqual(durationCell, '');
        assert.equal(Number(durationCell), 0);
      } else if (['crossboot', 'negative'].includes(scenario)) {
        assert.match(identity, /计时待确认/);
        assert.doesNotMatch(identity, /\d+:\d+/);
      } else if (scenario === 'unfinished') {
        assert.doesNotMatch(identity, /\d+:\d+/);
        assert.match(result, /尚未结束/);
        assert.equal(f.q('#btn-open-records').disabled, true);
        const before = f.client.mockState.commands.length;
        f.q('#btn-open-records').click();
        f.q('[data-action="open-reassign"]').click();
        assert.equal(f.app.state.editingReassignTakeId, null);
        assert.equal(f.client.mockState.commands.length, before);
      } else assert.match(result, scenario === 'discard' ? /不使用/ : /有异常/);
      assert.match(result, /双机/);
    });
  }
});

test('recent edit refuses stale project and unreadable ledger identities without commands', async t => {
  const f = await fixture(t, { events: completedTake() });
  await connect(f);
  f.app.storage.setItem(ledgerCursorKey('Q'), '1');
  f.app.storage.setItem(ledgerEventKey('Q', 1), '{broken');
  f.client.emitStatus({ project_id: 'Q', events: [], take_id: 0 });
  const before = f.client.mockState.commands.length;
  f.q('#btn-open-records').dataset.projectId = 'P';
  f.q('#btn-open-records').dataset.takeId = '1';
  // Dispatch bypasses disabled activation to exercise the stale identity guard.
  f.q('#btn-open-records').dispatchEvent(new f.dom.window.Event('click'));
  assert.equal(f.app.state.editingReassignTakeId, null);
  assert.equal(f.q('#view-records').hidden, true);
  assert.equal(f.client.mockState.commands.length, before);
});

test('healthy single-camera choice stays quiet while selected disconnect and stale observations remain visible', async t => {
  const f = await fixture(t);
  await connect(f);
  await f.app.selectTargetCameras(1);
  assert.equal(f.q('#target-alert-bar').hidden, true);
  f.client.emitStatus({ cameras: f.client.mockState.cameras.map((cam, index) => index ? cam : { ...cam, connected: false }) });
  assert.equal(f.q('#target-alert-bar').hidden, false);
  f.client.emitStatus({ cameras: f.client.mockState.cameras.map((cam, index) => index ? cam : { ...cam, connected: true, fresh: false }) });
  assert.equal(f.q('#target-alert-bar').hidden, false);
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
  const rail = f.q('#point-pills');
  Object.defineProperties(rail, { clientWidth: { value: 300 }, scrollWidth: { value: 1300 } });
  rail.getBoundingClientRect = () => ({ left: 0, right: 300 });
  for (const button of rail.querySelectorAll('[data-point-id]')) {
    button.getBoundingClientRect = () => {
      const offset = Number(button.dataset.pointId.slice(1) || 0) * 100 - rail.scrollLeft;
      return { left: offset, right: offset + 80 };
    };
  }
  flush();
  const pageScrolls = f.scrolls.length;
  f.client.emitStatus({ point_id: 'P12' });
  flush();
  assert.ok(rail.scrollLeft > 0);
  assert.equal(f.scrolls.length, pageScrolls);
  assert.equal(f.q('#point-rail-frame').dataset.overflowStart, 'true');
  rail.scrollLeft = 50;
  rail.dispatchEvent(new f.dom.window.Event('scroll'));
  f.advance(1000); flush();
  assert.equal(rail.scrollLeft, 50);
  f.app.switchView('list');
  f.client.emitStatus({ point_id: 'P1' });
  flush();
  assert.equal(rail.scrollLeft, 50);
  f.app.switchView('shoot'); flush();
  assert.ok(rail.scrollLeft < 100);

  // Focus a nonselected pill: fully reveals horizontally within rail with >=12px clearance,
  // leaving page vertical scroll, confirmed selection and commands untouched.
  const cmdsBeforeFocus = f.client.mockState.commands.length;
  const pageScrollsBeforeFocus = f.scrolls.length;
  const p12 = rail.querySelector('[data-point-id="P12"]');
  p12.dispatchEvent(new f.dom.window.Event('focusin', { bubbles: true }));
  flush();

  const p12Rect = p12.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  assert.ok(p12Rect.right <= railRect.right - 12);
  assert.ok(p12Rect.left >= railRect.left + 12);
  assert.equal(f.scrolls.length, pageScrollsBeforeFocus);
  assert.equal(f.app.state.status.point_id, 'P1');
  assert.equal(f.client.mockState.commands.length, cmdsBeforeFocus);

  // Focus a pill clipped on the left: also fully reveals with clearance
  const p2 = rail.querySelector('[data-point-id="P2"]');
  p2.dispatchEvent(new f.dom.window.Event('focusin', { bubbles: true }));
  flush();
  const p2Rect = p2.getBoundingClientRect();
  assert.ok(p2Rect.left >= railRect.left + 12);
  assert.ok(p2Rect.right <= railRect.right - 12);
  assert.equal(f.app.state.status.point_id, 'P1');
  assert.equal(f.client.mockState.commands.length, cmdsBeforeFocus);

  // Normal clock tick / manual scroll is still preserved without snapping back
  rail.scrollLeft = 80;
  rail.dispatchEvent(new f.dom.window.Event('scroll'));
  f.advance(1000); flush();
  assert.equal(rail.scrollLeft, 80);
  assert.equal(f.app.state.status.point_id, 'P1');
});

test('mobile controls fall back to whole-shoot scrolling only when measured text needs it and recover', async t => {
  let resized;
  const f = await fixture(t, { configureWindow(win) {
    win.document.documentElement.style.fontSize = '16px';
    win.ResizeObserver = class {
      constructor(callback) { resized = callback; }
      observe() {}
      disconnect() {}
    };
  } });
  const view = f.q('#view-shoot');
  const controls = f.q('#shoot-record-controls');
  let height = 300, controlHeight = 250;
  Object.defineProperty(view, 'clientHeight', { get: () => height });
  Object.defineProperty(controls, 'scrollHeight', { get: () => controlHeight });
  resized();
  assert.equal(view.classList.contains('is-overflow-layout'), true);
  assert.equal(f.root.classList.contains('is-overflow-layout'), true);
  height = 0; resized();
  assert.equal(view.classList.contains('is-overflow-layout'), true);
  height = 400; controlHeight = 200; resized();
  assert.equal(view.classList.contains('is-overflow-layout'), false);
  f.resize(1024);
  assert.equal(view.classList.contains('is-overflow-layout'), false);
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
  assert.equal(f.q('#action-list [data-action-id="S01"]').disabled, true);
  assert.equal(f.q('#btn-trigger-add-point').disabled, true);
  assert.equal(f.q('#btn-open-records').disabled, true);
  f.q('#btn-current-details').click();
  assert.doesNotMatch(f.q('#shoot-details-content').textContent, /外来动作|外来点位/);
  f.q('#btn-shoot-details-close').click();
  const commandsBefore = f.client.mockState.commands.length;
  assert.equal(await f.app.selectAction('S01'), null);
  assert.equal(await f.app.startRecording(), null);
  assert.equal(await f.app.reassignTake(1, 'S01'), null);
  f.q('#btn-open-records').dispatchEvent(new f.dom.window.Event('click'));
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
  assert.equal(f.q('#target-alert-bar').hidden, false);
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

test('stepper traverses full ordered template regardless of view filter, boundary buttons disable and boundary calls return null', async t => {
  const f = await fixture(t);
  await connect(f);
  // Full template actions in order: S01 (order 1), S27 (order 2), D27 (order 3), D28 (order 4)
  assert.equal(f.app.state.status.action_id, 'S01');

  // At first action S01: Prev is disabled, Next is enabled.
  assert.equal(f.q('#btn-prev-action').disabled, true);
  assert.equal(f.q('#btn-next-action').disabled, false);

  // Stepping prev at boundary returns null without sending any BLE command
  const cmdsBefore = f.client.mockState.commands.length;
  const prevResult = await f.app.stepAction(-1);
  assert.equal(prevResult, null);
  assert.equal(f.client.mockState.commands.length, cmdsBefore);

  // Set filter in list view that hides S27 (e.g. dynamic type filter)
  f.q('#nav-btn-list').click();
  f.q('[data-type-filter="dynamic"]').click();
  assert.deepEqual(rows(f), ['D27', 'D28']);

  // Return to shoot view: stepping next traverses to S27 (full sorted template order, not view-filtered)
  f.q('#nav-btn-shoot').click();
  await f.app.stepAction(1);
  assert.equal(f.app.state.status.action_id, 'S27');
  assert.equal(f.q('#btn-prev-action').disabled, false);
  assert.equal(f.q('#btn-next-action').disabled, false);

  // Advance to D27, then D28
  await f.app.stepAction(1);
  assert.equal(f.app.state.status.action_id, 'D27');
  await f.app.stepAction(1);
  assert.equal(f.app.state.status.action_id, 'D28');

  // At last action D28: Next is disabled, Prev is enabled.
  assert.equal(f.q('#btn-prev-action').disabled, false);
  assert.equal(f.q('#btn-next-action').disabled, true);

  // Stepping next at boundary returns null without wrapping or sending command
  const nextCmds = f.client.mockState.commands.length;
  const nextResult = await f.app.stepAction(1);
  assert.equal(nextResult, null);
  assert.equal(f.client.mockState.commands.length, nextCmds);
  assert.equal(f.app.state.status.action_id, 'D28');
});

test('disconnected state disables action/point controls; unfinished take prevents reassignment; finished take reassigns', async t => {
  const beginEvt = event(1, 'TAKE_BEGIN', {
    take_id: 1, action_id: 'D27', point_id: 'P1',
    command_id: 'cmd-start-1', source: 'ble', participants: 3,
    time_anchor: { boot_id: 'boot-one', mono_ms: 1000, utc_ms: 1800000000000 }
  });
  const f = await fixture(t, { events: [beginEvt] });
  // While disconnected:
  assert.equal(f.app.state.connected, false);
  assert.equal(f.q('#btn-prev-action').disabled, true);
  assert.equal(f.q('#btn-next-action').disabled, true);
  assert.equal(f.q('#btn-open-action-list').disabled, true);
  assert.equal(f.q('#btn-trigger-add-point').disabled, true);
  assert.equal(await f.app.stepAction(1), null);

  // Connect: initial log sync delivers the unfinished take
  await connect(f);
  assert.equal(f.app.state.ledger.takes.length, 1);
  assert.equal(f.app.state.ledger.takes[0].ended, false);

  // In records view, reassign button for unfinished take is disabled and displays 结束后可改归属
  f.q('#nav-btn-records').click();
  const reassignBtn = f.q('[data-action="open-reassign"]');
  assert.equal(reassignBtn.disabled, true);
  assert.ok(reassignBtn.textContent.includes('结束后可改归属'));

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

  // Reassign button is now enabled and displays 改归属
  assert.equal(reassignBtn.disabled, false);
  assert.ok(reassignBtn.textContent.includes('改归属'));

  // Reassignment succeeds
  f.q('[data-action="open-reassign"]').click();
  f.change('[data-reassign-action-select="1"]', 'D28');
  f.q('[data-reassign-confirm="1"]').click();
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

  // In shoot view: global strip is hidden
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
  await until(() => f.app.state.ledger.takes.find(t => t.take_id === 1)?.discarded === true);
  discardBtns[3].click();
  await until(() => f.app.state.ledger.takes.find(t => t.take_id === 1)?.discarded === false);
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
