'use strict';
const { canonicalJSON } = require('./principal/encoding');
function validApplicationBody(body, epoch) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['expected_epoch','topic','data'].includes(key))
    || typeof body.expected_epoch !== 'string' || body.expected_epoch !== epoch
    || typeof body.topic !== 'string' || Buffer.byteLength(body.topic) > 96
    || !/^app\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(body.topic)
    || !Object.hasOwn(body, 'data')) return false;
  let nodes = 0;
  function bounded(value, depth = 0) {
    if (++nodes > 256 || depth > 8) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return Buffer.byteLength(value) <= 4096;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.length <= 128 && value.every(item => bounded(item, depth + 1));
    const keys = Object.keys(value);
    return keys.length <= 128 && keys.every(key => Buffer.byteLength(key) <= 128 && bounded(value[key], depth + 1));
  }
  try { return bounded(body.data) && Buffer.byteLength(canonicalJSON(body.data)) <= 4096; } catch { return false; }
}
function projectPublicationReceipt(response, remote, sessionId) {
  const valid = remote && typeof remote === 'object' && !Array.isArray(remote);
  const accepted = response.ok && valid && remote.success === true && remote.session_id === sessionId
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(remote.publication_id || '')
    && Number.isInteger(remote.matched_socket_count) && remote.matched_socket_count >= 0 && remote.matched_socket_count <= 64 && remote.delivery_ack === false;
  const uncertain = response.status >= 500 || !valid || (response.ok && !accepted);
  const safe = { success: accepted, retryable: false, delivery_ack: false };
  if (accepted) { safe.publication_id = remote.publication_id; safe.matched_socket_count = remote.matched_socket_count; }
  if (valid && /^[A-Z][A-Z0-9_]{0,95}$/.test(remote.code || '')) safe.code = remote.code;
  if (uncertain) { safe.success = false; safe.delivery_uncertain = true; }
  return { accepted, uncertain, safe };
}
module.exports = { validApplicationBody, projectPublicationReceipt };
