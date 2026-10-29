'use strict';

// Domain dependencies are the daemon's actual shared helpers and records.
// Late mailbox getters are invoked only at the original points of use.
function createSessionDeliveryContext({
  hasHeldInteraction,
  interaction,
  buildErrorBody,
  DELIVERY_TIMEOUT_MS,
  markSessionDisconnected,
  isOpenWebSocket,
  armUpstreamProbe,
  shouldQueueBootstrapOperation,
  getSessionHealthStatus,
  enqueueBootstrapOperation,
  parkTrackedInjection,
  bootstrapQueuedResponse,
  getInjectFailure,
  resolveModalGate,
  modalRemedy,
  hasBootstrapBacklog,
  parkOperationOnModal,
  modalParkResponse,
  modalRejectionResponse,
  crypto,
  applyProvenance,
  maybeBracketedPaste,
  emitInjectFailureEvent,
  sessions,
  broadcastSessionEvent,
  getMailbox, getMailboxNotifier, getMailboxDelivery,
  net = require('net'), fetch = globalThis.fetch, AbortSignal = globalThis.AbortSignal,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout
}) {
  async function writeDataToSession(id, session, data) {
    if (hasHeldInteraction(session)) return { success: false, httpStatus: 409,
      code: 'INTERACTION_HELD', error: 'Original task retained pending measured composer readiness.', bytes_written: 0 };
    interaction.invalidateInteraction(session, 'automated_input');
    if (session.type === 'aterm') {
      // UDS delivery via net.connect()
      if (session.delivery && session.delivery.transport === 'unix_socket' && session.delivery.address) {
        return new Promise((resolve) => {
          const payload = JSON.stringify({ action: "Inject", workspace: id, text: data }) + '\n';
          let responseBuf = '';
          const timeout = setTimeout(() => {
            sock.destroy();
            resolve(buildErrorBody('TIMEOUT', 'UDS delivery timed out.', { httpStatus: 504 }));
          }, DELIVERY_TIMEOUT_MS);
          const sock = net.connect(session.delivery.address, () => {
            sock.end(payload);
          });
          sock.on('data', (chunk) => { responseBuf += chunk.toString(); });
          sock.on('end', () => {
            clearTimeout(timeout);
            if (responseBuf) {
              try {
                const resp = JSON.parse(responseBuf.trim());
                if (resp.status === 'Error' || resp.success === false) {
                  console.log(`[UDS] Delivery rejected by ${id}: ${resp.error || resp.message || 'unknown'}`);
                  resolve(buildErrorBody('DELIVERY_REJECTED', resp.error || resp.message || 'Target rejected the payload.', {
                    httpStatus: 502,
                    detail: resp
                  }));
                  return;
                }
              } catch {
                // Non-JSON response — treat as success (legacy endpoints)
              }
            } else {
              console.log(`[UDS] Empty response from ${id} — delivery unconfirmed (aterm may not have processed)`);
            }
            resolve({ success: true });
          });
          sock.on('error', (err) => {
            clearTimeout(timeout);
            console.log(`[UDS] Connection error for ${id} at ${session.delivery.address}: ${err.message}`);
            markSessionDisconnected(session);
            resolve(buildErrorBody('DISCONNECTED', 'UDS endpoint is unreachable.', {
              httpStatus: 503,
              detail: err.message
            }));
          });
        });
      }

      // HTTP delivery (backward compat)
      if (!session.deliveryEndpoint) {
        return buildErrorBody('DISCONNECTED', 'Delivery endpoint is missing.', { httpStatus: 503 });
      }

      try {
        const response = await fetch(session.deliveryEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: data, session_id: id }),
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
        });

        if (!response.ok) {
          return buildErrorBody('DELIVERY_FAILED', `Delivery endpoint returned ${response.status}.`, {
            httpStatus: 502,
            deliveryStatus: response.status
          });
        }

        return { success: true };
      } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          return buildErrorBody('TIMEOUT', 'Delivery endpoint timed out.', { httpStatus: 504 });
        }
        return buildErrorBody('DISCONNECTED', 'Delivery endpoint is unreachable.', {
          httpStatus: 503,
          detail: error.message
        });
      }
    }

    if (session.type === 'wrapped') {
      if (!isOpenWebSocket(session.ownerWs)) {
        return buildErrorBody('DISCONNECTED', 'Session owner is disconnected.', { httpStatus: 503 });
      }
      session.ownerWs.send(JSON.stringify({ type: 'inject', data }));
      // #732: every wrapped delivery doubles as an upstream probe — a live PTY answers with
      // at least an echo. See armUpstreamProbe (no-op while an earlier probe is unanswered).
      armUpstreamProbe(session);
      return { success: true };
    }

    if (!session.ptyProcess || session.ptyProcess.killed) {
      return buildErrorBody('DISCONNECTED', 'PTY process is not connected.', { httpStatus: 503 });
    }

    session.ptyProcess.write(data);
    return { success: true };
  }

  // #109: `sessions[id]` is the identity. Delete, rename and recreate all leave `sessions[id]`
  // pointing at a different object (or nothing); the epoch is compared as well so a future
  // in-place re-key cannot slip past.
  function isSameSessionInstance(id, session, sessionEpoch) {
    return sessions[id] === session && (session.sessionEpoch || null) === sessionEpoch;
  }

  // #109 review 1 B1: the deferred CR follows the INSTANCE, not the id. A rename moves the same
  // live record to `session.id` (same PTY, owner, epoch) — that record got the text, so it gets the
  // CR. Destroy/recreate leave the record unregistered; owner replacement changes the epoch.
  function isLiveSessionInstance(session, sessionEpoch) {
    return sessions[session.id] === session && (session.sessionEpoch || null) === sessionEpoch;
  }

  function sessionGoneResult() {
    return { success: false, httpStatus: 410, code: 'SESSION_GONE',
      error: 'Session was destroyed or replaced while this write was pending; it was not written.' };
  }

  // PR #108 TP2: an inject that owes a CR waits for ITS msg_id to be written, not for "a tick".
  // getMailboxDelivery().tick() returns at once while another tick is in flight (e.g. one stuck on a slow
  // session), so the CR used to be scheduled — and written — before the text. The deliverFn settles
  // the waiter with the owner socket the text was actually written to; the CR goes only there.
  // Bound: one in-flight delivery to another session plus our own.
  const SUBMIT_QUEUE_TIMEOUT_MS = (() => {
    const configured = Number(process.env.TELEPTY_SUBMIT_QUEUE_TIMEOUT_MS || 10000);
    return Number.isFinite(configured) && configured > 0 ? configured : 10000;
  })();
  const MAILBOX_TEXT_WAIT_MS = 2 * DELIVERY_TIMEOUT_MS;
  const injectionTargets = new Map(); // pending text stays bound to its original instance
  const mailboxTextWaiters = new Map(); // msg_id → { settle(ownerWs), lastFailure }

  function awaitMailboxText(msgId, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { lastFailure: null };
      const timer = setTimeout(() => {
        mailboxTextWaiters.delete(msgId);
        resolve({ delivered: false, lastFailure: waiter.lastFailure });
      }, timeoutMs);
      waiter.settle = (ownerWs) => {
        clearTimeout(timer);
        mailboxTextWaiters.delete(msgId);
        resolve({ delivered: true, ownerWs });
      };
      mailboxTextWaiters.set(msgId, waiter);
    });
  }

  async function deliverInjectionToSession(id, session, prompt, options = {}) {
    const now = Date.now();
    const sessionEpoch = session.sessionEpoch || null;
    // PR #108 TP1: the owner generation is the owner SOCKET. A same-bearer re-claim keeps the
    // record and the epoch but replaces ownerWs, and that replacement never saw this inject.
    const entryOwnerWs = session.ownerWs;
    if (!options.bypassBootstrapQueue && shouldQueueBootstrapOperation(session)) {
      const healthStatus = getSessionHealthStatus(session, { nowMs: now });
      if (healthStatus === 'STALE') {
        return { success: false, httpStatus: 410, code: 'STALE', error: 'Session is stale and awaiting cleanup.' };
      }
      const op = enqueueBootstrapOperation(id, session, {
        type: 'inject',
        prompt,
        noEnter: !!options.noEnter,
        // #860 F2: the tracked record's id rides ON THE OP, because the queue is where the dispatch
        // and the ledger part company — the route returns, and whatever this queue eventually does
        // with the op is the only thing left that can answer for it.
        injectId: options.injectId || null,
        options: {
          source: options.source || 'inject',
          from: options.from || 'daemon'
        }
      });
      parkTrackedInjection(options.injectId, 'bootstrap_queue', 'bootstrap_not_ready');
      session.lastActivityAt = new Date(now).toISOString();
      return bootstrapQueuedResponse(op, {
        msg_id: op.op_id,
        pending: session.bootstrapQueue.length,
        submit: options.noEnter ? 'skipped' : 'queued'
      });
    }

    const injectFailure = getInjectFailure(session, { nowMs: now });
    if (injectFailure) {
      return { success: false, ...injectFailure };
    }

    // #737: never write into a surface whose Enter key is wired to something other than
    // "submit my message". This is the TEXT path — bypass #4 in the evidence: it consulted
    // only the bootstrapReady boolean, which a blind timer flips without ever looking at the
    // screen (shouldApplyOwnerAliveFloor).
    const modalDecision = await resolveModalGate(id, session, options);
    if (!isSameSessionInstance(id, session, sessionEpoch) || session.ownerWs !== entryOwnerWs) return sessionGoneResult();
    const currentFailure = getInjectFailure(session, { nowMs: Date.now() });
    if (currentFailure) return { success: false, ...currentFailure };

    // #760: ORDER. Once anything is parked for this session, everything behind it parks too —
    // including after the modal clears, until the drain has actually caught up. Without this
    // the second dispatch sees a clear surface, goes straight down the mailbox path, and
    // overtakes the first one that is still sitting in the queue mid-drain. Same guard the
    // gated /submit path already uses for the bootstrap queue.
    const parkBehindBacklog = !modalDecision
      && modalRemedy(process.env, session) === 'park'
      && (hasBootstrapBacklog(session) || session.bootstrapDraining === true);
    const injectParkDecision = modalDecision || (parkBehindBacklog
      ? { action: 'park', reason: 'modal_park_backlog', hint: 'Queued behind an inject parked by a surface modal.' }
      : null);

    if (injectParkDecision) {
      // `park` acks the queue position instead of refusing. A refusal is what makes the caller
      // re-inject, and re-injecting into a modal that is still up is how #743 turned one
      // blocked REPORT into three lost ones.
      if (injectParkDecision.action === 'park') {
        const op = parkOperationOnModal(id, session, {
          type: 'inject',
          prompt,
          noEnter: !!options.noEnter,
          injectId: options.injectId || null,     // #860 F2 — see the bootstrap-queue push above
          options: { source: options.source || 'inject', from: options.from || 'daemon' },
        }, injectParkDecision);
        parkTrackedInjection(options.injectId, 'bootstrap_queue', injectParkDecision.reason);
        session.lastActivityAt = new Date(now).toISOString();
        return modalParkResponse(op, injectParkDecision, {
          msg_id: op.op_id,
          pending: session.bootstrapQueue.length,
          submit: options.noEnter ? 'skipped' : 'queued',
        });
      }
      console.log(`[INJECT] ${id} refused — ${injectParkDecision.reason}`);
      return { success: false, httpStatus: 409, ...modalRejectionResponse(injectParkDecision) };
    }

    // Mailbox payload is TEXT ONLY — CR is sent separately after a delay.
    // Reason: combining text+CR in one write triggers bracketed paste mode in modern
    // terminals. CLIs ignore \r inside paste brackets, so Enter never fires.
    const from = options.from || 'daemon';
    const msgId = `${from}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;

    // #47 P4 — capability-gated delivery provenance banner (spec §6). Default-OFF: only sessions
    // that registered as provenance-capable (and have a minted nonce) get the nonce-gated banner;
    // legacy/byte-exact-sensitive sessions receive `prompt` byte-for-byte (regression guard). The
    // audit log below still hashes the RAW `prompt`, not the banner — provenance is a delivery
    // wrapper, not a content change. `from`='daemon'/'inject' are routing sentinels, not real
    // claimed senders, so they are not surfaced as a `claimed:` label.
    const claimedSender = (from && from !== 'daemon' && from !== 'inject') ? from : null;
    const deliveredPrompt = applyProvenance(prompt, {
      capable: !!(session && session.provenanceCapable),
      nonce: session && session.provenanceNonce,
      verified: options.verifiedSenderSid || null,
      claimed: claimedSender,
      origin: options.origin
    }).payload;

    // #716: wrap the delivered text in bracketed paste for paste-capable CLIs so the
    // deferred/gated submit CR (written separately, outside the 200~/201~ envelope)
    // reliably fires instead of being swallowed into the paste burst. No-op otherwise.
    const deliveredBody = maybeBracketedPaste(deliveredPrompt, session);

    // #107: the deferred CR below belongs to THIS text. Without a barrier, a second inject
    // arriving inside the submit delay writes its text first and the target reads
    // text1 text2 CR CR — one glued line (and the bridge's #720 filter then drops the second,
    // now consecutive, CR as a duplicate). Wait for any earlier submit on this session, then
    // claim the barrier synchronously so a third inject queues behind this one.
    //
    // #109: the wait is bounded (SUBMIT_QUEUE_TIMEOUT_MS) and answered with a typed QUEUE_TIMEOUT
    // instead of the caller's own client timeout; nothing is enqueued for a timed-out caller.
    // After the wait (and resolveModalGate above) the id must still name THIS instance — a session
    // destroyed, renamed or recreated meanwhile gets SESSION_GONE, never the text.
    const queueDeadline = Date.now() + SUBMIT_QUEUE_TIMEOUT_MS;
    while (session.pendingSubmit) {
      const remaining = queueDeadline - Date.now();
      let timer;
      const timedOut = remaining <= 0 || await Promise.race([
        session.pendingSubmit.then(() => false),
        new Promise((resolve) => { timer = setTimeout(resolve, remaining, true); })
      ]);
      clearTimeout(timer);
      if (timedOut) {
        return { success: false, httpStatus: 503, code: 'QUEUE_TIMEOUT',
          error: `Earlier submits on this session did not clear within ${SUBMIT_QUEUE_TIMEOUT_MS} ms; nothing was written. Retry.` };
      }
    }
    if (!isSameSessionInstance(id, session, sessionEpoch) || session.ownerWs !== entryOwnerWs) return sessionGoneResult();
    const liveFailure = getInjectFailure(session, { nowMs: Date.now() });
    if (liveFailure) return { success: false, ...liveFailure };
    let releaseSubmit = () => {};
    if (!options.noEnter && session.type !== 'aterm') {
      session.pendingSubmit = new Promise((resolve) => {
        releaseSubmit = () => { session.pendingSubmit = null; resolve(); };
      });
    }

    try {
      const ack = getMailbox().enqueue({
        msg_id: msgId,
        from,
        to: id,
        payload: deliveredBody,
        created_at: Math.floor(now / 1000),
        attempt: 0,
      });
      injectionTargets.set(msgId, { session, sessionEpoch, ownerWs: entryOwnerWs });
      // Registered synchronously after the enqueue: no tick can run in between.
      const owesSubmit = !options.noEnter && session.type !== 'aterm';
      const textWait = owesSubmit ? awaitMailboxText(msgId, MAILBOX_TEXT_WAIT_MS) : null;

      // Notify aterm sessions immediately via UDS wake
      if (session.type === 'aterm') {
        getMailboxNotifier().notify(id);
      }

      // Deliver text synchronously — ensures text is written before inject returns success.
      try {
        await getMailboxDelivery().tick();
      } catch {}

      // Send CR separately after delay (outside paste brackets)
      if (owesSubmit) {
        const text = await textWait;
        if (!text.delivered) {
          // Not written in time. Withdraw it if no deliverer holds it, so it can never land later
          // without its CR and a retry cannot duplicate it; if one does hold it, say so.
          let withdrawn = false;
          try { withdrawn = getMailbox().withdraw(id, msgId, 'submit_unpaired: text not delivered in time'); } catch {}
          // Not withdrawable is not always "in flight" (review N1): a purge (session destroyed) leaves
          // no record and a dead-lettered message cannot be written any more either.
          let state;
          if (!withdrawn) { try { state = getMailbox().messageState(id, msgId); } catch {} }
          injectionTargets.delete(msgId);
          releaseSubmit();
          if (!withdrawn && state === null) return { ...sessionGoneResult(), msg_id: msgId };
          const failure = text.lastFailure;
          return withdrawn || state === 'dead_letter'
            ? { success: false, httpStatus: (failure && failure.httpStatus) || 504, code: (failure && failure.code) || 'TIMEOUT',
              error: `The text was not delivered within ${MAILBOX_TEXT_WAIT_MS} ms${failure && failure.error ? ` (${failure.error})` : ''}; it was ${withdrawn ? 'withdrawn' : 'dead-lettered'} and will not be written. Retry.`,
              msg_id: msgId }
            : { success: false, httpStatus: 504, code: 'DELIVERY_UNCERTAIN',
              error: `The text was handed to delivery but not confirmed within ${MAILBOX_TEXT_WAIT_MS} ms; it may still arrive, without a CR. Do not retry blindly.`,
              msg_id: msgId };
        }
        const submitDelay = session.type === 'wrapped' ? 500 : 300;
        setTimeout(async () => {
          let submitResult;
          try {
            // #109: never a bare CR into an instance that did not get this inject's text.
            // PR #108 TP1: nor into an owner socket other than the one that got it.
            submitResult = isLiveSessionInstance(session, sessionEpoch) && session.ownerWs === text.ownerWs
              ? await writeDataToSession(id, session, '\r')
              : sessionGoneResult();
          } finally {
            releaseSubmit();
          }
          if (!submitResult.success) {
            emitInjectFailureEvent(id, submitResult.code, submitResult.error, {
              phase: 'submit',
              source: options.source || 'inject'
            }, session);
          }
        }, submitDelay);
      }

      session.lastActivityAt = new Date(now).toISOString();
      return {
        success: true,
        msg_id: msgId,
        queued: ack.queued,
        pending: ack.pending,
        strategy: 'mailbox',
        submit: options.noEnter ? 'skipped' : 'deferred'
      };
    } catch (err) {
      console.error(`[MAILBOX] Enqueue failed for ${id}: ${err.message}`);
      // Fallback: direct delivery (backward compat during migration)
      injectionTargets.delete(msgId);
      if (!isSameSessionInstance(id, session, sessionEpoch) || session.ownerWs !== entryOwnerWs) { releaseSubmit(); return sessionGoneResult(); }
      const textOwnerWs = session.ownerWs;
      const textResult = await writeDataToSession(id, session, deliveredBody);
      if (!textResult.success) { releaseSubmit(); return textResult; }

      if (!options.noEnter && session.type !== 'aterm') {
        const submitDelay = session.type === 'wrapped' ? 500 : 300;
        setTimeout(async () => {
          let submitResult;
          try {
            // #109: never a bare CR into an instance that did not get this inject's text.
            // PR #108 TP1: nor into an owner socket other than the one that got it.
            submitResult = isLiveSessionInstance(session, sessionEpoch) && session.ownerWs === textOwnerWs
              ? await writeDataToSession(id, session, '\r')
              : sessionGoneResult();
          } finally {
            releaseSubmit();
          }
          if (!submitResult.success) {
            emitInjectFailureEvent(id, submitResult.code, submitResult.error, {
              phase: 'submit',
              source: options.source || 'inject'
            }, session);
          }
        }, submitDelay);
      }

      session.lastActivityAt = new Date(now).toISOString();
      return {
        success: true,
        strategy: 'direct_fallback',
        submit: options.noEnter ? 'skipped' : 'deferred'
      };
    }
  }


  const resolveMailboxSocket = (sessionId) => {
    const session = sessions[sessionId];
    if (!session || session.type !== 'aterm') return null;
    return (session.delivery && session.delivery.transport === 'unix_socket' && session.delivery.address) || null;
  };

  const mailboxDeliveryOptions = {
    pollMs: 200,
    sessionResolver: () => Object.keys(sessions),
    deliverFn: async (sessionId, msg) => {
      const session = sessions[sessionId];
      if (!session) return { success: false, error: 'Session not found' };
      const target = injectionTargets.get(msg.msg_id);
      if (target && (!isSameSessionInstance(sessionId, target.session, target.sessionEpoch)
          || session.ownerWs !== target.ownerWs)) {
        injectionTargets.delete(msg.msg_id);
        getMailbox().withdraw(sessionId, msg.msg_id, 'session_gone', { inFlight: true });
        const waiter = mailboxTextWaiters.get(msg.msg_id);
        if (waiter) waiter.lastFailure = sessionGoneResult();
        return sessionGoneResult();
      }
      const ownerWs = session.ownerWs;
      const result = await writeDataToSession(sessionId, session, msg.payload);
      const waiter = mailboxTextWaiters.get(msg.msg_id);
      if (waiter) {
        if (result.success) waiter.settle(ownerWs);
        else waiter.lastFailure = result;
      }
      if (result.success) {
        injectionTargets.delete(msg.msg_id);
        session.lastActivityAt = new Date().toISOString();
      }
      return result;
    },
    onDelivery: (sessionId, msgId, result) => {
      if (injectionTargets.has(msgId)) {
        const state = getMailbox().messageState(sessionId, msgId);
        if (state === null || state === 'dead_letter') injectionTargets.delete(msgId);
      }
      const session = sessions[sessionId];
      if (!session) return;
      if (result.success) {
        broadcastSessionEvent('mailbox_delivered', sessionId, session, {
          extra: { msg_id: msgId }
        });
      } else {
        broadcastSessionEvent('mailbox_delivery_failed', sessionId, session, {
          extra: { msg_id: msgId, error: result.error }
        });
      }
    },
  };

  return { writeDataToSession, deliverInjectionToSession, resolveMailboxSocket, mailboxDeliveryOptions };
}

module.exports = { createSessionDeliveryContext };
