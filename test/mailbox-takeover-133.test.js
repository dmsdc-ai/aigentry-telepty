'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { createSessionRecordContext } = require('../src/routes/session-records');
const persistence = require('../src/session-store/persistence');
const { validateTrustConfiguration, createSignedAssertion } = require('../src/principal/proof');
const { createPrincipalAuthentication } = require('../src/principal/http');
const { registerMailboxTakeoverRoute } = require('../src/principal/takeover');
const NOW = 1700000000000;

function fixture(t, {withMessage = false, beforeLocked} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-takeover-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'sessions.json'), credentials = createCredentialStore(), issued = credentials.issue('mail');
  const sessions = { mail: { id: 'mail', type: 'mailbox', sessionEpoch: issued.epoch, credentialVerifier: issued.verifier,
    credentialGeneration: 1, leaseExpiresAt: NOW - 1, ownerPid: null, ptyPid: null, ownerWs: null,
    owningPrincipal: { id: 'alice', source: 'ed25519', audience: 'fixture-node' }, requireOwnerProof: true } };
  const context = createSessionRecordContext({ sessions, sessionCredentials: credentials, sidNonces: new Map([['mail', 'old-nonce']]), sessionPersistPath: file });
  context.persistSessions();
  const pair = crypto.generateKeyPairSync('ed25519');
  const trust = validateTrustConfiguration({ schema: 'telepty.principals/v1', audience: 'fixture-node', keys: [{ key_id: 'alice',
    principal_id: 'alice', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    grants: [{ action: 'session.takeover', targets: ['mail'] }] }] }, { audience: 'fixture-node' });
  const authentication = createPrincipalAuthentication({ trust, sessions, now: () => NOW });
  const messages = withMessage ? [{ msg_id: 'message-1', from: 'original-unverified-sender', created_at: 1699999000,
    state: 'pending', payload: 'original synthetic text' }] : [];
  const beforeMessages = structuredClone(messages), events = [];
  let handler;
  registerMailboxTakeoverRoute({ post: (_path, route) => { handler = route; } }, { context, getMailbox: () => ({ withCustodySnapshot: (_id, callback) => { if (beforeLocked) beforeLocked(sessions.mail); return callback(messages); } }),
    now: () => NOW, broadcastSessionEvent: (...args) => events.push(args) });
  function request({ expectedEpoch = sessions.mail.sessionEpoch, body = {}, authenticate = true, beforeHandle } = {}) {
    const payload = { expected_epoch: expectedEpoch, ...body };
    const req = { method: 'POST', originalUrl: '/api/sessions/mail/takeover', url: '/api/sessions/mail/takeover',
      params: { id: 'mail' }, body: payload, principalRawBody: Buffer.from(JSON.stringify(payload)), headers: {} };
    if (authenticate) {
      req.headers['x-telepty-principal'] = createSignedAssertion({ privateKey: pair.privateKey, keyId: 'alice', principalId: 'alice',
        audience: 'fixture-node', challenge: authentication.verifier.challenge, issuedAt: NOW / 1000,
        method: 'POST', target: req.originalUrl, action: 'session.takeover', body: payload, sessionEpoch: expectedEpoch });
      const admitted = authentication.authorize(req);
      if (!admitted.ok) return { statusCode: admitted.status, body: admitted };
    }
    if (beforeHandle) beforeHandle();
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handler(req, res);
    return res;
  }
  return { sessions, context, credentials, issued, request, file, messages, beforeMessages, events };
}

test('expired same-principal empty-mailbox takeover rotates authority with a durable audit', t => {
  const f = fixture(t), oldEpoch = f.issued.epoch;
  const result = f.request();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.notEqual(result.body.session_epoch, oldEpoch);
  assert.equal(result.body.credential_generation, 2);
  assert.equal(f.credentials.verify(f.issued.bearer), null);
  assert.equal(f.credentials.verify(result.body.session_token).epoch, result.body.session_epoch);
  assert.deepEqual(f.messages, f.beforeMessages);
  const disk = persistence.loadPersistedSessions(f.file).mail;
  assert.equal(disk.sessionEpoch, result.body.session_epoch);
  assert.equal(disk.authorityAudit.at(-1).actor.id, 'alice');
  assert.equal(disk.authorityAudit.at(-1).previous_epoch, oldEpoch);
  assert.equal(disk.authorityAudit.at(-1).previous_owner_state, 'mailbox_lease_expired');
  assert.equal(disk.authorityAudit.at(-1).pending_count, 0);
  assert.equal(JSON.stringify(disk).includes(result.body.session_token), false);
  assert.equal(persistence.buildRestoredWrappedSession('mail', disk).authorityAudit.at(-1).next_epoch, result.body.session_epoch);
  assert.equal(f.events.length, 1);
});

test('takeover requires fresh strict principal proof and exact expected epoch; shared-equivalent metadata refuses', t => {
  const f = fixture(t);
  assert.equal(f.request({ authenticate: false }).statusCode, 403);
  assert.equal(f.request({ expectedEpoch: 'wrong-epoch' }).statusCode, 401);
  assert.equal(f.credentials.verify(f.issued.bearer).epoch, f.issued.epoch);
  assert.deepEqual(f.events, []);
});

for (const state of ['active', 'wrapped', 'closing', 'process']) test(`takeover refuses ${state} incumbents without authority change`, t => {
  const f = fixture(t);
  if (state === 'active') f.sessions.mail.leaseExpiresAt = NOW + 10000;
  if (state === 'wrapped') f.sessions.mail.type = 'wrapped';
  if (state === 'closing') f.sessions.mail.isClosing = true;
  if (state === 'process') f.sessions.mail.ownerPid = 123;
  const result = f.request();
  assert.equal(result.statusCode, 409);
  assert.ok(f.credentials.verify(f.issued.bearer));
  assert.deepEqual(f.messages, f.beforeMessages);
  assert.deepEqual(f.events, []);
});

test('failed atomic takeover save preserves the old epoch, verifier, nonce, pending messages and audit', t => {
  const f = fixture(t), old = { ...f.sessions.mail };
  t.mock.method(fs, 'renameSync', () => { throw new Error('synthetic disk failure'); });
  const result = f.request();
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.session_token, undefined);
  assert.deepEqual(f.sessions.mail, old);
  assert.equal(f.context.sidNonces.get('mail'), 'old-nonce');
  assert.ok(f.credentials.verify(f.issued.bearer));
  assert.equal(persistence.loadPersistedSessions(f.file).mail.sessionEpoch, f.issued.epoch);
  assert.deepEqual(f.messages, f.beforeMessages);
  assert.deepEqual(f.events, []);
});

test('a second admitted request cannot rotate again after an intervening epoch transfer', t => {
  const f = fixture(t);
  let first;
  const stale = f.request({ beforeHandle: () => { first = f.request(); } });
  assert.equal(first.statusCode, 200);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.code, 'TAKEOVER_EPOCH_CHANGED');
  assert.equal(f.sessions.mail.authorityAudit.length, 1);
  assert.ok(f.credentials.verify(first.body.session_token));
});

test('post-rename directory sync failure withholds bearer and keeps the visible epoch authoritative', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory sync failure'); return sync(fd); });
  const result = f.request();
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.session_token, undefined);
  assert.notEqual(f.sessions.mail.sessionEpoch, f.issued.epoch);
  assert.equal(f.credentials.verify(f.issued.bearer), null);
  assert.equal(persistence.loadPersistedSessions(f.file).mail.sessionEpoch, f.sessions.mail.sessionEpoch);
  assert.deepEqual(f.messages, f.beforeMessages);
  assert.deepEqual(f.events, []);
});

test('historical owner-unknown or another principal never receives takeover authority', t => {
  for (const owner of [undefined, { id: 'another', source: 'ed25519', audience: 'fixture-node' }]) {
    const f = fixture(t);
    f.sessions.mail.owningPrincipal = owner;
    assert.equal(f.request().statusCode, 403);
    assert.ok(f.credentials.verify(f.issued.bearer));
    assert.deepEqual(f.events, []);
  }
});

for (const withMessage of [false, true]) test(`real HTTP expired-mailbox ${withMessage ? 'refuses exposed pending bytes' : 'transfers empty custody'} across restart`, { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const { startTestDaemon } = require('../test-support/daemon-harness');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-takeover-http-'));
  const pair = crypto.generateKeyPairSync('ed25519');
  const trustFile = path.join(home, 'public-trust.json');
  fs.writeFileSync(trustFile, JSON.stringify({ schema: 'telepty.principals/v1', audience: 'fixture-node', keys: [{
    key_id: 'alice', principal_id: 'alice', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    grants: ['session.register', 'session.inspect', 'session.inject', 'session.takeover', 'mailbox.read', 'mailbox.renew'].map(action => ({ action, targets: ['mail'] }))
  }] }), { mode: 0o600 });
  const env = { TELEPTY_PRINCIPAL_MODE: 'strict', TELEPTY_PRINCIPAL_TRUST_FILE: trustFile, TELEPTY_MACHINE_ID: 'fixture-node' };
  let daemon = await startTestDaemon({ homeDir: home, env });
  t.after(async () => { if (daemon) await daemon.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  let challenge = (await daemon.request('/api/auth/challenge')).body.challenge;
  async function request(target, action, body, { method = 'GET', epoch, bearer } = {}) {
    const proof = createSignedAssertion({ privateKey: pair.privateKey, keyId: 'alice', principalId: 'alice', audience: 'fixture-node',
      challenge, target, action, body, method, sessionEpoch: epoch });
    return daemon.request(target, { method, ...(body === undefined ? {} : { body }), headers: { 'x-telepty-principal': proof,
      ...(bearer ? { 'x-telepty-session-token': bearer } : {}) } });
  }
  const registered = await request('/api/sessions/register', 'session.register', { session_id: 'mail', delivery_type: 'mailbox', lease_seconds: 1 }, { method: 'POST' });
  assert.equal(registered.status, 201);
  if (withMessage) {
  const injected = await request('/api/sessions/mail/inject', 'session.inject', { prompt: 'original synthetic mailbox text', from: 'orchestrator' }, { method: 'POST' });
  assert.equal(injected.status, 200);
  }
  const original = (await request('/api/sessions/mail/mailbox', 'mailbox.read')).body.pending;
  assert.equal(original.length, withMessage ? 1 : 0);
  await new Promise(resolve => setTimeout(resolve, 1050));
  const transferred = await request('/api/sessions/mail/takeover', 'session.takeover', { expected_epoch: registered.body.session_epoch },
    { method: 'POST', epoch: registered.body.session_epoch });
  if (withMessage) {
    assert.equal(transferred.status, 409);assert.equal(transferred.body.code, 'TAKEOVER_PENDING_UNPROVEN');assert.equal(transferred.body.session_token, undefined);
    assert.deepEqual((await request('/api/sessions/mail/mailbox', 'mailbox.read')).body.pending, original);
    assert.equal((await request('/api/sessions/mail/lease', 'mailbox.renew', {lease_seconds:60}, {method:'POST',epoch:registered.body.session_epoch,bearer:registered.body.session_token})).status, 200);
    await daemon.kill();daemon=await startTestDaemon({homeDir:home,env});challenge=(await daemon.request('/api/auth/challenge')).body.challenge;
    const retained=await request('/api/sessions/mail','session.inspect');assert.equal(retained.body.handshake.session_epoch,registered.body.session_epoch);
    assert.deepEqual((await request('/api/sessions/mail/mailbox','mailbox.read')).body.pending,original);return;
  }
  assert.equal(transferred.status, 200);
  const nextEpoch = transferred.body.session_epoch;
  assert.notEqual(nextEpoch, registered.body.session_epoch);
  const renew = { lease_seconds: 60 };
  assert.equal((await request('/api/sessions/mail/lease', 'mailbox.renew', renew, { method: 'POST', epoch: nextEpoch, bearer: registered.body.session_token })).status, 403);
  assert.equal((await request('/api/sessions/mail/lease', 'mailbox.renew', renew, { method: 'POST', epoch: nextEpoch, bearer: transferred.body.session_token })).status, 200);
  assert.deepEqual((await request('/api/sessions/mail/mailbox', 'mailbox.read')).body.pending, original);
  await daemon.kill();
  daemon = await startTestDaemon({ homeDir: home, env });
  challenge = (await daemon.request('/api/auth/challenge')).body.challenge;
  const restored = await request('/api/sessions/mail', 'session.inspect');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.handshake.session_epoch, nextEpoch);
  assert.equal(restored.body.authorityAudit.at(-1).previous_epoch, registered.body.session_epoch);
  assert.deepEqual((await request('/api/sessions/mail/mailbox', 'mailbox.read')).body.pending, original);
});

test('strict custody snapshot refuses corrupt, partial and unknown queues instead of claiming empty custody', t => {
  const { FileMailbox } = require('../src/mailbox');
  for (const corruption of ['inbox-json', 'state-json', 'missing-inbox', 'missing-state', 'missing-pending', 'duplicate-key']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-custody-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const mailbox = new FileMailbox({ root });
    mailbox.enqueue({ msg_id: 'fixture-msg', from: 'fixture', to: 'mail', payload: 'synthetic', created_at: Math.floor(Date.now() / 1000), attempt: 0 });
    const directory = path.join(root, 'mail');
    if (corruption === 'inbox-json') fs.appendFileSync(path.join(directory, 'inbox.jsonl'), '{bad-json}\n');
    if (corruption === 'state-json') fs.appendFileSync(path.join(directory, 'state.jsonl'), '{bad-json}\n');
    if (corruption === 'missing-inbox') fs.unlinkSync(path.join(directory, 'inbox.jsonl'));
    if (corruption === 'missing-state') fs.unlinkSync(path.join(directory, 'state.jsonl'));
    if (corruption === 'missing-pending') fs.writeFileSync(path.join(directory, 'state.jsonl'), '');
    if (corruption === 'duplicate-key') fs.appendFileSync(path.join(directory, 'state.jsonl'), '{"msg_id":"fixture-msg","state":"acked","state":"pending","ts":1}\n');
    assert.throws(() => mailbox.snapshotCustody('mail'), undefined, corruption);
  }
});

test('invalid audit history survives restart and later saves as a refusal marker', t => {
  const f = fixture(t);
  const disk = persistence.loadPersistedSessions(f.file);
  disk.mail.authorityAudit = [{ schema: 'unknown-authority-record' }];
  const restored = persistence.buildRestoredWrappedSession('mail', disk.mail);
  assert.equal(restored.authorityAuditInvalid, true);
  const serialized = persistence.serializePersistedSessions({ mail: restored }).mail;
  assert.equal(serialized.authorityAuditInvalid, true);
  Object.assign(f.sessions.mail, restored);
  const result = f.request();
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'TAKEOVER_AUDIT_INVALID');
  assert.ok(f.credentials.verify(f.issued.bearer));
  assert.deepEqual(f.events, []);
});

function registrationCustodyFixture(t) {
  const { FileMailbox } = require('../src/mailbox');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-registration-custody-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mailbox = new FileMailbox({ root: path.join(home, 'mailboxes') });
  const sessions = Object.create(null), credentials = createCredentialStore(), events = [];
  const context = createSessionRecordContext({ sessions, sessionCredentials: credentials, sidNonces: new Map(), sessionPersistPath: path.join(home, 'sessions.json') });
  let handler;
  require('../src/routes/session-records').registerSessionRegisterRoute({ post: (_path, fn) => { handler = fn; } },
    { context, getMailbox: () => mailbox, sessionStateManager: { register: () => events.push('register') }, busClients: new Set() });
  function register() {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handler({ body: { session_id: 'unused', delivery_type: 'mailbox' }, headers: {} }, res);
    return res;
  }
  return { mailbox, home, sessions, credentials, events, register, context };
}
for (const failure of ['write', 'file-fsync', 'directory-fsync']) test(`mailbox registration refuses ${failure} initialization failure before authority publication`, t => {
  const f = registrationCustodyFixture(t);
  if (failure === 'directory-fsync' && process.platform === 'win32') {
    // Task 1215 / #879 W4 — accepted win32 contract (src/mailbox/index.js, #879 D1; src/session-store/persistence.js):
    // win32 has no directory flush step, so this fault cannot fire there. Assert that contract instead: no
    // directory is opened or flushed, and both custody files are flushed BEFORE the 201 is returned. The POSIX
    // directory-fsync refusal below is unchanged.
    const open = fs.openSync, flush = fs.fsyncSync, fdPaths = new Map(), trace = [];
    t.mock.method(fs, 'openSync', function (target, ...rest) {
      let directory = false;
      try { directory = typeof target === 'string' && fs.lstatSync(target).isDirectory(); } catch { /* absent: not a directory */ }
      if (directory) trace.push(`open-directory:${path.basename(target)}`);
      const fd = open.call(this, target, ...rest);
      fdPaths.set(fd, typeof target === 'string' ? target : null);
      return fd;
    });
    t.mock.method(fs, 'fsyncSync', fd => {
      trace.push(fs.fstatSync(fd).isDirectory() ? 'fsync-directory' : `fsync:${path.basename(fdPaths.get(fd) || '?')}`);
      return flush(fd);
    });
    const result = f.register();
    trace.push(`response:${result.statusCode}`);
    t.mock.restoreAll();
    assert.equal(result.statusCode, 201, `win32: ${JSON.stringify(result.body)}`);
    assert.deepEqual(trace.filter(e => e.startsWith('open-directory') || e === 'fsync-directory'), [], `win32: no directory open/flush: ${JSON.stringify(trace)}`);
    for (const leaf of ['inbox.jsonl', 'state.jsonl']) {
      const flushed = trace.indexOf(`fsync:${leaf}`);
      assert.ok(flushed !== -1 && flushed < trace.indexOf('response:201'), `win32: ${leaf} is flushed before the 201: ${JSON.stringify(trace)}`);
    }
    assert.deepEqual(Object.keys(f.sessions), ['unused']);
    assert.deepEqual(f.mailbox.snapshotCustody('unused'), []);
    return;
  }
  if (failure === 'write') {
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (fd, content, ...rest) => {
      if (content === '') throw new Error('synthetic empty-file write failure');
      return write(fd, content, ...rest);
    });
  } else {
    const flush = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', fd => {
      if (failure === 'file-fsync' || fs.fstatSync(fd).isDirectory()) throw new Error('synthetic custody flush failure');
      return flush(fd);
    });
  }
  const result = f.register();
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'MAILBOX_CUSTODY_UNAVAILABLE');
  assert.equal(result.body.session_token, undefined);
  assert.deepEqual(Object.keys(f.sessions), []);
  assert.equal(f.credentials.size(), 0);
  assert.deepEqual(f.events, []);
  t.mock.restoreAll();
  if (failure === 'directory-fsync') {
    // Both components exist, so retry validates and flushes them without truncation.
    assert.equal(f.register().statusCode, 201);
    assert.deepEqual(f.mailbox.snapshotCustody('unused'), []);
  } else {
    // An incomplete attempt cannot establish empty custody; do not silently repair it.
    assert.equal(f.register().statusCode, 503);
  }
});
for (const corruption of ['missing', 'corrupt']) test(`mailbox registration preserves and refuses ${corruption} existing custody`, t => {
  const f = registrationCustodyFixture(t);
  f.mailbox.initializeCustody('unused');
  const inbox = path.join(f.mailbox.config.root, 'unused', 'inbox.jsonl');
  if (corruption === 'missing') fs.unlinkSync(inbox);
  else fs.writeFileSync(inbox, '{invalid-json}\n');
  const result = f.register();
  assert.equal(result.statusCode, 503);
  assert.deepEqual(Object.keys(f.sessions), []);
  assert.equal(f.credentials.size(), 0);
  assert.equal(fs.existsSync(inbox), corruption !== 'missing');
  if (corruption === 'corrupt') assert.equal(fs.readFileSync(inbox, 'utf8'), '{invalid-json}\n');
});
test('session-store precommit failure leaves initialized custody reusable without publishing authority', t => {
  const f = registrationCustodyFixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function(from, to) {
    if (to === path.join(f.home, 'sessions.json')) throw new Error('synthetic registry replacement failure');
    return rename.apply(fs, arguments);
  });
  assert.equal(f.register().statusCode, 503);
  assert.deepEqual(Object.keys(f.sessions), []);
  assert.equal(f.credentials.size(), 0);
  assert.deepEqual(f.mailbox.snapshotCustody('unused'), []);
  fs.renameSync.mock.restore();
  assert.equal(fs.renameSync, rename);
  assert.equal(f.register().statusCode, 201);
});
test('initializing existing valid custody preserves pending message bytes and journal', t => {
  const f = registrationCustodyFixture(t);
  f.mailbox.enqueue({ msg_id: 'retained', from: 'synthetic-origin', to: 'unused', payload: 'retain this text', created_at: Math.floor(Date.now() / 1000), attempt: 0 });
  const dir = path.join(f.mailbox.config.root, 'unused');
  const before = ['inbox.jsonl', 'state.jsonl'].map(leaf => fs.readFileSync(path.join(dir, leaf), 'utf8'));
  assert.equal(f.register().statusCode, 201);
  assert.deepEqual(['inbox.jsonl', 'state.jsonl'].map(leaf => fs.readFileSync(path.join(dir, leaf), 'utf8')), before);
  assert.equal(f.mailbox.snapshotCustody('unused')[0].msg_id, 'retained');
});
for(const state of ['pending','in_flight'])test(`lease expiry does not prove that ${state} poll bytes can transfer to another epoch`,t=>{
 const f=fixture(t,{withMessage:true});f.messages[0].state=state;const before=fs.readFileSync(f.file,'utf8'),records=structuredClone(f.messages);
 const result=f.request();assert.equal(result.statusCode,409);assert.equal(result.body.code,'TAKEOVER_PENDING_UNPROVEN');
 assert.equal(f.sessions.mail.sessionEpoch,f.issued.epoch);assert.ok(f.credentials.verify(f.issued.bearer));assert.equal(f.sessions.mail.credentialGeneration,1);assert.deepEqual(f.messages,records);assert.deepEqual(f.events,[]);assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
test('durable custody mode refuses a flush failure before invoking an authority callback',t=>{
 const {FileMailbox}=require('../src/mailbox');const root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-custody-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const mailbox=new FileMailbox({root});mailbox.initializeCustody('fixture');
 const sync=fs.fsyncSync,inbox=fs.statSync(path.join(root,'fixture','inbox.jsonl'));t.mock.method(fs,'fsyncSync',fd=>{const st=fs.fstatSync(fd);if(st.dev===inbox.dev&&st.ino===inbox.ino)throw Error('synthetic custody flush failure');return sync(fd);});let callbacks=0;
 assert.throws(()=>mailbox.withCustodySnapshot('fixture',()=>callbacks++,{durable:true}),/custody flush failure/);assert.equal(callbacks,0);assert.deepEqual(mailbox.snapshotCustody('fixture'),[]);
});

test('locked takeover rechecks the configured owner before changing authority',t=>{
 const f=fixture(t,{beforeLocked:session=>{session.owningPrincipal={id:'different',source:'ed25519',audience:'fixture-node'};}}),before=fs.readFileSync(f.file,'utf8');
 const result=f.request();assert.equal(result.statusCode,403);assert.equal(result.body.code,'TAKEOVER_OWNER_REQUIRED');assert.equal(f.sessions.mail.sessionEpoch,f.issued.epoch);assert.ok(f.credentials.verify(f.issued.bearer));assert.deepEqual(f.events,[]);assert.equal(fs.readFileSync(f.file,'utf8'),before);
});
