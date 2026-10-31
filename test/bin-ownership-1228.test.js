'use strict';

// #1228 (telepty#94) — the unscoped `aigentry-telepty` and the scoped
// `@dmsdc-ai/aigentry-telepty` both declare a `telepty` bin, so `npm rm -g` of
// the legacy package can take the shared link with it and `telepty` becomes
// "command not found".
//
// SAFETY: npm is never invoked and the npm prefix is never written. Every tree
// below is an in-memory fake fs; nothing here reads the real global prefix, the
// real bin dir, or any package installed on this host.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  classifyBinOwner,
  detectLegacyPackage,
  diagnoseBinOwnership,
  formatMigrationNotice,
  locatePrefix
} = require('../src/bin-ownership');

const pkg = require('../package.json');

const POSIX_PREFIX = '/opt/prefix';
const POSIX_GLOBAL_ROOT = `${POSIX_PREFIX}/lib/node_modules`;
const POSIX_BIN = `${POSIX_PREFIX}/bin`;
const POSIX_PKG_ROOT = `${POSIX_GLOBAL_ROOT}/@dmsdc-ai/aigentry-telepty`;

const WIN_PREFIX = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const WIN_GLOBAL_ROOT = `${WIN_PREFIX}\\node_modules`;
const WIN_PKG_ROOT = `${WIN_GLOBAL_ROOT}\\@dmsdc-ai\\aigentry-telepty`;

// A fake fs that is a flat map of path → { content } | { link }. `lstat` only has
// to answer "is this a symlink", which is the single question the classifier asks.
function fakeFs(entries) {
  const map = new Map(Object.entries(entries));
  return {
    reads: [],
    existsSync(p) { return map.has(p); },
    readFileSync(p) {
      this.reads.push(p);
      const entry = map.get(p);
      if (!entry || entry.content == null) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return entry.content;
    },
    lstatSync(p) {
      const entry = map.get(p);
      if (!entry) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return { isSymbolicLink: () => entry.link != null };
    },
    readlinkSync(p) {
      const entry = map.get(p);
      if (!entry || entry.link == null) throw new Error(`EINVAL: ${p}`);
      return entry.link;
    }
  };
}

const packageJson = (name, version, bin) => ({ content: JSON.stringify({ name, version, bin }) });

function posixTree({ linkTarget, legacy = true, extraEntries = {} } = {}) {
  const entries = {
    [`${POSIX_PKG_ROOT}/package.json`]: packageJson('@dmsdc-ai/aigentry-telepty', pkg.version, { telepty: 'cli.js' }),
    ...extraEntries
  };
  if (legacy) {
    entries[`${POSIX_GLOBAL_ROOT}/aigentry-telepty/package.json`] =
      packageJson('aigentry-telepty', '0.0.4', { telepty: 'cli.js' });
  }
  if (linkTarget !== undefined) {
    entries[`${POSIX_BIN}/telepty`] = { link: linkTarget };
  }
  return fakeFs(entries);
}

// A Windows shim body in npm's real shape: the .cmd wrapper references the
// package's own cli.js through a relative node_modules path.
const cmdShim = (pkgSegment) => ({
  content: `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\node_modules\\${pkgSegment}\\cli.js" %*\r\n)\r\n`
});
const ps1Shim = (pkgSegment) => ({
  content: `$exe=""\r\n& "$basedir/../node_modules/${pkgSegment.replace(/\\/g, '/')}/cli.js" $args\r\n`
});
const shShim = (pkgSegment) => ({
  content: `#!/bin/sh\nexec node  "$basedir/../node_modules/${pkgSegment.replace(/\\/g, '/')}/cli.js" "$@"\n`
});

function winTree({ owner = 'aigentry-telepty', legacy = true, shims } = {}) {
  const entries = {
    [`${WIN_PKG_ROOT}\\package.json`]: packageJson('@dmsdc-ai/aigentry-telepty', pkg.version, { telepty: 'cli.js' })
  };
  if (legacy) {
    entries[`${WIN_GLOBAL_ROOT}\\aigentry-telepty\\package.json`] =
      packageJson('aigentry-telepty', '0.0.4', { telepty: 'cli.js' });
  }
  const bodies = shims || {
    [`${WIN_PREFIX}\\telepty.cmd`]: cmdShim(owner),
    [`${WIN_PREFIX}\\telepty.ps1`]: ps1Shim(owner),
    [`${WIN_PREFIX}\\telepty`]: shShim(owner)
  };
  return fakeFs({ ...entries, ...bodies });
}

// ── locatePrefix ──────────────────────────────────────────────────────────────

test('locatePrefix: POSIX <prefix>/lib/node_modules/@dmsdc-ai/<pkg> → <prefix>/bin', () => {
  const located = locatePrefix({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {} });
  assert.equal(located.scoped, true);
  assert.equal(located.globalRoot, POSIX_GLOBAL_ROOT);
  assert.equal(located.binDir, POSIX_BIN);
});

test('locatePrefix: win32 <prefix>\\node_modules\\@dmsdc-ai\\<pkg> → <prefix>', () => {
  const located = locatePrefix({ pkgRoot: WIN_PKG_ROOT, platform: 'win32', env: {} });
  assert.equal(located.scoped, true);
  assert.equal(located.globalRoot, WIN_GLOBAL_ROOT);
  assert.equal(located.binDir, WIN_PREFIX);
});

test('locatePrefix: npm_config_prefix wins when npm sets it (the postinstall case)', () => {
  const posix = locatePrefix({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: { npm_config_prefix: '/home/me/.local' } });
  assert.equal(posix.binDir, '/home/me/.local/bin');
  assert.equal(posix.globalRoot, path.posix.join('/home/me/.local', 'lib', 'node_modules'));

  const win = locatePrefix({ pkgRoot: WIN_PKG_ROOT, platform: 'win32', env: { npm_config_prefix: 'D:\\npm' } });
  assert.equal(win.binDir, 'D:\\npm');
});

test('locatePrefix: a non-global checkout is reported unscoped, never guessed at', () => {
  const located = locatePrefix({ pkgRoot: '/Users/me/projects/aigentry-telepty', platform: 'darwin', env: {} });
  assert.equal(located.scoped, false);
});

// ── detectLegacyPackage ───────────────────────────────────────────────────────

test('detectLegacyPackage: reports presence, version and the bin map (resolves F-1 on a real host)', () => {
  const fs = posixTree({ linkTarget: '../lib/node_modules/aigentry-telepty/cli.js' });
  const legacy = detectLegacyPackage({ globalRoot: POSIX_GLOBAL_ROOT, fs });

  assert.equal(legacy.present, true);
  assert.equal(legacy.version, '0.0.4');
  assert.deepEqual(legacy.bin, { telepty: 'cli.js' });
  assert.equal(legacy.root, `${POSIX_GLOBAL_ROOT}/aigentry-telepty`);
});

test('detectLegacyPackage: a same-named directory with a different package name is not the legacy package', () => {
  const fs = fakeFs({
    [`${POSIX_GLOBAL_ROOT}/aigentry-telepty/package.json`]: packageJson('something-else', '9.9.9', {})
  });
  assert.equal(detectLegacyPackage({ globalRoot: POSIX_GLOBAL_ROOT, fs }).present, false);
});

test('detectLegacyPackage: unreadable or malformed package.json is absent, never a throw', () => {
  assert.equal(detectLegacyPackage({ globalRoot: POSIX_GLOBAL_ROOT, fs: fakeFs({}) }).present, false);
  const broken = fakeFs({ [`${POSIX_GLOBAL_ROOT}/aigentry-telepty/package.json`]: { content: '{not json' } });
  assert.equal(detectLegacyPackage({ globalRoot: POSIX_GLOBAL_ROOT, fs: broken }).present, false);
});

// ── B-U1 / B-U2 / B-U3: POSIX symlink ownership ───────────────────────────────

test('B-U1: a POSIX link into the legacy package is owned by legacy', () => {
  const fs = posixTree({ linkTarget: '../lib/node_modules/aigentry-telepty/cli.js' });
  assert.equal(classifyBinOwner({ binDir: POSIX_BIN, name: 'telepty', platform: 'linux', fs }), 'legacy');

  const diagnosis = diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs });
  assert.equal(diagnosis.legacy.present, true);
  assert.equal(diagnosis.bins.telepty.owner, 'legacy');
});

test('B-U2: a POSIX link into the scoped package is owned by scoped', () => {
  const fs = posixTree({ linkTarget: '../lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js' });
  assert.equal(classifyBinOwner({ binDir: POSIX_BIN, name: 'telepty', platform: 'linux', fs }), 'scoped');
  assert.equal(diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs }).bins.telepty.owner, 'scoped');
});

test('B-U3: an absent link is missing and a link elsewhere is foreign', () => {
  const absent = posixTree({});
  assert.equal(classifyBinOwner({ binDir: POSIX_BIN, name: 'telepty', platform: 'linux', fs: absent }), 'missing');

  const elsewhere = posixTree({ linkTarget: '../../other/tool/bin.js' });
  assert.equal(classifyBinOwner({ binDir: POSIX_BIN, name: 'telepty', platform: 'linux', fs: elsewhere }), 'foreign');
});

test('B-U3: an absolute link target is classified from the same package markers', () => {
  const fs = posixTree({ linkTarget: `${POSIX_GLOBAL_ROOT}/aigentry-telepty/cli.js` });
  assert.equal(classifyBinOwner({ binDir: POSIX_BIN, name: 'telepty', platform: 'linux', fs }), 'legacy');
});

test('a regular file (not a symlink) at the bin path is classified by its contents', () => {
  const fs = posixTree({
    extraEntries: { [`${POSIX_BIN}/telepty`]: shShim('aigentry-telepty') }
  });
  assert.equal(classifyBinOwner({ binDir: POSIX_BIN, name: 'telepty', platform: 'linux', fs }), 'legacy');
});

// ── B-U4: Windows shims, per file ─────────────────────────────────────────────

test('B-U4: all three win32 shims pointing at legacy are each classified legacy', () => {
  const fs = winTree({ owner: 'aigentry-telepty' });
  assert.equal(classifyBinOwner({ binDir: WIN_PREFIX, name: 'telepty', platform: 'win32', fs }), 'legacy');

  const diagnosis = diagnoseBinOwnership({ pkgRoot: WIN_PKG_ROOT, platform: 'win32', env: {}, fs });
  const files = diagnosis.bins.telepty.files;
  assert.equal(files.length, 3, 'every shim must be reported, not just the first');
  assert.deepEqual([...new Set(files.map((f) => f.owner))], ['legacy']);
  assert.deepEqual(files.map((f) => path.win32.basename(f.path)).sort(), ['telepty', 'telepty.cmd', 'telepty.ps1']);
});

test('B-U4: scoped win32 shims are scoped', () => {
  const fs = winTree({ owner: '@dmsdc-ai\\aigentry-telepty' });
  assert.equal(classifyBinOwner({ binDir: WIN_PREFIX, name: 'telepty', platform: 'win32', fs }), 'scoped');
});

test('B-U4: disagreeing shims aggregate to mixed and are reported per file', () => {
  const fs = winTree({
    shims: {
      [`${WIN_PREFIX}\\telepty.cmd`]: cmdShim('@dmsdc-ai\\aigentry-telepty'),
      [`${WIN_PREFIX}\\telepty.ps1`]: ps1Shim('aigentry-telepty'),
      [`${WIN_PREFIX}\\telepty`]: shShim('aigentry-telepty')
    }
  });
  const diagnosis = diagnoseBinOwnership({ pkgRoot: WIN_PKG_ROOT, platform: 'win32', env: {}, fs });
  assert.equal(diagnosis.bins.telepty.owner, 'mixed', 'a split install must not read as a clean one');
  const byFile = Object.fromEntries(diagnosis.bins.telepty.files.map((f) => [path.win32.basename(f.path), f.owner]));
  assert.deepEqual(byFile, { 'telepty.cmd': 'scoped', 'telepty.ps1': 'legacy', telepty: 'legacy' });
});

test('B-U4: no win32 shim at all is missing', () => {
  const fs = winTree({ shims: {} });
  assert.equal(classifyBinOwner({ binDir: WIN_PREFIX, name: 'telepty', platform: 'win32', fs }), 'missing');
});

// ── the shared-name set ───────────────────────────────────────────────────────

test('diagnose: `aigentry-telepty` is classified too, but only when legacy declares it', () => {
  const sharing = fakeFs({
    [`${POSIX_PKG_ROOT}/package.json`]: packageJson('@dmsdc-ai/aigentry-telepty', pkg.version, { telepty: 'cli.js', 'aigentry-telepty': 'install.js' }),
    [`${POSIX_GLOBAL_ROOT}/aigentry-telepty/package.json`]: packageJson('aigentry-telepty', '0.0.4', { telepty: 'cli.js', 'aigentry-telepty': 'install.js' }),
    [`${POSIX_BIN}/telepty`]: { link: '../lib/node_modules/aigentry-telepty/cli.js' },
    [`${POSIX_BIN}/aigentry-telepty`]: { link: '../lib/node_modules/aigentry-telepty/install.js' }
  });
  const shared = diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs: sharing });
  assert.deepEqual(Object.keys(shared.bins).sort(), ['aigentry-telepty', 'telepty']);
  assert.equal(shared.bins['aigentry-telepty'].owner, 'legacy');

  const notSharing = posixTree({ linkTarget: '../lib/node_modules/aigentry-telepty/cli.js' });
  const narrow = diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs: notSharing });
  assert.deepEqual(Object.keys(narrow.bins), ['telepty']);
});

test('diagnose: with no legacy package installed there is nothing to report', () => {
  const fs = posixTree({ linkTarget: '../lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js', legacy: false });
  const diagnosis = diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs });
  assert.equal(diagnosis.legacy.present, false);
  assert.equal(diagnosis.bins.telepty.owner, 'scoped');
});

test('diagnose: an unscoped checkout reports scoped=false and classifies nothing', () => {
  const diagnosis = diagnoseBinOwnership({
    pkgRoot: '/Users/me/projects/aigentry-telepty',
    platform: 'darwin',
    env: {},
    fs: fakeFs({})
  });
  assert.equal(diagnosis.scoped, false);
  assert.equal(diagnosis.legacy.present, false);
  assert.deepEqual(diagnosis.bins, {});
});

test('diagnose: a throwing fs is swallowed into an inconclusive diagnosis, never propagated', () => {
  const hostile = {
    existsSync: () => { throw new Error('EACCES'); },
    readFileSync: () => { throw new Error('EACCES'); },
    lstatSync: () => { throw new Error('EACCES'); },
    readlinkSync: () => { throw new Error('EACCES'); }
  };
  const diagnosis = diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs: hostile });
  assert.equal(diagnosis.legacy.present, false);
});

// ── B-U5: the migration notice ────────────────────────────────────────────────

test('B-U5: formatMigrationNotice carries the 4-step sequence with this exact version', () => {
  const fs = posixTree({ linkTarget: '../lib/node_modules/aigentry-telepty/cli.js' });
  const diagnosis = diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs });
  const notice = formatMigrationNotice({ diagnosis, version: pkg.version });

  assert.match(notice, /aigentry-telepty@0\.0\.4/);
  assert.match(notice, /owner now: legacy/);
  assert.match(notice, /1\) telepty service stop/);
  assert.match(notice, /2\) npm rm -g aigentry-telepty/);
  assert.match(notice, new RegExp(`3\\) npm i -g @dmsdc-ai/aigentry-telepty@${pkg.version.replace(/\./g, '\\.')} --force`));
  assert.match(notice, new RegExp(`4\\) telepty --version[\\s\\S]*${pkg.version.replace(/\./g, '\\.')}`));
  assert.equal(formatMigrationNotice({ diagnosis: { legacy: { present: false }, bins: {} }, version: pkg.version }), null);
});

// ── B-U5 (postinstall wiring) ─────────────────────────────────────────────────

function logger() {
  const lines = [];
  return { lines, log: (m) => lines.push(`log:${m}`), warn: (m) => lines.push(`warn:${m}`) };
}

test('B-U5: postinstall warns about a legacy install and still runs the restart flow', async () => {
  const postinstall = require('../scripts/postinstall');
  const log = logger();
  let detachedStarts = 0;
  const fs = posixTree({ linkTarget: '../lib/node_modules/aigentry-telepty/cli.js' });

  await postinstall.main({
    env: { npm_config_global: 'true' },
    logger: log,
    platform: 'linux',
    readDaemonState: () => ({ pid: 222, port: 49152, version: '0.0.1' }),
    detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    cleanupDaemonProcesses: () => ({ stopped: [{ pid: 222 }], failed: [] }),
    diagnoseBinOwnership: () => diagnoseBinOwnership({ pkgRoot: POSIX_PKG_ROOT, platform: 'linux', env: {}, fs }),
    spawnDetachedDaemon: () => { detachedStarts += 1; }
  });

  const output = log.lines.join('\n');
  assert.match(output, /Legacy package aigentry-telepty@0\.0\.4/);
  assert.match(output, /npm rm -g aigentry-telepty/);
  assert.equal(detachedStarts, 1, 'the migration notice must not short-circuit the restart flow');
  assert.match(output, /spawned fresh/);
});

test('B-U5: a diagnosis that throws cannot break npm install', async () => {
  const postinstall = require('../scripts/postinstall');
  const log = logger();
  let detachedStarts = 0;

  await postinstall.main({
    env: { npm_config_global: 'true' },
    logger: log,
    platform: 'linux',
    readDaemonState: () => ({ pid: 222, port: 49152, version: '0.0.1' }),
    detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    cleanupDaemonProcesses: () => ({ stopped: [{ pid: 222 }], failed: [] }),
    diagnoseBinOwnership: () => { throw new Error('prefix unreadable'); },
    spawnDetachedDaemon: () => { detachedStarts += 1; }
  });

  assert.equal(detachedStarts, 1);
  assert.match(log.lines.join('\n'), /spawned fresh/);
});

// ── A-U17: the postinstall service hint ───────────────────────────────────────

test('A-U17: unsupervised postinstall prints exactly one service hint naming the command', async () => {
  const postinstall = require('../scripts/postinstall');

  for (const [platform, extra] of [['darwin', false], ['linux', true], ['win32', false]]) {
    const log = logger();
    await postinstall.main({
      env: { npm_config_global: 'true' },
      logger: log,
      platform,
      readDaemonState: () => null,
      detectSupervisor: () => ({ present: false, kind: null, detail: null }),
      diagnoseBinOwnership: () => ({ legacy: { present: false }, bins: {} })
    });

    const hints = log.lines.filter((l) => /telepty service install/.test(l));
    assert.equal(hints.length, 1, `${platform}: expected one hint, got ${JSON.stringify(log.lines)}`);
    assert.match(hints[0], /No OS service manages the telepty daemon/);
    assert.match(hints[0], /will not start after reboot\/login/);
    if (extra) {
      assert.match(hints[0], /loginctl enable-linger/);
    } else {
      assert.doesNotMatch(hints[0], /linger/);
    }
  }
});

test('A-U17: a supervised host gets no hint, and the #757 output is unchanged', async () => {
  const postinstall = require('../scripts/postinstall');
  const log = logger();
  let detachedStarts = 0;

  await postinstall.main({
    env: { npm_config_global: 'true' },
    logger: log,
    platform: 'darwin',
    readDaemonState: () => ({ pid: 222, port: 49152, version: '0.0.1' }),
    detectSupervisor: () => ({ present: true, kind: 'launchd', detail: '/tmp/x.plist' }),
    cleanupDaemonProcesses: () => ({ stopped: [{ pid: 222 }], failed: [] }),
    restartSupervisorDaemon: () => ({ success: true }),
    waitForDaemonVersion: async () => ({ pid: 333, version: pkg.version }),
    diagnoseBinOwnership: () => ({ legacy: { present: false }, bins: {} }),
    spawnDetachedDaemon: () => { detachedStarts += 1; }
  });

  assert.equal(detachedStarts, 0);
  assert.doesNotMatch(log.lines.join('\n'), /telepty service install/);
  assert.match(log.lines.join('\n'), /launchd started/);
});

test('A-U17: the hint is skipped entirely when postinstall skips (non-global install)', async () => {
  const postinstall = require('../scripts/postinstall');
  const log = logger();
  await postinstall.main({ env: { npm_config_global: 'false' }, logger: log, platform: 'linux' });
  assert.deepEqual(log.lines, ['log:[telepty postinstall] Skipped (non-global install).']);
});

// ── B-U6: the entry point is pinned to this package ───────────────────────────

test('B-U6: resolveTeleptyEntryPoint refuses a PATH-resolved legacy cli.js', () => {
  const { resolveTeleptyEntryPoint } = require('../cli');
  const ownCli = path.join(path.resolve(__dirname, '..'), 'cli.js');

  const legacyCli = `${POSIX_GLOBAL_ROOT}/aigentry-telepty/cli.js`;
  const legacyFs = fakeFs({
    [legacyCli]: { content: '// legacy' },
    [`${POSIX_GLOBAL_ROOT}/aigentry-telepty/package.json`]: packageJson('aigentry-telepty', '0.0.4', { telepty: 'cli.js' })
  });
  assert.equal(
    resolveTeleptyEntryPoint({
      platform: 'linux',
      execSync: () => `${POSIX_BIN}/telepty\n`,
      fs: { ...legacyFs, existsSync: (p) => legacyFs.existsSync(p) || p === `${POSIX_BIN}/telepty`, realpathSync: () => legacyCli, readFileSync: (p) => legacyFs.readFileSync(p) }
    }),
    ownCli,
    'a legacy cli.js must never become the daemon entry point'
  );
});

test('B-U6: a `where telepty` reply with CRLF and a shim first resolves to our own cli.js', () => {
  const { resolveTeleptyEntryPoint } = require('../cli');
  const ownCli = path.join(path.resolve(__dirname, '..'), 'cli.js');

  assert.equal(
    resolveTeleptyEntryPoint({
      platform: 'win32',
      execSync: () => 'C:\\p\\telepty\r\nC:\\p\\telepty.cmd\r\n',
      fs: {
        existsSync: (p) => p === 'C:\\p\\telepty',
        realpathSync: (p) => p,
        readFileSync: () => { throw new Error('ENOENT'); }
      }
    }),
    ownCli,
    'the extensionless sh shim must not be spawned as the daemon'
  );
});

test('B-U6: a scoped cli.js on PATH is still accepted (the in-place upgrade case)', () => {
  const { resolveTeleptyEntryPoint } = require('../cli');
  const scopedCli = `${POSIX_PKG_ROOT}/cli.js`;
  const tree = fakeFs({
    [scopedCli]: { content: '// scoped' },
    [`${POSIX_PKG_ROOT}/package.json`]: packageJson('@dmsdc-ai/aigentry-telepty', pkg.version, { telepty: 'cli.js' })
  });

  assert.equal(
    resolveTeleptyEntryPoint({
      platform: 'linux',
      execSync: () => `${POSIX_BIN}/telepty\n`,
      fs: {
        existsSync: (p) => tree.existsSync(p) || p === `${POSIX_BIN}/telepty`,
        realpathSync: () => scopedCli,
        readFileSync: (p) => tree.readFileSync(p)
      }
    }),
    scopedCli
  );
});

test('B-U6: a failing `which` falls back to this package, never to argv[1]', () => {
  const { resolveTeleptyEntryPoint } = require('../cli');
  const ownCli = path.join(path.resolve(__dirname, '..'), 'cli.js');
  assert.equal(
    resolveTeleptyEntryPoint({
      platform: 'linux',
      execSync: () => { throw new Error('which: not found'); },
      fs: { existsSync: () => false, realpathSync: (p) => p, readFileSync: () => { throw new Error('ENOENT'); } }
    }),
    ownCli
  );
});

// ── B-U7: the unsupervised spawn no longer depends on the bin owner ───────────

test('B-U7: spawnDetachedDaemon launches process.execPath with this package cli.js', async () => {
  const postinstall = require('../scripts/postinstall');
  const calls = [];
  const listeners = [];
  const child = await postinstall.spawnDetachedDaemon(undefined, {
    spawn: (cmd, argv, opts) => {
      calls.push([cmd, argv, opts]);
      const child = new (require('node:events').EventEmitter)();
      child.unref = () => {};
      child.on('newListener', event => listeners.push(event));
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });

  assert.equal(calls.length, 1);
  const [cmd, argv, opts] = calls[0];
  assert.equal(cmd, process.execPath, 'the daemon must be launched by this node, not a PATH shim');
  assert.deepEqual(argv, [path.join(path.resolve(__dirname, '..'), 'cli.js'), 'daemon']);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.windowsHide, true);
  assert.ok(listeners.includes('error'), "an async spawn 'error' must be handled, not thrown at npm");
  assert.ok(child);
});

test('B-U7: main() no longer resolves the daemon through the `telepty` bin owner', async () => {
  const postinstall = require('../scripts/postinstall');
  const log = logger();
  let resolvedBin = 0;
  let spawnedWith = null;

  await postinstall.main({
    env: { npm_config_global: 'true' },
    logger: log,
    platform: 'linux',
    readDaemonState: () => ({ pid: 222, port: 49152, version: '0.0.1' }),
    detectSupervisor: () => ({ present: false, kind: null, detail: null }),
    cleanupDaemonProcesses: () => ({ stopped: [{ pid: 222 }], failed: [] }),
    diagnoseBinOwnership: () => ({ legacy: { present: false }, bins: {} }),
    resolveTeleptyBin: () => { resolvedBin += 1; return '/opt/prefix/bin/telepty'; },
    spawnDetachedDaemon: (arg) => { spawnedWith = arg; }
  });

  assert.equal(resolvedBin, 0, 'the PATH bin owner must no longer decide what gets spawned');
  assert.ok(spawnedWith === undefined || /cli\.js$/.test(String(spawnedWith)));
  assert.equal(typeof postinstall.resolveTeleptyBin, 'function', 'the export stays for compatibility');
});

// ── B-U8: no npm, no prefix writes ────────────────────────────────────────────

test('B-U8: bin-ownership, service and postinstall never spawn npm or write the prefix bin dir', () => {
  const fs = require('fs');
  const root = path.resolve(__dirname, '..');
  for (const rel of ['src/bin-ownership.js', 'src/service.js', 'scripts/postinstall.js']) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(source, /exec(File)?Sync\(\s*['"`]npm/, `${rel} shells out to npm`);
    assert.doesNotMatch(source, /spawn\(\s*['"`]npm/, `${rel} spawns npm`);
    assert.doesNotMatch(source, /npm (install|rm|ls|deprecate|rebuild)[^`'"\n]*['"`]\s*\)/, `${rel} runs an npm subcommand`);
  }

  // The notice names the commands as TEXT; it must never execute them.
  const ownership = fs.readFileSync(path.join(root, 'src', 'bin-ownership.js'), 'utf8');
  assert.match(ownership, /npm rm -g aigentry-telepty/, 'the migration text is expected to be present');
  assert.doesNotMatch(ownership, /writeFileSync|mkdirSync|rmSync|symlinkSync|unlinkSync/, 'bin-ownership is read-only by construction');
});
