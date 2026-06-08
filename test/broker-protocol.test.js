'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAck,
  buildInjectEnvelope,
  buildSseInjectFrame,
  createMessageIdDeduper,
  createSseSequencer,
  parseInjectEnvelope,
  parseLastEventId,
  parseSseFrame,
} = require('../src/transport/broker-protocol');

test('inject envelope build and parse round-trip', () => {
  const envelope = buildInjectEnvelope({
    message_id: 'msg-1',
    inject_id: 'inject-1',
    to_node: 'nodeB',
    to_session: 'aigentry-devkit-001',
    from_node: 'nodeA',
    payload: {
      prompt: 'hello',
      from: 'telepty-42-w1',
      reply_to: 'orchestrator',
      no_enter: false,
    },
  });

  assert.deepEqual(envelope, {
    type: 'inject',
    message_id: 'msg-1',
    inject_id: 'inject-1',
    target: 'aigentry-devkit-001@nodeB',
    to_node: 'nodeB',
    to_session: 'aigentry-devkit-001',
    from_node: 'nodeA',
    source_host: 'nodeA',
    payload: {
      prompt: 'hello',
      from: 'telepty-42-w1',
      reply_to: 'orchestrator',
      no_enter: false,
    },
  });
  assert.deepEqual(parseInjectEnvelope(JSON.stringify(envelope)), envelope);
});

test('message_id deduper drops duplicates and evicts oldest entries when bounded', () => {
  const deduper = createMessageIdDeduper({ maxSize: 3, trimSize: 1 });

  assert.equal(deduper.accept('msg-1'), true);
  assert.equal(deduper.accept({ message_id: 'msg-1' }), false);
  assert.equal(deduper.accept('msg-2'), true);
  assert.equal(deduper.accept('msg-3'), true);
  assert.equal(deduper.accept('msg-4'), true);

  assert.equal(deduper.has('msg-1'), false);
  assert.equal(deduper.has('msg-2'), true);
  assert.equal(deduper.size, 3);
});

test('SSE sequence helper is monotonic and parses Last-Event-ID', () => {
  const seq = createSseSequencer({ initial: 7 });

  assert.equal(seq.next(), 8);
  assert.equal(seq.next(), 9);
  assert.equal(seq.current, 9);
  assert.equal(parseLastEventId('9'), 9);
  assert.equal(parseLastEventId(''), null);
});

test('SSE inject frame build and parse round-trip', () => {
  const envelope = buildInjectEnvelope({
    message_id: 'msg-1',
    inject_id: 'inject-1',
    target: 'explicit-target@nodeB',
    to_node: 'nodeB',
    to_session: 'explicit-target',
    from_node: 'nodeA',
    source_host: 'nodeA',
    payload: { prompt: 'hello', from: 'sid', reply_to: 'reply', no_enter: true },
  });
  const frame = buildSseInjectFrame(12, envelope);

  assert.equal(frame, `id: 12\nevent: inject\ndata: ${JSON.stringify(envelope)}\n\n`);
  assert.deepEqual(parseSseFrame(frame), {
    id: '12',
    event: 'inject',
    data: envelope,
  });
});

test('ack helper returns the broker ack shape', () => {
  assert.deepEqual(buildAck({ inject_id: 'inject-1', success: true }), {
    type: 'ack',
    inject_id: 'inject-1',
    success: true,
    code: null,
    error: null,
  });
});
