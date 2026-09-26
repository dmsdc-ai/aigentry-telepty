'use strict';

// P2 independent oracle suite for the experimental read-only SQLite opener.
//
// Authoring lane: st1170ba-tester. This file is written by a DIFFERENT session from the one
// that wrote open-existing.cjs / fixture.cjs (C6 role independence). Every expected value below
// — in particular the F1 and F10 ledger literals — is authored here from the prose of
// P2-CONTRACT.md as amended by P2-CORRECTIONS.md and from FIXTURE-API.md. Nothing expected is
// imported from fixture.cjs or from open-existing.cjs: fixture.cjs exports only buildFixture /
// FIXTURE_IDS / DB_FILENAME, and the opener exports only its one function, so a green C2/C11
// cannot mean "the generator agreed with itself".
//
// Corrections win on every contradictory phrase in the older contract prose. In particular:
//   - C1: a missing path yields unavailable/open_failed_unknown, NEVER
//     conditional_store_not_initialized, and only the PRIMARY code SQLITE_CANTOPEN is asserted
//     (no extended result code, no errno, no message — none of those were measured).
//   - C3: byte identity is an observation, not a zero-write filesystem proof.
//   - C7/C11: reserved-looking row keys are ordinary store data.
//
// This suite asserts codes and values, never messages. There are no skips and no
// continue-on-error. A failing oracle is reported, never patched around, and the source under
// test is never modified from here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const Database = require('better-sqlite3');
const { loadConditionalAdmissionsSqlite } = require('./open-existing.cjs');
const { buildFixture, DB_FILENAME } = require('./fixture.cjs');

// --- environment / evidence contract ------------------------------------------------------

function envOrNull(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

// Owned temp roots live under P2_WORK_DIR. When the variable is absent we create our own root
// under os.tmpdir() rather than writing anywhere near the source tree or $HOME.
const WORK_DIR_FROM_ENV = envOrNull('P2_WORK_DIR');
const WORK_DIR = WORK_DIR_FROM_ENV || fs.mkdtempSync(path.join(os.tmpdir(), 'p2-work-'));
const EVIDENCE_DIR = envOrNull('P2_EVIDENCE_DIR');
const FORCE_FAIL = envOrNull('P2_FORCE_FAIL');

// The complete set of case ids this suite is expected to execute. T compares this against the
// ids actually recorded during the run; it is never a hardcoded pass total.
const EXPECTED_CASE_IDS = [
  'P0',
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11',
  'X1', 'X2', 'X3',
].sort();

const evidence = {
  schema: 'st1170ba-p2-open-evidence/1',
  // Identity is read from the actual environment or recorded as null. It is never backfilled
  // from a prior worker attempt.
  gitHead: envOrNull('P2_GIT_HEAD'),
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
  },
  workDirFromEnv: WORK_DIR_FROM_ENV !== null,
  workDir: WORK_DIR,
  forceFailHook: FORCE_FAIL,
  cases: {},
  notes: [],
};

// P2_FORCE_FAIL may only ADD a bounded intentional failure. It is invoked at the END of a case,
// after that case's evidence has been recorded, so it can never convert a real pass into a
// silent skip or suppress a real failure.
function maybeForceFail(caseId) {
  if (FORCE_FAIL === caseId) {
    assert.fail(
      `P2_FORCE_FAIL=${caseId}: deliberate bounded failure injected to demonstrate that temp-root `
      + 'cleanup and evidence persistence survive a failing assertion without altering the exit code',
    );
  }
}

// --- owned temp roots ----------------------------------------------------------------------

const createdRoots = [];

// One directory per fixture: every fixture uses the same filename, so directory inventories are
// only meaningful when each fixture owns its own root.
function ownedRoot(label) {
  const root = fs.mkdtempSync(path.join(WORK_DIR, `.tmp-${label}-`));
  createdRoots.push(root);
  return root;
}

// --- filesystem observation helpers ----------------------------------------------------------

// Sorted (name, size) inventory. Used to show that no file and no -journal/-wal/-shm sidecar
// appeared or disappeared across an opener call.
function inventory(dir) {
  return fs.readdirSync(dir)
    .map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'];

function sidecars(dir) {
  return fs.readdirSync(dir).filter(name => SIDECAR_SUFFIXES.some(sfx => name.endsWith(sfx))).sort();
}

// --- expectations authored here, independently of the code under test -------------------------

// P2-CONTRACT §5: the ledger has EXACTLY these seven keys, in this order.
const EXPECTED_LEDGER_KEYS = [
  'schema_version', 'generation', 'marker', 'bindings', 'admissions', 'tombstones', 'fenced_sessions',
];

// Transcribed from FIXTURE-API.md §3/§5 as this suite's own expectation of what F1 must
// reconstruct to. store_meta is TEXT on disk; schema_version and generation surface as NUMBERS.
const EXPECTED_F1_LEDGER = {
  schema_version: 1,
  generation: 7,
  marker: {
    marker_id: '9f8b7a6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c',
    initialized_at: '2026-01-02T03:04:05.006Z',
  },
  bindings: {
    'binding-alpha': { session_id: 'sess-alpha', manifest_id: 'mf-alpha', generation: 1 },
    'binding-beta': { session_id: 'sess-beta', manifest_id: 'mf-beta', generation: 2 },
  },
  admissions: { 'admission-one': { task: '1170', attempt: 1, granted: true } },
  tombstones: { 'tombstone-one': { revoked_at: '2026-01-02T03:04:05.006Z', reason: 'superseded' } },
  fenced_sessions: { 'fenced-one': { fenced_at: '2026-01-02T03:04:05.006Z', generation: 7 } },
};

// Every enumerated refusal is a THREE-property object: `error` is carried only by the catch-all
// "any other throw" mapping, so deep equality here also proves no stray `error` leaked out.
function refusal(detail) {
  return { ok: false, reason: 'conditional_store_unavailable', detail };
}

// F10's expected bindings cannot be written as an object literal: the literal `__proto__:` key
// would hit the Object.prototype setter and silently fail to create an own property. It is built
// with defineProperty for exactly the reason C7 gives for the opener itself.
function expectedF10Bindings() {
  const bindings = {};
  const define = (key, value) => Object.defineProperty(bindings, key, {
    value, writable: true, enumerable: true, configurable: true,
  });
  define('binding-alpha', { session_id: 'sess-alpha', manifest_id: 'mf-alpha', generation: 1 });
  define('binding-beta', { session_id: 'sess-beta', manifest_id: 'mf-beta', generation: 2 });
  define('__proto__', { kind: 'proto-key', polluted: false });
  define('constructor', { kind: 'constructor-key', polluted: false });
  define('prototype', { kind: 'prototype-key', polluted: false });
  return bindings;
}

// --- test-owned store builder for the extra controls (X1/X2) ----------------------------------

// fixture.cjs covers F1-F10 only. The dispatch additionally requires empty / missing /
// fractional / unsafe generation controls and date-marker controls. Those stores are built here,
// in the test lane, with the same §3 schema — the coder's four leaves are not touched.
const SCHEMA_SQL = `
CREATE TABLE store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE bindings        (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE admissions      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE tombstones      (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE TABLE fenced_sessions (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

const BASE_META = {
  schema_version: '1',
  generation: '7',
  marker_id: '9f8b7a6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c',
  initialized_at: '2026-01-02T03:04:05.006Z',
};

// `metaOverrides` values of `undefined` mean "omit this store_meta row entirely", which is how
// the missing-generation and missing-marker-row controls are expressed.
function buildControlStore(label, metaOverrides) {
  const root = ownedRoot(label);
  const dbPath = path.join(root, DB_FILENAME);
  const meta = { ...BASE_META, ...metaOverrides };
  // journal_mode is left at the SQLite default (delete) and the handle is closed in a finally,
  // so the opener never sees a hot -wal/-shm sidecar, exactly as the F1-F10 fixtures guarantee.
  const db = new Database(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    const insertMeta = db.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined) insertMeta.run(key, value);
    }
    db.prepare('INSERT INTO bindings (key, value) VALUES (?, ?)')
      .run('binding-alpha', '{"session_id":"sess-alpha","manifest_id":"mf-alpha","generation":1}');
    db.prepare('INSERT INTO admissions (key, value) VALUES (?, ?)')
      .run('admission-one', '{"task":"1170","attempt":1,"granted":true}');
    db.prepare('INSERT INTO tombstones (key, value) VALUES (?, ?)')
      .run('tombstone-one', '{"revoked_at":"2026-01-02T03:04:05.006Z","reason":"superseded"}');
    db.prepare('INSERT INTO fenced_sessions (key, value) VALUES (?, ?)')
      .run('fenced-one', '{"fenced_at":"2026-01-02T03:04:05.006Z","generation":7}');
  } finally {
    db.close();
  }
  return dbPath;
}

// --- P0: preconditions on the pinned native stack ---------------------------------------------

// Strips a Windows extended-length prefix (\\?\ or //?/) before normalising separators and case,
// per P2-CONTRACT §6 P0. Without this step a mapped Windows path can never equal the selector's
// ordinary path, which is exactly how the prior report lost the mapping.
function normalizeNativePath(value) {
  return String(value)
    .replace(/^\\\\\?\\/, '')
    .replace(/^\/\/\?\//, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

// The runtime's ACTUAL loaded native object, observed separately from the file the selector
// chose. These are two different questions and the evidence keeps them apart.
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

test('P0 pinned native stack: versions, selected prebuild, and actual runtime mapping', () => {
  const pkg = require('better-sqlite3/package.json');
  assert.equal(pkg.version, '13.0.3', 'better-sqlite3 must be the pinned 13.0.3');

  // C5 requires the resolved node-addon-api to stay at the verified 8.9.2, never a fresh ^8 pick.
  const addon = require('node-addon-api/package.json');
  assert.equal(addon.version, '8.9.2', 'node-addon-api must be the verified 8.9.2');

  // lib/binding.js is not listed in the package "exports" map, so it is loaded by absolute path
  // resolved from the one subpath that IS exported.
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
    // A mapping that IS observable and disagrees with the selection is a hard failure, never a
    // silent unknown.
    assert.equal(
      selectedMatchesMapped, true,
      'the observed mapped native binary must agree with the selected prebuild',
    );
  }

  evidence.cases.P0 = {
    betterSqlite3Version: pkg.version,
    nodeAddonApiVersion: addon.version,
    sqliteVersion,
    selectedPrebuild: selected,
    selectedPrebuildExists: true,
    selectedPrebuildNote: 'filename selection only — NOT evidence that this file was the one mapped',
    mappedNativeBinary: mapped,
    selectedMatchesMapped,
    windowsPrefixNormalization: 'applied to both sides before comparison (\\\\?\\ and //?/ stripped)',
  };
  maybeForceFail('P0');
});

// --- C1: a missing path refuses and creates nothing --------------------------------------------

test('C1 (F9) missing-path-refuses-without-creating', () => {
  const root = ownedRoot('C1');
  const dbPath = buildFixture('F9', root);

  const before = inventory(root);
  const result = loadConditionalAdmissionsSqlite(dbPath);
  const after = inventory(root);

  // C1 explicitly replaces the old conditional_store_not_initialized mapping: a generic CANTOPEN
  // is NOT positive proof of absence, so the opener must report unknown-open-failure instead.
  assert.deepEqual(result, refusal('open_failed_unknown'));
  assert.equal(result.reason === 'conditional_store_not_initialized', false,
    'the opener must never emit conditional_store_not_initialized (read downstream as "initialize now")');
  assert.equal(Object.hasOwn(result, 'error'), false, 'an enumerated refusal carries no error property');

  assert.equal(fs.existsSync(dbPath), false, 'no store file may be created at the missing path');
  assert.deepEqual(after, before, 'the directory inventory must be unchanged');
  assert.deepEqual(after, [], 'the owned directory must still be empty');
  assert.deepEqual(sidecars(root), [], 'no -journal/-wal/-shm sidecar may be created');

  // The native no-CREATE mechanism itself, exercised directly with the §4 options. Only the
  // PRIMARY code is asserted: no extended result code and no errno were measured on any runner,
  // and the message is never asserted.
  let openError = null;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.close();
  } catch (error) {
    openError = error;
  }
  assert.notEqual(openError, null, 'opening a missing path with readonly+fileMustExist must throw');
  assert.equal(openError.code, 'SQLITE_CANTOPEN', 'the primary code must be SQLITE_CANTOPEN');
  assert.equal(fs.existsSync(dbPath), false, 'the direct native open must also create nothing');
  assert.deepEqual(inventory(root), [], 'the direct native open must leave the directory empty');

  evidence.cases.C1 = {
    name: 'missing-path-refuses-without-creating',
    result,
    fileExistsAfter: false,
    inventoryBefore: before,
    inventoryAfter: after,
    sidecars: [],
    nativeOpenPrimaryCode: openError.code,
    interpretation: 'proves no creation and a refusal — NOT that the path was absent rather than '
      + 'inaccessible; licenses no initialize decision',
    extendedCodeMeasured: false,
  };
  maybeForceFail('C1');
});

// --- C2: the valid store loads exactly ----------------------------------------------------------

test('C2 (F1) a valid store reconstructs to the independently authored ledger', () => {
  const root = ownedRoot('C2');
  const dbPath = buildFixture('F1', root);

  const result = loadConditionalAdmissionsSqlite(dbPath);
  assert.equal(result.ok, true, 'a valid store must load');

  const { ledger } = result;
  assert.deepEqual(Object.keys(ledger), EXPECTED_LEDGER_KEYS, 'the 7 ledger keys, in contract order');
  assert.deepEqual(ledger, EXPECTED_F1_LEDGER, 'the ledger must equal the independently authored literal');
  assert.equal(Number.isSafeInteger(ledger.generation), true, 'generation must be a safe integer');
  assert.ok(ledger.generation >= 1, 'generation must be >= 1');
  assert.equal(typeof ledger.schema_version, 'number', 'schema_version surfaces as a number');

  // Prototype identity matters: the product's JSON store produces Object.prototype-backed maps,
  // and C7 forbids an Object.create(null) map precisely because it would not match.
  assert.equal(Object.getPrototypeOf(ledger), Object.prototype);
  for (const section of ['bindings', 'admissions', 'tombstones', 'fenced_sessions']) {
    assert.equal(Object.getPrototypeOf(ledger[section]), Object.prototype, `${section} prototype`);
  }
  assert.deepEqual(Object.keys(ledger.marker), ['marker_id', 'initialized_at'], 'marker has exactly 2 keys, in order');

  evidence.cases.C2 = {
    ok: true,
    ledgerKeys: Object.keys(ledger),
    generation: ledger.generation,
    schemaVersion: ledger.schema_version,
    bindingKeys: Object.keys(ledger.bindings),
    expectationSource: 'authored in the test lane from FIXTURE-API.md prose; nothing imported from fixture.cjs',
  };
  maybeForceFail('C2');
});

// --- C3-C7: the enumerated semantic refusals ------------------------------------------------------

// Each entry is [caseId, fixtureId, expectedDetail, whatTheFixtureBreaks].
const SEMANTIC_REFUSALS = [
  ['C3', 'F2', 'schema_version=2', 'schema_version is the raw stored text 2, not 1'],
  ['C4', 'F3', 'invalid_store_shape', 'generation is 0, below the >= 1 floor'],
  ['C5', 'F4', 'invalid_store_shape', 'the bindings table was dropped (missing table -> SQLITE_ERROR)'],
  ['C6', 'F5', 'marker_invalid', 'marker_id is not a v4 uuid'],
  ['C7', 'F6', 'invalid_store_shape', 'an admissions row value is not JSON — the bad row is named, never skipped'],
];

for (const [caseId, fixtureId, expectedDetail, broken] of SEMANTIC_REFUSALS) {
  test(`${caseId} (${fixtureId}) refuses with detail ${expectedDetail}`, () => {
    const root = ownedRoot(caseId);
    const dbPath = buildFixture(fixtureId, root);

    const shaBefore = sha256(dbPath);
    const before = inventory(root);
    const result = loadConditionalAdmissionsSqlite(dbPath);
    const shaAfter = sha256(dbPath);
    const after = inventory(root);

    assert.deepEqual(result, refusal(expectedDetail));
    assert.equal(Object.hasOwn(result, 'error'), false, 'an enumerated refusal carries no error property');
    assert.deepEqual(after, before, 'the directory inventory must be unchanged');
    assert.deepEqual(sidecars(root), [], 'no sidecar may appear');
    assert.equal(shaAfter, shaBefore, 'the fixture bytes must be unchanged (observation, not a no-write proof)');

    evidence.cases[caseId] = {
      fixture: fixtureId,
      broken,
      result,
      sha256Before: shaBefore,
      sha256After: shaAfter,
      inventoryBefore: before,
      inventoryAfter: after,
      byteIdentityLabel: 'byte-identity observation only — NOT a zero-write proof',
    };
    maybeForceFail(caseId);
  });
}

// --- C8 / C9: non-store bytes are refused without modification --------------------------------------

const UNPARSEABLE_FIXTURES = [
  ['C8', 'F7', 'corrupt bytes: SQLite magic header followed by 4096 deterministic non-random bytes'],
  ['C9', 'F8', 'a legacy JSON conditional-admissions body — the opener must not read, interpret or migrate it'],
];

for (const [caseId, fixtureId, what] of UNPARSEABLE_FIXTURES) {
  test(`${caseId} (${fixtureId}) refuses as unparseable without changing bytes`, () => {
    const root = ownedRoot(caseId);
    const dbPath = buildFixture(fixtureId, root);

    const shaBefore = sha256(dbPath);
    const sizeBefore = fs.statSync(dbPath).size;
    const before = inventory(root);

    const result = loadConditionalAdmissionsSqlite(dbPath);

    const shaAfter = sha256(dbPath);
    const sizeAfter = fs.statSync(dbPath).size;
    const after = inventory(root);

    assert.deepEqual(result, refusal('unparseable'));
    assert.equal(Object.hasOwn(result, 'error'), false, 'an enumerated refusal carries no error property');
    assert.equal(shaAfter, shaBefore, 'the file sha256 must be identical after the failed attempt');
    assert.equal(sizeAfter, sizeBefore, 'the file size must be identical after the failed attempt');
    assert.deepEqual(after, before, 'the directory inventory must be unchanged (no side files)');
    assert.deepEqual(sidecars(root), [], 'no sidecar may appear');

    evidence.cases[caseId] = {
      fixture: fixtureId,
      what,
      result,
      sha256Before: shaBefore,
      sha256After: shaAfter,
      sizeBefore,
      sizeAfter,
      inventoryBefore: before,
      inventoryAfter: after,
    };
    maybeForceFail(caseId);
  });
}

// --- C10: scoped mutation refusal and byte-identity controls -------------------------------------

test('C10 scoped SQL-mutation refusal and byte-identity across a successful read', () => {
  const root = ownedRoot('C10');
  const dbPath = buildFixture('F1', root);

  // (a) byte identity across the SUCCESSFUL read of a fully closed journal_mode=delete fixture.
  const shaBeforeRead = sha256(dbPath);
  const inventoryBeforeRead = inventory(root);
  const result = loadConditionalAdmissionsSqlite(dbPath);
  const shaAfterRead = sha256(dbPath);
  const inventoryAfterRead = inventory(root);

  assert.equal(result.ok, true, 'the F1 read must succeed for this control to mean anything');
  assert.equal(shaAfterRead, shaBeforeRead, 'sha256 identical across the successful read');
  assert.deepEqual(inventoryAfterRead, inventoryBeforeRead, 'inventory identical across the successful read');
  assert.deepEqual(sidecars(root), [], 'no sidecar may appear across the successful read');

  // (b) a SQL mutation through a handle opened with the §4 options must be refused.
  let mutationError = null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.exec("INSERT INTO bindings (key, value) VALUES ('injected', '{}')");
  } catch (error) {
    mutationError = error;
  } finally {
    db.close();
  }
  const shaAfterRefusedWrite = sha256(dbPath);

  assert.notEqual(mutationError, null, 'a write through a readonly handle must throw');
  assert.equal(mutationError.code, 'SQLITE_READONLY', 'the primary code must be SQLITE_READONLY');
  assert.equal(shaAfterRefusedWrite, shaBeforeRead, 'the file must be byte-identical after the refused write');
  assert.deepEqual(inventory(root), inventoryBeforeRead, 'inventory unchanged after the refused write');

  evidence.cases.C10 = {
    byteIdentity: {
      sha256BeforeRead: shaBeforeRead,
      sha256AfterRead: shaAfterRead,
      inventoryBeforeRead,
      inventoryAfterRead,
      label: 'byte-identity observation only — NOT a zero-write proof',
    },
    mutationRefusal: {
      primaryCode: mutationError.code,
      sha256AfterRefusedWrite: shaAfterRefusedWrite,
      label: 'SQL mutation refused — scoped to SQL statements on this handle',
    },
    notEstablished: [
      'inode metadata and atime/mtime effects',
      '-wal / -shm sidecar creation or deletion',
      'read-only WAL recovery (SQLITE_READONLY_RECOVERY / SQLITE_CANTOPEN)',
      'rollback-journal playback on a crash-interrupted store',
      'temp-file, page-cache spill and PRAGMA temp_store behaviour',
      'any write performed by the native library outside SQL statement execution',
    ],
  };
  maybeForceFail('C10');
});

// --- C11: reserved-looking row keys are ordinary store data ----------------------------------------

test('C11 (F10) reserved-looking keys are preserved as own data and no prototype is mutated', () => {
  const root = ownedRoot('C11');
  const dbPath = buildFixture('F10', root);

  const result = loadConditionalAdmissionsSqlite(dbPath);
  assert.equal(result.ok, true, 'F10 is a valid store and must load');

  const { bindings } = result.ledger;
  const expectedBindings = expectedF10Bindings();

  // The '__proto__' row must have become an OWN property. Plain assignment in the opener would
  // have invoked the Object.prototype setter and dropped the row silently.
  assert.equal(Object.hasOwn(bindings, '__proto__'), true, "'__proto__' must be an own property");
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(bindings, '__proto__').value,
    { kind: 'proto-key', polluted: false },
  );
  assert.equal(Object.getPrototypeOf(bindings), Object.prototype, 'the section prototype is untouched');

  // No global prototype pollution anywhere in the process.
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal({}.polluted, undefined, 'Object.prototype must not have gained a polluted property');
  assert.equal({}.kind, undefined, 'Object.prototype must not have gained a kind property');

  assert.deepEqual(
    Object.keys(bindings).sort(),
    ['__proto__', 'binding-alpha', 'binding-beta', 'constructor', 'prototype'],
    'all five rows survive — none dropped, none merged',
  );

  // 'constructor' and 'prototype' are own data properties holding their row values, not the
  // inherited Object.prototype.constructor function.
  assert.equal(Object.hasOwn(bindings, 'constructor'), true);
  assert.equal(typeof bindings.constructor, 'object', "'constructor' must be row data, not the inherited function");
  assert.deepEqual(bindings.constructor, { kind: 'constructor-key', polluted: false });
  assert.equal(Object.hasOwn(bindings, 'prototype'), true);
  assert.deepEqual(bindings.prototype, { kind: 'prototype-key', polluted: false });

  for (const key of Object.keys(expectedBindings)) {
    const descriptor = Object.getOwnPropertyDescriptor(bindings, key);
    assert.notEqual(descriptor, undefined, `${key} must be an own property`);
    assert.equal(descriptor.enumerable, true, `${key} must be enumerable`);
    assert.equal(descriptor.writable, true, `${key} must be writable`);
    assert.equal(descriptor.configurable, true, `${key} must be configurable`);
    assert.deepEqual(descriptor.value, Object.getOwnPropertyDescriptor(expectedBindings, key).value);
  }

  evidence.cases.C11 = {
    ok: true,
    bindingKeysSorted: Object.keys(bindings).sort(),
    protoIsOwnProperty: true,
    sectionPrototypeIsObjectPrototype: true,
    globalPrototypeUnpolluted: true,
    constructorValueType: typeof bindings.constructor,
    expectationSource: 'built with Object.defineProperty in the test lane, independently of fixture.cjs',
  };
  maybeForceFail('C11');
});

// --- X1: generation guard controls (dispatch addition) ----------------------------------------------

// Contract: generation is accepted only when it is absent-free, a canonical non-negative integer
// string, a safe integer, and >= 1. Everything else is invalid_store_shape. These controls cover
// the empty / missing / fractional / unsafe cases the dispatch names; F3 already covers '0'.
const GENERATION_CONTROLS = [
  ['empty-string', '', 'refuse'],
  ['missing-row', undefined, 'refuse'],
  ['fractional', '1.5', 'refuse'],
  ['exponential', '1e3', 'refuse'],
  ['signed-positive', '+7', 'refuse'],
  ['negative', '-1', 'refuse'],
  ['leading-space', ' 7', 'refuse'],
  ['trailing-space', '7 ', 'refuse'],
  ['non-numeric', 'seven', 'refuse'],
  ['unsafe-above-2pow53', '9007199254740993', 'refuse'],
  ['unsafe-very-large', '99999999999999999999', 'refuse'],
  ['zero-padded', '007', 'accept'],
  ['canonical-one', '1', 'accept'],
];

test('X1 generation guard: empty, missing, fractional and unsafe values are refused', () => {
  const observations = [];
  for (const [label, value, expectation] of GENERATION_CONTROLS) {
    const dbPath = buildControlStore(`X1-${label}`, { generation: value });
    const result = loadConditionalAdmissionsSqlite(dbPath);

    if (expectation === 'refuse') {
      assert.deepEqual(result, refusal('invalid_store_shape'), `generation ${JSON.stringify(value)} must refuse`);
    } else {
      assert.equal(result.ok, true, `generation ${JSON.stringify(value)} must be accepted`);
      assert.equal(Number.isSafeInteger(result.ledger.generation), true);
      assert.ok(result.ledger.generation >= 1);
    }

    observations.push({
      label,
      storedText: value === undefined ? null : value,
      rowPresent: value !== undefined,
      expectation,
      ok: result.ok,
      detail: result.ok ? null : result.detail,
      generation: result.ok ? result.ledger.generation : null,
    });
  }

  evidence.cases.X1 = {
    controls: observations,
    note: 'accept controls are included so the guard is shown to discriminate rather than refuse everything; '
      + "zero-padded '007' is accepted because the contract's acceptance test is safe-integer and >= 1, "
      + 'not canonical-decimal-form — recorded as a tolerance observation, not a defect',
  };
  maybeForceFail('X1');
});

// --- X2: marker and date-canonicality controls (dispatch addition) ------------------------------------

// The marker predicate requires a lowercase v4 uuid AND an initialized_at that survives a
// canonical toISOString() round-trip. These controls exercise both halves plus the missing-row
// cases; F5 already covers a plainly non-uuid marker_id.
const MARKER_CONTROLS = [
  ['uuid-uppercase', { marker_id: '9F8B7A6C-5D4E-4F3A-8B2C-1D0E9F8A7B6C' }, 'refuse'],
  ['uuid-wrong-version-nibble', { marker_id: '9f8b7a6c-5d4e-1f3a-8b2c-1d0e9f8a7b6c' }, 'refuse'],
  ['uuid-wrong-variant-nibble', { marker_id: '9f8b7a6c-5d4e-4f3a-7b2c-1d0e9f8a7b6c' }, 'refuse'],
  ['uuid-empty', { marker_id: '' }, 'refuse'],
  ['uuid-row-missing', { marker_id: undefined }, 'refuse'],
  ['date-no-millis', { initialized_at: '2026-01-02T03:04:05Z' }, 'refuse'],
  ['date-offset-form', { initialized_at: '2026-01-02T03:04:05.006+00:00' }, 'refuse'],
  ['date-space-separator', { initialized_at: '2026-01-02 03:04:05.006Z' }, 'refuse'],
  ['date-not-a-date', { initialized_at: 'not-a-date' }, 'refuse'],
  ['date-empty', { initialized_at: '' }, 'refuse'],
  ['date-row-missing', { initialized_at: undefined }, 'refuse'],
  ['date-canonical-other-instant', { initialized_at: '1999-12-31T23:59:59.999Z' }, 'accept'],
  ['both-canonical', {}, 'accept'],
];

test('X2 marker controls: uuid shape and canonical-date round-trip are both enforced', () => {
  const observations = [];
  for (const [label, overrides, expectation] of MARKER_CONTROLS) {
    const dbPath = buildControlStore(`X2-${label}`, overrides);
    const result = loadConditionalAdmissionsSqlite(dbPath);

    if (expectation === 'refuse') {
      assert.deepEqual(result, refusal('marker_invalid'), `${label} must refuse with marker_invalid`);
    } else {
      assert.equal(result.ok, true, `${label} must be accepted`);
      assert.deepEqual(Object.keys(result.ledger.marker), ['marker_id', 'initialized_at']);
    }

    observations.push({
      label,
      overrides: Object.fromEntries(
        Object.entries(overrides).map(([k, v]) => [k, v === undefined ? null : v]),
      ),
      rowsOmitted: Object.entries(overrides).filter(([, v]) => v === undefined).map(([k]) => k),
      expectation,
      ok: result.ok,
      detail: result.ok ? null : result.detail,
    });
  }

  evidence.cases.X2 = {
    controls: observations,
    note: 'accept controls prove the predicate discriminates rather than refusing every marker; '
      + 'no domain rule about marker VALUES beyond the contract predicate is asserted',
  };
  maybeForceFail('X2');
});

// --- X3: handle hygiene observation ------------------------------------------------------------------

// Code-review note carried by the dispatch: the opener's finally does `try { db.close(); } catch {}`,
// so a close FAILURE is swallowed and is invisible to any caller. This case measures what can
// actually be measured from outside the opener — that repeated opens do not accumulate descriptors
// — and records honestly that the swallowed-error branch itself is NOT exercised here.
const HANDLE_ITERATIONS = 256;

function ownFdCount() {
  // Reads this process's own descriptor directory. Not a scan of any other process.
  try {
    return fs.readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

// Measures descriptor growth across `iterations` calls, after a warm-up call so that one-time
// lazy allocations are not counted as growth.
function measureHandleGrowth(dbPath, expectOk) {
  assert.equal(loadConditionalAdmissionsSqlite(dbPath).ok, expectOk, 'warm-up call must have the expected verdict');

  const fdBefore = ownFdCount();
  let matching = 0;
  for (let i = 0; i < HANDLE_ITERATIONS; i += 1) {
    if (loadConditionalAdmissionsSqlite(dbPath).ok === expectOk) matching += 1;
  }
  const fdAfter = ownFdCount();

  assert.equal(matching, HANDLE_ITERATIONS, 'every repeated open must reach the same verdict');

  let fdGrowth = null;
  if (fdBefore !== null && fdAfter !== null) {
    fdGrowth = fdAfter - fdBefore;
    // Small slack: readdirSync itself transiently consumes a descriptor.
    assert.ok(fdGrowth <= 8, `descriptor count must not grow with repeated opens (grew by ${fdGrowth})`);
  }

  return {
    iterations: HANDLE_ITERATIONS,
    verdictHeldEveryTime: true,
    ownFdCountBefore: fdBefore,
    ownFdCountAfter: fdAfter,
    ownFdGrowth: fdGrowth,
    fdObservable: fdBefore !== null && fdAfter !== null,
  };
}

test('X3 handle hygiene: repeated opens accumulate no descriptors on success or on the read-error path', () => {
  // Success path: open -> read -> return through the finally that closes the handle.
  const okRoot = ownedRoot('X3-ok');
  const okPath = buildFixture('F1', okRoot);
  const successPath = measureHandleGrowth(okPath, true);
  assert.deepEqual(sidecars(okRoot), [], 'repeated successful opens must leave no sidecar behind');

  // Read-error path: F4 has the bindings table dropped, so the handle IS constructed and the
  // function returns from the catch — exercising the same finally on an error return. Without
  // this loop the error path's close would be entirely unmeasured.
  const errRoot = ownedRoot('X3-err');
  const errPath = buildFixture('F4', errRoot);
  const errorPath = measureHandleGrowth(errPath, false);
  assert.deepEqual(sidecars(errRoot), [], 'repeated failing opens must leave no sidecar behind');

  evidence.cases.X3 = {
    successPath,
    readErrorPath: errorPath,
    establishes: 'no descriptor accumulation across repeated opens on this platform, for BOTH the '
      + 'successful return and the read-error return — both of which leave through the opener\'s finally',
    doesNotEstablish: [
      "the opener's `finally { try { db.close(); } catch {} }` swallow branch is NOT exercised: no "
      + 'fixture in this suite makes db.close() itself throw, so close-FAILURE behaviour is UNMEASURED. '
      + 'If db.close() ever threw, the opener would discard the error and the caller could not tell.',
      'the open-failure path (C1) never constructs a handle, so it has nothing to close',
      'descriptor counting is a proxy for "the handle was released", not a direct observation of '
      + 'sqlite3_close() returning SQLITE_OK',
      'any cross-platform claim — this is one local macOS/arm64 observation',
    ],
  };
  maybeForceFail('X3');
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
// assertion. It must not change process.exitCode: a nonzero exit is never converted to success.
let finalized = false;

function finalize() {
  if (finalized) return;
  finalized = true;

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
    residual = fs.readdirSync(WORK_DIR).filter(name => name.startsWith('.tmp-')).sort();
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
