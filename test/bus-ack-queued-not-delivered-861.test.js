'use strict';

// #861 — the bus `inject_written` ACK said `delivered: true` about an inject that wrote nothing.
//
// `deliverInjectionToSession` has a third outcome that is neither a write nor a refusal: the op is
// parked on the session's bootstrap / surface-modal queue and the caller is handed
// `{success: true, strategy: 'bootstrap_queue', queued: true}`. #860 taught the AUDIT LOG to say
// `queued` for exactly that case. `busAutoRoute` kept computing `delivered` as
// `delivery.success === true`, so one parked inject produced two records that disagreed:
//
//   injects.jsonl        delivery_result: "queued"   (true — zero bytes)
//   bus inject_written   delivered: true             (false)
//
// And the asymmetry ran the wrong way. `injects.jsonl` is token-gated; any local process may
// subscribe to `/api/bus` with no credential. The honest record sat behind the credential and the
// false one was in the open — in a release whose subject is records that claim more than they
// measured.
//
// The park is reachable without a real CLI: `shouldQueueBootstrapOperation` gates a session that is
// `type: 'wrapped'` with a KNOWN AI CLI command and has never signalled bootstrap ready. Registering
// `claude` and never sending a ready frame is enough, so this test needs no binary and no PTY.
//
// The daemon here binds PORT=0 under a temp HOME. Nothing touches the production daemon on :3848.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

let daemon;
let TOKEN;

before(async () => {
  daemon = await startTestDaemon();
  TOKEN = JSON.parse(
    fs.readFileSync(path.join(daemon.homeDir, '.telepty', 'config.json'), 'utf8')
  ).authToken;
});
after(async () => { if (daemon) await daemon.stop(); });

const base = () => `http://${daemon.host}:${daemon.port}`;

async function post(pathname, body) {
  const res = await fetch(`${base()}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telepty-token': TOKEN },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

function open(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${daemon.host}:${daemon.port}${url}`, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused ${res.statusCode}`)));
  });
}

function nextFrame(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); resolve(null); }, timeoutMs);
    function onMessage(buf) {
      let msg = null;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
  });
}

// Register a wrapped session and hold its owner socket. `command` decides whether the bootstrap
// gate applies: a known AI CLI is gated until it signals ready, anything else is not gated at all.
async function wrappedSession(prefix, command) {
  const sid = createSessionId(prefix);
  const reg = await post('/api/sessions/register', { session_id: sid, command, cwd: process.cwd() });
  assert.ok([200, 201].includes(reg.status), `register ${command} -> ${reg.status}`);
  const owner = await open(
    `/api/sessions/${encodeURIComponent(sid)}?token=${encodeURIComponent(TOKEN)}`
    + `&owner=1&owner_pid=${process.pid}&command=${encodeURIComponent(command)}`,
    // #815 — the owner claim is credentialed; without the session bearer this socket is a viewer
    // and never receives the forwarded `inject` frame.
    { headers: { 'x-telepty-session-token': reg.body.session_token } }
  );
  return { sid, owner, token: reg.body.session_token };
}

// The ACK for one inject_id, off a bus subscription opened BEFORE the publish.
function ackFor(bus, sid) {
  return nextFrame(bus, (m) => m.type === 'inject_written'
    && (m.session_id === sid || (m.extra && m.extra.target_agent === sid)
        || m.target_agent === sid));
}

const extraOf = (ack) => (ack && ack.extra) ? ack.extra : ack;

test('#861: a bus inject parked on the bootstrap queue is NOT acked as delivered', async () => {
  const bus = await open(`/api/bus?token=${encodeURIComponent(TOKEN)}`);
  // `claude` is a known AI CLI, so this session is bootstrap-gated and never signals ready:
  // every inject to it parks with zero bytes written.
  const { sid, owner } = await wrappedSession('bus861-parked', 'claude');

  const ack = ackFor(bus, sid);
  const publish = await post('/api/bus/publish', {
    type: 'turn_request', target: sid, payload: { prompt: 'parked-by-the-bootstrap-gate' }
  });
  assert.equal(publish.status, 200);

  const got = extraOf(await ack);
  assert.ok(got, 'the bus route must still emit an inject_written ACK for a parked inject');

  assert.equal(got.delivered, false,
    '`delivered` means BYTES WERE WRITTEN. A parked op wrote none, and the delivery call returning '
    + '`success: true` for the park is exactly why this field cannot be `delivery.success`');
  assert.equal(got.delivery_result, 'queued',
    'the ACK must carry the audit log\'s own word for a park, on the unguarded surface too');
  // A park is not a failure, and must not be mistaken for one by a consumer that retries on error.
  assert.equal(got.code, null, 'a park is not a failure — no error code');
  assert.equal(got.error, null, 'a park is not a failure — no error string');

  owner.close();
  bus.close();
});

test('#861: an ungated bus inject is still acked as delivered — the fix is not a blanket false', async () => {
  // The control. Without it, `delivered: false` everywhere would satisfy the assertion above while
  // destroying the field's meaning in the other direction.
  const bus = await open(`/api/bus?token=${encodeURIComponent(TOKEN)}`);
  // Not a known AI CLI, so `isBootstrapGatedSession` is false and nothing parks.
  const { sid, owner } = await wrappedSession('bus861-written', 'test-wrap');

  const written = nextFrame(owner, (m) => m.type === 'inject' && String(m.data).includes('really-written'));
  const ack = ackFor(bus, sid);
  const publish = await post('/api/bus/publish', {
    type: 'turn_request', target: sid, payload: { prompt: 'really-written' }
  });
  assert.equal(publish.status, 200);
  assert.ok(await written, 'the ungated session must actually receive the bytes');

  const got = extraOf(await ack);
  assert.ok(got, 'the bus route must emit an inject_written ACK for a real write');
  assert.equal(got.delivered, true, 'a real write is still `delivered: true`');
  assert.equal(got.delivery_result, 'success', 'a real write is still `success`');

  owner.close();
  bus.close();
});
