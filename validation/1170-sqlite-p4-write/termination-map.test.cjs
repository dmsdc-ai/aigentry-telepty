"use strict";

// Task #1170 - OS termination REPRESENTATION apparatus (parent / oracle).
// Operation tp1170ce-v1. PROCESS-ONLY, bounded, zero dependency, Node builtins
// only.
//
// WHAT THIS MEASURES
// For each of three synthetic point labels, this records the RAW (exitCode,
// signal, error) triple the local OS reports for two different AUTHORSHIPS of
// one SIGKILL: the child killing itself, and the parent killing the exact
// ChildProcess handle it forked. Both are recorded side by side. Nothing here
// decides which authorship produced an observed pair.
//
// WHAT THIS IS NOT
//  - Not SQLite, not storage, not adoption, not durability. The labels
//    after_cas_read / after_row_insert / before_commit are PROCESS-ONLY
//    SYNTHETIC MARKERS passed to the child as strings. No slice is required, no
//    store is opened, no file is written except this apparatus' own evidence.
//  - Not a Windows result. Windows mappings CANNOT be inferred from darwin or
//    linux. `windowsMeasured` is derived from the actual platform.
//  - Not a W7 acceptance predicate and not a licence for one. A generic exit 1
//    is NEVER classified as a W7 pass. No record carries a committed, reason or
//    retrySafe field: a terminated process returns no JS object, so there is
//    nothing to synthesize (R2-2).
//  - Not a claim that the parent's local event sequence is OS chronology. The
//    sequence counter below is one parent-local counter; `<` between two seq
//    numbers means "this parent observed A before B", nothing more.
//  - Not a claim that an announce proves no JS ran afterwards, nor that the
//    bounded hold was entered or observed. See NOT_ESTABLISHED.
//
// PARENT OPERATION POLICY (fixed before spawn, recorded with every trial)
// Each trial declares ONE parent operation policy before the child exists:
//
//   observe_only          this parent issues ZERO experimental signals for this
//                         trial, whatever it observes. Used for the self-kill
//                         arms, so that any SIGKILL recorded there cannot have
//                         been authored by this parent.
//   kill_on_valid_marker  this parent will issue exactly one SIGKILL to the
//                         exact handle it forked, if and only if the gate below
//                         passes. Used for the parent-kill arms.
//
// The policy is a PARENT-SIDE operating decision, not an observation of the
// child and not a prediction of its behaviour. It is what makes the self/parent
// mapping causally separable: the two arms differ in how many signals this
// parent sent (zero vs one), so the raw triples being compared are not both
// produced under a parent kill. Apparatus timeout cleanup is a SEPARATE
// mechanism, counted separately, and is available under both policies.
//
// THE GATE, and what it requires before an experimental kill
// The gate is evaluated EXACTLY ONCE per trial, at the moment the first
// announce-shaped line is consumed, and the full set of inputs it saw is
// snapshotted into `gateDecision` so the decision stays auditable even though
// the observation record keeps changing afterwards. It requires ALL of:
//   - the declared policy is kill_on_valid_marker
//   - the line is the exact typed form
//   - the point matches the one assigned to this trial
//   - the nonce matches the one assigned to this trial
//   - the pid in the line is the pid of the handle this parent forked
//   - no result had been observed yet
//   - no hold release had been observed yet
//   - no exit had been observed yet
// The last four are disqualifying PRIOR OBSERVATIONS: a process that already
// returned a value, already resumed executing JS, or was already seen to be
// gone is not signalled at all.
//
// SEPARATION OF POLICY AND OBSERVATION FROM OUTCOME CLASSIFICATION
// `shouldSignal(obs)` and `classify(obs)` receive the live observation record
// only. That record contains the declared parent policy and the observations;
// it contains NO assigned child mode, no expectation and no case id. Outcome
// classification therefore cannot inspect what the child was told to do in
// order to infer whether the trial succeeded. The assigned scenario is joined
// to the outputs afterwards, in the assertion phase. The proof that this holds
// is a control that runs ONE child mode under BOTH policies and gets two
// different, individually correct classifications.
//
// BOUNDS AND CUSTODY
// Per child 3000 ms, whole apparatus 60000 ms. Every child created is observed
// joined ('close', i.e. exit plus stdio end). The only process ever signalled by
// this file is an exact ChildProcess handle it forked. No pid scan, no process
// group, no ps/pgrep, no global kill. A per-child bound expiry is recorded as
// `apparatus_timeout` and is NEVER reported as an experimental termination. No
// trial is ever re-run to change its own outcome; unknown and error observations
// stay recorded as observed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHILD = path.join(__dirname, "termination-map-child.cjs");

const PER_CHILD_MS = 3000;
const WHOLE_RUN_MS = 60000;
const PRIMARY_TRIALS = 3;
const CONTROL_TRIALS = 2;
const HOLD_MS = 2000;
// Short holds for the arms that are NOT signalled, so they finish on their own
// well inside the per-child bound instead of sitting out a full HOLD_MS.
const SHORT_HOLD_MS = 400;
const LINGER_MS = 200;

const POLICY_OBSERVE_ONLY = "observe_only";
const POLICY_KILL_ON_VALID_MARKER = "kill_on_valid_marker";

const LABELS = ["after_cas_read", "after_row_insert", "before_commit"];

// The exact typed announce form. Anything else is not an identity.
const MARKER_RE = /^TM_MARKER v1 point=([a-z_]+) nonce=([0-9a-f]{32}) pid=(\d+)$/;

// The exact typed orderly-exit sentinel form, written by the child's 'exit'
// listener. Recorded as a COUNT plus an EXACTNESS check, kept in its own table.
// It is deliberately NOT a gate input and NOT part of the raw OS pair.
const EXIT_HOOK_RE = /^TM_EXIT_HOOK v1 point=([a-z_]+) nonce=([0-9a-f]{32}) pid=(\d+)$/;

const NOT_ESTABLISHED = [
  "marker_does_not_prove_no_js_ran_after_the_announce",
  "marker_does_not_prove_the_bounded_hold_was_entered_or_observed",
  "parent_local_event_sequence_is_not_os_chronology",
  "kill_api_return_true_is_api_acceptance_not_delivery",
  "same_raw_pair_does_not_establish_same_kill_authorship",
  "a_zero_signal_policy_bounds_this_parent_only_not_the_os",
  "no_sqlite_no_storage_no_filesystem_durability_claim",
  "point_labels_are_synthetic_process_markers_not_sqlite_boundaries",
  "windows_mappings_cannot_be_inferred_from_a_non_win32_run",
  "no_w7_acceptance_predicate_is_evaluated_or_licensed_here",
  "exit_hook_sentinel_absence_does_not_prove_no_orderly_code_ran",
  "exit_hook_sentinel_absence_is_failure_or_unknown_not_proof_of_abrupt_termination",
  "exit_hook_observations_are_not_mixed_into_the_raw_os_pair_comparison",
  "an_ordinary_exit1_at_a_marker_is_not_a_termination_and_is_not_a_w7_pass",
];

// ---------------------------------------------------------------------------
// Fail-closed interface, mirroring the P4 prototype convention: the caller
// supplies already-existing owned roots. Nothing is defaulted into a host
// location and nothing is silently degraded.
// ---------------------------------------------------------------------------

function requireExistingDir(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set to an existing owned directory`);
  assert.ok(
    fs.existsSync(value) && fs.statSync(value).isDirectory(),
    `${name} is not an existing directory: ${value}`,
  );
  return value;
}

const EVIDENCE_DIR = requireExistingDir("TM_EVIDENCE_DIR");
const SANDBOX_DIR = requireExistingDir("TM_SANDBOX_DIR");

const FAKE_HOME = path.join(SANDBOX_DIR, "home");
const FAKE_TMP = path.join(SANDBOX_DIR, "tmp");
fs.mkdirSync(FAKE_HOME, { recursive: true });
fs.mkdirSync(FAKE_TMP, { recursive: true });

// Sanitized child environment, built from scratch. No host credential, no
// registry/proxy setting, no provider or inference variable of any kind can be
// reached from a child: only what a Node process needs to start, the fake HOME
// and TMP, and the four TM_ inputs.
function childEnv(vars) {
  const base = {
    PATH: process.env.PATH || "",
    HOME: FAKE_HOME,
    USERPROFILE: FAKE_HOME,
    TMPDIR: FAKE_TMP,
    TMP: FAKE_TMP,
    TEMP: FAKE_TMP,
  };
  // Required for a process to start at all on win32; absent elsewhere.
  for (const k of ["SystemRoot", "windir", "ComSpec", "PATHEXT"]) {
    if (process.env[k]) base[k] = process.env[k];
  }
  return Object.assign(base, vars);
}

// ---------------------------------------------------------------------------
// One parent-local monotonic sequence counter. Ordering between seq numbers is
// this parent's observation order and is NOT asserted to be OS chronology.
// ---------------------------------------------------------------------------

const seqCounter = { n: 0 };
const startedAt = Date.now();

function nextSeq() {
  return ++seqCounter.n;
}

const custody = {
  created: 0,
  joined: 0,
  experimentalSignalsIssued: 0,
  apparatusTimeoutSignalsIssued: 0,
  // Every signal this apparatus issues appends its target KIND here. The only
  // legal value is the owned handle; a pid, a process group or anything else
  // would show up as a different string and fail the audit assertion.
  signalTargets: [],
};

/**
 * Fork one owned child, observe it to completion, return the raw observation.
 * The returned record carries observations only - no mode, no expectation.
 */
function runTrial({ mode, point, holdMs, lingerMs, parentPolicy }) {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(16).toString("hex");
    const obs = {
      // The parent's own declared operating policy for this trial, fixed here,
      // before the child exists. Not an observation of the child.
      parentPolicy,
      assignedPoint: point,
      assignedNonce: nonce,
      childPid: null,
      stdoutRaw: "",
      stderrRaw: "",
      markerCandidate: null,
      markerValidForm: false,
      markerPointMatches: false,
      markerNonceMatches: false,
      markerPidMatchesHandle: null,
      markerObservedSeq: null,
      resultObserved: false,
      resultChannel: null,
      resultObservedSeq: null,
      holdReleasedObserved: false,
      holdReleasedSeq: null,
      holdMechanismReported: null,
      // Orderly-exit sentinel accounting. Counted and checked for exactness,
      // recorded separately from the raw OS exit pair below and never fed to
      // the gate or to classification.
      exitHookLinesObserved: 0,
      exitHookExactMatches: 0,
      exitHookFirstLine: null,
      exitHookFirstObservedSeq: null,
      markerObservedAfterExit: null,
      gateDecision: null,
      killRequested: false,
      killRequestSeq: null,
      killSignalRequested: null,
      killApiReturn: null,
      killApiError: null,
      apparatusTimeoutKill: false,
      timedOut: false,
      timeoutSeq: null,
      exitRecorded: false,
      rawExitCode: null,
      rawSignal: null,
      exitSeq: null,
      errorRecorded: false,
      rawErrorMessage: null,
      errorSeq: null,
      joined: false,
      exitObservedBeforeKillRequest: null,
      killAuthorshipClaim: null,
      pairSource: "raw_observation",
      events: [],
      elapsedMs: null,
    };

    const t0 = Date.now();
    const push = (name, extra) => {
      obs.events.push(Object.assign({ seq: nextSeq(), name, atMs: Date.now() - t0 }, extra || null));
    };

    const child = fork(CHILD, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: childEnv({
        TM_MODE: mode,
        TM_NONCE: nonce,
        TM_POINT: point,
        TM_HOLD_MS: String(holdMs),
        TM_LINGER_MS: String(lingerMs || 0),
      }),
    });
    custody.created += 1;
    obs.childPid = child.pid;
    push("child_forked", { pid: child.pid });

    // --- the gate. Sees the declared parent policy and the observation record
    // --- only. It cannot read the assigned child mode, because the record does
    // --- not contain it. Returns the full snapshot of what it decided on, so
    // --- the decision remains auditable after the record moves on.
    const evaluateGate = (rec) => {
      const inputs = {
        policy: rec.parentPolicy,
        policyPermitsSignal: rec.parentPolicy === POLICY_KILL_ON_VALID_MARKER,
        markerValidForm: rec.markerValidForm,
        markerPointMatches: rec.markerPointMatches,
        markerNonceMatches: rec.markerNonceMatches,
        markerPidMatchesHandle: rec.markerPidMatchesHandle,
        priorResultObserved: rec.resultObserved,
        priorHoldReleaseObserved: rec.holdReleasedObserved,
        priorExitObserved: rec.exitRecorded,
      };
      const identityExact =
        inputs.markerValidForm === true &&
        inputs.markerPointMatches === true &&
        inputs.markerNonceMatches === true &&
        inputs.markerPidMatchesHandle === true;
      const disqualified =
        inputs.priorResultObserved || inputs.priorHoldReleaseObserved || inputs.priorExitObserved;
      return Object.assign(inputs, {
        identityExact,
        disqualifiedByPriorObservation: Boolean(disqualified),
        result: inputs.policyPermitsSignal && identityExact && !disqualified,
      });
    };

    const requestExperimentalKill = () => {
      if (obs.killRequested) return;
      obs.killRequested = true;
      custody.experimentalSignalsIssued += 1;
      custody.signalTargets.push("owned_child_process_handle");
      obs.killSignalRequested = "SIGKILL";
      obs.killRequestSeq = nextSeq();
      obs.events.push({ seq: obs.killRequestSeq, name: "kill_requested", atMs: Date.now() - t0 });
      try {
        // The ONLY process this parent ever signals: the exact handle it forked.
        obs.killApiReturn = child.kill("SIGKILL");
      } catch (err) {
        obs.killApiError = String((err && err.message) || err);
      }
      push("kill_api_returned", { apiReturn: obs.killApiReturn, apiError: obs.killApiError });
    };

    let stdoutBuf = "";
    const consumeLine = (line) => {
      if (line.startsWith("TM_MARKER") && obs.markerCandidate === null) {
        obs.markerCandidate = line;
        const m = MARKER_RE.exec(line);
        if (m) {
          obs.markerValidForm = true;
          obs.markerPointMatches = m[1] === point;
          obs.markerNonceMatches = m[2] === nonce;
          obs.markerPidMatchesHandle = Number(m[3]) === child.pid;
        }
        obs.markerObservedSeq = nextSeq();
        obs.markerObservedAfterExit = obs.exitRecorded;
        obs.events.push({
          seq: obs.markerObservedSeq,
          name: "marker_observed",
          atMs: Date.now() - t0,
          validForm: obs.markerValidForm,
        });
        // The one and only gate evaluation for this trial.
        obs.gateDecision = Object.assign({ evaluatedAtSeq: obs.markerObservedSeq }, evaluateGate(obs));
        if (obs.gateDecision.result) requestExperimentalKill();
        return;
      }
      if (line.startsWith("TM_RESULT") && !obs.resultObserved) {
        obs.resultObserved = true;
        obs.resultChannel = "stdout";
        obs.resultObservedSeq = nextSeq();
        obs.events.push({ seq: obs.resultObservedSeq, name: "result_observed", atMs: Date.now() - t0 });
        return;
      }
      if (line.startsWith("TM_EXIT_HOOK")) {
        // Recorded only. The sentinel is NOT a gate input: the gate's decision
        // inputs are unchanged by this branch, and a sentinel cannot cause or
        // suppress a signal. It is also not merged into the raw pair.
        obs.exitHookLinesObserved += 1;
        const h = EXIT_HOOK_RE.exec(line);
        if (h && h[1] === point && h[2] === nonce && Number(h[3]) === child.pid) {
          obs.exitHookExactMatches += 1;
        }
        if (obs.exitHookFirstLine === null) {
          obs.exitHookFirstLine = line;
          obs.exitHookFirstObservedSeq = nextSeq();
          obs.events.push({
            seq: obs.exitHookFirstObservedSeq,
            name: "exit_hook_sentinel_observed",
            atMs: Date.now() - t0,
          });
        }
        return;
      }
      if (line.startsWith("TM_HOLD_RELEASED") && !obs.holdReleasedObserved) {
        obs.holdReleasedObserved = true;
        obs.holdReleasedSeq = nextSeq();
        const mech = /mechanism=(\w+)/.exec(line);
        obs.holdMechanismReported = mech ? mech[1] : null;
        obs.events.push({
          seq: obs.holdReleasedSeq,
          name: "hold_released_observed",
          atMs: Date.now() - t0,
        });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      obs.stdoutRaw += chunk;
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.length) consumeLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      obs.stderrRaw += chunk;
    });

    child.on("message", (message) => {
      if (message && message.type === "result" && !obs.resultObserved) {
        obs.resultObserved = true;
        obs.resultChannel = "ipc";
        obs.resultObservedSeq = nextSeq();
        obs.events.push({ seq: obs.resultObservedSeq, name: "result_observed", atMs: Date.now() - t0 });
      }
    });

    // Per-child bound. Expiry is APPARATUS CLEANUP, recorded as a timeout, and
    // never reported as an experimental termination.
    const timer = setTimeout(() => {
      obs.timedOut = true;
      obs.timeoutSeq = nextSeq();
      obs.events.push({ seq: obs.timeoutSeq, name: "apparatus_timeout", atMs: Date.now() - t0 });
      obs.apparatusTimeoutKill = true;
      custody.apparatusTimeoutSignalsIssued += 1;
      custody.signalTargets.push("owned_child_process_handle");
      try {
        child.kill("SIGKILL");
      } catch (err) {
        push("apparatus_timeout_kill_error", { message: String((err && err.message) || err) });
      }
    }, PER_CHILD_MS);

    child.on("error", (err) => {
      obs.errorRecorded = true;
      obs.rawErrorMessage = String((err && err.message) || err);
      obs.errorSeq = nextSeq();
      obs.events.push({ seq: obs.errorSeq, name: "child_error", atMs: Date.now() - t0 });
    });

    child.on("exit", (code, signal) => {
      obs.exitRecorded = true;
      obs.rawExitCode = code;
      obs.rawSignal = signal;
      obs.exitSeq = nextSeq();
      obs.events.push({
        seq: obs.exitSeq,
        name: "child_exit",
        atMs: Date.now() - t0,
        rawExitCode: code,
        rawSignal: signal,
      });
    });

    // 'close' is the join point: process gone AND both stdio streams ended, so
    // an announce that was still in the pipe at exit is not lost.
    child.on("close", () => {
      clearTimeout(timer);
      // No second gate evaluation here, and no late signal. An announce that
      // only became readable after the exit was already observed is recorded
      // (markerObservedAfterExit) and classified, never signalled: a process
      // this parent has already seen exit is not a signalling target.
      obs.joined = true;
      custody.joined += 1;
      obs.elapsedMs = Date.now() - t0;
      if (obs.killRequestSeq !== null && obs.exitSeq !== null) {
        obs.exitObservedBeforeKillRequest = obs.exitSeq < obs.killRequestSeq;
      }
      push("child_joined", null);
      resolve(obs);
    });
  });
}

/**
 * Classify one observation. Receives the declared parent policy and the
 * observations only; it has no access to the assigned child mode or to the
 * expectation, so it cannot infer success from what the child was told to do.
 *
 * Neither terminal class is an acceptance:
 *
 *   TERMINATION_OBSERVED_NO_PARENT_SIGNAL
 *     an exact identity was announced, this parent issued ZERO experimental
 *     signals for this trial, and a raw end-state was recorded. Because this
 *     parent sent nothing, the recorded end-state was not authored by it. It
 *     still does not establish what DID author it, that no JS ran, or anything
 *     about storage.
 *
 *   TERMINATION_OBSERVED_AFTER_PARENT_SIGNAL
 *     an exact identity was announced, this parent asked the OS to kill that
 *     exact handle, and a raw end-state was recorded afterwards. It does not
 *     establish that the signal is what ended the process.
 */
function classify(rec) {
  if (rec.timedOut) return "E_APPARATUS_TIMEOUT";
  if (rec.markerCandidate === null) return "E_NO_MARKER";
  if (!rec.markerValidForm) return "E_MARKER_MALFORMED";
  if (!rec.markerPointMatches || !rec.markerNonceMatches) return "E_IDENTITY_MISMATCH";
  if (rec.markerPidMatchesHandle !== true) return "E_PID_MISMATCH";
  if (rec.resultObserved) return "E_RESULT_BEFORE_KILL";
  if (rec.holdReleasedObserved) return "E_HOLD_RELEASED";
  if (!rec.exitRecorded) return "E_UNKNOWN_INCOMPLETE";
  if (rec.parentPolicy === POLICY_OBSERVE_ONLY) {
    // Fail closed: a signal under a zero-signal policy is an apparatus defect,
    // never a result.
    return rec.killRequested
      ? "E_POLICY_VIOLATION_SIGNAL_UNDER_OBSERVE_ONLY"
      : "TERMINATION_OBSERVED_NO_PARENT_SIGNAL";
  }
  if (rec.parentPolicy === POLICY_KILL_ON_VALID_MARKER) {
    if (rec.killRequested) return "TERMINATION_OBSERVED_AFTER_PARENT_SIGNAL";
    if (rec.markerObservedAfterExit) return "E_EXIT_OBSERVED_BEFORE_IDENTITY";
    return "E_UNKNOWN_INCOMPLETE";
  }
  return "E_UNKNOWN_INCOMPLETE";
}

// ---------------------------------------------------------------------------
// Predeclared scenarios. `expectClass` / `expectSignalled` are GROUNDTRUTH and
// are joined to the classifier output only in the assertion phase below.
// ---------------------------------------------------------------------------

const CASES = [];
for (const point of LABELS) {
  // Self arms: ZERO experimental parent signals, by policy, fixed before spawn.
  CASES.push({
    id: `primary/self_sigkill/${point}`,
    family: "primary",
    mode: "self_sigkill",
    parentPolicy: POLICY_OBSERVE_ONLY,
    point,
    holdMs: 0,
    trials: PRIMARY_TRIALS,
    expectClass: "TERMINATION_OBSERVED_NO_PARENT_SIGNAL",
    expectSignalled: false,
  });
  // PAIRED LIVENESS arm for the self-kill arm, at the SAME synthetic marker and
  // under the SAME observe_only policy (ZERO experimental parent signals). The
  // only difference from the self-kill arm is the manner of leaving: an ordinary
  // process.exit(1) instead of a self-directed SIGKILL.
  //
  // This is the positive side of the sentinel pair. It is an ordinary exit, not
  // a termination observation, and its raw exit 1 is never a W7 pass.
  //
  // Its predeclared class is TERMINATION_OBSERVED_NO_PARENT_SIGNAL, the SAME
  // class the self-kill arm gets. That is not an oversight and it is not an
  // acceptance: `classify` sees the declared policy and the observations only,
  // never the assigned mode, and on those inputs alone an exact announce under a
  // zero-signal policy with a recorded end-state is indistinguishable between
  // the two arms. What DOES separate them is recorded elsewhere and left
  // uninterpreted: the raw OS pair (1, null) vs a signal pair, and the
  // orderly-exit sentinel table. The classifier is not taught the difference,
  // because teaching it would mean classifying from the assigned mode.
  CASES.push({
    id: `liveness/ordinary_exit1_at_marker/${point}`,
    family: "liveness",
    mode: "ordinary_exit1_at_marker",
    parentPolicy: POLICY_OBSERVE_ONLY,
    point,
    holdMs: 0,
    trials: PRIMARY_TRIALS,
    expectClass: "TERMINATION_OBSERVED_NO_PARENT_SIGNAL",
    expectSignalled: false,
  });
  // Parent arms: validate the announce, then signal the exact handle.
  CASES.push({
    id: `primary/parent_sigkill/${point}`,
    family: "primary",
    mode: "parent_sigkill",
    parentPolicy: POLICY_KILL_ON_VALID_MARKER,
    point,
    holdMs: HOLD_MS,
    trials: PRIMARY_TRIALS,
    expectClass: "TERMINATION_OBSERVED_AFTER_PARENT_SIGNAL",
    expectSignalled: true,
  });
}

// Controls. Every identity-gate control runs under kill_on_valid_marker, so
// that its NOT being signalled is attributable to the gate refusing, not to a
// policy that was never going to signal anything.
// [mode, parentPolicy, expectClass, expectSignalled, holdMs, lingerMs]
const CONTROLS = [
  ["nc_ordinary_exit0_result", POLICY_KILL_ON_VALID_MARKER, "E_NO_MARKER", false, 0, 0],
  ["nc_ordinary_exit1", POLICY_KILL_ON_VALID_MARKER, "E_NO_MARKER", false, 0, 0],
  ["nc_thrown_error_exit1", POLICY_KILL_ON_VALID_MARKER, "E_NO_MARKER", false, 0, 0],
  ["nc_missing_marker", POLICY_KILL_ON_VALID_MARKER, "E_NO_MARKER", false, 0, 0],
  ["nc_wrong_marker", POLICY_KILL_ON_VALID_MARKER, "E_MARKER_MALFORMED", false, 0, 0],
  ["nc_wrong_nonce", POLICY_KILL_ON_VALID_MARKER, "E_IDENTITY_MISMATCH", false, 0, 0],
  // Correct point and correct nonce, foreign pid. Inert: nothing but the owned
  // handle is ever a signalling target, so the foreign number is only a string.
  ["nc_wrong_pid", POLICY_KILL_ON_VALID_MARKER, "E_PID_MISMATCH", false, 0, 0],
  // A result observed BEFORE the gate ran disqualifies the arm outright: no
  // signal is issued at all.
  ["nc_result_before_kill", POLICY_KILL_ON_VALID_MARKER, "E_RESULT_BEFORE_KILL", false, SHORT_HOLD_MS, 0],
  // The release is already in flight when the gate runs on the announce, so this
  // arm IS signalled and is then rejected on the observed release.
  ["nc_boundedhold_release", POLICY_KILL_ON_VALID_MARKER, "E_HOLD_RELEASED", true, 0, LINGER_MS],
  // POLICY CONTROL. Same child mode as the parent-kill primary arm, run under
  // observe_only. It must be signalled zero times and classified differently
  // from the primary arm - which is the standing proof that classification is
  // driven by the declared policy plus observations, never by the child mode.
  ["parent_sigkill", POLICY_OBSERVE_ONLY, "E_HOLD_RELEASED", false, SHORT_HOLD_MS, 0],
];
for (const [mode, parentPolicy, expectClass, expectSignalled, holdMs, lingerMs] of CONTROLS) {
  CASES.push({
    id: `control/${mode}/${parentPolicy}`,
    family: "control",
    mode,
    parentPolicy,
    point: LABELS[0],
    holdMs,
    lingerMs,
    trials: CONTROL_TRIALS,
    expectClass,
    expectSignalled,
  });
}

// ---------------------------------------------------------------------------
// The per-label mapping row: the two authorships of one SIGKILL, side by side.
//
// The self arm runs under observe_only (ZERO experimental parent signals) and
// the parent arm under kill_on_valid_marker (one signal to the owned handle), so
// the two recorded triples arise under genuinely different parent operation. The
// mapping is no longer confounded by this parent having killed both arms.
//
// ONLY the OS-reported fields are compared. Parent-side operational facts
// (policy, whether a signal was issued, the API return, the class name) differ
// between the two arms BY CONSTRUCTION and would swamp the comparison if mixed
// in, so they are recorded per trial instead of compared.
// `recordedOsPairSetsEqual` and `distinguishingOsFieldNames` are OBSERVATIONS of
// this apparatus' own records on this OS. Neither is a claim about what the OS
// did, and `authorshipDistinguishableFromRawPairAlone` stays null: this
// apparatus knows the authorship only because it assigned it.
// ---------------------------------------------------------------------------

const OS_REPORTED_FIELDS = ["rawExitCode", "rawSignal", "rawError"];

function projectPair(row) {
  return {
    // OS-reported, compared between the arms.
    rawExitCode: row.observation.rawExitCode,
    rawSignal: row.observation.rawSignal,
    rawError: row.observation.rawErrorMessage,
    // Parent-side operational: recorded, deliberately NOT compared.
    parentPolicy: row.observation.parentPolicy,
    experimentalSignalRequested: row.observation.killRequested,
    killApiReturn: row.observation.killApiReturn,
    killApiError: row.observation.killApiError,
    exitObservedBeforeKillRequest: row.observation.exitObservedBeforeKillRequest,
    observedClass: row.observedClass,
  };
}

function distinctValues(pairs, field) {
  return [...new Set(pairs.map((p) => JSON.stringify(p[field])))];
}

function buildPairEntry(label) {
  const pick = (id) => runState.rows.filter((r) => r.scenarioId === id).map(projectPair);
  const selfSigkill = pick(`primary/self_sigkill/${label}`);
  const parentSigkill = pick(`primary/parent_sigkill/${label}`);
  const distinguishing = OS_REPORTED_FIELDS.filter((field) => {
    const a = distinctValues(selfSigkill, field);
    const b = distinctValues(parentSigkill, field);
    return a.length !== b.length || a.some((v) => !b.includes(v));
  });
  return {
    label,
    selfSigkill,
    parentSigkill,
    selfArmPolicy: POLICY_OBSERVE_ONLY,
    parentArmPolicy: POLICY_KILL_ON_VALID_MARKER,
    selfArmExperimentalSignalsIssued: selfSigkill.filter((p) => p.experimentalSignalRequested).length,
    parentArmExperimentalSignalsIssued: parentSigkill.filter((p) => p.experimentalSignalRequested)
      .length,
    comparedOsFieldNames: OS_REPORTED_FIELDS,
    distinguishingOsFieldNames: distinguishing,
    recordedOsPairSetsEqual: distinguishing.length === 0,
    authorshipDistinguishableFromRawPairAlone: null,
  };
}

// ---------------------------------------------------------------------------
// The orderly-exit sentinel table. SEPARATE from the raw-pair table above, on
// purpose: that table is a comparison of OS-REPORTED fields only, and mixing a
// hook or policy fact into it would stop it being that. Nothing below is read by
// projectPair, by the gate, or by classify.
//
// Each row is one scenario's sentinel accounting: how many sentinel lines this
// parent read, and how many were the exact typed form bound to that trial's
// assigned point, assigned nonce and forked handle pid.
//
// The paired reading, and its limit. The ordinary-exit arm announces at a marker
// and leaves by process.exit(1); it MUST produce the exact sentinel, and that is
// what shows the detector is live in this bounded run. The self-kill arm
// producing none is recorded as an OBSERVED DIFFERENCE in this source-pinned
// apparatus and nothing more. It is not evidence that no orderly code ran, not
// evidence about signal delivery, not a claim about JS after the marker, not a
// causal-authorship claim, and not a storage, journal or power-loss claim.
// ---------------------------------------------------------------------------

function buildExitHookEntry(scenarioId) {
  const rows = runState.rows.filter((r) => r.scenarioId === scenarioId);
  return {
    scenarioId,
    trials: rows.length,
    parentPolicy: rows.length ? rows[0].observation.parentPolicy : null,
    sentinelLinesObserved: rows.reduce((n, r) => n + r.observation.exitHookLinesObserved, 0),
    sentinelExactMatches: rows.reduce((n, r) => n + r.observation.exitHookExactMatches, 0),
    trialsWithExactSentinel: rows.filter((r) => r.observation.exitHookExactMatches > 0).length,
    trialsWithNoSentinelLine: rows.filter((r) => r.observation.exitHookLinesObserved === 0).length,
    allJoined: rows.every((r) => r.observation.joined),
    anyTimedOut: rows.some((r) => r.observation.timedOut),
    anyResultObserved: rows.some((r) => r.observation.resultObserved),
    experimentalSignalsIssued: rows.filter((r) => r.observation.killRequested).length,
  };
}

function buildExitHookTable() {
  return {
    typedForm: "TM_EXIT_HOOK v1 point=<point> nonce=<32 hex> pid=<pid>",
    registeredBeforeScenarios: true,
    emittedSynchronouslyFromProcessExitHook: true,
    boundTo: ["assigned_point", "assigned_nonce", "forked_handle_pid"],
    mixedIntoRawPairComparison: false,
    usedAsGateInput: false,
    usedByClassification: false,
    absenceInterpretation: "failure_or_unknown_not_proof_of_abrupt_termination",
    pairedLiveness: LABELS.map((label) => ({
      label,
      orderlyExitArm: buildExitHookEntry(`liveness/ordinary_exit1_at_marker/${label}`),
      selfKillArm: buildExitHookEntry(`primary/self_sigkill/${label}`),
    })),
    allScenarios: CASES.map((c) => buildExitHookEntry(c.id)),
  };
}

// ---------------------------------------------------------------------------
// Execution. Strictly sequential, bounded, one pass. No trial is ever re-run.
// ---------------------------------------------------------------------------

const runState = { rows: [], aborted: null, elapsedMs: null };

test.before(async () => {
  for (const scenario of CASES) {
    for (let trial = 1; trial <= scenario.trials; trial += 1) {
      if (Date.now() - startedAt > WHOLE_RUN_MS) {
        runState.aborted = "whole_run_bound_exceeded";
        break;
      }
      const observation = await runTrial(scenario);
      // Classify FIRST, from the observation alone, then join groundtruth.
      const observedClass = classify(observation);
      runState.rows.push({ scenarioId: scenario.id, trial, observedClass, scenario, observation });
    }
    if (runState.aborted) break;
  }
  runState.elapsedMs = Date.now() - startedAt;

  const evidence = {
    apparatus: "termination-map",
    version: "1",
    task: 1170,
    operation: "tp1170ce-v1",
    scope: "process_only",
    labels: LABELS,
    labelSemantics: "synthetic_process_markers_not_sqlite_boundaries",
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      windowsMeasured: process.platform === "win32",
    },
    bounds: {
      perChildMs: PER_CHILD_MS,
      wholeRunMs: WHOLE_RUN_MS,
      elapsedMs: runState.elapsedMs,
      aborted: runState.aborted,
    },
    custody: {
      childrenCreated: custody.created,
      childrenJoined: custody.joined,
      everyChildJoined: custody.created === custody.joined,
      experimentalSignalsIssued: custody.experimentalSignalsIssued,
      apparatusTimeoutSignalsIssued: custody.apparatusTimeoutSignalsIssued,
      signalTargetKinds: [...new Set(custody.signalTargets)],
      pidScansPerformed: 0,
      processGroupsSignalled: 0,
      processesSignalledOtherThanOwnedHandles: 0,
    },
    parentOperationPolicies: {
      declared: [POLICY_OBSERVE_ONLY, POLICY_KILL_ON_VALID_MARKER],
      fixedBeforeSpawn: true,
      trialsByPolicy: runState.rows.reduce((acc, r) => {
        const k = r.observation.parentPolicy;
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      experimentalSignalsByPolicy: runState.rows.reduce((acc, r) => {
        const k = r.observation.parentPolicy;
        acc[k] = (acc[k] || 0) + (r.observation.killRequested ? 1 : 0);
        return acc;
      }, {}),
    },
    notEstablished: NOT_ESTABLISHED,
    pairTable: LABELS.map((label) => buildPairEntry(label)),
    // Separate table. Not merged into pairTable above by design.
    exitHookSentinel: buildExitHookTable(),
    classCounts: runState.rows.reduce((acc, r) => {
      acc[r.observedClass] = (acc[r.observedClass] || 0) + 1;
      return acc;
    }, {}),
    records: runState.rows.map((r) => ({
      scenarioId: r.scenarioId,
      trial: r.trial,
      assignedMode: r.scenario.mode,
      assignedPoint: r.scenario.point,
      parentPolicy: r.scenario.parentPolicy,
      expectClass: r.scenario.expectClass,
      expectSignalled: r.scenario.expectSignalled,
      observedClass: r.observedClass,
      observation: r.observation,
    })),
  };

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "termination-map.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  const jsonl = runState.rows
    .map((r) => JSON.stringify({ scenarioId: r.scenarioId, trial: r.trial, observedClass: r.observedClass, observation: r.observation }))
    .join("\n");
  fs.writeFileSync(path.join(EVIDENCE_DIR, "termination-map-rawlog.jsonl"), jsonl + "\n");
  runState.evidence = evidence;
});

// ---------------------------------------------------------------------------
// Assertions. Complete apparatus accounting and expected CONTROL behaviour
// only. No assertion anywhere depends on a platform-specific raw pair for a
// termination arm, because those pairs are what is being recorded.
// ---------------------------------------------------------------------------

test("apparatus: every created child was observed joined, with no orphan", () => {
  assert.equal(custody.created, custody.joined);
  assert.ok(custody.created > 0);
  for (const row of runState.rows) {
    assert.equal(row.observation.joined, true, `${row.scenarioId}#${row.trial} not joined`);
  }
});

test("apparatus: bounds were declared and not exceeded", () => {
  assert.equal(runState.aborted, null);
  assert.ok(runState.elapsedMs <= WHOLE_RUN_MS, `elapsed ${runState.elapsedMs}ms`);
  for (const row of runState.rows) {
    assert.ok(
      row.observation.elapsedMs <= PER_CHILD_MS + 500,
      `${row.scenarioId}#${row.trial} took ${row.observation.elapsedMs}ms`,
    );
  }
});

test("apparatus: each predeclared trial ran exactly once, none retried", () => {
  const expected = CASES.reduce((n, c) => n + c.trials, 0);
  assert.equal(runState.rows.length, expected);
  for (const c of CASES) {
    const got = runState.rows.filter((r) => r.scenarioId === c.id);
    assert.equal(got.length, c.trials, `${c.id} ran ${got.length} times`);
    assert.deepEqual(
      got.map((r) => r.trial),
      Array.from({ length: c.trials }, (_, i) => i + 1),
    );
  }
});

test("apparatus: a timeout is never recorded as an experimental termination", () => {
  for (const row of runState.rows) {
    if (row.observation.timedOut) {
      assert.equal(row.observedClass, "E_APPARATUS_TIMEOUT");
      assert.equal(row.observation.apparatusTimeoutKill, true);
    }
    if (row.observedClass.startsWith("TERMINATION_OBSERVED")) {
      assert.equal(row.observation.apparatusTimeoutKill, false);
      assert.equal(row.observation.timedOut, false);
    }
  }
  // Timeout cleanup is accounted for separately from experimental signalling.
  assert.equal(
    custody.apparatusTimeoutSignalsIssued,
    runState.rows.filter((r) => r.observation.apparatusTimeoutKill).length,
  );
});

test("gate: a signal was requested exactly when the recorded gate decision said so", () => {
  for (const row of runState.rows) {
    const o = row.observation;
    assert.equal(
      o.killRequested,
      Boolean(o.gateDecision && o.gateDecision.result),
      `${row.scenarioId}#${row.trial} killRequested=${o.killRequested}`,
    );
    if (o.markerCandidate === null) {
      assert.equal(o.gateDecision, null, "no announce means the gate never ran");
    } else {
      assert.ok(o.gateDecision, `${row.scenarioId}#${row.trial} has an announce but no gate decision`);
      assert.equal(o.gateDecision.evaluatedAtSeq, o.markerObservedSeq);
    }
  }
});

test("gate: every experimental signal required the exact identity and no prior disqualifier", () => {
  const signalled = runState.rows.filter((r) => r.observation.killRequested);
  assert.ok(signalled.length > 0);
  for (const row of signalled) {
    const g = row.observation.gateDecision;
    assert.equal(g.policy, POLICY_KILL_ON_VALID_MARKER);
    assert.equal(g.policyPermitsSignal, true);
    // Exact received identity: typed form, assigned point, assigned nonce, and
    // the pid of the handle this parent forked.
    assert.equal(g.markerValidForm, true);
    assert.equal(g.markerPointMatches, true);
    assert.equal(g.markerNonceMatches, true);
    assert.equal(g.markerPidMatchesHandle, true);
    assert.equal(g.identityExact, true);
    // No prior disqualifying observation at decision time.
    assert.equal(g.priorResultObserved, false);
    assert.equal(g.priorHoldReleaseObserved, false);
    assert.equal(g.priorExitObserved, false);
    assert.equal(g.disqualifiedByPriorObservation, false);
    assert.equal(row.observation.killSignalRequested, "SIGKILL");
    assert.equal(row.observation.markerPidMatchesHandle, true);
  }
});

test("gate: nothing was signalled without a passing decision, and only owned handles", () => {
  const notSignalled = runState.rows.filter((r) => !r.observation.killRequested);
  assert.ok(notSignalled.length > 0);
  for (const row of notSignalled) {
    assert.equal(row.observation.killApiReturn, null);
    assert.equal(row.observation.killApiError, null);
    assert.equal(row.observation.killRequestSeq, null);
  }
  // Every signal this apparatus issued, experimental or cleanup, targeted an
  // owned ChildProcess handle. No pid, no process group, nothing else.
  assert.deepEqual([...new Set(custody.signalTargets)], ["owned_child_process_handle"]);
  assert.equal(
    custody.signalTargets.length,
    custody.experimentalSignalsIssued + custody.apparatusTimeoutSignalsIssued,
  );
});

test("policy: observe-only trials issued zero experimental parent signals", () => {
  const observeOnly = runState.rows.filter((r) => r.observation.parentPolicy === POLICY_OBSERVE_ONLY);
  assert.ok(observeOnly.length > 0);
  for (const row of observeOnly) {
    assert.equal(row.observation.killRequested, false, `${row.scenarioId}#${row.trial} was signalled`);
    assert.equal(row.observation.killApiReturn, null);
    assert.notEqual(row.observedClass, "E_POLICY_VIOLATION_SIGNAL_UNDER_OBSERVE_ONLY");
  }
  // Specifically: the self-kill arms, whose whole purpose is an unconfounded
  // recording, contributed zero parent signals.
  const selfArms = runState.rows.filter((r) => r.scenario.mode === "self_sigkill");
  assert.equal(selfArms.length, LABELS.length * PRIMARY_TRIALS);
  assert.equal(selfArms.filter((r) => r.observation.killRequested).length, 0);
  assert.equal(
    custody.experimentalSignalsIssued,
    runState.rows.filter((r) => r.observation.parentPolicy === POLICY_KILL_ON_VALID_MARKER && r.observation.killRequested).length,
  );
});

test("policy: one child mode under both policies is classified differently and correctly", () => {
  // The standing proof that outcome classification is driven by the declared
  // policy plus observations, never by the assigned child mode: these two
  // scenarios hand the SAME mode to the child.
  const killPolicy = runState.rows.filter((r) => r.scenarioId === `primary/parent_sigkill/${LABELS[0]}`);
  const observePolicy = runState.rows.filter(
    (r) => r.scenarioId === `control/parent_sigkill/${POLICY_OBSERVE_ONLY}`,
  );
  assert.ok(killPolicy.length > 0 && observePolicy.length > 0);
  assert.equal(killPolicy[0].scenario.mode, observePolicy[0].scenario.mode);
  for (const row of killPolicy) {
    assert.equal(row.observedClass, "TERMINATION_OBSERVED_AFTER_PARENT_SIGNAL");
    assert.equal(row.observation.killRequested, true);
  }
  for (const row of observePolicy) {
    assert.equal(row.observedClass, "E_HOLD_RELEASED");
    assert.equal(row.observation.killRequested, false);
    assert.equal(row.observation.holdReleasedObserved, true);
  }
  assert.notEqual(killPolicy[0].observedClass, observePolicy[0].observedClass);
});

test("recording: kill API return is stored separately from the raw observed outcome", () => {
  for (const row of runState.rows) {
    const o = row.observation;
    for (const key of ["killApiReturn", "killApiError", "rawExitCode", "rawSignal", "rawErrorMessage"]) {
      assert.ok(key in o, `${row.scenarioId} missing ${key}`);
    }
    // API acceptance is never promoted to delivery, and never merged into the pair.
    assert.equal(o.pairSource, "raw_observation");
    assert.equal(o.killAuthorshipClaim, null);
    assert.ok(o.exitRecorded || o.errorRecorded, `${row.scenarioId}#${row.trial} has no end-state`);
  }
});

test("recording: local event order is recorded as parent-local, not as OS chronology", () => {
  for (const row of runState.rows) {
    const seqs = row.observation.events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(seqs.length >= 2);
  }
  assert.ok(runState.evidence.notEstablished.includes("parent_local_event_sequence_is_not_os_chronology"));
  assert.ok(runState.evidence.notEstablished.includes("marker_does_not_prove_no_js_ran_after_the_announce"));
  assert.ok(
    runState.evidence.notEstablished.includes(
      "marker_does_not_prove_the_bounded_hold_was_entered_or_observed",
    ),
  );
});

test("controls: each predeclared scenario produced its expected class", () => {
  const mismatches = runState.rows
    .filter((r) => r.observedClass !== r.scenario.expectClass)
    .map((r) => `${r.scenarioId}#${r.trial}: expected ${r.scenario.expectClass}, observed ${r.observedClass} (raw exitCode=${r.observation.rawExitCode} signal=${r.observation.rawSignal})`);
  assert.deepEqual(mismatches, []);
  for (const row of runState.rows) {
    assert.equal(row.observation.killRequested, row.scenario.expectSignalled, `${row.scenarioId}#${row.trial}`);
  }
});

test("controls: ordinary exit 0 with a result is recorded as an ordinary return", () => {
  const rows = runState.rows.filter((r) => r.scenario.mode === "nc_ordinary_exit0_result");
  assert.equal(rows.length, CONTROL_TRIALS);
  for (const row of rows) {
    assert.equal(row.observation.resultObserved, true);
    assert.equal(row.observation.rawExitCode, 0);
    assert.equal(row.observation.rawSignal, null);
    assert.equal(row.observation.killRequested, false);
    assert.ok(!row.observedClass.startsWith("TERMINATION_OBSERVED"));
  }
});

test("controls: raw exit-1 outcomes are preserved verbatim and never read as a termination", () => {
  // On win32 a self-directed SIGKILL may surface as exactly this pair. These
  // records are kept as observed and are NOT reinterpreted as a termination on
  // any platform.
  for (const mode of ["nc_ordinary_exit1", "nc_thrown_error_exit1"]) {
    const rows = runState.rows.filter((r) => r.scenario.mode === mode);
    assert.equal(rows.length, CONTROL_TRIALS);
    for (const row of rows) {
      assert.equal(row.observation.rawExitCode, 1);
      assert.equal(row.observation.rawSignal, null);
      assert.equal(row.observation.killRequested, false);
      assert.equal(row.observedClass, "E_NO_MARKER");
      assert.ok(!row.observedClass.startsWith("TERMINATION_OBSERVED"));
    }
  }
  const thrown = runState.rows.filter((r) => r.scenario.mode === "nc_thrown_error_exit1");
  for (const row of thrown) {
    assert.match(row.observation.stderrRaw, /TM_SYNTHETIC_THROW/);
  }
});

test("controls: a result observed before the gate ran makes the arm inert - no signal at all", () => {
  const rows = runState.rows.filter((r) => r.scenario.mode === "nc_result_before_kill");
  assert.equal(rows.length, CONTROL_TRIALS);
  for (const row of rows) {
    const o = row.observation;
    assert.equal(o.resultObserved, true);
    assert.ok(
      o.resultObservedSeq < o.markerObservedSeq,
      "this control requires the result to be observed before the announce",
    );
    // The gate saw the result as a prior observation and refused outright.
    assert.equal(o.gateDecision.priorResultObserved, true);
    assert.equal(o.gateDecision.disqualifiedByPriorObservation, true);
    assert.equal(o.gateDecision.result, false);
    assert.equal(o.killRequested, false);
    assert.equal(o.killRequestSeq, null);
    assert.equal(row.observedClass, "E_RESULT_BEFORE_KILL");
  }
});

test("controls: a foreign pid in an otherwise exact announce is refused, inertly", () => {
  const rows = runState.rows.filter((r) => r.scenario.mode === "nc_wrong_pid");
  assert.equal(rows.length, CONTROL_TRIALS);
  for (const row of rows) {
    const o = row.observation;
    // Point and nonce are the assigned ones: only the pid is foreign.
    assert.equal(o.markerValidForm, true);
    assert.equal(o.markerPointMatches, true);
    assert.equal(o.markerNonceMatches, true);
    assert.equal(o.markerPidMatchesHandle, false);
    assert.equal(o.gateDecision.identityExact, false);
    assert.equal(o.killRequested, false);
    assert.equal(row.observedClass, "E_PID_MISMATCH");
    // Inert: the foreign number was never a signalling target.
    assert.equal(o.killApiReturn, null);
  }
});

test("controls: a released bounded hold rejects the arm", () => {
  const rows = runState.rows.filter((r) => r.scenario.mode === "nc_boundedhold_release");
  assert.equal(rows.length, CONTROL_TRIALS);
  for (const row of rows) {
    assert.equal(row.observation.holdReleasedObserved, true);
    assert.equal(row.observedClass, "E_HOLD_RELEASED");
    assert.ok(row.observation.holdMechanismReported, "the hold mechanism must be recorded");
    // The release was not yet observed when the gate ran, so this arm WAS
    // signalled and is rejected on the observation, not on the gate.
    assert.equal(row.observation.gateDecision.priorHoldReleaseObserved, false);
    assert.equal(row.observation.killRequested, true);
  }
});

test("no W7 pass is emitted and no commit/reason/retrySafe is synthesized", () => {
  const forbidden = ["committed", "reason", "reasonCode", "retrySafe", "w7", "W7", "pass"];
  const serialized = JSON.stringify(runState.evidence.records);
  for (const key of ["committed", "reasonCode", "retrySafe"]) {
    assert.ok(!serialized.includes(`"${key}"`), `evidence must not carry a ${key} field`);
  }
  for (const row of runState.rows) {
    for (const key of forbidden) {
      assert.ok(!(key in row.observation), `observation must not carry ${key}`);
    }
    assert.ok(
      /^(TERMINATION_OBSERVED_NO_PARENT_SIGNAL|TERMINATION_OBSERVED_AFTER_PARENT_SIGNAL|E_[A-Z_]+)$/.test(
        row.observedClass,
      ),
      `unexpected class ${row.observedClass}`,
    );
  }
  assert.ok(
    runState.evidence.notEstablished.includes("no_w7_acceptance_predicate_is_evaluated_or_licensed_here"),
  );
});

test("mapping: self and parent SIGKILL pairs are recorded per label without an authorship claim", () => {
  assert.equal(runState.evidence.pairTable.length, LABELS.length);
  for (const entry of runState.evidence.pairTable) {
    assert.equal(entry.selfSigkill.length, PRIMARY_TRIALS);
    assert.equal(entry.parentSigkill.length, PRIMARY_TRIALS);
    assert.equal(entry.authorshipDistinguishableFromRawPairAlone, null);
    // The two arms differ in parent operation by construction: zero signals vs
    // one. That is what makes the comparison causally meaningful.
    assert.equal(entry.selfArmPolicy, POLICY_OBSERVE_ONLY);
    assert.equal(entry.parentArmPolicy, POLICY_KILL_ON_VALID_MARKER);
    assert.equal(entry.selfArmExperimentalSignalsIssued, 0);
    assert.equal(entry.parentArmExperimentalSignalsIssued, PRIMARY_TRIALS);
    // The comparison is RECORDED, never asserted to a value: whether the two
    // authorships coincide in the OS-reported fields is exactly the per-OS
    // measurement this apparatus exists to capture.
    assert.deepEqual(entry.comparedOsFieldNames, OS_REPORTED_FIELDS);
    assert.equal(typeof entry.recordedOsPairSetsEqual, "boolean");
    assert.ok(Array.isArray(entry.distinguishingOsFieldNames));
    assert.equal(entry.recordedOsPairSetsEqual, entry.distinguishingOsFieldNames.length === 0);
    for (const pair of entry.selfSigkill) {
      assert.ok("rawExitCode" in pair && "rawSignal" in pair);
      assert.equal(pair.experimentalSignalRequested, false);
      assert.equal(pair.observedClass, "TERMINATION_OBSERVED_NO_PARENT_SIGNAL");
    }
    for (const pair of entry.parentSigkill) {
      assert.ok("rawExitCode" in pair && "rawSignal" in pair);
      assert.equal(pair.experimentalSignalRequested, true);
      assert.equal(pair.observedClass, "TERMINATION_OBSERVED_AFTER_PARENT_SIGNAL");
    }
  }
  assert.ok(
    runState.evidence.notEstablished.includes("same_raw_pair_does_not_establish_same_kill_authorship"),
  );
});

test("exit hook: the paired orderly-exit arm emits the exact sentinel, the self-kill arm none", () => {
  for (const label of LABELS) {
    const orderly = runState.rows.filter(
      (r) => r.scenarioId === `liveness/ordinary_exit1_at_marker/${label}`,
    );
    const selfKill = runState.rows.filter((r) => r.scenarioId === `primary/self_sigkill/${label}`);
    assert.equal(orderly.length, PRIMARY_TRIALS);
    assert.equal(selfKill.length, PRIMARY_TRIALS);

    // POSITIVE side. This is the liveness proof: without it, the negative side
    // below would be an absence this apparatus could not interpret at all.
    for (const row of orderly) {
      const o = row.observation;
      assert.equal(o.exitHookExactMatches, 1, `${row.scenarioId}#${row.trial} exact sentinel count`);
      assert.equal(o.exitHookLinesObserved, 1, `${row.scenarioId}#${row.trial} sentinel line count`);
      // It really did leave by an ordinary exit, not by a signal.
      assert.equal(o.rawExitCode, 1);
      assert.equal(o.rawSignal, null);
      // The pair only means something if both arms were bounded and clean.
      assert.equal(o.joined, true);
      assert.equal(o.timedOut, false);
      assert.equal(o.resultObserved, false);
      assert.equal(o.killRequested, false);
      // The announce itself was the exact assigned identity, same as the
      // self-kill arm, so the two arms are paired at the SAME valid marker.
      assert.equal(o.markerValidForm, true);
      assert.equal(o.markerPointMatches, true);
      assert.equal(o.markerNonceMatches, true);
      assert.equal(o.markerPidMatchesHandle, true);
    }

    // NEGATIVE side. Recorded as an observation of THIS bounded run. A missing
    // sentinel is failure-or-unknown; it is not read as proof of anything.
    for (const row of selfKill) {
      const o = row.observation;
      assert.equal(o.exitHookExactMatches, 0, `${row.scenarioId}#${row.trial} exact sentinel count`);
      assert.equal(o.exitHookLinesObserved, 0, `${row.scenarioId}#${row.trial} sentinel line count`);
      assert.equal(o.joined, true);
      assert.equal(o.timedOut, false);
      assert.equal(o.resultObserved, false);
      assert.equal(o.killRequested, false);
    }
  }
  assert.ok(
    runState.evidence.notEstablished.includes(
      "exit_hook_sentinel_absence_is_failure_or_unknown_not_proof_of_abrupt_termination",
    ),
  );
});

test("exit hook: sentinel facts are kept out of the raw pair comparison and out of the gate", () => {
  // The raw-pair projection must stay OS-reported plus parent-operational only.
  for (const entry of runState.evidence.pairTable) {
    for (const pair of [...entry.selfSigkill, ...entry.parentSigkill]) {
      for (const key of Object.keys(pair)) {
        assert.ok(!/exithook/i.test(key), `raw pair projection must not carry ${key}`);
      }
    }
    assert.deepEqual(entry.comparedOsFieldNames, OS_REPORTED_FIELDS);
  }
  // The gate decided on identity and prior disqualifiers only. No sentinel input,
  // so a sentinel can neither cause nor suppress an experimental signal.
  for (const row of runState.rows) {
    if (!row.observation.gateDecision) continue;
    for (const key of Object.keys(row.observation.gateDecision)) {
      assert.ok(!/exithook/i.test(key), `gate decision must not carry ${key}`);
    }
  }
  const t = runState.evidence.exitHookSentinel;
  assert.equal(t.mixedIntoRawPairComparison, false);
  assert.equal(t.usedAsGateInput, false);
  assert.equal(t.usedByClassification, false);
  assert.ok(
    runState.evidence.notEstablished.includes(
      "exit_hook_observations_are_not_mixed_into_the_raw_os_pair_comparison",
    ),
  );
  assert.ok(
    runState.evidence.notEstablished.includes(
      "exit_hook_sentinel_absence_does_not_prove_no_orderly_code_ran",
    ),
  );
});

test("exit hook: the sentinel table is recorded separately and every sentinel read was exact", () => {
  const t = runState.evidence.exitHookSentinel;
  assert.equal(t.registeredBeforeScenarios, true);
  assert.equal(t.emittedSynchronouslyFromProcessExitHook, true);
  assert.equal(t.pairedLiveness.length, LABELS.length);
  for (const p of t.pairedLiveness) {
    assert.equal(p.orderlyExitArm.trialsWithExactSentinel, PRIMARY_TRIALS);
    assert.equal(p.orderlyExitArm.sentinelExactMatches, PRIMARY_TRIALS);
    assert.equal(p.selfKillArm.trialsWithExactSentinel, 0);
    assert.equal(p.selfKillArm.sentinelExactMatches, 0);
    assert.equal(p.selfKillArm.trialsWithNoSentinelLine, PRIMARY_TRIALS);
    // Both sides of the pair ran under the SAME zero-signal policy, which is
    // what makes the sentinel difference attributable to the manner of leaving
    // rather than to this parent having operated on one arm and not the other.
    for (const arm of [p.orderlyExitArm, p.selfKillArm]) {
      assert.equal(arm.trials, PRIMARY_TRIALS);
      assert.equal(arm.parentPolicy, POLICY_OBSERVE_ONLY);
      assert.equal(arm.experimentalSignalsIssued, 0);
      assert.equal(arm.allJoined, true);
      assert.equal(arm.anyTimedOut, false);
      assert.equal(arm.anyResultObserved, false);
    }
  }
  // Every sentinel line read anywhere in the run was the exact typed form for
  // that trial, and no process emitted more than one.
  for (const row of runState.rows) {
    const o = row.observation;
    assert.equal(
      o.exitHookExactMatches,
      o.exitHookLinesObserved,
      `${row.scenarioId}#${row.trial} read a non-exact sentinel line`,
    );
    assert.ok(
      o.exitHookLinesObserved <= 1,
      `${row.scenarioId}#${row.trial} read ${o.exitHookLinesObserved} sentinels`,
    );
  }
});

test("policy: the added liveness arm issued zero signals and left the 11 accounting intact", () => {
  const liveness = runState.rows.filter((r) => r.scenario.family === "liveness");
  assert.equal(liveness.length, LABELS.length * PRIMARY_TRIALS);
  for (const row of liveness) {
    assert.equal(row.observation.parentPolicy, POLICY_OBSERVE_ONLY);
    assert.equal(row.observation.killRequested, false);
    assert.equal(row.observation.killApiReturn, null);
    assert.equal(row.observation.apparatusTimeoutKill, false);
  }
  // The pre-existing experimental-signal accounting is unchanged, and its shape
  // is preserved as it actually is: 11 signals = 9 primary parent-kill trials
  // PLUS 2 hold-release controls. The hold-release control has TWO parent
  // signals, not zero.
  assert.equal(custody.experimentalSignalsIssued, 11);
  const primaryParent = runState.rows.filter(
    (r) => r.scenario.family === "primary" && r.scenario.mode === "parent_sigkill",
  );
  assert.equal(primaryParent.filter((r) => r.observation.killRequested).length, 9);
  const releaseControls = runState.rows.filter((r) => r.scenario.mode === "nc_boundedhold_release");
  assert.equal(releaseControls.filter((r) => r.observation.killRequested).length, 2);
  assert.equal(
    runState.evidence.parentOperationPolicies.experimentalSignalsByPolicy[POLICY_OBSERVE_ONLY],
    0,
  );
});

test("scope: platform is recorded and no Windows mapping is inferred from a non-win32 run", () => {
  assert.equal(runState.evidence.runtime.windowsMeasured, process.platform === "win32");
  assert.equal(runState.evidence.scope, "process_only");
  assert.equal(runState.evidence.labelSemantics, "synthetic_process_markers_not_sqlite_boundaries");
  assert.ok(
    runState.evidence.notEstablished.includes("windows_mappings_cannot_be_inferred_from_a_non_win32_run"),
  );
  assert.ok(runState.evidence.notEstablished.includes("no_sqlite_no_storage_no_filesystem_durability_claim"));
});

test("evidence: structured JSON and rawlog were written under the owned evidence root", () => {
  for (const name of ["termination-map.json", "termination-map-rawlog.jsonl"]) {
    const p = path.join(EVIDENCE_DIR, name);
    assert.ok(fs.existsSync(p), `${name} missing`);
    assert.ok(fs.statSync(p).size > 0, `${name} empty`);
  }
  const parsed = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "termination-map.json"), "utf8"));
  assert.equal(parsed.custody.everyChildJoined, true);
  assert.equal(parsed.custody.pidScansPerformed, 0);
  assert.equal(parsed.custody.processGroupsSignalled, 0);
  assert.equal(parsed.custody.processesSignalledOtherThanOwnedHandles, 0);
  assert.deepEqual(parsed.custody.signalTargetKinds, ["owned_child_process_handle"]);
  assert.equal(parsed.parentOperationPolicies.fixedBeforeSpawn, true);
  assert.equal(parsed.parentOperationPolicies.experimentalSignalsByPolicy[POLICY_OBSERVE_ONLY], 0);
  assert.equal(parsed.records.length, runState.rows.length);
  assert.deepEqual(parsed.notEstablished, NOT_ESTABLISHED);
  // The evidence root is the supplied owned root; nothing was written to a host
  // location, and os.tmpdir() was never used as a destination.
  assert.notEqual(path.resolve(EVIDENCE_DIR), path.resolve(os.tmpdir()));
});
