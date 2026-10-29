'use strict';
const { parseSessionReference } = require('../../session-routing');
async function boundedJson(response, maxBytes = 32768) {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('response_budget_exceeded');
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
async function diagnoseTarget(target, { fetchWithAuth, daemonUrl, timeoutMs = 2000, machineId, sessionEpoch,
  now = Date.now, monotonic = () => performance.now() }) {
  const parsed = parseSessionReference(target);
  if (!parsed.host || !parsed.id || parsed.id.length > 256 || parsed.host.length > 256) throw new Error('diagnose requires an exact session_id@host');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('timeout must be 1..5000ms per request');
  const started = monotonic(), observed = new Date(now()).toISOString();
  const failure = (status, phase, httpStatus = null) => ({ schema_version: 1, observed_at: observed, read_only: true,
    target: { session_id: parsed.id, host: parsed.host }, identity: null,
    layers: { host_network: { status: httpStatus ? 'http_path_responded' : 'unknown', reason: 'no_independent_host_or_tcp_probe' },
      daemon_api: { status, phase, http_status: httpStatus, elapsed_ms: Math.max(0, Math.round(monotonic() - started)), source: 'client_http_probe' },
      authentication: { status: httpStatus === 401 || httpStatus === 403 ? 'refused' : status === 'credentials_unavailable' ? 'unavailable' : 'unknown' },
      agent_responsiveness: { status: 'unknown', reason: 'daemon_probe_does_not_probe_agent' } },
    confirmed_causes: [], completion_fact: null, next_read_only_observation: 'Verify the exact configured host and existing credentials; repeat the read-only probe.' });
  let phase = 'meta';
  try {
    const base = daemonUrl(parsed.host);
    const response = await fetchWithAuth(`${base}/api/meta`, { signal: AbortSignal.timeout(timeoutMs), readOnlyAuth: true });
    if (!response.ok) return failure(response.status === 401 || response.status === 403 ? 'authentication_refused' : 'http_error', phase, response.status);
    const meta = await boundedJson(response);
    if (typeof meta.machine_id !== 'string' || (machineId && meta.machine_id !== machineId)) return failure('machine_mismatch', phase, response.status);
    phase = 'session';
    const query = new URLSearchParams({ machine_id: meta.machine_id });
    if (sessionEpoch) query.set('session_epoch', sessionEpoch);
    const result = await fetchWithAuth(`${base}/api/sessions/${encodeURIComponent(parsed.id)}/diagnostics?${query}`, { signal: AbortSignal.timeout(timeoutMs), readOnlyAuth: true });
    if (!result.ok) return failure(result.status === 409 ? 'identity_mismatch' : result.status === 401 || result.status === 403 ? 'authentication_refused' : result.status === 404 ? 'not_registered' : 'http_error', phase, result.status);
    const report = await boundedJson(result);
    if (report?.identity?.machine_id !== meta.machine_id || report?.identity?.session_id !== parsed.id || (sessionEpoch && report.identity.session_epoch !== sessionEpoch)) return failure('identity_mismatch', phase, result.status);
    report.target = { host: parsed.host, session_id: parsed.id };
    report.client_probe = { source: 'authenticated_http_requests', observed_at: new Date(now()).toISOString(),
      elapsed_ms: Math.max(0, Math.round(monotonic() - started)), timeout_ms_per_request: timeoutMs,
      requests: 2, host_network: 'http_path_responded', authentication: 'accepted',
      mcp_transport: 'not_measured', agent_responsiveness: 'unknown' };
    return report;
  } catch (error) { return failure(error.code === 'TELEPTY_CONFIG_UNREADABLE' || error.name === 'CredentialRefusalError'
    ? 'credentials_unavailable' : ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'unavailable', phase); }
}
function formatDiagnostics(report) {
  // The human view intentionally preserves the exact structured evidence and uncertainty.
  return `Read-only layered diagnostics\n${JSON.stringify(report, null, 2)}`;
}
module.exports = { diagnoseTarget, boundedJson, formatDiagnostics };
