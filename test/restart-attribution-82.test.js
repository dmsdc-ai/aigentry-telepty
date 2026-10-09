'use strict';

// gh#82 follow-up (2026-10-09, ask 1) — every client-initiated stop or kickstart says WHO did it.
//
// Under multi-session load a launchd-supervised daemon restarted twice in six minutes and nothing
// on the host could say which process sent the SIGTERM: `~/.telepty/logs/daemon-restart.log`
// (0.8.2) records a restart attempt only when it FAILS, and a successful stop leaves no line at
// all. The reporter could only infer that "clients whose probes all timed out" did it.
//
// Pinned here: before `restartDaemonGraceful` stops anything (cleanup) or kickstarts the
// supervisor, it appends one `event=stop-initiated` / `event=kickstart-initiated` line carrying
// initiator_pid, initiator_ppid, initiator_argv (≤ 200 chars, one line), the verdict that sent it
// there, the addressed port and the session id — successful or not.
//
// SAFETY: in-process only, every kill/spawn/kickstart is an injected seam, port 51821 is never the
// live daemon's, and setup-env.js gives this process its own HOME for the real-log case.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('../package.json');
const { restartDaemonGraceful } = require('../cli');

const PORT = 51821;
const LOG_PATH = path.join(os.homedir(), '.telepty', 'logs', 'daemon-restart.log');
const healthy = { version: pkg.version, capabilities: [] };

function recordingLog() {
  const lines = [];
  const fn = (fields) => { lines.push(fields); };
  fn.lines = lines;
  return fn;
}

function restartSeams(extra = {}) {
  return {
    maxAttempts: 1,
    port: PORT,
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

test('attribution: a stop writes event=stop-initiated with pid/ppid/argv/verdict BEFORE the stop', async () => {
  const log = recordingLog();
  const seenAtStop = [];
  await quiet(() => restartDaemonGraceful(restartSeams({
    absenceVerdict: true,
    verdict: 'daemon-unreachable',
    _probeDaemonHealth: async () => false,
    _cleanupDaemonProcesses: () => { seenAtStop.push(log.lines.slice()); return { stopped: [], failed: [] }; },
    _logDaemonRestartEvent: log
  })));

  assert.equal(seenAtStop.length, 1, 'the stop must have been reached');
  const before = seenAtStop[0].filter((l) => l.event === 'stop-initiated');
  assert.equal(before.length, 1, 'the initiator line must be written before cleanup runs, not after');
  const line = before[0];
  assert.equal(line.initiator_pid, process.pid);
  assert.equal(line.initiator_ppid, process.ppid);
  assert.equal(typeof line.initiator_argv, 'string');
  assert.equal(line.verdict, 'daemon-unreachable');
  assert.equal(line.port, PORT);
});

test('attribution: a supervisor kickstart writes event=kickstart-initiated BEFORE the kickstart', async () => {
  const log = recordingLog();
  const seenAtKick = [];
  let health = 0;
  await quiet(() => restartDaemonGraceful(restartSeams({
    verdict: 'version-cli-newer',
    _detectSupervisor: () => ({ present: true, kind: 'launchd', detail: '/fake.plist' }),
    _supervisedPort: () => PORT,
    _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
    _restartSupervisorDaemon: () => { seenAtKick.push(log.lines.slice()); return { success: true, kind: 'launchd' }; },
    // first wait = "did the supervisor already restore it?" (no), second = after the kickstart (yes)
    _waitForDaemonHealth: async () => (++health === 1 ? null : healthy),
    _logDaemonRestartEvent: log
  })));

  assert.equal(seenAtKick.length, 1, 'the kickstart must have been reached');
  const kick = seenAtKick[0].filter((l) => l.event === 'kickstart-initiated');
  assert.equal(kick.length, 1, 'the initiator line must be written before the kickstart runs');
  assert.equal(kick[0].initiator_pid, process.pid);
  assert.equal(kick[0].initiator_ppid, process.ppid);
  assert.equal(kick[0].verdict, 'version-cli-newer');
  assert.equal(kick[0].port, PORT);
  assert.equal(
    seenAtKick[0].filter((l) => l.event === 'stop-initiated').length,
    1,
    'the stop that precedes the kickstart is attributed too'
  );
});

test('attribution: a SUCCESSFUL stop now leaves a line in the real daemon-restart.log', async () => {
  // Pre-fix, only failures logged: this exact call — stop, respawn, healthy daemon back — wrote nothing.
  try { fs.unlinkSync(LOG_PATH); } catch { /* first run */ }
  const result = await quiet(() => restartDaemonGraceful(restartSeams({
    verdict: 'capability-missing:wrapped-sessions',
    _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] })
  })));
  assert.equal(result.success, true, 'precondition: this restart succeeded');

  const written = fs.readFileSync(LOG_PATH, 'utf8');
  assert.match(written, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] event=stop-initiated /m);
  assert.match(written, new RegExp(`initiator_pid=${process.pid} initiator_ppid=${process.ppid} initiator_argv=`));
  assert.match(written, /verdict=capability-missing:wrapped-sessions port=51821 session=none/);
});

test('attribution: argv is capped at 200 chars and can never break the one-line-per-event format', async () => {
  const log = recordingLog();
  const originalArgv = process.argv;
  const originalSession = process.env.TELEPTY_SESSION_ID;
  process.argv = [originalArgv[0], originalArgv[1], 'inject', 'target', `line one\nline two ${'x'.repeat(400)}`];
  process.env.TELEPTY_SESSION_ID = 'worker-7';
  try {
    await quiet(() => restartDaemonGraceful(restartSeams({
      verdict: 'daemon-unreachable',
      absenceVerdict: true,
      _probeDaemonHealth: async () => false,
      _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
      _logDaemonRestartEvent: log
    })));
  } finally {
    process.argv = originalArgv;
    if (originalSession === undefined) delete process.env.TELEPTY_SESSION_ID;
    else process.env.TELEPTY_SESSION_ID = originalSession;
  }
  const line = log.lines.find((l) => l.event === 'stop-initiated');
  assert.ok(line, 'stop-initiated line missing');
  const argv = JSON.parse(line.initiator_argv); // quoted, so spaces/newlines stay inside one field
  assert.ok(argv.length <= 200, `argv must be capped at 200 chars, got ${argv.length}`);
  assert.ok(argv.startsWith('inject target line one\nline two'));
  assert.doesNotMatch(line.initiator_argv, /\n/, 'a raw newline would split one event across two log lines');
  assert.equal(line.session, 'worker-7');
});
