'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { combineAbortSignals } = require('../src/broker/http');
test('broker cancellation keeps shutdown and deadline without depending on AbortSignal.any', () => {
  for (const trigger of [0, 1]) {
    const sources = [new AbortController(), new AbortController()];
    const signal = combineAbortSignals(sources.map(source => source.signal));
    assert.equal(signal.aborted, false);
    sources[trigger].abort('selected cause');
    assert.equal(signal.aborted, true); assert.equal(signal.reason, 'selected cause');
    for (const source of sources) assert.equal(getEventListeners(source.signal, 'abort').length, 0);
  }
});
test('broker cancellation preserves already aborted signals without adding listeners', () => {
  const first = new AbortController(), second = new AbortController(); first.abort('before request');
  const signal = combineAbortSignals([first.signal, second.signal]);
  assert.equal(signal.aborted, true); assert.equal(signal.reason, 'before request');
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
});
