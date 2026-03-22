'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  attachInteractiveTerminal,
  getTerminalSize,
  restoreTerminalModes,
  TERMINAL_CLEANUP_SEQUENCE
} = require('../interactive-terminal');

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

class FakeOutput extends EventEmitter {
  constructor() {
    super();
    this.columns = undefined;
    this.rows = undefined;
    this.writes = [];
  }

  write(value) {
    this.writes.push(value);
  }
}

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

test('interactive terminal cleanup restores terminal keyboard modes', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const cleanup = attachInteractiveTerminal(input, output, {});

  cleanup();

  assert.deepEqual(output.writes, [TERMINAL_CLEANUP_SEQUENCE]);
});

test('restoreTerminalModes falls back to output.write when fd is unavailable', () => {
  const output = new FakeOutput();

  restoreTerminalModes(output);

  assert.deepEqual(output.writes, [TERMINAL_CLEANUP_SEQUENCE]);
});

test('getTerminalSize falls back to environment and defaults when output size is missing', () => {
  const output = new FakeOutput();
  const originalColumns = process.env.COLUMNS;
  const originalLines = process.env.LINES;

  process.env.COLUMNS = '132';
  process.env.LINES = '48';
  assert.deepEqual(getTerminalSize(output, { cols: 80, rows: 24 }), { cols: 132, rows: 48 });

  delete process.env.COLUMNS;
  delete process.env.LINES;
  assert.deepEqual(getTerminalSize(output, { cols: 90, rows: 33 }), { cols: 90, rows: 33 });

  if (originalColumns === undefined) delete process.env.COLUMNS;
  else process.env.COLUMNS = originalColumns;

  if (originalLines === undefined) delete process.env.LINES;
  else process.env.LINES = originalLines;
});
