'use strict';

// #844 — two places where a daemon ANSWER was thrown away or mis-named, and both verdicts route
// into `cleanupDaemonProcesses()` → SIGTERM/SIGKILL against the process that parents every live
// PTY session. Same defect class as the refused-owner-claim blocker, one layer out.
//
// ── `cli.js` decideDaemonAction: a 404 is not "running, but not serving" ────────────────
// `getDaemonMeta` classifies every non-2xx as `answered`, and `decideDaemonAction` aborts on any
// `answered` meta with a message stating a cause it did not determine. But a **404 on
// `/api/meta`** means the ROUTE does not exist — `/api/meta` was added 2026-03-12, so a daemon
// predating it answers 404 for exactly the reason it answers 200 on `/api/sessions`. That is the
// legacy-daemon case the `sessionsReachable` probe exists to name, and calling it a failure kills
// the upgrade path outright: `telepty list` against an old daemon dies with "running, but not
// serving". It also falsifies `CHANGELOG.md` "a new client against an old daemon works".
//
// Scoped to the endpoint, deliberately: a 404 from `/api/sessions` is NOT the same statement, and
// a 401/403/5xx from `/api/meta` still aborts. The rule is only that a missing route is a missing
// route.
//
// ── `cli.js` deferToSupervisor: the third consumer that never learned #835 ──────────────
// `getDaemonMeta` has three consumers. #835 taught two of them that a non-200 is an ANSWER
// (`waitForDaemonHealth`'s `if (meta && meta.refused) return meta`, and the legacy probe inside
// `ensureDaemonRunning`) and left this one byte-identical to baseline: its poll loop accepts only
// `meta.version`. So a daemon that came back and REFUSED our credentials was reported as *"the
// supervisor did not restore it in time"* — and that verdict spawns/kills. A daemon that answers
// 401 is ALIVE; it is the one thing that must not be killed.
//
// Every seam is injected. No daemon is started, no socket is opened, no process is signalled.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pkg = require('../package.json');
const { decideDaemonAction, deferToSupervisor, ensureDaemonRunning } = require('../cli');

// The shape `getDaemonMeta` returns for a non-2xx (cli.js daemonAnswer). Deliberately spelled out
// rather than imported: this is the wire fact the policy is fed, and it should be readable here.
const answer = (status, endpoint = '/api/meta') => ({
  answered: true, status, refused: status === 401 || status === 403, endpoint
});

const supervisorPresent = () => ({ present: true, kind: 'launchd', detail: '/tmp/plist' });

function recordingRestart() {
  const calls = [];
  const fn = async (opts) => { calls.push(opts || {}); return { success: true }; };
  fn.calls = calls;
  return fn;
}

// Silence the stderr banners `ensureDaemonRunning` / `deferToSupervisor` write; the assertions
// are on decisions, not on wording, and a test run should not look like a daemon fault.
function quietStderr(run) {
  const original = process.stderr.write;
  process.stderr.write = () => true;
  return Promise.resolve().then(run).finally(() => { process.stderr.write = original; });
}

// ── decideDaemonAction: 404 on /api/meta is a legacy daemon, not a broken one ───────────

test('404 on /api/meta + sessions reachable → the legacy-daemon restart, not an abort', () => {
  const d = decideDaemonAction({
    meta: answer(404), requiredCapabilities: [], cliVersion: pkg.version, sessionsReachable: true
  });
  assert.equal(d.action, 'restart',
    'a daemon that predates /api/meta is the exact case `legacy-daemon-no-meta` exists for');
  assert.equal(d.reason, 'legacy-daemon-no-meta');
});

test('404 on /api/meta + nothing else answering → start, i.e. the pre-#835 verdict', () => {
  const d = decideDaemonAction({
    meta: answer(404), requiredCapabilities: [], cliVersion: pkg.version, sessionsReachable: false
  });
  assert.equal(d.action, 'start');
  assert.equal(d.reason, 'daemon-unreachable');
});

test('401 on /api/meta still aborts — a refusal is an answer and the daemon is alive', () => {
  const d = decideDaemonAction({
    meta: answer(401), requiredCapabilities: [], cliVersion: pkg.version, sessionsReachable: false
  });
  assert.equal(d.action, 'abort');
  assert.equal(d.reason, 'daemon-refused:401');
});

test('500 on /api/meta still aborts — answering and failing is not a missing route', () => {
  const d = decideDaemonAction({
    meta: answer(500), requiredCapabilities: [], cliVersion: pkg.version, sessionsReachable: true
  });
  assert.equal(d.action, 'abort');
  assert.equal(d.reason, 'daemon-answered-error:500');
});

test('404 on /api/sessions still aborts — the exemption is scoped to the route that was added', () => {
  // `ensureDaemonRunning` can classify the legacy probe itself. A daemon whose /api/sessions is
  // 404 is not a daemon this CLI understands, and inventing "old daemon" from it would be the
  // same over-reach in the other direction.
  const d = decideDaemonAction({
    meta: answer(404, '/api/sessions'), requiredCapabilities: [], cliVersion: pkg.version, sessionsReachable: false
  });
  assert.equal(d.action, 'abort');
  assert.equal(d.reason, 'daemon-answered-error:404');
});

test('ensureDaemonRunning: an old daemon is upgraded, not declared broken', async () => {
  const doRestart = recordingRestart();
  await quietStderr(() => ensureDaemonRunning({
    _getDaemonMeta: async () => answer(404),
    _fetchWithAuth: async () => ({ ok: true, json: async () => [] }),
    _restartDaemonGraceful: doRestart,
    _findPortOwnerPid: () => 0,
    _readRestartFailureMarker: () => null,
    _writeRestartFailureMarker: () => {},
    _clearRestartFailureMarker: () => {},
    _detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    _probe: { attempts: 1, backoffMs: 0 }
  }));
  assert.equal(doRestart.calls.length, 1,
    'the legacy-upgrade path must run — this is the CHANGELOG claim that a new client against an '
    + 'old daemon works');
});

// ── deferToSupervisor: an answer is the supervisor having delivered ─────────────────────

test('deferToSupervisor: a daemon that came back REFUSING is delivered, not declared missing', async () => {
  const refusal = answer(401);
  let markerWritten = null;
  const result = await quietStderr(() => deferToSupervisor({
    _detectSupervisor: supervisorPresent,
    _getDaemonMeta: async () => refusal,
    _readSupervisorDeferMarker: () => null,
    _writeSupervisorDeferMarker: (m) => { markerWritten = m; },
    _clearSupervisorDeferMarker: () => {},
    supervisorWaitMs: 400,
    supervisorPollMs: 20
  }));
  assert.deepEqual(result, refusal,
    'a daemon answering 401 is ALIVE; reporting it as "the supervisor did not restore it in time" '
    + 'is what routes a live daemon into cleanupDaemonProcesses()');
  assert.equal(markerWritten, null, 'the supervisor DID deliver — do not record a failure against it');
});

test('deferToSupervisor: an old daemon (404 on /api/meta) is delivered too', async () => {
  const legacy = answer(404);
  const result = await quietStderr(() => deferToSupervisor({
    _detectSupervisor: supervisorPresent,
    _getDaemonMeta: async () => legacy,
    _readSupervisorDeferMarker: () => null,
    _writeSupervisorDeferMarker: () => {},
    _clearSupervisorDeferMarker: () => {},
    supervisorWaitMs: 400,
    supervisorPollMs: 20
  }));
  assert.deepEqual(result, legacy);
});

test('deferToSupervisor: genuine silence is still a non-delivery — the #738 behaviour is intact', async () => {
  let markerWritten = null;
  const result = await quietStderr(() => deferToSupervisor({
    _detectSupervisor: supervisorPresent,
    _getDaemonMeta: async () => null,
    _readSupervisorDeferMarker: () => null,
    _writeSupervisorDeferMarker: (m) => { markerWritten = m; },
    _clearSupervisorDeferMarker: () => {},
    supervisorWaitMs: 200,
    supervisorPollMs: 20
  }));
  assert.equal(result, null, 'nothing answered → fall through to the pre-#738 spawn path');
  assert.ok(markerWritten, 'and record the non-delivery so every command does not pay the full wait');
});

test('ensureDaemonRunning: a refusal reached through the supervisor path never becomes a restart', async () => {
  // The whole chain: nothing answers at first (→ action 'start'), the supervisor brings a daemon
  // back, and that daemon REFUSES us. Before this change the refusal was discarded twice — once
  // by the poll loop, once by the caller not re-checking `abort` after re-deciding — and the CLI
  // proceeded to kill the daemon it had just heard from.
  const doRestart = recordingRestart();
  let probes = 0;
  await quietStderr(async () => {
    await assert.rejects(
      ensureDaemonRunning({
        _getDaemonMeta: async () => (probes++ === 0 ? null : answer(401)),
        _fetchWithAuth: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
        _restartDaemonGraceful: doRestart,
        _findPortOwnerPid: () => 0,
        _readRestartFailureMarker: () => null,
        _writeRestartFailureMarker: () => {},
        _clearRestartFailureMarker: () => {},
        _detectSupervisor: supervisorPresent,
        _readSupervisorDeferMarker: () => null,
        _writeSupervisorDeferMarker: () => {},
        _clearSupervisorDeferMarker: () => {},
        supervisorWaitMs: 400,
        supervisorPollMs: 20,
        _probe: { attempts: 1, backoffMs: 0 }
      }),
      (error) => {
        assert.equal(error.name, 'DaemonResponseError');
        assert.equal(error.refused, true);
        return true;
      }
    );
  });
  assert.equal(doRestart.calls.length, 0,
    'a daemon that answered and refused must never be restarted — it is alive and owns every session');
});
