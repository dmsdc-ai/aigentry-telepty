'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerSessionRegisterRoute } = require('../src/routes/session-records');
const { createCredentialStore } = require('../src/session-store/session-credentials');

// Call the real route and credential verifier with in-memory records only.
// Numeric PIDs are inert fixture metadata: no daemon, kill or process probe is used.
function fixture({ legacy = false } = {}) {
  const sessionCredentials = createCredentialStore();
  const issued = legacy ? null : sessionCredentials.issue('incumbent');
  const sessions = { incumbent: { id: 'incumbent', type: 'wrapped', command: 'bash',
    cwd: 'original', backend: 'pty', ownerPid: 111, ptyPid: 222 } };
  let handler;
  registerSessionRegisterRoute({ post: (_path, route) => { handler = route; } }, {
    context: { sessions, sessionCredentials, issueSessionCredential: () => { throw Error('must not mint'); },
      persistSessions: () => { throw Error('existing route should not persist here'); } },
    sessionStateManager: { register: () => {} }, busClients: new Set()
  });
  return {
    record: sessions.incumbent, issued, sessionCredentials,
    register(token, metadata = {}) {
      const response = { statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
      handler({ body: { session_id: 'incumbent', ...metadata },
        headers: token ? { 'x-telepty-session-token': token } : {} }, response);
      return response;
    }
  };
}

for (const credential of ['absent', 'wrong', 'revoked']) {
  test(`#130: ${credential} credential cannot overwrite incumbent process PIDs`, () => {
    const f = fixture();
    let token;
    if (credential === 'wrong') token = 'not-the-owner';
    if (credential === 'revoked') {
      token = f.issued.bearer;
      f.sessionCredentials.revoke('incumbent');
      f.sessionCredentials.issue('incumbent');
    }
    const response = f.register(token, { owner_pid: 333, pty_pid: 444 });
    assert.equal(response.statusCode, 200, 'metadata registration stays idempotent');
    assert.equal(response.body.session_token, undefined);
    assert.equal(f.record.ownerPid, 111);
    assert.equal(f.record.ptyPid, 222);
  });
}

test('#130: credentialed owner may refresh process PIDs on reconnect', () => {
  const f = fixture();
  f.register(f.issued.bearer, { owner_pid: 333, pty_pid: 444 });
  assert.equal(f.record.ownerPid, 333);
  assert.equal(f.record.ptyPid, 444);
});

test('#130: credentialless legacy records retain their registration compatibility', () => {
  const f = fixture({ legacy: true });
  f.register(undefined, { owner_pid: 333, pty_pid: 444 });
  assert.equal(f.record.ownerPid, 333);
  assert.equal(f.record.ptyPid, 444);
});
