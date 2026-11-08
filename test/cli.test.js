'use strict';

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const WebSocket = require('ws');
const { buildSharedContextPrompt, createSharedContextDescriptor, getSharedContextDir } = require('../shared-context');
const { createSessionId, startTestDaemon, stripAnsi, waitFor } = require('../test-support/daemon-harness');
const { writeFakeCli } = require('../test-support/platform-contract');

let harness;

// Task 1215 / #879 — ALLOWLISTED failure-boundary diagnostics for the win32 delivery failures. Emitted only when a
// delivery wait fails; never payload bytes (only booleans for test-owned markers), tokens, env, URLs or credentials.
// They do not change any assertion, wait, timeout or the test sequence; the original error is rethrown unchanged.
async function diagSession(sessionId) {
  try {
    const res = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const b = res.body && typeof res.body === 'object' ? res.body : {};
    const t = b.transport && typeof b.transport === 'object' ? b.transport : {};
    const r = t.readiness && typeof t.readiness === 'object' ? t.readiness : {};
    const q = t.bridge_queue && typeof t.bridge_queue === 'object' ? t.bridge_queue : null;
    return { status: res.status, healthStatus: b.healthStatus ?? null, type: b.type ?? null, input_policy: t.input_policy ?? null,
      bootstrap_gated: t.bootstrap ? t.bootstrap.gated ?? null : null, readiness_capability: r.capability ?? null,
      input_transport_ready: r.input_transport_ready ? r.input_transport_ready.status ?? null : null,
      // Task 1215 (#879 discriminators): which handshake half is missing, any refused frame (fixed reason code) and the
      // daemon-side bootstrap queue (counts only).
      process_started: r.process_started ? r.process_started.status ?? null : null,
      input_transport_ready_reason: r.input_transport_ready ? r.input_transport_ready.reason ?? null : null,
      refused_frames: r.refused_frames ? { count: r.refused_frames.count ?? null, milestone: r.refused_frames.last ? r.refused_frames.last.milestone ?? null : null,
        reason: r.refused_frames.last ? r.refused_frames.last.reason ?? null : null } : null,
      bootstrap: t.bootstrap ? { ready: t.bootstrap.ready ?? null, queued: t.bootstrap.queued ?? null, draining: t.bootstrap.draining ?? null } : null,
      instruction_received: t.instruction_received ? t.instruction_received.status ?? null : null, bridge_receipts: t.bridge_receipts ?? null,
      bridge_queue: q ? { source: q.source ?? null, phase: q.phase ?? null, pending: q.pending ?? null, reason: q.reason ?? null } : null };
  } catch (error) { return { error: (error && error.code) || 'request_failed' }; }
}
function diagInject(res) {
  if (!res) return null;
  const b = res.body && typeof res.body === 'object' ? res.body : {};
  return { status: res.status, success: b.success ?? null, code: b.code ?? null, queued: b.queued ?? null,
    bootstrap_queued: b.bootstrap_queued ?? null, strategy: b.strategy ?? null, tracking_state: b.tracking_state ?? null };
}
function diagPty(text, exit, markers) {
  const plain = stripAnsi(String(text || ''));
  return { exit: exit === undefined ? null : exit, bytes: Buffer.byteLength(String(text || ''), 'utf8'),
    markers: Object.fromEntries(Object.entries(markers).map(([name, needle]) => [name, plain.includes(needle)])) };
}
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

// #879: returns { command, env } from writeFakeCli — on POSIX the shebang file path as before; on
// win32 a `claude.cmd` shim + `claude.js` body and the bare name `claude` resolved through PATH,
// because Windows cannot execute a shebang text file (measured: bridge never connected, 503).
// Task 1215 (511): input before the composer is DISCARDED on purpose (a still-starting CLI). `discardLog`: bounded test-only
// record of exactly the discarded bytes (JSON chunk per line, at most 4096 chars), never an ACK or output. `composerAfterEnter`:
// the composer is drawn once a discarded chunk carried a line delimiter (an event, no timer race); else the original 700 ms.
function writeFakeClaudeCommand(dir, { discardLog = null, composerAfterEnter = false } = {}) {
  const script = `const fs = require('fs');
process.stdin.setEncoding('utf8');
process.stdin.resume();
let ready = false;
let buffer = '';
let discarded = 0;
const DISCARD_LOG = ${JSON.stringify(discardLog)};
process.stdout.write('Claude welcome\\n❯ welcome input\\n');
function showComposer() {
  if (ready) return;
  ready = true;
  buffer = '';
  process.stdout.write('\\n────────────────\\n❯\\n────────────────\\n');
}
${composerAfterEnter ? '' : 'setTimeout(showComposer, 700);'}
process.stdin.on('data', (chunk) => {
  if (!ready) {
    if (DISCARD_LOG && discarded < 4096) {
      const kept = chunk.slice(0, 4096 - discarded);
      discarded += kept.length;
      fs.appendFileSync(DISCARD_LOG, JSON.stringify(kept) + '\\n');
    }
    if (${composerAfterEnter ? 'true' : 'false'} && /[\\r\\n]/.test(chunk)) showComposer();
    return;
  }
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
  return writeFakeCli(dir, 'claude', script);
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

// #879: the interactive `attach` selection prompt under ConPTY is timing-sensitive on Windows —
// the prompt renders and `1\r` is written, but 'Entered room' did not arrive within 7 s in the
// per-file run 40507287234 (8.07 s) and in job 122148002651, while the parallel run 40507287143
// passed it (0.93 s). Nothing in the fixture is demonstrably wrong; the intermittent wait is the
// ConPTY/TUI interaction class deferred to #577. Skipped on win32 WITH this reason; the attach
// stdin-resume behaviour is UNVERIFIED on Windows, never passed by this skip. Exact case list:
// this one test.
const ATTACH_WIN32_SKIP = process.platform === 'win32'
  ? 'win32: interactive attach selection under ConPTY — intermittent room-entry timeout (per-file run 40507287234, job 122148002651); Windows-native runtime deferred, owner #577'
  : false;

test('telepty attach resumes stdin after session selection and forwards room input', { skip: ATTACH_WIN32_SKIP }, async () => {
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

test('telepty allow inject submits once without exposing routing metadata', async (t) => {
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
  // #879 diagnostics only: exit code, plus booleans for test-owned markers (prompt, payload echo, submit line).
  let cliExit = null;
  cli.onExit(({ exitCode }) => { cliExit = exitCode; });
  let inject = null;
  const DIAG_MARKERS = { inject_allowed: 'Inject allowed.', child_prompt: '> ', payload_echo: 'hello-once', submit_line: 'SUBMIT:', announce_unsent: 'transport readiness not announced', announce_pid_unavailable: 'pid=unavailable' };
  const diagnose = (stage) => async (error) => {
    t.diagnostic(`#879 diag ${stage} ${JSON.stringify({ bridge: diagPty(output, cliExit, DIAG_MARKERS), inject: diagInject(inject), session: await diagSession(sessionId) })}`);
    throw error;
  };

  try {
    await waitFor(() => stripAnsi(output).includes('Inject allowed.'), {
      timeoutMs: 7000,
      description: 'allow bridge ready'
    }).catch(diagnose('bridge_ready'));

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
    }).catch(diagnose('owner_connected'));

    inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST',
      body: { prompt: 'hello-once', from: 'orch', reply_to: 'orch' }
    });
    assert.equal(inject.status, 200);

    await waitFor(() => stripAnsi(output).includes('SUBMIT:hello-once'), {
      timeoutMs: 7000,
      description: 'single submitted inject payload'
    }).catch(diagnose('submitted_payload'));

    const normalized = stripAnsi(output);
    assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);
    assert.equal(normalized.includes('[from:'), false);
    assert.equal(normalized.includes('reply-to:'), false);
    assert.equal(normalized.includes('telepty inject --from'), false);
  } finally {
    cli.kill();
  }
});

// Task 1215 G1 (review26: silent-child outcome UNKNOWN by source — measured natively here). The REAL allow bridge and
// the REAL node-pty spawn a child that writes nothing to its terminal before input; it only records what it receives.
// Readiness is the daemon's own view of the bridge's real handshake (never a fabricated frame, never a screen oracle);
// one ordinary inject must then arrive exactly once. Actual-owner control: a milestone frame from a NON-owner socket on
// the same session changes nothing. Inherently native (ConPTY), so non-Windows hosts skip; Windows CI must execute it.
// Private daemon/home per test (beforeEach/afterEach), the bridge is this test's own child and is killed in finally.
const G1_NATIVE_SKIP = process.platform === 'win32' ? false : 'native ConPTY silent-child readiness: measured on Windows CI only';
test('#1215 G1 native: a SILENT child under the real allow bridge and ConPTY reaches readiness and receives one ordinary inject exactly once', { skip: G1_NATIVE_SKIP, timeout: 45000 }, async (t) => {
  const sessionId = createSessionId('cli-g1-silent');
  const rx = path.join(harness.homeDir, `${sessionId}.rx`);
  fs.writeFileSync(rx, '');
  const silentChild = [
    "const fs = require('fs');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.resume();",
    `process.stdin.on('data', (chunk) => { fs.appendFileSync(${JSON.stringify(rx)}, chunk); });`
  ].join(' ');
  const cli = pty.spawn(process.execPath, ['cli.js', 'allow', '--id', sessionId, process.execPath, '-e', silentChild], {
    cwd: projectRoot, cols: 80, rows: 24, name: 'xterm',
    env: { ...process.env, HOME: harness.homeDir, USERPROFILE: harness.homeDir, TELEPTY_HOST: harness.host, TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1' }
  });
  let output = ''; let cliExit = null; let inject = null;
  cli.onData((chunk) => { output += chunk; });
  cli.onExit(({ exitCode }) => { cliExit = exitCode; });
  const MARK = 'g1-silent-once';
  const DIAG_MARKERS = { inject_allowed: 'Inject allowed.', announce_unsent: 'transport readiness not announced', announce_pid_unavailable: 'pid=unavailable' };
  const diagnose = (stage) => async (error) => {
    t.diagnostic(`#879 diag ${stage} ${JSON.stringify({ bridge: diagPty(output, cliExit, DIAG_MARKERS), inject: diagInject(inject), session: await diagSession(sessionId),
      child_rx_bytes: fs.statSync(rx).size })}`);
    throw error;
  };
  const readinessOf = async () => {
    const body = (await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`)).body;
    return body && body.transport && body.transport.readiness ? body.transport.readiness : null;
  };
  try {
    await waitFor(() => stripAnsi(output).includes('Inject allowed.'), { timeoutMs: 10000, description: 'allow bridge ready' })
      .catch(diagnose('g1_bridge_ready'));
    const ready = await waitFor(async () => {
      const rd = await readinessOf();
      return rd && rd.process_started && rd.process_started.status === 'observed'
        && rd.input_transport_ready && rd.input_transport_ready.status === 'observed' ? rd : null;
    }, { timeoutMs: 10000, description: 'the silent child\'s process_started + input_transport_ready observed by the daemon' })
      .catch(diagnose('g1_readiness'));
    assert.equal(fs.readFileSync(rx, 'utf8'), '', 'PRECONDITION: the child received nothing before the inject');

    // Actual-owner control: a milestone frame from a non-owner socket is not the owner's handshake and changes nothing.
    const viewer = await harness.connectSession(sessionId);
    openOwnerSockets.push(viewer);   // closed by afterEach on every path
    viewer.send(JSON.stringify({ type: 'input_transport_ready', schema: 1, session_id: sessionId, child_seq: ready.input_transport_ready.child_seq + 1, input_loop: 'attached' }));

    inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST', body: { prompt: MARK, from: 'orch', reply_to: 'orch' } });
    assert.equal(inject.status, 200, JSON.stringify(inject.body));
    await waitFor(() => (/g1-silent-once[\r\n]/.test(fs.readFileSync(rx, 'utf8')) ? true : null), { timeoutMs: 10000, description: 'the inject and its submit received by the silent child' })
      .catch(diagnose('g1_delivery'));
    const after = await readinessOf();
    assert.deepEqual({ received: countOccurrences(fs.readFileSync(rx, 'utf8'), MARK),
      readiness: [after.process_started.child_seq, after.input_transport_ready.child_seq, after.input_transport_ready.observed_at] },
    { received: 1, readiness: [ready.process_started.child_seq, ready.input_transport_ready.child_seq, ready.input_transport_ready.observed_at] });
  } finally {
    cli.kill();
  }
});

// Task 1215 G1 (correction29): native restart / stale-child control on the REAL `telepty allow --auto-restart` bridge and
// REAL node-pty. The quiet child writes nothing to its terminal; it records what it receives, tagged with its own pid, and
// exits abnormally when it receives a test-owned crash line (input-driven, never output). The bridge then respawns it
// (a new child generation); readiness must be re-established by the NEW child's own handshake (higher child_seq, its own
// pid), and a later ordinary inject must reach only the new child, exactly once. Daemon-side replay and stale/wrong-owner
// frame refusal is not reachable natively without owner access; it is covered by the real handler tests
// (readiness-handshake-22 G1, supervision-readiness-1215 F2) — see DECISION.md. Windows-only (ConPTY); Windows CI runs it.
test('#1215 G1 native: after a crash-restart the quiet child\'s successor re-establishes readiness itself and alone receives the next inject, exactly once', { skip: G1_NATIVE_SKIP, timeout: 60000 }, async (t) => {
  const sessionId = createSessionId('cli-g1-restart');
  const rx = path.join(harness.homeDir, `${sessionId}.rx`);
  fs.writeFileSync(rx, '');
  const CRASH = 'g1-crash-now';
  const quietChild = [
    "const fs = require('fs');",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.resume();",
    `process.stdin.on('data', (chunk) => { fs.appendFileSync(${JSON.stringify(rx)}, process.pid + ' ' + JSON.stringify(chunk) + '\\n');`,
    `  if (chunk.includes(${JSON.stringify(CRASH)})) process.exit(1); });`
  ].join(' ');
  const cli = pty.spawn(process.execPath, ['cli.js', 'allow', '--auto-restart', '--id', sessionId, process.execPath, '-e', quietChild], {
    cwd: projectRoot, cols: 80, rows: 24, name: 'xterm',
    env: { ...process.env, HOME: harness.homeDir, USERPROFILE: harness.homeDir, TELEPTY_HOST: harness.host, TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1' }
  });
  let output = ''; let cliExit = null; let inject = null;
  cli.onData((chunk) => { output += chunk; });
  cli.onExit(({ exitCode }) => { cliExit = exitCode; });
  const DIAG_MARKERS = { inject_allowed: 'Inject allowed.', restarted: 'restarted (attempt', announce_unsent: 'transport readiness not announced', announce_pid_unavailable: 'pid=unavailable' };
  const diagnose = (stage) => async (error) => {
    t.diagnostic(`#879 diag ${stage} ${JSON.stringify({ bridge: diagPty(output, cliExit, DIAG_MARKERS), inject: diagInject(inject), session: await diagSession(sessionId),
      child_rx_lines: fs.readFileSync(rx, 'utf8').split('\n').filter(Boolean).length })}`);
    throw error;
  };
  const readinessOf = async () => {
    const body = (await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`)).body;
    return body && body.transport && body.transport.readiness ? body.transport.readiness : null;
  };
  const observedReady = (rd) => rd && rd.process_started && rd.process_started.status === 'observed'
    && rd.input_transport_ready && rd.input_transport_ready.status === 'observed';
  const lines = () => fs.readFileSync(rx, 'utf8').split('\n').filter(Boolean).map((l) => { const i = l.indexOf(' '); return { pid: Number(l.slice(0, i)), data: JSON.parse(l.slice(i + 1)) }; });
  try {
    await waitFor(() => stripAnsi(output).includes('Inject allowed.'), { timeoutMs: 10000, description: 'allow bridge ready' }).catch(diagnose('g1r_bridge_ready'));
    const first = await waitFor(async () => { const rd = await readinessOf(); return observedReady(rd) ? rd : null; },
      { timeoutMs: 10000, description: 'first child readiness observed' }).catch(diagnose('g1r_first_ready'));

    inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, { method: 'POST', body: { prompt: CRASH, from: 'orch', reply_to: 'orch' } });
    assert.equal(inject.status, 200, JSON.stringify(inject.body));
    const second = await waitFor(async () => {
      const rd = await readinessOf();
      return observedReady(rd) && rd.input_transport_ready.child_seq > first.input_transport_ready.child_seq ? rd : null;
    }, { timeoutMs: 20000, description: 'the respawned child\'s own readiness (higher child_seq)' }).catch(diagnose('g1r_second_ready'));

    const MARK = 'g1-after-restart-once';
    inject = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, { method: 'POST', body: { prompt: MARK, from: 'orch', reply_to: 'orch' } });
    assert.equal(inject.status, 200, JSON.stringify(inject.body));
    await waitFor(() => (/g1-after-restart-once[\r\n]/.test(lines().map((l) => l.data).join('')) ? true : null),
      { timeoutMs: 10000, description: 'the next inject received by the successor' }).catch(diagnose('g1r_delivery'));

    const got = lines();
    const crashPids = [...new Set(got.filter((l) => l.data.includes(CRASH)).map((l) => l.pid))];
    const markPids = [...new Set(got.filter((l) => l.data.includes('g1-after')).map((l) => l.pid))];
    assert.deepEqual({
      seqAdvanced: second.input_transport_ready.child_seq > first.input_transport_ready.child_seq,
      newPid: second.process_started.pid !== first.process_started.pid,
      crashOnlyOld: crashPids.length === 1 && crashPids[0] === first.process_started.pid,
      markOnlyNew: markPids.length === 1 && markPids[0] === second.process_started.pid,
      markOnce: countOccurrences(got.map((l) => l.data).join(''), MARK),
    }, { seqAdvanced: true, newPid: true, crashOnlyOld: true, markOnlyNew: true, markOnce: 1 });
  } finally {
    cli.kill();
  }
});

// #879: with the `.cmd` shim the fake claude now starts, registers and the inject returns 0 on
// Windows (runs 40507287143 and 40507287234), but the post-bootstrap `SUBMIT:` line carrying the
// bracketed-paste envelope never appeared within 10 s in either run. The logs do not identify the
// layer where the bytes stop (shim, ConPTY input, or the bootstrap drain); no fixture defect is
// demonstrable from them. Measured native-wrapped behaviour under ConPTY is deferred to #577.
// Skipped on win32 WITH this reason; welcome-bootstrap queueing of the first inject is UNVERIFIED
// on Windows, never passed by this skip. Exact case list: this one test.
const BOOTSTRAP_WIN32_SKIP = process.platform === 'win32'
  ? 'win32: wrapped fake-claude under ConPTY — post-bootstrap submit never observed (runs 40507287143 + 40507287234), byte-loss layer not identified; Windows-native runtime deferred, owner #577'
  : false;

// Task 1215 (511): the fake claude's composer frame, i.e. its own application-ready signal (not the welcome line).
const FAKE_CLAUDE_COMPOSER = /─{16}\r?\n❯\r?\n─{16}/;
const readDiscarded = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).join('') : '');

// Task 1215 (511) — replaces the obsolete "early input is consumed by the app" expectation. 0.10.1 hands an inject to the PTY
// at once; this still-starting child DISCARDS it (by design, recorded in discardLog). Asserted: the transport effect (body + one
// Enter before the composer), the truthful report (consumption unknown, never consumed / a new turn), no replay after the
// composer. The early inject's application outcome is intentionally unobservable; real CLI/model acceptance is not proven.
test('telepty allow early transport: body + ONE Enter reach a still-starting fake claude (discarded there), are never replayed after its composer, and are reported consumption unknown', { skip: BOOTSTRAP_WIN32_SKIP }, async () => {
  const sessionId = createSessionId('cli-allow-early');
  const discardLog = path.join(harness.homeDir, `${sessionId}.discarded`);
  const cli = spawnAllowFakeClaude(sessionId, writeFakeClaudeCommand(harness.homeDir, { discardLog, composerAfterEnter: true }));
  let output = '';
  cli.onData((chunk) => { output += chunk; });
  const EARLY = '\u001b[200~early-token\u001b[201~';
  try {
    await waitFor(async () => {
      const body = (await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}`)).body;
      const rd = body && body.transport && body.transport.readiness;
      return rd && rd.input_transport_ready && rd.input_transport_ready.status === 'observed';
    }, { timeoutMs: 7000, description: 'input transport ready (transport only; the application has not drawn its composer)' });
    assert.equal(FAKE_CLAUDE_COMPOSER.test(stripAnsi(output)), false, 'PRECONDITION: no composer before the early inject');

    const early = await harness.runCli(['inject', '--submit', sessionId, 'early-token'], { timeoutMs: 10000 });
    assert.equal(early.code, 0, early.stderr);
    await waitFor(() => /[\r\n]/.test(readDiscarded(discardLog)), { timeoutMs: 10000, description: 'early body + Enter at the child before its composer' });
    await waitFor(() => FAKE_CLAUDE_COMPOSER.test(stripAnsi(output)), { timeoutMs: 10000, description: 'composer drawn after the early input' });
    const discardedAtComposer = readDiscarded(discardLog);

    // The follow-up through the public API, after the composer: the only submit this application accepts.
    const follow = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
      method: 'POST', body: { prompt: 'follow-token', no_enter: true } });
    assert.equal(follow.status, 200, JSON.stringify(follow.body));
    const submit = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
      method: 'POST', body: { injected_body: 'follow-token', retries: 0, retry_delay_ms: 500, inject_id: follow.body.inject_id } });
    await waitFor(() => stripAnsi(output).includes('SUBMIT:'), { timeoutMs: 10000, description: 'fake claude submit after its composer' });

    const normalized = stripAnsi(output);
    // PTY line discipline may turn the bridge's literal CR into LF at child stdin (bridge unit tests prove the single
    // literal CR); normalise CRLF first so one Enter is never counted twice.
    const terminalNormalized = discardedAtComposer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    assert.deepEqual({
      discarded: terminalNormalized,
      earlyBodies: countOccurrences(discardedAtComposer, EARLY),
      enters: countOccurrences(terminalNormalized, '\n'),
      discardedLater: readDiscarded(discardLog) === discardedAtComposer,
      cli: [/stage: sent_to_bridge/.test(early.stdout), /consumption=unknown/.test(early.stdout),
        /consumption=consumed|— consumed as a new turn/.test(early.stdout)],
      api: [submit.status, submit.body.submit_stage, submit.body.consumption, submit.body.submit_confirmed],
      submits: countOccurrences(normalized, 'SUBMIT:'),
      accepted: /SUBMIT:\u001b\[200~follow-token\u001b\[201~\r?\n/.test(normalized),
    }, {
      discarded: `${EARLY}\n`, earlyBodies: 1, enters: 1, discardedLater: true,
      cli: [true, true, false],
      api: [200, 'sent_to_bridge', 'unknown', false],
      submits: 1, accepted: true,
    });
  } finally {
    cli.kill();
  }
});

// Task 1215 (511) — first-instruction positive path (caller bootstrap policy, not a bridge gate): the caller waits ONCE for
// the fixture's actual composer render — not mere registration, not a fixed delay — and then injects. The full bracketed
// body is accepted exactly once with one submit, and nothing was discarded. Real CLI/model acceptance is not proven here.
test('telepty allow first instruction: a caller that waits once for the fake claude composer gets the full body accepted once', { skip: BOOTSTRAP_WIN32_SKIP }, async () => {
  const sessionId = createSessionId('cli-allow-bootstrap');
  const discardLog = path.join(harness.homeDir, `${sessionId}.discarded`);
  const cli = spawnAllowFakeClaude(sessionId, writeFakeClaudeCommand(harness.homeDir, { discardLog }));

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
    await waitFor(() => FAKE_CLAUDE_COMPOSER.test(stripAnsi(output)), { timeoutMs: 10000, description: 'fake claude composer (caller bootstrap, once)' });

    const inject = await harness.runCli(['inject', sessionId, 'dispatch-token'], { timeoutMs: 10000 });
    assert.equal(inject.code, 0, inject.stderr);

    // #760: the drained bootstrap body now carries the #716/#730 bracketed-paste envelope,
    // like every other inject path. The stub echoes whatever bytes it receives (a real
    // claude interprets the markers instead), and the harness stripAnsi only removes SGR —
    // so the markers are still in `output` and the assertion names them.
    await waitFor(() => stripAnsi(output).includes(`SUBMIT:\u001b[200~dispatch-token\u001b[201~`), {
      timeoutMs: 10000,
      description: 'fake claude submit after its composer'
    });

    const normalized = stripAnsi(output);
    assert.equal(countOccurrences(normalized, 'SUBMIT:'), 1);
    assert.equal(readDiscarded(discardLog), '', 'nothing reached the child before its composer');
  } finally {
    cli.kill();
  }
});

function spawnAllowFakeClaude(sessionId, fakeClaude) {
  return pty.spawn(process.execPath, [
    'cli.js',
    'allow',
    '--id',
    sessionId,
    fakeClaude.command
  ], {
    cwd: projectRoot,
    cols: 80,
    rows: 24,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env: {
      ...process.env,
      ...fakeClaude.env,
      HOME: harness.homeDir,
      USERPROFILE: harness.homeDir,
      TELEPTY_HOST: harness.host,
      TELEPTY_PORT: String(harness.port),
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
    }
  });
}

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

// #879: two interactive-TUI cases reproduced on every Windows run (baseline 40486488540, candidate
// 40486724173, final 40492011728, per-file 40500878932: 'update completion message' and 'menu
// recovery after terminal EIO' never arrive under ConPTY within 7 s). Windows-native TUI/ConPTY
// behaviour is deferred to #577; the two cases are skipped on win32 WITH this reason. The only
// other win32 skips in this file are ATTACH_WIN32_SKIP and BOOTSTRAP_WIN32_SKIP above, each with
// its own measured reason. Exact case list here: 'interactive update returns to the TUI instead of
// exiting', 'interactive menu recovers from a terminal EIO instead of crashing'.
const TUI_WIN32_SKIP = process.platform === 'win32'
  ? 'win32: interactive TUI under ConPTY — reproduced timeout in 4/4 Windows runs; Windows-native runtime deferred, owner #577'
  : false;

test('interactive update returns to the TUI instead of exiting', { skip: TUI_WIN32_SKIP }, async () => {
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

test('interactive menu recovers from a terminal EIO instead of crashing', { skip: TUI_WIN32_SKIP }, async () => {
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
