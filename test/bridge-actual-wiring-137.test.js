'use strict';

// #136/#137 task 1215 — actual-caller coverage the frozen 136/137 bodies do not provide:
//   1. cli.js wiring (closures, not exports): checked on the real cli.js source text.
//   2. Bridge context behaviour through the real createAllowSecurityContext + FileMailbox + VT:
//      post-first-ready busy safety (no 5 s blind timer), exit custody (queue-preserving, fail
//      closed), the VT kill switch, lone-submit refusal, and the queue summary the heartbeat carries.
//   3. Daemon: paired submit frame ids, submit receipts, NO consumption from receipts, and
//      cross-session receipt forgery — via a real daemon.js (test-support/daemon-harness.js).
// The inject-frame path calls the production handleOwnerInject (task 1215 F4); the onReady closure
// mirrors cli.js, and the static checks in (1) bind both to the real cli.js. Payloads are synthetic.
// "PRECONDITION:" assertions validate fixtures/setup (failure = INVALID, not RED).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const security = require('../src/cli/security-actions');
const registry = require('../src/prompt-symbol-registry');
const bridgeStage = require('../src/mailbox/bridge-stage');
const { FileMailbox } = require('../src/mailbox/index');
const flushFilter = require('../src/mailbox/bridge-flush-filter');
const { getTerminalSize } = require('../interactive-terminal');
const { startTestDaemon, waitFor, delay } = require('../test-support/daemon-harness');

const ROOT = path.join(__dirname, '..');
const FIXTURES_136 = path.join(__dirname, 'fixtures', 'bridge-136');
const FIXTURES_137 = path.join(__dirname, 'fixtures', 'bridge-137');
const OWNER_GENERATION = 'owner-gen-1215-current';

function loadStream(name) {
  const recipe = JSON.parse(fs.readFileSync(path.join(FIXTURES_136, name), 'utf8'));
  assert.match(recipe.provenance, /^synthetic:/, `PRECONDITION: ${name} provenance must be synthetic`);
  let stream = recipe.preamble.join('');
  for (let k = 0; k < recipe.repeat; k++) stream += recipe.cycle[k % recipe.cycle.length];
  return stream + recipe.epilogue.join('');
}
const IDLE = loadStream('codex-differential-idle.json');
const MODAL = loadStream('codex-differential-modal.json');
const BUSY = loadStream('codex-differential-busy.json');
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

function createBridge(t, { sid, identity = null, inputPolicy, readyRegistry = registry }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-137w-'));
  const bridgeRoot = path.join(root, 'bridge');
  const clock = createClock();
  const writes = []; const sends = [];
  const stdout = { columns: 80, rows: 24, isTTY: true, write() { return true; } };
  const child = { pid: null, write(data) { writes.push(data); }, resize() {},
    kill() { throw new Error('PRECONDITION: native kill is not part of this fixture'); } };
  const shared = {
    sessionId: sid, command: 'codex', cmdArgs: [], sshPlan: null, child, handoffPending: null, idleTtl: null,
    detectedBackend: 'fixture', terminalProgram: 'fixture', terminalType: 'xterm-256color',
    DAEMON_URL: 'http://127.0.0.1:9', fetchWithAuth: () => Promise.reject(new Error('no network in fixture')),
    sessionCwd: root, sessionEnv: {}, bridgeTarget: sid, bridgeMsgSeq: 0, bridgePendingCount: 0,
    promptReady: false, lastUserInputTime: 0, IDLE_THRESHOLD: 2000,
    knownAiCli: readyRegistry.isKnownAiCli('codex'), outputTail: '', readyRegistry, readyQualification: null,
    promptPattern: /[❯>$#%]\s*$/, firstReadyObserved: false, queueFlushTimer: null, idleCheckTimer: null,
    reconnectTimer: null, heartbeatTimer: null,
    filterBridgeBatch: flushFilter.filterBridgeBatch, bridgeInjectTtlSecs: flushFilter.bridgeInjectTtlSecs,
    interactionBinding: { sid, session_epoch: 'epoch-1215', credential_generation: 1,
      owner_generation: OWNER_GENERATION, input_generation: 0, geometry_generation: 0 },
    wsReady: true,
    daemonWs: { readyState: 1, send(raw) { sends.push({ raw: String(raw), at: clock.now() }); }, close() {} },
    getTerminalSize, allowSessionClosed: false, cleanupTerminal() {}, currentOwnerToken: 'synthetic-owner-token',
    allowSignalHandlers: new Map(), FileMailbox, path, os, bridgeIdentity: identity, inputPolicy,
  };
  const allow = security.createAllowSecurityContext(shared, {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    getStdout: () => stdout, removeSignalHandler() {},
    spawnPty() { throw new Error('PRECONDITION: native spawn is not part of this fixture'); },
    bridgeRoot,
  });
  shared.bridgeMailbox = allow.createBridgeMailbox();
  // Mirror of cli.js onReady (bound to cli.js by the static checks below).
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
  function feed(stream, chunk = 1024) { for (let i = 0; i < stream.length; i += chunk) relay(stream.slice(i, i + chunk)); }
  // Task 1215 F4: the PRODUCTION owner-WS inject handler (cli.js calls the same function); only
  // cli.js's own closure state (readyNotified) is kept here.
  function injectFrame(frame) {
    const handled = allow.handleOwnerInject(frame);
    if (handled.rawData && handled.rawData !== '\r') readyNotified = false;
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
  const leaf = name => {
    const file = path.join(fs.realpathSync(bridgeRoot), sid, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  t.after(() => {
    try { allow.closeAllowSession({ destroySession: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { shared, allow, clock, writes, sends, feed, injectFrame, daemonInject, framesOf, receipts, leaf, bridgeRoot };
}

// --- 1. actual cli.js wiring --------------------------------------------------------------------

const CLI = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');
function region(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `PRECONDITION: marker ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `PRECONDITION: marker ${endMarker}`);
  return source.slice(start, end);
}
const count = (text, needle) => text.split(needle).length - 1;

// Task 1215 F4: the inject branch is now ONE production function (security-actions
// handleOwnerInject) that cli.js calls and the tests call; this checks both ends of that wiring.
const SECURITY = fs.readFileSync(path.join(ROOT, 'src', 'cli', 'security-actions.js'), 'utf8');
test('#137 wiring: cli.js inject handler delegates to the shared production handler, which carries frame ids and routes direct writes', () => {
  const handler = region(CLI, "if (msg.type === 'inject') {", "} else if (msg.type === 'resize') {");
  const shared = region(SECURITY, 'function handleOwnerInject(msg) {', 'function announceTransportReady() {');
  assert.deepEqual({
    delegates: count(handler, 'allowSecurity.handleOwnerInject(msg)'),
    cliRawChildWrite: /child\.write\(/.test(handler),
    metaKeys: /for \(const key of \['daemon_msg_id', 'inject_id', 'part', 'pair', 'owner_generation'\]\)/.test(shared),
    enqueueWithMeta: count(shared, 'enqueueBridgeMessage(rawData, meta)'),
    enqueueWithoutMeta: count(shared, 'enqueueBridgeMessage(rawData)'),
    directViaContext: count(shared, 'writeDirectInject(rawData, meta)'),
    rawChildWrite: /child\.write\(/.test(shared),
    exported: /handleOwnerInject, announceTransportReady \};/.test(SECURITY),
  }, { delegates: 1, cliRawChildWrite: false, metaKeys: true, enqueueWithMeta: 2, enqueueWithoutMeta: 0, directViaContext: 2, rawChildWrite: false, exported: true });
});

test('#137 wiring: cli.js feeds the VT through the relay, notes both resizes, reports the queue and stamps the code digest', () => {
  const heartbeat = region(CLI, "type: 'heartbeat',", '}));');
  assert.deepEqual({
    relayFromContext: /const relayPtyOutput = allowSecurity\.createOutputRelay\(\{/.test(CLI),
    vtFeedThroughObserve: /if \(!sshInput\) return observePromptReady\(data\);/.test(CLI),
    resizeNotes: count(CLI, 'allowSecurity.noteBridgeGeometry('),
    ownerBoundQueue: /invalidateBridgeInteraction\('owner_bound'\);\s*if \(!sshPlan\) allowSecurity\.reportBridgeQueue\(true\);/.test(CLI),
    heartbeatQueue: heartbeat.includes('bridge_queue: allowSecurity.bridgeQueueSummary()'),
    identityOnce: count(CLI, "require('./src/mailbox/bridge-stage').bridgeIdentity(__dirname, pkg.version)"),
    identityGetter: CLI.includes('get bridgeIdentity() { return bridgeIdentity; }'),
    recoverAfterOwner: /await initialOwnerAccepted;\s*clearTimeout\(claimTimeout\);\s*spawnChild\(\);\s*if \(!sshPlan\) allowSecurity\.recoverBridgeMailbox\(\);/.test(CLI),
  }, { relayFromContext: true, vtFeedThroughObserve: true, resizeNotes: 2, ownerBoundQueue: true, heartbeatQueue: true,
    identityOnce: 1, identityGetter: true, recoverAfterOwner: true });
});

test('#137 identity: bridge_code_digest is a sha256 over the loaded bridge files, changes with them, and is null when unreadable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-digest-'));
  try {
    for (const rel of bridgeStage.DIGEST_FILES) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
    }
    const real = bridgeStage.bridgeIdentity(ROOT, '0.10.0');
    const copy = bridgeStage.bridgeIdentity(tmp, '0.10.0');
    fs.appendFileSync(path.join(tmp, 'src/mailbox/index.js'), '\n');
    const changed = bridgeStage.bridgeIdentity(tmp, '0.10.0');
    fs.rmSync(path.join(tmp, 'cli.js'));
    const missing = bridgeStage.bridgeIdentity(tmp, '0.10.0');
    assert.deepEqual({
      hex: /^[a-f0-9]{64}$/.test(real.bridge_code_digest), sameBytesSameDigest: copy.bridge_code_digest === real.bridge_code_digest,
      changedBytesNewDigest: changed.bridge_code_digest !== real.bridge_code_digest, missing: missing.bridge_code_digest,
      basis: real.digest_basis, version: real.bridge_version,
    }, { hex: true, sameBytesSameDigest: true, changedBytesNewDigest: true, missing: null, basis: 'files_at_bridge_start', version: '0.10.0' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('#137 validator: every forged/stale/forbidden receipt shape is refused; genuine ones pass', () => {
  const table = JSON.parse(fs.readFileSync(path.join(FIXTURES_137, 'receipt-cases.json'), 'utf8'));
  assert.match(table.provenance, /^synthetic:/, 'PRECONDITION: synthetic receipt table');
  const verdicts = table.cases.map(c => {
    const msg = { ...table.base, ...c.patch };
    if (c.pad_reason_units) msg.reason = 'x'.repeat(c.pad_reason_units);
    const v = bridgeStage.validateBridgeReceipt(msg, table.owner_generation);
    return { name: c.name, ok: v.ok, reason: v.ok ? undefined : v.reason };
  });
  assert.deepEqual(verdicts, table.cases.map(c => ({ name: c.name, ok: c.ok, reason: c.ok ? undefined : c.reason })));
});

// --- 2. bridge context behaviour -----------------------------------------------------------------

test('#136 post-first-ready busy safety: after a drained ready, a busy frame gets no 5 s blind flush and no write', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b137w-busy-after-ready' });
  b.feed(IDLE);
  await settleVt();
  const first = b.daemonInject('FIRST-READY-BODY');
  b.injectFrame(first.body);
  b.injectFrame(first.submit);
  await b.clock.advance(3000);
  assert.deepEqual(b.writes, ['FIRST-READY-BODY', '\r'], 'PRECONDITION: the first inject drained on a ready frame');
  assert.equal(b.shared.firstReadyObserved, true, 'PRECONDITION: first ready observed');
  b.feed(BUSY);
  await settleVt();
  const timersBefore = b.clock.calls.timeouts.length;
  const second = b.daemonInject('SECOND-WHILE-BUSY');
  b.injectFrame(second.body);
  b.injectFrame(second.submit);
  await b.clock.advance(20000);
  assert.deepEqual({
    writes: b.writes,
    blindFlushTimers: b.clock.calls.timeouts.slice(timersBefore).filter(ms => ms === 5000).length,
    withheld: b.receipts(second.injectId, 'withheld').filter(r => r.msg.part === 'body').map(r => r.msg.reason),
  }, { writes: ['FIRST-READY-BODY', '\r'], blindFlushTimers: 0, withheld: ['busy_indicator'] });
});

test('#136 exit custody: a destroying close dead-letters every undelivered record with its payload before clearing the queue', { timeout: 30000 }, async t => {
  const sid = 'b137w-exit-custody';
  const b = createBridge(t, { sid });
  b.feed(LOADING);
  const { injectId, body, submit } = b.daemonInject('EXIT-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  // A record a previous process had in flight (outcome unknown).
  const previous = new FileMailbox({ root: b.bridgeRoot });
  previous.enqueue({ msg_id: `${sid}:prev:0`, from: 'daemon', to: sid, payload: 'EXIT-PREV-IN-FLIGHT', created_at: Math.floor(b.clock.now() / 1000) - 10, attempt: 0 });
  assert.equal(previous.dequeue(sid).payload, 'EXIT-PREV-IN-FLIGHT', 'PRECONDITION: foreign in-flight record');
  assert.equal(b.allow.closeAllowSession({ destroySession: true }), true);
  assert.deepEqual({
    writes: b.writes,
    dead: b.leaf('dead-letter.jsonl').map(d => ({ payload: d.payload, reason: d.reason, uncertain: d.delivery_uncertain === true })),
    inbox: b.leaf('inbox.jsonl'), state: b.leaf('state.jsonl'),
    quarantined: b.receipts(injectId, 'quarantined').map(r => [r.msg.part, r.msg.certainty]),
  }, {
    writes: [],
    dead: [{ payload: 'EXIT-BODY', reason: 'bridge_exit_unwritten', uncertain: false },
      { payload: '\r', reason: 'bridge_exit_unwritten', uncertain: false },
      { payload: 'EXIT-PREV-IN-FLIGHT', reason: 'bridge_exit_in_flight_unknown', uncertain: true }],
    inbox: [], state: [],
    quarantined: [['body', 'not_written'], ['submit', 'not_written']],
  });
});

test('#136 exit custody fails closed: if a record cannot be dead-lettered, the queue is not purged', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b137w-exit-fail-closed' });
  const { body } = b.daemonInject('KEPT-BODY');
  b.injectFrame(body);
  b.shared.bridgeMailbox.withdraw = () => { throw new Error('synthetic withdraw failure'); };
  assert.equal(b.allow.closeAllowSession({ destroySession: true }), true);
  assert.deepEqual({
    inbox: b.leaf('inbox.jsonl').map(r => r.payload),
    lastState: b.leaf('state.jsonl').at(-1)?.state,
    dead: b.leaf('dead-letter.jsonl'),
  }, { inbox: ['KEPT-BODY'], lastState: 'pending', dead: [] });
});

test('#136 kill switch: TELEPTY_BRIDGE_VT_READY=0 never weakens the gate (a known CLI on an idle frame is still not written)', { timeout: 30000 }, async t => {
  const saved = process.env.TELEPTY_BRIDGE_VT_READY;
  process.env.TELEPTY_BRIDGE_VT_READY = '0';
  t.after(() => { if (saved === undefined) delete process.env.TELEPTY_BRIDGE_VT_READY; else process.env.TELEPTY_BRIDGE_VT_READY = saved; });
  const b = createBridge(t, { sid: 'b137w-kill-switch' });
  b.feed(IDLE);
  await settleVt();
  const { body, submit } = b.daemonInject('KILL-SWITCH-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(20000);
  assert.deepEqual({ writes: b.writes, vt: b.allow.bridgeQueueSummary().vt, blindFlushTimers: b.clock.calls.timeouts.filter(ms => ms === 5000).length },
    { writes: [], vt: 'disabled', blindFlushTimers: 0 });
});

test('#136 lone submit: a CR whose body was quarantined unwritten is refused, not written alone', { timeout: 60000 }, async t => {
  const b = createBridge(t, { sid: 'b137w-lone-submit' });
  b.feed(LOADING);
  await settleVt();
  const { injectId, body, submit } = b.daemonInject('LONE-SUBMIT-BODY');
  b.injectFrame(body);
  await b.clock.advance(602000);
  assert.equal(b.receipts(injectId, 'quarantined').length, 1, 'PRECONDITION: body quarantined by TTL');
  assert.equal(b.shared.bridgePendingCount, 0, 'PRECONDITION: nothing pending, so the CR takes the direct path');
  b.injectFrame(submit);
  assert.deepEqual({ writes: b.writes, refused: b.receipts(injectId, 'refused').map(r => [r.msg.part, r.msg.reason, r.msg.certainty]) },
    { writes: [], refused: [['submit', 'pair_unwritten', 'not_written']] });
});

test('#137 queue summary: the real VT feed and the bridge identity reach the bounded summary the heartbeat carries', { timeout: 30000 }, async t => {
  const identity = bridgeStage.bridgeIdentity(ROOT, require('../package.json').version);
  const b = createBridge(t, { sid: 'b137w-summary', identity });
  b.feed(LOADING);
  await settleVt();
  b.injectFrame(b.daemonInject('SUMMARY-BODY').body);
  await b.clock.advance(16000);
  const summary = b.allow.bridgeQueueSummary();
  const checked = bridgeStage.validateBridgeQueue(summary, OWNER_GENERATION);
  assert.deepEqual({
    valid: checked.ok, vt: summary.vt, phase: summary.phase, pending: summary.pending, reason: summary.reason,
    digest: summary.bridge_code_digest === identity.bridge_code_digest && /^[a-f0-9]{64}$/.test(summary.bridge_code_digest),
    bytes: Buffer.byteLength(JSON.stringify(summary)) <= bridgeStage.QUEUE_MAX_BYTES,
    payloadFree: !JSON.stringify(summary).includes('SUMMARY-BODY'),
  }, { valid: true, vt: 'available', phase: 'stalled', pending: 1, reason: 'first_ready_unobserved', digest: true, bytes: true, payloadFree: true });
});

// --- 2b. task 1215 role split: user-supervised orchestrator vs guarded worker --------------------

// A registry that counts every screen/tail classifier call, so "no screen read" is measured.
function countingRegistry() {
  const reads = { detectOutput: 0, detectFrame: 0, detectSurfaceModal: 0 };
  const proxy = { ...registry,
    detectOutput: (...a) => { reads.detectOutput++; return registry.detectOutput(...a); },
    detectFrame: (...a) => { reads.detectFrame++; return registry.detectFrame(...a); },
    detectSurfaceModal: (...a) => { reads.detectSurfaceModal++; return registry.detectSurfaceModal(...a); } };
  return { proxy, reads };
}
function countScreens(t) {
  const vtModule = require('../src/vt/session-screen');
  const Original = vtModule.SessionScreen;
  const counter = { constructed: 0 };
  vtModule.SessionScreen = class CountedSessionScreen extends Original {
    constructor(...args) { counter.constructed++; super(...args); }
  };
  t.after(() => { vtModule.SessionScreen = Original; });
  return counter;
}

test('#1215 supervised: an orchestrator on a MODAL frame receives body then CR at once, with zero screen reads', { timeout: 30000 }, async t => {
  const screens = countScreens(t);
  const { proxy, reads } = countingRegistry();
  const b = createBridge(t, { sid: 'b1215-supervised-direct', inputPolicy: 'user-supervised', readyRegistry: proxy });
  b.feed(MODAL); // an interaction modal is on screen; the user, not a classifier, controls it
  const { injectId, body, submit } = b.daemonInject('SUPERVISED-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(1000);
  assert.deepEqual({
    writes: b.writes, reads, screens: screens.constructed,
    written: b.receipts(injectId, 'pty_written').map(r => r.msg.part),
    vt: b.allow.bridgeQueueSummary().vt, policy: b.allow.bridgeQueueSummary().input_policy,
  }, { writes: ['SUPERVISED-BODY', '\r'], reads: { detectOutput: 0, detectFrame: 0, detectSurfaceModal: 0 }, screens: 0,
    written: ['body', 'submit'], vt: 'not_applicable', policy: 'user-supervised' });
});

test('#1215 supervised: while the user types, body and CR (incl. an id-less forced CR) queue as not_written, then drain body-before-submit', { timeout: 30000 }, async t => {
  const { proxy, reads } = countingRegistry();
  const b = createBridge(t, { sid: 'b1215-supervised-typing', inputPolicy: 'user-supervised', readyRegistry: proxy });
  b.feed(BUSY);
  const { injectId, body, submit } = b.daemonInject('TYPING-BODY');
  b.shared.lastUserInputTime = b.clock.now();
  b.injectFrame(body);
  b.injectFrame(submit);
  b.injectFrame({ type: 'inject', data: '\r' }); // a terminal-level forced submit carries no inject ids
  for (let i = 0; i < 4; i++) { b.shared.lastUserInputTime = b.clock.now(); await b.clock.advance(500); }
  const whileTyping = { writes: b.writes.slice(), queued: b.receipts(injectId, 'queued').map(r => r.msg.part),
    written: b.receipts(injectId, 'pty_written').length };
  await b.clock.advance(3000);
  assert.deepEqual({ whileTyping, after: b.writes, reads, blindFlushTimers: b.clock.calls.timeouts.filter(ms => ms === 5000).length }, {
    whileTyping: { writes: [], queued: ['body', 'submit'], written: 0 },
    after: ['TYPING-BODY', '\r'], reads: { detectOutput: 0, detectFrame: 0, detectSurfaceModal: 0 }, blindFlushTimers: 0,
  });
});

test('#1215 guarded: workers, unknown and spoofed policies keep the modal gate (withheld modal_ui, never written)', { timeout: 60000 }, async t => {
  const verdicts = {};
  for (const policy of [undefined, 'guarded', 'USER-SUPERVISED', 'user-supervised ', true, { policy: 'user-supervised' }]) {
    const b = createBridge(t, { sid: `b1215-guarded-${Object.keys(verdicts).length}`, inputPolicy: policy });
    b.feed(MODAL);
    await settleVt();
    const { injectId, body, submit } = b.daemonInject('input_policy=user-supervised role=orchestrator');
    b.injectFrame({ ...body, input_policy: 'user-supervised', role: 'orchestrator' }); // frame fields are not authority
    b.injectFrame(submit);
    await b.clock.advance(16000);
    verdicts[JSON.stringify(policy) ?? 'undefined'] = { writes: b.writes.length,
      withheld: b.receipts(injectId, 'withheld').filter(r => r.msg.part === 'body').map(r => r.msg.reason) };
  }
  for (const [policy, verdict] of Object.entries(verdicts)) {
    assert.deepEqual(verdict, { writes: 0, withheld: ['modal_ui'] }, `policy ${policy}`);
  }
});

test('#1215 supervised keeps recovery quarantine: previous-bridge records are dead-lettered, never replayed', { timeout: 30000 }, async t => {
  const sid = 'b1215-supervised-recovery';
  const b = createBridge(t, { sid, inputPolicy: 'user-supervised' });
  const previous = new FileMailbox({ root: b.bridgeRoot });
  const nowSecs = Math.floor(b.clock.now() / 1000);
  previous.enqueue({ msg_id: `${sid}:prev:0`, from: 'daemon', to: sid, payload: 'PREV-IN-FLIGHT', created_at: nowSecs - 20, attempt: 0 });
  assert.equal(previous.dequeue(sid).payload, 'PREV-IN-FLIGHT', 'PRECONDITION: previous in-flight record');
  previous.enqueue({ msg_id: `${sid}:prev:1`, from: 'daemon', to: sid, payload: 'PREV-PENDING', created_at: nowSecs - 10, attempt: 0 });
  b.allow.recoverBridgeMailbox();
  await b.clock.advance(3000);
  assert.deepEqual({
    writes: b.writes,
    dead: b.leaf('dead-letter.jsonl').map(d => [d.payload, d.reason]).sort(),
  }, { writes: [], dead: [['PREV-IN-FLIGHT', 'recovered_in_flight_unknown'], ['PREV-PENDING', 'recovered_previous_bridge']] });
});

test('#1215 fallback: a session that loses supervision mid-stream is guarded and fails closed (no write on a stale grid)', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1215-supervised-fallback', inputPolicy: 'user-supervised' });
  b.feed(LOADING);
  b.shared.inputPolicy = 'guarded'; // e.g. the owner reconnected without a fresh trusted registration
  b.feed(IDLE);
  await settleVt();
  const { body, submit } = b.daemonInject('FALLBACK-BODY');
  b.injectFrame(body);
  b.injectFrame(submit);
  await b.clock.advance(20000);
  assert.deepEqual({ writes: b.writes, policy: b.allow.bridgeQueueSummary().input_policy, vt: b.allow.bridgeQueueSummary().vt },
    { writes: [], policy: 'guarded', vt: 'unavailable:mid_stream_after_supervision' });
});

test('#1215 launch flag: --input-policy user-supervised is refused from inside a telepty session and parsed from a host launch', () => {
  const keys = ['TELEPTY_SESSION_ID', 'TELEPTY_SESSION_TOKEN', 'TELEPTY_AVAILABLE', 'TELEPTY_SESSION_NONCE', 'TELEPTY_SESSION_ORIGIN',
    'TELEPTY_SESSION_CREDENTIAL_PATH', 'TELEPTY_SESSION_CREDENTIAL_INSTANCE'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const restore = () => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  const exits = [];
  const cli = security.createCliSecurityActions({ path, lifecycle: { parseDuration() {} }, TRAILING_PAYLOAD_HELP: {} },
    { exit(code) { exits.push(code); throw Object.assign(new Error('captured exit'), { code }); } });
  try {
    for (const k of keys) delete process.env[k];
    const host = cli.parseAllowInvocation('allow', ['allow', '--id', 'orch-1215', '--input-policy', 'user-supervised', 'codex']);
    restore(); for (const k of keys) delete process.env[k];
    process.env.TELEPTY_SESSION_ID = 'some-worker';
    assert.throws(() => cli.parseAllowInvocation('allow', ['allow', '--id', 'x', '--input-policy', 'user-supervised', 'codex']), /captured exit/);
    restore(); for (const k of keys) delete process.env[k];
    assert.throws(() => cli.parseAllowInvocation('allow', ['allow', '--input-policy', 'supervised', 'codex']), /captured exit/);
    assert.deepEqual({ host, exits }, { host: { sessionId: 'orch-1215', command: 'codex', cmdArgs: [], idleTtl: null, autoRestart: false,
      inputPolicy: 'user-supervised' }, exits: [1, 1] });
  } finally { restore(); }
});

test('#1215 wiring: cli.js requests the policy at both registrations and trusts it only when the daemon confirms it per owner', () => {
  assert.deepEqual({
    destructured: CLI.includes('inputPolicy: requestedInputPolicy = null } = allowInvocation;'),
    registrations: count(CLI, "...(requestedInputPolicy ? { input_policy: requestedInputPolicy } : {}),"),
    bothRequired: CLI.includes("inputPolicy = requestedInputPolicy === 'user-supervised' && msg.input_policy === 'user-supervised' ? 'user-supervised' : 'guarded';"),
    guardedOnClose: /interactionBinding = null;\s*readinessNonce = null;\s*inputPolicy = 'guarded';/.test(CLI),
    getter: CLI.includes('get inputPolicy() { return inputPolicy; },'),
    refusedWarning: count(CLI, 'this session runs GUARDED'),
    // Task 1215 F1: the capability stays in bridge memory — never in an environment the child gets.
    capabilityToEnv: /(process\.env|sessionEnv)(\.[A-Za-z_]+|\[[^\]]+\])\s*=\s*[^;\n]*[Cc]apability/.test(CLI)
      || /sessionEnv = \{[^\n]*inputPolicyCapability/.test(CLI),
    capabilityHeaders: count(CLI, '...policyCapabilityHeaders()'),
    transportDeclared: CLI.includes("'x-telepty-bridge-capabilities': require('./src/transport/readiness-handshake').CAPABILITY"),
    announces: count(CLI, 'allowSecurity.announceTransportReady();'),
  }, { destructured: true, registrations: 2, bothRequired: true, guardedOnClose: true, getter: true, refusedWarning: 2,
    capabilityToEnv: false, capabilityHeaders: 2, transportDeclared: true, announces: 3 });
});

// --- 3. daemon ----------------------------------------------------------------------------------

let harness = null;
const sockets = [];
before(async () => { harness = await startTestDaemon(); }, { timeout: 30000 });
after(async () => {
  for (const ws of sockets) { try { ws.terminate(); } catch {} }
  if (harness) await harness.stop();
}, { timeout: 30000 });

async function ownedSession(sid) {
  const created = await harness.registerSession(sid, { command: 'fixture' });
  assert.equal(created.status, 201, `PRECONDITION: register ${JSON.stringify(created.body)}`);
  const frames = [];
  const owner = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}?owner=1`,
    { headers: { ...harness.ownerAuth(sid).headers, 'x-telepty-token': harness.authToken() } });
  sockets.push(owner);
  owner.on('message', raw => { try { frames.push(JSON.parse(raw)); } catch {} });
  await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
  const token = await waitFor(() => frames.find(f => f.type === 'owner_token'), { timeoutMs: 5000, description: 'owner_token' });
  const ownerGeneration = token.interaction_binding && token.interaction_binding.owner_generation;
  assert.equal(typeof ownerGeneration, 'string', 'PRECONDITION: owner generation');
  owner.send(JSON.stringify({ type: 'ready' }));
  return { sid, owner, frames, ownerGeneration, epoch: created.body.session_epoch };
}
function receipt(fields) {
  return JSON.stringify({ type: 'bridge_receipt', schema: 1, daemon_msg_id: null, inject_id: null, part: 'body',
    bridge_msg_id: 'synthetic-bridge-msg', stage: 'pty_written', reason: null, certainty: 'written', bridge_seq: 1,
    at_ms: Date.now(), clock: 'bridge_wall', owner_generation: null, ...fields });
}
async function messaging(s, injectId) {
  const meta = (await harness.request('/api/meta')).body;
  const query = new URLSearchParams({ machine_id: meta.machine_id, inject_id: injectId, session_epoch: s.epoch });
  const result = await harness.request(`/api/sessions/${encodeURIComponent(s.sid)}/diagnostics?${query}`);
  assert.equal(result.status, 200, `PRECONDITION: diagnostics ${JSON.stringify(result.body)}`);
  return result.body.messaging;
}
async function pollMessaging(s, injectId, predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  let last = await messaging(s, injectId);
  while (!predicate(last) && Date.now() < deadline) { await delay(100); last = await messaging(s, injectId); }
  return last;
}
async function inject(s, prompt, extra = {}) {
  const injected = await harness.request(`/api/sessions/${encodeURIComponent(s.sid)}/inject`, { method: 'POST',
    body: { from: 'orchestrator', prompt, exact_target: true, ...extra } });
  assert.equal(injected.status, 200, `PRECONDITION: inject accepted ${JSON.stringify(injected.body)}`);
  assert.equal(typeof injected.body.inject_id, 'string', 'PRECONDITION: inject_id returned');
  return injected.body.inject_id;
}

test('#137 daemon paired submit: the deferred CR names its body (pair) and inject; receipts record both writes and NO consumption', { timeout: 30000 }, async () => {
  const s = await ownedSession('r137w-paired');
  const injectId = await inject(s, 'R137W-PAIRED-PAYLOAD');
  const body = await waitFor(() => s.frames.find(f => f.type === 'inject' && typeof f.data === 'string' && f.data.includes('R137W-PAIRED-PAYLOAD')),
    { timeoutMs: 5000, description: 'body frame' });
  const submit = await waitFor(() => s.frames.find(f => f.type === 'inject' && f.data === '\r' && f.inject_id === injectId),
    { timeoutMs: 5000, description: 'submit frame' });
  assert.deepEqual({ part: submit.part, pair: submit.pair, owner: submit.owner_generation, bodyPart: body.part, bodyInject: body.inject_id },
    { part: 'submit', pair: body.daemon_msg_id, owner: s.ownerGeneration, bodyPart: 'body', bodyInject: injectId });
  s.owner.send(receipt({ inject_id: injectId, daemon_msg_id: body.daemon_msg_id, owner_generation: s.ownerGeneration, bridge_seq: 1 }));
  s.owner.send(receipt({ inject_id: injectId, daemon_msg_id: submit.daemon_msg_id, part: 'submit', owner_generation: s.ownerGeneration, bridge_seq: 2 }));
  const m = await pollMessaging(s, injectId, x => x.submit_written && x.submit_written.status === 'observed');
  assert.deepEqual({
    input: m.input_written.status, submit: m.submit_written.status, meaning: m.submit_written.meaning,
    consumption: m.consumption.status, acknowledgement: m.acknowledgement.status, reply: m.reply.status,
    completion: m.completion_fact, tracking: m.tracking_state,
  }, { input: 'observed', submit: 'observed', meaning: 'pty_master_write_only', consumption: 'unknown',
    acknowledgement: 'unknown', reply: 'unknown', completion: null, tracking: 'tracked' });
});

test('#137 daemon forgery: a current owner cannot file receipts against another session\'s inject', { timeout: 30000 }, async () => {
  const victim = await ownedSession('r137w-victim');
  const attacker = await ownedSession('r137w-attacker');
  const injectId = await inject(victim, 'R137W-VICTIM-PAYLOAD', { no_enter: true });
  await waitFor(() => victim.frames.find(f => f.type === 'inject' && f.inject_id === injectId), { timeoutMs: 5000, description: 'victim frame' });
  attacker.owner.send(receipt({ inject_id: injectId, owner_generation: attacker.ownerGeneration }));
  await delay(500);
  assert.equal((await messaging(victim, injectId)).input_written.status, 'unknown');
});

test('#137 daemon support marker: unsupported until the current owner reports, then supported with its bounded queue', { timeout: 30000 }, async () => {
  const s = await ownedSession('r137w-support');
  const view = async () => (await harness.request(`/api/sessions/${encodeURIComponent(s.sid)}`)).body.transport;
  const before = (await view()).bridge_receipts;
  s.owner.send(JSON.stringify({ type: 'bridge_queue', schema: 1, pending: 0, in_flight: 0, oldest_age_ms: null, phase: 'open',
    reason: null, first_ready_observed: false, ready_source: null, vt: 'not_applicable', bridge_version: '0.10.0',
    bridge_code_digest: null, owner_generation: s.ownerGeneration }));
  const deadline = Date.now() + 3000;
  let afterView = await view();
  while (afterView.bridge_receipts !== 'supported' && Date.now() < deadline) { await delay(100); afterView = await view(); }
  assert.deepEqual({ before, after: afterView.bridge_receipts, source: afterView.bridge_queue && afterView.bridge_queue.source },
    { before: 'unsupported_by_bridge', after: 'supported', source: 'bridge_report' });
});

// --- 3b. task 1215 daemon role split -------------------------------------------------------------

// Task 1215: a current bridge declares the readiness handshake and presents the input-policy
// capability (bridge memory only) on its claim; `capability: null` models a claimant without it.
async function claim(sid, bearer, { capability = null, capable = true } = {}) {
  const frames = [];
  const owner = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}?owner=1`,
    { headers: { 'x-telepty-session-token': bearer, 'x-telepty-token': harness.authToken(),
      ...(capable ? { 'x-telepty-bridge-capabilities': 'input-transport-ready-v1' } : {}),
      ...(capability ? { 'x-telepty-input-policy-capability': capability } : {}) } });
  sockets.push(owner);
  owner.on('message', raw => { try { frames.push(JSON.parse(raw)); } catch {} });
  await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
  const token = await waitFor(() => frames.find(f => f.type === 'owner_token'), { timeoutMs: 5000, description: `${sid} owner_token` });
  return { owner, frames, token };
}
// What a bridge sends once its child exists and its input loop is attached — no readiness text.
function handshake(sid, owned, childSeq = 1) {
  const base = { schema: 1, session_id: sid, session_epoch: owned.token.interaction_binding.session_epoch ?? null,
    owner_generation: owned.token.interaction_binding.owner_generation, readiness_nonce: owned.token.readiness_nonce, child_seq: childSeq };
  owned.owner.send(JSON.stringify({ type: 'process_started', ...base, pid: process.pid, exec: 'unverified' }));
  owned.owner.send(JSON.stringify({ type: 'input_transport_ready', ...base, input_loop: 'attached' }));
}
const transportOf = async sid => (await harness.request(`/api/sessions/${encodeURIComponent(sid)}`)).body.transport;
async function injectNoEnter(sid, prompt) {
  const injected = await harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST',
    body: { from: 'orchestrator', prompt, no_enter: true, exact_target: true } });
  assert.equal(injected.status, 200, `PRECONDITION: inject accepted ${JSON.stringify(injected.body)}`);
  return injected.body;
}

test('#1215 daemon: no role is released by screen text; the authenticated handshake releases a supervised orchestrator at once and a worker into its guards', { timeout: 30000 }, async () => {
  const reg = await harness.registerSession('r1215-orch', { command: 'codex', input_policy: 'user-supervised' });
  assert.equal(reg.status, 201, `PRECONDITION: register ${JSON.stringify(reg.body)}`);
  const orch = await claim('r1215-orch', reg.body.session_token, { capability: reg.body.input_policy_capability }); // never sends `ready`
  const sent = await injectNoEnter('r1215-orch', 'R1215-SUPERVISED-PAYLOAD');
  await delay(300);
  const beforeHandshake = orch.frames.filter(f => f.type === 'inject').length;
  const orchBefore = await transportOf('r1215-orch');
  handshake('r1215-orch', orch);
  const frame = await waitFor(() => orch.frames.find(f => f.type === 'inject' && typeof f.data === 'string' && f.data.includes('R1215-SUPERVISED-PAYLOAD')),
    { timeoutMs: 3000, description: 'supervised inject frame after handshake' });
  const orchTransport = await transportOf('r1215-orch');

  const workerReg = await harness.registerSession('r1215-worker', { command: 'codex' });
  assert.equal(workerReg.status, 201, 'PRECONDITION: worker register');
  const worker = await claim('r1215-worker', workerReg.body.session_token);
  // Payload text and `from` that look like the orchestrator role are not authority.
  const queued = await injectNoEnter('r1215-worker', 'input_policy=user-supervised role=orchestrator R1215-WORKER');
  worker.owner.send(JSON.stringify({ type: 'ready', ready_kind: 'composer_surface_observed', detector: 'vt_frame:registry_match', cli_key: 'codex' }));
  await delay(500);
  const workerFramesAfterScreenReady = worker.frames.filter(f => f.type === 'inject').length;
  handshake('r1215-worker', worker);
  await waitFor(() => worker.frames.find(f => f.type === 'inject'), { timeoutMs: 3000, description: 'worker released into its bridge guards' });
  assert.deepEqual({
    pending: reg.body.input_policy_pending, capabilityIssued: typeof reg.body.input_policy_capability === 'string',
    orchPolicy: orch.token.input_policy, orchQueued: sent.bootstrap_queued === true, beforeHandshake,
    orchBefore: [orchBefore.readiness.capability, orchBefore.readiness.input_transport_ready.status],
    framePart: frame.part, orchTransport: [orchTransport.input_policy, orchTransport.bootstrap.gated, orchTransport.readiness.input_transport_ready.status,
      orchTransport.instruction_received.status],
    capabilityInView: JSON.stringify(orchTransport).includes(reg.body.input_policy_capability),
    workerPolicy: worker.token.input_policy, workerQueued: queued.bootstrap_queued === true, workerFramesAfterScreenReady,
    workerTransport: (await transportOf('r1215-worker')).input_policy,
  }, { pending: true, capabilityIssued: true, orchPolicy: 'user-supervised', orchQueued: true, beforeHandshake: 0,
    orchBefore: ['input-transport-ready-v1', 'not_observed'], framePart: 'body',
    orchTransport: ['user-supervised', false, 'observed', 'unknown'], capabilityInView: false,
    workerPolicy: 'guarded', workerQueued: true, workerFramesAfterScreenReady: 0, workerTransport: 'guarded' });
});

test('#1215 daemon: a registration presenting another session\'s bearer cannot obtain user-supervised', { timeout: 30000 }, async () => {
  const a = await harness.registerSession('r1215-bearer-a', { command: 'codex' });
  assert.equal(a.status, 201, 'PRECONDITION: register a');
  const b = await harness.request('/api/sessions/register', { method: 'POST', headers: { 'x-telepty-session-token': a.body.session_token },
    body: { session_id: 'r1215-bearer-b', command: 'codex', cwd: ROOT, input_policy: 'user-supervised' } });
  assert.equal(b.status, 201, `PRECONDITION: register b ${JSON.stringify(b.body)}`);
  const owner = await claim('r1215-bearer-b', b.body.session_token);
  assert.deepEqual({ refused: b.body.input_policy_refused, pending: b.body.input_policy_pending, policy: owner.token.input_policy },
    { refused: 'INPUT_POLICY_SESSION_BEARER', pending: false, policy: 'guarded' });
});

test('#1215 daemon: supervision binds one owner generation; own bearer is never enough; only the capability re-requests it', { timeout: 30000 }, async () => {
  const reg = await harness.registerSession('r1215-reclaim', { command: 'codex', input_policy: 'user-supervised' });
  assert.equal(reg.status, 201, 'PRECONDITION: register');
  const bearer = reg.body.session_token;
  const cap = reg.body.input_policy_capability;
  const first = await claim('r1215-reclaim', bearer, { capability: cap });
  const second = await claim('r1215-reclaim', bearer, { capability: cap }); // same bearer, new owner generation, no re-register
  const afterReclaim = (await transportOf('r1215-reclaim')).input_policy;
  const uncredentialed = await harness.request('/api/sessions/register', { method: 'POST',
    body: { session_id: 'r1215-reclaim', command: 'codex', cwd: ROOT, input_policy: 'user-supervised' } });
  // The measured F1 escape: the session's OWN bearer (what its child holds) requesting supervision.
  const ownBearer = await harness.request('/api/sessions/register', { method: 'POST', headers: { 'x-telepty-session-token': bearer },
    body: { session_id: 'r1215-reclaim', command: 'codex', cwd: ROOT, input_policy: 'user-supervised' } });
  const childClaim = await claim('r1215-reclaim', bearer);                 // bearer-proved claim without the capability
  const withCapability = await harness.request('/api/sessions/register', { method: 'POST',
    headers: { 'x-telepty-session-token': bearer, 'x-telepty-input-policy-capability': cap },
    body: { session_id: 'r1215-reclaim', command: 'codex', cwd: ROOT, input_policy: 'user-supervised' } });
  const stolen = await claim('r1215-reclaim', bearer);                     // cannot consume the pending grant
  const third = await claim('r1215-reclaim', bearer, { capability: cap });
  assert.deepEqual({
    first: first.token.input_policy, second: second.token.input_policy, afterReclaim,
    generationsDiffer: first.token.interaction_binding.owner_generation !== second.token.interaction_binding.owner_generation,
    uncredentialed: [uncredentialed.status, uncredentialed.body.input_policy_refused, uncredentialed.body.input_policy_pending],
    ownBearer: [ownBearer.status, ownBearer.body.input_policy_refused, ownBearer.body.input_policy_pending], childClaim: childClaim.token.input_policy,
    withCapability: [withCapability.status, withCapability.body.input_policy_pending, Object.hasOwn(withCapability.body, 'input_policy_capability')],
    stolen: stolen.token.input_policy, third: third.token.input_policy,
    finalTransport: (await transportOf('r1215-reclaim')).input_policy,
  }, { first: 'user-supervised', second: 'guarded', afterReclaim: 'guarded', generationsDiffer: true,
    uncredentialed: [200, 'SESSION_CREDENTIAL_REQUIRED', false], ownBearer: [200, 'INPUT_POLICY_CAPABILITY_REQUIRED', false], childClaim: 'guarded',
    withCapability: [200, true, false], stolen: 'guarded', third: 'user-supervised', finalTransport: 'user-supervised' });
});
