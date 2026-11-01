'use strict';
const crypto = require('node:crypto');

function parseExternalApprovalPolicy(value) {
  if (value === undefined) return { policy: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'public_key_spki')
      || typeof value.public_key_spki !== 'string' || (!value.public_key_spki.startsWith('-----BEGIN PUBLIC KEY-----') || value.public_key_spki.includes('PRIVATE KEY')) || Buffer.byteLength(value.public_key_spki) > 8192) {
    return { error: 'External approval requires an Ed25519 SPKI public key.' };
  }
  try {
    const key = crypto.createPublicKey(value.public_key_spki);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return { policy: { public_key_spki: key.export({ type: 'spki', format: 'pem' }).toString(), mode: 'signed-inject' } };
  } catch { return { error: 'External approval requires an Ed25519 SPKI public key.' }; }
}

function protectedInputFailure(session) {
  if (require('./principal/cooperative-handoff').activeHandoff(session)) return {success:false,httpStatus:409,code:'HANDOFF_FENCED',bytes_written:0,error:'Cooperative handoff fences terminal writes.'};
  return session?.externalApprovalPolicy ? { success: false, httpStatus: 403,
    code: 'EXTERNAL_APPROVAL_REQUIRED', bytes_written: 0,
    error: 'This protected session requires an external signature through the supported inject ingress.' } : null;
}

function createExternalApprovalVerifier({ now = Date.now, randomBytes = crypto.randomBytes, maxPending = 256 } = {}) {
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 4096) throw new Error('Invalid approval cache bound');
  const daemonChallenge = randomBytes(32).toString('base64url');
  const pending = new Map();
  const binding = session => ({ sid: session.id, epoch: session.sessionEpoch,
    owner_generation: session.interactionOwnerGeneration || null });
  const same = (a, b) => a.sid === b.sid && a.epoch === b.epoch && a.owner_generation === b.owner_generation;
  function challenge(session, request) {
    if (!session?.externalApprovalPolicy || !session.sessionEpoch || !session.id) return { ok: false, code: 'APPROVAL_POLICY_REQUIRED' };
    if (!request || request.operation !== 'inject' || typeof request.no_enter !== 'boolean'
        || typeof request.payload_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.payload_sha256)) {
      return { ok: false, code: 'INVALID_APPROVAL_REQUEST' };
    }
    for (const [nonce, item] of pending) if (item.expires_at <= now()) pending.delete(nonce);
    if (pending.size >= maxPending) return { ok: false, code: 'APPROVAL_CAPACITY' };
    const document = { version: 1, ...binding(session), operation: request.operation,
      no_enter: request.no_enter, payload_sha256: request.payload_sha256,
      nonce: randomBytes(24).toString('base64url'), expires_at: now() + 60000, daemon_challenge: daemonChallenge };
    pending.set(document.nonce, document);
    return { ok: true, approval: { ...document }, write_ingress: 'inject-only' };
  }
  function verifyAndConsume(session, request, approval, signature) {
    const item = approval && pending.get(approval.nonce);
    if (!item) return { ok: false, code: 'APPROVAL_DENIED' };
    if (item.expires_at <= now()) { pending.delete(item.nonce); return { ok: false, code: 'APPROVAL_EXPIRED' }; }
    if (!session?.externalApprovalPolicy || !same(item, binding(session))
        || request?.operation !== item.operation || request?.no_enter !== item.no_enter
        || request?.payload_sha256 !== item.payload_sha256
        || JSON.stringify(approval) !== JSON.stringify(item)
        || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return { ok: false, code: 'APPROVAL_DENIED' };
    try {
      const key = crypto.createPublicKey(session.externalApprovalPolicy.public_key_spki);
      if (key.asymmetricKeyType !== 'ed25519') return { ok: false, code: 'APPROVAL_DENIED' };
      const verified = crypto.verify(null, Buffer.from(JSON.stringify(item)), key, Buffer.from(signature, 'base64url'));
      if (!verified) return { ok: false, code: 'APPROVAL_DENIED' };
      pending.delete(item.nonce);
      return { ok: true, code: 'EXTERNAL_SIGNATURE_VERIFIED', write_ingress: 'inject-only' };
    } catch { return { ok: false, code: 'APPROVAL_DENIED' }; }
  }
  return { challenge, verifyAndConsume };
}
const externalApprovalVerifier = createExternalApprovalVerifier();
module.exports = { parseExternalApprovalPolicy, protectedInputFailure, createExternalApprovalVerifier, externalApprovalVerifier };
