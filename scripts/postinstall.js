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
const { detectSupervisor, restartSupervisorDaemon } = require('../src/supervisor');

function shouldSkip(env = process.env) {
  if (env.TELEPTY_SKIP_POSTINSTALL === '1') {
    return 'TELEPTY_SKIP_POSTINSTALL=1';
  }
  // Only act on global installs. Local `npm install` (CI, dev) must not
  // restart a user's daemon.
  if (env.npm_config_global !== 'true') {
    return 'non-global install';
  }
  return null;
}

function readDaemonState(homeDir = os.homedir()) {
  const statePath = path.join(homeDir, '.telepty', 'daemon-state.json');
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

function spawnDetachedDaemon(bin) {
  const child = spawn(bin, ['daemon'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function waitForDaemonVersion({ port = 3848, version = pkg.version, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/meta`, {
        signal: AbortSignal.timeout(800)
      });
      if (res && res.ok) {
        const meta = await res.json();
        if (meta && meta.version === version) return meta;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function main(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const skip = shouldSkip(env);
  if (skip) {
    logger.log(`[telepty postinstall] Skipped (${skip}).`);
    return;
  }

  const state = (options.readDaemonState || readDaemonState)(options.homeDir || os.homedir());
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) {
    logger.log('[telepty postinstall] No running daemon detected — nothing to restart.');
    return;
  }

  if (state.version === pkg.version) {
    logger.log(`[telepty postinstall] Running daemon already at ${pkg.version} (pid ${state.pid}). No restart needed.`);
    return;
  }

  logger.log(`[telepty postinstall] Detected stale daemon ${state.version || 'unknown'} (pid ${state.pid}); upgrading in-place to ${pkg.version}.`);

  const supervisor = (options.detectSupervisor || detectSupervisor)();

  let stopped = 0;
  try {
    // Lazy require so a malformed install of daemon-control.js doesn't abort
    // postinstall before the skip-check runs.
    const daemonControl = require('../daemon-control');
    const cleanupDaemonProcesses = options.cleanupDaemonProcesses || daemonControl.cleanupDaemonProcesses;
    // #902: postinstall replaces the installed daemon machine-wide; the default port is now
    // named, not assumed by the sweep.
    const result = cleanupDaemonProcesses({ port: daemonControl.DEFAULT_PORT });
    stopped = result.stopped.length;
    if (result.failed.length > 0) {
      logger.warn(`[telepty postinstall] Could not stop ${result.failed.length} daemon process(es).`);
    }
  } catch (err) {
    logger.warn(`[telepty postinstall] cleanupDaemonProcesses failed: ${err.message}`);
  }

  // If an OS supervisor is installed, it must own the replacement daemon. Spawning a
  // detached process here creates the first-pass orphan fixed by #757.
  if (supervisor && supervisor.present) {
    const restart = (options.restartSupervisorDaemon || restartSupervisorDaemon)(supervisor);
    if (!restart || restart.success !== true) {
      logger.warn(
        `[telepty postinstall] Stopped ${stopped} stale daemon(s), but ${supervisor.kind} restart failed: ` +
        `${(restart && restart.error) || 'unknown error'}. Not spawning a detached daemon for a supervisor-managed install.`
      );
      return;
    }

    const waitForVersion = options.waitForDaemonVersion || waitForDaemonVersion;
    const meta = await waitForVersion({
      port: Number(state.port) || 3848,
      version: pkg.version,
      timeoutMs: options.waitTimeoutMs || 8000
    });
    if (meta) {
      logger.log(`[telepty postinstall] Stopped ${stopped} stale daemon(s); ${supervisor.kind} started ${pkg.version} daemon (pid ${meta.pid}).`);
    } else {
      logger.warn(`[telepty postinstall] Stopped ${stopped} stale daemon(s); requested ${supervisor.kind} restart, but daemon did not report ${pkg.version} yet.`);
    }
    return;
  }

  // No supervisor installed: keep the pre-#757 fallback so upgrades do not leave
  // standalone/non-root installs without a daemon.
  try {
    const bin = (options.resolveTeleptyBin || resolveTeleptyBin)();
    (options.spawnDetachedDaemon || spawnDetachedDaemon)(bin);
    logger.log(`[telepty postinstall] Stopped ${stopped} stale daemon(s); spawned fresh ${pkg.version} daemon.`);
  } catch (err) {
    logger.warn(`[telepty postinstall] Daemon respawn failed: ${err.message}.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.warn(`[telepty postinstall] Failed: ${err.message}`);
  });
}

module.exports = {
  main,
  readDaemonState,
  resolveTeleptyBin,
  shouldSkip,
  spawnDetachedDaemon,
  waitForDaemonVersion
};
