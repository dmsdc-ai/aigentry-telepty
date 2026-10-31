'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBoundedUdsResponse } = require('../src/mailbox/uds-response');
const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
test('UDS response preserves UTF8 split across chunks and bounds wire bytes', () => {
  const response = createBoundedUdsResponse(8), bytes = Buffer.from('🙂한');
  assert.equal(response.append(bytes.subarray(0, 2)), true); assert.equal(response.append(bytes.subarray(2)), true);
  assert.equal(response.text(), '🙂한'); assert.equal(response.bytes, 7);
  assert.equal(response.append(Buffer.from('ab')), false); assert.throws(() => response.text());
  assert.equal(response.append(Buffer.from('a')), false);
});
test('oversized aterm response destroys socket, cancels timer and reports uncertain delivery', async () => {
  let socket, timerCancelled = 0, writes = 0, destroyed = 0;
  const session = { id: 'fixture', sessionEpoch: 'fixture-epoch', type: 'aterm', delivery: { transport: 'unix_socket', address: '/fixture' } };
  const context = createSessionDeliveryContext({ sessions: { fixture: session }, DELIVERY_TIMEOUT_MS: 10, hasHeldInteraction: () => false,
    interaction: { invalidateInteraction() {} }, buildErrorBody: (code, error, extra) => ({ success: false, code, error, ...extra }),
    markSessionDisconnected() { throw Error('overflow is not measured disconnection'); }, setTimeout: () => 1,
    clearTimeout: () => timerCancelled++, net: { connect(_path, ready) { socket = new EventEmitter(); socket.end = () => writes++; socket.destroy = () => destroyed++; queueMicrotask(ready); return socket; } } });
  const pending = context.writeDataToSession('fixture', session, 'synthetic text');
  await Promise.resolve(); socket.emit('data', Buffer.from('한'.repeat(22000))); socket.emit('end');
  const result = await pending; assert.equal(result.code, 'DELIVERY_RESPONSE_TOO_LARGE'); assert.equal(result.delivery_uncertain, true);
  assert.equal(result.bytes_written, null); assert.equal(destroyed, 1); assert.equal(writes, 1); assert.equal(timerCancelled, 1);
});
test('aterm timeout destroys socket and reports uncertainty without accepting later response', async () => {
  let socket, expire, ready, cancelled = 0, destroyed = 0;
  const session = { id: 'fixture', sessionEpoch: 'fixture-epoch', type: 'aterm', delivery: { transport: 'unix_socket', address: '/fixture' } };
  const context = createSessionDeliveryContext({ sessions: { fixture: session }, DELIVERY_TIMEOUT_MS: 10, hasHeldInteraction: () => false,
    interaction: { invalidateInteraction() {} }, buildErrorBody: (code, error, extra) => ({ success: false, code, error, ...extra }),
    setTimeout: callback => { expire = callback; return 1; }, clearTimeout: () => cancelled++,
    net: { connect(_path, callback) { ready = callback; socket = new EventEmitter(); socket.end = () => {}; socket.destroy = () => destroyed++; return socket; } } });
  const pending = context.writeDataToSession('fixture', session, 'synthetic text');
  ready(); expire(); socket.emit('data', Buffer.from('{"success":true}')); socket.emit('end');
  const result = await pending; assert.equal(result.code, 'TIMEOUT'); assert.equal(result.delivery_uncertain, true);
  assert.equal(destroyed, 1); assert.equal(cancelled, 1);
});
