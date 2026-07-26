'use strict';

// #732 — pure decision logic for "the owner socket is alive but the output pipe is dead".
// No processes, no sockets: this pins the production defaults that the end-to-end test
// (test/bridge-output-pipe-732.test.js) deliberately compresses so it can run in seconds.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Requiring daemon.js binds a listener and reads persisted session state. Pin both to
// throwaway values BEFORE the require so a bare require can never contend with the
// operator's daemon on 3848 or rewrite their sessions.json (#524 guard).
process.env.PORT = '0';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tp732-pred-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isUpstreamStalled, armUpstreamProbe } = require('../daemon.js');

test('#732 isUpstreamStalled: only fires when a delivery went unanswered past the threshold', () => {
  const base = () => ({ type: 'wrapped', outputRingTotalBytes: 100 });

  const never = base();
  assert.equal(isUpstreamStalled(never, 1_000_000), false, 'no probe armed → never stalled');

  const fresh = base();
  armUpstreamProbe(fresh, 0);
  assert.equal(isUpstreamStalled(fresh, 29_000), false, 'inside the 30s default → not yet');
  assert.equal(isUpstreamStalled(fresh, 30_000), true, 'at the 30s default → stalled');

  const answered = base();
  armUpstreamProbe(answered, 0);
  answered.outputRingTotalBytes = 101;          // one byte came back
  assert.equal(isUpstreamStalled(answered, 1_000_000), false, 'any upstream byte clears the probe');

  const spawned = { type: 'spawned', outputRingTotalBytes: 0, upstreamProbeAt: 0 };
  assert.equal(isUpstreamStalled(spawned, 1_000_000), false, 'non-wrapped sessions have no owner-WS leg');
});

test('#732 armUpstreamProbe: a burst of deliveries must not keep resetting the clock', () => {
  const s = { type: 'wrapped', outputRingTotalBytes: 100 };
  armUpstreamProbe(s, 0);
  armUpstreamProbe(s, 10_000);
  armUpstreamProbe(s, 20_000);
  assert.equal(s.upstreamProbeAt, 0,
    'the OLDEST unanswered delivery ages — otherwise a chatty caller hides a dead pipe forever');
  assert.equal(isUpstreamStalled(s, 30_000), true);

  s.outputRingTotalBytes = 200;                 // answered
  armUpstreamProbe(s, 40_000);                  // next delivery re-arms from scratch
  assert.equal(s.upstreamProbeAt, 40_000);
  assert.equal(s.upstreamProbeWatermark, 200);
  assert.equal(isUpstreamStalled(s, 69_000), false);
  assert.equal(isUpstreamStalled(s, 70_000), true);
});

test('#732 isUpstreamStalled: threshold is overridable per call', () => {
  const s = { type: 'wrapped', outputRingTotalBytes: 0 };
  armUpstreamProbe(s, 0);
  assert.equal(isUpstreamStalled(s, 5_000, { stallSeconds: 5 }), true);
  assert.equal(isUpstreamStalled(s, 4_999, { stallSeconds: 5 }), false);
});
