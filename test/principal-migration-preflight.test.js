'use strict';
const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { skip: process.platform !== 'linux' }, fn);
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'principal-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync('ed25519');
  const trust = { schema: 'telepty.principals/v1', audience: 'private-fixture', keys: [{
    key_id: 'key', principal_id: 'owner', public_key_spki: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    grants: [{ action: 'session.register', targets: ['mine'] }, { action: 'session.owner', targets: ['mine'] }]
  }] };
  const client = { id: 'wrapper', authentication: 'principal-v1', key_id: 'key', principal_id: 'owner',
    requirements: [{ action: 'session.register', target: 'mine' }, { action: 'session.owner', target: 'mine' }] };
  const inventory = { schema: 'telepty.strict-client-inventory/v1', audience: trust.audience, clients: [client] };
  const trustFile = path.join(root, 'trust.json'), inventoryFile = path.join(root, 'inventory.json');
  const write = () => { fs.writeFileSync(trustFile, JSON.stringify(trust), { mode: 0o600 }); fs.writeFileSync(inventoryFile, JSON.stringify(inventory), { mode: 0o600 }); };
  write();
  const inspect = () => require('../src/principal/migration-preflight').inspectPrincipalMigration({ trustFile, inventoryFile });
  return { root, trustFile, inventoryFile, trust, inventory, client, write, inspect };
}
test('declared matching grants never establish authenticated registration or permit activation', t => {
  const f = fixture(t), before = [f.trustFile, f.inventoryFile].map(p => fs.readFileSync(p));
  const report = f.inspect();
  assert.equal(report.all_declared_grants_match, true);
  assert.deepEqual(report.clients, [{ id: 'wrapper', grants_match: true, reason: 'declared_grants_match' }]);
  assert.equal(report.activation_permitted, false);
  assert.equal(report.authenticated_registration, 'unverified');
  assert.equal(report.inventory_completeness, 'unverified');
  assert.equal(report.runtime_authorization, 'unverified');
  assert.equal(report.report_delegation, 'disabled');
  assert.equal(report.foreign_trust_expansion, 'disabled');
  assert.equal(report.mutated, false);
  assert.equal(report.network_contacted, false);
  const output = JSON.stringify(report);
  assert.ok(!output.includes('BEGIN PUBLIC KEY'));
  assert.ok(!output.includes(f.root));
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['inventory.json', 'trust.json']);
  [f.trustFile, f.inventoryFile].forEach((p, i) => assert.deepEqual(fs.readFileSync(p), before[i]));
});
for (const [name, mutate, reason] of [
  ['legacy', f => { f.inventory.clients = [{ id: 'old', authentication: 'legacy', requirements: f.client.requirements }]; }, 'legacy_authentication'],
  ['missing key', f => { f.client.key_id = 'missing'; }, 'key_not_configured'],
  ['other principal', f => { f.client.principal_id = 'other'; }, 'principal_mismatch'],
  ['other session', f => { f.client.requirements[0].target = 'other'; }, 'declared_grant_missing'],
  ['other action', f => { f.client.requirements[0].action = 'session.destroy'; }, 'declared_grant_missing']
]) test(`static preflight reports ${name} as a blocker without changing trust`, t => {
  const f = fixture(t); mutate(f); f.write(); const report = f.inspect();
  assert.equal(report.all_declared_grants_match, false);
  assert.equal(report.clients[0].reason, reason);
  assert.equal(report.activation_permitted, false);
});
test('operator read-only wildcard semantics reuse production trust validation', t => {
  const f = fixture(t);
  f.trust.keys[0].authority = 'operator';
  f.trust.keys[0].grants = [{ action: 'session.inspect', targets: ['*'] }];
  f.client.requirements = [{ action: 'session.inspect', target: 'mine' }];
  f.write(); assert.equal(f.inspect().all_declared_grants_match, true);
  f.trust.keys[0].grants = [{ action: 'session.destroy', targets: ['*'] }];
  f.write(); assert.throws(f.inspect);
});
test('invalid, ambiguous, oversized and incomplete inventories refuse', t => {
  const f = fixture(t);
  for (const mutate of [
    () => { f.inventory.audience = 'foreign'; },
    () => { f.inventory.unexpected = true; },
    () => { f.inventory.clients = []; },
    () => { f.inventory.clients = Array(129).fill(f.client); },
    () => { f.inventory.clients.push({ ...f.client }); },
    () => { f.client.requirements = []; },
    () => { f.client.requirements = Array(129).fill({ action: 'session.owner', target: 'mine' }); },
    () => { f.client.requirements.push({ ...f.client.requirements[0] }); },
    () => { f.client.requirements[0].action = 'invented.action'; },
    () => { f.client.token = 'do-not-disclose'; }
  ]) {
    const snapshot = JSON.stringify(f.inventory), originalClient = JSON.stringify(f.client);
    mutate(); f.write(); assert.throws(f.inspect, { code: 'PRINCIPAL_PREFLIGHT_UNAVAILABLE' });
    Object.keys(f.inventory).forEach(k => delete f.inventory[k]); Object.assign(f.inventory, JSON.parse(snapshot));
    Object.keys(f.client).forEach(k => delete f.client[k]); Object.assign(f.client, JSON.parse(originalClient));
    f.inventory.clients[0] = f.client;
  }
  for (const raw of ['{"schema":"x","schema":"y"}', ' '.repeat(65537)]) {
    fs.writeFileSync(f.inventoryFile, raw); assert.throws(f.inspect, { code: 'PRINCIPAL_PREFLIGHT_UNAVAILABLE' });
  }
});
test('unsafe input files refuse without repairing permissions or following links', t => {
  const f = fixture(t);
  fs.chmodSync(f.inventoryFile, 0o666); assert.throws(f.inspect); assert.equal(fs.statSync(f.inventoryFile).mode & 0o777, 0o666);
  fs.chmodSync(f.inventoryFile, 0o600);
  fs.renameSync(f.inventoryFile, f.inventoryFile + '.real'); fs.symlinkSync(f.inventoryFile + '.real', f.inventoryFile);
  assert.throws(f.inspect);
});
test('actual CLI requires explicit paths and emits sanitized static results only', t => {
  const f = fixture(t), script = path.join(__dirname, '../scripts/principal-preflight.js');
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const args = ['--trust', f.trustFile, '--inventory', f.inventoryFile];
  let result = run(args); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).activation_permitted, false);
  f.client.key_id = 'missing'; f.write(); result = run(args); assert.equal(result.status, 1, result.stderr);
  for (const invalid of [[], ['--trust', 'relative', '--inventory', f.inventoryFile], [...args, '--apply'], ['--trust', f.trustFile, '--trust', f.trustFile]]) {
    result = run(invalid); assert.equal(result.status, 2); assert.ok(!result.stderr.includes(f.root));
  }
  fs.writeFileSync(f.inventoryFile, '{"token":"do-not-disclose"}');
  result = run(args); assert.equal(result.status, 2); assert.ok(!(result.stdout + result.stderr).includes('do-not-disclose'));
});
nodeTest('unsupported native authority platforms refuse static inspection without fallback', t => {
  const f = fixture(t), script = path.join(__dirname, '../scripts/principal-preflight.js');
  for (const platform of ['darwin', 'win32']) {
    const program = `Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});process.argv=[process.execPath,${JSON.stringify(script)},'--trust',${JSON.stringify(f.trustFile)},'--inventory',${JSON.stringify(f.inventoryFile)}];require(${JSON.stringify(script)});`;
    const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.activation_permitted, false);
    assert.equal(report.authenticated_registration, 'unverified');
    assert.equal(report.error, 'PRINCIPAL_PREFLIGHT_UNAVAILABLE');
    assert.ok(!result.stdout.includes(f.root));
  }
});
