'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCliSecurityActions, adoptRegistrationCredential, scopedSessionToken } = require('../src/cli/security-actions');
function security(fetch, port = 3848) {
  const shared = { PORT: port, cachedAuthToken: 'synthetic-local-daemon', cachedPeerTokens: null, getConfig: () => ({ authToken: 'synthetic-local-daemon' }),
    crossMachine: { loadPeers: () => ({ peers: { foreign: { host: 'foreign.invalid', port: 3848, token: 'synthetic-foreign-daemon' },
      otherLoopback: { host: '127.0.0.1', port: port + 1, token: 'synthetic-other-daemon' } } }) }, isMainModule: false };
  return createCliSecurityActions(shared, { fetch });
}
async function environment(fn) {
  const keys = ['TELEPTY_AUTH_TOKEN','TELEPTY_SESSION_TOKEN','TELEPTY_SESSION_ORIGIN','TELEPTY_HOST'];
  const saved = keys.map(key => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  try { return await fn(); } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
test('foreign and other-loopback authorities receive only destination daemon credential', async () => environment(async () => {
  process.env.TELEPTY_SESSION_TOKEN = 'synthetic-local-owner'; process.env.TELEPTY_HOST = 'foreign.invalid';
  const calls = [], client = security(async (url, options) => { calls.push({ url, options }); return { ok: true }; });
  await client.fetchWithAuth('http://foreign.invalid:3848/api/sessions', { redirect: 'follow', headers: { 'X-Telepty-Session-Token': 'caller-bypass' } });
  await client.fetchWithAuth('http://127.0.0.1:3849/api/sessions');
  await client.fetchWithAuth('http://127.0.0.1:3848/api/sessions');
  assert.equal(calls[0].options.headers['x-telepty-token'], 'synthetic-foreign-daemon');
  assert.equal(calls[1].options.headers['x-telepty-token'], 'synthetic-other-daemon');
  for (const call of calls.slice(0, 2)) assert.equal(call.options.headers['x-telepty-session-token'], undefined);
  assert.equal(calls[2].options.headers['x-telepty-session-token'], 'synthetic-local-owner');
  for (const call of calls) assert.equal(call.options.redirect, 'error');
}));
test('successful remote issuance binds future owner HTTP and WebSocket claims to exact minted origin', () => {
  const env = {}, childEnv = {};
  assert.equal(adoptRegistrationCredential({ ok: true }, { session_token: 'synthetic-remote-owner' }, env, childEnv, 'http://remote.invalid:4000/api/sessions/register'), true);
  assert.equal(env.TELEPTY_SESSION_ORIGIN, 'http://remote.invalid:4000'); assert.deepEqual(childEnv, env);
  assert.equal(scopedSessionToken('http://remote.invalid:4000/api/sessions', { env }), 'synthetic-remote-owner');
  assert.equal(scopedSessionToken('ws://remote.invalid:4000/api/sessions?owner=1', { env }), 'synthetic-remote-owner');
  for (const url of ['http://remote.invalid:4001','http://other.invalid:4000','http://127.0.0.1:3848']) assert.equal(scopedSessionToken(url, { env }), null);
  const before = { ...env };
  assert.equal(adoptRegistrationCredential({ ok: false }, { session_token: 'synthetic-error' }, env, childEnv, 'http://other.invalid:4000'), false);
  assert.deepEqual(env, before);
  assert.equal(adoptRegistrationCredential({ ok: true }, { session_token: 'synthetic-new' }, env, childEnv, 'file:///tmp'), false);
  assert.deepEqual(env, before);
});
test('invalid binding fails closed and explicit daemon fleet override does not expand session authority', async () => environment(async () => {
  process.env.TELEPTY_AUTH_TOKEN = 'synthetic-fleet-daemon'; process.env.TELEPTY_SESSION_TOKEN = 'synthetic-local-owner';
  const calls = [], client = security(async (url, options) => { calls.push(options); return { ok: true }; });
  await client.fetchWithAuth('http://not-registered.invalid:3848/api/sessions');
  assert.equal(calls[0].headers['x-telepty-token'], 'synthetic-fleet-daemon');
  assert.equal(calls[0].headers['x-telepty-session-token'], undefined);
  process.env.TELEPTY_SESSION_ORIGIN = 'invalid';
  await client.fetchWithAuth('http://127.0.0.1:3848/api/sessions');
  assert.equal(calls[1].headers['x-telepty-session-token'], undefined);
}));
test('real cross-origin redirect reproduces native header leak; protected client never follows', async () => environment(async () => {
  const http = require('node:http'); let sinks = 0, sourceHeaders, sinkHeaders;
  const sink = http.createServer((req, res) => { sinks++; sinkHeaders = req.headers; res.end('{}'); });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  const source = http.createServer((req, res) => { sourceHeaders = req.headers; res.writeHead(302, { location: `http://127.0.0.1:${sink.address().port}/sink` }); res.end(); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${source.address().port}/api/meta`;
    await fetch(url, { headers: { 'x-telepty-token': 'synthetic-daemon-control', 'x-telepty-session-token': 'synthetic-session-control' } });
    assert.equal(sinkHeaders['x-telepty-token'], 'synthetic-daemon-control'); assert.equal(sinkHeaders['x-telepty-session-token'], 'synthetic-session-control');
    sinks = 0; process.env.TELEPTY_SESSION_TOKEN = 'synthetic-owner';
    const client = security(globalThis.fetch, source.address().port);
    await assert.rejects(() => client.fetchWithAuth(url, { redirect: 'follow' }), { name: 'TransportError' });
    assert.equal(sinks, 0); assert.equal(sourceHeaders['x-telepty-session-token'], 'synthetic-owner');
  } finally { await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => sink.close(resolve))]); }
}));
test('registered HTTP peer and broker requests prohibit credential-bearing redirects', async () => environment(async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createPeerContext } = require('../cross-machine');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-origin-fixture-'));
  const client = createPeerContext({ PEERS_PATH: path.join(root, 'peers.json'), CONTROL_DIR: path.join(root, 'ssh') });
  const original = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => url.endsWith('/api/meta') ? { machine_id: 'synthetic-machine' } : [] }; };
  try {
    assert.equal((await client.connectHttp('foreign.invalid:4000', { name: 'fixture', token: 'synthetic-peer-secret' })).success, true);
    await client.listHttpRemoteSessions('fixture');
    assert.equal((await client.connectBroker('http://broker.invalid:4000', { node: 'fixture-node', jwt: 'synthetic-broker-secret' })).success, true);
    await client.listBrokerRemoteSessions();
    assert.equal(calls.length, 4);
    for (const call of calls) assert.equal(call.options.redirect, 'error');
    assert.equal(calls[1].options.headers['x-telepty-token'], 'synthetic-peer-secret');
    assert.equal(calls[2].options.headers['x-telepty-token'], 'synthetic-peer-secret');
    assert.equal(calls[3].options.headers.Authorization, 'Bearer synthetic-broker-secret');
  } finally { global.fetch = original; fs.rmSync(root, { recursive: true, force: true }); }
}));
