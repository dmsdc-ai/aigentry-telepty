'use strict';

// Task 1215 F-B — root membership change under stable root metadata, CANDIDATE SEAM. SIMULATION ONLY.
// Seam mapping (original -> candidate): the frozen windows-filesystem-contract-1215.test.js pins root lstat
// and mutates the root when the FIRST root enumeration closes, asserting lstat/enumeration counts. Here the
// root lstat is pinned the same way, but the mutation is performed at a later point that is still inside the
// observed scan — the first lstat of an observed session directory — and nothing depends on how many times
// the product enumerates or stats the root. The INVARIANT assertions are the frozen F-B assertions.
// Contract limit (unchanged): detection inside THIS observed scan window only; no atomic snapshot and no
// claim to detect an add+remove (ABA) completed outside the observed window.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setup(label, fn) {
  try { return fn(); } catch (error) { throw Object.assign(new Error(`SETUP ${label}: ${error && error.message}`), { cause: error }); }
}
function ownedRoot(t) {
  const root = setup('root', () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-membership-1215-'))));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function namesIn(dir) { return fs.readdirSync(dir).sort(); }
// Serial, restored mock scope (t.mock restores at test end). Every root lstat returns ONE captured
// fingerprint; every other path is real. `mutate` runs once, at the first lstat of root/<at>.
function instrument(t, root, { at = 's', mutate = null } = {}) {
  const realLstat = fs.lstatSync;
  const pinned = realLstat.call(fs, root);
  const seam = { rootPinned: true, mutated: false };
  const target = path.join(root, at);
  t.mock.method(fs, 'lstatSync', function lstatSync(file, ...rest) {
    if (file === root) return pinned;
    if (mutate && !seam.mutated && file === target) { seam.mutated = true; mutate(); }
    return realLstat.call(fs, file, ...rest);
  });
  seam.pinnedStillEqualsReal = () => { const now = realLstat.call(fs, root); return ['dev', 'ino', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].every((k) => now[k] === pinned[k]); };
  return seam;
}
function inspect() {
  return setup('compat closure', () => require('../src/mailbox/compatibility')).inspectMailboxCompatibility;
}

for (const variant of [
  { name: 'a root directory added', initial: ['s'], mutate: (root) => fs.mkdirSync(path.join(root, 'concurrent')), after: ['concurrent', 's'] },
  { name: 'an observed root directory removed', initial: ['gone', 's'], mutate: (root) => fs.rmdirSync(path.join(root, 'gone')), after: ['s'] },
  { name: 'an observed root directory renamed (same count)', initial: ['a', 's'], mutate: (root) => fs.renameSync(path.join(root, 'a'), path.join(root, 'b')), after: ['b', 's'] },
]) {
  test(`F-B candidate seam (simulated stable metadata): ${variant.name} during the observed scan yields a partial observation`, (t) => {
    const inspectMailboxCompatibility = inspect();
    const root = ownedRoot(t); for (const n of variant.initial) fs.mkdirSync(path.join(root, n));
    const before = namesIn(root);
    const seam = instrument(t, root, { at: 's', mutate: () => variant.mutate(root) });
    const report = inspectMailboxCompatibility(root);
    const after = namesIn(root);
    t.diagnostic(`F-B candidate ${JSON.stringify({ variant: variant.name, mutated: seam.mutated, before, after, listed: report.sessions.map((r) => r.session_id), complete: report.complete, reason: report.reason || null })}`);
    assert.equal(seam.mutated, true, 'SEAM: the root membership changed inside the observed scan');
    assert.deepEqual([before, after], [variant.initial, variant.after], 'SEAM: root membership really changed');
    assert.deepEqual(report.sessions.map((r) => r.session_id), variant.initial, 'SEAM: the observed enumeration preceded the change');
    assert.equal(report.complete, false, 'INVARIANT: a membership change during the scan is a partial observation');
    assert.equal(report.reason, 'changed_during_inspection', 'INVARIANT: reason is changed_during_inspection');
    assert.equal(report.migration_permitted, false, 'INVARIANT: never permits migration');
    assert.equal(report.mutated, false, 'INVARIANT: the inspection reports no mutation of its own');
  });
}

test('F-B candidate control: an unchanged root under pinned metadata stays a complete observation', (t) => {
  const inspectMailboxCompatibility = inspect();
  const root = ownedRoot(t); for (const n of ['a', 's']) fs.mkdirSync(path.join(root, n));
  const before = namesIn(root);
  const seam = instrument(t, root);
  const report = inspectMailboxCompatibility(root);
  assert.equal(seam.mutated, false, 'SEAM: no mutation');
  assert.ok(seam.pinnedStillEqualsReal(), 'SEAM: the real root metadata did not move either');
  assert.deepEqual(namesIn(root), before, 'SEAM: membership unchanged');
  assert.equal(report.complete, true, 'CONTROL: an unchanged root is complete');
  assert.equal(report.reason, undefined, 'CONTROL: no partial reason');
  assert.equal(report.migration_permitted, false, 'CONTROL: still never permits migration');
});

test('F-B candidate control: a scan that uses the whole entry budget is still complete and an over-budget root is entry_budget', (t) => {
  const inspectMailboxCompatibility = inspect();
  const root = ownedRoot(t); for (const n of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, n));
  instrument(t, root);
  const exact = inspectMailboxCompatibility(root, { entryBudget: 3 });
  assert.equal(exact.complete, true, 'CONTROL: re-enumeration does not consume the observed-scan budget');
  const over = inspectMailboxCompatibility(root, { entryBudget: 2 });
  assert.equal(over.complete, false, 'CONTROL: bounded scan is partial');
  assert.equal(over.reason, 'entry_budget', 'CONTROL: reason is entry_budget');
  assert.equal(over.migration_permitted, false, 'CONTROL: never permits migration');
});
