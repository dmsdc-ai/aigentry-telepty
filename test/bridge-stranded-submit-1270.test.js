'use strict';

// Task 1270 R1/R2 — a stranded composer and silent wake exits, through the REAL bridge factory.
// Written by the tester BEFORE any source correction. Expected to FAIL on security-actions 7e20bbdf through actual effects
// (a later body/CR written into a composer that still holds an unsubmitted body; a held CR leaving with no receipt) and
// to pass on a corrected source, unchanged.
//
// Contract under test (controller decision): when a bridge body was written (or its write is unknown) and the CR meant to
// submit it is refused or unknown, the composer of THAT child is stranded. Until that child exits or is replaced, every
// later bridge body and CR is not_written with reason composer_stranded (daemon keeps custody) — never appended and
// submitted together with the stranded body. Cleared by child exit/replacement only (no timer, repaint, owner change).
// R2: a CR held for its submit gap never leaves silently — handoff and close each produce one truthful refusal.
//
// Real seams, no mirrored gate: createAllowSecurityContext + handleOwnerInject, subscribeChild, the delivery/hold timers,
// closeAllowSession, the real FileMailbox, prompt registry and bridge-flush-filter. Declared fakes: clock/timers (Node's
// 0->1 ms coercion), child doubles (write log with fake-clock time), owner-WS send recorder, 80x24 stdout. No listener,
// network, provider, native PTY or model. Master-write order only; never proof of a native CLI's composer behaviour.
// "PRECONDITION:" = invalid setup (INVALID run). "CHECKPOINT:" = an intermediate product state (a semantic assertion).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const load = rel => require(path.join(ROOT, rel));
const security = load('src/cli/security-actions.js');
const registry = load('src/prompt-symbol-registry.js');
const { FileMailbox } = load('src/mailbox/index.js');
const flushFilter = load('src/mailbox/bridge-flush-filter.js');
const { getTerminalSize } = load('interactive-terminal.js');

const STRANDED = 'composer_stranded';
const OWNER_GENERATION = 'owner-gen-1270-current';
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'bridge-136');
function loadStream(name) {
  const recipe = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  assert.match(recipe.provenance, /^synthetic:/, `PRECONDITION: ${name} provenance must be synthetic`);
  let stream = recipe.preamble.join('');
  for (let k = 0; k < recipe.repeat; k++) stream += recipe.cycle[k % recipe.cycle.length];
  return stream + recipe.epilogue.join('');
}
const MODAL = loadStream('codex-differential-modal.json');
const IDLE = loadStream('codex-differential-idle.json');

// ── harness: the bridge-submit-gap-1270 fixture (clock, child double, real context), plus relay + owner generation ──
function createClock() {
  let now = Math.floor((Date.now() - 3 * 3600 * 1000) / 1000) * 1000;
  let seq = 0; let fired = 0;
  const timers = new Map();
  return {
    now: () => now,
    // Real Node semantics: a delay below 1 ms (including 0) is coerced to 1 ms.
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + Math.max(1, Number(ms) || 0), every: 0 }); return id; },
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

function childDouble(clock, name) {
  const handlers = { data: null, exit: null };
  const child = {
    pid: 5270, name, writes: [], at: [], attempts: 0, throwOn: null,
    write(data) {
      child.attempts++;
      if (child.throwOn && child.throwOn(data)) { child.throwOn = null; throw Object.assign(new Error('EIO fixture write'), { code: 'EIO' }); }
      child.writes.push(String(data)); child.at.push(clock.now());
    },
    resize() {}, kill() { throw new Error('PRECONDITION: native kill is not part of this fixture'); },
    onData(fn) { handlers.data = fn; }, onExit(fn) { handlers.exit = fn; },
    emit(data) { if (handlers.data) handlers.data(data); },
    exit(event = { exitCode: 1 }) { if (handlers.exit) handlers.exit(event); },
  };
  return child;
}

function createBridge(t, { sid, command = 'codex', inputPolicy } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1270-stranded-'));
  const clock = createClock();
  const sends = [];
  const stdout = { columns: 80, rows: 24, isTTY: true, write() { return true; } };
  const child = childDouble(clock, 'child-0');
  const shared = {
    sessionId: sid, command, cmdArgs: [], sshPlan: null, child, handoffPending: null, idleTtl: null,
    ...(inputPolicy ? { inputPolicy } : {}),
    detectedBackend: 'fixture', terminalProgram: 'fixture', terminalType: 'xterm-256color',
    DAEMON_URL: 'http://127.0.0.1:9', fetchWithAuth: () => Promise.reject(new Error('no network in fixture')),
    sessionCwd: root, sessionEnv: {}, bridgeTarget: sid, bridgeMsgSeq: 0, bridgePendingCount: 0,
    promptReady: false, lastUserInputTime: 0, IDLE_THRESHOLD: 2000,
    knownAiCli: registry.isKnownAiCli(command), outputTail: '', readyRegistry: registry, readyQualification: null,
    promptPattern: /[❯>$#%]\s*$/, firstReadyObserved: false, queueFlushTimer: null, idleCheckTimer: null,
    reconnectTimer: null, heartbeatTimer: null,
    filterBridgeBatch: flushFilter.filterBridgeBatch, bridgeInjectTtlSecs: flushFilter.bridgeInjectTtlSecs,
    interactionBinding: { sid, session_epoch: 'epoch-1270', credential_generation: 1,
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
    bridgeRoot: path.join(root, 'bridge'),
  });
  shared.bridgeMailbox = allow.createBridgeMailbox();
  const relay = allow.createOutputRelay({
    onInteraction: () => { shared.interactionBinding.input_generation++; },
    onBytes: () => {}, rewrite: d => d, write: () => {}, sendOutput: () => {},
    observeReady: d => allow.observePromptReady(d),
    onReady: () => { shared.promptReady = true; shared.firstReadyObserved = true; allow.flushBridgeMailbox(); },
  });
  allow.subscribeChild(child, relay, () => {});
  function feed(stream, chunk = 1024) { for (let i = 0; i < stream.length; i += chunk) shared.child.emit(stream.slice(i, i + chunk)); }
  function frame(msg) { return allow.handleOwnerInject(msg); }
  let seq = 0;
  function pair(text, generation = OWNER_GENERATION) {
    seq++;
    const injectId = `00000000-0000-4127-8000-${String(seq).padStart(12, '0')}`;
    const body = { type: 'inject', data: text, daemon_msg_id: `dm1270s-${seq}-body`, inject_id: injectId, part: 'body', owner_generation: generation };
    const submit = { type: 'inject', data: '\r', daemon_msg_id: `dm1270s-${seq}-submit`, inject_id: injectId, part: 'submit',
      pair: body.daemon_msg_id, owner_generation: generation };
    return { injectId, body, submit };
  }
  const receipts = () => sends.filter(m => m.type === 'bridge_receipt');
  const stages = id => receipts().filter(r => r.daemon_msg_id === id).map(r => [r.stage, r.certainty, r.reason ?? null]);
  t.after(() => {
    try { allow.closeAllowSession({ destroySession: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { shared, allow, clock, child, relay, sends, feed, frame, pair, receipts, stages };
}

// A direct body at t0 and its CR at t0+5 (held for the 250 ms submit gap on a quiet guarded surface).
async function bodyThenHeldCr(b, text) {
  const p = b.pair(text);
  b.frame(p.body);
  assert.deepEqual(b.child.writes, [text], 'PRECONDITION: body written directly on a quiet surface');
  await b.clock.advance(5);
  b.frame(p.submit);
  assert.deepEqual(b.child.writes, [text], 'CHECKPOINT: CR held, not written in the same turn');
  return p;
}
// A later pair, sent well after every local-typing window, body then CR 5 ms apart, then drained.
async function laterPair(b, text, generation) {
  const p = b.pair(text, generation);
  b.frame(p.body);
  await b.clock.advance(5);
  b.frame(p.submit);
  await b.clock.advance(5000);
  return p;
}
// R1: the effect first (nothing appended), then the named reason for both frames of the later pair.
function assertStranded(b, child, writesBefore, later) {
  assert.deepEqual(child.writes, writesBefore, 'no later body/CR may be written into a composer still holding an unsubmitted body');
  for (const id of [later.body.daemon_msg_id, later.submit.daemon_msg_id]) {
    const st = b.stages(id);
    assert.ok(!st.some(([stage]) => stage === 'pty_written'), `${id}: ${JSON.stringify(st)}`);
    assert.ok(st.some(([, certainty, reason]) => certainty === 'not_written' && reason === STRANDED), `${id}: ${JSON.stringify(st)}`);
  }
}

// ── R1: refusal at wake strands the composer of that child ──────────────────────────────────────────────────────
test('R1 modal: CR refused modal_ui at wake; after the modal is answered a later pair adds 0 writes (composer_stranded)', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-modal' });
  const p1 = await bodyThenHeldCr(b, 'S-MODAL-ONE');
  await b.clock.advance(95);
  b.feed(MODAL);                                   // a TRUE modal owns the surface during the hold
  await b.clock.advance(1000);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['refused', 'not_written', 'modal_ui']], 'CHECKPOINT: CR refused at wake');
  b.shared.lastUserInputTime = b.clock.now();      // the user answers the modal …
  b.feed(IDLE);                                    // … and the composer is back
  assert.equal(registry.detectSurfaceModal('codex', b.shared.outputTail).blocked, false, 'PRECONDITION: modal no longer on the surface');
  await b.clock.advance(3000);                     // well past the 2 s local-typing window
  const later = await laterPair(b, 'S-MODAL-TWO');
  assertStranded(b, b.child, ['S-MODAL-ONE'], later);
});

test('R1 typing: CR refused user_input_after_body at wake; a later pair is held (composer_stranded), 0 writes', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-typing' });
  const p1 = await bodyThenHeldCr(b, 'S-TYPED-ONE');
  await b.clock.advance(95);
  b.shared.lastUserInputTime = b.clock.now();      // a local keystroke after the body landed
  await b.clock.advance(1000);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['refused', 'not_written', 'user_input_after_body']], 'CHECKPOINT: CR refused at wake');
  await b.clock.advance(3000);
  const later = await laterPair(b, 'S-TYPED-TWO');
  assertStranded(b, b.child, ['S-TYPED-ONE'], later);
});

test('R1 owner change, same child: CR refused owner_changed; the new owner\'s pair is held (composer_stranded), 0 writes', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-owner' });
  const p1 = await bodyThenHeldCr(b, 'S-OWNER-ONE');
  await b.clock.advance(95);
  const next = 'owner-gen-1270-next';
  b.shared.interactionBinding = { ...b.shared.interactionBinding, owner_generation: next };
  await b.clock.advance(1000);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['refused', 'not_written', 'owner_changed']], 'CHECKPOINT: CR refused at wake');
  await b.clock.advance(3000);
  const later = await laterPair(b, 'S-OWNER-TWO', next);
  assertStranded(b, b.child, ['S-OWNER-ONE'], later);
});

test('R1 control: child replaced during the hold — CR refused child_replaced; a fresh pair reaches the NEW child exactly once', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-replaced' });
  const p1 = await bodyThenHeldCr(b, 'S-REPL-ONE');
  await b.clock.advance(95);
  const successor = childDouble(b.clock, 'child-1');
  b.shared.child = successor;
  b.allow.subscribeChild(successor, b.relay, () => {});
  await b.clock.advance(1000);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['refused', 'not_written', 'child_replaced']], 'CHECKPOINT: CR refused at wake');
  await b.clock.advance(3000);
  const later = await laterPair(b, 'S-REPL-TWO');
  assert.deepEqual({ old: b.child.writes, successor: successor.writes }, { old: ['S-REPL-ONE'], successor: ['S-REPL-TWO', '\r'] });
  assert.deepEqual(b.stages(later.body.daemon_msg_id), [['pty_written', 'written', null]]);
  assert.deepEqual(b.stages(later.submit.daemon_msg_id), [['pty_written', 'written', null]]);
});

// ── R1 derived: an unknown CR outcome, and the queued-path quarantine at wake ───────────────────────────────────
test('R1 derived (unknown): the held CR\'s write throws (unknown/write_threw); a later pair is held (composer_stranded), never appended', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-unknown' });
  const p1 = await bodyThenHeldCr(b, 'S-UNKNOWN-ONE');
  b.child.throwOn = data => data === '\r';
  await b.clock.advance(1000);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['unknown', 'unknown', 'write_threw']], 'CHECKPOINT: CR outcome unknown');
  await b.clock.advance(3000);
  const attemptsBefore = b.child.attempts;
  const later = await laterPair(b, 'S-UNKNOWN-TWO');
  assert.equal(b.child.attempts, attemptsBefore, 'no write attempt for the later pair');
  assertStranded(b, b.child, ['S-UNKNOWN-ONE'], later);
});

test('R1 derived (queued path): typing after the flushed body quarantines its queued CR; a later pair is held (composer_stranded)', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-queued' });
  const p1 = b.pair('S-QUEUED-ONE');
  b.shared.lastUserInputTime = b.clock.now();      // local typing: body and CR queue
  b.frame(p1.body);
  b.frame(p1.submit);
  for (let i = 0; i < 60 && b.child.writes.length === 0; i++) await b.clock.advance(50);   // until the idle tick flushes the body
  assert.deepEqual(b.child.writes, ['S-QUEUED-ONE'], 'CHECKPOINT: body flushed, its CR still on its delivery timer');
  await b.clock.advance(100);
  b.shared.lastUserInputTime = b.clock.now();
  await b.clock.advance(1000);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['queued', 'not_written', null], ['quarantined', 'not_written', 'user_input_after_body']],
    'CHECKPOINT: queued CR quarantined at wake');
  await b.clock.advance(3000);
  const later = await laterPair(b, 'S-QUEUED-TWO');
  assertStranded(b, b.child, ['S-QUEUED-ONE'], later);
});

// ── R2: a held CR never leaves without a receipt ──────────────────────────────────────────────────────────────────
test('R2 handoff: handoffPending set during the hold — exactly one refused not_written handoff_pending receipt, 0 CR', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-handoff' });
  const p1 = await bodyThenHeldCr(b, 'S-HANDOFF-ONE');
  await b.clock.advance(95);
  b.shared.handoffPending = { child: b.child, request: { type: 'handoff' } };   // cli.js:3455 shape
  await b.clock.advance(1000);
  assert.deepEqual(b.child.writes, ['S-HANDOFF-ONE']);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['refused', 'not_written', 'handoff_pending']]);
  b.shared.handoffPending = null;
});

test('R2 close (closeAllowSession during the hold): exactly one refused not_written session_closed receipt, 0 CR', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-close' });
  const p1 = await bodyThenHeldCr(b, 'S-CLOSE-ONE');
  await b.clock.advance(95);
  b.allow.closeAllowSession({ destroySession: false });
  await b.clock.advance(1000);
  assert.deepEqual(b.child.writes, ['S-CLOSE-ONE']);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['refused', 'not_written', 'session_closed']]);
});

test('R2 close (shared closed flag observed at wake, the isClosed() door): exactly one refused not_written session_closed receipt, 0 CR', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270s-closed-flag' });
  const p1 = await bodyThenHeldCr(b, 'S-CLOSEDFLAG-ONE');
  await b.clock.advance(95);
  b.shared.allowSessionClosed = true;              // the field isClosed() reads (cli.js:3115 exposes its setter)
  await b.clock.advance(1000);
  assert.deepEqual(b.child.writes, ['S-CLOSEDFLAG-ONE']);
  assert.deepEqual(b.stages(p1.submit.daemon_msg_id), [['refused', 'not_written', 'session_closed']]);
});
