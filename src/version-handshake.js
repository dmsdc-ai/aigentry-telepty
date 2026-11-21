// src/version-handshake.js — pure-functional daemon/CLI version handshake policy.
//
// Fixes telepty#15 (auto-restart on daemon version mismatch) and task #400
// (mismatch-banner-on-stdout contaminates `telepty list --json | jq`).
//
// Decision policy (newer-wins; daemon-side EADDRINUSE health-probe already
// handles the symmetric case where a newer daemon refuses to clobber). Input
// is the daemon `/api/meta` response (or null when unreachable) plus the local
// CLI package version. Output is a stable action enum the caller maps to side
// effects (restart vs noop vs start). Pure → unit-testable without sockets.
//
// Constraints honored:
//   - Constitution §1 lightweight: ≤80 lines core logic, no deps.
//   - Constitution §2 cross-platform: pure JS, no OS calls.
//   - Constitution §17 무의존: no new npm dependencies.

'use strict';

const ACTIONS = Object.freeze({
  NOOP: 'noop',
  RESTART: 'restart',
  START: 'start'
});

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some(id => /^0\d+$/.test(id))) return null;
  return { core: match.slice(1, 4), prerelease };
}

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareIdentifier(a, b) {
  if (a === b) return 0;
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA !== numericB) return numericA ? -1 : 1;
  if (numericA && a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : 1;
}

function compareSemver(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const order = compareIdentifier(left.core[i], right.core[i]);
    if (order) return order;
  }
  const x = left.prerelease;
  const y = right.prerelease;
  if (!x.length || !y.length) return Math.sign(y.length - x.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = compareIdentifier(x[i], y[i]);
    if (order) return order;
  }
  return Math.sign(x.length - y.length);
}

function decideVersionAction(input) {
  const daemonVersion = input && input.daemonVersion;
  const cliVersion = input && input.cliVersion;

  // No daemon reachable → caller should start one (separate from restart).
  if (!daemonVersion) {
    return { action: ACTIONS.START, reason: 'daemon-unreachable' };
  }
  if (!cliVersion) {
    return { action: ACTIONS.NOOP, reason: 'cli-version-missing' };
  }

  const cmp = compareSemver(daemonVersion, cliVersion);

  if (cmp === null) {
    return { action: ACTIONS.NOOP, reason: daemonVersion === cliVersion ? 'versions-equal-nonsemver' : 'version-unknown' };
  }

  if (cmp === 0) {
    return { action: ACTIONS.NOOP, reason: 'versions-equal' };
  }
  if (cmp < 0) {
    // Daemon older than CLI → newer-wins, restart.
    return { action: ACTIONS.RESTART, reason: 'daemon-older' };
  }
  // Daemon newer than CLI → respect newer daemon; CLI talks via HTTP wire
  // protocol that is forward-compatible. No restart (avoid clobbering newer).
  return { action: ACTIONS.NOOP, reason: 'daemon-newer' };
}

module.exports = {
  ACTIONS,
  decideVersionAction,
  // Exported for tests + reuse by daemon-control.js port-owner probe.
  parseSemver,
  compareSemver
};
