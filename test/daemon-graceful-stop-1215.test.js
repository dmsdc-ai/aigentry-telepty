'use strict';

// Task 1215 W3B — production graceful daemon stop. Exercises the REAL src/daemon-shutdown.js handler and
// client, the REAL daemon-control dry run, and (one case) the REAL HTTP app + auth middleware on a loopback
// listener. The daemon's shutdown() is replaced only by a counting callback (the "controlled shutdown
// seam"); nothing here kills a process. Native Windows behaviour (a detached daemon actually exiting and
// releasing its ledger lock) is covered ONLY by the unchanged real-CLI cases in daemon-lifecycle-55 on CI.
// "PRECONDITION:" assertions validate setup (failure = INVALID, not product RED).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const shutdownModule = require('../src/daemon-shutdown');
const { authorizeGracefulStop, createGracefulStopHandler, requestGracefulStop, decideStopOutcome, STOP_PATH } = shutdownModule;
const daemonControl = require('../daemon-control');

const TOKEN = 'local-admin-token-fixture-1215';
const PID = 4242;
const INSTANCE = shutdownModule.newInstanceId();

function req({ remote = '127.0.0.1', headers = {}, body = { pid: PID, instance_id: INSTANCE }, raw } = {}) {
  const bytes = raw !== undefined ? raw : Buffer.from(JSON.stringify(body));
  return { socket: { remoteAddress: remote }, headers: { 'content-type': 'application/json', 'x-telepty-token': TOKEN, ...headers },
    principalRawBody: bytes, body };
}
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function handlerWithCounter({ isDaemonMain = true } = {}) {
  const calls = [];
  const deferred = [];
  const handler = createGracefulStopHandler({ expectedToken: TOKEN, pid: PID, instanceId: INSTANCE, isDaemonMain,
    shutdown: (code) => calls.push(code), defer: (fn) => deferred.push(fn) });
  return { handler, calls, flush: () => { while (deferred.length) deferred.shift()(); } };
}

test('W3B authorized exact-instance stop answers 202 and runs the existing shutdown exactly once', () => {
  const h = handlerWithCounter();
  const r = res(); h.handler(req(), r); h.flush();
  assert.deepEqual({ status: r.statusCode, accepted: r.body.accepted, pid: r.body.pid, instance: r.body.instance_id === INSTANCE, calls: h.calls },
    { status: 202, accepted: true, pid: PID, instance: true, calls: [0] });
});

test('W3B duplicate stop requests are idempotent: one shutdown call, the second answers already_stopping', () => {
  const h = handlerWithCounter();
  const a = res(); const b = res();
  h.handler(req(), a); h.handler(req(), b); h.flush();
  assert.deepEqual({ a: [a.statusCode, a.body.already_stopping], b: [b.statusCode, b.body.already_stopping], calls: h.calls },
    { a: [202, false], b: [202, true], calls: [0] });
});

test('W3B every denied request is refused before any shutdown effect', () => {
  const cases = {
    nonLocalPeer: [req({ remote: '10.0.0.7' }), 403, 'STOP_LOCAL_ONLY'],
    forwardedHeaderIgnored: [req({ remote: '10.0.0.7', headers: { 'x-forwarded-for': '127.0.0.1' } }), 403, 'STOP_LOCAL_ONLY'],
    browserOrigin: [req({ headers: { origin: 'http://127.0.0.1:3848' } }), 403, 'STOP_ORIGIN_REFUSED'],
    missingToken: [req({ headers: { 'x-telepty-token': undefined } }), 401, 'STOP_AUTH_REQUIRED'],
    wrongToken: [req({ headers: { 'x-telepty-token': 'local-admin-token-fixture-1216' } }), 401, 'STOP_AUTH_REQUIRED'],
    shorterToken: [req({ headers: { 'x-telepty-token': 'short' } }), 401, 'STOP_AUTH_REQUIRED'],
    sessionBearerOnly: [req({ headers: { 'x-telepty-token': undefined, 'x-telepty-session-token': 'epoch.bearer' } }), 401, 'STOP_AUTH_REQUIRED'],
    jwtOnly: [req({ headers: { 'x-telepty-token': undefined, authorization: 'Bearer eyJ.fake.jwt' } }), 401, 'STOP_AUTH_REQUIRED'],
    wrongContentType: [req({ headers: { 'content-type': 'text/plain' } }), 415, 'STOP_BODY_INVALID'],
    oversizedBody: [req({ raw: Buffer.from(JSON.stringify({ pid: PID, instance_id: INSTANCE, pad: 'x'.repeat(300) })) }), 413, 'STOP_BODY_INVALID'],
    malformedJson: [req({ raw: Buffer.from('{"pid":') }), 400, 'STOP_BODY_INVALID'],
    extraKey: [req({ body: { pid: PID, instance_id: INSTANCE, force: true } }), 400, 'STOP_BODY_INVALID'],
    missingInstance: [req({ body: { pid: PID } }), 400, 'STOP_BODY_INVALID'],
    wrongPid: [req({ body: { pid: PID + 1, instance_id: INSTANCE } }), 409, 'STOP_INSTANCE_MISMATCH'],
    staleInstance: [req({ body: { pid: PID, instance_id: shutdownModule.newInstanceId() } }), 409, 'STOP_INSTANCE_MISMATCH'],
  };
  const observed = {};
  for (const [name, [request, status, code]] of Object.entries(cases)) {
    const h = handlerWithCounter();
    const r = res(); h.handler(request, r); h.flush();
    observed[name] = { status: r.statusCode, code: r.body.code, calls: h.calls.length, expected: [status, code] };
  }
  for (const [name, o] of Object.entries(observed)) {
    assert.deepEqual({ status: o.status, code: o.code, calls: o.calls }, { status: o.expected[0], code: o.expected[1], calls: 0 }, name);
  }
  // Not the daemon main (a test or tool that required daemon.js): authorized but no effect.
  const notMain = handlerWithCounter({ isDaemonMain: false });
  const r = res(); notMain.handler(req(), r); notMain.flush();
  assert.deepEqual({ status: r.statusCode, code: r.body.code, calls: notMain.calls.length }, { status: 503, code: 'STOP_UNAVAILABLE', calls: 0 });
  assert.equal(authorizeGracefulStop(req(), { expectedToken: TOKEN, pid: PID, instanceId: INSTANCE }).ok, true, 'PRECONDITION: the fixture request is otherwise valid');
});

test('W3B real HTTP app + auth middleware on loopback: a valid local stop reaches shutdown once; query-token and Origin requests do not', async (t) => {
  const express = require('express'); const cors = require('cors');
  const { createHttpApp } = require('../src/protocol/http-app');
  const { createAuthMiddleware, createOriginGuard } = require('../src/protocol/http-auth');
  const app = createHttpApp({ express, cors });
  app.use(createAuthMiddleware({ expectedToken: TOKEN, isAllowedPeer: () => true, verifyJwt: () => false, isForbiddenOrigin: createOriginGuard([]) }));
  const calls = [];
  const deferred = [];
  app.post(STOP_PATH, createGracefulStopHandler({ expectedToken: TOKEN, pid: PID, instanceId: INSTANCE, isDaemonMain: true,
    shutdown: (code) => calls.push(code), defer: (fn) => deferred.push(fn) }));
  const server = http.createServer(app);
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = (path, headers, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const good = { pid: PID, instance_id: INSTANCE };
  const queryOnly = await send(`${STOP_PATH}?token=${TOKEN}`, {}, good);
  const withOrigin = await send(STOP_PATH, { 'x-telepty-token': TOKEN, origin: 'http://127.0.0.1' }, good);
  const accepted = await send(STOP_PATH, { 'x-telepty-token': TOKEN }, good);
  while (deferred.length) deferred.shift()();
  assert.deepEqual({ queryOnly: queryOnly.status, withOrigin: withOrigin.status, accepted: [accepted.status, accepted.body && accepted.body.accepted], calls },
    { queryOnly: 401, withOrigin: 403, accepted: [202, true], calls: [0] });
});

function clientDeps(overrides = {}) {
  const sent = [];
  const running = overrides.running || (() => false);
  return {
    sent,
    deps: {
      port: 39001, token: TOKEN, pollMs: 1, deadlineMs: 50,
      fetchImpl: async (url, options = {}) => {
        sent.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body || null });
        if (url.endsWith('/api/meta')) return overrides.meta || { status: 200, json: async () => ({ pid: PID, instance_id: INSTANCE }) };
        return overrides.stop || { status: 202, json: async () => ({ accepted: true, pid: PID, instance_id: INSTANCE }) };
      },
      isProcessRunning: running, confirmCmdline: overrides.confirmCmdline || (() => true),
      probeHealth: overrides.probeHealth || (async () => false), readLockPid: overrides.readLockPid || (() => null),
      sleep: async () => {},
    },
  };
}

test('W3B client: a bound stop that exits and releases the lock is "stopped"; the request carries exactly {pid, instance_id} and the header token', async () => {
  const c = clientDeps();
  const result = await requestGracefulStop(c.deps);
  const post = c.sent.find((s) => s.method === 'POST');
  assert.deepEqual({ result, postBody: JSON.parse(post.body), headerToken: post.headers['x-telepty-token'] === TOKEN, queryToken: post.url.includes('token=') },
    { result: { status: 'stopped', pid: PID, lockRetained: false }, postBody: { pid: PID, instance_id: INSTANCE }, headerToken: true, queryToken: false });
});

test('W3B client: a stop that does not complete within the bound is a timeout, never success, and the client has no kill path', async () => {
  const c = clientDeps({ running: () => true });
  const result = await requestGracefulStop(c.deps);
  const outcome = decideStopOutcome(result);
  assert.deepEqual({ status: result.status, exited: result.exited, ok: outcome.ok, startReplacement: outcome.startReplacement, exitCode: outcome.exitCode,
    noKillDependency: !Object.keys(c.deps).some((k) => /kill/i.test(k)) },
  { status: 'timeout', exited: false, ok: false, startReplacement: false, exitCode: 1, noKillDependency: true });
});

test('W3B client: refused, unidentified and unsupported targets are failures with no stop sent where identity is not established', async () => {
  const refused = await requestGracefulStop(clientDeps({ stop: { status: 409, json: async () => ({ success: false, code: 'STOP_INSTANCE_MISMATCH' }) } }).deps);
  const notTelepty = clientDeps({ confirmCmdline: () => false });
  const unidentified = await requestGracefulStop(notTelepty.deps);
  const old = clientDeps({ meta: { status: 200, json: async () => ({ pid: PID }) } });
  const unsupported = await requestGracefulStop(old.deps);
  const metaRefused = await requestGracefulStop(clientDeps({ meta: { status: 401, json: async () => ({}) } }).deps);
  assert.deepEqual({
    refused: [refused.status, refused.code], unidentified: [unidentified.status, unidentified.reason, notTelepty.sent.filter((s) => s.method === 'POST').length],
    unsupported: [unsupported.status, old.sent.filter((s) => s.method === 'POST').length], metaRefused: metaRefused.status,
    outcomes: [refused, unidentified, unsupported, metaRefused].map((r) => decideStopOutcome(r).ok),
  }, {
    refused: ['refused', 'STOP_INSTANCE_MISMATCH'], unidentified: ['unidentified', 'pid_not_telepty', 0], unsupported: ['unsupported', 0],
    metaRefused: 'unidentified', outcomes: [false, false, false, false],
  });
});

test('W3B client: an exited daemon whose ledger lock still names it is NOT a clean stop; a lock owned by another pid is not this stop\'s concern', async () => {
  const retained = await requestGracefulStop(clientDeps({ readLockPid: () => PID }).deps);
  const foreign = await requestGracefulStop(clientDeps({ readLockPid: () => 999999 }).deps);
  assert.deepEqual({ retained: [retained.lockRetained, decideStopOutcome(retained).ok, decideStopOutcome(retained).startReplacement],
    foreign: [foreign.lockRetained, decideStopOutcome(foreign).ok] },
  { retained: [true, false, false], foreign: [false, true] });
});

test('W3B restart never overlaps: a replacement may start only after a confirmed stop or when there was no daemon at all', () => {
  const plan = (result, targets) => decideStopOutcome(result, targets).startReplacement;
  assert.deepEqual({
    stopped: plan({ status: 'stopped', pid: PID, lockRetained: false }),
    lockRetained: plan({ status: 'stopped', pid: PID, lockRetained: true }),
    timeout: plan({ status: 'timeout', pid: PID }),
    refused: plan({ status: 'refused', pid: PID }),
    unknown: plan({ status: 'unknown', pid: PID }),
    noAnswerNoDaemon: plan({ status: 'no_answer' }, []),
    noAnswerUnreachableDaemon: plan({ status: 'no_answer' }, [{ pid: PID, source: 'state-file' }]),
  }, { stopped: true, lockRetained: false, timeout: false, refused: false, unknown: false, noAnswerNoDaemon: true, noAnswerUnreachableDaemon: false });
});

test('W3B dry run lists only the surgical targets and signals/clears nothing; an unrelated port owner is preserved', () => {
  const killed = [];
  const result = daemonControl.cleanupDaemonProcesses({
    port: 39002, dryRun: true,
    readDaemonState: () => ({ pid: 5151, port: 39002 }),
    pidMatchesTeleptyCmdline: (pid) => pid === 5151,       // the port owner 6262 is NOT a telepty daemon
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => 6262,
    stopDaemonProcess: (pid) => { killed.push(pid); return true; },
  });
  assert.deepEqual({ targets: result.targets.map((x) => [x.pid, x.source]), stopped: result.stopped, failed: result.failed, killed },
    { targets: [[5151, 'state-file']], stopped: [], failed: [], killed: [] });
});
