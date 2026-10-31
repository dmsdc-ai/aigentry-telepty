'use strict';
const crypto = require('node:crypto');
const {canonicalJSON}=require('./encoding');
// Public deterministic correlation, not a secret or a signature. Keep the exact
// existing v1 tuple: stored intents must never acquire a new replay namespace.
function effectReceiptId(namespace,effect,principal,sessionId,epoch,idempotencyKey) {
  return crypto.createHash('sha256').update(canonicalJSON([namespace,...(effect===undefined?[]:[effect]),
    principal.audience,principal.id,principal.keyId,sessionId,epoch,idempotencyKey])).digest('hex');
}
module.exports={effectReceiptId};
