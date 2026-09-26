"use strict";

// P4 TESTER LANE - every section-5 oracle plus the R2 corrections, authored from
// input/P4-CONTRACT.md prose ONLY (sha256 2eb2b359ae7271d220a86906e698e2f868d7193fde09c303ef66f8d767797ef2).
// Section 9 (R2) supersedes sections 0-8 wherever they contradict, and this suite follows R2.
//
// Independence rules this file obeys, so that a green run cannot mean self-agreement:
//   - EVERY expected literal (reason codes, ledger keys, table names, db filename, detail
//     strings, tuple values) is authored HERE from the contract prose. Nothing expected is
//     imported from write-cas.cjs, states.cjs or write-child.cjs.
//   - The independent verifier is the mechanically copied, byte-identity-verified P2 opener
//     p2-open-existing.cjs. Store state is re-read through it, never through the slice.
//   - A failing oracle is REPORTED, never patched around. There is no skip, no continue-on-error,
//     no retry and no masking anywhere in this file.
//
// Scope this file does NOT claim: power loss or durability (process termination is not power
// loss), fsync equivalence with the product writer, WAL, backup/restore/recovery beyond recording
// what SQLite itself does on reopen, migration, ACL/DACL/confinement/hostile paths, TOCTOU,
// case-alias or path-identity behaviour, multi-host locking, product adoption, product reason-code
// mapping (D1), journal policy (D2) or a product Node floor (D3). Native rollback and close
// failure behaviour is UNMEASURED: P4_ROLLBACK_FAULT, P4_CLOSE_FAULT, P4_COMMIT_FAULT and
// P4_FAIL_AT are tester-injected SYNTHETIC seams, inert when unset, that can only ADD a failure.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const { builtinModules } = require("node:module");

const Database = require("better-sqlite3"); // pinned 13.0.3, used for P0 probes and FIXTURES only

// The slice under test (coder lane) and its declared fixture writer (coder lane).
const { applyExperimentalStoreMutation, classifyWriteFailure } = require("./write-cas.cjs");
const { createState } = require("./states.cjs");

// The INDEPENDENT verifier: the unmodified P2 opener, copied in byte-identically by the builder.
const { loadConditionalAdmissionsSqlite } = require("./p2-open-existing.cjs");

// Tester-lane W7 recovery observer (R2-2). Open + close only; never a repair.
const { observeRecoveryOpen } = require("./recovery-observe.cjs");

// --- environment -------------------------------------------------------------------------------

function envOrNull(name) {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}

// P4_WORK_DIR is an EXISTING owned root supplied by the builder. When absent we create our own
// root under os.tmpdir() rather than writing anywhere near the source tree or $HOME.
const WORK_DIR_FROM_ENV = envOrNull("P4_WORK_DIR");
const WORK_DIR = WORK_DIR_FROM_ENV || fs.mkdtempSync(path.join(os.tmpdir(), "p4-work-"));
const EVIDENCE_DIR = envOrNull("P4_EVIDENCE_DIR");
const FORCE_FAIL = envOrNull("P4_FORCE_FAIL");

const SLICE_DIR = __dirname;
const WRITE_CAS_SOURCE = path.join(SLICE_DIR, "write-cas.cjs");
const STATES_SOURCE = path.join(SLICE_DIR, "states.cjs");
const WRITE_CHILD_SOURCE = path.join(SLICE_DIR, "write-child.cjs");
const RECOVERY_OBSERVE_SOURCE = path.join(SLICE_DIR, "recovery-observe.cjs");
// W6-R, additive: the tester-lane controlled lock-holding peer. It is a PEER, never the slice - W9
// asserts below that it is unreachable from both runtime leaves and that it modifies nothing.
const LOCK_HOLD_CHILD_SOURCE = path.join(SLICE_DIR, "lock-hold-child.cjs");
const P2_OPENER_COPY = path.join(SLICE_DIR, "p2-open-existing.cjs");
const P3_INITIALIZER_COPY = path.join(SLICE_DIR, "p3-init-exclusive.cjs");

// The complete set of case ids this suite is expected to execute. T compares this against the ids
// ACTUALLY recorded during the run; it is never a hardcoded pass total. T itself is a TAP test
// that records NO case id, so the TAP test count is one higher than executedCaseCount - exactly
// the distinction P3 kept between its 18 TAP tests and its 17 recorded case ids.
// W7x is a SEPARATE case id, never a replacement for W7: the two arms assert opposite things about
// killRequested, so they could not share a case even if the storage observations coincide.
// W6-R is likewise a SEPARATE case id, never a replacement for W6 and never a relaxation of it: W6
// keeps its 20 x 8 race, its exactly-one-winner oracle and its closed loser vocabulary exactly as
// written, red or green, and W6-R adds a deterministic one-writer-one-peer observation beside it.
const EXPECTED_CASE_IDS = [
  "P0",
  "W0", "W1", "W2", "W3", "W4", "W5", "W6", "W6-R", "W7", "W7x", "W8", "W9", "W10", "W11", "W12",
  "E1",
].sort();

const evidence = {
  schema: "st1170bq-p4-write-evidence/1",
  contract: {
    file: "input/P4-CONTRACT.md",
    sha256: "2eb2b359ae7271d220a86906e698e2f868d7193fde09c303ef66f8d767797ef2",
    governing: "section 9 (R2) supersedes sections 0-8 on every contradictory phrase",
  },
  gitHead: envOrNull("P4_GIT_HEAD"),
  ci: {
    detected: envOrNull("CI") !== null || envOrNull("GITHUB_ACTIONS") !== null,
    repository: envOrNull("GITHUB_REPOSITORY"),
    workflow: envOrNull("GITHUB_WORKFLOW"),
    runId: envOrNull("GITHUB_RUN_ID"),
    runNumber: envOrNull("GITHUB_RUN_NUMBER"),
    runAttempt: envOrNull("GITHUB_RUN_ATTEMPT"),
    job: envOrNull("GITHUB_JOB"),
    eventName: envOrNull("GITHUB_EVENT_NAME"),
    // For pull_request events GITHUB_SHA is the synthetic merge commit, so it is recorded as an
    // observation and is not treated as the head under test.
    githubSha: envOrNull("GITHUB_SHA"),
  },
  runtime: {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    // Recorded because the W5 denied-path arm depends on a non-privileged euid to mean anything.
    euid: typeof process.geteuid === "function" ? process.geteuid() : null,
  },
  workDirFromEnv: WORK_DIR_FROM_ENV !== null,
  workDir: WORK_DIR,
  evidenceDirFromEnv: EVIDENCE_DIR,
  forceFailHook: FORCE_FAIL,
  frozenInputs: {},
  cases: {},
  errorVocabulary: [],
  // v6: SECONDARY cleanup-body failures. v5 caught a throw out of a cleanup body so the original
  // try-body error kept its identity, but it only stored that failure in a function-local which the
  // escaping error then stepped over: the latch and the assertion that read the local never ran, so
  // on the both-throw path the cleanup fault was recorded inside the construct and reported nowhere.
  // This list is appended from inside the SAME guaranteed inner finally that takes the preservation
  // decision, so it is reached on every path - normal return, try-body throw, cleanup-body throw -
  // and the finaliser serialises it with the rest of this object. It carries the existing
  // observationFailure representation verbatim, bound to the case, the iteration/seam and the exact
  // owned root. It is EVIDENCE, not a verdict: nothing branches on it, the primary error still
  // propagates with its identity intact, and the cleanup-only path still FAILS hard at its own
  // assert.equal(cleanupFailure, null) below. In-memory recording serialised at exit is NOT a
  // disk-durability claim.
  cleanupFailures: [],
  children: { spawned: 0, reaped: 0, records: [] },
  notes: [
    "Experimental prototype evidence only. No product adoption, no product reason-code mapping, "
    + "no journal-policy decision, no Node-floor decision and no dependency adoption is claimed.",
    "P4_FAIL_AT, P4_ROLLBACK_FAULT, P4_CLOSE_FAULT and P4_COMMIT_FAULT are SYNTHETIC tester-injected "
    + "seams, inert unset, that can only ADD a failure. Native rollback, close and COMMIT-busy "
    + "failure behaviour is UNMEASURED and is not claimed by W8, W10 or E1.",
    "W7 measures PROCESS TERMINATION, never power loss. No fsync or durability claim is made.",
    "W7 attributes by CONJUNCTION at each seam - bound seam marker present, bound exit-hook "
    + "sentinel ABSENT in the self-kill arm, a same-run same-seam ordinary-exit CONTROL whose own "
    + "bound sentinel is PRESENT, no returned result, no parent-authored signal, recorded source "
    + "identity, and the independent opener reporting the original generation with zero new rows. "
    + "The raw (exitCode, signal) pair is RECORDED and checked for REPRESENTATION only: on win32 a "
    + "self-delivered SIGKILL reports (1, null), byte-for-byte what an ordinary exit(1) reports, "
    + "so the pair may NEVER be a passing attribution predicate there. POSIX kernel-attested "
    + "signal evidence is preserved and asserted explicitly. The conjunction establishes that the "
    + "seam was reached and no JS exit path then ran; it does NOT establish which API killed the "
    + "process, and excluding reallyExit, a native fault or an external agent rests on pinned "
    + "SOURCE IDENTITY plus W9 - an inference, never OS or cryptographic attestation.",
    "W7's marker and control seams and the child's exit witness are INERT WHEN UNSET: with no "
    + "seam named, no listener is registered, no module is loaded, no descriptor is touched, no "
    + "signal is sent and no ordinary exit is taken anywhere in the unseamed runtime.",
    "UNMEASURED and named rather than omitted: Node runs NATIVE AtExit callbacks on the self-kill "
    + "path on all three platforms and does not emit JS 'exit' there, and whether better-sqlite3 "
    + "13.0.3 registers an AtExit callback that could close or finalize an open database is "
    + "outside what this lane measured. It bounds the word 'abrupt' equally on all three OSes.",
    "R2-2: byte identity across a refusal is asserted ONLY for the clean W5 fixtures (a)-(e), where "
    + "the open itself fails and no handle is ever constructed. For refusals raised AFTER the open "
    + "(W2, W4, W11, W12) the before/after sha256 is RECORDED as an observation and deliberately "
    + "NOT asserted, because a read-write open may replay a hot rollback journal before any "
    + "validation runs.",
    "R2-6: byte identity is not a zero-call proof and proves no access ordering. Ordering is "
    + "claimed from the W9 structural source-order oracle alone.",
    "W6-R is ADDITIVE instrumentation and is the ONE place in this suite where commit-phase "
    + "contention is met NATIVELY, with no seam set: its arms are labelled native (synthetic:false) "
    + "and its cause-side scalars come from a real thrown value, never from an induced one. It "
    + "changes nothing about W6, and it does not extend the W8, W10 or E1 scope note above - native "
    + "ROLLBACK and native close FAILURE behaviour stays UNMEASURED, because W6-R measures a clean "
    + "rollback and a clean close, not a failing one. W6-R is ONE DISCRIMINATING OBSERVATION: it is "
    + "not proof that the same lock holder caused any earlier W6 outcome, and a successful commit "
    + "after a release does not uniquely establish release latency. No lock-hold DURATION is "
    + "measured or claimed anywhere.",
  ],
};

// P4_FORCE_FAIL may only ADD a bounded intentional failure. It is invoked at the END of a case,
// after that case evidence has been recorded, so it can never convert a real pass into a silent
// skip, and can never suppress a real failure.
function maybeForceFail(caseId) {
  if (FORCE_FAIL === caseId) {
    assert.fail(
      "P4_FORCE_FAIL=" + caseId + ": deliberate bounded failure injected to demonstrate that "
      + "temp-root cleanup and evidence persistence survive a failing assertion without altering "
      + "the exit code",
    );
  }
}

// --- owned temp roots ---------------------------------------------------------------------------

// Every root this suite creates lives under WORK_DIR with this prefix, so the builder G3 gate can
// find residue with one filter. The prefix is recorded in the cleanup evidence.
const TMP_PREFIX = "tmp-";
const createdRoots = [];
// POSIX modes this suite deliberately restricted (W5e). Restored before removal, for OWNED fixture
// directories under WORK_DIR only - never a privileged operation, never anything outside WORK_DIR.
const modesToRestore = [];
// Exact child handles this suite owns. The finaliser kills these handles only; no global process
// scan and no global kill is ever performed.
const liveChildren = new Set();

// --- owned-root preservation (v3) ----------------------------------------------------------------

// v2 said an unjoined W7x arm "preserved" its store, but finalize() then removed EVERY createdRoot
// unconditionally - so the preserved store was deleted moments later and the claim was false. The
// decision below is the SINGLE place that answers "may this owned root be cleaned up?", and the
// finaliser consults exactly this map. Controls exercise these same functions rather than a
// duplicated hardcoded rule, so a control passing means the real finalisation path is the one that
// was proven.
const preservedRoots = new Map();

// PURE. exited is the OBSERVED exit of the exact owned handle - never inferred, never assumed.
function preservationDecision(entry) {
  if (entry.exited === true) return { preserve: false, because: null };
  return { preserve: true, because: entry.because === undefined ? "child_not_joined" : entry.because };
}

function registerRootPreservation(entry) {
  const decision = preservationDecision(entry);
  if (decision.preserve) {
    preservedRoots.set(entry.root, {
      root: entry.root,
      caseId: entry.caseId,
      seam: entry.seam === undefined ? null : entry.seam,
      pid: entry.pid === undefined ? null : entry.pid,
      because: decision.because,
    });
  }
  return decision;
}

// The one predicate the finaliser uses to decide whether a surviving handle may be signalled
// again. A handle that already had its bounded cleanup attempt may NOT: its fate is recorded as
// unknown, and a second untracked signal would not make it known.
function mayReSignalHandle(handle) {
  return handle.cleanupAttempted !== true;
}

// The one predicate the finaliser uses for removal AND for mode restoration. A preserved root is
// left exactly as the arm left it: not removed, not chmod-ed, not re-pointed.
function mayCleanUpRoot(root) {
  if (preservedRoots.has(root)) return false;
  for (const preserved of preservedRoots.keys()) {
    if (root === preserved || root.startsWith(preserved + path.sep)) return false;
  }
  return true;
}

// One owned parent directory per case. states.cjs creates storeRoot itself with a single
// non-recursive mkdir, so the parent is always this mkdtemp root and storeRoot is a name inside it.
function ownedParent(label) {
  const root = fs.mkdtempSync(path.join(WORK_DIR, TMP_PREFIX + label + "-"));
  createdRoots.push(root);
  return root;
}

// --- filesystem observation helpers ---------------------------------------------------------------

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Sorted (name, size) inventory, exactly as P2 and P3 recorded it.
function inventory(dir) {
  return fs.readdirSync(dir)
    .map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Sorted (name, size, sha256): the W7 leftover record, taken BEFORE anything reopens the store.
function inventoryWithHashes(dir) {
  return fs.readdirSync(dir).sort().map(name => {
    const member = path.join(dir, name);
    const stat = fs.lstatSync(member);
    return {
      name,
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other",
      size: stat.size,
      sha256: stat.isFile() ? sha256File(member) : null,
    };
  });
}

const SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"];

function sidecars(dir) {
  return fs.readdirSync(dir)
    .filter(name => SIDECAR_SUFFIXES.some(suffix => name.endsWith(suffix)))
    .sort();
}

// Full before/after snapshot of a pre-existing store root.
function snapshotRoot(dir) {
  return { inventory: inventory(dir), members: inventoryWithHashes(dir), sidecars: sidecars(dir) };
}

function normalizeToLf(buffer) {
  return Buffer.from(buffer.toString("binary").replace(/\r\n/g, "\n"), "binary");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// --- expectations authored HERE, independently of every file under test ---------------------------

// P2-CONTRACT section 3 storage format and the P3 store filename, authored here rather than
// imported from the coder leaves.
const DB_FILENAME = "conditional-admissions.sqlite3";
const STORE_ROOT_NAME = "store";
const STORE_META_TABLE = "store_meta";
const SECTION_TABLES = ["bindings", "admissions", "tombstones", "fenced_sessions"];
const TARGET_SECTION = "bindings";

// P2-CONTRACT section 5: the reconstructed ledger has EXACTLY these seven keys, in this order.
const EXPECTED_LEDGER_KEYS = [
  "schema_version", "generation", "marker", "bindings", "admissions", "tombstones", "fenced_sessions",
];

// P4-CONTRACT section 3: the exact field set of a successful result, sorted.
const EXPECTED_SUCCESS_KEYS = [
  "commitAttempted", "committed", "generation", "key", "ok", "requestId", "section",
].sort();

// The complete refusal vocabulary of section 3 as corrected by R2-1, authored here.
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

const ALL_REASONS = [
  REASON_PRECONDITION_INVALID, REASON_UNAVAILABLE, REASON_BUSY, REASON_MARKER_CHANGED,
  REASON_GENERATION_CONFLICT, REASON_KEY_EXISTS, REASON_BUMP_FAILED, REASON_TRANSACTION_FAILED,
  REASON_COMMIT_UNCERTAIN, REASON_ROLLBACK_FAILED, REASON_CLOSE_FAILED,
];

// R2-3 / R2-4 / R2-5 exact detail strings.
const DETAIL_INVALID_STORE_SHAPE = "invalid_store_shape";
const DETAIL_GENERATION_NOT_INCREMENTABLE = "generation_not_incrementable";
const DETAIL_VALUE_NOT_SERIALIZABLE = "value_not_serializable";
const DETAIL_REQUEST_ID_INVALID = "request_id_invalid";

// The closed classification vocabulary of section 3.
const CLASSIFICATIONS = ["busy", "conflict", "constraint", "unavailable", "unclassified"];

// Markers authored here. marker_id is a lowercase uuid-v4 and initialized_at survives a canonical
// toISOString round trip, which is the product predicate SHAPE reimplemented, never imported.
const MARKER_A = Object.freeze({
  marker_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  initialized_at: "2026-05-12T00:00:00.000Z",
});
// Differs from MARKER_A in marker_id only.
const MARKER_B = Object.freeze({
  marker_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  initialized_at: "2026-05-12T00:00:00.000Z",
});
// Differs from MARKER_A in initialized_at only.
const MARKER_C = Object.freeze({
  marker_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  initialized_at: "2026-05-12T00:00:01.000Z",
});

const REQUEST_ID = "p4-request-0001";

function mutationOf(key, value, section) {
  return { section: section === undefined ? TARGET_SECTION : section, key, value };
}

function callOptions(overrides) {
  const base = {
    marker: { marker_id: MARKER_A.marker_id, initialized_at: MARKER_A.initialized_at },
    expectedGeneration: 1,
    mutation: mutationOf("binding-alpha", { admitted: true, note: "p4" }),
    requestId: REQUEST_ID,
  };
  return Object.assign(base, overrides === undefined ? {} : overrides);
}

// --- store fixtures ------------------------------------------------------------------------------

// A complete valid store at the requested generation, built by states.cjs (which uses the
// byte-identity-verified P3 initializer for generation 1). states.cjs returns the dbPath ONLY and
// never an expected ledger, so the expectations above stay independent.
function newStore(label, options) {
  const settings = options === undefined ? {} : options;
  const marker = settings.marker === undefined ? MARKER_A : settings.marker;
  const generation = settings.generation === undefined ? 1 : settings.generation;
  const parent = ownedParent(label);
  const storeRoot = path.join(parent, STORE_ROOT_NAME);
  const dbPath = createState(storeRoot, "valid", { marker, generation });
  return { parent, storeRoot, dbPath };
}

// A TESTER-OWNED direct fixture mutation. The dispatch permits the tester to corrupt its own
// fixture tables, columns and rows directly for W11 and W12, independently of the coder lane. This
// is a declared FIXTURE writer confined to roots this suite created; W9 scopes the single-writer
// oracle to the runtime leaf precisely so that this remains legitimate.
function mutateFixture(dbPath, statements) {
  const db = new Database(dbPath);
  try {
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

// Read the store back through the INDEPENDENT P2 opener. Never through the slice.
function openLedger(dbPath) {
  return loadConditionalAdmissionsSqlite(dbPath);
}

function requireLedger(dbPath, context) {
  const opened = openLedger(dbPath);
  assert.equal(opened.ok, true,
    context + ": the independent P2 opener must accept the store (got "
    + JSON.stringify({ reason: opened.reason, detail: opened.detail }) + ")");
  return opened.ledger;
}

function sectionKeys(ledger, section) {
  return Object.keys(ledger[section]).sort();
}

function totalSectionRows(ledger) {
  return SECTION_TABLES.reduce((sum, table) => sum + Object.keys(ledger[table]).length, 0);
}

// --- synthetic seam control ------------------------------------------------------------------------

// P4_HOLD_AT and P4_HOLD_NONCE are MANDATORY members of this list, not an optional addition:
// withSeams and childEnv both delete every name here, and that deletion is the only thing standing
// between an indefinite in-process block and the seamedCall path. A hold seam that leaked into
// seamedCall would hang the suite itself with no budget to expire.
//
// P4_EXIT_AT is MANDATORY for the same class of reason and a sharper one: the W7 ordinary-exit
// control seam ends its process with process.exit(1), so a leak into the in-process seamedCall
// path would terminate THE SUITE mid-run with no assertion, no evidence and a nonzero code that
// looked like an ordinary failure. P4_CRASH_NONCE, P4_EXIT_NONCE, P4_WITNESS_AT and
// P4_WITNESS_NONCE are listed with them so no arm can ever inherit another arm's binding.
const SEAM_VARIABLES = [
  "P4_FAIL_AT", "P4_CRASH_AT", "P4_ROLLBACK_FAULT", "P4_CLOSE_FAULT", "P4_COMMIT_FAULT",
  "P4_HOLD_AT", "P4_HOLD_NONCE",
  "P4_CRASH_NONCE", "P4_EXIT_AT", "P4_EXIT_NONCE", "P4_WITNESS_AT", "P4_WITNESS_NONCE",
];

// Sets the named SYNTHETIC seams for exactly one call and restores the previous environment
// unconditionally, so a seam can never leak into a later case.
function withSeams(seams, fn) {
  const saved = new Map();
  for (const name of SEAM_VARIABLES) saved.set(name, process.env[name]);
  try {
    for (const name of SEAM_VARIABLES) delete process.env[name];
    for (const name of Object.keys(seams)) process.env[name] = seams[name];
    return fn();
  } finally {
    for (const name of SEAM_VARIABLES) {
      const previous = saved.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
}

// --- refusal recording and the R2-1 negative oracle W10e ----------------------------------------------

function codeOf(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

// A primary SQLite code has exactly one underscore-separated suffix (SQLITE_BUSY, SQLITE_CANTOPEN,
// SQLITE_NOTADB). An extended code carries more (SQLITE_CONSTRAINT_NOTNULL). P2 captured NO
// extended code on any runner, so this file RECORDS which was observed and asserts neither.
function isExtendedCode(code) {
  return typeof code === "string" && code.split("_").length > 2;
}

// W10e, applied to EVERY refusal this suite records rather than to one hand-picked arm: any result
// carrying retrySafe:true whose own record does not evidence all of R2-1 (a), (b) and (c) is a HARD
// FAILURE. (a) non-commit established, (b) transaction known ended - no rollback failure recorded,
// (c) cleanup settled - no close failure recorded.
function assertRetrySafeIsWellFormed(result, context) {
  if (result.ok === true || result.retrySafe !== true) return;
  assert.equal(result.commitAttempted, false,
    context + " [W10e a]: retrySafe:true requires commitAttempted:false as an established fact");
  assert.equal(result.committed, false,
    context + " [W10e a]: retrySafe:true requires committed:false as an established fact");
  const cleanup = result.cleanupError === undefined || result.cleanupError === null
    ? {} : result.cleanupError;
  assert.equal(cleanup.rollback === undefined || cleanup.rollback === null, true,
    context + " [W10e b]: retrySafe:true requires the transaction to be KNOWN ended - a recorded "
    + "rollback failure forces retrySafe:false");
  assert.equal(cleanup.close === undefined || cleanup.close === null, true,
    context + " [W10e c]: retrySafe:true requires cleanup settled - a recorded close failure "
    + "forces retrySafe:false");
}

// E1: for every refusal, record the primary sqliteCode, errno, syscall and the classifier verdict.
// An absent extended code or errno is a MEASURED UNKNOWN, never a failure.
function recordVocabulary(caseId, arm, result, extra) {
  const error = result.error === undefined ? null : result.error;
  const sqliteCode = codeOf(result.sqliteCode) !== null
    ? codeOf(result.sqliteCode)
    : (error === null ? null : codeOf(error.code));
  let classification = null;
  let classifierSqliteCode = null;
  let classifierErrno = null;
  if (error !== null) {
    const verdict = classifyWriteFailure(error);
    classification = verdict === null || verdict === undefined ? null : verdict.classification;
    classifierSqliteCode = verdict === null || verdict === undefined ? null : verdict.sqliteCode;
    classifierErrno = verdict === null || verdict === undefined ? null : verdict.errno;
  }
  const row = {
    caseId,
    arm,
    reason: result.reason,
    detail: result.detail === undefined ? null : result.detail,
    sqliteCode,
    sqliteCodeObserved: sqliteCode !== null,
    extendedCodeObserved: isExtendedCode(sqliteCode),
    errno: result.errno === undefined
      ? (error === null || error.errno === undefined ? null : error.errno)
      : result.errno,
    errnoObserved: result.errno !== undefined || (error !== null && error.errno !== undefined),
    syscall: error === null || typeof error.syscall !== "string" ? null : error.syscall,
    classification,
    classifierSqliteCode: classifierSqliteCode === undefined ? null : classifierSqliteCode,
    classifierErrno: classifierErrno === undefined ? null : classifierErrno,
    commitAttempted: result.commitAttempted,
    committed: result.committed,
    retrySafe: result.retrySafe,
    synthetic: extra !== undefined && extra !== null && extra.synthetic === true,
  };
  if (classification !== null) {
    assert.equal(CLASSIFICATIONS.includes(classification), true,
      caseId + "/" + arm + ": classifyWriteFailure must return a member of the closed vocabulary, "
      + "got " + String(classification));
  }
  // R2-5: native codes are preserved verbatim, never invented and never rewritten.
  if (classification !== null && sqliteCode !== null) {
    assert.equal(classifierSqliteCode, sqliteCode,
      caseId + "/" + arm + ": classifyWriteFailure must report the observed code VERBATIM");
  }
  evidence.errorVocabulary.push(row);
  return row;
}

// Asserts the full R2-1 tuple and records the E1 vocabulary row in one place, so no arm can quietly
// omit either. The expected argument is { reason, commitAttempted, committed, retrySafe }.
function expectRefusal(caseId, arm, result, expected, extra) {
  const context = caseId + "/" + arm;
  assert.equal(result.ok, false, context + ": this arm must refuse");
  assert.equal(result.reason, expected.reason, context + ": exact refusal reason");
  assert.equal(ALL_REASONS.includes(result.reason), true,
    context + ": the reason must belong to the closed section-3 vocabulary");
  assert.equal(result.commitAttempted, expected.commitAttempted, context + ": commitAttempted");
  assert.equal(result.committed, expected.committed, context + ": committed");
  assert.equal(result.retrySafe, expected.retrySafe, context + ": retrySafe");
  assertRetrySafeIsWellFormed(result, context);
  recordVocabulary(caseId, arm, result, extra);
  return result;
}

// Byte observation recorded under the exact R2-6 (a) label. Whether it is ASSERTED is decided per
// case: only the clean W5 fixtures may assert it (R2-2).
function byteObservation(before, after) {
  return {
    label: "not-a-zero-call-proof: byte-identity observation only",
    before,
    after,
    inventoryIdentical: JSON.stringify(before.inventory) === JSON.stringify(after.inventory),
    membersIdentical: JSON.stringify(before.members) === JSON.stringify(after.members),
    sidecarsCreated: after.sidecars.filter(name => !before.sidecars.includes(name)),
  };
}

// --- child-process helpers (W6 / W7) ---------------------------------------------------------------

const PER_CHILD_TIMEOUT_MS = 10000;
const SUITE_RACE_BUDGET_MS = 8 * 60 * 1000;
const RACE_CHILD_COUNT = 8;
const RACE_ITERATIONS = 20;

// --- run-wide signal audit (W7x) -----------------------------------------------------------------

// Counters incremented at the ONE place each event can occur, so these are measured totals rather
// than asserted constants. pidScans and processGroupsSignalled have no incrementer anywhere in this
// file: the suite owns exact handles and has no code path that enumerates processes or signals a
// group, which is why their run-wide zero is structural and not merely observed.
//
// EXPERIMENTAL and CLEANUP kills are counted SEPARATELY and never summed into a single "signals"
// claim. W7x issues exactly one experimental signal per arm; cleanup may still legitimately need a
// signal for a child that was refused or never announced, and the arm reports that honestly rather
// than promising a zero total it cannot keep.
const signalAudit = {
  pidScans: 0,
  processGroupsSignalled: 0,
  realSignalsIssued: 0,
  experimentalKillsIssued: 0,
  cleanupKillsIssued: 0,
  simulatedSignalsIssued: 0,
  killIntents: [],
};

// --- W7x seam-marker protocol --------------------------------------------------------------------

// The marker the coder seam writes, authored HERE from the contract prose rather than imported from
// the leaf under test, so a green parse cannot mean self-agreement.
//
// Byte-exact typed form, anchored at both ends. point is matched against the closed seam vocabulary
// by the caller, not by this pattern; the pattern only enforces the SHAPE.
const SEAM_MARKER_LINE =
  /^P4_SEAM_HOLD v1 point=([a-z][a-z_]{0,31}) nonce=([0-9a-f]{32}) pid=([1-9][0-9]{0,9})$/;

// The PARSE RETENTION buffer is HARD BOUNDED. A child that writes without ever emitting a newline,
// or that floods fd1, hits this cap and the arm is refused - there is no unbounded stdout buffer
// anywhere. v2: retention and DIGEST are now separate concerns. Retention is what is still waiting
// to become a line and is trimmed as lines are consumed; the digest is fed EVERY received byte
// before any trimming, so it describes what actually arrived rather than what happens to be left
// over. v1 hashed the post-trim retention, which meant a correctly parsed marker hashed the EMPTY
// string - the digest was structurally incapable of witnessing a successful arm.
const SEAM_MARKER_BUFFER_CAP = 1024;

function newSeamMarkerState() {
  return {
    // v3: RETENTION IS RAW BYTES. v2 held a JS string and bounded it with string.length/slice,
    // which are UTF-16 code units, not bytes - so a multibyte chunk silently violated the declared
    // 1024-BYTE cap. Worse, v2 decoded each chunk independently with toString("utf8"), so a
    // multibyte sequence split across a chunk boundary decoded to U+FFFD on both sides and the
    // retained material no longer WAS what arrived. A Buffer retains the exact bytes, the cap is
    // applied in bytes, and the marker parser refuses anything outside printable ASCII.
    retained: Buffer.alloc(0),
    bytesObserved: 0,
    linesObserved: 0,
    overflowed: false,
    // Set once, by the FIRST complete line only. Every later line is a duplicate and is refused.
    verdict: null,
    duplicateLinesRefused: 0,
    // Streaming digest over every received byte, in arrival order, fed before trimming.
    digest: crypto.createHash("sha256"),
    // CHUNKS that arrived on a stream nothing challenged. Their bytes are digested and counted in
    // bytesObserved like any other; this counter is the number of such arrivals, not a byte total.
    unchallengedChunks: 0,
  };
}

// Every byte that arrives goes through here exactly once, whether or not it is ever parsed, so the
// digest and the byte count cannot disagree with each other.
function absorbSeamBytes(state, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  state.bytesObserved += bytes.length;
  state.digest.update(bytes);
  return bytes;
}

// Raw child stdout is EXTERNAL TEXT and never reaches the evidence. Only these bounded, structured
// facts do: how many bytes and lines arrived, whether the cap was hit, and a digest of the raw
// bytes so two runs can be compared without the text itself being republished.
function seamMarkerObservation(state) {
  return {
    bytesObserved: state.bytesObserved,
    linesObserved: state.linesObserved,
    overflowed: state.overflowed,
    duplicateLinesRefused: state.duplicateLinesRefused,
    // v2: the digest of EVERY received byte, taken from the streaming hash rather than from the
    // post-trim retention. copy() is used so the state stays usable after an observation is taken.
    rawSha256: state.bytesObserved === 0 ? null : state.digest.copy().digest("hex"),
    unchallengedChunks: state.unchallengedChunks,
    retainedUnparsedBytes: state.retained.length,
    retentionPolicy: "retention is raw Buffer bytes, capped at SEAM_MARKER_BUFFER_CAP BYTES. No "
      + "chunk is decoded before the cap is applied and no line is decoded before it is proven to "
      + "be printable ASCII, so a split multibyte sequence can never be replaced or mis-bounded.",
    verdict: state.verdict,
    rawTextPolicy: "raw child stdout is NEVER copied into evidence - only these bounded counters "
      + "and a digest, so no external text can be republished as a measurement",
    digestPolicy: "the digest covers every byte received in arrival order, fed BEFORE any parse "
      + "trimming, so it witnesses a successful arm rather than the empty leftover of one",
  };
}

// Decides ONE complete line against the parent's challenge. Every refusal names its exact cause and
// none of them is a classification of the child: a child that lies about its point, nonce or pid is
// REFUSED, never identified, and this is not an authorship oracle.
function judgeSeamMarkerLine(lineBytes, expected) {
  // Byte-exact gate FIRST. The typed form is pure printable ASCII, so any byte outside 0x20-0x7e -
  // a multibyte lead or continuation byte, a stray CR, a control or a NUL - is marker material
  // this parser refuses outright rather than decoding, replacing or normalising.
  for (const byte of lineBytes) {
    if (byte < 0x20 || byte > 0x7e) {
      return { accepted: false, refusedBecause: "non_ascii_marker_material" };
    }
  }
  // Every byte is now known to be single-byte printable ASCII, so latin1 is a byte-exact decode.
  const line = lineBytes.toString("latin1");
  const match = SEAM_MARKER_LINE.exec(line);
  if (match === null) return { accepted: false, refusedBecause: "malformed_typed_form" };
  const point = match[1];
  const nonce = match[2];
  const pid = Number(match[3]);
  if (!CRASH_SEAMS.includes(point)) return { accepted: false, refusedBecause: "point_not_in_closed_set" };
  if (point !== expected.point) return { accepted: false, refusedBecause: "wrong_point" };
  if (nonce !== expected.nonce) return { accepted: false, refusedBecause: "wrong_nonce" };
  if (pid !== expected.pid) return { accepted: false, refusedBecause: "wrong_pid" };
  return { accepted: true, refusedBecause: null, point, nonce, pid };
}

// Chunk boundaries are arbitrary: a marker may arrive as one write, as several, or glued to a later
// line. Only COMPLETE newline-terminated lines are ever judged, and the first one decides.
function feedSeamMarker(state, chunk, expected) {
  // The digest is fed first and unconditionally, over the ORIGINAL Buffer, before any trimming.
  const bytes = absorbSeamBytes(state, chunk);
  let pending = Buffer.concat([state.retained, bytes]);
  if (pending.length > SEAM_MARKER_BUFFER_CAP) {
    // The cap is a BYTE cap. Once it is hit the state is dirty and every verdict is a refusal, so
    // truncating mid-sequence cannot produce a false acceptance.
    state.overflowed = true;
    pending = pending.subarray(0, SEAM_MARKER_BUFFER_CAP);
  }
  state.retained = pending;
  for (;;) {
    const at = state.retained.indexOf(0x0a);
    if (at === -1) break;
    const line = state.retained.subarray(0, at);
    state.retained = state.retained.subarray(at + 1);
    state.linesObserved += 1;
    if (state.verdict !== null) {
      // A second line is a protocol violation whatever it says. It can never upgrade an earlier
      // refusal into an acceptance, and it never re-decides an earlier acceptance.
      state.duplicateLinesRefused += 1;
      if (state.verdict.accepted) {
        state.verdict = { accepted: false, refusedBecause: "duplicate_marker_after_acceptance" };
      }
      continue;
    }
    state.verdict = state.overflowed
      ? { accepted: false, refusedBecause: "buffer_cap_exceeded" }
      : judgeSeamMarkerLine(line, expected);
  }
  return state.verdict;
}

// The single decision point for whether the experimental signal may be issued. Both the real arm
// and every negative control run through THIS function, so the controls exercise the production
// decision rather than a parallel copy of it.
function decideExperimentalKill(state, record) {
  if (record.exited) {
    return { issueSignal: false, failure: "exit_observed_before_kill_request" };
  }
  if (state.verdict === null) {
    return { issueSignal: false, failure: "no_marker_observed" };
  }
  if (!state.verdict.accepted) {
    return { issueSignal: false, failure: "marker_refused:" + state.verdict.refusedBecause };
  }
  // v2. An acceptance is a statement about ONE line, and v1 stopped there - so a marker that was
  // accepted and then followed by over-cap or trailing junk still issued the signal. The state as
  // a WHOLE must be clean at the moment of decision, not merely the line that was judged.
  if (state.overflowed) {
    return { issueSignal: false, failure: "marker_refused:buffer_cap_exceeded" };
  }
  if (state.duplicateLinesRefused > 0) {
    return { issueSignal: false, failure: "marker_refused:duplicate_marker_after_acceptance" };
  }
  if (state.retained.length > 0) {
    return { issueSignal: false, failure: "marker_refused:trailing_partial_content" };
  }
  return { issueSignal: true, failure: null };
}

// This is a decision about the bytes observed UP TO THIS POINT and nothing more. It is explicitly
// NOT a claim that no further data can arrive: the child is still live when the decision is taken,
// and anything it writes afterwards is outside what this function can see. What is claimed is only
// that the signal is never issued on a state that is ALREADY known to be dirty.
const SEAM_DECISION_LIMIT = "bounded by the bytes observed at decision time. No protection is "
  + "claimed or implied against data that arrives AFTER the decision is taken.";

// v2. The owned store may be inventoried, reopened or read as recovery evidence ONLY after this
// exact handle's exit has been OBSERVED. A live child still holds the transaction and its lock, so
// touching the store before the join would be reading a mid-transaction fixture and calling it a
// recovery observation.
function mayObserveRecovery(record) {
  return record.exited === true;
}

// --- W7 compound-evidence line protocol ----------------------------------------------------------
//
// W7 needs MORE THAN ONE line per child: the self-kill arm emits its seam marker and nothing else,
// and the ordinary-exit control arm emits its seam marker AND its exit-hook sentinel. The W7x
// single-verdict state machine above is deliberately left untouched - it exists to decide whether
// ONE line licenses ONE signal, and W7 issues no signal at all - so this is a SEPARATE collector
// beside it, with the same byte discipline and the same refuse-rather-than-decode posture.
//
// Everything expected here is authored in this lane: the typed forms, the closed kind vocabulary
// and every refusal cause. Nothing is imported from the leaves under test.
const W7_LINE_FORM =
  /^(P4_SEAM_CRASH|P4_SEAM_EXIT|P4_EXIT_WITNESS) v1 point=([a-z][a-z_]{0,31}) nonce=([0-9a-f]{32}) pid=([1-9][0-9]{0,9})$/;

const W7_LINE_KINDS = ["P4_SEAM_CRASH", "P4_SEAM_EXIT", "P4_EXIT_WITNESS"];

// The same HARD BYTE cap the W7x accumulator uses, reused rather than re-declared so a child that
// floods or never terminates a line costs a refusal instead of unbounded memory. Refusal records
// are bounded too: a child emitting a stream of junk lines cannot grow the evidence without limit.
const W7_LINE_BUFFER_CAP = SEAM_MARKER_BUFFER_CAP;
const W7_REFUSAL_EVIDENCE_CAP = 8;

function newW7LineState() {
  return {
    // Raw BYTES, capped in bytes, never decoded before a line is proven printable ASCII.
    retained: Buffer.alloc(0),
    bytesObserved: 0,
    linesObserved: 0,
    overflowed: false,
    // Streaming digest over every received byte, in arrival order, fed BEFORE any trimming.
    digest: crypto.createHash("sha256"),
    // Per-kind acceptance counts. A second accepted line of the same kind is a DUPLICATE and is
    // refused rather than counted, so these can only be 0 or 1 for a well-behaved child.
    acceptedByKind: { P4_SEAM_CRASH: 0, P4_SEAM_EXIT: 0, P4_EXIT_WITNESS: 0 },
    refusals: [],
    refusalsDropped: 0,
    duplicatesRefused: 0,
  };
}

function recordW7Refusal(state, because) {
  if (state.refusals.length >= W7_REFUSAL_EVIDENCE_CAP) {
    state.refusalsDropped += 1;
    return;
  }
  state.refusals.push(because);
}

// Decides ONE complete line against this child's challenge. Every refusal names its exact cause.
// A child that lies about its kind, point, nonce or pid is REFUSED, never identified: this is not
// an authorship oracle and a hostile child is outside what this fixture observes.
function judgeW7Line(lineBytes, expected) {
  // Byte-exact gate FIRST. The typed forms are pure printable ASCII, so any byte outside 0x20-0x7e
  // is material this parser refuses outright rather than decoding, replacing or normalising.
  for (const byte of lineBytes) {
    if (byte < 0x20 || byte > 0x7e) {
      return { accepted: false, kind: null, refusedBecause: "non_ascii_marker_material" };
    }
  }
  const line = lineBytes.toString("latin1");
  const match = W7_LINE_FORM.exec(line);
  if (match === null) return { accepted: false, kind: null, refusedBecause: "malformed_typed_form" };
  const kind = match[1];
  const point = match[2];
  const nonce = match[3];
  const pid = Number(match[4]);
  if (!W7_LINE_KINDS.includes(kind)) {
    return { accepted: false, kind: null, refusedBecause: "kind_not_in_closed_set" };
  }
  if (!CRASH_SEAMS.includes(point)) {
    return { accepted: false, kind, refusedBecause: "point_not_in_closed_set" };
  }
  if (point !== expected.point) return { accepted: false, kind, refusedBecause: "wrong_point" };
  if (nonce !== expected.nonce) return { accepted: false, kind, refusedBecause: "wrong_nonce" };
  if (pid !== expected.pid) return { accepted: false, kind, refusedBecause: "wrong_pid" };
  return { accepted: true, kind, refusedBecause: null, point, nonce, pid };
}

// Chunk boundaries are arbitrary. Only COMPLETE newline-terminated lines are ever judged; an
// unterminated tail stays retained and is reported as retained, never judged as if it had ended.
function feedW7Lines(state, chunk, expected) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  state.bytesObserved += bytes.length;
  state.digest.update(bytes);
  let pending = Buffer.concat([state.retained, bytes]);
  if (pending.length > W7_LINE_BUFFER_CAP) {
    // A BYTE cap. Once it is hit the state is dirty and the arm's own predicate rejects it, so a
    // mid-sequence truncation can never produce a false acceptance.
    state.overflowed = true;
    pending = pending.subarray(0, W7_LINE_BUFFER_CAP);
  }
  state.retained = pending;
  for (;;) {
    const at = state.retained.indexOf(0x0a);
    if (at === -1) break;
    const line = state.retained.subarray(0, at);
    state.retained = state.retained.subarray(at + 1);
    state.linesObserved += 1;
    if (state.overflowed) {
      recordW7Refusal(state, "buffer_cap_exceeded");
      continue;
    }
    const verdict = judgeW7Line(line, expected);
    if (!verdict.accepted) {
      recordW7Refusal(state, verdict.refusedBecause);
      continue;
    }
    if (state.acceptedByKind[verdict.kind] > 0) {
      // A second line of a kind already accepted is a protocol violation whatever it says. It is
      // refused rather than counted, and it can never upgrade or re-decide the first.
      state.duplicatesRefused += 1;
      recordW7Refusal(state, "duplicate_line_for_kind:" + verdict.kind);
      continue;
    }
    state.acceptedByKind[verdict.kind] += 1;
  }
  return state;
}

// Raw child stdout is EXTERNAL TEXT and never reaches the evidence. Only these bounded structured
// facts do: counts, refusal causes from a closed vocabulary, and a digest of the raw bytes.
function w7LineObservation(state) {
  return {
    bytesObserved: state.bytesObserved,
    linesObserved: state.linesObserved,
    overflowed: state.overflowed,
    retainedUnparsedBytes: state.retained.length,
    acceptedByKind: { ...state.acceptedByKind },
    refusals: [...state.refusals],
    refusalsDropped: state.refusalsDropped,
    duplicatesRefused: state.duplicatesRefused,
    rawSha256: state.bytesObserved === 0 ? null : state.digest.copy().digest("hex"),
    retentionPolicy: "retention is raw Buffer bytes capped at W7_LINE_BUFFER_CAP BYTES; no chunk "
      + "is decoded before the cap is applied and no line is decoded before it is proven printable "
      + "ASCII, so a split multibyte sequence can never be replaced or mis-bounded",
    rawTextPolicy: "raw child stdout is NEVER copied into evidence - only these bounded counters, "
      + "closed-vocabulary refusal causes and a digest",
  };
}

// The RAW self-kill representation per platform, authored HERE from the pinned-source research and
// the sealed CI recount, and kept SEPARATE from W7X_PINNED_PARENT_KILL_PAIR below because the two
// are different events with different reporting paths.
//
// On POSIX term_signal comes from the KERNEL wait status (WIFSIGNALED -> WTERMSIG), so the pair
// carries real information and the POSIX signal evidence is asserted explicitly and unchanged.
// On win32 there is no kernel channel for it at all: libuv maps a SIGKILL to
// TerminateProcess(handle, 1), the exit code is the hardcoded literal 1, and term_signal is
// bookkeeping only the OBSERVER's own uv_process_kill() would set - which a self-kill never calls.
// The pair is therefore (1, null), which is byte-for-byte what an ordinary exit(1) reports.
//
// HARD RULE: on win32 this pair is RECORDED as a representation observation and may NEVER be a
// passing attribution predicate on its own. Attribution comes from the compound oracle.
const W7_PINNED_SELF_KILL_PAIR = {
  darwin: { exitCode: null, signal: "SIGKILL", kernelAttestedSignal: true },
  linux: { exitCode: null, signal: "SIGKILL", kernelAttestedSignal: true },
  win32: { exitCode: 1, signal: null, kernelAttestedSignal: false },
};

// The ordinary-exit control's pinned pair. process.exit(1) reports exit code 1 and no signal on
// every one of the three runner platforms, which is precisely why it is non-discriminating from
// the win32 self-kill pair and why the control exists to be discriminated by its SENTINEL instead.
const W7_PINNED_ORDINARY_EXIT_PAIR = { exitCode: 1, signal: null };

// The pinned platform pair for a PARENT-issued SIGKILL through an owned handle, authored here from
// the contract prose. This is what the arm MEASURES against; it is never copied from the observed
// values, which would fabricate the datum being measured.
const W7X_PINNED_PARENT_KILL_PAIR = {
  darwin: { exitCode: null, signal: "SIGKILL" },
  linux: { exitCode: null, signal: "SIGKILL" },
  win32: { exitCode: null, signal: "SIGKILL" },
};

// Children never inherit this suite own seams: every synthetic hook is removed from the base
// environment and re-added only where a case deliberately asks for one.
function childEnv(extra) {
  const env = { ...process.env };
  for (const name of SEAM_VARIABLES) delete env[name];
  delete env.P4_FORCE_FAIL;
  return { ...env, ...(extra === undefined ? {} : extra) };
}

// fork IPC protocol (controller-reviewed integration detail): the child sends {type:"ready"},
// receives exactly one {type:"go", storeRoot, options}, calls the writer ONCE, sends
// {type:"result", result} and disconnects.
function spawnChild(extraEnv) {
  const child = fork(WRITE_CHILD_SOURCE, [], {
    cwd: SLICE_DIR,
    env: childEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const record = {
    pid: child.pid,
    ready: false,
    result: null,
    exitCode: null,
    signal: null,
    // Immutable observed exit facts. exited is set ONLY by the exit event, never by cleanup.
    exited: false,
    killRequested: false,
    killDelivered: null,
    killError: null,
    cleanupCalls: 0,
    killedByTest: false,
    stderrHead: "",
    // W7x kill accounting, kept SEPARATE by intent. A cleanup signal is a real signal and is
    // counted as one; it is never folded into the experimental count to make a zero look cleaner.
    experimentalKills: 0,
    cleanupKills: 0,
    killIntents: [],
    // Set only when this handle is a declared SIMULATION double (W7x negative controls).
    simulated: false,
    // IPC FAILURE EVIDENCE, the same schema spawnLockHoldPeer already records. A channel error and
    // an undelivered go command are FACTS about the arm that owns this child: they are recorded
    // here as scalars, latched with the rest of that arm and then hard-asserted empty. Nothing is
    // swallowed, nothing is retried, and an undelivered go is NEVER read as a child that received
    // it and chose to answer nothing. Both lists reuse the existing W6R_IPC_EVIDENCE_CAP bound, so
    // an erroring channel costs a refusal rather than unbounded memory.
    ipcErrors: [],
    sendAttempts: [],
  };
  const handle = { child, record, simulated: false };
  liveChildren.add(handle);
  evidence.children.spawned += 1;

  child.stderr.on("data", chunk => {
    if (record.stderrHead.length < 1024) record.stderrHead += String(chunk).slice(0, 1024);
  });

  // The ChildProcess 'error' listener, and the reason the W6/W7/W7x children cannot do without one.
  // This is the SAME listener spawnLockHoldPeer already installs, for the same measured reason: a
  // send() whose message cannot be delivered - the usual cause being a peer that already exited, so
  // the channel is closed - does NOT throw at the call site, it reports ASYNCHRONOUSLY. With no
  // callback and no listener that report becomes an 'error' event on an EventEmitter that has none,
  // which Node THROWS as an uncaughtException: measured on the verbatim W6/W7/W7x send regions it
  // aborted the PARENT in 6 of 6 runs, before any evidence latch and outside every finally, so the
  // owned children outlived the run and no reaped event was ever emitted.
  //
  // It is the BACKSTOP, not the mechanism: the go sends below supply a send callback so an ordinary
  // undelivered command is reported there instead, and this listener then covers what remains - a
  // libuv-level spawn failure, or a channel error raised outside any send. Either way the failure is
  // recorded, asserted and never absorbed. This listener records ONLY: it never resolves ready or
  // exited, never sets record.exited, and never counts a reap - an error is not an observed exit.
  child.on("error", error => {
    if (record.ipcErrors.length >= W6R_IPC_EVIDENCE_CAP) return;
    record.ipcErrors.push({ source: "child_process_error_event", ...observationFailure(error) });
  });

  // W7x fd1 listener. fd1 was already piped with NO reader, so attaching this listener adds no new
  // stream and cannot interleave with the native SQLite stderr line that stderrHead captures; the
  // 1024-byte stderrHead cap keeps exactly its current meaning. The accumulator is separately and
  // hard bounded, so an unreadable or flooding child costs a refusal, never unbounded memory.
  // W7 compound-evidence listener, ADDED BESIDE the W7x one below rather than folded into it: the
  // two protocols have different arities (W7x decides on exactly one line; W7 expects one line in
  // the self-kill arm and two in its ordinary-exit control) and different consequences (W7x
  // licenses a signal; W7 issues none). Attaching a second listener to the SAME already-piped fd1
  // adds no new stream and leaves the W7x path byte-for-byte unchanged. It is inert for every
  // child no W7 arm challenged: with handle.w7Expectation null nothing is parsed or retained.
  record.w7LineState = newW7LineState();
  handle.w7Expectation = null;
  child.stdout.on("data", chunk => {
    if (handle.w7Expectation === null) return;
    feedW7Lines(record.w7LineState, chunk, handle.w7Expectation);
  });

  // The exit EVENT can be observed before the last bytes of fd1 have been read, and the W7 exit
  // sentinel is by construction the very last thing a control child writes. Joining on the exit
  // alone would therefore race the sentinel and could report a real one as absent - which is the
  // single most misleading failure this case can produce. This promise resolves when the already
  // piped fd1 signals end-of-stream, and the W7 arms join on BOTH within the unchanged per-child
  // budget. No new stream, no new budget, and no other case awaits it.
  handle.stdoutEnded = new Promise(resolve => {
    child.stdout.on("end", () => resolve(record));
    child.stdout.on("close", () => resolve(record));
  });

  record.seamMarkerState = newSeamMarkerState();
  handle.seamExpectation = null;
  handle.seamMarker = new Promise(resolve => {
    child.stdout.on("data", chunk => {
      if (handle.seamExpectation === null) {
        // Nothing challenged this child, so nothing on fd1 can be a marker. Digested and counted,
        // never parsed and never retained - an unchallenged stream cannot produce a verdict.
        absorbSeamBytes(record.seamMarkerState, chunk);
        record.seamMarkerState.unchallengedChunks += 1;
        return;
      }
      const verdict = feedSeamMarker(record.seamMarkerState, chunk, handle.seamExpectation);
      if (verdict !== null) resolve(verdict);
    });
  });
  handle.ready = new Promise(resolve => {
    child.on("message", message => {
      if (message && message.type === "ready") {
        record.ready = true;
        resolve(record);
      }
      if (message && message.type === "result") {
        // Recorded verbatim. The parent NEVER synthesizes a result for a child that did not send
        // one (R2-2): a killed process cannot return a JS object.
        record.result = message.result;
      }
    });
  });
  handle.exited = new Promise(resolve => {
    child.on("exit", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.exited = true;
      liveChildren.delete(handle);
      evidence.children.reaped += 1;
      resolve(record);
    });
  });
  attachOwnedKill(handle);
  return handle;
}

// The test owns this exact handle and signals this exact pid. No process scan, no global kill.
//
// intent separates the W7x EXPERIMENTAL signal - the one the arm is measuring - from an ordinary
// CLEANUP signal, which may still be required for a child that was refused or never announced. The
// intent changes the ACCOUNTING only; the delivery path is byte-for-byte the same one every
// existing caller already used, and an omitted intent is "cleanup", exactly as before.
function attachOwnedKill(handle) {
  const record = handle.record;
  handle.kill = (intent) => {
    const label = intent === "experimental" ? "experimental" : "cleanup";
    record.cleanupCalls += 1;
    // An already-exited child is never signalled again. This is the existing guard, unchanged, and
    // it is what lets a W7x arm end with exactly one signal despite a cleanup pass in its finally.
    if (record.exited) return false;
    record.killRequested = true;
    record.killIntents.push(label);
    if (label === "experimental") record.experimentalKills += 1;
    else record.cleanupKills += 1;
    if (handle.simulated) {
      signalAudit.simulatedSignalsIssued += 1;
    } else {
      signalAudit.realSignalsIssued += 1;
      if (label === "experimental") signalAudit.experimentalKillsIssued += 1;
      else signalAudit.cleanupKillsIssued += 1;
    }
    signalAudit.killIntents.push({ pid: record.pid, intent: label, simulated: handle.simulated });
    let delivered = false;
    try {
      delivered = handle.child.kill("SIGKILL") === true;
    } catch (error) {
      record.killError = String((error && error.code) || error);
      delivered = false;
    }
    record.killDelivered = delivered;
    // Only a DELIVERED kill against a live child makes this death test-caused. A refused kill
    // leaves the fate unknown, which childLifecycle reports as a failure-worthy state.
    record.killedByTest = delivered;
    return delivered;
  };
  return handle;
}

// Derived from the recorded facts alone. Failed cleanup and an unknown fate stay distinct and
// reportable - never quietly folded into a clean exit.
function childLifecycle(record) {
  if (record.exited) return record.killedByTest ? "terminated-by-test" : "exited-observed";
  if (record.killRequested && record.killDelivered !== true) return "kill-failed-unknown";
  if (record.killRequested) return "kill-delivered-exit-unobserved";
  return "live-never-cleaned-up";
}

function lifecycleFacts(record) {
  return {
    pid: record.pid,
    exited: record.exited,
    exitCode: record.exitCode,
    signal: record.signal,
    ready: record.ready,
    resultReceived: record.result !== null,
    killRequested: record.killRequested,
    killDelivered: record.killDelivered,
    killError: record.killError,
    killedByTest: record.killedByTest,
    lifecycle: childLifecycle(record),
    // W7x: separate, never summed. A child with one experimental kill and no cleanup kill is a
    // different fact from a child that needed a cleanup signal, and both are reported as they are.
    experimentalKills: record.experimentalKills,
    cleanupKills: record.cleanupKills,
    killIntents: [...record.killIntents],
    // Real forked children carry this as false. It is recorded rather than omitted so the child
    // accounting can assert positively that no double ever entered it.
    simulated: record.simulated === true,
  };
}

// --- W7x injected owned-handle DOUBLES (declared SIMULATION) --------------------------------------

// An owned-handle double for the protocol and kill-failure negative controls. NO process is forked
// and NO operating-system signal is ever issued: handle.child is a plain object whose kill() does
// what the control declares. It is wired through the SAME attachOwnedKill accounting the real
// handles use, so a control exercises the production kill path rather than a parallel copy.
//
// HARD BOUNDARY, stated wherever these appear: a double is SIMULATION. It is evidence about this
// suite's own protocol handling and about nothing else. No double is counted in the child
// accounting, none contributes a lifecycle record, and NO double is ever storage proof - the real
// three-seam W7x arm is the only native-run evidence in this case.
function injectedOwnedHandleDouble(options) {
  const settings = options === undefined ? {} : options;
  const record = {
    pid: settings.pid === undefined ? 424242 : settings.pid,
    ready: true,
    result: null,
    exitCode: null,
    signal: null,
    exited: settings.alreadyExited === true,
    killRequested: false,
    killDelivered: null,
    killError: null,
    cleanupCalls: 0,
    killedByTest: false,
    stderrHead: "",
    experimentalKills: 0,
    cleanupKills: 0,
    killIntents: [],
    simulated: true,
    seamMarkerState: newSeamMarkerState(),
  };
  if (settings.alreadyExited === true) {
    record.exitCode = settings.exitCode === undefined ? 0 : settings.exitCode;
    record.signal = settings.signal === undefined ? null : settings.signal;
  }
  const child = {
    pid: record.pid,
    kill: () => {
      if (settings.killThrows === true) {
        const error = new Error("simulated kill failure - not a measured native failure");
        error.code = "EPERM";
        error.synthetic = true;
        throw error;
      }
      if (settings.killReturns === false) return false;
      if (settings.joins !== false) {
        record.exitCode = null;
        record.signal = "SIGKILL";
        record.exited = true;
      }
      return true;
    },
  };
  const handle = { child, record, simulated: true, seamExpectation: null };
  attachOwnedKill(handle);
  return handle;
}

// Bounds a wait without ever masking a non-unique winner: a timeout is a HARD FAILURE, never a
// retry. The caller kills its own handles in a finally.
function withDeadline(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded: " + label + " after " + ms + "ms")), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// --- SUITE CASES BEGIN BELOW --------------------------------------------------------------------

// Every call goes through one of these two helpers: withSeams deletes all five seam variables
// first, so no case can inherit a synthetic seam another case set.
function cleanCall(storeRoot, options) {
  return withSeams({}, () => applyExperimentalStoreMutation(storeRoot, options));
}

function seamedCall(seams, storeRoot, options) {
  return withSeams(seams, () => applyExperimentalStoreMutation(storeRoot, options));
}

// Section 5 W3 seam names and R2-2 W7 crash seam names, authored here from the prose.
const FAIL_SEAMS = ["after_open", "after_cas_read", "after_row_insert", "before_commit"];
const CRASH_SEAMS = ["after_cas_read", "after_row_insert", "before_commit"];

// --- P0: the pinned native stack and the two frozen copies this suite verifies against ----------

// Strips a Windows extended-length prefix BEFORE normalising separators and case, per the P2 P0
// oracle. Without this step a mapped Windows path can never equal the selector's ordinary path.
function normalizeNativePath(value) {
  return String(value)
    .replace(/^\\\\\?\\/, "")
    .replace(/^\/\/\?\//, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function observeMappedNativeBinary() {
  const method = "process.report.getReport().sharedObjects";
  let sharedObjects;
  try {
    sharedObjects = process.report.getReport().sharedObjects;
  } catch (error) {
    return { observed: false, method, reason: "getReport() threw: " + String(error && error.code) };
  }
  if (!Array.isArray(sharedObjects)) {
    return { observed: false, method, reason: "sharedObjects is not an array" };
  }
  const nodeObjects = sharedObjects.filter(entry => /\.node$/i.test(String(entry)));
  if (nodeObjects.length === 0) {
    return {
      observed: false,
      method,
      reason: "no .node entry present in sharedObjects on this platform/runtime",
      sharedObjectCount: sharedObjects.length,
    };
  }
  return { observed: true, method, nodeObjects };
}

// The frozen leaf identities, transcribed from this track's frozen-manifest.json entries for
// input/source/validation/1170-sqlite-p2-open/open-existing.cjs and
// input/source/validation/1170-sqlite-p3-init/init-exclusive.cjs (both pure LF).
const FROZEN_COPIES = [
  {
    label: "p2OpenerCopy",
    file: P2_OPENER_COPY,
    lfSha256: "d5e8e5b3311fc5e83dc7d11b72aa864032d50120db1d50abcd23e6686b936cd1",
    lfBytes: 11948,
    role: "the INDEPENDENT read-only verifier this suite REQUIRES",
  },
  {
    label: "p3InitializerCopy",
    file: P3_INITIALIZER_COPY,
    lfSha256: "31b94656b3fa24fde9367d39c23194cc3bc5768baa8a8f2b2cdeac852ae7243d",
    lfBytes: 16775,
    role: "the initializer states.cjs builds a generation-1 valid store with",
  },
];

test("P0 pinned native stack plus the frozen P2 opener and P3 initializer copies", () => {
  const pkg = require("better-sqlite3/package.json");
  assert.equal(pkg.version, "13.0.3", "better-sqlite3 must be the pinned 13.0.3");

  // P2-CORRECTIONS C5: the resolved node-addon-api stays at the verified 8.9.2, never a fresh ^8
  // pick with an unverified integrity.
  const addon = require("node-addon-api/package.json");
  assert.equal(addon.version, "8.9.2", "node-addon-api must be the verified 8.9.2");

  const packageRoot = path.dirname(require.resolve("better-sqlite3/package.json"));
  const binding = require(path.join(packageRoot, "lib", "binding.js"));
  const selected = binding.getPrebuildPath();
  assert.ok(typeof selected === "string" && selected.length > 0,
    "getPrebuildPath() must select a file");
  assert.equal(fs.existsSync(selected), true, "the selected prebuild file must exist");

  let sqliteVersion;
  const probe = new Database(":memory:");
  try {
    sqliteVersion = probe.prepare("SELECT sqlite_version() AS v").get().v;
  } finally {
    probe.close();
  }
  assert.match(sqliteVersion, /^\d+\.\d+\.\d+$/, "sqlite_version() must be a dotted triple");

  const mapped = observeMappedNativeBinary();
  let selectedMatchesMapped = null;
  if (mapped.observed) {
    const wanted = normalizeNativePath(selected);
    selectedMatchesMapped = mapped.nodeObjects.some(entry => normalizeNativePath(entry) === wanted);
    // UNKNOWN and MISMATCH stay distinct: an observable mapping that disagrees with the selection
    // is a hard failure; a mapping that cannot be observed is a recorded unknown (null).
    assert.equal(selectedMatchesMapped, true,
      "the observed mapped native binary must agree with the selected prebuild");
  }

  // The builder copies both frozen leaves in byte-identically before this suite runs. This lane
  // REQUIRES the P2 copy as its independent verifier, so it checks provenance itself rather than
  // trusting the copy step. The comparison is on LF-normalized bytes: a Windows checkout may
  // legitimately hold CRLF on disk (P2-CONTRACT section 0 records exactly that transform), and the
  // raw match is RECORDED rather than asserted.
  const copies = {};
  for (const entry of FROZEN_COPIES) {
    const raw = fs.readFileSync(entry.file);
    const rawSha = sha256Buffer(raw);
    const lf = normalizeToLf(raw);
    const lfSha = sha256Buffer(lf);
    assert.equal(lfSha, entry.lfSha256,
      entry.label + " must be the frozen leaf (LF-normalized sha256)");
    assert.equal(lf.length, entry.lfBytes,
      entry.label + " must be the frozen leaf byte length (LF-normalized)");
    copies[entry.label] = {
      path: entry.file,
      role: entry.role,
      rawSha256: rawSha,
      rawBytes: raw.length,
      lfNormalizedSha256: lfSha,
      lfNormalizedBytes: lf.length,
      expectedLfSha256: entry.lfSha256,
      rawMatchesFrozenLf: rawSha === entry.lfSha256,
      note: "read-only byte-identical copy of a frozen leaf, never edited here. A raw mismatch "
        + "with an LF match is a checkout line-ending transform, not a content change.",
    };
  }
  assert.equal(typeof loadConditionalAdmissionsSqlite, "function",
    "the copied P2 opener must export its one function");
  assert.equal(typeof applyExperimentalStoreMutation, "function",
    "the slice must export applyExperimentalStoreMutation");
  assert.equal(typeof classifyWriteFailure, "function",
    "the slice must export classifyWriteFailure");
  assert.equal(typeof observeRecoveryOpen, "function",
    "the tester-lane recovery observer must export its one function");

  evidence.frozenInputs = Object.assign({}, evidence.frozenInputs, copies);
  evidence.cases.P0 = {
    betterSqlite3Version: pkg.version,
    nodeAddonApiVersion: addon.version,
    sqliteVersion,
    nodeVersion: process.version,
    nodeVersionAssertedHere: false,
    nodeVersionNote: "the pinned 24.21.0 assertion belongs to the builder lane CI step; this case "
      + "records the observed runtime only, and decides no product Node floor (D3 stays open)",
    selectedPrebuild: selected,
    selectedPrebuildExists: true,
    selectedPrebuildNote: "filename selection only - NOT evidence that this file was the one mapped",
    mappedNativeBinary: mapped,
    selectedMatchesMapped,
    windowsPrefixNormalization: "applied to both sides before comparison (\\\\?\\ and //?/ stripped)",
    frozenCopies: copies,
  };
  maybeForceFail("P0");
});

// --- W0: positive caller preconditions, refused before any filesystem or SQLite call ------------

// R2-4 extends the v1 W0 arm list. Every arm is authored here from the prose; `detail` is asserted
// ONLY where R2-4 names the exact string, and merely recorded otherwise.
function cyclicValue() {
  const value = { name: "cyclic" };
  value.self = value;
  return value;
}

const W0_ARMS = [
  { arm: "marker:absent", overrides: { marker: undefined } },
  { arm: "marker:null", overrides: { marker: null } },
  { arm: "marker:empty-object", overrides: { marker: {} } },
  { arm: "marker:string", overrides: { marker: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" } },
  {
    arm: "marker:marker_id-not-uuid-v4",
    overrides: { marker: { marker_id: "not-a-uuid", initialized_at: MARKER_A.initialized_at } },
  },
  {
    arm: "marker:initialized_at-not-canonical",
    overrides: { marker: { marker_id: MARKER_A.marker_id, initialized_at: "2026-05-12T00:00:00Z" } },
  },
  {
    arm: "marker:extra-key",
    overrides: {
      marker: {
        marker_id: MARKER_A.marker_id,
        initialized_at: MARKER_A.initialized_at,
        extra: "not part of the two-key predicate",
      },
    },
  },
  { arm: "expectedGeneration:absent", overrides: { expectedGeneration: undefined } },
  { arm: "expectedGeneration:null", overrides: { expectedGeneration: null } },
  { arm: "expectedGeneration:zero", overrides: { expectedGeneration: 0 } },
  { arm: "expectedGeneration:negative", overrides: { expectedGeneration: -1 } },
  { arm: "expectedGeneration:string", overrides: { expectedGeneration: "1" } },
  { arm: "expectedGeneration:fractional", overrides: { expectedGeneration: 1.5 } },
  { arm: "expectedGeneration:NaN", overrides: { expectedGeneration: Number.NaN } },
  { arm: "expectedGeneration:2**53", overrides: { expectedGeneration: 2 ** 53 } },
  {
    arm: "expectedGeneration:MAX_SAFE_INTEGER",
    overrides: { expectedGeneration: Number.MAX_SAFE_INTEGER },
    detail: DETAIL_GENERATION_NOT_INCREMENTABLE,
  },
  { arm: "mutation:absent", overrides: { mutation: undefined } },
  { arm: "mutation:null", overrides: { mutation: null } },
  { arm: "mutation:empty-object", overrides: { mutation: {} } },
  {
    arm: "mutation:section-not-a-section-table",
    overrides: { mutation: mutationOf("binding-alpha", { admitted: true }, STORE_META_TABLE) },
  },
  {
    arm: "mutation:section-sqlite_master",
    overrides: { mutation: mutationOf("binding-alpha", { admitted: true }, "sqlite_master") },
  },
  {
    arm: "mutation:section-wrong-case",
    overrides: { mutation: mutationOf("binding-alpha", { admitted: true }, "Bindings") },
  },
  { arm: "mutation:key-empty", overrides: { mutation: mutationOf("", { admitted: true }) } },
  { arm: "mutation:key-non-string", overrides: { mutation: mutationOf(42, { admitted: true }) } },
  {
    arm: "requestId:empty",
    overrides: { requestId: "" },
    detail: DETAIL_REQUEST_ID_INVALID,
  },
  {
    arm: "requestId:null",
    overrides: { requestId: null },
    detail: DETAIL_REQUEST_ID_INVALID,
  },
  {
    arm: "requestId:non-string",
    overrides: { requestId: 7 },
    detail: DETAIL_REQUEST_ID_INVALID,
  },
  {
    arm: "requestId:absent",
    overrides: { requestId: undefined },
    detail: DETAIL_REQUEST_ID_INVALID,
  },
  {
    arm: "value:cyclic",
    overrides: { mutation: mutationOf("binding-alpha", cyclicValue()) },
    detail: DETAIL_VALUE_NOT_SERIALIZABLE,
  },
  {
    arm: "value:toJSON-throws",
    overrides: {
      mutation: mutationOf("binding-alpha", {
        toJSON() { throw new Error("synthetic toJSON refusal"); },
      }),
    },
    detail: DETAIL_VALUE_NOT_SERIALIZABLE,
  },
  {
    arm: "value:undefined",
    overrides: { mutation: mutationOf("binding-alpha", undefined) },
    detail: DETAIL_VALUE_NOT_SERIALIZABLE,
  },
  {
    arm: "value:function",
    overrides: { mutation: mutationOf("binding-alpha", () => 1) },
    detail: DETAIL_VALUE_NOT_SERIALIZABLE,
  },
  {
    arm: "value:bigint",
    overrides: { mutation: mutationOf("binding-alpha", 1n) },
    detail: DETAIL_VALUE_NOT_SERIALIZABLE,
  },
];

test("W0 preconditions refuse before any filesystem or SQLite call", () => {
  const store = newStore("w0");
  const before = snapshotRoot(store.storeRoot);
  const arms = [];

  for (const spec of W0_ARMS) {
    const armBefore = snapshotRoot(store.storeRoot);
    const result = cleanCall(store.storeRoot, callOptions(spec.overrides));
    expectRefusal("W0", spec.arm, result, {
      reason: REASON_PRECONDITION_INVALID,
      commitAttempted: false,
      committed: false,
      retrySafe: true,
    });
    if (spec.detail !== undefined) {
      assert.equal(result.detail, spec.detail,
        "W0/" + spec.arm + ": R2-4 names this exact detail string");
    }
    const armAfter = snapshotRoot(store.storeRoot);
    const observed = byteObservation(armBefore, armAfter);
    // R2-2 permits the byte-identity ASSERTION here: a precondition refusal constructs no handle
    // at all. R2-6 (a) still bounds what it proves - no modification, NOT no access.
    assert.equal(observed.membersIdentical, true,
      "W0/" + spec.arm + ": every pre-existing byte, size and name must be identical afterwards");
    assert.equal(observed.inventoryIdentical, true,
      "W0/" + spec.arm + ": the sorted (name,size) inventory must be identical afterwards");
    assert.deepEqual(observed.sidecarsCreated, [],
      "W0/" + spec.arm + ": no -journal, -wal or -shm may be created by a refused precondition");
    arms.push({
      arm: spec.arm,
      reason: result.reason,
      detail: result.detail === undefined ? null : result.detail,
      detailAsserted: spec.detail === undefined ? null : spec.detail,
      commitAttempted: result.commitAttempted,
      committed: result.committed,
      retrySafe: result.retrySafe,
      byteObservation: { label: observed.label, membersIdentical: observed.membersIdentical },
    });
  }

  const after = snapshotRoot(store.storeRoot);
  const overall = byteObservation(before, after);
  assert.equal(overall.membersIdentical, true,
    "W0: the store is byte-identical across the whole precondition arm set");
  assert.deepEqual(overall.sidecarsCreated, [], "W0: no sidecar survives the arm set");

  // The independent verifier still accepts the untouched store at generation 1.
  const ledger = requireLedger(store.dbPath, "W0");
  assert.equal(ledger.generation, 1, "W0: the generation is untouched");
  assert.equal(totalSectionRows(ledger), 0, "W0: no row was written by any refused precondition");

  evidence.cases.W0 = {
    armCount: arms.length,
    arms,
    byteObservation: overall,
    byteClaimScope: "R2-2: asserted here because no handle is ever constructed; R2-6 (a) bounds it "
      + "to a no-modification observation and it proves NO access ordering. Ordering is claimed "
      + "from the W9 structural source-order oracle alone.",
    ledgerAfter: { generation: ledger.generation, totalSectionRows: totalSectionRows(ledger) },
  };
  maybeForceFail("W0");
});

// --- W1: the positive write, verified through the independent P2 opener -------------------------

test("W1 positive: one row plus its generation bump, confirmed by the P2 opener", () => {
  const store = newStore("w1");
  const value = { admitted: true, note: "p4" };
  const result = cleanCall(store.storeRoot, callOptions());

  assert.equal(result.ok, true, "W1: a valid call against a generation-1 store must succeed");
  assert.deepEqual(Object.keys(result).sort(), EXPECTED_SUCCESS_KEYS,
    "W1: the success result carries exactly the section-3 field set");
  assert.equal(result.generation, 2, "W1: the committed generation is expectedGeneration + 1");
  assert.equal(result.section, TARGET_SECTION, "W1: the section is echoed back");
  assert.equal(result.key, "binding-alpha", "W1: the key is echoed back");
  assert.equal(result.requestId, REQUEST_ID, "W1: requestId is recorded in the result");
  assert.equal(result.commitAttempted, true, "W1: COMMIT was issued");
  assert.equal(result.committed, true, "W1: COMMIT returned and close returned");

  const ledger = requireLedger(store.dbPath, "W1");
  assert.deepEqual(Object.keys(ledger), EXPECTED_LEDGER_KEYS,
    "W1: the opener reconstructs exactly the seven ledger keys, in order");
  assert.equal(ledger.generation, 2, "W1: the opener reports generation 2");
  assert.deepEqual(ledger.marker,
    { marker_id: MARKER_A.marker_id, initialized_at: MARKER_A.initialized_at },
    "W1: the marker is unchanged by the write");
  assert.deepEqual(sectionKeys(ledger, TARGET_SECTION), ["binding-alpha"],
    "W1: exactly the written key is present in the target section");
  assert.deepEqual(ledger[TARGET_SECTION]["binding-alpha"], value,
    "W1: the stored value round-trips exactly");
  for (const table of SECTION_TABLES) {
    if (table === TARGET_SECTION) continue;
    assert.deepEqual(sectionKeys(ledger, table), [],
      "W1: no other section is touched (" + table + ")");
  }
  assert.equal(totalSectionRows(ledger), 1, "W1: exactly one row exists across all four sections");

  const after = snapshotRoot(store.storeRoot);
  assert.deepEqual(after.sidecars, [],
    "W1: journal_mode stays the SQLite default delete, so no hot sidecar survives a clean commit");

  evidence.cases.W1 = {
    result,
    openerLedgerKeys: Object.keys(ledger),
    generationAfter: ledger.generation,
    targetSectionKeys: sectionKeys(ledger, TARGET_SECTION),
    totalSectionRows: totalSectionRows(ledger),
    inventoryAfter: after.inventory,
    sidecarsAfter: after.sidecars,
    exitCodeObservedAtCase: process.exitCode === undefined ? 0 : process.exitCode,
    note: "no fsync, durability or power-loss claim is made by a returned COMMIT (section 7)",
  };
  maybeForceFail("W1");
});

// --- W2: exactly once - the CAS is the deduplication -------------------------------------------

test("W2 exactly once: the replayed identical call refuses on the generation CAS", () => {
  const store = newStore("w2");
  const first = cleanCall(store.storeRoot, callOptions());
  assert.equal(first.ok, true, "W2: the first call must succeed before a replay means anything");
  assert.equal(first.generation, 2, "W2: the first call commits generation 2");

  const committed = snapshotRoot(store.storeRoot);
  const committedSha = sha256File(store.dbPath);

  // The IDENTICAL call, replayed verbatim.
  const replay = cleanCall(store.storeRoot, callOptions());
  expectRefusal("W2", "replay-identical", replay, {
    reason: REASON_GENERATION_CONFLICT,
    commitAttempted: false,
    committed: false,
    retrySafe: false,
  });
  assert.notEqual(replay.detail, undefined, "W2: detail must carry observed and expected");
  const detailText = JSON.stringify(replay.detail);
  assert.match(detailText, /2/, "W2: detail names the OBSERVED generation 2");
  assert.match(detailText, /1/, "W2: detail names the EXPECTED generation 1");

  const afterReplay = snapshotRoot(store.storeRoot);
  const replaySha = sha256File(store.dbPath);
  // R2-2 bounds byte-preservation claims to the clean W5 fixtures: this refusal is raised AFTER a
  // read-write open, so the observation is RECORDED and deliberately NOT asserted.
  const replayObservation = byteObservation(committed, afterReplay);

  const ledgerAfterReplay = requireLedger(store.dbPath, "W2 after replay");
  assert.equal(ledgerAfterReplay.generation, 2, "W2: the opener still reports generation 2");
  assert.deepEqual(sectionKeys(ledgerAfterReplay, TARGET_SECTION), ["binding-alpha"],
    "W2: exactly one row - the replay applied nothing");
  assert.equal(totalSectionRows(ledgerAfterReplay), 1, "W2: exactly one row in the whole store");

  // Same section+key with the CORRECT expected generation now refuses on the key, not the CAS.
  const duplicate = cleanCall(store.storeRoot, callOptions({ expectedGeneration: 2 }));
  expectRefusal("W2", "same-key-correct-generation", duplicate, {
    reason: REASON_KEY_EXISTS,
    commitAttempted: false,
    committed: false,
    retrySafe: false,
  });

  const ledgerFinal = requireLedger(store.dbPath, "W2 after duplicate");
  assert.equal(ledgerFinal.generation, 2,
    "W2: a key-exists refusal leaves the generation at 2 - no bump without a row");
  assert.equal(totalSectionRows(ledgerFinal), 1, "W2: still exactly one row");

  evidence.cases.W2 = {
    first,
    replay,
    duplicate,
    committedSha256: committedSha,
    shaAfterReplay: replaySha,
    shaUnchangedAcrossReplay: committedSha === replaySha,
    byteObservation: replayObservation,
    byteClaimScope: "RECORDED, NOT ASSERTED (R2-2): this refusal is raised after a read-write "
      + "open, which may replay a hot rollback journal before any validation runs. Byte identity "
      + "is asserted only for the clean W5 fixtures.",
    generationAfterReplay: ledgerAfterReplay.generation,
    rowsAfterReplay: totalSectionRows(ledgerAfterReplay),
    deduplicationMechanism: "the generation CAS, never a request log - requestId is never stored",
  };
  maybeForceFail("W2");
});

// --- W3: no partial write - the row and its bump share one transaction --------------------------

test("W3 no partial write: every P4_FAIL_AT seam leaves generation 1 and zero rows", () => {
  const arms = [];
  for (const seam of FAIL_SEAMS) {
    const store = newStore("w3-" + seam);
    const before = snapshotRoot(store.storeRoot);
    const result = seamedCall({ P4_FAIL_AT: seam }, store.storeRoot, callOptions());

    // R2-7 outcome 1: rollback ok, close ok. The seam is SYNTHETIC and can only ADD a failure.
    expectRefusal("W3", seam, result, {
      reason: REASON_TRANSACTION_FAILED,
      commitAttempted: false,
      committed: false,
      retrySafe: true,
    }, { synthetic: true });
    assert.notEqual(result.error, undefined,
      "W3/" + seam + ": the in-transaction cause is carried in error");

    const ledger = requireLedger(store.dbPath, "W3/" + seam);
    assert.equal(ledger.generation, 1,
      "W3/" + seam + ": the generation is NOT bumped - a bump cannot land without its row");
    assert.equal(totalSectionRows(ledger), 0,
      "W3/" + seam + ": zero rows - a row cannot survive without its bump");

    const after = snapshotRoot(store.storeRoot);
    arms.push({
      seam,
      synthetic: true,
      result,
      generationAfter: ledger.generation,
      totalSectionRowsAfter: totalSectionRows(ledger),
      byteObservation: byteObservation(before, after),
      byteClaimScope: "RECORDED, NOT ASSERTED (R2-2): the failure is raised after a read-write open",
    });
  }

  assert.equal(arms.length, FAIL_SEAMS.length, "W3: every named seam must be exercised");
  evidence.cases.W3 = {
    seams: FAIL_SEAMS,
    arms,
    seamPolicy: "P4_FAIL_AT is tester-injected and SYNTHETIC, inert unset, and can only ADD a "
      + "failure - it never suppresses, masks or alters any other outcome. It is NOT native fault "
      + "coverage: native mid-transaction failure behaviour is UNMEASURED.",
  };
  maybeForceFail("W3");
});

// --- W4: the marker CAS -------------------------------------------------------------------------

test("W4 marker CAS: a differing marker_id or initialized_at refuses before any write", () => {
  const arms = [];
  // The store carries MARKER_A. The caller supplies a marker differing in exactly one field.
  const supplied = [
    { arm: "marker_id-differs", marker: MARKER_B },
    { arm: "initialized_at-differs", marker: MARKER_C },
  ];
  for (const spec of supplied) {
    const store = newStore("w4-" + spec.arm);
    const before = snapshotRoot(store.storeRoot);
    const result = cleanCall(store.storeRoot, callOptions({
      marker: { marker_id: spec.marker.marker_id, initialized_at: spec.marker.initialized_at },
    }));
    expectRefusal("W4", spec.arm, result, {
      reason: REASON_MARKER_CHANGED,
      commitAttempted: false,
      committed: false,
      retrySafe: false,
    });

    const ledger = requireLedger(store.dbPath, "W4/" + spec.arm);
    assert.equal(ledger.generation, 1, "W4/" + spec.arm + ": the generation is unchanged");
    assert.equal(totalSectionRows(ledger), 0, "W4/" + spec.arm + ": no row was written");
    assert.deepEqual(ledger.marker,
      { marker_id: MARKER_A.marker_id, initialized_at: MARKER_A.initialized_at },
      "W4/" + spec.arm + ": the stored marker is untouched");

    const after = snapshotRoot(store.storeRoot);
    arms.push({
      arm: spec.arm,
      suppliedMarker: { marker_id: spec.marker.marker_id, initialized_at: spec.marker.initialized_at },
      result,
      generationAfter: ledger.generation,
      totalSectionRowsAfter: totalSectionRows(ledger),
      byteObservation: byteObservation(before, after),
      byteClaimScope: "RECORDED, NOT ASSERTED (R2-2): raised after a read-write open",
    });
  }

  // A store whose stored marker fails the predicate outright: the marker check, not a shape check,
  // is what section 3 names for a marker that fails the predicate.
  const invalid = newStore("w4-stored-marker-invalid");
  mutateFixture(invalid.dbPath, [
    "UPDATE " + STORE_META_TABLE + " SET value = 'not-a-uuid' WHERE key = 'marker_id'",
  ]);
  const invalidResult = cleanCall(invalid.storeRoot, callOptions());
  expectRefusal("W4", "stored-marker-fails-predicate", invalidResult, {
    reason: REASON_MARKER_CHANGED,
    commitAttempted: false,
    committed: false,
    retrySafe: false,
  });
  // The independent verifier refuses this fixture too, for its own reason - recorded, not asserted
  // as agreement, because P2 names marker_invalid and P4 names its own experimental code (C2/D1).
  const openerVerdict = openLedger(invalid.dbPath);
  assert.equal(openerVerdict.ok, false,
    "W4: the independent P2 opener must also refuse a store whose marker fails the predicate");

  evidence.cases.W4 = {
    storedMarker: { marker_id: MARKER_A.marker_id, initialized_at: MARKER_A.initialized_at },
    arms,
    storedMarkerInvalid: {
      result: invalidResult,
      openerReason: openerVerdict.reason,
      openerDetail: openerVerdict.detail === undefined ? null : openerVerdict.detail,
      note: "the two lanes refuse independently with their own experimental identifiers; no "
        + "product reason-code mapping is claimed (D1 stays open)",
    },
    shapeNote: "the product check at L397-401 is mirrored in SHAPE only, never imported",
  };
  maybeForceFail("W4");
});

// --- W5: storage loss fails closed before any mutation, and creates nothing ---------------------

// A pre-existing state built by states.cjs in a parent this suite owns.
function newStateStore(label, kind) {
  const parent = ownedParent(label);
  const storeRoot = path.join(parent, STORE_ROOT_NAME);
  const dbPath = createState(storeRoot, kind, { marker: MARKER_A, generation: 1 });
  return { parent, storeRoot, dbPath };
}

// A Windows path long enough that the native open refuses it. Built from owned name components
// under a root this suite created: it is a LENGTH case, and makes no hostile-path claim.
function overLongStoreRoot(parent) {
  return path.join(parent, "w".repeat(120), "x".repeat(120), "y".repeat(120));
}

test("W5 storage loss: every unopenable store refuses closed and nothing is created", () => {
  const arms = [];

  function record(arm, spec) {
    const result = cleanCall(spec.storeRoot, callOptions());
    expectRefusal("W5", arm, result, {
      reason: REASON_UNAVAILABLE,
      commitAttempted: false,
      committed: false,
      retrySafe: true,
    });
    // The open failure must carry the observed PRIMARY sqliteCode. An extended code is RECORDED
    // when observed and is never asserted (P2 captured none on any runner).
    const sqliteCode = codeOf(result.sqliteCode);
    // R3-2. An ABSENT binding code is a MEASURED UNKNOWN, never permission to invent one: the
    // pinned binding can refuse before sqlite3_open_v2, in which case no SQLite code was ever
    // observable. The W11 arms already pass with sqliteCode null on this same reason. The hard
    // requirement is therefore that the code is RECORDED EXPLICITLY - never that one must exist.
    // No assertion is deleted and none is weakened into a mere recording: all three below are hard.
    const sqliteCodeKeyPresent = Object.hasOwn(result, "sqliteCode");
    const sqliteCodeObserved = sqliteCode !== null;
    // (i) a PRESENT key is never undefined, empty or otherwise a placeholder for an unknown.
    if (sqliteCodeKeyPresent) {
      assert.equal(typeof result.sqliteCode === "string" && result.sqliteCode !== "", true,
        "W5/" + arm + ": a PRESENT sqliteCode key must carry a non-empty observed string, never an "
        + "invented, empty or undefined placeholder");
    }
    // (ii) the explicit observation flag is a boolean, and the code is a string or an explicit null.
    assert.equal(typeof sqliteCodeObserved, "boolean",
      "W5/" + arm + ": sqliteCodeObserved must be recorded EXPLICITLY as a boolean");
    assert.equal(sqliteCode === null || typeof sqliteCode === "string", true,
      "W5/" + arm + ": sqliteCode must be recorded as a string or as an explicit null");
    // (iii) an OBSERVED code must be the PRIMARY one. An extended code stays recorded, never
    // asserted (P2 captured none on any runner), so observing one here is a hard failure.
    if (sqliteCodeObserved) {
      assert.equal(isExtendedCode(sqliteCode), false,
        "W5/" + arm + ": an observed open-failure code must be the PRIMARY sqliteCode, observed "
        + String(sqliteCode));
    }
    assert.notEqual(result.reason, "conditional_store_not_initialized",
      "W5/" + arm + ": a product reason code is never emitted, and no initialize decision is made");
    return { result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved };
  }

  // (a) absent storeRoot: the name is never created, recursively or otherwise.
  {
    const parent = ownedParent("w5a");
    const storeRoot = path.join(parent, "absent-store-root");
    const before = inventory(parent);
    const { result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved } =
      record("a:absent-store-root", { storeRoot });
    assert.equal(fs.existsSync(storeRoot), false,
      "W5/a: the absent storeRoot must NOT be created - the slice has no mkdir of any kind");
    assert.deepEqual(inventory(parent), before, "W5/a: the owned parent is untouched");
    arms.push({
      arm: "a:absent-store-root", result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved,
      storeRootCreated: false, parentInventory: inventory(parent),
      absenceClaim: "NOT CLAIMED: a refused open does not establish absence rather than "
        + "inaccessibility (P2-CORRECTIONS C1). The code is recorded, the cause is not inferred.",
    });
  }

  // (b) storeRoot present with no db file.
  {
    const spec = newStateStore("w5b", "empty-root");
    const before = snapshotRoot(spec.storeRoot);
    const { result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved } =
      record("b:no-db-file", spec);
    const after = snapshotRoot(spec.storeRoot);
    assert.equal(fs.existsSync(spec.dbPath), false,
      "W5/b: the missing database file must NOT be created - fileMustExist omits SQLITE_OPEN_CREATE");
    assert.deepEqual(after.inventory, before.inventory, "W5/b: the inventory is identical");
    assert.deepEqual(after.members, before.members, "W5/b: every pre-existing byte is identical");
    assert.deepEqual(after.sidecars, [], "W5/b: no -journal, -wal or -shm is created");
    arms.push({ arm: "b:no-db-file", result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved,
      dbCreated: false, byteObservation: byteObservation(before, after) });
  }

  // (c) corrupt bytes (P2 F7 body) and (d) a legacy JSON body (P2 F8 body).
  for (const [arm, kind] of [["c:corrupt-bytes", "corrupt"], ["d:legacy-json-body", "legacy-json"]]) {
    const spec = newStateStore("w5-" + kind, kind);
    const before = snapshotRoot(spec.storeRoot);
    const beforeSha = sha256File(spec.dbPath);
    const { result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved } = record(arm, spec);
    const after = snapshotRoot(spec.storeRoot);
    assert.equal(sha256File(spec.dbPath), beforeSha,
      "W5/" + arm + ": the pre-existing body is byte-identical - never truncated, repaired or replaced");
    assert.deepEqual(after.inventory, before.inventory, "W5/" + arm + ": the inventory is identical");
    assert.deepEqual(after.members, before.members, "W5/" + arm + ": every byte is identical");
    assert.deepEqual(after.sidecars, [], "W5/" + arm + ": no sidecar is created");
    arms.push({ arm, result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved,
      sha256Before: beforeSha, sha256After: sha256File(spec.dbPath),
      byteObservation: byteObservation(before, after) });
  }

  // (e) a denied path on POSIX, an invalid over-length path on Windows.
  if (process.platform === "win32") {
    const parent = ownedParent("w5e-win");
    const storeRoot = overLongStoreRoot(parent);
    const before = inventory(parent);
    const { result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved } =
      record("e:windows-over-length-path", { storeRoot });
    assert.deepEqual(inventory(parent), before,
      "W5/e: no component of the over-length path is created");
    arms.push({
      arm: "e:windows-over-length-path", result, sqliteCode, sqliteCodeKeyPresent,
      sqliteCodeObserved,
      pathLength: storeRoot.length,
      claimScope: "a LENGTH case only. No ACL, DACL, confinement, hostile-path or path-identity "
        + "claim is made, and no privilege expansion or denial bypass is attempted.",
      absenceClaim: "NOT CLAIMED as absence: an inaccessible name is never read as an absent one.",
    });
  } else {
    const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
    // The arm is only informative for a non-privileged euid, and the euid is recorded in the
    // evidence runtime block. A privileged run is a HARD FAILURE here, never a silent skip.
    assert.notEqual(euid, 0,
      "W5/e: the POSIX denied-path arm requires a non-privileged euid to mean anything");
    const spec = newStateStore("w5e-posix", "valid");
    const before = snapshotRoot(spec.storeRoot);
    const beforeSha = sha256File(spec.dbPath);
    // An OWNED fixture directory under WORK_DIR only. The mode is restored by the finaliser.
    modesToRestore.push({ dir: spec.storeRoot, mode: 0o700 });
    fs.chmodSync(spec.storeRoot, 0o000);
    let result;
    let sqliteCode;
    let sqliteCodeKeyPresent;
    let sqliteCodeObserved;
    try {
      const recorded = record("e:posix-denied-path", spec);
      result = recorded.result;
      sqliteCode = recorded.sqliteCode;
      sqliteCodeKeyPresent = recorded.sqliteCodeKeyPresent;
      sqliteCodeObserved = recorded.sqliteCodeObserved;
    } finally {
      fs.chmodSync(spec.storeRoot, 0o700);
    }
    const after = snapshotRoot(spec.storeRoot);
    assert.equal(sha256File(spec.dbPath), beforeSha,
      "W5/e: the pre-existing store is byte-identical behind a denied directory");
    assert.deepEqual(after.inventory, before.inventory, "W5/e: the inventory is identical");
    assert.deepEqual(after.sidecars, [], "W5/e: no sidecar is created");
    arms.push({
      arm: "e:posix-denied-path", result, sqliteCode, sqliteCodeKeyPresent, sqliteCodeObserved,
      euid,
      modeApplied: "0o000 on an owned fixture directory under WORK_DIR, restored before removal",
      sha256Before: beforeSha, sha256After: sha256File(spec.dbPath),
      byteObservation: byteObservation(before, after),
      claimScope: "no ACL, DACL, POSIX 0600, confinement or hostile-path claim is made, and no "
        + "privilege expansion or denial bypass is attempted (section 7).",
      absenceClaim: "NOT CLAIMED as absence: an inaccessible path is never reported as absent.",
    });
  }

  assert.equal(arms.length, 5, "W5: exactly the five named arms (a)-(e) must run");
  for (const entry of arms) {
    assert.equal(entry.result.reason, REASON_UNAVAILABLE,
      "W5: every arm refuses with the same experimental unavailable code");
    // R3-2: EVERY arm must have recorded its code observation explicitly - a missing flag is the
    // silent omission section 8 forbids, and is a hard failure rather than a tolerated unknown.
    assert.equal(typeof entry.sqliteCodeObserved, "boolean",
      "W5/" + entry.arm + ": the code observation must be recorded explicitly as a boolean");
    assert.equal(entry.sqliteCode === null || typeof entry.sqliteCode === "string", true,
      "W5/" + entry.arm + ": the recorded sqliteCode is a string or an explicit null");
    assert.equal(entry.sqliteCodeObserved, entry.sqliteCode !== null,
      "W5/" + entry.arm + ": the observation flag must agree with the recorded code");
  }

  evidence.cases.W5 = {
    arms,
    byteClaimScope: "R2-2: byte identity across a refusal is claimed ONLY for these clean W5 "
      + "fixtures, where the open itself fails and no handle is ever constructed. R2-6 (a): it is "
      + "a no-modification observation, not a zero-call or access-ordering proof.",
    extendedCodePolicy: "an extended SQLite result code is RECORDED when observed and asserted "
      + "never; P2 captured none on any runner",
    absentCodePolicy: "R3-2: where the pinned binding refuses BEFORE sqlite3_open_v2 no SQLite "
      + "code is observable at all. That is a MEASURED UNKNOWN recorded as sqliteCode null with "
      + "sqliteCodeObserved false - never an invented code, and never a silently omitted one. An "
      + "OBSERVED code is still hard-asserted to be the PRIMARY code.",
  };
  maybeForceFail("W5");
});

// --- W6: cooperating concurrent writers, 20 iterations x 8 children ------------------------------

// ==== BEGIN W6-INERT-ORACLE ====================================================================
// The W6 loser-vocabulary and independent-opener oracles, factored out as PURE functions so the
// inert control file (w6-vocabulary-control.cjs) can extract THIS EXACT REGION as text and drive
// the real maintained logic without loading better-sqlite3, the slice, or any native binding.
// Nothing in this region may require(), read process, touch the filesystem or mutate its argument;
// the control file asserts that inertness before it evaluates the region. The region is kept
// self-contained, so it declares the reason literals it needs, and the W6 test asserts those
// literals still equal the module-level REASON_ constants - the two copies cannot drift silently.
//
// Contract basis: L91 (W6) as SUPERSEDED by section 9 (L131) through R2-1 (L61 + L151). A throw
// raised BY COMMIT is experimental_store_commit_uncertain whatever err.code reports, INCLUDING a
// BUSY code; the section 3 busy row (L54) covers BEGIN IMMEDIATE and pre-COMMIT statements only
// and never captures a commit-phase BUSY.
const W6_LOSER_REASONS = {
  conflict: "experimental_store_generation_conflict",
  busy: "experimental_store_busy",
  commitUncertain: "experimental_store_commit_uncertain",
};

function w6HasField(result, name) {
  return Object.prototype.hasOwnProperty.call(result, name);
}

// Returns [] when the loser is admissible, otherwise one message per violation. It never throws
// and never reads anything outside `result`, so no caller can obtain a verdict by supplying
// context instead of evidence.
function w6LoserViolations(result) {
  const out = [];
  if (result === null || result === undefined) {
    out.push("a missing child result is NEVER folded into a refusal and NEVER synthesized into "
      + "commit_uncertain (R2-2, L167): a loser row must be a value the child actually returned");
    return out;
  }
  const reason = typeof result.reason === "string" ? result.reason : null;
  if (reason !== W6_LOSER_REASONS.conflict
    && reason !== W6_LOSER_REASONS.busy
    && reason !== W6_LOSER_REASONS.commitUncertain) {
    out.push("a loser refuses generation_conflict, busy or commit_uncertain and NOTHING else, "
      + "observed " + String(result.reason));
    return out;
  }
  if (reason === W6_LOSER_REASONS.busy) {
    const primary = typeof result.sqliteCode === "string" && result.sqliteCode !== ""
      ? result.sqliteCode
      : null;
    if (primary !== "SQLITE_BUSY") {
      out.push("a busy refusal carries the primary SQLITE_BUSY, observed "
        + String(result.sqliteCode));
    }
    if (result.commitAttempted !== false) {
      out.push("an ordinary busy is PRE-COMMIT and requires commitAttempted:false - a BUSY met AT "
        + "COMMIT is commit_uncertain instead (R2-1, L151), observed commitAttempted "
        + String(result.commitAttempted));
    }
    if (result.committed !== false) {
      out.push("a busy loser never reports a commit, observed committed "
        + String(result.committed));
    }
    if (result.retrySafe !== true) {
      out.push("a pre-COMMIT busy is retry-safe, observed retrySafe " + String(result.retrySafe));
    }
    return out;
  }
  if (reason === W6_LOSER_REASONS.conflict) {
    if (result.committed !== false) {
      out.push("a conflict loser never reports a commit, observed committed "
        + String(result.committed));
    }
    if (result.retrySafe !== false) {
      out.push("a generation conflict is NOT retry-safe, observed retrySafe "
        + String(result.retrySafe));
    }
    return out;
  }
  // commit_uncertain is admitted ONLY as the exact R2-1 tuple. The outcome stays UNKNOWN, and this
  // branch is never reached by relabelling it retryable (retrySafe:true) or not-committed
  // (committed:false) - both of those are violations below, not tolerated shapes.
  if (result.commitAttempted !== true) {
    out.push("commit_uncertain requires commitAttempted:true as an established fact, observed "
      + String(result.commitAttempted));
  }
  if (!w6HasField(result, "committed") || result.committed !== null) {
    out.push("commit_uncertain leaves the outcome UNKNOWN: committed must be PRESENT and null, "
      + "never relabelled false and never absent, observed " + String(result.committed));
  }
  if (result.retrySafe !== false) {
    out.push("commit_uncertain is NEVER retry-safe, observed retrySafe " + String(result.retrySafe));
  }
  return out;
}

// The independent-opener tuple, unchanged in strength: a read that ACTUALLY succeeded, generation
// exactly g + 1, exactly one new row, that row carrying the winner key, and no hot sidecar. This
// tuple is what keeps an admitted commit_uncertain honest (ORACLE-REVIEW N3): the uncertainty may
// survive in the loser vocabulary only while the ledger still shows exactly one winner at g + 1.
// A broken read or a broken tuple stays a HARD FAILURE, never a retry.
function w6LedgerViolations(latch, expected) {
  const out = [];
  if (latch === null || latch === undefined || latch.ledgerRead !== true) {
    out.push("the independent opener must actually read the store - a failed read is a failed "
      + "measurement, NEVER evidence that nothing landed");
    return out;
  }
  // Exactly null, as the assertion this replaced required. An ABSENT inventoryError is not a
  // clean inventory, it is a missing measurement, and a missing measurement is never evidence.
  if (latch.inventoryError !== null) {
    out.push("the on-disk inventory must actually be observed - inventoryError must be PRESENT "
      + "and exactly null, never absent, observed " + String(latch.inventoryError));
  }
  if (latch.generationAfter !== expected.generation) {
    out.push("the opener reports generation exactly g + 1 (" + String(expected.generation)
      + "), observed " + String(latch.generationAfter));
  }
  if (latch.rowsAfter !== 1) {
    out.push("EXACTLY one new row - no second write landed, observed " + String(latch.rowsAfter));
  }
  const keys = Array.isArray(latch.sectionKeysAfter) ? latch.sectionKeysAfter : null;
  if (keys === null || keys.length !== 1 || keys[0] !== expected.winnerKey) {
    out.push("the single row is the key of the unique confirmed winner ("
      + String(expected.winnerKey) + "), observed " + JSON.stringify(latch.sectionKeysAfter));
  }
  const hot = Array.isArray(latch.sidecarsAfter) ? latch.sidecarsAfter : null;
  if (hot === null || hot.length !== 0) {
    out.push("no hot sidecar survives the iteration, observed "
      + JSON.stringify(latch.sidecarsAfter));
  }
  return out;
}
// ==== END W6-INERT-ORACLE ======================================================================

// Every option value crossing the IPC boundary is authored HERE; the child echoes the slice result
// back verbatim and the parent never synthesizes one.
function raceOptions(iteration, index) {
  return {
    marker: { marker_id: MARKER_A.marker_id, initialized_at: MARKER_A.initialized_at },
    expectedGeneration: 1,
    mutation: mutationOf("binding-child-" + index, { iteration, child: index }),
    requestId: "p4-race-" + iteration + "-" + index,
  };
}

// Every scalar of a race child result that survives the IPC JSON boundary, recorded VERBATIM.
// write-child.cjs drops error and cleanupError across that boundary, so these are the only
// cause-side facts that can ever reach the parent: if they are not recorded they are lost for
// good, which is exactly what happened to Windows iteration 14. A missing result is an explicit
// null plus resultReceived:false - never silently folded into a refusal.
function raceScalars(result) {
  if (result === null || result === undefined) {
    return {
      resultReceived: false, ok: null, reason: null, detail: null,
      sqliteCode: null, sqliteCodeObserved: false, errno: null, errnoObserved: false,
      commitAttempted: null, committed: null, retrySafe: null, generation: null,
      key: null, requestId: null,
    };
  }
  const sqliteCode = codeOf(result.sqliteCode);
  return {
    resultReceived: true,
    ok: result.ok === true,
    reason: result.reason === undefined ? null : result.reason,
    detail: result.detail === undefined ? null : result.detail,
    sqliteCode,
    sqliteCodeObserved: sqliteCode !== null,
    errno: result.errno === undefined ? null : result.errno,
    errnoObserved: result.errno !== undefined,
    commitAttempted: result.commitAttempted === undefined ? null : result.commitAttempted,
    committed: result.committed === undefined ? null : result.committed,
    retrySafe: result.retrySafe === undefined ? null : result.retrySafe,
    generation: result.generation === undefined ? null : result.generation,
    key: result.key === undefined ? null : result.key,
    requestId: result.requestId === undefined ? null : result.requestId,
  };
}

// A failed observation is recorded as an observation, never as a verdict: no branch anywhere in
// this suite reads this text to decide an outcome (R2-7 forbids message-derived verdicts).
function observationFailure(error) {
  return {
    observed: String((error && error.code) || (error && error.name) || "error"),
    diagnostic: String((error && error.message) || error),
    note: "OBSERVATION ONLY - recorded so a failed read is visible as a failed read. No verdict "
      + "is derived from this text, and a failed read is NEVER reported as zero rows.",
  };
}

async function runRaceIteration(iteration) {
  const store = newStore("w6-i" + String(iteration).padStart(2, "0"));
  const handles = [];
  // Declared here so the transport evidence survives the try block and reaches the latch below.
  let goAttempts = [];
  let goSendFailures = [];
  // Declared with the transport evidence so the cleanup join's outcome reaches the latch too.
  let cleanupJoinError = null;
  // v5: a throw out of the CLEANUP BODY itself is RECORDED here rather than propagated, so an
  // original try-body error keeps its identity and stays the error that leaves this function. A
  // cleanup-only failure has no other error to hide behind: it is latched and asserted below, so it
  // fails the iteration rather than being swallowed to green.
  let cleanupFailure = null;
  // v5: the preservation decision is now taken inside the finally below so that the body-throw and
  // cleanup-throw paths reach it too. Its outputs are declared here so the latch and the assertions
  // below still read them exactly as before.
  let preservation = null;
  let unobservedExits = [];
  let unobservedPids = [];
  let storeObservable = false;
  try {
    for (let index = 0; index < RACE_CHILD_COUNT; index += 1) handles.push(spawnChild());
    // The start barrier: EVERY child reports ready before ANY child is released.
    await withDeadline(Promise.all(handles.map(handle => handle.ready)), PER_CHILD_TIMEOUT_MS,
      "W6 iteration " + iteration + " ready barrier");
    // Every go is ISSUED in this one synchronous pass, exactly as the bare forEach issued them, so
    // the simultaneous release that makes this a race is unchanged; only the acknowledgements are
    // awaited afterwards. sendGo never rejects, so this await cannot skip the latch below.
    goAttempts = await Promise.all(handles.map((handle, index) => sendGo(handle, "go",
      { type: "go", storeRoot: store.storeRoot, options: raceOptions(iteration, index) })));
    goSendFailures = goAttempts
      .map((attempt, index) => (attempt.failure === null ? null : { child: index, ...attempt.failure }))
      .filter(entry => entry !== null);
    // A child that was never commanded cannot exit, so joining on it would only burn the per-child
    // budget and then throw PAST this iteration's latch - destroying the very evidence an
    // undelivered go makes most valuable. The join is skipped, the failure is latched below and the
    // iteration FAILS on it; the finally still kills every owned handle. This is not a tolerated
    // condition and no child is read as having answered.
    if (goSendFailures.length === 0) {
      await withDeadline(Promise.all(handles.map(handle => handle.exited)), PER_CHILD_TIMEOUT_MS,
        "W6 iteration " + iteration + " child join");
    }
  } finally {
    // v5: the ENTIRE cleanup body below is wrapped and the preservation decision moved into an inner
    // finally. v4 took that decision AFTER this block, so a throw out of the try body left the
    // function before reaching it - and a bare tail-of-finally placement would still have been
    // skipped by a throw out of the cleanup body itself (handle.kill()). The inner finally is
    // guaranteed on all three paths: normal return, try-body throw, cleanup-body throw.
    try {
    // Exact owned handles only: no process scan and no global kill, ever.
    //
    // v4: the cleanup kill is now JOINED through these same exact handles, inside the SAME
    // per-child budget the skipped join above would have used. v3 signalled and walked away, so on
    // the undelivered-go path a kill ATTEMPT - which is not a reap - was followed immediately, in
    // the same synchronous turn, by the independent ledger read, the inventory and the finaliser's
    // removal of a root that up to eight commanded children were still holding open. No new budget,
    // no extra signal and no idle wait is introduced: this only waits for the kills already issued,
    // and a budget expiry here is recorded as the failure it is rather than absorbed.
    const cleanupJoins = [];
    for (const handle of handles) {
      handle.kill();
      if (!handle.record.exited) {
        // This handle has now had its ONE bounded cleanup attempt. The finaliser reads this flag and
        // does NOT issue a second, untracked signal to it.
        handle.cleanupAttempted = true;
        cleanupJoins.push(handle.exited);
      }
    }
    if (cleanupJoins.length > 0) {
      try {
        await withDeadline(Promise.all(cleanupJoins), PER_CHILD_TIMEOUT_MS,
          "W6 iteration " + iteration + " cleanup join");
      } catch (error) {
        cleanupJoinError = observationFailure(error);
      }
    }
    } catch (error) {
      // RECORDED, never re-thrown: if an original try-body error is in flight it stays the
      // propagating error with its identity intact, and this cleanup failure survives beside it as
      // evidence. Same observationFailure convention cleanupJoinError already uses.
      cleanupFailure = observationFailure(error);
    } finally {
      // v5 PRESERVATION DECISION, taken here so EVERY exit path reaches it - ready-barrier timeout,
      // undelivered go, skipped join, unjoined cleanup, a try-body throw or a cleanup-body throw
      // alike, and BEFORE the first store observation below. This is the same shared function the
      // finaliser consults, bound to THIS iteration's exact owned root: an iteration in which any
      // one of its own children's exits was never observed keeps its store instead of reading it,
      // and then having it removed, from under a live writer. The decision is taken AFTER the
      // bounded cleanup join above, from the OBSERVED record.exited of each exact handle - never
      // from the latch's childrenJoined metadata, and never from a kill attempt read as a reap.
      //
      // This block only ASSIGNS: it never throws and never returns, so it cannot replace or suppress
      // whichever error is propagating out of the blocks above.
      const cleanupRecords = handles.map(handle => handle.record);
      unobservedExits = cleanupRecords.filter(record => record.exited !== true);
      unobservedPids = unobservedExits.map(record => record.pid);
      storeObservable = unobservedExits.length === 0;
      preservation = registerRootPreservation({
        caseId: "W6",
        seam: "iteration-" + iteration,
        root: store.parent,
        // One pid when exactly one child is unaccounted for; null when the count is anything else,
        // because a single pid field cannot honestly stand for several. The full list is latched
        // below.
        pid: unobservedPids.length === 1 ? unobservedPids[0] : null,
        exited: storeObservable,
      });
      // v6: and the cleanup failure is PUBLISHED here, on the same guaranteed path, instead of being
      // left in the local above. When a try-body error is in flight it leaves this function the
      // moment this finally completes, so the latch and the assertion below are never reached and
      // v5's local died with the frame. Appending to the run evidence object is the only record that
      // survives that path. Push only - it cannot throw, cannot return and cannot replace or
      // suppress whichever error is propagating.
      if (cleanupFailure !== null) {
        evidence.cleanupFailures.push({
          caseId: "W6",
          seam: "iteration-" + iteration,
          iteration,
          root: store.parent,
          failure: cleanupFailure,
          note: "SECONDARY cleanup-body failure recorded beside the primary error, which keeps its "
            + "identity and still propagates. Recorded in memory and serialised by the finaliser - "
            + "NOT a disk-durability claim.",
        });
      }
    }
  }

  const records = handles.map(handle => handle.record);
  const facts = records.map(lifecycleFacts);
  const results = records.map(record => record.result);

  // ---- FAILURE-SAFE EVIDENCE LATCH: every record below PRECEDES every assertion -------------
  // Windows iteration 14 destroyed its own evidence because every record call sat AFTER the
  // loser-vocabulary assertion: the 8 lifecycle facts, the 7 loser vocabulary rows, the
  // independent ledger read, the row count, the winner key, the sidecars and the inventory were
  // all lost, and iterations 15-20 never ran at all. The one question that mattered - whether
  // the uncertain child row landed (rows 2) or not (rows 1) - was precisely the one the aborted
  // read would have answered. Recording now happens first and unconditionally.
  //
  // NOTHING below is weakened to achieve this: every original assertion still runs, still hard,
  // immediately after the latch, and the loser vocabulary stays closed to conflict-or-busy.

  // (1) all 8 child lifecycles, unconditionally and exactly once per child.
  evidence.children.records.push(...facts.map(fact => ({ caseId: "W6", iteration, ...fact })));

  // (2) all 8 child outcomes verbatim, including the phase scalars that survive IPC JSON.
  const outcomes = records.map((record, index) => ({
    child: index,
    ...lifecycleFacts(record),
    stderrHead: record.stderrHead === "" ? null : record.stderrHead,
    // The transport facts for this exact child, latched alongside its outcome. A delivered go is
    // transport completion only and decides NOTHING about the result scalars beside it.
    ...ipcFacts(record),
    ...raceScalars(record.result),
  }));

  const winners = results.filter(result =>
    result !== null && result !== undefined && result.ok === true);
  const losers = results.filter(result =>
    result === null || result === undefined || result.ok !== true);

  // (3) a vocabulary row for EVERY loser. recordVocabulary itself asserts, so each call is
  // guarded: one failing row can no longer discard the other six. The collected failures are
  // re-raised as a hard assertion once the latch is sealed - deferred, never dropped.
  const vocabularyErrors = [];
  records.forEach((record, index) => {
    const result = record.result;
    if (result === null || result === undefined || result.ok === true) return;
    try {
      recordVocabulary("W6",
        "iteration-" + iteration + ":child-" + index + ":" + String(result.reason),
        result, { synthetic: false });
    } catch (error) {
      vocabularyErrors.push({ child: index, reason: String(result.reason), ...observationFailure(error) });
    }
  });

  // (4) the INDEPENDENT P2 opener read: generation, row count and section keys. A failed or
  // missing read is recorded as an explicit null with ledgerRead:false and is NEVER reported as
  // zero rows - "nothing landed" may only ever be claimed from a read that actually succeeded.
  let ledger = null;
  let ledgerError = null;
  let generationObserved = null;
  let rowsObserved = null;
  let sectionKeysObserved = null;
  let ledgerKeysObserved = null;
  // (4a) v4 GATE. The owned store is not READ AT ALL until every one of this iteration's exact
  // handles has had its exit observed. An unjoined child still holds its transaction and its lock,
  // so a ledger read would report the row count of a live mid-write store and an inventory would
  // stat files underneath a running writer - and "rows: 0" recorded from under eight children that
  // were commanded, SIGKILLed and never reaped is the single most misleading datum this arm can
  // produce. When the exits were not all observed the iteration keeps the store UNTOUCHED, persists
  // the unknown through the preservation decision above, and FAILS below: ledgerRead stays false,
  // which w6LedgerViolations already treats as a failed measurement and NEVER as zero rows.
  let ledgerReadCalls = 0;
  let notObservedBecause = null;
  // (5) the on-disk inventory and sidecars, guarded the same way.
  let inventoryAfter = null;
  let sidecarsAfter = null;
  let inventoryError = null;
  if (!storeObservable) {
    notObservedBecause = preservation.because;
  } else {
    try {
      ledgerReadCalls += 1;
      ledger = requireLedger(store.dbPath, "W6 iteration " + iteration);
      generationObserved = ledger.generation;
      rowsObserved = totalSectionRows(ledger);
      sectionKeysObserved = sectionKeys(ledger, TARGET_SECTION);
      ledgerKeysObserved = Object.keys(ledger).sort();
    } catch (error) {
      ledger = null;
      ledgerError = observationFailure(error);
    }

    try {
      inventoryAfter = inventory(store.storeRoot);
      sidecarsAfter = sidecars(store.storeRoot);
    } catch (error) {
      inventoryError = observationFailure(error);
    }
  }

  const latch = {
    iteration,
    // Explicitly incomplete until every assertion below has passed. A partial iteration is
    // NEVER recorded as a success to satisfy a downstream gate.
    status: "incomplete",
    childrenPerIteration: RACE_CHILD_COUNT,
    childrenObserved: outcomes.length,
    outcomes,
    winners: winners.length,
    losers: losers.length,
    retriesUsed: 0,
    winnerKey: winners.length === 1 && winners[0].key !== undefined ? winners[0].key : null,
    winnerRequestId: winners.length === 1 && winners[0].requestId !== undefined
      ? winners[0].requestId : null,
    winnerGeneration: winners.length === 1 && winners[0].generation !== undefined
      ? winners[0].generation : null,
    loserReasons: losers.map(result =>
      result === null || result === undefined ? null : result.reason).sort(),
    loserScalars: outcomes.filter(outcome => outcome.ok !== true),
    vocabularyErrors,
    ledgerRead: ledger !== null,
    ledgerError,
    generationAfter: generationObserved,
    rowsAfter: rowsObserved,
    sectionKeysAfter: sectionKeysObserved,
    ledgerKeysAfter: ledgerKeysObserved,
    inventoryAfter,
    sidecarsAfter,
    inventoryError,
    childFacts: facts,
    // The iteration's transport evidence, latched BEFORE the assertions like everything else here.
    // childrenJoined records positively whether the join was reached, so a skipped join can never
    // be mistaken for one that completed.
    goSendFailures,
    goSendAttempts: goAttempts.map(attempt => ({ ...attempt })),
    childrenJoined: goSendFailures.length === 0,
    // v4 cleanup-join and gate facts, all derived from the OBSERVED per-handle records rather than
    // from childrenJoined above. ledgerReadCalls is 1 for an iteration whose children were all
    // reaped and 0 for one that was not, so the evidence shows POSITIVELY that no read was taken
    // against a store a live child was still holding.
    cleanupJoinError,
    // v5: a throw out of the cleanup body itself, recorded so it is visible as the failure it is
    // instead of replacing the original try-body error.
    cleanupFailure,
    cleanupAttempted: handles.filter(handle => handle.cleanupAttempted === true).length,
    exitsObserved: records.length - unobservedExits.length,
    unobservedExits: unobservedExits.length,
    unobservedExitPids: unobservedPids,
    storeObservable,
    notObservedBecause,
    ledgerReadCalls,
    storePreservedUnobserved: storeObservable === false,
    // The exact owned root of THIS iteration and what the shared decision said about it. A preserved
    // root is reported by the finaliser and forces cleanup clean:false rather than being removed.
    ownedRoot: store.parent,
    preservation,
    ipcErrors: records.flatMap((record, index) =>
      record.ipcErrors.map(entry => ({ child: index, ...entry }))),
    transportPolicy: "a delivered go is TRANSPORT COMPLETION ONLY - never a child acknowledgement "
      + "and never a result. An undelivered go is recorded as undelivered and is NEVER read as a "
      + "child that received it and refused.",
    zeroRowPolicy: "a missing or failed ledger read is recorded as null with ledgerRead:false "
      + "and is NEVER reported as zero rows",
    recordingOrder: "every field above was recorded BEFORE the first assertion below",
  };
  evidence.cases.W6.iterations.push(latch);
  evidence.cases.W6.iterationsRecorded = evidence.cases.W6.iterations.length;

  // ---- ASSERTIONS: unchanged in strength, now running against a sealed record ----------------
  // The transport predicates run FIRST so an undelivered go is reported as the undelivered go it
  // is, rather than as the unobserved exit it would otherwise masquerade as below. Both are HARD
  // failures of this iteration; neither relaxes or replaces any predicate that follows.
  assert.deepEqual(latch.ipcErrors, [],
    "W6 iteration " + iteration + ": the children's IPC channels must raise NO error. An error here "
    + "is a FAILURE of this iteration and is reported from inside its latch, which is the whole "
    + "point of observing it: unlistened, it would surface as an uncaughtException and end the run "
    + "BEFORE any of this iteration's evidence was written ("
    + JSON.stringify(latch.ipcErrors) + ")");
  assert.deepEqual(goSendFailures, [],
    "W6 iteration " + iteration + ": every go command must have been DELIVERED to a live child - a "
    + "command that never reached its child is reported as undelivered and is never read as a child "
    + "that received it and refused (" + JSON.stringify(goSendFailures) + ")");
  assert.deepEqual([...new Set(goAttempts.map(attempt => attempt.delivered))], [true],
    "W6 iteration " + iteration + ": every go must be positively acknowledged as delivered - a send "
    + "whose return value alone looked acceptable is not a delivered command");
  assert.equal(goAttempts.length, RACE_CHILD_COUNT,
    "W6 iteration " + iteration + ": exactly one go command per child, and no child is commanded twice");
  for (const record of records) {
    assert.equal(record.exited, true,
      "W6 iteration " + iteration + ": every child exit must be OBSERVED, never assumed");
    assert.equal(record.signal, null,
      "W6 iteration " + iteration + ": a cooperating child is never signalled");
    assert.equal(record.exitCode, 0,
      "W6 iteration " + iteration + ": a cooperating child exits 0 after sending its result");
    assert.notEqual(record.result, null,
      "W6 iteration " + iteration + ": every surviving child returns the slice result verbatim");
    assert.equal(childLifecycle(record), "exited-observed",
      "W6 iteration " + iteration + ": a plain observed exit, not a test-caused death");
  }
  // v4: the cleanup join and the store gate, asserted HARD and beside the exit predicates they
  // belong with, so an iteration can never reach the independent-opener tuple below by way of a
  // store it was not entitled to touch. Neither predicate relaxes or replaces any assertion around
  // them: the per-child record.exited assertion above stays exactly as strong as it was.
  assert.equal(cleanupJoinError, null,
    "W6 iteration " + iteration + ": a cleanup signal must itself be JOINED through these same exact "
    + "handles within the unchanged per-child bound - an unjoined cleanup leaves the fate unknown ("
    + JSON.stringify(cleanupJoinError) + ")");
  // v5: a cleanup body that threw is no longer able to end this iteration green. It was caught only
  // so the original error would keep its identity; it is a HARD failure of the iteration here.
  assert.equal(cleanupFailure, null,
    "W6 iteration " + iteration + ": the cleanup body itself must not throw - it is recorded rather "
    + "than propagated so the original error survives, and it fails the iteration here ("
    + JSON.stringify(cleanupFailure) + ")");
  assert.equal(storeObservable, true,
    "W6 iteration " + iteration + ": the store may be read as evidence ONLY after every one of this "
    + "iteration's children has been observed to exit - an unjoined child leaves the owned store "
    + "UNTOUCHED and preserved, and fails the iteration (" + String(notObservedBecause) + ", pids "
    + JSON.stringify(unobservedPids) + ")");
  assert.equal(ledgerReadCalls, 1,
    "W6 iteration " + iteration + ": exactly one independent opener read, and only after every "
    + "observed exit");
  assert.deepEqual(vocabularyErrors, [],
    "W6 iteration " + iteration + ": every loser vocabulary row must record without error");
  // A non-unique winner is a HARD FAILURE, never a retry. There is no retry-to-green anywhere.
  assert.equal(winners.length, 1,
    "W6 iteration " + iteration + ": EXACTLY one ok:true winner, observed " + winners.length);
  assert.equal(losers.length, RACE_CHILD_COUNT - 1,
    "W6 iteration " + iteration + ": every other child must refuse");
  assert.equal(winners[0].generation, 2,
    "W6 iteration " + iteration + ": the winner commits exactly g + 1");
  assert.equal(winners[0].committed, true,
    "W6 iteration " + iteration + ": the winner's COMMIT returned and its close returned");

  // The inert region declares its own reason literals so the control file can evaluate it stand
  // alone; this is the guard that stops that copy and the module constants drifting apart.
  assert.deepEqual(
    [W6_LOSER_REASONS.busy, W6_LOSER_REASONS.commitUncertain, W6_LOSER_REASONS.conflict],
    [REASON_BUSY, REASON_COMMIT_UNCERTAIN, REASON_GENERATION_CONFLICT],
    "W6: the inert-extractable oracle literals must still equal the module reason constants");
  for (const result of losers) {
    assert.deepEqual(w6LoserViolations(result), [],
      "W6 iteration " + iteration + ": loser vocabulary (L91 as superseded by R2-1) admits "
      + "generation_conflict, busy, or a genuine surviving commit_uncertain carrying "
      + "commitAttempted:true, committed:null, retrySafe:false - and NOTHING else");
    assertRetrySafeIsWellFormed(result, "W6 iteration " + iteration + " loser");
  }

  // The INDEPENDENT verifier decides what actually landed. The read itself already happened in
  // the latch above; a FAILED read is asserted as a failed read and is never silently treated as
  // "zero rows", so no iteration can be called clean on the strength of an observation that did
  // not succeed.
  // Unchanged in strength, and now the same function the inert control file drives: a failed read,
  // a generation other than g + 1, a second row, a row under any key but the unique confirmed
  // winner, or a surviving hot sidecar each remain a HARD FAILURE. This is also what bounds an
  // admitted commit_uncertain loser - the uncertainty is allowed to stand only while this tuple
  // still holds (ORACLE-REVIEW N3).
  assert.deepEqual(
    w6LedgerViolations(latch, { generation: 2, winnerKey: winners[0].key }), [],
    "W6 iteration " + iteration + ": the independent opener tuple, ledgerError "
    + JSON.stringify(latch.ledgerError));

  // Sealed only now, after every assertion above has passed.
  latch.status = "passed";
  return latch;
}

test("W6 concurrent writers: exactly one winner in every iteration", async () => {
  const startedAt = Date.now();
  const iterations = [];
  // Seeded BEFORE the first iteration so the per-iteration latch has somewhere durable to write
  // and the case evidence survives a failing iteration. status stays "incomplete" until every
  // assertion in this test has passed: a partial pass is never dressed up as a complete one, and
  // the 20 x 8 requirement is not relaxed by the case being recorded.
  evidence.cases.W6 = {
    status: "incomplete",
    platform: process.platform,
    childrenPerIteration: RACE_CHILD_COUNT,
    iterationsRequired: RACE_ITERATIONS,
    iterationsRecorded: 0,
    iterations: [],
    evidenceLatchNote: "every iteration records its 8 child lifecycles, its 8 child outcomes, "
      + "its 7 loser scalars and vocabulary rows, the independent P2 opener generation, row "
      + "count and section keys, and the on-disk inventory BEFORE its first assertion, so a "
      + "stopped iteration still reports what actually landed instead of destroying it.",
  };
  for (let iteration = 1; iteration <= RACE_ITERATIONS; iteration += 1) {
    iterations.push(await runRaceIteration(iteration));
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(iterations.length, RACE_ITERATIONS,
    "W6: exactly " + RACE_ITERATIONS + " iterations must run on this OS");
  // A recorded iteration is not a passed iteration. Both counts are asserted, so a run that
  // stopped partway can never be read as a complete pass.
  assert.equal(evidence.cases.W6.iterations.length, RACE_ITERATIONS,
    "W6: exactly " + RACE_ITERATIONS + " iterations must be RECORDED on this OS");
  assert.deepEqual([...new Set(evidence.cases.W6.iterations.map(entry => entry.status))], ["passed"],
    "W6: every recorded iteration must have completed its assertions - an iteration left "
    + "incomplete is a stopped iteration, never a whole pass");
  assert.deepEqual([...new Set(iterations.map(entry => entry.childrenObserved))], [RACE_CHILD_COUNT],
    "W6: every iteration observes exactly " + RACE_CHILD_COUNT + " children");
  assert.deepEqual([...new Set(iterations.map(entry => entry.ledgerRead))], [true],
    "W6: every iteration must have actually read the independent opener");
  assert.deepEqual([...new Set(iterations.map(entry => entry.winners))], [1],
    "W6: every iteration has exactly one winner");
  assert.deepEqual([...new Set(iterations.map(entry => entry.generationAfter))], [2],
    "W6: every iteration ends at generation exactly g + 1");
  assert.deepEqual([...new Set(iterations.map(entry => entry.rowsAfter))], [1],
    "W6: every iteration ends with exactly one new row");
  assert.equal(elapsedMs < SUITE_RACE_BUDGET_MS, true,
    "W6: the race must complete inside the declared suite budget, took " + elapsedMs + "ms");

  const reasonsObserved = [...new Set(iterations.flatMap(entry => entry.loserReasons))].sort();
  for (const reason of reasonsObserved) {
    assert.equal(
      reason === REASON_GENERATION_CONFLICT
      || reason === REASON_BUSY
      || reason === REASON_COMMIT_UNCERTAIN, true,
      "W6: the loser vocabulary is closed to generation_conflict, busy and commit_uncertain, "
      + "observed " + String(reason));
  }

  // Augmented in place, NEVER reassigned: replacing the object here would discard the latched
  // per-iteration records that the whole point of this restructure was to preserve.
  Object.assign(evidence.cases.W6, {
    status: "passed",
    platform: process.platform,
    childrenPerIteration: RACE_CHILD_COUNT,
    iterationsRequired: RACE_ITERATIONS,
    iterationsRun: iterations.length,
    retriesUsed: 0,
    elapsedMs,
    suiteRaceBudgetMs: SUITE_RACE_BUDGET_MS,
    loserReasonsObserved: reasonsObserved,
    cooperationNote: "cooperating writers against owned local throwaway roots only. Hostile paths, "
      + "symlink/TOCTOU, case-alias and path-identity behaviour, remote filesystems and multi-host "
      + "locking are OUT (section 7); the case-insensitive default volumes of the macOS and Windows "
      + "runners are exercised, and only alias equivalence is unclaimed.",
    retryPolicy: "no retry, no retry-to-green: a non-unique winner, a generation other than g + 1 "
      + "or more than one new row is a hard failure",
    vocabularyNote: "the loser vocabulary is CLOSED to generation_conflict, busy and "
      + "experimental_store_commit_uncertain. commit_uncertain is admitted ONLY as the exact R2-1 "
      + "tuple returned by a SURVIVING child - commitAttempted:true, committed:null, "
      + "retrySafe:false - because L151 makes a throw raised BY COMMIT dominate classification "
      + "whatever err.code reports, INCLUDING a BUSY code, and L131 makes that supersede the L91 "
      + "conflict-or-busy phrasing. The section 3 busy row still covers BEGIN IMMEDIATE and "
      + "pre-COMMIT statements only. That result stays UNKNOWN: it is never relabelled retryable "
      + "and never relabelled not-committed. Exactly-once is proven INDEPENDENTLY by the opener "
      + "tuple - one winner, generation exactly g + 1, exactly one new row under the winner key - "
      + "so a commit_uncertain loser beside a broken read or a broken tuple remains a hard "
      + "failure, and no missing child result is ever synthesized into it (R2-2, L167). No retry, "
      + "no busy_timeout, no PRAGMA and no journal_mode change is introduced here.",
  });
  maybeForceFail("W6");
});

// --- W6-R: additive, DETERMINISTIC lock-contention instrumentation, a SEPARATE case from W6 -------
//
// ADDITIVE. W6 above is untouched: its 20 x 8 race, its exactly-one-winner oracle, its closed loser
// vocabulary and its independent-opener tuple are exactly as written, and stay exactly as written
// whether they are green or red. Nothing here relaxes an acceptance threshold, and none of the
// oracle-relaxation, BEGIN EXCLUSIVE or retry options discussed elsewhere is implemented: no retry,
// no busy_timeout, no PRAGMA, no journal-mode change, no skip and no continue-on-error appears
// below, and write-cas.cjs, write-child.cjs, states.cjs and recovery-observe.cjs are not edited.
//
// What this case adds is ONE controlled observation with ONE writer and ONE owned peer, so that a
// contention outcome can be read off a deterministic arrangement instead of an 8-way scramble.
//
//   CONTROL      - an owned native peer holds a READ transaction on a READ-ONLY handle. The actual
//                  unmodified writer is then invoked, in-process and with NO seam set, and its exact
//                  result and cleanup metadata are measured. The store is re-read afterwards through
//                  the INDEPENDENT P2 opener, never through the slice.
//   DISCRIMINATOR - the tester's OWN declared fixture connection holds the write-intent lock while
//                  the peer observes its own immediate start FAIL. Only after that refused attempt
//                  has been VERIFIED against the parent's challenge is the fixture released and the
//                  writer invoked, and the outcome recorded.
//
// WHAT THIS DOES NOT ESTABLISH, stated here rather than buried in the evidence:
//   - The read/retention result is ONE DISCRIMINATING OBSERVATION. It is NOT proof that the same
//     lock holder caused any earlier W6 outcome.
//   - A successful commit after the fixture is released does NOT uniquely prove release latency. It
//     is consistent with that reading and with others, and the arm says so instead of choosing.
//   - No lock-hold DURATION is measured, and no timing threshold is proposed or implied.
//   - No byte-identity claim is made across the writer's call: R2-2 bounds byte preservation to the
//     clean W5 (a)-(e) fixtures where the open itself fails, and both arms open successfully, so the
//     before/after observation is RECORDED and deliberately NOT asserted.
//   - Nothing about win32 internals, better-sqlite3 internals, power loss, fsync, durability, D1,
//     D2 or D3.
//
// The writer runs IN-PROCESS on purpose. A forked child would cross the Node IPC JSON boundary,
// which destroys result.error and result.cleanupError - the exact cleanup facts this case exists to
// measure. In-process there is no such boundary, and the peer, which does cross it, projects every
// cause it observes to explicit scalars before sending so nothing of its own is lost either.

// The closed peer mode vocabulary, authored HERE from the protocol prose rather than imported from
// lock-hold-child.cjs, so a green run cannot mean self-agreement.
const W6R_MODE_READ_TXN = "read_txn";
const W6R_MODE_FAILED_BEGIN = "failed_begin";

// Exactly one owned peer per arm, and exactly two arms. T names both of these in its child total,
// which is a DECLARED arithmetic change and not a relaxation: that assertion stays exact.
const W6R_CONTROL_PEERS = 1;
const W6R_DISCRIMINATOR_PEERS = 1;

// A hard bound on the IPC failure evidence a single peer may accumulate. The protocol sends exactly
// two commands, so a healthy arm never approaches this; it exists so that a channel erroring in a
// loop is REFUSED rather than allowed to grow without limit. Dropping past the cap is itself
// visible, because the cap is larger than the protocol and any list at it is already a failure.
const W6R_IPC_EVIDENCE_CAP = 8;

// The owned peer handle. It deliberately does NOT reuse spawnChild: that function forks
// write-child.cjs and installs the W7x fd1 marker machinery, and neither belongs to a peer that
// never calls the writer and writes no marker. Everything that must stay shared IS shared - the
// liveChildren set, the spawned/reaped accounting, attachOwnedKill, childLifecycle and
// lifecycleFacts - so this peer is audited by the same T oracle as every other child.
function spawnLockHoldPeer() {
  const child = fork(LOCK_HOLD_CHILD_SOURCE, [], {
    cwd: SLICE_DIR,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const record = {
    pid: child.pid,
    ready: false,
    // The peer never calls the writer, so it returns no mutation result at any point in its life.
    // result stays null, which is what lets it share lifecycleFacts with the write children.
    result: null,
    exitCode: null,
    signal: null,
    exited: false,
    killRequested: false,
    killDelivered: null,
    killError: null,
    cleanupCalls: 0,
    killedByTest: false,
    stderrHead: "",
    experimentalKills: 0,
    cleanupKills: 0,
    killIntents: [],
    simulated: false,
    // Protocol state. Each phase is received AT MOST ONCE; a repeat is a RECORDED VIOLATION, never
    // an overwrite, so a second message can never re-decide an earlier one.
    heldReceived: false,
    holdObservation: null,
    releasedReceived: false,
    releaseObservation: null,
    protocolViolations: [],
    // fd1 is piped so the peer inherits no console. It writes NO marker there, so these bytes are
    // COUNTED and drained and never parsed - an unchallenged stream cannot produce a verdict.
    // Draining matters on its own: an unread pipe that filled would block a peer this arm must be
    // able to join.
    stdoutBytes: 0,
    // IPC FAILURE EVIDENCE. A channel error and an undelivered command are FACTS about this arm and
    // are recorded here as scalars, latched with the rest of the arm and then hard-asserted empty.
    // Nothing here is swallowed, nothing here is retried, and an undelivered command is NEVER read
    // as a peer that received it and chose to answer nothing. Both lists are hard bounded, so an
    // erroring channel costs a refusal rather than unbounded memory.
    ipcErrors: [],
    sendAttempts: [],
  };
  const handle = { child, record, simulated: false };
  liveChildren.add(handle);
  evidence.children.spawned += 1;

  child.stderr.on("data", chunk => {
    if (record.stderrHead.length < 1024) record.stderrHead += String(chunk).slice(0, 1024);
  });
  child.stdout.on("data", chunk => {
    record.stdoutBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
  });

  // The ChildProcess 'error' listener, and the reason this arm cannot do without one. A send() whose
  // message cannot be delivered - the usual cause being that the peer already exited, so the channel
  // is closed - does NOT throw at the call site: it reports ASYNCHRONOUSLY. With no callback and no
  // listener that report becomes an 'error' event on an EventEmitter that has none, which Node
  // THROWS as an uncaughtException; no try/catch around the send can contain it, and it would end
  // the run before this arm's evidence latch was ever written - destroying exactly the record that
  // an early-dying peer makes most valuable. This listener keeps that failure inside the arm.
  //
  // It is the BACKSTOP, not the mechanism: sendToPeer below supplies a send callback so an ordinary
  // undelivered command is reported there instead, and this listener then covers what remains - a
  // spawn failure, or a channel error raised outside any send. Either way the failure is recorded,
  // asserted and never absorbed.
  child.on("error", error => {
    if (record.ipcErrors.length >= W6R_IPC_EVIDENCE_CAP) return;
    record.ipcErrors.push({ source: "child_process_error_event", ...observationFailure(error) });
  });

  let announceReady = null;
  let announceHeld = null;
  let announceReleased = null;
  handle.ready = new Promise(resolve => { announceReady = resolve; });
  handle.held = new Promise(resolve => { announceHeld = resolve; });
  handle.released = new Promise(resolve => { announceReleased = resolve; });
  child.on("message", message => {
    if (!message || typeof message !== "object") {
      record.protocolViolations.push("non_object_message");
      return;
    }
    if (message.type === "ready") {
      if (record.ready) { record.protocolViolations.push("duplicate_ready"); return; }
      record.ready = true;
      announceReady(record);
      return;
    }
    if (message.type === "held") {
      if (record.heldReceived) { record.protocolViolations.push("duplicate_held"); return; }
      record.heldReceived = true;
      record.holdObservation = message.observation === undefined ? null : message.observation;
      announceHeld(record.holdObservation);
      return;
    }
    if (message.type === "released") {
      if (record.releasedReceived) { record.protocolViolations.push("duplicate_released"); return; }
      record.releasedReceived = true;
      record.releaseObservation = message.observation === undefined ? null : message.observation;
      announceReleased(record.releaseObservation);
      return;
    }
    record.protocolViolations.push("unknown_message_type");
  });
  handle.exited = new Promise(resolve => {
    child.on("exit", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.exited = true;
      liveChildren.delete(handle);
      evidence.children.reaped += 1;
      resolve(record);
    });
  });
  attachOwnedKill(handle);
  return handle;
}

// The ONE place this case addresses a peer. Both commands route through it, so there is exactly one
// send path and exactly one shape of send evidence, and no second spelling of a send can appear.
//
// A `connected` test ALONE IS RACY and is deliberately not relied on as the fix: the channel can
// close between the test and the call, which is precisely the window an early-dying peer occupies.
// It is kept only to avoid addressing a peer whose exit this parent has ALREADY observed, and its
// value at the moment of the attempt is recorded rather than trusted.
//
// The completeness comes from the CALLBACK. Node reports an undeliverable message to the send
// callback when one is supplied, instead of emitting 'error' on the ChildProcess - so the failure
// arrives here as ordinary data on a promise rather than as an uncaughtException that would abort
// the run. A synchronous throw is caught as well, and the boolean return is RECORDED, never read as
// a verdict: false is not by itself a delivery failure, and the callback is what decides.
//
// The promise settles when the send has been ACKNOWLEDGED one way or the other, so a peer that died
// before being commanded fails at the send - with a recorded cause - instead of the arm waiting out
// a per-child budget for a reply that can never arrive. It RESOLVES ONLY and never rejects, so no
// path through it can throw past the arm's evidence latch. No budget is extended, no send is
// repeated, and no failure is converted into a success.
function sendToPeer(handle, phase, message) {
  const record = handle.record;
  const attempt = {
    phase,
    exitedBeforeSend: record.exited === true,
    connectedBeforeSend: handle.child.connected === true,
    delivered: false,
    returned: null,
    failure: null,
  };
  const capped = record.sendAttempts.length >= W6R_IPC_EVIDENCE_CAP;
  if (!capped) record.sendAttempts.push(attempt);
  if (capped) {
    attempt.failure = {
      source: "send_refused_evidence_cap",
      observed: "send_attempt_evidence_cap_reached",
      diagnostic: "this peer has already accumulated " + W6R_IPC_EVIDENCE_CAP + " send attempts, "
        + "which the two-command protocol cannot produce, so the " + phase + " command is REFUSED",
      note: "OBSERVATION ONLY - a refused command is recorded as refused and is never read as a "
        + "delivered one.",
    };
    return Promise.resolve(attempt);
  }
  if (attempt.exitedBeforeSend || !attempt.connectedBeforeSend) {
    attempt.failure = {
      source: "send_refused_channel_closed",
      observed: "ipc_channel_already_closed",
      diagnostic: "the peer's IPC channel was already closed when the " + phase + " command was due "
        + "(exited " + String(attempt.exitedBeforeSend) + ", connected "
        + String(attempt.connectedBeforeSend) + "), so the command was never sent",
      note: "OBSERVATION ONLY - an undelivered command is recorded as undelivered and is NEVER read "
        + "as a peer that received it and answered nothing.",
    };
    return Promise.resolve(attempt);
  }
  return new Promise(resolve => {
    try {
      attempt.returned = handle.child.send(message, error => {
        if (error === null || error === undefined) attempt.delivered = true;
        else attempt.failure = { source: "send_callback", ...observationFailure(error) };
        resolve(attempt);
      });
    } catch (error) {
      // A synchronous throw out of send() itself. Caught rather than allowed to unwind, for the same
      // reason the 'error' listener exists: this arm reports its failures, it does not escape with
      // them.
      attempt.failure = { source: "send_synchronous_throw", ...observationFailure(error) };
      resolve(attempt);
    }
  });
}

// The ONE place W6, W7 and W7x address a spawned write child. All three go commands route through
// it, so there is exactly one send path for them and exactly one shape of send evidence.
//
// It is sendToPeer's mechanism, reused rather than respelled, minus that function's pre-send
// refusal: `connected` ALONE IS RACY - the channel can close between the test and the call, which
// is precisely the window a dying child occupies - so this helper always ATTEMPTS the send and
// records the pre-send values as observations rather than trusting them as a guard. Completeness
// comes from the CALLBACK: Node reports an undeliverable message to the send callback when one is
// supplied, instead of emitting 'error' on the ChildProcess, so the failure arrives here as
// ordinary data on a promise rather than as an uncaughtException that would abort the run. A
// synchronous throw is caught as well, and the boolean return is RECORDED, never read as a verdict.
//
// A delivered command is TRANSPORT COMPLETION AND NOTHING MORE. It is not an acknowledgement by the
// child, not a receipt of the go, and not a result: every protocol and result gate in every arm
// still has to be satisfied exactly as before. This RESOLVES ONLY and never rejects, so no path
// through it can throw past its arm's evidence latch. No budget is extended, no send is repeated,
// and no failure is converted into a success.
function sendGo(handle, phase, message) {
  const record = handle.record;
  const attempt = {
    phase,
    exitedBeforeSend: record.exited === true,
    connectedBeforeSend: handle.child.connected === true,
    delivered: false,
    returned: null,
    failure: null,
  };
  const capped = record.sendAttempts.length >= W6R_IPC_EVIDENCE_CAP;
  if (!capped) record.sendAttempts.push(attempt);
  if (capped) {
    attempt.failure = {
      source: "send_refused_evidence_cap",
      observed: "send_attempt_evidence_cap_reached",
      diagnostic: "this child has already accumulated " + W6R_IPC_EVIDENCE_CAP + " send attempts, "
        + "which the one-command go protocol cannot produce, so the " + phase + " command is REFUSED",
      note: "OBSERVATION ONLY - a refused command is recorded as refused and is never read as a "
        + "delivered one.",
    };
    return Promise.resolve(attempt);
  }
  return new Promise(resolve => {
    try {
      attempt.returned = handle.child.send(message, error => {
        if (error === null || error === undefined) attempt.delivered = true;
        else attempt.failure = { source: "send_callback", ...observationFailure(error) };
        resolve(attempt);
      });
    } catch (error) {
      // A synchronous throw out of send() itself. Caught rather than allowed to unwind, for the same
      // reason the 'error' listener exists: an arm reports its failures, it does not escape with
      // them - and on the W6 and W7 spans an escape here is not contained anywhere above.
      attempt.failure = { source: "send_synchronous_throw", ...observationFailure(error) };
      resolve(attempt);
    }
  });
}

// The IPC failure facts of a spawned child, projected for an arm's latch. Copied, not referenced, so
// the latched evidence is a snapshot of the arm rather than a live view a later event could edit.
// Kept OUT of lifecycleFacts deliberately: the injected W7x doubles carry no channel and must not be
// given the appearance of one.
function ipcFacts(record) {
  return {
    ipcErrors: record.ipcErrors.map(entry => ({ ...entry })),
    sendAttempts: record.sendAttempts.map(entry => ({ ...entry })),
  };
}

// A cause field as it arrives over IPC, read defensively and projected to scalars. present:false
// means the field itself was absent, which is a MISSING MEASUREMENT; observed:false means the peer
// positively reported that no error occurred; observed:true with code null means an error DID occur
// whose code was not a non-empty string. None of the three is ever collapsed into another, which is
// what stops an IPC-lost Error from masquerading as "no error".
function w6rCause(container, field) {
  const value = container === null || container === undefined ? undefined : container[field];
  if (value === null || value === undefined || typeof value !== "object") {
    return { present: false, observed: null, code: null, errno: null, synthetic: null };
  }
  return {
    present: true,
    observed: value.observed === true ? true : (value.observed === false ? false : null),
    code: codeOf(value.code),
    errno: Object.hasOwn(value, "errno") ? value.errno : null,
    synthetic: value.synthetic === true ? true : (value.synthetic === false ? false : null),
  };
}

// The parent's verification of its OWN challenge, returning [] when the hold is admissible. A peer
// that reports the wrong mode, nonce or pid is REFUSED, never identified and never classified: this
// is not an identity or authorship oracle, and a hostile peer is outside what this fixture observes.
// Pure: it reads nothing outside its two arguments and mutates neither.
function w6rHoldViolations(observation, expected) {
  const out = [];
  if (observation === null || observation === undefined) {
    out.push("no hold observation was received - a missing observation is a FAILED MEASUREMENT and "
      + "is NEVER read as a peer that held nothing");
    return out;
  }
  if (observation.nonce !== expected.nonce) {
    out.push("the peer must echo this parent's exact 32-lowercase-hex challenge, observed "
      + String(observation.nonce));
  }
  if (observation.pid !== expected.pid) {
    out.push("the observation must come from the exact pid this parent forked (" + String(expected.pid)
      + "), observed " + String(observation.pid));
  }
  if (observation.mode !== expected.mode) {
    out.push("the peer must report the exact mode it was commanded (" + String(expected.mode)
      + "), observed " + String(observation.mode));
  }
  if (observation.unmetPrecondition !== null) {
    out.push("the peer reported an UNMET PRECONDITION and therefore held nothing, so this arm "
      + "measured nothing: " + String(observation.unmetPrecondition));
  }
  if (observation.held !== true) {
    out.push("the peer must report a positive hold, observed held " + String(observation.held));
  }
  if (observation.handleOpen !== true) {
    out.push("the peer's own handle must be open at the moment it reports, observed handleOpen "
      + String(observation.handleOpen));
  }
  const options = observation.openOptions === null || observation.openOptions === undefined
    || typeof observation.openOptions !== "object" ? null : observation.openOptions;
  if (options === null || options.timeout !== 0) {
    out.push("the peer must open with timeout 0, so contention is MEASURED rather than waited out - "
      + "a nonzero value would turn this instrument into a hidden wait");
  }
  if (expected.mode === W6R_MODE_READ_TXN) {
    if (options !== null && options.readonly !== true) {
      out.push("the read peer must open READ-ONLY, so it cannot modify the store even by accident");
    }
    if (observation.beginReturned !== true) {
      out.push("the deferred transaction start must have returned, observed beginReturned "
        + String(observation.beginReturned));
    }
    if (w6rCause(observation, "beginError").observed !== false) {
      out.push("the deferred transaction start must report NO error, observed code "
        + String(w6rCause(observation, "beginError").code));
    }
    if (observation.readProbeReturned !== true || observation.readProbeKeyIsString !== true) {
      out.push("the keyed metadata read must have RETURNED A ROW - a deferred start alone takes no "
        + "lock, so an unread row is not a held read transaction, observed returned "
        + String(observation.readProbeReturned) + " keyIsString "
        + String(observation.readProbeKeyIsString));
    }
    if (w6rCause(observation, "readProbeError").observed !== false) {
      out.push("the keyed metadata read must report NO error, observed code "
        + String(w6rCause(observation, "readProbeError").code));
    }
    if (observation.inTransaction !== true) {
      out.push("an OPEN transaction is what holds the lock, observed inTransaction "
        + String(observation.inTransaction));
    }
    return out;
  }
  // The refused-start peer. The refusal must be REAL and NATIVE: a synthetic label here, or an
  // absent cause, would mean the arm froze a state it did not actually observe.
  //
  // READ-WRITE is checked EXPLICITLY, in the same direction the read arm checks read-only. An
  // immediate transaction start on a read-only connection fails FOR BEING READ-ONLY, which is a
  // DIFFERENT FAULT from the write-lock contention this arm exists to observe - and both surface as
  // a thrown error, so the refusal alone does not distinguish them. Distinguishing fault causes is
  // this arm's entire purpose, so the one place the challenge was weaker than the peer's own stated
  // reasoning is closed here. A read-only mix-up would very likely also be caught by the
  // SQLITE_BUSY code check below, since a read-only violation reports SQLITE_READONLY; that is a
  // second line of defence and not a reason to leave the first one unstated. The null case is
  // already reported by the timeout check above and is deliberately not reported twice.
  if (options !== null && options.readonly === true) {
    out.push("the refused-start peer must open READ-WRITE - a read-only connection refuses an "
      + "immediate start FOR BEING READ-ONLY, which is a different fault from the write-lock "
      + "contention this arm measures, observed readonly " + String(options.readonly));
  }
  if (observation.beginReturned !== false) {
    out.push("the immediate transaction start must NOT have returned - the parent's own fixture was "
      + "holding the write-intent lock, so a return means the precondition did not hold, observed "
      + "beginReturned " + String(observation.beginReturned));
  }
  const beginCause = w6rCause(observation, "beginError");
  if (beginCause.present !== true || beginCause.observed !== true) {
    out.push("an error must ACTUALLY have been observed on the refused start: observed:false is no "
      + "error at all and an absent field is a missing measurement, and neither is the same fact as "
      + "a cause whose code did not survive, observed present " + String(beginCause.present)
      + " observed " + String(beginCause.observed));
  }
  if (beginCause.code !== "SQLITE_BUSY") {
    out.push("the refused start carries the primary SQLITE_BUSY verbatim, observed "
      + String(beginCause.code));
  }
  if (beginCause.synthetic !== false) {
    out.push("this must be a REAL NATIVE refusal, never a synthetic one and never an unlabelled "
      + "one, observed synthetic " + String(beginCause.synthetic));
  }
  if (observation.rollbackAttempted !== false) {
    out.push("a refused start leaves nothing to discard, so the peer must have attempted none, "
      + "observed rollbackAttempted " + String(observation.rollbackAttempted));
  }
  return out;
}

// The release oracle: the peer must have actually let go, because an unreleased lock would confound
// the store observations that follow AND, on win32, would make the owned root unremovable.
function w6rReleaseViolations(observation) {
  const out = [];
  if (observation === null || observation === undefined) {
    out.push("no release observation was received - a missing observation is a FAILED MEASUREMENT "
      + "and is NEVER read as a peer that let go");
    return out;
  }
  if (observation.handleConstructed !== true) {
    out.push("the release must describe a handle that was actually constructed, observed "
      + String(observation.handleConstructed));
  }
  if (observation.closeAttempted !== true) {
    out.push("the peer must actually attempt its close - an unattempted close is never a released "
      + "lock, observed closeAttempted " + String(observation.closeAttempted));
  }
  const rollbackCause = w6rCause(observation, "rollbackError");
  if (rollbackCause.observed !== false) {
    out.push("the peer's transaction discard must return without throwing, observed code "
      + String(rollbackCause.code));
  }
  const closeCause = w6rCause(observation, "closeError");
  if (closeCause.observed !== false) {
    out.push("the peer's close must return without throwing, observed code "
      + String(closeCause.code));
  }
  if (observation.inTransaction !== false) {
    out.push("no transaction may remain open on the peer's handle after its release, observed "
      + String(observation.inTransaction));
  }
  if (observation.handleOpen !== false) {
    out.push("the peer's handle must be CLOSED after its release - an open handle is an unreleased "
      + "lock and, on win32, an unremovable root, observed handleOpen "
      + String(observation.handleOpen));
  }
  return out;
}

// SOURCE-BACKED SCALAR PROJECTION of the writer's result, and the ONLY shape W6-R records.
//
// The raw result is deliberately NOT pushed into the evidence. result.error, and the members of
// result.cleanupError, are Error objects whose message, stack and name are all non-enumerable, so
// JSON.stringify turns each of them into {} - the same silent cause-side loss the IPC boundary
// inflicts on a race child result. Recording explicit scalars instead is what keeps a native cause
// visible AS native.
//
// cleanupError is read WITHOUT ever being dereferenced unconditionally. cleanupErrorMap in the slice
// returns undefined when BOTH the rollback and the close returned, and materialize then OMITS the
// key - so on a clean cleanup the key is ABSENT, and it is NOT present-and-null. Reading
// cleanupError.rollback straight off the result would therefore throw on exactly the outcome this
// case most expects. Only the two member names the slice actually builds, rollback and close, are
// named here; no field is invented, and no value is read out of a container before that container
// has been proven to be a non-null object.
function w6rResultProjection(result) {
  if (result === null || result === undefined) {
    return {
      resultReceived: false,
      note: "no result object - a failed invocation is a FAILED MEASUREMENT and is never recorded "
        + "as an outcome the writer produced",
    };
  }
  const errorKeyPresent = Object.hasOwn(result, "error");
  const errorValue = errorKeyPresent ? result.error : undefined;
  const errorIsObject = errorValue !== null && errorValue !== undefined
    && typeof errorValue === "object";
  const cleanupKeyPresent = Object.hasOwn(result, "cleanupError");
  const cleanupValue = cleanupKeyPresent ? result.cleanupError : undefined;
  const cleanupIsObject = cleanupValue !== null && cleanupValue !== undefined
    && typeof cleanupValue === "object";
  const memberSynthetic = (name) => {
    if (!cleanupIsObject || !Object.hasOwn(cleanupValue, name)) return null;
    const member = cleanupValue[name];
    if (member === null || member === undefined || typeof member !== "object") return null;
    return member.synthetic === true;
  };
  return {
    resultReceived: true,
    ok: result.ok === true,
    reason: result.reason === undefined ? null : result.reason,
    detail: result.detail === undefined ? null : result.detail,
    sqliteCodeKeyPresent: Object.hasOwn(result, "sqliteCode"),
    sqliteCode: codeOf(result.sqliteCode),
    extendedCodeObserved: isExtendedCode(codeOf(result.sqliteCode)),
    errnoKeyPresent: Object.hasOwn(result, "errno"),
    errno: Object.hasOwn(result, "errno") ? result.errno : null,
    commitAttempted: result.commitAttempted === undefined ? null : result.commitAttempted,
    committedKeyPresent: Object.hasOwn(result, "committed"),
    committed: Object.hasOwn(result, "committed") ? result.committed : null,
    retrySafe: result.retrySafe === undefined ? null : result.retrySafe,
    generation: result.generation === undefined ? null : result.generation,
    section: result.section === undefined ? null : result.section,
    key: result.key === undefined ? null : result.key,
    requestId: result.requestId === undefined ? null : result.requestId,
    // The native-versus-synthetic label, read from the observed value alone. A native fault carries
    // no such property, so this is false for it; only a deliberately labelled synthetic reports true.
    errorKeyPresent,
    errorIsObject,
    errorSynthetic: errorIsObject ? errorValue.synthetic === true : null,
    errorCode: errorIsObject ? codeOf(errorValue.code) : null,
    // CLEANUP, as the source actually shapes it.
    cleanupErrorKeyPresent: cleanupKeyPresent,
    cleanupErrorIsNull: cleanupKeyPresent && cleanupValue === null,
    cleanupErrorIsObject: cleanupIsObject,
    cleanupRollbackKeyPresent: cleanupIsObject && Object.hasOwn(cleanupValue, "rollback"),
    cleanupCloseKeyPresent: cleanupIsObject && Object.hasOwn(cleanupValue, "close"),
    cleanupRollbackSynthetic: memberSynthetic("rollback"),
    cleanupCloseSynthetic: memberSynthetic("close"),
    cleanupProjectionPolicy: "cleanupErrorMap returns undefined when BOTH the rollback and the close "
      + "returned, and materialize omits an undefined entry, so a CLEAN cleanup means the "
      + "cleanupError KEY IS ABSENT - not present-and-null. Presence is therefore tested with "
      + "Object.hasOwn and nothing is dereferenced before its container is proven to be a non-null "
      + "object. Only rollback and close, the two members the slice actually builds, are ever named.",
    representationPolicy: "scalars only. The raw result is NEVER serialized into this evidence: "
      + "Error message, stack and name are non-enumerable, so a retained cause would arrive as {} "
      + "and a real native failure would read as an empty object.",
  };
}

// The CONTROL oracle. Strict and CLOSED: the unmodified writer, invoked with NO seam set against a
// store whose only other holder is the peer's read transaction, must meet that holder AT COMMIT and
// report the exact R2-1 uncertain tuple. This is deliberately NOT relaxed to "busy or uncertain": a
// PRE-COMMIT busy would mean the write-intent lock was refused rather than the commit, which is a
// DIFFERENT observation, and it is reported as a failure of this arm rather than absorbed by it.
function w6rControlViolations(result) {
  const out = [];
  if (result === null || result === undefined) {
    out.push("no writer result - a failed invocation is a FAILED MEASUREMENT and is NEVER evidence "
      + "about what the writer does under contention");
    return out;
  }
  if (result.ok !== false) {
    out.push("the writer must refuse while a read transaction is held, observed ok "
      + String(result.ok));
    return out;
  }
  if (result.reason !== REASON_COMMIT_UNCERTAIN) {
    out.push("the reason is exactly experimental_store_commit_uncertain - R2-1 makes a throw raised "
      + "BY COMMIT dominate classification whatever err.code reports, INCLUDING a BUSY code, and the "
      + "section 3 busy row covers the immediate begin and the pre-commit statements only - observed "
      + String(result.reason));
    return out;
  }
  if (result.commitAttempted !== true) {
    out.push("commit_uncertain requires commitAttempted:true as an established fact, observed "
      + String(result.commitAttempted));
  }
  if (!Object.hasOwn(result, "committed") || result.committed !== null) {
    out.push("commit_uncertain leaves the outcome UNKNOWN: committed must be PRESENT and null, "
      + "never relabelled false and never absent, observed " + String(result.committed));
  }
  if (result.retrySafe !== false) {
    out.push("commit_uncertain is NEVER retry-safe, observed retrySafe " + String(result.retrySafe));
  }
  if (codeOf(result.sqliteCode) !== "SQLITE_BUSY") {
    out.push("the commit-phase contention carries the primary SQLITE_BUSY VERBATIM, observed "
      + String(result.sqliteCode));
  }
  return out;
}

// The DISCRIMINATOR oracle. Exactly two branches are admissible and each is FULLY specified; a
// result matching neither is a HARD FAILURE. This is a closed admissible set, not a relaxation:
// neither branch tolerates a partial tuple, and neither is reachable by relabelling the other -
// retained cannot be reached by calling an uncertain commit successful, and released cannot be
// reached by calling a refusal a commit. Which branch held is RECORDED; what it means is not
// decided here.
function w6rDiscriminatorBranch(result) {
  if (result === null || result === undefined) {
    return {
      branch: null,
      violations: ["no writer result - a failed invocation is a FAILED MEASUREMENT and discriminates "
        + "nothing"],
    };
  }
  if (result.ok === true) {
    const out = [];
    if (result.commitAttempted !== true) {
      out.push("a successful write records commitAttempted:true, observed "
        + String(result.commitAttempted));
    }
    if (result.committed !== true) {
      out.push("a successful write records committed:true, observed " + String(result.committed));
    }
    if (result.generation !== 2) {
      out.push("the winner commits exactly g + 1 (2), observed " + String(result.generation));
    }
    if (result.section !== TARGET_SECTION) {
      out.push("the write targets the named section (" + TARGET_SECTION + "), observed "
        + String(result.section));
    }
    if (typeof result.key !== "string" || result.key === "") {
      out.push("a successful write names its key, observed " + String(result.key));
    }
    if (Object.hasOwn(result, "retrySafe")) {
      out.push("a successful result carries no retrySafe field, observed "
        + String(result.retrySafe));
    }
    return { branch: "released", violations: out };
  }
  const out = [];
  if (result.reason !== REASON_COMMIT_UNCERTAIN) {
    out.push("a refusal on this arm is admissible ONLY as experimental_store_commit_uncertain - any "
      + "other refusal means neither branch was observed and the arm discriminated nothing, observed "
      + String(result.reason));
    return { branch: null, violations: out };
  }
  if (result.commitAttempted !== true) {
    out.push("commit_uncertain requires commitAttempted:true as an established fact, observed "
      + String(result.commitAttempted));
  }
  if (!Object.hasOwn(result, "committed") || result.committed !== null) {
    out.push("commit_uncertain leaves the outcome UNKNOWN: committed must be PRESENT and null, "
      + "never relabelled false and never absent, observed " + String(result.committed));
  }
  if (result.retrySafe !== false) {
    out.push("commit_uncertain is NEVER retry-safe, observed retrySafe " + String(result.retrySafe));
  }
  if (codeOf(result.sqliteCode) !== "SQLITE_BUSY") {
    out.push("the commit-phase contention carries the primary SQLITE_BUSY VERBATIM, observed "
      + String(result.sqliteCode));
  }
  return { branch: "retained", violations: out };
}

// The independent-opener tuple for a W6-R arm, at the SAME strength W6 applies to its own: a read
// that ACTUALLY succeeded, the exact seven-key ledger, the exact generation, the exact row count,
// the exact section keys, and no hot sidecar. A broken read or a broken tuple stays a HARD FAILURE
// and is never reported as "nothing landed". Pure: every expectation is supplied by the caller.
function w6rLedgerViolations(latch, expected) {
  const out = [];
  if (latch === null || latch === undefined || latch.ledgerRead !== true) {
    out.push("the independent opener must actually read the store - a failed read is a failed "
      + "measurement, NEVER evidence that nothing landed");
    return out;
  }
  if (latch.inventoryError !== null) {
    out.push("the on-disk inventory must actually be observed - inventoryError must be PRESENT and "
      + "exactly null, never absent, observed " + String(latch.inventoryError));
  }
  if (JSON.stringify(latch.ledgerKeysAfter) !== JSON.stringify(expected.ledgerKeys)) {
    out.push("the reconstructed ledger carries exactly the expected key set, observed "
      + JSON.stringify(latch.ledgerKeysAfter));
  }
  if (latch.generationAfter !== expected.generation) {
    out.push("the opener reports generation exactly " + String(expected.generation) + ", observed "
      + String(latch.generationAfter));
  }
  if (latch.rowsAfter !== expected.rows) {
    out.push("the opener reports exactly " + String(expected.rows) + " row(s) across every section, "
      + "observed " + String(latch.rowsAfter));
  }
  if (JSON.stringify(latch.sectionKeysAfter) !== JSON.stringify(expected.sectionKeys)) {
    out.push("the target section carries exactly the expected keys ("
      + JSON.stringify(expected.sectionKeys) + "), observed "
      + JSON.stringify(latch.sectionKeysAfter));
  }
  const hot = Array.isArray(latch.sidecarsAfter) ? latch.sidecarsAfter : null;
  if (hot === null || hot.length !== 0) {
    out.push("no hot sidecar survives the arm, observed " + JSON.stringify(latch.sidecarsAfter));
  }
  return out;
}

const W6R_SORTED_LEDGER_KEYS = [...EXPECTED_LEDGER_KEYS].sort();

// One bounded orchestration, shared by both arms, so there is exactly one code path that spawns a
// peer, verifies a hold, invokes the writer, releases and joins. Every phase is budgeted by the
// existing PER_CHILD_TIMEOUT_MS; a budget expiry is a FAILURE of the arm, never a retry and never an
// acceptance. Nothing is signalled on the success path.
async function runW6RArm(spec) {
  const store = newStore("w6r-" + spec.label);
  const nonce = newSeamNonce();
  let beforeArm = null;
  let beforeArmError = null;
  try {
    beforeArm = snapshotRoot(store.storeRoot);
  } catch (error) {
    beforeArmError = observationFailure(error);
  }

  // The tester's OWN declared fixture connection, used by the discriminator arm only. W9 scopes the
  // single-writer oracle to the RUNTIME leaf precisely so that a tester-owned fixture connection on
  // a root this suite created is legitimate. It issues the write-intent start and the discard and NO
  // data statement of any kind, so it modifies nothing, and it is labelled a fixture in the evidence
  // rather than presented as a measurement of the slice.
  let fixtureHandle = null;
  const fixtureFacts = {
    used: spec.holdsFixture === true,
    role: "TESTER-OWNED FIXTURE holder, not the slice and not a measurement of it. It takes the "
      + "write-intent lock and discards it; it writes no row and commits nothing.",
    opened: false,
    beginReturned: false,
    openError: null,
    rollbackAttempted: false,
    rollbackError: null,
    closeAttempted: false,
    closeError: null,
    handleOpenAfterRelease: null,
    released: false,
  };
  const releaseFixture = () => {
    if (fixtureHandle === null) return;
    const handleToRelease = fixtureHandle;
    fixtureHandle = null;
    if (handleToRelease.inTransaction === true) {
      fixtureFacts.rollbackAttempted = true;
      try {
        handleToRelease.exec("ROLLBACK");
      } catch (error) {
        fixtureFacts.rollbackError = observationFailure(error);
      }
    }
    fixtureFacts.closeAttempted = true;
    try {
      handleToRelease.close();
    } catch (error) {
      fixtureFacts.closeError = observationFailure(error);
    }
    fixtureFacts.handleOpenAfterRelease = handleToRelease.open === true;
    fixtureFacts.released = fixtureFacts.rollbackError === null
      && fixtureFacts.closeError === null
      && fixtureFacts.handleOpenAfterRelease === false;
  };

  const handle = spawnLockHoldPeer();
  const expectation = { mode: spec.mode, nonce, pid: handle.child.pid };
  let readyError = null;
  let holdSendFailure = null;
  let releaseSendFailure = null;
  let holdError = null;
  let holdObservation = null;
  let holdViolations = ["the hold phase did not run"];
  let fixtureReleasedBeforeWriter = null;
  let writerInvoked = false;
  let result = null;
  let callError = null;
  let releaseError = null;
  let releaseObservation = null;
  let joinError = null;
  let cleanupJoinError = null;
  // v5: a throw out of the CLEANUP BODY itself is RECORDED here rather than propagated, so an
  // original try-body error keeps its identity. Latched and asserted below - never swallowed.
  let cleanupFailure = null;
  // v5: the preservation decision is now taken inside the finally below so the body-throw and
  // cleanup-throw paths reach it too. Declared here so the latch and assertions still read it.
  let preservation = null;

  try {
    // PHASE 1, discriminator only: the tester's own fixture takes the write-intent lock FIRST, so
    // the peer's attempt below is guaranteed to meet it rather than racing it.
    if (spec.holdsFixture) {
      try {
        fixtureHandle = new Database(store.dbPath, { fileMustExist: true, timeout: 0 });
        fixtureFacts.opened = true;
        fixtureHandle.exec("BEGIN IMMEDIATE");
        fixtureFacts.beginReturned = true;
      } catch (error) {
        fixtureFacts.openError = observationFailure(error);
      }
    }

    // PHASE 2: the peer announces itself, then is commanded exactly once. The announcement and the
    // command are now two RECORDED steps rather than one, because they fail for different reasons
    // and an arm that cannot say which of them failed has lost the measurement. The command's
    // DELIVERY is awaited inside the existing per-child budget - no new budget, no extension - so a
    // peer that died between announcing and being commanded fails HERE, with a recorded cause,
    // instead of raising a channel error this arm could not contain.
    try {
      await withDeadline(handle.ready, PER_CHILD_TIMEOUT_MS, "W6-R " + spec.label + " ready");
    } catch (error) {
      readyError = observationFailure(error);
    }
    if (readyError === null) {
      try {
        const holdAttempt = await withDeadline(
          sendToPeer(handle, "hold", { type: "hold", mode: spec.mode, dbPath: store.dbPath, nonce }),
          PER_CHILD_TIMEOUT_MS, "W6-R " + spec.label + " hold command",
        );
        holdSendFailure = holdAttempt.failure;
      } catch (error) {
        holdSendFailure = observationFailure(error);
      }
    }

    // PHASE 3: the single hold observation, verified against this parent's own challenge. It is
    // waited for ONLY when the command was actually delivered: waiting for a reply to a command the
    // peer never received would spend a per-child budget to learn what the send already reported,
    // and holdViolations then stays at its "the hold phase did not run" default, which is a
    // violation and therefore a failure - never an empty list that could read as a clean hold.
    if (readyError === null && holdSendFailure === null) {
      try {
        holdObservation = await withDeadline(
          handle.held, PER_CHILD_TIMEOUT_MS, "W6-R " + spec.label + " hold",
        );
      } catch (error) {
        holdError = observationFailure(error);
      }
      holdViolations = holdError === null
        ? w6rHoldViolations(holdObservation, expectation)
        : ["the hold observation never arrived inside the per-child budget"];
    }

    // PHASE 4, discriminator only: the fixture lets go, and ONLY AFTER the peer's refused attempt
    // has been VERIFIED. Releasing earlier would let the peer's own start succeed; not releasing at
    // all would make the writer meet the fixture instead of the peer, which is a different
    // measurement wearing this arm's name.
    if (spec.holdsFixture && holdViolations.length === 0) {
      releaseFixture();
      fixtureReleasedBeforeWriter = fixtureFacts.released;
    }

    // PHASE 5: the ACTUAL, UNMODIFIED writer, in-process, with NO seam set (cleanCall deletes every
    // seam variable first). It runs ONLY when the hold was positively verified and, on the
    // discriminator arm, only when the fixture actually let go - a writer invoked against an
    // unverified arrangement measures nothing and must not be recorded as if it did.
    const preconditionsMet = readyError === null && holdError === null
      && holdViolations.length === 0
      && (spec.holdsFixture !== true || fixtureFacts.released === true);
    if (preconditionsMet) {
      writerInvoked = true;
      try {
        result = cleanCall(store.storeRoot, callOptions({
          mutation: mutationOf(spec.mutationKey, { arm: spec.arm }),
        }));
      } catch (error) {
        callError = observationFailure(error);
      }
    }

    // PHASE 6: cooperative release, then JOIN. No signal is issued anywhere on this path.
    //
    // This is the WIDEST window in the arm: it spans the entire writer call, including a commit that
    // is DESIGNED to block on a lock. It is therefore the one place the peer is most likely to have
    // died before the parent speaks to it again - a native fault, an exhausted process, or a throw
    // out of the peer's own handle reads - which is exactly the shape that used to escape this arm
    // as an uncaught channel error and take the evidence latch down with it. The command goes
    // through the same acknowledged send, and the reply is waited for ONLY when the command was
    // delivered. The JOIN below runs either way, so the peer's fate is established on every path.
    if (readyError === null) {
      if (holdSendFailure === null) {
        try {
          const releaseAttempt = await withDeadline(
            sendToPeer(handle, "release", { type: "release" }),
            PER_CHILD_TIMEOUT_MS, "W6-R " + spec.label + " release command",
          );
          releaseSendFailure = releaseAttempt.failure;
        } catch (error) {
          releaseSendFailure = observationFailure(error);
        }
        if (releaseSendFailure === null) {
          try {
            releaseObservation = await withDeadline(
              handle.released, PER_CHILD_TIMEOUT_MS, "W6-R " + spec.label + " release",
            );
          } catch (error) {
            releaseError = observationFailure(error);
          }
        }
      }
      try {
        await withDeadline(handle.exited, PER_CHILD_TIMEOUT_MS, "W6-R " + spec.label + " join");
      } catch (error) {
        joinError = observationFailure(error);
      }
    }
  } finally {
    // v5: the ENTIRE cleanup body below is wrapped and the preservation decision moved into an inner
    // finally. v4 took that decision AFTER this block, so a throw out of the try body left the
    // function before reaching it - and a bare tail-of-finally placement would still have been
    // skipped by a throw out of the cleanup body itself (releaseFixture(), handle.kill()). The inner
    // finally is guaranteed on all three paths: normal return, try-body throw, cleanup-body throw.
    try {
    // The fixture is released on EVERY exit path, so a failure above can never leave a tester-owned
    // write-intent lock on the root the finaliser then tries to remove.
    releaseFixture();
    // For a cooperatively released and joined peer the existing exited guard makes this a no-op that
    // issues NO signal, which is what keeps this case's killRequested:false property intact under T.
    // For a peer that never announced or never let go it DOES signal, that cleanup kill is counted
    // as the real signal it is rather than hidden to protect a zero, and it is then JOINED inside
    // the unchanged per-child budget.
    if (!handle.record.exited) {
      handle.kill("cleanup");
      handle.cleanupAttempted = true;
      try {
        await withDeadline(
          handle.exited, PER_CHILD_TIMEOUT_MS, "W6-R " + spec.label + " cleanup join",
        );
      } catch (error) {
        cleanupJoinError = observationFailure(error);
      }
    }
    } catch (error) {
      // RECORDED, never re-thrown: an original try-body error stays the propagating error with its
      // identity intact, and this cleanup failure survives beside it as evidence. Same
      // observationFailure convention cleanupJoinError already uses.
      cleanupFailure = observationFailure(error);
    } finally {
      // v5 PRESERVATION DECISION, taken here so EVERY exit path reaches it - readiness timeout, hold
      // refusal, release failure, unjoined cleanup, a try-body throw or a cleanup-body throw alike.
      // This is the same shared function the finaliser consults, so a peer whose exit was never
      // observed keeps its store instead of having it removed from under a live handle, and
      // clean:false is reported honestly when that happens. It is taken AFTER the bounded cleanup
      // join above, from the OBSERVED record.exited - a requested kill is not an exit.
      //
      // This block only ASSIGNS: it never throws and never returns, so it cannot replace or suppress
      // whichever error is propagating out of the blocks above.
      preservation = registerRootPreservation({
        caseId: "W6-R",
        seam: spec.arm,
        root: store.parent,
        pid: handle.record.pid,
        exited: handle.record.exited,
      });
      // v6: and the cleanup failure is PUBLISHED here, on the same guaranteed path, instead of being
      // left in the local above. When a try-body error is in flight it leaves this function the
      // moment this finally completes, so the latch and the assertion below are never reached and
      // v5's local died with the frame. Appending to the run evidence object is the only record that
      // survives that path. Push only - it cannot throw, cannot return and cannot replace or
      // suppress whichever error is propagating.
      if (cleanupFailure !== null) {
        evidence.cleanupFailures.push({
          caseId: "W6-R",
          seam: spec.arm,
          iteration: null,
          root: store.parent,
          failure: cleanupFailure,
          note: "SECONDARY cleanup-body failure recorded beside the primary error, which keeps its "
            + "identity and still propagates. Recorded in memory and serialised by the finaliser - "
            + "NOT a disk-durability claim.",
        });
      }
    }
  }

  const record = handle.record;

  // ---- FAILURE-SAFE EVIDENCE LATCH: every record below PRECEDES every assertion ----------------
  const rawObserved = {
    pid: record.pid,
    exitCode: record.exitCode,
    signal: record.signal,
    exited: record.exited,
    ready: record.ready,
    heldReceived: record.heldReceived,
    releasedReceived: record.releasedReceived,
    killRequested: record.killRequested,
    killDelivered: record.killDelivered,
    killError: record.killError,
    killedByTest: record.killedByTest,
    lifecycle: childLifecycle(record),
    experimentalKills: record.experimentalKills,
    cleanupKills: record.cleanupKills,
    killIntents: [...record.killIntents],
    protocolViolations: [...record.protocolViolations],
    // Copied, not referenced, so the latched evidence is a snapshot of this arm rather than a live
    // view that a later event could still edit.
    ipcErrors: record.ipcErrors.map(entry => ({ ...entry })),
    sendAttempts: record.sendAttempts.map(entry => ({ ...entry })),
    stderrHead: record.stderrHead === "" ? null : record.stderrHead,
    stdoutBytes: record.stdoutBytes,
  };
  // Exactly ONE lifecycle record per peer, pushed here and nowhere else, so a cleanup pass cannot
  // double-count it.
  evidence.children.records.push({ caseId: "W6-R", arm: spec.arm, ...lifecycleFacts(record) });

  const resultProjection = w6rResultProjection(result);

  // The E1 vocabulary row, recorded HERE and guarded so one failing row cannot discard the rest of
  // the latch. synthetic:false: this is a NATIVE measurement with no seam set, and labelling it
  // synthetic would misdescribe the only native contention evidence in this suite. A SUCCESSFUL
  // writer is not a refusal and contributes no row - recording one would invent a refusal.
  const vocabularyErrors = [];
  if (result !== null && result !== undefined && result.ok !== true) {
    try {
      recordVocabulary("W6-R", spec.arm + ":" + String(result.reason), result, { synthetic: false });
    } catch (error) {
      vocabularyErrors.push({
        arm: spec.arm, reason: String(result.reason), ...observationFailure(error),
      });
    }
  }

  // The owned store is not touched AT ALL until this exact peer's exit has been OBSERVED. A live
  // peer still holds its handle, so an inventory would hash a file a running process has open and a
  // ledger read would be reading underneath it - and both would then be recorded as post-arm state,
  // which they are not. When the join did not happen the arm leaves the store UNTOUCHED, persists
  // the unknown, and fails below.
  const storeObservable = mayObserveRecovery(record);
  let ledgerRead = false;
  let ledgerError = null;
  let generationAfter = null;
  let rowsAfter = null;
  let sectionKeysAfter = null;
  let ledgerKeysAfter = null;
  let inventoryAfter = null;
  let sidecarsAfter = null;
  let inventoryError = null;
  let afterArm = null;
  if (storeObservable) {
    try {
      const ledger = requireLedger(store.dbPath, "W6-R/" + spec.arm);
      generationAfter = ledger.generation;
      rowsAfter = totalSectionRows(ledger);
      sectionKeysAfter = sectionKeys(ledger, TARGET_SECTION);
      ledgerKeysAfter = Object.keys(ledger).sort();
      ledgerRead = true;
    } catch (error) {
      ledgerError = observationFailure(error);
    }
    try {
      inventoryAfter = inventory(store.storeRoot);
      sidecarsAfter = sidecars(store.storeRoot);
      afterArm = snapshotRoot(store.storeRoot);
    } catch (error) {
      inventoryError = observationFailure(error);
    }
  } else {
    ledgerError = {
      observed: "not_observed",
      diagnostic: "the peer's exit was never observed, so the store was deliberately left untouched",
      note: "OBSERVATION ONLY - a store that was never read is recorded as never read and is NEVER "
        + "reported as zero rows",
    };
    inventoryError = ledgerError;
  }

  const branchVerdict = spec.holdsFixture === true ? w6rDiscriminatorBranch(result) : null;
  const latch = {
    arm: spec.arm,
    label: spec.label,
    mode: spec.mode,
    // Explicitly incomplete until every assertion below has passed. A partial arm is recorded as
    // partial and is never dressed up as a complete one to satisfy a downstream gate.
    status: "incomplete",
    synthetic: false,
    nativeLabel: "NATIVE: no seam variable is set on this arm - cleanCall deletes every one of them "
      + "before the call - so every cause recorded here was thrown by the real pinned binding.",
    retriesUsed: 0,
    rawObserved,
    holdExpectation: { mode: expectation.mode, pid: expectation.pid, nonceIsHex: true },
    holdObservation,
    holdViolations,
    readyError,
    holdSendFailure,
    holdError,
    ipcFailurePolicy: "a ChildProcess channel error and an UNDELIVERED command are recorded here as "
      + "the failures they are, BEFORE the assertions below, and are then asserted absent. An "
      + "undelivered command is never read as a peer that received it and answered nothing, no such "
      + "failure is retried, and none is absorbed into a pass.",
    fixture: fixtureFacts,
    fixtureReleasedBeforeWriter,
    writerInvoked,
    callError,
    resultProjection,
    vocabularyErrors,
    releaseObservation,
    releaseViolations: w6rReleaseViolations(releaseObservation),
    releaseSendFailure,
    releaseError,
    joinError,
    cleanupJoinError,
    // v5: a throw out of the cleanup body itself, recorded so it is visible as the failure it is
    // instead of replacing the original try-body error.
    cleanupFailure,
    preservation,
    storeObservable,
    ledgerRead,
    ledgerError,
    generationAfter,
    rowsAfter,
    sectionKeysAfter,
    ledgerKeysAfter,
    inventoryAfter,
    sidecarsAfter,
    inventoryError,
    beforeArm,
    beforeArmError,
    afterArm,
    byteObservation: beforeArm === null || afterArm === null
      ? null : byteObservation(beforeArm, afterArm),
    byteObservationPolicy: "RECORDED, NOT ASSERTED. R2-2 bounds byte identity to the clean W5 "
      + "(a)-(e) fixtures where the open itself fails and no handle is ever constructed; this arm "
      + "opens successfully, so no byte-identity claim is made here.",
    discriminator: branchVerdict === null ? null : {
      branch: branchVerdict.branch,
      violations: branchVerdict.violations,
      interpretationLimit: "RECORDED, NOT CONCLUDED. branch retained is ONE observation that a "
        + "refused write-intent start can leave a lock a later commit meets; it is NOT proof that "
        + "the same holder caused any earlier W6 outcome. branch released is ONE observation that "
        + "the commit succeeded once the tester's own holder let go; a successful commit does NOT "
        + "uniquely prove release latency, and no duration is measured here to support such a claim.",
    },
    zeroRowPolicy: "a missing or failed ledger read is recorded with ledgerRead:false and is NEVER "
      + "reported as zero rows",
    recordingOrder: "every field above was recorded BEFORE the first assertion below",
  };
  evidence.cases["W6-R"].arms.push(latch);

  // ---- ASSERTIONS: hard, no retry, no skip, running against a sealed record --------------------
  const context = "W6-R/" + spec.arm;
  assert.equal(readyError, null, context + ": the owned peer must announce itself inside the "
    + "per-child budget - a budget expiry is a FAILURE of this arm, never a retry ("
    + JSON.stringify(readyError) + ")");
  assert.equal(holdSendFailure, null, context + ": the single hold command must have been DELIVERED "
    + "to a live peer - an undelivered command is a FAILED MEASUREMENT reported as one, never a "
    + "peer that received it and held nothing (" + JSON.stringify(holdSendFailure) + ")");
  assert.equal(holdError, null, context + ": the single hold observation must arrive inside the "
    + "per-child budget (" + JSON.stringify(holdError) + ")");
  assert.deepEqual(holdViolations, [], context + ": the peer's hold must satisfy this parent's own "
    + "challenge and the declared arrangement for this mode");
  if (spec.holdsFixture) {
    assert.equal(fixtureFacts.opened, true,
      context + ": the tester-owned fixture holder must actually open ("
      + JSON.stringify(fixtureFacts.openError) + ")");
    assert.equal(fixtureFacts.beginReturned, true,
      context + ": the tester-owned fixture holder must actually take the write-intent lock");
    assert.equal(fixtureFacts.released, true,
      context + ": the tester-owned fixture holder must have fully let go BEFORE the writer ran - "
      + "otherwise the writer met the fixture rather than the peer and this arm measured the wrong "
      + "arrangement (" + JSON.stringify({
        rollbackError: fixtureFacts.rollbackError, closeError: fixtureFacts.closeError,
        handleOpenAfterRelease: fixtureFacts.handleOpenAfterRelease,
      }) + ")");
    assert.equal(fixtureReleasedBeforeWriter, true,
      context + ": the fixture release must be recorded as having happened before the writer ran");
  } else {
    assert.equal(fixtureFacts.used, false,
      context + ": the control arm uses no fixture holder - the peer's read transaction is the only "
      + "other party on this store");
  }
  assert.equal(writerInvoked, true,
    context + ": the ACTUAL unmodified writer must have been invoked - an arm that never called it "
    + "measured nothing");
  assert.equal(callError, null,
    context + ": the writer must return a result rather than throwing out of the call - a throw here "
    + "is a FAILED MEASUREMENT (" + JSON.stringify(callError) + ")");
  assert.deepEqual(vocabularyErrors, [],
    context + ": the E1 vocabulary row must record without error");

  if (spec.holdsFixture) {
    // The discriminating pair. Exactly one fully specified branch must hold cleanly; a result
    // outside both is a hard failure, and no branch is reachable by relabelling the other.
    assert.notEqual(branchVerdict.branch, null,
      context + ": the outcome must match one of the two fully specified branches - retained "
      + "(commit_uncertain with the exact R2-1 tuple and the primary SQLITE_BUSY) or released "
      + "(ok:true at generation exactly g + 1) - and nothing else");
    assert.deepEqual(branchVerdict.violations, [],
      context + ": the observed branch (" + String(branchVerdict.branch) + ") must hold CLEANLY - a "
      + "partial tuple is a failure, never an admissible variant");
  } else {
    assert.deepEqual(w6rControlViolations(result), [],
      context + ": the unmodified writer must meet the held read transaction AT COMMIT and report "
      + "the exact R2-1 uncertain tuple");
    // The existing R2-1 negative oracle, reused unchanged.
    assertRetrySafeIsWellFormed(result, context);
    // The existing cleanup-cause oracle, reused unchanged. It reads cleanupError through the same
    // null-and-absent-safe projection this file already used for W8, so a CLEAN cleanup - the
    // expected shape here, where the key is absent entirely - is handled rather than dereferenced.
    distinctCauses(result, context, { error: true, rollback: false, close: false });
    assert.equal(resultProjection.errorKeyPresent, true,
      context + ": the original native cause must be RETAINED on the result, not dropped");
    assert.equal(resultProjection.errorSynthetic, false,
      context + ": this contention is a REAL NATIVE failure and must never be labelled synthetic - "
      + "no seam is set on this arm");
    assert.equal(resultProjection.cleanupErrorKeyPresent, false,
      context + ": with both the rollback and the close returning, cleanupErrorMap returns undefined "
      + "and materialize OMITS the key, so cleanupError is ABSENT here - it is not present-and-null, "
      + "and it is never dereferenced to establish that");
    assert.equal(resultProjection.cleanupRollbackKeyPresent, false,
      context + ": no rollback cleanup member exists on a clean cleanup, and none is invented");
    assert.equal(resultProjection.cleanupCloseKeyPresent, false,
      context + ": no close cleanup member exists on a clean cleanup, and none is invented");
  }

  assert.deepEqual(record.protocolViolations, [],
    context + ": the peer must speak the declared protocol exactly - a repeated or unknown message "
    + "is a recorded violation and a failure, never an overwrite");
  assert.deepEqual(rawObserved.ipcErrors, [],
    context + ": the peer's IPC channel must raise NO error. An error here is a FAILURE of this arm "
    + "and is reported from inside its latch, which is the whole point of catching it: unlistened, "
    + "it would surface as an uncaughtException and end the run BEFORE any of this arm's evidence "
    + "was written (" + JSON.stringify(rawObserved.ipcErrors) + ")");
  assert.equal(releaseSendFailure, null,
    context + ": the single release command must have been DELIVERED to a live peer - a command that "
    + "never reached the peer is reported as undelivered and is never read as a peer that refused to "
    + "let go (" + JSON.stringify(releaseSendFailure) + ")");
  assert.deepEqual(rawObserved.sendAttempts.map(entry => entry.phase), ["hold", "release"],
    context + ": exactly two commands are sent to a W6-R peer, in that order - the protocol has no "
    + "third command and no command is ever repeated");
  assert.deepEqual([...new Set(rawObserved.sendAttempts.map(entry => entry.delivered))], [true],
    context + ": both commands must be positively acknowledged as delivered - a send whose return "
    + "value alone looked acceptable is not a delivered command");
  assert.equal(releaseError, null,
    context + ": the peer's single release observation must arrive inside the per-child budget ("
    + JSON.stringify(releaseError) + ")");
  assert.deepEqual(latch.releaseViolations, [],
    context + ": the peer must have fully let go - discard returned, close returned, no transaction "
    + "open and no handle left open");
  assert.equal(joinError, null,
    context + ": the peer's exit must be OBSERVED inside the per-child budget ("
    + JSON.stringify(joinError) + ")");
  assert.equal(cleanupJoinError, null,
    context + ": no cleanup join was needed, so none may have failed ("
    + JSON.stringify(cleanupJoinError) + ")");
  // v5: a cleanup body that threw is no longer able to end this arm green. It was caught only so the
  // original error would keep its identity; it is a HARD failure of the arm here.
  assert.equal(cleanupFailure, null,
    context + ": the cleanup body itself must not throw - it is recorded rather than propagated so "
    + "the original error survives, and it fails the arm here ("
    + JSON.stringify(cleanupFailure) + ")");
  assert.equal(record.exited, true,
    context + ": the peer's exit must be OBSERVED, never assumed");
  assert.equal(record.signal, null,
    context + ": a cooperatively released peer is NEVER signalled");
  assert.equal(record.exitCode, 0,
    context + ": a released peer disconnects and exits 0 by itself");
  assert.equal(record.killRequested, false,
    context + ": this suite requests no kill for a W6-R peer - the release is cooperative and the "
    + "join is what ends the arm");
  assert.equal(childLifecycle(record), "exited-observed",
    context + ": a plain observed exit, not a test-caused death");
  assert.equal(preservation.preserve, false,
    context + ": a joined peer leaves no preserved root, so this arm's owned root cleans up normally "
    + "and the honest preservation fallback stays reserved for an unobserved exit");

  // The INDEPENDENT verifier decides what actually landed, at the same strength W6 applies.
  //
  // DISCLOSURE, because this tuple asserts more than the commit-BUSY reason does. On the control arm
  // the writer reports committed:null - UNKNOWN - and this arm then hard-asserts generation 1 with
  // zero rows, i.e. that nothing landed. Those are two DIFFERENT facts and the second does not
  // convert the first into a certainty: committed:null stays exactly what the writer said, an
  // unresolved self-report, and nothing here rewrites it. What the ledger tuple adds is an
  // INDEPENDENT measurement by the P2 opener of what is actually in the file, which is a different
  // instrument answering a different question.
  //
  // That measurement rests on a premise this suite ASSERTS rather than assumes: journal mode is the
  // SQLite default `delete` rollback journal, asserted by the PRE-EXISTING W1 test, under which a
  // held SHARED read lock prevents the commit from acquiring EXCLUSIVE, so the database file cannot
  // have changed. The coupling is therefore declared, not hidden - and it is a COUPLING: under WAL a
  // reader would not block the commit at all and this arm's whole mechanism would be different. No
  // journal-mode change is introduced anywhere by this case, so the coupling is latent.
  //
  // If a runner ever produced a genuinely uncertain commit that DID land, this assertion goes red.
  // That is the intended and honest outcome - the arm fails loudly rather than absorbing the
  // surprise - and it is stated here so no reader has to discover it from a failure.
  const expectedLedger = spec.holdsFixture !== true || branchVerdict.branch === "retained"
    ? { generation: 1, rows: 0, sectionKeys: [], ledgerKeys: W6R_SORTED_LEDGER_KEYS }
    : { generation: 2, rows: 1, sectionKeys: [spec.mutationKey], ledgerKeys: W6R_SORTED_LEDGER_KEYS };
  assert.deepEqual(w6rLedgerViolations(latch, expectedLedger), [],
    context + ": the independent opener tuple for the observed outcome, ledgerError "
    + JSON.stringify(latch.ledgerError));

  latch.status = "passed";
  return latch;
}

test("W6-R additive lock-contention discriminator: one writer, one owned peer", async () => {
  // Seeded BEFORE the first arm so each arm latch has somewhere durable to write and the case
  // evidence survives a failing arm. status stays "incomplete" until every assertion has passed.
  evidence.cases["W6-R"] = {
    status: "incomplete",
    platform: process.platform,
    arms: [],
    armsRequired: 2,
    peersPerArm: 1,
    separateFromW6: "W6-R is a NEW case, never a relabelling of W6 and never a relaxation of it. "
      + "W6 keeps its 20 x 8 race, its exactly-one-winner oracle, its closed loser vocabulary and "
      + "its independent-opener tuple exactly as written, red or green. No oracle relaxation, no "
      + "BEGIN EXCLUSIVE, no retry, no busy_timeout, no PRAGMA, no journal-mode change, no skip and "
      + "no continue-on-error is introduced by this case.",
    inProcessWriterRationale: "the writer is invoked IN-PROCESS because the Node IPC JSON boundary a "
      + "forked child crosses destroys result.error and result.cleanupError, and those cleanup facts "
      + "are exactly what this case measures. The peer, which does cross that boundary, projects "
      + "every cause it observes to explicit scalars before sending, so nothing of its own is lost "
      + "either and no absent field can pass for 'no error'.",
    coordinationRationale: "the peer is RELEASED COOPERATIVELY over IPC and then JOINED - never "
      + "signalled. A SIGKILLed peer would break the existing T rules that every child outside W7x "
      + "has lifecycle exited-observed with killRequested:false and that the run-wide experimental "
      + "signal total stays exactly one per W7x seam, which would be a relaxation of existing "
      + "acceptance rather than an addition to it. Joining also lets the owned root be removed on "
      + "win32, where an open database handle blocks removal, without weakening cleanup.",
    evidenceLatchNote: "each arm records its raw peer scalars, its lifecycle, the verified hold "
      + "observation, the tester-owned fixture facts, the scalar projection of the writer result "
      + "including its cleanup shape, the release observation and the independent opener ledger - all "
      + "BEFORE its first assertion, so a stopped arm still reports what actually happened.",
    ipcFailureNote: "the latch above is only worth its claim if nothing can abort the arm before it "
      + "is written. An undeliverable IPC command reports ASYNCHRONOUSLY, so with no send callback "
      + "and no 'error' listener it would arrive as an uncaughtException that no try/catch at the "
      + "send site could contain - and the one scenario where the latch is most valuable, a peer "
      + "that died early, is exactly the scenario that would have destroyed it. Both commands "
      + "therefore go through a single acknowledged send whose failure is DATA, and the peer carries "
      + "an 'error' listener as the backstop. A connected check alone would be racy and is not "
      + "relied on. Every such failure is recorded in the arm's latch and asserted there; none is "
      + "swallowed, retried, or allowed to read as a peer that simply said nothing.",
    unmeasuredBoundaries: [
      "the control arm's independent ledger tuple (generation 1, zero rows) is a measurement by the "
      + "P2 opener of what is in the FILE. It rests on the journal mode the PRE-EXISTING W1 test "
      + "already asserts - the SQLite default `delete` rollback journal, under which a held SHARED "
      + "read lock prevents the commit acquiring EXCLUSIVE - and it does NOT turn the writer's own "
      + "committed:null into a certainty: that self-report stays UNRESOLVED. The arm is thereby "
      + "COUPLED to rollback-journal semantics; under WAL a reader would not block the commit and "
      + "the mechanism would differ. No journal-mode change is introduced here",
      "no lock-hold DURATION is measured, and no timing threshold is proposed or implied",
      "the retention/release outcome is ONE DISCRIMINATING OBSERVATION and is NOT proof that the "
      + "same lock holder caused any earlier W6 outcome",
      "a successful commit after the tester's own holder lets go does NOT uniquely prove release "
      + "latency",
      "native ROLLBACK and native close FAILURE behaviour stays UNMEASURED: this case measures a "
      + "clean rollback and a clean close, not a failing one, and asserts nothing about a failing one",
      "no byte-identity claim is made across the writer's call (R2-2 bounds that to the clean W5 "
      + "(a)-(e) fixtures); the before/after observation is RECORDED and not asserted",
      "nothing about win32 internals, better-sqlite3 internals, power loss, fsync, durability, "
      + "multi-host locking, D1, D2 or D3",
    ],
  };

  const arms = [];
  // The CONTROL arm first: it proves the instrument and the documented mechanism, so a failing
  // discriminator can be read against a control that is known to have worked.
  arms.push(await runW6RArm({
    arm: "control:read-transaction-peer",
    label: "control",
    mode: W6R_MODE_READ_TXN,
    holdsFixture: false,
    mutationKey: "binding-w6r-control",
  }));
  arms.push(await runW6RArm({
    arm: "discriminator:refused-start-peer",
    label: "discriminator",
    mode: W6R_MODE_FAILED_BEGIN,
    holdsFixture: true,
    mutationKey: "binding-w6r-discriminator",
  }));

  assert.equal(arms.length, 2, "W6-R: both arms must run");
  assert.equal(evidence.cases["W6-R"].arms.length, 2,
    "W6-R: both arms must be RECORDED - a recorded arm is not a passed arm, and both counts are "
    + "asserted so a run that stopped partway can never read as a complete pass");
  assert.deepEqual([...new Set(evidence.cases["W6-R"].arms.map(entry => entry.status))], ["passed"],
    "W6-R: every recorded arm must have completed its assertions");
  assert.deepEqual([...new Set(arms.map(entry => entry.writerInvoked))], [true],
    "W6-R: the ACTUAL unmodified writer must have been invoked on both arms");
  assert.deepEqual([...new Set(arms.map(entry => entry.synthetic))], [false],
    "W6-R: both arms are NATIVE measurements and neither may be labelled synthetic");
  assert.deepEqual([...new Set(arms.map(entry => entry.ledgerRead))], [true],
    "W6-R: both arms must have actually read the independent opener");
  assert.deepEqual([...new Set(arms.map(entry => entry.retriesUsed))], [0],
    "W6-R: no retry, on either arm, ever");
  assert.deepEqual(arms.map(entry => entry.mode), [W6R_MODE_READ_TXN, W6R_MODE_FAILED_BEGIN],
    "W6-R: the two arms exercise the two declared peer modes, in that order");

  const observedBranch = arms[1].discriminator.branch;
  Object.assign(evidence.cases["W6-R"], {
    status: "passed",
    armsRun: arms.length,
    retriesUsed: 0,
    controlOutcome: arms[0].resultProjection.reason,
    discriminatorBranch: observedBranch,
    discriminatorBranchMeaning: observedBranch === "retained"
      ? "RECORDED: the refused write-intent start left a lock the later commit met. This is ONE "
        + "observation of that mechanism; it does NOT establish that the same holder caused any "
        + "earlier W6 outcome, and no frequency, duration or platform generalisation follows from it."
      : "RECORDED: the commit succeeded once the tester's own holder let go. This does NOT uniquely "
        + "prove release latency - no duration is measured here - and it does not establish what "
        + "caused any earlier W6 outcome either.",
    decisionPolicy: "this case RECORDS a discriminating observation. It takes no scope decision, "
      + "proposes no threshold, changes no acceptance criterion and recommends no product adoption.",
  });
  maybeForceFail("W6-R");
});

// --- W7: the kill boundary - COMPOUND EVIDENCE at the termination seam --------------------------
//
// WHAT CHANGED AND WHY, stated rather than smoothed. The prior W7 asserted the POSIX
// representation of a self-delivered SIGKILL - signal "SIGKILL", exitCode null - as its
// attribution predicate on every platform. On win32 that predicate is not merely unmet, it is
// UNMEETABLE: libuv maps a SIGKILL to TerminateProcess(process_handle, 1), the Win32 exit channel
// is one DWORD carrying the hardcoded literal 1, and "terminated by signal" is bookkeeping set
// only by the OBSERVER's own uv_process_kill() call - which a victim-authored kill never makes.
// The observed pair is therefore (1, null), byte-for-byte what an ordinary process.exit(1)
// reports, so re-pinning win32 to that pair would make the arm pass while measuring nothing.
//
// The predicate is REPLACED, not removed, and not relaxed. At each of the SAME three seams this
// case now measures a CONJUNCTION, every conjunct required:
//
//   (a) a positive synchronous seam marker, bound to the controller-assigned fresh nonce, the
//       exact seam and this owned child's pid, emitted immediately before the self-termination;
//   (b) NO bound JS exit-hook sentinel in the self-kill arm;
//   (c) a SAME-RUN, SAME-SEAM ordinary process.exit(1) CONTROL child that DOES emit that exact
//       control child's own bound sentinel, with its own marker, nonce and pid - which is what
//       makes (b) a measurement rather than an unfalsifiable absence;
//   (d) no returned result, and no parent-authored experimental or cleanup signal, in the
//       accepted self-termination arm;
//   (e) the exact source identities of the child and the slice, recorded and unchanged across
//       the arm, plus the independent P2 opener and recovery observer still reporting the
//       original generation and ZERO new rows;
//   (f) every marker and witness byte bounded, with wrong nonce, wrong seam, wrong pid,
//       duplicate, malformed, missing and incomplete messages all REFUSED.
//
// HONEST BOUNDARY, stated here rather than left to be inferred. The conjunction establishes that
// the named seam was reached and the process then ended WITHOUT EXECUTING ANY JS EXIT PATH. It
// does NOT establish which API killed it. process.reallyExit(n) and a native fault also skip the
// JS exit hooks; excluding those rests on the pinned child source plus the W9 structural
// ownership oracle, which is an argument from SOURCE IDENTITY and is labelled as such - it is
// NEVER an OS-attested or cryptographically attested fact. An external agent terminating the
// process is not disprovable from any channel available here and is recorded as residual unknown.
//
// The raw (exitCode, signal) pair is RECORDED on every platform and checked against a platform
// table for REPRESENTATION only. On win32 that pair may never be a passing attribution predicate
// on its own, and nothing below reads it as one. On POSIX the kernel-attested signal evidence is
// preserved EXPLICITLY and asserted, because there the pair does carry information.
//
// This is PROCESS TERMINATION, never power loss. No durability or fsync claim is made anywhere.
// W7x stays a SEPARATE parent-authored experiment and is never a substitute for this case.

// Exactly two children per seam: the self-kill arm and its ordinary-exit control. Named here so
// the T child accounting is DERIVED from it rather than re-typed as a total.
const W7_ARMS_PER_SEAM = 2;
const W7_ARM_SELF_KILL = "self_kill";
const W7_ARM_ORDINARY_EXIT_CONTROL = "ordinary_exit_control";

// Source identity of a leaf, recorded raw and LF-normalized. A Windows checkout may legitimately
// hold CRLF on disk, so the raw digest is recorded and the LF digest is what two platforms can be
// compared on. This is an IDENTITY record, never an authorship or integrity attestation.
function sourceIdentity(file) {
  const raw = fs.readFileSync(file);
  const lf = normalizeToLf(raw);
  return {
    path: file,
    rawSha256: sha256Buffer(raw),
    rawBytes: raw.length,
    lfNormalizedSha256: sha256Buffer(lf),
    lfNormalizedBytes: lf.length,
  };
}

function sameSourceIdentity(left, right) {
  return left !== null && right !== null
    && left.rawSha256 === right.rawSha256 && left.rawBytes === right.rawBytes;
}

const W7_SOURCE_IDENTITY_SCOPE =
  "SOURCE IDENTITY only. Source-based exclusion of alternative exit paths (reallyExit, "
  + "a native fault, an external agent) is an INFERENCE from this identity plus the W9 "
  + "structural oracle. It is not kernel attestation and it is not cryptographic "
  + "attestation of execution.";

const W7_BETWEEN_ARMS_SCOPE = "sharedByBothArms is DERIVED from three digest samples - before the "
  + "self-kill arm, BETWEEN the two arms, and after the control - compared for BOTH pinned leaves. "
  + "It is never a declared literal and never a path comparison. It bounds the two arm intervals "
  + "only: a change-and-revert entirely INSIDE one unobserved interval remains unmeasured, and no "
  + "sample is a kernel or cryptographic attestation of what the child actually executed.";

// Derives the W7 source-identity fact set from THREE samples of the same two pinned leaves.
// `before`/`after` bracket both arms exactly as they always did. `between` is read after the
// self-kill arm has been joined and before the control is forked, which is what turns "both arms
// ran the same source" into a comparison: each leaf must be byte-identical across the
// before->between interval (the self-kill arm) AND the between->after interval (the control).
// Digests are compared; the path is carried for the record and is never the comparison. PURE.
function deriveW7SourceIdentity(before, between, after) {
  const childSharedByBothArms = sameSourceIdentity(before.writeChild, between.writeChild)
    && sameSourceIdentity(between.writeChild, after.writeChild);
  const sliceSharedByBothArms = sameSourceIdentity(before.writeCas, between.writeCas)
    && sameSourceIdentity(between.writeCas, after.writeCas);
  return {
    before,
    betweenArms: between,
    after,
    childUnchanged: sameSourceIdentity(before.writeChild, after.writeChild),
    sliceUnchanged: sameSourceIdentity(before.writeCas, after.writeCas),
    // Per-leaf, so a failure names WHICH leaf moved between the arms rather than only that one did.
    childSharedByBothArms,
    sliceSharedByBothArms,
    sharedByBothArms: childSharedByBothArms && sliceSharedByBothArms,
    scope: W7_SOURCE_IDENTITY_SCOPE,
    betweenArmsScope: W7_BETWEEN_ARMS_SCOPE,
  };
}

// THE ATTRIBUTION DECISION, PURE. The real arms and every rejection control below run through
// THIS function, so a control proves the production decision rather than a parallel copy of it.
// It reads nothing outside its argument, mutates nothing, and returns the closed list of failed
// conjuncts. An empty list is the only thing that attributes; there is no partial credit, no
// majority rule and no conjunct that can be waived.
function judgeW7Attribution(facts) {
  const failures = [];
  const self = facts.selfKill;
  const control = facts.control;

  // (a) the positive, bound seam marker of the self-kill arm.
  if (self.markerAccepted !== 1) failures.push("self_kill_marker_not_exactly_one");
  if (self.markerRefusals.length > 0) failures.push("self_kill_line_refused");
  if (self.overflowed === true) failures.push("self_kill_lines_over_byte_cap");
  if (self.retainedUnparsedBytes !== 0) failures.push("self_kill_incomplete_trailing_line");
  if (self.duplicatesRefused !== 0) failures.push("self_kill_duplicate_line");
  // The arm may emit its OWN marker kind and nothing else: a self-kill arm that somehow produced
  // an ordinary-exit marker would have run the control seam, not this one.
  if (self.foreignMarkerAccepted !== 0) failures.push("self_kill_foreign_marker_present");

  // (b) NO bound exit-hook sentinel in the self-kill arm - and the binding must have been
  // REQUESTED, or the absence would be explained by there being no listener to begin with.
  if (self.witnessBindingRequested !== true) failures.push("self_kill_exit_witness_not_bound");
  if (self.witnessAccepted !== 0) failures.push("self_kill_exit_sentinel_present");

  // (c) the same-run, same-seam ordinary-exit control, with its OWN binding, which must emit.
  if (control.seam !== self.seam) failures.push("control_seam_mismatch");
  if (control.witnessBindingRequested !== true) failures.push("control_exit_witness_not_bound");
  if (control.markerAccepted !== 1) failures.push("control_marker_not_exactly_one");
  if (control.witnessAccepted !== 1) failures.push("control_exit_sentinel_absent");
  if (control.lineRefusals.length > 0) failures.push("control_line_refused");
  if (control.foreignMarkerAccepted !== 0) failures.push("control_foreign_marker_present");
  if (control.nonce === self.nonce) failures.push("control_nonce_not_distinct");
  if (control.pid === self.pid) failures.push("control_pid_not_distinct");
  if (control.exitCode !== 1) failures.push("control_exit_code_not_one");
  if (control.signal !== null) failures.push("control_signal_not_null");
  if (control.resultReceived !== false) failures.push("control_returned_a_result");

  // (d) no returned result and no parent-authored signal in the accepted self-termination arm.
  if (self.resultReceived !== false) failures.push("self_kill_returned_a_result");
  if (self.killRequested !== false) failures.push("self_kill_parent_signal_requested");
  if (self.experimentalKills !== 0) failures.push("self_kill_experimental_signal_issued");
  if (self.cleanupKills !== 0) failures.push("self_kill_cleanup_signal_issued");

  // (e) source identity, and the independent storage observation.
  if (facts.sourceIdentity.childUnchanged !== true) failures.push("child_source_identity_changed");
  if (facts.sourceIdentity.sliceUnchanged !== true) failures.push("slice_source_identity_changed");
  if (facts.sourceIdentity.sharedByBothArms !== true) failures.push("arms_ran_different_sources");
  if (self.ledgerRead !== true) failures.push("self_kill_ledger_not_read");
  if (self.generationAfterRecovery !== facts.expectedGeneration) {
    failures.push("self_kill_generation_moved");
  }
  if (self.rowsAfterRecovery !== 0) failures.push("self_kill_rows_survived");

  return { attributed: failures.length === 0, failures };
}

// W7 assertion SCHEDULING, and nothing else. Every oracle below is kept, still runs in its
// existing order and still fails the case; only the moment a failure is THROWN moves - out of the
// seam loop and into an aggregate raised after all three seams have run and latched. Windows
// measured the FIRST arm (after_cas_read, exitCode 1 / signal null) throwing inside the loop, which
// discarded the after_row_insert and before_commit arms entirely and left the child accounting at
// 166 against 168 spawned.
//
// Within one seam the first failure still short-circuits THAT seam exactly as an inline assert
// does: nothing after it is asserted for that seam, so no predicate is ever evaluated against a
// record an earlier predicate has already rejected. A non-assertion throw (a TypeError, say) is
// captured and re-raised identically - an error or an unknown is NEVER downgraded into a zero, a
// skip or a pass.
function captureArmOracles(crashSeam, runOracles) {
  try {
    runOracles();
    return null;
  } catch (error) {
    return {
      crashSeam,
      // The original error object, re-raised unchanged by the aggregate below so the failure keeps
      // its own type, stack and cause rather than being restated as a new generic verdict.
      error,
      record: {
        crashSeam,
        // The EXACT message of the existing assertion that failed, verbatim.
        failedAssertion: String((error && error.message) || error),
        errorName: String((error && error.name) || "Error"),
        errorCode: (error && error.code) === undefined ? null : (error && error.code) || null,
        operator: (error && error.operator) === undefined ? null : error.operator,
        note: "DEFERRED, never weakened: this predicate rejected the seam and the case cannot pass. "
          + "The raw values it rejected stay latched in this seam's rawObserved, lines and "
          + "observation fields and are not re-derived from this record.",
      },
    };
  }
}

// One W7 child, run end to end and LATCHED. Both arms of every seam go through this one function,
// so there is exactly one spawn path, one join path, one cleanup path and one shape of evidence
// for W7 - the self-kill arm and its control cannot drift apart in how they were observed, which
// is the whole basis on which the control licenses conjunct (b).
//
// The cleanup and preservation structure below is the independently verified one, preserved: the
// entire cleanup body is wrapped, the preservation decision is taken in an inner finally that is
// guaranteed on all three paths (normal return, try-body throw, cleanup-body throw), and a
// secondary cleanup-body failure is PUBLISHED to evidence.cleanupFailures on that same guaranteed
// path rather than dying with the frame.
//
// One deliberate strengthening, named rather than slipped in: the budgeted joins are CAUGHT into
// latched observations instead of being allowed to propagate. v-prior let a join deadline unwind
// past the evidence latch, which destroyed this arm's record and every seam behind it - exactly
// the failure mode the aggregate scheduling above exists to prevent. Nothing is relaxed: joinError
// and streamEndError are HARD assertions in the caller, so a missed join still fails the seam.
async function runW7Child(spec) {
  const { caseId, armId, seam, store, env, nonce, label, mutationKey } = spec;
  const handle = spawnChild(env);
  // The challenge is installed BEFORE any byte can be judged. handle.child.pid is known the moment
  // fork returns, so every line is bound to this exact spawned process.
  const expectation = { point: seam, nonce, pid: handle.child.pid };
  handle.w7Expectation = expectation;

  let goAttempt = null;
  let joinError = null;
  let streamEndError = null;
  let cleanupJoinError = null;
  let cleanupFailure = null;
  let preservation = null;
  let readyError = null;

  try {
    try {
      await withDeadline(handle.ready, PER_CHILD_TIMEOUT_MS, label + " ready");
      // sendGo never rejects, so neither a synchronous throw out of send() nor an asynchronous
      // undeliverable report can escape and abort the seam loop.
      goAttempt = await sendGo(handle, "go", {
        type: "go",
        storeRoot: store.storeRoot,
        options: callOptions({ mutation: mutationOf(mutationKey, { seam, arm: armId }) }),
      });
    } catch (error) {
      readyError = observationFailure(error);
    }
    // A child that was never commanded cannot reach its seam and cannot exit, so joining on it
    // would only burn the per-child budget. The join is skipped, the failure is latched, and the
    // arm FAILS on it through the same captured-oracle path as every other W7 predicate.
    if (readyError === null && goAttempt !== null && goAttempt.failure === null) {
      try {
        await withDeadline(handle.exited, PER_CHILD_TIMEOUT_MS, label + " exit");
      } catch (error) {
        joinError = observationFailure(error);
      }
      // The exit EVENT can precede the last bytes of fd1, and the exit sentinel is by construction
      // the last thing a control child writes. Joining on the exit alone would race it and could
      // report a real sentinel as absent - the single most misleading failure this case can make.
      try {
        await withDeadline(handle.stdoutEnded, PER_CHILD_TIMEOUT_MS, label + " stdout end");
      } catch (error) {
        streamEndError = observationFailure(error);
      }
    }
  } finally {
    try {
      // For a child that reached its seam and terminated itself - by SIGKILL or by the control's
      // ordinary exit - the existing exited guard makes this a no-op that issues NO signal, which
      // is what keeps this arm's killRequested:false property intact. For a child that never got
      // its go it DOES signal, and that cleanup kill is JOINED through this same exact handle
      // inside the unchanged per-child budget rather than signalled and walked away from.
      handle.kill();
      if (!handle.record.exited) {
        // This handle has now had its ONE bounded cleanup attempt. The finaliser reads this flag
        // and does NOT issue a second, untracked signal to it.
        handle.cleanupAttempted = true;
        try {
          await withDeadline(handle.exited, PER_CHILD_TIMEOUT_MS, label + " cleanup join");
        } catch (error) {
          cleanupJoinError = observationFailure(error);
        }
      }
    } catch (error) {
      // RECORDED, never re-thrown: an original try-body error stays the propagating error with its
      // identity intact, and this cleanup failure survives beside it as evidence.
      cleanupFailure = observationFailure(error);
    } finally {
      // PRESERVATION DECISION, taken here so EVERY exit path reaches it, and BEFORE the first store
      // observation below. This is the same shared function the finaliser consults, bound to THIS
      // arm's exact owned root, taken AFTER the bounded cleanup join from the OBSERVED
      // record.exited of this exact handle - never from a kill read as a reap.
      //
      // This block only ASSIGNS: it never throws and never returns, so it cannot replace or
      // suppress whichever error is propagating out of the blocks above.
      preservation = registerRootPreservation({
        caseId,
        seam,
        root: store.parent,
        pid: handle.record.pid,
        exited: handle.record.exited,
      });
      if (cleanupFailure !== null) {
        evidence.cleanupFailures.push({
          caseId,
          seam,
          arm: armId,
          iteration: null,
          root: store.parent,
          failure: cleanupFailure,
          note: "SECONDARY cleanup-body failure recorded beside the primary error, which keeps its "
            + "identity and still propagates. Recorded in memory and serialised by the finaliser - "
            + "NOT a disk-durability claim.",
        });
      }
    }
  }

  const record = handle.record;

  // ---- FAILURE-SAFE EVIDENCE LATCH: every record below PRECEDES every assertion ---------------
  // The R2-2 ordering is preserved EXACTLY: (1) the leftover is recorded BEFORE anything reopens
  // the store, (2) the observer runs, (3) the post-recovery state is recorded SEPARATELY.

  // (0) the raw observed child scalars, verbatim, before any oracle reads them.
  const rawObserved = {
    arm: armId,
    pid: record.pid,
    exitCode: record.exitCode,
    signal: record.signal,
    exited: record.exited,
    resultReceived: record.result !== null && record.result !== undefined,
    killRequested: record.killRequested,
    killDelivered: record.killDelivered,
    killedByTest: record.killedByTest,
    experimentalKills: record.experimentalKills,
    cleanupKills: record.cleanupKills,
    killIntents: [...record.killIntents],
    lifecycle: childLifecycle(record),
    // Already captured by the existing stderr listener. Recorded because it was captured - no new
    // instrumentation is introduced here. It is WEAK evidence against an uncaught child throw and
    // excludes nothing; nothing below reads it as a verdict.
    stderrHead: record.stderrHead === "" ? null : record.stderrHead,
    ...ipcFacts(record),
    readyError,
    goSendFailure: goAttempt === null ? null : goAttempt.failure,
    joinError,
    streamEndError,
    childJoined: record.exited === true,
    transportPolicy: "a delivered go is TRANSPORT COMPLETION ONLY - never a child acknowledgement "
      + "and never a result, and the compound oracles below are unchanged by it",
    representationNote: "RAW observed values, recorded before any assertion reads them. The "
      + "(exitCode, signal) pair is checked against a PLATFORM table for REPRESENTATION only. On "
      + "win32 a self-delivered SIGKILL is reported as (1, null) - byte-for-byte what an ordinary "
      + "exit(1) reports - so the pair is provably non-discriminating there and is NEVER an "
      + "attribution predicate on its own. On POSIX the kernel-attested signal is asserted.",
  };
  // Exactly ONE lifecycle record per child, pushed here and nowhere else in this case.
  evidence.children.records.push({ caseId, crashSeam: seam, arm: armId, ...lifecycleFacts(record) });

  // The bounded fd1 observation, taken AFTER the stream end join so every byte the child wrote is
  // already absorbed. No raw external text reaches the evidence.
  const lines = w7LineObservation(record.w7LineState);

  // GATE: the owned store is not touched AT ALL until this exact handle's exit has been observed.
  // An unjoined child still holds its transaction and its lock, so the leftover inventory would
  // hash a live mid-transaction file and the read-WRITE reopen would replay a journal underneath a
  // running writer - and both would then be recorded as recovery evidence, which they are not.
  const recoveryObservable = mayObserveRecovery(record);
  let notObservedBecause = null;
  let recoveryOpenCalls = 0;
  let leftover = null;
  let leftoverSidecars = null;
  let leftoverError = null;
  let observation = null;
  let observationError = null;
  let afterRecovery = null;
  let afterRecoveryError = null;
  let ledgerRead = false;
  let ledgerError = null;
  let generationAfterRecovery = null;
  let rowsAfterRecovery = null;
  if (!recoveryObservable) {
    notObservedBecause = preservation.because;
  } else {
    // (1) The leftover, recorded VERBATIM before anything reopens the store.
    try {
      leftover = inventoryWithHashes(store.storeRoot);
      leftoverSidecars = sidecars(store.storeRoot);
    } catch (error) {
      leftoverError = observationFailure(error);
    }
    // (2) The tester-lane observer: one read-write open, one close, nothing else.
    try {
      recoveryOpenCalls += 1;
      observation = observeRecoveryOpen(store.dbPath);
    } catch (error) {
      observationError = observationFailure(error);
    }
    // (3) Post-recovery state, recorded SEPARATELY, neither record overwriting the other.
    try {
      afterRecovery = inventoryWithHashes(store.storeRoot);
    } catch (error) {
      afterRecoveryError = observationFailure(error);
    }
    try {
      const ledger = requireLedger(store.dbPath, caseId + "/" + seam + "/" + armId);
      generationAfterRecovery = ledger.generation;
      rowsAfterRecovery = totalSectionRows(ledger);
      ledgerRead = true;
    } catch (error) {
      ledgerError = observationFailure(error);
    }
  }

  return {
    armId,
    seam,
    nonce,
    pid: record.pid,
    // Explicitly incomplete until the seam's assertions have passed. A partial arm is recorded as
    // partial; it is never dressed up as a successful one to satisfy a downstream gate.
    status: "incomplete",
    rawObserved,
    lines,
    witnessBindingRequested: env.P4_WITNESS_AT === seam && env.P4_WITNESS_NONCE === nonce,
    ownedRoot: store.parent,
    preservation,
    cleanupJoinError,
    cleanupFailure,
    cleanupAttempted: handle.cleanupAttempted === true,
    recoveryObservable,
    notObservedBecause,
    recoveryOpenCalls,
    storePreservedUnobserved: recoveryObservable === false,
    leftoverBeforeAnyReopen: leftover,
    leftoverSidecars,
    leftoverError,
    hotJournalPresentInLeftover: leftoverSidecars === null
      ? null : leftoverSidecars.some(name => name.endsWith("-journal")),
    hotJournalPolicy: "MEASURED, not assumed: section 0 K1 expects a hot -journal at "
      + "before_commit, and this record reports what this run actually observed. A hot journal is "
      + "NOT mechanism evidence - an ordinary exit(1) at the same seam leaves the same journal, "
      + "which is exactly why the control arm exists - and it is never recovery, durability or "
      + "power-loss evidence.",
    recoveryObservation: observation,
    recoveryObservationError: observationError,
    afterRecovery,
    afterRecoveryError,
    leftoverChangedByReopen: leftover === null || afterRecovery === null
      ? null : JSON.stringify(leftover) !== JSON.stringify(afterRecovery),
    playbackNote: "a read-write open lets SQLite play back the rollback journal, so the leftover "
      + "is NOT byte-identical across the reopen. That playback is SQLite behaviour OBSERVED, not a "
      + "repair this slice or this lane performs or claims, and it decides nothing about D2.",
    readOnlyOpenerOnLeftover: {
      attempted: false,
      reason: "read-only journal recovery (SQLITE_READONLY_RECOVERY) is UNMEASURED (P2-CONTRACT "
        + "section 3), so the read-only opener is NOT the verifier on the pre-reopen leftover and "
        + "no such attempt is made",
    },
    ledgerRead,
    ledgerError,
    generationAfterRecovery,
    totalSectionRowsAfterRecovery: rowsAfterRecovery,
    zeroRowPolicy: "a missing or failed ledger read is recorded as null with ledgerRead:false and "
      + "is NEVER reported as zero rows",
  };
}

// Projects one latched arm into the flat fact set judgeW7Attribution reads. Pure.
function w7ArmFacts(arm) {
  return {
    seam: arm.seam,
    nonce: arm.nonce,
    pid: arm.pid,
    markerAccepted: arm.armId === W7_ARM_SELF_KILL
      ? arm.lines.acceptedByKind.P4_SEAM_CRASH
      : arm.lines.acceptedByKind.P4_SEAM_EXIT,
    // The marker kind belonging to the OTHER arm. It must never appear here.
    foreignMarkerAccepted: arm.armId === W7_ARM_SELF_KILL
      ? arm.lines.acceptedByKind.P4_SEAM_EXIT
      : arm.lines.acceptedByKind.P4_SEAM_CRASH,
    witnessAccepted: arm.lines.acceptedByKind.P4_EXIT_WITNESS,
    witnessBindingRequested: arm.witnessBindingRequested,
    markerRefusals: arm.lines.refusals,
    lineRefusals: arm.lines.refusals,
    overflowed: arm.lines.overflowed,
    retainedUnparsedBytes: arm.lines.retainedUnparsedBytes,
    duplicatesRefused: arm.lines.duplicatesRefused,
    exitCode: arm.rawObserved.exitCode,
    signal: arm.rawObserved.signal,
    resultReceived: arm.rawObserved.resultReceived,
    killRequested: arm.rawObserved.killRequested,
    experimentalKills: arm.rawObserved.experimentalKills,
    cleanupKills: arm.rawObserved.cleanupKills,
    ledgerRead: arm.ledgerRead,
    generationAfterRecovery: arm.generationAfterRecovery,
    rowsAfterRecovery: arm.totalSectionRowsAfterRecovery,
  };
}

test("W7 kill boundary: compound evidence that the seam was reached and no JS exit path ran", async () => {
  const arms = [];
  // Captured per-seam oracle failures, re-raised as one aggregate AFTER every seam has been
  // collected. A non-empty list is a FAILED case; it is never a tolerated or absorbed condition.
  const armFailures = [];
  // The generation every store in this case starts at, authored here rather than read back from
  // the store the arm is about to observe.
  const EXPECTED_GENERATION = 1;

  // Source identity, read ONCE before any arm runs. It is re-read after every arm and compared, so
  // "the arms ran the same pinned source" is a MEASURED property of this run rather than an
  // assumption about the checkout.
  const sourceBefore = {
    writeChild: sourceIdentity(WRITE_CHILD_SOURCE),
    writeCas: sourceIdentity(WRITE_CAS_SOURCE),
  };

  evidence.cases.W7 = {
    status: "incomplete",
    platform: process.platform,
    seamsRequired: CRASH_SEAMS,
    armsPerSeam: W7_ARMS_PER_SEAM,
    arms: [],
    rejectionControls: [],
    pinnedSelfKillPair: W7_PINNED_SELF_KILL_PAIR,
    pinnedOrdinaryExitPair: W7_PINNED_ORDINARY_EXIT_PAIR,
    sourceIdentityBefore: sourceBefore,
    sourceIdentitySamplingNote: "each seam samples both pinned leaves THREE times - before the "
      + "self-kill arm, between the arms, and after the control - and every digest is recorded on "
      + "the arm. sharedByBothArms is DERIVED from those comparisons for both leaves by "
      + "deriveW7SourceIdentity, the same pure function the A18-A21 controls run through. It was "
      + "previously a hardcoded literal, which made arms_ran_different_sources unreachable in a "
      + "real run. " + W7_BETWEEN_ARMS_SCOPE,
    contractNote: "W7's attribution predicate is a CONJUNCTION measured at each seam: bound seam "
      + "marker present, bound exit-hook sentinel ABSENT in the self-kill arm, a same-run "
      + "same-seam ordinary-exit CONTROL whose own bound sentinel is PRESENT, no returned result, "
      + "no parent-authored signal, recorded source identity, and the independent opener reporting "
      + "the original generation with zero new rows. Exit code or missing output ALONE is "
      + "insufficient and is never accepted as attribution.",
    pairPolicy: "the raw (exitCode, signal) pair is RECORDED and checked for REPRESENTATION only. "
      + "On win32 a self-delivered SIGKILL reports (1, null), which an ordinary exit(1) also "
      + "reports, so the pair is provably non-discriminating there and may NEVER be a passing "
      + "predicate on its own. On POSIX the kernel-attested signal evidence is preserved and "
      + "asserted explicitly.",
    attributionBoundary: "the conjunction establishes that the named seam was reached and the "
      + "process then ended without executing any JS exit path. It does NOT establish WHICH API "
      + "killed it: process.reallyExit and a native fault also skip the JS exit hooks, and "
      + "excluding those rests on the pinned child source plus the W9 structural oracle - an "
      + "argument from SOURCE IDENTITY, never an OS-attested or cryptographic attestation. An "
      + "external agent terminating the process is not disprovable from any channel available "
      + "here and stays a residual UNKNOWN.",
    notClaimed: "no power loss, no disk durability, no fsync equivalence, no journal-policy "
      + "decision, no OS-attested termination cause and no adoption. Process termination is not "
      + "power loss. The native AtExit / better-sqlite3 question remains UNMEASURED: Node runs "
      + "NATIVE AtExit callbacks on the self-kill path on all three platforms, JS 'exit' is not "
      + "emitted there, and whether the pinned binding registers one that could touch an open "
      + "database is outside what this lane measured.",
    evidenceLatchNote: "each arm records its raw scalars, its bounded fd1 line observation, the "
      + "pre-reopen leftover and sidecars, the recovery observation, the post-recovery inventory "
      + "and the independent opener ledger - all BEFORE its first assertion, in that R2-2 order.",
    assertionSchedulingNote: "every seam's oracles run per seam and any failure is CAPTURED, so a "
      + "failing seam no longer aborts the seams after it: all arms are observed and latched, and "
      + "the captured failures are re-raised together after the loop. Scheduling only - no "
      + "predicate is relaxed, no seam is skipped or retried, and a failed seam stays failed.",
  };

  for (const crashSeam of CRASH_SEAMS) {
    // Two FRESH nonces per seam, controller-assigned by this parent. They must differ, and the
    // conjunction asserts that they do, so a control can never be mistaken for its own arm.
    const selfKillNonce = newSeamNonce();
    const controlNonce = newSeamNonce();

    const selfKillStore = newStore("w7-" + crashSeam);
    const controlStore = newStore("w7ctl-" + crashSeam);

    const selfKillArm = await runW7Child({
      caseId: "W7",
      armId: W7_ARM_SELF_KILL,
      seam: crashSeam,
      store: selfKillStore,
      nonce: selfKillNonce,
      label: "W7 " + crashSeam + " self-kill",
      mutationKey: "binding-crash",
      env: {
        P4_CRASH_AT: crashSeam,
        P4_CRASH_NONCE: selfKillNonce,
        P4_WITNESS_AT: crashSeam,
        P4_WITNESS_NONCE: selfKillNonce,
      },
    });

    // Source identity BETWEEN the arms: the self-kill arm above has been joined and the control
    // below has not been forked yet, so this sample is what makes "both arms ran the same source" a
    // comparison rather than a declaration. It brackets the change-and-revert case the before/after
    // endpoints alone cannot see.
    const sourceBetweenArms = {
      writeChild: sourceIdentity(WRITE_CHILD_SOURCE),
      writeCas: sourceIdentity(WRITE_CAS_SOURCE),
    };

    // The CONTROL, in the SAME RUN and at the SAME SEAM. It is not a variant of the arm above and
    // it is never merged into it: it is an ORDINARY exit(1) whose whole job is to show, in this
    // run on this runner, that the sentinel the arm above is missing IS emittable here.
    const controlArm = await runW7Child({
      caseId: "W7",
      armId: W7_ARM_ORDINARY_EXIT_CONTROL,
      seam: crashSeam,
      store: controlStore,
      nonce: controlNonce,
      label: "W7 " + crashSeam + " ordinary-exit control",
      mutationKey: "binding-exit-control",
      env: {
        P4_EXIT_AT: crashSeam,
        P4_EXIT_NONCE: controlNonce,
        P4_WITNESS_AT: crashSeam,
        P4_WITNESS_NONCE: controlNonce,
      },
    });

    const sourceAfter = {
      writeChild: sourceIdentity(WRITE_CHILD_SOURCE),
      writeCas: sourceIdentity(WRITE_CAS_SOURCE),
    };
    // Three samples in, one derived fact set out - the SAME pure function the A18-A21 controls run
    // through. Every intermediate digest is recorded on the fact set it produced, and nothing here
    // is an authorship or integrity attestation.
    const sourceIdentityFacts =
      deriveW7SourceIdentity(sourceBefore, sourceBetweenArms, sourceAfter);

    // The R2-2 parent record: exactly that field set and NOTHING resembling a returned result.
    // exitCode and signal are the RAW OBSERVED values, never hardcoded expectations.
    const parentRecord = {
      crashSeam,
      exitCode: selfKillArm.rawObserved.exitCode,
      signal: selfKillArm.rawObserved.signal,
      childOutcome: "unknown",
      commitOutcome: "unknown",
    };

    const pinnedSelfKillPair = Object.hasOwn(W7_PINNED_SELF_KILL_PAIR, process.platform)
      ? W7_PINNED_SELF_KILL_PAIR[process.platform] : null;

    const facts = {
      seam: crashSeam,
      expectedGeneration: EXPECTED_GENERATION,
      selfKill: w7ArmFacts(selfKillArm),
      control: w7ArmFacts(controlArm),
      sourceIdentity: sourceIdentityFacts,
    };
    const attribution = judgeW7Attribution(facts);

    const arm = {
      crashSeam,
      status: "incomplete",
      synthetic: true,
      parentRecord,
      selfKillArm,
      controlArm,
      sourceIdentity: sourceIdentityFacts,
      attribution,
      attributionInputs: facts,
      observedSelfKillPair: {
        exitCode: selfKillArm.rawObserved.exitCode,
        signal: selfKillArm.rawObserved.signal,
      },
      pinnedSelfKillPair,
      observedControlPair: {
        exitCode: controlArm.rawObserved.exitCode,
        signal: controlArm.rawObserved.signal,
      },
      pinnedOrdinaryExitPair: W7_PINNED_ORDINARY_EXIT_PAIR,
      pairIsAttribution: false,
      pairsIndistinguishableOnWin32:
        W7_PINNED_SELF_KILL_PAIR.win32.exitCode === W7_PINNED_ORDINARY_EXIT_PAIR.exitCode
        && W7_PINNED_SELF_KILL_PAIR.win32.signal === W7_PINNED_ORDINARY_EXIT_PAIR.signal,
      posixSignalEvidence: pinnedSelfKillPair !== null && pinnedSelfKillPair.kernelAttestedSignal
        ? {
          asserted: true,
          signal: selfKillArm.rawObserved.signal,
          source: "kernel wait status (WIFSIGNALED -> WTERMSIG), preserved explicitly and "
            + "unchanged on this platform",
        }
        : {
          asserted: false,
          signal: selfKillArm.rawObserved.signal,
          source: "no kernel channel carries a term signal on this platform; the field is "
            + "observer-side bookkeeping only and is RECORDED, never asserted as attribution",
        },
      storageIndistinguishable: "the self-kill arm and the ordinary-exit control leave the SAME "
        + "storage state at the same seam - original generation, zero new rows, and the same hot "
        + "journal pattern. That is precisely why storage state is a conjunct of no-partial-write "
        + "and is NEVER a conjunct of attribution.",
    };
    evidence.cases.W7.arms.push(arm);
    arms.push(arm);

    // ---- ASSERTIONS: run against a sealed record, captured and re-raised as one aggregate ------
    const armFailure = captureArmOracles(crashSeam, () => {
    for (const forbidden of ["reason", "ok", "committed", "commitAttempted", "retrySafe"]) {
      assert.equal(Object.hasOwn(parentRecord, forbidden), false,
        "W7/" + crashSeam + ": the parent record must NOT synthesize " + forbidden
        + " for a process that returned nothing");
    }

    // Transport and join predicates FIRST, for BOTH arms, so an undelivered go or a missed join is
    // reported as what it is rather than as the missing marker it would otherwise masquerade as.
    for (const observed of [selfKillArm, controlArm]) {
      const where = "W7/" + crashSeam + "/" + observed.armId;
      assert.equal(observed.rawObserved.readyError, null,
        where + ": the child must announce readiness within the existing per-child budget ("
        + JSON.stringify(observed.rawObserved.readyError) + ")");
      assert.deepEqual(observed.rawObserved.ipcErrors, [],
        where + ": the child's IPC channel must raise NO error. An error here is a FAILURE of this "
        + "arm and is reported from inside its latch: unlistened, it would surface as an "
        + "uncaughtException and end the run BEFORE any of this arm's evidence was written ("
        + JSON.stringify(observed.rawObserved.ipcErrors) + ")");
      assert.equal(observed.rawObserved.goSendFailure, null,
        where + ": the single go command must have been DELIVERED to a live child - a command that "
        + "never reached the child is reported as undelivered and is never read as a child that "
        + "received it and declined to reach its seam ("
        + JSON.stringify(observed.rawObserved.goSendFailure) + ")");
      assert.deepEqual(observed.rawObserved.sendAttempts.map(entry => entry.delivered), [true],
        where + ": exactly one go command, positively acknowledged as delivered - a send whose "
        + "return value alone looked acceptable is not a delivered command");
      assert.equal(observed.rawObserved.joinError, null,
        where + ": the exit must be OBSERVED within the unchanged per-child budget ("
        + JSON.stringify(observed.rawObserved.joinError) + ")");
      assert.equal(observed.rawObserved.streamEndError, null,
        where + ": fd1 must reach end-of-stream within the unchanged per-child budget, so a real "
        + "exit sentinel can never be reported as absent because the parent stopped reading ("
        + JSON.stringify(observed.rawObserved.streamEndError) + ")");
      assert.equal(observed.cleanupJoinError, null,
        where + ": a cleanup signal must itself be JOINED through this same exact handle within "
        + "the unchanged per-child bound (" + JSON.stringify(observed.cleanupJoinError) + ")");
      assert.equal(observed.cleanupFailure, null,
        where + ": the cleanup body itself must not throw - it is recorded rather than propagated "
        + "so the original error survives, and it fails the arm here ("
        + JSON.stringify(observed.cleanupFailure) + ")");
      assert.equal(observed.rawObserved.exited, true,
        where + ": the child exit is OBSERVED, never assumed");
      assert.equal(observed.recoveryObservable, true,
        where + ": the store may be read and reopened as recovery evidence ONLY after an observed "
        + "exit - an unjoined child leaves the owned store UNTOUCHED and preserved, and fails the "
        + "arm (" + String(observed.notObservedBecause) + ")");
      assert.equal(observed.recoveryOpenCalls, 1,
        where + ": exactly one recovery open, and only after the observed exit");
      assert.equal(observed.leftoverError, null,
        where + ": the pre-reopen leftover must actually be observed");
      assert.equal(observed.recoveryObservationError, null,
        where + ": the recovery observer must actually run");
      assert.equal(observed.recoveryObservation.opened, true,
        where + ": the observer must be able to open the leftover read-write");
      assert.equal(observed.recoveryObservation.closed, true,
        where + ": the observer closes its handle");
      assert.equal(observed.recoveryObservation.openError, null, where + ": no open fault");
      assert.equal(observed.recoveryObservation.closeError, null, where + ": no close fault");
      assert.equal(observed.afterRecoveryError, null,
        where + ": the post-recovery inventory must actually be observed");
      assert.equal(observed.ledgerRead, true,
        where + ": the independent opener must actually read the store - a failed read is a failed "
        + "measurement, NEVER evidence that no partial application survived ("
        + JSON.stringify(observed.ledgerError) + ")");
      // No partial application survived, in EITHER arm. This is the no-partial-write oracle and it
      // is deliberately NOT an attribution conjunct: the two arms leave the same state, which is
      // exactly what makes storage useless for telling them apart.
      assert.equal(observed.generationAfterRecovery, EXPECTED_GENERATION,
        where + ": the opener reports generation g - no bump survived");
      assert.equal(observed.totalSectionRowsAfterRecovery, 0,
        where + ": ZERO new rows - no partial application survived");
      // Bounded bytes, run-wide for this arm: nothing over the cap, nothing left unterminated,
      // nothing refused, no duplicate of any kind.
      assert.equal(observed.lines.overflowed, false,
        where + ": the bounded fd1 accumulator must not have overflowed");
      assert.equal(observed.lines.retainedUnparsedBytes, 0,
        where + ": no incomplete trailing line may remain at decision time");
      assert.deepEqual(observed.lines.refusals, [],
        where + ": every line this child emitted must be bound and exact ("
        + JSON.stringify(observed.lines.refusals) + ")");
      assert.equal(observed.lines.duplicatesRefused, 0,
        where + ": each typed line is emitted exactly once");
    }

    // (d) no parent-authored signal in the self-termination arm. The suite requested no kill for
    // either of these children; the control leaves on its own ordinary exit.
    for (const observed of [selfKillArm, controlArm]) {
      const where = "W7/" + crashSeam + "/" + observed.armId;
      assert.equal(observed.rawObserved.killRequested, false,
        where + ": the child terminates itself; the suite scans no processes and kills none");
      assert.equal(observed.rawObserved.experimentalKills, 0,
        where + ": no experimental signal is issued anywhere in W7 - that is W7x, a separate case");
      assert.equal(observed.rawObserved.cleanupKills, 0,
        where + ": a child that ended on its own needs no cleanup signal");
      assert.equal(observed.rawObserved.resultReceived, false,
        where + ": a child that never returned sends NOTHING - no reason code, no committed, no "
        + "retrySafe - and the parent never synthesizes one");
    }

    // REPRESENTATION, checked against the platform table and labelled as representation. This is
    // never the attribution: on win32 the pinned self-kill pair is byte-for-byte the pinned
    // ordinary-exit pair, which the next assertion states positively rather than leaving implicit.
    assert.notEqual(pinnedSelfKillPair, null,
      "W7/" + crashSeam + ": platform " + process.platform + " is not in the pinned self-kill "
      + "representation table, so the representation is UNMEASURED here and the seam fails rather "
      + "than guessing");
    assert.equal(selfKillArm.rawObserved.exitCode, pinnedSelfKillPair.exitCode,
      "W7/" + crashSeam + ": the self-kill arm must report the pinned exit code for this platform "
      + "- a REPRESENTATION check, never an attribution");
    assert.equal(selfKillArm.rawObserved.signal, pinnedSelfKillPair.signal,
      "W7/" + crashSeam + ": the self-kill arm must report the pinned signal for this platform - a "
      + "REPRESENTATION check, never an attribution");
    assert.equal(controlArm.rawObserved.exitCode, W7_PINNED_ORDINARY_EXIT_PAIR.exitCode,
      "W7/" + crashSeam + ": the ordinary-exit control must report exit code 1");
    assert.equal(controlArm.rawObserved.signal, W7_PINNED_ORDINARY_EXIT_PAIR.signal,
      "W7/" + crashSeam + ": the ordinary-exit control must report no signal");
    assert.equal(arm.pairsIndistinguishableOnWin32, true,
      "W7/" + crashSeam + ": the pinned win32 self-kill pair and the pinned ordinary-exit pair are "
      + "the SAME pair. This is asserted positively so the reason the pair cannot attribute is a "
      + "measured property of the pinned table rather than a remark in a comment");

    // POSIX signal evidence, PRESERVED EXPLICITLY. Where the kernel does carry the term signal it
    // is asserted exactly as before, hard, and is not relaxed to SIGKILL-or-null.
    if (pinnedSelfKillPair.kernelAttestedSignal) {
      assert.equal(selfKillArm.rawObserved.signal, "SIGKILL",
        "W7/" + crashSeam + ": on a platform whose kernel reports the terminating signal, the "
        + "POSIX evidence is preserved and asserted - the child was terminated at the named point");
      assert.equal(selfKillArm.rawObserved.exitCode, null,
        "W7/" + crashSeam + ": a kernel-signalled child reports no exit code");
    }

    // THE CONJUNCTION. Every conjunct required; the failure list is the exact closed vocabulary.
    assert.deepEqual(attribution.failures, [],
      "W7/" + crashSeam + ": the compound attribution oracle must find no failed conjunct ("
      + JSON.stringify(attribution.failures) + ")");
    assert.equal(attribution.attributed, true,
      "W7/" + crashSeam + ": the named seam was reached and the process then ended without "
      + "executing any JS exit path - established by CONJUNCTION, never by the exit pair and never "
      + "by missing output alone");

    // The three facts the conjunction turns on, asserted individually too, so a failure names the
    // conjunct rather than only the aggregate.
    assert.equal(facts.selfKill.markerAccepted, 1,
      "W7/" + crashSeam + ": exactly one bound seam marker from the self-kill arm, carrying this "
      + "seam, this arm's fresh nonce and this owned child's pid");
    assert.equal(facts.selfKill.witnessAccepted, 0,
      "W7/" + crashSeam + ": NO exit-hook sentinel in the self-kill arm - the JS exit path did not "
      + "run, and the binding was requested for this child exactly as it was for the control");
    assert.equal(facts.selfKill.witnessBindingRequested, true,
      "W7/" + crashSeam + ": the exit witness must have been BOUND in the self-kill arm, or its "
      + "absence would be explained by there being no listener rather than by the termination");
    assert.equal(facts.control.witnessAccepted, 1,
      "W7/" + crashSeam + ": the same-run, same-seam ordinary-exit CONTROL must emit its own bound "
      + "sentinel - this is what makes the absence above a measurement rather than an "
      + "unfalsifiable silence");
    assert.equal(facts.control.markerAccepted, 1,
      "W7/" + crashSeam + ": the control reaches the same seam and says so with its own marker");
    assert.equal(facts.selfKill.foreignMarkerAccepted, 0,
      "W7/" + crashSeam + ": the self-kill arm emits its own marker kind and no other");
    assert.equal(facts.control.foreignMarkerAccepted, 0,
      "W7/" + crashSeam + ": the control emits its own marker kind and no other");
    assert.notEqual(facts.control.nonce, facts.selfKill.nonce,
      "W7/" + crashSeam + ": the two arms carry DISTINCT fresh nonces");
    assert.notEqual(facts.control.pid, facts.selfKill.pid,
      "W7/" + crashSeam + ": the two arms are distinct owned processes");

    // Source identity, recorded AND checked.
    assert.equal(sourceIdentityFacts.childUnchanged, true,
      "W7/" + crashSeam + ": write-child.cjs must be byte-identical across this seam's two arms");
    assert.equal(sourceIdentityFacts.sliceUnchanged, true,
      "W7/" + crashSeam + ": write-cas.cjs must be byte-identical across this seam's two arms");
    // The between-arms sample, asserted per leaf so a failure names which one moved. These are
    // MEASURED comparisons of three digests, not a declaration - and they bound the two arm
    // intervals only, never an unobserved interval inside either one.
    assert.equal(sourceIdentityFacts.childSharedByBothArms, true,
      "W7/" + crashSeam + ": write-child.cjs must be byte-identical at all THREE samples - before "
      + "the self-kill arm, between the arms and after the control");
    assert.equal(sourceIdentityFacts.sliceSharedByBothArms, true,
      "W7/" + crashSeam + ": write-cas.cjs must be byte-identical at all THREE samples - before the "
      + "self-kill arm, between the arms and after the control");
    assert.equal(sourceIdentityFacts.sharedByBothArms, true,
      "W7/" + crashSeam + ": both arms ran the same pinned source - DERIVED from the three digest "
      + "samples of both leaves, never a declared literal and never a path comparison");
    });

    if (armFailure === null) {
      arm.status = "passed";
      selfKillArm.status = "passed";
      controlArm.status = "passed";
    } else {
      // A rejected seam is recorded as FAILED - never left looking untested, never promoted, and
      // never merged into a neighbouring seam that did pass. The next seam still runs so that its
      // own observations exist; that is collection, not tolerance.
      arm.status = "failed";
      selfKillArm.status = "failed";
      controlArm.status = "failed";
      arm.assertionFailure = armFailure.record;
      armFailures.push(armFailure);
    }
  }

  // ---- REJECTION CONTROLS: each must be REFUSED, none may attribute ---------------------------
  //
  // Two families, both DETERMINISTIC and both PURE. No process is forked, no signal is issued and
  // no store is touched by any of them.
  //   B* exercise the byte/line parser: the exact typed form, then wrong nonce, wrong seam, wrong
  //      pid, malformed, duplicate, missing, incomplete, non-ASCII and over-cap.
  //   A* exercise judgeW7Attribution itself - the SAME function the real seams above ran through -
  //      so a control proves the production decision rather than a restatement of it.
  //
  // A POSITIVE control opens each family, so the refusals below cannot pass merely because the
  // parser or the judge refuses everything.
  const rejectionControls = [];
  function runRejectionControl(id, description, body) {
    const outcome = body();
    const entry = { id, description, ...outcome };
    evidence.cases.W7.rejectionControls.push(entry);
    rejectionControls.push(entry);
    return entry;
  }

  const controlPoint = "after_row_insert";
  const controlPid = 424242;
  const goodNonce = "0123456789abcdef0123456789abcdef";
  const foreignNonce = "fedcba9876543210fedcba9876543210";
  const w7Expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
  const typedLine = (kind, point, nonce, pid) =>
    kind + " v1 point=" + point + " nonce=" + nonce + " pid=" + String(pid) + "\n";

  runRejectionControl("B0", "the exact typed forms, split across arbitrary chunk boundaries, are "
    + "accepted - the positive control that stops every refusal below from being vacuous", () => {
    const state = newW7LineState();
    const both = typedLine("P4_SEAM_EXIT", controlPoint, goodNonce, controlPid)
      + typedLine("P4_EXIT_WITNESS", controlPoint, goodNonce, controlPid);
    for (const piece of [both.slice(0, 9), both.slice(9, 44), both.slice(44, 91), both.slice(91)]) {
      feedW7Lines(state, piece, w7Expected);
    }
    const observed = w7LineObservation(state);
    assert.equal(observed.acceptedByKind.P4_SEAM_EXIT, 1, "W7/B0: the marker is accepted");
    assert.equal(observed.acceptedByKind.P4_EXIT_WITNESS, 1, "W7/B0: the sentinel is accepted");
    assert.deepEqual(observed.refusals, [], "W7/B0: nothing is refused");
    assert.equal(observed.linesObserved, 2, "W7/B0: exactly two lines");
    assert.equal(observed.retainedUnparsedBytes, 0, "W7/B0: nothing is left unparsed");
    assert.equal(observed.rawSha256, sha256Buffer(Buffer.from(both, "utf8")),
      "W7/B0: the digest covers every byte RECEIVED, verified against an independent digest of "
      + "the exact chunks - it is not the parser agreeing with itself");
    return { mustAccept: true, accepted: observed.acceptedByKind, refusals: observed.refusals };
  });

  const parserRefusalControls = [
    ["B1", "a well-formed marker carrying a foreign nonce is refused",
      [typedLine("P4_SEAM_CRASH", controlPoint, foreignNonce, controlPid)], ["wrong_nonce"]],
    ["B2", "a well-formed marker naming the wrong seam is refused",
      [typedLine("P4_SEAM_CRASH", "after_cas_read", goodNonce, controlPid)], ["wrong_point"]],
    ["B3", "an otherwise exact marker carrying a foreign pid is refused",
      [typedLine("P4_SEAM_CRASH", controlPoint, goodNonce, 999999)], ["wrong_pid"]],
    ["B4", "a truncated or malformed typed prefix is refused",
      ["P4_SEAM_CRASH point=" + controlPoint + " nonce=" + goodNonce + "\n"],
      ["malformed_typed_form"]],
    ["B5", "an unknown line kind is refused rather than classified",
      [typedLine("P4_SEAM_UNKNOWN", controlPoint, goodNonce, controlPid)],
      ["malformed_typed_form"]],
    ["B6", "a seam name outside the closed set is refused",
      [typedLine("P4_SEAM_CRASH", "after_open", goodNonce, controlPid)],
      ["point_not_in_closed_set"]],
    ["B7", "a duplicate line of an already-accepted kind is refused, never re-counted",
      [typedLine("P4_SEAM_CRASH", controlPoint, goodNonce, controlPid),
        typedLine("P4_SEAM_CRASH", controlPoint, goodNonce, controlPid)],
      ["duplicate_line_for_kind:P4_SEAM_CRASH"]],
    ["B8", "a missing line produces no acceptance at all", [], []],
    ["B9", "an incomplete line with no terminator is RETAINED and never judged",
      ["P4_SEAM_CRASH v1 point=" + controlPoint + " nonce=" + goodNonce + " pid="], []],
    ["B10", "non-ASCII marker material is refused, never decoded or replaced",
      [Buffer.concat([
        Buffer.from("P4_SEAM_CRASH v1 point=" + controlPoint + " nonce=", "latin1"),
        Buffer.from([0xc3, 0xa9]),
        Buffer.from("0123456789abcdef0123456789abcd pid=424242\n", "latin1"),
      ])],
      ["non_ascii_marker_material"]],
    // Every accented character here is TWO bytes, so a code-unit cap would have retained twice the
    // declared byte budget. The terminator sits early in the SAME over-cap write, so the truncated
    // retention still carries a complete line and the refusal is the cap refusal rather than the
    // silence a trailing-newline variant would have produced.
    ["B11", "an over-cap flood is bounded in BYTES, not code units, and refused",
      [Buffer.from("xxxxxxxxxx\n" + "é".repeat(W7_LINE_BUFFER_CAP), "utf8")],
      ["buffer_cap_exceeded"]],
  ];
  for (const [id, description, chunks, expectedRefusals] of parserRefusalControls) {
    runRejectionControl(id, description, () => {
      const state = newW7LineState();
      for (const piece of chunks) feedW7Lines(state, piece, w7Expected);
      const observed = w7LineObservation(state);
      assert.deepEqual(observed.refusals, expectedRefusals,
        "W7/" + id + ": exact refusal causes from the closed vocabulary");
      // A refused or absent line NEVER counts as an acceptance of any kind.
      const acceptedTotal = W7_LINE_KINDS.reduce(
        (sum, kind) => sum + observed.acceptedByKind[kind], 0,
      );
      const expectedAccepted = id === "B7" ? 1 : 0;
      assert.equal(acceptedTotal, expectedAccepted,
        "W7/" + id + ": a refused line is never counted as an accepted one");
      // The declared bound is a BYTE bound and it holds for every one of these.
      assert.equal(state.retained.length <= W7_LINE_BUFFER_CAP, true,
        "W7/" + id + ": retained bytes must never exceed the declared byte cap (got "
        + state.retained.length + ")");
      if (id === "B9") {
        assert.equal(observed.retainedUnparsedBytes > 0, true,
          "W7/B9: an unterminated line stays retained, and the arm predicate rejects on it");
        assert.equal(observed.linesObserved, 0, "W7/B9: an unterminated line is never judged");
      }
      return {
        mustFail: true,
        refusals: observed.refusals,
        accepted: observed.acceptedByKind,
        retainedUnparsedBytes: observed.retainedUnparsedBytes,
        overflowed: observed.overflowed,
      };
    });
  }

  // The A* family. The baseline is an ATTRIBUTED fact set authored here from the contract prose;
  // each control mutates exactly one thing and names the conjunct that must reject it.
  function attributedBaseline() {
    return {
      seam: controlPoint,
      expectedGeneration: 1,
      selfKill: {
        seam: controlPoint, nonce: goodNonce, pid: controlPid,
        markerAccepted: 1, foreignMarkerAccepted: 0,
        witnessAccepted: 0, witnessBindingRequested: true,
        markerRefusals: [], lineRefusals: [], overflowed: false, retainedUnparsedBytes: 0,
        duplicatesRefused: 0,
        exitCode: null, signal: "SIGKILL", resultReceived: false,
        killRequested: false, experimentalKills: 0, cleanupKills: 0,
        ledgerRead: true, generationAfterRecovery: 1, rowsAfterRecovery: 0,
      },
      control: {
        seam: controlPoint, nonce: foreignNonce, pid: controlPid + 1,
        markerAccepted: 1, foreignMarkerAccepted: 0,
        witnessAccepted: 1, witnessBindingRequested: true,
        markerRefusals: [], lineRefusals: [], overflowed: false, retainedUnparsedBytes: 0,
        duplicatesRefused: 0,
        exitCode: 1, signal: null, resultReceived: false,
        killRequested: false, experimentalKills: 0, cleanupKills: 0,
        ledgerRead: true, generationAfterRecovery: 1, rowsAfterRecovery: 0,
      },
      sourceIdentity: { childUnchanged: true, sliceUnchanged: true, sharedByBothArms: true },
    };
  }

  runRejectionControl("A0", "the baseline fact set IS attributed - the positive control that stops "
    + "every rejection below from passing because the judge refuses everything", () => {
    const verdict = judgeW7Attribution(attributedBaseline());
    assert.deepEqual(verdict.failures, [], "W7/A0: the baseline must have no failed conjunct");
    assert.equal(verdict.attributed, true, "W7/A0: the baseline must attribute");
    return { mustAccept: true, attributed: true, failures: verdict.failures };
  });

  // Synthetic identity samples for the A18-A21 derivation controls. Every sample carries the SAME
  // path and the same byte length, so only the digest can distinguish them: a derivation that
  // compared paths, or that returned a literal, would wrongly call A19-A21 shared. These are
  // authored fact shapes - no file is read, written or reverted by any control here.
  const CHILD_LEAF_PATH = "/pinned/write-child.cjs";
  const SLICE_LEAF_PATH = "/pinned/write-cas.cjs";
  const w7SourceSample = (leafPath, digestNibble) => ({
    path: leafPath,
    rawSha256: digestNibble.repeat(64),
    rawBytes: 4096,
    lfNormalizedSha256: digestNibble.repeat(64),
    lfNormalizedBytes: 4096,
  });
  // One sample set: the unchanged triple, then per-leaf overrides for the between-arms sample only.
  const w7SampleTriple = (childBetween, sliceBetween) => {
    const endpoint = {
      writeChild: w7SourceSample(CHILD_LEAF_PATH, "a"),
      writeCas: w7SourceSample(SLICE_LEAF_PATH, "b"),
    };
    return [
      endpoint,
      {
        writeChild: w7SourceSample(CHILD_LEAF_PATH, childBetween),
        writeCas: w7SourceSample(SLICE_LEAF_PATH, sliceBetween),
      },
      endpoint,
    ];
  };

  runRejectionControl("A18", "three UNCHANGED samples derive sharedByBothArms through the real "
    + "derivation - the positive control that stops A19-A21 from passing because the derivation "
    + "returns false for everything", () => {
    const [before, between, after] = w7SampleTriple("a", "b");
    const derived = deriveW7SourceIdentity(before, between, after);
    assert.equal(derived.childSharedByBothArms, true, "W7/A18: the child leaf is shared");
    assert.equal(derived.sliceSharedByBothArms, true, "W7/A18: the slice leaf is shared");
    assert.equal(derived.sharedByBothArms, true, "W7/A18: the derived conjunct holds");
    assert.equal(derived.childUnchanged, true, "W7/A18: the child endpoints agree");
    assert.equal(derived.sliceUnchanged, true, "W7/A18: the slice endpoints agree");
    // The intermediate sample is RECORDED, not just consumed, or the derivation could not be audited.
    assert.equal(derived.betweenArms, between, "W7/A18: the between-arms sample is recorded");
    assert.notEqual(derived.sharedByBothArms, undefined,
      "W7/A18: the field is produced by the derivation rather than declared by its caller");
    // And the derived fact set carries the real judge to attribution, exactly as a seam does.
    const facts = attributedBaseline();
    facts.sourceIdentity = derived;
    const verdict = judgeW7Attribution(facts);
    assert.deepEqual(verdict.failures, [], "W7/A18: a derived unchanged fact set must attribute");
    assert.equal(verdict.attributed, true, "W7/A18: the derived positive control attributes");
    return {
      mustAccept: true,
      attributed: true,
      failures: verdict.failures,
      derivedSharedByBothArms: derived.sharedByBothArms,
      betweenArmsDigests: {
        writeChild: derived.betweenArms.writeChild.rawSha256,
        writeCas: derived.betweenArms.writeCas.rawSha256,
      },
    };
  });

  const attributionRejectionControls = [
    ["A1", "an ORDINARY EXIT at the seam: the self-kill arm's exit-hook sentinel is present",
      facts => { facts.selfKill.witnessAccepted = 1; },
      ["self_kill_exit_sentinel_present"]],
    ["A2", "an EARLY exit before the seam: no marker was ever emitted",
      facts => { facts.selfKill.markerAccepted = 0; },
      ["self_kill_marker_not_exactly_one"]],
    ["A3", "a WRONG marker: the line was refused by the parser",
      facts => { facts.selfKill.markerAccepted = 0; facts.selfKill.markerRefusals = ["wrong_nonce"];
        facts.selfKill.lineRefusals = ["wrong_nonce"]; },
      ["self_kill_marker_not_exactly_one", "self_kill_line_refused"]],
    ["A4", "a MISSING HEALTHY CONTROL: the control emitted no sentinel of its own",
      facts => { facts.control.witnessAccepted = 0; },
      ["control_exit_sentinel_absent"]],
    ["A5", "SENTINEL ABSENCE ALONE is not attribution: no marker and no healthy control",
      facts => { facts.selfKill.markerAccepted = 0; facts.control.witnessAccepted = 0;
        facts.control.markerAccepted = 0; },
      ["self_kill_marker_not_exactly_one", "control_marker_not_exactly_one",
        "control_exit_sentinel_absent"]],
    ["A6", "PARENT KILL ALONE is not attribution: the parent signalled and there is no marker",
      facts => { facts.selfKill.markerAccepted = 0; facts.selfKill.killRequested = true;
        facts.selfKill.experimentalKills = 1; },
      ["self_kill_marker_not_exactly_one", "self_kill_parent_signal_requested",
        "self_kill_experimental_signal_issued"]],
    ["A7", "an UNBOUND witness in the self-kill arm: the absence explains itself",
      facts => { facts.selfKill.witnessBindingRequested = false; },
      ["self_kill_exit_witness_not_bound"]],
    ["A8", "the control is not at the same seam",
      facts => { facts.control.seam = "before_commit"; },
      ["control_seam_mismatch"]],
    ["A9", "the control shares the arm's nonce and pid, so it is not an independent control",
      facts => { facts.control.nonce = facts.selfKill.nonce; facts.control.pid = facts.selfKill.pid; },
      ["control_nonce_not_distinct", "control_pid_not_distinct"]],
    ["A10", "the self-kill arm RETURNED a result, so it did not terminate at the seam",
      facts => { facts.selfKill.resultReceived = true; },
      ["self_kill_returned_a_result"]],
    ["A11", "a partial application survived: the generation moved and a row landed",
      facts => { facts.selfKill.generationAfterRecovery = 2; facts.selfKill.rowsAfterRecovery = 1; },
      ["self_kill_generation_moved", "self_kill_rows_survived"]],
    ["A12", "the ledger was never read, which is a failed measurement and not zero rows",
      facts => { facts.selfKill.ledgerRead = false; facts.selfKill.rowsAfterRecovery = null; },
      ["self_kill_ledger_not_read", "self_kill_rows_survived"]],
    ["A13", "the pinned source changed under the arms, so the source-identity inference is void",
      facts => { facts.sourceIdentity.childUnchanged = false; },
      ["child_source_identity_changed"]],
    ["A14", "over-cap or incomplete marker bytes in the self-kill arm",
      facts => { facts.selfKill.overflowed = true; facts.selfKill.retainedUnparsedBytes = 12; },
      ["self_kill_lines_over_byte_cap", "self_kill_incomplete_trailing_line"]],
    ["A15", "the control's own exit pair was not an ordinary exit(1)",
      facts => { facts.control.exitCode = null; facts.control.signal = "SIGKILL"; },
      ["control_exit_code_not_one", "control_signal_not_null"]],
    ["A16", "an arm emitted the OTHER arm's marker kind, so it ran the other seam path",
      facts => { facts.selfKill.foreignMarkerAccepted = 1; },
      ["self_kill_foreign_marker_present"]],
    ["A17", "the control was never given its own witness binding",
      facts => { facts.control.witnessBindingRequested = false; },
      ["control_exit_witness_not_bound"]],
    // A19-A21 drive the REAL derivation, not a hand-authored sourceIdentity fact: each supplies a
    // between-arms sample whose digest differs while BOTH endpoints stay equal. That is the
    // change-and-revert case the before/after pair cannot see, so childUnchanged and sliceUnchanged
    // both still hold and the ONLY conjunct that may reject is the derived one.
    ["A19", "the CHILD leaf changed and reverted between the two arms, invisible to the endpoints",
      facts => {
        const [before, between, after] = w7SampleTriple("c", "b");
        facts.sourceIdentity = deriveW7SourceIdentity(before, between, after);
        assert.equal(facts.sourceIdentity.childUnchanged, true,
          "W7/A19: the endpoints must still agree, or this would not be the revert case");
        assert.equal(facts.sourceIdentity.sliceUnchanged, true,
          "W7/A19: the untouched leaf must still be unchanged");
        assert.equal(facts.sourceIdentity.childSharedByBothArms, false,
          "W7/A19: the child leaf is the one the derivation must reject");
        assert.equal(facts.sourceIdentity.sliceSharedByBothArms, true,
          "W7/A19: the slice leaf is not implicated by the child leaf moving");
      },
      ["arms_ran_different_sources"]],
    ["A20", "the SLICE leaf changed and reverted between the two arms - the derivation covers both "
      + "leaves, not only the child",
      facts => {
        const [before, between, after] = w7SampleTriple("a", "d");
        facts.sourceIdentity = deriveW7SourceIdentity(before, between, after);
        assert.equal(facts.sourceIdentity.sliceUnchanged, true,
          "W7/A20: the endpoints must still agree, or this would not be the revert case");
        assert.equal(facts.sourceIdentity.sliceSharedByBothArms, false,
          "W7/A20: the slice leaf is the one the derivation must reject");
        assert.equal(facts.sourceIdentity.childSharedByBothArms, true,
          "W7/A20: the child leaf is not implicated by the slice leaf moving");
      },
      ["arms_ran_different_sources"]],
    ["A21", "BOTH leaves changed and reverted between the arms",
      facts => {
        const [before, between, after] = w7SampleTriple("c", "d");
        facts.sourceIdentity = deriveW7SourceIdentity(before, between, after);
        assert.equal(facts.sourceIdentity.childUnchanged, true, "W7/A21: endpoints still agree");
        assert.equal(facts.sourceIdentity.sliceUnchanged, true, "W7/A21: endpoints still agree");
        assert.equal(facts.sourceIdentity.sharedByBothArms, false,
          "W7/A21: neither leaf is shared, and one rejection covers the conjunct");
      },
      ["arms_ran_different_sources"]],
  ];
  for (const [id, description, mutate, expectedFailures] of attributionRejectionControls) {
    runRejectionControl(id, description, () => {
      const facts = attributedBaseline();
      mutate(facts);
      const verdict = judgeW7Attribution(facts);
      assert.equal(verdict.attributed, false,
        "W7/" + id + ": this fact set must NOT attribute");
      assert.deepEqual(verdict.failures.sort(), [...expectedFailures].sort(),
        "W7/" + id + ": exactly these conjuncts must reject it, from the closed vocabulary");
      return { mustFail: true, attributed: false, failures: verdict.failures };
    });
  }

  // Three POSITIVE controls now open the families - B0 for the parser, A0 for the judge and A18 for
  // the source-identity derivation - and the total is still DERIVED from the declared tables rather
  // than hard-coded, so a control that was written but never ran is a failure here.
  assert.equal(rejectionControls.length,
    3 + parserRefusalControls.length + attributionRejectionControls.length,
    "W7: every declared rejection control must have run - B0 plus " + parserRefusalControls.length
    + " parser refusals, A0 and A18 plus " + attributionRejectionControls.length
    + " attribution refusals");
  assert.deepEqual(
    rejectionControls.filter(entry => entry.mustAccept === true).map(entry => entry.id),
    ["B0", "A0", "A18"],
    "W7: exactly the three declared positive controls ran as positives - a refusal family whose "
    + "own positive control is missing proves nothing");
  for (const entry of rejectionControls) {
    if (entry.mustFail === true) {
      assert.equal(entry.attributed === false || entry.refusals !== undefined, true,
        "W7/" + entry.id + ": a failing control must record HOW it failed");
    }
  }

  // ---- AGGREGATE FAILURE: raised only AFTER all seams have run and latched ---------------------
  // Each captured failure is re-raised with its own seam, its own verbatim assertion message and
  // its original error as the cause. Nothing is summarised away, relaxed, retried or waived.
  if (armFailures.length > 0) {
    Object.assign(evidence.cases.W7, {
      status: "failed",
      failedSeams: armFailures.map(entry => entry.crashSeam),
      observedSeams: arms.map(entry => entry.crashSeam),
      aggregateFailureNote: "every named seam was still exercised, observed and latched before "
        + "this failure was raised. The case is FAILED, not incomplete-by-abort: W7 kill-proof "
        + "remains REQUIRED and OPEN, and no seam here is read as a pass.",
    });
    throw new AggregateError(
      armFailures.map(entry => entry.error),
      "W7: " + armFailures.length + " of " + CRASH_SEAMS.length + " crash seams FAILED their "
      + "compound oracles. All " + arms.length + " seams were observed and latched first; each "
      + "failure keeps its seam, its assertion and its cause, and none is relaxed or converted "
      + "into a pass:\n"
      + armFailures.map(entry => "  - " + entry.record.failedAssertion).join("\n"),
    );
  }

  assert.equal(arms.length, CRASH_SEAMS.length, "W7: every named crash seam must be exercised");
  assert.deepEqual([...new Set(arms.map(entry => entry.status))], ["passed"],
    "W7: every recorded seam must have completed its assertions");
  // Augmented in place, NEVER reassigned: replacing the object would discard the latched seams.
  Object.assign(evidence.cases.W7, {
    status: "passed",
    seams: CRASH_SEAMS,
    childrenPerSeam: W7_ARMS_PER_SEAM,
    terminationClaim: "PROCESS TERMINATION, never power loss. No durability or fsync claim is made.",
    killScope: "the writer signals its own pid only - no process scan, no global kill - and this "
      + "case issues NO parent signal of any kind: every W7 child ended on its own",
    fabricationPolicy: "the parent NEVER synthesizes experimental_store_commit_uncertain for a "
      + "killed child; that reason stays reserved for the surviving-process COMMIT-throw case",
    separateFromW7x: "W7x remains a SEPARATE parent-authored experiment and is never a substitute "
      + "for this case: it deliberately violates the killRequested:false property asserted here.",
  });
  maybeForceFail("W7");
});

// --- W7x: EXTERNAL termination at the pinned seams, a SEPARATE case from W7 ----------------------

// W7x measures a PARENT-issued SIGKILL through the owned ChildProcess handle, at the same three
// seams W7 uses. It is NOT a replacement for W7 and NOT a resolution of it:
//   - W7 asserts killRequested === false. W7x deliberately violates that, which is precisely why
//     the two cannot share a case id.
//   - The self-delivered-SIGKILL win32 UNKNOWN that W7 records STANDS. Nothing in this case
//     relabels it as proven self-abruptness, converts it into a skip, or ships it as supported.
//     A parent-issued kill is a different event with a different reporting path, and measuring
//     this one says nothing about that one.
// This is PROCESS TERMINATION, never power loss, and no durability, fsync, OS-delivery-chronology
// or authentication claim is made anywhere below.

function newSeamNonce() {
  return crypto.randomBytes(16).toString("hex");
}

// The parent-local order is parent-local. kill() returning true is API ACCEPTANCE, not delivery,
// and nothing here infers OS chronology from it.
const W7X_AUTHORSHIP_NOTE = "authorship is DECLARED and RECORDED - this parent issued one signal "
  + "to one handle it owns - and is never inferred from the observed pair. This is not an identity "
  + "or authorship oracle: a child that lies about its point, nonce or pid is REFUSED, not "
  + "classified, and a hostile child is outside what this fixture observes.";

const W7X_BARRIER_NOTE = "the block is indefinite, not a sleep, so there is no window in which the "
  + "child advances past the seam before the kill lands. It does NOT establish that no JS ran "
  + "between the marker write and entering the wait, that the hold was actually entered, or that "
  + "the kill was delivered at the seam in OS chronology.";

test("W7x external kill boundary: a parent-issued SIGKILL at the pinned seams", async () => {
  const arms = [];
  evidence.cases.W7x = {
    status: "incomplete",
    platform: process.platform,
    seamsRequired: CRASH_SEAMS,
    arms: [],
    negativeControls: [],
    separateFromW7: "W7x is a NEW case, not a relabelling of W7. W7's killRequested:false assertion "
      + "and its self-kill win32 UNKNOWN are untouched and remain exactly as recorded.",
    pinnedParentKillPair: W7X_PINNED_PARENT_KILL_PAIR,
    authorshipNote: W7X_AUTHORSHIP_NOTE,
    barrierNote: W7X_BARRIER_NOTE,
    terminationClaim: "PROCESS TERMINATION, never power loss. No durability or fsync claim.",
  };

  // The mechanism precondition, MEASURED before any arm rather than assumed. When it does not hold
  // the arms below fail as an unmet precondition (N9); there is deliberately no spin fallback.
  const sharedMemoryWaitAvailable =
    typeof SharedArrayBuffer === "function" && typeof Atomics === "object" && Atomics !== null;
  evidence.cases.W7x.mechanism = {
    requested: "atomics_wait",
    available: sharedMemoryWaitAvailable,
    note: "RECORDED, never assumed. The seam fails as an unmet precondition where this is false.",
  };

  for (const holdSeam of CRASH_SEAMS) {
    const store = newStore("w7x-" + holdSeam);
    const nonce = newSeamNonce();
    const beforeHold = inventoryWithHashes(store.storeRoot);
    const signalsBefore = signalAudit.realSignalsIssued;

    const handle = spawnChild({ P4_HOLD_AT: holdSeam, P4_HOLD_NONCE: nonce });
    // The challenge is installed BEFORE any data can be judged. handle.child.pid is known the
    // moment fork returns, so the pid check is bound to this exact spawned process.
    const expectation = { point: holdSeam, nonce, pid: handle.child.pid };
    handle.seamExpectation = expectation;

    let markerVerdict = null;
    let markerError = null;
    let decision = null;
    let killReturn = null;
    let joinError = null;
    let cleanupJoinError = null;
    // v5: a throw out of the CLEANUP BODY itself is RECORDED here rather than propagated, so an
    // original try-body error keeps its identity. Latched and asserted below - never swallowed.
    let cleanupFailure = null;
    // v5: the preservation decision is now taken inside the finally below so the body-throw and
    // cleanup-throw paths reach it too. Declared here so the latch and assertions still read it.
    let preservation = null;
    let readyError = null;
    // Declared with the other per-arm observations so the transport evidence reaches the latch.
    let goAttempt = null;
    let goSendFailure = null;

    try {
      // v3: the READINESS path is caught like every other budgeted await. v2 let a readiness or
      // send failure propagate straight out of the arm, which skipped the evidence latch AND the
      // preservation decision below - so the very case most likely to leave a live child holding
      // the store was the one case that never registered the store as preserved.
      try {
        await withDeadline(handle.ready, PER_CHILD_TIMEOUT_MS, "W7x " + holdSeam + " ready");
        // The enclosing catch contains a SYNCHRONOUS throw out of send() and always did. What it
        // cannot contain is Node's ASYNCHRONOUS report of an undeliverable message, which with no
        // callback becomes an 'error' event and an uncaughtException. sendGo supplies that callback
        // and never rejects, so the failure arrives as latched data here instead. The marker, kill
        // and ownership gating below is deliberately UNCHANGED: a transport failure fails this arm
        // through its own predicate, it does not re-route the arm.
        goAttempt = await sendGo(handle, "go", {
          type: "go",
          storeRoot: store.storeRoot,
          options: callOptions({ mutation: mutationOf("binding-hold", { seam: holdSeam }) }),
        });
        goSendFailure = goAttempt.failure;
      } catch (error) {
        readyError = observationFailure(error);
      }

      // Budget expiry HERE is a failure of the arm - never an acceptance, and never recorded as
      // the crash arm. The existing per-child budget is used unchanged.
      if (readyError === null) {
        try {
          markerVerdict = await withDeadline(
            handle.seamMarker, PER_CHILD_TIMEOUT_MS, "W7x " + holdSeam + " marker",
          );
        } catch (error) {
          markerError = observationFailure(error);
        }
      }

      decision = decideExperimentalKill(handle.record.seamMarkerState, handle.record);
      if (readyError === null && decision.issueSignal) {
        // The ONE experimental signal, to the ONE handle this suite owns, AFTER the exact marker
        // and never before.
        killReturn = handle.kill("experimental");
        try {
          await withDeadline(handle.exited, PER_CHILD_TIMEOUT_MS, "W7x " + holdSeam + " join");
        } catch (error) {
          joinError = observationFailure(error);
        }
      }
    } finally {
      // v5: the ENTIRE cleanup body below is wrapped and the preservation decision moved into an
      // inner finally. v3 took that decision AFTER this block, so a throw out of the try body left
      // the arm before reaching it - and a bare tail-of-finally placement would still have been
      // skipped by a throw out of the cleanup body itself (handle.kill("cleanup")). The inner
      // finally is guaranteed on all three paths: normal return, try-body throw, cleanup-body throw.
      try {
      // Cleanup. For a joined child the existing exited guard makes this a no-op that issues NO
      // signal, which is how the arm keeps its exactly-one-signal property. For a refused or
      // never-announced child it DOES signal, and that cleanup kill is counted as the real signal
      // it is rather than hidden to protect a zero.
      //
      // v2: the cleanup signal is now JOINED through this same exact handle, within the unchanged
      // per-child bound. v1 signalled and walked away, so a child that refused to die was still
      // followed by an inventory and a read-write reopen of a store it was holding open - the
      // reopen would have been reading a live mid-transaction fixture and recording it as recovery
      // evidence. No new budget and no extra signal is introduced: this only waits for the kill
      // that was already issued.
      if (!handle.record.exited) {
        handle.kill("cleanup");
        // v3: this handle has now had its ONE bounded cleanup attempt. The finaliser reads this
        // flag and does NOT issue a second, untracked signal to it.
        handle.cleanupAttempted = true;
        try {
          await withDeadline(
            handle.exited, PER_CHILD_TIMEOUT_MS, "W7x " + holdSeam + " cleanup join",
          );
        } catch (error) {
          cleanupJoinError = observationFailure(error);
        }
      }
      } catch (error) {
        // RECORDED, never re-thrown: an original try-body error stays the propagating error with its
        // identity intact, and this cleanup failure survives beside it as evidence. Same
        // observationFailure convention cleanupJoinError already uses.
        cleanupFailure = observationFailure(error);
      } finally {
        // v5 PRESERVATION DECISION, taken here so EVERY exit path reaches it - readiness timeout,
        // send failure, marker refusal, kill failure, unjoined cleanup, a try-body throw or a
        // cleanup-body throw alike. This is the same function the finaliser consults; registering
        // here is what actually makes the "store preserved" claim true instead of merely stated. It
        // is taken AFTER the bounded cleanup join above, from the OBSERVED record.exited of this
        // exact handle - a requested kill is not an exit.
        //
        // This block only ASSIGNS: it never throws and never returns, so it cannot replace or
        // suppress whichever error is propagating out of the blocks above.
        preservation = registerRootPreservation({
          caseId: "W7x",
          seam: holdSeam,
          root: store.parent,
          pid: handle.record.pid,
          exited: handle.record.exited,
        });
        // v6: and the cleanup failure is PUBLISHED here, on the same guaranteed path, instead of
        // being left in the local above. When a try-body error is in flight it leaves this arm - and
        // the hold loop - the moment this finally completes, so the latch and the assertion below
        // are never reached and v5's local died with the frame. Appending to the run evidence object
        // is the only record that survives that path. Push only - it cannot throw, cannot return and
        // cannot replace or suppress whichever error is propagating.
        if (cleanupFailure !== null) {
          evidence.cleanupFailures.push({
            caseId: "W7x",
            seam: holdSeam,
            iteration: null,
            root: store.parent,
            failure: cleanupFailure,
            note: "SECONDARY cleanup-body failure recorded beside the primary error, which keeps "
              + "its identity and still propagates. Recorded in memory and serialised by the "
              + "finaliser - NOT a disk-durability claim.",
          });
        }
      }
    }

    const record = handle.record;

    // ---- FAILURE-SAFE EVIDENCE LATCH: every record below PRECEDES every assertion -------------
    const rawObserved = {
      pid: record.pid,
      exitCode: record.exitCode,
      signal: record.signal,
      exited: record.exited,
      resultReceived: record.result !== null && record.result !== undefined,
      killRequested: record.killRequested,
      killDelivered: record.killDelivered,
      killError: record.killError,
      killedByTest: record.killedByTest,
      lifecycle: childLifecycle(record),
      experimentalKills: record.experimentalKills,
      cleanupKills: record.cleanupKills,
      killIntents: [...record.killIntents],
      stderrHead: record.stderrHead === "" ? null : record.stderrHead,
      // The transport facts for this exact child, latched with the raw scalars above.
      ...ipcFacts(record),
      goSendFailure,
      transportPolicy: "a delivered go is TRANSPORT COMPLETION ONLY - never a child acknowledgement, "
        + "never a marker and never a result, and the seam, kill and storage oracles below are "
        + "unchanged by it",
    };
    evidence.children.records.push({ caseId: "W7x", holdSeam, ...lifecycleFacts(record) });

    // v2 GATE. The owned store is not touched AT ALL until this exact handle's exit has been
    // observed. An unjoined child still holds the transaction and its lock, so an inventory would
    // hash a live mid-transaction file and the read-write reopen would replay a journal underneath
    // a running writer - and both would then be recorded as recovery evidence, which they are not.
    // When the join did not happen the arm keeps the store UNTOUCHED, persists the unknown, and
    // fails below. The observations stay in the unchanged R2-2 order within the gate.
    const recoveryObservable = mayObserveRecovery(record);
    let leftover = null;
    let leftoverSidecars = null;
    let leftoverError = null;
    let observation = null;
    let observationError = null;
    let afterRecovery = null;
    let afterRecoveryError = null;
    let ledgerRead = false;
    let ledgerError = null;
    let generationAfterRecovery = null;
    let rowsAfterRecovery = null;
    let recoveryOpenCalls = 0;
    let notObservedBecause = null;

    if (!recoveryObservable) {
      notObservedBecause = "child_not_joined";
    } else {
      // (1) The leftover, recorded VERBATIM before anything reopens the store. No store was opened
      // by this parent during the hold: the held child owned the transaction and its lock.
      try {
        leftover = inventoryWithHashes(store.storeRoot);
        leftoverSidecars = sidecars(store.storeRoot);
      } catch (error) {
        leftoverError = observationFailure(error);
      }

      // (2) The tester-lane observer: one read-write open, one close, nothing else.
      try {
        recoveryOpenCalls += 1;
        observation = observeRecoveryOpen(store.dbPath);
      } catch (error) {
        observationError = observationFailure(error);
      }

      // (3) Post-recovery state, recorded SEPARATELY, neither record overwriting the other.
      try {
        afterRecovery = inventoryWithHashes(store.storeRoot);
      } catch (error) {
        afterRecoveryError = observationFailure(error);
      }
      try {
        const ledger = requireLedger(store.dbPath, "W7x/" + holdSeam);
        generationAfterRecovery = ledger.generation;
        rowsAfterRecovery = totalSectionRows(ledger);
        ledgerRead = true;
      } catch (error) {
        ledgerError = observationFailure(error);
      }
    }

    const parentRecord = {
      holdSeam,
      exitCode: record.exitCode,
      signal: record.signal,
      childOutcome: "unknown",
      commitOutcome: "unknown",
    };
    for (const forbidden of ["reason", "ok", "committed", "commitAttempted", "retrySafe"]) {
      assert.equal(Object.hasOwn(parentRecord, forbidden), false,
        "W7x/" + holdSeam + ": the parent record must NOT synthesize " + forbidden
        + " for a process that returned nothing");
    }

    const pinnedPair = Object.hasOwn(W7X_PINNED_PARENT_KILL_PAIR, process.platform)
      ? W7X_PINNED_PARENT_KILL_PAIR[process.platform] : null;
    const arm = {
      holdSeam,
      status: "incomplete",
      simulation: false,
      nonceChallenged: true,
      rawObserved,
      parentRecord,
      seamMarker: seamMarkerObservation(record.seamMarkerState),
      readyError,
      markerError,
      decision,
      decisionLimit: SEAM_DECISION_LIMIT,
      killReturn,
      joinError,
      cleanupJoinError,
      // v5: a throw out of the cleanup body itself, recorded so it is visible as the failure it is
      // instead of replacing the original try-body error.
      cleanupFailure,
      // v2 gate facts. recoveryOpenCalls is 1 for a joined arm and 0 for an unjoined one, so the
      // evidence shows positively that no reopen was attempted against a live child.
      recoveryObservable,
      notObservedBecause,
      recoveryOpenCalls,
      storePreservedUnobserved: recoveryObservable === false,
      // The owned root and what the SHARED decision said about it. A preserved root is reported
      // by the finaliser and forces cleanup clean:false rather than being silently removed.
      ownedRoot: store.parent,
      preservation,
      cleanupAttempted: handle.cleanupAttempted === true,
      signalsIssuedByThisArm: signalAudit.realSignalsIssued - signalsBefore,
      mechanismUsed: sharedMemoryWaitAvailable ? "atomics_wait" : null,
      observedPair: { exitCode: record.exitCode, signal: record.signal },
      pinnedPair,
      beforeHold,
      leftoverBeforeAnyReopen: leftover,
      leftoverSidecars,
      leftoverError,
      hotJournalPresentInLeftover: leftoverSidecars === null
        ? null : leftoverSidecars.some(name => name.endsWith("-journal")),
      hotJournalPolicy: "MEASURED, not assumed: this record reports what this run observed, and a "
        + "hot journal is never treated as recovery, durability or power-loss evidence",
      recoveryObservation: observation,
      recoveryObservationError: observationError,
      afterRecovery,
      afterRecoveryError,
      leftoverChangedByReopen: leftover === null || afterRecovery === null
        ? null : JSON.stringify(leftover) !== JSON.stringify(afterRecovery),
      ledgerRead,
      ledgerError,
      generationAfterRecovery,
      totalSectionRowsAfterRecovery: rowsAfterRecovery,
      zeroRowPolicy: "a missing or failed ledger read is recorded as null with ledgerRead:false "
        + "and is NEVER reported as zero rows",
      dwellNote: "the held process dwells in the open transaction for an unbounded interval before "
        + "the kill, where the W7 self-kill is immediate. Nothing here measures a time-dependent "
        + "effect, and the shared-memory wait stops JS progress, not the operating system.",
    };
    evidence.cases.W7x.arms.push(arm);
    arms.push(arm);

    // ---- ASSERTIONS ---------------------------------------------------------------------------
    assert.equal(sharedMemoryWaitAvailable, true,
      "W7x/" + holdSeam + ": the shared-memory wait mechanism is an UNMET PRECONDITION on this "
      + "runtime - the arm fails rather than falling back to a timed sleep or a spin");
    assert.equal(readyError, null,
      "W7x/" + holdSeam + ": the child must announce readiness and accept the go message within "
      + "the existing per-child budget - a readiness failure is a FAILURE of this arm, and it "
      + "still records its evidence and its preservation decision rather than escaping both ("
      + JSON.stringify(readyError) + ")");
    // The transport predicates, beside the readiness one they belong with and before the seam
    // oracles, so an undelivered go is reported as the undelivered go it is rather than as the
    // absent marker it would otherwise masquerade as. Both are HARD failures of this arm.
    assert.deepEqual(rawObserved.ipcErrors, [],
      "W7x/" + holdSeam + ": the child's IPC channel must raise NO error. An error here is a FAILURE "
      + "of this arm and is reported from inside its latch, which is the whole point of observing "
      + "it: unlistened, it would surface as an uncaughtException and end the run BEFORE any of "
      + "this arm's evidence or its preservation decision was written ("
      + JSON.stringify(rawObserved.ipcErrors) + ")");
    assert.equal(goSendFailure, null,
      "W7x/" + holdSeam + ": the single go command must have been DELIVERED to a live child - a "
      + "command that never reached the child is reported as undelivered and is never read as a "
      + "child that received it and declined to reach its seam ("
      + JSON.stringify(goSendFailure) + ")");
    assert.deepEqual(rawObserved.sendAttempts.map(entry => entry.delivered), [true],
      "W7x/" + holdSeam + ": exactly one go command, positively acknowledged as delivered - a send "
      + "whose return value alone looked acceptable is not a delivered command");
    assert.equal(markerError, null,
      "W7x/" + holdSeam + ": the marker must arrive within the existing per-child budget - budget "
      + "expiry is a FAILURE of this arm, never an acceptance and never the crash arm ("
      + JSON.stringify(markerError) + ")");
    assert.notEqual(markerVerdict, null, "W7x/" + holdSeam + ": a marker verdict must exist");
    assert.equal(markerVerdict.accepted, true,
      "W7x/" + holdSeam + ": the marker must be byte-exact for the typed form, at the challenged "
      + "point, carrying the challenged nonce and this child's own pid (refused because "
      + String(markerVerdict.refusedBecause) + ")");
    assert.equal(record.seamMarkerState.overflowed, false,
      "W7x/" + holdSeam + ": the bounded fd1 accumulator must not have overflowed");
    assert.equal(record.seamMarkerState.duplicateLinesRefused, 0,
      "W7x/" + holdSeam + ": the seam emits exactly one marker line");

    assert.equal(decision.issueSignal, true,
      "W7x/" + holdSeam + ": the signal is issued only after an accepted marker");
    assert.equal(killReturn, true,
      "W7x/" + holdSeam + ": kill() through the owned handle must return true - API ACCEPTANCE, "
      + "which is not delivery and not OS chronology");
    assert.equal(joinError, null,
      "W7x/" + holdSeam + ": the joined exit must be OBSERVED within budget ("
      + JSON.stringify(joinError) + ")");
    assert.equal(cleanupJoinError, null,
      "W7x/" + holdSeam + ": a cleanup signal must itself be JOINED through this same exact "
      + "handle within the unchanged bound - an unjoined cleanup leaves the fate unknown ("
      + JSON.stringify(cleanupJoinError) + ")");
    // v5: a cleanup body that threw is no longer able to end this arm green. It was caught only so
    // the original error would keep its identity; it is a HARD failure of the arm here.
    assert.equal(cleanupFailure, null,
      "W7x/" + holdSeam + ": the cleanup body itself must not throw - it is recorded rather than "
      + "propagated so the original error survives, and it fails the arm here ("
      + JSON.stringify(cleanupFailure) + ")");
    assert.equal(record.exited, true, "W7x/" + holdSeam + ": the child exit is observed, never assumed");
    // The gate itself is asserted, so an arm can never reach the storage oracle below by way of a
    // store it was not entitled to touch.
    assert.equal(recoveryObservable, true,
      "W7x/" + holdSeam + ": the store may be read as recovery evidence ONLY after an observed "
      + "exit - an unjoined child leaves the owned store untouched and fails the arm ("
      + String(notObservedBecause) + ")");
    assert.equal(recoveryOpenCalls, 1,
      "W7x/" + holdSeam + ": exactly one recovery open, and only after the observed exit");

    // Exactly one signal, to exactly one owned handle, after the exact marker and never before.
    assert.equal(record.experimentalKills, 1,
      "W7x/" + holdSeam + ": exactly ONE experimental signal to exactly one owned handle");
    assert.equal(record.cleanupKills, 0,
      "W7x/" + holdSeam + ": a joined child needs no cleanup signal, so the arm total is one");
    assert.deepEqual(record.killIntents, ["experimental"],
      "W7x/" + holdSeam + ": the only signal this arm issued was the experimental one");
    assert.equal(arm.signalsIssuedByThisArm, 1,
      "W7x/" + holdSeam + ": exactly one real signal is attributable to this arm");
    assert.equal(signalAudit.pidScans, 0, "W7x/" + holdSeam + ": no process scan, run-wide");
    assert.equal(signalAudit.processGroupsSignalled, 0,
      "W7x/" + holdSeam + ": no process group is ever signalled, run-wide");

    // The platform pair, MEASURED in this fixture against the pinned table - never inherited.
    assert.notEqual(pinnedPair, null,
      "W7x/" + holdSeam + ": platform " + process.platform + " is not in the pinned table, so the "
      + "parent-issued pair is UNMEASURED here and the arm fails rather than guessing");
    assert.equal(record.signal, pinnedPair.signal,
      "W7x/" + holdSeam + ": the parent-issued kill must report the pinned signal");
    assert.equal(record.exitCode, pinnedPair.exitCode,
      "W7x/" + holdSeam + ": the parent-issued kill must report the pinned exit code");

    // A killed child returns NOTHING. No field is synthesized for it.
    assert.equal(record.result, null,
      "W7x/" + holdSeam + ": a killed child returns NOTHING - no reason code, no committed, no "
      + "retrySafe");

    // Every existing W7 storage observation, unchanged and in the same R2-2 order.
    assert.equal(leftoverError, null,
      "W7x/" + holdSeam + ": the pre-reopen leftover must actually be observed");
    assert.equal(observationError, null,
      "W7x/" + holdSeam + ": the recovery observer must actually run");
    assert.equal(observation.opened, true,
      "W7x/" + holdSeam + ": the observer must be able to open the leftover read-write");
    assert.equal(observation.closed, true, "W7x/" + holdSeam + ": the observer closes its handle");
    assert.equal(observation.openError, null, "W7x/" + holdSeam + ": no open fault");
    assert.equal(observation.closeError, null, "W7x/" + holdSeam + ": no close fault");
    assert.equal(afterRecoveryError, null,
      "W7x/" + holdSeam + ": the post-recovery inventory must actually be observed");
    assert.equal(ledgerRead, true,
      "W7x/" + holdSeam + ": the independent opener must actually read the store - a failed read "
      + "is a failed measurement, NEVER evidence that no partial application survived ("
      + JSON.stringify(ledgerError) + ")");
    assert.equal(generationAfterRecovery, 1,
      "W7x/" + holdSeam + ": the opener reports generation g - no bump survived");
    assert.equal(rowsAfterRecovery, 0,
      "W7x/" + holdSeam + ": ZERO new rows - no partial application survived");

    arm.status = "passed";
  }

  assert.equal(arms.length, CRASH_SEAMS.length, "W7x: every named hold seam must be exercised");
  assert.deepEqual([...new Set(arms.map(entry => entry.status))], ["passed"],
    "W7x: every recorded arm must have completed its assertions");

  // ---- Negative controls: each must FAIL, none may accept --------------------------------------
  // These run against INJECTED OWNED-HANDLE DOUBLES and are labelled SIMULATION everywhere they
  // appear. No process is forked and no operating-system signal is issued by any of them. They
  // exercise the SAME decideExperimentalKill and marker parser the real arms above used, so they
  // are evidence about this suite's protocol handling - and about nothing else. NO control below
  // is storage proof; the three real arms are the only native-run evidence in this case.
  const exactMarker = (point, nonce, pid) =>
    "P4_SEAM_HOLD v1 point=" + point + " nonce=" + nonce + " pid=" + String(pid) + "\n";

  const goodNonce = "0123456789abcdef0123456789abcdef";
  const foreignNonce = "fedcba9876543210fedcba9876543210";
  const controlPoint = "after_row_insert";
  const controlPid = 424242;

  const controls = [];
  function runControl(id, description, setup) {
    const simulatedBefore = signalAudit.simulatedSignalsIssued;
    const realBefore = signalAudit.realSignalsIssued;
    const outcome = setup();
    const entry = {
      id,
      description,
      simulation: true,
      simulationNote: "INJECTED OWNED-HANDLE DOUBLE - no process forked, no OS signal issued. "
        + "Protocol evidence only; this is NOT storage proof and NOT a native-run observation.",
      ...outcome,
      simulatedSignalsIssued: signalAudit.simulatedSignalsIssued - simulatedBefore,
      realSignalsIssued: signalAudit.realSignalsIssued - realBefore,
    };
    assert.equal(entry.realSignalsIssued, 0,
      "W7x/" + id + ": a simulated control must never issue a real operating-system signal");
    evidence.cases.W7x.negativeControls.push(entry);
    controls.push(entry);
    return entry;
  }

  // A POSITIVE protocol control first, so the refusals below cannot pass merely because the parser
  // refuses everything: the exact marker, split across arbitrary chunk boundaries, is ACCEPTED.
  runControl("P1", "exact marker split across chunk boundaries is accepted", () => {
    const state = newSeamMarkerState();
    const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
    const line = exactMarker(controlPoint, goodNonce, controlPid);
    let verdict = null;
    for (const piece of [line.slice(0, 7), line.slice(7, 31), line.slice(31, 60), line.slice(60)]) {
      verdict = feedSeamMarker(state, piece, expected);
    }
    assert.notEqual(verdict, null, "W7x/P1: a split marker must still produce a verdict");
    assert.equal(verdict.accepted, true, "W7x/P1: chunk splits must not defeat the parser");
    assert.equal(state.linesObserved, 1, "W7x/P1: exactly one line");
    return { accepted: verdict.accepted, refusedBecause: verdict.refusedBecause, mustAccept: true };
  });

  runControl("D1", "a duplicate marker line after acceptance is refused", () => {
    const state = newSeamMarkerState();
    const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
    const line = exactMarker(controlPoint, goodNonce, controlPid);
    feedSeamMarker(state, line, expected);
    const verdict = feedSeamMarker(state, line, expected);
    assert.equal(verdict.accepted, false, "W7x/D1: a duplicate must revoke acceptance, never confirm it");
    assert.equal(verdict.refusedBecause, "duplicate_marker_after_acceptance", "W7x/D1: exact cause");
    assert.equal(state.duplicateLinesRefused, 1, "W7x/D1: the duplicate is counted");
    const handle = injectedOwnedHandleDouble({ pid: controlPid });
    const decision = decideExperimentalKill(state, handle.record);
    assert.equal(decision.issueSignal, false, "W7x/D1: NO signal is issued for a duplicate");
    return { accepted: false, refusedBecause: verdict.refusedBecause, failure: decision.failure };
  });

  // F1: the streaming digest is verified against INDEPENDENT known chunk fixtures. The expected
  // value is computed here, from the concatenation of the exact chunks fed, by a hash that never
  // touches the parser state - so this cannot pass by the parser agreeing with itself. This is the
  // v1 defect made unmissable: v1 hashed the post-trim retention, so a fully consumed marker
  // hashed the empty string and the digest could never witness a successful arm.
  runControl("F1", "streaming digest matches an independent digest of the known chunks", () => {
    const state = newSeamMarkerState();
    const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
    const chunks = [
      "P4_SEAM_HOLD v1 poi",
      "nt=" + controlPoint + " nonce=",
      goodNonce + " pid=" + String(controlPid) + "\n",
    ];
    for (const piece of chunks) feedSeamMarker(state, piece, expected);
    const independent = sha256Buffer(Buffer.from(chunks.join(""), "utf8"));
    const observed = seamMarkerObservation(state);
    assert.equal(state.retained.length, 0,
      "W7x/F1: the retention buffer is empty once the line is consumed - which is exactly why "
      + "hashing the retention could never describe what arrived");
    assert.equal(observed.rawSha256, independent,
      "W7x/F1: the digest must cover every byte RECEIVED, not the post-parse leftover");
    assert.equal(observed.bytesObserved, Buffer.byteLength(chunks.join(""), "utf8"),
      "W7x/F1: the byte count and the digest describe the same bytes");
    assert.equal(observed.retainedUnparsedBytes, 0, "W7x/F1: nothing is left unparsed");
    return { digestMatchesIndependentFixture: true, bytesObserved: observed.bytesObserved };
  });

  // D2 and D3: an ACCEPTED marker does not license the signal if the state as a whole is already
  // dirty at decision time. v1 checked only the judged line and signalled anyway.
  runControl("D2", "accepted marker followed by an over-cap suffix issues no signal", () => {
    const state = newSeamMarkerState();
    const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
    const accepted = feedSeamMarker(
      state, exactMarker(controlPoint, goodNonce, controlPid), expected,
    );
    assert.equal(accepted.accepted, true, "W7x/D2: the first line really was accepted");
    feedSeamMarker(state, "x".repeat(SEAM_MARKER_BUFFER_CAP + 64), expected);
    assert.equal(state.overflowed, true, "W7x/D2: the retention cap was exceeded");
    const handle = injectedOwnedHandleDouble({ pid: controlPid });
    const decision = decideExperimentalKill(state, handle.record);
    assert.equal(decision.issueSignal, false,
      "W7x/D2: an over-cap suffix after acceptance must withdraw the signal");
    assert.equal(decision.failure, "marker_refused:buffer_cap_exceeded", "W7x/D2: exact cause");
    assert.equal(handle.record.experimentalKills, 0, "W7x/D2: ZERO experimental signals");
    return { failure: decision.failure, experimentalKills: 0, mustFail: true };
  });

  runControl("D3", "accepted marker with a trailing partial suffix in the same chunk", () => {
    const state = newSeamMarkerState();
    const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
    // One single write carrying the exact marker AND unterminated trailing bytes behind it.
    const verdict = feedSeamMarker(
      state, exactMarker(controlPoint, goodNonce, controlPid) + "P4_SEAM_HOLD v1 poi", expected,
    );
    assert.equal(verdict.accepted, true, "W7x/D3: the complete line itself was exact");
    assert.equal(state.retained.length > 0, true, "W7x/D3: unterminated bytes remain retained");
    const handle = injectedOwnedHandleDouble({ pid: controlPid });
    const decision = decideExperimentalKill(state, handle.record);
    assert.equal(decision.issueSignal, false,
      "W7x/D3: trailing partial content at decision time must withdraw the signal");
    assert.equal(decision.failure, "marker_refused:trailing_partial_content", "W7x/D3: exact cause");
    assert.equal(handle.record.experimentalKills, 0, "W7x/D3: ZERO experimental signals");
    return { failure: decision.failure, experimentalKills: 0, mustFail: true };
  });

  // M1-M3: the BYTE-cap and byte-exactness controls. v2 bounded a JS string by code units and
  // decoded each chunk independently, so these are the cases that were previously unprotected.
  // Each asserts retained bytes <= the declared cap, an exact original-byte digest, and NO
  // experimental kill. No raw external text is emitted by any of them.
  const multibyteChunkControls = [
    {
      id: "M1",
      description: "multibyte sequence split across a chunk boundary is refused, not replaced",
      // A 4-byte astral sequence deliberately cut between chunks, then a newline.
      chunks: [
        Buffer.from([0x50, 0x34, 0x5f, 0xf0, 0x9f]),
        Buffer.from([0x92, 0xa9, 0x0a]),
      ],
      expectRefusal: "non_ascii_marker_material",
    },
    {
      id: "M2",
      description: "an otherwise exact marker carrying one non-ASCII byte is refused",
      chunks: [
        Buffer.concat([
          Buffer.from("P4_SEAM_HOLD v1 point=after_row_insert nonce=", "latin1"),
          Buffer.from([0xc3, 0xa9]),
          Buffer.from("0123456789abcdef0123456789abcd pid=424242\n", "latin1"),
        ]),
      ],
      expectRefusal: "non_ascii_marker_material",
    },
    {
      id: "M3",
      description: "over-cap multibyte flood is bounded in BYTES, not code units",
      // Every character here is 2 bytes, so a code-unit cap would have retained twice the bytes.
      chunks: [Buffer.from("e".repeat(SEAM_MARKER_BUFFER_CAP).replace(/e/g, "é"), "utf8")],
      expectRefusal: null,
    },
  ];
  for (const control of multibyteChunkControls) {
    runControl(control.id, control.description, () => {
      const state = newSeamMarkerState();
      const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
      for (const piece of control.chunks) feedSeamMarker(state, piece, expected);
      const joined = Buffer.concat(control.chunks);
      const observed = seamMarkerObservation(state);

      // The declared bound is a BYTE bound, and it holds for every one of these.
      assert.equal(state.retained.length <= SEAM_MARKER_BUFFER_CAP, true,
        "W7x/" + control.id + ": retained bytes must never exceed the declared byte cap (got "
        + state.retained.length + ")");
      assert.equal(observed.retainedUnparsedBytes, state.retained.length,
        "W7x/" + control.id + ": the reported retention is the actual byte length");
      // The digest covers the ORIGINAL bytes, verified against an independent digest of them.
      assert.equal(observed.rawSha256, sha256Buffer(joined),
        "W7x/" + control.id + ": the digest must be of the original bytes, before any trimming "
        + "or decoding");
      assert.equal(observed.bytesObserved, joined.length,
        "W7x/" + control.id + ": every original byte is counted");
      if (control.expectRefusal !== null) {
        assert.notEqual(state.verdict, null, "W7x/" + control.id + ": a verdict must exist");
        assert.equal(state.verdict.accepted, false,
          "W7x/" + control.id + ": non-ASCII marker material is REFUSED, never decoded or replaced");
        assert.equal(state.verdict.refusedBecause, control.expectRefusal,
          "W7x/" + control.id + ": exact refusal cause");
      }
      const handle = injectedOwnedHandleDouble({ pid: controlPid });
      const decision = decideExperimentalKill(state, handle.record);
      assert.equal(decision.issueSignal, false,
        "W7x/" + control.id + ": NO experimental kill is issued for this state");
      assert.equal(handle.record.experimentalKills, 0,
        "W7x/" + control.id + ": ZERO experimental signals");
      return {
        retainedBytes: state.retained.length,
        byteCapRespected: true,
        digestMatchesOriginalBytes: true,
        refusedBecause: state.verdict === null ? null : state.verdict.refusedBecause,
        failure: decision.failure,
        experimentalKills: 0,
        mustFail: true,
      };
    });
  }

  // R1-R3: the OWNED-ROOT PRESERVATION controls. These call the exact functions the finaliser
  // calls - preservationDecision, registerRootPreservation, mayCleanUpRoot and mayReSignalHandle -
  // rather than restating the rule, so a green control means the real finalisation path is the one
  // that was proven. R1 deregisters its synthetic root afterwards and proves the deregistration,
  // so it cannot alter what the real run preserves. No filesystem call is made by any of them.
  const syntheticRoot = path.join(WORK_DIR, TMP_PREFIX + "w7x-simulated-unjoined-root");

  runControl("R1", "an unjoined W7x root is preserved by the shared finaliser decision", () => {
    const handle = injectedOwnedHandleDouble({ pid: controlPid, joins: false });
    handle.kill("experimental");
    assert.equal(handle.record.exited, false, "W7x/R1: the child was never joined");
    const decision = registerRootPreservation({
      caseId: "W7x", seam: controlPoint, root: syntheticRoot, pid: handle.record.pid,
      exited: handle.record.exited,
    });
    assert.equal(decision.preserve, true, "W7x/R1: an unobserved exit preserves the owned root");
    assert.equal(decision.because, "child_not_joined", "W7x/R1: exact cause");
    assert.equal(mayCleanUpRoot(syntheticRoot), false,
      "W7x/R1: the finaliser's own predicate must refuse to remove or chmod this root");
    assert.equal(mayCleanUpRoot(path.join(syntheticRoot, "store")), false,
      "W7x/R1: everything under a preserved root is preserved with it");
    // Deregister, so this simulation cannot change what the real run preserves - and prove it.
    preservedRoots.delete(syntheticRoot);
    assert.equal(mayCleanUpRoot(syntheticRoot), true,
      "W7x/R1: the decision is driven by the shared map, not by a hardcoded path");
    // The closed failure cause is the one the shared preservation decision just returned, read
    // back from that decision rather than retyped - so this record cannot drift from the cause
    // the assertions above proved. mustFail stays, and the shared audit below now accepts it
    // because it carries HOW it failed.
    return {
      preserve: true,
      because: decision.because,
      failure: decision.because,
      deregistered: true,
      mustFail: true,
    };
  });

  runControl("R2", "a joined root is NOT preserved and still cleans normally", () => {
    const handle = injectedOwnedHandleDouble({ pid: controlPid });
    handle.kill("experimental");
    assert.equal(handle.record.exited, true, "W7x/R2: this child WAS joined");
    const decision = registerRootPreservation({
      caseId: "W7x", seam: controlPoint, root: syntheticRoot, pid: handle.record.pid,
      exited: handle.record.exited,
    });
    assert.equal(decision.preserve, false,
      "W7x/R2: an OBSERVED exit means the root is cleaned normally - preservation is not blanket");
    assert.equal(preservedRoots.has(syntheticRoot), false,
      "W7x/R2: a joined root is never entered into the preservation map");
    assert.equal(mayCleanUpRoot(syntheticRoot), true, "W7x/R2: the finaliser may clean it");
    return { preserve: false, cleansNormally: true };
  });

  runControl("R3", "a handle with a bounded cleanup attempt is not re-signalled", () => {
    const handle = injectedOwnedHandleDouble({ pid: controlPid, joins: false });
    assert.equal(mayReSignalHandle(handle), true,
      "W7x/R3: before any cleanup attempt the finaliser would still signal it");
    handle.kill("cleanup");
    handle.cleanupAttempted = true;
    const signalsBeforeFinaliser = signalAudit.simulatedSignalsIssued;
    assert.equal(mayReSignalHandle(handle), false,
      "W7x/R3: after its ONE bounded cleanup attempt the finaliser must NOT signal it again");
    assert.equal(signalAudit.simulatedSignalsIssued, signalsBeforeFinaliser,
      "W7x/R3: consulting the predicate issues nothing");
    assert.equal(handle.record.cleanupKills, 1,
      "W7x/R3: exactly one cleanup signal was ever issued to this handle");
    assert.equal(childLifecycle(handle.record), "kill-delivered-exit-unobserved",
      "W7x/R3: the fate stays recorded as unknown rather than re-signalled off the books");
    // The closed cause here is the LIFECYCLE verdict already asserted above, taken from
    // childLifecycle rather than restated: the fate is unknown because the exit was never
    // observed, and that is exactly how this control fails.
    return {
      reSignalled: false,
      cleanupKills: handle.record.cleanupKills,
      lifecycle: childLifecycle(handle.record),
      failure: childLifecycle(handle.record),
      mustFail: true,
    };
  });

  // N8b: the recovery gate itself. For an unjoined handle the store is NOT read - no inventory,
  // no reopen, no ledger - and the arm fails instead.
  runControl("N8b", "recovery is never called for an unjoined handle", () => {
    const handle = injectedOwnedHandleDouble({ pid: controlPid, joins: false });
    handle.kill("experimental");
    assert.equal(handle.record.exited, false, "W7x/N8b: the child was never joined");
    assert.equal(mayObserveRecovery(handle.record), false,
      "W7x/N8b: an unjoined handle may NOT have its store read as recovery evidence");
    let recoveryOpenCalls = 0;
    if (mayObserveRecovery(handle.record)) recoveryOpenCalls += 1;
    assert.equal(recoveryOpenCalls, 0,
      "W7x/N8b: zero recovery opens against a store a live child may still be holding");
    // The closed cause comes from the SAME shared preservation decision the finaliser uses, so
    // this record names the unjoined cause in the one vocabulary the rest of the case uses rather
    // than in a literal of its own.
    const notObservedBecause = preservationDecision({ exited: handle.record.exited }).because;
    assert.equal(notObservedBecause, "child_not_joined",
      "W7x/N8b: the unjoined cause is the shared closed cause, not a control-local string");
    return {
      recoveryOpenCalls,
      notObservedBecause,
      failure: notObservedBecause,
      storePreserved: true,
      mustFail: true,
    };
  });

  // N1-N5: refused inertly, NO signal issued, the arm fails.
  const refusalControls = [
    ["N1", "no marker ever emitted", null, "no_marker_observed"],
    ["N2", "well-formed marker carrying a foreign nonce",
      exactMarker(controlPoint, foreignNonce, controlPid), "marker_refused:wrong_nonce"],
    ["N3", "well-formed marker naming the wrong point",
      exactMarker("after_cas_read", goodNonce, controlPid), "marker_refused:wrong_point"],
    ["N4", "otherwise exact marker carrying a foreign pid",
      exactMarker(controlPoint, goodNonce, 999999), "marker_refused:wrong_pid"],
    ["N5", "truncated or malformed typed prefix",
      "P4_SEAM_HOLD point=" + controlPoint + " nonce=" + goodNonce + "\n",
      "marker_refused:malformed_typed_form"],
  ];
  for (const [id, description, line, expectedFailure] of refusalControls) {
    runControl(id, description, () => {
      const state = newSeamMarkerState();
      const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
      if (line !== null) feedSeamMarker(state, line, expected);
      const handle = injectedOwnedHandleDouble({ pid: controlPid });
      const decision = decideExperimentalKill(state, handle.record);
      assert.equal(decision.issueSignal, false,
        "W7x/" + id + ": a refused or absent marker issues NO signal");
      assert.equal(decision.failure, expectedFailure, "W7x/" + id + ": exact refusal cause");
      assert.equal(handle.record.killRequested, false,
        "W7x/" + id + ": nothing was signalled, not even the double");
      return { accepted: false, failure: decision.failure, mustFail: true };
    });
  }

  // N6: the child announces, then exits ordinarily BEFORE the kill request. The arm fails and is
  // never recorded as a crash arm.
  runControl("N6", "child announces then exits ordinarily before the kill request", () => {
    const state = newSeamMarkerState();
    const expected = { point: controlPoint, nonce: goodNonce, pid: controlPid };
    const verdict = feedSeamMarker(state, exactMarker(controlPoint, goodNonce, controlPid), expected);
    assert.equal(verdict.accepted, true, "W7x/N6: the marker itself was exact");
    const handle = injectedOwnedHandleDouble({ pid: controlPid, alreadyExited: true, exitCode: 0 });
    const decision = decideExperimentalKill(state, handle.record);
    assert.equal(decision.issueSignal, false, "W7x/N6: no signal is issued to an exited child");
    assert.equal(decision.failure, "exit_observed_before_kill_request", "W7x/N6: exact cause");
    return {
      exitObservedBeforeKillRequest: true,
      failure: decision.failure,
      neverACrashArm: "an ordinary self-exit before the kill is a FAILED W7x arm and is never "
        + "recorded as, or merged into, the W7 crash arm",
    };
  });

  // N7: kill() returns false, or throws. Both fail. A signal IS attempted here, against the
  // double only, and is counted as the simulated attempt it is.
  runControl("N7a", "kill() returns false", () => {
    const handle = injectedOwnedHandleDouble({ pid: controlPid, killReturns: false });
    const returned = handle.kill("experimental");
    assert.equal(returned, false, "W7x/N7a: a refused kill must be reported as refused");
    assert.equal(handle.record.killedByTest, false,
      "W7x/N7a: a refused kill leaves the fate UNKNOWN - it is never read as a clean exit");
    assert.equal(childLifecycle(handle.record), "kill-failed-unknown", "W7x/N7a: exact lifecycle");
    return { killReturn: returned, lifecycle: childLifecycle(handle.record), mustFail: true };
  });

  runControl("N7b", "kill() throws", () => {
    const handle = injectedOwnedHandleDouble({ pid: controlPid, killThrows: true });
    const returned = handle.kill("experimental");
    assert.equal(returned, false, "W7x/N7b: a throwing kill must be reported as not delivered");
    assert.notEqual(handle.record.killError, null, "W7x/N7b: the thrown cause is recorded");
    assert.equal(childLifecycle(handle.record), "kill-failed-unknown", "W7x/N7b: exact lifecycle");
    return { killReturn: returned, lifecycle: childLifecycle(handle.record), mustFail: true };
  });

  // N8: marker observed, kill accepted, child NOT joined within budget.
  runControl("N8", "kill accepted but the child is never joined", () => {
    const handle = injectedOwnedHandleDouble({ pid: controlPid, joins: false });
    const returned = handle.kill("experimental");
    assert.equal(returned, true, "W7x/N8: the kill was accepted");
    assert.equal(handle.record.exited, false, "W7x/N8: no exit was observed");
    assert.equal(childLifecycle(handle.record), "kill-delivered-exit-unobserved",
      "W7x/N8: an unobserved exit stays distinct from an observed one and is never folded into it");
    return { killReturn: returned, lifecycle: childLifecycle(handle.record), mustFail: true };
  });

  // N9: the shared-memory wait mechanism is unavailable - an UNMET PRECONDITION, never a fallback.
  // Modelled at the parent boundary: the seam throws instead of holding, so the child returns a
  // result and no marker ever arrives.
  runControl("N9", "shared-memory wait unavailable: unmet precondition, no fallback", () => {
    const state = newSeamMarkerState();
    const handle = injectedOwnedHandleDouble({ pid: controlPid });
    handle.record.result = { ok: false, reason: REASON_TRANSACTION_FAILED };
    const decision = decideExperimentalKill(state, handle.record);
    assert.equal(decision.issueSignal, false, "W7x/N9: no marker, so no signal");
    assert.equal(decision.failure, "no_marker_observed", "W7x/N9: exact cause");
    return {
      failure: decision.failure,
      mustFail: true,
      fallbackPolicy: "there is deliberately NO spin fallback: an indefinite spin executes JS "
        + "continuously. An unavailable mechanism fails the arm as an unmet precondition.",
    };
  });

  assert.equal(controls.length, 22,
    "W7x: every declared control must have run - P1, D1, F1, D2, D3, M1-M3, R1-R3, N8b and N1-N9 "
    + "with N7 split into N7a and N7b");
  for (const entry of controls) {
    if (entry.mustFail === true) {
      assert.notEqual(entry.failure === undefined && entry.killReturn === undefined, true,
        "W7x/" + entry.id + ": a failing control must record how it failed");
    }
  }

  Object.assign(evidence.cases.W7x, {
    status: "passed",
    seams: CRASH_SEAMS,
    signalAccounting: {
      experimentalKillsIssued: signalAudit.experimentalKillsIssued,
      cleanupKillsIssued: signalAudit.cleanupKillsIssued,
      realSignalsIssued: signalAudit.realSignalsIssued,
      simulatedSignalsIssued: signalAudit.simulatedSignalsIssued,
      pidScans: signalAudit.pidScans,
      processGroupsSignalled: signalAudit.processGroupsSignalled,
      note: "experimental and cleanup kills are counted SEPARATELY and never summed into one "
        + "zero-signal claim. A refused or never-announced child still has to be joined through "
        + "its exact handle, and the cleanup signal that requires is reported as a real signal.",
    },
    decisionLimit: SEAM_DECISION_LIMIT,
    recoveryGate: "the owned store is read as recovery evidence ONLY after an observed exit of "
      + "the exact handle. An unjoined child leaves the store untouched, persists the unknown and "
      + "fails the arm; it is never reopened underneath a live writer.",
    simulationBoundary: "the three seam arms above are REAL native-run evidence. Every negative "
      + "control is an injected owned-handle double, labelled simulation, and NO simulation is "
      + "counted as storage proof or as an observation of any operating system.",
    notClaimed: "no power-loss, durability, fsync or hot-journal-recovery proof; no malicious-writer "
      + "or authorship proof; no OS delivery chronology; no authentication evidence; and no "
      + "statement whatsoever about the W7 self-kill win32 UNKNOWN, which stands.",
  });
  maybeForceFail("W7x");
});

// --- W8: rollback and close faults - all four cleanup outcomes, all SYNTHETIC -------------------

function distinctCauses(result, context, expected) {
  const cleanup = result.cleanupError === undefined || result.cleanupError === null
    ? {} : result.cleanupError;
  const present = {
    error: result.error !== undefined && result.error !== null,
    rollback: cleanup.rollback !== undefined && cleanup.rollback !== null,
    close: cleanup.close !== undefined && cleanup.close !== null,
  };
  assert.deepEqual(present, expected, context + ": exactly these causes must be present, each in "
    + "its own field, none overwriting another");
  // "No cause overwrites another" is a statement about OBJECT IDENTITY, so it is measured by
  // REFERENCE. JSON.stringify(err) is not a usable discriminator here: on an Error, message, stack
  // and name are all non-enumerable, so two separately allocated Errors both serialize to the same
  // text (for the synthetic seams, {"synthetic":true}) and a Set of those texts collapses to 1 even
  // though nothing was overwritten. Reference distinctness is exactly the asserted property.
  //
  // R2-7 forbids message-derived verdicts, so error.message is deliberately NOT read here and is
  // never used as a discriminator - doing so would introduce an Error.message classifier.
  const retained = [];
  if (present.error) retained.push(result.error);
  if (present.rollback) retained.push(cleanup.rollback);
  if (present.close) retained.push(cleanup.close);
  assert.equal(new Set(retained).size, retained.length,
    context + ": the retained causes must be DISTINCT OBJECTS - no cause overwrites another. "
    + "Measured by reference identity, never by serialization and never by message.");
  // Aliasing is named separately from distinctness so a collapse is reported as what it is.
  const aliasedPairs = [];
  for (let i = 0; i < retained.length; i += 1) {
    for (let j = i + 1; j < retained.length; j += 1) {
      if (retained[i] === retained[j]) aliasedPairs.push([i, j]);
    }
  }
  assert.deepEqual(aliasedPairs, [],
    context + ": no two retained cause fields may be the SAME object reference");
  return {
    present,
    cleanup,
    causeIdentity: {
      retainedCount: retained.length,
      distinctReferences: new Set(retained).size,
      aliasedPairs,
      method: "reference identity (===) over the retained cause fields",
      notUsed: "JSON.stringify is NOT a discriminator (Error message/stack/name are "
        + "non-enumerable); error.message is NEVER read as a verdict (R2-7)",
    },
  };
}

test("W8 synthetic rollback and close faults: the four cleanup outcomes", () => {
  const arms = [];

  // Outcome 1: rollback ok, close ok.
  {
    const store = newStore("w8-1");
    const result = seamedCall({ P4_FAIL_AT: "after_row_insert" }, store.storeRoot, callOptions());
    expectRefusal("W8", "1:rollback-ok-close-ok", result, {
      reason: REASON_TRANSACTION_FAILED, commitAttempted: false, committed: false, retrySafe: true,
    }, { synthetic: true });
    distinctCauses(result, "W8/1", { error: true, rollback: false, close: false });
    const ledger = requireLedger(store.dbPath, "W8/1");
    assert.equal(ledger.generation, 1, "W8/1: the generation is unchanged");
    assert.equal(totalSectionRows(ledger), 0, "W8/1: no row survived");
    arms.push({ outcome: 1, arm: "rollback-ok-close-ok", synthetic: true, result,
      generationAfter: ledger.generation, rowsAfter: totalSectionRows(ledger) });
  }

  // Outcome 2: rollback throws, close ok. A failed ROLLBACK never skips the close.
  {
    const store = newStore("w8-2");
    const result = seamedCall({ P4_FAIL_AT: "after_row_insert", P4_ROLLBACK_FAULT: "1" },
      store.storeRoot, callOptions());
    expectRefusal("W8", "2:rollback-throws-close-ok", result, {
      reason: REASON_ROLLBACK_FAILED, commitAttempted: false, committed: false, retrySafe: false,
    }, { synthetic: true });
    distinctCauses(result, "W8/2", { error: true, rollback: true, close: false });
    const ledger = requireLedger(store.dbPath, "W8/2");
    assert.equal(ledger.generation, 1, "W8/2: the generation is unchanged");
    assert.equal(totalSectionRows(ledger), 0, "W8/2: no row survived");
    arms.push({ outcome: 2, arm: "rollback-throws-close-ok", synthetic: true, result,
      generationAfter: ledger.generation, rowsAfter: totalSectionRows(ledger) });
  }

  // Outcome 3: rollback ok, close throws.
  {
    const store = newStore("w8-3");
    const result = seamedCall({ P4_FAIL_AT: "after_row_insert", P4_CLOSE_FAULT: "1" },
      store.storeRoot, callOptions());
    expectRefusal("W8", "3:rollback-ok-close-throws", result, {
      reason: REASON_CLOSE_FAILED, commitAttempted: false, committed: false, retrySafe: false,
    }, { synthetic: true });
    distinctCauses(result, "W8/3", { error: true, rollback: false, close: true });
    const ledger = requireLedger(store.dbPath, "W8/3");
    assert.equal(ledger.generation, 1, "W8/3: the generation is unchanged");
    assert.equal(totalSectionRows(ledger), 0, "W8/3: no row survived");
    arms.push({ outcome: 3, arm: "rollback-ok-close-throws", synthetic: true, result,
      generationAfter: ledger.generation, rowsAfter: totalSectionRows(ledger) });
  }

  // Outcome 4: rollback throws AND close throws - all three causes retained separately.
  {
    const store = newStore("w8-4");
    const result = seamedCall(
      { P4_FAIL_AT: "after_row_insert", P4_ROLLBACK_FAULT: "1", P4_CLOSE_FAULT: "1" },
      store.storeRoot, callOptions());
    expectRefusal("W8", "4:rollback-throws-close-throws", result, {
      reason: REASON_ROLLBACK_FAILED, commitAttempted: false, committed: false, retrySafe: false,
    }, { synthetic: true });
    distinctCauses(result, "W8/4", { error: true, rollback: true, close: true });
    const ledger = requireLedger(store.dbPath, "W8/4");
    assert.equal(ledger.generation, 1, "W8/4: the generation is unchanged");
    assert.equal(totalSectionRows(ledger), 0, "W8/4: no row survived");
    arms.push({ outcome: 4, arm: "rollback-throws-close-throws", synthetic: true, result,
      generationAfter: ledger.generation, rowsAfter: totalSectionRows(ledger) });
  }

  // The post-commit close failure: committed:true is PRESERVED, never swallowed and never ok:true.
  {
    const store = newStore("w8-post-commit-close");
    const value = { admitted: true, note: "p4" };
    const result = seamedCall({ P4_CLOSE_FAULT: "1" }, store.storeRoot, callOptions());
    expectRefusal("W8", "5:post-commit-close-throws", result, {
      reason: REASON_CLOSE_FAILED, commitAttempted: true, committed: true, retrySafe: false,
    }, { synthetic: true });
    assert.notEqual(result.ok, true, "W8/5: a close failure is never reported as ok:true");
    const shaAfterFault = sha256File(store.dbPath);
    const ledger = requireLedger(store.dbPath, "W8/5");
    assert.equal(ledger.generation, 2,
      "W8/5: the store holds the COMMITTED state at generation g + 1");
    assert.deepEqual(sectionKeys(ledger, TARGET_SECTION), ["binding-alpha"],
      "W8/5: the committed row is present");
    assert.deepEqual(ledger[TARGET_SECTION]["binding-alpha"], value,
      "W8/5: the committed value is exactly what was written");
    assert.deepEqual(sidecars(store.storeRoot), [],
      "W8/5: no hot sidecar remains after a returned COMMIT");
    // Byte STABILITY of the committed state, measured rather than compared against a twin store:
    // no cross-store raw-byte equality is asserted anywhere in this track.
    assert.equal(sha256File(store.dbPath), shaAfterFault,
      "W8/5: the committed bytes are stable across the independent verifier read");
    arms.push({ outcome: "post-commit", arm: "close-throws-after-returned-commit", synthetic: true,
      result, generationAfter: ledger.generation, rowsAfter: totalSectionRows(ledger),
      sha256AfterFault: shaAfterFault, sidecarsAfter: sidecars(store.storeRoot),
      committedStateClaim: "asserted through the INDEPENDENT P2 opener (generation g + 1, the exact "
        + "row and value) plus byte stability of the file; no cross-store byte equality is asserted" });
  }

  assert.equal(arms.length, 5, "W8: four cleanup outcomes plus the post-commit close arm");
  evidence.cases.W8 = {
    arms,
    seamPolicy: "P4_ROLLBACK_FAULT and P4_CLOSE_FAULT are tester-injected SYNTHETIC seams, inert "
      + "unset, that can only ADD a failure. The real close is always attempted first and a real "
      + "close failure wins.",
    unmeasured: "no runner produced a native ROLLBACK or close failure, so NATIVE rollback and "
      + "close failure behaviour is UNMEASURED and is not claimed here (section 7).",
    orderingClaim: "on any in-transaction failure the slice attempts ROLLBACK then close, each in "
      + "its own guard; a failed ROLLBACK never skips the close",
    verdictSource: "actual state re-read through the independent P2 opener. No verdict is derived "
      + "from a thrown error message anywhere in this suite.",
  };
  maybeForceFail("W8");
});

// --- W9: structural ownership, scoped to the runtime leaf ---------------------------------------

// A deliberately small scanner: it removes line and block comments and replaces every string
// literal body with a placeholder, so a forbidden WORD appearing in prose can never satisfy or
// break a code assertion. Declared limitation, recorded in the evidence: a regular-expression
// literal containing a quote character would be mis-scanned. The runtime leaf is asserted below to
// contain no such literal, so the limitation is closed by measurement rather than assumed away.
function scanSource(file) {
  const source = fs.readFileSync(file, "utf8");
  const strings = [];
  let code = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      let literal = "";
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") { literal += source[index] + String(source[index + 1]); index += 2; continue; }
        if (source[index] === quote) { index += 1; break; }
        literal += source[index];
        index += 1;
      }
      code += "\u0001S" + strings.length + "\u0001";
      strings.push({ quote, literal });
      continue;
    }
    code += ch;
    index += 1;
  }
  const requires = [];
  const pattern = /require\(\s*\u0001S(\d+)\u0001\s*\)/g;
  let match = pattern.exec(code);
  while (match !== null) {
    requires.push(strings[Number(match[1])].literal);
    match = pattern.exec(code);
  }
  return { file, source, code, strings, requires };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

const SQL_KEYWORD = /\b(BEGIN|COMMIT|ROLLBACK|SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|PRAGMA|REPLACE|VACUUM)\b/i;

function sqlLiterals(scan) {
  return scan.strings.map(entry => entry.literal).filter(literal => SQL_KEYWORD.test(literal));
}

// The transitive RELATIVE-require closure, by basename. A module that never appears here is
// unreachable from the entry point.
function relativeClosure(entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  const reached = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current !== entryFile) reached.push(path.basename(current));
    const scan = scanSource(current);
    for (const specifier of scan.requires) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(current), specifier);
      if (fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  return reached.sort();
}

const FORBIDDEN_RUNTIME_TOKENS = [
  "mkdir", "mkdirSync", "unlink", "unlinkSync", "rmSync", "rmdir", "rmdirSync",
  "truncate", "truncateSync", "rename", "renameSync",
  "existsSync", "statSync", "lstat", "lstatSync", "accessSync", "access",
  "readFileSync", "writeFileSync", "chmod", "chmodSync",
];

// --- W9 gated-seam fence: a PURE predicate with a CLOSED violation vocabulary -------------------
//
// The runtime leaf now carries three gated seams: the W7 self-kill marker, the W7 ordinary-exit
// control and the W7x hold. All three emit through ONE function, which is also the one place the
// core filesystem module is required. The fence below measures that arrangement rather than a
// single literal position, and it is a pure function so the negative controls in the case can
// prove it discriminates.
//
// Every expected name here is authored in this lane. The predicate is never imported from, and
// never derived from, the leaf it judges.
const W9_EMITTER_FUNCTION = "emitSeamLine";
const W9_SEAM_GATES = [
  { fn: "crashIfRequested", gate: "process.env.P4_CRASH_AT" },
  { fn: "exitControlIfRequested", gate: "process.env.P4_EXIT_AT" },
  { fn: "holdIfRequested", gate: "process.env.P4_HOLD_AT" },
];
// Each terminator is fenced to the ONE seam that is allowed to reach it. "Exactly one, and there"
// is the property; a second occurrence anywhere is a violation whatever it looks like.
const W9_FENCED_TERMINATORS = [
  { token: "process.kill(", fn: "crashIfRequested", violation: "process_kill_not_exactly_one_in_its_seam" },
  { token: "process.exit(", fn: "exitControlIfRequested", violation: "process_exit_not_exactly_one_in_its_seam" },
];

// A top-level function's span: from its declaration to the next column-zero declaration. Both
// runtime leaves keep every declaration at column zero, so this boundary is exact for them, and
// the synthetic fence samples are authored the same way.
function functionSpanIn(code, name) {
  const start = code.indexOf("function " + name + "(");
  if (start === -1) return null;
  const after = code.indexOf("\nfunction ", start + 1);
  return { start, end: after === -1 ? code.length : after };
}

function positionsOf(code, needle) {
  const found = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

// Violations are compared as SORTED lists everywhere, so the predicate's internal ordering is
// never something an expectation can accidentally depend on.
function w9SortedViolations(violations) {
  return [...violations].sort();
}

function w9RequireSites(scan) {
  const sites = [];
  const pattern = /require\(\s*\u0001S(\d+)\u0001\s*\)/g;
  let match = pattern.exec(scan.code);
  while (match !== null) {
    sites.push({ specifier: scan.strings[Number(match[1])].literal, at: match.index });
    match = pattern.exec(scan.code);
  }
  return sites;
}

function w9GatedEmitterViolations(scan) {
  const code = scan.code;
  const violations = [];
  const requireSites = w9RequireSites(scan);

  // Load-time surface. "Top level" is a MEASURED position: everything before the first
  // column-zero function declaration.
  const firstFunctionAt = code.indexOf("\nfunction ");
  if (firstFunctionAt === -1) violations.push("no_function_declaration");
  const topLevel = requireSites
    .filter(site => firstFunctionAt === -1 || site.at < firstFunctionAt)
    .map(site => site.specifier);
  if (topLevel.length !== 1 || topLevel[0] !== "better-sqlite3") {
    violations.push("top_level_require_not_only_pinned_binding");
  }
  if (requireSites.some(site => site.specifier.startsWith("."))) {
    violations.push("relative_require_present");
  }
  for (const banned of ["fs", "path", "node:path"]) {
    if (requireSites.some(site => site.specifier === banned)) {
      violations.push("banned_require:" + banned);
    }
  }

  // Exactly one node:fs require, and it lives inside the one emitter.
  const emitterSpan = functionSpanIn(code, W9_EMITTER_FUNCTION);
  const fsSites = requireSites.filter(site => site.specifier === "node:fs");
  if (fsSites.length !== 1) {
    violations.push("node_fs_require_not_exactly_one");
  } else if (emitterSpan === null
    || !(fsSites[0].at > emitterSpan.start && fsSites[0].at < emitterSpan.end)) {
    violations.push("node_fs_require_outside_emitter");
  }
  if (emitterSpan === null) violations.push("emitter_function_absent");

  // Every seam declares its gate, and the gate textually precedes the emit it guards.
  const seamSpans = [];
  for (const entry of W9_SEAM_GATES) {
    const span = functionSpanIn(code, entry.fn);
    if (span === null) {
      violations.push("seam_function_absent:" + entry.fn);
      continue;
    }
    seamSpans.push({ ...entry, span });
    const body = code.slice(span.start, span.end);
    const gateAt = body.indexOf(entry.gate);
    const emitAt = body.indexOf(W9_EMITTER_FUNCTION + "(");
    if (gateAt === -1) violations.push("gate_absent:" + entry.fn);
    else if (emitAt === -1) violations.push("emit_absent:" + entry.fn);
    else if (gateAt >= emitAt) violations.push("gate_does_not_precede_emit:" + entry.fn);
  }

  // No emitter call site outside a gated seam. The emitter's own declaration is excluded by
  // skipping its whole span; the emitter never calls itself.
  const callSites = positionsOf(code, W9_EMITTER_FUNCTION + "(").filter(
    at => emitterSpan === null || at < emitterSpan.start || at >= emitterSpan.end,
  );
  if (callSites.some(at => !seamSpans.some(
    entry => at > entry.span.start && at < entry.span.end,
  ))) {
    violations.push("emitter_called_outside_gated_seam");
  }

  // Each terminator exactly once, inside the one seam entitled to it.
  for (const entry of W9_FENCED_TERMINATORS) {
    const span = functionSpanIn(code, entry.fn);
    const sites = positionsOf(code, entry.token);
    if (sites.length !== 1 || span === null
      || !(sites[0] > span.start && sites[0] < span.end)) {
      violations.push(entry.violation);
    }
  }

  // The runtime leaf registers NO listener: with no seam set it must gain no side effect of any
  // kind, and a listener is a side effect whether or not it ever fires.
  if (/\bprocess\s*\.\s*on\s*\(/.test(code)) {
    violations.push("listener_registered_in_runtime_leaf");
  }

  // Alternative exit paths. Excluding these is an INFERENCE from source identity, never an
  // OS-attested fact - the case records it as such - but the source property itself is measured.
  if (/\breallyExit\b/.test(code)) violations.push("alternative_exit_path:reallyExit");
  if (/\bprocess\s*\.\s*abort\s*\(/.test(code)) violations.push("alternative_exit_path:abort");

  return w9SortedViolations(violations);
}

test("W9 structural ownership of the runtime leaf, and fixture unreachability", () => {
  const writeCas = scanSource(WRITE_CAS_SOURCE);
  const writeChild = scanSource(WRITE_CHILD_SOURCE);
  const observer = scanSource(RECOVERY_OBSERVE_SOURCE);
  const lockHoldPeer = scanSource(LOCK_HOLD_CHILD_SOURCE);

  // No filesystem mutation, no probe, and no fs surface at all in the runtime leaf. The match is
  // word-bounded so that an ordinary identifier CONTAINING a banned word (for example
  // "inaccessible" around "access") cannot fail this oracle spuriously.
  for (const token of FORBIDDEN_RUNTIME_TOKENS) {
    assert.equal(new RegExp("\\b" + token + "\\b").test(writeCas.code), false,
      "W9: write-cas.cjs must not contain " + token + " (code, not comments)");
  }
  assert.equal(/\bfs\s*\./.test(writeCas.code), false,
    "W9: the runtime leaf binds no fs namespace - there is no fs.<member> call site anywhere, and "
    + "the one gated W7x require below is consumed inline rather than bound to a name");

  // R2-6 (b): it requires neither node:fs nor node:path, and only builtins plus the pinned binding.
  const allowedSpecifier = specifier =>
    specifier === "better-sqlite3"
    || builtinModules.includes(specifier)
    || (specifier.startsWith("node:") && builtinModules.includes(specifier.slice(5)));
  const disallowed = writeCas.requires.filter(specifier => !allowedSpecifier(specifier));
  assert.deepEqual(disallowed, [],
    "W9: the runtime leaf may require only node builtins and better-sqlite3");
  // R2-6 (b), restated at the strength it actually holds now that the W7x hold seam exists.
  //
  // The path module stays banned OUTRIGHT, and so does any unqualified "fs" specifier. The
  // filesystem module is banned AT THE TOP LEVEL, which is the property R2-6 (b) was protecting:
  // with the seam unset that require is never evaluated, so the module's LOADED dependency surface
  // is the pinned native binding alone. The weaker source-level property is asserted as the weaker
  // property it is, and is then FENCED - the single permitted occurrence must lie inside
  // holdIfRequested, behind its gate - rather than being dropped.
  for (const banned of ["fs", "path", "node:path"]) {
    assert.equal(writeCas.requires.includes(banned), false,
      "W9: R2-6 (b) - the runtime leaf requires no path module and no unqualified fs (" + banned + ")");
  }

  // The GATED-SEAM FENCE. The W7 compound contract adds two further gated seams to the runtime
  // leaf - the self-kill marker and the ordinary-exit control - so the previous literal shape
  // assertion ("the single node:fs require lies inside holdIfRequested") no longer describes the
  // approved source. It is REPLACED by a stronger fence, never deleted and never weakened, and
  // every substantive invariant it protected is still asserted:
  //   - the ONLY top-level require is the pinned native binding, so the LOADED dependency surface
  //     with no seam set is unchanged;
  //   - no path module, no unqualified fs specifier, no relative require, no fixture import;
  //   - EXACTLY ONE node:fs require in the whole leaf, and it lies inside the ONE emitter;
  //   - every emitter call site lies inside one of the three gated seam functions, and in each of
  //     them the environment gate textually PRECEDES the emit it guards;
  //   - the leaf registers NO listener, so the unseamed runtime gains no side effect;
  //   - exactly one process.kill and exactly one process.exit, each fenced to its own seam, and no
  //     reallyExit or abort path anywhere.
  //
  // The fence is a PURE predicate returning a closed violation vocabulary, so the negative
  // controls below can prove it rejects the shapes it claims to reject rather than being assumed.
  const writeCasViolations = w9GatedEmitterViolations(writeCas);
  assert.deepEqual(writeCasViolations, [],
    "W9: the runtime leaf must satisfy the gated-seam fence ("
    + JSON.stringify(writeCasViolations) + ")");

  // NEGATIVE CONTROLS for the new allowed shape. Each writes ONE synthetic source into a root this
  // suite owns - a declared fixture write, exactly as states.cjs is - scans it with the same
  // scanner and runs the same predicate, so a green fence means the predicate DISCRIMINATES rather
  // than that it accepts everything. A POSITIVE control opens the set.
  const fenceRoot = ownedParent("w9-fence");
  let fenceSampleIndex = 0;
  function fenceSample(body) {
    fenceSampleIndex += 1;
    const file = path.join(fenceRoot, "fence-" + fenceSampleIndex + ".cjs");
    fs.writeFileSync(file, body);
    return w9GatedEmitterViolations(scanSource(file));
  }
  // The minimal source shape the fence declares legal, authored HERE rather than copied from the
  // leaf under test, so the positive control cannot pass by agreeing with that leaf.
  const LEGAL_FENCE_SAMPLE = [
    '"use strict";',
    'const Database = require("better-sqlite3");',
    'function emitSeamLine(kind, point, nonce) {',
    '  require("node:fs").writeSync(1, kind + point + nonce);',
    '}',
    'function crashIfRequested(point) {',
    '  if (process.env.P4_CRASH_AT !== point) return;',
    '  emitSeamLine("c", point, "n");',
    '  process.kill(process.pid, "SIGKILL");',
    '}',
    'function exitControlIfRequested(point) {',
    '  if (process.env.P4_EXIT_AT !== point) return;',
    '  emitSeamLine("e", point, "n");',
    '  process.exit(1);',
    '}',
    'function holdIfRequested(point) {',
    '  if (process.env.P4_HOLD_AT !== point) return;',
    '  emitSeamLine("h", point, "n");',
    '}',
    // A trailing non-seam declaration, deliberately present: a seam function's span runs to the
    // next column-zero declaration, so a seam left LAST would swallow everything after it and the
    // out-of-fence controls below would silently measure nothing. The real leaf already has
    // declarations after its last seam; the samples must too, or F2 and F5 would be vacuous.
    'function tail() {',
    '  return 1;',
    '}',
    'module.exports = { Database, crashIfRequested, exitControlIfRequested, holdIfRequested, tail };',
    '',
  ].join("\n");
  const fenceControls = [];
  function runFenceControl(id, description, body, expected) {
    const violations = w9SortedViolations(fenceSample(body));
    assert.deepEqual(violations, w9SortedViolations(expected),
      "W9/" + id + ": the fence must report exactly these violations - " + description);
    fenceControls.push({ id, description, violations, mustReject: expected.length > 0 });
  }
  runFenceControl("F0", "the declared legal shape is ACCEPTED, which is what stops every refusal "
    + "below from being satisfied by a predicate that rejects everything", LEGAL_FENCE_SAMPLE, []);
  runFenceControl("F1", "a top-level node:fs require is rejected",
    LEGAL_FENCE_SAMPLE.replace(
      'const Database = require("better-sqlite3");',
      'const Database = require("better-sqlite3");\nconst nodeFs = require("node:fs");',
    ),
    ["top_level_require_not_only_pinned_binding", "node_fs_require_not_exactly_one"]);
  runFenceControl("F2", "an emitter call outside every gated seam is rejected",
    LEGAL_FENCE_SAMPLE.replace(
      'module.exports =',
      'function unfenced() {\n  emitSeamLine("x", "after_open", "n");\n}\nmodule.exports =',
    ),
    ["emitter_called_outside_gated_seam"]);
  runFenceControl("F3", "an emit that precedes its own environment gate is rejected",
    LEGAL_FENCE_SAMPLE.replace(
      '  if (process.env.P4_HOLD_AT !== point) return;\n  emitSeamLine("h", point, "n");',
      '  emitSeamLine("h", point, "n");\n  if (process.env.P4_HOLD_AT !== point) return;',
    ),
    ["gate_does_not_precede_emit:holdIfRequested"]);
  runFenceControl("F4", "a second, unfenced process.exit is rejected",
    LEGAL_FENCE_SAMPLE.replace(
      'module.exports =',
      'function bail() {\n  process.exit(2);\n}\nmodule.exports =',
    ),
    ["process_exit_not_exactly_one_in_its_seam"]);
  runFenceControl("F5", "a listener registration in the runtime leaf is rejected",
    LEGAL_FENCE_SAMPLE.replace(
      'module.exports =',
      'process.on("exit", function () { emitSeamLine("z", "after_open", "n"); });\n'
      + 'module.exports =',
    ),
    ["listener_registered_in_runtime_leaf", "emitter_called_outside_gated_seam"]);
  runFenceControl("F6", "an alternative exit path is rejected",
    LEGAL_FENCE_SAMPLE.replace('  process.exit(1);', '  process.reallyExit(1);'),
    ["alternative_exit_path:reallyExit", "process_exit_not_exactly_one_in_its_seam"]);
  runFenceControl("F7", "a relative require is rejected",
    LEGAL_FENCE_SAMPLE.replace(
      'const Database = require("better-sqlite3");',
      'const Database = require("better-sqlite3");\nconst states = require("./states.cjs");',
    ),
    ["top_level_require_not_only_pinned_binding", "relative_require_present"]);
  runFenceControl("F8", "a path-module require is rejected",
    LEGAL_FENCE_SAMPLE.replace(
      'const Database = require("better-sqlite3");',
      'const Database = require("better-sqlite3");\nconst nodePath = require("node:path");',
    ),
    ["top_level_require_not_only_pinned_binding", "banned_require:node:path"]);
  assert.equal(fenceControls.length, 9,
    "W9: every declared fence control must have run - F0 plus F1-F8");
  assert.deepEqual(fenceControls.filter(entry => entry.mustReject
    && entry.violations.length === 0).map(entry => entry.id), [],
    "W9: every rejecting fence control must actually have rejected something");

  // The CHILD leaf's own gated binding, fenced at the same strength. The exit witness is the one
  // listener write-child.cjs may register, it must be GATED, and it must scan nothing.
  const writeChildFsSites = writeChild.requires.filter(specifier => specifier === "node:fs");
  assert.equal(writeChildFsSites.length, 1,
    "W9: write-child.cjs contains EXACTLY ONE node:fs require - the gated exit witness, no other");
  const witnessGateAt = writeChild.code.indexOf("process.env.P4_WITNESS_AT");
  assert.notEqual(witnessGateAt, -1, "W9: the child's exit witness must gate on P4_WITNESS_AT");
  const witnessListenerAt = writeChild.code.indexOf("process.on(");
  assert.notEqual(witnessListenerAt, -1, "W9: the exit witness listener must be present");
  assert.equal(witnessGateAt < witnessListenerAt, true,
    "W9: the P4_WITNESS_AT gate must textually precede the listener it guards, so with the gate "
    + "unset NO listener is registered and the unseamed child's runtime gains no side effect");
  assert.equal(countOccurrences(writeChild.code, "process.on("), 2,
    "W9: write-child.cjs registers exactly two listeners - the gated exit witness and the IPC "
    + "message handler the fork protocol requires - and nothing else");
  assert.equal(/\bprocess\s*\.\s*exit\b/.test(writeChild.code), false,
    "W9: write-child.cjs calls process.exit on NO path - it disconnects and exits by itself");
  assert.equal(/\bprocess\s*\.\s*kill\b/.test(writeChild.code), false,
    "W9: write-child.cjs signals nothing and looks at no other process - there is no global scan "
    + "and no process enumeration anywhere in it");
  assert.equal(countOccurrences(writeChild.code, "new Database("), 0,
    "W9: write-child.cjs constructs no handle of its own");

  // Exactly one handle construction and exactly one BEGIN IMMEDIATE.
  assert.equal(countOccurrences(writeCas.code, "new Database("), 1,
    "W9: exactly one Database construction, and no default-constructor Database");
  const sql = sqlLiterals(writeCas);
  const beginStatements = sql.filter(literal => /BEGIN\s+IMMEDIATE/i.test(literal));
  assert.equal(beginStatements.length, 1, "W9: exactly one BEGIN IMMEDIATE");
  assert.equal(sql.filter(literal => /\bBEGIN\b/i.test(literal)).length, 1,
    "W9: the only BEGIN is the IMMEDIATE one");

  // No upsert of any spelling, no PRAGMA, no busy_timeout: a replay can never overwrite.
  for (const banned of [/\bREPLACE\b/i, /INSERT\s+OR\b/i, /ON\s+CONFLICT/i, /\bUPSERT\b/i,
    /DO\s+UPDATE/i, /\bEXCLUDED\b/i, /\bPRAGMA\b/i, /busy_timeout/i, /\bDELETE\b/i, /\bDROP\b/i,
    /\bALTER\b/i, /\bVACUUM\b/i]) {
    assert.deepEqual(sql.filter(literal => banned.test(literal)), [],
      "W9: the runtime leaf contains no SQL matching " + String(banned));
  }
  assert.equal(/busy_timeout/i.test(writeCas.code), false, "W9: no busy_timeout anywhere");
  assert.equal(/\bPRAGMA\b/i.test(writeCas.code), false, "W9: no PRAGMA anywhere");

  // R2-5: no double-quoted token inside any SQL string; exactly one INSERT INTO; exactly one
  // UPDATE store_meta; every key comparison and every VALUES clause bound.
  for (const literal of sql) {
    assert.equal(literal.includes("\""), false,
      "W9: no double-quoted token inside a SQL string (double quotes are IDENTIFIER quoting in "
      + "SQLite, and the string fallback is the legacy misfeature) - offending: " + literal);
  }
  const inserts = sql.filter(literal => /INSERT\s+INTO/i.test(literal));
  assert.equal(inserts.length, 1, "W9: exactly one INSERT INTO");
  assert.match(inserts[0],
    /INSERT\s+INTO\s+(\$\{[A-Za-z_$][\w$]*\}|[A-Za-z_][\w]*)\s*\(\s*key\s*,\s*value\s*\)\s*VALUES\s*\(\s*\?\s*,\s*\?\s*\)/i,
    "W9: the INSERT is plain, two-column and fully bound");
  const updates = sql.filter(literal => /\bUPDATE\b/i.test(literal));
  assert.equal(updates.length, 1, "W9: exactly one UPDATE statement");
  assert.match(updates[0],
    /UPDATE\s+(\$\{[A-Za-z_$][\w$]*\}|store_meta)\s+SET\s+value\s*=\s*\?\s+WHERE\s+key\s*=\s*\?/i,
    "W9: the generation bump is UPDATE store_meta SET value = ? WHERE key = ?, key BOUND");
  for (const literal of sql) {
    if (/WHERE/i.test(literal)) {
      assert.equal(/WHERE\s+key\s*=\s*\?/i.test(literal) || !/\bkey\b/i.test(literal.split(/WHERE/i)[1]), true,
        "W9: every key comparison uses a bound parameter - offending: " + literal);
    }
    if (/VALUES/i.test(literal)) {
      assert.match(literal, /VALUES\s*\(\s*\?(\s*,\s*\?)*\s*\)/i,
        "W9: every VALUES clause uses bound parameters only - offending: " + literal);
    }
  }

  // The declared scanner limitation, closed by measurement rather than assumed away.
  assert.equal(/\/[^\n/*][^\n]*['"`][^\n]*\//.test(writeCas.code), false,
    "W9: the runtime leaf contains no regular-expression literal carrying a quote character, so "
    + "the scanner's declared limitation cannot apply to it");

  // R2-6 (b) source order: the WHOLE precondition block textually precedes the single open.
  const openAt = writeCas.code.indexOf("new Database(");
  assert.notEqual(openAt, -1, "W9: the single Database construction must be present");
  for (const token of ["Number.isSafeInteger", "JSON.stringify"]) {
    const last = writeCas.code.lastIndexOf(token);
    assert.notEqual(last, -1, "W9: the precondition block must contain " + token);
    assert.equal(last < openAt, true,
      "W9: every occurrence of " + token + " must textually precede the single new Database(...)");
  }

  // states.cjs and the observer are UNREACHABLE from the runtime leaves.
  const fromWriteCas = relativeClosure(WRITE_CAS_SOURCE);
  const fromWriteChild = relativeClosure(WRITE_CHILD_SOURCE);
  for (const [entry, closure] of [["write-cas.cjs", fromWriteCas], ["write-child.cjs", fromWriteChild]]) {
    assert.equal(closure.includes(path.basename(STATES_SOURCE)), false,
      "W9: states.cjs must be unreachable from " + entry);
    assert.equal(closure.includes(path.basename(RECOVERY_OBSERVE_SOURCE)), false,
      "W9: the tester-lane recovery observer must never be required by " + entry);
    assert.equal(closure.includes(path.basename(P2_OPENER_COPY)), false,
      "W9: the independent verifier must never be required by " + entry);
    // W6-R, asserted here rather than scoped out of this oracle: the lock-holding peer is a TESTER
    // instrument, so the slice and its child must not be able to reach it in either direction.
    assert.equal(closure.includes(path.basename(LOCK_HOLD_CHILD_SOURCE)), false,
      "W9: the W6-R lock-holding peer must be unreachable from " + entry);
  }
  assert.deepEqual(fromWriteChild, ["write-cas.cjs"],
    "W9: write-child.cjs requires the slice and nothing else relative");

  // --- W6-R: the lock-holding peer's REACHABILITY and its READ-ONLY statement vocabulary ---------
  //
  // The peer is additive TESTER instrumentation, so W9 is EXTENDED to cover it at the same strength
  // it covers the runtime leaves rather than being scoped around it. Three properties are asserted
  // from this SOURCE: it reaches nothing, it modifies nothing, and it terminates nothing.
  const fromLockHoldPeer = relativeClosure(LOCK_HOLD_CHILD_SOURCE);
  assert.deepEqual(fromLockHoldPeer, [],
    "W9: the W6-R peer reaches NO relative module - not the slice, not write-child.cjs, not "
    + "states.cjs, not the recovery observer and not the independent P2 opener, so it can never "
    + "create, adopt, repair or verify a store");
  assert.deepEqual(lockHoldPeer.requires, ["better-sqlite3"],
    "W9: the W6-R peer's ONLY require is the pinned native binding");
  assert.equal(lockHoldPeer.code.includes("applyExperimentalStoreMutation"), false,
    "W9: the W6-R peer never calls the mutation API - it is a lock holder, never a writer");
  // No filesystem surface at all, exactly as the runtime leaf is held to.
  for (const token of FORBIDDEN_RUNTIME_TOKENS) {
    assert.equal(new RegExp("\\b" + token + "\\b").test(lockHoldPeer.code), false,
      "W9: the W6-R peer must not contain " + token + " (code, not comments)");
  }
  assert.equal(/\bfs\s*\./.test(lockHoldPeer.code), false,
    "W9: the W6-R peer binds no fs namespace and has no fs call site anywhere");
  // It terminates nothing and signals nothing: the parent releases it over IPC and joins it, which
  // is what keeps this case inside the existing run-wide signal accounting.
  assert.equal(/\bprocess\s*\.\s*exit\b/.test(lockHoldPeer.code), false,
    "W9: the W6-R peer calls process.exit on NO path - it disconnects and exits by itself");
  assert.equal(/\bprocess\s*\.\s*kill\b/.test(lockHoldPeer.code), false,
    "W9: the W6-R peer signals nothing and looks at no other process");
  // Exactly one handle, and READ-ONLY statements only: the peer's whole statement vocabulary is a
  // CLOSED, ENUMERATED set, so "it modifies nothing" is measured from source rather than asserted as
  // a claim. No data statement, no PRAGMA, no busy_timeout and no COMMIT of any kind appears - the
  // transaction is always discarded, so not even an empty commit can be attributed to this peer.
  assert.equal(countOccurrences(lockHoldPeer.code, "new Database("), 1,
    "W9: the W6-R peer constructs exactly one handle, and no default-constructor Database");
  const peerSql = sqlLiterals(lockHoldPeer);
  const W6R_PEER_STATEMENTS = [
    "BEGIN DEFERRED",
    "BEGIN IMMEDIATE",
    "ROLLBACK",
    "SELECT key FROM store_meta ORDER BY key LIMIT 1",
  ];
  assert.deepEqual([...peerSql].sort(), [...W6R_PEER_STATEMENTS].sort(),
    "W9: the W6-R peer's statement vocabulary is exactly the closed read/lock set - one deferred "
    + "start, one immediate start, one keyed metadata read and one discard, each appearing once");
  for (const banned of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bREPLACE\b/i, /\bDROP\b/i,
    /\bALTER\b/i, /\bVACUUM\b/i, /\bPRAGMA\b/i, /\bCOMMIT\b/i, /\bCREATE\b/i, /\bATTACH\b/i]) {
    assert.deepEqual(peerSql.filter(literal => banned.test(literal)), [],
      "W9: the W6-R peer contains no SQL matching " + String(banned));
  }
  // READ THESE TWO AGAINST `.code`, NOT AGAINST THE RAW FILE. scanSource strips comments and
  // replaces every string body before any code assertion runs, so `.code` is the peer's EXECUTABLE
  // text. The peer's header prose does discuss busy_timeout and PRAGMA by name - it has to, to state
  // why neither is used - and a reviewer grepping the raw file will get those hits. They are COMMENT
  // TOKENS, they are not code, and they are not violations of these assertions, which pass exactly
  // as written. Nothing here is scoped around that fact: these checks are correct and are kept. Do
  // NOT weaken or delete either one to make a raw-file grep quieter; the assertion messages say
  // "anywhere in the W6-R peer" and mean anywhere in the peer's CODE.
  assert.equal(/\bPRAGMA\b/i.test(lockHoldPeer.code), false, "W9: no PRAGMA anywhere in the W6-R peer");
  assert.equal(/busy_timeout/i.test(lockHoldPeer.code), false,
    "W9: no busy_timeout anywhere in the W6-R peer - contention is MEASURED, never waited out");
  for (const literal of peerSql) {
    assert.equal(literal.includes("\""), false,
      "W9: no double-quoted token inside a W6-R peer SQL string - offending: " + literal);
  }
  // The declared scanner limitation, closed by measurement for this leaf too.
  assert.equal(/\/[^\n/*][^\n]*['"`][^\n]*\//.test(lockHoldPeer.code), false,
    "W9: the W6-R peer contains no regular-expression literal carrying a quote character, so the "
    + "scanner's declared limitation cannot apply to it");

  // The observer itself: open + close only, asserted here per R2-2.
  assert.equal(countOccurrences(observer.code, "new Database("), 1,
    "W9: the observer constructs exactly one handle");
  assert.deepEqual(sqlLiterals(observer), [],
    "W9: the observer issues NO statement of any kind - no SELECT, no PRAGMA, no transaction");
  assert.deepEqual(observer.requires.filter(specifier => specifier.startsWith(".")), [],
    "W9: the observer requires no slice file and no fixture");
  assert.equal(observer.code.includes("applyExperimentalStoreMutation"), false,
    "W9: the observer never calls the mutation API");

  evidence.cases.W9 = {
    scope: "the RUNTIME leaf. states.cjs and the evidence emitter DO write, by design, as declared "
      + "fixture and evidence writers confined to their own owned roots, so this oracle claims no "
      + "single writer overall.",
    writeCas: {
      requires: writeCas.requires,
      databaseConstructions: countOccurrences(writeCas.code, "new Database("),
      sqlStatements: sql,
      beginImmediateCount: beginStatements.length,
      insertCount: inserts.length,
      updateCount: updates.length,
      preconditionPrecedesOpenAt: openAt,
      gatedSeamFenceViolations: writeCasViolations,
    },
    // The REPLACED shape assertion, recorded as the replacement it is rather than as a deletion.
    gatedSeamFence: {
      emitter: W9_EMITTER_FUNCTION,
      seamGates: W9_SEAM_GATES,
      fencedTerminators: W9_FENCED_TERMINATORS.map(entry => ({ token: entry.token, fn: entry.fn })),
      violations: writeCasViolations,
      controls: fenceControls,
      replacedAssertion: "the prior literal assertion was 'the single node:fs require lies inside "
        + "holdIfRequested'. The W7 compound contract adds two further gated seams, so that literal "
        + "no longer describes the approved source. It is REPLACED by this fence - one emitter, one "
        + "node:fs require inside it, every emitter call site inside a gated seam, every gate "
        + "textually preceding its emit, no listener, and each terminator fenced to its own seam - "
        + "and the new allowed shape is proven by the F0-F8 negative controls rather than asserted.",
      inferenceScope: "the terminator and alternative-exit-path checks are SOURCE properties. "
        + "Excluding process.reallyExit, a native fault or an external agent from the W7 "
        + "attribution is an INFERENCE from this source identity, never kernel attestation and "
        + "never cryptographic attestation of what executed.",
    },
    writeChild: {
      requires: writeChild.requires,
      nodeFsRequires: writeChildFsSites.length,
      listeners: countOccurrences(writeChild.code, "process.on("),
      exitWitnessGatedOn: "P4_WITNESS_AT",
      gatePrecedesListener: witnessGateAt < witnessListenerAt,
      role: "W6 child entrypoint plus the ONE gated exit witness W7 requires. With the gate unset "
        + "no listener is registered, no module is loaded and nothing is written.",
    },
    writeChildRelativeClosure: fromWriteChild,
    writeCasRelativeClosure: fromWriteCas,
    observer: { requires: observer.requires, statements: sqlLiterals(observer) },
    // W6-R, additive: the lock-holding peer measured at the same strength as the runtime leaves.
    lockHoldPeer: {
      requires: lockHoldPeer.requires,
      relativeClosure: fromLockHoldPeer,
      reachableFromWriteCas: fromWriteCas.includes(path.basename(LOCK_HOLD_CHILD_SOURCE)),
      reachableFromWriteChild: fromWriteChild.includes(path.basename(LOCK_HOLD_CHILD_SOURCE)),
      databaseConstructions: countOccurrences(lockHoldPeer.code, "new Database("),
      statements: peerSql,
      statementVocabularyClosedTo: W6R_PEER_STATEMENTS,
      role: "TESTER-LANE lock holder for W6-R. Read/lock only: no data statement, no PRAGMA, no "
        + "busy_timeout, no COMMIT of any kind, exactly one handle, and no process.exit or signal on "
        + "any path - the parent releases it over IPC and joins it.",
      scopeNote: "asserted, not scoped around. This oracle claims nothing about the peer beyond "
        + "these SOURCE properties; whether the lock it holds behaves as the documentation says is "
        + "what W6-R MEASURES, not what W9 asserts.",
    },
    scannerLimitation: "comments are removed and string bodies replaced before any code assertion; "
      + "a regex literal carrying a quote character would be mis-scanned, and the runtime leaf is "
      + "asserted above to contain none",
  };
  maybeForceFail("W9");
});

// --- W10: retrySafe is phase-aware, and established commit facts are never overwritten ----------

test("W10 phase-aware retrySafe and non-overwritable commit facts", () => {
  const arms = [];

  // W10a - exactly the case the v1 wording described wrongly.
  {
    const store = newStore("w10a");
    const result = seamedCall({ P4_FAIL_AT: "after_row_insert" }, store.storeRoot, callOptions());
    expectRefusal("W10", "a:after_row_insert-clean-cleanup", result, {
      reason: REASON_TRANSACTION_FAILED, commitAttempted: false, committed: false, retrySafe: true,
    }, { synthetic: true });
    const ledger = requireLedger(store.dbPath, "W10/a");
    assert.equal(ledger.generation, 1, "W10/a: the opener reports generation g");
    assert.equal(totalSectionRows(ledger), 0, "W10/a: zero new rows");
    arms.push({ arm: "a", synthetic: true, result, generationAfter: ledger.generation,
      rowsAfter: totalSectionRows(ledger),
      retrySafeBasis: "(a) COMMIT never issued, (b) the explicit ROLLBACK returned, (c) close "
        + "returned - all three established positively, not assumed" });
  }

  // W10b - the rollback fault forces retrySafe:false even though committed:false is established.
  {
    const store = newStore("w10b");
    const result = seamedCall({ P4_FAIL_AT: "after_row_insert", P4_ROLLBACK_FAULT: "1" },
      store.storeRoot, callOptions());
    expectRefusal("W10", "b:rollback-fault", result, {
      reason: REASON_ROLLBACK_FAILED, commitAttempted: false, committed: false, retrySafe: false,
    }, { synthetic: true });
    distinctCauses(result, "W10/b", { error: true, rollback: true, close: false });
    const ledger = requireLedger(store.dbPath, "W10/b");
    assert.equal(ledger.generation, 1, "W10/b: the opener reports generation g");
    assert.equal(totalSectionRows(ledger), 0, "W10/b: zero new rows");
    arms.push({ arm: "b", synthetic: true, result, generationAfter: ledger.generation,
      rowsAfter: totalSectionRows(ledger),
      independenceClaim: "committed:false is still established, yet (b) is uncertain, so retrySafe "
        + "is false - committed and retrySafe are asserted INDEPENDENTLY" });
  }

  // W10c - a COMMIT throw DOMINATES classification, whatever err.code reports.
  {
    const store = newStore("w10c");
    const result = seamedCall({ P4_COMMIT_FAULT: "busy" }, store.storeRoot, callOptions());
    expectRefusal("W10", "c:commit-fault-busy", result, {
      reason: REASON_COMMIT_UNCERTAIN, commitAttempted: true, committed: null, retrySafe: false,
    }, { synthetic: true });
    assert.notEqual(result.reason, REASON_BUSY,
      "W10/c: a commit-phase BUSY is NEVER experimental_store_busy - the section 3 busy row covers "
      + "BEGIN IMMEDIATE and pre-COMMIT statements only");
    assert.notEqual(result.ok, true, "W10/c: uncertainty is not success");
    // The classifier still reports the code it was handed; the REASON is what refuses to collapse.
    const classified = result.error === undefined || result.error === null
      ? null : classifyWriteFailure(result.error);
    const ledger = requireLedger(store.dbPath, "W10/c");
    arms.push({ arm: "c", synthetic: true, result,
      classifierVerdict: classified,
      generationObservedAfter: ledger.generation,
      rowsObservedAfter: totalSectionRows(ledger),
      uncertaintyClaim: "the observed generation is RECORDED, never asserted: commitAttempted:true "
        + "/ committed:null / retrySafe:false is the contract outcome, and the write is reported "
        + "as neither a success nor a failure",
      syntheticNote: "a SYNTHETIC throw at COMMIT carrying a BUSY code. No runner produced a "
        + "native commit-phase BUSY, so that remains UNMEASURED." });
  }

  // W10d - a post-success close failure PRESERVES the commit.
  {
    const store = newStore("w10d");
    const result = seamedCall({ P4_CLOSE_FAULT: "1" }, store.storeRoot, callOptions());
    expectRefusal("W10", "d:post-commit-close-fault", result, {
      reason: REASON_CLOSE_FAILED, commitAttempted: true, committed: true, retrySafe: false,
    }, { synthetic: true });
    assert.notEqual(result.committed, false,
      "W10/d: committed:true is NEVER downgraded to false by a later cleanup failure");
    assert.notEqual(result.committed, null,
      "W10/d: committed:true is NEVER downgraded to null by a later cleanup failure");
    const ledger = requireLedger(store.dbPath, "W10/d");
    assert.equal(ledger.generation, 2, "W10/d: the store holds the committed state at g + 1");
    assert.deepEqual(sectionKeys(ledger, TARGET_SECTION), ["binding-alpha"],
      "W10/d: the committed row is present exactly once");
    arms.push({ arm: "d", synthetic: true, result, generationAfter: ledger.generation,
      rowsAfter: totalSectionRows(ledger) });
  }

  // The commit fault COMBINED with rollback and close faults: the COMMIT throw still dominates and
  // every cause is retained separately.
  const combinations = [
    { arm: "f:commit-fault-plus-rollback-fault",
      seams: { P4_COMMIT_FAULT: "busy", P4_ROLLBACK_FAULT: "1" },
      causes: { error: true, rollback: true, close: false } },
    { arm: "g:commit-fault-plus-close-fault",
      seams: { P4_COMMIT_FAULT: "busy", P4_CLOSE_FAULT: "1" },
      causes: { error: true, rollback: false, close: true } },
    { arm: "h:commit-fault-plus-rollback-and-close-fault",
      seams: { P4_COMMIT_FAULT: "busy", P4_ROLLBACK_FAULT: "1", P4_CLOSE_FAULT: "1" },
      causes: { error: true, rollback: true, close: true } },
  ];
  for (const spec of combinations) {
    const store = newStore("w10-" + spec.arm.slice(0, 1));
    const result = seamedCall(spec.seams, store.storeRoot, callOptions());
    expectRefusal("W10", spec.arm, result, {
      reason: REASON_COMMIT_UNCERTAIN, commitAttempted: true, committed: null, retrySafe: false,
    }, { synthetic: true });
    distinctCauses(result, "W10/" + spec.arm, spec.causes);
    assert.notEqual(result.reason, REASON_ROLLBACK_FAILED,
      "W10/" + spec.arm + ": COMMIT uncertainty outranks a cleanup reason - it is never replaced");
    assert.notEqual(result.reason, REASON_CLOSE_FAILED,
      "W10/" + spec.arm + ": COMMIT uncertainty outranks a cleanup reason - it is never replaced");
    const ledger = requireLedger(store.dbPath, "W10/" + spec.arm);
    arms.push({ arm: spec.arm, synthetic: true, seams: spec.seams, result,
      generationObservedAfter: ledger.generation,
      rowsObservedAfter: totalSectionRows(ledger),
      uncertaintyClaim: "commitAttempted:true / committed:null / retrySafe:false is retained even "
        + "though rollback and/or close also failed; the original cause and both cleanup causes are "
        + "kept in error, cleanupError.rollback and cleanupError.close separately" });
  }

  // W10e - the negative oracle, applied to EVERY refusal this suite has recorded so far rather than
  // to one hand-picked arm. assertRetrySafeIsWellFormed already enforced (a)(b)(c) at each call
  // site; this re-checks the recorded evidence, and checks that no established commit fact moved.
  const violations = [];
  for (const row of evidence.errorVocabulary) {
    if (row.retrySafe === true && !(row.commitAttempted === false && row.committed === false)) {
      violations.push({ row, rule: "W10e (a): retrySafe:true requires established non-commit" });
    }
    if (row.reason === REASON_COMMIT_UNCERTAIN
      && !(row.commitAttempted === true && row.committed === null && row.retrySafe === false)) {
      violations.push({ row, rule: "W10e: commit uncertainty is (true, null, false), always" });
    }
    if (row.reason === REASON_CLOSE_FAILED && row.commitAttempted === true && row.committed !== true) {
      violations.push({ row, rule: "W10e: an established committed:true is never changed later" });
    }
  }
  assert.deepEqual(violations, [],
    "W10e: any retrySafe:true not evidencing (a), (b) and (c), and any committed value changed "
    + "after it was established, is a HARD FAILURE");

  evidence.cases.W10 = {
    arms,
    refusalsChecked: evidence.errorVocabulary.length,
    negativeOracleViolations: violations,
    retrySafeRule: "retrySafe:true only when (a) COMMIT never issued, (b) the transaction is KNOWN "
      + "ended, and (c) cleanup is settled - each established positively. Any uncertainty in (b) or "
      + "(c) forces retrySafe:false even though committed:false is still established.",
    independence: "committed and retrySafe are independent and are asserted independently",
  };
  maybeForceFail("W10");
});

// --- W11: the preflight validates the WHOLE P2 ledger shape, in-transaction, before the INSERT ---

// The generation is read back with a tester-lane DIRECT fixture read for the arms whose fixture the
// independent verifier refuses BY CONSTRUCTION (a dropped table, a renamed column). This is a
// declared tester observation, never the verifier, and it is labelled as such in the evidence.
function readGenerationTextDirect(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM " + STORE_META_TABLE + " WHERE key = ?").get("generation");
    return row === undefined ? null : row.value;
  } finally {
    db.close();
  }
}

test("W11 preflight completeness: every section is validated before any INSERT", () => {
  const arms = [];

  for (const section of SECTION_TABLES) {
    // (a) the table dropped, and (b) its value column renamed. The mutation still targets the
    // ordinary target section, so a missing or malformed NON-target table must still refuse.
    const fixtures = [
      { arm: section + ":a:table-dropped", statements: ["DROP TABLE " + section], target: TARGET_SECTION },
      {
        arm: section + ":b:value-column-renamed",
        statements: ["ALTER TABLE " + section + " RENAME COLUMN value TO payload"],
        target: TARGET_SECTION,
      },
    ];
    // (c) a non-JSON row value planted in a section OTHER than the mutation target: the mutation is
    // retargeted to a different section so that every one of the four sections is covered by (c)
    // without any arm being skipped.
    const otherTarget = SECTION_TABLES.find(table => table !== section);
    fixtures.push({
      arm: section + ":c:non-json-row-value-outside-target",
      statements: ["INSERT INTO " + section + " (key, value) VALUES ('planted', 'not-json')"],
      target: otherTarget,
    });

    for (const fixture of fixtures) {
      const store = newStore("w11-" + section + "-" + fixture.arm.split(":")[1]);
      mutateFixture(store.dbPath, fixture.statements);
      const generationBefore = readGenerationTextDirect(store.dbPath);

      const result = cleanCall(store.storeRoot, callOptions({
        mutation: mutationOf("binding-preflight", { section, arm: fixture.arm }, fixture.target),
      }));
      expectRefusal("W11", fixture.arm, result, {
        reason: REASON_UNAVAILABLE, commitAttempted: false, committed: false, retrySafe: true,
      });
      assert.equal(result.detail, DETAIL_INVALID_STORE_SHAPE,
        "W11/" + fixture.arm + ": the R2-3 detail is exactly invalid_store_shape");

      // The INDEPENDENT verifier refuses the identical fixture: the slice must never write into a
      // store its own verifier would reject.
      const openerVerdict = openLedger(store.dbPath);
      assert.equal(openerVerdict.ok, false,
        "W11/" + fixture.arm + ": the independent P2 opener must refuse the identical fixture");
      assert.equal(openerVerdict.detail, DETAIL_INVALID_STORE_SHAPE,
        "W11/" + fixture.arm + ": the opener names the same shape detail independently");

      const generationAfter = readGenerationTextDirect(store.dbPath);
      assert.equal(generationAfter, generationBefore,
        "W11/" + fixture.arm + ": the generation is unchanged - the refusal precedes any INSERT");
      assert.equal(generationAfter, "1", "W11/" + fixture.arm + ": the generation text is still 1");

      arms.push({
        arm: fixture.arm,
        section,
        mutationTarget: fixture.target,
        fixtureStatements: fixture.statements,
        fixtureWriter: "tester-lane direct fixture mutation of an OWNED table, permitted by the "
          + "dispatch and scoped out of the W9 runtime-leaf oracle",
        result,
        openerReason: openerVerdict.reason,
        openerDetail: openerVerdict.detail,
        generationBefore,
        generationAfter,
        generationReadBy: "tester-lane direct read-only store_meta read - NOT the verifier, which "
          + "refuses this fixture by construction",
      });
    }
  }

  assert.equal(arms.length, SECTION_TABLES.length * 3,
    "W11: three arms for each of the four sections, none skipped");
  evidence.cases.W11 = {
    arms,
    orderClaim: "all preflight statements are issued on the ONE handle already holding the BEGIN "
      + "IMMEDIATE RESERVED lock: no pre-open probe, no second connection, no separate race window",
    declaredCost: "the preflight reads every section row inside the write transaction. Acceptable "
      + "for the fixture-sized stores this prototype measures; NO scaling, latency or lock-hold-time "
      + "claim is made and none may be inferred.",
    sectionsValidated: SECTION_TABLES,
  };
  maybeForceFail("W11");
});

// --- W12: key-exists is proven POSITIVELY by query, never by an invented extended code ----------

test("W12 key exists is established by query, and not every constraint failure is a duplicate", () => {
  // (a) a duplicate key in the TARGET section.
  const store = newStore("w12a");
  mutateFixture(store.dbPath, [
    "INSERT INTO " + TARGET_SECTION + " (key, value) VALUES ('binding-alpha', '{\"planted\":true}')",
  ]);
  const duplicate = cleanCall(store.storeRoot, callOptions());
  expectRefusal("W12", "a:duplicate-key-in-target-section", duplicate, {
    reason: REASON_KEY_EXISTS, commitAttempted: false, committed: false, retrySafe: false,
  });
  const ledgerA = requireLedger(store.dbPath, "W12/a");
  assert.equal(ledgerA.generation, 1, "W12/a: the generation is unchanged");
  assert.deepEqual(sectionKeys(ledgerA, TARGET_SECTION), ["binding-alpha"],
    "W12/a: EXACTLY one row remains - the planted one, unaltered");
  assert.deepEqual(ledgerA[TARGET_SECTION]["binding-alpha"], { planted: true },
    "W12/a: a plain INSERT can never overwrite the existing row - no REPLACE, no UPSERT");
  assert.equal(totalSectionRows(ledgerA), 1, "W12/a: exactly one row in the whole store");

  // (b) a SYNTHETIC primary constraint code classifies as constraint, and is NOT key-exists.
  const syntheticConstraint = Object.assign(new Error("synthetic constraint failure"),
    { code: "SQLITE_CONSTRAINT" });
  const syntheticVerdict = classifyWriteFailure(syntheticConstraint);
  assert.equal(syntheticVerdict.classification, "constraint",
    "W12/b: the primary SQLITE_CONSTRAINT classifies as constraint");
  assert.equal(syntheticVerdict.sqliteCode, "SQLITE_CONSTRAINT",
    "W12/b: the code is reported VERBATIM, never rewritten");

  // (b) continued - a NATIVE NOT NULL violation on an owned fixture table: a constraint failure
  // that is NOT a duplicate key. The fixture keeps (key, value) so the R2-3 preflight still passes.
  const notNull = newStore("w12b");
  mutateFixture(notNull.dbPath, [
    "DROP TABLE " + TARGET_SECTION,
    "CREATE TABLE " + TARGET_SECTION
      + " (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, required_note TEXT NOT NULL)",
  ]);
  const notNullResult = cleanCall(notNull.storeRoot, callOptions());
  expectRefusal("W12", "b:native-not-null-violation", notNullResult, {
    reason: REASON_TRANSACTION_FAILED, commitAttempted: false, committed: false, retrySafe: true,
  });
  assert.notEqual(notNullResult.reason, REASON_KEY_EXISTS,
    "W12/b: a NOT NULL violation is a constraint failure and is NOT experimental_store_key_exists");
  const notNullCode = codeOf(notNullResult.sqliteCode) !== null
    ? codeOf(notNullResult.sqliteCode)
    : (notNullResult.error === undefined || notNullResult.error === null
      ? null : codeOf(notNullResult.error.code));
  assert.notEqual(notNullCode, null, "W12/b: the native constraint code must be recorded");
  const notNullVerdict = notNullResult.error === undefined || notNullResult.error === null
    ? null : classifyWriteFailure(notNullResult.error);
  if (notNullVerdict !== null) {
    assert.equal(CLASSIFICATIONS.includes(notNullVerdict.classification), true,
      "W12/b: the classifier verdict belongs to the closed vocabulary");
    assert.equal(notNullVerdict.sqliteCode, notNullCode,
      "W12/b: the observed code is preserved VERBATIM by the classifier");
    if (isExtendedCode(notNullCode)) {
      // R2-5: the constraint classification is for the PRIMARY SQLITE_CONSTRAINT only, and an
      // unknown code is never rewritten into a known one. An extended code may be unclassified.
      assert.notEqual(notNullVerdict.classification, "constraint",
        "W12/b: an EXTENDED code is never rewritten into the primary constraint classification");
    }
  }

  // (c) E1 records the observed code verbatim for BOTH arms, with an explicit extended-code flag.
  const w12Rows = evidence.errorVocabulary.filter(row => row.caseId === "W12");
  assert.equal(w12Rows.length >= 2, true, "W12/c: both arms must be recorded in the E1 vocabulary");
  for (const row of w12Rows) {
    assert.equal(typeof row.extendedCodeObserved, "boolean",
      "W12/c: every row carries an explicit flag for whether an extended code was observed");
    assert.equal(typeof row.sqliteCodeObserved, "boolean",
      "W12/c: an absent code is a MEASURED UNKNOWN, recorded explicitly, never a failure");
  }

  evidence.cases.W12 = {
    duplicate: {
      result: duplicate,
      detectionMethod: "a bound SELECT 1 FROM <section> WHERE key = ? LIMIT 1 on the handle already "
        + "holding the BEGIN IMMEDIATE RESERVED lock - race-free without any pre-open probe or "
        + "second connection. No extended result code is asserted.",
      generationAfter: ledgerA.generation,
      rowsAfter: totalSectionRows(ledgerA),
      plantedRowPreserved: true,
    },
    syntheticConstraint: {
      input: { code: "SQLITE_CONSTRAINT" },
      verdict: syntheticVerdict,
      synthetic: true,
      note: "a SYNTHETIC error object, not a native runner observation",
    },
    nativeNotNull: {
      fixture: "the owned target table recreated with a third NOT NULL column and no default, so a "
        + "two-column INSERT violates NOT NULL rather than the primary key",
      result: notNullResult,
      sqliteCode: notNullCode,
      extendedCodeObserved: isExtendedCode(notNullCode),
      verdict: notNullVerdict,
      note: "not every constraint failure is a duplicate key; the code is recorded VERBATIM",
    },
    removedMapping: "the v1 SQLITE_CONSTRAINT_PRIMARYKEY mapping is REMOVED (R2-5): P2-CORRECTIONS "
      + "C1 records that no extended result code was captured on any runner",
  };
  maybeForceFail("W12");
});

// --- E1: the error vocabulary, informative either way -------------------------------------------

test("E1 error vocabulary: codes, errnos and classifier verdicts recorded per OS", () => {
  // Direct classifier probes. Only the two mappings the contract states are ASSERTED; the rest are
  // recorded as observations, because an asserted classification disagreeing with the observation
  // is a hard failure and P4 states no other mapping.
  const busyVerdict = classifyWriteFailure(Object.assign(new Error("synthetic busy"),
    { code: "SQLITE_BUSY" }));
  assert.equal(busyVerdict.classification, "busy", "E1: the primary SQLITE_BUSY classifies as busy");
  const constraintVerdict = classifyWriteFailure(Object.assign(new Error("synthetic constraint"),
    { code: "SQLITE_CONSTRAINT" }));
  assert.equal(constraintVerdict.classification, "constraint",
    "E1: the primary SQLITE_CONSTRAINT classifies as constraint");
  const nakedVerdict = classifyWriteFailure(new Error("synthetic error carrying no code"));
  assert.equal(nakedVerdict.classification, "unclassified",
    "E1: an error with no code is unclassified - an unknown classification never blocks a refusal");
  // R3-1, resolved: for the DIRECT classifyWriteFailure return a measured unknown is a PRESENT key
  // carrying null - never a silently omitted key (section 8: "an explicit unknown acceptable, a
  // silent omission not"; R2-5 W12(c): "an explicit flag for whether an extended code was
  // observed"). The SAME representation is required of sqliteCode and errno alike, and it is
  // asserted identically here and in the probe loop below - the v1 lane accepted an absent
  // sqliteCode while rejecting an absent errno, which is the inconsistency this resolves.
  //
  // Scope: this governs the CLASSIFIER RETURN ONLY. The mutation RESULT object keeps its
  // documented optional-key behaviour unchanged (section 3 marks detail?, sqliteCode?, errno?
  // optional), which is what the passing W0, W5 and W11 result-object arms depend on. codeOf()
  // normalisation therefore stays in use for RESULT fields and is not applied as a classifier gate.
  for (const key of ["sqliteCode", "errno", "classification"]) {
    assert.equal(Object.hasOwn(nakedVerdict, key), true,
      "E1: the classifier return must OWN " + key + " explicitly, never omit it silently");
  }
  assert.equal(nakedVerdict.sqliteCode, null,
    "E1: an unobserved sqliteCode is an explicit null on the classifier return, never invented "
    + "and never a silently absent key");
  assert.equal(nakedVerdict.errno, null,
    "E1: an unobserved errno is an explicit null on the classifier return - the SAME "
    + "representation required of sqliteCode, applied consistently");

  const probes = [];
  for (const spec of [
    { label: "SQLITE_BUSY", error: Object.assign(new Error("x"), { code: "SQLITE_BUSY" }), asserted: "busy" },
    { label: "SQLITE_CONSTRAINT", error: Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }), asserted: "constraint" },
    { label: "SQLITE_CANTOPEN", error: Object.assign(new Error("x"), { code: "SQLITE_CANTOPEN", errno: 14 }), asserted: null },
    { label: "SQLITE_NOTADB", error: Object.assign(new Error("x"), { code: "SQLITE_NOTADB", errno: 26 }), asserted: null },
    { label: "SQLITE_CONSTRAINT_NOTNULL", error: Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_NOTNULL" }), asserted: null },
    { label: "EACCES-with-syscall", error: Object.assign(new Error("x"), { code: "EACCES", errno: -13, syscall: "open" }), asserted: null },
  ]) {
    const verdict = classifyWriteFailure(spec.error);
    assert.deepEqual(Object.keys(verdict).sort(), ["classification", "errno", "sqliteCode"],
      "E1: classifyWriteFailure returns exactly { sqliteCode, errno, classification }");
    // R3-1 applied consistently: BOTH unknown-capable keys are present, each either an observed
    // value or an explicit null. Neither key may be silently omitted.
    assert.equal(verdict.sqliteCode === null || typeof verdict.sqliteCode === "string", true,
      "E1: " + spec.label + " - sqliteCode is an observed string or an explicit null");
    const expectedErrno = spec.error.errno === undefined ? null : spec.error.errno;
    assert.equal(verdict.errno, expectedErrno,
      "E1: " + spec.label + " - errno is the observed value or an explicit null, never omitted");
    assert.equal(CLASSIFICATIONS.includes(verdict.classification), true,
      "E1: " + spec.label + " must classify inside the closed vocabulary");
    assert.equal(verdict.sqliteCode, spec.error.code,
      "E1: " + spec.label + " - the code is preserved VERBATIM");
    if (spec.asserted !== null) {
      assert.equal(verdict.classification, spec.asserted,
        "E1: " + spec.label + " has a contract-stated classification");
    }
    if (isExtendedCode(spec.error.code)) {
      assert.notEqual(verdict.classification, "constraint",
        "E1: an extended code is never rewritten into a primary code's classification");
    }
    probes.push({
      label: spec.label,
      synthetic: true,
      input: { code: spec.error.code, errno: spec.error.errno === undefined ? null : spec.error.errno },
      verdict,
      sqliteCodeObserved: verdict.sqliteCode !== null,
      errnoObserved: verdict.errno !== null,
      classificationAsserted: spec.asserted,
    });
  }

  // The recorded vocabulary of every refusal this suite observed.
  const rows = evidence.errorVocabulary;
  assert.equal(rows.length > 0, true, "E1: the vocabulary must aggregate every recorded refusal");
  for (const row of rows) {
    assert.equal(ALL_REASONS.includes(row.reason), true,
      "E1: every recorded reason belongs to the closed section-3 vocabulary, got " + String(row.reason));
    if (row.classification !== null) {
      assert.equal(CLASSIFICATIONS.includes(row.classification), true,
        "E1: every recorded classification belongs to the closed vocabulary");
    }
    if (row.sqliteCode === "SQLITE_BUSY" && row.classification !== null) {
      assert.equal(row.classification, "busy",
        "E1: an observed primary SQLITE_BUSY must classify as busy (" + row.caseId + "/" + row.arm + ")");
    }
    if (row.sqliteCode === null && row.classification !== null) {
      assert.equal(row.classification, "unclassified",
        "E1: an absent code is a measured unknown and classifies as unclassified only");
    }
  }

  const reasonsObserved = [...new Set(rows.map(row => row.reason))].sort();
  const codesObserved = [...new Set(rows.map(row => row.sqliteCode))].sort((a, b) =>
    String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const classificationsObserved = [...new Set(rows.map(row => row.classification))].sort((a, b) =>
    String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

  evidence.cases.E1 = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    classifierProbes: probes,
    refusalsRecorded: rows.length,
    reasonsObserved,
    codesObserved,
    classificationsObserved,
    extendedCodesObserved: rows.filter(row => row.extendedCodeObserved).length,
    errnosObserved: rows.filter(row => row.errnoObserved).length,
    absentCodePolicy: "an absent extended code or errno is a MEASURED UNKNOWN, recorded explicitly "
      + "and never a failure; an asserted classification disagreeing with the observation IS a hard "
      + "failure",
    syntheticPolicy: "every probe above is SYNTHETIC. Native rollback, close and commit-phase BUSY "
      + "behaviour is UNMEASURED and is not claimed here.",
    vocabulary: rows,
  };
  maybeForceFail("E1");
});

// --- T: teardown and exact child accounting, derived from what actually ran ----------------------

test("T teardown: the recorded case-id list is derived from execution, and children are exact", () => {
  const recorded = Object.keys(evidence.cases).sort();
  assert.deepEqual(recorded, EXPECTED_CASE_IDS,
    "T: every expected case must have recorded its own evidence, and no other");

  // Exact child accounting. A killed child is still reaped: spawned must equal reaped.
  assert.equal(evidence.children.spawned, evidence.children.reaped,
    "T: childrenSpawned must equal childrenReaped - every child this suite forked was joined");
  assert.equal(evidence.children.records.length, evidence.children.spawned,
    "T: every spawned child contributed exactly one recorded lifecycle");
  assert.equal(liveChildren.size, 0,
    "T: no child handle may still be live when the suite finishes");
  for (const fact of evidence.children.records) {
    assert.equal(fact.exited, true, "T: every child exit is OBSERVED, never assumed");
    assert.equal(fact.exitCode !== null || fact.signal !== null, true,
      "T: every child records an exit code or a signal");
    // W7x is the ONLY case that may terminate a child, and it must do so through the exact handle
    // it owns. The pre-existing rule is kept at full strength for every other case rather than
    // relaxed run-wide: outside W7x an unknown fate or a test-caused kill is still a failure.
    if (fact.caseId === "W7x") {
      assert.equal(fact.lifecycle, "terminated-by-test",
        "T: a W7x child is terminated by this suite through its own handle, and that is recorded "
        + "as what it is rather than dressed up as a self-exit");
      assert.equal(fact.experimentalKills, 1,
        "T: a W7x child receives exactly ONE experimental signal");
      assert.equal(fact.cleanupKills, 0,
        "T: a joined W7x child needs no cleanup signal");
    } else {
      assert.equal(fact.lifecycle, "exited-observed",
        "T: every child outside W7x died on its own - no test-caused kill and no unknown fate");
      assert.equal(fact.killRequested, false,
        "T: no child outside W7x is ever signalled by this suite");
    }
  }
  // W6-R adds exactly TWO children run-wide: one owned lock-holding peer per arm, named term by
  // term below. W7 now spends W7_ARMS_PER_SEAM children per seam rather than one - the self-kill
  // arm and its same-run, same-seam ordinary-exit control - which is the compound contract's own
  // arithmetic and is DERIVED from that constant here, never re-typed as a total and never
  // hardcoded to force a green. Both W6-R peers are RELEASED COOPERATIVELY over IPC and JOINED,
  // and every W7 child ends on its own, so the outside-W7x killRequested:false rule above and the
  // run-wide signal totals below are untouched by either change.
  const expectedChildren =
    RACE_ITERATIONS * RACE_CHILD_COUNT + CRASH_SEAMS.length * W7_ARMS_PER_SEAM + CRASH_SEAMS.length
    + W6R_CONTROL_PEERS + W6R_DISCRIMINATOR_PEERS;
  assert.equal(evidence.children.spawned, expectedChildren,
    "T: exactly " + expectedChildren + " children (W6 " + RACE_ITERATIONS + "x" + RACE_CHILD_COUNT
    + ", W7 " + CRASH_SEAMS.length + "x" + W7_ARMS_PER_SEAM
    + ", W7x " + CRASH_SEAMS.length
    + ", W6-R control:read-transaction-peer " + W6R_CONTROL_PEERS
    + ", W6-R discriminator:refused-start-peer " + W6R_DISCRIMINATOR_PEERS + ")");
  // The two W7 arms are accounted SEPARATELY: a run that produced three self-kill children and no
  // controls would satisfy a bare total, and the control is the whole basis of conjunct (b).
  const w7ArmCounts = { [W7_ARM_SELF_KILL]: 0, [W7_ARM_ORDINARY_EXIT_CONTROL]: 0 };
  for (const fact of evidence.children.records) {
    if (fact.caseId === "W7" && Object.hasOwn(w7ArmCounts, fact.arm)) w7ArmCounts[fact.arm] += 1;
  }
  assert.deepEqual(w7ArmCounts, {
    [W7_ARM_SELF_KILL]: CRASH_SEAMS.length,
    [W7_ARM_ORDINARY_EXIT_CONTROL]: CRASH_SEAMS.length,
  }, "T: W7 ran exactly one self-kill arm AND one ordinary-exit control per seam - a missing "
    + "control would leave the sentinel absence unfalsifiable while the bare total still matched");

  // The W7x negative controls are DOUBLES and must not appear in the child accounting at all: a
  // simulation that inflated the spawned/reaped totals would be a simulation counted as a run.
  assert.equal(evidence.children.records.every(fact => fact.simulated !== true), true,
    "T: no simulated double may appear in the child accounting");

  // Run-wide, and measured rather than asserted as a constant: this suite owns exact handles and
  // has no code path that enumerates processes or signals a process group.
  assert.equal(signalAudit.pidScans, 0, "T: pidScans is zero run-wide");
  assert.equal(signalAudit.processGroupsSignalled, 0,
    "T: processGroupsSignalled is zero run-wide");
  assert.equal(signalAudit.experimentalKillsIssued, CRASH_SEAMS.length,
    "T: exactly one experimental signal per W7x seam, run-wide");
  assert.equal(signalAudit.realSignalsIssued,
    signalAudit.experimentalKillsIssued + signalAudit.cleanupKillsIssued,
    "T: every real signal is attributed to exactly one intent");
  evidence.signalAudit = {
    pidScans: signalAudit.pidScans,
    processGroupsSignalled: signalAudit.processGroupsSignalled,
    experimentalKillsIssued: signalAudit.experimentalKillsIssued,
    cleanupKillsIssued: signalAudit.cleanupKillsIssued,
    realSignalsIssued: signalAudit.realSignalsIssued,
    simulatedSignalsIssued: signalAudit.simulatedSignalsIssued,
    note: "experimental and cleanup kills are counted separately and never summed into a single "
      + "zero-signal claim. Simulated signals went to injected doubles and reached no process.",
  };

  evidence.executedCaseIds = recorded;
  evidence.executedCaseCount = recorded.length;
  evidence.childAccounting = {
    childrenSpawned: evidence.children.spawned,
    childrenReaped: evidence.children.reaped,
    expectedChildren,
    w7ArmCounts,
    // Named per arm rather than folded into one total, so the declared 166 + 2 = 168 change is
    // readable from the evidence without re-deriving it.
    expectedChildrenByCase: {
      W6: RACE_ITERATIONS * RACE_CHILD_COUNT,
      "W7:self_kill": CRASH_SEAMS.length,
      "W7:ordinary_exit_control": CRASH_SEAMS.length,
      W7x: CRASH_SEAMS.length,
      "W6-R:control:read-transaction-peer": W6R_CONTROL_PEERS,
      "W6-R:discriminator:refused-start-peer": W6R_DISCRIMINATOR_PEERS,
    },
    note: "T records NO case id of its own, so the TAP test count is one higher than "
      + "executedCaseCount - exactly the distinction P3 kept between 18 TAP tests and 17 case ids",
  };
});

// --- exit finaliser: cleanup and evidence, never altering the exit code --------------------------

// Runs from process.on("exit") rather than an after() hook so it survives a failing assertion. It
// MUST NOT change process.exitCode: a nonzero exit is never converted to success, and cleanup being
// recorded on a failing run never turns that failure into a zero.
let finalized = false;

function finalize() {
  if (finalized) return;
  finalized = true;

  // Only the exact child handles this suite created, and only if any survived.
  //
  // v3: a handle that already had its ONE bounded cleanup attempt is NOT signalled again here.
  // v2 issued a second SIGKILL straight through handle.child.kill, bypassing the kill accounting
  // entirely - so the run-wide signal totals under-reported by exactly the signals sent to the
  // children that mattered most. Skipping it is the honest option: the fate is already recorded as
  // unknown, and a second untracked signal would not make it known. No process scan, no process
  // group, and no global kill is ever performed.
  const orphanedChildrenKilled = [];
  const unjoinedHandlesNotReSignalled = [];
  for (const handle of liveChildren) {
    if (!mayReSignalHandle(handle)) {
      unjoinedHandlesNotReSignalled.push({
        pid: handle.record.pid,
        lifecycle: childLifecycle(handle.record),
        because: "a bounded cleanup signal was already issued and joined-for through this exact "
          + "handle; its fate stays recorded as unknown rather than re-signalled off the books",
      });
      continue;
    }
    orphanedChildrenKilled.push(handle.record.pid);
    try {
      handle.child.kill("SIGKILL");
    } catch {
      // Already gone. No process scan and no global kill is ever performed.
    }
  }

  // Restore the modes this suite deliberately restricted, for OWNED fixture directories under
  // WORK_DIR only. Never a privileged operation, never anything outside WORK_DIR.
  const permissionsRestored = [];
  const permissionRestoreFailures = [];
  const permissionRestoresSkippedForPreserved = [];
  for (const entry of modesToRestore) {
    // A preserved root is left EXACTLY as the arm left it - not removed and not chmod-ed.
    if (!mayCleanUpRoot(entry.dir)) {
      permissionRestoresSkippedForPreserved.push(entry.dir);
      continue;
    }
    try {
      fs.chmodSync(entry.dir, entry.mode);
      permissionsRestored.push(entry.dir);
    } catch (error) {
      permissionRestoreFailures.push({ dir: entry.dir, code: String(error && error.code) });
    }
  }

  // v3: the removal loop consults the SHARED preservation decision. Successfully joined roots
  // still clean normally; only the exact owned root of a W7x arm whose exit was never observed is
  // kept, because a live child may still be holding that store open.
  const removed = [];
  const failedToRemove = [];
  const preservedUnjoinedRoots = [];
  for (const root of createdRoots) {
    if (!mayCleanUpRoot(root)) {
      const entry = preservedRoots.get(root);
      preservedUnjoinedRoots.push(entry === undefined ? { root, because: "under_preserved_root" } : entry);
      continue;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
      removed.push(root);
    } catch (error) {
      failedToRemove.push({ root, code: String(error && error.code) });
    }
  }

  // Any tmp-* root still present under WORK_DIR after cleanup is a leak, and is recorded as one.
  let residualTmpRootsUnderWorkDir = [];
  try {
    residualTmpRootsUnderWorkDir = fs.readdirSync(WORK_DIR)
      .filter(name => name.startsWith(TMP_PREFIX)).sort();
  } catch {
    residualTmpRootsUnderWorkDir = [];
  }

  evidence.cleanup = {
    finalizedBy: "process.on(\"exit\")",
    rootsCreated: createdRoots.length,
    rootsRemoved: removed.length,
    failedToRemove,
    residualTmpRootsUnderWorkDir,
    // v3. A PRESERVED root is a deliberate, reported outcome - never a silent removal and never a
    // silent leak. It is listed explicitly and it forces clean:false, because the suite did not in
    // fact leave the work directory empty and saying otherwise would be the same false claim v2
    // made when it deleted the store it said it had preserved.
    preservedUnjoinedRoots,
    preservedRootCount: preservedUnjoinedRoots.length,
    permissionRestoresSkippedForPreserved,
    unjoinedHandlesNotReSignalled,
    clean: failedToRemove.length === 0
      && residualTmpRootsUnderWorkDir.length === 0
      && preservedUnjoinedRoots.length === 0,
    cleanPolicy: "clean is false whenever any owned root was preserved. A preserved root is a "
      + "REPORTED consequence of an unobserved child exit, distinct from a removal failure and "
      + "distinct from an unexplained residual leak; all three are listed separately.",
    tmpRootPrefix: TMP_PREFIX,
    orphanedChildrenKilled,
    permissionsRestored,
    permissionRestoreFailures,
    childrenSpawned: evidence.children.spawned,
    childrenReaped: evidence.children.reaped,
    note: "cleanup is RECORDED on a failing run and never converts a failure into a zero exit",
  };
  evidence.generatedAt = new Date().toISOString();
  evidence.exitCodeObserved = process.exitCode === undefined ? 0 : process.exitCode;
  if (evidence.executedCaseCount === undefined) {
    // T did not run to completion: the ids are still derived from what actually recorded evidence,
    // never from a hardcoded total, so a failing run reports fewer ids rather than a false full set.
    const recorded = Object.keys(evidence.cases).sort();
    evidence.executedCaseIds = recorded;
    evidence.executedCaseCount = recorded.length;
    evidence.executedCaseNote = "recorded by the finaliser because T did not complete; the list is "
      + "still derived from execution";
  }

  const payload = JSON.stringify(evidence, null, 2) + "\n";
  const targets = [path.join(WORK_DIR, "evidence.json")];
  if (EVIDENCE_DIR !== null && path.resolve(EVIDENCE_DIR) !== path.resolve(WORK_DIR)) {
    targets.push(path.join(EVIDENCE_DIR, "evidence.json"));
  }
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, payload);
    } catch (error) {
      // Reported on stderr only. Writing evidence must never mask or alter the run's verdict.
      process.stderr.write("evidence write failed (" + target + "): " + String(error && error.code) + "\n");
    }
  }
}

process.on("exit", finalize);
