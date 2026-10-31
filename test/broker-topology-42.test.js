'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createBrokerClient, createBrokerNode } = require('../src/broker/node');
const { createSignedAssertion } = require('../src/principal/proof');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const { linuxOnly, nonLinuxOnly } = require('../test-support/windows-879/linux-authority');

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, public: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    private: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
function entry(key, node, pair, grants) { return { key_id: key, principal_id: node, public_key_spki: pair.public, grants }; }
function trust(audience, keys) { return { schema: 'telepty.principals/v1', audience, keys }; }
function grant(action, targets) { return { action, targets }; }
function write(file, value) { fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); }
async function child(mode, configFile, home, banner) {
  const processChild = spawn(process.execPath, ['src/broker/main.js', mode, '--config', configFile], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = ''; let exited = false;
  processChild.stdout.on('data', data => { stdout += data; }); processChild.stderr.on('data', data => { stderr += data; });
  processChild.on('exit', () => { exited = true; });
  try {
    await waitFor(() => { if (exited) throw new Error(`Synthetic broker child exited: ${stderr}`); return stdout.match(banner); }, { description: 'owned broker child startup' });
  } catch (reason) { if (!exited) { processChild.kill(); await waitFor(() => exited, { description: 'failed owned child shutdown' }); } throw reason; }
  return { child: processChild, output: () => stdout,
    async stop() {
      if (exited) return;
      processChild.kill();
      await waitFor(() => exited, { timeoutMs: 5000, description: 'owned broker child shutdown' });
    }
  };
}

// #879: the hub/node children load their config and keys through readAuthorityFile — Linux-only.
test('three-process outbound-only broker topology uses enrolled keys and exact idempotent local ingress', { skip: linuxOnly }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-broker-42-'));
  const hubHome = path.join(root, 'hub'); fs.mkdirSync(hubHome, { mode: 0o700 });
  const receiver = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '', TELEPTY_MACHINE_ID: 'node-b' } });
  let hub, bridge, owner;
  try {
    const a = keyPair(), b = keyPair(), h = keyPair(), unconfigured = keyPair();
    const hubKey = path.join(hubHome, 'hub-key.pem'); write(hubKey, h.private);
    const nodeKey = path.join(receiver.homeDir, 'node-key.pem'); write(nodeKey, b.private);
    const limits = { max_payload_bytes: 256, max_requests: 10, window_ms: 60000, timeout_ms: 1500, max_pending: 4 };
    const hubConfig = { schema: 'telepty.broker-hub/v1', audience: 'synthetic-hub', principal_id: 'hub', key_id: 'hub-key',
      private_key_path: hubKey, listen: { host: '127.0.0.1', port: 0 }, stream_ms: 60000,
      nodes: { 'node-a': { audience: 'synthetic-node-a' }, 'node-b': { audience: 'synthetic-node-b' } },
      limits: { 'node-a': limits, 'node-b': limits },
      trust: trust('synthetic-hub', [
        entry('a-key', 'node-a', a, [grant('broker.inject', ['node-b/worker']), grant('broker.receipt', ['node-a'])]),
        entry('b-key', 'node-b', b, [grant('broker.stream', ['node-b']), grant('broker.result', ['node-b'])]),
        entry('unconfigured-key', 'constructor', unconfigured, [grant('broker.inject', ['node-b/worker'])])
      ]) };
    const hubFile = path.join(hubHome, 'hub.json'); write(hubFile, hubConfig);
    hub = await child('hub', hubFile, hubHome, /Broker v1 listening on http:\/\/127\.0\.0\.1:(\d+)/);
    const port = Number(hub.output().match(/127\.0\.0\.1:(\d+)/)[1]);
    const hubOrigin = `http://127.0.0.1:${port}`;
    const nodeConfig = { schema: 'telepty.broker-node/v1', principal_id: 'node-b', key_id: 'b-key', private_key_path: nodeKey,
      hub_url: hubOrigin, hub_audience: 'synthetic-hub', hub_principal_id: 'hub', audience: 'synthetic-node-b',
      local_daemon_url: `http://127.0.0.1:${receiver.port}`, local_timeout_ms: 1000,
      hub_trust: trust('synthetic-node-b', [entry('hub-key', 'hub', h, [grant('broker.envelope', ['node-a/worker'])])]) };
    const nodeFile = path.join(receiver.homeDir, 'node.json'); write(nodeFile, nodeConfig);
    const emptyHome = path.join(root, 'empty-home'); fs.mkdirSync(emptyHome, { mode: 0o700 });
    const missingCredential = spawnSync(process.execPath, ['src/broker/main.js', 'node', '--config', nodeFile], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome },
      encoding: 'utf8', timeout: 1000
    });
    assert.equal(missingCredential.status, 1);
    assert.equal(fs.existsSync(path.join(emptyHome, '.telepty')), false, 'bridge never mints a missing daemon credential');

    const registration = await receiver.registerSession('worker');
    owner = await receiver.connectSession('worker', receiver.ownerAuth('worker'));
    const frames = [];
    owner.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.type === 'inject' && String(frame.data).includes('Synthetic')) frames.push(frame);
    });
    bridge = await child('node', nodeFile, receiver.homeDir, /Broker v1 node connected/);
    const requests = [];
    const sourceConfig = { principal_id: 'node-a', key_id: 'a-key', hub_url: hubOrigin, hub_audience: 'synthetic-hub' };
    const client = createBrokerClient({ config: sourceConfig, privateKey: a.privateKey,
      fetch: (url, options) => {
        assert.equal(new URL(url).origin, hubOrigin, 'source can dial only the hub, never destination');
        assert.equal(options.headers && options.headers['x-telepty-token'], undefined);
        assert.equal(options.headers && options.headers['x-telepty-session-token'], undefined);
        requests.push({ url, options }); return fetch(url, options);
      } });
    const body = { prompt: 'Synthetic broker input', expected_epoch: registration.body.session_epoch,
      idempotency_key: 'synthetic-broker-key-0001', no_enter: true };
    const unconfiguredClient = createBrokerClient({ config: { ...sourceConfig, principal_id: 'constructor', key_id: 'unconfigured-key' }, privateKey: unconfigured.privateKey });
    assert.equal((await unconfiguredClient.inject('node-b', 'worker', body)).status, 403);
    const queued = await client.inject('node-b', 'worker', body);
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    assert.equal(queued.body.foreign_session_identity_verified, false);
    const accepted = await waitFor(async () => {
      const result = await client.receipt(body.idempotency_key);
      return result.body.state === 'accepted' ? result.body : null;
    }, { description: 'broker remote acceptance receipt' });
    assert.equal(typeof accepted.remote_inject_id, 'string');
    assert.equal(accepted.foreign_session_identity_verified, false);
    await waitFor(() => frames.length === 1, { description: 'one broker-delivered input' });
    const duplicate = await client.inject('node-b', 'worker', body);
    assert.equal(duplicate.body.remote_inject_id, accepted.remote_inject_id);
    assert.equal(frames.length, 1);
    const sourcePrivate = path.join(hubHome, 'source-key.pem'); write(sourcePrivate, a.private);
    const sourceFile = path.join(hubHome, 'source.json'); write(sourceFile, { ...sourceConfig,
      schema: 'telepty.broker-source/v1', private_key_path: sourcePrivate });
    const cliQuery = await receiver.runCli(['broker-receipt-v1', '--config', sourceFile, body.idempotency_key], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.equal(cliQuery.code, 0, cliQuery.stderr);
    assert.equal(JSON.parse(cliQuery.stdout).remote_inject_id, accepted.remote_inject_id);
    const cliDuplicate = await receiver.runCli(['broker-inject-v1', '--config', sourceFile, 'node-b', 'worker',
      body.expected_epoch, body.idempotency_key, body.prompt], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.equal(cliDuplicate.code, 0, cliDuplicate.stderr);
    assert.equal(JSON.parse(cliDuplicate.stdout).remote_inject_id, accepted.remote_inject_id);
    assert.equal(cliDuplicate.stdout.includes(body.prompt), false);
    assert.equal(frames.length, 1);

    assert.equal((await client.inject('node-b', 'ungranted', { ...body, idempotency_key: 'synthetic-broker-key-0002' })).status, 403);
    assert.equal((await client.inject('node-b', 'worker', { ...body, prompt: 'different', idempotency_key: body.idempotency_key })).status, 409);
    // Replaying the identical wire proof is rejected independently of operation dedup.
    const sent = requests.find(item => item.options.method === 'POST');
    const replay = await fetch(sent.url, sent.options);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, 'PRINCIPAL_REPLAY');
    // Foreign session identity remains absent in the destination audit/metadata.
    const meta = await receiver.request('/api/sessions/worker');
    assert.equal(meta.body.session_epoch, registration.body.session_epoch);
    const wrongEpoch = await client.inject('node-b', 'worker', { ...body,
      expected_epoch: 'synthetic-stale-epoch', idempotency_key: 'synthetic-broker-key-0003' });
    assert.equal(wrongEpoch.status, 202);
    const refused = await waitFor(async () => {
      const result = await client.receipt('synthetic-broker-key-0003');
      return result.body.state === 'failed' ? result.body : null;
    }, { description: 'stale-epoch receiver refusal' });
    assert.equal(refused.code, 'BROKER_LOCAL_INJECT_REFUSED');
    assert.equal(frames.length, 1);
    // No shared daemon bearer is accepted as broker node identity.
    const refusedBearer = await fetch(`${hubOrigin}/v1/nodes/node-b/stream`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telepty-token': receiver.authToken() }, body: JSON.stringify({ challenge: 'a'.repeat(32) }) });
    assert.equal(refusedBearer.status, 401); await refusedBearer.arrayBuffer();
    const receipts = fs.readdirSync(path.join(hubHome, '.telepty', 'forward-receipts')).map(file =>
      fs.readFileSync(path.join(hubHome, '.telepty', 'forward-receipts', file), 'utf8')).join('');
    assert.equal(receipts.includes(body.prompt), false);
    assert.equal(receipts.includes(receiver.authToken()), false);
    // A signature by any other hub key cannot become an accepted envelope.
    const foreign = keyPair();
    const challenge = (await (await fetch(`${hubOrigin}/v1/challenge`)).json()).challenge;
    const forged = createSignedAssertion({ privateKey: foreign.privateKey, keyId: 'a-key', principalId: 'node-a',
      audience: 'synthetic-hub', challenge, method: 'GET', target: '/v1/nodes/node-a/receipts/synthetic-broker-key-0001',
      body: {}, action: 'broker.receipt' });
    const denied = await fetch(`${hubOrigin}/v1/nodes/node-a/receipts/synthetic-broker-key-0001`, {
      headers: { 'x-telepty-assertion': forged } });
    assert.equal(denied.status, 401); await denied.arrayBuffer();
    assert.equal((await client.inject('node-b', 'worker', { ...body, prompt: 'x'.repeat(257), idempotency_key: 'synthetic-broker-too-large' })).status, 413);
    await bridge.stop(); bridge = null;
    const nodeClient = createBrokerClient({ config: nodeConfig, privateKey: b.privateKey });
    const rawStream = await waitFor(() => nodeClient.request('POST', '/v1/nodes/node-b/stream', { challenge: 'z'.repeat(32) },
      'broker.stream', { stream: true, signal: AbortSignal.timeout(6000) }), { description: 'fresh enrolled outbound stream' });
    const streamReader = rawStream.body.getReader();
    try {
      for (let index = 0; index < 4; index++) {
        assert.equal((await client.inject('node-b', 'worker', { ...body, idempotency_key: `synthetic-uncertain-key-${index}` })).status, 202);
      }
      assert.equal((await client.inject('node-b', 'worker', { ...body, idempotency_key: 'synthetic-backpressure-key' })).status, 429);
      let frameCount = 0;
      while (frameCount < 4) {
        const chunk = await streamReader.read(); assert.equal(chunk.done, false);
        frameCount += Buffer.from(chunk.value).toString().split('data: ').length - 1;
      }
      assert.equal(frameCount, 4);
      await waitFor(async () => (await client.receipt('synthetic-uncertain-key-0')).body.state === 'outcome_unknown',
        { description: 'bounded uncertain broker receipt' });
      const repeatUnknown = await client.inject('node-b', 'worker', { ...body, idempotency_key: 'synthetic-uncertain-key-0' });
      assert.equal(repeatUnknown.body.state, 'outcome_unknown');
      assert.equal(await Promise.race([streamReader.read().then(() => 'unexpected-frame'),
        new Promise(resolve => setTimeout(() => resolve('quiet'), 100))]), 'quiet');
      assert.equal(frames.length, 1, 'no uncertain operation was retried into the destination');
    } finally { await streamReader.cancel(); }

  } finally {
    if (owner) owner.close();
    if (bridge) await bridge.stop();
    if (hub) await hub.stop();
    await receiver.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('off Linux a broker hub child refuses its private config and key before listening', { skip: nonLinuxOnly }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-broker-42-refusal-'));
  try {
    const h = keyPair(), a = keyPair();
    const hubKey = path.join(root, 'hub-key.pem'); write(hubKey, h.private);
    const hubFile = path.join(root, 'hub.json');
    write(hubFile, { schema: 'telepty.broker-hub/v1', audience: 'synthetic-hub', principal_id: 'hub', key_id: 'hub-key',
      private_key_path: hubKey, listen: { host: '127.0.0.1', port: 0 }, stream_ms: 60000,
      nodes: { 'node-a': { audience: 'synthetic-node-a' } },
      limits: { 'node-a': { max_payload_bytes: 256, max_requests: 10, window_ms: 60000, timeout_ms: 1500, max_pending: 4 } },
      trust: trust('synthetic-hub', [entry('a-key', 'node-a', a, [grant('broker.receipt', ['node-a'])])]) });
    await assert.rejects(child('hub', hubFile, root, /Broker v1 listening/), (reason) => {
      assert.match(reason.message, /Synthetic broker child exited: BROKER_START_OR_CHANNEL_FAILED/);
      assert.equal(reason.message.includes(h.private), false, 'the refusal never echoes key material');
      return true;
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recipient rejects unpinned or oversized SSE envelopes before any local credential request', async () => {
  const b = keyPair(), h = keyPair(), foreign = keyPair();
  const config = { schema: 'telepty.broker-node/v1', principal_id: 'node-b', key_id: 'b-key',
    hub_url: 'http://127.0.0.1:38499', hub_audience: 'synthetic-hub', hub_principal_id: 'hub', audience: 'synthetic-node-b',
    local_daemon_url: 'http://127.0.0.1:38498', local_timeout_ms: 500,
    hub_trust: trust('synthetic-node-b', [entry('hub-key', 'hub', h, [grant('broker.envelope', ['node-a/worker'])])]) };
  for (const attack of ['unpinned', 'oversized']) {
    let localRequests = 0;
    const node = createBrokerNode({ config, privateKey: b.privateKey, localToken: 'synthetic-local-only',
      fetch: async (url, options) => {
        if (new URL(url).origin !== config.hub_url) { localRequests++; throw Error('local request forbidden in attack fixture'); }
        assert.equal(options.headers && options.headers['x-telepty-token'], undefined);
        if (url.endsWith('/v1/challenge')) return new Response(JSON.stringify({ schema: 'telepty.broker-challenge/v1',
          audience: 'synthetic-hub', challenge: 'h'.repeat(32) }));
        const receiverChallenge = JSON.parse(options.body).challenge;
        const envelope = { schema: 'telepty.broker-envelope/v1', receipt_id: 'a'.repeat(64), source_node: 'node-a', target_node: 'node-b',
          session: 'worker', payload: { prompt: 'Synthetic attack', expected_epoch: 'epoch', no_enter: true }, hop: 1,
          foreign_session_identity_verified: false };
        const assertion = createSignedAssertion({ privateKey: foreign.privateKey, keyId: 'hub-key', principalId: 'hub',
          audience: 'synthetic-node-b', challenge: receiverChallenge, method: 'EVENT', target: `/v1/envelopes/${envelope.receipt_id}`,
          body: envelope, action: 'broker.envelope', sessionEpoch: 'epoch' });
        const frame = attack === 'oversized' ? Buffer.alloc(128 * 1024 + 1, 120)
          : Buffer.from(`data: ${JSON.stringify({ envelope, assertion })}\n\n`);
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(frame); controller.close(); } }),
          { headers: { 'content-type': 'text/event-stream' } });
      } });
    await node.start();
    await assert.rejects(node.completion, reason => ['PRINCIPAL_PROOF_INVALID', 'BROKER_FRAME_TOO_LARGE'].includes(reason.code));
    assert.equal(localRequests, 0);
    await node.stop();
  }
});


test('recipient keeps pending or malformed successful local receipts uncertain', async () => {
  const b = keyPair(), h = keyPair();
  const config = { schema: 'telepty.broker-node/v1', principal_id: 'node-b', key_id: 'b-key',
    hub_url: 'http://127.0.0.1:38499', hub_audience: 'synthetic-hub', hub_principal_id: 'hub', audience: 'synthetic-node-b',
    local_daemon_url: 'http://127.0.0.1:38498', local_timeout_ms: 500,
    hub_trust: trust('synthetic-node-b', [entry('hub-key', 'hub', h, [grant('broker.envelope', ['node-a/worker'])])]) };
  for (const local of [{ status: 202, body: { success: false, code: 'FORWARD_OUTCOME_UNKNOWN' } },
    { status: 200, body: { success: true, inject_id: 'synthetic', session_id: 'wrong', exact_target: true } }]) {
    let posted;
    const node = createBrokerNode({ config, privateKey: b.privateKey, localToken: 'synthetic-local-only',
      fetch: async (url, options) => {
        if (url.startsWith(config.local_daemon_url)) {
          assert.equal(options.headers['x-telepty-token'], 'synthetic-local-only');
          return new Response(JSON.stringify(local.body), { status: local.status });
        }
        assert.equal(options.headers && options.headers['x-telepty-token'], undefined);
        if (url.endsWith('/v1/challenge')) return new Response(JSON.stringify({ schema: 'telepty.broker-challenge/v1',
          audience: 'synthetic-hub', challenge: 'h'.repeat(32) }));
        if (url.includes('/results/')) { posted = JSON.parse(options.body); assert.ok(options.signal); return new Response('{}'); }
        const receiverChallenge = JSON.parse(options.body).challenge;
        const envelope = { schema: 'telepty.broker-envelope/v1', receipt_id: 'a'.repeat(64), source_node: 'node-a', target_node: 'node-b',
          session: 'worker', payload: { prompt: 'Synthetic pending', expected_epoch: 'epoch', no_enter: true }, hop: 1,
          foreign_session_identity_verified: false };
        const assertion = createSignedAssertion({ privateKey: h.privateKey, keyId: 'hub-key', principalId: 'hub',
          audience: 'synthetic-node-b', challenge: receiverChallenge, method: 'EVENT', target: `/v1/envelopes/${envelope.receipt_id}`,
          body: envelope, action: 'broker.envelope', sessionEpoch: 'epoch' });
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.from(`data: ${JSON.stringify({ envelope, assertion })}\n\n`)); controller.close();
        } }));
      } });
    await node.start(); await node.completion;
    assert.equal(posted.state, 'outcome_unknown');
    await node.stop();
  }
});
