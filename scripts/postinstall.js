#!/usr/bin/env node
'use strict';

// #469 (0.4.5): npm postinstall hook — restart a stale telepty-daemon after
// `npm install -g`. Without this, the running daemon keeps executing the
// previously-loaded code (verified: a daemon ran 22 days through 4 npm
// upgrades), so user-facing upgrades quietly no-op until they manually kill
// the daemon. Wires the existing daemon-shutdown primitive into npm's
// lifecycle; does not add new shutdown logic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const pkg = require('../package.json');

function shouldSkip() {
  if (process.env.TELEPTY_SKIP_POSTINSTALL === '1') {
    return 'TELEPTY_SKIP_POSTINSTALL=1';
  }
  // Only act on global installs. Local `npm install` (CI, dev) must not
  // restart a user's daemon.
  if (process.env.npm_config_global !== 'true') {
    return 'non-global install';
  }
  return null;
}

function readDaemonState() {
  const statePath = path.join(os.homedir(), '.telepty', 'daemon-state.json');
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveTeleptyBin() {
  try {
    const cmd = os.platform() === 'win32' ? 'where telepty' : 'which telepty';
    return execSync(cmd, { encoding: 'utf8' }).split('\n')[0].trim() || 'telepty';
  } catch {
    return 'telepty';
  }
}

(function main() {
  const skip = shouldSkip();
  if (skip) {
    console.log(`[telepty postinstall] Skipped (${skip}).`);
    return;
  }

  const state = readDaemonState();
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) {
    console.log('[telepty postinstall] No running daemon detected — nothing to restart.');
    return;
  }

  if (state.version === pkg.version) {
    console.log(`[telepty postinstall] Running daemon already at ${pkg.version} (pid ${state.pid}). No restart needed.`);
    return;
  }

  console.log(`[telepty postinstall] Detected stale daemon ${state.version || 'unknown'} (pid ${state.pid}); upgrading in-place to ${pkg.version}.`);

  let stopped = 0;
  try {
    // Lazy require so a malformed install of daemon-control.js doesn't abort
    // postinstall before the skip-check runs.
    const { cleanupDaemonProcesses } = require('../daemon-control');
    const result = cleanupDaemonProcesses();
    stopped = result.stopped.length;
    if (result.failed.length > 0) {
      console.warn(`[telepty postinstall] Could not stop ${result.failed.length} daemon process(es).`);
    }
  } catch (err) {
    console.warn(`[telepty postinstall] cleanupDaemonProcesses failed: ${err.message}`);
  }

  // launchd/systemd KeepAlive will respawn the daemon automatically on
  // macOS/root-Linux. For other platforms (Windows, non-root Linux) or when
  // the user disabled the service, spawn a fresh detached daemon so upgrades
  // never silently leave the user without one.
  try {
    const bin = resolveTeleptyBin();
    const child = spawn(bin, ['daemon'], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`[telepty postinstall] Stopped ${stopped} stale daemon(s); spawned fresh ${pkg.version} daemon.`);
  } catch (err) {
    console.warn(`[telepty postinstall] Daemon respawn failed: ${err.message} (launchd/systemd may restart it automatically).`);
  }
})();
