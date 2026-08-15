'use strict';

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSharedContextPromptPath } = require('./shared-context');
const { parseHostSpec } = require('./host-spec');

const PEERS_PATH = path.join(os.homedir(), '.telepty', 'peers.json');
const BROKER_CONFIG_PATH = path.join(os.homedir(), '.telepty', 'broker.json');
const CONTROL_DIR = path.join(os.homedir(), '.telepty', 'ssh');

function getPeerTransport(entry) {
  if (!entry) return null;
  return entry.transport || 'ssh';
}

// #835: a peer that ANSWERS and declines is not a peer with no sessions. Only a connect error
// (peer offline, ssh unreachable) may honestly degrade to []; a 401/403 means the peer is up
// and refusing our credential, and a 5xx means it is up and broken. Both must reach the
// operator by name — a list that silently drops a refusing peer still looks authoritative.
const PEER_REFUSAL_STATUSES = new Set([401, 403]);

function peerAnswerError(name, target, status, detail) {
  const what = PEER_REFUSAL_STATUSES.has(status)
    ? `REFUSED this node's credential (HTTP ${status})`
    : status
      ? `answered with HTTP ${status}`
      : 'could not answer';
  const because = detail ? ` (${detail})` : '';
  const error = new Error(`Peer '${name}' (${target}) ${what}${because} — its sessions are UNKNOWN, not absent.`);
  error.name = 'PeerResponseError';
  error.peer = name;
  error.status = status || null;
  error.refused = PEER_REFUSAL_STATUSES.has(status);
  return error;
}

function isPeerAnswerError(error) {
  return Boolean(error) && error.name === 'PeerResponseError';
}

// Split a per-peer settlement into the sessions we know about and the peers we could not ask.
function collectPeerResults(settled) {
  const sessions = [];
  const failures = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') sessions.push(...result.value);
    else failures.push(result.reason);
  }
  return { sessions, failures };
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

function normalizeBrokerUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function loadBrokerConfig() {
  try {
    if (!fs.existsSync(BROKER_CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(BROKER_CONFIG_PATH, 'utf8'));
  } catch { return null; }
}

function saveBrokerConfig(config) {
  fs.mkdirSync(path.dirname(BROKER_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(BROKER_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(BROKER_CONFIG_PATH, 0o600); } catch {}
}

// In-memory active peers
const activePeers = new Map(); // name -> { target, controlSocket, connectedAt, machineId }

// File-backed SSH peer enumeration. Required because CLI subprocesses (fresh
// node procs) start with an empty `activePeers` Map — only the process that
// called connect() has it populated. peers.json is the cross-process source of
// truth. controlPath(target) is deterministic, so any process can reuse the
// ControlMaster socket established by an earlier connect() as long as
// ControlPersist hasn't expired. See #411.
function listSshPeers() {
  const peers = loadPeers().peers || {};
  return Object.entries(peers)
    .filter(([, entry]) => getPeerTransport(entry) === 'ssh' && entry && entry.target)
    .map(([name, entry]) => ({
      name,
      target: entry.target,
      machineId: entry.machineId || name,
      lastConnected: entry.lastConnected
    }));
}

function getSshPeerHandle(name) {
  if (activePeers.has(name)) return activePeers.get(name);
  const peers = loadPeers().peers || {};
  const entry = peers[name];
  if (!entry || getPeerTransport(entry) !== 'ssh' || !entry.target) return null;
  return {
    target: entry.target,
    controlSocket: controlPath(entry.target),
    name,
    machineId: entry.machineId || name
  };
}

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
    // #835: ssh never ran or never answered (spawn failure, timeout) — a transport-level
    // absence, not the remote declining. Tagged so callers can keep the two apart.
    throw Object.assign(result.error, { transportFailure: true });
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    // #835: carry the exit status. ssh reserves 255 for its OWN failure (host unreachable, auth
    // to the host failed); any other non-zero is the REMOTE command answering that it could not
    // do the job — a distinction the caller needs to tell "peer is offline" from "peer refused".
    throw Object.assign(
      new Error(stderr || stdout || `Remote command failed with exit code ${result.status}`),
      { status: result.status }
    );
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
  const peer = getSshPeerHandle(name);
  if (!peer) return [];

  try {
    const output = runRemoteCommand(peer, 'telepty list --json', { timeout: 10000 });
    const sessions = JSON.parse(output);
    if (!Array.isArray(sessions)) throw new Error('remote returned a non-list');
    return sessions.map(s => ({ ...s, host: peer.target, peerName: name, remote: true }));
  } catch (error) {
    // #835: ssh's OWN failure — exit 255 (host down, host auth failed) or a spawn-level error
    // (blackholed host, timeout, no ssh binary) — is a genuinely unreachable peer, the one case
    // where "no sessions" is honest. Anything else is the remote telepty answering that it could
    // not tell us (after this fix it exits non-zero on a refusal instead of printing `[]`), and
    // that must never read here as "that machine is empty".
    if (error && (error.status === 255 || error.transportFailure)) return [];
    throw peerAnswerError(name, peer.target, null, error && error.message);
  }
}

/**
 * Discover sessions across all connected peers, including SSH peers that are
 * persisted in peers.json but not in this process's activePeers Map. Fresh
 * CLI subprocesses depend on the file-backed path — #411.
 * @returns {{sessions: Array, failures: Error[]}} sessions we know about, and the peers we
 *          could not ask (#835 — a peer we could not ask is not a peer with nothing to report)
 */
function discoverAllRemoteSessions() {
  const sessions = [];
  const failures = [];
  const seen = new Set();
  const collect = (name) => {
    try {
      sessions.push(...listRemoteSessions(name));
    } catch (error) {
      failures.push(error);
    }
  };
  for (const [name] of activePeers) {
    collect(name);
    seen.add(name);
  }
  for (const peer of listSshPeers()) {
    if (seen.has(peer.name)) continue;
    collect(peer.name);
  }
  return { sessions, failures };
}

/**
 * Inject text into a remote session via SSH.
 */
function remoteInject(name, sessionId, prompt, options = {}) {
  const peer = getSshPeerHandle(name);
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
  const peer = getSshPeerHandle(name);
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
  // #823 — /api/meta is auth-gated, so discovery needs whichever token this operator has for the
  // target. /api/health below deliberately sends none: it is registered BEFORE the auth
  // middleware (daemon.js), and hardening it would break daemon-control's port-ownership probe
  // and aterm's version detection in one stroke.
  const metaToken = options.token || process.env.TELEPTY_AUTH_TOKEN;
  if (metaToken) headers['x-telepty-token'] = metaToken;

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
  // #823 — same address-keyed order as cli.js resolveTargetToken: explicit → env → the peer's
  // stored token (written by `connect-http --token`, and read for the first time here).
  const token = options.token || process.env.TELEPTY_AUTH_TOKEN || entry.token;
  if (token) headers['x-telepty-token'] = token;

  const target = `${entry.host}:${entry.port}`;
  try {
    const url = `http://${entry.host}:${entry.port}/api/sessions`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs || 3000),
      headers
    });
    // #835: a refused or failing peer used to contribute zero sessions to a list that still
    // looked authoritative. It answered — say so.
    if (!res.ok) throw peerAnswerError(name, target, res.status);
    const sessions = await res.json();
    if (!Array.isArray(sessions)) throw peerAnswerError(name, target, res.status, 'non-list response body');
    return sessions.map((s) => ({
      ...s,
      host: target,
      peerName: name,
      peerPort: entry.port
    }));
  } catch (error) {
    if (isPeerAnswerError(error)) throw error;
    return []; // connect error / timeout: the peer is unreachable, so no sessions is honest
  }
}

async function discoverHttpRemoteSessions(options = {}) {
  const peers = listHttpPeers();
  return collectPeerResults(await Promise.allSettled(
    peers.map((peer) => listHttpRemoteSessions(peer.name, options))
  ));
}

// ── Broker peer support (opt-in relay discovery) ────────────────────────────
// connect-broker stores the node's broker credentials in broker.json (0600) and
// records a non-secret transport='broker' peer in peers.json. Discovery remains
// default-OFF: no broker peer entry means list discovery never calls the broker.

async function connectBroker(url, options = {}) {
  const brokerUrl = normalizeBrokerUrl(url);
  if (!brokerUrl) {
    return { success: false, error: 'connect-broker requires a valid broker URL.' };
  }

  const node = String(options.node || '').trim();
  if (!node) {
    return { success: false, error: 'connect-broker requires --node <name>.' };
  }

  const jwt = String(options.jwt || '').trim();
  if (!jwt) {
    return { success: false, error: 'connect-broker requires a node JWT.' };
  }

  const connectedAt = new Date().toISOString();
  const config = {
    url: brokerUrl,
    node,
    jwt,
    pin: options.pin || null,
    accept_from: null
  };
  saveBrokerConfig(config);

  const peers = loadPeers();
  peers.peers[node] = {
    transport: 'broker',
    node,
    url: brokerUrl,
    machineId: node,
    lastConnected: connectedAt
  };
  savePeers(peers);

  return { success: true, name: node, node, url: brokerUrl };
}

function listBrokerPeers() {
  const peers = loadPeers().peers || {};
  return Object.entries(peers)
    .filter(([, entry]) => getPeerTransport(entry) === 'broker')
    .map(([name, entry]) => ({
      name,
      node: entry.node || entry.machineId || name,
      url: entry.url,
      machineId: entry.machineId || entry.node || name,
      lastConnected: entry.lastConnected
    }));
}

async function listBrokerRemoteSessions(options = {}) {
  const config = options.config || loadBrokerConfig();
  const brokerUrl = normalizeBrokerUrl(options.url || (config && config.url));
  const jwt = String(options.jwt || (config && config.jwt) || '').trim();
  if (!brokerUrl || !jwt) return [];

  try {
    const res = await fetch(`${brokerUrl}/broker/sessions`, {
      signal: AbortSignal.timeout(options.timeoutMs || 3000),
      headers: { Authorization: `Bearer ${jwt}` }
    });
    // #835: same shape as the HTTP peer — a broker that rejects our JWT is not a broker
    // relaying zero sessions.
    if (!res.ok) throw peerAnswerError(config && config.node ? config.node : 'broker', brokerUrl, res.status);
    const body = await res.json();
    const sessions = Array.isArray(body) ? body : body && body.sessions;
    if (!Array.isArray(sessions)) throw peerAnswerError(config && config.node ? config.node : 'broker', brokerUrl, res.status, 'non-list response body');
    return sessions.map((session) => {
      const base = (session && typeof session === 'object') ? session : { id: session };
      const node = base.peerName || base.host || base.node || base.machineId || base.machine_id;
      return {
        ...base,
        host: node,
        peerName: node
      };
    });
  } catch (error) {
    if (isPeerAnswerError(error)) throw error;
    return []; // broker unreachable
  }
}

async function discoverBrokerRemoteSessions(options = {}) {
  if (listBrokerPeers().length === 0) return { sessions: [], failures: [] };
  return collectPeerResults(await Promise.allSettled([listBrokerRemoteSessions(options)]));
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
  // Broker peer transport (opt-in relay discovery)
  connectBroker,
  listBrokerPeers,
  listBrokerRemoteSessions,
  discoverBrokerRemoteSessions,
  loadBrokerConfig,
  // File-backed SSH peer enumeration (cross-process — #411)
  listSshPeers,
  getSshPeerHandle,
  getPeerTransport,
  PEERS_PATH,
  BROKER_CONFIG_PATH
};
