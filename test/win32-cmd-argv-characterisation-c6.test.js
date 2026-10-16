'use strict';
// CHARACTERISATION (PR #108 review C6, unchanged on purpose — tracked as its own issue): on win32,
// POST /api/sessions/spawn builds cmd.exe /c <command> <args…> and node-pty joins it into ONE
// command line that cmd.exe parses — `&`, `|`, `>` in args are cmd syntax. This pins the CURRENT
// behaviour; invert the asserts when the Windows fix lands. Same principal as the caller (it may
// already send command:"cmd", args:["/c", …]), so not a privilege boundary today.
// Runs on Linux only: platform is faked for the route's one isWin line (test-support/
// win32-spawn-recorder-preload.js) and node-pty spawn is a recorder, so nothing is executed.
// Reviewer probe origin: tp-108s-rev, round2-evidence/win32-cmd-argv.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { startTestDaemon, createSessionId } = require(path.join(ROOT, 'test-support/daemon-harness'));
const { argsToCommandLine } = require(path.join(ROOT, 'node_modules/node-pty/lib/windowsPtyAgent.js'));
const rec = process.platform === 'win32' ? null : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rev-win32-')), 'spawn.jsonl');
const line = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'daemon.js'), 'utf8').split('\n');
  const i = src.findIndex((l) => l.includes("const isWin = os.platform() === 'win32';") && src.slice(Math.max(0, src.indexOf(l) - 20), src.indexOf(l)).length >= 0);
  // the spawn route's isWin line: the first one after app.post('/api/sessions/spawn'
  const routeAt = src.findIndex((l) => l.includes("app.post('/api/sessions/spawn'"));
  const j = src.findIndex((l, k) => k > routeAt && l.includes("const isWin = os.platform() === 'win32';"));
  return `daemon.js:${j + 1}:`;
})();
let d;
before(async () => {
  if (process.platform === 'win32') return;
  d = await startTestDaemon({ env: {
    NODE_OPTIONS: `--require ${path.join(ROOT, 'test-support', 'win32-spawn-recorder-preload.js')}`,
    REV_WIN32_RECORD: rec, REV_WIN32_LINE: line } });
});
after(async () => { if (d) await d.stop(); });

test('C6 characterisation (win32, unchanged): spawn args reach cmd.exe /c unescaped; cmd metacharacters survive into the command line', async (t) => {
  if (process.platform === 'win32') return t.skip('fakes win32 on POSIX; would execute on real Windows');
  const cases = [
    { command: 'node', args: ['-v', '&echo', 'X'] },          // unquoted & → second command for cmd
    { command: 'node', args: ['&echo X'] },                    // has a space → node-pty quotes it ("&echo X")
    { command: 'node', args: ['a|calc'] },                     // pipe
  ];
  for (const c of cases) {
    const res = await d.spawnSession(createSessionId('rev-win'), c);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const recs = fs.readFileSync(rec, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const r of recs) console.log('argv', JSON.stringify([r.file, ...r.args]), '| cmdline', argsToCommandLine(r.file, r.args), '| PS1 set:', r.hasPS1);
  assert.deepEqual(recs.map((r) => [r.file, ...r.args]), [
    ['cmd.exe', '/c', 'node', '-v', '&echo', 'X'],
    ['cmd.exe', '/c', 'node', '&echo X'],
    ['cmd.exe', '/c', 'node', 'a|calc'],
  ]);
  assert.equal(argsToCommandLine(recs[0].file, recs[0].args), 'cmd.exe /c node -v &echo X');   // cmd runs `echo X`
  assert.equal(argsToCommandLine(recs[1].file, recs[1].args), 'cmd.exe /c node "&echo X"');    // quoted: literal for cmd
  assert.equal(argsToCommandLine(recs[2].file, recs[2].args), 'cmd.exe /c node a|calc');      // cmd pipes to calc
  assert.ok(recs.every((r) => r.hasPS1 === false), 'no PS1 on win32');
});
