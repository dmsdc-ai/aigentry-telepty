'use strict';
const crypto = require('node:crypto');
const { createAuditWriter } = require('../audit/inject-log');
const { createPrivateAuditStorage } = require('./audit-storage');
const EVENTS = new Set(['request', 'admitted', 'idempotent_retry', 'envelope_forwarded', 'receipt_outcome']);
const CODES = new Set(['PRINCIPAL_REPLAY', 'PRINCIPAL_GRANT_DENIED', 'PRINCIPAL_PROOF_INVALID', 'PRINCIPAL_CLOCK_UNSAFE', 'PRINCIPAL_REPLAY_CAPACITY', 'BROKER_ROUTE_NOT_FOUND', 'BROKER_NODE_DENIED', 'BROKER_STORAGE_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT']);
const STATES = new Set(['pending', 'accepted', 'failed', 'outcome_unknown']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
function bounded(value, fallback, maximum) { return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback; }
// The writer receives only hashes and whitelisted metadata, never request objects, proofs,
// payloads, claimed senders, arbitrary error text or destination-supplied result codes.
function createBrokerAudit({ path, queueMax, flushMs } = {}) {
  const writer = createAuditWriter({ path, queueMax: bounded(queueMax, 10000, 10000), flushMs: bounded(flushMs, 250, 60000), preview: false, storage: createPrivateAuditStorage(path) });
  const counters = { submitted: 0, overflow_dropped: 0, write_errors: 0, append_errors: 0 };
  const increment = key => { counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1); };
  writer.on('audit_overflow', () => increment('overflow_dropped'));
  writer.on('audit_error', () => increment('write_errors'));
  let closed = false, closing;
  return {
    record({ event, principal, payload, requestTarget, receiptId, state, status, code, targetNode, targetSid } = {}) {
      if (closed || !EVENTS.has(event)) return;
      try {
        const text = typeof payload === 'string' ? payload : '';
        writer.append({ ts: new Date().toISOString(), kind: 'broker', source: 'broker-hub', origin: 'untrusted-remote', preview: false,
          broker: { event, target_node: identifier(targetNode),
            target_sid: typeof targetSid === 'string' && Buffer.byteLength(targetSid) <= 128 && targetSid.length > 0 && !/[\x00-\x1f\x7f]/.test(targetSid) ? targetSid : null, node: identifier(principal && principal.id), key: identifier(principal && principal.keyId),
            payload_sha256: digest(text), payload_bytes: Buffer.byteLength(text),
            request_sha256: typeof requestTarget === 'string' ? digest(requestTarget) : null,
            receipt_id: typeof receiptId === 'string' && /^[a-f0-9]{64}$/.test(receiptId) ? receiptId : null,
            state: STATES.has(state) ? state : null,
            code: CODES.has(code) ? code : null,
            status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null } });
        increment('submitted');
      } catch { increment('append_errors'); }
    },
    stats: () => ({ ...counters }),
    close() {
      if (!closing) { closed = true; closing = writer.close().catch(() => increment('write_errors')); }
      return closing;
    }
  };
}
module.exports = { createBrokerAudit };
