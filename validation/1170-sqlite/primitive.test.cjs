'use strict';

// Task #1170 / P1 - isolated SQLite primitive prototype.
//
// SCOPE: user-approved ISOLATED EXPERIMENT ONLY. This file does not adopt, wrap, or
// validate any product store adapter, and nothing here qualifies production behaviour.
// It exercises node:sqlite DatabaseSync against freshly-created synthetic fixtures inside
// a private temporary root that this process owns. It never resolves TELEPTY_HOME,
// ~/.telepty, or any operating data, and it never touches live stores.
//
// Explicitly NOT proven by this suite (see the *Qualified:false flags in the summary):
//   - process kill != power loss; a persisted WAL is not a physical durability proof
//   - chmod/mode observations are not Windows ACL or no-follow security
//   - the sq1170ao draft design remains unapproved and is not implemented here

const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --------------------------------------------------------------------------------------
// Child-process entry point.
//
// Children are forks of this same file (keeping the dispatch to exactly two leaves).
// This guard must run BEFORE node:test is required so a child never registers tests.
// --------------------------------------------------------------------------------------

if (process.env.P1_CHILD_ROLE) {
  runChild(process.env.P1_CHILD_ROLE);
  return;
}

const { test, after } = require('node:test');

// --------------------------------------------------------------------------------------
// Bounded synthetic fixture
// --------------------------------------------------------------------------------------

const FIXTURE_SCHEMA = `
  CREATE TABLE marker    (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
  CREATE TABLE binding   (id INTEGER PRIMARY KEY, holder TEXT NOT NULL);
  CREATE TABLE fence     (id INTEGER PRIMARY KEY, seq    INTEGER NOT NULL);
  CREATE TABLE admission (id INTEGER PRIMARY KEY, token  TEXT NOT NULL);
`;

const CHILD_TIMEOUT_MS = 10_000; // spec: each child <= 10s
const CASE_TIMEOUT_MS = 15_000; // 7 cases + summary stays well under the 120s overall cap

// --------------------------------------------------------------------------------------
// Owned roots. Local runs stage under output/; CI passes runner.temp via P1_TMP_ROOT.
// --------------------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..'); // .../source
const OUTPUT_ROOT = path.resolve(REPO_ROOT, '..'); // .../output (local layout only)

const TMP_BASE = process.env.P1_TMP_ROOT
  ? path.resolve(process.env.P1_TMP_ROOT)
  : OUTPUT_ROOT;

fs.mkdirSync(TMP_BASE, { recursive: true });
const OWNED_ROOT = fs.mkdtempSync(path.join(TMP_BASE, 'p1-sqlite-'));
fs.chmodSync(OWNED_ROOT, 0o700); // ownership hygiene only - NOT an ACL/security control

const EVIDENCE_DIR = process.env.P1_EVIDENCE_DIR
  ? path.resolve(process.env.P1_EVIDENCE_DIR)
  : path.join(OUTPUT_ROOT, 'evidence');

const SUMMARY_PATH = path.join(EVIDENCE_DIR, 'primitive-summary.json');

// Every child we spawn is tracked so cleanup reaps only processes we own.
const OWNED_CHILDREN = new Set();
const CASES = Object.create(null);

// Set by the awaited after hook; the synchronous last-resort handler defers to it.
let OWNED_ROOT_CLEANED = false;

let assertionCount = 0;
function check(fn) {
  fn();
  assertionCount += 1;
}

function caseDir(name) {
  const dir = path.join(OWNED_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Fresh fixture with explicit WAL + synchronous=FULL. Returns the readback values. */
function initFixture(dbPath) {
  const db = new DatabaseSync(dbPath, { timeout: 0 });
  try {
    const journalMode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
    db.exec('PRAGMA synchronous=FULL');
    const synchronous = db.prepare('PRAGMA synchronous').get().synchronous;
    db.exec(FIXTURE_SCHEMA);
    return { journalMode, synchronous };
  } finally {
    db.close();
  }
}

function openFixture(dbPath, options = {}) {
  const db = new DatabaseSync(dbPath, { timeout: 0, ...options });
  db.exec('PRAGMA synchronous=FULL');
  return db;
}

function rowCount(db, table) {
  return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
}

function integrity(db) {
  return db.prepare('PRAGMA integrity_check').get().integrity_check;
}

// --------------------------------------------------------------------------------------
// Deterministic child IPC. No guessed sleeps: every step waits on an explicit message
// or on the actual 'exit' event.
// --------------------------------------------------------------------------------------

function spawnChild(role, dbPath, extraEnv = {}, registry = OWNED_CHILDREN) {
  const child = fork(__filename, [], {
    // execArgv must be cleared: if the parent runs under `node --test`, an inherited
    // --test flag would make the child try to run the suite instead of its role.
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, P1_CHILD_ROLE: role, P1_CHILD_DB: dbPath, ...extraEnv },
  });
  registry.add(child);
  child.once('exit', () => registry.delete(child));
  return child;
}

/** Resolve on the first IPC message whose `t` matches, else reject on timeout/early exit. */
function awaitMessage(child, type, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout ${CHILD_TIMEOUT_MS}ms waiting for "${type}" (${label})`));
    }, CHILD_TIMEOUT_MS);

    function onMessage(msg) {
      if (!msg || msg.t !== type) return;
      cleanup();
      resolve(msg);
    }
    function onExit(code, signal) {
      cleanup();
      reject(new Error(`child exited early (code=${code} signal=${signal}) awaiting "${type}" (${label})`));
    }
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

/** Resolve with the actual {code, signal} exit, never a presumed one. */
function awaitExit(child, label) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`timeout ${CHILD_TIMEOUT_MS}ms waiting for exit (${label})`));
    }, CHILD_TIMEOUT_MS);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once('exit', onExit);
  });
}

/** Liveness probe for a pid we own: ESRCH (signal 0 rejected) means it is gone. */
function isLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Owned cleanup, awaited. Terminates every remaining owned child, then waits for its ACTUAL
 * exit (reaping it) before removing the owned root. Any failure throws so it is visible and
 * the run exits nonzero - it is never swallowed. Only ever called with roots/children we own.
 * `rmImpl` exists solely so the failure path can be exercised deliberately.
 */
async function cleanupOwned({ children, root, label, rmImpl = fs.rmSync }) {
  const tracked = [...children];
  const terminated = [];
  for (const child of tracked) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const exit = await awaitExit(child, `${label} cleanup child pid=${child.pid}`);
    terminated.push({ pid: child.pid, ...exit });
  }
  const stillLive = tracked.filter((c) => c.exitCode === null && c.signalCode === null);
  if (stillLive.length) {
    throw new Error(`${label} cleanup left live owned children: ${stillLive.map((c) => c.pid).join(',')}`);
  }
  rmImpl(root, { recursive: true, force: true }); // removes DBs and -wal/-shm sidecars
  if (fs.existsSync(root)) throw new Error(`${label} cleanup failed to remove owned root: ${root}`);
  return { terminated, rootRemoved: true };
}

// --------------------------------------------------------------------------------------
// Case 1 - explicit fresh fixture init, WAL + synchronous=FULL readback
// --------------------------------------------------------------------------------------

test('case1: fresh fixture init reports WAL and synchronous=FULL (numeric 2)', { timeout: CASE_TIMEOUT_MS }, () => {
  const dbPath = path.join(caseDir('case1'), 'fixture.db');
  check(() => assert.equal(fs.existsSync(dbPath), false, 'fixture must not pre-exist'));

  const { journalMode, synchronous } = initFixture(dbPath);

  check(() => assert.equal(journalMode, 'wal', 'journal_mode readback'));
  check(() => assert.equal(synchronous, 2, 'synchronous readback must be numeric 2 (FULL)'));

  const db = openFixture(dbPath);
  try {
    check(() => assert.equal(integrity(db), 'ok'));
  } finally {
    db.close();
  }

  CASES.case1 = {
    journalMode,
    synchronous,
    note: 'PRAGMA readback only; settings are not a durability measurement',
  };
});

// --------------------------------------------------------------------------------------
// Case 2 - atomic binding+fence commit survives close/reopen, with provenance
// --------------------------------------------------------------------------------------

test('case2: binding+fence commit persists across close/reopen with integrity ok', { timeout: CASE_TIMEOUT_MS }, () => {
  const dbPath = path.join(caseDir('case2'), 'fixture.db');
  initFixture(dbPath);

  let sqliteVersion;
  const writer = openFixture(dbPath);
  try {
    sqliteVersion = writer.prepare('SELECT sqlite_version() AS v').get().v;
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('INSERT INTO binding(id, holder) VALUES(?, ?)').run(1, 'owner-a');
    writer.prepare('INSERT INTO fence(id, seq) VALUES(?, ?)').run(1, 42);
    writer.exec('COMMIT');
  } finally {
    writer.close();
  }

  const reader = openFixture(dbPath);
  try {
    check(() => assert.equal(rowCount(reader, 'binding'), 1, 'exact binding rows'));
    check(() => assert.equal(rowCount(reader, 'fence'), 1, 'exact fence rows'));
    check(() => assert.equal(reader.prepare('SELECT seq FROM fence WHERE id=1').get().seq, 42));
    check(() => assert.equal(reader.prepare('SELECT holder FROM binding WHERE id=1').get().holder, 'owner-a'));
    check(() => assert.equal(integrity(reader), 'ok'));
  } finally {
    reader.close();
  }

  CASES.case2 = {
    sqliteVersion,
    nodeVersion: process.version,
    osPlatform: os.platform(),
    osRelease: os.release(),
    arch: process.arch,
    bindingRows: 1,
    fenceRows: 1,
    integrity: 'ok',
    note: 'persisted WAL across close/reopen is NOT a physical power-loss test',
  };
});

// --------------------------------------------------------------------------------------
// Case 3 - exception rollback leaves neither row; success keeps both
// --------------------------------------------------------------------------------------

test('case3: mid-transaction exception rolls back both rows; success keeps both', { timeout: CASE_TIMEOUT_MS }, () => {
  const dbPath = path.join(caseDir('case3'), 'fixture.db');
  initFixture(dbPath);

  const db = openFixture(dbPath);
  try {
    // Failing transaction: the second insert violates the PRIMARY KEY on a seeded row.
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO fence(id, seq) VALUES(?, ?)').run(7, 1);
    db.exec('COMMIT');

    let threw = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO binding(id, holder) VALUES(?, ?)').run(9, 'owner-rollback');
      db.prepare('INSERT INTO fence(id, seq) VALUES(?, ?)').run(7, 2); // duplicate PK
      db.exec('COMMIT');
    } catch (err) {
      threw = err;
      db.exec('ROLLBACK');
    }

    check(() => assert.notEqual(threw, null, 'duplicate PK must raise'));
    check(() => assert.equal(rowCount(db, 'binding'), 0, 'no partial binding row after rollback'));
    check(() => assert.equal(db.prepare('SELECT seq FROM fence WHERE id=7').get().seq, 1, 'fence unchanged'));
    check(() => assert.equal(rowCount(db, 'fence'), 1, 'no partial fence row after rollback'));

    // Success path keeps both.
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO binding(id, holder) VALUES(?, ?)').run(10, 'owner-commit');
    db.prepare('INSERT INTO fence(id, seq) VALUES(?, ?)').run(11, 3);
    db.exec('COMMIT');

    check(() => assert.equal(rowCount(db, 'binding'), 1, 'committed binding row present'));
    check(() => assert.equal(rowCount(db, 'fence'), 2, 'committed fence row present'));
    check(() => assert.equal(integrity(db), 'ok'));

    CASES.case3 = { rolledBackError: String(threw && threw.message), bindingRows: 1, fenceRows: 2 };
  } finally {
    db.close();
  }
});

// --------------------------------------------------------------------------------------
// Case 4 - write-lock contention between two owned children
// --------------------------------------------------------------------------------------

test('case4: BEGIN IMMEDIATE holder forces SQLITE_BUSY on a timeout=0 competitor', { timeout: CASE_TIMEOUT_MS }, async () => {
  const dbPath = path.join(caseDir('case4'), 'fixture.db');
  initFixture(dbPath);

  const holder = spawnChild('holder', dbPath);
  const holding = await awaitMessage(holder, 'holding', 'holder acquires write lock');
  check(() => assert.equal(holding.t, 'holding'));

  const competitor = spawnChild('competitor', dbPath);
  const busy = await awaitMessage(competitor, 'busy', 'competitor refused');
  const competitorExit = await awaitExit(competitor, 'competitor');

  // errcode 5 is SQLITE_BUSY. Asserted numerically, not by message text.
  check(() => assert.equal(busy.errcode, 5, `competitor must fail SQLITE_BUSY, got errstr=${busy.errstr}`));
  check(() => assert.equal(competitorExit.code, 0, 'competitor exits cleanly after refusal'));

  holder.send({ t: 'commit' });
  const committed = await awaitMessage(holder, 'committed', 'holder commits');
  const holderExit = await awaitExit(holder, 'holder');
  check(() => assert.equal(committed.t, 'committed'));
  check(() => assert.equal(holderExit.code, 0, 'holder exits cleanly after commit'));

  const db = openFixture(dbPath);
  try {
    check(() => assert.equal(rowCount(db, 'binding'), 1, 'holder row committed exactly once'));
    check(() => assert.equal(integrity(db), 'ok'));
  } finally {
    db.close();
  }

  CASES.case4 = {
    competitorErrcode: busy.errcode,
    competitorErrstr: busy.errstr,
    competitorExit,
    holderExit,
    note: 'lock contention observed via deterministic IPC handshakes, no sleeps',
  };
});

// --------------------------------------------------------------------------------------
// Case 5 - SIGKILL of one owned child mid-transaction
// --------------------------------------------------------------------------------------

test('case5: killed child leaves no uncommitted rows and integrity stays ok', { timeout: CASE_TIMEOUT_MS }, async () => {
  const dbPath = path.join(caseDir('case5'), 'fixture.db');
  initFixture(dbPath);

  // Seed a committed row so we can distinguish "rolled back" from "wiped".
  const seed = openFixture(dbPath);
  try {
    seed.exec('BEGIN IMMEDIATE');
    seed.prepare('INSERT INTO marker(id, label) VALUES(?, ?)').run(1, 'committed-before-kill');
    seed.exec('COMMIT');
  } finally {
    seed.close();
  }

  const victim = spawnChild('killable', dbPath);
  const signalled = await awaitMessage(victim, 'uncommitted', 'victim inserted uncommitted rows');
  check(() => assert.ok(signalled.rows > 0, 'victim reports uncommitted rows inserted'));

  victim.kill('SIGKILL');
  const victimExit = await awaitExit(victim, 'victim'); // actual exit, not presumed

  // The claim under test is "died without completing its transaction", not a POSIX signal
  // name: Windows terminates via TerminateProcess and may report a code instead of a
  // signal. Assert abnormal termination (never a clean exit 0) and record the real values.
  check(() =>
    assert.ok(
      victimExit.signal === 'SIGKILL' || victimExit.code !== 0,
      `victim must die abnormally, got code=${victimExit.code} signal=${victimExit.signal}`,
    ),
  );

  const db = openFixture(dbPath);
  try {
    check(() => assert.equal(rowCount(db, 'admission'), 0, 'uncommitted rows must not survive'));
    check(() => assert.equal(rowCount(db, 'marker'), 1, 'previously committed row must survive'));
    check(() => assert.equal(integrity(db), 'ok'));
  } finally {
    db.close();
  }

  CASES.case5 = {
    uncommittedRowsInserted: signalled.rows,
    victimExit,
    admissionRowsAfterReopen: 0,
    markerRowsAfterReopen: 1,
    note: 'process kill is NOT power loss; this does not qualify durability',
  };
});

// --------------------------------------------------------------------------------------
// Case 6 - corrupted byte-copy must fail loudly and must not be auto-reset
// --------------------------------------------------------------------------------------

test('case6: corrupted closed copy fails to open and its bytes are preserved', { timeout: CASE_TIMEOUT_MS }, () => {
  const dir = caseDir('case6');
  const dbPath = path.join(dir, 'fixture.db');
  const copyPath = path.join(dir, 'corrupt-copy.db');
  initFixture(dbPath);

  const seed = openFixture(dbPath);
  try {
    seed.exec('BEGIN IMMEDIATE');
    seed.prepare('INSERT INTO marker(id, label) VALUES(?, ?)').run(1, 'pre-corruption');
    seed.exec('COMMIT');
  } finally {
    seed.close(); // corrupt only a CLOSED database
  }

  fs.copyFileSync(dbPath, copyPath);
  const bytes = fs.readFileSync(copyPath);
  bytes.write('XXXX', 0); // clobber the SQLite header magic
  fs.writeFileSync(copyPath, bytes);

  const sizeAfterCorruption = fs.statSync(copyPath).size;
  const hashAfterCorruption = sha256(copyPath);

  // The handle is held OUTSIDE the try so a throwing prepare/get can never skip the close.
  // (Reproduced with a counted real-handle seam: the previous try-scoped handle shape left
  // opens=1 / closes=0 on the throwing path.)
  let threw = null;
  let db = null;
  try {
    db = new DatabaseSync(copyPath, { timeout: 0 });
    db.prepare('SELECT count(*) AS n FROM marker').get();
  } catch (err) {
    threw = err;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* a handle that failed to open may already be closed; never mask `threw` */
      }
    }
  }

  check(() => assert.notEqual(threw, null, 'corrupted database must not open+query silently'));
  check(() => assert.match(String(threw.message), /not a database|malformed|corrupt/i));

  // No auto-reset: SQLite must not have replaced the corrupt file with a fabricated new DB.
  check(() => assert.equal(fs.statSync(copyPath).size, sizeAfterCorruption, 'corrupt file size preserved'));
  check(() => assert.equal(sha256(copyPath), hashAfterCorruption, 'corrupt file bytes preserved'));

  // The untouched original must still be intact.
  const original = openFixture(dbPath);
  try {
    check(() => assert.equal(integrity(original), 'ok'));
    check(() => assert.equal(rowCount(original, 'marker'), 1));
  } finally {
    original.close();
  }

  CASES.case6 = {
    error: String(threw.message),
    corruptSize: sizeAfterCorruption,
    corruptSha256: hashAfterCorruption,
    bytesPreserved: true,
    autoResetObserved: false,
  };
});

// --------------------------------------------------------------------------------------
// Case 7 - NEGATIVE observation: the raw read-write open auto-creates absent files
// --------------------------------------------------------------------------------------

test('case7: raw read-write open CREATES an absent file (negative observation)', { timeout: CASE_TIMEOUT_MS }, () => {
  const absent = path.join(caseDir('case7'), 'absent.db');
  check(() => assert.equal(fs.existsSync(absent), false, 'path must be absent beforehand'));

  const db = new DatabaseSync(absent, { timeout: 0 }); // default open flags: CREATE
  try {
    db.exec('PRAGMA user_version=1');
  } finally {
    db.close();
  }

  check(() => assert.equal(fs.existsSync(absent), true, 'raw open created the absent file'));

  CASES.case7 = {
    autoCreatedAbsentFile: true,
    autoCreateRaceGuardQualified: false,
    // Accuracy: what was MEASURED here is only the raw-API behaviour below. No concurrent
    // adversary, no interleaving, no symlink swap between lstat and open was ever executed.
    measured: 'raw node:sqlite read-write open auto-creates an absent file inside an owned root',
    raceReproduced: false,
    adversarialLstatOpenRaceAttempted: false,
    note:
      'Observation only, inside an owned root. This is NOT a reproduction of an adversarial ' +
      'lstat-then-open race: no competing actor and no TOCTOU interleaving were exercised. ' +
      'It qualifies no production guard, filesystem gate, ACL, or no-follow guarantee.',
  };
});

// --------------------------------------------------------------------------------------
// Cleanup failure-path exercise (bounded, owned-only; not one of the seven scenarios).
//
// Proves the awaited cleanup actually reaps owned children and removes the owned root, and
// that a removal failure is VISIBLE (thrown) instead of swallowed the way a synchronous
// process.on('exit') handler swallows it.
// --------------------------------------------------------------------------------------

let CLEANUP_EXERCISE = null;

test('cleanup: owned children reaped and owned root removed; injected failure is visible', { timeout: CASE_TIMEOUT_MS }, async () => {
  const exerciseRoot = fs.mkdtempSync(path.join(OWNED_ROOT, 'cleanup-exercise-'));
  const dbPath = path.join(exerciseRoot, 'fixture.db');
  initFixture(dbPath);

  const exerciseChildren = new Set(); // separate registry: the suite's own set is untouched
  const child = spawnChild('killable', dbPath, {}, exerciseChildren);
  const held = await awaitMessage(child, 'uncommitted', 'exercise child holds an open transaction');
  const pid = child.pid;
  check(() => assert.ok(held.rows > 0, 'exercise child is alive and holding a transaction'));
  check(() => assert.equal(isLive(pid), true, 'exercise child is live before cleanup'));

  // Deliberate failure path: root removal fails. Children must still be reaped, and the
  // failure must surface as a thrown error.
  let failure = null;
  try {
    await cleanupOwned({
      children: exerciseChildren,
      root: exerciseRoot,
      label: 'exercise(injected-failure)',
      rmImpl: () => {
        throw new Error('injected owned-root removal failure');
      },
    });
  } catch (err) {
    failure = err;
  }
  check(() => assert.notEqual(failure, null, 'cleanup failure must be visible, never swallowed'));
  check(() => assert.match(String(failure.message), /injected owned-root removal failure/));
  check(() => assert.equal(isLive(pid), false, 'no live owned child remains after the failed cleanup'));
  check(() => assert.equal(exerciseChildren.size, 0, 'every owned child was reaped and deregistered'));
  check(() => assert.equal(fs.existsSync(exerciseRoot), true, 'root still present while removal was failing'));

  // Success path: same cleanup, real removal.
  const result = await cleanupOwned({ children: exerciseChildren, root: exerciseRoot, label: 'exercise' });
  check(() => assert.equal(result.rootRemoved, true, 'cleanup reports the owned root removed'));
  check(() => assert.equal(fs.existsSync(exerciseRoot), false, 'owned exercise root deletion completed'));
  check(() => assert.equal(isLive(pid), false, 'no live owned child remains after cleanup'));

  CLEANUP_EXERCISE = {
    childPid: pid,
    injectedFailureVisible: String(failure.message),
    liveOwnedChildrenAfterCleanup: 0,
    ownedRootRemoved: true,
    scope: 'owned exercise sub-root only; host paths are never cleaned',
    note:
      'Liveness probed with process.kill(pid, 0) (ESRCH => gone) after awaiting the actual ' +
      'exit event. This exercises the suite cleanup path, not any production shutdown path.',
  };
});

// --------------------------------------------------------------------------------------
// Evidence summary. Fails nonzero if any case or the evidence file is missing.
// --------------------------------------------------------------------------------------

test('summary: all 7 cases recorded and bounded JSON evidence written', { timeout: CASE_TIMEOUT_MS }, () => {
  const required = ['case1', 'case2', 'case3', 'case4', 'case5', 'case6', 'case7'];
  const missing = required.filter((k) => !CASES[k]);
  assert.deepEqual(missing, [], `missing case evidence: ${missing.join(',')}`);

  const workflowPath = path.join(REPO_ROOT, '.github', 'workflows', 'sqlite-conditional-prototype.yml');

  const summary = {
    task: 1170,
    track: 'pt1170ap',
    phase: 'P1',
    generatedAt: new Date().toISOString(),
    provenance: {
      nodeVersion: process.version,
      sqliteVersion: CASES.case2.sqliteVersion,
      osPlatform: os.platform(),
      osRelease: os.release(),
      arch: process.arch,
      gitHead: process.env.P1_GIT_HEAD || null,
      ownedRoot: OWNED_ROOT,
    },
    leaves: {
      test: { path: __filename, sha256: sha256(__filename) },
      workflow: fs.existsSync(workflowPath)
        ? { path: workflowPath, sha256: sha256(workflowPath) }
        : { path: workflowPath, sha256: null },
    },
    assertionCount,
    caseCount: required.length,
    cases: CASES,
    cleanupExercise: CLEANUP_EXERCISE,
    // Nothing in P1 qualifies any of the following. All remain OPEN.
    adoptionAllowed: false,
    productionAdapter: false,
    powerLossQualified: false,
    bootstrapDurabilityQualified: false,
    filesystemGateQualified: false,
    aclQualified: false,
    autoCreateRaceGuardQualified: false,
  };

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);

  const written = fs.statSync(SUMMARY_PATH);
  assert.ok(written.size > 0, 'evidence summary must be non-empty');
  assert.ok(assertionCount > 0, 'assertions must have been recorded');

  process.stdout.write(`# evidence: ${SUMMARY_PATH}\n`);
  process.stdout.write(`# assertions: ${assertionCount} cases: ${required.length}\n`);
});

// --------------------------------------------------------------------------------------
// Cleanup - own roots and own children only. No orphans, no daemons, no host repair.
// --------------------------------------------------------------------------------------

// Normal suite cleanup: an AWAITED node:test after hook. It terminates every remaining
// owned child, waits for that child's ACTUAL exit, and only then removes the owned root.
// Any failure propagates out of the hook, so node:test reports it and the run exits nonzero.
// (A synchronous process.on('exit') handler cannot do this: reproduced at exit it saw
// {exitCode:null, signalCode:null} for a child it had just signalled, and its bare catch
// swallowed an owned-root removal failure while the process still exited 0.)
after(async () => {
  await cleanupOwned({ children: OWNED_CHILDREN, root: OWNED_ROOT, label: 'suite' });
  OWNED_ROOT_CLEANED = true;
});

// LAST-RESORT ONLY - NOT EVIDENCE. This synchronous handler exists solely so an abnormal
// teardown (the after hook never running) cannot strand an owned child or owned directory.
// It cannot await or reap anything, its outcome is deliberately unobserved, and no result
// from it is ever recorded, asserted on, or reported as a cleanup measurement.
process.on('exit', () => {
  if (OWNED_ROOT_CLEANED) return;
  for (const child of OWNED_CHILDREN) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  try {
    fs.rmSync(OWNED_ROOT, { recursive: true, force: true }); // removes DBs and -wal/-shm sidecars
  } catch {
    /* best-effort; never repair or touch anything outside the owned root */
  }
});

// --------------------------------------------------------------------------------------
// Child role implementations
// --------------------------------------------------------------------------------------

function runChild(role) {
  const dbPath = process.env.P1_CHILD_DB;
  const send = (msg) => process.send && process.send(msg);

  // Hard self-cap so a child can never outlive the parent's 10s budget.
  const selfCap = setTimeout(() => process.exit(97), 10_000);
  selfCap.unref();

  let db;
  try {
    db = new DatabaseSync(dbPath, { timeout: 0 }); // timeout 0 => fail fast, never block
    db.exec('PRAGMA synchronous=FULL');

    if (role === 'holder') {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO binding(id, holder) VALUES(?, ?)').run(1, 'child-holder');
      send({ t: 'holding' });
      process.on('message', (msg) => {
        if (!msg || msg.t !== 'commit') return;
        try {
          db.exec('COMMIT');
          send({ t: 'committed' });
          db.close();
          process.exit(0);
        } catch (err) {
          send({ t: 'error', message: String(err && err.message) });
          process.exit(1);
        }
      });
      return; // stay alive on the IPC channel, holding the write lock
    }

    if (role === 'competitor') {
      try {
        db.exec('BEGIN IMMEDIATE');
        // Unexpected: the write lock was available.
        send({ t: 'acquired' });
        db.exec('ROLLBACK');
        db.close();
        process.exit(2);
      } catch (err) {
        send({ t: 'busy', errcode: err.errcode, errstr: String(err.errstr || err.message) });
        db.close();
        process.exit(0);
      }
      return;
    }

    if (role === 'killable') {
      db.exec('BEGIN IMMEDIATE');
      const rows = 3;
      const insert = db.prepare('INSERT INTO admission(id, token) VALUES(?, ?)');
      for (let i = 1; i <= rows; i += 1) insert.run(i, `uncommitted-${i}`);
      send({ t: 'uncommitted', rows }); // deliberately never commits
      setInterval(() => {}, 1_000); // hold the open transaction until SIGKILL
      return;
    }

    send({ t: 'error', message: `unknown child role: ${role}` });
    process.exit(3);
  } catch (err) {
    send({ t: 'error', message: String(err && err.message) });
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}
