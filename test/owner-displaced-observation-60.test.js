'use strict';

// telepty#60 Stage A §8.3 item 10 — `owner_displaced_without_markdead_reports_absence`.
//
// The failure this pins is a SILENCE, and silence is the one output Stage A forbids.
//
// When a second `?owner=1` claim displaces a live bridge, the daemon knows something with
// certainty: the process that was assigned this session's work is no longer attached to it. The
// displaced bridge reads close 4001 as terminal and exits (cli.js) — frequently without the PTY
// child ever driving `sessionStateManager.markDead`, so the state machine's death branch never
// runs. Meanwhile the session RECORD survives under the new socket, `hadDisconnectedOwner` is
// false so no `session_reconnect` fires either, and every tracked inject assigned to the displaced
// instance simply keeps sitting there. Continuity is implied by the absence of any statement,
// which is the lie.
//
// So this drives the real transport against the REAL observation ledger — not a stubbed emitter —
// and asserts the two facts are durably appended to every tracked inject, that authentication for
// the displaced epoch is gone, and that neither fact is dressed up as an outcome.
//
// Hermetic require, house style (see completion-unknown-observation-60.test.js): $HOME is
// redirected and PORT pinned BEFORE requiring the daemon, so it cannot read or restore live
// production session state into this test process.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty60-owner-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.PORT = '0';

const daemon = require('../daemon');
const { installWebSocketTransport } = require('../src/transport/websocket');
const { createCredentialStore } = require('../src/session-store/session-credentials');

const TOKEN = 'owner-displaced-60-token';
const SID = 'displaced-60';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function newRecord() {
  return {
    id: SID, type: 'wrapped', ownerWs: null, clients: new Set(),
    outputRing: [], outputRingTotalBytes: 0, ready: true,
    createdAt: new Date().toISOString(), lastActivityAt: null, lastDisconnectedAt: null
  };
}

// `markDead` is deliberately a THROWING stub, not a spy: if any path under test reaches it, the
// premise of this test ("even if markDead never ran") is void and it must fail loudly rather than
// quietly pass for the wrong reason.
function buildDeps(server, sessions, credentials) {
  return {
    server,
    tailnetServer: null,
    sessions,
    busClients: new Set(),
    expectedToken: TOKEN,
    verifyJwt: () => false,
    // #823: `isAllowedPeer` is now a reachability PRECONDITION that can only narrow, not an
    // alternative to the credential. `false` here would mean "this address may not connect at
    // all" (403) and no token would buy past it; the token in the URL is what authenticates.
    isAllowedPeer: () => true,
    initializeBootstrapState: () => {},
    findKittySocket: () => null,
    findKittyWindowId: () => null,
    markSessionConnected: () => {},
    scheduleBootstrapPromptPoll: () => {},
    emitSessionLifecycleEvent: () => {},
    persistSessions: () => {},
    appendToOutputRing: () => {},
    sessionStateManager: {
      feed: () => {},
      markDead: () => { throw new Error('markDead must not be required for the death fact to be reported'); },
    },
    isBootstrapGatedSession: () => false,
    markBootstrapReady: () => {},
    pendingReports: {},
    fireAutoReport: () => {
      throw new Error('fireAutoReport debounces and DROPS on a busy session — owner lifecycle must not route through it');
    },
    markSessionDisconnected: () => {},
    resolveSessionAlias: (id) => id,
    applySessionStateReport: () => ({ success: false }),
    busAutoRoute: () => {},
    credentials,
    // The real seams. This is the point of the test: the ledger append has to actually happen.
    recordObservation: daemon.recordObservation,
    listTrackedInjectionsForSession: daemon.listTrackedInjectionsForSession,
  };
}

function connect(port, bearer) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/api/sessions/${SID}?token=${TOKEN}&owner=1&owner_pid=${process.pid}`,
    bearer ? { headers: { 'x-telepty-session-token': bearer } } : undefined
  );
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const kindsOf = (injectId) =>
  (daemon.getTrackedInjection(injectId).observations || []).map((o) => o.kind);

test('owner_displaced_without_markdead_reports_absence: both facts reach every tracked inject', async () => {
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  after(() => server.close());

  const credentials = createCredentialStore();
  const issued = credentials.issue(SID);
  const session = newRecord();
  const sessions = { [SID]: session };
  installWebSocketTransport(buildDeps(server, sessions, credentials));

  // Two tracked injects for this session. The second SUPERSEDES the first, and the first is
  // retained deliberately — an owner replacement is exactly the kind of fact its reader still
  // needs, so "every tracked inject" has to mean every one, not just the active pointer.
  const first = daemon.beginTrackedInjection({ injectId: 'inj-old', sessionId: SID, source: 'orch', session });
  assert.equal(first.ok, true);
  const second = daemon.beginTrackedInjection({ injectId: 'inj-new', sessionId: SID, source: 'orch', session });
  assert.equal(second.ok, true);

  // The incumbent proves the credential, so the daemon knows the exact epoch its work is filed
  // under. Nothing else in this transport ever set `sessionEpoch`.
  const incumbent = await connect(port, issued.bearer);
  await delay(150);
  assert.equal(session.sessionEpoch, issued.epoch,
    'a claim that proved the credential must record the epoch it proved');

  // The displacement. Same credential (an authorized replacement, per #815) — this is the
  // authenticated `owner_replaced` fact Stage A consumes, not a hijack.
  const claimant = await connect(port, issued.bearer);
  await delay(250);

  for (const injectId of ['inj-old', 'inj-new']) {
    assert.ok(kindsOf(injectId).includes('owner_replaced_observed'),
      `expected owner_replaced_observed durably appended to ${injectId}, got ${JSON.stringify(kindsOf(injectId))}`);
    const record = daemon.getTrackedInjection(injectId);
    const observed = record.observations.find((o) => o.kind === 'owner_replaced_observed');
    assert.equal(observed.displaced_session_epoch, issued.epoch,
      'the fact must NAME the displaced instance, not merely report that something changed');
  }

  // Now the displaced bridge exits, exactly as it does on close 4001 — without markDead. The
  // stub above throws if anything tries to route through the state machine to get here.
  incumbent.close();
  await delay(300);

  for (const injectId of ['inj-old', 'inj-new']) {
    // #843 — the fact is still reported (that is §8.3 item 10 and it stands), but under the name
    // of what was actually measured: a SOCKET closed. The daemon initiated that close itself, 35
    // lines up, with code 4001. Calling a close the daemon sent `session_process_exited` asserted
    // a child exit nobody observed — and BUS_EVENT_SCHEMA.md:153-156 already said, correctly, that
    // this path implies no process-exit observation. The code contradicted the repo's own doc.
    assert.ok(kindsOf(injectId).includes('owner_transport_detached'),
      `expected owner_transport_detached for ${injectId} without markDead, got ${JSON.stringify(kindsOf(injectId))}`);
    assert.equal(kindsOf(injectId).includes('session_process_exited'), false,
      'transport detachment is not process death: the displaced bridge may still be running');
  }

  // Neither fact is an outcome. Owner replacement is not task failure and death is not task
  // completion — the record stays unknown through both.
  for (const injectId of ['inj-old', 'inj-new']) {
    const record = daemon.getTrackedInjection(injectId);
    assert.equal(record.capability.outcome_protocol, 'unavailable');
    for (const observation of record.observations) {
      assert.notEqual(observation.terminal, true, 'no owner-lifecycle observation may be terminal');
      assert.ok(!/TASK_COMPLETE|TASK_ERROR/.test(JSON.stringify(observation)),
        `terminal vocabulary leaked into the ledger: ${JSON.stringify(observation)}`);
    }
  }

  try { claimant.terminate(); } catch { /* already gone */ }
});

test('an unproven replacement claim leaves authentication unavailable, never inherited (§3 item 5)', async () => {
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  after(() => server.close());

  const credentials = createCredentialStore();
  const session = newRecord();
  // A session that holds NO credential — the pre-#815 restored-bridge class. The claim gate lets
  // it through (that is deliberate: it is what keeps reconnect working), but letting it through is
  // not the same as authenticating it.
  installWebSocketTransport(buildDeps(server, { [SID]: session }, credentials));

  const ws = await connect(port, null);
  await delay(150);
  after(() => { try { ws.terminate(); } catch { /* already gone */ } });

  assert.equal(session.sessionEpoch, null,
    'an unproven claim must not acquire an epoch: an open socket is not an authentication fact');
});

test('a credential-holding session still refuses an unauthenticated owner claim with 4003 (#815)', async () => {
  // #815's property, re-asserted here because this file is where the owner-claim path is now
  // doing more work. The epoch recording added above reads the same bearer the gate checks, and a
  // claimed SID must never substitute for it — that substitution is the exact defect #815 removed.
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  after(() => server.close());

  const credentials = createCredentialStore();
  credentials.issue(SID);
  const session = newRecord();
  installWebSocketTransport(buildDeps(server, { [SID]: session }, credentials));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SID}?token=${TOKEN}&owner=1`);
  const closeCode = await new Promise((resolve, reject) => {
    ws.once('close', (code) => resolve(code));
    ws.once('error', reject);
  });

  assert.equal(closeCode, 4003, 'a session holding a credential requires the matching bearer to be owned');
  assert.equal(session.ownerWs, null, 'and the refused claimant never became the owner');
  assert.equal(session.sessionEpoch, undefined, 'nor acquired an epoch on the way out');
});

// #843 — ownership without the bearer.
//
// The #815 owner-claim gate fires only when the handshake carries `?owner=1`. The ASSIGNMENT 35
// lines below it fires on `!activeSession.ownerWs || isOwnerConnect` — so on a credentialed
// session with no current owner, dropping the query parameter takes ownership without presenting
// the bearer at all. The taker then receives the full body of every subsequent inject to that
// session, which is exactly the disclosure #815 exists to prevent, reached by not asking for it.
//
// Not introduced by this release (the gate is byte-identical at the base commit), but #815's
// residual is documented as the first-claim race, and this is a second, larger one.
//
// The refusal is deliberately NOT the 4003 the explicit path uses: this socket never claimed to be
// an owner, so refusing the connection would break ordinary viewers attaching to a session whose
// bridge has dropped. It is refused OWNERSHIP and attached as a viewer — which is what it asked
// for. The #815 comment's warning against a silent downgrade is about an explicit `?owner=1`
// bridge, whose whole purpose is to own; it does not apply to a socket that made no claim.
test('an implicit first-claim on a credentialed session does not confer ownership (#843)', async () => {
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  after(() => server.close());

  const credentials = createCredentialStore();
  const issued = credentials.issue(SID);
  const session = newRecord();
  installWebSocketTransport(buildDeps(server, { [SID]: session }, credentials));

  // No `?owner=1`, no bearer — and the session currently has no owner.
  const sneak = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SID}?token=${TOKEN}`);
  let sawOwnerToken = false;
  sneak.on('message', (buf) => {
    try { if (JSON.parse(buf.toString()).type === 'owner_token') sawOwnerToken = true; } catch { /* not JSON */ }
  });
  await new Promise((resolve, reject) => { sneak.once('open', resolve); sneak.once('error', reject); });
  await delay(200);
  after(() => { try { sneak.terminate(); } catch { /* already gone */ } });

  // Server-authoritative: `ownerWs` is the daemon's own record of who owns the PTY stream, and it
  // starts null. (It holds the SERVER-side socket, which is never the client object this test
  // holds — so identity against `sneak` would be vacuously true and prove nothing.)
  assert.equal(session.ownerWs, null,
    'a socket that presented no bearer must not become the owner of a credentialed session');
  assert.equal(session.sessionEpoch, undefined,
    'and must not acquire the epoch it never proved — not even as a null assignment');
  assert.equal(sawOwnerToken, false,
    'nor be handed the owner token, which is the discriminator the DELETE guard trusts');
  // It is still a viewer: the connection is not refused, only the authority is.
  assert.equal(session.clients.size, 1,
    'an ordinary attach must keep working — this refuses ownership, not connectivity');
  assert.equal(sneak.readyState, 1, 'the socket stays open');

  // And the real bridge, presenting the bearer, still takes ownership normally.
  const owner = await connect(port, issued.bearer);
  await delay(200);
  after(() => { try { owner.terminate(); } catch { /* already gone */ } });
  assert.notEqual(session.ownerWs, null, 'the credentialed bridge still owns its session');
  assert.equal(session.sessionEpoch, issued.epoch);
});

test('a session holding NO credential still accepts an implicit first claim (#843 keeps reconnect working)', async () => {
  // The residual #815 deliberately leaves open: a record with no credential (the WS auto-register
  // path, or one restored from a pre-#815 daemon) has nothing to check a claim against. Narrowing
  // that here would break reconnect, which is the thing #815 was careful not to do.
  const app = express();
  const server = http.createServer(app);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  after(() => server.close());

  const credentials = createCredentialStore();
  const session = newRecord();
  installWebSocketTransport(buildDeps(server, { [SID]: session }, credentials));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SID}?token=${TOKEN}`);
  let sawOwnerToken = false;
  ws.on('message', (buf) => {
    try { if (JSON.parse(buf.toString()).type === 'owner_token') sawOwnerToken = true; } catch { /* not JSON */ }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await delay(200);
  after(() => { try { ws.terminate(); } catch { /* already gone */ } });

  assert.notEqual(session.ownerWs, null, 'no credential to check against: the pre-#815 claim path is unchanged');
  assert.equal(sawOwnerToken, true, 'and the claimant is handed the owner token, as before');
  assert.equal(session.sessionEpoch, null, 'but it proved nothing, and that absence is recorded');
});
