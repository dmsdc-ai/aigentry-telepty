'use strict';
/*
 * task1170 / release1171 - isolated prototype validation ONLY (nv1170av-v1).
 *
 * Real no-create / readonly / corruption behaviour of the better-sqlite3 13.0.3
 * NATIVE binding. No mocks, no stubs, no product code is imported.
 *
 * Scope note (unchanged from the prior revision, deliberately):
 *   This file proves observable open/create/readonly/corruption behaviour of the
 *   native binding on whichever single host executes it. It does NOT prove ACL,
 *   symlink/no-follow, local-volume, power-loss, backup or rollback guarantees,
 *   and case4 is NOT an adversarial race / TOCTOU proof. Three-OS acceptance is
 *   established only by the CI matrix run, never by a local run.
 *
 * Documented environment variables (both optional, both absolute when set):
 *   NV1170AV_BETTER_SQLITE3_PATH - better-sqlite3 package dir.
 *                                  Default: <this dir>/node_modules/better-sqlite3
 *   NV1170AV_WORK_DIR            - dir for owned temp roots + evidence.json.
 *                                  Default: <this dir>
 * No machine-specific path is baked into any assertion.
 *
 * Bounded self-test hook (hygiene proof only, never set in CI):
 *   NV1170AV_FORCE_FAIL=case5    - injects one deliberate assertion failure so the
 *                                  cleanup/evidence path can be proven to survive a
 *                                  failing run. The hook can only ADD a failure; it
 *                                  can never mask, skip or waive one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ------------------------------------------------------------- resolution ---

function requireAbsolute(value, name) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path, got: ${value}`);
  }
  return value;
}

const TEST_DIR = __dirname;
const DEFAULT_MODULE = path.join(TEST_DIR, 'node_modules', 'better-sqlite3');
const MODULE_PATH = requireAbsolute(
  process.env.NV1170AV_BETTER_SQLITE3_PATH || DEFAULT_MODULE,
  'NV1170AV_BETTER_SQLITE3_PATH'
);

const WORK_DIR = requireAbsolute(
  process.env.NV1170AV_WORK_DIR || TEST_DIR,
  'NV1170AV_WORK_DIR'
);
fs.mkdirSync(WORK_DIR, { recursive: true });
const EVIDENCE_PATH = path.join(WORK_DIR, 'evidence.json');

const Database = require(MODULE_PATH);

// ---------------------------------------------------------------- identity --

/** Env value, trimmed, or null. Never invents a value it cannot observe. */
function envOrNull(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// Honest identity of THIS run. Nothing here is hardcoded: every field is either
// observed from the environment of the current process or explicitly null.
const runIdentity = {
  track: 'nv1170av',
  task: 1170,
  workerAttempt: envOrNull('AIGENTRY_WORKER_ATTEMPT'),
  workerSessionId: envOrNull('AIGENTRY_WORKER_SESSION_ID'),
  ci: {
    detected: envOrNull('CI') !== null || envOrNull('GITHUB_ACTIONS') !== null,
    repository: envOrNull('GITHUB_REPOSITORY'),
    workflow: envOrNull('GITHUB_WORKFLOW'),
    runId: envOrNull('GITHUB_RUN_ID'),
    runNumber: envOrNull('GITHUB_RUN_NUMBER'),
    runAttempt: envOrNull('GITHUB_RUN_ATTEMPT'),
    job: envOrNull('GITHUB_JOB'),
    eventName: envOrNull('GITHUB_EVENT_NAME'),
    runnerOs: envOrNull('RUNNER_OS'),
    // GITHUB_SHA is the merge commit for pull_request events, so the workflow
    // additionally exports the resolved `git rev-parse HEAD` of the checkout.
    githubSha: envOrNull('GITHUB_SHA'),
    actualGitHead: envOrNull('NV1170AV_GIT_HEAD'),
  },
};

const evidence = {
  schema: 'nv1170av-no-create-evidence/1',
  runIdentity,
  forceFailHook: envOrNull('NV1170AV_FORCE_FAIL'),
  moduleResolution: {
    envVar: 'NV1170AV_BETTER_SQLITE3_PATH',
    envVarSet: envOrNull('NV1170AV_BETTER_SQLITE3_PATH') !== null,
    resolvedModuleDir: MODULE_PATH,
    usedDefault: MODULE_PATH === DEFAULT_MODULE,
    workDir: WORK_DIR,
    workDirEnvVarSet: envOrNull('NV1170AV_WORK_DIR') !== null,
  },
  runtime: {
    nodeVersion: process.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
  },
  versions: {},
  selectedPrebuild: {},
  mappedNativeBinary: {},
  cases: {},
};

// ---------------------------------------------------------------- helpers ---

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Case-insensitive, separator-normalised path key (Windows-safe comparison). */
function pathKey(p) {
  return path.resolve(p).split(path.sep).join('/').toLowerCase();
}

function inventory(dir) {
  // sorted (name, size) inventory of a directory - detects creation of the DB
  // itself as well as side files such as -journal / -wal / -shm.
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size };
    });
}

/**
 * Runs `fn`, requiring it to throw. Returns the thrown error.
 * Never swallows: an absence of throw is a hard assertion failure, and an error
 * of the wrong shape is returned to the caller for explicit code assertions.
 */
function mustThrow(fn, what) {
  let threw = false;
  let err;
  try {
    fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  assert.equal(threw, true, `expected ${what} to throw, but it returned normally`);
  return err;
}

/** Closes a better-sqlite3 handle if it is still open. Close errors propagate. */
function closeIfOpen(db) {
  if (db && db.open) db.close();
}

/** Bounded, documented hygiene hook. Can only add a failure, never remove one. */
function forceFailHook(label) {
  if (envOrNull('NV1170AV_FORCE_FAIL') === label) {
    assert.fail(
      `NV1170AV_FORCE_FAIL=${label}: deliberate failure injected to prove that ` +
        'temp-root cleanup and evidence persistence survive a failing assertion ' +
        'and that the process exit code stays nonzero.'
    );
  }
}

const tmpDirs = [];
function makeTmpDir(label) {
  // Private temp root we own, always under WORK_DIR. Never system, home or live DB.
  const dir = fs.mkdtempSync(path.join(WORK_DIR, `.tmp-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

/** Creates a valid fixture DB with known schema + rows, fully closed on return. */
function makeFixtureDb(dir, name) {
  const p = path.join(dir, name);
  let db = null;
  try {
    db = new Database(p);
    db.exec(
      'CREATE TABLE msg (id INTEGER PRIMARY KEY, body TEXT NOT NULL, n INTEGER NOT NULL)'
    );
    const ins = db.prepare('INSERT INTO msg (id, body, n) VALUES (?, ?, ?)');
    ins.run(1, 'alpha', 10);
    ins.run(2, 'beta', 20);
  } finally {
    closeIfOpen(db);
  }
  return p;
}

// Deterministic corrupt fixture: a valid SQLite magic header followed by a fixed,
// non-random byte pattern. Deterministic so the recorded hash is reproducible.
function makeCorruptDb(dir, name) {
  const p = path.join(dir, name);
  const header = Buffer.from('SQLite format 3\u0000', 'binary');
  const body = Buffer.alloc(4096);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  fs.writeFileSync(p, Buffer.concat([header, body]));
  return p;
}

// ------------------------------------------------------- native observation --

/**
 * The prebuild the package's OWN selector picks. This is a *filename decision*,
 * not proof that this file is the one the process mapped. Uses better-sqlite3's
 * lib/binding.js (required by absolute file path; the subpath is not exported),
 * so musl-vs-glibc selection is the package's logic, not a re-implementation.
 */
function readSelectedPrebuild() {
  let selected = null;
  let selectorError = null;
  try {
    // eslint-disable-next-line global-require
    const binding = require(path.join(MODULE_PATH, 'lib', 'binding.js'));
    selected = binding.getPrebuildPath();
  } catch (e) {
    selectorError = `${e.code || e.name}: ${e.message}`;
  }

  if (!selected) {
    return {
      source: 'better-sqlite3 lib/binding.js getPrebuildPath()',
      kind: 'no-prebuild-selected',
      path: null,
      filename: null,
      selectorError,
      note:
        'No prebuilt binary was selected; the package would fall back to a ' +
        'node-gyp build output (build/Debug or build/Release).',
    };
  }

  const exists = fs.existsSync(selected);
  return {
    source: 'better-sqlite3 lib/binding.js getPrebuildPath()',
    kind: 'prebuild-selected',
    path: selected,
    filename: path.basename(selected),
    exists,
    bytes: exists ? fs.statSync(selected).size : null,
    sha256: exists ? sha256File(selected) : null,
    selectorError,
    note: 'Filename selection only. Not evidence that this file was mapped.',
  };
}

/**
 * The native object the process ACTUALLY mapped, observed directly from
 * process.report's shared-object list after the binding has been loaded.
 * Where the platform does not surface the .node object, this reports
 * observed:false with a reason - it never guesses and never fabricates.
 */
function observeMappedNative() {
  const method = 'process.report.getReport().sharedObjects';
  let sharedObjects;
  try {
    sharedObjects = process.report.getReport().sharedObjects;
  } catch (e) {
    return { observed: false, method, reason: `process.report failed: ${e.message}` };
  }
  if (!Array.isArray(sharedObjects)) {
    return { observed: false, method, reason: 'sharedObjects is not an array' };
  }

  const nodeObjects = sharedObjects.filter(
    (s) => typeof s === 'string' && /\.node$/i.test(s)
  );
  const prefix = `${pathKey(MODULE_PATH)}/`;
  const matches = nodeObjects.filter((s) => pathKey(s).startsWith(prefix));

  if (matches.length === 0) {
    return {
      observed: false,
      method,
      reason:
        'no .node shared object under the resolved module dir was reported on ' +
        'this platform; the mapped binary is UNKNOWN here',
      nodeObjectsReported: nodeObjects,
    };
  }

  return {
    observed: true,
    method,
    count: matches.length,
    binaries: matches.map((p) => ({
      path: p,
      filename: path.basename(p),
      bytes: fs.existsSync(p) ? fs.statSync(p).size : null,
      sha256: fs.existsSync(p) ? sha256File(p) : null,
    })),
  };
}

// ------------------------------------------------------------ preconditions --

test('precondition: native binding loads, versions and mapped binary observed', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(MODULE_PATH, 'package.json'), 'utf8')
  );
  assert.equal(pkg.name, 'better-sqlite3');
  assert.equal(pkg.version, '13.0.3');

  // Load the native binding for real before observing what the process mapped.
  let db = null;
  let sqliteVersion;
  try {
    db = new Database(':memory:');
    sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
  } finally {
    closeIfOpen(db);
  }
  assert.match(sqliteVersion, /^\d+\.\d+\.\d+$/);

  const selected = readSelectedPrebuild();
  const mapped = observeMappedNative();

  // The selector must have found a real file on any platform we ship prebuilds
  // for; a missing prebuild would silently become a node-gyp build requirement.
  assert.equal(
    selected.kind,
    'prebuild-selected',
    `no prebuilt binary selected for ${process.platform}-${process.arch}`
  );
  assert.equal(selected.exists, true, `selected prebuild missing at ${selected.path}`);

  // Only assert agreement when the mapping was actually observed. On a platform
  // where it is unknown, the run records "unknown" instead of inventing a match.
  let agreement = null;
  if (mapped.observed) {
    agreement = mapped.binaries.some((b) => pathKey(b.path) === pathKey(selected.path));
    assert.equal(
      agreement,
      true,
      `mapped native binary ${JSON.stringify(mapped.binaries.map((b) => b.path))} ` +
        `does not include the selected prebuild ${selected.path}`
    );
  }

  evidence.versions = { betterSqlite3: pkg.version, sqlite: sqliteVersion };
  evidence.selectedPrebuild = selected;
  evidence.mappedNativeBinary = mapped;
  evidence.selectedMatchesMapped = agreement; // true | null (unobservable here)
});

// ------------------------------------------------------------------ case 1 --

test('case1: absent file + fileMustExist:true -> SQLITE_CANTOPEN, inventory unchanged', () => {
  const dir = makeTmpDir('case1');
  const dbPath = path.join(dir, 'absent.db');
  const before = inventory(dir);
  assert.deepEqual(before, [], 'fixture dir must start empty');

  let db = null;
  let err;
  try {
    err = mustThrow(() => {
      db = new Database(dbPath, { fileMustExist: true });
    }, 'strict open of an absent file');
  } finally {
    closeIfOpen(db);
  }

  assert.equal(err.code, 'SQLITE_CANTOPEN');
  const after = inventory(dir);
  assert.deepEqual(after, before, 'strict open must not create any file');
  assert.equal(fs.existsSync(dbPath), false);

  evidence.cases.case1 = {
    errorCode: err.code,
    errorMessage: err.message,
    errorName: err.constructor.name,
    inventoryBefore: before,
    inventoryAfter: after,
    fileCreated: false,
  };
});

// ------------------------------------------------------------------ case 2 --

test('case2: positive control - default constructor creates an absent DB', () => {
  const dir = makeTmpDir('case2');
  const dbPath = path.join(dir, 'created.db');
  assert.equal(fs.existsSync(dbPath), false);

  let db = null;
  let openedName;
  try {
    db = new Database(dbPath);
    openedName = db.name;
    // Force the file to materialize with real content, not a 0-byte placeholder.
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
  } finally {
    closeIfOpen(db); // closed before any further work, per dispatch
  }

  assert.equal(db.open, false, 'db must be closed before further work');
  assert.equal(openedName, dbPath);
  assert.equal(fs.existsSync(dbPath), true, 'default constructor must create the file');
  const size = fs.statSync(dbPath).size;
  assert.ok(size > 0, `created DB should be non-empty, got ${size} bytes`);

  evidence.cases.case2 = {
    created: true,
    bytes: size,
    inventoryAfter: inventory(dir),
    closedBeforeFurtherWork: true,
  };
});

// ------------------------------------------------------------------ case 3 --

test('case3: initialized DB opens strictly, commits, reopens with exact values/schema', () => {
  const dir = makeTmpDir('case3');
  const dbPath = path.join(dir, 'init.db');

  // explicit initialization (default constructor), then closed
  let db = null;
  try {
    db = new Database(dbPath);
    db.exec('CREATE TABLE msg (id INTEGER PRIMARY KEY, body TEXT NOT NULL, n INTEGER NOT NULL)');
  } finally {
    closeIfOpen(db);
  }
  assert.equal(fs.existsSync(dbPath), true);

  // strict open + committed transaction
  let journalMode;
  let synchronous;
  db = null;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    assert.equal(db.open, true);
    journalMode = db.pragma('journal_mode', { simple: true });
    synchronous = db.pragma('synchronous', { simple: true });

    const insertMany = db.transaction((rows) => {
      const ins = db.prepare('INSERT INTO msg (id, body, n) VALUES (?, ?, ?)');
      for (const r of rows) ins.run(r.id, r.body, r.n);
      return rows.length;
    });
    const written = insertMany([
      { id: 1, body: 'alpha', n: 10 },
      { id: 2, body: 'beta', n: 20 },
      { id: 3, body: 'gamma', n: 30 },
    ]);
    assert.equal(written, 3);
    assert.equal(db.inTransaction, false, 'transaction must be committed, not open');
  } finally {
    closeIfOpen(db);
  }

  // reopen strictly and verify exact values + exact schema
  db = null;
  let rows;
  let schemaSql;
  let tableInfo;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    rows = db.prepare('SELECT id, body, n FROM msg ORDER BY id').all();
    schemaSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='msg'")
      .get().sql;
    tableInfo = db.pragma('table_info(msg)').map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      pk: c.pk,
    }));
  } finally {
    closeIfOpen(db);
  }

  assert.deepEqual(rows, [
    { id: 1, body: 'alpha', n: 10 },
    { id: 2, body: 'beta', n: 20 },
    { id: 3, body: 'gamma', n: 30 },
  ]);
  assert.equal(
    schemaSql,
    'CREATE TABLE msg (id INTEGER PRIMARY KEY, body TEXT NOT NULL, n INTEGER NOT NULL)'
  );
  assert.deepEqual(tableInfo, [
    { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'body', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'n', type: 'INTEGER', notnull: 1, pk: 0 },
  ]);

  evidence.cases.case3 = {
    journalModeReadback: journalMode,
    synchronousReadback: synchronous,
    rowsAfterReopen: rows,
    schemaSql,
    tableInfo,
    committed: true,
  };
});

// ------------------------------------------------------------------ case 4 --

test('case4: sequential disappearance - fixture removed before strict open (NOT a race proof)', () => {
  const dir = makeTmpDir('case4');
  const dbPath = makeFixtureDb(dir, 'vanishing.db');
  assert.equal(fs.existsSync(dbPath), true);

  const parked = path.join(dir, 'vanishing.parked');
  fs.renameSync(dbPath, parked); // sequential: strictly before the open below
  assert.equal(fs.existsSync(dbPath), false);
  const before = inventory(dir);

  let db = null;
  let err;
  try {
    err = mustThrow(() => {
      db = new Database(dbPath, { fileMustExist: true });
    }, 'strict open of a path whose fixture was removed');
  } finally {
    closeIfOpen(db);
  }

  assert.equal(err.code, 'SQLITE_CANTOPEN');
  assert.equal(fs.existsSync(dbPath), false, 'no replacement DB may be created');
  const after = inventory(dir);
  assert.deepEqual(after, before, 'failed strict open must leave the directory unchanged');

  evidence.cases.case4 = {
    kind: 'sequential-disappearance',
    note: 'Sequential removal before open. NOT an adversarial race / TOCTOU proof.',
    errorCode: err.code,
    errorMessage: err.message,
    replacementCreated: false,
    inventoryBefore: before,
    inventoryAfter: after,
  };
});

// ------------------------------------------------------------------ case 5 --

test('case5: corrupt fixture -> refusal, byte hash unchanged after the failed attempt', () => {
  forceFailHook('case5'); // bounded hygiene hook; no-op unless explicitly requested
  const dir = makeTmpDir('case5');
  const dbPath = makeCorruptDb(dir, 'corrupt.db');
  const hashBefore = sha256File(dbPath);
  const sizeBefore = fs.statSync(dbPath).size;
  const invBefore = inventory(dir);

  let db = null;
  let err;
  try {
    err = mustThrow(() => {
      // The refusal may surface at open or at first real page access; both are
      // accepted, but a code must be asserted - never acceptance by message.
      db = new Database(dbPath, { fileMustExist: true });
      db.prepare('SELECT name FROM sqlite_master').all();
    }, 'reading a corrupt DB file');
  } finally {
    closeIfOpen(db);
  }

  assert.equal(err.code, 'SQLITE_NOTADB');
  const hashAfter = sha256File(dbPath);
  assert.equal(hashAfter, hashBefore, 'failed attempt must not modify the file bytes');
  assert.equal(fs.statSync(dbPath).size, sizeBefore);
  assert.deepEqual(inventory(dir), invBefore, 'no side files may be left behind');

  evidence.cases.case5 = {
    errorCode: err.code,
    errorMessage: err.message,
    sha256Before: hashBefore,
    sha256After: hashAfter,
    bytes: sizeBefore,
    unchanged: true,
  };
});

// ------------------------------------------------------------------ case 6 --

test('case6: readonly open reads correctly, mutation refuses, rows unchanged', () => {
  const dir = makeTmpDir('case6');
  const dbPath = makeFixtureDb(dir, 'readonly.db');
  const hashBefore = sha256File(dbPath);

  let db = null;
  let readRows;
  let err;
  try {
    db = new Database(dbPath, { readonly: true });
    readRows = db.prepare('SELECT id, body, n FROM msg ORDER BY id').all();
    err = mustThrow(() => {
      db.exec("INSERT INTO msg (id, body, n) VALUES (3, 'gamma', 30)");
    }, 'write through a readonly connection');
  } finally {
    closeIfOpen(db);
  }

  assert.deepEqual(readRows, [
    { id: 1, body: 'alpha', n: 10 },
    { id: 2, body: 'beta', n: 20 },
  ]);
  assert.equal(err.code, 'SQLITE_READONLY');

  // Independently reopen (read/write) and confirm the data really is unchanged.
  db = null;
  let rowsAfter;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    rowsAfter = db.prepare('SELECT id, body, n FROM msg ORDER BY id').all();
  } finally {
    closeIfOpen(db);
  }
  assert.deepEqual(rowsAfter, readRows, 'refused write must not have changed any row');

  evidence.cases.case6 = {
    rowsRead: readRows,
    mutationErrorCode: err.code,
    mutationErrorMessage: err.message,
    rowsAfterReopen: rowsAfter,
    sha256BeforeReadonlyOpen: hashBefore,
    sha256AfterRefusedWrite: sha256File(dbPath),
  };
});

// ------------------------------------------------------------------ case 7 --

test('case7: readonly + missing file -> refusal without creation', () => {
  const dir = makeTmpDir('case7');
  const dbPath = path.join(dir, 'missing-ro.db');
  const before = inventory(dir);
  assert.deepEqual(before, []);

  let db = null;
  let err;
  try {
    err = mustThrow(() => {
      db = new Database(dbPath, { readonly: true });
    }, 'readonly open of a missing file');
  } finally {
    closeIfOpen(db);
  }

  assert.equal(err.code, 'SQLITE_CANTOPEN');
  assert.equal(fs.existsSync(dbPath), false, 'readonly open must not create the file');
  const after = inventory(dir);
  assert.deepEqual(after, before);

  evidence.cases.case7 = {
    errorCode: err.code,
    errorMessage: err.message,
    fileCreated: false,
    inventoryBefore: before,
    inventoryAfter: after,
  };
});

// --------------------------------------------------------------- teardown ---

test('teardown: every mandatory case recorded evidence', () => {
  const expected = ['case1', 'case2', 'case3', 'case4', 'case5', 'case6', 'case7'];
  const recorded = Object.keys(evidence.cases).sort();
  // Derived from what actually ran - not a hardcoded passing total.
  assert.deepEqual(recorded, expected, 'every mandatory case must have recorded evidence');
});

// ---------------------------------------------------------------- finalize ---

// Cleanup and evidence persistence run from a process-exit finaliser, NOT from a
// test body, so that they still happen when any assertion above (including the
// teardown assertion) fails. The finaliser never throws and never alters the exit
// code, so a failing suite still exits nonzero.
let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;

  // Remove first, then count what was actually removed. No count is recorded in
  // advance of the removal it claims to describe.
  const details = [];
  for (const dir of tmpDirs) {
    let error = null;
    try {
      fs.rmSync(dir, { recursive: true, force: true }); // only dirs we created
    } catch (e) {
      error = `${e.code || e.name}: ${e.message}`;
    }
    let removed;
    try {
      removed = !fs.existsSync(dir);
    } catch (e) {
      removed = false;
      error = error || `${e.code || e.name}: ${e.message}`;
    }
    details.push({ dir: path.basename(dir), removed, error });
  }

  const remaining = details.filter((d) => !d.removed);
  evidence.cleanup = {
    finalizedBy: "process.on('exit')",
    tempRootsCreated: tmpDirs.length,
    tempRootsRemoved: details.filter((d) => d.removed).length,
    tempRootsRemaining: remaining.map((d) => d.dir),
    allRemoved: remaining.length === 0,
    details,
  };
  evidence.generatedAt = new Date().toISOString();

  try {
    fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
  } catch (e) {
    // Reported, never swallowed silently; the suite's own exit code is untouched.
    process.stderr.write(`evidence write failed (${EVIDENCE_PATH}): ${e.message}\n`);
  }

  if (remaining.length) {
    process.stderr.write(
      `temp roots not cleaned: ${remaining.map((d) => d.dir).join(', ')}\n`
    );
  }
}
process.on('exit', finalize);
