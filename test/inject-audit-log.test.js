'use strict';

// #43 P1 — inject audit spine (src/audit/inject-log.js).
// Pure builder (schema v1 shape, sha256, spoof_suspected, delivery_result variants)
// + bounded async writer (append, size+age rotation, 0700 dir / 0600 file,
// overflow→drop+event, no fsync stall) + read/filter helper for the P3 API.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAuditLine,
  createAuditWriter,
  readInjectLog
} = require('../src/audit/inject-log');

function tmpDir(prefix = 'telepty-audit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// buildAuditLine — pure, schema v1
// ---------------------------------------------------------------------------

test('buildAuditLine emits schema v1 shape with sha256 + byte length', () => {
  const line = buildAuditLine({
    ts: '2026-06-09T12:34:56.789Z',
    inject_id: 'abc-123',
    kind: 'inject',
    source: 'inject',
    claimed_from: 'orchestrator',
    verified_sender_sid: 'orchestrator',
    to: 'worker-3',
    to_alias: 'worker-3',
    origin: 'trusted-local',
    origin_host: 'hostA',
    payload: 'hello world',
    delivery_result: 'success'
  });
  const obj = JSON.parse(line);
  assert.equal(obj.v, 1);
  assert.equal(obj.ts, '2026-06-09T12:34:56.789Z');
  assert.equal(obj.inject_id, 'abc-123');
  assert.equal(obj.kind, 'inject');
  assert.equal(obj.source, 'inject');
  assert.equal(obj.claimed_from, 'orchestrator');
  assert.equal(obj.verified_sender_sid, 'orchestrator');
  assert.equal(obj.spoof_suspected, false);
  assert.equal(obj.to, 'worker-3');
  assert.equal(obj.origin, 'trusted-local');
  assert.equal(obj.origin_host, 'hostA');
  assert.equal(obj.payload_sha256, sha256('hello world'));
  assert.equal(obj.payload_bytes, Buffer.byteLength('hello world'));
  assert.equal(obj.payload_preview, null); // hash-only by default
  assert.equal(obj.delivery_result, 'success');
  // line is exactly one JSON object, no embedded newline
  assert.equal(line.includes('\n'), false);
});

test('buildAuditLine computes spoof_suspected when claimed != verified', () => {
  const obj = JSON.parse(buildAuditLine({
    claimed_from: 'orchestrator',
    verified_sender_sid: 'worker-7',
    payload: 'x'
  }));
  assert.equal(obj.spoof_suspected, true);
});

test('buildAuditLine never flags spoof when verified is null', () => {
  const obj = JSON.parse(buildAuditLine({
    claimed_from: 'orchestrator',
    verified_sender_sid: null,
    payload: 'x'
  }));
  assert.equal(obj.spoof_suspected, false);
  assert.equal(obj.verified_sender_sid, null);
});

test('buildAuditLine defaults: null claimed/verified, origin trusted-local, success', () => {
  const obj = JSON.parse(buildAuditLine({ payload: '' }));
  assert.equal(obj.claimed_from, null);
  assert.equal(obj.verified_sender_sid, null);
  assert.equal(obj.spoof_suspected, false);
  assert.equal(obj.origin, 'trusted-local');
  assert.equal(obj.delivery_result, 'success');
  assert.equal(obj.payload_sha256, sha256(''));
  assert.equal(obj.payload_bytes, 0);
});

test('buildAuditLine carries failed:<CODE> and blocked:<reason> delivery_result verbatim', () => {
  assert.equal(JSON.parse(buildAuditLine({ payload: 'x', delivery_result: 'failed:SESSION_DEAD' })).delivery_result, 'failed:SESSION_DEAD');
  assert.equal(JSON.parse(buildAuditLine({ payload: 'x', delivery_result: 'blocked:peer_lane' })).delivery_result, 'blocked:peer_lane');
});

test('buildAuditLine redaction: preview OFF => hash only, no payload content', () => {
  const secret = 'super secret prompt content';
  const obj = JSON.parse(buildAuditLine({ payload: secret }));
  assert.equal(obj.payload_preview, null);
  assert.equal(buildAuditLine({ payload: secret }).includes('secret'), false);
});

test('buildAuditLine redaction: preview ON => truncated to previewBytes, never full', () => {
  const payload = 'A'.repeat(500);
  const obj = JSON.parse(buildAuditLine({ payload, preview: true, previewBytes: 200 }));
  assert.equal(typeof obj.payload_preview, 'string');
  assert.equal(obj.payload_preview.length, 200);
  assert.notEqual(obj.payload_preview, payload);
  // hash always present even with preview on
  assert.equal(obj.payload_sha256, sha256(payload));
});

// ---------------------------------------------------------------------------
// createAuditWriter — bounded async writer
// ---------------------------------------------------------------------------

test('createAuditWriter appends one JSONL line per record with 0600 file / 0700 dir', async () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'logs', 'injects.jsonl');
  const writer = createAuditWriter({ path: logPath, flushMs: 10 });
  writer.append({ inject_id: 'i1', payload: 'one', to: 'a' });
  writer.append({ inject_id: 'i2', payload: 'two', to: 'b' });
  await writer.close();

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).inject_id, 'i1');
  assert.equal(JSON.parse(lines[1]).inject_id, 'i2');

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(logPath)).mode & 0o777, 0o700);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createAuditWriter.append never blocks (returns synchronously, no fsync)', () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'logs', 'injects.jsonl');
  const writer = createAuditWriter({ path: logPath, flushMs: 10 });
  const result = writer.append({ inject_id: 'i1', payload: 'x' });
  assert.equal(result, undefined); // fire-and-forget, no promise awaited on hot path
  writer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createAuditWriter rotates by size and keeps maxFiles', async () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'logs', 'injects.jsonl');
  const writer = createAuditWriter({ path: logPath, flushMs: 5, maxBytes: 200, maxFiles: 2 });
  for (let i = 0; i < 40; i++) {
    writer.append({ inject_id: `i${i}`, payload: 'X'.repeat(50) });
    await writer.flush();
  }
  await writer.close();
  assert.equal(fs.existsSync(logPath), true);
  assert.equal(fs.existsSync(`${logPath}.1`), true);
  // maxFiles=2 means rotated files capped at .1/.2 — no .3
  assert.equal(fs.existsSync(`${logPath}.3`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createAuditWriter age-prunes rotated files older than maxAgeDays', async () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'logs', 'injects.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // Stale rotated file with an old mtime
  const stale = `${logPath}.1`;
  fs.writeFileSync(stale, '{"old":true}\n');
  const old = Date.now() - 40 * 86400000;
  fs.utimesSync(stale, new Date(old), new Date(old));

  const writer = createAuditWriter({ path: logPath, flushMs: 5, maxAgeDays: 30, maxBytes: 1 });
  writer.append({ inject_id: 'fresh', payload: 'y' });
  await writer.flush();
  await writer.close();
  assert.equal(fs.existsSync(stale), false); // pruned
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createAuditWriter overflow drops oldest and emits audit_overflow', async () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'logs', 'injects.jsonl');
  const writer = createAuditWriter({ path: logPath, flushMs: 100000, queueMax: 3 });
  const events = [];
  writer.on('audit_overflow', (e) => events.push(e));
  for (let i = 0; i < 6; i++) writer.append({ inject_id: `i${i}`, payload: 'z' });
  assert.equal(events.length >= 1, true);
  assert.equal(events[events.length - 1].dropped >= 1, true);
  writer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readInjectLog — P3 read/filter/paginate helper
// ---------------------------------------------------------------------------

function seed(logPath, records) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, records.map((r) => buildAuditLine(r)).join('\n') + '\n');
}

test('readInjectLog returns newest-first and paginates with cursor', () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'injects.jsonl');
  seed(logPath, [
    { ts: '2026-06-09T10:00:00.000Z', inject_id: 'a', to: 's1', payload: '1' },
    { ts: '2026-06-09T11:00:00.000Z', inject_id: 'b', to: 's1', payload: '2' },
    { ts: '2026-06-09T12:00:00.000Z', inject_id: 'c', to: 's1', payload: '3' }
  ]);
  const page1 = readInjectLog(logPath, { limit: 2 });
  assert.deepEqual(page1.injects.map((r) => r.inject_id), ['c', 'b']);
  assert.equal(page1.next_cursor, 2);
  const page2 = readInjectLog(logPath, { limit: 2, cursor: page1.next_cursor });
  assert.deepEqual(page2.injects.map((r) => r.inject_id), ['a']);
  assert.equal(page2.next_cursor, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readInjectLog filters by to, from (claimed OR verified), since, spoof', () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'injects.jsonl');
  seed(logPath, [
    { ts: '2026-06-09T10:00:00.000Z', inject_id: 'a', to: 's1', claimed_from: 'orchestrator', verified_sender_sid: 'orchestrator', payload: '1' },
    { ts: '2026-06-09T11:00:00.000Z', inject_id: 'b', to: 's2', claimed_from: 'orchestrator', verified_sender_sid: 'worker-9', payload: '2' },
    { ts: '2026-06-09T12:00:00.000Z', inject_id: 'c', to: 's1', claimed_from: 'worker-9', verified_sender_sid: null, payload: '3' }
  ]);
  assert.deepEqual(readInjectLog(logPath, { to: 's1' }).injects.map((r) => r.inject_id), ['c', 'a']);
  // from matches claimed_from OR verified_sender_sid
  assert.deepEqual(readInjectLog(logPath, { from: 'worker-9' }).injects.map((r) => r.inject_id), ['c', 'b']);
  assert.deepEqual(readInjectLog(logPath, { spoof: true }).injects.map((r) => r.inject_id), ['b']);
  assert.deepEqual(readInjectLog(logPath, { since: '2026-06-09T11:30:00.000Z' }).injects.map((r) => r.inject_id), ['c']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readInjectLog returns empty result when file is absent', () => {
  const out = readInjectLog(path.join(tmpDir(), 'missing.jsonl'), {});
  assert.deepEqual(out.injects, []);
  assert.equal(out.next_cursor, null);
});
