'use strict';
const net = require('node:net');
const dns = require('node:dns');
// One exact endpoint, one DNS result, one socket. No data or credentials are sent.
function probeTcp(endpoint, { timeoutMs = 1000, now = Date.now, monotonic = () => performance.now(),
  resolver = () => new dns.Resolver(), connect = options => net.createConnection(options), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const url = new URL(endpoint);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_probe_endpoint');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) throw new Error('invalid_tcp_timeout');
  const host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const started = monotonic();
  return new Promise(resolve => {
    let socket, lookup, settled = false;
    const finish = (status, phase, reason = null) => {
      if (settled) return; settled = true; clearTimer(timer); lookup?.cancel(); socket?.destroy();
      resolve({ status, phase, reason, source: 'client_dns_and_tcp_connect', observed_at: new Date(now()).toISOString(),
        elapsed_ms: Math.max(0, Math.round(monotonic() - started)), timeout_ms: timeoutMs,
        freshness: 'fresh_probe', attempts: 1, dns_family: net.isIP(host) || 'ipv4_only', agent_responsiveness: 'unknown', endpoint: { host, port } });
    };
    const timer = setTimer(() => finish('timeout', socket ? 'tcp_connect' : 'dns'), timeoutMs);
    function dial(address, family) {
      if (settled) return;
      try { socket = connect({ host: address, port, family }); socket.once('connect', () => finish('connected', 'tcp_connect'));
        socket.once('error', error => finish('unavailable', 'tcp_connect', error.code === 'ECONNREFUSED' ? 'connection_refused' : 'connection_failed')); }
      catch { finish('unavailable', 'tcp_connect', 'connection_failed'); }
    }
    if (net.isIP(host)) dial(host, net.isIP(host));
    else {
      // Dedicated resolver can cancel its work on timeout. No unbounded lookup queue or fallback scan.
      lookup = resolver();
      lookup.resolve4(host, (error, addresses) => {
        if (settled) return;
        if (error || !addresses?.length) finish('unavailable', 'dns', 'dns_ipv4_resolution_unavailable');
        else dial(addresses[0], 4);
      });
    }
  });
}
module.exports = { probeTcp };
