'use strict';

// Task 1215 hotfix 0.10.1 (resume453) — an authorized inject into a live wrapped AI is handed to the child at once,
// in order, exactly once, even while the child keeps printing (working/thinking/loading). Output quietness, ready/idle
// detection, a rendered composer and settle timers are NOT admission conditions any more. What still withholds is
// real: a true modal on the rendered frame, the local user's own typing (2 s quiet window), an exited child during
// restart, a closed session. Withholding stays explicit (withheld/refused not_written receipts) and custodial.
// Written BEFORE the production change; the coder did not execute it (tester runs baseline RED / candidate GREEN).
//
// Real seams: createAllowSecurityContext (src/cli/security-actions.js) — the PRODUCTION owner-WS handler
// handleOwnerInject (cli.js calls the same function), createOutputRelay, observePromptReady, subscribeChild,
// spawnChild, bridge tick, flushBridgeMailbox, closeAllowSession — the real FileMailbox on a mkdtemp root, the real
// prompt registry, the real bridge flush filter and the REAL SessionScreen + @xterm/headless 6.0.0.
// Fakes (declared): clock + timers; child doubles (write recorder, onData/onExit registration) returned by the
// spawnPty seam; owner-WS send recorder; 80x24 stdout; fetchWithAuth rejects (no network). Streams are the synthetic
// fixtures in test/fixtures/bridge-136. No listener, daemon, native PTY, CLI or model.
//
// Baseline (0.10.0) expectation: every "at once" assertion below fails on the baseline (writes [] while the frame is
// busy/loading/unavailable, because isIdle() requires promptReady). "PRECONDITION:" failures are INVALID setup, not RED.

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
const OWNER_GENERATION = 'owner-gen-1215-hotfix';

function loadStream(name) {
  const recipe = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  assert.match(recipe.provenance, /^synthetic:/, `PRECONDITION: ${name} provenance must be synthetic`);
  let stream = recipe.preamble.join('');
  for (let k = 0; k < recipe.repeat; k++) stream += recipe.cycle[k % recipe.cycle.length];
  return stream + recipe.epilogue.join('');
}
const IDLE = loadStream('codex-differential-idle.json');
const BUSY = loadStream('codex-differential-busy.json');
const MODAL = loadStream('codex-differential-modal.json');
const LOADING = loadStream('codex-loading-no-composer.json');

function createClock() {
  const start = Math.floor((Date.now() - 3 * 3600 * 1000) / 1000) * 1000;
  let now = start; let seq = 0; let fired = 0;
  const timers = new Map(); const calls = { timeouts: [], intervals: [] };
  return {
    start, calls, now: () => now,
    setTimeout(fn, ms) { const id = ++seq; const d = Math.max(0, Number(ms) || 0); calls.timeouts.push(d); timers.set(id, { fn, at: now + d, every: 0 }); return id; },
    clearTimeout(id) { if (id != null) timers.delete(id); },
    setInterval(fn, ms) { const id = ++seq; const d = Math.max(1, Number(ms) || 1); calls.intervals.push(d); timers.set(id, { fn, at: now + d, every: d }); return id; },
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
async function settleVt() { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 20)); }

function childDouble(log, name) {
  const handlers = { data: null, exit: null };
  const child = {
    pid: 4000 + log.length, name, writes: [],
    write(data) { child.writes.push(data); log.push([name, data]); },
    resize() {}, kill() { throw new Error('PRECONDITION: native kill is not part of this fixture'); },
    onData(fn) { handlers.data = fn; }, onExit(fn) { handlers.exit = fn; },
    emit(data) { if (handlers.data) handlers.data(data); },
    exit(event = { exitCode: 1 }) { if (handlers.exit) handlers.exit(event); },
  };
  return child;
}

function createBridge(t, { sid, command = 'codex', readyRegistry = registry } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-hotfix-'));
  const bridgeRoot = path.join(root, 'bridge');
  const clock = createClock();
  const log = []; const sends = []; const children = [];
  const stdout = { columns: 80, rows: 24, isTTY: true, write() { return true; } };
  const first = childDouble(log, 'child-0');
  children.push(first);
  const shared = {
    sessionId: sid, command, cmdArgs: [], sshPlan: null, child: first, handoffPending: null, idleTtl: null,
    detectedBackend: 'fixture', terminalProgram: 'fixture', terminalType: 'xterm-256color',
    DAEMON_URL: 'http://127.0.0.1:9', fetchWithAuth: () => Promise.reject(new Error('no network in fixture')),
    sessionCwd: root, sessionEnv: {}, bridgeTarget: sid, bridgeMsgSeq: 0, bridgePendingCount: 0,
    promptReady: false, lastUserInputTime: 0, IDLE_THRESHOLD: 2000,
    knownAiCli: readyRegistry.isKnownAiCli(command), outputTail: '', readyRegistry, readyQualification: null,
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
  const allow = security.createAllowSecurityContext(shared, {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    getStdout: () => stdout, removeSignalHandler() {},
    spawnPty() { const next = childDouble(log, `child-${children.length}`); children.push(next); return next; },
    bridgeRoot,
  });
  shared.bridgeMailbox = allow.createBridgeMailbox();
  // Mirror of cli.js onReady (cli.js relayPtyOutput onReady) — the only cli.js closure the relay needs.
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
  const relay = allow.createOutputRelay({
    onInteraction: () => { shared.interactionBinding.input_generation++; },
    onBytes: () => {}, rewrite: data => data, write: () => {}, sendOutput: () => {},
    observeReady: data => allow.observePromptReady(data), onReady,
  });
  allow.subscribeChild(first, relay, () => {});
  // Child output enters through the subscribed child exactly as node-pty onData would deliver it.
  function feed(stream, chunk = 1024) { for (let i = 0; i < stream.length; i += chunk) shared.child.emit(stream.slice(i, i + chunk)); }
  // The PRODUCTION owner-WS inject handler; cli.js keeps only readyNotified of its own.
  function injectFrame(frame) {
    const handled = allow.handleOwnerInject(frame);
    if (handled.rawData && handled.rawData !== '\r') readyNotified = false;
    return handled;
  }
  function respawn() {
    const next = allow.spawnChild();
    assert.ok(next, 'PRECONDITION: spawnChild returned a successor child double');
    allow.subscribeChild(next, relay, () => {});
    return next;
  }
  let injectSeq = 0;
  function daemonInject(text) {
    injectSeq++;
    const injectId = `00000000-0000-4000-8000-${String(injectSeq).padStart(12, '0')}`;
    const body = { type: 'inject', data: text, daemon_msg_id: `dm-${injectSeq}-body`, inject_id: injectId, part: 'body', owner_generation: OWNER_GENERATION };
    const submit = { type: 'inject', data: '\r', daemon_msg_id: `dm-${injectSeq}-submit`, inject_id: injectId, part: 'submit',
      pair: body.daemon_msg_id, owner_generation: OWNER_GENERATION };
    return { injectId, body, submit };
  }
  function framesOf(type) {
    const out = [];
    for (const entry of sends) { let msg; try { msg = JSON.parse(entry.raw); } catch { continue; } if (msg && msg.type === type) out.push({ ...entry, msg }); }
    return out;
  }
  const receipts = (injectId, stage) => framesOf('bridge_receipt').filter(r => r.msg.inject_id === injectId && (!stage || r.msg.stage === stage));
  const stages = injectId => receipts(injectId).map(r => `${r.msg.part}:${r.msg.stage}`);
  const leaf = name => {
    const file = path.join(fs.realpathSync(bridgeRoot), sid, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const writes = () => log.map(([, data]) => data);
  t.after(() => {
    try { allow.closeAllowSession({ destroySession: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { shared, allow, clock, log, writes, children, sends, feed, injectFrame, respawn, daemonInject, framesOf, receipts, stages, leaf };
}

const typing = b => { b.shared.lastUserInputTime = b.clock.now(); };

// --- continuous output / working / loading: handed off at once --------------------------------------------------

test('hotfix: under CONTINUOUS busy output, body and CR are written at once, in order, exactly once', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-continuous' });
  const { injectId, body, submit } = b.daemonInject('HF-CONTINUOUS');
  const third = Math.floor(BUSY.length / 3);
  b.feed(BUSY.slice(0, third));
  await settleVt();
  b.injectFrame(body);
  b.feed(BUSY.slice(third, 2 * third)); // the child keeps working between the body and its CR
  b.injectFrame(submit);
  const atOnce = b.writes();
  b.feed(BUSY.slice(2 * third));
  await settleVt();
  await b.clock.advance(30000);
  assert.deepEqual({ atOnce, final: b.writes(), stages: b.stages(injectId), inbox: b.leaf('inbox.jsonl').length,
    firstReady: b.shared.firstReadyObserved },
  { atOnce: ['HF-CONTINUOUS', '\r'], final: ['HF-CONTINUOUS', '\r'], stages: ['body:pty_written', 'submit:pty_written'], inbox: 0,
    firstReady: false });
});

test('hotfix: a rendered WORKING frame (esc to interrupt) receives body and CR at once; no withheld receipt', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-working' });
  b.feed(BUSY);
  await settleVt();
  const { injectId, body, submit } = b.daemonInject('HF-WORKING');
  b.injectFrame(body);
  b.injectFrame(submit);
  const atOnce = b.writes();
  await b.clock.advance(20000);
  assert.deepEqual({ atOnce, final: b.writes(), withheld: b.receipts(injectId, 'withheld').length, queued: b.receipts(injectId, 'queued').length },
    { atOnce: ['HF-WORKING', '\r'], final: ['HF-WORKING', '\r'], withheld: 0, queued: 0 });
});

test('hotfix: a never-ready LOADING child (first ready unobserved) receives body and CR at once; no ready is invented', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-loading' });
  b.feed(LOADING);
  await settleVt();
  const { injectId, body, submit } = b.daemonInject('HF-LOADING');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(20000);
  assert.deepEqual({ writes: b.writes(), stages: b.stages(injectId), firstReady: b.shared.firstReadyObserved,
    readyFrames: b.framesOf('ready').length, phase: b.allow.bridgeQueueSummary().phase },
  { writes: ['HF-LOADING', '\r'], stages: ['body:pty_written', 'submit:pty_written'], firstReady: false, readyFrames: 0, phase: 'open' });
});

test('hotfix: an IDLE composer control still receives body and CR at once', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-idle' });
  b.feed(IDLE);
  await settleVt();
  const { body, submit } = b.daemonInject('HF-IDLE');
  b.injectFrame(body);
  b.injectFrame(submit);
  assert.deepEqual(b.writes(), ['HF-IDLE', '\r']);
});

test('hotfix: VT unavailable and the VT kill switch no longer withhold a known CLI', { timeout: 30000 }, async t => {
  vt.__setTerminalCtorForTest(null);
  t.after(() => vt.__setTerminalCtorForTest(undefined));
  const b = createBridge(t, { sid: 'hf-vt-unavailable' });
  b.feed(IDLE);
  const u = b.daemonInject('HF-VT-UNAVAILABLE');
  b.injectFrame(u.body);
  b.injectFrame(u.submit);
  vt.__setTerminalCtorForTest(undefined);
  const saved = process.env.TELEPTY_BRIDGE_VT_READY;
  process.env.TELEPTY_BRIDGE_VT_READY = '0';
  t.after(() => { if (saved === undefined) delete process.env.TELEPTY_BRIDGE_VT_READY; else process.env.TELEPTY_BRIDGE_VT_READY = saved; });
  const k = createBridge(t, { sid: 'hf-kill-switch' });
  k.feed(BUSY);
  const ks = k.daemonInject('HF-KILL-SWITCH');
  k.injectFrame(ks.body);
  k.injectFrame(ks.submit);
  assert.deepEqual({ unavailable: b.writes(), killSwitch: k.writes(), killVt: k.allow.bridgeQueueSummary().vt },
    { unavailable: ['HF-VT-UNAVAILABLE', '\r'], killSwitch: ['HF-KILL-SWITCH', '\r'], killVt: 'disabled' });
});

test('hotfix: a generic (unknown) CLI without any prompt receives body and CR at once', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-generic', command: 'generic-tool' });
  assert.equal(b.shared.knownAiCli, false, 'PRECONDITION: generic-tool is not a known AI CLI');
  b.feed('compiling... 12%\r\n');
  const { body, submit } = b.daemonInject('HF-GENERIC');
  b.injectFrame(body);
  b.injectFrame(submit);
  assert.deepEqual(b.writes(), ['HF-GENERIC', '\r']);
});

// --- FIFO and exactly-once ---------------------------------------------------------------------------------------

test('hotfix: three pairs interleaved with busy output stay FIFO, one write each', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-fifo' });
  const pairs = ['HF-A', 'HF-B', 'HF-C'].map(text => b.daemonInject(text));
  const chunk = Math.floor(BUSY.length / 6);
  pairs.forEach((p, i) => {
    b.feed(BUSY.slice(2 * i * chunk, (2 * i + 1) * chunk));
    b.injectFrame(p.body);
    b.feed(BUSY.slice((2 * i + 1) * chunk, (2 * i + 2) * chunk));
    b.injectFrame(p.submit);
  });
  await settleVt();
  await b.clock.advance(20000);
  assert.deepEqual({ writes: b.writes(), written: pairs.map(p => b.receipts(p.injectId, 'pty_written').map(r => r.msg.part)) },
    { writes: ['HF-A', '\r', 'HF-B', '\r', 'HF-C', '\r'], written: [['body', 'submit'], ['body', 'submit'], ['body', 'submit']] });
});

test('hotfix: records queued while the user types drain once when typing stops — busy output does not hold them; repeated flush writes nothing more', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-typing-drain' });
  b.feed(BUSY);
  await settleVt();
  const first = b.daemonInject('HF-TYPED-ONE');
  const second = b.daemonInject('HF-TYPED-TWO');
  typing(b);
  for (const frame of [first.body, first.submit, second.body, second.submit]) b.injectFrame(frame);
  const whileTyping = { writes: b.writes(), pending: b.shared.bridgePendingCount,
    reason: (b.allow.bridgeQueueSummary().phase === 'waiting') };
  await b.clock.advance(3000); // typing quiet; the busy frame is still on screen
  b.feed(BUSY);
  for (let i = 0; i < 5; i++) b.allow.flushBridgeMailbox();
  await settleVt();
  await b.clock.advance(20000);
  const states = b.leaf('state.jsonl');
  const finalById = new Map(); for (const row of states) finalById.set(row.msg_id, row.state);
  assert.deepEqual({ whileTyping, writes: b.writes(), finalStates: [...finalById.values()],
    written: [first, second].map(p => b.receipts(p.injectId, 'pty_written').map(r => r.msg.part)) },
  { whileTyping: { writes: [], pending: 4, reason: true },
    writes: ['HF-TYPED-ONE', '\r', 'HF-TYPED-TWO', '\r'], finalStates: ['acked', 'acked', 'acked', 'acked'],
    written: [['body', 'submit'], ['body', 'submit']] });
});

// --- true modal still withholds ----------------------------------------------------------------------------------

test('hotfix: a TRUE modal on the rendered frame still withholds body and CR (withheld modal_ui), then drains once when the composer returns', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-modal' });
  b.feed(MODAL);
  await settleVt();
  const { injectId, body, submit } = b.daemonInject('HF-MODAL');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(16000);
  const onModal = { writes: b.writes(), withheld: b.receipts(injectId, 'withheld').map(r => `${r.msg.part}:${r.msg.reason}:${r.msg.certainty}`),
    reason: b.allow.bridgeQueueSummary().reason };
  b.feed(IDLE);
  await settleVt();
  await b.clock.advance(5000);
  assert.deepEqual({ onModal, writes: b.writes() }, {
    onModal: { writes: [], withheld: ['body:modal_ui:not_written', 'submit:modal_ui:not_written'], reason: 'modal_ui' },
    writes: ['HF-MODAL', '\r'],
  });
});

// --- restart, ownership change, unwritable child -----------------------------------------------------------------

test('hotfix restart: records pending across a child exit are never written to the exited child and drain once to its successor', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-restart' });
  const old = b.children[0];
  const { injectId, body, submit } = b.daemonInject('HF-RESTART');
  typing(b);
  b.injectFrame(body);
  b.injectFrame(submit);
  assert.equal(b.shared.bridgePendingCount, 2, 'PRECONDITION: body and CR queued while the user types');
  old.exit({ exitCode: 1 });
  await b.clock.advance(5000); // typing quiet, but the only child has exited: restart window
  const duringRestart = { oldWrites: old.writes.slice(), pending: b.shared.bridgePendingCount };
  const next = b.respawn();
  next.emit('Preparing workspace (step 1 of 3)'); // the successor is still loading: no ready needed
  await b.clock.advance(3000);
  assert.deepEqual({ duringRestart, oldWrites: old.writes, newWrites: next.writes, written: b.receipts(injectId, 'pty_written').map(r => r.msg.part) }, {
    duringRestart: { oldWrites: [], pending: 2 },
    oldWrites: [], newWrites: ['HF-RESTART', '\r'], written: ['body', 'submit'],
  });
});

test('hotfix restart window: with nothing pending, a body is queued (not written to the exited child) and a lone CR is refused child_exited', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-restart-window' });
  const old = b.children[0];
  old.exit({ exitCode: 1 });
  const lone = b.injectFrame({ type: 'inject', data: '\r' }); // a terminal-level CR, nothing pending
  const { injectId, body, submit } = b.daemonInject('HF-WINDOW');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(3000);
  const duringRestart = { oldWrites: old.writes.slice(), pending: b.shared.bridgePendingCount, lone,
    refused: b.framesOf('bridge_receipt').filter(r => r.msg.stage === 'refused').map(r => [r.msg.reason, r.msg.certainty]) };
  const next = b.respawn();
  await b.clock.advance(3000);
  assert.deepEqual({ duringRestart, newWrites: next.writes, written: b.receipts(injectId, 'pty_written').map(r => r.msg.part) }, {
    duringRestart: { oldWrites: [], pending: 2, lone: { rawData: '\r', textWritten: false }, refused: [['child_exited', 'not_written']] },
    newWrites: ['HF-WINDOW', '\r'], written: ['body', 'submit'],
  });
});

test('hotfix ownership change: records queued under one owner generation drain once under its successor, receipts name the successor', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-owner' });
  const { injectId, body, submit } = b.daemonInject('HF-OWNER');
  typing(b);
  b.injectFrame(body);
  b.injectFrame(submit);
  const successorSends = [];
  b.shared.daemonWs = { readyState: 1, send(raw) { successorSends.push(JSON.parse(String(raw))); }, close() {} };
  b.shared.interactionBinding = { ...b.shared.interactionBinding, owner_generation: 'owner-gen-1215-successor' };
  await b.clock.advance(3000);
  const written = successorSends.filter(m => m.type === 'bridge_receipt' && m.inject_id === injectId && m.stage === 'pty_written');
  assert.deepEqual({ writes: b.writes(), written: written.map(m => [m.part, m.owner_generation]) },
    { writes: ['HF-OWNER', '\r'], written: [['body', 'owner-gen-1215-successor'], ['submit', 'owner-gen-1215-successor']] });
});

test('hotfix unwritable: a closed session writes nothing and claims nothing; queued records keep custody as not_written', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'hf-closed' });
  const queued = b.daemonInject('HF-QUEUED-THEN-CLOSED');
  typing(b);
  b.injectFrame(queued.body);
  b.injectFrame(queued.submit);
  assert.equal(b.allow.closeAllowSession({ destroySession: true }), true);
  const late = b.daemonInject('HF-AFTER-CLOSE');
  b.injectFrame(late.body);
  b.injectFrame(late.submit);
  await b.clock.advance(20000);
  assert.deepEqual({ writes: b.writes(), dead: b.leaf('dead-letter.jsonl').map(d => [d.payload, d.reason]),
    written: b.framesOf('bridge_receipt').filter(r => r.msg.stage === 'pty_written').length },
  { writes: [], dead: [['HF-QUEUED-THEN-CLOSED', 'bridge_exit_unwritten'], ['\r', 'bridge_exit_unwritten']], written: 0 });
});
