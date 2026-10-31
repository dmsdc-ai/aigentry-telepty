'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionStateMachine, mapObservationCause } = require('../session-state');

function machine(t) {
  const sm = new SessionStateMachine('wrap-67', { idle_timeout_ms: 1000 }, {
    setInterval: () => null, clearInterval: () => {}
  });
  t.after(() => sm.destroy());
  return sm;
}

for (const wrap of ['/', '-', '|', '\\']) {
  test(`#67: shell prompt wrapping after ${wrap} settles with a quiet observation`, t => {
    const sm = machine(t);
    const transitions = [];
    sm.onTransition((from, to, meta) => transitions.push({ from, to, ...meta }));
    // Bash 3.2 wraps long prompts with bare CR rather than LF.
    sm.feed(`[USER: worker] /Users/runner/project${wrap}\r/project $ `);
    assert.equal(sm.getState().state, 'working', 'a path is not a busy indicator');
    sm._tick(Date.now() + 2000);
    const state = sm.getState();
    assert.equal(state.state, 'idle');
    assert.equal(state.detail.trigger, 'prompt_suffix_after_quiet');
    const observation = mapObservationCause({ destination: state.state,
      cause: state.detail.trigger, evidence: state.detail });
    assert.equal(observation.kind, 'prompt_suffix_after_quiet_observed');
    assert.equal(transitions.some(row => row.to === 'thinking'), false);
  });
}

test('#67: a spinner before a CR-overwritten shell prompt does not absorb quiet', t => {
  const sm = machine(t);
  sm.feed('| \r[USER: worker] /tmp/project $ ');
  assert.equal(sm.getState().state, 'working');
  sm._tick(Date.now() + 2000);
  assert.equal(sm.getState().detail.trigger, 'prompt_suffix_after_quiet');
});

test('#67: a path containing slash-space is not an ASCII spinner frame', t => {
  const sm = machine(t);
  sm.feed('[USER: worker] /tmp/path/ with spaces $ ');
  assert.equal(sm.getState().state, 'working');
});

for (const spinner of ['|', '/', '-', '\\']) {
  test(`#67 control: standalone ${spinner} remains thinking during ordinary quiet`, t => {
    const sm = machine(t);
    sm.feed(`${spinner} `);
    assert.equal(sm.getState().state, 'thinking');
    sm._tick(Date.now() + 2000);
    assert.equal(sm.getState().state, 'thinking', 'silence does not establish an AI turn boundary');
  });
}

test('#67 control: active AI work is still thinking after a bare CR repaint', t => {
  const sm = machine(t);
  sm.feed('/old/path\r⠋ Processing...');
  assert.equal(sm.getState().state, 'thinking');
  sm._tick(Date.now() + 2000);
  assert.equal(sm.getState().state, 'thinking');
});
