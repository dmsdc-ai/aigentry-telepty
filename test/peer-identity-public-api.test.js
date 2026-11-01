'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveRegisteredPeerTarget } = require('../session-routing');
const { startTestDaemon } = require('../test-support/daemon-harness');

const peer = { transport: 'http', host: '192.0.2.1', port: 4859, target: '192.0.2.1:4859', machineId: 'worker', dnsName: 'worker.example.ts.net', token: 'remote-secret' };
test('registered HTTP address, port, machine identity and DNS name share stored endpoint', () => {
  for (const name of ['saved', peer.host, peer.target, peer.machineId, peer.dnsName]) {
    assert.deepEqual(resolveRegisteredPeerTarget(`exact-id@${name}`, { saved: peer }), {
      id: 'exact-id', host: '192.0.2.1:4859', peerName: 'saved', peerPort: 4859
    });
  }
  assert.equal(resolveRegisteredPeerTarget('exact-id@unknown', { saved: peer }), null);
  assert.throws(() => resolveRegisteredPeerTarget('exact-id@worker', {
    one: peer, two: { ...peer, host: '192.0.2.2' }
  }), /ambiguous/);
  assert.equal(resolveRegisteredPeerTarget('exact-id@192.0.2.1:9999', { saved: peer }), null);
  assert.equal(resolveRegisteredPeerTarget('exact-id@[2001:db8::1]:4859', {
    saved: { ...peer, host: '2001:db8::1' }
  }).host, '[2001:db8::1]:4859');
});
test('registered SSH machine identity keeps its SSH transport', () => {
  assert.deepEqual(resolveRegisteredPeerTarget('exact-id@worker', { saved: { target: 'user@ssh.example', machineId: 'worker' } }), {
    id: 'exact-id', host: 'user@ssh.example', peerName: 'saved', remote: true
  });
});

test('HTTP peers API redacts every unapproved field and CLI machine identity uses stored token and port', async () => {
  const daemon = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  const remote = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '' } });
  try {
    assert.notEqual(daemon.authToken(), remote.authToken());
    const peersPath = path.join(daemon.homeDir, '.telepty', 'peers.json');
    const stored = { peers: { saved: { ...peer, host: '127.0.0.1', port: remote.port,
      target: `127.0.0.1:${remote.port}`, token: remote.authToken(),
      refreshToken: 'refresh-private', credentials: { secret: 'nested-private' },
      futureSecret: 'future-private', label: 'Worker' } } };
    const original = JSON.stringify(stored);
    fs.writeFileSync(peersPath, original);
    const response = await daemon.request('/api/peers');
    assert.equal(response.status, 200);
    const known = response.body.known.saved;
    assert.equal(known.has_token, true);
    assert.equal(known.label, 'Worker');
    assert.deepEqual(Object.keys(known).sort(), ['has_token', 'host', 'label', 'machineId', 'port', 'target', 'transport']);
    for (const secret of [stored.peers.saved.token, 'refresh-private', 'nested-private', 'future-private']) assert.equal(response.text.includes(secret), false);
    assert.equal(fs.readFileSync(peersPath, 'utf8'), original);
    await remote.registerSession('exact-worker');
    const cli = await daemon.runCli(['session', 'info', 'exact-worker@worker', '--json'], {
      env: { TELEPTY_AUTH_TOKEN: '', TELEPTY_HOST: '127.0.0.1' }
    });
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /exact-worker/);
    // A missing exact id must not select a discovered longer session.
    const missing = await daemon.runCli(['session', 'info', 'exact@worker', '--json'], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.notEqual(missing.code, 0);
    const unknown = await daemon.runCli(['session', 'info', 'exact-worker@unknown-peer', '--json'], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /No peer registered.*unknown-peer/);
    stored.peers.other = { ...stored.peers.saved };
    fs.writeFileSync(peersPath, JSON.stringify(stored));
    const ambiguous = await daemon.runCli(['session', 'info', 'exact-worker@worker', '--json'], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.stderr, /ambiguous/);
  } finally { await Promise.all([daemon.stop(), remote.stop()]); }
});
