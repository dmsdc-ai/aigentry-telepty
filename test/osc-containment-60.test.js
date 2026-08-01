'use strict';

// telepty#60 Stage A — §8.4 OSC containment.
//
// READ THIS BEFORE "FIXING" A FAILURE HERE: these are PERMANENT GREEN CONTROLS, not RED tests.
// §8.4 says so outright — "Unpatched 0.7.1 should pass the OSC 9;4 behavioral controls because it
// currently strips/ignores OSC 9;4. If any is reported RED against unpatched source, the test is
// wired to the wrong premise." A control's job is to fail LATER, if someone promotes a progress
// escape to a completion fact. Cases 1-4 below therefore pass on ca44782 and on this branch, and
// that is the correct result for them.
//
// WHY THE CONTROL EXISTS AT ALL. OSC 9;4 is the most tempting signal in the capture set: in
// claude-2turn.raw.bin turn one opens at byte 4449 and closes at 9222, turn two opens at 9549 and
// closes at 13825, and each open follows the local CR by exactly 20 bytes. It looks like a turn
// boundary. It is not one, because the channel cannot supply EMITTER IDENTITY:
//
//   * the bridge receives one undifferentiated child.onData stream (cli.js:2066-2087) and relays it
//     unchanged — there is no per-emitter metadata to recover;
//   * a nested child's determinate-progress clear closes the parent's bracket, so depth counting
//     is defeated by the same byte stream it counts;
//   * the escape is ordinary file content: `cat` a transcript and the bytes arrive again, later,
//     attributed to the wrapper.
//
// So the escape may exist as telemetry and must never enter a completion-fact factory. In 0.8.0
// there is no factory to enter — which is what case 5 pins as a source invariant, and which is the
// only case here that is red against ca44782 (by construction: the cutover deleted the producers).
//
// Pure: session-state.js plus a source grep. No daemon, no PTY, no HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SessionStateMachine,
  stripAnsi,
  OSC_133_RE,
} = require('../session-state');

// Exact bytes lifted from ~/.aigentry/archive/telepty60-pty-captures-2026-07-29/claude-2turn.raw.bin
// at the four §8.4 offsets, 23 bytes each. Embedded rather than read from the archive so the
// control is hermetic (the archive is not in the repo and is not present in CI), and verbatim so
// it is still the real traffic. Offsets 4449/9549 open, 9222/13825 close; the synchronized-update
// and cursor-hide escapes that follow are the real next bytes in the stream, kept so each slice
// ends on a COMPLETE escape — a slice cut mid-escape is not traffic any parser ever sees, and
// asserting against one tests the trim, not the containment.
const CAPTURE_SLICES = [
  { offset: 4449,  bytes: '\x1b]9;4;3;\x07\x1b[?2026h\x1b[?25l' },   // turn 1 open  (indeterminate progress)
  { offset: 9222,  bytes: '\x1b]9;4;0;\x07\x1b[?2026h\x1b[?25l' },   // turn 1 close (progress cleared)
  { offset: 9549,  bytes: '\x1b]9;4;3;\x07\x1b[?2026h\x1b[?25l' },   // turn 2 open
  { offset: 13825, bytes: '\x1b]9;4;0;\x07\x1b[?2026h\x1b[?25l' },   // turn 2 close
];

// Feed bytes through the real machine and report the RAW transitions it fired.
//
// Deliberately raw, and this matters: an earlier version of this file mapped each transition
// through `mapObservationCause` before asserting. That coupled the control to a Stage-A-only
// export, so it went RED against ca44782 with `mapObservationCause is not a function` — a control
// wired to the wrong premise, exactly what §8.4's closing paragraph warns about. The containment
// claim is about what these BYTES can make the machine do, and that question is answerable
// identically on both sides of the cutover. `destroy()` clears the 1s poll interval.
function transitionsFor(chunks) {
  const sm = new SessionStateMachine('probe');
  const seen = [];
  sm.onTransition((from, to, detail) => {
    seen.push({ from, to, trigger: detail.detail ? detail.detail.trigger : null });
  });
  try {
    for (const c of chunks) sm.feed(c);
    return { transitions: seen, state: sm.getState() };
  } finally {
    sm.destroy();
  }
}

// What "zero completion facts" means at this layer, in a form that is true on both sides of the
// cutover. IDLE is the destination that fed the completion factory: in 0.7.1 an idle entrance ran
// fireAutoReport and could produce TASK_COMPLETE; in 0.8.0 it produces `pty_quiet`. If an OSC 9;4
// escape could reach idle, it would be a completion input in the old world and a quiet claim in the
// new one — wrong in both. And no 9;4 form may ever be attributed to the OSC 133 marker cause,
// which is the only entrance that carries any prompt-boundary authority at all.
const PROMPT_MARK_TRIGGER = /osc[_ ]?133|osc_133_prompt/i;

function assertNoCompletionFact(transitions, label) {
  for (const t of transitions) {
    assert.notEqual(t.to, 'idle',
      `[${label}] an OSC 9;4 escape drove the machine to idle — the destination that feeds completion`);
    assert.ok(!PROMPT_MARK_TRIGGER.test(String(t.trigger)),
      `[${label}] OSC 9;4 was attributed to the OSC 133 prompt-mark cause: ${t.trigger}`);
  }
}

// --- §8.4 case 1: the exact capture slices --------------------------------------------------

test('osc_containment: the four claude-2turn OSC 9;4 boundaries produce zero completion facts', () => {
  for (const slice of CAPTURE_SLICES) {
    const { transitions } = transitionsFor([slice.bytes]);
    assertNoCompletionFact(transitions, `claude-2turn@${slice.offset}`);
    // The escape is stripped before pattern analysis, so it produces no observation at all — it
    // cannot even reach the classifier, let alone a completion decision.
    assert.equal(stripAnsi(slice.bytes).trim(), '',
      `[${slice.offset}] the OSC 9;4 slice must contain no analysable text`);
  }
});

test('osc_containment: a whole turn bracket, fed in order, is not a turn boundary', () => {
  // Both slices of turn one, in the order the capture recorded them, with realistic output in
  // between. If any code path ever paired the open with the close, this is where it would show.
  const { transitions } = transitionsFor([
    CAPTURE_SLICES[0].bytes,
    'Reading files...\n',
    'Done writing the patch.\n',
    CAPTURE_SLICES[1].bytes,
  ]);
  assertNoCompletionFact(transitions, 'turn-1 bracket');
  assert.ok(transitions.length > 0, 'the intervening OUTPUT is still observed — containment is not blindness');
  for (const t of transitions) {
    assert.ok(['working', 'thinking'].includes(t.to),
      `only the TEXT moved the machine, and only to a busy state; got ${t.from}→${t.to}`);
  }
});

// --- §8.4 case 2: the full determinate-progress sequence -------------------------------------

test('osc_containment: a determinate 9;4 progress sequence produces zero completion facts', () => {
  // 9;4;3 (indeterminate) → 9;4;1;10 → 9;4;1;90 (determinate, with a percentage) → 9;4;0 (clear).
  // The percentage is the most "meaningful" form of the escape and still measures only a progress
  // bar drawn by SOME process on the shared stream.
  const { transitions } = transitionsFor([
    '\x1b]9;4;3;\x07',
    '\x1b]9;4;1;10\x07',
    '\x1b]9;4;1;90\x07',
    '\x1b]9;4;0;\x07',
  ]);
  assertNoCompletionFact(transitions, 'determinate progress');
  assert.equal(transitions.length, 0, 'a pure progress sequence moves the machine not at all');
});

// --- §8.4 case 3: an unpaired nested close ---------------------------------------------------

test('osc_containment: an unpaired nested 9;4;0 produces zero completion facts', () => {
  // The defeater for depth counting: a CHILD clears progress, closing the parent's bracket. A
  // parser that treated a close as "the wrapper's turn ended" would fire here on a turn that is
  // still running.
  const { transitions, state } = transitionsFor([
    '\x1b]9;4;3;\x07',        // parent opens
    'parent still working\n',
    '\x1b]9;4;0;\x07',        // CHILD clears — parent's bracket closed by someone else
    '\x1b]9;4;0;\x07',        // and again, with nothing open
    'parent still working\n',
  ]);
  assertNoCompletionFact(transitions, 'unpaired nested close');
  // The parent is still producing output, and the machine says exactly that.
  assert.equal(state.state, 'working', 'a stray close must not end the parent\'s turn');
});

// --- §8.4 case 4: the escape as ordinary content ---------------------------------------------

test('osc_containment: the escape inside bracketed paste, echoed input and cat output is inert', () => {
  const cases = [
    {
      label: 'bracketed paste',
      // ?2004h/l wraps pasted input. The bytes between are INPUT being echoed, not the wrapper
      // reporting anything about itself.
      chunks: ['\x1b[?2004h', '\x1b]9;4;0;\x07', '\x1b[?2004l'],
    },
    {
      label: 'echoed input line',
      chunks: ['$ echo -e "\\x1b]9;4;0;\\x07"\n'],
    },
    {
      label: 'later cat of a transcript containing the escape',
      // The design's point in one line: the same bytes arrive again, minutes later, from a file.
      // Nothing in the stream distinguishes this from the original emission.
      chunks: ['$ cat turn.log\n', '\x1b]9;4;3;\x07some old transcript\x1b]9;4;0;\x07', '$ '],
    },
  ];
  for (const c of cases) {
    const { transitions } = transitionsFor(c.chunks);
    assertNoCompletionFact(transitions, c.label);
  }
});

test('osc_containment: OSC 133 is not promoted either, and 9;4 can never borrow its regex', () => {
  // OSC_133_RE has never fired on real traffic — zero hits across nine live PTY captures and the
  // repo fixtures — and it matches only A/B, which are prompt/command-START markers, not a paired
  // command-END fact. The containment property here is narrower and checkable: no 9;4 form, in any
  // arrangement, may satisfy the 133 detector.
  for (const bytes of [
    '\x1b]9;4;3;\x07', '\x1b]9;4;0;\x07', '\x1b]9;4;1;90\x07',
    ...CAPTURE_SLICES.map(s => s.bytes),
  ]) {
    assert.equal(OSC_133_RE.test(bytes), false,
      `OSC 9;4 must never match the OSC 133 prompt-mark detector: ${JSON.stringify(bytes)}`);
  }
  // And a real 133 A/B marker moves the machine to idle — which is precisely why 9;4 must not be
  // able to reach that detector. (What the marker is NAMED once it gets there is the cause matrix's
  // business, not this control's: asserting it here would re-couple the control to a Stage-A-only
  // export, which is how three of these controls were mis-wired in the first draft.)
  const { transitions } = transitionsFor(['\x1b]133;B\x07']);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].to, 'idle');
});

// --- §8.4 case 5: the source invariant -------------------------------------------------------
//
// The one case here that is RED against ca44782, by construction: it asserts the cutover happened.

test('osc_containment: 0.8.0 contains no terminal outcome validator or producer', () => {
  // §8.4.5. A behavioural control can only prove that today's inputs produce no completion; this
  // proves there is nothing for a future input to reach. The future 0.9.0 validator must also not
  // import the OSC parser or session-state — but it does not exist yet, so what is checkable now
  // is that no producer exists at all.
  const root = path.join(__dirname, '..');
  const sources = [
    'daemon.js',
    'session-state.js',
    'src/completion-observation.js',
    'src/report-enforcement.js',
    'src/session-store/persistence.js',
  ];
  // Emission sites, not prose: a broadcast/return/assignment of a terminal name. Comments and
  // CHANGELOG history legitimately still NAME the removed vocabulary — this release is the thing
  // that removed it, and forbidding the words would forbid explaining them.
  const PRODUCER_RE = /(broadcastSessionEvent|broadcastBusEvent)\(\s*['"`](TASK_COMPLETE|TASK_COMPLETE_WITH_REPORT|TASK_IDLE_UNCONFIRMED|TASK_ERROR|TASK_IDLE_NO_REPORT|TASK_DEAD_NO_REPORT)/;
  const TEXT_RE = /['"`]TASK_COMPLETE(_WITH_REPORT)?:/;

  for (const rel of sources) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return; // prose may name it
      assert.ok(!PRODUCER_RE.test(line),
        `${rel}:${i + 1} emits a terminal outcome event: ${line.trim()}`);
      assert.ok(!TEXT_RE.test(line),
        `${rel}:${i + 1} produces terminal outcome text: ${line.trim()}`);
    });
  }

  // The text classifier the design deleted must not have come back under its old name.
  //
  // report-enforcement is a pure module and safe to require. daemon.js is NOT: requiring it reads
  // the real $HOME at load, restores every live persisted session into this process and arms their
  // timers. This file has no reason to pay that cost — the absence of `resolveOutboundReportStatus`
  // is already asserted in completion-unknown-observation-60.test.js:339, which does the hermetic
  // HOME redirect first.
  assert.equal(typeof require('../src/report-enforcement').classifyReportPrompt, 'undefined',
    '0.8.0 classifies no report-shaped text');
});
