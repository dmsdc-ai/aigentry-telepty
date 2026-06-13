'use strict';

// telepty#50 — the daemon must bind 127.0.0.1 by default. A fresh install used to
// listen on 0.0.0.0:3848, exposing the inject/control API to the local network
// without asking. Network exposure is now an explicit opt-in via TELEPTY_BIND
// (preferred) or the legacy HOST override.
//
// SAFETY: integration tests below spawn the daemon on an EPHEMERAL port (PORT=0)
// with a temp HOME and bind only loopback addresses — the live daemon on 3848 is
// never touched and no network-exposed listener is ever opened.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const { resolveBindHost, formatBindHint } = require('../daemon');

// ── pure bind-address policy ────────────────────────────────────────────────────

test('resolveBindHost: default is loopback, NOT 0.0.0.0 (#50 core)', () => {
  assert.equal(resolveBindHost({}), '127.0.0.1');
});

test('resolveBindHost: TELEPTY_BIND=0.0.0.0 opts into network exposure', () => {
  assert.equal(resolveBindHost({ TELEPTY_BIND: '0.0.0.0' }), '0.0.0.0');
});

test('resolveBindHost: legacy HOST override still honored', () => {
  assert.equal(resolveBindHost({ HOST: '10.0.0.5' }), '10.0.0.5');
});

test('resolveBindHost: TELEPTY_BIND takes precedence over legacy HOST', () => {
  assert.equal(resolveBindHost({ TELEPTY_BIND: '127.0.0.1', HOST: '0.0.0.0' }), '127.0.0.1');
});

test('formatBindHint: loopback gets the opt-in hint, exposed bind gets a warning', () => {
  assert.match(formatBindHint('127.0.0.1'), /loopback only/);
  assert.match(formatBindHint('127.0.0.1'), /TELEPTY_BIND=0\.0\.0\.0/);
  assert.match(formatBindHint('0.0.0.0'), /reachable from the network/);
});

// ── integration: the real listen path uses the resolved bind host ──────────────

function startDaemon(extraEnv) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-bind-test-'));
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PORT: '0',
    NO_UPDATE_NOTIFIER: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
    ...extraEnv
  };
  // The default-bind test needs HOST/TELEPTY_BIND genuinely absent, not inherited.
  if (!('HOST' in (extraEnv || {}))) delete env.HOST;
  if (!('TELEPTY_BIND' in (extraEnv || {}))) delete env.TELEPTY_BIND;

  const child = spawn(process.execPath, ['daemon.js'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return child;
}

function waitForBanner(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      reject(new Error(`daemon banner not seen in ${timeoutMs}ms. stdout so far:\n${stdout}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (/listening on https?:\/\/[^\s]+:\d+/.test(stdout) && stdout.includes('bind:')) {
        clearTimeout(timer);
        resolve(stdout);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early (code ${code}). stdout:\n${stdout}`));
    });
  });
}

async function stopDaemon(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
      child.on('exit', () => { clearTimeout(force); resolve(); });
    });
  }
}

test('daemon with no bind env listens on 127.0.0.1 and prints the loopback hint', async () => {
  const child = startDaemon({});
  try {
    const banner = await waitForBanner(child);
    assert.match(banner, /listening on http:\/\/127\.0\.0\.1:\d+/);
    assert.match(banner, /loopback only/);
  } finally {
    await stopDaemon(child);
  }
});

test('TELEPTY_BIND wins over legacy HOST on the real listen path', async () => {
  // Asserts precedence end-to-end without ever opening a network-exposed
  // listener: TELEPTY_BIND pins loopback while HOST tries to open it up.
  const child = startDaemon({ TELEPTY_BIND: '127.0.0.1', HOST: '0.0.0.0' });
  try {
    const banner = await waitForBanner(child);
    assert.match(banner, /listening on http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    await stopDaemon(child);
  }
});
