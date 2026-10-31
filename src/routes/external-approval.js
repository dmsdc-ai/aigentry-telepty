'use strict';
const { externalApprovalVerifier } = require('../external-approval');
function registerExternalApprovalRoutes(app, { sessions }) {
  app.post('/api/sessions/:id/approval-challenge', (req, res) => {
    const id = req.params.id;
    const session = Object.prototype.hasOwnProperty.call(sessions, id) && sessions[id];
    if (!session || session.isClosing) return res.status(404).json({ code: 'SESSION_NOT_FOUND', error: 'Exact live session not found.' });
    const result = externalApprovalVerifier.challenge(session, req.body);
    return res.status(result.ok ? 200 : result.code === 'APPROVAL_CAPACITY' ? 429 : 400).json(result);
  });
}
module.exports = { registerExternalApprovalRoutes };
