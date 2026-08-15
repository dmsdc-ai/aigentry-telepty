'use strict';

// telepty#56 — duplicate-`--id` owner flap loop + `kill --force` doesn't stick.
// Policy (orchestrator-approved): (P) Replace-deterministically (last-writer-wins), made durable
// by a dedicated terminal close code 4001 'Owner replaced' (reason-independent; WS 4000-4999 =
// app-reserved). kill-stick: capture owner_pid at the ?owner=1 claim so kill --force can SIGKILL
// the owning process. Hermetic: PORT=0 + mock owner WS only — never touches the live daemon.
// Spec: docs/specs/2026-06-14-dupid-flap-kill-stick.md

const { afterEach, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createSessionId, delay, startTestDaemon } = require('../test-support/daemon-harness');
const { isOwnerReplacedClose, isDaemonDestroyClose } = require('../cli.js');

// A non-existent pid: SIGKILL resolves to ESRCH, so the assertion never touches a real process.
const OWNER_PID_SENTINEL = 2000111777;

let harness;

beforeEach(async () => {
  harness = await startTestDaemon();
});

afterEach(async () => {
  await harness.stop();
});

function ownerUrl(id, query = '') {
  // #820: the daemon token upgrades the socket; harness.ownerAuth() adds the #815 session bearer.
  return `ws://${harness.host}:${harness.port}/api/sessions/${encodeURIComponent(id)}`
    + `?owner=1&token=${encodeURIComponent(harness.authToken())}${query}`;
}

function ownerConnect(id, query = '') {
  const ws = new WebSocket(ownerUrl(id, query), harness.ownerAuth(id));   // #815: credentialed claim
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('telepty#56: isOwnerReplacedClose gates on the 4001 code only (reason-independent)', () => {
  assert.equal(isOwnerReplacedClose(4001), true);
  assert.equal(isOwnerReplacedClose(4001), isOwnerReplacedClose(4001)); // reason not consulted
  assert.equal(isOwnerReplacedClose(1006), false, 'a transient 1006 drop must still reconnect');
  assert.equal(isOwnerReplacedClose(1000), false, 'destroy stays the 1000 path');
  // 4001 and the 1000 destroy path are distinct terminal signals.
  assert.equal(isDaemonDestroyClose(4001, 'Owner replaced'), false);
});

test('telepty#56: a displaced wrap-owner is closed with terminal 4001 (not the reconnectable 1006)', async () => {
  const id = createSessionId('flap');
  await harness.registerSession(id);

  const a = await ownerConnect(id);
  const aClosed = new Promise((resolve) => a.once('close', (code) => resolve(code)));
  await delay(50);
  // Second ?owner=1 claim displaces the incumbent.
  const b = await ownerConnect(id);

  const code = await aClosed;
  assert.equal(code, 4001, 'displaced owner must receive the dedicated 4001 "Owner replaced" close, not 1006');
  b.terminate();
});

test('telepty#56: two reconnecting owners on one id do not oscillate (Replace is durable)', async () => {
  const id = createSessionId('flap');
  await harness.registerSession(id);

  let stop = false;
  const sockets = [];
  // Model the real cli.js bridge reconnect policy: reconnect on any NON-terminal close.
  // Terminal codes (1000 'Session destroyed', 4001 'Owner replaced') must NOT reconnect.
  function bridge() {
    if (stop) return;
    const ws = new WebSocket(ownerUrl(id), harness.ownerAuth(id));   // #815: credentialed claim
    sockets.push(ws);
    ws.on('close', (code) => {
      if (!stop && code !== 1000 && code !== 4001) setTimeout(bridge, 20);
    });
    ws.on('error', () => {});
  }
  bridge();
  bridge();
  await delay(800);
  stop = true;
  for (const ws of sockets) { try { ws.terminate(); } catch {} }

  const replacements = (harness.getLogs().stdout
    .match(new RegExp(`Replacing stale ownerWs for session ${id}`, 'g')) || []).length;
  assert.ok(replacements <= 1, `expected <=1 ownerWs replacement (durable Replace), got ${replacements} (oscillation)`);
});

test('telepty#56: owner_pid supplied on the ?owner=1 claim is captured in session metadata', async () => {
  const id = createSessionId('ownerpid');
  await harness.registerSession(id);

  const a = await ownerConnect(id, `&owner_pid=${OWNER_PID_SENTINEL}`);
  await delay(50);

  const list = await harness.request('/api/sessions');
  const session = list.body.find((s) => s.id === id);
  assert.ok(session, 'session must be listed');
  assert.equal(session.ownerPid, OWNER_PID_SENTINEL, 'ownerPid must be captured at owner-claim time (not only on reconnect-register)');
  a.terminate();
});

test('telepty#56: kill --force targets the owner pid captured at claim (kill sticks to the process)', async () => {
  const id = createSessionId('killstick');
  await harness.registerSession(id);

  const a = await ownerConnect(id, `&owner_pid=${OWNER_PID_SENTINEL}`);
  await delay(50);

  const res = await harness.request(`/api/sessions/${encodeURIComponent(id)}/kill`, {
    method: 'POST',
    body: { force: true }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.kill.pid, OWNER_PID_SENTINEL, 'kill --force must signal the owner process captured at claim, not "none"');
  a.terminate();
});
