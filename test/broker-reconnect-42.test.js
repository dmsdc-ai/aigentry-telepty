'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBrokerNode } = require('../src/broker/node');
const { createSignedAssertion } = require('../src/principal/proof');
function fixture(options = {}) {
  const hub = crypto.generateKeyPairSync('ed25519'), nodeKey = crypto.generateKeyPairSync('ed25519');
  const config = { schema: 'telepty.broker-node/v1', principal_id: 'b', key_id: 'b-key', hub_url: 'http://127.0.0.1:39001', hub_audience: 'hub',
    hub_principal_id: 'hub', audience: 'b', local_daemon_url: 'http://127.0.0.1:39002', local_timeout_ms: 100,
    reconnect: { max_attempts: 2, initial_backoff_ms: 10, max_backoff_ms: 20 },
    hub_trust: { schema: 'telepty.principals/v1', audience: 'b', keys: [{ key_id: 'hub-key', principal_id: 'hub',
      public_key_spki: hub.publicKey.export({ type: 'spki', format: 'pem' }), grants: [{ action: 'broker.envelope', targets: ['a/worker'] }] }] }, ...options.config };
  let streams = 0, posts = 0, delivered = 0; const challenges = []; let previousFrame;
  const node = createBrokerNode({ config, privateKey: nodeKey.privateKey, localToken: 'synthetic', fetch: async (url, init) => {
    if (url.endsWith('/v1/challenge') && options.challengeHangs) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    if (url.endsWith('/v1/challenge')) return new Response(JSON.stringify({ schema: 'telepty.broker-challenge/v1', audience: 'hub', challenge: 'h'.repeat(32) }));
    if (url.includes('/results/')) { posts++; if (options.resultFailure) throw new TypeError('network'); return new Response('{}'); }
    if (url.startsWith(config.local_daemon_url)) { delivered++; return new Response(JSON.stringify({ success: false, code: 'FORWARD_OUTCOME_UNKNOWN' }), { status: 202 }); }
    streams++; challenges.push(JSON.parse(init.body).challenge);
    if (options.network && streams > 1) throw new TypeError('network');
    if (options.refused || (options.refusedAfterFirst && streams > 1)) return new Response('{}', { status: options.refused || 403 });
    if (options.handshake) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    const response = new Response(new ReadableStream({ start(controller) {
      if (options.signature) controller.enqueue(Buffer.from('data: {"envelope":{}}\n\n'));
      else if (options.protocol) controller.enqueue(Buffer.from('bad\n\n'));
      else if (options.messages && streams <= 2) {
        const envelope = { schema: 'telepty.broker-envelope/v1', receipt_id: String(streams).repeat(64), source_node: 'a', target_node: 'b', session: 'worker',
          payload: { prompt: 'Synthetic input', expected_epoch: 'epoch', no_enter: true }, hop: 1, foreign_session_identity_verified: false };
        const assertion = createSignedAssertion({ privateKey: hub.privateKey, keyId: 'hub-key', principalId: 'hub', audience: 'b', challenge: challenges.at(-1),
          method: 'EVENT', target: `/v1/envelopes/${envelope.receipt_id}`, body: envelope, action: 'broker.envelope', sessionEpoch: 'epoch' });
        const frame = `data: ${JSON.stringify({ envelope, assertion })}\n\n`;
        controller.enqueue(Buffer.from(options.replay && previousFrame ? previousFrame : frame));
        previousFrame = frame;
      }
      if (!options.hold) controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
    return response;
  } });
  return { node, challenges, counts: () => ({ streams, posts, delivered }) };
}
test('opt-in reconnect uses fresh challenges, bounds attempts, and never replays uncertain delivery', async () => {
  const f = fixture({ messages: true }); await f.node.start();
  await assert.rejects(f.node.completion, { code: 'BROKER_RECONNECT_EXHAUSTED' });
  assert.deepEqual(f.counts(), { streams: 3, posts: 2, delivered: 2 });
  assert.equal(new Set(f.challenges).size, 3); await f.node.stop();
});
test('default stream EOF retains stop behavior', async () => {
  const f = fixture({ config: { reconnect: undefined } }); await f.node.start(); await f.node.completion;
  assert.equal(f.counts().streams, 1); await f.node.stop();
});
test('stop cancels backoff without another handshake', async () => {
  const f = fixture({ config: { reconnect: { max_attempts: 2, initial_backoff_ms: 1000, max_backoff_ms: 1000 } } });
  await f.node.start(); await f.node.stop(); assert.equal(f.counts().streams, 1);
});
test('auth, protocol, and failed result POST are terminal', async () => {
  for (const options of [{ refused: 403 }, { protocol: true }, { signature: true }, { messages: true, resultFailure: true }]) {
    const f = fixture(options);
    if (options.refused) await assert.rejects(f.node.start(), { code: 'BROKER_STREAM_REFUSED' });
    else { await f.node.start(); await assert.rejects(f.node.completion); }
    assert.equal(f.counts().streams, 1); await f.node.stop();
  }
});
test('stop cancels an in-flight header handshake', async () => {
  const f = fixture({ handshake: true }); const starting = f.node.start();
  await new Promise(resolve => setImmediate(resolve)); await f.node.stop(); await assert.rejects(starting);
  assert.equal(f.counts().streams, 1);
});

test('transient reconnect handshake failures exhaust finite attempts', async () => {
  const f = fixture({ network: true }); await f.node.start();
  await assert.rejects(f.node.completion, { code: 'BROKER_RECONNECT_EXHAUSTED' });
  assert.equal(f.counts().streams, 3); await f.node.stop();
});
test('configuration rejects unbounded or malformed reconnect policies', () => {
  for (const reconnect of [true, {}, { max_attempts: 11, initial_backoff_ms: 10, max_backoff_ms: 20 },
    { max_attempts: 1, initial_backoff_ms: 10, max_backoff_ms: 30001 },
    { max_attempts: 1, initial_backoff_ms: 10, max_backoff_ms: 20, retry_results: true }]) {
    assert.throws(() => fixture({ config: { reconnect } }), { code: 'BROKER_CONFIG_INVALID' });
  }
});

test('challenge and stream headers have finite deadlines', async () => {
  await Promise.all([{ challengeHangs: true }, { handshake: true }].map(async options => {
    const f = fixture(options); const before = Date.now();
    await assert.rejects(f.node.start(), { code: 'BROKER_HEADER_TIMEOUT' });
    assert.ok(Date.now() - before < 5000); await f.node.stop();
  }));
});
test('stop cancels challenge fetch before any stream request', async () => {
  const f = fixture({ challengeHangs: true }); const starting = f.node.start();
  await new Promise(resolve => setImmediate(resolve)); await f.node.stop(); await assert.rejects(starting);
  assert.equal(f.counts().streams, 0);
});

test('old signed envelopes cannot cross a fresh reconnect challenge', async () => {
  const f = fixture({ messages: true, replay: true }); await f.node.start();
  await assert.rejects(f.node.completion);
  assert.deepEqual(f.counts(), { streams: 2, posts: 1, delivered: 1 }); await f.node.stop();
});

test('stop cancels a blocked reader and auth refusal after disconnect is terminal', async () => {
  const held = fixture({ hold: true }); await held.node.start(); await held.node.stop();
  assert.equal(held.counts().streams, 1);
  const refused = fixture({ refusedAfterFirst: true }); await refused.node.start();
  await assert.rejects(refused.node.completion, { code: 'BROKER_STREAM_REFUSED' });
  assert.equal(refused.counts().streams, 2); await refused.node.stop();
});
