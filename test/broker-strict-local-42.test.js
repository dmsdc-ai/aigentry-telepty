'use strict';
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAction } = require('../src/principal/http');
const { createSignedAssertion } = require('../src/principal/proof');
const { createBrokerHub } = require('../src/broker/hub');
const { createBrokerClient, createBrokerNode } = require('../src/broker/node');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const pair = () => crypto.generateKeyPairSync('ed25519');
const grant = (action, targets) => ({ action, targets });
const entry = (id, key, grants, authority = 'principal') => ({ key_id: id, principal_id: id, authority,
  public_key_spki: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(), grants });
const trust = (audience, keys) => ({ schema: 'telepty.principals/v1', audience, keys });

test('forwarded ingress requires a separate exact action and mandatory epoch', () => {
  const action = resolveAction({ method: 'POST', originalUrl: '/api/forwarded/sessions/worker/inject', body: {} });
  assert.equal(action.action, 'session.forwarded_inject');
  assert.equal(action.target, 'worker'); assert.equal(action.epochRequired, true); assert.equal(action.explicitInject, true);
  assert.equal(resolveAction({ method: 'POST', originalUrl: '/api/forwarded/sessions/broadcast/inject', body: {} }), null);
});

test('signed hub/node topology reaches strict local mailbox without a daemon token; no grant/epoch/signature/challenge fallback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-strict-local-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operator = pair(), relay = pair(), source = pair(), hubKey = pair(), nodeKey = pair(), wrong = pair();
  const localAudience = 'strict-local-fixture';
  const localTrust = path.join(root, 'local-trust.json');
  fs.writeFileSync(localTrust, JSON.stringify(trust(localAudience, [
    entry('operator', operator, [grant('session.register', ['worker', 'protected']), grant('mailbox.read', ['worker', 'protected'])], 'operator'),
    entry('relay', relay, [grant('session.forwarded_inject', ['worker', 'protected']), grant('session.inspect', ['worker'])], 'operator'),
    entry('ordinary', wrong, [grant('session.inject', ['worker'])])
  ])), { mode: 0o600 });
  const home = path.join(root, 'receiver'); fs.mkdirSync(home, { mode: 0o700 });
  const receiver = await startTestDaemon({ homeDir: home, env: { TELEPTY_MACHINE_ID: localAudience,
    TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: localTrust, TELEPTY_AUTH_TOKEN: 'synthetic-unused-daemon-token' } });
  t.after(() => receiver.stop());
  const local = `http://127.0.0.1:${receiver.port}`;
  async function localSigned(method, target, body, action, epoch, identity = 'operator', key = operator.privateKey) {
    const doc = await (await fetch(local + '/api/auth/challenge')).json();
    const assertion = createSignedAssertion({ privateKey: key, keyId: identity, principalId: identity,
      audience: localAudience, challenge: doc.challenge, method, target, body: method === 'GET' ? undefined : body, action, sessionEpoch: epoch });
    const response = await fetch(local + target, { method, headers: { 'content-type': 'application/json', 'x-telepty-principal': assertion },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const registration = await localSigned('POST', '/api/sessions/register', { session_id: 'worker', delivery_type: 'mailbox' }, 'session.register');
  assert.equal(registration.status, 201, JSON.stringify(registration.body));
  const epoch = registration.body.session_epoch;
  const limits = { max_payload_bytes: 256, max_requests: 20, window_ms: 60000, timeout_ms: 2000, max_pending: 8 };
  const hub = createBrokerHub({ privateKey: hubKey.privateKey, homeDir: root, config: { schema: 'telepty.broker-hub/v1', audience: 'hub', principal_id: 'hub', key_id: 'hub', stream_ms: 60000,
    nodes: { source: { audience: 'source-audience' }, recipient: { audience: 'recipient-audience' } }, limits: { source: limits, recipient: limits },
    trust: trust('hub', [entry('source', source, [grant('broker.inject', ['recipient/worker']), grant('broker.receipt', ['source']), grant('broker.discover', ['recipient'])]),
      entry('recipient', nodeKey, [grant('broker.stream', ['recipient']), grant('broker.result', ['recipient']), grant('broker.advertise', ['recipient'])])]) } });
  const address = await hub.listen({ host: '127.0.0.1', port: 0 }); t.after(() => hub.close());
  const hubOrigin = `http://127.0.0.1:${address.port}`;
  const config = { schema: 'telepty.broker-node/v1', principal_id: 'recipient', key_id: 'recipient', hub_url: hubOrigin,
    hub_audience: 'hub', hub_principal_id: 'hub', audience: 'recipient-audience', local_daemon_url: local, local_timeout_ms: 1000,
    reconnect: { max_attempts: 2, initial_backoff_ms: 10, max_backoff_ms: 20 },
    discovery: { sessions: ['worker'], interval_ms: 5000, ttl_ms: 10000 },
    hub_trust: trust('recipient-audience', [entry('hub', hubKey, [grant('broker.envelope', ['source/worker'])])]) };
  const client = createBrokerClient({ config: { principal_id: 'source', key_id: 'source', hub_url: hubOrigin, hub_audience: 'hub' }, privateKey: source.privateKey });
  let index = 0;
  for (const attack of ['valid', 'ordinary-grant', 'stale-epoch', 'forged-signature', 'refused-challenge']) {
    const requests = [], streamChallenges = [];
    const localPrincipal = { principal_id: attack === 'ordinary-grant' ? 'ordinary' : 'relay', key_id: attack === 'ordinary-grant' ? 'ordinary' : 'relay', audience: localAudience,
      privateKey: attack === 'ordinary-grant' || attack === 'forged-signature' ? wrong.privateKey : relay.privateKey };
    const node = createBrokerNode({ config, privateKey: nodeKey.privateKey, localPrincipal,
      fetch: async (url, options = {}) => {
        assert.equal(options.headers?.['x-telepty-token'], undefined); assert.equal(options.headers?.['x-telepty-session-token'], undefined);
        if (new URL(url).origin === local) {
          requests.push({ url, options });
          if (attack === 'refused-challenge' && url.endsWith('/api/auth/challenge')) return new Response('{}', { status: 403 });
          if (options.headers?.['x-telepty-principal']) assert.ok([local + '/api/forwarded/sessions/worker/inject', local + '/api/sessions/worker'].includes(url));
        }
        const response = await fetch(url, options);
        if (url === `${hubOrigin}/v1/nodes/recipient/stream` && response.ok) streamChallenges.push(JSON.parse(options.body).challenge);
        return response;
      } });
    await node.start();
    if (attack === 'valid') {
      const found = await waitFor(async () => { const result = await client.discover('recipient'); return result.body.status === 'observed' && result.body; });
      assert.deepEqual(found.sessions, [{ session_id: 'worker', session_epoch: epoch }]);
      assert.equal(found.foreign_session_identity_verified, false);
    }
    const body = { prompt: `Synthetic ${attack}`, expected_epoch: attack === 'stale-epoch' ? 'stale-epoch' : epoch,
      idempotency_key: `strict-local-key-${String(++index).padStart(4, '0')}`, no_enter: true };
    assert.equal((await client.inject('recipient', 'worker', body)).status, 202);
    const receipt = await waitFor(async () => {
      const result = await client.receipt(body.idempotency_key);
      return ['accepted', 'failed', 'outcome_unknown'].includes(result.body.state) ? result.body : null;
    }, { description: 'strict local broker receipt' });
    assert.equal(receipt.state, attack === 'valid' ? 'accepted' : 'failed', JSON.stringify(receipt));
    assert.equal(requests.filter(request => request.options.headers?.['x-telepty-token']).length, 0);
    if (attack === 'refused-challenge') assert.ok(requests.every(request => request.url.endsWith('/api/auth/challenge')), 'challenge refusal performs no local POST or fallback');
    if (attack === 'valid') {
      hub.server.closeAllConnections(); // Only this owned fixture's stream/keepalive sockets.
      await waitFor(() => streamChallenges.length === 2, { description: 'strict recipient reconnect' });
      assert.notEqual(streamChallenges[0], streamChallenges[1]);
      const next = { ...body, prompt: 'Synthetic after reconnect', idempotency_key: 'strict-local-after-reconnect-0007' };
      assert.equal((await client.inject('recipient', 'worker', next)).status, 202);
      await waitFor(async () => (await client.receipt(next.idempotency_key)).body.state === 'accepted');
      assert.equal((await client.receipt(body.idempotency_key)).body.state, 'accepted');
      assert.ok(hub.auditStats().submitted > 0);
    }
    await node.stop();
  }
  const protectedRegistration = await localSigned('POST', '/api/sessions/register', { session_id: 'protected', delivery_type: 'mailbox',
    external_approval_policy: { public_key_spki: operator.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }, 'session.register');
  assert.equal(protectedRegistration.status, 201);
  const protectedBody = { prompt: 'approval must not be bypassed', expected_epoch: protectedRegistration.body.session_epoch,
    exact_target: true, no_enter: true, forwarding: { hop: 1, key: 'e'.repeat(64) } };
  const protectedResult = await localSigned('POST', '/api/forwarded/sessions/protected/inject', protectedBody,
    'session.forwarded_inject', protectedRegistration.body.session_epoch, 'relay', relay.privateKey);
  assert.equal(protectedResult.status, 403);
  assert.equal(protectedResult.body.code, 'EXTERNAL_APPROVAL_REQUIRED');
  assert.equal((await localSigned('GET', '/api/sessions/protected/mailbox', {}, 'mailbox.read')).body.pending.length, 0);
  const forwardedTarget = '/api/forwarded/sessions/worker/inject';
  const localBody = { prompt: 'must not write', no_enter: true, exact_target: true, expected_epoch: epoch,
    claimed_cross_host: true, forwarding: { hop: 1, key: 'd'.repeat(64) } };
  assert.equal((await localSigned('POST', forwardedTarget, localBody, 'session.inject', epoch, 'relay', relay.privateKey)).status, 401);
  const invalidBody = { ...localBody, expected_epoch: 'not-current' };
  const invalid = await localSigned('POST', forwardedTarget, invalidBody, 'session.forwarded_inject', epoch, 'relay', wrong.privateKey);
  assert.equal(invalid.status, 401);
  const missingEpoch = { ...localBody }; delete missingEpoch.expected_epoch;
  assert.equal((await localSigned('POST', forwardedTarget, missingEpoch, 'session.forwarded_inject', epoch, 'relay', relay.privateKey)).status, 409);
  assert.equal((await localSigned('POST', forwardedTarget, localBody, 'session.forwarded_inject', undefined, 'relay', relay.privateKey)).status, 401);
  assert.equal((await localSigned('POST', '/api/sessions/worker/inject', localBody, 'session.forwarded_inject', epoch, 'relay', relay.privateKey)).status, 401);
  assert.equal((await localSigned('POST', '/api/sessions/worker/kill', {}, 'session.forwarded_inject', epoch, 'relay', relay.privateKey)).status, 401);

  // Real recipient startup uses separately provisioned synthetic keys from private
  // authority files. Its HOME has no daemon config or token to read or mint.
  const nodeHome = path.join(root, 'empty-node-home'); fs.mkdirSync(nodeHome, { mode: 0o700 });
  const nodePrivate = path.join(root, 'node-key.pem'), localPrivate = path.join(root, 'local-key.pem');
  fs.writeFileSync(nodePrivate, nodeKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(localPrivate, relay.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const nodeFile = path.join(root, 'node.json');
  fs.writeFileSync(nodeFile, JSON.stringify({ ...config, private_key_path: nodePrivate,
    local_principal: { principal_id: 'relay', key_id: 'relay', private_key_path: localPrivate, audience: localAudience } }), { mode: 0o600 });
  const child = spawn(process.execPath, ['src/broker/main.js', 'node', '--config', nodeFile], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: nodeHome, USERPROFILE: nodeHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.on('exit', () => { exited = true; });
  try {
    await waitFor(() => { if (exited) throw new Error('Synthetic strict recipient startup failed: ' + stderr); return stdout.includes('Broker v1 node connected'); });
    const body = { prompt: 'Synthetic configured key', expected_epoch: epoch, idempotency_key: 'strict-local-key-main-0006', no_enter: true };
    assert.equal((await client.inject('recipient', 'worker', body)).status, 202);
    await waitFor(async () => (await client.receipt(body.idempotency_key)).body.state === 'accepted');
    assert.deepEqual(fs.readdirSync(nodeHome), [], 'strict recipient never creates/reads a daemon credential config');
  } finally { child.kill(); await waitFor(() => exited, { description: 'owned strict broker recipient shutdown' }); }
  const messages = await localSigned('GET', '/api/sessions/worker/mailbox', {}, 'mailbox.read');
  assert.equal(messages.status, 200);
  assert.deepEqual(messages.body.pending.map(message => message.payload), ['Synthetic valid', 'Synthetic after reconnect', 'Synthetic configured key']);
  const duplicate = await client.inject('recipient', 'worker', { prompt: 'Synthetic valid', expected_epoch: epoch, idempotency_key: 'strict-local-key-0001', no_enter: true });
  assert.equal(duplicate.body.state, 'accepted');
  assert.equal(duplicate.body.foreign_session_identity_verified, false);
});

test('strict local challenge validation rejects null/schema/audience and redirects without any inject fallback', async () => {
  const { createLocalPrincipalRequest } = require('../src/broker/local-principal');
  const key = pair();
  const valid = { schema: 'telepty.principal-challenge/v1', audience: 'local', challenge: 'a'.repeat(43),
    max_lifetime_seconds: 60, transport: 'http', identity_source: 'configured-ed25519-key' };
  for (const value of [null, [], {}, { ...valid, audience: 'foreign' }, { ...valid, challenge: 'bad' },
    { ...valid, schema: 'wrong' }, { ...valid, identity_source: 'shared-token' }]) {
    const calls = [];
    const request = createLocalPrincipalRequest({ localDaemonUrl: 'http://127.0.0.1:39001', timeoutMs: 200,
      principal: { principal_id: 'relay', key_id: 'relay', audience: 'local', privateKey: key.privateKey },
      fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(value)); } });
    await assert.rejects(request('worker', { exact_target: true, expected_epoch: 'epoch' }), { code: 'BROKER_LOCAL_CHALLENGE_INVALID' });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:39001/api/auth/challenge');
    assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers, undefined);
  }
  const redirected = createLocalPrincipalRequest({ localDaemonUrl: 'http://127.0.0.1:39001', timeoutMs: 200,
    principal: { principal_id: 'relay', key_id: 'relay', audience: 'local', privateKey: key.privateKey },
    fetch: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1:39002' } }) });
  await assert.rejects(redirected('worker', { exact_target: true, expected_epoch: 'epoch' }), { code: 'BROKER_LOCAL_CHALLENGE_REFUSED' });
});

test('configured local signer uses existing Linux private authority reader and rejects unsafe or ambiguous selection', t => {
  const { loadLocalPrincipal, createLocalPrincipalRequest } = require('../src/broker/local-principal');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-local-authority-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = pair(), file = path.join(root, 'synthetic-key.pem');
  fs.writeFileSync(file, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const config = { principal_id: 'relay', key_id: 'relay', audience: 'local', private_key_path: file };
  assert.equal(loadLocalPrincipal(config).privateKey.asymmetricKeyType, 'ed25519');
  fs.chmodSync(file, 0o644); assert.throws(() => loadLocalPrincipal(config), { code: 'BROKER_LOCAL_KEY_UNAVAILABLE' }); fs.chmodSync(file, 0o600);
  const alias = path.join(root, 'alias'); fs.symlinkSync(file, alias);
  assert.throws(() => loadLocalPrincipal({ ...config, private_key_path: alias }), { code: 'BROKER_LOCAL_KEY_UNAVAILABLE' });
  assert.throws(() => loadLocalPrincipal({ ...config, local_token: 'not-accepted' }), { code: 'BROKER_LOCAL_PRINCIPAL_INVALID' });
  assert.throws(() => createLocalPrincipalRequest({ localDaemonUrl: 'http://localhost:39001', timeoutMs: 200,
    principal: { principal_id: 'relay', key_id: 'relay', audience: 'local', privateKey: key.privateKey } }), { code: 'BROKER_ORIGIN_INVALID' });
});

test('strict forwarded authorization refuses a closing target before the HTTP handler', async t => {
  const { createHttpApp, registerHealthAndAuth } = require('../src/protocol/http-app');
  const { createAuthMiddleware } = require('../src/protocol/http-auth');
  const { createPrincipalAuthentication } = require('../src/principal/http');
  const { validateTrustConfiguration } = require('../src/principal/proof');
  const key = pair(), sessions = { worker: { id: 'worker', sessionEpoch: 'closing-epoch', isClosing: true, type: 'mailbox' } };
  const authentication = createPrincipalAuthentication({ sessions, trust: validateTrustConfiguration(trust('closing-local', [entry('relay', key, [grant('session.forwarded_inject', ['worker'])])])) });
  const app = createHttpApp({ express: require('express'), cors: require('cors') });
  registerHealthAndAuth(app, { pkg: { version: 'fixture' }, createAuthMiddleware, isAllowedPeer: () => true,
    EXPECTED_TOKEN: 'unused', verifyJwt: () => false, principalAuthentication: authentication });
  let writes = 0;
  app.post('/api/forwarded/sessions/:id/inject', (_req, res) => { writes++; res.json({ success: true }); });
  const server = require('node:http').createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const target = '/api/forwarded/sessions/worker/inject', body = { expected_epoch: 'closing-epoch', prompt: 'not written' };
  const proof = createSignedAssertion({ privateKey: key.privateKey, keyId: 'relay', principalId: 'relay', audience: 'closing-local',
    challenge: authentication.verifier.challenge, method: 'POST', target, body, action: 'session.forwarded_inject', sessionEpoch: 'closing-epoch' });
  const response = await fetch(`http://127.0.0.1:${server.address().port}${target}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telepty-principal': proof }, body: JSON.stringify(body) });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'SESSION_CLOSING'); assert.equal(writes, 0);
});

test('recipient refuses simultaneous legacy token and explicit local principal', () => {
  const key = pair();
  assert.throws(() => createBrokerNode({ config: { schema: 'telepty.broker-node/v1', principal_id: 'recipient',
    hub_principal_id: 'hub', local_daemon_url: 'http://127.0.0.1:39001', local_timeout_ms: 1000 }, privateKey: key.privateKey,
    localToken: 'never-used', localPrincipal: { principal_id: 'relay', key_id: 'relay', audience: 'local', privateKey: key.privateKey } }),
  { code: 'BROKER_LOCAL_AUTH_AMBIGUOUS' });
});
