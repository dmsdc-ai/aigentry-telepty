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
