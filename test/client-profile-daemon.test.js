'use strict';

// Issue #144 / Telesession issue16 — `client-profile-scope-v1` against a REAL spawned daemon (PORT=0, temp HOME,
// private profiles file; the production daemon on :3848 is never contacted). This is the server-enforcement evidence
// contract564 §6 / REVIEW569 §6 demand: two profiles A and B each show own create / read / inject / observe / delete,
// and the four cross-profile operations are refused with sessions.json, the audit jsonl, the tracked ledger and the
// target receipt count byte-identical before and after every denial row.
//
// Native Windows: profile scope is UNSUPPORTED (no authority-file backend) — only the W1 refusal row runs there.
// Every token, prefix, target and path is synthetic.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startTestDaemon, delay, waitFor } = require('../test-support/daemon-harness');
const persistence = require('../src/session-store/persistence');

const WIN = process.platform === 'win32';
const SKIP = WIN ? 'win32: client-profile-scope-v1 is unsupported on native Windows; only the W1 refusal row runs' : false;
const SCHEMA = 'telepty.client-profiles/v1';
const LEGACY_CAPABILITIES = ['ssh-child-write-receipts-v1', 'bridge-stage-receipts-v1', 'sessions', 'wrapped-sessions', 'skill-installer',
  'singleton-daemon', 'handoff-inbox', 'deliberation-threads', 'cross-machine', 'mailbox', 'inject-exact-target', 'register-create-only',
  'delete-owned-session', 'daemon-graceful-stop-v1'];
const TARGETS = { a: 'cpa-target', b: 'cpb-target', c: 'cpc-target', shared: 'cp-shared' };
const BASE_ENV = { TELEPTY_AUDIT_FLUSH_MS: '10', TELEPTY_PRINCIPAL_MODE: '', TELEPTY_SUPERVISION_TRUST_FILE: '',
  TELEPTY_NO_TAILNET_AUTO: '1', TELEPTY_NO_SUPERVISOR_DEFER: '1',
  // Fewer background writes during byte-compared denial rows (health polling is not under test here).
  TELEPTY_HEALTH_POLL_MS: '600000',
  // The targets are on the orchestrator lane so the unchanged #533 peer guard lets inbox → target traffic through.
  AIGENTRY_ORCHESTRATOR_SIDS: Object.values(TARGETS).join(' ') };

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

const mintToken = (generation = 1) => `tpc1.${generation}.${crypto.randomBytes(32).toString('base64url')}`;
const verifierOf = (token) => `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
const hex32 = () => crypto.randomBytes(16).toString('hex');
const secretPath = () => crypto.randomBytes(32).toString('base64url');
const iso = (ms) => new Date(ms).toISOString();

function privateRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'telepty-cpd-'));
  fs.chmodSync(root, 0o700);
  for (const part of ['keys', 'home', path.join('home', '.telepty')]) fs.mkdirSync(path.join(root, part), { mode: 0o700 });
  return root;
}
function grant(profile, prefix, targets, token, { generation = 1, notBefore = iso(Date.now() - 60_000) } = {}) {
  return { profile, inbox_prefix: prefix, targets, generation, token_verifier: verifierOf(token), not_before: notBefore };
}
function profileBytes(entries) { return Buffer.from(JSON.stringify({ schema: SCHEMA, profiles: entries })); }
// Atomic replace (new inode, nlink 1, mode 0600) — the operator's normal edit.
function writeProfiles(file, entries) {
  const tmp = `${file}.${process.pid}.${hex32()}.tmp`;
  fs.writeFileSync(tmp, profileBytes(entries), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// A loopback HTTP receiver standing in for aterm targets and Telesession inbox receivers; counts every byte push.
function startReceiver() {
  const hits = [];
  let hold = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push({ path: req.url, body });
      const respond = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); };
      if (hold && hold.path === req.url) hold.pending.push(respond); else respond();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    hits,
    count: (p) => hits.filter((h) => p === undefined || h.path === p).length,
    holdPath(p) { hold = { path: p, pending: [] }; },
    release() { const held = hold; hold = null; if (held) for (const respond of held.pending) respond(); },
    close: () => new Promise((done) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => done()); }),
  })));
}

// Exact bytes on the wire: duplicate / case-variant / empty headers that fetch would merge or drop.
function dechunk(text) {
  let out = '', rest = text;
  for (;;) {
    const line = rest.indexOf('\r\n');
    if (line === -1) return out;
    const size = parseInt(rest.slice(0, line), 16);
    if (!size) return out;
    out += rest.slice(line + 2, line + 2 + size);
    rest = rest.slice(line + 2 + size + 2);
  }
}
function rawRequest(port, { method = 'GET', target = '/api/meta', headers = [], body = null, host = '127.0.0.1', upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const lines = [`${method} ${target} HTTP/1.1`, `Host: ${host}:${port}`];
    if (upgrade) lines.push('Connection: Upgrade', 'Upgrade: websocket', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13');
    else lines.push('Connection: close');
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    if (payload) lines.push('Content-Type: application/json', `Content-Length: ${payload.length}`);
    const socket = net.connect(port, host);
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      let rest = split === -1 ? '' : text.slice(split + 4);
      if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) rest = dechunk(rest);
      let json = null;
      try { json = JSON.parse(rest); } catch { json = null; }
      resolve({ status: Number((/^HTTP\/1\.1 (\d{3})/.exec(head) || [])[1]), head, text: rest, body: json });
    };
    socket.setTimeout(10_000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (upgrade && /^HTTP\/1\.1 101/.test(Buffer.concat(chunks).toString('latin1'))) { finish(); socket.destroy(); }
    });
    socket.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    socket.on('close', finish);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (payload) socket.write(payload);
  });
}

function hashTree(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (current, rel) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(current, entry.name), name = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, name);
      else { hash.update(name); hash.update(fs.readFileSync(full)); }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}
function readOrNull(file) { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

// ── the shared two-profile daemon ────────────────────────────────────────────────────────────────────────────────

const ctx = {};
const as = (token, extra = {}) => ({ 'x-telepty-client-token': token, ...extra });
function preq(pathname, token, options = {}) {
  return ctx.daemon.request(pathname, { ...options, noAuth: true, headers: { ...as(token), ...(options.headers || {}) } });
}
async function createInbox(token, prefix, id = `${prefix}-i${hex32()}`) {
  const endpointPath = secretPath();
  const res = await preq('/api/sessions/register', token, { method: 'POST', body: { session_id: id, delivery_type: 'aterm',
    delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/${endpointPath}`, command: 'telesession-inbox', create_only: true } });
  return { id, res, bearer: res.body && res.body.session_token, endpointPath };
}
function injectAs(token, bearer, target, from, extra = {}) {
  return preq(`/api/sessions/${encodeURIComponent(target)}/inject`, token, { method: 'POST',
    headers: bearer ? { 'x-telepty-session-token': bearer } : {}, body: { prompt: 'hello', from, reply_to: from, exact_target: true, ...extra } });
}
async function auditLine(predicate) {
  return waitFor(() => {
    const raw = readOrNull(ctx.auditPath);
    if (!raw) return null;
    return raw.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find(predicate) || null;
  }, { timeoutMs: 5000, description: 'audit line' });
}
// State that a denial must not touch. Settles first so an earlier row's 10 ms audit flush cannot be misattributed.
async function stateSnapshot() {
  await delay(150);
  return { sessions: readOrNull(ctx.sessionsPath), audit: readOrNull(ctx.auditPath), ledger: hashTree(ctx.ledgerDir), receipts: ctx.rx.hits.length };
}
async function assertDeniedUnchanged(label, run, status, code) {
  const before = await stateSnapshot();
  const res = await run();
  assert.equal(res.status, status, `${label}: status`);
  if (code) assert.equal(res.body && res.body.code, code, `${label}: code`);
  const afterState = await stateSnapshot();
  assert.ok(Buffer.compare(before.sessions || Buffer.alloc(0), afterState.sessions || Buffer.alloc(0)) === 0, `${label}: sessions.json unchanged`);
  assert.ok(Buffer.compare(before.audit || Buffer.alloc(0), afterState.audit || Buffer.alloc(0)) === 0, `${label}: audit jsonl unchanged`);
  assert.equal(afterState.ledger, before.ledger, `${label}: tracked ledger unchanged`);
  assert.equal(afterState.receipts, before.receipts, `${label}: no bytes reached any receiver`);
  return res;
}
// One fixed not_before for the suite's base grants, so restoring them never moves a profile's history window.
function baseGrants() {
  const notBefore = ctx.notBefore;
  return [
    grant('example-a', 'exa', [TARGETS.a, TARGETS.shared], ctx.tok.a, { notBefore }),
    grant('example-b', 'exb', [TARGETS.b, TARGETS.shared], ctx.tok.b, { generation: 3, notBefore }),
    grant('example-c', 'ex', [TARGETS.c], ctx.tok.c, { notBefore }),
  ];
}

if (!WIN) {
  before(async () => {
    ctx.root = privateRoot();
    ctx.file = path.join(ctx.root, 'keys', 'profiles.json');
    ctx.tok = { a: mintToken(1), b: mintToken(3), c: mintToken(1) };
    ctx.notBefore = iso(Date.now() - 60_000);
    writeProfiles(ctx.file, baseGrants());
    ctx.rx = await startReceiver();
    ctx.daemon = await startTestDaemon({ env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: ctx.file } });
    ctx.sessionsPath = persistence.defaultSessionPersistPath(ctx.daemon.homeDir);
    ctx.ledgerDir = persistence.defaultTrackedInjectionsPath(ctx.daemon.homeDir);
    ctx.auditPath = path.join(ctx.daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
    for (const id of Object.values(TARGETS)) {
      const res = await ctx.daemon.registerSession(id, { delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/t-${id}` });
      assert.equal(res.status, 201, `E1 registers target ${id}`);
    }
  });
  after(async () => {
    if (ctx.daemon) await ctx.daemon.stop();
    if (ctx.rx) await ctx.rx.close();
    if (ctx.root) fs.rmSync(ctx.root, { recursive: true, force: true });
  });
}

// ── health (D31) ─────────────────────────────────────────────────────────────────────────────────────────────────

test('D31: /api/meta advertises the capability and a server-computed caller for profile and shared-control callers', { skip: SKIP }, async () => {
  const a = await preq('/api/meta', ctx.tok.a);
  assert.equal(a.status, 200);
  assert.ok(a.body.capabilities.includes('client-profile-scope-v1'));
  assert.deepEqual(a.body.caller, { kind: 'client-profile', profile: 'example-a', generation: 1, inbox_prefix: 'exa',
    targets: [TARGETS.a, TARGETS.shared], enforcement: 'server', shared_token: false });
  const b = await preq('/api/meta', ctx.tok.b);
  assert.equal(b.body.caller.profile, 'example-b');
  assert.equal(b.body.caller.generation, 3);
  const root = await ctx.daemon.request('/api/meta');
  assert.deepEqual(root.body.caller, { kind: 'shared-control', enforcement: 'none', shared_token: true });
  assert.deepEqual(root.body.capabilities, [...LEGACY_CAPABILITIES, 'client-profile-scope-v1']);
});

// ── own positive controls, both profiles (D1–D6) ─────────────────────────────────────────────────────────────────

for (const [key, prefix, own, profileName] of [['a', 'exa', TARGETS.a, 'example-a'], ['b', 'exb', TARGETS.b, 'example-b']]) {
  test(`D1–D6 (${profileName}): own create, list, inject, audit read, observation and owned delete`, { skip: SKIP }, async () => {
    const token = ctx.tok[key];
    const inbox = await createInbox(token, prefix);
    assert.equal(inbox.res.status, 201, 'D1 create own inbox');
    assert.equal(typeof inbox.bearer, 'string', 'D1 the #815 bearer is returned once');

    const list = await preq('/api/sessions', token);
    assert.equal(list.status, 200);
    for (const item of list.body) assert.deepEqual(Object.keys(item), ['id'], 'D2 [{id}] only — no deliveryEndpoint');
    const ids = list.body.map((item) => item.id);
    assert.ok(ids.includes(inbox.id) && ids.includes(own) && ids.includes(TARGETS.shared), 'D2 own inbox and granted targets');
    for (const id of ids) assert.ok(id === own || id === TARGETS.shared || id.startsWith(`${prefix}-i`), `D2 nothing foreign: ${id}`);

    const before = ctx.rx.count(`/t-${own}`);
    const inject = await injectAs(token, inbox.bearer, own, inbox.id);
    assert.equal(inject.status, 200, `D3 inject: ${JSON.stringify(inject.body)}`);
    const injectId = inject.body.inject_id;
    assert.equal(typeof injectId, 'string');
    await waitFor(() => ctx.rx.count(`/t-${own}`) === before + 1, { timeoutMs: 5000, description: 'target receipt' });
    const line = await auditLine((l) => l.inject_id === injectId && l.to === own);
    assert.equal(line.verified_sender_sid, inbox.id, 'D3 audit verified_sender_sid = own inbox');

    const rows = await waitFor(async () => {
      const res = await preq(`/api/injects?from=${encodeURIComponent(inbox.id)}&to=${encodeURIComponent(own)}`, token);
      return res.status === 200 && res.body.injects.some((r) => r.inject_id === injectId) ? res : null;
    }, { timeoutMs: 5000, description: 'own audit row' });
    assert.ok(rows.body.injects.every((r) => r.verified_sender_sid === inbox.id), 'D4 exact verified rows only');
    const toInbox = await preq(`/api/injects?to=${encodeURIComponent(inbox.id)}`, token);
    assert.equal(toInbox.status, 200, 'D4 replies addressed to the own inbox are readable');

    const observed = await preq(`/api/inject-observations/${encodeURIComponent(injectId)}`, token);
    assert.equal(observed.status, 200);
    assert.equal(observed.body.inject_id, injectId, 'D5 own observation');
    assert.equal(observed.body.transport_source, inbox.id);
    assert.ok(!Object.prototype.hasOwnProperty.call(observed.body.consumption, 'active_inject_id'));

    const del = await preq(`/api/sessions/${encodeURIComponent(inbox.id)}?owned=true`, token, { method: 'DELETE', headers: { 'x-telepty-session-token': inbox.bearer } });
    assert.equal(del.status, 200, `D6 owned delete: ${JSON.stringify(del.body)}`);
    const gone = await preq('/api/sessions', token);
    assert.ok(!gone.body.some((item) => item.id === inbox.id));
  });
}

// ── cross-profile denial ×4 with byte-compared state (D7–D17) ───────────────────────────────────────────────────

test('D7–D17: A is refused create, read, inject and delete on B (with and without A\'s bearer); state byte-identical', { skip: SKIP }, async () => {
  const A = await createInbox(ctx.tok.a, 'exa');
  const B = await createInbox(ctx.tok.b, 'exb');
  assert.equal(A.res.status, 201); assert.equal(B.res.status, 201);
  const bInject = await injectAs(ctx.tok.b, B.bearer, TARGETS.b, B.id);
  assert.equal(bInject.status, 200);
  const tA = ctx.tok.a;
  const body = { prompt: 'x', from: A.id, reply_to: A.id, exact_target: true };
  const post = (target, b, bearer = A.bearer) => () => preq(`/api/sessions/${target}/inject`, tA, { method: 'POST',
    headers: bearer ? { 'x-telepty-session-token': bearer } : {}, body: b });

  await assertDeniedUnchanged('D7 create in B', () => preq('/api/sessions/register', tA, { method: 'POST', body: { session_id: `exb-i${hex32()}`,
    delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/${secretPath()}`, create_only: true } }), 403, 'PROFILE_NAMESPACE_DENIED');
  await assertDeniedUnchanged('D15 prefix ex claims exa-i…', () => preq('/api/sessions/register', ctx.tok.c, { method: 'POST', body: { session_id: `exa-i${hex32()}`,
    delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/${secretPath()}`, create_only: true } }), 403, 'PROFILE_NAMESPACE_DENIED');
  await assertDeniedUnchanged('D8 read to=B', () => preq(`/api/injects?to=${B.id}`, tA), 403, 'PROFILE_READ_DENIED');
  await assertDeniedUnchanged('D8 read from=B', () => preq(`/api/injects?from=${B.id}&to=${TARGETS.b}`, tA), 403, 'PROFILE_READ_DENIED');
  await assertDeniedUnchanged('D9 inject into B inbox', post(B.id, body), 403, 'PROFILE_TARGET_DENIED');
  await assertDeniedUnchanged('D9 inject into B-only target', post(TARGETS.b, body), 403, 'PROFILE_TARGET_DENIED');
  await assertDeniedUnchanged('D10 delete B with A bearer', () => preq(`/api/sessions/${B.id}?owned=true`, tA, { method: 'DELETE',
    headers: { 'x-telepty-session-token': A.bearer } }), 403, 'PROFILE_NAMESPACE_DENIED');
  await assertDeniedUnchanged('D10 delete B without bearer', () => preq(`/api/sessions/${B.id}?owned=true`, tA, { method: 'DELETE' }), 403, 'PROFILE_NAMESPACE_DENIED');
  await assertDeniedUnchanged('D10 delete B with B bearer but A token', () => preq(`/api/sessions/${B.id}?owned=true`, tA, { method: 'DELETE',
    headers: { 'x-telepty-session-token': B.bearer } }), 403, 'PROFILE_NAMESPACE_DENIED');
  await assertDeniedUnchanged('D12 from=B inbox', post(TARGETS.a, { ...body, from: B.id, reply_to: B.id }, B.bearer), 403, 'PROFILE_SENDER_DENIED');
  await assertDeniedUnchanged('D13 reply_to≠from', post(TARGETS.a, { ...body, reply_to: B.id }), 403, 'PROFILE_SENDER_DENIED');
  await assertDeniedUnchanged('D14 B bearer with A token', post(TARGETS.a, body, B.bearer), 403, 'PROFILE_SENDER_DENIED');
  await assertDeniedUnchanged('D16 -N sibling', post(`${TARGETS.a}-2`, body), 403, 'PROFILE_TARGET_DENIED');
  await assertDeniedUnchanged('D16 %2F', post(`${TARGETS.a}%2Fx`, body), 403, 'PROFILE_ACTION_DENIED');
  await assertDeniedUnchanged('D16 uppercase hex', () => preq('/api/sessions/register', tA, { method: 'POST', body: { session_id: `exa-i${hex32().toUpperCase()}`,
    delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/${secretPath()}`, create_only: true } }), 403, 'PROFILE_NAMESPACE_DENIED');
  await assertDeniedUnchanged('D17 exact_target false', post(TARGETS.a, { ...body, exact_target: false }), 403, 'PROFILE_REQUEST_FIELD_DENIED');

  // D11: A's observation of B's inject is the SAME body as an unknown id (only the echoed id differs).
  const foreign = await preq(`/api/inject-observations/${bInject.body.inject_id}`, tA);
  const unknownId = crypto.randomUUID();
  const unknown = await preq(`/api/inject-observations/${unknownId}`, tA);
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.reason, 'not_observed_by_daemon_epoch');
  assert.equal(foreign.text.replaceAll(bInject.body.inject_id, '<id>'), unknown.text.replaceAll(unknownId, '<id>'), 'D11 uniform body, no existence oracle');
  // B still owns and reads its own inject.
  assert.equal((await preq(`/api/inject-observations/${bInject.body.inject_id}`, ctx.tok.b)).body.inject_id, bInject.body.inject_id);
});

// ── admin escape and alternate ingress (D23, D32, D33) ──────────────────────────────────────────────────────────

test('D23/D32/D33: every admin, alternate and fan-out route is 403 with no effect', { skip: SKIP }, async () => {
  const A = await createInbox(ctx.tok.a, 'exa');
  const injectBody = { prompt: 'x', from: A.id, reply_to: A.id, exact_target: true };
  const rows = [
    ['POST', '/api/sessions/spawn', { session_id: `exa-i${hex32()}`, command: 'sh' }], ['POST', `/api/sessions/${TARGETS.a}/kill`, {}],
    ['PATCH', `/api/sessions/${A.id}`, { new_id: `exa-i${hex32()}` }], ['POST', `/api/sessions/${TARGETS.a}/submit`, {}],
    ['GET', `/api/sessions/${TARGETS.a}/screen`], ['GET', `/api/sessions/${TARGETS.a}/diagnostics`], ['GET', `/api/sessions/${A.id}/mailbox`],
    ['GET', `/api/sessions/${TARGETS.a}`], ['GET', `/api/sessions/${TARGETS.a}/state`], ['GET', '/api/peers'],
    ['POST', `/api/forwarded/sessions/${TARGETS.a}/inject`, injectBody], ['POST', '/api/sessions/multicast/inject', { ...injectBody, session_ids: [TARGETS.b] }],
    ['POST', '/api/sessions/broadcast/inject', injectBody], ['POST', '/api/sessions/Broadcast/inject', injectBody],
    ['POST', '/api/sessions/submit-all', {}], ['POST', `/api/peers/p/sessions/${TARGETS.a}/inject`, injectBody], ['POST', '/api/bus/publish', { type: 'x' }],
    ['GET', `/api/sessions/${TARGETS.a}/interaction`], ['GET', '/api/ledger/status'], ['POST', '/api/daemon/stop', {}],
    ['POST', `/api/sessions/${TARGETS.a}/approval-challenge`, {}], ['GET', `/api/pendingReports/${TARGETS.a}`],
    ['GET', '/API/META'], ['GET', '/api/meta/'], ['HEAD', '/api/meta'], ['POST', `/api/sessions/${TARGETS.a}/inject/`, injectBody],
    ['GET', '/api/sessions?idle_gt=0'], ['DELETE', `/api/sessions/${A.id}`],
  ];
  for (const [method, url, body] of rows) {
    await assertDeniedUnchanged(`${method} ${url}`, () => preq(url, ctx.tok.a, { method, ...(body ? { body } : {}) }), 403,
      method === 'HEAD' ? undefined : 'PROFILE_ACTION_DENIED');
  }
});

// ── credential carriers (D24–D26, D38, D39) ─────────────────────────────────────────────────────────────────────

test('D24–D26/D38/D39: carriers — ambiguous 400, legacy carriers of a profile token 401, any WebSocket 401', { skip: SKIP }, async () => {
  const port = ctx.daemon.port;
  const tA = ctx.tok.a;
  const root = await ctx.daemon.request('/api/meta');
  assert.equal(root.status, 200);
  const rootToken = fs.existsSync(path.join(ctx.daemon.homeDir, '.telepty', 'config.json'))
    ? JSON.parse(fs.readFileSync(path.join(ctx.daemon.homeDir, '.telepty', 'config.json'), 'utf8')).authToken : null;
  assert.equal(typeof rootToken, 'string');
  const ambiguous = [
    ['D38 duplicate client token', [['x-telepty-client-token', tA], ['X-Telepty-Client-Token', tA]]],
    ['D38 empty x-telepty-token', [['x-telepty-client-token', tA], ['x-telepty-token', '']]],
    ['D26 profile + root token', [['x-telepty-client-token', tA], ['x-telepty-token', rootToken]]],
    ['D38 duplicate authorization', [['x-telepty-client-token', tA], ['Authorization', 'Bearer a'], ['authorization', 'Bearer b']]],
    ['D38 owner token', [['x-telepty-client-token', tA], ['x-telepty-owner-token', 'o']]],
    ['D38 principal', [['x-telepty-client-token', tA], ['x-telepty-principal', 'p']]],
    ['D38 input policy capability', [['x-telepty-client-token', tA], ['x-telepty-input-policy-capability', 'c']]],
  ];
  for (const [label, headers] of ambiguous) {
    await assertDeniedUnchanged(label, () => rawRequest(port, { headers }), 400, 'CREDENTIAL_AMBIGUOUS');
  }
  await assertDeniedUnchanged('D38 ?token=', () => rawRequest(port, { target: '/api/meta?token=', headers: [['x-telepty-client-token', tA]] }), 400, 'CREDENTIAL_AMBIGUOUS');
  // A profile token in a LEGACY carrier is just a wrong admin token (no client header ⇒ legacy path).
  await assertDeniedUnchanged('D25 ?token=<profile>', () => rawRequest(port, { target: `/api/meta?token=${tA}` }), 401, 'PERMISSION_DENIED');
  await assertDeniedUnchanged('D25 x-telepty-token: <profile>', () => rawRequest(port, { headers: [['x-telepty-token', tA]] }), 401, 'PERMISSION_DENIED');
  await assertDeniedUnchanged('D25 Bearer <profile>', () => rawRequest(port, { headers: [['Authorization', `Bearer ${tA}`]] }), 401, 'PERMISSION_DENIED');
  for (const target of [`/api/sessions/${TARGETS.a}`, '/api/bus', `/api/sessions/${TARGETS.a}?token=${rootToken}`]) {
    const res = await rawRequest(port, { target, upgrade: true, headers: [['x-telepty-client-token', tA], ['x-telepty-token', rootToken]] });
    assert.equal(res.status, 401, `D39 ${target}`);
    assert.match(res.head, /X-Telepty-Refusal: PROFILE_WEBSOCKET_UNSUPPORTED/i);
    const only = await rawRequest(port, { target, upgrade: true, headers: [['x-telepty-client-token', '']] });
    assert.equal(only.status, 401, `D24 ${target} (empty header counts)`);
    assert.match(only.head, /PROFILE_WEBSOCKET_UNSUPPORTED/);
  }
});

// ── register fields, create_only, replay (D27, D29, D30) ────────────────────────────────────────────────────────

test('D27/D29/D30: register field refusals, create_only 409 unchanged, a replayed inject is a new inject (bearer model)', { skip: SKIP }, async () => {
  const good = () => ({ session_id: `exa-i${hex32()}`, delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/${secretPath()}`, create_only: true });
  for (const [label, mutate] of [
    ['no create_only', (b) => { delete b.create_only; }], ['delivery object', (b) => { b.delivery = { unix_socket: '/tmp/x.sock' }; }],
    ['non-loopback endpoint', (b) => { b.delivery_endpoint = `http://10.0.0.1:9/${secretPath()}`; }],
    ['input_policy', (b) => { b.input_policy = 'user-supervised'; }], ['ssh_remote', (b) => { b.ssh_remote = { host: 'h' }; }],
  ]) {
    const body = good(); mutate(body);
    await assertDeniedUnchanged(`D27 ${label}`, () => preq('/api/sessions/register', ctx.tok.a, { method: 'POST', body }), 403, 'PROFILE_REQUEST_FIELD_DENIED');
  }
  const A = await createInbox(ctx.tok.a, 'exa');
  await assertDeniedUnchanged('D29 second create', () => preq('/api/sessions/register', ctx.tok.a, { method: 'POST', body: { session_id: A.id,
    delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/${secretPath()}`, create_only: true } }), 409, 'SESSION_EXISTS');
  const before = ctx.rx.count(`/t-${TARGETS.a}`);
  const first = await injectAs(ctx.tok.a, A.bearer, TARGETS.a, A.id);
  const replay = await injectAs(ctx.tok.a, A.bearer, TARGETS.a, A.id);
  assert.equal(first.status, 200); assert.equal(replay.status, 200);
  assert.notEqual(first.body.inject_id, replay.body.inject_id, 'D30 a captured request replays as a NEW inject (documented)');
  await waitFor(() => ctx.rx.count(`/t-${TARGETS.a}`) === before + 2, { timeoutMs: 5000, description: 'two receipts' });
});

// ── audit exactness (D28, D37) and observation strip (D36) ──────────────────────────────────────────────────────

test('D28/D37: spoof refused; a forged claimed sender is not in the profile\'s from= rows', { skip: SKIP }, async () => {
  const A = await createInbox(ctx.tok.a, 'exa');
  await assertDeniedUnchanged('D28 spoof', () => preq(`/api/injects?to=${A.id}&spoof=1`, ctx.tok.a), 403, 'PROFILE_READ_DENIED');
  const own = await injectAs(ctx.tok.a, A.bearer, TARGETS.a, A.id);
  const forged = await ctx.daemon.request(`/api/sessions/${TARGETS.a}/inject`, { method: 'POST', body: { prompt: 'forged', from: A.id } });
  assert.equal(own.status, 200); assert.equal(forged.status, 200);
  await auditLine((l) => l.inject_id === forged.body.inject_id);
  const rows = await waitFor(async () => {
    const res = await preq(`/api/injects?from=${A.id}&to=${TARGETS.a}`, ctx.tok.a);
    return res.status === 200 && res.body.injects.some((r) => r.inject_id === own.body.inject_id) ? res : null;
  }, { timeoutMs: 5000, description: 'own row' });
  assert.ok(!rows.body.injects.some((r) => r.inject_id === forged.body.inject_id), 'D37 claimed-only attribution is excluded');
  const legacy = await ctx.daemon.request(`/api/injects?from=${A.id}&to=${TARGETS.a}`);
  assert.ok(legacy.body.injects.some((r) => r.inject_id === forged.body.inject_id), 'E1 audit semantics unchanged');
});

test('D36: a profile\'s own observation never carries another caller\'s active_inject_id on a shared target', { skip: SKIP }, async (t) => {
  const A = await createInbox(ctx.tok.a, 'exa');
  const B = await createInbox(ctx.tok.b, 'exb');
  const aInject = await injectAs(ctx.tok.a, A.bearer, TARGETS.shared, A.id);
  const bInject = await injectAs(ctx.tok.b, B.bearer, TARGETS.shared, B.id);
  assert.equal(aInject.status, 200); assert.equal(bInject.status, 200);
  const mine = await preq(`/api/inject-observations/${aInject.body.inject_id}`, ctx.tok.a);
  assert.equal(mine.body.inject_id, aInject.body.inject_id);
  assert.ok(!Object.prototype.hasOwnProperty.call(mine.body.consumption, 'active_inject_id'), 'D36 stripped');
  // ci708: the inputs are real ids, so the absence check below cannot pass or fail on an empty/undefined needle.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.match(aInject.body.inject_id, UUID); assert.match(bInject.body.inject_id, UUID);
  assert.notEqual(aInject.body.inject_id, bInject.body.inject_id);
  const pathsOf = (value, needle, at = '') => (value === needle ? [at || '(root)']
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => pathsOf(v, needle, Array.isArray(value) ? `${at}[${k}]` : (at ? `${at}.${k}` : k))) : []);
  assert.ok(!mine.text.includes(bInject.body.inject_id),
    `B's inject id appears nowhere in A's body; found at: ${JSON.stringify(pathsOf(mine.body, bInject.body.inject_id))}`);
  const supersededOf = (body) => (body.observations || []).find((o) => o && o.kind === 'tracking_superseded');
  const mineSuperseded = supersededOf(mine.body);
  const admin = await ctx.daemon.request(`/api/inject-observations/${aInject.body.inject_id}`);
  if (admin.body.consumption.basis === 'pending_report_belongs_to_other_inject') {
    assert.equal(admin.body.consumption.active_inject_id, bInject.body.inject_id, 'control: the E1 view is unchanged');
  } else {
    t.diagnostic(`control not reached: admin consumption basis = ${admin.body.consumption.basis}`);
  }
  if (mineSuperseded) {
    assert.ok(!Object.prototype.hasOwnProperty.call(mineSuperseded, 'superseded_by'), 'profile history entry has no superseded_by');
    assert.equal(mineSuperseded.trigger, 'superseded_by_new_tracked_inject', 'the supersession itself stays visible');
    assert.ok(Number.isInteger(mineSuperseded.seq) && typeof mineSuperseded.at === 'string', 'seq/at kept');
    assert.equal(supersededOf(admin.body).superseded_by, bInject.body.inject_id, 'control: the E1 history is unchanged');
  } else {
    t.diagnostic('supersession control not reached: no tracking_superseded entry in A\'s history');
  }
});

// ── E1 namespace reservation (D35) ───────────────────────────────────────────────────────────────────────────────

test('D35: while configured, E1 cannot create or rename into a profile namespace; elsewhere unchanged', { skip: SKIP }, async () => {
  const reserved = await ctx.daemon.registerSession(`exa-i${hex32()}`, { delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/x` });
  assert.equal(reserved.status, 403);
  assert.equal(reserved.body.code, 'PROFILE_NAMESPACE_RESERVED');
  const outsideId = `cp-outside-${hex32().slice(0, 8)}`;
  const outside = await ctx.daemon.registerSession(outsideId);
  assert.equal(outside.status, 201, 'E1 register outside every namespace is unchanged');
  const rename = await ctx.daemon.request(`/api/sessions/${outsideId}`, { method: 'PATCH', body: { new_id: `exb-i${hex32()}` } });
  assert.equal(rename.status, 403);
  assert.equal(rename.body.code, 'PROFILE_NAMESPACE_RESERVED');
});

// ── credential lifecycle (D18–D22, D41, D42) and prefix re-grant (D34) ─────────────────────────────────────────

test('D18/D20/D41: rotation (atomic and same-size in place with mtime restored) is seen on the next request', { skip: SKIP }, async () => {
  try {
    const forged = `tpc1.9.${ctx.tok.a.split('.')[2]}`;
    assert.equal((await preq('/api/meta', forged)).body.code, 'PROFILE_CREDENTIAL_INVALID', 'D20 generation text buys nothing');
    const rotated = mintToken(2);
    writeProfiles(ctx.file, [grant('example-a', 'exa', [TARGETS.a, TARGETS.shared], rotated, { generation: 2, notBefore: ctx.notBefore }),
      ...baseGrants().slice(1)]);
    assert.equal((await preq('/api/meta', ctx.tok.a)).status, 401, 'D18 old token');
    const now = await preq('/api/meta', rotated);
    assert.equal(now.status, 200); assert.equal(now.body.caller.generation, 2);
    // D41: same-size rewrite in place, then restore atime/mtime — the digest, not a stat signature, decides.
    const stat = fs.statSync(ctx.file);
    const next = mintToken(2);
    const bytes = profileBytes([grant('example-a', 'exa', [TARGETS.a, TARGETS.shared], next, { generation: 2, notBefore: ctx.notBefore }),
      ...baseGrants().slice(1)]);
    assert.equal(bytes.length, stat.size, 'same size');
    const fd = fs.openSync(ctx.file, 'r+');
    try { fs.writeSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
    fs.utimesSync(ctx.file, stat.atime, stat.mtime);
    assert.equal((await preq('/api/meta', rotated)).status, 401, 'D41 old token refused on the next request');
    assert.equal((await preq('/api/meta', next)).status, 200);
  } finally { writeProfiles(ctx.file, baseGrants()); }
});

test('D19/D21/D22: revoke, unsafe file → 503 for profiles while E1 stays 200, re-fix without restart', { skip: SKIP }, async () => {
  try {
    writeProfiles(ctx.file, baseGrants().filter((g) => g.profile !== 'example-c'));
    assert.equal((await preq('/api/meta', ctx.tok.c)).status, 401, 'D19 revoked');
    assert.equal((await preq('/api/meta', ctx.tok.a)).status, 200, 'others undisturbed');
    writeProfiles(ctx.file, baseGrants());
    const unsafe = [
      ['group-readable', () => fs.chmodSync(ctx.file, 0o640), () => fs.chmodSync(ctx.file, 0o600)],
      ['symlinked', () => { fs.renameSync(ctx.file, `${ctx.file}.real`); fs.symlinkSync(`${ctx.file}.real`, ctx.file); },
        () => { fs.unlinkSync(ctx.file); fs.renameSync(`${ctx.file}.real`, ctx.file); }],
      ['hardlinked', () => fs.linkSync(ctx.file, `${ctx.file}.link`), () => fs.unlinkSync(`${ctx.file}.link`)],
      ['corrupt', () => fs.writeFileSync(ctx.file, '{"schema":'), () => writeProfiles(ctx.file, baseGrants())],
    ];
    for (const [label, breakIt, fixIt] of unsafe) {
      breakIt();
      try {
        const res = await preq('/api/meta', ctx.tok.a);
        assert.equal(res.status, 503, `D21 ${label}`);
        assert.equal(res.body.code, 'PROFILE_REGISTRY_UNAVAILABLE');
        assert.equal((await ctx.daemon.request('/api/meta')).status, 200, `D21 ${label}: E1 unaffected`);
        const reserved = await ctx.daemon.registerSession(`exa-i${hex32()}`);
        assert.equal(reserved.status, 403, `D21 ${label}: namespaces stay reserved from the last good file`);
      } finally { fixIt(); }
      assert.equal((await preq('/api/meta', ctx.tok.a)).status, 200, `D22 ${label} re-fixed without restart`);
    }
  } finally { writeProfiles(ctx.file, baseGrants()); }
});

test('D42: a revocation does not cancel an admitted in-flight inject; the next request is refused', { skip: SKIP }, async () => {
  const A = await createInbox(ctx.tok.a, 'exa');
  const target = `/t-${TARGETS.a}`;
  const before = ctx.rx.count(target);
  ctx.rx.holdPath(target);
  try {
    const pending = injectAs(ctx.tok.a, A.bearer, TARGETS.a, A.id);
    await waitFor(() => ctx.rx.count(target) === before + 1, { timeoutMs: 5000, description: 'held delivery' });
    writeProfiles(ctx.file, baseGrants().filter((g) => g.profile !== 'example-a'));
    assert.equal((await preq('/api/meta', ctx.tok.a)).status, 401, 'the next gate sees the revocation');
    ctx.rx.release();
    assert.equal((await pending).status, 200, 'the admitted request completes (documented linearization)');
  } finally { ctx.rx.release(); writeProfiles(ctx.file, baseGrants()); }
});

test('D34: a re-granted prefix with a fresh not_before sees none of the previous holder\'s inbox or history', { skip: SKIP }, async () => {
  const old = await createInbox(ctx.tok.a, 'exa');
  const oldInject = await injectAs(ctx.tok.a, old.bearer, TARGETS.a, old.id);
  assert.equal(oldInject.status, 200);
  await auditLine((l) => l.inject_id === oldInject.body.inject_id);
  await delay(20);
  const tokD = mintToken(1);
  try {
    writeProfiles(ctx.file, [grant('example-d', 'exa', [TARGETS.a], tokD, { notBefore: iso(Date.now()) }), ...baseGrants().slice(1)]);
    assert.equal((await preq('/api/meta', ctx.tok.a)).status, 401, 'the previous holder is revoked');
    const list = await preq('/api/sessions', tokD);
    assert.ok(!list.body.some((item) => item.id === old.id), 'D34 leftover inbox not listed');
    // CF1: a late reply addressed to the previous holder's still-LIVE inbox after the re-grant is not D's history.
    const late = await ctx.daemon.request(`/api/sessions/${old.id}/inject`, { method: 'POST', body: { prompt: 'late reply' } });
    assert.equal(late.status, 200, 'E1 late reply reaches the old live inbox');
    await auditLine((l) => l.inject_id === late.body.inject_id);
    await assertDeniedUnchanged('D34/CF1 to=<old live inbox> (post-grant late reply)', () => preq(`/api/injects?to=${old.id}`, tokD), 403, 'PROFILE_READ_DENIED');
    await assertDeniedUnchanged('D34/CF1 from=<old live inbox>', () => preq(`/api/injects?from=${old.id}&to=${TARGETS.a}`, tokD), 403, 'PROFILE_READ_DENIED');
    const obs = await preq(`/api/inject-observations/${oldInject.body.inject_id}`, tokD);
    assert.equal(obs.body.reason, 'not_observed_by_daemon_epoch', 'D34 uniform body');
    await assertDeniedUnchanged('D34 delete leftover', () => preq(`/api/sessions/${old.id}?owned=true`, tokD, { method: 'DELETE',
      headers: { 'x-telepty-session-token': old.bearer } }), 403, 'PROFILE_NAMESPACE_DENIED');
    await assertDeniedUnchanged('D34 send as leftover', () => injectAs(tokD, old.bearer, TARGETS.a, old.id), 403, 'PROFILE_SENDER_DENIED');
    const fresh = await createInbox(tokD, 'exa');
    assert.equal(fresh.res.status, 201, 'the new holder operates its own fresh inbox');
    const freshSend = await injectAs(tokD, fresh.bearer, TARGETS.a, fresh.id);
    assert.equal(freshSend.status, 200);
    const reply = await ctx.daemon.request(`/api/sessions/${fresh.id}/inject`, { method: 'POST', body: { prompt: 'reply to fresh' } });
    assert.equal(reply.status, 200);
    const replies = await waitFor(async () => {
      const res = await preq(`/api/injects?to=${fresh.id}`, tokD);
      return res.status === 200 && res.body.injects.some((r) => r.inject_id === reply.body.inject_id) ? res : null;
    }, { timeoutMs: 5000, description: 'fresh own reply row' });
    assert.ok(replies.body.injects.every((r) => r.to === fresh.id), 'CF1 positive: fresh own inbox rows stay readable');
    const sent = await preq(`/api/injects?from=${fresh.id}&to=${TARGETS.a}`, tokD);
    assert.equal(sent.status, 200, 'CF1 positive: fresh own sender + granted target');
  } finally { writeProfiles(ctx.file, baseGrants()); }
});

// ── CF2: every creation route honours namespace reservation ──────────────────────────────────────────────────────

test('CF2: E1 spawn and owner/viewer WS auto-register into a profile namespace are refused before any effect', { skip: SKIP }, async () => {
  const root = ctx.daemon.authToken();
  const spawnId = `exa-i${hex32()}`, ownerId = `exb-i${hex32()}`, viewerId = `exa-i${hex32()}`;
  await assertDeniedUnchanged('CF2 spawn', () => ctx.daemon.spawnSession(spawnId), 403, 'PROFILE_NAMESPACE_RESERVED');
  await assertDeniedUnchanged('CF2 WS owner auto-register', () => rawRequest(ctx.daemon.port, { target: `/api/sessions/${ownerId}?owner=1`,
    upgrade: true, headers: [['x-telepty-token', root]] }), 403, 'PROFILE_NAMESPACE_RESERVED');
  await assertDeniedUnchanged('CF2 WS viewer auto-register', () => rawRequest(ctx.daemon.port, { target: `/api/sessions/${viewerId}`,
    upgrade: true, headers: [['x-telepty-token', root]] }), 403, 'PROFILE_NAMESPACE_RESERVED');
  const listed = (await ctx.daemon.request('/api/sessions')).body.map((item) => item.id);
  for (const id of [spawnId, ownerId, viewerId]) assert.ok(!listed.includes(id), `CF2 ${id} never created`);
  for (const token of [ctx.tok.a, ctx.tok.b]) {
    const own = (await preq('/api/sessions', token)).body.map((item) => item.id);
    for (const id of [spawnId, ownerId, viewerId]) assert.ok(!own.includes(id), 'CF2 nothing planted in a profile view');
  }
  // Outside every namespace both routes keep their legacy behaviour.
  const outsideSpawn = `cp-spawn-${hex32().slice(0, 8)}`;
  assert.equal((await ctx.daemon.spawnSession(outsideSpawn)).status, 201, 'CF2 outside-namespace spawn unchanged');
  const outsideWs = `cp-ws-${hex32().slice(0, 8)}`;
  const ws = await rawRequest(ctx.daemon.port, { target: `/api/sessions/${outsideWs}?owner=1`, upgrade: true, headers: [['x-telepty-token', root]] });
  assert.equal(ws.status, 101, 'CF2 outside-namespace WS auto-register unchanged');
  // An EXISTING namespace session is not "created" by an attach, so the reservation does not apply to it.
  const A = await createInbox(ctx.tok.a, 'exa');
  const attach = await rawRequest(ctx.daemon.port, { target: `/api/sessions/${A.id}`, upgrade: true, headers: [['x-telepty-token', root]] });
  assert.equal(attach.status, 101, 'CF2 E1 attach to an existing session unchanged');
});

// ── C1: the profile carrier never replaces the live #815 bearer checks ─────────────────────────────────────────

test('C1: stale-epoch, forged-epoch, tampered, missing and foreign bearers are refused for inject and delete; fresh own positives', { skip: SKIP }, async () => {
  const B = await createInbox(ctx.tok.b, 'exb');
  const X = await createInbox(ctx.tok.a, 'exa');
  assert.equal(X.res.status, 201);
  const [epoch, secret] = X.bearer.split('.');
  const bearers = [
    ['forged epoch', `${crypto.randomBytes(16).toString('base64url')}.${secret}`],
    ['tampered secret', `${epoch}.${crypto.randomBytes(32).toString('base64url')}`],
    ['missing', null],
    ['foreign (B inbox)', B.bearer],
  ];
  const del = (bearer) => () => preq(`/api/sessions/${X.id}?owned=true`, ctx.tok.a, { method: 'DELETE',
    headers: bearer ? { 'x-telepty-session-token': bearer } : {} });
  for (const [label, bearer] of bearers) {
    await assertDeniedUnchanged(`C1 inject ${label}`, () => injectAs(ctx.tok.a, bearer, TARGETS.a, X.id), 403, 'PROFILE_SENDER_DENIED');
    await assertDeniedUnchanged(`C1 delete ${label}`, del(bearer), 403, 'OWNED_DELETE_FORBIDDEN');
  }
  // Stale epoch: the SAME id recreated is a new instance; the predecessor's bearer is dead for both operations.
  assert.equal((await del(X.bearer)()).status, 200, 'C1 positive: owned delete with the live bearer');
  await waitFor(async () => !(await preq('/api/sessions', ctx.tok.a)).body.some((item) => item.id === X.id), { timeoutMs: 5000, description: 'inbox gone' });
  const again = await createInbox(ctx.tok.a, 'exa', X.id);
  assert.equal(again.res.status, 201, 'same id recreated');
  assert.notEqual(again.res.body.session_epoch, epoch, 'a new instance epoch');
  await assertDeniedUnchanged('C1 inject stale epoch', () => injectAs(ctx.tok.a, X.bearer, TARGETS.a, X.id), 403, 'PROFILE_SENDER_DENIED');
  await assertDeniedUnchanged('C1 delete stale epoch', () => preq(`/api/sessions/${X.id}?owned=true`, ctx.tok.a, { method: 'DELETE',
    headers: { 'x-telepty-session-token': X.bearer } }), 403, 'OWNED_DELETE_FORBIDDEN');
  assert.equal((await injectAs(ctx.tok.a, again.bearer, TARGETS.a, X.id)).status, 200, 'C1 positive: fresh own inject');
  assert.equal((await preq(`/api/sessions/${X.id}?owned=true`, ctx.tok.a, { method: 'DELETE',
    headers: { 'x-telepty-session-token': again.bearer } })).status, 200, 'C1 positive: fresh own delete');
  // Generation-only mismatch cannot be produced for an aterm inbox on a real daemon (generation moves only through
  // mailbox takeover / cooperative handoff); the gate's generation check is a unit row in client-profile-scope.test.js.
});

// ── C2: the registration response discloses only the caller's own bearer ───────────────────────────────────────

test('C2: register/meta/list bodies carry no host, profile or other-inbox credential, verifier or endpoint path', { skip: SKIP }, async () => {
  const B = await createInbox(ctx.tok.b, 'exb');
  const A = await createInbox(ctx.tok.a, 'exa');
  assert.equal(A.res.status, 201);
  assert.deepEqual(Object.keys(A.res.body).sort(), ['command', 'credential_generation', 'cwd', 'provenance_capable', 'session_epoch',
    'session_id', 'session_nonce', 'session_token', 'type'], 'C2 exact register response shape');
  assert.equal(A.res.body.session_id, A.id);
  assert.ok(A.res.body.session_token.startsWith(`${A.res.body.session_epoch}.`), 'C2 the bearer is this instance\'s own');
  assert.equal((await injectAs(ctx.tok.a, A.bearer, TARGETS.a, A.id)).status, 200, 'C2 the returned bearer is usable by its owner');
  const meta = await preq('/api/meta', ctx.tok.a);
  const list = await preq('/api/sessions', ctx.tok.a);
  const stored = readOrNull(ctx.sessionsPath).toString('utf8');
  const storedVerifiers = [...stored.matchAll(/"credentialVerifier"\s*:\s*"([0-9a-f]{64})"/g)].map((m) => m[1]);
  assert.ok(storedVerifiers.length > 0, 'fixture: persisted verifiers exist to check against');
  const forbidden = [
    ['host token', ctx.daemon.authToken()], ['profile A token', ctx.tok.a], ['profile B token', ctx.tok.b], ['profile C token', ctx.tok.c],
    ['B inbox bearer', B.bearer], ['own endpoint path', A.endpointPath], ['B endpoint path', B.endpointPath],
    ...baseGrants().map((g) => [`${g.profile} verifier`, g.token_verifier.slice(7)]),
    ...storedVerifiers.map((v) => ['stored credentialVerifier', v]),
    ...Object.values(TARGETS).map((id) => ['target endpoint path', `/t-${id}`]),
    ['field deliveryEndpoint', 'deliveryEndpoint'], ['field delivery_endpoint', 'delivery_endpoint'], ['field credentialVerifier', 'credentialVerifier'],
    ['verifier prefix', 'sha256:'],
  ];
  for (const [where, res] of [['register', A.res], ['meta', meta], ['list', list]]) {
    for (const [label, secret] of forbidden) assert.ok(!res.text.includes(secret), `C2 ${where} must not disclose ${label}`);
  }
  assert.ok(!meta.text.includes(A.bearer) && !list.text.includes(A.bearer), 'C2 the own bearer is returned once, at creation only');
});

// ── a grant that is not yet in force cannot create (item 5) ───────────────────────────────────────────────────────

test('future not_before: register is refused with PROFILE_CREATE_DENIED before any mutation; due grants keep positives', { skip: SKIP }, async () => {
  try {
    writeProfiles(ctx.file, [grant('example-a', 'exa', [TARGETS.a, TARGETS.shared], ctx.tok.a, { notBefore: iso(Date.now() + 86_400_000) }),
      ...baseGrants().slice(1)]);
    await assertDeniedUnchanged('future not_before register', () => preq('/api/sessions/register', ctx.tok.a, { method: 'POST', body: {
      session_id: `exa-i${hex32()}`, delivery_type: 'aterm', delivery_endpoint: `http://127.0.0.1:${ctx.rx.port}/${secretPath()}`, create_only: true } }),
    403, 'PROFILE_CREATE_DENIED');
    assert.equal((await preq('/api/meta', ctx.tok.a)).status, 200, 'the credential itself is valid');
    assert.equal((await createInbox(ctx.tok.b, 'exb')).res.status, 201, 'another, due grant is unaffected');
  } finally { writeProfiles(ctx.file, baseGrants()); }
  assert.equal((await createInbox(ctx.tok.a, 'exa')).res.status, 201, 'due again ⇒ create positive');
});

// ── loopback only on a shared non-loopback listener (D40) ───────────────────────────────────────────────────────

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) if (item.family === 'IPv4' && !item.internal) return item.address;
  }
  return null;
}
const LAN = WIN ? null : lanAddress();

test('D40: a profile token arriving from a non-loopback socket is 403 even on the same app', { skip: WIN ? SKIP : (LAN ? false : 'no non-loopback IPv4 interface on this host') }, async () => {
  const root = privateRoot();
  const file = path.join(root, 'keys', 'profiles.json');
  const tok = mintToken();
  writeProfiles(file, [grant('example-a', 'exa', ['cpa-target'], tok)]);
  const daemon = await startTestDaemon({ host: '0.0.0.0', env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: file, TELEPTY_PEER_ALLOWLIST: LAN } });
  try {
    const remote = await rawRequest(daemon.port, { host: LAN, headers: [['x-telepty-client-token', tok]] });
    assert.equal(remote.status, 403);
    assert.equal(remote.body.code, 'PROFILE_REMOTE_DENIED');
    const local = await rawRequest(daemon.port, { host: '127.0.0.1', headers: [['x-telepty-client-token', tok]] });
    assert.equal(local.status, 200, 'the same token over loopback is admitted');
  } finally { await daemon.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ── feature off is 0.10.1 (U3) ───────────────────────────────────────────────────────────────────────────────────

test('U3: unconfigured daemon — no capability, no caller, the profile header means nothing, no reservation', { skip: SKIP }, async () => {
  const daemon = await startTestDaemon({ env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: '' } });
  try {
    const meta = await daemon.request('/api/meta');
    assert.deepEqual(meta.body.capabilities, LEGACY_CAPABILITIES);
    assert.ok(!Object.prototype.hasOwnProperty.call(meta.body, 'caller'));
    const tok = mintToken();
    const only = await daemon.request('/api/meta', { noAuth: true, headers: as(tok) });
    assert.equal(only.status, 401);
    assert.equal(only.body.code, 'PERMISSION_DENIED');
    const both = await daemon.request('/api/meta', { headers: as(tok) });
    assert.equal(both.status, 200, 'root token still admits; the extra header is ignored');
    const ns = await daemon.registerSession(`exa-i${hex32()}`);
    assert.equal(ns.status, 201, 'no namespace reservation when off');
    const rootToken = JSON.parse(fs.readFileSync(path.join(daemon.homeDir, '.telepty', 'config.json'), 'utf8')).authToken;
    const ws = await rawRequest(daemon.port, { target: '/api/bus', upgrade: true, headers: [['x-telepty-client-token', tok], ['x-telepty-token', rootToken]] });
    assert.equal(ws.status, 101, 'legacy WebSocket admission unchanged');
    const nsWs = await rawRequest(daemon.port, { target: `/api/sessions/exa-i${hex32()}?owner=1`, upgrade: true, headers: [['x-telepty-token', rootToken]] });
    assert.equal(nsWs.status, 101, 'CF2 feature off: no namespace reservation on WS auto-register');
  } finally { await daemon.stop(); }
});

// ── startup policy (D43, F8, U4, config key) ─────────────────────────────────────────────────────────────────────

async function bootFails(options) {
  try { const daemon = await startTestDaemon(options); await daemon.stop(); return null; } catch (error) { return String(error && error.message); }
}
function configFile(root, settings) {
  const file = path.join(root, 'home', '.telepty', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ authToken: `cpd-${crypto.randomUUID()}`, ...settings }), { mode: 0o600 });
  return file;
}

test('D43/F8: a configured but corrupt, unsafe or mis-set profiles file refuses start, naming no path', { skip: SKIP, timeout: 120_000 }, async () => {
  const root = privateRoot();
  try {
    const file = path.join(root, 'keys', 'profiles.json');
    fs.writeFileSync(file, '{"schema":', { mode: 0o600 });
    const corrupt = await bootFails({ env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: file } });
    assert.match(corrupt || '', /CLIENT_PROFILES_UNAVAILABLE/, 'D43 corrupt ⇒ refuse start');
    assert.ok(!(corrupt || '').includes(root), 'no path in the refusal');
    fs.writeFileSync(file, profileBytes([grant('a', 'exa', ['broadcast'], mintToken())]));
    assert.match(await bootFails({ env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: file } }) || '', /CLIENT_PROFILES_UNAVAILABLE/, 'D32 reserved target ⇒ refuse');
    writeProfiles(file, [grant('a', 'exa', ['t1'], mintToken())]);
    fs.chmodSync(file, 0o644);
    assert.match(await bootFails({ env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: file } }) || '', /CLIENT_PROFILES_UNAVAILABLE/, 'world-readable ⇒ refuse');
    configFile(root, { clientProfilesFile: 'relative/profiles.json' });
    assert.match(await bootFails({ homeDir: path.join(root, 'home'), env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: '' } }) || '',
      /CLIENT_PROFILES_UNAVAILABLE[^\n]*path_invalid/, 'invalid config key ⇒ refuse');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('config key: a service-managed daemon (no env) enables profiles from clientProfilesFile', { skip: SKIP, timeout: 60_000 }, async () => {
  const root = privateRoot();
  const file = path.join(root, 'keys', 'profiles.json');
  const tok = mintToken();
  writeProfiles(file, [grant('example-a', 'exa', ['cpa-target'], tok)]);
  configFile(root, { clientProfilesFile: file });
  const daemon = await startTestDaemon({ homeDir: path.join(root, 'home'), env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: '' } });
  try {
    const meta = await daemon.request('/api/meta', { noAuth: true, headers: as(tok) });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.caller.profile, 'example-a');
  } finally { await daemon.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('U4: strict principal mode + client profiles refuses start with CLIENT_PROFILES_MODE_CONFLICT', { skip: SKIP, timeout: 60_000 }, async () => {
  const root = privateRoot();
  try {
    const file = path.join(root, 'keys', 'profiles.json');
    writeProfiles(file, [grant('example-a', 'exa', ['cpa-target'], mintToken())]);
    const pair = crypto.generateKeyPairSync('ed25519');
    const trust = path.join(root, 'keys', 'trust.json');
    fs.writeFileSync(trust, JSON.stringify({ schema: 'telepty.principals/v1', audience: 'cpd-audience', keys: [{ key_id: 'operator-key',
      principal_id: 'operator', authority: 'operator', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      grants: [{ action: 'session.register', targets: ['cpd-orchestrator'] }] }] }), { mode: 0o600 });
    const message = await bootFails({ env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: file, TELEPTY_PRINCIPAL_MODE: 'strict',
      TELEPTY_PRINCIPAL_TRUST_FILE: trust, TELEPTY_MACHINE_ID: 'cpd-audience' } });
    assert.match(message || '', /CLIENT_PROFILES_MODE_CONFLICT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── native Windows: refusal only (W1) ────────────────────────────────────────────────────────────────────────────

test('W1: on native Windows a configured profiles file refuses daemon start (profile scope unsupported)', { skip: WIN ? false : 'win32-only row', timeout: 60_000 }, async () => {
  const file = path.join(path.resolve(os.tmpdir()), `telepty-cpd-${hex32()}.json`);
  const message = await bootFails({ env: { ...BASE_ENV, TELEPTY_CLIENT_PROFILES_FILE: file } });
  assert.match(message || '', /CLIENT_PROFILES_UNAVAILABLE[^\n]*platform_unsupported/);
  assert.ok(!(message || '').includes(file), 'no path in the refusal');
});
