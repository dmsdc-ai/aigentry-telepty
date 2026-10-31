'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPtySpawnTarget } = require('../src/win-spawn-target');
const opts = { platform: 'win32', existsSync: () => true };
const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };

test('POSIX arguments remain literal argv', () => {
  const args = ['x &echo X', '"', '', '%PATH%', '!x!'];
  assert.deepEqual(buildPtySpawnTarget('node', args, {}, { platform: 'linux' }), { file: 'node', args });
});
test('Windows executables bypass cmd, preserving metacharacter argv', () => {
  for (const file of ['C:\\bin\\node.exe', 'C:\\bin\\app.com']) {
    const args = ['-v &echo X', 'a|b', '>out', '^', '" & whoami', '%PATH%', '!x!', ''];
    assert.deepEqual(buildPtySpawnTarget(file, args, env, opts), { file, args });
  }
});
test('Windows npm shim command line escapes shell syntax at both parsing layers', () => {
  const target = buildPtySpawnTarget('C:\\Program Files\\tool.cmd', ['a&b', 'a|b', '>out', '^', '" & echo X', '!x!', '', 'trail\\'], env, opts);
  assert.equal(target.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(typeof target.args, 'string');
  assert.ok(target.args.startsWith('/d /v:off /s /c "C:\\Program^ Files\\tool.cmd '));
  for (const escaped of ['a^^^&b', 'a^^^|b', '^^^>out', '^^^^', '^^^!x^^^!']) assert.ok(target.args.includes(escaped), escaped);
  assert.ok(target.args.includes('^^^"^^^"')); // empty argument survives
});
test('batch percent expansion and line breaks fail closed', () => {
  for (const arg of ['%PATH%', 'line\nnext', 'line\rnext']) {
    assert.throws(() => buildPtySpawnTarget('C:\\bin\\tool.cmd', [arg], env, opts), /cannot contain percent signs or line breaks/);
  }
});
test('Windows PowerShell scripts use explicit -File argv; unsupported scripts fail closed', () => {
  assert.deepEqual(buildPtySpawnTarget('C:\\bin\\tool.ps1', ['a&b'], env, opts), {
    file: 'powershell.exe', args: ['-NoLogo', '-File', 'C:\\bin\\tool.ps1', 'a&b']
  });
  assert.ok(!buildPtySpawnTarget('C:\\bin\\tool.ps1', [], env, opts).args.includes('-ExecutionPolicy'));
  assert.throws(() => buildPtySpawnTarget('C:\\bin\\tool.js', [], env, opts), /unsupported Windows executable type/);
});

test('REST Windows spawn calls production target builder before PTY spawn', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { registerSpawnRoute } = require('../src/routes/spawn');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-115-'));
  try {
    const executable = path.join(root, 'node.exe');
    fs.writeFileSync(executable, 'fixture');
    let handler, spawned;
    registerSpawnRoute({ post: (_, fn) => { handler = fn; } }, {
      sessions: {}, os: { platform: () => 'win32' },
      admission: { take: () => ({ allowed: true }) },
      buildSessionEnv: () => ({}),
      pty: { spawn: (...args) => { spawned = args; throw new Error('test capture'); } }
    });
    const response = { status() { return this; }, json() {} };
    handler({ body: { session_id: 'fixture', command: executable, args: ['-v &echo X', '%PATH%'] } }, response);
    assert.equal(spawned[0], executable);
    assert.deepEqual(spawned[1], ['-v &echo X', '%PATH%']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native Windows npm-style shim preserves literal argv', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const pty = require('node-pty');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-115-'));
  try {
    const helper = path.join(root, 'capture.js');
    const output = path.join(root, 'argv.json');
    const shim = path.join(root, 'fixture.cmd');
    fs.writeFileSync(helper, `require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`);
    fs.writeFileSync(shim, `@"${process.execPath}" "${helper}" %*\r\n`);
    const args = ['a&b', 'a|b', '>out', '^', '" & echo X', '!x!', '', 'trail\\'];
    const target = buildPtySpawnTarget(shim, args, process.env);
    await new Promise((resolve, reject) => {
      const child = pty.spawn(target.file, target.args, { env: process.env, cwd: root, cols: 80, rows: 24 });
      child.onData(() => {});
      child.onExit(({ exitCode }) => exitCode === 0 ? resolve() : reject(new Error(`shim exited ${exitCode}`)));
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), args);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
