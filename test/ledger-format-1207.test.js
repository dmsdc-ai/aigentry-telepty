'use strict';

// #1207 — pure ledger format (primitive gate): frames, tails, log-position overlay equivalence
// (ACCEPTANCE R3 as patched by errata C3), index entries, class accounting inequalities (C5).
// No filesystem, no worker, no daemon. Author-written; independent verification is separate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const F = require('../src/session-store/ledger-format');
const persistence = require('../src/session-store/persistence');

function obs(kind, trigger, at, extra = {}) { return { kind, trigger, at, ...extra }; }

test('frame roundtrip, tail detection, hash mismatch, unparseable json', () => {
  const a = F.encodeFrame({ t: 'obs', epoch: 1, seq: 1, txn: 'a', id: 'x', observation: obs('output_observed', 'output_received', 't1') });
  const b = F.encodeFrame({ t: 'commit', epoch: 1, seq_from: 1, seq_to: 1, n: 1 });
  const whole = Buffer.concat([a, b]);
  const ok = F.decodeFrames(whole);
  assert.equal(ok.tail, null);
  assert.equal(ok.frames.length, 2);
  assert.deepEqual(ok.frames.map((f) => [f.offset, f.length]), [[0, a.length], [a.length, b.length]]);
  assert.equal(ok.frames[0].obj.t, 'obs');
  // torn tail: no newline
  const torn = F.decodeFrames(whole.subarray(0, whole.length - 3));
  assert.equal(torn.frames.length, 1);
  assert.deepEqual(torn.tail, { offset: a.length, bytes: b.length - 3, reason: 'no_newline' });
  // one byte flipped inside the first frame's json: nothing after it is applied, nothing is removed
  const flipped = Buffer.from(whole); flipped[5] = flipped[5] === 0x61 ? 0x62 : 0x61;
  const bad = F.decodeFrames(flipped);
  assert.equal(bad.frames.length, 0);
  assert.equal(bad.tail.offset, 0);
  assert.equal(bad.tail.reason, 'hash_mismatch');
  assert.equal(bad.tail.bytes, flipped.length, 'the tail covers every byte from the first bad frame');
  // hash matches but json does not parse (fabricated)
  const json = '{"t":"obs",'; const line = Buffer.from(json + '\t' + F.frameHash(json) + '\n');
  assert.equal(F.decodeFrames(line).tail.reason, 'unparseable');
  assert.equal(F.frameBytes({ t: 'x' }), F.encodeFrame({ t: 'x' }).length);
});

test('groupFrames: only commit-framed groups close; open frames stay listed; a commit frame that miscounts is invalid', () => {
  const frames = (objs) => F.decodeFrames(Buffer.concat(objs.map((o) => F.encodeFrame(o)))).frames;
  const g1 = F.groupFrames(frames([
    { t: 'obs', epoch: 1, seq: 1, txn: 'a' }, { t: 'obs', epoch: 1, seq: 2, txn: 'b' }, { t: 'commit', epoch: 1, seq_from: 1, seq_to: 2, n: 2 },
    { t: 'obs', epoch: 1, seq: 3, txn: 'c' },
  ]));
  assert.equal(g1.groups.length, 1);
  assert.equal(g1.groups[0].frames.length, 2);
  assert.equal(g1.open.length, 1);
  assert.equal(g1.open[0].obj.txn, 'c');
  assert.equal(g1.invalidCommit, null);
  const g2 = F.groupFrames(frames([{ t: 'obs', epoch: 1, seq: 1, txn: 'a' }, { t: 'commit', epoch: 1, seq_from: 1, seq_to: 1, n: 5 }]));
  assert.equal(g2.groups.length, 0);
  assert.ok(g2.invalidCommit, 'a commit frame describing 5 frames after 1 is not a valid commit');
  assert.equal(g2.open.length, 2);
});

test('log positions compare by (epoch, seq), never by timestamps', () => {
  assert.equal(F.comparePos(F.pos(1, 9), F.pos(2, 1)), -1);
  assert.equal(F.comparePos(F.pos(2, 1), F.pos(1, 9)), 1);
  assert.equal(F.comparePos(F.pos(3, 3), F.pos(3, 3)), 0);
  assert.equal(F.comparePos(F.pos(0, 0), F.pos(0, 1)), -1);
});

test('appendObservation == persistence.appendLedgerObservation (seq, at, last_observation, 50-cap)', () => {
  const mutable = { inject_id: 'i', session_id: 's', observation_seq: 0, observations: [], last_observation: null, tracking_state: 'tracked' };
  let pure = { ...mutable };
  for (let i = 0; i < 60; i++) {
    const o = { kind: i % 2 ? 'output_observed' : 'busy_indicator_pattern_observed', trigger: i % 2 ? 'output_received' : 'busy_indicator_pattern', n: i };
    persistence.appendLedgerObservation(mutable, o, `t${i}`);
    pure = F.appendObservation(pure, { ...o, at: `t${i}` }).record;
  }
  assert.deepEqual(pure.observations, mutable.observations);
  assert.deepEqual(pure.last_observation, mutable.last_observation);
  assert.equal(pure.observation_seq, mutable.observation_seq);
  assert.equal(pure.observations.length, F.MAX_OBSERVATIONS_PER_RECORD);
});

test('applyFrame is deterministic: the same frames in two projections produce deepEqual state', () => {
  const frames = [
    { t: 'begin', epoch: 1, seq: 1, txn: 'b1', id: 'A', sid: 's1', record: { inject_id: 'A', session_id: 's1', observation_seq: 1, tracking_state: 'tracked', observations: [{ kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't0' }], last_observation: { kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't0' } }, supersede: [] },
    { t: 'fact', epoch: 1, seq: 2, txn: 'f1', scope: 'global', observation: obs('daemon_restart_observed', 'daemon_restart', 't1') },
    { t: 'obs', epoch: 1, seq: 3, txn: 'o1', id: 'A', observation: obs('output_observed', 'output_received', 't2') },
    { t: 'begin', epoch: 1, seq: 4, txn: 'b2', id: 'B', sid: 's1', record: { inject_id: 'B', session_id: 's1', observation_seq: 1, tracking_state: 'tracked', observations: [{ kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't3' }], last_observation: { kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't3' } }, supersede: [{ id: 'A', entry: { kind: 'tracking_superseded', trigger: 'superseded_by_new_tracked_inject', superseded_by: 'B', at: 't3' } }] },
    { t: 'state', epoch: 1, seq: 5, txn: 's1', id: 'B', tracking_state: 'aborted', observation: obs('inject_delivery_refused', 'delivery_refused', 't4', { delivery_code: 'X', bytes_written: 0 }) },
  ];
  const run = () => { const m = new Map(); const ctx = { get: (id) => m.get(id) || null, set: (id, r) => m.set(id, r), facts: [] }; for (const f of frames) F.applyFrame(f, ctx); return { records: Object.fromEntries(m), facts: ctx.facts }; };
  const x = run(); const y = run();
  assert.deepEqual(x, y);
  // the restart fact (seq 2) was folded into A BEFORE its obs (seq 3): A's observations are
  // tracking_started, daemon_restart_observed, output_observed, tracking_superseded
  assert.deepEqual(x.records.A.observations.map((o) => o.kind), ['tracking_started', 'daemon_restart_observed', 'output_observed', 'tracking_superseded']);
  assert.deepEqual(x.records.A.observations.map((o) => o.seq), [1, 2, 3, 4]);
  assert.equal(x.records.A.tracking_state, 'superseded');
  assert.equal(x.records.B.tracking_state, 'aborted');
  // B began AFTER the fact (materialized_through = its own pos), so the fact is not overlaid on B
  assert.deepEqual(F.overlay(x.records.B, x.facts).observations.map((o) => o.kind), ['tracking_started', 'inject_delivery_refused']);
  // state on a terminal record is refused; obs on a terminal record is allowed
  const m = new Map(Object.entries(x.records)); const ctx = { get: (id) => m.get(id) || null, set: (id, r) => m.set(id, r), facts: x.facts };
  assert.throws(() => F.applyFrame({ t: 'state', epoch: 1, seq: 6, txn: 's2', id: 'B', tracking_state: 'superseded', observation: obs('x', 'y', 't') }, ctx), /record_terminal/);
  assert.doesNotThrow(() => F.applyFrame({ t: 'obs', epoch: 1, seq: 6, txn: 'o2', id: 'B', observation: obs('owner_replaced_observed', 'owner_epoch_replaced', 't') }, ctx));
});

// ACCEPTANCE R3 (patched): overlay deepEqual a replay of frames in (epoch, seq) order; timestamps never affect order.
test('R3: lazy fact overlay == today\'s per-record append sequence, in LOG order, for 1000 records with equal and backwards `at`', () => {
  const rng = (() => { let s = 20261027; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const base = Date.parse('2026-10-01T00:00:00Z');
  for (let r = 0; r < 1000; r++) {
    const nObs = 1 + Math.floor(rng() * 55);
    const restarts = Math.floor(rng() * 4);
    const lifecycle = Math.floor(rng() * 3);
    const sid = `s${r % 7}`;
    // today's shape: begin, N observations, then facts appended per record in the order they happened
    const today = { inject_id: `i${r}`, session_id: sid, observation_seq: 0, observations: [], last_observation: null, tracking_state: 'tracked' };
    persistence.appendLedgerObservation(today, { kind: 'tracking_started', trigger: 'inject_accepted' }, new Date(base).toISOString());
    for (let i = 1; i < nObs; i++) persistence.appendLedgerObservation(today, { kind: 'output_observed', trigger: 'output_received', i }, new Date(base + i).toISOString());
    const stored = JSON.parse(JSON.stringify(today));
    stored.materialized_through = F.pos(1, 1);     // record written at (1,1)
    // facts after it in LOG order, with deliberately equal / backwards wall-clock `at` values
    const facts = []; let seq = 2; const kinds = [];
    for (let k = 0; k < restarts; k++) { const at = new Date(base - 1000 * k).toISOString(); facts.push({ pos: F.pos(1, seq++), scope: 'global', sid: null, observation: { kind: 'daemon_restart_observed', trigger: 'daemon_restart', at } }); kinds.push(at); }
    for (let k = 0; k < lifecycle; k++) { const at = new Date(base).toISOString(); facts.push({ pos: F.pos(2, 1 + k), scope: 'session', sid: k % 2 ? sid : 'other', observation: { kind: 'owner_replaced_observed', trigger: 'owner_epoch_replaced', at } }); }
    // a fact from BEFORE the record was materialized must not apply
    facts.unshift({ pos: F.pos(0, 5), scope: 'global', sid: null, observation: { kind: 'daemon_restart_observed', trigger: 'daemon_restart', at: 'ancient' } });
    for (const f of facts.filter((x) => F.comparePos(x.pos, stored.materialized_through) > 0 && (x.scope === 'global' || x.sid === sid))) {
      persistence.appendLedgerObservation(today, { kind: f.observation.kind, trigger: f.observation.trigger }, f.observation.at);
    }
    const view = F.overlay(stored, facts);
    assert.deepEqual(view.observations, today.observations, `record ${r}: overlay must equal the per-record append sequence`);
    assert.deepEqual(view.last_observation, today.last_observation);
    assert.equal(view.observation_seq, today.observation_seq);
    assert.equal(view.observations.length <= F.MAX_OBSERVATIONS_PER_RECORD, true);
    // shuffling the facts' wall-clock values changes nothing: only pos decides
    const shuffled = facts.map((f) => ({ ...f, observation: { ...f.observation, at: new Date(base + Math.floor(rng() * 1e6)).toISOString() } }));
    assert.deepEqual(F.overlay(stored, shuffled).observations.map((o) => [o.kind, o.seq]), view.observations.map((o) => [o.kind, o.seq]));
  }
});

test('materialize at reheat advances materialized_through; later facts still overlay', () => {
  const rec = { inject_id: 'i', session_id: 's', observation_seq: 1, observations: [{ kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't' }], last_observation: { kind: 'tracking_started', trigger: 'inject_accepted', seq: 1, at: 't' }, tracking_state: 'tracked', materialized_through: F.pos(0, 0) };
  const facts = [{ pos: F.pos(1, 1), scope: 'global', observation: obs('daemon_restart_observed', 'daemon_restart', 'a') }, { pos: F.pos(1, 7), scope: 'global', observation: obs('daemon_restart_observed', 'daemon_restart', 'b') }];
  const hot = F.materialize(rec, F.pendingFactsFor(rec, facts, F.pos(1, 5)), F.pos(1, 5));
  assert.equal(hot.observation_seq, 2);
  assert.deepEqual(hot.materialized_through, F.pos(1, 5));
  const view = F.overlay(hot, facts);
  assert.equal(view.observation_seq, 3, 'the fact at (1,7) is still overlaid; the one at (1,1) was folded exactly once');
  assert.deepEqual(view.observations.map((o) => o.at), ['t', 'a', 'b']);
});

test('32-byte index entries: encode/decode, sorted build, exact and multi lookups', () => {
  const entries = ['a', 'b', 'c', 'c', 'zz'].map((k, i) => ({ key: F.keyPrefix(k), file: i % 3, offset: i * 1000, len: 100 + i, flags: i % 2 }));
  const buf = F.buildIndex(entries);
  assert.equal(buf.length, entries.length * F.INDEX_ENTRY_BYTES);
  for (let i = 1; i * F.INDEX_ENTRY_BYTES < buf.length; i++) assert.ok(Buffer.compare(buf.subarray((i - 1) * 32, (i - 1) * 32 + 16), buf.subarray(i * 32, i * 32 + 16)) <= 0, 'sorted by key');
  const c = F.findIndexEntries(buf, 'c');
  assert.equal(c.length, 2);
  assert.deepEqual(c.map((e) => e.offset).sort(), [2000, 3000]);
  assert.equal(F.findIndexEntries(buf, 'nope').length, 0);
  const one = F.decodeIndexEntry(F.encodeIndexEntry({ key: F.keyPrefix('k'), file: 65535, offset: 2 ** 40 + 7, len: 4294967295, flags: 9 }));
  assert.deepEqual([one.file, one.offset, one.len, one.flags], [65535, 2 ** 40 + 7, 4294967295, 9]);
  assert.ok(one.key.equals(F.keyPrefix('k')));
});

test('classify: result-class vs transition-class observations; facts/reheat are L; iact is I; state/begin are T', () => {
  assert.equal(F.classify('state'), 'T');
  assert.equal(F.classify('begin'), 'T');
  assert.equal(F.classify('fact'), 'L');
  assert.equal(F.classify('reheat'), 'L');
  assert.equal(F.classify('iact'), 'I');
  assert.equal(F.classify('obs', { kind: 'output_observed', emitted_via: 'transition' }), 'O');
  assert.equal(F.classify('obs', { kind: 'inject_parked' }), 'R');
  assert.equal(F.classify('obs', { kind: 'pty_quiet', emitted_via: 'real-idle' }), 'R');
  assert.equal(F.classify('obs', { kind: 'output_observed' }, { result: true }), 'R');
});

// ACCEPTANCE C5: exact inequalities under random submissions.
test('C5: inflight_entries(c)+prospective <= POOL_entries(c) and bytes likewise, at every step, for every class; totals never exceeded', () => {
  let t = 0;
  const acct = F.createAccounting({ now: () => t });
  const rng = (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const live = []; let admitted = 0; let rejected = 0; let jobs = 0;
  for (let step = 0; step < 20000; step++) {
    t += 1;
    const r = rng();
    if (r < 0.15) { const id = `job${jobs}`; const res = acct.reserveJob(id); if (res.ok) { jobs++; live.push({ job: id }); } }
    else if (r < 0.8) {
      const cls = ['O', 'O', 'O', 'R', 'L', 'T', 'I'][Math.floor(rng() * 7)];
      const bytes = cls === 'L' ? Math.floor(rng() * 1048576) : Math.floor(rng() * 16384);
      const jobId = cls === 'T' || cls === 'R' ? (live.find((x) => x.job) || {}).job || null : null;
      const res = acct.admit(cls, bytes, { jobId, t });
      if (res.ok) { admitted++; live.push({ cls: res.class, bytes, jobId, reserved: res.reserved }); } else rejected++;
    } else if (live.length) {
      const i = Math.floor(rng() * live.length); const [x] = live.splice(i, 1);
      if (x.job) acct.releaseJob(x.job); else acct.release(x.cls, x.bytes, { jobId: x.jobId, reserved: x.reserved });
    }
    const check = acct.check();
    assert.ok(check.ok, `step ${step}: inequality violated for ${check.violations.join(',')}`);
    const st = acct.status();
    for (const c of ['T', 'R', 'L', 'O', 'I']) assert.ok(st.inflight[c].entries <= F.POOLS[c].entries && st.inflight[c].bytes <= F.POOLS[c].bytes, `pool ${c} within bounds`);
    assert.ok(check.totalEntries <= F.POOL_TOTALS.entries && check.totalBytes <= F.POOL_TOTALS.bytes);
    assert.ok(st.admitted_jobs <= F.R_MAX_JOBS);
  }
  assert.ok(admitted > 0 && rejected > 0, 'the random walk must exercise both admission and rejection');
  // a job may never consume more than its 2 reserved R units from the reservation; the third is shared
  const a2 = F.createAccounting({ now: () => 0 });
  assert.equal(a2.reserveJob('j').ok, true);
  assert.equal(a2.admit('R', 100, { jobId: 'j' }).reserved, true);
  assert.equal(a2.admit('R', 100, { jobId: 'j' }).reserved, true);
  assert.equal(a2.admit('R', 100, { jobId: 'j' }).reserved, false, 'third result draws on the shared pool');
  // T without a job reservation is never admitted; begin at R_MAX is refused
  assert.equal(a2.admit('T', 10, { jobId: 'nope' }).ok, false);
  const a3 = F.createAccounting({ now: () => 0 });
  for (let i = 0; i < F.R_MAX_JOBS; i++) assert.equal(a3.reserveJob(`j${i}`).ok, true);
  assert.deepEqual(a3.reserveJob('one-more'), { ok: false, reason: 'tracking_capacity_exhausted' });
  // sustained exhaustion: a pool that rejected within 5 s and is still full refuses new begins.
  // Fixture arithmetic (resume3 correction): the O pool declares 1024 entries AND 4 MiB of bytes; at
  // one cap-sized unit (16384 B) per admission the BYTE budget binds first, so the pool holds
  // min(entries, floor(bytes / unit)) admissions — derived from the declared constants, not chosen.
  let now = 1000; const a4 = F.createAccounting({ now: () => now });
  const oCapacity = Math.min(F.POOLS.O.entries, Math.floor(F.POOLS.O.bytes / 16384));
  assert.ok(oCapacity < F.POOLS.O.entries, 'the byte budget is the tighter O constraint under cap-sized units');
  for (let i = 0; i < oCapacity; i++) assert.equal(a4.admit('O', 16384, { t: now }).ok, true, `O admission ${i + 1}/${oCapacity}`);
  const oFull = a4.admit('O', 16384, { t: now });
  assert.equal(oFull.ok, false, 'the admission past the tighter O constraint is refused');
  assert.equal(oFull.reason, 'tracking_backpressure');
  assert.equal(a4.status().inflight.O.entries, oCapacity, 'a refusal mutates no counter');
  assert.equal(a4.reserveJob('late', now + 100).ok, false);
  assert.equal(a4.reserveJob('late', now + 100).reason, 'sustained_exhaustion');
  // room returns and 5 s pass: begins resume
  a4.release('O', 16384); now += 6000;
  assert.equal(a4.reserveJob('late').ok, true);
  // per-act I reservation: at most 4 concurrent acts
  const a5 = F.createAccounting();
  for (let i = 0; i < 4; i++) assert.equal(a5.reserveAct(`s${i}`), true);
  assert.equal(a5.reserveAct('s4'), false);
  a5.releaseAct('s0'); assert.equal(a5.reserveAct('s4'), true);
});

// ---------------------------------------------------------------------------------------------
// Capacity / reservation regressions (resume3). Measured defect: the C5 walk above violated the I
// budget at step 210 against the original module (I admissions were counted but never bounded).
// These cases pin each class's entry AND byte budget, refusal without counter mutation, capacity
// restoration on a valid release, reserved-vs-shared accounting, and invalid inputs. New defects
// they expose against the original module are labelled separately from the measured one.
// ---------------------------------------------------------------------------------------------
function snapshot(acct) { const s = acct.status(); return JSON.stringify({ inflight: s.inflight, jobs: s.admitted_jobs, acts: s.acts }); }
function assertNoMutation(acct, before, label) { assert.equal(snapshot(acct), before, `${label}: a refusal must not mutate any counter`); }

test('capacity I: interaction admissions are bounded by the per-act promise (3 entries / 1064960 B per reserved act) and the pool (12 / 4259840); refusal mutates nothing; release restores', () => {
  const p = F.POOLS.I;
  const a = F.createAccounting();
  // no act reserved ⇒ nothing is admitted (the core reserves an act BEFORE its first saveRecord)
  const before0 = snapshot(a);
  const none = a.admit('I', 100);
  assert.equal(none.ok, false); assert.equal(none.class, 'I'); assertNoMutation(a, before0, 'I without an act');
  // one act: exactly perAct.entries admissions, then refusal without mutation
  assert.equal(a.reserveAct('s1'), true);
  for (let i = 0; i < p.perAct.entries; i++) assert.equal(a.admit('I', 4096).ok, true, `act s1 admission ${i + 1}`);
  const b1 = snapshot(a);
  assert.equal(a.admit('I', 4096).ok, false, 'a 4th entry exceeds the single act\'s 3-entry promise'); assertNoMutation(a, b1, 'I over per-act entries');
  // release one entry ⇒ capacity restored for that act
  a.release('I', 4096, { reserved: true });
  assert.equal(a.admit('I', 4096).ok, true, 'a valid release restores the released capacity');
  // byte budget per act binds independently of entries
  const b = F.createAccounting();
  assert.equal(b.reserveAct('s1'), true);
  assert.equal(b.admit('I', p.perAct.bytes).ok, true, 'one admission may use the whole per-act byte budget');
  const bb = snapshot(b);
  assert.equal(b.admit('I', 1).ok, false, 'one more byte exceeds the per-act byte promise even with entries left'); assertNoMutation(b, bb, 'I over per-act bytes');
  // four acts: the pool bound (12 entries / 4259840 B) is the ceiling; a 13th admission is refused
  const c = F.createAccounting();
  for (let i = 0; i < p.concurrentActs; i++) assert.equal(c.reserveAct(`s${i}`), true);
  for (let i = 0; i < p.entries; i++) assert.equal(c.admit('I', 1000).ok, true, `pool admission ${i + 1}/${p.entries}`);
  const bc = snapshot(c);
  assert.equal(c.admit('I', 1000).ok, false, 'the 13th interaction entry exceeds the I pool'); assertNoMutation(c, bc, 'I over pool');
  assert.ok(c.check().ok);
  // releasing an act never pushes inflight above the pool; the walk's invariant holds afterwards
  c.releaseAct('s0');
  assert.ok(c.check().ok);
  assert.equal(c.admit('I', 1).ok, false, 'with 3 acts left, 12 inflight already exceeds 3 x 3: refused until releases');
});

test('capacity T: one terminal unit per admitted job — a second concurrent T for the same job is refused without mutation; release returns the unit; bytes above the unit are refused; no job ⇒ never admitted', () => {
  const p = F.POOLS.T;
  const a = F.createAccounting();
  const b0 = snapshot(a);
  assert.equal(a.admit('T', 100).ok, false); assertNoMutation(a, b0, 'T without a job');
  assert.equal(a.reserveJob('j1').ok, true);
  const first = a.admit('T', p.unit, { jobId: 'j1' });
  assert.equal(first.ok, true); assert.equal(first.reserved, true);
  const b1 = snapshot(a);
  const second = a.admit('T', p.unit, { jobId: 'j1' });
  assert.equal(second.ok, false, 'the job\'s single terminal unit is already inflight'); assertNoMutation(a, b1, 'second concurrent T');
  a.release('T', p.unit, { jobId: 'j1', reserved: true });
  assert.equal(a.admit('T', p.unit, { jobId: 'j1' }).ok, true, 'the unit is returned on release (begin then terminal on the same reservation)');
  // a frame larger than the reserved unit cannot ride on the reservation
  assert.equal(a.reserveJob('j2').ok, true);
  const bj2 = snapshot(a);
  assert.equal(a.admit('T', p.unit + 1, { jobId: 'j2' }).ok, false); assertNoMutation(a, bj2, 'T above the unit');
  // 512 jobs each with one terminal inflight fill exactly the T pool; nothing exceeds it
  const full = F.createAccounting();
  for (let i = 0; i < F.R_MAX_JOBS; i++) { assert.equal(full.reserveJob(`j${i}`).ok, true); assert.equal(full.admit('T', p.unit, { jobId: `j${i}` }).ok, true); }
  assert.equal(full.status().inflight.T.entries, p.entries); assert.equal(full.status().inflight.T.bytes, p.bytes);
  assert.ok(full.check().ok, 'T at exactly the pool is within bounds');
  assert.equal(full.reserveJob('one-more').ok, false);
});

test('capacity R: two reserved units per job are consumed, not returned; the shared pool is bounded at 128 entries / 2 MiB with refusal tracking_capacity_result and no mutation; a new job\'s reserved units are honoured while the shared pool is full', () => {
  const p = F.POOLS.R;
  const a = F.createAccounting({ now: () => 0 });
  assert.equal(a.reserveJob('j').ok, true);
  assert.equal(a.admit('R', 1000, { jobId: 'j' }).reserved, true);
  assert.equal(a.admit('R', 1000, { jobId: 'j' }).reserved, true);
  a.release('R', 1000, { jobId: 'j', reserved: true });
  assert.equal(a.status().inflight.R.entries, 1, 'release lowers inflight');
  assert.equal(a.admit('R', 1000, { jobId: 'j' }).reserved, false, 'a consumed reserved unit is NOT returned by release: the third result is shared');
  // shared pool: exactly p.shared entries of one unit each, then refusal without mutation
  // (a non-zero clock: production never rejects at epoch 0, and the sustained-exhaustion rule reads
  // the time of the last rejection)
  const s = F.createAccounting({ now: () => 1000 });
  for (let i = 0; i < p.shared; i++) assert.equal(s.admit('R', p.unit).ok, true, `shared admission ${i + 1}/${p.shared}`);
  const bs = snapshot(s);
  const over = s.admit('R', p.unit);
  assert.equal(over.ok, false); assert.equal(over.reason, 'tracking_capacity_result'); assertNoMutation(s, bs, 'shared R over entries');
  // shared byte budget binds independently (one admission that would exceed p.shared * unit in bytes)
  const sb = F.createAccounting({ now: () => 0 });
  for (let i = 0; i < p.shared - 1; i++) assert.equal(sb.admit('R', p.unit).ok, true);
  const bsb = snapshot(sb);
  assert.equal(sb.admit('R', p.unit + 1).ok, false, 'the last shared entry may not exceed the shared byte budget'); assertNoMutation(sb, bsb, 'shared R over bytes');
  assert.equal(sb.admit('R', p.unit).ok, true, 'but a unit-sized frame still fits');
  // a job's reservation is honoured while the shared pool is full (reserved-vs-shared accounting)
  assert.equal(s.reserveJob('late').ok, false, 'sustained exhaustion: the shared pool just rejected and is still full');
  const s2 = F.createAccounting({ now: () => 0 });
  assert.equal(s2.reserveJob('j').ok, true);
  for (let i = 0; i < p.shared; i++) assert.equal(s2.admit('R', p.unit).ok, true);
  assert.equal(s2.admit('R', p.unit, { jobId: 'j' }).reserved, true, 'the reserved unit is admitted while shared is full');
  assert.equal(s2.status().inflight.R.entries, p.shared + 1);
  assert.ok(s2.check().ok);
  // releasing a shared entry restores shared capacity
  s2.release('R', p.unit, { reserved: false });
  assert.equal(s2.admit('R', p.unit).ok, true);
  assert.ok(s2.check().ok);
});

test('capacity invalid inputs: unknown class, non-finite or negative bytes, and releases of unknown classes mutate nothing', () => {
  const a = F.createAccounting();
  assert.equal(a.reserveJob('j').ok, true);
  const before = snapshot(a);
  assert.equal(a.admit('X', 1).ok, false);
  assert.equal(a.admit('O', NaN).ok, false);
  assert.equal(a.admit('O', -1).ok, false);
  assert.equal(a.admit('O', Infinity).ok, false);
  assert.equal(a.admit('T', NaN, { jobId: 'j' }).ok, false);
  assert.equal(a.release('X', 1), false);
  assertNoMutation(a, before, 'invalid inputs');
  assert.ok(a.check().ok);
});

// A second deterministic walk (seed 11) that also reserves and releases acts, so interaction
// admissions are exercised against their reservation promise; the seed-7 walk above is kept
// verbatim so its measured step-210 outcome stays observable against the original module.
test('C5 (acts): a 20000-step deterministic walk with job AND act reservations keeps every class within its entry/byte budget and the totals', () => {
  let t = 0;
  const acct = F.createAccounting({ now: () => t });
  const rng = (() => { let s = 11; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const live = []; const acts = []; let admitted = 0; let rejected = 0; let jobs = 0; let actN = 0; let iAdmitted = 0;
  for (let step = 0; step < 20000; step++) {
    t += 1;
    const r = rng();
    if (r < 0.1) { const id = `job${jobs}`; if (acct.reserveJob(id).ok) { jobs++; live.push({ job: id }); } }
    else if (r < 0.2) { const sid = `act${actN++}`; if (acct.reserveAct(sid)) acts.push(sid); }
    else if (r < 0.25 && acts.length) { const i = Math.floor(rng() * acts.length); acct.releaseAct(acts.splice(i, 1)[0]); }
    else if (r < 0.8) {
      const cls = ['O', 'O', 'R', 'L', 'T', 'I', 'I'][Math.floor(rng() * 7)];
      const bytes = cls === 'L' ? Math.floor(rng() * 1048576) : cls === 'I' ? Math.floor(rng() * 1064960) : Math.floor(rng() * 16384);
      const jobId = cls === 'T' || cls === 'R' ? (live.filter((x) => x.job)[Math.floor(rng() * Math.max(1, live.filter((x) => x.job).length))] || {}).job || null : null;
      const res = acct.admit(cls, bytes, { jobId, t });
      if (res.ok) { admitted++; if (cls === 'I') iAdmitted++; live.push({ cls: res.class, bytes, jobId, reserved: res.reserved }); } else rejected++;
    } else if (live.length) {
      const i = Math.floor(rng() * live.length); const [x] = live.splice(i, 1);
      if (x.job) acct.releaseJob(x.job); else acct.release(x.cls, x.bytes, { jobId: x.jobId, reserved: x.reserved });
    }
    const check = acct.check();
    assert.ok(check.ok, `step ${step}: inequality violated for ${check.violations.join(',')}`);
    const st = acct.status();
    for (const c of ['T', 'R', 'L', 'O', 'I']) assert.ok(st.inflight[c].entries <= F.POOLS[c].entries && st.inflight[c].bytes <= F.POOLS[c].bytes, `step ${step}: pool ${c} within bounds`);
    assert.ok(st.acts <= F.POOLS.I.concurrentActs, 'never more than 4 concurrent acts');
    assert.ok(check.totalEntries <= F.POOL_TOTALS.entries && check.totalBytes <= F.POOL_TOTALS.bytes);
  }
  assert.ok(admitted > 0 && rejected > 0 && iAdmitted > 0, `the walk must exercise admission, rejection and interaction admissions (I admitted ${iAdmitted})`);
});

test('frame caps: one encoded frame above its cap is refused by size, nothing silently truncated', () => {
  const big = 'x'.repeat(F.FRAME_CAPS.obs);
  const frame = { t: 'obs', epoch: 1, seq: 1, txn: crypto.randomUUID(), id: 'i', observation: obs('k', 'tr', 't', { big }) };
  assert.ok(F.frameBytes(frame) > F.FRAME_CAPS.obs);
  const small = { ...frame, observation: obs('k', 'tr', 't') };
  assert.ok(F.frameBytes(small) < F.FRAME_CAPS.obs);
});
