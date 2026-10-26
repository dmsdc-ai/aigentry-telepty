'use strict';

// gh#118: the allow/attach bridges forward terminal stdin one chunk at a time and every call
// site decodes each chunk on its own (`data.toString()`), so a multi-byte UTF-8 character that
// the terminal's pty writes across two reads (Ghostty writes 64-byte buffers) reaches the child
// as U+FFFD replacement characters: `객관적으로` → `객관적으���`. The seam that owns stdin is
// `attachInteractiveTerminal`, so the decoder belongs there and this test pins it there.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');

const { attachInteractiveTerminal } = require('../interactive-terminal');

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (value) => { input.rawModes.push(value); };
  return input;
}

test('a UTF-8 character split across two stdin chunks reaches onData intact (gh#118)', async () => {
  const text = '객관적으로 분석해서';
  const bytes = Buffer.from(text, 'utf8');
  const cut = Buffer.byteLength('객관적으', 'utf8') + 1; // one byte into '로' — the observed 128-byte boundary
  const input = fakeTty();
  const received = [];

  const cleanup = attachInteractiveTerminal(input, new PassThrough(), {
    // Exactly what cli.js does with each chunk at every call site.
    onData: (chunk) => received.push(chunk.toString())
  });

  input.write(bytes.subarray(0, cut));
  await tick();
  input.write(bytes.subarray(cut));
  await tick();
  cleanup();

  assert.equal(received.length, 2, 'the two writes must arrive as two chunks, or this test measures nothing');
  const joined = received.join('');
  assert.equal(joined.includes('�'), false, `U+FFFD leaked into the child input: ${JSON.stringify(joined)}`);
  assert.equal(joined, text);
  assert.deepEqual(input.rawModes, [true, false]);
});

test('ASCII control bytes still arrive unchanged after the decoder is attached', async () => {
  const input = fakeTty();
  const received = [];
  const cleanup = attachInteractiveTerminal(input, new PassThrough(), {
    onData: (chunk) => received.push(chunk.toString())
  });

  input.write(Buffer.from('\x1b[200~x\r\x03\x1b[201~', 'binary'));
  await tick();
  cleanup();

  assert.equal(received.join(''), '\x1b[200~x\r\x03\x1b[201~');
});
