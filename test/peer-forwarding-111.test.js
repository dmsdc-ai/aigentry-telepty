'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const { createForwardLedger } = require('../src/peer-forwarding');
const crypto = require('node:crypto');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const grant = { enabled: true, operations: ['inject'], sessions: ['same@literal'], hop_limit: 1,
  max_payload_bytes: 128, max_requests: 8, window_ms: 60000, timeout_ms: 500 };

test('opt-in exact peer forwarding scopes authority, preserves receipts, deduplicates and retains timeout uncertainty', async () => {
  const source = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  const target = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  const sockets = [];
  let slow, tripwire;
  try {
    assert.notEqual(source.authToken(), target.authToken());
    const localRegistration = await source.registerSession('same@literal');
    const remoteRegistration = await target.registerSession('same@literal');
    assert.equal(localRegistration.status, 201);
    async function owner(daemon) {
      const socket = new WebSocket(`ws://${daemon.host}:${daemon.port}/api/sessions/same@literal?owner=1&token=${encodeURIComponent(daemon.authToken())}`, daemon.ownerAuth('same@literal'));
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return socket;
    }
    const localOwner = await owner(source);
    const remoteOwner = await owner(target);
    sockets.push(localOwner, remoteOwner);
    const localFrames = [], remoteFrames = [];
    localOwner.on('message', (raw) => { const frame = JSON.parse(raw); if (frame.type === 'inject') localFrames.push(frame); });
    remoteOwner.on('message', (raw) => { const frame = JSON.parse(raw); if (frame.type === 'inject') remoteFrames.push(frame); });
    const file = path.join(source.homeDir, '.telepty', 'peers.json');
    let peer = { transport: 'http', host: target.host, port: target.port, token: target.authToken() };
    const seed = () => fs.writeFileSync(file, JSON.stringify({ peers: { exact: peer } }));
    seed();
    const request = (body, name = 'exact', sid = 'same@literal') => source.request(`/api/peers/${name}/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body });
    const body = { prompt: 'Synthetic forwarded input', expected_epoch: remoteRegistration.body.session_epoch,
      idempotency_key: 'synthetic-forward-key-0001', no_enter: true };
    assert.equal((await request(body)).status, 403);
    assert.equal((await request(body, 'unknown')).body.code, 'PEER_UNKNOWN');
    peer.forwarding = { ...grant }; seed();
    assert.equal((await request(body, 'exact', 'ungranted')).status, 403);
    assert.equal((await request({ ...body, prompt: 'x'.repeat(129) })).status, 403);
    assert.equal((await request({ ...body, url: 'http://example.invalid' })).status, 400);
    assert.equal((await source.request('/api/peers')).text.includes('max_requests'), false);
    const accepted = await request(body);
    assert.equal(accepted.status, 200, JSON.stringify({ source: accepted.body, destination: createForwardLedger(target.homeDir).all() }));
    assert.equal(accepted.body.state, 'accepted');
    assert.equal(accepted.body.routing_receipt.session, 'same@literal');
    assert.equal(accepted.body.routing_receipt.remote_inject_id, accepted.body.inject_id);
    assert.equal(accepted.body.verified_foreign_identity, false);
    await waitFor(() => remoteFrames.length === 1, { description: 'one remote injection' });
    assert.equal(localFrames.length, 0);
    const replay = await request(body);
    assert.equal(replay.body.inject_id, accepted.body.inject_id);
    assert.equal(remoteFrames.length, 1);
    assert.equal((await request({ ...body, prompt: 'changed input' })).status, 409);
    const query = await source.request(`/api/peers/forward-receipts/${body.idempotency_key}`);
    assert.equal(query.body.inject_id, accepted.body.inject_id);
    assert.equal((await request({ ...body, expected_epoch: 'wrong-epoch', idempotency_key: 'synthetic-forward-key-0002' })).body.code, 'TARGET_EPOCH_MISMATCH');
    // The destination also deduplicates independent transport retries before delivery.
    const wire = { ...body, exact_target: true, claimed_cross_host: true,
      forwarding: { hop: 1, key: digest(`outbound:${body.idempotency_key}`) } };
    delete wire.idempotency_key;
    const destinationReplay = await target.request(`/api/forwarded/sessions/${encodeURIComponent('same@literal')}/inject`, { method: 'POST', body: wire });
    assert.equal(destinationReplay.body.inject_id, accepted.body.inject_id);
    assert.equal(remoteFrames.length, 1);
    assert.equal((await target.request(`/api/forwarded/sessions/${encodeURIComponent('same@literal')}/inject`, {
      method: 'POST', body: { ...wire, forwarding: { ...wire.forwarding, hop: 2 } }
    })).status, 400);
    // A literal @ session on the local API remains exact-local.
    const literal = await source.request(`/api/sessions/${encodeURIComponent('same@literal')}/inject`, {
      method: 'POST', body: { prompt: 'Synthetic local input', exact_target: true, no_enter: true }
    });
    assert.equal(literal.status, 200);
    await waitFor(() => localFrames.length === 1, { description: 'literal local session inject' });
    // Timeout after the request arrives is uncertain; replay must never send again.
    let requests = 0, headers, redirectTo = null, redirectedRequests = 0;
    slow = http.createServer((req, res) => {
      requests++; headers = req.headers; req.resume();
      if (redirectTo) { res.writeHead(302, { location: redirectTo }); res.end(); return; }
      setTimeout(() => { if (!res.destroyed) res.end('{}'); }, 400);
    });
    await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
    peer = { ...peer, port: slow.address().port, token: 'synthetic-destination-only', forwarding: { ...grant, timeout_ms: 100 } }; seed();
    const uncertainBody = { ...body, idempotency_key: 'synthetic-forward-key-0003' };
    const uncertain = await request(uncertainBody);
    assert.equal(uncertain.status, 202);
    assert.equal(uncertain.body.state, 'outcome_unknown');
    assert.equal(requests, 1);
    assert.equal(headers['x-telepty-token'], 'synthetic-destination-only');
    assert.equal(headers['x-telepty-session-token'], undefined);
    assert.notEqual(headers['x-telepty-token'], source.authToken());
    assert.equal((await request(uncertainBody)).status, 202);
    assert.equal(requests, 1);
    assert.equal((await source.request(`/api/peers/forward-receipts/${uncertainBody.idempotency_key}`)).body.state, 'outcome_unknown');
    tripwire = http.createServer((req, res) => { redirectedRequests++; req.resume(); res.end('{}'); });
    await new Promise((resolve) => tripwire.listen(0, '127.0.0.1', resolve));
    redirectTo = `http://127.0.0.1:${tripwire.address().port}/never`;
    const redirected = await request({ ...body, idempotency_key: 'synthetic-forward-key-0004' });
    assert.equal(redirected.status, 202);
    assert.equal(redirected.body.state, 'outcome_unknown');
    assert.equal(redirectedRequests, 0);
    peer = { ...peer, port: target.port, token: target.authToken(), forwarding: { ...grant, sessions: ['same@literal', 'not-created', 'broadcast'] } }; seed();
    const missing = await request({ ...body, idempotency_key: 'synthetic-forward-key-0005' }, 'exact', 'not-created');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SESSION_NOT_FOUND');
    assert.equal((await request({ ...body, idempotency_key: 'synthetic-forward-broadcast' }, 'exact', 'broadcast')).status, 404);
    assert.equal(remoteFrames.length, 1);
    peer.forwarding.max_requests = 1; seed();
    assert.equal((await request({ ...body, idempotency_key: 'synthetic-forward-key-0006' })).status, 429);
    const ledger = createForwardLedger(source.homeDir);
    for (const record of ledger.all()) assert.equal(JSON.stringify(record).includes(body.prompt), false);
    const pendingKey = digest('outbound:synthetic-crashed-forward');
    ledger.reserve(pendingKey, 'a'.repeat(64), { direction: 'outbound', peer: 'exact', session: 'same@literal' });
    assert.equal(createForwardLedger(source.homeDir).view(ledger.read(pendingKey)).state, 'outcome_unknown');
  } finally {
    sockets.forEach((socket) => socket.close());
    if (slow) await new Promise((resolve) => slow.close(resolve));
    if (tripwire) await new Promise((resolve) => tripwire.close(resolve));
    await Promise.all([source.stop(), target.stop()]);
  }
});
