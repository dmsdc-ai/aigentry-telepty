'use strict';

// Task 1292 rc-fix6 — the reply-capability guard at the wrapped bridge's final write (SUPPORT-MATRIX.md P2).
//
// A reply-capability inject frame carries reply_not_after_ms, reply_session_epoch and reply_child_seq (an ordinary frame
// carries none; rc-fix7 GB2-06 dropped the relative reply_ttl_ms). At every point where the bridge writes such a body or
// its CR to the child — the direct write and the deferred (held) submit — the instance (session epoch + owner generation
// of the current owner binding, the child_seq of the current live child) and the deadline (the wall clock, and the wall
// clock at receipt plus the monotonic time elapsed since, plus a 1500 ms submit headroom for a body) are checked
// immediately before child.write. rc-fix7 GB2-03: a reply record is never queued. A refusal writes zero bytes for that
// record and says so on the existing receipt channel (refused, not_written).
//
// Expected to FAIL on the rc-fix5 snapshot (src/cli/security-actions.js ignores the reply_* fields and writes) through
// actual effects (child.write calls), and to pass on the candidate. The two golden tests pass on both by design.
//
// Real seams: createAllowSecurityContext + spawnChild/subscribeChild + handleOwnerInject, the delivery/hold timers, the
// real FileMailbox and bridge-flush-filter. Declared fakes: clock/timers (Node's 0->1 ms coercion, plus `stall` = an
// event-loop stall: time passes and due timers fire late), child doubles, owner-WS send recorder, 80x24 stdout.
// "PRECONDITION:" = invalid setup. "CHECKPOINT:" = an intermediate product state.

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

const OWNER_GENERATION = 'owner-gen-1292-current';
const EPOCH = 'epoch-1292';   // not 22 characters: spawnChild's metadata refresh stays local (no request is built)

function createClock() {
  let now = Math.floor((Date.now() - 3 * 3600 * 1000) / 1000) * 1000;
  let seq = 0; let fired = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
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
    // An event-loop stall: the clock moves on and nothing fires until the next advance (then due timers fire late).
    stall(ms) { now += ms; },
  };
  return clock;
}

function childDouble(clock, name) {
  const handlers = { data: null, exit: null };
  const child = {
    pid: 5292, name, writes: [], attempts: 0,
    write(data) { child.attempts++; child.writes.push(String(data)); },
    resize() {}, kill() { throw new Error('PRECONDITION: native kill is not part of this fixture'); },
    onData(fn) { handlers.data = fn; }, onExit(fn) { handlers.exit = fn; },
    emit(data) { if (handlers.data) handlers.data(data); },
  };
  return child;
}

function createBridge(t, { sid, command = 'codex' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1292-reply-'));
  const clock = createClock();
  const skew = { wallBack: 0 };   // rc-fix7 GB2-06: the bridge's wall clock may step back; its monotonic clock never does
  const sends = [];
  const stdout = { columns: 80, rows: 24, isTTY: true, write() { return true; } };
  const children = [];
  // spawnChild resolves the command through %PATHEXT% on Windows (win-spawn-target.js); a fixture shim satisfies it.
  const sessionEnv = {};
  if (process.platform === 'win32') {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, `${command}.cmd`), '@echo off\r\n');
    Object.assign(sessionEnv, { PATH: bin, PATHEXT: '.CMD' });
  }
  const shared = {
    sessionId: sid, command, cmdArgs: [], sshPlan: null, child: null, handoffPending: null, idleTtl: null,
    detectedBackend: 'fixture', terminalProgram: 'fixture', terminalType: 'xterm-256color',
    DAEMON_URL: 'http://127.0.0.1:9', fetchWithAuth: () => Promise.reject(new Error('no network in fixture')),
    sessionCwd: root, sessionEnv, bridgeTarget: sid, bridgeMsgSeq: 0, bridgePendingCount: 0,
    promptReady: false, lastUserInputTime: 0, IDLE_THRESHOLD: 2000,
    knownAiCli: registry.isKnownAiCli(command), outputTail: '', readyRegistry: registry, readyQualification: null,
    promptPattern: /[❯>$#%]\s*$/, firstReadyObserved: false, queueFlushTimer: null, idleCheckTimer: null,
    reconnectTimer: null, heartbeatTimer: null,
    filterBridgeBatch: flushFilter.filterBridgeBatch, bridgeInjectTtlSecs: flushFilter.bridgeInjectTtlSecs,
    interactionBinding: { sid, session_epoch: EPOCH, credential_generation: 1,
      owner_generation: OWNER_GENERATION, input_generation: 0, geometry_generation: 0 },
    wsReady: true,
    daemonWs: { readyState: 1, send(raw) { sends.push(JSON.parse(String(raw))); }, close() {} },
    getTerminalSize, allowSessionClosed: false, cleanupTerminal() {}, currentOwnerToken: 'synthetic-owner-token',
    allowSignalHandlers: new Map(), FileMailbox, path, os,
  };
  const allow = security.createAllowSecurityContext(shared, {
    now: () => clock.now() - skew.wallBack, monoNow: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    getStdout: () => stdout, removeSignalHandler() {},
    spawnPty() { const next = childDouble(clock, `child-${children.length}`); children.push(next); return next; },
    bridgeRoot: path.join(root, 'bridge'),
  });
  shared.bridgeMailbox = allow.createBridgeMailbox();
  const relay = allow.createOutputRelay({
    onInteraction: () => { shared.interactionBinding.input_generation++; },
    onBytes: () => {}, rewrite: d => d, write: () => {}, sendOutput: () => {},
    observeReady: d => allow.observePromptReady(d),
    onReady: () => { shared.promptReady = true; shared.firstReadyObserved = true; allow.flushBridgeMailbox(); },
  });
  function spawn() {
    const next = allow.spawnChild();
    assert.ok(next, 'PRECONDITION: spawnChild returned a child double');
    allow.subscribeChild(next, relay, () => {});
    return next;
  }
  const child = spawn();   // child_seq 1: the value the daemon learns from this child's process_started milestone
  assert.equal(shared.child, child, 'PRECONDITION: the spawned child is current');
  function frame(msg) { return allow.handleOwnerInject(msg); }
  let seq = 0;
  function pair(text) {
    seq++;
    const injectId = `00000000-0000-4129-8000-${String(seq).padStart(12, '0')}`;
    const body = { type: 'inject', data: text, daemon_msg_id: `dm1292-${seq}-body:reply-capability-v1`, inject_id: injectId,
      part: 'body', owner_generation: OWNER_GENERATION };
    const submit = { type: 'inject', data: '\r', daemon_msg_id: `dm1292-${seq}-body:reply-capability-v1:submit`, part: 'submit',
      pair: body.daemon_msg_id, owner_generation: OWNER_GENERATION };
    return { body, submit };
  }
  // The reply_* fields exactly as the daemon builds them (replyFrameFields): the absolute deadline and the instance facts.
  function reply(notAfter, over = {}) {
    return { reply_not_after_ms: notAfter, reply_session_epoch: EPOCH, reply_child_seq: 1, ...over };
  }
  const receipts = () => sends.filter(m => m.type === 'bridge_receipt');
  const stages = id => receipts().filter(r => r.daemon_msg_id === id).map(r => [r.stage, r.certainty, r.reason ?? null]);
  t.after(() => {
    try { allow.closeAllowSession({ destroySession: false }); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { shared, allow, clock, skew, child, children, spawn, sends, frame, pair, reply, receipts, stages };
}

const NOT_WRITTEN = reason => ['refused', 'not_written', reason];

// ── control ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('rc-fix6 control: an in-time reply on a quiet surface — body written directly, CR held for its gap and written', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1292-control' });
  const p = b.pair('R-CONTROL');
  const notAfter = b.clock.now() + 60000;
  b.frame({ ...p.body, ...b.reply(notAfter) });
  assert.deepEqual(b.child.writes, ['R-CONTROL'], 'CHECKPOINT: body written directly');
  await b.clock.advance(5);
  b.frame({ ...p.submit, ...b.reply(notAfter) });
  await b.clock.advance(1000);
  assert.deepEqual(b.child.writes, ['R-CONTROL', '\r']);
  assert.deepEqual(b.stages(p.body.daemon_msg_id), [['pty_written', 'written', null]]);
  assert.deepEqual(b.stages(p.submit.daemon_msg_id), [['pty_written', 'written', null]]);
});

// ── the immediate (direct) write ─────────────────────────────────────────────────────────────────────────────────
test('rc-fix6 direct write: a reply body without its submit headroom (or past its deadline) is dropped — zero bytes, drop reported', { timeout: 30000 }, async t => {
  for (const [label, offset, reason] of [['inside the 1500 ms headroom', 1000, 'reply_submit_headroom'],   // rc-fix7 GB2-10: own reason
    ['already past not_after', -1, 'reply_deadline_passed']]) {
    const b = createBridge(t, { sid: `b1292-direct-${offset < 0 ? 'past' : 'headroom'}` });
    const p = b.pair('R-DIRECT');
    const notAfter = b.clock.now() + offset;
    b.frame({ ...p.body, ...b.reply(notAfter) });
    await b.clock.advance(5);
    b.frame({ ...p.submit, ...b.reply(notAfter) });
    await b.clock.advance(2000);
    assert.equal(b.child.attempts, 0, `${label}: child.write was never called`);
    assert.deepEqual(b.stages(p.body.daemon_msg_id), [NOT_WRITTEN(reason)], label);
    assert.deepEqual(b.stages(p.submit.daemon_msg_id), [NOT_WRITTEN('pair_unwritten')], `${label}: its CR is never written alone`);
  }
});

// ── rc-fix7 GB2-03: a reply record is never queued, never persisted ─────────────────────────────────────────────
// Fails on the snapshot, which queued the body in the bridge's FileMailbox (a row a later recovery path could replay).
test('GB2-03 a reply body that would have to queue behind local typing is refused, never queued or persisted', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1292-noqueue' });
  const p = b.pair('R-NOQUEUE');
  const notAfter = b.clock.now() + 60000;
  b.shared.lastUserInputTime = b.clock.now();   // the human is typing: a direct write is not permitted now
  b.frame({ ...p.body, ...b.reply(notAfter) });
  await b.clock.advance(5);
  b.frame({ ...p.submit, ...b.reply(notAfter) });
  assert.deepEqual(b.stages(p.body.daemon_msg_id), [NOT_WRITTEN('reply_not_queued')], 'refused, never queued');
  const rows = b.shared.bridgeMailbox.peek(b.shared.bridgeTarget).filter(m => m.state === 'pending' || m.state === 'in_flight');
  assert.deepEqual(rows, [], 'no row of this reply exists for any recovery path');
  assert.equal(b.shared.bridgePendingCount, 0);
  await b.clock.advance(6000);
  assert.equal(b.child.attempts, 0, 'neither the body nor its CR reached the child');
  assert.deepEqual(b.stages(p.submit.daemon_msg_id), [NOT_WRITTEN('pair_unwritten')], 'its CR is never written alone');
});

test('rc-fix6 enqueue: a reply body that would have to queue without its submit headroom is dropped instead of queued', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1292-enqueue' });
  const p = b.pair('R-ENQUEUE');
  b.shared.lastUserInputTime = b.clock.now();
  b.frame({ ...p.body, ...b.reply(b.clock.now() + 1000) });
  assert.deepEqual(b.stages(p.body.daemon_msg_id), [NOT_WRITTEN('reply_submit_headroom')], 'refused, never queued');   // rc-fix7 GB2-10
  assert.equal(b.shared.bridgePendingCount, 0);
  await b.clock.advance(6000);
  assert.equal(b.child.attempts, 0);
});

// ── the deferred (held) submit ───────────────────────────────────────────────────────────────────────────────────
test('rc-fix6 deferred submit: the held CR wakes after not_after (event-loop stall) — not written, drop reported, composer stranded', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1292-held' });
  const p = b.pair('R-HELD');
  const notAfter = b.clock.now() + 1600;   // the body passes its headroom (now + 1500 <= not_after)
  b.frame({ ...p.body, ...b.reply(notAfter) });
  assert.deepEqual(b.child.writes, ['R-HELD'], 'CHECKPOINT: body written in time');
  await b.clock.advance(5);
  b.frame({ ...p.submit, ...b.reply(notAfter) });
  assert.deepEqual(b.child.writes, ['R-HELD'], 'CHECKPOINT: the CR is held for its submit gap');
  b.clock.stall(2000);            // the held CR's 250 ms timer fires ~2 s late, after not_after
  await b.clock.advance(10);
  assert.deepEqual(b.child.writes, ['R-HELD'], 'zero bytes of the CR after the deadline');
  assert.equal(b.child.attempts, 1);
  assert.deepEqual(b.stages(p.submit.daemon_msg_id), [NOT_WRITTEN('reply_deadline_passed')]);
  // Task 1270 R1: the body sits unsubmitted, so this child's composer is stranded — a later ordinary pair is refused.
  await b.clock.advance(3000);
  const later = b.pair('LATER');   // an ordinary pair (no reply_* fields)
  b.frame(later.body);
  await b.clock.advance(5);
  b.frame(later.submit);
  await b.clock.advance(3000);
  assert.deepEqual(b.child.writes, ['R-HELD'], 'nothing is appended to the stranded composer');
  assert.deepEqual(b.stages(later.body.daemon_msg_id), [NOT_WRITTEN('composer_stranded')]);
});

// ── instance ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('rc-fix6 instance: a reply for another session epoch or another child is dropped at the direct write — zero bytes', { timeout: 30000 }, async t => {
  for (const [label, over] of [['other session epoch', { reply_session_epoch: 'epoch-other' }], ['other child', { reply_child_seq: 2 }],
    ['malformed child', { reply_child_seq: '1' }], ['other owner generation', { owner_generation: 'owner-gen-1292-next' }]]) {
    const b = createBridge(t, { sid: `b1292-inst-${label.replace(/\W+/g, '-')}` });
    const p = b.pair('R-INSTANCE');
    const notAfter = b.clock.now() + 60000;
    b.frame({ ...p.body, ...b.reply(notAfter, over) });
    await b.clock.advance(5);
    b.frame({ ...p.submit, ...b.reply(notAfter, over) });
    await b.clock.advance(2000);
    assert.equal(b.child.attempts, 0, label);
    assert.deepEqual(b.stages(p.body.daemon_msg_id), [NOT_WRITTEN('reply_instance_changed')], label);
  }
});

// rc-fix7 GB2-06: one absolute deadline, compared at the write with the wall clock now AND with the wall clock at receipt
// plus the monotonic time elapsed since — a wall clock that steps back after the frame arrived cannot extend the window.
test('GB2-06 the wall clock steps back after the CR frame arrived: the held CR is still refused at not_after (elapsed since receipt)', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1292-wallback' });
  const p = b.pair('R-WALLBACK');
  const notAfter = b.clock.now() + 1600;
  b.frame({ ...p.body, ...b.reply(notAfter) });
  assert.deepEqual(b.child.writes, ['R-WALLBACK'], 'CHECKPOINT: body written in time');
  await b.clock.advance(5);
  b.frame({ ...p.submit, ...b.reply(notAfter) });
  assert.deepEqual(b.child.writes, ['R-WALLBACK'], 'CHECKPOINT: the CR is held for its submit gap');
  b.skew.wallBack = 5000;   // the wall clock steps back 5 s; by the wall clock alone the CR would still be in time
  b.clock.stall(2000);
  await b.clock.advance(20000);
  assert.deepEqual(b.child.writes, ['R-WALLBACK'], 'zero bytes of the CR after not_after');
  assert.deepEqual(b.stages(p.submit.daemon_msg_id), [NOT_WRITTEN('reply_deadline_passed')]);
});

// ── golden: the ordinary inject is unchanged ─────────────────────────────────────────────────────────────────────
test('rc-fix6 golden: an ordinary pair (no reply_* fields) produces exactly the pre-change writes and receipts', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'b1292-golden' });
  const p = b.pair('ORDINARY');
  b.frame(p.body);
  await b.clock.advance(5);
  b.frame(p.submit);
  await b.clock.advance(1000);
  assert.deepEqual(b.child.writes, ['ORDINARY', '\r']);
  assert.deepEqual(b.receipts().map(r => [r.daemon_msg_id, r.inject_id, r.part, r.bridge_msg_id, r.stage, r.reason, r.certainty, r.owner_generation]), [
    [p.body.daemon_msg_id, p.body.inject_id, 'body', null, 'pty_written', null, 'written', OWNER_GENERATION],
    [p.submit.daemon_msg_id, null, 'submit', null, 'pty_written', null, 'written', OWNER_GENERATION],
  ]);
  // Queued path: same records, same receipts as before the change.
  const q = createBridge(t, { sid: 'b1292-golden-queued' });
  const qp = q.pair('QUEUED');
  q.shared.lastUserInputTime = q.clock.now();
  q.frame(qp.body);
  await q.clock.advance(5);
  q.frame(qp.submit);
  await q.clock.advance(6000);
  assert.deepEqual(q.child.writes, ['QUEUED', '\r']);
  assert.deepEqual(q.stages(qp.body.daemon_msg_id), [['queued', 'not_written', null], ['pty_written', 'written', null]]);
  assert.deepEqual(q.stages(qp.submit.daemon_msg_id), [['queued', 'not_written', null], ['pty_written', 'written', null]]);
});
