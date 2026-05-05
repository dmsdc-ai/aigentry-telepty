'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildOutput } = require('../src/init/print-snippet');

const projectRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(projectRoot, 'tests', 'snippet-protocol', 'v1');
const targets = ['claude', 'agents', 'gemini', 'all'];
const formats = [
  { name: 'markdown', ext: 'md' },
  { name: 'json', ext: 'json' }
];

function createCaptureStream() {
  return {
    value: '',
    write(chunk) {
      this.value += chunk;
    }
  };
}

fs.mkdirSync(fixtureDir, { recursive: true });

for (const target of targets) {
  for (const format of formats) {
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const code = buildOutput(['--print-snippet', '--target', target, '--format', format.name], {
      stdout,
      stderr
    });

    if (code !== 0) {
      throw new Error(`failed to generate ${target} ${format.name}: ${stderr.value}`);
    }

    const fixturePath = path.join(fixtureDir, `golden-${target}.${format.ext}`);
    fs.writeFileSync(fixturePath, stdout.value, 'utf8');
  }
}
