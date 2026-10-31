'use strict';

// Test support (#1207, resume5): a PRIVATE TEST BARRIER that pauses the REAL owner worker at a named
// filesystem call, composed over the resume4 fault-fs facade. The owner is synchronous, so blocking
// inside one fs call pauses all of its processing; messages the main thread sends meanwhile queue in
// the MessagePort (not inspectable from JavaScript — tests measure the client's inflight set as a
// PROXY and say so). Two uses:
//   worker side  — required as `workerData.fsImplPath`; barrier config from
//                  process.env.LEDGER_1207_BARRIER (JSON) and faults from LEDGER_1207_FAULTS (fault-fs)
//   main thread  — createBarrier(dir) raises/releases the barrier FILE the worker polls; the wait is
//                  bounded by maxWaitMs (default 15 s) so a failed assertion can never hang the worker.
// Never shipped; production passes no fsImpl.

const realFs = require('node:fs');
const path = require('node:path');
const faultFs = require('./fault-fs');          // resume4: hooks preserved, env-configured for the worker

const WAITABLE = new Int32Array(new SharedArrayBuffer(4));
const DEFAULTS = Object.freeze({ on: ['fsyncSync'], pathIncludes: `${path.sep}segments${path.sep}`, maxWaitMs: 15000, pollMs: 5 });

function readConfig(env = process.env) {
  if (!env.LEDGER_1207_BARRIER) return null;
  try { const c = JSON.parse(env.LEDGER_1207_BARRIER); return c && typeof c.path === 'string' ? { ...DEFAULTS, ...c, on: Array.isArray(c.on) ? c.on : [c.on || 'fsyncSync'] } : null; } catch { return null; }
}

/** Compose a barrier over an fs-like facade (fault-fs by default). */
function createPausedFs({ base = faultFs, config = readConfig(), real = realFs } = {}) {
  const fdPaths = new Map();
  const state = { config, waits: [], timeouts: 0 };
  const facade = { constants: real.constants };
  const names = Object.keys(base).filter((k) => typeof base[k] === 'function' && k !== 'createFaultFs');
  function pathOf(name, args) {
    if (name === 'fsyncSync' || name === 'writeSync' || name === 'closeSync' || name === 'readSync') return fdPaths.get(args[0]) || null;
    return typeof args[0] === 'string' ? args[0] : null;
  }
  function maybeWait(name, p) {
    if (!config || !config.on.includes(name)) return;
    if (config.pathIncludes && !(p && p.includes(config.pathIncludes))) return;
    if (!real.existsSync(config.path)) return;
    const t0 = Date.now(); let timedOut = false;
    while (real.existsSync(config.path)) {
      if (Date.now() - t0 >= config.maxWaitMs) { timedOut = true; break; }
      Atomics.wait(WAITABLE, 0, 0, config.pollMs);     // bounded synchronous wait (worker thread)
    }
    if (timedOut) state.timeouts++;
    state.waits.push({ name, path: p, waited_ms: Date.now() - t0, timed_out: timedOut });
  }
  for (const name of names) {
    facade[name] = function paused(...args) {
      const p = pathOf(name, args);
      maybeWait(name, p);
      const result = base[name](...args);
      if (name === 'openSync' && typeof args[0] === 'string') fdPaths.set(result, args[0]);
      if (name === 'closeSync') fdPaths.delete(args[0]);
      return result;
    };
  }
  facade._barrier = state;
  facade._faults = base._state || null;
  return facade;
}

/** Main-thread handle for the barrier FILE. `raise()` pauses the owner at its next matching call. */
function createBarrier(dir, name = 'owner.barrier') {
  const file = path.join(dir, name);
  return {
    path: file,
    raise() { realFs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); realFs.writeFileSync(file, String(Date.now()), { mode: 0o600 }); return file; },
    release() { try { realFs.unlinkSync(file); return true; } catch { return false; } },
    isRaised() { return realFs.existsSync(file); },
    /** Environment the OWNER WORKER must be spawned with (set before the client opens). */
    env(overrides = {}) { return JSON.stringify({ path: file, ...DEFAULTS, ...overrides }); },
  };
}

const workerFacade = createPausedFs();
for (const k of Object.keys(workerFacade)) if (!k.startsWith('_')) module.exports[k] = workerFacade[k];
module.exports.constants = realFs.constants;
module.exports.createPausedFs = createPausedFs;
module.exports.createBarrier = createBarrier;
module.exports.readConfig = readConfig;
module.exports.DEFAULTS = DEFAULTS;
module.exports._barrier = workerFacade._barrier;
module.exports._faults = workerFacade._faults;
