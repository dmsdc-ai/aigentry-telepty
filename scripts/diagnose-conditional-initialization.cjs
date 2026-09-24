#!/usr/bin/env node
'use strict';

// #1170 Windows first-initialization diagnostic. Standalone instrumentation ONLY: it changes no
// product code, gates no release, and cannot turn the red Windows regression green. Its single job
// is to recover the runtime errno that conditional-admission.js:611 and setup-env.js:126 discard,
// leaving `first_initialization_failed:conditional_initialization_failed` with no syscall attached.
//
// Stage B additionally traces the REAL fsync calls that initializeConditionalAdmissions makes, so
// the recovered errno is attributed to an actual descriptor instead of being guessed. Static
// evidence alone permits BOTH the marker-file fsync at persistence.js:424 and the directory fsync
// at persistence.js:428; the two share `EPERM`/-4048 on Windows, so only tracing the calls
// themselves separates them. The trace observes, it never substitutes: no product operation is
// mocked, skipped, swallowed, retried or reordered, and an observation that fails is reported as an
// explicit unknown rather than being allowed to change what the product did.

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
// The trace is bounded so a pathological call volume can never grow the artifact without limit.
// Truncation drops only LATER events: the first failing fsync is recorded when it happens and is
// therefore still exact if the tail is cut.
const MAX_TRACE_EVENTS = 64;
const UNKNOWN_TARGET = { role: 'unknown', path: null, open_seq: null };

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
 * Exact own-root path classification. A descriptor is named by WHICH file or directory it was
 * opened on, never by inferring a kind from the errno that came back — that inference is precisely
 * what this task rejects. The temporary-ledger form mirrors the name writeConditionalAdmissions
 * mints at persistence.js:290.
 */
function classifyStorePath(storeDir, storePath, markerPath) {
  const TMP_PREFIX = '.conditional-admissions.';
  return value => {
    if (typeof value !== 'string' || value === '') return 'unknown';
    if (value === markerPath) return 'marker_file';
    if (value === storePath) return 'ledger_file';
    if (value === storeDir) return 'store_directory';
    if (path.dirname(value) === storeDir && path.basename(value).startsWith(TMP_PREFIX)) {
      return 'ledger_tmp_file';
    }
    return 'other';
  };
}

/**
 * Bounded Stage B tracer over the product's own fs calls.
 *
 * persistence.js holds the `node:fs` module object and resolves `fs.fsyncSync` at call time, so
 * replacing the property on that same object observes the genuine callsites. Each wrapper invokes
 * the original EXACTLY ONCE with unchanged `this` and unchanged arguments, and returns its result
 * or rethrows its error object untouched. open/close are traced only to keep the descriptor -> path
 * mapping correct across fd-number reuse (the marker fd is closed at persistence.js:425 immediately
 * before the directory is opened at :427, and the OS may hand back the same number). Every
 * bookkeeping step runs inside `observe`, so a defect in the observation records an explicit
 * unknown and can never alter the product's arguments, result or error.
 */
function createStageBTracer(classify) {
  const trace = {
    installed: false,
    restored: null,
    truncated: false,
    observation_error: null,
    fsync_call_count: 0,
    first_fsync_failure: null,
    failing_fsync_target: 'unknown',
    events: [],
  };
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync };
  const fdTargets = new Map();
  let seq = 0;

  const observe = fn => {
    try {
      return fn();
    } catch (error) {
      if (trace.observation_error === null) {
        try { trace.observation_error = describeError(error); } catch { /* unrecordable */ }
      }
      return null;
    }
  };
  const record = entry => {
    if (trace.events.length >= MAX_TRACE_EVENTS) { trace.truncated = true; return; }
    trace.events.push(entry);
  };
  const targetForPath = value => ({ role: classify(value), path: redact(value), open_seq: null });
  const targetForFd = fd => fdTargets.get(fd) ?? UNKNOWN_TARGET;

  const wrapped = {
    openSync(...args) {
      const at = ++seq;
      const target = observe(() => targetForPath(args[0])) ?? UNKNOWN_TARGET;
      let fd;
      try {
        fd = original.openSync.apply(this, args);
      } catch (error) {
        observe(() => record({ seq: at, call: 'openSync', ...target, ok: false, error: describeError(error) }));
        throw error;
      }
      observe(() => {
        fdTargets.set(fd, { role: target.role, path: target.path, open_seq: at });
        record({ seq: at, call: 'openSync', ...target, open_seq: at, ok: true, error: null });
      });
      return fd;
    },
    fsyncSync(...args) {
      const at = ++seq;
      const target = observe(() => targetForFd(args[0])) ?? UNKNOWN_TARGET;
      observe(() => { trace.fsync_call_count += 1; });
      try {
        const result = original.fsyncSync.apply(this, args);
        observe(() => record({ seq: at, call: 'fsyncSync', ...target, ok: true, error: null }));
        return result;
      } catch (error) {
        observe(() => {
          const entry = { seq: at, call: 'fsyncSync', ...target, ok: false, error: describeError(error) };
          record(entry);
          // Set from the entry itself, not from the (possibly truncated) event list, so the first
          // refusal survives even if the tail of the trace is cut.
          if (trace.first_fsync_failure === null) trace.first_fsync_failure = entry;
        });
        throw error;
      }
    },
    closeSync(...args) {
      const at = ++seq;
      const target = observe(() => targetForFd(args[0])) ?? UNKNOWN_TARGET;
      try {
        const result = original.closeSync.apply(this, args);
        observe(() => {
          // Only a CONFIRMED close releases the number; a failed close leaves the mapping in place
          // rather than letting a later reuse be attributed to the wrong path.
          fdTargets.delete(args[0]);
          record({ seq: at, call: 'closeSync', ...target, ok: true, error: null });
        });
        return result;
      } catch (error) {
        observe(() => record({ seq: at, call: 'closeSync', ...target, ok: false, error: describeError(error) }));
        throw error;
      }
    },
  };

  const restore = () => {
    try {
      fs.openSync = original.openSync;
      fs.closeSync = original.closeSync;
      fs.fsyncSync = original.fsyncSync;
      trace.restored = fs.openSync === original.openSync
        && fs.closeSync === original.closeSync
        && fs.fsyncSync === original.fsyncSync;
    } catch (error) {
      trace.restored = false;
      if (trace.observation_error === null) trace.observation_error = describeError(error);
    }
  };

  return {
    trace,
    install() {
      try {
        fs.openSync = wrapped.openSync;
        fs.fsyncSync = wrapped.fsyncSync;
        fs.closeSync = wrapped.closeSync;
        trace.installed = true;
      } catch (error) {
        // A partially installed tracer is worse than none: undo it and run the product bare.
        trace.installed = false;
        trace.observation_error = describeError(error);
        restore();
      }
    },
    restore,
  };
}

/**
 * Which fsync the platform actually refused. Anything the trace could not observe cleanly is
 * `unknown` — never a guess, and never a default to one of the two candidate callsites.
 */
function resolveFsyncTarget(trace) {
  if (!trace.installed || trace.observation_error) return 'unknown';
  if (trace.first_fsync_failure) return trace.first_fsync_failure.role;
  if (trace.fsync_call_count === 0) return 'no_fsync_call_observed';
  return 'no_fsync_failure_observed';
}

/**
 * Stage B — call the exported product function on an independently fresh root with an explicit
 * store path, using the pristine ledger/marker exactly as conditional-admission.js:604-608 mints
 * it. This is the one hop that still carries `error` (persistence.js:436), so it yields the errno
 * the refusal string drops. The product is invoked, never simulated; the tracer around the call
 * names the descriptor that errno belongs to and is removed again in `finally`.
 */
function stageProductInitialize(root, persistence) {
  const storePath = path.join(root, STORE_SUBDIR, STORE_FILE);
  const markerPath = persistence.conditionalInitializationPath(storePath);
  const storeDir = path.dirname(storePath);
  const ledger = persistence.emptyConditionalAdmissions();
  ledger.marker = {
    marker_id: crypto.randomUUID(),
    initialized_at: new Date(Date.now()).toISOString(),
  };

  const tracer = createStageBTracer(classifyStorePath(storeDir, storePath, markerPath));
  let result = null;
  let thrown = null;
  tracer.install();
  try {
    result = persistence.initializeConditionalAdmissions(ledger, storePath);
  } catch (error) {
    thrown = error;
  } finally {
    // The wrappers come off whatever the product did, so nothing downstream — including this
    // probe's own presence checks and artifact write — runs through instrumented fs.
    tracer.restore();
  }
  const fsyncTrace = tracer.trace;
  fsyncTrace.failing_fsync_target = resolveFsyncTarget(fsyncTrace);

  if (thrown !== null) {
    // initializeConditionalAdmissions is documented to return, not throw; a throw is a probe-level
    // surprise worth failing on rather than recording as a product observation.
    return {
      store_path: redact(storePath),
      threw: true,
      error: describeError(thrown),
      harness_error: true,
      fsync_trace: fsyncTrace,
    };
  }

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
    // Which real descriptor each fsync ran on, in call order. This is the measurement that tells
    // persistence.js:424 (marker file) apart from persistence.js:428 (store directory).
    fsync_trace: fsyncTrace,
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
    // Reported beside the other outcome flags, never folded into them: an unobservable trace is an
    // unknown attribution, not a probe failure and not a product verdict.
    failing_fsync_target: stageB && stageB.fsync_trace
      ? stageB.fsync_trace.failing_fsync_target : 'unknown',
  };

  const artifactPath = path.join(REPO_ROOT, ARTIFACT_NAME);
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // Nonzero only for probe/harness failure. A product refusal is the observation we came for and
  // must not be laundered into a green step, nor must a broken probe vanish as exit 0.
  process.exitCode = failed ? 1 : 0;
}

main();
