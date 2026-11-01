'use strict';
const { error } = require('./http');
const keyValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
function createRoutingClient({ request, source }) {
  const receiptValid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw error('BROKER_RECEIPT_INVALID'); };
  return {
    broadcast(body) { return request('POST', `/v1/nodes/${source}/broadcast`, body, 'broker.broadcast'); },
    broadcastReceipt(key) {
      if (!keyValid(key)) throw error('BROKER_KEY_INVALID');
      return request('GET', `/v1/nodes/${source}/broadcast-receipts/${key}`, {}, 'broker.receipt');
    },
    replyContext(receipt) { receiptValid(receipt); return request('GET', `/v1/nodes/${source}/reply-context/${receipt}`, {}, 'broker.reply_context'); },
    reply(receipt, body) {
      receiptValid(receipt);
      return request('POST', `/v1/nodes/${source}/replies/${receipt}`, body, 'broker.reply', { sessionEpoch: body.expected_epoch });
    }
  };
}
module.exports = { createRoutingClient };
