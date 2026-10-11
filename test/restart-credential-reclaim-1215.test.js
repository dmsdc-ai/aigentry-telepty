'use strict';

// task 1215 (S1 §1b) — restart credential continuity against the REAL daemon.
//
// #815 says a wrapped child's spawn-time bearer stays verifiable across a daemon restart with no
// reissuance: the daemon persists only sha256(bearer) in sessions.json and `adopt`s it at boot
// (src/session-store/session-credentials.js `adopt`, daemon.js session restore). Until now that
// was asserted only by a fake (telesession helpers/fake-telepty.js "wrapped targets keep id +
// epoch") and by wrapper-reregister-82, which checks `active_clients` and liveness but never WHO a
// post-restart inject is attributed to. These rows measure attribution end to end:
//
//   real daemon.js ── real `telepty allow` bridge ── PTY ── test-support/restart-credential-child-1215.js
//
// The child (the sender) holds the bearer exactly as a wrapped CLI does — read once from its
// spawn-time env — and POSTs one inject per command to an aterm sink. The daemon's own audit log
// (GET /api/injects) is the only evidence read: `verified_sender_sid/_epoch/_generation` and
// `spoof_suspected` per row. Epoch/generation equality is always relative to row #1 of the SAME
// run; no historical value is hard-coded. The bearer never reaches this process, and diagnostics
// carry booleans/equality results only.
//
// The sink is named `orchestrator`, which keeps every W → sink inject on the orchestrator lane of
// the #533 peer guard under the daemon's DEFAULT policy (AIGENTRY_ORCHESTRATOR_SIDS unset) — the
// same D → orchestrator route the real deployment uses (RC6 pins that policy explicitly).
//
//   RC1  SIGTERM, `node daemon.js`                         → same principal after restart
//   RC1b SIGTERM, production boot (env flag + require)     → exit 0, same principal after restart
//   RC2  SIGKILL (supervisor kill)                         → same principal after restart
//   RC3  verifier fields dropped from sessions.json        → reclaim accepted, inject #2 unverified
//   RC4  restored record GC'd before the bridge reclaims   → fresh instance, inject #2 unverified
//   RC6  AIGENTRY_ORCHESTRATOR_SIDS unset / "" / "   " / explicit list without the target
//
// RC3 and RC4 CHARACTERIZE a verified negative outcome (credential lost → attribution lost); they
// assert that it is reported as unverified rather than concealed. They are not product fixes.
//
// Isolation (§1c): every daemon is this test's own child on an ephemeral loopback port under its
// own temp HOME, restarted on that same HOME and port. Only this test's own children are signalled
// (daemon, bridge). Port 3848 and any host daemon are never contacted; `TELEPTY_PORT` is stripped
// from the daemon env because it would win over `PORT=0` (src/bind-port.js).
//
// Run (cwd = telepty tree):
//   node --require ./test-support/setup-env.js --test test/restart-credential-reclaim-1215.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const H = require('../test-support/bridge-pipe-harness');

const projectRoot = path.resolve(__dirname, '..');
const DAEMON_JS = path.join(projectRoot, 'daemon.js');
const CHILD = path.join(projectRoot, 'test-support', 'restart-credential-child-1215.js');
const REQUIRED_CAPS = ['inject-exact-target', 'register-create-only', 'delete-owned-session'];
const SINK = 'orchestrator';
const CASE_TIMEOUT_MS = 180000;
const RECONNECT_TIMEOUT_MS = 45000;

// The daemon inherits this process's env (the harness spreads process.env). Anything that would
// decide the handshake, the bind, the policy or the GC under test is removed — `undefined` in a
// spawn env drops the key. Each case then sets exactly what it measures.
const DAEMON_CLEAN = {
  TELEPTY_SESSION_TOKEN: undefined,
  TELEPTY_SESSION_ID: undefined,
  TELEPTY_SESSION_NONCE: undefined,
  TELEPTY_AUTH_TOKEN: undefined,
  TELEPTY_PORT: undefined,
  TELEPTY_BIND: undefined,
  AIGENTRY_TELEPTY_DAEMON_MAIN: undefined,
  AIGENTRY_ORCHESTRATOR_SIDS: undefined,
  TELEPTY_SESSION_STALE_SECONDS: undefined,
  TELEPTY_SESSION_CLEANUP_SECONDS: undefined,
  TELEPTY_HEALTH_POLL_MS: undefined,
  TELEPTY_NO_TAILNET_AUTO: '1'
};
// The bridge keeps the harness's TELEPTY_HOST/TELEPTY_PORT; only inherited credentials go.
const BRIDGE_CLEAN = {
  TELEPTY_SESSION_TOKEN: undefined,
  TELEPTY_SESSION_ID: undefined,
  TELEPTY_SESSION_NONCE: undefined,
  TELEPTY_AUTH_TOKEN: undefined
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const tagFor = (label) => `${label}-${crypto.randomBytes(4).toString('hex')}`;

// Diagnostics never carry credential material: the daemon token, anything bearer-shaped
// (`<epoch>.<secret>`) and 64-hex strings (verifier-shaped) are masked before printing.
function redact(text, home) {
  let s = String(text == null ? '' : text);
  const token = home ? H.daemonToken(home) : null;
  if (token) s = s.split(token).join('[daemon-token]');
  return s
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}/g, '[bearer-shaped]')
    .replace(/\b[0-9a-f]{64}\b/g, '[hex64]');
}

// Boot daemon.js. `productionPath` boots it the way cli.js does (`telepty daemon`): set
// AIGENTRY_TELEPTY_DAEMON_MAIN, then require — so require.main is NOT daemon.js (same idiom as
// daemon-shutdown-handlers-916.test.js). Returns the harness daemon shape either way.
function bootDaemon({ home, port = 0, env = {}, productionPath = false }) {
  const daemonEnv = { ...DAEMON_CLEAN, ...env };
  if (!productionPath) return H.startDaemon({ home, port, env: daemonEnv });
  const d = { stdout: '', stderr: '', port, child: null, log: () => d.stdout + d.stderr };
  d.child = spawn(process.execPath, ['-e', `process.env.AIGENTRY_TELEPTY_DAEMON_MAIN='1'; require(${JSON.stringify(DAEMON_JS)});`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      HOST: '127.0.0.1',
      NO_UPDATE_NOTIFIER: '1',
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
      ...daemonEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  d.child.stdout.on('data', (c) => { d.stdout += c.toString(); });
  d.child.stderr.on('data', (c) => { d.stderr += c.toString(); });
  return d;
}

async function call(port, home, method, route, body) {
  const token = H.daemonToken(home);
  const headers = token ? { 'x-telepty-token': token } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, body: json };
}

// §1f gate, run against EVERY daemon a case boots and before anything else touches it: the
// candidate's three capabilities, and proof that the answering process is this case's own child.
async function assertCandidateDaemon(d, port, home, label) {
  const meta = await call(port, home, 'GET', '/api/meta');
  assert.equal(meta.status, 200, `${label}: /api/meta must answer before any RC step`);
  const caps = meta.body && Array.isArray(meta.body.capabilities) ? meta.body.capabilities : [];
  assert.deepEqual(REQUIRED_CAPS.filter((c) => !caps.includes(c)), [],
    `${label}: STOP — the daemon lacks the candidate capabilities (baseline daemon.js?)`);
  assert.equal(meta.body.pid, d.child.pid, `${label}: the daemon answering is not this case's own child`);
  assert.equal(Number(meta.body.port), port, `${label}: the daemon is not bound to this case's port`);
}

// aterm delivery endpoint: records every {text, session_id} the daemon delivers for `sid`.
async function startAtermRecorder(sid) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { received.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { received.push(null); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/rc1215-sink`,
    got: (text) => received.some((b) => b && b.session_id === sid && b.text === text),
    count: () => received.length,
    close: () => new Promise((resolve) => {
      try { server.closeAllConnections(); } catch { /* none */ }
      server.close(() => resolve());
    })
  };
}

// The sink is an aterm session; aterm records are not restored across a restart
// (persistence.js buildRestoredWrappedSession), so it is registered on every boot. Its one-time
// bearer is dropped unread — nothing here sends as the sink.
async function registerSink(port, home, endpoint) {
  const r = await call(port, home, 'POST', '/api/sessions/register', {
    session_id: SINK, delivery_type: 'aterm', delivery_endpoint: endpoint, command: 'rc1215-sink'
  });
  return r.status;
}

function sessionsJsonPath(home) {
  return path.join(home, '.config', 'aigentry-telepty', 'sessions.json');
}

function readPersisted(home) {
  return JSON.parse(fs.readFileSync(sessionsJsonPath(home), 'utf8'));
}

// Booleans only — the verifier itself is never returned.
function persistedFacts(home, sid) {
  let rec = null;
  try { rec = readPersisted(home)[sid] || null; } catch { rec = null; }
  return {
    present: !!rec,
    hasEpoch: !!(rec && typeof rec.sessionEpoch === 'string' && rec.sessionEpoch),
    hasVerifier: !!(rec && typeof rec.credentialVerifier === 'string' && rec.credentialVerifier),
    hasLastDisconnectedAt: !!(rec && rec.lastDisconnectedAt)
  };
}

function persistedEpochEquals(home, sid, epoch) {
  const rec = readPersisted(home)[sid];
  return !!(rec && rec.sessionEpoch === epoch);
}

// Fixture surgery on the stopped daemon's sessions.json (RC3/RC4) — only ever after the daemon that
// wrote it has exited, so nothing can rewrite it underneath us.
function editPersisted(home, sid, mutate) {
  const all = readPersisted(home);
  assert.ok(all[sid], `fixture edit: ${sid} is not in sessions.json`);
  mutate(all[sid]);
  fs.writeFileSync(sessionsJsonPath(home), JSON.stringify(all, null, 2), { mode: 0o600 });
}

async function activeClients(port, home, sid) {
  const body = await H.api(port, home).session(sid);
  return body && typeof body.active_clients === 'number' ? body.active_clients : null;
}

async function auditRowsFor(port, home, payload) {
  const r = await call(port, home, 'GET', `/api/injects?to=${encodeURIComponent(SINK)}&limit=1000`);
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.injects)) return null;
  const sha = sha256(payload);
  const rows = r.body.injects.filter((x) => x && x.payload_sha256 === sha);
  return rows.length ? rows : null;
}

// One sender inject W → sink, triggered by an operator inject of an `RCSEND` line into W's PTY.
// Waits for the AUDIT row (the writer flushes on a timer, so a row is only durable once it shows
// up here — which is also why no daemon is stopped before its row #1 is readable).
async function sendThroughChild(fx, d, label) {
  const tag = tagFor(label);
  const payload = `rc1215-payload ${tag}`;
  const op = await H.api(fx.port, fx.home).inject(fx.sid, `RCSEND ${SINK} ${tag}`);
  assert.equal(op.status, 200, `${label}: operator inject into ${fx.sid} → ${op.status} ${redact(JSON.stringify(op.body), fx.home)}`);
  const rows = await H.waitFor(() => auditRowsFor(fx.port, fx.home, payload), {
    timeoutMs: 30000,
    description: `${label}: audit row for the child's inject`,
    context: async () => fx.context(d)
  });
  assert.equal(rows.length, 1, `${label}: exactly one audit row for one inject`);
  const row = rows[0];
  if (row.delivery_result === 'success') {
    await H.waitFor(() => fx.sink.got(payload), { timeoutMs: 10000, description: `${label}: sink delivery` });
  }
  return row;
}

// The shared body of RC1/RC1b/RC2/RC3/RC4: boot → bridge W (credentialed at register) → inject #1
// → stop daemon → optional fixture edit → restart on the SAME HOME and port → W reclaims → inject #2.
async function runRestartCase(t, {
  caseId, signal, productionPath = false, editBeforeRestart = null, restartEnv = {}, holdBridgeUntilGc = false
}) {
  assert.notEqual(process.platform, 'win32', `${caseId}: POSIX-only (node-pty bridge, POSIX signals)`);
  assert.ok(fs.existsSync(CHILD), `${caseId}: fixture child missing at ${CHILD}`);

  const home = H.makeHome();
  const sid = `rc1215-${caseId.toLowerCase()}-w`;
  const started = [];
  const fx = { home, sid, port: 0, sink: null, bridge: null };
  fx.context = async (d) => redact([
    `bridge alive=${fx.bridge ? fx.bridge.alive() : 'n/a'}`,
    `bridge out (tail):\n${fx.bridge ? fx.bridge.out.slice(-2000) : ''}`,
    `bridge err (tail):\n${fx.bridge ? fx.bridge.err.slice(-1500) : ''}`,
    `daemon log (tail):\n${d ? d.log().slice(-2500) : ''}`
  ].join('\n'), home);

  t.after(async () => {
    if (fx.bridge) H.killBridge(fx.bridge);   // SIGKILL also ends a SIGSTOPped bridge
    for (const d of started) { try { d.child.kill('SIGKILL'); } catch { /* already gone */ } }
    if (fx.sink) await fx.sink.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  t.diagnostic(`daemon.js sha256=${sha256(fs.readFileSync(DAEMON_JS))}`);
  fx.sink = await startAtermRecorder(SINK);

  const d1 = bootDaemon({ home, productionPath });
  started.push(d1);
  fx.port = await H.daemonReady(d1);
  await assertCandidateDaemon(d1, fx.port, home, `${caseId} boot 1`);
  assert.equal(await registerSink(fx.port, home, fx.sink.endpoint), 201, `${caseId}: sink registration`);

  fx.bridge = H.startBridge({ home, port: fx.port, sid, cmd: [process.execPath, CHILD], env: BRIDGE_CLEAN });
  await H.waitFor(async () => (await activeClients(fx.port, home, sid)) >= 1
    && /RC-CHILD-READY has_sid=true has_bearer=true bearer_shape=true/.test(fx.bridge.out), {
    timeoutMs: 30000,
    description: `${caseId}: W owns its session and the child holds a spawn-time bearer`,
    context: async () => fx.context(d1)
  });

  const factsAtRegister = persistedFacts(home, sid);
  const row1 = await sendThroughChild(fx, d1, `${caseId}-1`);

  if (holdBridgeUntilGc) fx.bridge.child.kill('SIGSTOP');   // RC4: W cannot reclaim until released
  await H.stopDaemon(d1, signal);
  const d1Exit = { code: d1.child.exitCode, signal: d1.child.signalCode };
  assert.ok(d1Exit.code !== null || d1Exit.signal !== null, `${caseId}: daemon 1 did not exit within the bound after ${signal}`);

  if (editBeforeRestart) editPersisted(home, sid, editBeforeRestart);

  const d2 = bootDaemon({ home, port: fx.port, env: restartEnv, productionPath });
  started.push(d2);
  await H.daemonReady(d2);
  await assertCandidateDaemon(d2, fx.port, home, `${caseId} boot 2`);
  const restored = d2.log().includes(`[PERSIST] Restored session ${sid} (awaiting reconnect)`);
  assert.equal(await registerSink(fx.port, home, fx.sink.endpoint), 201, `${caseId}: sink re-registration`);

  let gcRevoked = null;
  if (holdBridgeUntilGc) {
    await H.waitFor(async () => (await H.api(fx.port, home).session(sid)).status === 404
      && d2.log().includes(`[CLEANUP] Removed stale session ${sid}`), {
      timeoutMs: 20000,
      description: `${caseId}: the restored record is GC'd while W is held`,
      context: async () => fx.context(d2)
    });
    gcRevoked = true;
    fx.bridge.child.kill('SIGCONT');
  }

  await H.waitFor(async () => (await activeClients(fx.port, home, sid)) >= 1, {
    timeoutMs: RECONNECT_TIMEOUT_MS,
    description: `${caseId}: W reconnects to the restarted daemon`,
    context: async () => fx.context(d2)
  });
  const row2 = await sendThroughChild(fx, d2, `${caseId}-2`);

  return { fx, d1, d2, d1Exit, row1, row2, factsAtRegister, restored, gcRevoked };
}

function ownerClaimRefused(bridge) {
  return /Owner claim refused/.test(bridge.out + bridge.err);
}

function summarize(t, caseId, r, extra = {}) {
  const summary = {
    case: caseId,
    verified_sid_match: r.row1.verified_sender_sid === r.fx.sid && r.row2.verified_sender_sid === r.fx.sid,
    epoch_equal: r.row1.verified_sender_epoch != null && r.row2.verified_sender_epoch === r.row1.verified_sender_epoch,
    generation_equal: r.row1.verified_sender_generation != null
      && r.row2.verified_sender_generation === r.row1.verified_sender_generation,
    spoof: r.row1.spoof_suspected || r.row2.spoof_suspected,
    gc_revoked: r.gcRevoked,
    wrapper_exit_code: r.fx.bridge.child.exitCode,
    sessions_json_has_epoch: r.factsAtRegister.hasEpoch,
    sessions_json_has_verifier: r.factsAtRegister.hasVerifier,
    daemon1_exit: r.d1Exit,
    restored_from_sessions_json: r.restored,
    ...extra
  };
  t.diagnostic(`RC-SUMMARY ${JSON.stringify(summary)}`);
  return summary;
}

// Same-principal continuity (RC1/RC1b/RC2): the post-restart inject is attributed to the SAME
// instance — sid, epoch and generation equal to row #1 — with nothing reissued.
function assertSamePrincipal(caseId, r) {
  const { fx, row1, row2 } = r;
  assert.equal(r.factsAtRegister.hasEpoch, true, `${caseId}: sessions.json carries W's epoch from register`);
  assert.equal(r.factsAtRegister.hasVerifier, true, `${caseId}: sessions.json carries W's verifier from register`);
  for (const [n, row] of [[1, row1], [2, row2]]) {
    assert.equal(row.delivery_result, 'success', `${caseId}: inject #${n} delivered`);
    assert.equal(row.claimed_from, fx.sid, `${caseId}: inject #${n} claims W`);
    assert.equal(row.verified_sender_sid, fx.sid, `${caseId}: inject #${n} verified as W`);
    assert.equal(row.spoof_suspected, false, `${caseId}: inject #${n} not spoof-suspected`);
  }
  assert.equal(typeof row1.verified_sender_epoch, 'string', `${caseId}: row #1 names an epoch`);
  assert.equal(row2.verified_sender_epoch, row1.verified_sender_epoch,
    `${caseId}: the restarted daemon verified the SAME epoch (no reissue)`);
  assert.equal(typeof row1.verified_sender_generation, 'number', `${caseId}: row #1 names a generation`);
  assert.equal(row2.verified_sender_generation, row1.verified_sender_generation, `${caseId}: same generation`);
  assert.equal(r.restored, true, `${caseId}: W was restored from sessions.json at boot 2`);
  assert.equal(r.fx.bridge.alive(), true, `${caseId}: W is still running`);
  assert.equal(ownerClaimRefused(r.fx.bridge), false, `${caseId}: W's owner reclaim was not refused (4003)`);
}

test('RC1 graceful: SIGTERM + restart on the same HOME/port — the child\'s spawn-time bearer still verifies as the same (sid, epoch, generation)', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const r = await runRestartCase(t, { caseId: 'RC1', signal: 'SIGTERM' });
  summarize(t, 'RC1', r);
  assert.deepEqual(r.d1Exit, { code: 0, signal: null }, 'RC1: SIGTERM reached the registered shutdown handler (exit 0)');
  assertSamePrincipal('RC1', r);
});

test('RC1b production boot path: daemon booted the cli.js way (env flag + require) — SIGTERM exits 0 and the principal survives', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const r = await runRestartCase(t, { caseId: 'RC1b', signal: 'SIGTERM', productionPath: true });
  summarize(t, 'RC1b', r);
  assert.match(r.d1.log(), /\[HEALTH\] session sweep armed/,
    'RC1b: the AIGENTRY_TELEPTY_DAEMON_MAIN-gated blocks ran (production path, not require.main)');
  assert.deepEqual(r.d1Exit, { code: 0, signal: null },
    'RC1b: SIGTERM → exit 0 — the shutdown handlers are registered on the production boot path');
  assertSamePrincipal('RC1b', r);
});

test('RC2 supervisor kill: SIGKILL + restart — the record restored from the sessions.json written at register keeps the principal', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const r = await runRestartCase(t, { caseId: 'RC2', signal: 'SIGKILL' });
  summarize(t, 'RC2', r);
  assert.equal(r.d1Exit.signal, 'SIGKILL', 'RC2: the first daemon died on SIGKILL (no shutdown path ran)');
  assertSamePrincipal('RC2', r);
});

test('RC3 verifier absent: W\'s verifier dropped from sessions.json — reclaim is accepted but inject #2 is UNVERIFIED (characterized, not fixed)', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const r = await runRestartCase(t, {
    caseId: 'RC3',
    signal: 'SIGTERM',
    editBeforeRestart: (rec) => {
      delete rec.sessionEpoch;
      delete rec.credentialVerifier;
      delete rec.credentialGeneration;
    }
  });
  const factsAfter = persistedFacts(r.fx.home, r.fx.sid);
  summarize(t, 'RC3', r, { sessions_json_after_restart_has_verifier: factsAfter.hasVerifier });
  const { fx, row1, row2 } = r;
  assert.equal(r.factsAtRegister.hasVerifier, true, 'RC3: the verifier existed before the fixture dropped it');
  assert.equal(row1.verified_sender_sid, fx.sid, 'RC3: inject #1 verified as W before the restart');
  assert.equal(r.restored, true, 'RC3: W was still restored (as an uncredentialed wrapped record)');
  // websocket.js owner gate: a session holding NO credential is claimed freely — no 4003.
  assert.equal(fx.bridge.alive(), true, 'RC3: W is still running');
  assert.equal(ownerClaimRefused(fx.bridge), false, 'RC3: W\'s owner reclaim was accepted');
  assert.equal(row2.delivery_result, 'success', 'RC3: inject #2 still delivered');
  assert.equal(row2.claimed_from, fx.sid, 'RC3: inject #2 still CLAIMS W');
  assert.equal(row2.verified_sender_sid, null, 'RC3: no verifier → the spawn-time bearer no longer verifies (claimed_only)');
  assert.equal(row2.verified_sender_epoch, null, 'RC3: no verified epoch');
  assert.equal(row2.spoof_suspected, false, 'RC3: unverified is not spoof (nothing verified to contradict the claim)');
  assert.equal(factsAfter.hasVerifier, false, 'RC3: nothing re-minted a verifier for the restored instance');
});

test('RC4 GC before reclaim (R3): restored W swept while its bridge is held — fresh instance, inject #2 with the old bearer is UNVERIFIED (characterized, not fixed)', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  // SESSION_CLEANUP_SECONDS is floored by SESSION_STALE_SECONDS (daemon.js:81-82), so both are set.
  // The restored record is aged one hour, far past 30 s, while a FRESH registration would need 30 s
  // without an owner — so only the restored record is swept, never W's re-registration.
  const restartEnv = {
    TELEPTY_SESSION_STALE_SECONDS: '5',
    TELEPTY_SESSION_CLEANUP_SECONDS: '30',
    TELEPTY_HEALTH_POLL_MS: '200'
  };
  let hadLastDisconnectedAt = null;
  const r = await runRestartCase(t, {
    caseId: 'RC4',
    signal: 'SIGTERM',
    restartEnv,
    holdBridgeUntilGc: true,
    editBeforeRestart: (rec) => {
      // persistence.js restores lastDisconnectedAt ← lastActivityAt when none was persisted.
      hadLastDisconnectedAt = !!rec.lastDisconnectedAt;
      rec.lastActivityAt = new Date(Date.now() - 3600 * 1000).toISOString();
      rec.lastDisconnectedAt = null;
    }
  });
  const factsAfter = persistedFacts(r.fx.home, r.fx.sid);
  const freshEpochDiffers = factsAfter.hasEpoch && !persistedEpochEquals(r.fx.home, r.fx.sid, r.row1.verified_sender_epoch);
  summarize(t, 'RC4', r, {
    persisted_last_disconnected_at_before_edit: hadLastDisconnectedAt,
    fresh_instance_epoch_differs: freshEpochDiffers
  });
  const { fx, row1, row2 } = r;
  assert.match(r.d2.log(), /\[HEALTH\] session sweep armed \(poll=200ms, stale-disconnect cleanup after 30s\)/,
    'RC4: the GC knobs are the ones in effect on the restarted daemon');
  assert.equal(r.restored, true, 'RC4: W was restored before it was swept');
  assert.equal(r.gcRevoked, true, 'RC4: the restored record was GC\'d (credential revoked) before W reclaimed');
  assert.equal(row1.verified_sender_sid, fx.sid, 'RC4: inject #1 verified as W before the restart');
  // cli.js re-register: the GC'd id is a FIRST registration again → new epoch + bearer, adopted by the
  // bridge; the child cannot receive it (its env is fixed at spawn).
  assert.equal(fx.bridge.alive(), true, 'RC4: W survived and re-registered');
  assert.equal(ownerClaimRefused(fx.bridge), false, 'RC4: the bridge claimed the fresh instance with the adopted bearer');
  assert.equal(freshEpochDiffers, true, 'RC4: W now persists a DIFFERENT (fresh) epoch');
  assert.equal(row2.delivery_result, 'success', 'RC4: inject #2 still delivered');
  assert.equal(row2.claimed_from, fx.sid, 'RC4: inject #2 still CLAIMS W');
  assert.equal(row2.verified_sender_sid, null, 'RC4: the child\'s revoked spawn-time bearer no longer verifies');
  assert.equal(row2.verified_sender_epoch, null, 'RC4: no verified epoch');
  assert.equal(row2.spoof_suspected, false, 'RC4: unverified is not spoof');
});

// ── RC6: the #533 peer-lane policy on the D → orchestrator → D route ──
// The verdict is keyed on the CLAIMED sender (daemon.js classifyPeerLaneInject), so these rows need
// no bearer at all: D, `orchestrator` and a third peer are aterm sinks, and every inject below is
// sent with `from` only.

async function runPolicyCase(t, caseId, orchestratorSids) {
  const home = H.makeHome();
  const sinks = [];
  let d = null;
  t.after(async () => {
    if (d) { try { d.child.kill('SIGKILL'); } catch { /* already gone */ } }
    for (const s of sinks) await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  d = bootDaemon({ home, env: { AIGENTRY_ORCHESTRATOR_SIDS: orchestratorSids } });
  const port = await H.daemonReady(d);
  await assertCandidateDaemon(d, port, home, caseId);

  const ids = { orch: SINK, d: 'rc6-d', peer: 'rc6-peer' };
  const eps = {};
  for (const [k, id] of Object.entries(ids)) {
    const ep = await startAtermRecorder(id);
    sinks.push(ep);
    eps[k] = ep;
    const r = await call(port, home, 'POST', '/api/sessions/register', {
      session_id: id, delivery_type: 'aterm', delivery_endpoint: ep.endpoint, command: 'rc6-sink'
    });
    assert.equal(r.status, 201, `${caseId}: register ${id}`);
  }
  async function send(from, to, k) {
    const prompt = `rc6 ${from}->${to} ${crypto.randomBytes(4).toString('hex')}`;
    const r = await call(port, home, 'POST', `/api/sessions/${encodeURIComponent(to)}/inject`, { prompt, from });
    let delivered = false;
    if (r.status === 200) {
      await H.waitFor(() => eps[k].got(prompt), { timeoutMs: 10000, description: `${caseId}: delivery ${from}->${to}` });
      delivered = true;
    }
    return { status: r.status, code: r.body && r.body.code, delivered, prompt };
  }
  return { d, port, home, ids, eps, send };
}

function policySummary(t, caseId, rows) {
  t.diagnostic(`RC-SUMMARY ${JSON.stringify({ case: caseId, ...rows })}`);
}

test('RC6a policy lane: AIGENTRY_ORCHESTRATOR_SIDS unset → default lane names `orchestrator`: D→orchestrator and orchestrator→D allowed, peer→peer still blocked', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const p = await runPolicyCase(t, 'RC6a', undefined);
  const fwd = await p.send(p.ids.d, p.ids.orch, 'orch');
  const back = await p.send(p.ids.orch, p.ids.d, 'd');
  const peer = await p.send(p.ids.d, p.ids.peer, 'peer');
  policySummary(t, 'RC6a', { forward: fwd.status, reverse: back.status, peer: peer.status });
  assert.equal(fwd.status, 200, 'RC6a: D → orchestrator is on the default orchestrator lane');
  assert.equal(back.status, 200, 'RC6a: orchestrator → D is on the default orchestrator lane');
  assert.equal(peer.status, 403, 'RC6a: the guard is active (peer → peer without envelope is blocked)');
  assert.equal(peer.code, 'PEER_INJECT_BLOCKED');
  assert.doesNotMatch(p.d.log(), /peer guardrail disabled/, 'RC6a: no fail-open warning');
});

test('RC6b policy lane: AIGENTRY_ORCHESTRATOR_SIDS="" → same default lane as unset', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const p = await runPolicyCase(t, 'RC6b', '');
  const fwd = await p.send(p.ids.d, p.ids.orch, 'orch');
  const back = await p.send(p.ids.orch, p.ids.d, 'd');
  const peer = await p.send(p.ids.d, p.ids.peer, 'peer');
  policySummary(t, 'RC6b', { forward: fwd.status, reverse: back.status, peer: peer.status });
  assert.equal(fwd.status, 200, 'RC6b: D → orchestrator allowed');
  assert.equal(back.status, 200, 'RC6b: orchestrator → D allowed');
  assert.equal(peer.status, 403, 'RC6b: "" falls back to the default sids, so the guard is still active');
  assert.equal(peer.code, 'PEER_INJECT_BLOCKED');
  assert.doesNotMatch(p.d.log(), /peer guardrail disabled/, 'RC6b: no fail-open warning');
});

test('RC6c policy lane: AIGENTRY_ORCHESTRATOR_SIDS="   " → guard disabled, fail-open with a warning', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const p = await runPolicyCase(t, 'RC6c', '   ');
  const fwd = await p.send(p.ids.d, p.ids.orch, 'orch');
  const peer = await p.send(p.ids.d, p.ids.peer, 'peer');
  await H.waitFor(() => /\[PEER-GUARD\] orchestrator sid unconfigured .*fail-open/.test(p.d.log()), {
    timeoutMs: 5000, description: 'RC6c: fail-open warning in the daemon log'
  });
  policySummary(t, 'RC6c', { forward: fwd.status, peer: peer.status, fail_open_warning: true });
  assert.equal(fwd.status, 200, 'RC6c: D → orchestrator allowed');
  assert.equal(peer.status, 200, 'RC6c: whitespace-only resolves to no sids → peer → peer allowed (fail-open)');
});

test('RC6d policy lane: explicit AIGENTRY_ORCHESTRATOR_SIDS without the target → 403 PEER_INJECT_BLOCKED, nothing delivered', { timeout: CASE_TIMEOUT_MS }, async (t) => {
  const p = await runPolicyCase(t, 'RC6d', 'rc6-some-other-orchestrator');
  const fwd = await p.send(p.ids.d, p.ids.orch, 'orch');
  await H.delay(500);
  const row = await H.waitFor(async () => {
    const a = await call(p.port, p.home, 'GET', `/api/injects?to=${encodeURIComponent(p.ids.orch)}&limit=50`);
    return a.body && Array.isArray(a.body.injects) ? a.body.injects.find((x) => x.payload_sha256 === sha256(fwd.prompt)) : null;
  }, { timeoutMs: 5000, description: 'RC6d: the blocked attempt is audited' });
  policySummary(t, 'RC6d', { forward: fwd.status, code: fwd.code, delivered: p.eps.orch.count() > 0 });
  assert.equal(fwd.status, 403, 'RC6d: a named orchestrator list that omits the target puts D → orchestrator on the peer lane');
  assert.equal(fwd.code, 'PEER_INJECT_BLOCKED');
  assert.equal(p.eps.orch.count(), 0, 'RC6d: nothing reached the target');
  assert.match(String(row.delivery_result), /^blocked:/, 'RC6d: the audit row records the block');
});
