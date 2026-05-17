'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const winPath = path.win32;

const { resolveWindowsExecutable } = require('../src/win-resolve-executable');

function makeExistsSync(presentSet) {
  return (p) => presentSet.has(p);
}

test('POSIX: returns command unchanged (no-op)', () => {
  const result = resolveWindowsExecutable('claude', { PATH: '/usr/bin', PATHEXT: '.EXE' }, {
    platform: 'linux',
    existsSync: () => false,
  });
  assert.equal(result, 'claude');
});

test('POSIX (darwin): returns command unchanged even with absolute path', () => {
  const result = resolveWindowsExecutable('/usr/local/bin/claude', {}, {
    platform: 'darwin',
    existsSync: () => false,
  });
  assert.equal(result, '/usr/local/bin/claude');
});

test('Windows: bare name resolves to PATHEXT .CMD match (npm-global claude.cmd)', () => {
  // PATHEXT walker uses ext strings verbatim from env, so the candidate matches
  // the casing of the PATHEXT entry. (Real Windows fs is case-insensitive; the
  // test mock uses Set lookup which is case-sensitive, so cases must match.)
  const expected = winPath.join('C:\\Users\\u\\AppData\\Roaming\\npm', 'claude.CMD');
  const present = new Set([expected]);
  const result = resolveWindowsExecutable('claude', {
    PATH: 'C:\\Windows\\System32;C:\\Users\\u\\AppData\\Roaming\\npm',
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(present),
  });
  assert.equal(result, expected);
});

test('Windows: bare name picks first PATHEXT match in order', () => {
  const dir = 'C:\\bin';
  const exe = winPath.join(dir, 'tool.EXE');
  const cmd = winPath.join(dir, 'tool.CMD');
  const present = new Set([exe, cmd]);
  const result = resolveWindowsExecutable('tool', {
    PATH: dir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(present),
  });
  assert.equal(result, exe);
});

test('Windows: bare name picks first PATH directory winner', () => {
  const dirA = 'C:\\binA';
  const dirB = 'C:\\binB';
  const present = new Set([
    winPath.join(dirA, 'tool.EXE'),
    winPath.join(dirB, 'tool.EXE'),
  ]);
  const result = resolveWindowsExecutable('tool', {
    PATH: `${dirA};${dirB}`,
    PATHEXT: '.EXE',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(present),
  });
  assert.equal(result, winPath.join(dirA, 'tool.EXE'));
});

test('Windows: command with extension already wins via empty-ext probe', () => {
  const dir = 'C:\\bin';
  const present = new Set([winPath.join(dir, 'tool.cmd')]);
  const result = resolveWindowsExecutable('tool.cmd', {
    PATH: dir,
    PATHEXT: '.EXE;.CMD',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(present),
  });
  assert.equal(result, winPath.join(dir, 'tool.cmd'));
});

test('Windows: default PATHEXT used when env.PATHEXT missing', () => {
  const dir = 'C:\\bin';
  const expected = winPath.join(dir, 'claude.CMD');
  const present = new Set([expected]);
  const result = resolveWindowsExecutable('claude', {
    PATH: dir,
    // PATHEXT intentionally absent
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(present),
  });
  assert.equal(result, expected);
});

test('Windows: throws when command not found via PATHEXT walk', () => {
  assert.throws(
    () => resolveWindowsExecutable('does-not-exist', {
      PATH: 'C:\\bin',
      PATHEXT: '.EXE;.CMD',
    }, {
      platform: 'win32',
      existsSync: () => false,
    }),
    /cannot find executable "does-not-exist"/
  );
});

test('Windows: absolute path with extension returned as-is when present', () => {
  const absolute = 'C:\\tools\\my.exe';
  const result = resolveWindowsExecutable(absolute, {
    PATH: '',
    PATHEXT: '.EXE',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([absolute])),
  });
  assert.equal(result, absolute);
});

test('Windows: absolute path without extension resolves via PATHEXT', () => {
  const base = 'C:\\tools\\my';
  const expected = `${base}.CMD`;
  const result = resolveWindowsExecutable(base, {
    PATH: '',
    PATHEXT: '.EXE;.CMD',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([expected])),
  });
  assert.equal(result, expected);
});

test('Windows: rejects empty command', () => {
  assert.throws(
    () => resolveWindowsExecutable('', {}, { platform: 'win32', existsSync: () => true }),
    /requires a non-empty command/
  );
});

test('Windows: rejects non-string command', () => {
  assert.throws(
    () => resolveWindowsExecutable(null, {}, { platform: 'win32', existsSync: () => true }),
    /requires a non-empty command/
  );
});

test('Windows: missing PATH yields PATHEXT-walk failure (not crash)', () => {
  assert.throws(
    () => resolveWindowsExecutable('claude', { PATHEXT: '.CMD' }, {
      platform: 'win32',
      existsSync: () => false,
    }),
    /cannot find executable "claude"/
  );
});

test('Windows: extensionless sibling does NOT shadow .CMD shim for bare name', () => {
  // npm-global publishes both an extensionless POSIX shell script `claude`
  // AND `claude.cmd` in the same directory. cmd.exe shell only matches
  // PATHEXT entries for bare names, so `telepty allow ... claude` must
  // resolve to claude.CMD — not the shell script that node-pty (and cmd)
  // cannot execute.
  const dir = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const bareScript = winPath.join(dir, 'claude');
  const cmdShim = winPath.join(dir, 'claude.CMD');
  const result = resolveWindowsExecutable('claude', {
    PATH: dir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(new Set([bareScript, cmdShim])),
  });
  assert.equal(result, cmdShim);
});

test('Windows: PATHEXT entries with whitespace are trimmed', () => {
  const dir = 'C:\\bin';
  const expected = winPath.join(dir, 'tool.CMD');
  const present = new Set([expected]);
  const result = resolveWindowsExecutable('tool', {
    PATH: dir,
    PATHEXT: ' .EXE ; .CMD ',
  }, {
    platform: 'win32',
    existsSync: makeExistsSync(present),
  });
  assert.equal(result, expected);
});
