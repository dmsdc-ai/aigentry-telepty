'use strict';

// #691 — Windows libuv crash on `telepty inject <phantom-sid>` (session-not-found).
//
// On the not-found (and remote-entitlement) exit path, the CLI used a hard
// `process.exit(1)` immediately after resolveSessionTarget → discoverSessions()
// had opened async handles (undici keep-alive sockets, AbortSignal.timeout
// timers). A hard exit races that teardown and, on Windows, trips a libuv
// double-close assertion: `!(handle->flags & UV_HANDLE_CLOSING), src/win/async.c:76`.
// That crash left the wrapped session wedged and dropped subsequent CRs.
//
// The crash is a Windows-only libuv timing race — it cannot be reproduced on
// macOS/Linux. So we assert the PLATFORM-INDEPENDENT teardown CONTRACT instead
// of the crash:
//   1. (source)     the inject not-found + entitlement branches drain-exit
//                   (process.exitCode + return), never a hard process.exit()
//                   that races handle teardown. This is the fix; it FAILS on
//                   the pre-#691 code.
//   2. (behavioral) removing process.exit() must not hang — the not-found path
//                   still exits promptly with code 1 by natural event-loop drain.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(PROJECT_ROOT, 'cli.js');
const pkg = require(path.join(PROJECT_ROOT, 'package.json'));

// ---------------------------------------------------------------------------
// 1. Source contract — the fix. Drain-exit, not a teardown-racing process.exit().
// ---------------------------------------------------------------------------

function injectHandlerSource() {
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  const start = src.indexOf("if (cmd === 'inject')");
  const end = src.indexOf("if (cmd === 'enter')", start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'could not locate inject command block in cli.js');
  return src.slice(start, end);
}

// The branch body immediately following a marker line, with `//` line comments
// stripped so the process.exit() check inspects CODE, not explanatory comments
// (which deliberately mention process.exit() to explain why it was removed).
function branchAfter(block, markerSubstring) {
  const at = block.indexOf(markerSubstring);
  assert.ok(at !== -1, `expected inject handler to contain: ${markerSubstring}`);
  return block.slice(at, at + 700).replace(/\/\/[^\n]*/g, '');
}

test('#691 inject not-found path drain-exits (exitCode+return, never a hard process.exit)', () => {
  const block = injectHandlerSource();
  const branch = branchAfter(block, 'was not found on any discovered host');
  assert.match(branch, /process\.exitCode\s*=\s*1/, 'not-found path must set process.exitCode = 1');
  assert.match(branch, /return;/, 'not-found path must return to let the event loop drain');
  assert.doesNotMatch(
    branch,
    /process\.exit\s*\(/,
    'not-found path must NOT hard process.exit() — it races async-handle teardown (libuv src/win/async.c:76 on Windows)'
  );
});

test('#691 inject remote-entitlement-denied path drain-exits (sibling of the not-found path)', () => {
  const block = injectHandlerSource();
  const branch = branchAfter(block, 'Upgrade: ${ent.upgrade_url}');
  assert.match(branch, /process\.exitCode\s*=\s*1/, 'entitlement-denied path must set process.exitCode = 1');
  assert.match(branch, /return;/, 'entitlement-denied path must return to let the event loop drain');
  assert.doesNotMatch(branch, /process\.exit\s*\(/, 'entitlement-denied path must NOT hard process.exit()');
});

// ---------------------------------------------------------------------------
// 2. Behavioral guard — removing process.exit() must not hang. The not-found
//    path still exits, promptly, with code 1 (natural drain, no wedge).
// ---------------------------------------------------------------------------

function startNotFoundDaemon() {
  // Healthy daemon (so no auto-start/restart) that reports ZERO sessions, so
  // resolveSessionTarget can never find the phantom sid → not-found branch.
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '';
    if (req.method === 'GET' && url.startsWith('/api/meta')) {
      res.statusCode = 200;
      res.end(JSON.stringify({ version: pkg.version, capabilities: [] }));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/api/sessions')) {
      res.statusCode = 200;
      res.end('[]');
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', url }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function createTempHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-691-home-'));
  fs.mkdirSync(path.join(homeDir, '.telepty'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(homeDir, '.telepty', 'config.json'),
    JSON.stringify({ authToken: 'mock-token-for-tests' }),
    { mode: 0o600 }
  );
  return homeDir;
}

test('#691 inject <phantom-sid> exits 1 by drain and does not hang', async () => {
  const daemon = await startNotFoundDaemon();
  const homeDir = createTempHome();
  try {
    const result = await new Promise((resolve, reject) => {
      const cli = spawn(process.execPath, ['cli.js', 'inject', 'phantom-sid-that-does-not-exist', 'hello'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          TELEPTY_HOST: '127.0.0.1',
          TELEPTY_PORT: String(daemon.port),
          NO_UPDATE_NOTIFIER: '1',
          TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
          TELEPTY_SKIP_PACKAGE_UPDATE: '1',
          TELEPTY_SKIP_DAEMON_REPAIR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      // If the drain-exit ever regressed into a hang, SIGKILL fires and the test fails.
      const timer = setTimeout(() => { cli.kill('SIGKILL'); reject(new Error(`CLI hung (no drain-exit)\nstderr:\n${stderr}`)); }, 8000);
      cli.stdout.on('data', (c) => { stdout += c; });
      cli.stderr.on('data', (c) => { stderr += c; });
      cli.on('error', (e) => { clearTimeout(timer); reject(e); });
      cli.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 1, `expected exit code 1, got ${result.code}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /was not found on any discovered host/);
  } finally {
    await daemon.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
