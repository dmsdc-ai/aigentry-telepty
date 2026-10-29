'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const persistence = require('../src/session-store/persistence');
const { createSessionRecordContext, registerSessionRegisterRoute, registerSessionRenameRoute } = require('../src/routes/session-records');
const { createCredentialStore } = require('../src/session-store/session-credentials');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-durability-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const record = { type: 'wrapped', command: 'old', cwd: '/fixture', sessionEpoch: 'synthetic', credentialVerifier: 'synthetic' };
test('save reports a replacement failure and preserves the committed generation', t => {
    const file = path.join(temp(t), 'sessions.json');
    persistence.savePersistedSessions({ old: record }, file);
    const before = fs.readFileSync(file, 'utf8');
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('disk failure'), { code: 'EIO' }); });
    const result = persistence.savePersistedSessions({ next: record }, file);
    assert.equal(result?.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['sessions.json']);
});
test('save rejects symbolic link destination and parent without modifying their targets', { skip: process.platform === 'win32' }, t => {
    const dir = temp(t), target = path.join(dir, 'target');
    fs.writeFileSync(target, 'keep');
    const link = path.join(dir, 'sessions.json');
    fs.symlinkSync(target, link);
    assert.equal(persistence.savePersistedSessions({ next: record }, link)?.ok, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    const parent = path.join(dir, 'linked');
    fs.symlinkSync(dir, parent, 'dir');
    assert.equal(persistence.savePersistedSessions({}, path.join(parent, 'other.json'))?.ok, false);
    assert.equal(fs.existsSync(path.join(dir, 'other.json')), false);
});
test('concurrent reader sees only complete generations and final store restores verifier', async (t) => {
    const file = path.join(temp(t), 'sessions.json');
    persistence.savePersistedSessions({ old: record }, file);
    const state = new Int32Array(new SharedArrayBuffer(12));
    const worker = new Worker(`const {workerData}=require('node:worker_threads');const fs=require('node:fs');const state=new Int32Array(workerData.state);Atomics.store(state,0,1);while(!Atomics.load(state,1)){try{JSON.parse(fs.readFileSync(workerData.file,'utf8'));Atomics.add(state,2,1);}catch(e){if(e instanceof SyntaxError)throw e;}}`, { eval: true, workerData: { file, state: state.buffer } });
    const done = new Promise((resolve, reject) => { worker.on('error', reject); worker.on('exit', code => code ? reject(Error('reader failed')) : resolve()); });
    while (!Atomics.load(state, 0))
        await new Promise(resolve => setImmediate(resolve));
    try {
        for (let n = 0; n < 40; n++)
            persistence.savePersistedSessions({ next: { ...record, stateReport: 'x'.repeat(512 * 1024) } }, file);
    }
    finally {
        Atomics.store(state, 1, 1);
    }
    await done;
    assert.ok(Atomics.load(state, 2) > 0, 'reader actually observed committed bytes');
    assert.equal(persistence.loadPersistedSessions(file).next.credentialVerifier, 'synthetic');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
function routeFixture(t, failing = true) {
    const sessions = Object.create(null), sessionCredentials = createCredentialStore(), sidNonces = new Map(), events = [], states = [];
    const file = path.join(temp(t), 'sessions.json');
    const context = createSessionRecordContext({ sessions, sessionCredentials, sidNonces, sessionPersistPath: file });
    if (failing) {
        fs.mkdirSync(file);
    }
    const routes = {};
    const app = { post: (_, fn) => routes.register = fn, patch: (_, fn) => routes.rename = fn };
    const options = { context, sessionStateManager: { register: id => states.push(id), unregister: id => states.push('-' + id) }, busClients: new Set([{ readyState: 1, send: msg => events.push(JSON.parse(msg)) }]) };
    registerSessionRegisterRoute(app, options);
    registerSessionRenameRoute(app, options);
    function call(name, body, params = {}) { const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; routes[name]({ body, params, headers: {} }, res); return res; }
    return { sessions, sessionCredentials, sidNonces, events, states, file, call };
}
test('failed registration returns no credential, record, nonce, state machine or bus publication', t => {
    const f = routeFixture(t);
    const res = f.call('register', { session_id: 'worker-2' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'SESSION_STORE_WRITE_FAILED');
    assert.equal(res.body.session_token, undefined);
    assert.deepEqual(Object.keys(f.sessions), []);
    assert.equal(f.sessionCredentials.size(), 0);
    assert.equal(f.sidNonces.size, 0);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.states, []);
});
test('failed reregistration restores the original live record and metadata', t => {
    const f = routeFixture(t);
    f.sessions.worker = { id: 'worker', ...record, clients: new Set() };
    const original = f.sessions.worker;
    const before = { ...original };
    const res = f.call('register', { session_id: 'worker', command: 'changed' });
    assert.equal(res.statusCode, 503);
    assert.equal(f.sessions.worker, original);
    assert.deepEqual(original, before);
    assert.deepEqual(f.events, []);
});
test('failed rename preserves identity, credential principal, nonce and events', t => {
    const f = routeFixture(t);
    const issued = f.sessionCredentials.issue('worker');
    f.sessions.worker = { id: 'worker', ...record };
    f.sidNonces.set('worker', 'nonce');
    const res = f.call('rename', { new_id: 'renamed' }, { id: 'worker' });
    assert.equal(res.statusCode, 503);
    assert.equal(f.sessions.worker.id, 'worker');
    assert.equal(f.sessions.renamed, undefined);
    assert.equal(f.sessionCredentials.verify(issued.bearer).sid, 'worker');
    assert.equal(f.sidNonces.get('worker'), 'nonce');
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.states, []);
});
test('failed spawn persistence kills only the newly created PTY and publishes no success', t => {
    const { registerSpawnRoute } = require('../src/routes/spawn');
    let handler, killed = 0;
    const sessions = {}, events = [], states = [];
    registerSpawnRoute({ post: (_, fn) => handler = fn }, { sessions, sessionStateManager: { register: id => states.push(id) }, pty: { spawn: () => ({ pid: 123, kill: () => killed++, onData: () => { }, onExit: () => { } }) }, persistSessions: () => ({ ok: false, committed: false }), appendToOutputRing: () => { }, revokeSessionCredential: () => { }, busClients: new Set([{ readyState: 1, send: msg => events.push(msg) }]), os: { platform: () => process.platform }, buildSessionEnv: () => ({}), admission: { take: () => ({ allowed: true }) } });
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handler({ body: { session_id: 'synthetic-spawn', command: 'synthetic-command' } }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(sessions, {});
    assert.equal(killed, 1);
    assert.deepEqual(events, []);
    assert.deepEqual(states, []);
});
test('failed state-report save rolls back metadata before publishing the report', () => {
    const { createSessionActions } = require('../src/routes/session-actions');
    const events = [];
    const session = { stateReport: { phase: 'old', seq: 1 }, lastStateReportAt: 'old' };
    const before = { ...session };
    const actions = createSessionActions({ persistSessions: () => ({ ok: false, committed: false }), broadcastSessionEvent: (...args) => events.push(args), buildSessionSemanticBlock: () => ({}), buildSessionTransportBlock: () => ({}) });
    const result = actions.applySessionStateReport('fixture', session, { phase: 'next', seq: 2, thread_id: 'new' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'SESSION_STORE_WRITE_FAILED');
    assert.deepEqual(session, before);
    assert.deepEqual(events, []);
});

for (const [operation, code] of [['writeFileSync', 'ENOSPC'], ['fsyncSync', 'EIO'], ['fchmodSync', 'EACCES']]) {
    test(`${operation} failure preserves previous committed sessions and cleans temporary files`, t => {
        const dir = temp(t), file = path.join(dir, 'sessions.json');
        assert.equal(persistence.savePersistedSessions({ old: record }, file).ok, true);
        const before = fs.readFileSync(file, 'utf8');
        t.mock.method(fs, operation, () => { throw Object.assign(Error(code), { code }); });
        const result = persistence.savePersistedSessions({ next: record }, file);
        assert.equal(result.ok, false);
        assert.equal(result.committed, false);
        assert.equal(result.error.code, code);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        assert.deepEqual(fs.readdirSync(dir), ['sessions.json']);
    });
}
test('directory fsync failure identifies the visible committed generation without claiming durability', { skip: process.platform === 'win32' }, t => {
    const file = path.join(temp(t), 'sessions.json');
    persistence.savePersistedSessions({ old: record }, file);
    const sync = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isDirectory())
        throw Object.assign(Error('directory sync failed'), { code: 'EIO' }); return sync(fd); });
    const result = persistence.savePersistedSessions({ next: record }, file);
    assert.equal(result.ok, false);
    assert.equal(result.committed, true);
    assert.equal(persistence.loadPersistedSessions(file).next.command, 'old');
});
test('load rejects a symlink rather than reading or chmodding its target', { skip: process.platform === 'win32' }, t => {
    const dir = temp(t), target = path.join(dir, 'target'), file = path.join(dir, 'sessions.json');
    fs.writeFileSync(target, JSON.stringify({ secret: record }), { mode: 0o644 });
    fs.symlinkSync(target, file);
    assert.deepEqual(persistence.loadPersistedSessions(file), {});
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});
