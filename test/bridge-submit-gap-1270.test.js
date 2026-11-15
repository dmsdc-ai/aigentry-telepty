'use strict';

// Task 1270 — body→submit ordering floor at the bridge PTY writer (SUBMIT_GAP_MS = 250 in src/cli/security-actions.js).
// Written BEFORE the production change; the coder did not execute it. The tester runs it: RED on 1a51d30a, GREEN on the candidate.
//
// Real production seams, no mirrored gate logic: createAllowSecurityContext + handleOwnerInject (the owner-WS inject handler
// cli.js calls), subscribeChild, flushBridgeMailbox and its delivery timers, closeAllowSession, the real FileMailbox, the
// real prompt registry and bridge-flush-filter. Declared fakes: the clock/timers, child doubles (write log with the fake
// clock time), the owner-WS send recorder, the 80x24 stdout. No listener, network, provider, native PTY or model.
// A timer test proves only the bridge's master-write ORDER/TIMING; it never proves a native CLI treats the CR as Enter.
// "PRECONDITION:" means the setup is invalid (an INVALID run), not a product finding.

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

const GAP_MS = 250;   // the contract value (task 1270 SPEC), asserted as a bound, not read from the product
const OWNER_GENERATION = 'owner-gen-1270-current';
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'bridge-136');
function loadStream(name) {
  const recipe = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  assert.match(recipe.provenance, /^synthetic:/, `PRECONDITION: ${name} provenance must be synthetic`);
  let stream = recipe.preamble.join('');
  for (let k = 0; k < recipe.repeat; k++) stream += recipe.cycle[k % recipe.cycle.length];
  return stream + recipe.epilogue.join('');
}
const BUSY = loadStream('codex-differential-busy.json');
const MODAL = loadStream('codex-differential-modal.json');

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
    bump(ms) { now += ms; },   // time spent inside a synchronous call (e.g. child.write)
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

function childDouble(clock, name) {
  const handlers = { data: null, exit: null };
  const child = {
    pid: 5270, name, writes: [], at: [], attempts: 0, throwOn: null, writeCostMs: 0,
    write(data) {
      child.attempts++;
      if (child.writeCostMs) clock.bump(child.writeCostMs);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1270-'));
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
  function feed(stream, chunk = 1024) { for (let i = 0; i < stream.length; i += chunk) child.emit(stream.slice(i, i + chunk)); }
  function frame(msg) { return allow.handleOwnerInject(msg); }
  let seq = 0;
  function pair(text) {
    seq++;
    const injectId = `00000000-0000-4127-8000-${String(seq).padStart(12, '0')}`;
    const body = { type: 'inject', data: text, daemon_msg_id: `dm1270-${seq}-body`, inject_id: injectId, part: 'body', owner_generation: OWNER_GENERATION };
    const submit = { type: 'inject', data: '\r', daemon_msg_id: `dm1270-${seq}-submit`, inject_id: injectId, part: 'submit',
      pair: body.daemon_msg_id, owner_generation: OWNER_GENERATION };
    return { injectId, body, submit };
  }
  const receipts = () => sends.filter(m => m.type === 'bridge_receipt');
  const stages = id => receipts().filter(r => r.daemon_msg_id === id).map(r => [r.stage, r.certainty, r.reason ?? null]);
  t.after(() => {
    try { allow.closeAllowSession({ destroySession: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { shared, allow, clock, child, sends, feed, frame, pair, receipts, stages };
}
const crTimes = c => c.writes.map((w, i) => [w, c.at[i]]).filter(([w]) => w === '\r').map(([, at]) => at);
const bodyTime = (c, text) => c.at[c.writes.indexOf(text)];

test('1270: a CR arriving +5 ms after a direct body write is written once, no sooner than 250 ms after that body write', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-early' });
  const p = b.pair('B1270-EARLY');
  b.frame(p.body);
  await b.clock.advance(5);
  b.frame(p.submit);
  const atArrival = b.child.writes.slice();
  await b.clock.advance(GAP_MS - 5 - 1);
  const justBefore = b.child.writes.slice();
  await b.clock.advance(5000);
  const gaps = crTimes(b.child).map(at => at - bodyTime(b.child, 'B1270-EARLY'));
  assert.deepEqual({ atArrival, justBefore, writes: b.child.writes, attempts: b.child.attempts }, {
    atArrival: ['B1270-EARLY'], justBefore: ['B1270-EARLY'], writes: ['B1270-EARLY', '\r'], attempts: 2,
  });
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0] >= GAP_MS, `CR gap ${gaps[0]} ms must be >= ${GAP_MS}`);
  assert.ok(b.stages(p.submit.daemon_msg_id).some(([stage, certainty]) => stage === 'pty_written' && certainty === 'written'));
});

test('1270: a late CR (gap already elapsed) is written immediately in the same turn', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-late' });
  const p = b.pair('B1270-LATE');
  b.frame(p.body);
  await b.clock.advance(GAP_MS + 50);
  b.frame(p.submit);
  assert.deepEqual(b.child.writes, ['B1270-LATE', '\r'], 'late CR is not delayed');
});

test('1270: queued flush (local typing) writes body then CR with a body→CR offset >= 250 ms', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-queued' });
  const p = b.pair('B1270-QUEUED');
  b.shared.lastUserInputTime = b.clock.now();
  b.frame(p.body);
  b.frame(p.submit);
  assert.deepEqual({ writes: b.child.writes, pending: b.shared.bridgePendingCount }, { writes: [], pending: 2 }, 'PRECONDITION: both queued while typing');
  await b.clock.advance(10000);
  assert.deepEqual(b.child.writes, ['B1270-QUEUED', '\r']);
  const gap = crTimes(b.child)[0] - bodyTime(b.child, 'B1270-QUEUED');
  assert.ok(gap >= GAP_MS, `queued CR gap ${gap} ms must be >= ${GAP_MS}`);
});

test('1270: busy output does not add an idle wait — the CR lands at the floor, not after output quiets', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-busy' });
  b.feed(BUSY);
  await settleVt();
  const p = b.pair('B1270-BUSY');
  b.frame(p.body);
  b.frame(p.submit);
  await b.clock.advance(100);
  b.feed(BUSY);                    // output keeps streaming during the wait
  await b.clock.advance(GAP_MS - 100);
  assert.deepEqual(b.child.writes, ['B1270-BUSY', '\r'], 'CR written by the floor while output is busy');
  assert.equal(crTimes(b.child)[0] - bodyTime(b.child, 'B1270-BUSY'), GAP_MS);
});

test('1270: supervised owners get the same floor', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-supervised', inputPolicy: 'user-supervised' });
  const p = b.pair('B1270-SUP');
  b.frame(p.body);
  b.frame(p.submit);
  const atOnce = b.child.writes.slice();
  await b.clock.advance(5000);
  assert.deepEqual({ atOnce, writes: b.child.writes }, { atOnce: ['B1270-SUP'], writes: ['B1270-SUP', '\r'] });
  assert.ok(crTimes(b.child)[0] - bodyTime(b.child, 'B1270-SUP') >= GAP_MS);
});

test('1270: a duplicate CR while the first waits is refused duplicate_submit:admitted; a later one :written; exactly one CR', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-dup' });
  const p = b.pair('B1270-DUP');
  b.frame(p.body);
  b.frame(p.submit);
  const dupWaiting = { ...p.submit, daemon_msg_id: 'submit:dup-waiting' };
  b.frame(dupWaiting);
  await b.clock.advance(5000);
  const dupAfter = { ...p.submit, daemon_msg_id: 'submit:dup-after' };
  b.frame(dupAfter);
  await b.clock.advance(5000);
  assert.deepEqual({ writes: b.child.writes, waiting: b.stages('submit:dup-waiting'), after: b.stages('submit:dup-after') }, {
    writes: ['B1270-DUP', '\r'],
    waiting: [['refused', 'not_written', 'duplicate_submit:admitted']],
    after: [['refused', 'not_written', 'duplicate_submit:written']],
  });
});

test('1270: child exit during the wait — zero CR, the CR is quarantined not_written', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-exit' });
  const p = b.pair('B1270-EXIT');
  b.frame(p.body);
  b.frame(p.submit);
  b.child.exit();
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-EXIT']);
  const crStages = b.stages(p.submit.daemon_msg_id);
  assert.ok(crStages.some(([stage, certainty]) => stage === 'quarantined' && certainty === 'not_written'), JSON.stringify(crStages));
  assert.ok(!crStages.some(([stage]) => stage === 'pty_written'));
});

test('1270: child replaced during the wait — zero CR to either child, truthful not_written child_replaced', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-replaced' });
  const p = b.pair('B1270-REPL');
  b.frame(p.body);
  b.frame(p.submit);
  const successor = childDouble(b.clock, 'child-1');
  b.shared.child = successor;
  await b.clock.advance(5000);
  assert.deepEqual({ old: b.child.writes, successor: successor.writes }, { old: ['B1270-REPL'], successor: [] });
  assert.deepEqual(b.stages(p.submit.daemon_msg_id).filter(([stage]) => stage !== 'queued'),
    [['quarantined', 'not_written', 'child_replaced']]);
});

test('1270: owner generation changed during the wait — zero CR, not_written owner_changed', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-owner' });
  const p = b.pair('B1270-OWNER');
  b.frame(p.body);
  b.frame(p.submit);
  b.shared.interactionBinding = { ...b.shared.interactionBinding, owner_generation: 'owner-gen-1270-next' };
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-OWNER']);
  assert.deepEqual(b.stages(p.submit.daemon_msg_id).filter(([stage]) => stage !== 'queued'),
    [['quarantined', 'not_written', 'owner_changed']]);
});

test('1270: close during the wait clears the timer — zero CR, custody kept as not_written', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-close' });
  const p = b.pair('B1270-CLOSE');
  b.frame(p.body);
  b.frame(p.submit);
  b.allow.closeAllowSession({ destroySession: true });
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-CLOSE']);
  assert.ok(b.stages(p.submit.daemon_msg_id).some(([stage, certainty]) => stage === 'quarantined' && certainty === 'not_written'));
});

test('1270: a deferred CR whose write throws is unknown/write_threw, not rethrown out of the timer, never written again', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-throw' });
  const p = b.pair('B1270-THROW');
  b.frame(p.body);
  b.frame(p.submit);
  b.child.throwOn = data => data === '\r';
  await b.clock.advance(5000);   // a throw escaping the timer would reject here
  const again = { ...p.submit, daemon_msg_id: 'submit:again' };
  b.frame(again);
  await b.clock.advance(5000);
  assert.deepEqual({ attempts: b.child.attempts, writes: b.child.writes,
    cr: b.stages(p.submit.daemon_msg_id).filter(([stage]) => stage !== 'queued'), again: b.stages('submit:again') }, {
    attempts: 2, writes: ['B1270-THROW'],
    cr: [['unknown', 'unknown', 'write_threw']],
    again: [['refused', 'not_written', 'duplicate_submit:unknown']],
  });
});

test('1270: a body whose write threw (effect unknown) still imposes the floor on a following CR', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-body-unknown' });
  const p = b.pair('B1270-BODYTHROW');
  b.child.throwOn = data => data === 'B1270-BODYTHROW';
  const thrownAt = b.clock.now();
  assert.throws(() => b.frame(p.body), /EIO fixture write/, 'PRECONDITION: direct body write error escapes as before');
  b.frame(p.submit);
  assert.deepEqual(b.child.writes, [], 'CR not written in the same turn as an unknown body write');
  await b.clock.advance(5000);
  const times = crTimes(b.child);
  assert.equal(times.length, 1);
  assert.ok(times[0] - thrownAt >= GAP_MS);
});

// ── Task 1270 correction (F1): FIFO / head-of-line — a deferred CR keeps its place; a later body never overtakes it ──
const order = c => c.writes.map(w => (w === '\r' ? 'CR' : w));
function assertOwnGaps(c, bodies) {
  // each CR is measured from ITS OWN body: the body immediately before it in the written stream
  for (let i = 0; i < c.writes.length; i++) {
    if (c.writes[i] !== '\r') continue;
    const body = c.writes[i - 1];
    assert.ok(bodies.includes(body), `CR at ${i} follows its body (got ${JSON.stringify(body)})`);
    assert.ok(c.at[i] - c.at[i - 1] >= GAP_MS, `CR for ${body}: gap ${c.at[i] - c.at[i - 1]} ms must be >= ${GAP_MS}`);
  }
}

for (const arm of [{ name: 'guarded', inputPolicy: undefined }, { name: 'supervised', inputPolicy: 'user-supervised' }]) {
  test(`1270 F1 (${arm.name}): two queued pairs flushed at once (0→1 ms timer coercion, 1 ms per write) drain [body1, CR, body2, CR]`, { timeout: 30000 }, async t => {
    const b = createBridge(t, { sid: `b1270-fifo-${arm.name}`, inputPolicy: arm.inputPolicy });
    b.child.writeCostMs = 1;
    const p1 = b.pair('B1270-FIFO-1');
    const p2 = b.pair('B1270-FIFO-2');
    b.shared.lastUserInputTime = b.clock.now();   // local typing: all four queue
    b.frame(p1.body); b.frame(p1.submit); b.frame(p2.body); b.frame(p2.submit);
    assert.deepEqual({ writes: b.child.writes, pending: b.shared.bridgePendingCount }, { writes: [], pending: 4 }, 'PRECONDITION: all queued');
    await b.clock.advance(20000);
    assert.deepEqual(order(b.child), ['B1270-FIFO-1', 'CR', 'B1270-FIFO-2', 'CR']);
    assertOwnGaps(b.child, ['B1270-FIFO-1', 'B1270-FIFO-2']);
    for (const p of [p1, p2]) {
      assert.deepEqual(b.stages(p.submit.daemon_msg_id).filter(([stage]) => stage !== 'queued'), [['pty_written', 'written', null]]);
    }
  });
}

test('1270 F1: a direct body, its deferred CR, then a second pair arriving during the wait — [body1, CR, body2, CR], each own gap', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-fifo-direct' });
  const p1 = b.pair('B1270-DIRECT-1');
  const p2 = b.pair('B1270-DIRECT-2');
  b.frame(p1.body);
  await b.clock.advance(5);
  b.frame(p1.submit);
  await b.clock.advance(5);
  b.frame(p2.body);
  b.frame(p2.submit);
  await b.clock.advance(20000);
  assert.deepEqual(order(b.child), ['B1270-DIRECT-1', 'CR', 'B1270-DIRECT-2', 'CR']);
  assertOwnGaps(b.child, ['B1270-DIRECT-1', 'B1270-DIRECT-2']);
});

// ── Task 1270 correction (F2): admission re-read when the deferred CR wakes ─────────────────────────────────────────
test('1270 F2: a modal drawn during the hold (guarded) — zero CR, quarantined not_written modal_ui', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-modal-hold' });
  const p = b.pair('B1270-MODAL-HOLD');
  b.frame(p.body);
  b.frame(p.submit);
  assert.deepEqual(b.child.writes, ['B1270-MODAL-HOLD'], 'PRECONDITION: body written, CR held');
  await b.clock.advance(100);
  b.feed(MODAL);
  await settleVt();
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-MODAL-HOLD']);
  assert.deepEqual(b.stages(p.submit.daemon_msg_id).filter(([stage]) => stage !== 'queued'), [['quarantined', 'not_written', 'modal_ui']]);
});

test('1270 F2: modal evidence unavailable at wake (guarded after supervised output) — refused modal_unobservable, not a modal verdict', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-unobservable', inputPolicy: 'user-supervised' });
  const p = b.pair('B1270-UNOBS');
  b.frame(p.body);
  b.frame(p.submit);
  b.feed(BUSY);                          // printed while supervised: fed to neither grid nor tail
  b.shared.inputPolicy = 'guarded';      // same owner generation, policy now guarded
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-UNOBS']);
  assert.deepEqual(b.stages(p.submit.daemon_msg_id).filter(([stage]) => stage !== 'queued'), [['quarantined', 'not_written', 'modal_unobservable']]);
});

test('1270 F2: a supervised owner keeps its policy — a modal-looking screen during the hold does not gate the CR', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-supervised-modal', inputPolicy: 'user-supervised' });
  const p = b.pair('B1270-SUP-MODAL');
  b.frame(p.body);
  b.frame(p.submit);
  b.feed(MODAL);
  await settleVt();
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-SUP-MODAL', '\r']);
});

test('1270 F2: local typing AFTER the body write, during the hold — zero CR, quarantined not_written user_input_after_body', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-typing-hold' });
  const p = b.pair('B1270-TYPED');
  b.frame(p.body);
  b.frame(p.submit);
  await b.clock.advance(100);
  b.shared.lastUserInputTime = b.clock.now();   // a local keystroke into the same composer
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-TYPED']);
  assert.deepEqual(b.stages(p.submit.daemon_msg_id).filter(([stage]) => stage !== 'queued'), [['quarantined', 'not_written', 'user_input_after_body']]);
});

test('1270 F2 positive control: typing that ended BEFORE the body write is not intervening input — the CR is written once at the floor', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1270-typing-before' });
  b.shared.lastUserInputTime = b.clock.now();
  await b.clock.advance(2500);                  // past the idle window: the body may be written directly
  const p = b.pair('B1270-QUIET');
  b.frame(p.body);
  b.frame(p.submit);
  assert.deepEqual(b.child.writes, ['B1270-QUIET'], 'PRECONDITION: body written directly, CR held');
  await b.clock.advance(5000);
  assert.deepEqual(b.child.writes, ['B1270-QUIET', '\r']);
  assert.ok(crTimes(b.child)[0] - bodyTime(b.child, 'B1270-QUIET') >= GAP_MS);
});
