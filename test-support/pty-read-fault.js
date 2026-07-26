'use strict';
// TEST-ONLY fault injector for the #732 repro. Loaded into a real `telepty allow`
// bridge via NODE_OPTIONS=--require. Never required by product code.
//
// It severs the bridge's UPSTREAM leg at its source — the point where node-pty
// hands PTY bytes to the consumer (`child.onData`, cli.js:2064) — while leaving
// everything else untouched:
//   * the child process keeps running,
//   * node-pty's write side (`_writeStream`, a raw fs.write on the same master fd,
//     unixTerminal.js:97/154) keeps accepting `child.write()`, so injects still
//     reach the PTY,
//   * no 'exit'/'close' is emitted, so cli.js's onExit handler never fires and the
//     bridge neither restarts nor dies,
//   * the owner WebSocket stays open and keeps answering the daemon's 30s pings.
//
// That is the exact asymmetry the architecture permits: upstream (PTY -> owner-WS
// 'output' frame -> daemon ring) is dead while downstream (daemon -> owner-WS
// 'inject' -> child.write -> PTY) is alive, with NOTHING on either side able to
// notice. node-pty already has a code path that leaves precisely this state
// behind on its own: unixTerminal.js:99-105 swallows a read-stream EAGAIN and
// returns without _close(), without emitting 'close' and without emitting 'exit'.
//
// Modes (TELEPTY_FAULT_MODE):
//   mute  (default) — keep draining the master fd but stop delivering to onData.
//                     Faithful: the child never blocks on a full PTY buffer, which
//                     is required to model a session that kept working for hours.
//   pause           — stop reading the master fd entirely. Also kills upstream, but
//                     back-pressures and eventually blocks the child, so it does NOT
//                     model the observed "agent kept executing commands" half.
const pty = require('node-pty');

const MODE = process.env.TELEPTY_FAULT_MODE || 'mute';
const terms = [];
const origSpawn = pty.spawn;
pty.spawn = function (...args) {
  const t = origSpawn.apply(this, args);
  terms.push(t);
  return t;
};

process.on('SIGUSR2', () => {
  for (const t of terms) {
    try {
      if (MODE === 'pause') {
        if (t._socket) t._socket.pause();
      } else {
        // Keep the kernel PTY buffer draining, drop the hand-off to onData.
        t._onData.fire = () => {};
      }
      process.stderr.write(`[FAULT] upstream severed (mode=${MODE})\n`);
    } catch (e) {
      process.stderr.write(`[FAULT] error: ${e.message}\n`);
    }
  }
});
