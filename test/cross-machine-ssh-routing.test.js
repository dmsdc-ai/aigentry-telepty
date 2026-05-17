'use strict';

// Regression tests for #411 — cross-machine SSH-peer routing must be
// file-backed so fresh CLI subprocesses (which have an empty activePeers Map)
// can still see and route to SSH peers persisted in peers.json.
//
// These tests redirect HOME to a tmpdir, write a fixture peers.json, and
// exercise listSshPeers / getSshPeerHandle / remoteInject without ever
// invoking real ssh (HOME is throwaway, no ControlMaster exists). The intent
// is to verify the *routing decisions*, not the SSH wire protocol.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpHome;
let originalHome;
let crossMachine;

function writePeers(peers) {
  const dir = path.join(tmpHome, '.telepty');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'peers.json'), JSON.stringify({ peers }, null, 2));
}

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-xmachine-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // Force a fresh require so PEERS_PATH binds to the test HOME.
  delete require.cache[require.resolve('../cross-machine')];
  crossMachine = require('../cross-machine');
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  delete require.cache[require.resolve('../cross-machine')];
});

test('listSshPeers includes entries with no transport field (legacy default = ssh)', () => {
  writePeers({
    winserver: {
      target: 'Administrator@win.tail.ts.net',
      machineId: 'WIN-T6T20OIKEMR',
      lastConnected: '2026-05-17T14:10:29.883Z'
    }
  });
  const peers = crossMachine.listSshPeers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].name, 'winserver');
  assert.equal(peers[0].target, 'Administrator@win.tail.ts.net');
});

test('listSshPeers excludes HTTP-transport peers', () => {
  writePeers({
    sshpeer: { target: 'admin@host.example' },
    httppeer: { transport: 'http', host: '127.0.0.1', port: 4848, target: '127.0.0.1:4848' }
  });
  const peers = crossMachine.listSshPeers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].name, 'sshpeer');
});

test('getSshPeerHandle resolves SSH peer from peers.json without activePeers', () => {
  writePeers({
    winserver: { target: 'Administrator@win.tail.ts.net' }
  });
  const handle = crossMachine.getSshPeerHandle('winserver');
  assert.ok(handle, 'handle should be returned');
  assert.equal(handle.name, 'winserver');
  assert.equal(handle.target, 'Administrator@win.tail.ts.net');
  assert.match(
    handle.controlSocket,
    /[/\\]\.telepty[/\\]ssh[/\\]ctrl-Administrator@win\.tail\.ts\.net$/,
    'controlSocket should be deterministic from target'
  );
});

test('getSshPeerHandle returns null for HTTP-transport peers', () => {
  writePeers({
    httppeer: { transport: 'http', host: '127.0.0.1', port: 4848 }
  });
  assert.equal(crossMachine.getSshPeerHandle('httppeer'), null);
});

test('getSshPeerHandle returns null for unknown peers', () => {
  writePeers({ winserver: { target: 'a@b' } });
  assert.equal(crossMachine.getSshPeerHandle('nope'), null);
});

test('remoteInject no longer returns "Not connected to" for peers persisted in peers.json (#411 regression)', () => {
  // Before fix: remoteInject('winserver', ...) returned
  //   { success: false, error: 'Not connected to winserver' }
  // because activePeers Map was empty in this fresh process.
  // After fix: getSshPeerHandle reads peers.json, so remoteInject proceeds
  // to attempt SSH. The SSH attempt fails (no ControlMaster in test HOME),
  // but the failure mode is a *transport* error, not a *not-connected* error.
  writePeers({
    winserver: {
      target: 'Administrator@win.invalid-tld-for-test'
    }
  });
  const result = crossMachine.remoteInject('winserver', 'some-sid', 'hello');
  assert.equal(result.success, false);
  assert.doesNotMatch(
    String(result.error || ''),
    /Not connected to winserver/,
    'must not short-circuit at activePeers lookup'
  );
});

test('remoteInject still rejects unknown peers cleanly', () => {
  writePeers({});
  const result = crossMachine.remoteInject('does-not-exist', 'sid', 'hello');
  assert.equal(result.success, false);
  assert.match(String(result.error || ''), /Not connected to does-not-exist/);
});
