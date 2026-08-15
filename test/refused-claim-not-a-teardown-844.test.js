'use strict';

// #844 BLOCKER — a REFUSED owner claim still authorised tearing down the healthy incumbent.
//
// This is the invariant #835 exists to establish — *a refusal must never authorise a destructive
// remediation* — violated by the code path that produces the refusal.
//
// ── The sequence, which is routine in this ecosystem (dup-id / respawn race) ─────────────
//   bridge A: `telepty allow --id X bash`  → first registration, so #815 mints the session
//             credential, A's `?owner=1` claim is accepted, A owns a live PTY.
//   bridge B: `telepty allow --id X bash`  → RE-registration of an id the daemon already holds,
//             so #815 deliberately returns NO credential material to anyone. B's `?owner=1`
//             handshake therefore carries no bearer and is REFUSED with close 4003
//             (src/transport/websocket.js).
//   cli.js:   the 4003 branch called `closeAllowSession()`, whose teardown half issues
//             `DELETE /api/sessions/X`. That DELETE carries `owner_token` only when this bridge
//             HAS one — and B's whole problem is that it does not. So the URL went out bare, the
//             daemon's #536 owner-token guard had nothing to compare, and the session was
//             destroyed. A then got close 1000 'Session destroyed' and exited too.
//
// The bridge that was told "you are not the owner of this session" proceeded to destroy that
// session. It also purged the bridge mailbox for an id it does not own, discarding deliveries
// queued for the incumbent.
//
// The fix: a refused claim exits WITHOUT the destructive half. B still exits 1 and still says why
// — it just no longer acts on an authority the daemon explicitly denied it.
//
// Everything below runs against an isolated daemon (PORT=0, mkdtemp HOME). Nothing touches the
// production daemon or any real session.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const pty = require('node-pty');

const { startTestDaemon, createSessionId, stripAnsi, waitFor, delay } = require('../test-support/daemon-harness');

const projectRoot = path.resolve(__dirname, '..');

let harness;

before(async () => { harness = await startTestDaemon(); });
after(async () => { if (harness) await harness.stop(); });

function spawnBridge(sessionId) {
  const env = {
    ...process.env,
    HOME: harness.homeDir,
    USERPROFILE: harness.homeDir,
    TELEPTY_HOST: harness.host,
    TELEPTY_PORT: String(harness.port),
    NO_UPDATE_NOTIFIER: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
  };
  // The second bridge must reach its handshake with NO bearer — that is the whole scenario. An
  // ambient one inherited from the shell running the suite would silently make it the owner.
  delete env.TELEPTY_SESSION_TOKEN;
  delete env.TELEPTY_SESSION_ID;

  const proc = pty.spawn(process.execPath, ['cli.js', 'allow', '--id', sessionId, 'bash'], {
    cwd: projectRoot,
    cols: 100,
    rows: 30,
    name: process.platform === 'win32' ? 'xterm' : 'xterm-256color',
    env
  });
  const output = { text: '', exit: null };
  proc.onData((d) => { output.text += d; });
  proc.onExit(({ exitCode }) => { output.exit = exitCode; });
  return { proc, output };
}

async function listSessions() {
  const res = await harness.request('/api/sessions');
  return Array.isArray(res.body) ? res.body : [];
}

test('a bridge whose owner claim is REFUSED does not destroy the session it was refused', async (t) => {
  const sessionId = createSessionId('incumbent-844');

  // ── incumbent: first registration, so it holds the #815 credential and owns the PTY ──
  const a = spawnBridge(sessionId);
  t.after(() => { try { a.proc.kill(); } catch { /* already gone */ } });

  await waitFor(async () => {
    const sessions = await listSessions();
    return sessions.some((s) => s.id === sessionId && s.healthStatus === 'CONNECTED');
  }, { timeoutMs: 15000, description: 'incumbent bridge owner connected' });

  // ── challenger: a re-registration, so #815 hands it no credential and the claim is refused ──
  const b = spawnBridge(sessionId);
  t.after(() => { try { b.proc.kill(); } catch { /* already gone */ } });

  await waitFor(async () => b.output.exit !== null,
    { timeoutMs: 15000, description: 'refused bridge exits instead of reconnecting' });

  // The refusal happened, and it is the one we mean — otherwise the rest of this test proves
  // nothing about 4003 in particular.
  assert.match(stripAnsi(b.output.text), /Owner claim refused/,
    `the challenger must be refused with 4003; got:\n${stripAnsi(b.output.text).slice(-1200)}`);
  assert.equal(b.output.exit, 1, 'a refused claim is a failure for the bridge that made it');

  // The teardown DELETE, if it went out, is fire-and-forget — give it room to land so this
  // cannot pass by racing ahead of the very thing it is checking for.
  await delay(1500);

  // ── the property ──
  const sessions = await listSessions();
  const survivor = sessions.find((s) => s.id === sessionId);
  assert.ok(survivor,
    'the REFUSED bridge destroyed the session it was refused ownership of — a refusal must never '
    + 'authorise a destructive remediation (#835)');
  assert.equal(survivor.healthStatus, 'CONNECTED',
    'the healthy incumbent must still own its socket after another bridge was refused');
  assert.equal(a.output.exit, null,
    'the incumbent bridge exited — it was torn down by a bridge the daemon had just refused');
});

test('the incumbent still accepts an inject after the refused claim — it was never disturbed', async (t) => {
  // Survival in the session list is necessary but not sufficient: the point of not tearing the
  // session down is that it keeps WORKING. This also covers the mailbox purge, which
  // `closeAllowSession` performs on the bridge target and which the refused bridge has no
  // business running against an id it does not own.
  const sessionId = createSessionId('still-serving-844');

  const a = spawnBridge(sessionId);
  t.after(() => { try { a.proc.kill(); } catch { /* already gone */ } });
  await waitFor(async () => {
    const sessions = await listSessions();
    return sessions.some((s) => s.id === sessionId && s.healthStatus === 'CONNECTED');
  }, { timeoutMs: 15000, description: 'incumbent bridge owner connected' });

  const b = spawnBridge(sessionId);
  t.after(() => { try { b.proc.kill(); } catch { /* already gone */ } });
  await waitFor(async () => b.output.exit !== null,
    { timeoutMs: 15000, description: 'refused bridge exits' });
  await delay(1500);

  const MARK = `still-serving-${sessionId}`;
  const injected = await harness.request(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, {
    method: 'POST',
    body: { prompt: `echo ${MARK}` }
  });
  assert.equal(injected.status, 200,
    `the incumbent must still accept injects; got ${injected.status} ${JSON.stringify(injected.body)}`);

  await waitFor(async () => stripAnsi(a.output.text).includes(MARK),
    { timeoutMs: 10000, description: 'incumbent PTY received the inject' });
});
