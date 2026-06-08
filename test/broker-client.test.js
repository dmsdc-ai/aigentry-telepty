'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');

const { buildSseInjectFrame } = require('../src/transport/broker-protocol');
const { createBrokerClient } = require('../src/transport/broker-client');

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJSaiiozdYkWMxgJI
d0/XDRW9KwgWYjitoOybeBmBuxmhRANCAAS6dC7zgTgBFZd7Fij8qNNoyNdVS+z1
X4cFwj9rUgpUjQpmc5/Ux7W/C5aO0Hday704fRXPum0A/1becBOMcdUP
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUFWCDQ4D7C+SxwihEzOvO8gUiU4EwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYwODExNTEzOVoXDTI2MDYwOTEx
NTEzOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEunQu84E4ARWXexYo/KjTaMjXVUvs9V+HBcI/a1IKVI0KZnOf1Me1vwuW
jtB3Wsu9OH0Vz7ptAP9W3nATjHHVD6NTMFEwHQYDVR0OBBYEFHTOPtb1ubnmYNzk
z/W8o6mWERU7MB8GA1UdIwQYMBaAFHTOPtb1ubnmYNzkz/W8o6mWERU7MA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgPxMQUFZt4LpQQgxpbuFg7lE4
wqEbTvQjscqNriZn7jICIQDoLSMFCsrhdrVeAdeAtLgkVCPo7zOwRGewkNn552T7
fw==
-----END CERTIFICATE-----`;

const TLS_PIN = `sha256:${new crypto.X509Certificate(TLS_CERT).fingerprint256.replace(/:/g, '').toLowerCase()}`;

test('SSE inject delivers in-process, acks after delivery, and keeps daemon token off broker requests', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const priorExpectedToken = process.env.EXPECTED_TOKEN;
  process.env.EXPECTED_TOKEN = 'daemon-token-must-not-transit';
  t.after(() => {
    if (priorExpectedToken === undefined) {
      delete process.env.EXPECTED_TOKEN;
    } else {
      process.env.EXPECTED_TOKEN = priorExpectedToken;
    }
  });

  const session = { id: 'session-1' };
  const deliveries = [];
  const client = createBrokerClient({
    url: broker.url,
    node: 'nodeB',
    nodeJwt: 'node-jwt',
    pin: TLS_PIN,
    getSessions: () => [{ id: 'session-1' }],
    getSession: (id) => (id === 'session-1' ? session : null),
    deliver: async (...args) => {
      deliveries.push(args);
      return { success: true };
    },
    heartbeatMs: 0,
    reconnectInitialMs: 1000,
    reconnectMaxMs: 1000,
  });
  t.after(() => client.stop());

  await client.start();
  const stream = await broker.waitForStream(0);
  stream.write(buildSseInjectFrame(5, makeEnvelope({
    payload: { prompt: 'hello broker', from: 'sender-sid', reply_to: 'reply-sid', no_enter: true },
  })));

  const ack = await broker.waitForRequest((req) => req.method === 'POST' && req.url === '/broker/ack');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0][0], 'session-1');
  assert.equal(deliveries[0][1], session);
  assert.equal(deliveries[0][2], 'hello broker');
  assert.deepEqual(deliveries[0][3], {
    noEnter: true,
    source: 'broker',
    from: 'sender-sid',
    replyTo: 'reply-sid',
  });
  assert.deepEqual(ack.body, {
    type: 'ack',
    inject_id: 'inject-1',
    success: true,
    code: null,
    error: null,
  });

  for (const request of broker.requests) {
    assert.equal(request.headers.authorization, 'Bearer node-jwt');
    assert.equal(JSON.stringify([request.headers, request.body]).includes('daemon-token-must-not-transit'), false);
  }
});

test('reconnect sends Last-Event-ID from the last received SSE frame', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const client = createBrokerClient({
    url: broker.url,
    node: 'nodeB',
    nodeJwt: 'node-jwt',
    pin: TLS_PIN,
    getSession: (id) => ({ id }),
    deliver: async () => ({ success: true }),
    heartbeatMs: 0,
    reconnectInitialMs: 10,
    reconnectMaxMs: 10,
    reconnectJitterMs: 0,
  });
  t.after(() => client.stop());

  await client.start();
  const firstStream = await broker.waitForStream(0);
  firstStream.write(buildSseInjectFrame(12, makeEnvelope()));
  await broker.waitForRequest((req) => req.method === 'POST' && req.url === '/broker/ack');
  firstStream.end();

  const reconnect = await broker.waitForRequest((req) => (
    req.method === 'GET' &&
    req.url === '/broker/stream' &&
    req.headers['last-event-id'] === '12'
  ));
  assert.equal(reconnect.headers['last-event-id'], '12');
});

test('duplicate message_id is delivered once even when redelivered', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const deliveries = [];
  const client = createBrokerClient({
    url: broker.url,
    node: 'nodeB',
    nodeJwt: 'node-jwt',
    pin: TLS_PIN,
    getSession: (id) => ({ id }),
    deliver: async (...args) => {
      deliveries.push(args);
      return { success: true };
    },
    heartbeatMs: 0,
    reconnectInitialMs: 1000,
    reconnectMaxMs: 1000,
  });
  t.after(() => client.stop());

  await client.start();
  const stream = await broker.waitForStream(0);
  stream.write(buildSseInjectFrame(1, makeEnvelope({ message_id: 'msg-duplicate' })));
  stream.write(buildSseInjectFrame(2, makeEnvelope({ message_id: 'msg-duplicate' })));

  await waitFor(() => deliveries.length === 1);
  await sleep(40);
  assert.equal(deliveries.length, 1);
});

test('accept_from deny acks without calling deliver', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const deliveries = [];
  const client = createBrokerClient({
    url: broker.url,
    node: 'nodeB',
    nodeJwt: 'node-jwt',
    pin: TLS_PIN,
    acceptFrom: { allow: ['nodeA'] },
    getSession: (id) => ({ id }),
    deliver: async (...args) => {
      deliveries.push(args);
      return { success: true };
    },
    heartbeatMs: 0,
    reconnectInitialMs: 1000,
    reconnectMaxMs: 1000,
  });
  t.after(() => client.stop());

  await client.start();
  const stream = await broker.waitForStream(0);
  stream.write(buildSseInjectFrame(1, makeEnvelope({ from_node: 'nodeDenied' })));

  const ack = await broker.waitForRequest((req) => req.method === 'POST' && req.url === '/broker/ack');
  assert.equal(deliveries.length, 0);
  assert.equal(ack.body.success, false);
  assert.equal(ack.body.code, 'ACCEPT_FROM_DENIED');
});

test('originating inject posts the envelope upstream with node JWT auth', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const client = createBrokerClient({
    url: broker.url,
    node: 'nodeA',
    nodeJwt: 'node-jwt',
    pin: TLS_PIN,
    deliver: async () => ({ success: true }),
    heartbeatMs: 0,
    reconnectInitialMs: 1000,
    reconnectMaxMs: 1000,
  });
  t.after(() => client.stop());

  const result = await client.inject(makeEnvelope({ to_node: 'nodeB', to_session: 'session-9' }));
  const request = await broker.waitForRequest((req) => req.method === 'POST' && req.url === '/broker/inject');
  assert.equal(request.headers.authorization, 'Bearer node-jwt');
  assert.equal(request.body.to_session, 'session-9');
  assert.deepEqual(result, { ok: true });
});

test('TLS pin mismatch rejects the broker connection', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const client = createBrokerClient({
    url: broker.url,
    node: 'nodeB',
    nodeJwt: 'node-jwt',
    pin: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    deliver: async () => ({ success: true }),
    heartbeatMs: 0,
    reconnect: false,
  });
  t.after(() => client.stop());

  await assert.rejects(() => client.start(), /TLS pin mismatch/);
});

function makeEnvelope(overrides = {}) {
  return {
    type: 'inject',
    message_id: overrides.message_id || 'msg-1',
    inject_id: overrides.inject_id || 'inject-1',
    target: overrides.target || `${overrides.to_session || 'session-1'}@${overrides.to_node || 'nodeB'}`,
    to_node: overrides.to_node || 'nodeB',
    to_session: overrides.to_session || 'session-1',
    from_node: overrides.from_node || 'nodeA',
    source_host: overrides.source_host || overrides.from_node || 'nodeA',
    payload: overrides.payload || {
      prompt: 'hello',
      from: 'sender-sid',
      reply_to: 'reply-sid',
      no_enter: false,
    },
  };
}

async function startBroker() {
  const requests = [];
  const streams = [];
  const waiters = [];
  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : null,
      };
      requests.push(request);

      if (req.method === 'GET' && req.url === '/broker/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.flushHeaders();
        streams.push(res);
        wake(waiters);
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      wake(waiters);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `https://127.0.0.1:${port}`,
    requests,
    streams,
    waitForRequest: (predicate) => waitFor(() => requests.find(predicate), waiters, 1000, 'request'),
    waitForStream: (index) => waitFor(() => streams[index], waiters, 1000, 'stream'),
    close: () => new Promise((resolve) => {
      for (const stream of streams) {
        stream.end();
      }
      server.close(resolve);
    }),
  };
}

function waitFor(predicate, waiters = [], timeoutMs = 1000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      const timer = setTimeout(check, 5);
      timer.unref?.();
    };
    waiters.push(check);
    check();
  });
}

function wake(waiters) {
  for (const waiter of waiters.splice(0)) {
    waiter();
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
