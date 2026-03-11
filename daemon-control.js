'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const TELEPTY_DIR = path.join(os.homedir(), '.telepty');
const DAEMON_STATE_FILE = path.join(TELEPTY_DIR, 'daemon-state.json');

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
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    }

    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 1500;
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

function cleanupDaemonProcesses() {
  const targets = new Map();
  const state = readDaemonState();

  if (state && Number.isInteger(state.pid) && state.pid > 0 && state.pid !== process.pid) {
    targets.set(state.pid, { pid: state.pid, source: 'state-file' });
  }

  for (const item of listDaemonProcesses()) {
    if (!targets.has(item.pid)) {
      targets.set(item.pid, { pid: item.pid, source: 'process-scan', commandLine: item.commandLine });
    }
  }

  const stopped = [];
  const failed = [];

  for (const item of targets.values()) {
    if (stopDaemonProcess(item.pid)) {
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

module.exports = {
  DAEMON_STATE_FILE,
  claimDaemonState,
  cleanupDaemonProcesses,
  clearDaemonState,
  isProcessRunning,
  listDaemonProcesses,
  readDaemonState
};
