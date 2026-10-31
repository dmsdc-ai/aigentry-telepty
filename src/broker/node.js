'use strict';
const { createPrincipalVerifier, validateTrustConfiguration } = require('../principal/proof');
const { bodyDigest, parseUnambiguousJSON } = require('../principal/encoding');
const { id, error, origin, readResponse, assertion, combineAbortSignals } = require('./http');
const { createRoutingClient } = require('./routing-client');
const { ACTIONS } = require('./hub');
const { createDiscoveryAgent } = require('./discovery');
const { loadLocalPrincipal, createLocalPrincipalRequest } = require('./local-principal');
const { validateForwardBody } = require('../peer-forwarding');

function createBrokerClient({ config, privateKey, fetch: send = globalThis.fetch } = {}) {
  if (!config || !id(config.principal_id) || !id(config.key_id) || typeof config.hub_audience !== 'string') throw error('BROKER_CONFIG_INVALID');
  const hub = origin(config.hub_url);
  function deadline(signal, milliseconds) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal) { if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); }
    const timer = setTimeout(() => controller.abort(error('BROKER_HEADER_TIMEOUT')), milliseconds);
    return { signal: controller.signal, close() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', cancel); } };
  }
  async function challenge(signal) {
    const bounded = deadline(signal, 3000);
    try {
      const response = await send(`${hub}/v1/challenge`, { redirect: 'error', signal: bounded.signal });
      if (!response.ok) throw error('BROKER_CHALLENGE_FAILED', response.status);
      if (!response.body) throw error('BROKER_CHALLENGE_INVALID', 502);
      const value = await readResponse(response);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 'telepty.broker-challenge/v1' || value.audience !== config.hub_audience
        || !/^[A-Za-z0-9_-]{16,128}$/.test(value.challenge || '')) throw error('BROKER_CHALLENGE_INVALID', 502);
      return value.challenge;
    } finally { bounded.close(); }
  }
  async function request(method, target, body, action, { sessionEpoch, signal, stream = false } = {}) {
    const current = await challenge(signal);
    const proof = assertion(config, privateKey, current, method, target, body, action, sessionEpoch);
    const bounded = deadline(signal, stream ? 3000 : 10000);
    try {
      const response = await send(`${hub}${target}`, { method, redirect: 'error', signal: bounded.signal,
        headers: { 'content-type': 'application/json', 'x-telepty-assertion': proof },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
      // Stream reads are owned and cancelled by consume(); this deadline bounds headers only.
      if (stream) { if (!response.ok) { await response.body?.cancel().catch(() => {}); throw error('BROKER_STREAM_REFUSED', response.status); } return response; }
      return { status: response.status, body: await readResponse(response) };
    } finally { bounded.close(); }
  }
  return { request, ...createRoutingClient({ request, source: config.principal_id }),
    discover(node) {
      if (!id(node)) throw error('BROKER_NODE_INVALID');
      return request('GET', `/v1/nodes/${config.principal_id}/discovery/${node}`, {}, 'broker.discover');
    },
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

function createBrokerNode({ config, privateKey, localToken, localPrincipal, fetch: send = globalThis.fetch } = {}) {
  const strictLocal = localPrincipal !== undefined || config?.local_principal !== undefined;
  if (!config || config.schema !== 'telepty.broker-node/v1' || !id(config.principal_id)
    || !id(config.hub_principal_id) || (!strictLocal && (typeof localToken !== 'string' || !localToken))
    || !Number.isInteger(config.local_timeout_ms) || config.local_timeout_ms < 100 || config.local_timeout_ms > 10000) throw error('BROKER_CONFIG_INVALID');
  const local = origin(config.local_daemon_url, true);
  if (strictLocal && localToken !== undefined) throw error('BROKER_LOCAL_AUTH_AMBIGUOUS');
  const localRequest = strictLocal ? createLocalPrincipalRequest({ localDaemonUrl: local,
    principal: localPrincipal === undefined ? loadLocalPrincipal(config.local_principal) : localPrincipal,
    timeoutMs: config.local_timeout_ms, fetch: send }) : null;
  const trust = validateTrustConfiguration(config.hub_trust, { audience: config.audience, allowedActions: ACTIONS });
  // This trust file pins only the hub's key(s), with exact source-node/session grants.
  for (const key of trust.keys.values()) if (key.id !== config.hub_principal_id) throw error('BROKER_HUB_PIN_INVALID');
  let verifier = createPrincipalVerifier({ trust });
  const reconnect = config.reconnect;
  if (reconnect !== undefined && (!reconnect || typeof reconnect !== 'object' || Array.isArray(reconnect)
    || Object.keys(reconnect).some(key => !['max_attempts', 'initial_backoff_ms', 'max_backoff_ms'].includes(key))
    || !Number.isInteger(reconnect.max_attempts) || reconnect.max_attempts < 1 || reconnect.max_attempts > 10
    || !Number.isInteger(reconnect.initial_backoff_ms) || reconnect.initial_backoff_ms < 10
    || !Number.isInteger(reconnect.max_backoff_ms) || reconnect.max_backoff_ms < reconnect.initial_backoff_ms
    || reconnect.max_backoff_ms > 30000)) throw error('BROKER_CONFIG_INVALID');
  const client = createBrokerClient({ config, privateKey, fetch: send });
  const stop = new AbortController();
  const discovery = createDiscoveryAgent({ configuration: config.discovery, node: config.principal_id, client,
    timeoutMs: config.local_timeout_ms, signal: stop.signal, inspect: (sid, signal) => localRequest
      ? localRequest.inspect(sid, signal)
      : send(`${local}/api/sessions/${encodeURIComponent(sid)}`, { redirect: 'error', signal,
        headers: { 'x-telepty-token': localToken } }) });
  let completion, starting = false;
  function transient(reason) {
    return reason && (reason.code === 'BROKER_TRANSPORT_LOST' || reason.code === 'BROKER_HEADER_TIMEOUT'
      || reason.name === 'TimeoutError'
      || (reason instanceof TypeError && (!reason.cause || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(reason.cause.code))));
  }
  async function backoff(attempt) {
    await new Promise(resolve => {
      if (stop.signal.aborted) return resolve();
      const finish = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, Math.min(reconnect.max_backoff_ms, reconnect.initial_backoff_ms * 2 ** (attempt - 1)));
      stop.signal.addEventListener('abort', finish, { once: true });
    });
  }
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
      const localBody = { ...payload, exact_target: true, claimed_cross_host: true,
        forwarding: { hop: 1, key: envelope.receipt_id } };
      const response = localRequest ? await localRequest(envelope.session, localBody, stop.signal)
        : await send(`${local}/api/forwarded/sessions/${encodeURIComponent(envelope.session)}/inject`, {
        method: 'POST', redirect: 'error', signal: combineAbortSignals([stop.signal, AbortSignal.timeout(config.local_timeout_ms)]),
        headers: { 'content-type': 'application/json', 'x-telepty-token': localToken },
        body: JSON.stringify(localBody)
      });
      const receipt = await readResponse(response);
      if (response.ok && receipt.success === true && typeof receipt.inject_id === 'string'
        && receipt.session_id === envelope.session && receipt.exact_target === true) {
        result = { state: 'accepted', inject_id: receipt.inject_id, queued: receipt.queued === true || receipt.bootstrap_queued === true };
      } else result = { state: response.ok || response.status >= 500
        || ['FORWARD_OUTCOME_UNKNOWN', 'FORWARD_STORAGE_UNAVAILABLE'].includes(receipt.code) ? 'outcome_unknown' : 'failed',
        code: 'BROKER_LOCAL_INJECT_REFUSED' };
    } catch (failure) {
      result = failure.code?.startsWith('BROKER_LOCAL_CHALLENGE')
        ? { state: 'failed', code: 'BROKER_LOCAL_CHALLENGE_REFUSED' }
        : { state: 'outcome_unknown', code: 'BROKER_LOCAL_OUTCOME_UNKNOWN' };
    }
    // A failed/uncertain result POST is never retried automatically. Hub polling can
    // still reveal a committed receipt if the response alone was lost.
    const posted = await client.request('POST', `/v1/nodes/${config.principal_id}/results/${envelope.receipt_id}`,
      result, 'broker.result', { signal: stop.signal });
    if (posted.status >= 400) throw error('BROKER_RESULT_REFUSED', posted.status);
  }
  async function consume(response) {
    const streamChallenge = verifier.challenge;
    const reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    const cancel = () => { reader.cancel().catch(() => {}); };
    stop.signal.addEventListener('abort', cancel, { once: true });
    try {
      while (!stop.signal.aborted) {
        let chunk;
        try { chunk = await reader.read(); } catch (reason) {
          if (transient(reason)) throw error('BROKER_TRANSPORT_LOST');
          throw reason;
        }
        const { value, done } = chunk; if (done) break;
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
    } finally { discovery?.end(streamChallenge); stop.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
  }
  async function connect() {
    verifier = createPrincipalVerifier({ trust });
    const response = await client.request('POST', `/v1/nodes/${config.principal_id}/stream`, { challenge: verifier.challenge },
      'broker.stream', { signal: stop.signal, stream: true });
    discovery?.begin(verifier.challenge);
    return response;
  }
  async function run(response) {
    let retries = 0;
    while (!stop.signal.aborted) {
      try {
        await consume(response);
        if (!reconnect || stop.signal.aborted) return;
      } catch (reason) {
        if (stop.signal.aborted) return;
        // Only stream transport failures may reconnect. Never retry handle() or result POST.
        if (!reconnect || reason.code !== 'BROKER_TRANSPORT_LOST') throw reason;
      }
      while (!stop.signal.aborted) {
        if (retries >= reconnect.max_attempts) throw error('BROKER_RECONNECT_EXHAUSTED');
        await backoff(++retries);
        if (stop.signal.aborted) return;
        try { response = await connect(); break; }
        catch (reason) { if (stop.signal.aborted) return; if (!transient(reason)) throw reason; }
      }
    }
  }
  return {
    async start() {
      if (starting || completion || stop.signal.aborted) throw error('BROKER_NODE_ALREADY_STARTED');
      starting = true;
      const response = await connect();
      completion = run(response);
      completion.catch(() => {});
    },
    get completion() { return completion; },
    discoveryStats: () => discovery?.stats() || null,
    async stop() { stop.abort(); if (completion) await completion.catch(() => {}); }
  };
}
module.exports = { createBrokerClient, createBrokerNode };
