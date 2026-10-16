'use strict';
// Test-only preload (PR #108 C6 characterisation; origin tp-108s-rev): Linux-safe recording of the argv the spawn route builds for win32.
// - os.platform() answers 'win32' ONLY when called from the spawn route's isWin line in daemon.js;
//   everything else in the daemon keeps seeing the real platform.
// - node-pty's spawn is replaced by a recorder: nothing is executed.
const os = require('os');
const fs = require('fs');
const realPlatform = os.platform;
const REC = process.env.REV_WIN32_RECORD;
const WIN_LINE = process.env.REV_WIN32_LINE; // e.g. "daemon.js:3539"
os.platform = function platform() {
  const stack = new Error().stack || '';
  if (WIN_LINE && stack.split('\n')[2] && stack.split('\n')[2].includes(WIN_LINE)) return 'win32';
  return realPlatform.call(os);
};
const pty = require(require.resolve('node-pty', { paths: [process.cwd()] }));
pty.spawn = function recordSpawn(file, args, opts) {
  fs.appendFileSync(REC, JSON.stringify({ file, args, hasPS1: !!(opts && opts.env && opts.env.PS1) }) + '\n');
  const { EventEmitter } = require('events');
  const fake = new EventEmitter();
  Object.assign(fake, { pid: 999999, cols: 80, rows: 30, process: file,
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write() {}, resize() {}, kill() {}, pause() {}, resume() {} });
  return fake;
};
