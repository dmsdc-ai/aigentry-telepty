'use strict';

// #136 (RB1) F1 regression source, task 1215: readiness from the RENDERED frame of an actual
// differential repaint, measured independently of stall/timeout visibility. Written BEFORE the
// production fix; see SPEC.md §5.1.
//
// Real seams: createAllowSecurityContext (src/cli/security-actions.js:290) and its relay /
// observePromptReady / tick, the real FileMailbox, the real prompt registry, and the REAL
// SessionScreen + @xterm/headless 6.0.0 (src/vt/session-screen.js). "VT unavailable" uses the
// existing seam __setTerminalCtorForTest(null) (session-screen.js:184). Fakes (declared): clock +
// timers, child.write recorder, owner-WS send recorder, 80x24 stdout. cli.js onReady
// (cli.js:3412-3421) and the inject-frame handler (cli.js:3160-3196) are mirrored as callers.
//
// No proposed export (detectFrame, probeFrameReady, ...) is imported. A fix must make frame
// readiness effective through the context's existing per-chunk observePromptReady(data) feed and
// its existing 500 ms tick (SPEC §5.1.2 seam constraint).
//
// "PRECONDITION:" assertions validate fixtures/setup (failure = INVALID, not RED).


const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const security = require('../src/cli/security-actions');
const registry = require('../src/prompt-symbol-registry');
const { FileMailbox } = require('../src/mailbox/index');
const flushFilter = require('../src/mailbox/bridge-flush-filter');
const { getTerminalSize } = require('../interactive-terminal');
const vt = require('../src/vt/session-screen');

const FIXTURES = path.join(__dirname, 'fixtures', 'bridge-136');
const OWNER_GENERATION = 'owner-gen-1215-current';
const FORBIDDEN_STAGES = ['consumed', 'turn_accepted', 'completed'];

function loadStream(name) {
  const recipe = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  assert.match(recipe.provenance, /^synthetic:/, `PRECONDITION: ${name} provenance must be synthetic`);
  let stream = recipe.preamble.join('');
  for (let k = 0; k < recipe.repeat; k++) stream += recipe.cycle[k % recipe.cycle.length];
  return stream + recipe.epilogue.join('');
}

// Deterministic fake clock. It starts 3 h in the past on a whole second, because FileMailbox
// skips records whose created_at is later than the REAL Date.now() (mailbox/index.js:115).
function createClock() {
  const start = Math.floor((Date.now() - 3 * 3600 * 1000) / 1000) * 1000;
  let now = start;
  let seq = 0;
  let fired = 0;
  const timers = new Map();
  const calls = { timeouts: [], intervals: [] };
  return {
    start,
    calls,
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq; const d = Math.max(0, Number(ms) || 0);
      calls.timeouts.push(d); timers.set(id, { fn, at: now + d, every: 0 }); return id;
    },
    clearTimeout(id) { if (id != null) timers.delete(id); },
    setInterval(fn, ms) {
      const id = ++seq; const d = Math.max(1, Number(ms) || 1);
      calls.intervals.push(d); timers.set(id, { fn, at: now + d, every: d }); return id;
    },
    clearInterval(id) { if (id != null) timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let id = null; let t = null;
        for (const [k, v] of timers) if (v.at <= end && (!t || v.at < t.at)) { id = k; t = v; }
        if (!t) break;
        assert.ok(++fired <= 60000, 'PRECONDITION: fake timer budget exceeded');
        now = Math.max(now, t.at);
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
        await new Promise(resolve => setImmediate(resolve));
      }
      now = end;
    },
  };
}

// Real-time settle so the real @xterm/headless parser (it schedules with real timers) can apply
// fed bytes before the next fake tick. Bounded: 10 x 20 ms.
async function settleVt() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 20));
}

function createBridge(t, { sid }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-136-'));
  const bridgeRoot = path.join(root, 'bridge');
  const clock = createClock();
  const writes = [];
  const sends = [];
  const stdout = { columns: 80, rows: 24, isTTY: true, write() { return true; } };
  const child = {
    pid: null,
    write(data) { writes.push(data); },
    resize() {},
    kill() { throw new Error('PRECONDITION: native kill is not part of this fixture'); },
  };
  const shared = {
    sessionId: sid, command: 'codex', cmdArgs: [], sshPlan: null, child, handoffPending: null, idleTtl: null,
    detectedBackend: 'fixture', terminalProgram: 'fixture', terminalType: 'xterm-256color',
    DAEMON_URL: 'http://127.0.0.1:9', fetchWithAuth: () => Promise.reject(new Error('no network in fixture')),
    sessionCwd: root, sessionEnv: {}, bridgeTarget: sid, bridgeMsgSeq: 0, bridgePendingCount: 0,
    promptReady: false, lastUserInputTime: 0, IDLE_THRESHOLD: 2000,
    knownAiCli: registry.isKnownAiCli('codex'), outputTail: '', readyRegistry: registry, readyQualification: null,
    promptPattern: /[❯>$#%]\s*$/, firstReadyObserved: false, queueFlushTimer: null, idleCheckTimer: null,
    reconnectTimer: null, heartbeatTimer: null,
    filterBridgeBatch: flushFilter.filterBridgeBatch, bridgeInjectTtlSecs: flushFilter.bridgeInjectTtlSecs,
    interactionBinding: { sid, session_epoch: 'epoch-1215', credential_generation: 1,
      owner_generation: OWNER_GENERATION, input_generation: 0, geometry_generation: 0 },
    wsReady: true,
    daemonWs: { readyState: 1, send(raw) { sends.push({ raw: String(raw), at: clock.now() }); }, close() {} },
    getTerminalSize, allowSessionClosed: false, cleanupTerminal() {}, currentOwnerToken: 'synthetic-owner-token',
    allowSignalHandlers: new Map(), FileMailbox, path, os,
  };
  assert.equal(shared.knownAiCli, true, 'PRECONDITION: codex is a known AI CLI');
  const allow = security.createAllowSecurityContext(shared, {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    getStdout: () => stdout, removeSignalHandler() {},
    spawnPty() { throw new Error('PRECONDITION: native spawn is not part of this fixture'); },
    bridgeRoot,
  });
  shared.bridgeMailbox = allow.createBridgeMailbox();

  // Mirror of cli.js:3412-3421 (onReady). pendingReadyFields() is cooperative-handoff only.
  let readyNotified = false;
  function onReady() {
    if (shared.handoffPending) return;
    shared.promptReady = true;
    shared.firstReadyObserved = true;
    if (!shared.sshPlan) allow.flushBridgeMailbox();
    if (!readyNotified && shared.wsReady && shared.daemonWs.readyState === 1) {
      readyNotified = true;
      shared.daemonWs.send(JSON.stringify({ type: 'ready', ...(shared.readyQualification || {}) }));
    }
  }
  // cli.js:3385-3422 wires child output through the REAL relay.
  const relay = allow.createOutputRelay({
    onInteraction: () => { shared.interactionBinding.input_generation++; },
    onBytes: () => {}, rewrite: data => data, write: () => {}, sendOutput: () => {},
    observeReady: data => allow.observePromptReady(data), onReady,
  });
  function feed(stream, chunk = 1024) {
    for (let i = 0; i < stream.length; i += chunk) relay(stream.slice(i, i + chunk));
  }
  // Mirror of cli.js:3160-3196 (owner-WS 'inject' frame). The optional frame fields are
  // forwarded as the proposed second argument (design F3); the current code ignores it.
  function injectFrame(frame) {
    allow.invalidateBridgeInteraction('automated_input');
    const rawData = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '');
    const meta = {};
    for (const key of ['daemon_msg_id', 'inject_id', 'part', 'pair', 'owner_generation']) {
      if (frame[key] !== undefined) meta[key] = frame[key];
    }
    for (const chunk of [rawData]) {
      if (!chunk) continue;
      const isCr = chunk === '\r';
      if (isCr && shared.bridgePendingCount > 0) {
        allow.enqueueBridgeMessage(chunk, meta);
        if (allow.isIdle()) {
          if (shared.queueFlushTimer) { clock.clearTimeout(shared.queueFlushTimer); shared.queueFlushTimer = null; }
          allow.flushBridgeMailbox();
        } else {
          allow.scheduleIdleFlush();
        }
      } else if (isCr) {
        shared.child.write(chunk);
      } else if (allow.isIdle()) {
        shared.child.write(chunk);
        shared.promptReady = false;
      } else {
        allow.enqueueBridgeMessage(chunk, meta);
        allow.scheduleIdleFlush();
      }
    }
    if (rawData && rawData !== '\r') readyNotified = false;
  }
  let injectSeq = 0;
  function daemonInject(text) {
    injectSeq++;
    const injectId = `00000000-0000-4000-8000-${String(injectSeq).padStart(12, '0')}`;
    const body = { type: 'inject', data: text, daemon_msg_id: `dm-${injectSeq}-body`, inject_id: injectId,
      part: 'body', owner_generation: OWNER_GENERATION };
    const submit = { type: 'inject', data: '\r', daemon_msg_id: `dm-${injectSeq}-submit`, inject_id: injectId,
      part: 'submit', pair: body.daemon_msg_id, owner_generation: OWNER_GENERATION };
    return { injectId, body, submit };
  }
  function framesOf(type) {
    const out = [];
    for (const entry of sends) {
      let msg; try { msg = JSON.parse(entry.raw); } catch { continue; }
      if (msg && msg.type === type) out.push({ ...entry, msg });
    }
    return out;
  }
  function receipts(injectId, stage) {
    return framesOf('bridge_receipt').filter(r => r.msg.inject_id === injectId && (!stage || r.msg.stage === stage));
  }
  function receiptViolations(payloads) {
    const bad = [];
    for (const { raw, msg } of framesOf('bridge_receipt')) {
      if (Buffer.byteLength(raw, 'utf8') > 512) bad.push(`oversize:${msg.stage}`);
      if (Object.hasOwn(msg, 'payload') || Object.hasOwn(msg, 'data')) bad.push(`payload_key:${msg.stage}`);
      for (const p of payloads) if (raw.includes(p)) bad.push(`payload_text:${msg.stage}`);
      if (msg.owner_generation !== OWNER_GENERATION) bad.push(`owner_generation:${msg.stage}`);
      if (FORBIDDEN_STAGES.includes(msg.stage)) bad.push(`forbidden_stage:${msg.stage}`);
    }
    return bad;
  }
  function entries() { return shared.bridgeMailbox.peek(sid, { includePayload: true }); }
  function stateOfPayload(payload) {
    const hit = entries().filter(e => e.payload === payload);
    return hit.length ? hit[hit.length - 1].state : null;
  }
  function deadLetters() { return shared.bridgeMailbox.peekDeadLetter(sid); }
  function stateHistory() {
    const file = path.join(fs.realpathSync(bridgeRoot), sid, 'state.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  t.after(() => {
    try { allow.closeAllowSession({ destroySession: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { shared, allow, clock, writes, sends, feed, injectFrame, daemonInject, framesOf, receipts,
    receiptViolations, entries, stateOfPayload, deadLetters, stateHistory, bridgeRoot };
}


const IDLE = loadStream('codex-differential-idle.json');
const BUSY = loadStream('codex-differential-busy.json');
const MODAL = loadStream('codex-differential-modal.json');
const LOADING = loadStream('codex-loading-no-composer.json');
const BUSY_MARKER = /\besc to interrupt\b|\bstarting mcp servers?\b|\bbooting mcp server\b/i;

function repaintCycles(name, n) {
  const recipe = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  let out = '';
  for (let k = 0; k < n; k++) out += recipe.cycle[k % recipe.cycle.length];
  return out;
}

function tailVerdicts(stream, chunk = 1024) {
  // Exactly what observePromptReady computes per chunk (security-actions.js:408-409).
  let tail = '';
  const found = [];
  for (let i = 0; i < stream.length; i += chunk) {
    tail = (tail + stream.slice(i, i + chunk)).slice(-20000);
    found.push(registry.detectOutput('codex', tail).found);
  }
  return found;
}

// The real VT grid for a stream, at the same 80x24 local-PTY geometry the bridge would use.
async function renderedFrame(stream) {
  const screen = new vt.SessionScreen({ sessionId: 'fixture-136', cause: 'stream_origin', localSource: true,
    geometrySource: 'local_pty', cols: 80, rows: 24 });
  const keepAlive = setInterval(() => {}, 50);
  try {
    screen.noteOutput(stream);
    const deadline = Date.now() + 5000;
    let frame = await screen.readFrame({ drainWaitMs: 250 });
    while (frame.lag_units > 0 && Date.now() < deadline) frame = await screen.readFrame({ drainWaitMs: 250 });
    return frame;
  } finally {
    clearInterval(keepAlive);
    screen.dispose();
  }
}

test('#136 F1 fixture control: raw tail never matches; the real rendered frame shows composer / busy / modal / loading', { timeout: 30000 }, async () => {
  const summary = {};
  for (const [name, stream] of [['idle', IDLE], ['busy', BUSY], ['modal', MODAL], ['loading', LOADING]]) {
    const frame = await renderedFrame(stream);
    const rows = frame.rows_text;
    summary[name] = {
      differential: !/[\r\n]/.test(stream) && !/OpenAI Codex \(v/.test(stream),
      tailEverMatches: tailVerdicts(stream).some(Boolean),
      basis: frame.observation_basis,
      frameDetect: registry.ENTRIES.codex.detect(rows.join('\n')).found,
      busyInBottomSixRows: BUSY_MARKER.test(rows.slice(-6).join('\n')),
    };
  }
  assert.ok(IDLE.length > 20000 && BUSY.length > 20000 && MODAL.length > 20000, 'PRECONDITION: differential streams exceed the 20k tail');
  assert.deepEqual(summary, {
    idle: { differential: true, tailEverMatches: false, basis: 'vt_grid', frameDetect: true, busyInBottomSixRows: false },
    busy: { differential: true, tailEverMatches: false, basis: 'vt_grid', frameDetect: true, busyInBottomSixRows: true },
    modal: { differential: true, tailEverMatches: false, basis: 'vt_grid', frameDetect: false, busyInBottomSixRows: false },
    loading: { differential: true, tailEverMatches: false, basis: 'vt_grid', frameDetect: false, busyInBottomSixRows: false },
  }, 'PRECONDITION: synthetic fixture mechanism (real registry + real VT) must hold');
});

test('#136 F1: a rendered idle composer drains body+CR exactly once within 3 s of the repaint, before any stall threshold', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-vt-ready' });
  const { body, submit } = b.daemonInject('VT-READY-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(3000); // nothing rendered yet
  const beforeRepaint = b.writes.slice();
  b.feed(IDLE);
  await settleVt();
  await b.clock.advance(3000);
  const afterRepaint = b.writes.slice();
  b.feed(repaintCycles('codex-differential-idle.json', 6));
  await settleVt();
  await b.clock.advance(5000);
  const q = b.shared.readyQualification || {};
  assert.deepEqual({
    beforeRepaint,
    afterRepaint,
    afterFurtherRepaint: b.writes,
    readyKind: q.ready_kind || null,
    vtFrameDetector: typeof q.detector === 'string' && q.detector.startsWith('vt_frame'),
  }, {
    beforeRepaint: [],
    afterRepaint: ['VT-READY-BODY', '\r'],
    afterFurtherRepaint: ['VT-READY-BODY', '\r'],
    readyKind: 'composer_surface_observed',
    vtFrameDetector: true,
  });
});

test('#136 guard: busy frame (composer visible + esc to interrupt) is never written to', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-vt-busy-guard' });
  b.feed(BUSY);
  await settleVt();
  const { body, submit } = b.daemonInject('VT-BUSY-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(20000);
  assert.deepEqual(b.writes, []);
});

test('#136 F2: busy frame is reported withheld with reason busy_indicator', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-vt-busy-reason' });
  b.feed(BUSY);
  await settleVt();
  const { injectId, body } = b.daemonInject('VT-BUSY-REASON');
  b.injectFrame(body);
  await b.clock.advance(16000);
  assert.deepEqual({
    writes: b.writes,
    withheld: b.receipts(injectId, 'withheld').map(r => ({ part: r.msg.part, reason: r.msg.reason })),
    violations: b.receiptViolations(['VT-BUSY-REASON']),
  }, { writes: [], withheld: [{ part: 'body', reason: 'busy_indicator' }], violations: [] });
});

test('#136 guard: modal frame (directory trust) is never written to', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-vt-modal-guard' });
  b.feed(MODAL);
  await settleVt();
  const { body, submit } = b.daemonInject('VT-MODAL-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(20000);
  assert.deepEqual(b.writes, []);
});

test('#136 F2: modal frame is reported withheld with reason modal_ui', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-vt-modal-reason' });
  b.feed(MODAL);
  await settleVt();
  const { injectId, body } = b.daemonInject('VT-MODAL-REASON');
  b.injectFrame(body);
  await b.clock.advance(16000);
  assert.deepEqual({
    writes: b.writes,
    withheld: b.receipts(injectId, 'withheld').map(r => ({ part: r.msg.part, reason: r.msg.reason })),
    violations: b.receiptViolations(['VT-MODAL-REASON']),
  }, { writes: [], withheld: [{ part: 'body', reason: 'modal_ui' }], violations: [] });
});

test('#136 guard: recent user input blocks writes even on a ready composer frame', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-vt-user-guard' });
  b.feed(IDLE);
  await settleVt();
  const { body, submit } = b.daemonInject('VT-USER-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  for (let i = 0; i < 20; i++) { b.shared.lastUserInputTime = b.clock.now(); await b.clock.advance(500); }
  assert.deepEqual(b.writes, []);
});

test('#136 F1: once the user stops typing, the ready composer frame drains body+CR exactly once', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-vt-user-then-idle' });
  b.feed(IDLE);
  await settleVt();
  const { body, submit } = b.daemonInject('VT-USER-THEN-IDLE');
  b.injectFrame(body);
  b.injectFrame(submit);
  for (let i = 0; i < 20; i++) { b.shared.lastUserInputTime = b.clock.now(); await b.clock.advance(500); }
  const whileTyping = b.writes.slice();
  await b.clock.advance(5000);
  assert.deepEqual({ whileTyping, afterIdle: b.writes }, {
    whileTyping: [], afterIdle: ['VT-USER-THEN-IDLE', '\r'],
  });
});

test('#136 guard: VT unavailable -> nothing is written on the differential stream', { timeout: 30000 }, async t => {
  vt.__setTerminalCtorForTest(null);
  t.after(() => vt.__setTerminalCtorForTest(undefined));
  const b = createBridge(t, { sid: 'b136-vt-unavailable-guard' });
  b.feed(IDLE);
  const { body, submit } = b.daemonInject('VT-UNAVAILABLE-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(30000);
  assert.deepEqual(b.writes, []);
});

test('#136 F2: VT unavailable is reported on bridge_queue (vt: unavailable:<reason>)', { timeout: 30000 }, async t => {
  vt.__setTerminalCtorForTest(null);
  t.after(() => vt.__setTerminalCtorForTest(undefined));
  const b = createBridge(t, { sid: 'b136-vt-unavailable-report' });
  b.feed(IDLE);
  const { body } = b.daemonInject('VT-UNAVAILABLE-REPORT');
  b.injectFrame(body);
  await b.clock.advance(16000);
  assert.deepEqual({
    writes: b.writes,
    vtUnavailableReported: b.framesOf('bridge_queue').some(f => typeof f.msg.vt === 'string' && f.msg.vt.startsWith('unavailable:')),
  }, { writes: [], vtUnavailableReported: true });
});
