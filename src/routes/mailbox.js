'use strict';
const { parseMailboxLease, renewMailboxLease } = require('../mailbox/poll-session');

function registerMailboxRoutes(app, { sessions, resolveSessionAlias, getMailbox, sessionCredentials, persistSessions }) {
  app.get('/api/sessions/:id/mailbox', (req, res) => {
    const id = resolveSessionAlias(req.params.id);
    if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
    try {
      const pollOnly = sessions[id].type === 'mailbox';
      let pending = getMailbox().peek(id, { includePayload: pollOnly });
      if (req.query.since) {
        const index = pending.findIndex(msg => msg.msg_id === req.query.since);
        if (index === -1) return res.status(400).json({ code: 'UNKNOWN_CURSOR', error: 'since must name a mailbox message.' });
        pending = pending.slice(index + 1);
      }
      if (pollOnly) pending = pending.filter(msg => msg.state === 'pending' || msg.state === 'in_flight');
      const deadLetter = getMailbox().peekDeadLetter(id);
      res.json({ session_id: id, pending, dead_letter: deadLetter });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/mailbox/ack', (req, res) => {
    const id = resolveSessionAlias(req.params.id);
    if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
    const { msg_id } = req.body;
    if (typeof msg_id !== 'string' || !msg_id) return res.status(400).json({ error: 'msg_id is required' });
    try {
      if (sessions[id].type === 'mailbox' && !getMailbox().peek(id).some(msg => msg.msg_id === msg_id && ['pending', 'in_flight'].includes(msg.state))) {
        return res.status(404).json({ code: 'MESSAGE_NOT_FOUND', error: 'Pending mailbox message not found.' });
      }
      getMailbox().ack(id, msg_id);
      res.json({ success: true, msg_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/lease', (req, res) => {
    // Renewal uses exact ids, never an alias that could resolve to another owner.
    const id = req.params.id;
    const session = Object.prototype.hasOwnProperty.call(sessions, id) && sessions[id];
    if (!session || session.type !== 'mailbox') return res.status(404).json({ error: 'Mailbox session not found.' });
    if (!sessionCredentials.matches(id, req.headers['x-telepty-session-token'])) {
      return res.status(403).json({ code: 'SESSION_CREDENTIAL_REQUIRED', error: 'Current session credential is required.' });
    }
    if (session.isClosing) return res.status(409).json({ code: 'SESSION_CLOSING', error: 'Session is closing' });
    const lease = parseMailboxLease(req.body?.lease_seconds);
    if (lease.error) return res.status(400).json({ code: 'INVALID_LEASE', error: lease.error });
    const renewed = renewMailboxLease(session, lease.seconds, persistSessions);
    res.status(renewed.success ? 200 : 503).json(renewed);
  });

  app.delete('/api/sessions/:id/mailbox', (req, res) => {
    const id = resolveSessionAlias(req.params.id);
    if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
    try {
      getMailbox().purge(id);
      res.json({ success: true, session_id: id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/sessions/:id/mailbox/dead-letter', (req, res) => {
    const id = resolveSessionAlias(req.params.id);
    if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
    try {
      getMailbox().purgeDeadLetter(id);
      res.json({ success: true, session_id: id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerMailboxRoutes };
