'use strict';
// #738 — ensure-daemon-running vs supervisor (launchd) kickstart race.
//
// REPRO PHASE ONLY. Unregistered (not in package.json `test`): run explicitly with
//   node --test test/kickstart-race-738.test.js
//
// ── Mechanism under test ──────────────────────────────────────────────────────────
// Production launches the daemon through the CLI: the launchd plist ProgramArguments
// are `<telepty bin> daemon`, and `telepty` is a symlink to cli.js. cli.js:1296-1303
// then does `require('./daemon.js')` — so inside daemon.js `require.main` is cli.js,
// NOT daemon.js. Consequences:
//
//   daemon.js:382  `if (require.main === module) claimDaemonState(...)`  → NEVER RUNS
//                  in production. The singleton lock that would arbitrate two daemons
//                  is dead on the only launch path that matters.
//   daemon.js:4306 the listen block DOES run (it also honors
//                  AIGENTRY_TELEPTY_DAEMON_MAIN, set by cli.js:1302).
//
// So the ONLY arbitration left is first-come-first-served on the TCP port, resolved by
// daemon.js:4640-4655: on EADDRINUSE the loser probes /api/health and, seeing a healthy
// telepty, `process.exit(0)` — silently, as a success.
//
// `launchctl kickstart -k` kills the running daemon and relaunches it, leaving a gap
// with no listener. cli.js ensureDaemonRunning (cli.js:754) probes /api/meta 3× with
// 200ms backoff (~600ms budget), then /api/sessions; all fail inside the gap, so
// decideDaemonAction returns `start` (cli.js:751) and restartDaemonGraceful spawns a
// DETACHED daemon (cli.js:426-434) that binds the port before the supervisor instance
// finishes booting. The supervisor instance then exits 0 → launchd considers the job
// done, and the daemon that survives is the CLI's orphan: outside launchd, logs unwired
// (StandardOutPath never applies to it), and a fresh peer in the #733 self-update wars.
//
// ── Isolation ─────────────────────────────────────────────────────────────────────
// Everything runs on an OS-assigned ephemeral port under a temp HOME. `launchctl` is
// never invoked; the "supervisor" is a plain scripted relaunch of the same command line
// launchd uses. The production daemon (port 3848) and the real ~/Library/LaunchAgents
// are never touched.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PRODUCTION_PORT = 3848; // never touched — asserted in runKickstartRace

// Stand-in for the launchd relaunch latency (SIGKILL → exec → node boot → express init).
// The racer's own probe budget is ~600ms (cli.js:768-782), so a 1200ms gap puts the
// CLI-spawned daemon on the port first — deterministically, and without being
// unrealistic: booting this daemon.js costs ~1s of wall clock on its own.
const KICKSTART_GAP_MS = 1200;
// How long the supervisor instance gets to either exit (broken: it lost the port) or own
// the port (the contract the RED test pins).
const SUPERVISOR_VERDICT_MS = 10000;

const spawnedChildren = [];
const tempDirs = [];
const testPorts = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Timeline breadcrumbs — a race repro that goes wrong is unreadable without them.
const t0 = Date.now();
function mark(message) {
  process.stderr.write(`[738 +${String(Date.now() - t0).padStart(6)}ms] ${message}\n`);
}

async function waitFor(check, { timeoutMs = 7000, intervalMs = 100, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: HOST }, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}

// The plist the CLI *could* consult to learn a supervisor owns this daemon. Written into
// the temp HOME so the real ~/Library/LaunchAgents is untouched. Mirrors the shape
// install.js:89-128 generates (and the installed com.aigentry.telepty.plist).
function writeSupervisorPlist(homeDir) {
  const agentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const plistPath = path.join(agentsDir, 'com.aigentry.telepty.plist');
  fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aigentry.telepty</string>
    <key>ProgramArguments</key>
    <array>
        <string>${path.join(homeDir, 'bin', 'telepty')}</string>
        <string>daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`);
  return plistPath;
}

function createTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-738-'));
  tempDirs.push(homeDir);

  // PATH shim: resolveTeleptyEntryPoint (cli.js:413) runs `which telepty` and spawns
  // whatever it finds. Without this the racer would spawn the GLOBALLY INSTALLED telepty
  // instead of this worktree's cli.js.
  const binDir = path.join(homeDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join(projectRoot, 'cli.js'), path.join(binDir, 'telepty'));

  writeSupervisorPlist(homeDir);
  return { homeDir, binDir };
}

function childEnv({ homeDir, binDir, port }) {
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    HOST,
    PORT: String(port),          // daemon.js:302
    TELEPTY_PORT: String(port),  // cli.js:146
    NO_UPDATE_NOTIFIER: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
    TELEPTY_NO_TAILNET_AUTO: '1' // unregistered file → setup-env.js may not be loaded
  };
  delete env.TELEPTY_SESSION_ID; // #555 hygiene (see test-support/setup-env.js)
  return env;
}

function spawnNode(args, env, label) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.label = label;
  child.logs = { stdout: '', stderr: '' };
  // NOTE: child.exitCode is null BOTH for "still running" and for "killed by a signal",
  // so it cannot be used to test liveness — track the exit explicitly instead.
  child.exitResult = null;
  child.once('exit', (code, signal) => { child.exitResult = { code, signal }; });
  child.stdout.on('data', (c) => { child.logs.stdout += c.toString(); });
  child.stderr.on('data', (c) => { child.logs.stderr += c.toString(); });
  spawnedChildren.push(child);
  return child;
}

function describe(child) {
  if (!child) return '[child never spawned]';
  return `[${child.label} pid ${child.pid} exit ${JSON.stringify(child.exitResult)}]\n` +
    `stdout:\n${child.logs.stdout}\nstderr:\n${child.logs.stderr}`;
}

// Resolves { code, signal } once the child is gone, or null if it outlives timeoutMs.
// The timer is cleared on exit so no dangling handle keeps the runner alive.
function waitExit(child, timeoutMs) {
  if (child.exitResult) return Promise.resolve(child.exitResult);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(child.exitResult); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(null); }, timeoutMs);
    child.once('exit', onExit); // spawnNode's listener ran first ⇒ exitResult is already set
  });
}

async function fetchMeta(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/meta`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function stopChild(child) {
  if (child.exitResult) return;
  child.kill('SIGTERM');
  if (!(await waitExit(child, 2000))) {
    child.kill('SIGKILL');
    await waitExit(child, 2000);
  }
}

// #524 guard: the daemon the racer spawns is detached+unref'd, so it is nobody's tracked
// child. Reap it by asking the port who it is (/api/meta reports pid — daemon.js:2624).
async function reapPort(port) {
  if (port === PRODUCTION_PORT) return; // belt-and-braces; runKickstartRace already asserts
  for (let i = 0; i < 5; i++) {
    const meta = await fetchMeta(port);
    if (!meta || !meta.pid) return;
    try { process.kill(meta.pid, 'SIGKILL'); } catch { /* already gone */ }
    await delay(200);
  }
}

afterEach(async () => {
  await Promise.all(spawnedChildren.splice(0).map((child) => stopChild(child)));
  await Promise.all(testPorts.splice(0).map((port) => reapPort(port)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── The scenario ──────────────────────────────────────────────────────────────────
// 1. a supervisor-managed daemon is running and owns the port
// 2. `launchctl kickstart -k` stand-in: kill it, relaunch the SAME command line after a gap
// 3. an ambient CLI invocation lands in that gap and runs ensureDaemonRunning
async function runKickstartRace() {
  const port = await getFreePort();
  assert.notEqual(port, PRODUCTION_PORT, 'refusing to run the repro against the production daemon port');
  testPorts.push(port);

  const { homeDir, binDir } = createTempHome();
  const env = childEnv({ homeDir, binDir, port });

  // (1) The supervisor's daemon — launched EXACTLY the way the launchd plist does it.
  mark(`scenario start on :${port}`);
  const original = spawnNode(['cli.js', 'daemon'], env, 'daemon#supervisor-original');
  const originalMeta = await waitFor(() => fetchMeta(port), {
    description: `original daemon on :${port}\n${describe(original)}`
  });
  mark(`original daemon serving (pid ${originalMeta.pid})`);

  // (2) kickstart -k: hard-kill the running instance; the supervisor relaunches after the gap.
  original.kill('SIGKILL');
  await waitExit(original, 5000);
  mark('kickstart gap open (old daemon dead)');

  let supervisor = null;
  const supervisorLaunched = delay(KICKSTART_GAP_MS).then(() => {
    supervisor = spawnNode(['cli.js', 'daemon'], env, 'daemon#supervisor-relaunch');
    mark(`supervisor relaunch spawned (pid ${supervisor.pid})`);
    return supervisor;
  });

  // (3) The ambient CLI that hits the gap (reconcile tick, status poll, anything).
  const racer = spawnNode(['test-support/kickstart-race-738-racer.js'], env, 'racer');
  const racerExit = await waitExit(racer, 30000);
  mark(`racer exit=${JSON.stringify(racerExit)}`);

  await supervisorLaunched;

  // Let the supervisor instance reach its verdict: exit (it lost the port) or serve.
  const supervisorExit = await waitExit(supervisor, SUPERVISOR_VERDICT_MS); // null ⇒ still serving
  mark(`supervisor exit=${JSON.stringify(supervisorExit)}`);

  return { port, homeDir, originalMeta, supervisor, supervisorExit, racer, racerExit };
}

// ── REPRO: passes today; this IS the bug ──────────────────────────────────────────
test('#738 REPRO: a CLI racing the kickstart gap leaves an orphan daemon and the supervisor instance exits 0', async () => {
  const r = await runKickstartRace();

  assert.deepEqual(r.racerExit, { code: 0, signal: null }, `racer failed\n${describe(r.racer)}`);

  const meta = await fetchMeta(r.port);
  assert.ok(meta, `nobody is serving :${r.port} after the race\n${describe(r.supervisor)}`);

  // A NEW daemon owns the port ...
  assert.notEqual(meta.pid, r.originalMeta.pid, 'expected the killed daemon to be gone');
  // ... and it is NOT the supervisor's instance → it is an orphan outside launchd.
  assert.notEqual(meta.pid, r.supervisor.pid,
    `expected the CLI-spawned orphan to own :${r.port}, but the supervisor did\n${describe(r.supervisor)}`);

  // The supervisor instance lost the port and exited *successfully* — indistinguishable
  // from a clean shutdown, which is why nothing self-heals (daemon.js:4643-4651).
  assert.deepEqual(r.supervisorExit, { code: 0, signal: null },
    `expected the supervisor instance to exit 0\n${describe(r.supervisor)}`);
  assert.match(`${r.supervisor.logs.stdout}\n${r.supervisor.logs.stderr}`, /already running/i,
    `expected the "already running" EADDRINUSE bail-out\n${describe(r.supervisor)}`);

  // The singleton lock that should have arbitrated this never even engaged: under the
  // production launch path (`telepty daemon` → cli.js → require('./daemon.js')) the
  // claimDaemonState guard at daemon.js:382 is `require.main === module` only.
  assert.equal(
    fs.existsSync(path.join(r.homeDir, '.telepty', 'daemon-state.json')),
    false,
    'daemon-state.json exists — claimDaemonState unexpectedly ran on the CLI launch path'
  );

  // No self-heal: the orphan is still there, and stays there.
  await delay(3000);
  const later = await fetchMeta(r.port);
  assert.ok(later, 'orphan vanished on its own — not the observed production behavior');
  assert.equal(later.pid, meta.pid, 'orphan was replaced on its own — no self-heal expected');
  mark(`orphan pid ${later.pid} still owns :${r.port} — repro confirmed`);
});

// ── RED: the contract. Fails today. ───────────────────────────────────────────────
test('#738 RED: with a supervisor plist present, a CLI racing the gap must not own the port', async () => {
  const r = await runKickstartRace();

  const plist = path.join(r.homeDir, 'Library', 'LaunchAgents', 'com.aigentry.telepty.plist');
  assert.ok(fs.existsSync(plist), 'scenario precondition: a supervisor plist is installed');

  // The contract, satisfiable EITHER way:
  //   (a) the CLI sees the supervisor and defers instead of spawning, or
  //   (b) the supervisor instance wins the port within SUPERVISOR_VERDICT_MS.
  // Both collapse to: the process serving the port is the supervisor's.
  const owner = await waitFor(async () => {
    const meta = await fetchMeta(r.port);
    return meta && meta.pid === r.supervisor.pid ? meta : null;
  }, {
    timeoutMs: SUPERVISOR_VERDICT_MS,
    description: `supervisor instance (pid ${r.supervisor.pid}) to own :${r.port}`
  }).catch(async () => {
    const meta = await fetchMeta(r.port);
    assert.fail(
      `orphan daemon (pid ${meta && meta.pid}) owns :${r.port}; the supervisor instance ` +
      `(pid ${r.supervisor.pid}) exited instead of taking it over.\n${describe(r.supervisor)}`
    );
  });

  assert.equal(owner.pid, r.supervisor.pid);
  assert.equal(r.supervisorExit, null, 'supervisor instance must still be serving');
});
