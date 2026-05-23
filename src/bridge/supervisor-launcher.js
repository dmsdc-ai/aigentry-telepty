'use strict';

// Per-session supervisor process lifecycle. Spawns `telepty-supervisor-bin`
// (single-binary `telepty supervisor` mode is post-P2 per dispatch §6.6 A),
// waits for manifest.json to reach Status::Ready, and offers a liveness
// probe.
//
// Binary discovery order (dispatch §Phase-1 plan):
//   1. TELEPTY_SUPERVISOR_BIN env (absolute path)
//   2. ./target/{release,debug}/telepty-supervisor-bin relative to repo root
//   3. PATH lookup via which/where
//
// Stdlib only — child_process + fs (Constitution §17).

const fs = require('node:fs');
const path = require('node:path');
const { spawn: childSpawn, spawnSync } = require('node:child_process');

const { manifestPath, socketPath } = require('./j3-shim');

const DEFAULT_READY_TIMEOUT_MS = 3000;
const DEFAULT_READY_POLL_MS = 50;
const READY_STATUSES = new Set(['ready', 'draining']);
const BIN_NAME = 'telepty-supervisor-bin';

class SupervisorLauncherError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'SupervisorLauncherError';
  }
}

function whichSync(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(cmd, [name], { encoding: 'utf8' });
    if (res.status === 0) {
      const line = res.stdout.trim().split(/\r?\n/)[0];
      return line || null;
    }
  } catch {}
  return null;
}

/**
 * Resolve the supervisor binary path. Throws ERR_BIN_NOT_FOUND when no
 * candidate is found.
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
function resolveBinary({ env = process.env } = {}) {
  if (env.TELEPTY_SUPERVISOR_BIN) {
    if (fs.existsSync(env.TELEPTY_SUPERVISOR_BIN)) {
      return env.TELEPTY_SUPERVISOR_BIN;
    }
    throw new SupervisorLauncherError(
      'ERR_BIN_NOT_FOUND',
      `TELEPTY_SUPERVISOR_BIN points at '${env.TELEPTY_SUPERVISOR_BIN}' but the file does not exist`,
    );
  }
  // Repo-relative (src/bridge → repo root → target/{release,debug})
  const repoRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(repoRoot, 'target', 'release', BIN_NAME),
    path.join(repoRoot, 'target', 'debug', BIN_NAME),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  const onPath = whichSync(BIN_NAME);
  if (onPath) return onPath;
  throw new SupervisorLauncherError(
    'ERR_BIN_NOT_FOUND',
    `${BIN_NAME} not found. Set TELEPTY_SUPERVISOR_BIN, build via 'cargo build -p telepty-supervisor-bin', or install on PATH.`,
  );
}

/**
 * Spawn a supervisor for a session. Returns a handle exposing the child
 * process and manifest/socket paths. Caller is responsible for invoking
 * `waitReady(sid)` before issuing bridge operations and for cleaning up the
 * child on shutdown.
 *
 * stdio defaults to `['ignore', 'ignore', 'pipe']` — the supervisor mirrors
 * PTY output to its own stdout for M1/M2 smoke parity, which would mix with
 * the parent's stdout if inherited. Stderr (tracing) is piped so callers can
 * surface ready/error logs if needed.
 *
 * @param {{sid: string, argv: string[], cwd?: ?string, binary?: ?string, env?: NodeJS.ProcessEnv, stdio?: Array}} opts
 */
function spawn(opts) {
  const {
    sid,
    argv,
    cwd = null,
    binary = null,
    env = process.env,
    stdio = ['ignore', 'ignore', 'pipe'],
  } = opts || {};

  if (typeof sid !== 'string' || sid.length === 0) {
    throw new SupervisorLauncherError('ERR_BAD_ARG', 'sid required');
  }
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new SupervisorLauncherError('ERR_BAD_ARG', 'argv must be a non-empty array');
  }

  const bin = binary || resolveBinary({ env });
  const args = ['--sid', sid];
  if (cwd) args.push('--cwd', cwd);
  args.push('--', ...argv);

  const child = childSpawn(bin, args, { stdio, env, detached: false });

  return {
    child,
    pid: child.pid,
    sid,
    binary: bin,
    manifestPath: manifestPath(sid),
    socketPath: socketPath(sid),
  };
}

/**
 * Poll the per-session manifest until it reaches a ready status. Resolves
 * with the manifest object; rejects with ERR_READY_TIMEOUT on deadline.
 *
 * Uses TELEPTY_SESSIONS_DIR / HOME (via j3-shim's lazy resolution) so tests
 * can redirect the sessions root deterministically.
 *
 * @param {string} sid
 * @param {{timeoutMs?: number, pollMs?: number}} [options]
 * @returns {Promise<object>}
 */
async function waitReady(sid, { timeoutMs = DEFAULT_READY_TIMEOUT_MS, pollMs = DEFAULT_READY_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  const mp = manifestPath(sid);
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(mp, 'utf8');
      const m = JSON.parse(raw);
      // supervisor.rs writes the manifest with Status::Ready *before* it calls
      // ipc::bind_socket; gate on both so callers can immediately connect.
      if (m && m.id === sid && READY_STATUSES.has(m.status) && fs.existsSync(m.ipc.path)) {
        return m;
      }
    } catch {
      // ENOENT / mid-write race — keep polling.
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new SupervisorLauncherError(
    'ERR_READY_TIMEOUT',
    `supervisor for '${sid}' did not become ready within ${timeoutMs}ms`,
  );
}

/**
 * Best-effort liveness probe — manifest present with ready/draining status
 * AND the recorded pid is alive. Used by callers to decide bridge vs daemon
 * fallback.
 * @param {string} sid
 * @returns {boolean}
 */
function isAlive(sid) {
  try {
    const raw = fs.readFileSync(manifestPath(sid), 'utf8');
    const m = JSON.parse(raw);
    if (!m || m.id !== sid) return false;
    if (!READY_STATUSES.has(m.status)) return false;
    if (typeof m.pid !== 'number' || m.pid <= 0) return false;
    try {
      process.kill(m.pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

module.exports = {
  resolveBinary,
  spawn,
  waitReady,
  isAlive,
  whichSync,
  SupervisorLauncherError,
  BIN_NAME,
};
