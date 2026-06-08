'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(PROJECT_ROOT, 'cli.js');

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-broker-cli-'));
}

function writeJson(filePath, value, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadCrossMachine(homeDir) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  delete require.cache[require.resolve('../cross-machine')];
  const crossMachine = require('../cross-machine');
  return {
    crossMachine,
    restore() {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      delete require.cache[require.resolve('../cross-machine')];
    }
  };
}

function runCli(args, homeDir, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        NO_UPDATE_NOTIFIER: '1',
        TELEPTY_DISABLE_UPDATE_NOTIFIER: '1',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, 12000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

function startJsonServer(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : null;
      handler(req, res, body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

test('connectBroker writes broker.json mode 0600 and peers.json transport=broker', async (t) => {
  const homeDir = makeHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const loaded = loadCrossMachine(homeDir);
  t.after(loaded.restore);

  const result = await loaded.crossMachine.connectBroker('https://broker.example:8443/', {
    node: 'nodeA',
    jwt: 'node-jwt',
    pin: 'sha256:abc'
  });

  assert.equal(result.success, true);
  const brokerPath = path.join(homeDir, '.telepty', 'broker.json');
  const broker = readJson(brokerPath);
  assert.deepEqual(broker, {
    url: 'https://broker.example:8443',
    node: 'nodeA',
    jwt: 'node-jwt',
    pin: 'sha256:abc',
    accept_from: null
  });
  assert.equal(fs.statSync(brokerPath).mode & 0o777, 0o600);

  const peers = readJson(path.join(homeDir, '.telepty', 'peers.json'));
  assert.equal(peers.peers.nodeA.transport, 'broker');
  assert.equal(peers.peers.nodeA.node, 'nodeA');
  assert.equal(peers.peers.nodeA.url, 'https://broker.example:8443');
  assert.equal(peers.peers.nodeA.token, undefined);
});

test('listBrokerRemoteSessions uses node JWT and tags peerName=host=node', async (t) => {
  const homeDir = makeHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  writeJson(path.join(homeDir, '.telepty', 'broker.json'), {
    url: 'https://broker.example',
    node: 'nodeA',
    jwt: 'node-jwt',
    pin: null,
    accept_from: null
  }, 0o600);

  const loaded = loadCrossMachine(homeDir);
  t.after(loaded.restore);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let seenUrl = null;
  let seenAuth = null;
  global.fetch = async (url, options) => {
    seenUrl = url;
    seenAuth = options.headers.Authorization;
    return {
      ok: true,
      json: async () => ({
        ok: true,
        sessions: [
          { id: 's1', host: 'nodeB', command: 'cmd-b' },
          { id: 's2', peerName: 'nodeC', command: 'cmd-c' }
        ]
      })
    };
  };

  const sessions = await loaded.crossMachine.listBrokerRemoteSessions();

  assert.equal(seenUrl, 'https://broker.example/broker/sessions');
  assert.equal(seenAuth, 'Bearer node-jwt');
  assert.equal(sessions[0].host, 'nodeB');
  assert.equal(sessions[0].peerName, 'nodeB');
  assert.equal(sessions[1].host, 'nodeC');
  assert.equal(sessions[1].peerName, 'nodeC');
});

test('connect-broker enrolls with secret and stores returned node JWT', async (t) => {
  const homeDir = makeHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  let enrollRequest = null;
  const broker = await startJsonServer((req, res, body) => {
    enrollRequest = {
      method: req.method,
      url: req.url,
      enroll: req.headers['x-telepty-enroll'],
      body
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, node: 'nodeA', jwt: 'minted-node-jwt' }));
  });
  t.after(broker.close);

  const result = await runCli([
    'connect-broker',
    broker.url,
    '--node', 'nodeA',
    '--enroll-secret', 'env:BROKER_ENROLL_SECRET',
    '--pin', 'sha256:testpin'
  ], homeDir, { BROKER_ENROLL_SECRET: 'fleet-secret' });

  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(enrollRequest.method, 'POST');
  assert.equal(enrollRequest.url, '/broker/enroll');
  assert.equal(enrollRequest.enroll, 'fleet-secret');
  assert.deepEqual(enrollRequest.body, { node: 'nodeA', pin_ack: 'sha256:testpin' });

  const brokerConfig = readJson(path.join(homeDir, '.telepty', 'broker.json'));
  assert.equal(brokerConfig.jwt, 'minted-node-jwt');
  assert.equal(brokerConfig.pin, 'sha256:testpin');
  assert.equal(fs.statSync(path.join(homeDir, '.telepty', 'broker.json')).mode & 0o777, 0o600);
  const peers = readJson(path.join(homeDir, '.telepty', 'peers.json'));
  assert.equal(peers.peers.nodeA.transport, 'broker');
  assert.equal(peers.peers.nodeA.token, undefined);
});

test('broker allow deny revoke edit ACL and revocation JSON', async (t) => {
  const homeDir = makeHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  let result = await runCli(['broker', 'allow', 'nodeA', '--to', 'nodeB,nodeC'], homeDir);
  assert.equal(result.status, 0, result.stderr);
  let acl = readJson(path.join(homeDir, '.telepty', 'broker-acl.json'));
  assert.deepEqual(acl.nodeA, ['nodeB', 'nodeC']);

  result = await runCli(['broker', 'allow', 'nodeA', '--to', 'nodeC,nodeD'], homeDir);
  assert.equal(result.status, 0, result.stderr);
  acl = readJson(path.join(homeDir, '.telepty', 'broker-acl.json'));
  assert.deepEqual(acl.nodeA, ['nodeB', 'nodeC', 'nodeD']);

  result = await runCli(['broker', 'deny', 'nodeA'], homeDir);
  assert.equal(result.status, 0, result.stderr);
  acl = readJson(path.join(homeDir, '.telepty', 'broker-acl.json'));
  assert.equal(acl.nodeA, undefined);

  result = await runCli(['broker', 'revoke', 'nodeA'], homeDir);
  assert.equal(result.status, 0, result.stderr);
  const revoked = readJson(path.join(homeDir, '.telepty', 'broker-revoked.json'));
  assert.deepEqual(revoked, ['nodeA']);
});

test('list includes broker sessions only when a broker peer exists', async (t) => {
  const homeDir = makeHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  let sessionsRequests = 0;
  const broker = await startJsonServer((req, res) => {
    sessionsRequests += 1;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/broker/sessions');
    assert.equal(req.headers.authorization, 'Bearer node-jwt');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      sessions: [{ id: 'broker-session', host: 'nodeB', command: 'broker command' }]
    }));
  });
  t.after(broker.close);

  writeJson(path.join(homeDir, '.telepty', 'broker.json'), {
    url: broker.url,
    node: 'nodeA',
    jwt: 'node-jwt',
    pin: null,
    accept_from: null
  }, 0o600);

  const listEnv = { TELEPTY_HOST: 'localhost', TELEPTY_PORT: '9' };
  let result = await runCli(['list', '--json'], homeDir, listEnv);
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(sessionsRequests, 0, 'broker discovery must stay default-OFF without a broker peer');
  assert.deepEqual(JSON.parse(result.stdout), []);

  writeJson(path.join(homeDir, '.telepty', 'peers.json'), {
    peers: {
      nodeA: {
        transport: 'broker',
        node: 'nodeA',
        url: broker.url,
        machineId: 'nodeA'
      }
    }
  });

  result = await runCli(['list', '--json'], homeDir, listEnv);
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  const sessions = JSON.parse(result.stdout);
  assert.equal(sessionsRequests, 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'broker-session');
  assert.equal(sessions[0].host, 'nodeB');
  assert.equal(sessions[0].peerName, 'nodeB');
});
