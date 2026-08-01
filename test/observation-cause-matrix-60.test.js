'use strict';

// telepty#60 Stage A — §8.1 `every_state_entrance_has_literal_observation`,
// `error_state_entrances_are_trigger_truthful`, `waiting_transition_reports_absence` and
// `external_idle_is_renamed`.
//
// The defect this pins: the external name used to be selected from the DESTINATION STATE. Five
// unrelated routes reach internal `idle`, so a 0.6-confidence silence timeout serialized exactly
// like an OSC-133 REPL-done mark, and a repeated-error entrance serialized exactly like a thinking
// classification that merely timed out. A name is a claim (§A3): it must carry only what its own
// entrance measured.
//
// The file has two halves, and they fail for different reasons on purpose:
//
//   (1) PRODUCER normalization, driven through the REAL SessionStateMachine. The overloaded
//       trigger strings (`pattern` for both waiting and thinking, `lifecycle` for start/restart/
//       death, `osc_133_prompt` for both the raw marker and quiet-after-a-marker) are normalized at
//       their producers. Nothing is seeded here — the machine is fed bytes and ticked, and its own
//       emitted detail is read back.
//   (2) The MAPPER matrix over all 14 §2.3 rows, plus the fail-closed behaviour that is the whole
//       point: an unknown cause, a cause arriving at a destination it is not defined for, and a
//       cause missing its required evidence must ALL return `unmapped_transition_cause` — never a
//       state-name fallback, because that fallback is exactly how a weak cause inherits a strong
//       name.
//
// Pure: session-state.js only. No daemon, no PTY, no HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SessionStateMachine,
  OBSERVATION_CAUSES,
  mapObservationCause,
  DEFAULT_CONFIG,
} = require('../session-state');

// Drive a machine and collect every transition it fires. `destroy()` clears the 1s poll interval —
// without it each machine leaks a timer into the test process.
function withMachine(fn, config = {}) {
  const sm = new SessionStateMachine('probe', config);
  const seen = [];
  sm.onTransition((from, to, detail) => seen.push({ from, to, detail: detail.detail, confidence: detail.confidence }));
  try {
    return fn(sm, seen);
  } finally {
    sm.destroy();
  }
}

const last = (seen) => seen[seen.length - 1];

// =============================================================================================
// (1) PRODUCER normalization — every entrance names its own measurement
// =============================================================================================

test('every_state_entrance_has_literal_observation: the waiting entrance names an input request, not "pattern"', () => {
  // WAITING and THINKING both used the bare trigger `pattern`. One means "the session is asking a
  // human a question"; the other means "a spinner is turning". Collapsing them let a spinner match
  // serialize as a blocked-on-input observation and vice versa.
  const { detail, to } = withMachine((sm, seen) => {
    sm.feed('Do you want to proceed?\n');
    return last(seen);
  });
  assert.equal(to, 'waiting');
  assert.equal(detail.trigger, 'input_request_pattern');
  assert.equal(typeof detail.matched_line, 'string');
});

test('every_state_entrance_has_literal_observation: the thinking entrance names a busy indicator, not "pattern"', () => {
  const { detail, to } = withMachine((sm, seen) => {
    sm.feed('⠋ thinking\n');
    return last(seen);
  });
  assert.equal(to, 'thinking');
  assert.equal(detail.trigger, 'busy_indicator_pattern');
  assert.equal(typeof detail.matched_line, 'string');
});

test('every_state_entrance_has_literal_observation: start, restart and death no longer share "lifecycle"', () => {
  // Three measurements with nothing in common. `markStarting` says a PTY is coming up, `markDead`
  // says a process exited, `markRestarting` says an operator/supervisor decision was taken — and
  // all three used to serialize as the single string `lifecycle`.
  const starting = withMachine((sm, seen) => {
    sm.feed('boot\n');          // leave STARTING first, so markStarting is a real transition
    sm.markStarting();
    return last(seen);
  });
  assert.equal(starting.to, 'starting');
  assert.equal(starting.detail.trigger, 'lifecycle_starting');

  const restarting = withMachine((sm, seen) => {
    sm.markRestarting();
    return last(seen);
  });
  assert.equal(restarting.to, 'restarting');
  assert.equal(restarting.detail.trigger, 'lifecycle_restarting');

  const dead = withMachine((sm, seen) => {
    sm.markDead(1, null);
    return last(seen);
  });
  assert.equal(dead.to, 'dead');
  assert.equal(dead.detail.trigger, 'process_exit');
  assert.equal(dead.detail.exit_code, 1);
});

test('every_state_entrance_has_literal_observation: the raw OSC 133 marker and quiet-after-a-marker are different measurements', () => {
  // Both used `osc_133_prompt`, which let a quiet TIMEOUT borrow the authority of a marker it never
  // saw. The marker is a byte that arrived; the quiet is an inference drawn later, near it.
  const raw = withMachine((sm, seen) => {
    sm.feed('\x1b]133;B\x07');
    return last(seen);
  });
  assert.equal(raw.to, 'idle');
  assert.equal(raw.detail.trigger, 'osc_133_a_or_b_received');
  assert.equal(typeof raw.detail.timestamp, 'string');

  const quiet = withMachine((sm, seen) => {
    sm.feed('\x1b]133;B\x07');       // marker arrives …
    sm.feed('some output\n');        // … then real output moves us off idle …
    sm._tick(Date.now() + 6000);     // … and 6s of silence later the tick fires (marker still recent)
    return last(seen);
  });
  assert.equal(quiet.to, 'idle');
  assert.equal(quiet.detail.trigger, 'quiet_after_recent_osc_133_a_or_b');
  assert.ok(Number.isFinite(quiet.detail.silence_ms));
});

test('external_idle_is_renamed: a silence-timeout idle is pty_quiet with a silence basis, never "idle"', () => {
  // §8.5.1/§3.8: the internal FSM value is not the external name. A 0.6-confidence "nothing
  // happened for 5 seconds" is the weakest signal the machine produces, and exporting it as `idle`
  // is what the sidebar rendered as a green sleeping pill, i.e. task success.
  const entrance = withMachine((sm, seen) => {
    sm.feed('build output with no prompt shape\n');
    sm._tick(Date.now() + 6000);
    return last(seen);
  });
  assert.equal(entrance.to, 'idle', 'the INTERNAL state is still idle — submit/readiness code branches on it');
  assert.equal(entrance.detail.trigger, 'silence_timeout');

  const mapped = mapObservationCause({
    destination: entrance.to,
    cause: entrance.detail.trigger,
    evidence: { ...entrance.detail, confidence: entrance.confidence },
  });
  assert.equal(mapped.kind, 'pty_quiet', `expected "pty_quiet", got ${JSON.stringify(mapped.kind)}`);
  assert.equal(mapped.cause, 'silence_timeout');
  assert.ok(Number.isFinite(mapped.fields.silence_ms));
});

test('external_idle_is_renamed: a prompt-shaped suffix is its own observation, not a REPL-done mark', () => {
  // A `$ ` at the end of a frame is a detector match on untrusted current-frame bytes. It is not a
  // turn boundary, and it must not share a name with one.
  const entrance = withMachine((sm, seen) => {
    sm.feed('user@host:~$ ');
    sm._tick(Date.now() + 6000);
    return last(seen);
  });
  assert.equal(entrance.detail.trigger, 'prompt_suffix_after_quiet');
  const mapped = mapObservationCause({
    destination: 'idle', cause: entrance.detail.trigger, evidence: entrance.detail,
  });
  assert.equal(mapped.kind, 'prompt_suffix_after_quiet_observed');
});

test('every_state_entrance_has_literal_observation: markIdle is a caller mark and a caller cannot dress it up', () => {
  // `markIdle` spreads caller detail BEFORE the normalized cause. It used to spread it last, so any
  // caller passing `trigger` could present a bare mark as a screen-derived measurement.
  const entrance = withMachine((sm, seen) => {
    sm.feed('output\n');
    sm.markIdle(1.0, { trigger: 'osc_133_a_or_b_received', timestamp: new Date().toISOString() });
    return last(seen);
  });
  assert.equal(entrance.to, 'idle');
  assert.equal(entrance.detail.trigger, 'manual_state_mark',
    'a caller-supplied trigger must never overwrite the normalized cause');
  const mapped = mapObservationCause({ destination: 'idle', cause: entrance.detail.trigger, evidence: entrance.detail });
  assert.equal(mapped.kind, 'manual_state_mark_observed');
});

// =============================================================================================
// (2) §8.1 error_state_entrances_are_trigger_truthful — both ERROR entrances, driven for real
// =============================================================================================

test('error_state_entrances_are_trigger_truthful: repeated error text and a thinking timeout are different observations', () => {
  // (A) three identical error lines inside the 180s window — a fingerprint that actually repeated.
  const a = withMachine((sm, seen) => {
    for (let i = 0; i < DEFAULT_CONFIG.error_repeat_count; i++) sm.feed('deploy failed\n');
    return last(seen);
  });
  assert.equal(a.to, 'error');
  assert.equal(a.detail.trigger, 'repeated_error_pattern');
  const mappedA = mapObservationCause({ destination: a.to, cause: a.detail.trigger, evidence: a.detail });
  assert.equal(mappedA.kind, 'repeated_error_pattern_observed');
  assert.equal(mappedA.fields.error_fingerprint, 'deploy failed');
  assert.equal(mappedA.fields.repeat_count, DEFAULT_CONFIG.error_repeat_count);
  assert.equal(mappedA.fields.window_ms, DEFAULT_CONFIG.error_window_ms);
  assert.equal(mappedA.fields.thinking_duration_ms, undefined);

  // (B) a thinking pattern that simply ran past the 300s classification timeout. NOTHING failed
  // here: the classifier gave up. Naming this `repeated_error_pattern_observed` — which a
  // destination-state mapper necessarily would, since both land in ERROR — asserts observed error
  // text that never existed.
  const b = withMachine((sm, seen) => {
    sm.feed('⠋ thinking\n');
    sm._tick(Date.now() + DEFAULT_CONFIG.thinking_timeout_ms + 1000);
    return last(seen);
  });
  assert.equal(b.to, 'error');
  assert.equal(b.detail.trigger, 'thinking_timeout');
  const mappedB = mapObservationCause({ destination: b.to, cause: b.detail.trigger, evidence: b.detail });
  assert.equal(mappedB.kind, 'thinking_classification_timeout_observed');
  assert.ok(Number.isFinite(mappedB.fields.thinking_duration_ms));
  assert.equal(mappedB.fields.error_fingerprint, undefined, 'a timeout observed no error text');
  assert.equal(mappedB.fields.repeat_count, undefined);

  // Both land in the same internal state and MUST NOT share an external name.
  assert.notEqual(mappedA.kind, mappedB.kind);
});

test('waiting_transition_reports_absence: WAITING is absorbing and keeps its own literal name', () => {
  // §8.1 predicted `timed out waiting for task_completion_unknown after waiting transition`, and
  // the hazard behind it: WAITING is absorbing (session-state.js:403-405), so a dispatch parks
  // there forever. A 600s tick must NOT quietly relabel it as quiet/idle — the session is not
  // quiet, it is blocked on a human.
  const { seen, state } = withMachine((sm, collected) => {
    sm.feed('Continue?\n');
    sm._tick(Date.now() + 600_000);
    return { seen: collected, state: sm.getState() };
  });
  const waiting = seen.filter(s => s.to === 'waiting');
  assert.equal(waiting.length, 1, `expected exactly one waiting entrance, got ${waiting.length}`);
  assert.equal(waiting[0].detail.trigger, 'input_request_pattern');
  assert.equal(state.state, 'waiting', 'the 600s tick must not move an absorbing WAITING to idle');
  assert.equal(seen[seen.length - 1].to, 'waiting', 'no later transition may fire from the tick');

  const mapped = mapObservationCause({ destination: 'waiting', cause: waiting[0].detail.trigger, evidence: waiting[0].detail });
  assert.equal(mapped.kind, 'input_request_pattern_observed');
  assert.equal(typeof mapped.fields.matched_line, 'string');
});

// =============================================================================================
// (2) The mapper matrix — all 14 §2.3 producer rows, plus fail-closed
// =============================================================================================

// Every row of §2.3, with the evidence its `requires` list demands. The owner row expands to the
// two names it actually emits (#815 lifecycle facts consumed by Stage A — neither is an outcome).
const VOCABULARY_MATRIX = [
  ['lifecycle_starting',                'starting', {},                                                            'session_start_phase_observed'],
  ['osc_133_a_or_b_received',           'idle',     { timestamp: '2026-07-29T00:00:00.000Z' },                     'osc_133_a_or_b_observed'],
  ['quiet_after_recent_osc_133_a_or_b', 'idle',     { silence_ms: 6000 },                                          'pty_quiet_after_osc_133_a_or_b_observed'],
  ['prompt_suffix_after_quiet',         'idle',     { silence_ms: 6000 },                                          'prompt_suffix_after_quiet_observed'],
  ['silence_timeout',                   'idle',     { silence_ms: 6000 },                                          'pty_quiet'],
  ['manual_state_mark',                 'idle',     {},                                                            'manual_state_mark_observed'],
  ['output_received',                   'working',  {},                                                            'output_observed'],
  ['busy_indicator_pattern',            'thinking', { matched_line: '⠋ thinking' },                                'busy_indicator_pattern_observed'],
  ['input_request_pattern',             'waiting',  { matched_line: 'Continue?' },                                 'input_request_pattern_observed'],
  ['repeated_error_pattern',            'error',    { error_fingerprint: 'deploy failed', repeat_count: 3, window_ms: 180000 }, 'repeated_error_pattern_observed'],
  ['thinking_timeout',                  'error',    { thinking_duration_ms: 301000 },                              'thinking_classification_timeout_observed'],
  ['lifecycle_restarting',              'restarting', {},                                                          'session_restart_mark_observed'],
  ['process_exit',                      'dead',     {},                                                            'session_process_exited'],
  ['owner_epoch_replaced',              'idle',     { displaced_session_epoch: 'epoch-1' },                        'owner_replaced_observed'],
  ['owner_process_exited',              'idle',     {},                                                            'session_process_exited'],
];

test('every_state_entrance_has_literal_observation: every §2.3 producer row maps to its own name and fields', () => {
  for (const [cause, destination, evidence, expectedKind] of VOCABULARY_MATRIX) {
    const mapped = mapObservationCause({ destination, cause, evidence });
    assert.equal(mapped.kind, expectedKind,
      `[${cause}@${destination}] expected ${expectedKind}, got ${mapped.kind}`);
    assert.equal(mapped.cause, cause, `[${cause}] the measured cause must survive into the observation`);
    // Only the fields the row declares — a name may not travel with evidence it did not require.
    for (const required of OBSERVATION_CAUSES[cause].requires) {
      assert.equal(mapped.fields[required], evidence[required],
        `[${cause}] required field ${required} missing from the emitted observation`);
    }
  }
});

test('every_state_entrance_has_literal_observation: the matrix covers the whole table, with no unnamed row', () => {
  // A row added to OBSERVATION_CAUSES without a matrix row here would ship an external name nothing
  // ever asserted. Ready-frame rows are covered in ready-frame-qualification-60.test.js.
  const covered = new Set(VOCABULARY_MATRIX.map(([cause]) => cause));
  const readyRows = Object.keys(OBSERVATION_CAUSES).filter(c => c.startsWith('ready_frame_'));
  const uncovered = Object.keys(OBSERVATION_CAUSES).filter(c => !covered.has(c) && !readyRows.includes(c));
  assert.deepEqual(uncovered, [], `§2.3 rows with no assertion: ${uncovered.join(', ')}`);
  assert.equal(covered.size + readyRows.length, Object.keys(OBSERVATION_CAUSES).length);
});

test('every_state_entrance_has_literal_observation: an unmapped cause fails closed, never to a state name', () => {
  // The three fail-closed shapes, each asserting the SAME thing: no state-name fallback. If the
  // mapper fell back to the destination, every one of these would return the strong name belonging
  // to some other entrance that happens to share the state.
  const cases = [
    {
      label: 'unknown cause (an OLD overloaded trigger string) arriving at idle',
      // `osc_133_prompt` is the pre-Stage-A name that meant BOTH the raw marker and quiet-after-it.
      // A daemon still emitting it must not have it silently accepted as either.
      input: { destination: 'idle', cause: 'osc_133_prompt', evidence: { silence_ms: 6000 } },
      reason: 'unknown_cause',
    },
    {
      label: 'a real cause arriving at a destination it is not defined for',
      input: { destination: 'idle', cause: 'repeated_error_pattern', evidence: { error_fingerprint: 'x', repeat_count: 3, window_ms: 180000 } },
      reason: 'cause_destination_mismatch',
    },
    {
      label: 'a real cause missing the evidence its name is made of',
      input: { destination: 'error', cause: 'repeated_error_pattern', evidence: { error_fingerprint: 'x' } },
      reason: 'missing_evidence:repeat_count,window_ms',
    },
    {
      label: 'no cause at all',
      input: { destination: 'idle', evidence: {} },
      reason: 'unknown_cause',
    },
  ];
  for (const c of cases) {
    const mapped = mapObservationCause(c.input);
    assert.equal(mapped.kind, 'unmapped_transition_cause',
      `[${c.label}] expected unmapped_transition_cause, got ${mapped.kind}`);
    assert.equal(mapped.fields.reason, c.reason, `[${c.label}] the reason must be named`);
    // The raw destination and trigger are preserved so an operator can see what arrived …
    assert.equal(mapped.fields.destination, c.input.destination);
    // … and the destination NEVER becomes the name.
    assert.notEqual(mapped.kind, c.input.destination);
  }
});

test('every_state_entrance_has_literal_observation: a removed mapping degrades to unmapped, not to a neighbour', () => {
  // §8.1: "delete one mapping and assert `unmapped_transition_cause`, never a destination-state
  // fallback." OBSERVATION_CAUSES is frozen, so the deletion is simulated the only way it can be
  // observed from outside: ask for a row that is not in the table, at a destination that HAS other
  // rows. `silence_timeout` and `manual_state_mark` both live at `idle`, so a fallback of any kind
  // would have a plausible name to reach for here — and must not.
  const mapped = mapObservationCause({ destination: 'idle', cause: 'silence_timeout_v3', evidence: { silence_ms: 6000 } });
  assert.equal(mapped.kind, 'unmapped_transition_cause');
  assert.equal(mapped.cause, 'silence_timeout_v3');
  assert.equal(mapped.fields.silence_ms, undefined,
    'an unmapped observation may not carry the evidence fields of the row it resembles');
});

test('every_state_entrance_has_literal_observation: qualifiers ride along only when measured', () => {
  // `confidence` qualifies the classifier; it never manufactures missing evidence and never
  // qualifies completion. `elapsed_ms` is a field, not a threshold — elapsed time was never a
  // completion floor (§7 item 8).
  const bare = mapObservationCause({ destination: 'idle', cause: 'silence_timeout', evidence: { silence_ms: 6000 } });
  assert.equal(bare.fields.confidence, undefined);
  assert.equal(bare.fields.elapsed_ms, undefined);
  assert.equal(bare.fields.last_output_at, undefined);

  const qualified = mapObservationCause({
    destination: 'idle',
    cause: 'silence_timeout',
    evidence: { silence_ms: 6000, confidence: 0.6, elapsed_ms: 30000, last_output_at: '2026-07-29T00:00:00.000Z' },
  });
  assert.equal(qualified.fields.confidence, 0.6);
  assert.equal(qualified.fields.elapsed_ms, 30000);
  assert.equal(qualified.fields.last_output_at, '2026-07-29T00:00:00.000Z');
  // …and the name is still the weakest one. A qualifier cannot promote a measurement.
  assert.equal(qualified.kind, 'pty_quiet');
});
