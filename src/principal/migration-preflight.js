'use strict';
const { loadPrincipalTrust } = require('./http');
const { readAuthorityFile } = require('./authority-file');
const { parseUnambiguousJSON } = require('./encoding');
const { HTTP_ACTIONS } = require('./proof');

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const opaque = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x20\x7f]/.test(value);
function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function unavailable() {
  throw Object.assign(new Error('Principal static preflight unavailable; input invalid or unsafe'), { code: 'PRINCIPAL_PREFLIGHT_UNAVAILABLE' });
}
function boundaries() {
  return { schema: 'telepty.strict-preflight/v1', mutated: false, network_contacted: false,
    activation_permitted: false, authenticated_registration: 'unverified', inventory_completeness: 'unverified',
    runtime_authorization: 'unverified', report_delegation: 'disabled', foreign_trust_expansion: 'disabled' };
}
function inspectPrincipalMigration({ trustFile, inventoryFile }) {
  try {
    const trust = loadPrincipalTrust(trustFile);
    const inventory = parseUnambiguousJSON(readAuthorityFile(inventoryFile, { maximum: 64 * 1024 }));
    if (!fields(inventory, ['schema', 'audience', 'clients']) || inventory.schema !== 'telepty.strict-client-inventory/v1'
        || inventory.audience !== trust.audience || !Array.isArray(inventory.clients)
        || inventory.clients.length < 1 || inventory.clients.length > 128) unavailable();
    const ids = new Set();
    const clients = inventory.clients.map(client => {
      const signed = client?.authentication === 'principal-v1';
      if (!fields(client, signed ? ['id', 'authentication', 'requirements', 'key_id', 'principal_id'] : ['id', 'authentication', 'requirements'])
          || !identifier(client.id) || ids.has(client.id) || !['principal-v1', 'legacy'].includes(client.authentication)
          || (signed && (!identifier(client.key_id) || !identifier(client.principal_id)))
          || !Array.isArray(client.requirements) || client.requirements.length < 1 || client.requirements.length > 128) unavailable();
      ids.add(client.id);
      const requirements = new Set();
      for (const requirement of client.requirements) {
        if (!fields(requirement, ['action', 'target']) || !HTTP_ACTIONS.includes(requirement.action) || !opaque(requirement.target)) unavailable();
        const binding = JSON.stringify([requirement.action, requirement.target]);
        if (requirements.has(binding)) unavailable();
        requirements.add(binding);
      }
      const key = signed ? trust.keys.get(client.key_id) : null;
      const reason = !signed ? 'legacy_authentication' : !key ? 'key_not_configured'
        : key.id !== client.principal_id ? 'principal_mismatch'
        : !client.requirements.every(required => key.grants.some(grant => grant.action === required.action
          && (grant.targets.includes(required.target) || grant.targets.includes('*')))) ? 'declared_grant_missing' : 'declared_grants_match';
      return { id: client.id, grants_match: reason === 'declared_grants_match', reason };
    });
    return { ...boundaries(), client_count: clients.length, all_declared_grants_match: clients.every(client => client.grants_match), clients };
  } catch { unavailable(); }
}
module.exports = { inspectPrincipalMigration, boundaries };
