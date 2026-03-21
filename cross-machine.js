'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PEERS_PATH = path.join(os.homedir(), '.telepty', 'peers.json');
const BASE_LOCAL_PORT = 3849; // tunnels start at this port

// In-memory active tunnels
const activeTunnels = new Map(); // name -> { process, localPort, target, connectedAt, ... }

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

function getNextLocalPort() {
  const usedPorts = new Set([...activeTunnels.values()].map(t => t.localPort));
  let port = BASE_LOCAL_PORT;
  while (usedPorts.has(port)) port++;
  return port;
}

/**
 * Connect to a remote machine via SSH tunnel.
 * @param {string} target - "user@host" or "host" (uses current user)
 * @param {object} options - { name, port }
 * @returns {Promise<object>} - { success, name, localPort, machineId, version } or { success: false, error }
 */
async function connect(target, options = {}) {
  const remotePort = options.port || 3848;
  const localPort = getNextLocalPort();

  // Parse target
  let sshTarget = target;
  if (!target.includes('@')) {
    sshTarget = `${os.userInfo().username}@${target}`;
  }

  const name = options.name || target.split('@').pop().split('.')[0]; // short hostname

  // Check if already connected
  if (activeTunnels.has(name)) {
    const existing = activeTunnels.get(name);
    return { success: false, error: `Already connected to ${name} on port ${existing.localPort}` };
  }

  // Create SSH tunnel
  const tunnel = spawn('ssh', [
    '-N',                                           // No remote command
    '-L', `${localPort}:localhost:${remotePort}`,   // Local port forwarding
    '-o', 'ServerAliveInterval=30',                 // Keep alive
    '-o', 'ServerAliveCountMax=3',                  // Disconnect after 3 missed keepalives
    '-o', 'ExitOnForwardFailure=yes',               // Fail if port forwarding fails
    '-o', 'ConnectTimeout=10',                      // Connection timeout
    '-o', 'StrictHostKeyChecking=accept-new',       // Auto-accept new host keys
    sshTarget
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  // Wait for tunnel to establish or fail
  const result = await new Promise((resolve) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      // If process is still running after 5s, tunnel is up
      if (!tunnel.killed && tunnel.exitCode === null) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr || 'Connection timeout' });
      }
    }, 5000);

    tunnel.stderr.on('data', (data) => { stderr += data.toString(); });
    tunnel.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({ success: false, error: stderr || `SSH exited with code ${code}` });
      }
    });
    tunnel.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });
  });

  if (!result.success) {
    tunnel.kill();
    return result;
  }

  // Verify remote daemon is accessible through tunnel
  try {
    const res = await fetch(`http://127.0.0.1:${localPort}/api/meta`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) throw new Error('Daemon not responding');
    const meta = await res.json();

    const peerInfo = {
      process: tunnel,
      localPort,
      target: sshTarget,
      name,
      machineId: meta.machine_id || name,
      version: meta.version || 'unknown',
      connectedAt: new Date().toISOString()
    };

    activeTunnels.set(name, peerInfo);

    // Persist peer for reconnection
    const peers = loadPeers();
    peers.peers[name] = {
      target: sshTarget,
      remotePort,
      lastConnected: peerInfo.connectedAt,
      machineId: peerInfo.machineId
    };
    savePeers(peers);

    // Monitor tunnel health
    tunnel.on('exit', () => {
      console.log(`[PEER] SSH tunnel to ${name} disconnected`);
      activeTunnels.delete(name);
    });

    return {
      success: true,
      name,
      localPort,
      machineId: peerInfo.machineId,
      version: peerInfo.version
    };
  } catch (err) {
    tunnel.kill();
    return { success: false, error: `Remote daemon not accessible: ${err.message}` };
  }
}

function disconnect(name) {
  const tunnel = activeTunnels.get(name);
  if (!tunnel) {
    return { success: false, error: `Not connected to ${name}` };
  }
  tunnel.process.kill();
  activeTunnels.delete(name);
  return { success: true, name };
}

function disconnectAll() {
  const names = [...activeTunnels.keys()];
  names.forEach(name => disconnect(name));
  return { disconnected: names };
}

function listActivePeers() {
  return [...activeTunnels.entries()].map(([name, info]) => ({
    name,
    target: info.target,
    localPort: info.localPort,
    machineId: info.machineId,
    connectedAt: info.connectedAt,
    host: `127.0.0.1:${info.localPort}`
  }));
}

function listKnownPeers() {
  return loadPeers().peers;
}

/**
 * Get all connected peer hosts for discovery.
 * @returns {string[]} Array of "127.0.0.1:PORT" strings
 */
function getConnectedHosts() {
  return [...activeTunnels.values()].map(t => `127.0.0.1:${t.localPort}`);
}

/**
 * Get connected host for a specific peer.
 * @param {string} name - Peer name
 * @returns {string|null} "127.0.0.1:PORT" or null
 */
function getPeerHost(name) {
  const tunnel = activeTunnels.get(name);
  return tunnel ? `127.0.0.1:${tunnel.localPort}` : null;
}

function removePeer(name) {
  disconnect(name); // disconnect if active
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
  PEERS_PATH
};
