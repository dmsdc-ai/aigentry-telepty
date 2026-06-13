'use strict';

// telepty#49 — uninstall hygiene. `npm rm -g` left a live daemon, a loaded
// launchd plist, and 3 undocumented state dirs behind. src/uninstall.js drives
// both `telepty uninstall [--purge] [--dry-run]` and the npm preuninstall hook.
//
// SAFETY: every platform call (daemon cleanup, launchctl, fs) is injected —
// this suite never stops a real daemon, never calls launchctl, never deletes
// real directories. The live daemon on 3848 is untouchable by design here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { LAUNCHD_PLIST_NAMES, planUninstall, runPreuninstall, runUninstall } = require('../src/uninstall');

const HOME = '/home/tester';

function fakeDeps(overrides = {}) {
  const calls = { cleanup: 0, execFile: [], rm: [], exists: [] };
  const deps = {
    platform: 'darwin',
    homedir: HOME,
    cleanupDaemonProcesses: () => {
      calls.cleanup += 1;
      return { stopped: [{ pid: 111, source: 'state-file' }], failed: [] };
    },
    execFileSync: (cmd, cmdArgs) => {
      calls.execFile.push([cmd, ...cmdArgs]);
    },
    fs: {
      existsSync: (p) => {
        calls.exists.push(p);
        return true; // default: plists and state dirs all exist
      },
      rmSync: (p, opts) => {
        calls.rm.push([p, opts || {}]);
      }
    },
    ...overrides
  };
  return { deps, calls };
}

// ── planUninstall ───────────────────────────────────────────────────────────────

test('planUninstall: darwin → daemon+broker plists under LaunchAgents, 3 state dirs', () => {
  const plan = planUninstall({ platform: 'darwin', homedir: HOME });
  assert.deepEqual(plan.plists, LAUNCHD_PLIST_NAMES.map((n) => path.join(HOME, 'Library', 'LaunchAgents', n)));
  assert.deepEqual(plan.stateDirs, [
    path.join(HOME, '.telepty'),
    path.join(HOME, '.aigentry'),
    path.join(HOME, '.config', 'aigentry-telepty')
  ]);
});

test('planUninstall: non-darwin → no launchd plists, same state dirs', () => {
  const plan = planUninstall({ platform: 'linux', homedir: HOME });
  assert.deepEqual(plan.plists, []);
  assert.equal(plan.stateDirs.length, 3);
});

// ── runUninstall: default pass ──────────────────────────────────────────────────

test('runUninstall: stops daemons, unloads+removes plists, KEEPS state dirs (purge guard)', () => {
  const { deps, calls } = fakeDeps();
  const result = runUninstall(deps);

  assert.equal(calls.cleanup, 1, 'daemon cleanup chain runs exactly once');
  assert.equal(result.stopped.length, 1);

  const unloads = calls.execFile.filter(([cmd, sub]) => cmd === 'launchctl' && sub === 'unload');
  assert.equal(unloads.length, 2, 'both daemon and broker plists are unloaded');
  const plistRms = calls.rm.filter(([p]) => p.endsWith('.plist'));
  assert.equal(plistRms.length, 2, 'both plist files are removed');

  // THE #49 guard: without --purge, no state directory is ever deleted.
  const dirRms = calls.rm.filter(([p]) => !p.endsWith('.plist'));
  assert.equal(dirRms.length, 0, 'state dirs must survive a default uninstall');
  assert.ok(result.stateDirs.every((d) => d.exists && !d.purged));
  assert.equal(result.stateDirs.length, 3, 'all 3 dirs are reported so the leftover is documented');
});

test('runUninstall: --purge deletes the state dirs recursively', () => {
  const { deps, calls } = fakeDeps();
  const result = runUninstall({ ...deps, purge: true });
  const dirRms = calls.rm.filter(([p]) => !p.endsWith('.plist'));
  assert.equal(dirRms.length, 3);
  assert.ok(dirRms.every(([, opts]) => opts.recursive === true && opts.force === true));
  assert.ok(result.stateDirs.every((d) => d.purged));
});

test('runUninstall: --dry-run touches NOTHING, even with --purge', () => {
  const { deps, calls } = fakeDeps();
  const result = runUninstall({ ...deps, purge: true, dryRun: true });
  assert.equal(calls.cleanup, 0, 'dry run must not stop daemons');
  assert.equal(calls.execFile.length, 0, 'dry run must not call launchctl');
  assert.equal(calls.rm.length, 0, 'dry run must not delete anything');
  assert.equal(result.dryRun, true);
  assert.equal(result.plists.length, 2, 'dry run still reports what WOULD be touched');
  assert.equal(result.stateDirs.length, 3);
});

test('runUninstall: non-darwin skips launchctl entirely', () => {
  const { deps, calls } = fakeDeps({ platform: 'linux' });
  runUninstall(deps);
  assert.equal(calls.execFile.length, 0);
  assert.equal(calls.cleanup, 1, 'daemon stop still runs on every platform');
});

test('runUninstall: missing plist → no unload attempt; launchctl failure tolerated', () => {
  // First plist absent, second present but launchctl throws (not loaded).
  const { deps, calls } = fakeDeps();
  let existsCall = 0;
  deps.fs.existsSync = (p) => {
    if (p.endsWith('.plist')) {
      existsCall += 1;
      return existsCall > 1;
    }
    return true;
  };
  deps.execFileSync = (cmd, cmdArgs) => {
    calls.execFile.push([cmd, ...cmdArgs]);
    throw new Error('Could not find specified service');
  };
  const result = runUninstall(deps);
  assert.equal(calls.execFile.length, 1, 'absent plist is never unloaded');
  assert.equal(result.plists[0].existed, false);
  assert.equal(result.plists[1].unloaded, false, 'launchctl failure is recorded, not thrown');
  assert.equal(result.plists[1].removed, true, 'plist file still removed after a failed unload');
});

// ── runPreuninstall: npm hook — quiet, partial, unbreakable ─────────────────────

test('runPreuninstall: stops daemon + unloads plists but does NOT remove files or dirs', () => {
  const { deps, calls } = fakeDeps();
  const result = runPreuninstall(deps);
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.execFile.filter(([cmd]) => cmd === 'launchctl').length, 2);
  assert.equal(calls.rm.length, 0, 'preuninstall must not delete plists or state dirs');
  assert.ok(result.stateDirs.every((d) => !d.purged));
});

test('runPreuninstall: never throws, even when every dependency fails (npm rm must survive)', () => {
  const boom = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => {
    runPreuninstall({
      platform: 'darwin',
      homedir: HOME,
      cleanupDaemonProcesses: boom,
      execFileSync: boom,
      fs: { existsSync: boom, rmSync: boom }
    });
  });
});

test('runPreuninstall: a purge option smuggled in is ignored (hard guard)', () => {
  const { deps, calls } = fakeDeps();
  runPreuninstall({ ...deps, purge: true });
  assert.equal(calls.rm.length, 0, 'the npm hook can never delete user data');
});
