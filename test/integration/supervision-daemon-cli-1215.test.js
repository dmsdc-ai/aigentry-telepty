'use strict';
// Task 1215 — ACTUAL daemon + ACTUAL CLI regression for combined-mode user supervision (authored by the
// independent tester; frozen before any run).
//
// Real callers only:
//   - daemon.js started by test-support/daemon-harness.js on a private loopback ephemeral port, configured
//     via TELEPTY_SUPERVISION_TRUST_FILE (file-backed trust, real readAuthorityFile);
//   - cli.js `allow --input-policy user-supervised` under node-pty, with TELEPTY_SUPERVISION_CLIENT_FILE
//     (file-backed operator client + private key, real signing, real HTTP + owner WebSocket);
//   - cli.js `inject` for delivery; the child records its ACTUAL stdin bytes in an owned witness file;
//   - negatives over real HTTP with assertions from the real principal client (src/principal/client.js);
//   - restart of ONLY the fixture-owned daemon (harness kill() of its own child), restore from the product's
//     own persisted state, and re-registration by the live bridge that holds its current credential.
// Nothing is substituted: no fake verifier, no hand-written owner/epoch, no persistence rewrite.
//
// Platform: Linux and macOS. macOS needs the bundled native reader
// (src/principal/native/prebuilt/darwin/authority-darwin.node); without it the daemon refuses to start,
// and this test FAILS explicitly (it is not skipped). Windows is not a supported authority-file platform;
// the test is reported as skipped there with that reason. It claims nothing about Windows.
// "PRECONDITION:" = setup/prerequisite (a failure is INVALID / NOTRUN for behavior, never a pass).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestDaemon, waitFor, createSessionId } = require('../../test-support/daemon-harness');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIENCE = 'telepty-1215-real-caller';
const CI_TELEPTY_ALLOWED = new Set(['TELEPTY_NO_TAILNET_AUTO', 'TELEPTY_CLIENT_RESTART', 'TELEPTY_SKIP_DAEMON_REPAIR',
  'TELEPTY_SKIP_POSTINSTALL', 'TELEPTY_DISABLE_UPDATE_NOTIFIER']);
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const platform = process.platform === 'win32'
  ? { skip: 'win32: authority-file backend unsupported (Linux /proc/self/fd, macOS native openat only); no Windows claim', timeout: 120000 }
  : { timeout: 120000 };

// Child fixture: append the ACTUAL bytes arriving on stdin to an owned witness file; record which
// supervision variables (names only) are visible in its environment. Exits on a line containing EXIT.
const CHILD = [
  "const fs=require('fs');const w=process.argv[1];",
  "fs.writeFileSync(w+'.start',JSON.stringify({pid:process.pid,ppid:process.ppid,",
  "env:Object.keys(process.env).filter(k=>/SUPERVISION|PRINCIPAL_CLIENT|PRINCIPAL_TRUST/.test(k))}),{mode:0o600});",
  "process.stdin.on('data',d=>{fs.appendFileSync(w,d);if(String(d).includes('EXIT'))process.exit(0);});",
].join('');

function realTempRoot() {
  // realpath: the authority-file walk refuses symlinked ancestors (macOS /var -> /private/var).
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'telepty-1215-real-'));
  fs.chmodSync(root, 0o700);
  for (const part of ['home', 'keys', 'witness']) fs.mkdirSync(path.join(root, part), { mode: 0o700 });
  return root;
}
function writePrivate(file, content) { fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' }); fs.chmodSync(file, 0o600); }
function keyPair(root, name) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyPath = path.join(root, 'keys', `${name}.pem`);
  writePrivate(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { pair, keyPath, spki: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function clientFile(root, name, key, { port, principalId, keyId }) {
  const file = path.join(root, 'keys', `${name}-client.json`);
  writePrivate(file, JSON.stringify({ schema: 'telepty.principal-client/v1', daemon_url: `http://127.0.0.1:${port}`,
    principal_id: principalId, key_id: keyId, audience: AUDIENCE, private_key_path: key.keyPath }));
  return file;
}
function inheritedDirtyEnv() {
  return Object.keys(process.env).filter(k => (k.startsWith('TELEPTY_') && !CI_TELEPTY_ALLOWED.has(k))
    || k.startsWith('AIGENTRY_TELEPTY_') || (PROXY_KEYS.includes(k) && process.env[k]));
}
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TELEPTY_') || key.startsWith('AIGENTRY_TELEPTY_') || PROXY_KEYS.includes(key)
    || ['NODE_OPTIONS', 'PORT', 'HOST'].includes(key)) delete env[key];
  return env;
}
function spawnBridge({ root, daemon, sid, token, supervisionClient, witness }) {
  const pty = require('node-pty');   // real PTY harness (as test/credential-bridge-integration-92.test.js)
  const env = { ...cleanEnv(), HOME: daemon.homeDir, USERPROFILE: daemon.homeDir, XDG_CONFIG_HOME: path.join(daemon.homeDir, '.config'),
    TMPDIR: path.join(root, 'witness'), TELEPTY_HOST: daemon.host, TELEPTY_PORT: String(daemon.port), TELEPTY_AUTH_TOKEN: token,
    TELEPTY_NO_TAILNET_AUTO: '1', TELEPTY_NO_SUPERVISOR_DEFER: '1', TELEPTY_CLIENT_RESTART: 'off', TELEPTY_SKIP_DAEMON_REPAIR: '1',
    TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', NO_UPDATE_NOTIFIER: '1', TELEPTY_SUPERVISION_CLIENT_FILE: supervisionClient };
  const proc = pty.spawn(process.execPath, ['cli.js', 'allow', '--id', sid, '--input-policy', 'user-supervised', '--idle-ttl', 'off', '--',
    process.execPath, '-e', CHILD, witness], { cwd: ROOT, env, cols: 100, rows: 30, name: 'xterm-256color' });
  const state = { proc, pid: proc.pid, output: '', exit: null };
  proc.onData(data => { state.output += data; });
  proc.onExit(event => { state.exit = event.exitCode; });
  return state;
}
async function stopBridge(bridge) {
  if (!bridge || bridge.exit !== null) return;
  try { bridge.proc.write('EXIT\r'); } catch {}
  try { await waitFor(() => bridge.exit !== null, { timeoutMs: 3000 }); return; } catch {}
  try { bridge.proc.kill('SIGTERM'); } catch {}
  try { await waitFor(() => bridge.exit !== null, { timeoutMs: 3000 }); return; } catch {}
  try { bridge.proc.kill('SIGKILL'); } catch {}
  await waitFor(() => bridge.exit !== null, { timeoutMs: 3000, description: 'owned bridge termination' });
}
const witnessText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
// The child's OWN startup record (written by the child process itself, first thing it does), or null.
// Only this file proves the child executed; daemon supervision and bridge readiness do not (cli.js binds
// the owner and receives input_policy BEFORE it spawns the child: initialOwnerAccepted → spawnChild()).
function childStart(witness) {
  try {
    const start = JSON.parse(fs.readFileSync(witness + '.start', 'utf8'));
    return Number.isSafeInteger(start.pid) && start.pid > 0 && Array.isArray(start.env) ? start : null;
  } catch { return null; }
}
// Bounded wait that, on timeout, reports diagnostics read AT THE FAILURE (not when the wait began).
async function boundedWait(check, { deadline, label, diagnose }) {
  try {
    return await waitFor(check, { timeoutMs: Math.max(0, deadline - Date.now()), description: label });
  } catch (error) {
    let detail = '';
    try { detail = JSON.stringify(await diagnose()); } catch (e) { detail = `diagnostics unavailable: ${e && e.message}`; }
    throw new Error(`${error.message}\nDIAGNOSTICS ${detail}`);
  }
}
async function transportOf(daemon, sid) {
  const r = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}`);
  return r.status === 200 && r.body ? r.body.transport : null;
}
async function cliInject(daemon, token, sid, prompt) {
  return daemon.runCli(['inject', sid, prompt], { timeoutMs: 15000, env: { ...cleanEnv(), HOME: daemon.homeDir, TELEPTY_AUTH_TOKEN: token,
    TELEPTY_CLIENT_RESTART: 'off', TELEPTY_SKIP_DAEMON_REPAIR: '1', TELEPTY_NO_TAILNET_AUTO: '1', NO_UPDATE_NOTIFIER: '1' } });
}
// A real-HTTP register carrying the daemon token plus (optionally) a proof made by the REAL principal client.
async function signedRegister(daemon, token, body, { clientPath = null, sessionEpoch, bearer = null } = {}) {
  const headers = { 'content-type': 'application/json', 'x-telepty-token': token, ...(bearer ? { 'x-telepty-session-token': bearer } : {}) };
  if (clientPath) {
    const { loadPrincipalClientConfiguration, createPrincipalClient } = require('../../src/principal/client');
    const client = createPrincipalClient(loadPrincipalClientConfiguration(clientPath));
    headers['x-telepty-principal'] = await client.assertion({ method: 'POST', target: '/api/sessions/register', body, action: 'session.register',
      ...(sessionEpoch ? { sessionEpoch } : {}) });
  }
  const response = await fetch(`http://${daemon.host}:${daemon.port}/api/sessions/register`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' });
  let parsed = null; try { parsed = await response.json(); } catch {}
  return { status: response.status, body: parsed || {} };
}

test('#1215 real daemon + real CLI: file-backed operator supervision, child-input nonce, real negatives, owned-daemon restore', platform, async t => {
  assert.deepEqual(inheritedDirtyEnv(), [], 'PRECONDITION: no inherited telepty/auth/proxy state in the test environment');
  const root = realTempRoot();
  const homeDir = path.join(root, 'home');
  const token = crypto.randomBytes(32).toString('hex');
  const sid = createSessionId('sup-1215');
  const negToken = createSessionId('sup-1215-neg-token');
  const negWorker = createSessionId('sup-1215-neg-worker');
  const negForged = createSessionId('sup-1215-neg-forged');
  const guardedSid = createSessionId('sup-1215-guarded');
  const operator = keyPair(root, 'operator');
  const worker = keyPair(root, 'worker');
  const unenrolled = keyPair(root, 'unenrolled');
  const trustFile = path.join(root, 'keys', 'trust.json');
  writePrivate(trustFile, JSON.stringify({ schema: 'telepty.principals/v1', audience: AUDIENCE, keys: [
    { key_id: 'operator-key', principal_id: 'operator', authority: 'operator', public_key_spki: operator.spki,
      grants: [{ action: 'session.register', targets: [sid, negToken, negWorker, negForged, guardedSid] }] },
    { key_id: 'worker-key', principal_id: 'worker', authority: 'principal', public_key_spki: worker.spki,
      grants: [{ action: 'session.register', targets: [negWorker] }] }] }));
  const daemonEnv = { TELEPTY_AUTH_TOKEN: token, TELEPTY_MACHINE_ID: AUDIENCE, TELEPTY_SUPERVISION_TRUST_FILE: trustFile,
    TELEPTY_NO_TAILNET_AUTO: '1', TELEPTY_NO_SUPERVISOR_DEFER: '1' };
  let daemon = null, bridge = null;
  t.after(async () => {
    await stopBridge(bridge);
    if (daemon) await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ---- 1. actual daemon with file-backed supervision trust, actual CLI allow with file-backed operator client
  daemon = await startTestDaemon({ homeDir, env: daemonEnv });
  const port = daemon.port;
  const challenge = await daemon.request('/api/auth/challenge');
  assert.equal(challenge.status, 200, 'PRECONDITION: combined-mode supervision challenge served (trust file loaded by the real daemon)');
  assert.equal(challenge.body.audience, AUDIENCE, 'PRECONDITION: challenge audience from the file-backed trust');
  const operatorClient = clientFile(root, 'operator', operator, { port, principalId: 'operator', keyId: 'operator-key' });
  const workerClient = clientFile(root, 'worker', worker, { port, principalId: 'worker', keyId: 'worker-key' });
  const forgedClient = clientFile(root, 'forged', unenrolled, { port, principalId: 'operator', keyId: 'operator-key' });
  const witness = path.join(root, 'witness', 'child-stdin.bin');
  bridge = spawnBridge({ root, daemon, sid, token, supervisionClient: operatorClient, witness });
  // Fresh failure-time evidence for every bounded wait below (raw, unfiltered tails).
  const diagnose = async () => {
    let transport = null;
    try { transport = await transportOf(daemon, sid); } catch (e) { transport = `unreadable: ${e && e.message}`; }
    return { bridgeExit: bridge.exit, bridgeOutputTail: bridge.output.slice(-2000), daemonAlive: daemon.isAlive(),
      daemonLogTail: (({ stdout, stderr }) => ({ stdout: stdout.slice(-1500), stderr: stderr.slice(-1500) }))(daemon.getLogs()),
      transport, childStartPresent: fs.existsSync(witness + '.start'), childStart: childStart(witness), stdinWitnessBytes: witnessText(witness).length };
  };
  // ONE existing 20 s budget covers both facts: the daemon's effective supervision (owner bound) AND the child's own
  // startup record. The bridge spawns the child only after the owner is accepted, so the second can lag the first.
  const startDeadline = Date.now() + 20000;
  await boundedWait(async () => { const tr = await transportOf(daemon, sid); return tr && tr.input_policy === 'user-supervised'; },
    { deadline: startDeadline, label: `effective user-supervised for ${sid}`, diagnose });
  const start = await boundedWait(() => childStart(witness), { deadline: startDeadline, label: 'child-owned startup record (witness .start)', diagnose });
  const before = await transportOf(daemon, sid);
  const nonce1 = `N1215A-${crypto.randomBytes(12).toString('hex')}`;
  const inject1 = await cliInject(daemon, token, sid, nonce1);
  await boundedWait(() => witnessText(witness).includes(nonce1), { deadline: Date.now() + 15000, label: 'nonce 1 in the child stdin witness', diagnose });
  const persisted = JSON.parse(fs.readFileSync(require('../../src/session-store/persistence').defaultSessionPersistPath(homeDir), 'utf8'))[sid] || null;
  const positive = { inputPolicy: before.input_policy, source: before.input_policy_source, inject1Code: inject1.code,
    nonce1InChildInput: witnessText(witness).includes(nonce1), childSupervisionEnv: start.env,
    persistedOwner: persisted && persisted.owningPrincipal ? persisted.owningPrincipal.id : null,
    proofOrCapabilityInPersisted: JSON.stringify(persisted || {}).includes('input_policy_capability') };
  t.diagnostic(`positive ${JSON.stringify(positive)}`);
  assert.deepEqual(positive, { inputPolicy: 'user-supervised', source: 'operator_principal_registration', inject1Code: 0,
    nonce1InChildInput: true, childSupervisionEnv: [], persistedOwner: 'operator', proofOrCapabilityInPersisted: false });

  // ---- 2. real-protocol negatives (the positive above is reachable on this same daemon)
  // Each negative uses its OWN new sid, so each reaches the new-instance check it targets.
  const negBody = id => ({ session_id: id, command: 'test-wrap', cwd: ROOT, input_policy: 'user-supervised' });
  const tokenOnly = await signedRegister(daemon, token, negBody(negToken));
  const workerProof = await signedRegister(daemon, token, negBody(negWorker), { clientPath: workerClient });
  const forged = await signedRegister(daemon, token, negBody(negForged), { clientPath: forgedClient });
  const guarded = await daemon.registerSession(guardedSid, { command: 'test-wrap' });
  assert.equal(guarded.status, 201, 'PRECONDITION: guarded token registration');
  const takeover = await signedRegister(daemon, token, { session_id: guardedSid, command: 'test-wrap', cwd: ROOT, input_policy: 'user-supervised' },
    { clientPath: operatorClient, sessionEpoch: guarded.body.session_epoch, bearer: guarded.body.session_token });
  const negatives = {
    tokenOnly: [tokenOnly.status, tokenOnly.body.input_policy_pending === true, tokenOnly.body.input_policy_refused || null, Object.hasOwn(tokenOnly.body, 'input_policy_capability')],
    workerProof: [workerProof.status, workerProof.body.input_policy_pending === true],
    forged: [forged.status, forged.body.input_policy_pending === true],
    takeover: [takeover.status, takeover.body.input_policy_pending === true],
    guardedPolicyAfter: (await transportOf(daemon, guardedSid)).input_policy,
  };
  t.diagnostic(`negatives ${JSON.stringify(negatives)}`);
  assert.deepEqual(negatives, { tokenOnly: [201, false, 'INPUT_POLICY_OPERATOR_REQUIRED', false], workerProof: [403, false], forged: [401, false],
    takeover: [403, false], guardedPolicyAfter: 'guarded' });

  // ---- 3. restart ONLY the fixture-owned daemon; restore from its own persisted state; live bridge re-registers
  const bridgePidBefore = bridge.pid;
  await daemon.kill();                                            // harness: SIGTERM/SIGKILL of its own child only
  daemon = await startTestDaemon({ homeDir, port, env: daemonEnv });
  await boundedWait(async () => { const tr = await transportOf(daemon, sid); return tr && tr.input_policy === 'user-supervised'; },
    { deadline: Date.now() + 30000, label: 're-supervised after restore', diagnose });
  const nonce2 = `N1215B-${crypto.randomBytes(12).toString('hex')}`;
  const inject2 = await cliInject(daemon, token, sid, nonce2);
  await boundedWait(() => witnessText(witness).includes(nonce2), { deadline: Date.now() + 15000, label: 'nonce 2 in the child stdin witness', diagnose });
  const after = await transportOf(daemon, sid);
  const restored = { bridgeAlive: bridge.exit === null, samePid: bridge.pid === bridgePidBefore, inputPolicy: after.input_policy,
    source: after.input_policy_source, inject2Code: inject2.code, nonce2InChildInput: witnessText(witness).includes(nonce2),
    childRestarted: JSON.parse(fs.readFileSync(witness + '.start', 'utf8')).pid !== start.pid };
  t.diagnostic(`restored ${JSON.stringify(restored)}`);
  assert.deepEqual(restored, { bridgeAlive: true, samePid: true, inputPolicy: 'user-supervised', source: 'operator_principal_registration',
    inject2Code: 0, nonce2InChildInput: true, childRestarted: false });
});
