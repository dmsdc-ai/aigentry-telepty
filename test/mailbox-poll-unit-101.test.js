'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { authorizeMailboxRequest, parseMailboxLease, mailboxLeaseAlive, renewMailboxLease } = require('../src/mailbox/poll-session');
const { runMailboxCommand } = require('../src/cli/mailbox');

test('#101 lease bounds are strict and expiry is measured, not a sticky connected flag', () => {
  assert.equal(parseMailboxLease().seconds, 300);
  assert.equal(parseMailboxLease(3600).seconds, 3600);
  for (const value of [0, 3601, Infinity, NaN, '5', null, {}, []]) assert.ok(parseMailboxLease(value).error);
  const session = { type: 'mailbox', leaseExpiresAt: 2000 };
  assert.equal(mailboxLeaseAlive(session, 1999), true);
  assert.equal(mailboxLeaseAlive(session, 2000), false);
  assert.equal(mailboxLeaseAlive({ ...session, leaseExpiresAt: Infinity }, 0), false);
});

test('#101 renewal restores metadata on failed commit and reports uncertain durability without rolling it back', () => {
  const original = { id: 'poll', type: 'mailbox', leaseExpiresAt: 1000, lastActivityAt: 'old',
    lastConnectedAt: 'old', lastDisconnectedAt: 'old' };
  const session = { ...original };
  assert.equal(renewMailboxLease(session, 20, () => ({ ok: false, committed: false }), 1000).code, 'SESSION_STORE_WRITE_FAILED');
  assert.deepEqual(session, original);
  assert.equal(renewMailboxLease(session, 20, () => ({ ok: false, committed: true }), 1000).success, false);
  assert.equal(session.leaseExpiresAt, 21000);
  assert.equal(renewMailboxLease(session, 20, () => ({ ok: true, committed: true }), 2000).success, true);
  assert.equal(session.leaseExpiresAt, 22000);
});

test('#101 authorization uses exact canonical id, epoch and generation; aliases and encoded path tricks are denied', () => {
  const credentials = createCredentialStore();
  const issued = credentials.issue('poll-1');
  const session = { type: 'mailbox', sessionEpoch: issued.epoch, credentialGeneration: issued.generation };
  const sessions = { 'poll-1': session };
  const request = (path, method = 'GET') => ({ path, method, headers: { 'x-telepty-session-token': issued.bearer } });
  assert.equal(authorizeMailboxRequest(request('/api/sessions/poll-1/mailbox'), sessions, credentials), true);
  for (const path of ['/api/sessions/poll/mailbox', '/api/sessions/poll-2/mailbox', '/api/sessions/poll-1/mailbox/dead-letter',
    '/api/sessions/poll-1%2Fmailbox/ack', '/api/sessions/%/mailbox', '/api/sessions/poll-1/state']) {
    assert.equal(authorizeMailboxRequest(request(path), sessions, credentials), false, path);
  }
  session.sessionEpoch = 'replaced';
  assert.equal(authorizeMailboxRequest(request('/api/sessions/poll-1/mailbox'), sessions, credentials), false);
});

test('#101 CLI session-bearer path never resolves shared credentials or prints them', async () => {
  const output = [];
  let wire;
  await runMailboxCommand(['poll', '--json'], { daemonUrl: 'http://127.0.0.1:1234', sessionToken: 'private-session-token',
    fetchWithAuth() { throw new Error('must not read shared token'); },
    fetch: async (url, options) => { wire = { url, options }; return { ok: true, json: async () => ({ pending: [] }) }; },
    log: value => output.push(value), error() { throw new Error('unexpected error'); }, fail() { throw new Error('unexpected failure'); } });
  assert.equal(wire.options.headers['x-telepty-session-token'], 'private-session-token');
  assert.equal(wire.options.headers['x-telepty-token'], undefined);
  assert.equal(output.join('').includes('private-session-token'), false);
});

test('#101 failed initial mailbox persistence returns no bearer and revokes the uncommitted credential', () => {
  const credentials = createCredentialStore(); const sessions = {}; let handler; let minted;
  const { registerSessionRegisterRoute } = require('../src/routes/session-records');
  registerSessionRegisterRoute({ post: (_path, fn) => { handler = fn; } }, {
    context: { sessions, sessionCredentials: credentials,
      issueSessionCredential: sid => { minted = credentials.issue(sid); return { ...minted, nonce: 'private' }; },
      revokeSessionCredential: sid => credentials.revoke(sid),
      persistSessions: () => ({ ok: false, committed: false }) },
    sessionStateManager: { register() { throw new Error('must not publish uncommitted session'); } }, busClients: new Set() });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
  handler({ body: { session_id: 'poll', delivery_type: 'mailbox' }, headers: {} }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.session_token, undefined);
  assert.equal(sessions.poll, undefined);
  assert.equal(credentials.verify(minted.bearer), null);
});
