'use strict';

// #835 (P0) — a response that ARRIVES and DECLINES is not an absence.
//
// Three outcomes must stay distinguishable on every daemon/peer probe, because only ONE of
// them may honestly degrade to an empty result:
//
//   connect error / ECONNREFUSED  daemon unreachable  → [] / null is honest
//   401 / 403                     daemon REFUSED us   → name it, never []
//   5xx / unparseable             daemon is BROKEN    → name it, never []
//
// Two consequences are load-bearing and are what this file pins:
//   1. A refusal must never reach a DESTRUCTIVE remediation. `decideDaemonAction` returning
//      `start` authorizes restartDaemonGraceful → cleanupDaemonProcesses → SIGTERM/SIGKILL of
//      every process that looks like a telepty daemon — while the daemon that refused us is
//      alive, correct-version, and the parent of every live PTY session.
//   2. A refusal must never be reported as success. `list --json` printing `[]` with exit 0,
//      `broadcast` printing "✅ … to 0 active session(s)", `clean` printing "✅ No ghost
//      sessions found" are all the same misreport.
//
// SAFETY: this suite runs on a host with live telepty daemons. In-process cases use injected
// seams only (no real socket, no real process). Subprocess cases point the CLI at a stub HTTP
// server on an ephemeral port AND preload test-support/block-signals.js, so the kill path can
// be reached and measured without a signal ever being delivered.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pkg = require('../package.json');
const { decideDaemonAction, ensureDaemonRunning } = require('../cli');

const CAP = 'wrapped-sessions';
const REPO_ROOT = path.resolve(__dirname, '..');
const BLOCK_SIGNALS = path.join(REPO_ROOT, 'test-support', 'block-signals.js');

// A daemon answer that is not a result: no `version`, so every pre-#835 `meta && meta.version`
// reader is unaffected — the classification is additive.
const refusedAnswer = (status = 401) => ({ answered: true, status, refused: true, endpoint: '/api/meta' });
const brokenAnswer = (status = 503) => ({ answered: true, status, refused: false, endpoint: '/api/meta' });

function recordingRestart() {
  const calls = [];
  const fn = async (opts) => { calls.push(opts || {}); return { success: true }; };
  fn.calls = calls;
  return fn;
}

const noSupervisor = () => ({ present: false });

// ── 1. The destructive verdict ────────────────────────────────────────────────

test('#835 decideDaemonAction: a 401 answer never returns a verdict that authorizes a kill', () => {
  const d = decideDaemonAction({
    meta: refusedAnswer(401),
    requiredCapabilities: [CAP],
    cliVersion: pkg.version,
    sessionsReachable: false
  });
  assert.notEqual(d.action, 'start', 'start → restartDaemonGraceful → SIGKILL of a live daemon');
  assert.notEqual(d.action, 'restart');
  assert.equal(d.action, 'abort');
  assert.match(d.reason, /refus/i);
});

test('#835 decideDaemonAction: a 403 answer is a refusal too', () => {
  const d = decideDaemonAction({ meta: refusedAnswer(403), cliVersion: pkg.version });
  assert.equal(d.action, 'abort');
});

test('#835 decideDaemonAction: a 5xx answer is "broken", not "absent"', () => {
  const d = decideDaemonAction({ meta: brokenAnswer(503), cliVersion: pkg.version });
  assert.equal(d.action, 'abort');
  assert.match(d.reason, /503/);
});

test('#835 decideDaemonAction: nothing answered still auto-starts (the one legitimate absence)', () => {
  const d = decideDaemonAction({ meta: null, cliVersion: pkg.version, sessionsReachable: false });
  assert.equal(d.action, 'start');
  assert.equal(d.reason, 'daemon-unreachable');
});

test('#835 decideDaemonAction: legacy daemon (sessions answer, no meta) still restarts', () => {
  const d = decideDaemonAction({ meta: null, cliVersion: pkg.version, sessionsReachable: true });
  assert.equal(d.action, 'restart');
  assert.equal(d.reason, 'legacy-daemon-no-meta');
});

// ── 2. ensureDaemonRunning must not remediate a refusal ───────────────────────

test('#835 ensureDaemonRunning: /api/meta 401 → throws, and NEVER calls the restart path', async () => {
  const doRestart = recordingRestart();
  await assert.rejects(
    ensureDaemonRunning({
      _getDaemonMeta: async () => refusedAnswer(401),
      _fetchWithAuth: async () => { throw new Error('sessions probe must not be needed'); },
      _restartDaemonGraceful: doRestart,
      _detectSupervisor: noSupervisor,
      _probe: { attempts: 1, backoffMs: 0 }
    }),
    (error) => {
      assert.equal(error.name, 'DaemonResponseError');
      assert.equal(error.status, 401);
      assert.match(error.message, /refus/i);
      return true;
    }
  );
  assert.equal(doRestart.calls.length, 0, 'a refusal reached restartDaemonGraceful');
});

test('#835 ensureDaemonRunning: legacy probe 401 (no meta) → throws, no restart', async () => {
  const doRestart = recordingRestart();
  await assert.rejects(
    ensureDaemonRunning({
      _getDaemonMeta: async () => null,
      _fetchWithAuth: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      _restartDaemonGraceful: doRestart,
      _detectSupervisor: noSupervisor,
      _probe: { attempts: 1, backoffMs: 0 }
    }),
    (error) => error.name === 'DaemonResponseError'
  );
  assert.equal(doRestart.calls.length, 0);
});

test('#835 ensureDaemonRunning: a genuinely absent daemon is still auto-started', async () => {
  const doRestart = recordingRestart();
  await ensureDaemonRunning({
    _getDaemonMeta: async () => null,
    _fetchWithAuth: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    _restartDaemonGraceful: doRestart,
    _detectSupervisor: noSupervisor,
    _probe: { attempts: 1, backoffMs: 0 }
  });
  assert.equal(doRestart.calls.length, 1, 'unreachable must still be remediated');
});

// ── 3. End-to-end: what the operator actually sees ────────────────────────────

// `mode` picks what the stub answers with. 'refuse-all' is a daemon that declines every route.
// 'refuse-sessions' answers /api/meta as a healthy daemon and refuses everything else, which
// isolates the DISCOVERY path from the restart path.
function startStubDaemon(mode) {
  const server = http.createServer((req, res) => {
    const healthyMeta = mode === 'refuse-sessions' && req.url.startsWith('/api/meta');
    if (!healthyMeta) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token.', code: 'PERMISSION_DENIED' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: pkg.version, capabilities: [CAP] }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runCli(args, port, signalsLog) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'cli.js'), ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TELEPTY_PORT: String(port),
        TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
        NO_UPDATE_NOTIFIER: '1',
        TELEPTY_SUPERVISOR_WAIT_MS: '1',
        TELEPTY_DAEMON_KILL_GRACE_MS: '10',
        BLOCKED_SIGNALS_LOG: signalsLog,
        NODE_OPTIONS: `--require ${BLOCK_SIGNALS}`
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function blockedSignals(logPath) {
  try { return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

test('#835 a refused CLI reports the refusal and kills nothing', async (t) => {
  const { server, port } = await startStubDaemon('refuse-all');
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-835-')), 'signals.log');
  t.after(() => server.close());

  const result = await runCli(['list', '--json'], port, log);

  assert.equal(blockedSignals(log).length, 0, `a 401 reached the kill path: ${blockedSignals(log).slice(0, 3).join(' | ')}`);
  assert.notEqual(result.code, 0, 'a refused command exited 0 — every script reads that as success');
  assert.equal(result.stdout.trim(), '', 'a refusal must not print a session list of any shape');
  assert.match(result.stderr, /401/);
});

test('#835 discovery: a refused /api/sessions never becomes an empty session list', async (t) => {
  const { server, port } = await startStubDaemon('refuse-sessions');
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-835-')), 'signals.log');
  t.after(() => server.close());

  const listed = await runCli(['list', '--json'], port, log);
  assert.notEqual(listed.stdout.trim(), '[]', 'refusal rendered as an empty JSON list');
  assert.notEqual(listed.code, 0);

  const listedHuman = await runCli(['list'], port, log);
  assert.doesNotMatch(listedHuman.stdout, /No active sessions found/);

  const broadcast = await runCli(['broadcast', 'ping'], port, log);
  assert.doesNotMatch(broadcast.stdout, /✅/, 'refused broadcast reported success');
  assert.notEqual(broadcast.code, 0);

  const cleaned = await runCli(['clean'], port, log);
  assert.doesNotMatch(cleaned.stdout, /✅ No ghost sessions found/);
  assert.notEqual(cleaned.code, 0);

  assert.equal(blockedSignals(log).length, 0);
});

// ── 4. Peers: a refused peer is not a peer with no sessions ───────────────────

test('#835 http peer: a 401 is reported as a failure, not as zero sessions', async (t) => {
  const { server, port } = await startStubDaemon('refuse-all');
  t.after(() => server.close());

  const peersPath = path.join(os.homedir(), '.telepty', 'peers.json');
  fs.mkdirSync(path.dirname(peersPath), { recursive: true });
  fs.writeFileSync(peersPath, JSON.stringify({
    peers: { stub: { transport: 'http', host: '127.0.0.1', port, token: 'wrong-token' } }
  }));
  t.after(() => { try { fs.unlinkSync(peersPath); } catch {} });

  const crossMachine = require('../cross-machine');
  const result = await crossMachine.discoverHttpRemoteSessions();

  assert.deepEqual(result.sessions, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /401/);
  assert.match(result.failures[0].message, /stub/);
});

test('#835 http peer: an unreachable peer still degrades to no sessions, silently', async (t) => {
  // Claim a port, then release it: connecting there is a connect error, the one condition
  // for which an empty result is honest.
  const { server, port } = await startStubDaemon('refuse-all');
  await new Promise((resolve) => server.close(resolve));

  const peersPath = path.join(os.homedir(), '.telepty', 'peers.json');
  fs.mkdirSync(path.dirname(peersPath), { recursive: true });
  fs.writeFileSync(peersPath, JSON.stringify({
    peers: { gone: { transport: 'http', host: '127.0.0.1', port, token: 'whatever' } }
  }));
  t.after(() => { try { fs.unlinkSync(peersPath); } catch {} });

  const crossMachine = require('../cross-machine');
  const result = await crossMachine.discoverHttpRemoteSessions({ timeoutMs: 500 });

  assert.deepEqual(result.sessions, []);
  assert.equal(result.failures.length, 0);
});
