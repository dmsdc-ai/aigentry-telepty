'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrokerHub } = require('../src/broker/hub');
const { createBrokerClient, createBrokerNode } = require('../src/broker/node');
const { hash } = require('../src/broker/dispatch');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const pair = () => crypto.generateKeyPairSync('ed25519');
const grant = (action, targets) => ({ action, targets });
const entry = (key, principal, pair, grants) => ({ key_id: key, principal_id: principal,
  public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }), grants });
const trust = (audience, keys) => ({ schema: 'telepty.principals/v1', audience, keys });
test('owned broker broadcast and reply preserve durable exact routing, scopes, and uncertainty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-routing-'));
  const daemon = await startTestDaemon();
  const a = pair(), weakA = pair(), b = pair(), c = pair(), h = pair();
  const limits = { max_payload_bytes: 512, max_requests: 100, window_ms: 60000, timeout_ms: 500, max_pending: 16 };
  const hub = createBrokerHub({ homeDir: root, privateKey: h.privateKey, config: { schema: 'telepty.broker-hub/v1',
    principal_id: 'hub', key_id: 'h', audience: 'hub', stream_ms: 60000,
    nodes: { a: { audience: 'a' }, b: { audience: 'b' }, c: { audience: 'c' } }, limits: { a: limits, b: limits, c: limits },
    trust: trust('hub', [
      entry('a', 'a', a, [grant('broker.stream', ['a']), grant('broker.result', ['a']), grant('broker.broadcast', ['a']),
        grant('broker.inject', ['b/worker', 'b/other', 'c/offline']), grant('broker.receipt', ['a'])]),
      entry('weak-a', 'a', weakA, [grant('broker.broadcast', ['a'])]),
      entry('b', 'b', b, [grant('broker.stream', ['b']), grant('broker.result', ['b']), grant('broker.reply_context', ['b']),
        grant('broker.reply', ['a/return-worker', 'c/offline']), grant('broker.receipt', ['b'])]),
      entry('c', 'c', c, [grant('broker.reply_context', ['c']), grant('broker.reply', ['a/return-worker'])])
    ]) } });
  const bridges = [], owners = []; let origin, dropResults = false;
  const client = (principal, key, privateKey) => createBrokerClient({ config: { principal_id: principal, key_id: key, hub_audience: 'hub', hub_url: origin }, privateKey });
  try {
    const address = await hub.listen(); origin = `http://127.0.0.1:${address.port}`;
    const epochs = {}, frames = [];
    for (const sid of ['worker', 'other', 'return-worker']) {
      epochs[sid] = (await daemon.registerSession(sid)).body.session_epoch;
      const owner = await daemon.connectSession(sid, daemon.ownerAuth(sid)); owners.push(owner);
      owner.on('message', raw => { const frame = JSON.parse(raw); if (frame.type === 'inject') frames.push({ sid, frame }); });
    }
    for (const [node, keys, targets] of [['a', a, ['b/return-worker']], ['b', b, ['a/worker', 'a/other']]]) {
      const bridge = createBrokerNode({ fetch: (url, options) => {
        if (node === 'b' && dropResults && url.includes('/results/')) return Promise.reject(new TypeError('Synthetic lost result'));
        return fetch(url, options);
      }, privateKey: keys.privateKey, localToken: daemon.authToken(), config: {
        schema: 'telepty.broker-node/v1', principal_id: node, key_id: node, hub_url: origin, hub_audience: 'hub',
        hub_principal_id: 'hub', audience: node, local_daemon_url: `http://127.0.0.1:${daemon.port}`, local_timeout_ms: 500,
        hub_trust: trust(node, [entry('h', 'hub', h, [grant('broker.envelope', targets)])]) } });
      bridges.push(bridge); await bridge.start();
    }
    const source = client('a', 'a', a.privateKey), responder = client('b', 'b', b.privateKey), foreign = client('c', 'c', c.privateKey);
    const body = { idempotency_key: 'routing-group-key-0001', prompt: 'Synthetic broadcast', no_enter: true,
      targets: [{ node: 'b', session: 'worker', expected_epoch: epochs.worker }, { node: 'c', session: 'offline', expected_epoch: 'epoch' }] };
    assert.equal((await client('a', 'weak-a', weakA.privateKey).broadcast(body)).status, 403, 'another same-principal key does not supply inject grants');
    assert.equal((await source.broadcast({ ...body, targets: Array(9).fill(body.targets[0]) })).status, 400);
    assert.equal((await source.broadcast({ ...body, targets: [body.targets[0], body.targets[0]] })).status, 400);
    const admitted = await source.broadcast(body); assert.equal(admitted.status, 202);
    assert.equal(admitted.body.foreign_session_identity_verified, false);
    let group;
    await waitFor(async () => { group = (await source.broadcastReceipt(body.idempotency_key)).body; return group.children.some(child => child.state === 'accepted'); });
    assert.equal(group.state, 'mixed'); assert.equal(group.children[1].state, 'failed');
    assert.equal(group.children[1].code, 'BROKER_NODE_OFFLINE');
    const receipt = group.children[0].receipt_id;
    const before = frames.length;
    assert.equal((await source.broadcast(body)).status, 200);
    assert.equal(frames.length, before, 'group replay never redispatches');
    assert.equal((await source.broadcast({ ...body, prompt: 'changed' })).status, 409);
    const context = await responder.replyContext(receipt); assert.equal(context.status, 200);
    assert.equal(context.body.source_node, 'a'); assert.equal(context.body.prompt, undefined);
    assert.equal((await foreign.replyContext(receipt)).status, 404);
    const responseBody = { target_node: 'a', return_session: 'return-worker', expected_epoch: epochs['return-worker'],
      idempotency_key: 'routing-reply-key-0001', prompt: 'Synthetic reply', no_enter: true };
    assert.equal((await foreign.reply(receipt, responseBody)).status, 404, 'unrelated node cannot claim original target');
    assert.equal((await responder.reply(receipt, { ...responseBody, target_node: 'c', return_session: 'offline' })).status, 403, 'a granted different node is still not original source');
    assert.equal((await responder.reply(receipt, { ...responseBody, from: 'a' })).status, 400);
    const reply = await responder.reply(receipt, responseBody); assert.equal(reply.status, 202);
    assert.equal(reply.body.in_reply_to, receipt);
    let answer;
    await waitFor(async () => { answer = (await responder.receipt(responseBody.idempotency_key)).body; return answer.state === 'accepted'; });
    assert.equal(answer.foreign_session_identity_verified, false);
    const staleBody = { ...responseBody, idempotency_key: 'routing-stale-key-0001', expected_epoch: 'stale-epoch' };
    assert.equal((await responder.reply(receipt, staleBody)).status, 202);
    await waitFor(async () => (await responder.receipt(staleBody.idempotency_key)).body.state === 'failed');

    await waitFor(() => frames.some(frame => frame.sid === 'return-worker'));
    assert.equal((await responder.reply(receipt, responseBody)).status, 200);

    // Fail the second child reservation after group+first child commits. No stream
    // write may occur; retry must project missing child uncertainty without repair.
    const partial = { ...body, idempotency_key: 'routing-partial-key-0001', targets: [body.targets[0], { node: 'b', session: 'other', expected_epoch: epochs.other }] };
    const groupKey = hash(`broker-broadcast:a:${partial.idempotency_key}`), secondKey = hash(`broker-broadcast-child:${groupKey}:1`);
    const open = fs.openSync; const frameCount = frames.length;
    fs.openSync = function(file, flags, ...rest) { if (typeof file === 'string' && file.endsWith(`${secondKey}.json`) && flags === 'wx') throw Object.assign(new Error('Synthetic reservation failure'), { code: 'EIO' }); return open.call(fs, file, flags, ...rest); };
    let failed;
    try { failed = await source.broadcast(partial); } finally { fs.openSync = open; }
    assert.equal(failed.status, 503); assert.equal(frames.length, frameCount);
    const partialQuery = await source.broadcastReceipt(partial.idempotency_key);
    assert.ok(partialQuery.body.children.every(child => child.state === 'outcome_unknown'));
    assert.equal(partialQuery.body.children[1].code, 'BROKER_CHILD_INTENT_MISSING');
    const replay = await source.broadcast(partial); assert.equal(replay.status, 200);
    assert.equal(frames.length, frameCount); assert.equal(fs.existsSync(path.join(root, '.telepty', 'forward-receipts', `${secondKey}.json`)), false);
    // Same idempotency key cannot be rebound to a different original receipt.
    const other = await source.inject('b', 'other', { prompt: 'Synthetic other', expected_epoch: epochs.other, idempotency_key: 'routing-other-key-0001', no_enter: true });
    assert.equal((await responder.reply(other.body.receipt_id, responseBody)).status, 409);
    const cliKey = path.join(root, 'cli-key.pem'), cliConfig = path.join(root, 'cli.json'), cliRequest = path.join(root, 'request.json');
    fs.writeFileSync(cliKey, a.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(cliConfig, JSON.stringify({ schema: 'telepty.broker-source/v1', principal_id: 'a', key_id: 'a',
      hub_url: origin, hub_audience: 'hub', private_key_path: cliKey }), { mode: 0o600 });
    fs.writeFileSync(cliRequest, JSON.stringify({ ...body, idempotency_key: 'routing-cli-key-0001', targets: [body.targets[1]] }), { mode: 0o600 });
    const cli = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', './test-support/setup-env.js', 'cli.js', 'broker-broadcast-v1', '--config', cliConfig, '--request', cliRequest],
        { cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: root, USERPROFILE: root }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.on('error', reject);
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Owned CLI deadline')); }, 5000);
      child.on('exit', code => { clearTimeout(timeout); resolve({ code, body: JSON.parse(output.trim()) }); });
    });
    assert.equal(cli.code, 1); assert.equal(cli.body.state, 'failed');
    assert.equal(cli.body.children[0].code, 'BROKER_NODE_OFFLINE');
    fs.chmodSync(cliRequest, 0o644);
    await assert.rejects(require('../src/broker/routing-cli').runBrokerRoutingRequest('broadcast', cliConfig, ['--request', cliRequest]),
      { code: 'AUTHORITY_FILE_UNAVAILABLE' }, 'request files containing prompts must be private');

    const contents = fs.readdirSync(path.join(root, '.telepty', 'forward-receipts')).map(name => fs.readFileSync(path.join(root, '.telepty', 'forward-receipts', name), 'utf8')).join('');
    assert.equal(contents.includes('Synthetic broadcast'), false); assert.equal(contents.includes('Synthetic reply'), false);
    dropResults = true;
    const lost = { ...body, idempotency_key: 'routing-lost-key-0001', targets: [body.targets[0]] };
    assert.equal((await source.broadcast(lost)).status, 202);
    await waitFor(async () => (await source.broadcastReceipt(lost.idempotency_key)).body.state === 'outcome_unknown');
    const deliveredBeforeReplay = frames.length;
    const lostReplay = await source.broadcast(lost); assert.equal(lostReplay.body.state, 'outcome_unknown');
    assert.equal(frames.length, deliveredBeforeReplay, 'lost result never causes delivery replay');

  } finally {
    for (const bridge of bridges) await bridge.stop();
    for (const owner of owners) owner.close();
    await hub.close(); await daemon.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
});
