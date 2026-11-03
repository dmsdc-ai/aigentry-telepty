'use strict';

// Task 1215 — public error and correlated submit receipt contract (in-process, real factories).
//
// Drives the REAL daemon-side `telepty inject --submit` route pair in-process:
//   POST /api/sessions/:id/inject  {prompt, no_enter:true, from}        (cli.js:4151-4159 body)
//   POST /api/sessions/:id/submit  {injected_body, retries, retry_delay_ms[, inject_id]} (cli.js:4195-4199)
// through the real createSessionActions route handlers, the real createDeliveryRuntime
// (submitViaPty / recordBridgeReceipt / tracked ledger), the real createSessionDeliveryContext
// (mailbox body path) and the real correlateRequest. The only stand-ins are:
//   - a fake owner WS that records every outgoing frame and echoes ONE bridge receipt per inject
//     frame built by the real bridge-side builder bridgeStage.receiptFrame(frameMeta(frame ids)),
//     exactly what security-actions.js writeDirectInject sends after a PTY write;
//   - transportAccept(): the three-step owner-frame receipt glue of src/transport/websocket.js:90-100
//     (validateBridgeReceipt -> skip if no inject_id -> recordBridgeReceipt), because websocket.js
//     requires the `ws` package; this suite loads neither;
//   - isOpenWebSocket: same predicate as src/transport/websocket.js:17-19 (same reason);
//   - an exact own-property session resolver in place of session-records resolveSessionAlias.
// No daemon, listener, socket, network, provider or real PTY. Ledger = real ledger client + owner
// worker thread on a private directory under $TMPDIR.
//
// Assertion prefixes: "PRECONDITION:" = harness/setup error (INVALID run, not a product finding);
// "REGRESSION:" = behavioral contract assertion.
//
// The package under test is this repository (this file lives in <root>/test/). TELEPTY_REPO_ROOT may name
// another package root, for isolated candidate verification only.

const { test, before, after } = require('node:test');
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

const FROM = 'fixture-sender';
const SIDS = { c1: 'tpub-orch-c1', c2: 'tpub-orch-c2', a: 'tpub-orch-a', b: 'tpub-orch-b',
  ep: 'tpub-orch-epoch', ow: 'tpub-orch-owner', bad: 'tpub-orch-badid' };

let H = null;

function isOpenWebSocket(ws) { return Boolean(ws && ws.readyState === 1); }

async function compose() {
  const { createDeliveryRuntime } = load('src/mailbox/delivery-runtime.js');
  const { createSessionDeliveryContext } = load('src/mailbox/session-delivery.js');
  const { createSessionActions } = load('src/routes/session-actions.js');
  const { correlateRequest } = load('src/diagnostics/correlation.js');
  const bridgeStage = load('src/mailbox/bridge-stage.js');
  const inputPolicy = load('src/mailbox/input-policy.js');
  const sessionPersistence = load('src/session-store/persistence.js');
  const metadata = load('src/session-store/route-metadata.js');
  const { createCredentialStore } = load('src/session-store/session-credentials.js');
  const { FileMailbox } = load('src/mailbox/index.js');
  const { DeliveryEngine } = load('src/mailbox/delivery.js');
  const { applyProvenance } = load('src/audit/provenance.js');
  const { SessionStateManager, stripAnsi } = load('session-state.js');
  const { createLedgerClient } = load('src/session-store/ledger-client.js');
  const interaction = load('src/interaction.js');
  const readyRegistry = load('src/prompt-symbol-registry.js');
  const submitGate = load('src/submit-gate.js');
  const { CAPABILITY_STAGE_A } = load('src/completion-observation.js');
  const { isProcessRunning } = load('daemon-control.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-public-error-'));
  const ledgerDir = path.join(root, 'tracked-injections.json');
  const ledgerClient = createLedgerClient({ dir: ledgerDir, lockPath: path.join(root, 'tracked-injections.lock'), legacyPath: ledgerDir });
  const sessions = Object.create(null);
  const pendingReports = Object.create(null);
  const bus = [];
  const busClients = new Set([{ readyState: 1, send: data => bus.push(data) }]);
  const audits = [];
  const sessionStateManager = new SessionStateManager();
  const pendingReceipts = [];

  const rshared = {
    sessions, crypto, fs, sessionPersistence, sessionCredentials: createCredentialStore(),
    auditWriter: { append: record => audits.push(record) },
    ledgerClient, trackedLedgerHealthy: false, trackedLedgerUnavailableReason: 'not_opened',
    TRACKED_INJECTIONS_PATH: ledgerDir, pendingReports, busClients,
    interaction, interactionWaiters: new Map(), readyRegistry, sessionStateManager,
    stripAnsiState: stripAnsi, submitGate, CAPABILITY_STAGE_A,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    initializeBootstrapState: metadata.initializeBootstrapState,
    isOpenWebSocket, isProcessRunning, PEER_INJECT_KINDS: new Set(['ask-request', 'ask-reply']),
    UPSTREAM_STALL_SECONDS: 30, SESSION_STALE_SECONDS: 60, WRAPPED_SUBMIT_DELAY_MS: 500,
    BOOTSTRAP_READY_TIMEOUT_MS: 30000,
    BRACKETED_PASTE_START: '\x1b[200~', BRACKETED_PASTE_END: '\x1b[201~',
    MODAL_RING_TAIL_BYTES: 65536, MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
    MODAL_REMEDY_BY_CLI: { claude: 'park' }, MODAL_REMEDY_DEFAULT: 'hold',
    MODAL_HINT_BY_CLI: { claude: 'Answer the blocking modal.', codex: 'Dismiss the update modal.' },
    MODAL_HOLD_DEFAULT_MS: 30000, MODAL_PARK_TTL_DEFAULT_MS: 600000, MODAL_PARK_POLL_MS: 500,
  };
  const runtime = createDeliveryRuntime(rshared);
  rshared.interactionCore = runtime.createInteractionRuntime();
  const opened = await runtime.restoreTrackedInjections();
  assert.equal(opened && opened.ok, true, `PRECONDITION: private ledger opens ${JSON.stringify(opened)}`);

  const mailbox = new FileMailbox({ root: path.join(root, 'mailbox') });
  let engine;
  const context = createSessionDeliveryContext({ ...runtime, sessions, crypto, applyProvenance, interaction,
    isOpenWebSocket, DELIVERY_TIMEOUT_MS: 1000,
    getMailbox: () => mailbox, getMailboxDelivery: () => engine,
    getMailboxNotifier: () => ({ notify() { throw new Error('PRECONDITION: wrapped fixture must not notify UDS'); } }) });
  rshared.writeDataToSession = context.writeDataToSession;
  engine = new DeliveryEngine(mailbox, context.mailboxDeliveryOptions);

  const ashared = {
    ...runtime,
    sessions, pendingReports, busClients, crypto, ledgerClient, sessionStateManager, stripAnsiState: stripAnsi,
    submitGate, readyRegistry, sessionPersistence,
    deliverInjectionToSession: context.deliverInjectionToSession,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    isOpenWebSocket,
    resolveSessionAlias: id => (typeof id === 'string' && Object.hasOwn(sessions, id) ? id : null),
    ORCHESTRATOR_SIDS: Object.values(SIDS), MACHINE_ID: 'tpub-fixture-machine',
    NON_TERMINAL_GATE_REASONS: new Set(['timeout', 'no_state', 'no_state_manager', 'busy_settled']),
    SUBMIT_BUSY_DISPATCH_ENABLED: true, SUBMIT_BUSY_GRACE_MS: 250,
    REDELIVER_ENABLED: true, REDELIVER_MAX_ATTEMPTS: 3, REDELIVER_TOTAL_TIMEOUT_MS: 600000, REDELIVER_IDLE_WAIT_MS: 120000,
    CAPABILITY_STAGE_A, deliveredAbsenceIdentities: new WeakMap(),
  };
  const actions = createSessionActions(ashared, {});
  const routes = Object.create(null);
  const app = { post(route, handler) { routes[route] = handler; } };
  actions.registerSubmitRoute(app);
  actions.registerInjectRoute(app);
  assert.equal(typeof routes['/api/sessions/:id/inject'], 'function', 'PRECONDITION: inject route registered');
  assert.equal(typeof routes['/api/sessions/:id/submit'], 'function', 'PRECONDITION: submit route registered');

  // websocket.js:90-100 owner-frame receipt glue (validated, current owner socket only).
  async function transportAccept(ws, raw) {
    const session = sessions[ws.sid];
    if (!session || session.isClosing || session.type !== 'wrapped' || session.ownerWs !== ws) return { accepted: false, reason: 'not_current_owner' };
    const msg = JSON.parse(raw);
    const ownerGeneration = session.interactionOwnerGeneration;
    const checked = bridgeStage.validateBridgeReceipt(msg, ownerGeneration);
    if (!checked.ok) return { accepted: false, reason: checked.reason };
    session.bridgeStageGeneration = ownerGeneration;
    if (!checked.receipt.inject_id) return { accepted: true, filed: 'not_filed_no_inject_id' };
    return { accepted: true, filed: await runtime.recordBridgeReceipt(ws.sid, session, checked.receipt, ownerGeneration) };
  }

  let bridgeSeq = 0;
  function ownerSocket(label) {
    const ws = {
      label, sid: null, readyState: 1, frames: [], receipts: [], forgeInjectId: null, ownerGeneration: null,
      send(raw) {
        const msg = JSON.parse(raw);
        ws.frames.push(msg);
        if (msg.type !== 'inject') return;
        // security-actions.js handleOwnerInject: the frame's daemon ids travel with the record.
        const meta = {};
        for (const key of ['daemon_msg_id', 'inject_id', 'part', 'pair', 'owner_generation']) if (msg[key] !== undefined) meta[key] = msg[key];
        let ids = bridgeStage.frameMeta(meta);
        if (ws.forgeInjectId) ids = { ...ids, inject_id: ws.forgeInjectId };   // negative control only
        const receipt = bridgeStage.receiptFrame({ meta: ids, bridgeMsgId: null, stage: 'pty_written', certainty: 'written',
          bridgeSeq: ++bridgeSeq, atMs: Date.now(), ownerGeneration: ws.ownerGeneration });
        const entry = { frame: msg, receipt: receipt ? JSON.parse(receipt) : null, result: null, forged: !!ws.forgeInjectId };
        ws.receipts.push(entry);
        if (!receipt) { entry.result = { accepted: false, reason: 'receipt_unbuildable' }; return; }
        pendingReceipts.push(new Promise(resolve => setImmediate(resolve))
          .then(() => transportAccept(ws, receipt)).then(result => { entry.result = result; }));
      },
    };
    return ws;
  }

  // Owner claim with the real input-policy authority path: request (registration) -> mint
  // generation -> bind with the presented capability (websocket.js:408 + bindInputPolicy).
  function claimOwner(session, ws, origin) {
    const capability = inputPolicy.mintInputPolicyCapability(session);
    inputPolicy.requestInputPolicy(session, 'user-supervised', 'operator_principal_registration', new Date(), { origin });
    if (session.ownerWs && session.ownerWs !== ws) { session.clients.delete(session.ownerWs); }
    session.ownerWs = ws;
    session.clients.add(ws);
    session.interactionOwnerGeneration = crypto.randomUUID();
    inputPolicy.bindInputPolicy(session, new Date(), { capability });
    ws.sid = session.id;
    ws.ownerGeneration = session.interactionOwnerGeneration;
    assert.equal(inputPolicy.userSupervised(session), true, 'PRECONDITION: session bound user-supervised for this owner generation');
  }

  function registerSession(sid) {
    const ws = ownerSocket(sid);
    const epoch = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const session = { id: sid, type: 'wrapped', command: 'claude', clients: new Set(), ownerWs: null,
      sessionEpoch: epoch, sessionEpochProved: epoch, credentialGeneration: 1,
      outputRing: [], outputRingTotalBytes: 0, createdAt: nowIso, lastActivityAt: nowIso, lastConnectedAt: nowIso };
    sessions[sid] = session;
    claimOwner(session, ws, 'new_instance');
    metadata.initializeBootstrapState(session);
    sessionStateManager.register(sid);
    assert.equal(metadata.isBootstrapGatedSession(session), false, 'PRECONDITION: supervised session is not bootstrap-gated');
    return session;
  }

  function call(route, sid, body) {
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200,
        status(code) { res.statusCode = code; return res; },
        json(payload) { resolve({ status: res.statusCode, body: payload }); return res; } };
      Promise.resolve(routes[route]({ params: { id: sid }, body, headers: {}, query: {} }, res)).catch(reject);
    });
  }

  async function drain() {
    for (let i = 0; i < 10 && pendingReceipts.length; i++) await Promise.all(pendingReceipts.splice(0));
    await new Promise(resolve => setImmediate(resolve));
  }

  async function inject(sid, prompt) {
    const ws = sessions[sid].ownerWs;
    const seen = ws.frames.length;
    // cli.js buildInjectRequestBody(prompt, { fromId, noEnter: useSubmit })
    const r = await call('/api/sessions/:id/inject', sid, { prompt, no_enter: true, from: FROM });
    await drain();
    assert.equal(r.status, 200, `PRECONDITION: inject accepted ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.inject_id), /^[a-f0-9-]{36}$/, 'PRECONDITION: inject_id returned');
    const bodyFrames = ws.frames.slice(seen).filter(f => f.type === 'inject' && f.data !== '\r');
    assert.equal(bodyFrames.length, 1, `PRECONDITION: exactly one body frame written ${JSON.stringify(bodyFrames)}`);
    return { injectId: r.body.inject_id, bodyFrame: bodyFrames[0], response: r };
  }

  async function submit(sid, prompt, extra = {}) {
    const ws = sessions[sid].ownerWs;
    const seen = ws.frames.length;
    const seenReceipts = ws.receipts.length;
    sessionStateManager.markIdle(sid);   // controlled fixture state: REPL idle, so the gate does not burn 10 s
    // cli.js submitBody (--submit --no-submit-force --submit-retry 0) plus the optional contract field.
    const r = await call('/api/sessions/:id/submit', sid, { injected_body: prompt, retries: 0, retry_delay_ms: 500, ...extra });
    await drain();
    const crFrames = ws.frames.slice(seen).filter(f => f.type === 'inject' && f.data === '\r');
    return { response: r, crFrames, receipts: ws.receipts.slice(seenReceipts) };
  }

  async function record(injectId) {
    const fetched = await runtime.fetchTrackedInjection(injectId);
    assert.ok(fetched && fetched.record, `PRECONDITION: tracked record readable ${JSON.stringify(fetched && fetched.reason)}`);
    return fetched.record;
  }
  function correlate(rec, sid) {
    const session = sessions[sid];
    return correlateRequest(rec, { injectId: rec.inject_id, sessionId: sid, sessionEpoch: session.sessionEpoch,
      ownerGeneration: session.interactionOwnerGeneration, now: Date.now() });
  }
  const submitReceipts = rec => (rec.observations || []).filter(o => o.kind === 'bridge_receipt' && o.part === 'submit');
  const bodyReceipts = rec => (rec.observations || []).filter(o => o.kind === 'bridge_receipt' && o.part === 'body');

  async function dispose() {
    try { engine.stop(); } catch {}
    for (const [id, session] of Object.entries(sessions)) {
      try { runtime.cancelModalParkPoll(session); } catch {}
      // The owner-alive bootstrap floor (scheduleBootstrapPromptPoll) is a per-session timer that the daemon clears
      // when the owner disconnects (src/transport/websocket.js). These fake owners never disconnect, so teardown
      // clears it, as test-support/session-delivery-fixture.js does.
      if (session.bootstrapOptimisticTimer) { clearTimeout(session.bootstrapOptimisticTimer); session.bootstrapOptimisticTimer = null; }
      try { sessionStateManager.unregister(id); } catch {}
    }
    try { sessionStateManager.destroyAll(); } catch {}
    try { await ledgerClient.close(2000); } catch (error) { console.error(`[harness] ledger close failed: ${error && error.message}`); }
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { sessions, runtime, bridgeStage, registerSession, claimOwner, ownerSocket, inject, submit, record, correlate,
    submitReceipts, bodyReceipts, drain, dispose, audits, bus, call, sessionStateManager, metadata, rshared };
}

function assertCrBytes(cr, label) {
  assert.equal(cr.type, 'inject', `REGRESSION: ${label} CR frame type`);
  assert.equal(cr.data, '\r', `REGRESSION: ${label} CR bytes are exactly \\r`);
  assert.equal(cr.part, 'submit', `REGRESSION: ${label} CR frame part:'submit'`);
  assert.equal(Object.hasOwn(cr, 'pair'), false, `REGRESSION: ${label} CR frame carries no pair (no invented body daemon_msg_id)`);
  assert.match(String(cr.daemon_msg_id), /^submit:[a-f0-9-]{36}$/, `REGRESSION: ${label} CR daemon_msg_id is a terminal-level submit id`);
}

before(async () => {
  console.log(`# HARNESS_ROOT ${ROOT}`);
  H = await compose();
}, { timeout: 20000 });

after(async () => { if (H) await H.dispose(); }, { timeout: 20000 });

// ── Case 1: baseline / legacy no-ID — body receipt correlates, CR receipt cannot ───────────────────
test('case1 legacy no-ID inject --submit: body receipt correlates, CR receipt is not attributable', { timeout: 20000 }, async () => {
  const sid = SIDS.c1;
  H.registerSession(sid);
  const prompt = 'PROBE-C1 tpub base';
  const { injectId, bodyFrame } = await H.inject(sid, prompt);
  assert.equal(bodyFrame.inject_id, injectId, 'REGRESSION: body frame carries the tracked inject_id');
  assert.equal(bodyFrame.part, 'body', 'REGRESSION: body frame part:body');
  assert.ok(String(bodyFrame.data).includes(prompt), 'REGRESSION: body frame bytes carry the prompt');

  const s = await H.submit(sid, prompt);
  assert.equal(s.response.status, 200, `REGRESSION: legacy no-ID submit status 200 ${JSON.stringify(s.response.body)}`);
  assert.equal(s.response.body.success, true, 'REGRESSION: legacy submit success');
  assert.equal(s.crFrames.length, 1, `REGRESSION: exactly one CR frame for retries:0 (${s.crFrames.length})`);
  assertCrBytes(s.crFrames[0], 'legacy');
  assert.equal(Object.hasOwn(s.crFrames[0], 'inject_id'), false, 'REGRESSION: legacy no-ID CR frame carries no inferred inject_id');
  assert.equal(s.receipts.length, 1, 'PRECONDITION: fixture bridge echoed one CR receipt');
  assert.deepEqual(s.receipts[0].result, { accepted: true, filed: 'not_filed_no_inject_id' },
    'REGRESSION: id-less CR receipt is accepted by the transport but filed on no record');

  const rec = await H.record(injectId);
  assert.equal(H.bodyReceipts(rec).length, 1, 'REGRESSION: one body pty_written receipt filed on the record');
  assert.equal(H.submitReceipts(rec).length, 0, 'REGRESSION: no submit receipt attributed to the record for a legacy no-ID submit');
  const c = H.correlate(rec, sid);
  assert.equal(c.correlation, 'exact_instance_and_owner', 'REGRESSION: correlation is exact instance + owner');
  assert.equal(c.input_written.status, 'observed', 'REGRESSION: input_written observed from the body receipt');
  assert.equal(c.input_written.meaning, 'pty_master_write_only', 'REGRESSION: input_written is a PTY write only');
  assert.equal(c.submit_written.status, 'unknown', 'REGRESSION: submit_written unknown for the legacy no-ID submit');
  assert.equal(c.submit_written.reason, 'no_submit_write_receipt', 'REGRESSION: submit_written reason no_submit_write_receipt');
  assert.equal(c.acknowledgement.status, 'unknown', 'REGRESSION: no synthetic acknowledgement');
  assert.equal(c.instruction_received.status, 'unknown', 'REGRESSION: no synthetic instruction receipt');
  console.log(`# CASE1 ${JSON.stringify({ inject_id: injectId, body_frame: { daemon_msg_id: bodyFrame.daemon_msg_id, inject_id: bodyFrame.inject_id, part: bodyFrame.part },
    cr_frame: s.crFrames[0], cr_receipt: s.receipts[0].receipt, cr_receipt_result: s.receipts[0].result,
    input_written: c.input_written.status, submit_written: c.submit_written })}`);
});

// ── Case 2: correlated optional-ID contract — observed submit after repair ─────────────────────────
test('case2 optional inject_id contract: CR frame carries the id and submit_written becomes observed', { timeout: 20000 }, async (t) => {
  const sid = SIDS.c2;
  H.registerSession(sid);
  const prompt = 'PROBE-C2 tpub corr';
  const { injectId } = await H.inject(sid, prompt);
  // cli.js contract (REVIEW §5.1): submitBody gains inject_id from the /inject response.
  const s = await H.submit(sid, prompt, { inject_id: injectId });
  const cr = s.crFrames[0];
  const rec = await H.record(injectId);
  const c = H.correlate(rec, sid);
  console.log(`# CASE2 ${JSON.stringify({ inject_id: injectId, status: s.response.status, cr_frames: s.crFrames,
    cr_receipts: s.receipts.map(r => ({ receipt: r.receipt, result: r.result })), submit_written: c.submit_written })}`);

  await t.test('2a delivery unchanged: status, single CR, CR bytes, no pair', () => {
    assert.equal(s.response.status, 200, `REGRESSION: correlated submit status 200 ${JSON.stringify(s.response.body)}`);
    assert.equal(s.response.body.success, true, 'REGRESSION: correlated submit success');
    assert.equal(s.crFrames.length, 1, 'REGRESSION: exactly one CR frame');
    assertCrBytes(cr, 'correlated');
  });
  await t.test('2b owner CR frame carries the caller-supplied inject_id', () => {
    assert.equal(cr && cr.inject_id, injectId, 'REGRESSION: CR frame inject_id equals the original inject_id');
    assert.equal(cr && cr.owner_generation, H.sessions[sid].interactionOwnerGeneration, 'REGRESSION: CR frame names the current owner generation');
  });
  await t.test('2c CR receipt filed on the exact record; submit_written observed (PTY write only)', () => {
    assert.equal(s.receipts.length, 1, 'PRECONDITION: fixture bridge echoed one CR receipt');
    assert.deepEqual(s.receipts[0].result, { accepted: true, filed: 'tracking_bridge_receipt' }, 'REGRESSION: CR receipt filed on the tracked record');
    assert.equal(H.submitReceipts(rec).length, 1, 'REGRESSION: one submit pty_written receipt on the record');
    assert.equal(c.submit_written.status, 'observed', 'REGRESSION: submit_written observed');
    assert.equal(c.submit_written.meaning, 'pty_master_write_only', 'REGRESSION: submit_written means PTY master write only');
    assert.equal(c.input_written.status, 'observed', 'REGRESSION: input_written still observed');
  });
  await t.test('2d no synthetic acknowledgement / instruction receipt from the CR receipt', () => {
    assert.equal(c.acknowledgement.status, 'unknown', 'REGRESSION: acknowledgement stays unknown');
    assert.equal(c.instruction_received.status, 'unknown', 'REGRESSION: instruction_received stays unknown');
    assert.equal(c.consumption.status, 'unknown', 'REGRESSION: consumption is not derived from a CR receipt');
  });
  await t.test('2e structural: CLI submitBody carries the inject_id from the /inject response', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'cli.js'), 'utf8');
    const start = cli.indexOf('const submitBody = {');
    assert.notEqual(start, -1, 'PRECONDITION: cli.js submitBody literal located');
    const block = cli.slice(start, cli.indexOf('};', start) + 2);
    assert.match(block, /inject_id/, `REGRESSION: cli.js submitBody forwards inject_id\n${block}`);
  });
});

// ── Case 3: foreign session / epoch / owner / invalid correlation cannot alter the wrong record ────
test('case3 foreign/epoch/owner/invalid correlation never updates the wrong record', { timeout: 45000 }, async (t) => {
  const snapshot = async ids => Object.fromEntries(await Promise.all(ids.map(async id => {
    const rec = await H.record(id);
    return [id, { observations: (rec.observations || []).length, submit: H.submitReceipts(rec).length }];
  })));

  await t.test('3a foreign session: B /submit with A\'s inject_id', async () => {
    H.registerSession(SIDS.a); H.registerSession(SIDS.b);
    const a = await H.inject(SIDS.a, 'PROBE-3A tpub own');
    const b = await H.inject(SIDS.b, 'PROBE-3B tpub own');
    const pre = await snapshot([a.injectId, b.injectId]);
    const s = await H.submit(SIDS.b, 'PROBE-3B tpub own', { inject_id: a.injectId });
    const post = await snapshot([a.injectId, b.injectId]);
    console.log(`# CASE3A ${JSON.stringify({ a: a.injectId, b: b.injectId, status: s.response.status, cr_frames: s.crFrames,
      results: s.receipts.map(r => r.result), pre, post })}`);
    assert.equal(s.response.status, 200, 'REGRESSION: foreign valid inject_id does not change the submit status (REVIEW §6 T2)');
    assert.equal(s.crFrames.length, 1, 'REGRESSION: CR still delivered once to B');
    assertCrBytes(s.crFrames[0], 'foreign');
    assert.ok(!Object.hasOwn(s.crFrames[0], 'inject_id') || s.crFrames[0].inject_id === a.injectId,
      'REGRESSION: CR frame never carries an id the caller did not supply');
    assert.deepEqual(post[a.injectId], pre[a.injectId], 'REGRESSION: A\'s record unchanged by B\'s submit');
    assert.equal(post[b.injectId].submit, 0, 'REGRESSION: B\'s record gains no submit receipt it was not named for');
    for (const r of s.receipts) assert.notEqual(r.result && r.result.filed, 'tracking_bridge_receipt', 'REGRESSION: foreign receipt not filed');
  });

  await t.test('3b negative control: bridge receipt forged with a foreign inject_id is refused by identity', async () => {
    const a = await H.inject(SIDS.a, 'PROBE-3A2 tpub own');
    const b = await H.inject(SIDS.b, 'PROBE-3B2 tpub own');
    const pre = await snapshot([a.injectId, b.injectId]);
    const wsB = H.sessions[SIDS.b].ownerWs;
    wsB.forgeInjectId = a.injectId;
    let s;
    try { s = await H.submit(SIDS.b, 'PROBE-3B2 tpub own'); } finally { wsB.forgeInjectId = null; }
    const post = await snapshot([a.injectId, b.injectId]);
    console.log(`# CASE3B ${JSON.stringify({ results: s.receipts.map(r => r.result), pre, post })}`);
    assert.equal(s.receipts.length, 1, 'PRECONDITION: one forged CR receipt echoed');
    assert.deepEqual(s.receipts[0].result, { accepted: true, filed: 'receipt_identity_mismatch' },
      'REGRESSION: recordBridgeReceipt refuses a receipt naming another session\'s record');
    assert.deepEqual(post, pre, 'REGRESSION: neither record changed');
  });

  await t.test('3c epoch changed after the inject: old inject_id cannot file on the record', async () => {
    const session = H.registerSession(SIDS.ep);
    const prompt = 'PROBE-3E tpub epo';
    const x = await H.inject(SIDS.ep, prompt);
    const pre = await snapshot([x.injectId]);
    const epoch = crypto.randomUUID();
    session.sessionEpoch = epoch; session.sessionEpochProved = epoch;
    const s = await H.submit(SIDS.ep, prompt, { inject_id: x.injectId });
    const post = await snapshot([x.injectId]);
    console.log(`# CASE3C ${JSON.stringify({ status: s.response.status, cr_frames: s.crFrames, results: s.receipts.map(r => r.result), pre, post })}`);
    for (const cr of s.crFrames) assertCrBytes(cr, 'epoch');
    assert.deepEqual(post, pre, 'REGRESSION: record of the previous epoch unchanged');
    for (const r of s.receipts) assert.notEqual(r.result && r.result.filed, 'tracking_bridge_receipt', 'REGRESSION: cross-epoch receipt not filed');
  });

  await t.test('3d owner generation rotated after the inject: old inject_id cannot file on the record', async () => {
    const session = H.registerSession(SIDS.ow);
    const prompt = 'PROBE-3O tpub own';
    const x = await H.inject(SIDS.ow, prompt);
    const pre = await snapshot([x.injectId]);
    H.claimOwner(session, H.ownerSocket(`${SIDS.ow}-reclaim`), 'reregistration');
    const s = await H.submit(SIDS.ow, prompt, { inject_id: x.injectId });
    const post = await snapshot([x.injectId]);
    console.log(`# CASE3D ${JSON.stringify({ status: s.response.status, cr_frames: s.crFrames, results: s.receipts.map(r => r.result), pre, post })}`);
    for (const cr of s.crFrames) assertCrBytes(cr, 'owner');
    assert.deepEqual(post, pre, 'REGRESSION: record of the previous owner generation unchanged');
    for (const r of s.receipts) assert.notEqual(r.result && r.result.filed, 'tracking_bridge_receipt', 'REGRESSION: cross-owner receipt not filed');
  });

  await t.test('3e unknown and malformed inject_id: no record updated (status not pinned)', async () => {
    H.registerSession(SIDS.bad);
    const prompt = 'PROBE-3X tpub bad';
    const x = await H.inject(SIDS.bad, prompt);
    const pre = await snapshot([x.injectId]);
    const unknown = await H.submit(SIDS.bad, prompt, { inject_id: crypto.randomUUID() });
    const malformed = await H.submit(SIDS.bad, prompt, { inject_id: 'not-a-uuid' });
    const post = await snapshot([x.injectId]);
    console.log(`# CASE3E ${JSON.stringify({ unknown: { status: unknown.response.status, cr_frames: unknown.crFrames, results: unknown.receipts.map(r => r.result) },
      malformed: { status: malformed.response.status, cr_frames: malformed.crFrames, results: malformed.receipts.map(r => r.result) }, pre, post })}`);
    for (const cr of [...unknown.crFrames, ...malformed.crFrames]) assertCrBytes(cr, 'invalid-id');
    assert.deepEqual(post, pre, 'REGRESSION: the session\'s own record is not updated by an unknown/malformed id');
    for (const r of [...unknown.receipts, ...malformed.receipts]) {
      assert.notEqual(r.result && r.result.filed, 'tracking_bridge_receipt', 'REGRESSION: unknown/malformed receipt not filed');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C1/C2 block — public error JSON nondisclosure and the correlation_basis label.
//
// C1  Public error JSON must not leak raw Error objects, internal error messages/stacks or unsafe
//     `extra` overrides; documented public messages/status/code and safe extra fields are preserved.
//     "c1-direct" = adversarial tests of the helper only (NOT a caller reproduction).
//     "c1-caller" = real route handlers. The bootstrap case injects a throw at the transport peer:
//     production strict-owner.js:46-48 throws a synchronous Error from ownerWs.send while readyState
//     is 1; the thrown CONTENT here is a harness sentinel, the throw SITE and every hop are real.
// C2  submit_written observed → correlation_basis:'transport_receipt_by_inject_id' plus a limits line
//     that a CR write labelled with an inject_id does not establish composer contents or model
//     receipt; unknown stays unknown and carries no observed-receipt basis.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

Object.assign(SIDS, { k1: 'tpub-orch-k1', k2: 'tpub-orch-k2', rc: 'tpub-orch-rc', bs: 'tpub-orch-boot' });

const SENTINEL = 'TPUB_SENTINEL_internal_detail';
const SECRET_PATH = '/private/tpub/secret-path/ledger.json';
const SECRET_TOKEN = 'tpub-secret-token-value';
// Shape of a real Node system error: non-enumerable message/stack, ENUMERABLE errno/code/syscall/path.
function internalError(message = `${SENTINEL} open ${SECRET_PATH} token=${SECRET_TOKEN}`) {
  return Object.assign(new Error(message), { errno: -2, code: 'ENOENT', syscall: 'open', path: SECRET_PATH });
}
function leaks(serialized) {
  return [SENTINEL, SECRET_PATH, SECRET_TOKEN, '\n    at '].filter(s => String(serialized).includes(s));
}
function captureRes() {
  const res = { statusCode: 200, payload: undefined, serialized: undefined,
    status(code) { res.statusCode = code; return res; },
    // express res.json serializes with JSON.stringify
    json(payload) { res.payload = payload; res.serialized = JSON.stringify(payload); return res; } };
  return res;
}

// ── C1 direct helper (adversarial; not a caller reproduction) ─────────────────────────────────────
test('c1-direct buildErrorBody/respondWithError helper contract (adversarial, not a caller reproduction)', { timeout: 5000 }, async (t) => {
  const { buildErrorBody, respondWithError } = H.runtime;
  assert.equal(typeof buildErrorBody, 'function', 'PRECONDITION: runtime exposes buildErrorBody');
  assert.equal(typeof respondWithError, 'function', 'PRECONDITION: runtime exposes respondWithError');
  const injectId = '0d6f3a52-3b7e-4c1d-9a8e-5f2b7c9d1e04';

  await t.test('c1d-1 documented string error, status, code and safe extra fields preserved exactly', () => {
    const extra = { inject_id: injectId, tracking_state: 'aborted', reason: 'tracking_persistence_failed', bytes_written: 0,
      requested: 'tpub-x', httpStatus: 503, delivery_uncertain: true, retryable: false, queue_wait_ms: 12, submit: 'skipped' };
    const text = 'Delivery outcome unknown after an attempt; automatic retry disabled. Do not retry blindly.';
    assert.deepEqual(buildErrorBody('DELIVERY_UNCERTAIN', text, extra), { success: false, code: 'DELIVERY_UNCERTAIN', error: text, ...extra },
      'REGRESSION: safe internal/public error body unchanged');
    const res = captureRes();
    respondWithError(res, 503, 'TRACKING_CAPACITY', 'Observation tracking capacity is not available; no task bytes were delivered.',
      { inject_id: injectId, tracking_state: 'unavailable', reason: 'hot_capacity' });
    assert.equal(res.statusCode, 503, 'REGRESSION: status preserved');
    assert.deepEqual(res.payload, { success: false, code: 'TRACKING_CAPACITY',
      error: 'Observation tracking capacity is not available; no task bytes were delivered.',
      inject_id: injectId, tracking_state: 'unavailable', reason: 'hot_capacity' }, 'REGRESSION: documented public body preserved');
  });

  await t.test('c1d-2 a raw Error passed as `error` does not serialize its message/stack/enumerable props', () => {
    const body = buildErrorBody('DELIVERY_FAILED', internalError());
    const res = captureRes();
    respondWithError(res, 500, 'DELIVERY_FAILED', internalError());
    console.log(`# C1D2 ${JSON.stringify({ body_serialized: JSON.stringify(body), res_status: res.statusCode, res_serialized: res.serialized })}`);
    assert.equal(res.statusCode, 500, 'REGRESSION: status preserved');
    assert.equal(body.success, false, 'REGRESSION: success:false preserved');
    assert.equal(body.code, 'DELIVERY_FAILED', 'REGRESSION: code preserved');
    assert.equal(typeof body.error, 'string', 'REGRESSION: public `error` is a string, not a raw Error object');
    assert.ok(body.error.length > 0, 'REGRESSION: public `error` is non-empty');
    assert.deepEqual(leaks(JSON.stringify(body)), [], 'REGRESSION: buildErrorBody output carries no internal error detail');
    assert.deepEqual(leaks(res.serialized), [], 'REGRESSION: respondWithError JSON carries no internal error detail');
  });

  await t.test('c1d-3 `extra` cannot override success/code/error', () => {
    const body = buildErrorBody('SESSION_NOT_FOUND', 'Session not found',
      { success: true, code: 'OK', error: `${SENTINEL} ${SECRET_PATH}`, requested: 'tpub-x' });
    console.log(`# C1D3 ${JSON.stringify(body)}`);
    assert.equal(body.success, false, 'REGRESSION: extra cannot flip success');
    assert.equal(body.code, 'SESSION_NOT_FOUND', 'REGRESSION: extra cannot replace code');
    assert.equal(body.error, 'Session not found', 'REGRESSION: extra cannot replace the public error text');
    assert.equal(body.requested, 'tpub-x', 'REGRESSION: safe extra field kept');
    assert.deepEqual(leaks(JSON.stringify(body)), [], 'REGRESSION: overriding extra leaks nothing');
  });

  await t.test('c1d-4 Error objects and stack strings inside `extra` do not serialize', () => {
    const body = buildErrorBody('DELIVERY_FAILED', 'Delivery failed; see daemon log.',
      { cause: internalError(), stack: internalError().stack, inject_id: injectId });
    console.log(`# C1D4 ${JSON.stringify(body)}`);
    assert.equal(body.error, 'Delivery failed; see daemon log.', 'REGRESSION: documented text preserved');
    assert.equal(body.inject_id, injectId, 'REGRESSION: safe extra field kept');
    assert.deepEqual(leaks(JSON.stringify(body)), [], 'REGRESSION: no Error/stack detail from extra in public JSON');
  });
});

// ── C1 real caller: documented public errors through the real /inject route (must be preserved) ──
test('c1-caller documented public errors via the real /inject route are preserved', { timeout: 10000 }, async (t) => {
  assert.equal(typeof H.call, 'function', 'PRECONDITION: extended composition exposes call');
  H.registerSession(SIDS.rc);
  await t.test('c1c-1 404 SESSION_NOT_FOUND', async () => {
    const r = await H.call('/api/sessions/:id/inject', 'tpub-no-such-session', { prompt: 'x', no_enter: true, from: FROM });
    assert.equal(r.status, 404, 'REGRESSION: status 404');
    assert.deepEqual(r.body, { success: false, code: 'SESSION_NOT_FOUND', error: 'Session not found', requested: 'tpub-no-such-session' },
      'REGRESSION: documented 404 body preserved');
  });
  await t.test('c1c-2 400 INVALID_REQUEST prompt is required', async () => {
    const r = await H.call('/api/sessions/:id/inject', SIDS.rc, { no_enter: true, from: FROM });
    assert.equal(r.status, 400, 'REGRESSION: status 400');
    assert.deepEqual(r.body, { success: false, code: 'INVALID_REQUEST', error: 'prompt is required' }, 'REGRESSION: documented 400 body preserved');
  });
  await t.test('c1c-3 409 TARGET_EPOCH_MISMATCH', async () => {
    const r = await H.call('/api/sessions/:id/inject', SIDS.rc, { prompt: 'x', no_enter: true, from: FROM, expected_epoch: 'not-the-epoch' });
    assert.equal(r.status, 409, 'REGRESSION: status 409');
    assert.deepEqual(r.body, { success: false, code: 'TARGET_EPOCH_MISMATCH', error: 'Target session epoch differs' }, 'REGRESSION: documented 409 body preserved');
  });
});

// ── C1 real caller: /submit bootstrap drain — transport throw must not leak its internal message ──
test('c1-caller /submit bootstrap drain: a transport throw does not leak internal error detail (real caller)', { timeout: 15000 }, async (t) => {
  const sid = SIDS.bs;
  const ws = H.ownerSocket(sid);
  const epoch = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  // Guarded (no user-supervised binding) wrapped claude session whose bootstrap is not ready yet.
  const session = { id: sid, type: 'wrapped', command: 'claude', clients: new Set([ws]), ownerWs: ws,
    sessionEpoch: epoch, sessionEpochProved: epoch, credentialGeneration: 1, interactionOwnerGeneration: crypto.randomUUID(),
    outputRing: [], outputRingTotalBytes: 0, createdAt: nowIso, lastActivityAt: nowIso, lastConnectedAt: nowIso };
  ws.sid = sid; ws.ownerGeneration = session.interactionOwnerGeneration;
  H.sessions[sid] = session;
  H.metadata.initializeBootstrapState(session);
  H.sessionStateManager.register(sid);
  assert.equal(H.metadata.isBootstrapGatedSession(session), true, 'PRECONDITION: guarded claude session is bootstrap-gated');
  assert.notEqual(session.bootstrapReady, true, 'PRECONDITION: bootstrap not ready yet');

  const thrown = Object.assign(new Error(`STRICT_OWNER_SEND_REFUSED ${SENTINEL} ${SECRET_PATH} token=${SECRET_TOKEN}`),
    { code: 'STRICT_OWNER_SEND_REFUSED', path: SECRET_PATH });
  const send = ws.send;
  let thrownCount = 0;
  ws.send = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'inject' && msg.data === '\r') { thrownCount++; throw thrown; }
    return send(raw);
  };
  const busBefore = H.bus.length;
  const pending = H.call('/api/sessions/:id/submit', sid, { injected_body: 'PROBE-BS tpub boot', retries: 0, retry_delay_ms: 500 });
  assert.equal(session.bootstrapQueue.length, 1, 'PRECONDITION: the /submit op was parked on the bootstrap queue');
  H.runtime.markBootstrapReady(sid, session, 'ready');   // the bridge `ready` frame path releases the drain
  const r = await pending;
  await H.drain();
  const busFailed = H.bus.slice(busBefore).filter(raw => String(raw).includes('bootstrap_queue_failed'));
  console.log(`# C1BOOT ${JSON.stringify({ thrown_count: thrownCount, status: r.status, body: r.body,
    bus_bootstrap_queue_failed: busFailed, bus_leaks_informational: leaks(busFailed.join('\n')) })}`);
  assert.equal(thrownCount, 1, 'PRECONDITION: the drain reached the CR write and the transport threw once');

  await t.test('c1b-1 status and safe fields preserved', () => {
    assert.equal(r.status, 500, 'REGRESSION: status 500 preserved');
    assert.equal(r.body.strategy, 'none', 'REGRESSION: strategy none');
    assert.equal(r.body.attempts, 0, 'REGRESSION: attempts 0');
    assert.equal(r.body.gated, false, 'REGRESSION: gated false');
    assert.equal(r.body.bootstrap_queued, true, 'REGRESSION: bootstrap_queued true');
    assert.equal(typeof r.body.error, 'string', 'REGRESSION: error is a string');
    assert.ok(r.body.error.length > 0, 'REGRESSION: error is non-empty');
  });
  await t.test('c1b-2 the public JSON carries no internal error message/path/token/stack', () => {
    assert.deepEqual(leaks(JSON.stringify(r.body)), [], `REGRESSION: /submit 500 body leaks internal detail ${JSON.stringify(r.body)}`);
  });
});

// ── C2 correlation_basis label ────────────────────────────────────────────────────────────────────
test('c2 correlation_basis labels an observed submit receipt; unknown stays unknown', { timeout: 20000 }, async (t) => {
  H.registerSession(SIDS.k1);
  const promptA = 'PROBE-K1 tpub corr';
  const a = await H.inject(SIDS.k1, promptA);
  const sa = await H.submit(SIDS.k1, promptA, { inject_id: a.injectId });
  const ca = H.correlate(await H.record(a.injectId), SIDS.k1);

  H.registerSession(SIDS.k2);
  const promptB = 'PROBE-K2 tpub base';
  const b = await H.inject(SIDS.k2, promptB);
  const sb = await H.submit(SIDS.k2, promptB);
  const cb = H.correlate(await H.record(b.injectId), SIDS.k2);
  console.log(`# C2 ${JSON.stringify({ observed: { status: sa.response.status, submit_written: ca.submit_written },
    unknown: { status: sb.response.status, submit_written: cb.submit_written }, limits: ca.limits })}`);

  await t.test('c2-1 observed submit_written carries correlation_basis transport_receipt_by_inject_id', () => {
    assert.equal(ca.submit_written.correlation_basis, 'transport_receipt_by_inject_id', 'REGRESSION: observed receipt is labelled with its basis');
  });
  await t.test('c2-2 observed submit_written status/meaning/source unchanged', () => {
    assert.equal(ca.submit_written.status, 'observed', 'REGRESSION: status observed');
    assert.equal(ca.submit_written.meaning, 'pty_master_write_only', 'REGRESSION: meaning unchanged');
    assert.equal(ca.submit_written.source, 'persistent_inject_observation_ledger', 'REGRESSION: source unchanged');
    assert.equal(ca.submit_written.stage_source, 'bridge_receipt', 'REGRESSION: stage_source unchanged');
    assert.equal(ca.submit_written.certainty, 'written', 'REGRESSION: certainty unchanged');
  });
  await t.test('c2-3 limits explain that an inject_id-labelled CR write is not composer contents or model receipt', () => {
    const hit = (ca.limits || []).filter(line => /inject_id/.test(line) && /composer/i.test(line) && /model/i.test(line));
    assert.ok(hit.length >= 1, `REGRESSION: a limits line covers inject_id-labelled CR write vs composer contents/model receipt ${JSON.stringify(ca.limits)}`);
  });
  await t.test('c2-4 existing limits retained', () => {
    for (const line of ['Accepted tracking is not a PTY write, agent acknowledgement, reply, or task completion.',
      'A bridge pty_written receipt is a PTY master write, not model consumption, turn acceptance or completion.',
      'Absence from bounded observation history does not establish an event never happened.']) {
      assert.ok((ca.limits || []).includes(line), `REGRESSION: existing limit retained: ${line}`);
    }
  });
  await t.test('c2-5 unknown submit_written stays unknown with no observed-receipt basis', () => {
    assert.equal(cb.submit_written.status, 'unknown', 'REGRESSION: legacy submit stays unknown');
    assert.equal(cb.submit_written.reason, 'no_submit_write_receipt', 'REGRESSION: unknown reason unchanged');
    assert.notEqual(cb.submit_written.correlation_basis, 'transport_receipt_by_inject_id', 'REGRESSION: unknown is not labelled as an observed receipt');
  });
  await t.test('c2-6 no synthetic acknowledgement/instruction receipt in either case', () => {
    for (const c of [ca, cb]) {
      assert.equal(c.acknowledgement.status, 'unknown', 'REGRESSION: acknowledgement unknown');
      assert.equal(c.instruction_received.status, 'unknown', 'REGRESSION: instruction_received unknown');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C3 block — event disclosure. Two top-level tests read the REAL `bootstrap_queue_failed` bus event
// that the "c1-caller /submit bootstrap drain" test above produced for session SIDS.bs
// (the delivery-runtime.js drain catch). No new scenario, listener or framework.
//   c3a  preservation   (event type, session identity, op/code/tracking, queue settlement) — must stay green
//   c3b  nondisclosure  (no raw thrown message / sentinel / path / token / stack in the event) — the only
//        new contract. No specific public text is pinned; the existing fallback is printed only.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const RAW_THROWN = `STRICT_OWNER_SEND_REFUSED ${SENTINEL} ${SECRET_PATH} token=${SECRET_TOKEN}`;   // c1-caller bootstrap throw
function bootEvents() {
  const out = [];
  for (const raw of H.bus) { try { const e = JSON.parse(raw); if (e && e.session_id === SIDS.bs) out.push(e); } catch { /* non-JSON bus frame */ } }
  return out;
}
async function bootSettled() {
  const session = H.sessions[SIDS.bs];
  for (let i = 0; i < 100 && session && (session.bootstrapDraining || session.bootstrapDrainPromise); i++) await new Promise(r => setTimeout(r, 20));
  return session;
}

test('c3a bootstrap_queue_failed event preserves type, session identity, op outcome and queue settlement', { timeout: 5000 }, async () => {
  const session = await bootSettled();
  assert.ok(session, 'PRECONDITION: the c1-caller bootstrap test ran and registered its session');
  const events = bootEvents();
  const failed = events.filter(e => e.type === 'bootstrap_queue_failed');
  console.log(`# C3 ${JSON.stringify({ failed_events: failed.map(e => ({ type: e.type, event_type: e.event_type, session_id: e.session_id,
    op_id: e.op_id, operation: e.operation, code: e.code, error: e.error, tracking: e.tracking })),
    drained: events.filter(e => e.type === 'bootstrap_queue_drained').length, queue_length: session.bootstrapQueue.length,
    draining: session.bootstrapDraining, existing_fallback_equal: failed[0] ? failed[0].error === 'bootstrap drain failed' : null })}`);
  assert.equal(failed.length, 1, 'REGRESSION: exactly one bootstrap_queue_failed event for the drained /submit op');
  const e = failed[0];
  assert.equal(e.event_type, 'bootstrap_queue_failed', 'REGRESSION: event_type preserved');
  assert.equal(e.session_id, SIDS.bs, 'REGRESSION: session identity preserved');
  assert.equal(e.sender, 'daemon', 'REGRESSION: sender preserved');
  assert.equal(e.operation, 'submit', 'REGRESSION: operation preserved');
  assert.equal(e.code, 'BOOTSTRAP_DRAIN_FAILED', 'REGRESSION: failure code preserved');
  assert.match(String(e.op_id), /^[a-f0-9-]{36}$/, 'REGRESSION: op_id preserved');
  assert.equal(e.tracking, 'no_tracked_inject', 'REGRESSION: settlement outcome preserved (submit op carries no tracked inject)');
  assert.equal(typeof e.error, 'string', 'REGRESSION: error is a string');
  assert.ok(e.error.length > 0, 'REGRESSION: error is non-empty');
  assert.ok(events.some(x => x.type === 'bootstrap_queue_drained'), 'REGRESSION: queue drained event still emitted');
  assert.equal(session.bootstrapQueue.length, 0, 'REGRESSION: queue empty after settlement');
  assert.equal(session.bootstrapDraining, false, 'REGRESSION: drain finished');
});

test('c3b bootstrap_queue_failed event carries no raw internal exception text', { timeout: 5000 }, async () => {
  await bootSettled();
  const failed = bootEvents().filter(e => e.type === 'bootstrap_queue_failed');
  assert.equal(failed.length, 1, 'PRECONDITION: the bootstrap_queue_failed event under test exists');
  const e = failed[0];
  assert.notEqual(e.error, RAW_THROWN, 'REGRESSION: event error is not the raw thrown message');
  assert.deepEqual(leaks(JSON.stringify(e)), [], `REGRESSION: bootstrap_queue_failed event leaks internal detail ${JSON.stringify({ error: e.error })}`);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C4 block — public-message contract. Uses only the real H.runtime buildErrorBody /
// respondWithError factory (no new framework, listener or scenario).
//
// Contract (internal public-message contract; NOT a claim of current caller exploitability):
//   c4a  intended existing public texts and constrained legitimate numeric templates stay EXACT; an
//        absent error (undefined / null) keeps its serialization. Positive texts are derived from admitted
//        real callers (cited per case), not from any candidate's catalog.
//   c4b  arbitrary unknown strings — a real Error.message string, an unlisted string, a known text with a
//        raw suffix, an invalid numeric-template slot, an SSH composition with an unknown cause — become the
//        stable generic 'Internal error'. Status, code and safe extra fields are unchanged in every case.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const GENERIC_TEXT = 'Internal error';
function realErrorMessage() {
  try { JSON.parse('{"unterminated":'); } catch (error) { return error.message; }   // a genuine Node Error.message
  throw new Error('PRECONDITION: JSON.parse did not throw');
}
function bothOutputs(status, code, text, extra) {
  const body = H.runtime.buildErrorBody(code, text, extra);
  const res = captureRes();
  H.runtime.respondWithError(res, status, code, text, extra);
  return { body, res, json: JSON.parse(res.serialized) };
}
function assertExact(status, code, text, extra, label) {
  const { body, res, json } = bothOutputs(status, code, text, extra);
  assert.deepEqual(body, { success: false, code, error: text, ...extra }, `REGRESSION: ${label} body exact`);
  assert.equal(res.statusCode, status, `REGRESSION: ${label} status unchanged`);
  assert.deepEqual(json, { success: false, code, error: text, ...extra }, `REGRESSION: ${label} public JSON exact`);
}
function assertGeneric(status, code, text, extra, label) {
  const { body, res, json } = bothOutputs(status, code, text, extra);
  console.log(`# C4B ${JSON.stringify({ label, input: text, output: json.error })}`);
  assert.equal(res.statusCode, status, `REGRESSION: ${label} status unchanged`);
  assert.equal(json.success, false, `REGRESSION: ${label} success:false`);
  assert.equal(json.code, code, `REGRESSION: ${label} code unchanged`);
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(json[k], v, `REGRESSION: ${label} safe field ${k} unchanged`);
  assert.equal(body.error, GENERIC_TEXT, `REGRESSION: ${label} unknown string becomes '${GENERIC_TEXT}'`);
  assert.equal(json.error, GENERIC_TEXT, `REGRESSION: ${label} public JSON error is '${GENERIC_TEXT}'`);
}

test('c4a legitimate caller texts, numeric templates and absent error are preserved exactly', { timeout: 5000 }, async (t) => {
  assert.equal(typeof H.runtime.buildErrorBody, 'function', 'PRECONDITION: runtime exposes buildErrorBody');
  await t.test('c4a-1 fixed public texts (session-actions /inject, fanout, inject catch)', () => {
    assertExact(404, 'SESSION_NOT_FOUND', 'Session not found', { requested: 'tpub-missing' }, 'session-actions:1471');
    assertExact(400, 'INVALID_REQUEST', 'prompt is required', {}, 'session-actions:1482');
    assertExact(500, 'DELIVERY_FAILED', 'Delivery failed; see daemon log.', {}, 'session-actions INJECT_DELIVERY_FAILED_TEXT');
  });
  await t.test('c4a-2 HTTP endpoint status template (session-delivery:154)', () => {
    for (const status of [404, 502]) {
      assertExactCtx(502, 'DELIVERY_UNCERTAIN', `HTTP endpoint returned ${status} after an attempt; do not retry blindly.`,
        { httpStatus: 502, deliveryStatus: status, delivery_uncertain: true, bytes_written: null }, { kind: 'http_status', status }, `http status ${status}`);
    }
  });
  await t.test('c4a-3 fanout target cap templates (fanout:79/159)', () => {
    assertExactCtx(429, 'FANOUT_TARGET_CAP', 'multicast target count 65 exceeds cap 64', { cap: 64, requested: 65 }, { kind: 'fanout_limit', operation: 'multicast', requested: 65, cap: 64 }, 'multicast cap');
    assertExactCtx(429, 'FANOUT_TARGET_CAP', 'broadcast target count 120 exceeds cap 64', { cap: 64, requested: 120 }, { kind: 'fanout_limit', operation: 'broadcast', requested: 120, cap: 64 }, 'broadcast cap');
  });
  await t.test('c4a-4 submit queue timeout template (session-delivery:604 via /inject)', () => {
    assertExactCtx(503, 'QUEUE_TIMEOUT', 'Earlier submits on this session did not clear within 10000 ms; nothing was written. Retry.',
      { inject_id: '0d6f3a52-3b7e-4c1d-9a8e-5f2b7c9d1e04', tracking_state: 'aborted', queue_wait_ms: 10003 }, { kind: 'submit_timeout', timeoutMs: 10000 }, 'queue timeout');
  });
  await t.test('c4a-5 SSH known-cause composition (session-delivery:645 + ssh-session:186)', () => {
    assertExact(504, 'SSH_WRITE_UNCONFIRMED',
      'Text was written to the SSH child, but submit was not confirmed. Do not retry blindly. SSH child write was not confirmed. Do not retry blindly.',
      { text_written: true, retry_safe: false }, 'ssh composition');
  });
  await t.test('c4a-6 absent error keeps its serialization (undefined omitted, null kept)', () => {
    const u = H.runtime.buildErrorBody('DISCONNECTED', undefined, { httpStatus: 503 });
    assert.equal(u.error, undefined, 'REGRESSION: undefined error stays undefined');
    assert.equal(JSON.stringify(u), JSON.stringify({ success: false, code: 'DISCONNECTED', httpStatus: 503 }), 'REGRESSION: undefined error omitted from JSON');
    const n = H.runtime.buildErrorBody('DISCONNECTED', null, { httpStatus: 503 });
    assert.equal(n.error, null, 'REGRESSION: null error stays null');
    assert.equal(JSON.stringify(n), JSON.stringify({ success: false, code: 'DISCONNECTED', error: null, httpStatus: 503 }), 'REGRESSION: null error serialized as null');
  });
});

test('c4b arbitrary unknown strings become the stable generic public text', { timeout: 5000 }, async (t) => {
  await t.test('c4b-1 a real Error.message string', () => {
    assertGeneric(500, 'DELIVERY_FAILED', realErrorMessage(), { inject_id: '0d6f3a52-3b7e-4c1d-9a8e-5f2b7c9d1e04' }, 'Error.message');
  });
  await t.test('c4b-2 an arbitrary unlisted string', () => {
    assertGeneric(503, 'DISCONNECTED', 'tpub unlisted operator diagnostic text', { bytes_written: 0 }, 'unlisted string');
  });
  await t.test('c4b-3 a known public text with a raw suffix appended', () => {
    assertGeneric(404, 'SESSION_NOT_FOUND', `Session not found: ${realErrorMessage()}`, { requested: 'tpub-missing' }, 'known+suffix');
  });
  await t.test('c4b-4 a numeric template whose slot is not a number', () => {
    assertGeneric(502, 'DELIVERY_UNCERTAIN', 'HTTP endpoint returned 502 (upstream detail tpub) after an attempt; do not retry blindly.',
      { httpStatus: 502, delivery_uncertain: true, bytes_written: null }, 'invalid http slot');
  });
  await t.test('c4b-5 an SSH composition whose cause is not a known text', () => {
    assertGeneric(504, 'SSH_WRITE_UNCONFIRMED',
      'Text was written to the SSH child, but submit was not confirmed. Do not retry blindly. tpub unlisted transport detail',
      { text_written: true }, 'ssh unknown cause');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// C5/C6 block — numeric publicErrorContext contract and real-caller propagation.
//
// Numeric public-error contract (codes as used by the real callers):
//   http_status    {kind, status}                         code DELIVERY_UNCERTAIN   session-delivery.js:154
//   fanout_limit   {kind, operation, requested, cap}      code FANOUT_TARGET_CAP    fanout.js:79/159
//   submit_timeout {kind, timeoutMs}                      code QUEUE_TIMEOUT        session-delivery.js:604
// Caller bounds: status = fetch Response.status (integer); requested = array length (integer);
// cap = Math.max(1, Number(env||100)) (finite, may be fractional); timeoutMs = Number(env||10000) > 0 and
// finite (fractional or large such as 1e21 are legitimate). Expected text = the caller's own `${value}`
// interpolation. The context is never a JSON field. Anything else is 'Internal error'.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

Object.assign(SIDS, { us: 'tpub-orch-upstream', md: 'tpub-orch-modal' });

const HTTP_TEXT = s => `HTTP endpoint returned ${s} after an attempt; do not retry blindly.`;
const CAP_TEXT = (op, n, cap) => `${op} target count ${n} exceeds cap ${cap}`;
const TIMEOUT_TEXT = ms => `Earlier submits on this session did not clear within ${ms} ms; nothing was written. Retry.`;
const HTTP_EXTRA = s => ({ httpStatus: 502, deliveryStatus: s, delivery_uncertain: true, bytes_written: null });
const TIMEOUT_EXTRA = { inject_id: '0d6f3a52-3b7e-4c1d-9a8e-5f2b7c9d1e04', tracking_state: 'aborted', queue_wait_ms: 10003 };
// daemon.js:1457-1467 MODAL_HINT_BY_CLI, verbatim (verified against the daemon source before freezing).
const DAEMON_MODAL_HINT_BY_CLI = {
  codex: 'Target codex is showing a blocking modal (e.g. "Update available … Press enter to '
    + 'continue"); an Enter there would activate its default item, not submit your message. '
    + 'Dismiss it on the surface, or clear it by setting dismissed_version to latest_version '
    + 'in $CODEX_HOME/version.json and respawning.',
  claude: 'Target claude is showing a blocking modal (AskUserQuestion option list, '
    + 'ExitPlanMode plan approval, tool-permission or trust dialog); an Enter there would '
    + 'select the highlighted option — on a plan approval that is "Yes, auto-accept edits" — '
    + 'not submit your message. Answer or Esc the prompt on the surface; parked injects are '
    + 'delivered in order as soon as it clears.',
};

function withContext(status, code, text, extra, ctx) {
  const body = H.runtime.buildErrorBody(code, text, extra, ctx);
  const res = captureRes();
  H.runtime.respondWithError(res, status, code, text, extra, ctx);
  return { body, res, json: JSON.parse(res.serialized) };
}
function assertExactCtx(status, code, text, extra, ctx, label) {
  const { body, res, json } = withContext(status, code, text, extra, ctx);
  assert.equal(res.statusCode, status, `REGRESSION: ${label} status unchanged`);
  assert.deepEqual(json, { success: false, code, error: text, ...extra }, `REGRESSION: ${label} public JSON exact (no context field)`);
  assert.deepEqual(body, { success: false, code, error: text, ...extra }, `REGRESSION: ${label} body exact`);
}
function assertGenericCtx(status, code, text, extra, ctx, label) {
  const { body, res, json } = withContext(status, code, text, extra, ctx);
  console.log(`# C5 ${JSON.stringify({ label, output: json.error })}`);
  assert.equal(res.statusCode, status, `REGRESSION: ${label} status unchanged`);
  assert.equal(json.code, code, `REGRESSION: ${label} code unchanged`);
  assert.equal(json.success, false, `REGRESSION: ${label} success:false`);
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(json[k], v, `REGRESSION: ${label} safe field ${k} unchanged`);
  assert.deepEqual(Object.keys(json).sort(), ['code', 'error', 'success', ...Object.keys(extra)].sort(), `REGRESSION: ${label} no context field exposed`);
  assert.equal(body.error, GENERIC_TEXT, `REGRESSION: ${label} becomes '${GENERIC_TEXT}'`);
  assert.equal(json.error, GENERIC_TEXT, `REGRESSION: ${label} public JSON error is '${GENERIC_TEXT}'`);
}

// ── c5a legitimate numeric contexts (caller values, including fractional / large config) ─────────────
test('c5a legitimate numeric contexts render the caller text exactly', { timeout: 5000 }, async (t) => {
  const rows = [
    ['http 503', 502, 'DELIVERY_UNCERTAIN', HTTP_TEXT(503), HTTP_EXTRA(503), { kind: 'http_status', status: 503 }],
    ['multicast fractional cap 2.5', 429, 'FANOUT_TARGET_CAP', CAP_TEXT('multicast', 3, 2.5), { cap: 2.5, requested: 3 }, { kind: 'fanout_limit', operation: 'multicast', requested: 3, cap: 2.5 }],
    ['broadcast cap 100', 429, 'FANOUT_TARGET_CAP', CAP_TEXT('broadcast', 101, 100), { cap: 100, requested: 101 }, { kind: 'fanout_limit', operation: 'broadcast', requested: 101, cap: 100 }],
    ['timeout fractional 2500.5', 503, 'QUEUE_TIMEOUT', TIMEOUT_TEXT(2500.5), TIMEOUT_EXTRA, { kind: 'submit_timeout', timeoutMs: 2500.5 }],
    ['timeout small 0.5', 503, 'QUEUE_TIMEOUT', TIMEOUT_TEXT(0.5), TIMEOUT_EXTRA, { kind: 'submit_timeout', timeoutMs: 0.5 }],
    ['timeout large config 1e21', 503, 'QUEUE_TIMEOUT', TIMEOUT_TEXT(1e21), TIMEOUT_EXTRA, { kind: 'submit_timeout', timeoutMs: 1e21 }],
  ];
  for (const [label, status, code, text, extra, ctx] of rows) {
    await t.test(`c5a ${label}`, () => assertExactCtx(status, code, text, extra, ctx, label));
  }
});

// ── c5b numeric-template strings alone (no context) are no longer public text ───────────────────────
test('c5b numeric-template strings without a context become the generic text', { timeout: 5000 }, async (t) => {
  const rows = [
    ['http template only', 502, 'DELIVERY_UNCERTAIN', HTTP_TEXT(502), HTTP_EXTRA(502)],
    ['multicast template only', 429, 'FANOUT_TARGET_CAP', CAP_TEXT('multicast', 65, 64), { cap: 64, requested: 65 }],
    ['broadcast template only', 429, 'FANOUT_TARGET_CAP', CAP_TEXT('broadcast', 120, 64), { cap: 64, requested: 120 }],
    ['timeout template only', 503, 'QUEUE_TIMEOUT', TIMEOUT_TEXT(10000), TIMEOUT_EXTRA],
  ];
  for (const [label, status, code, text, extra] of rows) {
    await t.test(`c5b ${label}`, () => assertGenericCtx(status, code, text, extra, undefined, label));
  }
});

// ── c5c malformed / mismatched contexts (legitimate-looking text) become the generic text ────────────
test('c5c unsupported, mismatched or malformed numeric contexts become the generic text', { timeout: 5000 }, async (t) => {
  const H502 = [502, 'DELIVERY_UNCERTAIN', HTTP_TEXT(502), HTTP_EXTRA(502)];
  const M65 = [429, 'FANOUT_TARGET_CAP', CAP_TEXT('multicast', 65, 64), { cap: 64, requested: 65 }];
  const T10 = [503, 'QUEUE_TIMEOUT', TIMEOUT_TEXT(10000), TIMEOUT_EXTRA];
  const rows = [
    ['unsupported kind', ...H502, { kind: 'http_code', status: 502 }],
    ['missing kind', ...H502, { status: 502 }],
    ['non-object context', ...H502, 'http_status'],
    ['extra context key', ...H502, { kind: 'http_status', status: 502, detail: 'x' }],
    ['wrong code for http_status', 503, 'QUEUE_TIMEOUT', HTTP_TEXT(502), TIMEOUT_EXTRA, { kind: 'http_status', status: 502 }],
    ['wrong code for submit_timeout', 502, 'DELIVERY_UNCERTAIN', TIMEOUT_TEXT(10000), HTTP_EXTRA(502), { kind: 'submit_timeout', timeoutMs: 10000 }],
    ['wrong code for fanout_limit', 502, 'DELIVERY_UNCERTAIN', CAP_TEXT('multicast', 65, 64), HTTP_EXTRA(502), { kind: 'fanout_limit', operation: 'multicast', requested: 65, cap: 64 }],
    ['string status', ...H502, { kind: 'http_status', status: '502' }],
    ['Number-object status', ...H502, { kind: 'http_status', status: new Number(502) }],
    ['NaN status', ...H502, { kind: 'http_status', status: NaN }],
    ['non-integer status', ...H502, { kind: 'http_status', status: 502.5 }],
    ['missing status', ...H502, { kind: 'http_status' }],
    ['non-integer requested', ...M65, { kind: 'fanout_limit', operation: 'multicast', requested: 65.5, cap: 64 }],
    ['string requested', ...M65, { kind: 'fanout_limit', operation: 'multicast', requested: '65', cap: 64 }],
    ['NaN cap', ...M65, { kind: 'fanout_limit', operation: 'multicast', requested: 65, cap: NaN }],
    ['missing cap', ...M65, { kind: 'fanout_limit', operation: 'multicast', requested: 65 }],
    ['object cap', ...M65, { kind: 'fanout_limit', operation: 'multicast', requested: 65, cap: { n: 64 } }],
    ['unsupported operation', ...M65, { kind: 'fanout_limit', operation: 'unicast', requested: 65, cap: 64 }],
    ['Infinity timeoutMs', ...T10, { kind: 'submit_timeout', timeoutMs: Infinity }],
    ['string timeoutMs', ...T10, { kind: 'submit_timeout', timeoutMs: '10000' }],
  ];
  for (const [label, status, code, text, extra, ctx] of rows) {
    await t.test(`c5c ${label}`, () => assertGenericCtx(status, code, text, extra, ctx, label));
  }
});

// ── c5d raw strings are never accepted as public error input (no context) ────────────────────────────
test('c5d raw exception, suffixed, NaN and exponent strings are not accepted as public text', { timeout: 5000 }, async (t) => {
  const rows = [
    ['raw Error.message', 500, 'DELIVERY_FAILED', realErrorMessage(), {}],
    ['http template + suffix', 502, 'DELIVERY_UNCERTAIN', `${HTTP_TEXT(502)} ${realErrorMessage()}`, HTTP_EXTRA(502)],
    ['http NaN text', 502, 'DELIVERY_UNCERTAIN', HTTP_TEXT(NaN), HTTP_EXTRA(502)],
    ['timeout exponent text', 503, 'QUEUE_TIMEOUT', TIMEOUT_TEXT(1e21), TIMEOUT_EXTRA],
    ['cap template trailing newline', 429, 'FANOUT_TARGET_CAP', `${CAP_TEXT('multicast', 3, 2)}\n`, { cap: 2, requested: 3 }],
  ];
  for (const [label, status, code, text, extra] of rows) {
    await t.test(`c5d ${label}`, () => assertGenericCtx(status, code, text, extra, undefined, label));
  }
});

// ── c6 real callers through the admitted factories ────────────────────────────────────────────────────
test('c6 /inject real delivery-return boundary keeps actionable UPSTREAM_STALLED and SURFACE_MODAL texts', { timeout: 10000 }, async (t) => {
  await t.test('c6-1 UPSTREAM_STALLED exact text via /inject', async () => {
    const session = H.registerSession(SIDS.us);
    // Owner observation stub only: an upstream probe left unanswered for longer than UPSTREAM_STALL_SECONDS (30).
    session.upstreamProbeAt = Date.now() - 31000;
    session.upstreamProbeWatermark = 0;
    session.outputRingTotalBytes = 0;
    const r = await H.call('/api/sessions/:id/inject', SIDS.us, { prompt: 'PROBE-US tpub', no_enter: true, from: FROM });
    console.log(`# C6 ${JSON.stringify({ case: 'upstream', status: r.status, body: r.body })}`);
    assert.equal(r.status, 503, 'REGRESSION: status 503 preserved');
    assert.match(String(r.body.inject_id), /^[a-f0-9-]{36}$/, 'PRECONDITION: tracked inject id returned');
    assert.deepEqual(r.body, { success: false, code: 'UPSTREAM_STALLED',
      error: 'Session output pipe is dead: the owner is connected but has returned no output since the last delivery.',
      inject_id: r.body.inject_id, tracking_state: 'aborted' }, 'REGRESSION: /inject UPSTREAM_STALLED public body with exact actionable text');
  });

  await t.test('c6-2 SURFACE_MODAL reject exact reason + daemon hint via /inject', async () => {
    const sid = SIDS.md;
    const ws = H.ownerSocket(sid);
    const epoch = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const modalScreen = 'Update available! 1.2.3 -> 1.2.4\nPress enter to continue\n';
    // Terminal observation stub only: the codex update modal on the owner output ring. Guarded (not supervised).
    const session = { id: sid, type: 'wrapped', command: 'codex', clients: new Set([ws]), ownerWs: ws,
      sessionEpoch: epoch, sessionEpochProved: epoch, credentialGeneration: 1, interactionOwnerGeneration: crypto.randomUUID(),
      outputRing: [modalScreen], outputRingTotalBytes: modalScreen.length, createdAt: nowIso, lastActivityAt: nowIso, lastConnectedAt: nowIso };
    ws.sid = sid; ws.ownerGeneration = session.interactionOwnerGeneration;
    H.sessions[sid] = session;
    H.metadata.initializeBootstrapState(session);
    H.sessionStateManager.register(sid);
    H.runtime.markBootstrapReady(sid, session, 'ready');   // the bridge `ready` frame path
    assert.equal(H.runtime.isSurfaceBlockedByModal(session), true, 'PRECONDITION: codex modal observed on the surface');
    const savedRemedy = process.env.TELEPTY_MODAL_REMEDY;
    const savedHints = H.rshared.MODAL_HINT_BY_CLI;
    process.env.TELEPTY_MODAL_REMEDY = 'reject';             // documented operator remedy (avoids the 30 s hold)
    H.rshared.MODAL_HINT_BY_CLI = DAEMON_MODAL_HINT_BY_CLI;   // the daemon's real configured hints
    let r;
    try {
      r = await H.call('/api/sessions/:id/inject', sid, { prompt: 'PROBE-MD tpub', no_enter: true, from: FROM });
    } finally {
      if (savedRemedy === undefined) delete process.env.TELEPTY_MODAL_REMEDY; else process.env.TELEPTY_MODAL_REMEDY = savedRemedy;
      H.rshared.MODAL_HINT_BY_CLI = savedHints;
    }
    console.log(`# C6 ${JSON.stringify({ case: 'modal', status: r.status, body: r.body })}`);
    assert.equal(ws.frames.filter(f => f.type === 'inject').length, 0, 'PRECONDITION: nothing was written into the modal');
    assert.equal(r.status, 409, 'REGRESSION: status 409 preserved');
    assert.deepEqual(r.body, { success: false, code: 'SURFACE_MODAL',
      error: `codex_modal_ui — delivery refused: ${DAEMON_MODAL_HINT_BY_CLI.codex}`,
      inject_id: r.body.inject_id, tracking_state: 'aborted' }, 'REGRESSION: /inject SURFACE_MODAL public body with exact reason and actionable hint');
  });
});

test('c6 fanout real route propagates requested/cap into the public cap text', { timeout: 5000 }, async (t) => {
  const { registerFanoutRoutes } = load('src/routes/fanout.js');
  let deliveries = 0;
  function fanoutApp(cap) {
    const routes = Object.create(null);
    registerFanoutRoutes({ post(route, handler) { routes[route] = handler; } }, {
      classifyPeerLaneInject: H.runtime.classifyPeerLaneInject, ORCHESTRATOR_SIDS: Object.values(SIDS), crypto,
      sessions: H.sessions, broadcastSessionEvent: H.runtime.broadcastSessionEvent, auditAppend: H.runtime.auditAppend,
      MACHINE_ID: 'tpub-fixture-machine', respondWithError: H.runtime.respondWithError, FANOUT_MAX_TARGETS: cap,
      verifiedSenderFields: H.runtime.verifiedSenderFields, verifiedPrincipalFromReq: H.runtime.verifiedPrincipalFromReq,
      // Never reached: the cap refusal precedes any delivery. Counted to prove it.
      deliverInjectionToSession: async () => { deliveries++; throw new Error('PRECONDITION: cap refusal must precede delivery'); },
      deliveryAuditResult: H.runtime.deliveryAuditResult, broadcastBusEvent: H.runtime.broadcastBusEvent, busClients: H.rshared.busClients,
    });
    return (route, body) => new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(code) { res.statusCode = code; return res; },
        json(payload) { resolve({ status: res.statusCode, body: JSON.parse(JSON.stringify(payload)) }); return res; } };
      Promise.resolve(routes[route]({ params: {}, body, headers: {}, query: {} }, res)).catch(reject);
    });
  }
  await t.test('c6-3 multicast 3 > cap 2', async () => {
    const r = await fanoutApp(2)('/api/sessions/multicast/inject', { prompt: 'x', session_ids: ['a', 'b', 'c'] });
    assert.equal(r.status, 429, 'REGRESSION: status 429');
    assert.deepEqual(r.body, { success: false, code: 'FANOUT_TARGET_CAP', error: CAP_TEXT('multicast', 3, 2), cap: 2, requested: 3 },
      'REGRESSION: multicast cap public body exact');
  });
  await t.test('c6-4 multicast 3 > fractional cap 2.5 (Math.max(1, Number(env)))', async () => {
    const r = await fanoutApp(2.5)('/api/sessions/multicast/inject', { prompt: 'x', session_ids: ['a', 'b', 'c'] });
    assert.equal(r.status, 429, 'REGRESSION: status 429');
    assert.deepEqual(r.body, { success: false, code: 'FANOUT_TARGET_CAP', error: CAP_TEXT('multicast', 3, 2.5), cap: 2.5, requested: 3 },
      'REGRESSION: fractional cap public body exact');
  });
  await t.test('c6-5 broadcast all sessions > cap 2', async () => {
    const n = Object.keys(H.sessions).length;
    assert.ok(n > 2, 'PRECONDITION: more than 2 registered sessions');
    const r = await fanoutApp(2)('/api/sessions/broadcast/inject', { prompt: 'x' });
    assert.equal(r.status, 429, 'REGRESSION: status 429');
    assert.deepEqual(r.body, { success: false, code: 'FANOUT_TARGET_CAP', error: CAP_TEXT('broadcast', n, 2), cap: 2, requested: n },
      'REGRESSION: broadcast cap public body exact');
  });
  assert.equal(deliveries, 0, 'PRECONDITION: no fan-out delivery was attempted');
});
