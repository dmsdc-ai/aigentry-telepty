'use strict';
const { parseUnambiguousJSON, requestBodyDigest } = require('./encoding');
const { validateTrustConfiguration, createPrincipalVerifier, validTarget } = require('./proof');
const VERIFIED_REQUEST = Symbol('verified HTTP principal');
const { readAuthorityFile } = require('./authority-file');
function unavailable() { throw Object.assign(new Error('Principal trust is unavailable or unsafe'), { code: 'PRINCIPAL_TRUST_UNAVAILABLE' }); }
function loadPrincipalTrust(filePath, { audience, platform = process.platform } = {}) {
  try { return validateTrustConfiguration(parseUnambiguousJSON(readAuthorityFile(filePath, { platform })), { audience }); }
  catch { unavailable(); }
}
const RESERVED_SESSION_PATHS = new Set(['register', 'spawn', 'broadcast', 'multicast', 'submit-all', 'clean']);
function sessionId(value) {
  return typeof value === 'string' && !RESERVED_SESSION_PATHS.has(value.toLowerCase()) && value.length > 0 && Buffer.byteLength(value) <= 128
    && !/[\/\\\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..';
}
function ownSession(sessions, id) {
  const descriptor = Object.getOwnPropertyDescriptor(sessions, id);
  return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value && typeof descriptor.value === 'object' ? descriptor.value : null;
}
function resolveAction(req) {
  const target = req.originalUrl || req.url;
  if (!validTarget(target)) return null;
  const pathname = target.split('?')[0], method = req.method;
  if (method === 'GET' && pathname === '/api/meta') return { action: 'daemon.inspect', target: 'daemon' };
  if (method === 'GET' && pathname === '/api/sessions') return { action: 'session.list', target: '*', operatorOnly: true };
  if (method === 'POST' && ['/api/sessions/register', '/api/sessions/spawn'].includes(pathname)) {
    const id = req.body && Object.getOwnPropertyDescriptor(req.body, 'session_id');
    if (!id || !Object.hasOwn(id, 'value') || !sessionId(id.value)) return null;
    return { action: pathname.endsWith('/register') ? 'session.register' : 'session.create', target: id.value, creation: true,
      operatorOnly: pathname.endsWith('/spawn') };
  }
  const match = /^\/api\/sessions\/([^/]+)(?:\/(diagnostics|handshake|screen|inject|state|submit|kill|takeover|mailbox(?:\/ack)?|lease))?$/.exec(pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return null; }
  if (!sessionId(id)) return null;
  const suffix = match[2];
  if (method === 'GET' && [undefined, 'diagnostics', 'handshake', 'screen'].includes(suffix)) return { action: 'session.inspect', target: id, readOnly: true };
  if (method === 'GET' && suffix === 'mailbox') return { action: 'mailbox.read', target: id, readOnly: true };
  if (method === 'POST' && suffix === 'takeover') return { action: 'session.takeover', target: id, epochRequired: true };
  if (method === 'POST' && suffix === 'inject') return { action: 'session.inject', target: id, explicitInject: true };
  if (method === 'POST' && suffix === 'state') return { action: 'session.state', target: id, epochRequired: true };
  if (method === 'POST' && suffix === 'submit') return { action: 'session.input', target: id, epochRequired: true };
  if (method === 'POST' && suffix === 'mailbox/ack') return { action: 'mailbox.ack', target: id, epochRequired: true };
  if (method === 'POST' && suffix === 'lease') return { action: 'mailbox.renew', target: id, epochRequired: true };
  if ((method === 'DELETE' && suffix === undefined) || (method === 'POST' && suffix === 'kill')) return { action: 'session.destroy', target: id, epochRequired: true };
  if (method === 'PATCH' && suffix === undefined) return { action: 'session.rename', target: id, epochRequired: true };
  return null;
}
function storedOwningPrincipal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.source !== 'ed25519'
      || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)
      || typeof value.audience !== 'string' || !value.audience || Buffer.byteLength(value.audience) > 256) return null;
  return Object.freeze({ id: value.id, source: 'ed25519', audience: value.audience });
}
function verifiedRequestPrincipal(req, { action, target } = {}) {
  if (!req || !Object.hasOwn(req, VERIFIED_REQUEST) || !Object.hasOwn(req, 'authenticationPrincipal')) return null;
  const context = req[VERIFIED_REQUEST];
  if (!context || context.principal !== req.authenticationPrincipal || context.method !== req.method
      || context.requestTarget !== (req.originalUrl || req.url)
      || (action !== undefined && context.action !== action) || (target !== undefined && context.target !== target)) return null;
  try { if (requestBodyDigest(req) !== context.bodySha256) return null; } catch { return null; }
  return context.principal;
}
function verifiedOwningPrincipal(req) {
  return storedOwningPrincipal(verifiedRequestPrincipal(req));
}

function createPrincipalAuthentication({ trust, sessions, now, replayCapacity, challenge } = {}) {
  if (!sessions || !['object', 'function'].includes(typeof sessions)) unavailable();
  const verifier = createPrincipalVerifier({ trust, now, replayCapacity, challenge });
  const denied = (code, status = 403) => ({ ok: false, code, status });
  return Object.freeze({ verifier,
    challengeDocument: () => ({ schema: 'telepty.principal-challenge/v1', audience: verifier.audience,
      challenge: verifier.challenge, max_lifetime_seconds: 60, transport: 'http', identity_source: 'configured-ed25519-key' }),
    authorize(req) {
      delete req.authenticationPrincipal; delete req[VERIFIED_REQUEST];
      let digest;
      try { digest = requestBodyDigest(req); } catch { return denied('PRINCIPAL_ENCODING_INVALID', 400); }
      const action = resolveAction(req);
      if (!action) return denied('PRINCIPAL_ACTION_DENIED');
      const count = (req.rawHeaders || []).filter((name, index) => index % 2 === 0 && String(name).toLowerCase() === 'x-telepty-principal').length;
      if (count > 1) return denied('PRINCIPAL_HEADER_INVALID', 400);
      const store = typeof sessions === 'function' ? sessions() : sessions;
      const session = ['daemon.inspect', 'session.list'].includes(action.action) ? null : ownSession(store, action.target);
      const epochRequired = action.epochRequired || (action.creation && !!session);
      if (epochRequired && typeof session?.sessionEpoch !== 'string') return denied('PRINCIPAL_SESSION_IDENTITY_UNAVAILABLE');
      const result = verifier.verify(req.headers?.['x-telepty-principal'], { method: req.method,
        target: req.originalUrl || req.url, bodySha256: digest, action: action.action,
        grantTarget: action.target, transport: 'http', ...(epochRequired ? { sessionEpoch: session.sessionEpoch } : {}) });
      if (!result.ok) return result;
      const principal = result.principal, owner = storedOwningPrincipal(session?.owningPrincipal);
      const owns = owner && owner.id === principal.id && owner.audience === principal.audience;
      const operatorOnly = action.operatorOnly || (action.action === 'session.register'
        && (session ? session.type !== 'mailbox' : req.body.delivery_type !== 'mailbox'));
      if (operatorOnly && principal.authority !== 'operator') return denied('PRINCIPAL_OPERATOR_REQUIRED');
      if (session && !action.explicitInject) {
        if (!owns && !(action.readOnly && principal.authority === 'operator')) return denied('PRINCIPAL_SESSION_OWNER_REQUIRED');
      } else if (!session && !action.creation && !['daemon.inspect', 'session.list'].includes(action.action)) {
        return denied('PRINCIPAL_SESSION_NOT_FOUND', 404);
      }
      if (session?.isClosing && !action.readOnly) return denied('SESSION_CLOSING', 409);
      if (result.sessionEpoch && session && result.sessionEpoch !== session.sessionEpoch) return denied('PRINCIPAL_SESSION_EPOCH_MISMATCH', 409);
      if (action.action === 'session.rename') {
        const next = req.body?.new_id;
        const key = trust.keys.get(principal.keyId);
        if (!sessionId(next) || !key.grants.some(grant => grant.action === 'session.rename' && grant.targets.includes(next))) return denied('PRINCIPAL_GRANT_DENIED');
      }
      req.authenticationPrincipal = principal;
      req[VERIFIED_REQUEST] = Object.freeze({ principal, action: result.action, target: result.target,
        method: req.method, requestTarget: req.originalUrl || req.url, bodySha256: digest });
      return result;
    }
  });
}
function createPrincipalAuthenticationFromEnvironment({ env = process.env, machineId, sessions, platform = process.platform } = {}) {
  const mode = env.TELEPTY_PRINCIPAL_MODE;
  if (mode === undefined || mode === '' || mode === 'legacy') return null;
  if (mode !== 'strict') unavailable();
  const trust = loadPrincipalTrust(env.TELEPTY_PRINCIPAL_TRUST_FILE, { audience: machineId, platform });
  const replayCapacity = env.TELEPTY_PRINCIPAL_REPLAY_CAPACITY === undefined ? 4096 : Number(env.TELEPTY_PRINCIPAL_REPLAY_CAPACITY);
  return createPrincipalAuthentication({ trust, sessions, replayCapacity });
}
module.exports = { loadPrincipalTrust, createPrincipalAuthentication, createPrincipalAuthenticationFromEnvironment,
  verifiedOwningPrincipal, verifiedRequestPrincipal, storedOwningPrincipal, resolveAction };
