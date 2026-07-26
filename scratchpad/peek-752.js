#!/usr/bin/env node
'use strict';
// Peek at a captured pane ring: strip ANSI the same way the daemon's modal predicate does
// and print the tail, plus which #760 patterns match.
const fs = require('fs');
const path = require('path');
const reg = require(path.join(__dirname, '..', 'src', 'prompt-symbol-registry.js'));

const file = process.argv[2] || fs.readdirSync('/tmp/c752-work').filter((f) => f.endsWith('.raw.bin')).map((f) => `/tmp/c752-work/${f}`).sort().pop();
const raw = fs.readFileSync(file, 'utf8');
console.log(`file=${file} bytes=${raw.length}`);
const verdict = reg.detectSurfaceModal('claude', raw);
console.log('detectSurfaceModal(claude):', JSON.stringify(verdict));
console.log('detectOutput(claude).found:', JSON.stringify(reg.detectOutput('claude', raw).found));
const strip = require(path.join(__dirname, '..', 'src', 'screen-ansi.js'));
const text = (strip.stripAnsi ? strip.stripAnsi(raw) : raw);
console.log('--- last 2000 chars of stripped tail ---');
console.log(text.slice(-2000));
