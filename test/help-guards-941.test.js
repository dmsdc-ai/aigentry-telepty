'use strict';

// tp941 (gh#79 + gh#61) — `--help` is a QUESTION. Answering it must never be an ACTION.
//
// telepty#51 gated help interception on membership in TRAILING_PAYLOAD_HELP (inject / broadcast /
// multicast / allow) and called it from INSIDE each command branch. Every command outside that
// list therefore executed first and answered the question afterwards:
//
//   • `telepty update --help`  performed the update           (gh#61)
//   • `telepty clean --help`   DELETEd every STALE/DISCONNECTED session (gh#79)
//
// gh#79 records the real cost: `clean --idle --dry-run` was handed to a colleague as a read-only
// diagnostic and destroyed a live registry entry on their machine — because the ghost branch
// never read `dryRun` at all.
//
// The allow-list is the root cause, so the tests that matter here are the ones covering commands
// NOT on any list (`clean`, `delete`) — a fix that only adds two entries fails those.
//
// SAFETY (dispatch §0): every subprocess runs against a PORT=0 harness daemon under a temp HOME,
// or against a dead NON-default endpoint. `update` is only ever reached with
// TELEPTY_UPDATE_COMMAND pointed at a sentinel script and npm_config_prefix under /tmp. The CLI
// under test is always this checkout's own cli.js, never the `telepty` on PATH.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { createSessionId, startTestDaemon, stripAnsi, waitFor } = require('../test-support/daemon-harness');

const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'cli.js');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tp941-help-'));

// Distinctive lines from the GLOBAL usage block — asserting on these proves help was PRINTED
// rather than merely that the command stayed quiet.
const GLOBAL_HELP_UPDATE = /telepty update\s+Update to latest version/;
const GLOBAL_HELP_CLEAN = /telepty clean \[--older-than/;
const GLOBAL_HELP_BANNER = /Connect any terminal to any terminal/;

function runCliSandboxed(cliArgs, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...cliArgs], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        // Dead, NON-default endpoint: even a total regression of help interception cannot reach
        // the live daemon on 3848. A host other than 127.0.0.1 also disables daemon auto-start.
        TELEPTY_HOST: '127.0.0.42',
        TELEPTY_PORT: '9',
        TELEPTY_SKIP_DAEMON_REPAIR: '1',
        // Last line of defence: if runUpdateInstall ever fell through to its real
        // `npm install -g`, it installs into a temp prefix instead of the user's global node.
        npm_config_prefix: tempHome,
        ...extraEnv
      },
      timeout: 20000
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// A sentinel that records whether the update command actually ran. Each caller gets its own file
// so the "did run" control and the "did not run" assertion cannot alias.
function makeUpdateSentinel(name) {
  const sentinel = path.join(tempHome, `${name}.ran`);
  const script = path.join(tempHome, `${name}.js`);
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);
  return { sentinel, command: `"${process.execPath}" "${script}"` };
}

// ── gh#61: `update --help` must not update ────────────────────────────────────

test('control: plain `update` DOES run the configured update command', async () => {
  // Without this, the assertion below could pass because the sentinel is unwritable rather than
  // because the guard held. Fully sandboxed — TELEPTY_UPDATE_COMMAND replaces the real npm call.
  const { sentinel, command } = makeUpdateSentinel('control-update');
  await runCliSandboxed(['update'], { TELEPTY_UPDATE_COMMAND: command });
  assert.equal(fs.existsSync(sentinel), true, 'sentinel never fires — the guard test would be vacuous');
});

test('update --help prints usage and does NOT perform the update', async () => {
  const { sentinel, command } = makeUpdateSentinel('guarded-update');
  const result = await runCliSandboxed(['update', '--help'], { TELEPTY_UPDATE_COMMAND: command });
  assert.equal(fs.existsSync(sentinel), false, '`update --help` executed the update (gh#61)');
  assert.match(stripAnsi(result.stdout), GLOBAL_HELP_UPDATE);
  assert.doesNotMatch(stripAnsi(result.stdout), /Update complete/);
});

// ── the root-cause test: commands on NO allow-list get help, not execution ─────

test('delete <id> --help prints help instead of deleting — `delete` is on no allow-list', async () => {
  const harness = await startTestDaemon();
  try {
    const victim = createSessionId('tp941-delete-help');
    await harness.registerSession(victim);

    const result = await harness.runCli(['delete', victim, '--help']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(stripAnsi(result.stdout), GLOBAL_HELP_BANNER);

    const after = await harness.request('/api/sessions');
    assert.ok(
      after.body.some((session) => session.id === victim),
      '`delete <id> --help` deleted the session — help is still executing commands'
    );
  } finally {
    await harness.stop();
  }
});

test('control: plain `delete <id>` DOES delete', async () => {
  // Proves the fixture above is genuinely deletable, so its survival means the guard held.
  const harness = await startTestDaemon();
  try {
    const victim = createSessionId('tp941-delete-control');
    await harness.registerSession(victim);
    const result = await harness.runCli(['delete', victim]);
    assert.equal(result.code, 0, result.stderr);
    const after = await harness.request('/api/sessions');
    assert.ok(after.body.every((session) => session.id !== victim));
  } finally {
    await harness.stop();
  }
});

// ── gh#79 Guard A: `clean --help` must not clean ──────────────────────────────

test('control: plain `clean` DOES remove a registered ghost session', async () => {
  // A registered session with no owner socket reports DISCONNECTED, which is exactly what
  // clean's ghost sweep targets. Without this control, the two tests below could pass because
  // nothing was ever eligible for removal.
  const harness = await startTestDaemon();
  try {
    const ghost = createSessionId('tp941-clean-control');
    await harness.registerSession(ghost);
    const result = await harness.runCli(['clean']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(stripAnsi(result.stdout), new RegExp(`Removed ghost: ${ghost}`));
    const after = await harness.request('/api/sessions');
    assert.ok(after.body.every((session) => session.id !== ghost));
  } finally {
    await harness.stop();
  }
});

test('clean --help prints usage and deletes nothing (gh#79)', async () => {
  const harness = await startTestDaemon();
  try {
    const ghost = createSessionId('tp941-clean-help');
    await harness.registerSession(ghost);

    const result = await harness.runCli(['clean', '--help']);
    assert.equal(result.code, 0, result.stderr);
    const output = stripAnsi(result.stdout);
    assert.match(output, GLOBAL_HELP_CLEAN);
    assert.doesNotMatch(output, /Removed ghost/);

    const after = await harness.request('/api/sessions');
    assert.ok(
      after.body.some((session) => session.id === ghost),
      '`clean --help` DELETEd a session (gh#79)'
    );
  } finally {
    await harness.stop();
  }
});

// ── gh#79 Guard B: the ghost branch must honour --dry-run ─────────────────────

test('clean --idle --dry-run removes nothing and reports what it would remove (gh#79)', async () => {
  const harness = await startTestDaemon();
  try {
    const ghost = createSessionId('tp941-dry-idle');
    await harness.registerSession(ghost);

    const result = await harness.runCli(['clean', '--idle', '--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    const output = stripAnsi(result.stdout);
    assert.match(output, new RegExp(`Would remove ghost: ${ghost}`));
    assert.doesNotMatch(output, /Removed ghost/);

    const after = await harness.request('/api/sessions');
    assert.ok(
      after.body.some((session) => session.id === ghost),
      '`clean --idle --dry-run` DELETEd a session — the exact incident in gh#79'
    );
  } finally {
    await harness.stop();
  }
});

test('clean --dry-run alone also removes nothing', async () => {
  const harness = await startTestDaemon();
  try {
    const ghost = createSessionId('tp941-dry-bare');
    await harness.registerSession(ghost);

    const result = await harness.runCli(['clean', '--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(stripAnsi(result.stdout), new RegExp(`Would remove ghost: ${ghost}`));

    const after = await harness.request('/api/sessions');
    assert.ok(after.body.some((session) => session.id === ghost));
  } finally {
    await harness.stop();
  }
});

// ── invariants the guard must NOT break ───────────────────────────────────────

test('broadcast -- --help still delivers the literal payload to every session', async () => {
  const harness = await startTestDaemon();
  let bus = null;
  try {
    const target = createSessionId('tp941-broadcast');
    await harness.spawnSession(target);

    bus = await harness.connectBus();
    const events = [];
    bus.on('message', (raw) => {
      try { events.push(JSON.parse(String(raw))); } catch { /* non-JSON frame */ }
    });

    const result = await harness.runCli(['broadcast', '--', '--help']);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(stripAnsi(result.stdout), GLOBAL_HELP_BANNER);
    assert.match(stripAnsi(result.stdout), /broadcasted successfully to 1 active session/);

    // The fan-out bus event carries the prompt verbatim (daemon.js `injection`), so this asserts
    // the literal six characters arrived — not merely that the CLI declined to print usage.
    await waitFor(
      () => events.some((event) => event.type === 'injection'
        && event.content === '--help'
        && (event.session_ids || []).some((entry) => entry.id === target)),
      { timeoutMs: 5000, description: 'literal --help delivered by broadcast' }
    );
  } finally {
    if (bus) bus.close();
    await harness.stop();
  }
});

test('trailing-payload family keeps its own tailored usage, not the global block', async () => {
  // The guard defers to interceptSubcommandHelp for these four rather than pre-empting it.
  for (const [cliArgs, expected] of [
    [['broadcast', '--help'], /Usage: telepty broadcast/],
    [['multicast', '-h'], /Usage: telepty multicast/],
    [['inject', 'some-session', '--help'], /Usage: telepty inject/],
    [['allow', '--help'], /Usage: telepty allow/],
    [['wrap', '-h'], /Usage: telepty allow/]
  ]) {
    const result = await runCliSandboxed(cliArgs);
    assert.equal(result.code, 0, `${cliArgs.join(' ')}: ${result.stderr}`);
    assert.match(stripAnsi(result.stdout), expected, `${cliArgs.join(' ')} lost its tailored usage`);
  }
});

test('init --help keeps its OWN help — the guard defers to commands that render their own', async () => {
  const result = await runCliSandboxed(['init', '--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--print-snippet/);
});

test('--version / -v / version still print the version, not help', async () => {
  const pkg = require('../package.json');
  for (const flag of ['--version', '-v', 'version']) {
    const result = await runCliSandboxed([flag]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(stripAnsi(result.stdout).trim(), pkg.version, `${flag} did not print the version`);
  }
});
