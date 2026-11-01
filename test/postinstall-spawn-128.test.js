'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hook = require('../scripts/postinstall');

test('#128: installed CLI is launched via Node, independent of PATH shims', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => calls.push('unref');
  const pending = hook.spawnDetachedDaemon(process.execPath, { spawn: (...args) => { calls.push(args); return child; } });
  child.emit('spawn');
  await pending;
  assert.deepEqual(calls[0], [process.execPath, [path.resolve(__dirname, '../cli.js'), 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true }]);
  assert.equal(calls[1], 'unref');
});

test('#128: async respawn failure is reported without success or rollback exception', async () => {
  const logs = [];
  await hook.main({
    env: { npm_config_global: 'true' },
    readDaemonState: () => ({ pid: 123, version: 'old' }),
    detectSupervisor: () => ({ present: false }),
    cleanupDaemonProcesses: () => ({ stopped: [123], failed: [] }),
    spawnDetachedDaemon: async () => { throw new Error('ENOENT'); },
    logger: { log: s => logs.push(s), warn: s => logs.push(s) }
  });
  assert.ok(logs.some(s => /respawn failed: ENOENT/.test(s)));
  assert.ok(!logs.some(s => /spawned fresh/.test(s)));
});

test('#128: actual asynchronous spawn error is handled by the hook helper', () => {
  const script = `require('./scripts/postinstall').spawnDetachedDaemon('/nonexistent/telepty-node').then(() => process.exitCode = 9, e => { console.error(e.code); });`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error'/);
});

// Task 1215 install102 — F2 (frozen diagnostic; expected RED before any fix). The daemon serves /api/meta only behind its
// credential middleware (src/protocol/http-auth.js:218-235: x-telepty-token or ?token= must equal the daemon token, which
// is TELEPTY_AUTH_TOKEN, else <HOME>/.telepty/config.json authToken — daemon.js:324,334; #820: loopback is not a
// credential); only /api/health is public (src/protocol/http-app.js:15-25). Through the UNCHANGED real postinstall main()
// supervisor path — only supervisor detection, daemon state, cleanup and restart are injected, as in the cases above — a
// global upgrade must confirm the restarted daemon's version on that protected route with the operator's existing local
// token. The daemon is an in-process fetch interceptor applying the same admission rule: no listener, no real daemon,
// no real token or service. The dummy credential lives only in this process's preload-isolated HOME
// (test-support/setup-env.js), which that preload deletes when the process exits; this is the file's last case.
test('#1215 F2: a supervised upgrade confirms the new version on the protected /api/meta with the local daemon token', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const pkg = require('../package.json');
  const home = os.homedir();
  // PRECONDITION (a failure, never a skip): only the suite preload's isolated home may receive the fixture credential.
  assert.match(path.basename(home), /^telepty-test-home-/, 'PRECONDITION: HOME must be the preload-isolated test home');
  const DUMMY = 'tp1215-f2-fixture-dummy-local-admin-token';
  const configFile = path.join(home, '.telepty', 'config.json');
  assert.equal(fs.existsSync(configFile), false, 'PRECONDITION: no prior config in the isolated home');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ authToken: DUMMY }), { flag: 'wx', mode: 0o600 });
  const savedEnvToken = process.env.TELEPTY_AUTH_TOKEN;
  delete process.env.TELEPTY_AUTH_TOKEN;   // the usual global-install shell: the daemon token lives in config.json only
  const PORT = 43219;
  const META = `127.0.0.1:${PORT}/api/meta`;
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input));
    const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
    const presented = headers.get('x-telepty-token') ?? url.searchParams.get('token');
    const target = `${url.hostname}:${url.port}${url.pathname}`;
    const credentialed = presented === DUMMY;
    requests.push({ target, credentialed, presented_any: presented !== null });   // never the presented value
    if (target !== META) throw new Error('unexpected request in the F2 fixture');
    if (!credentialed) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ name: pkg.name, version: pkg.version, pid: 4242 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (savedEnvToken === undefined) delete process.env.TELEPTY_AUTH_TOKEN; else process.env.TELEPTY_AUTH_TOKEN = savedEnvToken;
  });

  const logs = [];
  await hook.main({
    env: { npm_config_global: 'true' },
    homeDir: home,
    readDaemonState: () => ({ pid: 123, version: 'old', port: PORT }),
    detectSupervisor: () => ({ present: true, kind: 'launchd' }),
    cleanupDaemonProcesses: () => ({ stopped: [123], failed: [] }),
    restartSupervisorDaemon: () => ({ success: true }),
    waitTimeoutMs: 2000,
    logger: { log: (s) => logs.push(String(s)), warn: (s) => logs.push(String(s)) }
  });

  const evidence = JSON.stringify({ meta_requests: requests.length, credentialed: requests.filter((r) => r.credentialed).length,
    presented_any: requests.filter((r) => r.presented_any).length, unexpected: requests.filter((r) => r.target !== META).length, logs });
  assert.ok(requests.length > 0, `the supervised upgrade must poll /api/meta: ${evidence}`);
  assert.equal(requests.filter((r) => r.target !== META).length, 0, `only the restarted daemon's /api/meta may be asked: ${evidence}`);
  assert.ok(requests.some((r) => r.credentialed), `no /api/meta request carried the local daemon token: ${evidence}`);
  assert.ok(logs.some((s) => s.includes(`launchd started ${pkg.version} daemon (pid 4242)`)), `the new version was not confirmed: ${evidence}`);
  assert.ok(!logs.some((s) => /did not report/.test(s)), evidence);
});
