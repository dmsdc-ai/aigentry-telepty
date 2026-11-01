#!/usr/bin/env node
// telepty #879 — argument-safe entrypoint for the package test scripts.
//
// npm runs a package script through cmd.exe on Windows, and cmd.exe refuses a command line above
// 8191 characters. The expanded `node --require … --test <every file>` script crossed that limit
// (job 124456824499: "The command line is too long.", no test started). This runner keeps the SAME
// node argv — preload, flags and files in inventory order — but hands it as an argv array straight
// to process.execPath with shell:false, so only `node scripts/run-tests.mjs <mode>` crosses a shell.
//
// Usage: node scripts/run-tests.mjs [--suites <inventory.json>] <mode>
//   The inventory defaults to scripts/test-suites.json. Paths in it resolve against the current
//   directory, exactly as they did inside the npm script. A usage or inventory error exits 2
//   before anything is spawned. Otherwise the direct child's exit code, or the signal that ended
//   it, becomes this process's own outcome. No timeout, retry, skip or concurrency override.
//
// Built-in modules only.

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const SCHEMA = 'telepty-test-suites/v1';
const DEFAULT_SUITES = join(dirname(fileURLToPath(import.meta.url)), 'test-suites.json');

function fail(message) {
  process.stderr.write(`run-tests: ${message}\nusage: node scripts/run-tests.mjs [--suites <inventory.json>] <mode>\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const rest = [...argv];
  let suitesPath = DEFAULT_SUITES;
  if (rest[0] === '--suites') {
    if (rest.length < 2) fail('missing value for --suites');
    suitesPath = resolve(rest[1]);
    rest.splice(0, 2);
  }
  if (rest.length === 0) fail('missing mode');
  if (rest.length > 1) fail(`unexpected arguments: ${JSON.stringify(rest.slice(1))}`);
  return { suitesPath, mode: rest[0] };
}

const isPathList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0 && !s.startsWith('-'));

function buildArgs(suitesPath, mode) {
  let inventory;
  try {
    inventory = JSON.parse(readFileSync(suitesPath, 'utf8'));
  } catch (e) {
    fail(`cannot read inventory ${suitesPath}: ${e.message}`);
  }
  if (!inventory || inventory.schema !== SCHEMA) fail(`${suitesPath}: expected schema ${SCHEMA}`);
  const modes = inventory.modes && typeof inventory.modes === 'object' ? inventory.modes : {};
  if (!Object.hasOwn(modes, mode)) fail(`unknown mode ${JSON.stringify(mode)} (known: ${Object.keys(modes).join(', ')})`);
  const suite = modes[mode];
  const { preload } = inventory;
  if (!isPathList(preload)) fail('preload must be an array of paths');
  if (!suite || typeof suite !== 'object') fail(`${mode}: suite must be an object`);
  const { flags, files } = suite;
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string' && f.startsWith('--'))) fail(`${mode}: flags must be an array of --options`);
  if (!isPathList(files) || files.length === 0) fail(`${mode}: files must be a non-empty array of paths`);
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file)) fail(`${mode}: duplicate file ${file}`);
    seen.add(file);
  }
  for (const file of [...preload, ...files]) {
    let isFile = false;
    try { isFile = statSync(resolve(file)).isFile(); } catch { /* reported below */ }
    if (!isFile) fail(`${mode}: not a file: ${file}`);
  }
  return [...preload.flatMap((p) => ['--require', p]), ...flags, ...files];
}

const { suitesPath, mode } = parseArgs(process.argv.slice(2));
const args = buildArgs(suitesPath, mode);
const child = spawn(process.execPath, args, { stdio: 'inherit', shell: false });

// Ctrl+C already reaches the child (same process group / console): stay alive until it exits so
// its outcome is the one reported. A SIGTERM/SIGHUP addressed to this process alone is forwarded.
const handlers = new Map([
  ['SIGINT', () => {}],
  ['SIGTERM', () => child.kill('SIGTERM')],
  ['SIGHUP', () => child.kill('SIGHUP')],
]);
for (const [signal, handler] of handlers) process.on(signal, handler);
const release = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };

child.on('error', (e) => {
  release();
  process.stderr.write(`run-tests: cannot start ${process.execPath}: ${e.message}\n`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  release();
  if (signal) {
    process.kill(process.pid, signal);
    // Reached only if the re-raised signal did not end this process.
    process.exitCode = 128 + (os.constants.signals[signal] ?? 0);
    return;
  }
  process.exitCode = code;
});
