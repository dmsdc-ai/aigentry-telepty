'use strict';
const { MAX_WAIT_MS } = require('../readiness');
const { parseSessionReference, routingError } = require('../../session-routing');

async function runReadinessCommand(command, argv, { remoteHost, daemonUrl, fetchWithAuth, resolveAddress, print = console.log, errorOutput = console.error }) {
  const json = argv.includes('--json');
  try {
    const args = argv.filter(a => a !== '--json');
    const target = args.shift();
    let timeoutMs = command === 'wait-ready' ? 10000 : 0;
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--timeout-ms' || !/^\d+$/.test(args[1]) || Number(args[1]) > MAX_WAIT_MS) {
        throw new Error('Usage: telepty readiness|wait-ready <exact-id>[@host] [--timeout-ms 0..30000] [--json]');
      }
      timeoutMs = Number(args[1]);
    }
    if (!target || target.startsWith('-')) throw new Error('An exact session id is required.');
    const parsed = parseSessionReference(target);
    // Read the explicitly addressed daemon only. Never discover, restart, alias-match or mutate.
    const address = resolveAddress ? await resolveAddress(target) : { host: parsed.host || remoteHost };
    if (address.remote) throw routingError('UNSUPPORTED_SESSION_TRANSPORT', 'Readiness requires an HTTP daemon endpoint.');
    const url = `${daemonUrl(address.host)}/api/sessions/${encodeURIComponent(parsed.id)}/handshake?timeout_ms=${timeoutMs}`;
    const response = await fetchWithAuth(url, { method: 'GET', readOnlyAuth: true, signal: AbortSignal.timeout(timeoutMs + 1500) });
    const result = await response.json();
    if (!response.ok) throw routingError(result.code || 'READINESS_REQUEST_REFUSED', result.reason || result.error);
    const ready = command === 'readiness' || result.ready === true;
    const view = ready ? result : { ...result, code: 'SESSION_NOT_READY' };
    print(json ? JSON.stringify(view) : `${result.session_id || parsed.id}: ${result.status} (${result.reason})`);
    return ready ? 0 : 1;
  } catch (error) {
    if (json) print(JSON.stringify({ ready: false, status: 'error', code: error.code || 'READINESS_REQUEST_FAILED', reason: error.message }));
    errorOutput(error.message);
    return 1;
  }
}
module.exports = { runReadinessCommand };
