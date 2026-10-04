// Test-env hygiene (#555): strip ambient TELEPTY_SESSION_ID before any test runs.
//
// `telepty inject` auto-stamps `from = TELEPTY_SESSION_ID` when `--from` is omitted
// (cli.js). That convenience is intentional for real sessions, but when the suite is
// run from a telepty session shell the test process inherits a real session id and
// leaks it into spawned cli.js subprocesses (the harness builds spawn env from
// `...process.env`), producing local-only reds that are CLEAN in CI where the var is
// unset. Loaded via `node --require` so it runs at startup in every test process,
// the deletion keeps the suite deterministic regardless of the ambient environment.
// Tests that need a session id still set it explicitly via their spawn env override.
delete process.env.TELEPTY_SESSION_ID;

// #672 tailnet auto-bind: the suite must be deterministic regardless of whether the host
// running it is on a Tailscale tailnet. Default the opt-out so spawned daemons bind
// loopback (the #50 policy the integration tests assert) instead of the host's live
// tailnet IP; the spawn harness builds child env from `...process.env`, so this
// propagates to spawned daemons. The tailnet path itself is covered by the pure decision
// fns (test/tailnet-autobind.test.js), not a live bind. A test can override by setting
// TELEPTY_NO_TAILNET_AUTO explicitly in its spawn env.
if (process.env.TELEPTY_NO_TAILNET_AUTO == null) process.env.TELEPTY_NO_TAILNET_AUTO = '1';

// #829 PRODUCTION-SAFETY: give every test process its own HOME, before anything reads one.
//
// Every state path in the product resolves through `os.homedir()` — the session store
// (src/session-store/persistence.js), the tracked-injection ledger, the audit log
// (daemon.js AUDIT_LOG_PATH), config (src/config-file.js), sessions (src/lifecycle.js).
// `os.homedir()` reads $HOME on POSIX at call time, so until this line ran, a test that did a
// bare `require('../daemon')` — several unit suites do, for the exported pure seams — loaded the
// developer's REAL ~/.telepty, RESTORED the live sessions found there, and began supervising
// them. Observed on this host: `orchestrator`, `r4x`, `s820` and `m808` restored by a unit test,
// with the process then spinning at ~96% CPU. The orchestrator session dispatching the suite was
// among them.
//
// That is a production-safety hazard, not untidiness: a test run must never touch live session
// state. It is also the likely head of the chain behind #822/#828 — a process supervising real
// sessions has timers it will never clear, so it cannot exit, which is what made the truncating
// `--test-force-exit` feel mandatory in the first place.
//
// The spawn harness already does exactly this per daemon (test-support/daemon-harness.js:62-67);
// this closes the gap for the in-process case. Set before any product module is required,
// because `--require` runs this file first. USERPROFILE too: `os.homedir()` reads that on win32.
//
// Deliberately NOT overridable. A test that needs the real HOME is a finding to be named, not a
// case to be special-cased quietly.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// T0 (#1170) FRESH-STORE PROVISIONING.
//
// A synthetic HOME has no conditional-admission store, and by design never grows one on its own:
// `loadConditionalAdmissions` (src/session-store/persistence.js) returns
// `conditional_store_not_initialized` when neither the ledger nor its `.initialized` marker
// exists, and `isFenced()` (src/session-store/conditional-admission.js) then fails CLOSED for
// every sid. That production behaviour is correct and is not relaxed here — absence never implies
// a new installation.
//
// The fixture's one narrow exception is grounded in CREATION, not inspection. `mkdtempSync` is the
// only thing that can tell us a directory is new, so the call that creates the directory is also
// the call that initializes it, and nothing else can reach the initializer. There is deliberately
// no way to ask this module to initialize a path you hand it: an exported path-taking provisioner
// could be pointed at a caller-owned or previously-used directory, and emptiness would not
// distinguish those from a fresh one.

// The controlled roots a fresh home may be minted under, selected by KEY rather than by path, so
// no caller can nominate a location. `shortSocketPath` exists because a darwin daemon's unix
// socket must stay inside the 104-byte sun_path limit, which /var/folders/... does not leave room
// for (test-support/bridge-pipe-harness.js, #732).
const TMP_BASES = {
  default: () => os.tmpdir(),
  shortSocketPath: () => (process.platform === 'darwin' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())
};

// A prefix names a directory; it must not be able to choose one. `mkdtempSync` appends six random
// characters to whatever string it is given, so an unvalidated prefix is concatenated straight into
// a path: '../escaped-' walks out of the controlled root, 'sub/inner-' walks into a directory the
// caller picked, and on win32 a backslash, drive letter or UNC prefix does the same. The allowlist
// below admits exactly one plain path segment, which is the whole of what a prefix is for.
const PLAIN_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

function assertPlainPrefix(prefix) {
  if (typeof prefix !== 'string') {
    throw new TypeError(
      `createProvisionedTestHome: prefix must be a string, got ${Object.prototype.toString.call(prefix)}`
    );
  }
  if (!PLAIN_SEGMENT.test(prefix) || prefix.includes('..')) {
    throw new Error(
      `createProvisionedTestHome: prefix ${JSON.stringify(prefix)} is not a plain name; `
      + 'separators, dot-dot, drive letters and UNC roots would relocate the created home'
    );
  }
}

// Private. Mints a brand-new directory under a controlled root and returns it. Split out from the
// initializer only so the preload below can install its HOME override in between the two — see the
// load-order note there. Both call sites are in this file and both initialize exactly the path this
// function just created; nothing takes a caller-supplied directory.
function mintFreshHome(prefix, baseKind) {
  assertPlainPrefix(prefix);
  const base = (TMP_BASES[baseKind] || TMP_BASES.default)();
  const createdHome = fs.mkdtempSync(path.join(base, prefix));
  // Belt-and-braces: the created home is a direct child of the root we chose, never elsewhere.
  if (path.dirname(path.resolve(createdHome)) !== path.resolve(base)) {
    throw new Error(`createProvisionedTestHome: prefix relocated the created home to ${createdHome}`);
  }
  return createdHome;
}

// Private. Only ever called with the return value of a `mintFreshHome` call directly above it; it
// is not exported and takes no caller-supplied path.
function initializeStoreInNewlyCreatedHome(createdHome) {
  // Required lazily, on purpose. The #829 override above must already be in effect before ANY
  // product module is loaded — a module-scope require here would run before the override and hand
  // the developer's real HOME to any module that resolves a state path at load time.
  const { ConditionalAdmissionStore } = require('../src/session-store/conditional-admission');
  const persistence = require('../src/session-store/persistence');
  // The package's own explicit first-init route — the method the authenticated controller handler
  // calls after its intent check. It refuses on any pre-existing evidence, so a collision would
  // surface as a throw rather than a silent overwrite. No ledger bytes are fabricated here: the
  // marker and the empty ledger are minted by the package.
  const storePath = persistence.defaultConditionalAdmissionsPath(createdHome);
  const store = new ConditionalAdmissionStore({ path: storePath });
  const result = store.initializeNewStore();
  if (!result.ok) {
    throw new Error(
      `createProvisionedTestHome: first initialization refused for ${storePath}: `
      + `${result.reason || result.code || 'unknown'}`
    );
  }
  return { marker_id: result.marker_id, storePath };
}

/**
 * Create a brand-new synthetic HOME and initialize its conditional-admission store.
 *
 * Creation and initialization are deliberately inseparable: the directory is minted here, so its
 * newness is known rather than inferred. A directory this factory did not create cannot be passed
 * in, which is what keeps caller-owned, reused-then-cleared, symlinked and already-initialized
 * directories out of the initializer entirely.
 *
 * A failure throws — an unprovisionable fixture is a hard red, never a silent skip, and never a
 * recovery or reset of a store somebody else owns.
 *
 * @param {string} [prefix] - one plain name segment, for recognisable directories in diagnostics.
 * @param {object} [options]
 * @param {'default'|'shortSocketPath'} [options.baseKind] - which controlled tmp root to mint under.
 * @returns {string} absolute path of the created, provisioned home.
 */
function createProvisionedTestHome(prefix = 'telepty-test-home-', { baseKind = 'default' } = {}) {
  const createdHome = mintFreshHome(prefix, baseKind);
  initializeStoreInNewlyCreatedHome(createdHome);
  return createdHome;
}

// LOAD ORDER, load-bearing: mint the directory, move HOME onto it, and only then initialize. The
// initializer is the first thing in this file that touches product code, so doing it last is what
// keeps the #829 promise that no product module ever observes the developer's real HOME. Calling
// the public factory here instead would load those modules one line too early.
const isolatedHome = mintFreshHome('telepty-test-home-', 'default');
process.env.HOME = isolatedHome;
if (process.platform === 'win32') process.env.USERPROFILE = isolatedHome;
initializeStoreInNewlyCreatedHome(isolatedHome);

// Best-effort: a process that exits cleanly takes its temp home with it. A process that hangs
// (#822) leaks one empty directory into the OS temp dir, which is the lesser problem by far.
process.on('exit', () => {
  try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

// The factory is exported so the spawn harness mints daemon homes through it rather than growing
// its own copy. The initializer itself is not exported and cannot be aimed at an arbitrary path.
module.exports = { createProvisionedTestHome };
