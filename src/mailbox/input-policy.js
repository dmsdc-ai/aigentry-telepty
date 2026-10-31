'use strict';

// Task 1215 — recipient input policy. One authority for who may receive input WITHOUT the
// screen-based readiness/modal gates.
//
//   user-supervised  The user personally watches and controls this session (the orchestrator).
//                    Admission = authenticated current owner + live owner transport. No bootstrap
//                    ready gate, no rendered-screen/VT/modal/busy classifier, no glyph/model/case
//                    matching. Receipts, duplicate suppression and quarantine still apply.
//   guarded          Every other session (workers, unknown, unauthenticated). Screen readiness and
//                    interaction/permission-modal checks stay. This is the default.
//
// The policy is never inferred: not from a process or command name, SID text, `--from`, payload,
// a bridge-reported field or an inject frame. It is REQUESTED at authenticated registration
// (requestInputPolicy, from src/routes/session-records.js), held as pending, and BOUND to the
// owner generation minted by the bearer-proved owner claim that follows (bindInputPolicy, from
// src/transport/websocket.js). A later claim — a new owner generation — that was not preceded by
// a fresh trusted registration is guarded. The binding lives in daemon memory only (the persisted
// session schema does not carry it), so a daemon restart is guarded until the owner re-registers.

const crypto = require('node:crypto');

const POLICIES = ['user-supervised', 'guarded'];

function parseInputPolicy(body) {
  if (!body || !Object.hasOwn(body, 'input_policy')) return { present: false };
  const value = body.input_policy;
  if (typeof value !== 'string' || !POLICIES.includes(value)) return { present: true, error: 'input_policy must be user-supervised or guarded' };
  return { present: true, policy: value };
}

// Registration-time authority check. `principal` is the verified strict principal (or null in
// legacy mode); `bearer` is the verified x-telepty-session-token principal (or null); `existing`
// is the record being re-registered (or null for a new one); `credentialed` says the caller holds
// that record's current bearer; `capabilityProved` says it presented this instance's current
// input-policy capability. Returns { ok, code?, source? }.
// `ownerReissue` (task 1215, restore): the route proved the verified persisted owner + current epoch +
// current session credential while no grant exists; it may stand in for capabilityProved only then.
function authorizeInputPolicy({ policy, principal, bearer, sessionId, existing, credentialed, hasCredential, external, sshRemote, wrapped,
  capabilityProved = false, ownerReissue = false }) {
  // Changing a live instance's policy either way (including back to guarded) needs its own
  // current credential, so an uncredentialed caller can neither escalate nor downgrade it.
  if (existing && hasCredential && !credentialed) return { ok: false, code: 'SESSION_CREDENTIAL_REQUIRED' };
  if (policy !== 'user-supervised') return { ok: true, source: 'registration' };
  if (external || sshRemote || !wrapped) return { ok: false, code: 'INPUT_POLICY_UNSUPPORTED' };
  // Strict principal mode: wrapped registration is already operator-only; require it explicitly.
  if (principal && principal.authority !== 'operator') return { ok: false, code: 'INPUT_POLICY_OPERATOR_REQUIRED' };
  // A caller presenting ANOTHER session's bearer is a session process (a worker), never the host.
  if (bearer && bearer.sid !== sessionId) return { ok: false, code: 'INPUT_POLICY_SESSION_BEARER' };
  if (!existing && bearer) return { ok: false, code: 'INPUT_POLICY_SESSION_BEARER' };
  // Task 1215 F1: a session bearer — including this session's OWN bearer, which its bridge exports
  // to the child — is never authority to request supervision. A live instance may re-request it
  // only with the input-policy capability minted to its host launch (bridge memory only).
  if (existing && !capabilityProved && !ownerReissue) return { ok: false, code: 'INPUT_POLICY_CAPABILITY_REQUIRED' };
  // Task 1215 R1: the ONLY authority is the server-verified strict operator principal
  // (verifiedRequestPrincipal: Ed25519 assertion checked by the principal middleware). The legacy host
  // token is shared with every wrapped child (sessionEnv / shared HOME config), so a token match, a
  // missing session header, SID/role text or a client env check never qualifies — new or existing.
  if (!principal || principal.source !== 'ed25519' || principal.authority !== 'operator') return { ok: false, code: 'INPUT_POLICY_OPERATOR_REQUIRED' };
  // A credentialless legacy record has no owner proof for the claim that would bind the policy.
  if (existing && !hasCredential) return { ok: false, code: 'INPUT_POLICY_CREDENTIAL_REQUIRED' };
  return { ok: true, source: 'operator_principal_registration', ...(existing && !capabilityProved && ownerReissue ? { reissue: true } : {}) };
}

// Task 1215 F1 — input-policy capability. Minted only at the 201 of a host registration that was
// granted user-supervised; the daemon keeps a digest bound to the instance (epoch + credential
// generation) and to one grant attempt. Memory only: a WeakMap keyed by the live record object, so
// it is never serialized (sessions.json is whitelisted), never in a view, and a destroyed or
// recreated record has none. A daemon restart therefore drops it and the session is guarded.
const grants = new WeakMap();
const CAPABILITY_HEADER = 'x-telepty-input-policy-capability';
function digest(value) { return crypto.createHash('sha256').update(value, 'utf8').digest(); }
function currentGrant(session) {
  const grant = session && grants.get(session);
  if (!grant) return null;
  if (grant.session_epoch !== (session.sessionEpoch || null)
      || grant.credential_generation !== (Number(session.credentialGeneration) || 1)) { grants.delete(session); return null; }
  return grant;
}
function mintInputPolicyCapability(session) {
  const capability = crypto.randomBytes(32).toString('base64url');
  grants.set(session, { digest: digest(capability), attempt: crypto.randomUUID(), session_epoch: session.sessionEpoch || null,
    credential_generation: Number(session.credentialGeneration) || 1, bound_owner_generation: null });
  return capability;
}
function verifyInputPolicyCapability(session, presented) {
  const grant = currentGrant(session);
  if (!grant || typeof presented !== 'string' || presented.length < 16 || presented.length > 256) return null;
  const candidate = digest(presented);
  return crypto.timingSafeEqual(candidate, grant.digest) ? grant : null;
}
function revokeInputPolicyCapability(session) { if (session) grants.delete(session); }
function hasInputPolicyGrant(session) { return !!currentGrant(session); }

function requestInputPolicy(record, policy, source, now = new Date(), { origin = 'reregistration' } = {}) {
  if (policy === 'user-supervised') {
    const grant = currentGrant(record);
    record.inputPolicyPending = { policy, source, requested_at: now.toISOString(), origin, grant_attempt: grant ? grant.attempt : null };
  } else { delete record.inputPolicyPending; record.inputPolicy = null; revokeInputPolicyCapability(record); }
}

// Called once per owner claim, immediately after the new interactionOwnerGeneration is minted.
// `claim` is what the claimant proved: websocket.js always passes { capability } (the header,
// possibly absent). A pending request binds only when that capability verifies for this instance
// and names the grant attempt that created the pending request; an unproven claim leaves the
// pending request in place for its rightful owner and this generation is guarded. Without a
// `claim` argument (direct non-production callers) only a pending request minted at the 201 of
// this same instance can bind: no child of that instance exists before its first owner claim.
// Returns true when the session moved from supervised to guarded (caller resets readiness).
function bindInputPolicy(session, now = new Date(), claim) {
  const wasSupervised = !!(session.inputPolicy && session.inputPolicy.policy === 'user-supervised');
  const pending = session.inputPolicyPending;
  const grant = currentGrant(session);
  const proved = claim === undefined
    ? !!(pending && pending.origin === 'new_instance')
    : !!(claim && verifyInputPolicyCapability(session, claim.capability));
  const bindable = !!(pending && pending.policy === 'user-supervised' && proved && grant && pending.grant_attempt === grant.attempt
    && typeof session.interactionOwnerGeneration === 'string');
  if (bindable || !pending) delete session.inputPolicyPending;
  session.inputPolicy = bindable
    ? { policy: 'user-supervised', owner_generation: session.interactionOwnerGeneration, source: pending.source, bound_at: now.toISOString() }
    : null;
  if (bindable) grant.bound_owner_generation = session.interactionOwnerGeneration;
  return wasSupervised && !session.inputPolicy;
}

function userSupervised(session) {
  const p = session && session.inputPolicy;
  return !!p && p.policy === 'user-supervised' && session.type === 'wrapped' && !session.sshRemote
    && !session.externalApprovalPolicy && typeof p.owner_generation === 'string'
    && p.owner_generation === session.interactionOwnerGeneration;
}

function effectiveInputPolicy(session) { return userSupervised(session) ? 'user-supervised' : 'guarded'; }

module.exports = { POLICIES, CAPABILITY_HEADER, parseInputPolicy, authorizeInputPolicy, requestInputPolicy, bindInputPolicy, userSupervised, effectiveInputPolicy,
  mintInputPolicyCapability, verifyInputPolicyCapability, revokeInputPolicyCapability, hasInputPolicyGrant };
