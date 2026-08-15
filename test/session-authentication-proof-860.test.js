'use strict';

// telepty#860 F1 — `capability.session_authentication: "observed"` may be stamped ONLY where a
// bearer was presented and verified.
//
// #843 keyed the field on `session.sessionEpoch`. Three writers set that field:
//
//   src/transport/websocket.js  — an owner claim whose bearer verified to THIS sid.    PROOF
//   POST /api/sessions/register — issuance, before any caller presented anything.      no proof
//   session-store/persistence   — restored off disk on daemon start.                   no proof
//
// so the predicate measured "this daemon minted or restored an epoch for this id" and reported it
// with the one word this release reserves for a measurement. An orchestrator reading that block
// concludes the target session instance authenticated itself.
//
// The first test is the reproduction the r3 gate ran, re-run here rather than trusted: an `aterm`
// session can NEVER reach websocket.js (it opens no WebSocket at all), and it is injected with no
// session token, no handshake, no bearer presented at any point in its life.
//
// Every daemon here binds PORT=0 with a temp HOME. Nothing touches the production daemon.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
const sessionPersistence = require('../src/session-store/persistence');

let daemon;
let sink;             // the aterm delivery endpoint — the UDS transport writeDataToSession prefers
let sinkPath;
const sinkDeliveries = [];

before(async () => {
  sinkPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp860-')), 's.sock');
  sink = net.createServer((sock) => {
    sock.on('data', (chunk) => {
      sinkDeliveries.push(chunk.toString());
      sock.end();
    });
  });
  await new Promise((resolve) => sink.listen(sinkPath, resolve));
  daemon = await startTestDaemon();
});

after(async () => {
  if (daemon) await daemon.stop();
  if (sink) await new Promise((resolve) => sink.close(resolve));
});

function observations(injectId) {
  return daemon.request(`/api/inject-observations/${encodeURIComponent(injectId)}`);
}

// --- the epoch a session never proved -------------------------------------------------------

test('#860 F1: an epoch MINTED at register is not an authentication — nothing presented a bearer', async () => {
  const sid = createSessionId('f1-aterm');
  const reg = await daemon.registerSession(sid, {
    delivery_type: 'aterm',
    delivery: { transport: 'unix_socket', address: sinkPath },
    command: 'test-wrap',
  });
  assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.body)}`);
  const epoch = reg.body.session_epoch;
  assert.equal(typeof epoch, 'string', 'precondition: register mints an epoch');

  const before = sinkDeliveries.length;
  // No `x-telepty-session-token` on this request, and this session has never held a WebSocket.
  const inject = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
    method: 'POST', body: { prompt: 'a task', from: 'orchestrator' },
  });
  assert.equal(inject.status, 200, `inject failed: ${JSON.stringify(inject.body)}`);
  await daemon.waitFor(() => sinkDeliveries.length > before, { description: 'aterm sink delivery' });

  const res = await observations(inject.body.inject_id);
  assert.equal(res.status, 200);
  const cap = res.body.capability;

  // The epoch itself is reported, and correctly — the record already carries it on its own field.
  assert.equal(res.body.session_epoch, epoch);
  assert.equal(res.body.session_epoch_reason, null);

  // What may NOT be reported is that anything authenticated.
  assert.equal(cap.session_authentication, 'unavailable',
    'an epoch this daemon MINTED was reported as an authentication the session performed');
  assert.equal(cap.session_authentication_reason, 'no_815_bearer_presented');
});

test('#860 F1: an epoch RESTORED from disk is not an authentication either', () => {
  // Built the way production builds it — serialize a credentialed session, load it back, and
  // restore it through the real restore path — rather than hand-asserting the premise. The r3
  // gate's complaint about the #843 test was exactly that: it hand-built
  // `{id, sessionEpoch}` and named it "a proven epoch".
  const live = {
    'restored-860': {
      id: 'restored-860', type: 'wrapped', command: 'claude', cwd: '/tmp',
      createdAt: new Date().toISOString(),
      sessionEpoch: 'PErsIsTEDepOCH860aaaa',
      credentialVerifier: 'v1:not-a-real-verifier',
      credentialGeneration: 1,
      // The proof a live claim would have left behind. It must not survive serialization: a
      // process that read a fact out of a file has verified nothing.
      sessionEpochProved: 'PErsIsTEDepOCH860aaaa',
    },
  };
  const onDisk = sessionPersistence.serializePersistedSessions(live);
  assert.equal(onDisk['restored-860'].sessionEpoch, 'PErsIsTEDepOCH860aaaa',
    'precondition: the epoch itself IS persisted (#815 — the restored instance keeps its identity)');
  assert.equal(onDisk['restored-860'].sessionEpochProved, undefined,
    'the proof was written to disk, where a restart can launder it back into a measurement');

  const restored = sessionPersistence.buildRestoredWrappedSession('restored-860', onDisk['restored-860']);
  assert.equal(restored.sessionEpoch, 'PErsIsTEDepOCH860aaaa');
  assert.equal(restored.sessionEpochProved, undefined);

  const daemonModule = require('../daemon');
  assert.deepEqual(daemonModule.sessionAuthenticationCapability(restored), {
    session_authentication: 'unavailable',
    session_authentication_reason: 'no_815_bearer_presented',
  }, 'a session restored across a daemon restart proved nothing to the daemon that restored it');
});

// --- the epoch a session DID prove -----------------------------------------------------------

test('#860 F1: an epoch proved on a credentialed ?owner=1 claim IS observed', async () => {
  const sid = createSessionId('f1-proved');
  const reg = await daemon.registerSession(sid);          // wrapped, `test-wrap` — not bootstrap-gated
  assert.equal(reg.status, 201);
  const epoch = reg.body.session_epoch;

  // The production claim: the bridge presents the bearer it was issued, on the handshake.
  const url = `ws://${daemon.host}:${daemon.port}/api/sessions/${encodeURIComponent(sid)}`
    + `?owner=1&owner_pid=${process.pid}&token=${encodeURIComponent(daemon.authToken())}`;
  const ws = new WebSocket(url, daemon.ownerAuth(sid));
  try {
    await new Promise((resolve, reject) => {
      ws.on('message', (m) => {
        const msg = JSON.parse(m);
        if (msg.type === 'owner_token') resolve();
      });
      ws.once('close', (code) => reject(new Error(`owner claim refused: ${code}`)));
      setTimeout(() => reject(new Error('no owner_token frame')), 4000);
    });

    const inject = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
      method: 'POST', body: { prompt: 'a task', from: 'orchestrator' },
    });
    assert.equal(inject.status, 200, `inject failed: ${JSON.stringify(inject.body)}`);

    const res = await observations(inject.body.inject_id);
    assert.equal(res.body.session_epoch, epoch);
    assert.equal(res.body.capability.session_authentication, 'observed',
      'a bearer WAS presented and verified — reporting that as unavailable is the opposite lie');
    assert.equal(res.body.capability.session_authentication_reason, null);
  } finally {
    ws.close();
  }
});

// --- the three cases, at the seam ------------------------------------------------------------

test('#860 F1: the capability overlay answers all three cases and nothing else', () => {
  const daemonModule = require('../daemon');
  const cap = daemonModule.sessionAuthenticationCapability;

  // No epoch fact at all: the frozen CAPABILITY_STAGE_A default stands, untouched.
  assert.deepEqual(cap(null), {});
  assert.deepEqual(cap({ id: 's' }), {});

  // An epoch with no proof beside it.
  assert.deepEqual(cap({ sessionEpoch: 'E1' }), {
    session_authentication: 'unavailable',
    session_authentication_reason: 'no_815_bearer_presented',
  });

  // Proof that names THIS epoch.
  assert.deepEqual(cap({ sessionEpoch: 'E1', sessionEpochProved: 'E1' }), {
    session_authentication: 'observed',
    session_authentication_reason: null,
  });

  // A STALE proof may not carry over. An owner displacement writes the claimant's epoch (null when
  // it proved none) and websocket.js writes the proof on the same two arms — but the comparison is
  // what makes a future writer that moves one without the other fail closed instead of inheriting
  // an authentication that belonged to the displaced instance.
  assert.deepEqual(cap({ sessionEpoch: 'E2', sessionEpochProved: 'E1' }), {
    session_authentication: 'unavailable',
    session_authentication_reason: 'no_815_bearer_presented',
  });
});
