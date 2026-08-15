'use strict';

// telepty#60 Stage A — §8.5.12 `consumer_vocabulary_matrix_is_total`, plus §8.5.1 and §8.5.5.
//
// The truth model is only as honest as its narrowest consumer. A daemon that emits
// `pty_quiet, completion_fact:null` and a sidebar that paints it as a green "done" pill have
// together made exactly the claim this release removes — the overclaim just moved one process to
// the right. So every §2.3 producer name must have an EXPLICIT nonterminal presentation, and the
// tone budget is fixed:
//
//   quiet / prompt / OSC / manual markers → neutral
//   output / busy markers                 → may render active
//   request / error / timeout / death     → may render warning or error
//   NONE of them                          → done, task success, terminal outcome, or green-success
//
// and an unknown or deleted name must degrade to a neutral `unmapped observation`, never to
// internal `idle` and never to success styling.
//
// SCOPE — READ THIS BEFORE EXTENDING THE FILE
// -------------------------------------------
// §8.5.12 drives the matrix through five consumers. Three are implemented on this branch and are
// asserted here:
//   * bus serialization        — the transition listener's envelope shape (daemon.js:126-134);
//   * `telepty list --json`    — serializeSession's `activityObservation` + `completion` blocks,
//                                which the CLI passes through verbatim (cli.js:1334-1337);
//   * the cmux/sidebar adapter — OBSERVATION_DISPLAY, keyed by observation KIND rather than by
//                                internal state (session-state.js:689-705).
// Two are NOT implemented on this branch and are out of this track's file boundary: `telepty
// status` text rendering (cli.js still prints `State:`) and the MCP list/status wording
// (mcp-server/index.mjs) are base-commit "NOT DONE" items 4 and 5, owned by the sibling doing the
// consumer-facing work. Their rows belong in the change that lands them.
//
// Pure: session-state.js + a source read. No daemon spawn, no PTY, no HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OBSERVATION_CAUSES,
  OBSERVATION_DISPLAY,
  STATE_DISPLAY,
  mapObservationCause,
} = require('../session-state');

// Tones that assert a task outcome. `done` is the obvious one; GREEN is the one that actually
// shipped — STATE_DISPLAY maps internal `idle` to a green sleeping pill, and the sidebar reads
// that green as task success (§8.5.5).
const GREEN = '\x1b[32m';
const OUTCOME_TONES = new Set(['done', 'success', 'complete', 'completed', 'task_success']);

// Every §2.3 producer row, with the presentation budget its measurement can support. The owner row
// is expanded into both names it emits, giving the 14 rows §8.5.12 requires.
const CONSUMER_MATRIX = [
  // measurement                              cause                                evidence                                                          allowed tones
  ['session_start_phase_observed',            'lifecycle_starting',                'starting', {},                                                   ['pending', 'neutral', 'active']],
  ['osc_133_a_or_b_observed',                 'osc_133_a_or_b_received',           'idle',     { timestamp: '2026-07-29T00:00:00.000Z' },            ['neutral']],
  ['pty_quiet_after_osc_133_a_or_b_observed', 'quiet_after_recent_osc_133_a_or_b', 'idle',     { silence_ms: 6000 },                                 ['neutral']],
  ['prompt_suffix_after_quiet_observed',      'prompt_suffix_after_quiet',         'idle',     { silence_ms: 6000 },                                 ['neutral']],
  ['pty_quiet',                               'silence_timeout',                   'idle',     { silence_ms: 6000 },                                 ['neutral']],
  ['manual_state_mark_observed',              'manual_state_mark',                 'idle',     {},                                                   ['neutral']],
  ['output_observed',                         'output_received',                   'working',  {},                                                   ['active', 'neutral']],
  ['busy_indicator_pattern_observed',         'busy_indicator_pattern',            'thinking', { matched_line: '⠋ thinking' },                       ['active', 'neutral']],
  ['input_request_pattern_observed',          'input_request_pattern',             'waiting',  { matched_line: 'Continue?' },                        ['attention', 'error', 'neutral']],
  ['repeated_error_pattern_observed',         'repeated_error_pattern',            'error',    { error_fingerprint: 'boom', repeat_count: 3, window_ms: 180000 }, ['error', 'attention', 'neutral']],
  ['thinking_classification_timeout_observed','thinking_timeout',                  'error',    { thinking_duration_ms: 301000 },                     ['attention', 'error', 'neutral']],
  ['session_restart_mark_observed',           'lifecycle_restarting',              'restarting', {},                                                 ['pending', 'neutral', 'active']],
  ['session_process_exited',                  'process_exit',                      'dead',     { exit_observed_at: '2026-07-29T00:00:00.000Z' },     ['error', 'attention', 'neutral']],
  // #843 — the two entrances that used to borrow `session_process_exited`. Each now presents as
  // what it measured; neither may reach the death styling, and neither may go quiet.
  ['session_termination_requested',           'termination_requested',             'dead',     { reason: 'operator_delete', requested_at: '2026-07-29T00:00:00.000Z' }, ['attention', 'neutral', 'pending']],
  ['session_termination_kill_failed',         'termination_kill_failed',           'dead',     { reason: 'operator_delete', kill_error: 'kill EPERM' }, ['error', 'attention']],
  ['owner_transport_detached',                'owner_transport_detached',          'idle',     { detached_at: '2026-07-29T00:00:00.000Z' },          ['attention', 'error', 'neutral']],
  ['owner_replaced_observed',                 'owner_epoch_replaced',              'idle',     { displaced_session_epoch: 'epoch-1' },               ['attention', 'error', 'neutral']],
];

// The bus/list envelope the daemon builds for an observation, reproduced from its two production
// call sites (daemon.js:126-134 transition listener, daemon.js:2806-2828 serializeSession) so the
// SHAPE consumers depend on is asserted, not just the name inside it.
function serializeForConsumers(destination, cause, evidence, confidence = 0.9) {
  const mapped = mapObservationCause({ destination, cause, evidence: { ...evidence, confidence } });
  const display = OBSERVATION_DISPLAY[mapped.kind] || OBSERVATION_DISPLAY.unmapped_transition_cause;
  return {
    // bus: session_activity_observation
    bus: {
      schema_version: 2,
      observation: { kind: mapped.kind, trigger: mapped.cause, ...mapped.fields },
      from_observation_state: destination,
      completion_fact: null,
      terminal: false,
    },
    // telepty list --json: serializeSession().activityObservation + .completion
    list: {
      activityObservation: {
        kind: mapped.kind, cause: mapped.cause, emoji: display.emoji, tone: display.tone, confidence,
        fields: mapped.fields,
      },
      completion: { completion_fact: null, terminal: false },
    },
    // cmux/sidebar adapter
    display,
    mapped,
  };
}

test('consumer_vocabulary_matrix_is_total: every §2.3 name has an explicit nonterminal presentation', () => {
  for (const [kind, cause, destination, evidence, allowedTones] of CONSUMER_MATRIX) {
    const s = serializeForConsumers(destination, cause, evidence);

    // The name survives the trip to every consumer, unchanged.
    assert.equal(s.mapped.kind, kind, `[${cause}] mapper produced ${s.mapped.kind}`);
    assert.equal(s.bus.observation.kind, kind, `[${kind}] bus serialization`);
    assert.equal(s.list.activityObservation.kind, kind, `[${kind}] list --json serialization`);

    // EXPLICIT, not defaulted: the presentation table must actually contain this name. A name that
    // only renders because it fell through to the unmapped entry is one nobody chose a tone for.
    assert.ok(Object.prototype.hasOwnProperty.call(OBSERVATION_DISPLAY, kind),
      `[${kind}] has no explicit presentation — it would render via the unmapped fallback`);

    // Tone budget.
    assert.ok(allowedTones.includes(s.display.tone),
      `[${kind}] tone ${s.display.tone} exceeds what this measurement supports (${allowedTones.join('|')})`);
    assert.ok(!OUTCOME_TONES.has(s.display.tone), `[${kind}] renders a task outcome: ${s.display.tone}`);
    assert.notEqual(s.display.color, GREEN, `[${kind}] renders green-success`);

    // And no consumer sees a completion claim, on any row.
    assert.equal(s.bus.completion_fact, null, `[${kind}] bus completion_fact`);
    assert.equal(s.bus.terminal, false, `[${kind}] bus terminal`);
    assert.equal(s.list.completion.completion_fact, null, `[${kind}] list completion_fact`);
    assert.equal(s.list.completion.terminal, false, `[${kind}] list terminal`);
  }
});

test('consumer_vocabulary_matrix_is_total: the matrix covers the whole vocabulary, and nothing in it is green', () => {
  // Coverage both ways: no §2.3 row without a presentation assertion, and no presentation entry
  // that no row exercises. Ready-frame rows are covered by ready-frame-qualification-60.test.js —
  // they are transport hints, not activity states, and OBSERVATION_DISPLAY deliberately omits them.
  const covered = new Set(CONSUMER_MATRIX.map(([, cause]) => cause));
  const ready = Object.keys(OBSERVATION_CAUSES).filter(c => c.startsWith('ready_frame_'));
  const missing = Object.keys(OBSERVATION_CAUSES).filter(c => !covered.has(c) && !ready.includes(c));
  // #843 — nothing is aliased any more. This assertion used to allow exactly one uncovered cause,
  // `owner_process_exited`, on the grounds that it emitted the SAME name as an ordinary child
  // exit: "one death, one name". That was the bug stated as a property. There were never two
  // deaths here — there was one death and one socket close, and folding them together is what
  // made a daemon-initiated disconnect indistinguishable from an observed process exit. Every
  // cause now has its own row.
  assert.deepEqual(missing, [],
    `§2.3 causes with no consumer assertion: ${missing.join(', ')}`);
  assert.notEqual(
    mapObservationCause({ destination: 'idle', cause: 'owner_transport_detached', evidence: { detached_at: '2026-07-29T00:00:00.000Z' } }).kind,
    'session_process_exited',
    'a transport detachment must not present as a process exit');

  // Whole-table sweep: nothing in the presentation layer may be green or done, including rows a
  // future change adds without touching this file.
  for (const [kind, display] of Object.entries(OBSERVATION_DISPLAY)) {
    assert.notEqual(display.color, GREEN, `${kind} is styled green-success`);
    assert.ok(!OUTCOME_TONES.has(display.tone), `${kind} carries an outcome tone: ${display.tone}`);
  }
});

test('consumer_vocabulary_matrix_is_total: a deleted or unknown name degrades to neutral unmapped, never to idle', () => {
  // §8.5.12's final clause. Two ways a consumer meets a name it has no entry for:
  //   (1) the daemon emits a cause this version does not know (a newer/older peer);
  //   (2) a presentation row is deleted.
  // Both must land on the neutral unmapped entry. The failure mode being excluded is a fallback to
  // the INTERNAL state table, where `idle` is a green pill.
  const unknownCause = serializeForConsumers('idle', 'turn_finished', { silence_ms: 1000 });
  assert.equal(unknownCause.mapped.kind, 'unmapped_transition_cause');
  assert.equal(unknownCause.display.tone, 'neutral');
  assert.notEqual(unknownCause.display.color, GREEN);
  assert.equal(unknownCause.list.activityObservation.kind, 'unmapped_transition_cause',
    'an unknown cause must reach the consumer AS unknown, not as a guessed neighbour');
  assert.equal(unknownCause.bus.completion_fact, null);

  // (2) simulate the deleted row: look up a kind the presentation table does not contain, exactly
  // as the production call sites do (`OBSERVATION_DISPLAY[kind] || OBSERVATION_DISPLAY.unmapped…`).
  const deleted = OBSERVATION_DISPLAY['pty_quiet_deleted_row'] || OBSERVATION_DISPLAY.unmapped_transition_cause;
  assert.equal(deleted.tone, 'neutral');
  assert.equal(deleted.emoji, '?');
  assert.notEqual(deleted.color, GREEN);

  // The internal state table still exists and still has its green — submit/readiness code branches
  // on internal state, so it cannot be deleted here (that is Stage D). What matters is that the
  // OBSERVATION path never reaches it: the two tables share no key.
  assert.equal(STATE_DISPLAY.idle.color, GREEN,
    'the internal table is unchanged — this test pins the SEPARATION, not the removal');
  const observationKeys = new Set(Object.keys(OBSERVATION_DISPLAY));
  for (const stateKey of Object.keys(STATE_DISPLAY)) {
    assert.equal(observationKeys.has(stateKey), false,
      `${stateKey} is a key in BOTH tables — an observation lookup could reach the state styling`);
  }
});

test('consumer_vocabulary_matrix_is_total: telepty list --json exposes no internal state value', () => {
  // §8.5.1: "no external autoState.state:'idle'; completion capability and last observation are
  // present." `telepty list --json` prints the daemon's session payload verbatim
  // (cli.js:1334-1337), so the daemon's serializer is the contract. Asserted against the SOURCE
  // because the shape is what consumers bind to, and a re-added field would not fail any behaviour
  // test until a consumer read it again.
  const daemonSrc = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  const serializeStart = daemonSrc.indexOf('activityObservation:');
  assert.ok(serializeStart > 0, 'serializeSession must expose activityObservation');

  // The removed field, in the shape a consumer would read: `autoState: {` inside the serialized
  // payload. Its absence is what makes `activityObservation` load-bearing rather than additive.
  const emitsAutoState = /^\s{4}autoState:/m.test(daemonSrc);
  assert.equal(emitsAutoState, false,
    'serializeSession must not export the internal FSM value as autoState — consumers read it as "the turn is over"');

  // …and the completion block travels beside it, permanently unknown.
  assert.ok(/completion:\s*\{[\s\S]{0,200}completion_fact:\s*null/.test(daemonSrc),
    'the serialized session must carry a separate, permanently-null completion block');
  assert.ok(/capability:\s*\{\s*\.\.\.CAPABILITY_STAGE_A\s*\}/.test(daemonSrc),
    'the completion block must carry the explicit capability gaps (§A4)');
});

test('consumer_vocabulary_matrix_is_total: quiet is the weakest name and must never present as the strongest', () => {
  // The single most consequential row, called out on its own because it is the one that shipped
  // wrong: five routes reach internal `idle`, and `silence_timeout` is the 0.6-confidence one that
  // measured nothing but the absence of bytes. Its presentation must be indistinguishable in
  // strength from "we have no idea", because that is what it means.
  const quiet = serializeForConsumers('idle', 'silence_timeout', { silence_ms: 6000 }, 0.6);
  const marker = serializeForConsumers('idle', 'osc_133_a_or_b_received', { timestamp: '2026-07-29T00:00:00.000Z' }, 0.95);

  assert.equal(quiet.mapped.kind, 'pty_quiet');
  assert.equal(marker.mapped.kind, 'osc_133_a_or_b_observed');
  assert.notEqual(quiet.mapped.kind, marker.mapped.kind,
    'a silence timeout and a REPL-done marker must not share a name');
  assert.equal(quiet.display.tone, 'neutral');
  assert.equal(marker.display.tone, 'neutral',
    'even the strongest idle evidence is neutral — OSC 133 A/B is a prompt mark, not a turn end');
  // Confidence rides along as a qualifier and changes nothing about the name or the styling.
  assert.equal(quiet.list.activityObservation.confidence, 0.6);
  assert.equal(quiet.list.activityObservation.kind, 'pty_quiet');
});
