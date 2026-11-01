// src/completion-observation.js — telepty#60 Stage A: the truth model, pure.
//
// Stage A separates four domains the daemon used to let bleed into each other:
//   transport (bytes were handed over) · activity (the PTY did something) ·
//   inject consumption (evidence the bytes started a turn) · TASK OUTCOME.
//
// The first three are measurable. Task outcome is NOT, and in 0.8.0 there is no measurement that
// can produce one: no terminal event, no validator, no producer. Everything here carries
// `completion_fact: null` and `terminal: false`, permanently, by construction.
//
// Pure and dependency-free so the decisions are unit-testable without booting the daemon.

'use strict';

const SCHEMA_VERSION = 2;

// §A4 — capability gaps are EXPLICIT, never implied by absence. No timer, silence threshold,
// prompt glyph, spinner, SID claim, loopback status, owner token, WebSocket connection or
// reconnect event may flip any of these to available.
const CAPABILITY_STAGE_A = Object.freeze({
  turn_boundary: 'unavailable',
  observation_tracking: 'persistent',
  session_authentication: 'unavailable',
  session_authentication_reason: 'no_815_epoch_fact',
  capability_delivery: 'unavailable',
  capability_delivery_reason: '816_not_implemented',
  remote_sender_identity: 'unavailable',
  remote_sender_identity_reason: '817_not_implemented',
  outcome_protocol: 'unavailable',
  outcome_protocol_reason: 'stage_b_deferred_to_0.9.0',
  outcome_authority: 'orchestrator',
});

// The ONLY submit-confirmation reasons that are screen-derived consumption evidence.
//
// This whitelist is load-bearing and it is narrower than `accepted === true`. Four production
// confirm sites normalize to `{accepted:true, ambiguous:false}` for reasons that measured no
// screen at all — `force` (daemon.js:3661), `gate_off` (:3747), `redelivered` (:1363) and
// `empty_body` (:1432/:3956). The force path is self-indicting: its own comment says it "skips
// the synchronous consumption classify, so a busy-parked body would silently drop". Admitting
// those would let a bare force-confirm assert that a turn started.
//
// `body_consumed` = the body was visible in the composer and then vanished (the CR consumed the
// input line). `state_working` / `state_thinking` = a post-submit busy transition was observed.
// Both are produced by confirmSubmitAccepted in src/submit-gate.js (`state_${state}` at :222,
// `body_consumed` at :259) and nothing else produces them.
const SCREEN_DERIVED_CONFIRM_REASONS = Object.freeze(['body_consumed', 'state_working', 'state_thinking']);

function isScreenDerivedConfirm(confirm) {
  if (!confirm || confirm.accepted !== true || confirm.ambiguous === true) return false;
  return SCREEN_DERIVED_CONFIRM_REASONS.includes(String(confirm.reason));
}

/**
 * Is a recorded busy edge a qualified fresh-turn candidate for THIS inject?
 *
 * Edge-gating only — it deliberately says nothing about the submit confirmation, because at the
 * moment the edge fires the confirmation usually does not exist yet (see classifyConsumption).
 *
 * @param {object} candidate — {from, to, sinceMs}
 * @param {string|null} submitStartedAt
 */
function isFreshBusyEdge(candidate, submitStartedAt) {
  if (!candidate) return false;
  // Must ENTER a turn from a non-busy state. A `starting`→working startup flip (#537 pollution)
  // and a working↔thinking mid-turn sub-state flip (an already-running turn that is not ours)
  // are both excluded.
  if (candidate.to !== 'working' && candidate.to !== 'thinking') return false;
  if (candidate.from !== 'idle' && candidate.from !== 'waiting') return false;
  if (!submitStartedAt) return false;
  const submitStartedMs = new Date(submitStartedAt).getTime();
  if (!Number.isFinite(submitStartedMs)) return false;
  // A turn that predates our CR is the #617 busy-park case, never our consumption.
  if (!Number.isFinite(candidate.sinceMs) || candidate.sinceMs < submitStartedMs) return false;
  return true;
}

/**
 * Classify inject-consumption evidence. PURE. Returns `{status, basis, ...provenance}`.
 *
 * `status` is only ever 'observed' or 'not_established'. It is a FIELD of an observation, never
 * a gate in front of one — the version this replaces was a bare `return` that emitted nothing,
 * and it was harmless only while a true `confirmed` bypassed it.
 *
 * ORDER IS THE CONTRACT:
 *
 *  1. A positive submit REJECTION wins outright, and is evaluated BEFORE any durable field, so a
 *     stale `injectConsumedAt` left by an earlier turn cannot override it (§3.10, B1).
 *  2. A qualified fresh busy edge + an accepted, non-ambiguous, SCREEN-DERIVED confirmation is
 *     the only thing that yields 'observed'.
 *
 *     Why the predicate is evaluated HERE and not at the edge: the design states these conjuncts
 *     at the transition site, but `submitConfirm` does not exist at that instant — the strongest
 *     accept reason, `state_working`, is PRODUCED BY the very transition being judged
 *     (src/submit-gate.js:218-227 polls the state machine). Evaluating there would make
 *     'observed' unreachable in production while every test that seeds the field stayed green.
 *     So the transition records only a candidate edge, and the full predicate is applied at
 *     classification time, when the confirmation is actually known. Same conjuncts, correct
 *     evaluation point.
 *  3. The launcher watermark (#721) keeps its whole calculation but is NOT consumption: it is
 *     `submit_accepted_and_output_advanced` telemetry with status 'not_established'. A
 *     never-started wrapped worker can satisfy it (daemon.js:483-503 says so outright).
 *  4. Composer body-removal / output echo keep their literal names and are also not consumption
 *     unless the full accepted fresh-edge predicate independently holds.
 */
function classifyConsumption(pendingReport, options = {}) {
  const pr = pendingReport || {};
  const confirm = pr.submitConfirm;

  // (1) Rejection precedence — before ANY durable field is read.
  if (confirm && confirm.accepted === false) {
    return {
      status: 'not_established',
      basis: 'submit_rejection_observed',
      submit_confirm_reason: confirm.reason || null,
      submit_confirmed_at: pr.submitUnconfirmedAt || null,
    };
  }

  // (2) The one positive admission.
  const candidate = pr.injectConsumptionCandidate || null;
  if (isFreshBusyEdge(candidate, pr.submitStartedAt) && isScreenDerivedConfirm(confirm)) {
    return {
      status: 'observed',
      basis: 'fresh_busy_transition',
      // Provenance, recorded explicitly so a future reader can see WHY this was judged observed
      // and at which point — not just that it was.
      submit_confirm_reason: String(confirm.reason),
      submit_confirmed_at: pr.submitConfirmedAt || null,
      transition_from: candidate.from,
      transition_to: candidate.to,
      transition_at: candidate.at || null,
      evaluated_at: 'consumption_classification',
    };
  }

  // (3) Launcher watermark — real telemetry, explicitly not consumption.
  if (pr.launcherWatermarkAt) {
    return {
      status: 'not_established',
      basis: 'submit_accepted_and_output_advanced',
      submit_confirm_reason: confirm && confirm.reason ? String(confirm.reason) : null,
      ring_bytes_delta: Number.isFinite(pr.launcherRingBytesDelta) ? pr.launcherRingBytesDelta : null,
      elapsed_ms: Number.isFinite(pr.launcherElapsedMs) ? pr.launcherElapsedMs : null,
    };
  }

  // (4) Literal screen observations that fall short of the predicate.
  if (isScreenDerivedConfirm(confirm)) {
    const literal = confirm.reason === 'body_consumed'
      ? 'submit_body_removed_observed'
      : 'busy_state_after_submit_observed';
    return {
      status: 'not_established',
      basis: literal,
      submit_confirm_reason: String(confirm.reason),
      submit_confirmed_at: pr.submitConfirmedAt || null,
      // Named so the gap is legible: the confirmation qualified, the fresh edge did not.
      shortfall: 'no_qualifying_fresh_busy_edge',
    };
  }
  if (options.echoObserved === true) {
    return { status: 'not_established', basis: 'inject_echo_observed', echo_reason: options.echoReason || null };
  }

  return {
    status: 'not_established',
    basis: 'no_consumption_evidence',
    submit_confirm_reason: confirm && confirm.reason ? String(confirm.reason) : null,
  };
}

/**
 * Build the §2.2 `task_completion_unknown` envelope. This is the ONLY task-adjacent statement
 * telepty emits in 0.8.0.
 */
function buildCompletionUnknown({ sessionId, injectId, observation, consumption, capability, observationSeq } = {}) {
  return {
    type: 'task_completion_unknown',
    schema_version: SCHEMA_VERSION,
    session_id: sessionId || null,
    inject_id: injectId || null,
    completion_fact: null,
    terminal: false,
    observation: observation || { kind: 'unmapped_transition_cause', trigger: null },
    consumption: consumption || { status: 'not_established', basis: 'no_consumption_evidence' },
    capability: capability || CAPABILITY_STAGE_A,
    ...(Number.isFinite(observationSeq) ? { observation_seq: observationSeq } : {}),
  };
}

// gh#82(F) — the observation kinds whose evidence is a DAEMON-MEASURED process or transport fact
// rather than a reading of the screen. Every other row in session-state.js OBSERVATION_CAUSES is
// derived from PTY bytes: silence, a prompt glyph, a busy/error pattern, a ready frame.
//
// That distinction is the whole gate. Against a Claude Code TUI the screen-derived rows mis-read
// routinely — `pty_quiet ≈ 5s` is a model thinking, and the reporter confirmed with `read-screen`
// that a `repeated_error_pattern_observed` alarm was firing on spinner frames (`Twisting… ✻ ✽ ✶`).
// In one working day roughly a dozen injects to five workers produced a TASK_COMPLETION_UNKNOWN
// for essentially every one, and every one was contradicted by the worker's own REPORT. A
// notification that is wrong every time is worse than none: an orchestrator that acts on it
// interrupts healthy work, and one that learns to ignore it also ignores the true positives.
//
// The four kept here are not screen scrapes and are the absences an orchestrator must not miss:
// the wrapped CLI was OBSERVED exiting; a kill threw, so a process may be alive with nothing
// tracking it; or the owner lane was replaced/detached under it (#815).
//
// `session_termination_requested` is deliberately NOT here even though it is daemon-measured: the
// source asked for the DELETE, so it only tells the requester what the requester just did, about
// a session that is already gone.
const PROCESS_FACT_OBSERVATION_KINDS = Object.freeze([
  'session_process_exited',
  'session_termination_kill_failed',
  'owner_replaced_observed',
  'owner_transport_detached',
]);

/**
 * May this absence be PUSHED to the source session? PURE.
 *
 * Gates the notification ONLY. The bus event and the ledger append are unconditional at the call
 * site — the observation stays recorded and queryable either way, which is what keeps this a
 * change to who gets interrupted rather than a return to silence (§A2).
 *
 * While `outcome_protocol: 'unavailable'` (Stage B deferred to 0.9.0) the screen heuristics carry
 * the whole judgement, which is the condition this gate exists for. When Stage B lands and the
 * protocol reports anything else, every kind pushes again with no code change here.
 * `TELEPTY_COMPLETION_UNKNOWN_PUSH=1` restores 0.8.1 behaviour for an operator who wants it.
 */
function shouldPushCompletionUnknown(envelope, env = process.env) {
  if (env && env.TELEPTY_COMPLETION_UNKNOWN_PUSH === '1') return true;
  const capability = (envelope && envelope.capability) || {};
  if (capability.outcome_protocol !== 'unavailable') return true;
  const kind = envelope && envelope.observation ? envelope.observation.kind : null;
  return PROCESS_FACT_OBSERVATION_KINDS.includes(kind);
}

/**
 * The source-facing text. Literal by design: it states the measurement and the absence, and it
 * contains no word that could be read as "the task is done".
 */
function formatCompletionUnknownText(envelope) {
  const e = envelope || {};
  const obs = e.observation || {};
  const parts = [];
  // #843 — `<kind>=<n>s` is a claim that the kind measured n seconds, so only the kind's OWN
  // measurement may fill it. This tested `elapsed_ms` first and fell back to `silence_ms`, which
  // are different things: `silence_ms` is how long the PTY has been quiet — what `pty_quiet` is
  // named after, and the only evidence its row requires — while `elapsed_ms` is time since the
  // inject, a qualifier attached to every row. A 3-second silence 900 seconds into a dispatch came
  // out as `pty_quiet=900.0s`, overstating the measurement by two orders of magnitude, and rows
  // that measure no duration at all (`output_observed`) wore elapsed as if it were theirs. This is
  // the one line the orchestrator reads, in the release that renamed everything to be honest about
  // exactly this. Elapsed is a real measurement and is still stated — under its own name.
  if (Number.isFinite(obs.silence_ms)) {
    parts.push(`${obs.kind}=${(obs.silence_ms / 1000).toFixed(1)}s`);
  } else {
    parts.push(String(obs.kind));
  }
  if (Number.isFinite(obs.elapsed_ms)) {
    parts.push(`elapsed_since_inject=${(obs.elapsed_ms / 1000).toFixed(1)}s`);
  }
  const consumption = (e.consumption && e.consumption.status) || 'not_established';
  parts.push(`consumption=${consumption}`);
  const injTag = e.inject_id ? ` inject=${e.inject_id}` : '';
  return `TASK_COMPLETION_UNKNOWN: ${e.session_id}${injTag} — no completion fact observed; `
    + `${parts.join('; ')}; outcome protocol unavailable`;
}

module.exports = {
  SCHEMA_VERSION,
  CAPABILITY_STAGE_A,
  SCREEN_DERIVED_CONFIRM_REASONS,
  isScreenDerivedConfirm,
  isFreshBusyEdge,
  classifyConsumption,
  buildCompletionUnknown,
  formatCompletionUnknownText,
  // gh#82(F)
  PROCESS_FACT_OBSERVATION_KINDS,
  shouldPushCompletionUnknown,
};
