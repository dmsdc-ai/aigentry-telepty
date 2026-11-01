'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestDaemon, waitFor } = require('../test-support/daemon-harness');
const { claimedReturnMetadata } = require('../src/claimed-return');

test('return metadata preserves explicit locators as unverified claims', () => {
  assert.deepEqual(claimedReturnMetadata('orchestrator@source'), {
    locator: 'orchestrator@source', verification: 'unverified', claimed_cross_host: true, host_qualified: true
  });
  assert.equal(claimedReturnMetadata('orchestrator', true).host_qualified, false);
  assert.equal(claimedReturnMetadata('invalid\nlocator'), null);
});

test('same-name cross-host replies follow registered claimed locator and refuse bare or unknown returns', async () => {
  const source = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '', TELEPTY_MACHINE_ID: 'source', AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator' } });
  const receiver = await startTestDaemon({ env: { TELEPTY_AUTH_TOKEN: '', TELEPTY_MACHINE_ID: 'receiver', AIGENTRY_ORCHESTRATOR_SIDS: 'orchestrator', TELEPTY_AUDIT_FLUSH_MS: '10' } });
  const owners = [];
  try {
    for (const daemon of [source, receiver]) await daemon.registerSession('orchestrator');
    const sourceOwner = await source.connectSession('orchestrator', source.ownerAuth('orchestrator'));
    const receiverOwner = await receiver.connectSession('orchestrator', receiver.ownerAuth('orchestrator'));
    owners.push(sourceOwner, receiverOwner);
    const sourceFrames = [], receiverFrames = [];
    for (const [socket, frames] of [[sourceOwner, sourceFrames], [receiverOwner, receiverFrames]]) {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.type === 'inject' && String(message.data).includes('Synthetic')) {
          frames.push(message);
          socket.send(JSON.stringify({ type: 'output', data: 'synthetic-ready> ' }));
        }
      });
    }
    function seed(daemon, name, peer) {
      fs.writeFileSync(path.join(daemon.homeDir, '.telepty', 'peers.json'), JSON.stringify({ peers: {
        [name]: { transport: 'http', host: peer.host, port: peer.port, machineId: name, token: peer.authToken() }
      } }));
    }
    seed(source, 'receiver', receiver); seed(receiver, 'source', source);
    const injected = await source.runCli(['inject', '--from', 'orchestrator@source', '--reply-to', 'orchestrator@source',
      'orchestrator@receiver', 'Synthetic qualified input'], { env: { TELEPTY_AUTH_TOKEN: '' } });
    assert.equal(injected.code, 0, injected.stderr);
    await waitFor(() => receiverFrames.length === 1, { description: 'incoming qualified request' });
    const metadata = await receiver.request('/api/sessions/orchestrator');
    assert.equal(metadata.body.lastInjectFrom, 'orchestrator@source');
    assert.equal(metadata.body.lastInjectReturn.locator, 'orchestrator@source');
    assert.equal(metadata.body.lastInjectReturn.verification, 'unverified');
    assert.equal(metadata.body.lastInjectReturn.claimed_cross_host, true);
    const replied = await receiver.runCli(['reply', 'Synthetic cross-host reply'], {
      env: { TELEPTY_SESSION_ID: 'orchestrator', TELEPTY_AUTH_TOKEN: '', TELEPTY_SESSION_TOKEN: '' }
    });
    assert.equal(replied.code, 0, replied.stderr);
    assert.match(replied.stdout, /claimed return locator.*unverified/);
    await waitFor(() => sourceFrames.length === 1, { description: 'reply on source host' });
    assert.equal(receiverFrames.length, 1, 'receiver did not reply to itself');
    const auditPath = path.join(receiver.homeDir, '.telepty', 'logs', 'injects.jsonl');
    const record = await waitFor(() => {
      if (!fs.existsSync(auditPath)) return null;
      return fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
        .find((entry) => entry.claimed_from === 'orchestrator@source');
    }, { description: 'unverified claimed return audit' });
    assert.equal(record.verified_sender_sid, null);
    assert.equal(record.claimed_return_locator, 'orchestrator@source');
    assert.equal(record.return_locator_verification, 'unverified');
    assert.equal(record.claimed_cross_host, true);
    assert.equal(record.payload_preview, null);
    const bare = await source.runCli(['inject', '--from', 'orchestrator', 'orchestrator@receiver', 'Synthetic bare sender'], {
      env: { TELEPTY_AUTH_TOKEN: '' }
    });
    assert.equal(bare.code, 0, bare.stderr);
    await waitFor(() => receiverFrames.length === 2, { description: 'bare cross-host request' });
    const refused = await receiver.runCli(['reply', 'Synthetic must not self-route'], {
      env: { TELEPTY_SESSION_ID: 'orchestrator', TELEPTY_AUTH_TOKEN: '' }
    });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /REPLY_AMBIGUOUS_SENDER/);
    assert.equal(receiverFrames.length, 2);
    assert.equal(sourceFrames.length, 1);
    const unknown = await receiver.request('/api/sessions/orchestrator/inject', { method: 'POST', body: {
      prompt: 'Synthetic unknown claimed peer', from: 'orchestrator', reply_to: 'orchestrator@not-registered', claimed_cross_host: true
    } });
    assert.equal(unknown.status, 200);
    const unknownReply = await receiver.runCli(['reply', 'Synthetic must not spend fleet token'], {
      env: { TELEPTY_SESSION_ID: 'orchestrator', TELEPTY_AUTH_TOKEN: receiver.authToken() }
    });
    assert.notEqual(unknownReply.code, 0);
    assert.match(unknownReply.stderr, /REPLY_UNKNOWN_CLAIMED_PEER/);
  } finally {
    owners.forEach((socket) => socket.close());
    await Promise.all([source.stop(), receiver.stop()]);
  }
});
