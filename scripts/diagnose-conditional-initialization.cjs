#!/usr/bin/env node
'use strict';

// #1170 Windows first-initialization diagnostic. Standalone instrumentation ONLY: it changes no
// product code, gates no release, and cannot turn the red Windows regression green. Its single job
// is to recover the runtime errno that conditional-admission.js:611 and setup-env.js:126 discard,
// leaving `first_initialization_failed:conditional_initialization_failed` with no syscall attached.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const PERSISTENCE_REL = path.posix.join('src', 'session-store', 'persistence.js');
const CONDITIONAL_REL = path.posix.join('src', 'session-store', 'conditional-admission.js');
const ARTIFACT_NAME = 'conditional-initialization-diagnostic.json';
const STORE_SUBDIR = path.join('.config', 'aigentry-telepty');
const STORE_FILE = 'conditional-admissions.json';

// os.tmpdir() is read once, before this process mutates HOME/USERPROFILE, so both probe roots are
// resolved from the runner's real temp location and never from the home we are about to override.
const TMPDIR = os.tmpdir();

const createdRoots = [];

/** Own-root-relative placeholder. Anything outside a root we created is reported as <redacted>. */
function redact(value) {
  if (typeof value !== 'string' || value === '') return value === '' ? value : null;
  for (const { root, label } of createdRoots) {
    if (value === root) return `<${label}>`;
    if (value.startsWith(root + path.sep)) {
      return `<${label}>/${value.slice(root.length + 1).split(path.sep).join('/')}`;
    }
  }
  return '<redacted>';
}

/** Only the classifying fields. No stack, no message, no env, no tokens. */
function describeError(error) {
  if (!error || typeof error !== 'object') return { captured: false };
  return {
    captured: true,
    name: typeof error.name === 'string' ? error.name : null,
    code: error.code ?? null,
    errno: typeof error.errno === 'number' ? error.errno : null,
    syscall: error.syscall ?? null,
    path: 'path' in error ? redact(error.path) : null,
  };
}

function makeRoot(label, prefix) {
  // Register the raw mkdtemp path for cleanup BEFORE realpathSync, which can throw and would
  // otherwise leak a directory this probe created.
  const created = fs.mkdtempSync(path.join(TMPDIR, prefix));
  createdRoots.push({ root: created, label });
  const real = fs.realpathSync(created);
  if (real !== created) createdRoots.push({ root: real, label });
  return real;
}

function sha256(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Stage A — isolate the directory-handle idiom at persistence.js:427-428 into three separately
 * recorded steps, on a directory this probe just created. Each step's outcome stands alone so a
 * platform that opens a directory but refuses to fsync it is distinguishable from one that
 * refuses the open outright.
 */
function stageDirectoryHandle(root) {
  const dir = path.join(root, STORE_SUBDIR);
  const steps = { mkdir: null, open_directory: null, fsync_directory: null, close_directory: null };
  const step = (name, fn) => {
    try {
      fn();
      steps[name] = { ok: true, error: null };
      return true;
    } catch (error) {
      steps[name] = { ok: false, error: describeError(error) };
      return false;
    }
  };

  let dirFd = null;
  try {
    if (!step('mkdir', () => fs.mkdirSync(dir, { recursive: true }))) {
      return {
        directory: redact(dir),
        steps,
        first_operational_failure: 'mkdir',
        first_operational_error: steps.mkdir.error,
        cleanup_failed: false,
      };
    }
    if (step('open_directory', () => { dirFd = fs.openSync(dir, 'r'); })) {
      step('fsync_directory', () => fs.fsyncSync(dirFd));
    }
  } finally {
    // The close is itself a recorded step, but a cleanup failure must never overwrite the
    // open/fsync result that is the actual measurement.
    if (dirFd !== null) {
      step('close_directory', () => fs.closeSync(dirFd));
      dirFd = null;
    }
  }

  // The operational chain is the measurement; the close is cleanup integrity. They are reported
  // separately so a leaked handle can never be mistaken for the platform's open/fsync verdict.
  const operational = ['mkdir', 'open_directory', 'fsync_directory'];
  const firstOperational = operational.find(name => steps[name] && steps[name].ok === false) ?? null;
  return {
    directory: redact(dir),
    steps,
    first_operational_failure: firstOperational,
    first_operational_error: firstOperational ? steps[firstOperational].error : null,
    cleanup_failed: Boolean(steps.close_directory && steps.close_directory.ok === false),
  };
}

/**
 * Stage B — call the exported product function on an independently fresh root with an explicit
 * store path, using the pristine ledger/marker exactly as conditional-admission.js:604-608 mints
 * it. This is the one hop that still carries `error` (persistence.js:436), so it yields the errno
 * the refusal string drops. The product is invoked, never simulated.
 */
function stageProductInitialize(root, persistence) {
  const storePath = path.join(root, STORE_SUBDIR, STORE_FILE);
  const ledger = persistence.emptyConditionalAdmissions();
  ledger.marker = {
    marker_id: crypto.randomUUID(),
    initialized_at: new Date(Date.now()).toISOString(),
  };

  let result;
  try {
    result = persistence.initializeConditionalAdmissions(ledger, storePath);
  } catch (error) {
    // initializeConditionalAdmissions is documented to return, not throw; a throw is a probe-level
    // surprise worth failing on rather than recording as a product observation.
    return { store_path: redact(storePath), threw: true, error: describeError(error), harness_error: true };
  }

  const markerPath = persistence.conditionalInitializationPath(storePath);
  // Only ENOENT proves absence. Any other lstat error is reported as unknown with its errno, never
  // collapsed into "not present" — that collapse is exactly the inference this task rejects.
  const presence = p => {
    try {
      fs.lstatSync(p);
      return { present: true };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { present: false };
      return { present: 'unknown', error: describeError(error) };
    }
  };

  return {
    store_path: redact(storePath),
    threw: false,
    harness_error: false,
    ok: result.ok === true,
    reason: result.reason ?? null,
    error: describeError(result.error),
    // Fail-closed comparison: on refusal neither artifact may be silently completed or recreated.
    artifacts_after_call: { ledger: presence(storePath), marker: presence(markerPath) },
  };
}

function main() {
  const report = {
    diagnostic: 'conditional-initialization',
    task: 1170,
    generated_at: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      os_release: os.release(),
    },
    source_sha256: {
      [PERSISTENCE_REL]: sha256(path.join(REPO_ROOT, 'src', 'session-store', 'persistence.js')),
      [CONDITIONAL_REL]: sha256(path.join(REPO_ROOT, 'src', 'session-store', 'conditional-admission.js')),
    },
    stages: { directory_handle: null, product_initialize: null },
    cleanup: [],
    harness_error: null,
  };

  let failed = false;
  try {
    const rootA = makeRoot('rootA', 'telepty-diag-a-');
    const rootB = makeRoot('rootB', 'telepty-diag-b-');

    // HOME/USERPROFILE are redirected to an owned root BEFORE the product is first required, so no
    // default-path resolution inside the module can ever reach the real home.
    process.env.HOME = rootB;
    process.env.USERPROFILE = rootB;
    const persistence = require(path.join(REPO_ROOT, 'src', 'session-store', 'persistence.js'));

    report.stages.directory_handle = stageDirectoryHandle(rootA);
    report.stages.product_initialize = stageProductInitialize(rootB, persistence);

    // Setup failures are probe failures. A refused open/fsync/close, or a product refusal, is the
    // measurement this job exists to capture and is reported at exit 0 with the errno attached.
    if (report.stages.directory_handle.first_operational_failure === 'mkdir'
      || report.stages.directory_handle.cleanup_failed
      || report.stages.product_initialize.harness_error) {
      failed = true;
    }
  } catch (error) {
    report.harness_error = describeError(error);
    failed = true;
  } finally {
    for (const { root, label } of createdRoots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        report.cleanup.push({ root: `<${label}>`, removed: true, error: null });
      } catch (error) {
        report.cleanup.push({ root: `<${label}>`, removed: false, error: describeError(error) });
      }
    }
  }

  const stageB = report.stages.product_initialize;
  // A source file we cannot hash means the artifact cannot attest what was measured.
  const missingHashes = Object.entries(report.source_sha256)
    .filter(([, value]) => value === null).map(([key]) => key);
  const cleanupFailed = report.cleanup.some(entry => entry.removed === false);
  if (missingHashes.length > 0 || cleanupFailed) failed = true;

  report.outcome = {
    // A reproduced refusal is a successful MEASUREMENT of a still-failing product, never a
    // Windows pass and never a reason to call the regression green.
    product_refusal_reproduced: Boolean(stageB && stageB.threw === false && stageB.ok === false),
    measurement_complete: Boolean(
      report.stages.directory_handle && stageB && !stageB.harness_error && !report.harness_error,
    ),
    missing_source_hashes: missingHashes,
    cleanup_failed: cleanupFailed || Boolean(
      report.stages.directory_handle && report.stages.directory_handle.cleanup_failed,
    ),
    probe_failed: failed,
  };

  const artifactPath = path.join(REPO_ROOT, ARTIFACT_NAME);
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // Nonzero only for probe/harness failure. A product refusal is the observation we came for and
  // must not be laundered into a green step, nor must a broken probe vanish as exit 0.
  process.exitCode = failed ? 1 : 0;
}

main();
