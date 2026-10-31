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

test('Windows: bare name chooses .CMD before extensionless npm shim', () => {
  // PATHEXT walker uses ext strings verbatim from env, so the candidate matches
  // the casing of the PATHEXT entry. (Real Windows fs is case-insensitive; the
  // test mock uses Set lookup which is case-sensitive, so cases must match.)
  const npmDir = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const shim = winPath.join(npmDir, 'codex');
  const expected = winPath.join(npmDir, 'codex.CMD');
  const present = new Set([shim, expected]);
  const result = resolveWindowsExecutable('codex', {
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

test('Windows: absolute path without extension returned as-is when present', () => {
  const absolute = 'C:\\tools\\my';
  const result = resolveWindowsExecutable(absolute, {
    PATH: '',
    PATHEXT: '.EXE;.CMD',
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

// ── #1215 G6 (#752, native 3b2c44a): Windows environment keys are case-insensitive ────────────────────────────
// The bridge hands the resolver a plain-object copy of process.env (cli.js sessionEnv), which keeps the OS key spelling
// (`Path`, `PathExt`); the native diagnostic measured path_key_other_case:true and resolver_walk_finds:false for an
// existing stub. Cross-host cases below run everywhere with win32 path semantics; the real-fixture cases need a
// native win32 host (the resolver is a POSIX no-op by design, and win32 path joins are not POSIX paths).
const fs = require('fs');
const os = require('os');

for (const key of ['PATH', 'Path', 'path']) {
  test(`Windows #1215: bare name resolves through a ${key} key with PathExt spelling`, () => {
    const dir = 'C:\\npm';
    const expected = winPath.join(dir, 'claude.CMD');
    const env = Object.freeze({ [key]: `C:\\Windows\\System32;${dir}`, PathExt: '.COM;.EXE;.BAT;.CMD' });
    const result = resolveWindowsExecutable('claude', env, { platform: 'win32', existsSync: makeExistsSync(new Set([expected])) });
    assert.equal(result, expected);
  });
}

test('Windows #1215: duplicate case-variant keys resolve by lexicographic key order, not insertion order', () => {
  const dirA = 'C:\\binA';
  const dirB = 'C:\\binB';
  const present = new Set([winPath.join(dirA, 'tool.EXE'), winPath.join(dirB, 'tool.EXE')]);
  const opts = { platform: 'win32', existsSync: makeExistsSync(present) };
  // Exact upper-case PATH keeps its precedence over another spelling, whichever was inserted first.
  assert.equal(resolveWindowsExecutable('tool', { Path: dirB, PATH: dirA, PATHEXT: '.EXE' }, opts), winPath.join(dirA, 'tool.EXE'));
  assert.equal(resolveWindowsExecutable('tool', { PATH: dirA, Path: dirB, PATHEXT: '.EXE' }, opts), winPath.join(dirA, 'tool.EXE'));
  // Without an exact key: 'Path' sorts before 'path'.
  assert.equal(resolveWindowsExecutable('tool', { path: dirA, Path: dirB, PATHEXT: '.EXE' }, opts), winPath.join(dirB, 'tool.EXE'));
  // PATHEXT spellings follow the same rule: 'PATHEXT' (.EXE) wins over 'PathExt' (.CMD).
  const both = new Set([winPath.join(dirA, 'tool.EXE'), winPath.join(dirA, 'tool.CMD')]);
  assert.equal(resolveWindowsExecutable('tool', { PATH: dirA, PathExt: '.CMD', PATHEXT: '.EXE' },
    { platform: 'win32', existsSync: makeExistsSync(both) }), winPath.join(dirA, 'tool.EXE'));
});

test('Windows #1215: an absolute path without extension honours a PathExt key spelling', () => {
  const base = 'C:\\tools\\my';
  const expected = `${base}.CMD`;
  const result = resolveWindowsExecutable(base, Object.freeze({ Path: '', PathExt: '.EXE;.CMD' }), {
    platform: 'win32', existsSync: makeExistsSync(new Set([expected])),
  });
  assert.equal(result, expected);
});

test('Windows #1215: a case-variant PATH never hides a genuinely missing executable', () => {
  for (const env of [{ Path: 'C:\\bin', PathExt: '.EXE;.CMD' }, { path: '' }, { PathExt: '.CMD' }]) {
    assert.throws(() => resolveWindowsExecutable('does-not-exist', Object.freeze(env), { platform: 'win32', existsSync: () => false }),
      /cannot find executable "does-not-exist" on PATH/);
  }
  assert.throws(() => resolveWindowsExecutable('', Object.freeze({ Path: 'C:\\bin' }), { platform: 'win32', existsSync: () => true }),
    /requires a non-empty command/);
});

test('Windows #1215: the env object and process.env are never modified', () => {
  const before = JSON.stringify(process.env);
  const env = Object.freeze({ Path: 'C:\\bin', PathExt: '.CMD' });
  resolveWindowsExecutable('tool', env, { platform: 'win32', existsSync: makeExistsSync(new Set([winPath.join('C:\\bin', 'tool.CMD')])) });
  assert.deepEqual(env, { Path: 'C:\\bin', PathExt: '.CMD' });
  assert.equal(JSON.stringify(process.env), before);
});

// Real temp executable fixtures on a native win32 host: the real filesystem and platform, no existsSync or platform
// override. The resolved path must be the fixture file itself (same bytes), and a fixture absent from PATH still throws.
const NATIVE = process.platform === 'win32' ? false : 'native win32 host only: the resolver is a POSIX no-op by design';
function nativeFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'win-resolve-1215-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture1215.cmd'), body = '@echo off\r\nrem #1215 fixture\r\n';
  fs.writeFileSync(file, body);
  return { dir, file, body };
}
for (const [pathKey, extKey] of [['PATH', 'PATHEXT'], ['Path', 'PathExt'], ['path', 'pathext']]) {
  test(`native win32 #1215: a real .cmd fixture resolves through ${pathKey}/${extKey} keys`, { skip: NATIVE }, (t) => {
    const fx = nativeFixture(t);
    const env = Object.freeze({ [pathKey]: `${process.env.SystemRoot || 'C:\\Windows'}\\System32;${fx.dir}`, [extKey]: '.COM;.EXE;.BAT;.CMD' });
    const result = resolveWindowsExecutable('fixture1215', env);
    assert.equal(path.resolve(result).toLowerCase(), path.resolve(fx.file).toLowerCase(), result);
    assert.equal(fs.readFileSync(result, 'utf8'), fx.body, 'the resolved executable is the real fixture file');
  });
}
test('native win32 #1215: a sessionEnv-shaped copy of process.env finds a real fixture added to its own PATH spelling', { skip: NATIVE }, (t) => {
  const fx = nativeFixture(t);
  const copy = { ...process.env };                      // the bridge's shape: OS key spelling preserved
  const pathKey = Object.keys(copy).find((key) => key.toUpperCase() === 'PATH') || 'Path';
  copy[pathKey] = `${fx.dir};${copy[pathKey] || ''}`;
  const result = resolveWindowsExecutable('fixture1215', Object.freeze(copy));
  assert.equal(fs.readFileSync(result, 'utf8'), fx.body);
});
test('native win32 #1215: a real fixture outside every PATH spelling is still not found', { skip: NATIVE }, (t) => {
  const fx = nativeFixture(t);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'win-resolve-1215-empty-')));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.ok(fs.existsSync(fx.file));
  assert.throws(() => resolveWindowsExecutable('fixture1215', Object.freeze({ Path: other, PathExt: '.CMD' })),
    /cannot find executable "fixture1215" on PATH/);
});
