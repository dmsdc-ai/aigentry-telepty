'use strict';

// #567 — ensureDaemonRunning must NOT restart a healthy daemon on a transient
// health-probe timeout. Under concurrent-spawn load the 1500ms /api/sessions (or
// meta) probe can time out even though the daemon is the correct version with all
// required capabilities; the old code caught that timeout and (re)started the
// daemon — a false alarm that could not displace the healthy incumbent and emitted
// the scary "Daemon restart failed after 3 attempts" banner on every spawn.
//
// All probes/restart are injected so NO real daemon is touched and NO real network
// call is made (SAFETY: this suite runs inside the live telepty daemon environment).

// Disable the update notifier before requiring cli.js so requiring it stays inert.
process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');
const { ensureDaemonRunning, decideDaemonAction } = require('../cli');

const CAP = 'wrapped-sessions';
const healthyMeta = { version: pkg.version, capabilities: [CAP] };

function timeoutFetch() {
  // Simulate a /api/sessions probe that times out (AbortSignal.timeout throws).
  return () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
}

function okFetch() {
  return () => Promise.resolve({ ok: true, json: async () => [] });
}

function recordingRestart() {
  const calls = [];
  const fn = async (opts) => { calls.push(opts || {}); return { success: true }; };
  fn.calls = calls;
  return fn;
}

// ── Pure decision policy ───────────────────────────────────────────────────────

test('decideDaemonAction: healthy version + caps → noop even if sessions unreachable (#567)', () => {
  const d = decideDaemonAction({
    meta: healthyMeta,
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: false
  });
  assert.equal(d.action, 'noop');
});

test('decideDaemonAction: daemon older than CLI → restart', () => {
  const d = decideDaemonAction({
    meta: { version: '0.0.1', capabilities: [CAP] },
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: true
  });
  assert.equal(d.action, 'restart');
});

test('decideDaemonAction: required capability genuinely missing → restart', () => {
  const d = decideDaemonAction({
    meta: { version: pkg.version, capabilities: [] },
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: true
  });
  assert.equal(d.action, 'restart');
});

test('decideDaemonAction: no meta but /api/sessions answers → restart (legacy daemon)', () => {
  const d = decideDaemonAction({
    meta: null,
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: true
  });
  assert.equal(d.action, 'restart');
});

test('decideDaemonAction: no meta and /api/sessions unreachable → start', () => {
  const d = decideDaemonAction({
    meta: null,
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: false
  });
  assert.equal(d.action, 'start');
});

test('decideDaemonAction: daemon newer than CLI → noop (do not clobber)', () => {
  const d = decideDaemonAction({
    meta: { version: '999.0.0', capabilities: [CAP] },
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: false
  });
  assert.equal(d.action, 'noop');
});

// ── ensureDaemonRunning orchestration (injected probes; no real daemon) ─────────

test('ensureDaemonRunning: healthy daemon + slow /api/sessions (timeout) → NO restart (#567 key)', async () => {
  const restart = recordingRestart();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _getDaemonMeta: async () => healthyMeta,
    _fetchWithAuth: timeoutFetch(),       // sessions probe times out — must not matter
    _restartDaemonGraceful: restart,
    _probe: { attempts: 3, backoffMs: 0 }
  });
  assert.equal(restart.calls.length, 0, 'healthy daemon must not be restarted on a slow sessions probe');
});

test('ensureDaemonRunning: version mismatch → DOES restart (legit)', async () => {
  const restart = recordingRestart();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _getDaemonMeta: async () => ({ version: '0.0.1', capabilities: [CAP] }),
    _fetchWithAuth: okFetch(),
    _restartDaemonGraceful: restart,
    _probe: { attempts: 3, backoffMs: 0 }
  });
  assert.equal(restart.calls.length, 1, 'a genuine version mismatch must still restart');
});

test('ensureDaemonRunning: required capability missing → DOES restart (legit)', async () => {
  const restart = recordingRestart();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _getDaemonMeta: async () => ({ version: pkg.version, capabilities: [] }),
    _fetchWithAuth: okFetch(),
    _restartDaemonGraceful: restart,
    _probe: { attempts: 3, backoffMs: 0 }
  });
  assert.equal(restart.calls.length, 1, 'a genuinely missing capability must still restart');
});

test('ensureDaemonRunning: no daemon at all (meta null + sessions unreachable) → DOES start (legit)', async () => {
  const restart = recordingRestart();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _getDaemonMeta: async () => null,
    _fetchWithAuth: timeoutFetch(),
    _restartDaemonGraceful: restart,
    _probe: { attempts: 2, backoffMs: 0 }
  });
  assert.equal(restart.calls.length, 1, 'a genuinely absent daemon must be auto-started');
});

test('ensureDaemonRunning: transient meta timeout that recovers on retry → NO restart', async () => {
  const restart = recordingRestart();
  let n = 0;
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _getDaemonMeta: async () => {
      n += 1;
      return n < 2 ? null : healthyMeta; // first probe "times out", second succeeds
    },
    _fetchWithAuth: timeoutFetch(),
    _restartDaemonGraceful: restart,
    _probe: { attempts: 3, backoffMs: 0 }
  });
  assert.equal(restart.calls.length, 0, 'a transient meta timeout that recovers must not restart');
  assert.ok(n >= 2, 'meta probe should have been retried at least once');
});
