'use strict';
const { MAX_WAIT_MS } = require('../readiness');
const { parseSessionReference } = require('../../session-routing');

async function runReadinessCommand(command, argv, { remoteHost, daemonUrl, fetchWithAuth, print = console.log }) {
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
    const url = `${daemonUrl(parsed.host || remoteHost)}/api/sessions/${encodeURIComponent(parsed.id)}/handshake?timeout_ms=${timeoutMs}`;
    const response = await fetchWithAuth(url, { method: 'GET', readOnlyAuth: true, signal: AbortSignal.timeout(timeoutMs + 1500) });
    const result = await response.json();
    print(json ? JSON.stringify(result) : `${result.session_id || parsed.id}: ${result.status} (${result.reason})`);
    return response.ok && (command === 'readiness' || result.ready === true) ? 0 : 1;
  } catch (error) {
    print(json ? JSON.stringify({ ready: false, status: 'error', reason: error.message }) : error.message);
    return 1;
  }
}
module.exports = { runReadinessCommand };
