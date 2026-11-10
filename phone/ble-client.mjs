// Browser-native ESM; no UI, automatic reconnect, retry, or camera commands.
export const UUIDS = Object.freeze({
  service: '749d1000-7fbe-4dbf-9f6a-307ca69c6bc5',
  rx: '749d1001-7fbe-4dbf-9f6a-307ca69c6bc5',
  tx: '749d1002-7fbe-4dbf-9f6a-307ca69c6bc5',
  info: '749d1003-7fbe-4dbf-9f6a-307ca69c6bc5',
});
export const KINDS = Object.freeze({ COMMAND: 0, REPLY: 1, STATUS: 2, LOG_BEGIN: 3, LOG_EVENT: 4, LOG_END: 5 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HEADER = 8;
const MAX_COMMAND = 767;
const MAX_MESSAGE = 4096;

export class BleClientError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'BleClientError';
    this.code = code;
    Object.assign(this, details);
  }
}
const fault = (code, details) => new BleClientError(code, code, details);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw fault('invalid_bytes');
}
function validateHeader(kind, requestId, total) {
  if (!Number.isInteger(kind) || kind < 0 || kind > 5 ||
      !Number.isInteger(requestId) || requestId < 0 || requestId > 65535 ||
      (kind === KINDS.STATUS ? requestId !== 0 : requestId === 0) ||
      !Number.isInteger(total) || total < 1 || total > (kind === KINDS.COMMAND ? MAX_COMMAND : MAX_MESSAGE)) {
    throw fault('invalid_header');
  }
}

// Uint8Array input preserves exact original bytes (not JSON reserialization).
export function encodeMessage(kind, requestId, value, { packetBytes = 20 } = {}) {
  const bytes = value instanceof ArrayBuffer || ArrayBuffer.isView(value)
    ? bytesOf(value) : encoder.encode(JSON.stringify(value));
  validateHeader(kind, requestId, bytes.length);
  if (!Number.isInteger(packetBytes) || packetBytes <= HEADER || packetBytes > 512) throw fault('invalid_packet_size');
  const packets = [];
  for (let offset = 0; offset < bytes.length; offset += packetBytes - HEADER) {
    const count = Math.min(packetBytes - HEADER, bytes.length - offset);
    const packet = new Uint8Array(HEADER + count);
    const header = new DataView(packet.buffer);
    header.setUint8(0, 1);
    header.setUint8(1, kind);
    header.setUint16(2, requestId, true);
    header.setUint16(4, offset, true);
    header.setUint16(6, bytes.length, true);
    packet.set(bytes.subarray(offset, offset + count), HEADER);
    packets.push(packet);
  }
  return packets;
}

export class MessageReassembler {
  constructor() { this.reset(); }
  reset() { this.partial = null; }
  push(value) {
    try {
      const packet = bytesOf(value);
      if (packet.length <= HEADER || packet.length > 512) throw fault('invalid_fragment');
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      const kind = view.getUint8(1), requestId = view.getUint16(2, true);
      const offset = view.getUint16(4, true), total = view.getUint16(6, true);
      if (view.getUint8(0) !== 1) throw fault('unsupported_protocol');
      validateHeader(kind, requestId, total);
      const count = packet.length - HEADER;
      if (offset + count > total) throw fault('invalid_fragment');
      if (offset === 0) {
        if (this.partial) throw fault('interleaved_message');
        this.partial = { kind, requestId, total, offset: 0, bytes: new Uint8Array(total) };
      }
      const part = this.partial;
      if (!part || part.kind !== kind || part.requestId !== requestId || part.total !== total || part.offset !== offset) {
        throw fault('noncontiguous_fragment');
      }
      part.bytes.set(packet.subarray(HEADER), offset);
      part.offset += count;
      if (part.offset !== total) return null;
      this.reset();
      const text = decoder.decode(part.bytes);
      const data = JSON.parse(text);
      if (!object(data)) throw fault('invalid_json_object');
      return { kind, requestId, data, bytes: part.bytes, text };
    } catch (error) {
      this.reset();
      if (error instanceof BleClientError) throw error;
      throw fault('invalid_json', { cause: error });
    }
  }
}

export class DjiBleClient {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, timeoutMs = 15000,
    packetBytes = 20, maxEventBacklog = 32, onStatus, onConnection, onError } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(packetBytes) ||
        packetBytes <= HEADER || packetBytes > 512 || !Number.isInteger(maxEventBacklog) ||
        maxEventBacklog < 1 || maxEventBacklog > 256) throw fault('invalid_options');
    this.bluetooth = bluetooth;
    this.timeoutMs = timeoutMs;
    this.packetBytes = packetBytes;
    this.maxEventBacklog = maxEventBacklog;
    this.onStatus = onStatus;
    this.onConnection = onConnection;
    this.onError = onError;
    this.session = null;
  }
  get connected() { return Boolean(this.session?.ready && this.session.active); }
  _notify(name, value) {
    const callback = this[name];
    if (typeof callback !== 'function') return;
    try {
      Promise.resolve(callback(value)).catch(error => this._callbackError(name, error));
    } catch (error) { this._callbackError(name, error); }
  }
  _callbackError(name, error) {
    if (name === 'onError') console.error('BLE onError callback failed', error);
    else this._notify('onError', fault('callback_failed', { cause: error, callback: name }));
  }
  async connect() {
    if (this.session) throw fault('already_connected_or_connecting');
    if (!this.bluetooth?.requestDevice) throw fault('web_bluetooth_unavailable');
    const session = { active: true, ready: false, pending: new Map(), queue: [], pumping: false,
      nextId: 1, parser: new MessageReassembler(), stream: null };
    this.session = session;
    const check = () => {
      if (this.session === session && session.active) return;
      // A browser connect() may complete after disconnect() cancelled setup.
      // Close that late link unless a new session now owns the same device.
      if (session.device?.gatt?.connected && this.session?.device !== session.device) {
        try { session.device.gatt.disconnect(); }
        catch (error) { this._notify('onError', error); }
      }
      throw fault('disconnected');
    };
    try {
      session.device = await this.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }] });
      check();
      session.onDisconnect = () => this._close(session, fault('disconnected'));
      session.device.addEventListener('gattserverdisconnected', session.onDisconnect);
      const server = await session.device.gatt.connect();
      check();
      const service = await server.getPrimaryService(UUIDS.service);
      check();
      session.rx = await service.getCharacteristic(UUIDS.rx);
      check();
      session.tx = await service.getCharacteristic(UUIDS.tx);
      check();
      const infoCharacteristic = await service.getCharacteristic(UUIDS.info);
      check();
      const infoBytes = bytesOf(await infoCharacteristic.readValue());
      check();
      if (infoBytes.length > MAX_MESSAGE) throw fault('invalid_info');
      const info = JSON.parse(decoder.decode(infoBytes));
      if (!object(info) || info.protocol !== 1 || info.header_bytes !== HEADER ||
          info.max_command_bytes !== MAX_COMMAND || info.max_message_bytes !== MAX_MESSAGE ||
          info.default_packet_bytes !== 20 || typeof session.rx.writeValueWithResponse !== 'function') throw fault('invalid_info');
      session.onValue = event => {
        if (this.session !== session || !session.active || !session.ready || event.target !== session.tx) return;
        try { this._receive(session, event.target.value); }
        catch (error) { this._close(session, error); }
      };
      session.tx.addEventListener('characteristicvaluechanged', session.onValue);
      await session.tx.startNotifications();
      check();
      session.ready = true;
      this._notify('onConnection', { connected: true, deviceId: session.device.id });
      return Object.freeze(info);
    } catch (error) {
      this._close(session, error);
      throw error;
    }
  }
  disconnect() {
    if (this.session) this._close(this.session, fault('disconnected'));
  }
  _close(session, error) {
    if (!session.active) return;
    if (!(error instanceof Error)) error = fault('transport_failed', { cause: error });
    session.active = false;
    session.ready = false;
    session.parser.reset();
    session.queue.length = 0;
    if (this.session === session) this.session = null;
    if (session.tx && session.onValue) session.tx.removeEventListener('characteristicvaluechanged', session.onValue);
    if (session.device && session.onDisconnect) session.device.removeEventListener('gattserverdisconnected', session.onDisconnect);
    for (const job of session.pending.values()) this._finish(session, job, error);
    try { session.device?.gatt?.disconnect(); }
    catch (cause) { this._notify('onError', cause); }
    this._notify('onConnection', { connected: false, error });
    if (error.code !== 'disconnected') this._notify('onError', error);
  }
  _touch(session, job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (!session.pending.has(job.id)) return;
      const error = fault('timeout', { request_id: job.id });
      // An unsent queued mutation can simply be removed. An in-flight partial
      // message/stream requires disconnect so its remainder cannot execute later.
      if (job.started) this._close(session, error);
      else this._finish(session, job, error);
    }, job.timeoutMs);
  }
  _finish(session, job, error, result) {
    if (!session.pending.delete(job.id)) return;
    clearTimeout(job.timer);
    if (session.stream === job) session.stream = null;
    if (job.log) {
      job.log.queue.length = 0;
      if (error) {
        error = new BleClientError(error.code || 'log_failed', error.message, {
          cause: error, reply: error.reply, request_id: job.id, after_seq: job.log.cursor,
        });
      }
    }
    job.doneResolve();
    if (error) job.reject(error); else job.resolve(result);
  }
  _enqueue(command, options, log) {
    const session = this.session;
    if (!session?.active || !session.ready) return Promise.reject(fault('disconnected'));
    if (!object(command) || typeof command.cmd !== 'string') return Promise.reject(fault('invalid_command'));
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(fault('invalid_timeout'));
    if (session.pending.size >= 32) return Promise.reject(fault('request_backlog_full'));
    if (session.nextId > 65535) return Promise.reject(fault('request_ids_exhausted'));
    if (log && session.stream) return Promise.reject(fault('log_busy', { after_seq: log.cursor }));
    const id = session.nextId++;
    let packets;
    try { packets = encodeMessage(KINDS.COMMAND, id, command, { packetBytes: this.packetBytes }); }
    catch (error) { return Promise.reject(error); }
    const promise = new Promise((resolve, reject) => {
      const job = { id, packets, timeoutMs, log, resolve, reject, started: false };
      job.done = new Promise(doneResolve => { job.doneResolve = doneResolve; });
      session.pending.set(id, job);
      if (log) session.stream = job;
      session.queue.push(job);
      this._touch(session, job);
    });
    // _pump handles all transport errors and never rejects in the background.
    void this._pump(session);
    return promise;
  }
  async _pump(session) {
    if (session.pumping) return;
    session.pumping = true;
    try {
      while (session.active && session.queue.length) {
        const job = session.queue.shift();
        if (!session.pending.has(job.id)) continue;
        job.started = true;
        this._touch(session, job);
        for (const packet of job.packets) {
          if (!session.active || !session.pending.has(job.id)) break;
          await session.rx.writeValueWithResponse(packet);
          if (!session.active || !session.pending.has(job.id)) break;
          this._touch(session, job);
        }
        if (!job.log && session.active) await job.done;
      }
    } catch (cause) { this._close(session, fault('write_failed', { cause })); }
    finally { session.pumping = false; }
  }
  request(command, options) {
    if (command?.cmd === 'GET_LOG') return Promise.reject(fault('use_sync_log'));
    return this._enqueue(command, options);
  }
  getStatus(options) { return this.request({ cmd: 'GET_STATUS' }, options); }
  syncTime(utcMs = Date.now(), options) { return this.request({ cmd: 'TIME_SYNC', utc_ms: utcMs }, options); }
  syncLog(afterSeq, projectId, onEvent, options) {
    if (!uint(afterSeq) || typeof projectId !== 'string' || !projectId || typeof onEvent !== 'function') {
      return Promise.reject(fault('invalid_log_arguments', { after_seq: afterSeq }));
    }
    const log = { cursor: afterSeq, after: afterSeq, projectId, onEvent, snapshot: null,
      lines: 0, bytes: 0, queue: [], backlogBytes: 0, draining: false, endReceived: false };
    return this._enqueue({ cmd: 'GET_LOG', project_id: projectId, after_seq: afterSeq }, options, log)
      .catch(error => {
        if (error.after_seq === undefined) error.after_seq = log.cursor;
        throw error;
      });
  }
  async _deliverStatus(session, value) {
    session.latestStatus = value;
    if (session.statusBusy) return;
    session.statusBusy = true;
    try {
      while (session.active && session.latestStatus) {
        const status = session.latestStatus;
        session.latestStatus = null;
        if (typeof this.onStatus === 'function') {
          try { await this.onStatus(status); }
          catch (error) { this._callbackError('onStatus', error); }
        }
      }
    } finally { session.statusBusy = false; }
  }
  _receive(session, value) {
    const message = session.parser.push(value);
    // Valid fragments are progress too: a 4 KiB event needs hundreds of ATT writes.
    if (!message) {
      const part = session.parser.partial;
      const job = session.pending.get(part.requestId);
      if (part.kind !== KINDS.STATUS) {
        if (!job?.started) throw fault('foreign_request');
        this._touch(session, job);
      }
      return;
    }
    const { kind, requestId, data } = message;
    if (kind === KINDS.STATUS) { void this._deliverStatus(session, data); return; }
    const job = session.pending.get(requestId);
    if (!job?.started) throw fault('foreign_request');
    this._touch(session, job);
    if (kind === KINDS.REPLY) {
      if (typeof data.ok !== 'boolean') throw fault('invalid_reply');
      if (!data.ok) {
        const error = fault(typeof data.error === 'string' ? data.error : 'request_rejected', { reply: data, request_id: requestId });
        if (job.log) this._close(session, error);
        else this._finish(session, job, error);
      } else if (job.log) throw fault('unexpected_log_reply');
      else this._finish(session, job, null, data);
      return;
    }
    if (!job.log || kind < KINDS.LOG_BEGIN || kind > KINDS.LOG_END) throw fault('unexpected_message_kind');
    const log = job.log;
    if (log.endReceived) throw fault('message_after_log_end');
    if (log.queue.length + (log.draining ? 1 : 0) >= this.maxEventBacklog ||
        log.backlogBytes + message.bytes.length > MAX_MESSAGE * this.maxEventBacklog) throw fault('event_backlog_full');
    if (kind === KINDS.LOG_END) log.endReceived = true;
    log.queue.push(message);
    log.backlogBytes += message.bytes.length;
    void this._drainLog(session, job);
  }
  async _drainLog(session, job) {
    const log = job.log;
    if (log.draining) return;
    log.draining = true;
    try {
      while (session.active && session.pending.has(job.id) && log.queue.length) {
        const message = log.queue.shift();
        await this._logMessage(session, job, message);
        log.backlogBytes -= message.bytes.length;
        if (session.pending.has(job.id)) this._touch(session, job);
      }
    } catch (error) { this._close(session, error); }
    finally { log.draining = false; }
  }
  async _logMessage(session, job, { kind, data, bytes }) {
    const log = job.log;
    if (kind === KINDS.LOG_BEGIN) {
      if (log.snapshot || data.project_id !== log.projectId || data.after_seq !== log.after ||
          typeof data.template_id !== 'string' || !uint(data.event_seq) || data.event_seq < log.after ||
          !uint(data.take_id) || !uint(data.lines) || !uint(data.bytes) || data.lines !== data.event_seq ||
          (data.lines === 0 ? data.bytes !== 0 : data.bytes < data.lines * 2)) throw fault('invalid_log_begin');
      log.snapshot = Object.freeze({ ...data });
      return;
    }
    const snapshot = log.snapshot;
    if (!snapshot) throw fault('missing_log_begin');
    if (kind === KINDS.LOG_EVENT) {
      if (data.project_id !== log.projectId || data.template_id !== snapshot.template_id ||
          data.event_seq !== log.cursor + 1 || data.event_seq > snapshot.event_seq ||
          bytes.includes(10) || bytes.includes(13) || log.bytes + bytes.length + 1 > snapshot.bytes ||
          log.lines + 1 > snapshot.lines) throw fault('invalid_log_event');
      const next = data.event_seq;
      // Persist the event before (or atomically with) its project cursor.
      await log.onEvent(data, { project_id: log.projectId, after_seq: next, raw: bytes.slice() });
      if (!session.active || !session.pending.has(job.id)) return;
      log.cursor = next;
      log.lines++;
      log.bytes += bytes.length + 1;
      return;
    }
    if (kind !== KINDS.LOG_END || typeof data.ok !== 'boolean' || data.project_id !== log.projectId ||
        data.event_seq !== snapshot.event_seq || data.through_seq !== snapshot.event_seq ||
        !uint(data.sent_lines) || !uint(data.sent_bytes) || data.sent_lines !== log.lines || data.sent_bytes !== log.bytes) {
      throw fault('invalid_log_end');
    }
    if (!data.ok) throw fault(typeof data.error === 'string' ? data.error : 'log_failed', { reply: data });
    if (log.cursor !== snapshot.event_seq || log.lines !== snapshot.event_seq - log.after ||
        (log.after === 0 && (log.lines !== snapshot.lines || log.bytes !== snapshot.bytes))) throw fault('incomplete_log');
    this._finish(session, job, null, { after_seq: log.cursor, snapshot, sent_lines: log.lines, sent_bytes: log.bytes });
  }
}
