'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createBrokerHub } = require('../src/broker/hub');
const { createBrokerNode, createBrokerClient } = require('../src/broker/node');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const { createSignedAssertion } = require('../src/principal/proof');
const { createDiscoveryRegistry, validateDiscovery, createDiscoveryAgent } = require('../src/broker/discovery');
const pair = () => crypto.generateKeyPairSync('ed25519');
const entry = (name, key, grants) => ({ key_id: name, principal_id: name, public_key_spki: key.publicKey.export({ type: 'spki', format: 'pem' }), grants });
const grant = (action, targets) => ({ action, targets });
const trust = (audience, keys) => ({ schema: 'telepty.principals/v1', audience, keys });

test('owned broker discovery requires signed exact grants, current stream, and whitelist-only metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-discovery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receiver = await startTestDaemon(); t.after(() => receiver.stop());
  const reg = await receiver.registerSession('worker', { command: 'PRIVATE_COMMAND', cwd: '/PRIVATE_CWD', delivery_type: 'mailbox' });
  assert.equal(reg.status, 201);
  const source = pair(), node = pair(), hubKey = pair(), intruder = pair();
  const limits = { max_payload_bytes: 256, max_requests: 20, window_ms: 60000, timeout_ms: 1000, max_pending: 4 };
  const hub = createBrokerHub({ privateKey: hubKey.privateKey, homeDir: root, config: {
    schema: 'telepty.broker-hub/v1', principal_id: 'hub', key_id: 'hub', audience: 'hub', stream_ms: 60000,
    nodes: { source: { audience: 'source' }, node: { audience: 'recipient' }, intruder: { audience: 'intruder' } },
    limits: { source: limits, node: limits, intruder: limits }, trust: trust('hub', [
      entry('source', source, [grant('broker.discover', ['node'])]),
      entry('node', node, [grant('broker.stream', ['node']), grant('broker.advertise', ['node'])]),
      entry('intruder', intruder, [grant('broker.receipt', ['intruder'])])]) } });
  const address = await hub.listen({ host: '127.0.0.1', port: 0 }); t.after(() => hub.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const client = createBrokerClient({ config: { principal_id: 'source', key_id: 'source', hub_url: origin, hub_audience: 'hub' }, privateKey: source.privateKey });
  const denied = createBrokerClient({ config: { principal_id: 'intruder', key_id: 'intruder', hub_url: origin, hub_audience: 'hub' }, privateKey: intruder.privateKey });
  const bridge = createBrokerNode({ privateKey: node.privateKey, localToken: receiver.authToken(), config: {
    schema: 'telepty.broker-node/v1', principal_id: 'node', key_id: 'node', hub_url: origin, hub_audience: 'hub',
    hub_principal_id: 'hub', audience: 'recipient', local_daemon_url: `http://127.0.0.1:${receiver.port}`, local_timeout_ms: 1000,
    discovery: { sessions: ['worker'], interval_ms: 5000, ttl_ms: 10000 },
    hub_trust: trust('recipient', [entry('hub', hubKey, [grant('broker.envelope', ['source/worker'])])]) } });
  await bridge.start(); t.after(() => bridge.stop());
  const observed = await waitFor(async () => { const result = await client.discover('node'); return result.body.status === 'observed' && result.body; });
  assert.deepEqual(observed.sessions, [{ session_id: 'worker', session_epoch: reg.body.session_epoch }]);
  assert.equal(observed.complete, true); assert.equal(observed.foreign_session_identity_verified, false);
  assert.equal(observed.observation_scope, 'node-reported');
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_COMMAND|PRIVATE_CWD|session_token|credentialVerifier|nonce|authToken/);
  const keyFile = path.join(root, 'source-key.pem'), configFile = path.join(root, 'source.json');
  fs.writeFileSync(keyFile, source.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(configFile, JSON.stringify({ schema: 'telepty.broker-source/v1', principal_id: 'source', key_id: 'source',
    private_key_path: keyFile, hub_url: origin, hub_audience: 'hub' }), { mode: 0o600 });
  const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,
    ['cli.js', 'broker-discover-v1', '--config', configFile, 'node'], { cwd: path.resolve(__dirname, '..'), timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout).sessions, observed.sessions);
  assert.equal((await denied.discover('node')).status, 403);
  // A forged path identity cannot borrow a valid signature from another node.
  const challenge = await (await fetch(origin + '/v1/challenge')).json();
  const target = '/v1/nodes/node/discovery/node';
  const assertion = createSignedAssertion({ privateKey: source.privateKey, keyId: 'source', principalId: 'source', audience: 'hub',
    challenge: challenge.challenge, method: 'GET', target, body: {}, action: 'broker.discover' });
  assert.equal((await fetch(origin + target, { headers: { 'x-telepty-assertion': assertion } })).status, 403);
  await bridge.stop();
  await waitFor(async () => (await client.discover('node')).body.reason === 'node_disconnected');
  assert.equal((await client.discover('node')).body.sessions, null);
});

test('discovery freshness and stream generation fail closed without replacing corrupt/unknown metadata', () => {
  let now = 10000;
  const first = { challenge: 'a'.repeat(43), response: { destroyed: false } }, streams = new Map([['node', first]]);
  const registry = createDiscoveryRegistry({ nodes: { node: {}, source: {} }, streams, now: () => now });
  const response = () => ({ writeHead() {}, end(bytes) { this.body = JSON.parse(bytes); } });
  const auth = (_body, action) => ({ id: action === 'broker.discover' ? 'source' : 'node' });
  const valid = { sessions: [], complete: true, configured_count: 0, ttl_ms: 5000, stream_challenge: first.challenge };
  assert.throws(() => registry.handle({ method: 'POST', url: '/v1/nodes/node/advertise' }, response(), { ...valid, token: 'NO' }, auth));
  assert.throws(() => registry.handle({ method: 'POST', url: '/v1/nodes/node/advertise' }, response(), { ...valid, sessions: [{ session_id: 'worker', session_epoch: 'epoch', cwd: 'NO' }] }, auth));
  registry.handle({ method: 'POST', url: '/v1/nodes/node/advertise' }, response(), valid, auth);
  now = 15000; let res = response(); registry.handle({ method: 'GET', url: '/v1/nodes/source/discovery/node' }, res, {}, auth);
  assert.equal(res.body.reason, 'snapshot_expired'); assert.equal(res.body.sessions, null);
  registry.handle({ method: 'POST', url: '/v1/nodes/node/advertise' }, response(), valid, auth);
  streams.set('node', { challenge: 'b'.repeat(43), response: { destroyed: false } });
  assert.throws(() => registry.handle({ method: 'POST', url: '/v1/nodes/node/advertise' }, response(), valid, auth));
  res = response(); registry.handle({ method: 'GET', url: '/v1/nodes/source/discovery/node' }, res, {}, auth); assert.equal(res.body.status, 'unavailable');
});

test('discovery config is explicit and bounded; a failed exact local read is partial, never a complete empty inventory', async () => {
  assert.equal(validateDiscovery(undefined), null);
  for (const sessions of [Array(33).fill('x'), ['same', 'same'], ['../escape'], ['a/b']]) {
    assert.throws(() => validateDiscovery({ sessions, interval_ms: 5000, ttl_ms: 10000 }));
  }
  const stop = new AbortController(), posted = [];
  const agent = createDiscoveryAgent({ configuration: { sessions: ['worker'], interval_ms: 5000, ttl_ms: 10000 },
    node: 'node', signal: stop.signal, timeoutMs: 100, inspect: async () => new Response('{}', { status: 403 }),
    client: { request: async (_method, _target, body) => { posted.push(body); return { status: 200, body: { success: true } }; } } });
  agent.begin('c'.repeat(43));
  await waitFor(() => posted.length === 1);
  assert.equal(posted[0].complete, false); assert.equal(posted[0].configured_count, 1); assert.deepEqual(posted[0].sessions, []);
  stop.abort();
});

test('in-flight discovery is fenced by stream end/stop and never serializes unrelated inspect fields', async () => {
  const stop = new AbortController(), posts = []; let resolveRead;
  const agent = createDiscoveryAgent({ configuration: { sessions: ['worker'], interval_ms: 5000, ttl_ms: 10000 }, node: 'node',
    signal: stop.signal, timeoutMs: 1000, inspect: () => new Promise(resolve => { resolveRead = resolve; }),
    client: { request: async (_method, _target, body) => { posts.push(body); return { status: 200, body: { success: true } }; } } });
  agent.begin('d'.repeat(43)); agent.end('d'.repeat(43));
  resolveRead(new Response(JSON.stringify({ id: 'worker', session_epoch: 'epoch', session_token: 'PRIVATE' })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(posts.length, 0);
  agent.begin('e'.repeat(43));
  resolveRead(new Response(JSON.stringify({ id: 'worker', session_epoch: 'epoch', session_token: 'PRIVATE', cwd: 'PRIVATE', command: 'PRIVATE' })));
  await waitFor(() => posts.length === 1);
  assert.deepEqual(posts[0].sessions, [{ session_id: 'worker', session_epoch: 'epoch' }]); assert.doesNotMatch(JSON.stringify(posts), /PRIVATE/);
  stop.abort(); agent.begin('f'.repeat(43)); await new Promise(resolve => setImmediate(resolve)); assert.equal(posts.length, 1);
});

test('discovery treats a backwards clock as unavailable rather than extending snapshot freshness', () => {
  let now = 10000; const stream = { challenge: 'g'.repeat(43), response: { destroyed: false } };
  const registry = createDiscoveryRegistry({ nodes: { source: {}, node: {} }, streams: new Map([['node', stream]]), now: () => now });
  const auth = (_body, action) => ({ id: action === 'broker.discover' ? 'source' : 'node' });
  const res = () => ({ writeHead() {}, end(data) { this.body = JSON.parse(data); } });
  registry.handle({ method: 'POST', url: '/v1/nodes/node/advertise' }, res(), { sessions: [], complete: true, configured_count: 0, ttl_ms: 5000, stream_challenge: stream.challenge }, auth);
  now = 12000; registry.handle({ method: 'GET', url: '/v1/nodes/source/discovery/node' }, res(), {}, auth);
  now = 11000; const result = res(); registry.handle({ method: 'GET', url: '/v1/nodes/source/discovery/node' }, result, {}, auth);
  assert.equal(result.body.reason, 'clock_unsafe'); assert.equal(result.body.sessions, null);
});
