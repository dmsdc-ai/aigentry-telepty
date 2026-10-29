'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { FileMailbox } = require('../src/mailbox');
const { DeliveryEngine } = require('../src/mailbox/delivery');
const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
function fixture(root, endpoint, extra = {}) {
  const mailbox = new FileMailbox({ root, retryBackoffSecs: 0, inflightTimeoutSecs: 0, maxRetries: 10 });
  const session = { id: 'fixture', sessionEpoch: 'fixture-epoch', type: 'aterm', deliveryEndpoint: endpoint };
  const events = []; let engine;
  const context = createSessionDeliveryContext({ ...extra, sessions: { fixture: session }, DELIVERY_TIMEOUT_MS: 60,
    isOpenWebSocket: ws => ws?.readyState === 1, armUpstreamProbe() {},
    hasHeldInteraction: () => false, interaction: { invalidateInteraction() {} },
    buildErrorBody: (code, error, extra) => ({ success: false, code, error, ...extra }), markSessionDisconnected() {},
    crypto: require('node:crypto'), shouldQueueBootstrapOperation: () => false, getInjectFailure: () => null,
    resolveModalGate: async () => null, modalRemedy: () => 'reject', hasBootstrapBacklog: () => false,
    applyProvenance: payload => ({ payload }), maybeBracketedPaste: payload => payload,
    getMailbox: () => mailbox, getMailboxNotifier: () => ({ notify() {} }), getMailboxDelivery: () => engine,
    broadcastSessionEvent: (type, _id, _session, data) => events.push({ type, ...data }) });
  engine = new DeliveryEngine(mailbox, context.mailboxDeliveryOptions);
  return { mailbox, engine, context, session, events };
}

for (const mode of ['lost-response', 'timeout', 'server-error', 'redirect']) {
  test(`HTTP ${mode} after receipt is quarantined across ticks and restart`, { timeout: 10000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-http-unknown-'));
    const received = []; let redirected = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/redirected') { redirected++; res.end(); return; }
      let body = ''; req.on('data', chunk => body += chunk);
      req.on('end', () => {
        received.push(JSON.parse(body));
        if (mode === 'lost-response') req.socket.destroy();
        else if (mode === 'server-error') { res.writeHead(503); res.end('failed after effect'); }
        else if (mode === 'redirect') { res.writeHead(307, { location: '/redirected' }); res.end(); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/deliver`;
    try {
      const f = fixture(root, endpoint);
      const result = await f.context.deliverInjectionToSession('fixture', f.session, 'PRIVATE_BODY', { noEnter: false, from: 'source' });
      assert.equal(result.success, false); assert.equal(result.delivery_uncertain, true);
      assert.equal(result.retryable, false); assert.equal(result.bytes_written, null); assert.equal(result.submit, 'skipped');
      assert.equal(f.mailbox.messageState('fixture', result.msg_id), 'dead_letter');
      for (let i = 0; i < 3; i++) await f.engine.tick();
      const restarted = fixture(root, endpoint); for (let i = 0; i < 3; i++) await restarted.engine.tick();
      assert.deepEqual(received.map(body => body.text), ['PRIVATE_BODY']); assert.equal(redirected, 0);
      assert.equal(restarted.mailbox.messageState('fixture', result.msg_id), 'dead_letter');
      assert.equal(restarted.mailbox.peekDeadLetter('fixture')[0].outcome, 'unknown');
      assert.ok(f.events.some(event => event.type === 'mailbox_delivery_unknown'));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
test('HTTP 2xx is endpoint acceptance only, not consumption or an agent reply', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-http-accept-'));
  try {
    const f = fixture(root, 'http://fixture.invalid', { fetch: async () => ({ ok: true, status: 202 }) });
    const result = await f.context.writeDataToSession('fixture', f.session, 'synthetic');
    assert.equal(result.success, true); assert.equal(result.transport_receipt, 'http_2xx');
    assert.equal(result.consumption, 'unknown'); assert.equal(result.reply, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('HTTP durable beforeWrite refusal makes no network attempt and remains known zero', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-http-fence-')); let attempts = 0;
  try {
    const f = fixture(root, 'http://fixture.invalid', { fetch: async () => { attempts++; throw Error('must not call'); } });
    const result = await f.context.writeDataToSession('fixture', f.session, 'synthetic', { beforeWrite: () => false });
    assert.equal(result.success, false); assert.equal(result.bytes_written, 0); assert.equal(attempts, 0);
    assert.notEqual(result.delivery_uncertain, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('HTTP API and observation ledger retain unknown delivery rather than reporting queued zero-write', { timeout: 15000 }, async () => {
  const { startTestDaemon } = require('../test-support/daemon-harness');
  let writes = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { writes++; res.writeHead(503); res.end('post-effect error'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const harness = await startTestDaemon();
  try {
    const registered = await harness.registerSession('http-uncertain', {
      command: 'fixture', delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${server.address().port}/deliver`
    });
    assert.equal(registered.status, 201);
    const result = await harness.request('/api/sessions/http-uncertain/inject', { method: 'POST',
      body: { prompt: 'PRIVATE_BODY', from: 'orchestrator', exact_target: true } });
    assert.equal(result.body.success, false); assert.equal(result.body.code, 'DELIVERY_UNCERTAIN');
    assert.equal(result.body.delivery_uncertain, true); assert.equal(result.body.bytes_written, null);
    assert.equal(result.body.retryable, false); assert.equal(result.body.submit, 'skipped');
    const observation = await harness.request('/api/inject-observations/' + result.body.inject_id);
    assert.equal(observation.body.observation.kind, 'inject_delivery_unknown');
    assert.equal(observation.body.observation.bytes_written, null); assert.equal(observation.body.completion_fact, null);
    await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(writes, 1);
  } finally { await harness.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
