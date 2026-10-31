'use strict';

// #1207 — restore-lifecycle regressions and refusal controls (frozen BEFORE any product fix).
//
// Two source-derived risks from the resume6 review are turned into exact regressions here, plus the
// refusal controls that bound them. Everything runs through the REAL factories of the control
// harness: createDeliveryRuntime, createSessionActions (the REAL captured `POST /api/sessions/:id/
// inject` handler), createLedgerClient with its REAL owner Worker. The ONLY test-owned element is a
// Worker class whose deterministic hook terminates the thread on a chosen outbound message — the
// exit the client sees is a real worker exit; nothing on the client side is simulated. Respawn
// policy, backend and product bodies are untouched.
//
// Honesty labels used throughout:
//   - "poll data path" = the control-harness COPY of the daemon.js GET /api/inject-observations
//     decision (`pollDataPath`), NOT the HTTP handler, NOT a daemon.
//   - "FIXED EXPECTED" = the behaviour the contract requires; "prediction" = the outcome expected by
//     reading the frozen product — a prediction is NOT a measurement.
// Author-written; NOT RUN in this phase. All fixture bytes live under private mkdtemp HOMEs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./fixtures/ledger-1207/control-harness');
const { readFrames } = require('./fixtures/ledger-1207/owner-harness');
const { writeLegacyLedger } = require('./fixtures/ledger-1207/legacy-fixture');

const EVIDENCE = H.evidenceDir();
const LIMITS = Object.freeze({ availableWaitMs: 5000, pollMs: 10, closeMs: 2000, seededRecords: 24, obsPerRecord: 3 });
const nowIso = () => new Date().toISOString();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- witnesses and helpers --------------------------------------------------------------------------
function snap(shared) {
  const c = shared.ledgerClient;
  return { healthy: shared.trackedLedgerHealthy, reason: shared.trackedLedgerUnavailableReason, client_state: c ? c.state : null, client_reason: c ? c.reason : null };
}
async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return true; await H.sleep(LIMITS.pollMs); }
  return predicate();
}
// Durable facts on disk: `fact` frames still in segments plus facts folded by a checkpoint into
// facts/<n>.jsonl (plain JSON lines there). Both are read as data; no owner API is consulted.
function restartFactsOnDisk(dir, kind = 'daemon_restart_observed') {
  const out = [];
  const seg = path.join(dir, 'segments');
  for (const n of fs.existsSync(seg) ? fs.readdirSync(seg).sort() : []) {
    for (const f of readFrames(path.join(seg, n)).frames) if (f.obj && f.obj.t === 'fact' && f.obj.observation && f.obj.observation.kind === kind) out.push({ where: `segments/${n}`, epoch: f.obj.epoch, seq: f.obj.seq, txn: f.obj.txn });
  }
  const facts = path.join(dir, 'facts');
  for (const n of fs.existsSync(facts) ? fs.readdirSync(facts).sort() : []) {
    for (const line of fs.readFileSync(path.join(facts, n), 'utf8').split('\n')) {
      if (!line) continue;
      let obj = null; try { obj = JSON.parse(line.split('\t')[0]); } catch { obj = null; }
      if (obj && obj.observation && obj.observation.kind === kind) out.push({ where: `facts/${n}`, pos: obj.pos || null });
    }
  }
  return out;
}
function countFrames(dir) {
  const out = { fact: 0, obs: 0, begin: 0, state: 0 };
  const seg = path.join(dir, 'segments');
  for (const n of fs.existsSync(seg) ? fs.readdirSync(seg) : []) for (const f of readFrames(path.join(seg, n)).frames) if (f.obj && out[f.obj.t] !== undefined) out[f.obj.t]++;
  return out;
}
function treeSnapshot(root) {
  const out = {};
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[r] = 'dir'; walk(path.join(d, e.name), r); } else out[r] = sha256(fs.readFileSync(path.join(d, e.name)));
    }
  })(root, '');
  return out;
}

// A test-OWNED Worker class: the real worker_threads.Worker (through the harness's message-size
// observer) plus ONE deterministic hook — when armed, the first outbound message of type `killOn`
// is forwarded and the thread is then terminated. Constructions and exits are recorded as witnesses.
function makeKillingWorker(messages, hook) {
  const Observed = H.makeObservedWorker(messages);
  return class KillingWorker extends Observed {
    constructor(...args) {
      super(...args);
      hook.constructed++;
      const gen = hook.constructed;
      this.on('exit', (code) => hook.exits.push({ gen, code, at: nowIso() }));
    }
    postMessage(m, ...rest) {
      const r = super.postMessage(m, ...rest);
      if (hook.armed && !hook.fired && m && m.type === hook.killOn) {
        hook.fired = { type: m.type, gen: hook.constructed, at: nowIso() };
        this.terminate().catch(() => { /* already gone */ });
      }
      return r;
    }
  };
}

async function withLifecycleStore(name, { killOn = null, seed = true } = {}, fn) {
  const store = H.privateStore(`telepty-1207-restore-${name}-`);
  const seeded = seed ? writeLegacyLedger(store.dir, { count: LIMITS.seededRecords, obsPerRecord: LIMITS.obsPerRecord, prefix: `rl-${name}` }) : null;
  const R = H.recorders();
  const messages = { inbound: [], outbound: [] };
  const hook = { killOn, armed: false, fired: null, constructed: 0, exits: [] };
  const built = H.buildShared(store, R, { messages, clientOptions: killOn ? { Worker: makeKillingWorker(messages, hook) } : {} });
  const evidence = { case: name, started_at: nowIso(), node: process.version, platform: process.platform, limits: LIMITS,
    seeded: seeded ? { count: seeded.count, bytes: seeded.bytes, sha256: seeded.sha256 } : null,
    labels: { poll: 'control-harness pollDataPath = COPY of the daemon.js poll decision; NOT HTTP, NOT a daemon', inject: 'REAL captured POST /api/sessions/:id/inject handler (in-process call, not HTTP)', worker: killOn ? `test-owned Worker; terminated on first armed outbound '${killOn}' message; real exit` : 'real Worker through the harness observer' } };
  let failed = true;
  try { await fn({ store, seeded, R, messages, hook, evidence, ...built }); failed = false; } finally {
    evidence.closed = await H.closeBounded(built.ledgerClient, LIMITS.closeMs);
    evidence.hook = hook; evidence.failed = failed; evidence.finished_at = nowIso();
    const file = H.writeEvidence(EVIDENCE, `restore-${name}.json`, evidence);
    console.log(`[ledger-1207 restore ${name}] evidence=${file}`);
    if (failed) console.log(`[ledger-1207 restore ${name}] FAILED — private HOME preserved: ${store.home}`);
    else fs.rmSync(store.home, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------
// 1 — first-open owner failure, then the existing bounded internal restart
// ------------------------------------------------------------------------------------------------
test('restore lifecycle 1: a GENUINE owner exit during the FIRST open (test-owned Worker terminated on its open message) — the failed first open is witnessed; FIXED EXPECTED: the existing bounded internal restart brings a REAL owner to available, the captured inject handler recovers to 200 with durable delivery, and the poll data path serves new and seeded records', () => withLifecycleStore('first-open-failure', { killOn: 'open' }, async ({ store, seeded, R, shared, runtime, injectHandler, ledgerClient, hook, evidence }) => {
  hook.armed = true;
  const first = await runtime.restoreTrackedInjections();
  evidence.first_open = { result: { ok: first.ok, state: first.state || null, reason: first.reason || null }, hook_fired: hook.fired, exits: hook.exits.slice(), constructed: hook.constructed, shared: snap(shared) };
  // witnesses (measurements, not predictions): the hook fired on the open message, a real exit followed, the open settled owner_failed
  assert.ok(hook.fired && hook.fired.type === 'open', 'the kill hook fired on the first open message');
  assert.equal(first.ok, false, JSON.stringify(first));
  assert.equal(first.reason, 'owner_failed', `the first open names the owner failure (observed ${first.reason})`);
  assert.ok(hook.exits.length >= 1 && hook.exits[0].gen === 1, 'a REAL exit of the first owner worker was observed');
  assert.equal(shared.trackedLedgerHealthy, false, 'a failed open authorizes nothing');

  // the later REAL owner reaching available — bounded wait; the respawn policy is the product's own
  const available = await waitFor(() => ledgerClient.isAvailable(), LIMITS.availableWaitMs);
  evidence.after_wait = { available, client: { state: ledgerClient.state, reason: ledgerClient.reason }, workers_constructed: hook.constructed, respawns_recorded: ledgerClient._internal.respawns.length, exits: hook.exits.slice(), shared: snap(shared) };
  assert.equal(available, true, `FIXED EXPECTED: a real owner is available within ${LIMITS.availableWaitMs} ms after the first-open failure (observed state=${ledgerClient.state}/${ledgerClient.reason}, workers constructed=${hook.constructed}, respawns recorded=${ledgerClient._internal.respawns.length}). Prediction by reading: RED — onWorkerExit calls open() while the first open's opening-promise is still set (its finally has not run), so the respawn returns that settling promise and constructs no second owner; the respawn budget is consumed anyway`);
  assert.ok(hook.constructed >= 2, `a second REAL owner worker was constructed (${hook.constructed})`);

  // the REAL captured inject handler must recover — a client-only available status is insufficient
  const res = H.makeRes();
  await injectHandler(H.makeReq('after first-open failure', 'orch', 'w1'), res);
  evidence.inject = { status: res.statusCode, body: res.body, deliveries: R.delivery.length, shared: snap(shared) };
  assert.equal(res.statusCode, 200, `FIXED EXPECTED: 200 after recovery (observed ${res.statusCode} ${res.body && res.body.code} ${res.body && res.body.reason}; shared=${JSON.stringify(snap(shared))}). Prediction by reading: RED — shared.trackedLedgerHealthy stays false with reason owner_failed because nothing re-runs the restore transition after the internal respawn`);
  assert.equal(R.delivery.length, 1, 'exactly one delivery, after the durable begin');
  const id = res.body.inject_id;
  const fetched = await runtime.fetchTrackedInjection(id);
  assert.ok(fetched.record && fetched.record.tracking_state === 'tracked', `the begin is durable and readable (${JSON.stringify(fetched.reason || null)})`);
  assert.equal(countFrames(store.dir).begin, 1, 'exactly one begin frame on disk');
  const pollNew = await H.pollDataPath(shared, id);
  const pollSeeded = await H.pollDataPath(shared, seeded.ids[0]);
  evidence.polls = { new_record: pollNew, seeded_record: pollSeeded };
  assert.equal(pollNew.arm, 'record', `poll data path serves the new record (${JSON.stringify(pollNew)})`);
  assert.equal(pollSeeded.arm, 'record', `poll data path serves a seeded record (${JSON.stringify(pollSeeded)})`);
}));

test('restore lifecycle 1 (control): a GENUINE owner exit AFTER a successful open (kill on the first armed submit) — the begin whose owner died is refused without delivery, the existing bounded internal restart brings a REAL owner back, the inject handler returns to 200 with durable delivery and the poll data path serves records (predicted GREEN: shared health was already true and the opening-promise is clear when the exit arrives)', () => withLifecycleStore('post-open-failure', { killOn: 'submit' }, async ({ store, seeded, R, shared, runtime, injectHandler, ledgerClient, hook, evidence }) => {
  const first = await runtime.restoreTrackedInjections();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(shared.trackedLedgerHealthy, true);
  evidence.first_open = { result: { ok: first.ok, counts: first.counts || null, restart_fact: first.restartFact ? first.restartFact.outcome : null }, constructed: hook.constructed };
  // arm AFTER the restore (its restart fact is also a submit) — the next submit is the begin below
  hook.armed = true;
  const killed = H.makeRes();
  await injectHandler(H.makeReq('owner dies during this begin', 'orch', 'w1'), killed);
  evidence.killed_begin = { status: killed.statusCode, body: killed.body, hook_fired: hook.fired, exits: hook.exits.slice(), deliveries: R.delivery.length, shared: snap(shared) };
  assert.ok(hook.fired && hook.fired.type === 'submit', 'the kill hook fired on the begin submit');
  assert.notEqual(killed.statusCode, 200, 'a begin whose owner died mid-persistence never authorizes delivery');
  assert.equal(R.delivery.length, 0, 'no delivery for the killed begin');
  assert.ok(['tracking_outcome_indeterminate', 'owner_failed', 'recovering'].includes(killed.body && killed.body.reason), `the refusal is named (${killed.body && killed.body.reason})`);

  const available = await waitFor(() => ledgerClient.isAvailable(), LIMITS.availableWaitMs);
  evidence.after_wait = { available, client: { state: ledgerClient.state, reason: ledgerClient.reason }, workers_constructed: hook.constructed, respawns_recorded: ledgerClient._internal.respawns.length, exits: hook.exits.slice(), shared: snap(shared), unresolved: ledgerClient.status ? ledgerClient.status().unresolved_count : null };
  assert.equal(available, true, `a real owner is available within ${LIMITS.availableWaitMs} ms after a post-open failure (observed ${ledgerClient.state}/${ledgerClient.reason}, workers=${hook.constructed})`);
  assert.ok(hook.constructed >= 2, 'a second REAL owner worker was constructed');
  const res = H.makeRes();
  await injectHandler(H.makeReq('after post-open failure', 'orch', 'w1'), res);
  evidence.inject = { status: res.statusCode, body: res.body, deliveries: R.delivery.length, shared: snap(shared) };
  assert.equal(res.statusCode, 200, `200 after the respawn (observed ${res.statusCode} ${res.body && res.body.code} ${res.body && res.body.reason})`);
  assert.equal(R.delivery.length, 1);
  const fetched = await runtime.fetchTrackedInjection(res.body.inject_id);
  assert.ok(fetched.record && fetched.record.tracking_state === 'tracked');
  const pollNew = await H.pollDataPath(shared, res.body.inject_id);
  const pollSeeded = await H.pollDataPath(shared, seeded.ids[0]);
  evidence.polls = { new_record: pollNew, seeded_record: pollSeeded };
  assert.equal(pollNew.arm, 'record'); assert.equal(pollSeeded.arm, 'record');
}));

// ------------------------------------------------------------------------------------------------
// 2 — two concurrent restore calls on the SAME runtime/client
// ------------------------------------------------------------------------------------------------
test('restore lifecycle 2: two concurrent restoreTrackedInjections() calls on the SAME runtime/client over a nonempty store — the overlap shares ONE in-flight open (same opening promise, one open message); both callers settle ok; FIXED EXPECTED: exactly ONE durable daemon_restart_observed fact for that recovery and exactly one such observation in a record\'s history; every record retained', () => withLifecycleStore('concurrent-restore', {}, async ({ store, seeded, shared, runtime, ledgerClient, messages, evidence }) => {
  const outboundBefore = messages.outbound.length;
  const p1 = runtime.restoreTrackedInjections();
  const opening1 = ledgerClient._internal.opening;
  const p2 = runtime.restoreTrackedInjections();
  const opening2 = ledgerClient._internal.opening;
  evidence.overlap = { same_opening_promise: !!opening1 && opening1 === opening2, client_state_during: ledgerClient.state, shared_during: snap(shared) };
  assert.ok(opening1 && opening1 === opening2, 'the second call joins the first in-flight open (opening-promise reuse)');
  assert.equal(ledgerClient.state, 'recovering', 'the client is recovering while both calls are in flight');
  const [r1, r2] = await Promise.all([p1, p2]);
  const openMessages = messages.outbound.slice(outboundBefore).filter((m) => m.type === 'open').length;
  evidence.settled = { r1: { ok: r1.ok, counts: r1.counts || null, restart_fact: r1.restartFact ? { outcome: r1.restartFact.outcome, seq: r1.restartFact.seq || null } : null }, r2: { ok: r2.ok, counts: r2.counts || null, restart_fact: r2.restartFact ? { outcome: r2.restartFact.outcome, seq: r2.restartFact.seq || null } : null }, open_messages: openMessages, shared: snap(shared) };
  assert.equal(openMessages, 1, `exactly one open message reached the owner (${openMessages})`);
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(shared.trackedLedgerHealthy, true);
  assert.equal(shared.trackedLedgerUnavailableReason, null);

  // durable, user-observable outcomes — frames on disk and the materialized record history
  const facts = restartFactsOnDisk(store.dir);
  const probe = await runtime.fetchTrackedInjection(seeded.ids[0]);
  const restartObs = probe.record ? probe.record.observations.filter((o) => o.kind === 'daemon_restart_observed') : null;
  evidence.durable = { restart_fact_frames: facts, restart_observations_on_probe_record: restartObs ? restartObs.length : null, probe_seq: probe.record ? probe.record.observation_seq : null, frames: countFrames(store.dir) };
  assert.ok(probe.record, `a seeded record is readable after the recovery (${JSON.stringify(probe.reason || null)})`);
  assert.equal(facts.length, 1, `FIXED EXPECTED: exactly ONE durable daemon_restart_observed fact for one recovery (observed ${facts.length}: ${JSON.stringify(facts)}). Prediction by reading: RED — both continuations of the shared open run the success branch and each submits the restart fact`);
  assert.equal(restartObs.length, 1, `the record history shows the restart exactly once (observed ${restartObs.length})`);
  assert.equal(probe.record.observation_seq, LIMITS.obsPerRecord + 1, 'seeded observations + one restart observation, nothing else');
  let retained = 0;
  for (const id of seeded.ids) { const f = await runtime.fetchTrackedInjection(id); if (f.record && f.record.inject_id === id) retained++; }
  evidence.retained = { expected: seeded.count, observed: retained };
  assert.equal(retained, seeded.count, 'every record of the migrated store is retained and readable');
}));

// ------------------------------------------------------------------------------------------------
// 3 — refusal controls through restore + the captured inject handler
// ------------------------------------------------------------------------------------------------
test('restore lifecycle 3a (control): a REAL foreign lock at the store\'s lock path — restore refuses by name (lock_present) with no owner spawned; the captured inject handler keeps the 503 TRACKING_CAPACITY / lock_present mapping; the poll data path names lock_present; no delivery; the lock bytes are untouched (no automatic break) and no store is created', () => withLifecycleStore('lock-conflict', { seed: false }, async ({ store, R, shared, runtime, injectHandler, ledgerClient, messages, evidence }) => {
  const foreign = Buffer.from(`${JSON.stringify({ pid: 2147483646, token: crypto.randomBytes(16).toString('hex'), started_at: nowIso() })}\n`);
  fs.writeFileSync(store.lockPath, foreign, { mode: 0o600 });
  const opened = await runtime.restoreTrackedInjections();
  evidence.opened = { result: { ok: opened.ok, state: opened.state || null, reason: opened.reason || null, lock: opened.lock ? { held: opened.lock.held, reason: opened.lock.reason } : null }, shared: snap(shared) };
  assert.equal(opened.ok, false); assert.equal(opened.reason, 'lock_present', JSON.stringify(opened));
  assert.equal(ledgerClient.state, 'lock_present');
  assert.equal(shared.trackedLedgerHealthy, false); assert.equal(shared.trackedLedgerUnavailableReason, 'lock_present', 'the shared lifecycle names the lock, never recovering');
  assert.equal(messages.outbound.filter((m) => m.type === 'open').length, 0, 'no owner was spawned behind a foreign lock');
  const res = H.makeRes();
  await injectHandler(H.makeReq('behind a foreign lock', 'orch', 'w1'), res);
  const poll = await H.pollDataPath(shared, 'any-inject-id');
  evidence.inject = { status: res.statusCode, body: res.body, deliveries: R.delivery.length }; evidence.poll = poll;
  assert.equal(res.statusCode, 503, `lock_present keeps the 503 mapping (observed ${res.statusCode} ${res.body && res.body.code})`);
  assert.equal(res.body.code, 'TRACKING_CAPACITY'); assert.equal(res.body.reason, 'lock_present'); assert.equal(res.body.tracking_state, 'unavailable');
  assert.equal(R.delivery.length, 0, 'no delivery');
  assert.equal(poll.arm, 'unhealthy'); assert.equal(poll.tracking_state, 'unavailable'); assert.equal(poll.reason, 'lock_present');
  assert.ok(fs.readFileSync(store.lockPath).equals(foreign), 'the foreign lock bytes are untouched (no auto break)');
  assert.equal(fs.existsSync(store.dir), false, 'no store was created behind a foreign lock');
}));

for (const variant of [
  // resume9: valid JSON with a WRONG store format reaches the owner's manifest_format branch; unparseable
  // bytes are (measured) named manifest_unreadable — the directory variant below already covers that.
  { name: 'manifest-wrong-format', ownerReason: 'manifest_format', mutate: (p) => fs.writeFileSync(p, `${JSON.stringify({ format: 999, published: true, token: 'not-a-store', epoch: 1 })}\n`) },
  { name: 'manifest-unreadable', ownerReason: 'manifest_unreadable', mutate: (p) => { fs.rmSync(p); fs.mkdirSync(p, { mode: 0o700 }); } },
]) {
  test(`restore lifecycle 3b (control) [${variant.name}]: a previously valid store whose MANIFEST is damaged (${variant.ownerReason}; no chmod) — restore refuses fail-closed (unavailable_read), the captured inject handler answers 500 TRACKING_PERSISTENCE_FAILED, the poll data path is unhealthy, the previously durable record is NOT served, no delivery, and not one byte of the store changes (no fabricated recovery)`, async () => {
    const store = H.privateStore(`telepty-1207-restore-${variant.name}-`);
    const seeded = writeLegacyLedger(store.dir, { count: LIMITS.seededRecords, obsPerRecord: LIMITS.obsPerRecord, prefix: `rl-${variant.name}` });
    const evidence = { case: variant.name, started_at: nowIso(), node: process.version, seeded: { count: seeded.count, bytes: seeded.bytes, sha256: seeded.sha256 },
      labels: { poll: 'control-harness pollDataPath = COPY of the daemon.js poll decision; NOT HTTP', inject: 'REAL captured inject handler (in-process call)' } };
    let durableId = null;
    // phase A — a valid store with one durable record, then a clean close
    {
      const R = H.recorders(); const built = H.buildShared(store, R, {});
      try {
        const o = await built.runtime.restoreTrackedInjections(); assert.equal(o.ok, true, JSON.stringify(o));
        const res = H.makeRes(); await built.injectHandler(H.makeReq('before the damage', 'orch', 'w1'), res);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body)); durableId = res.body.inject_id;
      } finally { evidence.phase_a_closed = await H.closeBounded(built.ledgerClient, LIMITS.closeMs); }
    }
    const manifestPath = path.join(store.dir, 'MANIFEST.json');
    assert.ok(fs.statSync(manifestPath).isFile(), 'phase A published a MANIFEST');
    variant.mutate(manifestPath);
    const treeBefore = treeSnapshot(store.dir);
    const parentBefore = fs.readdirSync(store.parent).filter((n) => n !== path.basename(store.lockPath)).sort();
    // phase B — a fresh runtime/client over the damaged store
    const R = H.recorders(); const messages = { inbound: [], outbound: [] };
    const built = H.buildShared(store, R, { messages });
    const { shared, runtime, injectHandler, ledgerClient } = built;
    let failed = true;
    try {
      const opened = await runtime.restoreTrackedInjections();
      evidence.opened = { result: { ok: opened.ok, state: opened.state || null, reason: opened.reason || null, detail: opened.detail ? opened.detail.detail : null }, shared: snap(shared) };
      assert.equal(opened.ok, false, JSON.stringify(opened));
      assert.equal(opened.state, 'unavailable_read', `fail-closed refusal (observed ${opened.state}/${opened.reason})`);
      assert.equal(opened.reason, variant.ownerReason, 'the intended fault path was reached (positive witness)');
      assert.equal(shared.trackedLedgerHealthy, false);
      assert.equal(shared.trackedLedgerUnavailableReason, 'observation_store_unavailable', 'an unreadable store is named observation_store_unavailable, never recovering');
      const res = H.makeRes();
      await injectHandler(H.makeReq('over a damaged store', 'orch', 'w1'), res);
      const pollDurable = await H.pollDataPath(shared, durableId);
      const pollSeeded = await H.pollDataPath(shared, seeded.ids[0]);
      evidence.inject = { status: res.statusCode, body: res.body, deliveries: R.delivery.length }; evidence.polls = { durable: pollDurable, seeded: pollSeeded };
      assert.equal(res.statusCode, 500, `corruption stays the fail-closed 500 branch (observed ${res.statusCode} ${res.body && res.body.code} ${res.body && res.body.reason})`);
      assert.equal(res.body.code, 'TRACKING_PERSISTENCE_FAILED'); assert.equal(res.body.reason, 'tracking_persistence_failed'); assert.equal(res.body.tracking_state, 'unavailable');
      assert.equal(R.delivery.length, 0, 'no delivery over a damaged store');
      assert.equal(pollDurable.arm, 'unhealthy', `the previously durable record is NOT served as healthy (${JSON.stringify(pollDurable)})`);
      assert.equal(pollDurable.reason, 'observation_store_unavailable'); assert.equal(pollSeeded.arm, 'unhealthy');
      assert.equal(ledgerClient.isHealthy(), false, 'the client never reports healthy over an unreadable store');
      const treeAfter = treeSnapshot(store.dir);
      evidence.store = { entries_before: Object.keys(treeBefore).length, entries_after: Object.keys(treeAfter).length };
      assert.deepEqual(treeAfter, treeBefore, 'not one byte of the damaged store changed — no fabricated recovery, no rewrite, no repair');
      assert.deepEqual(fs.readdirSync(store.parent).filter((n) => n !== path.basename(store.lockPath)).sort(), parentBefore, 'nothing was created beside the store (no staging, no aside, no legacy file)');
      failed = false;
    } finally {
      evidence.closed = await H.closeBounded(ledgerClient, LIMITS.closeMs);
      evidence.failed = failed; evidence.finished_at = nowIso();
      const file = H.writeEvidence(EVIDENCE, `restore-${variant.name}.json`, evidence);
      console.log(`[ledger-1207 restore ${variant.name}] evidence=${file}`);
      if (failed) console.log(`[ledger-1207 restore ${variant.name}] FAILED — private HOME preserved: ${store.home}`);
      else fs.rmSync(store.home, { recursive: true, force: true });
    }
  });
}

test('restore lifecycle 3c (boundary): no ledger client on the runtime — restore answers no_ledger_client, the captured inject handler refuses 500 TRACKING_PERSISTENCE_FAILED with no delivery and nothing is created (runtime API boundary: the daemon always constructs a client; the copied poll body dereferences the client, so it is not driven here)', async () => {
  const store = H.privateStore('telepty-1207-restore-no-client-');
  const R = H.recorders(); const built = H.buildShared(store, R, {});
  const realClient = built.ledgerClient;
  const evidence = { case: 'no-client', started_at: nowIso(), node: process.version, labels: { inject: 'REAL captured inject handler (in-process call)', poll: 'not driven: control-harness pollDataPath reads shared.ledgerClient.state' } };
  let failed = true;
  try {
    built.shared.ledgerClient = null;
    const opened = await built.runtime.restoreTrackedInjections();
    evidence.opened = { result: opened, shared: snap(built.shared) };
    assert.deepEqual(opened, { ok: false, reason: 'no_ledger_client' });
    assert.equal(built.shared.trackedLedgerHealthy, false); assert.equal(built.shared.trackedLedgerUnavailableReason, 'observation_store_unavailable');
    const res = H.makeRes();
    await built.injectHandler(H.makeReq('without a ledger client', 'orch', 'w1'), res);
    evidence.inject = { status: res.statusCode, body: res.body, deliveries: R.delivery.length };
    assert.equal(res.statusCode, 500, `no client is a fail-closed refusal (observed ${res.statusCode} ${res.body && res.body.code})`);
    assert.equal(res.body.code, 'TRACKING_PERSISTENCE_FAILED'); assert.equal(res.body.tracking_state, 'unavailable');
    assert.equal(R.delivery.length, 0, 'no delivery without a ledger client');
    assert.equal(fs.existsSync(store.dir), false, 'nothing was created at the store path');
    failed = false;
  } finally {
    built.shared.ledgerClient = realClient;
    evidence.closed = await H.closeBounded(realClient, LIMITS.closeMs);
    evidence.failed = failed; evidence.finished_at = nowIso();
    const file = H.writeEvidence(EVIDENCE, 'restore-no-client.json', evidence);
    console.log(`[ledger-1207 restore no-client] evidence=${file}`);
    if (failed) console.log(`[ledger-1207 restore no-client] FAILED — private HOME preserved: ${store.home}`);
    else fs.rmSync(store.home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------
// 4 — #1215 native44: lock-record DURABILITY delayed or failing, through the REAL client/runtime/inject
// handler. Measured on native Windows (df4cb86): the lock fsync took 258 ms ON the main thread inside
// the open. The fault model is storage that takes DURABILITY.delayMs to make the lock durable, applied to
// BOTH APIs of the client's own injected `fs` for the lock fd only: fsyncSync blocks the caller for the
// delay (Atomics.wait — what slow storage does to a synchronous fsync) and the callback fsync completes
// only when the test releases its gate. Everything else is real fs. RED/GREEN expectations are written
// against the original product (sync lock fsync) and the native44 candidate (lock.acquireDurable).
// ------------------------------------------------------------------------------------------------
const DURABILITY = Object.freeze({ delayMs: 300, enterMs: 2000, stallBoundMs: 50 });   // stallBoundMs = the existing #1207 heartbeat contract bound

function slowLockFs(lockPath, { failDurable = false } = {}) {
  const lockFds = new Set();
  const gate = { creates: 0, entered: 0, syncCalls: 0, released: false };
  let releaseGate; let released;
  gate.rearm = () => { gate.released = false; released = new Promise((resolve) => { releaseGate = resolve; }); };
  gate.release = () => { gate.released = true; releaseGate(); };
  gate.rearm();
  const eio = () => Object.assign(new Error('EIO: injected lock durability fault (test)'), { code: 'EIO' });
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  gate.fs = new Proxy(fs, { get(target, key) {
    const real = target[key];
    if (key === 'openSync') return (p, ...rest) => { const fd = real.call(target, p, ...rest); if (p === lockPath) { gate.creates++; lockFds.add(fd); } return fd; };
    if (key === 'fsyncSync') return (fd, ...rest) => {
      if (!lockFds.has(fd)) return real.call(target, fd, ...rest);
      gate.syncCalls++; sleepSync(DURABILITY.delayMs);
      if (failDurable) throw eio();
      return real.call(target, fd, ...rest);
    };
    if (key === 'fsync') return (fd, cb) => {
      if (!lockFds.has(fd)) return real.call(target, fd, cb);
      gate.entered++;
      released.then(() => (failDurable ? cb(eio()) : real.call(target, fd, cb)));   // the gate armed at call time
      return undefined;
    };
    if (key === 'closeSync' || key === 'close') return (fd, ...rest) => { lockFds.delete(fd); return real.call(target, fd, ...rest); };
    return real;
  } });
  return gate;
}
function loopGapMeter() {
  let last = performance.now(); let max = 0; let ticks = 0;
  const timer = setInterval(() => { const t = performance.now(); max = Math.max(max, t - last); last = t; ticks++; }, 1);
  return { stop() { clearInterval(timer); const t = performance.now(); max = Math.max(max, t - last); return { max_gap_ms: Math.round(max * 1000) / 1000, ticks }; } };
}
const lockFile = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const openMessages = (messages) => messages.outbound.filter((m) => m.type === 'open').length;

async function withDurabilityStore(name, { failDurable = false } = {}, fn) {
  const store = H.privateStore(`telepty-1207-durability-${name}-`);
  const gate = slowLockFs(store.lockPath, { failDurable });
  const counter = { constructed: 0 };
  const build = (messages, R) => {
    const Observed = H.makeObservedWorker(messages);
    class CountingWorker extends Observed { constructor(...args) { super(...args); counter.constructed++; } }
    return H.buildShared(store, R, { messages, clientOptions: { fs: gate.fs, Worker: CountingWorker } });
  };
  const R = H.recorders(); const messages = { inbound: [], outbound: [] };
  const built = build(messages, R);
  const extra = [];
  const evidence = { case: `durability-${name}`, started_at: nowIso(), node: process.version, platform: process.platform, limits: DURABILITY,
    labels: { fault: 'client-injected fs: lock fd only; fsyncSync blocks delayMs, callback fsync completes at gate release', inject: 'REAL captured inject handler (in-process call)' } };
  let failed = true;
  try { await fn({ store, gate, counter, R, messages, evidence, build, extra, ...built }); failed = false; } finally {
    gate.release();
    evidence.closed = await H.closeBounded(built.ledgerClient, LIMITS.closeMs);
    for (const c of extra) await H.closeBounded(c, LIMITS.closeMs);
    evidence.gate = { creates: gate.creates, entered: gate.entered, sync_calls: gate.syncCalls }; evidence.workers_constructed = counter.constructed;
    evidence.failed = failed; evidence.finished_at = nowIso();
    const file = H.writeEvidence(EVIDENCE, `durability-${name}.json`, evidence);
    console.log(`[ledger-1207 durability ${name}] evidence=${file}`);
    if (failed) console.log(`[ledger-1207 durability ${name}] FAILED — private HOME preserved: ${store.home}`);
    else fs.rmSync(store.home, { recursive: true, force: true });
  }
}

test('restore lifecycle 4a (native44 regression): lock durability DELAYED — the main loop stays responsive (no gap >= 50 ms) while the lock record is not durable; until it is: no owner Worker, no open message, not available, lock not held, the captured inject handler refuses 503 recovering with no delivery; after durability: one owner, available, lock names this client (expected RED on the original: its fsyncSync blocks the restore call for the whole delay; GREEN on native44)', () => withDurabilityStore('delayed', {}, async ({ store, gate, counter, R, messages, evidence, shared, runtime, injectHandler, ledgerClient }) => {
  const meter = loopGapMeter();
  const restoring = runtime.restoreTrackedInjections();
  let settled = null; restoring.then((v) => { settled = v; });
  const entered = await waitFor(() => gate.entered === 1, DURABILITY.enterMs);
  await H.sleep(DURABILITY.delayMs);   // durability is still pending: the gate is held for at least the fault delay
  const loop = meter.stop();
  const status = ledgerClient.status();
  evidence.pending = { loop, entered, sync_calls: gate.syncCalls, settled, state: ledgerClient.state, available: ledgerClient.isAvailable(), lock: status.lock, workers: counter.constructed, open_messages: openMessages(messages), shared: snap(shared) };
  assert.ok(loop.max_gap_ms < DURABILITY.stallBoundMs, `the main loop never stalls >= ${DURABILITY.stallBoundMs} ms while the lock is made durable (observed max gap ${loop.max_gap_ms} ms over ${loop.ticks} ticks; original: the synchronous fsync blocks ~${DURABILITY.delayMs} ms)`);
  assert.equal(gate.syncCalls, 0, 'the lock durability step never ran as fsyncSync on the calling thread');
  assert.equal(entered, true, 'the lock durability step reached the callback fsync (off-thread) and is held there');
  assert.equal(settled, null, 'the restore has not settled while the lock is not durable');
  assert.equal(ledgerClient.state, 'recovering'); assert.equal(ledgerClient.isAvailable(), false);
  assert.equal(status.lock.held, false, 'a lock whose record is not durable is not reported held');
  assert.equal(counter.constructed, 0, 'no owner Worker exists before the lock is durable');
  assert.equal(openMessages(messages), 0, 'no open message reached any owner before the lock is durable');
  assert.equal(gate.creates, 1, 'exactly one exclusive create');
  const res = H.makeRes();
  await injectHandler(H.makeReq('while the lock is not yet durable', 'orch', 'w1'), res);
  evidence.inject_pending = { status: res.statusCode, body: res.body, deliveries: R.delivery.length };
  assert.equal(res.statusCode, 503, `refused while recovering (observed ${res.statusCode} ${res.body && res.body.code} ${res.body && res.body.reason})`);
  assert.equal(res.body.code, 'TRACKING_CAPACITY'); assert.equal(res.body.reason, 'recovering');
  assert.equal(R.delivery.length, 0, 'no delivery before the store is usable');

  gate.release();
  const opened = await restoring;
  evidence.opened = { ok: opened.ok, reason: opened.reason || null, workers: counter.constructed, open_messages: openMessages(messages), shared: snap(shared) };
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(ledgerClient.isAvailable(), true); assert.equal(shared.trackedLedgerHealthy, true);
  assert.equal(counter.constructed, 1, 'exactly one owner Worker after durability'); assert.equal(openMessages(messages), 1);
  assert.equal(ledgerClient.status().lock.held, true);
  const contents = lockFile(store.lockPath);
  assert.ok(contents && Number(contents.pid) === process.pid && contents.token === ledgerClient._internal.token, `the durable lock names this client (${JSON.stringify(contents)})`);
}));

test('restore lifecycle 4b (native44 control, semantics preserved): lock durability FAILS (EIO) — restore refuses by name lock_error (step write), no owner Worker and no open message, the captured inject handler delivers nothing, the created lock is LEFT in place (uncertain lock retained), a re-open fails closed as lock_present (no automatic break) and close() never unlinks it (expected GREEN on the original and on native44)', () => withDurabilityStore('failed', { failDurable: true }, async ({ store, gate, counter, R, messages, evidence, shared, runtime, injectHandler, ledgerClient }) => {
  const restoring = runtime.restoreTrackedInjections();
  await waitFor(() => gate.entered + gate.syncCalls >= 1, DURABILITY.enterMs);
  gate.release();
  const opened = await restoring;
  evidence.opened = { result: { ok: opened.ok, state: opened.state || null, reason: opened.reason || null, lock: opened.lock ? { held: opened.lock.held, reason: opened.lock.reason, step: opened.lock.step, code: opened.lock.code } : null }, shared: snap(shared) };
  assert.equal(opened.ok, false, JSON.stringify(opened));
  assert.equal(opened.reason, 'lock_error');
  assert.ok(opened.lock && opened.lock.step === 'write' && opened.lock.code === 'EIO', `the durable-step failure keeps its classification (${JSON.stringify(opened.lock)})`);
  assert.equal(ledgerClient.state, 'unavailable'); assert.equal(ledgerClient.reason, 'lock_error');
  assert.equal(shared.trackedLedgerHealthy, false); assert.equal(shared.trackedLedgerUnavailableReason, 'lock_error');
  assert.equal(counter.constructed, 0, 'no owner behind a lock that is not durable'); assert.equal(openMessages(messages), 0);
  assert.equal(ledgerClient.status().lock.held, false);
  const res = H.makeRes();
  await injectHandler(H.makeReq('behind a lock that never became durable', 'orch', 'w1'), res);
  evidence.inject = { status: res.statusCode, body: res.body, deliveries: R.delivery.length };
  assert.notEqual(res.statusCode, 200); assert.equal(R.delivery.length, 0, 'no delivery');
  assert.equal(fs.existsSync(store.lockPath), true, 'the lock this client created is left in place, never unlinked');
  const bytes = fs.readFileSync(store.lockPath);
  const again = await ledgerClient.open();
  evidence.reopen = { ok: again.ok, state: again.state || null, reason: again.reason || null };
  assert.equal(again.ok, false); assert.equal(again.reason, 'lock_present', 'the uncertain lock fails a re-open closed (no stale break)');
  assert.equal(gate.creates, 1, 'the re-open created nothing');
  const closed = await ledgerClient.close(LIMITS.closeMs);
  evidence.close = closed;
  assert.equal(closed.lock.released, false, 'close() never releases a lock whose durability failed');
  assert.ok(fs.readFileSync(store.lockPath).equals(bytes), 'the uncertain lock bytes are untouched');
  assert.equal(counter.constructed, 0);
}));

test('restore lifecycle 4c (native44 regression): concurrent open/close/reopen while lock durability is pending — (1) a second open and an open issued during close JOIN the one in-flight open (one create) and it settles closed: no owner is constructed and the client\'s own lock is released once durable, never leaked; (2) an open() during an in-flight close of an OPENED client (owner present) is refused by name (shutting_down) instead of replacing the owner, and the close releases the lock; (3) a fresh client then acquires, opens with exactly one owner and releases (expected RED on the original: no off-thread durability, owners are spawned and the open during close is not refused; GREEN on native51)', () => withDurabilityStore('concurrent', {}, async ({ store, gate, counter, messages, evidence, build, extra, runtime, ledgerClient }) => {
  // (1) restore + concurrent open + close, all while the first acquisition's durability is pending
  const restoring = runtime.restoreTrackedInjections();
  const opening1 = ledgerClient._internal.opening;
  const joined = ledgerClient.open();
  assert.ok(opening1 && joined === opening1, 'a concurrent open joins the in-flight open (same promise) before anything yields');
  assert.equal(await waitFor(() => gate.entered === 1, DURABILITY.enterMs), true, 'durability is pending off-thread');
  const closing = ledgerClient.close(LIMITS.closeMs);
  const during = ledgerClient.open();
  assert.equal(during, opening1, 'an open during close joins the in-flight open — it cannot start a second acquisition');
  assert.equal(gate.creates, 1, 'one exclusive create for every open of this acquisition');
  gate.release();
  const [restored, closed] = await Promise.all([restoring, closing]);
  evidence.part1 = { restored: { ok: restored.ok, reason: restored.reason || null }, closed, workers: counter.constructed, open_messages: openMessages(messages), state: ledgerClient.state, lock_exists: fs.existsSync(store.lockPath) };
  assert.equal(restored.ok, false, 'the open that close() overtook does not succeed'); assert.equal(restored.reason, 'closed');
  assert.equal(counter.constructed, 0, 'no owner was resurrected after close'); assert.equal(openMessages(messages), 0);
  assert.equal(ledgerClient.state, 'closed'); assert.equal(ledgerClient.isAvailable(), false);
  assert.equal(closed.lock.released, true, `the client's own durable lock is released by close (${JSON.stringify(closed.lock)})`);
  assert.equal(fs.existsSync(store.lockPath), false, 'no leaked lock file');

  // (2) native51 (review D1): an open() during an in-flight close of an OPENED client (owner present) is refused by
  // name instead of clearing `closing` and replacing the owner; the close then completes and releases the lock.
  // (The daemon's load-time synchronous acquireLock()/releaseLock() shape is test 4d.)
  const R2 = H.recorders(); const messages2 = { inbound: [], outbound: [] };
  const second = build(messages2, R2); extra.push(second.ledgerClient);
  const opened2 = await second.runtime.restoreTrackedInjections();
  assert.equal(opened2.ok, true, JSON.stringify(opened2));
  assert.equal(counter.constructed, 1, 'one owner for the opened client');
  const creates2 = gate.creates;
  const closing2 = second.ledgerClient.close(LIMITS.closeMs);
  const refused = await second.ledgerClient.open();
  evidence.part2 = { opened: opened2.ok, refused, workers_during_close: counter.constructed };
  assert.equal(refused.ok, false); assert.equal(refused.reason, 'shutting_down', `an open during an in-flight close is refused by name (${JSON.stringify(refused)})`);
  assert.equal(gate.creates, creates2, 'the refused open created nothing');
  assert.equal(counter.constructed, 1, 'the refused open constructed no replacement owner');
  const closed2 = await closing2;
  assert.equal(closed2.lock.released, true, 'the close completes and releases the lock'); assert.equal(fs.existsSync(store.lockPath), false);
  assert.equal(second.ledgerClient.state, 'closed'); assert.equal(openMessages(messages2), 1);

  // (3) reopen: a fresh client on the same store takes the lock, opens with exactly one owner, and releases it
  const R3 = H.recorders(); const messages3 = { inbound: [], outbound: [] };
  const third = build(messages3, R3); extra.push(third.ledgerClient);
  const reopened = await third.runtime.restoreTrackedInjections();
  evidence.part3 = { ok: reopened.ok, reason: reopened.reason || null, workers: counter.constructed, open_messages: openMessages(messages3) };
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  assert.equal(counter.constructed, 2, 'exactly one owner per opened client (parts 2 and 3); none for part 1'); assert.equal(openMessages(messages3), 1);
  const contents = lockFile(store.lockPath);
  assert.ok(contents && contents.token === third.ledgerClient._internal.token, 'the lock names the new client');
  const closed3 = await third.ledgerClient.close(LIMITS.closeMs);
  assert.equal(closed3.lock.released, true); assert.equal(fs.existsSync(store.lockPath), false);
}));

test('restore lifecycle 4d (native51 regression, review D1): the daemon.js load-time shape — acquireLock() and then, in the SAME synchronous turn, releaseLock() (daemon.js:719 and :1136-1137 before process.exit(1)) — the public acquire answers held and durable, the release removes the lock, no lock file remains, and the next client for this store opens available, not lock_present (expected GREEN on the original, RED on native44 as submitted: its acquireLock left durability pending so releaseLock answered not_held; GREEN on native51). In-process, all platforms; test/integration/ledger-early-exit-lock-1207.test.js EX2 stays the real-daemon POSIX gate', () => withDurabilityStore('daemon-load-exit', {}, async ({ store, gate, counter, evidence, build, extra, ledgerClient }) => {
  // one synchronous turn with no await between the calls — exactly the daemon's config-failure exit path
  const claimed = ledgerClient.acquireLock();
  const released = ledgerClient.releaseLock();
  const lockLeft = fs.existsSync(store.lockPath);
  evidence.load_exit = { claimed: { held: claimed.held, durable: claimed.durable === undefined ? 'unset' : claimed.durable }, released, lock_left: lockLeft, sync_calls: gate.syncCalls, entered: gate.entered };
  assert.equal(claimed.held, true, JSON.stringify(claimed));
  assert.notEqual(claimed.durable, false, 'the public acquire answers only once the lock is durable (synchronous contract)');
  assert.equal(released.released, true, `the same-turn release succeeds (${JSON.stringify(released)})`);
  assert.equal(lockLeft, false, 'no lock outlives the early exit');
  assert.equal(gate.entered, 0, 'the public acquire never took the off-thread durability path');
  assert.equal(counter.constructed, 0, 'no owner');
  // the next daemon for this store: a fresh client opens available (not lock_present). Its open() takes the
  // off-thread path, so the durability gate is released first.
  gate.release();
  const next = build({ inbound: [], outbound: [] }, H.recorders()); extra.push(next.ledgerClient);
  const opened = await next.runtime.restoreTrackedInjections();
  evidence.next_open = { ok: opened.ok, reason: opened.reason || null, state: next.ledgerClient.state };
  assert.equal(opened.ok, true, JSON.stringify(opened)); assert.equal(next.ledgerClient.state, 'available');
}));
