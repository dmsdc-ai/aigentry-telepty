'use strict';
const crypto = require('node:crypto');
const { bodyDigest } = require('./encoding');
const { storedOwningPrincipal } = require('./http');
const MAX_PENDING = 8;
const CUSTODY_SCHEMA = 'telepty.pending-handoff-custody/v1';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const audience = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x20\x7f]/.test(value);
const epoch = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
const generation = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const messageId = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128 && !/[\x00-\x1f\x7f]/.test(value);
function messageDigest(message) {
    return bodyDigest(Object.fromEntries(['msg_id', 'from', 'to', 'payload', 'created_at', 'attempt']
        .map(key => [key, message[key] === undefined && key === 'from' ? null : message[key]])));
}
function validConsent(message, session, expectedEpoch, ownerGeneration) {
    try {
        const consent = message.cooperative_handoff;
        const recipient = storedOwningPrincipal(session.owningPrincipal);
        return !!consent && !!recipient && consent.schema === 'telepty.pending-handoff-consent/v1'
            && Object.keys(consent).every(key => ['schema', 'sid', 'origin_epoch', 'origin_owner_generation',
                'recipient', 'sender', 'request_sha256', 'proof_sha256', 'message_sha256', 'inject_id'].includes(key))
            && consent.sid === session.id && consent.sid === message.to && messageId(consent.sid)
            && epoch(consent.origin_epoch) && consent.origin_epoch === expectedEpoch
            && generation(consent.origin_owner_generation) && consent.origin_owner_generation === ownerGeneration
            && consent.recipient?.id === recipient.id && consent.recipient?.audience === recipient.audience
            && Object.keys(consent.recipient).every(key => ['id', 'audience'].includes(key))
            && consent.sender?.source === 'ed25519' && identifier(consent.sender.id) && identifier(consent.sender.key_id)
            && audience(consent.sender.audience)
            && Object.keys(consent.sender).every(key => ['id', 'key_id', 'audience', 'source'].includes(key))
            && hex(consent.request_sha256) && hex(consent.proof_sha256) && hex(consent.message_sha256)
            && consent.message_sha256 === messageDigest(message) && consent.inject_id === null;
    }
    catch {
        return false;
    }
}
function snapshotReceipt(rows) {
    return { pending_custody_schema: CUSTODY_SCHEMA, pending_count: rows.length, pending_digest: bodyDigest(rows),
        pending_records: rows.map(row => ({ id: row.msg_id, digest: bodyDigest(row) })) };
}
function validPendingAudit(value) {
    if (value.pending_policy === undefined) {
        return ['pending_custody_schema', 'pending_count', 'pending_digest', 'pending_records', 'pending_dispatch_started', 'pending_write_invoked']
            .every(key => value[key] === undefined);
    }
    if (value.pending_custody_schema !== CUSTODY_SCHEMA || !['empty', 'never-attempted'].includes(value.pending_policy)
        || !Number.isSafeInteger(value.pending_count) || value.pending_count < 0 || value.pending_count > MAX_PENDING
        || !hex(value.pending_digest) || !Array.isArray(value.pending_records)
        || value.pending_records.length !== value.pending_count
        || new Set(value.pending_records.map(row => row?.id)).size !== value.pending_count
        || !value.pending_records.every(row => row && Object.keys(row).length === 2 && messageId(row.id) && hex(row.digest)))
        return false;
    if (value.pending_policy === 'empty' && (value.pending_count !== 0 || value.pending_digest !== bodyDigest([])))
        return false;
    const invoked = value.pending_write_invoked;
    if (invoked !== undefined && (!Array.isArray(invoked) || new Set(invoked).size !== invoked.length || !invoked.every(id => value.pending_dispatch_started?.includes(id))))
        return false;
    return value.pending_dispatch_started === undefined || (Array.isArray(value.pending_dispatch_started)
        && new Set(value.pending_dispatch_started).size === value.pending_dispatch_started.length
        && value.pending_dispatch_started.every(id => value.pending_records.some(row => row.id === id)));
}
function transferredRecord(session, message) {
    const event = session.cooperativeHandoff;
    if (!eligibleRecipient(session) || !event || event.state !== 'committed' || event.next_epoch !== session.sessionEpoch
        || event.pending_policy !== 'never-attempted' || !validPendingAudit(event)
        || !validConsent(message, session, event.epoch, event.owner_generation))
        return null;
    return event.pending_records.find(row => row.id === message.msg_id && row.digest === bodyDigest(message)) ? event : null;
}
// One connection/child attempt only. A transport receipt measures the bridge's
// child.write invocation, never PTY consumption or application completion.
const deliveries = new WeakMap();
function requestPendingWrite(session, message, { timeoutMs = 3000 } = {}) {
    const ws = session.ownerWs, epoch = session.sessionEpoch, owner = session.interactionOwnerGeneration;
    const event = transferredRecord(session, message);
    if (!event || !ws || ws.readyState !== 1)
        return Promise.resolve({ success: false, delivery_uncertain: true, bytes_written: null, code: 'HANDOFF_OWNER_UNAVAILABLE' });
    const request = { type: 'pending_handoff', request_id: crypto.randomUUID(), session_id: session.id,
        session_epoch: epoch, owner_generation: owner, intent_id: event.id, msg_id: message.msg_id,
        content_digest: bodyDigest(message), payload_sha256: crypto.createHash('sha256').update(message.payload, 'utf8').digest('hex'), data: message.payload, deadline: Date.now() + timeoutMs };
    return new Promise(resolve => {
        const attempts = deliveries.get(session) || new Map();
        deliveries.set(session, attempts);
        const finish = result => { if (!attempts.delete(request.request_id))
            return; clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => finish({ success: false, delivery_uncertain: true, bytes_written: null, code: 'HANDOFF_WRITE_UNKNOWN' }), timeoutMs);
        attempts.set(request.request_id, { request, ws, epoch, owner, finish });
        try {
            ws.send(JSON.stringify(request), error => { if (error)
                finish({ success: false, delivery_uncertain: true, bytes_written: null, code: 'HANDOFF_WRITE_UNKNOWN' }); });
        }
        catch {
            finish({ success: false, delivery_uncertain: true, bytes_written: null, code: 'HANDOFF_WRITE_UNKNOWN' });
        }
    });
}
function acceptPendingReceipt(id, session, ws, message) {
    if (!message || message.type !== 'pending_handoff_receipt')
        return false;
    const attempt = deliveries.get(session)?.get(message.request_id);
    if (!attempt || attempt.ws !== ws || session.ownerWs !== ws || session.sessionEpoch !== attempt.epoch
        || session.interactionOwnerGeneration !== attempt.owner || message.session_id !== id
        || ['session_epoch', 'owner_generation', 'intent_id', 'msg_id', 'content_digest', 'payload_sha256'].some(key => message[key] !== attempt.request[key]))
        return false;
    if (Date.now() >= attempt.request.deadline) {
        attempt.finish({ success: false, delivery_uncertain: true, bytes_written: null, code: 'HANDOFF_WRITE_UNKNOWN' });
        return false;
    }
    if (message.stage === 'child_write_invoked' && message.bytes_written === null && message.submitted_bytes === Buffer.byteLength(attempt.request.data)) {
        attempt.finish({ success: true, bytes_written: null, submitted_bytes: message.submitted_bytes, measurement: 'bridge_child_write_invoked', consumption: 'unknown', reply: 'unknown' });
    }
    else
        attempt.finish({ success: false, delivery_uncertain: true, bytes_written: null, code: 'HANDOFF_WRITE_UNKNOWN' });
    return true;
}
function createPendingWriter({ binding, canWrite, write, now = Date.now }) {
    const receipts = new Map();
    return frame => {
        frame = frame || {};
        const result = { type: 'pending_handoff_receipt', request_id: frame.request_id, session_id: frame.session_id,
            session_epoch: frame.session_epoch, owner_generation: frame.owner_generation, intent_id: frame.intent_id,
            msg_id: frame.msg_id, content_digest: frame.content_digest, payload_sha256: frame.payload_sha256,
            stage: 'refused', bytes_written: 0, submitted_bytes: 0,
            measurement: 'child_write_invocation', consumption: 'unknown', reply: 'unknown' };
        const current = binding();
        const original = current ? Object.fromEntries(['sid', 'session_epoch', 'owner_generation', 'input_generation',
            'geometry_generation', 'child_identity'].map(key => [key, current[key]])) : null;
        if (frame.type !== 'pending_handoff' || !current || frame.session_id !== current.sid || frame.session_epoch !== current.session_epoch
            || frame.owner_generation !== current.owner_generation || !generation(frame.request_id) || !generation(frame.intent_id)
            || !messageId(frame.msg_id) || !hex(frame.content_digest) || !hex(frame.payload_sha256) || typeof frame.data !== 'string'
            || !frame.data.length || Buffer.from(frame.data, 'utf8').toString('utf8') !== frame.data || Buffer.byteLength(frame.data) > 4096 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(frame.data)
            || crypto.createHash('sha256').update(frame.data, 'utf8').digest('hex') !== frame.payload_sha256
            || !Number.isSafeInteger(frame.deadline) || frame.deadline <= now() || frame.deadline > now() + 5000)
            return result;
        const fingerprint = bodyDigest(frame);
        const prior = receipts.get(frame.msg_id);
        if (prior)
            return prior.fingerprint === fingerprint ? prior.result : result;
        if (receipts.size >= MAX_PENDING)
            return result;
        const permitted = canWrite();
        const finalBinding = binding();
        if (!permitted || now() >= frame.deadline || !finalBinding
            || Object.keys(original).some(key => finalBinding[key] !== original[key])) {
            receipts.set(frame.msg_id, { fingerprint, result });
            return result;
        }
        result.stage = 'outcome_unknown';
        result.bytes_written = null;
        result.submitted_bytes = null;
        receipts.set(frame.msg_id, { fingerprint, result });
        try {
            write(frame.data);
            result.stage = 'child_write_invoked';
            result.submitted_bytes = Buffer.byteLength(frame.data);
        }
        catch { /* Partial writes and buffered stream errors never authorize another attempt. */ }
        return result;
    };
}
function eligibleRecipient(session) {
    return session?.type === 'wrapped' && session.cooperativeHandoffCapable === true
        && !session.sshRemote && !session.externalApprovalPolicy && session.provenanceCapable !== true;
}
function pendingNamespaceReserved(session, mailboxSource) {
    const event = session?.cooperativeHandoff;
    if (event?.state !== 'committed' || !(event.pending_count > 0))
        return false;
    if (!validPendingAudit(event) || !event.pending_records.every(row => event.pending_write_invoked?.includes(row.id)))
        return true;
    try {
        const mailbox = typeof mailboxSource === 'function' ? mailboxSource() : mailboxSource;
        return mailbox?.withAcknowledgedCustody(session.id, event, () => true) !== true;
    }
    catch {
        return true;
    }
}
module.exports = { MAX_PENDING, messageDigest, validConsent, snapshotReceipt, validPendingAudit, transferredRecord,
    requestPendingWrite, acceptPendingReceipt, createPendingWriter, eligibleRecipient, pendingNamespaceReserved };
