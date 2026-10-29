// Production session actions. Keep non-strict semantics of the original daemon bodies.
// shared supplies lazy access to the daemon's actual stores and producers.
// effects is constructor-only: timer scheduling, lifecycle signal/sleep/liveness options,
// cleanup root/child-CPU exec options, and prompt-screen/clock/sleep captures.
// Domain producers remain real.
function createSessionActions(shared, effects = {}) {
  function scheduleTimeout(...args) {
    return (effects.setTimeout || globalThis.setTimeout)(...args);
  }

  function buildAutoSummaryWithDefaults(session) {
    return (0, shared.buildAutoSummary)(session, {
      maxLines: shared.REPORT_AUTO_SUMMARY_LINES,
      maxBytes: shared.REPORT_AUTO_SUMMARY_MAX_BYTES
    });
  }

  function observationIdentity(kind, cause) {
    return `${kind}|${cause == null ? '' : cause}`;
  }

  function markAbsenceDeliveredToSource(record, identity) {
    let delivered = shared.deliveredAbsenceIdentities.get(record);
    if (!delivered) {
      delivered = new Set();
      shared.deliveredAbsenceIdentities.set(record, delivered);
    }
    if (delivered.has(identity)) return true;
    delivered.add(identity);
    return false;
  }

  function recordObservation({
    sessionId,
    session,
    pendingReport,
    destination,
    cause,
    evidence,
    deliverToSource = false,
    trigger,
    deps = {},
  }) {
    const _broadcast = deps.broadcastSessionEvent || shared.broadcastSessionEvent;
    const _sessions = deps.sessions || shared.sessions;
    const _resolveAlias = deps.resolveSessionAlias || shared.resolveSessionAlias;
    const _deliver = deps.deliverInjectionToSession || shared.deliverInjectionToSession;
    const nowIso = new Date().toISOString();

    const mapped = (0, shared.mapObservationCause)({ destination, cause, evidence });
    const observation = { kind: mapped.kind, trigger: mapped.cause, ...mapped.fields };
    if (trigger) observation.emitted_via = trigger;

    // #801 output marker, attached HERE rather than by widening mapObservationCause's evidence
    // whitelist. The whitelist is a contract — a name may not travel with evidence its cause row
    // did not require — and widening it would let every unrelated field leak into every row. This
    // is the one sanctioned exception, so it is made at the call site where it is visible.
    //
    // What these two fields say: a known error banner was MATCHED IN THE OUTPUT BYTES of this
    // turn, by detectIdleAfterError, scoped past the inject watermark. That is a measured fact
    // about output — the text was there. What they do NOT say, and must never be read as: that
    // the session failed, that the task failed, or that the inject went unprocessed. Those are
    // outcome claims and remain unmeasurable; this envelope still carries completion_fact:null
    // and terminal:false alongside them, and the observation's KIND is unchanged — a marker
    // cannot rename the measurement it rode in on.
    //
    // Without this, a CLI dying on a 529 and an unmeasured CLI printing the same banner emit
    // byte-identical observations: the daemon measured the difference and then discarded it,
    // which is the inverse of this release's thesis rather than an instance of it (§A4 —
    // capability gaps are reported, not erased).
    if (evidence && evidence.error_marker) {
      observation.error_marker = evidence.error_marker;
      if (evidence.error_detail) observation.error_detail = evidence.error_detail;
    }

    const injectId = pendingReport ? pendingReport.injectId : null;
    const record = injectId ? (0, shared.getTrackedInjection)(injectId) : null;

    const consumption = pendingReport
      ? (0, shared.classifyConsumption)(pendingReport, {
        echoObserved: deps.echoObserved === true,
        echoReason: deps.echoReason || null,
      })
      : { status: 'not_established', basis: 'no_tracked_inject' };

    // Duplicate suppression by observation identity. It suppresses the repeat NOTIFICATION; it is
    // not an authority gate, and it can never prevent a future genuine observation of a different
    // kind from being recorded.
    let result = 'observation_emitted';
    if (record) {
      const identity = observationIdentity(mapped.kind, mapped.cause);
      if (record.last_observation && observationIdentity(record.last_observation.kind, record.last_observation.trigger) === identity) {
        result = 'observation_duplicate';
      } else {
        // #843 — snapshot BEFORE the in-memory append, because the append is speculative until the
        // commit lands. Two defects rode on its absence, and they compounded:
        //   1. the failed-commit branch below used to `return` HERE, ahead of the broadcast, so a
        //      store that could not be written emitted NOTHING — no bus event, no source delivery.
        //      That is §A2 ("absence is emitted, never silence") violated inside the emitter written
        //      to enforce §A2, on the one condition an operator most needs to hear about;
        //   2. `appendLedgerObservation` had already moved `last_observation`, so the identity dedup
        //      then suppressed every RETRY of that same measurement as a duplicate of an append that
        //      never reached disk. The first attempt was silent and it silenced all the rest.
        // The rollback is what makes the retry meaningful; falling through to the broadcast is what
        // makes the failure audible. Neither alone is enough.
        const priorSeq = record.observation_seq;
        const priorLast = record.last_observation;
        const priorObservations = Array.isArray(record.observations) ? record.observations.slice() : [];
        const priorCapability = record.capability;
        shared.sessionPersistence.appendLedgerObservation(record, { ...observation, consumption_status: consumption.status }, nowIso);
        record.capability = { ...shared.CAPABILITY_STAGE_A, ...(record.capability || {}) };
        const committed = (0, shared.commitTrackedInjections)();
        if (!committed.ok) {
          record.observation_seq = priorSeq;
          record.last_observation = priorLast;
          record.observations = priorObservations;
          record.capability = priorCapability;
          result = 'tracking_persistence_failed';
          console.error(`[OBSERVE] ledger commit FAILED for ${injectId} (${committed.reason}) — `
            + `${observation.kind} was emitted on the bus but is NOT durable`);
        } else if (record.tracking_state === 'superseded') {
          result = 'tracking_superseded';
        }
      }
    } else if (injectId) {
      // A tracked inject whose record we cannot find (pre-v2, another daemon epoch, corrupt store).
      // Explicit, named, never silence.
      result = 'tracking_unavailable';
    }

    if (mapped.kind === 'unmapped_transition_cause') result = 'unmapped_transition_cause';

    const envelope = (0, shared.buildCompletionUnknown)({
      sessionId,
      injectId,
      observation,
      consumption,
      capability: record ? record.capability : shared.CAPABILITY_STAGE_A,
      observationSeq: record ? record.observation_seq : undefined,
    });

    // The bus always hears the absence, even when the ledger deduped or is unavailable — a
    // subscriber must never have to infer from silence.
    _broadcast('task_completion_unknown', sessionId, session, {
      timestamp: nowIso,
      extra: { ...envelope, tracking_result: result, source: pendingReport ? pendingReport.source : null },
    });

    if (deliverToSource && pendingReport && result !== 'observation_duplicate') {
      // gh#82(F): while there is no outcome protocol, only absences made of a daemon-measured
      // process/transport fact are PUSHED to the source; the screen-derived rows (pty_quiet, a
      // repeated-error pattern matched on spinner frames, …) fired on essentially every inject to a
      // Claude Code worker and were wrong every time. Gated BEFORE the #914 bookkeeping below,
      // because an absence that was never delivered must not be recorded as delivered. The bus
      // event above and the ledger append are unconditional, so the observation stays recorded and
      // queryable — and the suppression is logged, never silent.
      if (!(0, shared.shouldPushCompletionUnknown)(envelope)) {
        console.log(`[OBSERVE] ${sessionId}: ${observation.kind} NOT pushed to ${pendingReport.source} — `
          + 'screen-derived absence while outcome_protocol=unavailable (gh#82 F; recorded on the bus '
          + 'and in the ledger; TELEPTY_COMPLETION_UNKNOWN_PUSH=1 to push it anyway)');
        return result;
      }
      // #914: the source hears each DISTINCT absence once per inject. The bus above is
      // unconditional and the ledger below already recorded this observation — only the
      // notification is suppressed, and only for an identity this inject already sent.
      if (record && markAbsenceDeliveredToSource(record, observationIdentity(mapped.kind, mapped.cause))) {
        console.log(`[OBSERVE] ${sessionId}: ${observation.kind} already delivered for ${injectId} — not re-notifying source`);
        return result;
      }
      const srcId = _resolveAlias(pendingReport.source) || pendingReport.source;
      const srcSession = _sessions[srcId];
      if (srcSession) {
        _deliver(srcId, srcSession, (0, shared.formatCompletionUnknownText)(envelope), { noEnter: false, source: 'auto_report' });
        console.log(`[OBSERVE] ${sessionId} → ${srcId}: ${observation.kind} (${result}, via ${trigger || mapped.cause})`);
      }
    }
    return result;
  }

  function pendingReportHasSubmitEvidence(pendingReport) {
    return !!(pendingReport && (
      pendingReport.submitConfirmedAt ||
      pendingReport.sawWorkingAfterInject ||
      (pendingReport.submitConfirm && pendingReport.submitConfirm.accepted === true)
    ));
  }

  function maybeRecordInjectConsumption(pendingReport, fromState, toState, transitionSinceMs) {
    if (!pendingReport || pendingReport.injectConsumptionCandidate) return false;
    const candidate = {
      from: fromState,
      to: toState,
      sinceMs: transitionSinceMs,
      at: Number.isFinite(transitionSinceMs) ? new Date(transitionSinceMs).toISOString() : null,
    };
    if (!shared.completionObservation.isFreshBusyEdge(candidate, pendingReport.submitStartedAt)) return false;
    pendingReport.injectConsumptionCandidate = candidate;
    return true;
  }

  function maybeRecordLauncherConsumption(session, pendingReport, elapsedSinceInjectSec, nowMs) {
    if (!pendingReport || pendingReport.launcherWatermarkAt) return false;
    if (!session || session.type !== 'wrapped') return false;
    if (!pendingReport.submitExpected || !pendingReport.submitStartedAt) return false;
    const confirm = pendingReport.submitConfirm;
    if (!(confirm && confirm.accepted === true)) return false;
    const ringNow = Number.isFinite(session.outputRingTotalBytes) ? session.outputRingTotalBytes : 0;
    const ringAtInject = Number.isFinite(pendingReport.ringBytesAtInject) ? pendingReport.ringBytesAtInject : 0;
    if (ringNow <= ringAtInject) return false;
    if (!(elapsedSinceInjectSec >= shared.LAUNCHER_CONSUMPTION_MIN_SECONDS)) return false;
    pendingReport.launcherWatermarkAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
    pendingReport.launcherRingBytesDelta = ringNow - ringAtInject;
    pendingReport.launcherElapsedMs = Math.round(elapsedSinceInjectSec * 1000);
    return true;
  }

  function observeInjectEchoEvidence(pendingReport, session) {
    const echo = shared.submitGate.observeInjectEcho(session, pendingReport.injectedBodyPreview, {
      sinceBytes: Number.isFinite(pendingReport.ringBytesAtInject) ? pendingReport.ringBytesAtInject : null,
      stripAnsi: shared.stripAnsiState,
    });
    return { observed: echo.observed === true, reason: echo.reason };
  }

  function detectIdleAfterError(session, pendingReport) {
    if (!session || !pendingReport) return null;
    if (!Array.isArray(session.outputRing) || session.outputRing.length === 0) return null;
    if (!Number.isFinite(session.outputRingTotalBytes)) return null;
    if (!Number.isFinite(pendingReport.ringBytesAtInject)) return null;
    const appended = Math.max(0, session.outputRingTotalBytes - pendingReport.ringBytesAtInject);
    if (appended === 0) return null;
    const all = session.outputRing.join('');
    const verdict = shared.readyRegistry.detectSurfaceError(session.command, all.slice(Math.max(0, all.length - appended)));
    return verdict.errored === true ? verdict : null;
  }

  function fireAutoReport(targetId, targetSession, pendingReport, trigger, deps = {}) {
    const _now = deps.now || Date.now;
    const _setTimeout = deps.setTimeout || scheduleTimeout;
    const _sessions = deps.sessions || shared.sessions;
    const _pendingReports = deps.pendingReports || shared.pendingReports;
    // #48: live auto-state lookup for the settle recheck (DI for unit tests).
    const _getAutoState = deps.getAutoState || ((sid) => {
      const st = shared.sessionStateManager.getState(sid);
      return st && st.state ? st.state : null;
    });
    // #52: wrapped-child CPU sampler for the quiet-thinking recheck (DI for unit tests).
    const _sampleChildCpu = deps.sampleChildCpu || ((sess) =>
      (0, shared.sampleChildCpuSeconds)(sess ? (sess.ptyPid || (sess.ptyProcess && sess.ptyProcess.pid) || null) : null, effects.childCpu));

    const elapsedNum = (_now() - new Date(pendingReport.injectedAt).getTime()) / 1000;
    const elapsed = elapsedNum.toFixed(1);
    const liveSession = () => _sessions[targetId] || targetSession;

    // Resolve the measured cause for this entrance. The caller passes the state machine's own
    // normalized cause where it has one (deps.observationCause); otherwise the trigger names it.
    // Nothing here infers a cause from the destination state.
    const resolveCause = () => {
      if (deps.observationCause) return deps.observationCause;
      if (trigger === 'ready-signal') {
        const sess = liveSession();
        const kind = sess && sess.readyKind ? sess.readyKind : 'legacy_unqualified_ready';
        if (kind === 'composer_surface_observed') return 'ready_frame_composer_surface';
        if (kind === 'prompt_suffix_observed') return 'ready_frame_prompt_suffix';
        return 'ready_frame_legacy_unqualified';
      }
      return 'silence_timeout';
    };

    const emit = (extraEvidence = {}, extraDeps = {}) => {
      const sess = liveSession();
      const cause = resolveCause();
      const evidence = {
        elapsed_ms: Math.round(elapsedNum * 1000),
        silence_ms: Number.isFinite(deps.silenceMs) ? deps.silenceMs : Math.round(elapsedNum * 1000),
        ...(deps.observationEvidence || {}),
        ...extraEvidence,
      };
      if (cause.startsWith('ready_frame_')) {
        evidence.detector = (sess && sess.readyDetector) || 'unqualified';
        evidence.cli_key = (sess && sess.readyCliKey) || null;
      }
      // #545 reliability is no longer a promotion input — nothing here promotes. It is computed and
      // then DELIBERATELY NOT CARRIED on the emitted observation: §2.3 fixes each row's payload to
      // the fields that row requires, plus last_output_at and confidence, and mapObservationCause
      // drops everything else. Do not read the assignment below as "it becomes a field" — an earlier
      // version of this comment claimed exactly that, and the claim was false, which is the same
      // defect this release exists to remove.
      //
      // It stays computed because it is a real input to the local decisions above and is useful in
      // the log line, and because OSC 133 has never fired on real traffic (zero hits across 9 live
      // PTY captures and 15 fixtures) — so as an emitted field it would be permanently false, which
      // is noise rather than information.
      //
      // #801's surface-error verdict is the deliberate exception and IS carried; see recordObservation,
      // where it is attached explicitly rather than by widening the §2.3 whitelist. Neither signal may
      // change the observation's NAME — that is fixed by the measured cause.
      if (deps.idleEvidenceReliable !== undefined) evidence.idle_evidence_reliable = deps.idleEvidenceReliable;
      const _detectIdleAfterError = deps.detectIdleAfterError || detectIdleAfterError;
      const errorVerdict = _detectIdleAfterError(sess, pendingReport);
      if (errorVerdict) {
        evidence.error_marker = errorVerdict.reason;
        evidence.error_detail = errorVerdict.detail;
      }
      const echo = sess ? observeInjectEchoEvidence(pendingReport, sess) : { observed: false, reason: null };
      return recordObservation({
        sessionId: targetId,
        session: sess,
        pendingReport,
        destination: 'idle',
        cause,
        evidence,
        deliverToSource: true,
        trigger,
        deps: { ...deps, echoObserved: echo.observed, echoReason: echo.reason, ...extraDeps },
      });
    };

    // --- ready-signal dwell (#32): wait for the submit verdict before speaking ---------------
    if (trigger === 'ready-signal' && pendingReport.submitExpected) {
      if (pendingReportHasSubmitEvidence(pendingReport)) {
        // Submit already answered — the ready frame adds no new measurement. Named, not silent.
        return 'observation_duplicate';
      }
      const shouldWaitForSubmit = pendingReport.submitInProgress === true || elapsedNum < shared.AUTO_REPORT_MIN_REAL_SECONDS;
      if (shouldWaitForSubmit) {
        if (!pendingReport.readySignalTimer) {
          const floorDelayMs = Math.max(50, Math.ceil((shared.AUTO_REPORT_MIN_REAL_SECONDS - elapsedNum) * 1000));
          const delayMs = pendingReport.submitInProgress === true ? Math.min(250, Math.max(50, floorDelayMs)) : floorDelayMs;
          pendingReport.readySignalTimer = _setTimeout(() => {
            pendingReport.readySignalTimer = null;
            const currentPending = (0, shared.getPendingReport)(targetId, _pendingReports);
            if (!currentPending) return;
            fireAutoReport(targetId, liveSession(), currentPending, 'ready-signal', deps);
          }, delayMs);
        }
        console.log(`[OBSERVE] ${targetId} ready-frame observation deferred; awaiting submit verdict`);
        return 'observation_deferred';
      }
    }

    // --- #721 launcher watermark: telemetry only, never consumption --------------------------
    if (trigger === 'real-idle') {
      maybeRecordLauncherConsumption(liveSession(), pendingReport, elapsedNum, _now());
    }

    // --- #48/#52 settle debounce (follow-ups only; the initial unknown is already durable) ---
    if (!pendingReport.unconfirmedSettleDone) {
      if (pendingReport.unconfirmedSettleTimer) return 'observation_deferred'; // window already open
      const settleMs = Math.max(50, Math.round(shared.IDLE_UNCONFIRMED_SETTLE_SECONDS * 1000));
      const armSettle = () => {
        const liveAtArm = liveSession();
        const activityAtArm = liveAtArm ? liveAtArm.lastActivityAt : null;
        const cpuAtArm = _sampleChildCpu(liveAtArm); // #52: null when unobservable
        pendingReport.unconfirmedSettleTimer = _setTimeout(() => {
          pendingReport.unconfirmedSettleTimer = null;
          const currentPending = (0, shared.getPendingReport)(targetId, _pendingReports);
          if (currentPending !== pendingReport) return;
          const autoState = _getAutoState(targetId);
          if (autoState === 'working' || autoState === 'thinking') {
            // Still busy: the quiet we were about to describe is gone. Nothing to state.
            console.log(`[OBSERVE] ${targetId} quiet observation dropped after settle — session is ${autoState}`);
            return;
          }
          const activityNow = liveSession() ? liveSession().lastActivityAt : null;
          if (activityNow !== activityAtArm
              && (pendingReport.unconfirmedSettleRearms || 0) < shared.IDLE_UNCONFIRMED_SETTLE_MAX_REARMS) {
            pendingReport.unconfirmedSettleRearms = (pendingReport.unconfirmedSettleRearms || 0) + 1;
            armSettle();
            return;
          }
          const cpuNow = _sampleChildCpu(liveSession());
          if (cpuAtArm != null && cpuNow != null
              && (cpuNow - cpuAtArm) >= shared.IDLE_UNCONFIRMED_CPU_DELTA_SECONDS
              && (pendingReport.unconfirmedCpuRearms || 0) < shared.IDLE_UNCONFIRMED_CPU_MAX_REARMS) {
            pendingReport.unconfirmedCpuRearms = (pendingReport.unconfirmedCpuRearms || 0) + 1;
            armSettle();
            return;
          }
          pendingReport.unconfirmedSettleDone = true;
          fireAutoReport(targetId, liveSession() || targetSession, currentPending, trigger, deps);
        }, settleMs);
      };
      armSettle();
      console.log(`[OBSERVE] ${targetId} quiet at ${elapsed}s (trigger=${trigger}) — settling ${shared.IDLE_UNCONFIRMED_SETTLE_SECONDS}s before the follow-up observation`);
      return 'observation_deferred';
    }

    // --- emit. Consumption is a FIELD here, never a gate. -----------------------------------
    return emit();
  }

  function normalizeNullableText(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  function scheduleQueuedRedeliver(id, session, injectedBody, opts = {}) {
    if (!shared.REDELIVER_ENABLED) return;
    if (!injectedBody || injectedBody.length === 0) return;
    if (!session) return;
    // One in-flight redeliver per session — never stack idle-watchers for the same composer.
    if (session._redeliverInFlight) return;
    session._redeliverInFlight = true;

    const emitSubmitBus = typeof opts.emitSubmitBus === 'function' ? opts.emitSubmitBus : () => {};
    const knownConsumption = opts.knownConsumption || null;

    const isParked = () =>
      shared.submitGate.observeBodyVisibility(session, injectedBody, { stripAnsi: shared.stripAnsiState }).visible === true;

    // Re-fire a bare CR (body already parked) then re-classify against a FRESH watermark:
    // the recipient is now idle, so a genuine idle→working/thinking turn is observable as
    // `consumed` (#53). A still-`queued` result means the CR did not fire the composer — retry.
    const fireCR = async () => {
      const strategy = await (0, shared.gatedTerminalSubmit)(id, session, injectedBody, true);
      if (!strategy) return { redelivered: false, reason: 'strategy_failed' };
      const submittedAtMs = Date.now();
      const sinceBytes = session.outputRingTotalBytes || 0;
      const c = await shared.submitGate.classifyInjectConsumption(session, injectedBody, {
        submittedAtMs,
        sinceBytes,
        getState: () => shared.sessionStateManager.getState(id),
        stripAnsi: shared.stripAnsiState,
      });
      return { redelivered: c.status === 'consumed', reason: c.reason };
    };

    const waitForIdle = (remainingMs) =>
      shared.submitGate.awaitReplReady(id, shared.sessionStateManager, {
        timeoutMs: Math.min(remainingMs, shared.REDELIVER_IDLE_WAIT_MS),
      });

    const run = async () => {
      // Force path skips the synchronous classify — establish the `queued` precondition here
      // before holding an idle-watcher. Only a busy-parked body needs rescue.
      if (knownConsumption !== 'queued') {
        if (Number.isFinite(opts.submittedAtMs)) {
          const c = await shared.submitGate.classifyInjectConsumption(session, injectedBody, {
            submittedAtMs: opts.submittedAtMs,
            sinceBytes: Number.isFinite(opts.ringBytesAtSubmit) ? opts.ringBytesAtSubmit : (session.outputRingTotalBytes || 0),
            getState: () => shared.sessionStateManager.getState(id),
            stripAnsi: shared.stripAnsiState,
          });
          if (c.status !== 'queued') return; // consumed / unknown — nothing to redeliver
        } else {
          return; // no watermark to classify against — cannot safely redeliver
        }
      }

      console.log(`[REDELIVER] ${id} inject queued on busy recipient — holding for idle to re-fire`);
      const result = await shared.submitGate.holdAndRedeliver({
        waitForIdle,
        isStillParked: isParked,
        fireCR,
        maxAttempts: shared.REDELIVER_MAX_ATTEMPTS,
        totalTimeoutMs: shared.REDELIVER_TOTAL_TIMEOUT_MS,
        onAttempt: ({ attempt }) =>
          console.log(`[REDELIVER] ${id} idle — re-firing queued inject (attempt ${attempt}/${shared.REDELIVER_MAX_ATTEMPTS})`),
        onExhausted: ({ reason, attempts }) => {
          console.log(`[REDELIVER] ${id} redeliver-exhausted (${reason}, attempts=${attempts})`);
          emitSubmitBus({ redeliver: 'exhausted', redeliver_reason: reason, redeliver_attempts: attempts });
        },
      });

      if (result.status === 'redelivered') {
        console.log(`[REDELIVER] ${id} queued inject redelivered after ${result.attempts} attempt(s)`);
        (0, shared.markPendingReportSubmitConfirmed)(id, { reason: 'redelivered', attempts: result.attempts });
        emitSubmitBus({ redeliver: 'redelivered', redeliver_attempts: result.attempts });
      } else if (result.status === 'already_consumed') {
        console.log(`[REDELIVER] ${id} queued inject already consumed (${result.reason}) — no re-fire`);
      }
    };

    Promise.resolve()
      .then(run)
      .catch((err) => console.log(`[REDELIVER] ${id} redeliver error: ${err && err.message}`))
      .finally(() => { session._redeliverInFlight = false; });
  }

  function parseSessionStateReport(session, payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return (0, shared.buildErrorBody)('INVALID_REQUEST', 'state report payload must be a JSON object', { httpStatus: 400 });
    }

    const phase = normalizeNullableText(payload.phase || payload.task_phase);
    if (!phase) {
      return (0, shared.buildErrorBody)('INVALID_REQUEST', 'phase is required', { httpStatus: 400 });
    }

    let seq;
    if (payload.seq === undefined || payload.seq === null || payload.seq === '') {
      seq = ((session && session.stateReport && session.stateReport.seq) || 0) + 1;
    } else {
      seq = Number(payload.seq);
      if (!Number.isInteger(seq) || seq < 0) {
        return (0, shared.buildErrorBody)('INVALID_REQUEST', 'seq must be a non-negative integer', { httpStatus: 400 });
      }
    }

    if (payload.needs_input !== undefined && typeof payload.needs_input !== 'boolean') {
      return (0, shared.buildErrorBody)('INVALID_REQUEST', 'needs_input must be a boolean', { httpStatus: 400 });
    }

    const source = normalizeNullableText(payload.source) || 'self_report';
    const timestamp = new Date().toISOString();
    return {
      success: true,
      report: {
        phase,
        current_task: normalizeNullableText(payload.current_task ?? payload.task),
        blocker: normalizeNullableText(payload.blocker),
        needs_input: payload.needs_input === true,
        thread_id: normalizeNullableText(payload.thread_id),
        source,
        seq,
        timestamp
      }
    };
  }

  function applySessionStateReport(sessionId, session, payload = {}) {
    const parsed = parseSessionStateReport(session, payload);
    if (!parsed.success) {
      return parsed;
    }

    const previous = Object.getOwnPropertyDescriptors(session);
    session.stateReport = parsed.report;
    session.lastStateReportAt = parsed.report.timestamp;
    if (parsed.report.thread_id) {
      session.lastThreadId = parsed.report.thread_id;
    }

    const saved = (0, shared.persistSessions)();
    if (!saved || !saved.ok) {
      if (!saved || !saved.committed) {
        for (const key of Object.keys(session)) delete session[key];
        Object.defineProperties(session, previous);
      }
      return { success: false, httpStatus: 503, code: 'SESSION_STORE_WRITE_FAILED', error: 'Session store write failed' };
    }

    const event = (0, shared.broadcastSessionEvent)('session_state_report', sessionId, session, {
      timestamp: parsed.report.timestamp
    });
    return {
      success: true,
      event,
      semantic: (0, shared.buildSessionSemanticBlock)(session),
      transport: (0, shared.buildSessionTransportBlock)(session, { nowMs: Date.parse(parsed.report.timestamp) })
    };
  }

  function emitSessionLifecycleEvent(type, sessionId, session, extra = {}) {
    const now = Date.now();
    (0, shared.broadcastSessionEvent)(type, sessionId, session, {
      nowMs: now,
      extra: {
        healthStatus: (0, shared.getSessionHealthStatus)(session, { nowMs: now }),
        healthReason: (0, shared.getSessionHealthReason)(session, (0, shared.getSessionHealthStatus)(session, { nowMs: now })),
        ...extra
      }
    });
  }

  function forceSubmitDeliveredToSurface(session, strategy) {
    return !!strategy;
  }

  function isTerminalGateFailure(gateResult) {
    return !!(
      gateResult &&
      gateResult.ready !== true &&
      gateResult.reason &&
      !shared.NON_TERMINAL_GATE_REASONS.has(gateResult.reason)
    );
  }

  function forceSubmitCrGapMs(injectedBody, session, env = process.env) {
    if (!injectedBody || !injectedBody.includes('\n')) return 0;
    if ((0, shared.maybeBracketedPaste)(injectedBody, session) !== injectedBody) return 0; // enveloped → immune
    // An UNSET or blank var must fall back to the default, never to 0 — `Number('')` is 0,
    // so a bare `TELEPTY_FORCE_CR_GAP_MS=` in an env file would silently disable the floor.
    const raw = String(env.TELEPTY_FORCE_CR_GAP_MS ?? '').trim();
    if (!raw) return shared.FORCE_CR_GAP_DEFAULT_MS;
    const configured = Number(raw);
    return Number.isFinite(configured) && configured >= 0 ? configured : shared.FORCE_CR_GAP_DEFAULT_MS;
  }

  async function teardownSessionById(id, options = {}) {
    const session = shared.sessions[id];
    if (!session) {
      return { success: false, httpStatus: 404, error: 'Session not found' };
    }

    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 5000));
    const force = options.force === true;
    const reason = options.reason || (force ? 'manual_force' : 'manual');
    session.isClosing = true;

    const kill = await shared.lifecycle.killSessionProcess(session, { ...effects.lifecycle, timeoutMs, force });
    emitSessionLifecycleEvent('session_closed', id, session, {
      reason,
      force,
      pid: kill.pid,
      signal: kill.signal || null,
      escalated: kill.escalated === true,
      source: options.source || 'daemon'
    });

    if (session.clients) {
      session.clients.forEach(ws => {
        try { ws.close(1000, 'Session destroyed'); } catch {}
      });
    }
    if (session.ownerWs) {
      try { session.ownerWs.close(1000, 'Session destroyed'); } catch {}
    }

    // Surface close is the orchestrator's job (Workspace Host adapter), per the 2026-05-30
    // verdict — this call is a NO-OP on the managed path. It actuates only for a standalone
    // telepty that opted in via AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1 (gate lives in closeSurface).
    try { shared.terminalBackend.closeSurface(session); } catch {}

    (0, shared.cancelModalParkPoll)(session);   // #760: a destroyed session must not keep polling its surface

    delete shared.sessions[id];
    (0, shared.revokeSessionCredential)(id);    // #815: kill path — the epoch dies with the instance
    shared.sessionStateManager.unregister(id);
    try { shared.mailbox.purge(id); } catch {}
    shared.lifecycle.cleanupSessionArtifacts(id, effects.cleanup);
    const saved = (0, shared.persistSessions)();
    if (!saved || !saved.ok) return { success: false, httpStatus: 503, code: 'SESSION_STORE_WRITE_FAILED',
      error: 'Session was removed but its removal was not durably saved', registry_removed: true, kill };

    return {
      success: true,
      session_id: id,
      status: 'closed',
      reason,
      force,
      timeout_ms: timeoutMs,
      kill
    };
  }

  function describeSessionTeardown(killError) {
    if (!killError) return { httpStatus: 200, body: { success: true, status: 'closing' } };
    return {
      httpStatus: 500,
      body: {
        success: false,
        code: 'KILL_FAILED',
        status: 'registry-removed-kill-unconfirmed',
        error: `Session teardown failed: ${killError.message || String(killError)}. `
          + 'The registry record was removed, so this process is no longer tracked by the daemon '
          + 'and may still be running.',
        registry_removed: true,
      },
    };
  }

  async function busAutoRoute(msg) {
    const eventType = msg.type || msg.kind;
    const isRoutable = (eventType === 'turn_request' || eventType === 'deliberation_route_turn') && (msg.target || msg.target_session_id);
    if (!isRoutable) {
      // Log all bus messages for debugging (excluding health checks)
      if (eventType && eventType !== 'session_health') {
        console.log(`[BUS] Event: ${eventType} (not routable)`);
      }
      return;
    }

    const rawTarget = (msg.target || msg.target_session_id).split('@')[0];
    const turnId = (msg.payload && msg.payload.turn_id) || null;
    console.log(`[BUS-ROUTE] ${eventType}: target=${rawTarget} turn=${turnId} msg_id=${msg.message_id || 'none'}`);
    const targetId = (0, shared.resolveSessionAlias)(rawTarget);
    const targetSession = targetId ? shared.sessions[targetId] : null;
    if (!targetSession) {
      console.log(`[BUS-ROUTE] Target ${rawTarget} not found among: ${Object.keys(shared.sessions).join(', ')}`);
      (0, shared.emitInjectFailureEvent)(rawTarget, 'SESSION_NOT_FOUND', 'Target session was not found.', {
        source: 'bus_auto_route',
        turn_id: turnId,
        original_message_id: msg.message_id || null
      });
      return;
    }

    const prompt = (msg.payload && msg.payload.prompt) || msg.content || msg.prompt || JSON.stringify(msg);
    const inject_id = shared.crypto.randomUUID();

    // #843 B — the THIRD write door, and until now the only one with no accountability at all.
    //
    // This writes into any session's PTY with exactly the authority of
    // `POST /api/sessions/:id/inject`, and it applied neither of that route's two rules: no
    // `classifyPeerLaneInject` verdict and no `auditAppend` line. Reproduced against one daemon:
    // the HTTP door refuses `from:'aigentry-coder-a' → victim` with 403 PEER_INJECT_BLOCKED and
    // records the attempt; the identical payload re-addressed to `POST /api/bus/publish` returned
    // 200, landed in the PTY, and left the audit log unchanged. A guardrail enforced at two doors
    // of three is not a guardrail — it is the false confidence this release exists to remove, and
    // #826 shipped believing there were two doors.
    //
    // The claimed sender is read ONLY from fields that name a session id. `msg.from` is the direct
    // analogue of `body.from`. `msg.source` is accepted only when it carries no `:` — the bus
    // envelope defines `source` as `project:session_id` (BUS_EVENT_SCHEMA.md), which is a different
    // namespace, and mapping it into the sid namespace would invent an identity and false-block
    // legitimate deliberation routing. An event that names no sender resolves to `null`, which
    // classifies as `no-sender` and is ALLOWED — deliberately the same answer the HTTP door gives a
    // body with no `from`. This is accountability parity, not a new restriction: the unattributed
    // bus route keeps working, and now it leaves a record.
    const busSource = typeof msg.source === 'string' && !msg.source.includes(':') ? msg.source : null;
    const claimedFrom = (typeof msg.from === 'string' && msg.from) || busSource || null;
    const peerVerdict = (0, shared.classifyPeerLaneInject)({
      from: claimedFrom, to: targetId, prompt, orchestratorSids: shared.ORCHESTRATOR_SIDS
    });
    const auditBusWrite = (deliveryResult) => (0, shared.auditAppend)({
      ts: new Date().toISOString(), inject_id, kind: 'inject', source: 'bus',
      claimed_from: claimedFrom,
      // The bus is not an authorization boundary — any local socket may publish to it with no
      // credential — so nothing arriving here is a verified identity. Absence, stated as absence.
      ...(0, shared.verifiedSenderFields)(null),
      to: targetId, to_alias: rawTarget !== targetId ? rawTarget : null,
      origin: 'trusted-local', origin_host: shared.MACHINE_ID, ref_path: null,
      payload: prompt, delivery_result: deliveryResult
    });

    if (peerVerdict.decision === 'block') {
      (0, shared.broadcastSessionEvent)('peer_inject_blocked', targetId, targetSession, {
        extra: {
          target_agent: targetId, from: claimedFrom, reason: peerVerdict.reason,
          attempted_kind: peerVerdict.kind, envelope_present: peerVerdict.envelopePresent,
          inject_id, source: 'bus_auto_route', turn_id: turnId
        }
      });
      auditBusWrite(`blocked:${peerVerdict.reason}`);
      console.warn(`[PEER-GUARD] blocked bus-route inject ${claimedFrom} → ${targetId} (${peerVerdict.reason})`);
      (0, shared.emitInjectFailureEvent)(targetId, 'PEER_INJECT_BLOCKED', `Peer-lane inject blocked: ${peerVerdict.reason}`, {
        source: 'bus_auto_route', turn_id: turnId, original_message_id: msg.message_id || null
      }, targetSession);
      return;
    }

    const delivery = await (0, shared.deliverInjectionToSession)(targetId, targetSession, prompt, {
      source: 'bus_auto_route'
    });
    const delivered = delivery.success === true;
    // #860 F2 — `queued` for an op parked on the bootstrap / modal queue: this route audits the bus
    // door, and a door that recorded a write which never happened is the gap #826 opened this log to
    // close.
    auditBusWrite(delivered ? (0, shared.deliveryAuditResult)(delivery) : `failed:${delivery.code || 'DELIVERY_FAILED'}`);
    if (!delivered) {
      (0, shared.emitInjectFailureEvent)(targetId, delivery.code, delivery.error, {
        source: 'bus_auto_route',
        turn_id: turnId,
        original_message_id: msg.message_id || null
      }, targetSession);
    }

    // #861 — `delivered` means BYTES WERE WRITTEN, and a park writes none.
    //
    // `bootstrapQueuedResponse` returns `success: true` for an op parked on the bootstrap /
    // surface-modal queue, so `delivery.success` cannot carry this field on its own. #860 made the
    // audit log say `queued` for exactly that case and this event went on saying `delivered: true`
    // about the same inject — and the asymmetry ran the wrong way: `injects.jsonl` is token-gated
    // while any local process may subscribe to the bus with no credential, so the honest record sat
    // behind the credential and the false one was in the open.
    //
    // Asked THROUGH `deliveryAuditResult` rather than re-expressed here. It is the same question the
    // audit line two lines up asks, and two writers of one predicate — with nothing binding them — is
    // the shape every drift defect in this release has: the answers agree until someone edits one.
    // The keying (strategy as well as flag) and its reason live there, at the single writer.
    const parked = (0, shared.deliveryAuditResult)(delivery) === 'queued';
    const wrote = delivered && !parked;

    // Emit inject_written ack
    (0, shared.broadcastSessionEvent)('inject_written', targetId, targetSession, {
      extra: {
        inject_id,
        source_host: shared.MACHINE_ID,
        target_agent: targetId,
        source_type: 'bus_auto_route',
        turn_id: (msg.payload && msg.payload.turn_id) || null,
        original_message_id: msg.message_id || null,
        delivered: wrote,
        // The audit log's own vocabulary, carried on the UNGUARDED surface too, so a subscriber can
        // tell "accepted and parked" from "refused" without opening a log it may hold no token for.
        // A park is not a failure: `code`/`error` stay null below, because nothing went wrong.
        delivery_result: wrote ? 'success' : parked ? 'queued' : `failed:${delivery.code || 'DELIVERY_FAILED'}`,
        code: delivered ? null : delivery.code,
        error: delivered ? null : delivery.error
      }
    });
    console.log(`[BUS-ROUTE] ${eventType} → ${targetId}: ${wrote ? 'delivered' : parked ? 'queued (parked, 0 bytes)' : 'failed'}`);
  }

  function registerStateRoute(app) {
    app.post('/api/sessions/:id/state', (req, res) => {
      const requestedId = req.params.id;
      const resolvedId = (0, shared.resolveSessionAlias)(requestedId);
      if (!resolvedId) return (0, shared.respondWithError)(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId });
      const session = shared.sessions[resolvedId];
      const applied = applySessionStateReport(resolvedId, session, req.body);
      if (!applied.success) {
        return (0, shared.respondWithError)(res, applied.httpStatus || 400, applied.code || 'INVALID_REQUEST', applied.error);
      }

      res.json({
        success: true,
        session_id: resolvedId,
        transport: applied.transport,
        semantic: applied.semantic
      });
    });
  }

  function registerSubmitRoute(app) {
    app.post('/api/sessions/:id/submit', async (req, res) => {
      const requestedId = req.params.id;
      const resolvedId = (0, shared.resolveSessionAlias)(requestedId);
      if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
      const session = shared.sessions[resolvedId];
      const id = resolvedId;

      const preDelayMs = Math.min(Math.max(Number(req.body?.pre_delay_ms) || 0, 0), 1000);
      // Default raised 5000 → 10000 (0.3.1) to cover empirical claude REPL
      // ready window (3-6s on fresh spawn) with margin. Upper clamp raised
      // 15000 → 30000 for the rare extreme-cold case.
      const gateTimeoutMs = Math.min(Math.max(Number(req.body?.gate_timeout_ms) || 10000, 500), 30000);
      const injectedBody = typeof req.body?.injected_body === 'string' ? req.body.injected_body : null;
      const { retries, retryDelayMs, verifyTimeoutMs } = (0, shared.parseSubmitRetryOptions)(req.body || {}, injectedBody);
      const minConfidence = req.body?.min_confidence != null
        ? Math.min(Math.max(Number(req.body.min_confidence), 0), 1)
        : undefined;
      // Per-request bypass for manual overrides (`telepty send-key`). Skips gate +
      // verify and dispatches once via the existing terminal-level chain.
      const force = req.body?.force === true;

      const gateOff = String(process.env.TELEPTY_SUBMIT_GATE || '').toLowerCase() === 'off';

      console.log(`[SUBMIT] Session ${id} (${session.command})${retries > 0 ? `, retries: ${retries}, pre_delay: ${preDelayMs}ms` : ''}${gateOff ? ' [gate=off]' : ''}`);

      if (injectedBody) {
        (0, shared.markPendingReportSubmitStarted)(id, injectedBody);
      }

      // #471 (0.4.5): force=true must bypass the bootstrap gate. Without `!force`
      // here the per-request escape hatch (cli.js --submit-force) is enqueued and
      // 504s before the force-bypass block below ever runs.
      if (!force && (0, shared.isBootstrapGatedSession)(session) && (!(0, shared.isBootstrapReady)(session) || (0, shared.hasBootstrapBacklog)(session) || session.bootstrapDraining)) {
        const op = (0, shared.enqueueBootstrapOperation)(id, session, {
          type: 'submit',
          body: { ...(req.body || {}) }
        });
        // #760: this branch is also how the CR half of `telepty inject --submit` reaches the
        // queue after its body was modal-parked (hasBootstrapBacklog above). Awaiting it would
        // 504 at gateTimeoutMs and CANCEL the op, dropping the CR while the body sits parked —
        // half a message, which is worse than none. Ack the queue position; the park drain runs
        // both ops in order once the surface clears.
        if ((0, shared.isSurfaceBlockedByModal)(session)) {
          (0, shared.scheduleModalParkDrain)(id, session);
          console.log(`[SUBMIT] ${id} parked behind a surface modal (depth ${session.bootstrapQueue.length})`);
          return res.json((0, shared.bootstrapQueuedResponse)(op, {
            parked: 'surface_modal',
            reason: (0, shared.modalDeliveryDecision)(session, { force: false }).reason,
            pending: session.bootstrapQueue.length,
          }));
        }
        if ((0, shared.isBootstrapReady)(session)) {
          (0, shared.drainBootstrapQueue)(id, session);
        }
        const queuedSubmit = await (0, shared.waitForBootstrapSubmit)(op, session, gateTimeoutMs);
        if (queuedSubmit.status >= 400 && injectedBody) {
          (0, shared.markPendingReportSubmitUnconfirmed)(id, {
            reason: queuedSubmit.body && queuedSubmit.body.reason ? queuedSubmit.body.reason : 'bootstrap_submit_failed',
            attempts: queuedSubmit.body && queuedSubmit.body.attempts ? queuedSubmit.body.attempts : 0,
            retryable: false
          });
        }
        return res.status(queuedSubmit.status).json(queuedSubmit.body);
      }

      function emitSubmitBus(payload) {
        const busMsg = JSON.stringify({
          type: 'submit',
          sender: 'daemon',
          session_id: id,
          timestamp: new Date().toISOString(),
          ...payload,
        });
        shared.busClients.forEach(client => {
          if (client.readyState === 1) client.send(busMsg);
        });
      }

      // ── Per-request bypass: { force: true } skips gate + verify (0.3.1+) ──
      // Used by `telepty send-key` (manual override). Mirrors the env-var
      // escape-hatch but at request scope.
      // See: docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md §3.1
      if (force) {
        // #737: the force path is the one that kills sessions — it skips the bootstrap gate
        // (above) and returns before Layer 3 (below), so this is the ONLY place it can be asked.
        // A bare CR into the update modal activates "1. Update now" and codex exits.
        const forceModalDecision = await (0, shared.resolveModalGate)(id, session, { force: true });
        if (forceModalDecision) {
          // #760: `--submit-force` IS the worker REPORT path, and its body was parked by the
          // /inject request a moment earlier. Park the CR behind it so the pair replays in
          // order; refusing here would strand the body on the queue with no Enter behind it.
          if (forceModalDecision.action === 'park') {
            const op = (0, shared.parkOperationOnModal)(id, session, {
              type: 'submit',
              body: { ...(req.body || {}) },
            }, forceModalDecision);
            emitSubmitBus({
              strategy: 'none', attempts: 0, gated: false, forced: true,
              submit_confirmed: false, reason: forceModalDecision.reason, parked: 'surface_modal',
            });
            return res.json((0, shared.bootstrapQueuedResponse)(op, {
              parked: 'surface_modal',
              reason: forceModalDecision.reason,
              hint: forceModalDecision.hint,
              pending: session.bootstrapQueue.length,
              forced: true,
            }));
          }
          console.log(`[SUBMIT] force refused for ${id} — ${forceModalDecision.reason}`);
          if (injectedBody) {
            (0, shared.markPendingReportSubmitUnconfirmed)(id, { reason: 'codex_modal_ui', attempts: 0, retryable: true });
          }
          emitSubmitBus({ strategy: 'none', attempts: 0, gated: false, forced: true, submit_confirmed: false, reason: 'codex_modal_ui' });
          return res.status(409).json({
            ...(0, shared.modalRejectionResponse)(forceModalDecision),
            strategy: 'none',
            attempts: 0,
            gated: false,
            forced: true,
          });
        }
        if (injectedBody) {
          (0, shared.markPendingReportSubmitStarted)(id, injectedBody);
        }
        const forceRingBytesAtSubmit = session.outputRingTotalBytes || 0;
        // #730: hold the CR clear of the composer's paste-burst window for the one shape that
        // needs it (un-enveloped + multi-line). 0ms — byte-identical to before — otherwise.
        const forceCrGapMs = forceSubmitCrGapMs(injectedBody, session);
        if (forceCrGapMs > 0) {
          console.log(`[SUBMIT] force CR gap ${forceCrGapMs}ms for ${id} (un-enveloped multi-line body)`);
          await new Promise((resolve) => scheduleTimeout(resolve, forceCrGapMs));
        }
        const strategy = (0, shared.terminalLevelSubmit)(id, session);
        const forceSubmittedAtMs = Date.now();
        if (strategy) {
          // #537 / Bug B: force-confirm must reflect ACTUAL delivery. A pty_cr fallback on a
          // cmux surface means cmux send-key failed and Enter never reached the CLI — record
          // UNCONFIRMED so the ENFORCE-REPORT gate never labels a never-delivered inject DONE.
          const deliveredToSurface = forceSubmitDeliveredToSurface(session, strategy);
          if (injectedBody) {
            if (deliveredToSurface) {
              (0, shared.markPendingReportSubmitConfirmed)(id, { reason: 'force', attempts: 1 });
            } else {
              (0, shared.markPendingReportSubmitUnconfirmed)(id, { reason: 'cmux_send_failed', attempts: 1, retryable: true });
            }
          }
          // #617: the force path skips the synchronous consumption classify, so a busy-parked
          // body would silently drop (this IS the worker's `--submit-force` REPORT path). Hand it
          // to the detached redeliver — it classifies against the CR watermark and only re-fires
          // if `queued`. No-op when the body was consumed/unknown or absent.
          if (injectedBody && deliveredToSurface) {
            scheduleQueuedRedeliver(id, session, injectedBody, {
              submittedAtMs: forceSubmittedAtMs,
              ringBytesAtSubmit: forceRingBytesAtSubmit,
              emitSubmitBus,
            });
          }
          emitSubmitBus({ strategy, attempts: 1, gated: false, forced: true, submit_confirmed: deliveredToSurface });
          return res.json({ success: true, strategy, attempts: 1, gated: false, forced: true, submit_confirmed: deliveredToSurface });
        }
        if (injectedBody) {
          (0, shared.markPendingReportSubmitUnconfirmed)(id, { reason: 'strategy_failed', attempts: 0, retryable: false });
        }
        return res.status(503).json({
          error: 'Submit failed via all strategies (kitty/cmux/pty)',
          strategy: 'none',
          attempts: 0,
          gated: false,
          forced: true,
        });
      }

      // #737: every remaining submit path (gateOff escape hatch + the gated path) converges
      // here. Layer 3 already knows about `codex_modal_ui` but is cmux-only AND advisory
      // (`no_prompt_symbol_seen` falls through and submits anyway), so it protects nothing on a
      // wrapped session — measured: the gated path fired its CR into the modal at +3ms.
      const submitModalDecision = await (0, shared.resolveModalGate)(id, session, { force: false });
      if (submitModalDecision) {
        // #760: same park as the force path. Reached when the modal came up between the /inject
        // and the /submit, so the queue was still empty at the bootstrap branch above.
        if (submitModalDecision.action === 'park') {
          const op = (0, shared.parkOperationOnModal)(id, session, {
            type: 'submit',
            body: { ...(req.body || {}) },
          }, submitModalDecision);
          emitSubmitBus({
            strategy: 'none', attempts: 0, gated: true, forced: false,
            submit_confirmed: false, reason: submitModalDecision.reason, parked: 'surface_modal',
          });
          return res.json((0, shared.bootstrapQueuedResponse)(op, {
            parked: 'surface_modal',
            reason: submitModalDecision.reason,
            hint: submitModalDecision.hint,
            pending: session.bootstrapQueue.length,
          }));
        }
        console.log(`[SUBMIT] refused for ${id} — ${submitModalDecision.reason}`);
        if (injectedBody) {
          (0, shared.markPendingReportSubmitUnconfirmed)(id, { reason: 'codex_modal_ui', attempts: 0, retryable: true });
        }
        emitSubmitBus({ strategy: 'none', attempts: 0, gated: true, forced: false, submit_confirmed: false, reason: 'codex_modal_ui' });
        return res.status(409).json({
          ...(0, shared.modalRejectionResponse)(submitModalDecision),
          strategy: 'none',
          attempts: 0,
          gated: true,
          forced: false,
        });
      }

      // ── Legacy escape-hatch path: blind pre-delay + retries (0.2.x behavior) ──
      if (gateOff) {
        if (injectedBody) {
          (0, shared.markPendingReportSubmitStarted)(id, injectedBody);
        }
        if (preDelayMs > 0) {
          await new Promise(resolve => scheduleTimeout(resolve, preDelayMs));
        }
        let legacyStrategy = (0, shared.terminalLevelSubmit)(id, session);
        let legacyAttempts = legacyStrategy ? 1 : 0;
        for (let i = 0; i < retries && legacyStrategy; i++) {
          await new Promise(resolve => scheduleTimeout(resolve, retryDelayMs));
          (0, shared.terminalLevelSubmit)(id, session);
          legacyAttempts++;
        }
        if (legacyStrategy) {
          if (injectedBody) {
            (0, shared.markPendingReportSubmitConfirmed)(id, { reason: 'gate_off', attempts: legacyAttempts });
          }
          emitSubmitBus({ strategy: legacyStrategy, attempts: legacyAttempts, gated: false });
          return res.json({ success: true, strategy: legacyStrategy, attempts: legacyAttempts, gated: false });
        }
        if (injectedBody) {
          (0, shared.markPendingReportSubmitUnconfirmed)(id, { reason: 'strategy_failed', attempts: legacyAttempts, retryable: false });
        }
        return res.status(503).json({
          error: 'Submit failed via all strategies (kitty/cmux/pty)',
          strategy: 'none',
          attempts: legacyAttempts,
          gated: false,
        });
      }

      // ── Gated path (default, 0.3.0+; best-effort dispatch on timeout in 0.3.1+) ──

      // Step 0 (Layer 3, 0.3.2+): prompt-symbol render gate — strictly additive.
      // Polls `cmux read-screen` for the per-CLI prompt symbol and resolves only
      // when the symbol is stably rendered. Skips cleanly on non-cmux backends
      // (`no_screen_primitive`) and unknown CLIs (`unknown_cli`); on
      // `no_prompt_symbol_seen` (timeout) falls through to Layer 1 — never emits
      // its own 504. Per-request opt-out via `prompt_symbol_gate: false`.
      // See: docs/superpowers/specs/2026-04-26-prompt-symbol-render-gate.md
      const promptSymbolGate = req.body?.prompt_symbol_gate !== false;
      const promptSymbolTimeoutMs = Math.min(
        Math.max(Number(req.body?.prompt_symbol_timeout_ms) || 8000, 500),
        30000
      );
      let promptSymbol = null;
      if (promptSymbolGate) {
        const psResult = await shared.submitGate.awaitPromptSymbol(session, {
          timeoutMs: promptSymbolTimeoutMs,
          readScreen: effects.readScreen,
          now: effects.now,
          sleep: effects.sleep,
        });
        promptSymbol = {
          found: !!psResult.ready,
          waited_ms: psResult.waited_ms || 0,
          ...(psResult.reason ? { reason: psResult.reason } : {}),
          ...(psResult.last_seen_at != null ? { last_seen_at: psResult.last_seen_at } : {}),
        };
        if (psResult.reason === 'no_prompt_symbol_seen') {
          console.log(`[SUBMIT] Layer 3 timeout for ${id} after ${psResult.waited_ms}ms — falling through to Layer 1`);
        } else if (psResult.ready) {
          console.log(`[SUBMIT] Layer 3 ready for ${id} after ${psResult.waited_ms}ms`);
        }
      }

      // Step 1: wait for REPL readiness — best-effort, proceed on plain `timeout`.
      // Hard-fail reasons (session_dead/error/restarting/no_state/no_state_manager)
      // still short-circuit to 504 because dispatching to a dead/missing PTY is
      // pointless. See spec §1.3 / §3.3.
      //
      // #694 busy-dispatch fast-path: a BUSY (mid-turn) recipient sits in working/thinking — neither
      // is a READY_STATE — so awaitReplReady can never pass mid-turn and would burn the FULL
      // gateTimeoutMs (up to 10s) before best-effort dispatch. When the target is a GENUINE ongoing
      // turn (isBusyDispatchState: working/thinking held ≥ SUBMIT_BUSY_GRACE_MS, which excludes the
      // transient `working` from echoing our OWN just-injected text, duration_ms ≈ 0), wait ONLY for
      // the input to settle (body echoed + micro-quiet, via awaitInputSettled) and dispatch
      // best-effort — the same downstream path as a gate timeout, but in ~hundreds of ms. idle/waiting
      // never match isBusyDispatchState, so the idle path is byte-unchanged. gatedTerminalSubmit below
      // still runs its OWN echo+quiet gate before the \r (never fires blindly), and a CR into a busy
      // composer merely queues → #617 redeliver fires it on idle. Rollback: TELEPTY_SUBMIT_BUSY_DISPATCH=off.
      let gateResult = null;
      if (injectedBody && shared.SUBMIT_BUSY_DISPATCH_ENABLED) {
        const cur = shared.sessionStateManager.getState(id);
        if (shared.submitGate.isBusyDispatchState(cur, shared.SUBMIT_BUSY_GRACE_MS)) {
          const settle = await shared.submitGate.awaitInputSettled(session, injectedBody, {
            timeoutMs: 1200,
            quietWindowMs: 100,
            echoGraceMs: 400,
            pollIntervalMs: 30,
            stripAnsi: shared.stripAnsiState,
          });
          gateResult = { ready: false, reason: 'busy_settled', last_state: cur.state, waited_ms: settle.waited_ms };
          console.log(`[SUBMIT] busy-dispatch fast-path ${id}: state=${cur.state} (${cur.duration_ms}ms) settle=${settle.reason} (${settle.waited_ms}ms) — dispatching without idle-gate burn`);
        }
      }
      if (!gateResult) {
        gateResult = await shared.submitGate.awaitReplReady(id, shared.sessionStateManager, {
          timeoutMs: gateTimeoutMs,
          ...(minConfidence !== undefined ? { minConfidence } : {}),
        });
      }
      const gatedDispatchAfterTimeout = !gateResult.ready;
      if (isTerminalGateFailure(gateResult)) {
        console.log(`[SUBMIT] gate hard-fail ${id}: ${gateResult.reason} (last_state=${gateResult.last_state})`);
        return res.status(504).json({
          error: 'Submit gated-timeout — target REPL not in a dispatchable state',
          reason: gateResult.reason,
          last_state: gateResult.last_state,
          strategy: 'none',
          attempts: 0,
          gated: true,
          gate_wait_ms: gateResult.waited_ms,
          ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
        });
      }
      if (gatedDispatchAfterTimeout) {
        // #678: `no_state`/`no_state_manager` join `timeout` here — dispatch the CR best-effort
        // rather than hard-fail, so a live-bridge session with no render-state machine still submits.
        console.log(`[SUBMIT] gate ${gateResult.reason || 'not-ready'} ${id}: dispatching anyway (last_state=${gateResult.last_state})`);
      }

      // Step 2: dispatch Enter via the PTY/context path, render-gated (#568).
      if (injectedBody) {
        (0, shared.markPendingReportSubmitStarted)(id, injectedBody);
      }
      const settleEnabled = req.body?.input_settle_gate !== false;
      let strategy = await (0, shared.gatedTerminalSubmit)(id, session, injectedBody, settleEnabled);
      let submittedAtMs = Date.now();
      // #53: outputRing watermark at the CR — scopes consumption-evidence matching to frames
      // appended AFTER this submit (composer redraw / new-turn render), surviving ring trimming.
      let ringBytesAtSubmit = session.outputRingTotalBytes || 0;
      let attempts = strategy ? 1 : 0;
      if (!strategy) {
        if (injectedBody) {
          (0, shared.markPendingReportSubmitUnconfirmed)(id, { reason: 'strategy_failed', attempts: 0, retryable: false });
        }
        return res.status(503).json({
          error: 'Submit failed via all strategies (kitty/cmux/pty)',
          strategy: 'none',
          attempts: 0,
          gated: true,
          gate_wait_ms: gateResult.waited_ms,
          ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
        });
      }

      // Step 3: confirm the submit was accepted (only when caller provided body).
      // Without `injected_body`, this is a bare Enter press (`telepty enter` or
      // `telepty send-key` without force) — there is nothing to confirm and one
      // shot is enough. A retry is idempotent only when the body is still visible.
      let verify = null;
      let confirm = null;
      let consumption = null;        // #53: 'consumed' | 'queued' | 'unknown'
      let consumptionReason = null;
      if (injectedBody && injectedBody.length > 0) {
        confirm = await (0, shared.confirmSubmitAfterDispatch)(id, session, injectedBody, submittedAtMs, verifyTimeoutMs);
        while (confirm && !confirm.accepted && confirm.retryable && attempts <= retries) {
          await new Promise(resolve => scheduleTimeout(resolve, retryDelayMs));
          const retryStrategy = await (0, shared.gatedTerminalSubmit)(id, session, injectedBody, settleEnabled);
          submittedAtMs = Date.now();
          ringBytesAtSubmit = session.outputRingTotalBytes || 0;
          if (!retryStrategy) break;
          strategy = retryStrategy;
          attempts++;
          confirm = await (0, shared.confirmSubmitAfterDispatch)(id, session, injectedBody, submittedAtMs, verifyTimeoutMs);
        }
        verify = (0, shared.buildSubmitVerify)(confirm);

        // #53: consumption-evidence on the DELIVERY path. `confirm.accepted` can read a BUSY
        // recipient's mid-turn output as success (the isAcceptedSubmitState last_output_at leak),
        // so additionally classify whether the body was CONSUMED as a fresh turn vs QUEUED in a
        // busy composer vs UNKNOWN — and surface it to the caller. Advisory + additive: it does
        // NOT change accepted/retryable (back-compat); it only tells the sender what telepty can
        // actually observe past the PTY layer. Conservative (never-false-consumed).
        const consumptionResult = await shared.submitGate.classifyInjectConsumption(session, injectedBody, {
          submittedAtMs,
          sinceBytes: ringBytesAtSubmit,
          getState: () => shared.sessionStateManager.getState(id),
          stripAnsi: shared.stripAnsiState,
        });
        consumption = consumptionResult.status;
        consumptionReason = consumptionResult.reason;
        if (verify) {
          verify.consumption = consumptionResult.status;
          verify.consumption_reason = consumptionResult.reason;
        }

        // #617: a `queued` body was parked on a busy recipient and will never fire on its own.
        // Hand it to the detached hold-and-redeliver loop (re-fires the CR on busy→idle). This
        // runs independent of whether the handler returns 200 or 504 below — delivery is the
        // daemon's responsibility now that the worker no longer needs to poll the status.
        if (consumption === 'queued') {
          scheduleQueuedRedeliver(id, session, injectedBody, {
            knownConsumption: 'queued',
            submittedAtMs,
            ringBytesAtSubmit,
            emitSubmitBus,
          });
        }

        if (confirm && !confirm.accepted) {
          const reason = gatedDispatchAfterTimeout ? 'gated_dispatch_unconsumed' : 'submit_unconfirmed';
          const failBody = {
            error: gatedDispatchAfterTimeout
              ? 'Submit gated-timeout and body not consumed after best-effort dispatch'
              : 'Submit body still visible after bounded confirmation retry',
            reason,
            last_state: gateResult.last_state,
            strategy,
            attempts,
            gated: true,
            gate_wait_ms: gateResult.waited_ms,
            verify,
            confirm,
            ...(consumption ? { consumption, consumption_reason: consumptionReason } : {}),
            gated_dispatch_after_timeout: true,
            ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
          };
          if (!gatedDispatchAfterTimeout) {
            delete failBody.gated_dispatch_after_timeout;
          }
          (0, shared.markPendingReportSubmitUnconfirmed)(id, { ...confirm, attempts });
          emitSubmitBus(failBody);
          return res.status(504).json(failBody);
        }

        (0, shared.markPendingReportSubmitConfirmed)(id, { ...(confirm || { reason: 'empty_body' }), attempts });
      }

      const responseBody = {
        success: true,
        strategy,
        attempts,
        gated: true,
        gate_wait_ms: gateResult.waited_ms,
        verify,
        confirm,
        ...(consumption ? { consumption, consumption_reason: consumptionReason } : {}),
        ...(gatedDispatchAfterTimeout ? { gated_dispatch_after_timeout: true } : {}),
        ...(promptSymbol ? { prompt_symbol: promptSymbol } : {}),
      };
      emitSubmitBus(responseBody);
      return res.json(responseBody);
    });
  }

  // #1215 — the exact own-record lookup the opt-in exact-target inject and owned delete share: an
  // own, object-valued property of `sessions` and nothing else (mirrors ownRecord in
  // session-records.js). No alias/sibling resolution, no prototype adoption.
  function exactOwnSessionId(requestedId) {
    if (typeof requestedId !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(shared.sessions, requestedId);
    const value = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : null;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? requestedId : null;
  }

  function registerInjectRoute(app) {
    app.post('/api/sessions/:id/inject', async (req, res) => {
      const requestedId = req.params.id;
      // #1215 inject-exact-target — opt-in exact routing. With boolean `exact_target:true` the
      // target is the exact own record or nothing: a bare alias or a `-N` sibling name is 404 here
      // and never reaches resolveSessionAlias' most-recent-sibling fallback, so no bytes, audit line
      // or tracking record exist for it. For an exact id every guard below runs unchanged, and only
      // the success body additionally confirms `exact_target` and the actual `session_id`.
      const exactTarget = !!(req.body && req.body.exact_target === true);
      const resolvedId = exactTarget ? exactOwnSessionId(requestedId) : (0, shared.resolveSessionAlias)(requestedId);
      if (!resolvedId) return (0, shared.respondWithError)(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: requestedId, ...(exactTarget ? { exact_target: true } : {}) });
      const session = shared.sessions[resolvedId];
      const id = resolvedId;
      const { prompt, no_enter, auto_submit, thread_id, reply_expected } = req.body;
      let { from, reply_to } = req.body;
      if (typeof prompt !== 'string') return (0, shared.respondWithError)(res, 400, 'INVALID_REQUEST', 'prompt is required');
      // reply_to defaults to from when omitted
      if (from && !reply_to) reply_to = from;

      // Routing metadata stays in session/bus state, not in the visible prompt text.
      const finalPrompt = prompt;
      const inject_id = shared.crypto.randomUUID();
      // #43 P2 / #815 — daemon-verified sender identity (from the presented bearer, never body.from).
      // The full principal (sid, epoch, generation) so a consumer can tell WHICH INSTANCE of a sid
      // sent this; `verifiedSender` spreads the epoch/generation onto every audit line below.
      const verifiedPrincipal = (0, shared.verifiedPrincipalFromReq)(req);
      const verifiedSenderSid = verifiedPrincipal ? verifiedPrincipal.sid : null;
      const verifiedSender = (0, shared.verifiedSenderFields)(verifiedPrincipal);

      // #533 Phase 2 — peer-lane inject guardrail (in-band hard block, before delivery).
      // Out-of-policy peer→peer injects (no sanctioned ask-request/ask-reply envelope)
      // are blocked here so raw work-delegation bypass is prevented, not just detected.
      // Orchestrator↔peer, broadcast/multicast (no `from`), and existing kinds are untouched.
      const peerVerdict = (0, shared.classifyPeerLaneInject)({ from, to: requestedId, prompt, orchestratorSids: shared.ORCHESTRATOR_SIDS });
      if (peerVerdict.decision === 'block') {
        (0, shared.broadcastSessionEvent)('peer_inject_blocked', id, session, {
          extra: {
            target_agent: id,
            from: from || null,
            reason: peerVerdict.reason,
            attempted_kind: peerVerdict.kind,
            envelope_present: peerVerdict.envelopePresent,
            inject_id
          }
        });
        console.warn(`[PEER-GUARD] blocked peer inject ${from} → ${id} (${peerVerdict.reason})`);
        // #47 P5 — a blocked bypass attempt is auditable too, not just successful deliveries (spec
        // §5/§9). One shared-schema line with delivery_result:"blocked:<reason>" — the #45 gate logic
        // itself is unchanged; this only records the attempt.
        (0, shared.auditAppend)({
          ts: new Date().toISOString(), inject_id, kind: 'inject', source: 'inject',
          claimed_from: from || null, ...verifiedSender,
          to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
          origin: 'trusted-local', origin_host: shared.MACHINE_ID, ref_path: req.body.ref_path || null,
          payload: finalPrompt, delivery_result: `blocked:${peerVerdict.reason}`
        });
        return (0, shared.respondWithError)(res, 403, 'PEER_INJECT_BLOCKED',
          'Peer-lane inject blocked: not a sanctioned ask-request/ask-reply envelope. Use bin/ask.sh.',
          { reason: peerVerdict.reason, sanctioned_channel: 'bin/ask.sh' });
      }
      if (peerVerdict.lane === 'disabled') {
        console.warn('[PEER-GUARD] orchestrator sid unconfigured (AIGENTRY_ORCHESTRATOR_SIDS empty) — peer guardrail disabled (fail-open)');
      }

      // #60 Stage A / §3 item 1 — DURABLY RECORD ABSENCE BEFORE DELIVERY.
      //
      // This used to run after the delivery call, as a best-effort in-memory assignment. That
      // ordering is what made silence possible: bytes reached a worker, the daemon restarted, and
      // nothing anywhere could answer for the dispatch — the orchestrator's poll then got a 404 and
      // read it as a task-state signal. The commit is transactional (temp → fsync → rename → dir
      // fsync) and its failure ABORTS the delivery: refusing to deliver is honest, delivering and
      // then forgetting is not.
      //
      // Scoped to tracked injects (`from` present) — an untracked operator inject is unaffected.
      let trackedRecord = null;
      if (from) {
        const begun = (0, shared.beginTrackedInjection)({ injectId: inject_id, sessionId: id, source: from, session });
        if (!begun.ok) {
          (0, shared.emitInjectFailureEvent)(id, 'TRACKING_PERSISTENCE_FAILED',
            'Observation tracking could not be persisted; no task bytes were delivered.',
            { inject_id, from: from || null }, session);
          return (0, shared.respondWithError)(res, 500, 'TRACKING_PERSISTENCE_FAILED',
            'Observation tracking could not be persisted; no task bytes were delivered.',
            { inject_id, tracking_state: 'unavailable', reason: 'tracking_persistence_failed' });
        }
        trackedRecord = begun.record;
        shared.pendingReports[id] = {
          source: from,
          injectedAt: new Date().toISOString(),
          injectId: inject_id,
          submitExpected: !!no_enter,
          noEnter: !!no_enter,
          injectedBodyPreview: prompt.slice(0, 500),
          // #52: echo-evidence watermark — only frames appended after this inject count.
          ringBytesAtInject: session.outputRingTotalBytes || 0,
          awaitingReport: true
          // NOTE: no `idleNotified`. The one-way "already spoke" bit is gone; duplicate suppression
          // is keyed on observation identity in the ledger, where it cannot become an authority gate.
        };
      }

      try {
        const delivery = await (0, shared.deliverInjectionToSession)(id, session, finalPrompt, {
          noEnter: !!no_enter,
          source: 'inject',
          from: from || 'inject',
          // #860 F2 — carried so that a park keeps its link to the write-ahead record. Null for an
          // untracked operator inject (no `from`), and every consumer of it no-ops on null.
          injectId: trackedRecord ? inject_id : null,
          // #47 P4 — the daemon-verified sender (never body.from) labels the provenance banner.
          verifiedSenderSid
        });
        if (!delivery.success) {
          (0, shared.emitInjectFailureEvent)(id, delivery.code, delivery.error, {
            inject_id,
            from: from || null,
            reply_to: reply_to || null
          }, session);
          (0, shared.auditAppend)({
            ts: new Date().toISOString(), inject_id, kind: 'inject', source: 'inject',
            claimed_from: from || null, ...verifiedSender,
            to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
            origin: 'trusted-local', origin_host: shared.MACHINE_ID, ref_path: req.body.ref_path || null,
            payload: finalPrompt, delivery_result: `failed:${delivery.code || 'DELIVERY_FAILED'}`
          });
          // #843 — close the write-ahead record. Without this the refusal is recorded in the AUDIT log
          // (above) and contradicted in the OBSERVATION ledger, which keeps saying `tracked` /
          // `inject_accepted` for a dispatch that delivered nothing. `inject_id` rides on the error
          // body for the same reason: a caller told its dispatch was refused must be able to poll the
          // record that says so.
          const aborted = trackedRecord
            ? (0, shared.abortTrackedInjection)(inject_id, id, delivery.code, delivery.error)
            : 'no_tracked_inject';
          return (0, shared.respondWithError)(res, delivery.httpStatus || 500, delivery.code || 'DELIVERY_FAILED', delivery.error,
            { inject_id, tracking_state: aborted === 'tracking_aborted' ? 'aborted' : 'unavailable' });
        }

        if (from) session.lastInjectFrom = from;
        if (reply_to) session.lastInjectReplyTo = reply_to;
        if (thread_id) session.lastThreadId = thread_id;

        // #860 F2 — the service log gets the same distinction the audit line does. "Wrote" was printed
        // for a queue push too, so an operator grepping the log for a delivery found one that had not
        // happened.
        console.log(`[INJECT] ${(0, shared.deliveryAuditResult)(delivery) === 'queued' ? 'Queued for' : 'Wrote to'} session ${id} (inject_id: ${inject_id})`);

        const injectTimestamp = new Date().toISOString();
        // #43 P1/P2 — one audit line per delivery (claimed + daemon-verified sender, hash-only).
        (0, shared.auditAppend)({
          ts: injectTimestamp, inject_id, kind: 'inject', source: 'inject',
          claimed_from: from || null, ...verifiedSender,
          to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
          origin: 'trusted-local', origin_host: shared.MACHINE_ID, ref_path: req.body.ref_path || null,
          // #860 F2 — `queued` when the delivery was parked on the bootstrap / modal queue with zero
          // bytes written, `success` only for a delivery the machinery reported as written.
          payload: finalPrompt, delivery_result: (0, shared.deliveryAuditResult)(delivery)
        });
        (0, shared.broadcastSessionEvent)((0, shared.deliveryAuditResult)(delivery) === 'queued' ? 'inject_queued' : 'inject_written', id, session, {
          timestamp: injectTimestamp,
          extra: {
            inject_id,
            target_agent: id,
            // #815: the prompt is NO LONGER rebroadcast verbatim. Any local socket may subscribe to
            // the bus with no token and no Origin, so `content: prompt` published the full text of
            // every dispatch to any local process — a disclosure in its own right, and the harvest
            // that hands an adversary the correlation identifiers carried inside dispatches. Only
            // non-secret transport metadata now: enough to correlate and to verify integrity against
            // a payload you already hold, and nothing to read if you do not.
            content_sha256: shared.crypto.createHash('sha256').update(prompt).digest('hex'),
            content_length: Buffer.byteLength(prompt),
            from: from || null,
            // #43 — live bus event enriched with daemon-verified provenance (spec §7).
            ...verifiedSender,
            spoof_suspected: !!(from && verifiedSenderSid && from !== verifiedSenderSid),
            origin: 'trusted-local',
            reply_to: reply_to || null,
            thread_id: thread_id || null,
            reply_expected: !!reply_expected
          }
        });

        // #60 Stage A / §3.6: the reverse-text REPORT path is DELETED, not adapted.
        //
        // It used to look at any inject a session routed back to its own pending-report source and
        // call it a completion — `resolveOutboundReportStatus` mapped every payload that was not a
        // recognised prefix to `report_complete`, so "Can you clarify the requirement?" was recorded
        // as that worker reporting its task done. It also marked the sender idle from that text and
        // broadcast TASK_COMPLETE_WITH_REPORT.
        //
        // No text can authenticate its sender or correlate itself to a dispatch, so no text may
        // settle one. In 0.8.0 a reverse-routed inject is an ordinary message and the sender's
        // tracked record stays completion-unknown. The authenticated, correlated report protocol is
        // Stage B, and it will not consult pendingReports, the observation ledger, PTY state, or
        // reverse-route matching (§V2/§7 item 10).

        // The tracked record and the pending entry were both created BEFORE this delivery (see the
        // begin-tracking block above), so there is nothing to register here. Supersession of a prior
        // record for the same session is handled there too: the old inject_id keeps its history and
        // gains `tracking_superseded`, instead of being destructively overwritten.

        // Notify all attached viewers (telepty attach clients) about the inject
        // This enables aterm and other viewers to show inject events in real-time
        if (session.clients && session.clients.size > 0) {
          const viewerMsg = JSON.stringify({
            type: 'inject_notification',
            inject_id,
            session_id: id,
            from: from || null,
            content: prompt,
            timestamp: injectTimestamp
          });
          session.clients.forEach(client => {
            if (client !== session.ownerWs && client.readyState === 1) {
              client.send(viewerMsg);
            }
          });
        }

        if (requestedId !== resolvedId) {
          console.log(`[ALIAS] Resolved '${requestedId}' → '${resolvedId}'`);
        }

        if (from && reply_to) {
          const routedMsg = JSON.stringify({
            type: 'message_routed',
            message_id: inject_id,
            from,
            to: id,
            reply_to,
            inject_id,
            deliberation_session_id: req.body.deliberation_session_id || null,
            thread_id: req.body.thread_id || null,
            timestamp: new Date().toISOString()
          });
          shared.busClients.forEach(client => {
            if (client.readyState === 1) client.send(routedMsg);
          });
        }

        res.json({
          success: true,
          inject_id,
          strategy: delivery.strategy,
          submit: delivery.submit,
          ...(delivery.poll_only ? { queued: true, delivered: false, bytes_written: 0,
            msg_id: delivery.msg_id, pending: delivery.pending, poll_only: true } : {}),
          ...(exactTarget ? { exact_target: true, session_id: id } : {}),
          ...(delivery.bootstrap_queued ? {
            bootstrap_queued: true,
            bootstrap_op_id: delivery.bootstrap_op_id || delivery.msg_id,
            pending: delivery.pending
          } : {})
        });
      } catch (err) {
        (0, shared.emitInjectFailureEvent)(id, 'DELIVERY_FAILED', err.message, { inject_id }, session);
        res.status(500).json((0, shared.buildErrorBody)('DELIVERY_FAILED', err.message));
      }
    });
  }

  function registerKillRoute(app) {
    app.post('/api/sessions/:id/kill', async (req, res) => {
      const requestedId = req.params.id;
      // #548: destructive op — must not cascade across alias-sharing siblings.
      const resolvedId = (0, shared.resolveSessionForDestroy)(requestedId);
      if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });

      try {
        const timeoutSeconds = req.body && req.body.timeout != null
          ? Number(req.body.timeout)
          : (req.body && req.body.timeout_sec != null ? Number(req.body.timeout_sec) : 5);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
          return res.status(400).json({ error: 'timeout must be a non-negative number of seconds', code: 'INVALID_TIMEOUT' });
        }

        const result = await teardownSessionById(resolvedId, {
          force: req.body && req.body.force === true,
          timeoutMs: Math.floor(timeoutSeconds * 1000),
          reason: req.body && req.body.reason ? String(req.body.reason) : 'manual',
          source: req.body && req.body.source ? String(req.body.source) : 'api'
        });
        if (!result.success) {
          return res.status(result.httpStatus || 500).json({ ...result, error: result.error || 'Failed to kill session' });
        }
        console.log(`[KILL] Session ${resolvedId} closed (reason=${result.reason}, force=${result.force}, pid=${result.kill.pid || 'none'})`);
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to kill session' });
      }
    });
  }

  function registerDeleteRoute(app) {
    app.delete('/api/sessions/:id', (req, res) => {
      const requestedId = req.params.id;
      // #1215 delete-owned-session — opt-in owned delete. `?owned=true` names the exact own record
      // only (no resolveSessionForDestroy fallback: a bare alias is 404 even with one live sibling).
      const ownedDelete = req.query.owned === 'true';
      // #548: destructive op — must not cascade across alias-sharing siblings.
      const resolvedId = ownedDelete ? exactOwnSessionId(requestedId) : (0, shared.resolveSessionForDestroy)(requestedId);
      if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
      const session = shared.sessions[resolvedId];
      const id = resolvedId;
      // #1215 — an owned delete must present THIS instance's current credential: the verified
      // principal's sid, epoch and generation all matching the record. Checked before isClosing and
      // every side effect below (kill, unregister, revoke, purge, persist); a missing, foreign or
      // stale bearer is a 403 with no mutation. Requests without `owned=true` are untouched.
      if (ownedDelete) {
        const principal = (0, shared.verifiedPrincipalFromReq)(req);
        const generation = Number(session.credentialGeneration) || 1;
        if (!principal || principal.sid !== id || !session.sessionEpoch
            || principal.epoch !== session.sessionEpoch || principal.generation !== generation) {
          return (0, shared.respondWithError)(res, 403, 'OWNED_DELETE_FORBIDDEN',
            'Owned delete requires the current session credential.', { requested: requestedId });
        }
      }
      if (session.isClosing) return res.json({ success: true, status: 'closing' });
      // BUG-C (shared-fate): a wrapped session can be co-bound by a stale/displaced owner bridge
      // (duplicate --id). A DELETE carrying a token that is NOT the current owner's, while a live
      // owner ws is still open, is that stale bridge exiting — it must NOT tear down the live owner.
      // Detach-only (no-op): leave the record and every client untouched. Tokenless callers
      // (operator `telepty delete`, ghost clean) and matching-token current-owner exits are
      // unaffected. Forceful kills go through POST /:id/kill (teardownSessionById), not here.
      const ownerToken = req.query.owner_token;
      if (session.type === 'wrapped'
          && ownerToken && session.ownerToken && ownerToken !== session.ownerToken
          && (0, shared.isOpenWebSocket)(session.ownerWs)) {
        return res.json({ success: true, status: 'stale-detached' });
      }
      // #843 A — the kill outcome is MEASURED, not inferred from which block ran. The two arms used
      // to be a `try` returning `{success:true, status:'closing'}` and a `catch` returning
      // `{success:true, status:'force-removed'}`: a kill that THREW answered success. The process may
      // still be running, the registry record is gone, so nothing tracks it any more — and
      // `bin/session-cleanup.sh`, the operator entrance here, read that success as "the worker is
      // gone". Capturing the error as a value collapses the duplicated teardown into one path and
      // makes "a failed kill does not report success" structural rather than a thing to remember.
      let killError = null;
      try {
        session.isClosing = true;
        if (session.type === 'wrapped') {
          if (session.clients) session.clients.forEach(ws => ws.close(1000, 'Session destroyed'));
        } else if (session.ptyProcess) {
          session.ptyProcess.kill();
        }
      } catch (err) {
        killError = err;
      }
      // Surface close is the orchestrator's job (Workspace Host adapter), per the 2026-05-30
      // verdict — NO-OP on the managed path. The orchestrator's session-cleanup.sh closes the
      // surface on this normal CLI-exit (CLEANUP_REQUEST→wh_close). Actuates only for a standalone
      // telepty with AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1 (gate lives in closeSurface).
      try { shared.terminalBackend.closeSurface(session); } catch {}
      // #60 Stage A §A2 (F1) — OBSERVE THE END BEFORE THE RECORD DISAPPEARS.
      //
      // This used to `delete sessions[id]` first and mark nothing at all. The PTY kill's onExit fires
      // asynchronously, by which point the record is gone, so the transition listener's
      // `if (!session) return` guard bailed and the end was emitted on NO channel. Silence is the one
      // output Stage A forbids, and this is the entrance operator tooling uses, so every cleaned-up
      // session was saying nothing about its own end while the natural-exit path said it correctly.
      //
      // #843 A — and it is `markTerminationRequested`, not `markDead`. The A2 repair above was right
      // to leave exit code and signal null (no exit status was observed at this instant, and
      // inventing one would be a measurement we did not make) and then routed through the one method
      // whose external name is `session_process_exited`. Honest fields under a name that contradicted
      // them. The mark runs synchronously, so the observation is emitted while `sessions[id]` is still
      // live; unregister then destroys the machine, which also makes the later onExit markDead a no-op
      // (its `if (sm)` guard) rather than a second, differently-named statement about one ending.
      shared.sessionStateManager.markTerminationRequested(id, 'operator_delete', killError && killError.message);
      shared.sessionStateManager.unregister(id);
      delete shared.sessions[id];
      (0, shared.revokeSessionCredential)(id);    // #815: DELETE — revoke before the id can be reused
      try { shared.mailbox.purge(id); } catch {}
      shared.lifecycle.cleanupSessionArtifacts(id, effects.cleanup);
      const saved = (0, shared.persistSessions)();
      if (!saved || !saved.ok) return res.status(503).json({ success: false, code: 'SESSION_STORE_WRITE_FAILED',
        error: 'Session was removed but its removal was not durably saved', registry_removed: true,
        kill_error: killError ? killError.message : null });
      const teardown = describeSessionTeardown(killError);
      console.log(killError
        ? `[KILL] Session ${id} registry-removed but the kill was NOT confirmed: ${killError.message}`
        : `[KILL] Session ${id} removed`);
      res.status(teardown.httpStatus).json(teardown.body);
    });
  }

  function registerBusPublishRoute(app) {
    app.post('/api/bus/publish', (req, res) => {
      const payload = req.body;

      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Payload must be a JSON object' });
      }

      if (payload.type === 'session_state_report') {
        const resolvedId = (0, shared.resolveSessionAlias)(payload.session_id || '');
        if (!resolvedId || !shared.sessions[resolvedId]) {
          return (0, shared.respondWithError)(res, 404, 'SESSION_NOT_FOUND', 'Session not found', { requested: payload.session_id || null });
        }

        const applied = applySessionStateReport(resolvedId, shared.sessions[resolvedId], payload);
        if (!applied.success) {
          return (0, shared.respondWithError)(res, applied.httpStatus || 400, applied.code || 'INVALID_REQUEST', applied.error);
        }

        return res.json({ success: true, delivered: shared.busClients.size, event: applied.event });
      }

      let deliveredCount = 0;

      shared.busClients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(JSON.stringify(payload));
          deliveredCount++;
        }
      });

      // Auto-route if this is a turn_request
      busAutoRoute(payload);

      res.json({ success: true, delivered: deliveredCount });
    });
  }

  function registerStateObserver() {
    shared.sessionStateManager.onTransition((sessionId, from, to, detail) => {
      const session = shared.sessions[sessionId];
      if (!session) return;
      const cause = detail && detail.detail ? detail.detail.trigger : null;
      const evidence = { ...(detail && detail.detail ? detail.detail : {}), confidence: detail ? detail.confidence : undefined };

      // External activity vocabulary (§2.3/§3.8). The internal 8-state FSM is unchanged — submit and
      // readiness code branches on it (src/submit-gate.js:21-46, :498-508) — but what leaves this
      // process is the measured cause, never the state name.
      const mapped = (0, shared.mapObservationCause)({ destination: to, cause, evidence });
      (0, shared.broadcastSessionEvent)('session_activity_observation', sessionId, session, {
        extra: {
          schema_version: 2,
          observation: { kind: mapped.kind, trigger: mapped.cause, ...mapped.fields },
          from_observation_state: from,
          completion_fact: null,
          terminal: false,
        }
      });

      const pendingReport = (0, shared.getPendingReport)(sessionId);
      if (!pendingReport) return;

      if (to === 'working' || to === 'thinking') {
        if (!pendingReport.submitExpected || pendingReport.submitStartedAt) {
          pendingReport.sawWorkingAfterInject = true;
          pendingReport.workingAfterInjectAt = new Date().toISOString();
        }
        // #619 lineage: capture the fresh-turn edge the instant it fires, because the outputRing it
        // would otherwise be re-derived from has scrolled off by the time a long turn goes quiet.
        // Stage A records it as a CANDIDATE only — see maybeRecordInjectConsumption for why the
        // submit-confirmation conjuncts cannot be evaluated at this point.
        maybeRecordInjectConsumption(pendingReport, from, to, shared.sessionStateManager.getState(sessionId)?.since_ms);
        recordObservation({ sessionId, session, pendingReport, destination: to, cause, evidence, trigger: 'transition' });
        return;
      }

      if (to === 'idle') {
        // #545: reliability of the idle evidence is still computed, and is still worth recording —
        // it is now a FIELD on the observation rather than an input to a promotion decision. Note
        // both OSC-133 causes count: the raw marker and quiet-after-a-recent-marker are different
        // measurements, and the old code compared against the single overloaded `osc_133_prompt`.
        const bodyText = pendingReport.injectedBodyPreview;
        const bodyVisible = bodyText
          ? shared.submitGate.observeBodyVisibility(session, bodyText).visible === true
          : false;
        const idleEvidenceReliable = (cause === 'osc_133_a_or_b_received' || cause === 'quiet_after_recent_osc_133_a_or_b')
          && !bodyVisible;
        return fireAutoReport(sessionId, session, pendingReport, 'real-idle', {
          idleEvidenceReliable,
          observationCause: cause,
          observationEvidence: evidence,
          silenceMs: evidence.silence_ms,
        });
      }

      // §3.4 / §7 items 4 and 5: the entrances that used to produce nothing. Each emits IMMEDIATELY
      // (no settle debounce) because there is no ambiguity to settle — a waiting pattern matched, or
      // an error fingerprint repeated, or a thinking classification timed out. Each keeps its own
      // name and its own fields, and each carries completion_fact:null. A repeated-error entrance is
      // NOT the same measurement as a thinking timeout, and neither is a task failure.
      if (to === 'waiting' || to === 'error' || to === 'restarting' || to === 'starting') {
        return recordObservation({
          sessionId, session, pendingReport, destination: to, cause, evidence,
          deliverToSource: to === 'waiting' || to === 'error', trigger: 'transition',
        });
      }

      if (to === 'dead') {
        // The pending entry is released, but the ledger record is NOT: it stays queryable so a poll
        // after the process is gone still gets a named observation instead of a 404.
        delete shared.pendingReports[sessionId];
        return recordObservation({
          // #843 — no `|| 'process_exit'` fallback. A transition that arrived at `dead` without a
          // measured cause is not evidence of a process exit; substituting the strongest name in the
          // table for a missing measurement is the defect this release removes, in one line. With no
          // cause the mapper fails closed to `unmapped_transition_cause`, which is the honest answer.
          sessionId, session, pendingReport, destination: 'dead', cause,
          evidence: { ...evidence, auto_summary: buildAutoSummaryWithDefaults(session) },
          deliverToSource: true, trigger: 'transition',
        });
      }

      return recordObservation({ sessionId, session, pendingReport, destination: to, cause, evidence, trigger: 'transition' });
    });
  }

  return {
    buildAutoSummaryWithDefaults,
    observationIdentity,
    markAbsenceDeliveredToSource,
    recordObservation,
    pendingReportHasSubmitEvidence,
    maybeRecordInjectConsumption,
    maybeRecordLauncherConsumption,
    observeInjectEchoEvidence,
    detectIdleAfterError,
    fireAutoReport,
    normalizeNullableText,
    scheduleQueuedRedeliver,
    parseSessionStateReport,
    applySessionStateReport,
    emitSessionLifecycleEvent,
    forceSubmitDeliveredToSurface,
    isTerminalGateFailure,
    forceSubmitCrGapMs,
    teardownSessionById,
    describeSessionTeardown,
    busAutoRoute,
    registerStateRoute,
    registerSubmitRoute,
    registerInjectRoute,
    registerKillRoute,
    registerDeleteRoute,
    registerBusPublishRoute,
    registerStateObserver,
  };
}

module.exports = { createSessionActions };
