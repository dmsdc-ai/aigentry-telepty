'use strict';

// Task 1270 phase B — the bound busy-input transport, the cases the phase-A RED file deliberately left out.
// test/inject-bound-v1-1270.test.js owns the frozen interface (capability, view, accept, old bridge, stale binding,
// closed schema) and is UNCHANGED by this phase. This file adds the decisive behaviours of the implementation:
//   1. the strict local CLI verb — exact argv, canonical host, ONE post, no retry/fallback, unknown ≠ refused;
//   2. the client-profile scope — the new route is default-DENIED, no grant or field allow-list was widened;
//   3. current-store ABA and owner reclaim AT AN AWAIT, with zero frames to either owner;
//   4. a handed body whose CR fails: outcome_unknown, and every LATER path (bound, legacy body, legacy CR,
//      manual/force/redeliver) blocked for that exact identity while an unrelated record stays untouched.
//
// Real production seams, no mirrored product logic: cli.js's exported verb, src/protocol/bound-inject.js,
// src/protocol/client-profiles.js's real gate, and the same daemon composition the RED file uses
// (createDeliveryRuntime + createSessionDeliveryContext + DeliveryEngine + FileMailbox + createSessionActions,
// claim order as websocket.js). Declared fakes: owner-WS frame recorders (one of which closes itself mid-write to
// make a CR fail deterministically), an injected fetch recorder, a private ledger/mailbox under os.tmpdir().
// A frame handed to a recorder proves DAEMON HAND-OFF only (sent_to_bridge) — never a PTY write, native queueing,
// auto-submit or model consumption. No listener, network, daemon/bridge process, provider, native PTY or model.
// "PRECONDITION:" marks an invalid setup (not a product finding); "CHECKPOINT:" marks the intended behaviour.

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
const readinessHandshake = load('src/transport/readiness-handshake');
const boundInject = load('src/protocol/bound-inject.js');
const clientProfiles = load('src/protocol/client-profiles.js');
const cli = load('cli.js');
// r1: the real viewer-input gate (module scope in websocket.js — requiring it starts no server, socket or
// listener), the real session-store serializer/restorer, and strict mode's action table.
const wsTransport = load('src/transport/websocket.js');
const persistence = load('src/session-store/persistence.js');
const principalHttp = load('src/principal/http.js');

const BOUND_ROUTE = '/api/sessions/:id/inject-bound-v1';
const RESULT_SCHEMA = 'telepty.bound-inject-result/v1';
const REQUIRE = Object.freeze(['immediate-submit-v1', 'busy-input-v1']);
const HEADER_BOUND = 'input-transport-ready-v1, immediate-submit-v1, busy-input-v1';
const RESULT_KEYS = ['body_stage', 'bytes_written', 'consumption', 'inject_id', 'owner_generation', 'reason', 'schema',
  'session_epoch', 'session_id', 'stage', 'submit_stage'];
const STAGES = ['not_sent', 'queued', 'sent_to_bridge', 'pty_written', 'unknown'];
const WAITS = ['awaitPromptSymbol', 'awaitReplReady', 'awaitInputSettled', 'confirmSubmitAccepted', 'classifyInjectConsumption'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKING = 'Working (12s • esc to interrupt)\r\n';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Part 1: the strict local CLI verb (pure; no harness, no socket, no daemon) ──────────────────────────────────

test('B1270G argv: the verb accepts exactly one argv shape and builds the closed request from it', () => {
  const argv = ['--from', 'E-sender', '--expected-epoch', 'EPOCH-1', '--expected-owner-generation', 'GEN-1', '--', 'E-target', 'hello body'];
  const parsed = cli.parseBoundInjectArgv(argv);
  assert.equal(parsed.ok, true, `CHECKPOINT: the exact shape parses (${JSON.stringify(parsed)})`);
  assert.equal(parsed.sid, 'E-target', 'CHECKPOINT: the sid is taken VERBATIM — no alias/sibling/peer resolution');
  assert.deepEqual(parsed.request, {
    schema: 'telepty.bound-inject/v1', prompt: 'hello body', from: 'E-sender',
    expected_epoch: 'EPOCH-1', expected_owner_generation: 'GEN-1', require: ['immediate-submit-v1', 'busy-input-v1'],
  }, 'CHECKPOINT: exactly the six closed keys, with require in its exact order');
  // Flag order is not part of the contract; duplication and unknown flags are.
  const reordered = cli.parseBoundInjectArgv(['--expected-owner-generation', 'GEN-1', '--expected-epoch', 'EPOCH-1',
    '--from', 'E-sender', '--', 'E-target', 'hello body']);
  assert.deepEqual(reordered, parsed, 'CHECKPOINT: flag order is irrelevant, the built request is identical');
});

test('B1270G argv: unknown/duplicate flags, a missing separator and a non-exact target are refused with a bounded code', () => {
  const base = ['--from', 'E-sender', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1'];
  const variants = {
    // An old CLI turns an unknown flag into prompt TEXT; refusing it is what makes this verb's presence meaningful.
    'unknown flag': [...base, '--submit-force', '--', 'sid', 'body'],
    'legacy flag': [...base, '--no-enter', '--', 'sid', 'body'],
    'duplicate flag': [...base, '--from', 'E-other', '--', 'sid', 'body'],
    'equals form': ['--from=E-sender', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1', '--', 'sid', 'body'],
    'missing flag': ['--from', 'E-sender', '--expected-epoch', 'E1', '--', 'sid', 'body'],
    'missing separator': [...base, 'sid', 'body'],
    'two separators': [...base, '--', 'sid', '--', 'body'],
    'one positional': [...base, '--', 'sid'],
    'three positionals': [...base, '--', 'sid', 'body', 'extra'],
    'flag value missing': ['--from', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1', '--', 'sid', 'body'],
    'qualified remote target': [...base, '--', 'sid@10.0.0.4', 'body'],
    'path-ish target': [...base, '--', 'api/sessions/sid', 'body'],
    'empty target': [...base, '--', '', 'body'],
    'dot target': [...base, '--', '..', 'body'],
    'control char in epoch': ['--from', 'E-sender', '--expected-epoch', 'E\u00001', '--expected-owner-generation', 'G1', '--', 'sid', 'body'],
    'oversized generation': ['--from', 'E-sender', '--expected-epoch', 'E1', '--expected-owner-generation', 'G'.repeat(257), '--', 'sid', 'body'],
    'help': ['--help'],
    'empty argv': [],
  };
  for (const [label, argv] of Object.entries(variants)) {
    const parsed = cli.parseBoundInjectArgv(argv);
    assert.equal(parsed.ok, false, `CHECKPOINT: ${label} is refused`);
    assert.match(parsed.code, /^[a-z0-9_]{1,64}$/, `CHECKPOINT: ${label} refusal is a bounded code (${parsed.code})`);
  }
});

test('B1270G host: only the canonical loopback daemon is addressed, decided before any socket', () => {
  assert.equal(cli.boundTargetRefusal('127.0.0.1'), null, 'CHECKPOINT: the canonical local daemon is the only target');
  for (const host of ['10.0.0.4', 'localhost', '::1', '127.0.0.2', 'example.test', '', null, undefined]) {
    const refusal = cli.boundTargetRefusal(host);
    assert.equal(typeof refusal, 'string', `CHECKPOINT: ${JSON.stringify(host)} is refused`);
    assert.match(refusal, /No request was sent/, 'CHECKPOINT: the refusal states that nothing was sent');
  }
});

test('B1270G transport: ONE post, and unsupported/unknown/accepted are three different answers with no replay', async () => {
  const sid = 'E-target';
  const argv = ['--from', 'E-sender', '--expected-epoch', 'E1', '--expected-owner-generation', 'G1', '--', sid, 'payload'];
  const run = async (responder, { host = '127.0.0.1', args = argv } = {}) => {
    const calls = [];
    const out = []; const err = [];
    const code = await cli.runInjectBoundV1(args, {
      remoteHost: host,
      daemonUrl: 'http://127.0.0.1:3848',
      fetchWithAuth: (url, options) => { calls.push({ url, options }); return responder(); },
      stdout: { write: s => { out.push(String(s)); return true; } },
      stderr: { write: s => { err.push(String(s)); return true; } },
    });
    return { code, calls, lines: out.map(JSON.parse) };
  };
  const json = (status, body) => () => Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });
  const result = extra => ({ schema: RESULT_SCHEMA, stage: 'accepted', reason: null, session_id: sid, session_epoch: 'E1',
    owner_generation: 'G1', inject_id: crypto.randomUUID(), body_stage: 'sent_to_bridge', submit_stage: 'sent_to_bridge',
    bytes_written: null, consumption: 'unknown', ...extra });

  const accepted = await run(json(200, result()));
  assert.deepEqual([accepted.code, accepted.calls.length], [0, 1], 'CHECKPOINT: accepted exits 0 after EXACTLY one request');
  assert.equal(accepted.calls[0].url, `http://127.0.0.1:3848/api/sessions/${sid}/inject-bound-v1`,
    'CHECKPOINT: the exact versioned loopback path, the sid unresolved');
  assert.equal(accepted.calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(accepted.calls[0].options.body).require, REQUIRE, 'CHECKPOINT: both guarantees are demanded on the wire');
  assert.equal(accepted.lines[0].transport, 'accepted');

  // An old daemon does not know this route and answers a schema-less 404: the ONE 404 that proves no input.
  const old = await run(json(404, { error: 'Not found' }));
  assert.deepEqual([old.code, old.calls.length, old.lines[0].transport], [1, 1, 'unsupported'],
    'CHECKPOINT: an old daemon is unsupported — refused, never retried, and never read as success');
  // A 404 that DOES carry the closed schema is the route's own refusal, not "unsupported".
  const notFound = await run(json(404, { ...result({ stage: 'refused', reason: 'session_not_found' }) }));
  assert.deepEqual([notFound.code, notFound.lines[0].transport], [1, 'refused'], 'CHECKPOINT: a schema-ful 404 is a refusal');

  // A lost/unparseable answer may have had an effect: unknown, held, its OWN exit code, and still one request.
  const lost = await run(() => Promise.reject(new Error('socket hang up')));
  assert.deepEqual([lost.code, lost.calls.length, lost.lines[0].transport], [3, 1, 'outcome_unknown'],
    'CHECKPOINT: a lost response is unknown with no replay — never inferred to be unsent');
  const garbage = await run(json(200, { ok: true }));
  assert.deepEqual([garbage.code, garbage.lines[0].transport], [3, 'outcome_unknown'], 'CHECKPOINT: a non-schema 200 is unknown');
  const unknownStage = await run(json(500, result({ stage: 'outcome_unknown', reason: 'submit_outcome_unknown', submit_stage: 'unknown' })));
  assert.deepEqual([unknownStage.code, unknownStage.lines[0].transport], [3, 'outcome_unknown'],
    'CHECKPOINT: the daemon\'s own outcome_unknown keeps the hold exit code');

  // Nothing is sent when the request could not be built, or when this host is not the target.
  const badArgv = await run(json(200, result()), { args: ['--from', 'E-sender'] });
  assert.deepEqual([badArgv.code, badArgv.calls.length], [2, 0], 'CHECKPOINT: a usage refusal opens no socket');
  const remote = await run(json(200, result()), { host: '10.0.0.4' });
  assert.deepEqual([remote.code, remote.calls.length], [2, 0], 'CHECKPOINT: a non-canonical host opens no socket');
});

test('B1270G result shape: the builder is closed and zero bytes is never produced for a handed body', () => {
  const refused = boundInject.boundResult({ stage: 'refused', reason: 'epoch_mismatch', sessionId: 's' });
  assert.deepEqual(Object.keys(refused).sort(), RESULT_KEYS, 'CHECKPOINT: one closed key set for every stage');
  assert.deepEqual([refused.bytes_written, refused.body_stage, refused.submit_stage, refused.consumption],
    [0, 'not_sent', 'not_sent', 'unknown'], 'CHECKPOINT: zero is the default only where nothing was attempted');
  const unknown = boundInject.boundResult({ stage: 'outcome_unknown', reason: 'submit_outcome_unknown', sessionId: 's',
    bodyStage: 'sent_to_bridge', submitStage: 'unknown', bytesWritten: null });
  assert.equal(unknown.bytes_written, null, 'CHECKPOINT: a handed body can never report 0 bytes');
  // Anything that is not an exact 0 is reported as null: a positive count this daemon cannot prove is not invented.
  assert.equal(boundInject.boundResult({ stage: 'accepted', sessionId: 's', bytesWritten: 42 }).bytes_written, null,
    'CHECKPOINT: an unproven byte count is null, never a number');
  assert.throws(() => boundInject.boundResult({ stage: 'written', sessionId: 's' }), /stage/,
    'CHECKPOINT: an out-of-vocabulary stage cannot be built');
  assert.equal(boundInject.boundResult({ stage: 'refused', reason: '/Users/me/secret.txt threw: ENOENT', sessionId: 's' }).reason.length <= 64, true,
    'CHECKPOINT: a reason is a bounded code and cannot carry a path or raw error');
});

// ── Part 2: client-profile scope — the new route is default-denied, nothing was widened ─────────────────────────

test('B1270G profile scope: a client-profile caller is denied on the bound route, and the bound BODY is outside the inject scope too', () => {
  const token = `tpc1.1.${crypto.randomBytes(32).toString('base64url')}`;
  assert.match(token, clientProfiles.TOKEN_RE, 'PRECONDITION: the fixture token has the real carrier shape');
  const verifier = crypto.createHash('sha256').update(token).digest();
  const caller = { id: 'profile-1270', verifier, targetSet: new Set(['E-target']), notBeforeMs: 0,
    namespacePrefixes: ['profile-1270'], audience: 'local' };
  const gate = clientProfiles.createClientProfileGate({
    registry: { load: () => ({ byVerifier: new Map([[`sha256:${verifier.toString('hex')}`, caller]]) }) },
    sessions: () => ({}),
    credentials: { verify: () => null },
    now: () => 1,
  });
  const body = { schema: 'telepty.bound-inject/v1', prompt: 'p', from: 'profile-1270', expected_epoch: 'E1',
    expected_owner_generation: 'G1', require: [...REQUIRE] };
  const request = pathname => ({ method: 'POST', path: pathname, url: pathname, originalUrl: pathname, query: {}, body,
    headers: { [clientProfiles.CLIENT_TOKEN_HEADER]: token }, rawHeaders: [clientProfiles.CLIENT_TOKEN_HEADER, token],
    socket: { remoteAddress: '127.0.0.1' } });

  assert.equal(gate.presentsClientToken(request('/api/sessions/E-target/inject-bound-v1')), true,
    'PRECONDITION: the profile carrier is what routes this request to the profile gate ALONE');
  const bound = gate.authorize(request('/api/sessions/E-target/inject-bound-v1'));
  assert.deepEqual({ ok: bound.ok, status: bound.status, code: bound.code }, { ok: false, status: 403, code: 'PROFILE_ACTION_DENIED' },
    'CHECKPOINT: the bound route is not in the client-profile allow table — default deny, no new grant');
  // The control: on the route the profile DOES have, this body is still outside its field scope. So nothing was
  // widened anywhere — not the path table, not the inject field allow-list.
  const legacy = gate.authorize(request('/api/sessions/E-target/inject'));
  assert.deepEqual({ ok: legacy.ok, code: legacy.code }, { ok: false, code: 'PROFILE_REQUEST_FIELD_DENIED' },
    'CHECKPOINT: the bound body is outside the profile inject scope as well');
  // A target this profile was never granted stays denied on the bound route too (cross-profile denial preserved).
  const foreign = gate.authorize(request('/api/sessions/E-someone-else/inject-bound-v1'));
  assert.deepEqual({ ok: foreign.ok, code: foreign.code }, { ok: false, code: 'PROFILE_ACTION_DENIED' },
    'CHECKPOINT: a foreign target on the bound route is denied, never admitted by the new path');
});

// ── daemon harness ─────────────────────────────────────────────────────────────────────────────────────────────
// Copied from test/inject-bound-v1-1270.test.js compose() (itself copied from test/immediate-submit-1215.test.js
// lines 356-503), because that file is the sealed phase-A artifact and is not edited by this phase. Differences
// from that copy, all additive: `ownerSocket` takes an optional onSend hook (used ONCE, to close a socket inside
// its own write so a CR fails without a timer), and writeDataToSession / deliverInjectionToSession / submitPair
// helpers are exposed so the LEGACY paths can be driven against a stranded composer.
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1270-green-'));
  const ledgerDir = path.join(root, 'tracked-injections.json');
  const ledgerClient = createLedgerClient({ dir: ledgerDir, lockPath: path.join(root, 'tracked-injections.lock'), legacyPath: ledgerDir });
  const sessions = Object.create(null);
  const pendingReports = Object.create(null);
  // r3: the bus events this daemon publishes, captured instead of discarded (findings RR-m3 / RR-m4).
  const busEvents = [];
  const busClients = new Set([{ readyState: 1, send(raw) { try { busEvents.push(JSON.parse(raw)); } catch { busEvents.push({ unparsed: raw }); } } }]);
  const sessionStateManager = new SessionStateManager();
  // r1: the audit lines this door writes (#47 P5), captured instead of discarded, and the orchestrator-sid list
  // as a MUTABLE array so the #533 peer-lane cases can configure it for themselves and restore it after.
  const auditLines = [];
  const orchestratorSids = [];
  const rshared = {
    sessions, crypto, fs, sessionPersistence, sessionCredentials: createCredentialStore(),
    auditWriter: { append(record) { auditLines.push(record); } },
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
    ORCHESTRATOR_SIDS: orchestratorSids, MACHINE_ID: 'b1270-green-machine',
    NON_TERMINAL_GATE_REASONS: new Set(['timeout', 'no_state', 'no_state_manager', 'busy_settled']),
    SUBMIT_BUSY_DISPATCH_ENABLED: true, SUBMIT_BUSY_GRACE_MS: 250,
    REDELIVER_ENABLED: true, REDELIVER_MAX_ATTEMPTS: 3, REDELIVER_TOTAL_TIMEOUT_MS: 600000, REDELIVER_IDLE_WAIT_MS: 120000,
    CAPABILITY_STAGE_A, deliveredAbsenceIdentities: new WeakMap(),
  };
  const actions = createSessionActions(ashared, {});
  const routes = Object.create(null);
  const app = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (route, ...handlers) => { routes[`${method.toUpperCase()} ${route}`] = handlers[handlers.length - 1]; };
  }
  for (const [name, fn] of Object.entries(actions)) {
    if (/^register\w*Route$/.test(name) && typeof fn === 'function') fn(app);
  }
  assert.equal(typeof routes[`POST ${BOUND_ROUTE}`], 'function', 'PRECONDITION: the bound route is registered');

  function ownerSocket(onSend) {
    const ws = { readyState: 1, frames: [], send(raw) { ws.frames.push(JSON.parse(raw)); if (onSend) onSend(ws, ws.frames.at(-1)); } };
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
  function registerSession(sid, { command = 'claude', supervised = true, capable = true, header = HEADER_BOUND, ready = true, onSend = null } = {}) {
    const ws = ownerSocket(onSend);
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
    dispose, gateCalls, sessionStateManager, auditLines, orchestratorSids, busEvents,
    writeDataToSession: context.writeDataToSession, deliverInjectionToSession: context.deliverInjectionToSession,
    // r3: the mailbox drain's own entry point, so the cooperative-handoff branch (RR-M3) can be driven directly.
    mailboxDeliverFn: context.mailboxDeliveryOptions.deliverFn };
}

before(async () => { H = await compose(); }, { timeout: 20000 });
after(async () => { if (H) await H.dispose(); }, { timeout: 20000 });

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
function boundRequest(session, prompt, overrides = {}) {
  return { schema: 'telepty.bound-inject/v1', prompt, from: 'fixture-sender', expected_epoch: session.sessionEpoch,
    expected_owner_generation: session.interactionOwnerGeneration, require: [...REQUIRE], ...overrides };
}
function post(sid, body) { return H.call(`POST ${BOUND_ROUTE}`, sid, body); }
function injects(ws) { return ws.frames.filter(f => f.type === 'inject'); }
function assertResultShape(body, sid) {
  assert.deepEqual(Object.keys(body).sort(), RESULT_KEYS, `CHECKPOINT: closed result keys ${JSON.stringify(body)}`);
  assert.equal(body.schema, RESULT_SCHEMA);
  assert.equal(body.session_id, sid);
  assert.ok(STAGES.includes(body.body_stage) && STAGES.includes(body.submit_stage), `CHECKPOINT: frame stages ${JSON.stringify(body)}`);
  assert.equal(body.consumption, 'unknown');
  assert.ok(body.bytes_written === 0 || body.bytes_written === null, `CHECKPOINT: bytes_written ${body.bytes_written}`);
  assert.ok(body.reason === null || /^[a-z0-9_]{1,64}$/.test(body.reason), `CHECKPOINT: bounded reason ${JSON.stringify(body.reason)}`);
  assert.ok(body.inject_id === null || UUID.test(body.inject_id), `CHECKPOINT: inject_id ${body.inject_id}`);
}

// ── Part 3: the CURRENT store object and owner generation, re-checked AT THE AWAIT ──────────────────────────────

test('B1270G reclaim at await: an owner reclaim while the request waits on the submit barrier refuses with zero frames to either owner', { timeout: 30000 }, async () => {
  const sid = 'b1270g-reclaim-at-await';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const oldWs = session.ownerWs;
  const request = boundRequest(session, 'B1270G-RECLAIM body');
  // The deterministic await: the existing per-session submit barrier. The request passes every synchronous
  // precheck against the CURRENT binding, then parks here — exactly the window a preflight-only check misses.
  let releasePending;
  session.pendingSubmit = new Promise(resolve => { releasePending = () => { session.pendingSubmit = null; resolve(); }; });
  const inFlight = post(sid, request);
  await sleep(50);
  assert.equal(injects(oldWs).length, 0, 'PRECONDITION: nothing was written before the barrier cleared');
  const newWs = H.ownerSocket();
  H.claimOwner(session, newWs, { supervised: true });
  H.negotiate(session, { capable: true, header: HEADER_BOUND });
  H.transportReady(session);
  assert.notEqual(session.interactionOwnerGeneration, request.expected_owner_generation, 'PRECONDITION: the reclaim minted a new generation');
  releasePending();
  const response = await inFlight;
  await sleep(300);
  assert.ok(response.status >= 400 && response.status < 500, `CHECKPOINT: refused 4xx (${response.status})`);
  assertResultShape(response.body, sid);
  assert.deepEqual({ stage: response.body.stage, body: response.body.body_stage, submit: response.body.submit_stage,
    bytes: response.body.bytes_written, inject: response.body.inject_id },
  { stage: 'refused', body: 'not_sent', submit: 'not_sent', bytes: 0, inject: null },
  `CHECKPOINT: a binding that changed at the await writes nothing ${JSON.stringify(response.body)}`);
  assert.equal(injects(oldWs).length, 0, 'CHECKPOINT: the owner this request was bound to never gets a frame');
  assert.equal(injects(newWs).length, 0, 'CHECKPOINT: the owner that replaced it never gets this frame either');
  // The daemon's own current identity is reported back, not the stale values the caller sent.
  assert.deepEqual({ epoch: response.body.session_epoch, generation: response.body.owner_generation },
    { epoch: session.sessionEpoch, generation: session.interactionOwnerGeneration },
    'CHECKPOINT: the result names the daemon-authoritative binding');
});

test('B1270G store ABA at await: a destroy/recreate under the same id refuses, and the recreated record gets nothing', { timeout: 30000 }, async () => {
  const sid = 'b1270g-aba-at-await';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const oldWs = session.ownerWs;
  const request = boundRequest(session, 'B1270G-ABA body');
  let releasePending;
  session.pendingSubmit = new Promise(resolve => { releasePending = () => { session.pendingSubmit = null; resolve(); }; });
  const inFlight = post(sid, request);
  await sleep(50);
  // Destroy and recreate under the SAME id, and give the new record the SAME epoch and generation strings the
  // request pinned: only the OBJECT identity differs. A check that compared values alone would deliver here.
  const recreatedWs = H.ownerSocket();
  const recreated = { ...session, ownerWs: recreatedWs, clients: new Set([recreatedWs]) };
  H.sessions[sid] = recreated;
  assert.notEqual(H.sessions[sid], session, 'PRECONDITION: sessions[id] is a different object');
  assert.equal(H.sessions[sid].sessionEpoch, request.expected_epoch, 'PRECONDITION: the recreated record reuses the pinned epoch');
  releasePending();
  const response = await inFlight;
  await sleep(300);
  assertResultShape(response.body, sid);
  assert.deepEqual({ stage: response.body.stage, bytes: response.body.bytes_written, body: response.body.body_stage },
    { stage: 'refused', bytes: 0, body: 'not_sent' }, `CHECKPOINT: an ABA record is refused ${JSON.stringify(response.body)}`);
  assert.equal(injects(oldWs).length, 0, 'CHECKPOINT: the destroyed record\'s owner gets nothing');
  assert.equal(injects(recreatedWs).length, 0, 'CHECKPOINT: the recreated record never receives a body bound to its predecessor');
  H.sessions[sid] = session;   // leave the fixture's own record for dispose()
});

// ── Part 4: a handed body whose CR fails strands THAT identity for every later path ─────────────────────────────

test('B1270G strand: a body handed with no CR is outcome_unknown, and every later bound/legacy/manual path is blocked for that instance', { timeout: 30000 }, async () => {
  const sid = 'b1270g-strand';
  // The owner socket closes itself INSIDE its own body write: the body is handed, and the CR that follows cannot
  // be. No timer, no sleep — the failure is in the write order itself.
  const session = H.registerSession(sid, { onSend: (ws, frame) => { if (frame.part === 'body') ws.readyState = 3; } });
  H.sessionStateManager.feed(sid, WORKING);
  const flakyWs = session.ownerWs;
  const epoch = session.sessionEpoch;
  const response = await post(sid, boundRequest(session, 'B1270G-STRAND body'));
  await sleep(300);
  assertResultShape(response.body, sid);
  assert.ok(response.status >= 500, `CHECKPOINT: an unknown outcome is not a 4xx refusal (${response.status})`);
  assert.deepEqual({ stage: response.body.stage, body: response.body.body_stage, bytes: response.body.bytes_written,
    hasInject: UUID.test(String(response.body.inject_id)) },
  { stage: 'outcome_unknown', body: 'sent_to_bridge', bytes: null, hasInject: true },
  `CHECKPOINT: a handed body with no CR is unknown, never 0 bytes and never accepted ${JSON.stringify(response.body)}`);
  assert.ok(['not_sent', 'unknown'].includes(response.body.submit_stage), `CHECKPOINT: submit_stage ${response.body.submit_stage}`);
  const handed = injects(flakyWs);
  assert.deepEqual(handed.map(f => f.part), ['body'], 'CHECKPOINT: exactly the body was handed — no CR followed it');

  // A LIVE owner comes back on the SAME session instance (new generation, same epoch): the composer still holds
  // that unsubmitted text, so nothing may be appended to it or submit it.
  const freshWs = H.ownerSocket();
  H.claimOwner(session, freshWs, { supervised: true });
  H.negotiate(session, { capable: true, header: HEADER_BOUND });
  H.transportReady(session);
  assert.equal(H.runtime.buildSessionTransportBlock(session).busy_input, 'supported',
    'PRECONDITION: the new owner generation re-declared busy-input-v1, so only the strand can refuse now');

  const again = await post(sid, boundRequest(session, 'B1270G-STRAND second body'));
  assert.deepEqual({ status: again.status >= 400 && again.status < 500, stage: again.body.stage, reason: again.body.reason,
    bytes: again.body.bytes_written }, { status: true, stage: 'refused', reason: 'composer_stranded', bytes: 0 },
  `CHECKPOINT: a later BOUND body is refused composer_stranded ${JSON.stringify(again.body)}`);

  // The legacy body path, through the shared delivery boundary.
  const legacyBody = await H.writeDataToSession(sid, session, 'B1270G-STRAND legacy append');
  assert.deepEqual({ success: legacyBody.success, code: legacyBody.code, bytes: legacyBody.bytes_written },
    { success: false, code: 'COMPOSER_STRANDED', bytes: 0 }, `CHECKPOINT: a later LEGACY body is refused ${JSON.stringify(legacyBody)}`);
  const legacyInject = await H.deliverInjectionToSession(sid, session, 'B1270G-STRAND legacy inject', { from: 'fixture-sender' });
  assert.equal(legacyInject.success, false, `CHECKPOINT: the legacy inject path delivers nothing ${JSON.stringify(legacyInject)}`);

  // Every bare-CR producer: the immediate/gated /submit chain, send-key --force and the #617 idle redeliver all
  // reach the owner through terminalLevelSubmit → submitViaPty, so one guard covers all of them.
  assert.equal(H.runtime.terminalLevelSubmit(sid, session, undefined), null, 'CHECKPOINT: a later id-less CR is refused');
  assert.equal(H.runtime.terminalLevelSubmit(sid, session, { immediate: true, injectId: response.body.inject_id }), null,
    'CHECKPOINT: a later CR naming the stranded inject is refused too');
  assert.equal(H.runtime.submitViaPty(session), false, 'CHECKPOINT: the shared CR boundary itself refuses');
  assert.equal(injects(freshWs).length, 0, 'CHECKPOINT: the live owner received NOTHING after the strand — no append, no Enter');

  // No automatic clear: not by a reclaim, not by a refusal, not by time.
  assert.ok(runtimeModule.strandedComposer(session), 'CHECKPOINT: the strand is not cleared by an owner reclaim or by any attempt above');

  // An unrelated record is untouched — the strand is one instance's, not the daemon's.
  const other = H.registerSession('b1270g-strand-other');
  H.sessionStateManager.feed('b1270g-strand-other', WORKING);
  const unrelated = await post('b1270g-strand-other', boundRequest(other, 'B1270G-OTHER body'));
  assert.equal(unrelated.body.stage, 'accepted', `CHECKPOINT: an unrelated session still delivers ${JSON.stringify(unrelated.body)}`);
  assert.equal(epoch, session.sessionEpoch, 'PRECONDITION: the stranded record kept its epoch throughout');
});

test('B1270G strand keying: the strand belongs to one epoch — a new epoch is a new composer and is not blocked', () => {
  // Pure unit on the exported boundary: the epoch is the identity of the instance whose composer holds the text.
  const session = { id: 'b1270g-keying', sessionEpoch: 'epoch-A' };
  runtimeModule.strandComposer(session, { epoch: 'epoch-A', injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  assert.ok(runtimeModule.strandedComposer(session), 'CHECKPOINT: stranded while the instance that holds the text is current');
  assert.equal(runtimeModule.strandedInputFailure(session).code, 'COMPOSER_STRANDED', 'CHECKPOINT: the shared refusal names itself');
  session.sessionEpoch = 'epoch-B';
  assert.equal(runtimeModule.strandedComposer(session), null, 'CHECKPOINT: a NEW epoch is a new composer and is never blocked by the old strand');
  assert.equal(runtimeModule.strandedInputFailure(session), null, 'CHECKPOINT: a fresh instance writes normally');
  session.sessionEpoch = 'epoch-A';
  assert.ok(runtimeModule.strandedComposer(session), 'CHECKPOINT: and the old instance is still stranded — nothing was cleared');
});

// ── Part 5: concurrency, ordering and the remaining closed-shape refusals ───────────────────────────────────────

test('B1270G concurrency: two bound requests each keep their own body→own CR pair, in arrival order', { timeout: 30000 }, async () => {
  const sid = 'b1270g-concurrent';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const ws = session.ownerWs;
  const waitsBefore = H.gateCalls.length;
  // Issued without awaiting the first: the second must not slip its body between the first body and its CR.
  const first = post(sid, boundRequest(session, 'B1270G-CONCURRENT one'));
  const second = post(sid, boundRequest(session, 'B1270G-CONCURRENT two'));
  const [a, b] = await Promise.all([first, second]);
  await sleep(1000);   // a retry/redeliver loop would add another frame inside this window
  assert.deepEqual([a.body.stage, b.body.stage], ['accepted', 'accepted'], `CHECKPOINT: both accepted ${JSON.stringify([a.body, b.body])}`);
  assert.notEqual(a.body.inject_id, b.body.inject_id, 'PRECONDITION: two distinct injects');
  const frames = injects(ws);
  assert.deepEqual(frames.map(f => f.part), ['body', 'submit', 'body', 'submit'],
    `CHECKPOINT: strict body→CR alternation, never body body CR CR ${JSON.stringify(frames.map(f => f.part))}`);
  assert.deepEqual(frames.map(f => f.inject_id), [a.body.inject_id, a.body.inject_id, b.body.inject_id, b.body.inject_id],
    'CHECKPOINT: the first pair completes before the second begins');
  assert.equal(frames[1].pair, frames[0].daemon_msg_id, 'CHECKPOINT: each CR names its OWN body as pair');
  assert.equal(frames[3].pair, frames[2].daemon_msg_id, 'CHECKPOINT: ...and so does the second');
  assert.notEqual(frames[0].daemon_msg_id, frames[2].daemon_msg_id, 'CHECKPOINT: the two bodies are distinct frames');
  assert.deepEqual(new Set(frames.map(f => f.owner_generation)), new Set([session.interactionOwnerGeneration]),
    'CHECKPOINT: all four frames carry the one current owner generation');
  assert.deepEqual(H.gateCalls.slice(waitsBefore).filter(n => WAITS.includes(n)), [],
    'CHECKPOINT: no prompt-symbol/REPL/settle/confirm/consumption wait on the busy path');
  assert.equal(H.pendingReports[sid], undefined, 'CHECKPOINT: the bound route creates no pending-report record');
});

test('B1270G non-wrapped and unknown targets are refused in the closed shape with zero bytes', { timeout: 30000 }, async () => {
  const unknown = await post('b1270g-no-such-session', { schema: 'telepty.bound-inject/v1', prompt: 'p', from: 'f',
    expected_epoch: 'E', expected_owner_generation: 'G', require: [...REQUIRE] });
  assert.equal(unknown.status, 404, 'CHECKPOINT: an unknown id is 404');
  assertResultShape(unknown.body, 'b1270g-no-such-session');
  assert.deepEqual({ stage: unknown.body.stage, reason: unknown.body.reason, epoch: unknown.body.session_epoch, bytes: unknown.body.bytes_written },
    { stage: 'refused', reason: 'session_not_found', epoch: null, bytes: 0 }, JSON.stringify(unknown.body));

  // A spawned (non-wrapped) record: there is no owner bridge to hand frames to, so the capability is not applicable.
  const sid = 'b1270g-spawned';
  const epoch = crypto.randomUUID();
  H.sessions[sid] = { id: sid, type: 'spawned', command: 'claude', clients: new Set(), ownerWs: null,
    sessionEpoch: epoch, sessionEpochProved: epoch, interactionOwnerGeneration: crypto.randomUUID(),
    outputRing: [], outputRingTotalBytes: 0, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  const spawned = await post(sid, { schema: 'telepty.bound-inject/v1', prompt: 'p', from: 'f', expected_epoch: epoch,
    expected_owner_generation: H.sessions[sid].interactionOwnerGeneration, require: [...REQUIRE] });
  assertResultShape(spawned.body, sid);
  assert.deepEqual({ status: spawned.status >= 400 && spawned.status < 500, stage: spawned.body.stage,
    reason: spawned.body.reason, bytes: spawned.body.bytes_written },
  { status: true, stage: 'refused', reason: 'transport_not_applicable', bytes: 0 }, JSON.stringify(spawned.body));
  assert.equal(H.runtime.buildSessionTransportBlock(H.sessions[sid]).busy_input, 'not_applicable',
    'CHECKPOINT: the view says not_applicable for a record with no owner bridge');
  delete H.sessions[sid];
});

// ── Part 6: the r1 review findings, each as its own decisive case ────────────────────────────────────────────────
//
// Added for the independent review's REJECT (2 blockers, 8 majors, 8 minors). Every case below drives REAL
// production code — the exported viewer gate, the real route, the real persistence serializer, the real audit
// seam — and asserts the property the finding named, not the implementation's shape.

// B1270R-B1 (blocker): the viewer input adapter is a FOURTH input producer. It reaches the owner socket (wrapped)
// or the PTY (spawned) directly, bypassing writeDataToSession and submitViaPty, so an attached operator pressing
// Enter on a quiet session would have submitted an earlier delivery's unsubmitted text.
test('B1270R B1 viewer input: both adapter arms refuse a stranded composer, and nothing reaches the socket or the PTY', () => {
  const sid = 'b1270g-viewer';
  const session = H.registerSession(sid);
  const ownerWs = session.ownerWs;
  const before = injects(ownerWs).length;
  assert.equal(typeof wsTransport.viewerInputDeliverer(session), 'function',
    'PRECONDITION: a healthy wrapped session has a viewer write adapter');

  runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  assert.equal(wsTransport.viewerInputDeliverer(session), null,
    'CHECKPOINT: the WRAPPED arm hands back no writer for a stranded composer');
  assert.equal(injects(ownerWs).length, before, 'CHECKPOINT: no viewer frame reached the pinned owner');

  // The spawned twin: the same ONE gate, so neither arm can be fixed without the other.
  const wrote = [];
  const spawned = { id: 'b1270g-viewer-spawned', type: 'spawned', sessionEpoch: 'viewer-epoch',
    clients: new Set(), ptyProcess: { write: data => wrote.push(data) } };
  const writer = wsTransport.viewerInputDeliverer(spawned);
  assert.equal(typeof writer, 'function', 'PRECONDITION: a spawned session with a live PTY has one too');
  let completed = false;
  writer('\r', () => { completed = true; });
  assert.deepEqual([wrote, completed], [['\r'], true], 'PRECONDITION: that adapter really writes to the PTY');

  runtimeModule.strandComposer(spawned, { epoch: 'viewer-epoch', injectId: crypto.randomUUID(), reason: 'cr_outcome_unknown' });
  assert.equal(wsTransport.viewerInputDeliverer(spawned), null, 'CHECKPOINT: the SPAWNED arm refuses the same way');
  assert.deepEqual(wrote, ['\r'], 'CHECKPOINT: not one further byte reached the PTY');

  // Keyed on the instance, here too: a new epoch is a new child and a new composer.
  spawned.sessionEpoch = 'viewer-epoch-2';
  assert.equal(typeof wsTransport.viewerInputDeliverer(spawned), 'function',
    'CHECKPOINT: a NEW instance is never blocked by the old strand');
});

// B1270R-B2 (blocker): the #533 peer-lane hard block applies to this door too — `from` is policy-checked, not
// merely schema-validated, so a credential blocked from raw peer→peer delegation on /inject is blocked here.
test('B1270R B2 peer lane: an off-policy peer→peer bound inject is blocked 403 before any effect; the orchestrator lane and a sanctioned envelope still deliver', { timeout: 30000 }, async () => {
  const sid = 'b1270g-peer';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const ws = session.ownerWs;
  H.orchestratorSids.push('orchestrator');   // configured, so the guardrail is ACTIVE rather than fail-open
  try {
    const auditAt = H.auditLines.length;
    const blocked = await post(sid, boundRequest(session, 'please do my work for me', { from: 'peer-a' }));
    assert.equal(blocked.status, 403, `CHECKPOINT: a blocked peer-lane bound inject is 403 (${blocked.status})`);
    assertResultShape(blocked.body, sid);
    assert.deepEqual({ stage: blocked.body.stage, reason: blocked.body.reason, bytes: blocked.body.bytes_written,
      inject: blocked.body.inject_id },
    { stage: 'refused', reason: 'peer_inject_blocked', bytes: 0, inject: null },
    `CHECKPOINT: refused with a provable zero ${JSON.stringify(blocked.body)}`);
    assert.equal(injects(ws).length, 0, 'CHECKPOINT: zero frames — the block is before any effect');
    const blockedLines = H.auditLines.slice(auditAt);
    assert.equal(blockedLines.length, 1, `CHECKPOINT: exactly one audit line for the blocked attempt ${JSON.stringify(blockedLines)}`);
    assert.deepEqual({ source: blockedLines[0].source, from: blockedLines[0].claimed_from, to: blockedLines[0].to,
      result: blockedLines[0].delivery_result },
    { source: 'inject-bound-v1', from: 'peer-a', to: sid, result: 'blocked:malformed-envelope' },
    `CHECKPOINT: the blocked attempt is auditable with the legacy vocabulary ${JSON.stringify(blockedLines[0])}`);

    // Control 1: the orchestrator lane is untouched.
    const orch = await post(sid, boundRequest(session, 'orchestrator dispatch', { from: 'orchestrator' }));
    assert.equal(orch.body.stage, 'accepted', `CHECKPOINT: the orchestrator lane still delivers ${JSON.stringify(orch.body)}`);

    // Control 2: a sanctioned peer envelope is allowed, so this is the #533 verdict and not a blanket peer ban.
    const envelope = JSON.stringify({ kind: 'ask-request', from: 'peer-a', to: sid, thread_id: 'b1270-thread', round: 1,
      question: 'is the bound transport policy-checked?' });
    const sanctioned = await post(sid, boundRequest(session, envelope, { from: 'peer-a' }));
    assert.equal(sanctioned.body.stage, 'accepted', `CHECKPOINT: a sanctioned ask-request is delivered ${JSON.stringify(sanctioned.body)}`);
    assert.deepEqual(injects(ws).map(f => f.part), ['body', 'submit', 'body', 'submit'],
      'CHECKPOINT: only the two allowed requests produced frames, each a body and its own CR');
  } finally {
    H.orchestratorSids.length = 0;
  }
});

// B1270R-M1 (major): one audit line per terminal outcome, in the EXISTING record shape, with the honest word for
// a frame handed to the owner bridge — `forwarded`, never `success` (which in this log means bytes measured).
test('B1270R M1 audit: an accepted and a refused bound delivery each write exactly one line, naming this door', { timeout: 30000 }, async () => {
  const sid = 'b1270g-audit';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);

  const acceptedAt = H.auditLines.length;
  const accepted = await post(sid, boundRequest(session, 'B1270R-AUDIT body', { from: 'audited-sender' }));
  assert.equal(accepted.body.stage, 'accepted', `PRECONDITION: accepted ${JSON.stringify(accepted.body)}`);
  const acceptedLines = H.auditLines.slice(acceptedAt);
  assert.equal(acceptedLines.length, 1, `CHECKPOINT: exactly one line per delivery ${JSON.stringify(acceptedLines)}`);
  assert.deepEqual({ kind: acceptedLines[0].kind, source: acceptedLines[0].source, from: acceptedLines[0].claimed_from,
    to: acceptedLines[0].to, result: acceptedLines[0].delivery_result, payload: acceptedLines[0].payload,
    inject: acceptedLines[0].inject_id === accepted.body.inject_id, verified: acceptedLines[0].verified_sender_sid },
  { kind: 'inject', source: 'inject-bound-v1', from: 'audited-sender', to: sid, result: 'forwarded',
    payload: 'B1270R-AUDIT body', inject: true, verified: null },
  `CHECKPOINT: the accepted line is the existing shape, says forwarded (not success) and carries no unverified sender claim ${JSON.stringify(acceptedLines[0])}`);

  // r3 (finding RR-m2): a ROUTE refusal writes NO audit line, which is what the legacy /inject route does — it
  // audits the #533 block and the terminal delivery outcomes, and a legacy 404/400 leaves no record. The r1
  // behaviour (a full-prompt line for every refusal, including ids that do not exist) was audit amplification
  // from an authenticated caller. Asserted as zero lines, which is stricter than the assertion it replaces.
  const refusedAt = H.auditLines.length;
  const refused = await post(sid, boundRequest(session, 'B1270R-AUDIT refused', { expected_epoch: crypto.randomUUID() }));
  assert.equal(refused.body.stage, 'refused', `PRECONDITION: refused ${JSON.stringify(refused.body)}`);
  assert.deepEqual(H.auditLines.slice(refusedAt), [],
    'CHECKPOINT: a pre-delivery route refusal appends NOTHING to the inject log, exactly as /inject does');

  const unknownAt = H.auditLines.length;
  const missing = await post('b1270g-audit-no-such-session', boundRequest(session, 'B1270R-AUDIT unknown target'));
  assert.equal(missing.status, 404, `PRECONDITION: unknown id is 404 ${JSON.stringify(missing.body)}`);
  assert.deepEqual(H.auditLines.slice(unknownAt), [],
    'CHECKPOINT: and a request naming a session that does not exist writes no full-prompt record either');
});

// B1270R-M2 (major): a provenance-capable session was promised a nonce-gated banner on injected text. A bound
// body is injected text, and the banner is applied BEFORE the paste framing exactly as on the legacy path.
test('B1270R M2 provenance: a capable session gets the nonce-gated banner on the bound body; a default session gets byte-exact text', { timeout: 30000 }, async () => {
  const sid = 'b1270g-provenance';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  session.provenanceCapable = true;
  session.provenanceNonce = 'B1270RNONCE';
  const capable = await post(sid, boundRequest(session, 'B1270R-PROV body', { from: 'prov-sender' }));
  assert.equal(capable.body.stage, 'accepted', `PRECONDITION: accepted ${JSON.stringify(capable.body)}`);
  const frames = injects(session.ownerWs);
  assert.deepEqual(frames.map(f => f.part), ['body', 'submit'], 'PRECONDITION: one body and its CR');
  assert.ok(frames[0].data.includes('⟦telepty:provenance v=1 from=claimed:prov-sender? origin=trusted-local nonce=B1270RNONCE⟧'),
    `CHECKPOINT: the banner names the claimed (unverified) sender and the minted nonce ${JSON.stringify(frames[0].data)}`);
  assert.ok(frames[0].data.includes('⟦telepty:end nonce=B1270RNONCE⟧'), 'CHECKPOINT: and it is fenced at both ends');
  assert.ok(frames[0].data.includes('B1270R-PROV body'), 'CHECKPOINT: the payload itself is carried byte-for-byte inside the fence');
  assert.equal(frames[1].data, '\r', 'CHECKPOINT: the CR is still a bare Enter, outside any banner or paste envelope');

  // Default-OFF regression guard: a session that never registered the capability receives exactly what it did before.
  const plainSid = 'b1270g-provenance-off';
  const plain = H.registerSession(plainSid);
  H.sessionStateManager.feed(plainSid, WORKING);
  const off = await post(plainSid, boundRequest(plain, 'B1270R-PROV plain', { from: 'prov-sender' }));
  assert.equal(off.body.stage, 'accepted', `PRECONDITION: accepted ${JSON.stringify(off.body)}`);
  const plainFrames = injects(plain.ownerWs);
  assert.ok(!plainFrames[0].data.includes('telepty:provenance'),
    `CHECKPOINT: no banner for a non-capable session ${JSON.stringify(plainFrames[0].data)}`);
});

// B1270R-M5 (major): a THROW after the body was handed is the same hazard as a refused CR. The three explicit
// strand branches could not see it, so the composer stayed open to every later append and Enter.
test('B1270R M5 throw after the body: the identity is stranded on the way out and the answer is an honest unknown', { timeout: 30000 }, async () => {
  const sid = 'b1270g-throw';
  // The socket stops being writable by THROWING, not by changing state: the exception leaves the delivery.
  const session = H.registerSession(sid, { onSend: (ws, frame) => {
    if (frame.part === 'body') ws.send = () => { throw new Error('owner socket went away mid-pair'); };
  } });
  H.sessionStateManager.feed(sid, WORKING);
  const auditAt = H.auditLines.length;
  const response = await post(sid, boundRequest(session, 'B1270R-THROW body'));
  assertResultShape(response.body, sid);
  assert.ok(response.status >= 500, `CHECKPOINT: a throw after a handed body is not a 4xx refusal (${response.status})`);
  assert.deepEqual({ stage: response.body.stage, reason: response.body.reason, bytes: response.body.bytes_written },
    { stage: 'outcome_unknown', reason: 'delivery_threw', bytes: null },
    `CHECKPOINT: unknown, never zero bytes and never accepted ${JSON.stringify(response.body)}`);
  const strand = runtimeModule.strandedComposer(session);
  assert.ok(strand, 'CHECKPOINT: the exact identity IS stranded even though no branch returned');
  assert.deepEqual({ reason: strand.reason, epoch: strand.epoch === session.sessionEpoch, inject: strand.inject_id === response.body.inject_id },
    { reason: 'delivery_threw_after_body', epoch: true, inject: true },
    `CHECKPOINT: the strand names the throw and the exact instance ${JSON.stringify(strand)}`);
  assert.equal(H.runtime.submitViaPty(session), false, 'CHECKPOINT: every later bare CR is refused for that instance');
  const lines = H.auditLines.slice(auditAt);
  assert.deepEqual(lines.map(l => l.delivery_result), ['outcome_unknown:delivery_threw'],
    `CHECKPOINT: one honest audit line for the unknown outcome ${JSON.stringify(lines)}`);
  assert.equal(session.pendingSubmit, null, 'CHECKPOINT: the submit barrier was released despite the throw');
});

// B1270R-M6 (major): the post-await recheck covered identity only. A modal, a bootstrap drain, an unwired input
// transport or a stale session during the barrier wait still got the body and its Enter.
test('B1270R M6 admission at the await: a state change while the request waits refuses it, and one after the body withholds the CR', { timeout: 30000 }, async () => {
  const sid = 'b1270g-admission';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const ws = session.ownerWs;

  // The one predicate, shared by the route and the delivery — the route's refusal proves which one it is.
  session.bootstrapDraining = true;
  assert.equal(H.runtime.boundAdmissionRefusal(session), 'bootstrap_backlog', 'PRECONDITION: the predicate names the gate');
  const upfront = await post(sid, boundRequest(session, 'B1270R-ADMISSION upfront'));
  assert.deepEqual({ status: upfront.status, stage: upfront.body.stage, reason: upfront.body.reason, bytes: upfront.body.bytes_written },
    { status: 409, stage: 'refused', reason: 'bootstrap_backlog', bytes: 0 }, JSON.stringify(upfront.body));
  session.bootstrapDraining = false;
  assert.equal(H.runtime.boundAdmissionRefusal(session), null, 'PRECONDITION: admissible again');

  // DURING the barrier wait: the gate is re-read after the await, not taken from the route's snapshot.
  let release;
  session.pendingSubmit = new Promise(resolve => { release = () => { session.pendingSubmit = null; resolve(); }; });
  const waiting = post(sid, boundRequest(session, 'B1270R-ADMISSION during the wait'));
  await sleep(50);
  session.bootstrapDraining = true;
  release();
  const waited = await waiting;
  assert.deepEqual({ stage: waited.body.stage, reason: waited.body.reason, bytes: waited.body.bytes_written },
    { stage: 'refused', reason: 'bootstrap_backlog', bytes: 0 },
    `CHECKPOINT: a gate that closed during the wait refuses with a provable zero ${JSON.stringify(waited.body)}`);
  assert.equal(injects(ws).length, 0, 'CHECKPOINT: nothing was written for either refusal');
  session.bootstrapDraining = false;

  // AFTER the body is handed: the Enter is withheld (#737's rule) and, because the text exists, that is a strand.
  const afterSid = 'b1270g-admission-after';
  const hook = { session: null };
  const after = H.registerSession(afterSid, { onSend: (socket, frame) => {
    if (frame.part === 'body' && hook.session) hook.session.bootstrapDraining = true;
  } });
  hook.session = after;
  H.sessionStateManager.feed(afterSid, WORKING);
  const response = await post(afterSid, boundRequest(after, 'B1270R-ADMISSION after the body'));
  assert.deepEqual({ stage: response.body.stage, reason: response.body.reason, body: response.body.body_stage,
    submit: response.body.submit_stage, bytes: response.body.bytes_written },
  { stage: 'outcome_unknown', reason: 'admission_changed_after_body', body: 'sent_to_bridge', submit: 'not_sent', bytes: null },
  `CHECKPOINT: the body stays reported as handed and the CR is withheld, never claimed ${JSON.stringify(response.body)}`);
  assert.deepEqual(injects(after.ownerWs).map(f => f.part), ['body'], 'CHECKPOINT: exactly one frame — no Enter into a changed surface');
  assert.ok(runtimeModule.strandedComposer(after), 'CHECKPOINT: the unsubmitted text is stranded, not left open to the next writer');
});

// B1270R-M7 (major): the strand was in memory while the epoch it keys on was persisted, so a restart silently
// un-stranded the same instance while the bridge went on quarantining every delivery to it.
test('B1270R M7 durability: the strand serializes with its epoch and restores onto the same instance; a tampered or epoch-less record is dropped', () => {
  const epoch = crypto.randomUUID();
  const injectId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const record = { id: 'b1270g-persisted', type: 'wrapped', command: 'claude', cwd: '/tmp/b1270',
    sessionEpoch: epoch, credentialVerifier: 'opaque-verifier', credentialGeneration: 1,
    createdAt: nowIso, lastActivityAt: nowIso, clients: new Set() };
  runtimeModule.strandComposer(record, { epoch, injectId, reason: 'submit_outcome_unknown' });

  const serialized = persistence.serializePersistedSessions({ [record.id]: record });
  const meta = serialized[record.id];
  assert.deepEqual(meta.strandedComposer, { epoch, inject_id: injectId, reason: 'submit_outcome_unknown', at: record.strandedComposer.at },
    `CHECKPOINT: exactly the four bounded fields are written, with the epoch they key on ${JSON.stringify(meta.strandedComposer)}`);
  assert.equal(meta.sessionEpoch, epoch, 'PRECONDITION: the epoch itself is persisted, which is why the strand must be');

  const restored = persistence.buildRestoredWrappedSession(record.id, meta);
  assert.ok(runtimeModule.strandedComposer(restored),
    'CHECKPOINT: the restored instance is still stranded — a restart cannot un-strand a composer that holds text');
  assert.equal(runtimeModule.strandedInputFailure(restored).code, 'COMPOSER_STRANDED', 'CHECKPOINT: and every input path refuses it');

  // A hand-edited record naming a DIFFERENT epoch is dropped, so an edited file cannot block another instance.
  const tampered = { ...meta, strandedComposer: { ...meta.strandedComposer, epoch: crypto.randomUUID() } };
  assert.equal(persistence.buildRestoredWrappedSession(record.id, tampered).strandedComposer, undefined,
    'CHECKPOINT: a strand that does not name the restored epoch is not adopted');
  // Free text in a stored reason cannot travel either.
  const dirty = { ...meta, strandedComposer: { ...meta.strandedComposer, reason: '/Users/me/secret.txt: ENOENT' } };
  assert.equal(persistence.buildRestoredWrappedSession(record.id, dirty).strandedComposer.reason, 'refused',
    'CHECKPOINT: a reason outside the allow-list degrades to the generic code');
  // No credential verifier → no epoch is persisted → there is nothing for a strand to key on.
  const credentialless = { ...record, credentialVerifier: undefined };
  const withoutEpoch = persistence.serializePersistedSessions({ [record.id]: credentialless })[record.id];
  assert.deepEqual([withoutEpoch.sessionEpoch, withoutEpoch.strandedComposer], [undefined, undefined],
    'CHECKPOINT: both-or-neither — a strand is never written without the epoch it belongs to');
});

// B1270R-M8(a) (major): make the refusal VISIBLE. Without this an operator sees a live, healthy, connected
// session that silently refuses every input. Read-only: there is no clear, force, timeout or recovery anywhere.
test('B1270R M8a view: the transport block shows the strand next to busy_input, and is byte-identical to the pre-1270 shape when nothing is stranded', () => {
  const sid = 'b1270g-view-strand';
  const session = H.registerSession(sid);
  // r3 (finding RR-m1, Root decision: the key stays, but strictly additive). It is emitted CONDITIONALLY, so a
  // session that is not stranded carries no new key at all — the strongest form of neutrality for an existing
  // reader, and this file's own convention for a fact that does not apply (cf. `lease_expires_at`).
  const clearView = H.runtime.buildSessionTransportBlock(session);
  assert.equal(Object.hasOwn(clearView, 'stranded_composer'), false,
    `CHECKPOINT: no stranded_composer key for a session that is not stranded ${JSON.stringify(Object.keys(clearView))}`);
  assert.equal(clearView.stranded_composer, undefined, 'CHECKPOINT: and it reads falsy-absent, never a false-ish object');
  const injectId = crypto.randomUUID();
  runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId, reason: 'submit_outcome_unknown' });
  const view = H.runtime.buildSessionTransportBlock(session);
  assert.deepEqual({ stranded: view.stranded_composer.stranded, inject_id: view.stranded_composer.inject_id,
    reason: view.stranded_composer.reason, at: typeof view.stranded_composer.at },
  { stranded: true, inject_id: injectId, reason: 'submit_outcome_unknown', at: 'string' },
  `CHECKPOINT: an operator can see WHY the session refuses ${JSON.stringify(view.stranded_composer)}`);
  assert.equal(view.busy_input, 'supported', 'CHECKPOINT: the capability view is unchanged by the strand — they are different facts');
});

// B1270R-m7 (minor): the barrier ahead can end in two non-normal ways. Neither may become an outcome_unknown the
// caller must hold for ever, because nothing of this request was handed to anyone.
test('B1270R m7 barrier: a rejected and a settled-but-unreleased barrier are refusals with a provable zero, not unknowns', { timeout: 30000 }, async () => {
  const sid = 'b1270g-barrier';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const ws = session.ownerWs;

  const rejected = Promise.reject(new Error('the holder ahead failed'));
  rejected.catch(() => {});   // the test's own handler; the delivery attaches its own
  session.pendingSubmit = rejected;
  const afterReject = await post(sid, boundRequest(session, 'B1270R-BARRIER rejected'));
  assertResultShape(afterReject.body, sid);
  assert.deepEqual({ status: afterReject.status, stage: afterReject.body.stage, reason: afterReject.body.reason,
    bytes: afterReject.body.bytes_written },
  { status: 409, stage: 'refused', reason: 'submit_barrier_rejected', bytes: 0 }, JSON.stringify(afterReject.body));

  // Settled but never released: refused instead of re-awaited, so the wait cannot spin on a dead promise.
  session.pendingSubmit = Promise.resolve();
  const started = Date.now();
  const afterStale = await post(sid, boundRequest(session, 'B1270R-BARRIER stale'));
  const elapsedMs = Date.now() - started;
  assert.deepEqual({ stage: afterStale.body.stage, reason: afterStale.body.reason, bytes: afterStale.body.bytes_written },
    { stage: 'refused', reason: 'submit_barrier_busy', bytes: 0 }, JSON.stringify(afterStale.body));
  assert.ok(elapsedMs < 1000, `CHECKPOINT: answered at once rather than spinning to the barrier deadline (${elapsedMs} ms)`);
  assert.equal(injects(ws).length, 0, 'CHECKPOINT: neither case wrote anything');

  session.pendingSubmit = null;
  const control = await post(sid, boundRequest(session, 'B1270R-BARRIER control'));
  assert.equal(control.body.stage, 'accepted', `CHECKPOINT: a released barrier still delivers ${JSON.stringify(control.body)}`);
});

// B1270R-m2 / m3 (minors): the bounded reason field is an ALLOW-LIST, and the token bound is measured in bytes.
test('B1270R m2/m3 bounded fields: a reason outside the allow-list degrades to `refused`, and a token bound in bytes', () => {
  assert.equal(boundInject.boundedReason('ENOENT: no such file or directory, open /Users/me/secret.txt'), 'refused',
    'CHECKPOINT: an exception message cannot become a 64-character reason code');
  assert.equal(boundInject.boundedReason('Session epoch 3f2ad963 of /home/op/.telepty/config.json'), 'refused',
    'CHECKPOINT: nor can a path or an identifier fragment');
  assert.equal(boundInject.boundedReason('STALE'), 'stale', 'CHECKPOINT: the real shared codes still travel, lowercased');
  assert.equal(boundInject.boundedReason('claude_modal_ui'), 'claude_modal_ui', 'CHECKPOINT: and the modal gate keeps its own CLI-keyed reason');
  assert.equal(boundInject.boundedReason('codex_modal_ui'), 'codex_modal_ui', 'CHECKPOINT: for any registry CLI key');
  assert.equal(boundInject.boundedReason(null), null, 'CHECKPOINT: an accepted delivery still has no reason at all');

  assert.equal(boundInject.boundedToken('a'.repeat(256)), true, 'PRECONDITION: 256 bytes is the bound');
  assert.equal(boundInject.boundedToken('a'.repeat(257)), false, 'CHECKPOINT: one byte over is refused');
  assert.equal(boundInject.boundedToken('あ'.repeat(100)), false,
    'CHECKPOINT: 100 multi-byte characters are 300 bytes and are refused — the bound is bytes, as the name says');
  assert.equal(boundInject.boundedToken('あ'.repeat(80)), true, 'CHECKPOINT: 240 bytes of the same characters are fine');
});

// B1270R-M3 (major, Root decision): strict principal mode has no action for this path, so the route is
// fail-closed there. Asserted rather than assumed, because the decision is to SHIP it that way.
test('B1270R M3 strict principal mode: the bound path resolves to no action, so strict mode denies it (documented unsupported configuration)', () => {
  assert.deepEqual(principalHttp.resolveAction({ method: 'POST', url: '/api/sessions/b1270/inject' }),
    { action: 'session.inject', target: 'b1270', explicitInject: true },
    'PRECONDITION: the legacy inject path IS a known strict-mode action');
  assert.equal(principalHttp.resolveAction({ method: 'POST', url: '/api/sessions/b1270/inject-bound-v1' }), null,
    'CHECKPOINT: the bound path resolves to no action — PRINCIPAL_ACTION_DENIED, never an unchecked write');
});

// ── Part 7: the last Enter producer — the osascript/AppleScript submit arm (r2, finding m5) ─────────────────────
//
// `submitViaOsascript` does not write bytes: it raises a GUI window and presses Return (`key code 36`). So it
// reaches neither `writeDataToSession` nor `submitViaPty`, which is why the strand boundary missed it. Both
// cases below drive the REAL production context (`createSessionInspectionContext`) with the real
// `submitViaPty`, and both FAIL without the guard — the proof is that the injected `execFileSync` seam is never
// called, i.e. no AppleScript process is spawned and no key is pressed.
function inspectionContext(sessions, execFileSync) {
  const { createSessionInspectionContext } = load('src/routes/session-inspection.js');
  // SUBMIT_STRATEGIES is the daemon's own map; the shipped default has no `osascript_cmd_enter` entry at all, so
  // this fixture supplies one deliberately — the guard has to hold for ANY configuration that enables that arm.
  return createSessionInspectionContext({
    sessions,
    submitViaPty: H.runtime.submitViaPty,
    SUBMIT_STRATEGIES: { claude: 'pty_cr', stable: 'osascript_cmd_enter' },
  }, { execFileSync });
}

test('B1270R m5 osascript arm: a stranded composer gets no Return keystroke, and a new instance does', () => {
  const sid = 'b1270g-osascript';
  const session = { id: sid, type: 'wrapped', command: 'stable', cwd: '/tmp/b1270-project',
    sessionEpoch: 'osa-epoch-1', clients: new Set(), ownerWs: { readyState: 1, frames: [], send() {} } };
  const sessions = Object.create(null);
  sessions[sid] = session;
  const calls = [];
  const { submitViaOsascript } = inspectionContext(sessions, (file, args) => {
    calls.push({ file, args }); return Buffer.from('ok:window');
  });

  assert.equal(submitViaOsascript(sid, 'cmd_enter'), true, 'PRECONDITION: a healthy session does get its keystroke');
  assert.equal(calls.length, 1, 'PRECONDITION: exactly one osascript invocation');
  assert.equal(calls[0].file, 'osascript');
  assert.match(calls[0].args[1], /key code 36 using command down/, 'PRECONDITION: that invocation really presses Return');

  runtimeModule.strandComposer(session, { epoch: 'osa-epoch-1', injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  assert.equal(submitViaOsascript(sid, 'cmd_enter'), false, 'CHECKPOINT: refused for a stranded composer');
  assert.equal(calls.length, 1, 'CHECKPOINT: NO osascript process was spawned — the Return was never pressed');

  // Keyed on the instance here too: a new epoch is a new composer and must not inherit the refusal.
  session.sessionEpoch = 'osa-epoch-2';
  assert.equal(submitViaOsascript(sid, 'cmd_enter'), true, 'CHECKPOINT: a NEW instance submits normally');
  assert.equal(calls.length, 2, 'CHECKPOINT: and that one did spawn its keystroke');
});

test('B1270R m5 submit-all: a batch submit skips every stranded identity with the shared failure, on BOTH strategies', { timeout: 30000 }, async () => {
  // A real wrapped session that is stranded (pty_cr strategy), a GUI-strategy record that is stranded, and a
  // healthy wrapped session as the control. One batch, one pass.
  const strandedPty = H.registerSession('b1270g-submitall-stranded');
  const healthy = H.registerSession('b1270g-submitall-ok');
  H.sessionStateManager.feed('b1270g-submitall-ok', WORKING);
  runtimeModule.strandComposer(strandedPty, { epoch: strandedPty.sessionEpoch, injectId: crypto.randomUUID(),
    reason: 'submit_outcome_unknown' });
  const osaId = 'b1270g-submitall-osa';
  const osa = { id: osaId, type: 'wrapped', command: 'stable', cwd: '/tmp/b1270-project',
    sessionEpoch: 'osa-batch-epoch', clients: new Set(), ownerWs: { readyState: 1, frames: [], send() {} } };
  runtimeModule.strandComposer(osa, { epoch: 'osa-batch-epoch', injectId: crypto.randomUUID(), reason: 'cr_outcome_unknown' });

  const sessions = Object.create(null);
  sessions[strandedPty.id] = strandedPty;
  sessions[healthy.id] = healthy;
  sessions[osaId] = osa;
  const calls = [];
  const { runSubmitAll } = inspectionContext(sessions, (file, args) => { calls.push({ file, args }); return Buffer.from('ok:window'); });

  const before = { stranded: injects(strandedPty.ownerWs).length, healthy: injects(healthy.ownerWs).length };
  const results = runSubmitAll(sessions);

  assert.deepEqual(results.successful.map(r => r.id), [healthy.id],
    `CHECKPOINT: only the healthy session was submitted ${JSON.stringify(results)}`);
  assert.deepEqual(results.failed.map(f => [f.id, f.strategy, f.code]).sort(),
    [[osaId, 'osascript_cmd_enter', 'COMPOSER_STRANDED'], [strandedPty.id, 'pty_cr', 'COMPOSER_STRANDED']].sort(),
    `CHECKPOINT: both stranded identities are refused with the SHARED failure code, not a generic "Submit failed" ${JSON.stringify(results.failed)}`);
  assert.deepEqual(calls, [], 'CHECKPOINT: the osascript arm never ran at all — no window raised, no key pressed');
  assert.equal(injects(strandedPty.ownerWs).length, before.stranded,
    'CHECKPOINT: not one CR reached the stranded owner socket');
  const healthyFrames = injects(healthy.ownerWs).slice(before.healthy);
  assert.deepEqual(healthyFrames.map(f => f.data), ['\r'],
    `CHECKPOINT: the control session still got exactly its one bare CR ${JSON.stringify(healthyFrames)}`);
});

// ── Part 8: the independent RE-REVIEW's findings (r3) ───────────────────────────────────────────────────────────
//
// A second reviewer, who wrote neither the code nor the first review, returned 0 blockers / 3 majors / 12 minors.
// One case per fix below, each driving real production code and each failing without its fix.

// RR-M1 (major): first-review M5 covered a throw at the CR only. A throw from the BODY write itself unwinds with
// `bodyHanded` still false — including from `armUpstreamProbe`, which runs AFTER the frame is handed — so the
// composer was left open to every later producer. The ATTEMPT is now marked, not just the success.
test('B1270RR M1 throw DURING the body: the attempt alone strands the identity, with its own reason', { timeout: 30000 }, async () => {
  const sid = 'b1270g-throw-during';
  // The socket throws on the BODY frame itself (not on the next one), so the exception leaves writeDataToSession
  // with the body's fate unknown: it may have reached the socket, or not.
  const session = H.registerSession(sid, { onSend: (ws, frame) => {
    if (frame.part === 'body') throw new Error('owner socket threw while handing the body');
  } });
  H.sessionStateManager.feed(sid, WORKING);
  const response = await post(sid, boundRequest(session, 'B1270RR-THROW-DURING body'));
  assertResultShape(response.body, sid);
  assert.ok(response.status >= 500, `CHECKPOINT: an unknown outcome is not a 4xx refusal (${response.status})`);
  assert.deepEqual({ stage: response.body.stage, reason: response.body.reason, bytes: response.body.bytes_written },
    { stage: 'outcome_unknown', reason: 'delivery_threw', bytes: null },
    `CHECKPOINT: unknown, never zero bytes ${JSON.stringify(response.body)}`);
  const strand = runtimeModule.strandedComposer(session);
  assert.ok(strand, 'CHECKPOINT: the identity IS stranded on the attempt alone — this is what RR-M1 found missing');
  assert.deepEqual({ reason: strand.reason, epoch: strand.epoch === session.sessionEpoch, inject: strand.inject_id === response.body.inject_id },
    { reason: 'delivery_threw_during_body', epoch: true, inject: true },
    `CHECKPOINT: the reason distinguishes an attempted body from a handed one ${JSON.stringify(strand)}`);
  assert.ok(/^[a-z0-9_]{1,64}$/.test(boundInject.boundedReason(strand.reason)) && boundInject.boundedReason(strand.reason) === 'delivery_threw_during_body',
    'CHECKPOINT: the new reason is in the closed allow-list, so it travels instead of degrading to `refused`');
  assert.equal(H.runtime.submitViaPty(session), false, 'CHECKPOINT: every later bare CR is refused for that instance');
  assert.equal(session.pendingSubmit, null, 'CHECKPOINT: the submit barrier was released despite the throw');
  // And a pre-send refusal is still NOT a strand: a provable zero stays a provable zero.
  const cleanSid = 'b1270g-throw-during-clean';
  const clean = H.registerSession(cleanSid, { header: 'input-transport-ready-v1, immediate-submit-v1' });
  const refused = await post(cleanSid, boundRequest(clean, 'B1270RR-THROW-DURING refused before any attempt'));
  assert.deepEqual({ stage: refused.body.stage, bytes: refused.body.bytes_written, stranded: !!runtimeModule.strandedComposer(clean) },
    { stage: 'refused', bytes: 0, stranded: false },
    `CHECKPOINT: a refusal before the attempt marker strands nothing ${JSON.stringify(refused.body)}`);
});

// RR-M2 (major): dispatchInteraction becomes child.write(bytes) in the bridge, and KEYS.enter is '\r'. It is
// neither writeDataToSession nor submitViaPty, so it needed its own gate — in its own frozen refusal vocabulary.
test('B1270RR M2 interaction frames: a stranded composer admits no interaction, refused in that path\'s own vocabulary', async () => {
  const sid = 'b1270g-interaction';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const before = ws.frames.length;
  // One request shape for both halves. The epoch it quotes is deliberately NOT this session's, so a request that
  // gets PAST the strand gate fails at validateObservation's binding check — which is how the two halves below
  // are told apart by their reason rather than by their stage.
  const frame = () => ({
    request: {
      action_id: crypto.randomUUID(),
      interaction_request_id: crypto.randomUUID(),
      identity: { kind: 'session', sid },
      expected: { sid, session_epoch: 'b1270-not-this-epoch' },
      operation: 'key',
      value: 'enter',
      authority: { provenance: 'controller-policy' },
    },
    request_digest: 'b1270-digest',
  });
  const control = await H.runtime.dispatchInteraction(frame());
  assert.deepEqual({ stage: control.stage, reason: control.reason, bytes: control.bytes_written },
    { stage: 'refused', reason: 'wrong_owner', bytes: 0 },
    `PRECONDITION: without a strand the request reaches the binding/observation fences ${JSON.stringify(control)}`);

  runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  const stranded = await H.runtime.dispatchInteraction(frame());
  assert.deepEqual({ stage: stranded.stage, reason: stranded.reason, bytes: stranded.bytes_written },
    { stage: 'refused', reason: 'unsupported_capability', bytes: 0 },
    `CHECKPOINT: the strand gate answers FIRST, in the frozen REFUSALS vocabulary ${JSON.stringify(stranded)}`);
  assert.equal(ws.frames.length, before, 'CHECKPOINT: no interaction frame was ever handed to the owner — no key was written');

  session.sessionEpoch = crypto.randomUUID();   // a new instance is a new composer
  const afterNewEpoch = await H.runtime.dispatchInteraction(frame());
  assert.equal(afterNewEpoch.reason, 'wrong_owner',
    `CHECKPOINT: a NEW instance is not blocked by the old strand ${JSON.stringify(afterNewEpoch)}`);
});

// RR-M3 (major): the cooperative-handoff pending write returns before the shared boundary, so the strand gate
// never ran for it. The bridge writes that retained text with child.write — it cannot submit (control characters
// are rejected) but it CAN concatenate into the stranded half-line.
test('B1270RR M3 cooperative-handoff pending write: refused for a stranded instance before any dispatch trace', async () => {
  const sid = 'b1270g-handoff';
  const session = H.registerSession(sid);
  const ws = session.ownerWs;
  const before = ws.frames.length;
  const msg = () => ({ msg_id: `b1270-handoff-${crypto.randomUUID().slice(0, 8)}`, from: 'handoff-sender', to: sid,
    payload: 'retained handoff text', created_at: Math.floor(Date.now() / 1000), attempt: 0,
    cooperative_handoff: { origin_epoch: 'b1270-older-epoch', intent_id: crypto.randomUUID() } });

  const control = await H.mailboxDeliverFn(sid, msg());
  assert.deepEqual({ success: control.success, code: control.code },
    { success: false, code: 'HANDOFF_DISPATCH_UNKNOWN' },
    `PRECONDITION: without a strand the branch proceeds to its own identity fences ${JSON.stringify(control)}`);

  runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  const stranded = await H.mailboxDeliverFn(sid, msg());
  assert.deepEqual({ success: stranded.success, code: stranded.code, bytes: stranded.bytes_written, uncertain: stranded.delivery_uncertain },
    { success: false, code: 'COMPOSER_STRANDED', bytes: 0, uncertain: false },
    `CHECKPOINT: refused with the shared code and a provable zero ${JSON.stringify(stranded)}`);
  assert.equal(ws.frames.length, before, 'CHECKPOINT: no pending_handoff frame reached the owner');
  assert.equal(session.cooperativeHandoffAudit, undefined,
    'CHECKPOINT: refused BEFORE any dispatch is recorded — no audit row, no store churn for a write that can never happen');
});

// RR-m5 (minor): strandComposer may only ever ADD a strand. Called without an epoch it used to overwrite an
// active record with {epoch:null}, which strandedComposer then reads as "not stranded".
test('B1270RR m5 strandComposer: an un-keyed call cannot un-strand an active instance', () => {
  const session = { id: 'b1270g-m5', sessionEpoch: 'epoch-A' };
  const first = runtimeModule.strandComposer(session, { epoch: 'epoch-A', injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  assert.ok(runtimeModule.strandedComposer(session), 'PRECONDITION: stranded');
  assert.deepEqual(runtimeModule.strandComposer(session), first,
    'CHECKPOINT: a call with no epoch returns the EXISTING record and changes nothing');
  assert.ok(runtimeModule.strandedComposer(session), 'CHECKPOINT: still stranded — the un-keyed call did not re-admit every producer');
  assert.equal(runtimeModule.strandComposer(session, { epoch: 42 }), first, 'CHECKPOINT: a non-string epoch is refused the same way');
  assert.equal(runtimeModule.strandedInputFailure(session).code, 'COMPOSER_STRANDED', 'CHECKPOINT: and the shared refusal still fires');
  // It can still strand a session that has no record at all only when given a usable key.
  const fresh = { id: 'b1270g-m5-fresh', sessionEpoch: 'epoch-B' };
  assert.equal(runtimeModule.strandComposer(fresh), null, 'CHECKPOINT: no key, no record, nothing invented');
  assert.ok(runtimeModule.strandComposer(fresh, { epoch: 'epoch-B', reason: 'cr_outcome_unknown' }), 'CHECKPOINT: a keyed call still strands');
});

// RR-m9 (minor): the barrier release must clear only its OWN promise, or it could separate a third party's body
// from its CR — the exact failure the barrier exists to prevent.
test('B1270RR m9 barrier release: a foreign barrier installed mid-pair is left untouched', { timeout: 30000 }, async () => {
  const sid = 'b1270g-m9';
  const foreign = new Promise(() => {});   // never settles; nobody else may clear it
  const session = H.registerSession(sid, { onSend: (ws, frame) => {
    // Installed between the body and its CR, exactly where an unconditional release would steal it.
    if (frame.part === 'body') H.sessions[sid].pendingSubmit = foreign;
  } });
  H.sessionStateManager.feed(sid, WORKING);
  const response = await post(sid, boundRequest(session, 'B1270RR-M9 body'));
  assert.equal(response.body.stage, 'accepted', `PRECONDITION: the pair completed ${JSON.stringify(response.body)}`);
  assert.equal(session.pendingSubmit, foreign,
    "CHECKPOINT: the finally-release left the foreign barrier in place instead of nulling somebody else's");
  session.pendingSubmit = null;
});

// RR-m10 (minor): protectedInputFailure is now re-evaluated with the other gates after every await, and the one
// reason the route itself answers 403 keeps that status when the delivery returns it.
test('B1270RR m10 protected input mid-flight: an enrolment during the barrier wait is refused 403 by name', { timeout: 30000 }, async () => {
  const sid = 'b1270g-m10';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const ws = session.ownerWs;
  let release;
  session.pendingSubmit = new Promise(resolve => { release = () => { session.pendingSubmit = null; resolve(); }; });
  const pending = post(sid, boundRequest(session, 'B1270RR-M10 body'));
  await sleep(50);
  session.externalApprovalPolicy = { authority: 'external-signer' };   // enrolled while the request waits
  release();
  const response = await pending;
  assert.deepEqual({ status: response.status, stage: response.body.stage, reason: response.body.reason, bytes: response.body.bytes_written },
    { status: 403, stage: 'refused', reason: 'protected_input', bytes: 0 },
    `CHECKPOINT: the named reason and the route's own status, not a late generic body_refused ${JSON.stringify(response.body)}`);
  assert.equal(injects(ws).length, 0, 'CHECKPOINT: nothing was written');
  assert.equal(H.runtime.boundAdmissionRefusal(session), 'protected_input',
    'CHECKPOINT: the shared predicate is what reports it, so both call sites agree');
  delete session.externalApprovalPolicy;
});

// RR-m11 (minor): a stranded session used to accept legacy bootstrap-queue parks and answer queued:true for work
// that could never be written. Nothing was corrupted — the drain refused each op — but the answer was wrong.
test('B1270RR m11 legacy door: a stranded session is refused instead of being told its work is queued', async () => {
  const sid = 'b1270g-m11';
  const session = H.registerSession(sid, { ready: false });   // bootstrap-gated: the park branch is live
  runtimeModule.strandComposer(session, { epoch: session.sessionEpoch, injectId: crypto.randomUUID(), reason: 'submit_outcome_unknown' });
  const before = injects(session.ownerWs).length;
  const result = await H.deliverInjectionToSession(sid, session, 'B1270RR-M11 legacy body', { from: 'legacy-sender' });
  assert.deepEqual({ success: result.success, code: result.code, bytes: result.bytes_written, queued: result.queued },
    { success: false, code: 'COMPOSER_STRANDED', bytes: 0, queued: undefined },
    `CHECKPOINT: refused at the door, never queued:true for an undeliverable park ${JSON.stringify(result)}`);
  assert.equal(injects(session.ownerWs).length, before, 'CHECKPOINT: and nothing was written');
  assert.equal(session.bootstrapQueue === undefined || session.bootstrapQueue.length === 0, true,
    'CHECKPOINT: no op was parked for an instance that can never be written to');
});

// RR-m3 / RR-m4 (minors): the bound route now emits the SAME bus events the legacy route emits for the same
// outcomes, with the same non-secret metadata, and sets the same lastInjectFrom the transport view reads.
test('B1270RR m3/m4 observability: an accepted bound delivery emits inject_written and names its sender; a #533 block emits peer_inject_blocked', { timeout: 30000 }, async () => {
  const sid = 'b1270g-m34';
  const session = H.registerSession(sid);
  H.sessionStateManager.feed(sid, WORKING);
  const atAccept = H.busEvents.length;
  const accepted = await post(sid, boundRequest(session, 'B1270RR-M34 body', { from: 'bus-sender' }));
  assert.equal(accepted.body.stage, 'accepted', `PRECONDITION: accepted ${JSON.stringify(accepted.body)}`);
  const written = H.busEvents.slice(atAccept).filter(e => e.type === 'inject_written');
  assert.equal(written.length, 1, `CHECKPOINT: exactly one inject_written for the delivery ${JSON.stringify(H.busEvents.slice(atAccept).map(e => e.type))}`);
  assert.deepEqual({ session_id: written[0].session_id, from: written[0].from, inject_id: written[0].inject_id,
    transport: written[0].transport, length: written[0].content_length, hasHash: typeof written[0].content_sha256 === 'string',
    carriesPrompt: JSON.stringify(written[0]).includes('B1270RR-M34 body') },
  { session_id: sid, from: 'bus-sender', inject_id: accepted.body.inject_id, transport: 'inject-bound-v1',
    length: Buffer.byteLength('B1270RR-M34 body'), hasHash: true, carriesPrompt: false },
  `CHECKPOINT: correlatable metadata only — never the prompt text (#815) ${JSON.stringify(written[0])}`);
  assert.equal(session.lastInjectFrom, 'bus-sender', 'CHECKPOINT: the record names the bound sender');
  assert.equal(H.runtime.buildSessionTransportBlock(session).last_inject_from, 'bus-sender',
    'CHECKPOINT: so transport.last_inject_from no longer reports an older legacy sender after a bound write');

  H.orchestratorSids.push('orchestrator');
  try {
    const atBlock = H.busEvents.length;
    const blocked = await post(sid, boundRequest(session, 'do my work for me', { from: 'peer-b' }));
    assert.equal(blocked.status, 403, `PRECONDITION: blocked ${JSON.stringify(blocked.body)}`);
    const events = H.busEvents.slice(atBlock).filter(e => e.type === 'peer_inject_blocked');
    assert.equal(events.length, 1, `CHECKPOINT: the bound block emits the legacy enforcement event ${JSON.stringify(events)}`);
    assert.deepEqual({ target: events[0].target_agent, from: events[0].from, reason: events[0].reason,
      envelope: events[0].envelope_present, inject: events[0].inject_id },
    { target: sid, from: 'peer-b', reason: 'malformed-envelope', envelope: false, inject: null },
    `CHECKPOINT: same extra fields as the legacy event ${JSON.stringify(events[0])}`);
  } finally {
    H.orchestratorSids.length = 0;
  }
});
