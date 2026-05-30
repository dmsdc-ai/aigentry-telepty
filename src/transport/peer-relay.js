'use strict';

const crypto = require('crypto');

function relayPeersFromEnv(env = process.env) {
  return (env.TELEPTY_RELAY_PEERS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function createPeerRelay(options) {
  const {
    relayPeers,
    relaySeen = new Set(),
    machineId,
    expectedToken,
    getPort,
    fetchImpl = fetch,
    randomUUID = crypto.randomUUID,
    timeoutSignal = (ms) => AbortSignal.timeout(ms)
  } = options;

  return function relayToPeers(msg) {
    if (relayPeers.length === 0) return;
    if (!msg.message_id) msg.message_id = randomUUID();
    if (relaySeen.has(msg.message_id)) return; // already relayed
    relaySeen.add(msg.message_id);
    // Prevent unbounded growth
    if (relaySeen.size > 10000) {
      const arr = [...relaySeen];
      arr.splice(0, 5000);
      relaySeen.clear();
      arr.forEach(id => relaySeen.add(id));
    }

    msg.source_host = msg.source_host || machineId;
    msg._relayed_from = machineId;

    for (const peer of relayPeers) {
      fetchImpl(`http://${peer}:${getPort()}/api/bus/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telepty-token': expectedToken },
        body: JSON.stringify(msg),
        signal: timeoutSignal(3000)
      }).catch(() => {}); // fire-and-forget
    }
  };
}

module.exports = {
  createPeerRelay,
  relayPeersFromEnv
};
