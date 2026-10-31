'use strict';

// #835 — a corrupt config must never destroy the shared secret.
//
// `getConfig()` used to answer an unparseable `~/.telepty/config.json` by minting a new UUID and
// WRITING IT OVER the file: the real token gone, every other key gone, exit 0, nothing thrown.
// Because daemon.js freezes EXPECTED_TOKEN at module load while every CLI process re-reads the
// file, one partial write desynced a long-lived daemon from every subsequent CLI call, forever.
//
// The invariant these tests pin: a secret we cannot read is a condition to REPORT, never to
// silently replace. The bytes on disk are the evidence — every case asserts them unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { EventEmitter, once } = require('events');
const { PassThrough } = require('stream');
const { assertOwnerOnlyMode } = require('../test-support/platform-contract');

const ROOT = path.resolve(__dirname, '..');
const AUTH = path.join(ROOT, 'auth.js');

// auth.js resolves CONFIG_FILE from os.homedir() at module load, so each case gets its own HOME
// and its own child process. Never the real ~/.telepty — that is the incident this file prevents.
function withHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-835-'));
  fs.mkdirSync(path.join(home, '.telepty'), { recursive: true, mode: 0o700 });
  return { home, cfg: path.join(home, '.telepty', 'config.json') };
}

// Task 1215 — a daemon that reached `listening` has a ledger owner (a worker thread IN the daemon process)
// holding .config/aigentry-telepty/tracked-injections.json/segments/* open. ChildProcess.kill() only
// REQUESTS termination; removing the home before the process has exited raced those handles (Windows:
// ENOTEMPTY on segments). Kill stays SIGKILL (no graceful path is simulated); teardown now waits,
// bounded, for the actual 'exit', keeps the home and fails hard if it never comes, and reports a cleanup
// failure together with — never instead of — the body's own failure. No retry, no sleep.
const DAEMON_EXIT_BOUND_MS = 5000;
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}
function remainingEntries(root, max = 40) {
  const out = [];
  (function walk(d, rel) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { if (out.length >= max) return; const r = rel ? `${rel}/${e.name}` : e.name; out.push(e.isDirectory() ? `${r}/` : r); if (e.isDirectory()) walk(path.join(d, e.name), r); }
  })(root, '');
  return out;
}
async function killExitedThenRemove(d, home, bodyError) {
  const failures = [];
  if (d) {
    const exited = waitForExit(d, DAEMON_EXIT_BOUND_MS);
    try { d.kill('SIGKILL'); } catch { /* already gone */ }
    if (!(await exited)) failures.push(new Error(`daemon pid ${d.pid} did not exit within ${DAEMON_EXIT_BOUND_MS}ms of SIGKILL; owned home retained: ${home}`));
  }
  if (!failures.length) {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (error) {
      failures.push(new Error(`owned home cleanup failed after daemon exit (exit=${d ? d.exitCode : 'n/a'} signal=${d ? d.signalCode : 'n/a'}): ${error.code} ${error.path || ''}; body_failed=${!!bodyError}; remaining=${JSON.stringify(remainingEntries(home))}`, { cause: error }));
    }
  }
  if (!failures.length) return;
  if (bodyError) throw new AggregateError([bodyError, ...failures], `test body failed (${bodyError.message}) and owned teardown failed`);
  throw failures[0];
}

function seed(cfg, bytes) {
  fs.writeFileSync(cfg, bytes, { mode: 0o600 });
}

// Task 1215 token15 — every collector whose RESULT is the child's output settles on 'close', not
// 'exit'. Node may emit 'exit' before the stdout/stderr pipes are drained, so an exit-time read can
// see '' from a child that wrote its token and exited 0 (measured, Linux CI on aec1bc3: 8 exits 0,
// 7 identical tokens + 1 '' — an output impossible for auth.js, whose getConfig() either returns a
// non-empty token or throws). 'close' follows the end of every stdio stream, so `out`/`err` are
// complete there; 'error' rejects. The accumulators stay readable while the child runs (the #839
// writer is admitted on its live stderr). Exit-only helpers (waitForExit) prove termination and
// are unchanged.
function collectChild(child) {
  const io = { out: '', err: '' };
  if (child.stdout) child.stdout.on('data', (c) => { io.out += c; });
  if (child.stderr) child.stderr.on('data', (c) => { io.err += c; });
  io.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, out: io.out, err: io.err }));
  });
  return io;
}

// Run getConfig() in a child process with HOME pointed at the fixture. Returns the parsed
// {ok, token, code, message} the child prints, so a throw is data rather than a crashed suite.
function runGetConfig(home) {
  const script = `
    const { getConfig } = require(${JSON.stringify(AUTH)});
    try {
      process.stdout.write(JSON.stringify({ ok: true, token: getConfig().authToken }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, code: e.code, message: e.message }));
    }
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

// Every shape that reaches auth.js as "there is a file here but it holds no usable secret".
// A partial write and an empty file are the field-realistic ones; `{}` / `null` / a non-string
// token are the ones that used to slip THROUGH the try block and hand the daemon
// `EXPECTED_TOKEN === undefined`, which the middleware then matches against a request that
// sends no token at all.
const UNUSABLE = [
  ['a truncated partial write', '{"authToken":"REAL-SECR'],
  ['an empty file', ''],
  ['whitespace only', '   \n'],
  ['valid JSON with no authToken', '{"createdAt":"2026-01-01T00:00:00.000Z"}'],
  ['JSON null', 'null'],
  ['a JSON string, not an object', '"just-a-string"'],
  ['a non-string authToken', '{"authToken":12345}'],
  ['an empty authToken', '{"authToken":""}']
];

for (const [label, bytes] of UNUSABLE) {
  test(`getConfig() refuses ${label} — throws, file untouched`, () => {
    const { home, cfg } = withHome();
    try {
      seed(cfg, bytes);
      const before = fs.readFileSync(cfg);
      const r = runGetConfig(home);

      assert.equal(r.ok, false, 'getConfig() must throw, not return a freshly minted token');
      assert.equal(r.code, 'TELEPTY_CONFIG_UNREADABLE');
      assert.match(r.message, /config\.json/, 'the operator must be told which file');
      assert.deepEqual(fs.readFileSync(cfg), before, 'the file on disk must be byte-identical');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('a valid config is returned intact — every key preserved, file never rewritten', () => {
  const { home, cfg } = withHome();
  try {
    const good = {
      authToken: randomUUID(), // generated, not literal — the assertion is identity, not the value
      createdAt: '2026-01-01T00:00:00.000Z',
      peerAllowlist: ['100.72.155.21']
    };
    seed(cfg, JSON.stringify(good));
    const before = fs.readFileSync(cfg);

    const r = runGetConfig(home);
    assert.equal(r.ok, true);
    assert.equal(r.token, good.authToken);
    assert.deepEqual(fs.readFileSync(cfg), before, 'a readable config is never rewritten');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no config at all still mints one — first run is the only place a token is created', async (t) => {
  const { home, cfg } = withHome();
  try {
    assert.equal(fs.existsSync(cfg), false);
    const first = runGetConfig(home);
    assert.equal(first.ok, true);
    assert.match(first.token, /^[0-9a-f-]{36}$/i);
    await assertOwnerOnlyMode(t, cfg, 'minted config stays 0600'); // #879: named subtest, skipped on win32

    const second = runGetConfig(home);
    assert.equal(second.token, first.token, 'a second call must not re-mint');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('concurrent first-run mints converge on one token — no process loses its secret', { timeout: 30000 }, async () => {
  const { home, cfg } = withHome();
  try {
    const script = `
      const { getConfig } = require(${JSON.stringify(AUTH)});
      process.stdout.write(getConfig().authToken);
    `;
    // Eight processes started together against one empty HOME. Whoever loses the create race
    // must ADOPT the winner's token, not overwrite it — an overwrite here is the same
    // secret-destroying rotation by another door, and it desyncs whichever process already
    // froze the loser's value. This is a race DETECTOR, not a proof: it only goes red when a
    // clobber actually happened, so it never produces a false failure.
    // All eight are spawned before any is awaited (still concurrent); each result is taken at 'close'.
    const tokens = await Promise.all(Array.from({ length: 8 }, () => {
      const p = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'inherit']
      });
      return collectChild(p).done.then(({ code, signal, out }) => {
        if (code === 0 && signal === null) return out.trim();
        throw new Error(`exit ${code}${signal ? ` signal ${signal}` : ''}`);
      });
    }));
    assert.equal(new Set(tokens).size, 1, `all 8 must agree, got ${JSON.stringify(tokens)}`);
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).authToken, tokens[0]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Task 1215 token15 — the collector contract, deterministically. A child may emit 'exit' BEFORE its
// stdout data is read, and 'close' only after every stdio stream has ended. The ADOPTED helper above
// must return the whole output; the pre-token15 exit-time read (kept here only as the negative
// control that names the cause) returns '' for the same order. Synthetic ordering pins the helper's
// contract; it does not claim to reproduce the native CI schedule (the measured Linux run is that).
test('collectChild settles on close: exit before data still yields the whole output (the old exit-time read yields "")', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const io = collectChild(child);
  let oldOut = '';
  child.stdout.on('data', (c) => { oldOut += c; });
  const oldRead = new Promise((resolve) => child.once('exit', (code) => resolve(code === 0 ? oldOut.trim() : null)));

  child.emit('exit', 0, null);
  assert.equal(await oldRead, '', 'negative control: an exit-time read sees no output yet — the measured failure shape');
  child.stdout.end('TOKEN-T');
  child.stderr.end();
  await Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')]);
  child.emit('close', 0, null);
  assert.deepEqual(await io.done, { code: 0, signal: null, out: 'TOKEN-T', err: '' });
});

test('collectChild reports a signal outcome explicitly and rejects on a spawn error', async () => {
  const killed = new EventEmitter();
  killed.stdout = new PassThrough();
  const io = collectChild(killed);
  killed.stdout.end();
  await once(killed.stdout, 'end');
  killed.emit('close', null, 'SIGKILL');
  assert.deepEqual(await io.done, { code: null, signal: 'SIGKILL', out: '', err: '' });

  const broken = new EventEmitter();
  const failed = collectChild(broken).done;
  const boom = new Error('spawn ENOENT');
  broken.emit('error', boom);
  await assert.rejects(failed, (e) => e === boom);
});

// #839 — the first-run write must be ATOMIC, not merely exclusive.
//
// The `flag: 'wx'` above makes the CREATE exclusive, but the bytes then land in the file everyone
// can already see: create, then write. A process that opens config.json inside that window reads
// TRUNCATED JSON — and the fail-closed reader this file pins then (correctly) throws, so it exits
// 1. Where the old code mis-recovered by minting over the file, the fixed code crashes. The
// concurrency test above cannot see it: it is a CLOBBER detector, and it only ever reddened under
// full-suite load, where contention widened the window on its own.
//
// So widen the window on purpose. The child installs a shim that sleeps between the exclusive
// CREATE of a file and the write of its content, and announces the create on stderr so the readers
// are admitted at the widest point of the window rather than at a guessed delay. The shim is fair
// to both versions — it delays whatever file the code creates exclusively. Pre-fix that file is
// config.json itself, so every reader admitted at the marker finds it empty; post-fix it is the
// temp file, and config.json does not exist at all until the atomic link puts it there complete.
function slowMintScript(delayMs) {
  return `
    const fs = require('fs');
    const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
    const realOpen = fs.openSync;
    const realWriteFile = fs.writeFileSync;
    const announceAndStall = () => { fs.writeSync(2, 'CREATED\\n'); sleep(${delayMs}); };

    fs.openSync = (p, flags, mode) => {
      const fd = realOpen(p, flags, mode);
      if (String(flags).includes('x')) announceAndStall();
      return fd;
    };
    // node's writeFileSync(path, ...) opens through its own internals, so widening it needs its
    // own arm: same create → stall → write, just spelled out.
    fs.writeFileSync = (file, data, opts) => {
      const flag = opts && opts.flag;
      if (typeof file === 'string' && typeof flag === 'string' && flag.includes('x')) {
        const fd = realOpen(file, flag, (opts && opts.mode) || 0o666);
        announceAndStall();
        fs.writeSync(fd, data);
        fs.closeSync(fd);
        return;
      }
      return realWriteFile(file, data, opts);
    };

    const { getConfig } = require(${JSON.stringify(AUTH)});
    process.stdout.write(getConfig().authToken);
  `;
}

// getConfig() in a child, no shim, no try/catch: a throw is an exit 1 here, which is exactly the
// failure the fail-closed reader produces when it is handed a half-written file.
function spawnReader(home) {
  const script = `
    const { getConfig } = require(${JSON.stringify(AUTH)});
    process.stdout.write(getConfig().authToken);
  `;
  const p = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Settles at 'close' (complete output); a signal leaves code null, which the caller counts as a failure.
  return collectChild(p).done.then(({ code, signal, out, err }) => ({ code, signal, out: out.trim(), err: err.trim() }));
}

test('a reader that arrives mid-mint never sees a partial config — the write is atomic', { timeout: 30000 }, async (t) => {
  const { home, cfg } = withHome();
  const WINDOW_MS = 1500; // wide enough that four child-process startups fit inside it under load
  try {
    const writer = spawn(process.execPath, ['-e', slowMintScript(WINDOW_MS)], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Live accumulators (the readers are admitted on the writer's stderr marker); the writer's
    // completion is its 'close', so `w.out` is the whole token by the time it is compared below.
    const w = collectChild(writer);
    const writerExit = w.done.then(({ code }) => code);

    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`the writer never announced its exclusive create: ${w.err}`));
      }, 15000);
      const poll = setInterval(() => {
        if (!w.err.includes('CREATED')) return;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }, 10);
    });

    const readers = await Promise.all(Array.from({ length: 4 }, () => spawnReader(home)));
    const writerCode = await writerExit;

    assert.deepEqual(
      readers.filter((r) => r.code !== 0).map((r) => r.err),
      [],
      'a reader admitted while a mint is in flight must never see a file it cannot read'
    );
    assert.equal(writerCode, 0, `the minting process itself must exit 0: ${w.err}`);

    const tokens = [w.out.trim(), ...readers.map((r) => r.out)];
    assert.equal(new Set(tokens).size, 1, `all 5 must agree, got ${JSON.stringify(tokens)}`);
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).authToken, tokens[0]);
    await assertOwnerOnlyMode(t, cfg, 'the atomically placed config stays 0600'); // #879: named subtest, skipped on win32
    assert.deepEqual(
      fs.readdirSync(path.dirname(cfg)),
      ['config.json'],
      'and no temp file is left behind in ~/.telepty'
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The loudness requirement: a `console.warn` from whichever process happened to read the file is
// not enough. The process that must not be fooled is the DAEMON — it freezes the token at module
// load, so a daemon that boots on a replacement secret 401s every call for the rest of its life
// and the operator sees only a fleet of 401s with no cause anywhere. It must refuse to boot.
test('the daemon refuses to boot on an unreadable config, loudly, without rewriting it', { timeout: 30000 }, async () => {
  const { home, cfg } = withHome();
  try {
    seed(cfg, '{"authToken":"REAL-SECR');
    const before = fs.readFileSync(cfg);

    const d = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', TELEPTY_NO_TAILNET_AUTO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Task 1215 token15: the refusal is asserted on its OUTPUT, so it is read at 'close' (complete);
    // the existing 20 s SIGKILL deadline and its message are unchanged.
    const io = collectChild(d);
    const { code, stderr, stdout } = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { d.kill('SIGKILL'); reject(new Error('daemon did not exit')); }, 20000);
      io.done.then((r) => { clearTimeout(t); resolve({ code: r.code, stderr: r.err, stdout: r.out }); },
        (e) => { clearTimeout(t); reject(e); });
    });

    assert.notEqual(code, 0, 'a daemon that cannot read the shared secret must not exit 0');
    assert.match(stderr, /\[AUTH\]/, 'the reason must reach stderr, where a service log keeps it');
    assert.match(stderr, /config\.json/);
    assert.doesNotMatch(stdout, /listening on/, 'it must not start serving');
    assert.deepEqual(fs.readFileSync(cfg), before, 'and it must not have rewritten the file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// #843 C — the recovery configuration the env override exists for was impossible at the daemon.
//
// `TELEPTY_AUTH_TOKEN` is documented (BOUNDARY.md, CHANGELOG.md, and daemon.js's own comment) as
// env-then-file at BOTH ends. The CLI (`cli.js getAuthToken`) and the MCP server genuinely
// short-circuit: with the variable set, `getConfig()` is never called. The daemon evaluated the
// override at line 61 — eleven lines AFTER a `getConfig()` whose failure is `process.exit(1)`.
//
// So with a corrupt config plus a valid env token, the CLI and MCP worked and the daemon exited
// before reaching the check. That combination is not exotic: it is precisely the state an operator
// is in while recovering from the corruption the #835 fail-closed refusal reports. Two
// individually-correct changes — fail closed on an unreadable secret, and honour the env override —
// composing into a whole where the documented escape hatch cannot be used.
//
// `~/.telepty/config.json` is read TWICE at boot: once by `getConfig()` for the secret, once by
// `loadTeleptyConfig()` for optional settings (`idle_ttl_default`). Both had to stop being fatal
// when the secret came from the environment, or the daemon still dies on the second read having
// skipped the first — which is the same defect one layer out.
test('the daemon boots on a corrupt config when TELEPTY_AUTH_TOKEN supplies the secret', { timeout: 30000 }, async () => {
  const { home, cfg } = withHome();
  const ENV_TOKEN = `env-supplied-${randomUUID()}`;
  let d = null; let bodyError = null;
  try {
    seed(cfg, '{"authToken":"REAL-SECR');
    const before = fs.readFileSync(cfg);

    d = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home, PORT: '0',
        TELEPTY_NO_TAILNET_AUTO: '1',
        TELEPTY_AUTH_TOKEN: ENV_TOKEN
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    d.stdout.on('data', (c) => { stdout += c; });
    d.stderr.on('data', (c) => { stderr += c; });

    const listening = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 20000);
      const poll = setInterval(() => {
        if (!/listening on/.test(stdout)) return;
        clearInterval(poll); clearTimeout(deadline); resolve(true);
      }, 50);
      d.on('exit', () => { clearInterval(poll); clearTimeout(deadline); resolve(false); });
    });

    assert.equal(listening, true,
      `the documented recovery path must work at the daemon too. stderr: ${stderr}`);
    // The bytes are still untouched — this is a read that did not happen, not a repair.
    assert.deepEqual(fs.readFileSync(cfg), before, 'it must not have rewritten the unreadable file');
    // §A4: the settings it could not read are reported AS unavailable, not silently defaulted.
    assert.match(stderr, /\[CONFIG\]/,
      'the file it declined to trust must still be named on stderr, where a service log keeps it');

    // And the token in force is the env one: a request bearing it is not 401.
    const port = Number((stdout.match(/listening on http:\/\/[^:]+:(\d+)/) || [])[1]);
    assert.ok(Number.isInteger(port) && port > 0, `could not read the bound port from: ${stdout}`);
    const ok = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { 'x-telepty-token': ENV_TOKEN } });
    assert.equal(ok.status, 200, 'the env-supplied token must be the one the daemon actually enforces');
    const denied = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { 'x-telepty-token': 'REAL-SECR' } });
    assert.notEqual(denied.status, 200, 'and the unreadable file must not have supplied a working one');
  } catch (error) { bodyError = error; throw error; } finally {
    await killExitedThenRemove(d, home, bodyError);
  }
});

test('without the env token nothing changes: a corrupt config is still a refusal', { timeout: 30000 }, async () => {
  // The pairing that makes the change above a PRECEDENCE fix rather than a weakening of #835. The
  // file-only refusal is asserted in full by the test above this block; this one pins that the new
  // env branch cannot be reached by accident — an empty variable is not a supplied secret.
  const { home, cfg } = withHome();
  try {
    seed(cfg, '{"authToken":"REAL-SECR');
    const d = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home, USERPROFILE: home, PORT: '0',
        TELEPTY_NO_TAILNET_AUTO: '1',
        TELEPTY_AUTH_TOKEN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Task 1215 token15: the refusal is asserted on its OUTPUT, so it is read at 'close' (complete);
    // the existing 20 s SIGKILL deadline and its message are unchanged.
    const io = collectChild(d);
    const { code, stderr, stdout } = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { d.kill('SIGKILL'); reject(new Error('daemon did not exit')); }, 20000);
      io.done.then((r) => { clearTimeout(t); resolve({ code: r.code, stderr: r.err, stdout: r.out }); },
        (e) => { clearTimeout(t); reject(e); });
    });

    assert.notEqual(code, 0, 'an empty TELEPTY_AUTH_TOKEN supplies no secret and must not open the recovery path');
    assert.match(stderr, /\[AUTH\]/);
    assert.doesNotMatch(stdout, /listening on/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
