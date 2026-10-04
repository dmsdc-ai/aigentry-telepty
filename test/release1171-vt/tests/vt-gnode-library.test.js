'use strict';

// G-NODE — the pinned package ACTUALLY loads and parses under telepty's node >=20.
// Contract §12 G-NODE, blocker B-2 ("no `engines` key is not evidence").
//
// Everything here uses the REAL unpacked @xterm/headless 6.0.0. No stub.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const H = require('./helpers/vt-harness');

// tt1170aa PORTABILITY-2 (default only; assertions below unchanged): resolve the pinned package
// through the harness's own dependency root, whose default is now `<repo root>/node_modules`
// rather than an absolute worker path. `TELEPTY_DEPENDENCY_ROOT` still overrides it as a fixture
// selector, so this is the same value this file used whenever that variable was set.
const DEP_DIR = path.join(H.DEPENDENCY_ROOT, '@xterm', 'headless');
// vg1136am DELTA-0: input layout only — `input/pinned-headless` in vt1136ak is staged at
// `input/prior-input/pinned-headless` in this phase. Assertions unchanged.
const PINNED_DIR = path.resolve(__dirname, '..', 'fixtures', 'pinned-headless');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('G-NODE/fixture: the unpacked dependency is byte-identical to the pinned artifacts', () => {
  assert.strictEqual(
    sha256(path.join(DEP_DIR, 'package.json')),
    sha256(path.join(PINNED_DIR, 'package.json')),
    'unpacked package.json must equal input/pinned-headless/package.json'
  );
  assert.strictEqual(
    sha256(path.join(DEP_DIR, 'typings', 'xterm-headless.d.ts')),
    sha256(path.join(PINNED_DIR, 'xterm-headless.d.ts')),
    'unpacked typings must equal input/pinned-headless/xterm-headless.d.ts'
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(DEP_DIR, 'package.json'), 'utf8'));
  assert.strictEqual(manifest.name, '@xterm/headless');
  assert.strictEqual(manifest.version, '6.0.0');
  assert.strictEqual(manifest.license, 'MIT');
  // B-2: the ABSENCE of `engines` is recorded as a measured fact, not as evidence of support.
  assert.ok(!('engines' in manifest), 'manifest has no engines key (recorded, not evidence)');
  assert.ok(!('dependencies' in manifest), 'manifest declares no runtime dependencies');
});

test('G-LICENSE (partial): the tarball ships no LICENSE; the vendored notice does, byte-identical', () => {
  // B-1 as the contract states it: `"license": "MIT"` is metadata, not shipped attribution.
  assert.ok(
    !fs.existsSync(path.join(DEP_DIR, 'LICENSE')),
    'the 6.0.0 tarball genuinely contains no package/LICENSE — B-1 reproduced'
  );
  const vendored = path.join(H.SOURCE_ROOT, 'third-party-notices', 'xterm-headless-LICENSE');
  assert.ok(fs.existsSync(vendored), 'vendored notice leaf exists');
  assert.strictEqual(
    sha256(vendored),
    sha256(path.join(PINNED_DIR, 'LICENSE')),
    'vendored notice is the upstream text unchanged'
  );
  assert.strictEqual(fs.statSync(vendored).size, 1261);

  const pkg = JSON.parse(fs.readFileSync(path.join(H.SOURCE_ROOT, 'package.json'), 'utf8'));
  assert.ok(
    pkg.files.includes('third-party-notices/'),
    'third-party-notices/ is in package.json files, so the notice actually ships'
  );
  assert.strictEqual(pkg.dependencies['@xterm/headless'], '6.0.0', 'exact pin, no caret');
});

test('G-NODE: the real package requires, constructs, parses and disposes under this node', () => {
  assert.strictEqual(process.versions.node.split('.')[0], '20', 'running under node 20');

  const Terminal = H.realTerminalCtor();
  assert.strictEqual(typeof Terminal, 'function');

  const term = new Terminal({ cols: 24, rows: 4, scrollback: 0, allowProposedApi: true });
  assert.strictEqual(term.cols, 24);
  assert.strictEqual(term.rows, 4);

  // Proposed-API surface (B-4): reading `buffer` must not throw when allowProposedApi is true.
  const buf = term.buffer.active;
  assert.strictEqual(buf.type, 'normal');
  assert.strictEqual(typeof buf.getLine(0).translateToString, 'function');
  term.dispose();
});

test('G-NODE/B-4: reading buffer WITHOUT allowProposedApi throws — the pin is load-bearing', () => {
  const Terminal = H.realTerminalCtor();
  const term = new Terminal({ cols: 10, rows: 2, scrollback: 0 });
  assert.throws(
    () => term.buffer.active.getLine(0),
    'buffer access is a proposed API; allowProposedApi:true is mandatory, as the module sets it'
  );
  term.dispose();
});

test('G-NODE: the module under test resolves and loads the real library (no injected factory)', async () => {
  const vt = H.loadVt();
  // No terminalFactory: this exercises the module's own lazy require('@xterm/headless').
  const screen = new vt.SessionScreen({
    sessionId: 's-gnode',
    cause: 'stream_origin',
    localSource: true,
    geometrySource: 'local_pty',
    cols: 20,
    rows: 3,
  });
  screen.noteOutput('loaded-for-real');
  const frame = await H.frameAfterDrain(screen);

  H.assertNoReason(frame, 'vt_library_unavailable');
  H.assertNoReason(frame, 'vt_library_invalid');
  H.assertNoReason(frame, 'vt_construct_failed');
  assert.strictEqual(frame.rows_text[0], 'loaded-for-real');
  assert.strictEqual(frame.unit, 'utf16_code_unit');
  screen.dispose();
});

test('the module is self-contained: no daemon, store, socket or disk import', () => {
  const src = fs.readFileSync(H.VT_MODULE_PATH, 'utf8');
  const requires = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    requires, ['@xterm/headless'],
    `session-screen.js must require exactly @xterm/headless; got ${JSON.stringify(requires)}`
  );
});
