'use strict';

// Task 1292 W1 — unit coverage for the reply-capability-v1 store (src/reply-capability.js).
// TEST-PLAN ids owned by W1: U1 and U15 (store part). Store-level supporting tests: U4s, U5s, U6s, U7s(a-c), U12s.
// They do not replace W3's route-level U4-U12. The clocks, the RNG and the timers are injected.
// No network, no daemon, no file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const rc = require('../src/reply-capability');
const { verifierFor } = require('../src/session-store/session-credentials');

const { createReplyCapabilityStore, parseToken, replyCapabilityTrailer, TOKEN_RE, STATES } = rc;

const T0 = 1800000000000;
const MARGIN = 15000;
const R = { sid: 'responder-a', epoch: 'epoch-r1', generation: 1 };
const Q = { sid: 'requester-q', epoch: 'epoch-q1', generation: 1 };
const PREFIX = 'REPLY 0123456789abcdef0123456789abcdef\n';

function harness(extra = {}) {
  const clock = { wall: T0, mono: 1000 };
  const store = createReplyCapabilityStore({
    now: () => clock.wall,
    monoNow: () => clock.mono,
    ...extra,
    limits: { acceptMarginMs: MARGIN, ...(extra.limits || {}) }
  });
  return { clock, store };
}

function mintOne(store, clock, over = {}) {
  const minted = store.mint({ responder: R, requester: Q, inbound_inject_id: 'inbound-1', reply_prefix: PREFIX,
    not_after_ms: clock.wall + 600000, ...over });
  assert.equal(minted.ok, true, `mint refused: ${minted.code}`);
  return minted;
}

function wrongSecret(token) {
  const last = token.at(-1) === 'A' ? 'B' : 'A';
  return token.slice(0, -1) + last;
}

// Takes a minted capability through C3/C4, C5/C6 and C11, as the W3 route does.
function spend(store, token, body) {
  const resolved = store.resolve(token);
  assert.equal(resolved.ok, true);
  const state = store.checkState(resolved.id, body);
  assert.equal(state.ok, true, `checkState refused: ${state.code}`);
  const begun = store.begin(resolved.id, body);
  assert.equal(begun.ok, true);
  return begun;
}

test('U1 token shape: 10 000 mints give unique ids and well-formed tokens from the injected CSPRNG', () => {
  const sizes = [];
  const { clock, store } = harness({
    randomBytes: (n) => { sizes.push(n); return crypto.randomBytes(n); },
    limits: { maxLiveGlobal: 20000, maxLivePerResponder: 20000, maxLivePerRequester: 20000 }
  });
  const ids = new Set();
  for (let i = 0; i < 10000; i += 1) {
    const minted = mintOne(store, clock);
    assert.equal(minted.token.length, 70);
    assert.match(minted.token, TOKEN_RE);
    assert.equal(minted.id.length, 22);
    assert.equal(minted.token.slice(4, 26), minted.id);
    assert.deepEqual(parseToken(minted.token), { id: minted.id });
    ids.add(minted.id);
  }
  assert.equal(ids.size, 10000);
  assert.equal(store.size(), 10000);
  assert.deepEqual([...new Set(sizes)].sort((a, b) => a - b), [16, 32]);
});

test('U1 verifier at rest: the record holds sha256(token) only, never the token or its secret', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  const secret = minted.token.split('.')[2];
  const record = store.get(minted.id);
  assert.equal(record.verifier, verifierFor(minted.token));
  assert.equal(record.verifier, crypto.createHash('sha256').update(minted.token).digest('hex'));
  const seen = [];
  (function scan(value) {
    if (typeof value === 'string') seen.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) scan(v);
  })(record);
  for (const s of seen) {
    assert.ok(!s.includes(secret), 'secret must not be in the record');
    assert.ok(!s.includes(minted.token), 'token must not be in the record');
  }
  const view = JSON.stringify(store.publicView(minted.id));
  assert.ok(!view.includes(secret));
  assert.deepEqual(store.publicView(minted.id), { v: 1, id: minted.id, not_after_ms: minted.not_after_ms,
    responder: { session_id: R.sid, epoch: R.epoch, generation: R.generation } });
});

test('U1 no oracle: an unknown id and a wrong secret get the same refusal', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  const unknownId = `rc1.${'Z'.repeat(22)}.${minted.token.split('.')[2]}`;
  const a = store.resolve(unknownId);
  const b = store.resolve(wrongSecret(minted.token));
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(a.code, 'REPLY_CAPABILITY_UNKNOWN');
  assert.equal(b.code, a.code);
  assert.deepEqual(Object.keys(a), Object.keys(b));
  assert.deepEqual(rc.refusalAnswer(a.code), rc.refusalAnswer(b.code));
  assert.deepEqual(rc.refusalAnswer(a.code), { status: 404, result: rc.buildResult({ stage: 'refused', reason: 'REPLY_CAPABILITY_UNKNOWN' }) });
  for (const bad of [undefined, null, '', 'rc1.short.x', minted.token + 'x', minted.token.replace('rc1.', 'rc2.')]) {
    assert.equal(store.resolve(bad).code, 'REPLY_REQUEST_INVALID');
  }
});

test('U15 store part: mint, consume, settle, sweep, sweeper and restart touch no file and log nothing', () => {
  const calls = [];
  const restore = [];
  const names = ['open', 'openSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync',
    'unlink', 'unlinkSync', 'mkdir', 'mkdirSync', 'rmdir', 'rmdirSync', 'rm', 'rmSync', 'createWriteStream', 'copyFile', 'copyFileSync'];
  for (const [target, label] of [[fs, 'fs'], [fs.promises, 'fs.promises']]) {
    for (const name of names) {
      if (typeof target[name] !== 'function') continue;
      const original = target[name];
      target[name] = function spy(...args) { calls.push(`${label}.${name}`); return original.apply(this, args); };
      restore.push(() => { target[name] = original; });
    }
  }
  for (const name of ['log', 'error', 'warn', 'info', 'debug']) {
    const original = console[name];
    console[name] = (...args) => { calls.push(`console.${name}`); return original.apply(console, args); };
    restore.push(() => { console[name] = original; });
  }
  try {
    const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
    const { clock, store } = harness({ timers });
    const a = mintOne(store, clock);
    const begun = spend(store, a.token, 'answer');
    store.settle(begun.capability_id, { success: true });
    store.checkState(begun.capability_id, 'answer');
    const b = mintOne(store, clock);
    spend(store, b.token, 'x');
    store.settleThrown(b.id);
    store.chargeRefusal(null);
    store.resolve(wrongSecret(a.token));
    const stop = store.startSweeper({ isInstanceLive: () => true });
    clock.wall += 3600000 * 2;
    store.sweep({ isInstanceLive: () => false });
    stop();
    const restarted = harness({ timers }).store;
    assert.equal(restarted.resolve(a.token).code, 'REPLY_CAPABILITY_UNKNOWN');
  } finally {
    for (const undo of restore.reverse()) undo();
  }
  assert.deepEqual(calls, []);
});

test('U4s a wrong secret neither consumes nor revokes; the right token is then accepted', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  const before = store.get(minted.id);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(store.resolve(wrongSecret(minted.token)).code, 'REPLY_CAPABILITY_UNKNOWN');
  }
  assert.deepEqual(store.get(minted.id), before);
  const begun = spend(store, minted.token, 'the reply');
  assert.equal(begun.attempt, 1);
  assert.equal(begun.delivered_text, PREFIX + 'the reply');
  assert.deepEqual(begun.requester, Q);
  assert.deepEqual(begun.responder, R);
  assert.equal(begun.inbound_inject_id, 'inbound-1');
  assert.equal(store.get(minted.id).state, STATES.IN_FLIGHT);
});

test('U5s single in_flight: further presentations see IN_FLIGHT; after settle the same body replays and another is CONSUMED', () => {
  let n = 0;
  const { clock, store } = harness({ randomUUID: () => `uuid-${++n}` });
  const minted = mintOne(store, clock);
  const begun = spend(store, minted.token, 'body-1');
  assert.equal(begun.reply_inject_id, 'uuid-1');
  for (let i = 0; i < 50; i += 1) {
    const state = store.checkState(minted.id, i % 2 ? 'body-1' : `other-${i}`);
    assert.equal(state.ok, false);
    assert.equal(state.code, 'REPLY_CAPABILITY_IN_FLIGHT');
    assert.equal(state.answer.status, 409);
    assert.equal(state.answer.result.retryable, true);
    assert.equal(state.answer.result.capability_id, minted.id);
    assert.equal(store.begin(minted.id, 'body-1').ok, false);
  }
  assert.equal(store.resolve(wrongSecret(minted.token)).ok, false);
  assert.equal(store.get(minted.id).state, STATES.IN_FLIGHT);
  assert.equal(store.get(minted.id).attempts, 1);
  const first = store.settle(minted.id, { success: true }, { queued: false });
  assert.equal(first.answer.status, 200);
  const replay = store.checkState(minted.id, 'body-1');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.answer, { status: 200, result: { ...first.answer.result, replayed: true } });
  const other = store.checkState(minted.id, 'body-2');
  assert.equal(other.code, 'REPLY_CAPABILITY_CONSUMED');
  assert.equal(other.answer.status, 409);
  assert.equal(store.begin(minted.id, 'body-2').ok, false);
});

const SETTLE_ROWS = [
  { name: 'delivered', delivery: { success: true }, queued: false, state: 'consumed', status: 200, stage: 'accepted', outcome: 'delivered' },
  { name: 'queued', delivery: { success: true }, queued: true, state: 'consumed', status: 200, stage: 'accepted', outcome: 'queued' },
  { name: 'uncertain', delivery: { success: false, code: 'DELIVERY_UNCERTAIN', httpStatus: 504, delivery_uncertain: true, bytes_written: null },
    state: 'unknown', status: 500, stage: 'outcome_unknown', reason: null },
  { name: 'bytes_written null', delivery: { success: false, code: 'TIMEOUT', httpStatus: 504, bytes_written: null },
    state: 'unknown', status: 500, stage: 'outcome_unknown', reason: null },
  { name: 'SESSION_GONE while uncertain', delivery: { success: false, code: 'SESSION_GONE', httpStatus: 410, delivery_uncertain: true, bytes_written: null },
    state: 'unknown', status: 500, stage: 'outcome_unknown', reason: null },
  { name: 'SESSION_GONE', delivery: { success: false, code: 'SESSION_GONE', httpStatus: 410 },
    state: 'revoked', status: 410, stage: 'refused', reason: 'REPLY_DESTINATION_GONE', later: 'REPLY_DESTINATION_GONE' },
  { name: 'SESSION_CLOSING', delivery: { success: false, code: 'SESSION_CLOSING', httpStatus: 409, bytes_written: 0 },
    state: 'revoked', status: 410, stage: 'refused', reason: 'REPLY_DESTINATION_GONE', later: 'REPLY_DESTINATION_GONE' },
  { name: 'REPLY_DEADLINE_PASSED', delivery: { success: false, code: 'REPLY_DEADLINE_PASSED', httpStatus: 410, bytes_written: 0 },
    state: 'expired', status: 410, stage: 'refused', reason: 'REPLY_CAPABILITY_EXPIRED', later: 'REPLY_CAPABILITY_EXPIRED' },
  { name: 'non-zero bytes_written', delivery: { success: false, code: 'DELIVERY_REJECTED', httpStatus: 502, bytes_written: 12 },
    state: 'unknown', status: 500, stage: 'outcome_unknown', reason: null }
];

for (const row of SETTLE_ROWS) {
  test(`U6s settlement row: ${row.name}`, () => {
    const { clock, store } = harness();
    const minted = mintOne(store, clock);
    const begun = spend(store, minted.token, 'reply-body');
    const settled = store.settle(minted.id, row.delivery, { queued: row.queued === true });
    assert.equal(settled.ok, true);
    assert.equal(settled.state, row.state);
    assert.equal(store.get(minted.id).state, row.state);
    assert.equal(settled.answer.status, row.status);
    assert.equal(settled.answer.result.stage, row.stage);
    assert.equal(settled.answer.result.retryable, false);
    assert.equal(settled.answer.result.capability_id, minted.id);
    assert.equal(settled.answer.result.reply_inject_id, begun.reply_inject_id);
    if (row.stage === 'accepted') {
      assert.equal(settled.answer.result.outcome, row.outcome);
      assert.equal(settled.answer.result.destination_session_id, Q.sid);
    } else {
      assert.equal(settled.answer.result.reason, row.reason);
      assert.equal(settled.answer.result.destination_session_id, null);
    }
    if (row.state === 'unknown' || row.state === 'consumed') {
      const replay = store.checkState(minted.id, 'reply-body');
      assert.deepEqual(replay.answer, { status: row.status, result: { ...settled.answer.result, replayed: true } });
      assert.equal(store.checkState(minted.id, 'another').code, 'REPLY_CAPABILITY_CONSUMED');
    } else {
      assert.equal(store.checkState(minted.id, 'reply-body').code, row.later);
    }
    assert.equal(store.begin(minted.id, 'reply-body').ok, false, 'a terminal record is never re-attempted');
    assert.equal(store.settle(minted.id, { success: true }).ok, false);
  });
}

test('U6s definitive zero-byte refusal re-arms up to 3 attempts, then VOID', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  const refusal = { success: false, code: 'QUEUE_TIMEOUT', httpStatus: 503, bytes_written: 0 };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const begun = spend(store, minted.token, `body-${attempt}`);
    assert.equal(begun.attempt, attempt);
    const settled = store.settle(minted.id, attempt === 2 ? { success: false, code: 'BODY_CUSTODY_FULL', httpStatus: 409 } : refusal);
    assert.equal(settled.answer.result.stage, 'refused');
    assert.equal(settled.answer.status, attempt === 2 ? 409 : 503);
    assert.equal(settled.answer.result.reason, attempt === 2 ? 'BODY_CUSTODY_FULL' : 'QUEUE_TIMEOUT');
    assert.equal(settled.answer.result.retryable, attempt < 3);
    assert.equal(settled.state, attempt < 3 ? STATES.ISSUED : STATES.VOID);
  }
  const later = store.checkState(minted.id, 'body-3');
  assert.equal(later.code, 'REPLY_CAPABILITY_VOID');
  assert.equal(later.answer.status, 410);
  assert.equal(store.begin(minted.id, 'body-4').ok, false);
});

test('U6s a delivery that threw settles as unknown (500) and is never re-attempted', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  spend(store, minted.token, 'b');
  const settled = store.settleThrown(minted.id);
  assert.equal(settled.state, STATES.UNKNOWN);
  assert.equal(settled.answer.status, 500);
  assert.equal(settled.answer.result.stage, 'outcome_unknown');
  assert.equal(store.checkState(minted.id, 'b').replayed, true);
  assert.equal(store.begin(minted.id, 'b').ok, false);
  assert.equal(store.settleThrown(minted.id).ok, false);
});

test('U7s(a) wall clock at not_after - margin is accepted; one ms later is EXPIRED', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  clock.wall = minted.not_after_ms - MARGIN;
  clock.mono += minted.not_after_ms - MARGIN - T0;
  assert.equal(store.checkState(minted.id, 'b').ok, true);
  clock.wall += 1;
  const late = store.checkState(minted.id, 'b');
  assert.equal(late.code, 'REPLY_CAPABILITY_EXPIRED');
  assert.equal(late.answer.status, 410);
  assert.equal(store.get(minted.id).state, STATES.EXPIRED);
});

test('U7s(b) wall clock jumps back 1 h while the monotonic clock passes the deadline -> EXPIRED', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  const deadlineMono = store.get(minted.id).deadline_mono_ms;
  clock.wall -= 3600000;
  clock.mono = deadlineMono - MARGIN + 1;
  assert.equal(store.checkState(minted.id, 'b').code, 'REPLY_CAPABILITY_EXPIRED');
  assert.equal(store.get(minted.id).state, STATES.EXPIRED);
});

test('U7s(c) wall clock jumps forward -> EXPIRED early although the monotonic clock has not moved', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  clock.wall += 3600000;
  assert.equal(store.checkState(minted.id, 'b').code, 'REPLY_CAPABILITY_EXPIRED');
});

test('U12s M8 deadline window and refusal without effect', () => {
  const { clock, store } = harness();
  assert.equal(store.deadlineRefusal(T0 + 30000), null);
  assert.equal(store.deadlineRefusal(T0 + 3600000), null);
  for (const bad of [T0 + 29999, T0 + 3600001, T0 + 30000.5, '1800000030000', NaN, null]) {
    assert.equal(store.deadlineRefusal(bad), 'REPLY_CAPABILITY_DEADLINE_INVALID');
    const refused = store.mint({ responder: R, requester: Q, inbound_inject_id: 'i', reply_prefix: PREFIX, not_after_ms: bad });
    assert.deepEqual(refused, { ok: false, code: 'REPLY_CAPABILITY_DEADLINE_INVALID' });
  }
  assert.equal(store.size(), 0);
  void clock;
});

test('U12s capacity: 64 per responder, 64 per requester, terminal records count until retention', () => {
  const { clock, store } = harness();
  for (let i = 0; i < 64; i += 1) mintOne(store, clock, { requester: { ...Q, sid: `q-${i}` } });
  assert.equal(store.capacityRefusal(R, { ...Q, sid: 'q-new' }), 'REPLY_CAPABILITY_CAPACITY');
  const refused = store.mint({ responder: R, requester: { ...Q, sid: 'q-new' }, inbound_inject_id: 'i', reply_prefix: PREFIX, not_after_ms: clock.wall + 60000 });
  assert.deepEqual(refused, { ok: false, code: 'REPLY_CAPABILITY_CAPACITY' });
  assert.equal(store.capacityRefusal({ ...R, generation: 2 }, Q), null, 'a rotated responder instance is a different instance');

  const h2 = harness();
  const all = [];
  for (let i = 0; i < 64; i += 1) all.push(mintOne(h2.store, h2.clock, { responder: { ...R, sid: `r-${i}` } }));
  assert.equal(h2.store.capacityRefusal({ ...R, sid: 'r-new' }, Q), 'REPLY_CAPABILITY_CAPACITY');
  const begun = spend(h2.store, all[0].token, 'b');
  h2.store.settle(begun.capability_id, { success: true });
  assert.equal(h2.store.capacityRefusal({ ...R, sid: 'r-new' }, Q), 'REPLY_CAPABILITY_CAPACITY', 'a consumed record still counts');
  h2.clock.wall = all[0].not_after_ms + 60000;
  assert.equal(h2.store.capacityRefusal({ ...R, sid: 'r-new' }, Q), null, 'retention ended, slots freed');
  assert.equal(h2.store.size(), 0);
});

test('U12s capacity: 4096 global', () => {
  const { clock, store } = harness();
  for (let r = 0; r < 64; r += 1) {
    for (let q = 0; q < 64; q += 1) mintOne(store, clock, { responder: { ...R, sid: `r-${r}` }, requester: { ...Q, sid: `q-${q}` } });
  }
  assert.equal(store.size(), 4096);
  assert.equal(store.capacityRefusal({ ...R, sid: 'r-x' }, { ...Q, sid: 'q-x' }), 'REPLY_CAPABILITY_CAPACITY');
  const refused = store.mint({ responder: { ...R, sid: 'r-x' }, requester: { ...Q, sid: 'q-x' }, inbound_inject_id: 'i',
    reply_prefix: PREFIX, not_after_ms: clock.wall + 60000 });
  assert.deepEqual(refused, { ok: false, code: 'REPLY_CAPABILITY_CAPACITY' });
  assert.equal(store.size(), 4096);
});

test('U12s retention: terminal records are deleted at not_after + 60 s and then answer UNKNOWN with no effect', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  spend(store, minted.token, 'b');
  store.settle(minted.id, { success: true });
  clock.wall = minted.not_after_ms + 60000 - 1;
  assert.equal(store.resolve(minted.token).ok, true);
  assert.equal(store.checkState(minted.id, 'b').replayed, true);
  clock.wall += 1;
  const gone = store.resolve(minted.token);
  assert.equal(gone.code, 'REPLY_CAPABILITY_UNKNOWN');
  assert.equal(store.get(minted.id), null);
  assert.equal(store.size(), 0);
});

test('U12s an in_flight record past retention is kept until it settles, then deleted', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  spend(store, minted.token, 'b');
  clock.wall = minted.not_after_ms + 120000;
  store.sweep();
  assert.equal(store.get(minted.id).state, STATES.IN_FLIGHT);
  store.settle(minted.id, { success: true });
  store.sweep();
  assert.equal(store.get(minted.id), null);
  assert.equal(store.size(), 0);
});

test('U12s sweep cost is proportional to expired entries, and the time sweep expires issued records', () => {
  const { clock, store } = harness({ limits: { maxLiveGlobal: 5000, maxLivePerResponder: 5000, maxLivePerRequester: 5000 } });
  const minted = [];
  for (let i = 0; i < 1000; i += 1) minted.push(mintOne(store, clock, { not_after_ms: T0 + 60000 + i * 1000 }));
  assert.equal(store.sweep().visited, 0);
  clock.wall = T0 + 60000 + 9 * 1000 - MARGIN + 1;
  const first = store.sweep();
  assert.equal(first.expired, 10);
  assert.equal(first.visited, 10);
  assert.equal(store.get(minted[9].id).state, STATES.EXPIRED);
  assert.equal(store.get(minted[10].id).state, STATES.ISSUED);
  clock.wall = T0 + 60000 + 9 * 1000 + 60000;
  const second = store.sweep();
  assert.equal(second.deleted, 10);
  assert.equal(store.size(), 990);
  assert.equal(second.expired, 74);
  assert.equal(second.visited, second.deleted + second.expired);
  assert.equal(first.visited, first.deleted + first.expired);
});

test('U12s liveness sweep (Root Q6): responder gone -> superseded, requester gone -> revoked; without a predicate time only', () => {
  const { clock, store } = harness();
  const a = mintOne(store, clock);
  const b = mintOne(store, clock, { responder: { ...R, sid: 'responder-b' } });
  store.sweep();
  assert.equal(store.get(a.id).state, STATES.ISSUED);
  const dead = new Set([JSON.stringify(R), JSON.stringify(Q)]);
  const result = store.sweep({ isInstanceLive: (p) => !dead.has(JSON.stringify(p)) });
  assert.equal(result.superseded, 1);
  assert.equal(result.revoked, 1);
  assert.equal(store.get(a.id).state, STATES.SUPERSEDED);
  assert.equal(store.get(b.id).state, STATES.REVOKED);
  assert.equal(store.checkState(a.id, 'x').code, 'REPLY_CAPABILITY_SUPERSEDED');
  assert.equal(store.checkState(b.id, 'x').code, 'REPLY_DESTINATION_GONE');
});

test('supersede (C7) and revoke (C9 / inbound refusal) move only issued records', () => {
  const { clock, store } = harness();
  const a = mintOne(store, clock);
  const b = mintOne(store, clock);
  assert.equal(store.supersede(a.id), true);
  assert.equal(store.supersede(a.id), false);
  assert.equal(store.revoke(b.id, 'inbound_refused'), true);
  assert.equal(store.get(b.id).revoked_reason, 'inbound_refused');
  assert.equal(store.checkState(b.id, 'x').code, 'REPLY_DESTINATION_GONE');
  assert.throws(() => store.revoke(b.id, 'whatever'), TypeError);
  const c = mintOne(store, clock);
  spend(store, c.token, 'x');
  assert.equal(store.revoke(c.id, 'requester_gone'), false, 'an in_flight record is settled, not revoked');
});

test('refusal budget (Root Q5): 8 lines per id, 10 per 60 s shared bucket, one suppressed counter', () => {
  const { clock, store } = harness();
  const minted = mintOne(store, clock);
  for (let i = 0; i < 8; i += 1) assert.deepEqual(store.chargeRefusal(minted.id), { emit: true, suppressed_count: 0 });
  assert.equal(store.chargeRefusal(minted.id).emit, false);
  assert.equal(store.chargeRefusal(minted.id).emit, false);
  assert.deepEqual(store.chargeRefusal(null), { emit: true, suppressed_count: 2 });
  for (let i = 0; i < 9; i += 1) assert.equal(store.chargeRefusal('not-held').emit, true);
  assert.equal(store.chargeRefusal(null).emit, false);
  clock.mono += 5999;
  assert.equal(store.chargeRefusal(null).emit, false);
  clock.mono += 6000;
  assert.deepEqual(store.chargeRefusal(null), { emit: true, suppressed_count: 2 });
  assert.equal(store.get(minted.id).state, STATES.ISSUED, 'the budget never changes state');
});

test('sweeper: never started at construction; one unref()d 60 s interval; stop clears it', () => {
  const log = [];
  let tick = null;
  const timers = {
    setInterval: (fn, ms) => { log.push(['set', ms]); tick = fn; return { unref() { log.push(['unref']); } }; },
    clearInterval: () => log.push(['clear'])
  };
  const { clock, store } = harness({ timers });
  assert.deepEqual(log, []);
  const minted = mintOne(store, clock);
  const stop = store.startSweeper({ isInstanceLive: () => { throw new Error('predicate bug'); } });
  assert.equal(store.startSweeper(), stop);
  assert.deepEqual(log, [['set', 60000], ['unref']]);
  assert.doesNotThrow(() => tick());
  assert.equal(store.get(minted.id).state, STATES.ISSUED);
  stop();
  stop();
  assert.deepEqual(log, [['set', 60000], ['unref'], ['clear']]);
});

// GB-06: SPEC §2.3 as amended — the printed command uses --file, which runs unchanged in POSIX shells, cmd.exe and
// PowerShell (no `<` input redirection).
test('trailer text is exactly SPEC §2.3', () => {
  const token = `rc1.${'A'.repeat(22)}.${'b'.repeat(43)}`;
  const trailer = replyCapabilityTrailer({ id: 'A'.repeat(22), token, not_after_ms: 1795262400000 });
  assert.equal(trailer,
    `\n\n⟦telepty:reply-capability v=1 id=${'A'.repeat(22)} expires=2026-11-21T12:00:00.000Z⟧\n`
    + 'To reply to this request once, write the reply text to reply.txt and run on this machine:\n'
    + `  telepty reply-v1 ${token} --file reply.txt\n`
    + '(or pipe the reply text to the same command without --file). The reply goes only to the requester and only once.\n'
    + `⟦telepty:end reply-capability id=${'A'.repeat(22)}⟧`);
});

test('mint rejects malformed input as a programming error and leaves no record', () => {
  const { clock, store } = harness();
  const base = { responder: R, requester: Q, inbound_inject_id: 'i', reply_prefix: PREFIX, not_after_ms: clock.wall + 60000 };
  for (const over of [{ reply_prefix: '' }, { reply_prefix: 'a\nb' }, { reply_prefix: 'x'.repeat(257) }, { reply_prefix: 'é' },
    { responder: { ...R, generation: 0 } }, { requester: { sid: 'q' } }, { inbound_inject_id: '' }]) {
    assert.throws(() => store.mint({ ...base, ...over }), TypeError);
  }
  assert.equal(store.size(), 0);
  assert.equal(rc.validReplyPrefix(PREFIX), true);
  assert.equal(rc.validReplyPrefix('x'.repeat(256)), true);
  assert.throws(() => createReplyCapabilityStore({ limits: { notALimit: 1 } }), TypeError);
});
