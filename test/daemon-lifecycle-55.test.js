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

function runCli(args, homeDir, port, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const cli = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: childEnv(homeDir, port),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cli.kill('SIGKILL'); }, timeoutMs);
    cli.stdout.on('data', (c) => { stdout += c.toString(); });
    cli.stderr.on('data', (c) => { stderr += c.toString(); });
    cli.on('error', (e) => { clearTimeout(timer); reject(e); });
    cli.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`CLI \`${args.join(' ')}\` did not return (blocked).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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

  const res = await runCli(['daemon', 'stop'], home, port);
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

  // Give any (erroneously) spawned daemon a moment, then assert nothing is listening.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await health(port), null, 'stop on an idle port must leave nothing listening');
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
    pidMatchesTeleptyCmdline: (pid) => pid === 222, // port owner confirmed as telepty
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
