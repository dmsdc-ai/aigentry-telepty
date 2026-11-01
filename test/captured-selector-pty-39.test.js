'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const pty = require('node-pty');
const { startTestDaemon, waitFor, createSessionId } = require('../test-support/daemon-harness');
const { PROFILE, CODEX_PROFILE } = require('../src/vt/captured-selector');
const I = require('../src/interaction');
const root = path.resolve(__dirname, '..');
function action(sid, observation, operation, value, id) {
  return { schema_version: 1, action_id: id, interaction_request_id: 'fixture-request-' + id,
    identity: { kind: 'manual', sid },
    expected: Object.fromEntries([...I.FENCE_FIELDS, 'question_id'].map(key => [key, observation[key]])),
    operation, value, authority: { provenance: 'controller-policy', reference: 'fixture-color-policy' }, expires_at: Date.now() + 1500 };
}
function spawnBridge(daemon, sid, result, profile, mode = '') {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TELEPTY_')) delete env[key];
  Object.assign(env, { HOME: daemon.homeDir, USERPROFILE: daemon.homeDir, TELEPTY_HOST: daemon.host,
    TELEPTY_PORT: String(daemon.port), TELEPTY_AUTH_TOKEN: daemon.authToken(), TELEPTY_NO_TAILNET_AUTO: '1',
    TELEPTY_NO_SUPERVISOR_DEFER: '1', TELEPTY_CLIENT_RESTART: 'off', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
    TELEPTY_INTERACTION_PROFILE: profile, TELEPTY_FAKE_TUI_RESULT: result, TELEPTY_FAKE_TUI_MODE: mode });
  const child = pty.spawn(process.execPath, ['cli.js', 'allow', '--id', sid, '--idle-ttl', 'off', '--', process.execPath,
    path.join(root, 'test-support/captured-selector-tui-39.js')], { cwd: root, env, cols: 140, rows: 30, name: 'xterm-256color' });
  const bridge = { child, output: '', exited: false };
  child.onData(data => { bridge.output += data; }); child.onExit(() => { bridge.exited = true; });
  return bridge;
}
async function stop(bridge) {
  if (!bridge || bridge.exited) return;
  try { bridge.child.write('EXIT'); } catch {}
  try { await waitFor(() => bridge.exited, { timeoutMs: 2000 }); return; } catch {}
  try { bridge.child.kill('SIGTERM'); } catch {}
  await waitFor(() => bridge.exited, { timeoutMs: 3000 });
}
test('captured routine selector: real VT + actual bridge writer/HTTP receipt drives only own fake PTY', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selector-39-'));
  const daemon = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: crypto.randomBytes(32).toString('hex'), TELEPTY_NO_TAILNET_AUTO: '1' } });
  let bridge;
  t.after(async () => { await stop(bridge); await daemon.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sid = createSessionId('selector-39'); const result = path.join(directory, 'result.json');
  bridge = spawnBridge(daemon, sid, result, PROFILE);
  const observation = await waitFor(async () => {
    const response = await daemon.request(`/api/sessions/${sid}/interaction`);
    return response.body?.routine === true ? response.body : false;
  }, { timeoutMs: 10000, description: 'bounded live captured-selector observation' });
  assert.equal(observation.native_behavior_verified, false);
  assert.equal(observation.version_evidence, 'operator-selected-captured-profile');
  assert.deepEqual(observation.supported_operations, ['select']);
  const raw = await daemon.request(`/api/sessions/${sid}/interaction`, { method: 'POST', body: action(sid, observation, 'key', 'enter', 'raw') });
  assert.equal(raw.body.bytes_written, 0); assert.equal(raw.body.stage, 'refused'); assert.equal(fs.existsSync(result), false);
  const staleRequest = action(sid, { ...observation, geometry_generation: observation.geometry_generation + 1 }, 'select', 'blue', 'stale');
  const stale = await daemon.request(`/api/sessions/${sid}/interaction`, { method: 'POST', body: staleRequest });
  assert.equal(stale.body.stage, 'refused'); assert.equal(fs.existsSync(result), false);
  const request = action(sid, observation, 'select', 'blue', 'select-blue');
  const receipt = await daemon.request(`/api/sessions/${sid}/interaction`, { method: 'POST', body: request });
  assert.equal(receipt.body.stage, 'written', JSON.stringify(receipt.body)); assert.equal(receipt.body.bytes_written, 4);
  await waitFor(() => fs.existsSync(result), { timeoutMs: 3000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { selected: 'blue', count: 1 });
  const repeated = await daemon.request(`/api/sessions/${sid}/interaction`, { method: 'POST', body: request });
  assert.equal(repeated.body.stage, 'written');
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { selected: 'blue', count: 1 });
});
test('captured Codex update remains observed but unwriteable through typed or raw interaction', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selector-update-39-'));
  const daemon = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: crypto.randomBytes(32).toString('hex'), TELEPTY_NO_TAILNET_AUTO: '1' } });
  let bridge;
  t.after(async () => { await stop(bridge); await daemon.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sid = createSessionId('selector-update-39'); const result = path.join(directory, 'result.json');
  bridge = spawnBridge(daemon, sid, result, CODEX_PROFILE, 'update');
  const observation = await waitFor(async () => {
    const response = await daemon.request(`/api/sessions/${sid}/interaction`);
    return response.body?.mode === 'permission_trust' ? response.body : false;
  }, { timeoutMs: 10000, description: 'captured update refusal observation' });
  assert.deepEqual(observation.supported_operations, []);
  for (const [operation, value] of [['select', 'skip'], ['key', 'enter'], ['confirm', 'yes']]) {
    const response = await daemon.request(`/api/sessions/${sid}/interaction`, { method: 'POST', body: action(sid, observation, operation, value, operation) });
    assert.equal(response.body.stage, 'refused'); assert.equal(response.body.bytes_written, 0);
  }
  assert.equal(fs.existsSync(result), false);
});

test('externally protected session cannot enable this provider or bypass signatures with typed/raw/submit operations', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const daemon = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: crypto.randomBytes(32).toString('hex'), TELEPTY_NO_TAILNET_AUTO: '1' } });
  t.after(() => daemon.stop());
  const sid = createSessionId('selector-protected-39');
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = await daemon.registerSession(sid, { command: 'synthetic-protected', external_approval_policy: {
    public_key_spki: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } });
  assert.equal(registered.status, 201);
  const WebSocket = require('ws');
  const owner = new WebSocket(`ws://${daemon.host}:${daemon.port}/api/sessions/${sid}?owner=1&token=${encodeURIComponent(daemon.authToken())}`, daemon.ownerAuth(sid));
  const frames = [];
  owner.on('message', raw => frames.push(JSON.parse(raw)));
  t.after(() => owner.close());
  const ack = await waitFor(() => frames.find(frame => frame.type === 'owner_token'), { timeoutMs: 3000 });
  owner.send(JSON.stringify({ type: 'interaction_provider', profile: PROFILE, stream_id: crypto.randomUUID(),
    owner_generation: ack.interaction_binding.owner_generation, cols: 140, rows: 30 }));
  owner.send(JSON.stringify({ type: 'output', data: require('./fixtures/captured-selector-39').paint(require('./fixtures/captured-selector-39').claudeColor) }));
  const observation = (await daemon.request(`/api/sessions/${sid}/interaction`)).body;
  assert.equal(observation.available, false); assert.equal(observation.live_adapter, false);
  const expected = { ...ack.interaction_binding, cols: 140, rows: 30, prompt_revision: 'fixture', frame_digest: '0'.repeat(64), question_id: 'claude-color-2.1.220-v1' };
  for (const [operation, value] of [['select', 'blue'], ['key', 'enter']]) {
    const response = await daemon.request(`/api/sessions/${sid}/interaction`, { method: 'POST', body: action(sid, expected, operation, value, 'protected-' + operation) });
    assert.equal(response.body.stage, 'refused'); assert.equal(response.body.bytes_written, 0);
  }
  assert.equal((await daemon.request(`/api/sessions/${sid}/submit`, { method: 'POST', body: { force: true } })).status, 403);
  assert.ok(!frames.some(frame => ['interaction', 'inject'].includes(frame.type)));
});
