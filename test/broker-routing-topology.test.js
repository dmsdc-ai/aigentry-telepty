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
const { IS_LINUX } = require('../test-support/windows-879/linux-authority');
const pair = () => crypto.generateKeyPairSync('ed25519');
const grant = (action, targets) => ({ action, targets });
const entry = (key, principal, pair, grants) => ({ key_id: key, principal_id: principal,
  public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }), grants });
const trust = (audience, keys) => ({ schema: 'telepty.principals/v1', audience, keys });
// Task 1215 windows121 (diagnostics only): a bounded, fixed-shape record of each request a bridge's test fetch seam issued —
// kind, settled, HTTP status OR an allowlisted error name, and error/cause code only when it is an uppercase code token.
// Never a prompt, URL, id, token, header, message or stack. observe() returns the caller's promise unchanged.
const OUTCOME_LIMIT = 32, CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/, ERROR_NAMES = ['TypeError', 'AbortError', 'TimeoutError', 'SyntaxError', 'Error'];
function requestOutcomes() {
  const records = []; let issued = 0;
  const kind = (url) => { const text = String(url); return text.includes('/v1/challenge') ? 'challenge' : text.includes('/results/') ? 'results' : /\/stream$/.test(text) ? 'stream' : 'other'; };
  const token = (value) => (typeof value === 'string' && CODE_TOKEN.test(value) ? value : null);
  return { kind,
    observe(url, pending) {
      const entry = { seq: ++issued, kind: kind(url), settled: false, status: null, error: null, code: null, cause_code: null };
      if (records.length < OUTCOME_LIMIT) records.push(entry);
      Promise.resolve(pending).then((response) => { entry.settled = true; entry.status = Number.isInteger(response && response.status) ? response.status : null; },
        (reason) => { entry.settled = true; entry.error = ERROR_NAMES.includes(reason && reason.name) ? reason.name : 'other';
          entry.code = token(reason && reason.code); entry.cause_code = token(reason && reason.cause && reason.cause.code); });
      return pending;
    },
    snapshot: () => ({ issued, kept: records.length, records: records.map((entry) => ({ ...entry })) }) };
}
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
  const nodeRuns = {}; // Task 1215 native39: diagnostics only — how each bridge's run loop settled (fixed labels / code tokens)
  const nodeARequests = requestOutcomes(); // Task 1215 windows121: diagnostics only — node a's per-request outcomes
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
        return node === 'a' ? nodeARequests.observe(url, fetch(url, options)) : fetch(url, options);
      }, privateKey: keys.privateKey, localToken: daemon.authToken(), config: {
        schema: 'telepty.broker-node/v1', principal_id: node, key_id: node, hub_url: origin, hub_audience: 'hub',
        hub_principal_id: 'hub', audience: node, local_daemon_url: `http://127.0.0.1:${daemon.port}`, local_timeout_ms: 500,
        hub_trust: trust(node, [entry('h', 'hub', h, [grant('broker.envelope', targets)])]) } });
      bridges.push(bridge); await bridge.start();
      nodeRuns[node] = 'running'; // observe-only: the node's own completion promise is never awaited or altered here
      bridge.completion.then(() => { nodeRuns[node] = 'ended'; },
        (reason) => { const code = reason && reason.code; nodeRuns[node] = `rejected:${typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'other'}`; });
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
    const replyAdmitted = performance.now(); // Task 1215 native39: diagnostics only
    await waitFor(async () => { answer = (await responder.receipt(responseBody.idempotency_key)).body; return answer.state === 'accepted'; })
      .catch((error) => {
        // Task 1215 native39 (failure-only; the wait has ALREADY failed and the same error is rethrown): the last receipt the
        // unchanged poll saw (fixed fields only — never a prompt), owner frames per sid (counts) and each bridge's run state.
        // Discriminates node-side local timeout (BROKER_LOCAL_OUTCOME_UNKNOWN), hub result timer (BROKER_RESULT_TIMEOUT),
        // stream loss, a stopped bridge loop, and a delivered-but-unreported frame. V8 formats `stack` lazily: read it first.
        const stack = error.stack; const first = `${error.name}: ${error.message}`;
        const count = (sid) => frames.filter((f) => f.sid === sid).length;
        const note = ` | #1215 native39 evidence ${JSON.stringify({ waited_ms: Math.round(performance.now() - replyAdmitted),
          last_receipt: answer ? { state: answer.state ?? null, code: answer.code ?? null, remote_queued: answer.remote_queued ?? null,
            has_remote_inject_id: Boolean(answer.remote_inject_id), in_reply_to_matches: answer.in_reply_to === receipt } : null,
          frames: { worker: count('worker'), other: count('other'), 'return-worker': count('return-worker') }, nodes: { ...nodeRuns },
          node_a_requests: nodeARequests.snapshot() })}`;
        error.message += note;
        if (typeof stack === 'string' && stack.startsWith(first)) error.stack = first + note + stack.slice(first.length);
        throw error;
      });
    assert.equal(answer.foreign_session_identity_verified, false);
    const staleBody = { ...responseBody, idempotency_key: 'routing-stale-key-0001', expected_epoch: 'stale-epoch' };
    assert.equal((await responder.reply(receipt, staleBody)).status, 202);
    let staleAnswer; const staleAdmitted = performance.now(); // Task 1215 lifecycle56: diagnostics only
    await waitFor(async () => { staleAnswer = (await responder.receipt(staleBody.idempotency_key)).body; return staleAnswer.state === 'failed'; })
      .catch((error) => {
        // Task 1215 lifecycle56 (failure-only; the unchanged poll and bound have ALREADY failed and the same error is
        // rethrown; nothing is sent or retried). The last receipt the poll saw separates: node local timeout
        // (outcome_unknown / BROKER_LOCAL_OUTCOME_UNKNOWN), local 5xx (outcome_unknown / BROKER_LOCAL_INJECT_REFUSED),
        // node never reported (BROKER_RESULT_TIMEOUT), stream loss (BROKER_STREAM_LOST), still in flight (pending), and
        // a stale epoch that was ADMITTED (accepted; a second return-worker frame). Fixed fields only — never a prompt.
        const stack = error.stack; const first = `${error.name}: ${error.message}`;
        const count = (sid) => frames.filter((f) => f.sid === sid).length;
        const note = ` | #1215 lifecycle56 evidence ${JSON.stringify({ waited_ms: Math.round(performance.now() - staleAdmitted),
          last_receipt: staleAnswer ? { state: staleAnswer.state ?? null, code: staleAnswer.code ?? null, remote_queued: staleAnswer.remote_queued ?? null,
            has_remote_inject_id: Boolean(staleAnswer.remote_inject_id), in_reply_to_matches: staleAnswer.in_reply_to === receipt,
            expected_epoch_is_stale: staleAnswer.expected_epoch === 'stale-epoch' } : null,
          first_reply: answer ? { state: answer.state ?? null, has_remote_inject_id: Boolean(answer.remote_inject_id) } : null,
          frames: { worker: count('worker'), other: count('other'), 'return-worker': count('return-worker') }, nodes: { ...nodeRuns } })}`;
        error.message += note;
        if (typeof stack === 'string' && stack.startsWith(first)) error.stack = first + note + stack.slice(first.length);
        throw error;
      });

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
      let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; }); child.on('error', reject);
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Owned CLI deadline')); }, 5000);
      child.on('exit', code => { clearTimeout(timeout); resolve({ code, output, errors }); });
    });
    // #879: the CLI's private config/key/request files go through readAuthorityFile — Linux-only
    // (src/principal/authority-file.js:15). Off Linux the same CLI and loader must refuse before any send.
    if (IS_LINUX) {
      cli.body = JSON.parse(cli.output.trim());
      assert.equal(cli.code, 1); assert.equal(cli.body.state, 'failed');
      assert.equal(cli.body.children[0].code, 'BROKER_NODE_OFFLINE');
      fs.chmodSync(cliRequest, 0o644);
      await assert.rejects(require('../src/broker/routing-cli').runBrokerRoutingRequest('broadcast', cliConfig, ['--request', cliRequest]),
        { code: 'AUTHORITY_FILE_UNAVAILABLE' }, 'request files containing prompts must be private');
    } else {
      assert.equal(cli.code, 1); assert.equal(cli.output, '', 'a refused CLI prints no result');
      assert.match(cli.errors, /BROKER_REQUEST_FAILED/);
      assert.equal(cli.errors.includes('Synthetic broadcast'), false);
      await assert.rejects(require('../src/broker/routing-cli').runBrokerRoutingRequest('broadcast', cliConfig, ['--request', cliRequest]),
        { code: 'BROKER_FILE_UNSAFE' }, 'an unsupported platform refuses even a private config');
    }

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

// Task 1215 windows121: a deterministic uncertain result on node a's REPLY leg. This is a diagnostic reproduction of the
// Windows :88 tuple; it fixes nothing, and the original trigger stays unknown. Node a's fetch seam holds ONE request of the
// named stage that follows its local forwarded inject: the result POST, or (a separate variant) the challenge GET just
// before it. It holds that request until the hub's own 500 ms result timer has recorded outcome_unknown/BROKER_RESULT_TIMEOUT,
// then rejects it with a coded socket TypeError. Holding keeps node a's stream open, so the hub's stream-loss path
// (BROKER_STREAM_LOST, hub.js close handler) cannot pre-empt the timer. The ordering is event-driven, with no added clock constant.
for (const stage of ['results', 'challenge']) test(`a lost reply result (${stage === 'results' ? 'result POST' : 'challenge GET before it'}) stays one frame and a truthful bounded unknown, never retried`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-uncertain-'));
  const daemon = await startTestDaemon();
  const a = pair(), b = pair(), h = pair();
  const limits = { max_payload_bytes: 512, max_requests: 100, window_ms: 60000, timeout_ms: 500, max_pending: 16 };
  const hub = createBrokerHub({ homeDir: root, privateKey: h.privateKey, config: { schema: 'telepty.broker-hub/v1',
    principal_id: 'hub', key_id: 'h', audience: 'hub', stream_ms: 60000,
    nodes: { a: { audience: 'a' }, b: { audience: 'b' } }, limits: { a: limits, b: limits },
    trust: trust('hub', [
      entry('a', 'a', a, [grant('broker.stream', ['a']), grant('broker.result', ['a']), grant('broker.inject', ['b/worker']), grant('broker.receipt', ['a'])]),
      entry('b', 'b', b, [grant('broker.stream', ['b']), grant('broker.result', ['b']), grant('broker.reply_context', ['b']),
        grant('broker.reply', ['a/return-worker']), grant('broker.receipt', ['b'])])
    ]) } });
  const bridges = [], owners = [], frames = [], epochs = {}, attempts = { challenge: 0, results: 0 };
  const requests = requestOutcomes();
  let localInjected = false, release;
  const released = new Promise((resolve) => { release = resolve; });
  try {
    const address = await hub.listen(); const origin = `http://127.0.0.1:${address.port}`;
    for (const sid of ['worker', 'return-worker']) {
      epochs[sid] = (await daemon.registerSession(sid)).body.session_epoch;
      const owner = await daemon.connectSession(sid, daemon.ownerAuth(sid)); owners.push(owner);
      owner.on('message', raw => { const frame = JSON.parse(raw); if (frame.type === 'inject') frames.push({ sid, frame }); });
    }
    for (const [node, keys, targets] of [['a', a, ['b/return-worker']], ['b', b, ['a/worker']]]) {
      const bridge = createBrokerNode({ fetch: (url, options) => {
        if (node !== 'a') return fetch(url, options);
        const kind = requests.kind(url);
        if (String(url).includes('/api/forwarded/')) localInjected = true;
        if (localInjected && (kind === 'challenge' || kind === 'results')) attempts[kind] += 1;
        const held = localInjected && kind === stage && attempts[kind] === 1;
        return requests.observe(url, held ? released.then(() => { throw new TypeError('fetch failed',
          { cause: Object.assign(new Error('synthetic'), { code: 'UND_ERR_SOCKET' }) }); }) : fetch(url, options));
      }, privateKey: keys.privateKey, localToken: daemon.authToken(), config: {
        schema: 'telepty.broker-node/v1', principal_id: node, key_id: node, hub_url: origin, hub_audience: 'hub',
        hub_principal_id: 'hub', audience: node, local_daemon_url: `http://127.0.0.1:${daemon.port}`, local_timeout_ms: 500,
        hub_trust: trust(node, [entry('h', 'hub', h, [grant('broker.envelope', targets)])]) } });
      bridges.push(bridge); await bridge.start();
    }
    const client = (principal, privateKey) => createBrokerClient({ config: { principal_id: principal, key_id: principal, hub_audience: 'hub', hub_url: origin }, privateKey });
    const source = client('a', a.privateKey), responder = client('b', b.privateKey);
    const count = (sid) => frames.filter((f) => f.sid === sid).length;
    const original = await source.inject('b', 'worker', { prompt: 'Synthetic original', expected_epoch: epochs.worker, idempotency_key: 'uncertain-original-0001', no_enter: true });
    assert.equal(original.status, 202, JSON.stringify({ code: original.body && original.body.code }));
    await waitFor(async () => (await source.receipt('uncertain-original-0001')).body.state === 'accepted');
    const replyBody = { target_node: 'a', return_session: 'return-worker', expected_epoch: epochs['return-worker'],
      idempotency_key: 'uncertain-reply-0001', prompt: 'Synthetic reply', no_enter: true };
    assert.equal((await responder.reply(original.body.receipt_id, replyBody)).status, 202);
    let answer;
    await waitFor(async () => { answer = (await responder.receipt(replyBody.idempotency_key)).body; return answer.state !== 'pending'; });
    assert.deepEqual({ state: answer.state, code: answer.code }, { state: 'outcome_unknown', code: 'BROKER_RESULT_TIMEOUT' });
    await waitFor(() => attempts[stage] === 1, { description: `node a issued the held ${stage} request` });
    release();
    const reason = await bridges[0].completion.then(() => null, (failure) => failure);
    assert.ok(reason instanceof TypeError && reason.cause && reason.cause.code === 'UND_ERR_SOCKET', 'node a completion rejects with the coded socket failure');
    await waitFor(() => count('worker') >= 1 && count('return-worker') >= 1);
    assert.deepEqual(attempts, stage === 'results' ? { challenge: 1, results: 1 } : { challenge: 1, results: 0 }, 'the result path ran once and was never retried');
    assert.deepEqual(requests.snapshot().records.filter((r) => r.error !== null).map(({ seq, ...rest }) => rest),
      [{ kind: stage, settled: true, status: null, error: 'TypeError', code: null, cause_code: 'UND_ERR_SOCKET' }]);
    const after = (await responder.receipt(replyBody.idempotency_key)).body;
    assert.deepEqual({ state: after.state, code: after.code }, { state: 'outcome_unknown', code: 'BROKER_RESULT_TIMEOUT' }, 'node a stopping later does not rewrite the bounded unknown');
    assert.deepEqual({ worker: count('worker'), 'return-worker': count('return-worker') }, { worker: 1, 'return-worker': 1 }, 'exactly one local frame per leg; no duplicate');
  } finally {
    release();
    for (const bridge of bridges) await bridge.stop();
    for (const owner of owners) owner.close();
    await hub.close(); await daemon.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
});
