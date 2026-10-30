'use strict';
const crypto = require('node:crypto');
const { canonicalJSON, bodyDigest, parseUnambiguousJSON } = require('./encoding');
const SCHEMA = 'telepty.principals/v1';
const DOMAIN = 'telepty.principal-assertion/v1\n';
const HTTP_ACTIONS = Object.freeze(['daemon.inspect', 'session.list', 'session.inspect', 'session.register',
  'session.observe', 'session.events', 'session.bus', 'session.owner', 'session.input_stream', 'session.create', 'session.takeover', 'session.inject', 'session.forwarded_inject', 'session.state', 'session.input', 'session.rename', 'session.destroy', 'mailbox.read', 'mailbox.ack', 'mailbox.renew']);
const VALIDATED = Symbol('validated public principal trust');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const opaque = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x20\x7f]/.test(value);
function configError() { throw Object.assign(new Error('Principal trust configuration is invalid'), { code: 'PRINCIPAL_CONFIG_INVALID' }); }
function exactFields(object, fields) {
  return object && typeof object === 'object' && !Array.isArray(object)
    && [Object.prototype, null].includes(Object.getPrototypeOf(object))
    && Object.keys(object).every(key => fields.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(object, key), 'value'));
}
function validateTrustConfiguration(configuration, { audience, allowedActions = HTTP_ACTIONS } = {}) {
  // Also rejects accessors and oversized/cyclic objects before any property is consumed.
  try { canonicalJSON(configuration); } catch { configError(); }
  if (!exactFields(configuration, ['schema', 'audience', 'keys']) || configuration.schema !== SCHEMA
      || !Array.isArray(configuration.keys) || configuration.keys.length < 1 || configuration.keys.length > 64) configError();
  const trustedAudience = configuration.audience === undefined ? audience : configuration.audience;
  if (!opaque(trustedAudience) || !Array.isArray(allowedActions) || !allowedActions.length
      || allowedActions.some(action => typeof action !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(action))) configError();
  const actions = new Set(allowedActions), keys = new Map(), fingerprints = new Set();
  for (const entry of configuration.keys) {
    if (!exactFields(entry, ['key_id', 'principal_id', 'public_key_spki', 'authority', 'grants'])
        || !identifier(entry.key_id) || !identifier(entry.principal_id) || keys.has(entry.key_id)
        || !['principal', 'operator'].includes(entry.authority === undefined ? 'principal' : entry.authority)
        || typeof entry.public_key_spki !== 'string' || entry.public_key_spki.length > 1024
        || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(entry.public_key_spki)
        || !Array.isArray(entry.grants) || entry.grants.length < 1 || entry.grants.length > 128) configError();
    let publicKey;
    try { publicKey = crypto.createPublicKey({ key: entry.public_key_spki, format: 'pem', type: 'spki' }); } catch { configError(); }
    if (publicKey.asymmetricKeyType !== 'ed25519') configError();
    const fingerprint = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    if (fingerprints.has(fingerprint)) configError();
    fingerprints.add(fingerprint);
    const authority = entry.authority === undefined ? 'principal' : entry.authority;
    const grants = entry.grants.map(grant => {
      if (!exactFields(grant, ['action', 'targets']) || !actions.has(grant.action) || !Array.isArray(grant.targets)
          || grant.targets.length < 1 || grant.targets.length > 128 || grant.targets.some(target => !opaque(target))
          || new Set(grant.targets).size !== grant.targets.length) configError();
      if (grant.targets.includes('*') && !(authority === 'operator'
          && ['session.inspect', 'session.list', 'daemon.inspect'].includes(grant.action))) configError();
      return Object.freeze({ action: grant.action, targets: Object.freeze([...grant.targets]) });
    });
    keys.set(entry.key_id, Object.freeze({ id: entry.principal_id, authority, publicKey, grants: Object.freeze(grants) }));
  }
  return Object.freeze({ [VALIDATED]: true, audience: trustedAudience, keys, actions });
}
function validTarget(target) {
  if (typeof target !== 'string' || target.length > 4096 || !target.startsWith('/') || target.startsWith('//')
      || /[\\#\x00-\x20\x7f]/.test(target)) return false;
  const query = target.includes('?') ? target.slice(target.indexOf('?') + 1) : '';
  const seen = new Set();
  for (const [key] of new URLSearchParams(query)) {
    if (seen.has(key) || ['token', 'access_token', 'authorization', 'owner_token'].includes(key.toLowerCase())) return false;
    seen.add(key);
  }
  return true;
}
function documentValid(document) {
  return exactFields(document, ['v', 'key_id', 'principal_id', 'audience', 'method', 'target', 'action', 'transport',
    'body_sha256', 'challenge', 'nonce', 'issued_at', 'expires_at', 'session_epoch'])
    && document.v === 1 && identifier(document.key_id) && identifier(document.principal_id)
    && opaque(document.audience) && typeof document.method === 'string' && /^[A-Z]{3,16}$/.test(document.method)
    && validTarget(document.target) && typeof document.action === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(document.action)
    && ['http', 'websocket'].includes(document.transport)
    && /^[a-f0-9]{64}$/.test(document.body_sha256 || '') && /^[A-Za-z0-9_-]{16,128}$/.test(document.challenge || '')
    && /^[A-Za-z0-9_-]{16,128}$/.test(document.nonce || '') && Number.isSafeInteger(document.issued_at)
    && Number.isSafeInteger(document.expires_at) && document.issued_at >= 0 && document.expires_at > document.issued_at
    && document.expires_at - document.issued_at <= 60
    && (document.session_epoch === undefined || (typeof document.session_epoch === 'string' && document.session_epoch.length > 0 && document.session_epoch.length <= 128));
}
function createSignedAssertion({ privateKey, keyId, principalId, audience, challenge, method, target, body, action,
  nonce = crypto.randomBytes(24).toString('base64url'), issuedAt = Math.floor(Date.now() / 1000), ttlSeconds = 60,
  sessionEpoch, transport = 'http' }) {
  const document = { v: 1, key_id: keyId, principal_id: principalId, audience, challenge, method, target,
    action, transport, body_sha256: bodyDigest(body), nonce, issued_at: issuedAt, expires_at: issuedAt + ttlSeconds,
    ...(sessionEpoch === undefined ? {} : { session_epoch: sessionEpoch }) };
  if (!documentValid(document)) throw new Error('Invalid principal assertion input');
  const encoded = canonicalJSON(document);
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signer required');
  const signature = crypto.sign(null, Buffer.from(DOMAIN + encoded), key);
  return `v1.${Buffer.from(encoded).toString('base64url')}.${signature.toString('base64url')}`;
}
function createPrincipalVerifier({ trust, challenge = crypto.randomBytes(32).toString('base64url'), now = Date.now, replayCapacity = 4096 }) {
  if (!trust?.[VALIDATED] || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)
      || !Number.isSafeInteger(replayCapacity) || replayCapacity < 1 || replayCapacity > 65536) configError();
  const replay = new Map();
  let latestClock = Math.floor(now() / 1000);
  const deny = (code = 'PRINCIPAL_PROOF_INVALID', status = 401) => ({ ok: false, code, status });
  function check(header, binding, consume) {
      try {
        if (typeof header !== 'string' || header.length > 8192 || !binding || !trust.actions.has(binding.action)) return deny();
        const parts = header.split('.');
        if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{86}$/.test(parts[2])) return deny();
        const payload = Buffer.from(parts[1], 'base64url'), signature = Buffer.from(parts[2], 'base64url');
        if (payload.toString('base64url') !== parts[1] || signature.toString('base64url') !== parts[2] || signature.length !== 64) return deny();
        const document = parseUnambiguousJSON(payload);
        const encoded = canonicalJSON(document);
        if (encoded !== payload.toString('utf8') || !documentValid(document)) return deny();
        const key = trust.keys.get(document.key_id), at = Math.floor(now() / 1000);
        if (!Number.isSafeInteger(at) || at < latestClock) return deny('PRINCIPAL_CLOCK_UNSAFE', 503);
        latestClock = at;
        if (!key || !Number.isSafeInteger(at) || key.id !== document.principal_id || document.audience !== trust.audience
            || document.challenge !== challenge || document.issued_at > at || document.expires_at <= at
            || document.method !== binding.method || document.target !== binding.target || document.action !== binding.action
            || document.transport !== (binding.transport || 'http') || document.body_sha256 !== binding.bodySha256
            || (binding.sessionEpoch !== undefined && document.session_epoch !== binding.sessionEpoch)
            || !crypto.verify(null, Buffer.from(DOMAIN + encoded), key.publicKey, signature)) return deny();
        const grant = key.grants.find(item => item.action === binding.action && (item.targets.includes(binding.grantTarget)
          || (key.authority === 'operator' && item.targets.includes('*'))));
        if (!grant) return deny('PRINCIPAL_GRANT_DENIED', 403);
        for (const [nonce, expires] of replay) if (expires <= at) replay.delete(nonce);
        const nonce = `${document.key_id}:${document.nonce}`;
        if (replay.has(nonce)) return deny('PRINCIPAL_REPLAY', 409);
        if (replay.size >= replayCapacity) return deny('PRINCIPAL_REPLAY_CAPACITY', 503);
        if (consume) replay.set(nonce, document.expires_at);
        return { ok: true, principal: Object.freeze({ id: key.id, keyId: document.key_id, authority: key.authority,
          source: 'ed25519', audience: trust.audience }), action: binding.action, target: binding.grantTarget,
          sessionEpoch: document.session_epoch || null, expiresAt: document.expires_at * 1000 };
      } catch { return deny(); }
  }
  return Object.freeze({ challenge, audience: trust.audience,
    verify: (header, binding) => check(header, binding, true),
    // Preflight for an adapter that will submit the SAME proof to real middleware.
    // It authenticates all bindings/grants/replay checks but never grants an effect.
    inspect: (header, binding) => check(header, binding, false)
  });
}
module.exports = { SCHEMA, HTTP_ACTIONS, validateTrustConfiguration, createPrincipalVerifier, createSignedAssertion, validTarget };
