'use strict';
// A trusted daemon-only fanout. Never enroll sockets in legacy busClients or session.clients.
const APPROVED_TYPES = new Set(['session_connect', 'session_reconnect', 'session_disconnect', 'session_health',
  'session_state_report', 'session_takeover', 'session.idle', 'inject_failed', 'peer_inject_blocked',
  'mailbox_delivered', 'mailbox_delivery_failed', 'mailbox_delivery_unknown']);
function projectSessionEvent(session, sessionId, eventType, event) {
  if (!session || typeof session.sessionEpoch !== 'string' || !APPROVED_TYPES.has(eventType)) return null;
  const result = { schema: 'telepty.session-event/v1', type: eventType, session_id: sessionId,
    session_epoch: session.sessionEpoch, timestamp: new Date().toISOString(), observation_only: true,
    foreign_session_identity_verified: false };
  if (eventType === 'session_health' && ['CONNECTED', 'STALE', 'DISCONNECTED', 'UPSTREAM_STALLED'].includes(event?.transport?.health_status)) {
    result.health_status = event.transport.health_status;
  }
  return result;
}
const subscribers = new WeakMap();
function publishTrustedSessionEvent(session, sessionId, eventType, event) {
  const projected = projectSessionEvent(session, sessionId, eventType, event);
  if (!projected) return;
  for (const send of subscribers.get(session) || []) send(projected);
}
function createSessionEventTransport(deps) {
  return require('./scoped-read').createScopedReadTransport(deps, { prefix:'/api/events/', subscribers,
    authorize:(auth,req)=>auth.authorizeEvents(req), codePrefix:'SESSION_EVENTS', refusalMessage:'Read-only session events refused.',
    type:'session_events',schema:'telepty.read-only-session-events/v1',maxFrameBytes:4096 });
}

module.exports = { createSessionEventTransport, publishTrustedSessionEvent, projectSessionEvent };
