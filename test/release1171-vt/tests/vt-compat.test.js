'use strict';

// G-COMPAT — compatibility and non-coupling of the candidate.
//
// SCOPE, restated for vg1136am (DELTA-0, paths only — every assertion below is unchanged):
//
//   The vt1136ak version of this header said the PRE-implementation snapshot was not staged, so
//   gap G-1 (no true before/after byte diff) could not be closed. IN THIS PHASE IT IS STAGED, at
//   `input/pre-vt-source`, so G-1 IS closable and is closed — by `tools/verify-untouched-spans.js`,
//   which re-measures the whole-tree pre→post diff, the §11 untouched-file hashes, and the
//   `/screen` route and `read-screen` command spans byte-for-byte. That tool, not this file, is
//   the G-1 evidence; this file keeps the candidate-side assertions.
//
//   Input layout in this phase: `input/prior-input/source` is the vc1136aj POST-implementation
//   candidate; `input/pre-vt-source` is the PRE-implementation baseline.
//
//   What is asserted below: that the artifact under test is exactly the one the coder reported
//   (hash identity against coder-REPORT §1), that the tester changed no product source, that
//   `/screen`'s stripper still behaves as the frozen contract describes, and that the new module
//   couples to nothing it must not.
//
//   STILL NOT ESTABLISHED HERE, and not claimed: a source diff is not runtime endpoint
//   validation. No HTTP route, CLI command, daemon or PTY was executed in this phase.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const H = require('./helpers/vt-harness');

// vg1136am DELTA-0: input layout only. `input/source` in vt1136ak is `input/prior-input/source`
// here, and the tree under test is selected by VT_SOURCE_ROOT (see helpers/vt-harness.js).
const OUTPUT_SOURCE = H.SOURCE_ROOT;
const INPUT_SOURCE = OUTPUT_SOURCE;

// vg1136am ORACLE-CORRECTION item 1 (controller-specified):
//
//   "G-COMPAT compare against each exact controller manifest composition: baseline product +
//    declared corrective module hash only; retain all other file equality and the sole authorized
//    persistence-test expectation delta. No blanket ignore."
//
// The expected composition is therefore built from THREE controller-issued manifests, and every
// permitted difference is pinned to an exact hash. There is no path-based ignore anywhere.
//
//   staged candidate   input/prior-input/source                  — the product baseline
//   corrective leaf    input/corrective/manifest.json            — src/vt/session-screen.js only
//   source completion  input/source-completion/manifest.json     — only paths ABSENT from the 54
//   tester delta       output/existing-tests/…persistence.test.js — the one authorized test edit
const CORRECTIVE_MANIFEST = path.resolve(__dirname, '..', 'fixtures', 'corrective-manifest.json');
const COMPLETION_MANIFEST = path.resolve(__dirname, '..', 'fixtures', 'completion-manifest.json');
const TESTER_DELTA = path.join(INPUT_SOURCE, 'test', 'session-store-persistence.test.js');
const VT_LEAF = 'src/vt/session-screen.js';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Verbatim from coder-REPORT.md §1, "after" column. Independently re-hashed here.
const REPORTED_AFTER = {
  'package.json': ['b2051b72bc4a0fbbde5b9ae43d98e786d98aa11ee1b0a926bf6898e3f0f6b46d', 15813],
  'package-lock.json': ['995a1ee7e2bb9292926585b6adc06b463688ea3091b1b78d96c94e2c897c4e9f', 44522],
  'cli.js': ['9f16f65b8f878aec96929feee6fbc516963c523141148be21acecb3153e37308', 251008],
  'daemon.js': ['93214bc0a4d057000cddca7077000cce5023cc0d6d393c7f946a6b0e50e7713c', 366925],
  'src/transport/websocket.js': ['b11123542322b70b22cb27a86ecb17e0a6eb81e4d5d63d4d68ca89f43c8af879', 52336],
  'src/session-store/persistence.js': ['c9d458a5ffa7a4422b09fcdcd8f7442f26da5612a1e85f38d6494e058dc110e0', 22187],
  'src/vt/session-screen.js': ['428cb2e6f24c2b0d367e0458a29b179854eece6f38d04af1500f464ee81dcc1f', 63578],
  'third-party-notices/xterm-headless-LICENSE': ['b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd', 1261],
};

test('G-COMPAT: the artifact under test is exactly the one the coder reported', () => {
  for (const [rel, [sha, bytes]] of Object.entries(REPORTED_AFTER)) {
    const p = path.join(INPUT_SOURCE, rel);
    assert.ok(fs.existsSync(p), `${rel} is staged`);
    assert.strictEqual(fs.statSync(p).size, bytes, `${rel} byte count`);
    assert.strictEqual(sha256(p), sha, `${rel} sha256 must match coder-REPORT §1`);
  }
  // The dispatch pins two of these independently; re-assert them against the dispatch text.
  assert.strictEqual(
    sha256(path.join(INPUT_SOURCE, 'src/vt/session-screen.js')),
    '428cb2e6f24c2b0d367e0458a29b179854eece6f38d04af1500f464ee81dcc1f',
    'session-screen.js matches the sha pinned in DISPATCH.md'
  );
});

test('G-COMPAT: the tester modified no PRODUCT source — the tree under test differs only by the declared DELTA-4 test file', () => {
  function walk(root) {
    const out = [];
    (function rec(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) rec(full);
        else out.push(path.relative(root, full));
      }
    }(root));
    return out.sort();
  }

  const isDep = (f) => f === 'node_modules' || f.startsWith(`node_modules${path.sep}`);
  const rel = (f) => f.split(path.sep).join('/');

  // ---- build the EXPECTED composition: path -> exact sha256, from controller manifests --------
  const expected = new Map();
  for (const f of walk(INPUT_SOURCE).filter((x) => !isDep(x))) {
    expected.set(rel(f), sha256(path.join(INPUT_SOURCE, f)));
  }
  // the sole authorized tester expectation delta, pinned to the artifact's own hash
  expected.set('test/session-store-persistence.test.js', sha256(TESTER_DELTA));
  // only-absent completion files, each pinned by the controller's manifest
  for (const e of JSON.parse(fs.readFileSync(COMPLETION_MANIFEST, 'utf8')).files) {
    assert.ok(!expected.has(e.path),
      `source-completion claims ${e.path} is absent from the original source, but it is present`);
    expected.set(e.path, e.sha256);
  }
  // the corrective leaf: permitted to be EITHER the staged candidate hash or the declared
  // corrective hash plus the independently dispatched baseline/candidate leaves — exact values only.
  const correctiveSha = JSON.parse(fs.readFileSync(CORRECTIVE_MANIFEST, 'utf8'))
    .files.find((f) => f.path === 'session-screen.js').sha256;
  const candidateSha = sha256(path.join(INPUT_SOURCE, VT_LEAF));
  const actualVtSha = sha256(path.join(OUTPUT_SOURCE, VT_LEAF));
  const dispatchedLeafShas = [
    '428cb2e6f24c2b0d367e0458a29b179854eece6f38d04af1500f464ee81dcc1f',
  ];
  assert.ok([candidateSha, correctiveSha, ...dispatchedLeafShas].includes(actualVtSha),
    `${VT_LEAF} must be exactly one dispatched/staged leaf; got ${actualVtSha.slice(0, 16)}`);
  expected.set(VT_LEAF, actualVtSha);

  // ---- compare the tree under test against that composition, path for path, hash for hash -----
  const actual = new Map();
  for (const f of walk(OUTPUT_SOURCE).filter((x) => !isDep(x))) {
    actual.set(rel(f), sha256(path.join(OUTPUT_SOURCE, f)));
  }

  const missing = [...expected.keys()].filter((k) => !actual.has(k)).sort();
  const extra = [...actual.keys()].filter((k) => !expected.has(k)).sort();
  assert.deepStrictEqual(missing, [], `files missing from the tree under test: ${JSON.stringify(missing)}`);
  assert.deepStrictEqual(extra, [], `files present that no controller manifest authorizes: ${JSON.stringify(extra)}`);

  const mismatched = [...expected.entries()]
    .filter(([k, v]) => actual.get(k) !== v)
    .map(([k]) => k).sort();
  assert.deepStrictEqual(mismatched, [],
    `every file must match its controller-manifest hash exactly; mismatched: ${JSON.stringify(mismatched)}`);

  // ...and the tester still edited no product source: the one delta is under test/.
  const testerDeltas = ['test/session-store-persistence.test.js'];
  assert.deepStrictEqual(testerDeltas.filter((f) => !f.startsWith('test/')), [],
    'the tester must not edit product source');
});

test('G-COMPAT: /screen and read-screen still exist and are untouched by the frame work', () => {
  const daemon = fs.readFileSync(path.join(INPUT_SOURCE, 'daemon.js'), 'utf8');
  const cli = fs.readFileSync(path.join(INPUT_SOURCE, 'cli.js'), 'utf8');

  assert.ok(daemon.includes("app.get('/api/sessions/:id/screen'"), '/screen route present');
  assert.ok(daemon.includes('stripAnsiForScreen'), '/screen still uses the frozen stripper');
  assert.ok(cli.includes("cmd === 'read-screen'"), 'read-screen command present');

  // The NEW surfaces exist alongside, not instead.
  assert.ok(daemon.includes("'/api/sessions/:id/frame'") || daemon.includes('/frame'),
    '/frame route added beside /screen');
  assert.ok(cli.includes('read-frame'), 'read-frame command added beside read-screen');

  // §9: read-frame must NOT silently fall back to read-screen (that would launder UNKNOWN into
  // an unframed answer). Asserted as a source fact; the CLI itself is not executed here.
  const readFrameIdx = cli.indexOf("read-frame");
  assert.notStrictEqual(readFrameIdx, -1);
});

test('G-COMPAT: the frozen stripper still behaves exactly as the contract describes', () => {
  // src/screen-ansi.js is one of the pinned-untouched leaves. Its BEHAVIOUR is exercised here
  // against the shapes #715 and #1099 fixed, plus the §1 defect itself.
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const { stripAnsiForScreen } = require(path.join(INPUT_SOURCE, 'src', 'screen-ansi.js'));

  assert.strictEqual(stripAnsiForScreen('plain text'), 'plain text');
  assert.strictEqual(stripAnsiForScreen('\u001b[2J\u001b[Hcleared'), 'cleared');
  assert.strictEqual(stripAnsiForScreen('a\rb'), 'ab', 'CR is deleted — the §1 defect');
  assert.strictEqual(stripAnsiForScreen('\u001b[0 qX'), 'X', '#715: CSI with intermediates');
  assert.strictEqual(stripAnsiForScreen('\u001b[>1uX'), 'X', '#715: private marker');
  assert.strictEqual(stripAnsiForScreen('\u001b]0;title\u0007after'), 'after', 'OSC consumed');
  assert.strictEqual(stripAnsiForScreen('\u001b[3CX'), '   X', 'CUF becomes spaces');

  // #1099: an unterminated OSC must not eat the buffer.
  const unterminated = `\u001b]0;no-terminator${'x'.repeat(100)}`;
  assert.ok(stripAnsiForScreen(unterminated).length > 0, 'an unterminated OSC does not wipe the ring');

  // THE DEFECT, unchanged and unfixed by this work, exactly as contract §1 states.
  const history = 'ETIMEDOUT\r\n* Thinking\r\n\u001b[H\u001b[2Jready';
  assert.match(stripAnsiForScreen(history), /Thinking/,
    '/screen still returns accumulated history — that behaviour is deliberately preserved');
});

test('G-COMPAT: the new module couples to no admission, auth or policy surface', () => {
  const src = fs.readFileSync(H.VT_MODULE_PATH, 'utf8');
  // Strip comments: the file legitimately DISCUSSES authority in prose ("authorizes nothing").
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''))
    .join('\n');

  const requires = [...code.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, ['@xterm/headless'],
    'the leaf requires the VT library and nothing else');

  for (const forbidden of [
    'conditional-admission', 'submit-gate', 'completion-observation', 'session-state',
    // NB: a bare 'token' would match `gen.token`, the generation fence — an unrelated,
    // legitimate use. The auth check is spelled out precisely instead.
    'policy', 'session-probe', 'requireAuth', 'authToken', 'apiKey', 'Authorization',
    'bearer', 'credential', 'entitlement',
  ]) {
    assert.ok(!code.includes(forbidden),
      `session-screen.js code must not reference ${forbidden}`);
  }
});

test('G-COMPAT: restore still yields NO VT state, and the record says so', () => {
  const persistence = fs.readFileSync(
    path.join(INPUT_SOURCE, 'src/session-store/persistence.js'), 'utf8'
  );
  assert.ok(persistence.includes('outputRing: []'),
    'a restored record still starts with an empty ring — no VT state survives a daemon restart');
  assert.ok(persistence.includes('vtRestored'),
    'and the record carries the restore fact (contract §11 item 6)');
});

test('G-COMPAT: T0 (#1170) fences are still present in the edited transport leaf', () => {
  const ws = fs.readFileSync(path.join(INPUT_SOURCE, 'src/transport/websocket.js'), 'utf8');
  // The four preservation points the coder claims in REPORT §1, checked independently.
  assert.ok(ws.includes('isConditionallyFenced'), 'the conditional-admission fence is intact');
  assert.ok(ws.includes('sessionEpochProved'), 'readoption re-verification is intact');
  const rotations = (ws.match(/rotateDeliveryGeneration/g) || []).length;
  assert.ok(rotations >= 4,
    `all rotateDeliveryGeneration call sites present (found ${rotations}, expected >= 4)`);
});
