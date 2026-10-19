const sessionPersistence = require('../session-store/persistence');
const { mintSessionNonce } = require('../audit/provenance');
const {
  parseOptionalIdleTtl, applyProcessMetadata, applyIdleTtlMetadata, applyTimestampMetadata,
  initializeBootstrapState, markSessionConnected
} = require('../session-store/route-metadata');

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function ownRecord(records, id) {
  const descriptor = Object.getOwnPropertyDescriptor(records, id);
  const value = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : null;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readIdentity(body, key) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: `Invalid ${key}` };
  const descriptor = Object.getOwnPropertyDescriptor(body, key);
  if (!descriptor) return { error: `${key} is required` };
  if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !validSessionId(descriptor.value)) {
    return { error: `Invalid ${key}` };
  }
  return { value: descriptor.value };
}

function createSessionRecordContext({ sessions, sessionCredentials, sidNonces, sessionPersistPath }) {
  const SESSION_PERSIST_PATH = sessionPersistPath;

  function persistSessions() {
    sessionPersistence.savePersistedSessions(sessions, SESSION_PERSIST_PATH);
  }

  // Mint the credential + nonce for a NEW instance of `sid`. The bearer and nonce it returns are
  // handed to exactly one caller, exactly once, and are never recoverable afterwards.
  function issueSessionCredential(sid) {
    const credential = sessionCredentials.issue(sid);
    const nonce = mintSessionNonce();
    sidNonces.set(sid, nonce);
    return { ...credential, nonce };
  }

  // Called from EVERY destroy path before the id can be reused.
  function revokeSessionCredential(sid) {
    sessionCredentials.revoke(sid);
    sidNonces.delete(sid);
  }

  // Stable alias routing: resolve alias to latest session with matching prefix
  function resolveSessionAlias(requestedId) {
    // Exact match first
    if (typeof requestedId !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(sessions, requestedId)) return ownRecord(sessions, requestedId) ? requestedId : null;

    // Strip trailing version number to get base alias (e.g., "aigentry-dustcraw-002" → "aigentry-dustcraw")
    // Also handles bare alias like "aigentry-dustcraw"
    const baseAlias = requestedId.replace(/-\d+$/, '');

    // Find all sessions matching the base alias
    const candidates = Object.keys(sessions).filter(id => {
      const candidateBase = id.replace(/-\d+$/, '');
      return candidateBase === baseAlias && ownRecord(sessions, id) !== null;
    });

    if (candidates.length === 0) return null;

    // Return the most recently created session
    candidates.sort((a, b) => {
      const timeA = new Date(ownRecord(sessions, a).createdAt).getTime();
      const timeB = new Date(ownRecord(sessions, b).createdAt).getTime();
      return timeB - timeA;
    });
    return candidates[0];
  }

  // #548 (alias-cascade shared-fate): resolveSessionAlias' most-recent-wins fuzzy match is correct for
  // READ/inject ("talk to the current `coder`"), but DESTRUCTIVE ops (DELETE / kill) must NEVER cascade
  // across distinct sids that merely share an alias. The incident: cleaning an already-gone `coder-532`
  // fuzzy-fell-through to its live sibling `coder-533` (same `coder` track) and KILLED it. Distinct sids
  // = distinct lifecycles. This resolver enforces "destroy exactly the session you named":
  //   - exact sid match → that sid;
  //   - a fully-qualified sid (ends in `-<digits>`) with no exact match → null (a stale/duplicate DELETE
  //     of a gone sid must NOT fall through to a sibling — this is the exact #548 cascade);
  //   - a bare alias → resolve ONLY when a single session carries it (unambiguous); multiple siblings → null
  //     (refuse rather than silently pick most-recent and kill the wrong one).
  function resolveSessionForDestroy(requestedId) {
    if (typeof requestedId !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(sessions, requestedId)) return ownRecord(sessions, requestedId) ? requestedId : null;
    if (/-\d+$/.test(requestedId)) return null;
    const baseAlias = requestedId.replace(/-\d+$/, '');
    const candidates = Object.keys(sessions).filter(id => id.replace(/-\d+$/, '') === baseAlias && ownRecord(sessions, id) !== null);
    return candidates.length === 1 ? candidates[0] : null;
  }

  return { sessions, sessionCredentials, sidNonces, persistSessions, issueSessionCredential,
    revokeSessionCredential, resolveSessionAlias, resolveSessionForDestroy };
}

function registerSessionRegisterRoute(app, { context, sessionStateManager, busClients }) {
  const { sessions, sessionCredentials, issueSessionCredential, persistSessions } = context;
  app.post('/api/sessions/register', (req, res) => {
    const identity = readIdentity(req.body, 'session_id');
    if (identity.error) return res.status(400).json({ error: identity.error });
    const session_id = identity.value;
    const { command, cwd = process.cwd(), backend, cmux_workspace_id, cmux_surface_id, term_program, term } = req.body;
    const parsedIdleTtl = parseOptionalIdleTtl(req.body);
    if (parsedIdleTtl.error) {
      return res.status(400).json({ error: parsedIdleTtl.error, code: 'INVALID_IDLE_TTL' });
    }
    // Idempotent: allow re-registration (update command/cwd, keep clients)
    if (Object.prototype.hasOwnProperty.call(sessions, session_id)) {
      const existing = ownRecord(sessions, session_id);
      if (!existing) return res.status(409).json({ error: 'Invalid existing session record' });
      // #815: does this caller hold the session's CURRENT credential? A re-register never mints,
      // recovers or discloses credential material either way — this only decides whether the
      // caller may redirect where the session's injects are delivered (below).
      // Keyed off the RESOLVED record's own id (daemon-owned state), never the raw body string —
      // identical here since we are inside the own-record branch, but it keeps
      // attacker-controlled text out of the credential path entirely.
      const credentialed = sessionCredentials.matches(existing.id, req.headers['x-telepty-session-token']);
      if (command) existing.command = command;
      if (cwd) existing.cwd = cwd;
      if (backend) existing.backend = backend;
      if (cmux_workspace_id) existing.cmuxWorkspaceId = cmux_workspace_id;
      if (cmux_surface_id) existing.cmuxSurfaceId = cmux_surface_id;
      if (Object.prototype.hasOwnProperty.call(req.body, 'term_program')) existing.termProgram = term_program || null;
      if (Object.prototype.hasOwnProperty.call(req.body, 'term')) existing.term = term || null;
      if (req.body.delivery_type) existing.type = req.body.delivery_type;
      // #815: the delivery endpoint is where this session's injects are WRITTEN. An uncredentialed
      // re-register that could rewrite it would redirect a live session's traffic to an attacker —
      // the same "keyed to a name" flaw as the token disclosure, on the same endpoint. A session
      // that has no credential at all (aterm/external registrants) is unchanged: nothing to prove
      // against, so those registrations keep working exactly as before.
      const mayRedirectDelivery = credentialed || !sessionCredentials.hasCredential(existing.id);
      if (mayRedirectDelivery) {
        if (req.body.delivery_endpoint) existing.deliveryEndpoint = req.body.delivery_endpoint;
        if (req.body.delivery) {
          existing.delivery = req.body.delivery;
          if (!existing.deliveryEndpoint && req.body.delivery.address) {
            existing.deliveryEndpoint = req.body.delivery.address;
          }
        }
      } else if (req.body.delivery_endpoint || req.body.delivery) {
        console.warn(`[REGISTER] Ignored uncredentialed delivery-endpoint change for session ${session_id}`);
      }
      if (req.body.delivery_type === 'aterm') {
        existing.ready = true;
        markSessionConnected(existing);
      }
      applyProcessMetadata(existing, req.body);
      applyIdleTtlMetadata(existing, parsedIdleTtl);
      applyTimestampMetadata(existing, req.body);
      initializeBootstrapState(existing);
      // #47 P4 — provenance capability is opt-in (default-OFF). Only flip it ON; never silently OFF
      // on a metadata re-register, or a session's delivered bytes would change mid-flight.
      if (req.body.provenance_capable === true) existing.provenanceCapable = true;
      // #678: a bridge reconnecting to an already-known session (e.g. one restored across a
      // daemon restart, or a re-`allow` of the same id) must still end up with a render-state
      // machine. register() is idempotent (returns the existing machine untouched), so this is
      // safe for the normal re-register too — and it is the ONLY thing that recreates the
      // machine for a same-id reconnect, since a daemon restart is not required to reach here.
      sessionStateManager.register(session_id);
      console.log(`[REGISTER] Re-registered session ${session_id} (type: ${existing.type}, updated metadata)`);
      // #815: NO credential material in a re-register response — not the bearer, not the nonce, not
      // even to a caller that proved it holds the current one. This was the disclosure: the branch
      // used to return `mintSessionToken(session_id)` to whoever named an already-registered id.
      // The legitimate holder does not need a copy back: the bridge carries the bearer in its env
      // (cli.js) and the child got its copy at spawn. `session_epoch` is a non-secret instance
      // discriminator — it identifies WHICH instance answered, and proves nothing on its own.
      return res.status(200).json({ session_id, type: existing.type, command: existing.command, cwd: existing.cwd, reregistered: true, session_epoch: existing.sessionEpoch || null, provenance_capable: !!existing.provenanceCapable });
    }

    const { delivery_type, delivery_endpoint, delivery } = req.body;
    const resolvedEndpoint = delivery_endpoint || (delivery && delivery.address) || null;
    // #815 — THE issuance point, and the only one. This branch runs exactly when the daemon does
    // not currently hold `session_id`, so every credential belongs to a fresh instance: a recreated
    // textual sid gets a new epoch and its predecessor's bearer can never resolve to it.
    const issued = issueSessionCredential(session_id);
    const sessionRecord = {
      id: session_id,
      type: delivery_type || 'wrapped',
      ptyProcess: null,
      ownerWs: null,
      command: command || 'wrapped',
      cwd,
      backend: backend || 'kitty',
      cmuxWorkspaceId: cmux_workspace_id || null,
      cmuxSurfaceId: cmux_surface_id || null,
      termProgram: term_program || null,
      term: term || null,
      delivery: delivery || null,
      deliveryEndpoint: resolvedEndpoint,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastConnectedAt: delivery_type === 'aterm' ? new Date().toISOString() : null,
      lastDisconnectedAt: delivery_type === 'aterm' ? null : new Date().toISOString(),
      lastStateReportAt: null,
      stateReport: null,
      idleTtl: parsedIdleTtl.present ? parsedIdleTtl.raw : null,
      idleTtlMs: parsedIdleTtl.present ? parsedIdleTtl.ms : null,
      ownerPid: Number.isInteger(Number(req.body.owner_pid)) && Number(req.body.owner_pid) > 0 ? Number(req.body.owner_pid) : null,
      ptyPid: Number.isInteger(Number(req.body.pty_pid)) && Number(req.body.pty_pid) > 0 ? Number(req.body.pty_pid) : null,
      clients: new Set(),
      isClosing: false,
      outputRing: [],
      ready: true,  // unknown commands remain injectable once registered (#150)
      // #47 P4 — provenance banner is opt-in per session (default-OFF, spec §6 rollout). A nonce is
      // always minted (cheap) but the capability-gated banner only wraps deliveries when capable.
      provenanceCapable: req.body.provenance_capable === true,
      provenanceNonce: issued.nonce,
      // #815: the VERIFIER is what lives on the record and goes to disk — the bearer never does.
      sessionEpoch: issued.epoch,
      credentialVerifier: issued.verifier,
      credentialGeneration: issued.generation,
    };
    initializeBootstrapState(sessionRecord);
    applyTimestampMetadata(sessionRecord, req.body);
    // Check for existing session with same base alias and emit replaced event
    const baseAlias = session_id.replace(/-\d+$/, '');
    const replaced = Object.keys(sessions).find(id => {
      return id !== session_id && id.replace(/-\d+$/, '') === baseAlias && ownRecord(sessions, id) !== null;
    });
    if (replaced) {
      const replacedMsg = JSON.stringify({
        type: 'session.replaced',
        sender: 'daemon',
        old_id: replaced,
        new_id: session_id,
        alias: baseAlias,
        timestamp: new Date().toISOString()
      });
      busClients.forEach(client => {
        if (client.readyState === 1) client.send(replacedMsg);
      });
      console.log(`[ALIAS] Session '${replaced}' replaced by '${session_id}' (alias: ${baseAlias})`);
    }

    Object.defineProperty(sessions, session_id, { value: sessionRecord, enumerable: true, writable: true, configurable: true });
    sessionStateManager.register(session_id);

    const busMsg = JSON.stringify({
      type: 'session_register',
      sender: 'daemon',
      session_id,
      command: sessionRecord.command,
      cwd,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[REGISTER] Registered wrapped session ${session_id} (epoch: ${issued.epoch})`);
    // #815: persist the verifier BEFORE acknowledging. persistSessions() is synchronous, so once
    // this response is on the wire the credential is already durable — a daemon that dies between
    // the two can never leave a bearer in a child's env with no verifier on disk to match it.
    persistSessions();
    // The bearer and nonce cross the wire HERE and only here, once, to this one caller.
    res.status(201).json({ session_id, type: 'wrapped', command: sessionRecord.command, cwd, session_token: issued.bearer, session_epoch: issued.epoch, credential_generation: issued.generation, session_nonce: sessionRecord.provenanceNonce, provenance_capable: sessionRecord.provenanceCapable });
  });
}

function registerSessionRenameRoute(app, { context, sessionStateManager, busClients }) {
  const { sessions, sessionCredentials, sidNonces, resolveSessionAlias } = context;
  app.patch('/api/sessions/:id', (req, res) => {
    const requestedId = req.params.id;
    const resolvedId = resolveSessionAlias(requestedId);
    if (!resolvedId) return res.status(404).json({ error: 'Session not found', requested: requestedId });
    const session = ownRecord(sessions, resolvedId);
    if (!session) return res.status(409).json({ error: 'Invalid existing session record' });
    const id = resolvedId;
    const identity = readIdentity(req.body, 'new_id');
    if (identity.error) return res.status(400).json({ error: identity.error });
    const new_id = identity.value;
    if (Object.prototype.hasOwnProperty.call(sessions, new_id)) return res.status(409).json({ error: `Session ID '${new_id}' is already in use.` });

    // Move session to new key (including state machine)
    Object.defineProperty(sessions, new_id, { value: session, enumerable: true, writable: true, configurable: true });
    delete sessions[id];
    // #815: a rename moves ONE LIVE INSTANCE to a new name — same PTY, same owner, same epoch. The
    // credential follows the instance rather than being revoked, or the running child (which holds
    // the bearer in an environment nobody can update) would silently lose its identity. Only
    // canonical_sid changes in the principal; the epoch still says "same instance".
    sessionCredentials.rename(id, new_id);
    const renamedNonce = sidNonces.get(id);
    if (renamedNonce !== undefined) {
      sidNonces.delete(id);
      sidNonces.set(new_id, renamedNonce);
    }
    sessionStateManager.unregister(id);
    sessionStateManager.register(new_id);
    session.id = new_id;

    // Broadcast rename to bus
    const busMsg = JSON.stringify({
      type: 'session_rename',
      sender: 'daemon',
      old_id: id,
      new_id,
      timestamp: new Date().toISOString()
    });
    busClients.forEach(client => {
      if (client.readyState === 1) client.send(busMsg);
    });

    console.log(`[RENAME] Session '${id}' renamed to '${new_id}'`);
    res.json({ success: true, old_id: id, new_id });
  });
}

module.exports = { createSessionRecordContext, registerSessionRegisterRoute, registerSessionRenameRoute };
