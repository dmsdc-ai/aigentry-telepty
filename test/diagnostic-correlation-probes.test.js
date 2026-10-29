'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { correlateRequest } = require('../src/diagnostics/correlation');
const { processState } = require('../src/diagnostics/process-state');
const { probeTcp } = require('../src/diagnostics/tcp-probe');
const { createDiagnosticsHandler, createSessionDiagnostics } = require('../src/diagnostics/session');
const { diagnoseTarget } = require('../src/diagnostics/client');
const ID = '12345678-1234-4234-8234-123456789abc';
const at = 100000, options = { injectId: ID, sessionId: 'exact', sessionEpoch: 'epoch', ownerGeneration: 'owner', now: at };
function record() { return { inject_id: ID, session_id: 'exact', session_epoch: 'epoch', owner_generation: 'owner',
  created_at: new Date(at - 2000).toISOString(), tracking_state: 'tracked', prompt: 'SECRET_PROMPT',
  observations: [{ kind: 'tracking_started', at: new Date(at - 2000).toISOString() },
    { kind: 'idle_unconfirmed', at: new Date(at - 1000).toISOString(), consumption_status: 'observed', error_detail: 'SECRET_DETAIL' }] }; }
test('request ledger correlation separates acceptance/consumption from write/ack/reply/completion and is read-only', () => {
  const row = record(), before = JSON.stringify(row), result = correlateRequest(row, options);
  assert.equal(result.request_accepted.status, 'observed'); assert.equal(result.consumption.status, 'observed');
  for (const key of ['input_written','acknowledgement','reply']) assert.equal(result[key].status, 'unknown');
  assert.equal(result.completion_fact, null); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(JSON.stringify(row), before); assert.deepEqual(correlateRequest(row, options), result);
  row.observations.push({ kind: 'inject_delivery_refused', bytes_written: 0, at: new Date(at).toISOString() });
  const refused = correlateRequest(row, options); assert.equal(refused.rejection.status, 'rejected'); assert.equal(refused.input_written.status, 'not_written');
});
test('wrong inject ID/session/epoch/owner fail closed; old snapshots and legacy binding stay explicit', () => {
  for (const [changes, code] of [[{ inject_id: 'other' },'INJECT_TARGET_MISMATCH'],[{ session_id: 'same@other' },'INJECT_TARGET_MISMATCH'],
    [{ session_epoch: 'old' },'INJECT_EPOCH_MISMATCH'],[{ owner_generation: 'old' },'INJECT_OWNER_MISMATCH']]) {
    assert.throws(() => correlateRequest({ ...record(), ...changes }, options), error => error.code === code);
  }
  assert.throws(() => correlateRequest(null, options), error => error.code === 'INJECT_NOT_OBSERVED');
  const legacy = record(); delete legacy.owner_generation;
  assert.equal(correlateRequest(legacy, options).consumption.status, 'unknown');
  const stale = correlateRequest(record(), { ...options, now: at + 70000 });
  assert.equal(stale.request_accepted.freshness, 'historical');
});
test('exact API correlation rejects mismatches before inspecting/mutating session', () => {
  const session = Object.freeze({ sessionEpoch: 'epoch', interactionOwnerGeneration: 'owner' }); let reads = 0;
  const handler = createDiagnosticsHandler({ machineId: 'machine', sessions: { exact: session }, inspect: createSessionDiagnostics(),
    readTracked: id => { reads++; assert.equal(id, ID); return record(); } });
  const call = query => { let status = 200, body; handler({ params: { id: 'exact' }, query }, { status(value) { status = value; return this; }, json(value) { body = value; } }); return { status, body }; };
  assert.equal(call({ machine_id: 'wrong', inject_id: ID }).status, 409); assert.equal(reads, 0);
  assert.equal(call({ machine_id: 'machine', inject_id: '__proto__' }).status, 400); assert.equal(reads, 0);
  const first = call({ machine_id: 'machine', inject_id: ID }); assert.equal(first.status, 200); assert.equal(first.body.messaging.inject_id, ID);
  assert.equal(call({ machine_id: 'machine', inject_id: ID }).body.messaging.request_accepted.status, 'observed');
  assert.equal(session.sessionEpoch, 'epoch'); assert.equal(reads, 2);
});
test('bounded Linux process state supports stopped/zombie and permission/unsupported limits without responsiveness claims', () => {
  for (const [state, expected] of [['R','running'],['S','sleeping'],['T','stopped'],['Z','zombie']]) {
    const result = processState(42, { platform: 'linux', read: path => { assert.equal(path, '/proc/42/stat'); return `42 (private ) name) ${state} 1 2 3`; }, now: () => at });
    assert.equal(result.state, expected); assert.doesNotMatch(JSON.stringify(result), /private/); assert.match(result.reason, /does_not_establish/);
  }
  assert.equal(processState(42, { platform: 'linux', read: () => { throw Object.assign(Error(), { code: 'EACCES' }); } }).reason, 'permission_denied');
  assert.equal(processState(42, { platform: 'win32' }).status, 'unknown');
  assert.equal(processState(42, { platform: 'linux', read: () => '한'.repeat(2000) }).reason, 'process_stat_budget_exceeded');
});
test('bounded TCP probe has one exact connection, no writes, DNS cancel and timeout cleanup', async () => {
  let socket, optionsSeen, writes = 0, destroyed = 0, timer, cancelled = 0;
  const common = { now: () => at, monotonic: () => 1, setTimer: callback => { timer = callback; return 1; }, clearTimer() {},
    connect: options => { optionsSeen = options; socket = new EventEmitter(); socket.write = () => writes++; socket.destroy = () => destroyed++; return socket; } };
  const pending = probeTcp('http://127.0.0.1:4321', common); socket.emit('connect');
  const result = await pending; assert.equal(result.status, 'connected'); assert.deepEqual(optionsSeen, { host: '127.0.0.1', port: 4321, family: 4 });
  assert.equal(writes, 0); assert.equal(destroyed, 1);
  const waiting = probeTcp('http://fixture.invalid:4321', { ...common, resolver: () => ({ resolve4() {}, cancel() { cancelled++; } }) });
  timer(); assert.equal((await waiting).phase, 'dns'); assert.equal(cancelled, 1);
});
test('CLI/MCP shared client passes exact correlation/probe options with bounded evidence and request count', async () => {
  const calls = [], probeCalls = [];
  const report = await diagnoseTarget('exact@peer.invalid', { includeTcp: true, includeProcessState: true, injectId: ID,
    daemonUrl: () => 'http://peer.invalid:4321', tcpProbe: async (...args) => { probeCalls.push(args); return { status: 'timeout', phase: 'tcp_connect' }; },
    fetchWithAuth: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(url.endsWith('/api/meta') ? { machine_id: 'machine' }
      : { identity: { machine_id: 'machine', session_id: 'exact', session_epoch: 'epoch' }, messaging: { inject_id: ID, reply: { status: 'unknown' } } })); } });
  assert.equal(calls.length, 2); assert.equal(probeCalls.length, 1); assert.equal(probeCalls[0][1].timeoutMs, 1000);
  assert.ok(calls.every(call => call.options.readOnlyAuth)); assert.match(calls[1].url, /inject_id=.*&process_state=1/);
  assert.equal(report.network_probe.status, 'timeout'); assert.equal(report.messaging.reply.status, 'unknown');
});
test('real HTTP/CLI/MCP correlate same request without replaying input; TCP probe sends no session data', { timeout: 15000 }, async () => {
  const { startTestDaemon } = require('../test-support/daemon-harness');
  const harness = await startTestDaemon(); let owner;
  try {
    const created = await harness.registerSession('diagnostic-correlation', { command: 'fixture' }); assert.equal(created.status, 201);
    const WebSocket = require('ws');
    owner = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/diagnostic-correlation?owner=1`, { headers: { ...harness.ownerAuth('diagnostic-correlation').headers, 'x-telepty-token': harness.authToken() } });
    await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
    let inputFrames = 0; owner.on('message', raw => { if (JSON.parse(raw).type === 'inject') inputFrames++; });
    owner.send(JSON.stringify({ type: 'ready' }));
    const injected = await harness.request('/api/sessions/diagnostic-correlation/inject', { method: 'POST', body: {
      from: 'orchestrator', prompt: 'PRIVATE_FIXTURE_INPUT', no_enter: true, exact_target: true } });
    assert.equal(injected.status, 200, JSON.stringify(injected.body));
    const injectId = injected.body.inject_id; assert.ok(injectId);
    await harness.waitFor(() => inputFrames > 0);
    const ledgerPath = require('../src/session-store/persistence').defaultTrackedInjectionsPath(harness.homeDir);
    const ledgerBefore = require('node:fs').readFileSync(ledgerPath);
    const initialFrames = inputFrames, meta = (await harness.request('/api/meta')).body;
    const query = new URLSearchParams({ machine_id: meta.machine_id, inject_id: injectId, session_epoch: created.body.session_epoch, process_state: '1' });
    const first = await harness.request('/api/sessions/diagnostic-correlation/diagnostics?' + query);
    assert.equal(first.status, 200); assert.equal(first.body.messaging.correlation, 'exact_instance_and_owner');
    assert.equal(first.body.messaging.request_accepted.status, 'observed'); assert.equal(first.body.messaging.reply.status, 'unknown');
    const cli = await harness.runCli(['diagnose','diagnostic-correlation@127.0.0.1','--json','--inject-id',injectId,'--tcp','--process-state']);
    assert.equal(cli.code, 0, cli.stderr); const cliReport = JSON.parse(cli.stdout);
    assert.equal(cliReport.messaging.inject_id, injectId); assert.equal(cliReport.network_probe.status, 'connected');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'diagnostic-correlation-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp-server/index.mjs'], cwd: require('node:path').resolve(__dirname, '..'),
      env: { ...process.env, HOME: harness.homeDir, USERPROFILE: harness.homeDir, TELEPTY_HOST: harness.host, TELEPTY_PORT: String(harness.port), TELEPTY_AUTH_TOKEN: harness.authToken() } });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'telepty_diagnose_session', arguments: {
        target: 'diagnostic-correlation@127.0.0.1', machine_id: meta.machine_id, inject_id: injectId, tcp_probe: true, process_state: true } });
      assert.ok(!result.isError); const report = JSON.parse(result.content[0].text);
      assert.equal(report.messaging.inject_id, injectId); assert.equal(report.network_probe.status, 'connected');
      assert.equal(report.messaging.reply.status, 'unknown'); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FIXTURE_INPUT/);
    } finally { await client.close(); }
    const again = await harness.request('/api/sessions/diagnostic-correlation/diagnostics?' + query);
    assert.equal(again.body.messaging.inject_id, injectId); assert.equal(inputFrames, initialFrames);
    assert.deepEqual(require('node:fs').readFileSync(ledgerPath), ledgerBefore);
    await harness.registerSession('other-diagnostic-correlation', { command: 'fixture' });
    assert.equal((await harness.request('/api/sessions/other-diagnostic-correlation/diagnostics?' + query)).status, 409);
  } finally { owner?.close(); await harness.stop(); }
});
