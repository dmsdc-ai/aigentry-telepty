'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, stripAnsi, waitFor } = require('../test-support/daemon-harness');

let daemonA = null; // Local-side CLI's daemon (also serves as origin)
let daemonB = null; // Remote-side daemon hosting the target session

function collectMessages(ws, predicate, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(options.description || 'WS message timeout'));
    }, options.timeoutMs || 7000);

    function onMessage(buffer) {
      let parsed = null;
      try {
        parsed = JSON.parse(buffer.toString());
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(parsed);
      }
    }

    ws.on('message', onMessage);
  });
}

// #820/#823 — this file simulates cross-host over LOOPBACK: two harness daemons, two temp HOMEs,
// two DIFFERENT tokens, both on 127.0.0.1 (see the comment inside the first test). So the moment
// loopback stops being a credential, a CLI running out of daemonA's HOME presents daemonA's token
// to daemonB and is refused — in production AND here.
//
// The fix is to resolve the TARGET's token, keyed by ADDRESS. `connect-http --token` is how an
// operator supplies it, and it is the one user-visible migration this release asks for; running it
// once here is what lets every dial site below authenticate against daemonB.
//
// Note what does NOT work and why, because it is the trap: setting TELEPTY_AUTH_TOKEN to daemonB's
// token would make the CLI present it to daemonA too — the local /api/meta probe in
// ensureDaemonRunning — and that 401s. The env override is a FLEET-WIDE token for both ends, not a
// per-target one; a process talking to two daemons needs the per-address path.
before(async () => {
  daemonA = await startTestDaemon();
  daemonB = await startTestDaemon();

  const peer = await daemonA.runCli([
    'connect-http', `${daemonB.host}:${daemonB.port}`,
    '--name', 'crosshost-peer',
    '--token', daemonB.authToken()
  ], { timeoutMs: 8000 });
  assert.equal(peer.code, 0, `connect-http --token failed:\nstderr: ${peer.stderr}\nstdout: ${peer.stdout}`);
});

after(async () => {
  if (daemonA) await daemonA.stop();
  if (daemonB) await daemonB.stop();
});

test('cross-host: <id>@<host>:<port> routes inject to the remote daemon', async () => {
  const sessionId = createSessionId('cross-host-target');
  const spawn = await daemonB.spawnSession(sessionId);
  assert.ok([200, 201].includes(spawn.status), `spawnSession status=${spawn.status}: ${JSON.stringify(spawn.body)}`);

  const targetWs = new WebSocket(
    `ws://${daemonB.host}:${daemonB.port}/api/sessions/${encodeURIComponent(sessionId)}`
    + `?token=${encodeURIComponent(daemonB.authToken())}`);
  await new Promise((resolve, reject) => {
    targetWs.once('open', resolve);
    targetWs.once('error', reject);
  });

  const token = createSessionId('cross-host-token');
  // Task 1215 G-SHELL step 1 (K1) diagnostics only: payload-free counts of everything daemonB's viewer received.
  const viewer = viewerSummary(targetWs, token);
  const seenToken = collectMessages(
    targetWs,
    (msg) => msg.type === 'output' && String(msg.data || '').includes(token),
    { description: 'cross-host inject delivery', timeoutMs: 8000 }
  );
  // Settled at creation: the delivery deadline can never surface as an unhandled rejection ahead of the CLI result.
  const seen = seenToken.then(() => null, (error) => error);

  try {
    // Run the CLI from daemonA's HOME but target daemonB explicitly via @host:port. The token for
    // daemonB is resolved from its peers.json entry BY ADDRESS — the dial site here has only a host
    // string, never a peer name, which is why name-keyed resolution never fired for this path.
    const cliStarted = performance.now(); // Task 1215 native39: diagnostics only (CLI wall time, which bounds when the write happened)
    const result = await daemonA.runCli([
      'inject',
      `${sessionId}@${daemonB.host}:${daemonB.port}`,
      `echo ${token}`
    ], { timeoutMs: 8000 });
    const cliElapsedMs = Math.round(performance.now() - cliStarted);

    assert.equal(result.code, 0, `CLI failed:\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
    const missed = await seen;
    if (missed) {
      // The K1 evidence is fixed (stringified) at failure time, exactly as before; post_verdict below can only add to it.
      const k1 = JSON.stringify({
        cli: { code: result.code, signal: result.signal ?? null, stdout_tail: tail(result.stdout), stderr_tail: tail(result.stderr) },
        target_inject_log: daemonB.getLogs().stdout.split(/\r?\n/).filter((line) => line.startsWith('[INJECT]') && line.includes(sessionId))
          .slice(-4).map((line) => line.slice(0, 240)),
        viewer: viewer(),
      });
      // Task 1215 native39 (failure-only, observe-only; the 8000 ms verdict is ALREADY failed and `missed` is always rethrown):
      // one fixed window keeps the EXISTING viewerSummary listener recording, so a late prompt then late token (queued input
      // behind a slow shell start), a prompt with no token (input lost), no prompt at all (startup still stalled) and a shell
      // exit can be told apart. No write, resend, retry or polling; counts, times and fixed labels only.
      await new Promise((resolve) => setTimeout(resolve, POST_VERDICT_WINDOW_MS));
      const { stdout: bOut, stderr: bErr } = daemonB.getLogs();
      const post = JSON.stringify({ window_ms: POST_VERDICT_WINDOW_MS, cli_elapsed_ms: cliElapsedMs,
        window_end: { ...viewer(), observation_limit: 'viewer counters at the end of the post-verdict window (timing ms after viewer open)' },
        target_ws_ready_state: targetWs.readyState,
        target_exit_log_lines: `${bOut}\n${bErr}`.split(/\r?\n/).filter((line) => line.includes(sessionId) && line.includes('[EXIT]')).length });
      appendEvidence(missed, ` | K1 evidence ${k1} | post_verdict ${post}`);
      throw missed;
    }
  } finally {
    targetWs.close();
  }
});

// Task 1215 G-SHELL step 1 (K1): bounded, payload-free evidence only (counts and booleans; tails capped).
function tail(text) { return String(text ?? '').slice(-600); }
// Task 1215 native39: the fixed post-verdict observation window (same length as the #843 pty33 window).
const POST_VERDICT_WINDOW_MS = 20000;
// The same error object is rethrown (identity, stack frames); only its message and first stack line gain the evidence.
// Task 1215 pty17 (windows42 NA-4): V8 formats `stack` lazily, so it is read BEFORE `message` changes — reading it after
// already contained the note and the evidence appeared twice.
function appendEvidence(error, note) {
  const stack = error.stack;
  const first = `${error.name}: ${error.message}`;
  error.message += note;
  if (typeof stack === 'string' && stack.startsWith(first)) error.stack = first + note + stack.slice(first.length);
}
// Task 1215 pty17 (windows42 NA-1) — payload-free terminal control-sequence IDENTITIES of the viewer output, reported only
// in the failure evidence. CSI: its parameter/intermediate bytes (digits, `; : < = > ?`, 0x20-0x2F — never letters, so never
// text) plus the final byte, e.g. `CSI ?9001h` or `CSI 6n` (a DSR query); OSC: the command NUMBER only (`OSC 0`), never its
// title/text; other ESC sequences by their single final byte. A sequence split across frames is completed by the bounded
// state (<= 32 parameter bytes, <= 5 OSC digits). <= 32 distinct identities (the rest counted); input beyond 262144 code points is not
// parsed (marked). Characters outside sequences count as printable. Observation only: nothing is answered or written.
function controlSequenceIdentities() {
  const ids = new Map();
  let state = 'text'; let params = ''; let osc = ''; let fed = 0; let overflow = 0; let truncated = false; let printable = 0;
  const CODE_POINT_BOUND = 262144; // pty18: `fed` counts for-of CODE POINTS (not UTF-8 bytes); the bound and the report say so
  const add = (id) => { if (ids.has(id)) ids.set(id, ids.get(id) + 1); else if (ids.size < 32) ids.set(id, 1); else overflow++; };
  function step(ch) {
    const code = ch.codePointAt(0);
    if (state === 'text') {
      if (code === 0x1b) state = 'esc';
      else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) { printable++; return true; }
    } else if (state === 'esc') {
      if (ch === '[') { state = 'csi'; params = ''; } else if (ch === ']') { state = 'osc'; osc = ''; }
      else if (code === 0x1b) add('ESC ?');
      else { add(code >= 0x20 && code < 0x7f ? `ESC ${ch}` : 'ESC ?'); state = 'text'; }
    } else if (state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) { add(`CSI ${params}${ch}`); state = 'text'; }
      else if (code >= 0x20 && code <= 0x3f) { if (params.length < 32) params += ch; else { add('CSI overlong'); state = 'csi_skip'; } }
      else { add('CSI malformed'); state = code === 0x1b ? 'esc' : 'text'; }
    } else if (state === 'csi_skip') {
      if (code >= 0x40 && code <= 0x7e) state = 'text'; else if (!(code >= 0x20 && code <= 0x3f)) state = code === 0x1b ? 'esc' : 'text';
    } else if (state === 'osc') {
      if (code >= 0x30 && code <= 0x39 && osc.length < 5) osc += ch;
      else { add(`OSC ${osc || '-'}`); state = code === 0x07 ? 'text' : code === 0x1b ? 'osc_esc' : 'osc_body'; }
    } else if (state === 'osc_body') {
      if (code === 0x07) state = 'text'; else if (code === 0x1b) state = 'osc_esc';
    } else if (state === 'osc_esc') {
      if (ch === '\\') state = 'text'; else { state = 'esc'; return step(ch); } // not ST: a new sequence began
    }
    return false;
  }
  return {
    feed(chunk) {
      let sawPrintable = false;
      for (const ch of chunk) { if (fed >= CODE_POINT_BOUND) { truncated = true; break; } fed++; if (step(ch)) sawPrintable = true; }
      return sawPrintable;
    },
    report: () => ({ identities: Object.fromEntries(ids), distinct_overflow: overflow, printable, parser_state: state, truncated,
      code_point_bound: CODE_POINT_BOUND, fed_code_points: fed }),
  };
}
function viewerSummary(ws, token) {
  let frames = 0; let bytes = 0; let raw = '';
  // Task 1215 pty17: first output/printable/prompt/marker times (ms after this summary started, i.e. after viewer open),
  // observed by this same listener within the test's EXISTING windows only (no extension, no new timer).
  const origin = performance.now(); const ms = () => Math.round(performance.now() - origin);
  const timing = { first_output_ms: null, first_printable_ms: null, prompt_ms: null, marker_ms: null };
  const control = controlSequenceIdentities();
  const plainOf = (text) => stripAnsi(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b[@-Z\\-_]/g, '');
  ws.on('message', (buffer) => {
    let msg = null;
    try { msg = JSON.parse(buffer.toString()); } catch { return; }
    if (msg.type !== 'output' || typeof msg.data !== 'string') return;
    frames++; bytes += Buffer.byteLength(msg.data, 'utf8');
    if (raw.length < 65536) raw += msg.data;
    const at = ms();
    if (timing.first_output_ms === null) timing.first_output_ms = at;
    if (control.feed(msg.data) && timing.first_printable_ms === null) timing.first_printable_ms = at;
    if (timing.prompt_ms === null && raw.length < 65536 && plainOf(raw).includes('PS ')) timing.prompt_ms = at;
    if (timing.marker_ms === null && (raw.includes(token) || plainOf(raw).includes(token))) timing.marker_ms = at;
  });
  return () => {
    const plain = plainOf(raw);
    return { frames, bytes, printable: [...plain].filter((ch) => ch >= ' ' && ch !== '\u007f').length,
      prompt_ps: plain.includes('PS '), token_in_concatenated_output: raw.includes(token) || plain.includes(token),
      timing, control: control.report(),
      observation_limit: 'the existing 8000 ms delivery window only: this test has no outer test deadline, so nothing is observed after it' };
  };
}

test('cross-host: TELEPTY_HOST=host:port produces a clean http URL (no double-port)', async () => {
  // Regression for #13c. Previously TELEPTY_HOST=host:port concatenated :PORT
  // again, producing http://host:port:port/api/... and a parser error.
  const sessionId = createSessionId('cross-host-env');
  await daemonB.spawnSession(sessionId);

  const result = await daemonA.runCli(['list', '--json'], {
    timeoutMs: 8000,
    env: {
      TELEPTY_HOST: `${daemonB.host}:${daemonB.port}`,
      // Intentionally clear TELEPTY_PORT so the embedded port governs.
      TELEPTY_PORT: ''
      // #820: no TELEPTY_AUTH_TOKEN — the address resolves daemonB's stored peer token.
    }
  });

  assert.equal(result.code, 0, `CLI failed:\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
  // The session lives on daemonB; with TELEPTY_HOST=host:port we should see it.
  const out = stripAnsi(result.stdout);
  assert.match(out, new RegExp(sessionId), `session ${sessionId} should appear in output:\n${out}`);
  // Negative regression: stderr must NOT contain the old "Failed to parse URL"
  // error from the doubled-port URL bug (#13c).
  const errCombined = stripAnsi(result.stderr);
  assert.doesNotMatch(errCombined, /Failed to parse URL/, `unexpected URL parse error:\n${errCombined}`);
  assert.doesNotMatch(errCombined, new RegExp(`http://[^\\s]*:${daemonB.port}:${daemonB.port}`), `doubled-port URL detected:\n${errCombined}`);
});

test('connect-http: registers HTTP peer in peers.json and exposes its sessions to discovery', async () => {
  const peersPath = path.join(daemonA.homeDir, '.telepty', 'peers.json');
  // Pre-condition: no peers
  if (fs.existsSync(peersPath)) {
    fs.rmSync(peersPath);
  }

  // #820/#823 — `--token <that host's authToken>` is the migration this release asks cross-host
  // HTTP-peer users to perform, and this is the path that proves it works end to end: the token
  // is stored in peers.json by connect-http and then RESOLVED BY ADDRESS at discovery time.
  // Before this release connect-http wrote `entry.token` and nothing ever read it.
  const peerName = createSessionId('peer-http');
  const connect = await daemonA.runCli([
    'connect-http',
    `${daemonB.host}:${daemonB.port}`,
    '--name', peerName,
    '--token', daemonB.authToken()
  ], { timeoutMs: 8000 });

  assert.equal(connect.code, 0, `connect-http failed:\nstderr: ${connect.stderr}\nstdout: ${connect.stdout}`);

  // peers.json should now contain an HTTP-transport entry
  assert.ok(fs.existsSync(peersPath), 'peers.json should exist after connect-http');
  const peers = JSON.parse(fs.readFileSync(peersPath, 'utf8'));
  const entry = peers.peers && peers.peers[peerName];
  assert.ok(entry, `peer ${peerName} should be persisted`);
  assert.equal(entry.transport, 'http');
  assert.equal(entry.host, daemonB.host);
  assert.equal(entry.port, daemonB.port);
  assert.equal(entry.token, daemonB.authToken(), 'the peer token is stored so discovery can present it');

  // Spawn a fresh session on daemon B and verify it shows up in `list` from A
  const remoteSession = createSessionId('cross-host-discovered');
  await daemonB.spawnSession(remoteSession);

  const list = await daemonA.runCli(['list', '--json'], { timeoutMs: 8000 });
  assert.equal(list.code, 0, list.stderr);
  const listOut = stripAnsi(list.stdout);
  assert.match(listOut, new RegExp(remoteSession), `discovered HTTP-peer session not found in list:\n${listOut}`);
});

test('connect-http: rejects unreachable host with a clear error and non-zero exit', async () => {
  // Use a port we know nothing is listening on. Random high port.
  const deadPort = 30000 + Math.floor(Math.random() * 100);
  const result = await daemonA.runCli([
    'connect-http',
    `127.0.0.1:${deadPort}`,
    '--name', 'should-not-persist'
  ], { timeoutMs: 8000 });

  assert.notEqual(result.code, 0, 'expected non-zero exit when peer unreachable');
  const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
  assert.match(combined, /Cannot reach|connect|reach/i);
});
