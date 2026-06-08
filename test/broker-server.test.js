'use strict';

// Host-runnable security suite for the broker-server (spec §7). The server is
// mounted on a THROWAWAY http server bound to an EPHEMERAL port (port 0) — it never
// touches the live telepty daemon (3848). Covers §7 security: 401 bad-JWT,
// 403 ACL escalation block + default-deny proof, enroll secret-gate, anti-squat 409,
// rate-limit/cap 429, revocation, audit/bus event, sync ack round-trip, backpressure.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createBrokerServer } = require('../src/transport/broker-server');
const { signNodeJwt } = require('../src/protocol/http-auth');
const { parseSseFrame } = require('../src/transport/broker-protocol');

const JWT_SECRET = 'test-broker-jwt-secret';
const ENROLL_SECRET = 'fleet-enroll-secret';

function mint(node, overrides = {}) {
  const iat = 1_800_000_000;
  return signNodeJwt(JWT_SECRET, { sub: node, fleet: 'default', iat, exp: 1_900_000_000, ...overrides });
}

// --- tiny HTTP client over the ephemeral port -------------------------------------

function request(port, method, path, { token, enrollSecret, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (data) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    if (token) h['authorization'] = `Bearer ${token}`;
    if (enrollSecret !== undefined) h['x-telepty-enroll'] = enrollSecret;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let buf = '';
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

// Hold an SSE stream; resolve frames matching a predicate. Rejects on non-200.
function openStream(port, token, { lastEventId } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
    if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/broker/stream', headers }, (res) => {
      if (res.statusCode !== 200) {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => reject(Object.assign(new Error(`stream status ${res.statusCode}`), { status: res.statusCode, raw: b })));
        return;
      }
      const frames = [];
      const waiters = [];
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw.trim() || raw.startsWith(':')) continue; // skip comments/heartbeats
          const frame = parseSseFrame(raw);
          frames.push(frame);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(frame)) {
              waiters[i].resolve(frame);
              waiters.splice(i, 1);
            }
          }
        }
      });
      resolve({
        nextFrame(pred = () => true) {
          const found = frames.find(pred);
          if (found) return Promise.resolve(found);
          return new Promise((r) => waiters.push({ pred, resolve: r }));
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// --- shared fixtures ---------------------------------------------------------------

let httpServer;
let broker;
let port;
let busEvents;

function startBroker(opts = {}) {
  busEvents = [];
  broker = createBrokerServer({
    jwtSecret: JWT_SECRET,
    enrollSecret: ENROLL_SECRET,
    broadcastBusEvent: (e) => busEvents.push(e),
    heartbeatMs: 60_000,
    ...opts,
  });
  return broker;
}

before(() => new Promise((resolve) => {
  startBroker();
  httpServer = http.createServer((req, res) => broker.handler(req, res));
  httpServer.listen(0, '127.0.0.1', () => {
    port = httpServer.address().port;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  broker.close();
  httpServer.close(() => resolve());
}));

beforeEach(() => {
  // Reset broker state between tests by swapping the instance (same http server).
  startBroker();
});

// --- §7(a) auth: bad/expired JWT → 401 on register/stream --------------------------

test('register with missing JWT → 401', async () => {
  const res = await request(port, 'POST', '/broker/register', { body: { sessions: [] } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('register with wrong-signature JWT → 401', async () => {
  const bad = signNodeJwt('not-the-secret', { sub: 'nodeA', exp: 1_900_000_000 });
  const res = await request(port, 'POST', '/broker/register', { token: bad, body: {} });
  assert.equal(res.status, 401);
});

test('stream with expired JWT → 401', async () => {
  const expired = mint('nodeA', { exp: 1 }); // 1970
  await assert.rejects(openStream(port, expired), (err) => err.status === 401);
});

test('register with valid JWT → 200', async () => {
  const res = await request(port, 'POST', '/broker/register', { token: mint('nodeA'), body: { sessions: ['s1'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.node, 'nodeA');
});

// --- §7 enroll: secret gate (T7) ---------------------------------------------------

test('enroll with correct secret → 200 + minted JWT', async () => {
  const res = await request(port, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'nodeNew' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.node, 'nodeNew');
  assert.ok(typeof res.body.jwt === 'string' && res.body.jwt.split('.').length === 3);
  // Minted JWT works on a protected endpoint.
  const reg = await request(port, 'POST', '/broker/register', { token: res.body.jwt, body: {} });
  assert.equal(reg.status, 200);
});

test('enroll with wrong secret → 401', async () => {
  const res = await request(port, 'POST', '/broker/enroll', { enrollSecret: 'wrong', body: { node: 'nodeX' } });
  assert.equal(res.status, 401);
});

test('enroll with missing secret → 401', async () => {
  const res = await request(port, 'POST', '/broker/enroll', { body: { node: 'nodeX' } });
  assert.equal(res.status, 401);
});

// --- §7(h) DEFAULT-DENY PROOF: enrolled ≠ authorized — the core §4.6 argument -------

test('freshly-enrolled node inject → 403 (default-deny, enrolled ≠ authorized)', async () => {
  const enroll = await request(port, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'fresh' } });
  assert.equal(enroll.status, 200);
  // ACL written empty on enroll → cannot inject anyone.
  assert.deepEqual(broker.aclTable.fresh, []);
  const res = await request(port, 'POST', '/broker/inject', {
    token: enroll.body.jwt,
    body: { to_node: 'nodeB', to_session: 's1', payload: { prompt: 'hi' } },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

// --- §7(b) ACL escalation block — T2 ----------------------------------------------

test('inject to a target NOT in ACL → 403 (T2 escalation blocked)', async () => {
  const res = await request(port, 'POST', '/broker/inject', {
    token: mint('nodeA'),
    body: { to_node: 'nodeB', to_session: 's1', payload: { prompt: 'hi' } },
  });
  assert.equal(res.status, 403);
});

// --- §7(i) anti-squat: duplicate name without ownership-JWT → 409 ------------------

test('duplicate-name enroll without ownership JWT → 409; rotation with owner JWT → 200', async () => {
  const first = await request(port, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'dup' } });
  assert.equal(first.status, 200);

  const squat = await request(port, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'dup' } });
  assert.equal(squat.status, 409);
  assert.equal(squat.body.code, 'NAME_TAKEN');

  // Owner re-enroll (rotation) carrying the current valid JWT → fresh JWT.
  const rotate = await request(port, 'POST', '/broker/enroll', { token: first.body.jwt, body: { node: 'dup' } });
  assert.equal(rotate.status, 200);
  assert.ok(typeof rotate.body.jwt === 'string');
});

// --- §7(j) rate-limit + global cap → 429 ------------------------------------------

test('enroll rate-limit (>5/min one IP) → 429', async () => {
  const b = startBroker({ enrollRatePerMin: 5 });
  const srv = http.createServer((req, res) => b.handler(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(p, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: `rl${i}` } });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(statuses[5], 429);
  } finally {
    b.close();
    await new Promise((r) => srv.close(r));
  }
});

test('global node cap exceeded → 429', async () => {
  const b = startBroker({ maxNodes: 2 });
  const srv = http.createServer((req, res) => b.handler(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  try {
    assert.equal((await request(p, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'c1' } })).status, 200);
    assert.equal((await request(p, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'c2' } })).status, 200);
    const capped = await request(p, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'c3' } });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.code, 'ENROLL_CAP');
  } finally {
    b.close();
    await new Promise((r) => srv.close(r));
  }
});

// --- §7(k) revocation — revoked node JWT rejected on /broker/* ----------------------

test('revoked node JWT → rejected on /broker/*', async () => {
  broker.revokedNodes.add('nodeA');
  const res = await request(port, 'POST', '/broker/register', { token: mint('nodeA'), body: {} });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'REVOKED');
});

// --- §7(l) audit-log + broker_enroll bus event emitted -----------------------------

test('enroll emits audit-log entry and broker_enroll bus event', async () => {
  await request(port, 'POST', '/broker/enroll', { enrollSecret: ENROLL_SECRET, body: { node: 'audited' } });
  const entry = broker.auditLog.find((e) => e.node === 'audited');
  assert.ok(entry, 'audit-log entry recorded');
  assert.equal(entry.result, 'enrolled');
  const event = busEvents.find((e) => e.type === 'broker_enroll' && e.node === 'audited');
  assert.ok(event, 'broker_enroll bus event emitted');
});

test('failed enroll (wrong secret) is still audited', async () => {
  await request(port, 'POST', '/broker/enroll', { enrollSecret: 'wrong', body: { node: 'evil' } });
  const entry = broker.auditLog.find((e) => e.node === 'evil');
  assert.ok(entry);
  assert.equal(entry.result, 'unauthorized');
});

// --- inject ack round-trip resolves (§3.1 sync parity) -----------------------------

test('inject ack round-trip: held response resolves on target ack', async () => {
  // Authorize nodeA → nodeB, connect B's stream.
  broker.grant('nodeA', 'nodeB');
  const stream = await openStream(port, mint('nodeB'));

  const injectId = 'inj-rt-1';
  const injectP = request(port, 'POST', '/broker/inject', {
    token: mint('nodeA'),
    body: { to_node: 'nodeB', to_session: 'sess1', inject_id: injectId, message_id: 'm-1', payload: { prompt: 'ping' } },
  });

  // B receives the inject envelope over SSE.
  const frame = await stream.nextFrame((f) => f.event === 'inject');
  assert.equal(frame.data.inject_id, injectId);
  assert.equal(frame.data.to_session, 'sess1');
  assert.equal(frame.data.from_node, 'nodeA');

  // B acks → originating /broker/inject resolves with ack.
  const ack = await request(port, 'POST', '/broker/ack', {
    token: mint('nodeB'),
    body: { inject_id: injectId, success: true },
  });
  assert.equal(ack.status, 200);

  const injectRes = await injectP;
  assert.equal(injectRes.status, 200);
  assert.equal(injectRes.body.status, 'ack');
  assert.equal(injectRes.body.success, true);
  stream.close();
});

test('inject to a node with no live stream → unreachable', async () => {
  broker.grant('nodeA', 'ghost');
  const res = await request(port, 'POST', '/broker/inject', {
    token: mint('nodeA'),
    body: { to_node: 'ghost', to_session: 's', payload: { prompt: 'x' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'unreachable');
});

// --- backpressure → node_backlogged (§3.3) -----------------------------------------

test('backpressure: queue overflow resolves the oldest inject with node_backlogged', async () => {
  const b = startBroker({ maxQueue: 1 });
  const srv = http.createServer((req, res) => b.handler(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  try {
    b.grant('nodeA', 'nodeB');
    const stream = await openStream(p, mint('nodeB'));

    // First inject is held (delivered, awaiting ack) — fills the queue (depth 1).
    const first = request(p, 'POST', '/broker/inject', {
      token: mint('nodeA'),
      body: { to_node: 'nodeB', to_session: 's', inject_id: 'i1', payload: { prompt: '1' } },
    });
    await stream.nextFrame((f) => f.data && f.data.inject_id === 'i1');

    // Second inject overflows the bounded queue → oldest (i1) is drop-resolved.
    const second = request(p, 'POST', '/broker/inject', {
      token: mint('nodeA'),
      body: { to_node: 'nodeB', to_session: 's', inject_id: 'i2', payload: { prompt: '2' } },
    });
    await stream.nextFrame((f) => f.data && f.data.inject_id === 'i2');

    const firstRes = await first;
    assert.equal(firstRes.body.status, 'node_backlogged');

    // i2 is still in-flight; ack it to settle cleanly.
    await request(p, 'POST', '/broker/ack', { token: mint('nodeB'), body: { inject_id: 'i2', success: true } });
    const secondRes = await second;
    assert.equal(secondRes.body.status, 'ack');
    stream.close();
  } finally {
    b.close();
    await new Promise((r) => srv.close(r));
  }
});

// --- TLS gate (§4.4): plaintext rejected when TLS configured ------------------------

test('plaintext request rejected with TLS_REQUIRED when requireTls set', async () => {
  const b = startBroker({ requireTls: true });
  const srv = http.createServer((req, res) => b.handler(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  try {
    const res = await request(p, 'POST', '/broker/register', { token: mint('nodeA'), body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'TLS_REQUIRED');
  } finally {
    b.close();
    await new Promise((r) => srv.close(r));
  }
});

// --- sessions aggregation tags peerName=host=<node> --------------------------------

test('GET /broker/sessions aggregates sessions tagged peerName=host=<node>', async () => {
  await request(port, 'POST', '/broker/register', { token: mint('nodeA'), body: { sessions: [{ id: 'a1' }] } });
  await request(port, 'POST', '/broker/register', { token: mint('nodeB'), body: { sessions: [{ id: 'b1' }] } });
  const res = await request(port, 'GET', '/broker/sessions', { token: mint('nodeA') });
  assert.equal(res.status, 200);
  const a1 = res.body.sessions.find((s) => s.id === 'a1');
  assert.equal(a1.peerName, 'nodeA');
  assert.equal(a1.host, 'nodeA');
});
