'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSessionDiagnostics, createDiagnosticsHandler, processPresence } = require('../src/diagnostics/session');
const { createEventLoopTelemetry, slowRequestObserver } = require('../src/diagnostics/event-loop');
const { diagnoseTarget, formatDiagnostics, boundedJson } = require('../src/diagnostics/client');
const iso = n => new Date(n).toISOString();
const identity = { machineId: 'machine', sessionId: 'exact' };
test('busy or quiet does not establish agent health, pipe cause, messaging progress, or completion', () => {
  const now = 100000;
  const inspect = createSessionDiagnostics({ now: () => now, kill: () => {} });
  for (const count of [0, 10000]) {
    const session = Object.freeze({ sessionEpoch: 'epoch', interactionOwnerGeneration: 'owner', ownerWs: Object.freeze({ readyState: 1 }),
      bridgeHeartbeatAt: iso(now - 100), bridgePtyBytes: count, outputRingTotalBytes: count, lastActivityAt: iso(now),
      ptyPid: 123, outputRing: Object.freeze(['SECRET_SCREEN']), credentialVerifier: 'SECRET_TOKEN', stateReport: { prompt: 'SECRET_PROMPT' } });
    const before = JSON.stringify(session), report = inspect(session, identity);
    assert.equal(report.layers.bridge_heartbeat.freshness, 'fresh');
    assert.equal(report.layers.pty.last_actual_output.freshness, 'unknown');
    assert.equal(report.layers.wrapped_process.responsiveness.status, 'unknown');
    assert.equal(report.layers.wrapped_process.scheduler_state.status, 'unknown');
    for (const key of ['request_accepted','input_written','acknowledgement','reply']) assert.equal(report.messaging[key].status, 'unknown');
    assert.deepEqual(report.confirmed_causes, []); assert.equal(report.messaging.completion_fact, null);
    assert.equal(JSON.stringify(session), before); assert.doesNotMatch(JSON.stringify(report), /SECRET/);
    assert.deepEqual(JSON.parse(formatDiagnostics(report).split('\n').slice(1).join('\n')), report);
  }
});
test('freshness and counters are bounded, generation-scoped and distinct from activity', () => {
  let clock = 100000;
  const inspect = createSessionDiagnostics({ now: () => clock, kill: () => {} });
  const session = { sessionEpoch: 'one', interactionOwnerGeneration: 'owner', bridgeHeartbeatAt: iso(clock), bridgePtyBytes: 10,
    outputRingTotalBytes: 20, lastActualOutputAt: iso(clock - 20000), lastActivityAt: iso(clock) };
  const first = inspect(session, identity); assert.equal(first.sample.window_ms, null);
  clock += 1000; session.bridgePtyBytes += 4; session.outputRingTotalBytes += 2;
  const next = inspect(session, identity);
  assert.deepEqual(next.sample.counter_deltas, { bridge_pty_bytes: 4, daemon_output_code_units: 2 });
  assert.equal(next.layers.pty.last_actual_output.freshness, 'stale');
  assert.equal(next.layers.pty.last_activity.freshness, 'fresh');
  clock += 61000;
  const stale = inspect(session, identity); assert.equal(stale.sample.window_ms, null);
  assert.equal(stale.layers.bridge_heartbeat.status, 'stale');
  session.sessionEpoch = 'two'; assert.equal(inspect(session, identity).sample.window_ms, null);
  session.interactionOwnerGeneration = 'new'; assert.equal(inspect(session, identity).sample.window_ms, null);
});
test('exited, inaccessible and potentially stopped processes have precise capability limits', () => {
  for (const [code, status, reason] of [['ESRCH','absent','process_not_found'],['EPERM','unknown','permission_denied']]) {
    assert.deepEqual(processPresence(123, (pid, signal) => { assert.equal(signal, 0); throw Object.assign(Error('private'), { code }); }), { status, source: 'signal_zero', reason });
  }
  assert.equal(processPresence(null).status, 'unknown');
  assert.equal(processPresence(123, () => {}).status, 'exists');
  const report = createSessionDiagnostics({ kill: () => {} })({ ptyPid: 123, bridgeReadSide: 'error', bridgeHeartbeatAt: new Date().toISOString() }, identity);
  assert.equal(report.layers.pty.bridge_read_side, 'error'); assert.equal(report.layers.pty.forwarding.status, 'unknown');
  assert.deepEqual(report.confirmed_causes, []);
});
test('exact route rejects wrong machine, prefix aliases and replaced epoch without mutation', () => {
  const session = Object.freeze({ sessionEpoch: 'epoch', ptyPid: null });
  const sessions = Object.freeze({ exact: session });
  const handler = createDiagnosticsHandler({ sessions, machineId: 'machine', inspect: createSessionDiagnostics(), eventLoop: () => ({ status: 'unknown' }) });
  const call = (id, query) => { let code = 200, body; handler({ params: { id }, query }, { status(v) { code = v; return this; }, json(v) { body = v; } }); return { code, body }; };
  assert.equal(call('exact', {}).code, 409);
  assert.equal(call('exact', { machine_id: 'wrong' }).code, 409);
  assert.equal(call('exa', { machine_id: 'machine' }).code, 404);
  assert.equal(call('exact', { machine_id: 'machine', session_epoch: 'old' }).code, 409);
  const result = call('exact', { machine_id: 'machine', session_epoch: 'epoch' });
  assert.equal(result.code, 200); assert.equal(result.body.identity.session_epoch, 'epoch');
  assert.deepEqual(sessions, { exact: session });
});
test('client routes directly to qualified host, fences identity and distinguishes timeout from401', async () => {
  await assert.rejects(() => diagnoseTarget('same', {}), /exact/);
  const calls = [];
  const fetchWithAuth = async (url, options) => {
    calls.push(url); assert.ok(options.signal);
    return new Response(JSON.stringify(url.includes('/meta') ? { machine_id: 'machine' } : { identity: { machine_id: 'machine', session_id: 'exact', session_epoch: 'epoch' }, messaging: { reply: { status: 'unknown' } } }));
  };
  const report = await diagnoseTarget('exact@remote', { fetchWithAuth, daemonUrl: host => 'http://'+host, machineId: 'machine', sessionEpoch: 'epoch' });
  assert.equal(calls.length, 2); assert.ok(calls.every(url => url.startsWith('http://remote/')));
  assert.match(calls[1], /machine_id=machine&session_epoch=epoch/);
  assert.equal(report.client_probe.agent_responsiveness, 'unknown'); assert.equal(report.messaging.reply.status, 'unknown');
  const refused = await diagnoseTarget('exact@remote', { daemonUrl: () => 'http://remote', fetchWithAuth: async () => new Response('', { status: 401 }) });
  assert.equal(refused.layers.daemon_api.status, 'authentication_refused'); assert.equal(refused.layers.host_network.status, 'http_path_responded');
  const timeout = await diagnoseTarget('exact@remote', { daemonUrl: () => 'http://remote', fetchWithAuth: async () => { throw Object.assign(Error('private'), { name: 'TimeoutError' }); } });
  assert.equal(timeout.layers.daemon_api.status, 'timeout'); assert.equal(timeout.layers.host_network.status, 'unknown');
  const mismatch = await diagnoseTarget('exact@remote', { daemonUrl: () => 'http://remote', fetchWithAuth, machineId: 'different' });
  assert.equal(mismatch.layers.daemon_api.status, 'machine_mismatch');
  await assert.rejects(() => boundedJson(new Response('x'.repeat(33000))), /response_budget/);
});
test('event-loop metrics retain one bounded window and last stall with fake clock/statistics', () => {
  let clock = 10000, callback, enabled = 0, disabled = 0, reset = 0, cancelled = 0;
  const histogram = { count: 3, max: 2e9, percentile: p => p === 50 ? 1e6 : 1.5e9,
    enable() { enabled++; }, disable() { disabled++; }, reset() { reset++; } };
  const telemetry = createEventLoopTelemetry({ histogram, now: () => clock,
    schedule(fn) { callback = fn; return { unref() {} }; }, cancel() { cancelled++; } });
  assert.equal(telemetry.snapshot().status, 'unknown'); telemetry.start(); telemetry.start(); assert.equal(enabled, 1);
  clock += 10000; callback();
  const first = telemetry.snapshot(); assert.equal(first.latest.p50_ms, 1); assert.equal(first.latest.p99_ms, 1500);
  assert.equal(first.last_stall.max_ms, 2000); assert.equal(first.latest.window_ms, 10000);
  histogram.max = 10e6; clock += 10000; callback(); assert.equal(telemetry.snapshot().last_stall.max_ms, 2000);
  clock += 31000; assert.equal(telemetry.snapshot().stale, true);
  histogram.count = 0; callback(); assert.equal(telemetry.snapshot().latest.p50_ms, null);
  assert.equal(reset, 3); telemetry.stop(); assert.equal(disabled, 1); assert.equal(cancelled, 1);
});
test('slow handler attribution omits private request URL, body, headers and target', () => {
  let clock = 0, line, next = 0;
  const observe = slowRequestObserver({ now: () => clock, log: value => { line = value; } });
  const response = new EventEmitter(); response.statusCode = 200;
  observe({ method: 'GET', route: { path: '/api/sessions/:id/diagnostics' }, url: '/SECRET', body: 'SECRET', headers: { token: 'SECRET' } }, response, () => next++);
  clock = 2500; response.emit('finish');
  assert.equal(next, 1); assert.match(line, /2500ms/); assert.doesNotMatch(line, /SECRET/);
});
test('hermetic daemon HTTP diagnostics are authenticated, exact and leave session facts unchanged', async () => {
  const { startTestDaemon } = require('../test-support/daemon-harness');
  const harness = await startTestDaemon();
  try {
    const created = await harness.request('/api/sessions/register', { method: 'POST', body: { session_id: 'diagnostic-fixture', command: 'fixture', cwd: '/tmp' } });
    assert.equal(created.status, 201);
    const meta = await harness.request('/api/meta');
    assert.equal(meta.status, 200); assert.ok(meta.body.event_loop);
    const endpoint = '/api/sessions/diagnostic-fixture/diagnostics?machine_id=' + encodeURIComponent(meta.body.machine_id) + '&session_epoch=' + encodeURIComponent(created.body.session_epoch);
    assert.equal((await harness.request(endpoint, { noAuth: true })).status, 401);
    const before = (await harness.request('/api/sessions/diagnostic-fixture')).body;
    const report = await harness.request(endpoint);
    assert.equal(report.status, 200); assert.equal(report.body.read_only, true);
    assert.equal(report.body.identity.session_epoch, created.body.session_epoch);
    assert.equal(report.body.layers.wrapped_process.responsiveness.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(report.body), /session_token|credentialVerifier|outputRing|prompt_preview/);
    assert.equal((await harness.request('/api/sessions/diagnostic/diagnostics?machine_id=' + encodeURIComponent(meta.body.machine_id))).status, 404);
    const cli = await harness.runCli(['diagnose', 'diagnostic-fixture@127.0.0.1', '--json', '--machine-id', meta.body.machine_id, '--epoch', created.body.session_epoch]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).identity.session_epoch, created.body.session_epoch);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'diagnostics-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp-server/index.mjs'],
      cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...process.env, HOME: harness.homeDir, USERPROFILE: harness.homeDir,
        TELEPTY_HOST: harness.host, TELEPTY_PORT: String(harness.port), TELEPTY_AUTH_TOKEN: harness.authToken() } });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'telepty_diagnose_session', arguments: {
        target: 'diagnostic-fixture@127.0.0.1', machine_id: meta.body.machine_id, session_epoch: created.body.session_epoch } });
      assert.ok(!result.isError);
      const evidence = JSON.parse(result.content[0].text);
      assert.equal(evidence.identity.session_epoch, created.body.session_epoch);
      assert.equal(evidence.messaging.reply.status, 'unknown');
      assert.equal(evidence.mcp_transport.return_path_to_agent, 'unknown');
      const wrong = await client.callTool({ name: 'telepty_diagnose_session', arguments: {
        target: 'diagnostic-fixture@wrong-host', machine_id: meta.body.machine_id } });
      assert.equal(wrong.isError, true);
    } finally { await client.close(); }
    const after = (await harness.request('/api/sessions/diagnostic-fixture')).body;
    for (const key of ['id','createdAt','lastActivityAt','lastConnectedAt','lastDisconnectedAt','ready','active_clients']) assert.deepEqual(after[key], before[key]);
  } finally { await harness.stop(); }
});
