'use strict';

// Snyk Code on 9cff4bf (SNYK-9CFF4BF.md, verdicts in FINDINGS-9CFF4BF.md). Each test feeds the
// crafted input to the real sink and is RED on 9cff4bf.
//
//   4fc6e5b9 / 4158b586 / 20746b91 (daemon.js mailbox purge routes) and 0b79a913 (cli.js bridge
//   purge): FileMailbox put a session id into path.join(root, id) unchecked. Spawn refuses `.`/`..`
//   (NB4), but register accepts any id, so `..` or `../x` reached files outside the mailbox root.
//   aadc4863 / 0ab74261 / deee8c0c (cli.js connect / disconnect / peers --remove): the ssh target
//   was joined into a /bin/sh command string.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { FileMailbox } = require('../src/mailbox');
const { startTestDaemon } = require('../test-support/daemon-harness');

const posixOnly = (t) => (process.platform === 'win32' ? t.skip('POSIX shell sinks') : false);

// ------------------------------------------------------------------------------ mailbox paths

test('FileMailbox refuses ids that resolve to the root or outside it', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 's9-mbox-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'mailbox');
  const outside = path.join(base, 'x');
  fs.mkdirSync(outside);
  for (const f of ['inbox.jsonl', 'state.jsonl', 'dead-letter.jsonl']) fs.writeFileSync(path.join(outside, f), 'keep\n');
  fs.writeFileSync(path.join(base, 'inbox.jsonl'), 'keep\n');
  const mailbox = new FileMailbox({ root });

  for (const id of ['../x', '..', '.', 'a/../../x']) {
    assert.throws(() => mailbox.purge(id), /session id/, `purge(${JSON.stringify(id)})`);
    assert.throws(() => mailbox.purgeDeadLetter(id), /session id/, `purgeDeadLetter(${JSON.stringify(id)})`);
    assert.throws(() => mailbox.enqueue({ msg_id: 'm1', from: 'a', to: id, payload: 'p', created_at: Math.floor(Date.now() / 1000) }),
      /session id/, `enqueue to ${JSON.stringify(id)}`);
  }
  for (const f of ['inbox.jsonl', 'state.jsonl', 'dead-letter.jsonl']) {
    assert.equal(fs.readFileSync(path.join(outside, f), 'utf8'), 'keep\n', `${f} outside the root was written`);
  }
  assert.equal(fs.readFileSync(path.join(base, 'inbox.jsonl'), 'utf8'), 'keep\n');
  assert.equal(fs.existsSync(path.join(root, 'inbox.jsonl')), false, 'a file was written in the root itself');

  // Ordinary ids are unchanged.
  const ok = mailbox.enqueue({ msg_id: 'm2', from: 'a', to: 'w-1.claude', payload: 'p', created_at: Math.floor(Date.now() / 1000) });
  assert.equal(ok.queued, true);
  mailbox.purge('w-1.claude');
  mailbox.purgeDeadLetter('w-1.claude');
  assert.equal(fs.readFileSync(path.join(root, 'w-1.claude', 'inbox.jsonl'), 'utf8'), '');
});

// Mac re-review R1: every producer of a session id (register, PATCH rename, spawn, WS, a legacy
// sessions.json record from before the refusal, the CLI bridge mailbox) and every encoded route
// into FileMailbox must leave sibling files of the mailbox root unchanged.
test('R1: register / rename / spawn / WS / restored legacy id / encoded routes leave sibling files unchanged', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 's9-r1-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const aigentry = path.join(home, '.aigentry'); // mailbox root is ~/.aigentry/mailbox
  const victim = path.join(aigentry, 'victim');
  fs.mkdirSync(victim, { recursive: true });
  const files = ['inbox.jsonl', 'state.jsonl', 'dead-letter.jsonl'];
  const siblings = [...files.map((f) => path.join(victim, f)), ...files.map((f) => path.join(aigentry, f))];
  for (const f of siblings) fs.writeFileSync(f, 'keep\n');
  // A record persisted before register refused `../victim` is restored as-is (no migration).
  const persist = path.join(home, '.config', 'aigentry-telepty', 'sessions.json');
  fs.mkdirSync(path.dirname(persist), { recursive: true });
  fs.writeFileSync(persist, JSON.stringify({ '../victim': { id: '../victim', type: 'wrapped', command: 'legacy', cwd: home, createdAt: new Date().toISOString() } }));

  const daemon = await startTestDaemon({ homeDir: home });
  t.after(() => daemon.stop());

  for (const sid of ['../victim', '..', 'a/../../victim']) {
    const reg = await daemon.registerSession(sid);
    assert.equal(reg.status, 400, `register ${sid}`);
    const sp = await daemon.spawnSession(sid);
    // `../victim` is taken by the restored legacy record, and spawn answers 409 before its id check.
    assert.ok(sp.status === 400 || (sid === '../victim' && sp.status === 409), `spawn ${sid}: ${sp.status}`);
  }
  const okId = `r1-ok-${Date.now()}`;
  assert.equal((await daemon.registerSession(okId)).status, 201);
  for (const newId of ['../renamed', '..']) {
    const ren = await daemon.request(`/api/sessions/${okId}`, { method: 'PATCH', body: { new_id: newId } });
    assert.equal(ren.status, 400, `rename to ${newId}: ${JSON.stringify(ren.body)}`);
    assert.equal(ren.body.code, 'INVALID_SESSION_ID');
  }
  const ws = await daemon.connectSession('...');
  await new Promise((resolve) => { ws.once('close', resolve); setTimeout(resolve, 1500); });
  ws.terminate();

  // The restored legacy id is reachable through the encoded route, so the storage boundary is
  // what protects the siblings here.
  assert.equal((await daemon.request('/api/sessions/..%2Fvictim')).status, 200, 'legacy record restored');
  await daemon.request('/api/sessions/..%2Fvictim/inject', { method: 'POST', body: { prompt: 'x', no_enter: true } });
  await daemon.request('/api/sessions/..%2Fvictim/mailbox', { method: 'DELETE' });            // 4fc6e5b9
  await daemon.request('/api/sessions/..%2Fvictim/mailbox/dead-letter', { method: 'DELETE' }); // 4158b586
  await daemon.request('/api/sessions/..%2Fvictim', { method: 'DELETE' });                    // 20746b91

  // The CLI bridge mailbox (cli.js:3066, 0b79a913) is a FileMailbox under mailbox/bridge.
  const bridge = new FileMailbox({ root: path.join(aigentry, 'mailbox', 'bridge') });
  assert.throws(() => bridge.purge('../../victim'), /session id/);
  assert.throws(() => bridge.enqueue({ msg_id: 'b1', from: 'a', to: '../../victim', payload: 'p', created_at: Math.floor(Date.now() / 1000) }), /session id/);

  for (const f of siblings) assert.equal(fs.readFileSync(f, 'utf8'), 'keep\n', `${path.relative(home, f)} changed`);
  assert.equal(fs.existsSync(path.join(aigentry, 'mailbox', 'victim')), false);
});

// ------------------------------------------------------------------------ cross-machine ssh

// A temp HOME and a PATH with only a fake `ssh` (logs its argv, succeeds) and `touch`: an unfixed
// shell string runs the injected `touch`, while no real ssh is ever reached.
function fakeSshEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's9-ssh-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(childProcess.execFileSync('/bin/sh', ['-c', 'command -v touch'], { encoding: 'utf8' }).trim(), path.join(bin, 'touch'));
  const log = path.join(dir, 'ssh.log');
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = bin;
  process.env.HOME = dir;
  delete require.cache[require.resolve('../cross-machine')];
  t.after(() => {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
    delete require.cache[require.resolve('../cross-machine')];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, log, crossMachine: require('../cross-machine') };
}

test('telepty connect / disconnect / peers --remove pass the ssh target as one argv element', async (t) => {
  if (posixOnly(t)) return;
  const { dir, log, crossMachine } = fakeSshEnv(t);
  const marker = path.join(dir, 'ran');
  const target = `u@h;touch ${marker};#`; // `#`: an unfixed shell ignores the rest of its string
  const result = await crossMachine.connect(target, { name: 'p' });          // aadc4863
  assert.equal(fs.existsSync(marker), false, 'connect ran the target as a shell command');
  assert.equal(result.success, true, JSON.stringify(result));
  crossMachine.disconnect('p');                                               // 0ab74261
  assert.equal(fs.existsSync(marker), false, 'disconnect ran the target as a shell command');
  await crossMachine.connect(target, { name: 'p' });
  crossMachine.removePeer('p');                                               // deee8c0c
  assert.equal(fs.existsSync(marker), false, 'peers --remove ran the target as a shell command');
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.length >= 6 && calls.every((c) => c.endsWith(target) || c.includes(`${target} `)), calls.join('\n'));
});

test('telepty connect refuses a target that ssh would read as an option', async (t) => {
  if (posixOnly(t)) return;
  const { log, crossMachine } = fakeSshEnv(t);
  const result = await crossMachine.connect('-oProxyCommand=touch@x', { name: 'q' });
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(log), false, 'ssh was invoked with an option-shaped target');
});
