'use strict';

// 0.4.5 release bundle — postinstall hook (#469), daemon restart re-probe
// (#470), force bypass order (#471). All three failure modes were observed in
// production on 2026-05-26; this suite locks each fix against regression.

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createSessionId, startTestDaemon, waitFor } = require('../test-support/daemon-harness');

const projectRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(projectRoot, 'package.json'));

// ---------------------------------------------------------------------------
// #471 (Bug #C) — force bypass order vs bootstrap gate
// ---------------------------------------------------------------------------

let harness;

beforeEach(async () => {
  harness = await startTestDaemon();
});

afterEach(async () => {
  if (harness) await harness.stop();
  harness = null;
});

test('#471: POST /submit with force:true bypasses the bootstrap gate', async () => {
  const sessionId = createSessionId('force-bypass');
  // Register a gated AI-CLI wrapped session with no WS owner: the
  // bootstrap gate is hot (bootstrapReady stays false) until something
  // flips it. Without the fix, force:true would still be enqueued and
  // 504-timeout on the bootstrap queue.
  const reg = await harness.registerSession(sessionId, { command: 'claude' });
  assert.equal(reg.status, 201);

  const forced = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: 'POST',
    body: { force: true, gate_timeout_ms: 500 }
  });

  // Critical assertion: the force-bypass code path ran (forced=true in
  // body). The handler may return 200 or 503 depending on whether any
  // terminalLevelSubmit strategy succeeded — in test (no kitty/cmux/pty),
  // 503 is expected. The bug-fix invariant is that we are NOT 504 with
  // bootstrap_queued.
  assert.notEqual(forced.status, 504, `expected non-504, got ${forced.status} body=${JSON.stringify(forced.body)}`);
  assert.equal(forced.body && forced.body.forced, true, `expected forced:true, got ${JSON.stringify(forced.body)}`);
  assert.notEqual(forced.body && forced.body.bootstrap_queued, true);
});

test('#471: POST /submit without force still hits the bootstrap gate (regression guard)', async () => {
  const sessionId = createSessionId('gate-active');
  const reg = await harness.registerSession(sessionId, { command: 'claude' });
  assert.equal(reg.status, 201);

  const gated = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: 'POST',
    body: { gate_timeout_ms: 500 }
  });

  // Default (no force): the gate must still fire and 504 with
  // bootstrap_queued — the #C fix must not regress the gated path.
  assert.equal(gated.status, 504);
  assert.equal(gated.body && gated.body.bootstrap_queued, true);
});

// ---------------------------------------------------------------------------
// #470 (Bug #B) — daemon restart re-probes existing sessions
// ---------------------------------------------------------------------------

test('#470: daemon startup marks restored sessions with live ownerPid as ready', async () => {
  // Stop the harness daemon so we can pre-seed the persist file before a
  // fresh boot.
  const homeDir = harness.homeDir;
  await harness.stop();
  harness = null;

  const persistDir = path.join(homeDir, '.config', 'aigentry-telepty');
  fs.mkdirSync(persistDir, { recursive: true });
  const persistPath = path.join(persistDir, 'sessions.json');

  const restoredId = createSessionId('restored');
  // ownerPid = this test process: guaranteed alive for the duration of the
  // assertion, so the new daemon must treat the session as a survivor.
  fs.writeFileSync(persistPath, JSON.stringify({
    [restoredId]: {
      id: restoredId,
      type: 'wrapped',
      command: 'claude',
      cwd: projectRoot,
      backend: 'kitty',
      cmuxWorkspaceId: null,
      cmuxSurfaceId: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ownerPid: process.pid,
      ptyPid: null
    }
  }));

  harness = await startTestDaemon({ env: { HOME: homeDir } });

  // Eager-probe runs from server.listen callback; readiness flips
  // asynchronously. Bound to a few seconds.
  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    if (list.status !== 200 || !Array.isArray(list.body)) return false;
    const found = list.body.find((s) => s.id === restoredId);
    return found && found.ready === true ? found : false;
  }, { description: 'restored session flips to ready', timeoutMs: 6000 });
});

test('#470: restored session with dead ownerPid stays unready', async () => {
  const homeDir = harness.homeDir;
  await harness.stop();
  harness = null;

  const persistDir = path.join(homeDir, '.config', 'aigentry-telepty');
  fs.mkdirSync(persistDir, { recursive: true });
  const persistPath = path.join(persistDir, 'sessions.json');

  const restoredId = createSessionId('dead-owner');
  // PID 2^31-1 is guaranteed-unused on every platform we ship to (max
  // PID on linux ≤ 4194304, macOS ≤ 99999, Windows DWORDs allocated
  // sparsely). isProcessRunning() returns false here.
  fs.writeFileSync(persistPath, JSON.stringify({
    [restoredId]: {
      id: restoredId,
      type: 'wrapped',
      command: 'claude',
      cwd: projectRoot,
      backend: 'kitty',
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ownerPid: 2147483646,
      ptyPid: null
    }
  }));

  harness = await startTestDaemon({ env: { HOME: homeDir } });

  // Give the eager-probe a generous window to run; it must NOT mark a
  // dead-owner session ready.
  await new Promise((r) => setTimeout(r, 1500));

  const list = await harness.request('/api/sessions');
  const found = list.body && list.body.find((s) => s.id === restoredId);
  assert.ok(found, 'restored session present');
  assert.equal(found.ready, false, 'dead-owner session must remain unready');
});

// ---------------------------------------------------------------------------
// #469 (Bug #A) — postinstall hook lifecycle wiring
// ---------------------------------------------------------------------------

function runPostinstall(envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'postinstall.js')], {
      cwd: projectRoot,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('#469: postinstall skips when TELEPTY_SKIP_POSTINSTALL=1', async () => {
  const result = await runPostinstall({
    TELEPTY_SKIP_POSTINSTALL: '1',
    npm_config_global: 'true'
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Skipped \(TELEPTY_SKIP_POSTINSTALL=1\)/);
});

test('#469: postinstall skips non-global installs', async () => {
  const result = await runPostinstall({
    TELEPTY_SKIP_POSTINSTALL: '',
    npm_config_global: 'false'
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Skipped \(non-global install\)/);
});

test('#469: postinstall is a no-op when no daemon-state.json exists', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-postinstall-no-state-'));
  try {
    const result = await runPostinstall({
      TELEPTY_SKIP_POSTINSTALL: '',
      npm_config_global: 'true',
      HOME: tmpHome
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No running daemon detected/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('#469: postinstall no-ops when running daemon already matches package version', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-postinstall-match-'));
  try {
    fs.mkdirSync(path.join(tmpHome, '.telepty'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.telepty', 'daemon-state.json'),
      JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 3848, version: pkg.version })
    );

    const result = await runPostinstall({
      TELEPTY_SKIP_POSTINSTALL: '',
      npm_config_global: 'true',
      HOME: tmpHome
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(`already at ${pkg.version.replace(/\./g, '\\.')}`));
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #472 (Bug #D) — codex prompt-symbol matcher tolerates real cmux captures
// ---------------------------------------------------------------------------

const promptSymbolRegistry = require('../src/prompt-symbol-registry');

// Real cmux capture excerpt from a `codex resume` session that had
// permanently stuck at ready:false under the strict ^ › matcher. Contains
// the DECRQM mode-query leak (">4;0m>7u") and cursor-pos-query echoes
// ("0 q") that the prior matcher had no defence against.
const CODEX_REAL_BOOT_SCREEN = [
  '>4;0m>7u╭─────────────────────────────────────────╮│ >_ OpenAI Codex (v0.133.0)              ││                                         │',
  '╭──────────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.133.0)                           │',
  '│                                                      │',
  '│ model:       gpt-5.5 xhigh   fast   /model to change │',
  '│ directory:   ~/projects/cambrian-spore               │',
  '│ permissions: YOLO mode                               │',
  '╰──────────────────────────────────────────────────────╯',
  '',
  "  Tip: Try the Codex App. Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true › Run /review on my current changes gpt-5.5 xhigh fast · ~/projects/cambrian-spore0 q0 q",
].join('\n');

test('#472: codex matcher accepts real cmux boot capture (multi-signal)', () => {
  const result = promptSymbolRegistry.ENTRIES.codex.detect(CODEX_REAL_BOOT_SCREEN);
  assert.equal(result.found, true);
  assert.equal(result.reason, 'codex_multi_signal');
});

test('#472: codex matcher rejects resume-picker phase as not ready', () => {
  // Synthetic but representative — codex resume entry screen has the
  // "Resume a previous session" header and a Filter: row.
  const picker = [
    'Resume a previous session',
    '',
    'Filter: ',
    '> 2026-05-25 10:32  cambrian-spore  gpt-5.5 xhigh',
    '  2026-05-24 18:01  other-session   gpt-5  default',
    '',
    'enter resume   esc start new',
  ].join('\n');
  const result = promptSymbolRegistry.ENTRIES.codex.detect(picker);
  assert.equal(result.found, false);
  assert.equal(result.reason, 'codex_modal_ui');
});

test('#472: codex matcher rejects first-run directory-trust prompt as not ready', () => {
  // Codex on first cwd entry shows a modal trust prompt — Enter there
  // confirms trust, not a user message. Must not be considered ready.
  const trust = [
    '╭─ OpenAI Codex ─╮',
    '│ Do you trust the contents of this directory?',
    '│ 1. Yes, continue',
    '│ 2. No, quit',
    '╰────────────────╯',
  ].join('\n');
  const result = promptSymbolRegistry.ENTRIES.codex.detect(trust);
  assert.equal(result.found, false);
  assert.equal(result.reason, 'codex_modal_ui');
});

test('#472: codex matcher rejects generic press-enter-to-continue modal', () => {
  const press = 'Some banner text\n\nPress enter to continue\n';
  const result = promptSymbolRegistry.ENTRIES.codex.detect(press);
  assert.equal(result.found, false);
  assert.equal(result.reason, 'codex_modal_ui');
});

test('#472: codex matcher returns not-found on blank/unrelated screen', () => {
  assert.equal(promptSymbolRegistry.ENTRIES.codex.detect('').found, false);
  assert.equal(promptSymbolRegistry.ENTRIES.codex.detect('hello world\nno codex here').found, false);
});
