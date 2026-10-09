'use strict';

// gh#82 follow-up, round 2 (2026-10-09 RCA §0/§Q4/§Q5) — the gaps that let the 10:29 KST kill
// happen even with the three asks implemented.
//
//   (a) On loopback a connect to a port with no listener is REFUSED at once; a TIMEOUT means
//       something accepted or queued the connection. So a timeout is never an absence verdict,
//       and must never lead to a stop on ANY path — only ECONNREFUSED (and no LISTEN owner) may.
//   (b) A legacy daemon is identified by a 404 on /api/meta (#844's shape), never by a meta
//       TIMEOUT with /api/sessions 200 — that is the slow-daemon shape, and it was an unguarded
//       restart (`legacy-daemon-no-meta`, absenceVerdict false).
//   (c) The fail-fast / supervisor rule covers every caller that would stop the daemon: the start
//       verdict, legacy, version/capability, and repairLocalDaemon — not only the start path.
//   (d) discoverSessions must not turn a local /api/sessions timeout into "no local sessions",
//       which `inject` then printed as "session … was not found on any discovered host".
//
// SAFETY: in-process only. Every stop, spawn, kickstart, probe and fetch is an injected seam, so a
// red run OBSERVES the stop in a recorder and never delivers one. setup-env.js gives this process
// its own HOME (lease, markers, logs are temp files).

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');
const cli = require('../cli');
const { decideDaemonAction, ensureDaemonRunning, restartDaemonGraceful } = cli;

const PORT = 51823; // never the live daemon's port
const CLI_PORT = Number(process.env.TELEPTY_PORT || 3848); // what repairLocalDaemon addresses
const CAP = 'wrapped-sessions';

const noSupervisor = () => ({ present: false, kind: null, detail: null });
const launchd = () => ({ present: true, kind: 'launchd', detail: '/fake.plist' });

const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const refusedError = () => Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });

function recordingRestart() {
  const calls = [];
  const fn = async (opts) => { calls.push(opts || {}); return { success: true }; };
  fn.calls = calls;
  return fn;
}

function recordingCleanup() {
  const calls = [];
  const fn = (opts) => { calls.push(opts || {}); return { stopped: [], failed: [] }; };
  fn.calls = calls;
  return fn;
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

function ensureSeams(extra = {}) {
  return {
    port: PORT,
    _supervisedPort: () => PORT,
    _probe: { attempts: 3, backoffMs: 0 },
    supervisorWaitMs: 40,
    supervisorPollMs: 10,
    _detectSupervisor: noSupervisor,
    _findPortOwnerPid: () => null,
    _readRestartFailureMarker: () => null,
    _writeRestartFailureMarker: () => {},
    _clearRestartFailureMarker: () => {},
    _readSupervisorDeferMarker: () => null,
    _writeSupervisorDeferMarker: () => {},
    _clearSupervisorDeferMarker: () => {},
    ...extra
  };
}

function restartSeams(extra = {}) {
  return {
    maxAttempts: 1,
    port: PORT,
    absenceVerdict: true,
    verdict: 'daemon-unreachable',
    _detectSupervisor: noSupervisor,
    _startDetachedDaemon: () => {},
    _waitForDaemonHealth: async () => null,
    _findPortOwnerPid: () => null,
    _findParentProcessInfo: () => null,
    _logDaemonRestartEvent: () => {},
    ...extra
  };
}

// ── (b) legacy is a 404, not a timeout ──────────────────────────────────────────

test('R1 (b): meta TIMED OUT ×3 + /api/sessions 200 ⇒ the restart path is never entered', async () => {
  const doRestart = recordingRestart();
  const { text } = await captureStderr(() => ensureDaemonRunning(ensureSeams({
    _getDaemonMeta: async () => null, // /api/meta timed out on every attempt (not a 404)
    _fetchWithAuth: async () => ({ ok: true, json: async () => [] }), // /api/sessions answered 200
    _probeDaemonHealth: async () => true,
    _restartDaemonGraceful: doRestart
  })));
  assert.equal(doRestart.calls.length, 0, 'a daemon that answered /api/sessions was killed as "legacy" — 10:29 KST');
  assert.match(text, /alive, only slow/i);
});

test('R1 (b) pure: meta null + sessions reachable is alive-but-slow; only a /api/meta 404 is legacy', () => {
  const slow = decideDaemonAction({ meta: null, cliVersion: pkg.version, sessionsReachable: true });
  assert.equal(slow.action, 'noop');
  assert.equal(slow.reason, 'alive-but-slow');
  const legacy = decideDaemonAction({
    meta: { answered: true, status: 404, refused: false, endpoint: '/api/meta' },
    cliVersion: pkg.version,
    sessionsReachable: true
  });
  assert.equal(legacy.action, 'restart');
  assert.equal(legacy.reason, 'legacy-daemon-no-meta');
});

// ── (a) a timeout is never an absence verdict ───────────────────────────────────

test('(a) pure: nothing answered but nothing REFUSED ⇒ not `start`', () => {
  const d = decideDaemonAction({ meta: null, cliVersion: pkg.version, sessionsReachable: false, healthOk: false });
  assert.notEqual(d.action, 'start', 'a verdict reached by timeouts alone authorizes a kill');
  assert.equal(d.action, 'noop');
  assert.equal(d.reason, 'not-answering');
  const absent = decideDaemonAction({ meta: null, cliVersion: pkg.version, sessionsReachable: false, healthOk: false, connectionRefused: true });
  assert.equal(absent.action, 'start', 'a refused loopback connection is still the one legitimate absence');
});

test('(a) ensureDaemonRunning: every probe TIMED OUT ⇒ no restart, and the stall is named', async () => {
  const doRestart = recordingRestart();
  const { result, text } = await captureStderr(() => ensureDaemonRunning(ensureSeams({
    _getDaemonMeta: async () => null,
    _fetchWithAuth: async () => { throw timeoutError(); },
    _probeDaemonHealth: async () => null, // timed out (false would mean refused)
    _restartDaemonGraceful: doRestart
  })));
  assert.equal(doRestart.calls.length, 0, 'a daemon that only timed out was restarted');
  assert.equal(result && result.success, false);
  assert.match(text, /did not answer/i);
  assert.match(text, /not restarting/i);
});

test('(a) ensureDaemonRunning: sessions TIMED OUT, health refused ⇒ still no restart (no refusal on the probe that timed out)', async () => {
  const doRestart = recordingRestart();
  await captureStderr(() => ensureDaemonRunning(ensureSeams({
    _getDaemonMeta: async () => null,
    _fetchWithAuth: async () => { throw timeoutError(); },
    _probeDaemonHealth: async () => false,
    _restartDaemonGraceful: doRestart
  })));
  assert.equal(doRestart.calls.length, 0);
});

test('(a) control: sessions REFUSED + health refused ⇒ the absent daemon is still auto-started', async () => {
  const doRestart = recordingRestart();
  await captureStderr(() => ensureDaemonRunning(ensureSeams({
    _getDaemonMeta: async () => null,
    _fetchWithAuth: async () => { throw refusedError(); },
    _probeDaemonHealth: async () => false,
    _restartDaemonGraceful: doRestart
  })));
  assert.equal(doRestart.calls.length, 1);
  assert.equal(doRestart.calls[0].absenceVerdict, true);
});

test('R2 (a): absence verdict, health silent, but a LISTEN socket holds the port ⇒ no stop', async () => {
  const cleanup = recordingCleanup();
  const { result } = await captureStderr(() => restartDaemonGraceful(restartSeams({
    _probeDaemonHealth: async () => false,
    _findPortOwnerPid: () => 4242, // a listener exists on the addressed port
    _cleanupDaemonProcesses: cleanup
  })));
  assert.equal(cleanup.calls.length, 0, 'stopped the port owner after a TIMEOUT, not a refusal');
  assert.equal(result.success, false);
});

test('(a) restartDaemonGraceful: absence verdict + health TIMED OUT (null) ⇒ no stop', async () => {
  const cleanup = recordingCleanup();
  await captureStderr(() => restartDaemonGraceful(restartSeams({
    _probeDaemonHealth: async () => null,
    _cleanupDaemonProcesses: cleanup
  })));
  assert.equal(cleanup.calls.length, 0, 'a health TIMEOUT is not evidence of absence');
});

test('(a) restartDaemonGraceful: a retry never stops a daemon that is listening but slow', async () => {
  // attempt 1: stop (deliberate replacement), spawn, the new daemon does not answer in time
  // (waitHealth timed out). Attempt 2 used to SIGTERM it again — a timeout-driven kill.
  const cleanup = recordingCleanup();
  let ownerCalls = 0;
  await captureStderr(() => restartDaemonGraceful(restartSeams({
    maxAttempts: 2,
    absenceVerdict: false,
    verdict: 'version-cli-newer',
    _cleanupDaemonProcesses: cleanup,
    // first lookup = attempt 1's post-stop check (nothing yet); later = the spawned daemon listening
    _findPortOwnerPid: () => (++ownerCalls === 1 ? null : 5151)
  })));
  assert.equal(cleanup.calls.length, 1, 'attempt 2 stopped a daemon whose only fault was a health timeout');
});

// ── (c) the supervisor / fail-fast rule covers every caller ─────────────────────

for (const [label, meta, sessions] of [
  ['version mismatch', { version: '0.0.1', capabilities: [CAP] }, { ok: true, json: async () => [] }],
  ['capability missing', { version: pkg.version, capabilities: [] }, { ok: true, json: async () => [] }],
  ['legacy (404 on /api/meta)', { answered: true, status: 404, refused: false, endpoint: '/api/meta' }, { ok: true, json: async () => [] }]
]) {
  test(`(c) supervisor owns the port + ${label} ⇒ no client stop; the supervisor command is named`, async () => {
    const doRestart = recordingRestart();
    const { result, text } = await captureStderr(() => ensureDaemonRunning(ensureSeams({
      requiredCapabilities: [CAP],
      _detectSupervisor: launchd,
      _getDaemonMeta: async () => meta,
      _fetchWithAuth: async () => sessions,
      _probeDaemonHealth: async () => true,
      _restartDaemonGraceful: doRestart
    })));
    assert.equal(doRestart.calls.length, 0, `a supervised daemon was stopped by a client (${label})`);
    assert.equal(result && result.success, false);
    assert.match(text, /launchctl kickstart -k gui\/\S+\/com\.aigentry\.telepty/);
  });
}

test('(c) repairLocalDaemon: supervisor owns the port ⇒ no stop, no restart; names the command', async () => {
  assert.equal(typeof cli.repairLocalDaemon, 'function', 'repairLocalDaemon must be reachable through its seams');
  const stops = recordingCleanup();
  const doRestart = recordingRestart();
  const { result, text } = await captureStderr(() => cli.repairLocalDaemon({
    restart: true,
    _detectSupervisor: launchd,
    _supervisedPort: () => CLI_PORT,
    _stopDaemon: stops,
    _restartDaemonGraceful: doRestart
  }));
  assert.equal(stops.calls.length, 0, 'telepty update/repair SIGTERMed a supervised daemon');
  assert.equal(doRestart.calls.length, 0);
  assert.notEqual(result.versionMatch, true, 'must not claim the daemon was replaced');
  assert.match(text, /launchctl kickstart -k gui\/\S+\/com\.aigentry\.telepty/);
});

test('(c) repairLocalDaemon: TELEPTY_CLIENT_RESTART=off ⇒ no stop even without a supervisor', async () => {
  assert.equal(typeof cli.repairLocalDaemon, 'function');
  const original = process.env.TELEPTY_CLIENT_RESTART;
  process.env.TELEPTY_CLIENT_RESTART = 'off';
  const stops = recordingCleanup();
  const doRestart = recordingRestart();
  try {
    const { text } = await captureStderr(() => cli.repairLocalDaemon({
      restart: true,
      _detectSupervisor: noSupervisor,
      _stopDaemon: stops,
      _restartDaemonGraceful: doRestart
    }));
    assert.equal(stops.calls.length + doRestart.calls.length, 0);
    assert.match(text, /TELEPTY_CLIENT_RESTART/);
  } finally {
    if (original === undefined) delete process.env.TELEPTY_CLIENT_RESTART;
    else process.env.TELEPTY_CLIENT_RESTART = original;
  }
});

test('(c) control: repairLocalDaemon on an unsupervised host still stops and restarts', async () => {
  assert.equal(typeof cli.repairLocalDaemon, 'function');
  const stops = recordingCleanup();
  const doRestart = recordingRestart();
  const result = await cli.repairLocalDaemon({
    restart: true,
    _detectSupervisor: noSupervisor,
    _stopDaemon: stops,
    _restartDaemonGraceful: doRestart
  });
  assert.equal(stops.calls.length, 1);
  assert.equal(stops.calls[0].port, CLI_PORT);
  assert.equal(doRestart.calls.length, 1);
  assert.equal(result.versionMatch, true);
});

// ── (d) a local timeout is reported as a timeout ───────────────────────────────

test('(d) discoverSessions: local /api/sessions TIMED OUT ⇒ the command fails naming the timeout, not "no sessions"', async () => {
  assert.equal(typeof cli.discoverSessions, 'function', 'discoverSessions must be reachable through its seams');
  await assert.rejects(
    cli.discoverSessions({
      silent: true,
      _ensureDaemonRunning: async () => {},
      _fetchWithAuth: async () => { throw timeoutError(); }
    }),
    (error) => {
      assert.match(error.message, /did not answer/i);
      assert.doesNotMatch(error.message, /not found/i);
      return true;
    }
  );
});

test('(d) control: local /api/sessions REFUSED ⇒ an empty local list is still honest', async () => {
  assert.equal(typeof cli.discoverSessions, 'function');
  const sessions = await cli.discoverSessions({
    silent: true,
    _ensureDaemonRunning: async () => {},
    _fetchWithAuth: async () => { throw refusedError(); }
  });
  assert.deepEqual(sessions.filter((s) => s.host === '127.0.0.1'), []);
});
