'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSustainedIdleObserver, idleObservationConfig } = require('../src/sustained-idle-observation');
const { recordReadyEvidence } = require('../src/readiness');
function session() { return { id: 'worker', command: 'claude', type: 'wrapped', sessionEpoch: 'epoch', interactionOwnerGeneration: 'owner',
  interactionInputGeneration: 0, outputRingTotalBytes: 0, lastActualOutputAt: new Date(0).toISOString(), lastActivityAt: new Date(0).toISOString(),
  lastConnectedAt: new Date(0).toISOString(), ownerWs: { readyState: 1 }, outputRing: [], readyKind: 'composer_surface_observed', readyDetector: 'claude_composer', readyCliKey: 'claude' }; }
function observer(options = {}) { return createSustainedIdleObserver({ thresholdMs: 1000, debounceMs: 100, freshnessMs: 5000, inspectProcess: () => ({ status: 'unknown' }), ...options }); }
const sample = (watcher, s, nowMs, activityState = null) => watcher.observe(s.id, s, { nowMs, machineId: 'host', activityState });
test('quiet composer is qualified readiness, never free/completed; debounce and one edge per episode', () => {
  const s = session(), watcher = observer(); recordReadyEvidence(s, 0); const before = JSON.stringify(s);
  assert.equal(sample(watcher, s, 0), null); assert.equal(sample(watcher, s, 999), null); assert.equal(sample(watcher, s, 1000), null);
  const event = sample(watcher, s, 1100); assert.equal(event.classification, 'composer_ready'); assert.equal(event.completion_fact, null); assert.equal(event.terminal, false);
  assert.equal(event.output_tail_hash.rendered_screen, false); assert.equal(sample(watcher, s, 3000), null); assert.equal(JSON.stringify(s), before);
  s.lastActivityAt = new Date(3001).toISOString(); assert.equal(sample(watcher, s, 3100), null, 'ready/activity timestamp alone does not rearm');
  s.interactionInputGeneration++; assert.equal(sample(watcher, s, 3200), null); recordReadyEvidence(s, 3200);
  assert.equal(sample(watcher, s, 4200), null); assert.equal(sample(watcher, s, 4300).classification, 'composer_ready'); assert.equal(sample(watcher, s, 4400), null);
});
test('busy/quiet/control/stale evidence remain unknown and stable tail is not a hung verdict', () => {
  for (const state of ['working','thinking',null]) {
    const s = session(), watcher = observer(); if (state) recordReadyEvidence(s, 0);
    const activity = state ? { state, since: new Date(0).toISOString() } : null;
    sample(watcher, s, 0, activity); sample(watcher, s, 1000, activity);
    assert.equal(sample(watcher, s, 1100, activity).classification, 'unknown'); assert.equal(sample(watcher, s, 2000, activity), null);
  }
  const s = session(), watcher = observer({ freshnessMs: 500 }); recordReadyEvidence(s, 0);
  sample(watcher, s, 0); sample(watcher, s, 1000); assert.equal(sample(watcher, s, 1100).classification, 'unknown');
});
test('fresh known modal is awaiting_input; stale or previous-owner modal is unknown', () => {
  for (const [timestamp, connected, expected] of [[0,0,'awaiting_input'],[-10000,0,'unknown'],[0,100,'unknown']]) {
    const s = session(), watcher = observer(); s.outputRing = ['Yes, I trust this folder']; s.lastActualOutputAt = new Date(timestamp).toISOString(); s.lastConnectedAt = new Date(connected).toISOString();
    const event = [sample(watcher, s, 0), sample(watcher, s, 1000), sample(watcher, s, 1100)].find(Boolean);
    assert.equal(event.classification, expected);
  }
});
test('actual unavailable transport or measured stopped process is explicit, not inferred from silence', () => {
  for (const change of [s => { s.ownerWs.readyState = 3; }, s => { s.bridgeReadSide = 'destroyed'; s.bridgeHeartbeatAt = new Date(1000).toISOString(); }]) {
    const s = session(), watcher = observer(); change(s); sample(watcher, s, 0); sample(watcher, s, 1000); assert.equal(sample(watcher, s, 1100).classification, 'transport_unavailable');
  }
  const s = session(), watcher = observer({ inspectProcess: () => ({ status: 'observed', state: 'stopped', observed_at: new Date(1000).toISOString() }) });
  sample(watcher, s, 0); sample(watcher, s, 1000); assert.equal(sample(watcher, s, 1100).classification, 'transport_unavailable');
});
test('new output/working transition rearm; owner/epoch replacement cannot inherit candidate or cursor identity', () => {
  const s = session(), watcher = observer(); sample(watcher, s, 0); sample(watcher, s, 1000); assert.ok(sample(watcher, s, 1100));
  s.outputRingTotalBytes++; s.lastActualOutputAt = new Date(1200).toISOString(); assert.equal(sample(watcher, s, 1200), null);
  sample(watcher, s, 2200); assert.ok(sample(watcher, s, 2300));
  const busy = { state: 'working', since: new Date(2400).toISOString() }; assert.equal(sample(watcher, s, 2400, busy), null);
  sample(watcher, s, 3400, busy); assert.equal(sample(watcher, s, 3500, busy).classification, 'unknown');
  s.sessionEpoch = 'new'; assert.equal(sample(watcher, s, 3600), null); assert.equal(sample(watcher, s, 4000), null);
  sample(watcher, s, 4600); assert.equal(sample(watcher, s, 4700).identity.session_epoch, 'new');
});
test('configuration and per-sweep work/hash bounds are enforced', () => {
  assert.throws(() => idleObservationConfig({ TELEPTY_SUSTAINED_IDLE_THRESHOLD_MS: 'Infinity' }));
  assert.throws(() => idleObservationConfig({ TELEPTY_SUSTAINED_IDLE_DEBOUNCE_MS: '60001' }));
  assert.equal(idleObservationConfig({ TELEPTY_SUSTAINED_IDLE: 'off' }).enabled, false);
  const watcher = observer({ maxPerSweep: 1, debounceMs: 0 }), a = session(), b = session(); b.id = 'other'; a.outputRing = ['PRIVATE_CONTENT🙂'.repeat(10000)];
  sample(watcher, a, 0); sample(watcher, b, 0); const event = sample(watcher, a, 1000); assert.ok(event.output_tail_hash.bytes <= 16384);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_CONTENT/); assert.equal(sample(watcher, b, 1000), null); assert.ok(sample(watcher, b, 1100));
});
test('real bus observes stable/working/modal/transport/control once and rearms only after fresh output', { timeout: 15000 }, async () => {
  const { startTestDaemon } = require('../test-support/daemon-harness'); const WebSocket = require('ws');
  const harness = await startTestDaemon({ env: { TELEPTY_HEALTH_POLL_MS: '100', TELEPTY_SUSTAINED_IDLE_THRESHOLD_MS: '1500',
    TELEPTY_SUSTAINED_IDLE_DEBOUNCE_MS: '100', TELEPTY_SUSTAINED_IDLE_FRESHNESS_MS: '10000', TELEPTY_STATE_IDLE_TIMEOUT_MS: '100' } });
  const owners = [], events = []; let bus, inputFrames = 0;
  try {
    bus = await harness.connectBus(); bus.on('message', raw => { const event = JSON.parse(raw); if (event.kind === 'session_sustained_idle_observation') events.push(event); });
    async function own(id, command = 'claude') {
      const created = await harness.registerSession(id, { command, backend: 'pty' }); assert.equal(created.status, 201);
      const owner = new WebSocket(`ws://${harness.host}:${harness.port}/api/sessions/${id}?owner=1`, { headers: { 'x-telepty-token': harness.authToken(), ...harness.ownerAuth(id).headers } });
      owners.push(owner); owner.on('message', raw => { if (JSON.parse(raw).type === 'inject') inputFrames++; });
      await new Promise((resolve, reject) => { owner.once('open', resolve); owner.once('error', reject); });
      return owner;
    }
    const composer = await own('idle-composer'), working = await own('idle-working'), modal = await own('idle-modal'), transport = await own('idle-transport'), control = await own('idle-control', 'fixture');
    const output = (owner, data) => owner.send(JSON.stringify({ type: 'output', data }));
    const ready = owner => owner.send(JSON.stringify({ type: 'ready', ready_kind: 'composer_surface_observed', detector: 'claude_composer', cli_key: 'claude' }));
    output(composer, '❯'); ready(composer);
    output(working, '⠹ Thinking… PRIVATE_WORK'); output(modal, 'Yes, I trust this folder');
    transport.send(JSON.stringify({ type: 'heartbeat', pty_bytes: 0, read_side: 'destroyed' }));
    await harness.waitFor(() => ['idle-composer','idle-working','idle-modal','idle-transport','idle-control'].every(id => events.some(event => event.session_id === id)), { timeoutMs: 5000 });
    const expected = { 'idle-composer': 'composer_ready', 'idle-working': 'unknown', 'idle-modal': 'awaiting_input', 'idle-transport': 'transport_unavailable', 'idle-control': 'unknown' };
    for (const [id, classification] of Object.entries(expected)) {
      const matching = events.filter(event => event.session_id === id); assert.equal(matching.length, 1);
      const event = matching[0]; assert.equal(event.observation.classification, classification);
      assert.equal(event.completion_fact, null); assert.equal(event.terminal, false); assert.equal(event.observation.completion_fact, null);
      assert.equal(event.observation.identity.session_id, id); assert.ok(event.observation.identity.session_epoch);
      assert.equal(event.target, null); assert.equal(event.transport, null); assert.equal(event.semantic, null); assert.ok(event.message_id);
      assert.doesNotMatch(JSON.stringify(event), /PRIVATE_WORK|Yes, I trust this folder/);
    }
    ready(composer); await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(events.filter(event => event.session_id === 'idle-composer').length, 1, 'ready frame alone must not rearm');
    output(composer, '❯'); ready(composer);
    await harness.waitFor(() => events.filter(event => event.session_id === 'idle-composer').length === 2, { timeoutMs: 5000 });
    for (const id of ['idle-working','idle-modal','idle-transport','idle-control']) assert.equal(events.filter(event => event.session_id === id).length, 1);
    assert.equal(events.filter(event => event.session_id === 'idle-composer')[1].observation.classification, 'composer_ready');
    assert.equal(inputFrames, 0, 'observation never sends text or Enter to an owner');
  } finally { bus?.close(); for (const owner of owners) owner.close(); await harness.stop(); }
});
test('empty output chunks cannot force an unbounded readiness/hash tail scan', () => {
  const { outputTail } = require('../src/readiness'); let reads = 0;
  const chunks = new Proxy(Array(100000).fill(''), { get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key); } });
  assert.equal(outputTail({ outputRing: chunks }), ''); assert.equal(reads, 1024);
});
test('clock rollback cannot rearm an emitted episode without fresh work or input', () => {
  const s = session(), watcher = observer({ debounceMs: 0 }); sample(watcher, s, 0); assert.ok(sample(watcher, s, 1000));
  assert.equal(sample(watcher, s, -100), null); assert.equal(sample(watcher, s, 2000), null);
  s.interactionInputGeneration++; assert.equal(sample(watcher, s, 2100), null); assert.ok(sample(watcher, s, 3100));
});
