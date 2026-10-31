'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBrokerAudit } = require('../src/broker/audit');
const { createBrokerHub } = require('../src/broker/hub');
const { createSignedAssertion } = require('../src/principal/proof');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-broker-audit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function pair() { return crypto.generateKeyPairSync('ed25519'); }

test('broker audit bounds overflow and exposes sanitized writer failures without retaining payload', async t => {
  const file = path.join(temp(t), 'audit.jsonl');
  const audit = createBrokerAudit({ path: file, queueMax: 1, flushMs: 60000 });
  audit.record({ event: 'request', payload: 'secret-first', principal: { id: 'node-a', keyId: 'a-key' } });
  audit.record({ event: 'request', payload: 'secret-second', principal: { id: 'node-a', keyId: 'a-key' } });
  assert.equal(audit.stats().overflow_dropped, 1);
  t.mock.method(fs.promises, 'open', async () => { throw new Error('secret-error-content'); });
  await audit.close();
  assert.equal(audit.stats().write_errors, 1);
  assert.equal(JSON.stringify(audit.stats()).includes('secret'), false);
});

test('signed hub audits admission, refusal, replay and receipt outcomes hash-only and flushes on close', async t => {
  const home = temp(t), source = pair(), receiver = pair(), hubKey = pair();
  const key = (name, owner, p, grants) => ({ key_id: name, principal_id: owner,
    public_key_spki: p.publicKey.export({ type: 'spki', format: 'pem' }), grants });
  const limits = { max_payload_bytes: 256, max_requests: 10, window_ms: 60000, timeout_ms: 100, max_pending: 4 };
  const config = { schema: 'telepty.broker-hub/v1', audience: 'hub-fixture', principal_id: 'hub', key_id: 'hub-key', stream_ms: 60000,
    nodes: { source: { audience: 'source-fixture' }, receiver: { audience: 'receiver-fixture' } }, limits: { source: limits, receiver: limits },
    trust: { schema: 'telepty.principals/v1', audience: 'hub-fixture', keys: [
      key('source-key', 'source', source, [{ action: 'broker.inject', targets: ['receiver/mail'] }, { action: 'broker.receipt', targets: ['source'] }]),
      key('receiver-key', 'receiver', receiver, [{ action: 'broker.stream', targets: ['receiver'] }, { action: 'broker.result', targets: ['receiver'] }])
    ] } };
  const file = path.join(home, 'audit.jsonl');
  const hub = createBrokerHub({ config, privateKey: hubKey.privateKey, homeDir: home,
    audit: createBrokerAudit({ path: file, flushMs: 60000 }) });
  const address = await hub.listen();
  t.after(() => hub.close());
  const origin = `http://127.0.0.1:${address.port}`;
  async function request(target, action, body, owner = 'source', method = 'POST', existingProof) {
    const proof = existingProof || createSignedAssertion({ privateKey: (owner === 'source' ? source : receiver).privateKey,
      keyId: owner + '-key', principalId: owner, audience: 'hub-fixture', challenge: hub.challenge,
      method, target, body: method === 'GET' ? {} : body, action, sessionEpoch: body && body.expected_epoch });
    const response = await fetch(origin + target, { method, headers: { 'content-type': 'application/json', 'x-telepty-assertion': proof },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { response, proof };
  }
  const stream = await request('/v1/nodes/receiver/stream', 'broker.stream', { challenge: 'synthetic-challenge-0123456789' }, 'receiver');
  const reader = stream.response.body.getReader();
  await reader.read();
  const payload = 'PRIVATE_SYNTHETIC_PROMPT_43';
  const body = { prompt: payload, expected_epoch: 'synthetic-epoch', idempotency_key: 'synthetic-idempotency-0001', no_enter: true };
  const target = '/v1/nodes/source/to/receiver/sessions/mail/inject';
  const first = await request(target, 'broker.inject', body);
  assert.equal(first.response.status, 202);
  const receipt = await first.response.json();
  const frame = await reader.read();
  assert.match(Buffer.from(frame.value).toString(), /PRIVATE_SYNTHETIC_PROMPT_43/);
  const result = await request(`/v1/nodes/receiver/results/${receipt.receipt_id}`, 'broker.result', { state: 'accepted', inject_id: 'synthetic-inject' }, 'receiver');
  assert.equal(result.response.status, 200); await result.response.arrayBuffer();
  const duplicate = await request(target, 'broker.inject', body);
  assert.equal(duplicate.response.status, 200); await duplicate.response.arrayBuffer();
  const replay = await request(target, 'broker.inject', body, 'source', 'POST', first.proof);
  assert.equal(replay.response.status, 409); await replay.response.arrayBuffer();
  const denied = await request(target.replace('/mail/', '/other/'), 'broker.inject', body);
  assert.equal(denied.response.status, 403); await denied.response.arrayBuffer();
  const unknown = await fetch(origin + '/unknown/PRIVATE_RAW_PATH_43');
  assert.equal(unknown.status, 404); await unknown.arrayBuffer();
  const timed = await request(target, 'broker.inject', { ...body, idempotency_key: 'synthetic-idempotency-0002' });
  const timedReceipt = await timed.response.json();
  await reader.read();
  await new Promise(resolve => setTimeout(resolve, 150));
  const query = await request('/v1/nodes/source/receipts/synthetic-idempotency-0002', 'broker.receipt', undefined, 'source', 'GET');
  assert.equal((await query.response.json()).state, 'outcome_unknown');
  await reader.cancel();
  await hub.close();
  const raw = fs.readFileSync(file, 'utf8'), rows = raw.trim().split('\n').map(JSON.parse);
  for (const secret of [payload, first.proof, 'PRIVATE_RAW_PATH_43', hubKey.privateKey.export({ type: 'pkcs8', format: 'pem' })]) assert.equal(raw.includes(secret), false);
  assert.ok(rows.some(row => row.broker_event === 'request' && row.broker_http_status === 409 && row.broker_code === 'PRINCIPAL_REPLAY' && row.authenticated_node_id === null));
  assert.ok(rows.some(row => row.broker_event === 'request' && row.broker_http_status === 403));
  assert.ok(rows.some(row => row.broker_event === 'request' && row.broker_http_status === 404));
  assert.equal(rows.filter(row => row.broker_event === 'envelope_forwarded').length, 2, 'idempotency retries/replay do not add a forwarding attempt');
  assert.ok(rows.some(row => row.broker_event === 'receipt_outcome' && row.broker_state === 'accepted'));
  assert.ok(rows.some(row => row.broker_event === 'receipt_outcome' && row.broker_state === 'outcome_unknown' && row.broker_receipt_id === timedReceipt.receipt_id));
  const admission = rows.find(row => row.broker_event === 'admitted');
  assert.equal(admission.payload_sha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(admission.to, 'mail');
  assert.equal(admission.broker_target_node, 'receiver');
  assert.equal(admission.authenticated_node_id, 'source');
  assert.ok(rows.filter(row => row.broker_http_status === 403).every(row => row.to === null && row.broker_target_node === null));
  assert.equal(admission.authenticated_node_key_id, 'source-key');
  for (const row of rows) {
    assert.equal(row.verified_sender_sid, null);
    assert.equal(row.claimed_from, null);
    assert.equal(row.payload_preview, null);
    assert.equal(row.origin, 'untrusted-remote');
    assert.equal(row.foreign_session_identity_verified, false);
    assert.equal(row.authenticated_identity_scope, 'broker-node');
  }
});

test('owned hub SIGTERM awaits its final audit batch', { timeout: 10000 }, async t => {
  const { spawn } = require('node:child_process');
  const { waitFor } = require('../test-support/daemon-harness');
  const home = temp(t), hubKey = pair(), source = pair();
  const keyFile = path.join(home, 'hub-key.pem');
  fs.writeFileSync(keyFile, hubKey.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const config = { schema: 'telepty.broker-hub/v1', audience: 'shutdown-fixture', principal_id: 'hub', key_id: 'hub-key', private_key_path: keyFile,
    listen: { host: '127.0.0.1', port: 0 }, stream_ms: 60000, nodes: { source: { audience: 'source-fixture' } },
    limits: { source: { max_payload_bytes: 256, max_requests: 10, window_ms: 60000, timeout_ms: 100, max_pending: 4 } },
    trust: { schema: 'telepty.principals/v1', audience: 'shutdown-fixture', keys: [{ key_id: 'source-key', principal_id: 'source',
      public_key_spki: source.publicKey.export({ type: 'spki', format: 'pem' }), grants: [{ action: 'broker.receipt', targets: ['source'] }] }] } };
  const configFile = path.join(home, 'hub.json');
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ['src/broker/main.js', 'hub', '--config', configFile], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: home, USERPROFILE: home, TELEPTY_AUDIT_PREVIEW: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const ended = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  t.after(async () => { if (!exited) { child.kill(); await ended; } });
  await waitFor(() => { assert.equal(exited, false, stderr); return stdout.match(/127\.0\.0\.1:(\d+)/); }, { description: 'owned audit hub startup' });
  const port = stdout.match(/127\.0\.0\.1:(\d+)/)[1];
  const response = await fetch(`http://127.0.0.1:${port}/unknown/SYNTHETIC_SECRET_PATH_43`);
  assert.equal(response.status, 404); await response.arrayBuffer();
  child.kill('SIGTERM');
  assert.deepEqual(await ended, { code: 0, signal: null });
  const raw = fs.readFileSync(path.join(home, '.telepty', 'logs', 'broker.jsonl'), 'utf8');
  assert.equal(raw.includes('SYNTHETIC_SECRET_PATH_43'), false);
  assert.equal(JSON.parse(raw.trim()).broker_http_status, 404);
  assert.equal(stdout.includes('SYNTHETIC_SECRET_PATH_43'), false);
  assert.equal(stderr, '');
});

for (const unsafe of ['leaf-symlink', 'hardlink', 'writable-leaf', 'ancestor-symlink', 'writable-ancestor', 'foreign-owner']) test(`broker audit refuses ${unsafe} without modifying existing paths`, { skip: process.platform !== 'linux' }, async t => {
  const home = temp(t), directory = path.join(home, 'logs'), target = path.join(home, 'outside');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(target, 'KEEP', { mode: 0o600 });
  const file = path.join(directory, 'audit.jsonl');
  let auditPath = file;
  if (unsafe === 'leaf-symlink') fs.symlinkSync(target, file);
  if (unsafe === 'hardlink') fs.linkSync(target, file);
  if (unsafe === 'writable-leaf') { fs.writeFileSync(file, 'KEEP', { mode: 0o666 }); fs.chmodSync(file, 0o666); }
  if (unsafe === 'ancestor-symlink') { fs.symlinkSync(directory, path.join(home, 'alias')); auditPath = path.join(home, 'alias', 'audit.jsonl'); }
  if (unsafe === 'writable-ancestor') fs.chmodSync(directory, 0o777);
  if (unsafe === 'foreign-owner') {
    fs.writeFileSync(file, 'KEEP', { mode: 0o600 });
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (...args) => {
      const stat = lstat(...args);
      if (path.basename(args[0]) === 'audit.jsonl') return Object.assign(Object.create(stat), { uid: process.getuid() + 1 });
      return stat;
    });
  }
  const audit = createBrokerAudit({ path: auditPath });
  audit.record({ event: 'request', payload: 'SECRET' }); await audit.close();
  assert.equal(audit.stats().write_errors, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP');
  if (unsafe === 'writable-ancestor') assert.equal(fs.statSync(directory).mode & 0o777, 0o777);
  if (unsafe === 'writable-leaf') { assert.equal(fs.readFileSync(file, 'utf8'), 'KEEP'); assert.equal(fs.statSync(file).mode & 0o777, 0o666); }
  if (unsafe === 'ancestor-symlink' || unsafe === 'writable-ancestor') assert.equal(fs.existsSync(file), false);
});

test('private audit rotation remains bounded and refuses unsafe rotated leaves', { skip: process.platform !== 'linux' }, async t => {
  const { createPrivateAuditStorage } = require('../src/broker/audit-storage');
  const home = temp(t), file = path.join(home, 'logs', 'audit.jsonl');
  const storage = createPrivateAuditStorage(file), limits = { maxBytes: 1, maxFiles: 2, maxAgeDays: 30 };
  await storage.writeBatch('one\n', limits); await storage.writeBatch('two\n', limits); await storage.writeBatch('three\n', limits);
  assert.equal(fs.readFileSync(file, 'utf8'), 'three\n');
  assert.equal(fs.readFileSync(file + '.2', 'utf8'), 'one\n');
  const outside = path.join(home, 'outside'); fs.writeFileSync(outside, 'KEEP', { mode: 0o600 });
  fs.unlinkSync(file + '.1'); fs.symlinkSync(outside, file + '.1');
  await assert.rejects(storage.writeBatch('refuse\n', limits));
  assert.equal(fs.readFileSync(file, 'utf8'), 'three\n');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('private audit closes its directory descriptor when file-handle close rejects', { skip: process.platform !== 'linux' }, async t => {
  const { createPrivateAuditStorage } = require('../src/broker/audit-storage');
  const file = path.join(temp(t), 'logs', 'audit.jsonl');
  const open = fs.promises.open, close = fs.closeSync;
  let directoryDescriptor, directoryCloseCalls = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    directoryDescriptor = Number(args[0].match(/^\/proc\/self\/fd\/(\d+)\//)[1]);
    const handle = await open(...args), closeHandle = handle.close.bind(handle);
    handle.close = async () => { await closeHandle(); throw new Error('synthetic close failure after real close'); };
    return handle;
  });
  t.mock.method(fs, 'closeSync', fd => {
    if (fd === directoryDescriptor) directoryCloseCalls++;
    return close(fd);
  });
  await assert.rejects(createPrivateAuditStorage(file).writeBatch('synthetic audit row\n', { maxBytes: 1000, maxFiles: 2, maxAgeDays: 30 }), /synthetic close failure/);
  assert.equal(directoryCloseCalls, 1);
  assert.throws(() => fs.fstatSync(directoryDescriptor), { code: 'EBADF' });
});
