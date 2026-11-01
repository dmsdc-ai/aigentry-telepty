'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
const { createExternalApprovalVerifier, parseExternalApprovalPolicy } = require('../src/external-approval');
const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const signed = document => ({ document, signature: crypto.sign(null, Buffer.from(JSON.stringify(document)), keys.privateKey).toString('base64url') });
let daemon;
before(async () => { daemon = await startTestDaemon({ env: { TELEPTY_AUDIT_PREVIEW: '1' } }); });
after(async () => { if (daemon) await daemon.stop(); });
async function protectedOwner() {
  const sid = createSessionId('signed78');
  const reg = await daemon.registerSession(sid, { command: 'test-wrap', external_approval_policy: { public_key_spki: publicKey } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const WebSocket = require('ws');
  const owner = new WebSocket(`ws://${daemon.host}:${daemon.port}/api/sessions/${sid}?owner=1&token=${encodeURIComponent(daemon.authToken())}`, daemon.ownerAuth(sid));
  const frames = [];
  owner.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'inject') frames.push(msg.data); });
  await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
  return { sid, reg, owner, frames };
}
async function approval(sid, prompt, noEnter = true) {
  const result = await daemon.request(`/api/sessions/${sid}/approval-challenge`, { method: 'POST',
    body: { operation: 'inject', no_enter: noEnter, payload_sha256: digest(prompt) } });
  assert.equal(result.status, 200); return signed(result.body.approval);
}
const inject = (sid, prompt, external_approval, no_enter = true) => daemon.request(`/api/sessions/${sid}/inject`, {
  method: 'POST', body: { prompt, no_enter, external_approval } });

test('signed direct inject accepts exact message once; replay/payload/noEnter mismatches write nothing', async t => {
  const f = await protectedOwner(); t.after(() => f.owner.close());
  assert.equal((await inject(f.sid, 'unsigned')).status, 403);
  const ticket = await approval(f.sid, 'approved');
  assert.equal((await inject(f.sid, 'changed', ticket)).status, 403);
  assert.equal((await inject(f.sid, 'approved', ticket, false)).status, 403);
  assert.equal((await inject(f.sid, 'approved', ticket)).status, 200);
  await daemon.waitFor(() => f.frames.length === 1);
  assert.deepEqual(f.frames, ['approved']);
  const audit = await daemon.waitFor(async () => {
    const result = await daemon.request('/api/injects?limit=100');
    return (result.body.injects || []).find(item => item.to === f.sid && item.delivery_result === 'success');
  });
  assert.equal(audit.payload_preview, null, 'protected prompt must stay redacted even when legacy preview is enabled');
  assert.equal((await inject(f.sid, 'approved', ticket)).status, 403);
  assert.equal((await inject(f.sid, 'unsigned')).status, 403);
  assert.deepEqual(f.frames, ['approved']);
});

test('signed text+Enter stays paired; standalone submit and viewer/fanout bypasses are denied', async t => {
  const f = await protectedOwner(); t.after(() => f.owner.close());
  const ticket = await approval(f.sid, 'with submit', false);
  assert.equal((await inject(f.sid, 'with submit', ticket, false)).status, 200);
  assert.equal((await daemon.request(`/api/sessions/${f.sid}/submit`, { method: 'POST', body: { force: true } })).status, 403);
  const multicast = await daemon.request('/api/sessions/multicast/inject', { method: 'POST', body: { session_ids: [f.sid], prompt: 'bypass' } });
  assert.equal(multicast.body.results.failed[0].code, 'EXTERNAL_APPROVAL_REQUIRED');
  const broadcast = await daemon.request('/api/sessions/broadcast/inject', { method: 'POST', body: { prompt: 'broadcast bypass' } });
  assert.equal(broadcast.body.results.failed.find(item => item.id === f.sid).code, 'EXTERNAL_APPROVAL_REQUIRED');
  await daemon.request('/api/bus', { method: 'POST', body: { type: 'turn_request', target_agent: f.sid, content: 'bus bypass' } });
  const viewer = await daemon.connectSession(f.sid); t.after(() => viewer.close());
  const refusals = [];
  viewer.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'input_refused') refusals.push(msg); });
  viewer.send(JSON.stringify({ type: 'input', data: 'viewer bypass' }));
  await daemon.waitFor(() => refusals.length === 1);
  assert.equal(refusals[0].code, 'EXTERNAL_APPROVAL_REQUIRED');
  await daemon.waitFor(() => f.frames.length === 2);
  assert.deepEqual(f.frames, ['with submit', '\r']);
  const screen = await daemon.request(`/api/sessions/${f.sid}/screen`);
  assert.equal(screen.status, 200);
});

test('approval policy is immutable and destructive bypass requires current owner credential', async t => {
  const f = await protectedOwner(); t.after(() => f.owner.close());
  assert.equal((await daemon.request(`/api/sessions/${f.sid}/kill`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await daemon.request(`/api/sessions/${f.sid}`, { method: 'DELETE' })).status, 403);
  const rename = await daemon.request(`/api/sessions/${f.sid}`, { method: 'PATCH', body: { new_id: createSessionId('squatted') } });
  assert.equal(rename.status, 403);
  const changed = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: f.sid, external_approval_policy: { public_key_spki: publicKey } } });
  assert.equal(changed.status, 409);
  const noProof = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id: f.sid, delivery_type: 'aterm' } });
  assert.equal(noProof.status, 403);
});

test('verifier rejects expiry, owner/epoch change, wrong signer and restart; cache is bounded', () => {
  let now = 1000;
  const verifier = createExternalApprovalVerifier({ now: () => now, maxPending: 2 });
  const policy = parseExternalApprovalPolicy({ public_key_spki: publicKey }).policy;
  const session = { id: 's', sessionEpoch: 'e', interactionOwnerGeneration: 'g', externalApprovalPolicy: policy };
  const request = { operation: 'inject', no_enter: true, payload_sha256: digest('payload') };
  const a = verifier.challenge(session, request).approval;
  const b = verifier.challenge(session, request).approval;
  assert.equal(verifier.challenge(session, request).code, 'APPROVAL_CAPACITY');
  session.sessionEpoch = 'new'; assert.equal(verifier.verifyAndConsume(session, request, a, signed(a).signature).ok, false); session.sessionEpoch = 'e';
  session.interactionOwnerGeneration = 'new'; assert.equal(verifier.verifyAndConsume(session, request, a, signed(a).signature).ok, false); session.interactionOwnerGeneration = 'g';
  const other = crypto.generateKeyPairSync('ed25519');
  assert.equal(verifier.verifyAndConsume(session, request, a, crypto.sign(null, Buffer.from(JSON.stringify(a)), other.privateKey).toString('base64url')).ok, false);
  const restarted = createExternalApprovalVerifier({ now: () => now });
  assert.equal(restarted.verifyAndConsume(session, request, a, signed(a).signature).ok, false);
  now = b.expires_at;
  assert.equal(verifier.verifyAndConsume(session, request, b, signed(b).signature).code, 'APPROVAL_EXPIRED');
  assert.equal(verifier.challenge(session, request).ok, true);
  assert.ok(parseExternalApprovalPolicy({ public_key_spki: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }).error);
});


test('owner change invalidates issued approval and prevents a deferred Enter reaching replacement', async t => {
  const f = await protectedOwner(); t.after(() => f.owner.close());
  const pending = await approval(f.sid, 'old owner', false);
  const unused = await approval(f.sid, 'never write');
  assert.equal((await inject(f.sid, 'old owner', pending, false)).status, 200);
  await daemon.waitFor(() => f.frames.length === 1);
  const WebSocket = require('ws');
  const replacement = new WebSocket(`ws://${daemon.host}:${daemon.port}/api/sessions/${f.sid}?owner=1&token=${encodeURIComponent(daemon.authToken())}`, daemon.ownerAuth(f.sid));
  t.after(() => replacement.close());
  const frames = [];
  replacement.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'inject') frames.push(msg.data); });
  await new Promise((resolve, reject) => { replacement.once('open', resolve); replacement.once('error', reject); });
  assert.equal((await inject(f.sid, 'never write', unused)).status, 403);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(frames, []);
  assert.deepEqual(f.frames, ['old owner']);
});


test('protected low-level submit, interaction and bootstrap retries cannot bypass approval', async t => {
  const { createSessionDeliveryFixture } = require('../test-support/session-delivery-fixture');
  const fixture = createSessionDeliveryFixture(); t.after(() => fixture.dispose());
  const frames = [];
  const session = { type: 'wrapped', command: 'test-wrap', bootstrapReady: true,
    externalApprovalPolicy: parseExternalApprovalPolicy({ public_key_spki: publicKey }).policy,
    sessionEpoch: 'unit-epoch', ownerWs: { readyState: 1, send: raw => frames.push(raw) } };
  assert.equal((await fixture.deliverInjectionToSession('protected', session, 'bypass')).success, false);
  assert.equal(fixture.submitViaPty(session), false);
  assert.equal(fixture.terminalLevelSubmit('protected', session), null);
  const retried = await fixture.executeBootstrapInject('protected', session, { prompt: 'retry bypass', noEnter: true });
  assert.equal(retried.code, 'EXTERNAL_APPROVAL_REQUIRED');
  const interaction = await fixture.dispatchInteraction({ request: { identity: { sid: 'protected' } } });
  assert.equal(interaction.reason, 'unsupported_capability');
  assert.deepEqual(frames, []);
});
