'use strict';

// #694 — busy-target `--submit` latency. A BUSY (mid-turn) recipient sits in working/thinking,
// neither of which is a READY_STATE, so the render-gate (awaitReplReady) can never pass mid-turn
// and burned the FULL gate timeout (up to 10s) before best-effort dispatch. The busy-dispatch
// fast-path (isBusyDispatchState + awaitInputSettled) dispatches after only the echo+micro-quiet
// settle instead — sub-second — WITHOUT firing into a not-ready render, and WITHOUT touching the
// idle path.
//
// Regression locks (orchestrator-mandated):
//   (a) idle path BYTE-UNCHANGED   — gate_wait_ms=0, consumption=consumed, NO gated_dispatch flag.
//   (b) busy path no full-burn     — gate_wait_ms ≪ gate budget; fast-path dispatched best-effort.
//   (c) grace excludes self-echo   — the transient `working` from our OWN just-injected text
//                                     (duration_ms ≈ 0) does NOT trip the fast-path prematurely.
//
// Method mirrors the proven #678 isolated-daemon harness (private HOME + ephemeral PORT=0) plus a
// fake owner-WS bridge that stays deterministically busy (a persistent thinking-spinner) and echoes
// the injected body (composer echo).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { isBusyDispatchState } = require('../src/submit-gate');

const PROJECT_ROOT = path.join(__dirname, '..');
const TOKEN = 'test-694-token';
const LISTENING_BANNER = /listening on https?:\/\/[^\s]+:(\d+)/;
const BODY = 'FIX694 regression body one two three four five six seven eight nine ten';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// (c) Pure predicate — deterministic, no daemon. Locks the grace guard that
// separates a GENUINE ongoing turn from the transient `working` a target emits
// while echoing our own just-injected text.
// ---------------------------------------------------------------------------
test('#694(c) isBusyDispatchState: busy≥grace true; fresh-echo/idle/waiting/starting false', () => {
  // Genuine ongoing turn — busy state held past the grace floor.
  assert.equal(isBusyDispatchState({ state: 'thinking', duration_ms: 800 }, 250), true);
  assert.equal(isBusyDispatchState({ state: 'working', duration_ms: 251 }, 250), true);

  // Self-echo transient — our just-injected text flips to `working` with duration_ms ≈ 0.
  assert.equal(isBusyDispatchState({ state: 'working', duration_ms: 0 }, 250), false);
  assert.equal(isBusyDispatchState({ state: 'working', duration_ms: 120 }, 250), false);

  // Not a busy state at all — idle/waiting must NEVER take the fast-path (idle-path protection).
  assert.equal(isBusyDispatchState({ state: 'idle', duration_ms: 9999 }, 250), false);
  assert.equal(isBusyDispatchState({ state: 'waiting', duration_ms: 9999 }, 250), false);
  assert.equal(isBusyDispatchState({ state: 'starting', duration_ms: 9999 }, 250), false);

  // Missing/garbage inputs — conservative false.
  assert.equal(isBusyDispatchState(null, 250), false);
  assert.equal(isBusyDispatchState({ state: 'working' }, 250), false); // no duration_ms
  assert.equal(isBusyDispatchState({ state: 'thinking', duration_ms: 300 }, 0), true); // grace 0
});

// ---------------------------------------------------------------------------
// Isolated-daemon harness (copied shape from submit-gate-restore-register-678.test.js).
// ---------------------------------------------------------------------------
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
    if (port) { try { const r = await fetch(`http://127.0.0.1:${port}/api/sessions`); if (r.ok) break; } catch {} }
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
    await delay(150);
  };
  return { req, stop, port };
}

// Fake allow-bridge = PTY owner. A BUSY bridge emits a persistent thinking-spinner (so the render
// never goes quiet-idle → state parks at `thinking` with a stable `_since`) and folds the persistent
// status line into the body echo, mirroring how a real TUI redraws its status line at frame end. An
// IDLE bridge echoes bare text (transient `working`) and, on a CR, simulates the composer clearing +
// a fresh turn starting (idle→working with output past the submit watermark).
function attachOwnerBridge(port, sessionId, bearer) {
  const url = `ws://127.0.0.1:${port}/api/sessions/${sessionId}?owner=1&owner_pid=${process.pid}&token=${TOKEN}`;
  // #815: a session that holds a credential requires the matching bearer on the owner claim, or
  // the daemon refuses it (4003) — a tokenless claim is indistinguishable from a takeover attempt.
  const ws = new WebSocket(url, bearer ? { headers: { 'x-telepty-session-token': bearer } } : undefined);
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let mode = 'idle';
  const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'inject') return;
    if (msg.data === '\r') {
      if (mode === 'idle') {
        try { ws.send(JSON.stringify({ type: 'output', data: '\r\nSure — acknowledged, starting the task.\n' })); } catch {}
      }
      return;
    }
    if (msg.data && msg.data.trim().length > 0) {
      const f = FRAMES[spinnerFrame % FRAMES.length];
      const payload = mode === 'busy' ? `${msg.data}\n${f} Thinking… (esc to interrupt)` : msg.data;
      try { ws.send(JSON.stringify({ type: 'output', data: payload })); } catch {}
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => { try { ws.send(JSON.stringify({ type: 'ready' })); } catch {} resolve(); });
    ws.on('error', reject);
  });
  const startBusy = (intervalMs = 300) => {
    mode = 'busy';
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      const f = FRAMES[spinnerFrame++ % FRAMES.length];
      try { ws.send(JSON.stringify({ type: 'output', data: `\r${f} Thinking… (esc to interrupt)` })); } catch {}
    }, intervalMs);
  };
  const stopBusy = () => { if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; } };
  const goIdle = () => {
    mode = 'idle';
    stopBusy();
    try { ws.send(JSON.stringify({ type: 'output', data: '\x1b]133;B\x07' })); } catch {}
  };
  const close = () => { stopBusy(); try { ws.close(); } catch {} };
  return { ws, ready, startBusy, goIdle, close };
}

// ---------------------------------------------------------------------------
// (a) idle path BYTE-UNCHANGED — the clean render-gate ready branch, untouched by #694.
// ---------------------------------------------------------------------------
test('#694(a) idle target: clean ready path (gate_wait_ms=0, consumed, no gated_dispatch flag)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp694i-'));
  let d;
  try {
    d = await bootDaemon(home);
    const id = 'idle694';
    const reg = await d.req('/api/sessions/register', { method: 'POST',
      body: { session_id: id, command: 'claude', delivery_type: 'wrapped', cwd: '/tmp' } });
    const bridge = attachOwnerBridge(d.port, id, reg.body && reg.body.session_token);
    await bridge.ready;
    bridge.goIdle();
    await delay(300);

    await d.req(`/api/sessions/${id}/inject`, { method: 'POST', body: { prompt: BODY, no_enter: true } });
    await delay(150);
    bridge.goIdle();     // settle the input line back to idle after the echo
    await delay(120);

    const res = await d.req(`/api/sessions/${id}/submit`, { method: 'POST',
      body: { injected_body: BODY, gate_timeout_ms: 10000, prompt_symbol_gate: false } });
    bridge.close();

    assert.equal(res.status, 200, `idle submit must succeed: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.gate_wait_ms, 0, 'idle resolves the ready-gate immediately (byte-unchanged)');
    assert.equal(res.body.consumption, 'consumed', 'idle CR is consumed as a fresh turn');
    assert.equal(res.body.gated_dispatch_after_timeout, undefined,
      'idle takes the CLEAN ready path — NOT the busy/best-effort dispatch branch');
  } finally {
    if (d) await d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) busy path — fast-path dispatches best-effort instead of burning the full gate timeout.
// ---------------------------------------------------------------------------
test('#694(b) busy target: fast-path dispatches without the full-timeout burn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp694b-'));
  let d;
  try {
    d = await bootDaemon(home);
    const id = 'busy694';
    const reg = await d.req('/api/sessions/register', { method: 'POST',
      body: { session_id: id, command: 'claude', delivery_type: 'wrapped', cwd: '/tmp' } });
    const bridge = attachOwnerBridge(d.port, id, reg.body && reg.body.session_token);
    await bridge.ready;
    bridge.startBusy(300);
    await delay(700); // let `thinking` accrue duration_ms ≫ grace (a genuine ongoing turn)

    const st = await d.req(`/api/sessions/${id}/state`);
    assert.ok(['thinking', 'working'].includes(st.body.auto.state),
      `precondition: target is busy, got ${JSON.stringify(st.body.auto)}`);

    await d.req(`/api/sessions/${id}/inject`, { method: 'POST', body: { prompt: BODY, no_enter: true } });
    await delay(150);

    const GATE = 6000; // a full burn here would be ~6s; the fast-path must be ≪ that
    const t0 = Date.now();
    const res = await d.req(`/api/sessions/${id}/submit`, { method: 'POST',
      body: { injected_body: BODY, gate_timeout_ms: GATE, prompt_symbol_gate: false } });
    const gateWait = res.body && res.body.gate_wait_ms;
    bridge.close();

    assert.equal(res.status, 200, `busy submit must still succeed best-effort: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.gated_dispatch_after_timeout, true,
      'busy fast-path dispatches best-effort (not a clean ready)');
    // The core lock: the gate no longer burns the full timeout. The fast-path settle is the
    // awaitInputSettled window (~100–1200ms), never the multi-second gate budget.
    assert.ok(gateWait < 2000,
      `busy gate_wait_ms must be ≪ the ${GATE}ms budget (fast-path settle), got ${gateWait}ms`);
    assert.ok(Date.now() - t0 < GATE,
      'the /submit call returns before the full gate budget would have elapsed');
  } finally {
    if (d) await d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
