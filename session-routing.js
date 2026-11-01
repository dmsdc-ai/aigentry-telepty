'use strict';

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

// Resolve only identities explicitly recorded by connect/connect-http. Never infer trust
// from DNS, a session advertisement, or a partial hostname match.
function resolveRegisteredPeerTarget(sessionRef, peers = {}) {
  const parsed = parseSessionReference(sessionRef);
  if (!parsed.id || !parsed.host) return null;
  const matches = Object.entries(peers).filter(([name, peer]) => {
    if (!peer || typeof peer !== 'object') return false;
    const host = typeof peer.host === 'string' && peer.host.includes(':') && !peer.host.startsWith('[') ? `[${peer.host}]` : peer.host;
    const endpoint = host && peer.port ? `${host}:${peer.port}` : null;
    return [name, peer.machineId, peer.host, endpoint, peer.target,
      peer.dnsName, peer.magicDnsName].some((alias) => typeof alias === 'string' && alias === parsed.host);
  });
  if (matches.length > 1) {
    throw new Error(`Peer '${parsed.host}' is ambiguous: ${matches.map(([name]) => name).sort().join(', ')}. Use a registered address:port.`);
  }
  if (matches.length === 0) return null;
  const [name, peer] = matches[0];
  if (peer.transport === 'http') {
    if (!peer.host || !peer.port) throw new Error(`Peer '${name}' has no registered HTTP endpoint.`);
    const host = peer.host.includes(':') && !peer.host.startsWith('[') ? `[${peer.host}]` : peer.host;
    return { id: parsed.id, host: `${host}:${peer.port}`, peerName: name, peerPort: peer.port };
  }
  if (!peer.transport || peer.transport === 'ssh') {
    return { id: parsed.id, host: peer.target, peerName: name, remote: true };
  }
  return null;
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

  if (matches.length === 1) {
    return matches[0];
  }

  const hosts = matches.map((session) => session.host).sort().join(', ');
  throw new Error(`Session '${parsed.id}' exists on multiple hosts: ${hosts}. Use <session_id>@<host> or set TELEPTY_HOST.`);
}

module.exports = {
  formatHostLabel,
  groupSessionsByHost,
  parseSessionReference,
  pickSessionTarget,
  resolveRegisteredPeerTarget
};
