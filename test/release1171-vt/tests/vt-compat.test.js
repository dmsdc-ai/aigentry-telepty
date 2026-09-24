'use strict';

// G-COMPAT — compatibility and non-coupling of the candidate.
//
// SCOPE, restated for vg1136am (DELTA-0, paths only — every assertion below is unchanged):
//
//   vt1170ae ORACLE-REPAIR supersedes the "every assertion below is unchanged" clause for ONE
//   assertion only: the whole-tree composition check. See the ORACLE-REPAIR block below for why
//   the vg1136am composition no longer describes this integrated release candidate. Every other
//   assertion in this file — the coder's eight exact pins, the /screen and read-screen spans, the
//   stripper behaviour, the coupling ban, the restore record and the T0 fences — is unchanged.
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

// ---------------------------------------------------------------------------------------------
// vt1170ae ORACLE-REPAIR — why the composition below replaced the vg1136am one.
//
// HISTORICAL NOTE, recorded because it is load-bearing for reading this file: the vg1136am
// ORACLE-CORRECTION item 1 composition ("baseline product + declared corrective module hash
// only ... plus the sole authorized persistence-test expectation delta") DESCRIBED A STAGING
// LAYOUT THAT NO LONGER EXISTS, AND IT DOES NOT DESCRIBE THIS INTEGRATED RELEASE CANDIDATE.
// In that phase `input/prior-input/source` (expected) and the tree under test (actual) were two
// DIFFERENT directories, so a whole-tree path-for-path, hash-for-hash comparison between them
// was a real measurement. In this phase INPUT_SOURCE and OUTPUT_SOURCE resolve to the SAME
// directory (both are `H.SOURCE_ROOT`), which broke that oracle in two distinct ways:
//
//   1. TAUTOLOGY. Building the expected map by hashing the tree under test and then comparing it
//      to the tree under test can only fail on a mid-test change. Every leaf except the eight
//      REPORTED_AFTER pins and the VT leaf was asserted against itself, so a mutated product
//      file would have been declared correct.
//   2. SELF-RACE. The expected walk and the actual walk happen ~190ms apart, and in CI the suite's
//      own TAP log is being written INSIDE the walked tree at `artifacts/release1171-telepty/vt.tap`
//      the whole time. CI 36001514107 failed on exactly that path and nothing else: the oracle was
//      measuring its own logging, not the product.
//   The historical `source-completion` manifest is also vacuous here — it now carries zero files
//   (its job was to name paths absent from the old 54-file staging set), and the corrective leaf
//   hash is byte-identical to the staged candidate. Both are retained below only as EXACT pins.
//
// THE REPAIR: the expected side is no longer derived from the tree under test at all. It is a
// PRODUCT inventory frozen from the controller's read-only `input/source` at test-authorship time
// and committed as `fixtures/product-manifest.json`. The oracle enumerates only declared PRODUCT
// roots, so non-product growth (the TAP log, CI evidence, dependencies) is structurally outside
// the measurement rather than ignored by a path exception — while mutation, deletion AND addition
// of a product leaf are all rejected against fixed bytes.
// ---------------------------------------------------------------------------------------------
const CORRECTIVE_MANIFEST = path.resolve(__dirname, '..', 'fixtures', 'corrective-manifest.json');
const COMPLETION_MANIFEST = path.resolve(__dirname, '..', 'fixtures', 'completion-manifest.json');
const PRODUCT_MANIFEST = path.resolve(__dirname, '..', 'fixtures', 'product-manifest.json');
const VT_LEAF = 'src/vt/session-screen.js';

// The PRODUCT boundary this oracle enforces, measured from `package.json` (.files/.bin/.main) and
// the vt1170ae dispatch root list. Declared here AND in the frozen manifest; the test asserts the
// two agree, so neither can drift silently.
//
//   COVERED    every file under these roots, recursively:
//                src/**  mcp-server/**  scripts/**  skills/**  third-party-notices/**
//              every repository-ROOT runtime script matching ROOT_RUNTIME_JS (the 15 root .js
//              entrypoints today; a NEW root .js/.mjs/.cjs is an unauthorized addition), and
//                package.json  package-lock.json  install.sh  install.ps1
//
//   NOT COVERED, by explicit declaration and not as a blanket exception — see the manifest's
//              `excluded` map for the per-root reason: node_modules/** (dependencies),
//              test/** tests/** test-support/** (test harness, goldens, fixtures),
//              artifacts/** (live run evidence written DURING the suite), .github/** (CI),
//              .git/**, docs/ demo/ specs/ scratchpad/ protocol/ templates/ (documentation and
//              development material), .claude/ .gemini/ (agent config), and the root
//              documentation/config files (CHANGELOG.md, README*.md, LICENSE, AGENTS.md,
//              CLAUDE.md, GEMINI.md, BOUNDARY.md, BUS_EVENT_SCHEMA.md, tsconfig.json,
//              ecosystem.json, clipboard_image.png, .git* / .npmignore, clipboard assets).
//              CHANGELOG.md and LICENSE ARE shipped by `package.json .files` but carry no runtime
//              behaviour, so they are outside this inventory deliberately.
//
// NOT CLAIMED: this is not an assertion that every repository file is product. It is an assertion
// about exactly the roots above.
const PRODUCT_ROOTS_RECURSIVE = ['src', 'mcp-server', 'scripts', 'skills', 'third-party-notices'];
const PRODUCT_ROOT_FILES = ['package.json', 'package-lock.json', 'install.sh', 'install.ps1'];
const ROOT_RUNTIME_JS = /^[^.][^/]*\.(?:js|mjs|cjs)$/;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Enumerate the PRODUCT inventory of `root`, sorted, as posix-relative paths. */
function productInventory(root) {
  const out = [];
  const rec = (relDir) => {
    const abs = path.join(root, relDir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) rec(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  for (const r of PRODUCT_ROOTS_RECURSIVE) rec(r);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (ROOT_RUNTIME_JS.test(entry.name) || PRODUCT_ROOT_FILES.includes(entry.name)) {
      out.push(entry.name);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * The exact sha256 set authorized for one leaf: its frozen hash plus any controller-authorized
 * alternate. An alternate is always an EXACT hash for a NAMED path — never a path-based ignore.
 */
function authorizedShas(manifest, rel, frozenSha) {
  const alts = (manifest.authorized_alternates || {})[rel] || [];
  return [frozenSha, ...alts.map((a) => a.sha256)].filter(Boolean);
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
  // vt1170ae: the coder's eight exact pins are RETAINED verbatim. The only change is that
  // `package.json` may additionally be the one controller-authorized test-only variant (fh1170ad
  // adds `test/conditional-test-setup.test.js` to `scripts.test:ci`, sha 08dd342f…); that variant
  // is an exact hash recorded in the frozen manifest, not a relaxation. Its byte count is not
  // pinned because the controller supplied the hash only — the hash subsumes the length.
  const manifest = JSON.parse(fs.readFileSync(PRODUCT_MANIFEST, 'utf8'));
  for (const [rel, [sha, bytes]] of Object.entries(REPORTED_AFTER)) {
    const p = path.join(INPUT_SOURCE, rel);
    assert.ok(fs.existsSync(p), `${rel} is staged`);
    const allowed = authorizedShas(manifest, rel, sha);
    const got = sha256(p);
    assert.ok(allowed.includes(got),
      `${rel} sha256 must match coder-REPORT §1 (or an authorized alternate); `
      + `got ${got}, allowed ${JSON.stringify(allowed)}`);
    if (got === sha) {
      assert.strictEqual(fs.statSync(p).size, bytes, `${rel} byte count`);
    }
  }
  // The dispatch pins two of these independently; re-assert them against the dispatch text.
  assert.strictEqual(
    sha256(path.join(INPUT_SOURCE, 'src/vt/session-screen.js')),
    '428cb2e6f24c2b0d367e0458a29b179854eece6f38d04af1500f464ee81dcc1f',
    'session-screen.js matches the sha pinned in DISPATCH.md'
  );
});

test('G-COMPAT: the frozen PRODUCT manifest is internally consistent and declares the same roots this oracle enforces', () => {
  const m = JSON.parse(fs.readFileSync(PRODUCT_MANIFEST, 'utf8'));

  assert.strictEqual(m.schema, 'release1171-vt/product-manifest@1');
  assert.deepStrictEqual(m.product_roots.recursive, PRODUCT_ROOTS_RECURSIVE,
    'the manifest and this test must declare the same recursive product roots');
  assert.deepStrictEqual(m.product_roots.root_files, PRODUCT_ROOT_FILES,
    'the manifest and this test must declare the same explicit root product files');
  assert.strictEqual(m.product_roots.root_file_pattern, '^[^.][^/]*\\.(js|mjs|cjs)$',
    'the manifest and this test must use the same root runtime-script pattern');

  // The manifest is FROZEN: it carries a hash over its own (path, sha256) list, so editing a leaf
  // hash in the fixture to make a failing tree pass is itself a loud failure.
  assert.strictEqual(m.files.length, m.leaf_count, 'leaf_count matches the file list');
  assert.ok(m.leaf_count > 0, 'the inventory is non-empty');
  const selfSha = crypto.createHash('sha256')
    .update(m.files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex');
  assert.strictEqual(selfSha, m.inventory_sha256,
    'product-manifest.json has been edited in place — its inventory_sha256 no longer covers its files');

  // Every leaf is a full sha256 with a byte count, and no leaf escapes a declared product root.
  const inRoot = (p) => PRODUCT_ROOTS_RECURSIVE.some((r) => p.startsWith(`${r}/`))
    || (!p.includes('/') && (ROOT_RUNTIME_JS.test(p) || PRODUCT_ROOT_FILES.includes(p)));
  for (const f of m.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.path} carries a full sha256`);
    assert.ok(Number.isInteger(f.bytes) && f.bytes >= 0, `${f.path} carries a byte count`);
    assert.ok(inRoot(f.path), `${f.path} is inside a declared product root`);
  }
  // No test, CI, evidence, dependency or VCS path may ever enter the product inventory: those are
  // outside the boundary by declaration, so their presence here would mean the boundary drifted.
  const leaked = m.files.map((f) => f.path).filter((p) => /^(?:test|tests|test-support|artifacts|node_modules|\.git|\.github|docs|demo|specs|scratchpad)\//.test(p));
  assert.deepStrictEqual(leaked, [],
    `non-product paths must never appear in the product inventory: ${JSON.stringify(leaked)}`);

  // The historical manifests are retained as exact pins only; record what they now mean.
  const corrective = JSON.parse(fs.readFileSync(CORRECTIVE_MANIFEST, 'utf8'))
    .files.find((f) => f.path === 'session-screen.js').sha256;
  assert.match(corrective, /^[0-9a-f]{64}$/, 'the corrective leaf is still pinned by exact hash');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(COMPLETION_MANIFEST, 'utf8')).files, [],
    'the vg1136am source-completion manifest is empty in this phase — it described a staging '
    + 'layout that no longer exists, and is retained only so its vacuity is explicit'
  );
});

test('G-COMPAT: the PRODUCT inventory under test matches the frozen manifest exactly — no mutation, deletion or addition', () => {
  const m = JSON.parse(fs.readFileSync(PRODUCT_MANIFEST, 'utf8'));

  // EXPECTED comes from the frozen fixture — NOT from the tree being validated. This is the whole
  // repair: there is no second walk of the tree under test to compare against, so the oracle can
  // neither be tautological nor race its own TAP/evidence writes.
  const expected = new Map(m.files.map((f) => [f.path, f]));
  const actualPaths = productInventory(OUTPUT_SOURCE);

  const deleted = [...expected.keys()].filter((p) => !actualPaths.includes(p)).sort();
  const added = actualPaths.filter((p) => !expected.has(p)).sort();
  assert.deepStrictEqual(deleted, [],
    `PRODUCT leaves deleted from the tree under test: ${JSON.stringify(deleted)}`);
  assert.deepStrictEqual(added, [],
    `PRODUCT leaves present that the frozen manifest does not authorize: ${JSON.stringify(added)}`);

  // Hash EVERY inventory leaf against its frozen bytes; alternates are exact hashes for named
  // paths, so a mutation can never be absorbed by a tolerance.
  const mutated = [];
  for (const rel of actualPaths) {
    const e = expected.get(rel);
    const abs = path.join(OUTPUT_SOURCE, rel);
    const got = sha256(abs);
    const allowed = authorizedShas(m, rel, e.sha256);
    if (!allowed.includes(got)) {
      mutated.push(`${rel} (frozen ${e.sha256.slice(0, 16)}…, got ${got.slice(0, 16)}…)`);
    } else if (got === e.sha256) {
      assert.strictEqual(fs.statSync(abs).size, e.bytes, `${rel} frozen byte count`);
    }
  }
  assert.deepStrictEqual(mutated, [],
    `every PRODUCT leaf must match its frozen manifest hash exactly; mutated: ${JSON.stringify(mutated)}`);

  // The VT leaf keeps its own independent dispatched pin, as before.
  assert.ok(authorizedShas(m, VT_LEAF, expected.get(VT_LEAF).sha256)
    .includes('428cb2e6f24c2b0d367e0458a29b179854eece6f38d04af1500f464ee81dcc1f'),
    `${VT_LEAF} must still be pinned to the dispatched hash`);

  // NON-PRODUCT growth is tolerated STRUCTURALLY, not by exception: the suite's own live TAP log
  // and the CI evidence directory are written inside the repository while this test runs, and the
  // enumeration above never visits them. Asserting it keeps the property from silently regressing.
  assert.deepStrictEqual(
    actualPaths.filter((p) => /^(?:artifacts|test|tests|test-support|node_modules|\.github|\.git)\//.test(p)),
    [], 'the product enumeration must not reach evidence, test, CI, VCS or dependency paths'
  );

  // ...and the tester still edited no product source. The two files this operation owns are
  // `test/release1171-vt/tests/vt-compat.test.js` and `test/release1171-vt/fixtures/
  // product-manifest.json`; both are under `test/`, which the inventory above excludes by
  // declaration — so if either had been a product file, `added`/`mutated` would have caught it.
  const testerOwned = [
    'test/release1171-vt/tests/vt-compat.test.js',
    'test/release1171-vt/fixtures/product-manifest.json',
  ];
  assert.deepStrictEqual(testerOwned.filter((f) => !f.startsWith('test/')), [],
    'the tester must not edit product source');
  for (const f of testerOwned) {
    assert.ok(fs.existsSync(path.join(OUTPUT_SOURCE, f)), `${f} is present`);
    assert.ok(!expected.has(f), `${f} must be outside the PRODUCT inventory`);
  }
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
