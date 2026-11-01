'use strict';
const { createPrincipalClient, loadPrincipalClientConfiguration } = require('./client');
const { resolveAction } = require('./http');
const { readResponse } = require('../broker/http');
const failure = suffix => Object.assign(new Error('Principal readiness inspection failed'), { code: 'PRINCIPAL_READINESS_' + suffix });
function timestamp(value) {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
async function runPrincipalReadiness(parameters, { signal } = {}) {
  if (parameters.length !== 6 || parameters[0] !== '--config' || parameters[2] !== '--session' || parameters[4] !== '--epoch') throw failure('USAGE');
  const [, file, , id, , epoch] = parameters;
  if (typeof id !== 'string' || typeof epoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(epoch)) throw failure('TARGET_INVALID');
  const target = '/api/sessions/' + encodeURIComponent(id) + '/handshake?timeout_ms=0&session_epoch=' + encodeURIComponent(epoch);
  if (resolveAction({ method: 'GET', url: target })?.target !== id) throw failure('TARGET_INVALID');
  if (signal?.aborted) throw failure('CANCELLED');
  let response;
  try {
    const client = createPrincipalClient(loadPrincipalClientConfiguration(file));
    response = await client.request({ method: 'GET', target, action: 'session.inspect', sessionEpoch: epoch, signal });
  } catch { throw failure(signal?.aborted ? 'CANCELLED' : 'REQUEST_FAILED'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw failure('REFUSED');
  }
  let result;
  try { result = await readResponse(response, 16 * 1024); }
  catch { throw failure(signal?.aborted ? 'CANCELLED' : 'RESPONSE_INVALID'); }
  if (signal?.aborted) throw failure('CANCELLED');
  if (!result || result.schema !== 'telepty.readiness/v1' || result.session_id !== id || result.session_epoch !== epoch
      || typeof result.ready !== 'boolean' || !['ready', 'unknown', 'unsupported', 'blocked', 'disconnected'].includes(result.status)
      || result.ready !== (result.status === 'ready') || !/^[a-z][a-z0-9_]{0,95}$/.test(result.reason || '')
      || result.completion_fact !== null || result.terminal !== false || !timestamp(result.sampled_at)
      || (result.observed_at !== null && !timestamp(result.observed_at)) || (result.ready && result.observed_at === null)) throw failure('RESPONSE_INVALID');
  return { schema: 'telepty.readiness/v1', session_id: id, session_epoch: epoch, ready: result.ready,
    status: result.status, reason: result.reason, observed_at: result.observed_at, sampled_at: result.sampled_at,
    completion_fact: null, terminal: false, consumption: 'unknown', reply: 'unknown',
    authentication_observation: 'signed_request_http_2xx', authenticated_registration: 'unverified' };
}
module.exports = { runPrincipalReadiness };
