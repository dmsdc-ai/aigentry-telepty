"use strict";

// P4 W6-R CONTROLLED LOCK-HOLDING PEER - one owned peer process per W6-R arm.
//
// TESTER LANE, ADDITIVE, INSTRUMENTATION ONLY. This file is not part of the slice under test, is
// imported by nothing, and imports nothing but the pinned native binding. W6-R changes no
// mechanism: write-cas.cjs, write-child.cjs, states.cjs, recovery-observe.cjs, package.json and
// package-lock.json are untouched, no dependency is added, no Node floor moves, no journal mode is
// chosen and no product file is involved. W6 itself is untouched and its exactly-one-winner and
// closed-loser-vocabulary oracles are unchanged.
//
// Purpose: give the parent a lock holder whose LIFETIME THE PARENT DECIDES, so one contention
// outcome can be measured with ONE writer and ONE peer instead of being scrambled out of an 8-way
// race. What it produces is ONE DISCRIMINATING OBSERVATION. It is not proof that the same lock
// holder caused any earlier W6 outcome, and a successful commit after a release does not uniquely
// establish release latency - both of those readings are explicitly disclaimed by the arms.
//
// Protocol, exactly:
//   child  -> parent   { type: "ready" }                        once, at startup
//   parent -> child    { type: "hold", mode, dbPath, nonce }    the single hold command
//   child  -> parent   { type: "held", observation }            the single hold observation
//   parent -> child    { type: "release" }                      the single release command
//   child  -> parent   { type: "released", observation }        the single release observation
//   the child then disconnects its IPC channel and exits cleanly on its own.
//
// A second hold or a second release is IGNORED rather than re-applied, so the peer can pass through
// each phase at most once and the parent's accounting cannot be inflated by a repeated command.
//
// COOPERATIVE RELEASE, NOT A SIGKILLED BARRIER - a DELIBERATE DIVERGENCE from the analyst
// proposal's "block forever in Atomics.wait, then SIGKILL the peer" shape, taken because the
// controller-reviewed limits require every phase to be bounded and every child to be JOINED before
// its root is removed. The existing T oracle requires every child outside W7x to have lifecycle
// "exited-observed" with killRequested:false, and requires the run-wide experimental-signal total
// to stay exactly one per W7x seam; a signalled peer would break both, which would be a relaxation
// of existing acceptance rather than an addition to it. Holding inside the event loop instead keeps
// the transaction - and therefore the lock - open for exactly as long as the parent wants, while
// leaving the peer joinable. That is also what lets the owned root be removed on win32, where an
// open database handle blocks removal. Nothing is weakened: the hold is a real open transaction on
// a real native handle, and the parent still verifies its own challenge before it trusts the peer.
//
// This file signals, kills and scans nothing: it calls process.exit on no path, sends no signal,
// and never looks at any other process. The parent owns the exact fork handle and is the only party
// that could ever terminate this process.
//
// It also never MODIFIES anything. Its whole statement vocabulary is the four literals below - the
// deferred transaction start, the immediate transaction start, one keyed read of one metadata row,
// and the transaction discard - with no data statement of any kind, no PRAGMA, no journal-mode
// change and no busy_timeout statement. There is EXACTLY ONE handle construction and EXACTLY ONE
// discard site. W9 asserts that closed statement set, the single construction, the single allowed
// require and the absence of every filesystem token directly from this source. The read arm opens
// READ-ONLY, so on that path a write is not merely unwritten but unavailable. The transaction is
// always discarded rather than committed, so not even an empty commit can be attributed to this
// peer.
//
// IPC CARRIES NO Error. The Node IPC channel serialises as JSON, and an Error's message, stack and
// name are all non-enumerable, so an Error sent across it arrives as {} - which is exactly how a
// cause-side fact becomes an invisible loss that later reads as "nothing happened". Every cause
// this peer observes is therefore projected to EXPLICIT SCALARS here, before it is sent, each
// carrying its own observed flag: observed:false means no error occurred at all, while
// observed:true with code null means an error DID occur whose code was not a non-empty string.
// The two are never collapsed into one null. synthetic is read from the observed value alone, so a
// native fault is never labelled synthetic and a synthetic one is never labelled native.
//
// No timing claim is made anywhere: this file measures no duration, and the parent asserts none.

const Database = require("better-sqlite3"); // pinned 13.0.3

// The closed mode set. Underscored on purpose so that no mode name can be mistaken for a statement
// keyword by the W9 source scanner, which matches whole words.
const MODE_READ_TXN = "read_txn";
const MODE_FAILED_BEGIN = "failed_begin";
const HOLD_MODES = [MODE_READ_TXN, MODE_FAILED_BEGIN];

// The parent's per-spawn challenge, validated HERE as exactly 32 lowercase hex digits before it is
// echoed, exactly as the existing W7x hold seam validates its own nonce. An oversized or injected
// value can never become part of a message this peer sends.
const HOLD_NONCE_TEXT = /^[0-9a-f]{32}$/;

// P2-CONTRACT section 3 metadata table name, a module constant here, NEVER taken from a message and
// NEVER interpolated from caller input.
const META_ROW_READ = `SELECT key FROM store_meta ORDER BY key LIMIT 1`;

if (typeof process.send !== "function") {
  throw new Error(
    "lock-hold-child.cjs must be started with child_process.fork so that an IPC channel exists",
  );
}

// The ONE place a thrown value becomes a message field. Nothing else in this file reads an error.
function causeScalars(error) {
  if (error === null || error === undefined) {
    return { observed: false, code: null, errno: null, name: null, synthetic: null };
  }
  return {
    observed: true,
    code: typeof error.code === "string" && error.code !== "" ? error.code : null,
    errno: error.errno === undefined ? null : error.errno,
    name: typeof error.name === "string" && error.name !== "" ? error.name : null,
    // Read from the observed value alone. A native fault carries no such property, so this is
    // false for it; only a deliberately labelled synthetic value reports true.
    synthetic: error.synthetic === true,
  };
}

// Mode-dependent open OPTIONS, declared in the observation rather than implied - and kept separate
// from the single construction site below so that there is exactly one `new Database(` in this file.
//
// read_txn opens READ-ONLY: the strongest available statement that this peer cannot modify the
// store even by accident. failed_begin must be read-write, because an immediate transaction start
// on a read-only connection fails for being read-only, which is a DIFFERENT fault from the
// write-lock contention that arm exists to observe - accepting it would measure the wrong state.
//
// timeout 0 on both paths: contention is MEASURED rather than waited out. A nonzero value would
// turn this instrument into a hidden wait and could let the peer succeed after the parent released
// its own holder, which would destroy the observation.
function openOptions(mode) {
  return mode === MODE_READ_TXN
    ? { readonly: true, timeout: 0 }
    : { fileMustExist: true, timeout: 0 };
}

let holdCommanded = false;
let releaseCommanded = false;
let db = null;
let declaredOpenOptions = null;

// The ONE transaction-discard site in this file. Both callers route through it, so the statement
// vocabulary stays closed and no second spelling of a discard can ever appear.
function discardOpenTransaction() {
  if (db === null || db.inTransaction !== true) {
    return { attempted: false, error: causeScalars(null) };
  }
  try {
    db.exec(`ROLLBACK`);
    return { attempted: true, error: causeScalars(null) };
  } catch (error) {
    return { attempted: true, error: causeScalars(error) };
  }
}

// Every way this function can end other than a reported hold is an UNMET PRECONDITION that holds
// nothing, and it is reported as one rather than silently measuring a different state.
function performHold(message) {
  const mode = message.mode;
  const nonce = message.nonce;
  const dbPath = message.dbPath;

  const observation = {
    mode: typeof mode === "string" ? mode : null,
    nonce: typeof nonce === "string" && HOLD_NONCE_TEXT.test(nonce) ? nonce : null,
    pid: process.pid,
    held: false,
    openAttempted: false,
    openOptions: null,
    openError: causeScalars(null),
    beginAttempted: false,
    beginReturned: false,
    beginError: causeScalars(null),
    readProbeAttempted: false,
    readProbeReturned: false,
    readProbeKeyIsString: false,
    readProbeError: causeScalars(null),
    rollbackAttempted: false,
    rollbackError: causeScalars(null),
    inTransaction: false,
    handleOpen: false,
    unmetPrecondition: null,
  };

  if (observation.nonce === null) {
    observation.unmetPrecondition = "nonce_not_32_lowercase_hex";
    return observation;
  }
  if (!HOLD_MODES.includes(mode)) {
    observation.unmetPrecondition = "mode_not_in_closed_set";
    return observation;
  }
  if (typeof dbPath !== "string" || dbPath === "") {
    observation.unmetPrecondition = "db_path_not_a_non_empty_string";
    return observation;
  }

  observation.openAttempted = true;
  observation.openOptions = openOptions(mode);
  declaredOpenOptions = observation.openOptions;
  try {
    // EXACTLY ONE handle construction in this file, and no default-constructor handle: the path is
    // always the one the parent supplied and the options are always the declared pair above.
    db = new Database(dbPath, observation.openOptions);
  } catch (error) {
    db = null;
    observation.openError = causeScalars(error);
    observation.unmetPrecondition = "handle_could_not_be_constructed";
    return observation;
  }
  observation.handleOpen = db.open === true;

  if (mode === MODE_READ_TXN) {
    // A deferred transaction start takes no lock by itself; the first read statement inside it is
    // what starts the read transaction and takes the shared lock, per the official documentation
    // fetched into input/analysis. Both steps are therefore required for a reported hold, and the
    // read is a real keyed read whose return is recorded, never assumed.
    observation.beginAttempted = true;
    try {
      db.exec(`BEGIN DEFERRED`);
      observation.beginReturned = true;
    } catch (error) {
      observation.beginError = causeScalars(error);
      observation.unmetPrecondition = "deferred_transaction_start_did_not_return";
      observation.inTransaction = db.inTransaction === true;
      return observation;
    }
    observation.readProbeAttempted = true;
    try {
      const row = db.prepare(META_ROW_READ).get();
      observation.readProbeReturned = row !== undefined;
      observation.readProbeKeyIsString = row !== undefined && row !== null
        && typeof row.key === "string";
    } catch (error) {
      observation.readProbeError = causeScalars(error);
      observation.unmetPrecondition = "metadata_read_did_not_return";
      observation.inTransaction = db.inTransaction === true;
      return observation;
    }
    observation.inTransaction = db.inTransaction === true;
    if (!observation.readProbeReturned) {
      observation.unmetPrecondition = "metadata_read_returned_no_row";
      return observation;
    }
    if (!observation.inTransaction) {
      observation.unmetPrecondition = "no_transaction_is_open_after_the_read";
      return observation;
    }
    // The peer now holds an open read transaction on a read-only handle, and says exactly that.
    observation.held = true;
    return observation;
  }

  // MODE_FAILED_BEGIN. The immediate transaction start is EXPECTED TO FAIL, because the parent's
  // own declared fixture connection is holding the write-intent lock at this moment. The peer
  // reports what it actually observed and classifies nothing: whether the refused attempt left a
  // lock behind is precisely the open question, so this peer never claims that it did or did not.
  observation.beginAttempted = true;
  try {
    db.exec(`BEGIN IMMEDIATE`);
    observation.beginReturned = true;
  } catch (error) {
    observation.beginError = causeScalars(error);
  }
  observation.inTransaction = db.inTransaction === true;
  if (observation.beginReturned) {
    // The precondition did not hold: the parent's holder was not in force, so this peer would be
    // sitting on a write-intent lock of its own and the arm would measure the wrong thing. The
    // transaction is discarded IMMEDIATELY here so the parent's writer never meets this peer's
    // lock, and the arm is failed by the parent as an unmet precondition.
    observation.unmetPrecondition = "immediate_transaction_start_did_not_fail";
    const discard = discardOpenTransaction();
    observation.rollbackAttempted = discard.attempted;
    observation.rollbackError = discard.error;
    observation.inTransaction = db.inTransaction === true;
    return observation;
  }
  // The refused attempt is the state this arm freezes. The handle stays OPEN and unclosed, exactly
  // as the loser state under investigation would be.
  observation.held = true;
  return observation;
}

function performRelease() {
  const observation = {
    pid: process.pid,
    openOptions: declaredOpenOptions,
    handleConstructed: db !== null,
    rollbackAttempted: false,
    rollbackError: causeScalars(null),
    closeAttempted: false,
    closeError: causeScalars(null),
    inTransaction: false,
    handleOpen: false,
  };
  if (db === null) return observation;
  // The transaction is DISCARDED, never committed, so this peer can never be the author of any
  // change - not even of an empty commit. A discard that throws does NOT skip the close.
  const discard = discardOpenTransaction();
  observation.rollbackAttempted = discard.attempted;
  observation.rollbackError = discard.error;
  observation.closeAttempted = true;
  try {
    db.close();
  } catch (error) {
    observation.closeError = causeScalars(error);
  }
  observation.inTransaction = db.inTransaction === true;
  observation.handleOpen = db.open === true;
  return observation;
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "hold") {
    if (holdCommanded) return;
    holdCommanded = true;
    process.send({ type: "held", observation: performHold(message) });
    return;
  }
  if (message.type === "release") {
    if (!holdCommanded || releaseCommanded) return;
    releaseCommanded = true;
    process.send({ type: "released", observation: performRelease() }, () => {
      // Drop the IPC channel so the event loop drains and this peer exits with code 0 by itself.
      // No process.exit, no signal, no kill.
      if (process.channel) process.disconnect();
    });
  }
});

process.send({ type: "ready" });
