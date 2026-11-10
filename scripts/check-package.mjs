#!/usr/bin/env node
// Hosted CI only: real tarball, private non-global consumer, no product stubs.
//
// Modes (task 1215 G2; exactly one per run, validated before any side effect):
//   (no arguments)                          self-pack: pack this checkout, then validate it as a consumer (PR CI)
//   --pack-only --out <dir>                 pack this checkout once; write <tarball> + package-manifest.json to <dir>
//   --tarball <file> --manifest <file>      validate THAT archive (same bytes on every OS) against its manifest
// The manifest describes the actual packed bytes (read back out of the tarball, npm additions and a release-built
// Darwin reader included), so a CRLF Windows checkout is never the byte reference for a tarball built elsewhere.
// Consumer validation (self-pack and --tarball): non-global install with scripts enabled, npm ls identity, bins,
// --version/--help/init, macOS installed Darwin authority read, and an installed daemon + PTY smoke.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const USAGE = 'usage: check-package.mjs [--pack-only --out <dir> | --tarball <file> --manifest <file>]';
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--pack-only') { if (out.packOnly) return null; out.packOnly = true; continue; }
    const name = { '--out': 'out', '--tarball': 'tarball', '--manifest': 'manifest' }[key];
    const value = argv[i + 1];
    if (!name || Object.hasOwn(out, name) || typeof value !== 'string' || !value || value.startsWith('--') || !path.isAbsolute(value)) return null;
    out[name] = path.resolve(value); i++;
  }
  const keys = Object.keys(out).sort().join(',');
  if (keys === '') return { mode: 'self' };
  if (keys === 'out,packOnly') return { mode: 'pack', out: out.out };
  if (keys === 'manifest,tarball') return { mode: 'tarball', tarball: out.tarball, manifest: out.manifest };
  return null;
}
const options = parseArgs(process.argv.slice(2));
if (!options) { console.error(USAGE + ' (absolute paths only)'); process.exit(2); }

const checkout = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const read = file => fs.readFileSync(file);
const json = file => JSON.parse(read(file).toString('utf8'));
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
const pkg = json(path.join(checkout, 'package.json'));
const WIN = process.platform === 'win32';
assert.ok(['linux', 'darwin', 'win32'].includes(process.platform), 'Linux/macOS/Windows only');

// Task 1215 consumer84 (failure-only, read-only; POSIX callers only): after the unchanged 15 s "PTY exit after delete"
// deadline has ALREADY failed, ONE bounded `ps` read of the exact PTY child the daemon itself listed (ptyPid of the
// already-fetched session) — state/PID/PPID columns only, never command or environment; nothing is signalled and no
// other pid is looked up. Labels: live | zombie | absent | unknown (no listed pid, ps unavailable/timed out/unparsable).
// The caller appends the label to the ORIGINAL error and rethrows it: no label is ever a pass.
function ptyProcessState(sessions, sid, daemonPid) {
  const entry = Array.isArray(sessions) ? sessions.find((s) => s && s.id === sid) : null;
  const pid = entry ? entry.ptyPid : null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'no_listed_pty_pid' };
  const r = spawnSync('ps', ['-o', 'stat=', '-o', 'pid=', '-o', 'ppid=', '-p', String(pid)],
    { shell: false, timeout: 1000, maxBuffer: 8192, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const base = { pid, ps_status: r.status, ps_signal: r.signal || null, ps_stderr_bytes: Buffer.byteLength(r.stderr || '') };
  if (r.error) return { ...base, state: 'unknown', reason: typeof r.error.code === 'string' ? r.error.code.slice(0, 32) : 'ps_error' };
  const out = String(r.stdout || '').trim();
  if (r.status === 1 && out === '') return { ...base, state: 'absent' };
  const m = /^([A-Za-z<>+]{1,8})\s+(\d+)\s+(\d+)$/.exec(out);
  if (r.status !== 0 || !m || Number(m[2]) !== pid) return { ...base, state: 'unknown', reason: 'ps_unparsable' };
  const ppid = Number(m[3]);
  return { ...base, state: m[1].startsWith('Z') ? 'zombie' : 'live', stat: m[1], ppid, ppid_is_daemon: Number.isSafeInteger(daemonPid) ? ppid === daemonPid : null };
}
assert.equal(pkg.name, '@dmsdc-ai/aigentry-telepty');
assert.equal(pkg.version, '0.11.0');
const DARWIN_READER = 'src/principal/native/prebuilt/darwin/authority-darwin.node';
const DARWIN_PROVENANCE = DARWIN_READER + '.provenance.json';
const DARWIN_LOADER = 'src/principal/authority-file-darwin.js';
const MANIFEST_SCHEMA = 'telepty-package-manifest/v1';
const SHA256 = /^[0-9a-f]{64}$/, SHA1 = /^[0-9a-f]{40}$/, INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const outside = dir => dir !== checkout && !dir.startsWith(checkout + path.sep);

function relative(file) {
  assert.ok(typeof file === 'string' && file.length > 0 && !path.isAbsolute(file));
  assert.ok(!file.includes('\\') && file.split('/').every(p => p && p !== '.' && p !== '..'),
    'canonical package-relative path');
  return file;
}

// npm tarballs are gzip'd ustar with pax/GNU long-name headers. Only regular files (and ignorable directory
// entries) under package/ are accepted; checksums, truncation, traversal and duplicates fail before any install.
function readTarball(gz) {
  const tar = zlib.gunzipSync(gz, { maxOutputLength: 512 * 1024 * 1024 });
  const text = b => { const s = b.toString('utf8'); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z); };
  const octal = b => { const s = text(b).trim(); assert.ok(/^[0-7]*$/.test(s), 'tar numeric field'); return s ? parseInt(s, 8) : 0; };
  const members = new Map();
  let pos = 0, pax = null, longName = null, ended = false;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every(x => x === 0)) { ended = true; break; }
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(sum, octal(header.subarray(148, 156)), 'tar header checksum');
    const size = octal(header.subarray(124, 136));
    assert.ok(Number.isSafeInteger(size) && size >= 0, 'tar member size');
    const body = tar.subarray(pos + 512, pos + 512 + size);
    assert.equal(body.length, size, 'truncated tar member');
    pos += 512 + Math.ceil(size / 512) * 512;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type === 'x') {
      pax = {};
      for (let rest = body.toString('utf8'); rest.length;) {
        const m = /^(\d+) /.exec(rest); assert.ok(m, 'pax record');
        const record = rest.slice(0, Number(m[1])); rest = rest.slice(Number(m[1]));
        const eq = record.indexOf('='); assert.ok(eq > 0 && record.endsWith('\n'), 'pax record');
        pax[record.slice(m[0].length, eq)] = record.slice(eq + 1, -1);
      }
      continue;
    }
    if (type === 'L') { longName = text(body); continue; }
    const prefix = text(header.subarray(345, 500));
    const name = (pax && pax.path) || longName || (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
    pax = null; longName = null;
    assert.ok(name.startsWith('package/'), 'tar member outside package/');
    if (type === '5') { if (name !== 'package/') relative(name.slice(8).replace(/\/$/, '')); continue; }
    assert.equal(type, '0', 'only regular-file tar members');
    const file = relative(name.slice(8));
    assert.ok(!members.has(file), 'duplicate tar member: ' + file);
    members.set(file, { size, sha256: hash(body), body });
  }
  assert.ok(ended, 'tar end-of-archive marker');
  return members;
}

// Universal Mach-O: every slice inside the file, non-overlapping, a 64-bit Mach-O image, archs exactly arm64+x86_64.
function fatSlices(bytes) {
  assert.ok(bytes.length >= 8, 'Mach-O fat header');
  const magic = bytes.readUInt32BE(0), wide = magic === 0xcafebabf;
  assert.ok(magic === 0xcafebabe || wide, 'Mach-O fat magic');
  const count = bytes.readUInt32BE(4), entry = wide ? 32 : 20, table = 8 + count * entry;
  assert.ok(count >= 1 && count <= 8 && table <= bytes.length, 'Mach-O fat arch table');
  const names = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' };
  const slices = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * entry, cpu = bytes.readUInt32BE(at);
    const offset = wide ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
    const size = wide ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12);
    assert.ok(Number.isSafeInteger(offset) && offset >= table && size > 0 && offset + size <= bytes.length, 'slice bounds');
    assert.equal(bytes.readUInt32LE(offset), 0xfeedfacf, 'slice is a 64-bit Mach-O image');
    slices.push({ arch: names[cpu] || 'other', offset, size, sha256: hash(bytes.subarray(offset, offset + size)) });
  }
  slices.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < slices.length; i++) assert.ok(slices[i - 1].offset + slices[i - 1].size <= slices[i].offset, 'slices overlap');
  assert.deepEqual(slices.map(s => s.arch).sort(), ['arm64', 'x86_64'], 'universal arm64 + x86_64');
  return slices;
}

function darwinIdentity(members) {
  for (const file of [DARWIN_READER, DARWIN_PROVENANCE, DARWIN_LOADER]) assert.ok(members.has(file), 'tarball lacks ' + file);
  const reader = members.get(DARWIN_READER), provenance = members.get(DARWIN_PROVENANCE);
  const declared = JSON.parse(provenance.body.toString('utf8'));
  assert.equal(declared.sha256, reader.sha256, 'Darwin provenance names the packed reader bytes');
  assert.equal(declared.bytes, reader.size, 'Darwin provenance byte count');
  const slices = fatSlices(reader.body);
  assert.deepEqual([...declared.archs].sort(), slices.map(s => s.arch).sort(), 'Darwin provenance archs');
  return { path: DARWIN_READER, sha256: reader.sha256, bytes: reader.size, provenance_path: DARWIN_PROVENANCE,
    provenance_sha256: provenance.sha256, slices };
}

function buildManifest(pack, tarBytes, members) {
  return { schema: MANIFEST_SCHEMA, name: pack.name, version: pack.version, filename: pack.filename,
    sha256: hash(tarBytes), shasum: hash(tarBytes, 'sha1'), integrity: 'sha512-' + hash(tarBytes, 'sha512', 'base64'),
    bytes: tarBytes.length, files: [...members].map(([file, m]) => ({ path: file, size: m.size, sha256: m.sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    darwin: darwinIdentity(members) };
}

// Reject a malformed manifest or a tarball that differs from it BEFORE anything is installed. The manifest is
// data only: no field is executed, required or used as a path outside the private ROOT.
function verifyManifest(manifest, tarball, tarBytes, members) {
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest object');
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.name, pkg.name); assert.equal(manifest.version, pkg.version);
  assert.ok(typeof manifest.filename === 'string' && /^[a-zA-Z0-9_.-]+\.tgz$/.test(manifest.filename), 'manifest filename');
  assert.equal(path.basename(tarball), manifest.filename, 'tarball name = manifest filename');
  assert.ok(SHA256.test(manifest.sha256) && SHA1.test(manifest.shasum) && INTEGRITY.test(manifest.integrity), 'manifest hashes');
  assert.equal(hash(tarBytes), manifest.sha256, 'tarball sha256');
  assert.equal(hash(tarBytes, 'sha1'), manifest.shasum, 'tarball sha1');
  assert.equal('sha512-' + hash(tarBytes, 'sha512', 'base64'), manifest.integrity, 'tarball integrity');
  assert.equal(tarBytes.length, manifest.bytes, 'tarball bytes');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 10000, 'manifest files');
  const seen = new Set();
  for (const entry of manifest.files) {
    const file = relative(entry && entry.path);
    assert.ok(!seen.has(file), 'duplicate manifest path: ' + file); seen.add(file);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0 && SHA256.test(entry.sha256), 'manifest entry: ' + file);
    const member = members.get(file);
    assert.ok(member, 'manifest path not in tarball: ' + file);
    assert.equal(member.size, entry.size, 'packed size: ' + file); assert.equal(member.sha256, entry.sha256, 'packed sha256: ' + file);
  }
  assert.equal(seen.size, members.size, 'tarball members not in manifest');
  assert.deepEqual(darwinIdentity(members), manifest.darwin, 'manifest Darwin identity = packed bytes');
}

// Validate the whole command line and every input BEFORE creating anything.
if (options.mode === 'pack') {
  assert.ok(outside(options.out), '--out outside the checkout');
  assert.ok(!fs.existsSync(options.out) || fs.lstatSync(options.out).isDirectory(), '--out is a directory');
}
let tarballInput = null, manifestInput = null, inputMembers = null;
if (options.mode === 'tarball') {
  for (const file of [options.tarball, options.manifest]) {
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'regular input file: ' + path.basename(file));
  }
  assert.ok(fs.lstatSync(options.manifest).size <= 4 * 1024 * 1024, 'manifest size');
  tarballInput = read(options.tarball);
  manifestInput = JSON.parse(read(options.manifest).toString('utf8'));
  inputMembers = readTarball(tarballInput);
  verifyManifest(manifestInput, options.tarball, tarballInput, inputMembers);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-package-')));
let daemonChild = null, passed = false;
try {
  assert.ok(outside(root), 'temp outside checkout');
  const home = path.join(root, 'home');
  const consumer = path.join(root, 'consumer');
  const cache = path.join(root, 'npm-cache');
  const temp = path.join(root, 'tmp');
  for (const dir of [home, consumer, cache, temp]) fs.mkdirSync(dir, { mode: 0o700 });
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
  if (WIN) {
    // OS loader/shell essentials only (no secrets); every per-user location is private to ROOT.
    for (const key of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TMP: temp, TEMP: temp });
    for (const dir of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  function run(program, args, cwd, timeout = 60000) {
    const result = spawnSync(program, args, {
      cwd, env, shell: false, encoding: 'utf8', timeout,
      killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true
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
  // POSIX: npm on PATH (unchanged). win32: npm.cmd cannot be spawned shell-free, so run npm-cli.js under this node.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (WIN) assert.ok(fs.existsSync(npmCli), 'npm-cli.js beside node.exe');
  const npm = (args, cwd, timeout) => (WIN ? run(process.execPath, [npmCli, ...args], cwd, timeout) : run('npm', args, cwd, timeout));

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

  let tarball, tarBytes, members, manifest;
  if (options.mode === 'tarball') {
    // The archive under test is copied into ROOT and re-hashed there; the checkout is never the byte reference.
    tarball = path.join(root, manifestInput.filename);
    fs.copyFileSync(options.tarball, tarball);
    tarBytes = read(tarball); assert.equal(hash(tarBytes), manifestInput.sha256, 'copied tarball sha256');
    members = inputMembers; manifest = manifestInput;
    for (const file of required) assert.ok(members.has(file), 'missing packed asset: ' + file);
  } else {
    run(process.execPath, [path.join(checkout, 'scripts/gen-readme.mjs'), '--check'], checkout);
    const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', root], checkout, 120000));
    assert.ok(Array.isArray(packed) && packed.length === 1, 'one pack result');
    const pack = packed[0];
    assert.equal(pack.name, pkg.name);
    assert.equal(pack.version, pkg.version);
    assert.ok(typeof pack.filename === 'string' && /^[a-zA-Z0-9_.-]+\.tgz$/.test(pack.filename));
    assert.ok(Array.isArray(pack.files) && pack.files.length > 0, 'inventory required');
    const inventory = new Map();
    for (const entry of pack.files) {
      const file = relative(entry.path);
      assert.ok(!inventory.has(file), 'duplicate pack path');
      assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0, 'pack file size');
      inventory.set(file, entry.size);
    }
    tarball = path.join(root, pack.filename);
    assert.ok(fs.lstatSync(tarball).isFile(), 'regular tarball');
    tarBytes = read(tarball);
    assert.equal(pack.shasum, hash(tarBytes, 'sha1'));
    assert.equal(pack.integrity, 'sha512-' + hash(tarBytes, 'sha512', 'base64'));
    for (const file of required) {
      assert.ok(inventory.has(file), 'missing packed asset: ' + file);
      assert.equal(inventory.get(file), read(path.join(checkout, file)).length, 'packed size: ' + file);
    }
    members = readTarball(tarBytes);
    assert.deepEqual([...members.keys()].sort(), [...inventory.keys()].sort(), 'tar members = npm pack inventory');
    for (const [file, size] of inventory) assert.equal(members.get(file).size, size, 'tar size = npm inventory: ' + file);
    for (const file of required) assert.equal(members.get(file).sha256, hash(read(path.join(checkout, file))), 'packed bytes: ' + file);
    manifest = buildManifest(pack, tarBytes, members);
  }
  const tarSha256 = manifest.sha256;
  console.log(JSON.stringify({ package: pkg.name, version: pkg.version, mode: options.mode,
    filename: manifest.filename, integrity: manifest.integrity, sha256: tarSha256, shasum: manifest.shasum,
    files: manifest.files, darwin: { sha256: manifest.darwin.sha256, slices: manifest.darwin.slices } }));

  if (options.mode === 'pack') {
    // Write the archive and its manifest, never overwriting; both are re-read and re-hashed after writing.
    fs.mkdirSync(options.out, { recursive: true, mode: 0o700 });
    const outTarball = path.join(options.out, manifest.filename), outManifest = path.join(options.out, 'package-manifest.json');
    fs.copyFileSync(tarball, outTarball, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(outManifest, JSON.stringify(manifest, null, 1) + '\n', { flag: 'wx', mode: 0o644 });
    verifyManifest(JSON.parse(read(outManifest).toString('utf8')), outTarball, read(outTarball), readTarball(read(outTarball)));
    console.log(JSON.stringify({ result: 'PACKED', package: pkg.name, version: pkg.version, filename: manifest.filename,
      sha256: tarSha256, shasum: manifest.shasum, integrity: manifest.integrity, manifest_sha256: hash(read(outManifest)) }));
  } else {
    fs.writeFileSync(path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'telepty-package-consumer', version: '1.0.0', private: true }) + '\n');
    const installOutput = npm([
      'install', '--prefix', consumer, '--global=false', '--ignore-scripts=false',
      '--foreground-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball
    ], consumer, 300000);
    assert.ok(installOutput.includes('[telepty postinstall] Skipped (non-global install).'),
      'real postinstall non-global branch');
    const installed = path.join(consumer, 'node_modules', '@dmsdc-ai', 'aigentry-telepty');
    assert.deepEqual(json(path.join(installed, 'package.json')), pkg);
    // Every packed file is installed with the packed bytes; in self-pack mode those bytes are also the checkout's.
    for (const entry of manifest.files) {
      const full = path.join(installed, ...entry.path.split('/'));
      assert.ok(fs.lstatSync(full).isFile(), 'installed regular asset: ' + entry.path);
      assert.equal(hash(read(full)), entry.sha256, 'installed bytes: ' + entry.path);
    }
    if (options.mode === 'self') {
      for (const file of required) assert.deepEqual(read(path.join(installed, file)), read(path.join(checkout, file)), 'installed bytes: ' + file);
    }
    // Resolved dependency identity, as npm itself reports it (no range, lock or registry metadata is altered).
    const tree = JSON.parse(npm(['ls', '--all', '--json', '--prefix', consumer], consumer, 120000));
    const top = tree.dependencies && tree.dependencies[pkg.name];
    assert.ok(top && top.version === pkg.version, 'npm ls names the installed package');
    const resolved = {};
    for (const name of Object.keys(pkg.dependencies)) {
      const dep = top.dependencies && top.dependencies[name];
      assert.ok(dep && typeof dep.version === 'string', 'npm ls resolves ' + name);
      resolved[name] = dep.version;
    }
    let total = 0; (function count(node) { for (const child of Object.values((node && node.dependencies) || {})) { total++; count(child); } })(tree);
    console.log(JSON.stringify({ npm_ls: { package: top.version, dependencies: resolved, nodes: total } }));

    for (const [name, file] of Object.entries(pkg.bin)) {
      const target = path.join(installed, file);
      const binDir = path.join(consumer, 'node_modules', '.bin');
      if (WIN) {
        // npm's shims: the interpreter is node and the target is this package's file, relative to .bin.
        const rel = path.relative(binDir, target);
        for (const shim of [name + '.cmd', name + '.ps1']) {
          const text = read(path.join(binDir, shim)).toString('utf8').replace(/\//g, '\\');
          assert.ok(text.includes(rel), 'shim targets ' + file + ': ' + shim);
          assert.ok(/\bnode(\.exe)?\b/i.test(text), 'shim interpreter is node: ' + shim);
        }
        assert.ok(fs.lstatSync(path.join(binDir, name)).isFile(), 'POSIX-shell shim present: ' + name);
      } else {
        const bin = path.join(binDir, name);
        assert.equal(fs.realpathSync(bin), fs.realpathSync(target));
        fs.accessSync(bin, fs.constants.X_OK);
      }
    }
    // install.js (aigentry-telepty, telepty-install) installs services when run: inspected above, never executed.
    const cli = WIN
      ? args => run(process.execPath, [path.join(installed, 'cli.js'), ...args], consumer)
      : args => run(path.join(consumer, 'node_modules', '.bin', 'telepty'), args, consumer);
    assert.equal(cli(['--version']).replace(/\r\n/g, '\n'), pkg.version + '\n');
    const help = cli(['--help']);
    for (const text of ['Connect any terminal to any terminal', 'Session Management:', 'telepty allow', 'telepty session interaction']) {
      assert.ok(help.includes(text), 'installed help missing: ' + text);
    }
    const output = cli(['init', '--print-snippet', '--target', 'all', '--format', 'json']);
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

    if (process.platform === 'darwin') {
      // The installed reader's universal layout, then a REAL readAuthorityFile through it (importing the module
      // alone loads nothing: the binding is lazy). A 0644 control must be refused by the native checks.
      const reader = read(path.join(installed, DARWIN_READER));
      assert.equal(hash(reader), manifest.darwin.sha256, 'installed Darwin reader = packed bytes');
      assert.deepEqual(fatSlices(reader), manifest.darwin.slices, 'installed Darwin slices = packed slices');
      const fixtures = path.join(root, 'authority');
      fs.mkdirSync(fixtures, { mode: 0o700 }); fs.chmodSync(fixtures, 0o700);
      const secret = randomBytes(48), privateFile = path.join(fixtures, 'private.bin'), looseFile = path.join(fixtures, 'loose.bin');
      fs.writeFileSync(privateFile, secret, { mode: 0o600 }); fs.chmodSync(privateFile, 0o600);
      fs.writeFileSync(looseFile, secret, { mode: 0o644 }); fs.chmodSync(looseFile, 0o644);
      const probe = 'const { readAuthorityFile } = require(process.argv[1]); const out = {};'
        + 'try { out.private = readAuthorityFile(process.argv[2], { privateFile: true }).toString("hex"); } catch (e) { out.private_error = [e.code, e.reason]; }'
        + 'try { readAuthorityFile(process.argv[3], { privateFile: true }); out.loose = "read"; } catch (e) { out.loose = [e.code, e.reason]; }'
        + 'process.stdout.write(JSON.stringify(out));';
      const result = JSON.parse(run(process.execPath, ['-e', probe, path.join(installed, 'src/principal/authority-file.js'), privateFile, looseFile], consumer));
      assert.equal(result.private, secret.toString('hex'), 'installed native reader returns the exact private-file bytes');
      assert.ok(Array.isArray(result.loose) && result.loose[0] === 'AUTHORITY_FILE_UNAVAILABLE', 'a 0644 file is refused');
      assert.notEqual(result.loose[1], 'darwin_native_reader_unavailable', 'the refusal came from the loaded native reader');
    }

    // Installed daemon + PTY: ephemeral loopback port, no auto-tailnet (so no firewall path), private HOME; the
    // banner is only a port hint; readiness is /api/health, identity is authenticated /api/meta.
    const smoke = await (async () => {
      // Bounded wait on ONE event; the timer is cleared either way, so no rejection outlives the wait.
      const within = (promise, ms, what) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('deadline: ' + what)), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
      });
      // Resolves when `pattern` appears in the captured stdout; rejects if the child exits first.
      const stdoutEvent = (pattern, what) => new Promise((resolve, reject) => {
        const done = () => { child.stdout.off('data', look); child.off('exit', early); };
        const look = () => { const m = pattern.exec(logs.stdout); if (m) { done(); resolve(m); } };
        const early = (code, signal) => { done(); reject(new Error(what + ': daemon exited first ' + JSON.stringify({ code, signal }))); };
        child.stdout.on('data', look); child.once('exit', early); look();
      });
      const daemonEnv = { ...env, TELEPTY_PORT: '0', HOST: '127.0.0.1', TELEPTY_NO_TAILNET_AUTO: '1' };
      const child = daemonChild = spawn(process.execPath, [path.join(installed, 'cli.js'), 'daemon'],
        { cwd: consumer, env: daemonEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const logs = { stdout: '', stderr: '' };
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { if (logs[stream].length < 2097152) logs[stream] += chunk.toString('utf8'); });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      const closed = new Promise(resolve => child.once('close', () => resolve(true)));
      let token = null, meta = null;
      const redact = text => (token ? text.split(token).join('<redacted>') : text).slice(-4096);
      try {
        const port = Number((await within(stdoutEvent(/listening on http:\/\/127\.0\.0\.1:(\d+)/, 'listening banner'), 30000, 'listening banner'))[1]);
        assert.ok(Number.isSafeInteger(port) && port > 0, 'banner port hint');
        const base = `http://127.0.0.1:${port}`;
        const call = async (route, init = {}) => {
          const res = await fetch(base + route, { ...init, signal: AbortSignal.timeout(10000),
            headers: { ...(token ? { 'x-telepty-token': token } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
          const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch { /* status is the evidence */ }
          return { status: res.status, body };
        };
        const health = await call('/api/health');
        assert.equal(health.status, 200, 'health'); assert.equal(health.body.status, 'ok'); assert.equal(health.body.version, pkg.version);
        token = json(path.join(home, '.telepty', 'config.json')).authToken; // minted in the private HOME by this daemon
        assert.ok(typeof token === 'string' && token.length > 0, 'private daemon token');
        meta = await call('/api/meta');
        assert.equal(meta.status, 200, 'authenticated meta'); assert.equal(meta.body.version, pkg.version);
        assert.equal(meta.body.pid, child.pid, 'meta pid is the owned child');
        assert.ok(/^[A-Za-z0-9_-]{16,64}$/.test(meta.body.instance_id), 'meta instance_id');
        const sid = 'package-smoke-' + process.pid;
        const shell = WIN ? { command: process.env.ComSpec || 'cmd.exe', args: [] } : { command: '/bin/sh', args: [] };
        const spawned = await call('/api/sessions/spawn', { method: 'POST', body: JSON.stringify({ session_id: sid, ...shell, cwd: consumer, cols: 80, rows: 24, type: 'USER' }) });
        assert.ok([200, 201].includes(spawned.status), 'PTY spawn: ' + spawned.status);
        const listed = await call('/api/sessions');
        assert.ok(listed.status === 200 && Array.isArray(listed.body) && listed.body.some(s => s && s.id === sid), 'spawned session listed');
        const ptyExit = stdoutEvent(new RegExp(`\\[EXIT\\] Session ${sid} exited with code`), 'PTY exit');
        ptyExit.catch(() => {}); // observed below through within(); never an unhandled rejection meanwhile
        const removed = await call('/api/sessions/' + encodeURIComponent(sid), { method: 'DELETE' });
        assert.equal(removed.status, 200, 'PTY delete'); assert.equal(removed.body && removed.body.success, true);
        await within(ptyExit, 15000, 'PTY exit after delete') // the daemon's own onExit record for the owned PTY
          .catch((error) => { // Task 1215 consumer84: failure-only, after the unchanged deadline; the same error is rethrown
            if (!WIN) {
              let observed;
              try { observed = ptyProcessState(listed.body, sid, meta && meta.body ? meta.body.pid : null); }
              catch { observed = { state: 'unknown', reason: 'observer_error' }; }
              error.message += ' | pty_process ' + JSON.stringify(observed);
            }
            throw error;
          });
        if (WIN) {
          const stop = await call('/api/daemon/stop', { method: 'POST', body: JSON.stringify({ pid: meta.body.pid, instance_id: meta.body.instance_id }) });
          assert.equal(stop.status, 202, 'graceful stop accepted');
        } else {
          assert.ok(child.kill('SIGTERM'), 'SIGTERM delivered to the owned child');
        }
        const exit = await within(exited, 20000, 'daemon exit');
        await within(closed, 5000, 'daemon stdio close');
        daemonChild = null;
        const refused = await new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.setTimeout(5000);
          s.once('connect', () => { s.destroy(); resolve(false); }); s.once('timeout', () => { s.destroy(); resolve(false); });
          s.once('error', e => resolve(e.code === 'ECONNREFUSED')); });
        assert.ok(refused, 'port closed after stop');
        return { port_hint: port, pid: meta.body.pid, exit, pty: 'spawned+deleted' };
      } catch (error) {
        error.message += ' | daemon ' + JSON.stringify({ stdout: redact(logs.stdout), stderr: redact(logs.stderr) });
        if (child.exitCode === null && child.signalCode === null) {
          // One graceful stop of the OWNED child (the same primitive as the success path), then release its pipes
          // so this helper can report; the hosted job is the disposable boundary for anything left.
          try {
            if (!WIN) child.kill('SIGTERM');
            else if (token && meta && meta.body) await fetch(`http://127.0.0.1:${/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(logs.stdout)?.[1]}/api/daemon/stop`, { method: 'POST',
              headers: { 'x-telepty-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ pid: meta.body.pid, instance_id: meta.body.instance_id }), signal: AbortSignal.timeout(5000) });
          } catch { /* reported by the original error */ }
          child.stdout.destroy(); child.stderr.destroy(); child.unref();
        }
        throw error;
      }
    })();
    console.log(JSON.stringify({ daemon_smoke: smoke }));
    assert.equal(hash(read(tarball)), tarSha256, 'tarball unchanged after installation');
  }
  console.log(JSON.stringify({ result: 'PASS', mode: options.mode, package: pkg.name, version: pkg.version,
    sha256: tarSha256, checkedAssets: options.mode === 'pack' ? manifest.files.length : required.size,
    scope: 'non-global consumer; not global upgrade, daemon recovery or live-agent acceptance' }));
  passed = true;
} finally {
  // Only owned state: an unexited owned daemon is reported (never force-killed); the private ROOT is removed.
  if (daemonChild && daemonChild.exitCode === null && daemonChild.signalCode === null) console.error('owned daemon still running at cleanup (pid ' + daemonChild.pid + ')');
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (error) { if (passed) throw error; console.error('private ROOT cleanup failed: ' + error.code); } // a failure already propagates
}
