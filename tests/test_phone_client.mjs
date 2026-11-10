import test from 'node:test';
import assert from 'node:assert/strict';
import { UUIDS, KINDS, encodeMessage, MessageReassembler, BleClientError, DjiBleClient } from '../phone/ble-client.mjs';

const utf8 = new TextEncoder();
const info = { protocol: 1, header_bytes: 8, max_command_bytes: 767, max_message_bytes: 4096, default_packet_bytes: 20 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('Expected asynchronous state was not reached');
}
class BoundaryTarget {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ target: this }); }
}
// Only the Web Bluetooth boundary is faked; framing, scheduling, persistence and
// protocol validation are the real module under test.
class FakeDevice extends BoundaryTarget {
  constructor() {
    super();
    this.id = 'fake-device';
    this.writes = [];
    this.commands = [];
    this.parser = new MessageReassembler();
    this.tx = new BoundaryTarget();
    this.tx.startNotifications = async () => { this.subscribed = true; return this.tx; };
    this.rx = { writeValueWithResponse: async packet => {
      this.writes.push(new Uint8Array(packet));
      if (this.writeGate) await this.writeGate.promise;
      if (this.writeError) throw this.writeError;
      const message = this.parser.push(packet);
      if (message) this.commands.push(message);
    } };
    this.info = { readValue: async () => new DataView(utf8.encode(JSON.stringify(this.infoData ?? info)).buffer) };
    this.service = { getCharacteristic: async uuid => {
      assert.ok([UUIDS.rx, UUIDS.tx, UUIDS.info].includes(uuid));
      return uuid === UUIDS.rx ? this.rx : uuid === UUIDS.tx ? this.tx : this.info;
    } };
    this.gatt = {
      connected: false,
      connect: async () => { this.gatt.connected = true; return this.gatt; },
      getPrimaryService: async uuid => { assert.equal(uuid, UUIDS.service); return this.service; },
      disconnect: () => { this.gatt.connected = false; this.emit('gattserverdisconnected'); },
    };
  }
  packet(packet) {
    this.tx.value = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    this.tx.emit('characteristicvaluechanged');
  }
  send(kind, id, data, options) { for (const packet of encodeMessage(kind, id, data, options)) this.packet(packet); }
  reply(index = 0, data = { ok: true }) { this.send(KINDS.REPLY, this.commands[index].requestId, data); }
}
async function connected(t, options = {}, devices = [new FakeDevice()]) {
  const pickerCalls = [];
  let index = 0;
  const client = new DjiBleClient({ ...options, bluetooth: { requestDevice: async filters => {
    pickerCalls.push(filters);
    return devices[index++];
  } } });
  t.after(() => client.disconnect());
  assert.deepEqual(await client.connect(), info);
  return { client, device: devices[0], pickerCalls };
}
const event = (seq, changes = {}) => ({ schema_version: 1, project_id: 'P', template_id: 'T', event_seq: seq, type: 'SELECT_ACTION', action_id: '中文', ...changes });
const lineBytes = events => events.reduce((sum, value) => sum + utf8.encode(JSON.stringify(value)).length + 1, 0);
function begin(device, id, events, after = 0, changes = {}) {
  device.send(KINDS.LOG_BEGIN, id, { project_id: 'P', template_id: 'T', event_seq: events.length,
    take_id: 0, lines: events.length, bytes: lineBytes(events), after_seq: after, ...changes });
}
function end(device, id, all, sent = all, changes = {}) {
  device.send(KINDS.LOG_END, id, { ok: true, project_id: 'P', event_seq: all.length, through_seq: all.length,
    sent_lines: sent.length, sent_bytes: lineBytes(sent), ...changes });
}
async function startLog(client, device, after = 0, onEvent = async () => {}) {
  const promise = client.syncLog(after, 'P', onEvent);
  // Attach a rejection observer before synchronously delivering invalid packets.
  const outcome = promise.then(value => ({ value }), error => ({ error }));
  await until(() => device.commands.length > 0);
  return { promise, outcome, id: device.commands[0].requestId };
}

test('default wire packets are 20 bytes, preserve multibyte UTF-8, and support 16-bit IDs', () => {
  const value = { cmd: 'SELECT_ACTION', action_id: '动作' };
  const packets = encodeMessage(KINDS.COMMAND, 65535, value);
  assert.ok(packets.length > 1);
  const parser = new MessageReassembler();
  let result;
  for (const [index, packet] of packets.entries()) {
    assert.ok(packet.length <= 20 && packet.length > 8);
    assert.equal(new DataView(packet.buffer).getUint16(4, true), index * 12);
    result = parser.push(new DataView(packet.buffer));
  }
  assert.equal(result.requestId, 65535);
  assert.deepEqual(result.data, value);
});

test('command and incoming byte boundaries use bytes, not characters', () => {
  assert.doesNotThrow(() => encodeMessage(KINDS.COMMAND, 1, utf8.encode('x'.repeat(767))));
  assert.throws(() => encodeMessage(KINDS.COMMAND, 1, utf8.encode('x'.repeat(768))), /invalid_header/);
  const raw = utf8.encode(JSON.stringify({ x: 'x'.repeat(4088) }));
  assert.equal(raw.length, 4096);
  const parser = new MessageReassembler();
  let message;
  for (const packet of encodeMessage(KINDS.REPLY, 1, raw)) message = parser.push(packet);
  assert.equal(message.bytes.length, 4096);
  assert.throws(() => encodeMessage(KINDS.REPLY, 1, new Uint8Array(4097)), /invalid_header/);
  assert.throws(() => encodeMessage(KINDS.COMMAND, 0, {}), /invalid_header/);
  assert.throws(() => encodeMessage(KINDS.STATUS, 1, {}), /invalid_header/);
});

test('malformed fragmentation is rejected and partial state cleared', () => {
  const packets = encodeMessage(KINDS.REPLY, 7, { ok: true, text: 'a'.repeat(40) });
  for (const mutate of [
    packet => { packet[0] = 2; },
    packet => { packet[1] = 99; },
    packet => { packet[2] = 0; packet[3] = 0; },
    packet => { packet[6] = 0; packet[7] = 0; },
    packet => { packet[6] = 1; packet[7] = 16; },
    packet => { packet[4] = 1; },
  ]) {
    const parser = new MessageReassembler();
    const broken = packets[0].slice();
    mutate(broken);
    assert.throws(() => parser.push(broken), BleClientError);
    assert.equal(parser.partial, null);
    assert.deepEqual(parser.push(encodeMessage(KINDS.REPLY, 2, { ok: true })[0]).data, { ok: true });
  }
  for (const continuation of [packets[0], packets[2], encodeMessage(KINDS.REPLY, 8, { x: 1 })[0]]) {
    const parser = new MessageReassembler();
    parser.push(packets[0]);
    assert.throws(() => parser.push(continuation), BleClientError);
    assert.equal(parser.partial, null);
  }
  assert.throws(() => new MessageReassembler().push(new Uint8Array(8)), /invalid_fragment/);
  for (const bad of [new Uint8Array([0xff]), utf8.encode('[]'), utf8.encode('{')]) {
    const parser = new MessageReassembler();
    assert.throws(() => { for (const packet of encodeMessage(KINDS.REPLY, 1, bad)) parser.push(packet); }, BleClientError);
  }
});

test('real discovery uses UUID filter and INFO and does not issue automatic commands', async t => {
  const { client, device, pickerCalls } = await connected(t);
  assert.deepEqual(pickerCalls, [{ filters: [{ services: [UUIDS.service] }] }]);
  assert.equal(device.subscribed, true);
  assert.equal(client.connected, true);
  assert.equal(device.writes.length, 0);
  const status = client.getStatus();
  await until(() => device.commands.length === 1);
  device.reply(0, { ok: true, phase: 'idle' });
  assert.equal((await status).phase, 'idle');
  const sync = client.syncTime(1794220000000);
  await until(() => device.commands.length === 2);
  assert.deepEqual(device.commands[1].data, { cmd: 'TIME_SYNC', utc_ms: 1794220000000 });
  device.reply(1);
  await sync;
});

test('incompatible INFO rejects connection before commands', async () => {
  for (const change of [{ protocol: 2 }, { max_command_bytes: 768 }, { max_message_bytes: 4097 }, { header_bytes: 9 }, { default_packet_bytes: 21 }]) {
    const device = new FakeDevice();
    device.infoData = { ...info, ...change };
    const client = new DjiBleClient({ bluetooth: { requestDevice: async () => device } });
    await assert.rejects(client.connect(), /invalid_info/);
    assert.equal(client.connected, false);
    assert.equal(device.writes.length, 0);
  }
});

test('regular requests and whole fragment writes serialize; errors surface without retries', async t => {
  const { client, device } = await connected(t);
  const first = client.request({ cmd: 'RESET_PROJECT', confirm: true });
  const rejected = assert.rejects(first, error => error.code === 'usb_only' && error.reply.ok === false);
  const second = client.request({ cmd: 'GET_STATUS' });
  await until(() => device.commands.length === 1);
  assert.equal(device.commands[0].data.cmd, 'RESET_PROJECT');
  await Promise.resolve();
  assert.equal(device.commands.length, 1);
  device.reply(0, { ok: false, error: 'usb_only' });
  await rejected;
  await until(() => device.commands.length === 2);
  device.reply(1);
  await second;
  assert.notEqual(device.commands[0].requestId, device.commands[1].requestId);
  assert.equal(device.commands.length, 2);
});

test('disconnect during queued chunk write prevents remainder and queued mutation, including after reconnect', async t => {
  const old = new FakeDevice(), next = new FakeDevice();
  const { client } = await connected(t, {}, [old, next]);
  old.writeGate = deferred();
  const first = client.request({ cmd: 'SELECT_ACTION', project_id: 'P', action_id: 'A' });
  const second = client.request({ cmd: 'START', project_id: 'P', command_id: 'never-executed' });
  const failures = [assert.rejects(first, /disconnected/), assert.rejects(second, /disconnected/)];
  await until(() => old.writes.length === 1);
  old.gatt.disconnect();
  await Promise.all(failures);
  await client.connect();
  old.writeGate.resolve();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(old.writes.length, 1);
  assert.equal(old.commands.length, 0);
  assert.equal(next.writes.length, 0);
});

test('old session handlers cannot resolve a new request with reused ID', async t => {
  const old = new FakeDevice(), next = new FakeDevice();
  const { client } = await connected(t, {}, [old, next]);
  const staleHandler = [...old.tx.listeners.get('characteristicvaluechanged')][0];
  const first = client.getStatus();
  const failed = assert.rejects(first, /disconnected/);
  await until(() => old.commands.length === 1);
  client.disconnect();
  await failed;
  await client.connect();
  let resolved = false;
  const second = client.getStatus().then(value => { resolved = true; return value; });
  await until(() => next.commands.length === 1);
  for (const packet of encodeMessage(KINDS.REPLY, next.commands[0].requestId, { ok: true, stale: true })) {
    old.tx.value = new DataView(packet.buffer);
    staleHandler({ target: old.tx });
  }
  await Promise.resolve();
  assert.equal(resolved, false);
  next.reply(0, { ok: true, stale: false });
  assert.equal((await second).stale, false);
});

test('fragmented unsolicited STATUS is delivered separately from request correlation', async t => {
  const statuses = [];
  const { client, device } = await connected(t, { onStatus: value => statuses.push(value) });
  const request = client.getStatus();
  await until(() => device.commands.length === 1);
  device.send(KINDS.STATUS, 0, { project_id: 'P', phase: 'recording', event_seq: 1 });
  assert.equal(statuses[0].phase, 'recording');
  device.reply();
  await request;
});

test('foreign request replies and invalid live fragments fail pending requests', async t => {
  for (const foreign of [true, false]) {
    const { client, device } = await connected(t);
    const pending = client.getStatus();
    const failed = assert.rejects(pending, error => error.code === (foreign ? 'foreign_request' : 'unsupported_protocol'));
    await until(() => device.commands.length === 1);
    if (foreign) device.send(KINDS.REPLY, 400, { ok: true });
    else {
      const packet = encodeMessage(KINDS.REPLY, device.commands[0].requestId, { ok: true })[0];
      packet[0] = 9;
      device.packet(packet);
    }
    await failed;
    assert.equal(client.connected, false);
  }
});

test('async event persistence is ordered, counted from raw bytes, and does not block STOP', async t => {
  const { client, device } = await connected(t);
  const gate = deferred(), seen = [], persisted = [];
  const events = [event(1), event(2)];
  const { promise, id } = await startLog(client, device, 0, async (value, context) => {
    seen.push(value.event_seq);
    assert.equal(context.after_seq, value.event_seq);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(context.raw)), value);
    if (value.event_seq === 1) await gate.promise;
    persisted.push(value.event_seq);
  });
  begin(device, id, events);
  for (const value of events) device.send(KINDS.LOG_EVENT, id, value);
  end(device, id, events);
  await until(() => seen.length === 1);
  assert.deepEqual(persisted, []);
  const stop = client.request({ cmd: 'STOP', project_id: 'P', take_id: 1 });
  await until(() => device.commands.length === 2);
  assert.equal(device.commands[1].data.cmd, 'STOP');
  device.reply(1);
  await stop;
  assert.deepEqual(persisted, []);
  gate.resolve();
  const result = await promise;
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(persisted, [1, 2]);
  assert.equal(result.after_seq, 2);
  assert.equal(result.sent_bytes, lineBytes(events));
});

test('raw JSON whitespace and UTF-8 JSONL bytes are validated, not reserialized bytes', async t => {
  const { client, device } = await connected(t);
  const value = event(1);
  const raw = utf8.encode(JSON.stringify(value).replace(/,/g, ', '));
  const { promise, id } = await startLog(client, device);
  begin(device, id, [value], 0, { bytes: raw.length + 1 });
  device.send(KINDS.LOG_EVENT, id, raw);
  end(device, id, [value], [value], { sent_bytes: raw.length + 1 });
  assert.equal((await promise).sent_bytes, raw.length + 1);
});

test('incremental and empty streams retain exact persisted cursors', async t => {
  for (const after of [0, 1, 2]) {
    const { client, device } = await connected(t);
    const all = after === 0 ? [] : [event(1), event(2)];
    const received = [];
    const { promise, id } = await startLog(client, device, after, async value => received.push(value.event_seq));
    begin(device, id, all, after);
    for (const value of all.slice(after)) device.send(KINDS.LOG_EVENT, id, value);
    end(device, id, all, all.slice(after));
    const result = await promise;
    assert.equal(result.after_seq, all.length);
    assert.deepEqual(received, all.slice(after).map(value => value.event_seq));
  }
});

test('foreign, corrupt, incomplete, count and byte mismatched logs never jump cursor', async t => {
  const cases = [
    { begin: { project_id: 'foreign' }, cursor: 0 },
    { begin: { after_seq: 1 }, cursor: 0 },
    { begin: { lines: 3 }, cursor: 0 },
    { events: [event(1, { project_id: 'foreign' })], cursor: 0 },
    { events: [event(1, { template_id: 'foreign' })], cursor: 0 },
    { events: [event(2)], cursor: 0 },
    { events: [event(1), event(1)], cursor: 1 },
    { events: [event(1)], cursor: 1 },
    { end: { sent_bytes: 1 }, cursor: 2 },
    { end: { sent_lines: 1 }, cursor: 2 },
    { end: { project_id: 'foreign' }, cursor: 2 },
    { end: { through_seq: 100 }, cursor: 2 },
    { end: { event_seq: 100 }, cursor: 2 },
    { end: { ok: false, error: 'read_failed' }, cursor: 2 },
    { begin: { bytes: lineBytes([event(1), event(2)]) + 1 }, cursor: 2 },
  ];
  for (const scenario of cases) {
    const { client, device } = await connected(t);
    const all = [event(1), event(2)], saved = [];
    const { outcome, id } = await startLog(client, device, 0, async value => saved.push(value.event_seq));
    begin(device, id, all, 0, scenario.begin);
    for (const value of scenario.events ?? all) device.send(KINDS.LOG_EVENT, id, value);
    end(device, id, all, all, scenario.end);
    const { error } = await outcome;
    assert.ok(error instanceof BleClientError, JSON.stringify(scenario));
    assert.equal(error.after_seq, scenario.cursor, JSON.stringify(scenario));
    assert.equal(saved.length, scenario.cursor);
    assert.equal(client.connected, false);
  }
});

test('missing/repeated BEGIN and EVENT after END reject stream', async t => {
  for (const scenario of ['missing', 'repeated', 'after-end']) {
    const { client, device } = await connected(t);
    const gate = deferred();
    const { outcome, id } = await startLog(client, device, 0, async () => gate.promise);
    const all = [event(1)];
    if (scenario !== 'missing') begin(device, id, all);
    if (scenario === 'repeated') begin(device, id, all);
    device.send(KINDS.LOG_EVENT, id, all[0]);
    if (scenario === 'after-end') {
      end(device, id, all);
      device.send(KINDS.LOG_EVENT, id, all[0]);
    }
    gate.resolve();
    assert.ok((await outcome).error instanceof BleClientError);
  }
});

test('failed persistence and disconnect during persistence expose last completed cursor', async t => {
  for (const disconnect of [false, true]) {
    const { client, device } = await connected(t);
    const gate = deferred(), all = [event(1), event(2)];
    let secondEntered = false;
    const { outcome, id } = await startLog(client, device, 0, async value => {
      if (value.event_seq === 2) {
        secondEntered = true;
        if (disconnect) await gate.promise;
        else throw new Error('storage quota');
      }
    });
    begin(device, id, all);
    device.send(KINDS.LOG_EVENT, id, all[0]);
    device.send(KINDS.LOG_EVENT, id, all[1]);
    if (disconnect) {
      await until(() => secondEntered);
      device.gatt.disconnect();
      gate.resolve();
    }
    const { error } = await outcome;
    assert.equal(error.after_seq, 1);
    assert.equal(error.code, disconnect ? 'disconnected' : 'log_failed');
  }
});

test('bounded asynchronous event backlog disconnects rather than dropping events', async t => {
  const { client, device } = await connected(t, { maxEventBacklog: 2 });
  const gate = deferred(), all = [event(1), event(2), event(3)];
  const { outcome, id } = await startLog(client, device, 0, async () => gate.promise);
  begin(device, id, all);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  device.send(KINDS.LOG_EVENT, id, all[0]);
  device.send(KINDS.LOG_EVENT, id, all[1]);
  device.send(KINDS.LOG_EVENT, id, all[2]);
  const { error } = await outcome;
  assert.equal(error.code, 'event_backlog_full');
  assert.equal(error.after_seq, 0);
  gate.resolve();
});

test('queued timeout removes mutation without scheduling it later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, device } = await connected(t, { timeoutMs: 1000 });
  const first = client.getStatus();
  const second = client.request({ cmd: 'START', project_id: 'P', command_id: 'expired' }, { timeoutMs: 10 });
  const expired = assert.rejects(second, /timeout/);
  await until(() => device.commands.length === 1);
  t.mock.timers.tick(11);
  await expired;
  device.reply();
  await first;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(device.commands.length, 1);
  assert.equal(client.connected, true);
});

test('in-flight write timeout disconnects and late resolution cannot write remaining chunks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, device } = await connected(t, { timeoutMs: 10 });
  device.writeGate = deferred();
  const pending = client.request({ cmd: 'SELECT_ACTION', project_id: 'P', action_id: 'A' });
  const timedOut = assert.rejects(pending, /timeout/);
  await until(() => device.writes.length === 1);
  t.mock.timers.tick(11);
  await timedOut;
  device.writeGate.resolve();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(device.writes.length, 1);
  assert.equal(device.commands.length, 0);
  assert.equal(client.connected, false);
});

test('request idle timeout includes write progress and stream fragment progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, device } = await connected(t, { timeoutMs: 10 });
  const all = [event(1)];
  const { promise, id } = await startLog(client, device);
  const messages = [
    [KINDS.LOG_BEGIN, { project_id: 'P', template_id: 'T', event_seq: 1, take_id: 0, lines: 1, bytes: lineBytes(all), after_seq: 0 }],
    [KINDS.LOG_EVENT, all[0]],
    [KINDS.LOG_END, { ok: true, project_id: 'P', event_seq: 1, through_seq: 1, sent_lines: 1, sent_bytes: lineBytes(all) }],
  ];
  for (const [kind, value] of messages) {
    for (const packet of encodeMessage(kind, id, value)) {
      t.mock.timers.tick(9);
      device.packet(packet);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
  }
  assert.equal((await promise).after_seq, 1);
  assert.equal(client.connected, true);
});

test('write failure rejects pending and queued work without background rejection', async t => {
  const { client, device } = await connected(t);
  device.writeError = new Error('radio failure');
  const first = client.getStatus(), second = client.syncTime(1);
  await Promise.all([
    assert.rejects(first, error => error.code === 'write_failed' && error.cause.message === 'radio failure'),
    assert.rejects(second, /write_failed/),
  ]);
  assert.equal(device.writes.length, 1);
  assert.equal(client.connected, false);
});

test('each completed chunk write refreshes idle timeout, not a fixed whole-command deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, device } = await connected(t, { timeoutMs: 10 });
  const originalWrite = device.rx.writeValueWithResponse;
  device.rx.writeValueWithResponse = async packet => {
    await new Promise(resolve => setTimeout(resolve, 9));
    await originalWrite(packet);
  };
  const command = { cmd: 'SELECT_ACTION', project_id: 'P', action_id: 'A' };
  const pending = client.request(command);
  const count = encodeMessage(KINDS.COMMAND, 1, command).length;
  for (let i = 0; i < count; i++) {
    t.mock.timers.tick(9);
    await until(() => device.writes.length === i + 1);
    for (let n = 0; n < 5; n++) await Promise.resolve();
  }
  await until(() => device.commands.length === 1);
  device.reply();
  assert.equal((await pending).ok, true);
  assert.equal(client.connected, true);
});

test('partial stream timeout reports persisted cursor instead of frozen through_seq', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, device } = await connected(t, { timeoutMs: 10 });
  const all = [event(1), event(2)];
  let persisted = false;
  const { outcome, id } = await startLog(client, device, 0, async () => { persisted = true; });
  begin(device, id, all);
  device.send(KINDS.LOG_EVENT, id, all[0]);
  await until(() => persisted);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(11);
  const { error } = await outcome;
  assert.equal(error.code, 'timeout');
  assert.equal(error.after_seq, 1);
  assert.equal(client.connected, false);
});

test('slow status consumer retains latest snapshot and does not block command replies', async t => {
  const gate = deferred(), statuses = [];
  const { client, device } = await connected(t, { onStatus: async value => {
    statuses.push(value.event_seq);
    if (value.event_seq === 1) await gate.promise;
  } });
  for (let i = 1; i <= 100; i++) device.send(KINDS.STATUS, 0, { event_seq: i });
  assert.deepEqual(statuses, [1]);
  const pending = client.getStatus();
  await until(() => device.commands.length === 1);
  device.reply();
  await pending;
  gate.resolve();
  await until(() => statuses.length === 2);
  assert.deepEqual(statuses, [1, 100]);
});

test('async callback failures are surfaced and do not create unhandled background rejection', async t => {
  const errors = [];
  const { client, device } = await connected(t, {
    onStatus: async () => { throw new Error('status render failed'); },
    onError: error => errors.push(error),
  });
  device.send(KINDS.STATUS, 0, { event_seq: 0 });
  await until(() => errors.length === 1);
  assert.equal(errors[0].code, 'callback_failed');
  assert.equal(errors[0].cause.message, 'status render failed');
  const pending = client.getStatus();
  await until(() => device.commands.length === 1);
  device.reply();
  await pending;
});

test('disconnect during connection setup closes a late GATT link and never issues commands', async t => {
  const device = new FakeDevice(), gate = deferred();
  const connect = device.gatt.connect;
  device.gatt.connect = async () => { await gate.promise; return await connect(); };
  const client = new DjiBleClient({ bluetooth: { requestDevice: async () => device } });
  t.after(() => client.disconnect());
  const pending = client.connect();
  const failed = assert.rejects(pending, /disconnected/);
  await until(() => device.listeners.get('gattserverdisconnected')?.size === 1);
  client.disconnect();
  gate.resolve();
  await failed;
  assert.equal(client.connected, false);
  assert.equal(device.gatt.connected, false);
  assert.equal(device.writes.length, 0);
});
