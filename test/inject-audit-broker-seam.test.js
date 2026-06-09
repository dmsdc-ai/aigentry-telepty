'use strict';

// #47 P5 — broker cross-machine delivery audit seam (spec §9).
// A cross-machine inject forwarded by the broker emits the SAME injects.jsonl schema as a local
// delivery, with origin:"untrusted-remote" and verified_sender_sid:"node:<JWT sub>" (NOT the
// spoofable payload `from`). This is a seam only — #42's ACL/auth/delivery logic is unchanged.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createBrokerServer } = require('../src/transport/broker-server');
const { signNodeJwt } = require('../src/protocol/http-auth');
const { parseSseFrame } = require('../src/transport/broker-protocol');
const { buildAuditLine } = require('../src/audit/inject-log');

const JWT_SECRET = 'test-broker-jwt-secret';
const ENROLL_SECRET = 'fleet-enroll-secret';

function mint(node, overrides = {}) {
  return signNodeJwt(JWT_SECRET, { sub: node, fleet: 'default', iat: 1_800_000_000, exp: 1_900_000_000, ...overrides });
}

function request(port, method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    if (token) h['authorization'] = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let j = null; try { j = buf ? JSON.parse(buf) : null; } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function openStream(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/broker/stream', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`stream ${res.statusCode}`));
      const frames = [];
      const waiters = [];
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!raw.trim() || raw.startsWith(':')) continue;
          const frame = parseSseFrame(raw);
          frames.push(frame);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(frame)) { waiters[i].resolve(frame); waiters.splice(i, 1); }
          }
        }
      });
      resolve({
        nextFrame(pred = () => true) {
          const f = frames.find(pred);
          return f ? Promise.resolve(f) : new Promise((r) => waiters.push({ pred, resolve: r }));
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let httpServer;
let broker;
let port;
let auditRecords;

function startBroker() {
  auditRecords = [];
  broker = createBrokerServer({
    jwtSecret: JWT_SECRET,
    enrollSecret: ENROLL_SECRET,
    broadcastBusEvent: () => {},
    heartbeatMs: 60_000,
    onInjectAudit: (rec) => auditRecords.push(rec),
  });
  return broker;
}

before(() => new Promise((resolve) => {
  startBroker();
  httpServer = http.createServer((req, res) => broker.handler(req, res));
  httpServer.listen(0, '127.0.0.1', () => { port = httpServer.address().port; resolve(); });
}));

after(() => new Promise((resolve) => { broker.close(); httpServer.close(() => resolve()); }));

beforeEach(() => { startBroker(); });

test('P5: cross-machine inject emits a shared-schema audit record (untrusted-remote, node:<sub>)', async () => {
  broker.grant('nodeA', 'nodeB');
  const stream = await openStream(port, mint('nodeB'));

  const injectP = request(port, 'POST', '/broker/inject', {
    token: mint('nodeA'),
    body: { to_node: 'nodeB', to_session: 'sess1', inject_id: 'inj-seam-1', payload: { prompt: 'cross-machine hello', from: 'orchestrator' } },
  });
  await stream.nextFrame((f) => f.event === 'inject');
  // ack so the held response settles (keeps the test from leaking a pending socket).
  await request(port, 'POST', '/broker/ack', { token: mint('nodeB'), body: { inject_id: 'inj-seam-1', success: true } });
  await injectP;

  assert.equal(auditRecords.length, 1, 'exactly one audit record for the forwarded inject');
  const rec = auditRecords[0];
  assert.equal(rec.inject_id, 'inj-seam-1');
  assert.equal(rec.origin, 'untrusted-remote');
  assert.equal(rec.origin_host, 'nodeA');
  assert.equal(rec.verified_sender_sid, 'node:nodeA', 'verified sender is the JWT sub, not payload.from');
  assert.equal(rec.claimed_from, 'orchestrator', 'claimed_from preserves the spoofable payload from');
  assert.equal(rec.to, 'sess1');
  assert.equal(rec.delivery_result, 'success');

  stream.close();
});

test('P5: the broker record funnels through the SAME buildAuditLine schema v1 as local deliveries', async () => {
  broker.grant('nodeA', 'nodeB');
  const stream = await openStream(port, mint('nodeB'));
  const injectP = request(port, 'POST', '/broker/inject', {
    token: mint('nodeA'),
    body: { to_node: 'nodeB', to_session: 'sess9', inject_id: 'inj-seam-2', payload: { prompt: 'schema check', from: 'worker-x' } },
  });
  await stream.nextFrame((f) => f.event === 'inject');
  await request(port, 'POST', '/broker/ack', { token: mint('nodeB'), body: { inject_id: 'inj-seam-2', success: true } });
  await injectP;

  // The daemon wires onInjectAudit → auditAppend → buildAuditLine; emulate that here and assert
  // a valid schema-v1 line results (spoof_suspected derived: claimed 'worker-x' != verified node).
  const line = JSON.parse(buildAuditLine(auditRecords[0]));
  assert.equal(line.v, 1);
  assert.equal(line.origin, 'untrusted-remote');
  assert.equal(line.verified_sender_sid, 'node:nodeA');
  assert.equal(line.spoof_suspected, true, "claimed 'worker-x' != verified 'node:nodeA' → spoof visible");
  assert.equal(line.payload_preview, null, 'hash-only default — no cross-machine prompt content on disk');
  assert.ok(typeof line.payload_sha256 === 'string' && line.payload_sha256.length === 64);

  stream.close();
});
