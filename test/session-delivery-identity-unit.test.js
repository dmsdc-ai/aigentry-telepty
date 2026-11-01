'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');

function fixture() {
  const frames = [];
  const session = { id: 'target', type: 'wrapped', sessionEpoch: 'original',
    ownerWs: { send: raw => frames.push(JSON.parse(raw).data) } };
  const sessions = { target: session };
  let releaseModal;
  const modal = new Promise(resolve => { releaseModal = resolve; });
  let message;
  const mailbox = { enqueue: msg => { message = msg; return {}; }, withdraw: () => true };
  let context;
  const dependencies = {
    sessions, crypto: require('node:crypto'), DELIVERY_TIMEOUT_MS: 100,
    hasHeldInteraction: () => false, interaction: { invalidateInteraction() {} },
    isOpenWebSocket: ws => !!ws, armUpstreamProbe() {},
    shouldQueueBootstrapOperation: () => false, getInjectFailure: () => null,
    resolveModalGate: () => modal, modalRemedy: () => 'reject',
    hasBootstrapBacklog: () => false, applyProvenance: payload => ({ payload }),
    maybeBracketedPaste: payload => payload, emitInjectFailureEvent() {},
    getMailbox: () => mailbox,
    getMailboxDelivery: () => ({ tick: async () => {} }),
  };
  context = createSessionDeliveryContext(dependencies);
  return { session, sessions, frames, context, releaseModal, get message() { return message; } };
}

for (const churn of ['destroy', 'replace', 'epoch', 'owner']) {
  test(`modal wait rejects ${churn} before text enqueue`, async () => {
    const f = fixture();
    const result = f.context.deliverInjectionToSession('target', f.session, 'old text', { noEnter: true });
    if (churn === 'destroy') delete f.sessions.target;
    if (churn === 'replace') f.sessions.target = { ...f.session };
    if (churn === 'epoch') f.session.sessionEpoch = 'replacement';
    if (churn === 'owner') f.session.ownerWs = { send() { throw new Error('replacement got text'); } };
    f.releaseModal({ action: 'park', reason: 'modal' });
    assert.equal((await result).code, 'SESSION_GONE');
    assert.equal(f.message, undefined);
    assert.deepEqual(f.frames, []);
  });
}

test('mailbox delivery rejects text after session replacement even without Enter', async () => {
  const f = fixture();
  f.releaseModal(null);
  assert.equal((await f.context.deliverInjectionToSession('target', f.session, 'old text', { noEnter: true })).success, true);
  f.sessions.target = { ...f.session, ownerWs: { send() { throw new Error('replacement got text'); } } };
  const result = await f.context.mailboxDeliveryOptions.deliverFn('target', f.message);
  assert.equal(result.code, 'SESSION_GONE');
  assert.deepEqual(f.frames, []);
});
