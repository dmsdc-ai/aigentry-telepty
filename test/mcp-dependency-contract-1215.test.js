'use strict';
// #1215 compat183 — frozen MCP dependency contract (mcp181 MCP-CONTRACT.json + NEXT-TEST.json, 15 case groups).
//
// Drives a REAL stdio MCP server child (`node mcp-server/index.mjs`) against F, a private loopback HTTP recording
// fixture created and closed here. F is not a Telepty daemon: never the host daemon, a real session, the network
// beyond 127.0.0.1 or a real credential (random synthetic token; private HOME/USERPROFILE/tmp per child).
//
// Default (ordinary suites): the server under test is this checkout. Diagnostic runs only
// (.github/workflows/mcp-compatibility-1215.yml) may set:
//   TELEPTY_MCP_CONTRACT_SERVER_ROOT  root of another copy whose mcp-server/ runs with ITS OWN locked dependencies
//   TELEPTY_MCP_CONTRACT_RESULT       write the bounded result JSON to this file
//   TELEPTY_MCP_CONTRACT_BASELINE     result JSON of the original tree O; adds the O-equality comparison
// The SDK client, this driver and the case table always come from THIS checkout, so changing both sides cannot hide
// a protocol regression. Normative cases must hold on every tree; record-only cases (U3 and the V4 outcome) are
// recorded and compared as reported differences, never failed. A failure that the baseline also had is labelled
// baseline_original_failure, not a variant failure. This proves the MCP contract only on the exact recorded hashes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const SERVER_ROOT = process.env.TELEPTY_MCP_CONTRACT_SERVER_ROOT ? path.resolve(process.env.TELEPTY_MCP_CONTRACT_SERVER_ROOT) : CLIENT_ROOT;
const SERVER_ENTRY = path.join(SERVER_ROOT, 'mcp-server', 'index.mjs');
const CALL_MS = 5000, FILE_MS = 60000, CLOSE_MS = 2000;
const BODY_MAX = 16384, REQUESTS_MAX = 32, STDOUT_MAX = 262144, STDERR_KEEP = 4096, TEXT_KEEP = 4096, RAW_TOOLS_MAX = 65536, RESULT_MAX = 393216;
const TOKEN = crypto.randomBytes(24).toString('hex');
const SCHEMA = 'telepty-mcp-dependency-contract-1215/v1';

const sha256File = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const versionIn = (root, name) => { const pkg = readJson(path.join(root, 'node_modules', name, 'package.json')); return pkg && typeof pkg.version === 'string' ? pkg.version : null; };
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const settle = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms);
  Promise.resolve(promise).then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
});
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function waitGone(pid, ms) {
  const begun = Date.now();
  while (isAlive(pid) && Date.now() - begun < ms) await new Promise((resolve) => setTimeout(resolve, 50));
  return !isAlive(pid);
}

const serverPackage = readJson(path.join(SERVER_ROOT, 'package.json'));
const run = {
  schema: SCHEMA,
  label: 'MCP CONTRACT ONLY: not a full-suite, installed-prompt, security or release result',
  node: process.version,
  server: { root_label: path.basename(SERVER_ROOT), is_client_root: SERVER_ROOT === CLIENT_ROOT,
    package_json_sha256: sha256File(path.join(SERVER_ROOT, 'package.json')), package_lock_sha256: sha256File(path.join(SERVER_ROOT, 'package-lock.json')),
    entry_sha256: sha256File(SERVER_ENTRY), package_version: serverPackage && serverPackage.version,
    versions: Object.fromEntries(['@modelcontextprotocol/sdk', 'zod', 'zod-to-json-schema', 'ws'].map((name) => [name, versionIn(SERVER_ROOT, name)])) },
  client: { root_label: path.basename(CLIENT_ROOT), sdk_version: versionIn(CLIENT_ROOT, '@modelcontextprotocol/sdk'),
    driver_sha256: sha256File(__filename) },
  protocol_offered: null, negotiated_protocol: null, semantic_schema: null, tools_list_raw: null, tools_list_raw_truncated: false,
  cases: {}, comparison: null,
};

// ── F: private loopback HTTP recording fixture ──
async function startFixture({ sessions = [], injectStatus = 200 } = {}) {
  const log = { list: [], overflow: false };
  const server = http.createServer((req, res) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= BODY_MAX) chunks.push(chunk); });
    req.on('end', () => {
      if (log.list.length < REQUESTS_MAX) log.list.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'), body_bytes: size, token_ok: req.headers['x-telepty-token'] === TOKEN });
      else log.overflow = true;
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      const { pathname } = new URL(req.url, 'http://fixture.invalid');
      if (req.method === 'GET' && pathname === '/api/sessions') return json(200, sessions);
      if (req.method === 'GET' && pathname === '/api/meta') return json(401, { error: 'fixture authentication required' });
      if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/inject$/.test(pathname)) {
        return injectStatus === 200 ? json(200, { deliveryPath: 'fixture' }) : json(injectStatus, { error: 'fixture failure' });
      }
      return json(404, { error: 'fixture route not found' });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { log, port: server.address().port,
    close: () => new Promise((resolve) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => resolve()); }) };
}
function privateEnv(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-mcp-contract-'));
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp);
  const env = { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    TELEPTY_HOST: '127.0.0.1', TELEPTY_PORT: String(port), TELEPTY_AUTH_TOKEN: TOKEN };
  for (const key of ['PATH', 'SystemRoot', 'windir']) if (process.env[key]) env[key] = process.env[key];
  return { env, home };
}

// ── raw newline-delimited JSON-RPC caller (handshake and tools/list) ──
function rawServer(env) {
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: SERVER_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const state = { frames: [], unparsed: 0, not_jsonrpc: 0, stdout_bytes: 0, overflow: false, stderr: '', spawn_error: null, exited: null };
  const waiters = new Map();
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { state.exited = { code, signal }; resolve(); }));
  child.once('error', (error) => { state.spawn_error = error.code || 'spawn_error'; });
  child.stdin.on('error', () => {});
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    state.stdout_bytes += Buffer.byteLength(text);
    if (state.stdout_bytes > STDOUT_MAX) { state.overflow = true; return; }
    buffer += text;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { state.unparsed++; continue; }
      if (!frame || frame.jsonrpc !== '2.0') state.not_jsonrpc++;
      state.frames.push(frame);
      if (frame && waiters.has(frame.id)) { waiters.get(frame.id)(frame); waiters.delete(frame.id); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => { if (state.stderr.length < STDERR_KEEP) state.stderr += text.slice(0, STDERR_KEEP - state.stderr.length); });
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`raw ${method} not answered within ${CALL_MS} ms`)); }, CALL_MS);
    waiters.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
  async function close() {
    let forced = false;
    if (!state.exited) {
      child.stdin.end();
      if (!(await settle(exited, CLOSE_MS))) { forced = true; child.kill('SIGKILL'); await settle(exited, CLOSE_MS); }
    }
    return { exited: Boolean(state.exited), forced_kill: forced, stderr_head: state.stderr };
  }
  return { kind: 'raw', state, send, request, close };
}

// ── SDK caller: THIS checkout's Client + StdioClientTransport (callTool/close only, as the existing tests) ──
let clientSdk = null;
async function loadClientSdk() {
  if (!clientSdk) {
    const [{ Client }, { StdioClientTransport }, types] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js'), import('@modelcontextprotocol/sdk/types.js')]);
    clientSdk = { Client, StdioClientTransport, protocolVersion: types.LATEST_PROTOCOL_VERSION };
  }
  return clientSdk;
}
async function sdkServer(env) {
  const { Client, StdioClientTransport } = await loadClientSdk();
  const client = new Client({ name: 'mcp-dependency-contract-1215', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], cwd: SERVER_ROOT, env, stderr: 'pipe' });
  let stderr = '';
  if (transport.stderr) transport.stderr.on('data', (chunk) => { if (stderr.length < STDERR_KEEP) stderr += String(chunk).slice(0, STDERR_KEEP - stderr.length); });
  async function close() {
    const pid = typeof transport.pid === 'number' ? transport.pid : null;
    const closed = await settle(client.close(), CALL_MS);
    let gone = null, forced = false;
    if (pid !== null) {
      gone = await waitGone(pid, CLOSE_MS);
      if (!gone) { forced = true; try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
    return { exited: pid === null ? 'unknown (transport exposes no pid)' : gone, close_settled: closed, forced_kill: forced, stderr_head: stderr };
  }
  try { await client.connect(transport, { timeout: CALL_MS }); }
  catch (error) { await close(); throw new Error(`SDK client connect failed: ${error && error.message ? error.message : error}`); }
  return { kind: 'sdk', client, close };
}

// One tool call; the fixture request log is read before and after it. Outcome classes:
//   rejected  = a JSON-RPC error, or isError with ZERO fixture requests that is not a handler JSON verdict
//   accepted  = anything else that is not a transport failure (timeout -32001 / connection closed -32000)
async function call(session, fixture, label, name, args, { recordOnly = false } = {}) {
  const before = fixture.log.list.length;
  const record = { label, tool: name, record_only: recordOnly, outcome: null, form: null, code: null, layer: null, isError: null, handler_status: null, text: null, requests: [] };
  try {
    const result = await session.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_MS });
    record.isError = result && result.isError === true;
    const first = result && Array.isArray(result.content) ? result.content[0] : null;
    record.text = first && typeof first.text === 'string' ? first.text.slice(0, TEXT_KEEP) : null;
  } catch (error) {
    record.code = error && Number.isInteger(error.code) ? error.code : null;
    record.outcome = record.code === -32001 || record.code === -32000 ? 'transport_failure' : 'rejected';
    record.form = 'jsonrpc_error';
    record.layer = 'protocol_error';
    record.text = String(error && error.message ? error.message : error).slice(0, TEXT_KEEP);
  }
  record.requests = fixture.log.list.slice(before).map(({ method, url, body, token_ok }) => ({ method, url, body, token_ok }));
  if (record.outcome === null) {
    try { const parsed = JSON.parse(record.text); record.handler_status = parsed && typeof parsed.status === 'string' ? parsed.status : null; } catch { /* not JSON */ }
    if (record.isError && record.requests.length === 0 && record.handler_status === null) {
      record.outcome = 'rejected';
      record.form = 'tool_result_isError';
      record.layer = /invalid exact inject ID/.test(record.text || '') ? 'handler_throw' : 'schema_or_sdk';
    } else record.outcome = 'accepted';
  }
  return record;
}

// ── frozen tools/list contract (MCP-CONTRACT.json tools + schema_invariants) ──
const CONTRACT_SCHEMA = {
  telepty_list_sessions: { type: 'object', properties: {}, required: [] },
  telepty_session_status: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  telepty_diagnose_session: { type: 'object', required: ['machine_id', 'target'], properties: {
    target: { type: 'string', maxLength: 513 }, machine_id: { type: 'string', maxLength: 256 }, session_epoch: { type: 'string', maxLength: 256 },
    inject_id: { type: 'string', uuid_constraint: true }, tcp_probe: { type: 'boolean' }, process_state: { type: 'boolean' } } },
  telepty_inject_session: { type: 'object', required: ['session_id', 'text'], properties: {
    session_id: { type: 'string' }, text: { type: 'string' }, from: { type: 'string' }, no_enter: { type: 'boolean' } } },
};
// Semantic projection: names, property names, required set, JSON type, maxLength and the presence of a UUID constraint
// (format "uuid" or any pattern; the form is not contractual). Order, descriptions, $schema, additionalProperties and
// defaults are outside the projection.
function semanticSchema(tools) {
  const out = {};
  for (const tool of tools) {
    const schema = tool && tool.inputSchema ? tool.inputSchema : {};
    const properties = {};
    for (const [name, property] of Object.entries(schema.properties || {})) {
      const type = typeof property.type === 'string' ? property.type : Array.isArray(property.type) ? [...property.type].sort().join('|') : null;
      properties[name] = { type, ...(Number.isInteger(property.maxLength) ? { maxLength: property.maxLength } : {}),
        ...(property.format === 'uuid' || typeof property.pattern === 'string' ? { uuid_constraint: true } : {}) };
    }
    out[tool.name] = { type: schema.type, properties, required: [...(schema.required || [])].sort() };
  }
  return out;
}
function schemaDifferences(actual, expected) {
  const found = [];
  for (const name of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if (!(name in actual)) { found.push(`missing tool ${name}`); continue; }
    if (!(name in expected)) { found.push(`unexpected tool ${name}`); continue; }
    if (!same(actual[name], expected[name])) found.push(`${name}: ${JSON.stringify(canonical(actual[name]))} != ${JSON.stringify(canonical(expected[name]))}`);
  }
  return found;
}

// ── case groups: one owned server child and one fixture per group, always closed ──
async function group(t, id, options, body) {
  await t.test(id, { timeout: 20000 }, async () => {
    const record = run.cases[id] = { id, failures: [], calls: [], notes: {}, close: null, pass: false };
    const expect = (condition, message) => { if (!condition) record.failures.push(`${id}: ${message}`); return condition; };
    const fixture = await startFixture(options.fixture);
    const { env, home } = privateEnv(fixture.port);
    let session = null;
    try {
      session = options.raw ? rawServer(env) : await sdkServer(env);
      await body({ session, fixture, record, expect, call: async (...args) => { const r = await call(session, fixture, ...args); record.calls.push(r);
        expect(r.outcome !== 'transport_failure', `${r.label}: transport failure ${r.code}`); return r; } });
      if (session.kind === 'raw') {
        expect(!session.state.overflow && session.state.unparsed === 0 && session.state.not_jsonrpc === 0, 'stdout carried a non-JSON-RPC line or overflowed');
        expect(!session.state.spawn_error, `server spawn failed (${session.state.spawn_error})`);
      }
    } catch (error) {
      record.failures.push(`${id}: ${String(error && error.message ? error.message : error).slice(0, 1024)}`);
    } finally {
      if (session) record.close = await session.close();
      await fixture.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    if (record.close) expect(record.close.exited !== false, 'server child did not exit after close');
    expect(!fixture.log.overflow, 'fixture request log overflowed');
    record.pass = record.failures.length === 0;
    assert.deepEqual(record.failures, []);
  });
}
const rejected = (r) => r.outcome === 'rejected' && r.requests.length === 0;
const injectBody = (r) => (r.requests.length === 1 && r.requests[0].method === 'POST' && r.requests[0].url === '/api/sessions/s/inject' ? r.requests[0].body : null);
const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

function compareWithBaseline(base) {
  const comparison = { baseline_label: base.server && base.server.root_label, baseline_package_lock_sha256: base.server && base.server.package_lock_sha256,
    normative_differences: [], reported_differences: [], classification: {} };
  const schemaDiff = base.semantic_schema && run.semantic_schema ? schemaDifferences(run.semantic_schema, base.semantic_schema) : ['semantic schema missing on one side'];
  for (const difference of schemaDiff) comparison.normative_differences.push(`schema_equality: ${difference}`);
  for (const [id, mine] of Object.entries(run.cases)) {
    const theirs = base.cases && base.cases[id];
    comparison.classification[id] = mine.pass ? 'pass' : theirs && theirs.pass === false ? 'baseline_original_failure' : 'variant_only_failure';
    if (!theirs) { comparison.normative_differences.push(`${id}: absent from baseline`); continue; }
    for (const a of mine.calls) {
      const b = (theirs.calls || []).find((c) => c.label === a.label);
      if (!b) { comparison.normative_differences.push(`${a.label}: absent from baseline`); continue; }
      const target = a.record_only ? comparison.reported_differences : comparison.normative_differences;
      if (a.outcome !== b.outcome) target.push(`${a.label}: outcome ${b.outcome} -> ${a.outcome}`);
      if (!same(a.requests.map(({ method, url, body }) => ({ method, url, body })), (b.requests || []).map(({ method, url, body }) => ({ method, url, body })))) {
        target.push(`${a.label}: fixture requests differ (${(b.requests || []).length} -> ${a.requests.length})`);
      }
      if (a.outcome === 'accepted' && b.outcome === 'accepted' && a.isError !== b.isError) target.push(`${a.label}: isError ${b.isError} -> ${a.isError}`);
      if (a.outcome === 'rejected' && b.outcome === 'rejected' && (a.form !== b.form || a.layer !== b.layer)) {
        comparison.reported_differences.push(`${a.label}: rejection form ${b.form}/${b.layer} -> ${a.form}/${a.layer}`);
      }
    }
  }
  if (base.negotiated_protocol !== run.negotiated_protocol) comparison.reported_differences.push(`negotiated protocol ${base.negotiated_protocol} -> ${run.negotiated_protocol}`);
  return comparison;
}

function writeResult() {
  const file = process.env.TELEPTY_MCP_CONTRACT_RESULT;
  if (!file) return;
  let text = JSON.stringify(run, null, 1);
  if (Buffer.byteLength(text) > RESULT_MAX) { run.tools_list_raw = null; run.tools_list_raw_truncated = true; text = JSON.stringify(run, null, 1); }
  if (Buffer.byteLength(text) > RESULT_MAX) text = JSON.stringify({ schema: SCHEMA, error: 'result_over_bound', bytes: Buffer.byteLength(text) });
  fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
}

test('MCP dependency contract (#1215 compat183): real stdio server, private loopback fixture, frozen case table', { timeout: FILE_MS }, async (t) => {
  try {
    assert.ok(fs.existsSync(SERVER_ENTRY), `server entry missing under the selected server root (${run.server.root_label})`);
    const uuid = crypto.randomUUID();
    const atOther = '@other.invalid';

    await group(t, 'H1', { raw: true }, async ({ session, expect }) => {
      const { protocolVersion } = await loadClientSdk();
      run.protocol_offered = typeof protocolVersion === 'string' ? protocolVersion : null;
      if (!expect(run.protocol_offered, 'this checkout\'s SDK exposes no LATEST_PROTOCOL_VERSION')) return;
      const reply = await session.request(1, 'initialize', { protocolVersion: run.protocol_offered, capabilities: {}, clientInfo: { name: 'mcp-contract', version: '1' } });
      const result = reply.result || {};
      run.negotiated_protocol = typeof result.protocolVersion === 'string' ? result.protocolVersion : null;
      expect(!reply.error, `initialize answered an error ${JSON.stringify(reply.error)}`);
      expect(result.serverInfo && result.serverInfo.name === 'telepty', 'serverInfo.name is not telepty');
      expect(result.serverInfo && serverPackage && result.serverInfo.version === serverPackage.version, 'serverInfo.version is not the server package.json version');
      expect(result.capabilities && result.capabilities.tools && typeof result.capabilities.tools === 'object', 'no tools capability advertised');
    });

    await group(t, 'L1', { raw: true }, async ({ session, record, expect }) => {
      const { protocolVersion } = await loadClientSdk();
      const init = await session.request(1, 'initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'mcp-contract', version: '1' } });
      if (!expect(!init.error && init.result, 'initialize failed')) return;
      session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const reply = await session.request(2, 'tools/list', {});
      const tools = reply.result && Array.isArray(reply.result.tools) ? reply.result.tools : null;
      if (!expect(tools, 'tools/list returned no tools array')) return;
      const raw = JSON.stringify(tools);
      run.tools_list_raw = Buffer.byteLength(raw) <= RAW_TOOLS_MAX ? tools : null;
      run.tools_list_raw_truncated = run.tools_list_raw === null;
      run.semantic_schema = semanticSchema(tools);
      for (const difference of schemaDifferences(run.semantic_schema, CONTRACT_SCHEMA)) expect(false, `schema invariant: ${difference}`);
      const inject = tools.find((tool) => tool.name === 'telepty_inject_session');
      const noEnter = inject && inject.inputSchema && inject.inputSchema.properties ? inject.inputSchema.properties.no_enter : null;
      record.notes.no_enter_default = noEnter && 'default' in noEnter ? noEnter.default : 'not emitted';
      if (noEnter && 'default' in noEnter) expect(noEnter.default === false, 'no_enter default is emitted but is not false');
    });

    await group(t, 'U1', {}, async ({ call, expect }) => {
      const r = await call('U1 lowercase randomUUID v4', 'telepty_diagnose_session', { target: 'x@127.0.0.1', machine_id: 'm', inject_id: uuid });
      expect(r.outcome === 'accepted', 'a daemon-minted lowercase v4 inject_id was not accepted');
      expect(r.requests.length >= 1 && r.requests[0].method === 'GET' && r.requests[0].url.startsWith('/api/meta'), 'accepted diagnose made no GET /api/meta');
      expect(r.isError === true, 'the 401 fixture path did not return isError');
    });

    await group(t, 'U2', {}, async ({ call, expect }) => {
      const values = { proto: '__proto__', empty: '', len35: uuid.slice(0, 35), len37: `${uuid}a`, nonhex: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz', nohyphen: uuid.replace(/-/g, '') };
      for (const [name, value] of Object.entries(values)) {
        const r = await call(`U2 ${name}`, 'telepty_diagnose_session', { target: 'x@127.0.0.1', machine_id: 'm', inject_id: value });
        expect(rejected(r), `inject_id ${name} was not rejected before any request`);
      }
    });

    await group(t, 'U3', {}, async ({ call, expect }) => {
      const values = { upper_v4: uuid.toUpperCase(), nil: '00000000-0000-0000-0000-000000000000', any_hex: '12345678-1234-1234-1234-123456789abc', all_f: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
      for (const [name, value] of Object.entries(values)) {
        const r = await call(`U3 ${name}`, 'telepty_diagnose_session', { target: 'x@127.0.0.1', machine_id: 'm', inject_id: value }, { recordOnly: true });
        if (r.outcome === 'accepted') expect(r.requests.length >= 1, `accepted inject_id ${name} made no fixture request`);
      }
    });

    let n1Body = null;
    await group(t, 'N1', {}, async ({ call, expect }) => {
      const r = await call('N1 no_enter omitted', 'telepty_inject_session', { session_id: 's', text: 'x' });
      n1Body = injectBody(r);
      expect(r.outcome === 'accepted' && r.isError === false, 'ordinary inject was not accepted');
      expect(n1Body !== null && same(parse(n1Body), { prompt: 'x' }), `body is not exactly {prompt:'x'} (${n1Body})`);
    });

    await group(t, 'N2', {}, async ({ call, expect }) => {
      const r = await call('N2 no_enter false', 'telepty_inject_session', { session_id: 's', text: 'x', no_enter: false });
      const bytes = injectBody(r);
      expect(r.outcome === 'accepted' && r.isError === false, 'no_enter:false was not accepted');
      expect(bytes !== null && same(parse(bytes), { prompt: 'x' }), `body is not exactly {prompt:'x'} (${bytes})`);
      if (n1Body !== null) expect(bytes === n1Body, 'no_enter:false body is not byte-identical to the omitted case');
    });

    await group(t, 'N3', {}, async ({ call, expect }) => {
      const r = await call('N3 no_enter true with from', 'telepty_inject_session', { session_id: 's', text: 'x', no_enter: true, from: 'orch' });
      const bytes = injectBody(r);
      expect(r.outcome === 'accepted' && r.isError === false, 'no_enter:true was not accepted');
      expect(bytes !== null && same(parse(bytes), { prompt: 'x', from: 'orch', no_enter: true }), `body is not exactly {prompt,from,no_enter:true} (${bytes})`);
    });

    await group(t, 'N4', {}, async ({ call, expect }) => {
      for (const [name, value] of Object.entries({ string_true: 'true', number_one: 1, null_value: null })) {
        const r = await call(`N4 no_enter ${name}`, 'telepty_inject_session', { session_id: 's', text: 'x', no_enter: value });
        expect(rejected(r), `no_enter ${name} was not rejected before any request`);
      }
    });

    await group(t, 'V1', {}, async ({ call, expect }) => {
      expect(rejected(await call('V1 inject without session_id', 'telepty_inject_session', { text: 'x' })), 'inject without session_id was not rejected before any request');
      expect(rejected(await call('V1 status without session_id', 'telepty_session_status', {})), 'status without session_id was not rejected before any request');
    });

    await group(t, 'V2', {}, async ({ call, expect }) => {
      expect(rejected(await call('V2 numeric text', 'telepty_inject_session', { session_id: 's', text: 5 })), 'numeric text was not rejected before any request');
    });

    await group(t, 'V3', {}, async ({ call, expect }) => {
      const over = await call('V3 target 514', 'telepty_diagnose_session', { target: `${'a'.repeat(514 - atOther.length)}${atOther}`, machine_id: 'm' });
      expect(rejected(over), 'a 514-character target was not rejected before any request');
      const edge = await call('V3 target 513', 'telepty_diagnose_session', { target: `${'a'.repeat(513 - atOther.length)}${atOther}`, machine_id: 'm' });
      expect(edge.outcome === 'accepted' && edge.isError === true && edge.handler_status === 'identity_mismatch' && edge.requests.length === 0,
        'a 513-character target did not pass validation into the identity_mismatch handler result with zero requests');
    });

    await group(t, 'V4', {}, async ({ call, expect, record }) => {
      const r = await call('V4 extra key', 'telepty_inject_session', { session_id: 's', text: 'x', extra: 'y' }, { recordOnly: true });
      record.notes.extra_key_outcome = r.outcome;
      if (r.outcome === 'accepted') expect(injectBody(r) !== null && same(parse(injectBody(r)), { prompt: 'x' }), 'an accepted extra key changed the forwarded body');
      else expect(r.requests.length === 0, 'a rejected extra key still reached the fixture');
    });

    await group(t, 'E1', {}, async ({ call, expect }) => {
      const r = await call('E1 empty list', 'telepty_list_sessions', {});
      expect(r.outcome === 'accepted' && r.isError === false && r.text === 'No active sessions.', 'empty list did not answer "No active sessions." without isError');
      expect(r.requests.length === 1 && r.requests[0].method === 'GET' && r.requests[0].url === '/api/sessions', 'list did not make exactly one GET /api/sessions');
    });

    await group(t, 'E2', { fixture: { injectStatus: 500 } }, async ({ call, expect }) => {
      const r = await call('E2 daemon 500', 'telepty_inject_session', { session_id: 's', text: 'x' });
      expect(r.outcome === 'accepted' && r.isError === true && typeof r.text === 'string' && r.text.startsWith('Error injecting to s:'), 'a daemon 500 did not produce the isError inject text');
      expect(injectBody(r) !== null, 'the failing inject did not reach the fixture exactly once');
    });

    const baselineFile = process.env.TELEPTY_MCP_CONTRACT_BASELINE;
    if (baselineFile) {
      await t.test('O-equality', async () => {
        const base = readJson(baselineFile);
        assert.ok(base && base.schema === SCHEMA && base.cases, 'baseline result is missing or malformed');
        run.comparison = compareWithBaseline(base);
        assert.deepEqual(run.comparison.normative_differences, []);
      });
    }
  } finally {
    writeResult();
  }
});
