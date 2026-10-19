'use strict';

const CAPACITY = 8;
const clockOrigin = process.hrtime.bigint();

function monotonicSeconds() {
  return Number(process.hrtime.bigint() - clockOrigin) / 1e9;
}

function createSpawnAdmission({ now = monotonicSeconds } = {}) {
  let tokens = CAPACITY;
  let last = null;

  return {
    take() {
      let current;
      try { current = now(); } catch { return { allowed: false, reason: 'clock_unavailable' }; }
      if (typeof current !== 'number' || !Number.isFinite(current) || current < 0
          || current > Number.MAX_SAFE_INTEGER || (last !== null && current < last)) {
        return { allowed: false, reason: 'clock_unavailable' };
      }
      // One token per second; elapsed time beyond capacity cannot add usable credit.
      if (last !== null) tokens = Math.min(CAPACITY, tokens + Math.min(CAPACITY, current - last));
      last = current;
      if (tokens < 1) {
        return { allowed: false, reason: 'rate_limited', retryAfter: Math.max(1, Math.ceil(1 - tokens)) };
      }
      tokens -= 1;
      return { allowed: true };
    }
  };
}

const defaultSpawnAdmission = createSpawnAdmission();

module.exports = { createSpawnAdmission, defaultSpawnAdmission };
