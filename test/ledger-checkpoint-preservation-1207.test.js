'use strict';

// #1207 — checkpoint artifact preservation through recovery and the NEXT close (resume13, tester-authored,
// test only; no product change). Reproduction lead from resume11: after a torn-MANIFEST checkpoint (rename
// EIO at the MANIFEST temporary) and a reopen that recovers from the PREVIOUS MANIFEST, the reopened owner's
// next successful checkpoint/close reused the orphaned checkpoint number and rewrote hot/2.jsonl and
// hot/2.receipts.jsonl AFTER the in-test preservation assertion had passed.
//
// Contract lines applied (INPUT/contract):
//   revision1/CUTOVER.md l.33  crash at any boundary: "MANIFEST is always the last fully renamed one"
//   revision1/CUTOVER.md l.34  EIO on rename: "previous MANIFEST stays valid; nothing truncated"
//   revision1/CUTOVER.md l.36  crash mid-compaction: "new files referenced only by the next MANIFEST; abandoned
//                              files are **listed** in status, never deleted automatically"
//   revision2/CODER-HANDOFF.md l.10  "segments are never truncated or rewritten; cold files immutable; nothing deleted"
//   revision1/ACCEPTANCE.json T4     "orphan tmp listed (not deleted)"
// Mutability classes are distinguished, never equated: MANIFEST.json is intentionally mutable (rename-replaced
// by every checkpoint/close); segments are append-only history (size never shrinks, old bytes stay a prefix);
// cold files are immutable (written 0400); hot snapshot / receipts / facts checkpoint members are NUMBERED
// artifacts — the controller disposition under test is that UNPUBLISHED instances (written by a checkpoint
// whose MANIFEST never published) must not be silently overwritten or reused by recovery or by the next
// successful checkpoint/close. Ordinary MANIFEST changes and genuinely new files are named, not counted.
//
// Source-derived explanation (owner af77332a…, read not changed — compared against, not asserted):
//   loadCheckpoint(): S.checkpointN = manifest.hot.n (the previous PUBLISHED number);
//   checkpoint():     n = S.checkpointN + 1 — the number the failed checkpoint already used — and
//                     writeFileDurable() opens hot/<n>.jsonl, hot/<n>.receipts.jsonl, facts/<n>.jsonl,
//                     facts/<n>.sid.idx with 'w'; demotion: coldN = max(S.cold.n)+1 from the recovered list,
//                     i.e. the orphaned cold number again, but cold files are 0400 so a reused name is
//                     expected to FAIL rather than be rewritten;
//   close():          checkpoint('close') then writeManifest({clean_close:true}); a thrown checkpoint error is
//                     posted as a `progress` message carrying an `error` field and `closed.clean` is false;
//                     a SUCCESSFUL checkpoint also posts an informational `progress` {phase:'compact', done,
//                     total, demoted, reason} with NO error field (l.867) — retained as a message, not an error.
// Three things are kept apart in the verdict: (1) physical overwrite/loss of unpublished artifacts,
// (2) whether the close reported clean, (3) whether a fresh reopen still serves the record (replay). A
// failed (1) is NOT a data-loss claim when (3) holds.
//
// Phases (full lstat inventory {path → type, bytes, sha256, mode} + MANIFEST references at each):
//   P0 baseline · P1 failed checkpoint (armed EIO at the MANIFEST tmp→rename) · P2 later work ·
//   P3 release without close ("crash") · P4 reopen · P5 EXPLICIT close of the reopened owner ·
//   P6 fresh reopen · P7 final close. Stores are KEPT (never removed) for inspection.
// Setup that does not reach the torn-MANIFEST condition or a successful reopen fails with a
// NOT_MEASURED-prefixed assertion; nothing is edited or retried.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const persistence = require('../src/session-store/persistence');
const H = require('./fixtures/ledger-1207/control-harness');
const { createOwnerHarness, tmpStore, sha256, segmentFiles } = require('./fixtures/ledger-1207/owner-harness');
const { createFaultFs } = require('./fixtures/ledger-1207/fault-fs');

const EVIDENCE = H.evidenceDir();
const nowIso = () => new Date().toISOString();
const isManifestTmp = (p) => typeof p === 'string' && path.basename(p).startsWith('MANIFEST.json.') && p.endsWith('.tmp');

function beginRecord(id, sid) {
  const record = { inject_id: id, session_id: sid, session_epoch: null, session_epoch_reason: 'no_815_epoch_fact', transport_source: 'orch', created_at: nowIso(), observation_seq: 0, observations: [], last_observation: null, capability: { stage: 'A' }, tracking_state: 'tracked' };
  persistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, nowIso());
  return record;
}

// lstat inventory of the store root: relative path -> { type, bytes, sha256, mode, target }; links never followed.
function inventory(root) {
  const out = {};
  (function walk(d, rel) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name; const p = path.join(d, e.name); const st = fs.lstatSync(p); const mode = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) out[r] = { type: 'symlink', target: fs.readlinkSync(p), mode };
      else if (st.isDirectory()) { out[r] = { type: 'dir', mode }; walk(p, r); }
      else if (st.isFile()) { const b = fs.readFileSync(p); out[r] = { type: 'file', bytes: b.length, sha256: sha256(b), mode }; }
      else out[r] = { type: 'other', mode };
    }
  })(root, '');
  return out;
}
function manifestRefs(dir) {
  const file = path.join(dir, 'MANIFEST.json');
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { epoch: m.epoch, seq_committed: m.seq_committed, hot: m.hot, receipts: m.receipts, cold: (m.cold || []).map((c) => c.n), facts: m.facts, segments: (m.segments || []).map((s) => s.name), last_checkpoint: m.last_checkpoint || null, clean_close: m.clean_close, orphan_manifest_temps: m.recovery && m.recovery.orphan_manifest_temps !== undefined ? m.recovery.orphan_manifest_temps : 'absent' };
}
// Classify the P1 unpublished set against a later inventory.
function classify(unpublished, before, after) {
  const r = { preserved: [], rewritten: [], type_changed: [], disappeared: [] };
  for (const rel of unpublished) {
    const a = before[rel]; const b = after[rel];
    if (!b) { r.disappeared.push({ path: rel, before: a }); continue; }
    if (b.type !== a.type) { r.type_changed.push({ path: rel, before: a, after: b }); continue; }
    if (a.type === 'file' && (a.sha256 !== b.sha256 || a.bytes !== b.bytes)) { r.rewritten.push({ path: rel, before: { bytes: a.bytes, sha256: a.sha256, mode: a.mode }, after: { bytes: b.bytes, sha256: b.sha256, mode: b.mode } }); continue; }
    r.preserved.push(rel);
  }
  return r;
}
// Ordinary (non-violation) changes, named so they are not mislabeled: MANIFEST replacement, new files, and the
// append-only check on segments (size never shrinks, the earlier bytes remain a prefix).
function ordinaryChanges(before, after, dir, segPrefix) {
  const newFiles = Object.keys(after).filter((r) => !(r in before) && after[r].type !== 'dir');
  const manifestChanged = !!(before['MANIFEST.json'] && after['MANIFEST.json'] && before['MANIFEST.json'].sha256 !== after['MANIFEST.json'].sha256);
  const segments = {};
  for (const [rel, prev] of Object.entries(segPrefix)) {
    const p = path.join(dir, rel); const exists = fs.existsSync(p);
    const now = exists ? fs.readFileSync(p) : null;
    segments[rel] = { exists, bytes_before: prev.length, bytes_after: now ? now.length : null, append_only: !!(now && now.length >= prev.length && now.subarray(0, prev.length).equals(prev)) };
  }
  const coldModes = Object.entries(after).filter(([r, v]) => r.startsWith('cold/') && v.type === 'file').map(([r, v]) => ({ path: r, mode: v.mode }));
  return { new_files: newFiles, manifest_changed: manifestChanged, segments, cold_modes: coldModes };
}
const kinds = (rec) => (rec && rec.items && rec.items.length ? rec.items[0].observations.map((o) => o.kind) : null);

for (const variant of [{ name: 'hot-record-stays-hot', live: true }, { name: 'record-demoted-in-failed-checkpoint', live: false }]) {
  test(`checkpoint preservation [${variant.name}]: after a torn-MANIFEST checkpoint (rename EIO, hook witnessed) and recovery from the previous MANIFEST, the UNPUBLISHED checkpoint artifacts (hot snapshot, receipts, facts${variant.live ? '' : ', cold file'}, orphan MANIFEST temporary) keep path, type and bytes through the reopened owner's NEXT close; that close reports clean; a fresh reopen still serves the record`, async () => {
    const s = tmpStore('telepty-1207-ckpt-');
    const ev = { case: 'checkpoint-preservation', variant: variant.name, live_session: variant.live, store_dir: s.dir, started_at: nowIso(), node: process.version, reached: [], phases: {} };
    const save = () => H.writeEvidence(EVIDENCE, `ckpt-${variant.name}.json`, ev);
    const phase = (name, extra = {}) => { const p = { at: nowIso(), manifest: manifestRefs(s.dir), inventory: inventory(s.dir), ...extra }; ev.phases[name] = p; ev.reached.push(name); return p; };
    const notMeasured = (why, detail) => { ev.not_measured = { why, detail }; save(); assert.fail(`NOT_MEASURED (setup): ${why}: ${JSON.stringify(detail)}`); };
    let h = null;
    try {
      // P0 — baseline: open, (live session), begin A, one acked observation
      let armed = false;
      const faultFs = createFaultFs({ faults: { renameSync: { code: 'EIO', times: 1, when: (args) => armed && isManifestTmp(String(args[0])) && String(args[1]).endsWith('MANIFEST.json') } } });
      h = createOwnerHarness({ dir: s.dir, fsImpl: faultFs });
      const opened = h.open();
      if (opened.state !== 'available') notMeasured('first open not available', opened.stateMessage);
      if (variant.live) h.live('w', true);
      const begin = await h.submit('begin', { id: 'A', sid: 'w', record: beginRecord('A', 'w'), at: nowIso() }, { cls: 'T' });
      const obs1 = await h.submit('obs', { id: 'A', observation: { kind: 'output_observed', trigger: 'o1', at: nowIso() } });
      const P0 = phase('P0_baseline', { begin: begin.type, obs1: obs1.type });
      if (begin.type !== 'ack' || obs1.type !== 'ack') notMeasured('baseline not acked', { begin: begin.type, obs1: obs1.type });
      // P1 — the torn checkpoint: artifacts + MANIFEST temporary written, the rename throws EIO exactly once
      armed = true; const compact = h.read('compact'); armed = false;
      const fired = faultFs._state.fired.filter((f) => f.name === 'renameSync');
      const P1 = phase('P1_failed_checkpoint', { compact: { items: compact.items.length, reason: compact.reason }, fault_fired: fired });
      P1.manifest_unchanged = P1.inventory['MANIFEST.json'].sha256 === P0.inventory['MANIFEST.json'].sha256;
      P1.unpublished = Object.keys(P1.inventory).filter((r) => !(r in P0.inventory) && P1.inventory[r].type !== 'dir');
      P1.existing_changed = Object.keys(P0.inventory).filter((r) => P0.inventory[r].type === 'file' && P1.inventory[r] && P1.inventory[r].sha256 !== P0.inventory[r].sha256);
      const segPrefix = Object.fromEntries(segmentFiles(s.dir).map((f) => [`segments/${path.basename(f)}`, fs.readFileSync(f)]));
      const orphanTmps = P1.unpublished.filter(isManifestTmp);
      if (!/^compact_failed:EIO/.test(String(compact.reason)) || fired.length !== 1 || !isManifestTmp(fired[0].path) || !P1.manifest_unchanged || orphanTmps.length !== 1) notMeasured('torn-MANIFEST condition not reached', { reason: compact.reason, fired, manifest_unchanged: P1.manifest_unchanged, orphanTmps });
      P1.orphan_manifest_temp = orphanTmps[0];
      const orphan = JSON.parse(fs.readFileSync(path.join(s.dir, orphanTmps[0]), 'utf8'));
      P1.orphan_references = { hot_n: orphan.hot && orphan.hot.n, last_checkpoint: orphan.last_checkpoint || null, cold: (orphan.cold || []).map((c) => c.n) };
      // P2 — later work (same expectations as T4; recorded, not the subject)
      const later = await h.submit('obs', { id: 'A', observation: { kind: 'busy_indicator_pattern_observed', trigger: 'o2', at: nowIso() } });
      phase('P2_later_work', { obs2: { type: later.type, reason: later.reason || null }, expected: variant.live ? 'ack' : 'nack record_cold' });
      // P3 — "crash": release the lock without close
      h.release(); h = null;
      phase('P3_released_without_close');
      // P4 — reopen with a real fs owner: recovery from the previous MANIFEST
      h = createOwnerHarness({ dir: s.dir });
      const re = h.open();
      if (variant.live) h.live('w', true);           // the variant keeps its tracked record hot at the next checkpoint too
      const rec4 = h.read('get', { id: 'A' }); const st4 = h.read('status').items[0] || null;
      const P4 = phase('P4_reopened', { open: { state: re.state, reason: re.reason }, live_set_after_reopen: variant.live, record: rec4.items.length ? { observations: kinds(rec4), tracking_state: rec4.items[0].tracking_state, observation_seq: rec4.items[0].observation_seq } : null, status: st4 ? { checkpoint: st4.checkpoint, counts: st4.counts, epoch: st4.epoch, orphan_manifest_temps: st4.recovery ? st4.recovery.orphan_manifest_temps : 'absent' } : null });
      P4.classification = classify(P1.unpublished, P1.inventory, P4.inventory); P4.ordinary = ordinaryChanges(P1.inventory, P4.inventory, s.dir, segPrefix);
      if (re.state !== 'available') notMeasured('reopen not available', re.stateMessage);
      // P5 — the measurement: EXPLICIT close of the reopened owner (checkpoint('close') + clean MANIFEST), then inventory
      const progressBefore = h.ofType('progress').length;
      const closed5 = await h.close();
      const progressMessages5 = h.ofType('progress').slice(progressBefore).map(({ _seq, _hr_ns, ...m }) => m);   // every raw progress message in the close window
      const progress5 = progressMessages5.filter((m) => m.error !== undefined && m.error !== null);              // only error-bearing progress counts against a clean close
      h.release(); h = null;
      const P5 = phase('P5_closed_after_recovery', { closed: { clean: closed5.clean, unresolved: closed5.unresolved }, progress_messages: progressMessages5, progress_errors: progress5 });
      P5.classification = classify(P1.unpublished, P1.inventory, P5.inventory); P5.ordinary = ordinaryChanges(P1.inventory, P5.inventory, s.dir, segPrefix);
      // P6 — fresh reopen: user-visible record via the existing `get` read, status counts/checkpoint
      h = createOwnerHarness({ dir: s.dir });
      const re6 = h.open();
      const rec6 = h.read('get', { id: 'A' }); const st6 = h.read('status').items[0] || null;
      const P6 = phase('P6_fresh_reopen', { open: { state: re6.state, reason: re6.reason }, record: rec6.items.length ? { observations: kinds(rec6), tracking_state: rec6.items[0].tracking_state, observation_seq: rec6.items[0].observation_seq } : null, status: st6 ? { checkpoint: st6.checkpoint, counts: st6.counts, epoch: st6.epoch, orphan_manifest_temps: st6.recovery ? st6.recovery.orphan_manifest_temps : 'absent' } : null });
      P6.classification = classify(P1.unpublished, P1.inventory, P6.inventory);
      // P7 — final close + inventory
      const progressBefore7 = h.ofType('progress').length;
      const closed7 = await h.close();
      const progressMessages7 = h.ofType('progress').slice(progressBefore7).map(({ _seq, _hr_ns, ...m }) => m);
      const progress7 = progressMessages7.filter((m) => m.error !== undefined && m.error !== null);
      h.release(); h = null;
      const P7 = phase('P7_final_close', { closed: { clean: closed7.clean, unresolved: closed7.unresolved }, progress_messages: progressMessages7, progress_errors: progress7 });
      P7.classification = classify(P1.unpublished, P1.inventory, P7.inventory); P7.ordinary = ordinaryChanges(P1.inventory, P7.inventory, s.dir, segPrefix);
      // Verdict — one structured assertion so every verdict is visible in a failure
      const expectedKinds = variant.live ? ['tracking_started', 'output_observed', 'busy_indicator_pattern_observed'] : ['tracking_started', 'output_observed'];
      const verdict = {
        unpublished_preserved_through_close: P5.classification.rewritten.length === 0 && P5.classification.type_changed.length === 0 && P5.classification.disappeared.length === 0,
        close_reported_clean: closed5.clean === true && progress5.length === 0,   // progress5 = error-bearing progress only (TD1 correction)
        record_retained_after_fresh_reopen: re6.state === 'available' && !!P6.record && JSON.stringify(P6.record.observations) === JSON.stringify(expectedKinds),
      };
      ev.verdict = verdict; ev.expected_record_kinds = expectedKinds;
      ev.explanation = { source_derived: 'loadCheckpoint sets S.checkpointN = previous published hot.n; checkpoint() reuses n = checkpointN + 1 (the orphaned number) and writeFileDurable opens with w; cold uses max(recovered cold n)+1 but cold files are 0400', physical_overwrite_at_close: P5.classification.rewritten.map((r) => r.path), type_changed_at_close: P5.classification.type_changed.map((r) => r.path), disappeared_at_close: P5.classification.disappeared.map((r) => r.path), record_loss: verdict.record_retained_after_fresh_reopen ? 'none measured (replay serves the record)' : 'record NOT served as expected after the fresh reopen — see P6' };
      ev.finished_at = nowIso();
      const file = save();
      console.log(`[ledger-1207 ckpt ${variant.name}] ${file} verdict=${JSON.stringify(verdict)} rewritten_at_close=${JSON.stringify(P5.classification.rewritten.map((r) => r.path))} close=${JSON.stringify(P5.closed)} progress_errors=${JSON.stringify(progress5)} progress_messages=${JSON.stringify(progressMessages5)}`);
      assert.deepEqual(verdict, { unpublished_preserved_through_close: true, close_reported_clean: true, record_retained_after_fresh_reopen: true }, `checkpoint preservation [${variant.name}]: ${JSON.stringify({ unpublished: P1.unpublished, at_close: { rewritten: P5.classification.rewritten, type_changed: P5.classification.type_changed, disappeared: P5.classification.disappeared, preserved: P5.classification.preserved }, close: P5.closed, progress_errors: progress5, manifest_after_close: P5.manifest, fresh_reopen: { state: re6.state, record: P6.record } })}`);
    } finally {
      if (h) { try { await h.close(); } catch { /* best effort */ } try { h.release(); } catch { /* best effort */ } }
      ev.finished_at = ev.finished_at || nowIso(); ev.store_kept = s.home;
      save();
      console.log(`[ledger-1207 ckpt ${variant.name}] store kept for inspection: ${s.home}`);
    }
  });
}
