'use strict';

// Test support (#1207): synthetic 0.9.1 (schema 3) legacy ledgers in exactly the record shape
// beginTrackedInjection + recordObservation/appendLedgerObservation produce (the reproduction
// harness's makeHistoricalRecord). Private synthetic data only; never a live ledger.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const persistence = require('../../../src/session-store/persistence');
const completion = require('../../../src/completion-observation');

const BASE_MS = Date.parse('2026-10-01T00:00:00.000Z');

function makeHistoricalRecord(injectId, sessionId, nObs = 12, baseMs = BASE_MS, state = 'tracked') {
  const created = new Date(baseMs).toISOString();
  const record = { inject_id: injectId, session_id: sessionId, session_epoch: null, session_epoch_reason: 'no_815_epoch_fact',
    transport_source: 'orch', created_at: created, observation_seq: 0, observations: [], last_observation: null,
    capability: { ...completion.CAPABILITY_STAGE_A }, tracking_state: state };
  persistence.appendLedgerObservation(record, { kind: 'tracking_started', trigger: 'inject_accepted' }, created);
  for (let i = 2; i <= nObs; i++) {
    const busy = i % 2 === 0;
    persistence.appendLedgerObservation(record, busy
      ? { kind: 'busy_indicator_pattern_observed', trigger: 'busy_indicator_pattern', matched_line: `synthetic spinner frame ${i}`, confidence: 0.8, emitted_via: 'transition', consumption_status: 'not_established' }
      : { kind: 'output_observed', trigger: 'output_received', confidence: 0.9, emitted_via: 'transition', consumption_status: 'not_established' },
    new Date(baseMs + i * 5000).toISOString());
  }
  return record;
}

/** Build a schema-3 ledger with `count` records (or enough to reach `targetBytes`). */
function buildLegacyLedger({ count = null, targetBytes = null, obsPerRecord = 12, prefix = 'hist', generation = 3 } = {}) {
  const pad = (n) => String(n).padStart(7, '0');
  let n = count;
  if (n == null) {
    const sample = makeHistoricalRecord(`${prefix}-${pad(0)}`, `${prefix}-session-${pad(0)}`, obsPerRecord, BASE_MS);
    const wrapper = Buffer.byteLength(JSON.stringify({ ...persistence.emptyTrackedInjections(), generation }, null, 2));
    const per = Buffer.byteLength(JSON.stringify({ injections: { [sample.inject_id]: sample } }, null, 2)) - Buffer.byteLength(JSON.stringify({ injections: {} }, null, 2)) + 1;
    n = Math.max(1, Math.floor(((targetBytes || 1048576) - wrapper) / per));
  }
  const injections = {};
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${pad(i)}`;
    injections[id] = makeHistoricalRecord(id, `${prefix}-session-${pad(i)}`, obsPerRecord, BASE_MS + i * 60000);
  }
  return { schema_version: persistence.TRACKED_INJECTIONS_SCHEMA_VERSION, generation, injections, interactions: { actions: {}, pending: {} } };
}

/** Write the ledger with the 0.9.1 writer (byte-identical format) and return its identity. */
function writeLegacyLedger(filePath, options = {}) {
  const ledger = options.ledger || buildLegacyLedger(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const saved = persistence.saveTrackedInjections(ledger, filePath);
  if (!saved.ok) throw new Error(`legacy fixture write failed: ${saved.reason}`);
  const bytes = fs.readFileSync(filePath);
  return { ledger, ids: Object.keys(ledger.injections), count: Object.keys(ledger.injections).length, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

module.exports = { BASE_MS, makeHistoricalRecord, buildLegacyLedger, writeLegacyLedger };
