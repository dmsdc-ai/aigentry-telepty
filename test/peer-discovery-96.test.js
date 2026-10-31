'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test('#96 actual discovery CLI enumerates synthetic candidates without enrolling or minting credentials', {
  skip: process.platform === 'win32' ? 'POSIX executable fixture; provider logic is platform-independent' : false
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const status = { BackendState: 'Running', Self: { ID: 'self' }, Peer: {
    one: { ID: 'peer-one', HostName: 'worker', DNSName: 'worker.example.ts.net.',
      Online: true, TailscaleIPs: ['100.90.1.2'], UserID: 999, LoginName: 'must-not-export' }
  } };
  const script = '#!' + process.execPath + '\n'
    + 'if(process.argv.slice(2).join(" ")!=="status --json")process.exit(9);\n'
    + 'process.stdout.write(' + JSON.stringify(JSON.stringify(status)) + ');\n';
  fs.writeFileSync(path.join(bin, 'tailscale'), script, { mode: 0o700 });
  const { stdout } = await run(process.execPath, ['cli.js', 'discover', '--json'], {
    cwd: path.resolve(__dirname, '..'), timeout: 5000,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: bin + path.delimiter + process.env.PATH,
      TELEPTY_DISABLE_UPDATE_NOTIFIER: '1', NO_UPDATE_NOTIFIER: '1' }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].address, '100.90.1.2');
  assert.equal(result.candidates[0].authenticated, false);
  assert.equal(result.candidates[0].enrollment, 'credential_required');
  assert.doesNotMatch(stdout, /must-not-export|LoginName|UserID/);
  assert.deepEqual(fs.readdirSync(home), [], 'discovery is read-only, not enrollment or secret minting');
});

const { parseCandidates, createPeerDiscovery, MAX_CANDIDATES } = require('../src/peer-discovery');
function status(peers) { return { BackendState: 'Running', Self: { ID: 'self' }, Peer: peers }; }
function peer(ip, more = {}) { return { ID: ip, HostName: 'node', Online: true, TailscaleIPs: [ip], ...more }; }
test('#96 only online tailnet IPv4 candidates are exposed and no advertisement grants authority', () => {
  const result = parseCandidates(status({
    self: peer('100.90.1.1', { ID: 'self' }), offline: peer('100.90.1.2', { Online: false }),
    lan: peer('192.168.1.1'), valid: peer('100.90.1.3', { HostName: '\u001b[31mspoof', DNSName: 'name.ts.net.' }),
    duplicate: peer('100.90.1.3')
  }), { enrolled: { transport: 'http', host: '100.90.1.3', port: 5555, token: 'private-token' } }, 1000);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].machine_id, null);
  assert.equal(result.candidates[0].dns_name, 'name.ts.net');
  assert.equal(result.candidates[0].port, 5555);
  assert.equal(result.candidates[0].enrollment, 'credential_configured');
  assert.equal(result.candidates[0].authenticated, false);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});
test('#96 machine-name spoofing and duplicate address registrations cannot select credentials', () => {
  const s = status({ x: peer('100.90.1.2', { HostName: 'trusted-machine' }) });
  assert.equal(parseCandidates(s, { trusted: { transport: 'http', host: '100.90.1.1', port: 3848, machineId: 'trusted-machine', token: 'secret' } }).candidates[0].registered, false);
  const registered = { a: { transport: 'http', host: '100.90.1.2', port: 3848 }, b: { transport: 'http', host: '100.90.1.2', port: 9999 } };
  assert.equal(parseCandidates(s, registered).candidates[0].enrollment, 'ambiguous_registration');
});
test('#96 provider process and candidate output are bounded; cache is single-flight and read-only', async () => {
  let calls = 0, done, time = 1000;
  const discover = createPeerDiscovery({ now: () => time, exec: (file, args, opts, callback) => {
    calls++; done = callback; assert.equal(file, 'tailscale'); assert.deepEqual(args, ['status', '--json']);
    assert.equal(opts.timeout, 1500); assert.equal(opts.maxBuffer, 1024 * 1024); assert.equal(opts.killSignal, 'SIGKILL');
  } });
  const first = discover(), second = discover();
  done(null, JSON.stringify(status({ x: peer('100.90.1.2') })));
  assert.deepEqual(await first, await second); assert.equal(calls, 1);
  await discover(); assert.equal(calls, 1);
  time += 16000; const third = discover(); done({ code: 'ENOENT' });
  assert.equal((await third).reason, 'tool_not_found'); assert.equal(calls, 2);
  const peers = Object.fromEntries(Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => [i,
    peer(`100.90.${Math.floor(i / 256)}.${i % 256}`)]));
  const result = parseCandidates(status(peers));
  assert.equal(result.candidates.length, MAX_CANDIDATES); assert.equal(result.truncated, true);
  assert.throws(() => parseCandidates({ BackendState: 'Stopped' }));
});
