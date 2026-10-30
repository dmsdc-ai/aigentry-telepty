'use strict';
const { id, error, json, readResponse, combineAbortSignals } = require('./http');
const SID = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128
  && !/[\/\\\x00-\x1f\x7f-\x9f]/.test(value) && value !== '.' && value !== '..';
const EPOCH = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const CHALLENGE = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && Object.keys(value).every(key => names.includes(key));
}
function validateDiscovery(value) {
  if (value === undefined) return null;
  if (!fields(value, ['sessions', 'interval_ms', 'ttl_ms']) || !Array.isArray(value.sessions)
    || value.sessions.length > 32 || value.sessions.some(sid => !SID(sid)) || new Set(value.sessions).size !== value.sessions.length
    || !Number.isInteger(value.interval_ms) || value.interval_ms < 5000 || value.interval_ms > 120000
    || !Number.isInteger(value.ttl_ms) || value.ttl_ms < value.interval_ms || value.ttl_ms > 120000) throw error('BROKER_DISCOVERY_CONFIG_INVALID');
  return Object.freeze({ ...value, sessions: Object.freeze([...value.sessions]) });
}
function createDiscoveryRegistry({ nodes, streams, now = Date.now }) {
  const snapshots = new Map();
  let latestClock = 0;
  function clock() {
    const at = now();
    if (!Number.isSafeInteger(at) || at < latestClock) return null;
    latestClock = at; return at;
  }
  return {
    remove(node, stream) { if (snapshots.get(node)?.stream === stream) snapshots.delete(node); },
    handle(req, res, body, authenticate) {
      const advertised = /^\/v1\/nodes\/([A-Za-z0-9._-]+)\/advertise$/.exec(req.url);
      const lookup = /^\/v1\/nodes\/([A-Za-z0-9._-]+)\/discovery\/([A-Za-z0-9._-]+)$/.exec(req.url);
      if (req.method === 'POST' && advertised) {
        const node = advertised[1], principal = authenticate(body, 'broker.advertise', node);
        const stream = streams.get(node);
        if (principal.id !== node || !own(nodes, node) || !stream || stream.response.destroyed) throw error('BROKER_DISCOVERY_NODE_DENIED', 403);
        if (!fields(body, ['sessions', 'complete', 'configured_count', 'ttl_ms', 'stream_challenge'])
          || !Array.isArray(body.sessions) || body.sessions.length > 32 || typeof body.complete !== 'boolean'
          || !Number.isInteger(body.configured_count) || body.configured_count < body.sessions.length || body.configured_count > 32
          || (body.complete && body.configured_count !== body.sessions.length)
          || !Number.isInteger(body.ttl_ms) || body.ttl_ms < 5000 || body.ttl_ms > 120000
          || !CHALLENGE(body.stream_challenge) || body.stream_challenge !== stream.challenge
          || body.sessions.some(row => !fields(row, ['session_id', 'session_epoch']) || !SID(row.session_id) || !EPOCH(row.session_epoch))
          || new Set(body.sessions.map(row => row.session_id)).size !== body.sessions.length) throw error('BROKER_DISCOVERY_INVALID');
        const at = clock();
        if (at === null) throw error('BROKER_DISCOVERY_CLOCK_UNSAFE', 503);
        snapshots.set(node, { stream, at, ttl: body.ttl_ms, complete: body.complete, configured: body.configured_count,
          sessions: body.sessions.map(row => ({ session_id: row.session_id, session_epoch: row.session_epoch })) });
        json(res, 200, { success: true, node, received_at: new Date(at).toISOString(), foreign_session_identity_verified: false });
        return true;
      }
      if (req.method === 'GET' && lookup) {
        const [, caller, node] = lookup, principal = authenticate(body, 'broker.discover', node);
        if (principal.id !== caller || !own(nodes, caller) || !own(nodes, node)) throw error('BROKER_DISCOVERY_NODE_DENIED', 403);
        const stream = streams.get(node), snapshot = snapshots.get(node), at = clock();
        let reason = !stream || stream.response.destroyed ? 'node_disconnected'
          : !snapshot || snapshot.stream !== stream ? 'no_current_snapshot'
          : at === null || at < snapshot.at ? 'clock_unsafe'
          : at - snapshot.at >= snapshot.ttl ? 'snapshot_expired' : null;
        if (reason) {
          snapshots.delete(node);
          json(res, 200, { node, status: 'unavailable', reason, sessions: null, foreign_session_identity_verified: false });
        } else json(res, 200, { node, status: 'observed', observation_scope: 'node-reported', sessions: snapshot.sessions,
          complete: snapshot.complete, configured_count: snapshot.configured, age_ms: at - snapshot.at,
          received_at: new Date(snapshot.at).toISOString(), ttl_ms: snapshot.ttl,
          foreign_session_identity_verified: false });
        return true;
      }
      return false;
    }
  };
}
function createDiscoveryAgent({ configuration, node, client, inspect, timeoutMs, signal }) {
  const config = validateDiscovery(configuration);
  if (!config) return null;
  if (!id(node) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw error('BROKER_DISCOVERY_CONFIG_INVALID');
  let current = null;
  const counters = { posted: 0, partial: 0, errors: 0 };
  const bump = key => { counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1); };
  function end(challenge) {
    const job = current;
    if (!job || (challenge !== undefined && job.challenge !== challenge)) return;
    current = null; job.stop.abort(); clearTimeout(job.timer);
  }
  function begin(challenge) {
    end();
    if (signal.aborted || !CHALLENGE(challenge)) return;
    const job = { challenge, stop: new AbortController(), timer: null }; current = job;
    async function sample() {
      const sessions = [];
      const bounded = combineAbortSignals([signal, job.stop.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        for (const sid of config.sessions) {
          if (bounded.aborted || current !== job) break;
          try {
            const response = await inspect(sid, bounded);
            if (!response.ok) { await response.body?.cancel().catch(() => {}); continue; }
            const value = await readResponse(response, 16384);
            if (value && value.id === sid && EPOCH(value.session_epoch)) sessions.push({ session_id: sid, session_epoch: value.session_epoch });
          } catch { /* Missing/refused/invalid data cannot establish a complete snapshot. */ }
        }
        if (current !== job || signal.aborted || job.stop.signal.aborted) return;
        const body = { sessions, configured_count: config.sessions.length, complete: sessions.length === config.sessions.length,
          ttl_ms: config.ttl_ms, stream_challenge: challenge };
        // Local sampling has its own finite budget; publishing is separately bounded by client.
        const result = await client.request('POST', `/v1/nodes/${node}/advertise`, body, 'broker.advertise',
          { signal: combineAbortSignals([signal, job.stop.signal]) });
        if (current !== job || signal.aborted || job.stop.signal.aborted) return;
        if (result.status >= 400 || result.body?.success !== true) throw error('BROKER_DISCOVERY_REFUSED');
        bump('posted'); if (!body.complete) bump('partial');
      } catch { if (current === job && !signal.aborted && !job.stop.signal.aborted) bump('errors'); }
      finally {
        if (current === job && !signal.aborted && !job.stop.signal.aborted) {
          job.timer = setTimeout(sample, config.interval_ms); job.timer.unref?.();
        }
      }
    }
    sample();
  }
  signal.addEventListener('abort', () => end(), { once: true });
  return { begin, end, stats: () => ({ ...counters }) };
}
module.exports = { createDiscoveryRegistry, createDiscoveryAgent, validateDiscovery };
