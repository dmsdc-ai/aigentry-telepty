'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBrokerRouting } = require('../src/broker/routing');
test('routing rejects duplicate broadcast targets before any reservation or dispatch', () => {
  let touched = false;
  const route = createBrokerRouting({ config: { nodes: { a: {}, b: {} } }, trust: { keys: new Map([['a-key', { grants: [{ action: 'broker.inject', targets: ['b/worker'] }] }]]) },
    ledger: { read() { touched = true; }, reserve() { touched = true; } },
    dispatch: { plan() { return {}; }, admit() { touched = true; } } });
  assert.throws(() => route({ req: { method: 'POST', url: '/v1/nodes/a/broadcast' },
    body: { idempotency_key: 'synthetic-key-0001', prompt: 'synthetic', targets: [
      { node: 'b', session: 'worker', expected_epoch: 'epoch' }, { node: 'b', session: 'worker', expected_epoch: 'epoch' }] },
    authenticate: () => ({ id: 'a', keyId: 'a-key' }) }), { code: 'BROKER_BROADCAST_INVALID' });
  assert.equal(touched, false);
});

const { createBrokerDispatch } = require('../src/broker/dispatch');
test('shared dispatcher enforces aggregate capacity, source window, and pending budgets', () => {
  let records = [];
  const config = { limits: { a: { max_requests: 3, window_ms: 60000, max_pending: 2 } } };
  const ledger = { all: () => records, active: new Set() };
  const dispatch = createBrokerDispatch({ config, ledger });
  dispatch.admit('a', 3, 2);
  assert.throws(() => dispatch.admit('a', 4, 2), { code: 'BROKER_BUDGET_EXCEEDED' });
  assert.throws(() => dispatch.admit('a', 3, 3), { code: 'BROKER_BACKPRESSURE' });
  records = [{ source_node: 'a', created_at: Date.now(), receipt_id: 'existing' }]; ledger.active.add('existing');
  assert.throws(() => dispatch.admit('a', 3, 1), { code: 'BROKER_BUDGET_EXCEEDED' });
  assert.throws(() => dispatch.admit('a', 1, 2), { code: 'BROKER_BACKPRESSURE' });
  records = Array(511).fill({ source_node: 'other', created_at: 0 });
  assert.throws(() => dispatch.admit('a', 3, 2), { code: 'FORWARD_CAPACITY' });
});
test('broadcast checks the serialized group bound before reserving any record', () => {
  let reserved = false;
  const route = createBrokerRouting({ config: { nodes: { a: {}, b: {} } },
    trust: { keys: new Map([['a', { grants: [{ action: 'broker.inject', targets: Array.from({ length: 8 }, (_, i) => `b/${'s'.repeat(126)}${i}`) }] }]]) },
    ledger: { read: () => null, reserve: () => { reserved = true; } }, dispatch: { admit() {},
      plan(source, target, sid, body, principal, options) { return { key: options.key, target, sid, payload: { expected_epoch: body.expected_epoch } }; } } });
  const body = { prompt: 'synthetic', idempotency_key: 'synthetic-group-key', targets: Array.from({ length: 8 }, (_, i) => ({
    node: 'b', session: `${'s'.repeat(126)}${i}`, expected_epoch: '界'.repeat(128) })) };
  assert.throws(() => route({ req: { method: 'POST', url: '/v1/nodes/a/broadcast' }, body, authenticate: () => ({ id: 'a', keyId: 'a' }) }), { code: 'BROKER_BROADCAST_INVALID' });
  assert.equal(reserved, false);
});
