"use strict";

// P4 experimental TRANSACTIONAL WRITER with generation compare-and-swap, for an ALREADY
// INITIALIZED conditional-admission SQLite store.
//
// Contract: input/P4-CONTRACT.md. Section 9 (corrections R2) SUPERSEDES sections 0-8 wherever
// they contradict, and this file follows section 9 on every such point. The sx1170bn header the
// contract carries is inherited historical authoring identity, NOT this lane.
//
// ISOLATED EXPERIMENT ONLY. No product file imports this, no product reason code is added,
// changed, removed or mapped, no product marker, journal policy or Node floor is decided, and no
// dependency, daemon, live store or credential is touched. Every identifier beginning
// experimental_ below is a prototype-only string whose exposure to any caller needs explicit
// mapping and review later. D1, D2 and D3 are untouched and remain open.
//
// Deliberately absent from this runtime leaf (W9, R2-6b):
//   - neither the core filesystem module nor the core path module is required at all. The only
//     dependency is the pinned native binding, so this file issues no filesystem call of any kind
//     and no probe of any kind before the open. The single native open without
//     SQLITE_OPEN_CREATE is the whole mechanism.
//   - no directory creation, no removal, no shortening and no re-pointing of any name.
//   - no repair, adopt, migrate or JSON fallback path; no second connection; no compile-time
//     option is written, and the journal mode is left at the SQLite default.
//   - no import of the fixture module and no import of any product path.
//   - no error MESSAGE string is ever read or matched; only codes and observed values decide.
//
// R2-2 bounds the never-repair claim: it holds of the code paths in THIS file, which issue no
// repair step and contain no repair path. It does NOT hold of the process as a whole, because a
// read-write open can replay a hot rollback journal BEFORE any metadata, marker or generation
// check runs. Byte preservation across a refusal is therefore claimed only for the clean W5
// fixtures where the open itself fails and no handle is ever constructed.

const Database = require("better-sqlite3"); // pinned 13.0.3

// The owned namespace member this slice opens. Joined without the core path module (R2-6b): a
// forward slash is accepted by the Win32 path layer and by SQLite on all three runner OSes.
// storeRoot is always supplied by the caller, never defaulted and never $HOME, and is expected
// without a trailing separator.
const DB_FILENAME = "conditional-admissions.sqlite3";
const PATH_SEPARATOR = "/";

// P2-CONTRACT section 3 storage format. Section table names are module constants, NEVER taken
// from store data and NEVER taken from caller input: the caller names a section, and the text
// interpolated into the SQL is the module constant selected by that name.
const SECTION_TABLES = ["bindings", "admissions", "tombstones", "fenced_sessions"];

// store_meta row keys. Every one of these is used as a BOUND parameter, never interpolated.
const SCHEMA_VERSION_KEY = "schema_version";
const GENERATION_KEY = "generation";
const MARKER_ID_KEY = "marker_id";
const INITIALIZED_AT_KEY = "initialized_at";

// store_meta holds TEXT (P2-CONTRACT section 3).
const SCHEMA_VERSION_TEXT = "1";

// Canonical decimal digits only, the P2 guard reimplemented locally: it is what stops an empty,
// signed, space-padded, fractional or exponential generation from being coerced into an accepted
// integer. Range and safety are checked separately, exactly as P2 does.
const GENERATION_TEXT = /^[0-9]+$/;

// Byte-for-byte the product marker_id predicate (persistence.js validConditionalMarker),
// reimplemented locally and NEVER imported.
const MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const REASON_PRECONDITION_INVALID = "experimental_write_precondition_invalid";
const REASON_UNAVAILABLE = "experimental_store_unavailable";
const REASON_BUSY = "experimental_store_busy";
const REASON_MARKER_CHANGED = "experimental_store_marker_changed";
const REASON_GENERATION_CONFLICT = "experimental_store_generation_conflict";
const REASON_KEY_EXISTS = "experimental_store_key_exists";
const REASON_BUMP_FAILED = "experimental_store_bump_failed";
const REASON_TRANSACTION_FAILED = "experimental_write_transaction_failed";
const REASON_COMMIT_UNCERTAIN = "experimental_store_commit_uncertain";
const REASON_ROLLBACK_FAILED = "experimental_store_rollback_failed";
const REASON_CLOSE_FAILED = "experimental_store_close_failed";

// W3 / W7 seams. Closed sets of named points; nothing else in this file is interruptible.
const FAIL_POINTS = ["after_open", "after_cas_read", "after_row_insert", "before_commit"];
const CRASH_POINTS = ["after_cas_read", "after_row_insert", "before_commit"];

// The closed classification vocabulary of the contract: busy, conflict, constraint, unavailable,
// unclassified. PRIMARY codes only. An extended code a runner happens to produce is preserved
// verbatim and classified unclassified rather than folded into its primary (R2-5): this
// classifier never rewrites an unknown code into a known one, and never asserts an extended code
// a runner did not produce. Not every constraint failure is a duplicate key.
const CLASSIFICATION_BY_PRIMARY_CODE = {
  SQLITE_BUSY: "busy",
  SQLITE_LOCKED: "conflict",
  SQLITE_CONSTRAINT: "constraint",
  SQLITE_CANTOPEN: "unavailable",
  SQLITE_NOTADB: "unavailable",
  SQLITE_CORRUPT: "unavailable",
  SQLITE_ERROR: "unavailable",
};

// C7. Row keys are ARBITRARY STORE DATA. Plain assignment would, for the key __proto__, invoke
// the Object.prototype setter and mutate the prototype instead of storing the row. defineProperty
// on a {} literal stores it as an own enumerable property while keeping Object.prototype as the
// prototype, exactly as JSON.parse does for the legacy JSON store.
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  return target;
}

// Own-property read: meta.constructor must never fall through to Object.prototype when the store
// happens not to carry that row.
function ownValue(map, key) {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

// Every returned map is built this way (contract section 4). An entry whose value is undefined is
// OMITTED rather than defined as undefined. That is how the mutation RESULT object keeps the
// section 3 optional-key convention (detail?, sqliteCode?, errno?, error?) unchanged: an
// unobserved sqliteCode or errno stays an absent key THERE - a measured unknown per E1, never a
// failure and never an invented value. The classifyWriteFailure return shape is deliberately NOT
// optional in this way (R3-1 below).
function materialize(entries) {
  const result = {};
  for (const entry of entries) {
    if (entry[1] === undefined) continue;
    defineOwn(result, entry[0], entry[1]);
  }
  return result;
}

// R3-1 classifier-to-result boundary for sqliteCode, and the ONLY place a classifier null is
// re-read. The classifier always owns sqliteCode and errno and states a measured unknown as an
// explicit null; the mutation RESULT object keeps those keys OPTIONAL, which the passing W0, W5
// and W11 arms depend on. Mapping null back to undefined here lets materialize omit the key
// exactly as before, so result key presence stays the prior convention. Used for sqliteCode ONLY:
// err.code is read as a non-empty string or nothing at all, so a classifier sqliteCode null can
// only mean unobserved and the mapping is lossless there. No observed value is altered and no
// code or errno is invented.
function classifiedOptional(value) {
  return value === null ? undefined : value;
}

// errno carries no such guarantee: null is a legal OBSERVED errno value, indistinguishable in the
// classifier return from the unobserved null, so routing errno through classifiedOptional would
// ERASE an observed literal null that the prior RESULT convention kept present. The RESULT errno
// is therefore derived from the ORIGINAL thrown value, with the baseline expression verbatim: an
// observed errno is preserved verbatim INCLUDING null, and only absent/undefined stays an omitted
// key via materialize. Nothing is asserted about what the real binding can or cannot report.
function observedErrno(err) {
  return err && err.errno !== undefined ? err.errno : undefined;
}

/**
 * Classify a thrown write failure. Codes and observed values only; no message is ever read.
 *
 * R3-1 FIXED RETURN SHAPE: sqliteCode, errno and classification are ALWAYS own keys of the
 * returned object. A value that was not observed is an EXPLICIT null - the section 8 reading that
 * an explicit unknown is acceptable and a silent omission is not - never an absent key. An
 * observed value is preserved VERBATIM, primary or extended, exactly as err.code reported it; an
 * unmapped or absent code stays unclassified. Nothing is fabricated and no message is consulted.
 *
 * This is a REPRESENTATION correction only. Reason selection, commit accounting, retry safety and
 * cleanup ordering are untouched, and the mutation RESULT object keeps its optional keys optional
 * at the single boundary above - sqliteCode via classifiedOptional, errno via observedErrno.
 *
 * @param {*} err the thrown value.
 * @returns {{sqliteCode: string|null, errno: *, classification: string}}
 *          classification is one of busy, conflict, constraint, unavailable, unclassified.
 */
function classifyWriteFailure(err) {
  const rawCode = err && typeof err.code === "string" && err.code !== "" ? err.code : null;
  const errno = err && err.errno !== undefined ? err.errno : null;
  const classification = rawCode !== null && Object.hasOwn(CLASSIFICATION_BY_PRIMARY_CODE, rawCode)
    ? CLASSIFICATION_BY_PRIMARY_CODE[rawCode]
    : "unclassified";
  return materialize([["sqliteCode", rawCode], ["errno", errno], ["classification", classification]]);
}

// Synthetic, clearly labelled, FAILURE-ONLY seams (R2-7). Each is inert when unset, can only ADD
// a failure, and can never suppress, mask or alter any other outcome. None of them is a measured
// native fault: native rollback and close failure behaviour is UNMEASURED and is not claimed.
// Every induced error carries synthetic:true so no evidence record can read it as native.
function syntheticError(message) {
  const error = new Error(message);
  error.synthetic = true;
  return error;
}

function failIfRequested(point) {
  if (!FAIL_POINTS.includes(point)) return;
  if (process.env.P4_FAIL_AT !== point) return;
  throw syntheticError(`synthetic failure seam P4_FAIL_AT=${point} - not a measured native failure`);
}

// W7. Deterministic mid-transaction termination for leftover CLASSIFICATION only. This is PROCESS
// TERMINATION, never power-loss evidence: nothing is flushed and no durability claim is made. It
// signals exactly this process id - no process scan, no signal to any other process, no global
// kill. A killed process returns nothing at all, so no reason code, committed or retrySafe field
// exists for it (R2-2); the parent records an unknown outcome and MUST NOT synthesize one.
function crashIfRequested(point) {
  if (!CRASH_POINTS.includes(point)) return;
  if (process.env.P4_CRASH_AT === point) process.kill(process.pid, "SIGKILL");
}

// W10c. Fires immediately before the commit step is executed, and the commit phase is entered
// CONSERVATIVELY beforehand: commitAttempted is recorded true and the outcome unknown, even
// though the synthetic throw means the real commit never ran. Counting it any other way would
// under-report uncertainty, which R2-1 forbids.
function commitFaultIfRequested() {
  if (process.env.P4_COMMIT_FAULT !== "busy") return;
  const error = syntheticError(
    "synthetic commit fault induced by P4_COMMIT_FAULT=busy - not a measured native failure",
  );
  error.code = "SQLITE_BUSY";
  throw error;
}

// A named refusal raised from inside the transaction body so that one cleanup path serves every
// outcome. Module-private: never exported, and never escapes to the caller.
class WriteRefusal extends Error {
  constructor(payload) {
    super("experimental write refusal");
    this.payload = payload;
  }
}

function refuse(payload) {
  return new WriteRefusal(payload);
}

// Native read failures inside the preflight map to the P2 detail vocabulary. SQLITE_BUSY and
// anything else keep their own mapping and are rethrown untouched, so a busy preflight is never
// mis-reported as an unusable store.
function shapeRefusalOrRethrow(error) {
  const classified = classifyWriteFailure(error);
  if (classified.sqliteCode === "SQLITE_ERROR") {
    return refuse({
      reason: REASON_UNAVAILABLE,
      detail: "invalid_store_shape",
      sqliteCode: classifiedOptional(classified.sqliteCode),
      errno: observedErrno(error),
      retrySafeMax: true,
    });
  }
  if (classified.sqliteCode === "SQLITE_NOTADB" || classified.sqliteCode === "SQLITE_CORRUPT") {
    return refuse({
      reason: REASON_UNAVAILABLE,
      detail: "unparseable",
      sqliteCode: classifiedOptional(classified.sqliteCode),
      errno: observedErrno(error),
      retrySafeMax: true,
    });
  }
  return error;
}

function decodeGeneration(text) {
  if (typeof text !== "string" || !GENERATION_TEXT.test(text)) return null;
  const generation = Number(text);
  // Number.isSafeInteger also rejects a digit string above 2^53-1, which Number() would have
  // rounded into a finite integer.
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return generation;
}

// The product predicate SHAPE at persistence.js L384-392, reimplemented locally and NEVER
// imported: exactly 2 keys, a lowercase uuid-v4 marker_id, and an initialized_at that survives a
// canonical toISOString round trip.
function validConditionalMarker(marker) {
  return Boolean(marker) && typeof marker === "object" && !Array.isArray(marker)
    && Object.keys(marker).length === 2
    && typeof marker.marker_id === "string"
    && MARKER_ID.test(marker.marker_id)
    && typeof marker.initialized_at === "string"
    && Number.isFinite(Date.parse(marker.initialized_at))
    && new Date(marker.initialized_at).toISOString() === marker.initialized_at;
}

function preconditionFailure(detail) {
  return materialize([
    ["ok", false],
    ["reason", REASON_PRECONDITION_INVALID],
    ["detail", detail],
    ["commitAttempted", false],
    ["committed", false],
    ["retrySafe", true],
  ]);
}

// R2-3 step 1. store_meta values are TEXT and are NOT JSON, so they are read raw.
function readMetaRows(db) {
  let rows;
  try {
    rows = db.prepare(`SELECT key, value FROM store_meta ORDER BY key`).all();
  } catch (error) {
    throw shapeRefusalOrRethrow(error);
  }
  const meta = {};
  for (const row of rows) defineOwn(meta, row.key, row.value);
  return meta;
}

// R2-3 step 2. EVERY row value of EVERY section is parsed, including sections the mutation does
// not target: the independent P2 verifier refuses such a store, so this slice must not write into
// one. No section is skipped or silently bypassed. Declared experiment-only cost: this reads every
// section row inside the write transaction. No scaling, latency or lock-hold-time claim is made,
// and none may be inferred.
function readSectionRows(db, table) {
  let rows;
  try {
    rows = db.prepare(`SELECT key, value FROM ${table} ORDER BY key`).all();
  } catch (error) {
    throw shapeRefusalOrRethrow(error);
  }
  for (const row of rows) {
    try {
      JSON.parse(row.value);
    } catch {
      throw refuse({ reason: REASON_UNAVAILABLE, detail: "invalid_store_shape", retrySafeMax: true });
    }
  }
}

function cleanupErrorMap(rollbackError, closeError) {
  if (rollbackError === null && closeError === null) return undefined;
  return materialize([
    ["rollback", rollbackError === null ? undefined : rollbackError],
    ["close", closeError === null ? undefined : closeError],
  ]);
}

/**
 * Apply EXACTLY ONE section row together with its generation bump, inside ONE transaction or not
 * at all. Never creates, recreates, adopts, repairs, shortens or removes anything, never falls
 * back to JSON, never retries, and reports an uncertain commit AS uncertain rather than as
 * success or as a safe retry.
 *
 * @param {string} storeRoot absolute path of an ALREADY INITIALIZED store directory, supplied by
 *        the caller. Never defaulted, never $HOME.
 * @param {{marker: object, expectedGeneration: number, mutation: object, requestId: string}} options
 *        marker is the exact current marker; expectedGeneration is REQUIRED, read from the
 *        declared input only and never inferred, discovered or defaulted from disk; mutation is
 *        { section, key, value }; requestId is a non-empty string recorded in evidence only and
 *        deliberately never written to the store - deduplication is the generation CAS, not a
 *        request log.
 * @returns {{ok: true, generation: number, section: string, key: string, requestId: string,
 *            commitAttempted: true, committed: true}
 *          |{ok: false, reason: string, detail?: string, sqliteCode?: string, errno?: *,
 *            error?: Error, cleanupError?: object, commitAttempted: boolean,
 *            committed: true|false|null, retrySafe: boolean}}
 *
 * retrySafe is PHASE-AWARE (R2-1) and is returned true only when all three hold, each established
 * positively rather than assumed: (a) the commit was never issued, so commitAttempted false and
 * committed false are facts; (b) the transaction is known to have ended, because the immediate
 * begin never returned or the explicit rollback returned without throwing; (c) cleanup settled,
 * because close returned without throwing or no handle was ever constructed. committed and
 * retrySafe are independent, and an established committed value is never overwritten.
 */
function applyExperimentalStoreMutation(storeRoot, options) {
  const settings = options === undefined || options === null ? {} : options;
  const { marker, expectedGeneration, mutation, requestId } = settings;

  // ---------------------------------------------------------------------------------------
  // Precondition block. R2-6b: the WHOLE of it textually precedes the single handle
  // construction below, and it issues no filesystem and no SQLite call. Byte identity across a
  // refusal is a weak observation that proves no modification, NOT zero calls and NOT ordering;
  // ordering is claimed from this source order and the W9 grep oracle alone.
  // ---------------------------------------------------------------------------------------
  if (!validConditionalMarker(marker)) return preconditionFailure("marker_invalid");

  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
    return preconditionFailure("expected_generation_invalid");
  }
  // R2-4. MAX_SAFE_INTEGER satisfies the v1 rule yet cannot be incremented safely, so both the
  // stored value and the post-condition would compare rounded numbers. At most MAX_SAFE_INTEGER
  // minus one is accepted.
  if (!Number.isSafeInteger(expectedGeneration + 1)) {
    return preconditionFailure("generation_not_incrementable");
  }

  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
    return preconditionFailure("mutation_invalid");
  }
  const sectionIndex = SECTION_TABLES.indexOf(mutation.section);
  if (sectionIndex === -1) return preconditionFailure("mutation_invalid");
  if (typeof mutation.key !== "string" || mutation.key === "") {
    return preconditionFailure("mutation_invalid");
  }
  if (!Object.hasOwn(mutation, "value")) return preconditionFailure("mutation_invalid");

  // R2-4: a POSITIVE precondition, not merely an evidence field.
  if (typeof requestId !== "string" || requestId === "") {
    return preconditionFailure("request_id_invalid");
  }

  // R2-4: serialization happens HERE, once, before any filesystem or SQLite call, and THIS exact
  // string is the bound parameter written below - there is no second JSON.stringify, so what was
  // validated is what is written. A cyclic value, a throwing toJSON or a BigInt throws; a
  // top-level undefined, function or symbol yields undefined. Lossy round trips (NaN and Infinity
  // to null, Date to text, a rewriting toJSON) are recorded as measured prototype behaviour and
  // propose no new product-side value validation.
  let serializedValue;
  try {
    serializedValue = JSON.stringify(mutation.value);
  } catch {
    return preconditionFailure("value_not_serializable");
  }
  if (typeof serializedValue !== "string") return preconditionFailure("value_not_serializable");

  // The interpolated table text is the module constant selected by the caller name, never the
  // caller value itself.
  const sectionTable = SECTION_TABLES[sectionIndex];
  const mutationKey = mutation.key;
  const nextGeneration = expectedGeneration + 1;
  const nextGenerationText = String(nextGeneration);
  const dbPath = `${storeRoot}${PATH_SEPARATOR}${DB_FILENAME}`;

  // fileMustExist maps to SQLITE_OPEN_READWRITE WITHOUT SQLITE_OPEN_CREATE, which is how creation
  // of the main database file is structurally impossible here. R2-6b bounds that: it does not
  // prevent journal creation or journal playback on an existing store, and it is not a
  // hostile-path, symlink, path-identity or TOCTOU safety property. timeout 0 means BUSY is
  // MEASURED rather than waited out; a nonzero value would turn the concurrency measurement into
  // a hidden wait.
  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
  } catch (error) {
    // Nothing to close: the handle was never constructed. This is never a not-initialized verdict
    // and never an initialize decision (P2-CORRECTIONS C1): a name that is not there is never
    // read as absence.
    const classified = classifyWriteFailure(error);
    return materialize([
      ["ok", false],
      ["reason", REASON_UNAVAILABLE],
      ["sqliteCode", classifiedOptional(classified.sqliteCode)],
      ["errno", observedErrno(error)],
      ["commitAttempted", false],
      ["committed", false],
      ["retrySafe", true],
    ]);
  }

  let beginReturned = false;
  let commitAttempted = false;
  let committed = false;
  let committedGeneration = null;
  let originalError = null;
  let failure = null;

  try {
    failIfRequested("after_open");

    // The RESERVED lock is taken at once, so a second writer observes BUSY at a NAMED point
    // instead of failing on a later lock upgrade. Everything below runs on this one handle while
    // it holds that lock: there is no pre-open probe, no second connection and no separate race
    // window.
    db.exec(`BEGIN IMMEDIATE`);
    beginReturned = true;

    // R2-3 step 1.
    const meta = readMetaRows(db);

    const schemaVersionText = ownValue(meta, SCHEMA_VERSION_KEY);
    if (schemaVersionText !== SCHEMA_VERSION_TEXT) {
      throw refuse({
        reason: REASON_UNAVAILABLE,
        detail: `schema_version=${schemaVersionText}`,
        retrySafeMax: true,
      });
    }

    const observedGeneration = decodeGeneration(ownValue(meta, GENERATION_KEY));
    if (observedGeneration === null) {
      throw refuse({ reason: REASON_UNAVAILABLE, detail: "invalid_store_shape", retrySafeMax: true });
    }

    // R2-3 requires both marker rows to be PRESENT as part of the shape check. An absent row is a
    // shape refusal; a present row that fails the predicate, or differs from the supplied marker,
    // is a marker refusal below.
    const storedMarkerId = ownValue(meta, MARKER_ID_KEY);
    const storedInitializedAt = ownValue(meta, INITIALIZED_AT_KEY);
    if (typeof storedMarkerId !== "string" || typeof storedInitializedAt !== "string") {
      throw refuse({ reason: REASON_UNAVAILABLE, detail: "invalid_store_shape", retrySafeMax: true });
    }

    // R2-3 step 2, fixed order, all four sections, every row value parsed.
    for (const table of SECTION_TABLES) readSectionRows(db, table);

    // Marker CAS. Mirrors the product check at persistence.js L397-401 in SHAPE only: both
    // marker_id and initialized_at must match the supplied marker.
    const storedMarker = materialize([
      ["marker_id", storedMarkerId],
      ["initialized_at", storedInitializedAt],
    ]);
    if (!validConditionalMarker(storedMarker)
      || storedMarker.marker_id !== marker.marker_id
      || storedMarker.initialized_at !== marker.initialized_at) {
      throw refuse({ reason: REASON_MARKER_CHANGED, retrySafeMax: false });
    }

    // Generation CAS. This is the deduplication: a replayed identical call finds the generation
    // moved and refuses here. The product performs NO compare-and-swap, so this is STRICTER than
    // the product and is not a reproduction of it; whether the product adopts it is an adoption
    // decision and is not settled here.
    if (observedGeneration !== expectedGeneration) {
      throw refuse({
        reason: REASON_GENERATION_CONFLICT,
        detail: `observed=${observedGeneration},expected=${expectedGeneration}`,
        retrySafeMax: false,
      });
    }

    failIfRequested("after_cas_read");
    crashIfRequested("after_cas_read");

    // R2-5. Key-exists is established POSITIVELY by query on the handle already holding the
    // RESERVED lock, which makes it race-free without any pre-open probe or second connection.
    // No extended result code is asserted: P2 captured none on any runner.
    const duplicate = db.prepare(`SELECT 1 FROM ${sectionTable} WHERE key = ? LIMIT 1`).get(mutationKey);
    if (duplicate !== undefined) {
      throw refuse({ reason: REASON_KEY_EXISTS, detail: "detected_by_query", retrySafeMax: false });
    }

    // A plain insert, so a replay can never overwrite. Both the key and the exact serialized value
    // validated above are bound.
    db.prepare(`INSERT INTO ${sectionTable} (key, value) VALUES (?, ?)`).run(mutationKey, serializedValue);

    failIfRequested("after_row_insert");
    crashIfRequested("after_row_insert");

    // The generation key is BOUND from a module constant. Double quotes are identifier quoting in
    // SQLite and the fallback to a text literal is a build-configurable legacy behaviour, not a
    // measured property of the pinned binding, so no key comparison is ever written that way.
    const bump = db.prepare(`UPDATE store_meta SET value = ? WHERE key = ?`).run(nextGenerationText, GENERATION_KEY);
    if (bump.changes !== 1) {
      throw refuse({
        reason: REASON_BUMP_FAILED,
        detail: `changes=${bump.changes}`,
        retrySafeMax: false,
      });
    }

    // The row and the bump share this one transaction, so neither can land alone.
    failIfRequested("before_commit");
    crashIfRequested("before_commit");

    commitAttempted = true;
    commitFaultIfRequested();
    db.exec(`COMMIT`);
    committed = true;
    committedGeneration = nextGeneration;
  } catch (error) {
    if (error instanceof WriteRefusal) {
      failure = error.payload;
    } else {
      originalError = error;
      const classified = classifyWriteFailure(error);
      if (commitAttempted && !committed) {
        // R2-1: a commit-phase throw DOMINATES classification, whatever err.code reports,
        // INCLUDING a BUSY code. The busy row of the contract covers the immediate begin and
        // pre-commit steps only and never captures a commit-phase BUSY.
        failure = {
          reason: REASON_COMMIT_UNCERTAIN,
          sqliteCode: classifiedOptional(classified.sqliteCode),
          errno: observedErrno(error),
          retrySafeMax: false,
        };
      } else if (classified.classification === "busy") {
        failure = {
          reason: REASON_BUSY,
          sqliteCode: classifiedOptional(classified.sqliteCode),
          errno: observedErrno(error),
          retrySafeMax: true,
        };
      } else {
        failure = {
          reason: REASON_TRANSACTION_FAILED,
          sqliteCode: classifiedOptional(classified.sqliteCode),
          errno: observedErrno(error),
          retrySafeMax: true,
        };
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Cleanup. R2-7: rollback then close, in that order, each in its own guard, and a FAILED
  // ROLLBACK NEVER SKIPS THE CLOSE. The real step is always attempted first and a real failure
  // wins; a synthetic seam can only ADD a failure on top of a real step that returned.
  //
  // The explicit rollback is issued on EVERY in-transaction failure, the commit phase included,
  // whenever the immediate begin returned and the commit did not return successfully. A
  // commit-phase failure is an in-transaction failure like any other, so it takes the same
  // rollback-then-close cleanup, and a failed rollback still never skips the close.
  //
  // Cleanup NEVER touches the established commit facts. On a commit-phase failure the outcome
  // stays commitAttempted true, committed null and retrySafe false, and the reported reason stays
  // experimental_store_commit_uncertain no matter what the rollback or the close then does: a
  // cleanup verdict may never overwrite an uncertain commit. Whatever the rollback reports here
  // is EVIDENCE ABOUT CLEANUP recorded in cleanupError.rollback, and is never read as proof that
  // the commit did or did not land - that remains unknown, and unknown is what is reported.
  // ---------------------------------------------------------------------------------------
  let rollbackAttempted = false;
  let rollbackError = null;
  let closeError = null;

  if (beginReturned && !committed) {
    rollbackAttempted = true;
    try {
      db.exec(`ROLLBACK`);
    } catch (error) {
      rollbackError = error;
    }
    if (rollbackError === null && process.env.P4_ROLLBACK_FAULT === "1") {
      rollbackError = syntheticError(
        "synthetic rollback fault induced by P4_ROLLBACK_FAULT - not a measured native failure",
      );
    }
  }

  try {
    db.close();
  } catch (error) {
    closeError = error;
  }
  if (closeError === null && process.env.P4_CLOSE_FAULT === "1") {
    closeError = syntheticError(
      "synthetic close fault induced by P4_CLOSE_FAULT - not a measured native failure",
    );
  }

  // R2-1 (a), (b) and (c), each established positively.
  const nonCommitEstablished = !commitAttempted && !committed;
  const transactionEnded = !beginReturned || (rollbackAttempted && rollbackError === null);
  const cleanupSettled = closeError === null;
  const retrySafeAllowed = nonCommitEstablished && transactionEnded && cleanupSettled;

  if (committed) {
    // A post-success close failure PRESERVES the commit: committed true is never downgraded to
    // false or null by a later cleanup failure, and the close failure is never swallowed and
    // never reported as ok:true.
    if (closeError !== null) {
      return materialize([
        ["ok", false],
        ["reason", REASON_CLOSE_FAILED],
        ["cleanupError", cleanupErrorMap(rollbackError, closeError)],
        ["commitAttempted", true],
        ["committed", true],
        ["retrySafe", false],
      ]);
    }
    // ok:true only after the commit returned without throwing AND close returned without
    // throwing, with generation exactly one above the expected generation.
    return materialize([
      ["ok", true],
      ["generation", committedGeneration],
      ["section", sectionTable],
      ["key", mutationKey],
      ["requestId", requestId],
      ["commitAttempted", true],
      ["committed", true],
    ]);
  }

  // A cleanup failure relabels the reported reason, but commit uncertainty is never overwritten by
  // one: that established fact outranks every cleanup verdict. Whatever the reported reason, the
  // original cause stays in error and the cleanup causes stay in cleanupError, all distinct and
  // none overwriting another.
  let reason = failure.reason;
  if (reason !== REASON_COMMIT_UNCERTAIN) {
    if (rollbackError !== null) reason = REASON_ROLLBACK_FAILED;
    else if (closeError !== null) reason = REASON_CLOSE_FAILED;
  }

  return materialize([
    ["ok", false],
    ["reason", reason],
    ["detail", failure.detail],
    ["sqliteCode", failure.sqliteCode],
    ["errno", failure.errno],
    ["error", originalError === null ? undefined : originalError],
    ["cleanupError", cleanupErrorMap(rollbackError, closeError)],
    ["commitAttempted", commitAttempted],
    ["committed", commitAttempted ? null : false],
    ["retrySafe", failure.retrySafeMax === true && retrySafeAllowed],
  ]);
}

// Exports exactly the two functions the contract names. The section table list, the reason
// strings and the seam names stay module-private on purpose, so the tester writes every expected
// literal independently and a green oracle cannot mean self-agreement.
module.exports = { applyExperimentalStoreMutation, classifyWriteFailure };
