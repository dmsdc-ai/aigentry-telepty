'use strict';
// #738 — ensure-daemon-running vs supervisor (launchd) kickstart race.
//
// ── The bug (reproduced here before the fix) ──────────────────────────────────────
// Production launches the daemon through the CLI: the launchd plist ProgramArguments are
// `<telepty bin> daemon`, and `telepty` is a symlink to cli.js. cli.js:1296-1303 then does
// `require('./daemon.js')`, so inside daemon.js `require.main` is cli.js, NOT daemon.js.
// Every `require.main === module` block is therefore dead in production — including the
// claimDaemonState singleton lock at daemon.js:382. (Only the listen block, daemon.js:4306,
// got the AIGENTRY_TELEPTY_DAEMON_MAIN escape hatch. Repairing the rest is orchestrator
// task #742; this fix deliberately does NOT depend on it.)
//
// So the only arbitration between two daemons is first-come-first-served on the TCP port:
// the loser hits EADDRINUSE, probes /api/health, and `process.exit(0)` (daemon.js:4643-4651)
// — silently, as a success. `launchctl kickstart -k` leaves a gap with no listener; a CLI
// running in that gap concluded "no daemon" within its ~600ms probe budget (cli.js:768-782)
// and spawned a detached daemon that won the port. The survivor was an orphan outside
// launchd: logs unwired, and fresh fuel for the #733 self-update wars.
//
// ── The fix under test ───────────────────────────────────────────────────────────
// cli.js deferToSupervisor: on the `start` path only, if an OS service supervisor owns this
// daemon (src/supervisor.js — launchd plist / systemd unit / schtasks task), wait for it
// rather than racing it. No supervisor installed ⇒ the pre-#738 spawn path, unchanged.
//
// ── Isolation ─────────────────────────────────────────────────────────────────────
// Everything runs on an OS-assigned ephemeral port under a temp HOME. `launchctl` is never
// invoked; the "supervisor" is a plain scripted relaunch of the same command line launchd
// uses. The production daemon (port 3848) and the real ~/Library/LaunchAgents are never
// touched.

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
// The CLI's own probe budget is ~600ms (cli.js:768-782), so a 1200ms gap is exactly the
// window that used to produce the orphan — and it is realistic: booting this daemon.js
// costs ~1s of wall clock on its own.
const KICKSTART_GAP_MS = 1200;
// How long the supervisor instance gets to either exit (the old broken outcome) or own the
// port (the contract). Must exceed the CLI's own defer ceiling.
const SUPERVISOR_VERDICT_MS = 15000;

const spawnedChildren = [];
const tempDirs = [];
const testPorts = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Timeline breadcrumbs — a race test that goes wrong is unreadable without them.
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

// The supervisor's detection surface — the same paths install.js:363 writes and
// src/supervisor.js reads. Written into the temp HOME, so the real ~/Library/LaunchAgents
// and ~/.config/systemd are never touched.
//
// #768: detection is per-OS (src/supervisor.js:58-90) but this used to write only the
// launchd plist, which Linux detection does not look at. On CI's ubuntu runner the
// `supervisor: true` scenario therefore ran with NO supervisor detectable, the racer took
// the pre-#738 auto-start path, and its orphan won the port — a permanent red that looked
// like the #738 fix regressing. Write the surface this platform actually reads.
function writeSupervisorSurface(homeDir) {
  return process.platform === 'darwin'
    ? writeLaunchdPlist(homeDir)
    : writeSystemdUserUnit(homeDir);
}

// The kind src/supervisor.js reports for the surface written above (it names the defer banner).
const SUPERVISOR_KIND = process.platform === 'darwin' ? 'launchd' : 'systemd-user';

// win32 detection is a `schtasks /query` probe against the registry (src/supervisor.js:69-79),
// not a file under HOME — there is no way to present a supervisor to the child without
// registering a real scheduled task on the runner, which the isolation contract above forbids.
const SUPERVISOR_UNFAKEABLE = process.platform === 'win32'
  ? 'win32: supervisor detection is a schtasks registry probe, unfakeable inside a temp HOME'
  : false;

// Linux: the user unit, not /etc/systemd/system — the root unit is outside the temp HOME
// and writing it would violate the isolation contract above.
function writeSystemdUserUnit(homeDir) {
  const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, 'telepty.service');
  fs.writeFileSync(unitPath, `[Unit]
Description=aigentry-telepty daemon

[Service]
ExecStart=${path.join(homeDir, 'bin', 'telepty')} daemon
Restart=always

[Install]
WantedBy=default.target
`);
  return unitPath;
}

function writeLaunchdPlist(homeDir) {
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

function createTempHome({ supervisor = true } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-738-'));
  tempDirs.push(homeDir);

  // PATH shim: resolveTeleptyEntryPoint (cli.js:413) runs `which telepty` and spawns
  // whatever it finds. Without this the CLI would spawn the GLOBALLY INSTALLED telepty
  // instead of this worktree's cli.js.
  const binDir = path.join(homeDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join(projectRoot, 'cli.js'), path.join(binDir, 'telepty'));

  if (supervisor) writeSupervisorSurface(homeDir);
  return { homeDir, binDir };
}

// #820: the /api/meta probe needs the token of the daemon on that port, and only the spawn env
// knows which temp HOME holds it. Recorded here because this is the one place both are in hand.
const portHomes = new Map();

function childEnv({ homeDir, binDir, port }) {
  portHomes.set(port, homeDir);
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
    TELEPTY_NO_TAILNET_AUTO: '1'
  };
  delete env.TELEPTY_SESSION_ID; // #555 hygiene (see test-support/setup-env.js)
  delete env.TELEPTY_NO_SUPERVISOR_DEFER; // never inherit the operator kill-switch
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
  // NOTE: child.exitCode is null BOTH for "still running" and for "killed by a signal", so
  // it cannot be used to test liveness — track the exit explicitly instead.
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

// Resolves { code, signal } once the child is gone, or null if it outlives timeoutMs. The
// timer is cleared on exit so no dangling handle keeps the runner alive.
function waitExit(child, timeoutMs) {
  if (child.exitResult) return Promise.resolve(child.exitResult);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(child.exitResult); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(null); }, timeoutMs);
    child.once('exit', onExit); // spawnNode's listener ran first ⇒ exitResult is already set
  });
}

// #820: /api/meta is behind the auth middleware and loopback is no longer a credential, so the
// probe must present the token the daemon under `homeDir` minted. Read per call rather than
// cached: these daemons are being raced into existence, so the file may not exist yet on the
// first poll. Absent homeDir (reapPort's best-effort sweep) still probes — it just gets a 401 and
// treats it as "nobody to reap", which is the pre-existing best-effort contract there.
function fetchMeta(port, homeDir) {
  let token = null;
  if (homeDir) {
    try {
      token = JSON.parse(fs.readFileSync(path.join(homeDir, '.telepty', 'config.json'), 'utf8')).authToken;
    } catch { /* not minted yet */ }
  }
  return (async () => {
    try {
      const res = await fetch(`http://${HOST}:${port}/api/meta`, {
        signal: AbortSignal.timeout(1000),
        headers: token ? { 'x-telepty-token': token } : {}
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  })();
}

async function stopChild(child) {
  if (child.exitResult) return;
  child.kill('SIGTERM');
  if (!(await waitExit(child, 2000))) {
    child.kill('SIGKILL');
    await waitExit(child, 2000);
  }
}

// #524 guard: a daemon the CLI spawns is detached+unref'd, so it is nobody's tracked child.
// Reap it by asking the port who it is (/api/meta reports pid — daemon.js:2624).
async function reapPort(port) {
  if (port === PRODUCTION_PORT) return; // belt-and-braces; runKickstartRace already asserts
  for (let i = 0; i < 5; i++) {
    const meta = await fetchMeta(port, portHomes.get(port));
    if (!meta || !meta.pid) return;
    try { process.kill(meta.pid, 'SIGKILL'); } catch { /* already gone */ }
    await delay(200);
  }
}

afterEach(async () => {
  await Promise.all(spawnedChildren.splice(0).map((child) => stopChild(child)));
  await Promise.all(testPorts.splice(0).map((port) => reapPort(port)));
  portHomes.clear();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function claimTestPort() {
  const port = await getFreePort();
  assert.notEqual(port, PRODUCTION_PORT, 'refusing to run against the production daemon port');
  testPorts.push(port);
  return port;
}

// ── The scenario ──────────────────────────────────────────────────────────────────
// 1. a supervisor-managed daemon is running and owns the port
// 2. `launchctl kickstart -k` stand-in: kill it, relaunch the SAME command line after a gap
// 3. an ambient CLI invocation lands in that gap and runs ensureDaemonRunning
async function runKickstartRace({ supervisor = true } = {}) {
  const port = await claimTestPort();
  const { homeDir, binDir } = createTempHome({ supervisor });
  const env = childEnv({ homeDir, binDir, port });

  // (1) The supervisor's daemon — launched EXACTLY the way the launchd plist does it.
  mark(`scenario start on :${port} (supervisor=${supervisor})`);
  const original = spawnNode(['cli.js', 'daemon'], env, 'daemon#supervisor-original');
  const originalMeta = await waitFor(() => fetchMeta(port, homeDir), {
    description: `original daemon on :${port}\n${describe(original)}`
  });
  mark(`original daemon serving (pid ${originalMeta.pid})`);

  // (2) kickstart -k: hard-kill the running instance; the supervisor relaunches after the gap.
  original.kill('SIGKILL');
  await waitExit(original, 5000);
  mark('kickstart gap open (old daemon dead)');

  let relaunch = null;
  const relaunchLaunched = delay(KICKSTART_GAP_MS).then(() => {
    relaunch = spawnNode(['cli.js', 'daemon'], env, 'daemon#supervisor-relaunch');
    mark(`supervisor relaunch spawned (pid ${relaunch.pid})`);
    return relaunch;
  });

  // (3) The ambient CLI that hits the gap (reconcile tick, status poll, anything).
  const racer = spawnNode(['test-support/kickstart-race-738-racer.js'], env, 'racer');
  const racerExit = await waitExit(racer, 30000);
  mark(`racer exit=${JSON.stringify(racerExit)}`);

  await relaunchLaunched;

  // Let the supervisor instance reach its verdict: exit (it lost the port) or serve.
  const relaunchExit = await waitExit(relaunch, SUPERVISOR_VERDICT_MS); // null ⇒ still serving
  mark(`supervisor relaunch exit=${JSON.stringify(relaunchExit)}`);

  return { port, homeDir, originalMeta, relaunch, relaunchExit, racer, racerExit };
}

// ── 1. Characterization of the primitive the whole bug rests on ───────────────────
// Not the #738 fix — this pins the arbitration that made an orphan possible in the first
// place, and it stays true until #742 repairs the require.main guards. If this test ever
// starts failing, #742 landed and the fix below can be revisited.
test('#738 characterization: two daemons racing one port — loser exits 0, singleton lock never engages (#742)', async () => {
  const port = await claimTestPort();
  const { homeDir, binDir } = createTempHome();
  const env = childEnv({ homeDir, binDir, port });

  const first = spawnNode(['cli.js', 'daemon'], env, 'daemon#first');
  const firstMeta = await waitFor(() => fetchMeta(port, homeDir), {
    description: `first daemon on :${port}\n${describe(first)}`
  });

  const second = spawnNode(['cli.js', 'daemon'], env, 'daemon#second');
  const secondExit = await waitExit(second, 15000);

  // The loser exits *successfully* — indistinguishable from a clean shutdown, which is why
  // a supervisor sees no failure and nothing self-heals (daemon.js:4643-4651).
  assert.deepEqual(secondExit, { code: 0, signal: null },
    `expected the second daemon to exit 0\n${describe(second)}`);
  assert.match(`${second.logs.stdout}\n${second.logs.stderr}`, /already running/i,
    `expected the "already running" EADDRINUSE bail-out\n${describe(second)}`);

  // The first daemon is untouched — the port is decided purely by who bound first.
  const stillServing = await fetchMeta(port, homeDir);
  assert.equal(stillServing && stillServing.pid, firstMeta.pid);

  // And the singleton lock never engaged: under the production launch path
  // (`telepty daemon` → cli.js → require('./daemon.js')) the claimDaemonState guard at
  // daemon.js:382 is `require.main === module` only. This is #742's territory.
  assert.equal(
    fs.existsSync(path.join(homeDir, '.telepty', 'daemon-state.json')),
    false,
    'daemon-state.json exists — claimDaemonState now runs on the CLI launch path (#742 landed?)'
  );
});

// ── 2. The #738 contract (was RED, now GREEN) ─────────────────────────────────────
test('#738: with a supervisor installed, a CLI racing the kickstart gap defers — no orphan', { skip: SUPERVISOR_UNFAKEABLE }, async () => {
  const r = await runKickstartRace({ supervisor: true });

  assert.deepEqual(r.racerExit, { code: 0, signal: null }, `racer failed\n${describe(r.racer)}`);

  // The contract, satisfiable EITHER way:
  //   (a) the CLI sees the supervisor and defers instead of spawning, or
  //   (b) the supervisor instance wins the port.
  // Both collapse to: the process serving the port is the supervisor's.
  const owner = await waitFor(async () => {
    const meta = await fetchMeta(r.port, r.homeDir);
    return meta && meta.pid === r.relaunch.pid ? meta : null;
  }, {
    timeoutMs: SUPERVISOR_VERDICT_MS,
    description: `supervisor instance (pid ${r.relaunch.pid}) to own :${r.port}`
  }).catch(async () => {
    const meta = await fetchMeta(r.port, r.homeDir);
    assert.fail(
      `orphan daemon (pid ${meta && meta.pid}) owns :${r.port}; the supervisor instance ` +
      `(pid ${r.relaunch.pid}) did not.\n${describe(r.relaunch)}`
    );
  });

  assert.equal(owner.pid, r.relaunch.pid);
  assert.equal(r.relaunchExit, null, 'supervisor instance must still be serving');

  // The CLI must have said so, and must NOT have taken the auto-start path. The banner names
  // the detected kind (cli.js:735), which is per-OS — assert the one this platform installs.
  assert.match(r.racer.logs.stderr, new RegExp(`managed by ${SUPERVISOR_KIND}`, 'i'),
    `expected the defer banner\n${describe(r.racer)}`);
  assert.doesNotMatch(r.racer.logs.stderr, /Auto-starting local telepty daemon/i,
    `CLI spawned a daemon despite the supervisor\n${describe(r.racer)}`);

  // And the ownership is stable — no late orphan sneaks in behind the supervisor.
  await delay(2000);
  const later = await fetchMeta(r.port, r.homeDir);
  assert.equal(later && later.pid, r.relaunch.pid, 'port changed hands after the race settled');
  mark(`supervisor pid ${r.relaunch.pid} owns :${r.port} — contract satisfied`);
});

// ── 3. No supervisor ⇒ byte-identical pre-#738 behavior ───────────────────────────
// The regression guard for the other half of the policy. NOTE for Linux hosts: detection
// also looks at /etc/systemd/system/telepty.service, which a root-installed telepty would
// have; such a host would (correctly) see a supervisor and skip the spawn. CI and dev boxes
// do not root-install telepty, so this asserts the absent branch there.
test('#738: with no supervisor installed, the CLI still auto-starts the daemon (unchanged)', async () => {
  const r = await runKickstartRace({ supervisor: false });

  assert.deepEqual(r.racerExit, { code: 0, signal: null }, `racer failed\n${describe(r.racer)}`);
  assert.doesNotMatch(r.racer.logs.stderr, /managed by/i,
    `deferred despite no supervisor being installed\n${describe(r.racer)}`);
  assert.match(r.racer.logs.stderr, /Auto-starting local telepty daemon/i,
    `expected the pre-#738 auto-start path\n${describe(r.racer)}`);

  // A daemon is serving, and it is the one the CLI spawned (not the scripted relaunch,
  // which loses the port exactly as it always did when no supervisor policy applies).
  const meta = await fetchMeta(r.port, r.homeDir);
  assert.ok(meta, `nobody is serving :${r.port}\n${describe(r.racer)}`);
  assert.notEqual(meta.pid, r.originalMeta.pid, 'expected the killed daemon to be gone');
  assert.notEqual(meta.pid, r.relaunch.pid, 'expected the CLI-spawned daemon to own the port');
});
