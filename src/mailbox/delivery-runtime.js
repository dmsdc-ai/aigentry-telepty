'use strict';
const { protectedInputFailure } = require('../external-approval');
const { mailboxLeaseAlive } = require('./poll-session');
const bridgeStage = require('./bridge-stage');
const inputPolicies = require('./input-policy');
const readinessHandshake = require('../transport/readiness-handshake');
const { ptyInputFailure } = require('../pty-input-lifecycle');
const { validInjectId } = require('../diagnostics/correlation');

// Task 1215 hotfix 0.10.1 — immediate-submit-v1. A 0.10.1 bridge declares it on its authenticated owner-WS handshake
// header (x-telepty-bridge-capabilities, next to input-transport-ready-v1). It means the bridge writes an authorized
// inject at once (no ready/idle/output gate) and admits at most ONE submit CR per inject_id/pair per owner generation.
// websocket.js binds it at the single owner-generation mint, so every claim resets it. An old bridge never declares it,
// and it is never inferred from a receipt or from timing.
const IMMEDIATE_SUBMIT_CAPABILITY = 'immediate-submit-v1';
const SUBMIT_PAIR_MAX = 256;
function bindImmediateSubmitCapability(session, headerValue) {
  const declared = typeof headerValue === 'string' && headerValue.length <= 256
    && headerValue.split(',').map(part => part.trim()).includes(IMMEDIATE_SUBMIT_CAPABILITY);
  session.immediateSubmitGeneration = declared && typeof session.interactionOwnerGeneration === 'string'
    ? session.interactionOwnerGeneration : null;
  return session.immediateSubmitGeneration !== null;
}
// Honoured only for the CURRENT owner generation, and only together with that generation's negotiated
// input-transport handshake (the input-transport fence the immediate path keeps).
function immediateSubmitSupport(session) {
  if (!session || session.type !== 'wrapped' || session.sshRemote) return 'not_applicable';
  return typeof session.immediateSubmitGeneration === 'string'
    && session.immediateSubmitGeneration === session.interactionOwnerGeneration
    && readinessHandshake.negotiated(session) ? 'supported' : 'unsupported_by_bridge';
}
// The body daemon_msg_id this daemon handed to the current owner for an inject_id, so the immediate CR can name its
// pair. The entry is bounded and kept in memory only, never persisted (sessions.json is whitelisted). It is bound to the owner generation at hand-over.
function rememberSubmitPair(session, injectId, daemonMsgId) {
  if (!session || session.type !== 'wrapped' || !validInjectId(injectId) || typeof daemonMsgId !== 'string' || !daemonMsgId) return false;
  if (!(session.submitPairs instanceof Map)) session.submitPairs = new Map();
  session.submitPairs.delete(injectId);
  session.submitPairs.set(injectId, { daemon_msg_id: daemonMsgId, owner_generation: session.interactionOwnerGeneration || null });
  while (session.submitPairs.size > SUBMIT_PAIR_MAX) session.submitPairs.delete(session.submitPairs.keys().next().value);
  return true;
}
function submitPairFor(session, injectId) {
  const entry = validInjectId(injectId) && session && session.submitPairs instanceof Map ? session.submitPairs.get(injectId) : null;
  return entry && entry.owner_generation && entry.owner_generation === session.interactionOwnerGeneration ? entry.daemon_msg_id : null;
}
// hotfix480 F1 — bodies of a wrapped session still in daemon custody (mailbox pending / in flight). session-delivery holds
// one at enqueue and settles it on the body's actual handoff to the owner (handed) or when it leaves custody any other
// way. An immediate CR waits on that event (never a poll/dwell/output wait), bounded. In memory, bounded per session.
const BODY_CUSTODY_MAX = 256;
function holdBodyCustody(session, msgId, injectId) {
  if (!session || typeof msgId !== 'string') return;
  if (!(session.bodyCustody instanceof Map)) session.bodyCustody = new Map();
  session.bodyCustody.set(msgId, { injectId: validInjectId(injectId) ? injectId : null, waiters: [] });
}
// hotfix492 N4: live custody is never evicted; at the bound a NEW body is refused before it is queued (session-delivery).
function bodyCustodyFull(session) {
  return !!session && session.bodyCustody instanceof Map && session.bodyCustody.size >= BODY_CUSTODY_MAX;
}
// handed: true (handed to the owner), false (left custody unwritten), 'unknown' (left custody, outcome unknown).
function settleBodyCustody(session, msgId, handed) {
  const entry = session && session.bodyCustody instanceof Map ? session.bodyCustody.get(msgId) : null;
  if (!entry) return;
  session.bodyCustody.delete(msgId);
  for (const resolve of entry.waiters) resolve(handed === true || handed === 'unknown' ? handed : false);
}
// null at once when nothing it must follow is in custody (named: that inject's body; id-less: every body). Otherwise
// { handed, unknown } once all of them settled, or { timed_out: true } at the bound.
function awaitBodyCustody(session, injectId, timeoutMs) {
  const ahead = session && session.bodyCustody instanceof Map
    ? [...session.bodyCustody.values()].filter(entry => !injectId || entry.injectId === injectId) : [];
  if (!ahead.length) return null;
  let timer;
  const settled = Promise.all(ahead.map(entry => new Promise(resolve => entry.waiters.push(resolve))))
    .then(results => ({ handed: results.every(r => r === true), unknown: results.includes('unknown') }));
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, { timed_out: true }); });
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}
// hotfix480 F1-F4 — THE immediate single-CR attempt (the /submit route and the queued drain). In order: wait behind a
// body still in daemon custody; re-check owner instance, ADMITTING generation and capability; a named inject needs this
// generation's pair (never an id-less CR for it); `beforeEffect` may still refuse; then ONE CR. A refusal writes nothing.
// hotfix492 N2: after an actual custody wait, `modalCheck` (the applicable modal decision) is asked again right before
// the effect; a decision other than deliver is returned as `modal` and nothing is written.
async function immediateSubmitAttempt(session, { injectId = null, generation, timeoutMs, isCurrent, beforeEffect = () => true, submit,
  modalCheck = () => null }) {
  const custody = awaitBodyCustody(session, injectId, timeoutMs);
  const waited = custody ? await custody : null;
  if (waited && waited.timed_out) return { strategy: null, reason: 'body_custody_pending' };
  if (waited && !waited.handed && injectId) return { strategy: null, reason: waited.unknown ? 'body_outcome_unknown' : 'body_not_handed' };
  if (!isCurrent() || session.interactionOwnerGeneration !== generation || immediateSubmitSupport(session) !== 'supported') {
    return { strategy: null, reason: 'owner_generation_changed' };
  }
  if (injectId && !submitPairFor(session, injectId)) {
    const foreign = session.submitPairs instanceof Map && session.submitPairs.has(injectId);
    return { strategy: null, reason: foreign ? 'owner_generation_changed' : 'submit_pair_unavailable', prior_submit: 'unknown' };
  }
  const modal = waited ? modalCheck() : null;
  if (modal) return { strategy: null, reason: modal.reason, modal };
  if (!beforeEffect()) return { strategy: null, reason: 'cancelled' };
  return { strategy: submit({ ...(injectId ? { injectId } : {}), immediate: true }), ...(waited ? { queued_behind_body: true } : {}) };
}
// hotfix480: the extra response fields of an attempt (reason / prior_submit / queued_behind_body), nothing else.
function immediateAttemptFields(attempt) {
  const fields = { ...attempt };
  delete fields.strategy;
  delete fields.modal;   // hotfix492: the decision object is the caller's, never a response field
  return fields;
}
// The /submit response of the immediate path. It reports only what the daemon knows: whether the CR frame was handed to
// the current owner socket. The bridge receipt reports the PTY write. Consumption is unknown, and nothing is confirmed.
function immediateSubmitOutcome(strategy, extra = {}) {
  if (!strategy) {
    return { status: 503, body: { error: 'Submit not written: the owner bridge cannot take it for this owner generation',
      strategy: 'none', attempts: 0, gated: false, immediate_submit: true, submit_stage: 'not_written', ...extra } };
  }
  return { status: 200, body: { success: true, strategy, attempts: 1, gated: false, immediate_submit: true,
    submit_stage: 'sent_to_bridge', pty_write: 'reported_by_bridge_receipt', consumption: 'unknown',
    consumption_reason: 'not_observed_by_immediate_submit', submit_confirmed: false, ...extra } };
}

// Accessors retain the daemon's shared instances and original first-use timing.
// Construction only creates functions; effect boundaries run when those functions do.
function createDeliveryRuntime(shared, {
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout
} = {}) {
  function auditAppend(record) {
    if (shared.sessions?.[record.to]?.externalApprovalPolicy) record = { ...record, preview: false };
    try { shared.auditWriter.append(record); } catch { /* audit must never throw into a handler */ }
  }

  function verifiedPrincipalFromReq(req) {
    const bearer = req.headers && req.headers['x-telepty-session-token'];
    if (!bearer) return null;
    return shared.sessionCredentials.verify(bearer);
  }

  function verifiedSenderFields(principal) {
    return {
      verified_sender_sid: principal ? principal.sid : null,
      verified_sender_epoch: principal ? principal.epoch : null,
      verified_sender_generation: principal ? principal.generation : null
    };
  }

  // #1207 — there is no whole-ledger save boundary any more. Every writer (begin/abort/park here,
  // recordObservation in session-actions, the interaction core) submits one small delta to the
  // ledger owner through `shared.ledgerClient` and acts only on its explicit outcome. The guard
  // semantics of the former commitTrackedInjections survive: an unavailable store authorizes no
  // write — `ledgerUnavailable()` is checked before any in-memory or on-disk mutation, and the
  // only transition back to healthy is a successful owner open (restoreTrackedInjections).
  function ledgerUnavailable() {
    const client = shared.ledgerClient;
    if (!client || !shared.trackedLedgerHealthy || !client.isAvailable()) {
      // The NAMED reason: the retained unavailable reason when the store is unreadable, else the
      // store state itself (recovering / unavailable_write / lock_present / shutting_down), else
      // the owner-failure reason. Never an errno string — those are detail, kept in status.
      let reason = shared.trackedLedgerUnavailableReason || null;
      if (!reason && client) {
        if (client.state === 'unavailable') reason = client.reason || 'unavailable';
        else if (client.state === 'closing' || client.state === 'closed') reason = 'shutting_down';
        else reason = client.state;
      }
      return { ok: false, reason: reason || 'observation_store_unavailable' };
    }
    return null;
  }

  // Maps a ledger outcome onto the inject-route result shapes. `capacity:true` marks the 503 arm.
  function beginFailure(outcome) {
    if (!outcome) return { ok: false, reason: 'tracking_persistence_failed' };
    if (outcome.outcome === 'indeterminate') return { ok: false, reason: 'tracking_outcome_indeterminate', txn: outcome.txn };
    if (outcome.outcome === 'rejected_admission') return { ok: false, reason: outcome.reason || 'tracking_capacity_exhausted', capacity: true };
    const r = outcome.reason;
    if (['recovering', 'owner_failed', 'unavailable_write', 'lock_present', 'disk_full', 'sustained_exhaustion', 'tracking_capacity_exhausted', 'hot_capacity', 'shutting_down'].includes(r)) {
      return { ok: false, reason: r, capacity: true };
    }
    return { ok: false, reason: 'tracking_persistence_failed', detail: r || null };
  }

  function interactionBinding(sid) {
    const s = shared.sessions[sid];
    if (!s || !s.sessionEpoch || s.sessionEpochProved !== s.sessionEpoch) return null;
    return { sid, session_epoch: s.sessionEpoch, credential_generation: s.credentialGeneration || 1,
      owner_generation: s.interactionOwnerGeneration || null,
      input_generation: s.interactionInputGeneration || 0,
      geometry_generation: s.interactionGeometryGeneration || 0,
      surface_id: s.cmuxSurfaceId || sid, cols: s.cols || null, rows: s.rows || null };
  }

  function hasHeldInteraction(session) {
    if (!session) return false;
    // #1207 — the committed-only read model replaces the in-memory mirror.
    return shared.interactionCore.isBusy(session.id)
      || (!!shared.ledgerClient && shared.ledgerClient.readModel.hasHeldInteraction(session.id));
  }

  function dispatchInteraction(frame) {
    const sid = frame.request.identity.sid;
    const s = shared.sessions[sid];
    if (!s) return Promise.resolve(shared.interaction.refusal('wrong_owner'));
    if (protectedInputFailure(s)) return Promise.resolve(shared.interaction.refusal('unsupported_capability'));
    if (s.type !== 'wrapped' || !shared.isOpenWebSocket(s.ownerWs)) {
      return Promise.resolve(shared.interaction.refusal('unsupported_capability'));
    }
    const invalid = shared.interaction.validateObservation(frame.request,
      shared.readyRegistry.observeInteraction(s), interactionBinding(sid));
    if (invalid) return Promise.resolve(shared.interaction.refusal(invalid));
    return new Promise(resolve => {
      const owner = s.ownerWs;
      const id = frame.request.action_id;
      const timer = setTimeout(() => finish({ stage: 'outcome_unknown', bytes_written: null }), 5000);
      function finish(result) {
        clearTimeout(timer);
        shared.interactionWaiters.delete(id);
        resolve(result);
      }
      shared.interactionWaiters.set(id, { sid, owner, digest: frame.request_digest, finish });
      try { owner.send(JSON.stringify({ ...frame, owner_generation: s.interactionOwnerGeneration })); }
      catch { finish({ stage: 'outcome_unknown', bytes_written: null }); }
    });
  }

  // #1207 — ONE restoration at a time. Overlapping restore calls (measured: two concurrent callers
  // shared one owner open and then EACH wrote the daemon_restart_observed fact) share the single
  // in-flight restoration and its outcome — failures included. A genuinely subsequent call, made after
  // the shared one settled, performs its own restoration and its own fact. No flag outlives the work.
  let restoreInFlight = null;
  // One-shot watch that completes a first-open recovery across the client boundary (armRecoveryWatch).
  let recoveryWatch = null;
  // #1215 — this recovery's daemon_restart_observed submission while it is in flight (settles, never
  // rejects). The owner serves reads from COMMITTED facts only and holds a submitted fact in its open
  // group for up to GROUP.ms before the fsync, so a poll that arrived in that window was answered
  // without the fact (measured: CI 5914cc3 mac+win, [tracking_started] only). fetchTrackedInjection
  // orders itself after this one submission; nothing is written, retried or synthesized for it.
  let restartFactSettling = null;

  function restoreTrackedInjections() {
    if (restoreInFlight) return restoreInFlight;
    restoreInFlight = performRestore().finally(() => { restoreInFlight = null; });
    return restoreInFlight;
  }

  async function performRestore() {
    // #1207 — "restore" is the owner's open: lock verification, offline migration of a legacy file
    // if one is at the path, recovery of segments, and a chunked committed-only snapshot. A failed
    // open leaves the store unavailable with a NAMED reason and authorizes nothing; a successful
    // open is the ONLY transition back to healthy (guard semantics preserved).
    const client = shared.ledgerClient;
    if (!client) {
      shared.trackedLedgerHealthy = false;
      shared.trackedLedgerUnavailableReason = 'observation_store_unavailable';
      return { ok: false, reason: 'no_ledger_client' };
    }
    const opening = client.open({ liveSids: Object.keys(shared.sessions || {}) });
    // The restore is in progress from here until `opening` settles. The poll handler and
    // ledgerUnavailable() serve the shared lifecycle reason AHEAD of the client state, so a stale
    // one — the daemon's initial `not_opened`, or the reason of a previous failed open — would be
    // named while the owner is actually recovering, and `not_opened` selects the generic 500 branch
    // in beginFailure (measured: frozen R1, polls `not_opened`, begins 500 during recovery). The
    // store stays unhealthy; `recovering` is the client's own in-flight state and already maps to
    // the 503 arm. open() has exactly one synchronous refusal, the lock (`lock_present`, or
    // `unavailable` with `lock_error`): that outcome is already settled and keeps its precise name
    // through the branch below, so nothing is marked `recovering` for it.
    shared.trackedLedgerHealthy = false;
    const lockRefused = client.state === 'lock_present' || (client.state === 'unavailable' && client.reason === 'lock_error');
    if (!lockRefused) shared.trackedLedgerUnavailableReason = 'recovering';
    const opened = await opening;
    if (!opened.ok) {
      shared.trackedLedgerHealthy = false;
      shared.trackedLedgerUnavailableReason = opened.reason === 'manifest_format' || opened.state === 'unavailable_read'
        ? 'observation_store_unavailable' : (opened.reason || 'observation_store_unavailable');
      console.warn(`[OBSERVE] tracked-injection store unavailable (${opened.state}: ${opened.reason || 'unknown'}) — every poll answers tracking_state=unavailable`);
      // The owner died during this open. The client's own bounded respawn policy may bring ONE
      // replacement after this failed open has finalized (measured: previously none was constructed);
      // health may only follow that replacement's COMPLETE snapshot, which the client reports as
      // `available` — watched below, never assumed. An unavailable store stays fail-closed.
      if (opened.reason === 'owner_failed') armRecoveryWatch(client);
      return opened;
    }
    return finishRecovery(client, opened.counts || {});
  }

  // The ONLY transition to healthy: a complete, swapped-in snapshot for the current owner — reached by
  // a successful open, or by the client's `available` notification after an internal replacement.
  // The restart fact is stored ONCE per recovery as a global fact and overlaid lazily onto every
  // record in log order (DECISION §6, errata C3) — byte-for-byte the array today's per-record append
  // would have produced, without rewriting history. Nothing is appended to an empty store.
  async function finishRecovery(client, counts) {
    shared.trackedLedgerHealthy = true;
    shared.trackedLedgerUnavailableReason = null;
    const hadRecords = (counts.hot || 0) + (counts.cold || 0) > 0;
    let restartFact = null;
    if (hadRecords) {
      const submitted = client.submit('fact', { scope: 'global', observation: { kind: 'daemon_restart_observed', trigger: 'daemon_restart', at: new Date().toISOString() } }, { class: 'L' });
      const settling = submitted.then(() => undefined, () => undefined);
      restartFactSettling = settling;
      try { restartFact = await submitted; } finally { if (restartFactSettling === settling) restartFactSettling = null; }
      if (restartFact.outcome !== 'ack') {
        console.warn(`[OBSERVE] daemon_restart_observed fact not durable (${restartFact.outcome}: ${restartFact.reason || ''}) — recorded in ledger status, not retried`);
      }
      console.log(`[OBSERVE] restored ${counts.hot || 0} hot + ${counts.cold || 0} cold tracked injection(s) — all still completion-unknown`);
    }
    return { ok: true, counts, restartFact };
  }

  // After an `owner_failed` open: follow the SAME client's lifecycle until it either reports
  // `available` after its replacement's snapshot (→ finishRecovery, unless a restoration in flight
  // already owns the transition) or fails again / is closed / is replaced (→ fail-closed with the
  // client's named reason, watch disarmed). While the replacement opens, the reason is `recovering`
  // (the same naming the R1 correction gives an explicit restore). One listener, no timer, no retry,
  // no budget of its own; it never flips health on anything but the client's post-snapshot report.
  function armRecoveryWatch(client) {
    if (recoveryWatch || typeof client.onStateChange !== 'function') return;
    const disarm = () => { if (recoveryWatch) { const unsubscribe = recoveryWatch; recoveryWatch = null; unsubscribe(); } };
    recoveryWatch = client.onStateChange((ev) => {
      if (client !== shared.ledgerClient || ev.kind === 'closed') return disarm();
      if (shared.trackedLedgerHealthy) return disarm();                 // an explicit restore completed meanwhile
      if (ev.kind === 'recovering') { shared.trackedLedgerUnavailableReason = 'recovering'; return undefined; }
      if (ev.kind === 'unavailable' || ev.kind === 'unavailable_read') {
        shared.trackedLedgerUnavailableReason = ev.kind === 'unavailable_read' ? 'observation_store_unavailable' : (ev.reason || 'owner_failed');
        return disarm();
      }
      if (ev.kind !== 'available') return undefined;
      disarm();
      if (restoreInFlight) return undefined;
      restoreInFlight = finishRecovery(client, ev.counts || {}).catch((error) => {
        shared.trackedLedgerHealthy = false;
        shared.trackedLedgerUnavailableReason = 'observation_store_unavailable';
        console.error(`[OBSERVE] recovery after owner replacement failed: ${error && error.message}`);
        return { ok: false, reason: 'recovery_failed' };
      }).finally(() => { restoreInFlight = null; });
      return undefined;
    });
  }

  function getTrackedInjection(injectId) {
    // Sync, committed-only, HOT records (the working set). Cold records are read asynchronously via
    // fetchTrackedInjection (poll endpoint) and reheated only by a write (ensureHot).
    if (!shared.ledgerClient) return null;
    return shared.ledgerClient.readModel.getTrackedInjection(injectId);
  }

  async function fetchTrackedInjection(injectId) {
    if (typeof injectId !== 'string' || !injectId) return { record: null, reason: 'invalid_id' };
    if (!shared.ledgerClient) return { record: null, reason: 'observation_store_unavailable' };
    if (restartFactSettling) await restartFactSettling;
    return shared.ledgerClient.fetchTrackedInjection(injectId);
  }

  function sessionAuthenticationCapability(session) {
    if (!session || !session.sessionEpoch) return {};
    if (session.sessionEpochProved && session.sessionEpochProved === session.sessionEpoch) {
      return { session_authentication: 'observed', session_authentication_reason: null };
    }
    return { session_authentication: 'unavailable', session_authentication_reason: 'no_815_bearer_presented' };
  }

  async function beginTrackedInjection({ injectId, sessionId, source, session }) {
    // #1207 — refuse BEFORE any in-memory mutation. Measured on the 0.9.1 tree: after restore
    // refused a truncated or future-schema file (bytes untouched), this path inserted into the
    // empty mirror, committed it over the preserved bytes, flipped the store back to healthy and
    // let the inject route deliver. An unavailable store still answers the failure shape the route
    // already handles (500 TRACKING_PERSISTENCE_FAILED, tracking_state:'unavailable', no delivery).
    const unavailable = ledgerUnavailable();
    if (unavailable) {
      console.error(`[OBSERVE] tracking REFUSED for ${injectId} — observation store unavailable (${unavailable.reason}); refusing delivery`);
      return beginFailure({ outcome: 'nack', reason: unavailable.reason });
    }
    const client = shared.ledgerClient;
    // Reserve BEFORE accepting (errata C5): one terminal unit + two result units for this job, the
    // admitted-jobs cap, the sustained-exhaustion gate and the free-space HINT. A refusal here is
    // `rejected_admission`: nothing queued, nothing persisted, 503 TRACKING_CAPACITY on the route.
    const reserved = client.reserveJob(injectId);
    if (!reserved.ok) {
      console.error(`[OBSERVE] tracking REFUSED for ${injectId} — capacity (${reserved.reason}); refusing delivery`);
      return beginFailure({ outcome: 'rejected_admission', reason: reserved.reason });
    }
    const nowIso = new Date().toISOString();

    // Supersession is decided by the OWNER from its hot session index (records of this session that
    // are still `tracked`): the old record is retained and gains `tracking_superseded` in the same
    // durable group as the new begin. The previous in-memory scan over every record (O(history))
    // and its descriptor-level rollback are gone — a group is durable or it is not.
    const record = {
      inject_id: injectId,
      session_id: sessionId,
      // #815 gives an epoch only where a session actually proved one. Stage A records the absence
      // with a reason rather than inventing availability from a bare SID or an open socket.
      session_epoch: (session && session.sessionEpoch) || null,
      session_epoch_reason: (session && session.sessionEpoch) ? null : 'no_815_epoch_fact',
      owner_generation: (session && session.interactionOwnerGeneration) || null,
      transport_source: source || null,
      created_at: nowIso,
      observation_seq: 0,
      observations: [],
      last_observation: null,
      // #843 — the capability block must not contradict the record it is stamped on.
      // `CAPABILITY_STAGE_A` is frozen with `session_authentication_reason: 'no_815_epoch_fact'` and
      // was spread onto EVERY record, including records whose own `session_epoch` two lines up holds
      // the epoch the session PROVED on its #815 handshake. One response body then carried both the
      // epoch and a reason denying any epoch fact was measured, leaving a reader to pick which half
      // of one object to believe. §A4 requires gaps to be explicit; it does not license reporting a
      // gap that was measured shut. #860 F1: nor does it license the opposite — see
      // sessionAuthenticationCapability, which is what decides the three cases.
      capability: {
        ...shared.CAPABILITY_STAGE_A,
        ...sessionAuthenticationCapability(session),
      },
      tracking_state: 'tracked',
    };
    // `tracking_started` is part of the begin frame itself (seq 1), exactly as before.
    shared.sessionPersistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, nowIso);

    const outcome = await client.submit('begin', { id: injectId, sid: sessionId, record, at: nowIso }, { class: 'T', jobId: injectId });
    if (outcome.outcome !== 'ack') {
      // Not durable ⇒ not tracked ⇒ no delivery. The job reservation is released on a nack or a
      // pre-admission rejection; it is RETAINED on indeterminate (the begin may be on disk).
      if (outcome.outcome !== 'indeterminate') client.releaseJob(injectId);
      const failure = beginFailure(outcome);
      console.error(`[OBSERVE] tracking ${outcome.outcome === 'indeterminate' ? 'INDETERMINATE' : 'FAILED'} for ${injectId} — refusing delivery (${failure.reason}${outcome.reason && outcome.reason !== failure.reason ? `: ${outcome.reason}` : ''})`);
      return { ...failure, outcome };
    }
    if (outcome.result === 'already_exists') {
      // Idempotency by key (errata C4 rule 4): a resubmitted begin for an inject_id that is already
      // durable is not a second delivery authorization.
      client.releaseJob(injectId);
      return { ok: false, reason: 'already_exists', outcome };
    }
    const durable = client.readModel.getTrackedInjection(injectId) || record;
    return { ok: true, record: durable, superseded: outcome.superseded || [], outcome };
  }

  async function abortTrackedInjection(injectId, sessionId, deliveryCode, deliveryError, cause = {}) {
    const client = shared.ledgerClient;
    if (!client || ledgerUnavailable()) return 'tracking_unavailable';
    const hot = await client.ensureHot(injectId);
    if (!hot.ok) return hot.reason === 'record_missing' || hot.reason === 'not_observed_by_daemon_epoch' ? 'tracking_unavailable' : (hot.outcome && hot.outcome.outcome === 'indeterminate' ? 'tracking_outcome_indeterminate' : 'tracking_persistence_failed');
    // delivery_error is bounded at 1 KiB so the terminal frame always fits its reserved unit.
    let error = deliveryError == null ? null : String(deliveryError);
    let truncated = false;
    if (error && Buffer.byteLength(error, 'utf8') > 1024) { error = Buffer.from(error, 'utf8').subarray(0, 1024).toString('utf8'); truncated = true; }
    const observation = {
      kind: cause.kind || 'inject_delivery_refused',
      trigger: cause.trigger || 'delivery_refused',
      delivery_code: deliveryCode || 'DELIVERY_FAILED',
      delivery_error: error,
      ...(truncated ? { delivery_error_truncated: true } : {}),
      // Omitting `bytesWritten` means the caller MEASURED zero (the synchronous refusal arm: the
      // route never handed a byte over). An explicit `null` means it could not measure — a throw
      // mid-drain can land on either side of the body write — and null is recorded rather than a
      // guessed zero.
      bytes_written: cause.bytesWritten === undefined ? 0 : cause.bytesWritten,
      at: new Date().toISOString(),
    };
    // The pending entry goes too. It is what makes the session look like it is awaiting a turn, and
    // it belongs to an inject whose bytes were never delivered — every later observation on this
    // session would otherwise be filed against it. Released regardless of the durable outcome: the
    // in-memory pending slot is not evidence, the ledger is.
    if (sessionId && shared.pendingReports[sessionId] && shared.pendingReports[sessionId].injectId === injectId) {
      delete shared.pendingReports[sessionId];
    }
    // Terminal transition on the job's RESERVED T unit; released at the terminal ACK.
    const outcome = await client.submit('state', { id: injectId, tracking_state: 'aborted', observation }, { class: 'T', jobId: injectId });
    if (outcome.outcome === 'ack') return 'tracking_aborted';
    if (outcome.outcome === 'indeterminate') { console.error(`[OBSERVE] abort INDETERMINATE for ${injectId} (${outcome.reason})`); return 'tracking_outcome_indeterminate'; }
    console.error(`[OBSERVE] abort ${outcome.outcome} for ${injectId} (${outcome.reason})`);
    return 'tracking_persistence_failed';
  }

  // #1207 (measured on the four queue-flush paths): the terminal persistence outcome of a dropped or
  // refused op is AWAITED by every notifier before it emits the failure event or resolves its caller,
  // so a notification never outruns the record it describes. Never rejects: a thrown abort is logged
  // and named as a failed persistence outcome — durability unknown is never reported as
  // `tracking_aborted`; an op that carries no tracked record answers `no_tracked_inject` without an
  // owner round trip (the previous unconditional call asked the owner for an id of `undefined`).
  async function settleTerminalOutcome(op, sessionId, deliveryCode, deliveryError, cause) {
    if (!op || !op.injectId) return 'no_tracked_inject';
    try {
      return await abortTrackedInjection(op.injectId, sessionId, deliveryCode, deliveryError, cause);
    } catch (error) {
      console.error(`[OBSERVE] abort THREW for ${op.injectId} (${error && error.message}) — persistence outcome unknown, reported as failed`);
      return 'tracking_persistence_failed';
    }
  }

  async function parkTrackedInjection(injectId, strategy, reason) {
    if (!injectId) return 'no_tracked_inject';
    const client = shared.ledgerClient;
    if (!client || ledgerUnavailable()) return 'tracking_unavailable';
    const hot = await client.ensureHot(injectId);
    if (!hot.ok) return hot.reason === 'record_missing' || hot.reason === 'not_observed_by_daemon_epoch' ? 'tracking_unavailable' : 'tracking_persistence_failed';
    // `inject_parked` is a RESULT-class observation: it draws on the job's reserved R unit first,
    // then the shared R pool; a refusal is named, never queued.
    const outcome = await client.submit('obs', { id: injectId, observation: { kind: 'inject_parked', trigger: strategy, reason: reason || null, bytes_written: 0, at: new Date().toISOString() } }, { class: 'R', jobId: injectId, result: true });
    if (outcome.outcome === 'ack') return 'tracking_parked';
    if (outcome.outcome === 'indeterminate') { console.error(`[OBSERVE] park INDETERMINATE for ${injectId} (${outcome.reason})`); return 'tracking_outcome_indeterminate'; }
    if (outcome.outcome === 'rejected_admission') { console.error(`[OBSERVE] park REJECTED for ${injectId} (${outcome.reason})`); return 'tracking_capacity_result'; }
    console.error(`[OBSERVE] park ${outcome.outcome} for ${injectId} (${outcome.reason})`);
    return 'tracking_persistence_failed';
  }

  // #137 — file one validated bridge stage receipt on its tracked record. The transport already
  // bound it to the current owner socket and generation; this re-checks the RECORD identity
  // (session, epoch, owner generation) before the write, and the owner generation again after
  // the await. The observation is a bridge transport fact: it never carries consumption,
  // acknowledgement or completion, and pty_written is a PTY master write only.
  async function recordBridgeReceipt(sessionId, session, receipt, ownerGeneration) {
    if (!receipt || !receipt.inject_id) return 'no_tracked_inject';
    const client = shared.ledgerClient;
    if (!client || ledgerUnavailable()) return 'tracking_unavailable';
    const hot = await client.ensureHot(receipt.inject_id);
    if (!hot.ok) return hot.reason === 'record_missing' || hot.reason === 'not_observed_by_daemon_epoch' ? 'tracking_unavailable' : 'tracking_persistence_failed';
    const record = client.readModel.getTrackedInjection(receipt.inject_id);
    if (!record || record.session_id !== sessionId || shared.sessions[sessionId] !== session
      || session.interactionOwnerGeneration !== ownerGeneration
      || (record.owner_generation && record.owner_generation !== ownerGeneration)
      || (record.session_epoch && record.session_epoch !== (session.sessionEpoch || null))) return 'receipt_identity_mismatch';
    const observation = { kind: 'bridge_receipt', trigger: `${receipt.stage}:${receipt.part || 'unknown'}`,
      stage: receipt.stage, part: receipt.part, certainty: receipt.certainty, reason: receipt.reason,
      daemon_msg_id: receipt.daemon_msg_id, bridge_msg_id: receipt.bridge_msg_id, bridge_seq: receipt.bridge_seq,
      bridge_at_ms: receipt.at_ms, clock: receipt.clock, owner_generation: ownerGeneration, at: new Date().toISOString() };
    const outcome = await client.submit('obs', { id: receipt.inject_id, observation }, { jobId: receipt.inject_id });
    if (outcome.outcome === 'ack') return 'tracking_bridge_receipt';
    if (outcome.outcome === 'indeterminate') { console.error(`[OBSERVE] bridge receipt INDETERMINATE for ${receipt.inject_id} (${outcome.reason})`); return 'tracking_outcome_indeterminate'; }
    console.error(`[OBSERVE] bridge receipt ${outcome.outcome} for ${receipt.inject_id} (${outcome.reason})`);
    return outcome.outcome === 'rejected_admission' ? 'tracking_capacity_result' : 'tracking_persistence_failed';
  }

  function deliveryAuditResult(delivery) {
    return delivery && delivery.queued === true && (delivery.strategy === 'bootstrap_queue' || delivery.poll_only === true || delivery.delivery_status === 'retry_pending') ? 'queued' : 'success';
  }

  function getPendingReport(sessionId, registry = shared.pendingReports) {
    if (typeof sessionId !== 'string' || !registry) return null;
    const descriptor = Object.getOwnPropertyDescriptor(registry, sessionId);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    const pendingReport = descriptor.value;
    return pendingReport && typeof pendingReport === 'object' && !Array.isArray(pendingReport)
      ? pendingReport : null;
  }

  function markPendingReportSubmitStarted(sessionId, bodyText) {
    const pendingReport = getPendingReport(sessionId);
    if (!pendingReport) return;
    pendingReport.submitExpected = true;
    pendingReport.submitInProgress = true;
    pendingReport.submitStartedAt = new Date().toISOString();
    if (typeof bodyText === 'string') {
      pendingReport.injectedBodyPreview = bodyText.slice(0, 500);
    }
  }

  function markPendingReportSubmitConfirmed(sessionId, confirm) {
    const pendingReport = getPendingReport(sessionId);
    if (!pendingReport) return;
    pendingReport.submitExpected = true;
    pendingReport.submitInProgress = false;
    pendingReport.submitFinishedAt = new Date().toISOString();
    pendingReport.submitConfirmedAt = pendingReport.submitFinishedAt;
    pendingReport.submitConfirm = {
      accepted: true,
      reason: confirm && confirm.reason ? confirm.reason : 'confirmed',
      attempts: confirm && confirm.attempts ? confirm.attempts : undefined,
      ambiguous: !!(confirm && confirm.ambiguous),
    };
  }

  function markPendingReportSubmitUnconfirmed(sessionId, confirm) {
    const pendingReport = getPendingReport(sessionId);
    if (!pendingReport) return;
    pendingReport.submitExpected = true;
    pendingReport.submitInProgress = false;
    pendingReport.submitFinishedAt = new Date().toISOString();
    pendingReport.submitUnconfirmedAt = pendingReport.submitFinishedAt;
    pendingReport.submitConfirm = {
      accepted: false,
      reason: confirm && confirm.reason ? confirm.reason : 'submit_unconfirmed',
      attempts: confirm && confirm.attempts ? confirm.attempts : undefined,
      retryable: !!(confirm && confirm.retryable),
    };
  }

  function broadcastBusEvent(event) {
    const serialized = JSON.stringify(event);
    shared.busClients.forEach((client) => {
      if (client.readyState === 1) client.send(serialized);
    });
  }

  // Task 1215 (Snyk ServerLeak): this body is a response/bus boundary. `extra` cannot override success/code/error,
  // cannot itself be an Error, and drops top-level Error values plus the raw exception carriers `stack`/`detail`
  // (the only `detail` producer is a raw socket err.message; it stays in the local operator log, and no consumer
  // reads it). `publicErrorContext` is reserved too: it is never a JSON field (see buildErrorBody).
  const ERROR_BODY_RESERVED = new Set(['success', 'code', 'error', 'stack', 'detail', 'publicErrorContext']);
  // Task 1215 (Snyk295/301): explicit public-error contract. A string's type says nothing about whether it is an
  // exception message, so the public `error` text is CODE-OWNED. Without a publicErrorContext it is one of:
  //   - a PUBLIC_ERROR_TEXTS member, i.e. the daemon-authored texts the admitted callers pass: route literals,
  //     deliverInjectionToSession / writeDataToSession / requestSshWrite / protectedInputFailure / getInjectFailure
  //     results, and applySessionStateReport results;
  //   - SSH_SUBMIT_UNCONFIRMED_PREFIX plus a catalog member;
  //   - a SURFACE_MODAL refusal text, derived from the authoritative MODAL_HINT_BY_CLI.
  // A text with numbers is never parsed back out of a string. Its caller passes a publicErrorContext, and
  // PUBLIC_ERROR_CONTEXT_FORMATS validates that context and renders the text.
  // Any other string (an exception message included) and any non-string become GENERIC_PUBLIC_ERROR. null and
  // undefined stay as they are. A new public text must be added here, or it is answered generically.
  const GENERIC_PUBLIC_ERROR = 'Internal error';
  const PUBLIC_ERROR_TEXTS = Object.freeze([
    'Another approved write claimed the submit barrier; retry with this unspent approval.',
    'Approval must remain valid through the deferred submit.',
    'Approved owner write could not be confirmed; approval cannot be reused.',
    'Cooperative handoff fences terminal writes.',
    'Delivery endpoint is missing.',
    'Delivery failed; see daemon log.',
    'Delivery outcome unknown after an attempt; automatic retry disabled. Do not retry blindly.',
    'Delivery outcome unknown after enqueue; no direct retry was attempted.',
    'Delivery was not confirmed before the caller deadline; outcome unknown and automatic retry disabled. Do not retry blindly.',
    'Delivery was refused before text was written.',
    'Earlier submits did not clear; no approved text was written.',
    'HTTP attempt could not be durably fenced; nothing written.',
    'HTTP delivery response unavailable after an attempt; do not retry blindly.',
    'Invalid claimed return locator',
    'Kill requires the current session credential.',
    'Mailbox enqueue failed.',
    'Mailbox sessions accept queued text only.',
    'No current-child write receipt; input may have been written. Do not retry blindly.',
    'Observation tracking capacity is not available; no task bytes were delivered.',
    'Observation tracking could not be persisted; no task bytes were delivered.',
    'Original task retained pending measured composer readiness.',
    'Owned delete requires the current session credential.',
    'PTY input channel failed.',
    'PTY process is not connected.',
    'Peer-lane fan-out blocked: broadcast/multicast is operator-only. Use bin/ask.sh for peer→peer.',
    'Peer-lane inject blocked: not a sanctioned ask-request/ask-reply envelope. Use bin/ask.sh.',
    'Pending text was withdrawn before delivery; nothing was written.',
    'Protected SSH inject requires a bound SSH write receipt adapter.',
    'Protected inject cannot be parked or retained for later delivery.',
    'Protected inject requires a clear surface and empty bootstrap queue.',
    'SSH bridge disconnected.',
    'SSH bridge refused input; no bytes were written or queued.',
    'SSH bridge send failed.',
    'SSH child write was not confirmed. Do not retry blindly.',
    'SSH delivery could not be confirmed; input may have been written. Do not retry blindly.',
    'SSH input exceeds 256 KiB.',
    'SSH remote composer is not ready for this write; nothing was queued. Resolve authentication/bootstrap locally or wait for qualified readiness.',
    'Session is closing',
    'Session is stale and awaiting cleanup.',
    'Session not found',
    'Session output pipe is dead: the owner is connected but has returned no output since the last delivery.',
    'Session owner disconnected.',
    'Session owner is disconnected.',
    'Session store write failed',
    'Session was destroyed or replaced while this write was pending; it was not written.',
    'Signed inject currently supports wrapped sessions only.',
    'Signed inject requires the enrolled target policy.',
    'Target session epoch differs',
    'This protected session requires an external signature through the supported inject ingress.',
    'Too many pending SSH writes.',
    'UDS attempt could not be durably fenced; nothing written.',
    'UDS delivery timed out.',
    'UDS endpoint is unreachable.',
    'UDS endpoint reported an error after the write attempt.',
    'UDS response did not confirm endpoint acceptance; do not retry blindly.',
    'UDS response exceeded 65536 bytes; delivery outcome is uncertain.',
    'UDS response failed after a write attempt; delivery outcome unknown.',
    'UDS write outcome unknown; do not retry blindly.',
    'needs_input must be a boolean',
    'phase is required',
    'prompt is required',
    'seq must be a non-negative integer',
    'state report payload must be a JSON object',
  ]);
  // Code-owned formatters for the public texts that carry numbers. Each kind is tied to the one code its real
  // callers use:
  //   - http_status: session-delivery writeDataToSession, aterm HTTP endpoint;
  //   - submit_timeout: session-delivery queueTimeoutRefusal;
  //   - fanout_limit: fanout multicast/broadcast cap.
  // A context must be a plain object with exactly the kind's keys, and its fields must be real Numbers (no string
  // coercion). Integers stay integers. Operator-configured caps/timeouts stay finite positive Numbers and may be
  // fractional. They render with the same `${n}` the callers used.
  const PUBLIC_ERROR_CONTEXT_FORMATS = Object.freeze({
    http_status: Object.freeze({ code: 'DELIVERY_UNCERTAIN', keys: ['kind', 'status'],
      valid: c => typeof c.status === 'number' && Number.isInteger(c.status) && c.status >= 100 && c.status <= 599,
      format: c => `HTTP endpoint returned ${c.status} after an attempt; do not retry blindly.` }),
    submit_timeout: Object.freeze({ code: 'QUEUE_TIMEOUT', keys: ['kind', 'timeoutMs'],
      valid: c => typeof c.timeoutMs === 'number' && Number.isFinite(c.timeoutMs) && c.timeoutMs > 0,
      format: c => `Earlier submits on this session did not clear within ${c.timeoutMs} ms; nothing was written. Retry.` }),
    fanout_limit: Object.freeze({ code: 'FANOUT_TARGET_CAP', keys: ['kind', 'operation', 'requested', 'cap'],
      valid: c => (c.operation === 'multicast' || c.operation === 'broadcast')
        && typeof c.requested === 'number' && Number.isSafeInteger(c.requested) && c.requested >= 0
        && typeof c.cap === 'number' && Number.isFinite(c.cap) && c.cap > 0,
      format: c => `${c.operation === 'broadcast' ? 'broadcast' : 'multicast'} target count ${c.requested} exceeds cap ${c.cap}` }),
  });
  // Returns { text, context } for a valid context, else null. `context` is a frozen copy holding only the kind's keys.
  function publicErrorContextText(code, publicErrorContext) {
    const ctx = publicErrorContext;
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return null;
    const proto = Object.getPrototypeOf(ctx);
    if (proto !== Object.prototype && proto !== null) return null;
    if (typeof ctx.kind !== 'string' || !Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_CONTEXT_FORMATS, ctx.kind)) return null;
    const spec = PUBLIC_ERROR_CONTEXT_FORMATS[ctx.kind];
    if (code !== spec.code) return null;
    const keys = Object.keys(ctx);
    if (keys.length !== spec.keys.length || !spec.keys.every(key => keys.includes(key))) return null;
    const context = Object.freeze(Object.fromEntries(spec.keys.map(key => [key, ctx[key]])));
    return spec.valid(context) ? { text: spec.format(context), context } : null;
  }
  const SSH_SUBMIT_UNCONFIRMED_PREFIX = 'Text was written to the SSH child, but submit was not confirmed. Do not retry blindly. ';
  function publicErrorText(error) {
    // Absent stays absent, as literal constants: JSON null stays null, undefined stays an omitted key.
    if (error === null) return null;
    if (error === undefined) return undefined;
    if (typeof error !== 'string') return GENERIC_PUBLIC_ERROR;
    // Frozen-catalog lookup (63 entries): the input is used only for `===`; the catalog entry is returned.
    for (const entry of PUBLIC_ERROR_TEXTS) if (entry === error) return entry;
    if (error.startsWith(SSH_SUBMIT_UNCONFIRMED_PREFIX)) {
      const cause = error.slice(SSH_SUBMIT_UNCONFIRMED_PREFIX.length);
      for (const entry of PUBLIC_ERROR_TEXTS) if (entry === cause) return SSH_SUBMIT_UNCONFIRMED_PREFIX + entry;
      return GENERIC_PUBLIC_ERROR;
    }
    // SURFACE_MODAL refusal texts are modalRejectionResponse's own output. The CLI is one of MODAL_HINT_BY_CLI's
    // keys (codex/claude), because isSurfaceBlockedByModal is true only for a SURFACE_MODAL_RULES CLI, and the
    // reason is modalDeliveryDecision's `${cli}_modal_ui`. They are derived at call time: MODAL_HINT_BY_CLI is a
    // daemon const declared after this runtime is created. The input is used only for `===`; the locally built
    // text is returned.
    for (const [cli, hint] of Object.entries(shared.MODAL_HINT_BY_CLI || {})) {
      const text = modalRejectionResponse({ reason: `${cli}_modal_ui`, hint }).error;
      if (text === error) return text;
    }
    return GENERIC_PUBLIC_ERROR;
  }
  // `publicErrorContext` (optional) selects a numeric formatter. If it is given, `error` is ignored and an invalid
  // context gives GENERIC_PUBLIC_ERROR. The validated copy rides on the body as a NON-ENUMERABLE property:
  //   - an internal delivery result can carry it to the route (session-actions inject);
  //   - JSON never serializes it;
  //   - an object spread that overrides `error` (session-delivery mailbox arms) does not inherit it.
  function buildErrorBody(code, error, extra = {}, publicErrorContext) {
    const safeExtra = {};
    if (extra && typeof extra === 'object' && !(extra instanceof Error)) {
      for (const [key, value] of Object.entries(extra)) {
        if (!ERROR_BODY_RESERVED.has(key) && !(value instanceof Error)) safeExtra[key] = value;
      }
    }
    const contextual = publicErrorContext === undefined ? null : publicErrorContextText(code, publicErrorContext);
    const publicError = publicErrorContext === undefined ? publicErrorText(error)
      : (contextual ? contextual.text : GENERIC_PUBLIC_ERROR);
    const body = { success: false, code, error: publicError, ...safeExtra };
    if (contextual) Object.defineProperty(body, 'publicErrorContext', { value: contextual.context, enumerable: false });
    return body;
  }

  function respondWithError(res, httpStatus, code, error, extra = {}, publicErrorContext) {
    return res.status(httpStatus).json(buildErrorBody(code, error, extra, publicErrorContext));
  }

  function classifyPeerLaneInject({ from, to, prompt, orchestratorSids } = {}) {
    const orchSet = Array.isArray(orchestratorSids) ? orchestratorSids : [];
    // Fail-OPEN: with no known orchestrator sid we cannot tell the orch lane apart
    // from the peer lane (every inject would look peer-lane), which would over-block
    // legitimate orchestrator traffic and brick the mesh. Degrade to allow + warn;
    // the Phase-1 orchestrator-side auditor still detects raw bypass (defense in depth).
    if (orchSet.length === 0) {
      return { lane: 'disabled', decision: 'allow', reason: 'orch-sid-unconfigured-fail-open', kind: null, envelopePresent: false };
    }
    // No sender → operator/CLI/multicast/broadcast, never peer-lane.
    if (!from) {
      return { lane: 'orchestrator', decision: 'allow', reason: 'no-sender', kind: null, envelopePresent: false };
    }
    // Orchestrator lane (either end is the orchestrator) → always allowed, untouched.
    if (orchSet.includes(from) || orchSet.includes(to)) {
      return { lane: 'orchestrator', decision: 'allow', reason: 'orch-lane', kind: null, envelopePresent: false };
    }

    // Peer lane: require a sanctioned envelope on the first non-empty line.
    let env = null;
    try {
      const firstLine = String(prompt || '').split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0);
      if (firstLine) {
        const parsed = JSON.parse(firstLine);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) env = parsed;
      }
    } catch {
      env = null;
    }
    if (!env) {
      return { lane: 'peer', decision: 'block', reason: 'malformed-envelope', kind: null, envelopePresent: false };
    }
    if (!shared.PEER_INJECT_KINDS.has(env.kind)) {
      return { lane: 'peer', decision: 'block', reason: 'wrong-kind', kind: null, envelopePresent: true };
    }
    // Common required fields + per-kind payload (matches ask.sh build_envelope).
    const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
    const baseOk = nonEmptyStr(env.from) && nonEmptyStr(env.to) && nonEmptyStr(env.thread_id) && Number.isInteger(env.round);
    const payloadOk = env.kind === 'ask-request' ? nonEmptyStr(env.question) : nonEmptyStr(env.answer);
    if (!baseOk || !payloadOk) {
      return { lane: 'peer', decision: 'block', reason: 'invalid-field', kind: null, envelopePresent: true };
    }
    // Sender-consistency: the envelope's declared sender must match the inject's
    // from (cheap anti-spoof). `to` is NOT cross-checked — the route resolves aliases,
    // which would false-block legitimate aliased targets.
    if (env.from !== from) {
      return { lane: 'peer', decision: 'block', reason: 'from-mismatch', kind: null, envelopePresent: true };
    }
    return { lane: 'peer', decision: 'allow', reason: 'sanctioned-envelope', kind: env.kind, envelopePresent: true };
  }

  function getSessionDisconnectedMs(session, nowMs = Date.now()) {
    if (!session.lastDisconnectedAt) {
      return null;
    }

    return Math.max(0, nowMs - new Date(session.lastDisconnectedAt).getTime());
  }

  function armUpstreamProbe(session, nowMs = Date.now()) {
    if (!session || session.type !== 'wrapped') return;
    const watermark = session.outputRingTotalBytes || 0;
    // `!= null`, not falsiness: a probe armed at epoch 0 is a real probe.
    if (session.upstreamProbeAt != null && watermark <= (session.upstreamProbeWatermark || 0)) {
      return;
    }
    session.upstreamProbeAt = nowMs;
    session.upstreamProbeWatermark = watermark;
  }

  function isUpstreamStalled(session, nowMs = Date.now(), options = {}) {
    if (!session || session.type !== 'wrapped') return false;
    if (session.upstreamProbeAt == null) return false;
    if ((session.outputRingTotalBytes || 0) > (session.upstreamProbeWatermark || 0)) return false;
    const stallMs = (options.stallSeconds ?? shared.UPSTREAM_STALL_SECONDS) * 1000;
    return nowMs - session.upstreamProbeAt >= stallMs;
  }

  function getSessionHealthStatus(session, options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    const staleMs = (options.staleSeconds ?? shared.SESSION_STALE_SECONDS) * 1000;
    const disconnectedMs = getSessionDisconnectedMs(session, nowMs);

    if (session.type === 'mailbox') return mailboxLeaseAlive(session, nowMs) ? 'CONNECTED' : 'DISCONNECTED';

    if (session.type === 'wrapped') {
      if (shared.isOpenWebSocket(session.ownerWs)) {
        // #732: an open owner socket is necessary, not sufficient. A session that has
        // returned nothing since we last wrote to it is unobservable, not healthy.
        return isUpstreamStalled(session, nowMs, options) ? 'UPSTREAM_STALLED' : 'CONNECTED';
      }
      if (disconnectedMs !== null && disconnectedMs >= staleMs) {
        return 'STALE';
      }
      return 'DISCONNECTED';
    }

    if (session.type === 'aterm') {
      const endpoint = session.deliveryEndpoint || (session.delivery && session.delivery.address);
      if (endpoint) {
        const isSocketPath = endpoint.startsWith('/');
        if (isSocketPath) {
          try {
            const stat = shared.fs.statSync(endpoint);
            return stat.isSocket() ? 'CONNECTED' : 'DISCONNECTED';
          } catch {
            return 'DISCONNECTED';
          }
        }
        return 'CONNECTED';
      }
      if (disconnectedMs !== null && disconnectedMs >= staleMs) {
        return 'STALE';
      }
      return 'DISCONNECTED';
    }

    if (ptyInputFailure(session)) return 'DISCONNECTED';   // #1215 pipe200: input unavailable, not an observed exit
    return session.ptyProcess && !session.ptyProcess.killed ? 'CONNECTED' : 'DISCONNECTED';
  }

  function getSessionHealthReason(session, healthStatus) {
    if (session.type === 'mailbox') return healthStatus === 'CONNECTED' ? 'MAILBOX_LEASE_VALID' : 'MAILBOX_LEASE_EXPIRED';
    if (session.type === 'wrapped') {
      if (healthStatus === 'CONNECTED') return 'OWNER_CONNECTED';
      // #732: the owner socket is open and answering pings; the output pipe behind it is not.
      if (healthStatus === 'UPSTREAM_STALLED') return 'OWNER_CONNECTED_UPSTREAM_STALLED';
      if (healthStatus === 'STALE') return 'OWNER_DISCONNECTED_STALE';
      return 'OWNER_DISCONNECTED';
    }

    if (session.type === 'aterm') {
      if (healthStatus === 'CONNECTED') return 'DELIVERY_ENDPOINT_AVAILABLE';
      if (healthStatus === 'STALE') return 'DELIVERY_ENDPOINT_STALE';
      return 'DELIVERY_ENDPOINT_MISSING';
    }

    if (ptyInputFailure(session)) return 'PTY_INPUT_FAILED';   // #1215 pipe200: never PTY_EXITED for a live process
    return session.ptyProcess && !session.ptyProcess.killed ? 'PTY_RUNNING' : 'PTY_EXITED';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Task 1215 F2: a negotiated owner (input-transport-ready-v1) that has not completed its
  // handshake is not ready, for EVERY role; legacy owners keep the pre-handshake rule.
  function isBootstrapReady(session) {
    return (!shared.isBootstrapGatedSession(session) || session.bootstrapReady === true)
      && !readinessHandshake.awaitingInputTransport(session);
  }

  function buildBootstrapBlock(session) {
    return {
      gated: shared.isBootstrapGatedSession(session),
      ready: isBootstrapReady(session),
      ready_at: session.bootstrapReadyAt || null,
      reason: session.bootstrapReadyReason || null,
      queued: Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0,
      draining: session.bootstrapDraining === true
    };
  }

  function shouldQueueBootstrapOperation(session) {
    return (shared.isBootstrapGatedSession(session) || readinessHandshake.awaitingInputTransport(session)) && !isBootstrapReady(session);
  }

  function hasBootstrapBacklog(session) {
    return !!(session && Array.isArray(session.bootstrapQueue) && session.bootstrapQueue.length > 0);
  }

  function emitBootstrapEvent(eventType, sessionId, session, extra = {}) {
    broadcastSessionEvent(eventType, sessionId, session, {
      extra: {
        bootstrap: buildBootstrapBlock(session),
        ...extra
      }
    });
  }

  function enqueueBootstrapOperation(sessionId, session, operation) {
    shared.initializeBootstrapState(session);
    const op = {
      op_id: shared.crypto.randomUUID(),
      queued_at: new Date().toISOString(),
      ...operation
    };

    if (op.type === 'submit') {
      op.promise = new Promise((resolve) => {
        op.resolve = resolve;
      });
    }

    session.bootstrapQueue.push(op);
    emitBootstrapEvent('bootstrap_queue_queued', sessionId, session, {
      op_id: op.op_id,
      operation: op.type,
      depth: session.bootstrapQueue.length
    });
    scheduleBootstrapPromptPoll(sessionId, session);
    armInputTransportTimeout(sessionId, session);
    return op;
  }

  function resolveBootstrapSubmit(op, result) {
    if (op && typeof op.resolve === 'function') {
      op.resolve(result);
      op.resolve = null;
    }
  }

  function bootstrapQueuedResponse(op, extra = {}) {
    return {
      success: true,
      strategy: 'bootstrap_queue',
      queued: true,
      bootstrap_queued: true,
      bootstrap_op_id: op.op_id,
      ...extra
    };
  }

  async function executeBootstrapInject(sessionId, session, op) {
    const prompt = typeof op.prompt === 'string' ? op.prompt : '';
    // #760: this is the ONLY inject path that wrote the body un-enveloped — the mailbox path
    // has wrapped it since #716/#730, and #730 measured that the un-enveloped MULTI-LINE shape
    // is exactly what swallows the following CR (still 1/7 at a 127ms gap; the envelope was
    // 0/9). Harmless while this queue only carried boot-time injects; load-bearing now that a
    // modal park routes worker REPORTs — multi-line by definition — through it. Fixed here
    // rather than in the park branch so the boot caller stops rolling the same dice.
    const body = maybeBracketedPaste(prompt, session);
    // Task 1215: deliveries that waited for the transport handshake keep their frame ids, so the
    // bridge can receipt them and can refuse a submit whose body it never wrote (pair).
    const bodyMeta = { daemon_msg_id: `bootstrap:${op.op_id}`, inject_id: op.injectId || op.pairInjectId || null, part: 'body' };
    const textResult = await shared.writeDataToSession(sessionId, session, body, { frameMeta: bodyMeta });
    // #860 F2 — a failure here is reported back with the byte count that actually landed, because
    // the caller records it in the ledger. The two arms differ: nothing was written when the BODY
    // was refused, but the body is on the surface by the time the submit CR can fail, and an abort
    // that stamped `bytes_written: 0` on that one would be the same defect it exists to close.
    if (!textResult.success) return { ...textResult, bytes_written: 0 };
    // Task 1215 hotfix 0.10.1: a later immediate /submit for this inject names this body as its pair.
    if (op.noEnter && session.type === 'wrapped') rememberSubmitPair(session, op.injectId || op.pairInjectId, bodyMeta.daemon_msg_id);

    if (!op.noEnter) {
      await sleep(shared.WRAPPED_SUBMIT_DELAY_MS);
      const submitResult = await shared.writeDataToSession(sessionId, session, '\r',
        { frameMeta: { daemon_msg_id: `${bodyMeta.daemon_msg_id}:submit`, inject_id: bodyMeta.inject_id, part: 'submit', pair: bodyMeta.daemon_msg_id } });
      if (!submitResult.success) return { ...submitResult, bytes_written: Buffer.byteLength(body) };
    }

    session.lastActivityAt = new Date().toISOString();
    return {
      success: true,
      strategy: 'bootstrap_direct',
      submit: op.noEnter ? 'skipped' : 'sent'
    };
  }

  function parseSubmitRetryOptions(body = {}, injectedBody = null) {
    const hasExplicitRetries = body && body.retries !== undefined && body.retries !== null;
    // #568: raise the retry-budget ceiling so a momentarily-busy CLI still gets a
    // render-gated CR before we return 504 (each retry re-gates on input-ready, so
    // more attempts = more quiet-window chances to land). Ceilings only — the
    // default stays 1 for the injected case (behavior-preserving common path);
    // heavier callers opt into the bigger budget via retries/retry_delay_ms/
    // verify_timeout_ms. Total worst-case budget stays bounded (~10 attempts).
    const retries = Math.min(Math.max(Number(hasExplicitRetries ? body.retries : (injectedBody ? 1 : 0)) || 0, 0), 10);
    const retryDelayMs = Math.min(Math.max(Number(body?.retry_delay_ms) || 500, 100), 3000);
    const verifyTimeoutMs = Math.min(Math.max(Number(body?.verify_timeout_ms) || 1500, 200), 8000);
    return { retries, retryDelayMs, verifyTimeoutMs };
  }

  function buildSubmitVerify(confirm) {
    if (!confirm) return null;
    return {
      consumed: confirm.accepted === true,
      waited_ms: confirm.waited_ms || 0,
      reason: confirm.reason || null,
      source: confirm.visibility && confirm.visibility.source ? confirm.visibility.source : undefined,
      ambiguous: confirm.ambiguous === true || undefined,
      retryable: confirm.retryable === true || undefined,
    };
  }

  function buildSubmitConfirmOptions(id, session, submittedAtMs, verifyTimeoutMs) {
    return {
      timeoutMs: verifyTimeoutMs,
      intervalMs: 50,
      submittedAtMs,
      stripAnsi: shared.stripAnsiState,
      getState: () => shared.sessionStateManager.getState(id),
    };
  }

  async function confirmSubmitAfterDispatch(id, session, injectedBody, submittedAtMs, verifyTimeoutMs) {
    if (!injectedBody || injectedBody.length === 0) {
      return null;
    }
    return shared.submitGate.confirmSubmitAccepted(session, injectedBody, buildSubmitConfirmOptions(id, session, submittedAtMs, verifyTimeoutMs));
  }

  async function gatedTerminalSubmit(id, session, injectedBody, settleEnabled, options) {
    if (injectedBody && injectedBody.length > 0 && settleEnabled !== false) {
      const settle = await shared.submitGate.awaitInputSettled(session, injectedBody, {
        timeoutMs: 1200,
        quietWindowMs: 100,
        echoGraceMs: 400,
        pollIntervalMs: 30,
        stripAnsi: shared.stripAnsiState,
      });
      if (!settle.ready) {
        console.log(`[SUBMIT] input-settle gate timed out for ${id} (${settle.waited_ms}ms, echoed=${settle.echoed}) — sending CR best-effort`);
      }
    }
    return terminalLevelSubmit(id, session, options);
  }

  async function executeBootstrapSubmit(sessionId, session, op) {
    const body = op.body || {};
    const injectedBody = typeof body.injected_body === 'string' ? body.injected_body : null;
    const { retries, retryDelayMs, verifyTimeoutMs } = parseSubmitRetryOptions(body, injectedBody);
    if (injectedBody) {
      markPendingReportSubmitStarted(sessionId, injectedBody);
    }

    const settleEnabled = body.input_settle_gate !== false;
    // Task 1215 submit286: a parked /submit keeps its optional inject_id (op.body is its req.body).
    const submitOptions = validInjectId(body.inject_id) ? { injectId: body.inject_id } : undefined;
    // Task 1215 hotfix 0.10.1: a queued/parked submit for an immediate-submit bridge is ONE CR when it drains, with no
    // settle wait and no confirm retry. Capability and owner generation are re-read here, at the write.
    // hotfix480 F2: an op the /submit route admitted as immediate is PINNED (op.immediateGeneration = that generation).
    // It is refused before effects if the owner, generation or capability changed; it never falls to the legacy retry
    // branch. Unpinned ops (admitted legacy, other callers) keep the re-read.
    const pinned = typeof op.immediateGeneration === 'string';
    if (pinned || immediateSubmitSupport(session) === 'supported') {
      const attempt = await immediateSubmitAttempt(session, { injectId: submitOptions ? submitOptions.injectId : null,
        generation: pinned ? op.immediateGeneration : session.interactionOwnerGeneration,
        timeoutMs: Math.min(Math.max(Number(body.gate_timeout_ms) || 10000, 500), 30000),
        isCurrent: () => shared.sessions[sessionId] === session,
        // No effect after the caller's timeout declared this op unwritten; the flag records that an effect started.
        beforeEffect: () => (op.cancelled ? false : (op.effectStarted = true)),
        // hotfix492 N2: a modal that came up during the custody wait refuses this drained CR (not_written, its reason).
        modalCheck: () => { const decision = modalDeliveryDecision(session); return decision.action === 'deliver' ? null : decision; },
        submit: options => terminalLevelSubmit(sessionId, session, options) });
      const immediateStrategy = attempt.strategy;
      if (injectedBody) {
        markPendingReportSubmitUnconfirmed(sessionId, immediateStrategy
          ? { reason: 'consumption_unknown', attempts: 1, retryable: false }
          : { reason: 'strategy_failed', attempts: 0, retryable: false });
      }
      return immediateSubmitOutcome(immediateStrategy, { bootstrap_queued: true, ...immediateAttemptFields(attempt) });
    }
    let strategy = await gatedTerminalSubmit(sessionId, session, injectedBody, settleEnabled, submitOptions);
    const submittedAtMs = Date.now();
    if (!strategy) {
      if (injectedBody) {
        markPendingReportSubmitUnconfirmed(sessionId, { reason: 'strategy_failed', attempts: 0, retryable: false });
      }
      return {
        status: 503,
        body: {
          error: 'Submit failed via all strategies (kitty/cmux/pty)',
          strategy: 'none',
          attempts: 0,
          gated: false,
          bootstrap_queued: true
        }
      };
    }
    let attempts = 1;
    let confirm = await confirmSubmitAfterDispatch(sessionId, session, injectedBody, submittedAtMs, verifyTimeoutMs);
    while (confirm && !confirm.accepted && confirm.retryable && attempts <= retries) {
      await sleep(retryDelayMs);
      const retryStrategy = await gatedTerminalSubmit(sessionId, session, injectedBody, settleEnabled, submitOptions);
      const retrySubmittedAtMs = Date.now();
      if (!retryStrategy) break;
      strategy = retryStrategy;
      attempts++;
      confirm = await confirmSubmitAfterDispatch(sessionId, session, injectedBody, retrySubmittedAtMs, verifyTimeoutMs);
    }

    if (confirm && !confirm.accepted) {
      markPendingReportSubmitUnconfirmed(sessionId, { ...confirm, attempts });
      return {
        status: 504,
        body: {
          error: 'Submit body still visible after bounded confirmation retry',
          reason: 'submit_unconfirmed',
          strategy,
          attempts,
          gated: false,
          verify: buildSubmitVerify(confirm),
          confirm,
          bootstrap_queued: true
        }
      };
    }

    if (injectedBody) {
      markPendingReportSubmitConfirmed(sessionId, { ...(confirm || { reason: 'empty_body' }), attempts });
    }
    return {
      status: 200,
      body: {
        success: true,
        strategy,
        attempts,
        gated: false,
        verify: buildSubmitVerify(confirm),
        confirm,
        bootstrap_queued: true
      }
    };
  }

  async function drainBootstrapQueue(sessionId, session) {
    if (hasHeldInteraction(session)) return null;
    if (!session || session.bootstrapDraining) {
      return session ? session.bootstrapDrainPromise : null;
    }
    if (!isBootstrapReady(session)) {
      return null;
    }

    session.bootstrapDraining = true;
    session.bootstrapDrainPromise = (async () => {
      while (hasBootstrapBacklog(session)) {
        if (hasHeldInteraction(session)) break;
        // #760: the drain writes straight to the surface (executeBootstrapInject /
        // executeBootstrapSubmit), so it has to ask the modal gate itself — markBootstrapReady
        // reaches it without ever consulting one. Checked BEFORE the shift so the op stays
        // parked rather than being consumed into a modal, and re-armed so the park poll picks
        // it up again. Also covers a modal that appears part-way through a drain.
        //
        // Asked through modalDeliveryDecision, not the raw predicate, so that
        // TELEPTY_MODAL_REMEDY=off stays a COMPLETE rollback: with the gate off the drain
        // writes into the modal exactly as it did before this change.
        if (modalDeliveryDecision(session).action !== 'deliver') {
          scheduleModalParkDrain(sessionId, session);
          break;
        }
        const op = session.bootstrapQueue.shift();
        try {
          if (op.cancelled) {
            continue;
          }
          if (op.type === 'inject') {
            const result = await executeBootstrapInject(sessionId, session, op);
            if (!result.success) {
              // #860 F2 — durably; #1207 (measured) durably FIRST: this is a TERMINAL outcome for a
              // dispatch whose record has said `tracked` since the route accepted it, and the push-only
              // event below must not state it before the record does. The event carries the
              // persistence outcome it is based on.
              const tracking = await settleTerminalOutcome(op, sessionId, result.code || 'DELIVERY_FAILED', result.error, {
                trigger: 'bootstrap_queue_failed',
                // Linux: a delivery whose outcome is unknown is recorded as such, never as zero bytes.
                ...(result.delivery_uncertain ? { kind: 'inject_delivery_unknown' } : {}),
                bytesWritten: result.delivery_uncertain ? null : result.bytes_written,
              });
              emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
                op_id: op.op_id,
                operation: op.type,
                code: result.code || 'DELIVERY_FAILED',
                error: result.error || 'bootstrap delivery failed',
                tracking
              });
            }
          } else if (op.type === 'submit') {
            const result = await executeBootstrapSubmit(sessionId, session, op);
            resolveBootstrapSubmit(op, result);
            if (result.status >= 400) {
              emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
                op_id: op.op_id,
                operation: op.type,
                code: result.body.code || 'SUBMIT_FAILED',
                error: result.body.error || 'bootstrap submit failed'
              });
            }
          }
        } catch (error) {
          if (op.type === 'submit') {
            resolveBootstrapSubmit(op, {
              status: 500,
              body: {
                // Task 1215: this body is the /submit HTTP response (waitForBootstrapSubmit); stable public text only.
                error: 'bootstrap submit failed',
                strategy: 'none',
                attempts: 0,
                gated: false,
                bootstrap_queued: true
              }
            });
          }
          // #860 F2 — the same terminal outcome as the arm above, reached by a throw. `bytesWritten:
          // null` because a throw can land on either side of the body write, and this is the one
          // path that cannot say which. #1207 (measured): awaited before the event, as above.
          // Task 1215: the ledger delivery_error and the event below carry the stable text, never the exception message.
          const tracking = await settleTerminalOutcome(op, sessionId, 'BOOTSTRAP_DRAIN_FAILED', 'bootstrap drain failed', {
            trigger: 'bootstrap_drain_failed',
            bytesWritten: null,
          });
          emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
            op_id: op.op_id,
            operation: op.type,
            code: 'BOOTSTRAP_DRAIN_FAILED',
            error: 'bootstrap drain failed',
            tracking
          });
        }
      }

      emitBootstrapEvent('bootstrap_queue_drained', sessionId, session);
    })().finally(() => {
      session.bootstrapDraining = false;
      session.bootstrapDrainPromise = null;
    });

    return session.bootstrapDrainPromise;
  }

  // Task 1215 F2: an owner that negotiated the handshake never waits on a timer: if its
  // input_transport_ready does not arrive, its queued deliveries fail explicitly (never a blind write).
  function armInputTransportTimeout(sessionId, session) {
    if (!readinessHandshake.awaitingInputTransport(session) || session.inputTransportTimer) return;
    const generation = session.interactionOwnerGeneration;
    session.inputTransportTimer = setTimeout(() => {
      session.inputTransportTimer = null;
      if (session.interactionOwnerGeneration !== generation || !readinessHandshake.awaitingInputTransport(session)
          || !hasBootstrapBacklog(session)) return;
      failBootstrapQueueOnTimeout(sessionId, session, { reason: 'input_transport_ready_timeout' });
    }, shared.BOOTSTRAP_READY_TIMEOUT_MS);
    if (session.inputTransportTimer && typeof session.inputTransportTimer.unref === 'function') session.inputTransportTimer.unref();
  }

  function markBootstrapReady(sessionId, session, reason) {
    if (!session) return false;
    shared.initializeBootstrapState(session);
    // Task 1215 F2: for a negotiated owner, spawn readiness is its authenticated transport handshake
    // alone — a screen `ready` frame, prompt-symbol poll, owner-alive floor or restore never
    // releases it, for any role. Legacy owners are unchanged.
    if (readinessHandshake.negotiated(session) && (reason !== 'input_transport_ready' || !readinessHandshake.inputTransportReady(session))) return false;
    if (!shared.isBootstrapGatedSession(session)) {
      // Task 1215: a user-supervised owner (or any non-gated negotiated owner) is admitted by owner
      // + live transport. Anything parked before then drains now, FIFO, through the ordered drain.
      if ((inputPolicies.userSupervised(session) || reason === 'input_transport_ready') && hasBootstrapBacklog(session)) drainBootstrapQueue(sessionId, session);
      return false;
    }
    if (session.bootstrapReady === true) {
      // A new owner generation's handshake releases what queued while it was pending.
      if (reason === 'input_transport_ready' && hasBootstrapBacklog(session)) drainBootstrapQueue(sessionId, session);
      return false;
    }

    session.bootstrapReady = true;
    session.bootstrapReadyAt = new Date().toISOString();
    session.bootstrapReadyReason = reason || 'ready';
    session.ready = true;
    emitBootstrapEvent('bootstrap_ready', sessionId, session, { reason: session.bootstrapReadyReason });
    drainBootstrapQueue(sessionId, session);
    return true;
  }

  // #1207 (measured): a drop is TERMINAL for its dispatch, so each op's persistence outcome is awaited
  // (FIFO, one at a time) BEFORE the per-op `bootstrap_queue_failed` event states it. The
  // session-level `bootstrap_ready_timeout` event stays first — it is the actionable cause, not a
  // terminal claim about any dispatch. The queue is emptied synchronously so nothing else drains the
  // same ops. Resolves to a summary and never rejects (timer callbacks cannot await it).
  async function failBootstrapQueueOnTimeout(sessionId, session, detail = {}) {
    const queued = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
    emitBootstrapEvent('bootstrap_ready_timeout', sessionId, session, {
      ...detail,
      actionable: true,
      queued_dropped: queued,
      hint: `Session '${sessionId}' did not become inject-ready within ${shared.BOOTSTRAP_READY_TIMEOUT_MS}ms — the target CLI (e.g. codex MCP init) may be hung. Inspect the surface and re-spawn if needed; queued injects were flushed.`
    });
    const tracking = [];
    if (queued === 0) return { queued_dropped: 0, tracking };
    const drained = session.bootstrapQueue.splice(0, queued);
    for (const op of drained) {
      if (op.type === 'submit') {
        resolveBootstrapSubmit(op, {
          status: 504,
          body: {
            error: `bootstrap_ready_timeout — '${sessionId}' not ready within ${shared.BOOTSTRAP_READY_TIMEOUT_MS}ms`,
            reason: detail.reason || 'bootstrap_ready_timeout',
            strategy: 'none',
            attempts: 0,
            gated: true,
            bootstrap_queued: false,
            bootstrap: buildBootstrapBlock(session)
          }
        });
      }
      // #860 F2 — DROPPED, not refused: this op was accepted, parked, and discarded without the
      // daemon ever attempting a write. Zero bytes is a measurement here, not an assumption.
      const outcome = await settleTerminalOutcome(op, sessionId, 'BOOTSTRAP_READY_TIMEOUT',
        `target '${sessionId}' not ready within ${shared.BOOTSTRAP_READY_TIMEOUT_MS}ms`,
        { kind: 'inject_delivery_dropped', trigger: 'bootstrap_ready_timeout' });
      tracking.push({ op_id: op.op_id, inject_id: op.injectId || null, outcome });
      emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
        op_id: op.op_id,
        operation: op.type,
        code: 'BOOTSTRAP_READY_TIMEOUT',
        error: `target '${sessionId}' not ready within ${shared.BOOTSTRAP_READY_TIMEOUT_MS}ms`,
        tracking: outcome
      });
    }
    return { queued_dropped: queued, tracking };
  }

  function shouldApplyOwnerAliveFloor(session, deps = {}) {
    const _isBootstrapReady = deps.isBootstrapReady || isBootstrapReady;
    const _isProcessRunning = deps.isProcessRunning || shared.isProcessRunning;
    const _isOpenWebSocket = deps.isOpenWebSocket || shared.isOpenWebSocket;
    if (_isBootstrapReady(session)) return false;          // bridge_ready already won
    const ownerPid = Number(session.ownerPid);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !_isProcessRunning(ownerPid)) return false;
    if (!_isOpenWebSocket(session.ownerWs)) return false;
    return true;
  }

  function scheduleBootstrapPromptPoll(sessionId, session, deps = {}) {
    const _setTimeout = deps.setTimeout || setTimeout;
    if (!session || !shared.isBootstrapGatedSession(session) || isBootstrapReady(session)) return;
    if (!shared.isOpenWebSocket(session.ownerWs)) return;
    // Task 1215 F2: a negotiated owner's spawn readiness is its handshake, not a screen poll or floor.
    if (readinessHandshake.negotiated(session)) return;

    // cmux: rendered-screen prompt poll (the cmux-only read-screen primitive). Unchanged,
    // including the #31 actionable bootstrap-timeout on miss/error.
    if (session.backend === 'cmux' && session.cmuxWorkspaceId) {
      if (session.bootstrapPromptPoll) return;
      session.bootstrapPromptPoll = shared.submitGate.awaitPromptSymbol(session, {
        timeoutMs: shared.BOOTSTRAP_READY_TIMEOUT_MS
      }).then((result) => {
        session.bootstrapPromptPoll = null;
        if (result && result.ready && shared.isOpenWebSocket(session.ownerWs)) {
          markBootstrapReady(sessionId, session, 'cmux_prompt_symbol');
        } else if (result && result.reason) {
          // #1207: the flush settles after its terminal outcomes; returned so the chain settles with it
          return failBootstrapQueueOnTimeout(sessionId, session, {
            reason: result.reason,
            waited_ms: result.waited_ms || 0
          });
        }
        return undefined;
      }).catch((error) => {
        session.bootstrapPromptPoll = null;
        return failBootstrapQueueOnTimeout(sessionId, session, {
          reason: 'prompt_symbol_error',
          // Task 1215: the bootstrap_ready_timeout event carries the stable reason text, never the exception message.
          error: 'prompt_symbol_error'
        });
      });
      return;
    }

    // #29: non-cmux (warp/pty/kitty) has NO rendered-screen read primitive, so the cmux poll
    // would early-return and bootstrapReady could stay false forever (inject queues forever on
    // Warp). The fast path stays the bridge 'ready' frame; this arms an idempotent owner-alive
    // optimistic FLOOR — byte-for-byte the shipped runStartupBootstrapRestore precedent
    // (markBootstrapReady('startup_owner_alive') ~daemon.js:2997) — applied at the LIVE owner
    // WS-connect path. markBootstrapReady is idempotent, so a late timer after bridge_ready is a
    // harmless no-op. submit-gate.js read-screen guard stays cmux-only (untouched).
    if (session.bootstrapOptimisticTimer) return;
    session.bootstrapOptimisticTimer = _setTimeout(() => {
      session.bootstrapOptimisticTimer = null;
      if (!shouldApplyOwnerAliveFloor(session, deps)) return;
      markBootstrapReady(sessionId, session, 'owner_alive');
      console.log(`[BOOTSTRAP] Optimistic ready for ${sessionId} (ownerPid=${Number(session.ownerPid)}, backend=${session.backend || 'unknown'})`);
    }, shared.BOOTSTRAP_READY_TIMEOUT_MS);
  }

  async function waitForBootstrapSubmit(op, session, timeoutMs) {
    const timeout = sleep(timeoutMs).then(() => {
      op.cancelled = true;
      return {
        status: 504,
        body: {
          error: 'Submit bootstrap-timeout — target CLI did not become ready',
          reason: 'bootstrap_not_ready',
          last_state: shared.sessionStateManager.getState(session.id)?.state || null,
          strategy: 'none',
          attempts: 0,
          gated: true,
          bootstrap_queued: true,
          bootstrap_op_id: op.op_id,
          bootstrap: buildBootstrapBlock(session)
        }
      };
    });
    return Promise.race([op.promise, timeout]);
  }

  function buildSessionTransportBlock(session, options = {}) {
    if (!session) {
      return null;
    }

    const nowMs = options.nowMs ?? Date.now();
    const idleSeconds = session.lastActivityAt ? Math.floor((nowMs - new Date(session.lastActivityAt).getTime()) / 1000) : null;
    const disconnectedMs = getSessionDisconnectedMs(session, nowMs);
    const healthStatus = getSessionHealthStatus(session, { nowMs });
    const healthReason = getSessionHealthReason(session, healthStatus);

    return {
      health_status: healthStatus,
      health_reason: healthReason,
      type: session.type || 'spawned',
      ...(session.type === 'mailbox' ? { lease_expires_at: session.leaseExpiresAt || null } : {}),
      backend: session.backend || 'kitty',
      terminal: getSessionTerminalLabel(session),
      active_clients: session.clients ? session.clients.size : 0,
      ready: session.ready || false,
      idle_seconds: idleSeconds,
      disconnected_seconds: disconnectedMs === null ? null : Math.floor(disconnectedMs / 1000),
      last_activity_at: session.lastActivityAt || null,
      last_connected_at: session.lastConnectedAt || null,
      last_disconnected_at: session.lastDisconnectedAt || null,
      last_inject_from: session.lastInjectFrom || null,
      last_reply_to: session.lastInjectReplyTo || null,
      last_thread_id: session.lastThreadId || null,
      // #732 upstream diagnosis. `upstream_silent_seconds` counts from the oldest delivery
      // that has not produced a single byte back. The bridge_* fields come from the bridge's
      // own heartbeat and split the two failure shapes apart: a heartbeat that keeps arriving
      // while `bridge_pty_bytes` is frozen means the PTY read side died inside the bridge; a
      // heartbeat that stopped means the bridge→daemon leg itself is gone.
      upstream_silent_seconds: session.upstreamProbeAt != null && (session.outputRingTotalBytes || 0) <= (session.upstreamProbeWatermark || 0)
        ? Math.floor((nowMs - session.upstreamProbeAt) / 1000)
        : null,
      upstream_bytes: session.outputRingTotalBytes || 0,
      bridge_heartbeat_at: session.bridgeHeartbeatAt || null,
      bridge_pty_bytes: session.bridgePtyBytes ?? null,
      bridge_read_side: session.bridgeReadSide || null,
      // #137: owner-reported bridge stage support and queue summary (current owner generation only).
      bridge_receipts: bridgeStage.bridgeReceiptSupport(session),
      bridge_queue: bridgeStage.bridgeQueueView(session),
      // Task 1215 hotfix 0.10.1: whether /submit takes the single-CR immediate path for the current owner generation.
      immediate_submit: immediateSubmitSupport(session),
      // Task 1215: effective recipient input policy (bound to the current owner generation).
      input_policy: inputPolicies.effectiveInputPolicy(session),
      input_policy_source: inputPolicies.userSupervised(session) ? session.inputPolicy.source : null,
      // Task 1215 F2: session spawn-readiness milestones (current owner handshake), never receipts.
      readiness: readinessHandshake.view(session),
      // Per-message receipt honesty: no provider acknowledges a specific message today.
      instruction_received: { status: 'unknown', reason: 'no_message_bound_provider_acknowledgement' },
      bootstrap: buildBootstrapBlock(session)
    };
  }

  function buildSessionSemanticBlock(session) {
    if (!session || !session.stateReport) {
      return null;
    }

    const report = session.stateReport;
    return {
      phase: report.phase,
      current_task: report.current_task,
      blocker: report.blocker,
      needs_input: report.needs_input,
      thread_id: report.thread_id,
      source: report.source,
      seq: report.seq
    };
  }

  function buildSessionEvent(eventType, sessionId, session, options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    const timestamp = options.timestamp || new Date(nowMs).toISOString();
    return {
      type: eventType,
      event_type: eventType,
      sender: options.sender || 'daemon',
      session_id: sessionId,
      timestamp,
      transport: options.includeTransport === false ? null : buildSessionTransportBlock(session, { nowMs }),
      semantic: options.includeSemantic === false ? null : buildSessionSemanticBlock(session),
      ...(options.extra || {})
    };
  }

  function broadcastSessionEvent(eventType, sessionId, session, options = {}) {
    const event = buildSessionEvent(eventType, sessionId, session, options);
    require('../transport/session-events').publishTrustedSessionEvent(session, sessionId, eventType, event);
    broadcastBusEvent(event);
    return event;
  }

  function getInjectFailure(session, options = {}) {
    if (session.isClosing) return { httpStatus: 409, code: 'SESSION_CLOSING', error: 'Session is closing' };
    const healthStatus = getSessionHealthStatus(session, options);
    if (healthStatus === 'STALE') {
      return { httpStatus: 410, code: 'STALE', error: 'Session is stale and awaiting cleanup.' };
    }
    if (healthStatus === 'DISCONNECTED') {
      return { httpStatus: 503, code: 'DISCONNECTED', error: 'Session owner is disconnected.' };
    }
    // #732: bytes would physically reach the PTY, but nothing the session produces can be
    // read back — every reply, echo and REPORT would be invisible. Reporting that as a plain
    // success is what kept the live incident undetected for ~9h, so fail it loudly instead.
    if (healthStatus === 'UPSTREAM_STALLED') {
      return {
        httpStatus: 503,
        code: 'UPSTREAM_STALLED',
        error: 'Session output pipe is dead: the owner is connected but has returned no output since the last delivery.'
      };
    }
    return null;
  }

  function markSessionDisconnected(session, timestamp = new Date().toISOString()) {
    Reflect.set(session, 'lastDisconnectedAt', timestamp);
    Reflect.set(session, 'ready', false);
  }

  function emitInjectFailureEvent(sessionId, code, error, extra = {}, session = null) {
    broadcastSessionEvent('inject_failed', sessionId, session, {
      extra: {
        target_agent: sessionId,
        code,
        error,
        ...extra
      }
    });
  }

  // Task 1215 submit286 — the optional inject_id a submit names rides on its CR frame only for a
  // well-formed id of a HOT committed record of this exact session, live record, epoch and owner
  // generation (recordBridgeReceipt's identity predicate; read-only, no reheat, no write). Anything
  // else is null and the CR goes out id-less as before; the receipt is re-checked when it arrives.
  function submitCorrelationId(id, session, injectId) {
    if (!validInjectId(injectId)) return null;
    const record = getTrackedInjection(injectId);
    if (!record || record.session_id !== id || shared.sessions[id] !== session
      || (record.owner_generation && record.owner_generation !== session.interactionOwnerGeneration)
      || (record.session_epoch && record.session_epoch !== (session.sessionEpoch || null))) return null;
    return injectId;
  }

  function terminalLevelSubmit(id, session, options) {
    if (session.isClosing) return null;
    if (protectedInputFailure(session)) return null;
    if (session.sshRemote) return null;
    if (hasHeldInteraction(session)) return null;
    const correlated = options && options.injectId ? submitCorrelationId(id, session, options.injectId) : null;
    // Task 1215 hotfix 0.10.1: an immediate CR also names its body (pair) when this daemon handed that body to the
    // CURRENT owner generation. The bridge then refuses it if that body went unwritten, and keys its single-CR guard on it.
    // A legacy call never passes `immediate`, so its frame is byte-identical to before.
    const pair = options && options.immediate === true ? submitPairFor(session, options.injectId) : null;
    // hotfix480 F3/F4: an immediate CR for a NAMED inject goes only with this generation's pair, never id-less.
    if (options && options.immediate === true && options.injectId && !pair) return null;
    const injectId = correlated || (pair ? options.injectId : null);
    if (submitViaPty(session, injectId || pair ? { injectId, pair } : undefined)) return 'pty_cr';
    return null;
  }

  function maybeBracketedPaste(text, session) {
    if (!text) return text;
    if (!session) return text;
    const capable = session.bracketedPasteCapable === undefined
      ? shared.readyRegistry.isPasteCapableCli(session.command)
      : session.bracketedPasteCapable;
    if (!capable) return text;
    return shared.BRACKETED_PASTE_START + text + shared.BRACKETED_PASTE_END;
  }

  function readOutputRingTail(session, maxBytes = shared.MODAL_RING_TAIL_BYTES) {
    if (!session || !Array.isArray(session.outputRing) || session.outputRing.length === 0) return '';
    let total = 0;
    const parts = [];
    for (let i = session.outputRing.length - 1; i >= 0 && total < maxBytes; i--) {
      parts.unshift(session.outputRing[i]);
      total += session.outputRing[i].length;
    }
    return parts.join('');
  }

  function isSurfaceBlockedByModal(session) {
    if (!session) return false;
    const tail = readOutputRingTail(session);
    if (!tail) return false;
    return shared.readyRegistry.detectSurfaceModal(session.command, tail).blocked === true;
  }

  function modalRemedy(env = process.env, session = null) {
    const raw = String(env.TELEPTY_MODAL_REMEDY ?? '').trim().toLowerCase();
    if (shared.MODAL_REMEDIES.has(raw)) return raw;
    const cli = session ? shared.readyRegistry.commandKey(session.command) : null;
    return shared.MODAL_REMEDY_BY_CLI[cli] || shared.MODAL_REMEDY_DEFAULT;
  }

  function modalDeliveryDecision(session, options = {}, env = process.env) {
    // Task 1215: the user supervises this surface; no rendered-screen modal classifier gates it.
    if (inputPolicies.userSupervised(session)) return { action: 'deliver', reason: 'user_supervised' };
    const remedy = modalRemedy(env, session);
    if (remedy === 'off') return { action: 'deliver', reason: 'modal_gate_off' };
    if (!isSurfaceBlockedByModal(session)) return { action: 'deliver', reason: 'surface_clear' };
    const cli = shared.readyRegistry.commandKey(session && session.command) || 'codex';
    return {
      action: remedy,
      reason: `${cli}_modal_ui`,
      path: options.force === true ? 'force' : 'gated',
      hint: shared.MODAL_HINT_BY_CLI[cli] || shared.MODAL_HINT_BY_CLI.codex,
    };
  }

  function modalHoldMs(env = process.env) {
    // An UNSET or blank var must fall back to the default, never to 0 — `Number('')` is 0,
    // so a bare `TELEPTY_MODAL_HOLD_MS=` in an env file would silently disable the hold.
    const raw = String(env.TELEPTY_MODAL_HOLD_MS ?? '').trim();
    if (!raw) return shared.MODAL_HOLD_DEFAULT_MS;
    const configured = Number(raw);
    return Number.isFinite(configured) && configured >= 0 ? configured : shared.MODAL_HOLD_DEFAULT_MS;
  }

  async function awaitSurfaceModalClear(session, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : modalHoldMs();
    const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : 150;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const sleepFn = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    const start = now();
    while (isSurfaceBlockedByModal(session)) {
      if (now() - start >= timeoutMs) return { cleared: false, waited_ms: now() - start };
      await sleepFn(pollIntervalMs);
    }
    return { cleared: true, waited_ms: now() - start };
  }

  async function resolveModalGate(id, session, options = {}, holdOpts = {}) {
    const decision = modalDeliveryDecision(session, options);
    if (decision.action === 'deliver') return null;
    if (decision.action !== 'hold') return decision;
    const held = await awaitSurfaceModalClear(session, holdOpts);
    if (held.cleared) {
      console.log(`[MODAL] ${id} surface cleared after ${held.waited_ms}ms — delivering`);
      return null;
    }
    console.log(`[MODAL] ${id} still modal after ${held.waited_ms}ms — refusing (hold timed out)`);
    return { ...decision, action: 'reject', held_ms: held.waited_ms };
  }

  function modalRejectionResponse(decision) {
    return {
      error: `${decision.reason} — delivery refused: ${decision.hint}`,
      reason: decision.reason,
      code: 'SURFACE_MODAL',
      hint: decision.hint,
    };
  }

  function modalParkTtlMs(env = process.env) {
    // An UNSET or blank var must fall back to the default, never to 0 — `Number('')` is 0, so
    // a bare `TELEPTY_MODAL_PARK_TTL_MS=` in an env file would silently disable the park.
    const raw = String(env.TELEPTY_MODAL_PARK_TTL_MS ?? '').trim();
    if (!raw) return shared.MODAL_PARK_TTL_DEFAULT_MS;
    const configured = Number(raw);
    return Number.isFinite(configured) && configured > 0 ? configured : shared.MODAL_PARK_TTL_DEFAULT_MS;
  }

  // #1207 (measured): each dropped op's terminal persistence outcome is awaited (FIFO) BEFORE the
  // `modal_park_timeout` notification is emitted, and the notification carries those outcomes.
  // Resolves to the number of ops flushed and never rejects.
  async function flushModalParkQueue(sessionId, session, waitedMs) {
    const queued = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
    if (queued === 0) return 0;
    const drained = session.bootstrapQueue.splice(0, queued);
    const tracking = [];
    for (const op of drained) {
      if (op.type === 'submit') {
        resolveBootstrapSubmit(op, {
          status: 504,
          body: {
            error: 'Submit parked behind a surface modal that never cleared',
            reason: 'surface_modal_park_timeout',
            strategy: 'none', attempts: 0, gated: true, bootstrap_queued: true, bootstrap_op_id: op.op_id,
          },
        });
      }
      // #860 F2 — the third terminal path. A submit op answers its caller on the open HTTP request
      // above; an inject op's caller left long ago, and the ledger is the only thing that can still
      // tell it the body never reached the surface.
      const outcome = await settleTerminalOutcome(op, sessionId, 'SURFACE_MODAL_PARK_TIMEOUT',
        `parked behind a surface modal that did not clear within ${waitedMs}ms`,
        { kind: 'inject_delivery_dropped', trigger: 'surface_modal_park_timeout' });
      tracking.push({ op_id: op.op_id, inject_id: op.injectId || null, outcome });
    }
    emitBootstrapEvent('modal_park_timeout', sessionId, session, {
      actionable: true,
      queued_dropped: queued,
      waited_ms: waitedMs,
      tracking,
      hint: `Session '${sessionId}' has been showing a blocking modal for ${Math.round(waitedMs / 1000)}s — `
        + `${queued} parked inject(s) were flushed. Answer or dismiss the prompt on the surface, then re-inject.`,
    });
    console.log(`[MODAL] ${sessionId} park TTL expired after ${waitedMs}ms — flushed ${queued} op(s)`);
    return queued;
  }

  async function awaitModalParkDrain(sessionId, session, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : modalParkTtlMs();
    const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : shared.MODAL_PARK_POLL_MS;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const sleepFn = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    cancelModalParkPoll(session);   // this call supersedes any background poll
    const start = now();
    while (isSurfaceBlockedByModal(session)) {
      if (now() - start >= timeoutMs) {
        const waited = now() - start;
        return { cleared: false, waited_ms: waited, flushed: await flushModalParkQueue(sessionId, session, waited) };
      }
      await sleepFn(pollIntervalMs);
    }
    const waited = now() - start;
    await drainBootstrapQueue(sessionId, session);
    return { cleared: true, waited_ms: waited, flushed: 0 };
  }

  function cancelModalParkPoll(session) {
    if (session && session.modalParkPoll) {
      clearTimeout(session.modalParkPoll);
      session.modalParkPoll = null;
    }
  }

  function scheduleModalParkDrain(sessionId, session) {
    if (!session || session.modalParkPoll) return;
    const deadline = Date.now() + modalParkTtlMs();
    const tick = () => {
      session.modalParkPoll = null;
      if (!isSurfaceBlockedByModal(session)) {
        const depth = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
        console.log(`[MODAL] ${sessionId} surface cleared — draining ${depth} parked op(s)`);
        drainBootstrapQueue(sessionId, session);
        return;
      }
      if (Date.now() >= deadline) {
        flushModalParkQueue(sessionId, session, modalParkTtlMs()).catch((error) => console.error(`[MODAL] ${sessionId} park flush failed: ${error && error.message}`));
        return;
      }
      session.modalParkPoll = setTimeout(tick, shared.MODAL_PARK_POLL_MS);
      if (session.modalParkPoll.unref) session.modalParkPoll.unref();
    };
    session.modalParkPoll = setTimeout(tick, shared.MODAL_PARK_POLL_MS);
    if (session.modalParkPoll.unref) session.modalParkPoll.unref();
  }

  function parkOperationOnModal(sessionId, session, operation, decision) {
    const op = enqueueBootstrapOperation(sessionId, session, operation);
    scheduleModalParkDrain(sessionId, session);
    console.log(`[MODAL] ${sessionId} ${operation.type} parked — ${decision.reason} `
      + `(depth ${session.bootstrapQueue.length})`);
    return op;
  }

  function modalParkResponse(op, decision, extra = {}) {
    return bootstrapQueuedResponse(op, {
      parked: 'surface_modal',
      reason: decision.reason,
      hint: decision.hint,
      ...extra,
    });
  }

  function getSessionTerminalLabel(session) {
    if (session.termProgram) {
      return session.termProgram;
    }

    const term = String(session.term || '').toLowerCase();
    if (term.includes('kitty')) return 'kitty';
    if (term.includes('ghostty')) return 'ghostty';
    if (term.includes('tmux')) return 'tmux';

    if (session.type === 'mailbox') return 'mailbox';
    if (session.type === 'aterm') return 'aterm';
    if (session.backend === 'cmux') return 'cmux';
    if (session.backend === 'kitty') return 'kitty';
    if ((session.type || 'spawned') === 'spawned') return 'daemon-pty';

    return null;
  }

  function submitViaPty(session, options) {
    if (protectedInputFailure(session)) return false;
    if (session.sshRemote) return false; // SSH submit is admitted by the receipt protocol only.
    if (hasHeldInteraction(session)) return false;
    shared.interaction.invalidateInteraction(session, 'submit');
    if (session.type === 'wrapped') {
      if (session.ownerWs && session.ownerWs.readyState === 1) {
        // #137: a terminal-level submit names itself and the current owner generation. It carries
        // no pair (its body's daemon_msg_id is not known here). Task 1215 submit286: it carries the
        // inject_id only when terminalLevelSubmit correlated one to this exact record; without
        // one the frame is byte-identical to before (frameMeta omits a null id).
        session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r',
          ...bridgeStage.frameMeta({ daemon_msg_id: `submit:${shared.crypto.randomUUID()}`,
            inject_id: options && options.injectId ? options.injectId : null, part: 'submit',
            pair: options && options.pair ? options.pair : null,
            owner_generation: session.interactionOwnerGeneration }) }));
        armUpstreamProbe(session);   // #732: a submit is a delivery too — probe with it
        return true;
      }
      return false;
    } else {
      if (ptyInputFailure(session)) return false;   // #1215 pipe200: shared PTY input guard (deferred CR)
      session.ptyProcess.write('\r');
      return true;
    }
  }

  function createInteractionRuntime() {
    return shared.interaction.createInteractionCore({
      // #1207 — the core reads a committed-only VIEW of the interaction maps and commits one `iact`
      // delta per stage (class I, reserved per act before saveRecord). An unavailable store reads
      // as null, so the core refuses `storage_unavailable` before any write, as before.
      readLedger: () => {
        const client = shared.ledgerClient;
        if (!client || ledgerUnavailable()) return null;
        return { interactions: client.readModel.interactionsView() };
      },
      commitLedger: async (next, change) => {
        const client = shared.ledgerClient;
        if (!client || ledgerUnavailable()) return false;
        const action = change && change.record ? change.record : null;
        if (!action) return false;
        const outcome = await client.submit('iact', { action, pending: change.pending || null }, { class: 'I' });
        // Durable ⇒ true. Indeterminate is NOT false: the core maps a falsy commit to a refusal it
        // could later contradict, so the dispatch stage reports outcome_unknown through its own path.
        if (outcome.outcome === 'ack') return true;
        if (outcome.outcome === 'indeterminate') return 'indeterminate';
        return false;
      },
      reserveAct: sid => shared.ledgerClient ? shared.ledgerClient.accounting.reserveAct(sid) : false,
      releaseAct: sid => { if (shared.ledgerClient) shared.ledgerClient.accounting.releaseAct(sid); },
      observe: sid => shared.readyRegistry.observeInteraction(shared.sessions[sid]),
      binding: interactionBinding,
      authorize: principal => principal === 'authenticated-host-controller',
      pendingTask: (sid, id) => {
        const session = shared.sessions[sid];
        if (!session || session.bootstrapDraining) return null;
        const op = session.bootstrapQueue?.find(entry => entry.injectId === id && entry.type === 'inject');
        if (!op || typeof op.prompt !== 'string') return null;
        return { inject_id: id, sid, op_id: op.op_id, payload: op.prompt,
          payload_digest: shared.interaction.payloadDigest(op.prompt), no_enter: op.noEnter === true,
          queued_at: op.queued_at, fifo_index: session.bootstrapQueue.indexOf(op) };
      },
      dispatch: dispatchInteraction
    });
  }

  return {
    auditAppend,
    verifiedPrincipalFromReq,
    verifiedSenderFields,
    ledgerUnavailable,
    beginFailure,
    interactionBinding,
    hasHeldInteraction,
    dispatchInteraction,
    restoreTrackedInjections,
    getTrackedInjection,
    fetchTrackedInjection,
    sessionAuthenticationCapability,
    beginTrackedInjection,
    abortTrackedInjection,
    parkTrackedInjection,
    recordBridgeReceipt,
    deliveryAuditResult,
    getPendingReport,
    markPendingReportSubmitStarted,
    markPendingReportSubmitConfirmed,
    markPendingReportSubmitUnconfirmed,
    broadcastBusEvent,
    buildErrorBody,
    respondWithError,
    classifyPeerLaneInject,
    getSessionDisconnectedMs,
    armUpstreamProbe,
    isUpstreamStalled,
    getSessionHealthStatus,
    getSessionHealthReason,
    sleep,
    isBootstrapReady,
    buildBootstrapBlock,
    shouldQueueBootstrapOperation,
    hasBootstrapBacklog,
    emitBootstrapEvent,
    enqueueBootstrapOperation,
    resolveBootstrapSubmit,
    bootstrapQueuedResponse,
    executeBootstrapInject,
    parseSubmitRetryOptions,
    buildSubmitVerify,
    buildSubmitConfirmOptions,
    confirmSubmitAfterDispatch,
    gatedTerminalSubmit,
    executeBootstrapSubmit,
    drainBootstrapQueue,
    markBootstrapReady,
    failBootstrapQueueOnTimeout,
    shouldApplyOwnerAliveFloor,
    scheduleBootstrapPromptPoll,
    waitForBootstrapSubmit,
    buildSessionTransportBlock,
    buildSessionSemanticBlock,
    buildSessionEvent,
    broadcastSessionEvent,
    getInjectFailure,
    markSessionDisconnected,
    emitInjectFailureEvent,
    terminalLevelSubmit,
    maybeBracketedPaste,
    readOutputRingTail,
    isSurfaceBlockedByModal,
    modalRemedy,
    modalDeliveryDecision,
    modalHoldMs,
    awaitSurfaceModalClear,
    resolveModalGate,
    modalRejectionResponse,
    modalParkTtlMs,
    flushModalParkQueue,
    awaitModalParkDrain,
    cancelModalParkPoll,
    scheduleModalParkDrain,
    parkOperationOnModal,
    modalParkResponse,
    getSessionTerminalLabel,
    submitViaPty,
    createInteractionRuntime,
  };
}

module.exports = { createDeliveryRuntime,
  // Task 1215 hotfix 0.10.1: immediate-submit-v1 (pure; websocket.js, session-actions.js, session-delivery.js, cli.js).
  IMMEDIATE_SUBMIT_CAPABILITY, bindImmediateSubmitCapability, immediateSubmitSupport, rememberSubmitPair, immediateSubmitOutcome,
  // hotfix480: body custody (session-delivery) and the shared immediate attempt (session-actions, bootstrap drain).
  holdBodyCustody, settleBodyCustody, immediateSubmitAttempt, immediateAttemptFields, bodyCustodyFull };
