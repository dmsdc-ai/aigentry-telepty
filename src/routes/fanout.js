'use strict';

function registerFanoutRoutes(app, {
  classifyPeerLaneInject,
  ORCHESTRATOR_SIDS,
  crypto,
  sessions,
  broadcastSessionEvent,
  auditAppend,
  MACHINE_ID,
  respondWithError,
  FANOUT_MAX_TARGETS,
  verifiedSenderFields,
  verifiedPrincipalFromReq,
  deliverInjectionToSession,
  deliveryAuditResult,
  broadcastBusEvent,
  busClients
}) {
  // #45 — fan-out (broadcast/multicast) is OPERATOR/ORCHESTRATOR-ONLY. The single-inject
  // path hard-blocks off-policy peer→peer traffic via classifyPeerLaneInject; fan-out
  // one→many is strictly more dangerous (a worm/fan-out primitive), so the peer lane is
  // blocked OUTRIGHT here — even a sanctioned ask-envelope may not fan out. We reuse the
  // SAME classifier (DRY, no second policy) and gate on the LANE, not the per-target
  // decision: classify by SENDER (`to: null`) so the verdict is the sender's lane,
  // independent of any individual target. This is what makes broadcast all-or-nothing on
  // the lane — a peer cannot earn fan-out rights by listing the orchestrator as one
  // target. Operator lane (no `from`, or `from` ∈ orchestrator sids) and the fail-open
  // `disabled` lane proceed to delivery, exactly as single-inject allows them. #533 Phase 2.
  function isPeerLaneFanout(from, prompt) {
    return classifyPeerLaneInject({ from, to: null, prompt, orchestratorSids: ORCHESTRATOR_SIDS });
  }

  // Reject a peer-lane fan-out: emit a per-target peer_inject_blocked bus event for every
  // intended target (mirrors the single-inject block event for reporting parity) and return
  // the same 403 PEER_INJECT_BLOCKED shape, reaching ZERO sessions. `targetIds` is the full
  // intended target set (broadcast = all sessions, multicast = requested session_ids).
  function rejectPeerLaneFanout(res, { from, reason, targetIds, source, verifiedSender = null, prompt = '' }) {
    const inject_id = crypto.randomUUID();
    const failed = [];
    for (const id of targetIds) {
      broadcastSessionEvent('peer_inject_blocked', id, sessions[id] || null, {
        extra: {
          target_agent: id,
          from: from || null,
          reason,
          source,
          inject_id
        }
      });
      // #47 P5 — one shared-schema audit line per blocked target (mirrors the success per-target
      // fan-out audit), so a blocked fan-out's blast-radius is queryable just like a delivered one.
      auditAppend({
        ts: new Date().toISOString(), inject_id, kind: source, source,
        claimed_from: from || null, ...verifiedSender,
        to: id, to_alias: null, origin: 'trusted-local', origin_host: MACHINE_ID,
        payload: prompt, delivery_result: `blocked:${reason}`
      });
      failed.push({ id, code: 'PEER_INJECT_BLOCKED', error: 'Peer-lane fan-out blocked' });
    }
    console.warn(`[PEER-GUARD] blocked peer-lane ${source} from ${from || '(none)'} → ${targetIds.length} target(s) (${reason})`);
    return respondWithError(res, 403, 'PEER_INJECT_BLOCKED',
      'Peer-lane fan-out blocked: broadcast/multicast is operator-only. Use bin/ask.sh for peer→peer.',
      { reason, sanctioned_channel: 'bin/ask.sh', results: { successful: [], failed } });
  }

  app.post('/api/sessions/multicast/inject', async (req, res) => {
    const { session_ids, prompt, from } = req.body;
    if (typeof prompt !== 'string' || prompt.length === 0) return respondWithError(res, 400, 'INVALID_REQUEST', 'prompt is required');
    if (!Array.isArray(session_ids)) return res.status(400).json({ error: 'session_ids must be an array' });

    // #45 — operator-only fan-out gate (peer lane blocked outright, before any delivery).
    const verdict = isPeerLaneFanout(from, prompt);
    if (verdict.lane === 'peer') {
      return rejectPeerLaneFanout(res, { from, reason: verdict.reason, targetIds: session_ids, source: 'multicast', verifiedSender: verifiedSenderFields(verifiedPrincipalFromReq(req)), prompt });
    }
    // #45 — defense-in-depth blast-radius cap (operator lane too).
    if (session_ids.length > FANOUT_MAX_TARGETS) {
      return respondWithError(res, 429, 'FANOUT_TARGET_CAP',
        `multicast target count ${session_ids.length} exceeds cap ${FANOUT_MAX_TARGETS}`,
        { cap: FANOUT_MAX_TARGETS, requested: session_ids.length });
    }

    const results = { successful: [], failed: [] };
    // #43 — one inject_id for the whole fan-out; one audit line per target (group by inject_id).
    const inject_id = crypto.randomUUID();
    const verifiedPrincipal = verifiedPrincipalFromReq(req);
    const verifiedSenderSid = verifiedPrincipal ? verifiedPrincipal.sid : null;
    const verifiedSender = verifiedSenderFields(verifiedPrincipal);   // #815 audit fields

    for (const id of session_ids) {
      const session = sessions[id];
      if (session) {
        try {
          const delivery = await deliverInjectionToSession(id, session, prompt, {
            source: 'multicast',
            from: from || 'inject',
            verifiedSenderSid // #47 P4 — label the provenance banner with the verified sender
          });
          if (!delivery.success) {
            results.failed.push({ id, code: delivery.code, error: delivery.error });
            auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, `failed:${delivery.code || 'DELIVERY_FAILED'}`);
            continue;
          }

          results.successful.push({ id, strategy: delivery.strategy, ...(delivery.poll_only ? { queued: true, delivered: false, msg_id: delivery.msg_id } : {}) });
          // #860 F2 — a fan-out target that parked the op wrote nothing; same three-value rule as
          // the single-target route.
          auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, deliveryAuditResult(delivery));

          // Broadcast injection to bus
          broadcastBusEvent({
            type: 'injection',
            sender: 'cli',
            target_agent: id,
            content: prompt,
            timestamp: new Date().toISOString()
          });
        } catch (err) {
          results.failed.push({ id, code: 'DELIVERY_FAILED', error: err.message });
          auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, 'failed:DELIVERY_FAILED');
        }
      } else {
        results.failed.push({ id, code: 'SESSION_NOT_FOUND', error: 'Session not found' });
        auditMulticastTarget(inject_id, 'multicast', from, verifiedSender, id, prompt, 'failed:SESSION_NOT_FOUND');
      }
    }

    res.json({ success: true, results });
  });

  // #43 — shared per-target audit helper for the fan-out handlers (multicast/broadcast). One
  // JSONL line per target so blast-radius is queryable per session; all share `inject_id`.
  // #815: takes the full principal fields (verifiedSenderFields) rather than a bare sid, so a
  // fan-out line carries the same instance identity a single inject does.
  function auditMulticastTarget(inject_id, kind, from, verifiedSender, id, prompt, delivery_result) {
    auditAppend({
      ts: new Date().toISOString(), inject_id, kind, source: kind,
      claimed_from: from || null, ...verifiedSender,
      to: id, to_alias: null, origin: 'trusted-local', origin_host: MACHINE_ID,
      payload: prompt, delivery_result
    });
  }

  app.post('/api/sessions/broadcast/inject', async (req, res) => {
    const { prompt, from } = req.body;
    if (typeof prompt !== 'string' || prompt.length === 0) return respondWithError(res, 400, 'INVALID_REQUEST', 'prompt is required');

    // #45 — operator-only fan-out gate (peer lane blocked outright, before any delivery).
    // Broadcast is all-or-nothing on the lane: a peer-lane sender reaches ZERO sessions.
    const targetIds = Object.keys(sessions);
    const verdict = isPeerLaneFanout(from, prompt);
    if (verdict.lane === 'peer') {
      return rejectPeerLaneFanout(res, { from, reason: verdict.reason, targetIds, source: 'broadcast', verifiedSender: verifiedSenderFields(verifiedPrincipalFromReq(req)), prompt });
    }
    // #45 — defense-in-depth blast-radius cap (operator lane too).
    if (targetIds.length > FANOUT_MAX_TARGETS) {
      return respondWithError(res, 429, 'FANOUT_TARGET_CAP',
        `broadcast target count ${targetIds.length} exceeds cap ${FANOUT_MAX_TARGETS}`,
        { cap: FANOUT_MAX_TARGETS, requested: targetIds.length });
    }

    const results = { successful: [], failed: [] };
    // #43 — one inject_id for the whole broadcast; one audit line per target.
    const inject_id = crypto.randomUUID();
    const verifiedPrincipal = verifiedPrincipalFromReq(req);
    const verifiedSenderSid = verifiedPrincipal ? verifiedPrincipal.sid : null;
    const verifiedSender = verifiedSenderFields(verifiedPrincipal);   // #815 audit fields

    for (const id of targetIds) {
      const session = sessions[id];
      try {
        const delivery = await deliverInjectionToSession(id, session, prompt, {
          source: 'broadcast',
          from: from || 'inject',
          verifiedSenderSid // #47 P4 — label the provenance banner with the verified sender
        });
        if (!delivery.success) {
          results.failed.push({ id, code: delivery.code, error: delivery.error });
          auditMulticastTarget(inject_id, 'broadcast', from, verifiedSender, id, prompt, `failed:${delivery.code || 'DELIVERY_FAILED'}`);
          continue;
        }

        results.successful.push({ id, strategy: delivery.strategy, ...(delivery.poll_only ? { queued: true, delivered: false, msg_id: delivery.msg_id } : {}) });
        auditMulticastTarget(inject_id, 'broadcast', from, verifiedSender, id, prompt, deliveryAuditResult(delivery));  // #860 F2
      } catch (err) {
        results.failed.push({ id, code: 'DELIVERY_FAILED', error: err.message });
        auditMulticastTarget(inject_id, 'broadcast', from, verifiedSender, id, prompt, 'failed:DELIVERY_FAILED');
      }
    }

    // Send a single bus event for the entire broadcast (not per-session)
    if (results.successful.length > 0) {
      const busMsg = JSON.stringify({
        type: 'injection',
        sender: 'cli',
        target_agent: 'all',
        content: prompt,
        session_ids: results.successful,
        timestamp: new Date().toISOString()
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(busMsg);
      });
    }

    res.json({ success: true, results });
  });
}

module.exports = { registerFanoutRoutes };
