'use strict';
const { bodyDigest, parseUnambiguousJSON } = require('../principal/encoding');
const { createSignedAssertion } = require('../principal/proof');
const MAX_BYTES = 100 * 1024;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
function error(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function origin(value, loopbackOnly = false) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
    || (loopbackOnly && !loopback)) throw error('BROKER_ORIGIN_INVALID');
  return url.origin;
}
async function readBody(request) {
  if (request.method === 'GET') return {};
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BYTES) throw error('BROKER_BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return parseUnambiguousJSON(Buffer.concat(chunks));
}
async function readResponse(response, limit = 16 * 1024) {
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > limit) throw error('BROKER_RESPONSE_TOO_LARGE', 502);
      chunks.push(Buffer.from(value));
    }
    return parseUnambiguousJSON(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
function verify(verifier, request, body, action, target, sessionEpoch) {
  const result = verifier.verify(request.headers['x-telepty-assertion'], { method: request.method,
    target: request.url, bodySha256: bodyDigest(body), action, grantTarget: target, transport: 'http', sessionEpoch });
  if (!result.ok) throw error(result.code, result.status);
  return result.principal;
}
function assertion(config, privateKey, challenge, method, target, body, action, sessionEpoch) {
  return createSignedAssertion({ privateKey, keyId: config.key_id, principalId: config.principal_id,
    audience: config.hub_audience, challenge, method, target, body, action, sessionEpoch });
}
// Keep the declared Node20 runtime compatible without relying on optional any().
// A finite deadline always ends the listeners even if a successful request ends first.
function combineAbortSignals(signals) {
  const controller = new AbortController();
  const listeners = [];
  const finish = source => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    controller.abort(source.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) { finish(signal); return controller.signal; }
    const listener = () => finish(signal);
    listeners.push([signal, listener]);
    signal.addEventListener('abort', listener, { once: true });
  }
  return controller.signal;
}
module.exports = { combineAbortSignals, MAX_BYTES, id, error, origin, readBody, readResponse, json, verify, assertion };
