"use strict";

// Task #1170 - OS termination REPRESENTATION apparatus, owned child entrypoint.
// PROCESS-ONLY. This file opens no store, requires no slice, touches no SQLite,
// performs no filesystem durability work and makes no storage claim of any kind.
//
// What this child exists to do: reach one of a small number of predeclared
// process end-states, in a way the parent can account for, so that the RAW
// (exitCode, signal) pair the OS reports for each end-state can be RECORDED.
// Recorded, not interpreted: nothing here establishes that two end-states with
// the same raw pair are the same event.
//
// The three point labels after_cas_read / after_row_insert / before_commit are
// SYNTHETIC PROCESS MARKERS. They are strings passed in by the parent and
// printed back. They are NOT actual SQLite boundaries, they are not reached by
// executing any slice, and a marker carrying one of them is evidence about this
// process only.
//
// Protocol, exactly. Everything typed is a single line on stdout, written
// synchronously with fs.writeSync so it is in the pipe before the next
// statement runs:
//
//   TM_MARKER v1 point=<point> nonce=<32 hex> pid=<pid>
//       the identity announce. The parent signals ONLY on a line of exactly
//       this shape whose point and nonce are the ones it assigned.
//   TM_RESULT ok=true
//       an ordinary returned result. Its presence means this process produced a
//       value; an arm that produces one is not a termination observation.
//   TM_HOLD_RELEASED
//       the bounded hold expired and this process resumed executing JS.
//   TM_EXIT_HOOK v1 point=<point> nonce=<32 hex> pid=<pid>
//       the orderly-exit sentinel, written from a process.on('exit') listener
//       registered BEFORE any scenario below runs. Its PRESENCE means Node's
//       orderly exit path ran in this process. Its ABSENCE means only that
//       this parent did not read one: it is failure-or-unknown, NOT proof that
//       no orderly code ran and NOT proof of abrupt termination.
//
// This file signals nothing except its own pid, and only in the self_sigkill
// mode whose entire purpose is to record what a self-directed SIGKILL looks
// like. It never scans pids, never touches a process group, never enumerates or
// signals any process other than itself, and never kills anything globally.
//
// A marker does NOT prove that no JS ran afterwards, and it does not prove the
// bounded hold was entered or observed. The hold is synchronous, but whether it
// was actually reached is not established by the marker - see the parent's
// notEstablished list. Atomics.wait is the hold mechanism; if it is unavailable
// the fallback is a synchronous spin, which DOES execute JS, and the mechanism
// actually used is printed so the parent records it rather than assuming.

const fs = require("node:fs");

const MODE = process.env.TM_MODE || "";
const NONCE = process.env.TM_NONCE || "";
const POINT = process.env.TM_POINT || "";
const HOLD_MS = Number.parseInt(process.env.TM_HOLD_MS || "0", 10);
// A second synchronous hold used ONLY to keep an arm observable after it has
// already announced something disqualifying, so the parent reads the pipe while
// this process is still alive. It removes a read-vs-exit race from the control;
// it is not part of any measurement.
const LINGER_MS = Number.parseInt(process.env.TM_LINGER_MS || "0", 10);

// A well-formed nonce of the right shape that is deliberately NOT the assigned
// one, for the identity-gate control. Well-formed so that the gate is tested on
// identity, not on parsing.
const FOREIGN_NONCE = "0".repeat(32);

function writeOut(line) {
  fs.writeSync(1, line + "\n");
}

function markerLine(nonce, point) {
  return `TM_MARKER v1 point=${point} nonce=${nonce} pid=${process.pid}`;
}

// Synchronous bounded hold. Returns the mechanism actually used so the parent
// records it. ms === 0 returns immediately by design: that is the hold-release
// control, not a degraded hold.
function boundedHold(ms) {
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
    return "atomics_wait";
  } catch (err) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // Synchronous spin. This executes JS; it is reported, not hidden.
    }
    return "spin";
  }
}

// ---------------------------------------------------------------------------
// The orderly-exit hook sentinel. ONE fixed typed line, emitted synchronously
// with fs.writeSync from a process.on('exit') listener registered HERE, before
// the scenario switch below, so every mode runs under the same registration and
// no arm is advantaged by when the listener was installed.
//
// Bound to this trial's assigned point and nonce and to this pid, so the parent
// can separate an exact sentinel from any other line on the pipe.
//
// Scope of what a sentinel can support: presence shows the orderly exit path
// ran in THIS process, in THIS source-pinned apparatus. Absence is recorded as
// absence. It does not establish that no JS ran, does not establish how the
// process ended, and says nothing about kill delivery or storage.
// ---------------------------------------------------------------------------

function exitHookLine() {
  return `TM_EXIT_HOOK v1 point=${POINT} nonce=${NONCE} pid=${process.pid}`;
}

process.on("exit", () => {
  fs.writeSync(1, exitHookLine() + "\n");
});

function dropIpc() {
  // Release the IPC channel so the event loop drains and this process exits on
  // its own with code 0. No process.exit on this path.
  if (process.channel && typeof process.disconnect === "function") process.disconnect();
}

switch (MODE) {
  // ---- primary arms: the two authorships of one SIGKILL -------------------

  case "self_sigkill": {
    // Announce, then this process kills itself. The parent cannot have issued
    // anything yet: it has not read the announce bytes. Whatever raw pair the
    // OS reports here is the self-kill representation on THIS platform.
    writeOut(markerLine(NONCE, POINT));
    process.kill(process.pid, "SIGKILL");
    // Reached only if the platform did not terminate this process here. That
    // itself is a measurement, so it is announced rather than swallowed.
    writeOut("TM_HOLD_RELEASED");
    process.exit(3);
    break;
  }

  case "ordinary_exit1_at_marker": {
    // The PAIRED LIVENESS ARM for self_sigkill. It announces the SAME exact
    // identity at the SAME synthetic marker, then leaves by an ORDINARY
    // process.exit(1) instead of a self-directed SIGKILL. Its declared parent
    // policy is observe_only, identical to the self-kill arm, so this parent
    // issues zero experimental signals for it either.
    //
    // Why it exists: an orderly exit at this marker MUST produce the exact
    // sentinel. That is what makes the self-kill arm's silence an observed
    // difference rather than an unexplained absence. Without this positive
    // side, a missing sentinel could not be told apart from a broken detector.
    //
    // This arm is an ordinary exit and is NOT a termination observation. Its
    // raw (1, null) pair is recorded as observed and is never read as a W7 pass.
    writeOut(markerLine(NONCE, POINT));
    process.exit(1);
    break;
  }

  case "parent_sigkill": {
    // Announce, then hold synchronously. The parent validates the announce and
    // signals this exact handle. If the hold expires instead, that is visible:
    // TM_HOLD_RELEASED and exit 3, never a silent success.
    writeOut(markerLine(NONCE, POINT));
    const mechanism = boundedHold(HOLD_MS);
    writeOut(`TM_HOLD_RELEASED mechanism=${mechanism}`);
    process.exit(3);
    break;
  }

  // ---- negative controls --------------------------------------------------

  case "nc_ordinary_exit0_result": {
    // Ordinary cooperating child: returns a result over IPC and exits 0 on its
    // own. No announce, so the identity gate must not signal it.
    if (typeof process.send === "function") {
      process.send({ type: "result", result: { ok: true } }, () => dropIpc());
    } else {
      dropIpc();
    }
    break;
  }

  case "nc_ordinary_exit1": {
    // Ordinary non-zero exit. No announce. On win32 this raw pair may be
    // indistinguishable from a self-kill; that is the point of recording it.
    process.exit(1);
    break;
  }

  case "nc_thrown_error_exit1": {
    // Ordinary thrown error: uncaught, stack on stderr, exit 1. Not a
    // termination event.
    throw new Error("TM_SYNTHETIC_THROW ordinary error, not a termination");
  }

  case "nc_missing_marker": {
    // Prints no announce at all. (The orderly-exit sentinel registered above
    // still fires on the way out; it is not an announce and the gate ignores it.)
    dropIpc();
    break;
  }

  case "nc_wrong_marker": {
    // Announce-shaped but not the exact typed form.
    writeOut("TM_MARKER v0 garbled not-the-typed-form");
    dropIpc();
    break;
  }

  case "nc_wrong_nonce": {
    // Exact typed form, well-formed nonce, wrong identity.
    writeOut(markerLine(FOREIGN_NONCE, POINT));
    dropIpc();
    break;
  }

  case "nc_wrong_pid": {
    // Exact typed form, correct point AND correct nonce, but a pid field that is
    // NOT this process. The parent must refuse to signal on it. This control is
    // INERT by construction: the printed number is only a string in a line, the
    // parent signals nothing but its own ChildProcess handle, and no process
    // anywhere is looked up, scanned or signalled because of it.
    fs.writeSync(
      1,
      `TM_MARKER v1 point=${POINT} nonce=${NONCE} pid=${process.pid + 1}\n`,
    );
    dropIpc();
    break;
  }

  case "nc_result_before_kill": {
    // Result FIRST, in the same synchronous tick as the announce, so both lines
    // are in the pipe before the parent can decide anything. An arm that
    // returned a value is not a termination observation regardless of what
    // happens to the process afterwards.
    writeOut("TM_RESULT ok=true");
    writeOut(markerLine(NONCE, POINT));
    const mechanism = boundedHold(HOLD_MS);
    writeOut(`TM_HOLD_RELEASED mechanism=${mechanism}`);
    process.exit(3);
    break;
  }

  case "nc_boundedhold_release": {
    // Announce, hold 0 so the hold releases immediately, then resume executing
    // JS. Both lines are in the pipe before the parent can read either, so the
    // parent's gate decision is taken on the announce while the release is
    // already a fact in flight. The linger keeps this process alive while the
    // parent reads, so the arm does not depend on a read-vs-exit race.
    writeOut(markerLine(NONCE, POINT));
    const mechanism = boundedHold(0);
    writeOut(`TM_HOLD_RELEASED mechanism=${mechanism}`);
    boundedHold(LINGER_MS);
    process.exit(1);
    break;
  }

  default: {
    fs.writeSync(2, `TM_CHILD_UNKNOWN_MODE ${JSON.stringify(MODE)}\n`);
    process.exit(64);
  }
}
