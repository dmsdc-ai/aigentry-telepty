'use strict';

// telepty#837 — one unreachable peer in peers.json poisoned every LOCAL write command.
//
// MEASURED (2026-08-15, this worktree, before the fix): with a single unreachable SSH peer
// configured, `telepty inject <local-sid> …` against the LOCAL daemon printed a bare
// `❌ fetch failed` — indistinguishable from the local daemon being down. The operational
// workaround was parking ~/.telepty/peers.json, i.e. deleting a working feature to keep an
// unrelated one working.
//
// THE MECHANISM, measured rather than assumed. It is NOT undici pooling one dead ORIGIN's
// failures onto another (the prior diagnosis); it is same-origin socket reuse across an
// event-loop BLOCK:
//
//   1. `resolveSessionTarget` → `discoverSessions()` fetches the LOCAL /api/sessions. undici
//      keeps that socket in its keep-alive pool.
//   2. The same `discoverSessions()` then fans out to peers. The SSH arm is
//      `spawnSync('ssh', …, {timeout: 10000})` (cross-machine.js `runRemoteCommand`) — a
//      SYNCHRONOUS call that blocks the event loop for the full 10s when the peer is
//      unreachable.
//   3. The local daemon's HTTP server hits its idle keep-alive timeout and closes that socket.
//      undici cannot notice — its timers cannot run while the loop is blocked.
//   4. The local WRITE reuses the dead socket → ECONNRESET → `fetch failed`.
//
// A busy-wait of the same duration reproduces it identically, so ssh is the blocker, not the
// cause. That matters for the fix: hardening the socket would leave the 10s dependency in
// place, and the required property is stronger than "does not crash" —
//
//   an operation addressed to the LOCAL daemon must never depend on any peer's reachability.
//
// So the fix resolves a local session against the LOCAL daemon alone and fans out to peers only
// when the local daemon has no candidate. The peer is then not merely survivable, it is not
// consulted — which is what the `ssh was never spawned` assertion below states.
//
// The daemon here binds PORT=0 with a temp HOME, and the peers.json is the harness's temp-HOME
// one. Nothing reads or writes the production daemon or the real ~/.telepty/peers.json.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

let daemon;
let sshMarker;

// A stand-in `ssh` on PATH, so "was a peer consulted?" is a file existing rather than a stopwatch
// reading. It blocks for longer than `runRemoteCommand`'s own 10s timeout, which is what
// reproduces step 2 above without needing a real unreachable host on the network.
function installFakeSsh(homeDir) {
  const binDir = path.join(homeDir, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  sshMarker = path.join(homeDir, 'ssh-was-called');
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sshMarker)}\nsleep 12\nexit 255\n`;
  const sshPath = path.join(binDir, 'ssh');
  fs.writeFileSync(sshPath, script, { mode: 0o755 });
  return binDir;
}

function writeUnreachablePeer(homeDir) {
  const peersPath = path.join(homeDir, '.telepty', 'peers.json');
  fs.mkdirSync(path.dirname(peersPath), { recursive: true });
  fs.writeFileSync(peersPath, JSON.stringify({
    peers: { deadpeer: { target: 'nobody@192.0.2.1', machineId: 'DEAD' } }
  }, null, 2));
}

// A port nothing is listening on: bound to learn a free one, then released. Used for the
// transport-failure arm, where the point is that the CLI cannot connect at all.
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });

test('#837: a LOCAL write neither fails nor waits on an unreachable peer', async () => {
  const sid = createSessionId('local-write');
  const reg = await daemon.registerSession(sid);
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);

  const binDir = installFakeSsh(daemon.homeDir);
  writeUnreachablePeer(daemon.homeDir);

  const started = Date.now();
  const result = await daemon.runCli(['inject', sid, 'hello'], {
    timeoutMs: 30000,
    env: { PATH: `${binDir}:${process.env.PATH}` }
  });
  const elapsed = Date.now() - started;
  const stderr = result.stderr;

  // The write reached the LOCAL daemon and got the local daemon's own answer. This session has
  // no owner socket, so 503 DISCONNECTED is that answer — a fact the daemon measured, unlike
  // `fetch failed`, which is the socket the peer fan-out killed.
  assert.ok(!/fetch failed/.test(stderr),
    `the local write failed at the transport instead of reaching the local daemon: ${JSON.stringify(stderr)}`);
  assert.match(stderr, /\[DISCONNECTED\]/,
    `expected the local daemon's own answer, got: ${JSON.stringify(stderr)}`);

  // Not consulted, not merely survived. `ssh` is the only peer transport configured here, so its
  // absence from PATH usage is the whole peer fan-out never having run.
  assert.ok(!fs.existsSync(sshMarker),
    'the local write fanned out to a peer — a local operation must not depend on any peer at all');

  // The stopwatch is corroboration, not the assertion: the fake ssh blocks 12s and
  // `runRemoteCommand` caps it at 10s, so any fan-out is unmistakable in the timing too.
  assert.ok(elapsed < 5000, `local write took ${elapsed}ms — a peer was waited on`);
});

test('#837: a transport failure names WHICH origin could not be reached', async () => {
  // `fetch failed` with no host is an output claiming less than it measured — it is precisely
  // how the operator read a poisoned socket as "the local daemon is down". Every CLI request
  // goes through fetchWithAuth, so the origin is named once, there, for all 45 call sites.
  //
  // This arm doubles as telepty#840's transport row: a delivery that never reached a daemon
  // must not exit 0. TELEPTY_HOST is deliberately non-local so `ensureDaemonRunning` returns
  // early (cli.js:986) and no daemon is started for a port chosen to be dead; TELEPTY_AUTH_TOKEN
  // is set so #844's credential refusal (a different, already-non-zero arm) is not what fires.
  const port = await closedPort();
  const result = await daemon.runCli(['inject', 'no-such-session', 'hello'], {
    timeoutMs: 30000,
    env: { TELEPTY_HOST: '0.0.0.0', TELEPTY_PORT: String(port), TELEPTY_AUTH_TOKEN: 'not-the-point' }
  });

  assert.match(result.stderr, new RegExp(`0\\.0\\.0\\.0:${port}`),
    `the error did not name the origin it failed to reach: ${JSON.stringify(result.stderr)}`);
  assert.notEqual(result.code, 0,
    'a write that never reached a daemon exited 0 (telepty#840)');
});
