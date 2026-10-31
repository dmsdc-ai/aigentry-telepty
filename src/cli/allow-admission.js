'use strict';
// Task 1215 service41 — the ONE admission of `telepty allow` (cli.js), shared by the real allow and by the local,
// non-mutating `telepty allow-check --input-policy user-supervised`.
//
// The body is cli.js's former inline admission, moved unchanged in order and refusal text: strict principal client,
// cooperative handoff credential, cooperative-without-strict, then the combined-mode supervision client (strict
// conflict, policy pairing, the checked loader, local origin, not SSH). The only edits are that each refusal is
// RETURNED (with a code) instead of printed, and that the environment is a parameter (production passes process.env,
// so the handoff assignments stay exactly as process-local as before).
//
// What it does: local, private-file reads through the existing loaders (src/principal/client.js →
// readAuthorityFile + loadLocalPrincipal: key into memory) and closure construction. What it never does: a network
// request (createPrincipalClient fetches only inside assertion()), a daemon start, a registration, a listener, a file or
// config write, or a trust grant. Private-file, schema and key rules live in those loaders — none are re-implemented.

const REFUSALS = Object.freeze({
  ALLOW_PRINCIPAL_CLIENT_INVALID: 'Strict allow requires a checked principal client configuration for this local daemon and a local child.',
  ALLOW_HANDOFF_CREDENTIAL_INVALID: 'Invalid or unsafe cooperative handoff credential file.',
  ALLOW_COOPERATIVE_REQUIRES_STRICT: 'Cooperative handoff requires an explicit strict principal client.',
  SUPERVISION_STRICT_CONFLICT: 'TELEPTY_SUPERVISION_CLIENT_FILE cannot be combined with TELEPTY_PRINCIPAL_CLIENT_FILE (strict mode signs every request itself). Nothing was started.',
  SUPERVISION_POLICY_MISMATCH: 'TELEPTY_SUPERVISION_CLIENT_FILE is used only with --input-policy user-supervised. Nothing was started.',
  SUPERVISION_CLIENT_INVALID: 'Supervision requires a checked operator client configuration (TELEPTY_SUPERVISION_CLIENT_FILE) for this local daemon and a local child. Nothing was started.',
});

function refuse(code) {
  return { ok: false, code, message: REFUSALS[code] };
}

// invocation: parseAllowInvocation()'s result (sessionId, inputPolicy). daemonUrl: the CLI's DAEMON_URL.
// → { ok: true, strictOwnerClient, strictOwnerEpoch, handoffAdoption, supervisionClient } | { ok: false, code, message }
function admitAllowInvocation(invocation, { env = process.env, daemonUrl, sshPlan = null } = {}) {
  const { sessionId, inputPolicy: requestedInputPolicy = null } = invocation;
  let strictOwnerClient = null;
  let strictOwnerEpoch = null;
  let handoffAdoption = null;
  const cooperativeEnabled = env.TELEPTY_COOPERATIVE_HANDOFF === '1';
  if (env.TELEPTY_PRINCIPAL_CLIENT_FILE) {
    try {
      const principalClient = require('../principal/client');
      strictOwnerClient = principalClient.createPrincipalClient(principalClient.loadPrincipalClientConfiguration(env.TELEPTY_PRINCIPAL_CLIENT_FILE));
      if (strictOwnerClient.daemonUrl !== new URL(daemonUrl).origin || sshPlan) throw new Error('PRINCIPAL_ALLOW_TARGET_UNSUPPORTED');
    } catch {
      return refuse('ALLOW_PRINCIPAL_CLIENT_INVALID');
    }
  }
  if(env.TELEPTY_HANDOFF_CREDENTIAL_FILE){
    try{
      if(!strictOwnerClient || !cooperativeEnabled)throw new Error();
      const proof=require('../principal/encoding').parseUnambiguousJSON(require('../principal/authority-file').readAuthorityFile(env.TELEPTY_HANDOFF_CREDENTIAL_FILE,{privateFile:true,maximum:8192}));
      if(!proof || proof.schema!=='telepty.handoff-credential/v1' || Object.keys(proof).some(k=>!['schema','session_id','origin','session_epoch','session_token','session_nonce','credential_generation'].includes(k))
        || proof.session_id!==sessionId || proof.origin!==strictOwnerClient.daemonUrl || !/^[A-Za-z0-9_-]{22}$/.test(proof.session_epoch||'')
        || typeof proof.session_token!=='string' || !proof.session_token.startsWith(proof.session_epoch+'.') || proof.session_token.length>256
        || !Number.isSafeInteger(proof.credential_generation) || proof.credential_generation<2 || !/^[A-Za-z0-9_-]{24}$/.test(proof.session_nonce||''))throw new Error();
      handoffAdoption={expected_epoch:proof.session_epoch,expected_credential_generation:proof.credential_generation};
      strictOwnerEpoch=proof.session_epoch;env.TELEPTY_SESSION_TOKEN=proof.session_token;env.TELEPTY_SESSION_ORIGIN=proof.origin;env.TELEPTY_SESSION_NONCE=proof.session_nonce;
    }catch{return refuse('ALLOW_HANDOFF_CREDENTIAL_INVALID');}
  }
  if(cooperativeEnabled && !strictOwnerClient){return refuse('ALLOW_COOPERATIVE_REQUIRES_STRICT');}
  // Task 1215 combined mode: ordinary transport credentials stay in force; a SEPARATE operator client
  // (TELEPTY_SUPERVISION_CLIENT_FILE) signs only the user-supervised registration. It never selects
  // strict owner transport or cooperative handoff; conflicting or unused configuration is refused.
  let supervisionClient = null;
  if (env.TELEPTY_SUPERVISION_CLIENT_FILE) {
    if (strictOwnerClient) {
      return refuse('SUPERVISION_STRICT_CONFLICT');
    }
    if (requestedInputPolicy !== 'user-supervised') {
      return refuse('SUPERVISION_POLICY_MISMATCH');
    }
    try {
      const principalClient = require('../principal/client');
      supervisionClient = principalClient.createPrincipalClient(principalClient.loadPrincipalClientConfiguration(env.TELEPTY_SUPERVISION_CLIENT_FILE));
      if (supervisionClient.daemonUrl !== new URL(daemonUrl).origin || sshPlan) throw new Error('SUPERVISION_TARGET_UNSUPPORTED');
    } catch {
      return refuse('SUPERVISION_CLIENT_INVALID');
    }
  }
  return { ok: true, strictOwnerClient, strictOwnerEpoch, handoffAdoption, supervisionClient };
}

// `telepty allow-check` result line. Whitelisted fields only — never a client, key, principal or path.
const ALLOW_CHECK_SCHEMA = 'telepty.allow-admission/v1';
function allowCheckSuccessLine({ version, daemonOrigin }) {
  return JSON.stringify({ schema: ALLOW_CHECK_SCHEMA, ok: true, telepty_version: String(version), input_policy: 'user-supervised',
    supervision_client: 'loaded', daemon_origin: String(daemonOrigin) });
}
function allowCheckRefusalLine(code) {
  return JSON.stringify({ schema: ALLOW_CHECK_SCHEMA, ok: false, code: String(code) });
}

module.exports = { REFUSALS, admitAllowInvocation, ALLOW_CHECK_SCHEMA, allowCheckSuccessLine, allowCheckRefusalLine };
