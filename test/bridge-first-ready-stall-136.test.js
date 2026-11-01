'use strict';

// #136 (RB1) regression source, task 1215. Written BEFORE the production fix; see SPEC.md.
//
// Real seams: createAllowSecurityContext (src/cli/security-actions.js:290), its createOutputRelay /
// observePromptReady / enqueueBridgeMessage / scheduleIdleFlush / flushBridgeMailbox, the real
// FileMailbox on a mkdtemp root, the real prompt registry, the real bridge flush filter and the
// real SessionScreen VT module. Fakes (declared): clock + timers, child.write recorder, owner-WS
// send recorder, 80x24 stdout. The cli.js onReady callback (cli.js:3412-3421) and inject-frame
// handler (cli.js:3160-3196) are closures, not exports, so they are mirrored line-for-line below
// as CALLERS of the real seams.
//
// Assertion messages starting with "PRECONDITION:" check the fixture/setup; a failure there is
// INVALID, not a measured RED. Every other assertion is a frozen behaviour assertion.

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
const LOADING = loadStream('codex-loading-no-composer.json');
const LEGACY = loadStream('codex-legacy-composer.json');

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

test('#136 H (VT-unavailable control): differential stream, 120 ticks -> 0 writes, records pending, no 5 s compat timer', { timeout: 30000 }, async t => {
  assert.ok(IDLE.length > 20000 && !/[\r\n]/.test(IDLE), 'PRECONDITION: differential fixture is >20k with no LF/CR');
  assert.ok(tailVerdicts(IDLE).every(found => found === false), 'PRECONDITION: raw-tail detector never matches the differential stream');
  vt.__setTerminalCtorForTest(null); // existing seam: VT library unavailable
  t.after(() => vt.__setTerminalCtorForTest(undefined));
  const b = createBridge(t, { sid: 'b136-h-control' });
  b.feed(IDLE);
  const { body, submit } = b.daemonInject('H-CONTROL-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  for (let i = 0; i < 120; i++) await b.clock.advance(500);
  assert.deepEqual({
    writes: b.writes,
    states: b.entries().map(e => e.state),
    compatFlushTimers: b.clock.calls.timeouts.filter(ms => ms === 5000).length,
  }, { writes: [], states: ['pending', 'pending'], compatFlushTimers: 0 });
});

test('#136 P1 (legacy positive control): a tail-matching composer drains body+CR exactly once', { timeout: 30000 }, async t => {
  assert.equal(registry.detectOutput('codex', LEGACY).found, true, 'PRECONDITION: legacy fixture matches the existing tail detector');
  const b = createBridge(t, { sid: 'b136-p1-control' });
  const { body, submit } = b.daemonInject('P1-LEGACY-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  b.feed(LEGACY);
  await b.clock.advance(2000);
  const afterReady = b.writes.slice();
  await b.clock.advance(10000);
  assert.deepEqual({ afterReady, afterMoreTicks: b.writes }, {
    afterReady: ['P1-LEGACY-BODY', '\r'], afterMoreTicks: ['P1-LEGACY-BODY', '\r'],
  });
});

test('#136 P1-receipt: a written body and submit each get exactly one bounded pty_written receipt', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-p1-receipt' });
  const { injectId, body, submit } = b.daemonInject('P1-RECEIPT-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  b.feed(LEGACY);
  await b.clock.advance(12000);
  assert.deepEqual({
    writes: b.writes,
    ptyWritten: b.receipts(injectId, 'pty_written').map(r => r.msg.part),
    violations: b.receiptViolations(['P1-RECEIPT-BODY']),
  }, { writes: ['P1-RECEIPT-BODY', '\r'], ptyWritten: ['body', 'submit'], violations: [] });
});

test('#136 N1: a never-ready known CLI becomes visibly stalled by 15 s (one withheld receipt per reason, bounded queue frames), still 0 writes', { timeout: 30000 }, async t => {
  assert.ok(tailVerdicts(LOADING).every(found => found === false), 'PRECONDITION: loading fixture never matches the tail detector');
  const b = createBridge(t, { sid: 'b136-n1-stall' });
  b.feed(LOADING);
  await settleVt();
  const { injectId, body } = b.daemonInject('N1-STALL-BODY');
  b.injectFrame(body);
  await b.clock.advance(16000);
  const withheldBy16s = b.receipts(injectId, 'withheld').map(r => ({ part: r.msg.part, reason: r.msg.reason }));
  const stalledBy16s = b.framesOf('bridge_queue').some(q => q.msg.phase === 'stalled' && q.msg.pending === 1);
  await b.clock.advance(44000);
  const perSecond = new Map();
  for (const q of b.framesOf('bridge_queue')) {
    const second = Math.floor((q.at - b.clock.start) / 1000);
    perSecond.set(second, (perSecond.get(second) || 0) + 1);
  }
  assert.deepEqual({
    writes: b.writes,
    withheldBy16s,
    stalledBy16s,
    withheldBy60s: b.receipts(injectId, 'withheld').length,
    queueFramesAtMostOnePerSecond: [...perSecond.values()].every(n => n <= 1),
    violations: b.receiptViolations(['N1-STALL-BODY']),
  }, {
    writes: [],
    withheldBy16s: [{ part: 'body', reason: 'first_ready_unobserved' }],
    stalledBy16s: true,
    withheldBy60s: 1,
    queueFramesAtMostOnePerSecond: true,
    violations: [],
  });
});

test('#136 N2: past the 600 s TTL the tick quarantines the record (dead_letter expired_unwritten, payload kept, never acked, never written)', { timeout: 60000 }, async t => {
  const b = createBridge(t, { sid: 'b136-n2-ttl' });
  b.feed(LOADING);
  await settleVt();
  const { injectId, body } = b.daemonInject('N2-TTL-BODY');
  b.injectFrame(body);
  await b.clock.advance(602000);
  const atTtl = {
    writes: b.writes.slice(),
    state: b.stateOfPayload('N2-TTL-BODY'),
    dead: b.deadLetters().map(d => ({ reason: d.reason, payload: d.payload })),
    quarantined: b.receipts(injectId, 'quarantined').map(r => ({ part: r.msg.part, certainty: r.msg.certainty })),
  };
  b.feed(LEGACY); // a later ready must not replay or relabel it
  await b.clock.advance(2000);
  assert.deepEqual({
    ...atTtl,
    writesAfterLaterReady: b.writes,
    everAcked: b.stateHistory().some(row => row.state === 'acked'),
    violations: b.receiptViolations(['N2-TTL-BODY']),
  }, {
    writes: [],
    state: 'dead_letter',
    dead: [{ reason: 'expired_unwritten', payload: 'N2-TTL-BODY' }],
    quarantined: [{ part: 'body', certainty: 'not_written' }],
    writesAfterLaterReady: [],
    everAcked: false,
    violations: [],
  });
});

test('#136 N3: the submit CR is withdrawn with its expired body (pair_unwritten); a later ready writes no lone CR', { timeout: 60000 }, async t => {
  const b = createBridge(t, { sid: 'b136-n3-pair' });
  b.feed(LOADING);
  await settleVt();
  const { injectId, body, submit } = b.daemonInject('N3-PAIR-BODY');
  b.injectFrame(body);
  await b.clock.advance(300000);
  b.injectFrame(submit); // the CR arrives later, so its own age stays below the TTL
  await b.clock.advance(302000);
  const atTtl = {
    writes: b.writes.slice(),
    bodyState: b.stateOfPayload('N3-PAIR-BODY'),
    submitState: b.stateOfPayload('\r'),
    dead: b.deadLetters().map(d => ({ reason: d.reason, payload: d.payload })),
    quarantined: b.receipts(injectId, 'quarantined').map(r => ({ part: r.msg.part, certainty: r.msg.certainty })),
  };
  b.feed(LEGACY);
  await b.clock.advance(2000);
  assert.deepEqual({ ...atTtl, writesAfterLaterReady: b.writes }, {
    writes: [],
    bodyState: 'dead_letter',
    submitState: 'dead_letter',
    dead: [{ reason: 'expired_unwritten', payload: 'N3-PAIR-BODY' }, { reason: 'pair_unwritten', payload: '\r' }],
    quarantined: [{ part: 'body', certainty: 'not_written' }, { part: 'submit', certainty: 'not_written' }],
    writesAfterLaterReady: [],
  });
});
