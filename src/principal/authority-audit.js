'use strict';
const MAX_AUTHORITY_EVENTS = 32;
const FIELDS = ['schema', 'actor', 'at', 'previous_epoch', 'next_epoch', 'previous_generation', 'next_generation',
  'previous_owner_state', 'previous_lease_expires_at', 'pending_count', 'custody_digest'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function normalizeAuthorityAudit(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_AUTHORITY_EVENTS) return null;
  const output = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Object.keys(row).some(key => !FIELDS.includes(key))
        || row.schema !== 'telepty.mailbox-takeover/v1' || !row.actor || !id(row.actor.id) || !id(row.actor.key_id)
        || row.actor.source !== 'ed25519' || typeof row.actor.audience !== 'string' || !row.actor.audience
        || Object.keys(row.actor).some(key => !['id', 'key_id', 'source', 'audience'].includes(key))
        || !Number.isFinite(Date.parse(row.at)) || !/^[A-Za-z0-9_-]{22}$/.test(row.previous_epoch || '')
        || !/^[A-Za-z0-9_-]{22}$/.test(row.next_epoch || '') || !Number.isSafeInteger(row.previous_generation)
        || row.previous_generation < 1 || !Number.isSafeInteger(row.next_generation) || row.next_generation !== row.previous_generation + 1
        || row.previous_owner_state !== 'mailbox_lease_expired' || !Number.isFinite(row.previous_lease_expires_at)
        || !Number.isSafeInteger(row.pending_count) || row.pending_count < 0 || row.pending_count > 1000
        || !/^[a-f0-9]{64}$/.test(row.custody_digest || '')) return null;
    output.push({ schema: row.schema, actor: { id: row.actor.id, key_id: row.actor.key_id, source: 'ed25519', audience: row.actor.audience },
      at: row.at, previous_epoch: row.previous_epoch, next_epoch: row.next_epoch, previous_generation: row.previous_generation,
      next_generation: row.next_generation, previous_owner_state: row.previous_owner_state,
      previous_lease_expires_at: row.previous_lease_expires_at, pending_count: row.pending_count, custody_digest: row.custody_digest });
  }
  return output;
}
module.exports = { MAX_AUTHORITY_EVENTS, normalizeAuthorityAudit };
