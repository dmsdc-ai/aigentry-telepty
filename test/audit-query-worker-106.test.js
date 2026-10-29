'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAuditReader, registerAuditQueryRoute } = require('../src/audit/query-reader');
const { readInjectLog } = require('../src/audit/inject-log');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-audit-query-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'injects.jsonl');
}

test('#106 backward reader matches legacy filtered newest-first scalar pagination, UTF8 and partial rows', async t => {
  const file = fixture(t); const rows = [];
  for (let i=0; i<400; i++) rows.push(JSON.stringify({ ts: new Date(1700000000000+i*1000).toISOString(), inject_id: String(i),
    to: i%3 ? 'target' : 'other', to_alias: 'alias', claimed_from: i%2 ? 'claimed' : 'other',
    verified_sender_sid: 'verified', spoof_suspected: i%4===0, payload_preview: `한글🌿${i}` }));
  fs.writeFileSync(file, '\n' + rows.slice(0,200).join('\n') + '\nnot JSON\n' + rows.slice(200).join('\n') + '\n{"partial":');
  const reader = createAuditReader({ path: file }); t.after(() => reader.close());
  const filters = [{}, { limit: 17, cursor: 10 }, { limit: 5, cursor: 390 },
    { to: 'alias', from: 'claimed', limit: 13, cursor: 60 },
    { from: 'verified', spoof: true, since: 1700000100, until: '2023-11-14T22:18:20Z', limit: 7, cursor: 4 },
    { limit: 2.5, cursor: 1.5 }, { to: 'missing', limit: 1000 }];
  for (const options of filters) {
    const result = await reader.read(options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.json), readInjectLog(file, options));
  }
  fs.appendFileSync(file, 'true}'); // an unterminated but valid trailing JSON record is included by legacy
  const result = await reader.read({ limit: 2 });
  assert.deepEqual(JSON.parse(result.json), readInjectLog(file, { limit: 2 }));
  assert.deepEqual(JSON.parse(result.json).injects[0], { partial: true });
});

test('#106 large active log can be scanned deeply with bounded retained page', async t => {
  const file = fixture(t); const fd = fs.openSync(file, 'w');
  const line = JSON.stringify({ ts: '2026-01-01T00:00:00Z', to: 'target', pad: 'x'.repeat(1000) }) + '\n';
  const count = Math.ceil(50*1024*1024/Buffer.byteLength(line));
  const batch = line.repeat(500);
  try { for (let i=0; i<count; i+=500) fs.writeSync(fd, i+500<=count ? batch : line.repeat(count-i)); }
  finally { fs.closeSync(fd); }
  const reader = createAuditReader({ path: file }); t.after(() => reader.close());
  const result = await reader.read({ limit: 1, cursor: count-1, to: 'target' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const parsed = JSON.parse(result.json);
  assert.equal(parsed.injects.length, 1); assert.equal(parsed.next_cursor, null);
});

test('#106 missing file is empty; unreadable/nonregular and oversized rows/replies fail explicitly', async t => {
  const file = fixture(t); const reader = createAuditReader({ path: file }); t.after(() => reader.close());
  assert.deepEqual(JSON.parse((await reader.read()).json), { injects: [], next_cursor: null });
  fs.mkdirSync(file);
  assert.equal((await reader.read()).code, 'AUDIT_QUERY_UNAVAILABLE');
  fs.rmdirSync(file);
  fs.writeFileSync(file, JSON.stringify({ large: 'x'.repeat(256*1024) })+'\n');
  assert.equal((await reader.read()).code, 'AUDIT_QUERY_BUDGET_EXCEEDED');
  fs.writeFileSync(file, (JSON.stringify({ large: 'x'.repeat(3000) })+'\n').repeat(1000));
  assert.equal((await reader.read({ limit: 1000 })).code, 'AUDIT_QUERY_BUDGET_EXCEEDED');
  fs.truncateSync(file, 64*1024*1024+1);
  const oversizedFile = await reader.read();
  assert.equal(oversizedFile.code, 'AUDIT_QUERY_BUDGET_EXCEEDED');
  assert.equal(oversizedFile.reason, 'file_bytes');
});

class ControlledWorker extends EventEmitter {
  constructor() { super(); this.terminated = 0; this.unreferenced = false; }
  unref() { this.unreferenced = true; }
  terminate() { this.terminated++; this.emit('exit', 1); return Promise.resolve(1); }
}
function controlled(t, overrides = {}) {
  const workers = []; const timers = [];
  const reader = createAuditReader({ path: '/daemon-owned/private/audit.jsonl',
    workerFactory: (file, options) => { assert.match(file, /inject-query-worker\.js$/); assert.equal(options.workerData.path, '/daemon-owned/private/audit.jsonl');
      const w = new ControlledWorker(); workers.push(w); return w; },
    setTimer: fn => { timers.push(fn); return fn; }, clearTimer: () => {}, ...overrides });
  t.after(() => reader.close()); return { reader, workers, timers };
}

test('#106 capacity, timeout and shutdown are typed and terminate workers without leaking raw errors', async t => {
  const { reader, workers, timers } = controlled(t);
  const a = reader.read(); const b = reader.read();
  assert.equal((await reader.read()).code, 'AUDIT_QUERY_BUSY');
  assert.ok(workers.every(w => w.unreferenced));
  timers[0](); assert.equal((await a).code, 'AUDIT_QUERY_TIMEOUT'); assert.equal(workers[0].terminated, 1);
  workers[1].emit('error', new Error('SECRET /private/path raw details'));
  const failure = await b; assert.equal(failure.code, 'AUDIT_QUERY_FAILED');
  assert.doesNotMatch(JSON.stringify(failure), /SECRET|private|raw details/);
  const c = reader.read(); await reader.close();
  assert.equal((await c).code, 'AUDIT_QUERY_CLOSED');
  assert.equal((await reader.read()).code, 'AUDIT_QUERY_CLOSED');
});

test('#106 API remains responsive while a controlled worker owns query work', async t => {
  const express = require('express'); const app = express();
  let started; const online = new Promise(resolve => { started = resolve; });
  const { reader, workers } = controlled(t, { workerFactory: () => { const w = new ControlledWorker(); workers.push(w); started(); return w; } });
  // Avoid constructing this closure before its worker array exists.
  app.get('/api/health', (_req,res) => res.json({ status: 'ok' }));
  registerAuditQueryRoute(app, { reader, resolveSessionAlias: value => value });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = fetch(`${base}/api/injects?to=target`); await online;
  const health = await fetch(`${base}/api/health`); assert.equal(health.status, 200);
  workers[0].emit('message', { ok: true, json: '{"injects":[],"next_cursor":null}' });
  const response = await query; assert.equal(response.status, 200); assert.equal((await response.json()).next_cursor, null);
});

test('#106 UTF8 characters straddling a backward chunk boundary remain intact', async t => {
  const file = fixture(t); const row = { value: '🌿'+'x'.repeat(65530) };
  fs.writeFileSync(file, JSON.stringify(row)+'\n');
  const reader = createAuditReader({ path: file }); t.after(() => reader.close());
  const result = await reader.read(); assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.json).injects, [row]);
});

test('#106 a timed-out worker retains capacity until it actually exits', async t => {
  const workers = []; const timers = [];
  class HeldWorker extends ControlledWorker {
    terminate() { this.terminated++; return new Promise(() => {}); }
  }
  const reader = createAuditReader({ path: '/daemon-owned/log',
    workerFactory: () => { const w = new HeldWorker(); workers.push(w); return w; },
    setTimer: fn => { timers.push(fn); return fn; }, clearTimer: () => {} });
  t.after(() => reader.close());
  const a = reader.read(); const b = reader.read(); timers[0]();
  assert.equal((await a).code, 'AUDIT_QUERY_TIMEOUT');
  assert.equal((await reader.read()).code, 'AUDIT_QUERY_BUSY');
  assert.equal(workers.length, 2, 'do not spawn a third native thread while termination is pending');
  workers[0].emit('exit', 1);
  const c = reader.read(); assert.equal(workers.length, 3);
  await reader.close(); assert.equal((await b).code, 'AUDIT_QUERY_CLOSED'); assert.equal((await c).code, 'AUDIT_QUERY_CLOSED');
  workers[1].emit('error', new Error('late private error')); // listener remains safe until native exit
  workers[1].emit('exit', 1); workers[2].emit('exit', 1);
});

test('#106 real held worker leaves the actual API route and HTTP health responsive', async t => {
  const { Worker, MessageChannel } = require('node:worker_threads'); const express = require('express');
  const release = new SharedArrayBuffer(4); const state = new Int32Array(release);
  const { port1, port2 } = new MessageChannel();
  const started = new Promise(resolve => port1.once('message', resolve));
  const reader = createAuditReader({ path: '/daemon-owned/never-selected-by-query',
    workerFactory: (file, options) => {
      assert.match(file, /inject-query-worker\.js$/); assert.equal(options.workerData.path, '/daemon-owned/never-selected-by-query');
      return new Worker(path.resolve(__dirname, '../test-support/audit-query-held-worker.cjs'), {
        workerData: { release, started: port2 }, transferList: [port2], resourceLimits: options.resourceLimits
      });
    } });
  const app = express(); app.get('/api/health', (_req,res) => res.json({ status: 'ok' }));
  registerAuditQueryRoute(app, { reader, resolveSessionAlias: value => value });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { Atomics.store(state,0,1); Atomics.notify(state,0); port1.close(); await reader.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = fetch(`${base}/api/injects?path=/caller-cannot-select-this`); await started;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  Atomics.store(state,0,1); Atomics.notify(state,0);
  assert.equal((await query).status, 200);
});

test('#106 real daemon/API/CLI reports bounded failure rather than empty audit history', async t => {
  const { startTestDaemon } = require('../test-support/daemon-harness');
  const daemon = await startTestDaemon(); t.after(() => daemon.stop());
  const file = path.join(daemon.homeDir, '.telepty', 'logs', 'injects.jsonl');
  fs.writeFileSync(file, JSON.stringify({ private_payload: 'SECRET'.repeat(60000) })+'\n');
  const refused = await daemon.request('/api/injects', { noAuth: true });
  assert.equal(refused.status, 401);
  const failed = await daemon.request('/api/injects?path=/caller-file');
  assert.equal(failed.status, 503); assert.equal(failed.body.code, 'AUDIT_QUERY_BUDGET_EXCEEDED');
  assert.doesNotMatch(JSON.stringify(failed.body), /SECRET|caller-file|injects\.jsonl/);
  assert.equal((await daemon.request('/api/health')).status, 200);
  const cli = await daemon.runCli(['injects','--json']);
  assert.equal(cli.code, 1); const result = JSON.parse(cli.stdout);
  assert.equal(result.success, false); assert.equal(result.code, 'AUDIT_QUERY_BUDGET_EXCEEDED');
  assert.equal(Object.hasOwn(result, 'injects'), false);
  const tail = await daemon.runCli(['injects','--tail','--json']);
  assert.equal(tail.code, 1); assert.equal(JSON.parse(tail.stdout).success, false);
  assert.doesNotMatch(tail.stdout, /Tailing inject audit/);
});

test('#106 malformed filters, worker construction and unexpected exit fail without empty history', async t => {
  const { reader, workers } = controlled(t);
  assert.equal((await reader.read({ cursor: ['1','2'] })).code, 'AUDIT_QUERY_INVALID_FILTER');
  assert.equal(workers.length, 0);
  const pending = reader.read(); workers[0].emit('exit', 0);
  assert.equal((await pending).code, 'AUDIT_QUERY_FAILED');
  const failed = createAuditReader({ path: '/private/daemon-owned', workerFactory: () => { throw new Error('SECRET /private/runtime detail'); } });
  t.after(() => failed.close());
  const result = await failed.read(); assert.equal(result.code, 'AUDIT_QUERY_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private|runtime detail/);
});
