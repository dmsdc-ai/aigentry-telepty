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
test('#1207 an unavailable authoritative read is 503 CORRELATION_UNAVAILABLE and an unhealthy ledger is 503 OBSERVATION_LEDGER_UNAVAILABLE — never a 404 or a correlation', async () => {
  const session = Object.freeze({ sessionEpoch: 'epoch', interactionOwnerGeneration: 'owner' });
  const run = async (opts) => { let reads = 0, inspected = 0, status = 200, body;
    const handler = createDiagnosticsHandler({ machineId: 'machine', sessions: { exact: session }, inspect: () => { inspected++; return {}; },
      ...opts, readTracked: id => { reads++; return opts.readTracked(id); } });
    await handler({ params: { id: 'exact' }, query: { machine_id: 'machine', inject_id: ID } }, { status(value) { status = value; return this; }, json(value) { body = value; } });
    return { status, body, reads, inspected }; };
  // the shape daemon.js readTracked rejects with for every non-miss reason (recovering, cold_offline, a failed read)
  const named = await run({ readTracked: async () => { throw Object.assign(new Error('tracked-injection read unavailable'), { status: 503, code: 'CORRELATION_UNAVAILABLE' }); } });
  assert.deepEqual([named.status, named.body, named.reads, named.inspected], [503, { code: 'CORRELATION_UNAVAILABLE' }, 1, 0]);
  const plain = await run({ readTracked: async () => { throw new Error('owner_failed'); } });
  assert.deepEqual([plain.status, plain.body, plain.inspected], [503, { code: 'CORRELATION_UNAVAILABLE' }, 0]);
  const unhealthy = await run({ ledgerAvailable: () => false, readTracked: () => { throw new Error('must not be read'); } });
  assert.deepEqual([unhealthy.status, unhealthy.body, unhealthy.reads, unhealthy.inspected], [503, { code: 'OBSERVATION_LEDGER_UNAVAILABLE' }, 0, 0]);
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
// #1215 diagnostics12 (diagnostics only; built ONLY when the :103 inject assertion is already failing, appended to its
// message). Windows diagnostic run 41229418760 answered 503 DELIVERY_UNCERTAIN "after enqueue" here with no daemon output.
// Bounded: <=8 daemon log lines naming this sid (<=300 chars each); this fixture's mailbox evidence only — the resolved
// root must lie inside THIS harness's owned HOME, otherwise a fixed outside_fixture marker and nothing is read. Inbox:
// a newline COUNT over raw bytes (never decoded, parsed or serialized). State: whitelisted fields of the last 8 rows
// (no msg_id). Lock: entry counts and known ticket-entry names only. Override/private-root are booleans; no path or value.
function correlationInjectDiag(harness, sid, inputFrames) {
  const fsx = require('node:fs'), pathx = require('node:path');
  const cap = (l) => String(l).slice(0, 300);
  const { stdout, stderr } = harness.getLogs();
  const log = `${stdout}\n${stderr}`.split(/\r?\n/).filter((l) => l.includes(sid)).slice(-8).map(cap);
  const override = typeof process.env.AIGENTRY_MAILBOX_DIR === 'string' && process.env.AIGENTRY_MAILBOX_DIR !== '';
  let mailbox;
  try {
    const home = fsx.realpathSync(harness.homeDir);
    const configured = pathx.resolve(override ? process.env.AIGENTRY_MAILBOX_DIR : pathx.join(harness.homeDir, '.aigentry', 'mailbox'));
    let root = configured; try { root = fsx.realpathSync(configured); } catch { /* absent root: compared as resolved */ }
    const rel = pathx.relative(home, root);
    const privateRoot = rel !== '' && !rel.startsWith('..') && !pathx.isAbsolute(rel);
    if (!privateRoot) mailbox = { override, private_root: false, outside_fixture: true };
    else {
      const dirOf = (p) => { try { const st = fsx.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
      const sessionDir = pathx.join(root, sid);
      mailbox = { override, private_root: true, session_dir: dirOf(sessionDir) };
      if (mailbox.session_dir) {
        // #1215 correction41 (review25): every file read goes through one owned-file gate. lstat must be a regular non-symlink
        // file; it is opened read-only with O_NOFOLLOW (and O_NONBLOCK) where fs.constants defines them; fstat must be the same
        // regular file (dev/ino) or nothing is read; the descriptor is closed on every path. Where O_NOFOLLOW is undefined
        // (win32) the open itself may traverse a link swapped in after the lstat; the identity check then refuses to read it.
        // This is detection at this boundary, not race-free OS confinement; there is no path-based fallback read.
        const OPEN_FLAGS = fsx.constants.O_RDONLY | (fsx.constants.O_NOFOLLOW || 0) | (fsx.constants.O_NONBLOCK || 0);
        const withOwnedFile = (file, use) => {
          const st = fsx.lstatSync(file);
          if (!st.isFile() || st.isSymbolicLink()) return { file: false };
          const fd = fsx.openSync(file, OPEN_FLAGS);
          try {
            const opened = fsx.fstatSync(fd);
            if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) return { identity_changed: true };
            return use(fd, opened);
          } finally { fsx.closeSync(fd); }
        };
        let inbox;
        try {
          inbox = withOwnedFile(pathx.join(sessionDir, 'inbox.jsonl'), (fd, opened) => {
            const buf = Buffer.alloc(65536); let rows = 0, seen = 0, n;
            while (seen < 1048576 && (n = fsx.readSync(fd, buf, 0, buf.length, seen)) > 0) { for (let i = 0; i < n; i++) if (buf[i] === 10) rows++; seen += n; }
            return { rows, bytes: opened.size, partial: opened.size > seen };
          });
        } catch (e) { inbox = { error: e.code || 'read_failed' }; }
        let state;
        try {
          const keep = ['state', 'non_retryable_attempt', 'delivery_uncertain', 'outcome', 'retryable', 'never_attempted'];
          state = withOwnedFile(pathx.join(sessionDir, 'state.jsonl'), (fd, opened) => {
            // Bounded tail: only the last <=65536 bytes are read, positionally through the fd.
            const start = Math.max(0, opened.size - 65536), buf = Buffer.alloc(opened.size - start); let got = 0, n;
            while (got < buf.length && (n = fsx.readSync(fd, buf, got, buf.length - got, start + got)) > 0) got += n;
            let text = buf.subarray(0, got).toString('utf8');
            // A tail that does not start at byte 0 begins mid-row: that partial first line is omitted, never parsed as a row.
            if (start > 0) { const nl = text.indexOf('\n'); text = nl < 0 ? '' : text.slice(nl + 1); }
            return text.split('\n').filter(Boolean).slice(-8).map((l) => {
              try { const r = JSON.parse(l), out = {}; for (const k of keep) if (typeof r[k] === 'string' || typeof r[k] === 'boolean') out[k] = typeof r[k] === 'string' ? r[k].slice(0, 40) : r[k]; return out; }
              catch { return { unparsed: true }; }
            });
          });
        } catch (e) { state = { error: e.code || 'read_failed' }; }
        let lock;
        try {
          const lockDir = pathx.join(sessionDir, '.lock');
          if (!dirOf(lockDir)) lock = { dir: false };
          else {
            const names = fsx.readdirSync(lockDir);
            lock = { entries: names.length, tickets: names.slice(0, 16).map((name) => {
              try {
                // lstat before listing: a non-directory or symlinked ticket entry is reported, never listed or followed.
                const entry = fsx.lstatSync(pathx.join(lockDir, name)); // an lstat error is reported by the catch below
                if (!entry.isDirectory() || entry.isSymbolicLink()) return { not_directory: true };
                const inner = fsx.readdirSync(pathx.join(lockDir, name));
                return { known: inner.filter((x) => ['draft', 'number', 'departed'].includes(x)).sort(), unknown: inner.filter((x) => !['draft', 'number', 'departed'].includes(x)).length };
              } catch (e) { return { error: e.code || 'readdir_failed' }; }
            }) };
          }
        } catch (e) { lock = { error: e.code || 'readdir_failed' }; }
        Object.assign(mailbox, { inbox, state, lock });
      }
    }
  } catch (e) { mailbox = { override, error: e.code || 'inspect_failed' }; }
  return ` | [telepty-diag] correlation_inject ${JSON.stringify({ log, mailbox, owner_input_frames: inputFrames })}`;
}
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
    assert.equal(injected.status, 200, injected.status === 200 ? '' : `${JSON.stringify(injected.body)}${correlationInjectDiag(harness, 'diagnostic-correlation', inputFrames)}`);
    const injectId = injected.body.inject_id; assert.ok(injectId);
    await harness.waitFor(() => inputFrames > 0);
    // #1207 — the ledger path is the directory store: snapshot every file of it (MANIFEST, segments, tiers).
    const { shaTree } = require('./fixtures/ledger-1207/owner-harness');
    const ledgerPath = require('../src/session-store/persistence').defaultTrackedInjectionsPath(harness.homeDir);
    const ledgerBefore = shaTree(ledgerPath);
    assert.ok('MANIFEST.json' in ledgerBefore && Object.keys(ledgerBefore).some(k => k.startsWith('segments/')), JSON.stringify(Object.keys(ledgerBefore)));
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
    assert.deepEqual(shaTree(ledgerPath), ledgerBefore);
    await harness.registerSession('other-diagnostic-correlation', { command: 'fixture' });
    assert.equal((await harness.request('/api/sessions/other-diagnostic-correlation/diagnostics?' + query)).status, 409);
  } finally { owner?.close(); await harness.stop(); }
});
