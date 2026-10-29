'use strict';
const { mailboxLeaseAlive } = require('./poll-session');

// Accessors retain the daemon's shared instances and original first-use timing.
// Construction only creates functions; effect boundaries run when those functions do.
function createDeliveryRuntime(shared, {
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout
} = {}) {
  function auditAppend(record) {
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

  function commitTrackedInjections() {
    return shared.sessionPersistence.saveTrackedInjections(shared.trackedInjections, shared.TRACKED_INJECTIONS_PATH);
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
    return shared.interactionCore.isBusy(session.id)
      || Object.values(shared.trackedInjections.interactions?.actions || {}).some(a => a.sid === session.id
        && ['dispatched', 'outcome_unknown'].includes(a.stage))
      || Object.values(shared.trackedInjections.interactions?.pending || {})
      .some(p => p.sid === session.id && p.state === 'held');
  }

  function dispatchInteraction(frame) {
    const sid = frame.request.identity.sid;
    const s = shared.sessions[sid];
    if (!s) return Promise.resolve(shared.interaction.refusal('wrong_owner'));
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

  function restoreTrackedInjections() {
    const loaded = shared.sessionPersistence.loadTrackedInjections(shared.TRACKED_INJECTIONS_PATH);
    if (!loaded.ok) {
      shared.trackedLedgerHealthy = false;
      shared.trackedLedgerUnavailableReason = loaded.reason;
      console.warn(`[OBSERVE] tracked-injection store unavailable (${loaded.reason}${loaded.detail ? `: ${loaded.detail}` : ''}) — every poll answers tracking_state=unavailable`);
      return;
    }
    shared.trackedInjections = loaded.ledger;
    const nowIso = new Date().toISOString();
    let restored = 0;
    for (const record of Object.values(shared.trackedInjections.injections)) {
      shared.sessionPersistence.appendLedgerObservation(record, { kind: 'daemon_restart_observed', trigger: 'daemon_restart' }, nowIso);
      restored++;
    }
    if (restored > 0 || Object.keys(shared.trackedInjections.interactions.actions).length > 0) {
      if (!commitTrackedInjections().ok) {
        shared.trackedLedgerHealthy = false;
        shared.trackedLedgerUnavailableReason = 'observation_store_write_failed';
      }
      console.log(`[OBSERVE] restored ${restored} tracked injection(s) — all still completion-unknown`);
    }
  }

  function getTrackedInjection(injectId) {
    if (typeof injectId !== 'string' || !injectId) return null;
    if (injectId === '__proto__' || injectId === 'prototype' || injectId === 'constructor') return null;
    const store = shared.trackedInjections.injections;
    if (!Object.prototype.hasOwnProperty.call(store, injectId)) return null;
    return store[injectId];
  }

  function sessionAuthenticationCapability(session) {
    if (!session || !session.sessionEpoch) return {};
    if (session.sessionEpochProved && session.sessionEpochProved === session.sessionEpoch) {
      return { session_authentication: 'observed', session_authentication_reason: null };
    }
    return { session_authentication: 'unavailable', session_authentication_reason: 'no_815_bearer_presented' };
  }

  function beginTrackedInjection({ injectId, sessionId, source, session }) {
    const nowIso = new Date().toISOString();
    const injections = shared.trackedInjections.injections;
    const priorInjection = Object.getOwnPropertyDescriptor(injections, injectId);
    const superseded = [];
    // Supersession: a second tracked dispatch for the same session retains the OLD record and
    // appends `tracking_superseded` before the active pointer moves. The previous code only logged
    // a warning and destructively overwrote a SID-keyed entry, so the old inject_id became
    // unqueryable — and an inject_id nobody can query is indistinguishable from one that never
    // existed.
    for (const record of Object.values(injections)) {
      if (record.session_id === sessionId && record.tracking_state === 'tracked') {
        // Append mutates the history array in place and can trim its oldest entry.
        // Retain descriptors/references so rollback also preserves absent fields.
        const observations = record.observations;
        superseded.push({
          record,
          fields: ['tracking_state', 'observation_seq', 'last_observation', 'observations']
            .map(key => [key, Object.getOwnPropertyDescriptor(record, key)]),
          observations,
          history: Array.isArray(observations) ? Object.getOwnPropertyDescriptors(observations) : null,
        });
        record.tracking_state = 'superseded';
        shared.sessionPersistence.appendLedgerObservation(record, {
          kind: 'tracking_superseded', trigger: 'superseded_by_new_tracked_inject', superseded_by: injectId,
        }, nowIso);
      }
    }

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
    injections[injectId] = record;
    shared.sessionPersistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, nowIso);

    const committed = commitTrackedInjections();
    if (!committed.ok) {
      // Reverse order also restores a history array shared by prior records.
      for (let i = superseded.length - 1; i >= 0; i--) {
        const prior = superseded[i];
        if (prior.history) {
          for (const key of Reflect.ownKeys(prior.observations)) {
            if (!Object.prototype.hasOwnProperty.call(prior.history, key)) delete prior.observations[key];
          }
          Object.defineProperties(prior.observations, prior.history);
        }
        for (const [key, descriptor] of prior.fields) {
          if (descriptor) Object.defineProperty(prior.record, key, descriptor);
          else delete prior.record[key];
        }
      }
      if (priorInjection) Object.defineProperty(injections, injectId, priorInjection);
      else delete injections[injectId];
      console.error(`[OBSERVE] tracking persistence FAILED for ${injectId} — refusing delivery (${committed.reason})`);
      return { ok: false, reason: 'tracking_persistence_failed' };
    }
    shared.trackedLedgerHealthy = true;
    shared.trackedLedgerUnavailableReason = null;
    return { ok: true, record };
  }

  function abortTrackedInjection(injectId, sessionId, deliveryCode, deliveryError, cause = {}) {
    const record = getTrackedInjection(injectId);
    if (!record) return 'tracking_unavailable';
    record.tracking_state = 'aborted';
    shared.sessionPersistence.appendLedgerObservation(record, {
      kind: cause.kind || 'inject_delivery_refused',
      trigger: cause.trigger || 'delivery_refused',
      delivery_code: deliveryCode || 'DELIVERY_FAILED',
      delivery_error: deliveryError || null,
      // Omitting `bytesWritten` means the caller MEASURED zero (the synchronous refusal arm: the
      // route never handed a byte over). An explicit `null` means it could not measure — a throw
      // mid-drain can land on either side of the body write — and null is recorded rather than a
      // guessed zero.
      bytes_written: cause.bytesWritten === undefined ? 0 : cause.bytesWritten,
    }, new Date().toISOString());
    // The pending entry goes too. It is what makes the session look like it is awaiting a turn, and
    // it belongs to an inject whose bytes were never delivered — every later observation on this
    // session would otherwise be filed against it.
    if (sessionId && shared.pendingReports[sessionId] && shared.pendingReports[sessionId].injectId === injectId) {
      delete shared.pendingReports[sessionId];
    }
    const committed = commitTrackedInjections();
    if (!committed.ok) {
      console.error(`[OBSERVE] abort commit FAILED for ${injectId} (${committed.reason})`);
      return 'tracking_persistence_failed';
    }
    return 'tracking_aborted';
  }

  function parkTrackedInjection(injectId, strategy, reason) {
    if (!injectId) return 'no_tracked_inject';
    const record = getTrackedInjection(injectId);
    if (!record) return 'tracking_unavailable';
    shared.sessionPersistence.appendLedgerObservation(record, {
      kind: 'inject_parked',
      trigger: strategy,
      reason: reason || null,
      bytes_written: 0,
    }, new Date().toISOString());
    const committed = commitTrackedInjections();
    if (!committed.ok) {
      console.error(`[OBSERVE] park commit FAILED for ${injectId} (${committed.reason})`);
      return 'tracking_persistence_failed';
    }
    return 'tracking_parked';
  }

  function deliveryAuditResult(delivery) {
    return delivery && delivery.queued === true && (delivery.strategy === 'bootstrap_queue' || delivery.poll_only === true) ? 'queued' : 'success';
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

  function buildErrorBody(code, error, extra = {}) {
    return { success: false, code, error, ...extra };
  }

  function respondWithError(res, httpStatus, code, error, extra = {}) {
    return res.status(httpStatus).json(buildErrorBody(code, error, extra));
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

    return session.ptyProcess && !session.ptyProcess.killed ? 'PTY_RUNNING' : 'PTY_EXITED';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isBootstrapReady(session) {
    return !shared.isBootstrapGatedSession(session) || session.bootstrapReady === true;
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
    return shared.isBootstrapGatedSession(session) && !isBootstrapReady(session);
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
    const textResult = await shared.writeDataToSession(sessionId, session, body);
    // #860 F2 — a failure here is reported back with the byte count that actually landed, because
    // the caller records it in the ledger. The two arms differ: nothing was written when the BODY
    // was refused, but the body is on the surface by the time the submit CR can fail, and an abort
    // that stamped `bytes_written: 0` on that one would be the same defect it exists to close.
    if (!textResult.success) return { ...textResult, bytes_written: 0 };

    if (!op.noEnter) {
      await sleep(shared.WRAPPED_SUBMIT_DELAY_MS);
      const submitResult = await shared.writeDataToSession(sessionId, session, '\r');
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

  async function gatedTerminalSubmit(id, session, injectedBody, settleEnabled) {
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
    return terminalLevelSubmit(id, session);
  }

  async function executeBootstrapSubmit(sessionId, session, op) {
    const body = op.body || {};
    const injectedBody = typeof body.injected_body === 'string' ? body.injected_body : null;
    const { retries, retryDelayMs, verifyTimeoutMs } = parseSubmitRetryOptions(body, injectedBody);
    if (injectedBody) {
      markPendingReportSubmitStarted(sessionId, injectedBody);
    }

    const settleEnabled = body.input_settle_gate !== false;
    let strategy = await gatedTerminalSubmit(sessionId, session, injectedBody, settleEnabled);
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
      const retryStrategy = await gatedTerminalSubmit(sessionId, session, injectedBody, settleEnabled);
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
              emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
                op_id: op.op_id,
                operation: op.type,
                code: result.code || 'DELIVERY_FAILED',
                error: result.error || 'bootstrap delivery failed'
              });
              // #860 F2 — and durably. The event above is push-only; this is a TERMINAL outcome for
              // a dispatch whose record has said `tracked` since the route accepted it.
              abortTrackedInjection(op.injectId, sessionId, result.code || 'DELIVERY_FAILED', result.error, {
                trigger: 'bootstrap_queue_failed',
                bytesWritten: result.bytes_written,
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
                error: error.message || 'bootstrap submit failed',
                strategy: 'none',
                attempts: 0,
                gated: false,
                bootstrap_queued: true
              }
            });
          }
          emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
            op_id: op.op_id,
            operation: op.type,
            code: 'BOOTSTRAP_DRAIN_FAILED',
            error: error.message || 'bootstrap drain failed'
          });
          // #860 F2 — the same terminal outcome as the arm above, reached by a throw. `bytesWritten:
          // null` because a throw can land on either side of the body write, and this is the one
          // path that cannot say which.
          abortTrackedInjection(op.injectId, sessionId, 'BOOTSTRAP_DRAIN_FAILED', error.message || 'bootstrap drain failed', {
            trigger: 'bootstrap_drain_failed',
            bytesWritten: null,
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

  function markBootstrapReady(sessionId, session, reason) {
    if (!session) return false;
    shared.initializeBootstrapState(session);
    if (!shared.isBootstrapGatedSession(session)) {
      return false;
    }
    if (session.bootstrapReady === true) {
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

  function failBootstrapQueueOnTimeout(sessionId, session, detail = {}) {
    const queued = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
    emitBootstrapEvent('bootstrap_ready_timeout', sessionId, session, {
      ...detail,
      actionable: true,
      queued_dropped: queued,
      hint: `Session '${sessionId}' did not become inject-ready within ${shared.BOOTSTRAP_READY_TIMEOUT_MS}ms — the target CLI (e.g. codex MCP init) may be hung. Inspect the surface and re-spawn if needed; queued injects were flushed.`
    });
    if (queued === 0) return;
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
      emitBootstrapEvent('bootstrap_queue_failed', sessionId, session, {
        op_id: op.op_id,
        operation: op.type,
        code: 'BOOTSTRAP_READY_TIMEOUT',
        error: `target '${sessionId}' not ready within ${shared.BOOTSTRAP_READY_TIMEOUT_MS}ms`
      });
      // #860 F2 — DROPPED, not refused: this op was accepted, parked, and discarded without the
      // daemon ever attempting a write. Zero bytes is a measurement here, not an assumption.
      abortTrackedInjection(op.injectId, sessionId, 'BOOTSTRAP_READY_TIMEOUT',
        `target '${sessionId}' not ready within ${shared.BOOTSTRAP_READY_TIMEOUT_MS}ms`,
        { kind: 'inject_delivery_dropped', trigger: 'bootstrap_ready_timeout' });
    }
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
          failBootstrapQueueOnTimeout(sessionId, session, {
            reason: result.reason,
            waited_ms: result.waited_ms || 0
          });
        }
      }).catch((error) => {
        session.bootstrapPromptPoll = null;
        failBootstrapQueueOnTimeout(sessionId, session, {
          reason: 'prompt_symbol_error',
          error: error.message || String(error)
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

  function terminalLevelSubmit(id, session) {
    if (session.isClosing) return null;
    if (hasHeldInteraction(session)) return null;
    if (submitViaPty(session)) return 'pty_cr';
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

  function flushModalParkQueue(sessionId, session, waitedMs) {
    const queued = Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0;
    if (queued === 0) return 0;
    const drained = session.bootstrapQueue.splice(0, queued);
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
      abortTrackedInjection(op.injectId, sessionId, 'SURFACE_MODAL_PARK_TIMEOUT',
        `parked behind a surface modal that did not clear within ${waitedMs}ms`,
        { kind: 'inject_delivery_dropped', trigger: 'surface_modal_park_timeout' });
    }
    emitBootstrapEvent('modal_park_timeout', sessionId, session, {
      actionable: true,
      queued_dropped: queued,
      waited_ms: waitedMs,
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
        return { cleared: false, waited_ms: waited, flushed: flushModalParkQueue(sessionId, session, waited) };
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
        flushModalParkQueue(sessionId, session, modalParkTtlMs());
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

  function submitViaPty(session) {
    if (hasHeldInteraction(session)) return false;
    shared.interaction.invalidateInteraction(session, 'submit');
    if (session.type === 'wrapped') {
      if (session.ownerWs && session.ownerWs.readyState === 1) {
        session.ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
        armUpstreamProbe(session);   // #732: a submit is a delivery too — probe with it
        return true;
      }
      return false;
    } else {
      session.ptyProcess.write('\r');
      return true;
    }
  }

  function createInteractionRuntime() {
    return shared.interaction.createInteractionCore({
      readLedger: () => shared.trackedLedgerHealthy ? shared.trackedInjections : null,
      commitLedger: next => {
        const saved = shared.sessionPersistence.saveTrackedInjections(next, shared.TRACKED_INJECTIONS_PATH);
        if (!saved.ok) { shared.trackedLedgerHealthy = false; return false; }
        shared.trackedInjections = next;
        return true;
      },
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
    commitTrackedInjections,
    interactionBinding,
    hasHeldInteraction,
    dispatchInteraction,
    restoreTrackedInjections,
    getTrackedInjection,
    sessionAuthenticationCapability,
    beginTrackedInjection,
    abortTrackedInjection,
    parkTrackedInjection,
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

module.exports = { createDeliveryRuntime };
