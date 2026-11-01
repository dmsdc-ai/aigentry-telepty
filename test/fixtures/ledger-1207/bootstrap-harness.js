'use strict';

// Test support (#1207, resume5): the bootstrap/modal machinery of the REAL delivery runtime
// (enqueueBootstrapOperation, parkOperationOnModal, drainBootstrapQueue, failBootstrapQueueOnTimeout,
// awaitModalParkDrain → flushModalParkQueue) needs shared fields the control-harness does not
// supply. This extends the control-harness `buildShared` with the daemon's real helpers
// (prompt-symbol-registry, route-metadata gating/state, submit-gate) and the daemon's modal/bootstrap
// constants (configuration values copied from daemon.js; no algorithm is copied). The delivery leg
// `writeDataToSession` is the wrapped-session branch shape (owner WebSocket send or DISCONNECTED) over
// a test-controlled fake socket, exactly the arrangement test/queued-inject-not-success-860 uses; it
// is NOT success-only — the test decides when the leg refuses or throws.
//
// Submissions to the ledger are TRACED by wrapping `ledgerClient.submit` on the very client the
// runtime uses, so each reached abort call site is witnessed by the terminal frame it submits
// (kind `state`, observation.delivery_code / trigger), not by source text.

const path = require('node:path');
const H = require('./control-harness');
const readyRegistry = require('../../../src/prompt-symbol-registry');
const submitGate = require('../../../src/submit-gate');
const { isBootstrapGatedSession, initializeBootstrapState } = require('../../../src/session-store/route-metadata');

// daemon.js values (constants, not logic)
const CONSTANTS = Object.freeze({
  BOOTSTRAP_READY_TIMEOUT_MS: 30000,
  WRAPPED_SUBMIT_DELAY_MS: 500,
  BRACKETED_PASTE_START: '\x1b[200~',
  BRACKETED_PASTE_END: '\x1b[201~',
  MODAL_RING_TAIL_BYTES: 65536,
  MODAL_REMEDY_DEFAULT: 'hold',
  MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
  MODAL_REMEDY_BY_CLI: { claude: 'park' },
  MODAL_HINT_BY_CLI: { codex: 'Target codex is showing a blocking modal.', claude: 'Target claude is showing a blocking modal.' },
  MODAL_HOLD_DEFAULT_MS: 30000,
  MODAL_PARK_TTL_DEFAULT_MS: 600000,
  MODAL_PARK_POLL_MS: 500,
});

// A real claude AskUserQuestion surface shape (the modal #760 measured; see test/queued-inject-not-success-860).
const MODAL_RING = '\n? Do you want to proceed?\n> 1. Yes\n  2. No, keep planning\n';
const CLEAR_RING = '';

/** A wrapped `claude` session as the daemon models one, with a test-controlled owner socket. */
function claudeSession(id, ring, { ready = true, failAfter = Infinity } = {}) {
  const written = [];
  const ws = { readyState: 1, send: (msg) => { written.push(JSON.parse(msg).data); if (written.length >= failAfter) ws.readyState = 3; } };
  return { id, type: 'wrapped', command: 'claude', backend: 'pty', cmuxWorkspaceId: null, cmuxSurfaceId: null, termProgram: null, term: null,
    bootstrapReady: ready, bootstrapReadyReason: ready ? 'owner_alive' : null, outputRing: [ring], outputRingTotalBytes: ring.length,
    bracketedPasteCapable: true, ownerWs: ws, written, clients: new Set(), isClosing: false, ready: true,
    createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), lastDisconnectedAt: null };
}

/**
 * buildBootstrapShared(store, R, { messages, clientOptions, submitDelayMs })
 * Returns the control-harness result plus `trace` (every ledger submit the runtime makes) and
 * `leg` (controls for the delivery leg: `throwNext` makes the next write throw).
 */
function buildBootstrapShared(store, R, { messages = null, clientOptions = {}, submitDelayMs = 50 } = {}) {
  const built = H.buildShared(store, R, { messages, clientOptions });
  const { shared, ledgerClient } = built;
  const leg = { throwNext: false, writes: [] };
  Object.assign(shared, {
    readyRegistry, submitGate, isBootstrapGatedSession, initializeBootstrapState,
    ...CONSTANTS, WRAPPED_SUBMIT_DELAY_MS: submitDelayMs,
    // the wrapped-session delivery branch shape over the test's fake owner socket; refuses when the
    // socket is not open and throws when the test arms `leg.throwNext`
    writeDataToSession: async (id, session, data) => {
      leg.writes.push({ id, bytes: Buffer.byteLength(data) });
      if (leg.throwNext) { leg.throwNext = false; throw new Error('synthetic delivery leg failure'); }
      if (!session.ownerWs || session.ownerWs.readyState !== 1) return { success: false, httpStatus: 503, code: 'DISCONNECTED', error: 'Session owner is disconnected.' };
      session.ownerWs.send(JSON.stringify({ type: 'inject', data }));
      return { success: true };
    },
  });
  // trace every ledger submission the runtime makes (same client object the runtime holds)
  const trace = [];
  const origSubmit = ledgerClient.submit;
  ledgerClient.submit = function tracedSubmit(kind, delta, opts) {
    const promise = origSubmit.call(ledgerClient, kind, delta, opts);
    const entry = { at: Date.now(), kind, id: delta && delta.id ? delta.id : null, tracking_state: delta && delta.tracking_state ? delta.tracking_state : null,
      delivery_code: delta && delta.observation ? delta.observation.delivery_code || null : null, trigger: delta && delta.observation ? delta.observation.trigger || null : null,
      kind_of_observation: delta && delta.observation ? delta.observation.kind || null : null, outcome: null, promise };
    promise.then((o) => { entry.outcome = o.outcome; entry.reason = o.reason || o.result || null; entry.resolved_at = Date.now(); }, () => { entry.outcome = 'threw'; });
    trace.push(entry);
    return promise;
  };
  return { ...built, trace, leg };
}

module.exports = { CONSTANTS, MODAL_RING, CLEAR_RING, claudeSession, buildBootstrapShared, ...H };
