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
    const exactMatch = sessions.find((session) => session.id === parsed.id && session.host === parsed.host);
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
  pickSessionTarget
};
