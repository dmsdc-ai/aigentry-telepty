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
const P2_OPENER_COPY = path.join(SLICE_DIR, "p2-open-existing.cjs");
const P3_INITIALIZER_COPY = path.join(SLICE_DIR, "p3-init-exclusive.cjs");

// The complete set of case ids this suite is expected to execute. T compares this against the ids
// ACTUALLY recorded during the run; it is never a hardcoded pass total. T itself is a TAP test
// that records NO case id, so the TAP test count is one higher than executedCaseCount - exactly
// the distinction P3 kept between its 18 TAP tests and its 17 recorded case ids.
const EXPECTED_CASE_IDS = [
  "P0",
  "W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10", "W11", "W12",
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
  children: { spawned: 0, reaped: 0, records: [] },
  notes: [
    "Experimental prototype evidence only. No product adoption, no product reason-code mapping, "
    + "no journal-policy decision, no Node-floor decision and no dependency adoption is claimed.",
    "P4_FAIL_AT, P4_ROLLBACK_FAULT, P4_CLOSE_FAULT and P4_COMMIT_FAULT are SYNTHETIC tester-injected "
    + "seams, inert unset, that can only ADD a failure. Native rollback, close and COMMIT-busy "
    + "failure behaviour is UNMEASURED and is not claimed by W8, W10 or E1.",
    "W7 measures PROCESS TERMINATION, never power loss. No fsync or durability claim is made.",
    "R2-2: byte identity across a refusal is asserted ONLY for the clean W5 fixtures (a)-(e), where "
    + "the open itself fails and no handle is ever constructed. For refusals raised AFTER the open "
    + "(W2, W4, W11, W12) the before/after sha256 is RECORDED as an observation and deliberately "
    + "NOT asserted, because a read-write open may replay a hot rollback journal before any "
    + "validation runs.",
    "R2-6: byte identity is not a zero-call proof and proves no access ordering. Ordering is "
    + "claimed from the W9 structural source-order oracle alone.",
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

const SEAM_VARIABLES = ["P4_FAIL_AT", "P4_CRASH_AT", "P4_ROLLBACK_FAULT", "P4_CLOSE_FAULT", "P4_COMMIT_FAULT"];

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
  };
  const handle = { child, record };
  liveChildren.add(handle);
  evidence.children.spawned += 1;

  child.stderr.on("data", chunk => {
    if (record.stderrHead.length < 1024) record.stderrHead += String(chunk).slice(0, 1024);
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
  // The test owns this exact handle and signals this exact pid. No process scan, no global kill.
  handle.kill = () => {
    record.cleanupCalls += 1;
    if (record.exited) return false;
    record.killRequested = true;
    let delivered = false;
    try {
      delivered = child.kill("SIGKILL") === true;
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
  };
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
  try {
    for (let index = 0; index < RACE_CHILD_COUNT; index += 1) handles.push(spawnChild());
    // The start barrier: EVERY child reports ready before ANY child is released.
    await withDeadline(Promise.all(handles.map(handle => handle.ready)), PER_CHILD_TIMEOUT_MS,
      "W6 iteration " + iteration + " ready barrier");
    handles.forEach((handle, index) => {
      handle.child.send({ type: "go", storeRoot: store.storeRoot, options: raceOptions(iteration, index) });
    });
    await withDeadline(Promise.all(handles.map(handle => handle.exited)), PER_CHILD_TIMEOUT_MS,
      "W6 iteration " + iteration + " child join");
  } finally {
    // Exact owned handles only: no process scan and no global kill, ever.
    for (const handle of handles) handle.kill();
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
  try {
    ledger = requireLedger(store.dbPath, "W6 iteration " + iteration);
    generationObserved = ledger.generation;
    rowsObserved = totalSectionRows(ledger);
    sectionKeysObserved = sectionKeys(ledger, TARGET_SECTION);
    ledgerKeysObserved = Object.keys(ledger).sort();
  } catch (error) {
    ledger = null;
    ledgerError = observationFailure(error);
  }

  // (5) the on-disk inventory and sidecars, guarded the same way.
  let inventoryAfter = null;
  let sidecarsAfter = null;
  let inventoryError = null;
  try {
    inventoryAfter = inventory(store.storeRoot);
    sidecarsAfter = sidecars(store.storeRoot);
  } catch (error) {
    inventoryError = observationFailure(error);
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
    zeroRowPolicy: "a missing or failed ledger read is recorded as null with ledgerRead:false "
      + "and is NEVER reported as zero rows",
    recordingOrder: "every field above was recorded BEFORE the first assertion below",
  };
  evidence.cases.W6.iterations.push(latch);
  evidence.cases.W6.iterationsRecorded = evidence.cases.W6.iterations.length;

  // ---- ASSERTIONS: unchanged in strength, now running against a sealed record ----------------
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

  for (const result of losers) {
    assert.equal(
      result.reason === REASON_GENERATION_CONFLICT || result.reason === REASON_BUSY, true,
      "W6 iteration " + iteration + ": a loser refuses generation_conflict or busy and NOTHING "
      + "else, observed " + String(result.reason));
    if (result.reason === REASON_BUSY) {
      assert.equal(codeOf(result.sqliteCode), "SQLITE_BUSY",
        "W6 iteration " + iteration + ": a busy refusal carries the primary SQLITE_BUSY");
      assert.equal(result.retrySafe, true, "W6: a pre-COMMIT busy is retry-safe");
    } else {
      assert.equal(result.retrySafe, false, "W6: a generation conflict is NOT retry-safe");
    }
    assert.equal(result.committed, false, "W6: a loser never reports a commit");
    assertRetrySafeIsWellFormed(result, "W6 iteration " + iteration + " loser");
  }

  // The INDEPENDENT verifier decides what actually landed. The read itself already happened in
  // the latch above; a FAILED read is asserted as a failed read and is never silently treated as
  // "zero rows", so no iteration can be called clean on the strength of an observation that did
  // not succeed.
  assert.equal(latch.ledgerRead, true,
    "W6 iteration " + iteration + ": the independent opener must actually read the store - a "
    + "failed read is a failed measurement, NEVER evidence that nothing landed ("
    + JSON.stringify(latch.ledgerError) + ")");
  assert.equal(latch.inventoryError, null,
    "W6 iteration " + iteration + ": the on-disk inventory must actually be observed");
  assert.equal(latch.generationAfter, 2,
    "W6 iteration " + iteration + ": the opener reports generation exactly g + 1");
  assert.equal(latch.rowsAfter, 1,
    "W6 iteration " + iteration + ": EXACTLY one new row - no second write landed");
  assert.deepEqual(latch.sectionKeysAfter, [winners[0].key],
    "W6 iteration " + iteration + ": the single row is the winner's key");
  assert.deepEqual(latch.sidecarsAfter, [],
    "W6 iteration " + iteration + ": no hot sidecar survives the iteration");

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
    assert.equal(reason === REASON_GENERATION_CONFLICT || reason === REASON_BUSY, true,
      "W6: the loser vocabulary is closed to generation_conflict and busy");
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
    vocabularyNote: "the loser vocabulary stays CLOSED to generation_conflict and busy, exactly "
      + "as written. It is deliberately NOT widened to admit experimental_store_commit_uncertain: "
      + "an uncertain COMMIT leaves \"exactly one new row at g + 1\" genuinely UNKNOWN for that "
      + "iteration, and this acceptance experiment keeps its hard rejection of that uncertainty. "
      + "No retry, no busy_timeout, no PRAGMA and no journal_mode change is introduced here.",
  });
  maybeForceFail("W6");
});

// --- W7: the kill boundary - a killed writer returns nothing, recovery is only observed ---------

test("W7 kill boundary: no partial application survives a mid-transaction SIGKILL", async () => {
  const arms = [];
  // Seeded BEFORE the first seam so each arm latch has somewhere durable to write and the case
  // evidence survives a failing arm. status stays "incomplete" until every assertion has passed.
  evidence.cases.W7 = {
    status: "incomplete",
    platform: process.platform,
    seamsRequired: CRASH_SEAMS,
    arms: [],
    evidenceLatchNote: "each seam records its raw exitCode, signal, resultReceived, "
      + "killRequested and already-captured stderr, then the pre-reopen leftover and sidecars, "
      + "then the recovery observation, then the post-recovery inventory and the independent "
      + "opener ledger - all BEFORE its first assertion, and in that R2-2 pre/post order.",
  };
  for (const crashSeam of CRASH_SEAMS) {
    const store = newStore("w7-" + crashSeam);
    const beforeCrash = inventoryWithHashes(store.storeRoot);
    const handle = spawnChild({ P4_CRASH_AT: crashSeam });
    try {
      await withDeadline(handle.ready, PER_CHILD_TIMEOUT_MS, "W7 " + crashSeam + " ready");
      handle.child.send({
        type: "go",
        storeRoot: store.storeRoot,
        options: callOptions({ mutation: mutationOf("binding-crash", { seam: crashSeam }) }),
      });
      await withDeadline(handle.exited, PER_CHILD_TIMEOUT_MS, "W7 " + crashSeam + " exit");
    } finally {
      handle.kill();
    }

    const record = handle.record;

    // ---- FAILURE-SAFE EVIDENCE LATCH: every record below PRECEDES every assertion ------------
    // On Windows the ONLY fact this arm ever measured was record.signal, because every record
    // call sat after that assertion: the raw exit code, the result flag, the pre-reopen leftover
    // and its hashes, the sidecar list, the recovery observation, the post-recovery inventory and
    // the ledger were all lost; the lifecycle record was never pushed (113 spawned against 104
    // recorded); and the after_row_insert and before_commit seams never ran at all.
    //
    // The R2-2 ordering is preserved EXACTLY and is not merely reordered for convenience:
    // (1) the leftover is recorded BEFORE anything reopens the store, (2) the observer runs,
    // (3) the post-recovery state is recorded SEPARATELY afterwards. Neither overwrites the other.

    // (0) the raw observed child scalars, verbatim, before any oracle reads them.
    const rawObserved = {
      pid: record.pid,
      exitCode: record.exitCode,
      signal: record.signal,
      exited: record.exited,
      resultReceived: record.result !== null && record.result !== undefined,
      killRequested: record.killRequested,
      killDelivered: record.killDelivered,
      killedByTest: record.killedByTest,
      lifecycle: childLifecycle(record),
      // Already captured by the existing stderr listener. Recorded because it was captured -
      // no new instrumentation, no breadcrumb and no coder-file edit is introduced here.
      stderrHead: record.stderrHead === "" ? null : record.stderrHead,
      representationNote: "RAW observed values, recorded before any assertion reads them. This "
        + "suite asserts the POSIX representation (signal SIGKILL, exitCode null) unchanged and "
        + "hard. The actual representation of a self-delivered SIGKILL on a platform without "
        + "POSIX signal delivery remains UNKNOWN until a CI run measures it; nothing here is "
        + "relaxed to SIGKILL-or-null, reinterpreted, retried or fabricated.",
    };
    // Exactly ONE lifecycle record per child, pushed here and nowhere else in this case - never
    // from the finally above, so a cleanup pass cannot double-count a child.
    evidence.children.records.push({ caseId: "W7", crashSeam, ...lifecycleFacts(record) });

    // (1) The leftover, recorded VERBATIM before anything reopens the store.
    let leftover = null;
    let leftoverSidecars = null;
    let leftoverError = null;
    try {
      leftover = inventoryWithHashes(store.storeRoot);
      leftoverSidecars = sidecars(store.storeRoot);
    } catch (error) {
      leftoverError = observationFailure(error);
    }

    // (2) The tester-lane observer: one read-write open, one close, nothing else.
    let observation = null;
    let observationError = null;
    try {
      observation = observeRecoveryOpen(store.dbPath);
    } catch (error) {
      observationError = observationFailure(error);
    }

    // (3) Post-recovery state, recorded SEPARATELY, neither record overwriting the other.
    let afterRecovery = null;
    let afterRecoveryError = null;
    try {
      afterRecovery = inventoryWithHashes(store.storeRoot);
    } catch (error) {
      afterRecoveryError = observationFailure(error);
    }
    let ledgerRead = false;
    let ledgerError = null;
    let generationAfterRecovery = null;
    let rowsAfterRecovery = null;
    try {
      const ledger = requireLedger(store.dbPath, "W7/" + crashSeam);
      generationAfterRecovery = ledger.generation;
      rowsAfterRecovery = totalSectionRows(ledger);
      ledgerRead = true;
    } catch (error) {
      ledgerError = observationFailure(error);
    }

    // The parent record carries exactly the R2-2 field set and NOTHING resembling a returned
    // result. exitCode and signal are the RAW OBSERVED values, never hardcoded expectations:
    // writing the expected literal into the evidence would fabricate the very datum the oracle
    // below is supposed to be measuring.
    const parentRecord = {
      crashSeam,
      exitCode: record.exitCode,
      signal: record.signal,
      childOutcome: "unknown",
      commitOutcome: "unknown",
    };
    for (const forbidden of ["reason", "ok", "committed", "commitAttempted", "retrySafe"]) {
      assert.equal(Object.hasOwn(parentRecord, forbidden), false,
        "W7/" + crashSeam + ": the parent record must NOT synthesize " + forbidden
        + " for a process that returned nothing");
    }

    const membersChanged = leftover === null || afterRecovery === null
      ? null : JSON.stringify(leftover) !== JSON.stringify(afterRecovery);
    const arm = {
      crashSeam,
      // Explicitly incomplete until every assertion below has passed. A partial arm is recorded
      // as partial; it is never dressed up as a successful case to satisfy a downstream gate.
      status: "incomplete",
      rawObserved,
      parentRecord,
      synthetic: true,
      leftoverBeforeAnyReopen: leftover,
      leftoverSidecars,
      leftoverError,
      hotJournalPresentInLeftover: leftoverSidecars === null
        ? null : leftoverSidecars.some(name => name.endsWith("-journal")),
      hotJournalPolicy: "MEASURED, not assumed: section 0 K1 expects a hot -journal at "
        + "before_commit, and this record reports what this run actually observed",
      recoveryObservation: observation,
      recoveryObservationError: observationError,
      afterRecovery,
      afterRecoveryError,
      leftoverChangedByReopen: membersChanged,
      playbackNote: "a read-write open lets SQLite play back the rollback journal, so the leftover "
        + "is NOT byte-identical across the reopen - unlike P3 K1, which never opened its leftover. "
        + "That playback is SQLite behaviour OBSERVED, not a repair this slice or this lane performs "
        + "or claims, and it decides nothing about D2.",
      readOnlyOpenerOnLeftover: {
        attempted: false,
        reason: "read-only journal recovery (SQLITE_READONLY_RECOVERY) is UNMEASURED "
          + "(P2-CONTRACT section 3), so the read-only opener is NOT the verifier on the "
          + "pre-reopen leftover and no such attempt is made before the ordering above completes",
      },
      ledgerRead,
      ledgerError,
      generationAfterRecovery,
      totalSectionRowsAfterRecovery: rowsAfterRecovery,
      zeroRowPolicy: "a missing or failed ledger read is recorded as null with ledgerRead:false "
        + "and is NEVER reported as zero rows",
    };
    evidence.cases.W7.arms.push(arm);
    arms.push(arm);

    // ---- ASSERTIONS: unchanged in strength, now running against a sealed record --------------
    // R2-2: the writer signals its OWN pid only. This suite requested no kill for this child.
    assert.equal(record.killRequested, false,
      "W7/" + crashSeam + ": the child terminates itself; the suite scans no processes and kills none");
    // The strict POSIX oracle is KEPT as written. It is deliberately NOT relaxed to
    // "SIGKILL or null": that would make the arm pass without measuring anything, and the
    // Windows representation is UNKNOWN rather than known-to-be-null. If this fails on a
    // runner, the latched rawObserved above is what the next revision will be decided from.
    assert.equal(record.signal, "SIGKILL",
      "W7/" + crashSeam + ": the child must be terminated at the named point");
    assert.equal(record.exitCode, null,
      "W7/" + crashSeam + ": a signalled child reports no exit code");
    // A SIGKILLed process cannot return a JS object: fabricating one is a hard failure.
    assert.equal(record.result, null,
      "W7/" + crashSeam + ": a killed child returns NOTHING - no reason code, no committed, no retrySafe");

    assert.equal(leftoverError, null,
      "W7/" + crashSeam + ": the pre-reopen leftover must actually be observed");
    assert.equal(observationError, null,
      "W7/" + crashSeam + ": the recovery observer must actually run");
    assert.equal(observation.opened, true,
      "W7/" + crashSeam + ": the observer must be able to open the leftover read-write");
    assert.equal(observation.closed, true, "W7/" + crashSeam + ": the observer closes its handle");
    assert.equal(observation.openError, null, "W7/" + crashSeam + ": no open fault");
    assert.equal(observation.closeError, null, "W7/" + crashSeam + ": no close fault");
    assert.equal(afterRecoveryError, null,
      "W7/" + crashSeam + ": the post-recovery inventory must actually be observed");
    assert.equal(ledgerRead, true,
      "W7/" + crashSeam + ": the independent opener must actually read the store - a failed read "
      + "is a failed measurement, NEVER evidence that no partial application survived ("
      + JSON.stringify(ledgerError) + ")");
    assert.equal(generationAfterRecovery, 1,
      "W7/" + crashSeam + ": the opener reports generation g - no bump survived");
    assert.equal(rowsAfterRecovery, 0,
      "W7/" + crashSeam + ": ZERO new rows - no partial application survived");

    arm.status = "passed";
  }

  assert.equal(arms.length, CRASH_SEAMS.length, "W7: every named crash seam must be exercised");
  assert.deepEqual([...new Set(arms.map(entry => entry.status))], ["passed"],
    "W7: every recorded arm must have completed its assertions");
  // Augmented in place, NEVER reassigned: replacing the object would discard the latched arms.
  Object.assign(evidence.cases.W7, {
    status: "passed",
    seams: CRASH_SEAMS,
    terminationClaim: "PROCESS TERMINATION, never power loss. No durability or fsync claim is made.",
    killScope: "the writer signals its own pid only - no process scan, no global kill, and the "
      + "suite kills only the exact handles it created",
    fabricationPolicy: "the parent NEVER synthesizes experimental_store_commit_uncertain for a "
      + "killed child; that reason stays reserved for the surviving-process COMMIT-throw case",
  });
  maybeForceFail("W7");
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

test("W9 structural ownership of the runtime leaf, and fixture unreachability", () => {
  const writeCas = scanSource(WRITE_CAS_SOURCE);
  const writeChild = scanSource(WRITE_CHILD_SOURCE);
  const observer = scanSource(RECOVERY_OBSERVE_SOURCE);

  // No filesystem mutation, no probe, and no fs surface at all in the runtime leaf. The match is
  // word-bounded so that an ordinary identifier CONTAINING a banned word (for example
  // "inaccessible" around "access") cannot fail this oracle spuriously.
  for (const token of FORBIDDEN_RUNTIME_TOKENS) {
    assert.equal(new RegExp("\\b" + token + "\\b").test(writeCas.code), false,
      "W9: write-cas.cjs must not contain " + token + " (code, not comments)");
  }
  assert.equal(/\bfs\s*\./.test(writeCas.code), false,
    "W9: the runtime leaf touches no fs surface at all");

  // R2-6 (b): it requires neither node:fs nor node:path, and only builtins plus the pinned binding.
  const allowedSpecifier = specifier =>
    specifier === "better-sqlite3"
    || builtinModules.includes(specifier)
    || (specifier.startsWith("node:") && builtinModules.includes(specifier.slice(5)));
  const disallowed = writeCas.requires.filter(specifier => !allowedSpecifier(specifier));
  assert.deepEqual(disallowed, [],
    "W9: the runtime leaf may require only node builtins and better-sqlite3");
  for (const banned of ["fs", "node:fs", "path", "node:path"]) {
    assert.equal(writeCas.requires.includes(banned), false,
      "W9: R2-6 (b) - the runtime leaf requires neither node:fs nor node:path (" + banned + ")");
  }
  assert.deepEqual(writeCas.requires.filter(specifier => specifier.startsWith(".")), [],
    "W9: the runtime leaf has NO relative require - no product import, no states.cjs, no fixture");

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
  }
  assert.deepEqual(fromWriteChild, ["write-cas.cjs"],
    "W9: write-child.cjs requires the slice and nothing else relative");

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
    },
    writeChildRelativeClosure: fromWriteChild,
    writeCasRelativeClosure: fromWriteCas,
    observer: { requires: observer.requires, statements: sqlLiterals(observer) },
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
    assert.equal(fact.lifecycle, "exited-observed",
      "T: every child died on its own - no test-caused kill and no unknown fate");
  }
  const expectedChildren = RACE_ITERATIONS * RACE_CHILD_COUNT + CRASH_SEAMS.length;
  assert.equal(evidence.children.spawned, expectedChildren,
    "T: exactly " + expectedChildren + " children (W6 " + RACE_ITERATIONS + "x" + RACE_CHILD_COUNT
    + " plus W7 " + CRASH_SEAMS.length + ")");

  evidence.executedCaseIds = recorded;
  evidence.executedCaseCount = recorded.length;
  evidence.childAccounting = {
    childrenSpawned: evidence.children.spawned,
    childrenReaped: evidence.children.reaped,
    expectedChildren,
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
  const orphanedChildrenKilled = [];
  for (const handle of liveChildren) {
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
  for (const entry of modesToRestore) {
    try {
      fs.chmodSync(entry.dir, entry.mode);
      permissionsRestored.push(entry.dir);
    } catch (error) {
      permissionRestoreFailures.push({ dir: entry.dir, code: String(error && error.code) });
    }
  }

  const removed = [];
  const failedToRemove = [];
  for (const root of createdRoots) {
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
    clean: failedToRemove.length === 0 && residualTmpRootsUnderWorkDir.length === 0,
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
