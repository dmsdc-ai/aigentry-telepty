'use strict';
// Task 1215 owner191 — DIAGNOSTIC-ONLY preload: which writable stream owned the fatal unhandled 'error', and in which
// process. Never loaded by the product. The test harness loads it ONLY on explicit opt-in
// (TELEPTY_EPIPE_OWNER_DIAGNOSTIC_DIR), as `node --require <this file> daemon.js`. child_process.fork() inherits
// execArgv, so forked descendants (node-pty's conpty_console_list_agent, ledger owners) load it too and attribute their
// own events under their own pid.
//
// It installs only when TELEPTY_EPIPE_OWNER_DIR names an existing absolute directory, and only on the main thread.
// Otherwise requiring it changes nothing and only exports the pure helpers below.
//
// Installed, it adds exactly:
//   1. Stream.prototype.emit (own property; it resolved to EventEmitter.prototype.emit before): for an 'error' emitted
//      while the stream has ZERO 'error' listeners, it records the owner, then calls the original emit with the same
//      receiver and arguments and returns or throws exactly what that returns or throws. Handled errors are not
//      recorded. No listener is added and nothing is caught or repaired.
//   2. Writable/Duplex/net.Socket prototype `write` (own properties only): the FIRST write on each stream records its
//      package-relative call site in a WeakMap, then calls the original unchanged. That call site is the owner evidence:
//      the error itself carries no stream reference, and Node's banner only says "Socket".
//   3. process 'uncaughtExceptionMonitor' and 'exit' listeners. Both are passive: they do not prevent the crash or change
//      the exit code.
//
// Records are fixed-shape and allowlisted: pid/ppid/role, error name/code/syscall/errno, stream constructor chain,
// handle type, stdio fd1/fd2, readable/writable/destroyed flags, accepted-by-server, and a bounded normalized call site
// (function @ package-relative file:line). Never a payload, chunk, URL, address, environment, user path or token.
// They are written synchronously (fs.appendFileSync, never a stream) to <dir>/owner-<pid>.jsonl, at most RECORD_MAX bytes each
// and PROCESS_MAX per process. Diagnostic I/O failures are ignored so the monitor never adds its own failure.
//
// Timing limits:
//   - the emit record is written synchronously just before the original emit throws, so a crash cannot lose it;
//   - the first-write site is the first writer, not necessarily the writer of the failing chunk;
//   - streams written only by internal native code have no site;
//   - an 'error' that never passes through Stream.prototype.emit (a Worker or IPC error, or a subclass's own emit) is seen
//     only by the uncaught monitor, as `matched_stream_record: null`.
const fs = require('node:fs');
const path = require('node:path');

const RECORD_MAX = 8192, PROCESS_MAX = 65536, FRAMES_MAX = 8, STACK_LIMIT = 16;
const REPO_ROOT = path.resolve(__dirname, '..');
const SELF = __filename;

const token = (value, pattern = /^[A-Za-z0-9_:.-]{1,64}$/) => (typeof value === 'string' && pattern.test(value) ? value : value === undefined || value === null ? null : 'other');
const int = (value) => (Number.isInteger(value) ? value : null);

function normalizeFile(file) {
  if (typeof file !== 'string' || file.length === 0) return '<unknown>';
  if (file.startsWith('node:')) return /^node:[a-z_/]{1,64}$/.test(file) ? file : 'node:<other>';
  let text = file;
  if (text.startsWith('file://')) { try { text = require('node:url').fileURLToPath(text); } catch { return '<unknown>'; } }
  text = text.replace(/\\/g, '/');
  if (text === '[eval]' || text.startsWith('evalmachine')) return '<eval>';
  const safe = (relative) => (/^[A-Za-z0-9._@/-]{1,160}$/.test(relative) ? relative : '<unsafe>');
  const modules = text.lastIndexOf('/node_modules/');
  if (modules >= 0) return safe(text.slice(modules + '/node_modules/'.length));
  const root = `${REPO_ROOT.replace(/\\/g, '/')}/`;
  if (text.toLowerCase().startsWith(root.toLowerCase())) return `repo/${safe(text.slice(root.length))}`;
  return '<external>';
}
// "    at fn (file:line:col)" / "    at file:line:col" -> "fn @ normalized:line"; preload frames are skipped.
function normalizeFrames(stack, max = FRAMES_MAX) {
  const out = [];
  for (const line of String(stack || '').split('\n').slice(1)) {
    const match = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (!match) continue;
    const file = match[2];
    if (file.replace(/\\/g, '/') === SELF.replace(/\\/g, '/')) continue;
    const fn = match[1] && /^[\w$.<>[\] ]{1,80}$/.test(match[1]) ? match[1] : '<anonymous>';
    out.push(`${fn} @ ${normalizeFile(file)}:${match[3]}`);
    if (out.length >= max) break;
  }
  return out;
}
function roleFor(env, ppid) {
  const parent = Number(env && env.TELEPTY_EPIPE_OWNER_PARENT_PID);
  return Number.isInteger(parent) && parent > 0 && ppid === parent ? 'daemon' : 'descendant';
}
function constructorChain(object) {
  const names = [];
  for (let proto = Object.getPrototypeOf(object); proto && names.length < 4; proto = Object.getPrototypeOf(proto)) {
    const name = proto.constructor && proto.constructor.name;
    names.push(token(name, /^[A-Za-z_$][\w$]{0,63}$/) || '<anonymous>');
  }
  return names;
}

const state = { installed: false, dir: null, bytes: 0, full: false, seq: 0, events: 0, role: null,
  writeSites: new WeakMap(), errorSeq: new WeakMap() };

function writeRecord(record) {
  if (!state.installed || state.full) return;
  try {
    let line = JSON.stringify(record);
    if (Buffer.byteLength(line) > RECORD_MAX && record.stream) { record.stream.first_write_site = ['<dropped: record bound>']; line = JSON.stringify(record); }
    if (Buffer.byteLength(line) > RECORD_MAX) line = JSON.stringify({ event: record.event, seq: record.seq, pid: process.pid, truncated: true });
    line += '\n';
    if (state.bytes + Buffer.byteLength(line) > PROCESS_MAX) {
      state.full = true;
      line = `${JSON.stringify({ event: 'bound_reached', pid: process.pid, bytes: state.bytes })}\n`;
      if (state.bytes + Buffer.byteLength(line) > PROCESS_MAX) return;
    }
    // Open-append-close per record (records are rare): no handle stays open inside the private directory.
    fs.appendFileSync(path.join(state.dir, `owner-${process.pid}.jsonl`), line, { mode: 0o600 });
    state.bytes += Buffer.byteLength(line);
  } catch { /* diagnostic I/O only: never add a failure of its own */ }
}
function base(event) {
  return { event, seq: ++state.seq, wall_ms: Date.now(), pid: process.pid, ppid: process.ppid, role: state.role };
}
function errorShape(error) {
  const object = error !== null && typeof error === 'object';
  return { name: object ? token(error.name, /^[A-Za-z_$][\w$]{0,63}$/) : 'non_object', code: object ? token(error.code, /^[A-Z0-9_]{1,48}$/) : null,
    syscall: object ? token(error.syscall, /^[a-z_]{1,32}$/) : null, errno: object ? int(error.errno) : null };
}
function streamShape(stream) {
  const handle = stream && stream._handle;
  const stdio = stream && stream._isStdio === true;
  const site = state.writeSites.get(stream);
  return { constructor: constructorChain(stream), handle: handle && handle.constructor ? token(handle.constructor.name, /^[A-Za-z_$][\w$]{0,63}$/) : null,
    is_stdio: stdio, stdio_fd: stdio && (stream.fd === 1 || stream.fd === 2) ? `fd${stream.fd}` : null,
    readable: stream.readable === true, writable: stream.writable === true, destroyed: stream.destroyed === true,
    accepted_by_server: Boolean(stream.server), first_write_site: site ? site.frames : null, first_write_wall_ms: site ? site.wall_ms : null };
}

function install() {
  const dir = process.env.TELEPTY_EPIPE_OWNER_DIR;
  let isMain = true;
  try { isMain = require('node:worker_threads').isMainThread; } catch { isMain = true; }
  if (!isMain || typeof dir !== 'string' || !path.isAbsolute(dir)) return;
  try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
  const stream = require('node:stream');
  const net = require('node:net');
  state.dir = dir;
  state.role = roleFor(process.env, process.ppid);
  state.installed = true;

  const originalEmit = stream.Stream.prototype.emit;
  const emitDescriptor = Object.getOwnPropertyDescriptor(require('node:events').EventEmitter.prototype, 'emit') || { writable: true, enumerable: true, configurable: true };
  Object.defineProperty(stream.Stream.prototype, 'emit', { ...emitDescriptor, value: function emit(type) {
    if (type === 'error' && state.installed) {
      try {
        if (this.listenerCount('error') === 0) {
          const error = arguments[1];
          const record = { ...base('unhandled_stream_error'), error: errorShape(error), stream: streamShape(this) };
          if (error !== null && typeof error === 'object') state.errorSeq.set(error, record.seq);
          state.events++;
          writeRecord(record);
        }
      } catch { /* recording only */ }
    }
    return Reflect.apply(originalEmit, this, arguments);
  } });

  const wrapped = new Set();
  for (const proto of [stream.Writable.prototype, stream.Duplex.prototype, net.Socket.prototype]) {
    if (!Object.hasOwn(proto, 'write') || typeof proto.write !== 'function' || wrapped.has(proto.write)) continue;
    const originalWrite = proto.write;
    const write = function write() {
      if (state.installed && this !== null && typeof this === 'object' && !state.writeSites.has(this)) {
        try {
          const holder = {};
          const limit = Error.stackTraceLimit;
          try { Error.stackTraceLimit = STACK_LIMIT; Error.captureStackTrace(holder, write); } finally { Error.stackTraceLimit = limit; }
          state.writeSites.set(this, { frames: normalizeFrames(holder.stack), wall_ms: Date.now() });
        } catch { /* recording only */ }
      }
      return Reflect.apply(originalWrite, this, arguments);
    };
    wrapped.add(write);
    Object.defineProperty(proto, 'write', { ...Object.getOwnPropertyDescriptor(proto, 'write'), value: write });
  }

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    state.events++;
    const matched = error !== null && typeof error === 'object' && state.errorSeq.has(error) ? state.errorSeq.get(error) : null;
    writeRecord({ ...base('uncaught'), origin: token(origin, /^[a-zA-Z]{1,32}$/), error: errorShape(error), matched_stream_record: matched });
  });
  process.on('exit', (code) => { if (code !== 0 || state.events > 0) writeRecord({ ...base('exit'), code: int(code) }); });
  writeRecord({ ...base('start'), node: token(process.version, /^v\d+\.\d+\.\d+$/), entry: normalizeFile(process.argv[1]) });
}

try { install(); } catch { state.installed = false; }

module.exports = { normalizeFile, normalizeFrames, roleFor, installed: () => state.installed, LIMITS: { RECORD_MAX, PROCESS_MAX, FRAMES_MAX } };
