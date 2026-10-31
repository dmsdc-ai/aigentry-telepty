'use strict';
// #1207 × Linux 9b80289 integration regressions (task1207 resume2). Each case pins one seam where
// Linux code written against the 0.9.x synchronous in-memory ledger meets the asynchronous
// directory-store ledger, through the REAL daemon (or the real runtime fixture):
//   S1  poll-only mailbox inject: the `inject_parked` observation is durable before `queued` is answered.
//   S3  diagnostics correlation reads the AUTHORITATIVE ledger (a cold record is found), and a true
//       miss is still 404 INJECT_NOT_OBSERVED.
//   S4  test-support/session-delivery-fixture.js binds a real ledger (no removed in-memory mirror).
//   P4  restore never brings an unsafe persisted id into the null-prototype session registry.
//   H   the daemon harness's readiness includes a settled store, so a tracked inject sent right after
//       start is not refused 503 recovering.
// Author-written in the source phase; NOT RUN here. Independent CI executes it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');
const { makeHistoricalRecord, writeLegacyLedger } = require('./fixtures/ledger-1207/legacy-fixture');
const persistence = require('../src/session-store/persistence');

const configDir = (home) => path.join(home, '.config', 'aigentry-telepty');
async function registerMailbox(d, sid) {
  const r = await d.request('/api/sessions/register', { method: 'POST', body: { session_id: sid, delivery_type: 'mailbox', command: 'poller' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test('H + S1: right after start a tracked poll-only inject is accepted, and its inject_parked observation is already durable when `queued` is answered', async () => {
  const d = await startTestDaemon();
  try {
    const sid = createSessionId('s1-poll');
    await registerMailbox(d, sid);
    const injected = await d.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body: { prompt: 'park me', from: 'orchestrator' } });
    assert.equal(injected.status, 200, `not refused while the store recovers: ${JSON.stringify(injected.body)}`);
    assert.equal(injected.body.queued, true); assert.equal(injected.body.poll_only, true); assert.equal(injected.body.bytes_written, 0);
    // No wait: the answer above was sent only after the park was acknowledged by the owner.
    const poll = await d.request(`/api/inject-observations/${encodeURIComponent(injected.body.inject_id)}`);
    assert.equal(poll.status, 200, JSON.stringify(poll.body));
    assert.equal(poll.body.tracking_state, 'tracked');
    assert.equal(poll.body.observation.kind, 'inject_parked', JSON.stringify(poll.body.observation));
    assert.equal(poll.body.observation.trigger, 'mailbox');
    assert.equal(poll.body.observation.reason, 'poll_pending');
    assert.equal(poll.body.observation.bytes_written, 0);
  } finally { await d.stop(); }
});

test('S3: diagnostics correlation finds a COLD record through the authoritative ledger read; an unknown inject id is still 404 INJECT_NOT_OBSERVED', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-s3-cold-'));
  const sid = createSessionId('s3-cold');
  const coldId = crypto.randomUUID();
  // A 0.9.x file migrated at start: every historical record lands in the immutable cold tier.
  const ledger = { ...persistence.emptyTrackedInjections(), generation: 3, injections: { [coldId]: makeHistoricalRecord(coldId, sid, 3) } };
  writeLegacyLedger(path.join(configDir(home), 'tracked-injections.json'), { ledger });
  let d = null;
  try {
    d = await startTestDaemon({ homeDir: home });
    const status = await d.request('/api/ledger/status');
    assert.equal(status.status, 200); assert.equal(status.body.healthy, true, JSON.stringify(status.body));
    assert.equal(status.body.owner.counts.cold, 1); assert.equal(status.body.owner.counts.hot, 0, 'the record is cold, not in the hot read model');
    await registerMailbox(d, sid);
    const machineId = (await d.request('/api/meta')).body.machine_id;
    const diag = (injectId) => d.request(`/api/sessions/${encodeURIComponent(sid)}/diagnostics?machine_id=${encodeURIComponent(machineId)}&inject_id=${injectId}`);
    // Found: the historical record has no session epoch, so correlation refuses it BY NAME (409)
    // instead of the hot-only read's 404 "not observed".
    const found = await diag(coldId);
    assert.equal(found.status, 409, JSON.stringify(found.body));
    assert.equal(found.body.code, 'INJECT_EPOCH_MISMATCH');
    const missing = await diag(crypto.randomUUID());
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body.code, 'INJECT_NOT_OBSERVED');
  } finally {
    if (d) await d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('S4: the session-delivery fixture tracks through a real ledger — begin is durable and readable, nothing reads a removed mirror', async () => {
  const { createSessionDeliveryFixture } = require('../test-support/session-delivery-fixture');
  const fixture = createSessionDeliveryFixture();
  try {
    const injectId = crypto.randomUUID();
    const session = { type: 'wrapped', ownerWs: null, clients: new Set(), outputRing: [], outputRingTotalBytes: 0, ready: true };
    const begun = await fixture.beginTrackedInjection({ injectId, sessionId: 'fixture-s4', source: 'orchestrator', session });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    assert.equal(fixture.ledgerClient.state, 'available');
    const record = fixture.getTrackedInjection(injectId);
    assert.ok(record, 'the begun record is in the committed read model');
    assert.equal(record.tracking_state, 'tracked');
    assert.equal(record.last_observation.kind, 'tracking_started');
  } finally { await fixture.dispose(); }
});

test('P4: restore skips persisted ids no producer may register (prototype names, path separators); a valid id is restored', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-p4-restore-'));
  const ok = createSessionId('p4-restore');
  fs.mkdirSync(configDir(home), { recursive: true, mode: 0o700 });
  // Raw JSON text: a `__proto__` key must be an OWN key of the parsed object, exactly as on disk.
  const text = `{${[ok, '__proto__', 'constructor', '../escape'].map((id) => `${JSON.stringify(id)}:{"type":"wrapped","command":"restored"}`).join(',')}}`;
  fs.writeFileSync(path.join(configDir(home), 'sessions.json'), text, { mode: 0o600 });
  let d = null;
  try {
    d = await startTestDaemon({ homeDir: home });
    const listing = await d.request('/api/sessions');
    assert.equal(listing.status, 200);
    const ids = listing.body.map((s) => s.id);
    assert.ok(ids.includes(ok), `the valid persisted id is restored: ${JSON.stringify(ids)}`);
    for (const bad of ['__proto__', 'constructor', '../escape']) assert.equal(ids.includes(bad), false, `${bad} must not be restored`);
    assert.equal((await d.request('/api/sessions/__proto__')).status, 404);
    assert.equal((await d.request('/api/sessions/constructor')).status, 404);
  } finally {
    if (d) await d.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
