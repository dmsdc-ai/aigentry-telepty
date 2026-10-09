'use strict';

// gh#82 follow-up (2026-10-09, ask 3) — under a supervisor, a client's "absent" verdict must not
// become a SIGTERM.
//
// The incident (0.8.3, macOS, launchd job com.aigentry.telepty, ~12 sessions, load > 14): probes
// timed out, ensureDaemonRunning concluded `start` / `daemon-unreachable`, deferToSupervisor gave
// up (or skipped the wait on a fresh supervisor-defer.json — the host had one), and the start path
// fell through to restartDaemonGraceful → cleanup({port}) → SIGTERM of the live launchd daemon.
//
//   auto (default) + supervisor owns the addressed port + absence verdict ⇒ defer to the
//     supervisor; zero cleanup. THIS IS THE REPRODUCTION — red on 6c84ba6 by observing a cleanup.
//   TELEPTY_CLIENT_RESTART=off (or clientRestart:"off" in ~/.telepty/config.json) ⇒ the client
//     never stops, spawns or kickstarts; the message names the supervisor command to run by hand.
//   Controls: no supervisor ⇒ auto-start unchanged. Round 2 (c): under a supervisor a daemon that
//     ANSWERED and is wrong (version mismatch) is left to the supervisor as well.
//
// SAFETY: in-process only. `_restartDaemonGraceful` is the REAL restartDaemonGraceful with every
// kill/spawn/kickstart replaced by a recording seam, so a cleanup is observed, never delivered.
// setup-env.js gives this process its own HOME (config.json, lease and markers are temp files).

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureDaemonRunning, restartDaemonGraceful } = require('../cli');

const PORT = 51821;
const CONFIG_PATH = path.join(os.homedir(), '.telepty', 'config.json');

const launchd = () => ({ present: true, kind: 'launchd', detail: '/fake.plist' });
const systemdUser = () => ({ present: true, kind: 'systemd-user', detail: '/fake.service' });
const noSupervisor = () => ({ present: false, kind: null, detail: null });

// Every destructive or spawning act, counted.
function recorder() {
  const r = { cleanup: 0, spawn: 0, kickstart: 0, restartCalls: 0, metaPolls: 0 };
  r.restart = (opts) => {
    r.restartCalls += 1;
    return restartDaemonGraceful({
      ...opts,
      maxAttempts: 1,
      port: PORT,
      _supervisedPort: () => PORT,
      _detectSupervisor: r.detect,
      _probeDaemonHealth: async () => false,
      _cleanupDaemonProcesses: () => { r.cleanup += 1; return { stopped: [{ pid: 4242 }], failed: [] }; },
      _startDetachedDaemon: () => { r.spawn += 1; },
      _restartSupervisorDaemon: () => { r.kickstart += 1; return { success: true, kind: 'launchd' }; },
      _waitForDaemonHealth: async () => null,
      _findPortOwnerPid: () => null,
      _findParentProcessInfo: () => null,
      _logDaemonRestartEvent: () => {}
    });
  };
  return r;
}

function ensureOptions(r, { detect = launchd, meta = async () => { r.metaPolls += 1; return null; }, deferMarker = null } = {}) {
  r.detect = detect;
  return {
    port: PORT,
    _supervisedPort: () => PORT,
    _probe: { attempts: 1, backoffMs: 0 },
    supervisorWaitMs: 60,
    supervisorPollMs: 10,
    _detectSupervisor: detect,
    _getDaemonMeta: meta,
    // Round 2 (a): only a REFUSED connection is an absence verdict; a timeout no longer reaches start.
    _fetchWithAuth: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); },
    _probeDaemonHealth: async () => false, // refused on all three probes — the verdict is daemon-unreachable
    _restartDaemonGraceful: r.restart,
    _findPortOwnerPid: () => null,
    _readRestartFailureMarker: () => null,
    _writeRestartFailureMarker: () => {},
    _clearRestartFailureMarker: () => {},
    _readSupervisorDeferMarker: () => deferMarker,
    _writeSupervisorDeferMarker: () => {},
    _clearSupervisorDeferMarker: () => {}
  };
}

async function captureStderr(fn) {
  const chunks = [];
  const write = process.stderr.write.bind(process.stderr);
  const error = console.error;
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  console.error = (...a) => { chunks.push(a.join(' ') + '\n'); };
  try {
    const result = await fn();
    return { result, text: chunks.join('') };
  } finally {
    process.stderr.write = write;
    console.error = error;
  }
}

function withEnv(value) {
  const original = process.env.TELEPTY_CLIENT_RESTART;
  if (value === undefined) delete process.env.TELEPTY_CLIENT_RESTART;
  else process.env.TELEPTY_CLIENT_RESTART = value;
  return () => {
    if (original === undefined) delete process.env.TELEPTY_CLIENT_RESTART;
    else process.env.TELEPTY_CLIENT_RESTART = original;
  };
}

afterEach(() => { try { fs.unlinkSync(CONFIG_PATH); } catch { /* none */ } });

// ── the incident ────────────────────────────────────────────────────────────────

test('REPRO (auto): supervisor owns the port + every probe timed out ⇒ defer to it, ZERO cleanup', async () => {
  const restore = withEnv(undefined);
  const r = recorder();
  try {
    const { text } = await captureStderr(() => ensureDaemonRunning(ensureOptions(r)));
    assert.ok(r.metaPolls > 1, 'the start path must go through deferToSupervisor (it polls the supervisor)');
    assert.equal(r.cleanup, 0, 'a client that merely timed out SIGTERMed the supervisor-owned daemon — gh#82, 2026-10-09');
    assert.equal(r.kickstart, 0, '`launchctl kickstart -k` is a SIGTERM too');
    assert.equal(r.spawn, 0);
    assert.match(text, /launchctl kickstart -k gui\/\S+\/com\.aigentry\.telepty/, 'name the command a human can run');
  } finally {
    restore();
  }
});

test('REPRO (auto): the host had a FRESH supervisor-defer.json ⇒ still zero cleanup', async () => {
  // A fresh marker makes deferToSupervisor return at once; pre-fix that went straight to the stop.
  const restore = withEnv(undefined);
  const r = recorder();
  try {
    await captureStderr(() => ensureDaemonRunning(ensureOptions(r, {
      deferMarker: { signature: `launchd:${process.env.TELEPTY_PORT || 3848}`, recordedAt: new Date().toISOString() }
    })));
    assert.equal(r.cleanup, 0);
    assert.equal(r.kickstart, 0);
  } finally {
    restore();
  }
});

// ── fail-fast switch ────────────────────────────────────────────────────────────

test('off (env): absence verdict ⇒ no cleanup, no spawn, no supervisor restart; names the launchd command', async () => {
  const restore = withEnv('off');
  const r = recorder();
  try {
    const { result, text } = await captureStderr(() => ensureDaemonRunning(ensureOptions(r)));
    assert.equal(r.restartCalls, 0, 'off: the restart path must not be entered at all');
    assert.equal(r.cleanup + r.spawn + r.kickstart, 0);
    assert.equal(r.metaPolls, 1, 'off is fail-fast: no supervisor wait either');
    assert.equal(result && result.success, false, 'the caller gets a failure, not a silent return');
    assert.match(text, /TELEPTY_CLIENT_RESTART/);
    assert.match(text, /launchctl kickstart -k gui\/\S+\/com\.aigentry\.telepty/);
  } finally {
    restore();
  }
});

test('off (env): systemd user unit ⇒ names `systemctl --user restart telepty`', async () => {
  const restore = withEnv('off');
  const r = recorder();
  try {
    const { text } = await captureStderr(() => ensureDaemonRunning(ensureOptions(r, { detect: systemdUser })));
    assert.equal(r.cleanup + r.spawn + r.kickstart, 0);
    assert.match(text, /systemctl --user restart telepty/);
  } finally {
    restore();
  }
});

test('off (env): no supervisor ⇒ no spawn either; names `telepty daemon start`', async () => {
  const restore = withEnv('off');
  const r = recorder();
  try {
    const { text } = await captureStderr(() => ensureDaemonRunning(ensureOptions(r, { detect: noSupervisor })));
    assert.equal(r.cleanup + r.spawn + r.kickstart, 0, 'off means the client never starts a daemon');
    assert.match(text, /telepty daemon start/);
  } finally {
    restore();
  }
});

test('off (config.json clientRestart): same as the env switch', async () => {
  const restore = withEnv(undefined);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ authToken: 'test-token', clientRestart: 'off' }));
  const r = recorder();
  try {
    const { text } = await captureStderr(() => ensureDaemonRunning(ensureOptions(r, { detect: noSupervisor })));
    assert.equal(r.restartCalls, 0);
    assert.equal(r.cleanup + r.spawn + r.kickstart, 0);
    assert.match(text, /telepty daemon start/);
  } finally {
    restore();
  }
});

test('off (env): a version-mismatched daemon is not replaced by the client either', async () => {
  const restore = withEnv('off');
  const r = recorder();
  try {
    await captureStderr(() => ensureDaemonRunning(ensureOptions(r, {
      meta: async () => ({ version: '0.0.1', capabilities: [] })
    })));
    assert.equal(r.restartCalls, 0);
    assert.equal(r.cleanup + r.spawn + r.kickstart, 0);
  } finally {
    restore();
  }
});

// ── controls: what `auto` must keep doing ───────────────────────────────────────

test('control (auto): no supervisor + absence verdict ⇒ the absent daemon is still auto-started', async () => {
  const restore = withEnv(undefined);
  const r = recorder();
  try {
    await captureStderr(() => ensureDaemonRunning(ensureOptions(r, { detect: noSupervisor })));
    assert.equal(r.restartCalls, 1);
    assert.equal(r.spawn, 1, 'unsupervised hosts keep the pre-gh#82 auto-start');
  } finally {
    restore();
  }
});

test('round 2 (c) (auto): supervisor + a daemon that ANSWERED with the wrong version ⇒ left to the supervisor too', async () => {
  // Round 1 kept this restart; the RCA (§Q4 ask 3) showed the gate must cover every verdict.
  const restore = withEnv(undefined);
  const r = recorder();
  try {
    const { text } = await captureStderr(() => ensureDaemonRunning(ensureOptions(r, {
      meta: async () => ({ version: '0.0.1', capabilities: [] })
    })));
    assert.equal(r.restartCalls, 0);
    assert.equal(r.cleanup + r.spawn + r.kickstart, 0, 'a supervised daemon is never stopped by a client');
    assert.match(text, /launchctl kickstart -k gui\/\S+\/com\.aigentry\.telepty/);
  } finally {
    restore();
  }
});
