'use strict';
// #738 — unit coverage for supervisor detection (per-OS) and the defer policy (uniform).
// No sockets, no daemons, no real filesystem: every seam is injected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  LAUNCHD_PLIST_NAME,
  SYSTEMD_UNIT_PATH,
  SYSTEMD_USER_UNIT_NAME,
  WINDOWS_TASK_NAME,
  DEFER_MARKER_TTL_MS,
  detectSupervisor,
  isDeferMarkerFresh
} = require('../src/supervisor');
const { deferToSupervisor, ensureDaemonRunning } = require('../cli');

const HOME = path.join(path.sep, 'home', 'tester');
const homedir = () => HOME;

function existsOnly(...present) {
  const set = new Set(present);
  return (p) => set.has(p);
}

// ── detection: macOS / launchd ────────────────────────────────────────────────────
test('detect: darwin with the installed plist → launchd', () => {
  const plist = path.join(HOME, 'Library', 'LaunchAgents', LAUNCHD_PLIST_NAME);
  const result = detectSupervisor({
    platform: 'darwin', env: {}, homedir, existsSync: existsOnly(plist)
  });
  assert.deepEqual(result, { present: true, kind: 'launchd', detail: plist });
});

test('detect: darwin without the plist → absent (pre-#738 behavior)', () => {
  const result = detectSupervisor({
    platform: 'darwin', env: {}, homedir, existsSync: existsOnly()
  });
  assert.equal(result.present, false);
  assert.equal(result.kind, null);
});

// ── detection: Linux / systemd ────────────────────────────────────────────────────
test('detect: linux with the root-installed unit → systemd', () => {
  const result = detectSupervisor({
    platform: 'linux', env: {}, homedir, existsSync: existsOnly(SYSTEMD_UNIT_PATH)
  });
  assert.deepEqual(result, { present: true, kind: 'systemd', detail: SYSTEMD_UNIT_PATH });
});

test('detect: linux with the user-installed unit → systemd-user', () => {
  const userUnit = path.join(HOME, '.config', 'systemd', 'user', SYSTEMD_USER_UNIT_NAME);
  const result = detectSupervisor({
    platform: 'linux', env: {}, homedir, existsSync: existsOnly(userUnit)
  });
  assert.deepEqual(result, { present: true, kind: 'systemd-user', detail: userUnit });
});

test('detect: linux non-root install (no unit file) → absent', () => {
  const result = detectSupervisor({
    platform: 'linux', env: {}, homedir, existsSync: existsOnly()
  });
  assert.equal(result.present, false);
});

// ── detection: Windows / schtasks ─────────────────────────────────────────────────
test('detect: win32 with the registered task → schtasks (queries by exact task name)', () => {
  const calls = [];
  const result = detectSupervisor({
    platform: 'win32',
    env: {},
    homedir,
    existsSync: existsOnly(),
    execSync: (cmd) => { calls.push(cmd); return 'TaskName: \\telepty-daemon'; }
  });
  assert.deepEqual(result, { present: true, kind: 'schtasks', detail: WINDOWS_TASK_NAME });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^schtasks \/query \/tn "telepty-daemon" \/fo LIST$/);
});

test('detect: win32 with no such task (schtasks exits non-zero) → absent', () => {
  const result = detectSupervisor({
    platform: 'win32',
    env: {},
    homedir,
    existsSync: existsOnly(),
    execSync: () => { throw new Error('ERROR: The system cannot find the file specified.'); }
  });
  assert.equal(result.present, false);
});

// ── detection: operator kill-switch ───────────────────────────────────────────────
test('detect: TELEPTY_NO_SUPERVISOR_DEFER=1 forces absent on every platform', () => {
  const plist = path.join(HOME, 'Library', 'LaunchAgents', LAUNCHD_PLIST_NAME);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const result = detectSupervisor({
      platform,
      env: { TELEPTY_NO_SUPERVISOR_DEFER: '1' },
      homedir,
      existsSync: existsOnly(plist, SYSTEMD_UNIT_PATH),
      execSync: () => 'TaskName: \\telepty-daemon'
    });
    assert.equal(result.present, false, `${platform} must honor the kill-switch`);
  }
});

// ── marker freshness (pure) ───────────────────────────────────────────────────────
test('marker: fresh only for a matching signature inside the TTL', () => {
  const now = Date.parse('2026-07-26T10:00:00.000Z');
  const recent = { signature: 'launchd:3848', recordedAt: new Date(now - 1000).toISOString() };

  assert.equal(isDeferMarkerFresh(recent, 'launchd:3848', now), true);
  assert.equal(isDeferMarkerFresh(recent, 'launchd:9999', now), false, 'other port');
  assert.equal(isDeferMarkerFresh(recent, 'systemd:3848', now), false, 'other supervisor');
  assert.equal(isDeferMarkerFresh(null, 'launchd:3848', now), false);
  assert.equal(isDeferMarkerFresh({ signature: 'launchd:3848' }, 'launchd:3848', now), false, 'no timestamp');
  assert.equal(
    isDeferMarkerFresh({ signature: 'launchd:3848', recordedAt: 'not-a-date' }, 'launchd:3848', now),
    false,
    'unparseable timestamp'
  );
  assert.equal(
    isDeferMarkerFresh(
      { signature: 'launchd:3848', recordedAt: new Date(now - DEFER_MARKER_TTL_MS - 1).toISOString() },
      'launchd:3848',
      now
    ),
    false,
    'expired → the supervisor gets another chance'
  );
});

// ── defer policy (uniform across platforms) ───────────────────────────────────────
const absent = () => ({ present: false, kind: null, detail: null });
const launchd = () => ({ present: true, kind: 'launchd', detail: '/plist' });

function policyOptions(overrides = {}) {
  return {
    supervisorWaitMs: 400,
    supervisorPollMs: 20,
    _detectSupervisor: launchd,
    _getDaemonMeta: async () => null,
    _readSupervisorDeferMarker: () => null,
    _writeSupervisorDeferMarker: () => {},
    _clearSupervisorDeferMarker: () => {},
    ...overrides
  };
}

test('defer: no supervisor → null immediately, nothing probed', async () => {
  let probes = 0;
  const deferred = await deferToSupervisor(policyOptions({
    _detectSupervisor: absent,
    _getDaemonMeta: async () => { probes += 1; return null; }
  }));
  assert.equal(deferred, null);
  assert.equal(probes, 0, 'absent supervisor must cost nothing');
});

test('defer: supervisor delivers a daemon mid-wait → its meta (caller must not spawn)', async () => {
  let probes = 0;
  const cleared = [];
  const deferred = await deferToSupervisor(policyOptions({
    _getDaemonMeta: async () => {
      probes += 1;
      return probes >= 3 ? { version: '9.9.9' } : null;
    },
    _clearSupervisorDeferMarker: () => cleared.push(true)
  }));
  assert.deepEqual(deferred, { version: '9.9.9' }, 'returns the daemon meta for the caller to re-decide on');
  assert.equal(probes, 3, 'must stop probing the instant the daemon answers');
  assert.deepEqual(cleared, [true], 'a delivering supervisor clears the stale verdict');
});

test('defer: supervisor never delivers → null, and the verdict is recorded', async () => {
  const written = [];
  const deferred = await deferToSupervisor(policyOptions({
    _writeSupervisorDeferMarker: (marker) => written.push(marker)
  }));
  assert.equal(deferred, null, 'must fall back to spawning rather than hang');
  assert.equal(written.length, 1);
  assert.match(written[0].signature, /^launchd:/);
  assert.ok(Date.parse(written[0].recordedAt) > 0, 'recordedAt drives the TTL');
});

test('defer: a fresh no-deliver verdict skips the wait entirely', async () => {
  let probes = 0;
  const deferred = await deferToSupervisor(policyOptions({
    _readSupervisorDeferMarker: () => ({
      signature: `launchd:${process.env.TELEPTY_PORT || 3848}`,
      recordedAt: new Date().toISOString()
    }),
    _getDaemonMeta: async () => { probes += 1; return null; }
  }));
  assert.equal(deferred, null);
  assert.equal(probes, 0, 'a broken supervisor must not cost every command the full wait');
});

test('defer: a stale verdict is ignored — the supervisor gets another chance', async () => {
  let probes = 0;
  const deferred = await deferToSupervisor(policyOptions({
    _readSupervisorDeferMarker: () => ({
      signature: `launchd:${process.env.TELEPTY_PORT || 3848}`,
      recordedAt: new Date(Date.now() - DEFER_MARKER_TTL_MS - 1000).toISOString()
    }),
    _getDaemonMeta: async () => { probes += 1; return probes >= 2 ? { version: '9.9.9' } : null; }
  }));
  assert.ok(deferred, 'expired verdict must re-probe and then defer');
  assert.ok(probes > 0, 'expired verdict must re-probe');
});

// ── ensureDaemonRunning integration with the defer policy (injected seams only) ────
function ensureOptions(overrides = {}) {
  return {
    _probe: { attempts: 1, backoffMs: 0 },
    supervisorWaitMs: 400,
    supervisorPollMs: 20,
    _detectSupervisor: launchd,
    _fetchWithAuth: async () => ({ ok: false }),
    _findPortOwnerPid: () => null,
    _readRestartFailureMarker: () => null,
    _writeRestartFailureMarker: () => {},
    _clearRestartFailureMarker: () => {},
    _readSupervisorDeferMarker: () => null,
    _writeSupervisorDeferMarker: () => {},
    _clearSupervisorDeferMarker: () => {},
    ...overrides
  };
}

test('ensureDaemonRunning: supervisor restores a matching daemon → no spawn at all (#738 core)', async () => {
  let restarts = 0;
  let probes = 0;
  await ensureDaemonRunning(ensureOptions({
    _getDaemonMeta: async () => {
      probes += 1;
      return probes === 1 ? null : { version: require('../package.json').version, capabilities: [] };
    },
    _restartDaemonGraceful: async () => { restarts += 1; return { success: true }; }
  }));
  assert.equal(restarts, 0, 'deferring to the supervisor must not spawn an orphan');
});

test('ensureDaemonRunning: supervisor restores a STALE daemon → still restarts (no blind accept)', async () => {
  // An upgrade window can leave the supervisor launching an older install. Deferring must
  // not mean silently accepting whatever came back.
  let restarts = 0;
  let probes = 0;
  await ensureDaemonRunning(ensureOptions({
    _getDaemonMeta: async () => {
      probes += 1;
      return probes === 1 ? null : { version: '0.0.1-ancient', capabilities: [] };
    },
    _restartDaemonGraceful: async () => { restarts += 1; return { success: true }; }
  }));
  assert.equal(restarts, 1, 'a version-mismatched daemon from the supervisor still gets restarted');
});

test('ensureDaemonRunning: no supervisor and no daemon → spawns exactly as before #738', async () => {
  let restarts = 0;
  await ensureDaemonRunning(ensureOptions({
    _detectSupervisor: absent,
    _getDaemonMeta: async () => null,
    _restartDaemonGraceful: async () => { restarts += 1; return { success: true }; }
  }));
  assert.equal(restarts, 1, 'unchanged auto-start path on unsupervised hosts');
});
