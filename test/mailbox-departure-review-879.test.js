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
