'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const dc = require('../daemon-control');
const cli = require('../cli');
const supervisor = require('../src/supervisor');
const pkg = require('../package.json');

// #902 — the daemon sweep must only ever act on the daemon the CLI is ADDRESSING.
//
// Measured on the operator host 2026-08-15/16 (spec docs/specs/2026-08-16-sweep-scoping.md §0):
// a CLI configured for port 52209 ran `restartDaemonGraceful`, whose `cleanup()` call passes NO
// port — so the port-owner source fell back to the hardcoded 3848 and the process scan matched
// every `telepty-daemon`-titled process on the machine. The operator's production daemon on
// :3848 was SIGTERMed by a CLI that was not addressing it. `~/.telepty/supervisor-defer.json`
// still holds the fingerprint: {"signature":"launchd:52209"}, 29s before the kill.
//
// Same discipline as daemon-restart-title-44.test.js: the killer is ALWAYS injected, so nothing
// is ever really signalled; the identity confirmation (`pidMatchesTeleptyCmdline`) runs for real
// against the real production title.

const PRODUCTION_TITLE = 'telepty-daemon';
const ADDRESSED_PORT = 52209; // the port from the measured incident — deliberately not 3848

function killerOk(captured) {
  return (pid) => {
    captured.push(pid);
    return true;
  };
}

function spawnTitledChild() {
  return spawn(process.execPath, ['-e', `process.title=${JSON.stringify(PRODUCTION_TITLE)}; setTimeout(()=>{}, 10000)`], {
    stdio: 'ignore'
  });
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A health probe that answers "nothing there yet" once, then healthy. The first call is the
// supervised "did the supervisor already restore it?" probe (cli.js:597) — answering that one
// healthy returns success before any restart action runs, which would make every assertion
// below vacuous. The second call is the post-restart probe.
function healthAfterOneMiss() {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1 ? null : { version: pkg.version, capabilities: [] };
  };
}

// Every seam restartDaemonGraceful can reach, stubbed inert. Individual tests override
// only the one they are measuring, so a test can never fall through to a real process,
// a real port probe, or a real spawn.
function inertRestartSeams(overrides = {}) {
  return {
    maxAttempts: 1,
    _cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
    _detectSupervisor: () => ({ present: false }),
    _restartSupervisorDaemon: () => ({ success: true, kind: 'launchd' }),
    _startDetachedDaemon: () => {},
    _waitForDaemonHealth: healthAfterOneMiss(),
    _findPortOwnerPid: () => null,
    _findParentProcessInfo: () => null,
    ...overrides
  };
}

// ── R1 — the port-owner source may not invent a port ────────────────────────────────────
// The repair path calls cleanup() with no options at all (cli.js:580). `o.port || 3848` then
// silently addresses 3848 — a port this caller never named. A source with no port is a source
// with no target.
test('R1: cleanupDaemonProcesses with no addressed port never falls back to 3848', () => {
  const killed = [];
  const result = dc.cleanupDaemonProcesses({
    // no `port` — exactly the call shape the repair path used
    readDaemonState: () => null,
    listDaemonProcesses: () => [],
    findPortOwnerPid: (port) => (port === 3848 ? 98714 : null),
    pidMatchesTeleptyCmdline: () => true,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(killed, [], 'no addressed port ⇒ the port-owner source must contribute no target');
  assert.equal(result.stopped.length, 0);
});

test('R1b: an explicitly addressed port is the only port consulted', () => {
  const probed = [];
  const killed = [];
  dc.cleanupDaemonProcesses({
    port: ADDRESSED_PORT,
    readDaemonState: () => null,
    listDaemonProcesses: () => [],
    findPortOwnerPid: (port) => { probed.push(port); return port === 3848 ? 98714 : null; },
    pidMatchesTeleptyCmdline: () => true,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(probed, [ADDRESSED_PORT], 'only the addressed port may be probed');
  assert.deepEqual(killed, []);
});

// ── R2 — the state-file source must match the addressed port ────────────────────────────
// claimDaemonState writes {pid, host, port, version} (daemon-control.js:88). The pid was being
// used while the port sitting beside it was ignored, so a state file describing the daemon on
// 3848 authorized a kill from a CLI addressing 52209.
test('R2: state-file pid is not a target when its port is not the addressed port', () => {
  const killed = [];
  dc.cleanupDaemonProcesses({
    port: ADDRESSED_PORT,
    readDaemonState: () => ({ pid: 4242, host: '127.0.0.1', port: 3848, version: pkg.version }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: (pid) => pid === 4242,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(killed, [], 'a state file describing :3848 must not authorize a kill from a :52209 CLI');
});

test('R2b: state-file pid IS a target when its port matches the addressed port', () => {
  const killed = [];
  dc.cleanupDaemonProcesses({
    port: 3848,
    readDaemonState: () => ({ pid: 4242, host: '127.0.0.1', port: 3848, version: pkg.version }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: (pid) => pid === 4242,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(killed, [4242], 'the addressed daemon must still be stoppable');
});

test('R2c: a pre-0.4 state file with no port field is still a target (back-compat)', () => {
  // telepty#15's reporter had a daemon predating the state file entirely; daemons between then
  // and the port field must not become unstoppable.
  const killed = [];
  dc.cleanupDaemonProcesses({
    port: 3848,
    readDaemonState: () => ({ pid: 4242 }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: (pid) => pid === 4242,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(killed, [4242], 'a state file with no port must stay stoppable');
});

// ── R3 — the repair path must name the port it is addressing ────────────────────────────
test('R3: restartDaemonGraceful passes the addressed port to its cleanup seam', async () => {
  const seen = [];
  await cli.restartDaemonGraceful(inertRestartSeams({
    port: ADDRESSED_PORT,
    _cleanupDaemonProcesses: (o) => { seen.push(o); return { stopped: [], failed: [] }; }
  }));

  assert.equal(seen.length, 1, 'cleanup must run exactly once for a single attempt');
  assert.equal(
    seen[0] && seen[0].port,
    ADDRESSED_PORT,
    'the repair path must tell the sweep which daemon it is addressing'
  );
});

test('R3b: with no explicit port the repair path addresses the CLI default', async () => {
  const seen = [];
  await cli.restartDaemonGraceful(inertRestartSeams({
    _cleanupDaemonProcesses: (o) => { seen.push(o); return { stopped: [], failed: [] }; }
  }));

  assert.equal(seen[0] && seen[0].port, 3848, 'default CLI port is the addressed port');
});

// ── R4 — the measured incident, as a fixture ────────────────────────────────────────────
// A REAL process carrying the REAL production title owns :3848; the CLI addresses :52209.
// The confirmation step runs for real (pidMatchesTeleptyCmdline against the live title); only
// the killer is injected, so the child is never signalled by the code under test.
test('R4: a CLI addressing :52209 never signals the titled daemon on :3848', async () => {
  if (process.platform === 'win32') return; // title replacement is Unix-only
  const child = spawnTitledChild();
  try {
    await waitMs(700); // let ps observe the renamed title
    const killed = [];

    await cli.restartDaemonGraceful(inertRestartSeams({
      port: ADDRESSED_PORT,
      // Pass-through spy: forwards whatever the repair path decided into the REAL surgical stop,
      // so this asserts the production routing, not a re-implementation of it.
      _cleanupDaemonProcesses: (o) => dc.stopDaemon({
        ...(o || {}),
        readDaemonState: () => null,
        findPortOwnerPid: (port) => (port === 3848 ? child.pid : null),
        // pidMatchesTeleptyCmdline deliberately NOT injected → real title confirmation runs
        stopDaemonProcess: killerOk(killed)
      })
    }));

    assert.deepEqual(
      killed,
      [],
      'the 2026-08-15 incident: a CLI addressing :52209 must not reach the daemon on :3848'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

// ── R5 — supervisor actions are label-scoped, so they need a port gate ──────────────────
// `launchctl kickstart -k gui/<uid>/com.aigentry.telepty` restarts the job by LABEL, whatever
// port the CLI is addressing. That is the second, independent way a :52209 CLI killed :3848.
test('R5: no supervisor kickstart when the CLI addresses a non-default port', async () => {
  let kicked = 0;
  let started = 0;

  await cli.restartDaemonGraceful(inertRestartSeams({
    port: ADDRESSED_PORT,
    _detectSupervisor: () => ({ present: true, kind: 'launchd' }),
    _restartSupervisorDaemon: () => { kicked += 1; return { success: true, kind: 'launchd' }; },
    _startDetachedDaemon: () => { started += 1; }
  }));

  assert.equal(kicked, 0, 'a label-scoped restart must not fire for a port the supervisor does not serve');
  assert.equal(started, 1, 'the unsupervised spawn path takes over instead');
});

// ── R5c — the supervised port is READ, not presumed ─────────────────────────────────────
// The gate compares the addressed port against the port the supervised job actually serves.
// DEFAULT_PORT is the fallback for "the descriptor names none" — never a presumption about
// which daemon is supervised. (The shipped plist names none, so that fallback IS production.)
test('R5c: supervisedPort reads PORT out of a launchd plist', () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key><string>com.aigentry.telepty</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/usr/bin</string>
        <key>PORT</key><string>51999</string>
    </dict>
</dict>
</plist>`;
  assert.equal(
    supervisor.supervisedPort({ present: true, kind: 'launchd', detail: '/fake.plist' }, { readFileSync: () => plist }),
    51999
  );
});

test('R5c2: supervisedPort reads PORT out of a systemd unit', () => {
  const unit = '[Service]\nEnvironment="PORT=51998"\nExecStart=/usr/bin/telepty daemon\n';
  assert.equal(
    supervisor.supervisedPort({ present: true, kind: 'systemd-user', detail: '/fake.service' }, { readFileSync: () => unit }),
    51998
  );
});

test('R5c3: a descriptor that names no PORT is undetermined, not "the default"', () => {
  // The SHIPPED plist is exactly this shape — EnvironmentVariables with PATH but no PORT
  // (measured on the operator host). Returning null keeps the fallback a caller policy.
  const plist = '<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict></dict></plist>';
  assert.equal(
    supervisor.supervisedPort({ present: true, kind: 'launchd', detail: '/fake.plist' }, { readFileSync: () => plist }),
    null
  );
});

test('R5c4: an unreadable or absent descriptor is undetermined', () => {
  assert.equal(
    supervisor.supervisedPort({ present: true, kind: 'launchd', detail: '/nope.plist' }, {
      readFileSync: () => { throw new Error('ENOENT'); }
    }),
    null
  );
  // schtasks `detail` is a task NAME, not a readable file.
  assert.equal(supervisor.supervisedPort({ present: true, kind: 'schtasks', detail: 'telepty-daemon' }), null);
  assert.equal(supervisor.supervisedPort({ present: false, kind: null, detail: null }), null);
});

test('R5d: descriptor names no port ⇒ the gate falls back to DEFAULT_PORT', async () => {
  // The production path: shipped plist, no PORT key, CLI on the default port ⇒ supervised.
  let kicked = 0;
  await cli.restartDaemonGraceful(inertRestartSeams({
    port: 3848,
    _detectSupervisor: () => ({ present: true, kind: 'launchd', detail: '/fake.plist' }),
    _supervisedPort: () => null, // descriptor names none
    _restartSupervisorDaemon: () => { kicked += 1; return { success: true, kind: 'launchd' }; },
    _startDetachedDaemon: () => { throw new Error('must not spawn on a supervised install'); }
  }));
  assert.equal(kicked, 1, 'fallback to DEFAULT_PORT keeps the shipped install supervised');
});

test('R5e: a supervised job on a NON-default port is honored on that port', async () => {
  // The case D1.4-as-written could not express, and the reason the #738 fixture needs it.
  let kicked = 0;
  await cli.restartDaemonGraceful(inertRestartSeams({
    port: 51999,
    _detectSupervisor: () => ({ present: true, kind: 'launchd', detail: '/fake.plist' }),
    _supervisedPort: () => 51999,
    _restartSupervisorDaemon: () => { kicked += 1; return { success: true, kind: 'launchd' }; },
    _startDetachedDaemon: () => { throw new Error('must not spawn on a supervised install'); }
  }));
  assert.equal(kicked, 1, 'the supervisor serves 51999 and the CLI addresses 51999 — that IS its daemon');
});

test('R5b: the supervisor is still used when the CLI addresses the default port', async () => {
  let kicked = 0;

  await cli.restartDaemonGraceful(inertRestartSeams({
    port: 3848,
    _detectSupervisor: () => ({ present: true, kind: 'launchd' }),
    _restartSupervisorDaemon: () => { kicked += 1; return { success: true, kind: 'launchd' }; },
    // #738: a supervised install must never be handed to a detached spawn
    _startDetachedDaemon: () => { throw new Error('must not spawn on a supervised install'); }
  }));

  assert.equal(kicked, 1, '#738 supervisor ownership is preserved on the port it serves');
});
