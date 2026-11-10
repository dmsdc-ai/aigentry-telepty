'use strict';

// Task 1273 — the persistent tracked-job COUNT is not an admission prerequisite (see test/ledger-job-count-removal-1273.test.js).
// Split590 (test-only): F3 moved from test/ledger-job-count-removal-1273.test.js.
// The test bodies are moved verbatim; the shared helpers live in test/fixtures/ledger-1207/job-count-removal-1273.js.
// Each test runs on its own private HOME or owner store, so the four 1273 files share no ledger, lock or owner worker.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const F = require('../src/session-store/ledger-format');
const { buildShared, recorders, inject, withStore, dirBytes, RELIEF_MIN_BATCH, storeInventory } = require('./fixtures/ledger-1207/job-count-removal-1273');

// ===================================================================================================
// #1273 correction (review559 F1–F4). Real inject handler / delivery runtime / ledger client / owner
// worker with the PRODUCTION constants (HOT_MAX_RECORDS 576, 64 MiB hot bytes); the transport and the
// bus are recorders. Owner-only fault cases drive the real owner in-process.
// ===================================================================================================

test('1273 F3: near the soft target (575 live current records) 1536 same-live injects are relieved in batches of >= 64 terminal records, never a checkpoint per begin; checkpoint / file / MANIFEST growth is measured per event', () => withStore(async (s) => {
  const R = recorders();
  const D = Array.from({ length: 574 }, (_, i) => `n${i}`);
  const { runtime, handler, ledgerClient } = buildShared(s, R, { extraSessions: D });
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  for (const sid of [...D, 'w1']) { const r = await inject(handler, sid, `seed ${sid}`); assert.equal(r.statusCode, 200, `${sid}: ${JSON.stringify(r.body)}`); }
  const st0 = await ledgerClient.ownerStatus();
  assert.equal(st0.resident.records, 575, 'near-saturated live set');
  const n0 = st0.checkpoint.n; const inv0 = storeInventory(s.dir); const io0 = st0.io;
  const EVENTS = 1536; let maxHot = 0; let lastN = n0; const reliefs = [];
  for (let i = 1; i <= EVENTS; i++) {
    const r = await inject(handler, 'w1', `burst ${i}`);
    assert.equal(r.statusCode, 200, `burst #${i}: ${JSON.stringify(r.body)}`);
    const st = await ledgerClient.ownerStatus();
    maxHot = Math.max(maxHot, st.resident.records);
    const checkpoints = st.checkpoint.n - n0;
    assert.ok(checkpoints <= Math.ceil(i / RELIEF_MIN_BATCH), `relief checkpoints bounded by batches: ${checkpoints} checkpoints after ${i} events (bound ${Math.ceil(i / RELIEF_MIN_BATCH)})`);
    if (st.checkpoint.n !== lastN) {
      const lc = storeInventory(s.dir).last_checkpoint;
      reliefs.push({ at_event: i, n: lc && lc.n, reason: lc && lc.reason, demoted: lc && lc.demoted });
      assert.equal(lc.reason, 'hot_pressure'); assert.ok(lc.demoted >= RELIEF_MIN_BATCH, `relief demoted a batch: ${JSON.stringify(lc)}`);
      lastN = st.checkpoint.n;
    }
  }
  const st1 = await ledgerClient.ownerStatus(); const inv1 = storeInventory(s.dir);
  assert.equal(st1.store, 'available');
  assert.ok(st1.resident.bytes < F.HOT_MAX_ENCODED_BYTES);
  assert.ok(reliefs.length >= 1 && reliefs.length <= Math.ceil(EVENTS / RELIEF_MIN_BATCH), `${reliefs.length} reliefs for ${EVENTS} events`);
  assert.equal(inv1.files - inv0.files, reliefs.length * 7, 'each relief adds exactly one checkpoint generation (4 hot/facts files) + one cold generation (3 files)');
  assert.equal(inv1.manifest_cold - inv0.manifest_cold, reliefs.length, 'MANIFEST cold[] grows by one entry per relief, not per event');
  for (const sid of D) { const id = (await ledgerClient.listForSession(sid))[0].inject_id; assert.equal(ledgerClient.readModel.getTrackedInjection(id).tracking_state, 'tracked', `${sid} current record hot`); }
  const measured = { events: EVENTS, live_records: 575, reliefs: reliefs.length, events_per_relief: +(EVENTS / reliefs.length).toFixed(1), max_hot_records: maxHot, files_added: inv1.files - inv0.files, files_per_event: +((inv1.files - inv0.files) / EVENTS).toFixed(4), manifest_bytes: [inv0.manifest_bytes, inv1.manifest_bytes], manifest_cold_entries: [inv0.manifest_cold, inv1.manifest_cold], fsyncs_per_event: +((st1.io.fsyncs - io0.fsyncs) / EVENTS).toFixed(2), bytes_written_per_event: Math.round((st1.io.bytes - io0.bytes) / EVENTS), store_bytes: dirBytes(s.dir), relief_events: reliefs.map((x) => `${x.at_event}:${x.demoted}`).join(',') };
  console.log(`[ledger-1273 F3] ${JSON.stringify(measured)} (reported)`);
  assert.deepEqual(R.unexpected, []);
}));
