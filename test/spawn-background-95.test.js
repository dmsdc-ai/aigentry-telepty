'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestDaemon, createSessionId, waitFor } = require('../test-support/daemon-harness');

test('#95: spawn accepts command separator and explicit background mode, preserving output', async t => {
  const h = await startTestDaemon();
  t.after(() => h.stop());
  const sid = createSessionId('background95');
  const result = await h.runCli(['spawn', '--id', sid, '--background', '--', process.execPath,
    '-e', 'console.log("SPAWN95_INITIAL"); setInterval(() => {}, 1000);'], { timeoutMs: 5000 });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /spawned/);
  assert.doesNotMatch(result.stdout, /Entering room/);
  await waitFor(async () => {
    const response = await h.request(`/api/sessions/${sid}/screen`);
    return response.status === 200 && response.body.screen.includes('SPAWN95_INITIAL');
  }, { timeoutMs: 5000, description: 'daemon-owned spawned process initial output is visible' });
  const snapshot = await h.request(`/api/sessions/${sid}`);
  assert.equal(snapshot.body.command, process.execPath);
  assert.notEqual(snapshot.body.type, 'wrapped', 'background CLI never auto-claims wrapped ownership');
});

const { parseSpawnInvocation } = require('../src/cli/spawn-invocation');
test('#95: only spawn options before the command are parsed; literal child arguments survive', () => {
  assert.deepEqual(parseSpawnInvocation(['--id', 'x', '--background', '--', 'node', 'spawn', '--id', 'literal', '--background']),
    { sessionId: 'x', background: true, command: 'node', cmdArgs: ['spawn', '--id', 'literal', '--background'] });
  assert.deepEqual(parseSpawnInvocation(['--id', 'x', 'bash', '-c', 'echo x']),
    { sessionId: 'x', background: false, command: 'bash', cmdArgs: ['-c', 'echo x'] });
  assert.throws(() => parseSpawnInvocation(['--id', 'x', '--']), /Usage/);
  assert.throws(() => parseSpawnInvocation(['--id', '--background', 'node']), /Usage/);
});
