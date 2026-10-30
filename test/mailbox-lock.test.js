'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {acquireLock, breakStaleLocks, isProcessAlive} = require('../src/mailbox/storage');
const {FileMailbox} = require('../src/mailbox');
const {DeliveryEngine} = require('../src/mailbox/delivery');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-lock-test-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dir = path.join(root, 's'); fs.mkdirSync(dir);
  return {root, dir};
}
test('current process is alive and permission/unknown probe failures do not prove death', t => {
  assert.equal(isProcessAlive(process.pid), true);
  const original = process.kill;
  t.after(() => { process.kill = original; });
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'ESRCH']) {
    process.kill = () => { throw Object.assign(Error(code), {code}); };
    assert.equal(isProcessAlive(123), code !== 'ESRCH');
  }
});
test('empty roots and retained idle lock directories have no dead tickets', t => {
  const {root, dir} = fixture(t); assert.equal(breakStaleLocks(root), 0);
  acquireLock(dir)(); assert.equal(breakStaleLocks(root), 0);
  assert.ok(fs.lstatSync(path.join(dir, '.lock')).isDirectory());
});
test('legacy stale-age options cannot override a live owner', t => {
  const {root, dir} = fixture(t), release = acquireLock(dir);
  try {
    const old = new Date(Date.now() - 70000); fs.utimesSync(path.join(dir, '.lock'), old, old);
    assert.throws(() => acquireLock(dir, {staleLockAgeMs: 1}), /lock timeout/i);
    assert.equal(breakStaleLocks(root, {staleLockAgeMs: 1}), 0);
  } finally { release(); }
});
test('FileMailbox startup delegates without clearing active tickets', t => {
  const {root, dir} = fixture(t), release = acquireLock(dir);
  try { assert.equal(new FileMailbox({root}).breakStaleLocks(), 0); }
  finally { release(); }
});
test('delivery failures back off without evicting an active writer at the old force-break threshold', async t => {
  const {root, dir} = fixture(t), mailbox = new FileMailbox({root, lockBreakAfterFailures: 2});
  mailbox.enqueue({msg_id: 'keep', from: 'a', to: 's', payload: 'keep', created_at: Math.floor(Date.now()/1000), attempt: 0});
  const engine = new DeliveryEngine(mailbox, {sessionResolver: () => ['s'], pollMs: 50});
  const release = acquireLock(dir);
  try {
    for (let i = 1; i <= 3; i++) {
      engine._skipUntil.delete('s'); await engine.tick();
      assert.equal(engine._lockFailures.get('s'), i);
      assert.ok(engine._skipUntil.get('s') > Date.now());
      assert.equal(breakStaleLocks(root), 0);
    }
    const start = Date.now(); await engine.tick(); assert.ok(Date.now() - start < 100);
  } finally { release(); }
  engine._skipUntil.delete('s'); await engine.tick();
  assert.equal(engine._lockFailures.get('s'), undefined);
});
test('compatibility config fields remain readable but are not eviction authority', t => {
  const {root} = fixture(t), defaults = new FileMailbox({root});
  assert.equal(defaults.config.staleLockAgeSecs, 60); assert.equal(defaults.config.lockBreakAfterFailures, 3);
  const custom = new FileMailbox({root, staleLockAgeSecs: 30, lockBreakAfterFailures: 5});
  assert.equal(custom.config.staleLockAgeSecs, 30); assert.equal(custom.config.lockBreakAfterFailures, 5);
});
