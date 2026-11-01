'use strict';
const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { skip: process.platform !== 'linux' }, fn);
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const { execFile } = require('node:child_process');
const { createHttpApp, registerHealthAndAuth } = require('../src/protocol/http-app');
const { createAuthMiddleware } = require('../src/protocol/http-auth');
const { validateTrustConfiguration } = require('../src/principal/proof');
const { createPrincipalAuthentication, verifiedRequestPrincipal } = require('../src/principal/http');
const { registerReadinessRoute, recordReadyEvidence } = require('../src/readiness');
async function fixture(t, { response, foreign = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'principal-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync('ed25519');
  const trust = validateTrustConfiguration({ schema: 'telepty.principals/v1', audience: 'fixture', keys: [{ key_id: 'reader', principal_id: 'reader',
    public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }), grants: [{ action: 'session.inspect', targets: ['mine'] }] }] });
  const session = { id: 'mine', type: 'wrapped', command: 'claude', sessionEpoch: 'current-epoch', interactionOwnerGeneration: 'owner',
    ownerWs: { readyState: 1 }, outputRing: [], readyKind: 'composer_surface_observed', readyDetector: 'claude_composer', readyCliKey: 'claude',
    owningPrincipal: { id: foreign ? 'other' : 'reader', source: 'ed25519', audience: 'fixture' } };
  recordReadyEvidence(session);
  const sessions = { mine: session }, authentication = createPrincipalAuthentication({ trust, sessions });
  const app = createHttpApp({ express: require('express'), cors: require('cors') });
  const requests = [], accepted = [];
  app.use((req, _res, next) => { requests.push({ method: req.method, url: req.url, headers: req.headers }); next(); });
  registerHealthAndAuth(app, { pkg: { version: 'fixture' }, createAuthMiddleware, isAllowedPeer: () => true, EXPECTED_TOKEN: 'unused-legacy',
    verifyJwt: () => true, authorizeSessionRequest: () => true, principalAuthentication: authentication });
  app.use((req, _res, next) => { accepted.push(verifiedRequestPrincipal(req)?.id); next(); });
  if (response) app.get('/api/sessions/:id/handshake', (_req, res) => res.json(response()));
  else registerReadinessRoute(app, { sessions, machineId: 'fixture' });
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const key = path.join(root, 'key'), config = path.join(root, 'config');
  fs.writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ schema: 'telepty.principal-client/v1', daemon_url: `http://127.0.0.1:${server.address().port}`,
    principal_id: 'reader', key_id: 'reader', audience: 'fixture', private_key_path: key }), { mode: 0o600 });
  const args = ['--config', config, '--session', 'mine', '--epoch', 'current-epoch'];
  const inspect = extra => require('../src/principal/readiness-cli').runPrincipalReadiness(args, extra);
  return { root, session, requests, accepted, config, key, args, inspect };
}
test('actual signed inspection is accepted without registration, mutation or legacy credentials', async t => {
  const f = await fixture(t), before = JSON.stringify(f.session);
  const result = await f.inspect();
  assert.equal(result.ready, true); assert.equal(result.session_epoch, 'current-epoch');
  assert.equal(result.authentication_observation, 'signed_request_http_2xx');
  assert.equal(result.authenticated_registration, 'unverified');
  assert.equal(result.completion_fact, null); assert.equal(result.terminal, false);
  assert.equal(result.consumption, 'unknown'); assert.equal(result.reply, 'unknown');
  assert.deepEqual(f.accepted, ['reader']);
  assert.equal(JSON.stringify(f.session), before);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.method, 'GET');
    for (const header of ['x-telepty-token', 'authorization', 'x-telepty-session-token']) assert.equal(request.headers[header], undefined);
  }
  assert.match(f.requests[1].url, /^\/api\/sessions\/mine\/handshake\?timeout_ms=0&session_epoch=current-epoch$/);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['config', 'key']);
});
test('stale epoch, foreign owner and wrong signer refuse without fallback or registration', async t => {
  for (const mode of ['epoch', 'owner', 'key']) {
    const f = await fixture(t, { foreign: mode === 'owner' });
    if (mode === 'epoch') f.args[5] = 'stale';
    if (mode === 'key') fs.writeFileSync(f.key, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await assert.rejects(f.inspect(), { code: 'PRINCIPAL_READINESS_REFUSED' });
    assert.equal(f.requests.length, 2); assert.deepEqual(f.accepted, []);
  }
});
const snapshot = () => ({ schema: 'telepty.readiness/v1', session_id: 'mine', session_epoch: 'current-epoch', ready: false, status: 'unknown',
  reason: 'no_current_composer_evidence', observed_at: null, sampled_at: new Date().toISOString(), completion_fact: null, terminal: false });
test('malformed, stale or completion-claiming responses never become readiness observations', async t => {
  for (const change of [{ schema: 'other' }, { session_id: 'other' }, { session_epoch: 'stale' }, { ready: true },
    { completion_fact: 'done' }, { terminal: true }, { reason: 'private arbitrary text' }, { sampled_at: 'invalid' }, { huge: 'x'.repeat(17000) }]) {
    const f = await fixture(t, { response: () => ({ ...snapshot(), ...change }) });
    await assert.rejects(f.inspect(), { code: 'PRINCIPAL_READINESS_RESPONSE_INVALID' });
  }
});
test('unknown readiness stays unknown and unrecognized fields are not echoed', async t => {
  const f = await fixture(t, { response: () => ({ ...snapshot(), raw: 'private-output-do-not-echo' }) });
  const result = await f.inspect();
  assert.equal(result.ready, false); assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-output-do-not-echo'));
});
test('cancelled or invalid usage refuses before opening a request', async t => {
  const f = await fixture(t);
  await assert.rejects(f.inspect({ signal: AbortSignal.abort() }), { code: 'PRINCIPAL_READINESS_CANCELLED' });
  const run = require('../src/principal/readiness-cli').runPrincipalReadiness;
  for (const args of [[], [...f.args, '--register'], ['--config', f.config, '--session', '../unsafe', '--epoch', 'epoch']]) await assert.rejects(run(args));
  assert.equal(f.requests.length, 0);
});
test('actual CLI prints one sanitized observation and exits nonzero on refusal', async t => {
  const f = await fixture(t), cli = path.join(__dirname, '../cli.js');
  const run = args => new Promise(resolve => execFile(process.execPath, [cli, 'principal-readiness-v1', ...args], {
    env: { ...process.env, HOME: f.root, USERPROFILE: f.root, TELEPTY_AUTH_TOKEN: 'must-not-send' }, timeout: 10000
  }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  const result = await run(f.args); assert.equal(result.error, null, result.stderr);
  assert.equal(JSON.parse(result.stdout).authentication_observation, 'signed_request_http_2xx');
  f.args[5] = 'stale'; const refused = await run(f.args);
  assert.equal(refused.error?.code, 1); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /PRINCIPAL_READINESS_REFUSED/);
  assert.equal(fs.existsSync(path.join(f.root, '.telepty', 'config.json')), false);
});
