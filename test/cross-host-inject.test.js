'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, stripAnsi, waitFor } = require('../test-support/daemon-harness');

let daemonA = null; // Local-side CLI's daemon (also serves as origin)
let daemonB = null; // Remote-side daemon hosting the target session

function collectMessages(ws, predicate, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(options.description || 'WS message timeout'));
    }, options.timeoutMs || 7000);

    function onMessage(buffer) {
      let parsed = null;
      try {
        parsed = JSON.parse(buffer.toString());
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(parsed);
      }
    }

    ws.on('message', onMessage);
  });
}

// #820/#823 — this file simulates cross-host over LOOPBACK: two harness daemons, two temp HOMEs,
// two DIFFERENT tokens, both on 127.0.0.1 (see the comment inside the first test). So the moment
// loopback stops being a credential, a CLI running out of daemonA's HOME presents daemonA's token
// to daemonB and is refused — in production AND here.
//
// The fix is to resolve the TARGET's token, keyed by ADDRESS. `connect-http --token` is how an
// operator supplies it, and it is the one user-visible migration this release asks for; running it
// once here is what lets every dial site below authenticate against daemonB.
//
// Note what does NOT work and why, because it is the trap: setting TELEPTY_AUTH_TOKEN to daemonB's
// token would make the CLI present it to daemonA too — the local /api/meta probe in
// ensureDaemonRunning — and that 401s. The env override is a FLEET-WIDE token for both ends, not a
// per-target one; a process talking to two daemons needs the per-address path.
before(async () => {
  daemonA = await startTestDaemon();
  daemonB = await startTestDaemon();

  const peer = await daemonA.runCli([
    'connect-http', `${daemonB.host}:${daemonB.port}`,
    '--name', 'crosshost-peer',
    '--token', daemonB.authToken()
  ], { timeoutMs: 8000 });
  assert.equal(peer.code, 0, `connect-http --token failed:\nstderr: ${peer.stderr}\nstdout: ${peer.stdout}`);
});

after(async () => {
  if (daemonA) await daemonA.stop();
  if (daemonB) await daemonB.stop();
});

test('cross-host: <id>@<host>:<port> routes inject to the remote daemon', async () => {
  const sessionId = createSessionId('cross-host-target');
  const spawn = await daemonB.spawnSession(sessionId);
  assert.ok([200, 201].includes(spawn.status), `spawnSession status=${spawn.status}: ${JSON.stringify(spawn.body)}`);

  const targetWs = new WebSocket(
    `ws://${daemonB.host}:${daemonB.port}/api/sessions/${encodeURIComponent(sessionId)}`
    + `?token=${encodeURIComponent(daemonB.authToken())}`);
  await new Promise((resolve, reject) => {
    targetWs.once('open', resolve);
    targetWs.once('error', reject);
  });

  const token = createSessionId('cross-host-token');
  const seenToken = collectMessages(
    targetWs,
    (msg) => msg.type === 'output' && String(msg.data || '').includes(token),
    { description: 'cross-host inject delivery', timeoutMs: 8000 }
  );

  // Run the CLI from daemonA's HOME but target daemonB explicitly via @host:port. The token for
  // daemonB is resolved from its peers.json entry BY ADDRESS — the dial site here has only a host
  // string, never a peer name, which is why name-keyed resolution never fired for this path.
  const result = await daemonA.runCli([
    'inject',
    `${sessionId}@${daemonB.host}:${daemonB.port}`,
    `echo ${token}`
  ], { timeoutMs: 8000 });

  assert.equal(result.code, 0, `CLI failed:\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
  await seenToken;
  targetWs.close();
});

test('cross-host: TELEPTY_HOST=host:port produces a clean http URL (no double-port)', async () => {
  // Regression for #13c. Previously TELEPTY_HOST=host:port concatenated :PORT
  // again, producing http://host:port:port/api/... and a parser error.
  const sessionId = createSessionId('cross-host-env');
  await daemonB.spawnSession(sessionId);

  const result = await daemonA.runCli(['list', '--json'], {
    timeoutMs: 8000,
    env: {
      TELEPTY_HOST: `${daemonB.host}:${daemonB.port}`,
      // Intentionally clear TELEPTY_PORT so the embedded port governs.
      TELEPTY_PORT: ''
      // #820: no TELEPTY_AUTH_TOKEN — the address resolves daemonB's stored peer token.
    }
  });

  assert.equal(result.code, 0, `CLI failed:\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
  // The session lives on daemonB; with TELEPTY_HOST=host:port we should see it.
  const out = stripAnsi(result.stdout);
  assert.match(out, new RegExp(sessionId), `session ${sessionId} should appear in output:\n${out}`);
  // Negative regression: stderr must NOT contain the old "Failed to parse URL"
  // error from the doubled-port URL bug (#13c).
  const errCombined = stripAnsi(result.stderr);
  assert.doesNotMatch(errCombined, /Failed to parse URL/, `unexpected URL parse error:\n${errCombined}`);
  assert.doesNotMatch(errCombined, new RegExp(`http://[^\\s]*:${daemonB.port}:${daemonB.port}`), `doubled-port URL detected:\n${errCombined}`);
});

test('connect-http: registers HTTP peer in peers.json and exposes its sessions to discovery', async () => {
  const peersPath = path.join(daemonA.homeDir, '.telepty', 'peers.json');
  // Pre-condition: no peers
  if (fs.existsSync(peersPath)) {
    fs.rmSync(peersPath);
  }

  // #820/#823 — `--token <that host's authToken>` is the migration this release asks cross-host
  // HTTP-peer users to perform, and this is the path that proves it works end to end: the token
  // is stored in peers.json by connect-http and then RESOLVED BY ADDRESS at discovery time.
  // Before this release connect-http wrote `entry.token` and nothing ever read it.
  const peerName = createSessionId('peer-http');
  const connect = await daemonA.runCli([
    'connect-http',
    `${daemonB.host}:${daemonB.port}`,
    '--name', peerName,
    '--token', daemonB.authToken()
  ], { timeoutMs: 8000 });

  assert.equal(connect.code, 0, `connect-http failed:\nstderr: ${connect.stderr}\nstdout: ${connect.stdout}`);

  // peers.json should now contain an HTTP-transport entry
  assert.ok(fs.existsSync(peersPath), 'peers.json should exist after connect-http');
  const peers = JSON.parse(fs.readFileSync(peersPath, 'utf8'));
  const entry = peers.peers && peers.peers[peerName];
  assert.ok(entry, `peer ${peerName} should be persisted`);
  assert.equal(entry.transport, 'http');
  assert.equal(entry.host, daemonB.host);
  assert.equal(entry.port, daemonB.port);
  assert.equal(entry.token, daemonB.authToken(), 'the peer token is stored so discovery can present it');

  // Spawn a fresh session on daemon B and verify it shows up in `list` from A
  const remoteSession = createSessionId('cross-host-discovered');
  await daemonB.spawnSession(remoteSession);

  const list = await daemonA.runCli(['list', '--json'], { timeoutMs: 8000 });
  assert.equal(list.code, 0, list.stderr);
  const listOut = stripAnsi(list.stdout);
  assert.match(listOut, new RegExp(remoteSession), `discovered HTTP-peer session not found in list:\n${listOut}`);
});

test('connect-http: rejects unreachable host with a clear error and non-zero exit', async () => {
  // Use a port we know nothing is listening on. Random high port.
  const deadPort = 30000 + Math.floor(Math.random() * 100);
  const result = await daemonA.runCli([
    'connect-http',
    `127.0.0.1:${deadPort}`,
    '--name', 'should-not-persist'
  ], { timeoutMs: 8000 });

  assert.notEqual(result.code, 0, 'expected non-zero exit when peer unreachable');
  const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(combined, /Cannot reach|connect|reach/i);
});
