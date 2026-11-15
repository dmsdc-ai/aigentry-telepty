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
    // #820: /api/health is registered before the auth middleware, so readiness does not depend on
    // a credential the daemon may not have written to disk yet.
    return (await fetch(`http://127.0.0.1:${d.port}/api/health`)).ok;
  }, { timeoutMs: 15000, description: 'daemon start' });
  return d.port;
}

// #820 — the token this daemon is serving, read from its own isolated HOME the way any real
// consumer reads it.
function daemonToken(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.telepty', 'config.json'), 'utf8')).authToken;
  } catch { return null; }
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

// #820: every call carries the daemon token — loopback is no longer a credential. `home` is the
// isolated HOME the daemon was started with; the token is read from it per call so a harness
// created before the daemon finished writing config.json still authenticates.
function api(port, home) {
  const base = `http://127.0.0.1:${port}`;
  const auth = (extra = {}) => {
    const token = home ? daemonToken(home) : null;
    return token ? { 'x-telepty-token': token, ...extra } : { ...extra };
  };
  const json = async (r) => (r.ok ? r.json() : { status: r.status });
  return {
    screen: async (sid) => {
      const r = await fetch(`${base}/api/sessions/${encodeURIComponent(sid)}/screen?lines=200`, { headers: auth() });
      return r.ok ? r.json() : { screen: '', status: r.status };
    },
    session: (sid) => fetch(`${base}/api/sessions/${encodeURIComponent(sid)}`, { headers: auth() }).then(json),
    inject: async (sid, prompt, extra = {}) => {
      const r = await fetch(`${base}/api/sessions/${encodeURIComponent(sid)}/inject`, {
        method: 'POST',
        headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt, ...extra })
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }
  };
}

// Task 1270 — opt-in request observation for startProxy (`observe: true`; absent ⇒ the proxy is unchanged).
// Each client→daemon connection is framed as HTTP/1.1: a request head is buffered to its CRLFCRLF (≤ 16 KiB), then forwarded
// unchanged; the body is framed by Content-Length. Recorded per request: { conn, method, path (query stripped), upgrade } —
// never headers, bodies, tokens or prompt data. An Upgrade request turns the connection into opaque pass-through (WS frames are
// never parsed); Transfer-Encoding, a bad Content-Length or an oversize/malformed head do too and count in unparsed(), so a test
// can require that framing never fell back. Two single-shot, exactly-one-request seams:
//   holdNextRequest({method, path})  — the next matching request (and every later byte of its connection) is queued at the proxy
//                                       until releaseHeldRequests(); heldCount() counts requests ever held.
//   failNextResponse({method, path}) — once the next matching request has been fully forwarded, the first daemon→client bytes on
//                                       that connection are its response: only the status code is read, the bytes are NOT
//                                       forwarded, and that connection pair is destroyed (the daemon answered, the client never
//                                       learns how). Recorded in faults().
const OBSERVE_HEAD_MAX = 16 * 1024;
const OBSERVE_RECORDS_MAX = 1000;
function createRequestObserver() {
  const records = [];
  const faults = [];
  const taps = new Set();
  let overflow = false; let unparsed = 0; let heldTotal = 0; let nextConn = 0;
  let holdArm = null; let faultArm = null;
  const matches = (arm, entry) => !!arm && arm.method === entry.method && arm.path === entry.path;
  const arm = (spec) => {
    if (!spec || typeof spec.method !== 'string' || typeof spec.path !== 'string') throw new TypeError('startProxy observe: {method, path} strings required');
    return { method: spec.method, path: spec.path };
  };
  function connection(forward, destroyPair) {
    const conn = ++nextConn;
    let mode = 'head'; let head = Buffer.alloc(0); let remaining = 0;
    let holding = false; let disposed = false; const queue = [];
    let faultPending = null; let faultArmed = null;
    const emit = (b) => { if (b.length === 0) return; if (holding) queue.push(b); else forward(b); };
    const complete = () => { if (faultPending) { faultArmed = faultPending; faultPending = null; } mode = 'head'; };
    const opaque = (rest, fallback) => { if (fallback) unparsed++; mode = 'opaque'; emit(rest); };
    function feed(chunk) {
      let buf = chunk;
      while (buf.length > 0) {
        if (mode === 'opaque') { emit(buf); return; }
        if (mode === 'body') {
          const n = Math.min(remaining, buf.length);
          emit(buf.subarray(0, n)); remaining -= n; buf = buf.subarray(n);
          if (remaining === 0) complete();
          continue;
        }
        const joined = head.length ? Buffer.concat([head, buf]) : buf;
        const end = joined.indexOf('\r\n\r\n');
        if (end === -1) {
          if (joined.length > OBSERVE_HEAD_MAX) { head = Buffer.alloc(0); opaque(joined, true); return; }
          head = Buffer.from(joined); return;
        }
        const headBytes = joined.subarray(0, end + 4);
        buf = joined.subarray(end + 4);
        head = Buffer.alloc(0);
        const lines = headBytes.toString('latin1').split('\r\n');
        const line = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0]);
        if (!line) { opaque(Buffer.concat([headBytes, buf]), true); return; }
        let length = 0; let framed = true; let upgrade = false;
        for (const h of lines.slice(1)) {
          const i = h.indexOf(':');
          if (i <= 0) continue;
          const name = h.slice(0, i).trim().toLowerCase(); const value = h.slice(i + 1).trim();
          if (name === 'content-length') { if (/^\d+$/.test(value)) length = Number(value); else framed = false; }
          else if (name === 'transfer-encoding') framed = false;
          else if (name === 'upgrade') upgrade = true;
        }
        const entry = { conn, method: line[1], path: line[2].split('?')[0], upgrade };
        if (records.length < OBSERVE_RECORDS_MAX) records.push(entry); else overflow = true;
        if (matches(holdArm, entry)) { holdArm = null; holding = true; heldTotal++; }
        if (matches(faultArm, entry)) { faultArm = null; faultPending = entry; }
        emit(headBytes);
        if (upgrade) { opaque(buf, false); return; }
        if (!framed) { opaque(buf, true); return; }
        if (length > 0) { mode = 'body'; remaining = length; } else complete();
      }
    }
    function intercept(chunk) {
      if (!faultArmed) return false;
      const entry = faultArmed; faultArmed = null;
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(chunk.subarray(0, 32).toString('latin1'));
      faults.push({ conn, method: entry.method, path: entry.path, status: status ? Number(status[1]) : null });
      destroyPair();
      return true;
    }
    const tap = {
      feed, intercept,
      release() { if (!holding) return; holding = false; if (!disposed) for (const b of queue.splice(0)) forward(b); },
      dispose() { disposed = true; queue.length = 0; taps.delete(tap); }
    };
    taps.add(tap);
    return tap;
  }
  return {
    connection,
    api: {
      requests: () => records.map(r => ({ ...r })),
      faults: () => faults.map(f => ({ ...f })),
      unparsed: () => unparsed,
      overflow: () => overflow,
      heldCount: () => heldTotal,
      holdNextRequest(spec) { holdArm = arm(spec); },
      failNextResponse(spec) { faultArm = arm(spec); },
      releaseHeldRequests() { for (const tap of [...taps]) tap.release(); }
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
function startProxy({ targetPort, targetHost = '127.0.0.1', holdWsUpgradeMs = 0, manualHoldWsUpgrade = false, observe = false }) {
  const pairs = new Set();
  const observer = observe ? createRequestObserver() : null;   // Task 1270 (see createRequestObserver)
  const upgradeReleases = [];
  let upgradesReleased = false;
  const state = { up: true, down: true }; // up = bridge->daemon, down = daemon->bridge
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    const pair = { client, upstream };
    pairs.add(pair);
    // Per-connection: `held` is an array while this connection's bytes are being queued,
    // and null once it is a straight pass-through (either plain HTTP or the hold expired).
    let held = null;
    let sniffed = !manualHoldWsUpgrade && holdWsUpgradeMs <= 0;
    const forward = (c) => { if (held) held.push(c); else upstream.write(c); };
    const tap = observer ? observer.connection(forward, () => bye()) : null;
    client.on('data', (c) => {
      if (!state.up) return;
      if (!sniffed) {
        // Request line + headers arrive in one loopback segment, so the first chunk decides.
        sniffed = true;
        if (/upgrade:\s*websocket/i.test(c.toString('latin1')) && (!manualHoldWsUpgrade || !upgradesReleased)) {
          held = [];
          const release = () => {
            const queued = held || [];
            held = null;
            for (const b of queued) { if (state.up) upstream.write(b); }
          };
          if (manualHoldWsUpgrade) upgradeReleases.push(release);
          else setTimeout(release, holdWsUpgradeMs).unref();
        }
      }
      if (tap) tap.feed(c); else forward(c);
    });
    upstream.on('data', (c) => { if (state.down && !(tap && tap.intercept(c))) client.write(c); });
    const bye = () => {
      if (tap) tap.dispose();
      pairs.delete(pair);
      try { client.destroy(); } catch { /* already gone */ }
      try { upstream.destroy(); } catch { /* already gone */ }
    };
    for (const s of [client, upstream]) { s.on('close', bye); s.on('error', bye); }
  });
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    releaseUpgrades() {
      upgradesReleased = true;
      for (const release of upgradeReleases.splice(0)) release();
    },
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
    close() { this.dropConnections(); server.close(); },
    ...(observer ? observer.api : {})
  };
}

module.exports = {
  delay, waitFor, makeHome,
  startDaemon, daemonReady, daemonToken, stopDaemon,
  startBridge, killBridge, api, startProxy
};
