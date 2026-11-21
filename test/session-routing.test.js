'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSessionTarget, runSessionInfo, printSessionList } = require('../cli');
const { createPeerContext } = require('../cross-machine');

const {
  formatHostLabel,
  groupSessionsByHost,
  parseSessionReference,
  pickSessionTarget
} = require('../session-routing');

test('formatHostLabel returns Local for localhost and preserves remote hosts', () => {
  assert.equal(formatHostLabel('127.0.0.1'), 'Local');
  assert.equal(formatHostLabel('100.70.64.60'), '100.70.64.60');
});

test('parseSessionReference supports plain ids and id@host syntax', () => {
  assert.deepEqual(parseSessionReference('alpha'), { id: 'alpha', host: null });
  assert.deepEqual(parseSessionReference('alpha@100.70.64.60'), { id: 'alpha', host: '100.70.64.60' });
});

test('groupSessionsByHost groups discovered sessions by host', () => {
  const grouped = groupSessionsByHost([
    { id: 'one', host: '127.0.0.1' },
    { id: 'two', host: '100.1.1.1' },
    { id: 'three', host: '100.1.1.1' }
  ]);

  assert.equal(grouped.get('127.0.0.1').length, 1);
  assert.equal(grouped.get('100.1.1.1').length, 2);
});

test('pickSessionTarget resolves unique sessions across discovered hosts', () => {
  const sessions = [
    { id: 'local', host: '127.0.0.1' },
    { id: 'remote', host: '100.70.64.60' }
  ];

  assert.deepEqual(pickSessionTarget('remote', sessions), { id: 'remote', host: '100.70.64.60' });
  assert.deepEqual(pickSessionTarget('remote@100.70.64.60', sessions), { id: 'remote', host: '100.70.64.60' });
  assert.deepEqual(pickSessionTarget('remote', sessions, '100.70.64.60'), { id: 'remote', host: '100.70.64.60' });
  assert.equal(pickSessionTarget('missing', sessions), null);
});

test('pickSessionTarget rejects ambiguous ids found on multiple hosts', () => {
  const sessions = [
    { id: 'shared', host: '100.70.64.60' },
    { id: 'shared', host: '100.72.155.21' }
  ];

  assert.throws(() => pickSessionTarget('shared', sessions), /multiple hosts/i);
});

test('pickSessionTarget matches `<id>@<peerName>` against session.peerName alias (#411)', () => {
  // Discovered SSH-peer session: host is `user@FQDN`, peerName is the
  // friendly alias from peers.json.
  const sessions = [
    { id: 'orchestrator-winsvr', host: 'Administrator@win.tail.ts.net', peerName: 'winserver', remote: true }
  ];

  // `<id>@<peerName>` syntax must match the alias rather than falling through
  // to a synthetic {host: 'winserver'} target.
  const resolved = pickSessionTarget('orchestrator-winsvr@winserver', sessions);
  assert.equal(resolved.id, 'orchestrator-winsvr');
  assert.equal(resolved.peerName, 'winserver');
  assert.equal(resolved.host, 'Administrator@win.tail.ts.net');
  assert.equal(resolved.remote, true);
});

const emptyDiscovery = { sessions: [], failures: [] };
const endpoint = { transport: 'http', machineId: 'machine-a', host: 'node-a.example', port: 4888 };
const remote = { id: 'shared', host: 'node-a.example:4888', peerName: 'saved-a', peerPort: 4888 };

function fixture({ local = [], peers = {}, discovered = [], errors = [], entries = {} } = {}) {
  const calls = [];
  const session = { id: 'shared', command: 'codex' };
  return {
    calls,
    options: {
      port: 3848,
      envHost: '',
      localIdentity: { hostname: 'local.example', interfaces: () => ({ lan: [{ address: '192.0.2.12' }] }) },
      _fetchWithAuth: async (url) => {
        calls.push(url);
        const pathname = new URL(url).pathname;
        if (entries[pathname]) return entries[pathname];
        return { ok: true, json: async () => pathname === '/api/sessions' ? local : session };
      },
      _ensureDaemonRunning: () => assert.fail('the injected daemon answered'),
      _peers: {
        loadPeers: () => { calls.push('registry'); return { peers }; },
        discoverAllRemoteSessions: () => { calls.push('ssh'); return emptyDiscovery; },
        discoverHttpRemoteSessions: async () => {
          calls.push('http'); return { sessions: discovered, failures: errors };
        },
        discoverBrokerRemoteSessions: async () => { calls.push('broker'); return emptyDiscovery; }
      },
      lookupAddress: async () => assert.fail('unexpected DNS lookup')
    }
  };
}

async function sessionInfo(ref, options) {
  let stdout = '', stderr = '';
  const exitCode = await runSessionInfo(ref, {
    ...options, json: true,
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } }
  });
  return { exitCode, stdout, stderr };
}

test('#1288 exact local hit ignores all registered peers and discovery', async () => {
  const { calls, options } = fixture({ local: [{ id: 'shared' }], peers: { 'saved-a': endpoint }, discovered: [remote] });
  assert.deepEqual(await resolveSessionTarget('shared', options), { id: 'shared', host: '127.0.0.1' });
  assert.deepEqual(calls, ['http://127.0.0.1:3848/api/sessions']);
  const result = await sessionInfo('shared', options);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).host, '127.0.0.1');
  assert.ok(calls.every((call) => call.startsWith('http://127.0.0.1:3848/')));
});

test('#1288 bare-id miss discovers peers and retains exact remote ambiguity', async () => {
  const only = fixture({ local: [{ id: 'shared-local' }], discovered: [remote] });
  assert.deepEqual(await resolveSessionTarget('shared', only.options), remote);
  assert.deepEqual(only.calls, ['http://127.0.0.1:3848/api/sessions', 'ssh', 'http', 'broker']);
  const second = { ...remote, host: 'node-b.example:4888', peerName: 'saved-b' };
  const multiple = fixture({ discovered: [remote, second] });
  await assert.rejects(resolveSessionTarget('shared', multiple.options), { code: 'AMBIGUOUS_SESSION' });
  assert.equal(pickSessionTarget('shared', [remote, { id: 'shared', host: '127.0.0.1' }]).host, '127.0.0.1');
});

test('#1288 TELEPTY_HOST restricts selection even when explicitly loopback, with qualifier precedence', async () => {
  const { calls, options } = fixture({ peers: { 'saved-a': endpoint }, discovered: [remote] });
  assert.deepEqual(await resolveSessionTarget('shared', { ...options, envHost: '127.0.0.1' }), { id: 'shared', host: '127.0.0.1' });
  assert.deepEqual(calls.splice(0), ['http://127.0.0.1:3848/api/sessions']);
  const selected = { ...options, envHost: 'http://node-a.example:4888', port: 4888 };
  assert.deepEqual(await resolveSessionTarget('shared', selected), remote);
  assert.deepEqual(calls, ['registry']);
  assert.deepEqual(await resolveSessionTarget('shared@localhost', selected), { id: 'shared', host: '127.0.0.1' });
  assert.deepEqual(calls, ['registry', 'http://127.0.0.1:4888/api/sessions']);
  const direct = { ...options, envHost: 'other.example:9111', port: 9111 };
  assert.deepEqual(await resolveSessionTarget('shared', direct), { id: 'shared', host: 'other.example:9111' });
});

test('#1288 local name and assigned addresses use the local daemon with zero DNS lookups', async () => {
  const { calls, options } = fixture({ local: [{ id: 'shared' }], peers: { 'saved-a': endpoint } });
  for (const identity of ['localhost', 'local.example', '192.0.2.12:3848', '[::1]:3848']) {
    assert.deepEqual(await resolveSessionTarget('shared@' + identity, options), { id: 'shared', host: '127.0.0.1' });
  }
  assert.deepEqual(await resolveSessionTarget('shared@192.0.2.12:4888', options),
    { id: 'shared', host: '127.0.0.1:4888' });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => url === 'http://127.0.0.1:3848/api/sessions'));
});

test('#1288 registered aliases and resolved IPs use the same stored endpoint', async () => {
  const { options } = fixture({ peers: { 'saved-a': endpoint, elsewhere: { ...endpoint, port: 4999 } } });
  // Use the unique registration for identities shared by the two ports.
  const single = fixture({ peers: { 'saved-a': endpoint } }).options;
  for (const identity of ['saved-a', 'machine-a', 'node-a.example', 'node-a.example:4888']) {
    assert.deepEqual(await resolveSessionTarget('shared@' + identity, single), remote);
  }
  const lookups = [];
  const lookupAddress = async (name, lookupOptions) => {
    lookups.push(name);
    assert.equal(lookupOptions.all, true);
    return [{ address: '192.0.2.25' }, { address: '2001:db8::25' }];
  };
  assert.deepEqual(await resolveSessionTarget('shared@192.0.2.25:4888', { ...options, lookupAddress }), remote);
  assert.deepEqual(await resolveSessionTarget('shared@[2001:db8::25]:4888', { ...options, lookupAddress }), remote);
  assert.deepEqual(lookups.splice(0), ['node-a.example', 'node-a.example']);
  await assert.rejects(resolveSessionTarget('shared@192.0.2.25', { ...options, lookupAddress }), { code: 'AMBIGUOUS_PEER' });
  assert.deepEqual(lookups, ['node-a.example'], 'each distinct hostname is looked up once per resolution');
});

test('#1288 JSON refusal documents, diagnostic stderr and non-zero dispatch result', async (t) => {
  const peerSet = { 'saved-a': endpoint };
  const missing = fixture().options;
  const entries = { '/api/sessions': { ok: false, status: 401 } };
  const scenarios = [
    ['INVALID_SESSION_REFERENCE', '', missing, /Usage/],
    ['SESSION_NOT_FOUND', 'absent', missing, /not found/],
    ['AMBIGUOUS_SESSION', 'shared', fixture({ discovered: [remote, { ...remote, host: 'node-b.example:4888' }] }).options, /multiple hosts/],
    ['PEER_NOT_REGISTERED', 'shared@unknown.example', fixture({ peers: peerSet }).options, /No peer registered/],
    ['AMBIGUOUS_PEER', 'shared@machine-a', fixture({ peers: { ...peerSet, 'saved-b': { ...endpoint, port: 4999 } } }).options, /ambiguous/],
    ['PEER_ENDPOINT_MISSING', 'shared@incomplete', fixture({ peers: { incomplete: { transport: 'http' } } }).options, /no registered HTTP endpoint/],
    ['PEER_DNS_FAILED', 'shared@192.0.2.99:4888', { ...fixture({ peers: peerSet }).options,
      lookupAddress: async () => { throw Object.assign(new Error('fixture'), { code: 'ENOTFOUND' }); } }, /node-a\.example.*ENOTFOUND/],
    ['PEER_DNS_FAILED', 'shared@192.0.2.99:4888', { ...fixture({ peers: peerSet }).options,
      lookupAddress: () => new Promise(() => {}), timeoutMs: 5 }, /PEER_DNS_TIMEOUT/],
    ['PEER_DISCOVERY_INCOMPLETE', 'shared', fixture({ errors: [new Error('peer refused')] }).options, /peer refused/],
    ['DAEMON_REFUSED', 'shared', fixture({ entries }).options, /HTTP 401/],
    ['DAEMON_RESPONSE_ERROR', 'shared', fixture({ entries: { '/api/sessions': { ok: false, status: 503 } } }).options, /HTTP 503/],
    ['DAEMON_NOT_ANSWERING', 'shared', { ...missing, _fetchWithAuth: async () => { throw new Error('fixture timeout'); } }, /did not answer/],
    ['SESSION_NOT_FOUND', 'shared@localhost', fixture({ entries: {
      '/api/sessions/shared': { ok: false, status: 404, json: async () => ({ error: 'Session not found' }) }
    } }).options, /Session not found/],
    ['NO_TARGET_CREDENTIAL', 'shared', { ...missing, envHost: 'foreign.example', _fetchWithAuth: async () => {
      throw Object.assign(new Error('credential unavailable'), { code: 'NO_TARGET_CREDENTIAL' });
    } }, /credential unavailable/]
  ];
  const previous = process.env.TELEPTY_AUTH_TOKEN;
  delete process.env.TELEPTY_AUTH_TOKEN;
  t.after(() => { if (previous !== undefined) process.env.TELEPTY_AUTH_TOKEN = previous; });
  for (const [code, ref, options, diagnostic] of scenarios) {
    const result = await sessionInfo(ref, options);
    assert.equal(result.exitCode, 1, ref);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed, { success: false, code, error: parsed.error });
    assert.match(parsed.error, diagnostic);
    assert.equal(result.stderr, '❌ ' + parsed.error + '\n');
  }
});

test('#1288 list disambiguates text IDs and the no-peer session info JSON matches the 0.11.3 golden bytes', async () => {
  const { options } = fixture({ local: [{ id: 'shared' }] });
  const local = await resolveSessionTarget('shared', options);
  const lines = [];
  printSessionList([local, remote, { id: 'shared', host: 'node-b.example:4888' }], (line) => lines.push(line));
  assert.deepEqual(lines.filter((line) => line?.includes('  - ID:')), [
    '  - ID: \x1b[36mshared\x1b[0m',
    '  - ID: \x1b[36mshared@saved-a\x1b[0m',
    '  - ID: \x1b[36mshared@node-b.example:4888\x1b[0m'
  ]);
  const empty = [];
  printSessionList([], (line) => empty.push(line + '\n'));
  assert.equal(empty.join(''), 'No active sessions found.\n');
  assert.deepEqual(await sessionInfo('shared', options), {
    exitCode: 0, stderr: '',
    stdout: '{\n  "host": "127.0.0.1",\n  "id": "shared",\n  "command": "codex"\n}\n'
  });
});

test('#1288 HTTP registrations use the handshake machine ID or full IP and preserve old keys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-peer-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const peersPath = path.join(dir, 'peers.json');
  const legacy = { transport: 'http', host: '192.0.2.2', port: 3848, machineId: 'older-host' };
  const initial = JSON.stringify({ peers: { '192': legacy } });
  fs.writeFileSync(peersPath, initial);
  const peerContext = createPeerContext({
    PEERS_PATH: peersPath,
    fetch: async (url) => {
      if (url.endsWith('/api/health')) return { ok: true };
      if (new URL(url).hostname === '192.0.2.3') return { ok: true, json: async () => ({ machine_id: 'named-peer' }) };
      return { ok: false };
    }
  });
  const options = { ...fixture().options, _peers: peerContext };
  assert.equal((await resolveSessionTarget('shared@192', options)).host, '192.0.2.2:3848');
  assert.equal((await resolveSessionTarget('shared@192.0.2.2:3848', options)).peerName, '192');
  assert.equal(fs.readFileSync(peersPath, 'utf8'), initial);
  assert.equal((await peerContext.connectHttp('192.0.2.3')).name, 'named-peer');
  assert.equal((await peerContext.connectHttp('192.0.2.4')).name, '192.0.2.4');
  assert.equal((await peerContext.connectHttp('[2001:db8::1]:3881')).name, '2001:db8::1');
  assert.deepEqual(peerContext.loadPeers().peers['192'], legacy);
});

test('#1288 SSH IP registration uses the reported host or the full IP', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ssh-peer-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const peerContext = createPeerContext({
    PEERS_PATH: path.join(dir, 'peers.json'),
    CONTROL_DIR: dir,
    getUsername: () => 'worker',
    execFileSync: (_cmd, args) => {
      if (args.at(-1) !== 'hostname') return '';
      if (args.includes('worker@192.0.2.3')) return 'ssh-machine\n';
      throw new Error('fixture hostname unavailable');
    }
  });
  assert.equal((await peerContext.connect('192.0.2.3')).name, 'ssh-machine');
  assert.equal((await peerContext.connect('192.0.2.4')).name, '192.0.2.4');
  assert.equal((await resolveSessionTarget('shared@192.0.2.3:22', { ...fixture().options, _peers: peerContext })).peerName, 'ssh-machine');
});
