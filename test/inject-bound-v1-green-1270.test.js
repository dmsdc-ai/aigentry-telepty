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
    ORCHESTRATOR_SIDS: [], MACHINE_ID: 'b1270-green-machine',
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
    dispose, gateCalls, sessionStateManager,
    writeDataToSession: context.writeDataToSession, deliverInjectionToSession: context.deliverInjectionToSession };
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
