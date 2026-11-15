'use strict';

// Task 1270 — safe boot interface: `telepty boot-capabilities` (sealed, pure local), the versioned `allow-create-v1` verb
// (canonical loopback only, one authenticated /api/meta check, first register create_only:true, NEVER ensureDaemonRunning),
// and non-deleting viewer detach for wrapped sessions on both attach paths. Contract: output/SPEC.md.
//
// Written BEFORE the production change; the coder did not execute it. The tester runs it: RED on 352d2dd (the exports and
// verbs do not exist; attach DELETEs a wrapped record), GREEN on the candidate.
//
// Part 1 (in-process) drives the real production exports of cli.js with injected fetch/writers — no listener, no process.
// Part 2 (process + local fake daemon, CI only) runs the real cli.js against a recording 127.0.0.1 http/ws fake: every request
// the CLI makes is recorded, so "zero requests", "only GET /api/meta", "no DELETE" and "no daemon repair path" are observed on
// the wire, not inferred. Declared fakes: the daemon (http + ws), the wrapped application (a node one-liner that writes a
// marker file), HOME (mkdtemp). No real daemon, provider, model or service is touched.
// This slice cannot prove native identity, custody or full no-kill acceptance.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
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

// ── Part 2: process + local fake daemon (CI only; not executed by the coder) ──────────────────────────────────────────

let WebSocketServer = null;
try { ({ WebSocketServer } = require('ws')); } catch { /* reported as skip below */ }
let pty = null;
try { pty = require('node-pty'); } catch { /* reported as skip below */ }
const PROCESS_SKIP = WebSocketServer ? false : 'ws not installed';
const PTY_SKIP = WebSocketServer && pty && process.platform !== 'win32' ? false : 'requires ws + node-pty on a POSIX host';

// A recording fake daemon. `opts.meta` → /api/meta reply; `opts.register(body, state)` → { status, body } or 'drop';
// `opts.sessions(state)` → GET /api/sessions body. WS upgrades are recorded; owner claims receive owner_token.
async function startFakeDaemon(t, opts = {}) {
  const seen = []; const registers = []; const upgrades = []; const ownerSockets = []; const viewerSockets = [];
  const state = { exists: new Set() };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      seen.push([req.method, url.pathname]);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        const meta = typeof opts.meta === 'function' ? opts.meta() : (opts.meta || { status: 200, body: { version: '0.11.0', capabilities: REQUIRED_CAPS } });
        if (meta === 'hang') return;   // never answers: the CLI's own bound must end it
        res.statusCode = meta.status; res.end(typeof meta.body === 'string' ? meta.body : JSON.stringify(meta.body)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions/register') {
        const body = JSON.parse(raw);
        registers.push(body);
        const r = opts.register ? opts.register(body, state) : (() => {
          if (body.create_only === true && state.exists.has(body.session_id)) {
            return { status: 409, body: { success: false, code: 'SESSION_EXISTS', error: 'Session already exists; create_only refused it unchanged.', session_id: body.session_id } };
          }
          state.exists.add(body.session_id);
          return { status: 200, body: { success: true, session_id: body.session_id } };
        })();
        if (r === 'drop') { req.socket.destroy(); return; }
        res.statusCode = r.status; res.end(JSON.stringify(r.body)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        res.statusCode = 200; res.end(JSON.stringify(opts.sessions ? opts.sessions(state) : [])); return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not in fake' }));
    });
  });
  const wss = WebSocketServer ? new WebSocketServer({ noServer: true }) : null;
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const owner = url.searchParams.get('owner') === '1';
    upgrades.push({ path: url.pathname, owner });
    wss.handleUpgrade(req, socket, head, ws => {
      if (owner) { ownerSockets.push(ws); ws.send(JSON.stringify({ type: 'owner_token', token: `owner-${ownerSockets.length}` })); }
      else { viewerSockets.push(ws); if (opts.onViewer) opts.onViewer(ws); }
      ws.on('error', () => {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const ws of [...ownerSockets, ...viewerSockets]) { try { ws.terminate(); } catch {} }
    if (wss) wss.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, seen, registers, upgrades, ownerSockets, viewerSockets, state };
}

function tmpHome(t, tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `telepty-1270-${tag}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function cliEnv(home, port, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TELEPTY_AUTH_TOKEN: 'private-fixture-token-1270',
    TELEPTY_PORT: String(port), NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', ...extra };
  for (const k of ['TELEPTY_HOST', 'TELEPTY_SESSION_ID', 'TELEPTY_SESSION_TOKEN', 'TELEPTY_PRINCIPAL_CLIENT_FILE', 'TELEPTY_SUPERVISION_CLIENT_FILE',
    'TELEPTY_HANDOFF_CREDENTIAL_FILE', 'TELEPTY_SESSION_CREDENTIAL_REFRESH', 'TELEPTY_COOPERATIVE_HANDOFF']) if (!(k in extra)) delete env[k];
  return env;
}
function runCli(argv, env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', './test-support/setup-env.js', 'cli.js', ...argv], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const started = Date.now();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`cli ${argv[0]} did not exit within ${timeoutMs} ms`)); }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, ms: Date.now() - started }); });
  });
}
function appArgs(marker) {
  return [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'started\\n'); setInterval(() => {}, 1000);`];
}
async function waitFor(fn, { timeoutMs = 10000, description = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${description}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
const FORBIDDEN_DAEMON_MANAGEMENT = ['/api/health', '/api/daemon/stop', '/api/daemon/graceful-stop', '/api/shutdown'];
function assertNoDaemonManagement(seen) {
  for (const [method, p] of seen) {
    assert.ok(!FORBIDDEN_DAEMON_MANAGEMENT.includes(p) && !p.includes('stop') && !p.includes('restart') && !p.includes('purge'),
      `no daemon repair/stop/purge request: ${method} ${p}`);
    assert.notEqual(method, 'DELETE', `no DELETE: ${p}`);
  }
}

test('1270 process: `telepty boot-capabilities` prints the sealed line, exit 0, zero requests, no HOME writes', { skip: PROCESS_SKIP }, async t => {
  const daemon = await startFakeDaemon(t);
  const home = tmpHome(t, 'caps');
  const r = await runCli(['boot-capabilities'], cliEnv(home, daemon.port));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${SEALED_LINE}\n`);
  assert.equal(cli.parseBootCapabilities(r.stdout, r.code).supported, true);
  assert.deepEqual(daemon.seen, []);
  assert.deepEqual(daemon.upgrades, []);
  assert.deepEqual(fs.readdirSync(home), [], 'no config, credential or state file created');
  const bad = await runCli(['boot-capabilities', '--json'], cliEnv(home, daemon.port));
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, '');
  assert.equal(cli.parseBootCapabilities(bad.stdout, bad.code).supported, false);
});

test('1270 process: an unknown verb answers with help + exit 0 (the old-CLI shape) and the validator calls it unsupported', { skip: PROCESS_SKIP }, async t => {
  const daemon = await startFakeDaemon(t);
  const home = tmpHome(t, 'oldhelp');
  // This is exactly what a pre-1270 CLI does for `telepty boot-capabilities`: fall through main() to the global help.
  const r = await runCli(['boot-capabilities-unknown-1270'], cliEnv(home, daemon.port));
  assert.equal(r.code, 0, 'PRECONDITION: the help fallthrough exits 0 — the hazard the discriminator exists for');
  assert.match(r.stdout, /Session Management/);
  assert.equal(cli.parseBootCapabilities(r.stdout, r.code).supported, false);
});

test('1270 process: allow-create-v1 refuses a non-canonical / remote TELEPTY_HOST with zero requests and no app', { skip: PROCESS_SKIP }, async t => {
  const daemon = await startFakeDaemon(t);
  const home = tmpHome(t, 'remote');
  const marker = path.join(home, 'app-marker');
  for (const host of [`localhost:${daemon.port}`, `[::1]:${daemon.port}`, '192.0.2.1', `http://192.0.2.1:${daemon.port}`, '100.64.0.1']) {
    const r = await runCli(['allow-create-v1', '--id', 'remote-1270', ...appArgs(marker)], cliEnv(home, daemon.port, { TELEPTY_HOST: host }));
    assert.equal(r.code, 1, `${host}: ${r.stderr}`);
    assert.match(r.stderr, /allow-create-v1 refuses non-canonical daemon host/);
    assert.ok(r.ms < 5000, `${host}: refused before any network wait (${r.ms} ms)`);
  }
  assert.deepEqual(daemon.seen, [], 'zero requests (the localhost spelling would have reached this listener)');
  assert.equal(fs.existsSync(marker), false, 'no application started');
});

for (const [label, meta] of [
  ['missing register-create-only', { status: 200, body: { version: '0.10.0', capabilities: ['sessions', 'wrapped-sessions'] } }],
  ['missing wrapped-sessions', { status: 200, body: { version: '0.10.0', capabilities: ['register-create-only'] } }],
  ['no capabilities (old daemon)', { status: 200, body: { version: '0.9.2' } }],
  ['401 credential refusal', { status: 401, body: { error: 'Unauthorized' } }],
  ['non-JSON meta', { status: 200, body: '<html></html>' }],
  ['meta never answers (timeout)', 'hang'],
]) {
  test(`1270 process: allow-create-v1 with ${label} → exit 1, only GET /api/meta, no register, no app, no daemon repair`, { skip: PROCESS_SKIP }, async t => {
    const daemon = await startFakeDaemon(t, { meta: () => meta });
    const home = tmpHome(t, 'meta');
    const marker = path.join(home, 'app-marker');
    const r = await runCli(['allow-create-v1', '--id', 'meta-1270', ...appArgs(marker)], cliEnv(home, daemon.port));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /allow-create-v1 requires a running local daemon advertising wrapped-sessions and register-create-only/);
    assert.deepEqual(daemon.seen, [['GET', '/api/meta']],
      'exactly one meta request — no ensureDaemonRunning re-probe, start, restart or register');
    assert.deepEqual(daemon.registers, []);
    assert.deepEqual(daemon.upgrades, []);
    assert.equal(fs.existsSync(marker), false, 'no application started');
    if (meta === 'hang') assert.ok(r.ms < 8000, `bounded meta wait (${r.ms} ms)`);
  });
}

test('1270 process: a lost first-register result is not replayed; the rerun gets 409 SESSION_EXISTS and starts no app', { skip: PROCESS_SKIP }, async t => {
  let calls = 0;
  const daemon = await startFakeDaemon(t, {
    register: (body, state) => {
      calls++;
      if (body.create_only === true && state.exists.has(body.session_id)) {
        return { status: 409, body: { success: false, code: 'SESSION_EXISTS', error: 'Session already exists; create_only refused it unchanged.', session_id: body.session_id } };
      }
      state.exists.add(body.session_id);   // the effect happened …
      return calls === 1 ? 'drop' : { status: 200, body: { success: true } };   // … but the first result is lost
    }
  });
  const home = tmpHome(t, 'lost');
  const marker = path.join(home, 'app-marker');
  const first = await runCli(['allow-create-v1', '--id', 'lost-1270', ...appArgs(marker)], cliEnv(home, daemon.port));
  assert.notEqual(first.code, 0, first.stderr);
  assert.equal(daemon.registers.length, 1, 'the uncertain register is not retried');
  assert.equal(fs.existsSync(marker), false, 'no app after an uncertain register');

  const second = await runCli(['allow-create-v1', '--id', 'lost-1270', ...appArgs(marker)], cliEnv(home, daemon.port));
  assert.equal(second.code, 1, second.stderr);
  assert.match(second.stderr, /Session 'lost-1270' already exists; allow-create-v1 refused it unchanged\. No application was started\./);
  assert.equal(fs.existsSync(marker), false, 'duplicate → zero new apps');
  assert.equal(daemon.registers.length, 2);
  for (const body of daemon.registers) {
    assert.equal(body.create_only, true);
    assert.equal(body.session_id, 'lost-1270');
  }
  assert.deepEqual(daemon.seen, [['GET', '/api/meta'], ['POST', '/api/sessions/register'], ['GET', '/api/meta'], ['POST', '/api/sessions/register']]);
  assert.deepEqual(daemon.upgrades, [], 'no owner claim, no takeover');
});

test('1270 process (pty): create_only only on the first register; owner reconnect re-registers without it; viewer close on the wrapped record sends zero DELETE', { skip: PTY_SKIP, timeout: 60000 }, async t => {
  const SID = 'boot-1270';
  const CONTROL = 'spawned-1270';
  const daemon = await startFakeDaemon(t, {
    // The reconnecting owner is not counted: active_clients 0 is exactly the case that used to destroy the record.
    sessions: () => [
      { id: SID, type: 'wrapped', command: 'node', active_clients: 0 },
      { id: CONTROL, type: 'spawned', command: 'bash', active_clients: 0 }
    ],
    onViewer: ws => setTimeout(() => { try { ws.close(1000, 'viewer done'); } catch {} }, 300)
  });
  const home = tmpHome(t, 'pty');
  const marker = path.join(home, 'app-marker');
  const bridge = pty.spawn(process.execPath, ['--require', './test-support/setup-env.js', 'cli.js', 'allow-create-v1', '--id', SID, ...appArgs(marker)], {
    cwd: ROOT, cols: 80, rows: 24, name: 'xterm', env: cliEnv(home, daemon.port) });
  let bridgeExit = null; let bridgeOut = '';
  bridge.onData(d => { bridgeOut += d; });
  bridge.onExit(({ exitCode }) => { bridgeExit = exitCode; });
  t.after(() => { try { bridge.kill(); } catch {} });

  await waitFor(() => fs.existsSync(marker), { timeoutMs: 15000, description: `the wrapped app to start (bridge output: ${JSON.stringify(bridgeOut.slice(-400))})` });
  assert.equal(daemon.registers.length, 1);
  assert.equal(daemon.registers[0].create_only, true, 'first register is create-only');
  assert.equal(daemon.ownerSockets.length, 1);

  // Owner WS drop (1006, as on a daemon blip) → the normal reconnect flow re-registers WITHOUT create_only and reclaims.
  daemon.ownerSockets[0].terminate();
  await waitFor(() => daemon.ownerSockets.length >= 2, { timeoutMs: 15000, description: 'owner reconnect' });
  assert.ok(daemon.registers.length >= 2);
  for (const body of daemon.registers.slice(1)) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'create_only'), false, 'reconnect register never repeats create_only');
    assert.equal(body.session_id, SID);
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), 'started\n', 'the application was started exactly once (no replay on reconnect)');

  // A viewer attaches to the wrapped session and leaves while active_clients is 0 → no DELETE, owner untouched.
  const viewer = await runCli(['attach', SID], cliEnv(home, daemon.port), { timeoutMs: 15000 });
  assert.equal(viewer.code, 0, viewer.stderr);
  assert.ok(daemon.upgrades.some(u => !u.owner && u.path === `/api/sessions/${SID}`), 'PRECONDITION: the viewer really attached');
  assert.equal(bridgeExit, null, 'the owner bridge keeps running');
  const deletes = daemon.seen.filter(([m]) => m === 'DELETE');
  assert.deepEqual(deletes, [], 'zero DELETE (no kill/unregister/purge of the wrapped record, credential custody or mailbox)');
  assertNoDaemonManagement(daemon.seen);
  assert.equal(daemon.seen.filter(([m, p]) => m === 'GET' && p === '/api/meta').length, 1, 'one meta check, no ensureDaemonRunning re-probe');

  // Control (non-wrapped semantics unchanged): the same viewer close on a spawned record with no clients still destroys it.
  const control = await runCli(['attach', CONTROL], cliEnv(home, daemon.port), { timeoutMs: 15000 });
  assert.equal(control.code, 0, control.stderr);
  assert.deepEqual(daemon.seen.filter(([m]) => m === 'DELETE'), [['DELETE', `/api/sessions/${CONTROL}`]]);
});
