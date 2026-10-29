'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDeliveryRuntime } = require('../src/mailbox/delivery-runtime');
const { createSessionDeliveryContext } = require('../src/mailbox/session-delivery');
const sessionPersistence = require('../src/session-store/persistence');
const metadata = require('../src/session-store/route-metadata');
const { createCredentialStore } = require('../src/session-store/session-credentials');
const { FileMailbox } = require('../src/mailbox');
const { DeliveryEngine } = require('../src/mailbox/delivery');
const { isOpenWebSocket } = require('../src/transport/websocket');
const { applyProvenance } = require('../src/audit/provenance');
const { SessionStateManager, stripAnsi } = require('../session-state');

// Compose the real delivery runtime and delivery context around owned fixture state.
// Queueing, modal gates, write pairing and durable tracking remain production code;
// only the socket peer and event recipients are supplied by the calling test.
function createSessionDeliveryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-delivery-fixture-'));
  const sessions = Object.create(null);
  const events = [];
  const shared = {
    sessions, crypto, fs, sessionPersistence, sessionCredentials: createCredentialStore(),
    trackedInjections: sessionPersistence.emptyTrackedInjections(), trackedLedgerHealthy: true,
    TRACKED_INJECTIONS_PATH: path.join(root, 'tracked.json'), pendingReports: Object.create(null),
    busClients: new Set([{ readyState: 1, send: data => events.push(JSON.parse(data)) }]),
    interaction: require('../src/interaction'), interactionWaiters: new Map(),
    readyRegistry: require('../src/prompt-symbol-registry'),
    sessionStateManager: new SessionStateManager(), stripAnsiState: stripAnsi,
    submitGate: require('../src/submit-gate'),
    CAPABILITY_STAGE_A: require('../src/completion-observation').CAPABILITY_STAGE_A,
    isBootstrapGatedSession: metadata.isBootstrapGatedSession,
    initializeBootstrapState: metadata.initializeBootstrapState,
    isOpenWebSocket, isProcessRunning: require('../daemon-control').isProcessRunning,
    UPSTREAM_STALL_SECONDS: 30, SESSION_STALE_SECONDS: 60, WRAPPED_SUBMIT_DELAY_MS: 500,
    BOOTSTRAP_READY_TIMEOUT_MS: 30000,
    BRACKETED_PASTE_START: '\x1b[200~', BRACKETED_PASTE_END: '\x1b[201~',
    MODAL_RING_TAIL_BYTES: 65536, MODAL_REMEDIES: new Set(['hold', 'park', 'reject', 'off']),
    MODAL_REMEDY_BY_CLI: { claude: 'park' }, MODAL_REMEDY_DEFAULT: 'hold',
    MODAL_HINT_BY_CLI: { claude: 'Answer the blocking modal.', codex: 'Dismiss the update modal.' },
    MODAL_HOLD_DEFAULT_MS: 30000, MODAL_PARK_TTL_DEFAULT_MS: 600000, MODAL_PARK_POLL_MS: 500,
  };
  const runtime = createDeliveryRuntime(shared);
  shared.interactionCore = runtime.createInteractionRuntime();
  const mailbox = new FileMailbox({ root: path.join(root, 'mailbox') });
  let engine;
  const context = createSessionDeliveryContext({ ...runtime, sessions, crypto, applyProvenance,
    interaction: shared.interaction, isOpenWebSocket, DELIVERY_TIMEOUT_MS: 1000,
    getMailbox: () => mailbox, getMailboxDelivery: () => engine,
    getMailboxNotifier: () => ({ notify() { throw new Error('wrapped fixture must not notify UDS'); } }),
  });
  shared.writeDataToSession = context.writeDataToSession;
  engine = new DeliveryEngine(mailbox, context.mailboxDeliveryOptions);

  function register(id, session) {
    if (!Object.prototype.hasOwnProperty.call(sessions, id)) {
      session.id = id;
      sessions[id] = session;
      metadata.initializeBootstrapState(session);
      shared.sessionStateManager.register(id);
    }
  }
  return { ...runtime, sessions, events,
    deliverInjectionToSession(id, session, prompt, options) {
      register(id, session);
      return context.deliverInjectionToSession(id, session, prompt, options);
    },
    beginTrackedInjection(request) { register(request.sessionId, request.session); return runtime.beginTrackedInjection(request); },
    dispose() {
      engine.stop();
      for (const [id, session] of Object.entries(sessions)) {
        shared.sessionStateManager.unregister(id);
        runtime.cancelModalParkPoll(session);
        if (session.bootstrapOptimisticTimer) clearTimeout(session.bootstrapOptimisticTimer);
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createSessionDeliveryFixture };
