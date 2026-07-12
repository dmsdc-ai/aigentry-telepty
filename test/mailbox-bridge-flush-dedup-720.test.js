'use strict';

// #720 — bridge mailbox stale-inject dedup/expiry.
//
// REPRODUCTION (Phase 1): when the bridge promptReady gate stays closed for a
// long window (broken matcher / TUI boot), each inject PARKS in the bridge
// mailbox. cli.js `flushBridgeMailbox()` then dequeues EVERY pending message and
// writes them all — so N identical parked questions are delivered N times (the
// target answered the same question 3× live on 2026-07-12), and a parked inject
// that has gone stale is still delivered.
//
// This test drives the real FileMailbox exactly as the bridge does
// (enqueueBridgeMessage → unique msg_id per inject; flushBridgeMailbox →
// dequeue-until-empty batch) and asserts the CURRENT buggy behavior, pinning the
// bug before the fix. Phase 2 adds failing-first tests for the fixed behavior.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FileMailbox } = require('../src/mailbox/index');
const {
  filterBridgeBatch,
  bridgeInjectTtlSecs,
} = require('../src/mailbox/bridge-flush-filter');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-720-'));
}

// Mirror cli.js enqueueBridgeMessage: every inject gets a UNIQUE msg_id, so the
// mailbox's built-in msg_id dedup never collapses identical *content*.
function enqueueInject(mb, target, text, createdAt) {
  let seq = enqueueInject._seq = (enqueueInject._seq || 0) + 1;
  mb.enqueue({
    msg_id: `${target}:${createdAt}:${seq}`,
    from: 'daemon', to: target,
    payload: text, created_at: createdAt, attempt: 0,
  });
}

// Mirror cli.js flushBridgeMailbox: dequeue until empty → batch to be written.
function flushBatch(mb, target) {
  const batch = [];
  while (true) {
    const msg = mb.dequeue(target);
    if (!msg) break;
    batch.push(msg);
  }
  return batch;
}

test('#720 reproduce: N identical parked injects all flush (no dedup)', () => {
  const mb = new FileMailbox({ root: tmpRoot() });
  const target = 'codex-sid';
  const now = Math.floor(Date.now() / 1000);
  const question = 'REPORT: status?\r';

  // Gate closed → same question parked 3× (distinct msg_ids).
  enqueueInject(mb, target, question, now);
  enqueueInject(mb, target, question, now);
  enqueueInject(mb, target, question, now);

  // Gate opens → flush.
  const batch = flushBatch(mb, target);

  // BUG: all 3 delivered → target answers the same question 3×.
  assert.equal(batch.length, 3, 'current behavior delivers every duplicate');
  assert.ok(batch.every(m => m.payload === question));
});

test('#720 reproduce: a stale parked inject still flushes (no bridge TTL)', () => {
  const mb = new FileMailbox({ root: tmpRoot() });
  const target = 'codex-sid';
  const now = Math.floor(Date.now() / 1000);

  // Parked 15 min ago — well past any sane bridge inject window, but far under
  // the mailbox's 24h ttlSecs so enqueue accepts it and nothing drops it later.
  enqueueInject(mb, target, 'stale question\r', now - 15 * 60);

  const batch = flushBatch(mb, target);

  // BUG: stale inject delivered as if fresh.
  assert.equal(batch.length, 1, 'current behavior delivers stale injects');
});

// ---------------------------------------------------------------------------
// FIX (Phase 2): filterBridgeBatch — TTL drop + consecutive-payload dedup.
// ---------------------------------------------------------------------------

const mkMsg = (payload, createdAt, seq) => ({
  msg_id: `sid:${createdAt}:${seq}`, payload, created_at: createdAt, to: 'sid',
});

test('#720 fix: stale parked injects dropped (reason=stale)', () => {
  const now = 1_000_000;
  const batch = [
    mkMsg('old\r', now - 700, 1),   // > 600s → stale
    mkMsg('fresh\r', now - 10, 2),  // within TTL
  ];
  const { deliver, dropped } = filterBridgeBatch(batch, { ttlSecs: 600, nowSecs: now });
  assert.deepEqual(deliver.map(m => m.payload), ['fresh\r']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'stale');
  assert.equal(dropped[0].msg.payload, 'old\r');
});

test('#720 fix: consecutive identical payloads collapse to one (reason=duplicate)', () => {
  const now = 1_000_000;
  const q = 'REPORT: status?\r';
  const batch = [mkMsg(q, now, 1), mkMsg(q, now, 2), mkMsg(q, now, 3)];
  const { deliver, dropped } = filterBridgeBatch(batch, { ttlSecs: 600, nowSecs: now });
  assert.equal(deliver.length, 1, 'the 3× question delivers once');
  assert.equal(deliver[0].msg_id, 'sid:1000000:1', 'first copy wins');
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every(d => d.reason === 'duplicate'));
});

test('#720 fix: distinct payloads all deliver (no false dedup)', () => {
  const now = 1_000_000;
  const batch = [mkMsg('a\r', now, 1), mkMsg('b\r', now, 2), mkMsg('c\r', now, 3)];
  const { deliver, dropped } = filterBridgeBatch(batch, { ttlSecs: 600, nowSecs: now });
  assert.deepEqual(deliver.map(m => m.payload), ['a\r', 'b\r', 'c\r']);
  assert.equal(dropped.length, 0);
});

test('#720 fix: non-consecutive repeat survives (Q,R,Q — intentional re-ask)', () => {
  const now = 1_000_000;
  const batch = [mkMsg('Q\r', now, 1), mkMsg('R\r', now, 2), mkMsg('Q\r', now, 3)];
  const { deliver, dropped } = filterBridgeBatch(batch, { ttlSecs: 600, nowSecs: now });
  assert.deepEqual(deliver.map(m => m.payload), ['Q\r', 'R\r', 'Q\r']);
  assert.equal(dropped.length, 0);
});

test('#720 fix: a lone CR submit chunk is never deduped against a body', () => {
  // Defensive: if daemon ever parks body and CR separately, [body, \r, body2, \r]
  // must NOT collapse the two \r submits — they follow different bodies.
  const now = 1_000_000;
  const batch = [mkMsg('body1', now, 1), mkMsg('\r', now, 2), mkMsg('body2', now, 3), mkMsg('\r', now, 4)];
  const { deliver } = filterBridgeBatch(batch, { ttlSecs: 600, nowSecs: now });
  assert.deepEqual(deliver.map(m => m.payload), ['body1', '\r', 'body2', '\r']);
});

test('#720 fix: bridgeInjectTtlSecs — default 600, env override, invalid falls back', () => {
  assert.equal(bridgeInjectTtlSecs({}), 600, 'default 10 min');
  assert.equal(bridgeInjectTtlSecs({ TELEPTY_BRIDGE_INJECT_TTL_SECS: '120' }), 120, 'env override honored');
  assert.equal(bridgeInjectTtlSecs({ TELEPTY_BRIDGE_INJECT_TTL_SECS: 'nope' }), 600, 'NaN → default');
  assert.equal(bridgeInjectTtlSecs({ TELEPTY_BRIDGE_INJECT_TTL_SECS: '0' }), 600, '<=0 → default');
  assert.equal(bridgeInjectTtlSecs({ TELEPTY_BRIDGE_INJECT_TTL_SECS: '-5' }), 600, 'negative → default');
});
