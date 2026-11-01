// src/bin-ownership.js — #1228: who owns the shared `telepty` command?
//
// Why this exists: the unscoped legacy package `aigentry-telepty` and this
// scoped `@dmsdc-ai/aigentry-telepty` both declare a `telepty` bin. npm keeps
// ONE link per name, so a host with both installed has a `telepty` that points
// into exactly one of them — and `npm rm -g aigentry-telepty` was observed
// (telepty#94, Ubuntu 24.04, prefix ~/.local) to take that shared link with it,
// leaving `telepty: command not found` until a `--force` reinstall relinked it.
//
// This module only DIAGNOSES. It never invokes npm (no install/rm/ls/deprecate/
// rebuild) and never writes into the npm prefix: re-creating npm's own shims
// would desynchronise npm's bookkeeping, and nothing here can be undone by npm.
// It is read-only by construction — no fs write call appears below.
//
// §17 무의존: fs + path only. Every seam (`fs`, `platform`, `env`, `pkgRoot`) is
// injectable, so the classifiers are unit-testable for any OS from any OS.

'use strict';

const fsDefault = require('fs');
const path = require('path');

const SCOPE = '@dmsdc-ai';
const SCOPED_NAME = '@dmsdc-ai/aigentry-telepty';
const LEGACY_NAME = 'aigentry-telepty';

// npm writes the package path into both POSIX symlink targets and Windows shim
// bodies, so one pair of markers classifies every shape. Scoped is tested first:
// `node_modules/@dmsdc-ai/aigentry-telepty/` also contains the legacy substring.
const SCOPED_MARKER = /node_modules[\\/]@dmsdc-ai[\\/]aigentry-telepty[\\/]/;
const LEGACY_MARKER = /node_modules[\\/]aigentry-telepty[\\/]/;

const ABSENT_LEGACY = Object.freeze({ present: false, version: null, bin: null, root: null });

function flavor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// `<prefix>/lib/node_modules/@dmsdc-ai/<pkg>` → bin dir and global root. Derived
// from the RUNNING package, so a host with several prefixes is never guessed at;
// npm's own `npm_config_prefix` wins when it is set (that is the postinstall case).
function locatePrefix({ pkgRoot, platform = process.platform, env = {} } = {}) {
  const p = flavor(platform);
  const scoped = Boolean(pkgRoot) && p.basename(p.dirname(pkgRoot)) === SCOPE;
  const prefix = env && env.npm_config_prefix;

  if (prefix) {
    return platform === 'win32'
      ? { scoped, globalRoot: p.join(prefix, 'node_modules'), binDir: prefix }
      : { scoped, globalRoot: p.join(prefix, 'lib', 'node_modules'), binDir: p.join(prefix, 'bin') };
  }

  // Not installed under the scope (a dev checkout, a vendored copy): say so
  // rather than pointing at a bin dir that has nothing to do with this file.
  if (!scoped) return { scoped: false, globalRoot: null, binDir: null };

  const globalRoot = p.dirname(p.dirname(pkgRoot));
  const binDir = platform === 'win32'
    ? p.dirname(globalRoot)                                      // <prefix>\node_modules → <prefix>
    : p.join(p.dirname(p.dirname(globalRoot)), 'bin');           // <prefix>/lib/node_modules → <prefix>/bin

  return { scoped: true, globalRoot, binDir };
}

// Legacy present ⇔ <globalRoot>/aigentry-telepty/package.json declares that name.
// A directory with the right name but a different package is NOT the legacy one.
function detectLegacyPackage({ globalRoot, fs = fsDefault, platform = process.platform } = {}) {
  if (!globalRoot) return ABSENT_LEGACY;
  const p = flavor(platform);
  const root = p.join(globalRoot, LEGACY_NAME);
  try {
    const manifest = JSON.parse(String(fs.readFileSync(p.join(root, 'package.json'), 'utf8')));
    if (!manifest || manifest.name !== LEGACY_NAME) return ABSENT_LEGACY;
    return { present: true, version: manifest.version || null, bin: manifest.bin || {}, root };
  } catch {
    return ABSENT_LEGACY; // absent, unreadable or malformed — all "not established"
  }
}

function ownerFromText(text) {
  if (SCOPED_MARKER.test(text)) return 'scoped';
  if (LEGACY_MARKER.test(text)) return 'legacy';
  return 'foreign';
}

// Windows has no symlink: npm writes three shims per bin name and `where` can
// return them in any order, so each file is classified on its own. A split pair
// is a real state (one package relinked, the other not) and must stay visible.
function classifyWindowsShims({ binDir, name, fs }) {
  const files = [];
  for (const file of [`${name}.cmd`, `${name}.ps1`, name]) {
    const full = path.win32.join(binDir, file);
    try {
      files.push({ path: full, owner: ownerFromText(String(fs.readFileSync(full, 'utf8'))) });
    } catch {
      // Missing shim: not every prefix has all three.
    }
  }
  return files;
}

function classifyPosixBin({ binDir, name, fs }) {
  const target = path.posix.join(binDir, name);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      const link = String(fs.readlinkSync(target));
      const resolved = path.posix.isAbsolute(link) ? link : path.posix.resolve(binDir, link);
      return [{ path: target, owner: ownerFromText(resolved) }];
    }
  } catch {
    return []; // nothing at that path at all
  }
  // A regular file (some prefixes ship a copied shim rather than a link).
  try {
    return [{ path: target, owner: ownerFromText(String(fs.readFileSync(target, 'utf8'))) }];
  } catch {
    return [{ path: target, owner: 'foreign' }];
  }
}

function classifyBin({ binDir, name, platform = process.platform, fs = fsDefault }) {
  if (!binDir) return { owner: 'missing', files: [] };
  let files;
  try {
    files = platform === 'win32'
      ? classifyWindowsShims({ binDir, name, fs })
      : classifyPosixBin({ binDir, name, fs });
  } catch {
    return { owner: 'missing', files: [] };
  }
  if (files.length === 0) return { owner: 'missing', files };
  const owners = [...new Set(files.map((f) => f.owner))];
  // `mixed` is deliberately a fifth value: a prefix whose shims disagree must
  // not be reportable as a clean install of either package.
  return { owner: owners.length === 1 ? owners[0] : 'mixed', files };
}

function classifyBinOwner(options) {
  return classifyBin(options).owner;
}

function readOwnBin({ pkgRoot, fs, platform }) {
  try {
    const p = flavor(platform);
    const manifest = JSON.parse(String(fs.readFileSync(p.join(pkgRoot, 'package.json'), 'utf8')));
    return (manifest && manifest.bin) || {};
  } catch {
    return { telepty: 'cli.js' }; // the one name this package has always declared
  }
}

// The full picture, as data. Never throws: a diagnosis that breaks `npm i -g`
// would be worse than the defect it reports.
function diagnoseBinOwnership(deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || fsDefault;
  const env = deps.env || process.env;
  const pkgRoot = deps.pkgRoot || path.resolve(__dirname, '..');

  const base = { platform, scoped: false, globalRoot: null, binDir: null, legacy: ABSENT_LEGACY, bins: {} };

  let located;
  try {
    located = locatePrefix({ pkgRoot, platform, env });
  } catch {
    return base;
  }
  if (!located.scoped || !located.binDir) {
    return { ...base, globalRoot: located.globalRoot || null, binDir: located.binDir || null };
  }

  const legacy = detectLegacyPackage({ globalRoot: located.globalRoot, fs, platform });

  // Only names BOTH packages declare can be fought over. `telepty` is always
  // checked (it is the command users type); the rest come from the measured
  // legacy bin map, which is also how fact F-1 gets answered on a real host.
  const own = readOwnBin({ pkgRoot, fs, platform });
  const shared = ['telepty'];
  if (legacy.present && legacy.bin) {
    for (const name of Object.keys(legacy.bin)) {
      if (name !== 'telepty' && Object.hasOwn(own, name)) shared.push(name);
    }
  }

  const bins = {};
  for (const name of shared) {
    bins[name] = classifyBin({ binDir: located.binDir, name, platform, fs });
  }

  return { platform, scoped: true, globalRoot: located.globalRoot, binDir: located.binDir, legacy, bins };
}

// The notice postinstall prints. Step 3 is the repair telepty#94 OBSERVED to
// work ("npm i -g @dmsdc-ai/aigentry-telepty@latest --force  # required to
// relink"); whether a narrower `npm rebuild -g` suffices is experiment E-B3 and
// not yet measured. Step 4 is the check, because an unverified relink is how
// this defect stayed invisible. The product runs NONE of these commands.
function formatMigrationNotice({ diagnosis, version } = {}) {
  if (!diagnosis || !diagnosis.legacy || !diagnosis.legacy.present) return null;
  const legacyVersion = diagnosis.legacy.version || 'unknown';
  const owner = (diagnosis.bins && diagnosis.bins.telepty && diagnosis.bins.telepty.owner) || 'unknown';

  return [
    `Legacy package aigentry-telepty@${legacyVersion} is also installed globally and shares the \`telepty\` command (owner now: ${owner}).`,
    '  Removing it with npm also removes the shared `telepty` link. Safe migration:',
    '    1) telepty service stop          (only if a service is installed)',
    '    2) npm rm -g aigentry-telepty',
    `    3) npm i -g ${SCOPED_NAME}@${version} --force`,
    `    4) telepty --version   → must print ${version}`
  ].join('\n');
}

module.exports = {
  LEGACY_NAME,
  SCOPED_NAME,
  classifyBinOwner,
  detectLegacyPackage,
  diagnoseBinOwnership,
  formatMigrationNotice,
  locatePrefix
};
