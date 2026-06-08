'use strict';

// W3/T5 — daemon.js broker wiring (spec §2F, §4.3, §5). Additive, default-OFF.
//
// SAFETY: this suite NEVER touches the live telepty daemon (port 3848). Every
// server it spins binds an EPHEMERAL port (0) in-process and is torn down in
// teardown; the node-mode client factory is MOCKED (no real SSE / network).
//
// Coverage:
//  - broker-mode: with required env + TELEPTY_BROKER_MODE → /broker/* routes to
//    the mounted broker-server (a real request reaches it), mounted BEFORE
//    express.json (raw body still readable).
//  - fail-fast: a missing required broker env throws loudly at mount.
//  - node-mode: broker config present → broker-client started with
//    deliver === deliverInjectionToSession (in-process), and NO daemon token on
//    the wire (§4.3 credential boundary).
//  - default-OFF: no broker config ⇒ client NOT started (§5 backward-compat).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const daemon = require('../daemon');

const JWT_SECRET = 'test-broker-jwt-secret';
const ENROLL_SECRET = 'fleet-enroll-secret';

function brokerModeEnv(overrides = {}) {
  return {
    mode: true,
    jwtSecret: JWT_SECRET,
    enrollSecret: ENROLL_SECRET,
    tlsCert: '/nonexistent/cert.pem',
    tlsKey: '/nonexistent/key.pem',
    aclPath: '/nonexistent/broker-acl.json',
    revokedPath: '/nonexistent/broker-revoked.json',
    configPath: '/nonexistent/broker.json',
    maxNodes: 256,
    url: null,
    jwt: null,
    node: null,
    pin: null,
    ...overrides,
  };
}

// tiny HTTP client over the ephemeral port (mirrors broker-server.test.js)
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
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- broker-mode -----------------------------------------------------------------

test('broker-mode: mounts broker-server at /broker/* before express.json (real request routes through)', async () => {
  const app = express();
  // Same ordering as daemon.js: broker mount BEFORE express.json so the broker
  // reads the raw request stream itself (its own JWT gate).
  const broker = daemon.mountBrokerMode(app, { env: brokerModeEnv(), requireTls: false });
  app.use(express.json());
  // a normal route after json, to prove non-broker traffic still flows
  app.get('/ping', (req, res) => res.json({ pong: true }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // POST with a JSON body reaches the broker (proves mounted before express.json)
    const enroll = await request(port, 'POST', '/broker/enroll', {
      enrollSecret: ENROLL_SECRET,
      body: { node: 'nodeX', pin_ack: 'sha256:deadbeef' },
    });
    assert.equal(enroll.status, 200, 'enroll routed to broker-server');
    assert.equal(enroll.body.ok, true);
    assert.ok(typeof enroll.body.jwt === 'string' && enroll.body.jwt.length > 0, 'broker minted a node JWT');

    // wrong enroll secret → broker's own 401 (still proves routing to broker)
    const denied = await request(port, 'POST', '/broker/enroll', {
      enrollSecret: 'wrong',
      body: { node: 'nodeY' },
    });
    assert.equal(denied.status, 401);

    // non-broker route untouched
    const ping = await request(port, 'GET', '/ping');
    assert.deepEqual(ping.body, { pong: true });
  } finally {
    if (broker && broker.close) broker.close();
    await new Promise((r) => server.close(r));
  }
});

test('broker-mode: fail-fast loud error when a required broker env is missing', () => {
  const app = express();
  assert.throws(
    () => daemon.mountBrokerMode(app, { env: brokerModeEnv({ jwtSecret: null }) }),
    /TELEPTY_JWT_SECRET/,
  );
  assert.throws(
    () => daemon.mountBrokerMode(app, { env: brokerModeEnv({ enrollSecret: null }) }),
    /TELEPTY_ENROLL_SECRET/,
  );
  assert.throws(
    () => daemon.mountBrokerMode(app, { env: brokerModeEnv({ tlsCert: null }) }),
    /TELEPTY_TLS_CERT/,
  );
});

// --- node-mode -------------------------------------------------------------------

test('node-mode: broker config present → starts client with deliver=deliverInjectionToSession (NO daemon token)', () => {
  let captured = null;
  let startCalls = 0;
  const fakeFactory = (opts) => {
    captured = opts;
    return { start: () => { startCalls += 1; return Promise.resolve(); }, stop() {} };
  };

  const client = daemon.startNodeBrokerClient({
    config: { url: 'https://broker.intranet:8443', jwt: 'node-jwt-123', node: 'nodeA', pin: null, accept_from: null },
    createBrokerClient: fakeFactory,
    autostart: true,
  });

  assert.ok(client, 'client created');
  assert.equal(startCalls, 1, 'client.start() invoked');
  assert.ok(captured, 'factory invoked');
  assert.equal(captured.url, 'https://broker.intranet:8443');
  assert.equal(captured.nodeJwt, 'node-jwt-123');
  // §4.3 credential boundary: delivery is in-process via deliverInjectionToSession,
  // and the daemon token NEVER appears in the client options.
  assert.equal(captured.deliver, daemon.deliverInjectionToSession, 'deliver wired to in-process deliverInjectionToSession');
  assert.ok(!('expectedToken' in captured), 'no expectedToken on the wire');
  assert.ok(!('token' in captured), 'no daemon token on the wire');
  assert.ok(!('expected_token' in captured), 'no daemon token on the wire');
});

test('node-mode default-OFF: no broker config ⇒ client NOT started (§5 backward-compat)', () => {
  let called = false;
  const spyFactory = () => { called = true; return { start() { return Promise.resolve(); }, stop() {} }; };

  const result = daemon.startNodeBrokerClient({
    env: brokerModeEnv({ mode: false, url: null, jwt: null }),
    readFile: () => { throw new Error('ENOENT'); }, // no broker.json
    createBrokerClient: spyFactory,
  });

  assert.equal(result, null, 'startNodeBrokerClient returns null when unconfigured');
  assert.equal(called, false, 'broker-client factory NOT invoked (default-OFF)');
});

test('node-mode config: env TELEPTY_BROKER_URL + TELEPTY_BROKER_JWT resolves config; absent ⇒ null', () => {
  const fromEnv = daemon.loadNodeBrokerConfig({
    env: brokerModeEnv({ url: 'https://b:8443', jwt: 'jwt-xyz', node: 'nodeB' }),
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.ok(fromEnv);
  assert.equal(fromEnv.url, 'https://b:8443');
  assert.equal(fromEnv.jwt, 'jwt-xyz');
  assert.equal(fromEnv.node, 'nodeB');

  const none = daemon.loadNodeBrokerConfig({
    env: brokerModeEnv({ url: null, jwt: null }),
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(none, null);
});
