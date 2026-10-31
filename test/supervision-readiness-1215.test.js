'use strict';

// Task 1215 repair — behavioral regressions for the measured supervision escape (F1) and the
// explicit transport-readiness contract (F2), the shared production inject handler (F4), id-less
// lone CR (F5), state-derived withhold reasons (F6) and receipt semantics.
//
// Real product code exercised: the register route (registerSessionRegisterRoute +
// createSessionRecordContext + createCredentialStore), input-policy bind exactly as websocket.js
// calls it (with the claimant's presented capability), readiness-handshake (daemon validator and
// bridge frame builder), createDeliveryRuntime gate functions, createAllowSecurityContext with
// its PRODUCTION handleOwnerInject / announceTransportReady / spawnChild / subscribeChild.
// Declared fakes: clock/timers, child (write recorder, pid), spawnPty, owner-WS send recorder,
// stdout geometry, HTTP req/res objects. No daemon, listener or network.
// "PRECONDITION:" assertions validate setup (failure = INVALID, not product RED).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const security = require('../src/cli/security-actions');
const registry = require('../src/prompt-symbol-registry');
const { FileMailbox } = require('../src/mailbox/index');
const flushFilter = require('../src/mailbox/bridge-flush-filter');
const { getTerminalSize } = require('../interactive-terminal');
const vtModule = require('../src/vt/session-screen');
const policies = require('../src/mailbox/input-policy');
const bridgeStage = require('../src/mailbox/bridge-stage');
const readiness = require('../src/transport/readiness-handshake');
const routeMetadata = require('../src/session-store/route-metadata');
const persistence = require('../src/session-store/persistence');
const { correlateRequest } = require('../src/diagnostics/correlation');
const { registerSessionRegisterRoute, createSessionRecordContext } = require('../src/routes/session-records');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { createDeliveryRuntime } = require('../src/mailbox/delivery-runtime');
const crypto = require('node:crypto');
const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
const { createPrincipalAuthentication } = require('../src/principal/http');
const { createAuthMiddleware } = require('../src/protocol/http-auth');

const GEN = 'owner-gen-1215-repair';
const CAP_HEADER = policies.CAPABILITY_HEADER;
const MODAL_STREAM = (() => {
  const recipe = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bridge-136', 'codex-differential-modal.json'), 'utf8'));
  assert.match(recipe.provenance, /^synthetic:/, 'PRECONDITION: synthetic modal fixture');
  let s = recipe.preamble.join('');
  for (let k = 0; k < recipe.repeat; k++) s += recipe.cycle[k % recipe.cycle.length];
  return s + recipe.epilogue.join('');
})();
const MODAL_RING = ['\x1b[2J> You are in /tmp/x\n\nDo you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue\n'];

// ---- daemon-side register fixture ----------------------------------------------------------------
// Task 1215 R1: requests pass through the REAL auth middleware before the real register route. `as:
// 'legacy'` = the shared host token (what every wrapped child inherits); `as: 'operator'` = a real
// Ed25519 operator assertion verified by the real strict principal verifier. Nothing is stubbed and no
// verified-request property is set by the test.
const HOST_TOKEN = 'host-token-1215-fixture';
const AUDIENCE = 'telepty-1215-fixture-machine';
const OPERATOR_KEY = crypto.generateKeyPairSync('ed25519');
function registerFixture(t, { sids = [], restoreFrom = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-repair-reg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = {};
  const sessionCredentials = createCredentialStore();
  // Task 1215 G6: optionally boot this fixture "daemon" from another fixture's ACTUAL persisted file, with the
  // product's own reader/builder in daemon.js's restore order (loadPersistedSessions → buildRestoredWrappedSession
  // → sessionCredentials.adopt → initializeBootstrapState). The test writes no restore marker or owner field.
  if (restoreFrom) {
    for (const [id, meta] of Object.entries(persistence.loadPersistedSessions(restoreFrom))) {
      const restored = persistence.buildRestoredWrappedSession(id, meta, { cwd: dir });
      if (!restored) continue;
      sessions[id] = restored;
      sessionCredentials.adopt(id, meta);
      routeMetadata.initializeBootstrapState(sessions[id]);
    }
  }
  const persistPath = path.join(dir, 'sessions.json');
  const context = createSessionRecordContext({ sessions, sessionCredentials, sidNonces: new Map(), sessionPersistPath: persistPath });
  let handler;
  registerSessionRegisterRoute({ post: (_p, h) => { handler = h; } }, { context, sessionStateManager: { register() {} }, busClients: new Set(),
    getMailbox: () => { throw new Error('PRECONDITION: no mailbox in this fixture'); } });
  const trust = validateTrustConfiguration({ schema: 'telepty.principals/v1', audience: AUDIENCE, keys: [
    { key_id: 'operator-key', principal_id: 'operator', authority: 'operator',
      public_key_spki: OPERATOR_KEY.publicKey.export({ type: 'spki', format: 'pem' }),
      grants: [{ action: 'session.register', targets: sids.length ? sids : ['unused-sid'] }] }] });
  const principalAuth = createPrincipalAuthentication({ trust, sessions });
  const middleware = {
    legacy: createAuthMiddleware({ expectedToken: HOST_TOKEN, isAllowedPeer: () => true, verifyJwt: () => false, isForbiddenOrigin: () => false }),
    operator: createAuthMiddleware({ expectedToken: HOST_TOKEN, isAllowedPeer: () => true, verifyJwt: () => false, isForbiddenOrigin: () => false,
      principalAuthentication: principalAuth }),
  };
  const warn = console.warn; const log = console.log;
  console.warn = () => {}; console.log = () => {};
  t.after(() => { console.warn = warn; console.log = log; });
  function register(input, { bearer, capability, sessionCredentialOnly, as = 'legacy' } = {}) {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const body = { cwd: dir, ...input };
    const target = '/api/sessions/register';
    const headers = { ...(bearer ? { 'x-telepty-session-token': bearer } : {}), ...(capability ? { [CAP_HEADER]: capability } : {}) };
    if (as === 'legacy') headers['x-telepty-token'] = HOST_TOKEN;
    if (as === 'operator') {
      const existing = sessions[body.session_id];
      headers['x-telepty-principal'] = createSignedAssertion({ privateKey: OPERATOR_KEY.privateKey, keyId: 'operator-key', principalId: 'operator',
        audience: AUDIENCE, challenge: principalAuth.verifier.challenge, method: 'POST', target, body, action: 'session.register',
        ...(existing ? { sessionEpoch: existing.sessionEpoch } : {}) });
    }
    const req = { method: 'POST', url: target, originalUrl: target, ip: '127.0.0.1', headers, rawHeaders: Object.entries(headers).flat(),
      body, principalRawBody: Buffer.from(JSON.stringify(body)), ...(sessionCredentialOnly ? { sessionCredentialOnly: true } : {}) };
    let admitted = false;
    middleware[as === 'operator' ? 'operator' : 'legacy'](req, res, () => { admitted = true; });
    if (admitted) handler(req, res);
    res.admitted = admitted;
    return res;
  }
  let gen = 0;
  // Exactly what websocket.js does at an owner claim: new generation, then bind with the claimant's
  // presented capability header (undefined when the claimant sent none), then a new handshake.
  function claim(sid, { capability, capable = true } = {}) {
    const s = sessions[sid];
    s.interactionOwnerGeneration = `claim-${++gen}`;
    s.ownerWs = { readyState: 1 };
    policies.bindInputPolicy(s, new Date(), { capability });
    readiness.beginOwnerGeneration(s, { capable });
    return s;
  }
  return { sessions, register, claim, persistPath };
}
function modalRuntime() {
  return createDeliveryRuntime({ readyRegistry: registry, MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
    MODAL_REMEDY_BY_CLI: { claude: 'park' }, MODAL_REMEDY_DEFAULT: 'hold', MODAL_HINT_BY_CLI: { codex: 'hint' }, MODAL_RING_TAIL_BYTES: 65536,
    isBootstrapGatedSession: routeMetadata.isBootstrapGatedSession, initializeBootstrapState: routeMetadata.initializeBootstrapState });
}

// ===== F1 ===========================================================================================

test('F1 measured self-grant: a worker child\'s own exported bearer cannot request user-supervised; later owner claims stay guarded', { timeout: 30000 }, t => {
  const f = registerFixture(t);
  const dm = modalRuntime();
  const worker = f.register({ session_id: 'w1215', command: 'codex' });
  assert.equal(worker.statusCode, 201, 'PRECONDITION: worker registered');
  f.claim('w1215');
  const childBearer = worker.body.session_token;               // == TELEPTY_SESSION_TOKEN in the child env
  const own = f.register({ session_id: 'w1215', command: 'codex', input_policy: 'user-supervised' }, { bearer: childBearer });
  const forged = f.register({ session_id: 'w1215', command: 'codex', input_policy: 'user-supervised' },
    { bearer: childBearer, capability: 'A'.repeat(43) });
  f.register({ session_id: 'w1215', command: 'codex' }, { bearer: childBearer });   // the bridge's own reconnect
  const s = f.claim('w1215', { capability: 'A'.repeat(43) });
  s.outputRing = MODAL_RING.slice();
  assert.deepEqual({
    own: [own.statusCode, own.body.input_policy_pending, own.body.input_policy_refused],
    forged: [forged.statusCode, forged.body.input_policy_pending, forged.body.input_policy_refused],
    pending: Object.hasOwn(s, 'inputPolicyPending'),
    effective: policies.effectiveInputPolicy(s), gated: routeMetadata.isBootstrapGatedSession(s), modal: dm.modalDeliveryDecision(s, {}, {}).action,
  }, { own: [200, false, 'INPUT_POLICY_CAPABILITY_REQUIRED'], forged: [200, false, 'INPUT_POLICY_CAPABILITY_REQUIRED'],
    pending: false, effective: 'guarded', gated: true, modal: 'hold' });
});

test('F1 operator launch keeps the feature: capability minted once at 201 to a verified operator, bridge-memory only, required at claim', { timeout: 30000 }, t => {
  const f = registerFixture(t, { sids: ['o1215'] });
  const reg = f.register({ session_id: 'o1215', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator' });
  assert.equal(reg.statusCode, 201, `PRECONDITION: operator registration ${JSON.stringify(reg.body)}`);
  const cap = reg.body.input_policy_capability;
  assert.equal(typeof cap, 'string', 'PRECONDITION: capability issued');
  const s = f.sessions.o1215;
  const persisted = JSON.stringify(persistence.serializePersistedSessions(f.sessions));
  const bound = f.claim('o1215', { capability: cap });
  const reReg = f.register({ session_id: 'o1215', command: 'codex', input_policy: 'user-supervised' },
    { as: 'operator', bearer: reg.body.session_token, capability: cap });
  assert.deepEqual({
    pending: reg.body.input_policy_pending, refused: reg.body.input_policy_refused,
    capabilityShape: /^[A-Za-z0-9_-]{43}$/.test(cap),
    inRecord: JSON.stringify(Object.keys(s).map(k => [k, typeof s[k] === 'object' ? null : s[k]])).includes(cap),
    inPersisted: persisted.includes(cap) || persisted.includes('inputPolicy'),
    effective: policies.effectiveInputPolicy(bound), source: bound.inputPolicy && bound.inputPolicy.source, gated: routeMetadata.isBootstrapGatedSession(bound),
    reRegPending: [reReg.statusCode, reReg.body.input_policy_pending], reRegCarriesCapability: Object.hasOwn(reReg.body, 'input_policy_capability'),
  }, { pending: true, refused: null, capabilityShape: true, inRecord: false, inPersisted: false,
    effective: 'user-supervised', source: 'operator_principal_registration', gated: false, reRegPending: [200, true], reRegCarriesCapability: false });
});

test('F1 cross-owner pending grant: a claimant without the capability cannot consume it; the rightful bridge still can', { timeout: 30000 }, t => {
  const f = registerFixture(t, { sids: ['x1215', 'x1215-other'] });
  const reg = f.register({ session_id: 'x1215', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator' });
  const cap = reg.body.input_policy_capability;
  assert.equal(typeof cap, 'string', 'PRECONDITION: capability issued');
  const stolen = f.claim('x1215');                                   // bearer-proved, no capability
  const afterStolen = { effective: policies.effectiveInputPolicy(stolen), pendingKept: Object.hasOwn(stolen, 'inputPolicyPending') };
  const other = f.register({ session_id: 'x1215-other', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator' });
  const wrongCap = f.claim('x1215', { capability: other.body.input_policy_capability });   // another instance's capability
  const afterWrong = { effective: policies.effectiveInputPolicy(wrongCap), pendingKept: Object.hasOwn(wrongCap, 'inputPolicyPending') };
  const rightful = f.claim('x1215', { capability: cap });
  const afterRightful = { effective: policies.effectiveInputPolicy(rightful), pendingKept: Object.hasOwn(rightful, 'inputPolicyPending') };
  const reclaim = f.claim('x1215', { capability: cap });             // no fresh request: generation-bound, guarded
  assert.deepEqual({ afterStolen, afterWrong, afterRightful, reclaim: policies.effectiveInputPolicy(reclaim) }, {
    afterStolen: { effective: 'guarded', pendingKept: true }, afterWrong: { effective: 'guarded', pendingKept: true },
    afterRightful: { effective: 'user-supervised', pendingKept: false }, reclaim: 'guarded' });
});

test('F1 stale capabilities: downgrade revokes, credential-generation change invalidates, recreate has none', { timeout: 30000 }, t => {
  const f = registerFixture(t, { sids: ['s1215'] });
  const reg = f.register({ session_id: 's1215', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator' });
  const cap = reg.body.input_policy_capability;
  assert.equal(typeof cap, 'string', 'PRECONDITION: capability issued');
  const s = f.sessions.s1215;
  const live = !!policies.verifyInputPolicyCapability(s, cap);
  s.credentialGeneration = (Number(s.credentialGeneration) || 1) + 1;     // rotated instance credential
  const afterRotation = !!policies.verifyInputPolicyCapability(s, cap);
  s.credentialGeneration -= 1;
  const stillGone = !!policies.verifyInputPolicyCapability(s, cap);       // a stale grant is dropped, not resurrected
  const f2 = registerFixture(t, { sids: ['d1215'] });
  const reg2 = f2.register({ session_id: 'd1215', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator' });
  const down = f2.register({ session_id: 'd1215', command: 'codex', input_policy: 'guarded' }, { as: 'operator', bearer: reg2.body.session_token });
  const reUp = f2.register({ session_id: 'd1215', command: 'codex', input_policy: 'user-supervised' },
    { as: 'operator', bearer: reg2.body.session_token, capability: reg2.body.input_policy_capability });
  const recreated = { id: 's1215', sessionEpoch: s.sessionEpoch, credentialGeneration: s.credentialGeneration };
  assert.deepEqual({ live, afterRotation, stillGone, down: down.statusCode,
    reUp: [reUp.body.input_policy_pending, reUp.body.input_policy_refused], recreated: !!policies.verifyInputPolicyCapability(recreated, cap) },
  { live: true, afterRotation: false, stillGone: false, down: 200, reUp: [false, 'INPUT_POLICY_CAPABILITY_REQUIRED'], recreated: false });
});

// ===== G6: revocation survives persistence; a genuine restore stays recoverable ======================
// Both tests run the same real path and differ ONLY in whether the owner explicitly downgraded:
// operator 201 + capability claim → (optional downgrade) → the route's own writer persisted sessions.json →
// a second fixture daemon restores that file with the product reader/builder → the same verified operator,
// with the record's current epoch and its own bearer, re-requests user-supervised.
// Fixture limits: in-memory route/middleware stand-in for HTTP and the owner socket. No daemon process,
// PTY, native reader, installed package or model ACK.

function g6Persisted(file) { return fs.readFileSync(file, 'utf8'); }

test('G6 explicit downgrade survives persistence: after a real save/restore the verified owner reissue is refused', { timeout: 30000 }, t => {
  const f1 = registerFixture(t, { sids: ['g6-down'] });
  const reg = f1.register({ session_id: 'g6-down', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator' });
  assert.equal(reg.statusCode, 201, `PRECONDITION: operator registration ${JSON.stringify(reg.body)}`);
  const cap = reg.body.input_policy_capability, bearer = reg.body.session_token;
  assert.equal(typeof cap, 'string', 'PRECONDITION: capability issued');
  assert.equal(policies.effectiveInputPolicy(f1.claim('g6-down', { capability: cap })), 'user-supervised', 'PRECONDITION: granted before the downgrade');
  const grantedFile = g6Persisted(f1.persistPath);                     // written by the route's real writer
  const down = f1.register({ session_id: 'g6-down', command: 'codex', input_policy: 'guarded' }, { as: 'operator', bearer });
  assert.equal(down.statusCode, 200, `PRECONDITION: explicit downgrade accepted ${JSON.stringify(down.body)}`);
  const downgradedFile = g6Persisted(f1.persistPath);
  const f2 = registerFixture(t, { sids: ['g6-down'], restoreFrom: f1.persistPath });
  const restored = f2.sessions['g6-down'];
  assert.ok(restored, 'PRECONDITION: the product reader/builder restored the record');
  assert.equal(restored.sessionEpoch, reg.body.session_epoch, 'PRECONDITION: the restored epoch is the instance epoch');
  const reissue = f2.register({ session_id: 'g6-down', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator', bearer, capability: cap });
  const after = f2.claim('g6-down', { capability: cap });
  assert.deepEqual({
    grantedFileMarksRestorable: JSON.parse(grantedFile)['g6-down'].supervisionRestorable === true,
    downgradedFileMarksRestorable: Object.hasOwn(JSON.parse(downgradedFile)['g6-down'], 'supervisionRestorable'),
    secretsInFiles: [grantedFile, downgradedFile].some(x => x.includes(cap) || x.includes(bearer)),
    restoredOwner: restored.owningPrincipal && restored.owningPrincipal.id,
    reissue: [reissue.admitted, reissue.statusCode, reissue.body.input_policy_pending, reissue.body.input_policy_refused,
      Object.hasOwn(reissue.body, 'input_policy_capability')],
    effective: policies.effectiveInputPolicy(after),
  }, { grantedFileMarksRestorable: true, downgradedFileMarksRestorable: false, secretsInFiles: false, restoredOwner: 'operator',
    reissue: [true, 200, false, 'INPUT_POLICY_CAPABILITY_REQUIRED', false], effective: 'guarded' });
});

test('G6 granted and never revoked: after a real save/restore the same verified owner gets a FRESH capability; stale/wrong credentials and the lost capability are refused', { timeout: 30000 }, t => {
  const f1 = registerFixture(t, { sids: ['g6-keep'] });
  const reg = f1.register({ session_id: 'g6-keep', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator' });
  assert.equal(reg.statusCode, 201, `PRECONDITION: operator registration ${JSON.stringify(reg.body)}`);
  const cap = reg.body.input_policy_capability, bearer = reg.body.session_token;
  assert.equal(typeof cap, 'string', 'PRECONDITION: capability issued');
  assert.equal(policies.effectiveInputPolicy(f1.claim('g6-keep', { capability: cap })), 'user-supervised', 'PRECONDITION: granted');
  const file = g6Persisted(f1.persistPath);
  const f2 = registerFixture(t, { sids: ['g6-keep'], restoreFrom: f1.persistPath });
  const restored = f2.sessions['g6-keep'];
  assert.ok(restored, 'PRECONDITION: the product reader/builder restored the record');
  const reserialized = JSON.stringify(persistence.serializePersistedSessions(f2.sessions));
  // Refusals first (they must not grant or consume anything), then the genuine reissue.
  const noBearer = f2.register({ session_id: 'g6-keep', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator', capability: cap });
  const wrongBearer = f2.register({ session_id: 'g6-keep', command: 'codex', input_policy: 'user-supervised' },
    { as: 'operator', bearer: `${reg.body.session_epoch}.${'A'.repeat(43)}`, capability: cap });
  const reissue = f2.register({ session_id: 'g6-keep', command: 'codex', input_policy: 'user-supervised' }, { as: 'operator', bearer, capability: cap });
  const fresh = reissue.body.input_policy_capability;
  const withLost = f2.claim('g6-keep', { capability: cap });             // the pre-restart capability never binds
  const lostEffective = policies.effectiveInputPolicy(withLost);
  const bound = f2.claim('g6-keep', { capability: fresh });
  assert.deepEqual({
    fileMarksRestorable: JSON.parse(file)['g6-keep'].supervisionRestorable === true,
    secretsInFile: file.includes(cap) || file.includes(bearer),
    restoreMarkerSerialized: reserialized.includes('restoredFromPersistence'),
    noBearer: [noBearer.statusCode, noBearer.body.input_policy_pending, noBearer.body.input_policy_refused],
    wrongBearer: [wrongBearer.statusCode, wrongBearer.body.input_policy_pending, wrongBearer.body.input_policy_refused],
    reissue: [reissue.admitted, reissue.statusCode, reissue.body.input_policy_pending, reissue.body.input_policy_refused],
    freshIssued: typeof fresh === 'string' && fresh !== cap,
    lostEffective, effective: policies.effectiveInputPolicy(bound), source: bound.inputPolicy && bound.inputPolicy.source,
  }, { fileMarksRestorable: true, secretsInFile: false, restoreMarkerSerialized: false,
    noBearer: [200, false, 'SESSION_CREDENTIAL_REQUIRED'], wrongBearer: [200, false, 'SESSION_CREDENTIAL_REQUIRED'],
    reissue: [true, 200, true, null], freshIssued: true, lostEffective: 'guarded', effective: 'user-supervised', source: 'operator_principal_registration' });
});

test('R1 the shared legacy host token is never supervision authority: omitted session headers, admitted request, no capability', { timeout: 30000 }, t => {
  const f = registerFixture(t);
  const dm = modalRuntime();
  const nested = f.register({ session_id: 'n1215', command: 'codex', input_policy: 'user-supervised' });   // env -u child, host token only
  const s = f.claim('n1215', { capability: nested.body.input_policy_capability });
  s.outputRing = MODAL_RING.slice();
  assert.deepEqual({ admitted: nested.admitted, status: nested.statusCode, pending: nested.body.input_policy_pending, refused: nested.body.input_policy_refused,
    capability: Object.hasOwn(nested.body, 'input_policy_capability'), effective: policies.effectiveInputPolicy(s), modal: dm.modalDeliveryDecision(s, {}, {}).action },
  { admitted: true, status: 201, pending: false, refused: 'INPUT_POLICY_OPERATOR_REQUIRED', capability: false, effective: 'guarded', modal: 'hold' });
});

// ===== F2 daemon handshake ===========================================================================

function handshakeSession() {
  const s = { id: 'hs1215', type: 'wrapped', command: 'codex', sessionEpoch: 'E'.repeat(22), interactionOwnerGeneration: GEN, ownerWs: { readyState: 1 } };
  readiness.beginOwnerGeneration(s, { capable: true });
  const binding = { owner_generation: GEN, session_epoch: s.sessionEpoch };
  const frame = (type, extra = {}, { childSeq = 1, nonce = s.transportReadiness.nonce, pid = 4242 } = {}) =>
    ({ ...JSON.parse(readiness.milestoneFrame(type, { sessionId: s.id, binding, nonce, childSeq, pid })), ...extra });
  return { s, frame };
}

test('F2 handshake: stale, replayed, wrong-owner and out-of-order milestones are refused; teardown clears readiness', () => {
  const { s, frame } = handshakeSession();
  const r = msg => { const v = readiness.acceptMilestone(s.id, s, msg); return v.ok ? v.milestone : v.reason; };
  const out = {
    readyBeforeStart: r(frame('input_transport_ready')),
    wrongNonce: r(frame('process_started', {}, { nonce: 'N'.repeat(22) })),
    wrongGeneration: r(frame('process_started', { owner_generation: 'other' })),
    wrongSid: r(frame('process_started', { session_id: 'other' })),
    wrongEpoch: r(frame('process_started', { session_epoch: 'F'.repeat(22) })),
    payload: r(frame('process_started', { data: 'x' })),
    started: r(frame('process_started')),
    startedReplay: r(frame('process_started')),
    ready: r(frame('input_transport_ready')),
    readyReplay: r(frame('input_transport_ready')),
  };
  out.awaitingAfterReady = readiness.awaitingInputTransport(s);
  out.readyFlag = readiness.inputTransportReady(s);
  readiness.clearReadiness(s, 'child_exited');
  out.afterExit = [readiness.inputTransportReady(s), readiness.awaitingInputTransport(s), readiness.view(s).input_transport_ready.reason];
  out.oldChildReplay = r(frame('process_started'));
  out.nextChild = [r(frame('process_started', {}, { childSeq: 2 })), r(frame('input_transport_ready', {}, { childSeq: 2 }))];
  s.ownerWs = { readyState: 3 };
  out.ownerClosed = [readiness.inputTransportReady(s), readiness.awaitingInputTransport(s)];
  s.ownerWs = { readyState: 1 };
  const oldNonce = s.transportReadiness.nonce;
  s.interactionOwnerGeneration = 'owner-gen-next';
  readiness.beginOwnerGeneration(s, { capable: true });
  out.newOwner = [readiness.inputTransportReady(s), readiness.awaitingInputTransport(s), s.transportReadiness.nonce !== oldNonce];
  out.crossGenerationReplay = r(frame('process_started', { owner_generation: 'owner-gen-next' }, { nonce: oldNonce, childSeq: 2 }));
  assert.deepEqual(out, {
    readyBeforeStart: 'process_not_started', wrongNonce: 'nonce', wrongGeneration: 'owner_generation', wrongSid: 'session_id',
    wrongEpoch: 'session_epoch', payload: 'payload_key', started: 'process_started', startedReplay: 'replay',
    ready: 'input_transport_ready', readyReplay: 'replay', awaitingAfterReady: false, readyFlag: true,
    afterExit: [false, true, 'child_exited'], oldChildReplay: 'child_seq',
    nextChild: ['process_started', 'input_transport_ready'], ownerClosed: [false, false],
    newOwner: [false, true, true], crossGenerationReplay: 'nonce' });
});

test('F2 daemon gate: a negotiated owner (any role) ignores screen ready / owner-alive / restore and queues until input_transport_ready', () => {
  const dm = modalRuntime();
  const worker = { id: 'g-worker', type: 'wrapped', command: 'codex', interactionOwnerGeneration: GEN, ownerWs: { readyState: 1 } };
  routeMetadata.initializeBootstrapState(worker);
  readiness.beginOwnerGeneration(worker, { capable: true });
  const supervisedLike = { id: 'g-plain', type: 'wrapped', command: 'bash', interactionOwnerGeneration: GEN, ownerWs: { readyState: 1 } };
  routeMetadata.initializeBootstrapState(supervisedLike);   // not bootstrap-gated by identity
  readiness.beginOwnerGeneration(supervisedLike, { capable: true });
  const legacy = { id: 'g-legacy', type: 'wrapped', command: 'bash', interactionOwnerGeneration: GEN, ownerWs: { readyState: 1 } };
  routeMetadata.initializeBootstrapState(legacy);
  readiness.beginOwnerGeneration(legacy, { capable: false });
  const out = {
    workerQueued: dm.shouldQueueBootstrapOperation(worker), plainQueued: dm.shouldQueueBootstrapOperation(supervisedLike),
    legacyQueued: dm.shouldQueueBootstrapOperation(legacy),
    screenReady: dm.markBootstrapReady(worker.id, worker, 'bridge_ready'), ownerAlive: dm.markBootstrapReady(worker.id, worker, 'owner_alive'),
    restore: dm.markBootstrapReady(worker.id, worker, 'startup_owner_alive'), forgedReason: dm.markBootstrapReady(worker.id, worker, 'input_transport_ready'),
    stillNotReady: [worker.bootstrapReady, dm.isBootstrapReady(worker)],
    legacyView: readiness.view(legacy).capability,
  };
  assert.deepEqual(out, { workerQueued: true, plainQueued: true, legacyQueued: false, screenReady: false, ownerAlive: false,
    restore: false, forgedReason: false, stillNotReady: [false, false], legacyView: 'legacy_bridge_no_handshake' });
});

// ===== bridge fixtures ===============================================================================

function countingRegistry() {
  const calls = {};
  const proxy = {};
  for (const [k, v] of Object.entries(registry)) proxy[k] = typeof v === 'function' ? (...a) => { calls[k] = (calls[k] || 0) + 1; return v(...a); } : v;
  return { proxy, calls };
}
function countScreens(t) {
  const Original = vtModule.SessionScreen;
  const counter = { constructed: 0, reads: 0 };
  vtModule.SessionScreen = class Counted extends Original {
    constructor(...a) { counter.constructed++; super(...a); }
    readFrameSync(...a) { counter.reads++; return super.readFrameSync(...a); }
  };
  t.after(() => { vtModule.SessionScreen = Original; });
  return counter;
}
function createClock() {
  const start = Math.floor((Date.now() - 3 * 3600 * 1000) / 1000) * 1000;
  let now = start; let seq = 0; const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), every: 0 }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++seq; const d = Math.max(1, Number(ms) || 1); timers.set(id, { fn, at: now + d, every: d }); return id; },
    clearInterval(id) { timers.delete(id); },
    async advance(ms, each) {
      const end = now + ms; let fired = 0;
      for (;;) {
        let id = null; let tm = null;
        for (const [k, v] of timers) if (v.at <= end && (!tm || v.at < tm.at)) { id = k; tm = v; }
        if (!tm) break;
        assert.ok(++fired <= 100000, 'PRECONDITION: fake timer budget');
        now = Math.max(now, tm.at);
        if (each) each(now);
        if (tm.every) tm.at += tm.every; else timers.delete(id);
        tm.fn();
        await new Promise(r => setImmediate(r));
      }
      now = end;
    },
  };
}
function createBridge(t, { sid, inputPolicy, readyRegistry = registry, withChild = true, nonce = 'R'.repeat(22) }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-repair-'));
  const clock = createClock();
  const writes = []; const sends = [];
  const stdout = { columns: 80, rows: 24, isTTY: true, write() { return true; } };
  const makeChild = () => ({ pid: 31337, cols: 80, rows: 24, write(d) { writes.push(d); }, resize() {},
    onData(fn) { this._data = fn; }, onExit(fn) { this._exit = fn; }, kill() { throw new Error('PRECONDITION: no kill'); } });
  const shared = {
    sessionId: sid, command: 'codex', cmdArgs: [], sshPlan: null, child: withChild ? makeChild() : null, handoffPending: null, idleTtl: null,
    detectedBackend: 'fixture', terminalProgram: 'fixture', terminalType: 'xterm-256color',
    DAEMON_URL: 'http://127.0.0.1:9', fetchWithAuth: () => Promise.reject(new Error('no network')),
    sessionCwd: root, sessionEnv: {}, bridgeTarget: sid, bridgeMsgSeq: 0, bridgePendingCount: 0,
    promptReady: false, lastUserInputTime: 0, IDLE_THRESHOLD: 2000,
    knownAiCli: registry.isKnownAiCli('codex'), outputTail: '', readyRegistry, readyQualification: null,
    promptPattern: /[❯>$#%]\s*$/, firstReadyObserved: false, queueFlushTimer: null, idleCheckTimer: null,
    reconnectTimer: null, heartbeatTimer: null,
    filterBridgeBatch: flushFilter.filterBridgeBatch, bridgeInjectTtlSecs: flushFilter.bridgeInjectTtlSecs,
    interactionBinding: { sid, session_epoch: 'E'.repeat(22), credential_generation: 1, owner_generation: GEN, input_generation: 0, geometry_generation: 0 },
    wsReady: true, daemonWs: { readyState: 1, send(raw) { sends.push(String(raw)); }, close() {} },
    getTerminalSize, allowSessionClosed: false, cleanupTerminal() {}, currentOwnerToken: 'synthetic',
    allowSignalHandlers: new Map(), FileMailbox, path, os, bridgeIdentity: null, inputPolicy, readinessNonce: nonce,
  };
  const allow = security.createAllowSecurityContext(shared, {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    getStdout: () => stdout, removeSignalHandler() {},
    spawnPty() { return makeChild(); }, bridgeRoot: path.join(root, 'bridge'),
  });
  shared.bridgeMailbox = allow.createBridgeMailbox();
  const relay = allow.createOutputRelay({ onInteraction() {}, onBytes() {}, rewrite: d => d, write() {}, sendOutput() {},
    observeReady: d => allow.observePromptReady(d),
    onReady() { if (shared.handoffPending) return; shared.promptReady = true; shared.firstReadyObserved = true; allow.flushBridgeMailbox(); } });
  const feed = s => { for (let i = 0; i < s.length; i += 1024) relay(s.slice(i, i + 1024)); };
  let n = 0;
  function pair(text) {
    n++;
    const inject_id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const body = { type: 'inject', data: text, daemon_msg_id: `rep-${n}-body`, inject_id, part: 'body', owner_generation: GEN };
    const submit = { type: 'inject', data: '\r', daemon_msg_id: `rep-${n}-submit`, inject_id, part: 'submit', pair: body.daemon_msg_id, owner_generation: GEN };
    return { inject_id, body, submit };
  }
  const frames = type => sends.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(m => m && m.type === type);
  const receipts = id => frames('bridge_receipt').filter(r => r.inject_id === id).map(r => `${r.part}:${r.stage}:${r.certainty}${r.reason ? ':' + r.reason : ''}`);
  t.after(() => { try { allow.closeAllowSession({ destroySession: false }); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return { shared, allow, clock, writes, sends, feed, pair, frames, receipts };
}

test('F2 all-role handshake without readiness text: both roles announce process_started + input_transport_ready, zero screen reads, daemon accepts', { timeout: 30000 }, t => {
  const screens = countScreens(t);
  const out = {};
  for (const policy of ['user-supervised', 'guarded']) {
    const { proxy, calls } = countingRegistry();
    const b = createBridge(t, { sid: `hs-${policy}`, inputPolicy: policy, readyRegistry: proxy, withChild: false });
    const beforeSpawn = b.allow.announceTransportReady();
    b.shared.command = process.execPath;                              // spawn target only (fake spawnPty); no output is fed
    const child = b.allow.spawnChild();
    const beforeSubscribe = b.allow.announceTransportReady();       // child exists, output/exit not attached yet
    b.allow.subscribeChild(child, () => {}, () => {});
    const announced = b.allow.announceTransportReady();
    const frames = [...b.frames('process_started'), ...b.frames('input_transport_ready')];
    const daemonSession = { id: `hs-${policy}`, type: 'wrapped', sessionEpoch: 'E'.repeat(22), interactionOwnerGeneration: GEN, ownerWs: { readyState: 1 } };
    readiness.beginOwnerGeneration(daemonSession, { capable: true });
    daemonSession.transportReadiness.nonce = 'R'.repeat(22);        // the nonce this owner received in owner_token
    const accepted = frames.map(f => { const v = readiness.acceptMilestone(daemonSession.id, daemonSession, f); return v.ok ? v.milestone : v.reason; });
    out[policy] = { beforeSpawn, beforeSubscribe, announced, types: frames.map(f => f.type), exec: frames[0] && frames[0].exec,
      accepted, ready: readiness.inputTransportReady(daemonSession), registryCalls: calls, writes: b.writes.length };
  }
  const legacy = createBridge(t, { sid: 'hs-legacy', inputPolicy: 'guarded', withChild: false, nonce: null });
  legacy.shared.command = process.execPath;
  legacy.allow.subscribeChild(legacy.allow.spawnChild(), () => {}, () => {});
  out.legacyNoNonce = legacy.allow.announceTransportReady();
  const expected = { beforeSpawn: false, beforeSubscribe: false, announced: true, types: ['process_started', 'input_transport_ready'], exec: 'unverified',
    accepted: ['process_started', 'input_transport_ready'], ready: true, registryCalls: {}, writes: 0 };
  assert.deepEqual({ ...out, screens }, { 'user-supervised': expected, guarded: expected, legacyNoNonce: false, screens: { constructed: 0, reads: 0 } });
});

// ===== F4 production handler: supervised zero-screen, guarded modal withholding =====================

test('F4 production handleOwnerInject: supervised on a modal frame writes body then CR with zero registry/VT reads', { timeout: 30000 }, async t => {
  const screens = countScreens(t);
  const { proxy, calls } = countingRegistry();
  const b = createBridge(t, { sid: 'p-sup', inputPolicy: 'user-supervised', readyRegistry: proxy });
  b.feed(MODAL_STREAM);
  const { inject_id, body, submit } = b.pair('P-SUP-BODY');
  const r1 = b.allow.handleOwnerInject(body);
  const r2 = b.allow.handleOwnerInject(submit);
  await b.clock.advance(3000);
  assert.deepEqual({ writes: b.writes, calls, screens, receipts: b.receipts(inject_id), r1, r2 },
    { writes: ['P-SUP-BODY', '\r'], calls: {}, screens: { constructed: 0, reads: 0 },
      receipts: ['body:pty_written:written', 'submit:pty_written:written'],
      r1: { rawData: 'P-SUP-BODY', textWritten: true }, r2: { rawData: '\r', textWritten: false } });
});

test('F4 production handleOwnerInject: a guarded worker on a genuine permission modal withholds body and submit (modal_ui)', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'p-guard', inputPolicy: 'guarded' });
  b.feed(MODAL_STREAM);
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 20));  // real xterm parser settle
  const { inject_id, body, submit } = b.pair('P-GUARD-BODY');
  b.allow.handleOwnerInject({ ...body, input_policy: 'user-supervised', role: 'orchestrator', from: 'orchestrator' });
  b.allow.handleOwnerInject(submit);
  await b.clock.advance(17000);
  assert.deepEqual({ writes: b.writes, withheld: b.receipts(inject_id).filter(r => r.includes(':withheld:')), policy: b.allow.bridgeQueueSummary().input_policy },
    { writes: [], withheld: ['body:withheld:not_written:modal_ui', 'submit:withheld:not_written:modal_ui'], policy: 'guarded' });
});

// ===== F5 / F6 ========================================================================================

test('F5 id-less lone CR adjacent to an unwritten body is refused; a keystroke or an ordinary id-less CR is unaffected', { timeout: 60000 }, async t => {
  const b = createBridge(t, { sid: 'lone-cr', inputPolicy: 'user-supervised' });
  const typing = now => { b.shared.lastUserInputTime = now; };
  const plain = b.allow.handleOwnerInject({ type: 'inject', data: '\r' });              // no prior body: ordinary
  const writesBefore = b.writes.slice();
  typing(b.clock.now());
  const { body } = b.pair('LONE-BODY');
  b.allow.handleOwnerInject(body);                                                       // typing -> queued
  await b.clock.advance(602000, typing);                                                 // TTL expiry while typing; no keystroke after it
  await b.clock.advance(5000);
  b.allow.handleOwnerInject({ type: 'inject', data: '\r' });                             // old daemon: no ids
  b.allow.handleOwnerInject({ type: 'inject', data: '\r', daemon_msg_id: 'submit:term', part: 'submit', owner_generation: GEN }); // terminal-level submit
  const refused = b.frames('bridge_receipt').filter(r => r.stage === 'refused').map(r => `${r.part}:${r.reason}`);
  const writesAfterRefusal = b.writes.slice();
  b.shared.lastUserInputTime = b.clock.now() + 1;                                         // the user typed: adjacency broken
  await b.clock.advance(3000);
  b.allow.handleOwnerInject({ type: 'inject', data: '\r' });
  assert.deepEqual({ plain, writesBefore, refused, writesAfterRefusal, final: b.writes },
    { plain: { rawData: '\r', textWritten: false }, writesBefore: ['\r'], refused: ['null:pair_unwritten', 'submit:pair_unwritten'],
      writesAfterRefusal: ['\r'], final: ['\r', '\r'] });
});

test('F6 supervised withhold reason is derived from state, never the fixed transport_unavailable label', { timeout: 30000 }, async t => {
  const b = createBridge(t, { sid: 'f6', inputPolicy: 'user-supervised' });
  b.shared.lastUserInputTime = b.clock.now();
  const { inject_id, body } = b.pair('F6-BODY');
  b.allow.handleOwnerInject(body);
  await b.clock.advance(16000, now => { b.shared.lastUserInputTime = now; });           // the user keeps typing
  const summary = b.allow.bridgeQueueSummary();
  assert.deepEqual({ withheld: b.receipts(inject_id).filter(r => r.includes(':withheld:')), phase: summary.phase, reason: summary.reason,
    fixedLabel: b.sends.some(raw => raw.includes('"transport_unavailable"')), writes: b.writes },
  { withheld: ['body:withheld:not_written:user_input_recent'], phase: 'stalled', reason: 'user_input_recent', fixedLabel: false, writes: [] });
});

// ===== receipts ======================================================================================

test('receipt semantics: milestones are not receipt stages; instruction_received stays unknown without a message-bound provider ACK', () => {
  const base = { type: 'bridge_receipt', schema: 1, daemon_msg_id: 'd1', inject_id: '00000000-0000-4000-8000-000000000001', part: 'body',
    bridge_msg_id: null, reason: null, bridge_seq: 1, at_ms: 1, clock: 'bridge_wall', owner_generation: GEN };
  const stage = s => bridgeStage.validateBridgeReceipt({ ...base, stage: s, certainty: 'written' }, GEN).reason || 'ok';
  const at = 100000;
  const record = { inject_id: base.inject_id, session_id: 'exact', session_epoch: 'epoch', owner_generation: 'owner', created_at: new Date(at - 2000).toISOString(),
    tracking_state: 'tracked', observations: [{ kind: 'bridge_receipt', stage: 'pty_written', part: 'body', certainty: 'written', at: new Date(at - 1000).toISOString() },
      { kind: 'bridge_receipt', stage: 'pty_written', part: 'submit', certainty: 'written', at: new Date(at - 900).toISOString() }] };
  const c = correlateRequest(record, { injectId: base.inject_id, sessionId: 'exact', sessionEpoch: 'epoch', ownerGeneration: 'owner', now: at });
  const { s } = handshakeSession();
  assert.deepEqual({ stages: ['process_started', 'input_transport_ready', 'instruction_received', 'consumed'].map(stage),
    written: [c.input_written.status, c.submit_written.status], instruction: c.instruction_received, consumption: c.consumption.status,
    viewMeaning: readiness.view(s).meaning },
  { stages: ['stage', 'stage', 'stage', 'stage'], written: ['observed', 'observed'],
    instruction: { status: 'unknown', reason: 'no_message_bound_provider_acknowledgement' }, consumption: 'unknown',
    viewMeaning: 'transport_only_not_instruction_receipt' });
});
