'use strict';
const crypto = require('node:crypto');
const { canonicalJSON } = require('../principal/encoding');
const { createSignedAssertion } = require('../principal/proof');
const { validateForwardBody } = require('../peer-forwarding');
const { id, error } = require('./http');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function createBrokerDispatch({ config, signingKey, ledger, streams, timers, auditLog, finish, view }) {
  function plan(source, target, sid, body, principal, { key = hash(`broker:${source}:${body.idempotency_key}`), binding, metadata = {} } = {}) {
    if (!id(source) || !id(target) || !own(config.nodes, source) || !own(config.nodes, target)
      || typeof sid !== 'string' || !sid || Buffer.byteLength(sid) > 128 || /[\/\\\x00-\x1f\x7f]/.test(sid)
      || sid === '.' || sid === '..') throw error('BROKER_NODE_DENIED', 403);
    const payload = validateForwardBody(body);
    const limit = config.limits[source];
    if (Buffer.byteLength(payload.prompt) > limit.max_payload_bytes) throw error('BROKER_PAYLOAD_DENIED', 413);
    return { source, target, sid, payload, principal, key, limit,
      fingerprint: hash(canonicalJSON({ source, target, sid, payload, ...(binding ? { binding } : {}) })),
      metadata: { direction: 'broker', source_node: source, target_node: target, session: sid, expected_epoch: payload.expected_epoch, ...metadata } };
  }
  function admit(source, count = 1, pending = count) {
    const limit = config.limits[source], records = ledger.all();
    if (records.length + count > 512) throw error('FORWARD_CAPACITY', 503);
    if (records.filter(record => record.source_node === source && record.created_at >= Date.now() - limit.window_ms).length + count > limit.max_requests) throw error('BROKER_BUDGET_EXCEEDED', 429);
    if (records.filter(record => record.source_node === source && ledger.active.has(record.receipt_id)).length + pending > limit.max_pending) throw error('BROKER_BACKPRESSURE', 429);
  }
  function reserve(operation) { return ledger.reserve(operation.key, operation.fingerprint, operation.metadata); }
  function dispatch(operation, reserved) {
    const { source, target, sid, payload, principal, key, limit } = operation;
    if (!reserved.fresh) {
      auditLog.record({ event: 'idempotent_retry', principal, targetNode: target, targetSid: sid, receiptId: key, state: reserved.record.state });
      return { status: 200, body: view(reserved.record) };
    }
    auditLog.record({ event: 'admitted', principal, targetNode: target, targetSid: sid, payload: payload.prompt, receiptId: key, state: 'pending' });
    const stream = streams.get(target);
    if (!stream || stream.response.destroyed) return { status: 503, body: view(finish(reserved.record, { state: 'failed', code: 'BROKER_NODE_OFFLINE' })) };
    const envelope = { schema: 'telepty.broker-envelope/v1', receipt_id: key, source_node: source,
      target_node: target, session: sid, payload, hop: 1, foreign_session_identity_verified: false,
      ...(operation.metadata.in_reply_to ? { in_reply_to: operation.metadata.in_reply_to } : {}) };
    const proof = createSignedAssertion({ privateKey: signingKey, keyId: config.key_id, principalId: config.principal_id,
      audience: config.nodes[target].audience, challenge: stream.challenge, method: 'EVENT',
      target: `/v1/envelopes/${key}`, body: envelope, action: 'broker.envelope', sessionEpoch: payload.expected_epoch });
    const frame = `data: ${JSON.stringify({ envelope, assertion: proof })}\n\n`;
    if (Buffer.byteLength(frame) > 128 * 1024 || stream.response.writableLength + Buffer.byteLength(frame) > 128 * 1024) {
      return { status: 429, body: view(finish(reserved.record, { state: 'failed', code: 'BROKER_BACKPRESSURE' })) };
    }
    ledger.active.add(key);
    try { stream.response.write(frame); auditLog.record({ event: 'envelope_forwarded', principal, targetNode: target, targetSid: sid, receiptId: key, state: 'pending' }); }
    catch { return { status: 202, body: view(finish(reserved.record, { state: 'outcome_unknown', code: 'BROKER_WRITE_UNKNOWN' })) }; }
    timers.set(key, setTimeout(() => {
      try { const current = ledger.read(key); if (current && current.state === 'pending') finish(current, { state: 'outcome_unknown', code: 'BROKER_RESULT_TIMEOUT' }); }
      catch { ledger.active.delete(key); }
    }, limit.timeout_ms));
    return { status: 202, body: view(reserved.record) };
  }
  function inject(operation) {
    if (!ledger.read(operation.key)) admit(operation.source);
    return dispatch(operation, reserve(operation));
  }
  return { plan, admit, reserve, dispatch, inject };
}
module.exports = { createBrokerDispatch, hash };
