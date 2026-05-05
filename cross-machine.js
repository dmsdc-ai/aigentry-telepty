'use strict';

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSharedContextPromptPath } = require('./shared-context');
const { parseHostSpec } = require('./host-spec');

const PEERS_PATH = path.join(os.homedir(), '.telepty', 'peers.json');
const CONTROL_DIR = path.join(os.homedir(), '.telepty', 'ssh');

function getPeerTransport(entry) {
  if (!entry) return null;
  return entry.transport || 'ssh';
}

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

// ── HTTP peer support (no SSH required) ─────────────────────────────────────
// connect-http records a remote daemon's host:port in peers.json with
// transport='http'. Subsequent inject/list calls discover sessions via the
// remote daemon's HTTP API directly. Built for laptop daemons where running
// sshd is not viable. See GitHub issue #13.

async function connectHttp(target, options = {}) {
  const spec = parseHostSpec(target);
  if (!spec.host) {
    return { success: false, error: 'connect-http requires a host (got empty value).' };
  }

  const name = options.name || spec.host.split('.')[0] || spec.host;

  const headers = {};
  if (options.token) headers['x-telepty-token'] = options.token;

  let machineId = name;
  let healthOk = false;
  try {
    const healthUrl = `http://${spec.host}:${spec.port}/api/health`;
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { success: false, error: `Daemon at ${spec.host}:${spec.port} returned HTTP ${res.status} on /api/health.` };
    }
    healthOk = true;
  } catch (err) {
    return { success: false, error: `Cannot reach daemon at ${spec.host}:${spec.port}: ${err.message}` };
  }

  try {
    const metaUrl = `http://${spec.host}:${spec.port}/api/meta`;
    const res = await fetch(metaUrl, { signal: AbortSignal.timeout(3000), headers });
    if (res.ok) {
      const meta = await res.json();
      if (meta && typeof meta.machine_id === 'string' && meta.machine_id) {
        machineId = meta.machine_id;
      } else if (meta && typeof meta.host === 'string' && meta.host) {
        machineId = meta.host;
      }
    }
  } catch {
    // /api/meta is auth-gated; failure is not fatal — health passed.
  }

  const peers = loadPeers();
  peers.peers[name] = {
    transport: 'http',
    host: spec.host,
    port: spec.port,
    target: `${spec.host}:${spec.port}`,
    machineId,
    lastConnected: new Date().toISOString()
  };
  if (options.token) {
    peers.peers[name].token = options.token;
  }
  savePeers(peers);

  return {
    success: true,
    name,
    host: spec.host,
    port: spec.port,
    machineId,
    healthOk
  };
}

function listHttpPeers() {
  const peers = loadPeers().peers || {};
  return Object.entries(peers)
    .filter(([, entry]) => getPeerTransport(entry) === 'http')
    .map(([name, entry]) => ({
      name,
      host: entry.host,
      port: entry.port,
      machineId: entry.machineId,
      lastConnected: entry.lastConnected,
      hasToken: Boolean(entry.token)
    }));
}

async function listHttpRemoteSessions(name, options = {}) {
  const peers = loadPeers().peers || {};
  const entry = peers[name];
  if (!entry || getPeerTransport(entry) !== 'http') return [];

  const headers = {};
  const token = options.token || entry.token;
  if (token) headers['x-telepty-token'] = token;

  try {
    const url = `http://${entry.host}:${entry.port}/api/sessions`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs || 3000),
      headers
    });
    if (!res.ok) return [];
    const sessions = await res.json();
    if (!Array.isArray(sessions)) return [];
    return sessions.map((s) => ({
      ...s,
      host: `${entry.host}:${entry.port}`,
      peerName: name,
      peerPort: entry.port
    }));
  } catch {
    return [];
  }
}

async function discoverHttpRemoteSessions(options = {}) {
  const peers = listHttpPeers();
  const results = await Promise.all(
    peers.map((peer) => listHttpRemoteSessions(peer.name, options))
  );
  return results.flat();
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
  // HTTP peer transport (no SSH required)
  connectHttp,
  listHttpPeers,
  listHttpRemoteSessions,
  discoverHttpRemoteSessions,
  getPeerTransport,
  PEERS_PATH
};
