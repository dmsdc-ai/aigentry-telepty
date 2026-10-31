'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startTestDaemon } = require('../test-support/daemon-harness');
const { createForwardLedger } = require('../src/peer-forwarding');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('destination receipt keeps post-effect uncertainty across replay and ledger reconstruction', { timeout: 15000 }, async () => {
  let attempts = 0;
  const endpoint = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { attempts++; res.writeHead(503); res.end('after effect'); });
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const daemon = await startTestDaemon();
  try {
    const registered = await daemon.registerSession('destination', { delivery_type: 'aterm',
      delivery_endpoint: `http://127.0.0.1:${endpoint.address().port}/deliver` });
    assert.equal(registered.status, 201);
    const key = hash('synthetic-forwarded-uncertain');
    const body = { prompt: 'PRIVATE_BODY', no_enter: false, expected_epoch: registered.body.session_epoch,
      exact_target: true, forwarding: { hop: 1, key } };
    const send = () => daemon.request('/api/forwarded/sessions/destination/inject', { method: 'POST', body });
    const first = await send();
    assert.equal(first.body.delivery_uncertain, true); assert.equal(first.body.bytes_written, null);
    const restored = createForwardLedger(daemon.homeDir).read(hash(`inbound:${key}`));
    assert.equal(restored.state, 'outcome_unknown');
    assert.equal(restored.remote_receipt.delivery_uncertain, true);
    assert.equal(restored.remote_receipt.bytes_written, null); assert.equal(restored.remote_receipt.retryable, false);
    assert.equal(restored.remote_receipt.submit, 'skipped');
    const replay = await send();
    assert.equal(replay.body.inject_id, first.body.inject_id);
    assert.equal(replay.body.delivery_uncertain, true); assert.equal(replay.body.bytes_written, null);
    assert.equal(replay.body.retryable, false); assert.equal(replay.body.submit, 'skipped');
    assert.equal(attempts, 1);
    assert.equal(JSON.stringify(restored).includes('PRIVATE_BODY'), false);
  } finally { await daemon.stop(); endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); }
});
