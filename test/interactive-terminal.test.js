'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { attachInteractiveTerminal } = require('../interactive-terminal');

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.rawModes = [];
    this.resumeCalls = 0;
    this.pauseCalls = 0;
  }

  setRawMode(value) {
    this.rawModes.push(value);
  }

  resume() {
    this.resumeCalls += 1;
  }

  pause() {
    this.pauseCalls += 1;
  }
}

class FakeOutput extends EventEmitter {}

test('attachInteractiveTerminal resumes paused stdin and cleans up listeners', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const received = [];
  let resizeCalls = 0;

  const cleanup = attachInteractiveTerminal(input, output, {
    onData: (chunk) => received.push(chunk.toString()),
    onResize: () => {
      resizeCalls += 1;
    }
  });

  assert.deepEqual(input.rawModes, [true]);
  assert.equal(input.resumeCalls, 1);
  assert.equal(resizeCalls, 1);

  input.emit('data', Buffer.from('hello'));
  assert.deepEqual(received, ['hello']);

  output.emit('resize');
  assert.equal(resizeCalls, 2);

  cleanup();

  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.pauseCalls, 1);

  input.emit('data', Buffer.from('ignored'));
  output.emit('resize');

  assert.deepEqual(received, ['hello']);
  assert.equal(resizeCalls, 2);
});
