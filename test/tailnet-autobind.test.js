'use strict';

// #672 — seamless cross-machine (tailnet auto-bind + auto-trust). Unit tests for the
// PURE decision functions: detection (with R1 name-preference), bind host, auto-trust
// allowlist, and the startup banner. No live bind, no tailnet required — real multi-node
// validation is orchestrator task #672. The daemon fns are required WITHOUT starting the
// daemon (require.main !== module and AIGENTRY_TELEPTY_DAEMON_MAIN unset).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectTailnet, detectTailnetIp, inTailnetRange, TAILNET_CIDR } = require('../src/net/tailnet');
const {
  resolveBindHost,
  formatBindHint,
  isTailnetAuto,
  resolveEffectivePeerAllowlist
} = require('../daemon');

// helper: build an os.networkInterfaces()-shaped object
function ifaces(map) {
  const out = {};
  for (const [name, addr] of Object.entries(map)) {
    out[name] = [{ address: addr, family: 'IPv4', internal: false }];
  }
  return out;
}

// ── detection: R1 name-preference + range fallback ─────────────────────────────

test('detectTailnet: utun3 + 100.72.x → detected, nameMatched (macOS)', () => {
  const d = detectTailnet(ifaces({ en0: '192.168.1.10', utun3: '100.72.155.21' }));
  assert.deepEqual(d, { ip: '100.72.155.21', iface: 'utun3', nameMatched: true });
});

test('detectTailnet: tailscale0 + 100.72.x → detected, nameMatched (Linux)', () => {
  const d = detectTailnet(ifaces({ eth0: '10.0.0.5', tailscale0: '100.72.9.9' }));
  assert.deepEqual(d, { ip: '100.72.9.9', iface: 'tailscale0', nameMatched: true });
});

test('detectTailnet: Windows adapter name containing Tailscale → detected, nameMatched', () => {
  const d = detectTailnet(ifaces({ Ethernet: '192.168.0.4', 'Tailscale': '100.100.0.7' }));
  assert.deepEqual(d, { ip: '100.100.0.7', iface: 'Tailscale', nameMatched: true });
});

test('R1: eth0 + 100.72.x (ISP-CGNAT lookalike) → NOT name-preferred, range-only flagged', () => {
  const d = detectTailnet(ifaces({ eth0: '100.72.4.4' }));
  assert.deepEqual(d, { ip: '100.72.4.4', iface: 'eth0', nameMatched: false });
});

test('R1: a Tailscale-named in-range iface WINS over a range-only lookalike', () => {
  // eth0 lookalike appears first, but the tailscale0 candidate must be preferred.
  const d = detectTailnet(ifaces({ eth0: '100.72.4.4', tailscale0: '100.80.1.1' }));
  assert.equal(d.iface, 'tailscale0');
  assert.equal(d.nameMatched, true);
});

test('detectTailnet: multiple utun*, only the in-range one wins (macOS)', () => {
  const d = detectTailnet(ifaces({ utun0: '10.1.2.3', utun4: '169.254.0.1', utun6: '100.90.0.1' }));
  assert.deepEqual(d, { ip: '100.90.0.1', iface: 'utun6', nameMatched: true });
});

test('detectTailnet: no CGNAT address anywhere → null', () => {
  assert.equal(detectTailnet(ifaces({ en0: '192.168.1.10', eth0: '10.0.0.5' })), null);
});

test('detectTailnet: ignores internal/loopback and IPv6', () => {
  const input = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    utun6: [{ address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false },
            { address: '100.72.0.5', family: 'IPv4', internal: false }]
  };
  assert.deepEqual(detectTailnet(input), { ip: '100.72.0.5', iface: 'utun6', nameMatched: true });
});

test('detectTailnet: 100.128.x is OUTSIDE 100.64.0.0/10 → not detected', () => {
  assert.equal(detectTailnet(ifaces({ utun3: '100.128.0.1' })), null);
  assert.equal(inTailnetRange('100.128.0.1'), false);
  assert.equal(inTailnetRange('100.127.255.255'), true); // top of /10
  assert.equal(inTailnetRange('100.64.0.0'), true);      // bottom of /10
});

test('detectTailnet: malformed / empty input → null (non-fatal)', () => {
  assert.equal(detectTailnet(null), null);
  assert.equal(detectTailnet({}), null);
  assert.equal(detectTailnet({ weird: 'not-an-array' }), null);
});

// ── D1: IP is discovered live every run, never carried over ─────────────────────

test('D1: two runs with different injected interfaces → each run binds its own live IP', () => {
  const run1 = detectTailnetIp(ifaces({ utun6: '100.72.155.21' }));
  const run2 = detectTailnetIp(ifaces({ utun6: '100.88.0.42' })); // Tailscale reassigned
  assert.equal(run1, '100.72.155.21');
  assert.equal(run2, '100.88.0.42');
  assert.notEqual(run1, run2); // no carry-over — the second run followed the new IP
  assert.equal(resolveBindHost({}, run2), '100.88.0.42');
});

// ── bind host policy (extends #50; 1-arg legacy calls unchanged) ────────────────

test('resolveBindHost: no tailnet arg → #50 default loopback (legacy unchanged)', () => {
  assert.equal(resolveBindHost({}), '127.0.0.1');
  assert.equal(resolveBindHost({ TELEPTY_BIND: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveBindHost({ HOST: '10.0.0.5' }), '10.0.0.5');
});

test('resolveBindHost: detected tailnet, no override → binds the tailnet IP', () => {
  assert.equal(resolveBindHost({}, '100.72.155.21'), '100.72.155.21');
});

test('resolveBindHost: manual TELEPTY_BIND / HOST win over tailnet auto', () => {
  assert.equal(resolveBindHost({ TELEPTY_BIND: '0.0.0.0' }, '100.72.155.21'), '0.0.0.0');
  assert.equal(resolveBindHost({ HOST: '10.0.0.5' }, '100.72.155.21'), '10.0.0.5');
});

test('resolveBindHost: TELEPTY_NO_TAILNET_AUTO=1 forces loopback even on a tailnet', () => {
  assert.equal(resolveBindHost({ TELEPTY_NO_TAILNET_AUTO: '1' }, '100.72.155.21'), '127.0.0.1');
});

test('resolveBindHost: no tailnet detected (null) → loopback (#50 preserved)', () => {
  assert.equal(resolveBindHost({}, null), '127.0.0.1');
});

test('isTailnetAuto: true only with tailnet IP + no override + not opted out', () => {
  assert.equal(isTailnetAuto({}, '100.72.0.1'), true);
  assert.equal(isTailnetAuto({}, null), false);
  assert.equal(isTailnetAuto({ TELEPTY_BIND: '0.0.0.0' }, '100.72.0.1'), false);
  assert.equal(isTailnetAuto({ HOST: '10.0.0.5' }, '100.72.0.1'), false);
  assert.equal(isTailnetAuto({ TELEPTY_NO_TAILNET_AUTO: '1' }, '100.72.0.1'), false);
  assert.equal(isTailnetAuto({ TELEPTY_NO_TAILNET_AUTO: '0' }, '100.72.0.1'), true); // falsey literal → not opted out
});

// ── auto-trust allowlist (Q2/Q3): tighten, never widen ──────────────────────────

test('resolveEffectivePeerAllowlist: auto + empty manual → trust the tailnet CIDR', () => {
  assert.deepEqual(resolveEffectivePeerAllowlist([], true), [TAILNET_CIDR]);
});

test('resolveEffectivePeerAllowlist: auto + manual set → respect manual, do NOT widen', () => {
  assert.deepEqual(resolveEffectivePeerAllowlist(['100.72.9.9'], true), ['100.72.9.9']);
});

test('resolveEffectivePeerAllowlist: not auto → allowlist unchanged (no auto-trust)', () => {
  assert.deepEqual(resolveEffectivePeerAllowlist([], false), []);
  assert.deepEqual(resolveEffectivePeerAllowlist(['1.2.3.4'], false), ['1.2.3.4']);
});

// ── banner ──────────────────────────────────────────────────────────────────────

test('formatBindHint: tailnet (nameMatched) → tailnet-only posture, no range note', () => {
  const hint = formatBindHint('100.72.155.21', { ip: '100.72.155.21', iface: 'utun6', nameMatched: true });
  assert.match(hint, /tailnet auto/);
  assert.match(hint, /Tailnet only/);
  assert.match(hint, /LAN\/public closed/);
  assert.match(hint, /loopback also served/);
  assert.doesNotMatch(hint, /range only/);
});

test('formatBindHint: range-only tailnet → ISP-CGNAT caution + opt-out hint (R1)', () => {
  const hint = formatBindHint('100.72.4.4', { ip: '100.72.4.4', iface: 'eth0', nameMatched: false });
  assert.match(hint, /range only/);
  assert.match(hint, /TELEPTY_NO_TAILNET_AUTO=1/);
});

test('formatBindHint: loopback keeps #50 hint AND states cross-machine needs Tailscale (G2)', () => {
  const hint = formatBindHint('127.0.0.1');
  assert.match(hint, /loopback only/);           // #50 line preserved
  assert.match(hint, /TELEPTY_BIND=0\.0\.0\.0/); // #50 opt-in preserved
  assert.match(hint, /needs Tailscale/);         // G2 line added
});

test('formatBindHint: explicit network bind unchanged', () => {
  assert.match(formatBindHint('0.0.0.0'), /reachable from the network/);
});
