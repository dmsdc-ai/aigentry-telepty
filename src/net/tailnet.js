'use strict';

// Tailnet detection for seamless cross-machine (tailnet auto-bind + auto-trust).
// PURE + injectable: takes an os.networkInterfaces()-shaped object so the decision
// logic is unit-testable without a real tailnet. No subprocess (no `tailscale` CLI):
// the interface scan already yields the bind IP, and a child_process call would only
// add a PATH/exec failure mode + a command-injection surface. Article-17 fallback IS
// the scan itself.

const os = require('os');
const net = require('net');

// Tailscale assigns node IPs from the CGNAT range 100.64.0.0/10 (100.64.0.0 –
// 100.127.255.255). This is also the *effective trust CIDR* — safe only because the
// daemon binds the socket to the tailnet interface itself (see daemon.js), so only
// WireGuard-tunneled tailnet peers can reach it.
const TAILNET_CIDR = '100.64.0.0/10';

const _cgnat = new net.BlockList();
_cgnat.addSubnet('100.64.0.0', 10, 'ipv4');
function inTailnetRange(ip) {
  return typeof ip === 'string' && net.isIPv4(ip) && _cgnat.check(ip, 'ipv4');
}

// R1: 100.64.0.0/10 is ALSO the shared ISP-CGNAT range — a machine directly on ISP
// CGNAT (some VPS/direct-modem setups) can carry a 100.64.x address on a REAL,
// non-Tailscale interface. Binding+trusting that would expose :3848 to the ISP-CGNAT
// segment (other customers). The iface NAME (already a key in networkInterfaces())
// disambiguates at zero cost: prefer a Tailscale-named iface; fall back to range-only
// only when none is named, and flag that fallback so an operator can see + opt out.
const TAILSCALE_NAME = /tailscale|^utun/i; // tailscale0 (Linux) / utun* (macOS) / Tailscale adapter (Windows)

function isIPv4Addr(addr) {
  return addr && !addr.internal && (addr.family === 'IPv4' || addr.family === 4);
}

// Returns { ip, iface, nameMatched } for the tailnet interface, or null if none.
//   nameMatched=true  → iface name looked like Tailscale (high confidence)
//   nameMatched=false → range-only fallback (could be ISP-CGNAT; caller flags it)
function detectTailnet(interfaces = os.networkInterfaces()) {
  if (!interfaces || typeof interfaces !== 'object') return null;
  let rangeOnly = null; // first in-range candidate whose name did NOT match
  for (const iface of Object.keys(interfaces)) {
    const addrs = interfaces[iface];
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (!isIPv4Addr(addr) || !inTailnetRange(addr.address)) continue;
      if (TAILSCALE_NAME.test(iface)) {
        return { ip: addr.address, iface, nameMatched: true }; // name + range → done
      }
      if (!rangeOnly) rangeOnly = { ip: addr.address, iface, nameMatched: false };
    }
  }
  return rangeOnly; // range-only fallback, or null when no candidate at all
}

// Convenience for callers that only need the bind IP.
function detectTailnetIp(interfaces) {
  const d = detectTailnet(interfaces);
  return d ? d.ip : null;
}

module.exports = { detectTailnet, detectTailnetIp, inTailnetRange, TAILNET_CIDR };
