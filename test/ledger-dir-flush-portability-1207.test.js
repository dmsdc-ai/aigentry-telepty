'use strict';
// #1207 WIN-1 — directory-flush portability of the ledger OWNER, and the client's event-loop hold.
// Measured cause (Windows CI run 41169574692, node 20.20.2): every store open on win32 failed
// `open_failed` with `EPERM: operation not permitted, fsync` — FlushFileBuffers on a directory handle
// is refused there — so no tracked inject could begin. The owner now treats exactly that shape (a
// directory that OPENED, whose flush is refused with EPERM, on win32) as `dir_flush: unsupported`.
// These cases pin both sides of that line:
//   • supported-platform success on the actual host (real fs, no injection);
//   • the win32 branch (platform injected in-process) opens, migrates and acks with directory flush
//     unsupported, while FILE fsyncs still run before every ack;
//   • refusals stay refusals: the same EPERM on POSIX, a directory that cannot be opened, and an
//     injected FILE fsync failure (EIO, and EPERM on a file) are never acknowledged;
//   • a process whose only handle is the unref'd owner worker still receives the owner's replies
//     (an unref'd Worker also unrefs its port; the loop used to drain under `await`).
// Author-written in the source phase; NOT RUN here. Independent CI executes it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const persistence = require('../src/session-store/persistence');
const { createOwnerHarness, sha256, tmpStore } = require('./fixtures/ledger-1207/owner-harness');
const { createFaultFs } = require('./fixtures/ledger-1207/fault-fs');
const { writeLegacyLedger } = require('./fixtures/ledger-1207/legacy-fixture');

const nowIso = () => new Date().toISOString();
function beginRecord(id, sid, at = nowIso()) {
  const record = { inject_id: id, session_id: sid, session_epoch: null, session_epoch_reason: 'no_815_epoch_fact', transport_source: 'orch', created_at: at,
    observation_seq: 0, observations: [], last_observation: null, capability: { stage: 'A' }, tracking_state: 'tracked' };
  persistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, at);
  return record;
}
const begin = (h, id, sid) => h.submit('begin', { id, sid, record: beginRecord(id, sid), at: nowIso() }, { cls: 'T' });
async function withStore(fn) { const s = tmpStore('telepty-ledger-dirflush-1207-'); try { return await fn(s); } finally { s.rm(); } }
const isDir = (p) => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
// The measured win32 shape, reproduced on any host: fsync of a DIRECTORY handle throws EPERM.
const dirFlushRefused = (extra = {}) => createFaultFs({ faults: { fsyncSync: [{ times: 1e6, code: 'EPERM', when: (_a, p) => isDir(p) }], ...extra } });
const status = (h) => h.read('status').items[0];

test('supported platform (actual host, real fs): fresh open is available, a begin acks after its file fsync, and status names the real durability mode', () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir });
  const opened = h.open();
  assert.equal(opened.state, 'available', JSON.stringify(opened.stateMessage));
  const ack = await begin(h, 'inj-host', 'w1');
  assert.equal(ack.type, 'ack', JSON.stringify(ack)); assert.equal(ack.basis, 'written');
  const st = status(h);
  assert.equal(st.durability.platform, process.platform);
  assert.equal(st.durability.file_flush, 'fsync');
  assert.ok(st.io.fsyncs > 0, 'file fsyncs ran');
  if (process.platform === 'win32') {
    // Measured there: directory flush is refused. Named, not hidden.
    assert.equal(st.durability.dir_flush, 'unsupported'); assert.equal(st.durability.dir_flush_code, 'EPERM');
    assert.ok(st.io.dir_flush_unsupported > 0);
  } else {
    assert.equal(st.durability.dir_flush, 'flushed'); assert.equal(st.io.dir_flush_unsupported, 0);
  }
  assert.equal((await h.close()).clean, true);
  assert.equal(h.release().released, true);
  // Reopen: the acked begin is recovered from disk.
  const h2 = createOwnerHarness({ dir: s.dir });
  assert.equal(h2.open().state, 'available');
  assert.equal(h2.read('get', { id: 'inj-host' }).items[0].tracking_state, 'tracked');
  await h2.close(); h2.release();
}));

test('win32 branch: directory flush refused with EPERM ⇒ open, begin ack and reopen still work; status names dir_flush unsupported; file fsyncs still precede the ack', () => withStore(async (s) => {
  const ffs = dirFlushRefused();
  const h = createOwnerHarness({ dir: s.dir, fsImpl: ffs, platform: 'win32' });
  const opened = h.open();
  assert.equal(opened.state, 'available', JSON.stringify(opened.stateMessage));
  assert.ok(ffs._state.fired.some((f) => f.name === 'fsyncSync' && f.code === 'EPERM'), 'the directory-flush refusal was actually exercised (hook witnessed)');
  const fileFsyncsBefore = ffs._state.calls.filter((c) => c.name === 'fsyncSync' && isFile(c.path)).length;
  const ack = await begin(h, 'inj-win', 'w1');
  assert.equal(ack.type, 'ack', JSON.stringify(ack)); assert.equal(ack.basis, 'written');
  const fileFsyncsAfter = ffs._state.calls.filter((c) => c.name === 'fsyncSync' && isFile(c.path)).length;
  assert.ok(fileFsyncsAfter > fileFsyncsBefore, 'the begin was acked only after a FILE fsync');
  const st = status(h);
  assert.deepEqual({ platform: st.durability.platform, file_flush: st.durability.file_flush, dir_flush: st.durability.dir_flush, code: st.durability.dir_flush_code },
    { platform: 'win32', file_flush: 'fsync', dir_flush: 'unsupported', code: 'EPERM' });
  assert.ok(st.io.dir_flush_unsupported > 0);
  assert.equal((await h.close()).clean, true); h.release();
  const h2 = createOwnerHarness({ dir: s.dir, fsImpl: dirFlushRefused(), platform: 'win32' });
  assert.equal(h2.open().state, 'available');
  assert.equal(h2.read('get', { id: 'inj-win' }).items[0].tracking_state, 'tracked');
  await h2.close(); h2.release();
}));

test('win32 branch: a 0.9.x legacy file migrates with directory flush refused; legacy copy and aside hash == original', () => withStore(async (s) => {
  const legacy = writeLegacyLedger(s.dir, { count: 6 });
  const h = createOwnerHarness({ dir: s.dir, fsImpl: dirFlushRefused(), platform: 'win32' });
  const o = h.open();
  assert.equal(o.state, 'available', JSON.stringify(o.stateMessage));
  assert.equal(fs.statSync(s.dir).isDirectory(), true);
  assert.equal(sha256(fs.readFileSync(path.join(s.dir, 'legacy', 'tracked-injections.v3.json'))), legacy.sha256);
  const aside = fs.readdirSync(s.parent).find((n) => n.startsWith('tracked-injections.json.pre-0.10.'));
  assert.ok(aside, 'the original is retained aside');
  assert.equal(sha256(fs.readFileSync(path.join(s.parent, aside))), legacy.sha256);
  await h.close(); h.release();
}));

test('POSIX branch: the SAME directory-flush EPERM is an I/O failure ⇒ open_failed, nothing acknowledged', () => withStore(async (s) => {
  const h = createOwnerHarness({ dir: s.dir, fsImpl: dirFlushRefused(), platform: 'linux' });
  const o = h.open();
  assert.equal(o.state, 'unavailable', JSON.stringify(o.stateMessage));
  assert.equal(o.reason, 'open_failed');
  assert.equal(o.stateMessage.code, 'EPERM');
  assert.equal(h.ofType('ack').length, 0);
  h.release();
}));

test('win32 branch: other directory-flush errnos and a directory that cannot be OPENED still fail closed', async () => {
  for (const code of ['EIO', 'EACCES']) await withStore(async (s) => {
    const ffs = createFaultFs({ faults: { fsyncSync: [{ times: 1e6, code, when: (_a, p) => isDir(p) }] } });
    const h = createOwnerHarness({ dir: s.dir, fsImpl: ffs, platform: 'win32' });
    const o = h.open();
    assert.equal(o.state, 'unavailable', `${code}: ${JSON.stringify(o.stateMessage)}`);
    assert.equal(o.stateMessage.code, code);
    h.release();
  });
  await withStore(async (s) => {
    const noOpen = createFaultFs({ faults: { openSync: [{ times: 1e6, code: 'EACCES', when: (args) => isDir(args[0]) }] } });
    const h = createOwnerHarness({ dir: s.dir, fsImpl: noOpen, platform: 'win32' });
    const o = h.open();
    assert.equal(o.state, 'unavailable', JSON.stringify(o.stateMessage));
    assert.equal(o.stateMessage.code, 'EACCES');
    h.release();
  });
});

test('win32 branch: an injected FILE fsync failure is never acknowledged (EIO and EPERM on a segment file ⇒ indeterminate, not ack)', async () => {
  for (const [i, code] of ['EIO', 'EPERM'].entries()) await withStore(async (s) => {
    const ffs = dirFlushRefused();
    const h = createOwnerHarness({ dir: s.dir, fsImpl: ffs, platform: 'win32' });
    assert.equal(h.open().state, 'available');
    // From here on every fsync of a segment FILE fails (persistent, so the owner's one retry in a
    // new segment fails too).
    ffs._state.faults.fsyncSync.push({ times: 1e6, code, when: (_a, p) => isFile(p) && p.includes(`${path.sep}segments${path.sep}`) });
    const out = await begin(h, `inj-fail-${i}`, 'w1');
    assert.notEqual(out.type, 'ack', `${code}: a failed file fsync must not ack: ${JSON.stringify(out)}`);
    assert.equal(out.type, 'indeterminate', `${code}: ${JSON.stringify(out)}`);
    assert.ok(ffs._state.fired.some((f) => f.name === 'fsyncSync' && f.code === code && isFile(f.path)), `${code}: the file-fsync fault fired`);
    await h.close(); h.release();
  });
});

test('client: a process whose only handle is the unref\'d owner worker still receives open, begin and close replies (no event-loop drain under await)', () => withStore(async (s) => {
  const client = path.join(__dirname, '..', 'src', 'session-store', 'ledger-client.js');
  const pers = path.join(__dirname, '..', 'src', 'session-store', 'persistence.js');
  const script = `
    const { createLedgerClient } = require(${JSON.stringify(client)});
    const persistence = require(${JSON.stringify(pers)});
    (async () => {
      const c = createLedgerClient({ dir: ${JSON.stringify(s.dir)}, lockPath: ${JSON.stringify(s.lockPath)}, legacyPath: ${JSON.stringify(s.dir)}, unrefWorker: true });
      const opened = await c.open();
      const at = new Date().toISOString();
      const record = { inject_id: 'inj-loop', session_id: 'w1', session_epoch: null, session_epoch_reason: 'no_815_epoch_fact', transport_source: 'orch', created_at: at,
        observation_seq: 0, observations: [], last_observation: null, capability: { stage: 'A' }, tracking_state: 'tracked' };
      persistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, at);
      const reserved = c.reserveJob('inj-loop');
      const begun = await c.submit('begin', { id: 'inj-loop', sid: 'w1', record, at }, { class: 'T' });
      const st = await c.ownerStatus();
      const closed = await c.close(2000);
      process.stdout.write(JSON.stringify({ opened: opened.ok, reserved: reserved.ok, begun: begun.outcome, dir_flush: st && st.durability && st.durability.dir_flush, clean: closed.closed.clean }) + '\\n');
    })();`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: s.home, USERPROFILE: s.home } });
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const line = run.stdout.trim().split('\n').pop();
  assert.ok(line, `the child printed its result before exiting (stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)})`);
  const r = JSON.parse(line);
  assert.deepEqual({ opened: r.opened, reserved: r.reserved, begun: r.begun, clean: r.clean }, { opened: true, reserved: true, begun: 'ack', clean: true });
  assert.equal(r.dir_flush, process.platform === 'win32' ? 'unsupported' : 'flushed');
}));
