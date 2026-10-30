'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createForwardLedger } = require('../src/peer-forwarding');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-integrity-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ledger = createForwardLedger(home), key = 'a'.repeat(64), fingerprint = 'b'.repeat(64);
  const reserved = ledger.reserve(key, fingerprint, { direction: 'strict-input', session: 'mine', expected_epoch: 'epoch' });
  const file = path.join(home, '.telepty', 'forward-receipts', `${key}.json`);
  return { home, ledger, key, fingerprint, reserved, file };
}
test('receipt reader refuses ambiguous state/fingerprint and malformed UTF8 instead of selecting a winner', t => {
  const f = fixture(t), good = fs.readFileSync(f.file, 'utf8');
  const invalid = [good.replace('"state":"pending"', '"state":"outcome_unknown","state":"accepted"'),
    good.replace(`"fingerprint":"${f.fingerprint}"`, `"fingerprint":"${'c'.repeat(64)}","fingerprint":"${f.fingerprint}"`),
    Buffer.concat([Buffer.from(good.slice(0, -1) + ',"note":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    'null', '[]', good.slice(0, -1)];
  for (const bytes of invalid) {
    fs.writeFileSync(f.file, bytes); assert.throws(() => f.ledger.read(f.key), { code: 'FORWARD_STORAGE_UNAVAILABLE' });
    assert.throws(() => f.ledger.reserve(f.key, f.fingerprint, {}), { code: 'FORWARD_STORAGE_UNAVAILABLE' });
  }
  fs.writeFileSync(f.file, good); assert.equal(f.ledger.reserve(f.key, f.fingerprint, {}).fresh, false);
  assert.equal(f.ledger.view(f.ledger.read(f.key)).state, 'outcome_unknown');
});
test('opened receipt must match the checked regular singly-linked file', t => {
  const f = fixture(t), replacement = path.join(f.home, 'replacement'); fs.writeFileSync(replacement, JSON.stringify({ ...f.reserved.record, state: 'accepted' }), { mode: 0o600 });
  const open = fs.openSync;
  try {
    fs.openSync = function(file, flags, ...args) { if (file === f.file) fs.renameSync(replacement, f.file); return open.call(fs, file, flags, ...args); };
    assert.throws(() => f.ledger.read(f.key), { code: 'FORWARD_STORAGE_UNAVAILABLE' });
  } finally { fs.openSync = open; }
});
test('receipt mutation while reading refuses a misleading completed result', t => {
  const f = fixture(t), read = fs.readSync; let changed = false;
  try {
    fs.readSync = function(fd, ...args) {
      const count = read.call(fs, fd, ...args);
      if (!changed) { changed = true; fs.appendFileSync(f.file, ' '); }
      return count;
    };
    assert.throws(() => f.ledger.read(f.key), { code: 'FORWARD_STORAGE_UNAVAILABLE' });
  } finally { fs.readSync = read; }
});

test('receipt disappearing after existence check is storage uncertainty, not a new reservation', t => {
  const f = fixture(t), open = fs.openSync;
  try {
    fs.openSync = function(file, flags, ...args) { if (file === f.file) fs.unlinkSync(f.file); return open.call(fs, file, flags, ...args); };
    assert.throws(() => f.ledger.reserve(f.key, f.fingerprint, {}), { code: 'FORWARD_STORAGE_UNAVAILABLE' });
  } finally { fs.openSync = open; }
});
