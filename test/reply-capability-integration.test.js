'use strict';

// Task 1292 W6 — reply-capability-v1, daemon-side integration (TEST-PLAN §2: I1, I2, I5, I6, daemon side only).
//
// Written by the coder, NOT executed by the coder.
// One REAL isolated daemon for the file (test-support/daemon-harness), started in before() and stopped in after(). Sessions
// are registered through the real route and claimed by owner WebSockets that present their bearer, so each epoch is PROVED
// (SPEC M7). Every frame the daemon writes to a session is recorded. GB-01/GB-02/GB-03: a requester must be in the support
// matrix (SUPPORT-MATRIX.md). rc-fix8 GB3-02: aterm left it, so every requester is a wrapped session whose owner socket is
// a fake current bridge in this file (guardedRequester): it declares reply-guard-v1, announces its child and answers each
// reply frame with a bridge_receipt. The token is taken only from the trailer delivered to
// the responder, which is how a responder gets it. The requester sids are the configured orchestrator lane
// (AIGENTRY_ORCHESTRATOR_SIDS), so the unchanged peer-lane guard admits the request and both kinds of reply. It is not
// disabled.
// No sleeps. Every wait is a harness bound: waitFor, bounded requests, or audit completion under the case signal. "Exactly
// one write" is counted after a no-Enter sentinel inject has reached the same owner socket. WebSocket frames arrive in
// order, so every earlier write has been received by then.
// Every request a case sends carries that case's t.signal. node:test aborts it when the case ends or times out, and the harness
// then aborts the request (HARNESS_REQUEST_ABORTED). So a slow or failed case leaves no traffic running into the next case on
// the shared daemon.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId, waitFor, HARNESS_OBSERVATION_MARGIN_MS } = require('../test-support/daemon-harness');
const { beginAuditCompletion } = require('../test-support/audit-completion');
const { RESULT_SCHEMA, LIMITS } = require('../src/reply-capability');
const { REQUEST_TIMEOUT_MS } = require('../src/cli/reply-v1');

const ROOT = path.resolve(__dirname, '..');
const CASE = { timeout: 60000 };
// Harness OBSERVATION budgets, not product deadlines. Text into a wrapped owner may wait behind the submit barrier
// (SUBMIT_QUEUE_TIMEOUT_MS, product default 10000) and then for its text (MAILBOX_TEXT_WAIT_MS = 2 x 5000). The same holds
// for the consume route, which delivers through the same function. A CLI process is bounded by its own 30 s deadline.
const DELIVERY_BOUND_MS = 10000 + 2 * 5000 + HARNESS_OBSERVATION_MARGIN_MS;
const CLI_BOUND_MS = REQUEST_TIMEOUT_MS + HARNESS_OBSERVATION_MARGIN_MS;
const TOKEN_RE = /rc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/;
// I2 volume. Each group exists to kill a named mutation; none of them is a load figure (CI-ROOT-CAUSE.md).
//   BEFORE (maxAttempts + 1 per side, all answered before the consume is sent). Two mutations are killed this way. If an
//   inject to the responder superseded or revoked the capability, the consume would be refused. If ordinary traffic to
//   either side were charged as a reply attempt, the capability would be void after maxAttempts.
//   DURING (per side, sent in the same turn as the consume). Two more are killed. A consume that refused or waited on a
//   requester with ordinary messages pending or in flight. An in-flight capability that refused ordinary traffic.
//   AFTER (1 per side, sent once the consume has answered). A reply that left the submit barrier held, or a consumed capability
//   that blocked later traffic, would make this inject answer 503 QUEUE_TIMEOUT instead of 200.
const BEFORE = LIMITS.maxAttempts + 1;
const DURING = 4;
const AFTER = 1;
const TRAFFIC = BEFORE + DURING + AFTER;
const IN_FLIGHT = 4; // at most this many ordinary injects per side in flight at once
// I2 is skipped on win32 only, by name (CI-ROOT-CAUSE.md). Its precondition is that every ordinary no-Enter inject is
// ANSWERED 200. That is the HTTP answer, not a delivery that a wait could observe later: a non-200 answer is final. On
// Windows a no-Enter inject to a wrapped session can get a final, typed 503 from the mailbox's file storage (enqueue → the
// per-session file lock, src/mailbox/lock.js, which times out or throws on a Windows delete-pending entry →
// session-delivery.js catch → 503 DELIVERY_UNCERTAIN). That path is the same with or without the reply capability, and the
// answer must not be retried. On win20 at PR head c971253, 6 of 9 such answers were 200. Their codes were not recorded;
// ordinary() now records them. This property cannot be observed reliably on Windows through this harness. I2 still runs on
// Linux and macOS.
const I2_WIN32_SKIP = process.platform === 'win32'
  ? 'I2 skipped on win32: the 200-answer precondition depends on Windows mailbox file-lock refusals that are not part of the reply capability (CI-ROOT-CAUSE.md)'
  : false;

const REQUESTERS = { i1: createSessionId('w6-req-i1'), i2: createSessionId('w6-req-i2'), i5: createSessionId('w6-req-i5'),
  i5control: createSessionId('w6-req-i5c'), i6: createSessionId('w6-req-i6') };

let harness;
const sockets = [];
const endpoints = [];
before(async () => {
  harness = await startTestDaemon({ env: { TELEPTY_AUDIT_FLUSH_MS: '10', AIGENTRY_ORCHESTRATOR_SIDS: Object.values(REQUESTERS).join(' ') } });
});
after(async () => {
  for (const ws of sockets) { try { ws.close(); } catch { /* already closed */ } }
  if (harness) await harness.stop();
  for (const { server, connections } of endpoints) {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

// A registered wrapped session whose owner socket proved the registered epoch. texts() lists every inject frame written to it.
async function wrapped(sid) {
  const reg = await harness.registerSession(sid, { command: 'test-wrap' });
  assert.ok([200, 201].includes(reg.status) && typeof reg.body.session_token === 'string', `PRECONDITION: register ${sid} -> ${reg.status}`);
  const frames = [];
  const ws = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}`
    + `?owner=1&owner_pid=${process.pid}&command=test-wrap&token=${encodeURIComponent(harness.authToken())}`, harness.ownerAuth(sid));
  sockets.push(ws);
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw)); } catch { /* not a frame we record */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const claim = await waitFor(() => frames.find((f) => f.type === 'owner_token'), { timeoutMs: 5000, description: `${sid} owner_token` });
  assert.equal(claim.interaction_binding.session_epoch, reg.body.session_epoch, 'PRECONDITION: the owner claim proved the registered epoch');
  return { sid, bearer: reg.body.session_token, epoch: reg.body.session_epoch, generation: reg.body.credential_generation,
    texts: () => frames.filter((f) => f.type === 'inject').map((f) => f.data) };
}

// rc-fix8 GB3-02: a registered WRAPPED requester driven by a fake bridge in this file (aterm left the support matrix: its
// endpoint proves no instance). The fake claims the owner socket the way a current bridge does — with its bearer, declaring
// input-transport-ready-v1 and reply-guard-v1 (cli.js:3514-3516) — and announces its child (process_started, then
// input_transport_ready, as test/delivery-discriminators-1215.test.js drives a current bridge), so the daemon admits the
// requester at mint (M7a) and at delivery. For each inject frame carrying the reply_* fields (a reply body and its CR) it
// checks what a current bridge checks at its final write (session epoch, owner generation, child_seq 1, the absolute
// deadline) and answers with the real bridge_receipt wire shape (src/mailbox/bridge-stage.js receiptFrame): pty_written,
// or refused/not_written naming the failed check. Ordinary frames are recorded only. texts() lists the data of every
// inject frame in arrival order (a CR frame's data is "\r").
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function guardedRequester(sid) {
  const reg = await harness.registerSession(sid, { command: 'test-wrap' });
  assert.ok([200, 201].includes(reg.status) && typeof reg.body.session_token === 'string', `PRECONDITION: register ${sid} -> ${reg.status}`);
  const frames = [];
  let token = null;
  let bridgeSeq = 0;
  const ws = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(sid)}?owner=1`,
    { headers: { 'x-telepty-session-token': reg.body.session_token, 'x-telepty-token': harness.authToken(),
      'x-telepty-bridge-capabilities': 'input-transport-ready-v1, reply-guard-v1' } });
  sockets.push(ws);
  ws.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    frames.push(frame);
    if (!token || !frame || frame.type !== 'inject' || !Object.hasOwn(frame, 'reply_not_after_ms')) return;
    const binding = token.interaction_binding;
    const sameInstance = frame.reply_session_epoch === binding.session_epoch && frame.owner_generation === binding.owner_generation
      && frame.reply_child_seq === 1;
    const inTime = Number.isSafeInteger(frame.reply_not_after_ms) && Date.now() <= frame.reply_not_after_ms;
    const written = sameInstance && inTime;
    ws.send(JSON.stringify({ type: 'bridge_receipt', schema: 1, daemon_msg_id: frame.daemon_msg_id ?? null,
      inject_id: typeof frame.inject_id === 'string' && UUID_RE.test(frame.inject_id) ? frame.inject_id : null,
      part: frame.part ?? null, bridge_msg_id: null, stage: written ? 'pty_written' : 'refused',
      reason: written ? null : (sameInstance ? 'reply_deadline_passed' : 'reply_instance_changed'),
      certainty: written ? 'written' : 'not_written', bridge_seq: ++bridgeSeq, at_ms: Date.now(), clock: 'bridge_wall',
      owner_generation: binding.owner_generation }));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  token = await waitFor(() => frames.find((f) => f.type === 'owner_token'), { timeoutMs: 5000, description: `${sid} owner_token` });
  assert.equal(token.interaction_binding.session_epoch, reg.body.session_epoch, 'PRECONDITION: the owner claim proved the registered epoch');
  assert.equal(typeof token.readiness_nonce, 'string', 'PRECONDITION: the daemon negotiated the readiness handshake');
  const b = token.interaction_binding;
  const base = { schema: 1, session_id: sid, session_epoch: b.session_epoch ?? null, owner_generation: b.owner_generation,
    readiness_nonce: token.readiness_nonce, child_seq: 1 };
  ws.send(JSON.stringify({ type: 'process_started', ...base, pid: process.pid, exec: 'unverified' }));
  ws.send(JSON.stringify({ type: 'input_transport_ready', ...base, input_loop: 'attached' }));
  await waitFor(async () => {
    const res = await harness.request(`/api/sessions/${encodeURIComponent(sid)}`);
    const readiness = res.body && res.body.transport && res.body.transport.readiness;
    return readiness && readiness.input_transport_ready && readiness.input_transport_ready.status === 'observed' ? true : null;
  }, { timeoutMs: 5000, description: `${sid}: the child announced and the input loop attached` });
  return { sid, bearer: reg.body.session_token, epoch: reg.body.session_epoch, generation: reg.body.credential_generation,
    texts: () => frames.filter((f) => f.type === 'inject').map((f) => f.data) };
}

const inject = (sid, body, headers, signal) => harness.request(`/api/sessions/${encodeURIComponent(sid)}/inject`,
  { method: 'POST', body, ...(headers ? { headers } : {}), timeoutMs: DELIVERY_BOUND_MS, signal });
const consume = (token, body, headers, signal) => harness.request('/api/reply-capability-v1',
  { method: 'POST', body: { v: 1, capability: token, body }, ...(headers ? { headers } : {}), timeoutMs: DELIVERY_BOUND_MS, signal });

// `count` ordinary no-Enter injects `${label} #${i}#` (i = from, from + 1, ...) to one session. At most IN_FLIGHT are in flight at
// once, and each is bounded by the harness. Nothing new is sent once `signal` has aborted. Returns one { i, status, code }
// per answer. `code` is the typed refusal code (null on 200), so a failed precondition names the refusals.
async function ordinary(sid, label, from, count, signal) {
  const statuses = [];
  let next = 0;
  const worker = async () => {
    while (next < count && !signal.aborted) {
      const i = from + next++;
      const res = await inject(sid, { prompt: `${label} #${i}#`, no_enter: true }, undefined, signal);
      statuses.push({ i, status: res.status, code: (res.body && res.body.code) || null });
    }
  };
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, count) }, worker));
  return statuses;
}

// The requester mints on its own verified inject. The token is read from the responder's delivered text, nowhere else.
async function mint(requester, responder, prompt, signal) {
  const replyPrefix = `REPLY ${crypto.randomBytes(16).toString('hex')}\n`;
  const res = await inject(responder.sid, { prompt, from: requester.sid, exact_target: true,
    reply_capability: { v: 1, not_after_ms: Date.now() + 10 * 60 * 1000, reply_prefix: replyPrefix } },
  { 'x-telepty-session-token': requester.bearer }, signal);
  assert.equal(res.status, 200, `PRECONDITION: mint ${JSON.stringify(res.body)}`);
  const cap = res.body.reply_capability;
  assert.deepEqual(cap.responder, { session_id: responder.sid, epoch: responder.epoch, generation: responder.generation });
  const delivered = await waitFor(() => responder.texts().find((text) => text.includes(`id=${cap.id} `)),
    { timeoutMs: 5000, description: 'the reply-capability trailer at the responder' });
  const token = TOKEN_RE.exec(delivered)[0];
  assert.ok(delivered.includes(prompt) && token.startsWith(`rc1.${cap.id}.`));
  assert.equal(JSON.stringify(res.body).includes(token.split('.')[2]), false, 'the secret is never in the requester response');
  return { id: cap.id, token, secret: token.split('.')[2], replyPrefix, inboundInjectId: res.body.inject_id };
}

// Every inject frame the owner has received, read once a later no-Enter sentinel has arrived on the same socket.
async function drained(owner, signal) {
  const mark = `w6-sentinel-${crypto.randomUUID()}`;
  const res = await inject(owner.sid, { prompt: mark, no_enter: true }, undefined, signal);
  assert.equal(res.status, 200, `PRECONDITION: sentinel ${JSON.stringify(res.body)}`);
  await waitFor(() => owner.texts().some((text) => text.includes(mark)), { timeoutMs: 5000, description: 'the sentinel at the owner' });
  return owner.texts();
}

function readAudit() {
  const file = path.join(harness.homeDir, '.telepty', 'logs', 'injects.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function pick(row, keys) { return Object.fromEntries(keys.map((key) => [key, row[key]])); }
const REPLY_ROW_KEYS = ['kind', 'source', 'claimed_from', 'verified_sender_sid', 'verified_sender_epoch', 'spoof_suspected', 'to',
  'delivery_result', 'sender_proof', 'reply_capability_id', 'reply_to_inject_id', 'payload_preview'];
function replyRow(cap, requester, responder) {
  return { kind: 'inject', source: 'reply-capability-v1', claimed_from: responder.sid, verified_sender_sid: responder.sid,
    verified_sender_epoch: responder.epoch, spoof_suspected: false, to: requester.sid, delivery_result: 'success',
    sender_proof: 'reply-capability-v1', reply_capability_id: cap.id, reply_to_inject_id: cap.inboundInjectId, payload_preview: null };
}

// A real `telepty reply-v1` process. Its env is {PATH, HOME} plus the daemon port and host token, so its HOME is its own state
// root. 'close' (not 'exit') is awaited so stdout is complete.
function replyCli(token, body, { home, env = {} }) {
  const childEnv = { PATH: process.env.PATH, HOME: home, TELEPTY_PORT: String(harness.port), TELEPTY_AUTH_TOKEN: harness.authToken(),
    NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', ...env };
  if (process.platform === 'win32') { childEnv.USERPROFILE = home; childEnv.SystemRoot = process.env.SystemRoot; }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli.js', 'reply-v1', token], { cwd: ROOT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`reply-v1 did not exit within ${CLI_BOUND_MS} ms`)); }, CLI_BOUND_MS);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split('\n').filter(Boolean);
      let result = null;
      try { result = lines.length === 1 ? JSON.parse(lines[0]) : null; } catch { result = null; }
      resolve({ code, stdout, stderr, result });
    });
    child.stdin.end(body);
  });
}

function tempHome(t, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `w6-${label}-home-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('I1 two CLIs, two state roots: one token presented at once by two processes → exactly one write at the receiver, one success audit line', CASE, async (t) => {
  const requester = await guardedRequester(REQUESTERS.i1);
  const responder = await wrapped(createSessionId('w6-resp-i1'));
  const cap = await mint(requester, responder, 'w6 I1 request: answer once', t.signal);
  const body = `w6 I1 reply ${crypto.randomUUID()}`;
  const homes = [tempHome(t, 'i1a'), tempHome(t, 'i1b')];
  const audit = await beginAuditCompletion(harness, t.signal);

  const runs = await Promise.all(homes.map((home) => replyCli(cap.token, body, { home })));
  for (const r of runs) {
    assert.equal(r.result && r.result.schema, RESULT_SCHEMA, `one closed result line: ${r.stdout} ${r.stderr}`);
    assert.equal(`${r.stdout}${r.stderr}`.includes(cap.secret), false, 'the token is never printed');
  }
  const fresh = runs.filter((r) => r.code === 0 && r.result.stage === 'accepted' && r.result.replayed === false);
  assert.equal(fresh.length, 1, `exactly one process wrote: ${JSON.stringify(runs.map((r) => r.result))}`);
  assert.deepEqual(pick(fresh[0].result, ['outcome', 'capability_id', 'destination_session_id']),
    { outcome: 'delivered', capability_id: cap.id, destination_session_id: requester.sid });
  const other = runs.find((r) => r !== fresh[0]).result;
  assert.ok((other.stage === 'refused' && other.reason === 'REPLY_CAPABILITY_IN_FLIGHT' && other.retryable === true)
    || (other.stage === 'accepted' && other.replayed === true && other.reply_inject_id === fresh[0].result.reply_inject_id),
  `the other process met the in-flight record or replayed the recorded answer: ${JSON.stringify(other)}`);

  const texts = await drained(requester, t.signal);
  assert.equal(texts.filter((text) => text.includes(cap.replyPrefix + body)).length, 1, 'exactly one write at the receiver');
  const rows = await audit.settledRows({ read: readAudit,
    match: (row) => row.reply_capability_id === cap.id && row.source === 'reply-capability-v1' && row.delivery_result === 'success' });
  const successes = rows.filter((row) => row.reply_capability_id === cap.id && row.source === 'reply-capability-v1' && row.delivery_result === 'success');
  assert.equal(successes.length, 1, 'one success audit line');
  assert.deepEqual(pick(successes[0], REPLY_ROW_KEYS), replyRow(cap, requester, responder));
  for (const home of homes) assert.deepEqual(fs.readdirSync(home), [], 'the CLI wrote nothing under its own HOME');
});

test('I2 ordinary traffic never blocks: unrelated injects to the responder and ordinary messages to the requester before, during and after the consume in the request window; the reply is accepted, ordered and attributed', { ...CASE, skip: I2_WIN32_SKIP }, async (t) => {
  const requester = await guardedRequester(REQUESTERS.i2);
  const responder = await wrapped(createSessionId('w6-resp-i2'));
  const cap = await mint(requester, responder, 'w6 I2 request', t.signal);
  const body = `w6 I2 reply ${crypto.randomUUID()}`;
  const audit = await beginAuditCompletion(harness, t.signal);

  // No-Enter traffic: it never claims the per-session submit barrier and never waits 500 ms for a CR (see W6-GAPS.md).
  const traffic = (from, count) => Promise.all([ordinary(responder.sid, 'w6-i2-unrelated', from, count, t.signal),
    ordinary(requester.sid, 'w6-i2-ordinary', from, count, t.signal)]);
  const early = await traffic(0, BEFORE);
  const [during, reply] = await Promise.all([traffic(BEFORE, DURING), consume(cap.token, body, undefined, t.signal)]);
  const late = await traffic(BEFORE + DURING, AFTER);
  const [unrelated, ordinaryStatuses] = [0, 1].map((side) => [early, during, late].flatMap((phase) => phase[side]));

  const refusals = (answers) => answers.filter((a) => a.status !== 200);
  assert.deepEqual({ unrelated: unrelated.filter((a) => a.status === 200).length, ordinary: ordinaryStatuses.filter((a) => a.status === 200).length },
    { unrelated: TRAFFIC, ordinary: TRAFFIC }, `PRECONDITION: all ordinary traffic was delivered; non-200 answers ${JSON.stringify(
      { unrelated: refusals(unrelated), ordinary: refusals(ordinaryStatuses) })}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(pick(reply.body, ['schema', 'stage', 'outcome', 'reason', 'capability_id', 'destination_session_id', 'replayed', 'retryable']),
    { schema: RESULT_SCHEMA, stage: 'accepted', outcome: 'delivered', reason: null, capability_id: cap.id,
      destination_session_id: requester.sid, replayed: false, retryable: false });
  const texts = await drained(requester, t.signal);
  assert.equal(texts.filter((text) => text.includes(cap.replyPrefix + body)).length, 1, 'the reply was written once');
  assert.equal(texts.filter((text) => text.includes('w6-i2-ordinary')).length, TRAFFIC, 'and the ordinary messages beside it');
  // Order at the requester. Every message answered before the consume was sent precedes the reply (one FIFO mailbox).
  // Every message sent after the consume answered `delivered` follows it.
  const replyAt = texts.findIndex((text) => text.includes(cap.replyPrefix + body));
  const at = (i) => texts.findIndex((text) => text.includes(`w6-i2-ordinary #${i}#`));
  for (let i = 0; i < BEFORE; i += 1) assert.ok(at(i) >= 0 && at(i) < replyAt, `ordinary #${i} (answered before the consume) precedes the reply`);
  for (let i = BEFORE + DURING; i < TRAFFIC; i += 1) assert.ok(at(i) > replyAt, `ordinary #${i} (sent after the consume answered) follows the reply`);
  assert.equal((await drained(responder, t.signal)).filter((text) => text.includes('w6-i2-unrelated')).length, TRAFFIC);
  const rows = await audit.settledRows({ read: readAudit,
    match: (row) => row.reply_capability_id === cap.id && row.source === 'reply-capability-v1' && row.delivery_result === 'success' });
  const success = rows.filter((row) => row.reply_capability_id === cap.id && row.source === 'reply-capability-v1' && row.delivery_result === 'success');
  assert.equal(success.length, 1);
  assert.deepEqual(pick(success[0], REPLY_ROW_KEYS), replyRow(cap, requester, responder));
});

test('I5 rollback (daemon side): no new field in sessions.json and nothing in the tracked ledger; audit rows parse and differ from a run without the feature only by the additive fields', CASE, async (t) => {
  const requester = await guardedRequester(REQUESTERS.i5);
  const responder = await wrapped(createSessionId('w6-resp-i5'));
  const controlRequester = await guardedRequester(REQUESTERS.i5control);
  const controlResponder = await wrapped(createSessionId('w6-resp-i5c'));
  const audit = await beginAuditCompletion(harness, t.signal);

  // With the feature: mint on the inject, spend through the consume route.
  const cap = await mint(requester, responder, 'w6 I5 request', t.signal);
  const consumed = await consume(cap.token, 'w6 I5 answer', undefined, t.signal);
  assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
  assert.equal(consumed.body.stage, 'accepted');
  // Without it: the same inject, and an ordinary bearer reply.
  const controlInbound = await inject(controlResponder.sid, { prompt: 'w6 I5 request', from: controlRequester.sid, exact_target: true },
    { 'x-telepty-session-token': controlRequester.bearer }, t.signal);
  const controlReply = await inject(controlRequester.sid, { prompt: 'w6 I5 answer', from: controlResponder.sid, exact_target: true },
    { 'x-telepty-session-token': controlResponder.bearer }, t.signal);
  assert.deepEqual([controlInbound.status, controlReply.status], [200, 200], 'PRECONDITION: the control run delivered');

  // Audit: every line parses (readAudit), and each feature row differs from its control row by the additive fields only.
  const rows = await audit.settledRows({ read: readAudit, match: (row) => row.inject_id === consumed.body.reply_inject_id });
  const byId = (id) => { const row = rows.find((r) => r.inject_id === id); assert.ok(row, `audit row ${id}`); return row; };
  const extra = (a, b) => Object.keys(a).filter((key) => !Object.hasOwn(b, key)).sort();
  const [inbound, reply] = [byId(cap.inboundInjectId), byId(consumed.body.reply_inject_id)];
  const [baseInbound, baseReply] = [byId(controlInbound.body.inject_id), byId(controlReply.body.inject_id)];
  assert.deepEqual(extra(inbound, baseInbound), ['reply_capability_id', 'reply_capability_not_after']);
  assert.deepEqual(extra(baseInbound, inbound), []);
  assert.deepEqual(extra(reply, baseReply), ['reply_attempt', 'reply_capability_id', 'reply_to_inject_id', 'sender_proof']);
  // The ordinary reply carries `from`, so it has the claimed-return locator. The capability row names none.
  assert.deepEqual(extra(baseReply, reply), ['claimed_cross_host', 'claimed_return_locator', 'return_locator_verification']);

  // A registration persists every live session synchronously before it answers, so this snapshot follows both runs.
  const flush = await harness.registerSession(createSessionId('w6-i5-flush'), { command: 'test-wrap' });
  assert.ok([200, 201].includes(flush.status), `PRECONDITION: flush register -> ${flush.status}`);
  const stateDir = path.join(harness.homeDir, '.config', 'aigentry-telepty');
  const sessionsText = fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8');
  const stored = JSON.parse(sessionsText);
  const keys = (sid) => { assert.ok(stored[sid], `PRECONDITION: ${sid} persisted`); return Object.keys(stored[sid]).sort(); };
  assert.deepEqual(keys(requester.sid), keys(controlRequester.sid), 'requester record schema unchanged');
  assert.deepEqual(keys(responder.sid), keys(controlResponder.sid), 'responder record schema unchanged');

  const ledgerRoot = path.join(stateDir, 'tracked-injections.json');
  const files = [];
  const walk = (p) => { const st = fs.statSync(p); if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name)); else if (st.isFile()) files.push(p); };
  walk(ledgerRoot);
  const ledgerText = files.map((file) => fs.readFileSync(file).toString('latin1')).join('\n');
  assert.ok(ledgerText.includes(cap.inboundInjectId) && ledgerText.includes(controlInbound.body.inject_id),
    'PRECONDITION: both tracked inbound injects are in the ledger files read here');
  for (const needle of [cap.id, cap.secret, consumed.body.reply_inject_id, 'reply_capability', 'reply-capability', 'sender_proof']) {
    assert.equal(ledgerText.includes(needle), false, `tracked ledger: no reply-capability frame or field (${needle === cap.secret ? 'secret' : needle})`);
    assert.equal(sessionsText.includes(needle), false, `sessions.json: no reply-capability field (${needle === cap.secret ? 'secret' : needle})`);
  }
});

test('I6 direct reply plus capability reply: the responder answers once with its bearer and once with the capability → two writes, each separately attributed', CASE, async (t) => {
  const requester = await guardedRequester(REQUESTERS.i6);
  const responder = await wrapped(createSessionId('w6-resp-i6'));
  const cap = await mint(requester, responder, 'w6 I6 request', t.signal);
  const home = tempHome(t, 'i6');
  const origin = `http://127.0.0.1:${harness.port}`;
  const direct = `w6 I6 direct ${crypto.randomUUID()}`;
  const viaCapability = `w6 I6 capability ${crypto.randomUUID()}`;

  // The CLI attaches a shell's session bearer, as an unfiltered shell does. Another session's bearer is refused, nothing spent.
  const foreign = await replyCli(cap.token, viaCapability, { home, env: { TELEPTY_SESSION_TOKEN: requester.bearer, TELEPTY_SESSION_ORIGIN: origin } });
  assert.deepEqual({ code: foreign.code, reason: foreign.result && foreign.result.reason }, { code: 2, reason: 'REPLY_SENDER_MISMATCH' }, foreign.stderr);

  const audit = await beginAuditCompletion(harness, t.signal);
  const directRes = await inject(requester.sid, { prompt: direct, from: responder.sid, exact_target: true },
    { 'x-telepty-session-token': responder.bearer }, t.signal);
  assert.equal(directRes.status, 200, JSON.stringify(directRes.body));
  const capRun = await replyCli(cap.token, viaCapability, { home, env: { TELEPTY_SESSION_TOKEN: responder.bearer, TELEPTY_SESSION_ORIGIN: origin } });
  assert.equal(capRun.code, 0, capRun.stderr);
  assert.deepEqual(pick(capRun.result, ['stage', 'outcome', 'capability_id', 'replayed']),
    { stage: 'accepted', outcome: 'delivered', capability_id: cap.id, replayed: false });

  const texts = await drained(requester, t.signal);
  assert.equal(texts.filter((text) => text.includes(direct)).length, 1, 'the direct reply was written once');
  assert.equal(texts.filter((text) => text.includes(cap.replyPrefix + viaCapability)).length, 1, 'the capability reply was written once');
  const rows = await audit.settledRows({ read: readAudit, match: (row) => row.inject_id === capRun.result.reply_inject_id });
  assert.notEqual(directRes.body.inject_id, capRun.result.reply_inject_id);
  const directRow = rows.find((row) => row.inject_id === directRes.body.inject_id);
  assert.ok(directRow, 'the direct reply has its own audit line');
  assert.deepEqual(pick(directRow, ['kind', 'source', 'claimed_from', 'verified_sender_sid', 'verified_sender_epoch', 'spoof_suspected', 'to', 'delivery_result']),
    { kind: 'inject', source: 'inject', claimed_from: responder.sid, verified_sender_sid: responder.sid, verified_sender_epoch: responder.epoch,
      spoof_suspected: false, to: requester.sid, delivery_result: 'success' });
  assert.equal(Object.hasOwn(directRow, 'sender_proof') || Object.hasOwn(directRow, 'reply_capability_id'), false, 'the direct reply is not a capability reply');
  assert.deepEqual(pick(rows.find((row) => row.inject_id === capRun.result.reply_inject_id), REPLY_ROW_KEYS), replyRow(cap, requester, responder));
});
