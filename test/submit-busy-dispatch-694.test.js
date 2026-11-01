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
const { HARNESS_OBSERVATION_MARGIN_MS } = require('../test-support/daemon-harness');

const PROJECT_ROOT = path.join(__dirname, '..');
const TOKEN = 'test-694-token';
const LISTENING_BANNER = /listening on https?:\/\/[^\s]+:(\d+)/;
const BODY = 'FIX694 regression body one two three four five six seven eight nine ten';
// Task 1215 harness133: this file's own raw /submit requests were UNBOUNDED (no harness request() involved). Each now
// carries an explicit OBSERVATION budget: its own source-derived product upper bound plus the one named harness margin.
// This is not a product deadline and not the first-CR/gate performance assertions below. Gated path (session-actions.js
// submit route): gate (or the busy settle 1200, which is smaller) + gatedTerminalSubmit settle 1200 + verify
// + retries x (retry delay + 1200 + verify) + classifyInjectConsumption 1200, with the product defaults verify 1500,
// retries 1 and delay 500 when the body omits them (delivery-runtime.js parseSubmitRetryOptions).
// gate 10000 -> 17100 (+ margin 19100); gate 6000 -> 13100 (+ margin 15100); both fit the 30000 ms harness maximum.
const submitUpperBoundMs = ({ gate, verify = 1500, retries = 1, retryDelay = 500 }) =>
  gate + 1200 + verify + retries * (retryDelay + 1200 + verify) + 1200;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Task 1215 windows127: waits for a test-observed EVENT (bounded); it asserts nothing about time.
async function until(check, maxMs) { const end = Date.now() + maxMs; while (!check() && Date.now() < end) await delay(20); return check(); }

// Task 1215 windows127 (failure-only diagnostics): fixed-shape /submit evidence for assertion messages. Reasons pass only
// as product reason tokens (allowlist /^[a-z][a-z0-9_]{0,63}$/, else 'other'). Never a body, token, URL, message or stack.
const REASON_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
function submitEvidence(res, t0, doneAt, crTimes) {
  const b = (res && res.body) || {};
  const reason = (v) => (v == null ? null : (typeof v === 'string' && REASON_TOKEN.test(v) ? v : 'other'));
  const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return JSON.stringify({ status: int(res && res.status), elapsed_ms: int(doneAt - t0),
    time_to_headers_ms: int(res && res.headers_at - t0), first_cr_ms: crTimes.length ? int(crTimes[0] - t0) : null,
    cr_count: crTimes.length, gate_wait_ms: int(b.gate_wait_ms), attempts: int(b.attempts),
    gated_dispatch_after_timeout: b.gated_dispatch_after_timeout === true, verify_reason: reason(b.verify && b.verify.reason),
    confirm_reason: reason(b.confirm && b.confirm.reason), consumption_reason: reason(b.consumption_reason) });
}

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

  // Task 1215 harness133: an optional `opts.timeoutMs` bounds one request (headers AND body). On expiry it rejects with
  // code HARNESS_REQUEST_TIMEOUT (method and route only). The timer is cleared on every path. Without it: unchanged.
  const req = (pathname, opts = {}) => {
    const controller = opts.timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
    const expired = () => Object.assign(new Error(`submit-busy-dispatch-694 ${opts.method || 'GET'} ${pathname.split('?')[0]}: `
      + `no complete response within the ${opts.timeoutMs}ms observation budget (HARNESS_REQUEST_TIMEOUT)`), { code: 'HARNESS_REQUEST_TIMEOUT' });
    return fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: opts.method || 'GET',
      headers: { 'x-telepty-token': TOKEN, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      ...(controller ? { signal: controller.signal } : {}),
    }).then(async (r) => {
      const headersAt = Date.now();
      const body = await r.json().catch(() => null);
      if (controller && controller.signal.aborted) throw expired(); // a body cut by the budget is not a null body
      return { status: r.status, headers_at: headersAt, body };
    }, (error) => { throw controller && controller.signal.aborted ? expired() : error; })
      .finally(() => clearTimeout(timer));
  };

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
  // Task 1215 windows127: what the owner actually received — the arrival time of every CR, and how many inject
  // writes carried BODY. retainFirstCr (holdInput): the first CR leaves the body in place and stays silent; a
  // later CR clears the composer line and redraws a fresh busy frame without the body.
  const crTimes = [];
  let bodyInputs = 0;
  let retainFirstCr = false;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'inject') return;
    if (msg.data === '\r') {
      crTimes.push(Date.now());
      if (retainFirstCr) {
        if (crTimes.length > 1) {
          const f = FRAMES[spinnerFrame++ % FRAMES.length];
          try { ws.send(JSON.stringify({ type: 'output', data: `\r\x1b[2K${f} Thinking… (esc to interrupt)` })); } catch {}
        }
        return;
      }
      if (mode === 'idle') {
        try { ws.send(JSON.stringify({ type: 'output', data: '\r\nSure — acknowledged, starting the task.\n' })); } catch {}
      }
      return;
    }
    if (msg.data && msg.data.trim().length > 0) {
      if (msg.data.includes(BODY)) bodyInputs++;
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
  // Stops the periodic spinner BEFORE /submit (mode stays busy, so the body echo still ends on the spinner line), so no
  // post-CR output can arrive by chance; then the first CR is retained as above.
  const holdInput = () => { retainFirstCr = true; stopBusy(); };
  const close = () => { stopBusy(); try { ws.close(); } catch {} };
  return { ws, ready, startBusy, goIdle, close, holdInput, crTimes, bodyInputs: () => bodyInputs };
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
      timeoutMs: submitUpperBoundMs({ gate: 10000 }) + HARNESS_OBSERVATION_MARGIN_MS,
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

    // #60 §3.8: `auto` (the internal FSM name) became `activity_observation`, keyed by the
    // measured cause. The busy precondition is unchanged in substance — it just names the two
    // observations a busy session produces instead of the two internal states they map from:
    // `working` → output_observed, `thinking` → busy_indicator_pattern_observed.
    const st = await d.req(`/api/sessions/${id}/state`);
    const busyKinds = ['output_observed', 'busy_indicator_pattern_observed'];
    assert.ok(st.body.activity_observation && busyKinds.includes(st.body.activity_observation.kind),
      `precondition: target is busy, got ${JSON.stringify(st.body.activity_observation)}`);

    await d.req(`/api/sessions/${id}/inject`, { method: 'POST', body: { prompt: BODY, no_enter: true } });
    await delay(150);

    const GATE = 6000; // a full burn here would be ~6s; the fast-path must be ≪ that
    const t0 = Date.now();
    const res = await d.req(`/api/sessions/${id}/submit`, { method: 'POST',
      timeoutMs: submitUpperBoundMs({ gate: GATE }) + HARNESS_OBSERVATION_MARGIN_MS,
      body: { injected_body: BODY, gate_timeout_ms: GATE, prompt_symbol_gate: false } });
    const doneAt = Date.now();
    const gateWait = res.body && res.body.gate_wait_ms;
    await until(() => bridge.crTimes.length > 0, 2000); // the CR the daemon wrote before answering reaches the owner
    bridge.close();
    const evidence = submitEvidence(res, t0, doneAt, bridge.crTimes);

    assert.equal(res.status, 200, `busy submit must still succeed best-effort: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.gated_dispatch_after_timeout, true,
      `busy fast-path dispatches best-effort (not a clean ready) ${evidence}`);
    // The core lock: the gate no longer burns the full timeout. The fast-path settle is the
    // awaitInputSettled window (~100–1200ms), never the multi-second gate budget.
    assert.ok(gateWait < 2000,
      `busy gate_wait_ms must be ≪ the ${GATE}ms budget (fast-path settle), got ${gateWait}ms ${evidence}`);
    // Task 1215 windows127: the no-full-gate-burn property is the PRE-DISPATCH phase. Without the fast path, awaitReplReady
    // spends the whole gate budget before the first CR reaches the owner. The whole /submit round trip also contains the
    // bounded post-CR confirm/retry/consumption steps (about 8.3 s with every step at its source bound, see #694(b2)), so
    // it is not a gate measure; it is recorded only as evidence.
    assert.ok(bridge.crTimes.length > 0 && bridge.crTimes[0] - t0 < GATE,
      `the first CR is dispatched before the full ${GATE}ms gate budget would have elapsed ${evidence}`);
  } finally {
    if (d) await d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b2) Task 1215 windows127 — busy fast path, then one bounded confirm retry. This deterministically drives the
// allowed path that the old whole-round-trip assertion conflated with a gate burn. It uses the same fake bridge, and
// product and fixture deadlines are unchanged.
//   - The periodic spinner is stopped BEFORE /submit (holdInput). A THINKING target stays thinking while quiet (#545),
//     so the fast path is still taken.
//   - The owner retains the body after the first CR and stays silent. With no post-CR output, the state is not
//     accepted and the body stays visible, so confirm runs its whole 1500 ms window and returns body_still_visible
//     (retryable).
//   - After the 500 ms retry delay the retry CR is answered with a busy redraw that clears the composer line. Confirm
//     then accepts on state evidence; the ring is not a screen, so this is not body_consumed.
// Elapsed and gate wait are measured. The source-guaranteed non-gate time of this path is >= 1500 + 500 ms. Whether
// elapsed exceeds the old 6000 ms bound is NOT asserted: with every step at its source bound the path reaches about
// 8.3 s, but the existing seams cannot force those bounds deterministically.
// ---------------------------------------------------------------------------
test('#694(b2) busy target: a bounded confirm retry after body_still_visible is not a gate burn', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp694r-'));
  let d;
  try {
    d = await bootDaemon(home);
    const id = 'busyretry694';
    const reg = await d.req('/api/sessions/register', { method: 'POST',
      body: { session_id: id, command: 'claude', delivery_type: 'wrapped', cwd: '/tmp' } });
    const bridge = attachOwnerBridge(d.port, id, reg.body && reg.body.session_token);
    await bridge.ready;
    bridge.startBusy(300);
    await delay(700);
    bridge.holdInput();

    const st = await d.req(`/api/sessions/${id}/state`);
    assert.equal(st.body.activity_observation && st.body.activity_observation.kind, 'busy_indicator_pattern_observed',
      `precondition: target is THINKING (stays busy while quiet, #545), got ${JSON.stringify(st.body.activity_observation)}`);

    await d.req(`/api/sessions/${id}/inject`, { method: 'POST', body: { prompt: BODY, no_enter: true } });
    await delay(150);

    const GATE = 6000;
    const t0 = Date.now();
    const res = await d.req(`/api/sessions/${id}/submit`, { method: 'POST',
      timeoutMs: submitUpperBoundMs({ gate: GATE }) + HARNESS_OBSERVATION_MARGIN_MS,
      body: { injected_body: BODY, gate_timeout_ms: GATE, prompt_symbol_gate: false } });
    const doneAt = Date.now();
    const gateWait = res.body && res.body.gate_wait_ms;
    await until(() => bridge.crTimes.length >= 2, 2000);
    const crTimes = bridge.crTimes.slice();
    const bodyInputs = bridge.bodyInputs();
    bridge.close();
    const evidence = submitEvidence(res, t0, doneAt, crTimes);

    assert.equal(res.status, 200, `retried busy submit succeeds truthfully ${evidence}`);
    assert.equal(res.body.gated_dispatch_after_timeout, true, `busy fast-path dispatched best-effort ${evidence}`);
    assert.ok(gateWait < 2000, `busy gate_wait_ms stays the fast-path settle ${evidence}`);
    assert.equal(res.body.attempts, 2, `exactly one bounded confirm retry ${evidence}`);
    assert.equal(res.body.verify && res.body.verify.consumed, true, `the retry CR was confirmed ${evidence}`);
    assert.equal(crTimes.length, 2, `the owner received exactly the two CRs the daemon counted ${evidence}`);
    assert.equal(bodyInputs, 1, `the body was written once and never re-injected by the retry ${evidence}`);
    assert.ok(crTimes[0] - t0 < GATE, `the first CR is dispatched before the full ${GATE}ms gate budget would have elapsed ${evidence}`);
    assert.ok(doneAt - t0 - gateWait >= 1500 + 500,
      `the round trip holds >= the confirm window + retry delay of non-gate time ${evidence}`);
  } finally {
    if (d) await d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
