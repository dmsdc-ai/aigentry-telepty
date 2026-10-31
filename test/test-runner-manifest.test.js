'use strict';

// telepty #879 — contract for scripts/run-tests.mjs and its inventory scripts/test-suites.json.
//
// Native Windows never ran the suite: npm hands a package script to cmd.exe, which refuses lines
// above 8191 characters, and the expanded `node --test <every file>` script was 8709 (job
// 124456824499, "The command line is too long."). The scripts now call a short runner that passes
// the same node argv as an array to process.execPath. This file pins what that must keep true:
//   * the inventory registers every test file on disk exactly once, with the pre-migration preload
//     and flags, and no package script is long enough to overflow cmd.exe;
//   * the runner's DIRECT child receives exactly [--require preload..., flags..., files...] from the
//     same node binary, and that child's real exit code or signal, recorded by the child itself, is
//     the runner's outcome;
//   * unknown modes and broken inventories are refused before anything is spawned;
//   * the Windows diagnostic enumerates the same inventory, and its preload lets a process exit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');
const DIAGNOSTIC = path.join(ROOT, 'scripts', 'windows-ci-diagnostic.mjs');
const FIXTURE_SUITES = path.join(ROOT, 'test', 'fixtures', 'test-runner', 'suites.json');
const suites = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'test-suites.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(FIXTURE_SUITES, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const THIS_FILE = 'test/test-runner-manifest.test.js';
const CMD_EXE_LIMIT = 8191;
const CREATE_PROCESS_LIMIT = 32767;
const HANG_BOUND_MS = 60_000; // fails a hung fixture run instead of blocking; not a test budget

const modeFiles = (mode) => suites.modes[mode].files;

function testFilesOnDisk(dir = 'test') {
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') found.push(...testFilesOnDisk(rel));
    } else if (/\.test\.(c|m)?js$/.test(entry.name)) {
      found.push(rel);
    }
  }
  return found;
}

// The runner is started like npm starts it, minus the outer test runner's context: a
// NODE_TEST_CONTEXT inherited from this file would change how the nested node --test behaves.
function runRunner(t, args, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-run-tests-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const recordPath = path.join(dir, 'records.ndjson');
  const env = { ...process.env, TEST_RUNNER_RECORD: recordPath, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: ROOT, env, encoding: 'utf8', shell: false, timeout: HANG_BOUND_MS, killSignal: 'SIGKILL',
  });
  assert.ifError(result.error);
  const records = fs.existsSync(recordPath)
    ? fs.readFileSync(recordPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  return { result, records };
}

function directChild(result, records) {
  const starts = records.filter((r) => r.event === 'start');
  assert.equal(starts.length, 1, 'exactly one direct child');
  assert.equal(starts[0].ppid, result.pid, 'the recorded process is the runner\'s DIRECT child (no shell between)');
  return { start: starts[0], exits: records.filter((r) => r.event === 'exit' && r.pid === starts[0].pid) };
}

test('inventory registers every test file on disk exactly once, and every entry exists', () => {
  const files = modeFiles('test');
  assert.equal(new Set(files).size, files.length, 'no duplicate in test');
  assert.deepEqual([...files].sort(), testFilesOnDisk().sort(), 'test == every test/**/*.test.{js,cjs,mjs} outside fixtures');
  for (const mode of Object.keys(suites.modes)) {
    const list = modeFiles(mode);
    assert.equal(new Set(list).size, list.length, `no duplicate in ${mode}`);
    for (const file of list) {
      assert.match(file, /^test\/[^\s]+\.test\.(c|m)?js$/, `${mode}: ${file}`);
      assert.ok(!file.split('/').includes('..'), `${mode}: ${file} stays under test/`);
      assert.ok(fs.statSync(path.join(ROOT, file)).isFile(), `${mode}: ${file} exists`);
    }
  }
});

test('mode memberships keep their pre-migration relationships', () => {
  assert.deepEqual(Object.keys(suites.modes), ['test', 'test:watch', 'test:ci', 'test:ci:pty']);
  const all = new Set(modeFiles('test'));
  const pty = modeFiles('test:ci:pty');
  assert.deepEqual(pty, ['test/bridge-preconnect-output-768.test.js'], 'the PTY suite stays serialized on its own');
  const ci = new Set(modeFiles('test:ci'));
  assert.deepEqual([...ci].sort(), [...all].filter((f) => !pty.includes(f)).sort(), 'test:ci == test minus the PTY suite');
  for (const file of modeFiles('test:watch')) assert.ok(all.has(file), `test:watch ⊂ test: ${file}`);
  for (const mode of ['test', 'test:watch', 'test:ci']) assert.ok(modeFiles(mode).includes(THIS_FILE), `${THIS_FILE} registered in ${mode}`);
});

test('preload and node flags are the pre-migration options, with no timeout, exit or concurrency override', () => {
  assert.equal(suites.schema, 'telepty-test-suites/v1');
  assert.deepEqual(suites.preload, ['./test-support/setup-env.js']);
  assert.deepEqual(suites.modes.test.flags, ['--test']);
  assert.deepEqual(suites.modes['test:watch'].flags, ['--test', '--watch']);
  assert.deepEqual(suites.modes['test:ci'].flags, ['--test', '--test-reporter=spec']);
  assert.deepEqual(suites.modes['test:ci:pty'].flags, ['--test', '--test-reporter=spec']);
});

test('package scripts are short runner calls: no long argument list reaches cmd.exe', () => {
  const gate = ' && git diff --exit-code tests/snippet-protocol/v1/';
  assert.equal(pkg.scripts.test, `node scripts/run-tests.mjs test${gate}`);
  assert.equal(pkg.scripts['test:watch'], 'node scripts/run-tests.mjs test:watch');
  assert.equal(pkg.scripts['test:ci'], `node scripts/run-tests.mjs test:ci${gate}`);
  assert.equal(pkg.scripts['test:ci:pty'], 'node scripts/run-tests.mjs test:ci:pty');
  // Asserted on every platform, so Linux/macOS catch a regression before a Windows job does.
  for (const [name, script] of Object.entries(pkg.scripts)) {
    assert.ok(script.length < CMD_EXE_LIMIT, `${name} is ${script.length} chars (cmd.exe limit ${CMD_EXE_LIMIT})`);
  }
});

test('every mode\'s direct argv fits the Windows CreateProcess limit', () => {
  // Upper bound: each argument quoted and separated (none of these contain quotes).
  const quoted = (arg) => arg.length + 3;
  for (const mode of Object.keys(suites.modes)) {
    const args = [process.execPath, ...suites.preload.flatMap((p) => ['--require', p]), ...suites.modes[mode].flags, ...modeFiles(mode)];
    const length = args.reduce((sum, arg) => sum + quoted(arg), 0);
    assert.ok(length < CREATE_PROCESS_LIMIT, `${mode}: ~${length} chars (limit ${CREATE_PROCESS_LIMIT})`);
  }
});

test('runner forwards the exact preload, flags and files to its direct child, from the same node binary', (t) => {
  const { result, records } = runRunner(t, ['--suites', FIXTURE_SUITES, 'pass']);
  const { start, exits } = directChild(result, records);
  assert.equal(start.execPath, process.execPath);
  assert.deepEqual(start.execArgv, [...fixtures.preload.flatMap((p) => ['--require', p]), ...fixtures.modes.pass.flags]);
  assert.deepEqual(start.argv, fixtures.modes.pass.files, 'files in inventory order, nothing added');
  assert.deepEqual(exits.map((e) => e.code), [0], 'the direct child itself exited 0');
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

test('a failing suite: the runner exits with the code its direct child actually exited with', (t) => {
  const { result, records } = runRunner(t, ['--suites', FIXTURE_SUITES, 'fail']);
  const { exits } = directChild(result, records);
  assert.equal(exits.length, 1);
  assert.notEqual(exits[0].code, 0, 'the node --test parent observed a failure');
  assert.equal(result.signal, null);
  assert.equal(result.status, exits[0].code);
});

test('an arbitrary direct-child exit code is propagated unchanged', (t) => {
  const { result, records } = runRunner(t, ['--suites', FIXTURE_SUITES, 'pass'], { TEST_RUNNER_DIRECT_EXIT: '7' });
  const { exits } = directChild(result, records);
  assert.deepEqual(exits.map((e) => e.code), [7], 'the direct child itself exited 7');
  assert.equal(result.signal, null);
  assert.equal(result.status, 7);
});

test('a direct child ended by a signal ends the runner with the same signal', {
  skip: process.platform === 'win32' ? 'win32 has no POSIX signal termination to observe' : false,
}, (t) => {
  const { result, records } = runRunner(t, ['--suites', FIXTURE_SUITES, 'pass'], { TEST_RUNNER_DIRECT_SIGNAL: 'SIGTERM' });
  const { start, exits } = directChild(result, records);
  assert.ok(records.some((r) => r.event === 'signal' && r.pid === start.pid), 'the direct child signalled itself');
  assert.deepEqual(exits, [], 'the direct child never exited normally');
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
});

test('unknown modes, bad arguments and broken inventories exit 2 before anything is spawned', (t) => {
  const cases = [
    ['no-such-mode'],
    ['--suites', FIXTURE_SUITES, 'no-such-mode'],
    ['--suites', FIXTURE_SUITES, '__proto__'],
    ['--suites', FIXTURE_SUITES, 'constructor'],
    ['--suites', FIXTURE_SUITES, 'duplicate'],
    ['--suites', FIXTURE_SUITES, 'missing'],
    ['--suites', FIXTURE_SUITES],
    ['--suites', FIXTURE_SUITES, 'pass', 'extra'],
    ['--suites', path.join(ROOT, 'test', 'fixtures', 'test-runner', 'absent.json'), 'pass'],
  ];
  for (const args of cases) {
    const { result, records } = runRunner(t, args);
    assert.equal(result.signal, null, JSON.stringify(args));
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.match(result.stderr, /^run-tests: /, JSON.stringify(args));
    assert.deepEqual(records, [], `${JSON.stringify(args)}: nothing spawned`);
  }
});

test('windows-ci-diagnostic --list enumerates the runner inventory, never the wrapper', () => {
  const result = spawnSync(process.execPath, [DIAGNOSTIC, '--list'], {
    cwd: ROOT, encoding: 'utf8', shell: false, timeout: HANG_BOUND_MS, killSignal: 'SIGKILL',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.requires, suites.preload);
  assert.deepEqual(listed.main, modeFiles('test:ci'));
  assert.deepEqual(listed.pty, modeFiles('test:ci:pty'));
  assert.ok(!listed.main.includes('scripts/run-tests.mjs') && !listed.main.includes('test:ci'));
});

test('windows-ci-diagnostic preload logs beforeExit once and lets the process exit', async (t) => {
  // Run 41173717097: a persistent beforeExit listener whose stderr write is asynchronous on a
  // Windows pipe re-armed the loop forever (307,169 lines, SIGKILLed at the 60 s deadline). This
  // discriminates where that write is asynchronous (Windows); elsewhere it holds either way.
  const { preloadSource } = await import(pathToFileURL(DIAGNOSTIC).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-diag-preload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'preload-879-handles.cjs');
  fs.writeFileSync(preload, preloadSource(15_000));
  const result = spawnSync(process.execPath, ['--require', preload, '-e', ''], {
    encoding: 'utf8', shell: false, timeout: HANG_BOUND_MS, killSignal: 'SIGKILL',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.match(/beforeExit code=0/g)?.length, 1, result.stderr.slice(0, 2000));
  assert.match(result.stderr, /exit code=0/);
});
