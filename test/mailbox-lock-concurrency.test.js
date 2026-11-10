'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { acquireLock, breakStaleLocks, ensureSessionDir } = require('../src/mailbox/storage');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-lock-v2-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: ensureSessionDir(root, 's') };
}
// Timeout-path-only, read-only diagnostics (#1215 mac a41): ticket pid/state and counter, never ticket
// suffixes or payload. Nothing here runs unless a worker timeout has already failed the test.
function lockSnapshot(dir) {
  const lock = path.join(dir, '.lock'), tickets = [];
  let counter; try { counter = Number(fs.readFileSync(path.join(dir, 'counter'), 'utf8')); } catch (e) { counter = e.code; }
  let names; try { names = fs.readdirSync(lock).slice(0, 64); } catch (e) { return {counter, lock: e.code}; }
  for (const name of names) {
    let state;
    try {
      const files = fs.readdirSync(path.join(lock, name));
      state = files.includes('departed') ? 'departed' : files.includes('number') ? Number(fs.readFileSync(path.join(lock, name, 'number'), 'utf8')) : 'choosing';
    } catch (e) { state = e.code; }
    tickets.push({pid: Number(name.split('-')[0]), state});
  }
  return {counter, tickets};
}
function diagnostic(probe, self) {
  let extra; try { extra = probe(); } catch (e) { extra = {probe: e.code || 'error'}; }
  return ` | diag ${JSON.stringify({self, ...extra})}`;
}
// #1215 correction7 (test-only): the per-worker timer is a NO-PROGRESS guard, not a whole-work budget. macOS 3b2c44a
// measured 197/200 ordered increments, zero lock errors/timeouts and every acquisition under the 500 ms product bound,
// while each requested 10 ms pause averaged 42-46 ms: a 10 s total for 40 contended iterations asserted throughput,
// not exclusion or progress. The guard is re-armed ONLY by a valid, strictly advancing milestone record from this
// child's own stderr (the existing `lock-diag` progress line written after iterations 9/19/29/39). Split, multiple,
// duplicate, malformed, out-of-range or non-milestone records never re-arm it. Bound: at most floor(iterations / 10)
// re-arms, so a worker is given at most (floor(iterations / 10) + 1) × stallMs in total — 50 s for 40 iterations.
const PROGRESS_PREFIX = 'lock-diag ', PROGRESS_EVERY = 10;
function progressGuard(iterations) {
  let pending = '', last = -1;
  const milestones = Math.floor(iterations / PROGRESS_EVERY);
  return {
    milestones,
    get last() { return last; },
    feed(chunk) { // → number of strictly advancing milestones accepted from this chunk
      pending += chunk; let advanced = 0;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line.startsWith(PROGRESS_PREFIX)) continue;
        let record; try { record = JSON.parse(line.slice(PROGRESS_PREFIX.length)); } catch { continue; }
        const i = record && record.kind === 'progress' ? record.iteration : undefined;
        if (!Number.isSafeInteger(i) || i < 0 || i >= iterations || (i + 1) % PROGRESS_EVERY !== 0 || i <= last) continue;
        last = i; advanced++;
      }
      return advanced;
    },
  };
}
function worker(t, dir, mode, iterations = 1, probe = () => ({}), { stallMs = 10000 } = {}) {
  const forked = performance.now();
  const child = fork(path.join(__dirname, '../test-support/mailbox-lock-worker.js'), [dir, mode, String(iterations)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const guard = progressGuard(mode === 'contend' ? iterations : 0);
  let output = '', onProgress = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', b => { output += b; if (guard.feed(b) > 0 && onProgress) onProgress(); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const next = () => new Promise((resolve, reject) => {
    const armed = performance.now(), maxMs = (guard.milestones + 1) * stallMs;
    let timer;
    const expire = () => { clean(); reject(Error(`worker timeout: no progress for ${stallMs} ms (last milestone ${guard.last}): ${output}${diagnostic(probe, {mode, pid: child.pid,
      exitCode: child.exitCode, signalCode: child.signalCode, connected: child.connected, sinceForkMs: Math.round(performance.now() - forked)})}`)); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(expire, Math.min(stallMs, Math.max(0, armed + maxMs - performance.now()))); };
    const fail = code => { clean(); reject(Error(`worker exited ${code}: ${output}`)); };
    const message = value => { clean(); resolve(value); };
    function clean() { clearTimeout(timer); onProgress = null; child.off('message', message); child.off('exit', fail); }
    onProgress = arm; arm();
    child.once('message', message); child.once('exit', fail);
  });
  return { child, next };
}
test('an aged live lock remains exclusive through startup sweep and acquisition', t => {
  const {root, dir} = fixture(t), release = acquireLock(dir);
  try {
    const old = new Date(Date.now() - 70000); fs.utimesSync(path.join(dir, '.lock'), old, old);
    assert.equal(breakStaleLocks(root), 0);
    assert.throws(() => acquireLock(dir), /lock timeout/i);
  } finally { release(); }
});
test('a repeated old release cannot delete a successor acquisition', t => {
  const {dir} = fixture(t), release = acquireLock(dir); release();
  const successor = acquireLock(dir);
  try { release(); assert.throws(() => acquireLock(dir), /lock timeout/i); }
  finally { successor(); }
});
test('legacy PID files fail closed without deleting even invalid or dead owners', t => {
  const {root, dir} = fixture(t), file = path.join(dir, '.lock');
  for (const body of ['', 'garbage', '0', '-1', '999999', String(process.pid)]) {
    fs.writeFileSync(file, body); const old = new Date(Date.now() - 70000); fs.utimesSync(file, old, old);
    assert.throws(() => acquireLock(dir), {code: 'MAILBOX_LOCK_LEGACY'});
    assert.equal(breakStaleLocks(root), 0); assert.equal(fs.readFileSync(file, 'utf8'), body);
  }
});
test('multiple processes never overlap mailbox mutation or lose increments', async t => {
  const {dir} = fixture(t); fs.writeFileSync(path.join(dir, 'counter'), '0');
  const started = performance.now(), progress = []; // Resolution timeline; read only by the timeout diagnostic.
  const probe = () => ({...lockSnapshot(dir), pids: [...workers, sweeper].map(w => w.child.pid), progress});
  const workers = Array.from({length: 5}, () => worker(t, dir, 'contend', 40, probe));
  const sweeper = worker(t, dir, 'sweep', 350, probe);
  const mark = (i, p) => p.then(r => { progress.push({i, ms: Math.round(performance.now() - started), stats: r.stats}); return r; });
  const swept = mark(5, sweeper.next()); sweeper.child.send('start');
  const done = workers.map((w, i) => mark(i, w.next()));
  for (const w of workers) w.child.send('start');
  const results = await Promise.all([...done, swept]);
  assert.ok(results.slice(0, -1).every(r => r.done === 40));
  assert.equal(fs.readFileSync(path.join(dir, 'counter'), 'utf8'), '200');
  assert.equal(results.at(-1).removed, 0);
  // #1215 G3 diagnostic contract (additive; the behavioural assertions above are unchanged): every contend worker
  // reports its fixed-key lock totals — exactly one successful acquisition per iteration, pauses at 10 ms requested.
  for (const r of results.slice(0, -1)) {
    assert.equal(r.stats.lock.acquired, 40, `diag ${JSON.stringify(r.stats)}`);
    assert.equal(r.stats.lock.pause_requested_ms, r.stats.lock.pauses * 10, `diag ${JSON.stringify(r.stats)}`);
    assert.ok(Number.isSafeInteger(r.stats.cpu_user_ms) && Number.isSafeInteger(r.stats.cpu_system_ms), `diag ${JSON.stringify(r.stats)}`);
  }
});
test('#1215 guard control: only valid, strictly advancing milestone records count as progress', () => {
  const g = progressGuard(40), rec = value => `${PROGRESS_PREFIX}${JSON.stringify(value)}\n`;
  assert.equal(g.milestones, 4);
  assert.equal(g.feed(`${PROGRESS_PREFIX}{"kind":"progress","iter`), 0, 'a split record waits for its line end');
  assert.equal(g.feed('ation":9,"acquire_ms":3}\r\n'), 1, 'the completed split (CRLF) record counts once');
  assert.equal(g.feed(rec({kind: 'progress', iteration: 9})), 0, 'a duplicate never re-arms');
  assert.equal(g.feed(`${PROGRESS_PREFIX}{not json\n`), 0, 'malformed');
  assert.equal(g.feed(rec({kind: 'progress', iteration: 12})), 0, 'a slow-acquire record is not a milestone');
  assert.equal(g.feed(rec({kind: 'error', iteration: 19})), 0, 'an error record is not progress');
  assert.equal(g.feed(rec({kind: 'progress', iteration: 49})), 0, 'out of range for 40 iterations');
  assert.equal(g.feed(rec({kind: 'progress', iteration: '19'})), 0, 'non-integer iteration');
  assert.equal(g.feed(`other text\n${rec({kind: 'progress', iteration: 19})}${rec({kind: 'progress', iteration: 29})}`), 2, 'multiple records in one chunk');
  assert.equal(g.feed(rec({kind: 'progress', iteration: 19})), 0, 'going backwards never re-arms');
  assert.equal(g.feed(rec({kind: 'progress', iteration: 39})), 1);
  assert.equal(g.last, 39);
  assert.equal(g.feed(rec({kind: 'progress', iteration: 39})), 0, 'no record re-arms after the last milestone');
  assert.equal(progressGuard(1).milestones, 0, 'non-contend workers get exactly one stall window');
});
test('#1215 guard negative control: a real worker that stops making progress is rejected within its own stall window', async t => {
  const {root, dir} = fixture(t), stallMs = 500;
  const w = worker(t, dir, 'choose', 1, () => ({}), {stallMs});
  const choosing = w.next(); w.child.send('start');
  assert.equal((await choosing).choosing, true); // The child now blocks for 30 s inside its publication rename: no progress.
  const began = performance.now();
  await assert.rejects(w.next(), /worker timeout: no progress for 500 ms/);
  const waited = performance.now() - began;
  assert.ok(waited >= stallMs - 50 && waited < 5000, `rejected after ${Math.round(waited)} ms, not after the child's own 30 s stall`);
  assert.equal(w.child.exitCode, null, 'the guard rejects; it does not itself kill the child');
  const exited = once(w.child, 'exit'); w.child.kill('SIGKILL'); await exited; // This test's own child only.
  assert.equal(breakStaleLocks(root), 1, 'exactly its own choosing ticket is reaped');
  acquireLock(dir)();
  assert.deepEqual(fs.readdirSync(path.join(dir, '.lock')), []);
});
test('crashed owner is reaped without deleting a successor and old clients refuse v2 directory', async t => {
  const {root, dir} = fixture(t), w = worker(t, dir, 'hold'), held = w.next(); w.child.send('start');
  assert.equal((await held).held, true); assert.equal(breakStaleLocks(root), 0);
  const exited = once(w.child, 'exit'); w.child.kill('SIGKILL'); await exited;
  assert.equal(breakStaleLocks(root), 1);
  const release = acquireLock(dir);
  try {
    assert.equal(breakStaleLocks(root), 0);
    assert.ok(fs.lstatSync(path.join(dir, '.lock')).isDirectory());
    assert.throws(() => fs.openSync(path.join(dir, '.lock'), 'wx'));
  } finally { release(); }
});
test('crash before ticket publication is recoverable and live choosing is never bypassed', async t => {
  const {root, dir} = fixture(t), w = worker(t, dir, 'choose'), choosing = w.next(); w.child.send('start');
  assert.equal((await choosing).choosing, true);
  assert.throws(() => acquireLock(dir), /lock timeout/i);
  assert.equal(breakStaleLocks(root), 0);
  const exited = once(w.child, 'exit'); w.child.kill('SIGKILL'); await exited;
  assert.equal(breakStaleLocks(root), 1); acquireLock(dir)();
});
test('dead-letter purge participates in the same lock before truncating data', t => {
  const {root, dir} = fixture(t), { FileMailbox } = require('../src/mailbox');
  const mailbox = new FileMailbox({root}), file = path.join(dir, 'dead-letter.jsonl');
  fs.writeFileSync(file, '{"msg_id":"keep"}\n'); const release = acquireLock(dir);
  try {
    assert.throws(() => mailbox.purgeDeadLetter('s'), /lock timeout/i);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"msg_id":"keep"}\n');
  } finally { release(); }
  mailbox.purgeDeadLetter('s'); assert.equal(fs.readFileSync(file, 'utf8'), '');
});
test('a ticket released while its descriptor is read is a departure, not corrupt storage', t => {
  const {dir} = fixture(t), release = acquireLock(dir), original = fs.readSync;
  let departed = false;
  t.mock.method(fs, 'readSync', function(...args) {
    const count = original.apply(fs, args);
    if (!departed) { departed = true; release(); }
    return count;
  });
  const successor = acquireLock(dir);
  try { release(); assert.throws(() => acquireLock(dir), /lock timeout/i); }
  finally { successor(); }
  assert.equal(departed, true);
});
// #1215 lock525 — measured on win32 Node 26 (native524 M4, 5/20): the peer's `number` descriptor reported 0 links at OPEN
// (4x) or at READ (1x) while lstat still saw the delete-pending file; every other predicate held. Four re-lists showed the
// DEPARTED marker, one was a directory EPERM. Simulated here ONLY: that descriptor link count (fstat), the retiring owner's
// marker and a ticket-directory EPERM, around the REAL acquireLock/release. RED on 524: (a)/(b) throw MAILBOX_LOCK_STORAGE.
const lockCounters = () => require('../src/mailbox/lock').lockDiagnostics();
function deletePending(t, dir, { at = 'open', marker = true, eperm = 0, size = null, markOnEperm = false } = {}) {
  const ticket = path.join(dir, '.lock', fs.readdirSync(path.join(dir, '.lock'))[0]), number = path.join(ticket, 'number');
  const s = { fd: null, fstats: 0, armed: false, epermLeft: eperm };
  const open = fs.openSync, fstat = fs.fstatSync, readdir = fs.readdirSync;
  t.mock.method(fs, 'openSync', function(file, ...args) { const fd = open.call(fs, file, ...args); if (file === number && s.fd === null) s.fd = fd; return fd; });
  t.mock.method(fs, 'fstatSync', function(fd, ...args) {
    const st = fstat.call(fs, fd, ...args);
    if (fd !== s.fd || s.armed || ++s.fstats < (at === 'open' ? 1 : 2)) return st;
    s.armed = true;
    if (marker) fs.writeFileSync(path.join(ticket, 'departed'), '');   // the owner's marker precedes its unlink
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { nlink: 0 }, size === null ? {} : { size });
  });
  t.mock.method(fs, 'readdirSync', function(file, ...args) {
    if (s.armed && file === ticket && s.epermLeft !== 0) {
      if (s.epermLeft > 0) s.epermLeft--;
      if (markOnEperm) fs.writeFileSync(path.join(ticket, 'departed'), '');   // the owner then proceeds to depart
      throw Object.assign(new Error(`EPERM: operation not permitted, scandir '${file}'`), { code: 'EPERM' });
    }
    return readdir.call(fs, file, ...args);
  });
  return { number, disarm() { s.epermLeft = 0; }, armed: () => s.armed };
}
const delta = (before, key) => lockCounters()[key] - before[key];
const lockDir = dir => fs.readdirSync(path.join(dir, '.lock'));
// One registered case each (exact CI names `lock525 (a)`..`(f)`); a new counter is read only AFTER a functional success.
for (const [id, opts, key] of [['a', { at: 'open' }, 'nlink0_departed'], ['b', { at: 'read' }, 'nlink0_departed'],
  ['c', { marker: false, eperm: 1, markOnEperm: true }, 'nlink0_unresolved']]) {
  test(`lock525 (${id}) a retiring peer whose descriptor reports 0 links (${JSON.stringify(opts)}) is admitted only after a proved departure`, t => {
    const {dir} = fixture(t), release = acquireLock(dir), sim = deletePending(t, dir, opts), before = lockCounters();
    const successor = acquireLock(dir);
    try { release(); } finally { successor(); }
    assert.deepEqual([sim.armed(), lockDir(dir)], [true, []]);
    assert.equal(delta(before, key), 1);
  });
}
test('lock525 (d) a permanent ticket-directory EPERM is never admitted: TIMEOUT, holder evidence kept', t => {
  const {dir} = fixture(t), release = acquireLock(dir), sim = deletePending(t, dir, { marker: false, eperm: -1 });
  try { assert.throws(() => acquireLock(dir, { timeoutMs: 200 }), { code: 'MAILBOX_LOCK_TIMEOUT' }); assert.equal(fs.readFileSync(sim.number, 'utf8'), '1'); }
  finally { sim.disarm(); release(); }
  assert.deepEqual(lockDir(dir), []);
});
// (e)/(f): functional negative controls with the SAME outcome on older and current code (refusal, evidence kept, cleanup).
for (const [id, opts] of [['e', { marker: false }], ['f', { marker: true, size: 64 }]]) {
  test(`lock525 (${id}) a 0-link descriptor (${JSON.stringify(opts)}): unmarked or otherwise corrupt stays MAILBOX_LOCK_STORAGE`, t => {
    const {dir} = fixture(t), release = acquireLock(dir), sim = deletePending(t, dir, opts);
    try { assert.throws(() => acquireLock(dir), { code: 'MAILBOX_LOCK_STORAGE' }); assert.equal(fs.readFileSync(sim.number, 'utf8'), '1'); }
    finally { release(); }
    assert.deepEqual([sim.armed(), lockDir(dir)], [true, []]);
  });
}
test('corrupt live tickets and unknown entries are refused without deleting evidence', t => {
  const {root, dir} = fixture(t), release = acquireLock(dir), lock = path.join(dir, '.lock');
  const name = fs.readdirSync(lock)[0], number = path.join(lock, name, 'number');
  fs.writeFileSync(number, 'garbage');
  assert.throws(() => acquireLock(dir), {code: 'MAILBOX_LOCK_STORAGE'});
  assert.throws(() => breakStaleLocks(root), {code: 'MAILBOX_LOCK_STORAGE'});
  assert.equal(fs.readFileSync(number, 'utf8'), 'garbage');
  fs.writeFileSync(number, '1'); release();
  fs.writeFileSync(path.join(lock, 'unknown'), 'keep');
  assert.throws(() => acquireLock(dir), {code: 'MAILBOX_LOCK_STORAGE'});
  assert.equal(fs.readFileSync(path.join(lock, 'unknown'), 'utf8'), 'keep');
});
test('lock symlinks never modify the external target', {skip: process.platform === 'win32'}, t => {
  const {root, dir} = fixture(t), target = path.join(root, 'target'); fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(dir, '.lock'));
  assert.throws(() => acquireLock(dir), {code: 'MAILBOX_UNSAFE_PATH'});
  assert.throws(() => breakStaleLocks(root), {code: 'MAILBOX_UNSAFE_PATH'});
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});
test('an unlinked inode observed by lstat during normal release is a departed ticket', t => {
  const {dir} = fixture(t), release = acquireLock(dir), original = fs.lstatSync;
  const number = path.join(dir, '.lock', fs.readdirSync(path.join(dir, '.lock'))[0], 'number');
  let observed = false;
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (!observed && file === number) {
      observed = true; const fd = fs.openSync(file, 'r');
      try { release(); return fs.fstatSync(fd); } finally { fs.closeSync(fd); }
    }
    return original.call(fs, file, ...args);
  });
  const successor = acquireLock(dir);
  try { assert.equal(observed, true); release(); assert.throws(() => acquireLock(dir), /lock timeout/i); }
  finally { successor(); }
});
// #1215 correction5 — measured on win32 (5d9 run 41211065629): a reader's FIRST lstat of a peer's `number` returned a
// regular file with nlink 0 and the immediate RE-STAT raised EPERM (original lock.js:82:44, outside the first-stat handler).
// The stat objects below are real lstat/fstat results with only nlink forced to 0, so the case is platform-independent.
const nlinkZero = st => Object.assign(Object.create(Object.getPrototypeOf(st)), st, {nlink: 0});
const epermLstat = file => Object.assign(new Error(`EPERM: operation not permitted, lstat '${file}'`), {code: 'EPERM', syscall: 'lstat', path: file});
const restatCounters = () => Object.fromEntries(Object.entries(require('../src/mailbox/lock').lockDiagnostics()).filter(([key]) => key.startsWith('eperm_restat_')));
test('#1215: EPERM on the nlink0 re-stat of a released peer ticket is a departure; the successor acquires and stays exclusive', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir), original = fs.lstatSync;
  const number = path.join(lock, fs.readdirSync(lock)[0], 'number');
  let stage = 'armed', releasing = false;
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (file === number && !releasing && stage === 'armed') { // first stat: the owner releases, the stat shows nlink 0
      stage = 'first'; releasing = true;
      const fd = fs.openSync(file, 'r');
      try { release(); return nlinkZero(fs.fstatSync(fd)); } finally { fs.closeSync(fd); releasing = false; }
    }
    if (file === number && !releasing && stage === 'first') { stage = 'restat'; throw epermLstat(file); } // the re-stat
    return original.call(fs, file, ...args);
  });
  const before = restatCounters();
  const successor = acquireLock(dir);
  try {
    assert.equal(stage, 'restat', 'the first stat and the EPERM re-stat both happened');
    const after = restatCounters(), progressed = ['relist_departed', 'relist_dir_gone', 'marked_entry']
      .reduce((sum, key) => sum + after[`eperm_restat_${key}`] - before[`eperm_restat_${key}`], 0);
    assert.equal(progressed, 1, `exactly one re-stat EPERM resolved as a departure: ${JSON.stringify({before, after})}`);
    assert.equal(after.eperm_restat_unmarked_throw_entry_listed, before.eperm_restat_unmarked_throw_entry_listed);
    release(); // the old release is a no-op
    assert.throws(() => acquireLock(dir), /lock timeout/i); // Safety: the successor stays exclusive.
  } finally { successor(); }
  acquireLock(dir)(); // A departed leftover (delete-pending platforms) is finished by its owner on a later scan.
  assert.deepEqual(fs.readdirSync(lock), []);
});
test('#1215: EPERM on the nlink0 re-stat of a still-listed unmarked live ticket stays refused and the ticket is retained', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir), original = fs.lstatSync;
  const name = fs.readdirSync(lock)[0], number = path.join(lock, name, 'number'), body = fs.readFileSync(number, 'utf8');
  let firsts = 0, restats = 0, pending = false;
  const mock = t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (file === number && !pending) { firsts++; pending = true; return nlinkZero(original.call(fs, file, ...args)); }
    if (file === number && pending) { restats++; pending = false; throw epermLstat(file); }
    return original.call(fs, file, ...args);
  });
  try {
    let refused;
    assert.throws(() => acquireLock(dir), error => { refused = error; return error.code === 'EPERM'; });
    assert.ok(firsts >= 1 && restats >= 1, 'the nlink0 first stat and the EPERM re-stat both happened');
    assert.equal(refused.syscall, 'lstat', 'the refusal is the original re-stat EPERM, not a substituted error');
    assert.deepEqual(fs.readdirSync(lock), [name]); // The live holder's ticket is neither evicted nor marked departed.
    assert.deepEqual(fs.readdirSync(path.join(lock, name)), ['number']);
    assert.equal(fs.readFileSync(number, 'utf8'), body);
  } finally { mock.mock.restore(); release(); }
  assert.deepEqual(fs.readdirSync(lock), []);
});
test('#879: a release overlapped by a real open reader handle departs without blocking or breaking exclusion', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir);
  const number = path.join(lock, fs.readdirSync(lock)[0], 'number');
  const reader = fs.openSync(number, 'r'); // On win32 this real handle leaves the unlinked number delete-pending.
  let successor;
  try {
    release(); // Must neither throw (ENOTEMPTY) nor leave a ticket that reads as choosing.
    successor = acquireLock(dir); // Liveness: no EPERM and no wait on the departed ticket.
    assert.throws(() => acquireLock(dir), /lock timeout/i); // Safety: the successor stays exclusive.
  } finally { fs.closeSync(reader); }
  successor(); release();
  acquireLock(dir)(); // The owner finishes its leftover departed ticket on a later scan.
  assert.deepEqual(fs.readdirSync(lock), []);
});
test('#879: EPERM on a delete-pending number of a departing peer is a departure', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir);
  const number = path.join(lock, fs.readdirSync(lock)[0], 'number'), original = fs.openSync;
  let departing = false;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (!departing && file === number) {
      departing = true; release(); // win32 open of a delete-pending name reports EPERM, not ENOENT.
      throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), {code: 'EPERM', syscall: 'open', path: file});
    }
    return original.call(fs, file, ...args);
  });
  const successor = acquireLock(dir);
  try { assert.equal(departing, true); assert.throws(() => acquireLock(dir), /lock timeout/i); }
  finally { successor(); }
  assert.deepEqual(fs.readdirSync(lock), []);
});
test('#879: EPERM on a live ticket without a departure marker still fails closed', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir);
  const name = fs.readdirSync(lock)[0], number = path.join(lock, name, 'number'), original = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === number) throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), {code: 'EPERM', syscall: 'open', path: file});
    return original.call(fs, file, ...args);
  });
  try {
    assert.throws(() => acquireLock(dir), {code: 'EPERM'});
    assert.deepEqual(fs.readdirSync(lock), [name]); // The live holder's ticket is neither evicted nor marked departed.
    assert.deepEqual(fs.readdirSync(path.join(lock, name)), ['number']);
  } finally { mock.mock.restore(); release(); }
  assert.deepEqual(fs.readdirSync(lock), []);
});
// #1215 lock10 — measured on win32 (8a0219b diagnostic job, mailbox-lock-concurrency contend worker): a reader validated a
// peer's published `number`, then its `before` lstat (lock.js readTicket) raised EPERM and the re-list showed no departure
// marker, so the reader threw (eperm_read_throw) and the worker exited 1. Source-reachable state: removeTicket creates the
// marker, unlinks `number`, unlinks the marker once it is the last entry, THEN removes the directory — so a departing
// ticket is an EMPTY directory between its marker unlink and its rmdir. Below, the real owner release runs inside the
// reader's EPERM window with its rmdir deferred until just after the reader's re-list. Platform-independent: only the
// EPERM itself and the rmdir timing are injected; every file operation of the release is real.
const lockCounter = key => require('../src/mailbox/lock').lockDiagnostics()[key];
test('#1215: EPERM on a published peer number whose departure has removed its marker (empty ticket before rmdir) is a departure; the successor acquires and stays exclusive', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir);
  const name = fs.readdirSync(lock)[0], ticket = path.join(lock, name), number = path.join(ticket, 'number');
  const lstat = fs.lstatSync, readdir = fs.readdirSync, rmdir = fs.rmdirSync;
  let stage = 'armed';
  t.mock.method(fs, 'rmdirSync', function(p, ...args) {
    if (p === ticket && stage === 'releasing') { stage = 'rmdir_deferred'; return undefined; } // the owner's rmdir, later
    return rmdir.call(fs, p, ...args);
  });
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (file === number && stage === 'armed') { stage = 'validated'; return lstat.call(fs, file, ...args); } // checkTicketFiles
    if (file === number && stage === 'validated') { // readTicket's `before`: the owner departs during this lstat
      stage = 'releasing'; release();
      assert.equal(stage, 'rmdir_deferred', 'the real release reached its rmdir');
      assert.deepEqual(readdir.call(fs, ticket), [], 'number and marker are both gone; only the rmdir is outstanding');
      stage = 'emptied'; throw epermLstat(file);
    }
    return lstat.call(fs, file, ...args);
  });
  t.mock.method(fs, 'readdirSync', function(p, ...args) {
    const listed = readdir.call(fs, p, ...args);
    if (p === ticket && stage === 'emptied') { stage = 'relisted'; rmdir.call(fs, ticket); } // the owner's rmdir lands after the re-list
    return listed;
  });
  const gone0 = lockCounter('eperm_read_number_gone'), throws0 = lockCounter('eperm_read_throw');
  const successor = acquireLock(dir); // ORIGINAL (8a0219b): throws this EPERM. CANDIDATE: the departure is recognised.
  try {
    assert.equal(stage, 'relisted', 'the EPERM read and the re-list of the emptied ticket both happened');
    assert.equal(lockCounter('eperm_read_number_gone') - gone0, 1);
    assert.equal(lockCounter('eperm_read_throw') - throws0, 0);
    assert.equal(fs.readdirSync(lock).length, 1, 'only the successor ticket remains');
    release(); // the old release is a no-op
    assert.throws(() => acquireLock(dir), /lock timeout/i); // Safety: the successor stays exclusive.
  } finally { successor(); }
  assert.deepEqual(fs.readdirSync(lock), []);
});
test('#1215 control: EPERM on a published live peer number that the re-list still shows, with no marker, still fails closed and the ticket is retained', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir);
  const name = fs.readdirSync(lock)[0], number = path.join(lock, name, 'number'), body = fs.readFileSync(number, 'utf8');
  const lstat = fs.lstatSync;
  let reads = 0;
  const mock = t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (file === number && ++reads % 2 === 0) throw epermLstat(file); // every readTicket's `before` lstat, never its validation stat
    return lstat.call(fs, file, ...args);
  });
  try {
    let refused;
    assert.throws(() => acquireLock(dir), error => { refused = error; return error.code === 'EPERM'; });
    assert.equal(refused.syscall, 'lstat', 'the refusal is the original read-site EPERM, not a substituted error');
    assert.deepEqual(fs.readdirSync(lock), [name]); // The live holder's ticket is neither evicted nor marked departed.
    assert.deepEqual(fs.readdirSync(path.join(lock, name)), ['number']);
    assert.equal(fs.readFileSync(number, 'utf8'), body);
  } finally { mock.mock.restore(); release(); }
  assert.deepEqual(fs.readdirSync(lock), []);
});
// #1215 mailbox592 — measured on win32 (diagnostic run 42737861005, contend worker iteration 35): the FIRST lstat of a
// peer's published `number` (checkTicketFiles <- readTicket) raised EPERM, the re-list showed the ticket directory with
// neither `number` nor the marker, and onEperm rethrew (eperm_unmarked_throw_entry_absent). Same lock10 departure state
// (empty ticket before rmdir), reached one site earlier. Only the EPERM and the rmdir timing are injected.
test('#1215: first-stat EPERM on a published peer number whose departure has removed its marker (empty ticket before rmdir) is a departure; the successor acquires and stays exclusive', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock'), release = acquireLock(dir);
  const name = fs.readdirSync(lock)[0], ticket = path.join(lock, name), number = path.join(ticket, 'number');
  const lstat = fs.lstatSync, readdir = fs.readdirSync, rmdir = fs.rmdirSync;
  let stage = 'armed';
  t.mock.method(fs, 'rmdirSync', function(p, ...args) {
    if (p === ticket && stage === 'releasing') { stage = 'rmdir_deferred'; return undefined; } // the owner's rmdir, later
    return rmdir.call(fs, p, ...args);
  });
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (file === number && stage === 'armed') { // checkTicketFiles' FIRST stat: the owner departs during this lstat
      stage = 'releasing'; release();
      assert.equal(stage, 'rmdir_deferred', 'the real release reached its rmdir');
      assert.deepEqual(readdir.call(fs, ticket), [], 'number and marker are both gone; only the rmdir is outstanding');
      stage = 'emptied'; throw epermLstat(file);
    }
    return lstat.call(fs, file, ...args);
  });
  t.mock.method(fs, 'readdirSync', function(p, ...args) {
    const listed = readdir.call(fs, p, ...args);
    if (p === ticket && stage === 'emptied') { stage = 'relisted'; rmdir.call(fs, ticket); } // the owner's rmdir lands after the re-list
    return listed;
  });
  const keys = ['eperm_relist_number_gone', 'eperm_unmarked_throw_entry_absent', 'eperm_unmarked_throw_entry_listed', 'eperm_read_throw'];
  const before = keys.map(lockCounter);
  const successor = acquireLock(dir); // ORIGINAL (581): throws this first-stat EPERM. CANDIDATE: the departure is recognised.
  try {
    assert.equal(stage, 'relisted', 'the first-stat EPERM and the re-list of the emptied ticket both happened');
    assert.deepEqual(keys.map((key, i) => lockCounter(key) - before[i]), [1, 0, 0, 0]);
    assert.equal(fs.readdirSync(lock).length, 1, 'only the successor ticket remains');
    release(); // the old release is a no-op
    assert.throws(() => acquireLock(dir), /lock timeout/i); // Safety: the successor stays exclusive.
  } finally { successor(); }
  assert.deepEqual(fs.readdirSync(lock), []);
});
// #1215 mailbox592 review C2 — the fresh-lstat arms of the empty-ticket departure rule. The real holder releases inside the
// reader's FIRST lstat of its published `number` with the owner's rmdir deferred; that lstat throws EPERM; the reader re-lists
// the emptied ticket ([]) and then takes its fresh lstat of the ticket directory, which each case below drives.
// armOnPublish: arm only once the successor has published its own `number`, so the EPERM lands in its ADMISSION scan (an empty
// ticket re-read later would read as choosing; admission returns without re-reading it).
const c2Keys = ['eperm_relist_number_gone', 'eperm_unmarked_throw_entry_absent', 'dir_unresolved'];
function emptiedTicketWindow(t, dir, { armOnPublish = false, onRelist = () => {}, onFreshStat = read => read() } = {}) {
  const lock = path.join(dir, '.lock'), release = acquireLock(dir);
  const name = fs.readdirSync(lock)[0], ticket = path.join(lock, name), number = path.join(ticket, 'number');
  const lstat = fs.lstatSync, readdir = fs.readdirSync, rmdir = fs.rmdirSync, rename = fs.renameSync;
  const s = { lock, name, ticket, release, stage: armOnPublish ? 'idle' : 'armed', original: lstat.call(fs, ticket),
    injected: null, fresh: null, finishRmdir: () => rmdir.call(fs, ticket) };
  if (armOnPublish) t.mock.method(fs, 'renameSync', function(from, to, ...args) {
    const out = rename.call(fs, from, to, ...args);
    if (s.stage === 'idle' && path.basename(to) === 'number' && path.dirname(to) !== ticket) s.stage = 'armed'; // successor published
    return out;
  });
  t.mock.method(fs, 'rmdirSync', function(p, ...args) {
    if (p === ticket && s.stage === 'releasing') { s.stage = 'rmdir_deferred'; return undefined; } // the owner's rmdir, later
    return rmdir.call(fs, p, ...args);
  });
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (file === number && s.stage === 'armed') { // checkTicketFiles' FIRST stat: the owner departs during this lstat
      s.stage = 'releasing'; release();
      assert.equal(s.stage, 'rmdir_deferred', 'the real release reached its rmdir');
      assert.deepEqual(readdir.call(fs, ticket), [], 'number and marker are both gone; only the rmdir is outstanding');
      s.stage = 'emptied'; throw (s.injected = epermLstat(file));
    }
    if (file === ticket && s.stage === 'relisted') { s.stage = 'fresh_stat'; return (s.fresh = onFreshStat(() => lstat.call(fs, file, ...args))); }
    return lstat.call(fs, file, ...args);
  });
  t.mock.method(fs, 'readdirSync', function(p, ...args) {
    const listed = readdir.call(fs, p, ...args);
    if (p === ticket && s.stage === 'emptied') { assert.deepEqual(listed, [], 'the re-list is the emptied ticket'); s.stage = 'relisted'; onRelist(s); }
    return listed;
  });
  return s;
}
test('#1215 mailbox592 C2: admission-scan first-stat EPERM on an emptied ticket whose rmdir is deferred past the acquisition; the fresh lstat sees the SAME real directory, the departure is recognised and the successor acquires and stays exclusive', t => {
  const {dir} = fixture(t), s = emptiedTicketWindow(t, dir, { armOnPublish: true });
  const before = c2Keys.map(lockCounter);
  const successor = acquireLock(dir);
  try {
    assert.equal(s.stage, 'fresh_stat', 'after publishing, the successor re-listed the emptied ticket and took its fresh lstat');
    assert.ok(s.fresh && s.fresh.isDirectory() && !s.fresh.isSymbolicLink(), 'the fresh lstat saw a real directory, not an absent one');
    assert.deepEqual([s.fresh.dev, s.fresh.ino], [s.original.dev, s.original.ino], 'the fresh lstat saw the SAME directory');
    assert.deepEqual(c2Keys.map((key, i) => lockCounter(key) - before[i]), [1, 0, 0]);
    assert.deepEqual(fs.readdirSync(s.ticket), [], 'the peer directory still exists when the successor returns (rmdir deferred)');
    s.finishRmdir(); // the owner's deferred rmdir lands only now
    assert.equal(fs.readdirSync(s.lock).length, 1, 'only the successor ticket remains');
    s.release(); // the old release is a no-op
    assert.throws(() => acquireLock(dir), /lock timeout/i); // Safety: the successor stays exclusive.
  } finally { successor(); }
  assert.deepEqual(fs.readdirSync(s.lock), []);
});
test('#1215 mailbox592 C2 control: an emptied ticket path replaced after the re-list by a DIFFERENT real empty directory keeps the original first-stat EPERM; the replacement is neither admitted past nor deleted', t => {
  const {root, dir} = fixture(t), replacement = path.join(root, 'replacement');
  fs.mkdirSync(replacement, {mode: 0o700}); // created OUTSIDE .lock while the original ticket exists: no inode reuse
  const s = emptiedTicketWindow(t, dir, { onRelist: w => { fs.rmdirSync(w.ticket); fs.renameSync(replacement, w.ticket); } });
  const rep = fs.lstatSync(replacement);
  assert.notDeepEqual([rep.dev, rep.ino], [s.original.dev, s.original.ino], 'PRECONDITION: the host gives the replacement a distinct real identity');
  const before = c2Keys.map(lockCounter);
  let refused;
  assert.throws(() => acquireLock(dir), error => { refused = error; return true; });
  assert.equal(s.stage, 'fresh_stat', 'the re-list, the replacement and the fresh lstat all happened');
  assert.deepEqual([s.fresh.dev, s.fresh.ino], [rep.dev, rep.ino], 'the fresh lstat saw the replacement');
  assert.equal(refused, s.injected, 'the refusal is the ORIGINAL first-stat EPERM on number');
  assert.deepEqual(c2Keys.map((key, i) => lockCounter(key) - before[i]), [0, 1, 0]);
  assert.deepEqual(fs.readdirSync(s.lock), [s.name], 'no admission: only the replacement remains under the peer name');
  const kept = fs.lstatSync(s.ticket);
  assert.deepEqual([kept.isDirectory(), kept.dev, kept.ino, fs.readdirSync(s.ticket)], [true, rep.dev, rep.ino, []], 'the replacement is kept unchanged');
  fs.rmdirSync(s.ticket); // test cleanup of the injected replacement
  assert.deepEqual(fs.readdirSync(s.lock), []);
});
test('#1215 mailbox592 C2 control: an EPERM on the fresh lstat of the emptied ticket directory is unresolved; the original first-stat EPERM is rethrown and nothing is admitted or removed', t => {
  const {dir} = fixture(t);
  let dirEperm = null;
  const s = emptiedTicketWindow(t, dir, { onFreshStat: () => { throw (dirEperm = epermLstat(s.ticket)); } });
  const before = c2Keys.map(lockCounter);
  let refused;
  assert.throws(() => acquireLock(dir), error => { refused = error; return true; });
  assert.equal(s.stage, 'fresh_stat', 'the re-list and the fresh lstat of the ticket directory both happened');
  assert.ok(dirEperm, 'the fresh lstat raised its own, distinct EPERM');
  assert.equal(refused, s.injected, 'the refusal is the ORIGINAL first-stat EPERM on number');
  assert.notEqual(refused, dirEperm);
  assert.deepEqual(c2Keys.map((key, i) => lockCounter(key) - before[i]), [0, 1, 1]);
  assert.deepEqual(fs.readdirSync(s.lock), [s.name], 'no admission and no removal of the peer ticket');
  const kept = fs.lstatSync(s.ticket);
  assert.deepEqual([kept.dev, kept.ino, fs.readdirSync(s.ticket)], [s.original.dev, s.original.ino, []], 'custody unchanged');
  s.finishRmdir(); // the owner's deferred rmdir
  assert.deepEqual(fs.readdirSync(s.lock), []);
});

// Task 1215 repro141 (RED by design against 55568519; a reproduction, not a product fix). FIRST .lock creation race in
// the actual acquireLock -> lockDirectory -> resolveSessionDir path. resolveSessionDir observes .lock with one lstat
// for its directory exemption (path-boundary.js:59). When .lock is missing it then takes a SECOND lstat inside
// checkLeaf (:44). A concurrent first contender that creates .lock in between (its mkdir at lock.js:77) makes that
// second stat a directory, so the call fails `!isFile()` with MAILBOX_UNSAFE_PATH: the Windows per-file diagnostic
// failure at iteration 0.
// Barrier:
// - At the genuine "missing" result of the first fs.lstatSync/fs.statSync of exactly <dir>/.lock, the barrier creates
//   the entry another contender would. Then it returns that same genuine missing result.
// - It fires once and only on that path. fs functions are restored in finally.
// - It asserts the public outcome and the real on-disk lock effects, never a stat count.
// The symlink/junction and hardlink controls inject UNSAFE entries at the same boundary and must stay refused: the
// accepted path types are not widened. The exact Windows failing predicate was not recorded by CI.
function firstLockCreationBarrier(lockPath, inject) {
  const original = { lstatSync: fs.lstatSync, statSync: fs.statSync };
  const state = { ran: false, error: null };
  const fire = () => { state.ran = true; try { inject(); } catch (e) { state.error = (e && e.code) || 'inject_error'; } };
  const atMissing = (real) => function (p, ...rest) {
    const target = !state.ran && typeof p === 'string' && path.resolve(p) === lockPath;
    let result;
    try { result = real.call(fs, p, ...rest); }
    catch (e) { if (target && e && e.code === 'ENOENT') fire(); throw e; }
    if (target && result === undefined) fire(); // throwIfNoEntry:false spelling of the same "missing" observation
    return result;
  };
  fs.lstatSync = atMissing(original.lstatSync); fs.statSync = atMissing(original.statSync);
  return { state, original, restore() { Object.assign(fs, original); } };
}
function ownTickets(lock) {
  let names; try { names = fs.readdirSync(lock); } catch (e) { return e.code; }
  return names.filter((name) => new RegExp(`^${process.pid}-[a-f0-9]{32}$`).test(name) && fs.existsSync(path.join(lock, name, 'number')));
}
function acquireThroughBarrier(dir, barrier) {
  let outcome, release = null;
  try { release = acquireLock(dir); outcome = { ok: true }; }
  catch (e) { outcome = { ok: false, code: (e && e.code) || 'error' }; }
  finally { barrier.restore(); }
  assert.ok(fs.lstatSync === barrier.original.lstatSync && fs.statSync === barrier.original.statSync, 'CONTROL: patched fs functions restored');
  assert.equal(barrier.state.error, null, 'TEST HOOK FAILURE (not a product result): the concurrent contender entry could not be created');
  assert.equal(barrier.state.ran, true, 'NON-VACUITY: the lock path observed .lock missing and the contender created it at that boundary');
  return { outcome, release };
}
test('[1215-red141] control: first lock creation without a concurrent contender is admitted (hook-free baseline)', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock');
  assert.equal(fs.existsSync(lock), false, 'PRECONDITION: first creation (no .lock yet)');
  const release = acquireLock(dir);
  try { assert.equal(ownTickets(lock).length, 1, 'the acquisition holds exactly one real ticket'); }
  finally { release(); }
  assert.equal(ownTickets(lock).length, 0, 'release removes the ticket');
});
test('[1215-red141] a safe .lock directory created by a concurrent first contender after the missing observation is admitted', t => {
  const {dir} = fixture(t), lock = path.join(dir, '.lock');
  assert.equal(fs.existsSync(lock), false, 'PRECONDITION: first creation (no .lock yet)');
  const barrier = firstLockCreationBarrier(lock, () => fs.mkdirSync(lock, { mode: 0o700 })); // exactly the contender's own mkdir (lock.js:77)
  const { outcome, release } = acquireThroughBarrier(dir, barrier);
  try {
    const st = fs.lstatSync(lock);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'CONTROL: the contender .lock is a real, safe directory');
    assert.deepEqual(outcome, { ok: true }, `a legitimate concurrent first .lock creation must be admitted, got ${JSON.stringify(outcome)}`);
    assert.equal(ownTickets(lock).length, 1, 'the admitted acquisition holds exactly one real ticket in the shared .lock');
  } finally { if (release) release(); }
  assert.equal(ownTickets(lock).length, 0, 'release removes the ticket');
  const again = acquireLock(dir); again(); // the shared .lock stays usable
});
for (const kind of ['symlink', 'hardlink']) test(`[1215-red141] control: a ${kind} appearing as .lock at the same boundary is still refused`, t => {
  const {root, dir} = fixture(t), lock = path.join(dir, '.lock');
  const elsewhere = path.join(root, 'elsewhere'), leafFile = path.join(root, 'elsewhere-file');
  fs.mkdirSync(elsewhere, { mode: 0o700 }); fs.writeFileSync(leafFile, '');
  assert.equal(fs.existsSync(lock), false, 'PRECONDITION: first creation (no .lock yet)');
  const barrier = firstLockCreationBarrier(lock, () => kind === 'symlink'
    ? fs.symlinkSync(elsewhere, lock, process.platform === 'win32' ? 'junction' : 'dir')
    : fs.linkSync(leafFile, lock));
  const { outcome, release } = acquireThroughBarrier(dir, barrier);
  try {
    assert.deepEqual(outcome, { ok: false, code: 'MAILBOX_UNSAFE_PATH' }, `an unsafe ${kind} .lock must stay refused, got ${JSON.stringify(outcome)}`);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was created through the link');
    assert.equal(fs.readFileSync(leafFile, 'utf8'), '', 'the linked file is untouched');
  } finally { if (release) release(); }
});

// Task 1215 win164 — guard-semantics control (test-only; pins the source fact the Windows per-file failure turned on).
// A sweep worker is given progressGuard(0): it carries NO milestones, so its 10 s timer is a whole-work budget that no
// stderr line re-arms. Neither the existing `sweep` lines nor the diagnostic `sweep_tick` / `sweep_done` lines are progress,
// so the "(last milestone -1)" a sweep timeout reports is the budget's expiry, not a lost or rejected milestone.
test('[win164] a sweep worker carries no milestones: no sweep, sweep_tick or sweep_done record re-arms its guard', () => {
  const g = progressGuard(0), rec = value => `${PROGRESS_PREFIX}${JSON.stringify(value)}\n`;
  assert.equal(g.milestones, 0, 'one budget of (0 + 1) x stallMs, never re-armed');
  for (const record of [{ kind: 'sweep', iteration: 49 }, { kind: 'sweep_tick', iteration: 9 }, { kind: 'sweep_done', iteration: 349 },
    { kind: 'progress', iteration: 9 }]) {
    assert.equal(g.feed(rec(record)), 0, `${record.kind} is not a sweep milestone`);
  }
  assert.equal(g.last, -1);
});
