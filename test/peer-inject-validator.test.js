'use strict';

// #533 Phase 2 — peer-lane inject-validator (hard block) unit tests.
// Exercises the pure, self-contained classifyPeerLaneInject() exported from daemon.js.
// No server is started: require('../daemon') only runs the module body, which guards
// app.listen behind require.main === module / AIGENTRY_TELEPTY_DAEMON_MAIN.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyPeerLaneInject } = require('../daemon');

const ORCH = ['orchestrator', 'aigentry-orchestrator-claude'];

const askRequest = (over = {}) =>
  JSON.stringify({
    kind: 'ask-request',
    from: 'coder-a',
    to: 'coder-b',
    thread_id: 't1',
    round: 1,
    question: 'what is X?',
    reply_to: 'coder-a',
    ...over,
  });

const askReply = (over = {}) =>
  JSON.stringify({
    kind: 'ask-reply',
    from: 'coder-a',
    to: 'coder-b',
    thread_id: 't1',
    round: 1,
    answer: 'X is Y',
    ...over,
  });

// ── Scenario 1: peer work-delegation → BLOCKED ──────────────────────────────
test('peer work-delegation (no envelope) is BLOCKED', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: 'Implement foo() in bar.ts and report back when done.',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'peer');
  assert.equal(v.decision, 'block');
  assert.equal(v.kind, null);
  assert.equal(v.envelopePresent, false);
});

// ── Scenario 2: peer ask-request / ask-reply → ALLOWED ──────────────────────
test('peer ask-request envelope is ALLOWED', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: askRequest(),
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'peer');
  assert.equal(v.decision, 'allow');
  assert.equal(v.kind, 'ask-request');
});

test('peer ask-reply envelope is ALLOWED', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: askReply(),
    orchestratorSids: ORCH,
  });
  assert.equal(v.decision, 'allow');
  assert.equal(v.kind, 'ask-reply');
});

// ── Scenario 3: orchestrator↔peer → ALLOWED (untouched) ─────────────────────
test('orchestrator→peer with work-delegation prose is ALLOWED (orch lane)', () => {
  const v = classifyPeerLaneInject({
    from: 'orchestrator',
    to: 'coder-b',
    prompt: 'Implement foo() in bar.ts and report back.',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'orchestrator');
  assert.equal(v.decision, 'allow');
});

test('peer→orchestrator REPORT is ALLOWED (orch lane)', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-b',
    to: 'orchestrator',
    prompt: 'REPORT: task-DONE | ...',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'orchestrator');
  assert.equal(v.decision, 'allow');
});

test('second configured orchestrator sid is recognized', () => {
  const v = classifyPeerLaneInject({
    from: 'aigentry-orchestrator-claude',
    to: 'coder-b',
    prompt: 'anything goes',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'orchestrator');
  assert.equal(v.decision, 'allow');
});

// ── Scenario 4: empty orch-sid set → fail-OPEN ──────────────────────────────
test('empty orchestrator-sid set fails OPEN (validator disabled)', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: 'Implement foo() — raw work delegation that would otherwise be blocked.',
    orchestratorSids: [],
  });
  assert.equal(v.lane, 'disabled');
  assert.equal(v.decision, 'allow');
});

// ── Edge cases ──────────────────────────────────────────────────────────────
test('no sender (operator/CLI/multicast) is ALLOWED', () => {
  const v = classifyPeerLaneInject({
    from: undefined,
    to: 'coder-b',
    prompt: 'Implement foo()',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'orchestrator');
  assert.equal(v.decision, 'allow');
});

test('ask-request missing required field (question) is BLOCKED', () => {
  const env = JSON.parse(askRequest());
  delete env.question;
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: JSON.stringify(env),
    orchestratorSids: ORCH,
  });
  assert.equal(v.decision, 'block');
  assert.equal(v.envelopePresent, true);
});

test('non-integer round is BLOCKED', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: askRequest({ round: 1.5 }),
    orchestratorSids: ORCH,
  });
  assert.equal(v.decision, 'block');
});

test('envelope.from spoof (mismatch with inject from) is BLOCKED', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: askRequest({ from: 'coder-z' }),
    orchestratorSids: ORCH,
  });
  assert.equal(v.decision, 'block');
  assert.equal(v.reason, 'from-mismatch');
});

test('wrong kind on the peer lane is BLOCKED', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: JSON.stringify({ kind: 'report', from: 'coder-a', to: 'coder-b' }),
    orchestratorSids: ORCH,
  });
  assert.equal(v.decision, 'block');
  assert.equal(v.reason, 'wrong-kind');
  assert.equal(v.envelopePresent, true);
});

test('valid envelope on first line with trailing log lines is ALLOWED', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: askRequest() + '\n[telepty] submitted via pty_cr',
    orchestratorSids: ORCH,
  });
  assert.equal(v.decision, 'allow');
  assert.equal(v.kind, 'ask-request');
});

test('malformed JSON on the peer lane is BLOCKED (envelopePresent false)', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: 'coder-b',
    prompt: '{kind: ask-request, not valid json',
    orchestratorSids: ORCH,
  });
  assert.equal(v.decision, 'block');
  assert.equal(v.envelopePresent, false);
});

// ── #45: fan-out (broadcast/multicast) gate — sender-lane classification (to:null) ──
// The fan-out handlers classify by SENDER only (to:null) so a peer cannot earn fan-out
// rights by listing the orchestrator as one target. These lock that verdict contract.
test('#45 peer sender with no target (to:null) classifies as the PEER lane', () => {
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: null,
    prompt: 'echo anything',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'peer');
});

test('#45 peer sender with a sanctioned envelope is STILL the peer lane (fan-out operator-only)', () => {
  // decision may be 'allow' for single-inject, but lane stays 'peer' — the fan-out
  // gate blocks on lane, so a sanctioned peer envelope cannot fan out.
  const v = classifyPeerLaneInject({
    from: 'coder-a',
    to: null,
    prompt: askRequest(),
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'peer');
});

test('#45 orchestrator sender with no target (to:null) is the ORCHESTRATOR lane (fan-out allowed)', () => {
  const v = classifyPeerLaneInject({
    from: 'orchestrator',
    to: null,
    prompt: 'broadcast to the mesh',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'orchestrator');
  assert.equal(v.decision, 'allow');
});

test('#45 no-sender fan-out (operator/CLI, to:null) is the ORCHESTRATOR lane (allowed)', () => {
  const v = classifyPeerLaneInject({
    from: undefined,
    to: null,
    prompt: 'broadcast to the mesh',
    orchestratorSids: ORCH,
  });
  assert.equal(v.lane, 'orchestrator');
  assert.equal(v.decision, 'allow');
});
