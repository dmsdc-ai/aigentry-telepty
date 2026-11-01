'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
let daemon;
before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });
async function register(seconds = 300) {
  const sid = createSessionId('poll101');
  const result = await daemon.request('/api/sessions/register', { method: 'POST',
    body: { session_id: sid, delivery_type: 'mailbox', lease_seconds: seconds, command: 'poller' } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { sid, token: result.body.session_token, record: result.body };
}
async function own(sid, token, suffix = '/mailbox', method = 'GET', body) {
  const response = await fetch(`http://${daemon.host}:${daemon.port}/api/sessions/${encodeURIComponent(sid)}${suffix}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-telepty-session-token': token },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

test('#101 mailbox registration has a lease, no transport, and inject remains pending across delivery ticks', async () => {
  const { sid, token, record } = await register();
  const bus = await daemon.connectBus();
  const events = [];
  bus.on('message', raw => { try { events.push(JSON.parse(raw)); } catch {} });
  assert.equal(record.type, 'mailbox');
  assert.ok(record.lease_expires_at > Date.now());
  const listing = await daemon.request('/api/sessions');
  const session = listing.body.find(item => item.id === sid);
  assert.equal(session.healthStatus, 'CONNECTED');
  assert.equal(session.ownerPid, null); assert.equal(session.ptyPid, null);
  const injected = await daemon.request(`/api/sessions/${sid}/inject`, { method: 'POST', body: { prompt: 'poll this text' } });
  assert.equal(injected.status, 200, JSON.stringify(injected.body));
  assert.equal(injected.body.queued, true);
  assert.equal(injected.body.delivered, false);
  assert.equal(injected.body.bytes_written, 0);
  assert.equal(injected.body.submit, 'not_applicable');
  await new Promise(resolve => setTimeout(resolve, 650));
  const polled = await own(sid, token);
  assert.equal(polled.status, 200);
  assert.equal(polled.body.pending.length, 1);
  assert.equal(polled.body.pending[0].payload, 'poll this text');
  assert.equal(polled.body.pending[0].attempt, 0);
  assert.equal(polled.body.dead_letter.length, 0);
  assert.equal(events.some(event => event.type === 'inject_written' && event.session_id === sid), false);
  assert.equal(events.some(event => event.type === 'inject_queued' && event.session_id === sid), true);
  bus.close();
  assert.equal((await own(sid, token, '/mailbox/ack', 'POST', { msg_id: injected.body.msg_id })).status, 200);
  assert.equal((await own(sid, token)).body.pending.length, 0);
});

test('#101 session bearer cannot read or ack another mailbox, list, inject, delete, or renew another session', async () => {
  const a = await register(); const b = await register();
  for (const [sid, suffix, method, body] of [
    [b.sid, '/mailbox', 'GET'], [b.sid, '/mailbox/ack', 'POST', { msg_id: 'other' }],
    [b.sid, '/lease', 'POST', { lease_seconds: 300 }], [a.sid, '/mailbox', 'DELETE'],
    [a.sid, '/inject', 'POST', { prompt: 'unauthorized' }], [a.sid, '/state', 'POST', { state: 'idle' }],
  ]) assert.equal((await own(sid, a.token, suffix, method, body)).status, 401);
  const listed = await fetch(`http://${daemon.host}:${daemon.port}/api/sessions`, { headers: { 'x-telepty-session-token': a.token } });
  assert.equal(listed.status, 401);
  assert.equal((await own(a.sid, 'wrong')).status, 401);
});

test('#101 lease expires; tokenless re-register cannot extend it or mutate type; owner can renew', async () => {
  const { sid, token, record } = await register(1);
  const denied = await daemon.request('/api/sessions/register', { method: 'POST',
    body: { session_id: sid, delivery_type: 'aterm', lease_seconds: 3600, delivery_endpoint: 'http://invalid' } });
  assert.equal(denied.status, 403);
  const before = (await daemon.request('/api/sessions')).body.find(item => item.id === sid);
  assert.equal(before.type, 'mailbox'); assert.equal(before.lease_expires_at, record.lease_expires_at);
  await new Promise(resolve => setTimeout(resolve, 1050));
  const expired = (await daemon.request('/api/sessions')).body.find(item => item.id === sid);
  assert.equal(expired.healthStatus, 'DISCONNECTED');
  const inject = await daemon.request(`/api/sessions/${sid}/inject`, { method: 'POST', body: { prompt: 'expired' } });
  assert.equal(inject.status, 503);
  assert.equal((await own(sid, token, '/lease', 'POST', { lease_seconds: 2 })).status, 200);
  const renewed = (await daemon.request('/api/sessions')).body.find(item => item.id === sid);
  assert.equal(renewed.healthStatus, 'CONNECTED');
  const response = await fetch(`http://${daemon.host}:${daemon.port}/api/sessions/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telepty-session-token': token },
    body: JSON.stringify({ session_id: sid, lease_seconds: 3 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).session_token, undefined);
});

test('#101 invalid leases and endpoints fail before minting; own bearer cannot register another session', async () => {
  for (const lease_seconds of [0, -1, 3601, 1.5, '300', null]) {
    const result = await daemon.request('/api/sessions/register', { method: 'POST',
      body: { session_id: createSessionId('badpoll'), delivery_type: 'mailbox', lease_seconds } });
    assert.equal(result.status, 400);
  }
  for (const session_id of ['bad/poll', 'bad\\poll', '..', 'C:poll']) {
    const result = await daemon.request('/api/sessions/register', { method: 'POST', body: { session_id, delivery_type: 'mailbox' } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_SESSION_ID');
    assert.equal(result.body.session_token, undefined);
  }
  const { sid, token } = await register();
  const invalid = await own(sid, token, '/lease', 'POST', { lease_seconds: 3601 });
  assert.equal(invalid.status, 400);
  const response = await fetch(`http://${daemon.host}:${daemon.port}/api/sessions/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telepty-session-token': token },
    body: JSON.stringify({ session_id: createSessionId('otherpoll'), delivery_type: 'mailbox' }) });
  assert.equal(response.status, 401);
  const endpoint = await daemon.request('/api/sessions/register', { method: 'POST', body: {
    session_id: createSessionId('endpointpoll'), delivery_type: 'mailbox', delivery_endpoint: 'http://invalid' } });
  assert.equal(endpoint.status, 400);
});

test('#101 CLI reads and acknowledges with a session bearer without printing either credential', async () => {
  const { sid, token } = await register();
  const injected = await daemon.request(`/api/sessions/${sid}/inject`, { method: 'POST', body: { prompt: 'cli poll payload' } });
  const read = await daemon.runCli(['mailbox', sid, '--json'], { env: { TELEPTY_SESSION_TOKEN: token } });
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).pending[0].payload, 'cli poll payload');
  const ack = await daemon.runCli(['mailbox', 'ack', sid, injected.body.msg_id], { env: { TELEPTY_SESSION_TOKEN: token } });
  assert.equal(ack.code, 0, ack.stderr);
  assert.equal(JSON.parse(ack.stdout).success, true);
  for (const output of [read.stdout, read.stderr, ack.stdout, ack.stderr]) {
    assert.equal(output.includes(token), false); assert.equal(output.includes(daemon.authToken()), false);
  }
});

test('#101 mailbox lease and credential restore across restart; pending stays pending', async () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'poll101-restart-'));
  let fixture;
  try {
    fixture = await startTestDaemon({ homeDir: home });
    const sid = createSessionId('restartpoll');
    const registered = await fixture.request('/api/sessions/register', { method: 'POST', body: { session_id: sid, delivery_type: 'mailbox' } });
    assert.equal(registered.status, 201);
    await fixture.request(`/api/sessions/${sid}/inject`, { method: 'POST', body: { prompt: 'survive restart' } });
    // stop() cleans sessions; kill only the owned child for this restart fixture.
    await fixture.kill();
    fixture = await startTestDaemon({ homeDir: home });
    const response = await fetch(`http://${fixture.host}:${fixture.port}/api/sessions/${sid}/mailbox`, {
      headers: { 'x-telepty-session-token': registered.body.session_token } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pending[0].payload, 'survive restart');
  } finally { if (fixture) await fixture.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('#101 since cursor reads later pending messages and acknowledgements reject unknown ids', async () => {
  const { sid, token } = await register();
  const results = [];
  for (const prompt of ['first', 'second']) results.push(await daemon.request(`/api/sessions/${sid}/inject`, { method: 'POST', body: { prompt } }));
  const response = await own(sid, token, `/mailbox?since=${encodeURIComponent(results[0].body.msg_id)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.pending.map(msg => msg.payload), ['second']);
  assert.equal((await own(sid, token, '/mailbox/ack', 'POST', { msg_id: 'missing' })).status, 404);
});
