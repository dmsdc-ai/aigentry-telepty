'use strict';

// #815 — per-session verified-sender token issuance must be bound to the session that owns
// the PTY, not to whoever names its id.
//
// Three composing defects being pinned here:
//   1. ISSUANCE KEYED TO A NAME. /api/sessions/register is idempotent, and the re-register
//      branch (daemon.js:2897) hands `session_token: mintSessionToken(session_id)` to ANY
//      caller that names an already-registered sid — no token required.
//   2. LOOPBACK IS TRUSTED BEFORE THE TOKEN CHECK. src/protocol/http-auth.js passes a loopback
//      caller ahead of the token branch, and the 0.7.1 Origin guard is a deliberate no-op for
//      origin-less callers (`if (!origin) return false`) — exactly the curl/CLI shape used here.
//   3. TOKENS ARE NEVER REVOKED. `sessionTokens.delete` has zero call sites; DELETE
//      /api/sessions/:id (daemon.js:4316) leaves the mapping intact, so a cleaned-up-and-
//      respawned sid inherits its predecessor's authority for the daemon's lifetime.
//
// Every assertion below states the SECURE behavior. Before the fix they fail, and each failure
// message is itself the reproduction (e.g. "expected undefined, got <the victim's live token>").
// Hermetic throughout: PORT=0 + mkdtemp HOME via the shared harness — the production daemon on
// :3848 is never contacted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

let daemon;
let logPath;

before(async () => {
  daemon = await startTestDaemon({ env: { TELEPTY_AUDIT_FLUSH_MS: '10' } });
  logPath = path.join(daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
});

after(async () => { if (daemon) await daemon.stop(); });

// Wait until an audit line matches `predicate` and return it. Predicate-gated so a test never
// races the 10ms flush against lines written by an earlier test in this file.
async function waitForAuditLine(predicate) {
  return daemon.waitFor(() => {
    let raw = '';
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return null; }
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return lines.find(predicate) || null;
  }, { timeoutMs: 4000, description: 'audit line' });
}

function register(sessionId, headers = {}) {
  return daemon.request('/api/sessions/register', {
    method: 'POST', headers, body: { session_id: sessionId, command: 'x' }
  });
}

function injectWithToken(targetSid, token, prompt, from) {
  return daemon.request(`/api/sessions/${encodeURIComponent(targetSid)}/inject`, {
    method: 'POST',
    headers: token ? { 'x-telepty-session-token': token } : {},
    body: { prompt, from }
  });
}

// RED 1 — the impersonation itself. A second, tokenless, origin-less caller re-registers a
// LIVE victim's sid and must not be handed the victim's credential.
test('#815 RED-1: re-registering a live sid without its token discloses no token', async () => {
  const victim = createSessionId('victim815');
  const victimReg = await register(victim);
  assert.equal(victimReg.status, 201);
  const victimToken = victimReg.body.session_token;
  assert.equal(typeof victimToken, 'string', 'first registration must still mint a token');

  // The attacker: no token, no Origin header, same loopback shape as `curl`.
  const attackerReg = await register(victim);
  assert.equal(attackerReg.status, 200, 're-register stays idempotent (metadata update)');
  assert.equal(
    attackerReg.body.session_token, undefined,
    'a tokenless re-register must not disclose the session token'
  );
});

// RED 1b — the consequence: what the disclosed token buys. Even granting the attacker the
// victim's token by any route, this pins the end-to-end attribution claim it produces today.
test('#815 RED-1b: a token obtained by tokenless re-register cannot speak as the victim', async () => {
  // The victim is the ORCHESTRATOR — the highest-value identity on the mesh, and the one whose
  // lane the #45 peer guard actually permits to drive other sessions. Impersonating it is the
  // whole point of the attack. (A peer→peer claim is rejected 403 by classifyPeerLaneInject
  // before attribution is even reached, so it cannot exercise this path.)
  const victim = 'orchestrator';
  const victimReg = await register(victim);
  const victimToken = victimReg.body.session_token;

  const attackerReg = await register(victim);
  const stolen = attackerReg.body.session_token;

  const target = createSessionId('target815b');
  await daemon.spawnSession(target);
  const res = await injectWithToken(target, stolen, 'i am the victim', victim);
  assert.equal(res.status, 200, 'delivery is not what changes — attribution is');

  const line = await waitForAuditLine((l) => l.to === target && l.claimed_from === victim);
  assert.notEqual(
    line.verified_sender_sid, victim,
    'daemon must not attribute an inject to a session that did not send it'
  );
  assert.ok(stolen !== victimToken || stolen === undefined,
    'the re-register must not return the victim\'s live token');
});

// RED 2 — revocation. Cleanup + respawn under the same id is routine here (worker cleanup and
// id/track reuse are standard practice), so a dead session's token must die with it.
test('#815 RED-2: teardown revokes the token; a respawned id does not inherit it', async () => {
  const sid = createSessionId('reuse815');
  const firstReg = await register(sid);
  assert.equal(firstReg.status, 201);
  const predecessorToken = firstReg.body.session_token;

  const del = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);

  // Same id comes back — a NEW incarnation, and a new registrant.
  const secondReg = await register(sid);
  assert.equal(secondReg.status, 201, 'the id is free again, so this is a first registration');
  const successorToken = secondReg.body.session_token;
  assert.notEqual(
    successorToken, predecessorToken,
    'a respawned id must not inherit its predecessor\'s token'
  );

  // And the predecessor's token must resolve to nothing at all — fail closed, never a
  // fallback to the claimed name.
  // No `from`: this is an operator-lane inject, which classifyPeerLaneInject leaves untouched, so
  // the test exercises REVOCATION rather than the #533 peer-lane policy. (RED-1b already pins the
  // "never fall back to the claimed name" half, by claiming to be the orchestrator.)
  const target = createSessionId('target815c');
  await daemon.spawnSession(target);
  const res = await injectWithToken(target, predecessorToken, 'ghost of a dead session', undefined);
  assert.equal(res.status, 200);

  const line = await waitForAuditLine((l) => l.to === target);
  assert.equal(
    line.verified_sender_sid, null,
    'a revoked token must yield NO verified sender, not the sid it used to name'
  );
  assert.equal(line.verified_sender_epoch, null, 'and no epoch either — fail closed, fully');
});

// GREEN GUARD — the legitimate bridge reconnect (cli.js connectDaemonWs, the #678 restore path)
// re-registers BEFORE the WS connect, carrying its token via fetchWithAuth (cli.js:174-181).
// That path must keep working, or every reconnect loses its identity.
test('#815 GUARD: re-register works and discloses NOTHING, even to the true owner', async () => {
  const sid = createSessionId('bridge815');
  const reg = await register(sid);
  const token = reg.body.session_token;
  const epoch = reg.body.session_epoch;

  const rereg = await register(sid, { 'x-telepty-session-token': token });
  assert.equal(rereg.status, 200);
  assert.equal(rereg.body.reregistered, true, 'metadata re-register still updates the record');
  // A re-register returns no bearer material to ANYONE — the holder does not need a copy back
  // (the bridge has it in env, the child got it at spawn), and "return it to whoever proves they
  // already have it" is an oracle we simply do not need to offer.
  assert.equal(rereg.body.session_token, undefined, 'no bearer on re-register, ever');
  assert.equal(rereg.body.session_nonce, undefined, 'no provenance nonce on re-register, ever');
  // The epoch IS returned: it is a non-secret instance discriminator, not a credential.
  assert.equal(rereg.body.session_epoch, epoch, 'same instance answers with the same epoch');

  // And the token still verifies afterwards — a re-register must not rotate it out from under
  // the child's spawn-time env copy.
  const target = createSessionId('target815e');
  await daemon.spawnSession(target);
  await injectWithToken(target, token, 'still me after re-register', sid);
  const line = await waitForAuditLine((l) => l.to === target && l.claimed_from === sid);
  assert.equal(line.verified_sender_sid, sid);
});

// D2 — the provenance nonce (#47 P4) had the IDENTICAL defect on the same two response lines:
// idempotent per sid, handed to any caller on re-register, never revoked. A token-only fix would
// leave the provenance fence bypassable by the same one-line curl.
test('#815 D2: the provenance nonce is issued once and never re-disclosed', async () => {
  const sid = createSessionId('nonce815');
  const reg = await register(sid);
  assert.equal(typeof reg.body.session_nonce, 'string', 'first registration still delivers it');

  const attacker = await register(sid);
  assert.equal(attacker.body.session_nonce, undefined, 'a tokenless re-register discloses no nonce');
});

// D4 — the same endpoint allowed an uncredentialed caller to rewrite where a live session's
// injects are DELIVERED. Same "keyed to a name" root cause; shipping the token fix without this
// would leave a second unauthenticated mutation in the endpoint being hardened.
test('#815 D4: an uncredentialed re-register cannot redirect the delivery endpoint', async () => {
  const sid = createSessionId('deliv815');
  const reg = await register(sid, {});
  const token = reg.body.session_token;

  // Attacker: no credential, tries to point this session's deliveries at its own endpoint.
  await daemon.request('/api/sessions/register', {
    method: 'POST',
    body: { session_id: sid, command: 'x', delivery_endpoint: 'attacker://pwned' }
  });
  let list = await daemon.request('/api/sessions');
  let record = list.body.find((s) => s.id === sid);
  assert.notEqual(record.deliveryEndpoint, 'attacker://pwned', 'uncredentialed redirect refused');

  // The credentialed owner may still legitimately update it.
  await daemon.request('/api/sessions/register', {
    method: 'POST',
    headers: { 'x-telepty-session-token': token },
    body: { session_id: sid, command: 'x', delivery_endpoint: 'aterm://legit' }
  });
  list = await daemon.request('/api/sessions');
  record = list.body.find((s) => s.id === sid);
  assert.equal(record.deliveryEndpoint, 'aterm://legit', 'the credentialed owner may still update');
});

// GREEN GUARD — first registration of a never-seen sid is the one issuance point and must be
// unaffected: this is how every bridge, aterm session and cross-host registration bootstraps.
test('#815 GUARD: first registration of an unknown sid still mints a usable token', async () => {
  const sid = createSessionId('first815');
  const reg = await register(sid);
  assert.equal(reg.status, 201);
  assert.equal(typeof reg.body.session_token, 'string');

  const target = createSessionId('target815d');
  await daemon.spawnSession(target);
  await injectWithToken(target, reg.body.session_token, 'legitimately mine', sid);
  const line = await waitForAuditLine((l) => l.to === target && l.claimed_from === sid);
  assert.equal(line.verified_sender_sid, sid);
  assert.equal(line.spoof_suspected, false);
});

// ITEM 4 — the requirement that resolved the dispatch's dilemma. The daemon persists a VERIFIER
// (never the bearer), so the SAME bearer stays verifiable across a daemon restart with no
// reissuance. This matters because the wrapped child carries the bearer in its spawn-time
// environment, and the environment of a running process cannot be changed from outside: if the
// credential did not survive the restart, every restored session would silently become an
// unauthenticated sender and no reissuance could ever reach the child.
test('#815 item4: the same bearer still verifies after a daemon RESTART (verifier persisted)', async () => {
  // An isolated daemon PAIR over one shared HOME, so the file-backed handover is the real thing
  // and the suite's own daemon is left untouched.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-815-restart-'));
  const sid = createSessionId('restart815');
  const first = await startTestDaemon({ homeDir: home, env: { TELEPTY_AUDIT_FLUSH_MS: '10' } });
  let second = null;
  try {
    const reg = await first.request('/api/sessions/register', {
      method: 'POST', body: { session_id: sid, command: 'x' }
    });
    const bearer = reg.body.session_token;
    const epoch = reg.body.session_epoch;
    assert.equal(typeof bearer, 'string');

    // stop() runs cleanupSessions() first, which DELETEs every session — and DELETE now revokes.
    // Kill the process directly instead: that is what a daemon restart actually looks like.
    await first.kill();

    // The raw bearer must not be what carried the identity across — prove it is absent from disk.
    const persistedPath = path.join(home, '.config', 'aigentry-telepty', 'sessions.json');
    const persisted = fs.readFileSync(persistedPath, 'utf8');
    assert.equal(persisted.includes(bearer), false, 'the raw bearer must NEVER be persisted');
    assert.equal(persisted.includes(epoch), true, 'the epoch is persisted — non-secret discriminator');
    assert.equal(fs.statSync(persistedPath).mode & 0o777, 0o600, 'verifier store is owner-only');

    second = await startTestDaemon({ homeDir: home, env: { TELEPTY_AUDIT_FLUSH_MS: '10' } });
    const target = createSessionId('target815f');
    await second.spawnSession(target);
    const res = await second.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
      method: 'POST',
      headers: { 'x-telepty-session-token': bearer },
      body: { prompt: 'survived the restart' }
    });
    assert.equal(res.status, 200);

    const line = await second.waitFor(() => {
      let raw = '';
      try { raw = fs.readFileSync(path.join(home, '.telepty', 'logs', 'injects.jsonl'), 'utf8'); } catch { return null; }
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.to === target) || null;
    }, { timeoutMs: 4000, description: 'audit line after restart' });

    assert.equal(line.verified_sender_sid, sid, 'the child\'s spawn-time bearer still authenticates');
    assert.equal(line.verified_sender_epoch, epoch, 'and resolves to the SAME instance');
  } finally {
    if (second) await second.stop();
    else await first.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// sessions.json now carries credential verifiers, so it must be owner-only — including a file
// left world-readable by a pre-#815 daemon, which is why load() chmods too.
test('#815 item4: sessions.json is 0600', async () => {
  const sid = createSessionId('mode815');
  await register(sid);
  const p = path.join(daemon.homeDir, '.config', 'aigentry-telepty', 'sessions.json');
  await daemon.waitFor(() => fs.existsSync(p), { description: 'sessions.json' });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

// FINDING (b) / D1 — the ?owner=1 claim was unauthenticated: any local process could take over a
// live PTY byte stream, displacing the real bridge with close 4001. Hijacking the terminal is at
// least as bad as reading the token. This is the half of C1 worth having, without the cli.js
// reorder that C1 would have required.
test('#815 finding-b: an uncredentialed ?owner=1 claim is refused (4003), a credentialed one is not', async () => {
  const sid = createSessionId('claim815');
  const reg = await register(sid);
  const bearer = reg.body.session_token;
  const url = `ws://${daemon.host}:${daemon.port}/api/sessions/${encodeURIComponent(sid)}?owner=1&token=${encodeURIComponent(daemon.authToken())}`;

  const refused = await new Promise((resolve, reject) => {
    // #820: the DAEMON token (in `url`) upgrades the socket; what this attacker lacks is the
    // per-session bearer, which is the credential under test here. Two credentials, two
    // questions — conflating them would make this assert the transport gate by accident.
    const ws = new WebSocket(url); // no SESSION bearer — the attacker's shape
    ws.once('close', (code) => resolve(code));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('claim was neither refused nor closed')), 4000);
  });
  assert.equal(refused, 4003, 'unauthenticated owner claim must be refused, loudly');

  const owner = new WebSocket(url, { headers: { 'x-telepty-session-token': bearer } });
  try {
    const gotOwnerToken = await new Promise((resolve, reject) => {
      owner.on('message', (m) => {
        const msg = JSON.parse(m);
        if (msg.type === 'owner_token' && msg.token) resolve(true);
      });
      owner.once('close', (code) => reject(new Error(`credentialed claim was refused: ${code}`)));
      owner.once('error', reject);
      setTimeout(() => reject(new Error('no owner_token frame')), 4000);
    });
    assert.equal(gotOwnerToken, true, 'the credentialed owner still claims normally');
  } finally {
    owner.close();
  }
});

// A session with NO credential must still claim freely — this is the WS auto-register path (a
// reconnect that beats its own re-register POST) and any record restored from a pre-#815 daemon.
// Breaking it would break reconnect, which is exactly what the dispatch forbade.
test('#815 finding-b: a session with no credential still claims ownership freely', async () => {
  const sid = createSessionId('nocred815');
  const url = `ws://${daemon.host}:${daemon.port}/api/sessions/${encodeURIComponent(sid)}?owner=1&command=bash&token=${encodeURIComponent(daemon.authToken())}`;
  const ws = new WebSocket(url); // never registered → daemon auto-registers on WS connect
  try {
    const claimed = await new Promise((resolve, reject) => {
      ws.on('message', (m) => {
        const msg = JSON.parse(m);
        if (msg.type === 'owner_token' && msg.token) resolve(true);
      });
      ws.once('close', (code) => reject(new Error(`auto-register claim refused: ${code}`)));
      ws.once('error', reject);
      setTimeout(() => reject(new Error('no owner_token frame')), 4000);
    });
    assert.equal(claimed, true);
  } finally {
    ws.close();
  }
});

// ADDENDUM requirement — displacing a LIVE owner must produce a truthful observation. Before this,
// the takeover that ends a running agent (displaced bridge reads 4001 and exits) emitted nothing:
// hadDisconnectedOwner is false for a live incumbent, so not even the wrong event fired. Silence
// reads as continuity. This asserts the honest fact is on the bus, and that it is NOT a reconnect.
test('#815 addendum: displacing a live owner emits session_owner_replaced, not session_reconnect', async () => {
  const sid = createSessionId('displace815');
  const url = `ws://${daemon.host}:${daemon.port}/api/sessions/${encodeURIComponent(sid)}?owner=1&command=bash&token=${encodeURIComponent(daemon.authToken())}`;
  const bus = await daemon.connectBus();
  const events = [];
  bus.on('message', (m) => { try { events.push(JSON.parse(m)); } catch {} });

  // No credential on this session (WS auto-register path), so displacement is still legal — this
  // is exactly the residual case the event has to describe.
  const incumbent = new WebSocket(url);
  await new Promise((resolve, reject) => {
    incumbent.once('open', resolve);
    incumbent.once('error', reject);
  });

  const claimant = new WebSocket(url);
  try {
    const displaced = await new Promise((resolve, reject) => {
      incumbent.once('close', (code) => resolve(code));
      claimant.once('error', reject);
      setTimeout(() => reject(new Error('incumbent was never displaced')), 4000);
    });
    assert.equal(displaced, 4001, 'incumbent is displaced with the #56 code (unchanged)');

    const replaced = await daemon.waitFor(
      () => events.find((e) => e.type === 'session_owner_replaced' && e.session_id === sid) || null,
      { timeoutMs: 4000, description: 'session_owner_replaced' }
    );
    assert.equal(replaced.reason, 'owner_claim_displaced_live_owner');
    assert.equal(replaced.claim_was_credentialed, false, 'and it states the claim was unproven');
    assert.equal(
      events.some((e) => e.type === 'session_reconnect' && e.session_id === sid), false,
      'a takeover must never be reported as a reconnect'
    );
  } finally {
    claimant.close();
    incumbent.close();
    bus.close();
  }
});
