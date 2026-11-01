'use strict';

// Task 1215 R1 — user-supervised authority is the server-verified strict operator principal only.
//
// Real product callers: createAuthMiddleware (src/protocol/http-auth.js) with and without the real
// createPrincipalAuthentication (src/principal/http.js) built on validateTrustConfiguration; real Ed25519
// assertions from createSignedAssertion (src/principal/proof.js); the real register route
// (registerSessionRegisterRoute + createSessionRecordContext + createCredentialStore); the production
// claim shape bindInputPolicy(session, now, { capability }) exactly as websocket.js calls it; the real
// delivery-runtime modalDeliveryDecision. The decisive verifier is never stubbed and no verified-request
// property is written by the test. Declared fakes: req/res objects, an in-memory trust document (the
// trust FILE loader is Linux-only and is not the decision), the owner socket stand-in.
// "PRECONDITION:" assertions validate setup (failure = INVALID, not product RED).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policies = require('../src/mailbox/input-policy');
const registry = require('../src/prompt-symbol-registry');
const routeMetadata = require('../src/session-store/route-metadata');
const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
const { createPrincipalAuthentication, loadPrincipalTrust } = require('../src/principal/http');
const { createAuthMiddleware } = require('../src/protocol/http-auth');
const { registerSessionRegisterRoute, createSessionRecordContext } = require('../src/routes/session-records');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { createDeliveryRuntime } = require('../src/mailbox/delivery-runtime');

const HOST_TOKEN = 'host-token-shared-with-children';
const AUDIENCE = 'telepty-1215-operator-fixture';
const TARGET = '/api/sessions/register';
const KEYS = { operator: crypto.generateKeyPairSync('ed25519'), worker: crypto.generateKeyPairSync('ed25519'),
  unenrolled: crypto.generateKeyPairSync('ed25519') };
const SIDS = ['op-orch', 'op-orch-2', 'op-aterm', 'op-bearer', 'op-host', 'op-worker', 'op-forged', 'op-stale', 'op-replay', 'op-body', 'op-np'];
const MODAL_RING = ['\x1b[2J> You are in /tmp/x\n\nDo you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue\n'];
const spki = key => key.publicKey.export({ type: 'spki', format: 'pem' });

function fixture(t, { trustFromFile = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-1215-operator-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = {};
  const sessionCredentials = createCredentialStore();
  const context = createSessionRecordContext({ sessions, sessionCredentials, sidNonces: new Map(), sessionPersistPath: path.join(dir, 'sessions.json') });
  let handler;
  registerSessionRegisterRoute({ post: (_p, h) => { handler = h; } }, { context, sessionStateManager: { register() {} }, busClients: new Set(),
    getMailbox: () => { throw new Error('PRECONDITION: no mailbox in this fixture'); } });
  const trustDocument = { schema: 'telepty.principals/v1', audience: AUDIENCE, keys: [
    { key_id: 'operator-key', principal_id: 'operator', authority: 'operator', public_key_spki: spki(KEYS.operator),
      grants: [{ action: 'session.register', targets: SIDS }] },
    { key_id: 'worker-key', principal_id: 'worker', authority: 'principal', public_key_spki: spki(KEYS.worker),
      grants: [{ action: 'session.register', targets: SIDS }] }] };
  // darwin-resume2: optionally through the REAL trust-file loader (readAuthorityFile) instead of memory.
  let trust;
  if (trustFromFile) {
    const trustFile = path.join(fs.realpathSync(dir), 'trust.json');
    fs.writeFileSync(trustFile, JSON.stringify(trustDocument), { mode: 0o600 });
    trust = loadPrincipalTrust(trustFile, { audience: AUDIENCE });
  } else trust = validateTrustConfiguration(trustDocument);
  const principalAuth = createPrincipalAuthentication({ trust, sessions });
  const common = { expectedToken: HOST_TOKEN, isAllowedPeer: () => true, verifyJwt: () => false, isForbiddenOrigin: () => false };
  const legacy = createAuthMiddleware(common);
  const strict = createAuthMiddleware({ ...common, principalAuthentication: principalAuth });
  const warn = console.warn; const log = console.log;
  console.warn = () => {}; console.log = () => {};
  t.after(() => { console.warn = warn; console.log = log; });

  function sign(body, { key = KEYS.operator, keyId = 'operator-key', principalId = 'operator', issuedAt } = {}) {
    const existing = sessions[body.session_id];
    return createSignedAssertion({ privateKey: key.privateKey, keyId, principalId, audience: AUDIENCE, challenge: principalAuth.verifier.challenge,
      method: 'POST', target: TARGET, body, action: 'session.register', ...(existing ? { sessionEpoch: existing.sessionEpoch } : {}),
      ...(issuedAt !== undefined ? { issuedAt } : {}) });
  }
  // mode 'legacy': legacy daemon, shared host token in x-telepty-token. mode 'strict': strict daemon;
  // `signer` signs EXACTLY the sent body (or `signedBody` when testing a mismatch); `principal` sends a
  // pre-built header verbatim (replay).
  function send(mode, input, { signer = null, signedBody = null, principal = null, bearer = null, capability = null, hostToken = mode === 'legacy' } = {}) {
    const body = { cwd: dir, ...input };
    const header = principal || (signer ? sign(signedBody ? { cwd: dir, ...signedBody } : body, signer) : null);
    const headers = { ...(hostToken ? { 'x-telepty-token': HOST_TOKEN } : {}), ...(header ? { 'x-telepty-principal': header } : {}),
      ...(bearer ? { 'x-telepty-session-token': bearer } : {}), ...(capability ? { [policies.CAPABILITY_HEADER]: capability } : {}) };
    const req = { method: 'POST', url: TARGET, originalUrl: TARGET, ip: '127.0.0.1', headers, rawHeaders: Object.entries(headers).flat(),
      body, principalRawBody: Buffer.from(JSON.stringify(body)) };
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let admitted = false;
    (mode === 'strict' ? strict : legacy)(req, res, () => { admitted = true; });
    if (admitted) handler(req, res);
    return { admitted, status: res.statusCode, body: res.body || {}, header };
  }
  let gen = 0;
  function claim(sid, capability) {   // websocket.js owner-claim shape
    const s = sessions[sid];
    s.interactionOwnerGeneration = `op-claim-${++gen}`;
    s.ownerWs = { readyState: 1 };
    policies.bindInputPolicy(s, new Date(), { capability });
    return s;
  }
  return { sessions, send, sign, claim };
}
function modalRuntime() {
  return createDeliveryRuntime({ readyRegistry: registry, MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
    MODAL_REMEDY_BY_CLI: { claude: 'park' }, MODAL_REMEDY_DEFAULT: 'hold', MODAL_HINT_BY_CLI: { codex: 'hint' }, MODAL_RING_TAIL_BYTES: 65536,
    isBootstrapGatedSession: routeMetadata.isBootstrapGatedSession, initializeBootstrapState: routeMetadata.initializeBootstrapState });
}
const outcome = r => [r.admitted, r.status, r.body.input_policy_pending ?? null, r.body.input_policy_refused ?? r.body.code ?? null,
  Object.hasOwn(r.body, 'input_policy_capability')];

test('R1 legacy daemon: omitted session headers + the shared host token are admitted but never granted supervision', { timeout: 30000 }, t => {
  const f = fixture(t);
  const dm = modalRuntime();
  const nested = f.send('legacy', { session_id: 'op-host', command: 'codex', input_policy: 'user-supervised' });
  const s = f.claim('op-host', 'C'.repeat(43));
  s.outputRing = MODAL_RING.slice();
  const guardedLaunch = f.send('legacy', { session_id: 'op-worker', command: 'codex' });   // legacy guarded operation still works
  assert.deepEqual({ nested: outcome(nested), effective: policies.effectiveInputPolicy(s), modal: dm.modalDeliveryDecision(s, {}, {}).action,
    guarded: [guardedLaunch.status, typeof guardedLaunch.body.session_token, policies.effectiveInputPolicy(f.claim('op-worker'))] },
  { nested: [true, 201, false, 'INPUT_POLICY_OPERATOR_REQUIRED', false], effective: 'guarded', modal: 'hold', guarded: [201, 'string', 'guarded'] });
});

test('R1 session bearer is never authority, in legacy or alongside a valid operator signature', { timeout: 30000 }, t => {
  const f = fixture(t);
  const worker = f.send('legacy', { session_id: 'op-worker', command: 'codex' });
  assert.equal(worker.status, 201, 'PRECONDITION: worker registered');
  const legacyBearer = f.send('legacy', { session_id: 'op-bearer', command: 'codex', input_policy: 'user-supervised' }, { bearer: worker.body.session_token });
  const strictBearer = f.send('strict', { session_id: 'op-orch', command: 'codex', input_policy: 'user-supervised' },
    { signer: {}, bearer: worker.body.session_token });
  assert.deepEqual({ legacyBearer: outcome(legacyBearer), strictBearer: outcome(strictBearer) },
    { legacyBearer: [true, 201, false, 'INPUT_POLICY_SESSION_BEARER', false], strictBearer: [true, 201, false, 'INPUT_POLICY_SESSION_BEARER', false] });
});

test('R1 forged, stale, replayed, body-mismatched and non-operator principals cannot open a supervised instance', { timeout: 30000 }, t => {
  const f = fixture(t);
  const ask = sid => ({ session_id: sid, command: 'codex', input_policy: 'user-supervised' });
  const forged = f.send('strict', ask('op-forged'), { signer: { key: KEYS.unenrolled } });             // claims operator-key, wrong private key
  const stale = f.send('strict', ask('op-stale'), { signer: { issuedAt: Math.floor(Date.now() / 1000) - 120 } });
  const bodyMismatch = f.send('strict', ask('op-body'), { signer: {}, signedBody: { session_id: 'op-body', command: 'codex', input_policy: 'guarded' } });
  const nonOperator = f.send('strict', ask('op-np'), { signer: { key: KEYS.worker, keyId: 'worker-key', principalId: 'worker' } });
  const noPrincipalTokenOnly = f.send('strict', ask('op-host'), { hostToken: true });                  // strict daemon ignores the host token
  // Nonce replay: the first use is admitted (nonce consumed) but the route rejects its body, so no record
  // exists and the replay reaches the replay cache. A replay after a record exists fails its epoch binding.
  const invalid = { session_id: 'op-replay', command: 'codex', input_policy: 'USER-SUPERVISED' };
  const first = f.send('strict', invalid, { signer: {} });
  assert.deepEqual([first.admitted, first.status, Object.hasOwn(f.sessions, 'op-replay')], [true, 400, false], 'PRECONDITION: first use admitted, no record');
  const replay = f.send('strict', invalid, { principal: first.header });
  const created = f.send('strict', ask('op-orch-2'), { signer: {} });
  assert.equal(created.status, 201, `PRECONDITION: operator request ${JSON.stringify(created.body)}`);
  const replayExisting = f.send('strict', ask('op-orch-2'), { principal: created.header });
  const refusedAtAuth = r => [r.admitted, r.status, r.body.code ?? null, Object.hasOwn(r.body, 'input_policy_capability'), Object.hasOwn(f.sessions, r.sid)];
  assert.deepEqual({
    forged: refusedAtAuth({ ...forged, sid: 'op-forged' }), stale: refusedAtAuth({ ...stale, sid: 'op-stale' }),
    bodyMismatch: refusedAtAuth({ ...bodyMismatch, sid: 'op-body' }), nonOperator: refusedAtAuth({ ...nonOperator, sid: 'op-np' }),
    tokenOnly: [noPrincipalTokenOnly.admitted, noPrincipalTokenOnly.status, Object.hasOwn(noPrincipalTokenOnly.body, 'input_policy_capability')],
    replay: [replay.admitted, replay.status, replay.body.code ?? null, Object.hasOwn(replay.body, 'input_policy_capability')],
    replayExisting: [replayExisting.admitted, replayExisting.status, replayExisting.body.code ?? null],
  }, {
    forged: [false, 401, 'PRINCIPAL_PROOF_INVALID', false, false], stale: [false, 401, 'PRINCIPAL_PROOF_INVALID', false, false],
    bodyMismatch: [false, 401, 'PRINCIPAL_PROOF_INVALID', false, false], nonOperator: [false, 403, 'PRINCIPAL_OPERATOR_REQUIRED', false, false],
    tokenOnly: [false, 401, false], replay: [false, 409, 'PRINCIPAL_REPLAY', false], replayExisting: [false, 401, 'PRINCIPAL_PROOF_INVALID'],
  });
});

test('R1 a valid verified operator keeps the feature: capability once, production-shaped bind, modal delivers; bearer-only claim stays guarded', { timeout: 30000 }, t => {
  const f = fixture(t);
  const dm = modalRuntime();
  const reg = f.send('strict', { session_id: 'op-orch', command: 'codex', input_policy: 'user-supervised' }, { signer: {} });
  const cap = reg.body.input_policy_capability;
  const bearerOnly = f.claim('op-orch');
  bearerOnly.outputRing = MODAL_RING.slice();
  const guardedFirst = { effective: policies.effectiveInputPolicy(bearerOnly), modal: dm.modalDeliveryDecision(bearerOnly, {}, {}).action };
  const s = f.claim('op-orch', cap);
  const bound = { effective: policies.effectiveInputPolicy(s), source: s.inputPolicy && s.inputPolicy.source,
    gated: routeMetadata.isBootstrapGatedSession(s), modal: dm.modalDeliveryDecision(s, {}, {}).action };
  // Capability re-request from the same verified operator (bridge reconnect) — and a legacy-token one.
  const reReq = f.send('strict', { session_id: 'op-orch', command: 'codex', input_policy: 'user-supervised' },
    { signer: {}, bearer: reg.body.session_token, capability: cap });
  const aterm = f.send('strict', { session_id: 'op-aterm', command: 'codex', delivery_type: 'aterm', input_policy: 'user-supervised' }, { signer: {} });
  assert.deepEqual({ reg: outcome(reg), capShape: typeof cap === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cap), guardedFirst, bound,
    reReq: outcome(reReq), aterm: outcome(aterm).slice(3) }, {
    reg: [true, 201, true, null, true], capShape: true, guardedFirst: { effective: 'guarded', modal: 'hold' },
    bound: { effective: 'user-supervised', source: 'operator_principal_registration', gated: false, modal: 'deliver' },
    reReq: [true, 200, true, null, false], aterm: ['INPUT_POLICY_UNSUPPORTED', false] });
});

test('the operator positive path through the REAL trust-file loader (Linux /proc reader, Darwin bundled native reader)', { timeout: 30000 }, t => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') { t.skip('authority files are Linux/Darwin-scoped'); return; }
  const f = fixture(t, { trustFromFile: true });
  const reg = f.send('strict', { session_id: 'op-orch', command: 'codex', input_policy: 'user-supervised' }, { signer: {} });
  const legacy = f.send('legacy', { session_id: 'op-host', command: 'codex', input_policy: 'user-supervised' });
  const s = f.claim('op-orch', reg.body.input_policy_capability);
  assert.deepEqual({ reg: outcome(reg), legacy: outcome(legacy), effective: policies.effectiveInputPolicy(s) },
    { reg: [true, 201, true, null, true], legacy: [true, 201, false, 'INPUT_POLICY_OPERATOR_REQUIRED', false], effective: 'user-supervised' });
});
