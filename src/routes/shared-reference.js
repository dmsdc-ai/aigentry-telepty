'use strict';
const { commitSharedReference } = require('../shared-reference-transfer');

function registerSharedReferenceRoutes(app) {
  // Registered after the same authentication middleware as the sessions API.
  // The request carries bytes only: no filesystem source or network destination.
  app.post('/api/shared', (req, res) => {
    try { res.json(commitSharedReference(req.body)); }
    catch (error) {
      res.status(error.status || 503).json({ success: false,
        code: error.status ? error.code : 'SHARED_REF_STORAGE_UNAVAILABLE' });
    }
  });
}
module.exports = { registerSharedReferenceRoutes };
