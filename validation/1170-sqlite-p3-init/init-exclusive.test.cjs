'use strict';

// P3 independent oracle suite for the experimental exclusive-init SQLite slice.
//
// Authoring lane: st1170bk-tester. This file is written by a DIFFERENT session from the one that
// writes init-exclusive.cjs / states.cjs / race-child.cjs (INIT-CONTRACT.md section 5, Tester row).
// Every expected value below - in particular EXPECTED_INIT_LEDGER, TEST_MARKER and the EEXIST
// envelope - is authored HERE from the prose of INIT-CONTRACT.md as bounded by the controller's
// shared integration interface, and from P2-CONTRACT.md section 3/5 as amended by
// P2-CORRECTIONS.md. Nothing expected is imported from states.cjs or from init-exclusive.cjs:
// states.cjs returns a dbPath, never an expected ledger, so a green I1 cannot mean "the generator
// agreed with itself".
//
// Scope discipline carried from the dispatch:
//   - P2-CORRECTIONS.md wins over P2-CONTRACT.md on every contradictory phrase.
//   - All reason codes asserted here are EXPERIMENTAL, prototype-only identifiers. No product
//     reason code is asserted, mapped, added or changed, and nothing here approves adoption.
//   - The INIT-CONTRACT.md opening si1170bh identity / 29-file attestation is inherited historical
//     text. It is NOT this suite's provenance: this lane recounted the current 20-leaf frozen
//     manifest itself (20 declared, 20 present, 0 sha256 / byte-length / mode mismatch).
//   - initIntent.authority is a SYNTHETIC test precondition, never authentication proof.
//   - Process termination (K1) is not power loss, and P3_CLOSE_FAULT (K4) is a SYNTHETIC fault,
//     never a measured native close failure.
//
// This suite asserts codes and values, never messages. There are no skips and no
// continue-on-error. A failing oracle is reported, never patched around, and no file under test is
// modified from here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { builtinModules } = require('node:module');

const Database = require('better-sqlite3');

// The slice under test (coder lane) and its fixture writer (coder lane).
const { initializeExperimentalSqliteStore, classifyClaimFailure } = require('./init-exclusive.cjs');
const { createState } = require('./states.cjs');

// The frozen P2 opener, mechanically copied into this directory by the builder lane BEFORE the
// test runs, byte-identical and read-only. It is the independent verifier of I1/R1/K1/K2/K4. The
// product initializer never imports it; only this suite does.
const { loadConditionalAdmissionsSqlite } = require('./p2-open-existing.cjs');

// --- environment / evidence contract ------------------------------------------------------

function envOrNull(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

// P3_WORK_DIR is an EXISTING owned root supplied by the builder. When absent we create our own
// root under os.tmpdir() rather than writing anywhere near the source tree or $HOME.
const WORK_DIR_FROM_ENV = envOrNull('P3_WORK_DIR');
const WORK_DIR = WORK_DIR_FROM_ENV || fs.mkdtempSync(path.join(os.tmpdir(), 'p3-work-'));
const EVIDENCE_DIR = envOrNull('P3_EVIDENCE_DIR');
const FORCE_FAIL = envOrNull('P3_FORCE_FAIL');

const SLICE_DIR = __dirname;
const INIT_SOURCE = path.join(SLICE_DIR, 'init-exclusive.cjs');
const STATES_SOURCE = path.join(SLICE_DIR, 'states.cjs');
const RACE_CHILD_SOURCE = path.join(SLICE_DIR, 'race-child.cjs');
const P2_OPENER_COPY = path.join(SLICE_DIR, 'p2-open-existing.cjs');

// The complete set of case ids this suite is expected to execute. T compares this against the ids
// actually recorded during the run; it is never a hardcoded pass total.
const EXPECTED_CASE_IDS = [
  'P0', 'E0', 'I1', 'I2',
  'N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7',
  'R1', 'K1', 'K2', 'K3', 'K4',
].sort();

const evidence = {
  schema: 'st1170bk-p3-init-evidence/1',
  // Identity is read from the actual environment or recorded as null. It is never backfilled from
  // a prior worker attempt or from the inherited INIT-CONTRACT header text.
  gitHead: envOrNull('P3_GIT_HEAD'),
  ci: {
    detected: envOrNull('CI') !== null || envOrNull('GITHUB_ACTIONS') !== null,
    repository: envOrNull('GITHUB_REPOSITORY'),
    workflow: envOrNull('GITHUB_WORKFLOW'),
    runId: envOrNull('GITHUB_RUN_ID'),
    runNumber: envOrNull('GITHUB_RUN_NUMBER'),
    runAttempt: envOrNull('GITHUB_RUN_ATTEMPT'),
    job: envOrNull('GITHUB_JOB'),
    eventName: envOrNull('GITHUB_EVENT_NAME'),
    // For pull_request events GITHUB_SHA is the synthetic merge commit, so it is recorded as an
    // observation and is not treated as the head under test.
    githubSha: envOrNull('GITHUB_SHA'),
  },
  runtime: {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    // Recorded because N7 on POSIX depends on a non-privileged euid to mean anything at all.
    euid: typeof process.geteuid === 'function' ? process.geteuid() : null,
  },
  workDirFromEnv: WORK_DIR_FROM_ENV !== null,
  workDir: WORK_DIR,
  evidenceDirFromEnv: EVIDENCE_DIR,
  forceFailHook: FORCE_FAIL,
  frozenInputs: {},
  cases: {},
  notes: [
    'Experimental prototype evidence only. No product adoption, no product reason-code mapping, '
    + 'no Node-floor decision, no dependency adoption is claimed or implied.',
    'initIntent.authority is a synthetic test precondition, not authentication proof.',
    'K1 measures process termination, never power loss. K4 induces a SYNTHETIC close fault, never '
    + 'a measured native close failure.',
  ],
};

// P3_FORCE_FAIL may only ADD a bounded intentional failure. It is invoked at the END of a case,
// after that case's evidence has been recorded, so it can never convert a real pass into a silent
// skip, and can never suppress a real failure.
function maybeForceFail(caseId) {
  if (FORCE_FAIL === caseId) {
    assert.fail(
      `P3_FORCE_FAIL=${caseId}: deliberate bounded failure injected to demonstrate that temp-root `
      + 'cleanup and evidence persistence survive a failing assertion without altering the exit code',
    );
  }
}

// --- owned temp roots ----------------------------------------------------------------------

// Every root is created by this suite under WORK_DIR with the P2 '.tmp-' prefix, so the builder's
// ported G3 gate can find residue with the same filter P2 used.
const TMP_PREFIX = '.tmp-';
const createdRoots = [];
// POSIX modes this suite deliberately restricted (N7). Restored before removal, for OWNED fixture
// directories only - never a privileged operation and never anything outside WORK_DIR.
const modesToRestore = [];
// Exact child handles this suite owns. The finaliser kills these handles only; no global process
// scan and no global kill is ever performed.
const liveChildren = new Set();

// One owned parent directory per case. The initializer requires an EXISTING parent and creates
// only storeRoot, so the parent is always this mkdtemp root and storeRoot is a name inside it.
function ownedParent(label) {
  const root = fs.mkdtempSync(path.join(WORK_DIR, `${TMP_PREFIX}${label}-`));
  createdRoots.push(root);
  return root;
}

// --- filesystem observation helpers ----------------------------------------------------------

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Sorted (name, size) inventory, as P2 recorded it.
function inventory(dir) {
  return fs.readdirSync(dir)
    .map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'];

function sidecars(dir) {
  return fs.readdirSync(dir)
    .filter(name => SIDECAR_SUFFIXES.some(sfx => name.endsWith(sfx)))
    .sort();
}

// Full state snapshot of a pre-existing target: sorted (name, size, sha256) for a directory, or
// (size, sha256) for a regular file. N1-N6 compare this before and after the refusal, which is how
// "identical sha256, identical size, identical sorted inventory" is asserted for every member.
function stateSnapshot(target) {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    const members = fs.readdirSync(target).sort().map(name => {
      const member = path.join(target, name);
      const memberStat = fs.lstatSync(member);
      return {
        name,
        kind: memberStat.isFile() ? 'file' : memberStat.isDirectory() ? 'dir' : 'other',
        size: memberStat.size,
        sha256: memberStat.isFile() ? sha256File(member) : null,
      };
    });
    return { kind: 'dir', members };
  }
  return {
    kind: stat.isFile() ? 'file' : 'other',
    size: stat.size,
    sha256: stat.isFile() ? sha256File(target) : null,
  };
}

function normalizeToLf(buffer) {
  return Buffer.from(buffer.toString('binary').replace(/\r\n/g, '\n'), 'binary');
}

// --- expectations authored here, independently of the code under test -------------------------

// INIT-CONTRACT.md section 2: the owned namespace is every path under storeRoot, and the store
// file name is authored here rather than imported from the coder's leaves.
const DB_FILENAME = 'conditional-admissions.sqlite3';
const STORE_ROOT_NAME = 'store';

// P2-CONTRACT.md section 5: the ledger has EXACTLY these seven keys, in this order.
const EXPECTED_LEDGER_KEYS = [
  'schema_version', 'generation', 'marker', 'bindings', 'admissions', 'tombstones', 'fenced_sessions',
];

// This lane's own marker. Lowercase v4 uuid (third group starts '4', fourth group starts '9') and
// a canonical toISOString() instant that survives the round-trip. Deliberately different from the
// P2 fixture marker so that no value can leak in from the P2 lane.
const TEST_MARKER = {
  marker_id: '3b1f2c4d-8e6a-4c5b-9d7e-0a1b2c3d4e5f',
  initialized_at: '2026-03-04T05:06:07.008Z',
};

// A SECOND, distinct valid marker, used for the K2 history-preservation store.
const K2_MARKER = {
  marker_id: '7c6d5e4f-1a2b-4c3d-abcd-0f1e2d3c4b5a',
  initialized_at: '2025-11-12T13:14:15.016Z',
};

// Used for the N1-N6 pre-existing states, so none of them shares this lane's init marker.
const PRIOR_MARKER = {
  marker_id: 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  initialized_at: '2024-06-07T08:09:10.011Z',
};

// The positive init precondition. `authority` is SYNTHETIC: no real credential, account, network
// or live store is involved anywhere in this suite.
function initIntent() {
  return {
    declaredBy: 'st1170bk-tester',
    requestId: 'p3-init-oracle-0001',
    authority: 'synthetic-test-precondition-not-authentication-proof',
  };
}

// initialGeneration is a REQUIRED input whose only accepted value is the NUMBER 0 (the caller
// declaring that it initializes from nothing). The resulting empty-ledger generation is the NUMBER
// 1 - the 0-to-1 bump, never a generation inferred or discovered from disk.
const REQUIRED_INITIAL_GENERATION = 0;
const EXPECTED_RESULT_GENERATION = 1;

function initOptions(overrides = {}) {
  return {
    marker: { ...TEST_MARKER },
    initIntent: initIntent(),
    initialGeneration: REQUIRED_INITIAL_GENERATION,
    ...overrides,
  };
}

// I1: the ledger of a freshly initialized store, authored here from prose. Seven keys, the exact
// supplied marker, EMPTY section objects, schema_version 1 and generation 1 as NUMBERS.
const EXPECTED_INIT_LEDGER = {
  schema_version: 1,
  generation: EXPECTED_RESULT_GENERATION,
  marker: { ...TEST_MARKER },
  bindings: {},
  admissions: {},
  tombstones: {},
  fenced_sessions: {},
};

// The EEXIST refusal is exactly three properties: no `detail`, no `error`. The contents of the
// taken name are deliberately never inspected, so no case may infer a different reason from
// whatever happens to be on disk - N6 (storeRoot is a regular file) included.
const EEXIST_ENVELOPE = { ok: false, reason: 'experimental_store_root_exists', errno: 'EEXIST' };
const EEXIST_PROPERTY_NAMES = ['errno', 'ok', 'reason'];

function assertExactEexistEnvelope(result, context) {
  assert.deepEqual(result, EEXIST_ENVELOPE, `${context}: the single identical EEXIST envelope`);
  assert.deepEqual(
    Object.keys(result).sort(), EEXIST_PROPERTY_NAMES,
    `${context}: exactly three properties - no detail, no stray error`,
  );
  assert.equal(Object.hasOwn(result, 'detail'), false, `${context}: no detail property`);
  assert.equal(Object.hasOwn(result, 'error'), false, `${context}: no error property`);
}

const REASON_PRECONDITION_INVALID = 'experimental_init_precondition_invalid';
const REASON_INTENT_ABSENT = 'experimental_init_intent_absent';
const REASON_ROOT_EXISTS = 'experimental_store_root_exists';
const REASON_ROOT_UNAVAILABLE = 'experimental_store_root_unavailable';
const REASON_CLOSE_FAILED = 'experimental_init_close_failed';

// E0 vocabulary, accumulated from every claim failure this suite observes and asserted as a whole
// by the E0 case. An absent errno is a measured unknown; a classification that disagrees with the
// observation is a hard failure.
const errnoVocabulary = [];

function recordClaimFailure(entry) {
  errnoVocabulary.push(entry);
  return entry;
}

// Observes the raw error of a real mkdir claim on the same path, so E0 can record code / errno /
// syscall and so classifyClaimFailure can be exercised on a genuine error object. This is an
// observation made by the TEST, alongside the initializer's own refusal - it is not a second claim
// attempt by the slice.
function observeRawClaim(target) {
  try {
    fs.mkdirSync(target);
    return { threw: false, code: null, errno: null, syscall: null };
  } catch (error) {
    return {
      threw: true,
      code: error && error.code === undefined ? null : error.code,
      errno: error && error.errno === undefined ? null : error.errno,
      syscall: error && error.syscall === undefined ? null : error.syscall,
      classified: classifyClaimFailure(error),
      raw: error,
    };
  }
}

// --- bounded, test-owned instrumentation seam for N0 ------------------------------------------

// N0's load-bearing claim is that the precondition check runs BEFORE any filesystem call. An
// after-state observation ("storeRoot does not exist afterwards") is consistent with that, but is
// NOT a no-call proof: a call could have been made and failed. So this suite installs a bounded
// recorder over the sync fs entry points, proves the seam is observable with a POSITIVE control
// (an init that really does call mkdirSync must be counted), and only then asserts zero calls.
// When the positive control shows the seam cannot see the slice's calls - e.g. the slice captured
// its bindings at load time - the recorder makes no claim at all and N0 falls back to the
// after-state observation, explicitly labelled as not a no-call proof.
const RECORDED_FS_NAMES = [
  'mkdirSync', 'mkdtempSync', 'statSync', 'lstatSync', 'fstatSync', 'accessSync', 'existsSync',
  'openSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'readdirSync', 'unlinkSync',
  'rmSync', 'rmdirSync', 'renameSync', 'truncateSync', 'ftruncateSync', 'chmodSync', 'copyFileSync',
  'realpathSync', 'readlinkSync',
];

// Captured before any patching, so restoration can be asserted rather than assumed.
const PRISTINE_FS = new Map(RECORDED_FS_NAMES.map(name => [name, fs[name]]));

function withFsCallRecorder(fn) {
  const calls = [];
  const patched = [];
  for (const name of RECORDED_FS_NAMES) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    const descriptor = Object.getOwnPropertyDescriptor(fs, name);
    if (descriptor && descriptor.writable === false && descriptor.set === undefined) continue;
    const recorder = function recordedFsCall(...args) {
      calls.push({ fn: name, arg0: typeof args[0] === 'string' ? args[0] : typeof args[0] });
      return original.apply(this, args);
    };
    try {
      fs[name] = recorder;
      patched.push([name, original]);
    } catch {
      // A non-writable entry point simply stays unobserved; it is never forced.
    }
  }

  let value;
  let thrown = null;
  try {
    value = fn();
  } catch (error) {
    thrown = error;
  } finally {
    // Restoration happens unconditionally, and to the ORIGINAL function objects.
    for (const [name, original] of patched) {
      try {
        fs[name] = original;
      } catch {
        // Recorded by the post-restore assertion below rather than swallowed silently.
      }
    }
  }

  // The seam is only safe if it left the module exactly as it found it.
  for (const [name, pristine] of PRISTINE_FS) {
    assert.equal(fs[name], pristine, `instrumentation seam must restore fs.${name} exactly`);
  }

  if (thrown !== null) throw thrown;
  return { value, calls, observedEntryPoints: patched.map(([name]) => name) };
}

// --- source-text helpers for K3 ----------------------------------------------------------------

// Strips line and block comments so that a PROSE mention of a forbidden call (the coder's own
// "no lstat/stat/access/existsSync here" comment) is not mistaken for a call. Both the raw and the
// stripped counts are recorded; only the stripped text is asserted on.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function countMatches(source, pattern) {
  const matches = source.match(pattern);
  return matches === null ? 0 : matches.length;
}

function requireArguments(source) {
  const found = [];
  const pattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    found.push(match[2]);
    match = pattern.exec(source);
  }
  return found;
}

function isBuiltin(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return builtinModules.includes(bare);
}

// Transitive closure of LOCAL (relative) requires, used to assert that states.cjs is unreachable
// from the runtime leaves.
function localRequireClosure(entry) {
  const seen = new Set();
  const pending = [path.resolve(entry)];
  const edges = [];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = stripComments(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const specifier of requireArguments(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      edges.push({ from: path.basename(file), to: path.basename(resolved) });
      pending.push(resolved);
    }
  }
  seen.delete(path.resolve(entry));
  return { reachable: [...seen].sort(), edges };
}

// --- child-process helpers (R1 / K1 / K4) -------------------------------------------------------

const PER_CHILD_TIMEOUT_MS = 10_000;
const SUITE_RACE_BUDGET_MS = 8 * 60 * 1000;
const RACE_CHILD_COUNT = 8;
const RACE_ITERATIONS = 20;

// Children never inherit this suite's own seams: the crash, close-fault and force-fail hooks are
// removed from the base environment and re-added only where a case deliberately asks for one.
function childEnv(extra = {}) {
  const env = { ...process.env };
  delete env.P3_CRASH_AT;
  delete env.P3_CLOSE_FAULT;
  delete env.P3_FORCE_FAIL;
  return { ...env, ...extra };
}

// fork IPC protocol (controller-reviewed integration detail): the child signals {type:'ready'},
// waits for {type:'go', storeRoot, options}, calls the initializer ONCE, sends
// {type:'result', result} and exits cleanly.
function spawnChild(extraEnv) {
  const child = fork(RACE_CHILD_SOURCE, [], {
    cwd: SLICE_DIR,
    env: childEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const record = {
    pid: child.pid,
    ready: false,
    result: null,
    exitCode: null,
    signal: null,
    killedByTest: false,
    stderrHead: '',
  };
  const handle = { child, record };
  liveChildren.add(handle);

  child.stderr.on('data', chunk => {
    if (record.stderrHead.length < 1024) record.stderrHead += String(chunk).slice(0, 1024);
  });
  handle.ready = new Promise(resolve => {
    child.on('message', message => {
      if (message && message.type === 'ready') {
        record.ready = true;
        resolve(record);
      }
      if (message && message.type === 'result') {
        record.result = message.result;
      }
    });
  });
  handle.exited = new Promise(resolve => {
    child.on('exit', (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      liveChildren.delete(handle);
      resolve(record);
    });
  });
  // The test owns this exact handle. No global process kill is ever issued.
  handle.kill = () => {
    record.killedByTest = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The child had already exited; nothing to do.
    }
  };
  return handle;
}

// Bounds a wait without ever masking a non-unique winner: a timeout is a hard failure, never a
// retry. The caller kills its own handles in a finally.
function withDeadline(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// --- P0: preconditions on the pinned native stack and on the frozen P2 opener copy --------------

// Strips a Windows extended-length prefix before normalising separators and case, per the P2 P0
// oracle. Without this step a mapped Windows path can never equal the selector's ordinary path.
function normalizeNativePath(value) {
  return String(value)
    .replace(/^\\\\\?\\/, '')
    .replace(/^\/\/\?\//, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function observeMappedNativeBinary() {
  const method = 'process.report.getReport().sharedObjects';
  let sharedObjects;
  try {
    sharedObjects = process.report.getReport().sharedObjects;
  } catch (error) {
    return { observed: false, method, reason: `getReport() threw: ${error && error.code}` };
  }
  if (!Array.isArray(sharedObjects)) {
    return { observed: false, method, reason: 'sharedObjects is not an array' };
  }
  const nodeObjects = sharedObjects.filter(entry => /\.node$/i.test(String(entry)));
  if (nodeObjects.length === 0) {
    return {
      observed: false,
      method,
      reason: 'no .node entry present in sharedObjects on this platform/runtime',
      sharedObjectCount: sharedObjects.length,
    };
  }
  return { observed: true, method, nodeObjects };
}

// The frozen P2 leaf hash, transcribed from this track's frozen-manifest.json entry for
// input/source/validation/1170-sqlite-p2-open/open-existing.cjs (11948 bytes, pure LF).
const P2_OPENER_LF_SHA256 = 'd5e8e5b3311fc5e83dc7d11b72aa864032d50120db1d50abcd23e6686b936cd1';
const P2_OPENER_LF_BYTES = 11948;

test('P0 pinned native stack, and the frozen P2 opener copy this suite verifies against', () => {
  const pkg = require('better-sqlite3/package.json');
  assert.equal(pkg.version, '13.0.3', 'better-sqlite3 must be the pinned 13.0.3');

  // P2-CORRECTIONS.md C5: the resolved node-addon-api stays at the verified 8.9.2, never a fresh
  // ^8 pick with an unverified integrity.
  const addon = require('node-addon-api/package.json');
  assert.equal(addon.version, '8.9.2', 'node-addon-api must be the verified 8.9.2');

  const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'));
  const binding = require(path.join(packageRoot, 'lib', 'binding.js'));
  const selected = binding.getPrebuildPath();
  assert.ok(typeof selected === 'string' && selected.length > 0, 'getPrebuildPath() must select a file');
  assert.equal(fs.existsSync(selected), true, 'the selected prebuild file must exist');

  let sqliteVersion;
  const probe = new Database(':memory:');
  try {
    sqliteVersion = probe.prepare('SELECT sqlite_version() AS v').get().v;
  } finally {
    probe.close();
  }
  assert.match(sqliteVersion, /^\d+\.\d+\.\d+$/, 'sqlite_version() must be a dotted triple');

  const mapped = observeMappedNativeBinary();
  let selectedMatchesMapped = null;
  if (mapped.observed) {
    const wanted = normalizeNativePath(selected);
    selectedMatchesMapped = mapped.nodeObjects.some(entry => normalizeNativePath(entry) === wanted);
    // UNKNOWN and MISMATCH stay distinct: a mapping that IS observable and disagrees with the
    // selection is a hard failure; a mapping that cannot be observed is a recorded unknown with
    // selectedMatchesMapped === null.
    assert.equal(
      selectedMatchesMapped, true,
      'the observed mapped native binary must agree with the selected prebuild',
    );
  }

  // The builder copies the frozen P2 opener here byte-identically before the test runs. This lane
  // REQUIRES that read-only copy as its independent verifier, so it checks the copy's provenance
  // itself rather than trusting the copy step. The comparison is made on LF-normalized bytes: a
  // Windows checkout may legitimately hold CRLF on disk (P2-CONTRACT.md section 0 records exactly
  // that transform), and the raw match is recorded as an observation rather than asserted.
  const copyRaw = fs.readFileSync(P2_OPENER_COPY);
  const copyRawSha = crypto.createHash('sha256').update(copyRaw).digest('hex');
  const copyLf = normalizeToLf(copyRaw);
  const copyLfSha = crypto.createHash('sha256').update(copyLf).digest('hex');
  assert.equal(copyLfSha, P2_OPENER_LF_SHA256, 'the P2 opener copy must be the frozen P2 leaf (LF-normalized sha256)');
  assert.equal(copyLf.length, P2_OPENER_LF_BYTES, 'the P2 opener copy must be the frozen P2 leaf byte length (LF-normalized)');
  assert.equal(typeof loadConditionalAdmissionsSqlite, 'function', 'the copied P2 opener must export its one function');

  evidence.frozenInputs.p2OpenerCopy = {
    path: P2_OPENER_COPY,
    rawSha256: copyRawSha,
    rawBytes: copyRaw.length,
    lfNormalizedSha256: copyLfSha,
    lfNormalizedBytes: copyLf.length,
    expectedLfSha256: P2_OPENER_LF_SHA256,
    rawMatchesFrozenLf: copyRawSha === P2_OPENER_LF_SHA256,
    note: 'read-only byte-identical copy of the frozen P2 leaf, required by this suite as an '
      + 'independent verifier. It is never edited here, and the product initializer never imports it. '
      + 'A raw mismatch with an LF match is a checkout line-ending transform, not a content change.',
  };

  evidence.cases.P0 = {
    betterSqlite3Version: pkg.version,
    nodeAddonApiVersion: addon.version,
    sqliteVersion,
    nodeVersion: process.version,
    nodeVersionAssertedHere: false,
    nodeVersionNote: 'the pinned 24.21.0 assertion belongs to the builder lane CI step; this case '
      + 'records the observed runtime only',
    selectedPrebuild: selected,
    selectedPrebuildExists: true,
    selectedPrebuildNote: 'filename selection only - NOT evidence that this file was the one mapped',
    mappedNativeBinary: mapped,
    selectedMatchesMapped,
    windowsPrefixNormalization: 'applied to both sides before comparison (\\\\?\\ and //?/ stripped)',
    p2OpenerCopy: evidence.frozenInputs.p2OpenerCopy,
  };
  maybeForceFail('P0');
});

// --- I1: the positive init, verified by the independent frozen P2 opener -------------------------

test('I1 positive: one initializer creates one complete store with the authored ledger', () => {
  const parent = ownedParent('I1');
  const storeRoot = path.join(parent, STORE_ROOT_NAME);
  const dbPath = path.join(storeRoot, DB_FILENAME);

  const result = initializeExperimentalSqliteStore(storeRoot, initOptions());

  assert.equal(result.ok, true, 'a fresh owned parent with a declared init intent must initialize');
  assert.equal(result.storeRoot, storeRoot, 'the result echoes the storeRoot it claimed');

  const { ledger } = result;
  assert.deepEqual(Object.keys(ledger), EXPECTED_LEDGER_KEYS, 'the 7 ledger keys, in contract order');
  assert.deepEqual(ledger, EXPECTED_INIT_LEDGER, 'the ledger must equal the independently authored literal');
  assert.equal(ledger.generation, EXPECTED_RESULT_GENERATION, 'the empty-ledger generation is the NUMBER 1');
  assert.equal(typeof ledger.generation, 'number', 'generation is numeric, never the string');
  assert.equal(typeof ledger.schema_version, 'number', 'schema_version surfaces as a number');
  assert.deepEqual(ledger.marker, TEST_MARKER, 'the marker is exactly the one supplied by the caller');
  assert.deepEqual(Object.keys(ledger.marker), ['marker_id', 'initialized_at'], 'marker has exactly 2 keys, in order');
  for (const section of ['bindings', 'admissions', 'tombstones', 'fenced_sessions']) {
    assert.deepEqual(ledger[section], {}, `${section} starts empty`);
    assert.deepEqual(Object.keys(ledger[section]), [], `${section} has no rows`);
  }

  // The unmodified P2 opener, reused READ-ONLY as an independent verifier. Because the expected
  // literal above was authored in this lane and the opener comes from the frozen P2 leaf, a green
  // I1 cannot mean "the initializer agreed with itself".
  const shaBeforeVerify = sha256File(dbPath);
  const verified = loadConditionalAdmissionsSqlite(dbPath);
  const shaAfterVerify = sha256File(dbPath);

  assert.equal(verified.ok, true, 'the frozen P2 opener must be able to open the initialized store');
  assert.deepEqual(Object.keys(verified.ledger), EXPECTED_LEDGER_KEYS, 'the verifier sees the same 7 keys');
  assert.deepEqual(verified.ledger, EXPECTED_INIT_LEDGER, 'the verifier reconstructs the same authored ledger');
  assert.deepEqual(verified.ledger, ledger, 'initializer and independent verifier deep-equal each other');
  assert.equal(shaAfterVerify, shaBeforeVerify, 'the read-only verification changes no byte (observation)');

  evidence.cases.I1 = {
    ok: true,
    storeRoot,
    ledgerKeys: Object.keys(ledger),
    generation: ledger.generation,
    schemaVersion: ledger.schema_version,
    markerIdAsserted: ledger.marker.marker_id,
    sectionsEmpty: true,
    independentVerifier: {
      source: 'frozen P2 open-existing.cjs, copied read-only as p2-open-existing.cjs',
      ok: verified.ok,
      generation: verified.ledger.generation,
      deepEqualToInitializerLedger: true,
      sha256BeforeVerify: shaBeforeVerify,
      sha256AfterVerify: shaAfterVerify,
    },
    expectationSource: 'authored in the tester lane from INIT-CONTRACT.md prose; nothing imported '
      + 'from states.cjs or init-exclusive.cjs',
    generationNote: 'declared initialGeneration 0 -> resulting generation 1; no generation is '
      + 'inferred, read or discovered from disk',
  };
  maybeForceFail('I1');
});

// --- I2: the created inventory, the one fact recorded for a future backup slice -------------------

test('I2 inventory: the won namespace holds exactly the store file, with no sidecar or tmp residue', () => {
  const parent = ownedParent('I2');
  const storeRoot = path.join(parent, STORE_ROOT_NAME);

  const result = initializeExperimentalSqliteStore(storeRoot, initOptions());
  assert.equal(result.ok, true, 'I2 needs a successful init to inventory');

  const names = fs.readdirSync(storeRoot).sort();
  const members = inventory(storeRoot);

  assert.deepEqual(names, [DB_FILENAME], 'storeRoot holds exactly conditional-admissions.sqlite3');
  assert.deepEqual(sidecars(storeRoot), [], 'no -journal / -wal / -shm sidecar may remain');
  assert.equal(members.length, 1, 'exactly one member');
  assert.ok(members[0].size > 0, 'the store file is non-empty');
  assert.equal(fs.lstatSync(storeRoot).isDirectory(), true, 'storeRoot is a directory');
  // No tmp residue inside the owned namespace either.
  assert.deepEqual(names.filter(name => name.startsWith('tmp') || name.startsWith('.tmp')), [],
    'no tmp residue inside the owned namespace');
  // The parent was supplied, not created recursively: it holds only the one claimed name.
  assert.deepEqual(fs.readdirSync(parent).sort(), [STORE_ROOT_NAME], 'the supplied parent gained only storeRoot');

  evidence.cases.I2 = {
    storeRoot,
    inventory: members,
    names,
    sidecars: [],
    parentInventory: inventory(parent),
    backupSliceNote: 'this file set is the one fact recorded for a future backup slice. No '
      + 'active-database file-copy backup is performed or claimed here.',
  };
  maybeForceFail('I2');
});

// --- N0: precondition inputs refuse BEFORE any filesystem call -----------------------------------

// Every entry is [label, optionsBuilder, expectedReason]. Intent cases and generation/marker cases
// are kept orthogonal: a bad-generation case always carries a WELL-FORMED intent, because the
// contract checks intent first and a mixed case would not discriminate.
function optionsWithout(key) {
  const options = initOptions();
  delete options[key];
  return options;
}

const N0_CASES = [
  // initialGeneration: the only accepted value is the NUMBER 0.
  ['generation-one', () => initOptions({ initialGeneration: 1 }), REASON_PRECONDITION_INVALID],
  ['generation-negative-one', () => initOptions({ initialGeneration: -1 }), REASON_PRECONDITION_INVALID],
  ['generation-string-zero', () => initOptions({ initialGeneration: '0' }), REASON_PRECONDITION_INVALID],
  ['generation-absent', () => optionsWithout('initialGeneration'), REASON_PRECONDITION_INVALID],
  // The marker predicate: lowercase v4 uuid shape plus a canonical toISOString() round-trip.
  ['marker-absent', () => optionsWithout('marker'), REASON_PRECONDITION_INVALID],
  ['marker-not-an-object', () => initOptions({ marker: 'not-an-object' }), REASON_PRECONDITION_INVALID],
  ['marker-uuid-uppercase', () => initOptions({
    marker: { marker_id: '3B1F2C4D-8E6A-4C5B-9D7E-0A1B2C3D4E5F', initialized_at: TEST_MARKER.initialized_at },
  }), REASON_PRECONDITION_INVALID],
  ['marker-uuid-wrong-version-nibble', () => initOptions({
    marker: { marker_id: '3b1f2c4d-8e6a-1c5b-9d7e-0a1b2c3d4e5f', initialized_at: TEST_MARKER.initialized_at },
  }), REASON_PRECONDITION_INVALID],
  ['marker-uuid-wrong-variant-nibble', () => initOptions({
    marker: { marker_id: '3b1f2c4d-8e6a-4c5b-7d7e-0a1b2c3d4e5f', initialized_at: TEST_MARKER.initialized_at },
  }), REASON_PRECONDITION_INVALID],
  ['marker-uuid-empty', () => initOptions({
    marker: { marker_id: '', initialized_at: TEST_MARKER.initialized_at },
  }), REASON_PRECONDITION_INVALID],
  ['marker-uuid-key-missing', () => initOptions({
    marker: { initialized_at: TEST_MARKER.initialized_at },
  }), REASON_PRECONDITION_INVALID],
  ['marker-extra-third-key', () => initOptions({
    marker: { ...TEST_MARKER, extra: 'x' },
  }), REASON_PRECONDITION_INVALID],
  ['marker-date-no-millis', () => initOptions({
    marker: { marker_id: TEST_MARKER.marker_id, initialized_at: '2026-03-04T05:06:07Z' },
  }), REASON_PRECONDITION_INVALID],
  ['marker-date-offset-form', () => initOptions({
    marker: { marker_id: TEST_MARKER.marker_id, initialized_at: '2026-03-04T05:06:07.008+00:00' },
  }), REASON_PRECONDITION_INVALID],
  ['marker-date-space-separator', () => initOptions({
    marker: { marker_id: TEST_MARKER.marker_id, initialized_at: '2026-03-04 05:06:07.008Z' },
  }), REASON_PRECONDITION_INVALID],
  ['marker-date-not-a-date', () => initOptions({
    marker: { marker_id: TEST_MARKER.marker_id, initialized_at: 'not-a-date' },
  }), REASON_PRECONDITION_INVALID],
  ['marker-date-key-missing', () => initOptions({
    marker: { marker_id: TEST_MARKER.marker_id },
  }), REASON_PRECONDITION_INVALID],
  // initIntent: a POSITIVE caller precondition. Absence never means "initialize anyway".
  ['intent-absent', () => optionsWithout('initIntent'), REASON_INTENT_ABSENT],
  ['intent-null', () => initOptions({ initIntent: null }), REASON_INTENT_ABSENT],
  ['intent-not-an-object', () => initOptions({ initIntent: 'declared' }), REASON_INTENT_ABSENT],
  ['intent-array', () => initOptions({ initIntent: [] }), REASON_INTENT_ABSENT],
  ['intent-declaredBy-missing', () => {
    const options = initOptions();
    delete options.initIntent.declaredBy;
    return options;
  }, REASON_INTENT_ABSENT],
  ['intent-requestId-empty', () => {
    const options = initOptions();
    options.initIntent.requestId = '';
    return options;
  }, REASON_INTENT_ABSENT],
  ['intent-authority-not-a-string', () => {
    const options = initOptions();
    options.initIntent.authority = 42;
    return options;
  }, REASON_INTENT_ABSENT],
];

test('N0 precondition inputs refuse by name, before any filesystem call', () => {
  // Positive control for the instrumentation seam: an init that genuinely claims a root MUST be
  // seen calling mkdirSync. Only if it is seen does a zero-call observation mean anything.
  const controlParent = ownedParent('N0-seam-control');
  const controlRoot = path.join(controlParent, STORE_ROOT_NAME);
  const control = withFsCallRecorder(() => initializeExperimentalSqliteStore(controlRoot, initOptions()));
  assert.equal(control.value.ok, true, 'the seam positive control must itself be a successful init');
  const seamObservable = control.calls.some(call => call.fn === 'mkdirSync');
  const controlCallNames = [...new Set(control.calls.map(call => call.fn))].sort();

  const observations = [];
  for (const [label, buildOptions, expectedReason] of N0_CASES) {
    const parent = ownedParent(`N0-${label}`);
    const storeRoot = path.join(parent, STORE_ROOT_NAME);
    const parentBefore = inventory(parent);

    const run = withFsCallRecorder(() => initializeExperimentalSqliteStore(storeRoot, buildOptions()));
    const result = run.value;

    assert.equal(result.ok, false, `${label} must refuse`);
    assert.equal(result.reason, expectedReason, `${label} must refuse with ${expectedReason}`);
    // No claim was attempted, so no errno can have been classified.
    assert.equal(Object.hasOwn(result, 'errno'), false, `${label} carries no errno: no claim was attempted`);

    // After-state observation: the storeRoot does not exist and the supplied parent is untouched.
    assert.equal(fs.existsSync(storeRoot), false, `${label}: storeRoot must not exist afterwards`);
    assert.deepEqual(inventory(parent), parentBefore, `${label}: the supplied parent is unchanged`);
    assert.deepEqual(inventory(parent), [], `${label}: the supplied parent is still empty`);

    // No-call observation, asserted ONLY when the seam was proven observable above.
    if (seamObservable) {
      assert.deepEqual(
        run.calls, [],
        `${label}: the precondition check must run BEFORE any filesystem call `
        + `(observed: ${JSON.stringify(run.calls.map(call => call.fn))})`,
      );
    }

    observations.push({
      label,
      expectedReason,
      reason: result.reason,
      detail: Object.hasOwn(result, 'detail') ? result.detail : null,
      hasErrno: Object.hasOwn(result, 'errno'),
      storeRootExistsAfter: false,
      parentInventoryUnchanged: true,
      fsCallsObserved: run.calls.map(call => call.fn),
      proofKind: seamObservable ? 'no-filesystem-call-observed' : 'after-state-only',
    });
  }

  // A missing or malformed intent must never be turned into "absent, so initialize".
  const intentCases = observations.filter(entry => entry.expectedReason === REASON_INTENT_ABSENT);
  assert.ok(intentCases.length >= 4, 'the intent half of N0 must be exercised');
  for (const entry of intentCases) {
    assert.equal(entry.reason, REASON_INTENT_ABSENT, `${entry.label}: intent refusal is named, never inferred`);
  }

  evidence.cases.N0 = {
    cases: observations,
    instrumentation: {
      kind: 'bounded test-owned recorder over the sync fs entry points of this process',
      entryPointsObserved: control.observedEntryPoints,
      positiveControl: {
        ranSuccessfulInit: true,
        callNamesObserved: controlCallNames,
        sawMkdirSync: seamObservable,
      },
      seamObservable,
      restored: true,
      restorationAsserted: 'fs entry points compared against the pristine references captured at '
        + 'module load, after every recorder use',
      claim: seamObservable
        ? 'NO-CALL PROOF: with the seam proven observable by the positive control, every N0 case was '
          + 'observed making zero filesystem calls, so the precondition check provably ran first.'
        : 'AFTER-STATE OBSERVATION ONLY - explicitly NOT a no-call proof. The positive control did '
          + 'not see the slice call mkdirSync through the recorded module binding (e.g. the binding '
          + 'was captured at load time), so this run shows only that storeRoot does not exist '
          + 'afterwards and the supplied parent is unchanged. A call that was made and failed is '
          + 'NOT excluded by this evidence.',
    },
    scopeNote: 'an absent PARENT is deliberately not an N0 case: it reaches the claim and refuses '
      + `${REASON_ROOT_UNAVAILABLE} with errno ENOENT, recorded under E0`,
  };
  maybeForceFail('N0');
});

// --- N1-N6: six pre-existing states, one identical EEXIST refusal --------------------------------

// Every entry is [caseId, stateKind, whatIsPreExisting]. All six exercise the SAME single EEXIST
// refusal row: the contents of the taken name are deliberately never read, so no case may infer a
// different refusal reason from whatever happens to be on disk.
const PRE_EXISTING_STATES = [
  ['N1', 'valid', 'a complete valid store'],
  ['N2', 'zero', 'a zero-byte db file'],
  ['N3', 'corrupt', 'corrupt bytes (the P2 F7 body)'],
  ['N4', 'orphan-journal', 'an orphan -journal sidecar only'],
  ['N5', 'legacy-json', 'a legacy JSON body (the P2 F8 body)'],
  ['N6', 'root-file', 'storeRoot present as a REGULAR FILE, not a directory'],
];

for (const [caseId, stateKind, what] of PRE_EXISTING_STATES) {
  test(`${caseId} (${stateKind}) refuses with the single EEXIST envelope and changes nothing`, () => {
    const parent = ownedParent(`${caseId}-${stateKind}`);
    const storeRoot = path.join(parent, STORE_ROOT_NAME);

    // states.cjs is a DECLARED fixture writer, confined to its own owned root. It returns a
    // dbPath, never an expected ledger.
    const dbPath = createState(storeRoot, stateKind, { marker: { ...PRIOR_MARKER }, generation: 1 });

    const parentBefore = inventory(parent);
    const snapshotBefore = stateSnapshot(storeRoot);

    const result = initializeExperimentalSqliteStore(storeRoot, initOptions());

    const snapshotAfter = stateSnapshot(storeRoot);
    const parentAfter = inventory(parent);

    assertExactEexistEnvelope(result, `${caseId} (${stateKind})`);
    assert.equal(result.reason, REASON_ROOT_EXISTS, `${caseId}: the name was taken`);
    assert.notEqual(result.reason, REASON_ROOT_UNAVAILABLE,
      `${caseId}: a taken name is EEXIST, never inferred from the on-disk contents`);

    // Nothing deleted, truncated, adopted or repaired to obtain a pass.
    assert.deepEqual(snapshotAfter, snapshotBefore,
      `${caseId}: every pre-existing member keeps its sha256, size and sorted inventory`);
    assert.deepEqual(parentAfter, parentBefore, `${caseId}: the parent inventory is unchanged`);
    assert.equal(fs.existsSync(storeRoot), true, `${caseId}: the pre-existing state still exists`);
    if (snapshotBefore.kind === 'dir') {
      assert.deepEqual(
        snapshotAfter.members.map(m => [m.name, m.size]),
        snapshotBefore.members.map(m => [m.name, m.size]),
        `${caseId}: identical sorted (name,size) inventory`,
      );
    }

    // E0 input: the raw errno vocabulary of this claim failure, observed by the test on the same
    // path, plus the slice's own classifier verdict on that genuine error object.
    const raw = observeRawClaim(storeRoot);
    assert.equal(raw.threw, true, `${caseId}: a non-recursive mkdir on the taken name must throw`);
    assert.equal(raw.code, 'EEXIST', `${caseId}: the observed claim code is EEXIST`);
    assert.equal(raw.classified.classification, 'exists',
      `${caseId}: a taken name classifies as 'exists' (name taken, state unknown)`);
    assert.notEqual(raw.classified.classification, 'owned', `${caseId}: never 'owned'`);
    recordClaimFailure({
      caseId,
      stateKind,
      code: raw.code,
      errno: raw.errno,
      syscall: raw.syscall,
      classification: raw.classified.classification,
      classifierErrno: raw.classified.errno === undefined ? null : raw.classified.errno,
    });

    // The claim failure must not have disturbed the state either.
    assert.deepEqual(stateSnapshot(storeRoot), snapshotBefore, `${caseId}: unchanged after the raw observation too`);

    evidence.cases[caseId] = {
      stateKind,
      what,
      dbPathFromFixture: dbPath === undefined ? null : dbPath,
      result,
      resultPropertyNames: Object.keys(result).sort(),
      snapshotBefore,
      snapshotAfter,
      parentInventoryBefore: parentBefore,
      parentInventoryAfter: parentAfter,
      rawClaim: { code: raw.code, errno: raw.errno, syscall: raw.syscall },
      classification: raw.classified.classification,
      contentsInspected: false,
      interpretation: 'the pre-existing contents are deliberately never opened, read, stat-ed, '
        + 'adopted, repaired, truncated or deleted; the single mkdir claim already failed, so the '
        + 'refusal reason cannot depend on what is on disk',
    };
    maybeForceFail(caseId);
  });
}

// --- N7: inaccessible is not absent ---------------------------------------------------------------

test('N7 an inaccessible claim path is refused as unavailable, never as absence and never as owned', () => {
  const parent = ownedParent('N7');
  const isWindows = process.platform === 'win32';

  let storeRoot;
  let mechanism;
  if (isWindows) {
    // An INVALID OWNED OVER-LENGTH path (> 32767 units). This is a path-validity observation. It
    // makes NO ACL, DACL, permission, confinement or hostile-path claim, does not substitute for
    // the paused Windows ACL/confinement lane, and attempts no privilege expansion or bypass.
    storeRoot = path.join(parent, 'w'.repeat(40000));
    mechanism = 'windows: invalid owned over-length path (> 32767 units)';
    assert.ok(storeRoot.length > 32767, 'the over-length path must exceed 32767 units');
  } else {
    // A parent directory of this suite's own, at mode 0o000. Owned fixture permissions only; the
    // mode is restored by the teardown finaliser before removal.
    const denied = path.join(parent, 'denied');
    fs.mkdirSync(denied);
    storeRoot = path.join(denied, STORE_ROOT_NAME);
    // A 0o000 directory denies nothing to a privileged euid, so the case would be vacuous there.
    // That is asserted as a precondition failure, never skipped.
    assert.notEqual(process.geteuid(), 0,
      'N7 on POSIX requires a non-privileged euid: mode 0o000 does not deny root, and this case is '
      + 'never skipped to avoid that');
    fs.chmodSync(denied, 0o000);
    modesToRestore.push({ dir: denied, mode: 0o700 });
    mechanism = 'posix: owned parent directory at mode 0o000';
  }

  const result = initializeExperimentalSqliteStore(storeRoot, initOptions());

  assert.equal(result.ok, false, 'an inaccessible claim path must refuse');
  assert.equal(result.reason, REASON_ROOT_UNAVAILABLE, 'the refusal is unavailable, plus an errno');
  // Inaccessible must never be reported as absence.
  assert.notEqual(result.reason, REASON_ROOT_EXISTS, 'an inaccessible path is not a taken name');
  assert.equal(String(result.reason).includes('absent'), false, 'inaccessible is never reported as absence');
  assert.equal(String(result.reason).includes('not_initialized'), false,
    'inaccessible never licenses an initialize decision');

  const raw = observeRawClaim(storeRoot);
  assert.equal(raw.threw, true, 'the raw claim on an inaccessible path must throw');
  const classification = raw.classified.classification;
  assert.ok(
    classification === 'inaccessible' || classification === 'unclassified',
    `the classification must be inaccessible or unclassified, observed ${JSON.stringify(classification)}`,
  );
  assert.notEqual(classification, 'owned', "an inaccessible claim is never classified 'owned'");
  assert.notEqual(classification, 'exists', "an inaccessible claim is not a taken name");

  recordClaimFailure({
    caseId: 'N7',
    stateKind: mechanism,
    code: raw.code,
    errno: raw.errno,
    syscall: raw.syscall,
    classification,
    classifierErrno: raw.classified.errno === undefined ? null : raw.classified.errno,
  });

  evidence.cases.N7 = {
    platform: process.platform,
    mechanism,
    euid: typeof process.geteuid === 'function' ? process.geteuid() : null,
    storeRootLength: storeRoot.length,
    result: {
      ok: result.ok,
      reason: result.reason,
      errno: Object.hasOwn(result, 'errno') ? result.errno : null,
      detail: Object.hasOwn(result, 'detail') ? result.detail : null,
    },
    rawClaim: { code: raw.code, errno: raw.errno, syscall: raw.syscall },
    classification,
    claimsNotMade: [
      'no ACL / DACL / permission / confinement / hostile-path claim',
      'not a substitute for the paused Windows ACL/confinement lane',
      'no privilege expansion and no denial bypass was attempted',
      'not a statement that the path was absent',
    ],
    permissionRestoration: isWindows
      ? 'none needed'
      : 'owned fixture directory only, restored to 0o700 by the teardown finaliser before removal',
  };
  maybeForceFail('N7');
});

// --- R1: cooperating multi-process race on owned local throwaway roots -----------------------------

test(
  `R1 race: ${RACE_CHILD_COUNT} cooperating children x ${RACE_ITERATIONS} iterations yield exactly one winner`,
  { timeout: SUITE_RACE_BUDGET_MS },
  async () => {
    const started = Date.now();
    const iterations = [];

    for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
      const parent = ownedParent(`R1-${String(iteration).padStart(2, '0')}`);
      const storeRoot = path.join(parent, STORE_ROOT_NAME);
      const dbPath = path.join(storeRoot, DB_FILENAME);
      const handles = [];

      try {
        for (let child = 0; child < RACE_CHILD_COUNT; child += 1) handles.push(spawnChild({}));

        // Start barrier: every child must be ready before any of them is released.
        await withDeadline(
          Promise.all(handles.map(handle => handle.ready)),
          PER_CHILD_TIMEOUT_MS,
          `R1 iteration ${iteration}: start barrier`,
        );
        assert.equal(
          handles.filter(handle => handle.record.ready).length, RACE_CHILD_COUNT,
          `R1 iteration ${iteration}: every child must reach the barrier`,
        );

        const options = initOptions();
        for (const handle of handles) handle.child.send({ type: 'go', storeRoot, options });

        // Bounded per child. A timeout is a HARD FAILURE, never a retry: a retry could mask a
        // non-unique winner, which is exactly the property R1 exists to measure.
        await withDeadline(
          Promise.all(handles.map(handle => handle.exited)),
          PER_CHILD_TIMEOUT_MS,
          `R1 iteration ${iteration}: children did not all finish`,
        );

        const records = handles.map(handle => handle.record);
        for (const record of records) {
          assert.equal(record.killedByTest, false, `R1 iteration ${iteration}: no child needed killing`);
          assert.equal(record.signal, null, `R1 iteration ${iteration}: children exit cleanly, not by signal`);
          assert.equal(record.exitCode, 0, `R1 iteration ${iteration}: clean exit, stderr: ${record.stderrHead}`);
          assert.notEqual(record.result, null, `R1 iteration ${iteration}: every child reports a result`);
        }

        const winners = records.filter(record => record.result.ok === true);
        const losers = records.filter(record => record.result.ok !== true);
        assert.equal(
          winners.length, 1,
          `R1 iteration ${iteration}: EXACTLY one ok:true winner, observed ${winners.length} - a `
          + 'non-unique winner is a hard failure, never a retry',
        );
        assert.equal(losers.length, RACE_CHILD_COUNT - 1, `R1 iteration ${iteration}: all other children lose`);
        for (const loser of losers) {
          assertExactEexistEnvelope(loser.result, `R1 iteration ${iteration} loser pid ${loser.pid}`);
        }

        // The independent frozen P2 opener then reads generation EXACTLY 1 - which is what shows no
        // second write landed on the won namespace.
        const verified = loadConditionalAdmissionsSqlite(dbPath);
        assert.equal(verified.ok, true, `R1 iteration ${iteration}: the P2 opener must read the won store`);
        assert.equal(
          verified.ledger.generation, EXPECTED_RESULT_GENERATION,
          `R1 iteration ${iteration}: generation must be exactly 1 - no second write landed`,
        );
        assert.deepEqual(verified.ledger, EXPECTED_INIT_LEDGER,
          `R1 iteration ${iteration}: the won store equals the authored ledger`);
        assert.deepEqual(fs.readdirSync(storeRoot).sort(), [DB_FILENAME],
          `R1 iteration ${iteration}: the won namespace holds exactly the store file`);
        assert.deepEqual(sidecars(storeRoot), [], `R1 iteration ${iteration}: no sidecar left behind`);

        iterations.push({
          iteration,
          children: RACE_CHILD_COUNT,
          barrierReached: RACE_CHILD_COUNT,
          winners: winners.length,
          losers: losers.length,
          loserReasons: [...new Set(losers.map(loser => loser.result.reason))],
          loserErrnos: [...new Set(losers.map(loser => loser.result.errno))],
          exitCodes: records.map(record => record.exitCode),
          signals: records.map(record => record.signal),
          generationAfter: verified.ledger.generation,
          inventoryAfter: inventory(storeRoot),
          retriesUsed: 0,
        });
      } finally {
        // This suite kills only the exact handles it created.
        for (const handle of handles) handle.kill();
      }
    }

    const elapsedMs = Date.now() - started;
    assert.equal(iterations.length, RACE_ITERATIONS, 'every iteration must be recorded');
    assert.deepEqual(
      [...new Set(iterations.map(entry => entry.winners))], [1],
      'exactly one winner in EVERY iteration',
    );

    // One loser errno vocabulary entry for E0, from the race rather than from a fixture.
    recordClaimFailure({
      caseId: 'R1',
      stateKind: 'race loser (EEXIST via the losing non-recursive mkdir claim)',
      code: 'EEXIST',
      errno: null,
      syscall: null,
      classification: 'exists',
      classifierErrno: 'EEXIST',
      note: 'observed through the refusal envelope of forked children; the raw error object lives '
        + 'in the child process and is not transported over IPC',
    });

    evidence.cases.R1 = {
      childrenPerIteration: RACE_CHILD_COUNT,
      iterationsRun: RACE_ITERATIONS,
      perChildTimeoutMs: PER_CHILD_TIMEOUT_MS,
      suiteBudgetMs: SUITE_RACE_BUDGET_MS,
      elapsedMs,
      withinBudget: elapsedMs <= SUITE_RACE_BUDGET_MS,
      retriesUsed: 0,
      iterations,
      handleOwnership: 'the test forks and kills its own exact handles; no global process kill and '
        + 'no host process scan is performed',
      scopeNote: 'owned local throwaway roots only. Hostile paths, symlink and TOCTOU attacks, '
        + 'case-alias and path-identity equivalence, remote filesystems and multi-host locking are '
        + 'OUT. The case-insensitive default volumes of the macOS and Windows runners are still '
        + 'required and exercised - only alias equivalence on them is unclaimed.',
    };
    maybeForceFail('R1');
  },
);

// --- K1: deterministic mid-init termination --------------------------------------------------------

const CRASH_POINTS = ['after_claim', 'after_open', 'before_commit'];

test('K1 interruption: a terminated initializer leaves state that a fresh one refuses and preserves',
  { timeout: 120_000 }, async () => {
    const observations = [];

    for (const crashAt of CRASH_POINTS) {
      const parent = ownedParent(`K1-${crashAt}`);
      const storeRoot = path.join(parent, STORE_ROOT_NAME);
      const handle = spawnChild({ P3_CRASH_AT: crashAt });

      let record;
      try {
        await withDeadline(handle.ready, PER_CHILD_TIMEOUT_MS, `K1 ${crashAt}: start barrier`);
        handle.child.send({ type: 'go', storeRoot, options: initOptions() });
        record = await withDeadline(handle.exited, PER_CHILD_TIMEOUT_MS, `K1 ${crashAt}: child did not terminate`);
      } finally {
        handle.kill();
      }

      // The seam terminates the child process at the named point. Process termination is NOT power
      // loss, and no durability or fsync claim is made anywhere in this case.
      assert.equal(record.killedByTest, false, `K1 ${crashAt}: the seam terminates the child, not the test`);
      assert.equal(record.result, null, `K1 ${crashAt}: a terminated initializer reports no result`);
      // The named seam SIGKILLs the initializer at that point. POSIX reports that as
      // signal 'SIGKILL'; Windows has no signals and surfaces the same TerminateProcess as a
      // nonzero exit code with signal null. Both are abnormal termination without a reported
      // result, which is the property K1 measures - so the oracle asserts abnormal termination and
      // RECORDS the platform-specific pair, rather than asserting a Windows signal that does not
      // exist.
      const terminatedAbnormally = record.signal === 'SIGKILL'
        || (record.signal === null && record.exitCode !== 0);
      assert.equal(
        terminatedAbnormally, true,
        `K1 ${crashAt}: the child must be terminated at the named point, observed `
        + `signal=${JSON.stringify(record.signal)} exitCode=${JSON.stringify(record.exitCode)}`,
      );
      assert.notEqual(record.exitCode, 0, `K1 ${crashAt}: a terminated initializer never exits 0`);

      // The leftover inventory, recorded VERBATIM before anything else touches it.
      assert.equal(fs.existsSync(storeRoot), true, `K1 ${crashAt}: the claimed root survives the termination`);
      const leftoverBefore = stateSnapshot(storeRoot);
      const leftoverSidecars = sidecars(storeRoot);

      const result = initializeExperimentalSqliteStore(storeRoot, initOptions());
      const leftoverAfter = stateSnapshot(storeRoot);

      assertExactEexistEnvelope(result, `K1 ${crashAt}`);
      // Nothing is rolled back, completed, replayed or removed by the slice. A hot -journal left by
      // before_commit is preserved byte-identical and refused; recovery and WAL stay out.
      assert.deepEqual(leftoverAfter, leftoverBefore,
        `K1 ${crashAt}: the leftover is preserved byte-identical - nothing rolled back, completed, `
        + 'replayed or removed');
      assert.deepEqual(sidecars(storeRoot), leftoverSidecars,
        `K1 ${crashAt}: any hot -journal sidecar is preserved exactly as found`);

      observations.push({
        crashAt,
        childExitCode: record.exitCode,
        childSignal: record.signal,
        terminationShape: record.signal === 'SIGKILL'
          ? 'posix signal SIGKILL'
          : 'no signal reported (Windows TerminateProcess), nonzero exit code',
        childReportedResult: record.result,
        leftoverInventory: leftoverBefore,
        leftoverSidecars,
        leftoverUnchangedAfterRefusal: true,
        refusal: result,
        stderrHead: record.stderrHead,
      });

      recordClaimFailure({
        caseId: `K1:${crashAt}`,
        stateKind: 'crash leftover (claimed root survives)',
        code: 'EEXIST',
        errno: null,
        syscall: null,
        classification: 'exists',
        classifierErrno: 'EEXIST',
        note: 'observed through the refusal envelope of the in-process fresh initializer',
      });
    }

    assert.deepEqual(observations.map(entry => entry.crashAt), CRASH_POINTS,
      'all three named crash points must be exercised, none skipped');

    evidence.cases.K1 = {
      crashPoints: CRASH_POINTS,
      observations,
      establishes: 'leftover CLASSIFICATION only: a later initializer refuses '
        + `${REASON_ROOT_EXISTS} and removes nothing`,
      doesNotEstablish: [
        'process termination is NOT power loss',
        'no durability, fsync or atomic-rename claim is made',
        'no recovery, rollback or replay of a hot -journal is performed or claimed - it is '
          + 'preserved and refused',
        'WAL and hot sidecar behaviour stays out of this slice',
      ],
    };
    maybeForceFail('K1');
  });

// --- K2: history is preserved -----------------------------------------------------------------------

test('K2 history: a store with a different marker and a higher generation is refused and left untouched', () => {
  const parent = ownedParent('K2');
  const storeRoot = path.join(parent, STORE_ROOT_NAME);

  // A valid pre-existing store carrying BOTH a different marker_id and a generation higher than a
  // prior recorded observation (the initialized generation is 1; this store is at 3).
  const K2_GENERATION = 3;
  const dbPath = createState(storeRoot, 'valid', { marker: { ...K2_MARKER }, generation: K2_GENERATION });
  const storeFile = dbPath === undefined || dbPath === null ? path.join(storeRoot, DB_FILENAME) : dbPath;

  // Read through the independent frozen P2 opener BEFORE the attempt, so "untouched" is measured
  // against an observation rather than against an assumption. This lane authors no ledger literal
  // for K2: the point of the case is preservation, and the before-image IS the expectation.
  const readBefore = loadConditionalAdmissionsSqlite(storeFile);
  assert.equal(readBefore.ok, true, 'the K2 pre-existing store must be readable before the attempt');
  assert.equal(readBefore.ledger.marker.marker_id, K2_MARKER.marker_id, 'the pre-existing marker_id is the K2 one');
  assert.notEqual(readBefore.ledger.marker.marker_id, TEST_MARKER.marker_id,
    'the pre-existing marker_id differs from the one this init would supply');
  assert.equal(readBefore.ledger.generation, K2_GENERATION, 'the pre-existing generation is higher than 1');
  assert.ok(readBefore.ledger.generation > EXPECTED_RESULT_GENERATION, 'higher than a prior recorded observation');

  const snapshotBefore = stateSnapshot(storeRoot);

  const result = initializeExperimentalSqliteStore(storeRoot, initOptions());

  const snapshotAfter = stateSnapshot(storeRoot);
  const readAfter = loadConditionalAdmissionsSqlite(storeFile);

  assertExactEexistEnvelope(result, 'K2');
  assert.deepEqual(snapshotAfter, snapshotBefore, 'K2: the store is byte-identical after the refusal');
  assert.equal(readAfter.ok, true, 'K2: the store is still readable');
  assert.deepEqual(readAfter.ledger, readBefore.ledger, 'K2: the whole ledger is unchanged');
  assert.equal(readAfter.ledger.marker.marker_id, K2_MARKER.marker_id, 'K2: never re-marked');
  assert.notEqual(readAfter.ledger.marker.marker_id, TEST_MARKER.marker_id, 'K2: the init marker was not written');
  assert.equal(readAfter.ledger.generation, K2_GENERATION, 'K2: never reset and never renumbered');

  recordClaimFailure({
    caseId: 'K2',
    stateKind: 'valid store with a different marker and generation 3',
    code: 'EEXIST',
    errno: null,
    syscall: null,
    classification: 'exists',
    classifierErrno: 'EEXIST',
    note: 'observed through the refusal envelope',
  });

  evidence.cases.K2 = {
    preExisting: {
      kind: 'valid',
      markerId: readBefore.ledger.marker.marker_id,
      generation: readBefore.ledger.generation,
      differsFromInitMarker: true,
      higherThanInitialisedGeneration: true,
    },
    result,
    markerIdAfter: readAfter.ledger.marker.marker_id,
    generationAfter: readAfter.ledger.generation,
    snapshotBefore,
    snapshotAfter,
    ledgerUnchanged: true,
    expectationSource: 'the before-image read through the frozen P2 opener; states.cjs supplies no '
      + 'expected ledger and none is imported',
  };
  maybeForceFail('K2');
});

// --- K3: structural ownership, scoped to the runtime leaf --------------------------------------------

test('K3 structural: the runtime leaf is the only writer, has one claim and one Database, and cannot reach states.cjs', () => {
  const rawSource = fs.readFileSync(INIT_SOURCE, 'utf8');
  const source = stripComments(rawSource);

  // Exactly one mkdirSync, and no `recursive` anywhere: recursive:true succeeds on an existing
  // directory and would silently destroy the claim.
  const mkdirCount = countMatches(source, /\bmkdirSync\s*\(/g);
  assert.equal(mkdirCount, 1, `init-exclusive.cjs must contain exactly one mkdirSync call, found ${mkdirCount}`);
  assert.equal(countMatches(source, /\brecursive\b/g), 0, "the claim must never mention `recursive`");
  assert.equal(countMatches(source, /\bmkdir\s*\(/g), 0, 'no async mkdir in the runtime leaf');
  assert.equal(countMatches(source, /\bmkdtempSync\s*\(/g), 0, 'the runtime leaf creates no temp roots');

  // Exactly one Database construction.
  const databaseCount = countMatches(source, /new\s+Database\s*\(/g);
  assert.equal(databaseCount, 1, `init-exclusive.cjs must construct exactly one Database, found ${databaseCount}`);

  // No pre-open probe: a stat-then-open or lstat-then-open gate is not the claim, and is a TOCTOU
  // window. And no destructive or repairing call at all.
  const FORBIDDEN = [
    ['lstat', /\blstat/g],
    ['statSync', /\bstatSync\b/g],
    ['fstat', /\bfstat/g],
    ['access', /\baccess(Sync)?\s*\(/g],
    ['existsSync', /\bexistsSync\b/g],
    ['unlink', /\bunlink/g],
    ['rmSync', /\brmSync\b/g],
    ['rmdir', /\brmdir/g],
    ['truncate', /\btruncate/g],
    ['rename', /\brename/g],
  ];
  const forbiddenFound = [];
  for (const [label, pattern] of FORBIDDEN) {
    const count = countMatches(source, pattern);
    if (count > 0) forbiddenFound.push({ label, count });
  }
  assert.deepEqual(forbiddenFound, [],
    `the runtime leaf must contain no probe, delete, truncate or rename call: ${JSON.stringify(forbiddenFound)}`);

  // No product import: only node builtins and better-sqlite3.
  const initRequires = requireArguments(source);
  const disallowed = initRequires.filter(
    specifier => !(isBuiltin(specifier) || specifier === 'better-sqlite3'),
  );
  assert.deepEqual(disallowed, [],
    `the runtime leaf may import only node builtins and better-sqlite3, found ${JSON.stringify(disallowed)}`);
  for (const specifier of initRequires) {
    assert.equal(/session-store|persistence|\bsrc\b/.test(specifier), false,
      `no product import may appear: ${specifier}`);
  }

  // states.cjs is a DECLARED fixture writer and the evidence emitter is a DECLARED evidence
  // writer. The oracle is therefore scoped to the runtime leaf rather than claiming a single
  // writer overall - and it additionally asserts states.cjs is unreachable from both runtime
  // entry points.
  const initClosure = localRequireClosure(INIT_SOURCE);
  const childClosure = localRequireClosure(RACE_CHILD_SOURCE);
  const reachesStates = names => names.some(name => path.basename(name) === 'states.cjs');
  assert.equal(reachesStates(initClosure.reachable), false, 'states.cjs must be unreachable from init-exclusive.cjs');
  assert.equal(reachesStates(childClosure.reachable), false, 'states.cjs must be unreachable from race-child.cjs');

  // The race child requires the slice, and nothing else local.
  const childRequires = requireArguments(stripComments(fs.readFileSync(RACE_CHILD_SOURCE, 'utf8')));
  const childLocal = childRequires.filter(specifier => specifier.startsWith('.'));
  assert.deepEqual(childLocal.map(specifier => path.basename(specifier)), ['init-exclusive.cjs'],
    'race-child.cjs requires the slice only');

  evidence.cases.K3 = {
    runtimeLeaf: path.basename(INIT_SOURCE),
    mkdirSyncCount: mkdirCount,
    mkdirSyncCountRaw: countMatches(rawSource, /\bmkdirSync\s*\(/g),
    recursiveMentions: 0,
    databaseConstructionCount: databaseCount,
    forbiddenFound,
    forbiddenChecked: FORBIDDEN.map(([label]) => label),
    initRequires,
    childRequires,
    initLocalClosure: initClosure.reachable.map(file => path.basename(file)),
    childLocalClosure: childClosure.reachable.map(file => path.basename(file)),
    statesUnreachableFromRuntime: true,
    commentStripping: 'line and block comments are removed before matching, so a prose mention of '
      + 'a forbidden call is not counted as a call; the raw mkdirSync count is recorded alongside',
    scopeNote: `${path.basename(STATES_SOURCE)} and the evidence emitter DO write, by design: they `
      + 'are declared fixture and evidence writers confined to their own owned roots. This oracle '
      + 'is scoped to the runtime leaf and claims no single writer overall.',
  };
  maybeForceFail('K3');
});

// --- K4: the synthetic close-fault seam, failure-only -----------------------------------------------

test('K4 synthetic close fault: the close failure is never swallowed, and the seam can only ADD a failure',
  { timeout: 120_000 }, async () => {
    // (a) the seam set, on a fresh root: the post-commit close throws synthetically and the
    // failure surfaces by name.
    const faultParent = ownedParent('K4-fault');
    const faultRoot = path.join(faultParent, STORE_ROOT_NAME);
    const faultDb = path.join(faultRoot, DB_FILENAME);
    const faultHandle = spawnChild({ P3_CLOSE_FAULT: '1' });
    let faultRecord;
    try {
      await withDeadline(faultHandle.ready, PER_CHILD_TIMEOUT_MS, 'K4 fault: start barrier');
      faultHandle.child.send({ type: 'go', storeRoot: faultRoot, options: initOptions() });
      faultRecord = await withDeadline(faultHandle.exited, PER_CHILD_TIMEOUT_MS, 'K4 fault: child did not finish');
    } finally {
      faultHandle.kill();
    }

    assert.notEqual(faultRecord.result, null, 'K4: the child must report a result, not die');
    assert.equal(faultRecord.result.ok, false, 'K4: a close failure is a failure');
    assert.equal(faultRecord.result.reason, REASON_CLOSE_FAILED,
      'K4: the close failure is reported by name and NEVER swallowed');

    // The store is left byte-identical: the close fault is POST-COMMIT, so the committed store
    // stands and nothing deletes or truncates it on the failure path.
    assert.equal(fs.existsSync(faultDb), true, 'K4: the committed store is not removed on the close failure');
    assert.deepEqual(fs.readdirSync(faultRoot).sort(), [DB_FILENAME], 'K4: the won namespace is intact');
    assert.deepEqual(sidecars(faultRoot), [], 'K4: no sidecar residue after the synthetic close failure');
    const faultShaBefore = sha256File(faultDb);
    const faultVerified = loadConditionalAdmissionsSqlite(faultDb);
    const faultShaAfter = sha256File(faultDb);
    assert.equal(faultVerified.ok, true, 'K4: the committed store is readable by the frozen P2 opener');
    assert.equal(faultVerified.ledger.generation, EXPECTED_RESULT_GENERATION, 'K4: generation 1 was committed');
    assert.deepEqual(faultVerified.ledger, EXPECTED_INIT_LEDGER, 'K4: the committed ledger is the authored one');
    assert.equal(faultShaAfter, faultShaBefore, 'K4: byte-identical across the verification read (observation)');

    // (b) the seam UNSET on an identical fresh root: inert.
    const inertParent = ownedParent('K4-inert');
    const inertRoot = path.join(inertParent, STORE_ROOT_NAME);
    const inertHandle = spawnChild({});
    let inertRecord;
    try {
      await withDeadline(inertHandle.ready, PER_CHILD_TIMEOUT_MS, 'K4 inert: start barrier');
      inertHandle.child.send({ type: 'go', storeRoot: inertRoot, options: initOptions() });
      inertRecord = await withDeadline(inertHandle.exited, PER_CHILD_TIMEOUT_MS, 'K4 inert: child did not finish');
    } finally {
      inertHandle.kill();
    }
    assert.notEqual(inertRecord.result, null, 'K4: the control child must report a result');
    assert.equal(inertRecord.result.ok, true, 'K4: with the seam unset the very same call succeeds - the seam is inert');
    assert.equal(inertRecord.result.ledger.generation, EXPECTED_RESULT_GENERATION, 'K4 control: generation 1');

    // (c) the seam must not MASK an earlier error: with a pre-existing state the result is still
    // the EEXIST envelope, never a close failure.
    const maskParent = ownedParent('K4-mask');
    const maskRoot = path.join(maskParent, STORE_ROOT_NAME);
    createState(maskRoot, 'valid', { marker: { ...PRIOR_MARKER }, generation: 2 });
    const maskSnapshotBefore = stateSnapshot(maskRoot);
    const maskHandle = spawnChild({ P3_CLOSE_FAULT: '1' });
    let maskRecord;
    try {
      await withDeadline(maskHandle.ready, PER_CHILD_TIMEOUT_MS, 'K4 mask: start barrier');
      maskHandle.child.send({ type: 'go', storeRoot: maskRoot, options: initOptions() });
      maskRecord = await withDeadline(maskHandle.exited, PER_CHILD_TIMEOUT_MS, 'K4 mask: child did not finish');
    } finally {
      maskHandle.kill();
    }
    assert.notEqual(maskRecord.result, null, 'K4 mask: the child must report a result');
    assertExactEexistEnvelope(maskRecord.result, 'K4 mask control');
    assert.notEqual(maskRecord.result.reason, REASON_CLOSE_FAILED,
      'K4: the close-fault seam must never mask or replace an earlier refusal');
    assert.deepEqual(stateSnapshot(maskRoot), maskSnapshotBefore,
      'K4 mask: the pre-existing state is untouched');

    evidence.cases.K4 = {
      seam: 'P3_CLOSE_FAULT=1',
      synthetic: true,
      faultRun: {
        result: faultRecord.result,
        reason: faultRecord.result.reason,
        childExitCode: faultRecord.exitCode,
        childSignal: faultRecord.signal,
        storeInventory: inventory(faultRoot),
        committedGeneration: faultVerified.ledger.generation,
        sha256BeforeVerify: faultShaBefore,
        sha256AfterVerify: faultShaAfter,
      },
      inertWhenUnset: {
        sameCallWithoutTheSeam: 'ok:true',
        generation: inertRecord.result.ledger.generation,
      },
      cannotMaskEarlierErrors: {
        preExisting: 'valid store, generation 2',
        result: maskRecord.result,
        reason: maskRecord.result.reason,
        preExistingUnchanged: true,
      },
      establishes: 'reachability of the close-failure branch ONLY: with the named seam set, a '
        + `post-commit close failure surfaces as ${REASON_CLOSE_FAILED} instead of being swallowed`,
      doesNotEstablish: [
        'this is a SYNTHETIC induced fault and is NEVER a measured native close failure',
        'it bypasses no real handle close and suppresses no other outcome',
        'the P2 opener close-in-finally swallow branch remains UNMEASURED in the P2 lane, which is '
          + 'left unmodified',
      ],
    };
    maybeForceFail('K4');
  });

// --- E0: errno vocabulary, informative either way ----------------------------------------------------

// Declared after every claim-failure case so that it aggregates what actually ran. It also owns
// the separately-tested MISSING PARENT case, which is deliberately NOT an N0 case: it reaches the
// claim and refuses unavailable with errno ENOENT.
test('E0 errno vocabulary: every claim failure is recorded per OS, an absent errno is a measured unknown', () => {
  // Missing parent: the single non-recursive claim surfaces ENOENT and is refused, never repaired.
  // No parent is created, recursively or otherwise.
  const parent = ownedParent('E0-missing-parent');
  const missingParent = path.join(parent, 'absent-parent');
  const storeRoot = path.join(missingParent, STORE_ROOT_NAME);

  const result = initializeExperimentalSqliteStore(storeRoot, initOptions());

  assert.equal(result.ok, false, 'a missing parent must refuse');
  assert.equal(result.reason, REASON_ROOT_UNAVAILABLE, 'a missing parent is unavailable, not a taken name');
  assert.equal(result.errno, 'ENOENT', 'the missing-parent errno is ENOENT');
  assert.equal(fs.existsSync(missingParent), false, 'the parent must NOT be created, recursively or otherwise');
  assert.equal(fs.existsSync(storeRoot), false, 'no storeRoot may be created below an absent parent');
  assert.deepEqual(inventory(parent), [], 'the owned grandparent is untouched');

  const rawMissing = observeRawClaim(storeRoot);
  assert.equal(rawMissing.threw, true, 'the raw claim below an absent parent must throw');
  assert.equal(rawMissing.code, 'ENOENT', 'the observed code is ENOENT');
  assert.notEqual(rawMissing.classified.classification, 'owned', "an ENOENT claim is never 'owned'");
  assert.notEqual(rawMissing.classified.classification, 'exists', "an ENOENT claim is not a taken name");
  recordClaimFailure({
    caseId: 'E0:missing-parent',
    stateKind: 'absent parent directory',
    code: rawMissing.code,
    errno: rawMissing.errno,
    syscall: rawMissing.syscall,
    classification: rawMissing.classified.classification,
    classifierErrno: rawMissing.classified.errno === undefined ? null : rawMissing.classified.errno,
  });

  // The classifier on an error carrying NO errno: an unclassified failure still refuses safely -
  // an unknown classification degrades the reported reason, it never blocks refusal.
  const noErrno = classifyClaimFailure(new Error('synthetic error with no errno'));
  assert.equal(noErrno.classification, 'unclassified', 'an error with no errno classifies as unclassified');
  assert.notEqual(noErrno.classification, 'owned', 'never owned');

  // Missing / inaccessible / ambiguous stay DISTINCT.
  const classifications = [...new Set(errnoVocabulary.map(entry => entry.classification))].sort();
  assert.ok(errnoVocabulary.length >= 8, `E0 must aggregate every claim failure, got ${errnoVocabulary.length}`);
  assert.equal(classifications.includes('owned'), false, 'no claim FAILURE may ever classify as owned');
  for (const entry of errnoVocabulary) {
    // An absent errno is a measured unknown, not a failure; a classification that disagrees with
    // the observation IS a hard failure.
    if (entry.code === 'EEXIST') {
      assert.equal(entry.classification, 'exists', `${entry.caseId}: EEXIST must classify as exists`);
    } else if (entry.code === null) {
      assert.equal(entry.classification, 'unclassified', `${entry.caseId}: no errno means unclassified`);
    } else {
      assert.notEqual(entry.classification, 'exists',
        `${entry.caseId}: only EEXIST may classify as exists (observed ${entry.code})`);
    }
  }

  evidence.cases.E0 = {
    platform: process.platform,
    arch: process.arch,
    vocabulary: errnoVocabulary,
    classificationsObserved: classifications,
    missingParent: {
      refusal: result,
      parentCreated: false,
      storeRootCreated: false,
      rawClaim: { code: rawMissing.code, errno: rawMissing.errno, syscall: rawMissing.syscall },
      classification: rawMissing.classified.classification,
      note: 'deliberately NOT an N0 case: it reaches the claim and refuses with an errno, and is '
        + 'refused rather than repaired - no parent is created, recursively or otherwise',
    },
    noErrnoClassifier: {
      input: 'a plain Error carrying no errno',
      classification: noErrno.classification,
      errno: noErrno.errno === undefined ? null : noErrno.errno,
      note: 'an unclassified failure still refuses safely: an unknown classification degrades the '
        + 'reported reason, it never blocks refusal',
    },
    absentErrnoPolicy: 'an absent errno is recorded as a measured UNKNOWN, never as a failure; a '
      + 'classification that disagrees with the observation is a hard failure',
  };
  maybeForceFail('E0');
});

// --- T: teardown, derived from what actually ran -------------------------------------------------------

test('T teardown: the recorded case-id list is derived from execution', () => {
  const recorded = Object.keys(evidence.cases).sort();
  assert.deepEqual(recorded, EXPECTED_CASE_IDS, 'every expected case must have recorded its own evidence');
  evidence.executedCaseIds = recorded;
  evidence.executedCaseCount = recorded.length;
});

// --- exit finaliser: cleanup + evidence, never altering the exit code -------------------------------------

// Runs from process.on('exit') rather than from an after() hook so that it survives a failing
// assertion. It must NOT change process.exitCode: a nonzero exit is never converted to success,
// and cleanup being recorded on a failing run never turns that failure into a zero.
let finalized = false;

function finalize() {
  if (finalized) return;
  finalized = true;

  // Only the exact child handles this suite created, and only if any survived.
  const orphanedChildren = [];
  for (const handle of liveChildren) {
    orphanedChildren.push(handle.record.pid);
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  // Restore OWNED fixture permissions so the roots can be removed. Owned directories under
  // WORK_DIR only; never a privileged operation.
  const restoredModes = [];
  const failedToRestore = [];
  for (const { dir, mode } of modesToRestore) {
    try {
      fs.chmodSync(dir, mode);
      restoredModes.push(dir);
    } catch (error) {
      failedToRestore.push({ dir, code: error && error.code });
    }
  }

  const removed = [];
  const failedToRemove = [];
  for (const root of createdRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      removed.push(root);
    } catch (error) {
      failedToRemove.push({ root, code: error && error.code });
    }
  }

  // Any .tmp-* root still present under WORK_DIR after cleanup is a leak, and is recorded as one.
  let residual = [];
  try {
    residual = fs.readdirSync(WORK_DIR).filter(name => name.startsWith(TMP_PREFIX)).sort();
  } catch {
    residual = [];
  }

  evidence.cleanup = {
    finalizedBy: "process.on('exit')",
    rootsCreated: createdRoots.length,
    rootsRemoved: removed.length,
    failedToRemove,
    residualTmpRootsUnderWorkDir: residual,
    clean: failedToRemove.length === 0 && residual.length === 0,
    tmpRootPrefix: TMP_PREFIX,
    orphanedChildrenKilled: orphanedChildren,
    permissionsRestored: restoredModes,
    permissionRestoreFailures: failedToRestore,
    note: 'cleanup is RECORDED on a failing run and never converts a failure into a zero exit',
  };
  evidence.generatedAt = new Date().toISOString();
  evidence.exitCodeObserved = process.exitCode === undefined ? 0 : process.exitCode;

  const payload = JSON.stringify(evidence, null, 2) + '\n';
  const targets = [path.join(WORK_DIR, 'evidence.json')];
  if (EVIDENCE_DIR !== null && path.resolve(EVIDENCE_DIR) !== path.resolve(WORK_DIR)) {
    targets.push(path.join(EVIDENCE_DIR, 'evidence.json'));
  }
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, payload);
    } catch (error) {
      // Reported on stderr only. Writing evidence must never mask or alter the run's verdict.
      process.stderr.write(`evidence write failed (${target}): ${error && error.message}\n`);
    }
  }
}

process.on('exit', finalize);
