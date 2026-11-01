'use strict';

// Regression guard for #576 (P0): the test harness must launch each daemon on an
// OS-assigned ephemeral port (PORT=0) and read the actual bound port back, so test
// daemons can never collide with another process or each other. This replaces the old
// randomPort() (unchecked 30000–49999) that caused EADDRINUSE flakes on ubuntu and
// systematic EACCES on Windows reserved ranges.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { startTestDaemon } = require('../test-support/daemon-harness');

const started = [];

after(async () => {
  await Promise.all(started.map((h) => h.stop().catch(() => {})));
});

test('startTestDaemon binds an OS-assigned port and reads back the actual bound port', async () => {
  const harness = await startTestDaemon();
  started.push(harness);

  // A real, OS-assigned port — never 0 and never the unchecked random sentinel.
  assert.equal(Number.isInteger(harness.port), true);
  assert.ok(harness.port > 0 && harness.port < 65536, `port out of range: ${harness.port}`);

  // The port the harness reports must equal the port the daemon actually bound:
  // /api/meta reports the daemon's real bound port, proving the read-back is correct.
  const meta = await harness.request('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.port, harness.port);

  // And the daemon is genuinely serving on that port.
  const health = await harness.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
});

test('two concurrent test daemons get distinct, conflict-free ports', async () => {
  const [a, b] = await Promise.all([startTestDaemon(), startTestDaemon()]);
  started.push(a, b);

  assert.notEqual(a.port, b.port, 'concurrent daemons must not share a port');

  // Both are independently reachable on their own read-back ports.
  const [metaA, metaB] = await Promise.all([a.request('/api/meta'), b.request('/api/meta')]);
  assert.equal(metaA.body.port, a.port);
  assert.equal(metaB.body.port, b.port);
});

// Task 1215 harness129 — the harness's own HTTP waits are BOUNDED (a test-harness bound on previously unbounded waits;
// not a product deadline and not a fix for any audit stall). An owned loopback fixture that accepts and never answers
// (or answers headers and never ends the body, or resets) proves: the default-capped request deadline, a caller
// AbortSignal as a distinct typed outcome, bounded diagnostics, no leftover abort listener, and that stop() reaches the
// owned child's termination even when its session cleanup never answers or fails. Every stub socket/server and every
// started daemon is closed in finally, also on assertion failure.
const http = require('node:http');
const { getEventListeners } = require('node:events');
const { boundedRequest, HARNESS_OBSERVATION_MARGIN_MS } = require('../test-support/daemon-harness');

// Task 1215 harness133: `handlers` (keyed "METHOD /route") answer exact routes; `at` records the first receipt time per
// "METHOD /route" and `headersAt` when headers-only wrote its headers, so receipt preconditions are measured, never
// assumed. The delayed route's timer is owned and cleared on close.
const DELAYED_MS = 5500; // the one owned endpoint that crosses the 5000 ms default (positive override only)
async function ownedStub(unknownRoute = 'never', handlers = {}) {
  const sockets = new Set(), timers = new Set(), seen = [], at = {}, marks = { headersAt: null };
  const server = http.createServer((req, res) => {
    const route = req.url.split('?')[0], key = `${req.method} ${route}`;
    if (seen.length < 32) seen.push(key);
    if (at[key] === undefined) at[key] = Date.now();
    if (handlers[key]) { handlers[key](req, res); return; }
    const mode = route === '/ok' ? 'ok' : route === '/headers-only' ? 'headers-only' : route === '/never' ? 'never'
      : route === '/delayed' ? 'delayed' : unknownRoute;
    if (mode === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
    else if (mode === 'headers-only') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"partial":'); marks.headersAt = Date.now(); }
    else if (mode === 'delayed') {
      const timer = setTimeout(() => { timers.delete(timer); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"delayed":true}'); }, DELAYED_MS);
      timers.add(timer);
    } else if (mode === 'reset') req.socket.destroy();
    // 'never': the request is accepted and never answered.
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`, seen, at, marks,
    close: () => new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
// A negative bound long enough for a cold loopback connection to be accepted first (receipt is then asserted, timed).
const NEGATIVE_BOUND_MS = 1000;
const abortListeners = (signal) => getEventListeners(signal, 'abort').length;

test('harness request: a never-answering endpoint is refused at the injected deadline with a typed, bounded diagnostic', { timeout: 15000 }, async () => {
  const stub = await ownedStub();
  try {
    const caller = new AbortController();
    const begun = Date.now();
    const error = await boundedRequest(`${stub.origin}/never?q=Q-SECRET`, { method: 'GET', headers: { 'x-telepty-token': 'T-SECRET' } },
      { timeoutMs: NEGATIVE_BOUND_MS, signal: caller.signal }).then(() => null, (e) => e);
    const elapsed = Date.now() - begun;
    assert.ok(error, 'the request must not resolve');
    assert.equal(error.code, 'HARNESS_REQUEST_TIMEOUT');
    assert.equal(error.method, 'GET'); assert.equal(error.route, '/never');
    assert.ok(Number.isInteger(error.elapsed_ms) && error.elapsed_ms >= NEGATIVE_BOUND_MS - 50 && elapsed < 4500,
      `refused at the injected ${NEGATIVE_BOUND_MS} ms, before the 5000 ms default: ${error.elapsed_ms}/${elapsed}`);
    for (const secret of ['Q-SECRET', 'T-SECRET', stub.origin]) assert.ok(!error.message.includes(secret), `diagnostic omits ${secret}`);
    assert.ok(error.message.includes('GET /never'), error.message);
    assert.equal(abortListeners(caller.signal), 0, 'the caller signal listener is removed');
    assert.deepEqual(stub.seen, ['GET /never'], 'the request reached the owned endpoint');
    assert.ok(stub.at['GET /never'] - begun < NEGATIVE_BOUND_MS, 'PRECONDITION: received before the deadline (a refused ANSWER, not a slow connect)');
  } finally { await stub.close(); }
});

test('harness request: the deadline also covers the body (headers sent, body never ends)', { timeout: 15000 }, async () => {
  const stub = await ownedStub();
  try {
    const begun = Date.now();
    const error = await boundedRequest(`${stub.origin}/headers-only`, {}, { timeoutMs: NEGATIVE_BOUND_MS }).then(() => null, (e) => e);
    assert.ok(error, 'a body that never ends must not resolve');
    assert.equal(error.code, 'HARNESS_REQUEST_TIMEOUT');
    assert.equal(error.route, '/headers-only');
    assert.ok(stub.marks.headersAt !== null && stub.marks.headersAt - begun < NEGATIVE_BOUND_MS,
      'PRECONDITION: the headers were written before the deadline, so it was the BODY that was cut');
  } finally { await stub.close(); }
});

test('harness request: an explicit observation budget may exceed the 5000 ms default (one delayed owned endpoint)', { timeout: 30000 }, async () => {
  const stub = await ownedStub();
  try {
    const begun = Date.now();
    const ok = await boundedRequest(`${stub.origin}/delayed`, {}, { timeoutMs: DELAYED_MS + HARNESS_OBSERVATION_MARGIN_MS });
    const elapsed = Date.now() - begun;
    assert.equal(ok.status, 200); assert.deepEqual(ok.body, { delayed: true }, 'the healthy outcome is preserved');
    assert.ok(elapsed >= 5000, `the answer arrived after the 5000 ms default would have refused it (${elapsed} ms)`);
  } finally { await stub.close(); }
});

test('harness request: an explicit budget must be finite and positive; nothing is sent otherwise', { timeout: 15000 }, async () => {
  const stub = await ownedStub();
  try {
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      const error = await boundedRequest(`${stub.origin}/ok`, {}, { timeoutMs }).then(() => null, (e) => e);
      assert.equal(error && error.code, 'HARNESS_REQUEST_INVALID_TIMEOUT', `rejected: ${String(timeoutMs)}`);
    }
    assert.deepEqual(stub.seen, [], 'an invalid budget sends no request');
  } finally { await stub.close(); }
});

test('harness request: a caller abort is a distinct typed outcome, before the default deadline', { timeout: 15000 }, async () => {
  const stub = await ownedStub();
  try {
    const caller = new AbortController();
    const pending = boundedRequest(`${stub.origin}/never`, { method: 'POST', body: '{}' }, { signal: caller.signal }).then(() => null, (e) => e);
    const waitStart = Date.now();
    while (!stub.seen.length && Date.now() - waitStart < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stub.seen.length, 1, 'PRECONDITION: the endpoint accepted the request');
    caller.abort();
    const error = await pending;
    assert.ok(error, 'an aborted request must not resolve');
    assert.equal(error.code, 'HARNESS_REQUEST_ABORTED');
    assert.equal(error.method, 'POST'); assert.equal(error.route, '/never');
    assert.ok(error.elapsed_ms < 4000, `aborted before the 5000 ms default: ${error.elapsed_ms}`);
    assert.equal(abortListeners(caller.signal), 0);
    const already = await boundedRequest(`${stub.origin}/ok`, {}, { signal: AbortSignal.abort() }).then(() => null, (e) => e);
    assert.equal(already && already.code, 'HARNESS_REQUEST_ABORTED', 'an already-aborted signal is refused as aborted');
  } finally { await stub.close(); }
});

test('harness request: healthy responses are still accepted unchanged', { timeout: 30000 }, async () => {
  const stub = await ownedStub();
  try {
    const caller = new AbortController();
    const ok = await boundedRequest(`${stub.origin}/ok`, {}, { timeoutMs: 2000, signal: caller.signal });
    assert.equal(ok.status, 200); assert.deepEqual(ok.body, { ok: true }); assert.equal(ok.text, '{"ok":true}');
    assert.equal(abortListeners(caller.signal), 0);
  } finally { await stub.close(); }
  const harness = await startTestDaemon();
  started.push(harness);
  try {
    const health = await harness.request('/api/health', { signal: new AbortController().signal });
    assert.equal(health.status, 200); assert.equal(health.body.status, 'ok');
  } finally { await harness.stop(); }
});

// stop() with its session cleanup redirected to the owned stub: the harness's own requests to THIS daemon's origin are
// re-pointed for the duration of stop() only (the daemon child itself is real and owned).
async function stopWithCleanupAt(harness, stubOrigin) {
  const from = `http://${harness.host}:${harness.port}`, realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input).startsWith(from) ? stubOrigin + String(input).slice(from.length) : input, init);
  const begun = Date.now();
  try {
    let value;
    const error = await harness.stop().then((v) => { value = v; return null; }, (e) => e);
    return { error, value, elapsed: Date.now() - begun, begun };
  }
  finally { globalThis.fetch = realFetch; }
}

test('stop(): a never-answering session cleanup still reaches owned child termination and settles', { timeout: 30000 }, async () => {
  const stub = await ownedStub('never');
  const CLEANUP_BOUND_MS = 2000; // long enough for a cold loopback connect, so receipt below is a measured precondition
  const harness = await startTestDaemon({ cleanupTimeoutMs: CLEANUP_BOUND_MS });
  started.push(harness);
  try {
    assert.equal(harness.isAlive(), true, 'PRECONDITION: the owned daemon runs');
    const { error, elapsed, begun } = await stopWithCleanupAt(harness, stub.origin);
    assert.deepEqual(stub.seen, ['GET /api/sessions'], 'cleanup reached the never-answering endpoint');
    assert.ok(stub.at['GET /api/sessions'] - begun < CLEANUP_BOUND_MS, 'PRECONDITION: received before the cleanup bound');
    assert.equal(harness.isAlive(), false, 'the owned daemon child was terminated anyway');
    assert.ok(error, 'the cleanup failure is reported, not swallowed');
    assert.equal(error.code, 'HARNESS_STOP_CLEANUP_TIMEOUT');
    assert.equal(error.cause && error.cause.code, 'HARNESS_REQUEST_ABORTED', 'the original request error is preserved as the cause');
    assert.ok(elapsed < 15000, `stop() settled (${elapsed} ms)`);
  } finally {
    if (harness.isAlive()) await harness.kill().catch(() => {});
    await stub.close();
  }
});

test('stop(): a failing session cleanup still terminates the owned child and preserves the original error', { timeout: 30000 }, async () => {
  const stub = await ownedStub('reset');
  const harness = await startTestDaemon();
  started.push(harness);
  try {
    const { error } = await stopWithCleanupAt(harness, stub.origin);
    assert.equal(harness.isAlive(), false, 'the owned daemon child was terminated anyway');
    assert.ok(error instanceof TypeError, `the original fetch failure is rethrown: ${error && error.name}`);
    assert.equal(error.code, undefined, 'not re-typed as a harness timeout/abort');
  } finally {
    if (harness.isAlive()) await harness.kill().catch(() => {});
    await stub.close();
  }
});

test('stop(): an already-aborted case signal does not cut cleanup short; an independent bounded signal is used', { timeout: 30000 }, async () => {
  const harness = await startTestDaemon();
  started.push(harness);
  try {
    await harness.stop({ signal: AbortSignal.abort() });
    assert.equal(harness.isAlive(), false);
  } finally {
    if (harness.isAlive()) await harness.kill().catch(() => {});
  }
});

// Task 1215 harness133 — the contractual refusal: a require_owner_proof session answers the token-only DELETE with the
// exact 403 OWNED_DELETE_FORBIDDEN (session-actions.js). stop() excludes ONLY that session from the drain, still drains
// the ordinary one, reports fixed-shape counts, and the owned daemon really exits.
test('stop(): an exact protected-session refusal survives cleanup and the owned daemon still exits', { timeout: 30000 }, async () => {
  const harness = await startTestDaemon();
  started.push(harness);
  try {
    const sid = (prefix) => `${prefix}-${process.pid}-${Date.now()}`;
    const guarded = sid('harness133-protected'), ordinary = sid('harness133-ordinary');
    const g = await harness.registerSession(guarded, { require_owner_proof: true });
    const o = await harness.registerSession(ordinary);
    assert.ok([200, 201].includes(g.status) && [200, 201].includes(o.status), `PRECONDITION: registered ${g.status}/${o.status}`);
    const probe = await harness.request(`/api/sessions/${encodeURIComponent(guarded)}`, { method: 'DELETE' });
    assert.equal(probe.status, 403, 'PRECONDITION: the token-only DELETE is refused by contract');
    assert.equal(probe.body && probe.body.code, 'OWNED_DELETE_FORBIDDEN');
    const summary = await harness.stop();
    assert.equal(harness.isAlive(), false, 'the owned daemon really exited');
    assert.deepEqual(summary, { listed: 2, deleted: 1, refused: 1, failed: 0,
      refused_codes: { OWNED_DELETE_FORBIDDEN: 1 }, failed_statuses: {} }, JSON.stringify(summary));
  } finally {
    if (harness.isAlive()) await harness.kill().catch(() => {});
  }
});

// Other DELETE answers are NOT excused: 404 "Exact session id required." (this list supplied exact ids) and a 403 with
// any other code surface as HARNESS_CLEANUP_DELETE_FAILED, after the owned daemon is terminated.
test('stop(): non-contractual DELETE answers still surface after the owned daemon is terminated', { timeout: 30000 }, async () => {
  const stub = await ownedStub('never', {
    'GET /api/sessions': (req, res) => json(res, 200, [{ id: 'exact-404' }, { id: 'other-403' }]),
    'DELETE /api/sessions/exact-404': (req, res) => json(res, 404, { error: 'Exact session id required.' }),
    'DELETE /api/sessions/other-403': (req, res) => json(res, 403, { success: false, code: 'SOME_OTHER_REFUSAL', error: 'x' }),
  });
  const harness = await startTestDaemon();
  started.push(harness);
  try {
    const { error } = await stopWithCleanupAt(harness, stub.origin);
    assert.equal(harness.isAlive(), false, 'the owned daemon child was terminated anyway');
    assert.equal(error && error.code, 'HARNESS_CLEANUP_DELETE_FAILED', `surfaced: ${error && error.message}`);
    assert.deepEqual(error.summary, { listed: 2, deleted: 0, refused: 0, failed: 2, refused_codes: {},
      failed_statuses: { 404: 1, '403:SOME_OTHER_REFUSAL': 1 } });
    assert.deepEqual([...stub.seen].sort(), ['DELETE /api/sessions/exact-404', 'DELETE /api/sessions/other-403', 'GET /api/sessions'],
      'both DELETEs were answered and no drain poll followed a failed DELETE');
  } finally {
    if (harness.isAlive()) await harness.kill().catch(() => {});
    await stub.close();
  }
});
