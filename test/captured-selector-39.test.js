'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const interaction = require('../src/interaction');
const { PROFILE, CODEX_PROFILE, createCapturedSelector, encodeCapturedSelector } = require('../src/vt/captured-selector');
const { claudeColor, codexUpdate, paint } = require('./fixtures/captured-selector-39');
function setup(profile = PROFILE) {
  const binding = { sid: 'fixture', session_epoch: 'epoch', credential_generation: 1, owner_generation: 'owner',
    input_generation: 1, geometry_generation: 0, surface_id: 'surface', cols: 140, rows: 30 };
  const provider = createCapturedSelector({ profile, binding: () => binding, cols: 140, rows: 30, sessionId: 'fixture' });
  return { binding, provider };
}
function request(observation, value = 'blue', operation = 'select') {
  return { schema_version: 1, action_id: 'action', interaction_request_id: 'request', identity: { kind: 'manual', sid: 'fixture' },
    expected: Object.fromEntries([...interaction.FENCE_FIELDS, 'question_id'].map(key => [key, observation[key]])),
    operation, value, authority: { provenance: 'controller-policy', reference: 'fixture-policy' }, expires_at: Date.now() + 1000 };
}
test('real pinned VT yields exact captured version-bound typed selector and production writer receipt', async () => {
  const { provider, binding } = setup();
  try {
    provider.feed(paint(claudeColor)); await provider.screen.readFrame({ drainWaitMs: 100 });
    const observation = provider.observe();
    assert.equal(observation.available, true); assert.deepEqual(observation.supported_operations, ['select']);
    assert.equal(observation.version_evidence, 'operator-selected-captured-profile');
    assert.equal(observation.native_behavior_verified, false);
    const writes = [];
    const writer = interaction.createInteractionWriter({ observe: () => provider.observe(), binding: () => binding, encode: encodeCapturedSelector, write: data => writes.push(data) });
    const r = request(observation);
    const receipt = writer({ request: r, request_digest: interaction.digest(r) });
    assert.equal(receipt.stage, 'written'); assert.equal(receipt.bytes_written, 4);
    assert.deepEqual(writes, ['\x1b[B\r']);
    const raw = request(provider.observe(), 'enter', 'key'); raw.action_id = 'raw';
    assert.equal(writer({ request: raw, request_digest: interaction.digest(raw) }).stage, 'refused');
    assert.equal(writes.length, 1);
    binding.input_generation++;
    provider.feed(paint(claudeColor)); await provider.screen.readFrame({ drainWaitMs: 100 });
    const repainted = provider.observe();
    assert.deepEqual(repainted.supported_operations, [], 'identical repaint is not a new prompt or retry authority');
    assert.equal(encodeCapturedSelector({ operation: 'select', value: 'red' }, { ...observation }), null, 'JSON/copy metadata cannot manufacture provider encode capability');
  } finally { provider.dispose(); }
});
test('stale input/geometry/owner/epoch and unsupported profile fail closed', async () => {
  for (const key of ['input_generation', 'geometry_generation', 'owner_generation', 'session_epoch']) {
    const { provider, binding } = setup();
    try { provider.feed(paint(claudeColor)); await provider.screen.readFrame({ drainWaitMs: 100 });
      const old = provider.observe(); binding[key] = typeof binding[key] === 'number' ? binding[key] + 1 : 'changed';
      assert.equal(provider.observe().available, false);
      const writer = interaction.createInteractionWriter({ observe: () => provider.observe(), binding: () => binding, encode: encodeCapturedSelector, write() { throw new Error('must not write'); } });
      const r = request(old); assert.equal(writer({ request: r, request_digest: interaction.digest(r) }).stage, 'refused');
    } finally { provider.dispose(); }
  }
  assert.equal(createCapturedSelector({ profile: 'unknown' }), null);
});
test('update/trust/approval/resume and ambiguous altered questions have no write capabilities', async () => {
  for (const [profile, text] of [[CODEX_PROFILE, codexUpdate], [PROFILE, claudeColor + 'Do you trust the files in this folder?'],
    [PROFILE, claudeColor + 'Yes, auto-accept edits'], [PROFILE, claudeColor + 'Resume a previous session'],
    [PROFILE, claudeColor.replace('Red', 'Delete files')]]) {
    const { provider } = setup(profile);
    try { provider.feed(paint(text)); await provider.screen.readFrame({ drainWaitMs: 100 });
      assert.deepEqual(provider.observe().supported_operations, []);
    } finally { provider.dispose(); }
  }
});
