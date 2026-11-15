'use strict';

// Task 1270 — safe boot interface: `telepty boot-capabilities` (sealed, pure local), the versioned `allow-create-v1` verb
// (canonical loopback only, one authenticated /api/meta check, first register create_only:true, NEVER ensureDaemonRunning),
// and non-deleting viewer detach for wrapped sessions on both attach paths. Contract: output/SPEC.md.
//
//
// Written BEFORE the production change; the coder did not execute it. A failure on 352d2dd that is only a missing export or
// an unknown verb is NOT product evidence; the meaningful checks are the observable CLI/daemon effects in Part 2.
//
// Part 1 (in-process) drives the real production exports of cli.js with injected fetch/writers — no listener, no process.
// Part 2 (process, CI only) runs the real cli.js against a REAL isolated daemon (test-support/daemon-harness startTestDaemon:
// daemon.js on 127.0.0.1 PORT=0, mkdtemp HOME, daemon-minted synthetic token) and, where a connection has to be cut or
// silenced, the existing byte pass-through test-support/bridge-pipe-harness startProxy. No test-owned HTTP/WS server.
// With `observe: true` that proxy records each CLI request's method + path (query stripped; no headers/bodies/tokens) and offers
// two per-request seams: hold one matching request, or swallow one matching request's response after the daemon answered it.
// Observable evidence: the CLI's requests on the wire, CLI exit/stdout/stderr, the app marker file, the daemon's own session
// records and register log lines, and the daemon's instance_id (never restarted). Declared fakes: the wrapped application only.
// This slice cannot prove native identity, custody or full no-kill acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const cli = require(path.join(ROOT, 'cli.js'));

const SEALED_LINE = '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"],"viewer_detach":"nondeleting-v1"}';
const REQUIRED_CAPS = ['wrapped-sessions', 'register-create-only'];

// ── Part 1: in-process, production exports ─────────────────────────────────────────────────────────────────────────

test('1270 boot-capabilities: the sealed line is exact and the reference validator accepts it only with exit 0', () => {
  assert.equal(cli.bootCapabilitiesLine(), SEALED_LINE);
  assert.deepEqual(JSON.parse(cli.bootCapabilitiesLine()), {
    schema: 'telepty-boot-capabilities-v1', verbs: ['allow-create-v1'], viewer_detach: 'nondeleting-v1' });
  const ok = cli.parseBootCapabilities(`${SEALED_LINE}\n`, 0);
  assert.equal(ok.supported, true);
  assert.deepEqual(ok.verbs, ['allow-create-v1']);
  assert.equal(ok.viewer_detach, 'nondeleting-v1');
  assert.equal(cli.parseBootCapabilities(`${SEALED_LINE}\n`, 1).supported, false, 'non-zero exit is never support');
  assert.equal(cli.parseBootCapabilities(`${SEALED_LINE}\n`, null).supported, false, 'signal/unknown exit is never support');
});

test('1270 boot-capabilities: help text, empty output and near-miss documents are unsupported (old CLI exit 0 never counts)', () => {
  const nearMisses = [
    '',
    '\n',
    '\n\x1b[1mtelepty\x1b[0m — Connect any terminal to any terminal, any machine.\n\n\x1b[1mSession Management:\x1b[0m\n  telepty allow ...\n',
    'Usage: telepty boot-capabilities\n',
    `${SEALED_LINE}\n${SEALED_LINE}\n`,
    `noise\n${SEALED_LINE}\n`,
    '{"schema":"telepty-boot-capabilities-v2","verbs":["allow-create-v1"],"viewer_detach":"nondeleting-v1"}\n',
    '{"schema":"telepty-boot-capabilities-v1","verbs":[],"viewer_detach":"nondeleting-v1"}\n',
    '{"schema":"telepty-boot-capabilities-v1","verbs":["allow"],"viewer_detach":"nondeleting-v1"}\n',
    '{"schema":"telepty-boot-capabilities-v1","verbs":"allow-create-v1","viewer_detach":"nondeleting-v1"}\n',
    '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1","allow-create-v1"],"viewer_detach":"nondeleting-v1"}\n',
    '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"],"viewer_detach":"deleting"}\n',
    '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"]}\n',
    '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"],"viewer_detach":"nondeleting-v1","extra":true}\n',
    '["telepty-boot-capabilities-v1"]\n',
    'null\n'
  ];
  for (const text of nearMisses) {
    assert.equal(cli.parseBootCapabilities(text, 0).supported, false, `must be unsupported: ${JSON.stringify(text)}`);
  }
  assert.equal(cli.parseBootCapabilities(undefined, 0).supported, false);
  assert.equal(cli.parseBootCapabilities(Buffer.from(`${SEALED_LINE}\n`), 0).supported, true, 'a Buffer stdout is accepted');
});

test('1270 boot-capabilities: runBootCapabilities is pure local — exact argv only, zero fetch', () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => { fetchCalls++; throw new Error('boot-capabilities must not fetch'); };
  try {
    const out = []; const err = [];
    const io = { stdout: { write: s => { out.push(String(s)); return true; } }, stderr: { write: s => { err.push(String(s)); return true; } } };
    assert.equal(cli.runBootCapabilities(['boot-capabilities'], io), 0);
    assert.deepEqual(out, [`${SEALED_LINE}\n`]);
    assert.deepEqual(err, []);
    for (const argv of [['boot-capabilities', '--json'], ['boot-capabilities', '--help'], ['boot-capabilities', 'x'], ['allow']]) {
      const o = []; const e = [];
      const io2 = { stdout: { write: s => { o.push(String(s)); return true; } }, stderr: { write: s => { e.push(String(s)); return true; } } };
      assert.equal(cli.runBootCapabilities(argv, io2), 2, JSON.stringify(argv));
      assert.deepEqual(o, [], 'usage never reaches stdout (a consumer must never parse it as support)');
      assert.ok(e.join('').includes('Usage: telepty boot-capabilities'));
    }
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetchCalls, 0);
});

test('1270 allow-create-v1 target: only the canonical 127.0.0.1 host is admitted (decided before any network)', () => {
  assert.equal(cli.createTargetRefusal('127.0.0.1'), null);
  for (const host of ['localhost', '::1', '[::1]', '127.0.0.2', '0.0.0.0', '10.0.0.5', '100.64.0.1', '192.0.2.1', 'example.com', '', null, undefined]) {
    const refusal = cli.createTargetRefusal(host);
    assert.equal(typeof refusal, 'string', `must refuse ${JSON.stringify(host)}`);
    assert.match(refusal, /allow-create-v1 refuses non-canonical daemon host/);
  }
});

function metaFetch(responder) {
  const calls = [];
  const fn = async (url, options) => { calls.push({ url, options }); return responder(url, options); };
  return { fn, calls };
}
function jsonResponse(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('1270 allow-create-v1 capability check: exactly one bounded read-only GET /api/meta; both caps required', async () => {
  const daemonUrl = 'http://127.0.0.1:3848';
  const good = metaFetch(() => jsonResponse(200, { version: '0.11.0', capabilities: ['sessions', ...REQUIRED_CAPS, 'mailbox'] }));
  assert.deepEqual(await cli.checkCreateDaemonSupport(good.fn, daemonUrl), { ok: true });
  assert.equal(good.calls.length, 1);
  assert.equal(good.calls[0].url, `${daemonUrl}/api/meta`);
  assert.equal(good.calls[0].options.readOnlyAuth, true, 'never mints a credential');
  assert.ok(good.calls[0].options.signal instanceof AbortSignal, 'bounded');
  assert.equal(good.calls[0].options.method === undefined || good.calls[0].options.method === 'GET', true);

  const refusals = [
    ['only wrapped-sessions', () => jsonResponse(200, { capabilities: ['wrapped-sessions'] })],
    ['only register-create-only', () => jsonResponse(200, { capabilities: ['register-create-only'] })],
    ['no capabilities (old daemon)', () => jsonResponse(200, { version: '0.9.2' })],
    ['capabilities object, not array (do not guess schema)', () => jsonResponse(200, { capabilities: { 'wrapped-sessions': true, 'register-create-only': true } })],
    ['capabilities nested elsewhere', () => jsonResponse(200, { features: { capabilities: REQUIRED_CAPS } })],
    ['401 auth refusal', () => jsonResponse(401, { error: 'Unauthorized' })],
    ['403 auth refusal', () => jsonResponse(403, { capabilities: REQUIRED_CAPS })],
    ['500', () => jsonResponse(500, { capabilities: REQUIRED_CAPS })],
    ['non-JSON body', () => jsonResponse(200, '<html>not a daemon</html>')],
    ['null body', () => jsonResponse(200, 'null')],
    ['timeout', () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }],
    ['transport error', () => { throw new TypeError('fetch failed'); }],
  ];
  for (const [label, responder] of refusals) {
    const probe = metaFetch(responder);
    const verdict = await cli.checkCreateDaemonSupport(probe.fn, daemonUrl);
    assert.equal(verdict.ok, false, label);
    assert.equal(typeof verdict.reason, 'string', label);
    assert.equal(probe.calls.length, 1, `${label}: exactly one request, no retry`);
  }
});

test('1270 viewer close decision: wrapped / absent / untyped are never deleted; non-wrapped semantics preserved', () => {
  const d = cli.viewerCloseDecision;
  assert.equal(d([{ id: 'w', type: 'wrapped', active_clients: 0 }], 'w'), 'keep-wrapped', 'owner disconnected, no viewers: still kept');
  assert.equal(d([{ id: 'w', type: 'wrapped', active_clients: 2 }], 'w'), 'keep-wrapped');
  assert.equal(d([{ id: 'w', type: 'wrapped' }], 'w'), 'keep-wrapped');
  assert.equal(d([{ id: 'other', type: 'spawned', active_clients: 0 }], 'w'), 'keep-unknown', 'absent: a bare DELETE could alias-resolve elsewhere');
  assert.equal(d([{ id: 'w', active_clients: 0 }], 'w'), 'keep-unknown', 'untyped (restricted list) cannot prove non-wrapped');
  assert.equal(d([], 'w'), 'keep-unknown');
  assert.equal(d(null, 'w'), 'keep-unknown');
  assert.equal(d({ id: 'w', type: 'spawned' }, 'w'), 'keep-unknown');
  // Unchanged non-wrapped rows:
  assert.equal(d([{ id: 's', type: 'spawned', active_clients: 1 }], 's'), 'keep-clients');
  assert.equal(d([{ id: 's', type: 'spawned', active_clients: 0 }], 's'), 'destroy');
  assert.equal(d([{ id: 'a', type: 'aterm', active_clients: 0 }], 'a'), 'destroy');
});

// ── Part 2: process + real isolated daemon (CI only; not executed by the coder) ────────────────────────────────────────

const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const { startProxy } = require('../test-support/bridge-pipe-harness');
let pty = null;
try { pty = require('node-pty'); } catch { /* reported as skip below */ }
const PTY_SKIP = pty && process.platform !== 'win32' ? false : 'requires node-pty on a POSIX host';

async function realDaemon(t) {
  const daemon = await startTestDaemon();
  t.after(() => daemon.stop());
  return daemon;
}
// The existing pass-through proxy in front of the real daemon, observing (method + path per request, per connection).
async function proxyTo(t, daemon) {
  const proxy = startProxy({ targetPort: daemon.port, targetHost: daemon.host, observe: true });
  const port = await proxy.listen();
  t.after(() => proxy.close());
  return { proxy, port };
}
// What the CLI put on the wire through this proxy: [[METHOD, path], ...] in arrival order; framing must never have fallen back.
function wire(proxy) {
  assert.equal(proxy.unparsed(), 0, 'PRECONDITION: every connection was framed (no opaque fallback)');
  assert.equal(proxy.overflow(), false, 'PRECONDITION: observation not truncated');
  return proxy.requests().map(r => [r.method, r.path]);
}
const META = ['GET', '/api/meta'];
const REGISTER = ['POST', '/api/sessions/register'];
const countOf = (proxy, [method, p]) => wire(proxy).filter(([m, x]) => m === method && x === p).length;
async function daemonInstance(daemon) {
  const meta = await daemon.request('/api/meta');
  assert.equal(meta.status, 200, 'PRECONDITION: the harness daemon answers its own meta');
  return { pid: meta.body.pid, instance_id: meta.body.instance_id };
}
async function sessionRecord(daemon, sid) {
  const r = await daemon.request(`/api/sessions/${encodeURIComponent(sid)}`);
  return r.status === 200 ? r.body : null;
}
const daemonOut = daemon => daemon.getLogs().stdout;
const occurrences = (text, needle) => text.split(needle).length - 1;
const registeredLine = sid => `[REGISTER] Registered wrapped session ${sid} `;
const reregisteredLine = sid => `[REGISTER] Re-registered session ${sid} `;

function tmpHome(t, tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `telepty-1270-${tag}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
// The CLI uses the daemon's HOME (its daemon-minted config token), as test/cli.test.js does, unless a test overrides it.
function cliEnv(daemon, port, extra = {}) {
  const env = { ...process.env, HOME: daemon.homeDir, USERPROFILE: daemon.homeDir, TELEPTY_PORT: String(port),
    NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', ...extra };
  for (const k of ['TELEPTY_HOST', 'TELEPTY_SESSION_ID', 'TELEPTY_SESSION_TOKEN', 'TELEPTY_PRINCIPAL_CLIENT_FILE', 'TELEPTY_SUPERVISION_CLIENT_FILE',
    'TELEPTY_HANDOFF_CREDENTIAL_FILE', 'TELEPTY_SESSION_CREDENTIAL_REFRESH', 'TELEPTY_COOPERATIVE_HANDOFF']) if (!(k in extra)) delete env[k];
  return env;
}
// fix1: the CLI child is spawned WITHOUT `--require ./test-support/setup-env.js`. That preload sets HOME to a fresh
// mkdtemp unconditionally (setup-env.js:49-51), so the CLI read its credential from an EMPTY HOME instead of the harness
// daemon's: the read-only meta check then failed closed before any request (CI 43728552002: heldCount 0, faults 0, the
// bridge and the viewer never started). Same convention as test/cli.test.js:895 — HOME is always passed explicitly and is
// always a mkdtemp (the daemon harness's, or the test's own), so real-HOME isolation is unchanged.
function runCli(argv, env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli.js', ...argv], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const started = Date.now();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`cli ${argv[0]} did not exit within ${timeoutMs} ms`)); }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, ms: Date.now() - started }); });
  });
}
// fix1: bounded, non-secret diagnostics for a failed first precondition (exit + the tail of what the CLI printed).
const tail = text => JSON.stringify(String(text).slice(-400));
const cliSaid = r => `exit=${r.code} signal=${r.signal} stderr=${tail(r.stderr)}`;
// A wait whose timeout message is built WHEN IT TIMES OUT, so it carries the state at that moment (the eager template
// in the CI run printed the bridge output as it was before the bridge had written anything: "bridge: \"\"").
async function waitOrExplain(check, opts, explain) {
  try { return await waitFor(check, opts); } catch (error) { throw new Error(`${error.message} — ${explain()}`); }
}
function appArgs(marker) {
  return [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n'); setInterval(() => {}, 1000);`];
}
function uniqueSid(tag) { return `boot1270-${tag}-${process.pid}-${Date.now().toString(36)}`; }

test('1270 process: `telepty boot-capabilities` puts zero requests on the wire and touches no HOME', async t => {
  const daemon = await realDaemon(t);
  const before = await daemonInstance(daemon);
  const { proxy, port } = await proxyTo(t, daemon);
  const home = tmpHome(t, 'caps');
  const r = await runCli(['boot-capabilities'], cliEnv(daemon, port, { HOME: home, USERPROFILE: home }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${SEALED_LINE}\n`);
  assert.equal(cli.parseBootCapabilities(r.stdout, r.code).supported, true);
  assert.deepEqual(fs.readdirSync(home), [], 'no config, credential or state file created');
  const bad = await runCli(['boot-capabilities', '--json'], cliEnv(daemon, port, { HOME: home, USERPROFILE: home }));
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, '');
  assert.equal(cli.parseBootCapabilities(bad.stdout, bad.code).supported, false);
  assert.deepEqual(wire(proxy), [], 'zero requests');
  assert.deepEqual(await daemonInstance(daemon), before, 'daemon not restarted');
});

test('1270 process: an unknown verb answers with help + exit 0 (the old-CLI shape) and the validator calls it unsupported', async t => {
  const daemon = await realDaemon(t);
  // This is exactly what a pre-1270 CLI does for `telepty boot-capabilities`: fall through main() to the global help.
  const r = await runCli(['boot-capabilities-unknown-1270'], cliEnv(daemon, daemon.port));
  assert.equal(r.code, 0, 'PRECONDITION: the help fallthrough exits 0 — the hazard the discriminator exists for');
  assert.match(r.stdout, /Session Management/);
  assert.equal(cli.parseBootCapabilities(r.stdout, r.code).supported, false);
});

test('1270 process: allow-create-v1 refuses a non-canonical / remote TELEPTY_HOST with zero requests; nothing registered, no app', async t => {
  const daemon = await realDaemon(t);
  const before = await daemonInstance(daemon);
  const { proxy, port } = await proxyTo(t, daemon);
  const home = tmpHome(t, 'remote');
  const marker = path.join(home, 'app-marker');
  const sid = uniqueSid('remote');
  // The two loopback spellings point at the observing proxy: had the CLI dialled, its request would be recorded there.
  for (const host of [`localhost:${port}`, `[::1]:${port}`, '192.0.2.1', `http://192.0.2.1:${port}`, '100.64.0.1']) {
    const r = await runCli(['allow-create-v1', '--id', sid, ...appArgs(marker)], cliEnv(daemon, port, { TELEPTY_HOST: host }));
    assert.equal(r.code, 1, `${host}: ${r.stderr}`);
    assert.match(r.stderr, /allow-create-v1 refuses non-canonical daemon host/);
    assert.doesNotMatch(r.stderr, /requires a running local daemon/, `${host}: refused before the meta check`);
  }
  assert.deepEqual(wire(proxy), [], 'zero requests');
  assert.equal(fs.existsSync(marker), false, 'no application started');
  assert.equal(await sessionRecord(daemon, sid), null, 'nothing registered');
  assert.equal(occurrences(daemonOut(daemon), registeredLine(sid)), 0);
  assert.deepEqual(await daemonInstance(daemon), before, 'daemon not restarted');
});

test('1270 process: allow-create-v1 with a refused credential (401 on /api/meta) → exactly one meta request, no register, no app, no repair', async t => {
  const daemon = await realDaemon(t);
  const before = await daemonInstance(daemon);
  const { proxy, port } = await proxyTo(t, daemon);
  const home = tmpHome(t, 'auth');
  const marker = path.join(home, 'app-marker');
  const sid = uniqueSid('auth');
  const r = await runCli(['allow-create-v1', '--id', sid, ...appArgs(marker)],
    cliEnv(daemon, port, { TELEPTY_AUTH_TOKEN: 'synthetic-wrong-token-1270' }));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /allow-create-v1 requires a running local daemon advertising wrapped-sessions and register-create-only \(HTTP 401\)/);
  assert.deepEqual(wire(proxy), [META], 'one meta check; no ensureDaemonRunning re-probe/health/stop, no register');
  assert.equal(fs.existsSync(marker), false, 'no application started');
  assert.equal(await sessionRecord(daemon, sid), null, 'nothing registered');
  assert.deepEqual(await daemonInstance(daemon), before, 'no start/restart/repair of the daemon');
  assert.equal(daemon.isAlive(), true);
});

test('1270 process: allow-create-v1 whose /api/meta is never answered → bounded exit 1 after exactly one meta request; no register/app/repair', async t => {
  const daemon = await realDaemon(t);
  const before = await daemonInstance(daemon);
  const { proxy, port } = await proxyTo(t, daemon);
  proxy.holdNextRequest({ method: 'GET', path: '/api/meta' });   // only this request is withheld; never released
  const home = tmpHome(t, 'timeout');
  const marker = path.join(home, 'app-marker');
  const sid = uniqueSid('timeout');
  const r = await runCli(['allow-create-v1', '--id', sid, ...appArgs(marker)], cliEnv(daemon, port));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /allow-create-v1 requires a running local daemon advertising wrapped-sessions and register-create-only/);
  assert.ok(r.ms < 8000, `bounded meta wait (${r.ms} ms)`);
  assert.equal(proxy.heldCount(), 1, `PRECONDITION: the meta request was the one withheld (${cliSaid(r)})`);
  assert.deepEqual(wire(proxy), [META], 'no retry, no re-probe, no register');
  assert.equal(fs.existsSync(marker), false, 'no application started');
  assert.equal(await sessionRecord(daemon, sid), null, 'nothing registered');
  assert.deepEqual(await daemonInstance(daemon), before, 'an unanswered probe never led to a start, restart or stop');
  assert.equal(daemon.isAlive(), true);
});

test('1270 process: a create-only register the daemon accepted but whose answer never reached the CLI → no app, no retry; the explicit rerun gets 409 with no second effect', async t => {
  const daemon = await realDaemon(t);
  const before = await daemonInstance(daemon);
  const { proxy, port } = await proxyTo(t, daemon);
  const home = tmpHome(t, 'lost');
  const marker = path.join(home, 'app-marker');
  const sid = uniqueSid('lost');
  proxy.failNextResponse({ method: 'POST', path: '/api/sessions/register' });
  const first = await runCli(['allow-create-v1', '--id', sid, ...appArgs(marker)], cliEnv(daemon, port));
  assert.notEqual(first.code, 0, first.stderr);
  const faults = proxy.faults();
  assert.equal(faults.length, 1, `PRECONDITION: the fault fired on that exact request (${cliSaid(first)})`);
  // 201: the daemon's answer to a FIRST registration (src/routes/session-records.js:446) — the create took effect.
  assert.deepEqual([faults[0].method, faults[0].path, faults[0].status], ['POST', '/api/sessions/register', 201],
    'the daemon accepted the create (its 200 was withheld from the CLI)');
  assert.deepEqual(wire(proxy), [META, REGISTER], 'exactly one register: the uncertain result was not retried; no owner claim');
  const custody = await sessionRecord(daemon, sid);
  assert.ok(custody, 'the record the daemon created is held by the daemon');
  assert.equal(custody.type, 'wrapped');
  assert.equal(occurrences(daemonOut(daemon), registeredLine(sid)), 1);
  assert.equal(fs.existsSync(marker), false, 'no application on an uncertain client result');

  const second = await runCli(['allow-create-v1', '--id', sid, ...appArgs(marker)], cliEnv(daemon, port));
  assert.equal(second.code, 1, second.stderr);
  assert.match(second.stderr, new RegExp(`Session '${sid}' already exists; allow-create-v1 refused it unchanged\\. No application was started\\.`));
  assert.deepEqual(wire(proxy), [META, REGISTER, META, REGISTER], 'the rerun made one meta check and one register, nothing else');
  assert.equal(proxy.faults().length, 1, 'the fault was single-shot');
  assert.equal(fs.existsSync(marker), false, 'zero applications across both invocations');
  const after = await sessionRecord(daemon, sid);
  assert.equal(after.session_epoch, custody.session_epoch, 'no second effect: same instance');
  assert.equal(occurrences(daemonOut(daemon), registeredLine(sid)), 1);
  assert.equal(occurrences(daemonOut(daemon), reregisteredLine(sid)), 0, 'the 409 did not fall through to re-register');
  assert.deepEqual(await daemonInstance(daemon), before);
});

test('1270 process: a rerun after an effect made by another client gets 409 SESSION_EXISTS and starts no app', async t => {
  const daemon = await realDaemon(t);
  const sid = uniqueSid('dup');
  const created = await daemon.registerSession(sid, { command: 'node', create_only: true });
  // 201: a first registration (src/routes/session-records.js:446; test/telesession-capabilities-1215.test.js:121).
  assert.equal(created.status, 201, `PRECONDITION: register answered ${created.status}`);
  const epoch = (await sessionRecord(daemon, sid)).session_epoch;
  const { proxy, port } = await proxyTo(t, daemon);
  const home = tmpHome(t, 'dup');
  const marker = path.join(home, 'app-marker');
  const r = await runCli(['allow-create-v1', '--id', sid, ...appArgs(marker)], cliEnv(daemon, port));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`Session '${sid}' already exists; allow-create-v1 refused it unchanged\\. No application was started\\.`));
  assert.deepEqual(wire(proxy), [META, REGISTER], 'no owner claim, no retry');
  assert.equal(fs.existsSync(marker), false, 'duplicate → zero new apps');
  const after = await sessionRecord(daemon, sid);
  assert.equal(after.session_epoch, epoch, 'record unchanged (no takeover)');
  assert.equal(after.active_clients, 0, 'no owner claim was made');
  assert.equal(occurrences(daemonOut(daemon), reregisteredLine(sid)), 0, 'the create_only register did not fall through to re-register');
});

// Viewer leave with a causal boundary: the close handler's session-list request is withheld at the proxy until the daemon has
// itself dropped the viewer from `clients` (active_clients back to 0); only then is it released. The decision the CLI makes is
// therefore always taken on the post-removal list, and what it does next is read off the wire.
async function viewerLeaves(t, daemon, sid) {
  const viewerPath = await proxyTo(t, daemon);
  const viewer = runCli(['attach', sid], cliEnv(daemon, viewerPath.port), { timeoutMs: 30000 });
  let viewerEnded = null;
  viewer.then(v => { viewerEnded = v; }, e => { viewerEnded = { code: null, signal: null, stderr: e.message }; });
  await waitOrExplain(async () => { const s = await sessionRecord(daemon, sid); return s && s.active_clients >= 1; },
    { timeoutMs: 15000, description: 'PRECONDITION: the viewer really attached' },
    () => (viewerEnded ? `viewer ended: ${cliSaid(viewerEnded)}` : 'viewer still running'));
  assert.ok(viewerPath.proxy.requests().some(r => r.upgrade && r.path === `/api/sessions/${encodeURIComponent(sid)}`), 'PRECONDITION: attach upgrade observed');
  const beforeLeave = viewerPath.proxy.requests().length;
  viewerPath.proxy.holdNextRequest({ method: 'GET', path: '/api/sessions' });
  viewerPath.proxy.dropConnections();
  await waitFor(() => viewerPath.proxy.heldCount() === 1, { timeoutMs: 15000, description: 'the close handler issued its session list' });
  await waitFor(async () => { const s = await sessionRecord(daemon, sid); return s && s.active_clients === 0; },
    { timeoutMs: 15000, description: 'the daemon removed the viewer' });
  viewerPath.proxy.releaseHeldRequests();
  const left = await viewer;
  assert.equal(left.code, 0, left.stderr);
  return wire(viewerPath.proxy).slice(beforeLeave);
}

test('1270 process (pty): create_only only on the first register; owner reconnect re-registers; a viewer leaving a wrapped session whose owner is away sends no DELETE', { skip: PTY_SKIP, timeout: 90000 }, async t => {
  const daemon = await realDaemon(t);
  const before = await daemonInstance(daemon);
  const SID = uniqueSid('pty');
  const marker = path.join(daemon.homeDir, `${SID}.marker`);
  const ownerPath = await proxyTo(t, daemon);    // the bridge's only route to the daemon
  const bridge = pty.spawn(process.execPath, ['cli.js', 'allow-create-v1', '--id', SID, ...appArgs(marker)], {
    cwd: ROOT, cols: 80, rows: 24, name: 'xterm', env: cliEnv(daemon, ownerPath.port) });
  let bridgeExit = null; let bridgeOut = '';
  bridge.onData(d => { bridgeOut += d; });
  bridge.onExit(({ exitCode }) => { bridgeExit = exitCode; });
  t.after(() => { try { bridge.kill(); } catch {} });

  await waitOrExplain(() => fs.existsSync(marker), { timeoutMs: 15000, description: 'the wrapped app to start' },
    () => `bridge exit=${bridgeExit} output=${tail(bridgeOut)}`);
  assert.equal(occurrences(daemonOut(daemon), registeredLine(SID)), 1, 'first register created the record');
  assert.equal(countOf(ownerPath.proxy, REGISTER), 1);
  const epoch = (await sessionRecord(daemon, SID)).session_epoch;

  // Owner connection cut → the normal reconnect flow re-registers. A create_only re-register would be refused 409 and never
  // log a re-registration, so this daemon log line is the observable proof that only the first register carried it.
  ownerPath.proxy.dropConnections();
  await waitFor(() => occurrences(daemonOut(daemon), reregisteredLine(SID)) >= 1, { timeoutMs: 20000, description: 'owner reconnect re-register' });
  await waitFor(async () => { const s = await sessionRecord(daemon, SID); return s && s.disconnectedSeconds === null; },
    { timeoutMs: 20000, description: 'owner reclaimed' });
  assert.equal(countOf(ownerPath.proxy, REGISTER), 2, 'first register + exactly one reconnect register');
  assert.equal(countOf(ownerPath.proxy, META), 1, 'one meta check for the whole bridge life: no ensureDaemonRunning');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'started\n', 'the application was started exactly once (no replay on reconnect)');

  // Owner away and staying away (its route silenced): exactly the window in which a viewer close used to destroy the record.
  ownerPath.proxy.blackhole('both');
  ownerPath.proxy.dropConnections();
  await waitFor(async () => { const s = await sessionRecord(daemon, SID); return s && s.disconnectedSeconds !== null; },
    { timeoutMs: 20000, description: 'daemon sees the owner disconnected' });

  const leaveWire = await viewerLeaves(t, daemon, SID);
  assert.deepEqual(leaveWire, [['GET', '/api/sessions']], 'the viewer listed sessions and sent no DELETE/kill/unregister/purge');
  const kept = await sessionRecord(daemon, SID);
  assert.ok(kept, 'the wrapped record survives the viewer leaving');
  assert.equal(kept.type, 'wrapped');
  assert.equal(kept.session_epoch, epoch, 'same instance: credential custody untouched');
  assert.equal(bridgeExit, null, 'the owner bridge keeps running');
  assert.deepEqual(await daemonInstance(daemon), before, 'one daemon instance throughout: no ensureDaemonRunning start/restart/repair');
});

test('1270 process: control — a viewer leaving a SPAWNED session with no other clients still destroys it (non-wrapped unchanged)', { skip: PTY_SKIP, timeout: 60000 }, async t => {
  const daemon = await realDaemon(t);
  const sid = uniqueSid('spawned');
  const spawned = await daemon.spawnSession(sid);
  assert.equal(spawned.status, 201, `PRECONDITION: spawn answered ${spawned.status}`);
  const leaveWire = await viewerLeaves(t, daemon, sid);
  assert.deepEqual(leaveWire, [['GET', '/api/sessions'], ['DELETE', `/api/sessions/${encodeURIComponent(sid)}`]], 'list, then exactly one DELETE');
  await waitFor(async () => (await sessionRecord(daemon, sid)) === null, { timeoutMs: 15000, description: 'the spawned session destroyed by that DELETE' });
});
