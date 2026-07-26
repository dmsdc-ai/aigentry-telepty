'use strict';

// #752 — an ad-hoc `telepty allow --id P claude` session accepts an inject, reports
// success, and delivers NOTHING. The body sits `pending` in the bridge's own FileMailbox
// for the life of the session.
//
// Written RED against c5a663b (0.6.18 + #760).
//
// ── Field repro, reproduced hermetically (scratchpad/repro-752-real.js) ───────────────
//   pane:  telepty allow --id P claude          (harness daemon, PORT=0 + mkdtemp HOME)
//   probe: telepty inject --submit P "…"
//   CLI:   ✅ Context injected successfully  /  ✅ Submitted via pty_cr [forced]
//   pane:  +0 bytes for 35s, claude never sees the message
//   ~/.aigentry/mailbox/bridge/P/state.jsonl:
//       {"msg_id":"P:…:1","state":"pending"}      ← the body
//       {"msg_id":"P:…:2","state":"pending"}      ← the CR queued behind it
//   daemon log: no [READY] line, ever — the bridge never sent its `ready` frame.
//
// ── Root cause ────────────────────────────────────────────────────────────────────────
// `telepty allow` gates inject delivery on a readiness signal (cli.js observePromptReady →
// registry.detectOutput). For a KNOWN AI CLI that signal is ENTRIES.claude.detect, which
// requires an EMPTY caret row: /^([❯>])\s*$/. Real Claude Code 2.1.220 paints a placeholder
// hint INSIDE the empty composer —
//     ❯ Try"refactordaemon.test.js"
// — so the caret row is never empty and detect() answers `found:false` for the entire life
// of a fresh session. With promptReady false, isIdle() is false, every inject is queued in
// the bridge mailbox, and scheduleIdleFlush() deliberately withholds its 5s safety flush
// from a known AI CLI that has never been ready (`!knownAiCli || firstReadyObserved`) — the
// same never-true flag. Nothing ever drains the queue.
//
// The daemon cannot see any of this: writeDataToSession's contract for a wrapped session is
// "handed to the owner WebSocket", so /inject and /submit both answer success.
//
// Why production launcher sessions were unaffected: their `command` is a wrapper .sh path,
// so isKnownAiCli is false, the bridge uses the permissive legacy prompt regex AND arms the
// 5s fallback flush. Naming the CLI directly is what turns on the strict gate.
//
// ── The fix material was already in the repo ─────────────────────────────────────────
// #760 measured CLAUDE_COMPOSER_MARKERS against real 2.1.220 PTY bytes precisely because
// they had to survive Ink's differential painting. All three match the capture above. The
// claude entry now decides positionally (last composer marker vs last modal marker), the
// same rule detectSurfaceModal uses, with the legacy empty-caret scan kept as a fallback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

const registry = require('../src/prompt-symbol-registry');
const { startTestDaemon, createSessionId, waitFor, delay } = require('../test-support/daemon-harness');

const projectRoot = path.resolve(__dirname, '..');
const RULE = '─'.repeat(120);

// ── Fixtures: verbatim tails of REAL claude PTY streams, after
//    normalizeOutputForDetection. Nothing hand-written — see the capture paths.

// A LIVE composer, nothing modal about it. /tmp/c752-work/c752-real-82908.raw.bin, last
// 560 normalized chars. Note `❯ Try"refactordaemon.test.js"`: the caret row carries the
// placeholder hint, which is exactly what the empty-caret matcher cannot see past.
const COMPOSER_RING = ' Inject allowed.\n ▐▛███▜▌ClaudeCodev2.1.220\n'
  + '▝▜█████▛▘Fable5withhigheffort·ClaudeMax\n ▘▘▝▝~/projects/aigentry-telepty\n'
  + '⚠Yourloginexpiresin3days ·run/logintorenew\n'
  + RULE + '\n❯ Try"refactordaemon.test.js"\n' + RULE + '\n'
  + '⏸manualmodeon·←foragents●high·/effort\n'
  + 'aigetry-telpty|Fable5 (1M context) | [░░░░░░░░░░░░░░░] 0% 0/1.0M\n'
  + '⏸manualmodeon·←foragents\n';

// First-run onboarding, captured on the same harness with a fresh HOME
// (/tmp/c752-work/c752-real-78631.raw.bin, normalized). A modal owns the screen: NOT ready.
// The glued words are the Ink differential paint again — `Choose the text style` is emitted
// as cursor jumps, so it reaches this predicate as `Choosethetextstyle`.
const ONBOARDING_RING = 'Let\'sgetstarted.\n'
  + 'Choosethetextstylethatlooksbestwithyourterminal\nTochangethislater,run/theme\n'
  + '1.Auto(matchterminal)\n❯2.Darkmode✔\n3.Lightmode\n4.Darkmode(colorblind-friendly)\n';

// The pre-2.1.220 shape the empty-caret matcher was written against (a cmux read-screen
// snapshot of an empty composer). Back-compat guard: it must keep detecting.
const EMPTY_CARET_SCREEN = RULE + '\n❯\n' + RULE + '\n';

test('#752 RED: a real claude LIVE COMPOSER is detected as ready', () => {
  const r = registry.detectOutput('claude', COMPOSER_RING);
  assert.equal(r.found, true,
    'the empty-caret matcher cannot see past the composer placeholder, so `telepty allow` '
    + 'never marks a real claude ready and every inject parks in the bridge mailbox');
});

test('#752: a claude MODAL surface is still NOT ready', () => {
  const r = registry.detectOutput('claude', ONBOARDING_RING);
  assert.equal(r.found, false);
  assert.equal(r.reason, 'claude_modal_ui');
});

test('#752: the composer verdict is POSITIONAL — a modal after a composer wins', () => {
  // The bridge feeds an append-only BYTE STREAM, not a screen snapshot: a composer painted
  // before a modal stays in the tail forever. Later marker wins (the #737 rule).
  assert.equal(registry.detectOutput('claude', COMPOSER_RING + ONBOARDING_RING).found, false);
  assert.equal(registry.detectOutput('claude', ONBOARDING_RING + COMPOSER_RING).found, true);
});

test('#752: the legacy empty-caret screen still detects (back-compat)', () => {
  assert.equal(registry.detectOutput('claude', EMPTY_CARET_SCREEN).found, true);
});

// ── The delivery leg: a real `telepty allow` bridge, end to end ───────────────────────

// A claude-shaped child. It paints the composer ABOVE — placeholder row and all — and
// records every byte it is given. Named `claude` on purpose: the filename is what
// isKnownAiCli reads, and it is the whole difference between this bug and a healthy
// generic-command session.
function writeClaudeStub(dir, rxLog) {
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const RULE = '\\u2500'.repeat(120);
const composer = () => process.stdout.write(
  '\\n' + RULE + '\\n\\u276f Try"refactordaemon.test.js"\\n' + RULE
  + '\\n\\u23f8manualmodeon\\u00b7\\u2190foragents\\n | [\\u2591\\u2591\\u2591] 0% 0/1.0M\\n');
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdout.write('ClaudeCodev2.1.220\\n');
setTimeout(composer, 300);
setInterval(composer, 2000);
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(${JSON.stringify(rxLog)}, chunk);
});
`, 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

let harness;
before(async () => {
  harness = await startTestDaemon({
    env: { AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator orch' }
  });
});
after(async () => {
  if (harness) await harness.stop();
});

test('#752 RED: an ad-hoc `telepty allow claude` session actually receives the inject', async (t) => {
  const sessionId = createSessionId('c752-allow-claude');
  const rxLog = path.join(harness.homeDir, `${sessionId}.rx`);
  fs.writeFileSync(rxLog, '');
  const stub = writeClaudeStub(harness.homeDir, rxLog);

  const bridge = pty.spawn(process.execPath, ['cli.js', 'allow', '--id', sessionId, stub], {
    cwd: projectRoot,
    cols: 120,
    rows: 40,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      // The field probe's environment: an inherited orchestrator session id. `allow`
      // overrides it for the session, but `telepty inject` still claims it as the sender,
      // which is what arms the pending auto-report.
      TELEPTY_SESSION_ID: 'orchestrator',
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
    },
  });
  t.after(() => { try { bridge.kill(); } catch {} });

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return Array.isArray(list.body)
      && list.body.some((s) => s.id === sessionId && s.healthStatus === 'CONNECTED');
  }, { timeoutMs: 8000, description: 'allow bridge owner connected' });

  await delay(1200);   // let the composer paint

  const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: 'c752-body-landed', from: 'orchestrator', reply_to: 'orchestrator' },
  });
  assert.equal(inject.status, 200, JSON.stringify(inject.body));

  await waitFor(() => fs.readFileSync(rxLog, 'utf8').includes('c752-body-landed'), {
    timeoutMs: 10000,
    intervalMs: 200,
    description: 'injected body reaching the wrapped claude PTY',
  }).catch(() => {
    const state = path.join(harness.homeDir, '.aigentry', 'mailbox', 'bridge', sessionId, 'state.jsonl');
    const parked = fs.existsSync(state) ? fs.readFileSync(state, 'utf8').trim() : '(no bridge mailbox)';
    assert.fail('the daemon reported success but the body never reached the PTY; '
      + `bridge mailbox says:\n${parked}`);
  });
});
