'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const WebSocket = require('ws');
const { buildSharedContextPrompt, createSharedContextDescriptor, getSharedContextDir } = require('../shared-context');
const { createSessionId, startTestDaemon, stripAnsi, waitFor } = require('../test-support/daemon-harness');

let harness;
const projectRoot = path.resolve(__dirname, '..');
const TERMINAL_CLEANUP_SEQUENCE = '\x1b[<u\x1b[>4;0m\x1b[?2004l';

function countOccurrences(value, pattern) {
  let count = 0;
  let index = 0;

  while (true) {
    index = value.indexOf(pattern, index);
    if (index === -1) {
      return count;
    }
    count += 1;
    index += pattern.length;
  }
}

function collectJsonMessages(ws) {
  const messages = [];
  ws.on('message', (chunk) => {
    try {
      messages.push(JSON.parse(chunk.toString()));
    } catch {
      // Ignore malformed payloads in tests.
    }
  });
  return messages;
}

function createSubmitCaptureScript() {
  return [
    "process.stdin.setEncoding('utf8');",
    "let buffer='';",
    "process.stdin.resume();",
    "process.stdout.write('> ');",
    "process.stdin.on('data', (chunk) => {",
    "  for (const ch of chunk) {",
    "    if (ch === '\\r' || ch === '\\n') {",
    "      process.stdout.write(`\\nSUBMIT:${buffer}\\n`);",
    "      process.exit(0);",
    "      return;",
    "    }",
    "    buffer += ch;",
    "  }",
    "});"
  ].join(' ');
}

function writeFakeClaudeCommand(dir) {
  const filePath = path.join(dir, 'claude');
  const script = `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.resume();
let ready = false;
let buffer = '';
process.stdout.write('Claude welcome\\n❯ welcome input\\n');
setTimeout(() => {
  ready = true;
  buffer = '';
  process.stdout.write('\\n────────────────\\n❯\\n────────────────\\n');
}, 700);
process.stdin.on('data', (chunk) => {
  if (!ready) return;
  for (const ch of chunk) {
    if (ch === '\\r' || ch === '\\n') {
      process.stdout.write('\\nSUBMIT:' + buffer + '\\n');
      process.exit(0);
      return;
    }
    buffer += ch;
  }
});
`;
  fs.writeFileSync(filePath, script, 'utf8');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

beforeEach(async () => {
  // #533 Phase 2: register the fixture orchestrator literal 'orch' (used as the
  // work-injecting `from`/`reply_to` in these tests) as an orchestrator sid, so
  // orchestrator→worker injects classify as orch-lane (allowed) instead of being
  // blocked by the peer-lane guardrail.
  harness = await startTestDaemon({
    env: { AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator aigentry-orchestrator-claude orch orch2' }
  });
});

afterEach(async () => {
  // #60: an owner socket opened by an observation arm must be closed even when the assertion
  // under test throws first — a leaked socket keeps the daemon's client set non-empty and the
  // NEXT test then fails on "Timed out waiting for daemon start", turning one real red into a
  // cascade of infrastructure reds that hide it.
  for (const ws of openOwnerSockets.splice(0)) {
    try { ws.close(); } catch { /* already gone */ }
  }
  await harness.stop();
});

test('telepty list prints active sessions from the configured host and port', async () => {
  const sessionId = createSessionId('cli-list');
  await harness.registerSession(sessionId, {
    term_program: 'kitty',
    term: 'xterm-kitty'
  });

  const result = await harness.runCli(['list']);
  assert.equal(result.code, 0, result.stderr);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, new RegExp(sessionId));
  assert.match(output, /Active Sessions/i);
  assert.match(output, /Status: DISCONNECTED \(OWNER_DISCONNECTED\)/i);
  assert.match(output, /Terminal: kitty \(xterm-kitty\)/i);
});

test('telepty list --json includes terminal metadata', async () => {
  const sessionId = createSessionId('cli-list-json');
  await harness.registerSession(sessionId, {
    term_program: 'ghostty',
    term: 'xterm-256color'
  });

  const result = await harness.runCli(['list', '--json']);
  assert.equal(result.code, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const session = parsed.find((item) => item.id === sessionId);
  assert.equal(session.termProgram, 'ghostty');
  assert.equal(session.term, 'xterm-256color');
  assert.equal(session.terminal, 'ghostty');
  assert.equal(session.healthStatus, 'DISCONNECTED');
  assert.equal(session.healthReason, 'OWNER_DISCONNECTED');
  assert.equal(session.transport.health_status, 'DISCONNECTED');
  assert.equal(session.semantic, null);
});

test('telepty list shows idle duration for sessions idle over 60 seconds', async () => {
  const sessionId = createSessionId('cli-list-idle');
  const lastActivityAt = new Date(Date.now() - ((2 * 60 + 5) * 60 * 1000)).toISOString();
  await harness.registerSession(sessionId, {
    term_program: 'kitty',
    term: 'xterm-kitty',
    last_activity_at: lastActivityAt
  });

  const result = await harness.runCli(['list']);
  assert.equal(result.code, 0, result.stderr);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, new RegExp(sessionId));
  assert.match(output, /Status: .*💤 idle \(2h 5m\)/);
});

test('telepty list --json includes computed idle_seconds', async () => {
  const sessionId = createSessionId('cli-list-idle-json');
  const lastActivityAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
  await harness.registerSession(sessionId, { last_activity_at: lastActivityAt });

  const result = await harness.runCli(['list', '--json']);
  assert.equal(result.code, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  const session = parsed.find((item) => item.id === sessionId);
  assert.equal(session.lastActivityAt, lastActivityAt);
  assert.ok(session.idle_seconds >= 590, `idle_seconds=${session.idle_seconds}`);
});

// --- #60 Stage A §8.5 consumer contract: the CLI must claim no more than it measured --------
//
// These pin the surfaces a removed claim most easily survives on — as WORDING. The daemon half
// landed already (`serializeSession.activityObservation`, `/state`'s `activity_observation`), and
// this file went on passing 24/24 because it never asserted the renamed field: cli.js still read
// `s.autoState`, which is now `undefined`, so the activity column silently rendered EMPTY. A test
// that passes by not looking is worth less than no test, so the column is pinned here.
//
// Every arm drives a REAL measured observation through the owner socket rather than asserting
// against a session that never left `starting`. That matters twice over: a never-fed session maps
// to `unmapped_transition_cause` (see the HOLD on the SessionStateMachine constructor), and an
// assertion that renders nothing at all would pass vacuously — the exact "the branch under test
// was never reached" shape this design round keeps producing.

// An OWNER socket, because only `ws === session.ownerWs` frames reach sessionStateManager.feed.
// The bearer is what makes it the owner rather than an attacker (#815). Tracked so afterEach can
// close it on the throwing path too.
const openOwnerSockets = [];
async function connectOwnerSocket(sessionId) {
  const ws = new WebSocket(
    `ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sessionId)}`
    + `?owner=1&owner_pid=${process.pid}&token=${encodeURIComponent(harness.authToken())}`,
    harness.ownerAuth(sessionId)
  );
  openOwnerSockets.push(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

// Drive the state machine to a NAMED observation and wait until the daemon actually serves it,
// so the CLI assertions below cannot race the transition.
async function observeSession(sessionId, ptyOutput, expectedKind, timeoutMs = 12000) {
  const ws = await connectOwnerSocket(sessionId);
  ws.send(JSON.stringify({ type: 'output', data: ptyOutput }));
  await waitFor(async () => {
    const res = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
    return res.body && res.body.activity_observation && res.body.activity_observation.kind === expectedKind;
  }, { timeoutMs, description: `activity observation ${expectedKind}` });
  return ws;
}

test('telepty status heading is the activity observation, never a State: line (§8.5.2)', async () => {
  const sessionId = createSessionId('cli-status-observation');
  await harness.registerSession(sessionId);
  // `Enter value:` matches WAITING_PATTERNS → an immediate, timer-free transition whose cause
  // (`input_request_pattern`) carries the `matched_line` its mapping row requires.
  const ws = await observeSession(sessionId, 'Enter value: ', 'input_request_pattern_observed');

  const result = await harness.runCli(['status', sessionId]);
  ws.close();
  assert.equal(result.code, 0, result.stderr);
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);

  assert.match(output, /Activity observation:/,
    `expected /Activity observation:/; got: ${JSON.stringify(output)}`);
  assert.match(output, /input_request_pattern_observed/,
    'the measured observation KIND is what ships, not an internal FSM state name');
  assert.doesNotMatch(output, /^\s*State:/m,
    '"State:" labelled an internal 8-state FSM value as if it were the session\'s condition');
  assert.match(output, /Cause: input_request_pattern/, 'the measured cause is named beside the observation');
});

test('telepty status states the outcome protocol is unavailable (§A4)', async () => {
  const sessionId = createSessionId('cli-status-outcome');
  await harness.registerSession(sessionId);
  const ws = await observeSession(sessionId, 'Enter value: ', 'input_request_pattern_observed');

  const result = await harness.runCli(['status', sessionId]);
  ws.close();
  assert.equal(result.code, 0, result.stderr);
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);

  // §A4: capability gaps are EXPLICIT, never implied by absence. A reader who is not told the
  // outcome protocol is unavailable will assume the activity line answers "is it done".
  assert.match(output, /Outcome protocol: unavailable/,
    `expected the outcome-protocol line; got: ${JSON.stringify(output)}`);
  assert.match(output, /Completion fact: none observed/,
    'the absence is stated, never left to inference');
});

test('telepty status renders quiet as neutral, never as task success (§8.5.2/§8.5.5)', async () => {
  const sessionId = createSessionId('cli-status-quiet');
  await harness.registerSession(sessionId);
  // The observation Stage A exists for. Non-prompt, non-OSC output then silence past
  // idle_timeout_ms (5s) → `silence_timeout` → `pty_quiet` at confidence 0.6. This is the exact
  // measurement the daemon used to announce as TASK_COMPLETE.
  const ws = await observeSession(sessionId, 'working on it\n', 'pty_quiet');

  const result = await harness.runCli(['status', sessionId]);
  ws.close();
  assert.equal(result.code, 0, result.stderr);
  const raw = `${result.stdout}\n${result.stderr}`;
  const output = stripAnsi(raw);

  // Non-vacuous: prove the quiet observation IS rendered before asserting how it is styled.
  assert.match(output, /Activity observation:.*pty_quiet/,
    `expected the quiet observation to render; got: ${JSON.stringify(output)}`);
  // Green is the claim. STATE_DISPLAY maps internal `idle` to a GREEN sleeping pill and the
  // sidebar reads that green as task success, so no observation may ever be painted green —
  // least of all this one, on the surface a human reads before believing a worker is done.
  assert.doesNotMatch(raw, /\x1b\[32m/, 'quiet must not render green: green is read as "done"');
  assert.doesNotMatch(raw, /\x1b\[92m/, 'bright green is the same claim');
  // §2.3: the internal FSM value must not reach the external surface at all.
  assert.doesNotMatch(output, /\bidle\b/,
    'external `idle` is gone — consumers read it as "the turn is over"');
});

test('telepty list renders the activity observation and never leaves it blank (§8.5.1)', async () => {
  const sessionId = createSessionId('cli-list-observation');
  await harness.registerSession(sessionId);
  const ws = await observeSession(sessionId, 'Enter value: ', 'input_request_pattern_observed');

  const result = await harness.runCli(['list']);
  ws.close();
  assert.equal(result.code, 0, result.stderr);
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);

  assert.match(output, /input_request_pattern_observed/,
    `the activity column must carry the measured observation, not render empty; got: ${JSON.stringify(output)}`);
});

test('telepty list --json exports activityObservation + completion, never autoState (§8.5.1)', async () => {
  // The machine-readable contract every other consumer (cmux sidebar, tracker) reads.
  const sessionId = createSessionId('cli-list-json-observation');
  await harness.registerSession(sessionId);
  const ws = await observeSession(sessionId, 'Enter value: ', 'input_request_pattern_observed');

  const result = await harness.runCli(['list', '--json']);
  ws.close();
  assert.equal(result.code, 0, result.stderr);

  const session = JSON.parse(result.stdout).find((item) => item.id === sessionId);
  assert.equal(session.autoState, undefined, 'the task-like `autoState.state:"idle"` export is gone');
  assert.equal(session.activityObservation.kind, 'input_request_pattern_observed');
  assert.equal(session.activityObservation.cause, 'input_request_pattern');
  assert.notEqual(session.activityObservation.tone, 'success', 'no tone may mean done');
  assert.equal(session.completion.completion_fact, null, 'completion is a SEPARATE, permanently null block');
  assert.equal(session.completion.terminal, false);
  assert.equal(session.completion.capability.outcome_protocol, 'unavailable');
});

test('observationTone maps every tone to a non-success color (§8.5.12)', () => {
  // A pure exhaustive check on the rule the rendering rests on: "nothing in this table is
  // green". Table-driven rather than sampled, and it includes the unknown-name arm, because a
  // missing mapping must fall back to NEUTRAL — never to success styling, and never to the
  // internal `idle` pill.
  const { observationTone, OBSERVATION_TONE_COLOR } = require('../src/cli/session-view');
  const { OBSERVATION_DISPLAY } = require('../session-state');

  for (const [tone, color] of Object.entries(OBSERVATION_TONE_COLOR)) {
    assert.doesNotMatch(color, /\x1b\[9?32m/, `tone "${tone}" must not be green`);
  }
  // Every kind the producer can emit has an explicit presentation.
  for (const kind of Object.keys(OBSERVATION_DISPLAY)) {
    const rendered = observationTone(OBSERVATION_DISPLAY[kind].tone);
    assert.ok(rendered, `kind "${kind}" has no tone presentation`);
    assert.doesNotMatch(rendered, /\x1b\[9?32m/, `kind "${kind}" renders green`);
  }
  // Deleted/unknown mapping → neutral, never success.
  assert.equal(observationTone('some_tone_that_does_not_exist'), OBSERVATION_TONE_COLOR.neutral);
  assert.equal(observationTone(undefined), OBSERVATION_TONE_COLOR.neutral);
});

test('telepty session info prints terminal metadata', async () => {
  const sessionId = createSessionId('cli-session-info');
  await harness.registerSession(sessionId, {
    term_program: 'Apple_Terminal',
    term: 'xterm-256color'
  });

  const result = await harness.runCli(['session', 'info', sessionId]);
  assert.equal(result.code, 0, result.stderr);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /Session Info/i);
  assert.match(output, /Status: DISCONNECTED \(OWNER_DISCONNECTED\)/i);
  assert.match(output, /Terminal: Apple_Terminal/i);
  assert.match(output, /TERM: xterm-256color/i);
});

test('telepty inject forwards input to the target PTY session', async () => {
  const sessionId = createSessionId('cli-inject');
  await harness.spawnSession(sessionId);

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);
  const token = createSessionId('cli-token');

  const result = await harness.runCli(['inject', sessionId, `echo ${token}`]);
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes(token)
  )), { timeoutMs: 7000, description: 'CLI inject output' });

  ws.close();
});

test('telepty inject accepts an explicit empty string and submits enter only', async () => {
  const sessionId = createSessionId('cli-inject-empty');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  const result = await harness.runCli(['inject', sessionId, ''], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI empty inject submit output' });

  const normalized = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');
  assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);

  ws.close();
});

test('telepty inject rejects --no-enter and points users to telepty enter', async () => {
  const sessionId = createSessionId('cli-inject-no-enter');
  await harness.spawnSession(sessionId);

  const result = await harness.runCli(['inject', '--no-enter', sessionId, 'echo blocked']);
  assert.equal(result.code, 1);

  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /always submits after text/i);
  assert.match(output, /telepty enter/i);
});

test('telepty enter sends an enter-only submission to the target session', async () => {
  const sessionId = createSessionId('cli-enter');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  const result = await harness.runCli(['enter', sessionId], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI enter submit output' });

  const normalized = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');
  assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);

  ws.close();
});

test('telepty inject --ref stores the payload in shared context and injects only the pointer prompt', async () => {
  const sessionId = createSessionId('cli-inject-ref');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);
  const rawToken = createSessionId('ref-payload');
  const context = `## Context\n\n${rawToken}\n\nKeep this out of stdin.`;
  const descriptor = createSharedContextDescriptor(context);
  const expectedPrompt = buildSharedContextPrompt(descriptor);
  const sharedPath = path.join(getSharedContextDir(harness.homeDir), descriptor.fileName);

  const result = await harness.runCli(['inject', '--ref', sessionId, context], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'CLI inject ref output' });

  const combinedOutput = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');

  assert.equal(combinedOutput.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), context);

  ws.close();
});

test('telepty inject --ref <file> stores file contents and appends the message after the pointer', async () => {
  const sessionId = createSessionId('cli-inject-ref-file');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);
  const rawToken = createSessionId('file-ref-payload');
  const fileContent = `# Spec\n\n${rawToken}\n\nUse this file as the source context.\n`;
  const filePath = path.join(harness.homeDir, 'spec.md');
  const message = 'Implement from this shared spec.';
  fs.writeFileSync(filePath, fileContent);

  const descriptor = createSharedContextDescriptor(fileContent);
  const expectedPrompt = `${buildSharedContextPrompt(descriptor)} ${message}`;
  const sharedPath = path.join(getSharedContextDir(harness.homeDir), descriptor.fileName);

  const result = await harness.runCli(['inject', '--ref', filePath, '--from', 'orch', sessionId, message], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((messageChunk) => (
    messageChunk.type === 'output' && String(messageChunk.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'CLI inject ref file output' });

  const combinedOutput = outputs
    .filter((messageChunk) => messageChunk.type === 'output')
    .map((messageChunk) => String(messageChunk.data))
    .join('');

  assert.equal(combinedOutput.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), fileContent);

  ws.close();
});

test('telepty broadcast --ref reuses one shared context file for all local sessions', async () => {
  const sessionIdA = createSessionId('cli-broadcast-ref-a');
  const sessionIdB = createSessionId('cli-broadcast-ref-b');
  const childArgs = ['-e', createSubmitCaptureScript()];
  await harness.spawnSession(sessionIdA, { command: process.execPath, args: childArgs });
  await harness.spawnSession(sessionIdB, { command: process.execPath, args: childArgs });

  const wsA = await harness.connectSession(sessionIdA);
  const wsB = await harness.connectSession(sessionIdB);
  const outputsA = collectJsonMessages(wsA);
  const outputsB = collectJsonMessages(wsB);
  const rawToken = createSessionId('broadcast-ref-payload');
  const context = `Shared context ${rawToken}\nSecond line`;
  const descriptor = createSharedContextDescriptor(context);
  const expectedPrompt = buildSharedContextPrompt(descriptor);
  const sharedDir = getSharedContextDir(harness.homeDir);
  const sharedPath = path.join(sharedDir, descriptor.fileName);

  const result = await harness.runCli(['broadcast', '--ref', context], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputsA.some((message) => (
    message.type === 'output' && String(message.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref output A' });

  await waitFor(() => outputsB.some((message) => (
    message.type === 'output' && String(message.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref output B' });

  const combinedA = outputsA.filter((message) => message.type === 'output').map((message) => String(message.data)).join('');
  const combinedB = outputsB.filter((message) => message.type === 'output').map((message) => String(message.data)).join('');
  assert.equal(combinedA.includes(rawToken), false);
  assert.equal(combinedB.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), context);
  assert.deepEqual(fs.readdirSync(sharedDir).filter((name) => name.endsWith('.md')).sort(), [descriptor.fileName]);

  wsA.close();
  wsB.close();
});

test('telepty broadcast --ref <file> reuses one shared file and appends the message for every local session', async () => {
  const sessionIdA = createSessionId('cli-broadcast-ref-file-a');
  const sessionIdB = createSessionId('cli-broadcast-ref-file-b');
  const childArgs = ['-e', createSubmitCaptureScript()];
  await harness.spawnSession(sessionIdA, { command: process.execPath, args: childArgs });
  await harness.spawnSession(sessionIdB, { command: process.execPath, args: childArgs });

  const wsA = await harness.connectSession(sessionIdA);
  const wsB = await harness.connectSession(sessionIdB);
  const outputsA = collectJsonMessages(wsA);
  const outputsB = collectJsonMessages(wsB);
  const rawToken = createSessionId('broadcast-file-ref-payload');
  const fileContent = `Shared file context ${rawToken}\nLine 2\n`;
  const filePath = path.join(harness.homeDir, 'broadcast-spec.md');
  const message = 'Review using the shared file reference.';
  fs.writeFileSync(filePath, fileContent);

  const descriptor = createSharedContextDescriptor(fileContent);
  const expectedPrompt = `${buildSharedContextPrompt(descriptor)} ${message}`;
  const sharedDir = getSharedContextDir(harness.homeDir);
  const sharedPath = path.join(sharedDir, descriptor.fileName);

  const result = await harness.runCli(['broadcast', '--ref', filePath, message], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputsA.some((messageChunk) => (
    messageChunk.type === 'output' && String(messageChunk.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref file output A' });

  await waitFor(() => outputsB.some((messageChunk) => (
    messageChunk.type === 'output' && String(messageChunk.data).includes(`SUBMIT:${expectedPrompt}`)
  )), { timeoutMs: 7000, description: 'broadcast ref file output B' });

  const combinedA = outputsA.filter((messageChunk) => messageChunk.type === 'output').map((messageChunk) => String(messageChunk.data)).join('');
  const combinedB = outputsB.filter((messageChunk) => messageChunk.type === 'output').map((messageChunk) => String(messageChunk.data)).join('');
  assert.equal(combinedA.includes(rawToken), false);
  assert.equal(combinedB.includes(rawToken), false);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), fileContent);
  assert.deepEqual(fs.readdirSync(sharedDir).filter((name) => name.endsWith('.md')).sort(), [descriptor.fileName]);

  wsA.close();
  wsB.close();
});

test('telepty status-report publishes a semantic self-report for the current session', async () => {
  const sessionId = createSessionId('cli-status-report');
  await harness.registerSession(sessionId);

  const result = await harness.runCli([
    'status-report',
    '--phase', 'implementing',
    '--task', 'wire observer schema',
    '--blocker', 'awaiting review',
    '--needs-input',
    '--thread-id', 'thread-telepty'
  ], {
    env: {
      TELEPTY_SESSION_ID: sessionId
    }
  });
  assert.equal(result.code, 0, result.stderr);

  const detail = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.semantic, {
    phase: 'implementing',
    current_task: 'wire observer schema',
    blocker: 'awaiting review',
    needs_input: true,
    thread_id: 'thread-telepty',
    source: 'self_report',
    seq: 1
  });

  const info = await harness.runCli(['session', 'info', sessionId]);
  assert.equal(info.code, 0, info.stderr);
  const output = stripAnsi(`${info.stdout}\n${info.stderr}`);
  assert.match(output, /Phase: implementing/i);
  assert.match(output, /Current Task: wire observer schema/i);
  assert.match(output, /Blocker: awaiting review/i);
});

test('telepty attach resumes stdin after session selection and forwards room input', async () => {
  const sessionId = createSessionId('cli-attach');
  await harness.spawnSession(sessionId);

  const cli = pty.spawn(process.execPath, ['cli.js', 'attach'], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(() => stripAnsi(output).includes('Select a session number to attach:'), {
      timeoutMs: 7000,
      description: 'attach selection prompt'
    });

    cli.write('1\r');

    await waitFor(() => stripAnsi(output).includes(`Entered room '${sessionId}'`), {
      timeoutMs: 7000,
      description: 'attach room entry'
    });

    const token = createSessionId('attach-token');
    cli.write(`echo ${token}\r`);

    await waitFor(() => stripAnsi(output).includes(token), {
      timeoutMs: 7000,
      description: 'attach input echoed through room'
    });
  } finally {
    cli.kill();
  }
});

test('telepty allow works without a TTY by using fallback terminal dimensions', async () => {
  const sessionId = createSessionId('cli-allow-no-tty');
  const result = await harness.runCli([
    'allow',
    '--id',
    sessionId,
    '--idle-ttl',
    '1h',
    process.execPath,
    '-e',
    'console.log("allow-ok")'
  ], {
    env: {
      COLUMNS: '120',
      LINES: '40'
    },
    timeoutMs: 8000
  });

  assert.equal(result.code, 0, result.stderr);
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /allow-ok/);

  await waitFor(async () => {
    const list = await harness.request('/api/sessions');
    return list.status === 200 && !list.body.some((session) => session.id === sessionId);
  }, { description: 'wrapped session cleanup after non-interactive allow' });
});

test('telepty allow rejects malformed --idle-ttl before spawning', async () => {
  const result = await harness.runCli([
    'allow',
    '--id',
    createSessionId('cli-allow-bad-idle-ttl'),
    '--idle-ttl',
    'forever',
    process.execPath,
    '-e',
    'console.log("should-not-run")'
  ]);

  assert.equal(result.code, 1);
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(output, /idle_ttl must be a duration/);
  assert.doesNotMatch(output, /should-not-run/);
});

test('telepty allow inject submits once without exposing routing metadata', async () => {
  const sessionId = createSessionId('cli-allow-inject');
  const childScript = createSubmitCaptureScript();

  const cli = pty.spawn(process.execPath, [
    'cli.js',
    'allow',
    '--id',
    sessionId,
    process.execPath,
    '-e',
    childScript
  ], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(() => stripAnsi(output).includes('Inject allowed.'), {
      timeoutMs: 7000,
      description: 'allow bridge ready'
    });

    // #577 CI-flake fix: the local "Inject allowed." banner does not guarantee the daemon-side
    // owner WebSocket is connected yet. Injecting immediately raced ahead of it and returned 503
    // DISCONNECTED on slow CI (ubuntu). Gate on the daemon reporting the session owner CONNECTED
    // (healthStatus === 'CONNECTED' <=> isOpenWebSocket(ownerWs) — the exact predicate the inject
    // endpoint checks) before POSTing, mirroring the sibling test's /api/sessions readiness gate.
    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return Array.isArray(list.body)
        && list.body.some((session) => session.id === sessionId && session.healthStatus === 'CONNECTED');
    }, {
      timeoutMs: 7000,
      description: 'allow session owner connected on daemon'
    });

    const inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST',
      body: { prompt: 'hello-once', from: 'orch', reply_to: 'orch' }
    });
    assert.equal(inject.status, 200);

    await waitFor(() => stripAnsi(output).includes('SUBMIT:hello-once'), {
      timeoutMs: 7000,
      description: 'single submitted inject payload'
    });

    const normalized = stripAnsi(output);
    assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);
    assert.equal(normalized.includes('[from:'), false);
    assert.equal(normalized.includes('reply-to:'), false);
    assert.equal(normalized.includes('telepty inject --from'), false);
  } finally {
    cli.kill();
  }
});

test('telepty allow queues first fake-claude inject until welcome bootstrap ready', async () => {
  const sessionId = createSessionId('cli-allow-bootstrap');
  const fakeClaude = writeFakeClaudeCommand(harness.homeDir);

  const cli = pty.spawn(process.execPath, [
    'cli.js',
    'allow',
    '--id',
    sessionId,
    fakeClaude
  ], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return list.body.some((session) => session.id === sessionId);
    }, {
      timeoutMs: 7000,
      description: 'fake claude registered'
    });

    const inject = await harness.runCli(['inject', sessionId, 'dispatch-token'], { timeoutMs: 10000 });
    assert.equal(inject.code, 0, inject.stderr);

    // #760: the drained bootstrap body now carries the #716/#730 bracketed-paste envelope,
    // like every other inject path. The stub echoes whatever bytes it receives (a real
    // claude interprets the markers instead), and the harness stripAnsi only removes SGR —
    // so the markers are still in `output` and the assertion names them.
    await waitFor(() => stripAnsi(output).includes(`SUBMIT:\u001b[200~dispatch-token\u001b[201~`), {
      timeoutMs: 10000,
      description: 'fake claude post-bootstrap submit'
    });

    const normalized = stripAnsi(output);
    assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);
  } finally {
    cli.kill();
  }
});

test('telepty allow restores terminal keyboard modes after the child exits', async () => {
  const sessionId = createSessionId('cli-allow-cleanup');
  const cli = pty.spawn(process.execPath, [
    'cli.js',
    'allow',
    '--id',
    sessionId,
    process.execPath,
    '-e',
    'process.stdout.write("\\u001b[>1u\\u001b[>4;2m\\u001b[?2004h"); setTimeout(() => process.exit(0), 50);'
  ], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for allow session exit'));
      }, 8000);

      cli.onExit((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });

    assert.equal(exit.exitCode, 0);
    assert.ok(countOccurrences(output, TERMINAL_CLEANUP_SEQUENCE) >= 1, output);

    await waitFor(async () => {
      const list = await harness.request('/api/sessions');
      return list.status === 200 && !list.body.some((session) => session.id === sessionId);
    }, { description: 'wrapped session cleanup after interactive allow exit' });
  } finally {
    cli.kill();
  }
});

test('interactive update returns to the TUI instead of exiting', async () => {
  const cli = pty.spawn(process.execPath, ['cli.js'], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      TELEPTY_SKIP_PACKAGE_UPDATE: '1',
      TELEPTY_SKIP_DAEMON_REPAIR: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(() => stripAnsi(output).includes('What would you like to do?'), {
      timeoutMs: 7000,
      description: 'interactive menu prompt'
    });
    const initialPromptCount = stripAnsi(output).split('What would you like to do?').length - 1;

    cli.write('\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\r');

    await waitFor(() => stripAnsi(output).includes('Update complete! Restarting daemon...'), {
      timeoutMs: 7000,
      description: 'update completion message'
    });

    await waitFor(() => {
      const promptCount = stripAnsi(output).split('What would you like to do?').length - 1;
      return promptCount >= initialPromptCount + 1;
    }, {
      timeoutMs: 7000,
      description: 'menu prompt after update'
    });
  } finally {
    cli.kill();
  }
});

test('interactive menu recovers from a terminal EIO instead of crashing', async () => {
  const cli = pty.spawn(process.execPath, ['cli.js'], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      TELEPTY_TEST_TRIGGER_PROMPT_EIO_ONCE: '1'
    }
  });

  let output = '';
  cli.onData((chunk) => {
    output += chunk;
  });

  try {
    await waitFor(() => {
      const normalized = stripAnsi(output);
      return normalized.includes('Terminal input was interrupted. Returning to the telepty menu...')
        && normalized.split('What would you like to do?').length - 1 >= 1;
    }, {
      timeoutMs: 7000,
      description: 'menu recovery after terminal EIO'
    });
  } finally {
    cli.kill();
  }
});

test('telepty inject --submit uses terminal-level submit after text injection', async () => {
  const sessionId = createSessionId('cli-inject-submit');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  const result = await harness.runCli(['inject', '--submit', sessionId, 'hello-submit'], { timeoutMs: 10000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI inject --submit output' });

  const normalized = outputs
    .filter((message) => message.type === 'output')
    .map((message) => String(message.data))
    .join('');
  assert.ok(normalized.includes('SUBMIT:hello-submit'));
  assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);

  ws.close();
});

test('telepty send-key sends terminal-level enter to the target session', async () => {
  const sessionId = createSessionId('cli-send-key');
  await harness.spawnSession(sessionId, {
    command: process.execPath,
    args: ['-e', createSubmitCaptureScript()]
  });

  const ws = await harness.connectSession(sessionId);
  const outputs = collectJsonMessages(ws);

  // Inject text without submit (via HTTP API with no_enter)
  await harness.request(`/api/sessions/${sessionId}/inject`, {
    method: 'POST',
    body: { prompt: 'key-payload', no_enter: true }
  });

  // Wait for text to be written to PTY
  await new Promise(resolve => setTimeout(resolve, 500));

  // Send enter via send-key command
  const result = await harness.runCli(['send-key', sessionId, 'enter'], { timeoutMs: 8000 });
  assert.equal(result.code, 0, result.stderr);

  await waitFor(() => outputs.some((message) => (
    message.type === 'output' && String(message.data).includes('SUBMIT:')
  )), { timeoutMs: 7000, description: 'CLI send-key enter output' });

  ws.close();
});
