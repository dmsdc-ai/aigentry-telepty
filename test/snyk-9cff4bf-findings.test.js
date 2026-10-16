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

test('daemon: the DELETE routes of a registered `../x` session do not touch files outside the mailbox root', async (t) => {
  const daemon = await startTestDaemon();
  t.after(() => daemon.stop());
  const x = path.join(daemon.homeDir, '.aigentry', 'x'); // mailbox root is ~/.aigentry/mailbox
  fs.mkdirSync(x, { recursive: true });
  for (const f of ['inbox.jsonl', 'state.jsonl', 'dead-letter.jsonl']) fs.writeFileSync(path.join(x, f), 'keep\n');
  // Since NB4 option A, register refuses `../x` (400); the files are checked first so this stays
  // RED on 9cff4bf, where the register succeeded and the DELETE routes truncated them.
  const reg = await daemon.registerSession('../x');
  // `..%2Fx` survives URL normalisation and express decodes it to `../x` (a bare `..` segment
  // does not survive, so `..` itself is covered by the FileMailbox test above).
  await daemon.request('/api/sessions/..%2Fx/mailbox', { method: 'DELETE' });           // 4fc6e5b9
  await daemon.request('/api/sessions/..%2Fx/mailbox/dead-letter', { method: 'DELETE' }); // 4158b586
  await daemon.request('/api/sessions/..%2Fx', { method: 'DELETE' });                   // 20746b91
  for (const f of ['inbox.jsonl', 'state.jsonl', 'dead-letter.jsonl']) {
    assert.equal(fs.readFileSync(path.join(x, f), 'utf8'), 'keep\n', `~/.aigentry/x/${f} was truncated`);
  }
  assert.equal(reg.status, 400, 'register refuses an id containing /');
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
