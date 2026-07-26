'use strict';

// #732 repro harness: a real daemon.js process plus a real `telepty allow` bridge
// process, both on an isolated HOME and an ephemeral port, so the two legs of a
// wrapped session can be driven and severed independently.
//
//   upstream   : PTY -> child.onData (cli.js:2064) -> owner-WS 'output' frame
//                -> daemon appendToOutputRing (src/transport/websocket.js:158-161)
//   downstream : POST /inject -> writeDataToSession (daemon.js:1823-1828)
//                -> owner-WS 'inject' frame -> child.write (cli.js:1933-1941)
//
// #524 guard: every process started here is owned by the caller and killed in
// stop(); the production daemon (3848) is never contacted — the daemon binds its
// own ephemeral port under its own HOME.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const LISTENING_BANNER = /listening on https?:\/\/[^\s]+:(\d+)/;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, { timeoutMs = 10000, intervalMs = 50, description = 'condition', context = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await check(); if (r) return r; } catch { /* keep polling */ }
    await delay(intervalMs);
  }
  // A two-process PTY race that times out is unreadable without the state of both
  // processes — `context` is how the caller attaches it (see #768).
  let extra = '';
  if (context) { try { extra = `\n${await context()}`; } catch (e) { extra = `\n[context failed: ${e.message}]`; } }
  throw new Error(`Timed out waiting for ${description}${extra}`);
}

function makeHome() {
  // /tmp on darwin keeps socket paths short (see bridge-e2e.test.js).
  const base = process.platform === 'darwin' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  return fs.mkdtempSync(path.join(base, 'tp732-'));
}

function startDaemon({ home, port = 0, env = {} }) {
  const d = { stdout: '', stderr: '', port, child: null, log: () => d.stdout + d.stderr };
  d.child = spawn(process.execPath, ['daemon.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      HOST: '127.0.0.1',
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  d.child.stdout.on('data', (c) => { d.stdout += c.toString(); });
  d.child.stderr.on('data', (c) => { d.stderr += c.toString(); });
  return d;
}

async function daemonReady(d) {
  await waitFor(async () => {
    if (d.child.exitCode !== null) throw new Error(`daemon exited early:\n${d.log()}`);
    if (!d.port) {
      const m = d.stdout.match(LISTENING_BANNER);
      if (!m) return false;
      d.port = Number(m[1]);
    }
    return (await fetch(`http://127.0.0.1:${d.port}/api/sessions`)).ok;
  }, { timeoutMs: 15000, description: 'daemon start' });
  return d.port;
}

async function stopDaemon(d, signal = 'SIGKILL') {
  if (!d || !d.child || d.child.exitCode !== null) return;
  d.child.kill(signal);
  await waitFor(() => d.child.exitCode !== null || d.child.signalCode !== null,
    { timeoutMs: 5000, description: 'daemon exit' }).catch(() => {});
}

// A real `telepty allow` bridge. `faultInjector: true` preloads
// test-support/pty-read-fault.js so the upstream leg can be severed on SIGUSR2.
function startBridge({ home, port, sid, cmd = ['bash', '--noprofile', '--norc'], faultInjector = false, env = {} }) {
  const b = { out: '', err: '', child: null };
  b.child = spawn(process.execPath, ['cli.js', 'allow', '--id', sid, ...cmd], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: home,
      TELEPTY_HOST: '127.0.0.1',
      TELEPTY_PORT: String(port),
      TERM: 'xterm-256color',
      PS1: 'RDY$ ',
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      ...(faultInjector ? { NODE_OPTIONS: `--require ${path.join(__dirname, 'pty-read-fault.js')}` } : {}),
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  b.child.stdout.on('data', (c) => { b.out += c.toString(); });
  b.child.stderr.on('data', (c) => { b.err += c.toString(); });
  b.severUpstream = () => b.child.kill('SIGUSR2');
  b.alive = () => b.child.exitCode === null;
  return b;
}

function killBridge(b) {
  if (b && b.child) { try { b.child.kill('SIGKILL'); } catch { /* already gone */ } }
}

function api(port) {
  const base = `http://127.0.0.1:${port}`;
  const json = async (r) => (r.ok ? r.json() : { status: r.status });
  return {
    screen: async (sid) => {
      const r = await fetch(`${base}/api/sessions/${encodeURIComponent(sid)}/screen?lines=200`);
      return r.ok ? r.json() : { screen: '', status: r.status };
    },
    session: (sid) => fetch(`${base}/api/sessions/${encodeURIComponent(sid)}`).then(json),
    inject: async (sid, prompt, extra = {}) => {
      const r = await fetch(`${base}/api/sessions/${encodeURIComponent(sid)}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...extra })
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }
  };
}

// Controllable TCP proxy for socket-level levers (blackhole a direction without
// FIN/RST, drop connections while staying bound, or delay one direction).
//
// holdWsUpgradeMs (#768): postpone ONLY the WebSocket upgrade by that long — plain HTTP is
// forwarded untouched. Nothing is dropped; the upgrade bytes are queued in order and then
// delivered, so this delays the owner-WS handshake without breaking it, and the bridge's PTY
// has provably booted and printed before its owner WS can open. That race is what decides
// whether pre-connect PTY output survives, and it is otherwise timing-dependent (Linux loses
// it almost always, macOS usually wins it).
//
// It has to be upgrade-only: holding the whole bridge->daemon direction also starves the
// CLI's own HTTP health/version probes, and the CLI then concludes the daemon is broken and
// goes off to restart it — which tests daemon management, not this pipe.
function startProxy({ targetPort, targetHost = '127.0.0.1', holdWsUpgradeMs = 0 }) {
  const pairs = new Set();
  const state = { up: true, down: true }; // up = bridge->daemon, down = daemon->bridge
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    const pair = { client, upstream };
    pairs.add(pair);
    // Per-connection: `held` is an array while this connection's bytes are being queued,
    // and null once it is a straight pass-through (either plain HTTP or the hold expired).
    let held = null;
    let sniffed = holdWsUpgradeMs <= 0;
    client.on('data', (c) => {
      if (!state.up) return;
      if (!sniffed) {
        // Request line + headers arrive in one loopback segment, so the first chunk decides.
        sniffed = true;
        if (/upgrade:\s*websocket/i.test(c.toString('latin1'))) {
          held = [];
          setTimeout(() => {
            const queued = held;
            held = null;
            for (const b of queued) { if (state.up) upstream.write(b); }
          }, holdWsUpgradeMs).unref();
        }
      }
      if (held) held.push(c); else upstream.write(c);
    });
    upstream.on('data', (c) => { if (state.down) client.write(c); });
    const bye = () => {
      pairs.delete(pair);
      try { client.destroy(); } catch { /* already gone */ }
      try { upstream.destroy(); } catch { /* already gone */ }
    };
    for (const s of [client, upstream]) { s.on('close', bye); s.on('error', bye); }
  });
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    blackhole(dir) {
      if (dir === 'up' || dir === 'both') state.up = false;
      if (dir === 'down' || dir === 'both') state.down = false;
    },
    dropConnections() {
      for (const p of pairs) {
        try { p.client.destroy(); } catch { /* already gone */ }
        try { p.upstream.destroy(); } catch { /* already gone */ }
      }
      pairs.clear();
    },
    close() { this.dropConnections(); server.close(); }
  };
}

module.exports = {
  delay, waitFor, makeHome,
  startDaemon, daemonReady, stopDaemon,
  startBridge, killBridge, api, startProxy
};
