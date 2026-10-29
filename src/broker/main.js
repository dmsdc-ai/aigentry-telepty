'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { parseUnambiguousJSON } = require('../principal/encoding');
const { createBrokerHub } = require('./hub');
const { createBrokerNode, createBrokerClient } = require('./node');
const { error } = require('./http');
function readFile(file, maximum, privateFile = false) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > maximum
    || (privateFile && process.platform !== 'win32' && (before.mode & 0o077))) throw error('BROKER_FILE_UNSAFE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const after = fs.fstatSync(fd);
    if (after.ino !== before.ino || after.dev !== before.dev) throw error('BROKER_FILE_UNSAFE');
    const bytes = Buffer.alloc(maximum + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > maximum) throw error('BROKER_FILE_UNSAFE');
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function loadConfiguration(configFile) {
  const config = parseUnambiguousJSON(readFile(configFile, 100 * 1024));
  if (typeof config.private_key_path !== 'string') throw error('BROKER_CONFIG_INVALID');
  const privateKey = crypto.createPrivateKey(readFile(config.private_key_path, 16 * 1024, true));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw error('BROKER_KEY_INVALID');
  return { config, privateKey };
}
async function runBrokerRequest(mode, configFile, parameters) {
  const { config, privateKey } = loadConfiguration(configFile);
  if (config.schema !== 'telepty.broker-source/v1') throw error('BROKER_CONFIG_INVALID');
  const client = createBrokerClient({ config, privateKey });
  let result;
  if (mode === 'inject' && parameters.length === 5) {
    const [node, sid, epoch, key, prompt] = parameters;
    result = await client.inject(node, sid, { prompt, expected_epoch: epoch, idempotency_key: key, no_enter: true });
  } else if (mode === 'receipt' && parameters.length === 1) result = await client.receipt(parameters[0]);
  else throw error('BROKER_REQUEST_INVALID');
  console.log(JSON.stringify(result.body));
  if (result.status >= 400 || ['failed', 'outcome_unknown'].includes(result.body.state)) process.exitCode = 1;
  return result;
}
async function runBrokerCommand(mode, configFile) {
  const { config, privateKey } = loadConfiguration(configFile);
  let running;
  if (mode === 'hub') {
    if (!config.listen || typeof config.listen.host !== 'string' || !Number.isInteger(config.listen.port)
      || config.listen.port < 0 || config.listen.port > 65535) throw error('BROKER_CONFIG_INVALID');
    const tls = config.listen.tls ? { key: readFile(config.listen.tls.key_path, 16 * 1024, true),
      cert: readFile(config.listen.tls.cert_path, 64 * 1024) } : undefined;
    running = createBrokerHub({ config, privateKey, tls });
    const address = await running.listen(config.listen);
    console.log(`Broker v1 listening on ${tls ? 'https' : 'http'}://${address.address}:${address.port}`);
  } else if (mode === 'node') {
    // Only this node's own local credential is read. It never leaves loopback.
    const localToken = require('../../auth').getConfig({ create: false }).authToken;
    running = createBrokerNode({ config, privateKey, localToken });
    await running.start();
    console.log('Broker v1 node connected (foreign session identity unverified)');
  } else throw error('BROKER_MODE_INVALID');
  return new Promise((resolve, reject) => {
    let stopping = false;
    async function close() {
      if (stopping) return;
      stopping = true;
      process.off('SIGTERM', close); process.off('SIGINT', close);
      try { await (mode === 'hub' ? running.close() : running.stop()); resolve(); } catch (reason) { reject(reason); }
    }
    process.once('SIGTERM', close); process.once('SIGINT', close);
    if (mode === 'node') running.completion.then(close, async () => { const unexpected = !stopping; await close(); if (unexpected) process.exitCode = 1; });
  });
}
if (require.main === module) {
  const [mode, flag, configFile] = process.argv.slice(2);
  if (flag !== '--config' || !configFile) { console.error('Usage: broker/main.js <hub|node> --config <file>'); process.exitCode = 1; }
  else runBrokerCommand(mode, configFile).catch(() => { console.error('BROKER_START_OR_CHANNEL_FAILED'); process.exitCode = 1; });
}
module.exports = { runBrokerCommand, runBrokerRequest };
