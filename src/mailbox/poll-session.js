'use strict';

const DEFAULT_LEASE_SECONDS = 300;
const MAX_LEASE_SECONDS = 3600;

function parseMailboxLease(value) {
  const seconds = value === undefined ? DEFAULT_LEASE_SECONDS : value;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_LEASE_SECONDS) {
    return { error: `lease_seconds must be an integer between 1 and ${MAX_LEASE_SECONDS}.` };
  }
  return { seconds };
}

function mailboxLeaseAlive(session, nowMs = Date.now()) {
  return session.type === 'mailbox' && Number.isFinite(session.leaseExpiresAt)
    && session.leaseExpiresAt > nowMs && session.leaseExpiresAt <= nowMs + MAX_LEASE_SECONDS * 1000;
}

// A session bearer grants only its own poll/ack/renew surface. No alias resolution,
// shared-token fallback, mailbox deletion, inject, listing, or other-session access.
function authorizeMailboxRequest(req, sessions, credentials) {
  const principal = credentials.verify(req.headers?.['x-telepty-session-token']);
  if (!principal) return false;
  const session = Object.prototype.hasOwnProperty.call(sessions, principal.sid) && sessions[principal.sid];
  if (!session || session.type !== 'mailbox' || session.sessionEpoch !== principal.epoch
      || (session.credentialGeneration || 1) !== principal.generation) return false;
  if (req.method === 'POST' && req.path === '/api/sessions/register') {
    return req.body?.session_id === principal.sid;
  }
  const match = /^\/api\/sessions\/([^/]+)\/(mailbox(?:\/ack)?|lease)$/.exec(req.path);
  if (!match) return false;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return false; }
  if (id !== principal.sid) return false;
  return (req.method === 'GET' && match[2] === 'mailbox')
    || (req.method === 'POST' && ['mailbox/ack', 'lease'].includes(match[2]));
}

function renewMailboxLease(session, leaseSeconds, persistSessions, nowMs = Date.now()) {
  const previous = { leaseExpiresAt: session.leaseExpiresAt, lastActivityAt: session.lastActivityAt,
    lastConnectedAt: session.lastConnectedAt, lastDisconnectedAt: session.lastDisconnectedAt };
  session.leaseExpiresAt = nowMs + leaseSeconds * 1000;
  session.lastActivityAt = new Date(nowMs).toISOString();
  session.lastConnectedAt = session.lastActivityAt;
  session.lastDisconnectedAt = null;
  const saved = persistSessions();
  if (!saved?.ok) {
    if (!saved?.committed) Object.assign(session, previous);
    return { success: false, code: 'SESSION_STORE_WRITE_FAILED', error: 'Session store write failed.' };
  }
  return { success: true, session_id: session.id, type: 'mailbox', lease_expires_at: session.leaseExpiresAt };
}

module.exports = { parseMailboxLease, mailboxLeaseAlive, authorizeMailboxRequest, renewMailboxLease };
