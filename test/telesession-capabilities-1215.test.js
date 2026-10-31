'use strict';

// task 1215 — the three opt-in HTTP contracts a Telesession/Kkoma consumer requires
// (evidence/telesession-transport.js: REQUIRED_CAPABILITIES):
//
//   register-create-only   POST /api/sessions/register  { create_only: true }   → 409 SESSION_EXISTS on
//                          an exact own-record collision, BEFORE any re-register mutation.
//   inject-exact-target    POST /api/sessions/:id/inject { exact_target: true } → exact own-record id
//                          only, never an alias/sibling fallback; the 200 body confirms
//                          `exact_target:true` and the actual `session_id`.
//   delete-owned-session   DELETE /api/sessions/:id?owned=true                 → exact id only, and the
//                          caller must present THIS instance's current credential (sid + epoch +
//                          generation) or get 403 OWNED_DELETE_FORBIDDEN with no side effect.
//
// Each contract is exercised through the real daemon over HTTP. Sessions are `aterm` registrations
// whose delivery endpoint is a loopback HTTP sink in this process, so "delivered" and "not delivered"
// are measured at the receiving end rather than inferred from a status code. No PTY, no provider,
// no OS UI, no external network. The daemon binds PORT=0 on 127.0.0.1 under a private temp HOME.
//
// The cases are deliberately independent of each other and of the capability advertisement. Read
// against the unchanged 0.9.1 routes, nine cases discriminate the baseline, each on ITS OWN
// assertion rather than on a shared metadata precondition: the /api/meta case; both exact-target
// cases (no `exact_target`/`session_id` in the body; alias resolved and delivered); the create-only
// fresh case (no `session_id` in the exact inject body) and collision case (200 re-register, not
// 409); the three refused owned deletes (no / wrong / stale bearer all tear the record down); and
// the bare-alias owned delete (the single sibling is deleted). The remaining cases pass on BOTH:
// the four marked "control" pin the non-opt-in behaviour, the create-only invalid-id case pins
// validation the baseline already performs, and the current-bearer owned delete positive passes
// the baseline too (an unchecked tokenless DELETE of an exact id also returns 200 and removes the
// record) - it is the positive half of a contract whose discrimination lives in its refusals. The
// consumer-shape case at the end of the file fails the baseline on the `exact_target` confirmation.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startTestDaemon, createSessionId, delay } = require('../test-support/daemon-harness');

const REQUIRED = ['inject-exact-target', 'register-create-only', 'delete-owned-session'];
const BASELINE = ['sessions', 'wrapped-sessions', 'skill-installer', 'singleton-daemon',
  'handoff-inbox', 'deliberation-threads', 'cross-machine', 'mailbox'];

let daemon;
let primarySink;   // the delivery endpoint every ordinary registration in this file uses
let otherSink;     // a second endpoint, used only to prove a collision did NOT redirect delivery

// A loopback HTTP endpoint that records every aterm delivery it receives, keyed by session id.
async function startSink() {
  const deliveries = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = { text: raw }; }
      deliveries.push({ session_id: body.session_id || null, text: typeof body.text === 'string' ? body.text : '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/deliver`,
    deliveries,
    textsFor: (sid) => deliveries.filter((d) => d.session_id === sid).map((d) => d.text),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

before(async () => {
  primarySink = await startSink();
  otherSink = await startSink();
  // The orchestrator sid list is pinned so the peer-lane guard (#533) behaves identically on every
  // host: `from: "orchestrator"` is the orchestrator lane, any other sender is the peer lane.
  daemon = await startTestDaemon({ env: { AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator' } });
});

after(async () => {
  if (daemon) await daemon.stop();
  if (primarySink) await primarySink.close();
  if (otherSink) await otherSink.close();
});

// --- helpers ------------------------------------------------------------------------------------

function enc(sid) {
  return encodeURIComponent(sid);
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// An alias base that does NOT end in `-<digits>`, so that `base` is a bare alias of `${base}-7`
// under the daemon's base-alias rule (strip one trailing `-<digits>`), and `${base}-8` is a
// fully-qualified sibling name with no record of its own.
function aliasBase(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-x`;
}

async function registerAterm(sid, overrides = {}) {
  const result = await daemon.registerSession(sid, {
    delivery_type: 'aterm',
    delivery_endpoint: primarySink.url,
    command: 'telesession-inbox',
    ...overrides,
  });
  assert.equal(result.status, 201, `register ${sid} failed: ${JSON.stringify(result.body)}`);
  assert.equal(typeof result.body.session_token, 'string');
  assert.equal(typeof result.body.session_epoch, 'string');
  return result.body;
}

function inject(target, body, headers = {}) {
  return daemon.request(`/api/sessions/${enc(target)}/inject`, { method: 'POST', body, headers });
}

function getSession(sid) {
  return daemon.request(`/api/sessions/${enc(sid)}`);
}

function ownedDelete(target, bearer) {
  return daemon.request(`/api/sessions/${enc(target)}?owned=true`, {
    method: 'DELETE',
    headers: bearer ? { 'x-telepty-session-token': bearer } : {},
  });
}

async function waitForDelivery(sink, sid, count) {
  await daemon.waitFor(() => sink.textsFor(sid).length >= count, {
    description: `${count} delivery(ies) for ${sid}`,
  });
  return sink.textsFor(sid);
}

// Proves a record is still live AND still routed to its original endpoint after a refusal.
async function assertStillDeliverable(sid, marker) {
  const before = primarySink.textsFor(sid).length;
  const ok = await inject(sid, { prompt: marker });
  assert.equal(ok.status, 200, `control inject to ${sid} failed: ${JSON.stringify(ok.body)}`);
  const texts = await waitForDelivery(primarySink, sid, before + 1);
  assert.ok(texts[texts.length - 1].includes(marker), 'control inject reached the original endpoint');
}

// --- capability advertisement -------------------------------------------------------------------

test('1215: /api/meta retains each consumer-required capability alongside SSH receipt support', async () => {
  const meta = await daemon.request('/api/meta');
  assert.equal(meta.status, 200);
  const caps = meta.body.capabilities;
  assert.ok(Array.isArray(caps), 'capabilities is an array');
  for (const cap of REQUIRED) {
    assert.ok(caps.includes(cap), `capabilities must advertise ${cap}`);
    assert.equal(caps.filter((c) => c === cap).length, 1, `${cap} advertised exactly once`);
  }
  for (const cap of BASELINE) {
    assert.ok(caps.includes(cap), `baseline capability ${cap} must be retained`);
  }
  assert.ok(caps.includes('ssh-child-write-receipts-v1'));
  // #137 (accepted; asserted by bridge-stage-receipts-137 S3): the daemon also advertises bridge-stage receipts.
  assert.equal(caps.filter((c) => c === 'bridge-stage-receipts-v1').length, 1, 'bridge-stage-receipts-v1 advertised exactly once');
  // Task 1215 W3B: the authenticated graceful local stop (POST /api/daemon/stop) is advertised exactly once.
  assert.equal(caps.filter((c) => c === 'daemon-graceful-stop-v1').length, 1, 'daemon-graceful-stop-v1 advertised exactly once');
  assert.equal(caps.length, BASELINE.length + REQUIRED.length + 3, 'only the explicit SSH receipt, #137 bridge-stage receipt and 1215 graceful-stop capabilities were added');
});

// --- inject-exact-target ------------------------------------------------------------------------

test('1215 inject-exact-target: an exact own id is delivered and the response confirms the target', async () => {
  const base = aliasBase('t1215-inbox');
  const inbox = `${base}-1`;
  const target = createSessionId('t1215-target');
  const inboxReg = await registerAterm(inbox);
  await registerAterm(target);

  // Consumer-shaped request on the orchestrator lane: tracked (`from`), reply routed to the inbox.
  const res = await inject(target, {
    prompt: '[telesession nonce=0123456789abcdef0123456789abcdef reply-to=' + inbox + ']\nexact hello',
    from: 'orchestrator', reply_to: inbox, exact_target: true,
  });
  assert.equal(typeof inboxReg.session_token, 'string', 'precondition: the inbox holds a bearer');
  assert.equal(res.status, 200, `inject failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.inject_id, 'string');
  assert.equal(res.body.exact_target, true, 'response must confirm exact_target');
  assert.equal(res.body.session_id, target, 'response must name the actual session id');

  const texts = await waitForDelivery(primarySink, target, 1);
  assert.ok(texts[0].includes('exact hello'), 'payload reached the exact target endpoint');
  assert.equal(primarySink.textsFor(inbox).length, 0, 'the sender inbox received nothing');

  // The observation ledger names the same exact instance the response did.
  const obs = await daemon.request(`/api/inject-observations/${enc(res.body.inject_id)}`);
  assert.equal(obs.status, 200);
  assert.equal(obs.body.session_id, target);
});

test('1215 inject-exact-target: an alias-only name is 404 and the sibling receives nothing', async () => {
  const base = aliasBase('t1215-alias');
  const sibling = `${base}-7`;
  await registerAterm(sibling);

  for (const requested of [base, `${base}-8`]) {
    const res = await inject(requested, { prompt: 'must not arrive ' + requested, from: 'orchestrator', exact_target: true });
    assert.equal(res.status, 404, `${requested}: expected 404, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'SESSION_NOT_FOUND');
    assert.equal(res.body.exact_target, true);
    assert.equal(res.body.success, false);
  }

  // Measured at the receiving end: nothing was routed to the sibling by either refused request.
  await delay(300);
  assert.deepEqual(primarySink.textsFor(sibling), [], 'no unintended delivery to the alias sibling');

  // And the sibling is untouched: the next exact delivery is the first thing it receives.
  await assertStillDeliverable(sibling, 'after refusal ' + sibling);
  assert.equal(primarySink.textsFor(sibling).length, 1);
});

test('1215 control: exact_target does not bypass the peer-lane guard — a refused inject delivers nothing', async () => {
  const inbox = createSessionId('1215-peer-inbox');
  const target = createSessionId('1215-peer-target');
  const inboxReg = await registerAterm(inbox);
  await registerAterm(target);

  // Peer → peer with no sanctioned JSON envelope on the first line: #533 blocks this in-band, and
  // the exact-target opt-in must leave that refusal exactly as it is.
  const res = await inject(target, {
    prompt: '[telesession nonce=0123456789abcdef0123456789abcdef reply-to=' + inbox + ']\npeer hello',
    from: inbox, reply_to: inbox, exact_target: true,
  }, { 'x-telepty-session-token': inboxReg.session_token });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, 'PEER_INJECT_BLOCKED');
  assert.equal(res.body.success, false);
  assert.equal(res.body.exact_target, undefined, 'a refusal is not decorated as an exact delivery');

  await delay(300);
  assert.deepEqual(primarySink.textsFor(target), [], 'nothing was delivered to the target');
  assert.equal((await getSession(target)).status, 200, 'target record intact');
});

test('1215 control: without the boolean opt-in, alias resolution still delivers to the sibling', async () => {
  const base = aliasBase('t1215-ctl');
  const sibling = `${base}-3`;
  await registerAterm(sibling);

  const plain = await inject(base, { prompt: 'alias plain' });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.exact_target, undefined, 'no exact_target field unless opted in');

  // A string "true" is not the boolean opt-in — existing alias behaviour applies.
  const stringy = await inject(`${base}-4`, { prompt: 'alias stringy', exact_target: 'true' });
  assert.equal(stringy.status, 200, JSON.stringify(stringy.body));

  const texts = await waitForDelivery(primarySink, sibling, 2);
  assert.ok(texts.some((t) => t.includes('alias plain')));
  assert.ok(texts.some((t) => t.includes('alias stringy')));
});

// --- register-create-only -----------------------------------------------------------------------

test('1215 register-create-only: a fresh id is created with a credential and is deliverable', async () => {
  const sid = createSessionId('t1215-fresh');
  const reg = await registerAterm(sid, { create_only: true });
  assert.equal(reg.session_id, sid);
  assert.equal(typeof reg.credential_generation, 'number');

  const res = await inject(sid, { prompt: 'fresh hello', exact_target: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.session_id, sid);
  const texts = await waitForDelivery(primarySink, sid, 1);
  assert.ok(texts[0].includes('fresh hello'));
});

test('1215 register-create-only: a colliding id is 409 SESSION_EXISTS and the prior record is untouched', async () => {
  const sid = createSessionId('t1215-collide');
  const original = await registerAterm(sid);
  const beforeView = await getSession(sid);
  assert.equal(beforeView.status, 200);

  const collide = await daemon.request('/api/sessions/register', {
    method: 'POST',
    body: {
      session_id: sid, create_only: true, delivery_type: 'aterm',
      delivery_endpoint: otherSink.url, command: 'intruder-inbox', cwd: '/tmp/intruder',
    },
  });
  assert.equal(collide.status, 409, `expected 409, got ${collide.status} ${JSON.stringify(collide.body)}`);
  assert.equal(collide.body.code, 'SESSION_EXISTS');
  assert.equal(collide.body.success, false);
  assert.equal(collide.body.session_token, undefined, 'no credential material on a refusal');
  assert.equal(collide.body.session_epoch, undefined, 'no epoch disclosure on a refusal');

  // Record: same instance, same metadata, same delivery endpoint.
  const afterView = await getSession(sid);
  assert.equal(afterView.status, 200);
  assert.equal(afterView.body.createdAt, beforeView.body.createdAt, 'createdAt unchanged');
  assert.equal(afterView.body.command, 'telesession-inbox', 'command not overwritten');
  assert.equal(afterView.body.cwd, beforeView.body.cwd, 'cwd not overwritten');
  assert.equal(afterView.body.deliveryEndpoint, primarySink.url, 'delivery endpoint not redirected');

  // Delivery still goes to the original endpoint only.
  const res = await inject(sid, { prompt: 'still mine', exact_target: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await waitForDelivery(primarySink, sid, 1);
  await delay(200);
  assert.deepEqual(otherSink.textsFor(sid), [], 'the colliding endpoint received nothing');

  // Identity: the ORIGINAL bearer is still this instance's current credential.
  const del = await ownedDelete(sid, original.session_token);
  assert.equal(del.status, 200, `original bearer must still own the record: ${JSON.stringify(del.body)}`);
  assert.equal(del.body.success, true);
});

test('1215 control: an ordinary re-register (no boolean opt-in) is still the idempotent 200 path', async () => {
  const sid = createSessionId('t1215-rereg');
  await registerAterm(sid);

  const rereg = await daemon.registerSession(sid, {
    delivery_type: 'aterm', delivery_endpoint: primarySink.url, command: 'telesession-inbox-v2',
  });
  assert.equal(rereg.status, 200, JSON.stringify(rereg.body));
  assert.equal(rereg.body.reregistered, true);
  assert.equal(rereg.body.session_token, undefined, '#815: a re-register discloses no credential');

  // A string "true" is not the boolean opt-in either.
  const stringy = await daemon.registerSession(sid, {
    delivery_type: 'aterm', delivery_endpoint: primarySink.url, create_only: 'true',
  });
  assert.equal(stringy.status, 200, JSON.stringify(stringy.body));
  assert.equal(stringy.body.reregistered, true);
});

test('1215 register-create-only: existing session_id validation is preserved under the opt-in', async () => {
  const bad = await daemon.request('/api/sessions/register', {
    method: 'POST',
    body: { session_id: 'bad\u0007id', create_only: true, delivery_type: 'aterm', delivery_endpoint: primarySink.url },
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(String(bad.body.error), /session_id/i);

  const missing = await daemon.request('/api/sessions/register', {
    method: 'POST',
    body: { create_only: true, delivery_type: 'aterm', delivery_endpoint: primarySink.url },
  });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
});

// --- delete-owned-session -----------------------------------------------------------------------

test('1215 delete-owned-session: the current bearer deletes exactly its own session', async () => {
  const sid = createSessionId('t1215-own');
  const reg = await registerAterm(sid);

  const del = await ownedDelete(sid, reg.session_token);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.success, true);

  await daemon.waitFor(async () => (await getSession(sid)).status === 404, { description: `${sid} removed` });
  const list = await daemon.request('/api/sessions');
  assert.ok(!list.body.some((s) => s.id === sid), 'record is gone from the list');

  // The revoked bearer no longer owns anything: a second owned delete is a refusal, not a 200.
  const again = await ownedDelete(sid, reg.session_token);
  assert.equal(again.status, 404, JSON.stringify(again.body));
});

test('1215 delete-owned-session: a missing bearer is 403 OWNED_DELETE_FORBIDDEN and nothing is torn down', async () => {
  const sid = createSessionId('t1215-nobearer');
  await registerAterm(sid);

  const del = await ownedDelete(sid, null);
  assert.equal(del.status, 403, `expected 403, got ${del.status} ${JSON.stringify(del.body)}`);
  assert.equal(del.body.code, 'OWNED_DELETE_FORBIDDEN');
  assert.equal(del.body.success, false);

  assert.equal((await getSession(sid)).status, 200, 'record still present');
  await assertStillDeliverable(sid, 'after nobearer refusal');
});

test("1215 delete-owned-session: another session's bearer is 403 and the target survives", async () => {
  const victim = createSessionId('t1215-victim');
  const other = createSessionId('t1215-other');
  await registerAterm(victim);
  const otherReg = await registerAterm(other);

  const del = await ownedDelete(victim, otherReg.session_token);
  assert.equal(del.status, 403, `expected 403, got ${del.status} ${JSON.stringify(del.body)}`);
  assert.equal(del.body.code, 'OWNED_DELETE_FORBIDDEN');

  assert.equal((await getSession(victim)).status, 200, 'victim still present');
  assert.equal((await getSession(other)).status, 200, 'the presenting session was not torn down either');
  await assertStillDeliverable(victim, 'after wrong-bearer refusal');
});

test('1215 delete-owned-session: a stale bearer from a previous instance of the same sid is 403', async () => {
  const sid = createSessionId('t1215-stale');
  const first = await registerAterm(sid);

  // Ordinary teardown of the first instance (the tokenless operator path), then the same textual
  // sid is recreated: a new epoch, a new credential.
  const plainDelete = await daemon.request(`/api/sessions/${enc(sid)}`, { method: 'DELETE' });
  assert.equal(plainDelete.status, 200, JSON.stringify(plainDelete.body));
  await daemon.waitFor(async () => (await getSession(sid)).status === 404, { description: `${sid} first instance removed` });
  const second = await registerAterm(sid);
  assert.notEqual(second.session_epoch, first.session_epoch, 'precondition: recreated sid has a new epoch');

  const stale = await ownedDelete(sid, first.session_token);
  assert.equal(stale.status, 403, `expected 403, got ${stale.status} ${JSON.stringify(stale.body)}`);
  assert.equal(stale.body.code, 'OWNED_DELETE_FORBIDDEN');
  assert.equal((await getSession(sid)).status, 200, 'the live second instance survives');
  await assertStillDeliverable(sid, 'after stale refusal');

  // The CURRENT bearer still owns it.
  const current = await ownedDelete(sid, second.session_token);
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.equal(current.body.success, true);
});

test('1215 delete-owned-session: a bare alias never resolves to a sibling (404, sibling intact)', async () => {
  const base = aliasBase('t1215-delalias');
  const sibling = `${base}-5`;
  const reg = await registerAterm(sibling);

  // On the baseline, resolveSessionForDestroy resolves a bare alias with ONE live sibling to that
  // sibling — and with the sibling's own bearer presented, an owned delete must STILL refuse,
  // because the caller did not name the exact id.
  const del = await ownedDelete(base, reg.session_token);
  assert.equal(del.status, 404, `expected 404, got ${del.status} ${JSON.stringify(del.body)}`);
  assert.equal((await getSession(sibling)).status, 200, 'sibling still present');
  await assertStillDeliverable(sibling, 'after alias refusal');
});

test('1215 control: an ordinary tokenless DELETE of an exact id still works', async () => {
  const sid = createSessionId('t1215-plaindel');
  await registerAterm(sid);

  const del = await daemon.request(`/api/sessions/${enc(sid)}`, { method: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.success, true);
  await daemon.waitFor(async () => (await getSession(sid)).status === 404, { description: `${sid} removed` });
});

// --- consumer shape: Telesession inbox -> the configured orchestrator sid -----------------------

// The request evidence/telesession-transport.js send() actually issues, end to end: the inbox's
// CURRENT bearer as x-telepty-session-token, a plain non-JSON first line (no sanctioned peer
// envelope), `from`/`reply_to` naming the inbox, `exact_target:true`, and a target that is the
// configured orchestrator sid - the only route admitted for this consumer. The peer-lane guard is
// not bypassed or weakened: with the orchestrator sid as the target this is the orchestrator lane
// exactly as #533 defines it, and the peer->peer refusal control above stays in force. Sender
// attribution is read from the audit surface the consumer itself reads (GET /api/injects,
// `verified_sender_sid`), which the daemon derives from the presented bearer and never from the
// unverified `from` field.
test('1215 consumer shape: inbox bearer + plain first line + exact_target to the orchestrator sid is delivered and attributed', async () => {
  const target = 'orchestrator'; // the sid pinned via AIGENTRY_ORCHESTRATOR_SIDS in before()
  const inbox = createSessionId('t1215-consumer-inbox');
  const inboxReg = await registerAterm(inbox);
  await registerAterm(target);

  const prompt = '[telesession nonce=fedcba9876543210fedcba9876543210 reply-to=' + inbox + ']\nconsumer hello orchestrator';
  const res = await inject(target, {
    prompt, from: inbox, reply_to: inbox, exact_target: true,
  }, { 'x-telepty-session-token': inboxReg.session_token });

  // HTTP success in the exact shape the consumer requires before it trusts the routing.
  assert.equal(res.status, 200, `inject failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.inject_id, 'string');
  assert.equal(res.body.exact_target, true, 'response must confirm exact_target');
  assert.equal(res.body.session_id, target, 'response must name the actual target session id');

  // Delivered: the original message, in full, reached the orchestrator endpoint; the inbox got nothing.
  const texts = await waitForDelivery(primarySink, target, 1);
  assert.ok(texts[0].includes(prompt), 'the original message reached the orchestrator endpoint');
  assert.equal(primarySink.textsFor(inbox).length, 0, 'the sender inbox received nothing');

  // Attributed: the audit row for this inject_id names the inbox as the daemon-VERIFIED sender
  // (bearer-derived), with the inbox's own epoch, and nothing about it reads as a spoof.
  const row = await daemon.waitFor(async () => {
    const audit = await daemon.request(`/api/injects?to=${enc(target)}&limit=200`);
    if (audit.status !== 200 || !Array.isArray(audit.body.injects)) return null;
    return audit.body.injects.find((r) => r && r.inject_id === res.body.inject_id) || null;
  }, { timeoutMs: 4000, description: `audit row for ${res.body.inject_id}` });
  assert.equal(row.to, target);
  assert.equal(row.to_alias, null, 'exact routing: no alias was resolved');
  assert.equal(row.delivery_result, 'success');
  assert.equal(row.payload_sha256, sha256(prompt), 'the audited payload is the original message');
  assert.equal(row.claimed_from, inbox);
  assert.equal(row.verified_sender_sid, inbox, 'attribution comes from the presented bearer, not from `from`');
  assert.equal(row.verified_sender_epoch, inboxReg.session_epoch, 'and names THIS instance of the inbox');
  assert.equal(row.spoof_suspected, false);
});
