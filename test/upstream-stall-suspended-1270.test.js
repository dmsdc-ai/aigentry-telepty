'use strict';

// Task 1270 — UPSTREAM_STALLED classification is suspended (user-directed, next hotfix).
//
// Live sequence: prompt text reaches the PTY, the Enter does not, nothing is printed. The
// #732 probe then stays unanswered, the session was classified UPSTREAM_STALLED and the
// recovery inject was refused with 503. Output silence is not evidence of a dead pipe, so the
// classification (and its input rejection) stays off until the missing-Enter defect is
// conclusively fixed and a user-approved patch restores it.
//
// Real factory seam: createDeliveryRuntime + createSessionDeliveryContext composed exactly as
// test-support/session-delivery-fixture.js does, but dependency-free: that fixture loads
// src/transport/websocket.js, which requires the `ws` package. Stand-ins: the owner socket and
// isOpenWebSocket (same predicate as src/transport/websocket.js isOpenWebSocket).
// TELEPTY_REPO_ROOT may name another package root (baseline vs candidate verification only).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.TELEPTY_REPO_ROOT ? path.resolve(process.env.TELEPTY_REPO_ROOT) : path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(ROOT, 'src/mailbox/delivery-runtime.js'))) {
  throw new Error(`PRECONDITION: TELEPTY_REPO_ROOT must name a Telepty package root (got ${JSON.stringify(ROOT)})`);
}
const load = rel => require(path.join(ROOT, rel));

function isOpenWebSocket(ws) { return Boolean(ws && ws.readyState === 1); }

function createSessionDeliveryFixture() {
  const { createDeliveryRuntime } = load('src/mailbox/delivery-runtime.js');
  const { createSessionDeliveryContext } = load('src/mailbox/session-delivery.js');
  const metadata = load('src/session-store/route-metadata.js');
  const { createCredentialStore } = load('src/session-store/session-credentials.js');
  const { FileMailbox } = load('src/mailbox/index.js');
  const { DeliveryEngine } = load('src/mailbox/delivery.js');
  const { applyProvenance } = load('src/audit/provenance.js');
  const { SessionStateManager, stripAnsi } = load('session-state.js');
  const { createLedgerClient } = load('src/session-store/ledger-client.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1270-'));
  const ledgerDir = path.join(root, 'tracked-injections.json');
  const ledgerClient = createLedgerClient({ dir: ledgerDir, lockPath: path.join(root, 'tracked-injections.lock'), legacyPath: ledgerDir });
  const sessions = Object.create(null);
  const shared = {
    sessions, crypto, fs, sessionPersistence: load('src/session-store/persistence.js'), sessionCredentials: createCredentialStore(),
    ledgerClient, trackedLedgerHealthy: false, trackedLedgerUnavailableReason: 'not_opened',
    TRACKED_INJECTIONS_PATH: ledgerDir, pendingReports: Object.create(null),
    busClients: new Set([{ readyState: 1, send() {} }]),
    interaction: load('src/interaction.js'), interactionWaiters: new Map(),
    readyRegistry: load('src/prompt-symbol-registry.js'),
    sessionStateManager: new SessionStateManager(), stripAnsiState: stripAnsi,
    submitGate: load('src/submit-gate.js'),
    CAPABILITY_STAGE_A: load('src/completion-observation.js').CAPABILITY_STAGE_A,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    initializeBootstrapState: metadata.initializeBootstrapState,
    isOpenWebSocket, isProcessRunning: load('daemon-control.js').isProcessRunning,
    UPSTREAM_STALL_SECONDS: 30, SESSION_STALE_SECONDS: 60, WRAPPED_SUBMIT_DELAY_MS: 500,
    BOOTSTRAP_READY_TIMEOUT_MS: 30000,
    BRACKETED_PASTE_START: '\x1b[200~', BRACKETED_PASTE_END: '\x1b[201~',
    MODAL_RING_TAIL_BYTES: 65536, MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
    MODAL_REMEDY_BY_CLI: { claude: 'park' }, MODAL_REMEDY_DEFAULT: 'hold',
    MODAL_HINT_BY_CLI: {}, MODAL_HOLD_DEFAULT_MS: 30000, MODAL_PARK_TTL_DEFAULT_MS: 600000, MODAL_PARK_POLL_MS: 500,
  };
  const runtime = createDeliveryRuntime(shared);
  shared.interactionCore = runtime.createInteractionRuntime();
  const mailbox = new FileMailbox({ root: path.join(root, 'mailbox') });
  let engine;
  const context = createSessionDeliveryContext({ ...runtime, sessions, crypto, applyProvenance,
    interaction: shared.interaction, isOpenWebSocket, DELIVERY_TIMEOUT_MS: 1000,
    getMailbox: () => mailbox, getMailboxDelivery: () => engine,
    getMailboxNotifier: () => ({ notify() { throw new Error('PRECONDITION: wrapped fixture must not notify UDS'); } }) });
  shared.writeDataToSession = context.writeDataToSession;
  engine = new DeliveryEngine(mailbox, context.mailboxDeliveryOptions);
  return { ...runtime,
    deliverInjectionToSession(id, session, prompt, options) {
      if (!Object.prototype.hasOwnProperty.call(sessions, id)) {
        session.id = id;
        sessions[id] = session;
        metadata.initializeBootstrapState(session);
        shared.sessionStateManager.register(id);
      }
      return context.deliverInjectionToSession(id, session, prompt, options);
    },
    async dispose() {
      engine.stop();
      for (const [id, session] of Object.entries(sessions)) {
        shared.sessionStateManager.unregister(id);
        runtime.cancelModalParkPoll(session);
        if (session.bootstrapOptimisticTimer) clearTimeout(session.bootstrapOptimisticTimer);
      }
      try { await ledgerClient.close(2000); } catch { /* never opened */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const PROMPT_RING = '$ ';

function wrappedSession({ open = true } = {}) {
  const written = [];
  return {
    type: 'wrapped',
    command: 'sh',
    backend: 'pty',
    cmuxWorkspaceId: null,
    bootstrapReady: true,
    bootstrapReadyReason: 'owner_alive',
    outputRing: [PROMPT_RING],
    outputRingTotalBytes: PROMPT_RING.length,
    ownerWs: { readyState: open ? 1 : 3, send: (msg) => { written.push(JSON.parse(msg).data); } },
    written,
  };
}

const STALL_MS = 30_000;   // fixture UPSTREAM_STALL_SECONDS (30)

test('1270: quiet after an unanswered input/submit is not classified UPSTREAM_STALLED', (t) => {
  const d = createSessionDeliveryFixture();
  t.after(() => d.dispose());
  const s = wrappedSession();
  d.armUpstreamProbe(s, 0);   // input/submit written, Enter absent, no output follows
  for (const nowMs of [STALL_MS, STALL_MS * 10, 24 * 3600 * 1000]) {
    assert.equal(d.isUpstreamStalled(s, nowMs), true,
      'diagnostic predicate still observes the unanswered probe (observation kept, not erased)');
    assert.equal(d.getSessionHealthStatus(s, { nowMs }), 'CONNECTED',
      `open owner socket with silent output stays CONNECTED at +${nowMs}ms`);
    assert.equal(d.getSessionHealthReason(s, d.getSessionHealthStatus(s, { nowMs })), 'OWNER_CONNECTED');
    assert.equal(d.getInjectFailure(s, { nowMs }), null, 'no input rejection on the basis of output silence');
  }
  // A shorter per-call threshold must not reactivate the gate either.
  assert.equal(d.getSessionHealthStatus(s, { nowMs: 5_000, stallSeconds: 1 }), 'CONNECTED');
  assert.equal(d.getInjectFailure(s, { nowMs: 5_000, stallSeconds: 1 }), null);
});

test('1270: output/heartbeat telemetry stays truthful; nothing is invented', (t) => {
  const d = createSessionDeliveryFixture();
  t.after(() => d.dispose());
  const s = wrappedSession();
  s.bridgeHeartbeatAt = '2026-11-15T00:00:00.000Z';
  s.bridgePtyBytes = 7;
  d.armUpstreamProbe(s, 0);
  const quiet = d.buildSessionTransportBlock(s, { nowMs: 90_000 });
  assert.equal(quiet.health_status, 'CONNECTED');
  assert.equal(quiet.upstream_silent_seconds, 90, 'silence is still measured');
  assert.equal(quiet.upstream_bytes, PROMPT_RING.length, 'no output bytes are invented');
  assert.equal(quiet.bridge_heartbeat_at, '2026-11-15T00:00:00.000Z');
  assert.equal(quiet.bridge_pty_bytes, 7);
  assert.equal(quiet.ready, false, 'no ready claim is fabricated');
  assert.deepEqual(quiet.instruction_received,
    { status: 'unknown', reason: 'no_message_bound_provider_acknowledgement' }, 'no consumption claim');

  s.outputRingTotalBytes += 3;   // real output arrives
  const answered = d.buildSessionTransportBlock(s, { nowMs: 91_000 });
  assert.equal(answered.upstream_silent_seconds, null);
  assert.equal(answered.upstream_bytes, PROMPT_RING.length + 3);
});

test('1270: prolonged quiet does not hard-reject the next (recovery) input', async (t) => {
  const d = createSessionDeliveryFixture();
  t.after(() => d.dispose());
  const s = wrappedSession();
  const first = await d.deliverInjectionToSession('c1270-recover', s, 'prompt text', { noEnter: true });
  assert.equal(first.success, true, `PRECONDITION: first input accepted ${JSON.stringify(first)}`);
  assert.ok(s.upstreamProbeAt != null, 'PRECONDITION: delivery armed the upstream probe');
  assert.equal(s.written.includes('\r'), false, 'PRECONDITION: no Enter was written (noEnter)');

  s.upstreamProbeAt = Date.now() - 10 * STALL_MS;   // the probe went unanswered well past the old threshold
  assert.equal(d.isUpstreamStalled(s), true, 'PRECONDITION: old detector would have fired');

  const recovery = await d.deliverInjectionToSession('c1270-recover', s, 'recovery text', { noEnter: true });
  assert.notEqual(recovery.code, 'UPSTREAM_STALLED', JSON.stringify(recovery));
  assert.equal(recovery.success, true, `recovery input is receivable ${JSON.stringify(recovery)}`);
  assert.equal(s.written.length, 2, 'both bodies reached the owner socket');
  assert.equal(s.written.includes('\r'), false, 'no Enter is fabricated');
});

test('1270: independently grounded refusals are preserved', (t) => {
  const d = createSessionDeliveryFixture();
  t.after(() => d.dispose());
  const nowMs = Date.parse('2026-11-15T01:00:00.000Z');

  const closing = wrappedSession();
  closing.isClosing = true;
  assert.equal(d.getInjectFailure(closing, { nowMs }).code, 'SESSION_CLOSING');

  const disconnected = wrappedSession({ open: false });
  disconnected.lastDisconnectedAt = new Date(nowMs - 1000).toISOString();
  assert.equal(d.getSessionHealthStatus(disconnected, { nowMs }), 'DISCONNECTED');
  assert.equal(d.getInjectFailure(disconnected, { nowMs }).code, 'DISCONNECTED');

  const stale = wrappedSession({ open: false });
  stale.lastDisconnectedAt = new Date(nowMs - 120_000).toISOString();   // fixture SESSION_STALE_SECONDS 60
  assert.equal(d.getSessionHealthStatus(stale, { nowMs }), 'STALE');
  assert.equal(d.getInjectFailure(stale, { nowMs }).code, 'STALE');
});
