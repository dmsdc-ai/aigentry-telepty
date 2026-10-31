'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [dir, mode, count] = process.argv.slice(2);
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === 'choose') {
  const rename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (path.basename(to) === 'number' && from.startsWith(path.join(dir, '.lock') + path.sep)) {
      process.send({choosing: true}); wait(30000);
    }
    return rename.apply(this, arguments);
  };
}
const { acquireLock, breakStaleLocks } = require('../src/mailbox/storage');
process.once('message', () => {
  if (mode === 'sweep') {
    let removed = 0;
    for (let i = 0; i < Number(count); i++) { removed += breakStaleLocks(path.dirname(dir)); wait(1); }
    process.send({removed}, () => process.disconnect()); return;
  }
  if (mode !== 'contend') {
    const release = acquireLock(dir); process.send({held: true});
    process.on('message', () => { release(); process.send({released: true}); });
    return;
  }
  for (let i = 0; i < Number(count); i++) {
    let release;
    for (let retry = 0; retry < 20 && !release; retry++) {
      try { release = acquireLock(dir); } catch (e) { if (!/lock timeout/i.test(e.message)) throw e; }
    }
    if (!release) throw Error('contention never resolved');
    const guard = path.join(dir, 'critical');
    try {
      const fd = fs.openSync(guard, 'wx'); fs.closeSync(fd);
      const value = Number(fs.readFileSync(path.join(dir, 'counter'), 'utf8')); wait(2);
      fs.writeFileSync(path.join(dir, 'counter'), String(value + 1)); fs.unlinkSync(guard);
    } finally { release(); }
  }
  process.send({done: Number(count)}, () => process.disconnect());
});
