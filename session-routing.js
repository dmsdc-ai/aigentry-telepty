'use strict';

const { isIP } = require('net');
const { parseHostSpec } = require('./host-spec');

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
  return registeredPeerTarget(parsed.id, name, peer);
}

function registeredPeerTarget(id, name, peer) {
  const parsed = { id };
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
  // #1288: the code lets a --json caller print this refusal as a document; the text is unchanged.
  throw Object.assign(new Error(`Session '${parsed.id}' exists on multiple hosts: ${hosts}. Use <session_id>@<host> or set TELEPTY_HOST.`),
    { code: 'AMBIGUOUS_SESSION' });
}

// #1288 (FACT C): is `name` this machine's own name? Case-insensitive, because Windows reports
// upper-case host names. The caller decides precedence: a registered peer always wins (F5).
function isLocalMachineName(name, localNames = []) {
  if (typeof name !== 'string' || !name) return false;
  const wanted = name.toLowerCase();
  return localNames.some((local) => typeof local === 'string' && local !== '' && local.toLowerCase() === wanted);
}

// #1288 (F5): does any registered peer use `name` as its name, machine id or host, ignoring case?
// A local-name match must never shadow such a peer, not even one that differs only in case.
function registeredPeerUsesName(name, peers = {}) {
  const wanted = String(name || '').toLowerCase();
  return Object.entries(peers).some(([peerName, peer]) => [peerName, peer && peer.machineId, peer && peer.host]
    .some((alias) => typeof alias === 'string' && alias.toLowerCase() === wanted));
}

const PEER_ADDRESS_LOOKUP_MS = 1000;

function ipAddressKey(address) {
  return String(address || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
}

// #1288 (FACT D): `<id>@<ip>[:port]` names a peer that was registered by HOSTNAME when that
// hostname resolves to the address. Only an IP-literal qualifier that matched no registered alias
// reaches here, and only peers registered by name are looked up — so a host without peers never
// performs a lookup. The registered endpoint and its stored credential are what is returned, never
// the typed address. A lookup that fails or misses the deadline is "no match" (F3): the caller then
// takes exactly the path it took before this function existed. Two matching peers are refused.
async function resolvePeerByAddress(sessionRef, peers = {}, options = {}) {
  const parsed = parseSessionReference(sessionRef);
  if (!parsed.id || !parsed.host) return null;
  const spec = parseHostSpec(parsed.host, null);
  const address = ipAddressKey(spec.host);
  if (!isIP(address)) return null;
  const candidates = [];
  for (const [name, peer] of Object.entries(peers)) {
    if (!peer || typeof peer !== 'object') continue;
    let host = null;
    if (peer.transport === 'http') {
      if (spec.port !== null && Number(peer.port) !== spec.port) continue;
      host = peer.host;
    } else if (!peer.transport || peer.transport === 'ssh') {
      if (spec.port !== null || typeof peer.target !== 'string') continue;
      host = peer.target.split('@').pop();
    }
    if (typeof host !== 'string' || !host || isIP(ipAddressKey(host))) continue;
    candidates.push({ name, peer, host });
  }
  if (candidates.length === 0) return null;
  const lookup = options.lookup || ((host, lookupOptions) => require('dns').promises.lookup(host, lookupOptions));
  const timeoutMs = options.timeoutMs || PEER_ADDRESS_LOOKUP_MS;
  const answers = new Map();
  for (const { host } of candidates) {
    const key = host.toLowerCase();
    if (answers.has(key)) continue;
    answers.set(key, new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), timeoutMs);
      Promise.resolve()
        .then(() => lookup(host, { all: true }))
        .then((found) => resolve(Array.isArray(found) ? found.map((entry) => ipAddressKey(entry && entry.address)) : []),
          () => resolve([]))
        .finally(() => clearTimeout(timer));
    }));
  }
  const matches = [];
  for (const candidate of candidates) {
    if ((await answers.get(candidate.host.toLowerCase())).includes(address)) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new Error(`Peer '${parsed.host}' is ambiguous: ${matches.map(({ name }) => name).sort().join(', ')}. Use the registered peer name.`);
  }
  if (matches.length === 0) return null;
  return registeredPeerTarget(parsed.id, matches[0].name, matches[0].peer);
}

module.exports = {
  formatHostLabel,
  groupSessionsByHost,
  isLocalMachineName,
  parseSessionReference,
  pickSessionTarget,
  registeredPeerUsesName,
  resolvePeerByAddress,
  resolveRegisteredPeerTarget
};
