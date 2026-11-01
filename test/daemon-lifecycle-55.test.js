'use strict';

// telepty#55 — daemon lifecycle surface: `telepty daemon start|stop|restart`.
//
// PROBLEM (0.6.5, observed Windows + 0.6.1/0.6.3): cli.js `cmd === 'daemon'`
// ignored args[1] entirely and ALWAYS started a FOREGROUND daemon. So
// `daemon start` blocked the shell, `daemon stop` STARTED a daemon (the `stop`
// arg was ignored), and `daemon restart` did not exist.
//
// This suite is FULLY HERMETIC. Every daemon runs:
//   - on an OS-picked free port (never 3848),
//   - under a throwaway temp HOME (isolated ~/.telepty/daemon-state.json),
//   - launched only by this test; we kill only the pids we started.
// It NEVER signals the live daemon (PID/port owned by the orchestrator) — the
// `stop` path is surgical (state-file pid + the configured port owner only,
// never a system-wide process sweep), which the unit test below pins down.
//
// To exercise WORKTREE code deterministically (not whatever `which telepty`
// finds on PATH), we shadow `telepty` on PATH with a symlink → this repo's
// cli.js, the same fake-bin-on-PATH pattern used by lifecycle-surface-acceptance.

// Isolate the module-level DAEMON_STATE_FILE (computed from os.homedir() at
// require time) so the stopDaemon unit test never reads the real ~/.telepty.
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const UNIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tp55-unit-home-'));
process.env.HOME = UNIT_HOME;
if (process.platform === 'win32') process.env.USERPROFILE = UNIT_HOME;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const daemonControl = require('../daemon-control');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'cli.js');

// ── shared hermetic plumbing ─────────────────────────────────────────────────
// Track temp dirs to remove and ports to reap. The production `telepty daemon`
// path launches daemon.js via require() (require.main is cli.js), so it does NOT
// write daemon-state.json — detection is via the port owner. We reap leftover
// daemons by asking /api/meta for the pid on each tracked port.
const tempDirs = [];
const daemonPorts = [];
after(async () => {
  for (const { port, home } of daemonPorts) {
    const m = await meta(port, home);
    const pid = m && m.pid;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  try { fs.rmSync(UNIT_HOME, { recursive: true, force: true }); } catch {}
});

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function makeTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp55-home-'));
  tempDirs.push(homeDir);
  return homeDir;
}

// Track a port whose daemon must be reaped in `after`. The HOME comes with it because since
// #820 the /api/meta pid lookup needs that daemon's token, and each temp HOME holds its own.
function trackDaemonPort(port, home) {
  daemonPorts.push({ port, home });
  return port;
}

// Shadow `telepty` on PATH → this repo's cli.js, so the detached daemon the CLI
// spawns is deterministically the worktree's code, not the globally installed one.
function makeShimBin() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp55-bin-'));
  tempDirs.push(binDir);
  fs.symlinkSync(CLI, path.join(binDir, 'telepty'));
  return binDir;
}
const SHIM_BIN = makeShimBin();

function childEnv(homeDir, port) {
  const homeEnv = process.platform === 'win32'
    ? { HOME: homeDir, USERPROFILE: homeDir }
    : { HOME: homeDir };
  return {
    ...process.env,
    ...homeEnv,
    PATH: SHIM_BIN + path.delimiter + process.env.PATH,
    PORT: String(port),          // daemon.js reads PORT
    TELEPTY_PORT: String(port),  // cli.js reads TELEPTY_PORT
    TELEPTY_HOST: '127.0.0.1',
    NO_UPDATE_NOTIFIER: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
  };
}

// Task 1215 windows127 (failure-only, owned fixture daemon only): what the fixture can observe about ITS OWN daemon at
// the moment runCli's bound fires. Fixed fields only: elapsed since the CLI spawn; the owned daemon pid's liveness via
// signal 0 (alive | gone | exists_no_permission | unknown); one /api/health request carrying that HOME's token, capped
// at 1000 ms ABSOLUTE (answered, HTTP status, health status token or an allowlisted error name/code). Never a command
// line, environment, token, arbitrary body, or any other process. It observes; it never decides a pass.
function observeOwnedDaemon({ pid, home }, port, spawnedAt, timeoutMs) {
  const elapsed = Date.now() - spawnedAt;
  let liveness = 'unknown';
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); liveness = 'alive'; }
    catch (e) { liveness = e && e.code === 'ESRCH' ? 'gone' : (e && e.code === 'EPERM' ? 'exists_no_permission' : 'unknown'); }
  }
  const started = Date.now();
  const token = tokenFor(home);
  const probe = (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000),
        headers: token ? { 'x-telepty-token': token } : {} });
      let status = null;
      try { const b = await res.json(); status = b && typeof b.status === 'string' && /^[a-z_]{1,32}$/.test(b.status) ? b.status : 'other'; } catch { /* no JSON */ }
      return { answered: true, http_status: res.status, health_status: status };
    } catch (e) {
      const code = e && e.cause && e.cause.code;
      return { answered: false, error: ['AbortError', 'TimeoutError', 'TypeError'].includes(e && e.name) ? e.name : 'other',
        cause_code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : null };
    }
  })();
  let cap;
  const capped = new Promise((resolve) => { cap = setTimeout(() => resolve({ answered: false, error: 'cap_1000ms' }), 1000); });
  return Promise.race([probe, capped]).then((health) => {
    clearTimeout(cap);
    return { elapsed_since_spawn_ms: elapsed, runcli_timeout_ms: timeoutMs, owned_daemon_pid: liveness,
      health: { ...health, probe_ms: Date.now() - started } };
  });
}

function runCli(args, homeDir, port, { timeoutMs = 8000, owned = null } = {}) {
  return new Promise((resolve, reject) => {
    const spawnedAt = Date.now();
    const cli = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: childEnv(homeDir, port),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let ownedEvidence = null; // Task 1215 windows127: only when the caller passes owned fixture metadata
    const timer = setTimeout(() => {
      timedOut = true;
      if (owned) ownedEvidence = observeOwnedDaemon(owned, port, spawnedAt, timeoutMs).catch(() => null);
      cli.kill('SIGKILL');
    }, timeoutMs);
    cli.stdout.on('data', (c) => { stdout += c.toString(); });
    cli.stderr.on('data', (c) => { stderr += c.toString(); });
    cli.on('error', (e) => { clearTimeout(timer); reject(e); });
    cli.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const fail = (note) => reject(new Error(`CLI \`${args.join(' ')}\` did not return (blocked).\nstdout:\n${stdout}\nstderr:\n${stderr}${note}`));
        if (!ownedEvidence) { fail(''); return; }
        ownedEvidence.then((evidence) => fail(evidence ? `\n#1215 windows127 owned-daemon evidence ${JSON.stringify(evidence)}` : ''));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// #820: /api/meta is behind the auth middleware, and loopback is no longer a credential — so the
// probe has to present the token the daemon under `home` actually loaded. (/api/health above needs
// none: it is registered before the middleware, deliberately.)
function tokenFor(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.telepty', 'config.json'), 'utf8')).authToken;
  } catch { return null; }
}

async function meta(port, home) {
  try {
    const token = home ? tokenFor(home) : null;
    const res = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      signal: AbortSignal.timeout(1000),
      headers: token ? { 'x-telepty-token': token } : {}
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitFor(fn, { timeoutMs = 7000, intervalMs = 100, desc = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${desc}`);
}

// ── INTEGRATION: start / stop / restart / back-compat ────────────────────────

test('daemon start: returns control to the shell immediately AND brings up a reachable detached daemon', async () => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);

  // If `start` blocked (the old foreground bug), runCli would time out → reject.
  const res = await runCli(['daemon', 'start'], home, port);
  assert.equal(res.code, 0, `daemon start should exit 0\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /started/i);
  assert.match(res.stdout, new RegExp(`pid\\s+\\d+`, 'i'));
  assert.match(res.stdout, new RegExp(String(port)), 'should print the listen URL with the port');

  const h = await waitFor(() => health(port), { desc: 'detached daemon health' });
  assert.equal(h.status, 'ok');
});

test('daemon stop: terminates the running daemon process and frees the port', async () => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);

  await runCli(['daemon', 'start'], home, port);
  await waitFor(() => health(port), { desc: 'daemon up before stop' });
  // The `telepty daemon` path launches daemon.js via require() so it does not
  // write daemon-state.json; the live pid comes from /api/meta (port-owner path).
  const m = await meta(port, home);
  const pid = m && m.pid;
  assert.ok(Number.isInteger(pid) && pid > 0, 'daemon should report a pid via /api/meta');

  // Task 1215 windows127: owned metadata adds failure-only evidence to the unchanged 8000 ms timeout branch.
  const res = await runCli(['daemon', 'stop'], home, port, { owned: { pid, home } });
  assert.equal(res.code, 0, `daemon stop should exit 0\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /stopped/i);

  // Port is freed (daemon no longer answering) AND the process is gone.
  await waitFor(async () => (await health(port)) === null, { desc: 'port freed after stop' });
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } },
    { desc: 'daemon process exited' });
});

test('daemon stop: with NO daemon running does NOT start one (the #55 ignore-args bug)', async () => {
  const home = makeTempHome();
  const port = await pickFreePort();

  const res = await runCli(['daemon', 'stop'], home, port);
  assert.equal(res.code, 0);
  // The old behavior printed "Starting telepty daemon..." and started a daemon.
  assert.doesNotMatch(res.stdout, /Starting telepty daemon/i, 'stop must never START a daemon');

  // #121: the released ephemeral port may now belong to another parallel test.
  // Only a state claim under this invocation's unique HOME is attributable to it.
  assert.equal(fs.existsSync(path.join(home, '.telepty', 'daemon-state.json')), false,
    'stop without a recorded daemon must not create a daemon state claim');
});

test('#121: stopping an unrecorded daemon leaves an independently owned listener intact', async t => {
  const home = makeTempHome();
  // Task 1215 G2: record what reaches this foreign listener — no stop (or any telepty action) may be sent to it.
  const received = [];
  const server = net.createServer(socket => { socket.on('data', (d) => received.push(String(d))); socket.end(); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  // Task 1215 G2 (review26): POSITIVE capture control — prove this fixture observes a known harmless request on this
  // exact listener before relying on the absence of stop/meta requests below (the socket ends at once, so a capture
  // that never worked would pass vacuously). Our own separate connection; the listener itself is never touched.
  const PROBE = 'GET /telepty-1215-capture-control HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n';
  await new Promise((resolve) => { const probe = net.connect(port, '127.0.0.1', () => { probe.end(PROBE); }); probe.on('close', resolve); probe.on('error', resolve); });
  await waitFor(() => received.join('').includes('/telepty-1215-capture-control'), { timeoutMs: 5000, desc: 'PRECONDITION: the listener capture observes a known request' });
  const captureBefore = received.length;
  const result = await runCli(['daemon', 'stop'], home, port);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(server.listening, true, 'a port listener is not evidence of a daemon owned by this invocation');
  assert.ok(captureBefore >= 1, 'PRECONDITION: capture control recorded before the stop');
  assert.equal(/\/api\/daemon\/stop|\/api\/meta/.test(received.slice(captureBefore).join('')), false, 'no identification or stop request reached a listener that is not an identified telepty daemon');
  assert.equal(fs.existsSync(path.join(home, '.telepty', 'daemon-state.json')), false);
});

test('daemon restart: cycles the daemon (stop + start) and leaves it reachable', async () => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);

  await runCli(['daemon', 'start'], home, port);
  const before = await waitFor(() => meta(port, home), { desc: 'daemon up before restart' });

  const res = await runCli(['daemon', 'restart'], home, port);
  assert.equal(res.code, 0, `daemon restart should exit 0\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /restarted/i);

  const afterMeta = await waitFor(async () => {
    const m = await meta(port, home);
    // Reachable again; the restarted daemon is a fresh process (new pid).
    return m && m.pid && m.pid !== before.pid ? m : null;
  }, { desc: 'restarted daemon reachable with a new pid' });
  assert.ok(afterMeta.pid);
});

test('bare `telepty daemon` keeps FOREGROUND behavior (back-compat for install/launchd flows)', async () => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);

  // Spawn directly (NOT runCli) — foreground means the process must NOT exit.
  const child = spawn(process.execPath, [CLI, 'daemon'], {
    cwd: REPO_ROOT,
    env: childEnv(home, port),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  try {
    await waitFor(() => health(port), { desc: 'foreground daemon up' });
    // Still running (blocking) ~after coming up — the hallmark of foreground.
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(child.exitCode, null, 'bare `telepty daemon` must stay in the foreground (not exit)');
    assert.match(out, /Starting telepty daemon/i);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  }
});

test('unknown daemon subcommand → usage error, exit 1, no daemon started', async () => {
  const home = makeTempHome();
  const port = await pickFreePort();

  const res = await runCli(['daemon', 'bogus'], home, port);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Usage: telepty daemon \[start\|stop\|restart\]/);
  assert.equal(await health(port), null, 'a bad subcommand must not start a daemon');
});

// ── UNIT: stopDaemon is SURGICAL (never a system-wide process sweep) ──────────
// This is the safety invariant for telepty#55: `daemon stop` must target ONLY
// the configured daemon (state-file pid + the owner of the configured port),
// never enumerate the whole process table — otherwise it could reap an unrelated
// telepty daemon (e.g. an orchestrator's live daemon on another port).

test('stopDaemon: targets state-file pid + configured-port owner, and NEVER scans the process table', () => {
  const killed = [];
  let scanCalled = false;

  const result = daemonControl.stopDaemon({
    port: 49999,
    readDaemonState: () => ({ pid: 111 }),
    findPortOwnerPid: (p) => (p === 49999 ? 222 : null),
    // #844: BOTH sources confirm identity now — the state-file pid is a pid we WROTE, not one we
    // measured, so `stopDaemon`'s surgical promise has to be checked rather than asserted.
    pidMatchesTeleptyCmdline: (pid) => pid === 111 || pid === 222,
    isProcessRunning: () => false,
    stopDaemonProcess: (pid) => { killed.push(pid); return true; },
    // If stop ever sweeps the table it MUST go through this seam — assert it does not.
    listDaemonProcesses: () => { scanCalled = true; return [{ pid: 98164, commandLine: 'telepty-daemon' }]; }
  });

  assert.equal(scanCalled, false, 'stop must NOT enumerate the system process table');
  assert.deepEqual(killed.sort((a, b) => a - b), [111, 222]);
  assert.equal(result.stopped.length, 2);
  assert.equal(result.failed.length, 0);
  assert.ok(!killed.includes(98164), 'an unrelated daemon found only by a table scan must never be signalled');
});

test('stopDaemon: nothing running → no targets, no failures (idempotent)', () => {
  const killed = [];
  const result = daemonControl.stopDaemon({
    port: 49998,
    readDaemonState: () => null,
    findPortOwnerPid: () => null,
    stopDaemonProcess: (pid) => { killed.push(pid); return true; },
    listDaemonProcesses: () => { throw new Error('must not scan'); }
  });
  assert.deepEqual(killed, []);
  assert.equal(result.stopped.length, 0);
  assert.equal(result.failed.length, 0);
});

// ── task 1215 W3: production normal stop/restart vs genuine crash (ledger lock) ─────────────────
//
// These cases drive the REAL CLI (`telepty daemon start|stop|restart`, `telepty ledger unlock`) against a
// private HOME/port, and bind ownership before acting: the pid comes from that daemon's own /api/meta,
// and the ledger lock file names that same pid. They distinguish three facts: the stop command's
// result, the actual process exit, and whether the NEXT daemon for the same HOME gets the ledger.
// On Windows the production stop path currently ends in `taskkill /F` (daemon-control.js →
// src/win-kill-process.js), which runs no shutdown handler; the two normal-stop cases are expected to
// stay RED there until that production path is corrected. Nothing here is skipped per platform.
//
// The crash control is the accepted fail-closed contract: a daemon killed without shutdown leaves its
// lock, the next daemon reports lock_present, the lock bytes are untouched (no automatic steal), and
// only `telepty ledger unlock --confirm` with no daemon alive clears it.

const LEDGER_WAIT_MS = 20000; // the same bound test/integration/ledger-daemon-1207.test.js uses

function ledgerLockPath(home) {
  return path.join(home, '.config', 'aigentry-telepty', 'tracked-injections.lock');
}

function readLock(home) {
  try { return fs.readFileSync(ledgerLockPath(home)); } catch { return null; }
}

async function ledgerStatus(port, home) {
  try {
    const token = tokenFor(home);
    const res = await fetch(`http://127.0.0.1:${port}/api/ledger/status`, {
      signal: AbortSignal.timeout(1000),
      headers: token ? { 'x-telepty-token': token } : {}
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Waits for a SETTLED ledger state of the daemon on `port` (available or lock_present) and returns it,
// so a refusal is reported by name instead of as a timeout.
function settledLedger(port, home, desc) {
  return waitFor(async () => {
    const s = await ledgerStatus(port, home);
    return s && s.client && ['available', 'lock_present'].includes(s.client.store) ? s : null;
  }, { timeoutMs: LEDGER_WAIT_MS, desc });
}

function processGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

// Starts a daemon through the CLI and returns its owned identity: the pid it reports and the lock it holds.
async function startOwnedDaemon(home, port) {
  const started = await runCli(['daemon', 'start'], home, port);
  assert.equal(started.code, 0, `PRECONDITION: daemon start exits 0\nstderr:\n${started.stderr}`);
  await waitFor(() => health(port), { desc: 'daemon health' });
  const m = await waitFor(() => meta(port, home), { desc: 'daemon /api/meta' });
  assert.ok(Number.isInteger(m.pid) && m.pid > 0, 'PRECONDITION: daemon reports its pid');
  const ledger = await settledLedger(port, home, 'first ledger settle');
  assert.equal(ledger.client.store, 'available', 'PRECONDITION: a fresh HOME opens its ledger');
  const lock = readLock(home);
  assert.ok(lock, 'PRECONDITION: the running daemon holds the ledger lock');
  assert.equal(JSON.parse(lock.toString('utf8')).pid, m.pid, 'PRECONDITION: the lock is owned by this daemon pid');
  return { pid: m.pid, lock };
}

test('#W3 production `daemon stop`: a normal stop exits the owned daemon, frees the port and releases the ledger lock', async () => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);
  const owned = await startOwnedDaemon(home, port);

  const res = await runCli(['daemon', 'stop'], home, port);
  await waitFor(async () => (await health(port)) === null, { desc: 'port freed after stop' });
  await waitFor(() => processGone(owned.pid), { desc: 'owned daemon process exited' });
  assert.deepEqual({ code: res.code, stopped: /stopped/i.test(res.stdout), lockReleased: readLock(home) === null },
    { code: 0, stopped: true, lockReleased: true },
    `a NORMAL stop must run the daemon shutdown that releases its ledger lock\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
});

test('#W3 production `daemon restart`: the restarted daemon for the same HOME opens its ledger (not lock_present)', async () => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);
  const owned = await startOwnedDaemon(home, port);

  const res = await runCli(['daemon', 'restart'], home, port);
  assert.equal(res.code, 0, `daemon restart should exit 0\nstderr:\n${res.stderr}`);
  await waitFor(() => processGone(owned.pid), { desc: 'previous daemon process exited' });
  const next = await waitFor(async () => {
    const m = await meta(port, home);
    return m && m.pid && m.pid !== owned.pid ? m : null;
  }, { desc: 'restarted daemon reachable with a new pid' });
  const ledger = await settledLedger(port, home, 'restarted daemon ledger settle');
  assert.deepEqual({ newPid: next.pid !== owned.pid, store: ledger.client.store, reason: ledger.unavailable_reason || null },
    { newPid: true, store: 'available', reason: null },
    'a normal restart must not leave the previous daemon\'s lock behind');
});

test('#W3 genuine crash control: a forced kill keeps lock_present, untouched, until an explicit operator unlock', async () => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);
  const owned = await startOwnedDaemon(home, port);

  // Deliberate crash: no shutdown handler can run (POSIX SIGKILL; Windows TerminateProcess).
  process.kill(owned.pid, 'SIGKILL');
  await waitFor(() => processGone(owned.pid), { desc: 'crashed daemon process exited' });
  await waitFor(async () => (await health(port)) === null, { desc: 'port freed after crash' });
  const afterCrash = readLock(home);

  await runCli(['daemon', 'start'], home, port);
  const second = await waitFor(() => meta(port, home), { desc: 'second daemon /api/meta' });
  const refusedLedger = await settledLedger(port, home, 'second daemon ledger settle');
  const unlockWhileUp = await runCli(['ledger', 'unlock', '--confirm'], home, port);
  const lockWhileUp = readLock(home);

  const stopped = await runCli(['daemon', 'stop'], home, port);
  await waitFor(() => processGone(second.pid), { desc: 'second daemon process exited' });
  await waitFor(async () => (await health(port)) === null, { desc: 'port freed after second stop' });
  const lockAfterStop = readLock(home);
  const unlockNoConfirm = await runCli(['ledger', 'unlock'], home, port);
  const unlock = await runCli(['ledger', 'unlock', '--confirm'], home, port);

  await runCli(['daemon', 'start'], home, port);
  const third = await settledLedger(port, home, 'third daemon ledger settle');
  assert.deepEqual({
    lockKeptByCrash: !!afterCrash && afterCrash.equals(owned.lock),
    secondStore: refusedLedger.client.store, secondReason: refusedLedger.unavailable_reason,
    unlockWhileUpRefused: unlockWhileUp.code !== 0, lockUntouchedWhileUp: !!lockWhileUp && lockWhileUp.equals(owned.lock),
    secondStopCode: stopped.code, lockUntouchedAfterNonHolderStop: !!lockAfterStop && lockAfterStop.equals(owned.lock),
    unlockNeedsConfirm: unlockNoConfirm.code !== 0 && /confirm_required/.test(unlockNoConfirm.stdout),
    unlocked: unlock.code === 0 && /"unlocked": true/.test(unlock.stdout), thirdStore: third.client.store,
  }, {
    lockKeptByCrash: true, secondStore: 'lock_present', secondReason: 'lock_present',
    unlockWhileUpRefused: true, lockUntouchedWhileUp: true, secondStopCode: 0, lockUntouchedAfterNonHolderStop: true,
    unlockNeedsConfirm: true, unlocked: true, thirdStore: 'available',
  }, `unlockWhileUp:\n${unlockWhileUp.stdout}\nunlock:\n${unlock.stdout}${unlock.stderr}`);
});

// ── Task 1215 G2-N1 (review30): native restart from NO daemon, with and without a local token ──────────────────
// The Windows normal stop gate classifies a closed port by its transport outcome: only a refused connection is absence.
// Whether a Windows loopback refusal arrives inside the gate's existing bounds (1 s unauthenticated health / 2 s
// identity read) is UNMEASURED; these cases measure it on CI. The refusal latency observed by the test itself is
// reported as a diagnostic, never asserted. The contract asserted is the ordinary lifecycle: a restart from nothing
// exits 0 and leaves a reachable daemon. Isolated temp HOME + free port; every daemon started is tracked and killed in
// after(). No deadline was raised to make this pass.
function refusalProbe(port) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); try { socket.destroy(); } catch {} resolve({ code, ms: Date.now() - t0 }); };
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => finish('NO_RESULT_5000MS'), 5000);
    socket.once('error', (e) => finish(e.code || 'ERROR'));
    socket.once('connect', () => finish('CONNECTED'));
  });
}

test('#1215 G2-N1 native: `daemon restart` with NO daemon and NO local token restarts one (refused connection = absence)', async (t) => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);
  t.diagnostic(`#1215 G2-N1 no_token refusal ${JSON.stringify({ platform: process.platform, ...(await refusalProbe(port)) })}`);
  const res = await runCli(['daemon', 'restart'], home, port);
  assert.equal(res.code, 0, `restart from nothing should exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /restarted/i);
  await waitFor(async () => (await health(port)) ? true : null, { desc: 'restarted daemon reachable' });
});

test('#1215 G2-N1 native: `daemon restart` with NO daemon but WITH a local token restarts one (refused connection = absence)', async (t) => {
  const home = makeTempHome();
  const port = trackDaemonPort(await pickFreePort(), home);
  // A real local token: a real daemon start writes it under this HOME; the real stop then leaves nothing running.
  await runCli(['daemon', 'start'], home, port);
  await waitFor(() => meta(port, home), { desc: 'PRECONDITION: seeding daemon up (writes the local token)' });
  const stopped = await runCli(['daemon', 'stop'], home, port);
  assert.equal(stopped.code, 0, `PRECONDITION: seeding daemon stopped\nstderr:\n${stopped.stderr}`);
  await waitFor(async () => (await health(port)) === null, { desc: 'PRECONDITION: nothing answers on the port' });
  t.diagnostic(`#1215 G2-N1 with_token refusal ${JSON.stringify({ platform: process.platform, ...(await refusalProbe(port)) })}`);
  const res = await runCli(['daemon', 'restart'], home, port);
  assert.equal(res.code, 0, `restart from nothing should exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /restarted/i);
  await waitFor(async () => (await meta(port, home)) ? true : null, { desc: 'restarted daemon reachable with the local token' });
});

// A foreign HTTP listener (answers 404 to everything) is NOT absence: with no local token the Windows gate must not
// start a replacement on it, must not claim success, and must send it no identification or stop request. Windows-only:
// the gate is the win32 normal stop path; the unit tests pin the same decision on every platform.
test('#1215 G2-R1 native: a foreign HTTP 404 listener on the port is never treated as absence — no replacement, no success claim, no meta/stop', { skip: process.platform === 'win32' ? false : 'win32 graceful-stop gate only (unit tests pin the decision on all platforms)' }, async (t) => {
  const home = makeTempHome();
  const received = [];
  const server = require('node:http').createServer((req, res) => { received.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end('not found'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const port = server.address().port;
  // Positive capture control: this listener's capture observes a known harmless request before relying on absences.
  const control = await fetch(`http://127.0.0.1:${port}/telepty-1215-capture-control`, { signal: AbortSignal.timeout(5000) });
  assert.equal(control.status, 404, 'PRECONDITION: the foreign listener answers 404');
  assert.deepEqual(received, ['GET /telepty-1215-capture-control'], 'PRECONDITION: the capture observes requests');
  const res = await runCli(['daemon', 'restart'], home, port);
  assert.equal(res.code, 1, `restart must refuse on an unidentified listener\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stdout, /restarted/i);
  assert.equal(server.listening, true, 'the foreign listener is untouched');
  assert.deepEqual(received.slice(1).filter((r) => /\/api\/meta|\/api\/daemon\/stop/.test(r)), [], 'no identification or stop request reached it');
  assert.equal(fs.existsSync(path.join(home, '.telepty', 'daemon-state.json')), false, 'no daemon state was created');
});
