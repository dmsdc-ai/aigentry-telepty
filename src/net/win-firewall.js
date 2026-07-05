'use strict';

// G1 (Windows only): auto-binding the tailnet interface is necessary but NOT sufficient
// on Windows — Defender Firewall blocks inbound on the tailnet iface by default, so a
// tailnet peer still can't reach :3848 after a correct bind. Detect the inbound rule; add
// it automatically when the daemon runs elevated, otherwise print the exact one-time
// command. Never fatal. ponytail: no cross-firewall abstraction — mac/Linux need nothing.
//
// SECURITY: uses spawnSync with an ARGUMENT ARRAY (no shell) and the only interpolated
// value is the port, validated to an integer in [1,65535] — no command-injection surface.

const { spawnSync } = require('child_process');

function toPort(port) {
  const p = Math.trunc(Number(port));
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`invalid port: ${port}`);
  return p;
}

function firewallRuleName(port) {
  return `telepty-${toPort(port)}`;
}

function addRuleArgs(port) {
  const p = toPort(port);
  return ['advfirewall', 'firewall', 'add', 'rule', `name=telepty-${p}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${p}`];
}

function showRuleArgs(port) {
  return ['advfirewall', 'firewall', 'show', 'rule', `name=telepty-${toPort(port)}`];
}

// The copy-pasteable command shown in the banner when we can't add it ourselves.
function commandString(port) {
  const p = toPort(port);
  return `netsh advfirewall firewall add rule name="telepty-${p}" dir=in action=allow protocol=TCP localport=${p}`;
}

// runner is injectable for tests: (args) => { status, stdout, stderr, error }
function defaultRunner(args) {
  const r = spawnSync('netsh', args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function ruleExists(port, runner = defaultRunner) {
  const r = runner(showRuleArgs(port));
  // netsh 'show rule' → status 0 + rule text when present; nonzero / "No rules match" when absent.
  if (!r || r.error) return false;
  return r.status === 0 && /telepty-\d+/i.test(r.stdout || '');
}

// Returns { action: 'exists'|'added'|'guide', ruleName, command }.
function ensureInboundRule({ port, runner = defaultRunner } = {}) {
  const ruleName = firewallRuleName(port);
  const command = commandString(port);
  if (ruleExists(port, runner)) return { action: 'exists', ruleName, command };
  const add = runner(addRuleArgs(port));
  if (add && !add.error && add.status === 0) return { action: 'added', ruleName, command };
  // unelevated or failed → guide the operator, never crash
  return { action: 'guide', ruleName, command };
}

module.exports = { firewallRuleName, addRuleArgs, showRuleArgs, commandString, ruleExists, ensureInboundRule };
