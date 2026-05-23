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

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
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

  // Non-semver values: fall back to string compare so dev/test tags still flow.
  if (cmp === null) {
    if (daemonVersion === cliVersion) {
      return { action: ACTIONS.NOOP, reason: 'versions-equal-nonsemver' };
    }
    return { action: ACTIONS.RESTART, reason: 'version-mismatch-nonsemver' };
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
