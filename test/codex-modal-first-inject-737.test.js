'use strict';

// #737 — a codex session showing the blocking "Update available … Press enter to
// continue" modal swallows the FIRST inject. The shipped prompt-symbol matcher already
// classifies that screen correctly (`codex_modal_ui`), but NO delivery path consults it,
// so telepty writes the body and then a bare CR straight into the modal.
//
// Written RED against the shipped 0.6.17 daemon, now GREEN and registered in package.json.
//
// ── Measured against real codex 0.144.1 (scratchpad/repro-737-tmux.js — tmux
//    capture-pane as the VT, isolated CODEX_HOME with version.json
//    dismissed_version < latest_version, stub `brew` on PATH) ────────────────────────
//
//   modal  body envelope  text->CR   body reached composer   CR consumed as        codex
//                                                             modal activation      survives
//   ─────  ─────────────  ────────   ─────────────────────   ───────────────────   ────────
//   yes    bracketed      19ms       NO (absorbed)            YES -> option 1       NO (exits)
//   yes    bracketed      515ms      NO (absorbed)            YES -> option 1       NO (exits)
//   yes    bracketed      1523ms     NO (absorbed)            YES -> option 1       NO (exits)
//   yes    raw            18ms       NO (absorbed as keys)    YES -> a Skip option  yes
//   no     bracketed      17ms       yes, submitted           n/a                   yes
//
// The modal's PRE-SELECTED item is "1. Update now (runs `brew upgrade --cask codex`)".
// A bracketed-paste body — which is exactly what telepty writes for codex since #730's
// identity-based capability (src/prompt-symbol-registry.js PASTE_CAPABLE_CLIS) — moves
// no selection, so the following CR ACTIVATES that default: codex shell-executes brew
// and then exits with "Update ran successfully! Please restart Codex." The injected
// message is gone AND the session is dead. 3/3 wrapped runs, deterministic.
//
// ── The bypass, measured on the real daemon (scratchpad/e2e-737.js) ─────────────────
//   variant   cli                                registry verdict   body written   CR written
//   force     inject --submit --submit-force      codex_modal_ui     yes            yes (+4ms)
//   gated     inject --submit                     codex_modal_ui     yes            yes (+7ms)
//   plain     inject                              codex_modal_ui     yes            yes (+525ms)
//   control   inject --submit --submit-force      codex_multi_signal yes            yes (+10ms)
//
// All three paths deliver identically. `codex_modal_ui` is currently decorative on the
// delivery path — see scratchpad/EVIDENCE-737.md for the file:line map.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/prompt-symbol-registry');

// Captured verbatim from a real codex 0.144.1 boot with dismissed_version < latest_version
// (scratchpad/repro-737-tmux.js, `modal-force.screens.txt`, "===== boot =====").
const MODAL_SCREEN = [
  '',
  '  ✨ Update available! 0.144.1 -> 0.145.0',
  '',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `brew upgrade --cask codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  Press enter to continue',
].join('\n');

// Same codex, one version.json field different — boots straight to the composer.
const COMPOSER_SCREEN = [
  '>_ OpenAI Codex (v0.144.1)',
  '› ',
  'gpt-5.5 xhigh fast · /tmp/c737-work',
].join('\n');

// A wrapped codex session as the daemon models one: the rendered surface lives in the
// PTY-fed outputRing, there is no cmux workspace, and bootstrap has long since flipped
// ready (the owner-alive optimistic floor, daemon.js shouldApplyOwnerAliveFloor).
function modalSession(screen = MODAL_SCREEN) {
  return {
    type: 'wrapped',
    command: 'codex',
    backend: 'pty',
    cmuxWorkspaceId: null,
    bootstrapReady: true,
    bootstrapReadyReason: 'owner_alive',
    outputRing: [screen],
    outputRingTotalBytes: screen.length,
    bracketedPasteCapable: true,
  };
}

// Approved remedy: A (hold-and-retry) with C (reject) as its timeout branch, C shipped
// first. The tests below assert only "not lost" against this set, so neither stage of the
// rollout rewrites them; SHIPPED_REMEDY pins which one is the current default.
//   hold      — park the body until the surface leaves the modal, then deliver   (A)
//   reject    — refuse the inject with an actionable error (caller re-injects)   (C)
//   dismiss   — considered and rejected: a bare Enter IS the destructive key here
const ACCEPTED_REMEDIES = new Set(['hold', 'dismiss', 'reject']);
const SHIPPED_REMEDY = 'hold';
const REMEDY = process.env.TELEPTY_MODAL_REMEDY || null;

// ── GREEN anchors: the detection itself already works. These must never regress. ──

test('#737 anchor: the real update-modal screen classifies as codex_modal_ui', () => {
  const r = registry.detectOutput('codex', MODAL_SCREEN);
  assert.equal(r.found, false);
  assert.equal(r.reason, 'codex_modal_ui');
});

test('#737 anchor: the composer control classifies as ready', () => {
  const r = registry.detectOutput('codex', COMPOSER_SCREEN);
  assert.equal(r.found, true);
  assert.equal(r.reason, 'codex_multi_signal');
});

// The modal is detectable from the PTY byte stream alone — no cmux read-screen needed.
// This is what makes a backend-agnostic fix possible: today the only production consumer
// of detect() is submit-gate.awaitPromptSymbol, which hard-skips every non-cmux session.
test('#737 anchor: the modal is detectable from raw PTY bytes (no screen primitive needed)', () => {
  const ptyBytes = '\x1b[?2004h\x1b[?25l\r\n  ✨ Update available! 0.144.1 -> 0.145.0\r\n\r\n'
    + '› 1. Update now (runs `brew upgrade --cask codex`)\r\n  2. Skip\r\n  3. Skip until next version\r\n\r\n'
    + '  Press enter to continue\r\n';
  const r = registry.detectOutput('codex', ptyBytes);
  assert.equal(r.reason, 'codex_modal_ui');
});

// ── RED: the delivery paths must be able to ask, and must act on the answer. ──

// Seam 1 — a session-level predicate the delivery paths can consult. Named to mirror the
// existing isBootstrapGatedSession/isBootstrapReady pair in daemon.js; the fix may rename
// it, in which case rename here too. What is NOT negotiable is that some seam answers
// "would my bytes be lost right now?" from state a wrapped (non-cmux) session actually has.
test('#737 RED: the daemon exposes a modal-block predicate over a session surface', () => {
  const daemon = require('../daemon');
  assert.equal(typeof daemon.isSurfaceBlockedByModal, 'function',
    'no seam exists for "is this surface swallowing input?" — detection stops at the registry');
  assert.equal(daemon.isSurfaceBlockedByModal(modalSession()), true);
  assert.equal(daemon.isSurfaceBlockedByModal(modalSession(COMPOSER_SCREEN)), false);
});

// Seam 2 — the load-bearing one. Every path that writes to the surface must resolve to a
// non-losing action while the modal is up. The remedy is parameterized; "deliver" is the
// one answer that is always wrong, because it is what ships today and it loses the message
// AND (bracketed body + CR) kills the session.
for (const variant of [
  { name: 'force', opts: { force: true } },
  { name: 'gated', opts: { force: false } },
  { name: 'plain', opts: { force: false, noEnter: false } },
]) {
  test(`#737 RED: ${variant.name} delivery into a modal surface must not resolve to "deliver"`, () => {
    const daemon = require('../daemon');
    assert.equal(typeof daemon.modalDeliveryDecision, 'function',
      'no policy seam — the force path (daemon.js:3079) returns before Layer 3 (daemon.js:3180) ever runs');
    const decision = daemon.modalDeliveryDecision(modalSession(), variant.opts);
    assert.notEqual(decision.action, 'deliver',
      `${variant.name} still writes body+CR into the modal — message lost`);
    assert.ok(ACCEPTED_REMEDIES.has(decision.action),
      `unknown remedy '${decision.action}' — expected one of ${[...ACCEPTED_REMEDIES].join('|')}`);
    if (REMEDY) assert.equal(decision.action, REMEDY);
  });
}

// A non-modal surface must be byte-identical to today on every path — the fix cannot tax
// the common dispatch. Pairs with the control row in the evidence table above.
test('#737 RED: a composer surface still resolves to plain delivery on every path', () => {
  const daemon = require('../daemon');
  assert.equal(typeof daemon.modalDeliveryDecision, 'function');
  for (const opts of [{ force: true }, { force: false }]) {
    assert.equal(daemon.modalDeliveryDecision(modalSession(COMPOSER_SCREEN), opts).action, 'deliver');
  }
});

// ── Blast radius. The force path is production orchestrator dispatch, so the predicate
// must be FAIL-OPEN: only positive modal evidence may ever block a write. ──

test('#737: the predicate fails open on every surface that is not provably modal', () => {
  const daemon = require('../daemon');
  const cases = [
    ['no session', null],
    ['no ring', { command: 'codex', outputRing: undefined }],
    ['empty ring', { command: 'codex', outputRing: [] }],
    ['composer only', { command: 'codex', outputRing: [COMPOSER_SCREEN] }],
    ['unknown cli', { command: 'bash', outputRing: [MODAL_SCREEN] }],
    ['claude session', { command: 'claude', outputRing: [MODAL_SCREEN] }],
    ['gemini session', { command: 'gemini', outputRing: [MODAL_SCREEN] }],
  ];
  for (const [label, session] of cases) {
    assert.equal(daemon.isSurfaceBlockedByModal(session), false, `blocked a non-modal surface: ${label}`);
  }
});

// The byte stream is append-only: the boot modal stays in the ring for the whole session.
// Deciding by presence (what detectOutput does — correct for a cmux screen SNAPSHOT) would
// park every dispatch on a healthy composer forever. Measured on a real codex ring:
// scratchpad/probe-737-ring.js. Position is what makes the predicate usable here.
test('#737: a dismissed modal still in the ring does NOT block — position decides', () => {
  const daemon = require('../daemon');
  const registry2 = require('../src/prompt-symbol-registry');
  const ring = `${MODAL_SCREEN}\n${COMPOSER_SCREEN}\n`;
  // The old presence-based read says "modal" — that is exactly the false positive.
  assert.equal(registry2.detectOutput('codex', ring).reason, 'codex_modal_ui');
  // The positional read sees the composer footer after the modal, and lets the write through.
  assert.equal(daemon.isSurfaceBlockedByModal({ command: 'codex', outputRing: [ring] }), false);
  assert.equal(registry2.detectSurfaceModal('codex', ring).reason, 'composer_after_modal');
});

// ── A: hold-and-retry, with C as its timeout branch. ──

test('#737 A: the hold releases as soon as the surface leaves the modal', async () => {
  const daemon = require('../daemon');
  const session = modalSession();
  // Whoever owns the surface dismisses the modal while we are parked; codex then repaints
  // its composer footer, which is what the positional predicate keys on.
  setTimeout(() => { session.outputRing.push(`\n${COMPOSER_SCREEN}\n`); }, 60);
  const held = await daemon.awaitSurfaceModalClear(session, { timeoutMs: 4000, pollIntervalMs: 20 });
  assert.equal(held.cleared, true);
  assert.ok(held.waited_ms < 4000, `waited ${held.waited_ms}ms — should release on the repaint`);
  assert.equal(await daemon.resolveModalGate('s', session, { force: true }, { timeoutMs: 4000, pollIntervalMs: 20 }), null,
    'gate must let the write through once the surface is clear');
});

test('#737 A: a hold that never clears degrades to reject, not to a write', async () => {
  const daemon = require('../daemon');
  const session = modalSession();                       // nobody ever dismisses it
  const decision = await daemon.resolveModalGate('s', session, { force: true }, { timeoutMs: 120, pollIntervalMs: 20 });
  assert.ok(decision, 'gate must not resolve to "proceed" while the modal is still up');
  assert.equal(decision.action, 'reject');
  assert.equal(decision.reason, 'codex_modal_ui');
  assert.ok(decision.held_ms >= 120, `held only ${decision.held_ms}ms — the bound was not honoured`);
  assert.match(decision.hint, /version\.json/);
});

// #850: same defect as test/claude-modal-inject-760.test.js — `waited_ms` is `now() - start`
// around a loop a clear surface never enters (daemon.js:2700-2705), so asserting it is exactly 0
// asserts that no wall clock ticked across one synchronous predicate call. Observed red on an
// otherwise idle box during the #850 work: `3 !== 0`. The poll count is the claim in the test's
// own name, and the `sleep` seam measures it directly.
test('#737 A: a clear surface costs the hold nothing', async () => {
  const daemon = require('../daemon');
  let polls = 0;
  const held = await daemon.awaitSurfaceModalClear(modalSession(COMPOSER_SCREEN), {
    timeoutMs: 5000,
    pollIntervalMs: 50,
    sleep: (ms) => { polls += 1; return new Promise((r) => setTimeout(r, ms)); }
  });
  assert.equal(held.cleared, true);
  assert.equal(polls, 0, 'a non-modal surface must not pay a single poll');
});

test('#737 A: TELEPTY_MODAL_HOLD_MS bounds the hold, and a blank value keeps the default', () => {
  const daemon = require('../daemon');
  assert.equal(daemon.modalHoldMs({}), 30000);
  assert.equal(daemon.modalHoldMs({ TELEPTY_MODAL_HOLD_MS: '' }), 30000, 'blank must not read as 0');
  assert.equal(daemon.modalHoldMs({ TELEPTY_MODAL_HOLD_MS: '1500' }), 1500);
  assert.equal(daemon.modalHoldMs({ TELEPTY_MODAL_HOLD_MS: 'nope' }), 30000);
});

// Rollback lever, mirroring TELEPTY_SUBMIT_BUSY_DISPATCH=off.
test('#737: TELEPTY_MODAL_REMEDY selects the remedy and `off` restores pre-fix behavior', () => {
  const daemon = require('../daemon');
  assert.equal(daemon.modalRemedy({}), SHIPPED_REMEDY, 'shipped default changed without updating the test');
  assert.equal(daemon.modalRemedy({ TELEPTY_MODAL_REMEDY: 'hold' }), 'hold');
  assert.equal(daemon.modalRemedy({ TELEPTY_MODAL_REMEDY: 'reject' }), 'reject');
  assert.equal(daemon.modalRemedy({ TELEPTY_MODAL_REMEDY: 'off' }), 'off');
  assert.equal(daemon.modalRemedy({ TELEPTY_MODAL_REMEDY: 'nonsense' }), SHIPPED_REMEDY);
  assert.equal(
    daemon.modalDeliveryDecision(modalSession(), { force: true }, { TELEPTY_MODAL_REMEDY: 'off' }).action,
    'deliver');
});
