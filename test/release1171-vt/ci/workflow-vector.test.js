'use strict';

// ---------------------------------------------------------------------------
// tt1170aa — CI workflow command-vector and failure-propagation suite
// ---------------------------------------------------------------------------
//
// The controller review found three concrete defects in the prior acceptance workflow. All three
// are invisible to a green run: a wrong command vector, a wrong repository layout, and a lost
// failure. This suite makes each of them a loud, independent test.
//
//   DEFECT-1  the workflow assumed a nested `source/` package; the release branch package is at
//             the REPOSITORY ROOT.
//   DEFECT-2  `run_suite` invokes `"$NODE" "$@"` while every call site ALSO passed `"$NODE"`,
//             producing `node node --test …`.
//   DEFECT-3  `first_failure` was assigned inside a `( cd source … )` subshell, so a real legacy
//             failure died with the subshell and the job exited 0.
//
// SEAM DECLARATION.
//
//   ACTUAL — the shell program under test is EXTRACTED VERBATIM from the committed
//            `.github/workflows/release1171-telepty-acceptance.yml`. It is never retyped here, so
//            this suite cannot drift into asserting a copy that the workflow does not contain.
//            The suite-path globs are expanded by bash against the REAL repository tree, which is
//            what proves the ROOT layout: a `source/`-prefixed path would expand to nothing.
//
//   FAKE   — `$NODE` only. It is replaced by an inert stub that runs no test, opens no port and
//            spawns nothing; it records its argument vector and exits with a scripted code. A
//            real node run could not be made to fail on demand in a chosen suite, which is
//            exactly what DEFECT-3 requires in order to be observable.
//
// Nothing here runs a daemon, listener, WS, PTY or package manager. All writes go to a temporary
// directory. The repository tree is read-only to this suite.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const H = require('../tests/helpers/vt-harness');

const WORKFLOW = path.join(
  H.REPO_ROOT, '.github', 'workflows', 'release1171-telepty-acceptance.yml'
);
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW, 'utf8');

// Every suite the workflow is required to invoke, in order.
const EXPECTED_SUITES = [
  'vt',
  'vt-focused',
  't0',
  // this suite, which CI must run so the three corrected defects stay guarded
  'wf-vector',
  't0-legacy-six',
  'legacy-owner-displaced',
  'legacy-ws-owner-swap',
  'legacy-bridge-pipe',
  'legacy-bridge-levers',
];

// --- extraction -------------------------------------------------------------------------------

/** Pull the `run: |` block of the named step out of the workflow, dedented, verbatim. */
function extractRunBlock(stepName) {
  const lines = WORKFLOW_TEXT.split('\n');
  const stepIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.notStrictEqual(stepIdx, -1, `workflow must contain a step named ${stepName}`);

  const runIdx = lines.findIndex((l, i) => i > stepIdx && /^\s*run: \|\s*$/.test(l));
  assert.notStrictEqual(runIdx, -1, `step ${stepName} must carry a literal block \`run: |\``);

  const bodyIndent = lines[runIdx].search(/\S/) + 2;
  const body = [];
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    if (line.search(/\S/) < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  const text = body.join('\n').replace(/\s+$/, '');
  assert.ok(text.length > 0, 'the extracted run block must not be empty');
  return text;
}

const RUN_BLOCK = extractRunBlock('Run retained synthetic suites');

// --- inert stub harness -----------------------------------------------------------------------

/**
 * Execute the extracted workflow program with an inert stub standing in for node.
 *
 * `failOn` names the suite whose stub invocation exits nonzero (matched on the `.tap` target the
 * workflow redirects to, so the stub never needs to know the suite list).
 */
function runWorkflowProgram({ failOn = null, failCode = 7 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt1170aa-wf-'));
  const argvLog = path.join(dir, 'argv.log');

  // The inert stub: append the argument vector, then exit with the scripted code. It never
  // interprets its arguments, never reads a test file and never spawns a child.
  const stub = path.join(dir, 'node-stub.sh');
  fs.writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    'if [ -n "${SYNTH_FAIL_MATCH:-}" ]; then',
    '  case "$*" in',
    '    *"$SYNTH_FAIL_MATCH"*) exit "${SYNTH_FAIL_CODE:-7}" ;;',
    '  esac',
    'fi',
    'exit 0',
  ].join('\n'));
  fs.chmodSync(stub, 0o755);

  const script = path.join(dir, 'suites.sh');
  fs.writeFileSync(script, RUN_BLOCK);

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE: stub,
    GITHUB_WORKSPACE: dir,
    // The workflow's own env block, with the same values CI supplies.
    NODE_PATH: path.join(H.REPO_ROOT, 'node_modules'),
    TELEPTY_DEPENDENCY_ROOT: path.join(H.REPO_ROOT, 'node_modules'),
    VT_SOURCE_ROOT: H.REPO_ROOT,
  };
  if (failOn) {
    // The workflow redirects each suite to `<name>.tap`; the stub sees that only via its own
    // argument vector, so match on the suite's distinguishing test path instead.
    env.SYNTH_FAIL_MATCH = failOn;
    env.SYNTH_FAIL_CODE = String(failCode);
  }

  // cwd is the REAL repository root: the globs in the workflow must expand against it.
  const proc = spawnSync('bash', [script], {
    cwd: H.REPO_ROOT, env, encoding: 'utf8', timeout: 60000,
  });

  const artifactDir = path.join(dir, 'artifacts', 'release1171-telepty');
  const readArtifacts = () => (fs.existsSync(artifactDir)
    ? fs.readdirSync(artifactDir).sort()
    : []);
  const exitFor = (name) => {
    const p = path.join(artifactDir, `${name}.exit`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
  };
  const argv = fs.existsSync(argvLog)
    ? fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean)
    : [];

  return {
    status: proc.status, stdout: proc.stdout, stderr: proc.stderr, dir, artifactDir,
    artifacts: readArtifacts(), exitFor, argv,
  };
}

// --- DEFECT-2: the command vector ---------------------------------------------------------------

test('WF-VECTOR: every suite is invoked as `node --test …`, never `node node --test …`', () => {
  const r = runWorkflowProgram();
  assert.strictEqual(r.argv.length, EXPECTED_SUITES.length,
    `expected one node invocation per suite; got ${r.argv.length}: ${JSON.stringify(r.argv)}`);

  for (const line of r.argv) {
    const first = line.trim().split(/\s+/)[0];
    assert.ok(first === '--test' || first === '--require',
      `the first argument passed to node must be a node flag, not a second copy of the `
      + `interpreter (DEFECT-2). Got: ${JSON.stringify(line)}`);
    assert.doesNotMatch(line, /(^|\s)node(\s|$)/,
      `no argument may be the bare word "node" (DEFECT-2). Got: ${JSON.stringify(line)}`);
  }
});

test('WF-VECTOR: run_suite supplies the interpreter exactly once', () => {
  // The function invokes "$NODE"; therefore no call site may also pass it.
  const callSites = RUN_BLOCK.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('run_suite ') && !l.startsWith('run_suite()'));
  assert.strictEqual(callSites.length, EXPECTED_SUITES.length,
    `expected ${EXPECTED_SUITES.length} run_suite call sites; got ${callSites.length}`);
  for (const site of callSites) {
    assert.doesNotMatch(site, /"\$NODE"/,
      `run_suite already invokes "$NODE"; the call site must not pass it again (DEFECT-2). `
      + `Got: ${JSON.stringify(site)}`);
  }
  assert.match(RUN_BLOCK, /run_suite\(\)\s*\{[\s\S]*?"\$NODE"\s+"\$@"/,
    'run_suite itself must invoke "$NODE" "$@"');
});

// --- DEFECT-1: the ROOT layout -------------------------------------------------------------------

test('WF-LAYOUT: the suite globs expand against the repository ROOT', () => {
  const r = runWorkflowProgram();
  const all = r.argv.join('\n');

  // A glob that matched nothing would survive literally; a real expansion names real files.
  assert.match(all, /test\/release1171-vt\/tests\/vt-[a-z-]+\.test\.js/,
    'the VT glob must expand to real files at the ROOT (DEFECT-1)');
  assert.ok(!all.includes('*'),
    `no glob may survive unexpanded — that means the path does not exist (DEFECT-1): `
    + `${JSON.stringify(r.argv)}`);
  assert.ok(!/(^|\s|\/)source\//.test(all),
    `no invoked path may contain a "source/" segment; the package is at the ROOT (DEFECT-1): `
    + `${JSON.stringify(r.argv)}`);
});

test('WF-LAYOUT: the workflow never changes directory into a nested package', () => {
  assert.doesNotMatch(RUN_BLOCK, /^\s*cd\s+source\s*$/m,
    'there is no `source/` directory to cd into (DEFECT-1)');
  assert.doesNotMatch(WORKFLOW_TEXT, /working-directory:\s*source/,
    'no step may set working-directory: source (DEFECT-1)');
  assert.match(WORKFLOW_TEXT, /cache-dependency-path:\s*package-lock\.json/,
    'the npm cache must key off the ROOT package-lock.json (DEFECT-1)');
});

test('WF-LAYOUT: the ROOT really holds the package and every invoked suite file', () => {
  for (const rel of ['package.json', 'package-lock.json', 'test-support/setup-env.js']) {
    assert.ok(fs.existsSync(path.join(H.REPO_ROOT, rel)), `${rel} must exist at the ROOT`);
  }
  assert.ok(!fs.existsSync(path.join(H.REPO_ROOT, 'source')),
    'there must be no `source/` sibling in the release-branch layout');
});

// --- DEFECT-3: failure propagation ----------------------------------------------------------------

test('WF-FAIL: a clean run exits 0 and records a TAP and an exit file per suite', () => {
  const r = runWorkflowProgram();
  assert.strictEqual(r.status, 0, `clean run must exit 0; stderr: ${r.stderr}`);
  for (const name of EXPECTED_SUITES) {
    assert.ok(r.artifacts.includes(`${name}.tap`), `${name}.tap must be captured`);
    assert.ok(r.artifacts.includes(`${name}.exit`), `${name}.exit must be captured`);
    assert.strictEqual(r.exitFor(name), '0', `${name} must record exit 0`);
  }
  assert.strictEqual(r.artifacts.length, EXPECTED_SUITES.length * 2,
    `exactly one TAP and one exit file per suite: ${JSON.stringify(r.artifacts)}`);
});

test('WF-FAIL: THE DEFECT-3 REGRESSION — the last legacy suite failing after every earlier '
   + 'suite passed still fails the job', () => {
  // This is the exact shape the subshell used to swallow: four suites pass, then a suite that
  // the old workflow ran inside `( cd source … )` fails. `first_failure` was set in the
  // subshell, lost on its exit, and the job reported success.
  const r = runWorkflowProgram({ failOn: 'bridge-output-pipe-732-levers.test.js', failCode: 9 });
  assert.strictEqual(r.exitFor('legacy-bridge-levers'), '9',
    'the failing suite must record its own nonzero exit');
  assert.strictEqual(r.exitFor('vt'), '0', 'the earlier suites must still have passed');
  assert.strictEqual(r.exitFor('t0'), '0', 'the earlier suites must still have passed');
  assert.notStrictEqual(r.status, 0,
    'a later legacy failure after earlier passes MUST fail the job (DEFECT-3)');
  assert.strictEqual(r.status, 9,
    'the job exit code must be the failing suite\'s own code, not a laundered 0 (DEFECT-3)');
});

test('WF-FAIL: a failure in the six-suite regression split fails the job', () => {
  // t0-legacy-six also ran inside the old subshell.
  const r = runWorkflowProgram({ failOn: 'session-credentials.test.js', failCode: 3 });
  assert.strictEqual(r.exitFor('t0-legacy-six'), '3');
  assert.strictEqual(r.status, 3, 'a six-suite regression failure must fail the job (DEFECT-3)');
});

test('WF-FAIL: an early failure fails the job AND every later suite still runs', () => {
  const r = runWorkflowProgram({ failOn: 'conditional-admission.test.js', failCode: 4 });
  assert.strictEqual(r.exitFor('t0'), '4');
  assert.strictEqual(r.status, 4, 'the job must report the first failure');
  // `set +e` plus `run_suite`'s `return 0` must keep the run going, so diagnostics are complete.
  for (const name of EXPECTED_SUITES) {
    assert.ok(r.artifacts.includes(`${name}.tap`),
      `${name} must still have run after an earlier failure — diagnostics must be complete`);
  }
  assert.strictEqual(r.exitFor('legacy-bridge-levers'), '0',
    'suites after the failure still execute and record their own exit');
});

test('WF-FAIL: first_failure is assigned in the top-level shell, never inside a subshell', () => {
  const body = RUN_BLOCK.split('\n');
  const assignIdx = body.findIndex((l) => /^\s*first_failure="\$rc"/.test(l)
    || /first_failure="\$rc"/.test(l));
  assert.notStrictEqual(assignIdx, -1, 'first_failure must be assigned from rc');
  // No parenthesised subshell may wrap any run_suite call.
  assert.doesNotMatch(RUN_BLOCK, /^\s*\(\s*$/m,
    'no run_suite call may be wrapped in a ( … ) subshell — assignments would be lost (DEFECT-3)');
  assert.match(RUN_BLOCK, /exit\s+"\$\{first_failure:-0\}"/,
    'the job must exit with first_failure');
});

// --- CI contract ---------------------------------------------------------------------------------

test('WF-CI: triggers are the PR branch and manual dispatch, with no host secrets', () => {
  assert.match(WORKFLOW_TEXT, /^on:\n(?:\s+\w[\w-]*:.*\n?)+/m, 'workflow declares triggers');
  assert.match(WORKFLOW_TEXT, /^\s{2}pull_request:/m,
    'the suite must run on this PR branch (pull_request)');
  assert.match(WORKFLOW_TEXT, /^\s{2}workflow_dispatch:/m,
    'manual dispatch must remain available');
  // Checked against the workflow's CODE, not its prose: a comment may legitimately say the word
  // "secrets", but no executable line may reference one.
  const code = WORKFLOW_TEXT.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(!code.includes('secrets.'),
    'no host secret may be referenced by this workflow');
  assert.doesNotMatch(code, /\$\{\{\s*secrets\./,
    'no step may interpolate a secret');
});

test('WF-CI: Ubuntu and macOS on locked Node 20', () => {
  assert.match(WORKFLOW_TEXT, /os:\s*\[ubuntu-latest,\s*macos-latest\]/, 'both runners');
  assert.match(WORKFLOW_TEXT, /node-version:\s*20/, 'Node 20');
  assert.match(WORKFLOW_TEXT, /run:\s*npm ci/, 'locked install');
  assert.ok(!/npm (install|i)\s/.test(WORKFLOW_TEXT), 'never an unlocked install');
});

test('WF-CI: diagnostics upload unconditionally and fail loudly when absent', () => {
  assert.match(WORKFLOW_TEXT, /if:\s*always\(\)/, 'diagnostics upload on failure too');
  assert.match(WORKFLOW_TEXT, /if-no-files-found:\s*error/,
    'a missing artifact set must fail rather than pass quietly');
});

test('WF-CI: the existing install workflow is untouched and still present', () => {
  const existing = path.join(H.REPO_ROOT, '.github', 'workflows', 'test-install.yml');
  assert.ok(fs.existsSync(existing), 'the pre-existing CI workflow must remain');
});
