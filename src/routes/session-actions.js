const { protectedInputFailure } = require('../external-approval');
const { claimedReturnMetadata } = require('../claimed-return');
const { validInjectId } = require('../diagnostics/correlation');
// Task 1215 hotfix 0.10.1: immediate-submit-v1 support (current owner generation) and its honest response shape.
// Task 1270: the busy-input-v1 binding view (one require, as elsewhere in this file). The stranded-composer and
// body-custody gates are inside `shared.boundAdmissionRefusal`, the one predicate the delivery re-evaluates.
const { immediateSubmitSupport, immediateSubmitOutcome, immediateSubmitAttempt, immediateAttemptFields,
  busyInputSupport, strandedComposer, clearStrandedComposer } = require('../mailbox/delivery-runtime');
// Task 1270: the two CLOSED bound schemas.
const boundInject = require('../protocol/bound-inject');
// Task 1270 operator clear: the CLOSED clear schemas and its PURE decisions (the expected host token never
// enters this module — the route receives a `verifyHostToken(req)` seam instead).
const clearStrand = require('../protocol/clear-strand');
const { activeHandoff } = require('../principal/cooperative-handoff');
const readinessHandshake = require('../transport/readiness-handshake');
// #1215 pipe200 S24: the stable public text for an inject delivery that threw (details are in the daemon log only).
const INJECT_DELIVERY_FAILED_TEXT = 'Delivery failed; see daemon log.';
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
    // #1207 — read-model records are immutable copies replaced on every ack, so the per-inject key
    // is the client's stable identity object for that inject (same lifetime as its residency); a
    // record that did not come from the read model keys on itself, exactly as before.
    const key = (shared.ledgerClient && record && shared.ledgerClient.readModel.identityOf(record.inject_id)) || record;
    let delivered = shared.deliveredAbsenceIdentities.get(key);
    if (!delivered) {
      delivered = new Set();
      shared.deliveredAbsenceIdentities.set(key, delivered);
    }
    if (delivered.has(identity)) return true;
    delivered.add(identity);
    return false;
  }

  // #1207 — which ledger class a measured observation belongs to. Result-class (R) observations are
  // the ones a dispatch's source is waiting for (idle auto-report, death, park); everything a screen
  // transition produced is class O. The class decides which reservation admits the write — it never
  // changes the observation's name or fields.
  function observationClass(mapped, destination, trigger) {
    if (trigger && trigger !== 'transition' && trigger !== 'owner_lifecycle') return 'R';   // ready-signal / real-idle / silence-timeout
    if (destination === 'dead' || destination === 'idle') return 'R';
    if (trigger === 'owner_lifecycle') return 'L';
    return 'O';
  }

  // Maps one ledger outcome onto the named `tracking_result` vocabulary the bus and the source hear.
  function trackingResultFor(outcome) {
    switch (outcome.outcome) {
      case 'ack': return outcome.result === 'observation_duplicate' ? 'observation_duplicate'
        : outcome.result === 'already_terminal' ? 'already_terminal'
          : outcome.record_state === 'superseded' ? 'tracking_superseded' : 'observation_emitted';
      case 'rejected_admission': return outcome.reason === 'tracking_capacity_result' ? 'tracking_capacity_result'
        : outcome.reason === 'tracking_capacity_exhausted' ? 'tracking_capacity_exhausted' : 'tracking_backpressure';
      case 'indeterminate': return 'tracking_outcome_indeterminate';
      case 'nack': return ['record_missing', 'not_observed_by_daemon_epoch', 'cold_offline'].includes(outcome.reason) ? 'tracking_unavailable'
        : ['recovering', 'owner_failed', 'unavailable_write', 'unavailable_read', 'lock_present', 'shutting_down', 'unavailable'].includes(outcome.reason) ? 'tracking_unavailable'
          : 'tracking_persistence_failed';
      default: return 'tracking_persistence_failed';
    }
  }

  async function recordObservation({
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
    let record = injectId ? (0, shared.getTrackedInjection)(injectId) : null;

    const consumption = pendingReport
      ? (0, shared.classifyConsumption)(pendingReport, {
        echoObserved: deps.echoObserved === true,
        echoReason: deps.echoReason || null,
      })
      : { status: 'not_established', basis: 'no_tracked_inject' };

    // #1207 — no speculative in-memory append, no rollback, and NO client-side dedup shortcut
    // (errata C3): the owner alone decides `observation_duplicate` against its ORDERED overlay
    // (committed frames + pending frames of the open group, in log position), so a committed A,
    // pending B, incoming A is written rather than dropped. Admission is reserve-before-accept
    // (errata C5): the write is either persisted (ack / nack-invalid / indeterminate) or rejected
    // before anything is queued, with a named result either way. The bus hears every outcome.
    let result = 'observation_emitted';
    let outcome = null;
    if (injectId) {
      const client = shared.ledgerClient;
      const unavailable = client && typeof shared.ledgerUnavailable === 'function' ? (0, shared.ledgerUnavailable)() : { reason: 'observation_store_unavailable' };
      if (unavailable) {
        // Unavailable authorizes nothing. Explicit, named, never silence.
        result = 'tracking_unavailable';
      } else {
        try {
          if (!record) {
            // A record this daemon epoch has not got hot (cold tier, or never tracked here). Reads
            // never reheat; a WRITE does, under resident admission and the job reservation.
            const hot = await client.ensureHot(injectId);
            if (hot.ok) record = (0, shared.getTrackedInjection)(injectId);
            else if (hot.outcome && hot.outcome.outcome === 'rejected_admission') result = hot.reason === 'hot_capacity' ? 'tracking_backpressure' : 'tracking_capacity_exhausted';
            else if (hot.outcome && hot.outcome.outcome === 'indeterminate') result = 'tracking_outcome_indeterminate';
            else result = 'tracking_unavailable';
          }
          if (record) {
            const cls = observationClass(mapped, destination, trigger);
            outcome = await client.submit('obs', {
              id: injectId,
              observation: { ...observation, consumption_status: consumption.status, at: nowIso },
            }, { class: cls, jobId: injectId, result: cls === 'R' });
            result = trackingResultFor(outcome);
            if (outcome.outcome === 'ack') record = (0, shared.getTrackedInjection)(injectId) || record;
            if (outcome.outcome !== 'ack') {
              console.error(`[OBSERVE] ledger write for ${injectId} → ${outcome.outcome} (${outcome.reason || outcome.result || ''}) — `
                + `${observation.kind} is emitted on the bus and is NOT described as durable`);
            }
          }
        } catch (error) {
          // The emitter never throws into a listener; the bus still hears a named absence.
          result = 'tracking_persistence_failed';
          console.error(`[OBSERVE] ledger write threw for ${injectId}: ${error && error.message}`);
        }
      }
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

    // #1207 — the source is notified only AFTER the fsynced ACK (durable before delivery). A
    // duplicate, a pre-admission rejection, an invalid nack or an indeterminate outcome is on the
    // bus with its name and is never pushed as if it had been recorded.
    const durable = outcome ? outcome.outcome === 'ack' && outcome.basis === 'written' : !injectId;
    if (deliverToSource && pendingReport && result !== 'observation_duplicate' && durable) {
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

  /**
   * #1207 — an owner-lifecycle FACT about a session (owner replaced, displaced transport detached):
   * stored ONCE as a session-scoped fact frame and overlaid lazily, in log order, onto every tracked
   * inject assigned to that session (hot and cold alike) — instead of one whole-ledger rewrite per
   * record. The bus hears one `task_completion_unknown` per record, as today, with the ONE durable
   * outcome as its `tracking_result`; the source is notified per record only after the ACK.
   * Returns the named results, one per record — never undefined, never a bare return.
   */
  async function recordSessionFact({ sessionId, session, cause, evidence, records, trigger = 'owner_lifecycle', deps = {} }) {
    const _broadcast = deps.broadcastSessionEvent || shared.broadcastSessionEvent;
    const _sessions = deps.sessions || shared.sessions;
    const _resolveAlias = deps.resolveSessionAlias || shared.resolveSessionAlias;
    const _deliver = deps.deliverInjectionToSession || shared.deliverInjectionToSession;
    const nowIso = new Date().toISOString();
    const mapped = (0, shared.mapObservationCause)({ destination: null, cause, evidence });
    const observation = { kind: mapped.kind, trigger: mapped.cause, ...mapped.fields, emitted_via: trigger };
    if (!Array.isArray(records) || records.length === 0) return ['no_tracked_inject'];
    const client = shared.ledgerClient;
    const unavailable = client && typeof shared.ledgerUnavailable === 'function' ? (0, shared.ledgerUnavailable)() : { reason: 'observation_store_unavailable' };
    let result = 'observation_emitted';
    let outcome = null;
    if (unavailable) result = 'tracking_unavailable';
    else {
      try {
        outcome = await client.submit('fact', { scope: 'session', sid: sessionId, observation: { ...observation, at: nowIso } }, { class: 'L' });
        result = trackingResultFor(outcome);
      } catch (error) { result = 'tracking_persistence_failed'; console.error(`[OBSERVE] session fact threw for ${sessionId}: ${error && error.message}`); }
    }
    if (mapped.kind === 'unmapped_transition_cause') result = 'unmapped_transition_cause';
    const durable = outcome && outcome.outcome === 'ack' && outcome.basis === 'written';
    const active = (0, shared.getPendingReport)(sessionId);
    return records.map((rec) => {
      const pendingReport = active && active.injectId === rec.inject_id ? active : { injectId: rec.inject_id, source: rec.transport_source };
      const live = (0, shared.getTrackedInjection)(rec.inject_id);
      const consumption = active && active.injectId === rec.inject_id ? (0, shared.classifyConsumption)(pendingReport, {}) : { status: 'not_established', basis: 'no_tracked_inject' };
      const seq = (Number(rec.observation_seq) || 0) + (durable ? 1 : 0);
      const envelope = (0, shared.buildCompletionUnknown)({
        sessionId, injectId: rec.inject_id, observation: { ...observation, seq, at: nowIso }, consumption,
        capability: (live && live.capability) || rec.capability || shared.CAPABILITY_STAGE_A, observationSeq: seq,
      });
      _broadcast('task_completion_unknown', sessionId, session, { timestamp: nowIso, extra: { ...envelope, tracking_result: result, source: pendingReport.source || null } });
      if (durable && pendingReport.source && (0, shared.shouldPushCompletionUnknown)(envelope)) {
        const key = observationIdentity(mapped.kind, mapped.cause) + '|' + rec.inject_id;
        if (!(live && markAbsenceDeliveredToSource(live, key))) {
          const srcId = _resolveAlias(pendingReport.source) || pendingReport.source;
          const srcSession = _sessions[srcId];
          if (srcSession) _deliver(srcId, srcSession, (0, shared.formatCompletionUnknownText)(envelope), { noEnter: false, source: 'auto_report' });
        }
      }
      return result;
    });
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
      // Task 1215 submit286: the re-fired CR names the same validated inject_id as its /submit;
      // terminalLevelSubmit re-checks its record identity at this write.
      const strategy = await (0, shared.gatedTerminalSubmit)(id, session, injectedBody, true,
        opts.injectId ? { injectId: opts.injectId } : undefined);
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
    if (session.isClosing) return { success: false, httpStatus: 409, code: 'SESSION_CLOSING', error: 'Session is closing' };
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

  function beginDurableSessionClose(id, session) {
    if(require('../principal/cooperative-handoff').activeHandoff(session) || require('../principal/pending-handoff').pendingNamespaceReserved(session,()=>shared.mailbox))return {success:false,httpStatus:409,code:'HANDOFF_FENCED',error:'Cooperative handoff reserves this instance.'};
    if (session.isClosing && !session.closeDurabilityPending) {
      return { success: false, httpStatus: 409, code: 'SESSION_CLOSING', error: 'Session is closing' };
    }
    const previous = Object.getOwnPropertyDescriptor(session, 'isClosing');
    session.isClosing = true;
    const saved = (0, shared.persistSessions)();
    if (!saved || !saved.ok) {
      if ((!saved || !saved.committed) && !session.closeDurabilityPending) {
        if (previous) Object.defineProperty(session, 'isClosing', previous);
        else delete session.isClosing;
      } else {
        // Rename reached disk, but its fsync failed. Keep the namespace reserved and permit
        // only a close retry, never process actions or reuse before a successful durable save.
        session.closeDurabilityPending = true;
      }
      return { success: false, httpStatus: 503, code: 'SESSION_STORE_WRITE_FAILED',
        error: 'Session removal was not durably saved; no process action was attempted',
        process_action_attempted: false, removal_visible: !!saved?.committed };
    }
    session.closeDurabilityPending = false;
    (0, shared.revokeSessionCredential)(id);
    return { success: true };
  }

  async function teardownSessionById(id, options = {}) {
    const session = shared.sessions[id];
    if (!session) return { success: false, httpStatus: 404, error: 'Session not found' };
    const prepared = beginDurableSessionClose(id, session);
    if (!prepared.success) return prepared;

    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 5000));
    const force = options.force === true;
    const reason = options.reason || (force ? 'manual_force' : 'manual');
    let kill = null, killError = null;
    try {
      kill = await shared.lifecycle.killSessionProcess(session, { ...effects.lifecycle, timeoutMs, force });
      if (kill?.reason === 'ESCALATION_FAILED') killError = new Error('Process escalation was not confirmed');
    } catch (error) { killError = error; }

    // A process exit can remove the old record while killSessionProcess awaits. Never let its
    // delayed cleanup unregister, revoke, purge or delete a successor with the same textual id.
    const current = shared.sessions[id] === session;
    if (current) emitSessionLifecycleEvent('session_closed', id, session, {
      reason, force, pid: kill?.pid || null, signal: kill?.signal || null,
      escalated: kill?.escalated === true, process_action_error: killError?.message || null,
      source: options.source || 'daemon'
    });
    (0, shared.cancelModalParkPoll)(session);
    if (current) {
      if (session.clients) session.clients.forEach(ws => { try { ws.close(1000, 'Session destroyed'); } catch {} });
      if (session.ownerWs) { try { session.ownerWs.close(1000, 'Session destroyed'); } catch {} }
      try { shared.terminalBackend.closeSurface(session); } catch {}
      delete shared.sessions[id];
      shared.sessionStateManager.unregister(id);
      try { shared.mailbox.purge(id); } catch {}
      shared.lifecycle.cleanupSessionArtifacts(id, effects.cleanup);
    }
    if (killError) return { success: false, httpStatus: 500, code: 'KILL_FAILED',
      status: 'registry-removed-kill-unconfirmed', registry_removed: true, kill,
      error: `Session was durably removed, but process teardown was not confirmed: ${killError.message}` };
    return { success: true, session_id: id, status: 'closed', reason, force, timeout_ms: timeoutMs, kill };
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

  // #1215 fix93 — DELETE of a spawned PTY sent ONE node-pty kill() (SIGHUP on POSIX; node-pty swallows
  // its errors) and never looked again, so a child ignoring SIGHUP outlived its deleted record untracked
  // (CI 41256450955 F2). Confirm the end of THIS captured child through its own onExit: the record's
  // onExit cleanup bails once the record is gone, so session.ptyProcess/pid fields prove nothing after
  // DELETE. Not ended within the lifecycle's 5000 ms grace => escalate ONCE via
  // lifecycle.killSessionProcess(force) at the pid captured from this pty — never a record fallback
  // (ptyPid/ownerPid). The response is untouched: 200 {status:'closing'} still means "requested".
  const DELETE_EXIT_GRACE_MS = 5000;
  function confirmDeletedPtyExit(id, session, pty) {
    const pid = Number.isInteger(pty.pid) && pty.pid > 0 ? pty.pid : null;
    if (!pid || typeof pty.onExit !== 'function') {
      console.warn(`[KILL] Session ${id} PTY exit cannot be confirmed (no pid or exit observer); not escalating`);
      return;
    }
    const clear = effects.setTimeout ? effects.clearTimeout : globalThis.clearTimeout;
    let ended = false, timer = null, listener = null;
    const stop = () => {
      if (timer && typeof clear === 'function') clear(timer);
      timer = null;
      try { if (listener && typeof listener.dispose === 'function') listener.dispose(); } catch {}
      listener = null;
    };
    try {
      listener = pty.onExit(() => { ended = true; stop(); });
    } catch (error) {
      console.warn(`[KILL] Session ${id} PTY exit cannot be confirmed: ${error.message}; not escalating`);
      return;
    }
    timer = scheduleTimeout(() => {
      timer = null;
      if (ended) return;
      console.warn(`[KILL] Session ${id} PTY pid ${pid} did not exit within ${DELETE_EXIT_GRACE_MS} ms of delete; escalating once (SIGKILL)`);
      Promise.resolve()
        .then(() => shared.lifecycle.killSessionProcess(session, { ...effects.lifecycle, pid, force: true }))
        .then(kill => (kill && kill.signaled ? null : `escalation not delivered (${(kill && kill.reason) || 'unknown'})`),
          error => `escalation failed: ${error && error.message}`)
        .then(failure => {
          if (ended) return;
          if (failure) console.error(`[KILL] Session ${id} PTY pid ${pid} ${failure}`);
          timer = scheduleTimeout(() => {
            timer = null;
            if (!ended) console.error(`[KILL] Session ${id} PTY pid ${pid} exit NOT confirmed ${DELETE_EXIT_GRACE_MS} ms after escalation; it may still be running untracked`);
            stop();
          }, DELETE_EXIT_GRACE_MS);
        })
        .catch(error => { console.error(`[KILL] Session ${id} PTY exit confirmation failed: ${error && error.message}`); stop(); });
    }, DELETE_EXIT_GRACE_MS);
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
      if (session.isClosing) return res.status(409).json({ success: false, code: 'SESSION_CLOSING', error: 'Session is closing' });

      const denied = protectedInputFailure(session);
      if (denied) return res.status(denied.httpStatus).json(denied);
      if (session.sshRemote) {
        const result = await require('../ssh-session').requestSshWrite(session, '\r');
        return res.status(result.success ? 200 : result.httpStatus || 409).json(result);
      }
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
      // Task 1215 submit286: optional correlation — the inject_id of the body this CR submits.
      // Syntax-checked here; a missing or malformed value is simply absent (legacy, never a 400).
      // terminalLevelSubmit keeps it on the CR frame only for a record of this exact session,
      // epoch and owner generation. It changes no gate, retry, status or byte.
      const submitInjectId = validInjectId(req.body?.inject_id) ? req.body.inject_id : null;
      const submitOptions = submitInjectId ? { injectId: submitInjectId } : undefined;

      const gateOff = String(process.env.TELEPTY_SUBMIT_GATE || '').toLowerCase() === 'off';
      // Task 1215 hotfix 0.10.1: a wrapped bridge holding immediate-submit-v1 for THIS owner generation writes the CR at
      // once and admits one CR per inject_id/pair. Its /submit keeps every real fence (closing, protected input, ssh,
      // input-transport/bootstrap queue, modal, held interaction, owner socket/generation) and sends exactly ONE CR:
      // no prompt-symbol/REPL/settle wait, no confirm retry, no queued redeliver, no gate-off retries, forced or not.
      const immediate = immediateSubmitSupport(session) === 'supported';
      const immediateGeneration = session.interactionOwnerGeneration;
      const immediateStage = stage => (immediate ? { immediate_submit: true, submit_stage: stage } : {});
      // hotfix480 F2: an op this request queues or parks as immediate is pinned to the generation+capability that admitted it.
      const admission = immediate ? { immediateGeneration } : {};

      console.log(`[SUBMIT] Session ${id} (${session.command})${retries > 0 ? `, retries: ${retries}, pre_delay: ${preDelayMs}ms` : ''}${gateOff ? ' [gate=off]' : ''}`);

      if (injectedBody) {
        (0, shared.markPendingReportSubmitStarted)(id, injectedBody);
      }

      // #471 (0.4.5): force=true must bypass the bootstrap gate. Without `!force`
      // here the per-request escape hatch (cli.js --submit-force) is enqueued and
      // 504s before the force-bypass block below ever runs.
      // Task 1215 hotfix 0.10.1: for an immediate bridge the input-transport fence (an unwired child) and the FIFO backlog
      // apply to every caller, forced too: a CR handed to an unwired bridge would be buffered, not written.
      const bootstrapFenced = (0, shared.isBootstrapGatedSession)(session) || (immediate
        && (readinessHandshake.awaitingInputTransport(session) || (0, shared.hasBootstrapBacklog)(session) || session.bootstrapDraining));
      if ((!force || immediate) && bootstrapFenced && (!(0, shared.isBootstrapReady)(session) || (0, shared.hasBootstrapBacklog)(session) || session.bootstrapDraining)) {
        const op = (0, shared.enqueueBootstrapOperation)(id, session, {
          type: 'submit',
          body: { ...(req.body || {}) },
          ...admission,
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
            ...immediateStage('queued'),
          }));
        }
        if ((0, shared.isBootstrapReady)(session)) {
          (0, shared.drainBootstrapQueue)(id, session);
        }
        const queuedSubmit = await (0, shared.waitForBootstrapSubmit)(op, session, gateTimeoutMs);
        // Task 1215 hotfix 0.10.1: say what happened to the CR. hotfix480 F2: derived from the op's actual progress, not
        // from the status: a failed op whose effect never started (cancelled, flushed, refused) is not_written; once the
        // pinned op started its single write the outcome is unknown.
        if (immediate && queuedSubmit.body && !queuedSubmit.body.submit_stage) {
          queuedSubmit.body = { ...queuedSubmit.body, ...immediateStage(queuedSubmit.status < 400 ? 'sent_to_bridge'
            : op.effectStarted ? 'unknown' : 'not_written') };
        }
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

      // Task 1215 hotfix 0.10.1: the immediate path's single attempt. terminalLevelSubmit re-checks closing, protected
      // input, ssh, held interaction and the open owner socket, and stamps the current owner generation (plus the body
      // pair this daemon handed to that generation). It never retries or redelivers, and it never claims consumption.
      // hotfix480 F1-F4: a CR whose body is still in daemon custody is queued behind it and released on its handoff
      // (bounded by gate_timeout_ms); a named inject needs this generation's pair; the generation is the admitting one.
      async function respondImmediateSubmit(forced) {
        // A modal hold may have spanned an owner change: never send this CR under another owner generation or instance.
        const attempt = await immediateSubmitAttempt(session, { injectId: submitInjectId, generation: immediateGeneration,
          timeoutMs: gateTimeoutMs, isCurrent: () => shared.sessions[id] === session,
          modalCheck: () => { const d = (0, shared.modalDeliveryDecision)(session, { force: forced }); return d.action === 'deliver' ? null : d; },
          submit: options => (0, shared.terminalLevelSubmit)(id, session, options) });
        // hotfix492 N2: a modal that came up while this CR waited on its body: park it behind the modal, pinned, or refuse.
        if (attempt.modal) {
          if (injectedBody) (0, shared.markPendingReportSubmitUnconfirmed)(id, { reason: 'codex_modal_ui', attempts: 0, retryable: true });
          emitSubmitBus({ strategy: 'none', attempts: 0, gated: !forced, forced, submit_confirmed: false, reason: attempt.modal.reason,
            ...(attempt.modal.action === 'park' ? { parked: 'surface_modal' } : {}) });
          if (attempt.modal.action === 'park') {
            const op = (0, shared.parkOperationOnModal)(id, session, { type: 'submit', body: { ...(req.body || {}) }, ...admission }, attempt.modal);
            return res.json((0, shared.bootstrapQueuedResponse)(op, { parked: 'surface_modal', reason: attempt.modal.reason,
              hint: attempt.modal.hint, pending: session.bootstrapQueue.length, forced, ...immediateStage('queued') }));
          }
          return res.status(409).json({ ...(0, shared.modalRejectionResponse)(attempt.modal), strategy: 'none', attempts: 0,
            gated: !forced, forced, ...immediateStage('not_written') });
        }
        const strategy = attempt.strategy;
        if (injectedBody) {
          (0, shared.markPendingReportSubmitUnconfirmed)(id, strategy
            ? { reason: 'consumption_unknown', attempts: 1, retryable: false }
            : { reason: 'strategy_failed', attempts: 0, retryable: false });
        }
        const outcome = immediateSubmitOutcome(strategy, { forced, ...immediateAttemptFields(attempt) });
        emitSubmitBus(outcome.body);
        return res.status(outcome.status).json(outcome.body);
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
              ...admission,
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
              ...immediateStage('queued'),
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
            ...immediateStage('not_written'),
          });
        }
        if (immediate) return respondImmediateSubmit(true);
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
        const strategy = (0, shared.terminalLevelSubmit)(id, session, submitOptions);
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
              injectId: submitInjectId,
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
            ...admission,
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
            ...immediateStage('queued'),
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
          ...immediateStage('not_written'),
        });
      }
      if (immediate) return respondImmediateSubmit(false);

      // ── Legacy escape-hatch path: blind pre-delay + retries (0.2.x behavior) ──
      if (gateOff) {
        if (injectedBody) {
          (0, shared.markPendingReportSubmitStarted)(id, injectedBody);
        }
        if (preDelayMs > 0) {
          await new Promise(resolve => scheduleTimeout(resolve, preDelayMs));
        }
        let legacyStrategy = (0, shared.terminalLevelSubmit)(id, session, submitOptions);
        let legacyAttempts = legacyStrategy ? 1 : 0;
        for (let i = 0; i < retries && legacyStrategy; i++) {
          await new Promise(resolve => scheduleTimeout(resolve, retryDelayMs));
          (0, shared.terminalLevelSubmit)(id, session, submitOptions);
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
      let strategy = await (0, shared.gatedTerminalSubmit)(id, session, injectedBody, settleEnabled, submitOptions);
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
          const retryStrategy = await (0, shared.gatedTerminalSubmit)(id, session, injectedBody, settleEnabled, submitOptions);
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
            injectId: submitInjectId,
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

  function registerInjectRoute(app, routePath = '/api/sessions/:id/inject') {
    app.post(routePath, async (req, res) => {
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
      if (req.body.expected_epoch !== undefined && req.body.expected_epoch !== session.sessionEpoch) {
        return (0, shared.respondWithError)(res, 409, 'TARGET_EPOCH_MISMATCH', 'Target session epoch differs');
      }
      if (req.body.external_approval && !session.externalApprovalPolicy) {
        return (0, shared.respondWithError)(res, 403, 'APPROVAL_POLICY_REQUIRED', 'Signed inject requires the enrolled target policy.');
      }
      const { prompt, no_enter, auto_submit, thread_id, reply_expected } = req.body;
      let { from, reply_to } = req.body;
      if (typeof prompt !== 'string') return (0, shared.respondWithError)(res, 400, 'INVALID_REQUEST', 'prompt is required');
      let cooperativeConsent = null;
      if(Object.hasOwn(req.body,'allow_cooperative_handoff') && typeof req.body.allow_cooperative_handoff!=='boolean')return res.status(400).json({code:'HANDOFF_CONSENT_INVALID'});
      if(req.body.allow_cooperative_handoff===true){
        const principal=require('../principal/http').verifiedRequestPrincipal(req,{action:'session.inject',target:id});
        const recipient=require('../principal/http').storedOwningPrincipal(session.owningPrincipal);
        if(!prompt.length || Buffer.from(prompt,'utf8').toString('utf8')!==prompt || Buffer.byteLength(prompt)>4096 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(prompt) || !principal || !recipient || !exactTarget || req.body.expected_epoch!==session.sessionEpoch || no_enter!==true
          || !!from || auto_submit===true || session.type!=='wrapped' || session.sshRemote || session.externalApprovalPolicy || req.body.external_approval
          || session.provenanceCapable===true || session.cooperativeHandoffCapable!==true || !session.interactionOwnerGeneration)return res.status(403).json({code:'HANDOFF_CONSENT_UNSUPPORTED'});
        cooperativeConsent={schema:'telepty.pending-handoff-consent/v1',sid:id,origin_epoch:session.sessionEpoch,origin_owner_generation:session.interactionOwnerGeneration,
          recipient:{id:recipient.id,audience:recipient.audience},sender:{id:principal.id,key_id:principal.keyId,audience:principal.audience,source:'ed25519'},
          request_sha256:require('../principal/encoding').requestBodyDigest(req),proof_sha256:shared.crypto.createHash('sha256').update(req.headers['x-telepty-principal']).digest('hex')};
      }
      // reply_to defaults to from when omitted
      if (from && !reply_to) reply_to = from;
      const claimedReturn = claimedReturnMetadata(reply_to, req.body.claimed_cross_host === true || !!req.body.forwarding);
      if (reply_to && !claimedReturn) return (0, shared.respondWithError)(res, 400, 'INVALID_RETURN_LOCATOR', 'Invalid claimed return locator');

      // Routing metadata stays in session/bus state, not in the visible prompt text.
      const finalPrompt = prompt;
      const inject_id = shared.crypto.randomUUID();
      // #43 P2 / #815 — daemon-verified sender identity (from the presented bearer, never body.from).
      // The full principal (sid, epoch, generation) so a consumer can tell WHICH INSTANCE of a sid
      // sent this; `verifiedSender` spreads the epoch/generation onto every audit line below.
      const verifiedPrincipal = req.body.forwarding ? null : (0, shared.verifiedPrincipalFromReq)(req);
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
          claimed_from: from || null, ...verifiedSender, claimed_return: claimedReturn,
          to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
          origin: req.body.forwarding ? 'untrusted-remote' : 'trusted-local',
          origin_host: req.body.forwarding ? null : shared.MACHINE_ID, ref_path: req.body.ref_path || null,
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
        // #1207 — the begin is durable (fsynced commit ACK) before this await returns; capacity and
        // availability refusals are 503 TRACKING_CAPACITY with the named reason, an unreadable
        // store or an indeterminate outcome stays the existing 500 branch with its reason.
        const begun = await (0, shared.beginTrackedInjection)({ injectId: inject_id, sessionId: id, source: from, session });
        if (!begun.ok) {
          if (begun.capacity) {
            (0, shared.emitInjectFailureEvent)(id, 'TRACKING_CAPACITY',
              'Observation tracking capacity is not available; no task bytes were delivered.',
              { inject_id, from: from || null, reason: begun.reason }, session);
            return (0, shared.respondWithError)(res, 503, 'TRACKING_CAPACITY',
              'Observation tracking capacity is not available; no task bytes were delivered.',
              { inject_id, tracking_state: 'unavailable', reason: begun.reason });
          }
          (0, shared.emitInjectFailureEvent)(id, 'TRACKING_PERSISTENCE_FAILED',
            'Observation tracking could not be persisted; no task bytes were delivered.',
            { inject_id, from: from || null, reason: begun.reason }, session);
          return (0, shared.respondWithError)(res, 500, 'TRACKING_PERSISTENCE_FAILED',
            'Observation tracking could not be persisted; no task bytes were delivered.',
            { inject_id, tracking_state: 'unavailable', reason: begun.reason === 'tracking_outcome_indeterminate' ? 'tracking_outcome_indeterminate' : 'tracking_persistence_failed' });
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
          cooperativeHandoffConsent:cooperativeConsent,
          source: 'inject',
          externalApproval: req.body.external_approval || null,
          from: from || 'inject',
          // #860 F2 — carried so that a park keeps its link to the write-ahead record. Null for an
          // untracked operator inject (no `from`), and every consumer of it no-ops on null.
          injectId: trackedRecord ? inject_id : null,
          // Task 1215 519: the inject_id returned to THIS caller names its body pair even when untracked (no ledger use).
          pairInjectId: inject_id,
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
            claimed_from: from || null, ...verifiedSender, claimed_return: claimedReturn,
            to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
            origin: req.body.forwarding ? 'untrusted-remote' : 'trusted-local',
            origin_host: req.body.forwarding ? null : shared.MACHINE_ID, ref_path: req.body.ref_path || null,
            payload: finalPrompt, delivery_result: `failed:${delivery.code || 'DELIVERY_FAILED'}`
          });
          // #843 — close the write-ahead record. Without this the refusal is recorded in the AUDIT log
          // (above) and contradicted in the OBSERVATION ledger, which keeps saying `tracked` /
          // `inject_accepted` for a dispatch that delivered nothing. `inject_id` rides on the error
          // body for the same reason: a caller told its dispatch was refused must be able to poll the
          // record that says so.
          const aborted = trackedRecord
            ? await (0, shared.abortTrackedInjection)(inject_id, id, delivery.code, delivery.error, delivery.delivery_uncertain
              ? { kind: 'inject_delivery_unknown', trigger: 'delivery_outcome_unknown', bytesWritten: null } : {})
            : 'no_tracked_inject';
          return (0, shared.respondWithError)(res, delivery.httpStatus || 500, delivery.code || 'DELIVERY_FAILED', delivery.error,
            { inject_id, tracking_state: aborted === 'tracking_aborted' ? 'aborted' : 'unavailable',
              // Task 1215 (#879 discriminator): the measured barrier wait of a QUEUE_TIMEOUT refusal (nothing was written).
              ...(delivery.code === 'QUEUE_TIMEOUT' && Number.isSafeInteger(delivery.queue_wait_ms) ? { queue_wait_ms: delivery.queue_wait_ms } : {}),
              ...(session.sshRemote ? { text_written: delivery.text_written === true,
                text_bytes_written: delivery.text_bytes_written ?? null, bytes_written: delivery.bytes_written ?? null,
                retry_safe: delivery.bytes_written === 0 && delivery.text_written !== true } : {}),

              ...(delivery.delivery_uncertain ? { delivery_uncertain: true, retryable: false, bytes_written: null, submit: 'skipped' } : {}) },
            // Task 1215: a numeric public text travels as its internal (non-enumerable) context, never re-parsed.
            delivery.publicErrorContext);
        }

        if (from) session.lastInjectFrom = from;
        if (reply_to) {
          session.lastInjectReplyTo = reply_to;
          session.lastInjectReturn = claimedReturn;
        }
        if (thread_id) session.lastThreadId = thread_id;

        // #860 F2 — the service log gets the same distinction the audit line does. "Wrote" was printed
        // for a queue push too, so an operator grepping the log for a delivery found one that had not
        // happened.
        console.log(`[INJECT] ${(0, shared.deliveryAuditResult)(delivery) === 'queued' ? 'Queued for' : 'Wrote to'} session ${id} (inject_id: ${inject_id})`);

        const injectTimestamp = new Date().toISOString();
        // #43 P1/P2 — one audit line per delivery (claimed + daemon-verified sender, hash-only).
        (0, shared.auditAppend)({
          ts: injectTimestamp, inject_id, kind: 'inject', source: 'inject',
          claimed_from: from || null, ...verifiedSender, claimed_return: claimedReturn,
          to: id, to_alias: requestedId !== resolvedId ? requestedId : null,
          origin: req.body.forwarding ? 'untrusted-remote' : 'trusted-local',
          origin_host: req.body.forwarding ? null : shared.MACHINE_ID, ref_path: req.body.ref_path || null,
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
        // #1215 pipe200 S24 (disclosure197 P1): a strict-mode non-owner holding only session.inject reaches this catch,
        // and is not entitled to host paths or internal state. The raw exception therefore stays a LOCAL operator
        // diagnostic. The response and the inject_failed event/bus sink carry one stable text, with the unchanged
        // status 500 and code DELIVERY_FAILED.
        console.error('[INJECT] delivery threw for %s inject_id=%s:', id, inject_id, err && err.stack ? err.stack : err);
        (0, shared.emitInjectFailureEvent)(id, 'DELIVERY_FAILED', INJECT_DELIVERY_FAILED_TEXT, { inject_id }, session);
        res.status(500).json((0, shared.buildErrorBody)('DELIVERY_FAILED', INJECT_DELIVERY_FAILED_TEXT));
      }
    });
  }

  // Task 1270 — POST /api/sessions/:id/inject-bound-v1 (telepty.bound-inject/v1).
  //
  // ONE versioned route for the bound busy-input transport. Everything below the schema check is a REFUSAL
  // BEFORE ANY EFFECT, in a fixed order, and every answer — refusal, acceptance or outcome_unknown — is the
  // one closed telepty.bound-inject-result/v1 object, so a caller parses a single shape and never guesses.
  //
  // Authorization is NOT re-implemented here: the request reaches this handler only through the SAME
  // createAuthMiddleware chain as /inject (origin guard → peer reachability → client-profile gate → strict
  // principal / host token / JWT / session bearer). Two consequences are deliberate and must stay:
  //   • the client-profile gate classifies paths exactly and default-DENIES anything it does not name, so a
  //     profile-scoped caller is refused on this route — it is not widened to a new grant, and cross-profile
  //     denial is unchanged (src/protocol/client-profiles.js is untouched);
  //   • the mailbox session-bearer scope is an exact path match and does not reach here either.
  // The target is the EXACT OWN record only — no alias, no `-N` sibling, no resolveSessionAlias fallback — so
  // a bound body can never land in a session the caller did not name.
  function registerInjectBoundV1Route(app, routePath = '/api/sessions/:id/inject-bound-v1') {
    app.post(routePath, async (req, res) => {
      const requestedId = req.params.id;
      // #43 P1/P2 / #815 — the daemon-verified sender (from the presented bearer, never body.from), resolved
      // ONCE here because two different seams need it: the audit line below and the delivery provenance banner.
      const verifiedPrincipal = (0, shared.verifiedPrincipalFromReq)(req);
      const verifiedSender = (0, shared.verifiedSenderFields)(verifiedPrincipal);
      const claimedFrom = req.body && typeof req.body.from === 'string' ? req.body.from : null;
      const promptText = req.body && typeof req.body.prompt === 'string' ? req.body.prompt : null;
      // #47 P5 (review finding M1) — ONE audit line per terminal outcome of this door, in the EXISTING record
      // shape with no new field: a bound delivery is a write into somebody's terminal with exactly the authority
      // of POST /inject, and an operator reads the inject log as THE record of who typed into a session. The
      // vocabulary is this door's own and deliberately avoids `success`, which in this log means bytes measured
      // as written: `forwarded` is the honest word for frames handed to the owner bridge (the same word the
      // ws-viewer door uses for the same kind of handoff).
      const recordAudit = (deliveryResult, injectId) => (0, shared.auditAppend)({
        ts: new Date().toISOString(), inject_id: injectId || null, kind: 'inject', source: 'inject-bound-v1',
        claimed_from: claimedFrom, ...verifiedSender,
        to: requestedId,   // the exact own id; this route resolves no alias, so there is never a to_alias
        origin: 'trusted-local', origin_host: shared.MACHINE_ID,
        payload: promptText, delivery_result: deliveryResult
      });
      // Every answer reports the DAEMON's current identity, never the values the request claimed. The record is
      // resolved through the same exact-own-id helper the route's target resolution uses (#1215), so a prototype
      // key such as `__proto__` can never present an inherited object as a session (review finding m4).
      const answer = (status, fields) => {
        const ownId = exactOwnSessionId(requestedId);
        const session = ownId ? shared.sessions[ownId] : null;
        return res.status(status).json(boundInject.boundResult({
          sessionId: requestedId,
          sessionEpoch: session ? (session.sessionEpoch || null) : null,
          ownerGeneration: session ? (session.interactionOwnerGeneration || null) : null,
          ...fields,
        }));
      };
      // A refusal is always 4xx: nothing was written, and the caller may act on that with certainty. 5xx is
      // reserved for outcome_unknown, where it may not.
      //
      // Task 1270 r3 (re-review finding RR-m2): a route refusal writes NO audit line, which is exactly what the
      // legacy /inject route does — it audits the #533 block and the terminal delivery outcomes, and a legacy
      // 404 or 400 leaves no record at all. The r1 version audited every refusal, so an authenticated caller
      // could append unbounded full-prompt records to the inject log by POSTing to ids that do not exist. The
      // audit calls now sit on the outcome classes legacy audits, and nowhere else.
      const refuse = (status, reason) => answer(status, { stage: 'refused', reason });

      const id = exactOwnSessionId(requestedId);
      if (!id) return refuse(404, 'session_not_found');
      const session = shared.sessions[id];
      if (session.isClosing) return refuse(409, 'session_closing');

      // 1. The CLOSED request schema, before anything looks at the session's state.
      const invalid = boundInject.validateBoundRequest(req.body);
      if (invalid) return refuse(400, invalid);

      // 1b. #533 Phase 2 — the peer-lane inject guardrail, the SAME verdict with the SAME inputs the legacy
      //     /inject route computes, before any of this session's transport state is inspected and before any
      //     effect (review finding B2). A new write door with the authority of /inject may not have less
      //     accountability than /inject: `from` is not merely schema-validated here, it is POLICY-CHECKED, so a
      //     credential that is blocked from raw peer→peer work delegation on /inject is blocked here too.
      //     Same keying (the CLAIMED sender), so this stays a policy guardrail and not an authentication
      //     boundary, and the same fail-open-with-warning behaviour when no orchestrator sid is configured.
      const peerVerdict = (0, shared.classifyPeerLaneInject)({
        from: claimedFrom, to: requestedId, prompt: req.body.prompt, orchestratorSids: shared.ORCHESTRATOR_SIDS
      });
      if (peerVerdict.decision === 'block') {
        // r3 (finding RR-m4): the SAME bus event type the legacy route emits for the same verdict, with the
        // same extra field SET, so a subscriber reading `peer_inject_blocked` as THE enforcement record sees
        // bound blocks too. One field's VALUE cannot match and that is deliberate (r5, finding D2):
        // `inject_id` is null here because this door mints no transport identity before this gate — the
        // legacy route mints its UUID above its own #533 check, this one only below. So bound blocks
        // correlate by `(target_agent, from, reason)`, not by `inject_id`. Minting one early would
        // contradict this route's own closed result, which gives a refusal no identity at all (see the
        // `injectId` comment on the answer below) and would put an id in the audit log for a request that
        // never had one. `broadcastSessionEvent` is an existing `shared` seam and is synchronous — it adds
        // no await, and this arm has no effect to precede.
        (0, shared.broadcastSessionEvent)('peer_inject_blocked', id, session, {
          extra: {
            target_agent: id,
            from: claimedFrom,
            reason: peerVerdict.reason,
            attempted_kind: peerVerdict.kind,
            envelope_present: peerVerdict.envelopePresent,
            inject_id: null   // no transport identity is minted for a request that is blocked before delivery
          }
        });
        console.warn(`[PEER-GUARD] blocked bound inject ${claimedFrom} → ${requestedId} (${peerVerdict.reason})`);
        // One audit line with the legacy `blocked:<reason>` vocabulary — the #533 gate logic itself is unchanged.
        recordAudit(`blocked:${peerVerdict.reason}`, null);
        return answer(403, { stage: 'refused', reason: 'peer_inject_blocked' });
      }
      if (peerVerdict.lane === 'disabled') {
        console.warn('[PEER-GUARD] orchestrator sid unconfigured (AIGENTRY_ORCHESTRATOR_SIDS empty) — peer guardrail disabled (fail-open)');
      }

      // 2. The binding the caller pinned must be the daemon's CURRENT one. An epoch or generation mismatch is a
      //    refusal, never a "close enough" delivery: the whole point of the schema is that a body cannot land on
      //    an owner the caller did not verify. Compared as opaque strings.
      if (req.body.expected_epoch !== session.sessionEpoch) return refuse(409, 'epoch_mismatch');
      if (req.body.expected_owner_generation !== session.interactionOwnerGeneration) return refuse(409, 'owner_generation_mismatch');

      // 3. Transport shape and BOTH required capabilities, for the current owner generation only. An old bridge
      //    (one that never declared busy-input-v1 on its own claim) is refused here, before any effect — its
      //    silence about the capability is not permission to write into a busy composer.
      if (session.type !== 'wrapped' || session.sshRemote) return refuse(409, 'transport_not_applicable');
      if (busyInputSupport(session) !== 'supported') return refuse(409, 'busy_input_unsupported');
      if (immediateSubmitSupport(session) !== 'supported') return refuse(409, 'immediate_submit_unsupported');
      if (!(0, shared.isOpenWebSocket)(session.ownerWs)) return refuse(409, 'owner_disconnected');

      // 4. Every existing input fence that applies to a wrapped delivery, unchanged and none of them removed.
      //
      //    Review finding M6: these gates are evaluated HERE for the caller's refusal, and the SAME predicate
      //    (`boundAdmissionRefusal`, one synchronous function in the delivery runtime) is re-evaluated inside the
      //    delivery after every await and immediately before each write. One function, so the two sites cannot
      //    drift: the state the route admitted on is the state the body is written on, not a 10-second-old
      //    snapshot. The ORDER is the pre-existing one — stranded composer, held interaction, session health,
      //    input transport, bootstrap readiness, bootstrap backlog, body custody, surface modal.
      const denied = protectedInputFailure(session);
      if (denied) return refuse(403, 'protected_input');
      const inadmissible = (0, shared.boundAdmissionRefusal)(session);
      if (inadmissible) return refuse(409, inadmissible);

      // 5. The single bound delivery. The inject_id names THIS pair (body frame and its CR) for the bridge and
      //    for the caller's own durable record; it is not a tracked-ledger observation, and this route creates
      //    no pendingReports entry — the closed result has no tracking field and the controller disposition
      //    keeps the caller's registry fact mapping outside this unit.
      const inject_id = shared.crypto.randomUUID();
      let outcome;
      try {
        outcome = await (0, shared.deliverBoundInjection)(id, session, req.body.prompt, {
          expectedEpoch: req.body.expected_epoch,
          expectedOwnerGeneration: req.body.expected_owner_generation,
          injectId: inject_id,
          // #47 P4 (review finding M2) — the claimed and the daemon-verified sender, so the capability-gated
          // provenance banner a provenance-capable session was promised is applied to a bound body too. For a
          // non-capable session (the default) the transform is a documented no-op and the bytes are unchanged.
          from: claimedFrom,
          verifiedSenderSid: verifiedPrincipal ? verifiedPrincipal.sid : null,
        });
      } catch (err) {
        // The delivery threw after it may already have handed the body: that is unknown, never a refusal and
        // never a retry. The raw exception stays a LOCAL operator diagnostic (#1215 pipe200 S24). The delivery
        // itself strands the exact identity on its way out when the body was already handed, so the composer is
        // protected before this answer is written (review finding M5).
        console.error('[INJECT-BOUND-V1] delivery threw for %s inject_id=%s:', id, inject_id, err && err.stack ? err.stack : err);
        recordAudit('outcome_unknown:delivery_threw', inject_id);
        return answer(500, { stage: 'outcome_unknown', reason: 'delivery_threw', injectId: inject_id,
          bodyStage: 'unknown', submitStage: 'unknown', bytesWritten: null });
      }
      // r3 (finding RR-m10): the one reason the shared predicate can return AFTER an await that the route would
      // itself have answered 403 keeps that status, so a mid-flight protected-input enrolment reads the same to
      // a caller whether it was caught before or during the delivery. Every other refusal stays 409.
      const status = outcome.stage === 'accepted' ? 200
        : outcome.stage === 'refused' ? (outcome.reason === 'protected_input' ? 403 : 409)
          : 500;
      console.log(`[INJECT-BOUND-V1] ${id} ${outcome.stage}${outcome.reason ? ` (${outcome.reason})` : ''} inject_id=${inject_id}`);
      // The terminal audit line for the delivery itself — the outcome classes the legacy route audits
      // (RR-m2). `forwarded` ONLY for accepted (both frames handed to the pinned owner); a delivery-returned
      // refusal and an unknown each say so, with the bounded reason the caller also gets.
      recordAudit(outcome.stage === 'accepted' ? 'forwarded'
        : `${outcome.stage === 'refused' ? 'refused' : 'outcome_unknown'}:${boundInject.boundedReason(outcome.reason)}`,
      outcome.stage === 'refused' ? null : inject_id);
      if (outcome.stage === 'accepted') {
        // r3 (finding RR-m3): the legacy route sets `session.lastInjectFrom = from` on its delivered arm, and
        // `transport.last_inject_from` is read from it — so without this the view named an older legacy sender
        // while the most recent write to that composer was a bound one. A plain field assignment on the record
        // this request is pinned to; no seam, no await, and it runs AFTER both frames are already handed.
        if (claimedFrom) session.lastInjectFrom = claimedFrom;
        // …and the same bus event the legacy route emits for a written delivery, with the same non-secret
        // metadata (never the prompt itself — #815). `broadcastSessionEvent` is an existing `shared` seam and is
        // synchronous, so this adds no await anywhere, let alone before an effect. `inject_queued` has no bound
        // counterpart on purpose: this transport never parks, so `accepted` is only ever "handed to the owner".
        (0, shared.broadcastSessionEvent)('inject_written', id, session, {
          extra: {
            inject_id,
            target_agent: id,
            content_sha256: shared.crypto.createHash('sha256').update(req.body.prompt).digest('hex'),
            content_length: Buffer.byteLength(req.body.prompt),
            from: claimedFrom,
            ...verifiedSender,
            spoof_suspected: !!(claimedFrom && verifiedPrincipal && claimedFrom !== verifiedPrincipal.sid),
            origin: 'trusted-local',
            transport: 'inject-bound-v1',
            body_stage: outcome.bodyStage,
            submit_stage: outcome.submitStage
          }
        });
      }
      return answer(status, {
        stage: outcome.stage,
        reason: outcome.reason,
        // A refused request has no transport identity to correlate; an accepted or unknown one does, and the
        // caller needs it precisely because the unknown case must be held rather than replayed.
        injectId: outcome.stage === 'refused' ? null : inject_id,
        bodyStage: outcome.bodyStage,
        submitStage: outcome.submitStage,
        bytesWritten: outcome.bytesWritten,
      });
    });
  }

  // Task 1270 operator clear — the daemon's own observation about the child the stranded text was typed into.
  // 'replaced' needs BOTH records (the strand's `child`, written at strand time, and the current generation's
  // accepted milestone) and a difference in `child_seq` or `pid`; 'same_child' needs both and no difference;
  // 'unobservable' is the honest answer whenever either side is missing — a legacy bridge announces no
  // milestone at all, and a strand written before this field existed carries none. The comparison is only
  // valid inside ONE epoch, which step 4.6 has already pinned.
  function childEvidence(session, strand) {
    const recorded = strand && strand.child && typeof strand.child === 'object' ? strand.child : null;
    const observed = readinessHandshake.observedChild(session);
    if (!recorded || !observed) return 'unobservable';
    if (!Number.isSafeInteger(recorded.child_seq) || !Number.isSafeInteger(observed.child_seq)) return 'unobservable';
    if (recorded.child_seq !== observed.child_seq || recorded.pid !== observed.pid) return 'replaced';
    return 'same_child';
  }

  // The two counts the clear REPORTS and never acts on. Read defensively: a session object whose accessor
  // throws must not be able to turn an honest answer into a 5xx (there is no 5xx on this route), and these are
  // read on the error path too.
  function clearQueueDepth(session) {
    try { return Array.isArray(session.bootstrapQueue) ? session.bootstrapQueue.length : 0; } catch { return 0; }
  }
  function clearCustodyDepth(session) {
    try { return session.bodyCustody instanceof Map ? session.bodyCustody.size : 0; } catch { return 0; }
  }

  // Task 1270 — POST /api/sessions/:id/clear-strand-v1 (telepty.clear-strand/v1).
  //
  // THE operator clear for a stranded composer, and the ONLY way out of the strand short of re-registering the
  // session. A bound delivery that handed a body and then could not hand its CR leaves unsubmitted text in a
  // real composer and STRANDS that instance: every later body and key from every producer is refused, by
  // design, because appending to or submitting that half-written line is worse than refusing. Until this route
  // existed the only exit was to destroy the session — so the hotfix could not ship.
  //
  // What it does: deletes ONE strand record for ONE exactly-named session instance, after a four-part identity
  // pin (epoch + owner generation + the stranded inject id + an operator basis). What it NEVER does: write a
  // byte, send a key, touch a queue, settle custody, release a barrier, close a socket, arm a timer or hand a
  // bridge frame. There is no force flag and no automatic variant. `basis` is an operator CLAIM — the daemon
  // cannot observe composer contents (CLEAR-DESIGN §2.1) — so it is recorded, and only the checkable basis
  // (`child_replaced_observed`) is verified against the daemon's own milestone.
  //
  // Authority is the /api/daemon/stop guard, not this file's own invention: a loopback SOCKET peer (forwarded
  // headers are never consulted), NO Origin header, an exact `application/json` media type, a 1..1100-byte raw
  // body, and the local administrative token in the `x-telepty-token` HEADER under a timing-safe compare. A query
  // token, a JWT, a session bearer and a client-profile carrier satisfy NONE of it. The expected secret never
  // enters this module: step 1.5 is the injected `verifyHostToken(req)`, which daemon.js closes over
  // EXPECTED_TOKEN. A request that ALSO carries a session bearer is not refused — `fetchWithAuth` attaches one
  // automatically inside any registered session, and any session can read the host token from HOME anyway, so
  // refusing buys nothing against an adversary while blocking a legitimate operator; the verified sender is
  // RECORDED instead (CLEAR-DESIGN §1.2, OPEN-QUESTIONS Q4).
  //
  // Every refusal precedes every effect, in the frozen order of CLEAR-INTERFACE §5, and every answer — refusal,
  // clear, or caught exception — is the one closed telepty.clear-strand-result/v1 object. The handler is
  // deliberately NOT async: between reading the strand and deleting it there is no await, no .then, no timer
  // and no microtask, so no reclaim, destroy, delivery or second clear can interleave with the decision.
  function registerClearStrandV1Route(app, { verifyHostToken, routePath = '/api/sessions/:id/clear-strand-v1' } = {}) {
    // A route that cannot authenticate MUST NOT exist. Construction-time, not request-time: a daemon wired
    // without the token check must fail to start rather than serve an unauthenticated clear.
    if (typeof verifyHostToken !== 'function') {
      throw new TypeError('registerClearStrandV1Route requires a verifyHostToken(req) function');
    }
    // Registered exactly ONCE, at exactly one path: no forwarded twin, no alias form, no query-parameter
    // variant (contrast registerInjectRoute, which is deliberately registered twice).
    app.post(routePath, function (req, res) {
      const requestedId = req.params ? req.params.id : null;
      let answered = false;
      const send = (status, result) => {
        answered = true;
        return res.status(status).json(result);
      };
      // Steps 1-3 answer with NO identity at all: before the credential check passed, and before the target is
      // known to exist, this daemon says nothing about any session — not its epoch, not its owner generation,
      // not whether it is stranded. An unauthenticated caller learns only that it was refused.
      const blind = (status, reason) => send(status, clearStrand.clearResult({
        stage: 'refused', reason, sessionId: requestedId,
      }));
      try {
        // ── Step 1 — transport authority ────────────────────────────────────────────────────────────────────
        // 1.1 loopback peer · 1.2 no Origin · 1.3 exact application/json · 1.4 a 1..1100-byte raw body: one
        // decision that never sees the token, then 1.5, the injected comparison, which is the ONLY credential
        // this door accepts. Strict `!== true` so a seam that returns something truthy-but-not-true fails closed.
        const transport = clearStrand.authorizeClearStrandTransport(req);
        if (transport) return blind(transport.status, transport.reason);
        if (verifyHostToken(req) !== true) return blind(401, 'clear_auth_required');

        // ── Step 2 — the closed request shape, before anything looks at a session ────────────────────────────
        const invalid = clearStrand.validateClearRequest(req.body);
        if (invalid) return blind(400, invalid);
        const body = req.body;

        // ── Step 3 — the target's own shape ─────────────────────────────────────────────────────────────────
        if (!clearStrand.boundedToken(requestedId)) return blind(400, 'clear_target_invalid');

        // ── Step 4 — target identity and state, in the frozen order ─────────────────────────────────────────
        // 4.1 The EXACT OWN record and nothing else: no alias, no `-N` sibling, no resolveSessionAlias
        // fallback, no prototype adoption (`__proto__`, `constructor` and `toString` are 404s here).
        const id = exactOwnSessionId(requestedId);
        if (!id) return blind(404, 'session_not_found');
        const session = shared.sessions[id];

        // From 4.1 onward every answer names the DAEMON's own current identity — never the values the request
        // claimed — echoes the validated basis, and reports the two queues it did not touch.
        const answer = (status, fields) => send(status, clearStrand.clearResult({
          sessionId: requestedId,
          sessionEpoch: session.sessionEpoch || null,
          ownerGeneration: typeof session.interactionOwnerGeneration === 'string' && session.interactionOwnerGeneration
            ? session.interactionOwnerGeneration : null,
          basis: body.basis,
          pendingBootstrapOps: clearQueueDepth(session),
          bodyCustody: clearCustodyDepth(session),
          ...fields,
        }));
        // The DAEMON-verified sender (from the presented bearer, never body.from), resolved once: the audit
        // line, the bus event and the view's `by` all name it, and the claimed `from` is recorded beside it.
        const verifiedPrincipal = (0, shared.verifiedPrincipalFromReq)(req);
        const verifiedSender = (0, shared.verifiedSenderFields)(verifiedPrincipal);
        const claimedFrom = typeof body.from === 'string' ? body.from : null;
        // ONE audit line per outcome from 4.1 onward (CLEAR-INTERFACE §7.1). `payload` is the empty string
        // because there IS no payload on this door; every value below is a bounded code, an opaque identity
        // token, an ISO timestamp or a boolean. No screen, prompt or composer text exists here to leak.
        const recordAudit = (deliveryResult, strand, evidence, persisted) => (0, shared.auditAppend)({
          ts: new Date().toISOString(),
          inject_id: strand && strand.inject_id ? strand.inject_id : null,
          kind: 'operator-clear', source: 'clear-strand-v1',
          claimed_from: claimedFrom, ...verifiedSender,
          to: id,   // the exact own id; this route resolves no alias, so there is never a to_alias
          origin: 'trusted-local', origin_host: shared.MACHINE_ID,
          payload: '',
          delivery_result: deliveryResult,
          clear: {
            session_epoch: session.sessionEpoch || null,
            owner_generation: typeof session.interactionOwnerGeneration === 'string' ? session.interactionOwnerGeneration : null,
            basis: body.basis,
            strand_reason: strand ? strand.reason : null,
            strand_at: strand ? strand.at : null,
            child_evidence: evidence,
            persisted: persisted === true,
          },
        });
        const refuse = (status, reason, strand = null, evidence = 'unobservable') => {
          recordAudit(`refused:${reason}`, strand, evidence, false);
          console.warn('[CLEAR-STRAND-V1] %s refused (%s) stranded_inject_id=%s', id, reason,
            body.stranded_inject_id === null ? 'null' : body.stranded_inject_id);
          return answer(status, { stage: 'refused', reason, childEvidence: evidence });
        };

        if (session.isClosing) return refuse(409, 'session_closing');
        // A cooperative handoff is mid-flight: its own retained text may still be written, so the composer's
        // state is not this operator's to assert about yet.
        if (activeHandoff(session)) return refuse(409, 'handoff_active');
        // Only a local wrapped session has an owner bridge whose composer can hold text. A mailbox, a spawned
        // and an SSH record have no strand this door could be clearing.
        if (!(session.type === 'wrapped' && !session.sshRemote)) return refuse(409, 'transport_not_applicable');
        // 4.5 A LIVE strand, i.e. one that applies to this session's current instance. A record left behind by
        // a superseded epoch is already inert and is NOT removed here: it belongs to an instance this request
        // does not name, and a later restore of that epoch must still find it.
        const strand = strandedComposer(session);
        if (!strand) return refuse(409, 'not_stranded');
        // Computed once, before any answer that needs it. There is no await between here and the deletion, so
        // this value cannot go stale: it is the same observation step 5.1 would make.
        const evidence = childEvidence(session, strand);
        if (body.expected_epoch !== session.sessionEpoch) return refuse(409, 'epoch_mismatch', strand, evidence);
        if (!(typeof session.interactionOwnerGeneration === 'string' && session.interactionOwnerGeneration)) {
          return refuse(409, 'owner_generation_unavailable', strand, evidence);
        }
        if (body.expected_owner_generation !== session.interactionOwnerGeneration) {
          return refuse(409, 'owner_generation_mismatch', strand, evidence);
        }
        // The owner that holds the composer must still be here: with no live owner there is no composer this
        // clear could be about, and the next claim will mint a new generation anyway.
        if (!(0, shared.isOpenWebSocket)(session.ownerWs)) return refuse(409, 'owner_disconnected', strand, evidence);
        // 4.10 Strict `===`, `null === null` included: no case folding, no regex-derived equivalence, no
        // prefix match. An operator who quotes a DIFFERENT delivery's id has not read this session's view.
        if (body.stranded_inject_id !== strand.inject_id) {
          return refuse(409, 'stranded_inject_id_mismatch', strand, evidence);
        }
        // 4.11 The one checkable basis is CHECKED. A refused milestone frame had no effect, so it cannot
        // corroborate anything, and a legacy bridge that announces nothing cannot either.
        if (body.basis === 'child_replaced_observed' && evidence !== 'replaced') {
          return refuse(409, 'basis_contradicted', strand, evidence);
        }

        // ── Step 5 — the effect: ONE synchronous in-memory deletion, then the records ────────────────────────
        // The keyed removal: it can only remove THIS record, for THIS epoch and THIS inject id. A null return
        // is unreachable here (nothing above awaited), and it answers `not_stranded` rather than claiming a
        // clear the daemon did not perform.
        const removed = clearStrandedComposer(session, { epoch: strand.epoch, injectId: strand.inject_id });
        if (!removed) return refuse(409, 'not_stranded', strand, evidence);
        // Memory-only, and deliberately NOT in the persistence whitelist: it tells the NEXT operator that this
        // instance was already cleared once. `by` is the VERIFIED sender or null — never the claimed `from`.
        //
        // r2 erratum (review finding CSR-m3): the record carries the EPOCH it was written for, and the view
        // emits it only while that epoch is still the live one. `src/principal/takeover.js` reassigns
        // `sessionEpoch` on the SAME session object, so without the epoch the next instance's view would
        // report a clear performed against an instance that no longer exists, with nothing in the field to
        // reveal the staleness. The emitted key set stays the five fields of §7.3 — `epoch` is a key of the
        // RECORD, not of the view — and the durable record (the audit line's `clear_session_epoch`) was
        // already correct.
        session.lastStrandClear = {
          at: new Date().toISOString(),
          epoch: session.sessionEpoch || null,
          basis: body.basis,
          stranded_inject_id: removed.inject_id,
          child_evidence: evidence,
          by: verifiedPrincipal ? verifiedPrincipal.sid : null,
        };
        // The one fallible step. Reported, never swallowed and never rolled back: a clear that happened in
        // memory but could not be saved is told the truth, because re-adding the strand would deny input to a
        // composer the operator has just emptied.
        let persisted = false;
        let persistReason = 'session_store_write_failed';
        if (typeof shared.persistSessions === 'function') {
          try {
            const saved = (0, shared.persistSessions)();
            persisted = !!(saved && (saved.ok || saved.committed));
            persistReason = persisted ? null : 'session_store_write_failed';
          } catch (error) {
            persisted = false;
            persistReason = 'session_store_write_threw';
            console.warn('[CLEAR-STRAND-V1] %s cleared in memory but the session store write threw:', id,
              error && error.message ? error.message : error);
          }
        } else {
          // No store seam in this composition at all: nothing was attempted, and nothing is claimed.
          persistReason = 'not_attempted';
        }
        // Review note CSR-n7: this call is deliberately NOT individually wrapped. §6's justification for
        // answering a caught exception 409 `refused` requires that every step after the delete either cannot
        // throw or has already answered, and this one cannot: `shared.auditAppend` is the delivery-runtime
        // wrapper whose whole body is `try { auditWriter.append(record) } catch {}` ("audit must never throw
        // into a handler"). If this is ever pointed at a raw writer, wrap it here.
        recordAudit('cleared', removed, evidence, persisted);
        // The bus event the operator's own tooling reads. `extra` carries NO key named `transport`, so the
        // envelope's transport block is not shadowed (the defect recorded for the bound `inject_written`
        // event), and the type is deliberately absent from APPROVED_TYPES, so the scoped read-only
        // session-event transport does not carry it. Wrapped: a throwing subscriber must not be able to turn an
        // honest 200 into a refusal for a clear that already happened.
        try {
          (0, shared.broadcastSessionEvent)('composer_strand_cleared', id, session, {
            extra: {
              target_agent: id,
              stranded_inject_id: removed.inject_id,
              strand_reason: removed.reason,
              strand_at: removed.at,
              basis: body.basis,
              child_evidence: evidence,
              persisted,
              from: claimedFrom,
              verified_sender_sid: verifiedSender.verified_sender_sid,
              verified_sender_epoch: verifiedSender.verified_sender_epoch,
              verified_sender_generation: verifiedSender.verified_sender_generation,
              spoof_suspected: !!(claimedFrom && verifiedSender.verified_sender_sid
                && claimedFrom !== verifiedSender.verified_sender_sid),
              origin: 'trusted-local',
            },
          });
        } catch (error) {
          console.warn('[CLEAR-STRAND-V1] %s cleared but the bus event threw:', id,
            error && error.message ? error.message : error);
        }
        console.log('[CLEAR-STRAND-V1] %s cleared basis=%s child_evidence=%s persisted=%s', id, body.basis,
          evidence, persisted);
        return answer(200, {
          stage: 'cleared', reason: null,
          clearedInjectId: removed.inject_id,
          clearedStrandReason: removed.reason,
          clearedStrandAt: removed.at,
          childEvidence: evidence,
          persisted, persistReason,
        });
      } catch (error) {
        // There is NO 5xx on this route. At every point where a throw is reachable the effect has either not
        // happened (the answer is honest as a refusal) or has happened and been reported by the answer above —
        // so a caught exception is answered 409 `refused`, with the exception text staying a LOCAL operator
        // diagnostic. If an answer was already sent, the throw came after it and nothing more is said.
        // r2 erratum (review finding CSR-m7): the id is logged through JSON.stringify. express percent-decodes
        // `:id`, so a caller could put a newline in it and forge an extra line in the daemon's own log. Narrow
        // — step 3 refuses control characters before any other use, so only a throw raised in step 1.5 or
        // step 2 reaches this line — but a log an operator reads during an incident is exactly where a forged
        // line costs the most. The refusal warn above uses `id`, which step 3 has already bounded.
        console.error('[CLEAR-STRAND-V1] %s handler threw:', JSON.stringify(requestedId),
          error && error.stack ? error.stack : error);
        if (answered) return undefined;
        return blind(409, 'refused');
      }
    });
  }

  function registerKillRoute(app) {
    app.post('/api/sessions/:id/kill', async (req, res) => {
      const requestedId = req.params.id;
      // #548: destructive op — must not cascade across alias-sharing siblings.
      const ownedKill = req.query?.owned === 'true';
      const resolvedId = ownedKill ? exactOwnSessionId(requestedId) : (0, shared.resolveSessionForDestroy)(requestedId);
      if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
      const session = shared.sessions[resolvedId];
      if (ownedKill || session.requireOwnerProof === true) {
        if (exactOwnSessionId(requestedId) !== resolvedId) return res.status(404).json({ error: 'Exact session id required.' });
        const principal = (0, shared.verifiedPrincipalFromReq)(req);
        if (!principal || principal.sid !== resolvedId || !session.sessionEpoch
            || principal.epoch !== session.sessionEpoch || principal.generation !== (Number(session.credentialGeneration) || 1)) {
          return (0, shared.respondWithError)(res, 403, 'OWNED_KILL_FORBIDDEN', 'Kill requires the current session credential.');
        }
      }

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
        // Task 1215: the raw exception text never reaches the public response; the stable text was the fallback.
        res.status(500).json({ error: 'Failed to kill session' });
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
      if (ownedDelete || session.requireOwnerProof === true) {
        if (exactOwnSessionId(requestedId) !== resolvedId) return res.status(404).json({ error: 'Exact session id required.' });
        const principal = (0, shared.verifiedPrincipalFromReq)(req);
        const generation = Number(session.credentialGeneration) || 1;
        if (!principal || principal.sid !== id || !session.sessionEpoch
            || principal.epoch !== session.sessionEpoch || principal.generation !== generation) {
          return (0, shared.respondWithError)(res, 403, 'OWNED_DELETE_FORBIDDEN',
            'Owned delete requires the current session credential.', { requested: requestedId });
        }
      }
      if (session.isClosing && !session.closeDurabilityPending) return res.status(409).json({ success: false, code: 'SESSION_CLOSING', error: 'Session is closing' });
      // BUG-C (shared-fate): a wrapped session can be co-bound by a stale/displaced owner bridge
      // (duplicate --id). A DELETE carrying a token that is NOT the current owner's, while a live
      // owner ws is still open, is that stale bridge exiting — it must NOT tear down the live owner.
      // Detach-only (no-op): leave the record and every client untouched. Tokenless callers
      // (operator `telepty delete`, ghost clean) and matching-token current-owner exits are
      // unaffected. Forceful kills go through POST /:id/kill (teardownSessionById), not here.
      const ownerHeaderCount = (req.rawHeaders || []).filter((name, index) => index % 2 === 0 && String(name).toLowerCase() === 'x-telepty-owner-token').length;
      const ownerHeader = req.headers?.['x-telepty-owner-token'];
      if (ownerHeaderCount > 1 || (ownerHeader !== undefined && (typeof ownerHeader !== 'string' || !ownerHeader || ownerHeader.length > 128))
          || (ownerHeader && req.query.owner_token)) return res.status(400).json({code:'OWNER_TOKEN_HEADER_INVALID',error:'Invalid owner token carrier.'});
      const ownerToken = ownerHeader || req.query.owner_token;
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
      const prepared = beginDurableSessionClose(id, session);
      if (!prepared.success) return res.status(prepared.httpStatus).json(prepared);
      let killError = null;
      try {
        if (session.type === 'wrapped') {
          if (session.clients) session.clients.forEach(ws => ws.close(1000, 'Session destroyed'));
        } else if (session.ptyProcess) {
          // #1215 fix93 — arm the exit confirmation on the captured pty before signalling it.
          const pty = session.ptyProcess;
          confirmDeletedPtyExit(id, session, pty);
          pty.kill();
        }
      } catch (err) {
        killError = err;
      }
      // Surface close is the orchestrator's job (Workspace Host adapter), per the 2026-05-30
      // verdict — NO-OP on the managed path. The orchestrator's session-cleanup.sh closes the
      // surface on this normal CLI-exit (CLEANUP_REQUEST→wh_close). Actuates only for a standalone
      // telepty with AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1 (gate lives in closeSurface).
      if (shared.sessions[id] === session) { try { shared.terminalBackend.closeSurface(session); } catch {} }
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
      if (shared.sessions[id] === session) {
        shared.sessionStateManager.markTerminationRequested(id, 'operator_delete', killError && killError.message);
        shared.sessionStateManager.unregister(id);
        delete shared.sessions[id];
        try { shared.mailbox.purge(id); } catch {}
        shared.lifecycle.cleanupSessionArtifacts(id, effects.cleanup);
      }
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

  const actions = {
    buildAutoSummaryWithDefaults,
    observationIdentity,
    markAbsenceDeliveredToSource,
    recordObservation,
    recordSessionFact,
    observationClass,
    trackingResultFor,
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
    registerInjectBoundV1Route,   // Task 1270: POST /api/sessions/:id/inject-bound-v1
    registerKillRoute,
    registerDeleteRoute,
    registerBusPublishRoute,
    registerStateObserver,
  };
  // Task 1270 — the clear registrar is reachable BY NAME and invisible to ENUMERATION, on purpose.
  //
  // Every other registrar here can be composed blind: a harness that knows nothing about a particular route
  // can do `for (const [name, fn] of Object.entries(actions)) if (/^register\w*Route$/.test(name)) fn(app)`
  // and get a working app. Several existing test harnesses do exactly that (test/inject-bound-v1-1270.test.js
  // `compose`, test/inject-bound-v1-green-1270.test.js `compose`, both descended from
  // test/immediate-submit-1215.test.js). This registrar CANNOT be composed blind, because
  // CLEAR-INTERFACE-V1.md §8 requires it to THROW when it is handed no authenticator — a route that cannot
  // authenticate must not exist — so a one-argument generic call is a TypeError by contract, not by accident.
  //
  // Those two requirements are only compatible if the clear is NOT part of the generically enumerated surface.
  // It is therefore defined as a non-enumerable own property: `sessionActions.registerClearStrandV1Route(app,
  // { verifyHostToken })` works exactly as §8's daemon.js snippet writes it (property access is unaffected,
  // and so is destructuring), while `Object.entries`/`Object.keys`/`for…in`/spread do not see it — so a blind
  // composer registers every route it knows about and simply never asks for this one. The registration is
  // explicit and single (daemon.js), which is what §1 ("registered exactly once, with no second path") and §8
  // (the daemon snippet passes the seam) already describe. The throw itself is unchanged.
  Object.defineProperty(actions, 'registerClearStrandV1Route', {
    value: registerClearStrandV1Route, enumerable: false, writable: false, configurable: true,
  });
  return actions;
}

module.exports = { createSessionActions };
