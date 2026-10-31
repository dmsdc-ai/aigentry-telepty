'use strict';

// #136 (RB1) F4 regression source, task 1215: records left by a PREVIOUS bridge process are
// never replayed, and the flush-filter drop path dead-letters instead of relabelling as acked.
// Written BEFORE the production fix; see SPEC.md §5.1.5-6.
//
// Real seams: createAllowSecurityContext (src/cli/security-actions.js:290) incl.
// recoverBridgeMailbox (:562-571) and flushBridgeMailbox's filter/ack path (:447-456), the real
// FileMailbox (a second FileMailbox instance on the same root plays the previous process), the
// real filterBridgeBatch. Fakes (declared): clock + timers, child.write / owner-WS recorders,
// 80x24 stdout. cli.js onReady (cli.js:3412-3421) and inject handler (cli.js:3160-3196) are
// mirrored as callers. cli.js calls recoverBridgeMailbox only after owner acceptance (cli.js:3334);
// the fake owner WS is connected (wsReady) throughout.
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


const LEGACY = loadStream('codex-legacy-composer.json');
const LEFTOVERS = ['LEFTOVER-1', 'LEFTOVER-2', 'LEFTOVER-3'];
const LEFTOVER_IN_FLIGHT = 'LEFTOVER-IN-FLIGHT';

// The previous bridge process: 1 record it had dequeued (in_flight, write outcome unknown) and
// 3 it never dequeued (pending). All are younger than the 600 s bridge TTL.
function seedPreviousProcess(b, sid) {
  const previous = new FileMailbox({ root: b.bridgeRoot });
  const nowSecs = Math.floor(b.clock.now() / 1000);
  const ids = {};
  previous.enqueue({ msg_id: `${sid}:prev:0`, from: 'daemon', to: sid, payload: LEFTOVER_IN_FLIGHT, created_at: nowSecs - 40, attempt: 0 });
  ids[LEFTOVER_IN_FLIGHT] = `${sid}:prev:0`;
  const taken = previous.dequeue(sid);
  assert.equal(taken && taken.payload, LEFTOVER_IN_FLIGHT, 'PRECONDITION: previous process held one record in flight');
  LEFTOVERS.forEach((payload, i) => {
    const msgId = `${sid}:prev:${i + 1}`;
    previous.enqueue({ msg_id: msgId, from: 'daemon', to: sid, payload, created_at: nowSecs - 30 + i, attempt: 0 });
    ids[payload] = msgId;
  });
  const states = Object.fromEntries(b.entries().map(e => [e.payload, e.state]));
  assert.deepEqual(states, { [LEFTOVER_IN_FLIGHT]: 'in_flight', 'LEFTOVER-1': 'pending', 'LEFTOVER-2': 'pending', 'LEFTOVER-3': 'pending' },
    'PRECONDITION: seeded previous-process mailbox');
  return ids;
}

test('#136 guard: a recovered in_flight record (write outcome unknown) is never written', { timeout: 30000 }, async t => {
  const sid = 'b136-recovery-guard';
  const b = createBridge(t, { sid });
  seedPreviousProcess(b, sid);
  b.allow.recoverBridgeMailbox();
  b.feed(LEGACY);
  await b.clock.advance(10000);
  assert.equal(b.writes.includes(LEFTOVER_IN_FLIGHT), false);
});

test('#136 F4: previous-bridge leftovers are quarantined, never replayed on ready; a fresh record still drains once', { timeout: 30000 }, async t => {
  const sid = 'b136-recovery';
  const b = createBridge(t, { sid });
  const ids = seedPreviousProcess(b, sid);
  b.allow.recoverBridgeMailbox();
  b.feed(LEGACY); // a positive ready right after recovery
  await b.clock.advance(3000);
  const { body } = b.daemonInject('FRESH-AFTER-RECOVERY');
  b.injectFrame(body);
  b.feed(LEGACY);
  await b.clock.advance(8000);
  const leftoverIds = new Set(Object.values(ids));
  const dead = b.deadLetters()
    .filter(d => leftoverIds.has(d.msg_id))
    .map(d => ({ payload: d.payload, reason: d.reason, delivery_uncertain: d.delivery_uncertain === true }))
    .sort((x, y) => x.payload.localeCompare(y.payload));
  assert.deepEqual({
    writes: b.writes,
    leftoverStates: Object.fromEntries(b.entries().filter(e => leftoverIds.has(e.msg_id)).map(e => [e.payload, e.state])),
    dead,
    everAckedLeftover: b.stateHistory().some(row => leftoverIds.has(row.msg_id) && row.state === 'acked'),
    quarantinedCertainties: b.framesOf('bridge_receipt').filter(r => r.msg.stage === 'quarantined').map(r => r.msg.certainty).sort(),
    violations: b.receiptViolations([...LEFTOVERS, LEFTOVER_IN_FLIGHT]),
  }, {
    writes: ['FRESH-AFTER-RECOVERY'],
    leftoverStates: { [LEFTOVER_IN_FLIGHT]: 'dead_letter', 'LEFTOVER-1': 'dead_letter', 'LEFTOVER-2': 'dead_letter', 'LEFTOVER-3': 'dead_letter' },
    dead: [
      { payload: 'LEFTOVER-1', reason: 'recovered_previous_bridge', delivery_uncertain: false },
      { payload: 'LEFTOVER-2', reason: 'recovered_previous_bridge', delivery_uncertain: false },
      { payload: 'LEFTOVER-3', reason: 'recovered_previous_bridge', delivery_uncertain: false },
      { payload: LEFTOVER_IN_FLIGHT, reason: 'recovered_in_flight_unknown', delivery_uncertain: true },
    ],
    everAckedLeftover: false,
    quarantinedCertainties: ['not_written', 'not_written', 'not_written', 'unknown'],
    violations: [],
  });
});

test('#136 F4: a consecutive duplicate dropped at flush is dead-lettered (bridge_duplicate), never relabelled acked', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b136-duplicate-drop' });
  const first = b.daemonInject('SAME-QUESTION');
  const second = b.daemonInject('SAME-QUESTION');
  b.injectFrame(first.body);
  b.injectFrame(second.body);
  assert.deepEqual(b.entries().map(e => e.state), ['pending', 'pending'], 'PRECONDITION: both copies queued while not ready');
  b.feed(LEGACY);
  await b.clock.advance(3000);
  assert.deepEqual({
    writes: b.writes,
    states: b.entries().map(e => e.state),
    dead: b.deadLetters().map(d => ({ reason: d.reason, payload: d.payload })),
    secondQuarantined: b.receipts(second.injectId, 'quarantined').map(r => r.msg.certainty),
    violations: b.receiptViolations(['SAME-QUESTION']),
  }, {
    writes: ['SAME-QUESTION'],
    states: ['acked', 'dead_letter'],
    dead: [{ reason: 'bridge_duplicate', payload: 'SAME-QUESTION' }],
    secondQuarantined: ['not_written'],
    violations: [],
  });
});
