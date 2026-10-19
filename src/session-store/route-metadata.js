const lifecycle = require('../lifecycle');
const readyRegistry = require('../prompt-symbol-registry');

function parseOptionalIdleTtl(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'idle_ttl')) {
    return { present: false };
  }
  try {
    return {
      present: true,
      raw: body.idle_ttl == null ? 'off' : String(body.idle_ttl),
      ms: lifecycle.parseDuration(body.idle_ttl == null ? 'off' : body.idle_ttl, { fieldName: 'idle_ttl' })
    };
  } catch (err) {
    return { present: true, error: err.message };
  }
}

function applyProcessMetadata(session, body) {
  if (!session || !body) return;
  const ownerPid = Number(body.owner_pid);
  const ptyPid = Number(body.pty_pid);
  if (Number.isInteger(ownerPid) && ownerPid > 0) {
    session.ownerPid = ownerPid;
  }
  if (Number.isInteger(ptyPid) && ptyPid > 0) {
    session.ptyPid = ptyPid;
  }
}

function applyIdleTtlMetadata(session, parsedIdleTtl) {
  if (!session || !parsedIdleTtl || !parsedIdleTtl.present || parsedIdleTtl.error) return;
  session.idleTtl = parsedIdleTtl.raw;
  session.idleTtlMs = parsedIdleTtl.ms;
}

function applyTimestampMetadata(session, body) {
  if (!session || !body) return;
  for (const [field, prop] of [
    ['created_at', 'createdAt'],
    ['last_activity_at', 'lastActivityAt']
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field] == null ? null : String(body[field]);
    if (value && Number.isFinite(new Date(value).getTime())) {
      session[prop] = value;
    }
  }
}

function isBootstrapGatedSession(session) {
  return !!(session && session.type === 'wrapped' && readyRegistry.isKnownAiCli(session.command));
}

function initializeBootstrapState(session) {
  if (!session) return session;
  if (!Array.isArray(session.bootstrapQueue)) {
    session.bootstrapQueue = [];
  }
  session.bootstrapDraining = session.bootstrapDraining === true;
  session.bootstrapDrainPromise = session.bootstrapDrainPromise || null;
  session.bootstrapPromptPoll = session.bootstrapPromptPoll || null;

  if (isBootstrapGatedSession(session)) {
    session.bootstrapReady = session.bootstrapReady === true;
    session.bootstrapReadyAt = session.bootstrapReadyAt || null;
    session.bootstrapReadyReason = session.bootstrapReadyReason || null;
    session.ready = session.bootstrapReady === true;
  } else {
    session.bootstrapReady = true;
    session.bootstrapReadyAt = session.bootstrapReadyAt || new Date().toISOString();
    session.bootstrapReadyReason = session.bootstrapReadyReason || 'generic_command_compat';
    session.ready = true;
  }
  return session;
}

function markSessionConnected(session, timestamp = new Date().toISOString()) {
  session.lastConnectedAt = timestamp;
  session.lastDisconnectedAt = null;
  session._staleEmitted = false;
}

module.exports = {
  parseOptionalIdleTtl,
  applyProcessMetadata,
  applyIdleTtlMetadata,
  applyTimestampMetadata,
  isBootstrapGatedSession,
  initializeBootstrapState,
  markSessionConnected
};
