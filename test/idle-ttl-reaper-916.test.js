'use strict';

// #916 block 4 — the idle-TTL reaper, armed for the first time, WARN-ONLY by default.
//
// `setInterval(runIdleTtlSweep)` was guarded on `require.main === module` alone, false in
// production. So this sweep has never run on a real daemon, which means `idle_ttl` is a
// FEATURE THAT HAS NEVER WORKED: an operator who set `idle_ttl_default`, or PATCHed a session's
// `idle_ttl`, got no reaping and no error. Arming it makes that config live for the first time.
//
// Measured on the operator host before this change (2026-08-16): `idle_ttl_default` resolves to
// "off" (`idleTtlDefaultMs: null`) and none of the five live sessions carries a per-session TTL,
// so `selectIdleTtlVictims` returns EMPTY and enforcing would reap nothing today. The danger is
// not today's session list — it is that the next operator to set a TTL gets a killer instead of
// the no-op every previous one got. Hence: arm in `warn`, and let the owner read the log first.
//
// Modes: off (not armed) · warn (default — computes victims, logs, kills nothing) · enforce.
//
// Hermetic: temp HOME + PORT=0 before the require (the #829 rule — a bare `require('../daemon')`
// against the real HOME restores and supervises the operator's LIVE sessions).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty916r-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemon = require('../daemon');
const { runIdleTtlSweep } = daemon;

const projectRoot = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(projectRoot, 'daemon.js');
const HOUR_MS = 3600 * 1000;

// Two sessions well past a 1-hour TTL, and one comfortably inside it.
function fixture(nowMs) {
  const iso = (msAgo) => new Date(nowMs - msAgo).toISOString();
  return {
    'idle-old-1': { id: 'idle-old-1', lastActivityAt: iso(6 * HOUR_MS) },
    'idle-old-2': { id: 'idle-old-2', lastActivityAt: iso(3 * HOUR_MS) },
    'busy-now': { id: 'busy-now', lastActivityAt: iso(30 * 1000) },
  };
}

const CONFIG_TTL_1H = { idleTtlDefaultMs: HOUR_MS };
const NOW = 1_700_000_000_000;

test('#916.4 WARN-ONLY (default): names every victim and kills none', async () => {
  const killed = [];
  const logs = [];
  const broadcasts = [];

  const result = await runIdleTtlSweep(NOW, {
    mode: 'warn',
    sessions: fixture(NOW),
    config: CONFIG_TTL_1H,
    teardownSessionById: (id) => { killed.push(id); },
    broadcastSessionEvent: (type, id) => { broadcasts.push({ type, id }); },
    log: (m) => logs.push(m),
  });

  assert.deepEqual(result.victims.sort(), ['idle-old-1', 'idle-old-2'], 'both stale sessions are identified');
  assert.deepEqual(killed, [], 'WARN-ONLY must not tear down anything');
  assert.deepEqual(result.killed, []);
  assert.equal(logs.filter((m) => /WARN-ONLY: would auto-kill/.test(m)).length, 2, 'each victim is named in the log');
  assert.match(logs.join('\n'), /TELEPTY_IDLE_TTL_MODE=enforce/, 'the log says how to act on it');
  assert.deepEqual(
    broadcasts,
    [],
    'no idle_ttl_auto_kill event may be broadcast for a session that is still running — that '
    + 'event asserts a kill happened'
  );
});

test('#916.4 enforce: reaps exactly the victims, leaves the busy session alone', async () => {
  const killed = [];
  const broadcasts = [];

  const result = await runIdleTtlSweep(NOW, {
    mode: 'enforce',
    sessions: fixture(NOW),
    config: CONFIG_TTL_1H,
    teardownSessionById: (id) => { killed.push(id); },
    broadcastSessionEvent: (type, id, _s, payload) => { broadcasts.push({ type, id, action: payload.extra.action }); },
    log: () => {},
  });

  assert.deepEqual(killed.sort(), ['idle-old-1', 'idle-old-2'], 'enforce is the pre-#916 behaviour');
  assert.deepEqual(result.killed.sort(), ['idle-old-1', 'idle-old-2']);
  assert.ok(!killed.includes('busy-now'), 'a session inside its TTL is never a victim');
  assert.deepEqual(broadcasts.map((b) => b.action), ['idle_ttl_auto_kill', 'idle_ttl_auto_kill']);
});

test('#916.4: no TTL configured ⇒ no victims in any mode (this host, today)', async () => {
  // The measured state of the operator host: idle_ttl_default "off" ⇒ idleTtlDefaultMs null, and
  // no per-session idle_ttl. `effectiveIdleTtlMs` returns null, so nothing is ever selected.
  for (const mode of ['warn', 'enforce']) {
    const killed = [];
    const result = await runIdleTtlSweep(NOW, {
      mode,
      sessions: fixture(NOW),
      config: { idleTtlDefaultMs: null },
      teardownSessionById: (id) => { killed.push(id); },
      broadcastSessionEvent: () => {},
      log: () => {},
    });
    assert.deepEqual(result.victims, [], `mode=${mode}: an unset TTL selects nobody`);
    assert.deepEqual(killed, [], `mode=${mode}: and kills nobody`);
  }
});

test('#916.4: a per-session TTL overrides the default', async () => {
  const killed = [];
  const sessions = fixture(NOW);
  sessions['busy-now'].idleTtlMs = 10 * 1000;   // 30s idle > 10s ttl ⇒ now a victim
  sessions['idle-old-1'].idleTtlMs = null;      // explicitly exempt

  const result = await runIdleTtlSweep(NOW, {
    mode: 'enforce',
    sessions,
    config: CONFIG_TTL_1H,
    teardownSessionById: (id) => { killed.push(id); },
    broadcastSessionEvent: () => {},
    log: () => {},
  });

  assert.ok(killed.includes('busy-now'), 'a short per-session TTL makes an active session a victim');
  assert.ok(!killed.includes('idle-old-1'), 'a null per-session TTL exempts a session from the default');
  assert.deepEqual(result.mode, 'enforce');
});

// ── The launch-path RED: was the sweep armed at all? ────────────────────────────────────
function bootDaemonChild(homeDir, env = {}) {
  const child = spawn(process.execPath, ['-e',
    `process.env.AIGENTRY_TELEPTY_DAEMON_MAIN='1'; require(${JSON.stringify(DAEMON_JS)});`], {
    cwd: projectRoot,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PORT: '0', TELEPTY_NO_TAILNET_AUTO: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.out = '';
  child.stdout.on('data', (c) => { child.out += c.toString(); });
  child.stderr.on('data', () => {});
  child.ready = new Promise((resolve) => {
    child.stdout.on('data', () => { if (/listening on http:\/\//.test(child.out)) resolve(true); });
    setTimeout(() => resolve(false), 15000);
  });
  return child;
}

test('#916.4: the sweep is armed on the production launch path, and says its mode', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty916r-boot-'));
  const child = bootDaemonChild(homeDir);
  try {
    assert.equal(await child.ready, true, 'daemon must reach its LISTEN banner');
    assert.match(
      child.out,
      /\[REAPER\] idle-TTL sweep armed \(mode=warn/,
      'the sweep must arm on the launch path production actually uses, and state its mode'
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('#916.4: TELEPTY_IDLE_TTL_MODE=off does not arm the sweep at all', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty916r-off-'));
  const child = bootDaemonChild(homeDir, { TELEPTY_IDLE_TTL_MODE: 'off' });
  try {
    assert.equal(await child.ready, true);
    assert.doesNotMatch(child.out, /idle-TTL sweep armed/, 'off means no timer, not a quiet timer');
  } finally {
    child.kill('SIGKILL');
  }
});
