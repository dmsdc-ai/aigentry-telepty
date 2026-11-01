'use strict';
const { execFile } = require('node:child_process');
const { inTailnetRange } = require('./net/tailnet');

const MAX_CANDIDATES = 256;
const MAX_STATUS_BYTES = 1024 * 1024;
const TTL_MS = 15000;
function label(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 253
    && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value.replace(/\.$/, '') : null;
}
function parseCandidates(status, registered = {}, nowMs = Date.now()) {
  if (!status || status.BackendState !== 'Running' || !status.Peer || typeof status.Peer !== 'object'
      || Array.isArray(status.Peer)) throw Error('unsupported_status');
  const candidates = [], seen = new Set();
  let truncated = false;
  for (const peer of Object.values(status.Peer)) {
    if (!peer || typeof peer !== 'object' || peer.Online !== true || peer.ID === status.Self?.ID) continue;
    const address = Array.isArray(peer.TailscaleIPs) && peer.TailscaleIPs.find(inTailnetRange);
    if (!address || seen.has(address)) continue;
    if (candidates.length === MAX_CANDIDATES) { truncated = true; break; }
    seen.add(address);
    // Advertised names never select credentials. Only exact pre-enrolled HTTP addresses
    // are matched, and a match is metadata, not a successful authenticated API probe.
    const matches = Object.entries(registered).filter(([, record]) => record && record.transport === 'http'
      && record.host === address && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535);
    const known = matches.length === 1 ? matches[0] : null;
    candidates.push({ address, port: known ? known[1].port : 3848,
      machine_id: label(peer.HostName), dns_name: label(peer.DNSName),
      online_observed: true, authenticated: false, registered: !!known,
      ...(known ? { registered_name: known[0] } : {}),
      enrollment: matches.length > 1 ? 'ambiguous_registration'
        : known && typeof known[1].token === 'string' && known[1].token ? 'credential_configured' : 'credential_required',
      source: 'local_tailscale_status', sampled_at: new Date(nowMs).toISOString() });
  }
  return { status: 'ok', candidates, truncated, sampled_at: new Date(nowMs).toISOString(),
    authorization: 'unchanged', source: 'local_tailscale_status' };
}

function createPeerDiscovery({ exec = execFile, now = Date.now, loadRegistered = () => ({}) } = {}) {
  let cached = null, cachedAt = 0, pending = null;
  return async function discover({ refresh = false } = {}) {
    if (!refresh && cached && now() - cachedAt < TTL_MS && now() >= cachedAt) return cached;
    if (pending) return pending;
    pending = new Promise(resolve => {
      exec('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 1500,
        maxBuffer: MAX_STATUS_BYTES, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
        let result;
        if (error) {
          result = { status: 'unavailable', reason: error.code === 'ENOENT' ? 'tool_not_found'
            : error.killed ? 'provider_timeout' : 'provider_failed', candidates: [], authorization: 'unchanged' };
        } else {
          try {
            if (Buffer.byteLength(stdout) > MAX_STATUS_BYTES) throw Error('status_too_large');
            result = parseCandidates(JSON.parse(stdout), loadRegistered(), now());
          } catch { result = { status: 'unavailable', reason: 'invalid_provider_status', candidates: [], authorization: 'unchanged' }; }
        }
        cached = result; cachedAt = now(); resolve(result);
      });
    });
    try { return await pending; } finally { pending = null; }
  };
}
module.exports = { createPeerDiscovery, parseCandidates, MAX_CANDIDATES, MAX_STATUS_BYTES };
