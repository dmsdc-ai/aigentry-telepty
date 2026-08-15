'use strict';

// #826 — the WebSocket viewer write path had authority without accountability.
//
// `websocket.js` forwarded a viewer's `{type:'input'}` straight to the owner as `{type:'inject'}`.
// It bypassed everything `POST /api/sessions/:id/inject` applies: `auditAppend` (#47 P5),
// `classifyPeerLaneInject` (#533's hard block) and provenance labelling. Two write paths, equal
// authority, unequal accountability.
//
// Why this ships WITH #820/#823 rather than after: today the audit log is obviously incomplete,
// because anything on the box can write with no credential at all — nobody can read that log as a
// record of anything. The moment loopback stops being a credential every writer is authenticated,
// and an operator will reasonably start reading the inject log as THE record of who typed into a
// session, and #533 as THE enforcement point. Both would then claim more than they measure, which
// is the exact defect class this release exists to remove. The security fix is what creates the
// false confidence.
//
// What this asserts, precisely: the WS path is now held to the SAME rule as the HTTP path — no
// stricter. Both are keyed on a CLAIMED sender, so #533 stays a policy guardrail, not an
// authentication boundary; and `verified_sender_*` on the audit line is the daemon-verified half,
// taken from the #815 bearer on the handshake and never from the frame.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

let daemon;
let TOKEN;
let logPath;

function readDaemonToken(homeDir) {
  return JSON.parse(fs.readFileSync(path.join(homeDir, '.telepty', 'config.json'), 'utf8')).authToken;
}

function base() {
  return `http://${daemon.host}:${daemon.port}`;
}

async function post(pathname, body, headers = {}) {
  const res = await fetch(`${base()}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telepty-token': TOKEN, ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, text };
}

function open(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}${url}`, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
  });
}

function nextFrame(ws, predicate, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); resolve(null); }, timeoutMs);
    function onMessage(buf) {
      let msg = null;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
  });
}

function auditLines() {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function waitForAudit(predicate) {
  return daemon.waitFor(() => {
    const lines = auditLines().filter(predicate);
    return lines.length ? lines : null;
  }, { timeoutMs: 4000, description: 'ws-viewer audit line' });
}

// A registered wrapped session with a credentialed owner bridge and a credentialed viewer.
async function pair(prefix) {
  const sid = createSessionId(prefix);
  const reg = await post('/api/sessions/register', { session_id: sid, command: 'test-wrap', cwd: process.cwd() });
  assert.ok([200, 201].includes(reg.status), `register: ${reg.status} ${reg.text}`);
  const owner = await open(
    `/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}&owner=1&owner_pid=${process.pid}&command=test-wrap`,
    { headers: { 'x-telepty-session-token': reg.body.session_token } }
  );
  const viewer = await open(`/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}`);
  return { sid, owner, viewer, bearer: reg.body.session_token };
}

before(async () => {
  daemon = await startTestDaemon({ env: { TELEPTY_AUDIT_FLUSH_MS: '10' } });
  TOKEN = readDaemonToken(daemon.homeDir);
  logPath = path.join(daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
});

after(async () => { if (daemon) await daemon.stop(); });

test('a viewer input frame is forwarded AND recorded, with source ws-viewer', async () => {
  const { sid, owner, viewer } = await pair('wsaudit');

  const delivered = nextFrame(owner, (m) => m.type === 'inject' && m.data === 'ls -la\r');
  viewer.send(JSON.stringify({ type: 'input', data: 'ls -la\r' }));
  assert.ok(await delivered, 'the viewer write path must keep working — this is not a tightening');

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'ws-viewer');
  const line = lines[0];
  assert.equal(line.v, 1);
  assert.equal(line.kind, 'inject');
  assert.equal(line.source, 'ws-viewer', 'a distinct source so the two write paths stay tellable apart');
  // `forwarded`, not `success`: what the WS path measures is that the frame was written to the
  // owner socket. The HTTP path's `success` means its delivery machinery reported success. Two
  // different measurements must not wear the same word.
  assert.equal(line.delivery_result, 'forwarded');
  assert.equal(line.payload_bytes, Buffer.byteLength('ls -la\r'));
  assert.equal(line.payload_preview, null, 'hash-only by default, same as every other line');
  assert.ok(line.payload_sha256 && line.payload_sha256.length === 64);

  owner.close();
  viewer.close();
});

test('an unproven viewer is recorded as unverified — never as the sid it claims', async () => {
  const { sid, owner, viewer } = await pair('wsclaim');

  const delivered = nextFrame(owner, (m) => m.type === 'inject');
  viewer.send(JSON.stringify({ type: 'input', data: 'echo hi\r', from: 'orchestrator' }));
  await delivered;

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'ws-viewer');
  const line = lines[0];
  assert.equal(line.claimed_from, 'orchestrator', 'the claim is recorded as a claim');
  assert.equal(line.verified_sender_sid, null, 'this socket presented no session bearer — absence, not the claim');
  assert.equal(line.verified_sender_epoch, null);
  assert.equal(line.spoof_suspected, false, 'nothing to compare against: unverified is not suspected');

  owner.close();
  viewer.close();
});

test('a viewer that PROVED its identity gets verified_sender_sid on the line', async () => {
  // The sender registers a session of its own and presents that bearer on the viewer handshake —
  // the same credential `fetchWithAuth` sends as `x-telepty-session-token` on the HTTP path.
  const senderSid = createSessionId('wssender');
  const senderReg = await post('/api/sessions/register', { session_id: senderSid, command: 'test-wrap', cwd: process.cwd() });
  const senderBearer = senderReg.body.session_token;

  const { sid, owner } = await pair('wsverified');
  const viewer = await open(
    `/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}`,
    { headers: { 'x-telepty-session-token': senderBearer } }
  );

  const delivered = nextFrame(owner, (m) => m.type === 'inject');
  viewer.send(JSON.stringify({ type: 'input', data: 'whoami\r', from: senderSid }));
  await delivered;

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'ws-viewer' && l.verified_sender_sid);
  const line = lines[0];
  assert.equal(line.verified_sender_sid, senderSid, 'taken from the handshake bearer, never from the frame');
  // The epoch is the base64url instance id from the bearer's `<epoch>.<secret>` shape (#815), not
  // a counter — and it must be PRESENT, because a verified sid beside a null epoch would read as
  // "verified, instance unknown", which is not a state this daemon can be in.
  assert.equal(typeof line.verified_sender_epoch, 'string');
  assert.ok(line.verified_sender_epoch.length > 0);
  assert.equal(line.spoof_suspected, false);

  owner.close();
  viewer.close();
});

test('#533 applies to the WS path too: an out-of-policy peer-lane write is blocked, not forwarded', async () => {
  // Peer lane = neither end is an orchestrator sid. On that lane the body must be a sanctioned
  // ask-request/ask-reply envelope. Over HTTP this is a hard block; opening a viewer socket used
  // to be the way around it.
  const { sid, owner, viewer } = await pair('wspeer');

  viewer.send(JSON.stringify({ type: 'input', data: 'go do my work for me\r', from: 'peer-alpha' }));
  const leaked = await nextFrame(owner, (m) => m.type === 'inject', 1200);
  assert.equal(leaked, null, 'an out-of-policy peer-lane write must not reach the PTY owner');

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'ws-viewer');
  const line = lines[0];
  assert.match(line.delivery_result, /^blocked:/, 'a blocked attempt is auditable too, not just a delivery');
  assert.equal(line.claimed_from, 'peer-alpha');

  owner.close();
  viewer.close();
});

test('the orchestrator lane is untouched — the guardrail did not become a tightening', async () => {
  const { sid, owner, viewer } = await pair('wsorch');

  const delivered = nextFrame(owner, (m) => m.type === 'inject' && m.data === 'status?\r');
  viewer.send(JSON.stringify({ type: 'input', data: 'status?\r', from: 'orchestrator' }));
  assert.ok(await delivered, 'orchestrator-lane traffic must pass exactly as it does over HTTP');

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'ws-viewer' && l.claimed_from === 'orchestrator');
  assert.equal(lines[0].delivery_result, 'forwarded');

  owner.close();
  viewer.close();
});

// =============================================================================================
// #843 B — the SPAWNED viewer door, and the BUS door. #826 fixed one write path of three.
// =============================================================================================

// A spawned session: the daemon owns the PTY directly, so there is no owner bridge and EVERY
// attached socket is a viewer. `websocket.js` handled it in the `else` arm below the wrapped
// branch — `activeSession.ptyProcess.write(data)`, no policy verdict, no audit line. The #826
// comment one branch up calls the wrapped path "the one write path with no accountability"; the
// spawned path still was exactly that, and the six #826 cases all build wrapped fixtures, so
// nothing ever went through this door.
async function spawned(prefix) {
  const sid = createSessionId(prefix);
  const res = await daemon.spawnSession(sid);
  assert.ok([200, 201].includes(res.status), `spawn: ${res.status} ${JSON.stringify(res.body)}`);
  const viewer = await open(`/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}`);
  return { sid, viewer };
}

// Everything the PTY has echoed back to this socket. For a spawned session the shell echoes what
// is typed into it, so the marker appearing here is proof the bytes reached the PTY — and its
// absence, over a window, is proof they did not.
function collectOutput(ws) {
  const chunks = [];
  ws.on('message', (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type === 'output' && typeof msg.data === 'string') chunks.push(msg.data);
  });
  return () => chunks.join('');
}

test('#843: a SPAWNED session\'s viewer write is authorized and audited, exactly like a wrapped one', async () => {
  const { sid, viewer } = await spawned('spawnaudit');
  const output = collectOutput(viewer);

  viewer.send(JSON.stringify({ type: 'input', data: 'echo SPAWNMARKER_OK\r', from: 'orchestrator' }));
  await daemon.waitFor(() => (output().includes('SPAWNMARKER_OK') ? true : null),
    { timeoutMs: 5000, description: 'the orchestrator-lane write to reach the spawned PTY' });

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'ws-viewer');
  assert.equal(lines.length, 1, 'one line per viewer write, same as the wrapped door');
  assert.equal(lines[0].kind, 'inject');
  assert.equal(lines[0].delivery_result, 'forwarded');
  assert.equal(lines[0].claimed_from, 'orchestrator');
  assert.equal(lines[0].payload_bytes, Buffer.byteLength('echo SPAWNMARKER_OK\r'));

  viewer.close();
});

test('#843: #533 applies at the spawned door too — the block is not one `else` away', async () => {
  const { sid, viewer } = await spawned('spawnpeer');
  const output = collectOutput(viewer);

  viewer.send(JSON.stringify({ type: 'input', data: 'echo SPAWNMARKER_LEAK\r', from: 'peer-alpha' }));
  // A shell echoes what is typed into it, so if these bytes reached the PTY the marker comes back
  // within milliseconds. Give it a full second before concluding it did not.
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(output().includes('SPAWNMARKER_LEAK'), false,
    'an out-of-policy peer-lane write must not reach a spawned PTY either');

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'ws-viewer');
  assert.match(lines[0].delivery_result, /^blocked:/);
  assert.equal(lines[0].claimed_from, 'peer-alpha');

  viewer.close();
});

test('#843: a spawned resize still resizes, and is still not an inject', async () => {
  // The resize DECISION, restated at the second door: geometry is not text. `classifyPeerLaneInject`
  // has no prompt to classify, and recording a window-size change as `kind:'inject'` would put a
  // PTY write in the log that never happened — this release's own defect, committed by the fix for
  // it. Resize therefore stays outside the inject gate at BOTH doors, deliberately and identically.
  const { sid, viewer } = await spawned('spawnresize');
  viewer.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }));
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(auditLines().some((l) => l.to === sid && l.source === 'ws-viewer'), false,
    'a geometry change writes nothing into the PTY — recording it as an inject would be its own overclaim');
  // And it did not take the input path by accident: a resize routed through the inject adapter
  // would have written `undefined` into the shell.
  assert.equal((await post(`/api/sessions/${encodeURIComponent(sid)}/screen`, {})).status !== 500, true);

  viewer.close();
});

test('#843: the BUS door is a PTY write and is audited as one', async () => {
  // `busAutoRoute` writes into any session's PTY via `deliverInjectionToSession` with no audit
  // line and no policy verdict. Same authority as `POST /api/sessions/:id/inject`, no
  // accountability at all — so the inject log, which an operator now reasonably reads as THE
  // record of who typed into a session, was missing a whole door.
  const sid = createSessionId('busaudit');
  const reg = await post('/api/sessions/register', { session_id: sid, command: 'test-wrap', cwd: process.cwd() });
  assert.ok([200, 201].includes(reg.status));
  const owner = await open(
    `/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}&owner=1&owner_pid=${process.pid}&command=test-wrap`,
    { headers: { 'x-telepty-session-token': reg.body.session_token } }
  );

  const delivered = nextFrame(owner, (m) => m.type === 'inject' && m.data === 'bus-audited-task', 5000);
  const publish = await post('/api/bus/publish', {
    type: 'turn_request', target: sid, payload: { prompt: 'bus-audited-task' }
  });
  assert.equal(publish.status, 200);
  assert.ok(await delivered, 'an unattributed bus route still delivers — this is accountability, not a tightening');

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'bus');
  assert.equal(lines[0].kind, 'inject');
  assert.equal(lines[0].delivery_result, 'success');
  assert.equal(lines[0].claimed_from, null, 'no sender was claimed, and absence is recorded as absence');
  assert.equal(lines[0].verified_sender_sid, null,
    'the bus is not an authorization boundary: nothing on it is a verified identity');

  owner.close();
});

test('#843: the BUS door cannot launder a #533 block', async () => {
  // The reproduction, both halves against the same daemon: the HTTP door refuses this payload
  // with 403 and records the attempt; re-addressing the identical payload to the bus used to
  // return 200, land the text in the PTY, and leave the audit log untouched.
  const sid = createSessionId('buslaunder');
  const reg = await post('/api/sessions/register', { session_id: sid, command: 'test-wrap', cwd: process.cwd() });
  const owner = await open(
    `/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}&owner=1&owner_pid=${process.pid}&command=test-wrap`,
    { headers: { 'x-telepty-session-token': reg.body.session_token } }
  );

  const viaHttp = await post(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
    prompt: 'go do my work for me', from: 'peer-alpha'
  });
  assert.equal(viaHttp.status, 403, 'the HTTP door refuses this — that is the rule being enforced');

  const leaked = nextFrame(owner, (m) => m.type === 'inject' && String(m.data).includes('go do my work'), 1500);
  const publish = await post('/api/bus/publish', {
    type: 'turn_request', target: sid, from: 'peer-alpha', payload: { prompt: 'go do my work for me' }
  });
  assert.equal(publish.status, 200, 'publishing is still accepted — it is the ROUTE that must refuse');
  assert.equal(await leaked, null, 'the same payload the HTTP door refused must not reach the PTY via the bus');

  const lines = await waitForAudit((l) => l.to === sid && l.source === 'bus');
  assert.match(lines[0].delivery_result, /^blocked:/);
  assert.equal(lines[0].claimed_from, 'peer-alpha');

  owner.close();
});

test('a resize frame is not an inject and is not audited as one', async () => {
  const { sid, owner, viewer } = await pair('wsresize');

  const resized = nextFrame(owner, (m) => m.type === 'resize');
  viewer.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  assert.ok(await resized, 'terminal geometry must still be forwarded');

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    auditLines().some((l) => l.to === sid && l.source === 'ws-viewer'),
    false,
    'a geometry change writes nothing into the PTY — recording it as an inject would be its own overclaim'
  );

  owner.close();
  viewer.close();
});
