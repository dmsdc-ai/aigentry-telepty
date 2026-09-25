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
const {
  ensureDaemonRunning,
  decideDaemonAction,
  resolveDaemonLifecycleMode,
  isDaemonLifecycleError
} = require('../cli');

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
    _findPortOwnerPid: () => null,
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
    _findPortOwnerPid: () => null,
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
    _detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    _fetchWithAuth: timeoutFetch(),
    // gh#82 (B): absent on /api/health too — otherwise this reaches the live local daemon.
    _probeDaemonHealth: async () => false,
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

// ── #751 TELEPTY_DAEMON_LIFECYCLE=external — explicit no-daemon-lifecycle safety mode ──
//
// Intent under test: when the operator states that something OTHER than this CLI owns the
// daemon's lifecycle, NO probe verdict may spawn, restart, repair, install, or mutate a
// lifecycle marker. Validation still runs in full (this is not a bare early return): a daemon
// verified healthy is allowed through with zero side effects, and every other verdict —
// unhealthy, unknown/unverified, version mismatch, capability mismatch — fails closed.
//
// Every lifecycle-capable seam below is an injected spy asserted to have ZERO calls, so a
// regression that reintroduces management is a test failure rather than a real process kill.

// All seams through which ensureDaemonRunning can mutate lifecycle state (spawn/restart a
// daemon, consult the port owner, defer to a supervisor, or write a marker file to disk).
function lifecycleSpies() {
  const calls = [];
  const spy = (name, result) => {
    const fn = (...args) => { calls.push({ name, args }); return result; };
    return fn;
  };
  return {
    calls,
    names: () => calls.map((c) => c.name),
    seams: {
      _restartDaemonGraceful: spy('restartDaemonGraceful', Promise.resolve({ success: true })),
      _findPortOwnerPid: spy('findPortOwnerPid', 0),
      _detectSupervisor: spy('detectSupervisor', { present: false, kind: null, detail: null }),
      _readRestartFailureMarker: spy('readRestartFailureMarker', null),
      _writeRestartFailureMarker: spy('writeRestartFailureMarker', undefined),
      _clearRestartFailureMarker: spy('clearRestartFailureMarker', undefined),
      _readSupervisorDeferMarker: spy('readSupervisorDeferMarker', null),
      _writeSupervisorDeferMarker: spy('writeSupervisorDeferMarker', undefined),
      _clearSupervisorDeferMarker: spy('clearSupervisorDeferMarker', undefined)
    }
  };
}

const EXTERNAL_ENV = { TELEPTY_DAEMON_LIFECYCLE: 'external' };

// Probe seams for a given scenario. Defaults are "nothing answered anywhere" so a test that
// forgets to override one cannot silently reach the live local daemon.
function probes({ meta = null, sessionsOk = false, healthOk = false } = {}) {
  return {
    _getDaemonMeta: async () => meta,
    _fetchWithAuth: sessionsOk ? okFetch() : timeoutFetch(),
    _probeDaemonHealth: async () => healthOk,
    _probe: { attempts: 2, backoffMs: 0 }
  };
}

// ── Mode resolution (pure; fail-closed) ────────────────────────────────────────

test('#751 resolveDaemonLifecycleMode: unset → managed (legacy behavior untouched)', () => {
  assert.equal(resolveDaemonLifecycleMode({}).mode, 'managed');
  assert.equal(resolveDaemonLifecycleMode({}).explicit, false);
});

test('#751 resolveDaemonLifecycleMode: external, case/whitespace tolerant', () => {
  assert.equal(resolveDaemonLifecycleMode({ TELEPTY_DAEMON_LIFECYCLE: 'external' }).mode, 'external');
  assert.equal(resolveDaemonLifecycleMode({ TELEPTY_DAEMON_LIFECYCLE: '  EXTERNAL  ' }).mode, 'external');
  assert.equal(resolveDaemonLifecycleMode({ TELEPTY_DAEMON_LIFECYCLE: 'managed' }).mode, 'managed');
});

test('#751 resolveDaemonLifecycleMode: unrecognized values are INVALID, never managed', () => {
  // The failure mode this guards: a typo or a truthy-looking value silently re-enabling
  // lifecycle management, which is the exact outcome the safety mode exists to prevent.
  for (const raw of ['externl', 'off', 'none', '1', '0', 'true', 'EXTERNAL=1', '', '   ']) {
    const resolved = resolveDaemonLifecycleMode({ TELEPTY_DAEMON_LIFECYCLE: raw });
    assert.equal(resolved.mode, 'invalid', `${JSON.stringify(raw)} must not resolve to a usable mode`);
    assert.notEqual(resolved.mode, 'managed', `${JSON.stringify(raw)} must not silently enable management`);
  }
});

test('#751 invalid mode → fails closed before ANY probe or lifecycle call', async () => {
  const spies = lifecycleSpies();
  let probed = 0;
  await assert.rejects(
    ensureDaemonRunning({
      requiredCapabilities: [CAP],
      _env: { TELEPTY_DAEMON_LIFECYCLE: 'externl' },
      _getDaemonMeta: async () => { probed += 1; return healthyMeta; },
      _fetchWithAuth: timeoutFetch(),
      _probeDaemonHealth: async () => false,
      _probe: { attempts: 1, backoffMs: 0 },
      ...spies.seams
    }),
    (error) => {
      assert.equal(error.name, 'DaemonLifecycleModeError');
      assert.ok(isDaemonLifecycleError(error), 'must be classifiable as a lifecycle-mode failure');
      return true;
    }
  );
  assert.equal(probed, 0, 'an unreadable mode must be rejected before probing anything');
  assert.deepEqual(spies.names(), [], 'no lifecycle seam may run for an invalid mode');
});

// ── external mode: the one allowed outcome ─────────────────────────────────────

test('#751 external + verified healthy daemon → ALLOWED with zero lifecycle side effects', async () => {
  const spies = lifecycleSpies();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _env: EXTERNAL_ENV,
    ...probes({ meta: healthyMeta }),
    ...spies.seams
  });
  assert.deepEqual(spies.names(), [], 'a verified healthy external daemon must be used as-is');
});

// ── external mode: every refusal path ─────────────────────────────────────────

// [scenario label, probe inputs, expected verdict recorded on the error]
const REFUSED_SCENARIOS = [
  ['version mismatch (daemon older)', { meta: { version: '0.0.1', capabilities: [CAP] }, sessionsOk: true }, 'version-daemon-older'],
  ['capability mismatch', { meta: { version: pkg.version, capabilities: [] }, sessionsOk: true }, 'capability-missing:' + CAP],
  ['legacy daemon (no /api/meta route)', { meta: null, sessionsOk: true }, 'legacy-daemon-no-meta'],
  ['unknown/unverified (alive on /api/health only)', { meta: null, sessionsOk: false, healthOk: true }, 'alive-but-slow'],
  ['absent (nothing answered anywhere)', { meta: null, sessionsOk: false, healthOk: false }, 'daemon-unreachable']
];

for (const [label, probeInput, expectedReason] of REFUSED_SCENARIOS) {
  test(`#751 external + ${label} → refuses, spawns/restarts NOTHING`, async () => {
    const spies = lifecycleSpies();
    await assert.rejects(
      ensureDaemonRunning({
        requiredCapabilities: [CAP],
        _env: EXTERNAL_ENV,
        ...probes(probeInput),
        ...spies.seams
      }),
      (error) => {
        assert.equal(error.name, 'DaemonLifecycleExternalError');
        assert.ok(isDaemonLifecycleError(error), 'must be classifiable as a lifecycle failure');
        assert.equal(error.mode, 'external');
        assert.equal(error.reason, expectedReason, 'the refusal must name the verdict it refused on');
        return true;
      }
    );
    assert.deepEqual(spies.names(), [], `no lifecycle seam may run for: ${label}`);
  });
}

test('#751 external + daemon REFUSES credentials (401) → auth check preserved, no restart', async () => {
  // The refusal/auth verdict keeps its own distinct error (#835): a daemon that declines us is
  // demonstrably running, and external mode must not reclassify that as a lifecycle problem.
  const spies = lifecycleSpies();
  await assert.rejects(
    ensureDaemonRunning({
      requiredCapabilities: [CAP],
      _env: EXTERNAL_ENV,
      ...probes({ meta: { answered: true, status: 401, refused: true, endpoint: '/api/meta' } }),
      ...spies.seams
    }),
    (error) => {
      assert.equal(error.name, 'DaemonResponseError', 'a refusal is an answer, not an absence');
      assert.equal(error.refused, true);
      return true;
    }
  );
  assert.deepEqual(spies.names(), [], 'a refusing daemon must never be killed or replaced');
});

test('#751 external + daemon newer than CLI → allowed (newer-wins preserved, no clobber)', async () => {
  const spies = lifecycleSpies();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _env: EXTERNAL_ENV,
    ...probes({ meta: { version: '999.0.0', capabilities: [CAP] } }),
    ...spies.seams
  });
  assert.deepEqual(spies.names(), [], 'a newer external daemon must be left strictly alone');
});

test('#751 external refusal error is BOUNDED (hostile daemon cannot inflate the message)', async () => {
  const spies = lifecycleSpies();
  await assert.rejects(
    ensureDaemonRunning({
      requiredCapabilities: [CAP],
      _env: EXTERNAL_ENV,
      // Non-semver so it reaches the mismatch verdict, and absurdly long so an unbounded
      // interpolation would show up as a multi-kilobyte error message.
      ...probes({ meta: { version: `9z${'A'.repeat(20000)}`, capabilities: [CAP] }, sessionsOk: true }),
      ...spies.seams
    }),
    (error) => {
      assert.equal(error.name, 'DaemonLifecycleExternalError');
      assert.ok(error.message.length < 600, `error message must stay bounded, got ${error.message.length}`);
      return true;
    }
  );
  assert.deepEqual(spies.names(), [], 'no lifecycle seam may run on a hostile version string');
});

// A refusal is rendered as ONE line by the top-level catch, so neither untrusted string may carry
// a newline (forges a second line of CLI output) or an ESC byte (emits arbitrary ANSI).
const HOSTILE = '\x1b[31m\x1b[2K\nFATAL: daemon deleted\r\x07\x9b31m\x00';

function assertOneLineSafe(message) {
  assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(message), 'no control/ANSI bytes may survive');
  assert.equal(message.split('\n').length, 1, 'refusal must stay a single line');
  assert.ok(message.length < 600, `must stay bounded, got ${message.length}`);
}

test('#751 external + multiline/ANSI hostile daemon version → refusal stays one safe line', async () => {
  const spies = lifecycleSpies();
  await assert.rejects(
    ensureDaemonRunning({
      requiredCapabilities: [CAP],
      _env: EXTERNAL_ENV,
      // Non-semver, so it reaches the mismatch verdict with the hostile string in hand.
      ...probes({ meta: { version: `9z${HOSTILE}`, capabilities: [CAP] }, sessionsOk: true }),
      ...spies.seams
    }),
    (error) => {
      assert.equal(error.name, 'DaemonLifecycleExternalError');
      assertOneLineSafe(error.message);
      return true;
    }
  );
  assert.deepEqual(spies.names(), [], 'no lifecycle seam may run on a hostile version string');
});

test('#751 multiline/ANSI hostile mode value → invalid, refusal stays one safe line', async () => {
  const spies = lifecycleSpies();
  await assert.rejects(
    ensureDaemonRunning({
      requiredCapabilities: [CAP],
      _env: { TELEPTY_DAEMON_LIFECYCLE: `external${HOSTILE}` }, // must NOT resolve to external
      ...probes({ meta: healthyMeta }),
      ...spies.seams
    }),
    (error) => {
      assert.equal(error.name, 'DaemonLifecycleModeError');
      assertOneLineSafe(error.message);
      assertOneLineSafe(error.raw);
      return true;
    }
  );
  assert.deepEqual(spies.names(), [], 'no lifecycle seam may run for a hostile mode value');
});

test('#751 hostile mode value does not smuggle itself past mode resolution', () => {
  // trim() strips the trailing \n but not an interior one, so this must land on INVALID —
  // never on external (a forged safety mode) and never on managed (silent management).
  const resolved = resolveDaemonLifecycleMode({ TELEPTY_DAEMON_LIFECYCLE: `external${HOSTILE}` });
  assert.equal(resolved.mode, 'invalid');
});

// ── legacy (mode unset): positive behavior must be bit-for-bit unchanged ───────

test('#751 legacy unset: version mismatch STILL restarts (safety mode is opt-in only)', async () => {
  const restart = recordingRestart();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _env: {}, // mode explicitly unset
    _getDaemonMeta: async () => ({ version: '0.0.1', capabilities: [CAP] }),
    _fetchWithAuth: okFetch(),
    _findPortOwnerPid: () => 0,
    _readRestartFailureMarker: () => null,
    _writeRestartFailureMarker: () => {},
    _clearRestartFailureMarker: () => {},
    _restartDaemonGraceful: restart,
    _probe: { attempts: 2, backoffMs: 0 }
  });
  assert.equal(restart.calls.length, 1, 'legacy managed mode must keep restarting on mismatch');
});

test('#751 legacy unset: absent daemon STILL auto-starts', async () => {
  const restart = recordingRestart();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _env: {},
    _getDaemonMeta: async () => null,
    _detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    _fetchWithAuth: timeoutFetch(),
    _probeDaemonHealth: async () => false,
    _findPortOwnerPid: () => 0,
    _readRestartFailureMarker: () => null,
    _writeRestartFailureMarker: () => {},
    _clearRestartFailureMarker: () => {},
    _restartDaemonGraceful: restart,
    _probe: { attempts: 2, backoffMs: 0 }
  });
  assert.equal(restart.calls.length, 1, 'legacy managed mode must keep auto-starting an absent daemon');
});

test('#751 legacy unset: healthy daemon still noops (no new error path on the happy case)', async () => {
  const restart = recordingRestart();
  await ensureDaemonRunning({
    requiredCapabilities: [CAP],
    _env: {},
    ...probes({ meta: healthyMeta }),
    _restartDaemonGraceful: restart
  });
  assert.equal(restart.calls.length, 0, 'a healthy daemon must not be touched in either mode');
});
