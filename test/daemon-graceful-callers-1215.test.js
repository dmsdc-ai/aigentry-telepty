'use strict';

// Task 1215 W3 — every NORMAL Windows stop/restart caller goes through the authenticated exact-instance graceful
// gate (src/daemon-shutdown.js via cli.js gracefulWindowsStop), and a replacement starts only after a confirmed
// clean stop (or when no daemon was running). Covered here, all through injected seams (nothing is killed,
// spawned, kickstarted or scheduled; no daemon is started):
//   C5 automatic restart (restartDaemonGraceful → restartDaemonUnderLease), unsupervised and schtasks-supervised
//   C6 repairLocalDaemon (interactive update / repair-daemon)
//   C3/C4 scheduled-task `daemon stop|restart` and `service stop|restart` (scheduledTaskGracefulVerb)
//   F4 strict principal mode: the signed operator `daemon.stop` action through the REAL HTTP app + REAL auth
//      middleware + REAL principal verifier + REAL stop handler on a loopback listener (shutdown() replaced only
//      by a counting callback), and the client's signing of the identity read and the stop.
// Gate outcomes are produced by the REAL decideStopOutcome. Native Windows behaviour (an installed task, a real
// daemon exit and lock release) is NOT measured here; it needs native Windows CI.
// "PRECONDITION:" assertions validate setup (failure = INVALID, not product RED).

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const pkg = require('../package.json');
const cli = require('../cli');
const { DEFAULT_PORT } = require('../daemon-control');
const shutdownModule = require('../src/daemon-shutdown');
const { decideStopOutcome, requestGracefulStop, createGracefulStopHandler, STOP_PATH } = shutdownModule;
const { SERVICE_EXIT } = require('../src/service');

const PID = 4242;
const INSTANCE = shutdownModule.newInstanceId();
const TOKEN = 'local-admin-token-fixture-1215-callers';

const OUTCOMES = {
  stopped: decideStopOutcome({ status: 'stopped', pid: PID, lockRetained: false }),
  none: decideStopOutcome({ status: 'no_answer' }, []),
  lockRetained: decideStopOutcome({ status: 'stopped', pid: PID, lockRetained: true }),
  timeout: decideStopOutcome({ status: 'timeout', pid: PID, exited: false }),
  refused: decideStopOutcome({ status: 'refused', pid: PID, code: 'STOP_AUTH_REQUIRED', httpStatus: 401 }),
  unknown: decideStopOutcome({ status: 'unknown', pid: PID, reason: 'stop_request_failed' }),
  unsupported: decideStopOutcome({ status: 'unsupported', pid: PID, reason: 'daemon_without_graceful_stop' }),
  unidentified: decideStopOutcome({ status: 'unidentified', reason: 'principal_client_unavailable' }),
  silentButPresent: decideStopOutcome({ status: 'no_answer' }, [{ pid: PID }]),
};
const CONFIRMED = ['stopped', 'none'];
const UNCONFIRMED = ['lockRetained', 'timeout', 'refused', 'unknown', 'unsupported', 'unidentified', 'silentButPresent'];

function recorder() {
  const events = [];
  const fn = (name, ret) => (...args) => { events.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };
  return { events, fn, names: () => events.map((e) => e[0]) };
}
async function quiet(fn) {
  const write = process.stderr.write.bind(process.stderr);
  const error = console.error;
  process.stderr.write = () => true;
  console.error = () => {};
  try { return await fn(); } finally { process.stderr.write = write; console.error = error; }
}
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-callers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('PRECONDITION: the real gate authorizes a replacement only for a confirmed clean stop or no daemon', () => {
  for (const k of CONFIRMED) assert.equal(OUTCOMES[k].startReplacement, true, k);
  for (const k of UNCONFIRMED) assert.deepEqual([OUTCOMES[k].ok, OUTCOMES[k].startReplacement], [false, false], k);
});

test('W3 normal stop mode: graceful on win32 only; POSIX keeps its signal stop', () => {
  assert.deepEqual(['win32', 'linux', 'darwin'].map((p) => cli.normalStopMode(p)), ['graceful', 'signal', 'signal']);
});

// ---- C5: automatic restart --------------------------------------------------------------------------------
function autoSeams(t, r, outcome, extra = {}) {
  const health = extra.health || [{ version: pkg.version, capabilities: [] }];
  let h = 0;
  return {
    maxAttempts: 1, port: 51831, verdict: 'version-mismatch', absenceVerdict: false,
    _platform: 'win32',
    _restartLeasePath: path.join(tempDir(t), 'restart.lease'),
    _gracefulStop: r.fn('graceful', async () => outcome),
    // Task 1215 W3 (R2): the signal-stop IMPLEMENTATION seam (taskkill /F on win32). It does not change the mode, so
    // these cases exercise the production selector; on win32 it must never be called.
    _signalStop: r.fn('signal-stop', { stopped: [{ pid: PID }], failed: [] }),
    _startDetachedDaemon: r.fn('start', undefined),
    _restartSupervisorDaemon: r.fn('kickstart', { success: true }),
    _detectSupervisor: () => ({ present: false }),
    _waitForDaemonHealth: async () => health[Math.min(h++, health.length - 1)],
    _findPortOwnerPid: () => null,
    _findParentProcessInfo: () => null,
    _isProcessRunning: () => false,
    _probeDaemonHealth: async () => false,
    _logDaemonRestartEvent: () => {},
    ...extra.options,
  };
}

test('W3 C5 automatic restart on win32: a confirmed graceful stop precedes the replacement; no forced cleanup', async (t) => {
  for (const k of CONFIRMED) {
    const r = recorder();
    const result = await quiet(() => cli.restartDaemonGraceful(autoSeams(t, r, OUTCOMES[k])));
    assert.deepEqual({ k, success: result.success, events: r.names(), port: r.events[0][1] },
      { k, success: true, events: ['graceful', 'start'], port: 51831 });
  }
});

test('W3 C5 automatic restart on win32: refused / timeout / uncertain stop ⇒ failure, nothing forced, nothing started', async (t) => {
  for (const k of UNCONFIRMED) {
    const r = recorder();
    const result = await quiet(() => cli.restartDaemonGraceful(autoSeams(t, r, OUTCOMES[k])));
    assert.deepEqual({ k, success: result.success, unconfirmed: result.gracefulStopUnconfirmed, events: r.names() },
      { k, success: false, unconfirmed: true, events: ['graceful'] });
    assert.equal(result.diagnostic, OUTCOMES[k].message);
  }
});

test('W3 C5 automatic restart, schtasks-supervised: kickstart (schtasks /run) only after a confirmed graceful stop', async (t) => {
  const supervised = { _detectSupervisor: () => ({ present: true, kind: 'schtasks', detail: 'telepty-daemon' }), _supervisedPort: () => 51831 };
  const ok = recorder();
  const okResult = await quiet(() => cli.restartDaemonGraceful(autoSeams(t, ok, OUTCOMES.stopped,
    { options: supervised, health: [null, { version: pkg.version, capabilities: [] }] })));
  assert.deepEqual({ success: okResult.success, events: ok.names() }, { success: true, events: ['graceful', 'kickstart'] });
  for (const k of UNCONFIRMED) {
    const r = recorder();
    const result = await quiet(() => cli.restartDaemonGraceful(autoSeams(t, r, OUTCOMES[k], { options: supervised })));
    assert.deepEqual({ k, success: result.success, events: r.names() }, { k, success: false, events: ['graceful'] });
  }
});

test('W3 seam rule: an injected stop seam still replaces the stop step (frozen restart-lease/757 tests keep their meaning)', async (t) => {
  const r = recorder();
  const seams = autoSeams(t, r, OUTCOMES.stopped);
  seams._cleanupDaemonProcesses = r.fn('legacy-seam', { stopped: [{ pid: PID }], failed: [] });   // even with _gracefulStop present
  const result = await quiet(() => cli.restartDaemonGraceful(seams));
  assert.deepEqual({ success: result.success, events: r.names() }, { success: true, events: ['legacy-seam', 'start'] });
});

test('W3 R2 C5: the platform, not an injected implementation, selects the stop: POSIX keeps its signal stop even with _gracefulStop present', async (t) => {
  for (const platform of ['linux', 'darwin']) {
    const r = recorder();
    const result = await quiet(() => cli.restartDaemonGraceful({ ...autoSeams(t, r, OUTCOMES.stopped), _platform: platform }));
    assert.deepEqual({ platform, success: result.success, events: r.names() }, { platform, success: true, events: ['signal-stop', 'start'] });
  }
});

// ---- C6: repair / update ----------------------------------------------------------------------------------
async function withClientRestartAuto(fn) {
  const saved = { mode: process.env.TELEPTY_CLIENT_RESTART, skip: process.env.TELEPTY_SKIP_DAEMON_REPAIR };
  process.env.TELEPTY_CLIENT_RESTART = 'auto';
  delete process.env.TELEPTY_SKIP_DAEMON_REPAIR;
  try { return await fn(); } finally {
    if (saved.mode === undefined) delete process.env.TELEPTY_CLIENT_RESTART; else process.env.TELEPTY_CLIENT_RESTART = saved.mode;
    if (saved.skip !== undefined) process.env.TELEPTY_SKIP_DAEMON_REPAIR = saved.skip;
  }
}
function repairSeams(r, outcome) {
  return {
    restart: true, _platform: 'win32', _detectSupervisor: () => ({ present: false }),
    _gracefulStop: r.fn('graceful', async () => outcome),
    _signalStop: r.fn('signal-stop', { stopped: [{ pid: PID }], failed: [] }),   // R2: implementation seam only
    _restartDaemonGraceful: r.fn('restart', async () => ({ success: true, meta: { version: pkg.version } })),
  };
}

test('W3 C6 repair/update on win32: restart only after a confirmed graceful stop; otherwise nothing forced or restarted', async () => {
  await withClientRestartAuto(async () => {
    for (const k of CONFIRMED) {
      const r = recorder();
      const result = await quiet(() => cli.repairLocalDaemon(repairSeams(r, OUTCOMES[k])));
      assert.deepEqual({ k, versionMatch: result.versionMatch, events: r.names() }, { k, versionMatch: true, events: ['graceful', 'restart'] });
    }
    for (const k of UNCONFIRMED) {
      const r = recorder();
      const result = await quiet(() => cli.repairLocalDaemon(repairSeams(r, OUTCOMES[k])));
      assert.deepEqual({ k, versionMatch: result.versionMatch, unconfirmed: result.gracefulStopUnconfirmed, events: r.names() },
        { k, versionMatch: false, unconfirmed: true, events: ['graceful'] });
      assert.equal(cli.updateRestartSucceeded(result), false, 'update must not report success');
    }
  });
});

test('W3 R2 C6 repair: POSIX keeps the signal stop and the legacy `_stopDaemon` seam still wins over the platform', async () => {
  await withClientRestartAuto(async () => {
    const posix = recorder();
    const p = await quiet(() => cli.repairLocalDaemon({ ...repairSeams(posix, OUTCOMES.stopped), _platform: 'linux' }));
    assert.deepEqual({ versionMatch: p.versionMatch, events: posix.names() }, { versionMatch: true, events: ['signal-stop', 'restart'] });
    const legacy = recorder();
    const l = await quiet(() => cli.repairLocalDaemon({ ...repairSeams(legacy, OUTCOMES.timeout), _stopDaemon: legacy.fn('legacy-seam', { stopped: [], failed: [] }) }));
    assert.deepEqual({ versionMatch: l.versionMatch, events: legacy.names() }, { versionMatch: true, events: ['legacy-seam', 'restart'] });
  });
});

// ---- C3/C4: installed scheduled task ----------------------------------------------------------------------
const END = ['schtasks', '/end', '/tn', 'telepty-daemon'];
const RUN = ['schtasks', '/run', '/tn', 'telepty-daemon'];
function serviceSeam(r, { kind = 'schtasks', previewExit = SERVICE_EXIT.OK } = {}) {
  return r.fn('service', async (verb, opts) => {
    if (opts && opts.dryRun) {
      return { ok: previewExit === SERVICE_EXIT.OK, verb, exitCode: previewExit, reason: previewExit === SERVICE_EXIT.OK ? 'dry-run' : 'ownership-unverified',
        steps: [], status: null, plan: { kind, commands: verb === 'restart' ? [END, RUN] : verb === 'stop' ? [END] : [RUN] }, manualCommands: [] };
    }
    return { ok: true, verb, exitCode: SERVICE_EXIT.OK, reason: null, verified: null, steps: [{ command: RUN.join(' '), ok: true, stderr: '' }],
      status: null, plan: { kind, commands: [RUN] }, manualCommands: [] };
  });
}
const calls = (r) => r.events.map(([name, verb, opts]) => (name === 'service' ? `service:${verb}:${opts && opts.dryRun ? 'dry' : 'live'}` : `${name}:${verb}`));
const noEnd = (result) => !JSON.stringify(result.plan.commands).includes('"/end"');

test('W3 C3/C4 scheduled task stop: graceful first, never schtasks /end; unconfirmed ⇒ failure with nothing issued', async () => {
  for (const k of CONFIRMED) {
    const r = recorder();
    const result = await cli.scheduledTaskGracefulVerb('stop', { port: 1 }, { _runServiceVerb: serviceSeam(r), _gracefulStop: r.fn('graceful', async () => OUTCOMES[k]) });
    assert.deepEqual({ k, exit: result.exitCode, calls: calls(r), noEnd: noEnd(result), step: result.steps[0].ok },
      { k, exit: SERVICE_EXIT.OK, calls: ['service:stop:dry', `graceful:${DEFAULT_PORT}`], noEnd: true, step: true });
  }
  for (const k of UNCONFIRMED) {
    const r = recorder();
    const result = await cli.scheduledTaskGracefulVerb('stop', { port: 1 }, { _runServiceVerb: serviceSeam(r), _gracefulStop: r.fn('graceful', async () => OUTCOMES[k]) });
    assert.deepEqual({ k, exit: result.exitCode, reason: result.reason, calls: calls(r), stepOk: result.steps[0].ok, stderr: result.steps[0].stderr },
      { k, exit: SERVICE_EXIT.FAILED, reason: 'graceful-stop-unconfirmed', calls: ['service:stop:dry', `graceful:${DEFAULT_PORT}`], stepOk: false, stderr: OUTCOMES[k].message });
  }
});

test('W3 C3/C4 scheduled task restart: schtasks /run (service start) only after a confirmed graceful stop', async () => {
  for (const k of CONFIRMED) {
    const r = recorder();
    const result = await cli.scheduledTaskGracefulVerb('restart', { port: 1 }, { _runServiceVerb: serviceSeam(r), _gracefulStop: r.fn('graceful', async () => OUTCOMES[k]) });
    assert.deepEqual({ k, exit: result.exitCode, verb: result.verb, calls: calls(r), steps: result.steps.map((s) => s.ok), noEnd: noEnd(result) },
      { k, exit: SERVICE_EXIT.OK, verb: 'restart', calls: ['service:restart:dry', `graceful:${DEFAULT_PORT}`, 'service:start:live'], steps: [true, true], noEnd: true });
  }
  for (const k of UNCONFIRMED) {
    const r = recorder();
    const result = await cli.scheduledTaskGracefulVerb('restart', { port: 1 }, { _runServiceVerb: serviceSeam(r), _gracefulStop: r.fn('graceful', async () => OUTCOMES[k]) });
    assert.deepEqual({ k, exit: result.exitCode, calls: calls(r) }, { k, exit: SERVICE_EXIT.FAILED, calls: ['service:restart:dry', `graceful:${DEFAULT_PORT}`] });
  }
});

test('W3 C3/C4 scheduled task: service refusals are unchanged, dry run shows the graceful plan, other kinds/verbs keep their path', async () => {
  const refused = recorder();
  const notInstalled = await cli.scheduledTaskGracefulVerb('stop', {}, { _runServiceVerb: serviceSeam(refused, { previewExit: SERVICE_EXIT.NOT_INSTALLED }), _gracefulStop: refused.fn('graceful', async () => OUTCOMES.stopped) });
  assert.deepEqual({ exit: notInstalled.exitCode, calls: calls(refused), noEnd: noEnd(notInstalled) }, { exit: SERVICE_EXIT.NOT_INSTALLED, calls: ['service:stop:dry'], noEnd: true });

  const dry = recorder();
  const plan = await cli.scheduledTaskGracefulVerb('restart', {}, { dryRun: true, _runServiceVerb: serviceSeam(dry), _gracefulStop: dry.fn('graceful', async () => OUTCOMES.stopped) });
  assert.deepEqual({ calls: calls(dry), first: /graceful stop/.test(plan.plan.commands[0][0]), rest: plan.plan.commands.slice(1), noEnd: noEnd(plan) },
    { calls: ['service:restart:dry'], first: true, rest: [RUN], noEnd: true });

  const launchd = recorder();
  assert.equal(await cli.scheduledTaskGracefulVerb('stop', {}, { _runServiceVerb: serviceSeam(launchd, { kind: 'launchd' }), _gracefulStop: launchd.fn('graceful', async () => OUTCOMES.stopped) }), null);
  assert.deepEqual(calls(launchd), ['service:stop:dry'], 'a non-scheduled-task service is never gracefully stopped by this helper');
  const start = recorder();
  assert.equal(await cli.scheduledTaskGracefulVerb('start', {}, { _runServiceVerb: serviceSeam(start), _gracefulStop: start.fn('graceful', async () => OUTCOMES.stopped) }), null);
  assert.deepEqual(calls(start), []);
});

// ---- F4: strict principal mode --------------------------------------------------------------------------
function strictConfiguration() {
  const pairs = {}; const keys = [];
  const key = (id, authority, grants) => {
    pairs[id] = crypto.generateKeyPairSync('ed25519');
    keys.push({ key_id: id, principal_id: id, public_key_spki: pairs[id].publicKey.export({ type: 'spki', format: 'pem' }), authority, grants });
  };
  key('operator', 'operator', [{ action: 'daemon.inspect', targets: ['daemon'] }, { action: 'daemon.stop', targets: ['daemon'] }]);
  key('opnostop', 'operator', [{ action: 'daemon.inspect', targets: ['daemon'] }]);
  key('opother', 'operator', [{ action: 'daemon.inspect', targets: ['daemon'] }, { action: 'daemon.stop', targets: ['other'] }]);
  key('alice', 'principal', [{ action: 'daemon.inspect', targets: ['daemon'] }, { action: 'daemon.stop', targets: ['daemon'] }]);
  return { pairs, json: { schema: 'telepty.principals/v1', audience: 'fixture-node', keys } };
}

async function strictDaemon(t) {
  const express = require('express'); const cors = require('cors');
  const { createHttpApp, registerHealthAndAuth } = require('../src/protocol/http-app');
  const { createAuthMiddleware } = require('../src/protocol/http-auth');
  const { createPrincipalAuthentication } = require('../src/principal/http');
  const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
  const config = strictConfiguration();
  const authentication = createPrincipalAuthentication({ trust: validateTrustConfiguration(config.json, { audience: 'fixture-node' }), sessions: {} });
  const app = createHttpApp({ express, cors });
  registerHealthAndAuth(app, { pkg: { version: 'fixture' }, createAuthMiddleware, isAllowedPeer: () => true, EXPECTED_TOKEN: TOKEN,
    verifyJwt: () => false, principalAuthentication: authentication });
  app.get('/api/meta', (_req, res) => res.json({ pid: PID, instance_id: INSTANCE }));
  const shutdowns = []; const deferred = [];
  app.post(STOP_PATH, createGracefulStopHandler({ expectedToken: TOKEN, pid: PID, instanceId: INSTANCE, isDaemonMain: true,
    shutdown: (code) => shutdowns.push(code), defer: (fn) => deferred.push(fn) }));
  const server = http.createServer(app);
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  // `body` is taken as given when present (a GET identity read signs `undefined`, i.e. the empty body).
  const sign = (id, { method = 'POST', target = STOP_PATH, action = 'daemon.stop', ...rest } = {}) =>
    createSignedAssertion({ privateKey: config.pairs[id].privateKey, keyId: id, principalId: id, audience: 'fixture-node',
      challenge: authentication.verifier.challenge, method, target, body: Object.hasOwn(rest, 'body') ? rest.body : { pid: PID, instance_id: INSTANCE }, action });
  const send = async ({ proof, token = TOKEN, origin, body = { pid: PID, instance_id: INSTANCE } } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${STOP_PATH}`, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', ...(token ? { 'x-telepty-token': token } : {}), ...(proof ? { 'x-telepty-principal': proof } : {}), ...(origin ? { origin } : {}) },
      body: JSON.stringify(body) });
    const answer = await r.json().catch(() => null);
    return [r.status, answer && answer.code];
  };
  return { port, sign, send, shutdowns, flush: () => { while (deferred.length) deferred.shift()(); } };
}

test('W3 F4 strict: daemon.stop needs an explicit operator grant on target daemon; no wildcard is admitted', () => {
  const { validateTrustConfiguration } = require('../src/principal/proof');
  const config = strictConfiguration();
  assert.equal(validateTrustConfiguration(config.json, { audience: 'fixture-node' }).keys.size, 4, 'PRECONDITION: fixture trust is valid');
  config.json.keys[0].grants = [{ action: 'daemon.stop', targets: ['*'] }];
  assert.throws(() => validateTrustConfiguration(config.json, { audience: 'fixture-node' }), { code: 'PRINCIPAL_CONFIG_INVALID' });
});

test('W3 F4 strict real HTTP: denied principal / missing grant / wrong target / replay / bearer-only never reach shutdown; a valid operator stop does, once', async (t) => {
  const d = await strictDaemon(t);
  const good = { pid: PID, instance_id: INSTANCE };
  const other = { pid: PID + 1, instance_id: INSTANCE };
  const valid = d.sign('operator');
  const observed = {
    bearerOnly: await d.send({}),
    principalKey: await d.send({ proof: d.sign('alice') }),
    missingGrant: await d.send({ proof: d.sign('opnostop') }),
    wrongGrantTarget: await d.send({ proof: d.sign('opother') }),
    wrongAction: await d.send({ proof: d.sign('operator', { action: 'daemon.inspect' }) }),
    wrongRequestTarget: await d.send({ proof: d.sign('operator', { target: `${STOP_PATH}?x=1` }) }),
    wrongBody: await d.send({ proof: d.sign('operator', { body: other }) }),
    withOrigin: (await d.send({ proof: d.sign('operator'), origin: 'http://127.0.0.1' }))[0],
    verifiedWithoutLocalToken: await d.send({ proof: d.sign('operator'), token: null }),
    verifiedOtherInstance: await d.send({ proof: d.sign('operator', { body: other }), body: other }),
    shutdownsBeforeValid: d.shutdowns.length,
    valid: await d.send({ proof: valid, body: good }),
    replay: await d.send({ proof: valid, body: good }),
  };
  d.flush();
  assert.deepEqual({ ...observed, shutdowns: d.shutdowns }, {
    bearerOnly: [401, 'PRINCIPAL_PROOF_INVALID'],
    principalKey: [403, 'PRINCIPAL_OPERATOR_REQUIRED'],
    missingGrant: [403, 'PRINCIPAL_GRANT_DENIED'],
    wrongGrantTarget: [403, 'PRINCIPAL_GRANT_DENIED'],
    wrongAction: [401, 'PRINCIPAL_PROOF_INVALID'],
    wrongRequestTarget: [401, 'PRINCIPAL_PROOF_INVALID'],
    wrongBody: [401, 'PRINCIPAL_PROOF_INVALID'],
    withOrigin: 403,
    verifiedWithoutLocalToken: [401, 'STOP_AUTH_REQUIRED'],
    verifiedOtherInstance: [409, 'STOP_INSTANCE_MISMATCH'],
    shutdownsBeforeValid: 0,
    valid: [202, undefined],
    replay: [409, 'PRINCIPAL_REPLAY'],
    shutdowns: [0],
  });
});

test('W3 F4 client: the identity read and the stop are signed for daemon.inspect / daemon.stop; an unavailable proof sends nothing', async () => {
  const sent = []; const bindings = [];
  const deps = (signRequest) => ({ port: 39002, token: TOKEN, pollMs: 1, deadlineMs: 50, signRequest,
    fetchImpl: async (url, options = {}) => {
      sent.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body || null });
      if (url.endsWith('/api/meta')) return { status: 200, json: async () => ({ pid: PID, instance_id: INSTANCE }) };
      return { status: 202, json: async () => ({ accepted: true, pid: PID, instance_id: INSTANCE }) };
    },
    isProcessRunning: () => false, confirmCmdline: () => true, probeHealth: async () => false, readLockPid: () => null, sleep: async () => {} });
  const result = await requestGracefulStop(deps(async (b) => { bindings.push(b); return `proof-${bindings.length}`; }));
  assert.deepEqual({ result, bindings, proofs: sent.map((s) => s.headers['x-telepty-principal']), tokens: sent.map((s) => s.headers['x-telepty-token'] === TOKEN) }, {
    result: { status: 'stopped', pid: PID, lockRetained: false },
    bindings: [{ method: 'GET', target: '/api/meta', body: undefined, action: 'daemon.inspect' },
      { method: 'POST', target: STOP_PATH, body: { pid: PID, instance_id: INSTANCE }, action: 'daemon.stop' }],
    proofs: ['proof-1', 'proof-2'], tokens: [true, true],
  });
  sent.length = 0;
  const noProof = await requestGracefulStop(deps(async () => { throw new Error('PRINCIPAL_CHALLENGE_REFUSED'); }));
  assert.deepEqual({ noProof, sent: sent.length }, { noProof: { status: 'unidentified', reason: 'principal_proof_unavailable' }, sent: 0 });
  sent.length = 0;
  let n = 0;
  const noStopProof = await requestGracefulStop(deps(async () => { if (++n === 2) throw new Error('PRINCIPAL_CHALLENGE_INVALID'); return 'proof'; }));
  assert.deepEqual({ noStopProof, methods: sent.map((s) => s.method) }, { noStopProof: { status: 'unidentified', pid: PID, reason: 'principal_proof_unavailable' }, methods: ['GET'] });
  assert.equal(decideStopOutcome(noStopProof).startReplacement, false);
});

test('W3 F4 end to end: the real client, signing as the operator, stops the strict real daemon exactly once', async (t) => {
  const d = await strictDaemon(t);
  const result = await requestGracefulStop({ port: d.port, token: TOKEN, pollMs: 1, deadlineMs: 2000,
    fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'error' }),
    signRequest: async (b) => d.sign('operator', b),
    isProcessRunning: () => { d.flush(); return d.shutdowns.length === 0; },
    confirmCmdline: () => true, probeHealth: async () => false, readLockPid: () => null, sleep: async () => {} });
  assert.deepEqual({ result, shutdowns: d.shutdowns }, { result: { status: 'stopped', pid: PID, lockRetained: false }, shutdowns: [0] });
});
