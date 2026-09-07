'use strict';

// gh#82 — a verdict of "nothing answered on this port" must never BEGIN by killing the port owner.
//
// `telepty list` → ensureDaemonRunning probes /api/meta + /api/sessions with a 1500 ms deadline.
// Both slow ⇒ decideDaemonAction returns {action:'start', reason:'daemon-unreachable'} ⇒
// restartDaemonGraceful ⇒ cleanup({port}) ⇒ SIGTERM/SIGKILL of the state-file pid AND the port
// owner. The stop is a no-op only while the verdict is RIGHT. The reporter's machine is the case
// where it was wrong: `/api/health` returned 200 immediately before the command and connection
// refused immediately after.
//
// This file pins the remaining half of #835's rule — "it is alive; killing it is the one thing we
// must not do" — on the START path, which #835 could not reach because with only /api/meta and
// /api/sessions as evidence that path has no way to know the daemon is alive:
//
//   (A) restartDaemonGraceful re-confirms liveness on /api/health before ANY stop, but only when
//       the caller says it arrived on an ABSENCE verdict. The version-mismatch/repair callers stop
//       a daemon they know is alive on purpose and must keep doing so.
//   (B) the absence verdict itself must include /api/health: meta timeout + health 200 ⇒
//       `alive-but-slow`, never `start`.
//   (C) the probe deadline is one overridable constant, and escalates across attempts so `start`
//       requires failure at two patience levels rather than the same one three times.
//   (E) every failed restart attempt leaves a line in ~/.telepty/logs/daemon-restart.log saying
//       what was attempted and why it failed (environment A's log directory was EMPTY).
//
// The PORT split's destructive half is NOT re-asserted here: cleanupDaemonProcesses already
// refuses a state-file pid whose recorded port ≠ the addressed port (`portMatchesAddress`,
// daemon-control.js:392, #902) and test/sweep-scoping-902.test.js R2/R2b/R2c already pins it —
// see that file rather than duplicating the assertion. What remains of the split (the daemon
// binding $PORT while the CLI dials $TELEPTY_PORT) is a connection error, not a kill.
//
// SAFETY: this suite runs on a host with a LIVE telepty daemon on 3848. In-process cases use
// injected seams only — no real socket, no real signal. The one subprocess case points the CLI at
// a stub HTTP server on an ephemeral port AND preloads test-support/block-signals.js, so the kill
// path is reached and MEASURED without a signal ever being delivered; an empty log is the proof.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pkg = require('../package.json');
const {
  decideDaemonAction,
  ensureDaemonRunning,
  restartDaemonGraceful,
  probeTimeoutMs
} = require('../cli');

const CAP = 'wrapped-sessions';
const REPO_ROOT = path.resolve(__dirname, '..');
const BLOCK_SIGNALS = path.join(REPO_ROOT, 'test-support', 'block-signals.js');

const noSupervisor = () => ({ present: false });

// A probe that never answers within its deadline — the environment-A shape.
const timesOut = async () => null;

function recordingRestart() {
  const calls = [];
  const fn = async (opts) => { calls.push(opts || {}); return { success: true }; };
  fn.calls = calls;
  return fn;
}

// The kill itself. Every test that claims "no stop was issued" asserts on THIS array, not on the
// absence of an error — cleanupDaemonProcesses is where all three kill sources converge.
function recordingCleanup() {
  const calls = [];
  const fn = (opts) => { calls.push(opts || {}); return { stopped: [], failed: [] }; };
  fn.calls = calls;
  return fn;
}

function recordingLog() {
  const lines = [];
  const fn = (fields) => { lines.push(fields); };
  fn.lines = lines;
  return fn;
}

// ── (B) the verdict ───────────────────────────────────────────────────────────

test('gh#82 B: meta timeout + health 200 is alive-but-slow, NEVER the verdict that authorizes a kill', () => {
  const d = decideDaemonAction({
    meta: null,
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: false,
    healthOk: true
  });
  assert.notEqual(d.action, 'start', "start → restartDaemonGraceful → SIGKILL of a daemon that just answered /api/health");
  assert.notEqual(d.action, 'restart');
  assert.equal(d.action, 'noop');
  assert.equal(d.reason, 'alive-but-slow');
});

test('gh#82 B: health silent too ⇒ still the one legitimate absence (negative control)', () => {
  const d = decideDaemonAction({ meta: null, cliVersion: pkg.version, sessionsReachable: false, healthOk: false });
  assert.equal(d.action, 'start');
  assert.equal(d.reason, 'daemon-unreachable');
});

test('gh#82 B: health is not consulted once /api/sessions answered — legacy restart is unchanged', () => {
  const d = decideDaemonAction({ meta: null, cliVersion: pkg.version, sessionsReachable: true, healthOk: true });
  assert.equal(d.action, 'restart');
  assert.equal(d.reason, 'legacy-daemon-no-meta');
});

test('gh#82 B: #567 still holds — meta answered healthy, health irrelevant, never a restart', () => {
  const d = decideDaemonAction({
    meta: { version: pkg.version, capabilities: [CAP] },
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: false,
    healthOk: false
  });
  assert.equal(d.action, 'noop');
  assert.equal(d.reason, 'healthy');
});

test('gh#82 B: #835 still holds — an answered 401 aborts, health does not soften it', () => {
  const d = decideDaemonAction({
    meta: { answered: true, status: 401, refused: true, endpoint: '/api/meta' },
    cliVersion: pkg.version,
    sessionsReachable: false,
    healthOk: true
  });
  assert.equal(d.action, 'abort');
});

// ── (B) end to end through ensureDaemonRunning ────────────────────────────────

test('gh#82 T1 (red): meta+sessions time out but health answers ⇒ the restart path is NEVER entered', async () => {
  const doRestart = recordingRestart();
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await ensureDaemonRunning({
      _getDaemonMeta: timesOut,
      _fetchWithAuth: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
      _probeDaemonHealth: async () => true,
      _restartDaemonGraceful: doRestart,
      _detectSupervisor: noSupervisor,
      _probe: { attempts: 1, backoffMs: 0 }
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(doRestart.calls.length, 0, 'a daemon answering /api/health reached the kill path');
  assert.match(stderr.join(''), /alive, only slow/i);
  assert.match(stderr.join(''), /TELEPTY_PROBE_TIMEOUT_MS/);
});

test('gh#82 T2 (control): health silent too ⇒ the absent daemon is still auto-started', async () => {
  const doRestart = recordingRestart();
  await ensureDaemonRunning({
    _getDaemonMeta: timesOut,
    _fetchWithAuth: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    _probeDaemonHealth: async () => false,
    _restartDaemonGraceful: doRestart,
    _detectSupervisor: noSupervisor,
    _probe: { attempts: 1, backoffMs: 0 }
  });
  assert.equal(doRestart.calls.length, 1, 'a genuinely unreachable daemon must still be remediated');
  assert.equal(doRestart.calls[0].absenceVerdict, true, 'the start verdict must be declared to the restart path');
});

test('gh#82 A: a version-mismatch restart is NOT flagged as an absence verdict', async () => {
  const doRestart = recordingRestart();
  await ensureDaemonRunning({
    _getDaemonMeta: async () => ({ version: '0.0.1', capabilities: [CAP] }),
    _fetchWithAuth: async () => ({ ok: true, json: async () => [] }),
    _probeDaemonHealth: async () => { throw new Error('health must not be probed on a confirmed daemon'); },
    _restartDaemonGraceful: doRestart,
    _detectSupervisor: noSupervisor,
    _probe: { attempts: 1, backoffMs: 0 }
  });
  assert.equal(doRestart.calls.length, 1);
  assert.equal(doRestart.calls[0].absenceVerdict, false, 'replacing a daemon we KNOW answered must keep stopping it');
});

// ── (A) the guard at the choke point ──────────────────────────────────────────

const restartSeams = (extra = {}) => ({
  maxAttempts: 1,
  port: 51821, // never 3848 — the live daemon on this host is not addressed by any test here
  _detectSupervisor: noSupervisor,
  _startDetachedDaemon: () => {},
  _waitForDaemonHealth: async () => null,
  _findPortOwnerPid: () => null,
  _findParentProcessInfo: () => null,
  ...extra
});

test('gh#82 T3 (red): absenceVerdict + health 200 ⇒ cleanup is NEVER called', async () => {
  const cleanup = recordingCleanup();
  const log = recordingLog();
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  let result;
  try {
    result = await restartDaemonGraceful(restartSeams({
      absenceVerdict: true,
      _probeDaemonHealth: async () => true,
      _cleanupDaemonProcesses: cleanup,
      _logDaemonRestartEvent: log
    }));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(cleanup.calls.length, 0, 'the stop was issued against a daemon that answered /api/health');
  assert.equal(result.aliveButSlow, true);
  assert.equal(result.reason, 'alive-but-slow');
  assert.equal(result.success, false);
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].event, 'stop-refused');
  assert.equal(log.lines[0].verdict, 'alive-but-slow');
});

test('gh#82 T3 (red): the re-confirmation deadline is 3x the probe that produced the verdict', async () => {
  const seen = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    await restartDaemonGraceful(restartSeams({
      absenceVerdict: true,
      _probeDaemonHealth: async (port, timeout) => { seen.push({ port, timeout }); return true; },
      _cleanupDaemonProcesses: recordingCleanup(),
      _logDaemonRestartEvent: () => {}
    }));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].port, 51821, 'liveness must be re-confirmed on the ADDRESSED port (#902 scoping)');
  assert.equal(seen[0].timeout, probeTimeoutMs() * 3, 'a daemon too slow for the probe must not face the same impatience');
});

test('gh#82 T3b (control): absenceVerdict + health silent ⇒ the stop proceeds', async () => {
  const cleanup = recordingCleanup();
  await restartDaemonGraceful(restartSeams({
    absenceVerdict: true,
    _probeDaemonHealth: async () => false,
    _cleanupDaemonProcesses: cleanup,
    _logDaemonRestartEvent: () => {}
  }));
  assert.equal(cleanup.calls.length, 1, 'a genuinely dead port must still be cleaned up');
  assert.equal(cleanup.calls[0].port, 51821);
});

test('gh#82 T3c (regression): WITHOUT absenceVerdict a healthy daemon is still stopped', async () => {
  // The version-mismatch and repairLocalDaemon callers stop a daemon they know is alive, on
  // purpose. An unconditional health guard here would make `telepty update` a no-op.
  const cleanup = recordingCleanup();
  await restartDaemonGraceful(restartSeams({
    _probeDaemonHealth: async () => { throw new Error('health must not be probed without an absence verdict'); },
    _cleanupDaemonProcesses: cleanup,
    _logDaemonRestartEvent: () => {}
  }));
  assert.equal(cleanup.calls.length, 1, 'a deliberate replacement must keep stopping the old daemon');
});

// ── (C) the probe deadline ────────────────────────────────────────────────────

test('gh#82 C: probeTimeoutMs defaults to 1500 (unchanged) and honours TELEPTY_PROBE_TIMEOUT_MS', () => {
  const original = process.env.TELEPTY_PROBE_TIMEOUT_MS;
  try {
    delete process.env.TELEPTY_PROBE_TIMEOUT_MS;
    assert.equal(probeTimeoutMs(), 1500, 'the default must not change — this widens an escape hatch, it does not retune');
    process.env.TELEPTY_PROBE_TIMEOUT_MS = '9000';
    assert.equal(probeTimeoutMs(), 9000);
    process.env.TELEPTY_PROBE_TIMEOUT_MS = 'not-a-number';
    assert.equal(probeTimeoutMs(), 1500, 'garbage must fall back, never produce a zero deadline');
    process.env.TELEPTY_PROBE_TIMEOUT_MS = '0';
    assert.equal(probeTimeoutMs(), 1500, 'zero would abort every probe instantly ⇒ permanent "absent"');
  } finally {
    if (original === undefined) delete process.env.TELEPTY_PROBE_TIMEOUT_MS;
    else process.env.TELEPTY_PROBE_TIMEOUT_MS = original;
  }
});

test('gh#82 C: the meta deadline escalates on retry, so `start` needs failure at two patience levels', async () => {
  const deadlines = [];
  await ensureDaemonRunning({
    _getDaemonMeta: async (_host, timeout) => { deadlines.push(timeout); return null; },
    _fetchWithAuth: async () => { throw new Error('refused'); },
    _probeDaemonHealth: async () => false,
    _restartDaemonGraceful: async () => ({ success: true }),
    _detectSupervisor: noSupervisor,
    _probe: { attempts: 2, backoffMs: 0 }
  });
  assert.deepEqual(deadlines, [probeTimeoutMs(), probeTimeoutMs() * 2]);
});

// ── (E) the log ───────────────────────────────────────────────────────────────

test('gh#82 T6 (E): a failed restart attempt writes one line saying what was attempted and why', async () => {
  const log = recordingLog();
  await restartDaemonGraceful(restartSeams({
    maxAttempts: 2,
    _cleanupDaemonProcesses: () => ({ stopped: [{ pid: 4242 }], failed: [] }),
    _waitForDaemonHealth: async () => null, // nothing came back — the environment-A shape
    _logDaemonRestartEvent: log
  }));
  assert.equal(log.lines.length, 2, 'one line per failed attempt');
  assert.equal(log.lines[0].event, 'attempt-failed');
  assert.equal(log.lines[0].attempt, '1/2');
  assert.equal(log.lines[0].port, 51821);
  assert.equal(log.lines[0].stopped, 1);
  assert.equal(log.lines[0].reason, 'no-daemon-after-spawn', 'a bare "attempt n/N failed" is what made this a multi-round remote diagnosis');
  assert.equal(log.lines[1].attempt, '2/2');
});

test('gh#82 T6 (E): the reason reaches the real log file under ~/.telepty/logs', async () => {
  // setup-env.js gives every test process its own HOME, so this writes to a temp tree and the
  // developer's real ~/.telepty is never touched.
  const logPath = path.join(os.homedir(), '.telepty', 'logs', 'daemon-restart.log');
  try { fs.unlinkSync(logPath); } catch { /* first run */ }
  await restartDaemonGraceful(restartSeams({
    _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
    _waitForDaemonHealth: async () => null
  }));
  const written = fs.readFileSync(logPath, 'utf8');
  assert.match(written, /event=attempt-failed/);
  assert.match(written, /port=51821/);
  assert.match(written, /reason=no-daemon-after-spawn/);
  assert.match(written, /^\[\d{4}-\d{2}-\d{2}T/, 'timestamped like session-deaths.log');
});

test('gh#82 T6 (E): the stderr retry banner names the reason too', async () => {
  const stderr = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    await restartDaemonGraceful(restartSeams({
      maxAttempts: 2,
      _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
      _waitForDaemonHealth: async () => null,
      _logDaemonRestartEvent: () => {}
    }));
  } finally {
    process.stderr.write = write;
  }
  assert.match(stderr.join(''), /attempt 1\/2 failed \(no-daemon-after-spawn\)/);
});

// ── T7: the reproduction the issue said it did not have ───────────────────────
//
// A stub daemon that answers /api/health and STALLS /api/meta + /api/sessions — the mechanism the
// report described but had not exercised ("we have not verified that specific reproduction
// ourselves").
//
// MEASURED against the pre-fix cli.js: the CLI prints "⚙️ Auto-starting local telepty daemon..."
// — the absence verdict, reached while the stub was answering /api/health 200 — and enters
// restartDaemonGraceful, whose step (a) is the stop. That banner is the load-bearing assertion
// here and it is what turns green with the fix.
//
// The signals log is the safety net, not the proof: in THIS harness the stub's port owner is the
// test runner, so telepty#15's blocked-restart fail-fast ("owned by parent node") stops the path
// one step after the stop is attempted and no signal is reached even unfixed. On the reporter's
// machine the port owner is a real daemon, where the same verdict does deliver SIGTERM.
// block-signals.js records rather than delivers, so a non-empty log would be a real regression.

function startHalfAliveDaemon() {
  const stalled = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: pkg.version }));
      return;
    }
    // /api/meta and /api/sessions: accept the connection and never answer.
    stalled.push(res);
  });
  server.on('close', () => { for (const res of stalled) { try { res.destroy(); } catch {} } });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      closeAll: () => { for (const res of stalled) { try { res.destroy(); } catch {} } }
    }));
  });
}

function runCli(args, port, signalsLog, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'cli.js'), ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TELEPTY_PORT: String(port),
        TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
        NO_UPDATE_NOTIFIER: '1',
        TELEPTY_SUPERVISOR_WAIT_MS: '1',
        TELEPTY_DAEMON_KILL_GRACE_MS: '10',
        TELEPTY_PROBE_TIMEOUT_MS: '150', // the environment-A condition, compressed
        BLOCKED_SIGNALS_LOG: signalsLog,
        NODE_OPTIONS: `--require ${BLOCK_SIGNALS}`,
        ...extraEnv
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function blockedSignals(logPath) {
  try { return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

test('gh#82 T7 (E2E red): `list` against a daemon that answers /api/health but stalls /api/meta issues NO kill', async (t) => {
  const stub = await startHalfAliveDaemon();
  const signalsLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh82-')), 'signals.log');
  t.after(() => new Promise((resolve) => { stub.closeAll(); stub.server.close(resolve); }));

  const { stderr } = await runCli(['list'], stub.port, signalsLog);

  assert.deepEqual(
    blockedSignals(signalsLog),
    [],
    'a command that concluded "nothing is there" attempted to kill the process that answered /api/health'
  );
  assert.doesNotMatch(stderr, /Auto-starting local telepty daemon/, 'the absence verdict was reached despite a 200 on /api/health');
  assert.match(stderr, /alive, only slow/i, 'the operator must be told the daemon is there, just slow');
});
