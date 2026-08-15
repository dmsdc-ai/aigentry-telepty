'use strict';

// #835 PRODUCTION-SAFETY, sibling to setup-env.js's isolated HOME.
//
// The defect under test is a code path that answers "the daemon is unreachable" by SIGTERM/
// SIGKILLing every process that looks like a telepty daemon — found by a GLOBAL `ps` scan
// (daemon-control.js:124-170), so an isolated HOME and an ephemeral PORT do not isolate it.
// On the machine this was written, that scan matched 120 live `telepty-daemon` processes,
// including the one owning every real session.
//
// A test that spawns the CLI against a daemon that REFUSES must therefore be able to reach the
// remediation without delivering it. Loaded into a spawned CLI via
// `NODE_OPTIONS=--require <this file>`, it turns every real signal into a RECORDING (one line
// per attempt in $BLOCKED_SIGNALS_LOG) and refuses to spawn a detached daemon. Signal 0 — a
// liveness probe, not a kill — is passed through unchanged.
//
// The recording is also the assertion: "no kill was attempted" is proven by an empty log, not
// by trusting the code under test. Never loaded by the product; test-support only.

const fs = require('node:fs');
const cp = require('node:child_process');

const LOG = process.env.BLOCKED_SIGNALS_LOG;

function record(line) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, `${line}\n`); } catch { /* best effort */ }
}

const realKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (signal === 0 || signal === undefined) return realKill(pid, 0);
  record(`BLOCKED-SIGNAL ${signal} -> pid ${pid}`);
  return true;
};

const realSpawn = cp.spawn;
cp.spawn = function guardedSpawn(command, args) {
  if (Array.isArray(args) && args.some((arg) => String(arg) === 'daemon')) {
    record(`BLOCKED-SPAWN ${command} ${args.join(' ')}`);
    return { unref() {}, on() {}, pid: -1 };
  }
  return realSpawn.apply(cp, arguments);
};
