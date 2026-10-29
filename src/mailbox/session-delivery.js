'use strict';
const { createBoundedUdsResponse } = require('./uds-response');
const { protectedInputFailure, externalApprovalVerifier } = require('../external-approval');
const { sshInputFailure, requestSshWrite } = require('../ssh-session');

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
  async function writeDataToSession(id, session, data, { beforeWrite } = {}) {
    if (session.isClosing) return { success: false, httpStatus: 409, code: 'SESSION_CLOSING', error: 'Session is closing', bytes_written: 0 };
    const denied = protectedInputFailure(session);
    if (denied) return denied;
    const sshFailure = sshInputFailure(session, data);
    if (sshFailure) return sshFailure;
    if (session.type === 'mailbox') return { success: false, httpStatus: 409, code: 'POLL_ONLY', error: 'Mailbox sessions accept queued text only.' };
    if (hasHeldInteraction(session)) return { success: false, httpStatus: 409,
      code: 'INTERACTION_HELD', error: 'Original task retained pending measured composer readiness.', bytes_written: 0 };
    interaction.invalidateInteraction(session, 'automated_input');
    if (session.type === 'aterm') {
      // UDS delivery via net.connect()
      if (session.delivery && session.delivery.transport === 'unix_socket' && session.delivery.address) {
        return new Promise((resolve) => {
          const payload = JSON.stringify({ action: "Inject", workspace: id, text: data }) + '\n';
          const response = createBoundedUdsResponse();
          let settled = false, attempted = false;
          const finish = result => { if (settled) return; settled = true; clearTimeout(timeout); resolve(result); };
          const timeout = setTimeout(() => {
            finish(buildErrorBody('TIMEOUT', 'UDS delivery timed out.', { httpStatus: 504, delivery_uncertain: attempted, bytes_written: attempted ? null : 0 }));
            sock.destroy();
          }, DELIVERY_TIMEOUT_MS);
          const sock = net.connect(session.delivery.address, () => {
            if (settled) return;
            if (session.isClosing || sessions[id] !== session) {
              finish({ success: false, httpStatus: 409, code: 'SESSION_CLOSING', error: 'Session is closing', bytes_written: 0 });
              sock.destroy();
              return;
            }
            try {
              if (beforeWrite && beforeWrite() !== true) {
                finish(buildErrorBody('TRACKING_PERSISTENCE_FAILED', 'UDS attempt could not be durably fenced; nothing written.', { httpStatus: 503, bytes_written: 0 }));
                sock.destroy(); return;
              }
              attempted = true;
              sock.end(payload);
            } catch {
              finish(buildErrorBody(attempted ? 'DELIVERY_UNCERTAIN' : 'TRACKING_PERSISTENCE_FAILED',
                attempted ? 'UDS write outcome unknown; do not retry blindly.' : 'UDS attempt could not be durably fenced; nothing written.',
                { httpStatus: 503, delivery_uncertain: attempted, bytes_written: attempted ? null : 0 }));
              sock.destroy();
            }
          });
          sock.on('data', (chunk) => {
            if (settled) return;
            if (!response.append(chunk)) {
              finish(buildErrorBody('DELIVERY_RESPONSE_TOO_LARGE', 'UDS response exceeded 65536 bytes; delivery outcome is uncertain.',
                { httpStatus: 502, delivery_uncertain: true, bytes_written: null }));
              sock.destroy();
            }
          });
          sock.on('end', () => {
            if (settled) return;
            const responseBuf = response.text();
            if (responseBuf) {
              try {
                const resp = JSON.parse(responseBuf.trim());
                if (resp.status === 'Error' || resp.success === false) {
                  console.log(`[UDS] Delivery rejected by ${id}: ${resp.error || resp.message || 'unknown'}`);
                  finish(buildErrorBody('DELIVERY_REJECTED', resp.error || resp.message || 'Target rejected the payload.', {
                    httpStatus: 502,
                    detail: resp, delivery_uncertain: attempted, bytes_written: attempted ? null : 0
                  }));
                  return;
                }
              } catch {
                // Non-JSON response — treat as success (legacy endpoints)
              }
            } else {
              console.log(`[UDS] Empty response from ${id} — delivery unconfirmed (aterm may not have processed)`);
            }
            finish({ success: true });
          });
          sock.on('error', (err) => {
            if (settled) return;
            console.log(`[UDS] Connection error for ${id} at ${session.delivery.address}: ${err.message}`);
            markSessionDisconnected(session);
            finish(buildErrorBody(attempted ? 'DELIVERY_UNCERTAIN' : 'DISCONNECTED', attempted ? 'UDS response failed after a write attempt; delivery outcome unknown.' : 'UDS endpoint is unreachable.', {
              httpStatus: 503, delivery_uncertain: attempted, bytes_written: attempted ? null : 0, detail: err.message
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
      if (session.sshRemote) return requestSshWrite(session, data);
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
    return !session.isClosing && sessions[id] === session && (session.sessionEpoch || null) === sessionEpoch;
  }

  // #109 review 1 B1: the deferred CR follows the INSTANCE, not the id. A rename moves the same
  // live record to `session.id` (same PTY, owner, epoch) — that record got the text, so it gets the
  // CR. Destroy/recreate leave the record unregistered; owner replacement changes the epoch.
  function isLiveSessionInstance(session, sessionEpoch) {
    return !session.isClosing && sessions[session.id] === session && (session.sessionEpoch || null) === sessionEpoch;
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
  const immediateAttempts = new Map(); // only while the source is awaiting its immediate tick
  const mailboxTextWaiters = new Map(); // msg_id → { settle(ownerWs), lastFailure }

  function awaitMailboxText(msgId, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { lastFailure: null };
      const timer = setTimeout(() => {
        mailboxTextWaiters.delete(msgId);
        resolve({ delivered: false, lastFailure: waiter.lastFailure });
      }, timeoutMs);
      waiter.notWritten = result => {
        clearTimeout(timer); mailboxTextWaiters.delete(msgId); resolve({ delivered: false, lastFailure: result, retryPending: true });
      };
      waiter.uncertain = result => {
        clearTimeout(timer); mailboxTextWaiters.delete(msgId); resolve({ delivered: false, lastFailure: result });
      };
      waiter.settle = (ownerWs) => {
        clearTimeout(timer);
        mailboxTextWaiters.delete(msgId);
        resolve({ delivered: true, ownerWs });
      };
      mailboxTextWaiters.set(msgId, waiter);
    });
  }

  async function deliverApprovedInjection(id, session, prompt, options) {
    const epoch = session.sessionEpoch || null;
    const ownerWs = session.ownerWs;
    const ownerGeneration = session.interactionOwnerGeneration || null;
    const gone = () => !isSameSessionInstance(id, session, epoch) || session.isClosing || session.sshRemote
      || session.ownerWs !== ownerWs || (session.interactionOwnerGeneration || null) !== ownerGeneration;
    const reject = (code, error, httpStatus = 403) => ({ success: false, code, error, httpStatus, bytes_written: 0 });
    if (session.sshRemote) return reject('SSH_APPROVAL_TRANSPORT_UNSUPPORTED', 'Protected SSH inject requires a bound SSH write receipt adapter.');
    if (session.type !== 'wrapped') return reject('APPROVAL_INGRESS_UNSUPPORTED', 'Signed inject currently supports wrapped sessions only.');
    const deadline = Date.now() + SUBMIT_QUEUE_TIMEOUT_MS;
    while (session.pendingSubmit) {
      const remaining = deadline - Date.now();
      let timer;
      const expired = remaining <= 0 || await Promise.race([session.pendingSubmit.then(() => false),
        new Promise(resolve => { timer = setTimeout(resolve, remaining, true); })]);
      clearTimeout(timer);
      if (expired) return reject('QUEUE_TIMEOUT', 'Earlier submits did not clear; no approved text was written.', 503);
      if (gone()) return sessionGoneResult();
    }
    if (gone()) return sessionGoneResult();
    const failure = getInjectFailure(session, { nowMs: Date.now() });
    if (failure) return { success: false, ...failure };
    if (shouldQueueBootstrapOperation(session) || hasHeldInteraction(session)) {
      return reject('APPROVAL_TARGET_NOT_READY', 'Protected inject cannot be parked or retained for later delivery.', 409);
    }
    const modal = await resolveModalGate(id, session, options);
    if (gone()) return sessionGoneResult();
    if (!isOpenWebSocket(ownerWs)) return reject('DISCONNECTED', 'Session owner disconnected.', 503);
    if (session.pendingSubmit) return reject('QUEUE_BUSY', 'Another approved write claimed the submit barrier; retry with this unspent approval.', 503);
    if (modal || hasHeldInteraction(session) || hasBootstrapBacklog(session) || session.bootstrapDraining) {
      return reject('APPROVAL_TARGET_NOT_READY', 'Protected inject requires a clear surface and empty bootstrap queue.', 409);
    }
    const submitDelay = 500;
    const approval = options.externalApproval;
    if (!options.noEnter && approval.document?.expires_at <= Date.now() + submitDelay) {
      return reject('APPROVAL_EXPIRED', 'Approval must remain valid through the deferred submit.');
    }
    const checked = externalApprovalVerifier.verifyAndConsume(session, {
      operation: 'inject', no_enter: !!options.noEnter,
      payload_sha256: crypto.createHash('sha256').update(prompt).digest('hex')
    }, approval.document, approval.signature);
    if (!checked.ok) return reject(checked.code, 'External signer approval was refused.');
    let release = () => {};
    if (!options.noEnter) session.pendingSubmit = new Promise(resolve => {
      release = () => { session.pendingSubmit = null; resolve(); };
    });
    try {
      // Signature covers prompt bytes; transport paste framing carries no extra text.
      const data = maybeBracketedPaste(prompt, session);
      interaction.invalidateInteraction(session, 'external_approved_input');
      ownerWs.send(JSON.stringify({ type: 'inject', data }));
      armUpstreamProbe(session);
      if (!options.noEnter) setTimeout(() => {
        try {
          if (gone() || !isOpenWebSocket(ownerWs) || Date.now() >= approval.document.expires_at) {
            emitInjectFailureEvent(id, 'SESSION_GONE', 'Protected submit binding or approval expired.', { phase: 'submit' }, session);
          } else {
            ownerWs.send(JSON.stringify({ type: 'inject', data: '\r' }));
            armUpstreamProbe(session);
          }
        } catch {
          emitInjectFailureEvent(id, 'DELIVERY_UNCERTAIN', 'Approved submit could not be confirmed.', { phase: 'submit' }, session);
        } finally { release(); }
      }, submitDelay);
      session.lastActivityAt = new Date().toISOString();
      return { success: true, strategy: 'external_approved_owner_write', approved: true,
        queued: false, submit: options.noEnter ? 'skipped' : 'deferred' };
    } catch {
      release();
      return reject('DELIVERY_UNCERTAIN', 'Approved owner write could not be confirmed; approval cannot be reused.', 503);
    }
  }

  async function deliverInjectionToSession(id, session, prompt, options = {}) {
    if (session.isClosing) return { success: false, httpStatus: 409, code: 'SESSION_CLOSING', error: 'Session is closing', bytes_written: 0 };
    const denied = protectedInputFailure(session);
    if (denied) return options.externalApproval
      ? deliverApprovedInjection(id, session, prompt, options) : denied;
    const sshFailure = sshInputFailure(session, prompt);
    if (sshFailure) return sshFailure;
    const sshGeneration = session.sshState?.generation;
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
    const modalDecision = session.type === 'mailbox' ? null : await resolveModalGate(id, session, options);
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
    const deliveredBody = session.type === 'mailbox' ? deliveredPrompt : maybeBracketedPaste(deliveredPrompt, session);

    if (session.type === 'mailbox') {
      try {
        const ack = getMailbox().enqueue({ msg_id: msgId, from, to: id, payload: deliveredBody,
          created_at: Math.floor(now / 1000), attempt: 0 });
        parkTrackedInjection(options.injectId, 'mailbox', 'poll_pending');
        session.lastActivityAt = new Date(now).toISOString();
        return { success: true, msg_id: msgId, strategy: 'mailbox', poll_only: true,
          queued: true, delivered: false, bytes_written: 0, pending: ack.pending, submit: 'not_applicable' };
      } catch (error) {
        return { success: false, httpStatus: 503, code: 'MAILBOX_ENQUEUE_FAILED', error: 'Mailbox enqueue failed.' };
      }
    }

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

    let enqueueAttempted = false;
    try {
      if (session.sshRemote) {
        const failure = sshInputFailure(session, deliveredBody, sshGeneration);
        if (failure) { releaseSubmit(); return failure; }
        const text = await requestSshWrite(session, deliveredBody, { expectedGeneration: sshGeneration });
        if (!text.success) { releaseSubmit(); return text; }
        if (!options.noEnter) {
          await new Promise(resolve => setTimeout(resolve, 500));
          if (!isSameSessionInstance(id, session, sessionEpoch) || session.ownerWs !== entryOwnerWs) { releaseSubmit(); return sessionGoneResult(); }
          const submit = await requestSshWrite(session, '\r', { expectedGeneration: sshGeneration });
          if (!submit.success) { releaseSubmit(); return { ...submit, text_written: true, text_bytes_written: text.bytes_written,
            error: `Text was written to the SSH child, but submit was not confirmed. Do not retry blindly. ${submit.error}` }; }
        }
        releaseSubmit();
        session.lastActivityAt = new Date().toISOString();
        return { ...text, submit: options.noEnter ? 'skipped' : 'written', queued: false, consumption: 'unknown' };
      }
      const mailboxForEnqueue = getMailbox();
      enqueueAttempted = true;
      const ack = mailboxForEnqueue.enqueue({
        msg_id: msgId,
        from,
        to: id,
        payload: deliveredBody,
        created_at: Math.floor(now / 1000),
        attempt: 0,
      });
      const immediate = { result: null }; immediateAttempts.set(msgId, immediate);
      injectionTargets.set(msgId, { session, sessionEpoch, ownerWs: entryOwnerWs });
      // Registered synchronously after the enqueue: no tick can run in between.
      const owesSubmit = !options.noEnter && session.type !== 'aterm';
      const waitsForText = owesSubmit || session.type === 'aterm';
      const textWait = waitsForText ? awaitMailboxText(msgId, MAILBOX_TEXT_WAIT_MS) : null;

      // Notify aterm sessions immediately via UDS wake
      if (session.type === 'aterm') {
        getMailboxNotifier().notify(id);
      }

      // Deliver text synchronously — ensures text is written before inject returns success.
      try {
        await getMailboxDelivery().tick();
      } catch {}
      immediateAttempts.delete(msgId);
      if (immediate.result?.delivery_uncertain) {
        injectionTargets.delete(msgId); releaseSubmit();
        return { ...immediate.result, success: false, code: 'DELIVERY_UNCERTAIN', msg_id: msgId, retryable: false,
          error: 'Delivery outcome unknown after an attempt; automatic retry disabled. Do not retry blindly.', submit: 'skipped' };
      }

      // Send CR separately after delay (outside paste brackets)
      if (waitsForText) {
        const text = await textWait;
        if (!text.delivered) {
          if (text.retryPending && session.type === 'aterm') return { success: true, queued: true, msg_id: msgId, pending: ack.pending,
            strategy: 'mailbox', delivery_status: 'retry_pending', bytes_written: 0, submit: 'skipped' };
          if (text.lastFailure?.delivery_uncertain) {
            injectionTargets.delete(msgId); releaseSubmit();
            return { ...text.lastFailure, success: false, code: 'DELIVERY_UNCERTAIN', msg_id: msgId, retryable: false, submit: 'skipped',
              error: 'Delivery outcome unknown after an attempt; automatic retry disabled. Do not retry blindly.' };
          }
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
          const failure = text.lastFailure;
          if (!withdrawn && !(state === 'dead_letter' && failure && (failure.bytes_written === 0 || failure.code === 'SESSION_GONE'))) {
            try { getMailbox().withdraw(id, msgId, 'delivery_outcome_unknown_at_caller_timeout', { inFlight: true, deliveryUncertain: true }); } catch {}
            return { success: false, httpStatus: state === null ? 410 : 504, code: state === null ? 'SESSION_GONE' : 'DELIVERY_UNCERTAIN',
              delivery_uncertain: true, retryable: false, bytes_written: null, submit: 'skipped', msg_id: msgId,
              error: 'Delivery was not confirmed before the caller deadline; outcome unknown and automatic retry disabled. Do not retry blindly.' };
          }
          return { success: false, httpStatus: (failure && failure.httpStatus) || 504, code: (failure && failure.code) || 'TIMEOUT',
            error: withdrawn ? 'Pending text was withdrawn before delivery; nothing was written.' : 'Delivery was refused before text was written.',
            msg_id: msgId, bytes_written: 0 };
        }
        if (owesSubmit) {
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
      if (session.sshRemote) {
        releaseSubmit();
        return { success: false, httpStatus: 504, code: 'SSH_WRITE_UNCONFIRMED',
          error: 'SSH delivery could not be confirmed; input may have been written. Do not retry blindly.' };
      }
      console.error(`[MAILBOX] Enqueue/delivery path failed for ${id}; no blind retry will be attempted`);
      // Once enqueue succeeded an exception cannot authorize a second physical attempt.
      immediateAttempts.delete(msgId);
      if (enqueueAttempted) {
        try { getMailbox().withdraw(id, msgId, 'delivery_outcome_unknown', { inFlight: true, deliveryUncertain: true }); } catch {}
        injectionTargets.delete(msgId); releaseSubmit();
        return { success: false, code: 'DELIVERY_UNCERTAIN', httpStatus: 503, delivery_uncertain: true, retryable: false, bytes_written: null, msg_id: msgId,
          error: 'Delivery outcome unknown after enqueue; no direct retry was attempted.', submit: 'skipped' };
      }
      // Fallback only when the mailbox could not even be obtained: enqueue was never called.
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
    sessionResolver: () => Object.keys(sessions).filter(id => !sessions[id].isClosing && sessions[id].type !== 'mailbox'),
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
      const beforeWrite = session.type === 'aterm' && session.delivery?.transport === 'unix_socket'
        ? () => getMailbox().beginNonRetryableAttempt(sessionId, msg.msg_id) : undefined;
      const result = await writeDataToSession(sessionId, session, msg.payload, { beforeWrite });
      const immediate = immediateAttempts.get(msg.msg_id); if (immediate) immediate.result = result;
      const waiter = mailboxTextWaiters.get(msg.msg_id);
      if (waiter) {
        if (result.success) waiter.settle(ownerWs);
        else if (result.delivery_uncertain) waiter.uncertain(result);
        else if (session.type === 'aterm') waiter.notWritten(result);
        else waiter.lastFailure = result;
      }
      if (result.success) {
        injectionTargets.delete(msg.msg_id);
        session.lastActivityAt = new Date().toISOString();
      }
      return result;
    },
    onDelivery: (sessionId, msgId, result) => {
      if (result.delivery_uncertain) {
        const immediate = immediateAttempts.get(msgId); if (immediate) immediate.result = result;
        const waiter = mailboxTextWaiters.get(msgId); if (waiter) waiter.uncertain(result);
      }
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
        broadcastSessionEvent(result.delivery_uncertain ? 'mailbox_delivery_unknown' : 'mailbox_delivery_failed', sessionId, session, {
          extra: { msg_id: msgId, error: result.delivery_uncertain ? 'Delivery outcome unknown; automatic retry disabled.' : result.error, ...(result.delivery_uncertain ? { delivery_uncertain: true, outcome: 'unknown', retryable: false } : {}) }
        });
      }
    },
  };

  return { writeDataToSession, deliverInjectionToSession, resolveMailboxSocket, mailboxDeliveryOptions };
}

module.exports = { createSessionDeliveryContext };
