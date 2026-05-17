'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const winPath = path.win32;

const { buildPtySpawnTarget } = require('../src/win-spawn-target');

function makeExistsSync(presentSet) {
  return (p) => presentSet.has(p);
}

test('POSIX: pass-through (no resolution, no wrap)', () => {
  const target = buildPtySpawnTarget('claude', ['--continue'], { PATH: '/usr/bin', PATHEXT: '.EXE' }, {
    platform: 'linux',
    existsSync: () => false,
  });
  assert.deepEqual(target, { file: 'claude', args: ['--continue'] });
});

test('POSIX (darwin): pass-through preserves absolute paths and args', () => {
  const target = buildPtySpawnTarget('/usr/local/bin/claude', ['--continue'], {}, {
    platform: 'darwin',
    existsSync: () => false,
  });
  assert.deepEqual(target, { file: '/usr/local/bin/claude', args: ['--continue'] });
});

test('POSIX: undefined/null args coerces to empty array', () => {
  const t1 = buildPtySpawnTarget('claude', undefined, {}, { platform: 'linux' });
  const t2 = buildPtySpawnTarget('claude', null, {}, { platform: 'linux' });
  assert.deepEqual(t1.args, []);
  assert.deepEqual(t2.args, []);
});

test('Windows: .exe target spawns directly with array args (no wrap)', () => {
  const dir = 'C:\\tools';
  const expected = winPath.join(dir, 'tool.EXE');
  const target = buildPtySpawnTarget('tool', ['--flag'], {
    PATH: dir,
    PATHEXT: '.EXE;.CMD',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([expected])),
  });
  assert.deepEqual(target, { file: expected, args: ['--flag'] });
});

test('Windows: .com target spawns directly with array args', () => {
  const dir = 'C:\\bin';
  const expected = winPath.join(dir, 'old.COM');
  const target = buildPtySpawnTarget('old', [], {
    PATH: dir,
    PATHEXT: '.EXE;.COM',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([expected])),
  });
  assert.deepEqual(target, { file: expected, args: [] });
});

test('Windows: .cmd shim wraps via cmd.exe /d /s /c (fixes claude.cmd error 193)', () => {
  const dir = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const cmd = winPath.join(dir, 'claude.CMD');
  const target = buildPtySpawnTarget('claude', ['--dangerously-skip-permissions', '--continue'], {
    PATH: dir,
    PATHEXT: '.EXE;.CMD',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([cmd])),
  });
  assert.equal(target.file, 'C:\\Windows\\System32\\cmd.exe');
  // args is a single pre-formatted string so node-pty uses it verbatim.
  assert.equal(typeof target.args, 'string');
  assert.ok(target.args.startsWith('/d /s /c "'), `expected '/d /s /c "...' prefix, got: ${target.args}`);
  assert.ok(target.args.endsWith('"'));
  // The resolved .cmd path and both args must appear in the wrapped cmdline.
  assert.ok(target.args.includes(cmd), `expected resolved path, got: ${target.args}`);
  assert.ok(target.args.includes('--dangerously-skip-permissions'));
  assert.ok(target.args.includes('--continue'));
});

test('Windows: .bat shim also wraps via cmd.exe', () => {
  const dir = 'C:\\bin';
  const bat = winPath.join(dir, 'oldtool.BAT');
  const target = buildPtySpawnTarget('oldtool', [], {
    PATH: dir,
    PATHEXT: '.BAT',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([bat])),
  });
  assert.equal(target.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(typeof target.args, 'string');
  assert.ok(target.args.startsWith('/d /s /c "'));
});

test('Windows: .ps1 wraps via powershell.exe -ExecutionPolicy Bypass -File (array args)', () => {
  const dir = 'C:\\scripts';
  const ps1 = winPath.join(dir, 'my.PS1');
  const target = buildPtySpawnTarget('my', ['arg1'], {
    PATH: dir,
    PATHEXT: '.PS1',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([ps1])),
  });
  assert.equal(target.file, 'powershell.exe');
  assert.deepEqual(target.args, ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', ps1, 'arg1']);
});

test('Windows: PSExecutablePath env var overrides default powershell.exe', () => {
  const dir = 'C:\\scripts';
  const ps1 = winPath.join(dir, 'my.PS1');
  const target = buildPtySpawnTarget('my', [], {
    PATH: dir,
    PATHEXT: '.PS1',
    PSExecutablePath: 'pwsh.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([ps1])),
  });
  assert.equal(target.file, 'pwsh.exe');
});

test('Windows: ComSpec env var overrides default cmd.exe path', () => {
  const dir = 'C:\\bin';
  const cmd = winPath.join(dir, 'tool.CMD');
  const target = buildPtySpawnTarget('tool', [], {
    PATH: dir,
    PATHEXT: '.CMD',
    ComSpec: 'D:\\custom\\cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([cmd])),
  });
  assert.equal(target.file, 'D:\\custom\\cmd.exe');
});

test('Windows: falls back to default cmd.exe when ComSpec unset', () => {
  const dir = 'C:\\bin';
  const cmd = winPath.join(dir, 'tool.CMD');
  const target = buildPtySpawnTarget('tool', [], {
    PATH: dir,
    PATHEXT: '.CMD',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([cmd])),
  });
  assert.equal(target.file, 'C:\\Windows\\System32\\cmd.exe');
});

test('Windows: path with spaces gets one wrap-quoted token inside the cmdline', () => {
  const dir = 'C:\\Program Files\\My App';
  const cmd = winPath.join(dir, 'tool.CMD');
  const target = buildPtySpawnTarget('tool', [], {
    PATH: dir,
    PATHEXT: '.CMD',
    ComSpec: 'cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([cmd])),
  });
  // The resolved path must appear quoted exactly once inside the cmdline.
  // After /s strips the outer wrap, cmd will see "<path>" as a single token.
  assert.ok(
    target.args.includes(`"${cmd}"`),
    `expected one-pair-quoted path in cmdline, got: ${target.args}`
  );
});

test('Windows: arg with embedded double-quotes uses backslash-quote encoding', () => {
  const dir = 'C:\\bin';
  const cmd = winPath.join(dir, 'tool.CMD');
  const target = buildPtySpawnTarget('tool', ['say "hi"'], {
    PATH: dir,
    PATHEXT: '.CMD',
    ComSpec: 'cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([cmd])),
  });
  // Embedded " becomes \" per CreateProcessW rule (no caret-escape needed
  // — the receiving program's argv parser, not cmd, interprets \").
  assert.match(target.args, /say \\"hi\\"/);
});

test('Windows: args without special chars are not quoted (kept bare for cmd.exe)', () => {
  const dir = 'C:\\bin';
  const cmd = winPath.join(dir, 'tool.CMD');
  const target = buildPtySpawnTarget('tool', ['--flag', 'value'], {
    PATH: dir,
    PATHEXT: '.CMD',
    ComSpec: 'cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([cmd])),
  });
  // Plain args without special chars stay unquoted in the cmdline.
  assert.match(target.args, /--flag value/);
});

test('Windows: args with cmd metachars get quote-wrapped (cmd treats meta as literal in quotes)', () => {
  const dir = 'C:\\bin';
  const cmd = winPath.join(dir, 'tool.CMD');
  const target = buildPtySpawnTarget('tool', ['a&b', 'c|d'], {
    PATH: dir,
    PATHEXT: '.CMD',
    ComSpec: 'cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([cmd])),
  });
  // a&b and c|d each get wrapped in "..." so cmd treats & and | as literal.
  assert.match(target.args, /"a&b"/);
  assert.match(target.args, /"c\|d"/);
});

test('Windows: extensionless resolved target falls through to cmd.exe wrap', () => {
  const exe = 'C:\\tools\\noext';
  const target = buildPtySpawnTarget(exe, [], {
    PATHEXT: '.EXE',
    ComSpec: 'cmd.exe',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([exe])),
  });
  // No .exe/.com ext → cmd.exe wrap (let cmd decide; cmd will fail loudly
  // for non-runnable files rather than CreateProcessW error 193).
  assert.equal(target.file, 'cmd.exe');
  assert.equal(typeof target.args, 'string');
  assert.ok(target.args.startsWith('/d /s /c "'));
});

test('Windows: throws when bare command cannot be resolved', () => {
  assert.throws(
    () => buildPtySpawnTarget('does-not-exist', [], {
      PATH: 'C:\\bin',
      PATHEXT: '.EXE;.CMD',
    }, {
      platform: 'win32',
      existsSync: () => false,
    }),
    /cannot find executable/
  );
});
