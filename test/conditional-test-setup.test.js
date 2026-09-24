'use strict';

// T0 (#1170) — regressions for the TEST FIXTURE's fresh-home factory.
//
// These pin the *fixture* helper `createProvisionedTestHome` (test-support/setup-env.js), not the
// production admission policy. The product must keep failing closed on every store it did not
// create; the fixture's one exception is grounded in creation, not inspection.
//
// The load-bearing property is NEGATIVE and structural: there is no way to ask this module to
// initialize a directory you hand it. Emptiness is not ownership — a caller-owned empty directory
// and a used-then-cleared directory are indistinguishable from a fresh one by inspection, so the
// factory does not inspect. It creates. Everything below either exercises that factory or proves
// that some other directory was left untouched by it.
//
// Three further properties are pinned here because each was lost once already:
//   * a prefix names a directory, it must not choose one (path traversal via mkdtemp);
//   * HOME moves before any product module loads (#829), proved by a load-order spy;
//   * the no-adoption oracle is behavioural, and is demonstrated to fail a bad implementation —
//     an absent export name proves nothing on its own.
//
// No test in this file reads or writes a developer's real home. The read/write boundary is proved
// against a synthetic stand-in home in a child process, never against `os.homedir()` of the host.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const setupEnv = require('../test-support/setup-env');
const { createProvisionedTestHome } = setupEnv;
const persistence = require('../src/session-store/persistence');
const { ConditionalAdmissionStore } = require('../src/session-store/conditional-admission');

const SOURCE_ROOT = path.resolve(__dirname, '..');
const scratch = [];

/** A directory the factory did NOT create — the stand-in for "somebody else's". */
function foreignDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function track(home) {
  scratch.push(home);
  return home;
}

function storePathFor(home) {
  return persistence.defaultConditionalAdmissionsPath(home);
}

function loadStore(home) {
  return persistence.loadConditionalAdmissions(storePathFor(home));
}

/**
 * Recursive snapshot of every entry and its bytes, for proving "nothing was written here".
 * Only ever called on directories this file created.
 */
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = path.join(d, entry.name);
      const key = path.join(rel, entry.name);
      if (entry.isDirectory()) { out.push(`dir  ${key}`); walk(full, key); }
      else if (entry.isSymbolicLink()) out.push(`link ${key} -> ${fs.readlinkSync(full)}`);
      else out.push(`file ${key} ${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(dir, '');
  return out.join('\n');
}

test.after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// 1. The factory does its job
// ---------------------------------------------------------------------------

test('creates a new home and initializes its store in one step', () => {
  const home = track(createProvisionedTestHome('telepty-factory-'));

  assert.equal(fs.statSync(home).isDirectory(), true);
  assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));

  const loaded = loadStore(home);
  assert.equal(loaded.ok, true, 'the created home must come back ready, not refusing');
  assert.match(
    loaded.ledger.marker.marker_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'marker is a v4 uuid minted by the package, not a fixture-invented string'
  );
  assert.equal(loaded.ledger.schema_version, persistence.CONDITIONAL_ADMISSIONS_SCHEMA_VERSION);
  for (const section of ['bindings', 'admissions', 'tombstones', 'fenced_sessions']) {
    assert.deepEqual(loaded.ledger[section], {}, `${section} must be empty on first init`);
  }
  // Both durable artifacts — the ledger and its .initialized marker.
  assert.equal(fs.existsSync(storePathFor(home)), true);
  assert.equal(fs.existsSync(persistence.conditionalInitializationPath(storePathFor(home))), true);
});

test('each call creates a distinct home with its own marker', () => {
  const a = track(createProvisionedTestHome('telepty-factory-'));
  const b = track(createProvisionedTestHome('telepty-factory-'));

  assert.notEqual(a, b, 'the factory must never hand back the same directory twice');
  assert.notEqual(
    loadStore(a).ledger.marker.marker_id,
    loadStore(b).ledger.marker.marker_id,
    'each fresh store is genuinely new, not a copy of a previous one'
  );
});

test('a provisioned store no longer fences an unbound sid, and still fences a bound one', () => {
  const home = track(createProvisionedTestHome('telepty-factory-'));

  const store = new ConditionalAdmissionStore({ path: storePathFor(home) });
  assert.equal(store.initialize().ok, true);
  assert.equal(store.available(), true);

  // The behaviour change the fixture buys: before init, isFenced() returned true for EVERY sid
  // (fail-closed on unknown history). After a real init, an unbound sid is unknown-and-unfenced,
  // while genuine fence entries are still honoured.
  assert.equal(store.isFenced('never-bound-sid'), false);
  store.ledger.fenced_sessions['bound-sid'] = true;
  assert.equal(store.isFenced('bound-sid'), true, 'real fence entries must survive provisioning');
});

test('the factory is reusable and never resets a home it already handed out', () => {
  const first = track(createProvisionedTestHome('telepty-factory-'));
  const markerBefore = loadStore(first).ledger.marker.marker_id;
  const bytesBefore = fs.readFileSync(storePathFor(first));

  track(createProvisionedTestHome('telepty-factory-'));
  track(createProvisionedTestHome('telepty-factory-'));

  assert.deepEqual(fs.readFileSync(storePathFor(first)), bytesBefore,
    'an earlier home is not rewritten by later calls');
  assert.equal(loadStore(first).ledger.marker.marker_id, markerBefore);
});

// ---------------------------------------------------------------------------
// 2. A prefix names a directory; it must not be able to choose one
// ---------------------------------------------------------------------------

// `mkdtempSync` appends six random characters to the string it is given, so an unvalidated prefix
// is concatenated straight into a path. '../x-' walked out of the controlled tmp root and created
// a provisioned home in its PARENT — outside the only directory this fixture is allowed to write.
const RELOCATING_PREFIXES = [
  ['dot-dot', '../escaped-'],
  ['nested separator', 'sub/inner-'],
  ['trailing separator', 'dir/'],
  ['posix absolute', '/tmp/absolute-'],
  ['windows backslash', '..\\escaped-'],
  ['windows drive', 'C:\\temp\\x-'],
  ['windows UNC', '\\\\server\\share\\x-'],
  ['NUL byte', 'evil\0-']
];

for (const [label, prefix] of RELOCATING_PREFIXES) {
  test(`a ${label} prefix is refused and creates nothing`, () => {
    const tmpBefore = new Set(fs.readdirSync(os.tmpdir()));
    let created = null;
    assert.throws(
      () => { created = createProvisionedTestHome(prefix); },
      /prefix/i,
      created ? `the prefix relocated the created home to ${path.dirname(created)}` : undefined
    );
    assert.equal(created, null, 'a refused prefix must not leave a directory behind');
    // The refusal happens before mkdtemp, so the controlled root is unchanged too.
    assert.deepEqual(
      fs.readdirSync(os.tmpdir()).filter((e) => !tmpBefore.has(e)), [],
      'a refused prefix must not create anything under the controlled root'
    );
  });
}

test('a malformed prefix is refused rather than passed to path.join', () => {
  for (const bad of [42, null, {}, ['x'], Buffer.from('x'), () => 'x']) {
    assert.throws(
      () => createProvisionedTestHome(bad),
      /prefix/i,
      `a ${typeof bad} prefix must be refused with a prefix-specific error`
    );
  }
});

test('a plain prefix still works and still lands directly under the controlled root', () => {
  for (const good of ['telepty-factory-', 'a', 'with.dots-', 'with_underscore-']) {
    const home = track(createProvisionedTestHome(good));
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(home).startsWith(good), true);
    assert.equal(loadStore(home).ok, true);
  }
});

// ---------------------------------------------------------------------------
// 3. The structural refusal: initialization is not reachable for a given path
// ---------------------------------------------------------------------------

/**
 * The behavioural no-adoption oracle, applied below to the real module AND to a deliberately bad
 * one. It hands the candidate a directory it does not own, in every shape a caller could name it,
 * and requires the directory to come back byte-identical. A refusal counts as a pass; silently
 * initializing what it was handed does not.
 */
function assertNoAdoption(candidate) {
  const victim = foreignDir('telepty-victim-');
  fs.mkdirSync(path.join(victim, 'pre-existing'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'pre-existing', 'owned.txt'), 'not yours');
  const before = snapshot(victim);

  for (const arg of [victim, victim + path.sep, path.basename(victim), `../${path.basename(victim)}`]) {
    try { track(candidate.createProvisionedTestHome(arg)); } catch { /* refusal is the desired outcome */ }
  }

  assert.equal(snapshot(victim), before,
    'the candidate wrote into a directory it was handed rather than one it created');
}

test('the no-adoption oracle rejects a deliberately bad factory', () => {
  // Without this, the oracle could be vacuous: asserting that a removed export name is `undefined`
  // is satisfied by any implementation that adopts caller directories under a different name.
  const adoptingMutant = {
    createProvisionedTestHome(dirOrPrefix) {
      const target = path.isAbsolute(dirOrPrefix)
        ? dirOrPrefix
        : fs.mkdtempSync(path.join(os.tmpdir(), path.basename(dirOrPrefix)));
      const storePath = persistence.defaultConditionalAdmissionsPath(target);
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      new ConditionalAdmissionStore({ path: storePath }).initializeNewStore();
      return target;
    }
  };

  assert.throws(() => assertNoAdoption(adoptingMutant), /handed/,
    'the oracle must fail an implementation that initializes a caller-supplied directory');
});

test('the real factory passes the same no-adoption oracle', () => {
  assertNoAdoption(setupEnv);
});

test('the module exposes no way to initialize a caller-supplied path', () => {
  assert.deepEqual(
    Object.keys(setupEnv).sort(),
    ['createProvisionedTestHome'],
    'the only export is the factory; a path-taking provisioner is itself the defect'
  );
  // The v1 shape specifically — an exported function that accepted any directory.
  assert.equal(typeof setupEnv.provisionFreshConditionalStore, 'undefined');

  // And the factory does not accept a directory: its argument is an mkdtemp PREFIX, now constrained
  // to a single plain name. Handing it an existing directory's name yields a brand-new directory
  // under the controlled root, so an existing directory can never be adopted.
  const existing = foreignDir('telepty-not-adoptable-');
  const created = track(createProvisionedTestHome(path.basename(existing) + '-'));
  assert.notEqual(path.resolve(created), path.resolve(existing));
  assert.deepEqual(fs.readdirSync(existing), [], 'the existing directory gained nothing');
});

test('an unrelated empty directory receives no writes', () => {
  // The exact v1 forgery: empty, under tmp, and not ours. Nothing may appear in it.
  const foreign = foreignDir('telepty-foreign-empty-');
  const before = snapshot(foreign);

  track(createProvisionedTestHome('telepty-factory-'));

  assert.equal(snapshot(foreign), before, 'an unrelated empty directory must stay empty');
  assert.equal(fs.existsSync(storePathFor(foreign)), false);
  assert.deepEqual(loadStore(foreign), { ok: false, reason: 'conditional_store_not_initialized' },
    'and it must still be refusing, exactly as production intends');
});

test('a reused directory emptied of its contents receives no writes', () => {
  // The second v1 forgery: it had a prior life, was cleared, and now looks brand-new.
  const reused = foreignDir('telepty-reused-');
  fs.mkdirSync(path.join(reused, '.config', 'aigentry-telepty'), { recursive: true });
  fs.writeFileSync(path.join(reused, '.config', 'aigentry-telepty', 'leftover.json'), '{}');
  fs.rmSync(path.join(reused, '.config'), { recursive: true, force: true });
  assert.deepEqual(fs.readdirSync(reused), [], 'precondition: indistinguishable from brand-new');

  track(createProvisionedTestHome('telepty-factory-'));

  assert.deepEqual(fs.readdirSync(reused), [], 'a cleared directory must not be adopted');
  assert.deepEqual(loadStore(reused), { ok: false, reason: 'conditional_store_not_initialized' });
});

test('a symlinked directory receives no writes', () => {
  const realDir = foreignDir('telepty-symlink-target-');
  const linkParent = foreignDir('telepty-symlink-parent-');
  const link = path.join(linkParent, 'home-link');
  fs.symlinkSync(realDir, link, 'dir');

  const before = snapshot(realDir);
  track(createProvisionedTestHome('telepty-factory-'));

  assert.equal(snapshot(realDir), before, 'nothing may be written through a symlink');
  assert.equal(fs.existsSync(storePathFor(link)), false);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link itself is untouched');
});

test('a home with a lost .initialized marker stays refusing and is not rewritten', () => {
  const home = track(createProvisionedTestHome('telepty-factory-'));
  const storePath = storePathFor(home);
  const markerPath = persistence.conditionalInitializationPath(storePath);
  const ledgerBytes = fs.readFileSync(storePath);
  fs.rmSync(markerPath);

  // The product's verdict on a lost pair: unavailable, NOT "uninitialized". Lost state is a
  // recovery situation, and first initialization is never recovery.
  const loaded = loadStore(home);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'conditional_store_unavailable');
  assert.equal(loaded.detail, 'marker_store_mismatch');

  track(createProvisionedTestHome('telepty-factory-'));

  assert.equal(fs.existsSync(markerPath), false, 'the lost marker must not be re-minted');
  assert.deepEqual(fs.readFileSync(storePath), ledgerBytes, 'the surviving ledger is untouched');
});

test('a home with a corrupt store stays refusing and its bytes are preserved', () => {
  const home = track(createProvisionedTestHome('telepty-factory-'));
  const storePath = storePathFor(home);
  fs.writeFileSync(storePath, '{ not valid json');

  assert.equal(loadStore(home).ok, false);

  track(createProvisionedTestHome('telepty-factory-'));

  // Corrupt bytes are kept for diagnosis rather than auto-recovered or reset.
  assert.equal(fs.readFileSync(storePath, 'utf8'), '{ not valid json');
});

// ---------------------------------------------------------------------------
// 4. The read/write boundary, proved against a synthetic stand-in home
// ---------------------------------------------------------------------------

/**
 * Run `body` in a child process whose HOME is a synthetic directory dressed to look like a
 * developer's, with an fs spy recording every path read or written. Returns the recorded paths.
 *
 * A child process is what makes this non-vacuous: the preload moves HOME the moment it is required,
 * so in THIS process there is no pre-override home left to observe. The host's own home is never
 * named, read or written by any of it.
 */
function recordIoWithStandInHome(body) {
  const standInHome = foreignDir('telepty-stand-in-home-');
  const liveState = path.join(standInHome, '.telepty');
  fs.mkdirSync(liveState, { recursive: true });
  fs.writeFileSync(path.join(liveState, 'config.json'), '{"authToken":"live-token"}');
  fs.writeFileSync(path.join(liveState, 'sessions.json'), '{"orchestrator":{"pid":1}}');

  const controlledTmp = foreignDir('telepty-controlled-tmp-');
  const script = path.join(controlledTmp, 'io-spy.js');
  fs.writeFileSync(script, `
    const realFs = require('node:fs');
    const nodePath = require('node:path');
    const reads = [], writes = [];
    const WRITERS = ['writeFileSync', 'mkdirSync', 'mkdtempSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'renameSync', 'symlinkSync', 'openSync'];
    const READERS = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'readlinkSync'];
    for (const [names, sink] of [[WRITERS, writes], [READERS, reads]]) {
      for (const name of names) {
        const real = realFs[name];
        realFs[name] = function (p, ...rest) {
          try { if (typeof p === 'string') sink.push(nodePath.resolve(p)); } catch {}
          return real.call(this, p, ...rest);
        };
      }
    }
    const setupEnv = require(${JSON.stringify(path.join(SOURCE_ROOT, 'test-support/setup-env'))});
    const created = (${body.toString()})(setupEnv);
    process.stdout.write(JSON.stringify({ reads, writes, created, home: process.env.HOME }));
  `);

  const out = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: standInHome, USERPROFILE: standInHome, TMPDIR: controlledTmp }
  });
  return { standInHome, controlledTmp, ...JSON.parse(out) };
}

test('the factory writes only inside directories it created, never into the ambient HOME', () => {
  const io = recordIoWithStandInHome((setupEnv) => [
    setupEnv.createProvisionedTestHome('telepty-boundary-'),
    setupEnv.createProvisionedTestHome('telepty-boundary-')
  ]);

  const owned = [io.home, ...io.created].map((d) => path.resolve(d));
  const isOwned = (p) => owned.some((o) => p === o || p.startsWith(o + path.sep));
  // The mkdtemp TEMPLATE is a write request naming a direct child of the controlled root; the
  // directory it becomes is one of `owned`. Anything else under the root would be a stray.
  const isTemplate = (p) => path.dirname(p) === path.resolve(io.controlledTmp) && !fs.existsSync(p);

  assert.deepEqual(
    io.writes.filter((p) => !isOwned(p) && !isTemplate(p)), [],
    'every write must land inside a directory the factory itself created'
  );
  assert.deepEqual(
    io.writes.filter((p) => p.startsWith(path.resolve(io.standInHome) + path.sep) && !isOwned(p)), [],
    'the ambient HOME must receive no writes at all'
  );
  assert.equal(io.created.length, 2);
});

test('the stand-in HOME keeps its live state byte-for-byte and is never read', () => {
  const standIn = recordIoWithStandInHome((setupEnv) => setupEnv.createProvisionedTestHome('telepty-boundary-'));

  // Its pre-existing session/config bytes survive untouched…
  assert.equal(
    fs.readFileSync(path.join(standIn.standInHome, '.telepty', 'sessions.json'), 'utf8'),
    '{"orchestrator":{"pid":1}}',
    'a live-looking sessions.json must not be restored, rewritten or removed'
  );
  // …and nothing under it was even read. This is the #829 hazard in its original form: a product
  // module loaded before the override would have read exactly these paths.
  const liveState = path.resolve(standIn.standInHome, '.telepty');
  assert.deepEqual(
    standIn.reads.filter((p) => p === liveState || p.startsWith(liveState + path.sep)), [],
    'no test may read the contents of the home it was started with'
  );
});

test('HOME and USERPROFILE are overridden before any product module is loaded', () => {
  // #829, as a structural regression rather than a comment. A Module._load spy records the HOME in
  // force at the moment each product module is first required; the override must already have
  // happened. R2 regressed this by hoisting two store requires above the assignment.
  const controlledTmp = foreignDir('telepty-load-order-');
  const standInHome = foreignDir('telepty-load-order-home-');
  const spy = path.join(controlledTmp, 'load-order-spy.js');
  fs.writeFileSync(spy, `
    const Module = require('node:module');
    const nodePath = require('node:path');
    const SOURCE = ${JSON.stringify(SOURCE_ROOT)};
    const ambientHome = process.env.HOME;
    const tooEarly = [];
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch {}
      if (resolved && resolved.startsWith(nodePath.join(SOURCE, 'src') + nodePath.sep)
          && process.env.HOME === ambientHome) {
        tooEarly.push(nodePath.relative(SOURCE, resolved));
      }
      return realLoad.apply(this, arguments);
    };
    require(nodePath.join(SOURCE, 'test-support/setup-env'));
    process.stdout.write(JSON.stringify({ tooEarly, movedTo: process.env.HOME, ambientHome }));
  `);

  const result = JSON.parse(execFileSync(process.execPath, [spy], {
    encoding: 'utf8',
    env: { ...process.env, HOME: standInHome, USERPROFILE: standInHome, TMPDIR: controlledTmp }
  }));

  assert.deepEqual(result.tooEarly, [],
    'these product modules were required while HOME was still the ambient one');
  assert.notEqual(result.movedTo, result.ambientHome, 'the preload must actually move HOME');
  assert.equal(path.dirname(path.resolve(result.movedTo)), path.resolve(controlledTmp));
});

// ---------------------------------------------------------------------------
// 5. The preloaded HOME this very process runs in
// ---------------------------------------------------------------------------

test('the ambient test HOME was provisioned by the preload', () => {
  // setup-env.js mints its isolated HOME through the same private steps, so any test process gets a
  // ready store without a per-test hack. This is why the CI cascade is fixed at the fixture layer
  // rather than in each test.
  assert.equal(loadStore(os.homedir()).ok, true, 'the preloaded isolated HOME carries a ready store');

  const store = new ConditionalAdmissionStore({ path: storePathFor(os.homedir()) });
  assert.equal(store.initialize().ok, true);
  assert.equal(store.isFenced('any-unbound-sid'), false);
});

test('the isolated HOME is not the real HOME', () => {
  // #829 production-safety, restated as an assertion: these tests must not be operating on the
  // developer's live ~/.telepty.
  assert.match(path.resolve(os.homedir()), /telepty-test-home-/);
  assert.equal(path.dirname(path.resolve(os.homedir())), path.resolve(os.tmpdir()));
});
