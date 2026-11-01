'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const persistence = require('../src/session-store/persistence');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { createSessionActions } = require('../src/routes/session-actions');
const { createSessionRecordContext, registerSessionRegisterRoute, registerSessionRenameRoute } = require('../src/routes/session-records');

function fixture(t, kill = async () => ({ pid: 123, signaled: true })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-close-durability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json');
  const credentials = createCredentialStore();
  const issued = credentials.issue('worker');
  const effects = [];
  const session = { id: 'worker', type: 'wrapped', isClosing: false, sessionEpoch: issued.epoch,
    credentialVerifier: issued.verifier, credentialGeneration: issued.generation,
    clients: new Set([{ close: () => effects.push('close') }]) };
  const sessions = { worker: session };
  const context = createSessionRecordContext({ sessions, sessionCredentials: credentials, sidNonces: new Map(), sessionPersistPath: file });
  assert.equal(context.persistSessions().ok, true);
  const shared = { ...context, lifecycle: { killSessionProcess: async (...args) => { effects.push('kill'); return kill(...args); },
    cleanupSessionArtifacts: () => effects.push('artifacts') }, broadcastSessionEvent: () => effects.push('event'),
    getSessionHealthStatus: () => '', getSessionHealthReason: () => '',
    terminalBackend: { closeSurface: () => effects.push('surface') }, cancelModalParkPoll: () => effects.push('cancel'),
    sessionStateManager: { unregister: () => effects.push('unregister'), markTerminationRequested: () => effects.push('termination') },
    mailbox: { purge: () => effects.push('purge') }, resolveSessionForDestroy: id => sessions[id] ? id : null,
    isOpenWebSocket: ws => ws?.readyState === 1 };
  return { file, session, sessions, credentials, issued, context, shared, effects, actions: createSessionActions(shared) };
}
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

test('failed removal commit leaves authority intact and performs zero irreversible actions', async t => {
  const f = fixture(t);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); });
  const result = await f.actions.teardownSessionById('worker');
  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 503);
  assert.equal(f.sessions.worker, f.session);
  assert.equal(f.session.isClosing, false);
  assert.ok(f.credentials.verify(f.issued.bearer));
  assert.ok(persistence.loadPersistedSessions(f.file).worker);
  assert.deepEqual(f.effects, []);
});

test('durable removal precedes kill, stays reserved while awaiting and cannot reappear in another save', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => { await waiting; return { signaled: true }; });
  const closing = f.actions.teardownSessionById('worker');
  assert.equal(f.sessions.worker, f.session);
  assert.equal(f.session.isClosing, true);
  assert.equal(f.credentials.verify(f.issued.bearer), null);
  assert.deepEqual(persistence.loadPersistedSessions(f.file), {});
  f.sessions.other = { id: 'other', type: 'wrapped' };
  assert.equal(f.context.persistSessions().ok, true);
  const recovered = persistence.loadPersistedSessions(f.file);
  assert.equal(recovered.worker, undefined);
  assert.ok(recovered.other);
  const restartedCredentials = createCredentialStore();
  for (const [id, record] of Object.entries(recovered)) restartedCredentials.adopt(id, record);
  assert.equal(restartedCredentials.verify(f.issued.bearer), null);
  release();
  assert.equal((await closing).success, true);
  assert.equal(f.sessions.worker, undefined);
});

test('failed kill after durable removal reports unconfirmed process and never restores verifier', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('synthetic permission denied'), { code: 'EPERM' }); });
  const result = await f.actions.teardownSessionById('worker');
  assert.equal(result.success, false);
  assert.equal(result.code, 'KILL_FAILED');
  assert.equal(result.registry_removed, true);
  assert.equal(f.sessions.worker, undefined);
  assert.equal(f.credentials.verify(f.issued.bearer), null);
  assert.deepEqual(persistence.loadPersistedSessions(f.file), {});
});

test('post-rename fsync failure reserves closing instance without killing and retry can finish', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const sync = fs.fsyncSync;
  const mock = t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('synthetic directory failure'), { code: 'EIO' });
    return sync(fd);
  });
  const failed = await f.actions.teardownSessionById('worker');
  assert.equal(failed.success, false);
  assert.equal(failed.httpStatus, 503);
  assert.equal(f.session.isClosing, true);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(persistence.loadPersistedSessions(f.file), {});
  mock.mock.restore();
  assert.equal((await f.actions.teardownSessionById('worker')).success, true);
  assert.equal(f.effects.filter(item => item === 'kill').length, 1);
});

test('a replacement during kill await survives predecessor cleanup and retains its new credential', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => { await waiting; return { signaled: true }; });
  const closing = f.actions.teardownSessionById('worker');
  const replacement = { id: 'worker', type: 'wrapped', clients: new Set() };
  f.sessions.worker = replacement;
  const next = f.credentials.issue('worker');
  release();
  await closing;
  assert.equal(f.sessions.worker, replacement);
  assert.ok(f.credentials.verify(next.bearer));
  assert.equal(f.effects.includes('unregister'), false);
  assert.equal(f.effects.includes('purge'), false);
  assert.equal(f.effects.includes('artifacts'), false);
  assert.equal(f.effects.includes('surface'), false);
  assert.equal(f.effects.includes('close'), false);
});

test('DELETE refuses before any close on failed persistence', t => {
  const f = fixture(t);
  let handler;
  f.actions.registerDeleteRoute({ delete: (_path, fn) => { handler = fn; } });
  t.mock.method(fs, 'renameSync', () => { throw new Error('synthetic disk failure'); });
  const res = response();
  handler({ params: { id: 'worker' }, query: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(f.session.isClosing, false);
  assert.deepEqual(f.effects, []);
  assert.ok(f.credentials.verify(f.issued.bearer));
});

test('closing instance rejects state updates, registration and rename without publishing or saving', t => {
  const f = fixture(t);
  f.session.isClosing = true;
  f.shared.persistSessions = () => { throw new Error('closing updates must not save'); };
  assert.equal(f.actions.applySessionStateReport('worker', f.session, { phase: 'next' }).code, 'SESSION_CLOSING');
  const handlers = {};
  const app = { post: (_path, fn) => { handlers.register = fn; }, patch: (_path, fn) => { handlers.rename = fn; } };
  const options = { context: f.context, sessionStateManager: f.shared.sessionStateManager, busClients: new Set() };
  registerSessionRegisterRoute(app, options);
  registerSessionRenameRoute(app, options);
  for (const [name, body] of [['register', { session_id: 'worker', command: 'replacement' }], ['rename', { new_id: 'changed' }]]) {
    const res = response();
    handlers[name]({ body, params: { id: 'worker' }, headers: {} }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'SESSION_CLOSING');
  }
  assert.equal(f.session.id, 'worker');
  assert.deepEqual(f.effects, []);
});

test('closing instance rejects text, deferred delivery and terminal submit before adapters run', async () => {
  const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
  const { createDeliveryRuntime } = require('../src/mailbox/delivery-runtime');
  const session = { id: 'worker', type: 'wrapped', isClosing: true };
  const delivery = createSessionDeliveryContext({ sessions: { worker: session } });
  assert.equal((await delivery.writeDataToSession('worker', session, 'text')).code, 'SESSION_CLOSING');
  assert.equal((await delivery.deliverInjectionToSession('worker', session, 'text')).code, 'SESSION_CLOSING');
  const runtime = createDeliveryRuntime({});
  assert.equal(runtime.getInjectFailure(session).code, 'SESSION_CLOSING');
  assert.equal(runtime.terminalLevelSubmit('worker', session), null);
});

test('failed synchronous DELETE kill after commit is typed failure and cannot restore authority', t => {
  const f = fixture(t);
  f.session.type = 'spawned';
  f.session.ptyProcess = { kill() { throw new Error('synthetic kill failure'); } };
  let handler;
  f.actions.registerDeleteRoute({ delete: (_path, fn) => { handler = fn; } });
  const res = response();
  handler({ params: { id: 'worker' }, query: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'KILL_FAILED');
  assert.equal(res.body.registry_removed, true);
  assert.equal(f.credentials.verify(f.issued.bearer), null);
  assert.deepEqual(persistence.loadPersistedSessions(f.file), {});
});

test('idle TTL does not reclaim a namespace already reserved for closing', () => {
  const { selectIdleTtlVictims } = require('../src/lifecycle');
  assert.deepEqual(selectIdleTtlVictims({ worker: { isClosing: true, idleTtlMs: 1,
    lastActivityAt: '2020-01-01T00:00:00Z' } }, {}, { nowMs: Date.parse('2026-01-01T00:00:00Z') }), []);
});

test('mailbox delivery does not dequeue a closing namespace', () => {
  const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
  const delivery = createSessionDeliveryContext({ sessions: { closing: { isClosing: true }, live: {} } });
  assert.deepEqual(delivery.mailboxDeliveryOptions.sessionResolver(), ['live']);
});

test('a UDS connection established after close cannot write its pending payload', async () => {
  const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
  const session = { type: 'aterm', delivery: { transport: 'unix_socket', address: '/synthetic' } };
  const events = {};
  let connected, writes = 0;
  const socket = { on(type, fn) { events[type] = fn; return this; }, end() { writes++; events.end(); }, destroy() {} };
  const delivery = createSessionDeliveryContext({ sessions: { worker: session }, hasHeldInteraction: () => false,
    interaction: { invalidateInteraction() {} }, DELIVERY_TIMEOUT_MS: 1000,
    net: { connect(_address, callback) { connected = callback; return socket; } } });
  const pending = delivery.writeDataToSession('worker', session, 'synthetic payload');
  session.isClosing = true;
  connected();
  assert.equal((await pending).code, 'SESSION_CLOSING');
  assert.equal(writes, 0);
});
