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

const ROOT = path.resolve(__dirname, '..');
const AUTH = path.join(ROOT, 'auth.js');

// auth.js resolves CONFIG_FILE from os.homedir() at module load, so each case gets its own HOME
// and its own child process. Never the real ~/.telepty — that is the incident this file prevents.
function withHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-835-'));
  fs.mkdirSync(path.join(home, '.telepty'), { recursive: true, mode: 0o700 });
  return { home, cfg: path.join(home, '.telepty', 'config.json') };
}

function seed(cfg, bytes) {
  fs.writeFileSync(cfg, bytes, { mode: 0o600 });
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

test('no config at all still mints one — first run is the only place a token is created', () => {
  const { home, cfg } = withHome();
  try {
    assert.equal(fs.existsSync(cfg), false);
    const first = runGetConfig(home);
    assert.equal(first.ok, true);
    assert.match(first.token, /^[0-9a-f-]{36}$/i);
    assert.equal((fs.statSync(cfg).mode & 0o777), 0o600, 'minted config stays 0600');

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
    const tokens = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'inherit']
      });
      let out = '';
      p.stdout.on('data', (c) => { out += c; });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
    })));
    assert.equal(new Set(tokens).size, 1, `all 8 must agree, got ${JSON.stringify(tokens)}`);
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).authToken, tokens[0]);
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
    let stderr = '';
    let stdout = '';
    d.stderr.on('data', (c) => { stderr += c; });
    d.stdout.on('data', (c) => { stdout += c; });
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { d.kill('SIGKILL'); reject(new Error('daemon did not exit')); }, 20000);
      d.on('exit', (c) => { clearTimeout(t); resolve(c); });
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
