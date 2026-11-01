'use strict';

// #1207 — failure boundaries: ACCEPTANCE T4 (a crash between the MANIFEST temporary write and its
// rename) and the four bootstrap-abort callers in src/mailbox/delivery-runtime.js (drain failure arm,
// drain throw arm, bootstrap-ready timeout, modal-park timeout). Author-written; NOT RUN here.
//
// T4 drives the REAL owner in-process (owner harness) with a resume4 fault-fs hook that throws EIO at
// exactly the rename of the MANIFEST temporary (positive hook witness asserted), then re-opens with a
// fresh owner: the previous valid MANIFEST is used, durable later segments are replayed, and every
// orphaned artifact (the .tmp manifest and the checkpoint files it would have referenced) is
// preserved byte-for-byte. ACCEPTANCE T4 — "orphan tmp listed (not deleted)" — is asserted through
// the owner's status diagnostic, status.recovery.orphan_manifest_temps (exact relative root filename of
// the MANIFEST temporary, count, truncation, scan completeness); on a product without that diagnostic
// the T4 variants are RED by design (resume11 freeze; the listing was measured absent twice before).
//
// The bootstrap callers are driven through the REAL delivery runtime (bootstrap-harness: real
// registry / gating / submit-gate, the wrapped-session delivery-leg shape over a test-controlled
// socket) against the REAL client + owner, with terminal persistence DELAYED by the private barrier
// (paused-owner-fs) and, in the failure variant, made INDETERMINATE by an env-configured fsync fault.
// Each reached call site is witnessed by the `state` frame it submits (delivery_code / trigger),
// traced on the client the runtime holds — never by source text.
//
// CONTRACT under test (durable-before-notification): when a flush path returns or emits its
// `bootstrap_queue_failed` / `modal_park_timeout` bus event, the dispatch's terminal outcome must be
// durable (ACK) — a notification or pending cleanup must not outrun it. EXPECTED RED BY READING:
// the four call sites invoke the now-async abortTrackedInjection WITHOUT awaiting it, so with the
// owner paused the record is still `tracked` when the event fires. This file freezes that contract
// before any product fix; the measured outcome decides. MEASURED (tester resume5): all four RED.
//
// resume8 measurement repair (same contract, same seven cases, same witnesses): the delayed cases
// START the real operation without awaiting it (a correctly awaited abort cannot complete while
// storage is held), witness the exact terminal submit while the barrier holds storage, capture the
// committed state AT event emission through a test-owned bus client on the existing broadcast path,
// assert that no terminal notification is emitted while the outcome is unresolved, then RELEASE
// storage by the barrier — test-controlled, bounded, independent of the operation's completion —
// and assert durability at the notification after release. T4's orphan-listing check is exact and
// path-aware (a segment `1-1.jsonl` does not list `cold/1.jsonl`); the indeterminate variant waits
// for a bounded terminal-submit witness instead of reading the trace synchronously. The SAME file
// runs against the original and the corrected product.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../src/session-store/ledger-format');
const persistence = require('../src/session-store/persistence');
const H = require('./fixtures/ledger-1207/control-harness');
const B = require('./fixtures/ledger-1207/bootstrap-harness');
const { createOwnerHarness, tmpStore, sha256, shaTree, readFrames, segmentFiles } = require('./fixtures/ledger-1207/owner-harness');
const { createFaultFs } = require('./fixtures/ledger-1207/fault-fs');
const { createBarrier } = require('./fixtures/ledger-1207/paused-owner-fs');

const PAUSED_FS = path.join(__dirname, 'fixtures', 'ledger-1207', 'paused-owner-fs.js');
const EVIDENCE = H.evidenceDir();
const nowIso = () => new Date().toISOString();
const isManifestTmp = (p) => typeof p === 'string' && path.basename(p).startsWith('MANIFEST.json.') && p.endsWith('.tmp');
// Task 1215 / #879 W2 — simulated crash (same helper as ledger-owner-1207). A real crash ends the owner's
// process and the OS releases every descriptor it held; the in-process "crash" (no close(), then release())
// used to leave them open, which Windows measured as ENOTEMPTY at cleanup. trackOwnerFds wraps ONE owner's
// fsImpl and records only the descriptors opened through it; crashOwner closes exactly those still open with
// the real fs (never another owner's, and never the owner's close(): no flush, checkpoint or MANIFEST write),
// then releases the lock as before. Evidence asserted: no `closed` message, no call through the owner's fs,
// a byte-identical store tree.
function trackOwnerFds(base = fs) {
  const open = new Set(); let calls = 0;
  const facade = Object.create(base);
  facade.openSync = (...args) => { calls++; const fd = base.openSync(...args); open.add(fd); return fd; };
  facade.closeSync = (fd, ...rest) => { calls++; try { return base.closeSync(fd, ...rest); } finally { open.delete(fd); } };
  return { fs: facade, calls: () => calls, takeOpen: () => { const fds = [...open]; open.clear(); return fds; } };
}
function crashOwner(h, tracked) {
  const parent = path.dirname(h.dir);
  const treeBefore = shaTree(parent); const callsBefore = tracked.calls(); const closedBefore = h.ofType('closed').length;
  const fds = tracked.takeOpen();
  for (const fd of fds) fs.closeSync(fd);            // the OS-level release a process exit performs
  assert.equal(tracked.calls(), callsBefore, 'crash cleanup makes no call through the owner fs');
  assert.equal(h.ofType('closed').length, closedBefore, 'crash cleanup is not the owner close()');
  assert.deepEqual(shaTree(parent), treeBefore, 'crash cleanup writes nothing');
  return h.release();
}
const LIMITS = Object.freeze({ witnessMs: 5000, settleMs: 150, afterReleaseMs: 10000, stepMs: 5 });

// Every string value reachable in a JSON-shaped value (status item, MANIFEST) — exact listing evidence.
function stringValues(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringValues(v, out);
  return out;
}
// A string NAMES an orphan iff it equals its relative path or its basename, or ends with `/<relative path>`.
const namesPath = (s, rel) => s === rel || s === path.basename(rel) || s.endsWith(`/${rel}`) || s.endsWith(`${path.sep}${rel}`);

// Bounded polling wait: returns the first truthy predicate value, or null at the deadline.
async function waitUntil(predicate, ms, stepMs = LIMITS.stepMs) {
  const deadline = Date.now() + ms;
  for (;;) { const v = predicate(); if (v) return v; if (Date.now() >= deadline) return null; await H.sleep(stepMs); }
}
const bounded = (promise, ms, onTimeout) => Promise.race([promise, H.sleep(ms).then(() => onTimeout)]);

// A test-owned bus client pushed onto the EXISTING broadcast path (shared.busClients). It samples the
// committed read-model state and the terminal submit's outcome synchronously INSIDE the broadcast —
// exactly at event emission, never after the operation returns.
function snapshotEvents(shared, ledgerClient, injectId, eventType, ref) {
  const snapshots = [];
  shared.busClients.push({ readyState: 1, send(serialized) {
    const event = JSON.parse(serialized);
    if (event.type !== eventType) return;
    const rec = ledgerClient.readModel.getTrackedInjection(injectId);
    snapshots.push({ at: Date.now(), event, tracking_state: rec ? rec.tracking_state : null, terminal_outcome: ref.entry ? ref.entry.outcome : 'not_submitted', barrier_raised: ref.barrier ? ref.barrier.isRaised() : null });
  } });
  return snapshots;
}
// The persistence outcome a notification STATES, if it states one (top-level `tracking`; a flush event may carry a list).
function statedTracking(event, injectId) {
  if (event.tracking === undefined) return undefined;
  if (Array.isArray(event.tracking)) { const e = event.tracking.find((x) => x && x.inject_id === injectId); return e ? e.outcome : undefined; }
  return event.tracking;
}

function beginRecord(id, sid) {
  const record = { inject_id: id, session_id: sid, session_epoch: null, session_epoch_reason: 'no_815_epoch_fact', transport_source: 'orch', created_at: nowIso(), observation_seq: 0, observations: [], last_observation: null, capability: { stage: 'A' }, tracking_state: 'tracked' };
  persistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, nowIso());
  return record;
}

// ------------------------------------------------------------------------------------------------
// T4 — MANIFEST temporary written, rename fails (crash point), reopen recovers from the previous one
// ------------------------------------------------------------------------------------------------
for (const variant of [{ name: 'hot-record-stays-hot', live: true }, { name: 'record-demoted-in-failed-checkpoint', live: false }]) {
  test(`T4 [${variant.name}]: fault at the MANIFEST tmp→rename (hook witnessed); the previous MANIFEST is used on reopen, durable later segments replay, orphan tmp + checkpoint artifacts are preserved byte-for-byte; ACCEPTANCE T4: the orphan MANIFEST temporary is LISTED by status.recovery.orphan_manifest_temps (exact path, count 1, not truncated, scan complete) and never deleted`, async () => {
    const s = tmpStore('telepty-1207-t4-');
    let h = null; let failed = true;
    try {
      let armed = false;
      const faultFs = createFaultFs({ faults: { renameSync: { code: 'EIO', times: 1, when: (args) => armed && isManifestTmp(String(args[0])) && String(args[1]).endsWith('MANIFEST.json') } } });
      const crashed = trackOwnerFds(faultFs);
      h = createOwnerHarness({ dir: s.dir, fsImpl: crashed.fs });
      assert.equal(h.open().state, 'available');
      if (variant.live) h.live('w', true);                   // a live session keeps its tracked record hot through a checkpoint
      assert.equal((await h.submit('begin', { id: 'A', sid: 'w', record: beginRecord('A', 'w'), at: nowIso() }, { cls: 'T' })).type, 'ack');
      assert.equal((await h.submit('obs', { id: 'A', observation: { kind: 'output_observed', trigger: 'o1', at: nowIso() } })).type, 'ack');
      const manifestBefore = fs.readFileSync(path.join(s.dir, 'MANIFEST.json'));
      const treeBefore = shaTree(s.dir);
      // the crash point: checkpoint writes hot/receipts/facts (+ a cold file in the demotion variant),
      // then the MANIFEST temporary, then the rename — which throws EIO exactly once
      armed = true;
      const compact = h.read('compact');
      armed = false;
      assert.equal(compact.items.length, 0); assert.match(String(compact.reason), /^compact_failed:EIO/, `the checkpoint failed at the manifest rename: ${compact.reason}`);
      const fired = faultFs._state.fired.filter((f) => f.name === 'renameSync');
      assert.equal(fired.length, 1, 'positive hook witness: exactly one injected rename fault');
      assert.ok(isManifestTmp(fired[0].path), `the fault fired at the MANIFEST temporary, not elsewhere: ${fired[0].path}`);
      // artifact identity: the on-disk MANIFEST is byte-identical to the previous valid one; the
      // orphan temporary holds the manifest the failed checkpoint would have published
      assert.ok(fs.readFileSync(path.join(s.dir, 'MANIFEST.json')).equals(manifestBefore), 'MANIFEST.json is still the previous valid manifest');
      const orphans = fs.readdirSync(s.dir).filter(isManifestTmp);
      assert.equal(orphans.length, 1, 'exactly one orphan MANIFEST temporary');
      const orphan = JSON.parse(fs.readFileSync(path.join(s.dir, orphans[0]), 'utf8'));
      const prev = JSON.parse(manifestBefore.toString('utf8'));
      assert.equal(orphan.format, 4); assert.equal(orphan.hot.n, prev.hot.n + 1, 'the orphan references the NEXT checkpoint'); assert.equal(orphan.last_checkpoint.n, prev.hot.n + 1);
      const orphanFiles = [`hot/${orphan.hot.n}.jsonl`, `hot/${orphan.hot.n}.receipts.jsonl`, `facts/${orphan.hot.n}.jsonl`, `facts/${orphan.hot.n}.sid.idx`].concat(variant.live ? [] : (orphan.cold || []).filter((c) => !(prev.cold || []).some((p) => p.n === c.n)).flatMap((c) => [`cold/${c.n}.jsonl`, `cold/${c.n}.id.idx`, `cold/${c.n}.sid.idx`]));
      for (const rel of orphanFiles) assert.ok(fs.existsSync(path.join(s.dir, rel)), `orphan checkpoint artifact preserved: ${rel}`);
      if (!variant.live) assert.ok(orphanFiles.some((r) => r.startsWith('cold/')), 'the demotion variant left an orphan cold file');
      const orphanShas = Object.fromEntries(orphanFiles.concat([orphans[0]]).map((rel) => [rel, sha256(fs.readFileSync(path.join(s.dir, rel)))]));
      // durable later work after the failed checkpoint (segment appends are unaffected)
      const later = await h.submit('obs', { id: 'A', observation: { kind: 'busy_indicator_pattern_observed', trigger: 'o2', at: nowIso() } });
      if (variant.live) { assert.equal(later.type, 'ack', 'later observations stay durable after a failed checkpoint'); }
      else {
        // in-memory demotion already happened although the MANIFEST never published: the record is
        // cold to this owner — a NAMED refusal (record_cold), nothing invented; recorded as evidence
        assert.equal(later.type, 'nack'); assert.equal(later.reason, 'record_cold');
      }
      const segBytesBefore = segmentFiles(s.dir).map((f) => [path.basename(f), fs.statSync(f).size]);
      // "crash": no close; a fresh owner recovers from the previous MANIFEST
      crashOwner(h, crashed); h = null;
      h = createOwnerHarness({ dir: s.dir });
      const re = h.open();
      assert.equal(re.state, 'available', JSON.stringify(re.stateMessage));
      const rec = h.read('get', { id: 'A' });
      assert.equal(rec.items.length, 1);
      const kinds = rec.items[0].observations.map((o) => o.kind);
      assert.deepEqual(kinds, variant.live ? ['tracking_started', 'output_observed', 'busy_indicator_pattern_observed'] : ['tracking_started', 'output_observed'], 'the previous MANIFEST plus replayed durable segments reconstruct the record');
      const manifestAfter = JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8'));
      assert.equal(manifestAfter.hot.n, prev.hot.n, 'reopen used the previous checkpoint, not the orphaned one');
      assert.ok(manifestAfter.epoch > prev.epoch, 'reopen advanced the epoch (recovery happened)');
      for (const [rel, sha] of Object.entries(orphanShas)) assert.equal(sha256(fs.readFileSync(path.join(s.dir, rel))), sha, `orphan preserved byte-for-byte across recovery: ${rel}`);
      for (const [name, size] of segBytesBefore) assert.ok(fs.statSync(path.join(s.dir, 'segments', name)).size >= size, 'segments are never truncated');
      // ACCEPTANCE T4 — "orphan tmp listed (not deleted)": the owner's status diagnostic, reached through
      // the same `status` read the client's ownerStatus() uses, lists the orphan MANIFEST temporary by
      // its exact relative root filename, collected once at THIS recovery:
      //   status.recovery.orphan_manifest_temps = { paths: string[], count, truncated, scan_error }
      // Checkpoint/segment members stay preserved evidence; they are not part of this listing. On a
      // product without the diagnostic the next assertion is RED by design (resume11 freeze).
      const statusItem = h.read('status').items[0];
      const diag = statusItem && statusItem.recovery && statusItem.recovery.orphan_manifest_temps !== undefined ? statusItem.recovery.orphan_manifest_temps : undefined;
      const evidence = { case: 'T4', variant: variant.name, orphans: Object.keys(orphanShas), orphan_shas: orphanShas, orphan_manifest_temp: orphans[0], orphan_manifest_temps_diagnostic: diag === undefined ? 'absent' : diag, hook_witness: fired, tree_before_failure: Object.keys(treeBefore).length, reopen_epoch: manifestAfter.epoch };
      H.writeEvidence(EVIDENCE, `T4-${variant.name}.json`, evidence);
      assert.ok(diag && typeof diag === 'object' && !Array.isArray(diag), `ACCEPTANCE T4: status.recovery.orphan_manifest_temps lists the orphan MANIFEST temporary (observed: ${diag === undefined ? 'ABSENT — this product exposes no orphan listing' : JSON.stringify(diag)})`);
      assert.deepEqual(diag.paths, [orphans[0]], 'exact relative root filename of the orphan MANIFEST temporary, and nothing else');
      assert.equal(diag.count, 1, 'count = every matching regular temporary found by the same scan');
      assert.equal(diag.truncated, false, 'one name is not truncated');
      assert.equal(diag.scan_error, null, 'a completed scan');
      assert.ok(fs.lstatSync(path.join(s.dir, orphans[0])).isFile(), 'listed, never deleted');
      const file = H.writeEvidence(EVIDENCE, `T4-${variant.name}.json`, { ...evidence, listed: true });
      console.log(`[ledger-1207 T4 ${variant.name}] ${file} orphans=${Object.keys(orphanShas).length} listed=${JSON.stringify(diag.paths)}`);
      await h.close(); h.release(); h = null;
      failed = false;
    } finally {
      if (h) { try { await h.close(); } catch { /* best effort */ } try { h.release(); } catch { /* best effort */ } }
      if (failed) console.log(`[ledger-1207 T4] FAILED — private store preserved: ${s.home}`); else s.rm();
    }
  });
}

// ------------------------------------------------------------------------------------------------
// The four bootstrap-abort callers (delivery-runtime.js: drain failure arm, drain throw arm,
// ready-timeout, modal-park timeout) with DELAYED terminal persistence, plus an INDETERMINATE variant
// ------------------------------------------------------------------------------------------------
async function withBootstrapStore(name, { faults = null } = {}, fn) {
  const store = H.privateStore(`telepty-1207-abort-${name}-`);
  const barrier = createBarrier(store.home);
  const prevB = process.env.LEDGER_1207_BARRIER; const prevF = process.env.LEDGER_1207_FAULTS;
  process.env.LEDGER_1207_BARRIER = barrier.env({ maxWaitMs: 15000 });
  if (faults) process.env.LEDGER_1207_FAULTS = JSON.stringify(faults); else delete process.env.LEDGER_1207_FAULTS;
  const R = H.recorders();
  const built = B.buildBootstrapShared(store, R, { clientOptions: { fsImplPath: PAUSED_FS }, submitDelayMs: 20 });
  let failed = true;
  try { const r = await fn({ store, barrier, R, ...built }); failed = false; return r; } finally {
    barrier.release();
    await H.closeBounded(built.ledgerClient, 2000);
    if (prevB === undefined) delete process.env.LEDGER_1207_BARRIER; else process.env.LEDGER_1207_BARRIER = prevB;
    if (prevF === undefined) delete process.env.LEDGER_1207_FAULTS; else process.env.LEDGER_1207_FAULTS = prevF;
    if (failed) console.log(`[ledger-1207 abort ${name}] FAILED — private HOME preserved: ${store.home}`); else fs.rmSync(store.home, { recursive: true, force: true });
  }
}

const PATHS = [
  { id: 'drain-failure-arm', site: 'drainBootstrapQueue: !result.success', code: 'DISCONNECTED', trigger: 'bootstrap_queue_failed', kind: 'inject_delivery_refused', event: 'bootstrap_queue_failed',
    arrange: (session) => { session.bootstrapReady = false; }, fire: async ({ runtime, session, sid }) => { session.bootstrapReady = true; session.ownerWs.readyState = 3; return runtime.drainBootstrapQueue(sid, session); } },
  { id: 'drain-throw-arm', site: 'drainBootstrapQueue: catch', code: 'BOOTSTRAP_DRAIN_FAILED', trigger: 'bootstrap_drain_failed', kind: 'inject_delivery_refused', event: 'bootstrap_queue_failed',
    arrange: (session) => { session.bootstrapReady = false; }, fire: async ({ runtime, session, sid, leg }) => { session.bootstrapReady = true; leg.throwNext = true; return runtime.drainBootstrapQueue(sid, session); } },
  { id: 'ready-timeout', site: 'failBootstrapQueueOnTimeout', code: 'BOOTSTRAP_READY_TIMEOUT', trigger: 'bootstrap_ready_timeout', kind: 'inject_delivery_dropped', event: 'bootstrap_queue_failed',
    arrange: (session) => { session.bootstrapReady = false; }, fire: async ({ runtime, session, sid }) => runtime.failBootstrapQueueOnTimeout(sid, session, { reason: 'bootstrap_ready_timeout' }) },
  { id: 'modal-park-timeout', site: 'awaitModalParkDrain → flushModalParkQueue', code: 'SURFACE_MODAL_PARK_TIMEOUT', trigger: 'surface_modal_park_timeout', kind: 'inject_delivery_dropped', event: 'modal_park_timeout',
    arrange: (session) => { session.outputRing = [B.MODAL_RING]; session.outputRingTotalBytes = B.MODAL_RING.length; }, fire: async ({ runtime, session, sid }) => runtime.awaitModalParkDrain(sid, session, { timeoutMs: 60, pollIntervalMs: 10 }) },
];

for (const p of PATHS) {
  test(`abort caller [${p.id}] (${p.site}): the real path is reached (traced terminal frame ${p.code}); CONTRACT: no ${p.event} notification while the terminal outcome is unresolved, and the state captured AT the notification is durably aborted — storage is held by the barrier while the real operation runs and released by the test independently of the operation's completion (the SAME test measures original and corrected product)`, () => withBootstrapStore(p.id, {}, async ({ store, barrier, R, shared, runtime, ledgerClient, trace, leg }) => {
    assert.equal((await runtime.restoreTrackedInjections()).ok, true);
    const sid = `s-${p.id}`;
    const session = B.claudeSession(sid, p.id === 'modal-park-timeout' ? B.MODAL_RING : B.CLEAR_RING, { ready: false });
    shared.sessions[sid] = session;
    const injectId = `inj-${p.id}`;
    const begun = await runtime.beginTrackedInjection({ injectId, sessionId: sid, source: 'orch', session });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    p.arrange(session);
    // the op enters the real queue the way the route enqueues it (bootstrap gate or modal park)
    const op = p.id === 'modal-park-timeout'
      ? runtime.parkOperationOnModal(sid, session, { type: 'inject', prompt: 'REPORT: stranded', noEnter: true, injectId, options: { source: 'inject', from: 'orch' } }, { action: 'park', reason: 'claude_modal_ui', hint: 'h' })
      : runtime.enqueueBootstrapOperation(sid, session, { type: 'inject', prompt: 'REPORT: stranded', noEnter: true, injectId, options: { source: 'inject', from: 'orch' } });
    assert.ok(op && op.op_id); assert.equal(session.bootstrapQueue.length, 1);
    const evidence = { case: 'bootstrap-abort', path: p.id, site: p.site, event: p.event, limits: LIMITS, timeline: [] };
    const mark = (what, extra = {}) => evidence.timeline.push({ at: Date.now(), what, ...extra });
    const ref = { entry: null, barrier };
    const snapshots = snapshotEvents(shared, ledgerClient, injectId, p.event, ref);
    const traceBefore = trace.length;
    let operation = null; let settled = null;
    try {
      try {
        // 1. hold storage: the owner pauses at its next segment fsync — the terminal group's
        barrier.raise(); mark('barrier_raised');
        // 2. start the REAL operation WITHOUT awaiting it: a correctly awaited abort cannot complete while storage is held
        operation = Promise.resolve().then(() => p.fire({ runtime, session, sid, leg })).then((v) => ({ returned: v === undefined ? null : v }), (e) => ({ threw: e && e.message }));
        operation.then((v) => { settled = v; mark('operation_settled', v); });
        // 3. witness the exact terminal submit while storage is held (reached-path witness, not source text)
        ref.entry = await waitUntil(() => trace.slice(traceBefore).find((t) => t.kind === 'state' && t.id === injectId) || null, LIMITS.witnessMs);
        mark('terminal_witnessed', { found: !!ref.entry });
        assert.ok(ref.entry, `the ${p.site} call site submitted its terminal frame within ${LIMITS.witnessMs} ms: ${JSON.stringify(trace.slice(traceBefore).map((t) => [t.kind, t.id, t.delivery_code, t.trigger]))}`);
        assert.equal(ref.entry.delivery_code, p.code); assert.equal(ref.entry.trigger, p.trigger); assert.equal(ref.entry.kind_of_observation, p.kind); assert.equal(ref.entry.tracking_state, 'aborted');
        assert.equal(ref.entry.outcome, null, 'storage is held: the terminal submit is inflight, its ack cannot have arrived');
        assert.equal(barrier.isRaised(), true, 'the barrier is still raised');
        // 4. let any premature notification land (bounded settle), then judge each at ITS emission time
        await H.sleep(LIMITS.settleMs);
        evidence.unresolved_window = { operation_settled: settled, events_emitted: snapshots.length, snapshots: snapshots.map((s) => ({ tracking_state: s.tracking_state, terminal_outcome: s.terminal_outcome, barrier_raised: s.barrier_raised, stated_tracking: statedTracking(s.event, injectId) })) };
        const premature = snapshots.filter((s) => !(s.terminal_outcome === 'ack' && s.tracking_state === 'aborted'));
        assert.equal(premature.length, 0, `CONTRACT (durable before notification): no ${p.event} may be emitted while the terminal outcome is unresolved; observed ${premature.length} emitted with tracking_state '${premature[0] && premature[0].tracking_state}' and terminal outcome '${premature[0] && premature[0].terminal_outcome}' while storage was held — the call site did not await abortTrackedInjection (product evidence)`);
        assert.equal(settled, null, `the operation (${p.site}) must not report completion before its terminal outcome is durable: ${JSON.stringify(settled)}`);
      } finally {
        // 5. release storage — test-controlled, bounded, independent of the operation
        barrier.release(); mark('barrier_released');
      }
      // 6. after release: terminal outcome, the operation's return and the notification — each bounded
      const finalOutcome = await bounded(ref.entry.promise, LIMITS.afterReleaseMs, { outcome: 'timeout' });
      const returned = await bounded(operation, LIMITS.afterReleaseMs, { timeout: true });
      const emitted = await waitUntil(() => (snapshots.length >= 1 ? snapshots : null), LIMITS.afterReleaseMs);
      mark('after_release', { final_outcome: finalOutcome.outcome, returned, events: snapshots.length });
      evidence.after_release = { final_outcome: finalOutcome.outcome, operation: returned, snapshots: snapshots.map((s) => ({ tracking_state: s.tracking_state, terminal_outcome: s.terminal_outcome, stated_tracking: statedTracking(s.event, injectId) })) };
      assert.equal(finalOutcome.outcome, 'ack', JSON.stringify(finalOutcome));
      assert.ok(emitted, `the ${p.event} notification was emitted once the outcome became durable`);
      for (const s of snapshots) { assert.equal(s.tracking_state, 'aborted', 'AT emission the committed record is aborted'); assert.equal(s.terminal_outcome, 'ack', 'AT emission the terminal submit had been acked'); }
      assert.ok(returned && !returned.timeout && !returned.threw, `the operation settled after release without throwing: ${JSON.stringify(returned)}`);
      assert.equal(trace.slice(traceBefore).filter((t) => t.kind === 'state' && t.id === injectId).length, 1, 'exactly one terminal frame — no duplicate abort');
      assert.equal(session.bootstrapQueue.length, 0, 'the op left the queue (pending cleanup happened)');
      const rec = ledgerClient.readModel.getTrackedInjection(injectId);
      assert.equal(rec.tracking_state, 'aborted');
      assert.equal(rec.last_observation.kind, p.kind); assert.equal(rec.last_observation.delivery_code, p.code);
      assert.equal(rec.last_observation.bytes_written, p.id === 'drain-throw-arm' ? null : 0, 'bytes_written: null only where a throw could land on either side of the write');
      // a notification that STATES a persistence outcome states the durable one, never more than it knows
      for (const s of snapshots) { const stated = statedTracking(s.event, injectId); if (stated !== undefined) assert.equal(stated, 'tracking_aborted', `the notification's stated outcome matches the durable one (${stated})`); }
      assert.equal(R.delivery.length, 0, 'no delivery for an aborted dispatch');
      evidence.final = { tracking_state: rec.tracking_state, last_observation: { kind: rec.last_observation.kind, delivery_code: rec.last_observation.delivery_code, bytes_written: rec.last_observation.bytes_written } };
    } finally {
      const file = H.writeEvidence(EVIDENCE, `abort-${p.id}.json`, evidence);
      console.log(`[ledger-1207 abort ${p.id}] evidence=${file} events_while_unresolved=${evidence.unresolved_window ? evidence.unresolved_window.events_emitted : 'n/a'} final=${evidence.after_release ? evidence.after_release.final_outcome : 'n/a'}`);
    }
  }));
}

test('abort caller failure variant [ready-timeout]: the terminal persistence attempt fails twice (EIO) — the outcome is INDETERMINATE, distinct from a pre-admission rejection: the record is NOT described as aborted, the txn is held unresolved, nothing is retried, and no notification claims a durable abort', () => withBootstrapStore('indeterminate', { faults: { fsyncSync: { code: 'EIO', times: 2, skip: 1, pathIncludes: `${path.sep}segments${path.sep}` } } }, async ({ R, shared, runtime, ledgerClient, trace }) => {
  // skip:1 lets the begin's group through (a fresh store has no recovery re-fsync); the abort's group
  // is the first faulted fsync, its retry in a new segment the second ⇒ indeterminate
  assert.equal((await runtime.restoreTrackedInjections()).ok, true);
  const sid = 's-indeterminate'; const session = B.claudeSession(sid, B.CLEAR_RING, { ready: false }); shared.sessions[sid] = session;
  const injectId = 'inj-indeterminate';
  assert.equal((await runtime.beginTrackedInjection({ injectId, sessionId: sid, source: 'orch', session })).ok, true);
  runtime.enqueueBootstrapOperation(sid, session, { type: 'inject', prompt: 'REPORT: stranded', noEnter: true, injectId, options: { source: 'inject', from: 'orch' } });
  const ref = { entry: null, barrier: null };
  const snapshots = snapshotEvents(shared, ledgerClient, injectId, 'bootstrap_queue_failed', ref);
  const traceBefore = trace.length;
  // not awaited: the original returns undefined, the corrected a promise — the witness is the TRACE, bounded
  const fired = runtime.failBootstrapQueueOnTimeout(sid, session, { reason: 'bootstrap_ready_timeout' });
  ref.entry = await waitUntil(() => trace.slice(traceBefore).find((t) => t.kind === 'state' && t.id === injectId) || null, LIMITS.witnessMs);
  assert.ok(ref.entry, `the ready-timeout path submitted its terminal frame within ${LIMITS.witnessMs} ms (bounded witness; the abort awaits ensureHot before submitting)`);
  const outcome = await bounded(ref.entry.promise, LIMITS.afterReleaseMs, { outcome: 'timeout' });
  assert.equal(outcome.outcome, 'indeterminate', `a persistence attempt that failed twice is INDETERMINATE, never ack/nack/rejected: ${JSON.stringify(outcome)}`);
  assert.equal(ledgerClient.readModel.getTrackedInjection(injectId).tracking_state, 'tracked', 'the committed read model never shows an unconfirmed terminal');
  assert.equal(ledgerClient.status().unresolved_count, 1, 'the txn is held for resolution after recovery; no automatic retry');
  assert.equal(ledgerClient.state, 'unavailable_write');
  // the drop notification (whenever emitted) must not claim a durable abort
  const emitted = await waitUntil(() => (snapshots.length >= 1 ? snapshots : null), LIMITS.afterReleaseMs);
  assert.ok(emitted, 'bootstrap_queue_failed was emitted for the dropped op');
  for (const s of snapshots) {
    assert.notEqual(s.tracking_state, 'aborted', 'the committed read model never showed aborted at emission');
    const stated = statedTracking(s.event, injectId);
    if (stated !== undefined) assert.equal(stated, 'tracking_outcome_indeterminate', `a notification that states a persistence outcome states the INDETERMINATE one (${stated})`);
  }
  await bounded(Promise.resolve(fired), LIMITS.afterReleaseMs, null);   // drain the operation's promise when it is one
  // distinct from a pre-admission rejection: a second abort now is refused by name without a persistence attempt
  const second = await ledgerClient.submit('state', { id: injectId, tracking_state: 'aborted', observation: { kind: 'inject_delivery_dropped', trigger: 'x', delivery_code: 'X', bytes_written: 0, at: nowIso() } }, { class: 'T', jobId: injectId });
  assert.notEqual(second.outcome, 'ack');
  assert.ok(['nack', 'rejected_admission'].includes(second.outcome), `pre-persistence refusal named: ${JSON.stringify(second)}`);
  assert.equal(R.delivery.length, 0);
  H.writeEvidence(EVIDENCE, 'abort-indeterminate.json', { first: { outcome: outcome.outcome, reason: outcome.reason }, second: { outcome: second.outcome, reason: second.reason }, state: ledgerClient.state, unresolved: ledgerClient.status().unresolved_count, notifications: snapshots.map((s) => ({ tracking_state: s.tracking_state, stated_tracking: statedTracking(s.event, injectId) })) });
}));
