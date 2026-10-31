'use strict';
const crypto = require('node:crypto');
const { verifiedRequestPrincipal, storedOwningPrincipal } = require('./http');
const { verifierFor } = require('../session-store/session-credentials');
const pendingHandoff = require('./pending-handoff');
const { mintSessionNonce } = require('../audit/provenance');

function restoreHandoff(value, epoch, generation) {
  if (value === undefined) return undefined;
  try {
    const committed = value?.state === 'committed';
    const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    const allowed=['schema','id','state','epoch','generation','owner_generation','actor','at','expires_at','next_epoch','exit_code','exit_signal','completed_at','pending_custody_schema','pending_policy','pending_count','pending_digest','pending_records','pending_dispatch_started','pending_write_invoked'];
    if (typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 4096
        || value.schema!=='telepty.cooperative-handoff-intent/v1'
        || Object.keys(value).some(key=>!allowed.includes(key)) || !pendingHandoff.validPendingAudit(value)
        || !['awaiting_ack', 'refused', 'outcome_unknown', 'committed'].includes(value.state)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id || '') || !/^[a-f0-9-]{36}$/.test(value.owner_generation || '')
        || !/^[A-Za-z0-9_-]{22}$/.test(value.epoch || '')
        || !value.actor || !identifier(value.actor.id) || !identifier(value.actor.key_id)
        || value.actor.source!=='ed25519' || Object.keys(value.actor).some(key=>!['id','key_id','audience','source'].includes(key))
        || typeof value.actor.audience !== 'string' || !value.actor.audience || value.actor.audience.length>256 || /[\x00-\x20\x7f]/.test(value.actor.audience) || !Number.isSafeInteger(value.generation)
        || value.generation < 1 || value.generation>=Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(value.expires_at) || !Number.isSafeInteger(value.at)
        || value.at<0 || value.expires_at<=value.at || value.expires_at-value.at>60000
        || (committed && (!/^[A-Za-z0-9_-]{22}$/.test(value.next_epoch || '') || value.next_epoch===value.epoch || !Number.isSafeInteger(value.completed_at) || value.completed_at<value.at
          || !(value.exit_code===null || Number.isSafeInteger(value.exit_code)) || !(value.exit_signal===null || typeof value.exit_signal==='string' && value.exit_signal.length<=32 && !/[\x00-\x1f\x7f]/.test(value.exit_signal))))
        || (committed ? value.next_epoch !== epoch || value.generation + 1 !== generation
          : value.epoch !== epoch || value.generation !== generation)) throw new Error();
    return value;
  } catch {
    return { state: 'outcome_unknown', invalid: true };
  }
}

function restoreHandoffRecord(meta) {
  const result=meta.cooperativeHandoffCapable===true ? {cooperativeHandoffCapable:true} : {};
  if(Object.hasOwn(meta,'cooperativeHandoff'))result.cooperativeHandoff=restoreHandoff(meta.cooperativeHandoff,meta.sessionEpoch,Number(meta.credentialGeneration)||1);
  if(Object.hasOwn(meta,'cooperativeHandoffAudit')){
    const rows=meta.cooperativeHandoffAudit;
    if(!Array.isArray(rows)||rows.length>32||rows.some(row=>!row || row.state!=='committed' || restoreHandoff(row,row.next_epoch,row.generation+1)?.invalid)){
      result.cooperativeHandoff={state:'outcome_unknown',invalid:true};
    }else result.cooperativeHandoffAudit=rows;
  }
  return result;
}

function activeHandoff(session) {
  return !!session?.cooperativeHandoff && !['committed', 'refused'].includes(session.cooperativeHandoff.state);
}

function registerCooperativeHandoff(app, { context, getMailbox, hasUnsettled = () => true, timeoutMs = 4000 }) {
  const pending = new Map();

  function status(session) {
    return {
      schema: 'telepty.cooperative-handoff/v1', session_id: session.id,
      intent_id: session.cooperativeHandoff?.id, state: session.cooperativeHandoff?.state || 'absent',
      session_epoch: session.sessionEpoch, credential_generation: session.credentialGeneration,
      owner_generation: session.interactionOwnerGeneration || null,
      ...(session.cooperativeHandoff?.pending_policy ? {pending_policy:session.cooperativeHandoff.pending_policy,pending_count:session.cooperativeHandoff.pending_count,pending_digest:session.cooperativeHandoff.pending_digest} : {}),
      pending_transport:session.pendingHandoffCapability?.owner===session.ownerWs && session.pendingHandoffCapability?.generation===session.interactionOwnerGeneration?'available':'unavailable',
      child_exit: 'incumbent_report_only', process_tree: 'unknown', retryable: false
    };
  }

  function authorizedOwner(req, id) {
    const principal = verifiedRequestPrincipal(req, { action: 'session.takeover', target: id });
    const session = Object.getOwnPropertyDescriptor(context.sessions, id)?.value;
    const stored = storedOwningPrincipal(session?.owningPrincipal);
    return principal && stored && principal.id === stored.id && principal.audience === stored.audience
      ? { principal, session } : null;
  }

  function captureCustody(id, session, policy) {
    try {
      if(hasUnsettled(id,session))return null;
      if(policy==='empty')return getMailbox().snapshotCustody(id).length===0?[]:null;
      return getMailbox().withNeverAttemptedCustody(id, rows => rows.every(row=>pendingHandoff.validConsent(row,session,session.sessionEpoch,session.interactionOwnerGeneration))?rows:null);
    }catch{return null;}
  }

  app.get('/api/sessions/:id/handoff', (req, res) => {
    const authorized = authorizedOwner(req, req.params.id);
    if (!authorized) return res.status(403).json({ code: 'HANDOFF_OWNER_REQUIRED' });
    return res.json(status(authorized.session));
  });

  app.post('/api/sessions/:id/handoff', async (req, res) => {
    const id = req.params.id;
    const authorized = authorizedOwner(req, id);
    const deny = (code, statusCode = 409) => res.status(statusCode).json({ success: false, code, retryable: false });
    if (!authorized) return deny('HANDOFF_OWNER_REQUIRED', 403);
    const { session, principal } = authorized;
    const body = req.body;
    if (session.type !== 'wrapped' || session.cooperativeHandoffCapable !== true || session.sshRemote || session.isClosing) {
      return deny('HANDOFF_UNSUPPORTED');
    }
    if (!context.sessionCredentials.matches(id, req.headers['x-telepty-session-token'])) {
      return deny('HANDOFF_BEARER_REQUIRED', 403);
    }
    if (!body || Array.isArray(body)
        || Object.keys(body).some(key => !['intent_id', 'expected_epoch', 'credential_generation', 'owner_generation','pending_policy'].includes(key))
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.intent_id || '')) return deny('HANDOFF_INVALID_REQUEST', 400);
    if (session.cooperativeHandoff?.id === body.intent_id) {
      return res.status(409).json({ ...status(session), success: false, code: 'HANDOFF_ALREADY_RECORDED' });
    }
    const policy=body.pending_policy===undefined?'empty':body.pending_policy;
    if(!['empty','never-attempted'].includes(policy))return deny('HANDOFF_INVALID_REQUEST',400);
    if(policy==='never-attempted' && (session.externalApprovalPolicy || session.provenanceCapable===true))return deny('HANDOFF_CONSENT_UNSUPPORTED');
    if (activeHandoff(session)) return deny('HANDOFF_FENCED');
    if (body.expected_epoch !== session.sessionEpoch || body.credential_generation !== session.credentialGeneration
        || body.owner_generation !== session.interactionOwnerGeneration) return deny('HANDOFF_INSTANCE_CHANGED');

    const ws = session.ownerWs;
    const epoch = session.sessionEpoch;
    const generation = session.credentialGeneration;
    const ownerGeneration = session.interactionOwnerGeneration;
    if (ws?.readyState !== 1 || !session.strictOwnerConnected || !Number.isSafeInteger(generation)
        || generation < 1 || generation >= Number.MAX_SAFE_INTEGER) return deny('HANDOFF_INCUMBENT_UNAVAILABLE');
    const captured=captureCustody(id,session,policy);
    if(captured===null)return deny('HANDOFF_PENDING_OR_UNKNOWN');
    const custodyReceipt=pendingHandoff.snapshotReceipt(captured);

    const previous = session.cooperativeHandoff;
    const ownerSnapshot = JSON.stringify(storedOwningPrincipal(session.owningPrincipal));
    const intent = {
      schema:'telepty.cooperative-handoff-intent/v1',id: body.intent_id, state: 'awaiting_ack', epoch, generation, owner_generation: ownerGeneration,
      actor: { id: principal.id, key_id: principal.keyId, audience: principal.audience,source:'ed25519' },
      pending_policy:policy,...custodyReceipt,
      at: Date.now(), expires_at: Date.now() + timeoutMs
    };
    session.cooperativeHandoff = intent;
    const saved = context.persistSessions();
    if (!saved?.ok) {
      if (!saved?.committed) session.cooperativeHandoff = previous;
      return deny('HANDOFF_STORE_UNAVAILABLE', 503);
    }

    function current() {
      return context.sessions[id] === session && !session.isClosing && session.sessionEpoch === epoch
        && session.credentialGeneration === generation && session.interactionOwnerGeneration === ownerGeneration
        && session.ownerWs === ws && session.cooperativeHandoff === intent
        && JSON.stringify(storedOwningPrincipal(session.owningPrincipal)) === ownerSnapshot;
    }
    let timer;
    const ackPromise = new Promise(resolve => {
      pending.set(id, { intent, ws, resolve });
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      ws.send(JSON.stringify({ type: 'handoff_stop', intent_id: intent.id, session_epoch: epoch,
        credential_generation: generation, owner_generation: ownerGeneration, deadline: intent.expires_at }));
    } catch { pending.get(id)?.resolve(null); }
    const ack = await ackPromise;
    clearTimeout(timer);
    pending.delete(id);
    if (!current()) return deny('HANDOFF_INSTANCE_CHANGED');
    if (!ack || Date.now() > intent.expires_at || ack.status !== 'exited') {
      intent.state = ack?.status === 'refused' ? 'refused' : 'outcome_unknown';
      const result = context.persistSessions();
      if (!result?.ok) intent.state = 'outcome_unknown';
      return res.status(409).json({ ...status(session), success: false,
        code: ack?.status === 'refused' ? 'HANDOFF_INCUMBENT_REFUSED' : 'HANDOFF_OUTCOME_UNKNOWN' });
    }

    try {
      return getMailbox()[policy==='never-attempted'?'withNeverAttemptedCustody':'withCustodySnapshot'](id, messages => {
        const sameCustody=policy==='empty'?messages.length===0:messages.every(row=>pendingHandoff.validConsent(row,session,epoch,ownerGeneration)) && pendingHandoff.snapshotReceipt(messages).pending_digest===custodyReceipt.pending_digest;
        if (!sameCustody || hasUnsettled(id, session) || !current()) {
          intent.state = 'outcome_unknown';
          context.persistSessions();
          return res.status(409).json({...status(session),success:false,code:'HANDOFF_PENDING_OR_UNKNOWN',retryable:false});
        }
        // No await follows the final identity/custody check. The verifier and release audit
        // become visible together; neither a failed response nor late ACK repeats the effect.
        const descriptors = Object.getOwnPropertyDescriptors(session);
        const nextEpoch = crypto.randomBytes(16).toString('base64url');
        const bearer = `${nextEpoch}.${crypto.randomBytes(32).toString('base64url')}`;
        const nonce = mintSessionNonce();
        const committed = { ...intent, state: 'committed', next_epoch: nextEpoch,
          exit_code: ack.exit_code, exit_signal: ack.exit_signal, completed_at: Date.now() };
        Object.assign(session, {
          sessionEpoch: nextEpoch, credentialGeneration: generation + 1, credentialVerifier: verifierFor(bearer),
          provenanceNonce: nonce, sessionEpochProved: null, ownerWs: null, ownerToken: null, ownerPid: null, ptyPid: null,
          interactionOwnerGeneration: null, ready: false, cooperativeHandoff: committed,
          cooperativeHandoffAudit: [...(Array.isArray(session.cooperativeHandoffAudit) ? session.cooperativeHandoffAudit : []), committed].slice(-32)
        });
        const result = context.persistSessions();
        if (!result?.ok && !result?.committed) {
          for (const key of Object.keys(session)) delete session[key];
          Object.defineProperties(session, descriptors);
          intent.state = 'outcome_unknown';
          context.persistSessions();
          return deny('HANDOFF_STORE_UNAVAILABLE', 503);
        }
        context.sessionCredentials.revoke(id);
        context.sessionCredentials.adopt(id, session);
        context.sidNonces.set(id, nonce);
        try { ws.close(4004, 'Cooperative release recorded'); } catch {}
        if (!result.ok) return deny('HANDOFF_STORE_UNAVAILABLE', 503);
        return res.json({ ...status(session), success: true, session_token: bearer, session_nonce: nonce,
          credential_generation: generation + 1, previous_epoch: epoch });
      });
    } catch {
      // The release ACK is not permission to guess an empty or unlocked mailbox.
      if (session.cooperativeHandoff === intent) {
        intent.state = 'outcome_unknown';
        context.persistSessions();
      }
      return deny('HANDOFF_CUSTODY_UNAVAILABLE', 503);
    }
  });

  function acceptAck(id, session, ws, message) {
    const attempt = pending.get(id);
    if (!attempt || attempt.ws !== ws || attempt.intent !== session.cooperativeHandoff
        || Date.now() > attempt.intent.expires_at || message.intent_id !== attempt.intent.id
        || message.session_epoch !== attempt.intent.epoch || message.owner_generation !== attempt.intent.owner_generation
        || message.credential_generation !== attempt.intent.generation || !['exited', 'refused'].includes(message.status)) return false;
    if (message.status === 'exited'
        && (!(message.exit_code === null || Number.isSafeInteger(message.exit_code))
          || !(message.exit_signal === null || (typeof message.exit_signal === 'string'
            && message.exit_signal.length <= 32 && !/[\x00-\x1f\x7f]/.test(message.exit_signal))))) return false;
    attempt.resolve(message);
    return true;
  }
  return { acceptAck };
}
module.exports = { registerCooperativeHandoff, activeHandoff, restoreHandoff, restoreHandoffRecord };
