'use strict';

// End-to-end integration + cross-cutting security proof for the #42 broker MVP
// (spec docs/specs/2026-06-08-broker-mvp-implementation.md §7 / §3 / §4).
//
// This is the headline "broker MVP works" acceptance test: it wires the REAL
// `createBrokerServer` and the REAL `createBrokerClient` together over a real
// HTTPS server (self-signed cert + fingerprint-pin, §4.4) on EPHEMERAL ports
// (listen 0 — never the live daemon on 3848), with TWO node clients that connect
// ONLY to the broker. There is no direct A<->B channel — client-isolation is the
// whole point of the topology, so the only path nodeA's inject can reach nodeB is
// through the broker relay.
//
// NO-HANG contract (the T3 lesson): every node client (.stop()) + the broker
// (.close(), which ends held streams and settles pending injects) + the HTTPS
// server (.close()) are torn down via t.after() so `node --test` EXITS cleanly.
//
// Faithful-behaviour note: the landed broker buffers *delivered* frames in a
// bounded per-node replay window (at-least-once) and, on reconnect with
// Last-Event-ID, redelivers frames after that id — the receiving node dedups by
// message_id to collapse them to exactly-once. An inject to a *fully
// disconnected* node returns `unreachable` (request/reply parity — never silent
// loss), not a silent buffer. Both guarantees are asserted below.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const { createBrokerServer } = require('../src/transport/broker-server');
const { createBrokerClient } = require('../src/transport/broker-client');
const { createMessageIdDeduper } = require('../src/transport/broker-protocol');
const { signNodeJwt } = require('../src/protocol/http-auth');

// --- self-signed TLS fixture (EC P-256, CN=localhost, SAN 127.0.0.1, ~10y) --------
// Long-lived so the suite is deterministic and never flakes on cert expiry. The pin
// is the cert's SHA-256 fingerprint, which each broker-client pins (§4.4).

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2HMLmiR3UQCaaN5s
L4ExSl68uPugaPZLTxVq0bItnPKhRANCAAQo6gO2V9qKsBzREJ6/wTxqDpDfEDSO
osb4MGWmhkkTBgk03WCdQIqRvNJwCMRfXX+MR0i1JAvBLcpop05Fx8NH
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUErXeHXfWO5+huSqBn6dTvaRbuzAwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYwODEyMjI0M1oXDTM2MDYwNTEy
MjI0M1owFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEKOoDtlfairAc0RCev8E8ag6Q3xA0jqLG+DBlpoZJEwYJNN1gnUCKkbzS
cAjEX11/jEdItSQLwS3KaKdORcfDR6NvMG0wHQYDVR0OBBYEFJYpg8OH90ofHx3h
lGCqCrv291IDMB8GA1UdIwQYMBaAFJYpg8OH90ofHx3hlGCqCrv291IDMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MAoGCCqGSM49
BAMCA0gAMEUCIQCs2eCCyuRnZvEKxi2ErMUxei+FEEt68aITVD5i8Ad2ogIgZeLC
tymAX3dyPsKgt5KB1BKehFMyDyM9zfgSBBEBEAQ=
-----END CERTIFICATE-----`;

const TLS_PIN = `sha256:${new crypto.X509Certificate(TLS_CERT).fingerprint256.replace(/:/g, '').toLowerCase()}`;

// --- raw test-driver clients (over the ephemeral ports) ---------------------------
// `rejectUnauthorized:false` is the test DRIVER bypass — the production path is the
// real broker-client which pins the fingerprint (exercised separately below).

function rawRequest(url, method, path, { token, enrollSecret, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (data) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    if (token) h['authorization'] = `Bearer ${token}`;
    if (enrollSecret !== undefined) h['x-telepty-enroll'] = enrollSecret;
    const req = https.request(`${url}${path}`, { method, headers: h, rejectUnauthorized: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* non-json */ }
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function rawHttp(port, method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    if (token) h['authorization'] = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* non-json */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const enrollNode = (fleet, node, opts = {}) => rawRequest(fleet.url, 'POST', '/broker/enroll', {
  enrollSecret: opts.enrollSecret,
  token: opts.token,
  body: { node },
});

const injectAs = (fleet, jwt, body) => rawRequest(fleet.url, 'POST', '/broker/inject', { token: jwt, body });

// --- fleet harness: real broker on a real HTTPS server, ephemeral port -------------

async function setupFleet(opts = {}) {
  const jwtSecret = 'int-broker-jwt-secret';
  const enrollSecret = 'int-fleet-enroll-secret';
  const busEvents = [];
  const captured = []; // passive copy of every inbound request (credential-boundary)

  const broker = createBrokerServer({
    jwtSecret,
    enrollSecret,
    requireTls: true, // TLS mandatory day 1 (§4.4)
    heartbeatMs: 60_000,
    broadcastBusEvent: (e) => busEvents.push(e),
    ...opts,
  });

  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    // Passive request capture for the credential-boundary assertion. For POST
    // bodies a second 'data'/'end' listener observes the same chunks the broker
    // reads (EventEmitter fans out to all listeners) without disturbing the
    // broker's own parsing. The held SSE request (GET /broker/stream) is captured
    // by HEADERS ONLY and its body is left untouched: consuming that request to
    // 'end' would trip the broker's `req 'close'` disconnect cleanup and tear the
    // stream down. GET requests carry no body anyway.
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET') {
      captured.push({ method: req.method, url: path, headers: req.headers, body: null, raw: '' });
    } else {
      const chunks = [];
      req.on('data', (c) => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* non-json */ }
        captured.push({ method: req.method, url: path, headers: req.headers, body, raw });
      });
    }
    broker.handler(req, res);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    broker,
    server,
    port,
    url: `https://127.0.0.1:${port}`,
    jwtSecret,
    enrollSecret,
    busEvents,
    captured,
    close: async () => {
      broker.close(); // ends held streams + settles pending injects → no dangling sockets
      await new Promise((r) => server.close(r));
    },
  };
}

function makeNodeClient(fleet, node, jwt, { deliver, sessions, extra } = {}) {
  return createBrokerClient({
    url: fleet.url,
    node,
    nodeJwt: jwt,
    pin: TLS_PIN,
    getSession: (id) => (sessions ? sessions(id) : { id }),
    getSessions: () => [{ id: `${node}-sess` }],
    deliver: deliver || (async () => ({ success: true })),
    heartbeatMs: 0,
    reconnect: false,
    reconnectInitialMs: 50,
    reconnectMaxMs: 50,
    reconnectJitterMs: 0,
    ...(extra || {}),
  });
}

function waitFor(pred, { timeout = 2000, interval = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      let v;
      try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() >= deadline) return reject(new Error('waitFor timed out'));
      const t = setTimeout(tick, interval);
      t.unref?.();
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

// ==================================================================================
// INTEGRATION (loopback, no real network) — the headline acceptance proof
// ==================================================================================

test('integration: inject nodeA → broker → nodeB delivers in-process, acks, originator gets success', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  // Both nodes self-enroll over the automated endpoint → node-JWT identities (§4.6).
  const ea = await enrollNode(fleet, 'nodeA', { enrollSecret: fleet.enrollSecret });
  const eb = await enrollNode(fleet, 'nodeB', { enrollSecret: fleet.enrollSecret });
  assert.equal(ea.status, 200);
  assert.equal(eb.status, 200);
  const jwtA = ea.body.jwt;
  const jwtB = eb.body.jwt;

  // Admin grants injection authz nodeA → nodeB (default-deny otherwise, §4.1).
  fleet.broker.grant('nodeA', 'nodeB');

  // nodeB's daemon-side deliver stub stands in for deliverInjectionToSession.
  const deliveries = [];
  const sessionB = { id: 'sessB-1' };
  const clientB = makeNodeClient(fleet, 'nodeB', jwtB, {
    sessions: (id) => (id === 'sessB-1' ? sessionB : null),
    deliver: async (toSession, session, prompt, options) => {
      deliveries.push({ toSession, session, prompt, options });
      return { success: true };
    },
  });
  t.after(() => clientB.stop());
  await clientB.start();

  // nodeA is the originator — it only POSTs upstream, no held stream needed.
  const clientA = makeNodeClient(fleet, 'nodeA', jwtA, {});
  t.after(() => clientA.stop());

  const result = await clientA.inject({
    message_id: 'm-core-1',
    inject_id: 'i-core-1',
    to_node: 'nodeB',
    to_session: 'sessB-1',
    from_node: 'nodeA',
    payload: { prompt: 'hello over broker', from: 'sidA', reply_to: 'sidA', no_enter: false },
  });

  // Core flow: A → broker → B's deliver received the right session + payload.
  assert.equal(deliveries.length, 1, 'nodeB delivered exactly once');
  assert.equal(deliveries[0].toSession, 'sessB-1');
  assert.equal(deliveries[0].session, sessionB);
  assert.equal(deliveries[0].prompt, 'hello over broker');
  assert.equal(deliveries[0].options.source, 'broker');
  assert.equal(deliveries[0].options.from, 'sidA');

  // ...and B acked → the held /broker/inject resolved with success to A (§3.1 sync).
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ack');
  assert.equal(result.success, true);

  // Topology proof: the only paths used were B's SSE downstream + A's inject
  // upstream, both to the broker — there is no A<->B server at all.
  const brokerPaths = fleet.captured.map((r) => `${r.method} ${r.url}`);
  assert.ok(brokerPaths.includes('GET /broker/stream'), 'nodeB held the broker SSE downstream');
  assert.ok(brokerPaths.includes('POST /broker/inject'), 'nodeA injected via the broker upstream');
});

test('integration: reconnect with Last-Event-ID redelivers buffered inject, deduped to exactly-once', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  const ea = await enrollNode(fleet, 'nodeA', { enrollSecret: fleet.enrollSecret });
  const eb = await enrollNode(fleet, 'nodeB', { enrollSecret: fleet.enrollSecret });
  const jwtA = ea.body.jwt;
  const jwtB = eb.body.jwt;
  fleet.broker.grant('nodeA', 'nodeB');

  // One deduper shared across nodeB's reconnect epochs — models the persistent
  // daemon-held client whose dedup set survives a dropped SSE channel.
  const deduper = createMessageIdDeduper();
  const deliveries = [];
  const mkB = (lastEventId) => makeNodeClient(fleet, 'nodeB', jwtB, {
    deliver: async (toSession, session, prompt) => { deliveries.push(prompt); return { success: true }; },
    extra: { deduper, lastEventId },
  });

  const b1 = mkB(null);
  t.after(() => b1.stop());
  await b1.start();

  // A injects while B is up → frame delivered (seq 1) and buffered in the replay
  // window; B delivers once and acks.
  const r1 = await injectAs(fleet, jwtA, {
    message_id: 'm-dup-1', inject_id: 'i-dup-1', to_node: 'nodeB', to_session: 'sessB-1', payload: { prompt: 'first' },
  });
  assert.equal(r1.body.status, 'ack');
  await waitFor(() => deliveries.length === 1);

  // Drop B's SSE channel. While fully down, an inject returns `unreachable`
  // (request/reply parity — never silent loss), NOT a silent buffer.
  b1.stop();
  await waitFor(() => !fleet.broker.nodes.get('nodeB').stream);
  const down = await injectAs(fleet, jwtA, {
    message_id: 'm-down', inject_id: 'i-down', to_node: 'nodeB', to_session: 'sessB-1', payload: { prompt: 'while down' },
  });
  assert.equal(down.status, 200);
  assert.equal(down.body.status, 'unreachable');

  // Reopen with an older Last-Event-ID (0) → broker redelivers seq>0 from the
  // replay buffer → the already-seen message_id is deduped → deliver NOT called
  // again, but the redelivered frame is still acked (at-least-once → exactly-once).
  const acksBefore = fleet.captured.filter((r) => r.url === '/broker/ack').length;
  const b2 = mkB('0');
  t.after(() => b2.stop());
  await b2.start();

  await waitFor(() => fleet.captured.filter((r) => r.url === '/broker/ack').length > acksBefore);
  await sleep(60); // settle any further frames
  assert.equal(deliveries.length, 1, 'redelivered buffered inject deduped to exactly-once');
});

test('integration: backpressure — queue overflow resolves the oldest inject with node_backlogged', async (t) => {
  const fleet = await setupFleet({ maxQueue: 1, injectTimeoutMs: 5000 });
  t.after(() => fleet.close());

  const ea = await enrollNode(fleet, 'nodeA', { enrollSecret: fleet.enrollSecret });
  const eb = await enrollNode(fleet, 'nodeB', { enrollSecret: fleet.enrollSecret });
  const jwtA = ea.body.jwt;
  const jwtB = eb.body.jwt;
  fleet.broker.grant('nodeA', 'nodeB');

  const deliveries = [];
  // B's deliver hangs (never acks) so i1 stays in the bounded in-flight queue. The
  // real client processes SSE frames serially, so this also blocks B from acking
  // anything further — exactly the stuck-consumer condition backpressure guards.
  const clientB = makeNodeClient(fleet, 'nodeB', jwtB, {
    deliver: async () => { deliveries.push(1); return new Promise(() => {}); },
  });
  t.after(() => clientB.stop());
  await clientB.start();

  // i1 fills the queue (depth 1) and is held awaiting an ack that never comes.
  const i1 = injectAs(fleet, jwtA, {
    message_id: 'm-bp-1', inject_id: 'i-bp-1', to_node: 'nodeB', to_session: 's', payload: { prompt: '1' },
  });
  await waitFor(() => deliveries.length === 1);

  // i2 overflows the bounded queue → broker drop-resolves the oldest held inject
  // (i1) with node_backlogged rather than dropping it silently (§3.3). Awaiting i1
  // blocks until that overflow settlement happens.
  const i2 = injectAs(fleet, jwtA, {
    message_id: 'm-bp-2', inject_id: 'i-bp-2', to_node: 'nodeB', to_session: 's', payload: { prompt: '2' },
  });
  const firstRes = await i1;
  assert.equal(firstRes.body.status, 'node_backlogged');
  // i2 stays held; fleet.close() settles it cleanly on teardown.
  i2.catch(() => {});
});

// ==================================================================================
// SECURITY (end-to-end, §7) — asserted at the integration layer
// ==================================================================================

test('security: missing / expired node-JWT → 401 on a protected endpoint', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  const noTok = await rawRequest(fleet.url, 'POST', '/broker/register', { body: {} });
  assert.equal(noTok.status, 401);

  const expired = signNodeJwt(fleet.jwtSecret, { sub: 'nodeA', fleet: 'default', iat: 1, exp: 1 }); // 1970
  const exp = await rawRequest(fleet.url, 'POST', '/broker/register', { token: expired, body: {} });
  assert.equal(exp.status, 401);
});

test('security: cross-node inject to a target NOT in the ACL → 403 (T2 escalation blocked)', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  const ea = await enrollNode(fleet, 'nodeA', { enrollSecret: fleet.enrollSecret });
  const eb = await enrollNode(fleet, 'nodeB', { enrollSecret: fleet.enrollSecret });
  fleet.broker.grant('nodeA', 'nodeB'); // nodeB's ACL stays empty

  // nodeB (un-granted) tries to inject nodeA → default-deny → 403.
  const res = await injectAs(fleet, eb.body.jwt, {
    message_id: 'm', inject_id: 'i', to_node: 'nodeA', to_session: 's', payload: { prompt: 'x' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
  // Sanity: the granted direction is allowed (delivered as unreachable since A has no stream).
  const allowed = await injectAs(fleet, ea.body.jwt, {
    message_id: 'm2', inject_id: 'i2', to_node: 'nodeB', to_session: 's', payload: { prompt: 'x' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.status, 'unreachable');
});

test('security: plaintext rejected when TLS required; broker-client refuses a non-https URL', async (t) => {
  // Production client refuses to even construct against a plaintext broker URL.
  assert.throws(
    () => createBrokerClient({ url: 'http://127.0.0.1:1/', node: 'n', nodeJwt: 'j', deliver: async () => ({}) }),
    /https/i,
  );

  // A TLS-required broker mounted on a plain HTTP server rejects the request (§4.4).
  const broker = createBrokerServer({ jwtSecret: 's', enrollSecret: 'e', requireTls: true });
  const srv = http.createServer((req, res) => broker.handler(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { broker.close(); srv.close(r); }));

  const res = await rawHttp(srv.address().port, 'POST', '/broker/register', {
    token: signNodeJwt('s', { sub: 'n', exp: 2_000_000_000 }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TLS_REQUIRED');
});

test('security: duplicate message_id is delivered once even when broker sends two frames', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  const ea = await enrollNode(fleet, 'nodeA', { enrollSecret: fleet.enrollSecret });
  const eb = await enrollNode(fleet, 'nodeB', { enrollSecret: fleet.enrollSecret });
  fleet.broker.grant('nodeA', 'nodeB');

  const deliveries = [];
  const clientB = makeNodeClient(fleet, 'nodeB', eb.body.jwt, {
    deliver: async (toSession, session, prompt) => { deliveries.push(prompt); return { success: true }; },
  });
  t.after(() => clientB.stop());
  await clientB.start();

  // Same message_id, distinct inject_id → broker forwards both; the node dedups.
  const r1 = await injectAs(fleet, ea.body.jwt, {
    message_id: 'dupe', inject_id: 'i1', to_node: 'nodeB', to_session: 's', payload: { prompt: 'once' },
  });
  const r2 = await injectAs(fleet, ea.body.jwt, {
    message_id: 'dupe', inject_id: 'i2', to_node: 'nodeB', to_session: 's', payload: { prompt: 'once' },
  });
  assert.equal(r1.body.status, 'ack');
  assert.equal(r2.body.status, 'ack');
  await sleep(40);
  assert.equal(deliveries.length, 1, 'duplicate message_id deduped to a single delivery');
});

test('security: broker-client outbound carries ONLY the node-JWT, never the daemon EXPECTED_TOKEN (§4.3)', async (t) => {
  const prior = process.env.EXPECTED_TOKEN;
  process.env.EXPECTED_TOKEN = 'daemon-token-MUST-NOT-TRANSIT';
  t.after(() => {
    if (prior === undefined) delete process.env.EXPECTED_TOKEN;
    else process.env.EXPECTED_TOKEN = prior;
  });

  const fleet = await setupFleet();
  t.after(() => fleet.close());

  const ea = await enrollNode(fleet, 'nodeA', { enrollSecret: fleet.enrollSecret });
  const eb = await enrollNode(fleet, 'nodeB', { enrollSecret: fleet.enrollSecret });
  const jwtA = ea.body.jwt;
  const jwtB = eb.body.jwt;
  fleet.broker.grant('nodeA', 'nodeB');

  const clientB = makeNodeClient(fleet, 'nodeB', jwtB, { deliver: async () => ({ success: true }) });
  t.after(() => clientB.stop());
  await clientB.start();

  const clientA = makeNodeClient(fleet, 'nodeA', jwtA, {});
  t.after(() => clientA.stop());
  await clientA.inject({
    message_id: 'm-cb', inject_id: 'i-cb', to_node: 'nodeB', to_session: 'nodeB-sess', from_node: 'nodeA',
    payload: { prompt: 'boundary', from: 'sidA' },
  });

  // Every request the REAL clients made to the broker must carry a node-JWT and
  // must NOT contain the daemon token anywhere (headers or body).
  const clientReqs = fleet.captured.filter((r) => r.url.startsWith('/broker/') && r.url !== '/broker/enroll');
  assert.ok(clientReqs.length > 0, 'captured at least one client→broker request');
  for (const r of clientReqs) {
    assert.ok(
      typeof r.headers.authorization === 'string' && r.headers.authorization.startsWith('Bearer '),
      `${r.method} ${r.url} carries a Bearer node-JWT`,
    );
    const jwt = r.headers.authorization.slice(7);
    assert.ok(jwt === jwtA || jwt === jwtB, 'authorization is a node-JWT (not a daemon token)');
  }
  // No request — client OR enroll-driver — leaked the daemon token.
  for (const r of fleet.captured) {
    assert.equal(
      JSON.stringify({ h: r.headers, b: r.body }).includes('daemon-token-MUST-NOT-TRANSIT'),
      false,
      `${r.method} ${r.url} did not leak EXPECTED_TOKEN`,
    );
  }
});

// --- enroll suite (T7), end-to-end -------------------------------------------------

test('enroll: correct secret mints a JWT; enrolled ≠ authorized (default-deny inject → 403); audit + bus event; wrong secret → 401', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  // (f) correct enroll-secret → 200 + a usable JWT.
  const ok = await enrollNode(fleet, 'fresh', { enrollSecret: fleet.enrollSecret });
  assert.equal(ok.status, 200);
  assert.ok(typeof ok.body.jwt === 'string' && ok.body.jwt.split('.').length === 3);
  const reg = await rawRequest(fleet.url, 'POST', '/broker/register', { token: ok.body.jwt, body: {} });
  assert.equal(reg.status, 200, 'minted JWT authenticates on a protected endpoint');

  // (h) DEFAULT-DENY PROOF — enroll grants identity, never injection.
  assert.deepEqual(fleet.broker.aclTable.fresh, [], 'enroll wrote an EMPTY ACL entry');
  const inj = await injectAs(fleet, ok.body.jwt, {
    message_id: 'm', inject_id: 'i', to_node: 'nodeB', to_session: 's', payload: { prompt: 'x' },
  });
  assert.equal(inj.status, 403, 'freshly-enrolled node cannot inject anyone (default-deny)');

  // (l) audit-log + broker_enroll bus event emitted.
  const entry = fleet.broker.auditLog.find((e) => e.node === 'fresh');
  assert.ok(entry && entry.result === 'enrolled', 'enroll audit-log entry recorded');
  assert.ok(fleet.busEvents.find((e) => e.type === 'broker_enroll' && e.node === 'fresh'), 'broker_enroll bus event emitted');

  // (g) wrong enroll-secret → 401 (and still audited).
  const bad = await enrollNode(fleet, 'evil', { enrollSecret: 'wrong' });
  assert.equal(bad.status, 401);
  assert.ok(fleet.broker.auditLog.find((e) => e.node === 'evil' && e.result === 'unauthorized'));
});

test('enroll: duplicate name without ownership-JWT → 409 (anti-squat); rotation with owner JWT → 200', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  const first = await enrollNode(fleet, 'dup', { enrollSecret: fleet.enrollSecret });
  assert.equal(first.status, 200);

  const squat = await enrollNode(fleet, 'dup', { enrollSecret: fleet.enrollSecret });
  assert.equal(squat.status, 409);
  assert.equal(squat.body.code, 'NAME_TAKEN');

  // Owner re-enroll carrying the current valid JWT (no enroll-secret) → fresh JWT.
  const rotate = await rawRequest(fleet.url, 'POST', '/broker/enroll', { token: first.body.jwt, body: { node: 'dup' } });
  assert.equal(rotate.status, 200);
  assert.ok(typeof rotate.body.jwt === 'string');
});

test('enroll: per-IP rate-limit exceeded → 429', async (t) => {
  const fleet = await setupFleet({ enrollRatePerMin: 3 });
  t.after(() => fleet.close());

  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const r = await enrollNode(fleet, `rl${i}`, { enrollSecret: fleet.enrollSecret });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429, '4th enroll from the same IP within the window is rate-limited');
});

test('enroll: global fleet cap exceeded → 429 ENROLL_CAP', async (t) => {
  const fleet = await setupFleet({ maxNodes: 2 });
  t.after(() => fleet.close());

  assert.equal((await enrollNode(fleet, 'c1', { enrollSecret: fleet.enrollSecret })).status, 200);
  assert.equal((await enrollNode(fleet, 'c2', { enrollSecret: fleet.enrollSecret })).status, 200);
  const capped = await enrollNode(fleet, 'c3', { enrollSecret: fleet.enrollSecret });
  assert.equal(capped.status, 429);
  assert.equal(capped.body.code, 'ENROLL_CAP');
});

test('enroll: a revoked node JWT is rejected on /broker/* (identity kill)', async (t) => {
  const fleet = await setupFleet();
  t.after(() => fleet.close());

  const e = await enrollNode(fleet, 'nodeR', { enrollSecret: fleet.enrollSecret });
  assert.equal(e.status, 200);
  fleet.broker.revokedNodes.add('nodeR');

  const res = await rawRequest(fleet.url, 'POST', '/broker/register', { token: e.body.jwt, body: {} });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'REVOKED');
});
