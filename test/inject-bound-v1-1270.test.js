'use strict';

// Task 1270 — bound busy input: `telepty inject-bound-v1` / POST /api/sessions/:id/inject-bound-v1 (telepty.bound-inject/v1).
// Frozen interface: controller BOUND-INJECT-V1-CONTRACT-20261116.md. Written BEFORE the production change; the coder did not
// execute it. Expected RED on 21f13ca1 is a CHECKPOINT assertion (ERR_ASSERTION) in every case: the bound route is not
// registered, the transport view has no session_epoch/owner_generation/busy_input, and boot-capabilities does not advertise
// the verb. A module-not-found, setup or timeout failure is NOT that RED.
//
// Real production seams, no mirrored product logic: createSessionActions (every register*Route registrar on one recording
// app), createDeliveryRuntime (immediate-submit attempt, tracked ledger, transport view), createSessionDeliveryContext +
// DeliveryEngine + FileMailbox, readiness-handshake milestones, and cli.js bootCapabilitiesLine/parseBootCapabilities.
// The daemon harness is the existing test/immediate-submit-1215.test.js compose() (same seams, same claim order as
// websocket.js: mint generation -> beginOwnerGeneration -> bindImmediateSubmitCapability(header)). Busy-input-v1 is declared
// in that SAME x-telepty-bridge-capabilities header value and must be bound by the existing claim-time binder call.
// Declared fakes: owner-WS frame recorders, submit-gate pass-through spies (counted, never replaced), a private ledger/mailbox
// under os.tmpdir(). No listener, network, daemon/bridge process, provider, native PTY or model. Frames handed to a recorder
// prove daemon hand-off only (sent_to_bridge) — never a PTY write, native queueing, auto-submit or model consumption.
// "PRECONDITION:" marks an invalid setup (not a product finding); "CHECKPOINT:" marks the intended bound behaviour.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const load = rel => require(path.join(ROOT, rel));
const registry = load('src/prompt-symbol-registry.js');
const { FileMailbox } = load('src/mailbox/index.js');
const runtimeModule = load('src/mailbox/delivery-runtime.js');
const readinessHandshake = load('src/transport/readiness-handshake.js');
const cli = load('cli.js');

const BOUND_ROUTE = '/api/sessions/:id/inject-bound-v1';
const REQUEST_SCHEMA = 'telepty.bound-inject/v1';
const RESULT_SCHEMA = 'telepty.bound-inject-result/v1';
const REQUIRE = Object.freeze(['immediate-submit-v1', 'busy-input-v1']);
const HEADER_BOUND = 'input-transport-ready-v1, immediate-submit-v1, busy-input-v1';
const HEADER_OLD_BRIDGE = 'input-transport-ready-v1, immediate-submit-v1';
const RESULT_KEYS = ['body_stage', 'bytes_written', 'consumption', 'inject_id', 'owner_generation', 'reason', 'schema',
  'session_epoch', 'session_id', 'stage', 'submit_stage'];
const STAGES = ['not_sent', 'queued', 'sent_to_bridge', 'pty_written', 'unknown'];
const WAITS = ['awaitPromptSymbol', 'awaitReplReady', 'awaitInputSettled', 'confirmSubmitAccepted', 'classifyInjectConsumption'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKING = 'Working (12s • esc to interrupt)\r\n';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── daemon harness (copied from test/immediate-submit-1215.test.js compose(); route registration widened) ──────────
let H = null;
function isOpenWebSocket(ws) { return Boolean(ws && ws.readyState === 1); }

async function compose() {
  const { createDeliveryRuntime } = runtimeModule;
  const { createSessionDeliveryContext } = load('src/mailbox/session-delivery.js');
  const { createSessionActions } = load('src/routes/session-actions.js');
  const inputPolicy = load('src/mailbox/input-policy.js');
  const sessionPersistence = load('src/session-store/persistence.js');
  const metadata = load('src/session-store/route-metadata.js');
  const { createCredentialStore } = load('src/session-store/session-credentials.js');
  const { DeliveryEngine } = load('src/mailbox/delivery.js');
  const { applyProvenance } = load('src/audit/provenance.js');
  const { SessionStateManager, stripAnsi } = load('session-state.js');
  const { createLedgerClient } = load('src/session-store/ledger-client.js');
  const interaction = load('src/interaction.js');
  const realGate = load('src/submit-gate.js');
  const { CAPABILITY_STAGE_A } = load('src/completion-observation.js');
  const { isProcessRunning } = load('daemon-control.js');

  const gateCalls = [];
  const submitGate = { ...realGate };
  for (const name of WAITS) {
    submitGate[name] = (...args) => { gateCalls.push(name); return realGate[name](...args); };
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1270-bound-'));
  const ledgerDir = path.join(root, 'tracked-injections.json');
  const ledgerClient = createLedgerClient({ dir: ledgerDir, lockPath: path.join(root, 'tracked-injections.lock'), legacyPath: ledgerDir });
  const sessions = Object.create(null);
  const pendingReports = Object.create(null);
  const busClients = new Set([{ readyState: 1, send() {} }]);
  const sessionStateManager = new SessionStateManager();
  const rshared = {
    sessions, crypto, fs, sessionPersistence, sessionCredentials: createCredentialStore(),
    auditWriter: { append() {} },
    ledgerClient, trackedLedgerHealthy: false, trackedLedgerUnavailableReason: 'not_opened',
    TRACKED_INJECTIONS_PATH: ledgerDir, pendingReports, busClients,
    interaction, interactionWaiters: new Map(), readyRegistry: registry, sessionStateManager,
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
    submitGate, readyRegistry: registry, sessionPersistence,
    deliverInjectionToSession: context.deliverInjectionToSession,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    isOpenWebSocket,
    resolveSessionAlias: id => (typeof id === 'string' && Object.hasOwn(sessions, id) ? id : null),
    ORCHESTRATOR_SIDS: [], MACHINE_ID: 'b1270-fixture-machine',
    NON_TERMINAL_GATE_REASONS: new Set(['timeout', 'no_state', 'no_state_manager', 'busy_settled']),
    SUBMIT_BUSY_DISPATCH_ENABLED: true, SUBMIT_BUSY_GRACE_MS: 250,
    REDELIVER_ENABLED: true, REDELIVER_MAX_ATTEMPTS: 3, REDELIVER_TOTAL_TIMEOUT_MS: 600000, REDELIVER_IDLE_WAIT_MS: 120000,
    CAPABILITY_STAGE_A, deliveredAbsenceIdentities: new WeakMap(),
  };
  const actions = createSessionActions(ashared, {});
  // Every existing and future register*Route registrar of the real session-actions module, on one recording app keyed
  // "METHOD path" (registration only; no listener). The bound route's registrar name is not pinned here.
  const routes = Object.create(null);
  const app = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (route, ...handlers) => { routes[`${method.toUpperCase()} ${route}`] = handlers[handlers.length - 1]; };
  }
  for (const [name, fn] of Object.entries(actions)) {
    if (/^register\w*Route$/.test(name) && typeof fn === 'function') fn(app);
  }
  assert.equal(typeof routes['POST /api/sessions/:id/inject'], 'function', 'PRECONDITION: inject route registered');
  assert.equal(typeof routes['POST /api/sessions/:id/submit'], 'function', 'PRECONDITION: submit route registered');

  function ownerSocket() {
    const ws = { readyState: 1, frames: [], send(raw) { ws.frames.push(JSON.parse(raw)); } };
    return ws;
  }
  function claimOwner(session, ws, { supervised }) {
    if (supervised) {
      const capability = inputPolicy.mintInputPolicyCapability(session);
      inputPolicy.requestInputPolicy(session, 'user-supervised', 'operator_principal_registration', new Date(), { origin: 'new_instance' });
      session.ownerWs = ws; session.clients.add(ws);
      session.interactionOwnerGeneration = crypto.randomUUID();
      inputPolicy.bindInputPolicy(session, new Date(), { capability });
      assert.equal(inputPolicy.userSupervised(session), true, 'PRECONDITION: supervised for this owner generation');
    } else {
      session.ownerWs = ws; session.clients.add(ws);
      session.interactionOwnerGeneration = crypto.randomUUID();
    }
  }
  // websocket.js owner claim order: mint generation -> beginOwnerGeneration -> bindImmediateSubmitCapability(header).
  function negotiate(session, { capable, header }) {
    readinessHandshake.beginOwnerGeneration(session, { capable });
    runtimeModule.bindImmediateSubmitCapability(session, header);
  }
  function transportReady(session) {
    const base = { schema: 1, session_id: session.id, session_epoch: session.sessionEpoch, owner_generation: session.interactionOwnerGeneration,
      readiness_nonce: session.transportReadiness.nonce, child_seq: 1 };
    const started = readinessHandshake.acceptMilestone(session.id, session, { type: 'process_started', ...base, pid: 4242, exec: 'unverified' });
    const ready = readinessHandshake.acceptMilestone(session.id, session, { type: 'input_transport_ready', ...base, input_loop: 'attached' });
    assert.deepEqual([started.ok, ready.ok], [true, true], `PRECONDITION: milestones accepted ${JSON.stringify([started, ready])}`);
    runtime.markBootstrapReady(session.id, session, 'input_transport_ready');
  }
  function registerSession(sid, { command = 'claude', supervised = true, capable = true, header = HEADER_BOUND, ready = true } = {}) {
    const ws = ownerSocket();
    const epoch = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const session = { id: sid, type: 'wrapped', command, clients: new Set(), ownerWs: null,
      sessionEpoch: epoch, sessionEpochProved: epoch, credentialGeneration: 1,
      outputRing: [], outputRingTotalBytes: 0, createdAt: nowIso, lastActivityAt: nowIso, lastConnectedAt: nowIso };
    sessions[sid] = session;
    claimOwner(session, ws, { supervised });
    negotiate(session, { capable, header });
    metadata.initializeBootstrapState(session);
    sessionStateManager.register(sid);
    if (capable && ready) transportReady(session);
    return session;
  }
  function call(key, sid, body) {
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(code) { res.statusCode = code; return res; }, json(payload) { resolve({ status: res.statusCode, body: payload }); return res; } };
      Promise.resolve(routes[key]({ params: { id: sid }, body, headers: {}, query: {} }, res)).catch(reject);
    });
  }
  async function dispose() {
    try { engine.stop(); } catch {}
    for (const [id, session] of Object.entries(sessions)) {
      try { runtime.cancelModalParkPoll(session); } catch {}
      if (session.bootstrapOptimisticTimer) { clearTimeout(session.bootstrapOptimisticTimer); session.bootstrapOptimisticTimer = null; }
      if (session.inputTransportTimer) { clearTimeout(session.inputTransportTimer); session.inputTransportTimer = null; }
      try { sessionStateManager.unregister(id); } catch {}
    }
    try { sessionStateManager.destroyAll(); } catch {}
    try { await ledgerClient.close(2000); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { sessions, pendingReports, runtime, routes, registerSession, negotiate, transportReady, claimOwner, ownerSocket, call,
    dispose, gateCalls, sessionStateManager };
}

before(async () => { H = await compose(); }, { timeout: 20000 });
after(async () => { if (H) await H.dispose(); }, { timeout: 20000 });

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
function boundRouteRegistered() {
  assert.equal(typeof H.routes[`POST ${BOUND_ROUTE}`], 'function',
    `CHECKPOINT: POST ${BOUND_ROUTE} is registered by the real session-actions registrars`);
}
function boundRequest(session, prompt, overrides = {}) {
  return { schema: REQUEST_SCHEMA, prompt, from: 'fixture-sender', expected_epoch: session.sessionEpoch,
    expected_owner_generation: session.interactionOwnerGeneration, require: [...REQUIRE], ...overrides };
}
async function bound(sid, body) {
  const ws = H.sessions[sid].ownerWs;
  const seen = ws.frames.length; const calls = H.gateCalls.length;
  const started = Date.now();
  const response = await H.call(`POST ${BOUND_ROUTE}`, sid, body);
  return { response, elapsedMs: Date.now() - started, frames: () => ws.frames.slice(seen).filter(f => f.type === 'inject'),
    waits: () => H.gateCalls.slice(calls).filter(n => WAITS.includes(n)) };
}
// The closed telepty.bound-inject-result/v1 shape (every response, any stage).
function assertResultShape(body, sid) {
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `CHECKPOINT: result is an object ${JSON.stringify(body)}`);
  assert.deepEqual(Object.keys(body).sort(), RESULT_KEYS, `CHECKPOINT: closed result keys ${JSON.stringify(body)}`);
  assert.equal(body.schema, RESULT_SCHEMA);
  assert.ok(['refused', 'accepted', 'outcome_unknown'].includes(body.stage), `CHECKPOINT: stage ${body.stage}`);
  assert.equal(body.session_id, sid);
  assert.ok(STAGES.includes(body.body_stage), `CHECKPOINT: body_stage ${body.body_stage}`);
  assert.ok(STAGES.includes(body.submit_stage), `CHECKPOINT: submit_stage ${body.submit_stage}`);
  assert.ok(body.bytes_written === 0 || body.bytes_written === null, `CHECKPOINT: bytes_written ${body.bytes_written}`);
  assert.equal(body.consumption, 'unknown');
  assert.ok(body.inject_id === null || UUID.test(body.inject_id), `CHECKPOINT: inject_id ${body.inject_id}`);
  assert.ok(body.reason === null || (typeof body.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(body.reason)),
    `CHECKPOINT: bounded reason ${JSON.stringify(body.reason)}`);
}
// Refused before any effect: zero is authoritative only here.
function assertRefusedNoEffect(r, sid, ...sockets) {
  assert.ok(r.response.status >= 400 && r.response.status < 500, `CHECKPOINT: refusal is a 4xx (${r.response.status})`);
  assertResultShape(r.response.body, sid);
  assert.deepEqual({ stage: r.response.body.stage, body: r.response.body.body_stage, submit: r.response.body.submit_stage,
    bytes: r.response.body.bytes_written, reasonIsCode: typeof r.response.body.reason === 'string' },
  { stage: 'refused', body: 'not_sent', submit: 'not_sent', bytes: 0, reasonIsCode: true }, JSON.stringify(r.response.body));
  for (const ws of sockets) {
    assert.equal(ws.frames.filter(f => f.type === 'inject').length, 0, 'CHECKPOINT: zero inject frames to any owner');
  }
  assert.equal(H.pendingReports[sid], undefined, 'CHECKPOINT: no tracked pending report for a refused request');
}

// ── CLI capability ───────────────────────────────────────────────────────────────────────────────────────────────
test('B1270 capability: boot-capabilities advertises inject-bound-v1 in the existing sealed verbs array (shape otherwise unchanged)', () => {
  const line = cli.bootCapabilitiesLine();
  const doc = JSON.parse(line);
  assert.deepEqual(Object.keys(doc).sort(), ['schema', 'verbs', 'viewer_detach'], 'sealed document shape unchanged');
  assert.equal(doc.schema, 'telepty-boot-capabilities-v1');
  assert.equal(doc.viewer_detach, 'nondeleting-v1');
  assert.ok(doc.verbs.includes('allow-create-v1'), 'allow-create-v1 stays advertised');
  assert.ok(doc.verbs.includes('inject-bound-v1'), `CHECKPOINT: inject-bound-v1 advertised (${line})`);
  assert.equal(new Set(doc.verbs).size, doc.verbs.length, 'no duplicate verbs');
  const parsed = cli.parseBootCapabilities(`${line}\n`, 0);
  assert.equal(parsed.supported, true, 'the reference validator still accepts the sealed line');
  assert.ok(parsed.verbs.includes('inject-bound-v1'), 'CHECKPOINT: the parsed verbs carry inject-bound-v1');
});

// ── daemon view ──────────────────────────────────────────────────────────────────────────────────────────────────
test('B1270 view: transport exposes daemon-authoritative session_epoch, owner_generation and busy_input bound to the CURRENT owner generation only', () => {
  const declared = H.registerSession('b1270-view-bound');
  const old = H.registerSession('b1270-view-old', { header: HEADER_OLD_BRIDGE });
  const a = H.runtime.buildSessionTransportBlock(declared);
  const b = H.runtime.buildSessionTransportBlock(old);
  assert.equal(a.immediate_submit, 'supported', 'PRECONDITION: immediate-submit-v1 bound for the declaring owner');
  assert.equal(b.immediate_submit, 'supported', 'PRECONDITION: immediate-submit-v1 bound for the old-bridge owner');
  assert.deepEqual({ epoch: a.session_epoch, generation: a.owner_generation, busy: a.busy_input },
    { epoch: declared.sessionEpoch, generation: declared.interactionOwnerGeneration, busy: 'supported' },
    'CHECKPOINT: busy-input-v1 declared on the owner handshake is visible with the exact epoch/generation');
  assert.equal(b.busy_input, 'unsupported_by_bridge', 'CHECKPOINT: an owner that did not declare busy-input-v1');
  // A later claim (new generation, same epoch) that did not re-declare the capability does not inherit it.
  H.claimOwner(declared, H.ownerSocket(), { supervised: true });
  H.negotiate(declared, { capable: true, header: HEADER_OLD_BRIDGE });
  H.transportReady(declared);
  const c = H.runtime.buildSessionTransportBlock(declared);
  assert.deepEqual({ epoch: c.session_epoch, generation: c.owner_generation, busy: c.busy_input },
    { epoch: declared.sessionEpoch, generation: declared.interactionOwnerGeneration, busy: 'unsupported_by_bridge' },
    'CHECKPOINT: busy-input-v1 of a previous owner generation is not honoured');
});

// ── bound route ──────────────────────────────────────────────────────────────────────────────────────────────────
test('B1270 accept: ONE bound request on a BUSY capable session hands one body then one paired CR to the current owner — no prompt/REPL/settle wait, no /submit, consumption unknown', { timeout: 30000 }, async () => {
  const sid = 'b1270-accept';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  boundRouteRegistered();
  const r = await bound(sid, boundRequest(session, 'B1270-ACCEPT body'));
  await sleep(1000);   // a retry/redeliver loop would add another frame inside this window
  const body = r.response.body;
  assert.ok(r.response.status >= 200 && r.response.status < 300, `CHECKPOINT: accepted is 2xx (${r.response.status} ${JSON.stringify(body)})`);
  assertResultShape(body, sid);
  assert.deepEqual({ stage: body.stage, reason: body.reason, epoch: body.session_epoch, generation: body.owner_generation,
    bodyStage: body.body_stage, submitStage: body.submit_stage, bytes: body.bytes_written, injectId: UUID.test(String(body.inject_id)) }, {
    stage: 'accepted', reason: null, epoch: session.sessionEpoch, generation: session.interactionOwnerGeneration,
    bodyStage: 'sent_to_bridge', submitStage: 'sent_to_bridge', bytes: null, injectId: true,
  }, 'CHECKPOINT: accepted = both frames handed to the pinned owner; never a PTY/model claim; zero/positive bytes never inferred');
  const frames = r.frames();
  assert.deepEqual(frames.map(f => [f.part, f.inject_id, f.part === 'submit' ? f.data : 'body']),
    [['body', body.inject_id, 'body'], ['submit', body.inject_id, '\r']], 'CHECKPOINT: exactly [body, CR] for this inject, in order');
  assert.equal(frames[1].pair, frames[0].daemon_msg_id, 'CHECKPOINT: the CR names its own body as pair');
  assert.deepEqual(frames.map(f => f.owner_generation), [session.interactionOwnerGeneration, session.interactionOwnerGeneration],
    'CHECKPOINT: both frames are bound to the expected (current) owner generation');
  assert.ok(frames[0].data.includes('B1270-ACCEPT body'), 'CHECKPOINT: the body frame carries the prompt');
  assert.deepEqual(r.waits(), [], 'CHECKPOINT: no prompt-symbol/REPL/settle/confirm/consumption wait on the busy path');
  assert.ok(r.elapsedMs < 1000, `CHECKPOINT: no output-silence wait (${r.elapsedMs} ms)`);
});

test('B1270 old bridge: an owner that did not declare busy-input-v1 is refused before any effect (zero frames, bytes_written 0, no tracked record)', { timeout: 30000 }, async () => {
  const sid = 'b1270-old-bridge';
  const session = H.registerSession(sid, { header: HEADER_OLD_BRIDGE });
  H.sessionStateManager.feed(sid, WORKING);
  boundRouteRegistered();
  const r = await bound(sid, boundRequest(session, 'B1270-OLD body'));
  await sleep(300);
  assertRefusedNoEffect(r, sid, session.ownerWs);
});

test('B1270 stale binding: a reclaimed owner (same epoch, new generation) or a stale epoch is refused with zero frames to either owner; the current binding is accepted', { timeout: 30000 }, async () => {
  const sid = 'b1270-stale';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const oldWs = session.ownerWs;
  const oldGeneration = session.interactionOwnerGeneration;
  const epoch = session.sessionEpoch;
  const newWs = H.ownerSocket();
  H.claimOwner(session, newWs, { supervised: true });
  H.negotiate(session, { capable: true, header: HEADER_BOUND });
  H.transportReady(session);
  assert.notEqual(session.interactionOwnerGeneration, oldGeneration, 'PRECONDITION: reclaim minted a new generation');
  assert.equal(session.sessionEpoch, epoch, 'PRECONDITION: reclaim keeps the epoch');
  boundRouteRegistered();
  const staleGeneration = await bound(sid, boundRequest(session, 'B1270-STALE-GEN body', { expected_owner_generation: oldGeneration }));
  const staleEpoch = await bound(sid, boundRequest(session, 'B1270-STALE-EPOCH body', { expected_epoch: crypto.randomUUID() }));
  await sleep(300);
  assertRefusedNoEffect(staleGeneration, sid, oldWs, newWs);
  assertRefusedNoEffect(staleEpoch, sid, oldWs, newWs);
  const current = await bound(sid, boundRequest(session, 'B1270-CURRENT body'));
  await sleep(300);
  assert.equal(current.response.body && current.response.body.stage, 'accepted', `CHECKPOINT: control ${JSON.stringify(current.response.body)}`);
  assert.deepEqual(newWs.frames.filter(f => f.type === 'inject').map(f => f.part), ['body', 'submit'], 'CHECKPOINT: only the current owner gets [body, CR]');
  assert.equal(oldWs.frames.filter(f => f.type === 'inject').length, 0, 'CHECKPOINT: the previous owner never gets a frame');
});

test('B1270 closed schema: unknown/missing keys, coercions and an incomplete require list are refused before any effect', { timeout: 30000 }, async () => {
  const sid = 'b1270-schema';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  boundRouteRegistered();
  const valid = boundRequest(session, 'B1270-SCHEMA body');
  const without = key => { const copy = { ...valid }; delete copy[key]; return copy; };
  const variants = {
    'unknown key (legacy exact_target)': { ...valid, exact_target: true },
    'unknown key (legacy no_enter)': { ...valid, no_enter: true },
    'missing schema': without('schema'),
    'wrong schema version': { ...valid, schema: 'telepty.bound-inject/v2' },
    'missing prompt': without('prompt'),
    'non-string prompt': { ...valid, prompt: 42 },
    'missing expected_epoch': without('expected_epoch'),
    'missing expected_owner_generation': without('expected_owner_generation'),
    'numeric expected_owner_generation': { ...valid, expected_owner_generation: 1 },
    'missing require': without('require'),
    'require without busy-input-v1': { ...valid, require: ['immediate-submit-v1'] },
    'require with a duplicate': { ...valid, require: ['immediate-submit-v1', 'busy-input-v1', 'busy-input-v1'] },
    'require as a string': { ...valid, require: 'immediate-submit-v1,busy-input-v1' },
  };
  for (const [label, body] of Object.entries(variants)) {
    const r = await bound(sid, body);
    await sleep(20);
    assert.ok(r.response.status >= 400 && r.response.status < 500, `CHECKPOINT: ${label} -> 4xx (${r.response.status})`);
    assertResultShape(r.response.body, sid);
    assert.deepEqual({ stage: r.response.body.stage, bytes: r.response.body.bytes_written, bodyStage: r.response.body.body_stage,
      submitStage: r.response.body.submit_stage }, { stage: 'refused', bytes: 0, bodyStage: 'not_sent', submitStage: 'not_sent' },
    `CHECKPOINT: ${label} refused before any effect`);
  }
  assert.equal(session.ownerWs.frames.filter(f => f.type === 'inject').length, 0, 'CHECKPOINT: zero frames for every malformed request');
  assert.equal(H.pendingReports[sid], undefined, 'CHECKPOINT: no tracked record for any malformed request');
});
