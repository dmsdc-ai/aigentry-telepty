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
function worker(t, dir, mode, iterations = 1) {
  const child = fork(path.join(__dirname, '../test-support/mailbox-lock-worker.js'), [dir, mode, String(iterations)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stderr.on('data', b => { output += b; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(Error(`worker timeout: ${output}`)); }, 10000);
    const fail = code => { clean(); reject(Error(`worker exited ${code}: ${output}`)); };
    const message = value => { clean(); resolve(value); };
    function clean() { clearTimeout(timer); child.off('message', message); child.off('exit', fail); }
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
  const workers = Array.from({length: 5}, () => worker(t, dir, 'contend', 40));
  const sweeper = worker(t, dir, 'sweep', 350);
  const swept = sweeper.next(); sweeper.child.send('start');
  const done = workers.map(w => w.next());
  for (const w of workers) w.child.send('start');
  const results = await Promise.all([...done, swept]);
  assert.ok(results.slice(0, -1).every(r => r.done === 40));
  assert.equal(fs.readFileSync(path.join(dir, 'counter'), 'utf8'), '200');
  assert.equal(results.at(-1).removed, 0);
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
