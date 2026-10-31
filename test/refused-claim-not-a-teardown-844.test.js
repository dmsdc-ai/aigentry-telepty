'use strict';

// #844 BLOCKER — a REFUSED owner claim still authorised tearing down the healthy incumbent.
//
// This is the invariant #835 exists to establish — *a refusal must never authorise a destructive
// remediation* — violated by the code path that produces the refusal.
//
// ── The sequence, which is routine in this ecosystem (dup-id / respawn race) ─────────────
//   bridge A: `telepty allow --id X bash`  → first registration, so #815 mints the session
//             credential, A's `?owner=1` claim is accepted, A owns a live PTY.
//   bridge B: `telepty allow --id X bash`  → RE-registration of an id the daemon already holds,
//             so #815 deliberately returns NO credential material to anyone. B's `?owner=1`
//             handshake therefore carries no bearer and is REFUSED with close 4003
//             (src/transport/websocket.js).
//   cli.js:   the 4003 branch called `closeAllowSession()`, whose teardown half issues
//             `DELETE /api/sessions/X`. That DELETE carries `owner_token` only when this bridge
//             HAS one — and B's whole problem is that it does not. So the URL went out bare, the
//             daemon's #536 owner-token guard had nothing to compare, and the session was
//             destroyed. A then got close 1000 'Session destroyed' and exited too.
//
// The bridge that was told "you are not the owner of this session" proceeded to destroy that
// session. It also purged the bridge mailbox for an id it does not own, discarding deliveries
// queued for the incumbent.
//
// The fix: a refused claim exits WITHOUT the destructive half. B still exits 1 and still says why
// — it just no longer acts on an authority the daemon explicitly denied it.
//
// Everything below runs against an isolated daemon (PORT=0, mkdtemp HOME). Nothing touches the
// production daemon or any real session.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const pty = require('node-pty');

const { startTestDaemon, createSessionId, stripAnsi, waitFor, delay } = require('../test-support/daemon-harness');

const projectRoot = path.resolve(__dirname, '..');

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

before(async () => { harness = await startTestDaemon(); });
after(async () => { if (harness) await harness.stop(); });

// #879: `bash` is not a Windows primitive (it may resolve to the WSL launcher, or not at all). The
// incumbent only needs a long-lived interactive child that echoes what it is given, so win32 uses
// this suite's own node by absolute path in REPL mode. POSIX keeps `bash` unchanged.
const INCUMBENT_COMMAND = process.platform === 'win32' ? [process.execPath, '-i'] : ['bash'];

function spawnBridge(sessionId, commandArgs = INCUMBENT_COMMAND) {
  const env = {
    ...process.env,
    HOME: harness.homeDir,
    USERPROFILE: harness.homeDir,
    TELEPTY_HOST: harness.host,
    TELEPTY_PORT: String(harness.port),
    NO_UPDATE_NOTIFIER: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
  };
  // The second bridge must reach its handshake with NO bearer — that is the whole scenario. An
  // ambient one inherited from the shell running the suite would silently make it the owner.
  delete env.TELEPTY_SESSION_TOKEN;
  delete env.TELEPTY_SESSION_ID;

  const proc = pty.spawn(process.execPath, ['cli.js', 'allow', '--id', sessionId, ...commandArgs], {
    cwd: projectRoot,
    cols: 100,
    rows: 30,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env
  });
  const output = { text: '', exit: null };
  proc.onData((d) => { output.text += d; });
  proc.onExit(({ exitCode }) => { output.exit = exitCode; });
  return { proc, output };
}

async function listSessions() {
  const res = await harness.request('/api/sessions');
  return Array.isArray(res.body) ? res.body : [];
}

test('a bridge whose owner claim is REFUSED does not destroy the session it was refused', async (t) => {
  const sessionId = createSessionId('incumbent-844');

  // ── incumbent: first registration, so it holds the #815 credential and owns the PTY ──
  const a = spawnBridge(sessionId);
  t.after(() => { try { a.proc.kill(); } catch { /* already gone */ } });

  await waitFor(async () => {
    const sessions = await listSessions();
    return sessions.some((s) => s.id === sessionId && s.healthStatus === 'CONNECTED');
  }, { timeoutMs: 15000, description: 'incumbent bridge owner connected' });

  const beforeChallenge = (await listSessions()).find(s => s.id === sessionId);

  // ── challenger: a re-registration, so #815 hands it no credential and the claim is refused ──
  const b = spawnBridge(sessionId);
  t.after(() => { try { b.proc.kill(); } catch { /* already gone */ } });

  await waitFor(async () => b.output.exit !== null,
    { timeoutMs: 15000, description: 'refused bridge exits instead of reconnecting' });

  // The refusal happened, and it is the one we mean — otherwise the rest of this test proves
  // nothing about 4003 in particular.
  assert.match(stripAnsi(b.output.text), /Owner claim refused/,
    `the challenger must be refused with 4003; got:\n${stripAnsi(b.output.text).slice(-1200)}`);
  assert.equal(b.output.exit, 1, 'a refused claim is a failure for the bridge that made it');

  // The teardown DELETE, if it went out, is fire-and-forget — give it room to land so this
  // cannot pass by racing ahead of the very thing it is checking for.
  await delay(1500);

  // ── the property ──
  const sessions = await listSessions();
  const survivor = sessions.find((s) => s.id === sessionId);
  assert.ok(survivor,
    'the REFUSED bridge destroyed the session it was refused ownership of — a refusal must never '
    + 'authorise a destructive remediation (#835)');
  assert.equal(survivor.healthStatus, 'CONNECTED',
    'the healthy incumbent must still own its socket after another bridge was refused');
  assert.equal(survivor.ownerPid, beforeChallenge.ownerPid, 'refused challenger must not replace incumbent owner PID');
  // The owner claim can precede the incumbent's own asynchronous PTY metadata update.
  // Only an already observed PTY PID is stable across the challenge.
  if (beforeChallenge.ptyPid != null) {
    assert.equal(survivor.ptyPid, beforeChallenge.ptyPid, 'incumbent PTY PID is preserved');
  }
  assert.equal(a.output.exit, null,
    'the incumbent bridge exited — it was torn down by a bridge the daemon had just refused');
});

test('the incumbent still accepts an inject after the refused claim — it was never disturbed', async (t) => {
  // Survival in the session list is necessary but not sufficient: the point of not tearing the
  // session down is that it keeps WORKING. This also covers the mailbox purge, which
  // `closeAllowSession` performs on the bridge target and which the refused bridge has no
  // business running against an id it does not own.
  const sessionId = createSessionId('still-serving-844');

  const a = spawnBridge(sessionId);
  t.after(() => { try { a.proc.kill(); } catch { /* already gone */ } });
  await waitFor(async () => {
    const sessions = await listSessions();
    return sessions.some((s) => s.id === sessionId && s.healthStatus === 'CONNECTED');
  }, { timeoutMs: 15000, description: 'incumbent bridge owner connected' });

  const b = spawnBridge(sessionId);
  t.after(() => { try { b.proc.kill(); } catch { /* already gone */ } });
  await waitFor(async () => b.output.exit !== null,
    { timeoutMs: 15000, description: 'refused bridge exits' });
  await delay(1500);

  const MARK = `still-serving-${sessionId}`;
  const injected = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: `echo ${MARK}` }
  });
  assert.equal(injected.status, 200,
    `the incumbent must still accept injects; got ${injected.status} ${JSON.stringify(injected.body)}`);

  await waitFor(async () => stripAnsi(a.output.text).includes(MARK),
    { timeoutMs: 10000, description: 'incumbent PTY received the inject' }).catch(async (error) => {
    // #879 diagnostics only (allowlisted; MARK is test-owned): where did the accepted inject stop?
    t.diagnostic(`#879 diag incumbent_delivery ${JSON.stringify({ inject: diagInject(injected), session: await diagSession(sessionId),
      incumbent: diagPty(a.output.text, a.output.exit, { inject_allowed: 'Inject allowed', repl_prompt: '> ', mark_echo: MARK, announce_unsent: 'transport readiness not announced', announce_pid_unavailable: 'pid=unavailable' }),
      challenger: diagPty(b.output.text, b.output.exit, { owner_claim_refused: 'Owner claim refused' }) })}`);
    throw error;
  });
});


test('#135: refused claimant never starts its command or announces ownership', async (t) => {
  const fs = require('node:fs');
  const sessionId = createSessionId('claim-order-135');
  const incumbent = spawnBridge(sessionId);
  t.after(() => { try { incumbent.proc.kill(); } catch {} });
  await waitFor(() => /Inject allowed/.test(incumbent.output.text),
    { timeoutMs: 15000, description: 'accepted bridge starts' });
  const { FileMailbox } = require('../src/mailbox');
  const mailbox = new FileMailbox({ root: path.join(harness.homeDir, '.aigentry', 'mailbox', 'bridge') });
  mailbox.enqueue({ msg_id: 'pending-135', from: 'original-sender', to: sessionId,
    payload: 'pending for incumbent', created_at: Math.floor(Date.now() / 1000), attempt: 0 });
  const marker = path.join(harness.homeDir, 'refused-child-started');
  const challenger = spawnBridge(sessionId, [process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`]);
  t.after(() => { try { challenger.proc.kill(); } catch {} });
  await waitFor(() => challenger.output.exit !== null,
    { timeoutMs: 15000, description: 'challenger refused' });
  assert.match(challenger.output.text, /Owner claim refused/);
  assert.equal(challenger.output.exit, 1);
  assert.doesNotMatch(challenger.output.text, /Inject allowed|Recovered .*undelivered/);
  assert.equal(fs.existsSync(marker), false, 'unowned command must never execute');
  assert.equal(mailbox.peek(sessionId).length, 1, 'incumbent mailbox must remain intact');
});
