'use strict';

// Test support (#1207): a fault-injecting `fs` facade for the ledger owner. Two entry points:
//   createFaultFs({ faults, record })  — in-process (owner harness), programmable hooks
//   module itself                     — when required as `workerData.fsImplPath` inside the owner
//                                       worker, faults come from process.env.LEDGER_1207_FAULTS (JSON)
// Faults name a function and match by path substring (fd→path mapping is tracked across openSync).
// Production passes no fsImpl at all; this file is never shipped.

const realFs = require('node:fs');

// Per-instance copy of the caller's fault table that PRESERVES function hooks (`when`, `before`):
// one shallow copy per fault object, so the mutable counters (`remaining`, `skip`) live on the copy
// and the caller's specification is never mutated. (resume4: the previous JSON round-trip deleted
// the functions, which turned every hook-only fault into an unconditional EFAULT — measured as
// `open_failed` where `migration_conflict` was the product outcome under test.)
function cloneFaults(spec) {
  const out = {};
  for (const [name, list] of Object.entries(spec || {})) {
    const arr = Array.isArray(list) ? list : [list];
    out[name] = arr.filter((f) => f && typeof f === 'object').map((f) => ({ ...f }));
  }
  return out;
}

function createFaultFs({ faults = {}, record = null, real = realFs } = {}) {
  const fdPaths = new Map();
  const state = { faults: cloneFaults(faults), calls: [], fired: [] };
  const names = ['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'readFileSync', 'readSync', 'writeFileSync', 'mkdirSync', 'unlinkSync',
    'lstatSync', 'statSync', 'readdirSync', 'chmodSync', 'existsSync', 'statfsSync'];
  const facade = { constants: real.constants };
  function pathOf(args, name) {
    if (name === 'fsyncSync' || name === 'writeSync' || name === 'closeSync' || name === 'readSync') return fdPaths.get(args[0]) || null;
    return typeof args[0] === 'string' ? args[0] : null;
  }
  function maybeFault(name, args, p) {
    const arr = state.faults[name];
    if (!arr) return null;
    for (const f of arr) {
      if (f.remaining === undefined) f.remaining = f.times == null ? 1 : f.times;
      if (f.remaining <= 0) continue;
      if (f.pathIncludes && !(p && p.includes(f.pathIncludes))) continue;
      if (f.pathEndsWith && !(p && p.endsWith(f.pathEndsWith))) continue;
      if (f.argIncludes && !(typeof args[1] === 'string' && args[1].includes(f.argIncludes))) continue;
      if (typeof f.when === 'function' && !f.when(args, p)) continue;
      if (f.skip > 0) { f.skip -= 1; continue; }           // let the first `skip` matching calls through
      f.remaining -= 1;
      state.fired.push({ name, path: p, code: f.code === undefined ? 'EFAULT' : f.code, hook: typeof f.before === 'function' });
      if (typeof f.before === 'function') f.before(args, p);     // side effect before the real call (or before throwing)
      // `code: null` = hook-only fault: the real call proceeds (an "old writer" acting in a gap).
      // Any other code (or an omitted code) throws that errno.
      if (f.code === null) return null;
      const error = new Error(`${f.code || 'EFAULT'}: injected fault at ${name}(${p || ''})`);
      error.code = f.code || 'EFAULT';
      throw error;
    }
    return null;
  }
  for (const name of names) {
    if (typeof real[name] !== 'function') continue;
    facade[name] = function faulted(...args) {
      const p = pathOf(args, name);
      if (record) record.push({ name, path: p, at: record.length });
      state.calls.push({ name, path: p });
      maybeFault(name, args, p);
      const result = real[name](...args);
      if (name === 'openSync' && typeof args[0] === 'string') fdPaths.set(result, args[0]);
      if (name === 'closeSync') fdPaths.delete(args[0]);
      return result;
    };
  }
  facade._state = state;
  return facade;
}

// Worker entry: faults from the environment (the worker cannot receive functions).
let envFaults = null;
try { envFaults = process.env.LEDGER_1207_FAULTS ? JSON.parse(process.env.LEDGER_1207_FAULTS) : null; } catch { envFaults = null; }
const workerFacade = createFaultFs({ faults: envFaults || {} });
for (const k of Object.keys(workerFacade)) if (k !== '_state') module.exports[k] = workerFacade[k];
module.exports.constants = realFs.constants;
module.exports.createFaultFs = createFaultFs;
module.exports._state = workerFacade._state;
