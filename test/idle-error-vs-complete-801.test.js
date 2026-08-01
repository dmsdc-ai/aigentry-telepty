'use strict';

// #801 — a wrapped AI-CLI session that DIES on an API error is reported as a COMPLETION.
//
// The session errors, prints its banner, and returns to its prompt having produced nothing.
// It is then quiet, so the idle detector flips it and the auto-report path emits:
//
//   TASK_COMPLETE: <sid> is now idle after processing inject (204.5s, via real-idle inject=…)
//
// It did not process the inject. The orchestrator cannot tell this apart from a real
// completion without reading the screen — which is precisely the thing the signal exists to
// spare it.
//
// ── Live evidence, 2026-07-26, production orchestrator ──────────────────────────────
//   session                     idle-at                  screen at that moment
//   ─────────────────────────   ──────────────────────   ────────────────────────────────
//   c757s-supervisor-orphan     204.5 / 213.8 / 209.4s   ⏺ API Error: 529 Overloaded…
//   ar795r-adr-r2               329.5 / 211.3s           same 529 banner
//   r795cs-adr-review-sol       10.8s                    ■ {"type":"error","status":400,…}
//   w795c-w1c-freshness         366.6s                   CONTROL — a real REPORT arrived
//
// ── Measured against real binaries (scratchpad/capture-801-api-error.js — claude 2.1.220
//    against a local stub that answers 529, codex 0.145.0 against the real API's model
//    rejection; tmux as the VT on its own socket, `pipe-pane -O` for the raw PTY stream,
//    which is exactly what daemon.js's outputRing accumulates) ────────────────────────
//
//   shape        last error marker                     verdict          notes
//   ──────────   ───────────────────────────────────   ──────────────   ──────────────────
//   claude-529   ⏺API Error: 529 Overloaded…           claude_api_error after 10 retries
//   claude-ok    (none — last ⏺ bullet is the answer)  clear            CONTROL
//   codex-400    ■ {"type":"error","status":400,…}     codex_api_error  turn died at once
//   codex-ok     (none — last • bullet is the answer)  clear            CONTROL
//
// ── The two measurements that shaped the design ─────────────────────────────────────
//
// (1) The composer CANNOT be the counter-signal. detectSurfaceModal decides "modal vs live
//     composer" positionally, and the obvious move here was to reuse that shape. It does not
//     work: in BOTH error captures the composer and its status footer repaint AFTER the error
//     banner. That repaint is not recovery — it IS the symptom (the worker is back at its
//     prompt with nothing to show), so a composer counter-signal vetoes every real error.
//     What scopes the verdict instead is the TURN: only ring bytes appended past the inject
//     watermark are scanned, the same split observeInjectEcho uses. An error from an earlier
//     turn was already reported when it happened and cannot poison this turn.
//
// (2) The #760 whitespace lesson bites again, and in both directions. The captured claude
//     bytes read `⏺API Error:` — the rendered space between glyph and text is GONE, because
//     Ink paints runs of spaces as ESC[<n>C cursor jumps — while `API Error`'s interior space
//     survives. The same stream shows `atempt 8/10` where the screen reads `attempt 8/10`.
//     A literal-space pattern would match a `read-screen` snapshot and miss the byte stream
//     this predicate actually runs on; `\s*` matches both forms.
//
// ── Fail-open, which is the whole safety argument ───────────────────────────────────
// Only positive error evidence may relabel. No per-CLI rule (gemini, a shell), no watermark,
// no ring, or no marker => the emission is byte-identical to today's. A genuine TASK_COMPLETE
// can never be suppressed by an unrecognised screen, and TASK_IDLE_UNCONFIRMED / NO_REPORT
// semantics are untouched — the check only ever runs when the daemon was about to claim the
// inject was PROCESSED.
//
// e2e (scratchpad/e2e-801.js, harness daemon PORT=0 + mkdtemp HOME, production 3848 never
// touched) runs the same four captures through the real daemon on both builds:
//   pre-fix main  claude-529 → TASK_COMPLETE      fix build  claude-529 → TASK_ERROR
//   pre-fix main  codex-400  → TASK_COMPLETE      fix build  codex-400  → TASK_ERROR
//   pre-fix main  control    → TASK_COMPLETE      fix build  control    → TASK_COMPLETE

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/prompt-symbol-registry');
const { fireAutoReport, detectIdleAfterError } = require('../daemon');

// ── Fixtures: verbatim tails of the REAL PTY byte streams, after
//    normalizeOutputForDetection. Nothing here is hand-written; the glued words and the
//    dropped letter in "atempt" are the differential paint, not transcription slips.

// /tmp/c801-work/claude-529.raw.bin — retries exhausted, turn dead, composer back.
const CLAUDE_ERROR_RING = '9s · atempt 10/10\n8\n7\n6\n5\n4\n3\n2\n1\n'
  + '⏺API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it \n'
  + '  persists, check your inference gateway (127.0.0.1:55310).\n'
  + '✻ Sautéed for 3m 4s\n❯ \n'
  + '─'.repeat(120) + '\n'
  + 'trusted|Haiku4.5|[░░░░░░░░░░░░░░░]0%0/200.0K\n'
  + '⏸manualmodeon·←foragents\n';

// /tmp/c801-work/claude-ok.raw.bin — CONTROL: the last ⏺ bullet is the answer.
const CLAUDE_OK_RING = '·thinking\n'
  + '⏺Hey! 👋 What can I help you with?\n'
  + '· Determining… (4s · thought for 3s)\n❯ \n'
  + '─'.repeat(120) + '\n'
  + 'trusted | Haiku 4.5 | [░░░░░░░░░░░░░░░]0% 0/200.0K\n'
  + '⏸manualmodeon·←foragents\n'
  + '✻Cooked for 4s\n❯ \n██18% 35.5K/200.0K\n';

// /tmp/c801-work/codex-400.raw.bin — the r795cs-adr-review-sol banner, verbatim from the
// real API. The trailing garble is the MCP-startup line codex was still repainting
// underneath the error.
const CODEX_ERROR_RING = '• You have 3 usage limit resets available. Run /usage to use one.ers (5/6):•rs (5/6): apps\n'
  + '■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6\' model is not supported\n'
  + 'when using Codex with a ChatGPT account."}}ppsps›Summarize recent commitsgpt-5.6 xhigh · /private/tmp/c801-work/trusted';

// /tmp/c801-work/codex-ok.raw.bin — CONTROL. Note the spinner's own `•` inside
// "(0s • esc to interrupt)", differentially smeared across the reflowing line: that is why
// `•` is not usable as a codex content marker and the ■ glyph anchors the error patterns.
const CODEX_OK_RING = '•Working (0s • esc to interrupt)Wor•WorkWorki•Workin•Working1•WorkingWorking•Working•orking•rking•kinging•ngg2\n'
  + '• Hi! 👋›Write tests for @filenamegpt-5.6-sol xhigh fast · /private/tmp/c801-work/trusted';

// ===========================================================================
// 1 — the detector, on the captured bytes
// ===========================================================================

test('#801 claude: an exhausted-retry API Error banner is a terminal-turn failure', () => {
  const v = registry.detectSurfaceError('claude', CLAUDE_ERROR_RING);
  assert.equal(v.errored, true);
  assert.equal(v.reason, 'claude_api_error');
  assert.match(v.detail, /^API Error: 529 Overloaded\./);
  assert.ok(v.detail.length <= 120, `detail must stay injectable, got ${v.detail.length} chars`);
});

test('#801 claude: the glyph/text space is absent from the byte stream (#760)', () => {
  assert.ok(CLAUDE_ERROR_RING.includes('⏺API Error'),
    'fixture must keep the differential paint — a literal-space pattern would pass on a screen and fail here');
  // Both forms must detect: whichever way the frame happened to repaint.
  assert.equal(registry.detectSurfaceError('claude', '⏺API Error: 500 Internal').errored, true);
  assert.equal(registry.detectSurfaceError('claude', '⏺ API Error: 500 Internal').errored, true);
});

test('#801 claude CONTROL: a real answer is not an error, even after the same footer repaint', () => {
  const v = registry.detectSurfaceError('claude', CLAUDE_OK_RING);
  assert.equal(v.errored, false);
  assert.equal(v.reason, 'no_error_seen');
});

test('#801 claude: a mid-flight retry banner is NOT a terminal failure', () => {
  // The 10 retries claude paints while it still has hope must not trip the signal — only the
  // ⏺ bullet it prints once the turn is actually dead may.
  const retrying = '✻ 529 Overloaded · Retrying in 8s · atempt 5/10\n  If it persists, check your inference gateway.\n';
  assert.equal(registry.detectSurfaceError('claude', retrying).errored, false);
});

test('#801 codex: the ■ error envelope is a terminal-turn failure', () => {
  const v = registry.detectSurfaceError('codex', CODEX_ERROR_RING);
  assert.equal(v.errored, true);
  assert.equal(v.reason, 'codex_api_error');
  assert.match(v.detail, /invalid_request_error/);
  assert.ok(v.detail.length <= 120);
});

test('#801 codex CONTROL: a real answer plus spinner-smeared bullets is not an error', () => {
  assert.equal(registry.detectSurfaceError('codex', CODEX_OK_RING).errored, false);
});

test('#801 codex: an unanchored "type":"error" in worker output is not a CLI failure', () => {
  // A worker that cats a JSON fixture or a log must not be declared dead. The ■ glyph is
  // codex's own chrome; the worker cannot print it as part of a tool result line.
  const catted = '› cat fixture.json\n{"type":"error","status":500,"error":{"type":"server_error"}}\n• Done.\n';
  assert.equal(registry.detectSurfaceError('codex', catted).errored, false);
});

test('#801 fail-open: an unmeasured or unknown CLI keeps byte-identical behaviour', () => {
  for (const cli of ['gemini', 'bash', 'wrapped', '', null]) {
    const v = registry.detectSurfaceError(cli, CLAUDE_ERROR_RING);
    assert.equal(v.errored, false, `${cli} must not be classified`);
    assert.equal(v.reason, 'not_applicable');
  }
});

test('#801 positional: the LAST error marker is the one described', () => {
  const twice = registry.detectSurfaceError('claude',
    '⏺API Error: 500 Internal\n…\n⏺API Error: 529 Overloaded\n');
  assert.match(twice.detail, /529/);
});

// ===========================================================================
// 2 — the wiring: turn-scoped, and fail-open on every missing input
// ===========================================================================

function session(ring, overrides = {}) {
  const frames = Array.isArray(ring) ? ring : [ring];
  return {
    id: 'worker-1',
    type: 'wrapped',
    command: 'claude',
    outputRing: frames,
    outputRingTotalBytes: frames.reduce((s, d) => s + d.length, 0),
    ...overrides,
  };
}

test('#801 turn-scoped: an error from a PREVIOUS turn cannot poison this one', () => {
  const pre = CLAUDE_ERROR_RING;             // last turn died — already reported then
  const post = CLAUDE_OK_RING;               // this turn genuinely answered
  const s = session([pre, post]);
  assert.equal(detectIdleAfterError(s, { ringBytesAtInject: pre.length }), null);
  // …and the same ring WITHOUT the scoping would have said errored — proving the guard is
  // load-bearing rather than incidentally satisfied.
  assert.equal(registry.detectSurfaceError('claude', pre + post).errored, true);
});

test('#801 turn-scoped: an error inside THIS turn fires', () => {
  const pre = CLAUDE_OK_RING;
  const s = session([pre, CLAUDE_ERROR_RING]);
  const v = detectIdleAfterError(s, { ringBytesAtInject: pre.length });
  assert.ok(v && v.reason === 'claude_api_error');
});

test('#801 fail-open: no watermark / no ring / no advance => no verdict', () => {
  assert.equal(detectIdleAfterError(session(CLAUDE_ERROR_RING), {}), null, 'legacy entry, no watermark');
  assert.equal(detectIdleAfterError(session([]), { ringBytesAtInject: 0 }), null, 'empty ring');
  assert.equal(detectIdleAfterError(null, { ringBytesAtInject: 0 }), null, 'no session');
  assert.equal(detectIdleAfterError(session(CLAUDE_ERROR_RING), null), null, 'no pending report');
  const s = session(CLAUDE_ERROR_RING);
  assert.equal(detectIdleAfterError(s, { ringBytesAtInject: s.outputRingTotalBytes }), null,
    'ring did not advance past the inject');
});

// ===========================================================================
// 3 — the emission. DI harness around fireAutoReport, mirroring
//     test/idle-unconfirmed-false-negative-721.test.js.
// ===========================================================================

const T0 = 1_700_000_000_000;
const BODY = 'TASK: read the README, summarize it in two sentences, then REPORT back to orchestrator';

function makeGate({ preFrames = [], postFrames = [], pendingReportOverrides = {}, command = 'claude' } = {}) {
  const ring = [...preFrames, ...postFrames];
  const ctx = {
    delivered: [],
    broadcasts: [],
    session: session(ring, { command, lastActivityAt: new Date(T0 - 60_000).toISOString() }),
  };
  ctx.pendingReport = {
    source: 'orch',
    injectId: 'inj-801',
    injectedAt: new Date(T0 - 204_500).toISOString(),   // the c757s profile
    injectedBodyPreview: BODY,
    ringBytesAtInject: preFrames.reduce((s, d) => s + d.length, 0),
    submitExpected: true,
    // The production shape: a force-confirmed submit whose consumption #721 recorded, which
    // is exactly what makes the idle CONFIRMED and produces the false TASK_COMPLETE.
    submitStartedAt: new Date(T0 - 204_000).toISOString(),
    submitConfirmedAt: new Date(T0 - 203_000).toISOString(),
    submitConfirm: { accepted: true, reason: 'pty_cr' },
    injectConsumedAt: new Date(T0 - 200_000).toISOString(),
    ...pendingReportOverrides,
  };
  ctx.deps = {
    now: () => T0,
    setTimeout: (fn, ms) => { ctx.timers.push({ fn, ms }); return ctx.timers.length; },
    broadcastSessionEvent: (type, sid, _s, opts) => ctx.broadcasts.push({ type, sid, opts }),
    resolveSessionAlias: (s) => s,
    sessions: { orch: { id: 'orch' }, 'worker-1': ctx.session },
    pendingReports: { 'worker-1': ctx.pendingReport },
    deliverInjectionToSession: (srcId, _s, msg) => ctx.delivered.push({ srcId, msg }),
    getAutoState: () => 'idle',
  };
  ctx.timers = [];
  ctx.fire = (trigger = 'real-idle') =>
    fireAutoReport('worker-1', ctx.session, ctx.pendingReport, trigger, ctx.deps);
  // #60 Stage A: every quiet observation now goes through the #48/#52 settle debounce — the old
  // code let a `confirmed` completion bypass it, and there are no confirmed completions left.
  // So the emission happens on the settle recheck, not on the first fire.
  ctx.flushTimers = () => {
    let n = 0;
    while (ctx.timers.length && n < 50) { ctx.timers.shift().fn(); n++; }
    return n;
  };
  return ctx;
}

// The literal absence statement this path now emits, for a 204.5s quiet after the c757s inject.
const UNKNOWN_204 =
  /^TASK_COMPLETION_UNKNOWN: worker-1 inject=inj-801 — no completion fact observed; pty_quiet=204\.5s; consumption=(observed|not_established); outcome protocol unavailable$/;

test('#801 THE BUG: an error-death is no longer reported as a completion', () => {
  const g = makeGate({ preFrames: ['boot\n'], postFrames: [BODY + '\n', CLAUDE_ERROR_RING] });
  g.fire();
  g.flushTimers();
  assert.equal(g.delivered.length, 1);
  const msg = g.delivered[0].msg;
  // The bug was the daemon calling this a COMPLETION. That is fixed at the root rather than by
  // relabelling: there is no completion claim for any input, so an error-death cannot be dressed
  // as one. The `TASK_ERROR` counter-label goes with it — "the inject was NOT processed" was an
  // assertion about the worker's turn that the daemon could not measure either.
  assert.match(msg, UNKNOWN_204);
  assert.doesNotMatch(msg, /TASK_COMPLETE/);
  assert.doesNotMatch(msg, /TASK_ERROR/);
  // provenance survives
  assert.match(msg, /inject=inj-801/);
});

// !!! HELD — NOT MIGRATED, EXPECTED RED. Injected to the orchestrator as a suspected source
// regression rather than a vocabulary change; see below. Do not "fix" this by asserting the
// marker is absent — that would pin the defect as intended behaviour.
//
// daemon.js:949-952 still computes the turn-scoped error verdict and writes
// `evidence.error_marker` / `evidence.error_detail`, and the comment at :944-946 says it "rides
// along as a marker". It does not: mapObservationCause (session-state.js:736-737) copies only
// the matched cause row's `requires` fields plus last_output_at/confidence/elapsed_ms, and
// `silence_timeout` requires just ['silence_ms'], so both fields are dropped before the envelope
// is built. Measured consequence: this error-death and the gemini CONTROL below now emit
// byte-identical output. A grep confirms error_marker/error_detail have zero production readers.
test('#801 the bus event carries the marker for the observability lane', () => {
  const g = makeGate({ preFrames: ['boot\n'], postFrames: [CLAUDE_ERROR_RING] });
  g.fire();
  g.flushTimers();
  const ev = g.broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.equal(ev.opts.extra.observation.error_marker, 'claude_api_error');
  assert.match(ev.opts.extra.observation.error_detail, /529 Overloaded/);
});

test('#801 codex error-death is not reported as a completion either', () => {
  const g = makeGate({ command: 'codex', preFrames: ['boot\n'], postFrames: [CODEX_ERROR_RING] });
  g.fire();
  g.flushTimers();
  assert.match(g.delivered[0].msg, UNKNOWN_204);
  assert.doesNotMatch(g.delivered[0].msg, /TASK_COMPLETE|TASK_ERROR/);
});

test('#801 CONTROL: a genuine completion is also only ever an observation', () => {
  // These two fixtures are real answered turns — the strongest "this really did finish" input
  // the daemon ever had. They still produce no completion claim, which is the whole cutover:
  // the daemon never had a fact for the control case either, it just had fewer doubts.
  for (const [command, ring] of [['claude', CLAUDE_OK_RING], ['codex', CODEX_OK_RING]]) {
    const g = makeGate({ command, preFrames: ['boot\n'], postFrames: [BODY + '\n', ring] });
    g.fire();
    g.flushTimers();
    assert.match(g.delivered[0].msg, UNKNOWN_204, `${command} control`);
    assert.doesNotMatch(g.delivered[0].msg, /TASK_COMPLETE/, `${command} control`);
  }
});

test('#801 CONTROL: an unmeasured CLI showing the same banner is treated identically', () => {
  // Fail-open is preserved trivially now — an unrecognised screen cannot suppress a completion
  // claim that no longer exists. (This case is also the measurement behind the HOLD above: it
  // is currently indistinguishable from the claude error-death, which is the regression.)
  const g = makeGate({ command: 'gemini', preFrames: ['boot\n'], postFrames: [CLAUDE_ERROR_RING] });
  g.fire();
  g.flushTimers();
  assert.match(g.delivered[0].msg, UNKNOWN_204);
  assert.doesNotMatch(g.delivered[0].msg, /TASK_COMPLETE|TASK_ERROR/);
});

test('#801 an unconfirmed idle is stated the same way — no relabelling remains possible', () => {
  // The original point was that #801's check only ever intercepted a claim of COMPLETION and
  // never touched the honest warning. With one statement for every path there is no label left
  // to relabel; what is asserted instead is that dropping the consumption evidence changes the
  // consumption FIELD and nothing else about the sentence.
  const g = makeGate({
    preFrames: ['boot\n'],
    postFrames: [CLAUDE_ERROR_RING],
    pendingReportOverrides: {
      injectConsumedAt: undefined,
      submitConfirmedAt: undefined,
      submitConfirm: { accepted: false, reason: 'submit_unconfirmed' },
      unconfirmedSettleDone: true,
    },
  });
  g.deps.idleEvidenceReliable = false;
  g.fire();
  g.flushTimers();
  assert.equal(g.delivered.length, 1);
  assert.match(g.delivered[0].msg, UNKNOWN_204);
  assert.doesNotMatch(g.delivered[0].msg, /TASK_ERROR|TASK_IDLE_UNCONFIRMED/);
  const ev = g.broadcasts.find((b) => b.type === 'task_completion_unknown');
  assert.equal(ev.opts.extra.consumption.basis, 'submit_rejection_observed',
    'the rejected submit is named as the basis, where the old code encoded it in the label');
});
