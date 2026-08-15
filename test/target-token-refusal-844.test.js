'use strict';

// #844 F1 — `resolveTargetToken` sent THIS machine's daemon master token to arbitrary addresses.
//
// Found by the architect who designed the #820 change, reviewing their own work. The resolution
// order was `TELEPTY_AUTH_TOKEN` → the address's `peers.json` entry → `return getAuthToken()`, and
// that last step is unconditional: any command aimed at an address with no stored credential put
// the local daemon's master token on the wire, in cleartext, to whoever answered.
//
// It was worthless in 0.7.1 because the target trusted every caller anyway and never read the
// credential. **This release is what makes it matter.** Post-#820 that token is the whole boundary
// on the sending machine — "whoever can read ~/.telepty/config.json can drive the daemon" — and on
// a tailnet #672's auto-populated allowlist means the recipient can point it straight back at the
// daemon that sent it. Silent, and one typo wide: `telepty inject sess@10.0.0.5` to a mistyped host
// hands over the key with no output at all.
//
// The fix uses a predicate that already existed and was spent only on error WORDING:
// `isLocalHostname()`. It now decides RESOLUTION. A non-local address with no stored credential is
// REFUSED before the socket opens, carrying `credentialRefusalHint()` — the same one-refusal-message
// helper every other surface uses, which names `connect-http --token` and `TELEPTY_AUTH_TOKEN`.
// A loud refusal that says how to fix it, never a silent send.
//
// Nothing here dials anything. The wire assertion is made against a stubbed `fetch`, so no token —
// real or fake — leaves this process.
//
// Cases 1-3 are the refusal: RED against the base commit (they observe the local master token
// being handed to a non-local address). Cases 4-8 are the anti-regression half: GREEN before and
// after, so an over-tightening that breaks loopback or the stored-peer path fails here.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getConfig } = require('../auth');
const { resolveTargetToken, fetchWithAuth } = require('../cli');

// A tailnet-shaped address, in the CIDR #672 auto-trusts. Never dialled — see the fetch stub.
const REMOTE = '100.72.155.21';
const REMOTE_URL = `http://${REMOTE}:3848`;
// A second non-local address, this one WITH a stored credential (case 5).
const STORED_PEER = '198.51.100.7';
const STORED_PEER_TOKEN = 'the-peers-own-token-not-ours';

let LOCAL_MASTER_TOKEN;

before(() => {
  // test-support/setup-env.js (#829) gives every test process its own mkdtemp HOME before any
  // product module is required, so this mints a throwaway token in a temp dir. The real
  // ~/.telepty is never read and never written.
  const home = os.homedir();
  assert.ok(home.includes('telepty-test-home-'),
    `refusing to run against a real HOME (${home}) — this test writes peers.json`);

  fs.mkdirSync(path.join(home, '.telepty'), { recursive: true, mode: 0o700 });
  // Written before the first resolveTargetToken() call: cli.js caches the peer map on first use.
  fs.writeFileSync(path.join(home, '.telepty', 'peers.json'), JSON.stringify({
    peers: {
      stored: { host: STORED_PEER, port: 3848, token: STORED_PEER_TOKEN, transport: 'http' }
    }
  }, null, 2));

  LOCAL_MASTER_TOKEN = getConfig().authToken;
  assert.equal(typeof LOCAL_MASTER_TOKEN, 'string');
  assert.ok(LOCAL_MASTER_TOKEN.length > 0, 'the local daemon token is what must not leak');
});

after(() => { delete process.env.TELEPTY_AUTH_TOKEN; });

// ── 1-3: the refusal. RED on the base commit. ───────────────────────────────────────────

test('1) a non-local address with no stored credential is REFUSED, not handed the local token', () => {
  let leaked = null;
  try {
    leaked = resolveTargetToken(REMOTE_URL);
  } catch (error) {
    assert.equal(error.name, 'CredentialRefusalError');
    assert.equal(error.code, 'NO_TARGET_CREDENTIAL');
    return;
  }
  assert.fail(
    `resolveTargetToken('${REMOTE_URL}') returned a token instead of refusing`
    + (leaked === LOCAL_MASTER_TOKEN
      ? ' — and it is THIS MACHINE\'S DAEMON MASTER TOKEN, byte-identical to '
        + '~/.telepty/config.json authToken. That is the leak.'
      : ` — ${JSON.stringify(leaked)}`)
  );
});

test('2) the refusal names the fix — it is a hint, not a wall', () => {
  // A refusal an operator cannot act on just moves the failure. This is the SAME wording every
  // other refusal surface prints (`credentialRefusalHint`), so there is one thing to learn.
  let error = null;
  try { resolveTargetToken(REMOTE_URL); } catch (e) { error = e; }
  assert.ok(error && error.name === 'CredentialRefusalError', 'expected a refusal');
  assert.match(error.message, new RegExp(`\\b${REMOTE.replace(/\./g, '\\.')}\\b`), 'name the address');
  assert.match(error.message, /telepty connect-http/, 'name the command that stores the target credential');
  assert.match(error.message, /TELEPTY_AUTH_TOKEN/, 'name the fleet-wide alternative');
  assert.ok(!error.message.includes(LOCAL_MASTER_TOKEN), 'a refusal must not print the secret it refused to send');
});

test('3) nothing reaches the wire — the local token appears in no request, because none is made', async () => {
  // The property, stated where it matters: not "the header is absent" but "there is no request".
  // The refusal is raised while building the headers, before fetch is ever reached.
  const originalFetch = global.fetch;
  const attempts = [];
  global.fetch = async (url, options) => {
    attempts.push({ url: String(url), headers: { ...(options && options.headers) } });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await assert.rejects(
      (async () => fetchWithAuth(`${REMOTE_URL}/api/sessions`))(),
      { name: 'CredentialRefusalError' }
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(attempts, [], `a refused target must produce no request at all, got ${JSON.stringify(attempts)}`);
  const onTheWire = JSON.stringify(attempts);
  assert.ok(!onTheWire.includes(LOCAL_MASTER_TOKEN), 'the local master token reached a non-local address');
});

// ── 4-8: the anti-regression half. GREEN before AND after. ──────────────────────────────

test('4) loopback still gets the local token — every local command depends on it', () => {
  for (const url of ['http://127.0.0.1:3848', 'http://localhost:3848', 'http://[::1]:3848']) {
    assert.equal(resolveTargetToken(url), LOCAL_MASTER_TOKEN, `${url} is this machine`);
  }
});

test('5) a non-local address WITH a peers.json entry resolves to THAT peer\'s token', () => {
  // The #823 path this must not break: `connect-http <host> --token` stores the credential, and
  // address-keyed lookup is what finally made it reachable.
  const token = resolveTargetToken(`http://${STORED_PEER}:3848`);
  assert.equal(token, STORED_PEER_TOKEN);
  assert.notEqual(token, LOCAL_MASTER_TOKEN);
});

test('6) an address:port with no entry is still refused even when the HOST has one', () => {
  // Keyed on host AND port (#823): two daemons on one host are two targets with two secrets.
  assert.throws(() => resolveTargetToken(`http://${STORED_PEER}:9999`), { name: 'CredentialRefusalError' });
});

test('7) TELEPTY_AUTH_TOKEN still wins for a non-local address — the fleet-wide escape hatch', () => {
  // This is the documented way out of the refusal, so it has to work; a caller that sets it has
  // stated deliberately that both ends share a token.
  process.env.TELEPTY_AUTH_TOKEN = 'fleet-wide-token';
  try {
    assert.equal(resolveTargetToken(REMOTE_URL), 'fleet-wide-token');
  } finally {
    delete process.env.TELEPTY_AUTH_TOKEN;
  }
});

test('8) a local request still carries the token on the wire', () => {
  // The mirror of case 3: the refusal must not have turned into "send nothing", which is the
  // ambiguity #835 exists to delete.
  const originalFetch = global.fetch;
  const attempts = [];
  global.fetch = async (url, options) => {
    attempts.push({ url: String(url), headers: { ...(options && options.headers) } });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    fetchWithAuth('http://127.0.0.1:3848/api/sessions');
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].headers['x-telepty-token'], LOCAL_MASTER_TOKEN);
});
