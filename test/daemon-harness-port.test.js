'use strict';

// Regression guard for #576 (P0): the test harness must launch each daemon on an
// OS-assigned ephemeral port (PORT=0) and read the actual bound port back, so test
// daemons can never collide with another process or each other. This replaces the old
// randomPort() (unchecked 30000–49999) that caused EADDRINUSE flakes on ubuntu and
// systematic EACCES on Windows reserved ranges.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { startTestDaemon } = require('../test-support/daemon-harness');

const started = [];

after(async () => {
  await Promise.all(started.map((h) => h.stop().catch(() => {})));
});

test('startTestDaemon binds an OS-assigned port and reads back the actual bound port', async () => {
  const harness = await startTestDaemon();
  started.push(harness);

  // A real, OS-assigned port — never 0 and never the unchecked random sentinel.
  assert.equal(Number.isInteger(harness.port), true);
  assert.ok(harness.port > 0 && harness.port < 65536, `port out of range: ${harness.port}`);

  // The port the harness reports must equal the port the daemon actually bound:
  // /api/meta reports the daemon's real bound port, proving the read-back is correct.
  const meta = await harness.request('/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.port, harness.port);

  // And the daemon is genuinely serving on that port.
  const health = await harness.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
});

test('two concurrent test daemons get distinct, conflict-free ports', async () => {
  const [a, b] = await Promise.all([startTestDaemon(), startTestDaemon()]);
  started.push(a, b);

  assert.notEqual(a.port, b.port, 'concurrent daemons must not share a port');

  // Both are independently reachable on their own read-back ports.
  const [metaA, metaB] = await Promise.all([a.request('/api/meta'), b.request('/api/meta')]);
  assert.equal(metaA.body.port, a.port);
  assert.equal(metaB.body.port, b.port);
});
