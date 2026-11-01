'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAllowSecurityContext } = require('../src/cli/security-actions');

function child() {
  return { onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; } };
}

test('production relay rejects retained exited/replaced/closed callbacks, accepts successor prompt', () => {
  const shared = { child: child(), allowSessionClosed: false };
  const context = createAllowSecurityContext(shared);
  const effects = { generation: 0, bytes: 0, terminal: [], daemon: [], readiness: 0, writes: [] };
  let pending = ['wait-for-current-prompt'];
  const relay = context.createOutputRelay({
    onInteraction: () => effects.generation++,
    onBytes: n => { effects.bytes += n; },
    rewrite: data => data,
    write: data => effects.terminal.push(data),
    sendOutput: data => effects.daemon.push(data),
    observeReady: data => { effects.readiness++; return data.endsWith('> '); },
    onReady: () => { effects.writes.push(...pending); pending = []; }
  });
  const old = shared.child;
  let exits = 0;
  context.subscribeChild(old, relay, () => exits++);
  old.exit({ exitCode: 1 });
  const before = structuredClone(effects);
  old.data('late before restart> ');
  assert.deepEqual(effects, before);
  const current = shared.child = child();
  context.subscribeChild(current, relay, () => exits++);
  old.data('stale prompt> ');
  old.exit({ exitCode: 1 });
  assert.deepEqual(effects, before);
  assert.equal(exits, 1);
  current.data('current> ');
  assert.deepEqual(effects.writes, ['wait-for-current-prompt']);
  assert.deepEqual(effects.terminal, ['current> ']);
  assert.deepEqual(effects.daemon, ['current> ']);
  assert.equal(effects.generation, 1);
  assert.equal(effects.bytes, 9);
  assert.equal(effects.readiness, 1);
  shared.allowSessionClosed = true;
  const after = structuredClone(effects);
  current.data('closed> ');
  current.exit({ exitCode: 1 });
  assert.deepEqual(effects, after);
  assert.equal(exits, 1);
  shared.allowSessionClosed = false;
  current.data('reset shared flag> ');
  assert.deepEqual(effects, after);
});
