'use strict';
// #1215 pipe200 (v2 of the pipe196 frozen regression, whose exact bytes 397759e3… are kept as a named baseline in the
// author checkpoint): a failing Windows ConPTY INPUT channel must not terminate the daemon. It must also not be
// reported as a successful delivery or as an observed process exit, on ANY first-party write path.
//
// MEASURED (separate, preserved; not reproduced here): Windows B full test:ci run 41295961906. The owner record
// owner-daemon-744-1.json attributes an unhandled EPIPE `write` to the daemon itself (pid 1352). The stream was a Socket
// first written by node-pty WindowsTerminal._doWrite (lib/windowsTerminal.js:123), via the deferred queue (:193) at
// first output (:83/:78). The matching uncaught exception and exit 1 followed.
//
// THIS FILE is a CONTRACT REPRODUCTION, not a native ConPTY crash. It drives the REAL first-party code:
//   - spawn route (src/routes/spawn.js registerSpawnRoute);
//   - HTTP delivery write (src/mailbox/session-delivery.js writeDataToSession);
//   - deferred-CR submit and session health (src/mailbox/delivery-runtime.js submitViaPty, getSessionHealthStatus,
//     getSessionHealthReason);
//   - WebSocket viewer input (src/transport/websocket.js installWebSocketTransport, the pattern of
//     viewer-input-validation.test.js).
// The only stand-in is the PTY: a Windows-shaped terminal whose internal agent input channel `_agent.inSocket` is a
// real, never-connected net.Socket, the same class and the same node-pty internal property as observed. A
// deterministic EPIPE is injected with socket.destroy(err), the same stream destroy(err) → emitErrorCloseNT →
// emit('error') path as the measured crash.
//
// On the unchanged product nothing owns that socket's 'error', so the daemon-equivalent child process dies of the
// uncaught EPIPE after printing `setup_ok` and `injecting`. The first test then fails at its exit assertion. Setup
// errors are told apart by the missing markers. Scenarios run in a child process, so the test process never takes the
// crash.
//
// Changes versus pipe196 (all other pipe196 assertions are kept verbatim in meaning):
//   - the PTY must NOT carry a fabricated `killed` property: a failed input is not an observed exit;
//   - an unsupported shape is refused at spawn (503 PTY_INPUT_UNSUPPORTED, exactly one rollback kill, no session)
//     instead of publishing an unsupervised writable session. That covers an agent without a valid inSocket on every
//     OS, and a missing agent on win32 (pipe196 expected 201 there). Off Windows a terminal without an agent stays
//     'not_applicable' and writable, as before;
//   - deferred CR, WS viewer input and health are checked on the real paths.
const path = require('node:path');

const SCENARIO = '--pty-input-scenario';
const ROOT = path.resolve(__dirname, '..');
const MARK = 'PTYCASE ';

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write', errno: -4047 });
const turns = async (count = 3) => { for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve)); };

// Windows-shaped stand-in for node-pty's WindowsTerminal. Only the shape the first-party code and the measured crash
// touch: pid, write, kill, resize, onData, onExit and the internal `_agent.inSocket` (a real net.Socket that never
// connects, so no OS handle or listener is created).
function fakeWindowsTerminal({ agent = 'socket' } = {}) {
  const net = require('node:net');
  const exitListeners = [];
  const term = {
    pid: 4242, writes: [], kills: 0,
    write(data) { term.writes.push(String(data)); },
    kill() { term.kills++; },
    resize() {},
    onData() { return { dispose() {} }; },
    onExit(listener) { exitListeners.push(listener); return { dispose() {} }; },
    exit(code) { for (const listener of exitListeners.slice()) listener({ exitCode: code, signal: undefined }); },
  };
  if (agent === 'socket') term._agent = { inSocket: new net.Socket() };
  if (agent === 'no-socket') term._agent = {};
  return term;
}

async function scenario(name) {
  const report = (value) => process.stdout.write(`${MARK}${JSON.stringify(value)}\n`);
  // Markers are flushed (write callback) BEFORE an injection, so a crash cannot hide that setup completed.
  const marker = (text) => new Promise((resolve) => process.stdout.write(`${text}\n`, resolve));
  const { EventEmitter } = require('node:events');
  const { registerSpawnRoute } = require(path.join(ROOT, 'src', 'routes', 'spawn.js'));
  const { createSessionDeliveryContext } = require(path.join(ROOT, 'src', 'mailbox', 'session-delivery.js'));
  const { createDeliveryRuntime } = require(path.join(ROOT, 'src', 'mailbox', 'delivery-runtime.js'));
  const { installWebSocketTransport } = require(path.join(ROOT, 'src', 'transport', 'websocket.js'));
  const routes = Object.create(null);
  const sessions = Object.create(null);
  const factories = [];
  const terms = Object.create(null);
  const deps = {
    sessions,
    sessionStateManager: { feed() {}, register() {}, markDead() {}, unregister() {} },
    pty: { spawn: () => factories.shift()() },
    persistSessions: () => ({ ok: true, committed: true }),
    appendToOutputRing() {}, revokeSessionCredential() {}, busClients: new Set(), os: require('node:os'),
    buildSessionEnv: (id) => ({ TELEPTY_SESSION_ID: id }),
    admission: { take: () => ({ allowed: true }) },
  };
  registerSpawnRoute({ post: (route, handler) => { routes[route] = handler; } }, deps);
  const spawnSession = (id, factory) => new Promise((resolve) => {
    factories.push(() => { const term = factory(); terms[id] = term; return term; });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, setHeader() {},
      json(body) { resolve({ status: this.statusCode, body }); return this; } };
    routes['/api/sessions/spawn']({ body: { session_id: id, command: process.execPath, cwd: ROOT }, headers: {}, rawHeaders: [] }, res);
  });
  const delivery = createSessionDeliveryContext({ hasHeldInteraction: () => false, interaction: { invalidateInteraction() {} },
    buildErrorBody: (code, error, extra = {}) => ({ success: false, code, error, ...extra }), sessions });
  const deliver = (id, text) => delivery.writeDataToSession(id, sessions[id], text);
  const runtime = createDeliveryRuntime({ sessions, interaction: { invalidateInteraction() {} }, interactionCore: { isBusy: () => false },
    ledgerClient: null, SESSION_STALE_SECONDS: 300, UPSTREAM_STALL_SECONDS: 120, isOpenWebSocket: () => false, crypto: require('node:crypto') });
  const health = (id) => ({ status: runtime.getSessionHealthStatus(sessions[id]), reason: runtime.getSessionHealthReason(sessions[id], runtime.getSessionHealthStatus(sessions[id])) });
  const transport = installWebSocketTransport({ server: new EventEmitter(), sessions, busClients: new Set(), expectedToken: 'synthetic', verifyJwt: () => false,
    isAllowedPeer: () => true, credentials: { hasCredential: () => false, matches: () => false }, pendingReports: {}, authorizeViewerInject: () => true });
  const viewers = [];
  const viewer = (id) => {
    const ws = new EventEmitter(); ws.readyState = 1; ws.replies = [];
    ws.send = (frame) => ws.replies.push(JSON.parse(frame)); ws.close = () => ws.emit('close'); ws.terminate = ws.close; ws.ping = () => {};
    transport.wss.emit('connection', ws, { url: `/api/sessions/${id}`, headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } });
    viewers.push(ws);
    return { input: (data) => ws.emit('message', JSON.stringify({ type: 'input', data })), replies: ws.replies };
  };
  const closeViewers = () => { for (const ws of viewers) ws.emit('close'); };

  if (name === 'scope') {
    // Control: an error on a stream the PTY input owner does NOT own must stay fatal (no catch-all handler).
    const spawned = await spawnSession('pty-input-scope', () => fakeWindowsTerminal());
    report({ spawned: spawned.status });
    await marker('setup_ok');
    const other = new (require('node:net').Socket)();
    other.destroy(epipe());
    await turns();
    report({ survived_unowned_error: true });
    return;
  }

  const results = {};
  for (const [id, factory] of [['pty-input-a', () => fakeWindowsTerminal()], ['pty-input-b', () => fakeWindowsTerminal()],
    ['pty-input-c', () => fakeWindowsTerminal()], ['pty-input-d', () => fakeWindowsTerminal()], ['pty-input-e', () => fakeWindowsTerminal()],
    ['pty-input-f', () => fakeWindowsTerminal({ agent: 'none' })], ['pty-input-g', () => fakeWindowsTerminal({ agent: 'no-socket' })]]) {
    const spawned = await spawnSession(id, factory);
    results[`spawn_${id}`] = spawned.status;
    results[`spawn_code_${id}`] = spawned.body && spawned.body.code ? spawned.body.code : null;
  }
  const recordA = sessions['pty-input-a'], recordC = sessions['pty-input-c'];
  results.before_a = await deliver('pty-input-a', 'before-a');
  results.health_a_before = health('pty-input-a');
  const viewerA = viewer('pty-input-a'), viewerB = viewer('pty-input-b');
  await marker('setup_ok');
  await marker('injecting');
  terms['pty-input-a']._agent.inSocket.destroy(epipe());               // broken input: the measured class of error
  terms['pty-input-d']._agent.inSocket.destroy(Object.assign(new Error('unexpected'), { code: 'EWEIRD' })); // unexpected code
  terms['pty-input-e']._agent.inSocket.destroy('not-an-error');           // invalid error value
  await turns();
  results.alive_after_injection = true;

  results.a_input = recordA.ptyInput ? { state: recordA.ptyInput.state, failure: recordA.ptyInput.failure } : null;
  results.a_killed_property = Object.hasOwn(terms['pty-input-a'], 'killed');
  results.after_a = await deliver('pty-input-a', 'after-a');                       // HTTP delivery path
  results.cr_a = runtime.submitViaPty(sessions['pty-input-a']);                  // deferred submit path
  viewerA.input('viewer-a');                                                      // WebSocket viewer path
  results.viewer_a_replies = viewerA.replies.filter((frame) => frame.type === 'input_refused');
  results.health_a_after = health('pty-input-a');
  results.a_writes = terms['pty-input-a'].writes;
  results.a_error_listeners_after_close = terms['pty-input-a']._agent.inSocket.listenerCount('error');
  results.b_delivery = await deliver('pty-input-b', 'to-b');
  results.cr_b = runtime.submitViaPty(sessions['pty-input-b']);
  viewerB.input('viewer-b');
  results.viewer_b_refusals = viewerB.replies.filter((frame) => frame.type === 'input_refused').length;
  results.health_b = health('pty-input-b');
  results.b_writes = terms['pty-input-b'].writes;
  results.b_error_listeners = terms['pty-input-b']._agent.inSocket.listenerCount('error');
  results.d_input = sessions['pty-input-d'].ptyInput ? sessions['pty-input-d'].ptyInput.failure : null;
  results.d_delivery = await deliver('pty-input-d', 'to-d');
  results.e_input = sessions['pty-input-e'].ptyInput ? sessions['pty-input-e'].ptyInput.failure : null;
  results.f_present = Object.hasOwn(sessions, 'pty-input-f');
  results.f_input = results.f_present && sessions['pty-input-f'].ptyInput ? sessions['pty-input-f'].ptyInput.state : null;
  results.f_delivery = results.f_present ? await deliver('pty-input-f', 'to-f') : null;
  results.f_kills = terms['pty-input-f'].kills;
  results.g_present = Object.hasOwn(sessions, 'pty-input-g');
  results.g_kills = terms['pty-input-g'].kills;

  // Idempotent exit after a terminal input failure: the first exit removes the record, a repeated exit changes nothing.
  terms['pty-input-a'].exit(0);
  results.a_removed_after_exit = !Object.hasOwn(sessions, 'pty-input-a');
  terms['pty-input-a'].exit(0);
  results.a_second_exit_harmless = !Object.hasOwn(sessions, 'pty-input-a') && Object.hasOwn(sessions, 'pty-input-b');

  // Disposal must not reintroduce an unowned error: session C exits FIRST, then its still-open input socket fails late.
  terms['pty-input-c'].exit(0);
  terms['pty-input-c']._agent.inSocket.destroy(epipe());
  await turns();
  results.c_late_failure = recordC.ptyInput ? recordC.ptyInput.failure : null;
  closeViewers();
  results.alive_at_end = true;
  report(results);
}

if (process.argv[2] === SCENARIO) {
  scenario(process.argv[3]).catch((error) => { process.stderr.write(`scenario setup failed: ${error && error.stack ? error.stack : error}\n`); process.exitCode = 70; });
} else {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const CHILD_MS = 20000, KEEP = 65536;
  function runScenario(name) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [__filename, SCENARIO, name], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', spawnError = null;
      child.stdout.on('data', (chunk) => { if (stdout.length < KEEP) stdout += String(chunk).slice(0, KEEP - stdout.length); });
      child.stderr.on('data', (chunk) => { if (stderr.length < KEEP) stderr += String(chunk).slice(0, KEEP - stderr.length); });
      child.on('error', (error) => { spawnError = error.code || 'spawn_error'; });
      const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_MS);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const lines = stdout.split(/\r?\n/);
        const reports = lines.filter((line) => line.startsWith(MARK)).map((line) => JSON.parse(line.slice(MARK.length)));
        resolve({ code, signal, spawnError, stdout, stderr, reports, setup: lines.includes('setup_ok'), injecting: lines.includes('injecting') });
      });
    });
  }

  test('[contract reproduction] an EPIPE on a spawned session\'s Windows PTY input socket does not terminate the daemon', { timeout: 60000 }, async () => {
    const run = await runScenario('contract');
    assert.equal(run.spawnError, null);
    assert.ok(run.setup && run.injecting, `setup did not complete (not the regression): ${run.stderr.slice(-2000)}`);
    assert.deepEqual([run.code, run.signal], [0, null],
      `the daemon-equivalent process died after the injected PTY input EPIPE (unowned input-socket error): ${run.stderr.slice(-2000)}`);
    const [r] = run.reports;
    assert.ok(r, run.stdout.slice(-2000));
    for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal(r[`spawn_pty-input-${id}`], 201, `spawn ${id}`);
    assert.deepEqual(r.before_a, { success: true });
    assert.deepEqual(r.health_a_before, { status: 'CONNECTED', reason: 'PTY_RUNNING' });
    assert.equal(r.alive_after_injection, true);
    // Expected broken input: owned and truthfully classified; the PTY object is not marked as killed or exited.
    assert.deepEqual(r.a_input, { state: 'closed', failure: { kind: 'input_closed', code: 'EPIPE', syscall: 'write' } });
    assert.equal(r.a_killed_property, false, 'a failed input is not an observed process exit');
    // No falsely successful delivery after the terminal input failure, on every write path; nothing reaches the channel.
    assert.equal(r.after_a.success, false);
    assert.equal(r.after_a.code, 'DISCONNECTED');
    assert.equal(r.after_a.reason, 'pty_input_failed');
    assert.equal(r.cr_a, false);
    assert.equal(r.viewer_a_replies.length, 1);
    assert.equal(r.viewer_a_replies[0].code, 'DISCONNECTED');
    assert.equal(r.viewer_a_replies[0].bytes_written, 0);
    assert.deepEqual(r.health_a_after, { status: 'DISCONNECTED', reason: 'PTY_INPUT_FAILED' });
    assert.deepEqual(r.a_writes, ['before-a']);
    assert.equal(r.a_error_listeners_after_close, 0, 'the owner is disposed only after the socket closed');
    // The unrelated live session is untouched on every path.
    assert.deepEqual(r.b_delivery, { success: true });
    assert.equal(r.cr_b, true);
    assert.equal(r.viewer_b_refusals, 0);
    assert.deepEqual(r.health_b, { status: 'CONNECTED', reason: 'PTY_RUNNING' });
    assert.deepEqual(r.b_writes, ['to-b', '\r', 'viewer-b']);
    assert.equal(r.b_error_listeners, 1);
    // Unexpected and invalid error values are owned too, labelled as such, and fence their session.
    assert.deepEqual(r.d_input, { kind: 'unexpected', code: 'EWEIRD', syscall: null });
    assert.equal(r.d_delivery.code, 'DISCONNECTED');
    assert.deepEqual(r.e_input, { kind: 'invalid', code: null, syscall: null });
    // Unsupported shape: refused deterministically with one rollback kill, never published as an unsupervised session.
    assert.deepEqual([r['spawn_pty-input-g'], r['spawn_code_pty-input-g'], r.g_present, r.g_kills], [503, 'PTY_INPUT_UNSUPPORTED', false, 1]);
    if (process.platform === 'win32') {
      assert.deepEqual([r['spawn_pty-input-f'], r['spawn_code_pty-input-f'], r.f_present, r.f_kills], [503, 'PTY_INPUT_UNSUPPORTED', false, 1]);
    } else {
      assert.equal(r['spawn_pty-input-f'], 201);
      assert.equal(r.f_input, 'not_applicable');
      assert.deepEqual(r.f_delivery, { success: true });
      assert.equal(r.f_kills, 0);
    }
    // Idempotent exit, and an error after exit is still owned.
    assert.equal(r.a_removed_after_exit, true);
    assert.equal(r.a_second_exit_harmless, true);
    assert.deepEqual(r.c_late_failure, { kind: 'input_closed', code: 'EPIPE', syscall: 'write' });
    assert.equal(r.alive_at_end, true);
  });

  test('[control] an error on a stream the PTY input owner does not own stays fatal (no catch-all handler)', { timeout: 60000 }, async () => {
    const run = await runScenario('scope');
    assert.equal(run.spawnError, null);
    assert.ok(run.setup, `setup did not complete: ${run.stderr.slice(-2000)}`);
    assert.deepEqual([run.code, run.signal], [1, null], 'an unowned stream error must still terminate the process');
    assert.match(run.stderr, /EPIPE/);
    assert.equal(run.reports.some((entry) => entry.survived_unowned_error), false);
  });
}
