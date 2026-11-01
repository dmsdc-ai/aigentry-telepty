'use strict';
const { canonicalJSON } = require('../principal/encoding');
const { error, id } = require('./http');
const { hash } = require('./dispatch');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const keyValid = key => typeof key === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(key);
function object(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(field => fields.includes(field));
}
function createBrokerRouting({ config, trust, ledger, dispatch, view }) {
  function sourcePrincipal(principal, source) {
    if (principal.id !== source || !own(config.nodes, source)) throw error('BROKER_NODE_DENIED', 403);
  }
  function groupView(group) {
    if (group.direction !== 'broker-broadcast' || !Array.isArray(group.children) || group.children.length < 1 || group.children.length > 8) throw error('BROKER_STORAGE_UNAVAILABLE', 503);
    const children = group.children.map(child => {
      const record = ledger.read(child.receipt_id);
      if (!record) return { ...child, state: 'outcome_unknown', code: 'BROKER_CHILD_INTENT_MISSING', foreign_session_identity_verified: false };
      if (record.source_node !== group.source_node || record.group_receipt_id !== group.receipt_id) throw error('BROKER_STORAGE_UNAVAILABLE', 503);
      return view(record);
    });
    const states = new Set(children.map(child => child.state));
    return { receipt_id: group.receipt_id, source_node: group.source_node,
      state: states.size === 1 ? children[0].state : 'mixed', children, foreign_session_identity_verified: false };
  }
  function originalFor(responder, receipt) {
    const original = ledger.read(receipt);
    if (!original || original.direction !== 'broker' || original.target_node !== responder) throw error('BROKER_REPLY_CONTEXT_NOT_FOUND', 404);
    return original;
  }
  return function route({ req, body, authenticate }) {
    const broadcast = /^\/v1\/nodes\/([A-Za-z0-9._-]+)\/broadcast$/.exec(req.url);
    const groupQuery = /^\/v1\/nodes\/([A-Za-z0-9._-]+)\/broadcast-receipts\/([A-Za-z0-9_-]{16,128})$/.exec(req.url);
    const context = /^\/v1\/nodes\/([A-Za-z0-9._-]+)\/reply-context\/([a-f0-9]{64})$/.exec(req.url);
    const reply = /^\/v1\/nodes\/([A-Za-z0-9._-]+)\/replies\/([a-f0-9]{64})$/.exec(req.url);
    if (req.method === 'POST' && broadcast) {
      const source = broadcast[1], principal = authenticate(body, 'broker.broadcast', source);
      sourcePrincipal(principal, source);
      if (!object(body, ['idempotency_key', 'prompt', 'no_enter', 'targets']) || !keyValid(body.idempotency_key)
        || !Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 8) throw error('BROKER_BROADCAST_INVALID');
      const seen = new Set(), key = hash(`broker-broadcast:${source}:${body.idempotency_key}`);
      // Validate every target and same-key inject grant before creating any intent.
      const plans = body.targets.map((target, index) => {
        if (!object(target, ['node', 'session', 'expected_epoch']) || !id(target.node) || typeof target.session !== 'string') throw error('BROKER_BROADCAST_INVALID');
        const exact = `${target.node}/${target.session}`;
        if (seen.has(exact)) throw error('BROKER_BROADCAST_INVALID'); seen.add(exact);
        const signingKey = trust.keys.get(principal.keyId);
        if (!signingKey || !signingKey.grants.some(grant => grant.action === 'broker.inject' && grant.targets.includes(exact))) throw error('BROKER_BROADCAST_TARGET_DENIED', 403);
        return dispatch.plan(source, target.node, target.session, { prompt: body.prompt, no_enter: body.no_enter,
          expected_epoch: target.expected_epoch, idempotency_key: body.idempotency_key }, principal,
        { key: hash(`broker-broadcast-child:${key}:${index}`), binding: { group: key, index }, metadata: { group_receipt_id: key } });
      });
      const fingerprint = hash(canonicalJSON(body));
      const existing = ledger.read(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw error('IDEMPOTENCY_CONFLICT', 409);
        return { status: 200, body: groupView(existing) };
      }
      dispatch.admit(source, plans.length + 1, plans.length);
      const metadata = { direction: 'broker-broadcast', source_node: source,
        children: plans.map(plan => ({ receipt_id: plan.key, target_node: plan.target, session: plan.sid, expected_epoch: plan.payload.expected_epoch })) };
      if (Buffer.byteLength(JSON.stringify({ receipt_id: key, fingerprint, created_at: Date.now(), state: 'pending', ...metadata })) > 4096) throw error('BROKER_BROADCAST_INVALID');
      const group = ledger.reserve(key, fingerprint, metadata).record;
      // No physical stream writes until every child intent has committed. Any failure
      // leaves a tombstone; replay/query never attempts missing child reservations.
      const children = plans.map(plan => dispatch.reserve(plan));
      for (let index = 0; index < plans.length; index++) dispatch.dispatch(plans[index], children[index]);
      return { status: 202, body: groupView(group) };
    }
    if (req.method === 'GET' && groupQuery) {
      const [, source, key] = groupQuery;
      sourcePrincipal(authenticate(body, 'broker.receipt', source), source);
      const group = ledger.read(hash(`broker-broadcast:${source}:${key}`));
      if (!group || group.source_node !== source) throw error('BROKER_RECEIPT_NOT_FOUND', 404);
      return { status: 200, body: groupView(group) };
    }
    if (req.method === 'GET' && context) {
      const [, responder, receipt] = context;
      sourcePrincipal(authenticate(body, 'broker.reply_context', responder), responder);
      const original = originalFor(responder, receipt);
      return { status: 200, body: { receipt_id: receipt, source_node: original.source_node, target_node: original.target_node,
        session: original.session, expected_epoch: original.expected_epoch, state: view(original).state, foreign_session_identity_verified: false } };
    }
    if (req.method === 'POST' && reply) {
      const [, responder, receipt] = reply;
      if (!object(body, ['target_node', 'return_session', 'expected_epoch', 'idempotency_key', 'prompt', 'no_enter'])
        || !id(body.target_node) || typeof body.return_session !== 'string') throw error('BROKER_REPLY_INVALID');
      const principal = authenticate(body, 'broker.reply', `${body.target_node}/${body.return_session}`, body.expected_epoch);
      sourcePrincipal(principal, responder);
      const original = originalFor(responder, receipt);
      if (body.target_node !== original.source_node) throw error('BROKER_REPLY_TARGET_DENIED', 403);
      const binding = { in_reply_to: receipt, original_fingerprint: original.fingerprint };
      const operation = dispatch.plan(responder, body.target_node, body.return_session, { prompt: body.prompt,
        no_enter: body.no_enter, expected_epoch: body.expected_epoch, idempotency_key: body.idempotency_key }, principal,
      { binding, metadata: { in_reply_to: receipt, original_fingerprint: original.fingerprint } });
      const result = dispatch.inject(operation);
      return result;
    }
    return null;
  };
}
module.exports = { createBrokerRouting };
