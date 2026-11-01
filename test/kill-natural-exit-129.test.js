'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Execute the actual command branch with transport seams; a hard exit throws so it cannot
// appear as a successful graceful return. No real daemon, credentials or processes touched.
const source = fs.readFileSync(require.resolve('../cli.js'), 'utf8');
const branch = source.slice(source.indexOf("  if (cmd === 'kill') {"), source.indexOf("  if (cmd === 'clean') {"));
for (const scenario of ['missing', 'refused', 'transport']) {
  test(`#129: kill ${scenario} sets failure status and lets pending I/O drain`, async () => {
    const errors = [];
    const proc = { exitCode: 0, exit: () => { throw new Error('hard process.exit'); } };
    const run = vm.runInNewContext(`(async () => { ${branch} })`, {
      cmd: 'kill', args: ['kill', 'target'], process: proc,
      console: { error: s => errors.push(s), log: () => {} },
      resolveSessionTarget: async () => scenario === 'missing' ? null : { id: 'target', host: 'local' },
      daemonUrl: () => 'http://isolated', encodeURIComponent,
      fetchWithAuth: async () => {
        if (scenario === 'transport') throw new Error('connection refused');
        return { ok: false, json: async () => ({ error: 'permission denied' }) };
      }
    });
    await run();
    assert.equal(proc.exitCode, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not found|permission denied|connection refused/);
  });
}
