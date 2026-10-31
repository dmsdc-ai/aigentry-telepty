'use strict';

// #1207 — the ledger OWNER on a real private filesystem, driven in-process (no worker_threads, no
// daemon, no socket, no PTY) with fault injection at named fs points. Covers the pure/fake-IO halves
// of ACCEPTANCE O1, O3, O4(a), O5, T1, T3, T6, I1, I2, I3, S1, M1, M2 (conflicts incl. errata C2),
// M5, X1, R4, E1 (lock half), E2, E3, E4 (receipt across checkpoint), the two binding controller
// corrections (published store before pending scan with a retained aside; no rename-back after a
// capture mismatch), and the close/clean_close half of W2. Author-written: not runtime admission.
//
// Prerequisites: POSIX filesystem semantics for the rename-over-directory and EISDIR assertions
// (X1 records the errno elsewhere; Windows is NOT a supported cutover platform until measured).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('../src/session-store/ledger-format');
const lock = require('../src/session-store/ledger-lock');
const persistence = require('../src/session-store/persistence');
const { createOwnerHarness, sha256, shaTree, readFrames, segmentFiles, tmpStore } = require('./fixtures/ledger-1207/owner-harness');
const { createFaultFs } = require('./fixtures/ledger-1207/fault-fs');
const { writeLegacyLedger, makeHistoricalRecord } = require('./fixtures/ledger-1207/legacy-fixture');

const POSIX = process.platform !== 'win32';
const nowIso = () => new Date().toISOString();
// Tree hashes of the store's parent, excluding the lock this harness itself holds.
function treeWithoutLock(parent) { const t = shaTree(parent); delete t['tracked-injections.lock']; return t; }
function beginRecord(id, sid, at = nowIso()) {
  const record = { inject_id: id, session_id: sid, session_epoch: null, session_epoch_reason: 'no_815_epoch_fact', transport_source: 'orch', created_at: at,
    observation_seq: 0, observations: [], last_observation: null, capability: { stage: 'A' }, tracking_state: 'tracked' };
  persistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, at);
  return record;
}
const begin = (h, id, sid) => h.submit('begin', { id, sid, record: beginRecord(id, sid), at: nowIso() }, { cls: 'T' });
const obs = (h, id, kind, trigger, extra = {}) => h.submit('obs', { id, observation: { kind, trigger, at: nowIso(), ...extra } });
const state = (h, id, ts) => h.submit('state', { id, tracking_state: ts, observation: { kind: 'inject_delivery_refused', trigger: 'delivery_refused', delivery_code: 'X', bytes_written: 0, at: nowIso() } }, { cls: 'T' });
async function withStore(fn) { const s = tmpStore(); const owned = []; return inStore(s, owned, () => fn(s, owned)); }
// Task 1215 — owned fixture teardown. On Windows a file deleted while a descriptor is still open stays
// delete-pending, so removing its directory fails ENOTEMPTY; a test body that fails BEFORE its owner is
// closed or crash-released leaves exactly such a descriptor, and the cleanup error then REPLACED the
// assertion error. inStore keeps both: it releases only what this test positively owns (descriptors
// still open through each registered owner's tracker — the OS release a crash performs, no owner close()
// and no store write — then that owner's token-verified lock), removes the private home, and reports a
// teardown failure with the remaining entries, aggregated with the body error when there is one.
// No retry, no wait, nothing swallowed.
async function inStore(s, owned, body) {
  let bodyError = null;
  try { return await body(); } catch (error) { bodyError = error; throw error; } finally { ownedTeardown(s, owned, bodyError); }
}
function remainingEntries(root, max = 40) {
  const out = [];
  (function walk(d, rel) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { if (out.length >= max) return; const r = rel ? `${rel}/${e.name}` : e.name; out.push(e.isDirectory() ? `${r}/` : r); if (e.isDirectory()) walk(path.join(d, e.name), r); }
  })(root, '');
  return out;
}
function ownedTeardown(s, owned, bodyError) {
  const failures = []; let releasedFds = 0;
  for (const { h, tracked } of owned.splice(0)) {
    for (const fd of tracked.takeOpen()) { try { fs.closeSync(fd); releasedFds++; } catch (error) { failures.push(error); } }
    const r = h.release();            // token-verified: an already-released (or replaced) lock is lock_mismatch, a no-op
    if (r && r.reason === 'unlink_failed') failures.push(new Error(`owned lock release failed: ${r.code}`));
  }
  try { s.rm(); } catch (error) {
    failures.push(new Error(`owned fixture cleanup failed: ${error.code} ${error.path || ''}; released_fds=${releasedFds}; body_failed=${!!bodyError}; remaining=${JSON.stringify(remainingEntries(s.home))}`, { cause: error }));
  }
  if (!failures.length) return;
  if (bodyError) throw new AggregateError([bodyError, ...failures], `test body failed (${bodyError.message}) and owned fixture teardown failed`);
  throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'owned fixture teardown failed');
}
// Task 1215 / #879 W2 — simulated crash. A real crash ends the owner's process and the OS releases every
// descriptor it held; the in-process "crash" (no close(), then release()) used to leave them open, which
// Windows measured as ENOTEMPTY at cleanup. trackOwnerFds wraps ONE owner's fsImpl and records only the
// descriptors opened through it; crashOwner closes exactly those still open with the real fs (never another
// owner's, and never the owner's close(): no flush, checkpoint or MANIFEST write), then releases the lock as
// before. Evidence asserted: no `closed` message, no call through the owner's fs, a byte-identical store tree.
function trackOwnerFds(base = fs) {
  const open = new Set(); let calls = 0;
  const facade = Object.create(base);
  facade.openSync = (...args) => { calls++; const fd = base.openSync(...args); open.add(fd); return fd; };
  facade.closeSync = (fd, ...rest) => { calls++; try { return base.closeSync(fd, ...rest); } finally { open.delete(fd); } };
  return { fs: facade, calls: () => calls, takeOpen: () => { const fds = [...open]; open.clear(); return fds; } };
}
function crashOwner(h, tracked) {
  const parent = path.dirname(h.dir);
  const treeBefore = shaTree(parent); const callsBefore = tracked.calls(); const closedBefore = h.ofType('closed').length;
  const fds = tracked.takeOpen();
  for (const fd of fds) fs.closeSync(fd);            // the OS-level release a process exit performs
  assert.equal(tracked.calls(), callsBefore, 'crash cleanup makes no call through the owner fs');
  assert.equal(h.ofType('closed').length, closedBefore, 'crash cleanup is not the owner close()');
  assert.deepEqual(shaTree(parent), treeBefore, 'crash cleanup writes nothing');
  return h.release();
}

test('fresh open: directory store published at the legacy path; begin is acked only after its commit frame is durable on disk', () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir });
  assert.equal(h.lockResult.held, true);
  const opened = h.open();
  assert.equal(opened.state, 'available', JSON.stringify(opened.stateMessage));
  assert.equal(fs.statSync(s.dir).isDirectory(), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.format, 4); assert.equal(manifest.published, true); assert.equal(manifest.epoch, 1);
  // At the instant of the ack, the active segment must already hold a valid begin frame AND a valid
  // commit frame covering it (F5's durable-before-ack ordering, observed from the ack callback).
  const ack = await begin(h, 'inj-1', 'w1');
  const atAck = segmentFiles(s.dir).map((f) => readFrames(f));
  assert.equal(ack.type, 'ack'); assert.equal(ack.basis, 'written'); assert.equal(ack.result, 'committed');
  assert.equal(ack.epoch, 1); assert.equal(ack.seq, 1);
  const frames = atAck.flatMap((d) => d.frames.map((f) => f.obj));
  assert.deepEqual(frames.map((f) => f.t), ['begin', 'commit']);
  assert.equal(frames[1].seq_from, 1); assert.equal(frames[1].seq_to, 1); assert.equal(frames[1].n, 1);
  assert.equal(atAck[0].tail, null);
  // record readable, hot tier, observation_seq 1
  const got = h.read('get', { id: 'inj-1' });
  assert.equal(got.tier, 'hot'); assert.equal(got.items[0].observation_seq, 1); assert.equal(got.items[0].tracking_state, 'tracked');
  assert.equal(got.items[0].materialized_through, undefined, 'owner-only fields are not served');
  const closed = await h.close();
  assert.equal(closed.clean, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8')).clean_close, true);
  assert.equal(h.release().released, true);
  assert.equal(fs.existsSync(s.lockPath), false);
}));

test('O3 / E3 / O4(a): committed-basis duplicate acks immediately without a frame; committed A + pending B + incoming A is WRITTEN; a pending-basis duplicate resolves only with its group', () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir });
  assert.equal(h.open().state, 'available');
  await begin(h, 'i', 'w');
  const a1 = await obs(h, 'i', 'output_observed', 'output_received');
  assert.equal(a1.basis, 'written');
  const framesBefore = readFrames(segmentFiles(s.dir)[0]).frames.length;
  // O3: identity equals the committed last_observation → immediate ack, basis committed, no frame
  const dup = await obs(h, 'i', 'output_observed', 'output_received');
  assert.equal(dup.type, 'ack'); assert.equal(dup.result, 'observation_duplicate'); assert.equal(dup.basis, 'committed');
  assert.deepEqual(dup.depends_on_pos, { epoch: 1, seq: 2 });
  assert.equal(readFrames(segmentFiles(s.dir)[0]).frames.length, framesBefore, 'no frame for a committed-basis no-op');
  // E3: committed A, pending B (same macrotask), incoming A → the overlay's last is B → A is written
  const pB = obs(h, 'i', 'busy_indicator_pattern_observed', 'busy_indicator_pattern');
  const pA = obs(h, 'i', 'output_observed', 'output_received');
  const pA2 = obs(h, 'i', 'output_observed', 'output_received');     // O4(a): duplicate of PENDING A → bound to the group
  const [b, a, a2] = await Promise.all([pB, pA, pA2]);
  assert.equal(b.basis, 'written'); assert.equal(a.basis, 'written');
  assert.equal(a2.result, 'observation_duplicate'); assert.equal(a2.basis, 'pending');
  assert.ok(a2._seq > a._seq && a2._seq > b._seq, 'the pending-basis verdict is posted after the group\'s acks, never before');
  const record = h.read('get', { id: 'i' }).items[0];
  assert.deepEqual(record.observations.map((o) => o.kind), ['tracking_started', 'output_observed', 'busy_indicator_pattern_observed', 'output_observed']);
  assert.equal(record.observation_seq, 4);
  await h.close(); h.release();
}));

test('O1 / O5: same-record overlap in one group acks in seq order; obs on a terminal record is allowed; same terminal twice is already_terminal; a conflicting terminal is nacked record_terminal', () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir });
  h.open();
  await begin(h, 'i', 'w');
  const results = await Promise.all([
    obs(h, 'i', 'output_observed', 'output_received'),
    obs(h, 'i', 'busy_indicator_pattern_observed', 'busy_indicator_pattern'),
    state(h, 'i', 'aborted'),
    obs(h, 'i', 'owner_replaced_observed', 'owner_epoch_replaced'),
  ]);
  assert.deepEqual(results.map((r) => r.type), ['ack', 'ack', 'ack', 'ack']);
  assert.deepEqual(results.map((r) => r.seq), [2, 3, 4, 5]);
  assert.ok(results.every((r, i, arr) => i === 0 || r._seq > arr[i - 1]._seq), 'acks posted in seq order');
  assert.equal(results[2].record_state, 'aborted');
  const again = await state(h, 'i', 'aborted');
  assert.equal(again.type, 'ack'); assert.equal(again.result, 'already_terminal');
  const conflict = await state(h, 'i', 'superseded');
  assert.equal(conflict.type, 'nack'); assert.equal(conflict.reason, 'record_terminal');
  const rec = h.read('get', { id: 'i' }).items[0];
  assert.equal(rec.tracking_state, 'aborted'); assert.equal(rec.observation_seq, 5);
  await h.close(); h.release();
}));

test('begin supersedes the session\'s hot tracked records in the same durable group; a second begin for an existing id is already_exists', () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir });
  h.open();
  const first = await begin(h, 'old', 'w');
  assert.deepEqual(first.superseded, []);
  const second = await begin(h, 'new', 'w');
  assert.deepEqual(second.superseded, ['old']);
  assert.equal(second.effects.length, 2);
  const old = h.read('get', { id: 'old' }).items[0];
  assert.equal(old.tracking_state, 'superseded');
  assert.equal(old.last_observation.kind, 'tracking_superseded');
  assert.equal(old.last_observation.superseded_by, 'new');
  const dup = await begin(h, 'new', 'w');
  assert.equal(dup.type, 'ack'); assert.equal(dup.result, 'already_exists'); assert.equal(dup.basis, 'committed');
  await h.close(); h.release();
}));

test('I1: a single fsync failure retries the same bytes in a NEW segment and acks (retried:true); recovery after a crash applies the group exactly once', () => withStore(async (s) => {
  const faultFs = createFaultFs({ faults: { fsyncSync: { code: 'EIO', times: 1, pathIncludes: `${path.sep}segments${path.sep}1-1.jsonl` } } });
  const crashed = trackOwnerFds(faultFs);
  let h = createOwnerHarness({ dir: s.dir, fsImpl: crashed.fs });
  h.open();
  await begin(h, 'i', 'w');                                  // group 1 — fsync of segment 1-1 throws once → retry into 1-2
  assert.equal(faultFs._state.fired.length, 1, 'exactly one injected fsync failure');
  const files = segmentFiles(s.dir);
  assert.deepEqual(files.map((f) => path.basename(f)), ['1-1.jsonl', '1-2.jsonl']);
  const a = await obs(h, 'i', 'output_observed', 'output_received');
  assert.equal(a.type, 'ack');
  // segment 1-1 holds the first copy of the group (bytes were written before the fsync threw);
  // 1-2 holds the retry copy plus later groups: a duplicate (epoch,seq) on disk, by design.
  const s1 = readFrames(files[0]).frames.map((f) => f.obj); const s2 = readFrames(files[1]).frames.map((f) => f.obj);
  assert.deepEqual(s1.map((f) => f.t), ['begin', 'commit']);
  assert.deepEqual(s2.slice(0, 2).map((f) => f.t), ['begin', 'commit']);
  assert.equal(s1[0].seq, s2[0].seq);
  const retriedAck = h.ofType('ack').find((m) => m.txn && m.retried === true);
  assert.ok(retriedAck, 'the ack names the retry');
  // "crash": no close; a new owner recovers
  crashOwner(h, crashed);
  h = createOwnerHarness({ dir: s.dir });
  const reopened = h.open();
  assert.equal(reopened.state, 'available');
  assert.equal(reopened.stateMessage.recovery.skipped_duplicates >= 1, true, 'the duplicate copy is skipped by (epoch,seq)+hash');
  const rec = h.read('get', { id: 'i' }).items[0];
  assert.equal(rec.observation_seq, 2, 'applied exactly once');
  assert.deepEqual(rec.observations.map((o) => o.kind), ['tracking_started', 'output_observed']);
  await h.close(); h.release();
}));

test('I2 / S2: two write failures make every txn of the group INDETERMINATE (never ack, never nack); the store goes unavailable_write; reads serve committed only; no further frames', () => withStore(async (s) => {
  const faultFs = createFaultFs({ faults: { fsyncSync: { code: 'EIO', times: 2, pathIncludes: `${path.sep}segments${path.sep}` } } });
  const crashed = trackOwnerFds(faultFs);
  const h = createOwnerHarness({ dir: s.dir, fsImpl: crashed.fs });
  h.open();
  const ok = await begin(h, 'durable', 'w');     // group 1 (segment 1-1) — fine? no: faults fire on the first two fsyncs
  // The first group already consumed both faults: begin resolved indeterminate.
  assert.equal(ok.type, 'indeterminate', JSON.stringify(ok));
  assert.equal(ok.reason.startsWith('write_error:EIO'), true);
  assert.deepEqual(ok.group.seq_from, 1);
  const st = h.ofType('state').pop();
  assert.equal(st.store, 'unavailable_write');
  // committed projection does NOT contain the possibly-durable record
  assert.deepEqual(h.read('get', { id: 'durable' }).items, []);
  const later = await obs(h, 'durable', 'output_observed', 'output_received');
  assert.equal(later.type, 'nack'); assert.equal(later.reason, 'unavailable_write');
  const sizes = segmentFiles(s.dir).map((f) => fs.statSync(f).size);
  const again = await begin(h, 'other', 'w');
  assert.equal(again.type, 'nack');
  assert.deepEqual(segmentFiles(s.dir).map((f) => fs.statSync(f).size), sizes, 'no frame is appended after indeterminate');
  const status = h.read('status').items[0];
  assert.equal(status.store, 'unavailable_write'); assert.ok(status.possibly_durable);
  crashOwner(h, crashed);
}));

test('I3 / E4: settlement only at actual recovery — durable bytes resolve `committed{pos}` from receipts; frames without a commit frame are listed unapplied and resolve `not_applied`; unknown txns stay `unresolved`; receipts survive a checkpoint', () => withStore(async (s) => {
  // (a) bytes durable: writeSync succeeded, both fsyncs threw
  const faultFs = createFaultFs({ faults: { fsyncSync: { code: 'EIO', times: 2, pathIncludes: `${path.sep}segments${path.sep}` } } });
  const crashed1 = trackOwnerFds(faultFs);
  let h = createOwnerHarness({ dir: s.dir, fsImpl: crashed1.fs });
  h.open();
  const ind = await begin(h, 'A', 'w');
  assert.equal(ind.type, 'indeterminate');
  crashOwner(h, crashed1);
  // (b) a torn tail: append half a frame to the last segment (crash between append and fsync)
  const files = segmentFiles(s.dir);
  const last = files[files.length - 1];
  const tornTxn = crypto.randomUUID();
  const tornFrame = F.encodeFrame({ t: 'obs', epoch: 1, seq: 9, txn: tornTxn, id: 'A', observation: { kind: 'x', trigger: 'y', at: 't' } });
  fs.appendFileSync(last, tornFrame.subarray(0, tornFrame.length - 4));
  const sizeBefore = fs.statSync(last).size;
  const crashed2 = trackOwnerFds();
  h = createOwnerHarness({ dir: s.dir, fsImpl: crashed2.fs });
  const re = h.open();
  assert.equal(re.state, 'available');
  const rec = h.read('get', { id: 'A' }).items[0];
  assert.ok(rec, 'the commit-framed group is applied at recovery whether or not it was acked');
  assert.equal(fs.statSync(last).size, sizeBefore, 'T1: the torn tail is never truncated');
  assert.ok(re.stateMessage.recovery.unapplied_count >= 1);
  const resolved = h.read('resolve', { txns: [ind.txn, tornTxn, 'never-seen'] }).items;
  assert.equal(resolved[0].outcome, 'committed'); assert.deepEqual(resolved[0].pos, { epoch: 1, seq: 1 });
  assert.equal(resolved[1].outcome, 'unresolved', 'a torn frame has no readable txn: not in the unapplied txn list, so unresolved — never inferred');
  assert.equal(resolved[2].outcome, 'unresolved');
  // a complete-but-uncommitted frame IS listed by txn and resolves not_applied
  const u = crypto.randomUUID();
  const activeSeg = segmentFiles(s.dir).pop();
  await obs(h, 'A', 'output_observed', 'output_received');
  fs.appendFileSync(activeSeg, F.encodeFrame({ t: 'obs', epoch: 2, seq: 99, txn: u, id: 'A', observation: { kind: 'q', trigger: 'r', at: 't' } }));
  crashOwner(h, crashed2);
  h = createOwnerHarness({ dir: s.dir });
  h.open();
  const r2 = h.read('resolve', { txns: [u, ind.txn] }).items;
  assert.equal(r2[0].outcome, 'not_applied'); assert.equal(typeof r2[0].segment, 'string'); assert.equal(typeof r2[0].offset, 'number');
  assert.equal(r2[1].outcome, 'committed', 'receipt retained across the recovery and the checkpoint written at close');
  // E4: receipts persist across a checkpoint
  h.read('compact');
  assert.equal(h.read('resolve', { txns: [ind.txn] }).items[0].outcome, 'committed');
  await h.close(); h.release();
  const manifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
  assert.ok(manifest.recovery.unapplied_count >= 1, 'MANIFEST names the unapplied frames');
}));

test('T3 / T6: a flipped byte in a committed frame, or a conflicting duplicate seq, makes the store unavailable_read; bytes preserved; nothing written', () => withStore(async (s) => {
  let h = createOwnerHarness({ dir: s.dir });
  h.open(); await begin(h, 'i', 'w'); await obs(h, 'i', 'output_observed', 'output_received'); await h.close(); h.release();
  const seg = segmentFiles(s.dir)[0];
  const original = fs.readFileSync(seg);
  const flipped = Buffer.from(original); flipped[10] ^= 0x01; fs.writeFileSync(seg, flipped);
  const before = shaTree(s.dir);
  h = createOwnerHarness({ dir: s.dir });
  const o = h.open();
  assert.equal(o.state, 'unavailable_read');
  assert.equal(o.reason, 'corrupt_committed_frame', JSON.stringify(o.stateMessage));
  const nack = await begin(h, 'x', 'w');
  assert.equal(nack.type, 'nack'); assert.equal(nack.reason, 'unavailable_read');
  assert.deepEqual(shaTree(s.dir), before, 'no repair, no write');
  h.release();
  // T6: restore the bytes, then fabricate a frame reusing an applied seq with different content
  fs.writeFileSync(seg, original);
  const dup = F.encodeFrame({ t: 'obs', epoch: 1, seq: 2, txn: 'forged', id: 'i', observation: { kind: 'forged', trigger: 'f', at: 't' } });
  const commit = F.encodeFrame({ t: 'commit', epoch: 1, seq_from: 2, seq_to: 2, n: 1 });
  fs.appendFileSync(seg, Buffer.concat([dup, commit]));
  const before2 = shaTree(s.dir);
  h = createOwnerHarness({ dir: s.dir });
  const o2 = h.open();
  assert.equal(o2.state, 'unavailable_read'); assert.equal(o2.reason, 'duplicate_frame_conflict');
  assert.deepEqual(shaTree(s.dir), before2);
  h.release();
}));

test('S1 / E1 (lock half): O_EXCL fails closed; a second holder never breaks the lock; the worker-side re-check refuses a token mismatch without opening anything; operator unlock refuses while a daemon is alive', () => withStore(async (s) => {
  const first = lock.acquire(s.lockPath, { pid: process.pid, token: 'tok-1' });
  assert.equal(first.held, true);
  const bytes = fs.readFileSync(s.lockPath);
  const second = lock.acquire(s.lockPath, { pid: process.pid, token: 'tok-2' });
  assert.equal(second.held, false); assert.equal(second.reason, 'lock_present');
  assert.deepEqual(second.contents.token, 'tok-1');
  assert.ok(fs.readFileSync(s.lockPath).equals(bytes), 'the lock file is byte-identical afterwards');
  assert.deepEqual(fs.readdirSync(s.parent).filter((n) => n.includes('stale')), [], 'no lock.stale.* file exists');
  // a lock from a DEAD pid is still not broken
  fs.writeFileSync(s.lockPath, JSON.stringify({ pid: 999999, token: 'dead', started_at: 'x' }));
  const dead = lock.acquire(s.lockPath, { pid: process.pid, token: 'tok-3' });
  assert.equal(dead.held, false); assert.equal(dead.reason, 'lock_present');
  // an unreadable lock is reported as unreadable, never treated as dead
  fs.writeFileSync(s.lockPath, 'garbage');
  const unreadable = lock.acquire(s.lockPath, { pid: process.pid, token: 'tok-4' });
  assert.equal(unreadable.reason, 'lock_present'); assert.equal(unreadable.contents, 'unreadable');
  assert.equal(lock.release(s.lockPath, { pid: process.pid, token: 'tok-4' }).released, false, 'release only with matching contents');
  // worker re-check: a store whose token does not match the lock refuses before opening any file
  fs.writeFileSync(s.lockPath, JSON.stringify({ pid: process.pid, token: 'tok-1' }));
  const h = createOwnerHarness({ dir: s.dir, token: 'wrong', acquire: false });
  const o = h.open();
  assert.equal(o.state, 'unavailable'); assert.equal(o.reason, 'lock_mismatch');
  assert.equal(fs.existsSync(s.dir), false, 'nothing opened, nothing created');
  // operator unlock: confirm required; refuses on a live daemon-state pid; refuses when health answers; else unlinks
  assert.equal((await lock.operatorUnlock(s.lockPath, { confirm: false })).reason, 'confirm_required');
  assert.equal((await lock.operatorUnlock(s.lockPath, { confirm: true, daemonState: { pid: 4242 }, isProcessRunning: (p) => p === 4242 })).reason, 'daemon_state_pid_alive');
  assert.equal((await lock.operatorUnlock(s.lockPath, { confirm: true, probeHealth: async () => true })).reason, 'health_answers');
  assert.equal((await lock.operatorUnlock(s.lockPath, { confirm: true, isProcessRunning: () => false, probeHealth: async () => false })).unlocked, true);
  assert.equal(fs.existsSync(s.lockPath), false);
  const after = lock.acquire(s.lockPath, { pid: process.pid, token: 'tok-5' });
  assert.equal(after.held, true, 'after the operator unlock exactly one acquisition succeeds');
  lock.release(s.lockPath, { pid: process.pid, token: 'tok-5' });
}));

test('M1 / M5: a 0.9.1 file is migrated under the lock (lock read before the first legacy open); legacy copy and aside hash == original == MANIFEST.legacy; historical polls deepEqual the legacy records', () => withStore(async (s) => {
  const legacy = writeLegacyLedger(s.dir, { count: 40, obsPerRecord: 12 });
  const calls = [];
  const recFs = createFaultFs({ record: calls });
  let h = createOwnerHarness({ dir: s.dir, fsImpl: recFs });
  const o = h.open();
  assert.equal(o.state, 'available', JSON.stringify(o.stateMessage));
  // M5: the lock was read before the legacy file was opened/read
  const lockRead = calls.findIndex((c) => c.name === 'readFileSync' && c.path === s.lockPath);
  const legacyOpen = calls.findIndex((c) => (c.name === 'openSync' || c.name === 'readFileSync') && c.path === s.dir);
  assert.ok(lockRead !== -1 && legacyOpen !== -1 && lockRead < legacyOpen, `lock read (${lockRead}) must precede the first legacy open (${legacyOpen})`);
  assert.equal(fs.statSync(s.dir).isDirectory(), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.legacy.sha256, legacy.sha256); assert.equal(manifest.legacy.bytes, legacy.bytes);
  assert.equal(sha256(fs.readFileSync(path.join(s.dir, 'legacy', 'tracked-injections.v3.json'))), legacy.sha256);
  const aside = fs.readdirSync(s.parent).find((n) => n.startsWith('tracked-injections.json.pre-0.10.'));
  assert.ok(aside, 'the original is moved aside, never deleted');
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, aside))), legacy.sha256);
  assert.equal(o.stateMessage.counts.cold, 40); assert.equal(o.stateMessage.counts.hot, 0, 'legacy tracked records are cold and consume no reservation');
  for (const id of legacy.ids.slice(0, 5)) {
    const got = h.read('get', { id });
    assert.equal(got.tier, 'cold');
    assert.deepEqual(got.items[0], legacy.ledger.injections[id], `historical ${id} deepEqual the legacy record`);
  }
  const listed = h.read('listSession', { sid: `hist-session-${'0'.repeat(6)}3` }).items;
  assert.equal(listed.length, 1); assert.equal(listed[0].inject_id, 'hist-0000003');
  await h.close(); h.release();
  // the restart fact at the NEXT open overlays every record lazily, in log order
  h = createOwnerHarness({ dir: s.dir });
  h.open();
  const f = await h.submit('fact', { scope: 'global', observation: { kind: 'daemon_restart_observed', trigger: 'daemon_restart', at: nowIso() } }, { cls: 'L' });
  assert.equal(f.type, 'ack');
  const polled = h.read('get', { id: legacy.ids[7] }).items[0];
  assert.equal(polled.observation_seq, 13); assert.equal(polled.last_observation.kind, 'daemon_restart_observed'); assert.equal(polled.last_observation.seq, 13);
  await h.close(); h.release();
}));

test('binding correction 1: a published store is recognised BEFORE any pending-migration scan — a retained completed aside (and an abandoned staging dir) never blocks a restart', () => withStore(async (s) => {
  writeLegacyLedger(s.dir, { count: 5 });
  let h = createOwnerHarness({ dir: s.dir });
  assert.equal(h.open().state, 'available');
  await begin(h, 'i', 'w');
  await h.close(); h.release();
  const asides = fs.readdirSync(s.parent).filter((n) => n.startsWith('tracked-injections.json.pre-0.10.'));
  assert.equal(asides.length, 1);
  // plus an abandoned staging directory from some earlier interrupted attempt
  fs.mkdirSync(path.join(s.parent, 'tracked-injections.json.migrating.deadbeef'), { recursive: true });
  for (let i = 0; i < 3; i++) {
    h = createOwnerHarness({ dir: s.dir });
    const o = h.open();
    assert.equal(o.state, 'available', `restart ${i}: ${JSON.stringify(o.stateMessage)}`);
    assert.equal(h.read('get', { id: 'i' }).items.length, 1);
    await h.close(); h.release();
  }
  assert.deepEqual(fs.readdirSync(s.parent).filter((n) => n.startsWith('tracked-injections.json.pre-0.10.')), asides, 'the aside is retained, untouched');
  assert.equal(fs.existsSync(path.join(s.parent, 'tracked-injections.json.migrating.deadbeef')), true, 'nothing deleted');
}));

test('binding correction 2 / E2: a writer replacing the legacy file after capture is detected on the ASIDE artifact (h3 != h1); aside, staging and a reappeared legacy file are retained IN PLACE — no rename back; the next open fails closed on the same identity', () => withStore(async (s) => {
  const legacy = writeLegacyLedger(s.dir, { count: 6 });
  const replacement = Buffer.from(JSON.stringify({ ...legacy.ledger, generation: 99, marker: 'OLD-WRITER-AFTER-CAPTURE' }, null, 2));
  const faultFs = createFaultFs({ faults: { renameSync: { code: null, times: 1, when: (args) => args[0] === s.dir && String(args[1]).includes('.pre-0.10.'),
    before: () => { fs.writeFileSync(s.dir, replacement); } } } });
  let h = createOwnerHarness({ dir: s.dir, fsImpl: faultFs });
  const o = h.open();
  assert.equal(o.state, 'unavailable'); assert.equal(o.reason, 'migration_conflict'); assert.equal(o.stateMessage.detail, 'original_modified_after_capture');
  const aside = fs.readdirSync(s.parent).find((n) => n.startsWith('tracked-injections.json.pre-0.10.'));
  const staging = fs.readdirSync(s.parent).find((n) => n.startsWith('tracked-injections.json.migrating.'));
  assert.ok(aside && staging);
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, aside))), sha256(replacement), 'the aside holds the NEWER original (what the old writer produced)');
  assert.equal(fs.existsSync(s.dir), false, 'the aside is NOT renamed back to the legacy path (that check races an old writer)');
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, staging, 'legacy', 'tracked-injections.v3.json'))), legacy.sha256, 'the staging copy of the captured bytes is retained');
  h.release();
  // an old writer now recreates a file at L; everything stays, and the next open does not create a fresh store
  fs.writeFileSync(s.dir, '{"schema_version":3,"generation":1,"injections":{},"interactions":{"actions":{},"pending":{}}}');
  const before = treeWithoutLock(s.parent);
  h = createOwnerHarness({ dir: s.dir });
  const o2 = h.open();
  assert.equal(o2.state, 'unavailable'); assert.equal(o2.reason, 'migration_conflict'); assert.equal(o2.stateMessage.detail, 'legacy_recreated');
  assert.deepEqual(treeWithoutLock(s.parent), before, 'all three artifacts retained byte-for-byte');
  h.release();
  // and with L absent, the pending identity (staging at step 6a + mismatching aside) still fails closed
  fs.unlinkSync(s.dir);
  const before2 = treeWithoutLock(s.parent);
  h = createOwnerHarness({ dir: s.dir });
  const o3 = h.open();
  assert.equal(o3.state, 'unavailable'); assert.equal(o3.reason, 'migration_conflict'); assert.equal(o3.stateMessage.detail, 'original_modified');
  assert.deepEqual(treeWithoutLock(s.parent), before2);
  assert.equal(fs.existsSync(s.dir), false, 'no fresh store was initialised over a pending identity');
  h.release();
}));

test('M2 conflicts: legacy_modified (write to L between capture and aside) and legacy_recreated (file at L between the two renames) each stop with every file retained; a crash after M5 resumes to the same final store', () => withStore(async (s, owned) => {
  // legacy_modified: mutate L right before the h2 re-hash (hook on the statless hashing open after M5)
  const legacy = writeLegacyLedger(s.dir, { count: 4 });
  let opens = 0;
  const f1 = createFaultFs({ faults: { openSync: { code: null, times: 1, when: (args) => args[0] === s.dir && ++opens === 3, before: () => fs.appendFileSync(s.dir, '\n') } } });
  const crashed1 = trackOwnerFds(f1);
  let h = createOwnerHarness({ dir: s.dir, fsImpl: crashed1.fs }); owned.push({ h, tracked: crashed1 });
  const o1 = h.open();
  assert.equal(o1.reason, 'migration_conflict'); assert.equal(o1.stateMessage.detail, 'legacy_modified');
  assert.equal(fs.statSync(s.dir).isFile(), true, 'L untouched (still the file, with the writer\'s change)');
  assert.notEqual(sha256(fs.readFileSync(s.dir)), legacy.sha256);
  assert.equal(fs.readdirSync(s.parent).filter((n) => n.startsWith('tracked-injections.json.migrating.')).length, 1, 'S kept');
  crashOwner(h, crashed1);
  // clean slate: legacy_recreated at M6b
  ownedTeardown(s, owned, null); const s2 = tmpStore(); const owned2 = [];
  await inStore(s2, owned2, () => {
    const leg2 = writeLegacyLedger(s2.dir, { count: 4 });
    const f2 = createFaultFs({ faults: { renameSync: { code: null, times: 1, when: (args) => String(args[0]).includes('.migrating.') && args[1] === s2.dir, before: () => fs.writeFileSync(s2.dir, 'recreated-by-old-writer') } } });
    const crashed2 = trackOwnerFds(f2);
    h = createOwnerHarness({ dir: s2.dir, fsImpl: crashed2.fs }); owned2.push({ h, tracked: crashed2 });
    const o2 = h.open();
    assert.equal(o2.reason, 'migration_conflict'); assert.equal(o2.stateMessage.detail, 'legacy_recreated');
    const names = fs.readdirSync(s2.parent);
    assert.ok(names.some((n) => n.startsWith('tracked-injections.json.pre-0.10.')) && names.some((n) => n.startsWith('tracked-injections.json.migrating.')) && names.includes('tracked-injections.json'));
    assert.equal(fs.readFileSync(s2.dir, 'utf8'), 'recreated-by-old-writer', 'the reappeared file is retained');
    const asideName = names.find((n) => n.startsWith('tracked-injections.json.pre-0.10.'));
    assert.equal(sha256(fs.readFileSync(path.join(s2.parent, asideName))), leg2.sha256);
    crashOwner(h, crashed2);
  });
  // crash after M5 (before the aside rename): the next open redoes the migration with a new token; the abandoned staging dir is counted, not deleted
  const s3 = tmpStore(); const owned3 = [];
  await inStore(s3, owned3, async () => {
    const leg3 = writeLegacyLedger(s3.dir, { count: 4 });
    const f3 = createFaultFs({ faults: { renameSync: { code: 'EIO', times: 1, when: (args) => args[0] === s3.dir } } });
    const crashed3 = trackOwnerFds(f3);
    h = createOwnerHarness({ dir: s3.dir, fsImpl: crashed3.fs }); owned3.push({ h, tracked: crashed3 });
    assert.equal(h.open().reason, 'open_failed');
    crashOwner(h, crashed3);
    assert.equal(sha256(fs.readFileSync(s3.dir)), leg3.sha256, 'L untouched');
    const live3 = trackOwnerFds();     // pass-through tracker: lets a failed body release this owner's segment fd
    h = createOwnerHarness({ dir: s3.dir, fsImpl: live3.fs }); owned3.push({ h, tracked: live3 });
    const o3 = h.open();
    assert.equal(o3.state, 'available');
    assert.equal(fs.readdirSync(s3.parent).filter((n) => n.startsWith('tracked-injections.json.migrating.')).length, 1, 'the abandoned staging dir from the crashed attempt is retained');
    assert.equal(h.read('get', { id: leg3.ids[0] }).items.length, 1);
    await h.close(); h.release();
    // two abandoned staging dirs + a legacy file ⇒ abandoned_staging precondition (operator cleanup)
    const s4 = tmpStore(); const owned4 = [];
    await inStore(s4, owned4, () => {
      writeLegacyLedger(s4.dir, { count: 1 });
      fs.mkdirSync(path.join(s4.parent, 'tracked-injections.json.migrating.aaaa'));
      fs.mkdirSync(path.join(s4.parent, 'tracked-injections.json.migrating.bbbb'));
      const crashed4 = trackOwnerFds();
      h = createOwnerHarness({ dir: s4.dir, fsImpl: crashed4.fs }); owned4.push({ h, tracked: crashed4 });
      const o4 = h.open();
      assert.equal(o4.reason, 'migration_precondition'); assert.equal(o4.stateMessage.detail, 'abandoned_staging');
      assert.equal(fs.statSync(s4.dir).isFile(), true);
      crashOwner(h, crashed4);
    });
  });
}));

test('X1: the installed 0.9.1 persistence cannot write over or read the directory store (errno recorded); no tmp residue; directory unchanged', { skip: !POSIX && 'errno recorded on POSIX only; Windows unsupported for cutover until measured' }, () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir }); h.open(); await begin(h, 'i', 'w'); await h.close(); h.release();
  const installed = require('./fixtures/0.9.1/src/session-store/persistence');
  const inventory = require('./fixtures/0.9.1/INVENTORY.json');
  assert.equal(sha256(fs.readFileSync(path.join(__dirname, 'fixtures/0.9.1/src/session-store/persistence.js'))), inventory.files.find((f) => f.path === 'src/session-store/persistence.js').sha256, 'frozen body is byte-exact');
  const before = shaTree(s.dir);
  const saved = installed.saveTrackedInjections(installed.emptyTrackedInjections(), s.dir);
  assert.equal(saved.ok, false); assert.equal(saved.reason, 'observation_store_write_failed');
  assert.ok(['EISDIR', 'EPERM', 'EEXIST', 'ENOTEMPTY'].includes(saved.error && saved.error.code), `errno recorded: ${saved.error && saved.error.code}`);
  const loaded = installed.loadTrackedInjections(s.dir);
  assert.equal(loaded.ok, false); assert.equal(loaded.reason, 'observation_store_unavailable');
  assert.deepEqual(shaTree(s.dir), before);
  assert.deepEqual(fs.readdirSync(s.parent).filter((n) => n.startsWith('.tracked-injections.') && n.endsWith('.tmp')), [], 'no tmp residue');
}));

test('R4 / E6-lite / C8: a cold record is reheated by a write (facts materialized, seq continues); resident admission refuses begins beyond HOT_MAX_RECORDS; residency releases only after a checkpoint demoted terminal records', () => withStore(async (s) => {
  const legacy = writeLegacyLedger(s.dir, { count: 3, obsPerRecord: 3 });
  let h = createOwnerHarness({ dir: s.dir, hotMaxRecords: 2 });
  h.open();
  await h.submit('fact', { scope: 'global', observation: { kind: 'daemon_restart_observed', trigger: 'daemon_restart', at: nowIso() } }, { cls: 'L' });
  await h.submit('fact', { scope: 'global', observation: { kind: 'daemon_restart_observed', trigger: 'daemon_restart', at: nowIso() } }, { cls: 'L' });
  const cold = legacy.ids[0];
  const coldNack = await obs(h, cold, 'output_observed', 'output_received');
  assert.equal(coldNack.type, 'nack'); assert.equal(coldNack.reason, 'record_cold', 'reads never reheat; a write asks for an explicit reheat');
  const noJob = await h.submit('reheat', { id: cold }, { cls: 'L' });
  assert.equal(noJob.type, 'nack'); assert.equal(noJob.reason, 'tracking_capacity_exhausted', 'a tracked record becomes an admitted job: reservation required');
  const reheat = await h.submit('reheat', { id: cold, job_reserved: true }, { cls: 'L' });
  assert.equal(reheat.type, 'ack');
  assert.equal(reheat.effects[0].record.observation_seq, 3 + 2, 'stored + 2 overlay facts');
  const o = await obs(h, cold, 'output_observed', 'output_received');
  assert.equal(o.entry.seq, 6);
  const view = h.read('get', { id: cold }).items[0];
  assert.equal(view.observation_seq, 6); assert.equal(view.tier === undefined, true);
  assert.equal(h.read('get', { id: cold }).tier, 'hot');
  // resident cap: 2 hot records max (1 reheated + 1 begin); the third is rejected by the OWNER, named
  assert.equal((await begin(h, 'n1', 'w1')).type, 'ack');
  const full = await begin(h, 'n2', 'w2');
  assert.equal(full.type, 'nack'); assert.equal(full.reason, 'hot_capacity'); assert.equal(full.resident.records, 2);
  // the cold records and the facts stay readable
  assert.equal(h.read('get', { id: legacy.ids[1] }).items[0].observation_seq, 5);
  // terminal + checkpoint ⇒ demotion ⇒ residency released ⇒ further begins admitted
  assert.equal((await state(h, 'n1', 'aborted')).type, 'ack');
  const before = h.read('status').items[0];
  const compacted = h.read('compact').items[0];
  assert.ok(compacted.demoted >= 1, JSON.stringify(compacted));
  const after = h.read('status').items[0];
  assert.ok(after.resident.records < before.resident.records);
  assert.equal((await begin(h, 'n2', 'w2')).type, 'ack');
  assert.equal(h.read('get', { id: 'n1' }).tier, 'cold'); assert.equal(h.read('get', { id: 'n1' }).items[0].tracking_state, 'aborted');
  // cold files are immutable: a further commit does not touch them
  const coldFiles = fs.readdirSync(path.join(s.dir, 'cold')).map((n) => [n, fs.statSync(path.join(s.dir, 'cold', n)).mtimeMs, sha256(fs.readFileSync(path.join(s.dir, 'cold', n)))]);
  await obs(h, 'n2', 'output_observed', 'output_received');
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'cold')).map((n) => [n, fs.statSync(path.join(s.dir, 'cold', n)).mtimeMs, sha256(fs.readFileSync(path.join(s.dir, 'cold', n)))]), coldFiles);
  await h.close(); h.release();
  // reopen: cold + hot survive, listSession sees both tiers
  h = createOwnerHarness({ dir: s.dir });
  const re = h.open();
  assert.equal(re.state, 'available');
  assert.equal(h.read('get', { id: 'n1' }).items[0].tracking_state, 'aborted');
  assert.equal(h.read('get', { id: 'n2' }).items[0].observation_seq, 2);
  await h.close(); h.release();
}));

test('exportV3: the downgrade export loads with the frozen 0.9.1 loader; record count == hot + cold; overlay facts materialized; observations <= 50', () => withStore(async (s) => {
  const legacy = writeLegacyLedger(s.dir, { count: 8, obsPerRecord: 49 });
  const h = createOwnerHarness({ dir: s.dir });
  h.open();
  await h.submit('fact', { scope: 'global', observation: { kind: 'daemon_restart_observed', trigger: 'daemon_restart', at: nowIso() } }, { cls: 'L' });
  await begin(h, 'live-1', 'w'); await obs(h, 'live-1', 'output_observed', 'output_received');
  const out = path.join(s.home, 'export.v3.json');
  const r = h.read('exportV3', { out }).items[0];
  assert.equal(r.ok, true); assert.equal(r.records, 9);
  const installed = require('./fixtures/0.9.1/src/session-store/persistence');
  const loaded = installed.loadTrackedInjections(out);
  assert.equal(loaded.ok, true);
  assert.equal(Object.keys(loaded.ledger.injections).length, 9);
  const hist = loaded.ledger.injections[legacy.ids[0]];
  assert.equal(hist.observations.length, 50); assert.equal(hist.observation_seq, 50); assert.equal(hist.last_observation.kind, 'daemon_restart_observed');
  assert.equal(hist.materialized_through, undefined);
  assert.equal(loaded.ledger.injections['live-1'].observation_seq, 2);
  await h.close(); h.release();
}));

test('frame_too_large is a pre-write nack; a frame above the group soft cap forms its own group; the segment rolls at the soft size', () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir, group: { frames: 64, bytes: 4096, ms: 5 } });
  h.open(); await begin(h, 'i', 'w');
  const tooBig = await obs(h, 'i', 'k', 't', { pad: 'x'.repeat(F.FRAME_CAPS.obs) });
  assert.equal(tooBig.type, 'nack'); assert.equal(tooBig.reason, 'frame_too_large');
  const n0 = readFrames(segmentFiles(s.dir).pop()).frames.length;
  const [small, large, small2] = await Promise.all([
    obs(h, 'i', 'a', '1'), obs(h, 'i', 'b', '2', { pad: 'y'.repeat(6000) }), obs(h, 'i', 'c', '3'),
  ]);
  assert.deepEqual([small.type, large.type, small2.type], ['ack', 'ack', 'ack']);
  const frames = readFrames(segmentFiles(s.dir).pop()).frames.map((f) => f.obj).slice(n0);
  // small | commit | large | commit | small2 | commit  (the large frame is its own group)
  const commits = frames.filter((f) => f.t === 'commit');
  assert.ok(commits.length >= 2, `the large frame formed its own group: ${frames.map((f) => f.t).join(',')}`);
  await h.close(); h.release();
}));
