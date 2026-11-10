'use strict';

// Task 1273 — the persistent tracked-job COUNT is not an admission prerequisite (see test/ledger-job-count-removal-1273.test.js).
// Split590 (test-only): F1 moved from test/ledger-job-count-removal-1273.test.js.
// The test bodies are moved verbatim; the shared helpers live in test/fixtures/ledger-1207/job-count-removal-1273.js.
// Each test runs on its own private HOME or owner store, so the four 1273 files share no ledger, lock or owner worker.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const F = require('../src/session-store/ledger-format');
const { buildShared, recorders, inject, withStore, assertBusCorrelation, beginOnDisk } = require('./fixtures/ledger-1207/job-count-removal-1273');

// ===================================================================================================
// #1273 correction (review559 F1–F4). Real inject handler / delivery runtime / ledger client / owner
// worker with the PRODUCTION constants (HOT_MAX_RECORDS 576, 64 MiB hot bytes); the transport and the
// bus are recorders. Owner-only fault cases drive the real owner in-process.
// ===================================================================================================

test('1273 F1: more than 576 distinct LIVE destinations each hold a current tracked inject and identified injects are still admitted — a self-superseding begin and 1536 more injects to one live target — durable, correlated, hot bytes below the byte bound', () => withStore(async (s) => {
  const R = recorders();
  const D = Array.from({ length: 600 }, (_, i) => `d${i}`);
  const { shared, runtime, handler, ledgerClient } = buildShared(s, R, { extraSessions: D });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const current = new Map();
  for (const [i, sid] of D.entries()) {
    const res = await inject(handler, sid, `synthetic task for ${sid}`);
    assert.equal(res.statusCode, 200, `distinct live destination #${i + 1} (${sid}): ${res.statusCode} ${JSON.stringify(res.body)} healthy=${shared.trackedLedgerHealthy}`);
    current.set(sid, res.body.inject_id);
  }
  let owner = await ledgerClient.ownerStatus();
  assert.ok(owner.resident.records >= D.length && D.length > F.HOT_MAX_RECORDS, `${owner.resident.records} live current records resident (> ${F.HOT_MAX_RECORDS})`);
  assert.ok(owner.resident.bytes < F.HOT_MAX_ENCODED_BYTES);
  for (const [sid, id] of current) { const r = ledgerClient.readModel.getTrackedInjection(id); assert.ok(r && r.tracking_state === 'tracked' && r.session_id === sid, `${sid}: current record hot and tracked`); }
  // a begin that supersedes the session's own record, with the hot set beyond the target
  const self = await inject(handler, 'd0', 'second task for d0');
  assert.equal(self.statusCode, 200, `self-superseding begin: ${JSON.stringify(self.body)}`);
  assert.equal((await ledgerClient.fetchTrackedInjection(current.get('d0'))).record.tracking_state, 'superseded');
  // continued admission to the same live target
  const burst = [];
  for (let i = 1; i <= 1536; i++) {
    const res = await inject(handler, 'd1', `burst ${i} for d1`);
    assert.equal(res.statusCode, 200, `burst #${i} to d1: ${res.statusCode} ${JSON.stringify(res.body)}`);
    burst.push(res.body.inject_id);
  }
  const total = D.length + 1 + 1536;
  assert.equal(R.delivery.length, total, 'exactly one delivery per admitted inject');
  assert.ok(R.delivery.every((d) => d.durable), 'durable before delivery, every time');
  assert.equal(new Set(R.delivery.map((d) => d.injectId)).size, total, 'no inject delivered twice');
  assert.equal(assertBusCorrelation(R), total);
  for (const id of [burst[0], burst[767], burst[1535]]) assert.equal(beginOnDisk(s.dir, id), true);
  owner = await ledgerClient.ownerStatus();
  assert.equal(owner.store, 'available'); assert.equal(shared.trackedLedgerHealthy, true);
  assert.ok(owner.resident.records > F.HOT_MAX_RECORDS, `the record count is a soft target: ${owner.resident.records} resident`);
  assert.ok(owner.resident.bytes < F.HOT_MAX_ENCODED_BYTES, 'hot bytes below the hard byte bound');
  for (const sid of D.slice(2)) { const r = ledgerClient.readModel.getTrackedInjection(current.get(sid)); assert.ok(r && r.tracking_state === 'tracked', `${sid}: a live session's current record is never demoted by relief`); }
  assert.equal(ledgerClient._internal.inflight.size, 0); assert.equal(ledgerClient.status().unresolved_count, 0);
  console.log(`[ledger-1273 F1] live_destinations=${D.length} injects=${total} hot_records=${owner.resident.records} soft_target=${F.HOT_MAX_RECORDS} hot_bytes=${owner.resident.bytes} max_bytes=${F.HOT_MAX_ENCODED_BYTES} cold=${owner.counts.cold} checkpoint_n=${owner.checkpoint.n} (reported)`);
  assert.deepEqual(R.unexpected, []);
}));
