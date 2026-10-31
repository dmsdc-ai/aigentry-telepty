'use strict';

// Task 1215 F-A — non-destructive store publication, CANDIDATE SEAM. SIMULATION ONLY (not native Windows).
// Seam mapping (original -> candidate):
//   frozen windows-filesystem-contract-1215.test.js hooks the old writer on `renameSync(S -> L)` and gives
//   only that call win32 replacement semantics. The candidate never renames anything onto L: it CLAIMS L
//   with an exclusive `mkdirSync(L)` and then moves S's children into the claimed directory. The frozen
//   setup therefore no longer executes against the candidate (its SEAM assertions fail; it is NOT green).
//   Here the old writer acts immediately before the candidate's publication boundary (the claim), and
//   EVERY owner rename gets win32 replacement semantics (an existing non-directory target is replaced; a
//   directory target errors as before), so no replace-capable call can hide behind a different name.
//   The INVARIANT assertions are the frozen F-A assertions, unchanged in meaning.
// Assertion prefixes: SEAM (the injected condition happened), CONTROL, INVARIANT (the product contract).
// No product algorithm is reused as an oracle: expectations are bytes, names and owner state messages.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATING = 'tracked-injections.json.migrating.';
const ASIDE = 'tracked-injections.json.pre-0.10.';
const RECREATED = 'recreated-by-old-writer';

function setup(label, fn) {
  try { return fn(); } catch (error) { throw Object.assign(new Error(`SETUP ${label}: ${error && error.message}`), { cause: error }); }
}
function modules() {
  return setup('ledger closure', () => ({
    ...require('./fixtures/ledger-1207/owner-harness'),
    ...require('./fixtures/ledger-1207/legacy-fixture'),
  }));
}
function kindOf(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return st ? (st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other') : 'absent';
}
function names(dir) { return fs.readdirSync(dir).sort(); }
function treeWithoutLock(parent, shaTree) {
  const tree = shaTree(parent);
  for (const k of Object.keys(tree)) if (k.startsWith('tracked-injections.lock')) delete tree[k];
  return tree;
}

// Owner fs: real fs (prototype) + win32 replace-on-rename for every rename + descriptor tracking (so a
// "crash" can perform the OS release) + optional hooks at the claim and fill boundaries.
function win32OwnerFs(L, { beforeClaim = null, atFill = null, failFillOf = null } = {}) {
  const seam = { claimCalls: 0, claimOccupants: [], fillRenames: 0, replaced: [], replacedAtL: 0, replacedRecreatedBytes: 0, fillFaults: 0 };
  const open = new Set();
  const facade = Object.create(fs);
  facade.openSync = (...args) => { const fd = fs.openSync(...args); open.add(fd); return fd; };
  facade.closeSync = (fd, ...rest) => { try { return fs.closeSync(fd, ...rest); } finally { open.delete(fd); } };
  facade.mkdirSync = (p, ...rest) => {
    if (p === L) {
      seam.claimCalls++;
      if (beforeClaim && seam.claimCalls === 1) beforeClaim();
      seam.claimOccupants.push(kindOf(L));
    }
    return fs.mkdirSync(p, ...rest);
  };
  facade.renameSync = (from, to, ...rest) => {
    const into = String(to).startsWith(L + path.sep) && String(from).includes(MIGRATING);
    if (into) {
      seam.fillRenames++;
      if (atFill && seam.fillRenames === 1) atFill();
      if (failFillOf && path.basename(String(from)) === failFillOf && seam.fillFaults === 0) {
        seam.fillFaults++;
        throw Object.assign(new Error(`EIO: injected fault at renameSync(${from})`), { code: 'EIO' });
      }
    }
    const occupant = fs.lstatSync(to, { throwIfNoEntry: false });
    if (occupant && !occupant.isDirectory()) {            // win32 MoveFileExW(REPLACE_EXISTING) semantics
      if (fs.readFileSync(to, 'utf8') === RECREATED) seam.replacedRecreatedBytes++;
      if (to === L) seam.replacedAtL++;
      seam.replaced.push(path.basename(String(to)));
      fs.unlinkSync(to);
    }
    return fs.renameSync(from, to, ...rest);
  };
  const releaseAll = () => { for (const fd of [...open]) { try { fs.closeSync(fd); } catch { /* closed */ } open.delete(fd); } };
  return { fs: facade, seam, releaseAll };
}

test('F-A candidate seam (simulated win32): a legacy file recreated at the publication boundary is a conflict and its bytes survive', async (t) => {
  const { createOwnerHarness, writeLegacyLedger, tmpStore, sha256, shaTree } = modules();
  const s = setup('store', () => tmpStore('telepty-1215-pub-fa-'));
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const legacy = setup('legacy ledger', () => writeLegacyLedger(s.dir, { count: 4 }));
  let oldWriterRuns = 0;
  const win = win32OwnerFs(s.dir, { beforeClaim: () => { oldWriterRuns++; fs.writeFileSync(s.dir, RECREATED); } });
  let h = setup('owner', () => createOwnerHarness({ dir: s.dir, fsImpl: win.fs, platform: 'win32' }));
  t.after(() => { win.releaseAll(); h.release(); });
  const o = h.open();
  const parentNames = names(s.parent);
  t.diagnostic(`F-A candidate ${JSON.stringify({ state: o.state, reason: o.reason, detail: (o.stateMessage || {}).detail || null, oldWriterRuns, seam: win.seam,
    parent: parentNames.map((n) => n.replace(/[0-9a-f]{16,}/g, '<tok>')) })}`);
  // SEAM
  assert.equal(oldWriterRuns, 1, 'SEAM: the old-writer hook ran exactly once at the publication boundary');
  assert.equal(win.seam.claimCalls, 1, 'SEAM: the publication boundary was reached exactly once');
  assert.deepEqual(win.seam.claimOccupants, ['file'], 'SEAM: the boundary saw the old writer\'s FILE as occupant');
  // INVARIANT — conflict, never availability; every file retained (frozen F-A assertions).
  assert.notEqual(o.state, 'available', 'INVARIANT: the store must not become available over a recreated legacy file');
  assert.equal(o.reason, 'migration_conflict', 'INVARIANT: outcome is migration_conflict');
  assert.equal(o.stateMessage.detail, 'legacy_recreated', 'INVARIANT: detail is legacy_recreated');
  assert.equal(win.seam.replacedAtL, 0, 'INVARIANT: publication never replaced the old writer\'s file');
  assert.equal(win.seam.replacedRecreatedBytes, 0, 'INVARIANT: no rename anywhere replaced the old writer\'s bytes');
  const atL = fs.lstatSync(s.dir, { throwIfNoEntry: false });
  assert.ok(atL && atL.isFile() && fs.readFileSync(s.dir, 'utf8') === RECREATED, 'INVARIANT: the recreated bytes are retained at L');
  const aside = parentNames.find((n) => n.startsWith(ASIDE));
  assert.ok(aside, 'INVARIANT: the aside (captured legacy) is retained');
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, aside))), legacy.sha256, 'INVARIANT: the aside bytes equal the captured legacy ledger');
  const staging = parentNames.filter((n) => n.startsWith(MIGRATING));
  assert.equal(staging.length, 1, 'INVARIANT: the staging directory (migration evidence) is retained');
  assert.ok(fs.lstatSync(path.join(s.parent, staging[0])).isDirectory(), 'INVARIANT: the retained staging is a directory');
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, staging[0], 'legacy', 'tracked-injections.v3.json'))), legacy.sha256, 'INVARIANT: the staging legacy copy is retained');
  // the next open stays a conflict and changes nothing
  win.releaseAll(); h.release();
  const before = treeWithoutLock(s.parent, shaTree);
  h = createOwnerHarness({ dir: s.dir });
  const o2 = h.open();
  assert.equal(o2.reason, 'migration_conflict', 'INVARIANT: reopen stays a conflict');
  assert.equal(o2.stateMessage.detail, 'legacy_recreated', 'INVARIANT: reopen detail is legacy_recreated');
  assert.deepEqual(treeWithoutLock(s.parent, shaTree), before, 'INVARIANT: reopen retains every artifact byte-for-byte');
});

test('F-A candidate control (simulated win32): with no occupant at the boundary the same seam migrates normally and leaves no staging', async (t) => {
  const { createOwnerHarness, writeLegacyLedger, tmpStore, sha256 } = modules();
  const s = setup('store', () => tmpStore('telepty-1215-pub-ctl-'));
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const legacy = setup('legacy ledger', () => writeLegacyLedger(s.dir, { count: 4 }));
  const win = win32OwnerFs(s.dir);
  const h = setup('owner', () => createOwnerHarness({ dir: s.dir, fsImpl: win.fs, platform: 'win32' }));
  let closed = false;
  t.after(() => { if (!closed) win.releaseAll(); h.release(); });
  const o = h.open();
  t.diagnostic(`F-A candidate control ${JSON.stringify({ state: o.state, reason: o.reason, seam: win.seam })}`);
  assert.equal(win.seam.claimCalls, 1, 'SEAM: the publication boundary was reached exactly once');
  assert.deepEqual(win.seam.claimOccupants, ['absent'], 'SEAM: no occupant at publication');
  assert.equal(o.state, 'available', 'CONTROL: an unoccupied publication succeeds');
  assert.equal(o.reason, null, 'CONTROL: no failure reason');
  assert.ok(fs.lstatSync(s.dir).isDirectory(), 'CONTROL: L is the published directory store');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8')).published, true, 'CONTROL: MANIFEST is published');
  assert.equal(win.seam.replacedAtL, 0, 'CONTROL: nothing at L was replaced');
  assert.deepEqual(names(s.parent).filter((n) => n.startsWith(MIGRATING)), [], 'CONTROL: no staging directory remains');
  const aside = names(s.parent).find((n) => n.startsWith(ASIDE));
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, aside))), legacy.sha256, 'CONTROL: the aside is retained');
  assert.deepEqual(h.read('get', { id: legacy.ids[0] }).items[0], legacy.ledger.injections[legacy.ids[0]], 'CONTROL: a historical record reads back');
  await h.close(); closed = true;
});

test('F-A candidate: an old 0.9.1 writer acting after the claim cannot replace the claimed store and the migration completes', async (t) => {
  const { createOwnerHarness, writeLegacyLedger, tmpStore } = modules();
  const s = setup('store', () => tmpStore('telepty-1215-pub-after-'));
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const legacy = setup('legacy ledger', () => writeLegacyLedger(s.dir, { count: 3 }));
  const installed = setup('0.9.1 writer', () => require('./fixtures/0.9.1/src/session-store/persistence'));
  let saved = null; let kindAtWrite = null;
  const win = win32OwnerFs(s.dir, { atFill: () => { kindAtWrite = kindOf(s.dir); saved = installed.saveTrackedInjections(installed.emptyTrackedInjections(), s.dir); } });
  const h = setup('owner', () => createOwnerHarness({ dir: s.dir, fsImpl: win.fs, platform: 'win32' }));
  let closed = false;
  t.after(() => { if (!closed) win.releaseAll(); h.release(); });
  const o = h.open();
  t.diagnostic(`F-A after-claim ${JSON.stringify({ state: o.state, reason: o.reason, kindAtWrite, saved: saved && { ok: saved.ok, reason: saved.reason, code: saved.error && saved.error.code } })}`);
  assert.equal(kindAtWrite, 'directory', 'SEAM: the old writer ran while L was the claimed directory');
  assert.ok(saved && saved.ok === false, 'INVARIANT: the old writer could not write over the claimed store');
  assert.equal(o.state, 'available', 'INVARIANT: the claimed store is published');
  assert.equal(win.seam.replacedAtL, 0, 'INVARIANT: nothing at L was replaced');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8')).published, true, 'INVARIANT: MANIFEST is published');
  assert.equal(h.read('get', { id: legacy.ids[1] }).items.length, 1, 'INVARIANT: historical records are present');
  await h.close(); closed = true;
});

test('F-A candidate crash recovery: a fill interrupted after the claim resumes to the same published store', async (t) => {
  const { createOwnerHarness, writeLegacyLedger, tmpStore, sha256 } = modules();
  const s = setup('store', () => tmpStore('telepty-1215-pub-crash-'));
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const legacy = setup('legacy ledger', () => writeLegacyLedger(s.dir, { count: 5 }));
  const win = win32OwnerFs(s.dir, { failFillOf: 'hot' });
  let h = setup('owner', () => createOwnerHarness({ dir: s.dir, fsImpl: win.fs, platform: 'win32' }));
  const o1 = h.open();
  win.releaseAll(); h.release();                                   // crash: OS releases descriptors and the lock
  const staging = names(s.parent).filter((n) => n.startsWith(MIGRATING));
  assert.equal(win.seam.fillFaults, 1, 'SEAM: the fill was interrupted once');
  assert.equal(o1.state === 'available', false, 'SEAM: the interrupted open did not report availability');
  assert.ok(fs.lstatSync(s.dir).isDirectory() && !fs.existsSync(path.join(s.dir, 'MANIFEST.json')), 'SEAM: L is a claimed directory without MANIFEST');
  assert.equal(staging.length, 1, 'SEAM: one staging directory holds the rest');
  assert.ok(fs.existsSync(path.join(s.parent, staging[0], 'MANIFEST.json')), 'SEAM: the unpublished MANIFEST is still in staging');
  h = createOwnerHarness({ dir: s.dir });
  let closed = false;
  t.after(() => { if (!closed) h.release(); });
  const o2 = h.open();
  t.diagnostic(`F-A crash-resume ${JSON.stringify({ first: [o1.state, o1.reason], second: [o2.state, o2.reason, (o2.stateMessage || {}).detail || null] })}`);
  assert.equal(o2.state, 'available', `INVARIANT: the interrupted publication resumes: ${JSON.stringify(o2.stateMessage)}`);
  assert.equal(o2.stateMessage.counts.cold, legacy.count, 'INVARIANT: every legacy record is in the published store');
  assert.deepEqual(h.read('get', { id: legacy.ids[2] }).items[0], legacy.ledger.injections[legacy.ids[2]], 'INVARIANT: a historical record reads back exactly');
  assert.deepEqual(names(s.parent).filter((n) => n.startsWith(MIGRATING)), [], 'INVARIANT: the emptied staging directory is removed');
  const aside = names(s.parent).find((n) => n.startsWith(ASIDE));
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, aside))), legacy.sha256, 'INVARIANT: the aside is retained');
  await h.close(); h.release(); closed = true;
});

test('F-A candidate crash recovery: a claimed directory holding a foreign entry stays fail-closed with every artifact retained', async (t) => {
  const { createOwnerHarness, tmpStore, shaTree } = modules();
  const s = setup('store', () => tmpStore('telepty-1215-pub-foreign-'));
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const win = win32OwnerFs(s.dir, { failFillOf: 'legacy' });      // fresh store: interrupted at the first child
  let h = setup('owner', () => createOwnerHarness({ dir: s.dir, fsImpl: win.fs, platform: 'win32' }));
  h.open(); win.releaseAll(); h.release();
  assert.equal(win.seam.fillFaults, 1, 'SEAM: the fresh-store fill was interrupted');
  assert.deepEqual(names(s.dir), [], 'SEAM: L is an empty claimed directory');
  fs.writeFileSync(path.join(s.dir, 'foreign'), 'not-ours');
  const before = treeWithoutLock(s.parent, shaTree);
  h = createOwnerHarness({ dir: s.dir });
  t.after(() => h.release());
  const o = h.open();
  assert.notEqual(o.state, 'available', 'INVARIANT: an unrecognized claimed directory is not adopted');
  assert.equal(o.reason, 'manifest_unreadable', 'INVARIANT: the pre-existing fail-closed outcome is kept');
  assert.deepEqual(treeWithoutLock(s.parent, shaTree), before, 'INVARIANT: nothing was moved, removed or written');
});

test('F-A candidate crash recovery: a fresh store interrupted after the claim resumes', async (t) => {
  const { createOwnerHarness, tmpStore } = modules();
  const s = setup('store', () => tmpStore('telepty-1215-pub-fresh-'));
  t.after(() => fs.rmSync(s.home, { recursive: true, force: true }));
  const win = win32OwnerFs(s.dir, { failFillOf: 'legacy' });
  let h = setup('owner', () => createOwnerHarness({ dir: s.dir, fsImpl: win.fs, platform: 'win32' }));
  h.open(); win.releaseAll(); h.release();
  assert.equal(win.seam.fillFaults, 1, 'SEAM: the fresh-store fill was interrupted');
  h = createOwnerHarness({ dir: s.dir });
  let closed = false;
  t.after(() => { if (!closed) h.release(); });
  const o = h.open();
  assert.equal(o.state, 'available', `INVARIANT: the fresh publication resumes: ${JSON.stringify(o.stateMessage)}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'MANIFEST.json'), 'utf8')).published, true, 'INVARIANT: MANIFEST is published');
  assert.deepEqual(names(s.parent).filter((n) => n.startsWith(MIGRATING)), [], 'INVARIANT: no staging remains');
  await h.close(); h.release(); closed = true;
});
