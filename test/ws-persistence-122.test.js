'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { installWebSocketTransport } = require('../src/transport/websocket');
test('failed owner-claim save preserves incumbent and sends no ownership ACK', async (t) => {
    const server = http.createServer();
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    let displaced = 0;
    const incumbent = { readyState: 1, close: () => displaced++, terminate: () => displaced++ };
    const session = { id: 'synthetic', type: 'wrapped', ownerWs: incumbent, ownerToken: 'old', ownerPid: 111, clients: new Set([incumbent]), outputRing: [], ready: true };
    const sessions = { synthetic: session };
    let events = 0;
    const deps = { server, tailnetServer: null, sessions, busClients: new Set(), expectedToken: 'synthetic-token', verifyJwt: () => false, isAllowedPeer: () => true, initializeBootstrapState: () => { }, findKittySocket: () => null, findKittyWindowId: () => null, markSessionConnected: s => s.lastConnectedAt = 'new', scheduleBootstrapPromptPoll: () => { }, emitSessionLifecycleEvent: () => events++, persistSessions: () => ({ ok: false, committed: false }), appendToOutputRing: () => { }, sessionStateManager: { feed: () => { } }, isBootstrapGatedSession: () => false, markBootstrapReady: () => { }, pendingReports: {}, fireAutoReport: () => { }, markSessionDisconnected: () => { }, resolveSessionAlias: id => id, applySessionStateReport: () => ({ success: false }), busAutoRoute: () => { } };
    installWebSocketTransport(deps);
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/sessions/synthetic?token=synthetic-token&owner=1&owner_pid=222`);
    t.after(() => ws.terminate());
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data)));
    const closed = new Promise((r, j) => { ws.once('close', (code) => r(code)); ws.once('error', j); });
    const timeout = setTimeout(() => ws.terminate(), 1000);
    t.after(() => clearTimeout(timeout));
    assert.equal(await closed, 1011);
    assert.equal(displaced, 0);
    assert.equal(session.ownerWs, incumbent);
    assert.equal(session.ownerToken, 'old');
    assert.equal(session.ownerPid, 111);
    assert.equal(session.lastConnectedAt, undefined);
    assert.equal(session.clients.size, 1);
    assert.deepEqual(messages, []);
    assert.equal(events, 0);
});

test('closing instance refuses an owner claim before any save, credential ACK or displacement', async t => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const incumbent = { readyState: 1, close() { throw new Error('incumbent must not be displaced'); } };
  const session = { id: 'closing', type: 'wrapped', isClosing: true, ownerWs: incumbent,
    clients: new Set([incumbent]), ownerPid: 111 };
  installWebSocketTransport({ server, sessions: { closing: session }, busClients: new Set(),
    expectedToken: 'synthetic-token', verifyJwt: () => false, isAllowedPeer: () => true,
    persistSessions() { throw new Error('closing claim must not save'); } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/sessions/closing?token=synthetic-token&owner=1&owner_pid=222`);
  t.after(() => ws.terminate());
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  const closed = new Promise((resolve, reject) => { ws.once('close', resolve); ws.once('error', reject); });
  const timeout = setTimeout(() => ws.terminate(), 1000);
  t.after(() => clearTimeout(timeout));
  assert.equal(await closed, 1011);
  assert.equal(session.ownerWs, incumbent);
  assert.equal(session.ownerPid, 111);
  assert.equal(session.clients.size, 1);
  assert.deepEqual(messages, []);
});
