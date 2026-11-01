'use strict';
const fs = require('node:fs');
const { claudeColor, codexUpdate, paint } = require('../test/fixtures/captured-selector-39');
// A synthetic TUI; it is never an installed provider CLI.
process.stdout.write(paint(process.env.TELEPTY_FAKE_TUI_MODE === 'update' ? codexUpdate : claudeColor));
process.stdin.setRawMode(true); process.stdin.resume();
let input = '';
process.stdin.on('data', bytes => {
  input += bytes.toString();
  if (input.includes('EXIT')) return process.exit(0);
  if (input.endsWith('\r')) {
    const selected = input.includes('\x1b[B') ? 'blue' : 'red';
    const previous = fs.existsSync(process.env.TELEPTY_FAKE_TUI_RESULT) ? JSON.parse(fs.readFileSync(process.env.TELEPTY_FAKE_TUI_RESULT, 'utf8')).count : 0;
    fs.writeFileSync(process.env.TELEPTY_FAKE_TUI_RESULT, JSON.stringify({ selected, count: previous + 1 }), { mode: 0o600 });
    input = '';
    process.stdout.write('\x1b[2J\x1b[HSELECTED:' + selected + '\r\n');
  }
});
