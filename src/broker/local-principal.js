'use strict';
const crypto = require('node:crypto');
const { createSignedAssertion } = require('../principal/proof');
const { readAuthorityFile } = require('../principal/authority-file');
const { id, origin, error, readResponse, combineAbortSignals } = require('./http');
const FIELDS = ['principal_id', 'key_id', 'audience', 'private_key_path'];
function validateLocalPrincipal(value, programmatic = false) {
  const fields = programmatic ? ['principal_id', 'key_id', 'audience', 'privateKey'] : FIELDS;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
      || !id(value.principal_id) || !id(value.key_id) || typeof value.audience !== 'string'
      || !value.audience || Buffer.byteLength(value.audience) > 256 || /[\x00-\x20\x7f]/.test(value.audience)
      || (!programmatic && typeof value.private_key_path !== 'string')) throw error('BROKER_LOCAL_PRINCIPAL_INVALID');
  return value;
}
function loadLocalPrincipal(configuration) {
  const checked = validateLocalPrincipal(configuration);
  let privateKey;
  try { privateKey = crypto.createPrivateKey(readAuthorityFile(checked.private_key_path, { maximum: 16 * 1024, privateFile: true })); }
  catch { throw error('BROKER_LOCAL_KEY_UNAVAILABLE'); }
  return validateProgrammaticPrincipal({ principal_id: checked.principal_id, key_id: checked.key_id, audience: checked.audience, privateKey });
}
function validateProgrammaticPrincipal(value) {
  validateLocalPrincipal(value, true);
  if (!(value.privateKey instanceof crypto.KeyObject) || value.privateKey.type !== 'private' || value.privateKey.asymmetricKeyType !== 'ed25519') throw error('BROKER_LOCAL_KEY_INVALID');
  return Object.freeze({ ...value });
}
function createLocalPrincipalRequest({ localDaemonUrl, principal, timeoutMs, fetch: send = globalThis.fetch }) {
  const local = origin(localDaemonUrl, true);
  const signer = validateProgrammaticPrincipal(principal);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw error('BROKER_CONFIG_INVALID');
  return async (sid, body, signal) => {
    const target = `/api/forwarded/sessions/${encodeURIComponent(sid)}/inject`;
    const deadline = combineAbortSignals([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    let response;
    try { response = await send(`${local}/api/auth/challenge`, { redirect: 'error', signal: deadline }); }
    catch { throw error('BROKER_LOCAL_CHALLENGE_UNAVAILABLE'); }
    if (!response.ok) throw error('BROKER_LOCAL_CHALLENGE_REFUSED', response.status);
    let challenge;
    try { challenge = await readResponse(response, 4096); } catch { throw error('BROKER_LOCAL_CHALLENGE_INVALID'); }
    if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge) || challenge.schema !== 'telepty.principal-challenge/v1' || challenge.audience !== signer.audience
        || typeof challenge.challenge !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge.challenge)
        || challenge.max_lifetime_seconds !== 60 || challenge.transport !== 'http'
        || challenge.identity_source !== 'configured-ed25519-key') throw error('BROKER_LOCAL_CHALLENGE_INVALID');
    if (body.exact_target !== true || typeof body.expected_epoch !== 'string' || !body.expected_epoch) throw error('BROKER_LOCAL_BODY_INVALID');
    const assertion = createSignedAssertion({ privateKey: signer.privateKey, keyId: signer.key_id, principalId: signer.principal_id,
      audience: signer.audience, challenge: challenge.challenge, method: 'POST', target, body,
      action: 'session.forwarded_inject', sessionEpoch: body.expected_epoch });
    return send(local + target, { method: 'POST', redirect: 'error', signal: deadline,
      headers: { 'content-type': 'application/json', 'x-telepty-principal': assertion }, body: JSON.stringify(body) });
  };
}
module.exports = { loadLocalPrincipal, validateProgrammaticPrincipal, createLocalPrincipalRequest };
