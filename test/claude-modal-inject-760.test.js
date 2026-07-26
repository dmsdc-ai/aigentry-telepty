'use strict';

// #760 — a Claude Code session showing a blocking modal (AskUserQuestion option list,
// ExitPlanMode plan approval, first-run/trust dialog) swallows injects the same way #737's
// codex update modal did. #737 shipped the mechanism — a positional `detectSurfaceModal`
// predicate, a fail-open `isSurfaceBlockedByModal` gate on all three write paths, and a
// remedy selector — but scoped it to codex: `detectSurfaceModal` returns `not_applicable`
// for every other CLI, so claude got byte-identical pre-#737 behavior.
//
// Written RED against 0.6.18, now GREEN and registered in package.json.
//
// ── Live evidence, 2026-07-26, production orchestrator session ──────────────────────
//   (a) a worker REPORT's text was SPLICED into the middle of the user's in-progress
//       AskUserQuestion answer
//   (b) 3 REPORT injects silently lost during a plan-mode approval window (task #743)
//
// ── Measured against real Claude Code 2.1.220 (scratchpad/capture-760-claude-modals.js —
//    tmux as the VT on its own socket, `pipe-pane -O` for the raw PTY stream, which is
//    exactly what daemon.js's outputRing accumulates) ────────────────────────────────
//
//   shape      modal marker (last)          composer marker (last)   verdict   bytes in 45s
//                                                                              under modal
//   ────────   ──────────────────────────   ──────────────────────   ───────   ────────────
//   composer   (none)                       ctx_meter, mode_line     clear     n/a
//   ask        Esc to cancel                ctx_meter (earlier)      BLOCKED   +0
//   plan       Yes, auto-accept edits       ctx_meter (earlier)      BLOCKED   +0
//
// The "+0 bytes in 45s" column is the load-bearing measurement for the remedy choice: a
// parked claude modal repaints NOTHING. So (i) the positional verdict cannot drift while a
// modal sits for minutes, and (ii) there is no output event to re-arm on — only a poll can
// notice the clear.
//
// ── Why claude needs its own remedy ─────────────────────────────────────────────────
// #737's default is `hold`: park the HTTP request until the surface clears, bounded by
// TELEPTY_MODAL_HOLD_MS (30s) and degrading to `reject`. That fits codex's transient boot
// modal. It does NOT fit claude: a plan approval waits on a HUMAN and routinely stays up for
// minutes, and `telepty inject` is a plain undici fetch (cli.js fetchWithAuth) whose 300s
// headers timeout would kill the request long before the modal clears — the caller sees a
// network error and re-injects, while the daemon delivers the original anyway. So claude
// defaults to `park`: ack immediately, hold the op on the EXISTING bootstrap FIFO, and drain
// it in order once the surface clears. Contract: not lost, delivered after the modal clears,
// order preserved.
//
// ── The delivery shape this must survive ────────────────────────────────────────────
// `telepty inject --submit-force` (the worker REPORT path) is TWO requests: POST /inject
// with noEnter:true, then POST /submit with the body to verify. Parking only the first would
// leave the body on the composer with no CR behind it. Both must land on the same queue.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/prompt-symbol-registry');

// ── Fixtures: verbatim tails of the REAL PTY byte streams, after
//    normalizeOutputForDetection. Nothing here is hand-written.
//
// Note the glued words ("Entertoselect", "Wouldyouliketoproceed?"). That is not a
// transcription slip — it is the single most important property of this fixture set.
// claude's Ink renderer paints DIFFERENTIALLY, emitting ESC[<n>C cursor jumps instead of
// runs of spaces, so once stripAnsi removes them the words abut. Measured:
// `grep -aF "Enter to select" ask.raw.bin` => 0 hits, while the rendered screen shows it
// plainly. Any pattern written with literal spaces matches the screen and MISSES the byte
// stream the delivery path actually reads.

// AskUserQuestion option list — /tmp/c760-work/ask.raw.bin, last 620 normalized chars.
const ASK_RING = 'thought for 1s)\nn65\n90\n'
  + '─'.repeat(120) + '\n'
  + ' ☐ Color choice \nWhich color do you prefer?\n❯ 1. Red\n   A warm, boldcolor\n2. Blue\n'
  + 'A cool, calm color\n3.Typesomething.\n'
  + '─'.repeat(120) + '\n'
  + '4.Chataboutthis\nEntertoselect·↑/↓tonavigate·Esctocancel\n';

// ExitPlanMode approval — /tmp/c760-work/plan.raw.bin, last 620 normalized chars.
// The pre-selected item is "1. Yes, auto-accept edits": a bare CR here does not submit a
// message, it drops a real claude into auto-accept-edits and starts executing the plan.
// Same destructive-default family as #737's "1. Update now (runs `brew upgrade`)".
const PLAN_RING = '╌'.repeat(120) + '\n'
  + '─'.repeat(120) + '\n'
  + 'Claudehaswrittenupaplanandisreadytoexecute.Wouldyouliketoproceed?\n'
  + '❯1.Yes,auto-acceptedits\n2.Yes,manuallyapproveedits\n'
  + '3.No,refinewithUltraplanonClaudeCodeontheweb\n4.TellClaudewhattochange\n'
  + 'shift+tabtoapprovewiththisfeedback\n'
  + 'ctrl+gtoeditinVSCode·~/.claude/plans/read-readme-md-then-immediately-breezy-meadow.md\n';

// Live composer, no modal — /tmp/c760-work/composer.raw.bin, last 620 normalized chars.
// Both forms of the status footer appear: the fully repainted one (real spaces) and the
// differentially repainted one (glued). The counter-signal has to match both.
const COMPOSER_RING = '⚠Yourloginexpiresin3days ·run/logintorenew\n'
  + '─'.repeat(120) + '\n'
  + '❯ Try"howdoIloganerror?"\n'
  + '─'.repeat(120) + '\n'
  + '⏸manualmodeon·←foragents\n'
  + 'trusted | Haiku 4.5 | [░░░░░░░░░░░░░░░] 0% 0/200.0K\n'
  + '⏸ manual mode on · ←r agnts\n';

// A wrapped claude session as the daemon models one: the surface lives in the PTY-fed
// outputRing, no cmux workspace, bootstrap long since ready. `written` collects what
// actually reaches the wire — the owner WebSocket is the real delivery leg for a wrapped
// session (writeDataToSession), so nothing here stubs out the code under test.
function claudeSession(ring = ASK_RING) {
  const written = [];
  return {
    type: 'wrapped',
    command: 'claude',
    backend: 'pty',
    cmuxWorkspaceId: null,
    bootstrapReady: true,
    bootstrapReadyReason: 'owner_alive',
    outputRing: [ring],
    outputRingTotalBytes: ring.length,
    bracketedPasteCapable: true,
    ownerWs: { readyState: 1, send: (msg) => { written.push(JSON.parse(msg).data); } },
    written,
  };
}

const ACCEPTED_REMEDIES = new Set(['hold', 'park', 'reject']);
const SHIPPED_CLAUDE_REMEDY = 'park';

// A drained body arrives bracketed-paste enveloped, exactly as the mailbox path delivers it
// (#716/#730). Strip the envelope to compare payloads; `enveloped()` below asserts it is
// actually there, since that is the property #730 measured the CR's survival on.
const unwrap = (d) => d.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
const enveloped = (d) => d.startsWith('\x1b[200~') && d.endsWith('\x1b[201~');

// ── Detection anchors: real bytes in, correct verdict out. ──

for (const [label, ring] of [['AskUserQuestion', ASK_RING], ['ExitPlanMode', PLAN_RING]]) {
  test(`#760 RED: the real ${label} ring classifies as a blocking claude modal`, () => {
    const r = registry.detectSurfaceModal('claude', ring);
    assert.equal(r.blocked, true,
      `detectSurfaceModal is codex-scoped — claude gets '${r.reason}' and the write goes through`);
    assert.equal(r.reason, 'claude_modal_ui');
  });
}

test('#760 RED: the live-composer control ring is NOT blocked', () => {
  const r = registry.detectSurfaceModal('claude', COMPOSER_RING);
  assert.equal(r.blocked, false);
});

// The literal-space trap. If this passes but the ring tests above fail, the patterns were
// written against the rendered screen instead of the byte stream.
test('#760: the modal markers match the glued Ink form, not just the spaced screen form', () => {
  const glued = registry.detectSurfaceModal('claude', 'Entertoselect·↑/↓tonavigate·Esctocancel');
  const spaced = registry.detectSurfaceModal('claude', 'Enter to select · ↑/↓ to navigate · Esc to cancel');
  assert.equal(glued.blocked, true, 'differential-repaint (glued) form missed — this is what the ring holds');
  assert.equal(spaced.blocked, true, 'full-repaint (spaced) form missed');
});

// ── The delivery paths must be able to ask, and must act on the answer. ──

test('#760 RED: the daemon modal predicate is true for a claude modal surface', () => {
  const daemon = require('../daemon');
  assert.equal(daemon.isSurfaceBlockedByModal(claudeSession(ASK_RING)), true,
    'claude modal surfaces are invisible to the #737 gate');
  assert.equal(daemon.isSurfaceBlockedByModal(claudeSession(PLAN_RING)), true);
  assert.equal(daemon.isSurfaceBlockedByModal(claudeSession(COMPOSER_RING)), false);
});

for (const variant of [
  { name: 'force', opts: { force: true } },
  { name: 'gated', opts: { force: false } },
  { name: 'plain', opts: { force: false, noEnter: false } },
]) {
  test(`#760 RED: ${variant.name} delivery into a claude modal must not resolve to "deliver"`, () => {
    const daemon = require('../daemon');
    const decision = daemon.modalDeliveryDecision(claudeSession(PLAN_RING), variant.opts);
    assert.notEqual(decision.action, 'deliver',
      `${variant.name} still writes into the plan-approval modal — the CR activates "1. Yes, auto-accept edits"`);
    assert.ok(ACCEPTED_REMEDIES.has(decision.action),
      `unknown remedy '${decision.action}' — expected one of ${[...ACCEPTED_REMEDIES].join('|')}`);
  });
}

// ── Blast radius. Production dispatch flows through this path all day, so the predicate
//    must stay FAIL-OPEN: only positive modal evidence may ever block a write. ──

test('#760: the predicate fails open on every claude surface that is not provably modal', () => {
  const daemon = require('../daemon');
  const cases = [
    ['no session', null],
    ['no ring', { command: 'claude', outputRing: undefined }],
    ['empty ring', { command: 'claude', outputRing: [] }],
    ['composer only', { command: 'claude', outputRing: [COMPOSER_RING] }],
    ['bare boot banner', { command: 'claude', outputRing: ['Welcome to Claude Code v2.1.220\n'] }],
    ['transcript prose', { command: 'claude', outputRing: [`${COMPOSER_RING}\nI will now select the best option.\n`] }],
    ['unknown cli', { command: 'bash', outputRing: [ASK_RING] }],
    ['gemini session', { command: 'gemini', outputRing: [ASK_RING] }],
  ];
  for (const [label, session] of cases) {
    assert.equal(daemon.isSurfaceBlockedByModal(session), false, `blocked a non-modal claude surface: ${label}`);
  }
});

// #737's rule, re-proved for claude: the ring is append-only, so a DISMISSED modal is still
// in it forever. Presence would park every dispatch on a healthy session; position decides.
test('#760: a dismissed claude modal still in the ring does NOT block — position decides', () => {
  const daemon = require('../daemon');
  const ring = `${PLAN_RING}\n${COMPOSER_RING}\n`;
  assert.equal(daemon.isSurfaceBlockedByModal({ command: 'claude', outputRing: [ring] }), false);
  assert.equal(registry.detectSurfaceModal('claude', ring).reason, 'composer_after_modal');
});

// The verdict must not depend on how much of the ring the delivery path happens to read.
test('#760: the verdict is window-insensitive', () => {
  const pad = 'x'.repeat(4096) + '\n';
  for (const repeats of [1, 4, 16]) {
    const ring = pad.repeat(repeats) + ASK_RING;
    assert.equal(registry.detectSurfaceModal('claude', ring).blocked, true, `blocked flipped at ${repeats} pads`);
    assert.equal(registry.detectSurfaceModal('claude', ring + COMPOSER_RING).blocked, false,
      `clear flipped at ${repeats} pads`);
  }
});

// ── codex must be untouched: #737's anchors run against the generalized detector. ──

const CODEX_MODAL_SCREEN = [
  '', '  ✨ Update available! 0.144.1 -> 0.145.0', '',
  '› 1. Update now (runs `brew upgrade --cask codex`)', '  2. Skip', '',
  '  Press enter to continue',
].join('\n');
const CODEX_COMPOSER_SCREEN = ['>_ OpenAI Codex (v0.144.1)', '› ', 'gpt-5.5 xhigh fast · /tmp/c737-work'].join('\n');

test('#760: codex detection is unchanged by the generalization (#737 anchors)', () => {
  const daemon = require('../daemon');
  assert.equal(registry.detectSurfaceModal('codex', CODEX_MODAL_SCREEN).reason, 'codex_modal_ui');
  assert.equal(registry.detectSurfaceModal('codex', CODEX_COMPOSER_SCREEN).blocked, false);
  assert.equal(registry.detectSurfaceModal('codex', `${CODEX_MODAL_SCREEN}\n${CODEX_COMPOSER_SCREEN}`).reason,
    'composer_after_modal');
  // codex must not pick up claude's markers, nor claude codex's.
  assert.equal(registry.detectSurfaceModal('codex', ASK_RING).blocked, false);
  assert.equal(registry.detectSurfaceModal('claude', CODEX_MODAL_SCREEN).blocked, false);
  assert.equal(daemon.isSurfaceBlockedByModal({ command: 'codex', outputRing: [CODEX_MODAL_SCREEN] }), true);
});

test('#760: codex keeps the 30s hold remedy; claude gets park', () => {
  const daemon = require('../daemon');
  assert.equal(daemon.modalRemedy({}, { command: 'codex' }), 'hold', 'codex remedy changed — #737 regression');
  assert.equal(daemon.modalRemedy({}, { command: 'claude' }), SHIPPED_CLAUDE_REMEDY);
  assert.equal(daemon.modalRemedy({}), 'hold', '#737 called modalRemedy(env) with no session — must still answer hold');
  // The env lever still wins over the per-CLI default, in both directions.
  assert.equal(daemon.modalRemedy({ TELEPTY_MODAL_REMEDY: 'hold' }, { command: 'claude' }), 'hold');
  assert.equal(daemon.modalRemedy({ TELEPTY_MODAL_REMEDY: 'park' }, { command: 'codex' }), 'park');
  assert.equal(daemon.modalRemedy({ TELEPTY_MODAL_REMEDY: 'nonsense' }, { command: 'claude' }), SHIPPED_CLAUDE_REMEDY);
});

test('#760: TELEPTY_MODAL_REMEDY=off restores pre-fix behavior for claude too', () => {
  const daemon = require('../daemon');
  assert.equal(
    daemon.modalDeliveryDecision(claudeSession(ASK_RING), { force: true }, { TELEPTY_MODAL_REMEDY: 'off' }).action,
    'deliver');
});

// `off` has to be a COMPLETE rollback, including the new guard inside the boot drain. If
// that guard asked the raw predicate instead of the remedy-aware decision, a rollback would
// still leave boot-queued ops stuck behind a modal — a new failure mode reachable only by
// the escape hatch, which is the worst place to have one.
test('#760: TELEPTY_MODAL_REMEDY=off also un-gates the bootstrap drain', async () => {
  const daemon = require('../daemon');
  const prior = process.env.TELEPTY_MODAL_REMEDY;
  const session = claudeSession(ASK_RING);
  session.bootstrapQueue = [{ op_id: 'off-1', type: 'inject', prompt: 'legacy behavior', noEnter: true }];
  process.env.TELEPTY_MODAL_REMEDY = 'off';
  try {
    await daemon.drainBootstrapQueue('c760-off', session);
  } finally {
    if (prior === undefined) delete process.env.TELEPTY_MODAL_REMEDY;
    else process.env.TELEPTY_MODAL_REMEDY = prior;
  }
  assert.deepEqual(session.written.map(unwrap), ['legacy behavior'],
    'the rollback lever must restore the pre-#760 drain, modal or not');
  assert.equal(session.bootstrapQueue.length, 0);
});

// ── The park: not lost, delivered after the modal clears, order preserved. ──

test('#760 RED: a modal-parked inject is queued and acked, not written and not refused', async () => {
  const daemon = require('../daemon');
  const session = claudeSession(PLAN_RING);
  const result = await daemon.deliverInjectionToSession('c760-park', session, 'REPORT: worker one', {});
  assert.equal(result.success, true, 'a park must ACK — a refusal makes the caller re-inject');
  assert.equal(result.queued, true);
  assert.equal(result.reason, 'claude_modal_ui');
  assert.equal(session.bootstrapQueue.length, 1, 'the body must be parked on the FIFO, not written');
  assert.equal(session.bootstrapQueue[0].prompt, 'REPORT: worker one');
});

test('#760 RED: the park drains in FIFO order once the modal clears', async () => {
  const daemon = require('../daemon');
  const session = claudeSession(PLAN_RING);

  for (const body of ['first', 'second', 'third']) {
    await daemon.deliverInjectionToSession('c760-order', session, body, { noEnter: true });
  }
  assert.equal(session.bootstrapQueue.length, 3, 'all three parked');
  assert.deepEqual(session.written, [], 'nothing may reach the surface while the modal is up');

  // Whoever owns the surface answers the plan prompt; claude repaints its composer.
  session.outputRing.push(`\n${COMPOSER_RING}\n`);
  await daemon.awaitModalParkDrain('c760-order', session, { timeoutMs: 4000, pollIntervalMs: 20 });

  assert.equal(session.bootstrapQueue.length, 0, 'the queue must drain once the surface clears');
  assert.deepEqual(session.written.map(unwrap), ['first', 'second', 'third'],
    'order was not preserved across the park');
  assert.ok(session.written.every(enveloped),
    'a parked body must be delivered bracketed-paste enveloped — an un-enveloped multi-line '
    + 'body is the exact shape #730 measured swallowing the following CR');
});

// The race the FIFO alone does not close: the modal clears between two dispatches. Dispatch
// two sees a clear surface, takes the mailbox path, and lands before dispatch one — which is
// still sitting in the queue waiting for the drain. Everything behind a backlog must park.
test('#760: a dispatch arriving after the modal clears still parks behind the backlog', async () => {
  const daemon = require('../daemon');
  const session = claudeSession(ASK_RING);
  await daemon.deliverInjectionToSession('c760-race', session, 'first', { noEnter: true });
  assert.equal(session.bootstrapQueue.length, 1);

  session.outputRing.push(`\n${COMPOSER_RING}\n`);       // surface clears; drain not run yet
  assert.equal(daemon.isSurfaceBlockedByModal(session), false, 'precondition: the gate now says clear');

  const second = await daemon.deliverInjectionToSession('c760-race', session, 'second', { noEnter: true });
  assert.equal(second.queued, true, 'second dispatch overtook the parked first via the mailbox path');
  assert.equal(second.reason, 'modal_park_backlog');
  assert.equal(session.bootstrapQueue.length, 2);

  await daemon.awaitModalParkDrain('c760-race', session, { timeoutMs: 4000, pollIntervalMs: 20 });
  assert.deepEqual(session.written.map(unwrap), ['first', 'second']);
});

test('#760 RED: the drain never writes into a still-modal surface', async () => {
  const daemon = require('../daemon');
  const session = claudeSession(ASK_RING);
  await daemon.deliverInjectionToSession('c760-guard', session, 'must not land', { noEnter: true });
  // Call the boot drain directly — it must refuse on its own, not rely on its caller. The
  // boot path (markBootstrapReady) reaches it without ever consulting the modal gate.
  await daemon.drainBootstrapQueue('c760-guard', session);
  assert.deepEqual(session.written, [], 'drainBootstrapQueue wrote into a live modal');
  assert.equal(session.bootstrapQueue.length, 1, 'the op must stay parked, not be consumed');
});

test('#760: a park that outlives its TTL is flushed with an actionable error, not silently', async () => {
  const daemon = require('../daemon');
  const session = claudeSession(ASK_RING);           // nobody ever answers it
  await daemon.deliverInjectionToSession('c760-ttl', session, 'stranded', { noEnter: true });
  const outcome = await daemon.awaitModalParkDrain('c760-ttl', session, { timeoutMs: 120, pollIntervalMs: 20 });
  assert.equal(outcome.cleared, false);
  assert.equal(outcome.flushed, 1, 'the parked op must be flushed, not left to accumulate forever');
  assert.equal(session.bootstrapQueue.length, 0);
});

test('#760: TELEPTY_MODAL_PARK_TTL_MS bounds the park, and a blank value keeps the default', () => {
  const daemon = require('../daemon');
  assert.equal(daemon.modalParkTtlMs({}), 600000, 'default must match the bridge park budget (#720, 600s)');
  assert.equal(daemon.modalParkTtlMs({ TELEPTY_MODAL_PARK_TTL_MS: '' }), 600000, 'blank must not read as 0');
  assert.equal(daemon.modalParkTtlMs({ TELEPTY_MODAL_PARK_TTL_MS: '1500' }), 1500);
  assert.equal(daemon.modalParkTtlMs({ TELEPTY_MODAL_PARK_TTL_MS: 'nope' }), 600000);
});

// A clear claude surface must cost nothing and behave exactly as it does today. Asserted at
// the decision seam rather than through deliverInjectionToSession, because the delivering
// branch runs the real mailbox — the park branch returns before it, which is why the park
// tests above can drive the whole function.
test('#760: a clear claude surface resolves to plain delivery on every path', () => {
  const daemon = require('../daemon');
  for (const opts of [{ force: true }, { force: false }, { force: false, noEnter: true }]) {
    assert.equal(daemon.modalDeliveryDecision(claudeSession(COMPOSER_RING), opts).action, 'deliver');
  }
  assert.equal(daemon.modalDeliveryDecision(claudeSession(COMPOSER_RING), {}).reason, 'surface_clear');
});

test('#760: the park costs a clear surface nothing — no queue, no poll', async () => {
  const daemon = require('../daemon');
  const session = claudeSession(COMPOSER_RING);
  const outcome = await daemon.awaitModalParkDrain('c760-noop', session, { timeoutMs: 5000, pollIntervalMs: 50 });
  assert.equal(outcome.cleared, true);
  assert.equal(outcome.waited_ms, 0, 'a non-modal surface must not pay a single poll');
});
