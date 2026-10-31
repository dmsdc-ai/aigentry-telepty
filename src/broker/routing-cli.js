'use strict';
const { parseUnambiguousJSON } = require('../principal/encoding');
const { readAuthorityFile } = require('../principal/authority-file');
const { createBrokerClient } = require('./node');
const { error } = require('./http');
async function runBrokerRoutingRequest(mode, configFile, parameters) {
  const { config, privateKey } = require('./main').loadConfiguration(configFile);
  if (config.schema !== 'telepty.broker-source/v1') throw error('BROKER_CONFIG_INVALID');
  const client = createBrokerClient({ config, privateKey });
  let result;
  if (['broadcast', 'reply'].includes(mode)) {
    const offset = mode === 'reply' ? 1 : 0;
    if (parameters.length !== offset + 2 || parameters[offset] !== '--request') throw error('BROKER_REQUEST_INVALID');
    const body = parseUnambiguousJSON(readAuthorityFile(parameters[offset + 1], { maximum: 100 * 1024, privateFile: true }));
    result = mode === 'reply' ? await client.reply(parameters[0], body) : await client.broadcast(body);
  } else if (parameters.length === 1 && mode === 'broadcast-receipt') result = await client.broadcastReceipt(parameters[0]);
  else if (parameters.length === 1 && mode === 'reply-context') result = await client.replyContext(parameters[0]);
  else throw error('BROKER_REQUEST_INVALID');
  console.log(JSON.stringify(result.body));
  if (result.status >= 400 || ['failed', 'outcome_unknown', 'mixed'].includes(result.body.state)) process.exitCode = 1;
  return result;
}
module.exports = { runBrokerRoutingRequest };
