'use strict';

// Task 1273 — the persistent tracked-job COUNT is not an admission prerequisite (see test/ledger-job-count-removal-1273.test.js).
// Split590 (test-only): T6, F2, F4, TH1 and TH2 moved from test/ledger-job-count-removal-1273.test.js.
// The test bodies are moved verbatim; the shared helpers live in test/fixtures/ledger-1207/job-count-removal-1273.js.
// Each test runs on its own private HOME or owner store, so the four 1273 files share no ledger, lock or owner worker.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createOwnerHarness, readFrames, segmentFiles } = require('./fixtures/ledger-1207/owner-harness');
const { sha, makeSession, buildShared, recorders, inject, closeBounded, withStore, assertBusCorrelation, nowIso, ownerBegin, withOwnerStore, FAULT_FS, manifestTmps, segBytesOf, orphanSet, coreOf } = require('./fixtures/ledger-1207/job-count-removal-1273');

// ---------------------------------------------------------------------------------------------------
// T6 — no identity bypass: a reheated cold record still enforces the receipt identity predicate; an
// inject without `from` is not silently tracked (and a tracked one is never silently untracked).
// ---------------------------------------------------------------------------------------------------
test('1273 T6: beyond 512, identity checks stay: a bridge receipt for a reheated cold record with the wrong session or owner generation is refused; an inject without `from` stays untracked', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const ids = [];
  for (let i = 0; i < 600; i++) { const r = await inject(handler, 'w1', `t${i}`); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); ids.push(r.body.inject_id); }
  assert.equal((await ledgerClient.fetchTrackedInjection(ids[0])).tier, 'cold');
  const receipt = { inject_id: ids[0], stage: 'pty_written', part: 'body', certainty: 'observed', reason: null, daemon_msg_id: 'm', bridge_msg_id: 'b', bridge_seq: 1, at_ms: 1, clock: 'mono' };
  assert.equal(await runtime.recordBridgeReceipt('w2', shared.sessions.w2, receipt, undefined), 'receipt_identity_mismatch', 'wrong session');
  assert.equal(await runtime.recordBridgeReceipt('w1', shared.sessions.w1, receipt, 'gen-other'), 'receipt_identity_mismatch', 'wrong owner generation');
  const untracked = await inject(handler, 'w1', 'operator text', null);
  assert.equal(untracked.statusCode, 200, JSON.stringify(untracked.body));
  assert.equal(R.delivery[R.delivery.length - 1].injectId, null, 'untracked inject carries no tracked id');
  assert.equal(ledgerClient.readModel.getTrackedInjection(untracked.body.inject_id), null);
  assert.equal((await ledgerClient.fetchTrackedInjection(untracked.body.inject_id)).record, null);
}));

// ===================================================================================================
// #1273 correction (review559 F1–F4). Real inject handler / delivery runtime / ledger client / owner
// worker with the PRODUCTION constants (HOT_MAX_RECORDS 576, 64 MiB hot bytes); the transport and the
// bus are recorders. Owner-only fault cases drive the real owner in-process.
// ===================================================================================================

test('1273 F2: routine hot-pressure relief never demotes the CURRENT tracked record of a session registered without a live hint (register-route shape) — it stays hot for submit correlation and its next inject supersedes it', () => withStore(async (s) => {
  const R = recorders();
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R);
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  // added AFTER the ledger opened, as POST /api/sessions/register does: no ledgerClient.live() call
  shared.sessions.late = makeSession('late');
  const first = await inject(handler, 'late', 'task for a session registered without a live hint');
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  const n0 = (await ledgerClient.ownerStatus()).checkpoint.n;
  for (let i = 1; i <= 700; i++) { const r = await inject(handler, 'w1', `pressure ${i}`); assert.equal(r.statusCode, 200, `pressure #${i}: ${JSON.stringify(r.body)}`); }
  const owner = await ledgerClient.ownerStatus();
  assert.ok(owner.checkpoint.n > n0, `hot-pressure relief ran (${n0} -> ${owner.checkpoint.n})`);
  const rec = runtime.getTrackedInjection(first.body.inject_id);   // the hot read model submitCorrelationId reads
  assert.ok(rec, 'the current record of the hint-less session is still in the hot read model after relief');
  assert.equal(rec.tracking_state, 'tracked'); assert.equal(rec.session_id, 'late');
  assert.equal((await ledgerClient.fetchTrackedInjection(first.body.inject_id)).tier, 'hot');
  const second = await inject(handler, 'late', 'second task for the same session');
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.equal((await ledgerClient.fetchTrackedInjection(first.body.inject_id)).record.tracking_state, 'superseded', 'the next inject supersedes it (supersession reads the hot tier)');
  assert.equal(runtime.getTrackedInjection(second.body.inject_id).tracking_state, 'tracked');
  assertBusCorrelation(R);
  assert.deepEqual(R.unexpected, []);
}));

test('1273 F4: a MANIFEST failure AFTER the relief checkpoint changed owner memory fails the store CLOSED (unavailable_write + errno, published before the nack, before any further write); restart recovers the previous MANIFEST with every record, preserves the orphans and replays nothing', () => withOwnerStore(async (s, hs) => {
  let armed = false; const fired = [];
  const faulty = Object.create(fs);
  faulty.renameSync = (from, to) => {
    if (armed && String(to) === path.join(s.dir, 'MANIFEST.json')) { fired.push(String(from)); const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e; }
    return fs.renameSync(from, to);
  };
  const h = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70, fsImpl: faulty }); hs.push(h);
  assert.equal(h.open(['w']).state, 'available');
  for (let i = 1; i <= 70; i++) assert.equal((await ownerBegin(h, `p${i}`, 'w')).type, 'ack', `p${i}`);
  const manifestBefore = fs.readFileSync(path.join(s.dir, 'MANIFEST.json'));
  const prev = JSON.parse(manifestBefore.toString('utf8'));
  const segBytes = () => segmentFiles(s.dir).reduce((n, f) => n + fs.statSync(f).size, 0);
  armed = true;
  const relief = await ownerBegin(h, 'p71', 'w');   // 71 > 70 with 69 terminal residents: relief checkpoint
  armed = false;
  assert.equal(fired.length, 1, 'positive hook witness: the relief checkpoint reached the MANIFEST rename (after its in-memory changes)');
  assert.equal(relief.type, 'nack'); assert.equal(relief.reason, 'hot_demotion_failed'); assert.equal(relief.code, 'EIO');
  const closedState = h.ofType('state').find((m) => m.store === 'unavailable_write');
  assert.ok(closedState, `the owner failed closed: ${JSON.stringify(h.ofType('state').map((m) => [m.store, m.reason]))}`);
  assert.ok(closedState._seq < relief._seq, 'unavailable_write is published BEFORE the nack');
  assert.match(String(closedState.reason), /EIO/); assert.equal(closedState.code, 'EIO');
  assert.equal(h.read('status').items[0].store, 'unavailable_write');
  assert.ok(fs.readFileSync(path.join(s.dir, 'MANIFEST.json')).equals(manifestBefore), 'the previous MANIFEST is still the published one');
  const seg0 = segBytes();
  const next = await ownerBegin(h, 'p72', 'w');
  assert.equal(next.type, 'nack'); assert.equal(next.reason, 'unavailable_write');
  const o = await h.submit('obs', { id: 'p70', observation: { kind: 'output_observed', trigger: 'after_fault', at: nowIso() } });
  assert.equal(o.type, 'nack'); assert.equal(o.reason, 'unavailable_write');
  assert.equal(segBytes(), seg0, 'no write was accepted from the diverged state');
  // orphans of the unpublished checkpoint (+ the MANIFEST temporary) are left in place
  const orphanTmp = fs.readdirSync(s.dir).filter((n) => n.startsWith('MANIFEST.json.') && n.endsWith('.tmp'));
  assert.equal(orphanTmp.length, 1);
  const orphanManifest = JSON.parse(fs.readFileSync(path.join(s.dir, orphanTmp[0]), 'utf8'));
  const orphanFiles = [orphanTmp[0], `hot/${orphanManifest.hot.n}.jsonl`, `hot/${orphanManifest.hot.n}.receipts.jsonl`, `facts/${orphanManifest.hot.n}.jsonl`, `facts/${orphanManifest.hot.n}.sid.idx`]
    .concat((orphanManifest.cold || []).filter((c) => !(prev.cold || []).some((p) => p.n === c.n)).flatMap((c) => [`cold/${c.n}.jsonl`, `cold/${c.n}.id.idx`, `cold/${c.n}.sid.idx`]));
  assert.ok(orphanFiles.some((f) => f.startsWith('cold/')), 'the failed relief left its cold generation');
  const orphanSha = Object.fromEntries(orphanFiles.map((f) => [f, sha(fs.readFileSync(path.join(s.dir, f)))]));
  await h.close(); h.release(); hs.splice(hs.indexOf(h), 1);
  // restart on the real fs
  const h2 = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70 }); hs.push(h2);
  const re = h2.open(['w']);
  assert.equal(re.state, 'available', JSON.stringify(re.stateMessage));
  const st = h2.read('status').items[0];
  assert.equal(st.checkpoint.n, prev.hot.n, 'recovered from the previous checkpoint, not the unpublished one');
  assert.equal(st.recovery.unapplied_count, 0, 'nothing unknown to replay');
  for (let i = 1; i <= 70; i++) { const r = h2.read('get', { id: `p${i}` }); assert.equal(r.items.length, 1, `p${i} retained`); assert.equal(r.items[0].tracking_state, i === 70 ? 'tracked' : 'superseded'); }
  for (const id of ['p71', 'p72']) assert.equal(h2.read('get', { id }).items.length, 0, `${id}: refused, never persisted, not replayed`);
  const begins = segmentFiles(s.dir).flatMap((f) => readFrames(f).frames.map((x) => x.obj)).filter((x) => x.t === 'begin').map((x) => x.id);
  assert.deepEqual([...new Set(begins)].sort(), Array.from({ length: 70 }, (_, i) => `p${i + 1}`).sort(), 'segments hold exactly the 70 acked begins');
  for (const [f, h0] of Object.entries(orphanSha)) assert.equal(sha(fs.readFileSync(path.join(s.dir, f))), h0, `orphan preserved byte-for-byte: ${f}`);
  assert.equal((await ownerBegin(h2, 'p71', 'w')).type, 'ack', 'the recovered store serves new begins');
}));

// ===================================================================================================
// #1273 correction570 (review566 F4-threshold). The THRESHOLD checkpoint that a group flush runs
// (flushGroup, framesSinceCheckpoint >= compactFrames) changes owner memory before its MANIFEST publishes,
// exactly like the relief checkpoint. A MANIFEST failure there must fail the store CLOSED as well — on the
// plain write path (TH1, real client + owner worker) and when the flush is the relief path's own (TH2).
// ===================================================================================================

test('1273 TH1: a MANIFEST failure in the THRESHOLD checkpoint of a group flush fails the store CLOSED (real client + owner worker): the next inject is refused with no delivery and no segment growth; restart recovers exactly the acknowledged records, preserves the orphans and replays nothing', () => withStore(async (s) => {
  // prepare a published store with history (no fault): one live destination, superseded predecessors
  const R0 = recorders();
  const a = buildShared(s, R0);
  assert.equal((await a.runtime.restoreTrackedInjections()).ok, true);
  const prep = [];
  for (let i = 1; i <= 3; i++) { const r = await inject(a.handler, 'w1', `prep ${i}`); assert.equal(r.statusCode, 200); prep.push(r.body.inject_id); }
  assert.equal((await a.ledgerClient.close(2000)).lock.released, true);
  // reopen with the fault facade in the owner WORKER (read at spawn): the reopen writes one MANIFEST (skipped),
  // the next MANIFEST tmp->rename — the first threshold checkpoint — fails EIO once
  const prevFaults = process.env.LEDGER_1207_FAULTS;
  process.env.LEDGER_1207_FAULTS = JSON.stringify({ renameSync: { code: 'EIO', times: 1, skip: 1, pathIncludes: 'MANIFEST.json.' } });
  const R = recorders();
  let b;
  try {
    b = buildShared(s, R, { clientOptions: { fsImplPath: FAULT_FS, compactFrames: 24 } });
    assert.equal((await b.runtime.restoreTrackedInjections()).ok, true);
  } finally { if (prevFaults === undefined) delete process.env.LEDGER_1207_FAULTS; else process.env.LEDGER_1207_FAULTS = prevFaults; }
  const prevManifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifestTmps(s.dir).length, 0, 'setup: the reopen published normally');
  const acked = []; let trigger = null;
  for (let i = 1; i <= 200 && !trigger; i++) {
    const r = await inject(b.handler, 'w1', `threshold task ${i}`);
    if (manifestTmps(s.dir).length) trigger = { i, status: r.statusCode, id: r.body.inject_id };
    else { assert.equal(r.statusCode, 200, `inject #${i} before the threshold: ${JSON.stringify(r.body)}`); acked.push(r.body.inject_id); }
  }
  assert.ok(trigger, 'setup: a threshold checkpoint reached the MANIFEST rename and the fault fired');
  // The flush that crossed compactFrames is either this inject's own begin group (begin acked durable BEFORE the
  // checkpoint ⇒ delivered, 200) or an earlier inject's follow-up write (⇒ this begin already meets the closed
  // store: refused by name, nothing delivered, nothing persisted).
  const refusedIds = [];
  if (trigger.status === 200) acked.push(trigger.id);
  else {
    assert.equal(trigger.status, 503, `named refusal: ${JSON.stringify(trigger)}`);
    assert.equal(R.delivery.some((d) => d.injectId === trigger.id), false, 'the refused trigger inject was not delivered');
    refusedIds.push(trigger.id);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8')), prevManifest, 'the threshold checkpoint did not publish: the MANIFEST on disk is the previous one');
  const lastBefore = new Map();
  for (const id of [...prep, ...acked]) lastBefore.set(id, coreOf((await b.ledgerClient.fetchTrackedInjection(id)).record));
  const seg0 = segBytesOf(s.dir); const delivered0 = R.delivery.length;
  // fail-closed: no further write from the diverged owner memory
  const refused = await inject(b.handler, 'w1', 'after the threshold failure');
  assert.notEqual(refused.statusCode, 200, `the store must not admit from diverged state: ${JSON.stringify(refused.body)} client=${b.ledgerClient.state}`);
  assert.equal(b.ledgerClient.state, 'unavailable_write');
  const owner = await b.ledgerClient.ownerStatus();
  assert.equal(owner.store, 'unavailable_write'); assert.match(String(owner.reason), /EIO/);
  assert.notEqual(await b.runtime.parkTrackedInjection(acked[acked.length - 1], 'synthetic_strategy', 'after_fault'), 'tracking_parked', 'no observation is acked either');
  assert.equal(R.delivery.length, delivered0, 'no delivery after the failure');
  assert.equal(segBytesOf(s.dir), seg0, 'no segment growth after the failure');
  assert.equal(R.delivery.length, acked.length, 'exactly one delivery per acknowledged inject');
  assert.ok(R.delivery.every((d) => d.durable), 'durable before delivery');
  const orphans = orphanSet(s.dir, prevManifest);
  await closeBounded(b.ledgerClient, 2000);
  // restart without the fault
  const R2 = recorders();
  const c = buildShared(s, R2);
  assert.equal((await c.runtime.restoreTrackedInjections()).ok, true);
  const st = await c.ledgerClient.ownerStatus();
  assert.equal(st.store, 'available');
  assert.equal(st.checkpoint.n, prevManifest.hot.n, 'the rename failed: restart recovers the previous MANIFEST (segments replay the acknowledged work)');
  assert.equal(st.recovery.unapplied_count, 0, 'no unknown effect');
  for (const id of [...prep, ...acked]) assert.deepEqual(coreOf((await c.ledgerClient.fetchTrackedInjection(id)).record), lastBefore.get(id), `${id}: identity, state and observations recovered`);
  assert.equal(lastBefore.get(acked[acked.length - 1]).tracking_state, 'tracked');
  for (const id of [...refusedIds, refused.body.inject_id]) assert.equal((await c.ledgerClient.fetchTrackedInjection(id)).record, null, `${id}: the refused inject persisted nothing`);
  for (const [f, h0] of Object.entries(orphans.sha)) assert.equal(sha(fs.readFileSync(path.join(s.dir, f))), h0, `orphan preserved byte-for-byte: ${f}`);
  assert.deepEqual(R2.delivery, [], 'nothing replayed across the restart');
  const after = await inject(c.handler, 'w1', 'after restart');
  assert.equal(after.statusCode, 200, JSON.stringify(after.body));
  console.log(`[ledger-1273 TH1] acked=${acked.length} trigger_inject=${trigger.i}:${trigger.status} refused=${refused.statusCode}/${refused.body.reason} owner=${owner.store}:${owner.reason} recovered_checkpoint=${st.checkpoint.n} orphans=${Object.keys(orphans.sha).length} (reported)`);
  assert.deepEqual([...R0.unexpected, ...R.unexpected, ...R2.unexpected], []);
}));

test('1273 TH2: a threshold checkpoint NESTED in the relief path\'s group flush that fails at the MANIFEST fails the store CLOSED before the relieving begin is answered (unavailable_write, no later ack, no segment growth); restart recovers all acknowledged records', () => withOwnerStore(async (s, hs) => {
  let armed = false; const fired = [];
  const faulty = Object.create(fs);
  faulty.renameSync = (from, to) => {
    if (armed && String(to) === path.join(s.dir, 'MANIFEST.json')) { armed = false; fired.push(String(from)); const e = new Error('synthetic EIO'); e.code = 'EIO'; throw e; }
    return fs.renameSync(from, to);
  };
  const h = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70, compactFrames: 71, fsImpl: faulty }); hs.push(h);
  assert.equal(h.open(['w']).state, 'available');
  for (let i = 1; i <= 70; i++) assert.equal((await ownerBegin(h, `p${i}`, 'w')).type, 'ack', `p${i}`);
  assert.equal(h.read('status').items[0].frames_since_checkpoint, 70, 'setup: one frame below the threshold');
  const prevManifest = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
  armed = true;
  // an open group (one observation frame), then a begin past the soft target with a relief batch resident:
  // relief flushes the group first, the flush crosses compactFrames and runs the threshold checkpoint
  const obsP = h.submit('obs', { id: 'p70', observation: { kind: 'output_observed', trigger: 'nested_threshold', at: nowIso() } });
  const beginP = ownerBegin(h, 'p71', 'w');
  const [o, b] = await Promise.all([obsP, beginP]);
  assert.equal(fired.length, 1, 'positive hook witness: the threshold checkpoint reached its MANIFEST rename');
  assert.equal(o.type, 'ack', 'the flushed observation is durable and acked');
  const closed = h.ofType('state').find((m) => m.store === 'unavailable_write');
  assert.ok(closed, `the owner failed closed: ${JSON.stringify(h.ofType('state').map((m) => [m.store, m.reason]))}`);
  assert.equal(closed.stage, 'checkpoint_manifest'); assert.equal(closed.code, 'EIO');
  assert.ok(o._seq < closed._seq, 'the acked group precedes the state change');
  assert.equal(b.type, 'nack', `the relieving begin is not admitted from diverged state: ${JSON.stringify(b)}`); assert.equal(b.reason, 'unavailable_write');
  assert.ok(closed._seq < b._seq);
  assert.equal(h.messages.filter((m) => m.type === 'ack' && m._seq > closed._seq).length, 0, 'no ack after the state change');
  const seg0 = segBytesOf(s.dir);
  const later = await h.submit('obs', { id: 'p70', observation: { kind: 'output_observed', trigger: 'after_fault', at: nowIso() } });
  assert.equal(later.type, 'nack'); assert.equal(later.reason, 'unavailable_write');
  assert.equal(segBytesOf(s.dir), seg0, 'no segment growth after the failure');
  const orphans = orphanSet(s.dir, prevManifest);
  await h.close(); h.release(); hs.splice(hs.indexOf(h), 1);
  const h2 = createOwnerHarness({ dir: s.dir, hotMaxRecords: 70, compactFrames: 71 }); hs.push(h2);
  assert.equal(h2.open(['w']).state, 'available');
  const st = h2.read('status').items[0];
  assert.equal(st.checkpoint.n, prevManifest.hot.n, 'previous MANIFEST (the rename failed)'); assert.equal(st.recovery.unapplied_count, 0);
  for (let i = 1; i <= 70; i++) { const r = h2.read('get', { id: `p${i}` }); assert.equal(r.items.length, 1, `p${i}`); assert.equal(r.items[0].tracking_state, i === 70 ? 'tracked' : 'superseded'); }
  assert.deepEqual(h2.read('get', { id: 'p70' }).items[0].observations.map((x) => x.trigger).filter((t) => t === 'nested_threshold' || t === 'after_fault'), ['nested_threshold'], 'the acked observation persists, the refused one does not');
  assert.equal(h2.read('get', { id: 'p71' }).items.length, 0, 'the refused begin persisted nothing');
  for (const [f, h0] of Object.entries(orphans.sha)) assert.equal(sha(fs.readFileSync(path.join(s.dir, f))), h0, `orphan preserved: ${f}`);
}));
