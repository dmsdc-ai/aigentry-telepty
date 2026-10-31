'use strict';

// Preload of the fixture inventory (suites.json). Records only in the DIRECT child of
// scripts/run-tests.mjs: node --test gives its per-file processes NODE_TEST_CONTEXT, and the
// contract test removes it from the runner's environment, so only the direct child has none.
const fs = require('node:fs');

const out = process.env.TEST_RUNNER_RECORD;
if (out && process.env.NODE_TEST_CONTEXT === undefined) {
  const record = (entry) => fs.appendFileSync(out, JSON.stringify({ pid: process.pid, ...entry }) + '\n');
  record({ event: 'start', ppid: process.ppid, execPath: process.execPath, execArgv: process.execArgv, argv: process.argv.slice(1) });
  process.on('exit', (code) => record({ event: 'exit', code }));
  if (process.env.TEST_RUNNER_DIRECT_EXIT) process.exit(Number(process.env.TEST_RUNNER_DIRECT_EXIT));
  if (process.env.TEST_RUNNER_DIRECT_SIGNAL) {
    record({ event: 'signal', signal: process.env.TEST_RUNNER_DIRECT_SIGNAL });
    process.kill(process.pid, process.env.TEST_RUNNER_DIRECT_SIGNAL);
  }
}
