'use strict';

function registerMailboxRoutes(app, { sessions, resolveSessionAlias, getMailbox }) {
  app.get('/api/sessions/:id/mailbox', (req, res) => {
    const id = resolveSessionAlias(req.params.id);
    if (!id || !sessions[id]) return res.status(404).json({ error: 'Session not found' });
    try {
      const pending = getMailbox().peek(id);
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
    if (!msg_id) return res.status(400).json({ error: 'msg_id is required' });
    try {
      getMailbox().ack(id, msg_id);
      res.json({ success: true, msg_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
