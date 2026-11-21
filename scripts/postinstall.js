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
const { spawn } = require('child_process');

const pkg = require('../package.json');
const { detectSupervisor, ownsLifecycleTarget, restartSupervisorDaemon } = require('../src/supervisor');

const { compareSemver } = require('../src/version-handshake');

function topLevelPackage(root, prefix) {
  const parts = root.replace(/\\/g, '/').split('/');
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  if (!windows && !path.posix.isAbsolute(root)) return false;
  if (prefix) {
    const paths = windows ? path.win32 : path.posix;
    const modules = windows ? 'node_modules' : 'lib/node_modules';
    if (paths.relative(paths.join(prefix, modules, pkg.name), root) !== '') return false;
  } else if (!windows && parts.at(-4) !== 'lib') {
    return false;
  }
  return parts.filter(p => p.toLowerCase() === 'node_modules').length === 1
    && parts.slice(-3).join('/') === 'node_modules/' + pkg.name;
}

function installScope(env, root) {
  if (env.npm_config_global !== 'true') return 'non-global install';
  // Check npm's manifest as well as the physical hook location for nested links.
  if (!topLevelPackage(root, env.npm_config_prefix) || (env.npm_package_json &&
      !topLevelPackage(env.npm_package_json.replace(/[\\/]package\.json$/, ''), env.npm_config_prefix))) {
    return 'outside the top-level global package; daemon left alone';
  }
  return null;
}

function shouldSkip(env = process.env, root = path.dirname(__dirname)) {
  if (env.TELEPTY_SKIP_POSTINSTALL === '1') return 'TELEPTY_SKIP_POSTINSTALL=1';
  const scope = installScope(env, root);
  if (scope) return scope;
  if (env.npm_command && !['install', 'update'].includes(env.npm_command)) return 'outside npm install';
  return null;
}

function restartCommand(port, platform) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'telepty daemon restart';
  return platform === 'win32'
    ? `$env:TELEPTY_PORT='${port}'; telepty daemon restart`
    : `TELEPTY_PORT=${port} telepty daemon restart`;
}

async function stopRecordedDaemon(state, supervised, homeDir = os.homedir()) {
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !state.host) return false;
  if (homeDir !== os.homedir()) return false;
  const current = readDaemonState(homeDir);
  if (!current || ['pid', 'port', 'host', 'version', 'startedAt', 'instanceId'].some(field => current[field] !== state[field])) return false;
  const outcome = await require('../cli').gracefulWindowsStop(state.port, { ...state, supervised });
  return outcome.ok && outcome.stopped?.length === 1 && outcome.stopped[0] === state.pid;
}

function readDaemonState(homeDir = os.homedir()) {
  const statePath = path.join(homeDir, '.telepty', 'daemon-state.json');
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

// Use this install's CLI directly: Windows PATH may select the extensionless npm shim.
function resolveTeleptyBin() {
  return process.execPath;
}

function spawnDetachedDaemon(bin = process.execPath, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(bin, [path.resolve(__dirname, '../cli.js'), 'daemon'], {
      detached: true, stdio: 'ignore', windowsHide: true,
      ...(options.port ? { env: { ...process.env, TELEPTY_PORT: String(options.port) } } : {})
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child);
    });
  });
}

function printServiceHint(logger, supervisor, platform = process.platform) {
  if (supervisor && supervisor.present) return false;
  const linger = platform === 'darwin' || platform === 'win32'
    ? ''
    : ' (boot without login also needs: loginctl enable-linger $USER)';
  logger.log(
    '[telepty postinstall] No OS service manages the telepty daemon; it will not start after '
    + `reboot/login. To enable: telepty service install${linger}`
  );
  return true;
}

// #1228: name a legacy dual-install so `npm rm -g aigentry-telepty` cannot take
// the shared `telepty` link by surprise. Diagnosis only — never npm, never a
// write into the prefix — and wrapped so a diagnosis can never break an install.
function warnAboutLegacyInstall(options, logger, platform, env) {
  try {
    const ownership = require('../src/bin-ownership');
    const diagnose = options.diagnoseBinOwnership || ownership.diagnoseBinOwnership;
    const notice = ownership.formatMigrationNotice({
      diagnosis: diagnose({ platform, env }),
      version: pkg.version
    });
    if (notice) logger.warn(`[telepty postinstall] ${notice}`);
  } catch {
    // An inconclusive diagnosis is not a failed install.
  }
}

// Task 1215 F2: /api/meta is authenticated (#820: loopback is not a credential). Present the existing local daemon
// token with the client precedence TELEPTY_AUTH_TOKEN, else ~/.telepty/config.json authToken — read-only, never
// minted (auth.js getConfig create:false). Unavailable => no header; the value is never logged.
function localDaemonToken(env = process.env) {
  if (env.TELEPTY_AUTH_TOKEN) return env.TELEPTY_AUTH_TOKEN;
  try { return require('../auth').getConfig({ create: false }).authToken; } catch { return null; }
}

async function waitForDaemonVersion({ port = 3848, version = pkg.version, timeoutMs = 8000, fetchImpl = fetch, token = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/meta`, {
        headers: token ? { 'x-telepty-token': token } : {},
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
  const platform = options.platform || process.platform;
  const skip = shouldSkip(env, options.packageRoot);
  if (skip) {
    logger.log(`[telepty postinstall] Skipped (${skip}).`);
    return;
  }

  warnAboutLegacyInstall(options, logger, platform, env);
  const supervisor = (options.detectSupervisor || detectSupervisor)();

  const state = (options.readDaemonState || readDaemonState)(options.homeDir || os.homedir());
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) {
    logger.log('[telepty postinstall] No running daemon detected — nothing to restart.');
    printServiceHint(logger, supervisor, platform);
    return;
  }

  const order = compareSemver(state.version, pkg.version);
  if (order === null) {
    logger.log('[telepty postinstall] Daemon left alone because its version could not be compared. For a deliberate downgrade, verify the running version and run telepty daemon restart.');
    return;
  }
  if (order > 0 && env.TELEPTY_ALLOW_DAEMON_DOWNGRADE !== '1') {
    logger.log(`[telepty postinstall] Newer daemon ${state.version} left alone. To downgrade deliberately, set TELEPTY_ALLOW_DAEMON_DOWNGRADE=1 and reinstall ${pkg.name}@${pkg.version} globally.`);
    return;
  }
  if (order === 0) {
    logger.log(`[telepty postinstall] Running daemon already at ${pkg.version} (pid ${state.pid}). No restart needed.`);
    printServiceHint(logger, supervisor, platform);
    return;
  }

  // Task 1215 service36: a replacement daemon that would refuse its supervision setting must not replace a running
  // one. Preflight BEFORE the stop; on a refusal skip both stop and restart, so the old daemon keeps running, and
  // name the code only (no path, no config content).
  try {
    const supervision = require('../src/principal/supervision-config');
    try {
      supervision.preflightSupervision({ env, platform, configPath: supervision.defaultConfigPath(options.homeDir || os.homedir()) });
    } catch (err) {
      logger.warn(`[telepty postinstall] Supervision preflight refused (${supervision.refusalCode(err)}); the running `
        + `${state.version || 'unknown'} daemon was NOT stopped or restarted. Fix the supervisionTrustFile setting, then run: telepty daemon restart`);
      return;
    }
  } catch {
    logger.warn('[telepty postinstall] Supervision preflight unavailable (SUPERVISION_PREFLIGHT_FAILED); the running daemon was NOT stopped or restarted.');
    return;
  }

  if (supervisor?.detail === 'disabled-by-env') {
    logger.warn(`[telepty postinstall] Running daemon upgrade deferred because supervisor detection is disabled. Run ${restartCommand(state.port, platform)}.`);
    return;
  }
  const supervised = Boolean(supervisor?.present);
  if (supervised && !(options.ownsLifecycleTarget || ownsLifecycleTarget)(supervisor, state)) {
    logger.warn(`[telepty postinstall] Running daemon upgrade deferred because the service PID and installed command could not be verified. Check telepty service status, then run ${restartCommand(state.port, platform)}.`);
    return;
  }
  const stop = options.stopRecordedDaemon || stopRecordedDaemon;
  if (!(await stop(state, supervised, options.homeDir))) {
    logger.warn(`[telepty postinstall] Recorded daemon exit was not confirmed. Automatic replacement deferred. Check telepty service status, then run ${restartCommand(state.port, platform)}.`);
    return;
  }

  // If an OS supervisor is installed, it must own the replacement daemon. Spawning a
  // detached process here creates the first-pass orphan fixed by #757.
  if (supervisor && supervisor.present) {
    const restart = (options.restartSupervisorDaemon || restartSupervisorDaemon)(supervisor, { startOnly: true });
    if (!restart || restart.success !== true) {
      logger.warn(
        `[telepty postinstall] Stopped daemon (pid ${state.pid}), but ${supervisor.kind} restart failed: ` +
        `${(restart && restart.error) || 'unknown error'}. Not spawning a detached daemon for a supervisor-managed install.`
      );
      return;
    }

    const waitForVersion = options.waitForDaemonVersion || waitForDaemonVersion;
    const meta = await waitForVersion({
      port: Number(state.port) || 3848,
      version: pkg.version,
      timeoutMs: options.waitTimeoutMs || 8000,
      token: localDaemonToken(env)
    });
    if (meta) {
      logger.log(`[telepty postinstall] Stopped daemon (pid ${state.pid}); ${supervisor.kind} started ${pkg.version} daemon (pid ${meta.pid}).`);
    } else {
      logger.warn(`[telepty postinstall] Stopped daemon (pid ${state.pid}); requested ${supervisor.kind} restart, but daemon did not report ${pkg.version} yet.`);
    }
    return;
  }

  // No supervisor installed: keep the pre-#757 fallback so upgrades do not leave
  // standalone/non-root installs without a daemon.
  try {
    await (options.spawnDetachedDaemon || spawnDetachedDaemon)(undefined, { port: state.port });
    logger.log(`[telepty postinstall] Stopped daemon (pid ${state.pid}); spawned fresh ${pkg.version} daemon.`);
  } catch (err) {
    logger.warn(`[telepty postinstall] Daemon respawn failed: ${err.message}.`);
  }
  printServiceHint(logger, supervisor, platform);
}

if (require.main === module) {
  main().catch((err) => {
    console.warn(`[telepty postinstall] Failed: ${err.message}`);
  });
}

module.exports = {
  main,
  installScope,
  stopRecordedDaemon,
  printServiceHint,
  readDaemonState,
  resolveTeleptyBin,
  shouldSkip,
  spawnDetachedDaemon,
  waitForDaemonVersion
};
