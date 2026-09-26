"use strict";

// P4 W6 concurrent-writer child entrypoint - one cooperating writer per forked process.
//
// Requires the SLICE ONLY. The fixture module is deliberately unreachable from here (W9), so a
// child can never create, adopt or repair a store; it can only attempt the one mutation.
//
// Protocol, exactly:
//   child  -> parent   { type: "ready" }                      once, at startup
//   parent -> child    { type: "go", storeRoot, options }     the start barrier
//   child  -> parent   { type: "result", result }             the single result, verbatim
//   the child then disconnects its IPC channel and exits cleanly on its own.
//
// The test owns the exact fork handle and is the only party that may terminate this process. This
// file signals, kills and scans nothing: it calls process.exit on no path, sends no signal, and
// never looks at any other process.
//
// The writer is invoked AT MOST ONCE - a second "go" is ignored rather than re-applied - so a
// non-unique winner in an iteration can only come from the transaction and CAS primitives
// themselves, which is what W6 measures.
//
// P4_CRASH_AT is honoured INSIDE the slice, not here: when it names a point this child reaches,
// the process terminates there and SENDS NO RESULT. That is PROCESS TERMINATION, never power-loss
// evidence. A killed process cannot return a JS object, so for it no reason code, committed or
// retrySafe field exists at all, and the parent MUST NOT synthesize one (R2-2): the parent
// records the RAW observed pair, an unknown child outcome and an unknown commit outcome, and that
// unknown is a separate record from any surviving-process result. The pair itself is PLATFORM
// SCOPED and is never the attribution: on win32 a self-delivered SIGKILL is reported as
// (exitCode 1, signal null), which is exactly what an ordinary exit(1) reports, so the parent
// attributes from the compound oracle below and never from the pair.
//
// Note for the test: the result crosses the Node IPC channel, which serialises as JSON, so an
// `error` or `cleanupError` value carried by a refusal does NOT survive the trip. W6 results are
// ok:true, experimental_store_generation_conflict or experimental_store_busy and carry neither,
// so the W6 oracle is unaffected; a child result is not the place to read a thrown cause. The
// committed:null of an uncertain commit does survive, because JSON carries null.

// W7 EXIT WITNESS, gated and inert when unset.
//
// The parent's W7 oracle needs a POSITIVE witness that Node's JS exit path ran in a child, and it
// needs that witness bound in BOTH arms of the same seam, so that its absence in the self-kill
// arm is a measurement rather than an unfalsifiable absence. The hook below is that witness.
//
// Inert when unset is the whole point: with P4_WITNESS_AT or P4_WITNESS_NONCE absent or malformed
// NO listener is registered, no module is loaded, no descriptor is touched and nothing is written
// - the unseamed child's runtime is the one it had before. Every W6 child and every W7x child
// runs with this gate unset.
//
// The line is composed ONCE here, from the validated point, the validated nonce and this
// process's own pid, so the hook itself reads no environment and builds no string on the way out.
// It scans nothing, signals nothing and looks at no other process.
//
// SCOPE, stated rather than implied: the sentinel's PRESENCE shows that Node's orderly exit path
// ran in this process. Its ABSENCE is only an absence. It is one conjunct of the parent's oracle,
// and on its own it proves nothing about how a process ended.
const WITNESS_POINT_TEXT = /^[a-z][a-z_]{0,31}$/;
const WITNESS_NONCE_TEXT = /^[0-9a-f]{32}$/;

const witnessPoint = process.env.P4_WITNESS_AT;
const witnessNonce = process.env.P4_WITNESS_NONCE;
if (typeof witnessPoint === "string" && WITNESS_POINT_TEXT.test(witnessPoint)
  && typeof witnessNonce === "string" && WITNESS_NONCE_TEXT.test(witnessNonce)) {
  const witnessLine =
    `P4_EXIT_WITNESS v1 point=${witnessPoint} nonce=${witnessNonce} pid=${process.pid}\n`;
  // writeSync, for the same reason the slice's seam emitter uses it: a pipe write through
  // process.stdout is asynchronous, and an exit hook has no later turn in which to flush.
  process.on("exit", () => { require("node:fs").writeSync(1, witnessLine); });
}

const { applyExperimentalStoreMutation } = require("./write-cas.cjs");

if (typeof process.send !== "function") {
  throw new Error(
    "write-child.cjs must be started with child_process.fork so that an IPC channel exists",
  );
}

let applied = false;

process.on("message", (message) => {
  if (!message || message.type !== "go" || applied) return;
  applied = true;
  const result = applyExperimentalStoreMutation(message.storeRoot, message.options);
  process.send({ type: "result", result }, () => {
    // Drop the IPC channel so the event loop drains and this child exits with code 0 by itself.
    // No process.exit, no signal, no kill.
    if (process.channel) process.disconnect();
  });
});

process.send({ type: "ready" });
