'use strict';

// Test support for the pure/fake-IO gate (#1207): drives the ledger OWNER in-process through its
// message interface, with no worker_threads, no daemon, no socket. Real filesystem under a private
// temp directory unless a fault-injecting `fsImpl` is supplied. Not shipped (test/fixtures only).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('../../../src/session-store/ledger-owner');
const lock = require('../../../src/session-store/ledger-lock');

function createOwnerHarness({ dir, token = crypto.randomBytes(8).toString('hex'), pid = process.pid, fsImpl = fs, acquire = true, lockFs = fs, ...opts } = {}) {
  if (!dir) throw new TypeError('owner-harness: dir required');
  const lockPath = opts.lockPath || path.join(path.dirname(dir), 'tracked-injections.lock');
  const lockResult = acquire ? lock.acquire(lockPath, { pid, token }, lockFs) : null;
  const messages = [];
  const waiters = new Map();
  let seq = 0;
  // Timing stamp (resume4): a JSON-safe Number of nanoseconds since this harness was created —
  // monotonic (process.hrtime) and exact below 2^53 ns, so ordering assertions keep ns precision
  // and assertion diagnostics may JSON.stringify a message. (The previous BigInt `_hr` made every
  // eagerly-evaluated `JSON.stringify(message)` diagnostic throw — measured as 5 spurious failures.)
  const T0 = process.hrtime.bigint();
  function key(m) {
    if (m.type === 'ack' || m.type === 'nack') return `txn:${m.txn}`;
    if (m.type === 'read_chunk' || m.type === 'resolve_chunk' || m.type === 'snapshot_chunk') return `req:${m.req}`;
    if (m.type === 'closed') return 'closed';
    return null;
  }
  function fire(k, m) { const list = waiters.get(k); if (!list) return; waiters.delete(k); for (const r of list) r(m); }
  function post(m) {
    const stamped = { ...m, _seq: ++seq, _hr_ns: Number(process.hrtime.bigint() - T0) };
    messages.push(stamped);
    if (m.type === 'indeterminate') for (const txn of m.txns || []) fire(`txn:${txn}`, { ...stamped, txn });
    const k = key(m); if (k) fire(k, stamped);
  }
  function waitFor(k) { return new Promise((resolve) => { if (!waiters.has(k)) waiters.set(k, []); waiters.get(k).push(resolve); }); }
  const store = createStore({ dir, lockPath, token, pid, fsImpl, post, ...opts });

  /** Synchronous: the owner's open (migration/recovery/snapshot) is synchronous in-process. */
  function open(liveSids = []) {
    const before = messages.length;
    store.handle({ type: 'open', live_sids: liveSids, req: 'snapshot' });
    const snapshot = [];
    for (;;) {
      const chunk = messages.slice(before).filter((m) => m.type === 'snapshot_chunk').pop();
      if (!chunk) break;
      for (const item of chunk.items || []) snapshot.push(item);
      if (chunk.last) break;
      const n = messages.length;
      store.handle({ type: 'chunk_ack', req: chunk.req });
      if (messages.length === n) break;
      // next loop iteration picks the newest chunk; mark consumed by slicing from n
      messages.splice(before, 0); // no-op; kept for clarity
    }
    const states = messages.slice(before).filter((m) => m.type === 'state');
    const last = states[states.length - 1] || null;
    return { state: last ? last.store : null, reason: last ? last.reason : null, stateMessage: last, snapshot, lock: lockResult };
  }
  /** Resolves with the ack / nack / indeterminate message for this txn. */
  function submit(kind, delta, { txn = crypto.randomUUID(), cls = 'O' } = {}) {
    const p = waitFor(`txn:${txn}`);
    store.handle({ type: 'submit', txn, kind, delta, class: cls, bytes: 0 });
    return p.then((m) => ({ ...m, txn }));
  }
  /** Synchronous chunked read; returns { items, reason, tier }. */
  function read(op, args = {}) {
    const req = crypto.randomUUID();
    const items = []; let reason = null; let tier = null;
    const type = op === 'resolve' ? 'resolve' : (op === 'compact' ? 'compact' : 'read');
    store.handle(type === 'read' ? { type: 'read', op, req, ...args } : { type, req, ...args });
    for (;;) {
      const chunk = messages.filter((m) => m.req === req && (m.type === 'read_chunk' || m.type === 'resolve_chunk')).pop();
      if (!chunk) break;
      for (const it of chunk.items || []) items.push(it);
      if (chunk.reason) reason = chunk.reason;
      if (chunk.tier) tier = chunk.tier;
      if (chunk.last) break;
      store.handle({ type: 'chunk_ack', req });
    }
    return { items, reason, tier };
  }
  function flush() { store.handle({ type: 'flush' }); }
  function close(deadline = 2000) { const p = waitFor('closed'); store.handle({ type: 'close', deadline_ms: deadline }); return p; }
  function live(sid, on) { store.handle({ type: 'live', sid, on }); }
  function release() { return lock.release(lockPath, { pid, token }, lockFs); }
  function ofType(type) { return messages.filter((m) => m.type === type); }
  return { store, messages, open, submit, read, flush, close, live, release, ofType, lockPath, token, pid, dir, lockResult };
}

// ---- small helpers shared by the owner tests ------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function shaTree(root) {
  const out = {};
  (function walk(d, rel) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out[r] = sha256(fs.readFileSync(path.join(d, e.name)));
    }
  })(root, '');
  return out;
}
function readFrames(file) {
  const F = require('../../../src/session-store/ledger-format');
  return F.decodeFrames(fs.readFileSync(file));
}
function segmentFiles(dir) {
  const d = path.join(dir, 'segments');
  try { return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).sort().map((n) => path.join(d, n)); } catch { return []; }
}
function tmpStore(prefix = 'telepty-ledger-1207-') {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), prefix));
  const parent = path.join(home, '.config', 'aigentry-telepty');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return { home, parent, dir: path.join(parent, 'tracked-injections.json'), lockPath: path.join(parent, 'tracked-injections.lock'), rm: () => fs.rmSync(home, { recursive: true, force: true }) };
}

module.exports = { createOwnerHarness, sha256, shaTree, readFrames, segmentFiles, tmpStore };
