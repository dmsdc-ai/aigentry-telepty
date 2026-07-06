'use strict';

// #678 — cross-machine `--submit` Enter never applied to the orchestrator target.
//
// Root cause: a WRAPPED session that survives a daemon restart is restored into `sessions[]`
// WITHOUT a render-state machine (the restore loop never called sessionStateManager.register,
// and the reconnecting bridge's idempotent re-register returned early before register()). So
// sessionStateManager.getState(id) === null → the submit gate (submitGate.awaitReplReady)
// returns reason:'no_state' → POST /submit hard-failed 504 (strategy:'none', attempts:0) and
// the CR was never fired. `/inject` text still landed (no gate) → "text lands, Enter not applied".
// A force submit (TELEPTY_SUBMIT_FORCE_DEFAULT=1 on local workers) bypassed the gate → looked fine
// locally, while plain gated cross-machine `--submit` failed.
//
// Three regression locks:
//   (a) restore → register: a wrapped session restored across a daemon restart gets a machine.
//   (b) re-register → register (idempotent): a bridge reconnecting to an already-known session
//       ends up with a live machine; register() creates-when-absent and never clobbers.
//   (c) gate no_state → best-effort DISPATCH (fire CR), not hard-fail — while genuinely-terminal
//       PTY states (dead/error/restarting) still short-circuit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const daemon = require('../daemon');
const { isTerminalGateFailure } = daemon;
const { SessionStateManager } = require('../session-state');

const PROJECT_ROOT = path.join(__dirname, '..');
const TOKEN = 'test-678-token';
const LISTENING_BANNER = /listening on https?:\/\/[^\s]+:(\d+)/;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Boot a real daemon under a private HOME + ephemeral port (PORT=0, read back from the banner).
// Never touches the developer's ~/.telepty or the shared daemon.
async function bootDaemon(homeDir) {
  fs.mkdirSync(path.join(homeDir, '.telepty'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.telepty', 'config.json'),
    JSON.stringify({ authToken: TOKEN }), { mode: 0o600 });

  let stdout = '';
  const child = spawn(process.execPath, ['daemon.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PORT: '0',
           TELEPTY_BIND: '127.0.0.1', NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { stdout += c.toString(); });
  child.stderr.on('data', () => {});

  let port = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited early:\n${stdout}`);
    if (!port) { const m = stdout.match(LISTENING_BANNER); if (m) port = Number(m[1]); }
    if (port) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/sessions`); if (r.ok) break; } catch {}
    }
    await delay(100);
  }
  if (!port) { child.kill('SIGKILL'); throw new Error(`daemon never bound:\n${stdout}`); }

  const req = (pathname, opts = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: opts.method || 'GET',
    headers: { 'x-telepty-token': TOKEN, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      const t = Date.now() + 3000;
      while (child.exitCode === null && Date.now() < t) await delay(50);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await delay(150); // let the port fully release before a same-HOME reboot
  };

  return { req, stop };
}

// (a) + (b) end-to-end: register a wrapped session, restart the daemon (session persists), and
// verify the restored session has a live render-state machine — then a bridge re-register keeps it.
test('#678(a,b) restart-restored wrapped session has a state machine (not no_state), survives re-register', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp678-'));
  let d;
  try {
    // Daemon #1: register a wrapped session (this is the pre-restart state machine).
    d = await bootDaemon(home);
    const reg = await d.req('/api/sessions/register', { method: 'POST',
      body: { session_id: 'alpha', command: 'claude', delivery_type: 'wrapped', cwd: '/tmp' } });
    assert.equal(reg.status, 201);
    const before = await d.req('/api/sessions/alpha/state');
    assert.notEqual(before.body.auto.state, 'unknown', 'machine present before restart');
    await d.stop();

    // Daemon #2 (same HOME): restores 'alpha'. Pre-fix this yielded getState()=null →
    // /state auto = { state:'unknown', detail:'no state machine registered' }.
    d = await bootDaemon(home);
    const restored = await d.req('/api/sessions/alpha/state');
    assert.equal(restored.status, 200);
    assert.notEqual(restored.body.auto.state, 'unknown',
      `restored session must have a state machine, got ${JSON.stringify(restored.body.auto)}`);
    assert.notEqual(restored.body.auto.detail, 'no state machine registered');

    // (b) A bridge reconnecting re-registers the same id (early-return branch) — machine stays live.
    const rereg = await d.req('/api/sessions/register', { method: 'POST',
      body: { session_id: 'alpha', command: 'claude', delivery_type: 'wrapped', cwd: '/tmp' } });
    assert.equal(rereg.body.reregistered, true);
    const after = await d.req('/api/sessions/alpha/state');
    assert.notEqual(after.body.auto.state, 'unknown', 'machine present after bridge re-register');
    assert.notEqual(after.body.auto.detail, 'no state machine registered');
  } finally {
    if (d) await d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// (b) mechanism (hermetic): register() creates a machine when absent AND is idempotent (no clobber).
// This is exactly what the re-register call before the /api/sessions/register early-return relies on
// to recreate a machine for an already-existing, machine-less session.
test('#678(b) SessionStateManager.register creates-when-absent and is idempotent', () => {
  const mgr = new SessionStateManager();
  try {
    assert.equal(mgr.getState('x'), null, 'no machine before register');
    mgr.register('x');
    assert.notEqual(mgr.getState('x'), null, 'register creates a machine when absent');

    // Evolve the machine, then re-register: it must return the SAME machine untouched (idempotent).
    mgr.feed('x', 'busy output\n');
    const evolved = mgr.getState('x');
    mgr.register('x');
    const afterReRegister = mgr.getState('x');
    assert.notEqual(afterReRegister, null, 're-register keeps the machine');
    assert.equal(afterReRegister.since, evolved.since, 're-register does not reset the existing machine');
  } finally {
    // register() starts a per-machine 1s poll setInterval (session-state.js) that is NOT unref'd;
    // leaving it live keeps this file's `node --test` worker process alive after the tests pass,
    // so the whole suite never exits and CI runs to the 6h job timeout (cancelled). destroyAll()
    // clears every machine's timer. (#645 CI-hang root cause.)
    mgr.destroyAll();
  }
});

// (c) gate disposition: no_state / no_state_manager are best-effort DISPATCH (like timeout),
// only session_dead/error/restarting hard-fail (504, never fire the CR).
test('#678(c) isTerminalGateFailure: no_state is best-effort dispatch, dead/error/restarting hard-fail', () => {
  // Non-terminal → dispatch the CR best-effort (not a hard-fail):
  assert.equal(isTerminalGateFailure({ ready: true }), false);
  assert.equal(isTerminalGateFailure({ ready: false, reason: 'timeout' }), false);
  assert.equal(isTerminalGateFailure({ ready: false, reason: 'no_state' }), false, 'THE FIX: no_state dispatches');
  assert.equal(isTerminalGateFailure({ ready: false, reason: 'no_state_manager' }), false);
  assert.equal(isTerminalGateFailure(undefined), false);
  // Terminal → hard-fail 504 (writing a CR to a dead/errored/restarting PTY is pointless):
  assert.equal(isTerminalGateFailure({ ready: false, reason: 'session_dead' }), true);
  assert.equal(isTerminalGateFailure({ ready: false, reason: 'session_error' }), true);
  assert.equal(isTerminalGateFailure({ ready: false, reason: 'session_restarting' }), true);
});
