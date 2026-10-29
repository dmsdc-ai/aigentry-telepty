'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');
function createEventLoopTelemetry({ histogram = monitorEventLoopDelay({ resolution: 20 }), now = Date.now,
  schedule = setInterval, cancel = clearInterval, intervalMs = 10000, stallMs = 1000 } = {}) {
  let timer = null, startedAt = null, windowAt = null, latest = null, lastStall = null;
  const millis = value => Number.isFinite(value) && value >= 0 ? Math.round(value / 1e4) / 100 : null;
  function sample() {
    const at = now(), count = Number(histogram.count || 0);
    latest = { started_at: new Date(windowAt).toISOString(), observed_at: new Date(at).toISOString(),
      window_ms: Math.max(0, at - windowAt), count,
      p50_ms: count ? millis(histogram.percentile(50)) : null,
      p99_ms: count ? millis(histogram.percentile(99)) : null,
      max_ms: count ? millis(histogram.max) : null };
    if (latest.max_ms >= stallMs) lastStall = { observed_at: latest.observed_at, window_started_at: latest.started_at, max_ms: latest.max_ms };
    histogram.reset(); windowAt = at;
    return latest;
  }
  return {
    start() { if (startedAt !== null) return; startedAt = windowAt = now(); histogram.enable(); timer = schedule(sample, intervalMs); timer.unref?.(); },
    stop() { if (timer !== null) cancel(timer); timer = null; histogram.disable(); },
    sample,
    snapshot() { const at = now(); return { source: 'perf_hooks.monitorEventLoopDelay', status: latest ? 'observed' : 'unknown',
      reason: latest ? null : 'no_completed_sample_window', interval_ms: intervalMs, stall_threshold_ms: stallMs,
      started_at: startedAt === null ? null : new Date(startedAt).toISOString(),
      freshness_ms: latest ? Math.max(0, at - Date.parse(latest.observed_at)) : null,
      stale: latest ? at - Date.parse(latest.observed_at) > intervalMs * 3 : null,
      latest: latest ? { ...latest } : null, last_stall: lastStall ? { ...lastStall } : null }; }
  };
}
function slowRequestObserver({ now = () => performance.now(), thresholdMs = 2000, log = console.warn } = {}) {
  return (req, res, next) => {
    const started = now();
    res.once('finish', () => {
      const duration = now() - started;
      // Only static route templates are logged: never URLs, IDs, headers, bodies, or query strings.
      if (duration >= thresholdMs) log(`[HTTP_SLOW] ${['GET','POST','DELETE','PUT','PATCH','OPTIONS','HEAD'].includes(req.method) ? req.method : 'OTHER'} ${req.route?.path || 'middleware'} ${Math.round(duration)}ms status=${res.statusCode}`);
    });
    next();
  };
}
module.exports = { createEventLoopTelemetry, slowRequestObserver };
