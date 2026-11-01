'use strict';
// Task 1215 owner191 — behavioural controls for test-support/epipe-owner-diagnostic-1215.cjs and its opt-in harness
// wiring. NOT registered in any suite; the diagnostic workflow runs it once per leg, before the real test:ci run.
//
// Two classes, kept apart:
//   [synthetic control]   real child processes loading the EXACT preload over injected fake errors. They prove monitor
//                         semantics only: exit preserved, handled stays handled, results unchanged, owner/PID recorded,
//                         inert without opt-in. They say nothing about ConPTY or about what crashed the real daemon.
//   [real launch wiring]  real Telepty daemons started by the real harness, with and without the opt-in. They prove the
//                         launch wiring and daemon-role attribution only, not a reproduction.
// The same file is also the child script: `node [--require <preload>] <this file> --epipe-owner-control <scenario>`.
// Then only scenario() runs; node:test is never loaded.
const path = require('node:path');

const PRELOAD = path.resolve(__dirname, '..', 'test-support', 'epipe-owner-diagnostic-1215.cjs');
const CONTROL = '--epipe-owner-control';

// The call site every attributed record must name (normalized as repo/test/epipe-owner-diagnostic-1215.test.js:<line>).
function syntheticOwnerWrite(stream) { return stream.write('synthetic'); }
function stdioOwnerWrite(text) { return process.stdout.write(text); }
function failingWritable() {
  const { Writable } = require('node:stream');
  return new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('synthetic EPIPE'), { code: 'EPIPE', syscall: 'write', errno: -32 })); } });
}
function scenario(name) {
  const report = (value) => stdioOwnerWrite(`${JSON.stringify(value)}\n`);
  if (name === 'unhandled') { syntheticOwnerWrite(failingWritable()); return; }
  if (name === 'handled') {
    const stream = failingWritable();
    stream.on('error', (error) => report({ handled: error.code }));
    syntheticOwnerWrite(stream);
    return;
  }
  if (name === 'success') {
    const { Writable, PassThrough } = require('node:stream');
    const chunks = [];
    const sink = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    const writeReturn = syntheticOwnerWrite(sink);
    const emitter = new PassThrough();
    let receiverSame = false, argumentsSeen = null;
    emitter.on('custom', function (...values) { receiverSame = this === emitter; argumentsSeen = values; });
    const emitReturn = emitter.emit('custom', 1, 'two');
    const emitNoListener = emitter.emit('unlistened');
    emitter.on('boom', () => { throw new Error('listener throw'); });
    let thrown = null;
    try { emitter.emit('boom'); } catch (error) { thrown = error.message; }
    sink.end(() => report({ writeReturn, emitReturn, emitNoListener, receiverSame, argumentsSeen, thrown, chunks }));
    return;
  }
  if (name === 'stdio') {
    report({ ready: true });
    process.stdout.emit('error', Object.assign(new Error('synthetic stdout EPIPE'), { code: 'EPIPE', syscall: 'write' }));
    return;
  }
  if (name === 'fork-parent') {
    // Same shape as node-pty's agent fork: default execArgv (so the preload is inherited) and inherited stdio.
    const child = require('node:child_process').fork(__filename, [CONTROL, 'unhandled']);
    child.on('exit', (code, signal) => report({ descendant_pid: child.pid, descendant_exit: code, descendant_signal: signal }));
    return;
  }
  process.exitCode = 64;
}

if (process.argv[2] === CONTROL) {
  scenario(process.argv[3]);
} else {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const CHILD_MS = 15000, STREAM_KEEP = 65536;
  const SELF = 'repo/test/epipe-owner-diagnostic-1215.test.js';

  const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-epipe-owner-control-'));
  function runChild(name, { preload = true, ownerDir = null } = {}) {
    return new Promise((resolve) => {
      const env = { TELEPTY_EPIPE_OWNER_PARENT_PID: String(process.pid) };
      for (const key of ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
      if (ownerDir) env.TELEPTY_EPIPE_OWNER_DIR = ownerDir;
      const child = spawn(process.execPath, [...(preload ? ['--require', PRELOAD] : []), __filename, CONTROL, name],
        { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', spawnError = null;
      child.stdout.on('data', (chunk) => { if (stdout.length < STREAM_KEEP) stdout += String(chunk).slice(0, STREAM_KEEP - stdout.length); });
      child.stderr.on('data', (chunk) => { if (stderr.length < STREAM_KEEP) stderr += String(chunk).slice(0, STREAM_KEEP - stderr.length); });
      child.on('error', (error) => { spawnError = error.code || 'spawn_error'; });
      const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_MS);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const lines = stdout.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { unparsed: true }; } });
        resolve({ pid: child.pid, code, signal, stdout, stderr, lines, spawnError });
      });
    });
  }
  function records(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/^owner-\d+\.jsonl$/.test(name)) continue;
      for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) if (line) out.push(JSON.parse(line));
    }
    return out;
  }
  const ofPid = (list, pid) => list.filter((record) => record.pid === pid);
  const events = (list) => list.filter((record) => record.event !== 'start');
  const siteNames = (record, fn) => (record.stream.first_write_site || []).some((frame) => new RegExp(`^${fn} @ ${SELF.replace(/[./]/g, '\\$&')}:\\d+$`).test(frame));

  test('[synthetic control] (a) an unhandled stream error keeps its non-zero exit and is attributed to its owner', async () => {
    const dir = tempDir();
    try {
      const bare = await runChild('unhandled', { preload: false });
      const watched = await runChild('unhandled', { ownerDir: dir });
      // guard193: an uncaught error exits by itself with code 1; a signal, timeout kill or spawn failure must not pass.
      assert.deepEqual([bare.code, bare.signal, bare.spawnError], [1, null, null], 'the unwatched synthetic error must exit 1 by itself');
      assert.deepEqual([watched.code, watched.signal, watched.spawnError], [1, null, null], 'the instrumented child must exit 1 by itself');
      assert.match(watched.stderr, /EPIPE/, 'Node\'s own fatal report is still printed');
      const mine = ofPid(records(dir), watched.pid);
      const unhandled = mine.filter((record) => record.event === 'unhandled_stream_error');
      assert.equal(unhandled.length, 1);
      assert.deepEqual(unhandled[0].error, { name: 'Error', code: 'EPIPE', syscall: 'write', errno: -32 });
      assert.equal(unhandled[0].role, 'daemon');
      assert.equal(unhandled[0].ppid, process.pid);
      assert.equal(unhandled[0].stream.constructor[0], 'Writable');
      assert.equal(unhandled[0].stream.is_stdio, false);
      assert.ok(siteNames(unhandled[0], 'syntheticOwnerWrite'), JSON.stringify(unhandled[0].stream.first_write_site));
      const uncaught = mine.find((record) => record.event === 'uncaught');
      assert.ok(uncaught, 'the passive uncaught monitor recorded the same crash');
      assert.equal(uncaught.matched_stream_record, unhandled[0].seq);
      assert.ok(Buffer.byteLength(JSON.stringify(unhandled[0])) <= 8192);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('[synthetic control] (b) an already-handled stream error is not turned into a fatal or recorded one', async () => {
    const dir = tempDir();
    try {
      const bare = await runChild('handled', { preload: false });
      const watched = await runChild('handled', { ownerDir: dir });
      assert.equal(bare.code, 0);
      assert.equal(watched.code, 0);
      assert.deepEqual(watched.lines, bare.lines);
      assert.deepEqual(watched.lines, [{ handled: 'EPIPE' }]);
      assert.deepEqual(events(ofPid(records(dir), watched.pid)), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('[synthetic control] (c) successful writes and emits keep their results, receiver, arguments and throws', async () => {
    const dir = tempDir();
    try {
      const bare = await runChild('success', { preload: false });
      const watched = await runChild('success', { ownerDir: dir });
      assert.equal(bare.code, 0);
      assert.equal(watched.code, 0);
      assert.deepEqual(watched.lines, bare.lines);
      assert.deepEqual(watched.lines, [{ writeReturn: true, emitReturn: true, emitNoListener: false, receiverSame: true, argumentsSeen: [1, 'two'],
        thrown: 'listener throw', chunks: ['synthetic'] }]);
      assert.deepEqual(events(ofPid(records(dir), watched.pid)), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('[synthetic control] (d) the owner process is recorded: a forked descendant\'s crash is not the parent\'s, stdio is fd-labelled', async () => {
    const dir = tempDir();
    try {
      const parent = await runChild('fork-parent', { ownerDir: dir });
      assert.equal(parent.code, 0, 'the parent survives its descendant\'s crash');
      const [result] = parent.lines;
      assert.ok(result && Number.isInteger(result.descendant_pid), parent.stdout);
      assert.equal(result.descendant_exit, 1, 'the descendant exits 1 by itself');
      assert.equal(result.descendant_signal, null);
      assert.match(parent.stderr, /EPIPE/, 'the descendant\'s fatal report arrives on the inherited stderr (the H6 confound)');
      const all = records(dir);
      const own = ofPid(all, parent.pid);
      assert.deepEqual(own.map((record) => [record.event, record.role]), [['start', 'daemon']], 'nothing fatal is attributed to the parent');
      const descendant = ofPid(all, result.descendant_pid);
      const crash = descendant.find((record) => record.event === 'unhandled_stream_error');
      assert.ok(crash, 'the descendant attributes its own crash');
      assert.equal(crash.role, 'descendant');
      assert.equal(crash.ppid, parent.pid);
      assert.equal(crash.error.code, 'EPIPE');
      assert.ok(siteNames(crash, 'syntheticOwnerWrite'));

      const bareStdio = await runChild('stdio', { preload: false });
      const stdio = await runChild('stdio', { ownerDir: dir });
      assert.deepEqual([bareStdio.code, bareStdio.signal, bareStdio.spawnError], [1, null, null], 'the unwatched stdout error must exit 1 by itself');
      assert.deepEqual([stdio.code, stdio.signal, stdio.spawnError], [1, null, null], 'the instrumented stdout error must exit 1 by itself');
      const stdioCrash = ofPid(records(dir), stdio.pid).find((record) => record.event === 'unhandled_stream_error');
      assert.ok(stdioCrash, 'the stdout stream error is attributed');
      assert.equal(stdioCrash.stream.is_stdio, true);
      assert.equal(stdioCrash.stream.stdio_fd, 'fd1');
      assert.ok(siteNames(stdioCrash, 'stdioOwnerWrite'), JSON.stringify(stdioCrash.stream.first_write_site));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('[synthetic control] (e) without the opt-in the preload is inert in-process and in a child', async () => {
    assert.equal(process.env.TELEPTY_EPIPE_OWNER_DIR, undefined, 'precondition: this test process carries no preload opt-in');
    const stream = require('node:stream');
    const before = { emitOwn: Object.hasOwn(stream.Stream.prototype, 'emit'), writable: stream.Writable.prototype.write, duplex: stream.Duplex.prototype.write,
      socket: Object.getOwnPropertyDescriptor(net.Socket.prototype, 'write'), monitors: process.listenerCount('uncaughtExceptionMonitor'), exits: process.listenerCount('exit') };
    const preload = require(PRELOAD);
    assert.equal(preload.installed(), false);
    assert.equal(Object.hasOwn(stream.Stream.prototype, 'emit'), before.emitOwn);
    assert.equal(stream.Writable.prototype.write, before.writable);
    assert.equal(stream.Duplex.prototype.write, before.duplex);
    assert.deepEqual(Object.getOwnPropertyDescriptor(net.Socket.prototype, 'write'), before.socket);
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before.monitors);
    assert.equal(process.listenerCount('exit'), before.exits);
    // The same normalization the installed preload applies: package-relative, never a user path.
    const root = path.resolve(__dirname, '..');
    assert.equal(preload.normalizeFile(path.join(root, 'node_modules', 'node-pty', 'lib', 'windowsTerminal.js')), 'node-pty/lib/windowsTerminal.js');
    assert.equal(preload.normalizeFile(path.join(root, 'daemon.js')), 'repo/daemon.js');
    assert.equal(preload.normalizeFile(path.join(os.tmpdir(), 'elsewhere', 'x.js')), '<external>');
    assert.equal(preload.normalizeFile('node:internal/streams/destroy'), 'node:internal/streams/destroy');
    const bare = await runChild('success', { preload: false });
    const loadedNoDir = await runChild('success', { preload: true, ownerDir: null });
    assert.equal(loadedNoDir.code, bare.code);
    assert.deepEqual(loadedNoDir.lines, bare.lines);
    const bareFatal = await runChild('unhandled', { preload: false });
    const loadedNoDirFatal = await runChild('unhandled', { preload: true, ownerDir: null });
    assert.deepEqual([bareFatal.code, bareFatal.signal, bareFatal.spawnError], [1, null, null], 'the bare fatal child must exit 1 by itself');
    assert.deepEqual([loadedNoDirFatal.code, loadedNoDirFatal.signal, loadedNoDirFatal.spawnError], [1, null, null], 'the loaded-without-dir fatal child must exit 1 by itself');
  });

  test('[real launch wiring] the harness launches the preload only on opt-in and attributes the daemon role to the owned pid', { timeout: 60000 }, async () => {
    const { startTestDaemon } = require('../test-support/daemon-harness');
    const saved = process.env.TELEPTY_EPIPE_OWNER_DIAGNOSTIC_DIR;
    assert.equal(saved, undefined, 'precondition: the control run itself carries no harness opt-in');
    const plain = await startTestDaemon();
    try { assert.equal('ownerDiagnostic' in plain, false, 'absent opt-in: the returned harness is unchanged'); }
    finally { await plain.stop(); }
    const root = tempDir();
    let watched = null;
    try {
      process.env.TELEPTY_EPIPE_OWNER_DIAGNOSTIC_DIR = root;
      watched = await startTestDaemon();
      delete process.env.TELEPTY_EPIPE_OWNER_DIAGNOSTIC_DIR;
      assert.equal(typeof watched.ownerDiagnostic, 'function');
      await watched.stop();
      const evidence = watched.ownerDiagnostic();
      assert.ok(Number.isInteger(evidence.daemon_pid));
      const daemon = evidence.processes.find((entry) => entry.pid === evidence.daemon_pid);
      assert.ok(daemon, JSON.stringify(evidence));
      assert.equal(daemon.role, 'daemon');
      assert.equal(daemon.ppid, process.pid);
      assert.equal(daemon.entry, 'repo/daemon.js');
      assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 65536);
    } finally {
      delete process.env.TELEPTY_EPIPE_OWNER_DIAGNOSTIC_DIR;
      if (watched && watched.isAlive()) await watched.stop().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
