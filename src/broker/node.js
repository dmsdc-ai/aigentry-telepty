'use strict';
const { createPrincipalVerifier, validateTrustConfiguration } = require('../principal/proof');
const { bodyDigest, parseUnambiguousJSON } = require('../principal/encoding');
const { id, error, origin, readResponse, assertion, combineAbortSignals } = require('./http');
const { ACTIONS } = require('./hub');
const { validateForwardBody } = require('../peer-forwarding');

function createBrokerClient({ config, privateKey, fetch: send = globalThis.fetch } = {}) {
  if (!config || !id(config.principal_id) || !id(config.key_id) || typeof config.hub_audience !== 'string') throw error('BROKER_CONFIG_INVALID');
  const hub = origin(config.hub_url);
  async function challenge() {
    const response = await send(`${hub}/v1/challenge`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw error('BROKER_CHALLENGE_FAILED', 502);
    const value = await readResponse(response);
    if (value.schema !== 'telepty.broker-challenge/v1' || value.audience !== config.hub_audience
      || !/^[A-Za-z0-9_-]{16,128}$/.test(value.challenge || '')) throw error('BROKER_CHALLENGE_INVALID', 502);
    return value.challenge;
  }
  async function request(method, target, body, action, { sessionEpoch, signal, stream = false } = {}) {
    const current = await challenge();
    const proof = assertion(config, privateKey, current, method, target, body, action, sessionEpoch);
    const response = await send(`${hub}${target}`, { method, redirect: 'error',
      signal: stream ? (signal || AbortSignal.timeout(10000))
        : combineAbortSignals([...(signal ? [signal] : []), AbortSignal.timeout(10000)]), headers: { 'content-type': 'application/json', 'x-telepty-assertion': proof },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    if (stream) { if (!response.ok) throw error('BROKER_STREAM_REFUSED', response.status); return response; }
    return { status: response.status, body: await readResponse(response) };
  }
  return { request,
    inject(node, sid, body) {
      if (!id(node)) throw error('BROKER_NODE_INVALID');
      return request('POST', `/v1/nodes/${config.principal_id}/to/${node}/sessions/${encodeURIComponent(sid)}/inject`,
        body, 'broker.inject', { sessionEpoch: body.expected_epoch });
    },
    receipt(key) {
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw error('BROKER_KEY_INVALID');
      return request('GET', `/v1/nodes/${config.principal_id}/receipts/${key}`, {}, 'broker.receipt');
    }
  };
}

function createBrokerNode({ config, privateKey, localToken, fetch: send = globalThis.fetch } = {}) {
  if (!config || config.schema !== 'telepty.broker-node/v1' || !id(config.principal_id)
    || !id(config.hub_principal_id) || typeof localToken !== 'string' || !localToken
    || !Number.isInteger(config.local_timeout_ms) || config.local_timeout_ms < 100 || config.local_timeout_ms > 10000) throw error('BROKER_CONFIG_INVALID');
  const local = origin(config.local_daemon_url, true);
  const trust = validateTrustConfiguration(config.hub_trust, { audience: config.audience, allowedActions: ACTIONS });
  // This trust file pins only the hub's key(s), with exact source-node/session grants.
  for (const key of trust.keys.values()) if (key.id !== config.hub_principal_id) throw error('BROKER_HUB_PIN_INVALID');
  const verifier = createPrincipalVerifier({ trust });
  const client = createBrokerClient({ config, privateKey, fetch: send });
  const stop = new AbortController();
  let completion;
  async function handle(frame) {
    const value = parseUnambiguousJSON(frame);
    const envelope = value.envelope;
    if (!envelope || envelope.schema !== 'telepty.broker-envelope/v1' || envelope.target_node !== config.principal_id
      || !id(envelope.source_node) || envelope.hop !== 1 || envelope.foreign_session_identity_verified !== false
      || !/^[a-f0-9]{64}$/.test(envelope.receipt_id || '') || typeof envelope.session !== 'string'
      || !envelope.payload || typeof envelope.payload.expected_epoch !== 'string') throw error('BROKER_ENVELOPE_INVALID');
    const payload = validateForwardBody({ ...envelope.payload, idempotency_key: envelope.receipt_id });
    const proof = verifier.verify(value.assertion, { method: 'EVENT', target: `/v1/envelopes/${envelope.receipt_id}`,
      bodySha256: bodyDigest(envelope), action: 'broker.envelope', grantTarget: `${envelope.source_node}/${envelope.session}`,
      sessionEpoch: envelope.payload.expected_epoch, transport: 'http' });
    if (!proof.ok) throw error(proof.code, proof.status);
    let result;
    try {
      const response = await send(`${local}/api/forwarded/sessions/${encodeURIComponent(envelope.session)}/inject`, {
        method: 'POST', redirect: 'error', signal: combineAbortSignals([stop.signal, AbortSignal.timeout(config.local_timeout_ms)]),
        headers: { 'content-type': 'application/json', 'x-telepty-token': localToken },
        body: JSON.stringify({ ...payload, exact_target: true, claimed_cross_host: true,
          forwarding: { hop: 1, key: envelope.receipt_id } })
      });
      const receipt = await readResponse(response);
      if (response.ok && receipt.success === true && typeof receipt.inject_id === 'string'
        && receipt.session_id === envelope.session && receipt.exact_target === true) {
        result = { state: 'accepted', inject_id: receipt.inject_id, queued: receipt.queued === true || receipt.bootstrap_queued === true };
      } else result = { state: response.ok || response.status >= 500
        || ['FORWARD_OUTCOME_UNKNOWN', 'FORWARD_STORAGE_UNAVAILABLE'].includes(receipt.code) ? 'outcome_unknown' : 'failed',
        code: 'BROKER_LOCAL_INJECT_REFUSED' };
    } catch { result = { state: 'outcome_unknown', code: 'BROKER_LOCAL_OUTCOME_UNKNOWN' }; }
    // A failed/uncertain result POST is never retried automatically. Hub polling can
    // still reveal a committed receipt if the response alone was lost.
    const posted = await client.request('POST', `/v1/nodes/${config.principal_id}/results/${envelope.receipt_id}`,
      result, 'broker.result', { signal: stop.signal });
    if (posted.status >= 400) throw error('BROKER_RESULT_REFUSED', posted.status);
  }
  async function consume(response) {
    const reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    try {
      while (!stop.signal.aborted) {
        const { value, done } = await reader.read(); if (done) break;
        if (pending.length + value.length > 128 * 1024) throw error('BROKER_FRAME_TOO_LARGE');
        pending = Buffer.concat([pending, Buffer.from(value)]);
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.subarray(0, end).toString('utf8'); pending = pending.subarray(end + 2);
          if (frame.startsWith(':')) continue;
          if (!frame.startsWith('data: ') || frame.includes('\n')) throw error('BROKER_FRAME_INVALID');
          await handle(frame.slice(6));
        }
      }
      if (pending.length) throw error('BROKER_FRAME_TRUNCATED');
    } finally { await reader.cancel().catch(() => {}); }
  }
  return {
    async start() {
      if (completion) throw error('BROKER_NODE_ALREADY_STARTED');
      const response = await client.request('POST', `/v1/nodes/${config.principal_id}/stream`, { challenge: verifier.challenge },
        'broker.stream', { signal: stop.signal, stream: true });
      completion = consume(response);
      // The caller can observe .completion; mark handled immediately to avoid an
      // unhandled rejection while an operator is querying another receipt.
      completion.catch(() => {});
    },
    get completion() { return completion; },
    async stop() { stop.abort(); if (completion) await completion.catch(() => {}); }
  };
}
module.exports = { createBrokerClient, createBrokerNode };
