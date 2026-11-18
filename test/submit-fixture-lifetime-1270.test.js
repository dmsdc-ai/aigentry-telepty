'use strict';

// Task 1270 E2 — c6 fixture ownership/lifetime regression: REAL node:test cancellation of the REAL maintained fixture.
//
// Runs the maintained file test/submit-public-error-contract.test.js in one child node process, FOCUSED with node:test's
// own --test-name-pattern=^c6 (the c6 parent, its children and the c6 fanout test; every other case is deliberately
// excluded here — the ordinary whole-file run, all 93 tests, stays the regular acceptance), with ONE test-only controlled
// fault, TELEPTY_FIXTURE_1270_C6_HOLD_MS (unset in every ordinary run). It holds c6-1, abortably, past its parent's
// UNCHANGED 10 000 ms deadline: the point where c6-1's H.inject was still pending on Windows/20 job 133048676602.
// node:test then times the c6 parent out, cancels c6-1 and the parent body resumes. That child run is an EXPECTED
// FAILURE (exit 1, c6 timed out, c6-1 cancelled): it is the evidence this test judges, never a normal green.
//
// REGRESSION: once the parent is aborted no later c6 subtest starts — no c6-2 result and no c6-2 body output (c6-2
// mutates process.env.TELEPTY_MODAL_REMEDY and H.rshared.MODAL_HINT_BY_CLI before its '"case":"modal"' line) — the
// guard reports itself, the c6 parent timeout is the ONLY top-level failure, and c6 fanout (c6-3/4/5) still passes.
// Child ownership: the exact child handle is SIGKILLed on its own 45 s bound, on this test's cancellation (t.signal) and
// on a catchable exit of this process ('exit'). An uncatchable kill of this process or an ancestor (e.g. the #879
// runner's SIGKILL of its direct `node --test` handle) cannot be intercepted from JS: the child then ends only with its
// own finite run (~11 s expected). A killed, timed-out or aborted child is a FAIL here, never cancellation evidence.
// Expected RED (NOT_RUN) with the ownership guard removed (the CI sensitivity mutant; the d4 fixture has no fault hook,
// so it fails here only on a PRECONDITION and is NOT a RED): c6-2 is re-parented to the root, its body runs and it is
// reported "test could not be started because its parent finished" (job 133048676602 log lines 12884-12888).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'submit-public-error-contract.test.js');
const SETUP = path.join(__dirname, '..', 'test-support', 'setup-env.js');   // the inventory preload
const HOLD_MS = '30000';         // > the parent's 10 000 ms; ended by c6-1's cancellation, so it adds no time
const FOCUS = '^c6';             // node:test name filter: c6 parent, c6-1/2, c6 fanout and c6-3/4/5 only
const CHILD_BOUND_MS = 45000;    // focused child ~11 s; below this test's 50 s and the #879 runner's 60 s per-file bound
const PARENT = 'c6 /inject real delivery-return boundary: UPSTREAM_STALLED suspended (task1270), SURFACE_MODAL text kept';
const C61 = 'c6-1 unanswered upstream probe does not reject /inject (UPSTREAM_STALLED suspended)';
const C62 = 'c6-2 SURFACE_MODAL reject exact reason + daemon hint via /inject';
const FANOUT = 'c6 fanout real route propagates requested/cap into the public cap text';
const FANOUT_CHILDREN = ['c6-3 multicast 3 > cap 2', 'c6-4 multicast 3 > fractional cap 2.5 (Math.max(1, Number(env)))',
  'c6-5 broadcast all sessions > cap 2'];
const GUARD_LINE = '# C6_LIFETIME {"c6_2":"not_started","parent_aborted":true}';

function runFixture(signal) {
  // A NODE_TEST_CONTEXT inherited from an outer `node --test` would switch the child to the runner's private protocol.
  const env = { ...process.env, TELEPTY_FIXTURE_1270_C6_HOLD_MS: HOLD_MS };
  delete env.NODE_TEST_CONTEXT;
  return new Promise(resolve => {
    let child = null;
    // A catchable exit of this process stops exactly the owned child (no group, tree or sweep signal).
    const reap = () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    process.once('exit', reap);
    child = execFile(process.execPath, ['--require', SETUP, `--test-name-pattern=${FOCUS}`, '--test-reporter=tap', FIXTURE],
      { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CHILD_BOUND_MS, killSignal: 'SIGKILL', signal, windowsHide: true },
      (error, stdout, stderr) => {
        process.removeListener('exit', reap);
        resolve({ code: error ? error.code : 0, killed: Boolean(error && error.killed), signal: (error && error.signal) || null, stdout, stderr });
      });
  });
}

// TAP result lines "<indent>(not )ok N - <title>[ # SKIP|TODO …]" with the YAML block that follows each. node:test escapes
// a literal '#' in titles, so " # " only introduces a directive (e.g. Node 20's skip for a name the pattern excludes).
function results(tap) {
  const lines = tap.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/i.exec(lines[i]);
    if (!m) continue;
    const yaml = [];
    if (/^\s*---\s*$/.test(lines[i + 1] || '')) {
      for (let j = i + 2; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) yaml.push(lines[j]);
    }
    out.push({ nested: m[1].length > 0, ok: m[2] === 'ok', title: m[3], directive: m[4] ? m[4].toUpperCase() : null, yaml: yaml.join('\n') });
  }
  return out;
}

test('c6 lifetime: an aborted c6 parent starts no later subtest and mutates no shared env/hint (real fixture, real cancellation)', { timeout: 50000 }, async (t) => {
  const run = await runFixture(t.signal);
  const tap = String(run.stdout);
  // Raw child evidence first, line-prefixed so no child TAP line can be read as a result of this file.
  console.log(`# LIFETIME_CHILD ${JSON.stringify({ focus: FOCUS, bound_ms: CHILD_BOUND_MS, code: run.code, killed: run.killed, signal: run.signal,
    stdout_bytes: tap.length, stderr_bytes: String(run.stderr).length })}`);
  for (const line of `${tap}\n${run.stderr}`.split(/\r?\n/)) console.log(`#| ${line}`);

  const all = results(tap);
  const find = (title, nested) => all.find(r => r.title === title && r.nested === nested);
  assert.equal(run.killed, false, 'PRECONDITION: the child fixture run ended within its own bound (a killed child is a FAIL)');
  assert.equal(run.signal, null, 'PRECONDITION: the child fixture run was not ended by a signal');
  assert.equal(run.code, 1, `PRECONDITION: the faulted fixture run fails (exit 1), got ${JSON.stringify(run.code)}`);
  // Deliberate focus: only c6 cases execute; every other case is excluded by the name pattern (not run, not a pass).
  assert.deepEqual(all.filter(r => r.directive !== 'SKIP' && !r.title.startsWith('c6')).map(r => r.title), [],
    'PRECONDITION: the focused probe executed only c6 cases');
  const parent = find(PARENT, false);
  assert.ok(parent && !parent.ok, 'PRECONDITION: the c6 parent is reported not ok');
  assert.match(parent.yaml, /test timed out after 10000ms/, 'PRECONDITION: the c6 parent failed on its own unchanged 10 000 ms deadline');
  const c61 = find(C61, true);
  assert.ok(c61 && !c61.ok, 'PRECONDITION: c6-1 is reported not ok under its parent');
  assert.match(c61.yaml, /test did not finish before its parent and was cancelled/, 'PRECONDITION: c6-1 was cancelled by its parent (real node:test cancellation)');

  assert.deepEqual(all.filter(r => r.title === C62).map(r => (r.ok ? 'ok' : 'not ok')), [],
    'REGRESSION: no c6-2 result: no subtest starts after its parent was aborted');
  assert.equal(tap.includes(C62), false, 'REGRESSION: c6-2 never appears (not started, not re-parented to the root)');
  assert.equal(tap.includes('"case":"modal"'), false, 'REGRESSION: the c6-2 body (env/hint mutation + modal /inject) did not run');
  assert.equal(tap.split(GUARD_LINE).length - 1, 1, 'REGRESSION: the ownership guard stopped the aborted parent exactly once');
  assert.deepEqual(all.filter(r => !r.nested && !r.ok).map(r => r.title), [PARENT],
    'REGRESSION: the c6 parent timeout is the only top-level failure (retained, not swallowed, nothing added)');
  const fanout = find(FANOUT, false);
  assert.ok(fanout && fanout.ok && !fanout.directive, 'REGRESSION: c6 fanout still runs and passes after the aborted parent');
  for (const title of FANOUT_CHILDREN) {
    const r = find(title, true);
    assert.ok(r && r.ok && !r.directive, `REGRESSION: ${title.slice(0, 4)} ran and passed (self-contained under the focus)`);
  }

  // Cancellation diagnostics: phase durations and numeric counters only (no id, path, token or body).
  const m = /^# C6_DIAG (.*)$/m.exec(tap);
  assert.ok(m, 'REGRESSION: c6-1 reports its phase diagnostics when cancelled');
  const diag = JSON.parse(m[1]);
  assert.equal(diag.case, 'upstream', 'REGRESSION: diagnostic names its case');
  assert.equal(diag.aborted, true, 'REGRESSION: diagnostic marks the cancellation');
  for (const [key, value] of Object.entries(diag)) {
    if (key === 'case' || key === 'aborted') continue;
    for (const v of value !== null && typeof value === 'object' ? Object.values(value) : [value]) {
      assert.ok(Number.isFinite(v), `REGRESSION: diagnostic ${key} is numeric only (${JSON.stringify(value)})`);
    }
  }
  assert.equal(Object.hasOwn(diag, 'route_ms'), false, 'REGRESSION: the held c6-1 never reached the /inject route');
  assert.ok(diag.elapsed_ms >= 5000, `REGRESSION: elapsed_ms measures the held time up to cancellation (${diag.elapsed_ms})`);
});
