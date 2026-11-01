'use strict';

// #910 — the production daemon never claims daemon-state.json.
//
// `daemon.js` guards its singleton claim on `require.main === module` ALONE. In production the
// launchd plist runs `telepty daemon` → cli.js → `require('./daemon.js')`, so `require.main` is
// cli.js and the claim never runs. Measured on the operator host: a live daemon (pid 98714) with
// no `~/.telepty/daemon-state.json` at all.
//
// #896 fixed exactly this guard for the process TITLE three lines above
// (`require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1'`) and left the
// claim on the old one. cli.js sets that env flag immediately before the require (cli.js:1699),
// so it is the signal that separates "a real daemon is booting" from "a test wants the exports".
//
// Consequences of the claim never running, all of them live today:
//   • no singleton guard — a second daemon does not detect the first through the state file
//   • `scripts/postinstall.js` gates its upgrade on the state file, so `npm i -g` reports
//     "No running daemon detected — nothing to restart" and never upgrades a running daemon
//   • #902's D1.2 state-file port gate has nothing to read
//
// Isolation: every daemon here binds PORT=0 under its own temp HOME, and the only processes these
// tests signal are their own children.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(projectRoot, 'daemon.js');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty910-'));
}

function statePath(homeDir) {
  return path.join(homeDir, '.telepty', 'daemon-state.json');
}

// Boot daemon.js the way a caller does, in a child process with its own HOME.
//   asDaemonMain: true  → the PRODUCTION shape (cli.js sets the env flag, then requires)
//   asDaemonMain: false → a bare test require (#896's contract: claims nothing)
function bootDaemonChild(homeDir, { asDaemonMain }) {
  const script = asDaemonMain
    ? `process.env.AIGENTRY_TELEPTY_DAEMON_MAIN='1'; require(${JSON.stringify(DAEMON_JS)});`
    : `require(${JSON.stringify(DAEMON_JS)});`;

  return spawn(process.execPath, ['-e', script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PORT: '0',                    // OS-assigned: never the operator's 3848
      TELEPTY_NO_TAILNET_AUTO: '1',
    },
    stdio: 'ignore',
  });
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('#910: a daemon booted the way cli.js boots it claims daemon-state.json', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, { asDaemonMain: true });
  try {
    const claimed = await waitFor(() => fs.existsSync(statePath(homeDir)));
    assert.equal(
      claimed,
      true,
      'the production launch path (env flag set, require.main = cli.js) must write daemon-state.json'
    );

    const state = JSON.parse(fs.readFileSync(statePath(homeDir), 'utf8'));
    assert.equal(state.pid, child.pid, 'the claim records the daemon process that made it');
    assert.ok(state.version, 'the claim records the version postinstall compares against');
    assert.ok(Object.prototype.hasOwnProperty.call(state, 'port'), 'the claim records the port #902 D1.2 gates on');
  } finally {
    child.kill('SIGKILL');
  }
});

test('#910: a bare test require still claims nothing (#896 contract)', async () => {
  const homeDir = tempHome();
  const child = bootDaemonChild(homeDir, { asDaemonMain: false });
  try {
    // Give it the same budget the positive case gets, then assert the ABSENCE.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(
      fs.existsSync(statePath(homeDir)),
      false,
      'requiring daemon.js for its exports must never overwrite a live daemon\'s claim'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

// Guard (green both sides): postinstall's upgrade path is gated on the state file existing, so
// this is what #910 unblocks in production. Unit-level — no real install, every seam injected.
test('#910: postinstall reaches its upgrade path once a state file exists', async () => {
  const postinstall = require('../scripts/postinstall.js');
  const logs = [];
  let cleanupCalled = 0;
  let respawnCalls = 0;
  let respawnArgs = null;
  let resolveBinCalls = 0;

  await postinstall.main({
    env: { npm_config_global: 'true' }, // postinstall only acts on a GLOBAL install
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    readDaemonState: () => ({ pid: 4242, port: 3848, version: '0.0.1-stale' }),
    detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    cleanupDaemonProcesses: () => { cleanupCalled += 1; return { stopped: [], failed: [] }; },
    // The spawn seam is the load-bearing injection: without it the real
    // `spawnDetachedDaemon()` runs, postinstall.main() returns while a REAL detached daemon it
    // spawned is still starting — a process this test has no business creating (it would target
    // :3848, the operator's port) and the leaked async activity node:test reports after the test
    // ends. The bin seam below is deliberately INERT: #1228 stopped main() from consulting the
    // PATH `telepty` at all, so it is kept only to DETECT a regression back to it.
    resolveTeleptyBin: () => { resolveBinCalls += 1; return '/nonexistent/telepty'; },
    spawnDetachedDaemon: (...args) => { respawnCalls += 1; respawnArgs = args; },
  });

  assert.equal(cleanupCalled, 1, 'a stale running daemon is what postinstall exists to replace');
  assert.equal(respawnCalls, 1, 'the upgrade path ran to its respawn — through the seam, spawning nothing');
  // #1228: the replacement daemon is THIS package's cli.js by construction. main() hands the
  // seam NO argument, so `spawnDetachedDaemon`'s own `path.join(__dirname,'..','cli.js')`
  // default decides — never whatever currently owns the `telepty` link on PATH.
  assert.deepEqual(respawnArgs, [], 'no caller-provided binary may reach the spawn seam');
  assert.equal(resolveBinCalls, 0, 'resolving the PATH `telepty` is exactly the #1228 regression this discriminates');
  assert.equal(
    logs.some((m) => /No running daemon detected/.test(m)),
    false,
    'that early return is the branch #910 stops production from taking every time'
  );
});

// Task 1215 repro141 (RED by design against 55568519; a reproduction, not a product fix). External-reader invariant
// of daemon-state.json publication: with an existing COMPLETE self-owned claim, a reader that runs while a
// replacement is in progress must see the previous complete claim, and after publication the new complete claim.
// It must never see an empty or partial document, which the public reader reports as null.
//
// Barrier:
// - In-process the replacement is one synchronous call, so a reader can only observe its intermediate states at a
//   pause point. While the replacement claim runs, the fs write calls that touch the owned state directory are
//   wrapped with the SAME genuine operations: open (which creates or truncates), then a probe; write the first half,
//   then a probe; write the rest, close, then a probe. The same probe also runs after any write-capable open, write or
//   rename in that directory. A temp-and-rename publication is therefore exercised as well, and the case cannot pass
//   vacuously.
// - The probe is the real public readDaemonState() plus the final file's byte length.
// - The fixture claim is this test process's own identity, in the preload-isolated test HOME. No real daemon or
//   other PID is consulted.
// - Every patched fs function is restored in finally.
// Source-predicted RED today: writeDaemonState truncates the FINAL path first (daemon-control.js:59-62), so the probe
// after create/truncate observes null at 0 bytes. The CI empty-vs-partial length at :83 was not recorded.
test('[1215-red141] a reader during a paused claim replacement sees the previous or the new complete claim, never empty/partial', () => {
  const daemonControl = require('../daemon-control');
  const { claimDaemonState, readDaemonState, clearDaemonState, DAEMON_STATE_FILE } = daemonControl;
  const home = os.homedir(), stateDir = path.dirname(DAEMON_STATE_FILE);
  // PRECONDITIONS (failures, never skips): only the preload-isolated test HOME may hold this fixture claim.
  assert.match(path.basename(home), /^telepty-test-home-/, 'PRECONDITION: HOME must be the preload-isolated test home');
  assert.ok(DAEMON_STATE_FILE.startsWith(home + path.sep), 'PRECONDITION: the state file lives under the isolated HOME');
  assert.equal(fs.existsSync(DAEMON_STATE_FILE), false, 'PRECONDITION: no prior claim in the isolated home');

  const same = require('node:util').isDeepStrictEqual;
  const original = { openSync: fs.openSync, writeSync: fs.writeSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  const observations = [], hookErrors = [], trackedFds = new Set();
  let inProbe = false, previous = null;
  const inStateDir = (p) => typeof p === 'string' && path.dirname(path.resolve(p)) === stateDir;
  const writable = (flags) => typeof flags === 'number'
    ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0
    : typeof flags === 'string' && /[wa+]/.test(flags);
  const probe = (boundary) => {
    if (inProbe || observations.length >= 32) return;
    inProbe = true;
    try {
      let bytes = null; try { bytes = fs.statSync(DAEMON_STATE_FILE).size; } catch (e) { bytes = e.code === 'ENOENT' ? 'absent' : 'stat_error'; }
      observations.push({ boundary, bytes, state: readDaemonState() });
    } catch (e) { hookErrors.push({ boundary, error: e && e.code ? e.code : 'probe_error' }); }
    finally { inProbe = false; }
  };
  try {
    // 1. Initial publication (no barrier): absent before, then a complete self-owned claim.
    const first = claimDaemonState({ host: '127.0.0.1', port: 0, version: '1215-red141-initial' });
    assert.equal(first.claimed, true, 'CONTROL: the fixture can publish its own first claim');
    assert.deepEqual(readDaemonState(), first.state, 'CONTROL: the public reader returns the complete first claim');
    previous = first.state;

    // 2. Replacement through the barrier.
    fs.openSync = function (p, flags, ...rest) {
      const fd = original.openSync.call(fs, p, flags, ...rest);
      if (inStateDir(p) && writable(flags === undefined ? 'r' : flags)) { trackedFds.add(fd); probe('after-create-or-truncate'); }
      return fd;
    };
    fs.writeSync = function (fd, ...rest) { const n = original.writeSync.call(fs, fd, ...rest); if (trackedFds.has(fd)) probe('after-write'); return n; };
    fs.closeSync = function (fd) { trackedFds.delete(fd); return original.closeSync.call(fs, fd); };
    fs.writeFileSync = function (file, data, options) {
      if (!inStateDir(file)) return original.writeFileSync.call(fs, file, data, options);
      const opts = typeof options === 'string' ? { encoding: options } : (options || {});
      const bytes = typeof data === 'string' ? Buffer.from(data, opts.encoding || 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const fd = original.openSync.call(fs, file, opts.flag || 'w', opts.mode === undefined ? 0o666 : opts.mode); // genuine create/truncate
      try {
        probe('after-create-or-truncate');
        const half = Math.floor(bytes.length / 2);
        let offset = 0;
        while (offset < half) offset += original.writeSync.call(fs, fd, bytes, offset, half - offset);
        if (half > 0) probe('after-partial-write');
        while (offset < bytes.length) offset += original.writeSync.call(fs, fd, bytes, offset, bytes.length - offset);
      } finally { original.closeSync.call(fs, fd); }
      probe('after-complete-write');
    };
    fs.renameSync = function (from, to) { const r = original.renameSync.call(fs, from, to); if (inStateDir(to)) probe('after-rename'); return r; };
    let second;
    try { second = claimDaemonState({ host: '127.0.0.1', port: 0, version: '1215-red141-replacement' }); }
    finally { Object.assign(fs, original); }
    assert.ok(Object.keys(original).every((name) => fs[name] === original[name]), 'CONTROL: every patched fs function was restored');

    // 3. Truthful outcome. Test-hook health is checked first, then non-vacuity, then the contract.
    assert.deepEqual(hookErrors, [], 'TEST HOOK FAILURE (not a product result): the reader probe itself failed');
    assert.equal(second.claimed, true, 'CONTROL: the self-owned replacement is admitted');
    const seen = observations.map(({ boundary, bytes, state }) => ({ boundary, bytes,
      seen: state === null ? 'null' : same(state, previous) ? 'previous' : same(state, second.state) ? 'new' : 'other' }));
    assert.ok(seen.some((o) => o.boundary === 'after-create-or-truncate'),
      `NON-VACUITY: the replacement must create or truncate a file in the owned state directory while the reader probes ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.filter((o) => o.seen !== 'previous' && o.seen !== 'new'), [],
      `the reader saw neither the previous nor the new complete claim during replacement ${JSON.stringify(seen)}`);
    const firstNew = seen.findIndex((o) => o.seen === 'new');
    assert.ok(firstNew === -1 || seen.slice(firstNew).every((o) => o.seen === 'new'), `once published, the new claim never reverts ${JSON.stringify(seen)}`);
    assert.deepEqual(readDaemonState(), second.state, 'after publication the reader returns the new complete claim');
  } finally {
    Object.assign(fs, original);
    clearDaemonState(process.pid); // owned claim only (removes it only while it names this process)
  }
});
