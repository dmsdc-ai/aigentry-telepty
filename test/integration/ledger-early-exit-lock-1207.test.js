'use strict';

// #1207 — real_daemon gate for the daemon's own deterministic early exits. The ledger lock is taken
// on the main thread right after the singleton claim; two later exits in daemon.js (the second
// config read failing without an env token, and the listener's EADDRINUSE branch) called
// process.exit directly. The lock then outlived the process, so the NEXT daemon for this HOME came
// up `lock_present` and refused every tracked inject until an operator unlock. A crash leaving the
// lock is the named limitation; a refusal the daemon itself decides on is not.
//
// Prerequisites: a real daemon process, loopback TCP, writable temp HOME. POSIX only (as E1).
// Author-written for the integration phase; frozen before the product edit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { startTestDaemon } = require('../../test-support/daemon-harness');

const projectRoot = path.resolve(__dirname, '..', '..');
const POSIX = process.platform !== 'win32';
const lockPath = (home) => path.join(home, '.config', 'aigentry-telepty', 'tracked-injections.lock');
const configPath = (home) => path.join(home, '.telepty', 'config.json');

function writeConfig(home, extra = {}) {
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(home), JSON.stringify({ authToken: crypto.randomUUID(), ...extra }), { mode: 0o600 });
}

// Runs daemon.js as the daemon until it exits on its own; never signalled except past the bound.
function runDaemonToExit(home, port, timeoutMs = 30000) {
  const env = { ...process.env, HOME: home, PORT: String(port), TELEPTY_PORT: String(port), HOST: '127.0.0.1',
    AIGENTRY_TELEPTY_DAEMON_MAIN: '1', TELEPTY_NO_TAILNET_AUTO: '1', NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1' };
  delete env.TELEPTY_AUTH_TOKEN;
  delete env.TELEPTY_TRACKED_INJECTIONS_PATH;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['daemon.js'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

async function nextDaemonLedgerStore(home) {
  const d = await startTestDaemon({ homeDir: home });
  try {
    return await d.waitFor(async () => {
      const r = await d.request('/api/ledger/status');
      const store = r.status === 200 && r.body && r.body.client ? r.body.client.store : null;
      return store && store !== 'recovering' && store !== 'not_opened' ? store : null;
    }, { timeoutMs: 20000, description: 'ledger settled' });
  } finally {
    await d.stop();
  }
}

test('EX1: a port held by a non-telepty listener ⇒ daemon exits 1 AND releases its ledger lock; the next daemon for this HOME opens the ledger (not lock_present)', { skip: !POSIX && 'POSIX only' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-ex1-'));
  // Answers /api/health with a non-JSON 404, so the daemon's probe classifies it as "another process".
  const blocker = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not telepty'); });
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  try {
    writeConfig(home);
    const run = await runDaemonToExit(home, blocker.address().port);
    assert.equal(run.signal, null, `daemon exited on its own\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /already in use by another process/);
    assert.equal(fs.existsSync(lockPath(home)), false, 'ledger lock released before exit');
    await new Promise((resolve) => blocker.close(resolve));
    assert.equal(await nextDaemonLedgerStore(home), 'available');
  } finally {
    if (blocker.listening) await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('EX2: the second config read failing without an env token ⇒ daemon exits 1 AND releases its ledger lock; the next daemon (config repaired) opens the ledger', { skip: !POSIX && 'POSIX only' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-ex2-'));
  try {
    // getConfig() accepts this (authToken string); loadTeleptyConfig() rejects the duration.
    writeConfig(home, { idle_ttl_default: 'not-a-duration' });
    const run = await runDaemonToExit(home, 0);
    assert.equal(run.signal, null, `daemon exited on its own\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /\[CONFIG\] Failed to load telepty config/);
    assert.equal(fs.existsSync(lockPath(home)), false, 'ledger lock released before exit');
    writeConfig(home);
    assert.equal(await nextDaemonLedgerStore(home), 'available');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
