"use strict";

// P3 experimental EXCLUSIVE INITIALIZER for a conditional-admission SQLite store.
//
// Contract: input/INIT-CONTRACT.md, approved for THIS BOUNDED EXPERIMENT only and adopted by
// nothing. The opening si1170bh identity and 29-file attestation in that document is inherited
// historical text describing the authoring lane, NOT this lane and NOT a verification of this
// file; the manifest actually governing this work is the 20-leaf si1170bj frozen manifest,
// recounted here as 20 declared / 20 present / 0 sha256 or byte-length mismatch.
// P2-CONTRACT.md as amended by P2-CORRECTIONS.md supplies the schema and the ledger shape; the
// corrections win on every contradictory phrase.
//
// EXPERIMENTAL. No product file imports this, no product reason code is added, changed, removed
// or mapped, no product marker, journal policy or Node floor is decided, and no dependency,
// daemon, live store or credential is touched. Every identifier beginning experimental_ below is
// a prototype-only string whose exposure to any caller needs explicit mapping and review later.
//
// Deliberately absent (section 2 and K3):
//   - recursive mkdir of any kind. The single non-recursive mkdirSync(storeRoot) IS the claim,
//     and the parent must ALREADY exist, supplied by the caller. A missing parent surfaces
//     ENOENT from that one call and is REFUSED - never created, never repaired.
//   - any pre-open probe: no lstat, stat, access or existsSync on storeRoot or on any member
//     path. The product pre-scan at persistence.js L418 is a courtesy check, not the gate; only
//     the gate shape is kept here, never lstat-then-open and never stat-then-open as the claim.
//   - any repair path: no unlink, rm, rmdir, truncate or rename, no adopt, migrate or read of a
//     pre-existing state, and no JSON fallback on any SQLite error. A taken name is refused
//     without its contents being opened, read, stat-ed, truncated or deleted.
//   - any product import, and any error MESSAGE string read or matched as proof of absence.

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3"); // pinned 13.0.3, default creating constructor

// Owned namespace = every path under storeRoot: the database plus any SQLite sidecar
// (-journal, default delete mode). The claim covers the whole namespace.
const DB_FILENAME = "conditional-admissions.sqlite3";

// P2-CONTRACT section 3 storage format, verbatim. Table names are module constants and are
// never taken from store data.
const SCHEMA_SQL = `
CREATE TABLE store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE bindings        (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE admissions      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE tombstones      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE fenced_sessions (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

const STORE_META_TABLE = "store_meta";
const SECTION_TABLES = ["bindings", "admissions", "tombstones", "fenced_sessions"];

// store_meta holds TEXT. The reconstructed ledger holds the NUMBER 1, matching the product
// constant CONDITIONAL_ADMISSIONS_SCHEMA_VERSION = 1 at persistence.js.
const SCHEMA_VERSION_TEXT = "1";
const SCHEMA_VERSION_VALUE = 1;

// initialGeneration settles the generation precondition by DEFINING the input explicitly, not
// by deleting the check: it is a REQUIRED input whose only accepted value is the number 0, the
// caller declaring that it initializes from nothing. No generation is ever inferred, read or
// discovered from disk. The initialized result is unchanged: generation === 1.
const REQUIRED_INITIAL_GENERATION = 0;
const INITIAL_GENERATION_TEXT = "1";
const INITIAL_GENERATION_VALUE = 1;

// Byte-for-byte the product marker_id predicate regex (persistence.js validConditionalMarker).
const MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const INIT_INTENT_FIELDS = ["declaredBy", "requestId", "authority"];

// K1: the closed set of named interruption points. Nothing else in this file is interruptible.
const CRASH_POINTS = ["after_claim", "after_open", "before_commit"];

// C7. Row and ledger keys are written with defineProperty on a {} literal so the result keeps
// Object.prototype as its prototype, exactly as JSON.parse does for the legacy JSON store,
// while a key such as __proto__ is stored as an own enumerable property instead of invoking the
// Object.prototype setter.
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  return target;
}

// The product predicate SHAPE at persistence.js L384-392, reimplemented locally and NEVER
// imported: exactly 2 keys, a lowercase uuid-v4 marker_id, and an initialized_at that survives
// a canonical toISOString round trip. P2 case X2 already measured that an uppercase uuid, a
// wrong version or variant nibble, an empty or missing id, missing millis, the +00:00 offset
// form and a space separator all refuse.
function validConditionalMarker(marker) {
  return Boolean(marker) && typeof marker === "object" && !Array.isArray(marker)
    && Object.keys(marker).length === 2
    && typeof marker.marker_id === "string"
    && MARKER_ID.test(marker.marker_id)
    && typeof marker.initialized_at === "string"
    && Number.isFinite(Date.parse(marker.initialized_at))
    && new Date(marker.initialized_at).toISOString() === marker.initialized_at;
}

// initIntent = { declaredBy, requestId, authority }, all non-empty own strings. The three named
// fields are required; unnamed extra keys are not rejected, because the contract fixes an exact
// key count for the marker only. In this experiment authority is a SYNTHETIC test precondition,
// NOT production authentication proof - no real credential, account, network or live store is
// involved. Both persistent records being gone could never prove a fresh installation and never
// substitutes for this intent: nothing here infers "absent, so initialize".
function validInitIntent(initIntent) {
  if (!initIntent || typeof initIntent !== "object" || Array.isArray(initIntent)) return false;
  return INIT_INTENT_FIELDS.every(
    field => Object.hasOwn(initIntent, field)
      && typeof initIntent[field] === "string"
      && initIntent[field] !== "",
  );
}

/**
 * Classify a claim outcome. A falsy `err` means the claim SUCCEEDED.
 *
 * Missing, inaccessible and ambiguous stay distinct, and the vocabulary is closed at four:
 *   owned        - the single mkdirSync returned, so this process owns the namespace
 *   exists       - EEXIST: the name is taken and the state behind it is UNKNOWN and unread
 *   inaccessible - any other errno-classified denial
 *   unclassified - the throw carried no errno
 *
 * ENOENT from an absent parent classifies as inaccessible, NEVER as absence: a name that is not
 * there is not positive proof that nothing is there, and no message string is matched to claim
 * otherwise. An unclassified failure still refuses safely - an unknown classification degrades
 * the reported reason, it never blocks the refusal.
 *
 * @param {*} err the value thrown by the claim, or a falsy value if it did not throw.
 * @returns {{errno: string|undefined, classification: string}}
 */
function classifyClaimFailure(err) {
  if (!err) return { errno: undefined, classification: "owned" };
  const errno = typeof err.code === "string" && err.code !== "" ? err.code : undefined;
  if (errno === undefined) return { errno: undefined, classification: "unclassified" };
  if (errno === "EEXIST") return { errno, classification: "exists" };
  return { errno, classification: "inaccessible" };
}

// K1 seam. Deterministic mid-init termination at one of three named points, for leftover
// CLASSIFICATION only. This is PROCESS TERMINATION, never power-loss evidence: nothing is
// flushed, no fsync is issued and no durability claim is made. The hook can only terminate the
// run - it can never supply a success and never alters a result. It signals exactly this
// process id: no process scan, no signal to any other process, no global kill. Inert unless
// P3_CRASH_AT names this exact point.
function crashIfRequested(point) {
  if (!CRASH_POINTS.includes(point)) return;
  if (process.env.P3_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
}

// K4 seam. One named, clearly labelled, FAILURE-ONLY synthetic close fault. It arms only after
// a successful COMMIT, it never bypasses the real db.close() (the real close is always
// attempted first and a real close failure wins), it can only ADD a close failure, and it can
// never suppress, mask or alter any other outcome. Inert when unset. The induced fault is
// labelled synthetic on the error it carries and is NEVER a measured native close failure: it
// exercises the P2 swallow branch that case X3 records as UNMEASURED, for reachability only.
function syntheticCloseFaultRequested() {
  return process.env.P3_CLOSE_FAULT === "1";
}

function syntheticCloseError() {
  const error = new Error(
    "synthetic close fault induced by P3_CLOSE_FAULT - not a measured native close failure",
  );
  error.synthetic = true;
  return error;
}

// P2-CONTRACT section 5: the ledger has EXACTLY 7 keys and Object.keys() reports them in this
// order - schema_version, generation, marker, bindings, admissions, tombstones,
// fenced_sessions. The list is deliberately module-private and unexported, so the tester writes
// its 7-key expectation independently and green cannot mean self-agreement.
function buildLedger(marker) {
  const ledger = {};
  defineOwn(ledger, "schema_version", SCHEMA_VERSION_VALUE);
  defineOwn(ledger, "generation", INITIAL_GENERATION_VALUE);
  // The EXACT marker the caller supplied, echoed as the two-key object the predicate accepted.
  // Never a fixture value, and never re-read from disk.
  const echoed = {};
  defineOwn(echoed, "marker_id", marker.marker_id);
  defineOwn(echoed, "initialized_at", marker.initialized_at);
  defineOwn(ledger, "marker", echoed);
  // An initialized store holds no bindings, admissions, tombstones or fenced sessions: the four
  // section tables are created empty, so the four section objects are empty.
  for (const table of SECTION_TABLES) defineOwn(ledger, table, {});
  return ledger;
}

/**
 * Exclusively create one complete conditional-admission SQLite store EXACTLY once, or refuse by
 * name. Never reads, adopts, repairs, truncates, overwrites or deletes any pre-existing state.
 *
 * @param {string} storeRoot absolute path whose PARENT already exists and is owned by the
 *        caller. Never defaulted, never $HOME. This directory itself must NOT exist: creating
 *        it is the claim, and a name that is already taken is refused, never adopted.
 * @param {{marker: object, initIntent: object, initialGeneration: number}} options
 * @returns {{ok: true, storeRoot: string, ledger: object}
 *          |{ok: false, reason: string, detail?: string, errno?: string, error?: Error}}
 *
 * Enumerated mappings, the complete list of what is CLAIMED:
 *   initIntent missing or malformed   -> experimental_init_intent_absent
 *   marker invalid or initialGeneration is not the number 0
 *                                     -> experimental_init_precondition_invalid
 *   claim throws EEXIST               -> experimental_store_root_exists + errno, three
 *                                        properties exactly, no detail and no error
 *   claim throws any other errno      -> experimental_store_root_unavailable + errno
 *   claim throws with no errno        -> experimental_store_root_unavailable / unclassified
 *   open, DDL or COMMIT throws        -> experimental_init_transaction_failed + error
 *   db.close() throws                 -> experimental_init_close_failed + error, never swallowed
 */
function initializeExperimentalSqliteStore(storeRoot, options) {
  const settings = options === undefined || options === null ? {} : options;
  const { marker, initIntent, initialGeneration } = settings;

  // Section 3: a POSITIVE caller precondition, validated BEFORE any filesystem call. Both
  // negative oracles in N0 observe that storeRoot does not exist afterwards, which is what
  // shows these two checks ran ahead of the claim.
  if (!validInitIntent(initIntent)) {
    return { ok: false, reason: "experimental_init_intent_absent" };
  }

  // Object.is rejects the string "0", -0, 1, -1, NaN and absence alike, so only the number 0
  // is accepted. The check reads the DECLARED input only.
  if (!Object.is(initialGeneration, REQUIRED_INITIAL_GENERATION) || !validConditionalMarker(marker)) {
    return { ok: false, reason: "experimental_init_precondition_invalid" };
  }

  // Section 2, the ONE mechanism: a single non-recursive directory create is the entire claim.
  // POSIX mkdir(2) and Windows CreateDirectory both fail when the name already exists, so the
  // claim is attempt-and-refuse and exactly one contender can return without throwing. The
  // recursive option is FORBIDDEN here - it succeeds on an existing directory and would
  // silently destroy the claim. path.join runs inside the same try so that a non-string
  // storeRoot is refused through this classifier instead of escaping to the caller.
  let dbPath;
  try {
    fs.mkdirSync(storeRoot);
    dbPath = path.join(storeRoot, DB_FILENAME);
  } catch (error) {
    const { errno, classification } = classifyClaimFailure(error);
    if (classification === "exists") {
      // Exactly three properties. No detail and no error: the contents behind the taken name
      // are deliberately NOT inspected, so no case may infer a different refusal reason from
      // whatever happens to be on disk. A crash leftover is refused here and changed by
      // nothing; recovery is a declared follow-on, never silent repair.
      return { ok: false, reason: "experimental_store_root_exists", errno: "EEXIST" };
    }
    if (classification === "unclassified") {
      return { ok: false, reason: "experimental_store_root_unavailable", detail: "unclassified" };
    }
    return { ok: false, reason: "experimental_store_root_unavailable", errno };
  }

  crashIfRequested("after_claim");

  // Creation inside the WON namespace. The directory was created by this process and is
  // provably empty, so no SQLite flag bears any exclusivity burden and the create-or-open
  // ambiguity carries no weight. This is the only Database construction in the runtime leaf.
  let db;
  try {
    db = new Database(dbPath);
  } catch (error) {
    // Nothing to close: the handle was never constructed.
    return { ok: false, reason: "experimental_init_transaction_failed", error };
  }

  crashIfRequested("after_open");

  let transactionError = null;
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(SCHEMA_SQL);
    const insertMeta = db.prepare(`INSERT INTO ${STORE_META_TABLE} (key, value) VALUES (?, ?)`);
    insertMeta.run("schema_version", SCHEMA_VERSION_TEXT);
    insertMeta.run("generation", INITIAL_GENERATION_TEXT);
    insertMeta.run("marker_id", marker.marker_id);
    insertMeta.run("initialized_at", marker.initialized_at);
    // Interrupting here leaves the database plus a hot -journal (default delete mode). The
    // slice never rolls that back, completes, replays or removes it.
    crashIfRequested("before_commit");
    db.exec("COMMIT");
    committed = true;
  } catch (error) {
    // No explicit ROLLBACK and no cleanup of any kind: closing the handle below discards the
    // open transaction, and this slice deletes nothing it or anyone else wrote.
    transactionError = error;
  }

  // The handle is closed exactly once, and a close failure is NEVER swallowed - that swallow is
  // precisely the P2 finally branch case X3 left unmeasured. The real close is attempted even
  // when the transaction already failed.
  let closeError = null;
  try {
    db.close();
  } catch (error) {
    closeError = error;
  }
  if (closeError === null && committed && syntheticCloseFaultRequested()) {
    closeError = syntheticCloseError();
  }

  // Preserve the ORIGINAL failure when the transaction and the close both fail: a later close
  // failure may not overwrite the earlier cause.
  if (transactionError !== null) {
    return { ok: false, reason: "experimental_init_transaction_failed", error: transactionError };
  }
  if (closeError !== null) {
    return { ok: false, reason: "experimental_init_close_failed", error: closeError };
  }

  return { ok: true, storeRoot, ledger: buildLedger(marker) };
}

module.exports = { initializeExperimentalSqliteStore, classifyClaimFailure };
