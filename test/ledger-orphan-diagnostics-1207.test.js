'use strict';

// #1207 — ACCEPTANCE T4 orphan diagnostic: focused controls for the owner's
//   status.recovery.orphan_manifest_temps = { paths: string[], count: integer, truncated: boolean, scan_error: string|null }
// reached through the REAL client's ownerStatus() (one traversal per check) over the REAL owner Worker.
// `paths` are exact relative root filenames of REGULAR files shaped like the real manifest writer's
// temporaries — writeAtomic(): `${file}.${pid}.${Date.now()}.tmp`, i.e. `MANIFEST.json.<pid>.<ms>.tmp` —
// at most 32 in byte-order ascending; `count` is every matching regular name the same scan found;
// `truncated` ⇔ count > paths.length; `scan_error` is null only for a completed scan. The inventory is
// collected ONCE at the owner's recovery/open and cached for that recovery (not a live census). It is
// diagnostic retention: nothing is deleted or imported, and no other checkpoint member is enumerated.
//
// Author-written; NOT RUN here. On a product without the diagnostic every case is RED at the presence
// assertion by design (resume11 freeze); the product addition follows the independent RED.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./fixtures/ledger-1207/control-harness');
const { createLedgerClient } = require('../src/session-store/ledger-client');
const { sha256 } = require('./fixtures/ledger-1207/owner-harness');

const EVIDENCE = H.evidenceDir();
const LIMITS = Object.freeze({ maxListed: 32, planted: 40, closeMs: 2000 });
const TEMP_RE = /^MANIFEST\.json\.\d+\.\d+\.tmp$/;                 // the real writer's shape
const tempName = (i) => `MANIFEST.json.4242.${1700000000000 + i}.tmp`;   // deterministic, writer-shaped
const nowIso = () => new Date().toISOString();

async function openClient(store) {
  const client = createLedgerClient({ dir: store.dir, lockPath: store.lockPath, legacyPath: store.dir });
  const opened = await client.open({});
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return client;
}
function plant(store, name, content = `{"format":4,"planted":"${name}"}\n`) {
  const p = path.join(store.dir, name);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return sha256(fs.readFileSync(p));
}
function diagnosticOf(status) {
  return status && status.recovery && status.recovery.orphan_manifest_temps !== undefined ? status.recovery.orphan_manifest_temps : undefined;
}
// Externally visible shape; the first assertion is the one that is RED on a product without the diagnostic.
function assertDiagnosticShape(diag, label) {
  assert.ok(diag && typeof diag === 'object' && !Array.isArray(diag), `${label}: status.recovery.orphan_manifest_temps present (observed ${diag === undefined ? 'ABSENT — this product exposes no orphan listing' : JSON.stringify(diag)})`);
  assert.ok(Array.isArray(diag.paths) && diag.paths.every((p) => typeof p === 'string'), 'paths: string[]');
  assert.ok(Number.isInteger(diag.count) && diag.count >= diag.paths.length, `count: integer >= paths.length (${diag.count} vs ${diag.paths.length})`);
  assert.equal(typeof diag.truncated, 'boolean', 'truncated: boolean');
  assert.equal(diag.truncated, diag.count > diag.paths.length, 'truncated ⇔ count > paths.length');
  assert.ok(diag.scan_error === null || typeof diag.scan_error === 'string', 'scan_error: string|null');
  assert.ok(diag.paths.length <= LIMITS.maxListed, `at most ${LIMITS.maxListed} names listed`);
  for (const p of diag.paths) assert.ok(TEMP_RE.test(p) && !p.includes('/') && !p.includes(path.sep), `exact relative root filename of a writer-shaped temporary: ${p}`);
  assert.deepEqual(diag.paths, [...diag.paths].sort(), 'deterministic byte-order ascending');
}

async function withStore(name, fn) {
  const store = H.privateStore(`telepty-1207-orphan-${name}-`);
  const clients = [];
  const evidence = { case: name, started_at: nowIso(), node: process.version, limits: LIMITS, writer_pattern: String(TEMP_RE) };
  let failed = true;
  try {
    // a valid store first: one real open and a clean close, so fixtures are planted into a real store root
    const c0 = await openClient(store);
    evidence.initial_close = await H.closeBounded(c0, LIMITS.closeMs);
    assert.ok(fs.statSync(path.join(store.dir, 'MANIFEST.json')).isFile(), 'a published MANIFEST exists');
    await fn({ store, evidence, open: async () => { const c = await openClient(store); clients.push(c); return c; }, closeClient: (c) => H.closeBounded(c, LIMITS.closeMs) });
    failed = false;
  } finally {
    for (const c of clients) { try { await H.closeBounded(c, LIMITS.closeMs); } catch { /* already closed */ } }
    evidence.failed = failed; evidence.finished_at = nowIso();
    const file = H.writeEvidence(EVIDENCE, `orphan-${name}.json`, evidence);
    console.log(`[ledger-1207 orphan ${name}] evidence=${file}`);
    if (failed) console.log(`[ledger-1207 orphan ${name}] FAILED — private HOME preserved: ${store.home}`);
    else fs.rmSync(store.home, { recursive: true, force: true });
  }
}

test('orphan diagnostic 1: no matching temporary — a complete, empty inventory; the inventory is collected once per recovery (a temporary planted after the open is not in this recovery\'s inventory; a fresh open lists it)', () => withStore('none', async ({ store, evidence, open, closeClient }) => {
  const c1 = await open();
  const status1 = await c1.ownerStatus();
  const diag1 = diagnosticOf(status1);
  evidence.first = diag1 === undefined ? 'absent' : diag1;
  assertDiagnosticShape(diag1, 'fresh store');
  assert.deepEqual(diag1, { paths: [], count: 0, truncated: false, scan_error: null }, 'no matching temporary: empty, complete inventory');
  // cached per recovery: plant one after the open; the SAME recovery's inventory does not change
  const planted = tempName(1); plant(store, planted);
  const status2 = await c1.ownerStatus();
  evidence.after_plant_same_recovery = diagnosticOf(status2);
  assert.deepEqual(diagnosticOf(status2), diag1, 'the diagnostic is the inventory of THIS recovery, not a live directory census');
  assert.ok(fs.lstatSync(path.join(store.dir, planted)).isFile(), 'the planted temporary is untouched');
  // a fresh open (new recovery) inventories it
  await closeClient(c1);
  const c2 = await open();
  const diag3 = diagnosticOf(await c2.ownerStatus());
  evidence.fresh_open = diag3;
  assertDiagnosticShape(diag3, 'fresh open after planting');
  assert.deepEqual(diag3, { paths: [planted], count: 1, truncated: false, scan_error: null }, 'the next recovery lists exactly the planted temporary');
  assert.ok(fs.lstatSync(path.join(store.dir, planted)).isFile(), 'listed, never deleted');
}));

test('orphan diagnostic 2: more matching temporaries than the listing bound — paths are the first 32 in byte order, count is all 40, truncated is true, the scan is complete, and every temporary is preserved byte-for-byte', () => withStore('bounded', async ({ store, evidence, open }) => {
  const names = []; const shas = {};
  for (let i = 0; i < LIMITS.planted; i++) { const n = tempName(i); names.push(n); shas[n] = plant(store, n); }
  const sorted = [...names].sort();
  const client = await open();
  const diag = diagnosticOf(await client.ownerStatus());
  evidence.diagnostic = diag === undefined ? 'absent' : diag;
  assertDiagnosticShape(diag, '40 planted temporaries');
  assert.deepEqual(diag.paths, sorted.slice(0, LIMITS.maxListed), 'the first 32 names in byte order, exactly');
  assert.equal(diag.count, LIMITS.planted, 'count is every matching regular temporary the scan found');
  assert.equal(diag.truncated, true, 'count > paths.length');
  assert.equal(diag.scan_error, null, 'a complete scan — truncation is a listing bound, not a failure');
  for (const n of names) assert.equal(sha256(fs.readFileSync(path.join(store.dir, n))), shas[n], `preserved byte-for-byte: ${n}`);
  assert.ok(fs.statSync(path.join(store.dir, 'MANIFEST.json')).isFile(), 'the published MANIFEST is untouched');
}));

test('orphan diagnostic 3: lookalikes are excluded without being followed or read — wrong-shaped names, a directory and symlinks (one dangling) are not listed, not deleted, and do not fail the scan; exactly the one writer-shaped regular file is listed', () => withStore('lookalikes', async ({ store, evidence, open }) => {
  const real = tempName(7); const realSha = plant(store, real);
  const lookalikes = ['MANIFEST.json.tmp', 'MANIFEST.json..tmp', 'MANIFEST.json.4242.abc.tmp', 'MANIFEST.json.4242.1700000000001.tmp.bak', 'xMANIFEST.json.4242.1700000000002.tmp', 'manifest.json.4242.1700000000006.tmp'];
  const lookalikeShas = {}; for (const n of lookalikes) lookalikeShas[n] = plant(store, n, `lookalike ${n}\n`);
  const dirName = 'MANIFEST.json.4242.1700000000003.tmp'; fs.mkdirSync(path.join(store.dir, dirName), { mode: 0o700 });
  const dangling = 'MANIFEST.json.4242.1700000000004.tmp'; const linked = 'MANIFEST.json.4242.1700000000005.tmp';
  const target = path.join(store.dir, 'symlink-target.txt'); fs.writeFileSync(target, 'sentinel target — must not be listed or read\n', { mode: 0o600 });
  const symlinks = { dangling: null, linked: null };
  try { fs.symlinkSync(path.join(store.dir, 'missing-target.txt'), path.join(store.dir, dangling)); symlinks.dangling = true; } catch (error) { symlinks.dangling = `unsupported: ${error.code}`; }
  try { fs.symlinkSync(target, path.join(store.dir, linked)); symlinks.linked = true; } catch (error) { symlinks.linked = `unsupported: ${error.code}`; }
  evidence.symlinks = symlinks;
  const before = Object.fromEntries(fs.readdirSync(store.dir).sort().map((n) => [n, fs.lstatSync(path.join(store.dir, n)).isSymbolicLink() ? 'symlink' : fs.lstatSync(path.join(store.dir, n)).isDirectory() ? 'dir' : 'file']));
  const client = await open();
  const diag = diagnosticOf(await client.ownerStatus());
  evidence.diagnostic = diag === undefined ? 'absent' : diag;
  assertDiagnosticShape(diag, 'lookalikes planted');
  assert.deepEqual(diag.paths, [real], 'exactly the one writer-shaped regular file; no lookalike, directory or symlink');
  assert.equal(diag.count, 1); assert.equal(diag.truncated, false);
  assert.equal(diag.scan_error, null, 'a dangling symlink in the root does not fail the scan — entries are classified by lstat, never followed');
  // nothing deleted, nothing rewritten
  const after = Object.fromEntries(fs.readdirSync(store.dir).sort().map((n) => [n, fs.lstatSync(path.join(store.dir, n)).isSymbolicLink() ? 'symlink' : fs.lstatSync(path.join(store.dir, n)).isDirectory() ? 'dir' : 'file']));
  assert.deepEqual(after, before, 'the store root has the same entries and types after the scan');
  assert.equal(sha256(fs.readFileSync(path.join(store.dir, real))), realSha);
  for (const n of lookalikes) assert.equal(sha256(fs.readFileSync(path.join(store.dir, n))), lookalikeShas[n], `lookalike untouched: ${n}`);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel target — must not be listed or read\n', 'symlink target untouched');
  evidence.limits = { ...LIMITS, note: 'a read of a non-dangling symlink target is not observable from outside; the dangling symlink is the positive witness that entries are not followed' };
}));
