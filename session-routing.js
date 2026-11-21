'use strict';

const os = require('node:os');
const { lookup } = require('node:dns').promises;
const { isIP } = require('node:net');
const { parseHostSpec, formatHostForUrl } = require('./host-spec');

function routingError(code, message) {
  return Object.assign(new Error(message), { code });
}

function addressKey(host) {
  if (!isIP(host)) return host.toLowerCase().replace(/\.$/, '');
  if (isIP(host) === 4) return host;
  return new URL('http://' + formatHostForUrl(host.split('%')[0])).hostname;
}

function isLocalAddress(locator, port, { hostname = os.hostname(), interfaces = os.networkInterfaces } = {}) {
  const spec = parseHostSpec(locator, port);
  if (spec.port !== port) return false;
  const key = addressKey(spec.host);
  if (key === 'localhost' || key === addressKey(hostname)
    || key === '[::1]' || (isIP(key) === 4 && key.startsWith('127.'))) return true;
  return Boolean(isIP(spec.host)) && Object.values(interfaces()).some((entries) =>
    entries?.some(({ address }) => addressKey(address) === key));
}

function formatHostLabel(host) {
  return host === '127.0.0.1' ? 'Local' : host;
}

function parseSessionReference(sessionRef) {
  const value = String(sessionRef || '').trim();
  const atIndex = value.lastIndexOf('@');

  if (atIndex <= 0 || atIndex === value.length - 1) {
    return { id: value, host: null };
  }

  return {
    id: value.slice(0, atIndex),
    host: value.slice(atIndex + 1)
  };
}

function peerTarget(parsed, matches) {
  if (matches.length > 1) {
    throw routingError('AMBIGUOUS_PEER', `Peer '${parsed.host}' is ambiguous: ${matches.map(([name]) => name).sort().join(', ')}. Use a registered address:port.`);
  }
  if (matches.length === 0) return null;
  const [name, peer] = matches[0];
  if (peer.transport === 'http') {
    if (!peer.host || !peer.port) throw routingError('PEER_ENDPOINT_MISSING', `Peer '${name}' has no registered HTTP endpoint.`);
    return { id: parsed.id, host: `${formatHostForUrl(peer.host)}:${peer.port}`, peerName: name, peerPort: peer.port };
  }
  if (!peer.transport || peer.transport === 'ssh') {
    return { id: parsed.id, host: peer.target, peerName: name, remote: true };
  }
  return null;
}

function peerHost(peer) {
  if (typeof peer.host === 'string' && peer.host) return peer.host;
  if ((!peer.transport || peer.transport === 'ssh') && typeof peer.target === 'string') return peer.target.split('@').pop();
  return null;
}

// Keep the endpoint and credential lane from registration.
function resolveRegisteredPeerTarget(sessionRef, peers = {}) {
  const parsed = parseSessionReference(sessionRef);
  if (!parsed.id || !parsed.host) return null;
  const matches = Object.entries(peers).filter(([name, peer]) => {
    if (!peer || typeof peer !== 'object') return false;
    const host = peerHost(peer);
    const port = peer.port || ((!peer.transport || peer.transport === 'ssh') ? 22 : null);
    const endpoint = host && port ? `${formatHostForUrl(host)}:${port}` : null;
    return [name, peer.machineId, host, endpoint, peer.target,
      peer.dnsName, peer.magicDnsName].some((alias) => typeof alias === 'string' && alias === parsed.host);
  });
  return peerTarget(parsed, matches);
}

async function resolvePeerAddress(id, locator, peers, { lookupAddress = lookup, timeoutMs = 1000 } = {}) {
  const { host, port } = parseHostSpec(locator, null);
  if (!isIP(host)) return null;

  const lookups = new Map();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(routingError('PEER_DNS_TIMEOUT', 'lookup timed out')), timeoutMs);
  });
  try {
    const candidates = Object.entries(peers).filter(([, peer]) => peer && (!peer.transport || ['ssh', 'http'].includes(peer.transport)) &&
      (port === null || port === (peer.port || (peer.transport === 'http' ? null : 22))));
    const results = await Promise.all(candidates.map(async (entry) => {
      const [name, peer] = entry;
      const recorded = peerHost(peer);
      if (!recorded) return {};
      const { host: registered } = parseHostSpec(recorded);
      if (isIP(registered)) return { match: addressKey(registered) === addressKey(host) ? entry : null };
      if (!lookups.has(registered)) {
        lookups.set(registered, Promise.race([
          Promise.resolve().then(() => lookupAddress(registered, { all: true })),
          deadline
        ]));
      }
      try {
        const addresses = await lookups.get(registered);
        return { match: addresses.some(({ address }) => addressKey(address) === addressKey(host)) ? entry : null };
      } catch (error) {
        return { failure: `${name} (${registered}): ${error.code || 'lookup failed'}` };
      }
    }));
    const match = peerTarget({ id, host: locator }, results.map(({ match }) => match).filter(Boolean));
    if (match) return match;
    const failures = results.map(({ failure }) => failure).filter(Boolean).sort();
    if (failures.length) {
      throw routingError('PEER_DNS_FAILED', `Could not match '${locator}' to a registered peer. Address lookup failed for ${failures.join(', ')}.`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function groupSessionsByHost(sessions) {
  const grouped = new Map();

  for (const session of sessions) {
    if (!grouped.has(session.host)) {
      grouped.set(session.host, []);
    }
    grouped.get(session.host).push(session);
  }

  return grouped;
}

function pickSessionTarget(sessionRef, sessions, defaultHost = '127.0.0.1') {
  const parsed = parseSessionReference(sessionRef);
  if (!parsed.id) {
    return null;
  }

  if (parsed.host) {
    // Match by host or by peerName alias (e.g. `sid@winserver` where
    // winserver is the SSH peer name and session.host is `user@FQDN`). #411
    const exactMatch = sessions.find((session) =>
      session.id === parsed.id &&
      (session.host === parsed.host || session.peerName === parsed.host)
    );
    return exactMatch || { id: parsed.id, host: parsed.host };
  }

  if (defaultHost && defaultHost !== '127.0.0.1') {
    const defaultMatch = sessions.find((session) => session.id === parsed.id && session.host === defaultHost);
    return defaultMatch || { id: parsed.id, host: defaultHost };
  }

  const matches = sessions.filter((session) => session.id === parsed.id);

  if (matches.length === 0) {
    // Project-based fallback: match sessions whose ID starts with the requested prefix.
    // e.g., "aigentry-dustcraw" matches "aigentry-dustcraw-001" or "aigentry-dustcraw-claude".
    const prefixMatches = sessions.filter((s) =>
      s.id.startsWith(parsed.id + '-') || s.id.startsWith(parsed.id)
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }
    if (prefixMatches.length > 1) {
      // Multiple candidates: prefer same host, then first alphabetically
      const local = prefixMatches.find((s) => s.host === '127.0.0.1');
      const best = local || prefixMatches.sort((a, b) => a.id.localeCompare(b.id))[0];
      return best;
    }
    return null;
  }

  const local = matches.find((session) => session.host === '127.0.0.1');
  if (local) return local;

  if (matches.length === 1) {
    return matches[0];
  }

  const hosts = matches.map((session) => session.host).sort().join(', ');
  throw routingError('AMBIGUOUS_SESSION', `Session '${parsed.id}' exists on multiple hosts: ${hosts}. Use <session_id>@<host> or set TELEPTY_HOST.`);
}

module.exports = {
  formatHostLabel,
  isLocalAddress,
  resolvePeerAddress,
  routingError,
  groupSessionsByHost,
  parseSessionReference,
  pickSessionTarget,
  resolveRegisteredPeerTarget
};
