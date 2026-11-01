'use strict';
const { parseSessionReference } = require('../session-routing');

// Routing claims are useful without being identity proof. Neither the claimed
// hostname nor the request's observed IP authenticates a foreign session.
function claimedReturnMetadata(locator, crossHost = false) {
  if (typeof locator !== 'string' || !locator || locator.length > 512 || /[\x00-\x1f\x7f]/.test(locator)) return null;
  const qualified = Boolean(parseSessionReference(locator).host);
  return { locator, verification: 'unverified', claimed_cross_host: crossHost || qualified,
    host_qualified: qualified };
}
module.exports = { claimedReturnMetadata };
