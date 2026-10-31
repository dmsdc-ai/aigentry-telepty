'use strict';

// Task 1215 — the REAL authority-file reader on the REAL platform (process.platform is never
// overridden and no `platform` option is passed). Darwin: the bundled native openat/fstat reader
// (src/principal/native/authority-darwin.c) MUST be present and load — its absence FAILS this test,
// it never skips — and it must accept a normal private file and refuse symlink, nonregular,
// permissive, hard-linked, oversized and unsafe-parent/replaced-parent paths. Linux: the
// descriptor-relative /proc reader keeps the same matrix. Threat model: integrity against OTHER uids;
// same-uid access is not isolation and is not claimed. Not expressible here without root or native
// instrumentation (pending the independent builder): foreign/root ownership fixtures, extended-ACL
// fixtures, and a rename landing between two openat calls inside one native read.
// "PRECONDITION:" assertions validate setup (failure = INVALID, not product RED).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAuthorityFile } = require('../src/principal/authority-file');
const { loadPrincipalTrust } = require('../src/principal/http');
const { loadPrincipalClientConfiguration } = require('../src/principal/client');

const PAYLOAD = '{"fixture":"telepty-1215"}\n';
function privateDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-authority-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  return dir;
}
function cases(dir) {
  const parent = path.join(dir, 'parent');
  fs.mkdirSync(parent, { mode: 0o700 });
  const normal = path.join(parent, 'key.json');
  fs.writeFileSync(normal, PAYLOAD, { mode: 0o600 });
  const permissive = path.join(parent, 'permissive.json');
  fs.writeFileSync(permissive, PAYLOAD, { mode: 0o644 });
  const linkLeaf = path.join(parent, 'link.json');
  fs.symlinkSync(normal, linkLeaf);
  const nonregular = path.join(parent, 'not-a-file');
  fs.mkdirSync(nonregular, { mode: 0o700 });
  const hard = path.join(parent, 'hard.json');
  fs.writeFileSync(hard, PAYLOAD, { mode: 0o600 });
  fs.linkSync(hard, path.join(parent, 'hard-second-name.json'));
  const loose = path.join(dir, 'loose');
  fs.mkdirSync(loose, { mode: 0o700 });
  fs.chmodSync(loose, 0o770);                                         // group-writable parent
  const looseFile = path.join(loose, 'key.json');
  fs.writeFileSync(looseFile, PAYLOAD, { mode: 0o600 });
  const symParentReal = path.join(dir, 'real-parent');
  fs.mkdirSync(symParentReal, { mode: 0o700 });
  fs.writeFileSync(path.join(symParentReal, 'key.json'), PAYLOAD, { mode: 0o600 });
  const symParent = path.join(dir, 'sym-parent');
  fs.symlinkSync(symParentReal, symParent);
  return { parent, normal, permissive, linkLeaf, nonregular, hard, looseFile, symParentFile: path.join(symParent, 'key.json') };
}
function outcome(file, options = {}) {
  try { return { ok: true, bytes: readAuthorityFile(file, { privateFile: true, ...options }).toString() }; }
  catch (e) { return { ok: false, code: e.code || null, reason: e.reason || null }; }
}

test('Darwin: the bundled native reader loads, returns a normal private file and refuses unsafe shapes', { skip: process.platform !== 'darwin' }, t => {
  const dir = privateDir(t);
  const c = cases(dir);
  assert.equal(fs.readFileSync(c.normal, 'utf8'), PAYLOAD, 'PRECONDITION: normal private fixture readable by its owner');
  const observed = {};
  for (const name of ['normal', 'permissive', 'linkLeaf', 'nonregular', 'hard', 'looseFile', 'symParentFile']) observed[name] = outcome(c[name]);
  observed.permissiveNotPrivate = outcome(c.permissive, { privateFile: false });
  observed.exactMaximum = outcome(c.normal, { maximum: Buffer.byteLength(PAYLOAD) });
  observed.oversized = outcome(c.normal, { maximum: Buffer.byteLength(PAYLOAD) - 1 });
  observed.relative = outcome('relative/key.json');
  observed.embeddedNul = outcome(`${c.normal}\0suffix`);
  // Controlled replacement: the parent path becomes a symlink to a directory holding other bytes.
  fs.renameSync(c.parent, `${c.parent}-moved`);
  const decoy = path.join(dir, 'decoy');
  fs.mkdirSync(decoy, { mode: 0o700 });
  fs.writeFileSync(path.join(decoy, 'key.json'), '{"decoy":true}\n', { mode: 0o600 });
  fs.symlinkSync(decoy, c.parent);
  observed.parentReplacedBySymlink = outcome(c.normal);
  const refused = reason => ({ ok: false, code: 'AUTHORITY_FILE_UNAVAILABLE', reason });
  const strip = o => (o.ok ? o : { ok: o.ok, code: o.code, reason: o.reason });
  for (const key of Object.keys(observed)) observed[key] = strip(observed[key]);
  assert.deepEqual(observed, {
    normal: { ok: true, bytes: PAYLOAD }, permissive: refused('leaf_unsafe'), linkLeaf: refused('leaf_open'),
    nonregular: refused('leaf_unsafe'), hard: refused('leaf_unsafe'), looseFile: refused('component_unsafe'),
    symParentFile: refused('component_open'), permissiveNotPrivate: { ok: true, bytes: PAYLOAD },
    exactMaximum: { ok: true, bytes: PAYLOAD }, oversized: refused('size'), relative: refused('path_shape'),
    embeddedNul: refused('path_shape'), parentReplacedBySymlink: refused('component_open'),
  }, `native reader result (a 'darwin_native_reader_unavailable' reason means the bundled binary is absent): ${JSON.stringify(observed)}`);
});

test('Darwin: the real strict trust/client loaders read through the native reader', { skip: process.platform !== 'darwin' }, t => {
  const dir = privateDir(t);
  const trustFile = path.join(dir, 'trust.json');
  fs.writeFileSync(trustFile, '{"schema":"telepty.principals/v1","keys":[]}\n', { mode: 0o600 });
  let trust = null;
  try { loadPrincipalTrust(trustFile, { audience: 'telepty-1215-fixture' }); } catch (e) { trust = e.code; }
  let client = null;
  try { loadPrincipalClientConfiguration(trustFile); } catch (e) { client = e.code; }
  // Both files are READ (native reader) and then rejected on content: an empty key list is not valid
  // trust, and a principals document is not a client configuration. A reader failure would instead
  // surface as AUTHORITY_FILE_UNAVAILABLE from the client loader.
  assert.deepEqual({ trust, client }, { trust: 'PRINCIPAL_TRUST_UNAVAILABLE', client: 'PRINCIPAL_CLIENT_CONFIG_INVALID' });
});

test('Linux: the descriptor-relative reader accepts a normal private file and rejects unsafe shapes and replaced parents', { skip: process.platform !== 'linux' }, t => {
  const dir = privateDir(t);
  const c = cases(dir);
  const observed = {};
  for (const name of ['normal', 'permissive', 'linkLeaf', 'nonregular', 'hard', 'looseFile', 'symParentFile']) observed[name] = outcome(c[name]);
  observed.permissiveNotPrivate = outcome(c.permissive, { privateFile: false });
  // Controlled replacement: the parent path becomes a symlink to a directory holding other bytes.
  fs.renameSync(c.parent, `${c.parent}-moved`);
  const decoy = path.join(dir, 'decoy');
  fs.mkdirSync(decoy, { mode: 0o700 });
  fs.writeFileSync(path.join(decoy, 'key.json'), '{"decoy":true}\n', { mode: 0o600 });
  fs.symlinkSync(decoy, c.parent);
  observed.parentReplacedBySymlink = outcome(c.normal);
  const rejected = { ok: false, code: 'AUTHORITY_FILE_UNAVAILABLE', reason: null };
  assert.deepEqual(observed, {
    normal: { ok: true, bytes: PAYLOAD }, permissive: rejected, linkLeaf: rejected, nonregular: rejected, hard: rejected,
    looseFile: rejected, symParentFile: rejected, permissiveNotPrivate: { ok: true, bytes: PAYLOAD }, parentReplacedBySymlink: rejected,
  });
});
