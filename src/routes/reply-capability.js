'use strict';

const { isLoopbackPeer } = require('../protocol/clear-strand');
const { CAPABILITY, SENDER_PROOF, REQUEST_MAX_BYTES, REPLY_BODY_MAX_BYTES,
  bodySha256, refusalAnswer } = require('../reply-capability');

const JSON_MEDIA_TYPE_RE = /^application\/json[ \t]*(?:;|$)/;

function validRequest(req) {
  const raw = req.principalRawBody;
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > REQUEST_MAX_BYTES) return false;
  const request = req.body;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  const keys = Object.keys(request);
  if (keys.length !== 3 || !['v', 'capability', 'body'].every(key => Object.hasOwn(request, key))) return false;
  const { v, body } = request;
  if (v !== 1 || typeof body !== 'string' || !body || body.includes('\0')
      || Buffer.byteLength(body) > REPLY_BODY_MAX_BYTES) return false;
  return Buffer.from(body, 'utf8').toString('utf8') === body;
}

function liveSession(sessions, { sid, epoch, generation }) {
  const session = Object.getOwnPropertyDescriptor(sessions, sid)?.value;
  return session && typeof session === 'object' && !Array.isArray(session)
    && !session.isClosing && session.sessionEpoch === epoch
    && (session.credentialGeneration || 1) === generation ? session : null;
}

function senderFields({ sid, epoch, generation }) {
  return {
    verified_sender_sid: sid,
    verified_sender_epoch: epoch,
    verified_sender_generation: generation
  };
}

function registerReplyCapabilityV1Route(app, { shared, verifyHostToken }) {
  if (typeof verifyHostToken !== 'function') {
    throw new TypeError('registerReplyCapabilityV1Route requires a verifyHostToken(req) function');
  }

  app.post('/api/reply-capability-v1', async function (req, res) {
    const send = ({ status, result }) => res.status(status).json(result);
    const headers = req.headers || {};
    // C1–C2. Requests denied here never look up a capability or spend audit budget.
    if (!isLoopbackPeer(req.socket?.remoteAddress) || headers.origin !== undefined
        || !JSON_MEDIA_TYPE_RE.test(String(headers['content-type']).toLowerCase())
        || verifyHostToken(req) !== true) {
      return send(refusalAnswer('REPLY_TRANSPORT_REFUSED'));
    }
    const store = shared.replyCapabilityStore;
    if (!store || req.clientProfile) return send(refusalAnswer('REPLY_CAPABILITY_UNAVAILABLE'));

    function refuse(code, { id = null, answer = refusalAnswer(code, { capability_id: id }), blocked } = {}) {
      const { emit, suppressed_count } = store.chargeRefusal(id);
      if (emit) {
        shared.auditAppend({
          kind: 'reply-capability',
          ...blocked,
          source: CAPABILITY,
          origin: 'trusted-local',
          origin_host: shared.MACHINE_ID,
          payload: '',
          preview: false,
          delivery_result: blocked?.delivery_result || `refused:${code}`,
          reply_capability: { id, suppressed_count }
        });
      }
      return send(answer);
    }

    // C3–C6. The store checks the token, terminal replay and both accept clocks synchronously.
    if (!validRequest(req)) return refuse('REPLY_REQUEST_INVALID');
    const { capability, body } = req.body;
    const resolved = store.resolve(capability);
    if (!resolved.ok) {
      const answer = refusalAnswer(resolved.code);
      if (resolved.code === 'REPLY_CAPABILITY_UNKNOWN') {
        answer.result.daemon_started_at = store.daemonStartedAt;
      }
      return refuse(resolved.code, { id: resolved.parsed_id, answer });
    }
    const { id } = resolved;
    const state = store.checkState(id, body);
    if (!state.ok) {
      if (state.replayed) return send(state.answer);
      return refuse(state.code, { id, answer: state.answer });
    }

    // C7–C11. Capture the exact destination and mark in flight before any await.
    const { responder, requester, reply_prefix } = store.get(id);
    if (!liveSession(shared.sessions, responder)) {
      store.supersede(id);
      return refuse('REPLY_CAPABILITY_SUPERSEDED', { id });
    }
    const bearer = headers['x-telepty-session-token'];
    if (bearer !== undefined) {
      const principal = shared.sessionCredentials.verify(bearer);
      if (!principal || principal.sid !== responder.sid || principal.epoch !== responder.epoch
          || principal.generation !== responder.generation) {
        return refuse('REPLY_SENDER_MISMATCH', { id });
      }
    }
    const dest = liveSession(shared.sessions, requester);
    if (!dest) {
      store.revoke(id, 'requester_gone');
      return refuse('REPLY_DESTINATION_GONE', { id });
    }
    const prompt = reply_prefix + body;
    const peer = shared.classifyPeerLaneInject({
      from: responder.sid, to: requester.sid, prompt, orchestratorSids: shared.ORCHESTRATOR_SIDS
    });
    const verified = senderFields(responder);
    if (peer.decision === 'block') {
      return refuse('PEER_INJECT_BLOCKED', {
        id,
        blocked: {
          kind: 'inject', to: requester.sid, claimed_from: responder.sid, ...verified,
          delivery_result: `blocked:${peer.reason}`
        }
      });
    }
    const attempt = store.begin(id, body);

    // C12. A thrown delivery is terminal. The exception itself can contain prompt text.
    let settled;
    try {
      const delivery = await shared.deliverInjectionToSession(requester.sid, dest, attempt.delivered_text, {
        from: responder.sid,
        source: CAPABILITY,
        injectId: null,
        pairInjectId: attempt.reply_inject_id,
        verifiedSenderSid: responder.sid,
        notAfterMs: attempt.not_after_ms
      });
      settled = store.settle(id, delivery, {
        queued: delivery?.success === true && shared.deliveryAuditResult(delivery) === 'queued'
      });
    } catch {
      settled = store.settleThrown(id);
    }
    const { answer } = settled;
    const { stage, outcome, reason } = answer.result;
    const accepted = stage === 'accepted';
    const queued = outcome === 'queued';
    const timestamp = new Date().toISOString();
    shared.auditAppend({
      ts: timestamp,
      inject_id: attempt.reply_inject_id,
      kind: 'inject',
      source: CAPABILITY,
      claimed_from: responder.sid,
      ...verified,
      to: requester.sid,
      origin: 'trusted-local',
      origin_host: shared.MACHINE_ID,
      payload: attempt.delivered_text,
      preview: false,
      delivery_result: accepted ? (queued ? 'queued' : 'success') : `failed:${reason || 'OUTCOME_UNKNOWN'}`,
      reply_capability: {
        id, sender_proof: SENDER_PROOF, reply_to_inject_id: attempt.inbound_inject_id, reply_attempt: attempt.attempt
      }
    });
    if (accepted) {
      shared.broadcastSessionEvent(queued ? 'inject_queued' : 'inject_written', requester.sid, dest, {
        timestamp,
        extra: {
          inject_id: attempt.reply_inject_id,
          target_agent: requester.sid,
          content_sha256: bodySha256(attempt.delivered_text),
          content_length: Buffer.byteLength(attempt.delivered_text),
          from: responder.sid,
          ...verified,
          spoof_suspected: false,
          origin: 'trusted-local',
          reply_to: null,
          thread_id: null,
          reply_expected: false,
          transport: CAPABILITY,
          reply_capability_id: id
        }
      });
    }
    return send(answer);
  });

  shared.replyCapabilityStore?.startSweeper({
    isInstanceLive: principal => Boolean(liveSession(shared.sessions, principal))
  });
}

module.exports = { registerReplyCapabilityV1Route };
