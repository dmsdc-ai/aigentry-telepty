'use strict';

// gh#82 follow-up (2026-10-09, ask 2) — one restart owner per host.
//
// ~12 wrapped sessions on one host, load average > 14: several clients' probes time out at the
// same moment, each concludes "absent", and each walks restartDaemonGraceful's stop + kickstart —
// the daemon restarted twice in six minutes. A host-wide lease (`~/.telepty/restart.lease`, taken
// with O_EXCL) makes the first client the only one that acts; the others wait for health instead.
//
//   (a) two concurrent restarts, same port, absence verdict ⇒ exactly one cleanup; the other waits
//   (b) a stale lease (old timestamp, or holder dead) is replaced, not obeyed forever
//   (c) a lease I/O failure forfeits the protection, logs `lease-unavailable`, and the restart proceeds
//
// SAFETY: in-process only, every kill/spawn/kickstart is an injected seam, port 51821 is never the
// live daemon's, and setup-env.js gives this process its own HOME so the lease is a temp file.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pkg = require('../package.json');
const { restartDaemonGraceful } = require('../cli');

const PORT = 51821;
const LEASE_PATH = path.join(os.homedir(), '.telepty', 'restart.lease');
const healthy = { version: pkg.version, capabilities: [] };

function recordingLog() {
  const lines = [];
  const fn = (fields) => { lines.push(fields); };
  fn.lines = lines;
  return fn;
}

function recordingCleanup(onCall) {
  const calls = [];
  const fn = (opts) => { calls.push(opts || {}); if (onCall) onCall(); return { stopped: [], failed: [] }; };
  fn.calls = calls;
  return fn;
}

function restartSeams(extra = {}) {
  return {
    maxAttempts: 1,
    port: PORT,
    absenceVerdict: true,
    verdict: 'daemon-unreachable',
    _probeDaemonHealth: async () => false,
    _detectSupervisor: () => ({ present: false }),
    _startDetachedDaemon: () => {},
    _waitForDaemonHealth: async () => healthy,
    _findPortOwnerPid: () => null,
    _findParentProcessInfo: () => null,
    ...extra
  };
}

async function quiet(fn) {
  const write = process.stderr.write.bind(process.stderr);
  const error = console.error;
  process.stderr.write = () => true;
  console.error = () => {};
  try { return await fn(); } finally { process.stderr.write = write; console.error = error; }
}

function writeLease(body) {
  fs.mkdirSync(path.dirname(LEASE_PATH), { recursive: true });
  fs.writeFileSync(LEASE_PATH, JSON.stringify(body));
}

function deadPid() {
  // A process this test started and that has already exited — never someone else's pid.
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return r.pid;
}

beforeEach(() => { try { fs.unlinkSync(LEASE_PATH); } catch { /* none */ } });

test('lease (a): two concurrent absence restarts on one port ⇒ ONE cleanup; the other waits for health', async () => {
  const cleanup = recordingCleanup();
  const log = recordingLog();
  const waits = [];
  const waitHealth = async (ms) => { waits.push(ms); return healthy; };

  const results = await quiet(() => Promise.all([
    restartDaemonGraceful(restartSeams({ _cleanupDaemonProcesses: cleanup, _logDaemonRestartEvent: log, _waitForDaemonHealth: waitHealth })),
    restartDaemonGraceful(restartSeams({ _cleanupDaemonProcesses: cleanup, _logDaemonRestartEvent: log, _waitForDaemonHealth: waitHealth }))
  ]));

  assert.equal(cleanup.calls.length, 1, 'two clients that both concluded "absent" each stopped the daemon — the incident');
  assert.ok(results.every((r) => r.success === true), 'the waiter succeeds once the holder brought the daemon back');
  const deferred = log.lines.filter((l) => l.event === 'restart-deferred-to-lease');
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].holder_pid, process.pid);
  assert.equal(deferred[0].port, PORT);
  assert.ok(!fs.existsSync(LEASE_PATH), 'the holder must release the lease when its restart completes');
});

test('lease (a2): a fresh lease held by a live process ⇒ no cleanup, no kickstart; failure WITHOUT a kill if health never returns', async () => {
  writeLease({ pid: process.pid, ppid: process.ppid, port: PORT, verdict: 'daemon-unreachable', startedAt: new Date().toISOString() });
  const before = fs.readFileSync(LEASE_PATH, 'utf8');
  const cleanup = recordingCleanup();
  const log = recordingLog();
  let kicked = 0;
  let started = 0;

  const result = await quiet(() => restartDaemonGraceful(restartSeams({
    _cleanupDaemonProcesses: cleanup,
    _restartSupervisorDaemon: () => { kicked += 1; return { success: true }; },
    _startDetachedDaemon: () => { started += 1; },
    _waitForDaemonHealth: async () => null,
    _logDaemonRestartEvent: log
  })));

  assert.equal(cleanup.calls.length, 0, 'a client that does not hold the lease must never stop the daemon');
  assert.equal(kicked, 0);
  assert.equal(started, 0);
  assert.equal(result.success, false);
  assert.equal(log.lines.filter((l) => l.event === 'restart-deferred-to-lease').length, 1);
  assert.equal(fs.readFileSync(LEASE_PATH, 'utf8'), before, "a waiter must not release someone else's lease");
});

test('lease (b): a lease whose holder is DEAD is replaced and the restart proceeds', async () => {
  writeLease({ pid: deadPid(), ppid: 1, port: PORT, verdict: 'daemon-unreachable', startedAt: new Date().toISOString() });
  const heldByUs = [];
  const cleanup = recordingCleanup(() => {
    heldByUs.push(JSON.parse(fs.readFileSync(LEASE_PATH, 'utf8')).pid === process.pid);
  });
  await quiet(() => restartDaemonGraceful(restartSeams({ _cleanupDaemonProcesses: cleanup, _logDaemonRestartEvent: () => {} })));
  assert.equal(cleanup.calls.length, 1, 'a dead holder must not block restarts forever');
  assert.deepEqual(heldByUs, [true], 'the stale lease must be REPLACED by ours before the stop');
  assert.ok(!fs.existsSync(LEASE_PATH), 'released after the restart');
});

test('lease (b2): a lease older than 60 s is replaced even if its holder pid is alive', async () => {
  writeLease({ pid: process.pid, ppid: process.ppid, port: PORT, verdict: 'daemon-unreachable', startedAt: new Date(Date.now() - 61_000).toISOString() });
  const heldByUs = [];
  const cleanup = recordingCleanup(() => {
    const lease = JSON.parse(fs.readFileSync(LEASE_PATH, 'utf8'));
    heldByUs.push(Date.now() - Date.parse(lease.startedAt) < 60_000);
  });
  await quiet(() => restartDaemonGraceful(restartSeams({ _cleanupDaemonProcesses: cleanup, _logDaemonRestartEvent: () => {} })));
  assert.equal(cleanup.calls.length, 1, 'an expired lease must not block restarts');
  assert.deepEqual(heldByUs, [true], 'the expired lease must be REPLACED by a fresh one before the stop');
});

test('lease: the lease records pid, ppid, port, verdict and startedAt', async () => {
  let lease = null;
  const cleanup = recordingCleanup(() => { lease = JSON.parse(fs.readFileSync(LEASE_PATH, 'utf8')); });
  await quiet(() => restartDaemonGraceful(restartSeams({ _cleanupDaemonProcesses: cleanup, _logDaemonRestartEvent: () => {} })));
  assert.ok(lease, 'the lease must be held while the stop runs');
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.ppid, process.ppid);
  assert.equal(lease.port, PORT);
  assert.equal(lease.verdict, 'daemon-unreachable');
  assert.ok(Date.parse(lease.startedAt) > 0);
});

test('lease (c): a lease I/O failure logs lease-unavailable and the restart still proceeds', async () => {
  // The lease's parent "directory" is a regular file, so neither mkdir nor open can succeed.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-82-')), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const cleanup = recordingCleanup();
  const log = recordingLog();
  const result = await quiet(() => restartDaemonGraceful(restartSeams({
    _restartLeasePath: path.join(blocker, 'restart.lease'),
    _cleanupDaemonProcesses: cleanup,
    _logDaemonRestartEvent: log
  })));
  assert.equal(cleanup.calls.length, 1, 'a lease error must never break a restart');
  assert.equal(result.success, true);
  const unavailable = log.lines.filter((l) => l.event === 'lease-unavailable');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].port, PORT);
});
