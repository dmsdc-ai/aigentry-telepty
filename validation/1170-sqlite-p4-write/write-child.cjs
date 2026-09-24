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
// records exitCode null, signal SIGKILL and an unknown child and commit outcome, and that unknown
// is a separate record from any surviving-process result.
//
// Note for the test: the result crosses the Node IPC channel, which serialises as JSON, so an
// `error` or `cleanupError` value carried by a refusal does NOT survive the trip. W6 results are
// ok:true, experimental_store_generation_conflict or experimental_store_busy and carry neither,
// so the W6 oracle is unaffected; a child result is not the place to read a thrown cause. The
// committed:null of an uncertain commit does survive, because JSON carries null.

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
