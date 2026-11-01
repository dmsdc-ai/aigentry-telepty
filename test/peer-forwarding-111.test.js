'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const WebSocket = require('ws');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const { createForwardLedger, registerPeerForwardRoutes } = require('../src/peer-forwarding');
const crypto = require('node:crypto');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const grant = { enabled: true, operations: ['inject'], sessions: ['same@literal'], hop_limit: 1,
  max_payload_bytes: 128, max_requests: 8, window_ms: 60000, timeout_ms: 500 };

test('opt-in exact peer forwarding scopes authority, preserves receipts, deduplicates and retains timeout uncertainty', async () => {
  const source = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  const target = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  const sockets = [];
  let slow, tripwire;
  const held = [];
  try {
    assert.notEqual(source.authToken(), target.authToken());
    const localRegistration = await source.registerSession('same@literal');
    const remoteRegistration = await target.registerSession('same@literal');
    assert.equal(localRegistration.status, 201);
    async function owner(daemon) {
      const socket = new WebSocket(`ws://${daemon.host}:${daemon.port}/api/sessions/same@literal?owner=1&token=${encodeURIComponent(daemon.authToken())}`, daemon.ownerAuth('same@literal'));
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return socket;
    }
    const localOwner = await owner(source);
    const remoteOwner = await owner(target);
    sockets.push(localOwner, remoteOwner);
    const localFrames = [], remoteFrames = [];
    localOwner.on('message', (raw) => { const frame = JSON.parse(raw); if (frame.type === 'inject') localFrames.push(frame); });
    remoteOwner.on('message', (raw) => { const frame = JSON.parse(raw); if (frame.type === 'inject') remoteFrames.push(frame); });
    const file = path.join(source.homeDir, '.telepty', 'peers.json');
    let peer = { transport: 'http', host: target.host, port: target.port, token: target.authToken() };
    const seed = () => fs.writeFileSync(file, JSON.stringify({ peers: { exact: peer } }));
    seed();
    const request = (body, name = 'exact', sid = 'same@literal') => source.request(`/api/peers/${name}/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body });
    const body = { prompt: 'Synthetic forwarded input', expected_epoch: remoteRegistration.body.session_epoch,
      idempotency_key: 'synthetic-forward-key-0001', no_enter: true };
    assert.equal((await request(body)).status, 403);
    assert.equal((await request(body, 'unknown')).body.code, 'PEER_UNKNOWN');
    peer.forwarding = { ...grant }; seed();
    assert.equal((await request(body, 'exact', 'ungranted')).status, 403);
    assert.equal((await request({ ...body, prompt: 'x'.repeat(129) })).status, 403);
    assert.equal((await request({ ...body, url: 'http://example.invalid' })).status, 400);
    assert.equal((await source.request('/api/peers')).text.includes('max_requests'), false);
    // #1215 windows109 — failure-only diagnostics for a non-200 first forward. Runs only on that failure and
    // before the unchanged assertion below: one read-only observation (<= 3000 ms) of this fixture's own
    // destination row through the existing ledger reader, never another injection, resend or retry. The
    // received response is kept as received; anything not observed is reported as 'unknown'.
    async function unacceptedForwardDiagnostics(response, callerElapsedMs) {
      const observedAt = performance.now();
      let destination;
      try { destination = createForwardLedger(target.homeDir).all(); } catch (error) { destination = { read_error: (error && error.code) || 'unknown' }; }
      const destinationLedger = createForwardLedger(target.homeDir);
      const rowKey = digest(`inbound:${digest(`outbound:${body.idempotency_key}`)}`);
      let row = null, readError = null, elapsed = 0;
      for (;;) {
        try { row = destinationLedger.read(rowKey); readError = null; } catch (error) { row = null; readError = (error && error.code) || 'unknown'; }
        elapsed = performance.now() - observedAt;
        if ((row && row.state !== 'pending') || elapsed >= 3000) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, 3000 - elapsed)));
      }
      const secrets = [source.authToken(), target.authToken()].filter((value) => typeof value === 'string' && value.length > 0);
      const tail = (text) => {
        const kept = String(text || '').split(/\r?\n/).map((line) => (/authori[sz]ation|cookie|token|secret|credential|grant/i.test(line)
          || secrets.some((secret) => line.includes(secret)) ? '[line redacted]' : line)).join('\n');
        const bytes = Buffer.from(kept, 'utf8');
        return bytes.length <= 1024 ? kept : bytes.subarray(bytes.length - 1024).toString('utf8');
      };
      const logs = target.getLogs();
      // #1215 peer174 — unrounded caller-side elapsed, correlation only: it spans the harness HTTP hop, the
      // source's ledger reserve and the forward, so it neither locates the source timer origin nor names the error.
      return JSON.stringify({ source: response.body, destination, source_call: {
        caller_elapsed_ms: callerElapsedMs,
        grant_timeout_ms: grant.timeout_ms,
        interpretation: 'correlation only; includes harness and reserve time; does not identify the caught error',
      }, after_non_200: {
        observation_bound_ms: 3000,
        elapsed_ms_since_non_200_observed: Math.round(elapsed),
        outcome: readError ? 'read_error' : !row ? 'row_absent' : row.state === 'pending' ? 'pending_at_bound' : 'settled',
        read_error: readError,
        final_state: row ? row.state : 'unknown',
        remote_status: row && Number.isInteger(row.remote_status) ? row.remote_status : 'unknown',
        remote_receipt_success: row && row.remote_receipt && typeof row.remote_receipt.success === 'boolean' ? row.remote_receipt.success : 'unknown',
        remote_frames_observed: remoteFrames.length,
        target_exit_event_recorded: !target.isAlive(),
        target_exit_code_signal: 'unknown (not exposed by the harness)',
        target_stdout_tail: tail(logs.stdout),
        target_stderr_tail: tail(logs.stderr),
      } });
    }
    const forwardBegun = performance.now();
    const accepted = await request(body);
    const callerElapsedMs = performance.now() - forwardBegun;
    const unacceptedDiagnostics = accepted.status === 200 ? null : await unacceptedForwardDiagnostics(accepted, callerElapsedMs);
    assert.equal(accepted.status, 200, unacceptedDiagnostics || JSON.stringify({ source: accepted.body, destination: createForwardLedger(target.homeDir).all() }));
    assert.equal(accepted.body.state, 'accepted');
    assert.equal(accepted.body.routing_receipt.session, 'same@literal');
    assert.equal(accepted.body.routing_receipt.remote_inject_id, accepted.body.inject_id);
    assert.equal(accepted.body.verified_foreign_identity, false);
    await waitFor(() => remoteFrames.length === 1, { description: 'one remote injection' });
    assert.equal(localFrames.length, 0);
    const replay = await request(body);
    assert.equal(replay.body.inject_id, accepted.body.inject_id);
    assert.equal(remoteFrames.length, 1);
    assert.equal((await request({ ...body, prompt: 'changed input' })).status, 409);
    const query = await source.request(`/api/peers/forward-receipts/${body.idempotency_key}`);
    assert.equal(query.body.inject_id, accepted.body.inject_id);
    assert.equal((await request({ ...body, expected_epoch: 'wrong-epoch', idempotency_key: 'synthetic-forward-key-0002' })).body.code, 'TARGET_EPOCH_MISMATCH');
    // The destination also deduplicates independent transport retries before delivery.
    const wire = { ...body, exact_target: true, claimed_cross_host: true,
      forwarding: { hop: 1, key: digest(`outbound:${body.idempotency_key}`) } };
    delete wire.idempotency_key;
    const destinationReplay = await target.request(`/api/forwarded/sessions/${encodeURIComponent('same@literal')}/inject`, { method: 'POST', body: wire });
    assert.equal(destinationReplay.body.inject_id, accepted.body.inject_id);
    assert.equal(remoteFrames.length, 1);
    assert.equal((await target.request(`/api/forwarded/sessions/${encodeURIComponent('same@literal')}/inject`, {
      method: 'POST', body: { ...wire, forwarding: { ...wire.forwarding, hop: 2 } }
    })).status, 400);
    // A literal @ session on the local API remains exact-local.
    const literal = await source.request(`/api/sessions/${encodeURIComponent('same@literal')}/inject`, {
      method: 'POST', body: { prompt: 'Synthetic local input', exact_target: true, no_enter: true }
    });
    assert.equal(literal.status, 200);
    await waitFor(() => localFrames.length === 1, { description: 'literal local session inject' });
    // Timeout after the request arrives is uncertain; replay must never send again.
    // #1215 peer174 — the answer is withheld (event-ordered) until the source has returned, replacing a
    // 400 ms timer raced against the 100 ms grant: the 202 below can then only come from the source's own
    // deadline or transport error, never from an answer. Delivery of the request itself within the 100 ms
    // grant (requests === 1) is the pre-existing, unchanged assumption of this leg.
    let requests = 0, headers, redirectTo = null, redirectedRequests = 0;
    slow = http.createServer((req, res) => {
      requests++; headers = req.headers; req.resume();
      if (redirectTo) { res.writeHead(302, { location: redirectTo }); res.end(); return; }
      held.push(res);
    });
    await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
    peer = { ...peer, port: slow.address().port, token: 'synthetic-destination-only', forwarding: { ...grant, timeout_ms: 100 } }; seed();
    const uncertainBody = { ...body, idempotency_key: 'synthetic-forward-key-0003' };
    const uncertain = await request(uncertainBody);
    const withheldWhenSourceReturned = held.filter((res) => !res.writableEnded).length;
    for (const res of held.splice(0)) if (!res.destroyed) res.end('{}');
    assert.equal(uncertain.status, 202);
    assert.equal(uncertain.body.state, 'outcome_unknown');
    assert.equal(uncertain.body.code, 'PEER_OUTCOME_UNKNOWN');
    assert.equal(requests, 1);
    assert.equal(withheldWhenSourceReturned, 1);
    assert.equal(headers['x-telepty-token'], 'synthetic-destination-only');
    assert.equal(headers['x-telepty-session-token'], undefined);
    assert.notEqual(headers['x-telepty-token'], source.authToken());
    assert.equal((await request(uncertainBody)).status, 202);
    assert.equal(requests, 1);
    assert.equal((await source.request(`/api/peers/forward-receipts/${uncertainBody.idempotency_key}`)).body.state, 'outcome_unknown');
    tripwire = http.createServer((req, res) => { redirectedRequests++; req.resume(); res.end('{}'); });
    await new Promise((resolve) => tripwire.listen(0, '127.0.0.1', resolve));
    redirectTo = `http://127.0.0.1:${tripwire.address().port}/never`;
    const redirected = await request({ ...body, idempotency_key: 'synthetic-forward-key-0004' });
    assert.equal(redirected.status, 202);
    assert.equal(redirected.body.state, 'outcome_unknown');
    assert.equal(redirectedRequests, 0);
    peer = { ...peer, port: target.port, token: target.authToken(), forwarding: { ...grant, sessions: ['same@literal', 'not-created', 'broadcast'] } }; seed();
    const missing = await request({ ...body, idempotency_key: 'synthetic-forward-key-0005' }, 'exact', 'not-created');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SESSION_NOT_FOUND');
    assert.equal((await request({ ...body, idempotency_key: 'synthetic-forward-broadcast' }, 'exact', 'broadcast')).status, 404);
    assert.equal(remoteFrames.length, 1);
    peer.forwarding.max_requests = 1; seed();
    assert.equal((await request({ ...body, idempotency_key: 'synthetic-forward-key-0006' })).status, 429);
    const ledger = createForwardLedger(source.homeDir);
    for (const record of ledger.all()) assert.equal(JSON.stringify(record).includes(body.prompt), false);
    const pendingKey = digest('outbound:synthetic-crashed-forward');
    ledger.reserve(pendingKey, 'a'.repeat(64), { direction: 'outbound', peer: 'exact', session: 'same@literal' });
    assert.equal(createForwardLedger(source.homeDir).view(ledger.read(pendingKey)).state, 'outcome_unknown');
  } finally {
    sockets.forEach((socket) => socket.close());
    for (const res of held.splice(0)) res.destroy();
    if (slow) await new Promise((resolve) => slow.close(resolve));
    if (tripwire) await new Promise((resolve) => tripwire.close(resolve));
    await Promise.all([source.stop(), target.stop()]);
  }
});

// #1215 peer174 — in-process seam for the two added legs below. The REAL source route handlers are
// registered through the existing registerPeerForwardRoutes(app, { fetch }) option on a capture-only app
// (no listener) and called with minimal req/res objects. In these legs the source side is this test
// process, not the source daemon, so they cannot establish what the daemon's route caught in a failing
// run of the leg above. Recorded fields are fixed-shape: no prompt, token, URL or error message.
function captureForwardRoutes(options) {
  const routes = new Map();
  registerPeerForwardRoutes({ get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler) }, options);
  return routes;
}
function invokeRoute(handler, req) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; } };
    Promise.resolve(handler(req, res)).then(() => resolve({ status: null, body: null }), reject);
  });
}
const safeToken = (value) => (value === undefined || value === null ? null
  : (typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value)) || Number.isInteger(value) ? value : 'other');
const errorClass = (error) => ({ name: safeToken(error && error.name), code: safeToken(error && error.code),
  cause_name: safeToken(error && error.cause && error.cause.name), cause_code: safeToken(error && error.cause && error.cause.code) });
const inboundRowKey = (idempotencyKey) => digest(`inbound:${digest(`outbound:${idempotencyKey}`)}`);
async function withRealDestination(idempotencyKey, run) {
  const target = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  const routeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-peer174-'));
  const sockets = [], frames = [];
  try {
    const registration = await target.registerSession('same@literal');
    assert.equal(registration.status, 201);
    const socket = new WebSocket(`ws://${target.host}:${target.port}/api/sessions/same@literal?owner=1&token=${encodeURIComponent(target.authToken())}`, target.ownerAuth('same@literal'));
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', (raw) => { const frame = JSON.parse(raw); if (frame.type === 'inject') frames.push(frame); });
    const peer = { transport: 'http', host: target.host, port: target.port, token: target.authToken(), forwarding: { ...grant } };
    const body = { prompt: 'Synthetic forwarded input', expected_epoch: registration.body.session_epoch,
      idempotency_key: idempotencyKey, no_enter: true };
    return await run({ target, routeHome, frames, peer, body });
  } finally {
    sockets.forEach((socket) => socket.close());
    await target.stop();
    fs.rmSync(routeHome, { recursive: true, force: true });
  }
}
async function observeDestinationRow(homeDir, idempotencyKey, boundMs) {
  const ledger = createForwardLedger(homeDir);
  const begun = performance.now();
  let row = null, readError = null, elapsed = 0;
  for (;;) {
    try { row = ledger.read(inboundRowKey(idempotencyKey)); readError = null; } catch (error) { row = null; readError = safeToken(error && error.code) || 'unknown'; }
    elapsed = performance.now() - begun;
    if ((row && row.state !== 'pending') || elapsed >= boundMs) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, boundMs - elapsed)));
  }
  return { row, readError, elapsed };
}
// Booleans only; approximates the receipt check the route applies to a complete 200 body.
function receiptShape(chunks, bytes) {
  if (bytes > 16 * 1024) return { json: 'over_limit' };
  let remote;
  try { remote = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { json: 'parse_failed' }; }
  const object = remote !== null && typeof remote === 'object' && !Array.isArray(remote);
  return { json: object ? 'object' : 'non_object', success_true: object && remote.success === true,
    inject_id_text: object && typeof remote.inject_id === 'string' && remote.inject_id.length > 0 && remote.inject_id.length <= 128,
    session_id_matches: object && remote.session_id === 'same@literal', exact_target_true: object && remote.exact_target === true };
}
// Passthrough to the real global fetch: same URL, init and signal; the status, headers and body bytes the
// route reads are the real ones, relayed unchanged. Only times and fixed-shape classes are recorded.
function measuredFetch(obs, clock) {
  const at = (field) => { if (obs.ms[field] === null) obs.ms[field] = performance.now() - clock.begun; };
  return async (url, init) => {
    obs.fetch_calls++;
    at('fetch_call');
    const signal = init && init.signal;
    if (signal) signal.addEventListener('abort', () => { at('signal_abort'); obs.signal_reason = safeToken(signal.reason && signal.reason.name); }, { once: true });
    let response;
    try { response = await globalThis.fetch(url, init); }
    catch (error) { at('fetch_rejected'); obs.stage = 'before_headers'; obs.error = errorClass(error); throw error; }
    at('headers'); obs.remote_status = response.status;
    if (!response.body || [101, 103, 204, 205, 304].includes(response.status)) { obs.stage = 'no_body'; return response; }
    const reader = response.body.getReader();
    const chunks = [];
    const relay = new ReadableStream({
      async pull(controller) {
        let step;
        try { step = await reader.read(); }
        catch (error) { at('body_error'); obs.stage = 'body'; obs.error = errorClass(error); controller.error(error); return; }
        if (step.done) { at('body_done'); obs.stage = 'body_complete'; obs.body = receiptShape(chunks, obs.body_bytes); controller.close(); return; }
        obs.body_bytes += step.value.length;
        if (obs.body_bytes <= 16 * 1024) chunks.push(Buffer.from(step.value));
        controller.enqueue(step.value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(relay, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

// Measurement leg: evidence, not a latency gate. It asserts only timing-independent invariants (a 200 is an
// exact accepted receipt delivered once; anything else is 202 outcome_unknown; one send; replay never
// resends). The live 200 contract stays asserted, unchanged, by the real two-daemon leg above.
test('[peer174] measurement: real source route, real global fetch and a real destination daemon under the original 500 ms grant record fixed-shape timing and error class', async (t) => {
  await withRealDestination('synthetic-forward-key-0007', async ({ target, routeHome, frames, peer, body }) => {
    const obs = { leg: 'peer174-measurement', grant_timeout_ms: grant.timeout_ms, fetch_calls: 0, stage: null, remote_status: null,
      error: null, signal_reason: null, body_bytes: 0, body: null,
      ms: { fetch_call: null, signal_abort: null, fetch_rejected: null, headers: null, body_error: null, body_done: null, route_return: null },
      route: null, destination: null, frames: null, classification: null,
      clock: 'performance.now() ms since route entry, unrounded; each is when this process observed the event (>= the event); '
        + 'the route creates AbortSignal.timeout while evaluating the fetch arguments, so fetch_call bounds the timer origin; '
        + 'route entry to fetch_call includes the ledger reserve; a signal_abort after route_return had no effect' };
    const clock = { begun: 0 };
    const routes = captureForwardRoutes({ sessions: {}, loadPeers: () => ({ peers: { measured: peer } }), homeDir: routeHome, fetch: measuredFetch(obs, clock) });
    const forward = routes.get('POST /api/peers/:peer/sessions/:sid/inject');
    const req = { params: { peer: 'measured', sid: 'same@literal' }, body };
    clock.begun = performance.now();
    const first = await invokeRoute(forward, req);
    obs.ms.route_return = performance.now() - clock.begun;
    obs.route = { status: first.status, state: safeToken(first.body && first.body.state), code: safeToken(first.body && first.body.code) };
    const observed = await observeDestinationRow(target.homeDir, body.idempotency_key, 3000);
    obs.destination = { state: observed.row ? observed.row.state : observed.readError ? 'read_error' : 'row_absent',
      remote_status: observed.row && Number.isInteger(observed.row.remote_status) ? observed.row.remote_status : null, observed_after_ms: observed.elapsed };
    obs.frames = frames.length;
    obs.classification = first.status === 200 ? 'accepted' : obs.ms.fetch_rejected !== null ? 'fetch_rejected_before_headers'
      : obs.ms.body_error !== null ? 'body_read_error' : obs.ms.body_done !== null ? 'body_complete_then_unknown' : 'other';
    const evidence = JSON.stringify(obs);
    t.diagnostic(`#1215 peer174 measurement ${evidence}`);
    assert.equal(obs.fetch_calls, 1, evidence);
    if (first.status === 200) {
      assert.equal(first.body.state, 'accepted', evidence);
      assert.equal(first.body.routing_receipt.remote_inject_id, first.body.inject_id, evidence);
      await waitFor(() => frames.length === 1, { description: 'one remote injection (measurement leg)' });
    } else {
      assert.equal(first.status, 202, evidence);
      assert.equal(first.body.state, 'outcome_unknown', evidence);
      assert.equal(first.body.code, 'PEER_OUTCOME_UNKNOWN', evidence);
      if (observed.row && observed.row.state === 'accepted') await waitFor(() => frames.length === 1, { description: 'one remote injection (measurement leg)' });
    }
    const replay = await invokeRoute(forward, req);
    assert.equal(obs.fetch_calls, 1, evidence);
    assert.equal(replay.status, first.status, evidence);
    if (first.status === 200) assert.equal(replay.body.inject_id, first.body.inject_id, evidence);
    else assert.equal(replay.body.state, 'outcome_unknown', evidence);
    assert.ok(frames.length <= 1, evidence);
  });
});

// Protocol control, not proof of native HTTP timing: a controlled fetch delivers the request to the real
// destination daemon outside the route's signal (so the source deadline cannot cancel transmission), then
// waits for BOTH that real answer and the route's own deadline event, and only then rejects with the
// route's own signal reason. Event-ordered: no delivery-within-deadline precondition, no fixed sleep.
test('[peer174] protocol control: an acceptance the real destination recorded but the source route did not observe before its deadline stays outcome_unknown and is never resent', async () => {
  await withRealDestination('synthetic-forward-key-0008', async ({ target, routeHome, frames, peer, body }) => {
    let calls = 0, delivery = null;
    const controlledFetch = async (url, init) => {
      calls++;
      const delivered = (async () => {
        try {
          const response = await globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
          await response.arrayBuffer();
          delivery = { status: response.status, error: null };
        } catch (error) { delivery = { status: null, error: errorClass(error) }; }
      })();
      const deadline = new Promise((resolve) => { if (init.signal.aborted) resolve(); else init.signal.addEventListener('abort', resolve, { once: true }); });
      await Promise.all([delivered, deadline]);
      throw init.signal.reason;
    };
    const routes = captureForwardRoutes({ sessions: {}, loadPeers: () => ({ peers: { controlled: peer } }), homeDir: routeHome, fetch: controlledFetch });
    const forward = routes.get('POST /api/peers/:peer/sessions/:sid/inject');
    const receipt = routes.get('GET /api/peers/forward-receipts/:key');
    const req = { params: { peer: 'controlled', sid: 'same@literal' }, body };
    const first = await invokeRoute(forward, req);
    // Setup boundary: without a real 200 from the destination this is a fixture failure, named as such.
    assert.equal(delivery && delivery.status, 200, `setup: real delivery did not complete ${JSON.stringify({ delivery, calls })}`);
    assert.equal(first.status, 202);
    assert.equal(first.body.state, 'outcome_unknown');
    assert.equal(first.body.code, 'PEER_OUTCOME_UNKNOWN');
    assert.equal(calls, 1);
    const row = createForwardLedger(target.homeDir).read(inboundRowKey(body.idempotency_key));
    assert.equal(row && row.state, 'accepted');
    assert.equal(row.remote_status, 200);
    await waitFor(() => frames.length === 1, { description: 'one remote injection (control leg)' });
    const replay = await invokeRoute(forward, req);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.state, 'outcome_unknown');
    assert.equal(calls, 1);
    const query = await invokeRoute(receipt, { params: { key: body.idempotency_key } });
    assert.equal(query.status, 200);
    assert.equal(query.body.state, 'outcome_unknown');
    assert.equal(frames.length, 1);
  });
});
