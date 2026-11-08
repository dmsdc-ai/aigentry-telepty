'use strict';

// Task 1215 hotfix 0.10.1 (hotfix463) — complete immediate body + single-Enter delivery.
// Written BEFORE the production change, and the coder did not execute it. The tester runs it: RED on gate453, GREEN on the candidate.
//
// Real production seams, with no mirrored gate logic:
//   - bridge: createAllowSecurityContext + handleOwnerInject (the owner-WS inject handler cli.js calls), subscribeChild,
//     the bridge tick/flush, the real FileMailbox, the real prompt registry, bridge-flush-filter and SessionScreen/VT;
//   - daemon: the real createSessionActions /inject + /submit route handlers, the real createDeliveryRuntime
//     (terminalLevelSubmit/submitViaPty/bootstrap queue/modal gate/tracked ledger), the real createSessionDeliveryContext
//     and DeliveryEngine, the real readiness-handshake milestone validation;
//   - CLI: describeImmediateSubmit (src/cli/security-actions.js), the formatter cli.js uses for the --submit outcome.
// Declared fakes: the bridge clock/timers, child doubles, the owner-WS objects (frame recorders, optionally routed into a
// REAL bridge context), the 80x24 stdout, and submit-gate spies that pass through to the real functions so the waits can be counted.
// No listener, network, provider, native PTY or model.
// "PRECONDITION:" means the setup is invalid (an INVALID run), not a product finding.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const load = rel => require(path.join(ROOT, rel));
const security = load('src/cli/security-actions.js');
const registry = load('src/prompt-symbol-registry.js');
const { FileMailbox } = load('src/mailbox/index.js');
const flushFilter = load('src/mailbox/bridge-flush-filter.js');
const { getTerminalSize } = load('interactive-terminal.js');
const runtimeModule = load('src/mailbox/delivery-runtime.js');
const readinessHandshake = load('src/transport/readiness-handshake.js');

const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'bridge-136');
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
const OWNER_GENERATION = 'owner-gen-463-current';
const CAPABILITY_HEADER_VALUE = 'input-transport-ready-v1, immediate-submit-v1';

// ── bridge harness (real security-actions context) ───────────────────────────────────────────────────────────────
function createClock() {
  let now = Math.floor((Date.now() - 3 * 3600 * 1000) / 1000) * 1000;
  let seq = 0; let fired = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), every: 0 }); return id; },
    clearTimeout(id) { if (id != null) timers.delete(id); },
    setInterval(fn, ms) { const id = ++seq; const d = Math.max(1, Number(ms) || 1); timers.set(id, { fn, at: now + d, every: d }); return id; },
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
    pid: 4600 + log.length, name, writes: [], attempts: 0, throwOn: null,
    write(data) {
      child.attempts++;
      if (child.throwOn && child.throwOn(data)) { child.throwOn = null; throw Object.assign(new Error('EIO fixture write'), { code: 'EIO' }); }
      child.writes.push(String(data)); log.push([name, String(data)]);
    },
    resize() {}, kill() { throw new Error('PRECONDITION: native kill is not part of this fixture'); },
    onData(fn) { handlers.data = fn; }, onExit(fn) { handlers.exit = fn; },
    emit(data) { if (handlers.data) handlers.data(data); },
    exit(event = { exitCode: 1 }) { if (handlers.exit) handlers.exit(event); },
  };
  return child;
}

function createBridge(t, { sid, command = 'codex', bridgeRoot = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-463-'));
  const mailboxRoot = bridgeRoot || path.join(root, 'bridge');
  const clock = createClock();
  const log = []; const sends = [];
  const stdout = { columns: 80, rows: 24, isTTY: true, write() { return true; } };
  const child = childDouble(log, 'child-0');
  const shared = {
    sessionId: sid, command, cmdArgs: [], sshPlan: null, child, handoffPending: null, idleTtl: null,
    detectedBackend: 'fixture', terminalProgram: 'fixture', terminalType: 'xterm-256color',
    DAEMON_URL: 'http://127.0.0.1:9', fetchWithAuth: () => Promise.reject(new Error('no network in fixture')),
    sessionCwd: root, sessionEnv: {}, bridgeTarget: sid, bridgeMsgSeq: 0, bridgePendingCount: 0,
    promptReady: false, lastUserInputTime: 0, IDLE_THRESHOLD: 2000,
    knownAiCli: registry.isKnownAiCli(command), outputTail: '', readyRegistry: registry, readyQualification: null,
    promptPattern: /[❯>$#%]\s*$/, firstReadyObserved: false, queueFlushTimer: null, idleCheckTimer: null,
    reconnectTimer: null, heartbeatTimer: null,
    filterBridgeBatch: flushFilter.filterBridgeBatch, bridgeInjectTtlSecs: flushFilter.bridgeInjectTtlSecs,
    interactionBinding: { sid, session_epoch: 'epoch-463', credential_generation: 1,
      owner_generation: OWNER_GENERATION, input_generation: 0, geometry_generation: 0 },
    wsReady: true,
    daemonWs: { readyState: 1, send(raw) { sends.push(JSON.parse(String(raw))); }, close() {} },
    getTerminalSize, allowSessionClosed: false, cleanupTerminal() {}, currentOwnerToken: 'synthetic-owner-token',
    allowSignalHandlers: new Map(), FileMailbox, path, os,
  };
  const allow = security.createAllowSecurityContext(shared, {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    getStdout: () => stdout, removeSignalHandler() {},
    spawnPty() { throw new Error('PRECONDITION: no respawn in this fixture'); },
    bridgeRoot: mailboxRoot,
  });
  shared.bridgeMailbox = allow.createBridgeMailbox();
  const relay = allow.createOutputRelay({
    onInteraction: () => { shared.interactionBinding.input_generation++; },
    onBytes: () => {}, rewrite: d => d, write: () => {}, sendOutput: () => {},
    observeReady: d => allow.observePromptReady(d),
    onReady: () => { shared.promptReady = true; shared.firstReadyObserved = true; allow.flushBridgeMailbox(); },
  });
  allow.subscribeChild(child, relay, () => {});
  function feed(stream, chunk = 1024) { for (let i = 0; i < stream.length; i += chunk) child.emit(stream.slice(i, i + chunk)); }
  // The production owner-WS handler; a throw escapes exactly as it does into cli.js handleOwnerMessage's catch.
  function frame(msg) { return allow.handleOwnerInject(msg); }
  let seq = 0;
  function pair(text, generation = OWNER_GENERATION) {
    seq++;
    const injectId = `00000000-0000-4463-8000-${String(seq).padStart(12, '0')}`;
    const body = { type: 'inject', data: text, daemon_msg_id: `dm463-${seq}-body`, inject_id: injectId, part: 'body', owner_generation: generation };
    const submit = { type: 'inject', data: '\r', daemon_msg_id: `dm463-${seq}-submit`, inject_id: injectId, part: 'submit',
      pair: body.daemon_msg_id, owner_generation: generation };
    return { injectId, body, submit };
  }
  // A /submit CR exactly as submitViaPty builds it: a fresh terminal-level id, the inject_id and (optionally) the pair.
  function terminalCr(injectId, { pairId = null, generation = OWNER_GENERATION } = {}) {
    return { type: 'inject', data: '\r', daemon_msg_id: `submit:${crypto.randomUUID()}`,
      ...(injectId ? { inject_id: injectId } : {}), part: 'submit', ...(pairId ? { pair: pairId } : {}), owner_generation: generation };
  }
  const receipts = () => sends.filter(m => m.type === 'bridge_receipt');
  const refused = () => receipts().filter(r => r.stage === 'refused').map(r => ({ id: r.daemon_msg_id, reason: r.reason, certainty: r.certainty }));
  t.after(() => {
    try { allow.closeAllowSession({ destroySession: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { shared, allow, clock, child, log, sends, feed, frame, pair, terminalCr, receipts, refused, mailboxRoot };
}
const typing = b => { b.shared.lastUserInputTime = b.clock.now(); };

// ── bridge: single CR per inject_id / pair per owner generation ──────────────────────────────────────────────────

test('463 bridge: busy output, body + CR written at once; a repeated /submit CR for the same inject_id is refused duplicate_submit:written, never written twice', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b463-dup-written' });
  b.feed(BUSY);
  await settleVt();
  const p = b.pair('B463-DUP');
  b.frame(p.body);
  b.frame(p.submit);
  const atOnce = b.child.writes.slice();
  const repeat = b.terminalCr(p.injectId);                       // repeated API call: new daemon_msg_id, same inject_id
  const pairOnly = b.terminalCr(null, { pairId: p.body.daemon_msg_id }); // same pair, no inject_id
  b.frame(repeat);
  b.frame(pairOnly);
  b.feed(BUSY);
  await b.clock.advance(20000);
  assert.deepEqual({ atOnce, writes: b.child.writes, attempts: b.child.attempts, refused: b.refused() }, {
    atOnce: ['B463-DUP', '\r'], writes: ['B463-DUP', '\r'], attempts: 2,
    refused: [
      { id: repeat.daemon_msg_id, reason: 'duplicate_submit:written', certainty: 'not_written' },
      { id: pairOnly.daemon_msg_id, reason: 'duplicate_submit:written', certainty: 'not_written' },
    ],
  });
});

test('463 bridge: a duplicate CR that arrives while the first is still queued (local typing) is refused duplicate_submit:admitted; exactly one CR drains', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b463-dup-queued' });
  const p = b.pair('B463-QUEUED');
  typing(b);
  b.frame(p.body);
  b.frame(p.submit);
  const dup = b.terminalCr(p.injectId, { pairId: p.body.daemon_msg_id });
  b.frame(dup);
  const whileTyping = { writes: b.child.writes.slice(), pending: b.shared.bridgePendingCount };
  await b.clock.advance(3000);
  for (let i = 0; i < 3; i++) b.allow.flushBridgeMailbox();
  await b.clock.advance(3000);
  assert.deepEqual({ whileTyping, writes: b.child.writes, refused: b.refused() }, {
    whileTyping: { writes: [], pending: 2 },
    writes: ['B463-QUEUED', '\r'],
    refused: [{ id: dup.daemon_msg_id, reason: 'duplicate_submit:admitted', certainty: 'not_written' }],
  });
});

test('463 bridge: a CR whose child.write throws is receipted unknown/write_threw; a repeat is refused duplicate_submit:unknown and child.write is never called again', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b463-throw' });
  const p = b.pair('B463-THROW');
  b.frame(p.body);
  b.child.throwOn = data => data === '\r';
  assert.throws(() => b.frame(p.submit), /EIO fixture write/, 'the write error escapes to the owner-message handler, as before');
  const attemptsAfterThrow = b.child.attempts;
  const again = b.terminalCr(p.injectId, { pairId: p.body.daemon_msg_id });
  b.frame(again);
  await b.clock.advance(5000);
  const unknown = b.receipts().filter(r => r.stage === 'unknown').map(r => [r.daemon_msg_id, r.reason, r.certainty]);
  assert.deepEqual({ attemptsAfterThrow, attempts: b.child.attempts, writes: b.child.writes, unknown, refused: b.refused() }, {
    attemptsAfterThrow: 2, attempts: 2, writes: ['B463-THROW'],
    unknown: [[p.submit.daemon_msg_id, 'write_threw', 'unknown']],
    refused: [{ id: again.daemon_msg_id, reason: 'duplicate_submit:unknown', certainty: 'not_written' }],
  });
});

test('463 bridge: the single-CR guard is per owner generation; legacy id-less CRs are never deduped', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b463-generation' });
  const p = b.pair('B463-GEN');
  b.frame(p.body);
  b.frame(p.submit);
  b.frame(b.terminalCr(p.injectId, { generation: 'owner-gen-463-next' }));   // a NEW owner generation: one CR allowed
  const dupNext = b.terminalCr(p.injectId, { generation: 'owner-gen-463-next' });
  b.frame(dupNext);                                                              // ...and only one
  b.frame({ type: 'inject', data: '\r' });                                       // legacy terminal CR, no ids
  b.frame({ type: 'inject', data: '\r' });                                       // legacy terminal CR, no ids
  await b.clock.advance(3000);
  assert.deepEqual({ writes: b.child.writes, refused: b.refused() }, {
    writes: ['B463-GEN', '\r', '\r', '\r', '\r'],
    refused: [{ id: dupNext.daemon_msg_id, reason: 'duplicate_submit:written', certainty: 'not_written' }],
  });
});

test('463 bridge: a TRUE modal still holds body and CR; a duplicate CR is refused meanwhile; one CR drains when the composer returns', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b463-modal' });
  b.feed(MODAL);
  await settleVt();
  const p = b.pair('B463-MODAL');
  b.frame(p.body);
  b.frame(p.submit);
  const dup = b.terminalCr(p.injectId);
  b.frame(dup);
  await b.clock.advance(3000);
  const onModal = b.child.writes.slice();
  b.feed(IDLE);
  await settleVt();
  await b.clock.advance(3000);
  assert.deepEqual({ onModal, writes: b.child.writes, refused: b.refused() }, {
    onModal: [], writes: ['B463-MODAL', '\r'],
    refused: [{ id: dup.daemon_msg_id, reason: 'duplicate_submit:admitted', certainty: 'not_written' }],
  });
});

test('463 bridge restart custody: a previous bridge\'s pending body + CR are dead-lettered with payload and bridge msg_id, never written, never acked', { timeout: 30000 }, async t => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-463-custody-'));
  t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const bridgeRoot = path.join(shared, 'bridge');
  const sid = 'b463-custody';
  const first = createBridge(t, { sid, bridgeRoot });
  const p = first.pair('B463-CUSTODY');
  typing(first);
  first.frame(p.body);
  first.frame(p.submit);
  assert.equal(first.shared.bridgePendingCount, 2, 'PRECONDITION: body and CR queued in the first bridge');
  // The first bridge process disappears without exit custody (crash); a successor bridge starts on the same queue.
  const second = createBridge(t, { sid, bridgeRoot });
  second.allow.recoverBridgeMailbox();
  await second.clock.advance(5000);
  const dead = second.shared.bridgeMailbox.peekDeadLetter(sid);
  const queuedIds = first.receipts().filter(r => r.stage === 'queued').map(r => r.bridge_msg_id).sort();
  assert.deepEqual({ writes: second.child.writes, firstWrites: first.child.writes, pending: second.shared.bridgePendingCount,
    payloads: dead.map(d => d.payload).sort(), msgIds: dead.map(d => d.msg_id).sort(), reasons: dead.map(d => d.reason),
    states: dead.map(d => second.shared.bridgeMailbox.messageState(sid, d.msg_id)) }, {
    writes: [], firstWrites: [], pending: 0, payloads: ['B463-CUSTODY', '\r'].sort(), msgIds: queuedIds,
    reasons: ['recovered_previous_bridge', 'recovered_previous_bridge'], states: ['dead_letter', 'dead_letter'],
  });
  const quarantined = second.receipts().filter(r => r.stage === 'quarantined').map(r => [r.reason, r.certainty]);
  assert.deepEqual(quarantined, [['recovered_previous_bridge', 'not_written'], ['recovered_previous_bridge', 'not_written']]);
});

// ── capability binding (daemon side) and CLI declaration ─────────────────────────────────────────────────────────

test('463 capability: immediate-submit-v1 binds to the CURRENT owner generation only, and only with the negotiated handshake', () => {
  const { bindImmediateSubmitCapability, immediateSubmitSupport, IMMEDIATE_SUBMIT_CAPABILITY } = runtimeModule;
  assert.equal(IMMEDIATE_SUBMIT_CAPABILITY, 'immediate-submit-v1');
  const ws = { readyState: 1 };
  const session = { id: 'cap463', type: 'wrapped', interactionOwnerGeneration: 'gen-a', ownerWs: ws };
  const verdicts = {};
  readinessHandshake.beginOwnerGeneration(session, { capable: true });
  verdicts.declared = [bindImmediateSubmitCapability(session, CAPABILITY_HEADER_VALUE), immediateSubmitSupport(session)];
  session.interactionOwnerGeneration = 'gen-b';                    // a new owner claim: nothing carried over
  verdicts.staleGeneration = immediateSubmitSupport(session);
  readinessHandshake.beginOwnerGeneration(session, { capable: true });
  verdicts.oldBridge = [bindImmediateSubmitCapability(session, 'input-transport-ready-v1'), immediateSubmitSupport(session)];
  verdicts.oversize = bindImmediateSubmitCapability(session, `${'x'.repeat(300)}, immediate-submit-v1`);
  readinessHandshake.beginOwnerGeneration(session, { capable: false });
  verdicts.noHandshake = [bindImmediateSubmitCapability(session, 'immediate-submit-v1'), immediateSubmitSupport(session)];
  verdicts.ssh = immediateSubmitSupport({ ...session, sshRemote: { host: 'h' } });
  verdicts.spawned = immediateSubmitSupport({ id: 'x', type: 'spawned' });
  assert.deepEqual(verdicts, {
    declared: [true, 'supported'], staleGeneration: 'unsupported_by_bridge', oldBridge: [false, 'unsupported_by_bridge'],
    oversize: false, noHandshake: [true, 'unsupported_by_bridge'], ssh: 'not_applicable', spawned: 'not_applicable',
  });
});

test('463 capability wiring: websocket.js binds it at the single owner-generation mint; cli.js declares it on the owner socket', () => {
  const ws = fs.readFileSync(path.join(ROOT, 'src/transport/websocket.js'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');
  const mint = ws.indexOf('activeSession.interactionOwnerGeneration = crypto.randomUUID();');
  const begin = ws.indexOf('readinessHandshake.beginOwnerGeneration(activeSession');
  const bind = ws.indexOf('bindImmediateSubmitCapability(activeSession, req.headers[readinessHandshake.CAPABILITY_HEADER])');
  assert.deepEqual({ mint: mint > 0, begin: begin > mint, bind: bind > begin, mints: ws.split('interactionOwnerGeneration = crypto.randomUUID()').length - 1 },
    { mint: true, begin: true, bind: true, mints: 1 });
  assert.ok(cli.includes("'x-telepty-bridge-capabilities': require('./src/transport/readiness-handshake').CAPABILITY + ', ' + require('./src/mailbox/delivery-runtime').IMMEDIATE_SUBMIT_CAPABILITY"),
    'the bridge declares immediate-submit-v1 next to input-transport-ready-v1');
});

// ── CLI honest stage ─────────────────────────────────────────────────────────────────────────────────────────────

test('463 CLI: describeImmediateSubmit reports the actual stage; legacy responses fall through unchanged', () => {
  const d = security.describeImmediateSubmit;
  assert.equal(typeof d, 'function');
  assert.equal(d(200, { success: true, strategy: 'pty_cr' }), null, 'legacy daemon response: existing formatting');
  assert.equal(d(504, { reason: 'timeout' }), null);
  const sent = d(200, { success: true, immediate_submit: true, submit_stage: 'sent_to_bridge', consumption: 'unknown', strategy: 'pty_cr' }, { injectId: 'abc' });
  const queued = d(200, { success: true, immediate_submit: true, submit_stage: 'queued', parked: 'surface_modal', reason: 'claude_modal_ui', strategy: 'bootstrap_queue' });
  const notWritten = d(504, { immediate_submit: true, submit_stage: 'not_written', reason: 'bootstrap_not_ready' });
  const unknown = d(500, { immediate_submit: true, submit_stage: 'unknown', error: 'bootstrap submit failed' });
  assert.deepEqual([sent.failed, queued.failed, notWritten.failed, unknown.failed], [false, false, true, true]);
  assert.match(sent.text, /sent_to_bridge/);
  assert.match(sent.text, /consumption=unknown/);
  assert.match(queued.text, /QUEUED/);
  assert.match(notWritten.text, /NOT written/);
  assert.match(notWritten.text, /bootstrap_not_ready/);
  assert.match(unknown.text, /unknown/);
  for (const r of [sent, queued, notWritten, unknown]) {
    assert.doesNotMatch(r.text, /gated-timeout/, 'never "gated-timeout" for an immediate response');
    assert.doesNotMatch(r.text, /--submit-force|send-key/, 'no forced-Enter instruction');
  }
  const cli = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');
  assert.ok(cli.includes('describeImmediateSubmit('), 'cli.js inject --submit uses the formatter');
});

// ── daemon harness (real routes + runtime + delivery context + ledger) ────────────────────────────────────────────
let H = null;
function isOpenWebSocket(ws) { return Boolean(ws && ws.readyState === 1); }

async function compose() {
  const { createDeliveryRuntime } = runtimeModule;
  const { createSessionDeliveryContext } = load('src/mailbox/session-delivery.js');
  const { createSessionActions } = load('src/routes/session-actions.js');
  const inputPolicy = load('src/mailbox/input-policy.js');
  const sessionPersistence = load('src/session-store/persistence.js');
  const metadata = load('src/session-store/route-metadata.js');
  const { createCredentialStore } = load('src/session-store/session-credentials.js');
  const { DeliveryEngine } = load('src/mailbox/delivery.js');
  const { applyProvenance } = load('src/audit/provenance.js');
  const { SessionStateManager, stripAnsi } = load('session-state.js');
  const { createLedgerClient } = load('src/session-store/ledger-client.js');
  const interaction = load('src/interaction.js');
  const realGate = load('src/submit-gate.js');
  const { CAPABILITY_STAGE_A } = load('src/completion-observation.js');
  const { isProcessRunning } = load('daemon-control.js');

  // Pass-through spies: the route/runtime waits are counted, never replaced.
  const gateCalls = [];
  const submitGate = { ...realGate };
  for (const name of ['awaitPromptSymbol', 'awaitReplReady', 'awaitInputSettled', 'confirmSubmitAccepted', 'classifyInjectConsumption']) {
    submitGate[name] = (...args) => { gateCalls.push(name); return realGate[name](...args); };
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-463-daemon-'));
  const ledgerDir = path.join(root, 'tracked-injections.json');
  const ledgerClient = createLedgerClient({ dir: ledgerDir, lockPath: path.join(root, 'tracked-injections.lock'), legacyPath: ledgerDir });
  const sessions = Object.create(null);
  const pendingReports = Object.create(null);
  const busClients = new Set([{ readyState: 1, send() {} }]);
  const sessionStateManager = new SessionStateManager();
  const rshared = {
    sessions, crypto, fs, sessionPersistence, sessionCredentials: createCredentialStore(),
    auditWriter: { append() {} },
    ledgerClient, trackedLedgerHealthy: false, trackedLedgerUnavailableReason: 'not_opened',
    TRACKED_INJECTIONS_PATH: ledgerDir, pendingReports, busClients,
    interaction, interactionWaiters: new Map(), readyRegistry: registry, sessionStateManager,
    stripAnsiState: stripAnsi, submitGate, CAPABILITY_STAGE_A,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    initializeBootstrapState: metadata.initializeBootstrapState,
    isOpenWebSocket, isProcessRunning, PEER_INJECT_KINDS: new Set(['ask-request', 'ask-reply']),
    UPSTREAM_STALL_SECONDS: 30, SESSION_STALE_SECONDS: 60, WRAPPED_SUBMIT_DELAY_MS: 500,
    BOOTSTRAP_READY_TIMEOUT_MS: 30000,
    BRACKETED_PASTE_START: '\x1b[200~', BRACKETED_PASTE_END: '\x1b[201~',
    MODAL_RING_TAIL_BYTES: 65536, MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
    MODAL_REMEDY_BY_CLI: { claude: 'park' }, MODAL_REMEDY_DEFAULT: 'hold',
    MODAL_HINT_BY_CLI: { claude: 'Answer the blocking modal.', codex: 'Dismiss the update modal.' },
    MODAL_HOLD_DEFAULT_MS: 30000, MODAL_PARK_TTL_DEFAULT_MS: 600000, MODAL_PARK_POLL_MS: 500,
  };
  const runtime = createDeliveryRuntime(rshared);
  rshared.interactionCore = runtime.createInteractionRuntime();
  const opened = await runtime.restoreTrackedInjections();
  assert.equal(opened && opened.ok, true, `PRECONDITION: private ledger opens ${JSON.stringify(opened)}`);
  const mailbox = new FileMailbox({ root: path.join(root, 'mailbox') });
  let engine;
  const context = createSessionDeliveryContext({ ...runtime, sessions, crypto, applyProvenance, interaction,
    isOpenWebSocket, DELIVERY_TIMEOUT_MS: 1000,
    getMailbox: () => mailbox, getMailboxDelivery: () => engine,
    getMailboxNotifier: () => ({ notify() { throw new Error('PRECONDITION: wrapped fixture must not notify UDS'); } }) });
  rshared.writeDataToSession = context.writeDataToSession;
  engine = new DeliveryEngine(mailbox, context.mailboxDeliveryOptions);
  const ashared = {
    ...runtime,
    sessions, pendingReports, busClients, crypto, ledgerClient, sessionStateManager, stripAnsiState: stripAnsi,
    submitGate, readyRegistry: registry, sessionPersistence,
    deliverInjectionToSession: context.deliverInjectionToSession,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    isOpenWebSocket,
    resolveSessionAlias: id => (typeof id === 'string' && Object.hasOwn(sessions, id) ? id : null),
    ORCHESTRATOR_SIDS: [], MACHINE_ID: 'd463-fixture-machine',
    NON_TERMINAL_GATE_REASONS: new Set(['timeout', 'no_state', 'no_state_manager', 'busy_settled']),
    SUBMIT_BUSY_DISPATCH_ENABLED: true, SUBMIT_BUSY_GRACE_MS: 250,
    REDELIVER_ENABLED: true, REDELIVER_MAX_ATTEMPTS: 3, REDELIVER_TOTAL_TIMEOUT_MS: 600000, REDELIVER_IDLE_WAIT_MS: 120000,
    CAPABILITY_STAGE_A, deliveredAbsenceIdentities: new WeakMap(),
  };
  const actions = createSessionActions(ashared, {});
  const routes = Object.create(null);
  const app = { post(route, handler) { routes[route] = handler; } };
  actions.registerSubmitRoute(app);
  actions.registerInjectRoute(app);
  assert.equal(typeof routes['/api/sessions/:id/submit'], 'function', 'PRECONDITION: submit route registered');

  // Owner socket: records every frame; with `bridge` set, inject frames go to a REAL bridge context exactly as
  // cli.js handleOwnerMessage does (a throw is swallowed by its catch).
  function ownerSocket() {
    const ws = { readyState: 1, frames: [], bridge: null,
      send(raw) { const msg = JSON.parse(raw); ws.frames.push(msg);
        if (ws.bridge && msg.type === 'inject') { try { ws.bridge.handleOwnerInject(msg); } catch {} } } };
    return ws;
  }
  function claimOwner(session, ws, { supervised }) {
    if (supervised) {
      const capability = inputPolicy.mintInputPolicyCapability(session);
      inputPolicy.requestInputPolicy(session, 'user-supervised', 'operator_principal_registration', new Date(), { origin: 'new_instance' });
      session.ownerWs = ws; session.clients.add(ws);
      session.interactionOwnerGeneration = crypto.randomUUID();
      inputPolicy.bindInputPolicy(session, new Date(), { capability });
      assert.equal(inputPolicy.userSupervised(session), true, 'PRECONDITION: supervised for this owner generation');
    } else {
      session.ownerWs = ws; session.clients.add(ws);
      session.interactionOwnerGeneration = crypto.randomUUID();
    }
  }
  // websocket.js owner claim order: mint generation -> beginOwnerGeneration -> bindImmediateSubmitCapability.
  function negotiate(session, { capable, header }) {
    readinessHandshake.beginOwnerGeneration(session, { capable });
    runtimeModule.bindImmediateSubmitCapability(session, header);
  }
  function transportReady(session) {
    const base = { schema: 1, session_id: session.id, session_epoch: session.sessionEpoch, owner_generation: session.interactionOwnerGeneration,
      readiness_nonce: session.transportReadiness.nonce, child_seq: 1 };
    const started = readinessHandshake.acceptMilestone(session.id, session, { type: 'process_started', ...base, pid: 4242, exec: 'unverified' });
    const ready = readinessHandshake.acceptMilestone(session.id, session, { type: 'input_transport_ready', ...base, input_loop: 'attached' });
    assert.deepEqual([started.ok, ready.ok], [true, true], `PRECONDITION: milestones accepted ${JSON.stringify([started, ready])}`);
    runtime.markBootstrapReady(session.id, session, 'input_transport_ready');
  }
  function registerSession(sid, { command = 'claude', supervised = true, capable = true, header = CAPABILITY_HEADER_VALUE, ready = true } = {}) {
    const ws = ownerSocket();
    const epoch = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const session = { id: sid, type: 'wrapped', command, clients: new Set(), ownerWs: null,
      sessionEpoch: epoch, sessionEpochProved: epoch, credentialGeneration: 1,
      outputRing: [], outputRingTotalBytes: 0, createdAt: nowIso, lastActivityAt: nowIso, lastConnectedAt: nowIso };
    sessions[sid] = session;
    claimOwner(session, ws, { supervised });
    negotiate(session, { capable, header });
    metadata.initializeBootstrapState(session);
    sessionStateManager.register(sid);
    if (capable && ready) transportReady(session);
    return session;
  }
  function call(route, sid, body) {
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(code) { res.statusCode = code; return res; }, json(payload) { resolve({ status: res.statusCode, body: payload }); return res; } };
      Promise.resolve(routes[route]({ params: { id: sid }, body, headers: {}, query: {} }, res)).catch(reject);
    });
  }
  async function inject(sid, prompt) {
    const r = await call('/api/sessions/:id/inject', sid, { prompt, no_enter: true, from: 'fixture-sender' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.status, 200, `PRECONDITION: inject accepted ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.inject_id), /^[a-f0-9-]{36}$/, 'PRECONDITION: inject_id returned');
    const bodyFrames = sessions[sid].ownerWs.frames.filter(f => f.type === 'inject' && f.inject_id === r.body.inject_id && f.part === 'body');
    assert.equal(bodyFrames.length, 1, 'PRECONDITION: exactly one body frame handed to the owner');
    return { injectId: r.body.inject_id, bodyFrame: bodyFrames[0] };
  }
  async function submit(sid, body) {
    const ws = sessions[sid].ownerWs;
    const seen = ws.frames.length; const calls = gateCalls.length;
    const started = Date.now();
    const r = await call('/api/sessions/:id/submit', sid, body);
    return { response: r, elapsedMs: Date.now() - started, crFrames: () => ws.frames.slice(seen).filter(f => f.type === 'inject' && f.data === '\r'),
      gateCalls: () => gateCalls.slice(calls) };
  }
  async function dispose() {
    try { engine.stop(); } catch {}
    for (const [id, session] of Object.entries(sessions)) {
      try { runtime.cancelModalParkPoll(session); } catch {}
      if (session.bootstrapOptimisticTimer) { clearTimeout(session.bootstrapOptimisticTimer); session.bootstrapOptimisticTimer = null; }
      if (session.inputTransportTimer) { clearTimeout(session.inputTransportTimer); session.inputTransportTimer = null; }
      try { sessionStateManager.unregister(id); } catch {}
    }
    try { sessionStateManager.destroyAll(); } catch {}
    try { await ledgerClient.close(2000); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { sessions, runtime, registerSession, negotiate, transportReady, claimOwner, ownerSocket, inject, submit, call, dispose, gateCalls, sessionStateManager,
    engine: () => engine,   // hotfix480: the REAL DeliveryEngine (never started: ticks come from /inject or the test)
    mailbox: () => mailbox };   // hotfix492: the REAL FileMailbox (its config bounds are set per test and restored)
}

before(async () => { H = await compose(); }, { timeout: 20000 });
after(async () => { if (H) await H.dispose(); }, { timeout: 20000 });

const WAITS = ['awaitPromptSymbol', 'awaitReplReady', 'awaitInputSettled', 'confirmSubmitAccepted', 'classifyInjectConsumption'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('463 daemon fast path: a capable bridge on a BUSY session gets exactly one CR at once, paired to its body; no prompt/REPL/settle wait, no confirm retry, no redeliver', { timeout: 30000 }, async () => {
  const sid = 'd463-fast';
  H.registerSession(sid);
  H.sessionStateManager.feed(sid, 'Working (12s • esc to interrupt)\r\n');
  const { injectId, bodyFrame } = await H.inject(sid, 'D463-FAST body');
  const s = await H.submit(sid, { injected_body: 'D463-FAST body', retries: 3, retry_delay_ms: 500, inject_id: injectId });
  await sleep(1500);   // a redeliver/retry loop would emit another CR inside this window
  const cr = s.crFrames();
  assert.equal(s.response.status, 200, JSON.stringify(s.response.body));
  assert.deepEqual({ immediate: s.response.body.immediate_submit, stage: s.response.body.submit_stage, attempts: s.response.body.attempts,
    consumption: s.response.body.consumption, confirmed: s.response.body.submit_confirmed, strategy: s.response.body.strategy,
    crs: cr.length, crIds: cr.map(f => [f.inject_id, f.pair, f.part]), waits: s.gateCalls().filter(n => WAITS.includes(n)) }, {
    immediate: true, stage: 'sent_to_bridge', attempts: 1, consumption: 'unknown', confirmed: false, strategy: 'pty_cr',
    crs: 1, crIds: [[injectId, bodyFrame.daemon_msg_id, 'submit']], waits: [],
  });
  assert.ok(s.elapsedMs < 1000, `the CR is handed over without any multi-second wait (${s.elapsedMs} ms)`);
  assert.equal(H.runtime.buildSessionTransportBlock(H.sessions[sid]).immediate_submit, 'supported');
});

test('463 daemon + REAL bridge end to end: repeated /submit for one inject writes body then ONE CR into a working child', { timeout: 30000 }, async t => {
  const sid = 'd463-e2e';
  const session = H.registerSession(sid);
  const b = createBridge(t, { sid });
  b.shared.interactionBinding.owner_generation = session.interactionOwnerGeneration;
  b.feed(BUSY);
  await settleVt();
  session.ownerWs.bridge = b.allow;
  const { injectId } = await H.inject(sid, 'D463-E2E body');
  const first = await H.submit(sid, { injected_body: 'D463-E2E body', retries: 0, inject_id: injectId });
  // hotfix480 (VALIDATION469): crFrames() is an open-ended slice; observe the first call's effects once that call is over,
  // before the second call adds its own frame.
  const firstCrs = first.crFrames().length;
  const second = await H.submit(sid, { injected_body: 'D463-E2E body', retries: 0, inject_id: injectId });
  b.feed(BUSY);
  await b.clock.advance(5000);
  assert.deepEqual({ statuses: [first.response.status, second.response.status], daemonCrs: [firstCrs, second.crFrames().length],
    childCrs: b.child.writes.filter(w => w === '\r').length, bodyWritten: b.child.writes.filter(w => w.includes('D463-E2E body')).length,
    order: b.child.writes.map(w => (w === '\r' ? 'CR' : 'BODY')),
    dupReasons: b.refused().map(r => r.reason) }, {
    statuses: [200, 200], daemonCrs: [1, 1], childCrs: 1, bodyWritten: 1, order: ['BODY', 'CR'],
    dupReasons: ['duplicate_submit:written'],
  });
});

test('463 daemon force caller: same single attempt; force no longer bypasses the input-transport fence for a capable bridge', { timeout: 30000 }, async () => {
  const ready = 'd463-force';
  H.registerSession(ready);
  const forced = await H.submit(ready, { injected_body: 'D463-FORCE', retries: 3, force: true });
  await sleep(1200);
  const unwired = 'd463-force-unwired';
  H.registerSession(unwired, { ready: false });
  const fenced = await H.submit(unwired, { injected_body: 'D463-UNWIRED', retries: 0, force: true, gate_timeout_ms: 500 });
  await sleep(300);
  assert.deepEqual({
    forced: [forced.response.status, forced.response.body.immediate_submit, forced.response.body.forced, forced.response.body.attempts, forced.crFrames().length,
      forced.gateCalls().filter(n => WAITS.includes(n)).length],
    fenced: [fenced.response.status, fenced.response.body.submit_stage, fenced.response.body.reason, fenced.crFrames().length],
  }, {
    forced: [200, true, true, 1, 1, 0],
    fenced: [504, 'not_written', 'bootstrap_not_ready', 0],
  });
});

test('463 daemon unwired child: a capable bridge whose input transport is not ready gets no CR; a later ready never replays the cancelled submit', { timeout: 30000 }, async () => {
  const sid = 'd463-unwired';
  const session = H.registerSession(sid, { ready: false });
  const s = await H.submit(sid, { injected_body: 'D463-UNWIRED-2', retries: 0, gate_timeout_ms: 500 });
  H.transportReady(session);
  await sleep(300);
  assert.deepEqual({ status: s.response.status, stage: s.response.body.submit_stage, immediate: s.response.body.immediate_submit, crs: s.crFrames().length },
    { status: 504, stage: 'not_written', immediate: true, crs: 0 });
});

test('463 daemon legacy bridge (no capability): the existing gated path is unchanged and says so', { timeout: 30000 }, async () => {
  const sid = 'd463-legacy';
  H.registerSession(sid, { header: 'input-transport-ready-v1' });
  H.sessionStateManager.markIdle(sid);
  const s = await H.submit(sid, { injected_body: 'D463-LEGACY', retries: 0, retry_delay_ms: 500 });
  const cr = s.crFrames();
  assert.equal(s.response.body.immediate_submit, undefined, 'a legacy response carries no immediate_submit field');
  assert.equal(cr.length >= 1, true, 'the legacy path still sends its CR');
  assert.equal(Object.hasOwn(cr[0], 'pair'), false, 'a legacy CR frame carries no pair (byte-identical)');
  assert.ok(s.gateCalls().includes('awaitReplReady'), 'the legacy path still runs its REPL gate');
  assert.equal(H.runtime.buildSessionTransportBlock(H.sessions[sid]).immediate_submit, 'unsupported_by_bridge');
});

// hotfix480 F3 (owner decision, fail-closed): this test used to assert `crs: 1, pair: false` — an id-less CR into the
// successor generation for a body handed to an earlier one. That unsafe behaviour is no longer preserved: the named
// /submit is refused (not_written, owner_generation_changed) and no CR frame is sent.
test('463 daemon owner/epoch: a capability of a previous owner generation is not honoured, and a body of a previous generation gets no CR (refused, never id-less)', { timeout: 30000 }, async () => {
  const sid = 'd463-owner';
  const session = H.registerSession(sid);
  const { injectId } = await H.inject(sid, 'D463-OWNER body');
  // A new owner claims the session (new generation) WITHOUT the immediate capability: legacy path, no pair.
  const ws = H.ownerSocket();
  H.claimOwner(session, ws, { supervised: true });
  H.negotiate(session, { capable: true, header: 'input-transport-ready-v1' });
  H.transportReady(session);
  H.sessionStateManager.markIdle(sid);
  const legacy = await H.submit(sid, { injected_body: 'D463-OWNER body', retries: 0, inject_id: injectId });
  // The same owner later declares the capability in a further claim: immediate, but the old body pair is not carried.
  const ws2 = H.ownerSocket();
  H.claimOwner(session, ws2, { supervised: true });
  H.negotiate(session, { capable: true, header: CAPABILITY_HEADER_VALUE });
  H.transportReady(session);
  const immediate = await H.submit(sid, { injected_body: 'D463-OWNER body', retries: 0, inject_id: injectId });
  const crs = immediate.crFrames();
  assert.deepEqual({ legacyImmediate: legacy.response.body.immediate_submit ?? null, legacyPair: legacy.crFrames().some(f => Object.hasOwn(f, 'pair')),
    immediate: immediate.response.body.immediate_submit, status: immediate.response.status, stage: immediate.response.body.submit_stage,
    reason: immediate.response.body.reason, crs: crs.length, anyCrOnSocket: ws2.frames.filter(f => f.type === 'inject' && f.data === '\r').length }, {
    legacyImmediate: null, legacyPair: false, immediate: true, status: 503, stage: 'not_written',
    reason: 'owner_generation_changed', crs: 0, anyCrOnSocket: 0,
  });
});

test('463 daemon actual modal: a guarded claude surface showing a permission modal parks the CR (queued, not written)', { timeout: 30000 }, async () => {
  const sid = 'd463-modal';
  const session = H.registerSession(sid, { supervised: false });
  const modal = '\x1b[2J\x1b[HBash command\r\n  rm -rf build\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don\'t ask again for rm commands\r\n  3. No\r\n';
  assert.equal(registry.detectSurfaceModal('claude', modal).blocked, true, 'PRECONDITION: the fixture is a claude permission modal');
  session.outputRing = [modal];
  session.outputRingTotalBytes = modal.length;
  const s = await H.submit(sid, { injected_body: 'D463-MODAL', retries: 0 });
  await sleep(200);
  assert.deepEqual({ status: s.response.status, queued: s.response.body.queued, parked: s.response.body.parked,
    stage: s.response.body.submit_stage, crs: s.crFrames().length }, {
    status: 200, queued: true, parked: 'surface_modal', stage: 'queued', crs: 0,
  });
});

// ── hotfix480: F1 body-custody ordering, F2 pinning, F3/F4 named pair, quiet duplicate drops ─────────────────────
// Written BEFORE the hotfix480 product change; not executed by the coder. Expected RED on exact463, GREEN after.

// /inject while the REAL engine's tick is already running (the 200 ms poll or a concurrent inject): DeliveryEngine._tick
// returns at once, so the body stays pending in the daemon mailbox when /inject answers. The flag is restored before
// any assertion; the engine is never started in this harness, so the test's own tick() calls are the only deliveries.
async function injectWhileTickBusy(sid, prompt) {
  const engine = H.engine();
  engine._tickInProgress = true;
  let r;
  try { r = await H.call('/api/sessions/:id/inject', sid, { prompt, no_enter: true, from: 'fixture-sender' }); }
  finally { engine._tickInProgress = false; }
  assert.equal(r.status, 200, `PRECONDITION: inject accepted ${JSON.stringify(r.body)}`);
  assert.match(String(r.body.inject_id), /^[a-f0-9-]{36}$/, 'PRECONDITION: inject_id returned');
  return r.body.inject_id;
}
const injectFrames = ws => ws.frames.filter(f => f.type === 'inject');

test('480 F1 daemon: body still in daemon custody (tick busy) — the immediate CR is queued behind it and released once, on its handoff, paired, after the body', { timeout: 30000 }, async () => {
  const sid = 'd480-f1-busy';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const injectId = await injectWhileTickBusy(sid, 'D480-F1 body');
  assert.equal(injectFrames(ws).length, 0, 'PRECONDITION: the body is still pending in the daemon mailbox');
  const pending = H.submit(sid, { injected_body: 'D480-F1 body', retries: 3, inject_id: injectId });
  await sleep(300);
  const beforeHandoff = injectFrames(ws).map(f => (f.data === '\r' ? 'CR' : 'BODY'));
  await H.engine().tick();                    // the real deliverer hands the body to the owner
  const s = await pending;
  await sleep(1200);                          // no second Enter, no retry, no redeliver afterwards
  const body = ws.frames.find(f => f.type === 'inject' && f.part === 'body' && f.inject_id === injectId);
  assert.deepEqual({ beforeHandoff, status: s.response.status, stage: s.response.body.submit_stage,
    order: injectFrames(ws).map(f => (f.data === '\r' ? 'CR' : 'BODY')), crs: s.crFrames().map(f => [f.inject_id, f.pair]),
    waits: s.gateCalls().filter(n => WAITS.includes(n)) }, {
    beforeHandoff: [], status: 200, stage: 'sent_to_bridge', order: ['BODY', 'CR'], crs: [[injectId, body && body.daemon_msg_id]], waits: [],
  });
});

test('480 F1 daemon: a second inject pending behind an earlier one (one dequeue per tick) — its CR follows ITS body, never the earlier body alone', { timeout: 30000 }, async () => {
  const sid = 'd480-f1-second';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const first = await injectWhileTickBusy(sid, 'D480-F1-A body');
  const second = await injectWhileTickBusy(sid, 'D480-F1-B body');
  const pending = H.submit(sid, { injected_body: 'D480-F1-B body', retries: 0, inject_id: second });
  await sleep(200);
  await H.engine().tick();                    // hands the earlier body (A) only
  await sleep(200);
  const afterFirstTick = injectFrames(ws).map(f => (f.data === '\r' ? 'CR' : f.inject_id === first ? 'A' : 'B'));
  await H.engine().tick();                    // hands B; its queued CR is released now
  const s = await pending;
  const bodyB = ws.frames.find(f => f.type === 'inject' && f.part === 'body' && f.inject_id === second);
  assert.deepEqual({ afterFirstTick, status: s.response.status, stage: s.response.body.submit_stage,
    order: injectFrames(ws).map(f => (f.data === '\r' ? `CR:${f.pair === (bodyB && bodyB.daemon_msg_id) ? 'B' : '?'}` : f.inject_id === first ? 'A' : 'B')) }, {
    afterFirstTick: ['A'], status: 200, stage: 'sent_to_bridge', order: ['A', 'B', 'CR:B'],
  });
});

test('480 F1 daemon: an id-less (manual) immediate CR never jumps ahead of a body in daemon custody; it stays id-less and is written after it', { timeout: 30000 }, async () => {
  const sid = 'd480-f1-idless';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  await injectWhileTickBusy(sid, 'D480-F1-C body');
  const pending = H.submit(sid, { retries: 0 });
  await sleep(200);
  const beforeHandoff = injectFrames(ws).length;
  await H.engine().tick();
  const s = await pending;
  const cr = s.crFrames();
  assert.deepEqual({ beforeHandoff, status: s.response.status, stage: s.response.body.submit_stage,
    order: injectFrames(ws).map(f => (f.data === '\r' ? 'CR' : 'BODY')), ids: cr.map(f => [Object.hasOwn(f, 'inject_id'), Object.hasOwn(f, 'pair')]) }, {
    beforeHandoff: 0, status: 200, stage: 'sent_to_bridge', order: ['BODY', 'CR'], ids: [[false, false]],
  });
});

test('480 F1/F2 daemon: a body not handed within gate_timeout — the CR is refused not_written (body_custody_pending), and a later handoff never writes it', { timeout: 30000 }, async () => {
  const sid = 'd480-f1-timeout';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const injectId = await injectWhileTickBusy(sid, 'D480-F1-D body');
  const s = await H.submit(sid, { injected_body: 'D480-F1-D body', retries: 0, inject_id: injectId, gate_timeout_ms: 500 });
  await H.engine().tick();                    // the body is handed only after the refusal
  await sleep(1200);
  assert.deepEqual({ status: s.response.status, stage: s.response.body.submit_stage, reason: s.response.body.reason,
    order: injectFrames(ws).map(f => (f.data === '\r' ? 'CR' : 'BODY')) }, {
    status: 503, stage: 'not_written', reason: 'body_custody_pending', order: ['BODY'],
  });
});

test('480 F2 daemon: an immediate /submit queued on an unwired owner is pinned to its admitting generation+capability; after a downgrade claim it is refused before effects, never run on the legacy retry branch', { timeout: 30000 }, async () => {
  const sid = 'd480-f2-downgrade';
  const session = H.registerSession(sid, { ready: false });
  const oldWs = session.ownerWs;
  const calls = H.gateCalls.length;
  const pending = H.submit(sid, { injected_body: 'D480-F2', retries: 3, retry_delay_ms: 100, gate_timeout_ms: 8000 });
  await sleep(50);
  assert.equal(session.bootstrapQueue.length, 1, 'PRECONDITION: the submit is queued behind the input-transport fence');
  const newWs = H.ownerSocket();
  H.claimOwner(session, newWs, { supervised: true });
  H.negotiate(session, { capable: true, header: 'input-transport-ready-v1' });   // a bridge WITHOUT immediate-submit-v1
  H.sessionStateManager.markIdle(sid);
  H.transportReady(session);                                                      // releases (drains) the queue
  const s = await pending;
  await sleep(1500);
  assert.deepEqual({ status: s.response.status, immediate: s.response.body.immediate_submit, stage: s.response.body.submit_stage,
    reason: s.response.body.reason, attempts: s.response.body.attempts,
    crs: [injectFrames(oldWs).filter(f => f.data === '\r').length, injectFrames(newWs).filter(f => f.data === '\r').length],
    waits: H.gateCalls.slice(calls).filter(n => WAITS.includes(n)) }, {
    status: 503, immediate: true, stage: 'not_written', reason: 'owner_generation_changed', attempts: 0, crs: [0, 0], waits: [],
  });
});

test('480 F4 daemon: a named pair evicted from the bounded pair history (>256 newer handoffs) is refused, never sent id-less; a repeat is refused again, never an old CR', { timeout: 30000 }, async () => {
  const sid = 'd480-f4-pairs';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const { injectId } = await H.inject(sid, 'D480-F4 body');
  // 257 newer handoffs through the production recorder (the one deliverFn calls) push this pair out of the 256-entry history.
  for (let i = 0; i < 257; i++) assert.equal(runtimeModule.rememberSubmitPair(session, crypto.randomUUID(), `d480-f4-fill-${i}`), true, 'PRECONDITION');
  const first = await H.submit(sid, { injected_body: 'D480-F4 body', retries: 0, inject_id: injectId });
  const again = await H.submit(sid, { injected_body: 'D480-F4 body', retries: 0, inject_id: injectId });
  await sleep(300);
  const view = r => [r.response.status, r.response.body.submit_stage, r.response.body.reason, r.response.body.prior_submit];
  assert.deepEqual({ first: view(first), again: view(again), crs: injectFrames(ws).filter(f => f.data === '\r').length }, {
    first: [503, 'not_written', 'submit_pair_unavailable', 'unknown'],
    again: [503, 'not_written', 'submit_pair_unavailable', 'unknown'],
    crs: 0,
  });
});

test('480 F4 bridge: past the 4096-key single-CR guard, a repeated CR for an evicted pair is refused submit_guard_evicted (never written again); a fresh pair still gets its one CR', { timeout: 60000 }, async t => {
  const b = createBridge(t, { sid: 'b480-guard' });
  const old = b.pair('B480-OLD');
  b.frame(old.body);
  b.frame(old.submit);
  for (let i = 0; i < 2100; i++) { const p = b.pair(`B480-FILL-${i}`); b.frame(p.body); b.frame(p.submit); }  // > 4096 guard keys
  const repeat = b.terminalCr(old.injectId, { pairId: old.body.daemon_msg_id });
  b.frame(repeat);
  const fresh = b.pair('B480-FRESH');
  b.frame(fresh.body);
  b.frame(fresh.submit);
  await b.clock.advance(3000);
  assert.deepEqual({ crs: b.child.writes.filter(w => w === '\r').length, tail: b.child.writes.slice(-2), refused: b.refused() }, {
    crs: 2102, tail: ['B480-FRESH', '\r'],
    refused: [{ id: repeat.daemon_msg_id, reason: 'submit_guard_evicted', certainty: 'not_written' }],
  });
});

// hotfix492 correction of the 480 quiet test (VALIDATION486: 23/24 on both 463 and 480). The bridge has TWO stale routes:
//   (a) bridgeTick TTL maintenance quarantines a pending record `expired_unwritten` and never warns; it runs before
//       any tick flush, so the 480 fixture (held past the TTL by ticks) never reached the filter: its stale-warn
//       expectation was a fixture defect, not a product defect;
//   (b) the flush filter's `stale` drop (warns) on a DIRECT production flush (onReady relay, CR path), reached before
//       maintenance sees the record. Here the operator TTL is high while the records are held and lowered right
//       before the real flushBridgeMailbox() call.
// Each route is asserted with its own actual effects. No production stale warning was added.
function ttlEnv(t, value) {
  const previousTtl = process.env.TELEPTY_BRIDGE_INJECT_TTL_SECS;
  t.after(() => { if (previousTtl === undefined) delete process.env.TELEPTY_BRIDGE_INJECT_TTL_SECS; else process.env.TELEPTY_BRIDGE_INJECT_TTL_SECS = previousTtl; });
  process.env.TELEPTY_BRIDGE_INJECT_TTL_SECS = value;
}

test('480/492 quiet (b) flush filter: through the real direct flush, a dropped DUPLICATE is silent while a stale drop still warns; quarantine/payload/receipts unchanged and a write error is still reported', { timeout: 30000 }, async t => {
  ttlEnv(t, '600');                                     // maintenance must not expire anything while the records are held
  const warns = [];
  t.mock.method(console, 'warn', (...args) => { warns.push(args.map(String).join(' ')); });
  const b = createBridge(t, { sid: 'b480-quiet' });
  typing(b);
  b.frame({ type: 'inject', data: 'Q480-OLD' });
  for (let i = 0; i < 5; i++) { typing(b); await b.clock.advance(1500); }   // held by local typing; OLD is ~7.5 s old
  typing(b);
  b.frame({ type: 'inject', data: 'Q480-DUP' });
  b.frame({ type: 'inject', data: 'Q480-DUP' });
  b.frame({ type: 'inject', data: 'Q480-NORMAL' });
  assert.equal(b.child.writes.length, 0, 'PRECONDITION: everything is still queued');
  assert.equal(b.receipts().filter(r => r.stage === 'quarantined').length, 0, 'PRECONDITION: maintenance expired nothing');
  b.child.throwOn = data => data === 'Q480-NORMAL';
  process.env.TELEPTY_BRIDGE_INJECT_TTL_SECS = '5';     // operator TTL lowered; the next flush filter applies it
  b.allow.flushBridgeMailbox();                         // the real production flush, reached before the next maintenance
  await assert.rejects(b.clock.advance(5000), /EIO fixture write/, 'the write error still escapes, as before');
  const sid = 'b480-quiet';
  const dead = b.shared.bridgeMailbox.peekDeadLetter(sid).map(d => [d.payload, d.reason]);
  const dropWarns = warns.filter(w => w.includes('[BRIDGE] dropped'));
  assert.deepEqual({ writes: b.child.writes, dead,
    quarantined: b.receipts().filter(r => r.stage === 'quarantined').map(r => [r.reason, r.certainty]),
    unknown: b.receipts().filter(r => r.stage === 'unknown').map(r => [r.reason, r.certainty]),
    dropWarns: dropWarns.length, staleWarn: dropWarns.some(w => w.includes('dropped stale')),
    duplicateWarn: warns.some(w => /duplicate/i.test(w)) }, {
    writes: ['Q480-DUP'], dead: [['Q480-OLD', 'expired_unwritten'], ['Q480-DUP', 'bridge_duplicate']],
    quarantined: [['expired_unwritten', 'not_written'], ['bridge_duplicate', 'not_written']],
    unknown: [['write_threw', 'unknown']],
    dropWarns: 1, staleWarn: true, duplicateWarn: false,
  });
});

test('492 quiet (a) TTL maintenance: a record held past the TTL by the real bridgeTick is dead-lettered expired_unwritten with its payload, never written, and that route has no drop warning (463 and 480 alike)', { timeout: 30000 }, async t => {
  ttlEnv(t, '5');
  const warns = [];
  t.mock.method(console, 'warn', (...args) => { warns.push(args.map(String).join(' ')); });
  const b = createBridge(t, { sid: 'b492-expire' });
  typing(b);
  b.frame({ type: 'inject', data: 'Q492-EXPIRE' });
  for (let i = 0; i < 5; i++) { typing(b); await b.clock.advance(1500); }   // the 500 ms tick's maintenance expires it
  await b.clock.advance(3000);
  assert.deepEqual({ writes: b.child.writes, pending: b.shared.bridgePendingCount,
    dead: b.shared.bridgeMailbox.peekDeadLetter('b492-expire').map(d => [d.payload, d.reason]),
    quarantined: b.receipts().filter(r => r.stage === 'quarantined').map(r => [r.reason, r.certainty]),
    dropWarns: warns.filter(w => w.includes('[BRIDGE] dropped')).length }, {
    writes: [], pending: 0, dead: [['Q492-EXPIRE', 'expired_unwritten']],
    quarantined: [['expired_unwritten', 'not_written']], dropWarns: 0,
  });
});

// ── hotfix492: custody lifecycle (N1 terminal transitions, N4 capacity) and N2 modal re-check ─────────────────────
// Written BEFORE the hotfix492 product change; not executed by the coder. Expected RED on exact480 for the effects
// named in each title, GREEN after. Mailbox config bounds are lowered per test on the REAL FileMailbox and restored.
function mailboxConfig(t, patch) {
  const config = H.mailbox().config;
  const previous = Object.fromEntries(Object.keys(patch).map(key => [key, config[key]]));
  Object.assign(config, patch);
  t.after(() => Object.assign(config, previous));
}

test('492 N1 daemon: a body that EXPIRES in the daemon mailbox leaves custody at that terminal transition — a waiting named CR is refused body_not_handed at once, and a manual id-less Enter is no longer blocked', { timeout: 30000 }, async t => {
  const sid = 'd492-n1-expire';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const injectId = await injectWhileTickBusy(sid, 'D492-N1 body');
  mailboxConfig(t, { ttlSecs: 0 });                       // created_at + 0 < now once the second has passed
  const started = Date.now();
  const named = H.submit(sid, { injected_body: 'D492-N1 body', retries: 0, inject_id: injectId, gate_timeout_ms: 8000 });
  await sleep(1300);
  await H.engine().tick();                                 // real tick: expireStale marks it `expired`
  const n = await named;
  const namedMs = Date.now() - started;
  const manual = await H.submit(sid, { retries: 0, gate_timeout_ms: 8000 });
  await sleep(200);
  assert.deepEqual({ named: [n.response.status, n.response.body.submit_stage, n.response.body.reason], namedFast: namedMs < 5000,
    manual: [manual.response.status, manual.response.body.submit_stage], manualFast: manual.elapsedMs < 1000,
    order: injectFrames(ws).map(f => (f.data === '\r' ? (Object.hasOwn(f, 'inject_id') ? 'NAMED-CR' : 'CR') : 'BODY')) }, {
    named: [503, 'not_written', 'body_not_handed'], namedFast: true,
    manual: [200, 'sent_to_bridge'], manualFast: true, order: ['CR'],
  });
});

test('492 N1 daemon: a fenced in-flight body RECOVERED as delivery_outcome_unknown leaves custody as unknown — the named CR is refused body_outcome_unknown (never "never written"), payload kept, nothing replayed', { timeout: 30000 }, async t => {
  const sid = 'd492-n1-recover';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const injectId = await injectWhileTickBusy(sid, 'D492-N1R body');
  // A deliverer took the body and was interrupted after its effect fence (the real mailbox API, as DeliveryEngine does).
  const taken = H.mailbox().dequeue(sid);
  assert.equal(taken && taken.payload.includes('D492-N1R body'), true, 'PRECONDITION: the pending body is the one taken');
  assert.equal(H.mailbox().beginNonRetryableAttempt(sid, taken.msg_id), true, 'PRECONDITION: fenced');
  mailboxConfig(t, { inflightTimeoutSecs: 0 });
  const named = H.submit(sid, { injected_body: 'D492-N1R body', retries: 0, inject_id: injectId, gate_timeout_ms: 8000 });
  await sleep(200);
  await H.engine().tick();                                 // real tick: recoverInflight dead-letters it delivery_uncertain
  const n = await named;
  await sleep(200);
  const dead = H.mailbox().peekDeadLetter(sid).filter(d => d.msg_id === taken.msg_id);
  assert.deepEqual({ named: [n.response.status, n.response.body.submit_stage, n.response.body.reason], fast: n.elapsedMs < 5000,
    dead: dead.map(d => [d.reason, d.outcome, d.payload.includes('D492-N1R body')]), frames: injectFrames(ws).length }, {
    named: [503, 'not_written', 'body_outcome_unknown'], fast: true,
    dead: [['delivery_outcome_unknown_after_interruption', 'unknown', true]], frames: 0,
  });
});

test('492 N4 daemon: with 256 accepted bodies still in custody, a NEW inject is refused before enqueue (BODY_CUSTODY_FULL, 0 bytes); the earliest accepted body keeps its Enter', { timeout: 180000 }, async () => {
  const sid = 'd492-n4-capacity';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const first = await injectWhileTickBusy(sid, 'D492-N4 first body');
  const engine = H.engine();
  engine._tickInProgress = true;
  let refused;
  try {
    for (let i = 1; i < 256; i++) {                        // untracked operator injects (no `from`): 255 more pending bodies
      const r = await H.call('/api/sessions/:id/inject', sid, { prompt: `D492-N4 fill ${i}`, no_enter: true });
      assert.equal(r.status, 200, `PRECONDITION: fill ${i} accepted ${JSON.stringify(r.body)}`);
    }
    refused = await H.call('/api/sessions/:id/inject', sid, { prompt: 'D492-N4 overflow body', no_enter: true, from: 'fixture-sender' });
  } finally { engine._tickInProgress = false; }
  const pendingPayloads = H.mailbox().peek(sid, { includePayload: true }).filter(m => m.state === 'pending').map(m => m.payload);
  const named = H.submit(sid, { injected_body: 'D492-N4 first body', retries: 0, inject_id: first, gate_timeout_ms: 8000 });
  await sleep(200);
  await H.engine().tick();                                 // FIFO: the first body is handed; its queued CR is released
  const s = await named;
  const firstBody = ws.frames.find(f => f.type === 'inject' && f.part === 'body' && f.inject_id === first);
  assert.deepEqual({ refused: [refused.status, refused.body.code], overflowQueued: pendingPayloads.some(p => String(p).includes('D492-N4 overflow body')),
    pending: pendingPayloads.length, named: [s.response.status, s.response.body.submit_stage],
    crs: s.crFrames().map(f => [f.inject_id, f.pair]) }, {
    refused: [503, 'BODY_CUSTODY_FULL'], overflowQueued: false, pending: 256, named: [200, 'sent_to_bridge'],
    crs: [[first, firstBody && firstBody.daemon_msg_id]],
  });
});

const CLAUDE_MODAL = '\x1b[2J\x1b[HBash command\r\n  rm -rf build\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don\'t ask again for rm commands\r\n  3. No\r\n';

test('492 N2 daemon: a guarded surface that shows a modal DURING the custody wait — the released CR is parked behind it (queued, no CR), and written once, paired, after the modal clears', { timeout: 30000 }, async () => {
  const sid = 'd492-n2-modal';
  const session = H.registerSession(sid, { supervised: false });
  const ws = session.ownerWs;
  const injectId = await injectWhileTickBusy(sid, 'D492-N2 body');
  const pending = H.submit(sid, { injected_body: 'D492-N2 body', retries: 0, inject_id: injectId, gate_timeout_ms: 8000 });
  await sleep(200);
  session.outputRing = [CLAUDE_MODAL];                     // the modal appears while the CR waits on its body
  session.outputRingTotalBytes = CLAUDE_MODAL.length;
  await H.engine().tick();                                 // the body is handed; the modal is re-asked before the CR
  const s = await pending;
  const whileModal = injectFrames(ws).map(f => (f.data === '\r' ? 'CR' : 'BODY'));
  session.outputRing = [];                                 // the modal clears; the park poll drains the parked CR
  session.outputRingTotalBytes = 0;
  await sleep(1500);
  const body = ws.frames.find(f => f.type === 'inject' && f.part === 'body' && f.inject_id === injectId);
  assert.deepEqual({ response: [s.response.status, s.response.body.submit_stage, s.response.body.parked], whileModal,
    after: injectFrames(ws).map(f => (f.data === '\r' ? `CR:${f.pair === (body && body.daemon_msg_id)}` : 'BODY')) }, {
    response: [200, 'queued', 'surface_modal'], whileModal: ['BODY'], after: ['BODY', 'CR:true'],
  });
});

test('492 N2 daemon: a USER-SUPERVISED owner keeps its policy — a modal-looking surface during the custody wait does not gate the CR (no output/busy/modal classifier for supervised)', { timeout: 30000 }, async () => {
  const sid = 'd492-n2-supervised';
  const session = H.registerSession(sid, { supervised: true });
  const ws = session.ownerWs;
  const injectId = await injectWhileTickBusy(sid, 'D492-N2S body');
  const pending = H.submit(sid, { injected_body: 'D492-N2S body', retries: 0, inject_id: injectId, gate_timeout_ms: 8000 });
  await sleep(200);
  session.outputRing = [CLAUDE_MODAL];
  session.outputRingTotalBytes = CLAUDE_MODAL.length;
  await H.engine().tick();
  const s = await pending;
  assert.deepEqual({ response: [s.response.status, s.response.body.submit_stage], order: injectFrames(ws).map(f => (f.data === '\r' ? 'CR' : 'BODY')) },
    { response: [200, 'sent_to_bridge'], order: ['BODY', 'CR'] });
});

// 519 A (RED on 511: 503 not_written submit_pair_unavailable, 0 CR) — the public `telepty inject --submit <sid> <text>` WITHOUT
// --from is an UNTRACKED inject. The daemon returns its inject_id and hands the body to the current owner, so /submit with that
// id must get ONE CR paired to that body. Controls stay refused with no CR: an id never issued, another session's id, the same
// id after an owner-generation change. A /submit without inject_id stays the legacy id-less CR (no pair attached).
async function untrackedInject(sid, prompt) {
  const r = await H.call('/api/sessions/:id/inject', sid, { prompt, no_enter: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.status, 200, `PRECONDITION: untracked inject accepted ${JSON.stringify(r.body)}`);
  assert.match(String(r.body.inject_id), /^[a-f0-9-]{36}$/, 'PRECONDITION: inject_id returned to the caller');
  return r.body.inject_id;
}
const bodyFramesOf = (ws, text) => ws.frames.filter(f => f.type === 'inject' && f.part === 'body' && String(f.data).includes(text));
const crSummary = s => ({ status: s.response.status, stage: s.response.body.submit_stage, reason: s.response.body.reason ?? null,
  consumption: s.response.body.consumption ?? null, confirmed: s.response.body.submit_confirmed ?? null,
  crs: s.crFrames().map(f => [f.inject_id ?? null, f.pair ?? null]) });
const REFUSED = reason => ({ status: 503, stage: 'not_written', reason, consumption: null, confirmed: null, crs: [] });

test('519 A daemon: an UNTRACKED inject + /submit with its returned inject_id gets ONE paired CR; wrong, other-session and cross-generation ids are refused; no id stays id-less', { timeout: 30000 }, async () => {
  const sid = 'd519-untracked';
  const session = H.registerSession(sid);
  const injectId = await untrackedInject(sid, 'D519 body');
  const body = bodyFramesOf(session.ownerWs, 'D519 body');
  // 521: H.submit's crFrames() is a LAZY view from that request's start to the moment it is read, so each request's summary
  // is taken at its own completion, before any later call. `firstRequest` keeps its lazy view for the cumulative check.
  const firstRequest = await H.submit(sid, { injected_body: 'D519 body', retries: 0, inject_id: injectId });
  const ok = crSummary(firstRequest);
  const wrong = crSummary(await H.submit(sid, { injected_body: 'D519 body', retries: 0, inject_id: crypto.randomUUID() }));
  H.registerSession('d519-other');
  const otherId = await untrackedInject('d519-other', 'D519 other body');
  const other = crSummary(await H.submit(sid, { injected_body: 'D519 other body', retries: 0, inject_id: otherId }));
  const idless = crSummary(await H.submit(sid, { injected_body: 'D519 body', retries: 0 }));
  const replacement = H.ownerSocket();
  H.claimOwner(session, replacement, { supervised: true });
  H.negotiate(session, { capable: true, header: CAPABILITY_HEADER_VALUE });
  H.transportReady(session);
  const crossGen = crSummary(await H.submit(sid, { injected_body: 'D519 body', retries: 0, inject_id: injectId }));
  // Cumulative: every CR the ORIGINAL owner socket received from the first request on (any late write included), and the
  // replacement socket's CRs, read after the last request.
  const originalOwnerCrs = firstRequest.crFrames().map(f => [f.inject_id ?? null, f.pair ?? null]);
  const replacementCrs = replacement.frames.filter(f => f.type === 'inject' && f.data === '\r').length;
  assert.deepEqual({ originalOwnerCrs, replacementCrs }, { originalOwnerCrs: [[injectId, body[0] && body[0].daemon_msg_id], [null, null]], replacementCrs: 0 });
  assert.deepEqual({ bodyIds: body.map(f => f.inject_id ?? null), ok, wrong, other, idless, crossGen }, {
    bodyIds: [injectId],
    ok: { status: 200, stage: 'sent_to_bridge', reason: null, consumption: 'unknown', confirmed: false, crs: [[injectId, body[0] && body[0].daemon_msg_id]] },
    wrong: REFUSED('submit_pair_unavailable'), other: REFUSED('submit_pair_unavailable'),
    idless: { status: 200, stage: 'sent_to_bridge', reason: null, consumption: 'unknown', confirmed: false, crs: [[null, null]] },
    crossGen: REFUSED('owner_generation_changed'),
  });
});

test('519 A daemon bootstrap path: an UNTRACKED inject queued before the transport handshake is paired when the drain hands its body; its /submit gets ONE paired CR', { timeout: 30000 }, async () => {
  const sid = 'd519-bootstrap';
  const session = H.registerSession(sid, { ready: false });
  const injectId = await untrackedInject(sid, 'D519 queued body');
  assert.equal(bodyFramesOf(session.ownerWs, 'D519 queued body').length, 0, 'PRECONDITION: queued behind the transport handshake');
  H.transportReady(session);
  for (let i = 0; i < 40 && bodyFramesOf(session.ownerWs, 'D519 queued body').length === 0; i++) await sleep(50);
  const body = bodyFramesOf(session.ownerWs, 'D519 queued body');
  const ok = await H.submit(sid, { injected_body: 'D519 queued body', retries: 0, inject_id: injectId });
  assert.deepEqual({ bodyIds: body.map(f => [f.inject_id ?? null, String(f.daemon_msg_id).startsWith('bootstrap:')]), ok: crSummary(ok) }, {
    bodyIds: [[injectId, true]],
    ok: { status: 200, stage: 'sent_to_bridge', reason: null, consumption: 'unknown', confirmed: false, crs: [[injectId, body[0] && body[0].daemon_msg_id]] },
  });
});
