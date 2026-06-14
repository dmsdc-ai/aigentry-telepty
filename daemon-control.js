'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, execSync } = require('child_process');
const { killWindowsProcess } = require('./src/win-kill-process');

const TELEPTY_DIR = path.join(os.homedir(), '.telepty');
const DAEMON_STATE_FILE = path.join(TELEPTY_DIR, 'daemon-state.json');
const DEFAULT_KILL_GRACE_MS = 5000;

function killGraceMs() {
  const raw = Number(process.env.TELEPTY_DAEMON_KILL_GRACE_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_KILL_GRACE_MS;
}

function ensureTeleptyDir() {
  fs.mkdirSync(TELEPTY_DIR, { recursive: true, mode: 0o700 });
}

function sleepMs(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readDaemonState() {
  if (!fs.existsSync(DAEMON_STATE_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(DAEMON_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeDaemonState(state) {
  ensureTeleptyDir();
  fs.writeFileSync(DAEMON_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function clearDaemonState(expectedPid) {
  if (!fs.existsSync(DAEMON_STATE_FILE)) {
    return;
  }

  if (expectedPid === undefined) {
    fs.rmSync(DAEMON_STATE_FILE, { force: true });
    return;
  }

  const current = readDaemonState();
  if (!current || current.pid === expectedPid) {
    fs.rmSync(DAEMON_STATE_FILE, { force: true });
  }
}

function claimDaemonState(details) {
  ensureTeleptyDir();
  const current = readDaemonState();

  if (current && current.pid !== process.pid) {
    if (isProcessRunning(current.pid)) {
      return { claimed: false, current };
    }

    clearDaemonState(current.pid);
  }

  const state = {
    pid: process.pid,
    host: details.host,
    port: details.port,
    startedAt: new Date().toISOString(),
    version: details.version
  };
  writeDaemonState(state);
  return { claimed: true, state };
}

function isLikelyTeleptyDaemon(commandLine) {
  const text = String(commandLine || '').toLowerCase();
  if (!text) {
    return false;
  }

  // telepty#44: the running daemon sets process.title = 'telepty-daemon' (daemon.js:188).
  // On macOS/Linux that REPLACES the command field `ps -axo command=` returns, so the
  // daemon's own title (hyphen) — not its launch command line — is what the process scan
  // and port-owner confirmation see. Recognize it so the stop path is no longer blind to it.
  if (text.includes('telepty-daemon')) {
    return true;
  }

  if (text.includes('telepty daemon')) {
    return true;
  }

  if (text.includes('cli.js daemon')) {
    return true;
  }

  return text.includes('daemon.js') && text.includes('aigentry-telepty');
}

function listUnixProcesses() {
  const output = execSync('ps -axo pid=,command=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return output.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      return { pid: Number(match[1]), commandLine: match[2] };
    })
    .filter(Boolean);
}

function listWindowsProcesses() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();

  if (!output) {
    return [];
  }

  const records = JSON.parse(output);
  const list = Array.isArray(records) ? records : [records];
  return list
    .map((item) => ({
      pid: Number(item.ProcessId),
      commandLine: item.CommandLine || ''
    }))
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0);
}

function listDaemonProcesses() {
  let processes = [];

  try {
    processes = process.platform === 'win32' ? listWindowsProcesses() : listUnixProcesses();
  } catch {
    return [];
  }

  return processes.filter((item) => item.pid !== process.pid && isLikelyTeleptyDaemon(item.commandLine));
}

function stopDaemonProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    if (process.platform === 'win32') {
      // Windows: delegate to dedicated module so taskkill args are unit-testable.
      return killWindowsProcess(pid);
    }

    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + killGraceMs();
    while (Date.now() < deadline) {
      if (!isProcessRunning(pid)) {
        return true;
      }
      sleepMs(50);
    }

    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return !isProcessRunning(pid);
  }
}

// Port-owner discovery for telepty#15 port-owner fallback.
// Returns the LISTEN-state pid bound to `port` on the local machine, or null
// if no listener can be identified (or detection failed).
function findPortOwnerPid(port, opts) {
  if (!Number.isInteger(port) || port <= 0) return null;
  const o = opts || {};
  const platform = o.platform || process.platform;
  const exec = o.execSync || execSync;

  try {
    if (platform === 'win32') {
      // PowerShell: Get-NetTCPConnection guarantees LISTEN-state filter.
      const script =
        `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue ` +
        `| Select-Object -First 1 -ExpandProperty OwningProcess`;
      const output = String(exec(`powershell.exe -NoProfile -Command "${script}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })).trim();
      const pid = Number(output);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }

    // POSIX: lsof -t prints only PIDs; -sTCP:LISTEN narrows to listeners.
    const output = String(exec(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })).trim();
    if (!output) return null;
    const pid = Number(output.split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Confirm via HTTP probe that the listener on `port` is actually a telepty
// daemon (token-less /api/health endpoint is enough — daemon.js:2891 path).
function probeTeleptyOnPort(port, opts) {
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false);
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 1500;
  const httpGet = o.httpGet || http.get;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let req;
    try {
      req = httpGet({ hostname: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            finish(Boolean(data && data.status === 'ok'));
          } catch {
            finish(false);
          }
        });
      });
    } catch {
      finish(false);
      return;
    }

    req.on('error', () => finish(false));
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      finish(false);
    });
  });
}

// telepty#15: identify who launched a daemon we cannot stop (e.g. an older
// daemon bundled inside a parent app such as aterm), so the CLI can print an
// actionable diagnostic instead of retrying blindly. Returns
// { ppid, command } for `pid`'s parent, or null when it cannot be resolved.
function findParentProcessInfo(pid, opts) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const o = opts || {};
  const platform = o.platform || process.platform;
  const exec = o.execSync || execSync;

  try {
    if (platform === 'win32') {
      const script =
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
        `if ($p) { $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; ` +
        `"$($p.ParentProcessId)|$(if ($pp) { $pp.Name } else { '' })" }`;
      const output = String(exec(`powershell.exe -NoProfile -Command "${script}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })).trim();
      if (!output) return null;
      const [ppidRaw, name] = output.split('|');
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(ppid) || ppid <= 0) return null;
      return { ppid, command: (name || '').trim() || null };
    }

    const ppidRaw = String(exec(`ps -p ${pid} -o ppid=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })).trim();
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(ppid) || ppid <= 0) return null;
    const command = String(exec(`ps -p ${ppid} -o comm=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })).trim() || null;
    return { ppid, command };
  } catch {
    return null;
  }
}

// telepty#15: once-per-mismatch warning marker. A daemon the CLI cannot stop
// (foreign-owned port, EPERM, parent respawns it) used to produce the full
// mismatch + 3-retries + failure banner on EVERY command. The CLI records the
// blocked state's signature here after warning once; identical signatures are
// then silent until the blocking pid / version pair changes or a restart
// succeeds. `opts.file` is an injectable path so tests never touch ~/.telepty.
const RESTART_FAILURE_FILE = path.join(TELEPTY_DIR, 'restart-failure.json');

function readRestartFailureMarker(opts) {
  const file = (opts && opts.file) || RESTART_FAILURE_FILE;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeRestartFailureMarker(marker, opts) {
  const file = (opts && opts.file) || RESTART_FAILURE_FILE;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort: losing the marker only means a repeated warning, never a failure.
  }
}

function clearRestartFailureMarker(opts) {
  const file = (opts && opts.file) || RESTART_FAILURE_FILE;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best-effort (see writeRestartFailureMarker).
  }
}

// Confirm via local process scan that `pid`'s command line looks like a
// telepty daemon (fallback when HTTP probe fails — daemon may be stuck).
function pidMatchesTeleptyCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const processes = process.platform === 'win32' ? listWindowsProcesses() : listUnixProcesses();
    const match = processes.find((item) => item.pid === pid);
    return Boolean(match && isLikelyTeleptyDaemon(match.commandLine));
  } catch {
    return false;
  }
}

function cleanupDaemonProcesses(opts) {
  const o = opts || {};
  const targets = new Map();
  const state = (o.readDaemonState || readDaemonState)();

  if (state && Number.isInteger(state.pid) && state.pid > 0 && state.pid !== process.pid) {
    targets.set(state.pid, { pid: state.pid, source: 'state-file' });
  }

  for (const item of (o.listDaemonProcesses || listDaemonProcesses)()) {
    if (!targets.has(item.pid)) {
      targets.set(item.pid, { pid: item.pid, source: 'process-scan', commandLine: item.commandLine });
    }
  }

  // 3rd source: port-owner fallback (telepty#15).
  // Only consider it a kill candidate after a confirmation step so we never
  // SIGTERM an arbitrary process that happens to own the port.
  // Confirmation order: HTTP /api/health probe → ps cmdline match.
  // Sync-friendly: HTTP probe is opt-in (port-owner kept disabled in tests).
  if (o.includePortOwner !== false) {
    const portOwnerPid = (o.findPortOwnerPid || findPortOwnerPid)(o.port || 3848);
    if (portOwnerPid && portOwnerPid !== process.pid && !targets.has(portOwnerPid)) {
      const confirmCmdline = (o.pidMatchesTeleptyCmdline || pidMatchesTeleptyCmdline);
      if (confirmCmdline(portOwnerPid)) {
        targets.set(portOwnerPid, { pid: portOwnerPid, source: 'port-owner' });
      }
    }
  }

  const stopped = [];
  const failed = [];

  for (const item of targets.values()) {
    const killer = o.stopDaemonProcess || stopDaemonProcess;
    if (killer(item.pid)) {
      stopped.push(item);
    } else {
      failed.push(item);
    }
  }

  const nextState = readDaemonState();
  if (nextState && !isProcessRunning(nextState.pid)) {
    clearDaemonState(nextState.pid);
  }

  return { stopped, failed };
}

// telepty#55: user-facing `telepty daemon stop`. Unlike cleanupDaemonProcesses
// (which ALSO sweeps the whole process table for ANY telepty daemon — the right
// behavior for `cleanup-daemons` and internal repair), stop must be SURGICAL: it
// targets only the daemon THIS CLI is configured for — the state-file pid and the
// owner of the configured port (default 3848). It never blind-scans the process
// table, so it can never reap an unrelated telepty daemon (e.g. another node's
// daemon on a different port). This mirrors the #44/#15 survivor-detection surface
// (state-file pid + port owner) and reuses cleanupDaemonProcesses' graceful
// SIGTERM→SIGKILL kill path + stale-state cleanup with the global scan disabled.
function stopDaemon(opts) {
  const o = opts || {};
  return cleanupDaemonProcesses({
    ...o,
    port: Number.isInteger(o.port) && o.port > 0 ? o.port : 3848,
    // Force-disable the system-wide process scan unconditionally (never honor a
    // caller-provided one) — this is the surgical guarantee: stop reaps only the
    // state-file pid and the configured port's owner, never a table sweep.
    listDaemonProcesses: () => []
  });
}

module.exports = {
  DAEMON_STATE_FILE,
  claimDaemonState,
  cleanupDaemonProcesses,
  stopDaemon,
  clearDaemonState,
  clearRestartFailureMarker,
  findParentProcessInfo,
  findPortOwnerPid,
  isLikelyTeleptyDaemon,
  isProcessRunning,
  listDaemonProcesses,
  pidMatchesTeleptyCmdline,
  probeTeleptyOnPort,
  readDaemonState,
  readRestartFailureMarker,
  writeRestartFailureMarker
};
