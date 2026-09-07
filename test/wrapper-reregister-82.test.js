'use strict';

// gh#82 (D) — after a daemon restart a `telepty allow` wrapper never re-registers.
//
// The reporter measured it on 2026-09-07: `lastConnectedAt`/`lastDisconnectedAt` 450ms apart,
// `active_clients: 0`, ownerPid AND ptyPid both ALIVE and the PTY still serving a human at the
// keyboard, `STALE (OWNER_DISCONNECTED_STALE)` for 10h36m, every inject rejected `[STALE]`, five
// worker REPORTs lost. Recovery required killing the wrapper and relaunching it.
//
// ── The mechanism, measured ────────────────────────────────────────────────────────────────
// The re-register POST is NOT missing: cli.js already sends it at the top of every reconnect
// attempt. What is missing is the SECOND attempt. `ws` aborts a handshake — emitting `error` +
// close 1006 — only when nobody listens for `unexpected-response` (node_modules/ws/lib/
// websocket.js:917: `else if (!websocket.emit('unexpected-response', req, res))`). #835 added a
// listener at cli.js so a credential refusal could be NAMED instead of read as 1006, and that
// listener suppresses the abort: a daemon that ANSWERS the upgrade with a complete HTTP 401
// (src/transport/websocket.js `refuseUpgrade`) therefore produces no `error` and no `close` at
// all, `scheduleReconnect()` is never called again, and the bridge sits on a live PTY forever.
//
//   probe, this host:  listener + no terminate  →  "unexpected-response:401"   (and nothing else)
//                      listener + ws.terminate() →  "unexpected-response:401 error close:1006"
//
// So #835's readable refusal is the origin of #82(D). Two halves have to hold for the reporter's
// incident to recover, and they are one row each below:
//
//   B. the reconnect LOOP must survive a refusal            → cli.js terminate() on the refusal
//   A. and it must re-resolve the CREDENTIAL as it retries  → a daemon that came back with a
//      different token is otherwise dialled with the stale one forever, which cannot converge
//
// Row C is the #17 negative control: a daemon-issued destroy is still final.
//
// Everything runs against an isolated daemon (own HOME, own port) and a real `telepty allow`
// bridge process. The production daemon on 3848 is never contacted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../test-support/bridge-pipe-harness');

const SKIP = process.platform === 'win32'
  ? 'POSIX-only: the bridge wraps `bash` over a node-pty master (same idiom as #732/#768)'
  : false;

// The bridge inherits this process's environment. A session bearer or a daemon token from the
// shell running the suite would decide the very handshake under test, so they are cleared —
// `undefined` in a spawn env removes the key rather than setting it empty.
const CLEAN = { TELEPTY_SESSION_TOKEN: undefined, TELEPTY_SESSION_ID: undefined, TELEPTY_AUTH_TOKEN: undefined };

function configPath(home) {
  return path.join(home, '.telepty', 'config.json');
}

function readToken(home) {
  return JSON.parse(fs.readFileSync(configPath(home), 'utf8')).authToken;
}

// What a re-minted config looks like to a bridge that is already running: same file, new secret.
function rotateToken(home, token) {
  const cfg = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  cfg.authToken = token;
  fs.writeFileSync(configPath(home), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return token;
}

async function activeClients(port, home, sid) {
  const body = await H.api(port, home).session(sid);
  return body && typeof body.active_clients === 'number' ? body.active_clients : null;
}

// One connected wrapper on a fresh daemon: the state every row starts from.
async function bootBridge(t, sid) {
  const home = H.makeHome();
  const daemon = H.startDaemon({ home, env: CLEAN });
  const port = await H.daemonReady(daemon);
  const bridge = H.startBridge({ home, port, sid, env: CLEAN });
  const started = [daemon];

  t.after(() => {
    H.killBridge(bridge);
    for (const d of started) { try { d.child.kill('SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  });

  await H.waitFor(async () => (await activeClients(port, home, sid)) >= 1, {
    timeoutMs: 20000,
    description: 'the bridge owns its session on the first daemon',
    context: async () => `bridge out:\n${bridge.out}\nbridge err:\n${bridge.err}\ndaemon:\n${daemon.log().slice(-1500)}`
  });

  return { home, port, bridge, started };
}

test('gh#82 (D) row B: a REFUSED upgrade does not kill the reconnect loop — the wrapper recovers '
  + 'when the refusal clears', { skip: SKIP }, async (t) => {
  const sid = `reregB-${process.pid}`;
  const { home, port, bridge, started } = await bootBridge(t, sid);
  const configToken = readToken(home);

  // Kill the daemon the way a supervisor restart does — no close frame, the socket just dies.
  await H.stopDaemon(started[0]);

  // The daemon comes back on the same port holding a DIFFERENT secret in its environment. This
  // is the reporter's environment B exactly: "every telepty CLI call → HTTP 401 on /api/meta"
  // with `~/.telepty/config.json` unmodified since March. Because config.json still holds the
  // original token, re-reading the credential CANNOT rescue this row — the only thing that
  // decides its outcome is whether the reconnect loop is still running afterwards.
  const refusing = H.startDaemon({ home, port, env: { ...CLEAN, TELEPTY_AUTH_TOKEN: `${configToken}-rotated` } });
  started.push(refusing);
  await H.daemonReady(refusing);

  // The refusal must actually have been delivered, or this row proves nothing about refusals.
  await H.waitFor(() => /REFUSED this bridge's credentials \(HTTP 401\)/.test(bridge.out + bridge.err), {
    timeoutMs: 20000,
    description: 'the bridge is refused by the restarted daemon',
    context: async () => `bridge out:\n${bridge.out}\nbridge err:\n${bridge.err}`
  });
  assert.equal(bridge.alive(), true, 'a refusal must not kill the wrapper — it owns a live PTY');

  // The refusal clears (an operator fixes the token, or the supervisor restarts it correctly).
  await H.stopDaemon(refusing);
  const healthy = H.startDaemon({ home, port, env: CLEAN });
  started.push(healthy);
  await H.daemonReady(healthy);

  await H.waitFor(async () => (await activeClients(port, home, sid)) >= 1, {
    timeoutMs: 45000,
    description: 'the wrapper re-registers and active_clients returns to 1',
    context: async () => 'the bridge never reconnected after being refused once: the '
      + '`unexpected-response` listener suppressed ws\'s abortHandshake, so no close event ever '
      + `reached scheduleReconnect().\nbridge out:\n${bridge.out}\nbridge err:\n${bridge.err}`
  });

  assert.equal(bridge.alive(), true, 'the wrapper survived the whole sequence');
});

test('gh#82 (D) row A: a daemon that came back with a ROTATED token is reachable again — the '
  + 'wrapper re-resolves its credential as it retries', { skip: SKIP }, async (t) => {
  const sid = `reregA-${process.pid}`;
  const { home, port, bridge, started } = await bootBridge(t, sid);
  const before = readToken(home);

  await H.stopDaemon(started[0]);

  // A re-minted config.json — the shape a reinstall (or any path that rewrites the config)
  // leaves behind. The bridge resolved its token once, at launch; from here that copy is wrong.
  const after = rotateToken(home, `${before}-fresh`);
  assert.notEqual(after, before, 'the rotation has to actually change the secret');

  const second = H.startDaemon({ home, port, env: CLEAN });
  started.push(second);
  await H.daemonReady(second);

  await H.waitFor(async () => (await activeClients(port, home, sid)) >= 1, {
    timeoutMs: 45000,
    description: 'the wrapper re-registers against the rotated token',
    context: async () => 'the bridge kept dialling the token it read at launch, so every attempt '
      + `was refused 401 — a loop that cannot converge.\nbridge out:\n${bridge.out}\nbridge err:\n${bridge.err}`
  });

  assert.equal(bridge.alive(), true, 'the wrapper survived the rotation');
});

test('gh#82 (D) row C (#17 negative control): a daemon-issued DESTROY still terminates the '
  + 'wrapper — it must never re-register', { skip: SKIP }, async (t) => {
  const sid = `reregC-${process.pid}`;
  const { home, port, bridge } = await bootBridge(t, sid);

  // close 1000 'Session destroyed' — the one close code that means the daemon ended this session
  // deliberately. #17: reconnecting here would resurrect a session the GC just removed.
  const token = readToken(home);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sid)}`, {
    method: 'DELETE',
    headers: { 'x-telepty-token': token }
  });
  assert.equal(res.ok, true, 'the DELETE itself must succeed');

  await H.waitFor(() => !bridge.alive(), {
    timeoutMs: 15000,
    description: 'the wrapper exits on a daemon-issued destroy',
    context: async () => `bridge out:\n${bridge.out}\nbridge err:\n${bridge.err}`
  });

  // And it stays gone: nothing re-registers the id behind the operator's back.
  await H.delay(3000);
  const body = await H.api(port, home).session(sid);
  assert.equal(body && body.id, undefined,
    'a destroyed session came back — the reconnect loop defeated the destroy (#17)');
});
