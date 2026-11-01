'use strict';
// Task 1215 / #879 — independent regression for the W1 departure-candidate review (w1-review3 REVIEW.json R1/R2).
// Standalone: requires only the unchanged candidate src/mailbox/lock.js (+ path-boundary.js) and Node builtins.
// Faults come from an explicit, counted fs seam (t.mock.method on the `fs` module the product uses) with a fixed
// schedule — no sleeps, races, child processes, listeners or network. Every pre-made peer ticket names THIS
// process's pid, which is alive: no peer is ever declared dead and no live owner may be evicted.
// This is a controlled fault regression on the host OS, not a measurement of native NTFS behaviour.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock } = require('../src/mailbox/lock');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-879-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 's');
  fs.mkdirSync(sessionDir, { mode: 0o700 });
  const lockDir = path.join(sessionDir, '.lock');
  fs.mkdirSync(lockDir, { mode: 0o700 });
  return { root, sessionDir, lockDir };
}
// A pre-made peer acquisition ticket of this (live) process.
function peer(lockDir, files = {}) {
  const name = `${process.pid}-${crypto.randomBytes(16).toString('hex')}`, dir = path.join(lockDir, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content, { mode: 0o600 });
  return { name, dir };
}
// One acquisition attempt; `during(release)` observes state at the instant acquireLock returned.
function attempt(sessionDir, timeoutMs, during) {
  let release = null, error = null;
  try { release = acquireLock(sessionDir, { timeoutMs }); } catch (e) { error = e.code || String(e.message); }
  const extra = during ? during(release) : {};
  if (release) release();
  return { error, acquired: !!release, ...extra };
}
const eperm = (syscall, target) => Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${target}'`),
  { code: 'EPERM', errno: -1, syscall, path: target });
const listing = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);

// ---- R1: a delete-pending peer ticket DIRECTORY (listed; lstat/readdir EPERM until the peer's handle closes) ----
test('C1 R1: transient EPERM lstat on a peer ticket DIRECTORY blocks, then the acquirer progresses after it clears', t => {
  const f = fixture(t), p = peer(f.lockDir), lstat = fs.lstatSync;
  let epermCalls = 0, cleared = false;
  t.mock.method(fs, 'lstatSync', function (target, ...rest) {
    if (target === p.dir && !cleared) {
      if (++epermCalls <= 3) throw eperm('lstat', target);   // delete-pending directory: still listed, lstat EPERM
      fs.rmdirSync(p.dir); cleared = true;                    // the peer's last handle closed: the name disappears
    }
    return lstat.call(this, target, ...rest);
  });
  const outcome = attempt(f.sessionDir, 1000, release => ({ acquiredOnlyAfterClear: !!release && cleared }));
  t.mock.restoreAll();
  assert.deepEqual(outcome, { error: null, acquired: true, acquiredOnlyAfterClear: true }, JSON.stringify({ outcome, epermCalls, cleared }));
});

test('C2 R1: transient EPERM readdir of a peer ticket DIRECTORY blocks, then the acquirer progresses after it clears', t => {
  const f = fixture(t), p = peer(f.lockDir), readdir = fs.readdirSync;
  let epermCalls = 0, cleared = false;
  t.mock.method(fs, 'readdirSync', function (target, ...rest) {
    if (target === p.dir && !cleared) {
      if (++epermCalls <= 3) throw eperm('scandir', target);
      fs.rmdirSync(p.dir); cleared = true;
    }
    return readdir.call(this, target, ...rest);
  });
  const outcome = attempt(f.sessionDir, 1000, release => ({ acquiredOnlyAfterClear: !!release && cleared }));
  t.mock.restoreAll();
  assert.deepEqual(outcome, { error: null, acquired: true, acquiredOnlyAfterClear: true }, JSON.stringify({ outcome, epermCalls, cleared }));
});

test('C3 R1 control: a PERSISTENT EPERM lstat on a peer ticket directory never admits and never evicts the peer', t => {
  const f = fixture(t), p = peer(f.lockDir), lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function (target, ...rest) {
    if (target === p.dir) throw eperm('lstat', target);
    return lstat.call(this, target, ...rest);
  });
  const o = attempt(f.sessionDir, 200);
  t.mock.restoreAll();
  const observed = { acquired: o.acquired, failClosed: ['EPERM', 'MAILBOX_LOCK_TIMEOUT'].includes(o.error), peerKept: fs.existsSync(p.dir) };
  assert.deepEqual(observed, { acquired: false, failClosed: true, peerKept: true }, JSON.stringify({ o, observed }));
});

test('C4 live-owner control: a real holder stays exclusive, unmarked and unevicted', t => {
  const f = fixture(t), holder = acquireLock(f.sessionDir);
  const [own] = fs.readdirSync(f.lockDir);
  const second = attempt(f.sessionDir, 150);
  const holderTicket = listing(path.join(f.lockDir, own));
  holder();
  const observed = { second, holderTicket, after: listing(f.lockDir) };
  assert.deepEqual(observed, { second: { error: 'MAILBOX_LOCK_TIMEOUT', acquired: false }, holderTicket: ['number'], after: [] }, JSON.stringify(observed));
});

// ---- R2: a departure marker must not suppress refusal of unsafe ticket entries ------------------------------
test('C5 R2: marker-present SYMLINK number is refused as unsafe; the link target and the evidence are kept', t => {
  const f = fixture(t), target = path.join(f.root, 'owned-target');
  fs.writeFileSync(target, 'keep', { mode: 0o600 });
  const p = peer(f.lockDir, { departed: '' });
  fs.symlinkSync(target, path.join(p.dir, 'number'));
  const o = attempt(f.sessionDir, 200);
  const observed = { error: o.error, acquired: o.acquired, target: fs.readFileSync(target, 'utf8'), evidence: listing(p.dir) };
  assert.deepEqual(observed, { error: 'MAILBOX_UNSAFE_PATH', acquired: false, target: 'keep', evidence: ['departed', 'number'] }, JSON.stringify(observed));
});

test('C6 R2: marker-present DIRECTORY number is refused as unsafe; its contents and the evidence are kept', t => {
  const f = fixture(t), p = peer(f.lockDir, { departed: '' }), inner = path.join(p.dir, 'number');
  fs.mkdirSync(inner, { mode: 0o700 });
  fs.writeFileSync(path.join(inner, 'owned'), 'keep', { mode: 0o600 });
  const o = attempt(f.sessionDir, 200);
  const observed = { error: o.error, acquired: o.acquired, evidence: listing(p.dir), inner: fs.existsSync(path.join(inner, 'owned')) ? fs.readFileSync(path.join(inner, 'owned'), 'utf8') : null };
  assert.deepEqual(observed, { error: 'MAILBOX_UNSAFE_PATH', acquired: false, evidence: ['departed', 'number'], inner: 'keep' }, JSON.stringify(observed));
});

test('C7 R2: marker-present HARD-LINKED number is refused as unsafe; the other link and the evidence are kept', t => {
  const f = fixture(t), owned = path.join(f.root, 'owned-file');
  fs.writeFileSync(owned, '1', { mode: 0o600 });
  const p = peer(f.lockDir, { departed: '' });
  fs.linkSync(owned, path.join(p.dir, 'number'));
  const o = attempt(f.sessionDir, 200);
  const observed = { error: o.error, acquired: o.acquired, owned: fs.readFileSync(owned, 'utf8'), ownedLinks: fs.statSync(owned).nlink, evidence: listing(p.dir) };
  assert.deepEqual(observed, { error: 'MAILBOX_UNSAFE_PATH', acquired: false, owned: '1', ownedLinks: 2, evidence: ['departed', 'number'] }, JSON.stringify(observed));
});

test('C8 R2 control: the same SYMLINK number without a marker is refused as unsafe (fixture validity)', t => {
  const f = fixture(t), target = path.join(f.root, 'owned-target');
  fs.writeFileSync(target, 'keep', { mode: 0o600 });
  const p = peer(f.lockDir);
  fs.symlinkSync(target, path.join(p.dir, 'number'));
  const o = attempt(f.sessionDir, 200);
  const observed = { error: o.error, acquired: o.acquired, target: fs.readFileSync(target, 'utf8'), evidence: listing(p.dir) };
  assert.deepEqual(observed, { error: 'MAILBOX_UNSAFE_PATH', acquired: false, target: 'keep', evidence: ['number'] }, JSON.stringify(observed));
});

// ---- marker-present number EPERM (directory NOT gone) and the no-marker permission control -------------------
test('C9 control: EPERM on a number whose peer is departing (marker listed, directory present) is a departure', t => {
  const f = fixture(t), p = peer(f.lockDir, { number: '1' }), number = path.join(p.dir, 'number'), open = fs.openSync;
  let atEperm = null;
  t.mock.method(fs, 'openSync', function (target, ...rest) {
    if (target === number && atEperm === null) {
      fs.closeSync(open.call(fs, path.join(p.dir, 'departed'), 'wx', 0o600));   // the peer's departure linearization point
      atEperm = { listed: fs.readdirSync(p.dir).sort(), dirPresent: fs.existsSync(p.dir) };
      throw eperm('open', target);                                             // its number is now delete-pending
    }
    return open.call(this, target, ...rest);
  });
  const o = attempt(f.sessionDir, 1000);
  t.mock.restoreAll();
  const observed = { ...o, atEperm };
  assert.deepEqual(observed, { error: null, acquired: true, atEperm: { listed: ['departed', 'number'], dirPresent: true } }, JSON.stringify(observed));
});

test('C10 permission control: EPERM on a live number WITHOUT a marker still fails closed and keeps the ticket', t => {
  const f = fixture(t), p = peer(f.lockDir, { number: '1' }), number = path.join(p.dir, 'number'), open = fs.openSync;
  t.mock.method(fs, 'openSync', function (target, ...rest) {
    if (target === number) throw eperm('open', target);
    return open.call(this, target, ...rest);
  });
  const o = attempt(f.sessionDir, 200);
  t.mock.restoreAll();
  const observed = { ...o, peer: listing(p.dir) };
  assert.deepEqual(observed, { error: 'EPERM', acquired: false, peer: ['number'] }, JSON.stringify(observed));
});

// ---- #1215 lock227: EPERM from removeTicket's OWN ticket-directory listing during a REAP --------------------------
// Windows job 124852862725 (8f7a70b tree): acquireLockObserved:308 (admission) → readTicket:197 (DEPARTED listed) →
// removeTicket:158 → checkTicketFiles → ticketNames:97 readdirSync threw a raw EPERM scandir out of acquireLock. Here
// the same branches are driven through counted seams with a fixed per-call schedule (no sleeps, races or children).
// A "concurrent remover finishing" is the seam itself completing the departure (unlink + rmdir with the real fs) right
// before it throws EPERM, modelling a delete-pending directory. Unlike C1–C10, the dead-owner cases (R3, R4, P2) make
// exactly one synthetic pid (DEAD_PID, never this process) report ESRCH through a process.kill seam; no real process
// is signalled or declared dead. The cases without a reap (N2, N3) and the denial controls (N1, N4) are unchanged rules.
// A RED case's first assertion names the escaped error: on the original it is the seam's own EPERM (`seam-scandir`).
const { reapSessionLocks, lockDiagnostics } = require('../src/mailbox/lock');
const DEAD_PID = 2147483646; // a valid ticket pid (<= 0x7fffffff); only the seam below ever answers for it
const COUNTER_KEYS = ['dir_unresolved', 'eperm_total', 'eperm_reap_list_unresolved', 'eperm_reap_relist_unresolved'];
const NO_COUNTS = { dir_unresolved: 0, eperm_total: 0, eperm_reap_list_unresolved: 0, eperm_reap_relist_unresolved: 0 };
// Process-wide lock totals across one case (a key the module does not have counts as 0).
function counterDelta(before) {
  const after = lockDiagnostics();
  return Object.fromEntries(COUNTER_KEYS.map(key => [key, (after[key] ?? 0) - (before[key] ?? 0)]));
}
// A pre-made acquisition ticket of an arbitrary pid.
function ticketOf(lockDir, pid, files = {}) {
  const name = `${pid}-${crypto.randomBytes(16).toString('hex')}`, dir = path.join(lockDir, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content, { mode: 0o600 });
  return { name, dir };
}
// Counted readdirSync seam for one ticket directory. plan(call) (1-based) returns undefined (real listing), true
// (throw EPERM scandir) or a function (run it, then throw EPERM scandir). Every injected error is kept by identity.
function listingSeam(t, isTarget, plan) {
  const readdir = fs.readdirSync, seam = { calls: 0, injected: [] };
  seam.finish = dir => { for (const name of readdir.call(fs, dir)) fs.unlinkSync(path.join(dir, name)); fs.rmdirSync(dir); };
  t.mock.method(fs, 'readdirSync', function (target, ...rest) {
    if (isTarget(target)) {
      const action = plan(++seam.calls);
      if (action) {
        if (typeof action === 'function') action();
        const e = eperm('scandir', target); seam.injected.push(e); throw e;
      }
    }
    return readdir.call(this, target, ...rest);
  });
  return seam;
}
// process.kill seam: exactly DEAD_PID is reported dead (ESRCH); every other call is the real process.kill.
function deadPidSeam(t) {
  const kill = process.kill, seam = { probes: 0 };
  t.mock.method(process, 'kill', function (pid, signal) {
    if (pid === DEAD_PID) { seam.probes++; throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' }); }
    return kill.call(this, pid, signal);
  });
  return seam;
}
// An error a seam injected is named `seam-<syscall>`; anything else by its code (or message).
function classify(e, seams) {
  return seams.some(seam => seam.injected.includes(e)) ? `seam-${e.syscall}` : (e && e.code) || String(e && e.message);
}
function acquireOnce(sessionDir, seams, timeoutMs = 1000) {
  let release = null, error = null;
  try { release = acquireLock(sessionDir, { timeoutMs }); } catch (e) { error = classify(e, seams); }
  return { error, release };
}
function reapOnce(sessionDir, seams) {
  try { return { error: null, removed: reapSessionLocks(sessionDir) }; } catch (e) { return { error: classify(e, seams), removed: null }; }
}

test('[L227 R1] admission reap of a departed ticket: EPERM at the first removeTicket listing is left to the finishing remover', t => {
  const f = fixture(t), before = lockDiagnostics(), rename = fs.renameSync;
  let p = null;
  // The departed peer appears right after this acquirer publishes its number, so the reap runs in the ADMISSION scan.
  t.mock.method(fs, 'renameSync', function (from, to, ...rest) {
    const result = rename.call(this, from, to, ...rest);
    if (p === null && path.basename(to) === 'number' && path.dirname(path.dirname(to)) === f.lockDir) p = peer(f.lockDir, { departed: '', number: '1' });
    return result;
  });
  const seam = listingSeam(t, target => p !== null && target === p.dir, call => (call === 2 ? () => seam.finish(p.dir) : undefined));
  const o = acquireOnce(f.sessionDir, [seam]);
  t.mock.restoreAll();
  if (o.release) o.release();
  assert.equal(o.error, null, `[L227 R1] removeTicket first-listing EPERM escaped the admission reap: ${o.error}`);
  const observed = { created: p !== null, calls: seam.calls, injected: seam.injected.length, dirGone: !fs.existsSync(p.dir), lock: listing(f.lockDir) };
  assert.deepEqual(observed, { created: true, calls: 2, injected: 1, dirGone: true, lock: [] }, JSON.stringify(observed));
  assert.deepEqual(counterDelta(before), { ...NO_COUNTS, dir_unresolved: 1, eperm_total: 1, eperm_reap_list_unresolved: 1 });
});

test('[L227 R2] departed reap: EPERM at the post-unlink re-list is left to the finishing remover', t => {
  const f = fixture(t), before = lockDiagnostics(), p = peer(f.lockDir, { departed: '', number: '1' });
  const seam = listingSeam(t, target => target === p.dir, call => (call === 3 ? () => seam.finish(p.dir) : undefined));
  const o = acquireOnce(f.sessionDir, [seam]);
  t.mock.restoreAll();
  if (o.release) o.release();
  assert.equal(o.error, null, `[L227 R2] removeTicket re-list EPERM escaped the departed reap: ${o.error}`);
  const observed = { calls: seam.calls, injected: seam.injected.length, dirGone: !fs.existsSync(p.dir), lock: listing(f.lockDir) };
  assert.deepEqual(observed, { calls: 3, injected: 1, dirGone: true, lock: [] }, JSON.stringify(observed));
  assert.deepEqual(counterDelta(before), { ...NO_COUNTS, dir_unresolved: 1, eperm_total: 1, eperm_reap_relist_unresolved: 1 });
});

test('[L227 R3] dead-owner reap in acquireLock: EPERM at the first listing (a concurrent reaper finishing) is left to it', t => {
  const f = fixture(t), before = lockDiagnostics(), p = ticketOf(f.lockDir, DEAD_PID, { number: '1' }), dead = deadPidSeam(t);
  const seam = listingSeam(t, target => target === p.dir, call => (call === 2 ? () => seam.finish(p.dir) : undefined));
  const o = acquireOnce(f.sessionDir, [seam]);
  t.mock.restoreAll();
  if (o.release) o.release();
  assert.equal(o.error, null, `[L227 R3] removeTicket first-listing EPERM escaped the dead-owner reap: ${o.error}`);
  const observed = { probes: dead.probes, calls: seam.calls, injected: seam.injected.length, dirGone: !fs.existsSync(p.dir), lock: listing(f.lockDir) };
  assert.deepEqual(observed, { probes: 1, calls: 2, injected: 1, dirGone: true, lock: [] }, JSON.stringify(observed));
  assert.deepEqual(counterDelta(before), { ...NO_COUNTS, dir_unresolved: 1, eperm_total: 1, eperm_reap_list_unresolved: 1 });
});

test('[L227 R4] dead-owner reap in reapSessionLocks: EPERM at the re-list is left pending and never counted as removed', t => {
  const f = fixture(t), before = lockDiagnostics(), p = ticketOf(f.lockDir, DEAD_PID, { number: '1' }), dead = deadPidSeam(t);
  const seam = listingSeam(t, target => target === p.dir, call => (call === 3 ? () => seam.finish(p.dir) : undefined));
  const o = reapOnce(f.sessionDir, [seam]);
  t.mock.restoreAll();
  assert.equal(o.error, null, `[L227 R4] removeTicket re-list EPERM escaped the dead-owner reap: ${o.error}`);
  const observed = { removed: o.removed, probes: dead.probes, calls: seam.calls, injected: seam.injected.length, dirGone: !fs.existsSync(p.dir) };
  assert.deepEqual(observed, { removed: 0, probes: 1, calls: 3, injected: 1, dirGone: true }, JSON.stringify(observed));
  assert.deepEqual(counterDelta(before), NO_COUNTS, 'no acquisition is active, so nothing is counted');
});

test('[L227 R5] a persistently refused departed-ticket reap listing is bounded: one attempt per scan, cleanup left pending', t => {
  const f = fixture(t), before = lockDiagnostics(), p = peer(f.lockDir, { departed: '', number: '1' });
  const seam = listingSeam(t, target => target === p.dir, call => (call % 2 === 0 ? true : undefined)); // every removeTicket listing
  const o = acquireOnce(f.sessionDir, [seam]);
  t.mock.restoreAll();
  const pending = listing(p.dir);
  if (o.release) o.release();
  assert.equal(o.error, null, `[L227 R5] a persistent reap-listing EPERM escaped acquireLock: ${o.error}`);
  const observed = { calls: seam.calls, injected: seam.injected.length, pending };
  assert.deepEqual(observed, { calls: 4, injected: 2, pending: ['departed', 'number'] }, JSON.stringify(observed));
  assert.deepEqual(counterDelta(before), { ...NO_COUNTS, dir_unresolved: 2, eperm_total: 2, eperm_reap_list_unresolved: 2 });
  acquireLock(f.sessionDir)(); // the refusal cleared: an ordinary later reap finishes the departure
  assert.deepEqual(listing(f.lockDir), []);
});

test('[L227 P1] positive control: a departed own-pid ticket is fully reaped through removeTicket', t => {
  const f = fixture(t), before = lockDiagnostics(), p = peer(f.lockDir, { departed: '', number: '1' });
  const seam = listingSeam(t, target => target === p.dir, () => undefined);
  const o = acquireOnce(f.sessionDir, [seam]);
  t.mock.restoreAll();
  if (o.release) o.release();
  const observed = { error: o.error, acquired: !!o.release, calls: seam.calls, dirGone: !fs.existsSync(p.dir), lock: listing(f.lockDir), counters: counterDelta(before) };
  assert.deepEqual(observed, { error: null, acquired: true, calls: 3, dirGone: true, lock: [], counters: NO_COUNTS }, JSON.stringify(observed));
});

test('[L227 P2] positive control: a dead owner\'s unmarked ticket is fully reaped and counted once', t => {
  const f = fixture(t), p = ticketOf(f.lockDir, DEAD_PID, { number: '1' }), dead = deadPidSeam(t);
  const seam = listingSeam(t, target => target === p.dir, () => undefined);
  const o = reapOnce(f.sessionDir, [seam]);
  t.mock.restoreAll();
  const observed = { ...o, probes: dead.probes, calls: seam.calls, dirGone: !fs.existsSync(p.dir), lock: listing(f.lockDir) };
  assert.deepEqual(observed, { error: null, removed: 1, probes: 1, calls: 3, dirGone: true, lock: [] }, JSON.stringify(observed));
});

test('[L227 N1] denial control: a persistent EPERM listing of an UNMARKED live ticket blocks to timeout and keeps it', t => {
  const f = fixture(t), before = lockDiagnostics(), p = peer(f.lockDir, { number: '1' });
  const seam = listingSeam(t, target => target === p.dir, () => true);
  const o = acquireOnce(f.sessionDir, [seam], 200);
  t.mock.restoreAll();
  const counters = counterDelta(before);
  const observed = { error: o.error, acquired: !!o.release, everyCallRefused: seam.calls > 0 && seam.injected.length === seam.calls,
    blockedEachScan: counters.dir_unresolved === seam.calls, peer: listing(p.dir), counters: { ...counters, dir_unresolved: 0 } };
  assert.deepEqual(observed, { error: 'MAILBOX_LOCK_TIMEOUT', acquired: false, everyCallRefused: true, blockedEachScan: true, peer: ['number'], counters: NO_COUNTS },
    JSON.stringify({ observed, calls: seam.calls }));
});

test('[L227 N2] owner control: an EPERM listing of the owner\'s own ticket during release() still throws', t => {
  const f = fixture(t), release = acquireLock(f.sessionDir), [own] = fs.readdirSync(f.lockDir), ownDir = path.join(f.lockDir, own);
  const seam = listingSeam(t, target => target === ownDir, () => true);
  let error = null;
  try { release(); } catch (e) { error = classify(e, [seam]); }
  t.mock.restoreAll();
  const kept = listing(ownDir);
  release(); // a refused release is not marked released: the same release finishes once the refusal clears
  const observed = { error, injected: seam.injected.length, kept, after: listing(f.lockDir) };
  assert.deepEqual(observed, { error: 'seam-scandir', injected: 1, kept: ['number'], after: [] }, JSON.stringify(observed));
});

test('[L227 N3] owner control: an EPERM listing of the owner\'s own ticket during failed-acquisition cleanup still throws', t => {
  const f = fixture(t), before = lockDiagnostics(), blocker = peer(f.lockDir, { number: '1' }), rename = fs.renameSync;
  let ownDir = null;
  // Armed only once this acquirer has published: after that its own directory is listed only by the abort cleanup.
  t.mock.method(fs, 'renameSync', function (from, to, ...rest) {
    const result = rename.call(this, from, to, ...rest);
    if (ownDir === null && path.basename(to) === 'number' && path.dirname(path.dirname(to)) === f.lockDir) ownDir = path.dirname(to);
    return result;
  });
  const seam = listingSeam(t, target => ownDir !== null && target === ownDir, () => true);
  const o = acquireOnce(f.sessionDir, [seam], 100);
  t.mock.restoreAll();
  const observed = { error: o.error, acquired: !!o.release, injected: seam.injected.length, own: ownDir && listing(ownDir), blocker: listing(blocker.dir), counters: counterDelta(before) };
  assert.deepEqual(observed, { error: 'seam-scandir', acquired: false, injected: 1, own: ['number'], blocker: ['number'], counters: NO_COUNTS }, JSON.stringify(observed));
});

test('[L227 N4] unlink control: a refused unlink of a stat-able entry in a departed reap still throws and keeps the evidence', t => {
  const f = fixture(t), before = lockDiagnostics(), p = peer(f.lockDir, { departed: '', number: '1' }), number = path.join(p.dir, 'number');
  const unlink = fs.unlinkSync, refused = { injected: [] };
  t.mock.method(fs, 'unlinkSync', function (target, ...rest) {
    if (target === number) { const e = eperm('unlink', target); refused.injected.push(e); throw e; }
    return unlink.call(this, target, ...rest);
  });
  const o = acquireOnce(f.sessionDir, [refused]);
  t.mock.restoreAll();
  const observed = { error: o.error, acquired: !!o.release, injected: refused.injected.length, evidence: listing(p.dir), counters: counterDelta(before) };
  assert.deepEqual(observed, { error: 'seam-unlink', acquired: false, injected: 1, evidence: ['departed', 'number'], counters: NO_COUNTS }, JSON.stringify(observed));
});
