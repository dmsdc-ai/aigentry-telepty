'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeScreen, parseBudget } = require('../src/screen-observation');
const { stripAnsiForScreen } = require('../src/screen-ansi');
const { readScreen, screenQuery } = require('../src/cli/read-screen');
const observe = (session, screen, rest = {}) => observeScreen(session, { sessionId: 'test', screen, raw: false, lines: 50, ...rest });
test('UTF8 content budgets below a wide repaint line are hard bounds', () => {
  for (let limit = 0; limit < 15; limit++) {
    const result = observe({}, '🙂한글'.repeat(1000), { maxBytes: limit });
    assert.ok(result.returned_bytes <= limit);
    assert.equal(result.returned_bytes, Buffer.byteLength(result.content));
    assert.ok(!result.content.includes('\ufffd'));
    assert.equal(result.truncated, true);
  }
  for (const bad of ['-1', 'x', '1.5', 262145]) assert.throws(() => parseBudget(bad));
});
test('cleaned Codex/Claude repaint uses reconstructable splice and unchanged metadata', () => {
  const session = {};
  const before = stripAnsiForScreen('\x1b[?2026h\x1b[0 q❯ Working 🙂\x1b[?2026l');
  const first = observe(session, before);
  const unchanged = observe(session, before, { since: first.cursor });
  assert.equal(unchanged.kind, 'unchanged'); assert.equal(unchanged.content, '');
  assert.equal(unchanged.changed, false);
  const after = stripAnsiForScreen('\x1b[2J\x1b[H❯ Finished 🙂');
  const delta = observe(session, after, { since: first.cursor });
  assert.equal(delta.kind, 'delta');
  const chars = Array.from(before); chars.splice(delta.splice.start, delta.splice.delete_count, ...Array.from(delta.content));
  assert.equal(chars.join(''), after);
});
test('rollover, history eviction, replacement and rendering modes reset closed', () => {
  const session = {}, first = observe(session, 'one');
  assert.equal(observe(session, 'two', { since: first.cursor, rollover: 1 }).reset_reason, 'ring_rollover');
  assert.equal(observe({}, 'one', { since: first.cursor }).reset, true);
  assert.equal(observe(session, 'one', { since: first.cursor, raw: true }).reset, true);
  assert.equal(observe(session, 'one', { since: first.cursor, lines: 2 }).reset, true);
  for (let i = 0; i < 10; i++) observe(session, String(i));
  assert.equal(observe(session, 'last', { since: first.cursor }).reset_reason, 'stale_cursor');
});
test('oversized delta resets to explicit partial snapshot; cache content bounded', () => {
  const session = {}, first = observe(session, 'old');
  const next = observe(session, 'new text', { since: first.cursor, maxBytes: 2 });
  assert.equal(next.kind, 'snapshot'); assert.equal(next.reset_reason, 'byte_budget');
  assert.equal(next.content, 'ne'); assert.equal(next.truncated, true);
  const huge = observe({}, 'a'.repeat(300000), { maxBytes: 262144 });
  assert.equal(huge.total_bytes, 300000); assert.equal(huge.returned_bytes, 262144); assert.equal(huge.truncated, true);
});
test('CLI uses resolved local/remote host and emits undecorated JSON; raw is explicit', async () => {
  for (const host of ['local', 'remote']) {
    let url, output;
    await readScreen(['read-screen', 'alias@'+host, '--json', '--raw', '--max-bytes', '7', '--since', 'a:b'], {
      resolveTarget: async id => { assert.equal(id, 'alias@'+host); return { id: 'exact/id', host }; },
      daemonUrl: value => 'http://'+value,
      fetchWithAuth: async value => { url = new URL(value); return { ok: true, json: async () => ({ content: '🙂', raw: true }) }; },
      print: value => { output = value; }
    });
    assert.equal(url.hostname, host); assert.equal(url.pathname, '/api/sessions/exact%2Fid/screen');
    assert.equal(url.searchParams.get('max_bytes'), '7'); assert.equal(url.searchParams.get('since'), 'a:b');
    assert.equal(url.searchParams.get('raw'), '1'); assert.equal(JSON.parse(output).content, '🙂');
  }
  assert.equal(screenQuery(['read-screen','id']), 'lines=50');
  assert.throws(() => screenQuery(['read-screen','id','--since','x']));
});
test('production route preserves legacy rendering and applies opt-in validation/raw/rollover', () => {
  const { createScreenHandler } = require('../src/routes/session-screen');
  const sessions = { exact: { outputRing: ['old\n\x1b[31m🙂new\x1b[0m'] } };
  const handler = createScreenHandler({ sessions, resolveSessionAlias: id => id === 'alias' ? 'exact' : null });
  const request = (query = {}, id = 'alias') => {
    let result, code = 200;
    handler({ params: { id }, query }, { json(value) { result = value; return this; }, status(value) { code = value; return this; } });
    return { result, code };
  };
  assert.deepEqual(request({ lines: '1' }).result, { session_id: 'exact', screen: '🙂new', lines: 1, total_lines: 2, raw: false });
  const first = request({ json: '1', lines: '1', max_bytes: '4' }).result;
  assert.equal(first.content, '🙂'); assert.equal(first.truncated, true);
  assert.equal(request({ json: '1', lines: '1', since: first.cursor }).result.changed, false);
  assert.match(request({ json: '1', raw: '1' }).result.content, /\x1b\[31m/);
  sessions.exact.outputRingRollover = 1;
  assert.equal(request({ json: '1', lines: '1', since: first.cursor }).result.reset_reason, 'ring_rollover');
  assert.equal(request({ json: '1', max_bytes: '-1' }).code, 400);
  assert.equal(request({ json: '1', lines: 'nope' }).code, 400);
  assert.equal(request({}, 'missing').code, 404);
  sessions.exact = { outputRing: [] };
  assert.deepEqual(request().result, { session_id: 'exact', screen: '', lines: 0, raw: false });
  assert.equal(request({ json: '1', since: first.cursor }).result.reset, true);
});
test('changes beyond bounded cache prefix still advance revision', () => {
  const session = {}, prefix = 'x'.repeat(262144);
  const first = observe(session, prefix + 'a');
  const next = observe(session, prefix + 'b', { since: first.cursor });
  assert.equal(next.changed, true); assert.notEqual(next.cursor, first.cursor);
  assert.equal(next.reset_reason, 'snapshot_limit');
});
test('same object reused for a new epoch or session ID cannot reuse its cursor', () => {
  const session = { sessionEpoch: 'epoch-one' }, first = observe(session, 'same');
  session.sessionEpoch = 'epoch-two';
  const replacement = observe(session, 'same', { since: first.cursor });
  assert.equal(replacement.reset, true); assert.notEqual(replacement.session_instance, first.session_instance);
  const renamed = observe(session, 'same', { sessionId: 'renamed', since: replacement.cursor });
  assert.equal(renamed.reset, true); assert.notEqual(renamed.session_instance, replacement.session_instance);
});
