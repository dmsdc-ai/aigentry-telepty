'use strict';

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSharedContextPromptPath } = require('./shared-context');

const PEERS_PATH = path.join(os.homedir(), '.telepty', 'peers.json');
const CONTROL_DIR = path.join(os.homedir(), '.telepty', 'ssh');

// SSH ControlMaster socket path pattern
function controlPath(target) {
  return path.join(CONTROL_DIR, `ctrl-${target.replace(/[^a-zA-Z0-9@.-]/g, '_')}`);
}

function loadPeers() {
  try {
    if (!fs.existsSync(PEERS_PATH)) return { peers: {} };
    return JSON.parse(fs.readFileSync(PEERS_PATH, 'utf8'));
  } catch { return { peers: {} }; }
}

function savePeers(data) {
  try {
    fs.mkdirSync(path.dirname(PEERS_PATH), { recursive: true });
    fs.writeFileSync(PEERS_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

// In-memory active peers
const activePeers = new Map(); // name -> { target, controlSocket, connectedAt, machineId }

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runRemoteCommand(peer, remoteCommand, options = {}) {
  const result = spawnSync('ssh', [
    '-o', `ControlPath=${peer.controlSocket}`,
    peer.target,
    remoteCommand
  ], {
    timeout: options.timeout ?? 15000,
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(stderr || stdout || `Remote command failed with exit code ${result.status}`);
  }

  return String(result.stdout || '');
}

/**
 * Connect to a remote machine via SSH ControlMaster.
 */
async function connect(target, options = {}) {
  let sshTarget = target;
  if (!target.includes('@')) {
    sshTarget = `${os.userInfo().username}@${target}`;
  }

  const name = options.name || target.split('@').pop().split('.')[0];

  if (activePeers.has(name)) {
    return { success: false, error: `Already connected to ${name}` };
  }

  // Ensure control directory exists
  fs.mkdirSync(CONTROL_DIR, { recursive: true });

  const ctrlPath = controlPath(sshTarget);

  // Start SSH ControlMaster
  try {
    execSync([
      'ssh', '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${ctrlPath}`,
      '-o', 'ControlPersist=600',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-N', '-f', // Go to background
      sshTarget
    ].join(' '), { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    return { success: false, error: `SSH connection failed: ${err.message}` };
  }

  // Verify remote telepty is available
  let machineId = name;
  try {
    const output = execSync(
      `ssh -o ControlPath=${ctrlPath} ${sshTarget} "hostname"`,
      { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (output) machineId = output;
  } catch {}

  // Verify telepty CLI is available on remote
  try {
    execSync(
      `ssh -o ControlPath=${ctrlPath} ${sshTarget} "telepty list --json"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (err) {
    // Clean up ControlMaster
    try { execSync(`ssh -O exit -o ControlPath=${ctrlPath} ${sshTarget}`, { stdio: 'pipe' }); } catch {}
    return { success: false, error: `Remote telepty not available: ${err.message}` };
  }

  const peerInfo = {
    target: sshTarget,
    controlSocket: ctrlPath,
    name,
    machineId,
    connectedAt: new Date().toISOString()
  };

  activePeers.set(name, peerInfo);

  // Persist peer
  const peers = loadPeers();
  peers.peers[name] = {
    target: sshTarget,
    lastConnected: peerInfo.connectedAt,
    machineId
  };
  savePeers(peers);

  return { success: true, name, machineId };
}

function disconnect(name) {
  const peer = activePeers.get(name);
  if (!peer) {
    return { success: false, error: `Not connected to ${name}` };
  }

  // Close ControlMaster
  try {
    execSync(`ssh -O exit -o ControlPath=${peer.controlSocket} ${peer.target}`, {
      timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {}

  activePeers.delete(name);
  return { success: true, name };
}

function disconnectAll() {
  const names = [...activePeers.keys()];
  names.forEach(name => disconnect(name));
  return { disconnected: names };
}

/**
 * List sessions on a remote peer via SSH.
 * @returns {Array} sessions with host info
 */
function listRemoteSessions(name) {
  const peer = activePeers.get(name);
  if (!peer) return [];

  try {
    const output = execSync(
      `ssh -o ControlPath=${peer.controlSocket} ${peer.target} "telepty list --json"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const sessions = JSON.parse(output);
    return sessions.map(s => ({ ...s, host: peer.target, peerName: name, remote: true }));
  } catch {
    return [];
  }
}

/**
 * Discover sessions across all connected peers.
 * @returns {Array} all remote sessions
 */
function discoverAllRemoteSessions() {
  const allSessions = [];
  for (const [name] of activePeers) {
    allSessions.push(...listRemoteSessions(name));
  }
  return allSessions;
}

/**
 * Inject text into a remote session via SSH.
 */
function remoteInject(name, sessionId, prompt, options = {}) {
  const peer = activePeers.get(name);
  if (!peer) return { success: false, error: `Not connected to ${name}` };

  try {
    const parts = ['telepty', 'inject'];
    if (options.ref) parts.push('--ref');
    if (options.no_enter) parts.push('--no-enter');
    if (options.from) parts.push('--from', options.from);
    if (options.reply_to) parts.push('--reply-to', options.reply_to);
    if (options.reply_expected) parts.push('--reply-expected');
    parts.push(sessionId, prompt);

    const remoteCommand = parts.map(shellQuote).join(' ');
    runRemoteCommand(peer, remoteCommand, { timeout: 15000 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function remoteEnsureSharedContext(name, descriptor) {
  const peer = activePeers.get(name);
  if (!peer) return { success: false, error: `Not connected to ${name}` };

  try {
    const remotePath = `$HOME/.telepty/shared/${descriptor.fileName}`;
    const remoteCommand = [
      'sh',
      '-lc',
      shellQuote(`umask 077 && mkdir -p "$HOME/.telepty/shared" && cat > "${remotePath}"`)
    ].join(' ');

    runRemoteCommand(peer, remoteCommand, {
      timeout: 15000,
      input: descriptor.content
    });

    return {
      success: true,
      promptPath: getSharedContextPromptPath(descriptor.fileName)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Spawn an interactive SSH attach to a remote session.
 * Returns the child process for stdin/stdout piping.
 */
function remoteAttach(name, sessionId) {
  const peer = activePeers.get(name);
  if (!peer) return null;

  return spawn('ssh', [
    '-o', `ControlPath=${peer.controlSocket}`,
    '-t', // Force TTY allocation
    peer.target,
    'telepty', 'attach', sessionId
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

function listActivePeers() {
  return [...activePeers.entries()].map(([name, info]) => ({
    name,
    target: info.target,
    machineId: info.machineId,
    connectedAt: info.connectedAt
  }));
}

function listKnownPeers() {
  return loadPeers().peers;
}

/**
 * Find which peer has a given session.
 * @returns {{ peerName, peer } | null}
 */
function findSessionPeer(sessionId) {
  for (const [name] of activePeers) {
    const sessions = listRemoteSessions(name);
    if (sessions.some(s => s.id === sessionId)) {
      return { peerName: name, peer: activePeers.get(name) };
    }
  }
  return null;
}

// Backward compat - getConnectedHosts no longer returns HTTP hosts
// Instead returns peer names for SSH-based discovery
function getConnectedHosts() {
  return []; // No HTTP hosts - use discoverAllRemoteSessions() instead
}

function getPeerHost(name) {
  return null; // No HTTP host - use SSH direct
}

function removePeer(name) {
  disconnect(name);
  const peers = loadPeers();
  delete peers.peers[name];
  savePeers(peers);
  return { success: true };
}

module.exports = {
  connect,
  disconnect,
  disconnectAll,
  listActivePeers,
  listKnownPeers,
  getConnectedHosts,
  getPeerHost,
  removePeer,
  loadPeers,
  listRemoteSessions,
  discoverAllRemoteSessions,
  remoteInject,
  remoteEnsureSharedContext,
  remoteAttach,
  findSessionPeer,
  PEERS_PATH
};
