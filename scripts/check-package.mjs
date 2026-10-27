#!/usr/bin/env node
// Hosted CI only: real tarball, private non-global consumer, no product stubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const checkout = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const read = file => fs.readFileSync(file);
const json = file => JSON.parse(read(file).toString('utf8'));
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
const pkg = json(path.join(checkout, 'package.json'));
assert.ok(['linux', 'darwin'].includes(process.platform), 'Linux/macOS only');
assert.equal(pkg.name, '@dmsdc-ai/aigentry-telepty');
assert.equal(pkg.version, '0.9.2');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-package-')));
try {
  assert.ok(root !== checkout && !root.startsWith(checkout + path.sep), 'temp outside checkout');
  const home = path.join(root, 'home');
  const consumer = path.join(root, 'consumer');
  const cache = path.join(root, 'npm-cache');
  for (const dir of [home, consumer, cache]) fs.mkdirSync(dir, { mode: 0o700 });
  const npmConfig = path.join(root, "user.npmrc");
  const npmGlobalConfig = path.join(root, "global.npmrc");
  for (const file of [npmConfig, npmGlobalConfig]) fs.writeFileSync(file, "", { mode: 0o600 });
  // No inherited tokens, TELEPTY overrides, NODE_OPTIONS or user npm config.
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TMPDIR: root,
    npm_config_cache: cache, npm_config_userconfig: npmConfig,
    npm_config_globalconfig: npmGlobalConfig, npm_config_global: 'false',
    npm_config_ignore_scripts: 'false', npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1', TELEPTY_DISABLE_UPDATE_NOTIFIER: '1'
  };
  function run(program, args, cwd, timeout = 60000) {
    const result = spawnSync(program, args, {
      cwd, env, shell: false, encoding: 'utf8', timeout,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024
    });
    console.log(JSON.stringify({ command: program, args, cwd,
      status: result.status, signal: result.signal,
      error: result.error ? result.error.message : null,
      stdout: result.stdout, stderr: result.stderr }));
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'command interrupted');
    assert.equal(result.status, 0, 'command failed: ' + program);
    return result.stdout;
  }
  run(process.execPath, [path.join(checkout, 'scripts/gen-readme.mjs'), '--check'], checkout);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], checkout, 120000));
  assert.ok(Array.isArray(packed) && packed.length === 1, 'one pack result');
  const pack = packed[0];
  assert.equal(pack.name, pkg.name);
  assert.equal(pack.version, pkg.version);
  assert.ok(typeof pack.filename === 'string' && /^[a-zA-Z0-9_.-]+\.tgz$/.test(pack.filename));
  assert.ok(Array.isArray(pack.files) && pack.files.length > 0, 'inventory required');
  const inventory = new Map();
  function relative(file) {
    assert.ok(typeof file === 'string' && file.length > 0 && !path.isAbsolute(file));
    assert.ok(!file.includes('\\') && file.split('/').every(p => p && p !== '.' && p !== '..'),
      'canonical package-relative path');
    return file;
  }
  for (const entry of pack.files) {
    const file = relative(entry.path);
    assert.ok(!inventory.has(file), 'duplicate pack path');
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0, 'pack file size');
    inventory.set(file, entry.size);
  }
  const tarball = path.join(root, pack.filename);
  assert.ok(fs.lstatSync(tarball).isFile(), 'regular tarball');
  const tarBytes = read(tarball);
  assert.equal(pack.shasum, hash(tarBytes, 'sha1'));
  assert.equal(pack.integrity, 'sha512-' + hash(tarBytes, 'sha512', 'base64'));
  const tarSha256 = hash(tarBytes);
  console.log(JSON.stringify({ package: pkg.name, version: pkg.version,
    filename: pack.filename, integrity: pack.integrity, sha256: tarSha256, files: pack.files }));

  // Current package.files consists of literal files/directories, not glob patterns.
  const required = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  function select(file) {
    relative(file);
    const full = path.join(checkout, file);
    const stat = fs.lstatSync(full);
    assert.ok(!stat.isSymbolicLink(), 'no source distribution symlink');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) select(file + '/' + name);
    } else {
      assert.ok(stat.isFile(), 'regular distribution source');
      required.add(file);
    }
  }
  assert.ok(Array.isArray(pkg.files));
  for (const entry of pkg.files) select(entry.replace(/\/$/, ''));
  select(pkg.main);
  assert.ok(pkg.bin && typeof pkg.bin === 'object');
  for (const entry of Object.values(pkg.bin)) select(entry);
  for (const hook of ['postinstall', 'preuninstall']) {
    const match = /^node (scripts\/[a-z-]+\.js)$/.exec(pkg.scripts[hook]);
    assert.ok(match, 'review changed lifecycle command');
    select(match[1]);
  }
  for (const file of required) {
    assert.ok(inventory.has(file), 'missing packed asset: ' + file);
    assert.equal(inventory.get(file), read(path.join(checkout, file)).length, 'packed size: ' + file);
  }
  fs.writeFileSync(path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'telepty-package-consumer', version: '1.0.0', private: true }) + '\n');
  const installOutput = run('npm', [
    'install', '--prefix', consumer, '--global=false', '--ignore-scripts=false',
    '--foreground-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball
  ], consumer, 300000);
  assert.ok(installOutput.includes('[telepty postinstall] Skipped (non-global install).'),
    'real postinstall non-global branch');
  const installed = path.join(consumer, 'node_modules', '@dmsdc-ai', 'aigentry-telepty');
  assert.deepEqual(json(path.join(installed, 'package.json')), pkg);
  for (const file of required) {
    const full = path.join(installed, file);
    assert.ok(fs.lstatSync(full).isFile(), 'installed regular asset: ' + file);
    assert.deepEqual(read(full), read(path.join(checkout, file)), 'installed bytes: ' + file);
  }
  for (const [name, file] of Object.entries(pkg.bin)) {
    const bin = path.join(consumer, 'node_modules', '.bin', name);
    assert.equal(fs.realpathSync(bin), fs.realpathSync(path.join(installed, file)));
    fs.accessSync(bin, fs.constants.X_OK);
  }
  const bin = path.join(consumer, 'node_modules', '.bin', 'telepty');
  assert.equal(run(bin, ['--version'], consumer), pkg.version + '\n');
  const help = run(bin, ['--help'], consumer);
  for (const text of ['Connect any terminal to any terminal', 'Session Management:', 'telepty allow', 'telepty session interaction']) {
    assert.ok(help.includes(text), 'installed help missing: ' + text);
  }
  const output = run(bin, ['init', '--print-snippet', '--target', 'all', '--format', 'json'], consumer);
  const golden = read(path.join(checkout, 'tests/snippet-protocol/v1/golden-all.json')).toString('utf8');
  assert.equal(output, golden, 'installed NDJSON must match checked-in golden exactly');
  const records = output.trimEnd().split('\n').map(line => JSON.parse(line));
  const targets = ['claude', 'agents', 'gemini'];
  assert.equal(records.length, 3);
  records.forEach((record, index) => {
    assert.deepEqual(Object.keys(record), ['version', 'target', 'sha256', 'body']);
    assert.equal(record.version, 'telepty-snippet/v1');
    assert.equal(record.target, targets[index]);
    assert.equal(typeof record.body, 'string');
    assert.equal(record.sha256, hash(Buffer.from(record.body, 'utf8')));
    assert.equal(record.body, read(path.join(installed, 'src/init/snippets', targets[index] + '.md')).toString('utf8'));
  });
  assert.equal(hash(read(tarball)), tarSha256, 'tarball unchanged after installation');
  console.log(JSON.stringify({ result: 'PASS', package: pkg.name, version: pkg.version,
    sha256: tarSha256, checkedAssets: required.size,
    scope: 'non-global consumer; not global upgrade, daemon recovery or live-agent acceptance' }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
