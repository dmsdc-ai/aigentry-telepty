'use strict';

// Lifecycle acceptance — terminal-backend surface primitives (#17 / #30 / #31).
//
// Scope: the DIRECTLY-TESTABLE seams of the 2026-05-29 lifecycle fixes
// (ADR 2026-05-29-telepty-lifecycle-gc-surface-focus.md). terminal-backend.js
// exports isSurfaceAlive / closeSurface / focusSurface; we exercise them against
// a FAKE `cmux` placed first on PATH so the real cmux app is never invoked
// (no surface close, no focus-steal, no app dependency).
//
// The daemon.js GC-loop wiring, cli.js close-handler, the #29 owner_alive floor,
// #31 focus GATE, #31.4 queue-flush and #32 provenance are covered by their own
// focused seams. The pure surface-GC verdict mapping lives in src/lifecycle.js.

const { test: nodeTest, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backend = require('../terminal-backend.js');

// POSIX-only by construction. The harness below writes a `#!/usr/bin/env node` script under a file
// literally named `cmux`, chmod 0755s it, and prepends its directory to PATH so that
// execFileSync('cmux', …) inside terminal-backend resolves to it. Windows resolves neither a
// shebang nor an extensionless name — there is no `.cmd`/`.exe` for it to find — so the probes
// that shell out would measure PATH resolution instead of the surface primitives they check. The
// ones that never reach cmux (a non-cmux backend, a malformed ref, `focusSurface` being gone)
// would still hold there; they are skipped with the rest rather than split off, because a file
// that half-runs on a platform its harness does not support is the harder thing to read.
// Skipped with a stated reason rather than returned out of, so a Windows run reports a skip
// instead of a pass it did not earn. Applied once at the seam because the whole file shares the
// one harness; the per-test form is in test/daemon-restart-title-44.test.js.
const SKIP = process.platform === 'win32'
  ? 'POSIX-only (fake `cmux` is a shebang script resolved by name from PATH)'
  : false;
const test = (name, fn) => nodeTest(name, { skip: SKIP }, fn);

// ── Fake cmux harness ────────────────────────────────────────────────────────
// A node script named `cmux` reads control.json to decide ping/list/close/focus
// outcomes and appends every argv to calls.log. We prepend its dir to PATH so
// execFileSync('cmux', ...) inside terminal-backend resolves to it.
let fakeDir;
let originalPath;
const ctrlPath = () => path.join(fakeDir, 'control.json');
const logPath = () => path.join(fakeDir, 'calls.log');

const FAKE_CMUX = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let ctrl = {};
try { ctrl = JSON.parse(fs.readFileSync(path.join(__dirname, 'control.json'), 'utf8')); } catch {}
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\\n');
const has = (k) => args.includes(k);
if (has('ping')) process.exit(ctrl.ping === 'fail' ? 1 : 0);
if (has('list-workspaces')) {
  if (ctrl.list === 'fail') process.exit(1);
  process.stdout.write(ctrl.workspaces || '');
  process.exit(0);
}
if (has('tree')) {
  if (ctrl.tree === 'fail') process.exit(1);
  process.stdout.write(ctrl.treeJson || '{}');
  process.exit(0);
}
if (has('close-workspace')) process.exit(ctrl.close === 'fail' ? 1 : 0);
if (has('select-workspace')) process.exit(ctrl.select === 'fail' ? 1 : 0);
if (has('focus-pane')) process.exit(ctrl.focus === 'fail' ? 1 : 0);
process.exit(0);
`;

function setControl(ctrl) {
  fs.writeFileSync(ctrlPath(), JSON.stringify(ctrl || {}));
}
function resetCalls() {
  fs.writeFileSync(logPath(), '');
}
function calls() {
  const raw = fs.readFileSync(logPath(), 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l));
}

before(() => {
  fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecmux-'));
  const cmuxPath = path.join(fakeDir, 'cmux');
  fs.writeFileSync(cmuxPath, FAKE_CMUX, { mode: 0o755 });
  fs.chmodSync(cmuxPath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = fakeDir + path.delimiter + originalPath;
});

after(() => {
  process.env.PATH = originalPath;
  try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  setControl({});
  resetCalls();
});

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ── #17 / INV-17 — isSurfaceAlive liveness probe ─────────────────────────────

test('isSurfaceAlive: non-cmux backend → unknown (out of #17 scope)', () => {
  assert.equal(backend.isSurfaceAlive({ backend: 'warp', cmuxWorkspaceId: UUID_A }), 'unknown');
  assert.equal(backend.isSurfaceAlive({ backend: 'pty', cmuxWorkspaceId: UUID_A }), 'unknown');
  assert.equal(backend.isSurfaceAlive({ backend: 'kitty', cmuxWorkspaceId: UUID_A }), 'unknown');
  // never touches cmux for non-cmux backends
  assert.deepEqual(calls(), []);
});

test('isSurfaceAlive: missing / invalid cmuxWorkspaceId → unknown (no cmux call)', () => {
  assert.equal(backend.isSurfaceAlive({ backend: 'cmux' }), 'unknown');
  assert.equal(backend.isSurfaceAlive({ backend: 'cmux', cmuxWorkspaceId: '' }), 'unknown');
  assert.equal(backend.isSurfaceAlive({ backend: 'cmux', cmuxWorkspaceId: 'not a ref; rm -rf /' }), 'unknown');
  assert.deepEqual(calls(), []);
});

test('AC-17.2 (INV-17 GATE / #486 non-regression): cmux UNREACHABLE → unknown → PRESERVE', () => {
  // cmux app-quit / restart: `cmux ping` throws (non-zero exit). The probe MUST
  // return indeterminate so the daemon GCs NOTHING — the whole point of #487.
  setControl({ ping: 'fail' });
  const verdict = backend.isSurfaceAlive({ backend: 'cmux', cmuxWorkspaceId: UUID_A });
  assert.equal(verdict, 'unknown', 'unreachable cmux must be INDETERMINATE, never "gone"');
  // ping was attempted, but no enumeration / no destructive follow-up
  const seen = calls();
  assert.ok(seen.some((c) => c.includes('ping')), 'ping should have been attempted');
  assert.ok(!seen.some((c) => c.includes('list-workspaces')), 'must not enumerate once ping failed');
});

test('AC-17.2 corollary: ping OK but list-workspaces throws → unknown (transient hiccup, no GC)', () => {
  setControl({ ping: 'ok', list: 'fail' });
  assert.equal(backend.isSurfaceAlive({ backend: 'cmux', cmuxWorkspaceId: UUID_A }), 'unknown');
});

test('AC-17.1 (explicit close): cmux reachable + workspace ABSENT → gone (GC candidate)', () => {
  // cmux alive, but this session's workspace UUID is not in the live listing.
  setControl({ ping: 'ok', workspaces: `workspace:1 ${UUID_B}\nworkspace:2 cccccccc-cccc-cccc-cccc-cccccccccccc\n` });
  assert.equal(backend.isSurfaceAlive({ backend: 'cmux', cmuxWorkspaceId: UUID_A }), 'gone');
});

test('AC-17.4 (recovery): cmux reachable + workspace PRESENT → alive (no GC)', () => {
  setControl({ ping: 'ok', workspaces: `workspace:1 ${UUID_A}\nworkspace:2 ${UUID_B}\n` });
  assert.equal(backend.isSurfaceAlive({ backend: 'cmux', cmuxWorkspaceId: UUID_A }), 'alive');
});

test('AC-17.x: UUID match is case-insensitive', () => {
  setControl({ ping: 'ok', workspaces: `workspace:1 ${UUID_A.toUpperCase()}\n` });
  assert.equal(backend.isSurfaceAlive({ backend: 'cmux', cmuxWorkspaceId: UUID_A }), 'alive');
});

// ── surface_mismatched predicate (read-only probe) ───────────────────────────

function alivePtyOptions(tty = 'ttys007') {
  return {
    sessionId: 'worker-codex',
    processKill: () => true,
    readProcessTty: () => tty
  };
}

function wrappedCmuxSession(extra = {}) {
  return {
    id: 'worker-codex',
    type: 'wrapped',
    backend: 'cmux',
    cmuxWorkspaceId: UUID_A,
    cmuxSurfaceId: 'surface:1',
    ptyPid: 4242,
    ...extra
  };
}

function setTree(workspace) {
  setControl({ ping: 'ok', treeJson: JSON.stringify({ workspaces: [workspace] }) });
}

test('detectSurfaceMismatch: selected surface tty matching expected PTY tty → match', () => {
  setTree({
    type: 'workspace',
    ref: UUID_A,
    surfaces: [
      { type: 'surface', ref: 'surface:1', title: '⚡ telepty :: worker-codex', selected: true, tty: 'ttys007' }
    ]
  });

  const verdict = backend.detectSurfaceMismatch(wrappedCmuxSession(), alivePtyOptions('ttys007'));
  assert.equal(verdict.status, 'match');
  assert.equal(verdict.method, 'tty');
  assert.equal(verdict.reason, 'tty_match');
});

test('detectSurfaceMismatch: selected surface tty differing from expected PTY tty → mismatch', () => {
  setTree({
    type: 'workspace',
    ref: UUID_A,
    surfaces: [
      { type: 'surface', ref: 'surface:9', title: 'stray shell', selected: true, tty: 'ttys999' }
    ]
  });

  const verdict = backend.detectSurfaceMismatch(wrappedCmuxSession(), alivePtyOptions('ttys007'));
  assert.equal(verdict.status, 'mismatch');
  assert.equal(verdict.method, 'tty');
  assert.equal(verdict.reason, 'tty_mismatch');
  assert.equal(verdict.expectedPtyPid, 4242);
  assert.match(verdict.observedSurface, /surface:9/);
  assert.match(verdict.observedSurface, /tty=ttys999/);
});

test('detectSurfaceMismatch: no tty metadata falls back to selected surface ref/title marker', () => {
  setTree({
    type: 'workspace',
    ref: UUID_A,
    surfaces: [
      { type: 'surface', ref: 'surface:2', title: 'stray shell', selected: true }
    ]
  });

  const verdict = backend.detectSurfaceMismatch(wrappedCmuxSession(), alivePtyOptions('ttys007'));
  assert.equal(verdict.status, 'mismatch');
  assert.equal(verdict.method, 'title');
  assert.equal(verdict.reason, 'surface_ref_mismatch');
  assert.match(verdict.observedSurface, /surface:2/);
});

test('detectSurfaceMismatch: cmux unreachable remains unknown and never enumerates tree', () => {
  setControl({ ping: 'fail' });
  const verdict = backend.detectSurfaceMismatch(wrappedCmuxSession(), alivePtyOptions('ttys007'));
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.reason, 'cmux_unreachable');
  const seen = calls();
  assert.ok(seen.some((c) => c.includes('ping')), 'ping should have been attempted');
  assert.ok(!seen.some((c) => c.includes('tree')), 'must not inspect tree once ping failed');
});

test('detectSurfaceMismatch: dead expected PTY remains unknown and never touches cmux', () => {
  const verdict = backend.detectSurfaceMismatch(wrappedCmuxSession(), {
    sessionId: 'worker-codex',
    processKill: () => {
      const err = new Error('dead');
      err.code = 'ESRCH';
      throw err;
    },
    readProcessTty: () => 'ttys007'
  });
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.reason, 'expected_pty_dead');
  assert.deepEqual(calls(), []);
});

// ── #30 — closeSurface: GATED (orchestrator owns surface close; verdict 2026-05-30) ──────────
// Managed default = NO-OP (orchestrator workspace-host.sh wh_close owns close). Standalone
// fallback only when AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1.
const SELF_CLOSE = 'AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE';

test('verdict-2026-05-30 (managed default): closeSurface is a NO-OP — no cmux close-workspace, returns true', () => {
  delete process.env[SELF_CLOSE];
  const ok = backend.closeSurface({ backend: 'cmux', cmuxWorkspaceId: 'workspace:3' });
  assert.equal(ok, true);
  assert.deepEqual(calls(), [], 'managed path: telepty must NOT actuate cmux close — orchestrator owns it');
});

test('standalone opt-in (=1): cmux session → issues `cmux close-workspace --workspace <wid>`', () => {
  process.env[SELF_CLOSE] = '1';
  try {
    assert.equal(backend.closeSurface({ backend: 'cmux', cmuxWorkspaceId: 'workspace:3' }), true);
    assert.deepEqual(calls()[0], ['close-workspace', '--workspace', 'workspace:3']);
  } finally { delete process.env[SELF_CLOSE]; }
});

test('standalone opt-in: already-gone surface (close fail) → returns true, never throws', () => {
  process.env[SELF_CLOSE] = '1';
  setControl({ close: 'fail' });
  try {
    let ok; assert.doesNotThrow(() => { ok = backend.closeSurface({ backend: 'cmux', cmuxWorkspaceId: 'workspace:9' }); });
    assert.equal(ok, true, 'a failed close must still resolve true so destroy is never blocked');
  } finally { delete process.env[SELF_CLOSE]; }
});

test('opt-in still no-ops non-cmux + guards injection: headless/warp/malformed → true, no cmux call', () => {
  process.env[SELF_CLOSE] = '1';
  try {
    assert.equal(backend.closeSurface({ backend: 'headless' }), true);
    assert.equal(backend.closeSurface({ backend: 'warp', cmuxWorkspaceId: UUID_A }), true);
    assert.equal(backend.closeSurface({ backend: 'cmux', cmuxWorkspaceId: 'evil; rm -rf /' }), true);
    assert.deepEqual(calls(), [], 'non-cmux + malformed cmux ref must never shell out');
  } finally { delete process.env[SELF_CLOSE]; }
});

test('closeSurface(null) → true no-op (both modes)', () => {
  assert.equal(backend.closeSurface(null), true);
  process.env[SELF_CLOSE] = '1';
  try { assert.equal(backend.closeSurface(null), true); } finally { delete process.env[SELF_CLOSE]; }
  assert.deepEqual(calls(), []);
});

// ── #31 — focusSurface REMOVED from telepty (focus = orchestrator wh_focus; verdict 2026-05-30) ──

test('verdict-2026-05-30: focusSurface is REMOVED from terminal-backend (focus actuation moved to orchestrator wh_focus)', () => {
  assert.equal(typeof backend.focusSurface, 'undefined',
    'telepty must no longer expose focusSurface — surface focus is owned by workspace-host.sh wh_focus');
});
