'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { FileMailbox } = require('../src/mailbox');
const { DeliveryEngine } = require('../src/mailbox/delivery');
const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
function fixture(root, address) {
  const mailbox = new FileMailbox({ root, retryBackoffSecs: 0, inflightTimeoutSecs: 0, maxRetries: 10 });
  const session = { id: 'fixture', sessionEpoch: 'fixture-epoch', type: 'aterm', delivery: { transport: 'unix_socket', address } };
  const events = []; let engine;
  const context = createSessionDeliveryContext({ sessions: { fixture: session }, DELIVERY_TIMEOUT_MS: 60,
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
for (const mode of ['oversize', 'timeout']) {
  test(`UDS ${mode}: source reports unknown, repeated ticks/restart never repeat body or submit`, { skip: process.platform === 'win32', timeout: 10000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-uds-unknown-')), address = path.join(root, 'sock'), sockets = new Set();
    let bodies = 0; const texts = [];
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      let input = '';
      socket.on('data', chunk => { input += chunk.toString(); if (input.includes('\n')) { bodies++; texts.push(JSON.parse(input).text); if (mode === 'oversize') socket.end(Buffer.alloc(70000, 'x')); } });
    });
    await new Promise(resolve => server.listen(address, resolve));
    try {
      const f = fixture(path.join(root, 'mailbox'), address);
      const result = await f.context.deliverInjectionToSession('fixture', f.session, 'PRIVATE_BODY', { noEnter: false, from: 'fixture-source' });
      assert.equal(result.success, false); assert.equal(result.code, 'DELIVERY_UNCERTAIN'); assert.equal(result.delivery_uncertain, true);
      assert.equal(result.retryable, false); assert.equal(result.submit, 'skipped'); assert.equal(bodies, 1); assert.deepEqual(texts, ['PRIVATE_BODY']);
      assert.equal(f.mailbox.messageState('fixture', result.msg_id), 'dead_letter');
      const quarantined = f.mailbox.peekDeadLetter('fixture'); assert.equal(quarantined.length, 1);
      assert.equal(quarantined[0].outcome, 'unknown'); assert.equal(quarantined[0].reason, 'delivery_outcome_unknown');
      assert.equal(quarantined[0].from, 'fixture-source'); assert.equal(quarantined[0].payload, 'PRIVATE_BODY');
      assert.ok(f.events.some(event => event.type === 'mailbox_delivery_unknown'));
      assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_BODY/);
      for (let i = 0; i < 4; i++) await f.engine.tick();
      const restarted = fixture(path.join(root, 'mailbox'), address);
      for (let i = 0; i < 4; i++) await restarted.engine.tick();
      assert.equal(bodies, 1); assert.equal(restarted.mailbox.messageState('fixture', result.msg_id), 'dead_letter');
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
test('fsynced attempt fence survives restart before a response/outcome is recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-uds-fence-'));
  try {
    const f = fixture(root, '/unused');
    f.mailbox.enqueue({ msg_id: 'interrupted', from: 'source', to: 'fixture', payload: 'PRIVATE_BODY', created_at: Math.floor(Date.now()/1000) });
    f.mailbox.dequeue('fixture'); assert.equal(f.mailbox.beginNonRetryableAttempt('fixture', 'interrupted'), true);
    const recovered = new FileMailbox({ root, inflightTimeoutSecs: 0 }); assert.equal(recovered.recoverInflight('fixture'), 1);
    assert.equal(recovered.dequeue('fixture'), null); assert.equal(recovered.messageState('fixture', 'interrupted'), 'dead_letter');
    const row = recovered.peekDeadLetter('fixture')[0]; assert.equal(row.reason, 'delivery_outcome_unknown_after_interruption'); assert.equal(row.delivery_uncertain, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('definite connection refusal stays retryable, and source reports a pending retry rather than a write', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-uds-retry-')), address = path.join(root, 'sock'); let bodies = 0;
  const f = fixture(path.join(root, 'mailbox'), address);
  const queued = await f.context.deliverInjectionToSession('fixture', f.session, 'synthetic', { noEnter: true });
  assert.equal(queued.success, true); assert.equal(queued.queued, true); assert.equal(queued.delivery_status, 'retry_pending'); assert.equal(queued.bytes_written, 0);
  assert.equal(f.mailbox.messageState('fixture', queued.msg_id), 'pending');
  const server = net.createServer(socket => { socket.on('data', () => { bodies++; socket.end('{"success":true}'); }); });
  await new Promise(resolve => server.listen(address, resolve));
  try { await f.engine.tick(); assert.equal(bodies, 1); assert.equal(f.mailbox.messageState('fixture', queued.msg_id), 'acked'); }
  finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
test('effectful callback throw is quarantined and source never emits CR or blind fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-delivery-throw-')); const frames = [];
  try {
    const f = fixture(root, '/unused'); f.session.type = 'wrapped';
    f.session.ownerWs = { readyState: 1, send(raw) { frames.push(JSON.parse(raw).data); throw Error('unmeasured post-write failure'); } };
    const result = await f.context.deliverInjectionToSession('fixture', f.session, 'PRIVATE_BODY', { from: 'source' });
    assert.equal(result.success, false); assert.equal(result.code, 'DELIVERY_UNCERTAIN'); assert.equal(result.delivery_uncertain, true);
    assert.equal(result.submit, 'skipped'); assert.deepEqual(frames, ['PRIVATE_BODY']);
    for (let i = 0; i < 3; i++) await f.engine.tick();
    const restarted = fixture(root, '/unused'); for (let i = 0; i < 3; i++) await restarted.engine.tick();
    assert.deepEqual(frames, ['PRIVATE_BODY']); assert.equal(restarted.mailbox.peekDeadLetter('fixture')[0].outcome, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('real API and tracked ledger preserve uncertain UDS attempt rather than false zero-write refusal', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-uds-api-')), address = path.join(root, 'sock'); let bodies = 0;
  const sockets = new Set(), server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString(); if (!input.includes('\n')) return;
      const message = JSON.parse(input);
      if (message.action === 'Inject') { bodies++; socket.end(Buffer.alloc(70000, 'x')); }
      else socket.end('{"success":true}');
    });
  });
  await new Promise(resolve => server.listen(address, resolve));
  const { startTestDaemon } = require('../test-support/daemon-harness'); const harness = await startTestDaemon();
  try {
    assert.equal((await harness.registerSession('uncertain-fixture', { command: 'fixture', delivery_type: 'aterm', delivery: { transport: 'unix_socket', address } })).status, 201);
    const result = await harness.request('/api/sessions/uncertain-fixture/inject', { method: 'POST', body: { prompt: 'PRIVATE_BODY', from: 'orchestrator', exact_target: true } });
    assert.equal(result.status, 502); assert.equal(result.body.code, 'DELIVERY_UNCERTAIN');
    assert.equal(result.body.delivery_uncertain, true); assert.equal(result.body.retryable, false); assert.equal(result.body.bytes_written, null);
    assert.equal(result.body.submit, 'skipped'); assert.equal(bodies, 1);
    const observation = await harness.request('/api/inject-observations/' + result.body.inject_id);
    assert.equal(observation.body.observation.kind, 'inject_delivery_unknown'); assert.equal(observation.body.observation.bytes_written, null);
    assert.equal(observation.body.completion_fact, null);
    await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(bodies, 1);
  } finally { for (const socket of sockets) socket.destroy(); await harness.stop(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
test('enqueue that commits then throws never authorizes a duplicate direct fallback or later retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-partial-enqueue-')); const frames = [];
  try {
    const f = fixture(root, '/unused'); f.session.type = 'wrapped'; f.session.ownerWs = { readyState: 1, send(raw) { frames.push(JSON.parse(raw).data); } };
    const enqueue = f.mailbox.enqueue.bind(f.mailbox); f.mailbox.enqueue = message => { enqueue(message); throw Error('post-commit fixture error'); };
    const result = await f.context.deliverInjectionToSession('fixture', f.session, 'PRIVATE_BODY', { from: 'source' });
    assert.equal(result.code, 'DELIVERY_UNCERTAIN'); assert.equal(result.delivery_uncertain, true); assert.deepEqual(frames, []);
    assert.equal(f.mailbox.messageState('fixture', result.msg_id), 'dead_letter');
    const restarted = fixture(root, '/unused'); for (let i = 0; i < 3; i++) await restarted.engine.tick(); assert.deepEqual(frames, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('caller deadline quarantines in-flight unknown text and never permits late retry or CR', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-caller-unknown-')); const frames = [];
  try {
    const f = fixture(root, '/unused'); f.session.type = 'wrapped'; f.session.ownerWs = { readyState: 1, send(raw) { frames.push(JSON.parse(raw).data); } };
    const tick = f.engine.tick.bind(f.engine);
    f.engine.tick = async () => { const message = f.mailbox.dequeue('fixture'); f.mailbox.beginNonRetryableAttempt('fixture', message.msg_id); };
    const result = await f.context.deliverInjectionToSession('fixture', f.session, 'PRIVATE_BODY', { from: 'source' });
    assert.equal(result.code, 'DELIVERY_UNCERTAIN'); assert.equal(result.delivery_uncertain, true); assert.equal(result.bytes_written, null);
    assert.equal(result.submit, 'skipped'); assert.equal(f.mailbox.messageState('fixture', result.msg_id), 'dead_letter');
    for (let i = 0; i < 3; i++) await tick();
    const restarted = fixture(root, '/unused'); for (let i = 0; i < 3; i++) await restarted.engine.tick(); assert.deepEqual(frames, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
