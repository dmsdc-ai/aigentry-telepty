'use strict';

// G1 — Windows inbound-firewall guide/auto-add for the tailnet bind. Pure logic tested
// with an INJECTED runner (no real `netsh`, cross-platform-runnable). The security-
// relevant property: the port is validated to an integer and interpolated only into
// fixed netsh tokens — no shell, no command injection.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  firewallRuleName, addRuleArgs, showRuleArgs, commandString, ruleExists, ensureInboundRule
} = require('../src/net/win-firewall');

test('addRuleArgs: array form, no shell, port only in fixed tokens', () => {
  assert.deepEqual(addRuleArgs(3848), [
    'advfirewall', 'firewall', 'add', 'rule',
    'name=telepty-3848', 'dir=in', 'action=allow', 'protocol=TCP', 'localport=3848'
  ]);
});

test('port validation rejects non-integer / injection attempts', () => {
  assert.throws(() => addRuleArgs('8080; rm -rf /'), /invalid port/);
  assert.throws(() => firewallRuleName('$(whoami)'), /invalid port/);
  assert.throws(() => addRuleArgs(0), /invalid port/);
  assert.throws(() => addRuleArgs(70000), /invalid port/);
  assert.equal(firewallRuleName('3848'), 'telepty-3848'); // numeric string is fine
});

test('commandString is the exact copy-pasteable admin command', () => {
  assert.equal(
    commandString(3848),
    'netsh advfirewall firewall add rule name="telepty-3848" dir=in action=allow protocol=TCP localport=3848'
  );
});

test('showRuleArgs targets the named rule', () => {
  assert.deepEqual(showRuleArgs(3848), ['advfirewall', 'firewall', 'show', 'rule', 'name=telepty-3848']);
});

test('ruleExists: true when netsh show returns the rule, false when absent', () => {
  const present = () => ({ status: 0, stdout: 'Rule Name: telepty-3848\nEnabled: Yes', stderr: '' });
  const absent = () => ({ status: 1, stdout: 'No rules match the specified criteria.', stderr: '' });
  assert.equal(ruleExists(3848, present), true);
  assert.equal(ruleExists(3848, absent), false);
});

test('ensureInboundRule: exists → action=exists (no add attempted)', () => {
  let addCalled = false;
  const runner = (args) => {
    if (args.includes('add')) { addCalled = true; return { status: 0 }; }
    return { status: 0, stdout: 'Rule Name: telepty-3848' }; // show → present
  };
  const r = ensureInboundRule({ port: 3848, runner });
  assert.equal(r.action, 'exists');
  assert.equal(r.ruleName, 'telepty-3848');
  assert.equal(addCalled, false);
});

test('ensureInboundRule: absent + add succeeds (elevated) → action=added', () => {
  const runner = (args) => args.includes('add')
    ? { status: 0 }
    : { status: 1, stdout: 'No rules match' };
  assert.equal(ensureInboundRule({ port: 3848, runner }).action, 'added');
});

test('ensureInboundRule: absent + add fails (unelevated) → action=guide with command', () => {
  const runner = (args) => args.includes('add')
    ? { status: 1, stderr: 'requires elevation' }
    : { status: 1, stdout: 'No rules match' };
  const r = ensureInboundRule({ port: 3848, runner });
  assert.equal(r.action, 'guide');
  assert.match(r.command, /netsh advfirewall firewall add rule/);
});
