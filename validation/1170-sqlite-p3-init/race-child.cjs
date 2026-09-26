"use strict";

// P3 R1 race child entrypoint - one cooperating initializer per forked process.
//
// Requires the SLICE ONLY. states.cjs is deliberately unreachable from here (K3), so a race
// child can never create, adopt or repair a state; it can only attempt the one claim.
//
// Protocol, exactly:
//   child  -> parent   { type: "ready" }                      once, at startup
//   parent -> child    { type: "go", storeRoot, options }     the start barrier
//   child  -> parent   { type: "result", result }             the single result, verbatim
//   the child then disconnects its IPC channel and exits cleanly on its own.
//
// The test owns the exact fork handle and is the only party that may terminate this process.
// This file signals, kills and scans nothing: it calls process.exit on no path, sends no
// signal, and never looks at any other process.
//
// The initializer is invoked AT MOST ONCE - a second "go" is ignored rather than re-claimed -
// so a non-unique winner in an iteration can only come from the claim primitive itself, which
// is what R1 measures.
//
// P3_CRASH_AT is honoured inside the slice, not here: when it names a point this child reaches,
// the process terminates there and sends no result. That is PROCESS TERMINATION, never
// power-loss evidence.
//
// Note for the test: the result crosses the Node IPC channel, which serialises as JSON, so an
// `error` value carried by a transaction or close refusal does not survive the trip. R1 results
// are ok:true or experimental_store_root_exists and carry no error property, so the race oracle
// is unaffected; a child result is not the place to read `error`.

const { initializeExperimentalSqliteStore } = require("./init-exclusive.cjs");

if (typeof process.send !== "function") {
  throw new Error(
    "race-child.cjs must be started with child_process.fork so that an IPC channel exists",
  );
}

let claimed = false;

process.on("message", (message) => {
  if (!message || message.type !== "go" || claimed) return;
  claimed = true;
  const result = initializeExperimentalSqliteStore(message.storeRoot, message.options);
  process.send({ type: "result", result }, () => {
    // Drop the IPC channel so the event loop drains and this child exits with code 0 by
    // itself. No process.exit, no signal, no kill.
    if (process.channel) process.disconnect();
  });
});

process.send({ type: "ready" });
