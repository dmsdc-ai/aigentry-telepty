'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  buildLaunchdPlist,
  buildSystemdService,
  buildWindowsAutostartCommand,
  buildBrokerLaunchdPlist,
  buildBrokerSystemdService,
  buildBrokerWindowsAutostartCommand,
  collectBrokerServiceEnv,
  BROKER_LAUNCHD_LABEL,
  BROKER_SYSTEMD_SERVICE,
  BROKER_WINDOWS_TASK,
} = require('../install');

const BROKER_ENV = {
  TELEPTY_TLS_CERT: '/etc/telepty/broker.crt',
  TELEPTY_TLS_KEY: '/etc/telepty/broker.key',
  TELEPTY_JWT_SECRET: 'jwt-secret-value',
  TELEPTY_ENROLL_SECRET: 'enroll-secret-value',
};

test('collectBrokerServiceEnv passes through broker env keys + sets broker mode, never hardcodes secrets', () => {
  const env = collectBrokerServiceEnv({
    TELEPTY_TLS_CERT: '/etc/telepty/broker.crt',
    TELEPTY_TLS_KEY: '/etc/telepty/broker.key',
    TELEPTY_JWT_SECRET: 'jwt-secret-value',
    TELEPTY_ENROLL_SECRET: 'enroll-secret-value',
    TELEPTY_BROKER_ACL: '/etc/telepty/acl.json',
    TELEPTY_ENROLL_MAX_NODES: '128',
    PORT: '8443',
    UNRELATED_VAR: 'ignored',
  });

  assert.equal(env.TELEPTY_BROKER_MODE, '1');
  assert.equal(env.TELEPTY_TLS_CERT, '/etc/telepty/broker.crt');
  assert.equal(env.TELEPTY_TLS_KEY, '/etc/telepty/broker.key');
  assert.equal(env.TELEPTY_JWT_SECRET, 'jwt-secret-value');
  assert.equal(env.TELEPTY_ENROLL_SECRET, 'enroll-secret-value');
  assert.equal(env.TELEPTY_BROKER_ACL, '/etc/telepty/acl.json');
  assert.equal(env.TELEPTY_ENROLL_MAX_NODES, '128');
  assert.equal(env.PORT, '8443');
  assert.equal(env.UNRELATED_VAR, undefined);
});

test('collectBrokerServiceEnv omits unset/empty keys (pass-through only, no hardcoded secrets)', () => {
  const env = collectBrokerServiceEnv({ TELEPTY_JWT_SECRET: '', TELEPTY_TLS_CERT: undefined });
  assert.deepEqual(env, { TELEPTY_BROKER_MODE: '1' });
});

test('broker launchd plist runs cli.js broker (not daemon), distinct label, with broker env + reused #41 hardening', () => {
  const nodeBin = '/opt/homebrew/bin/node';
  const cliJs = '/usr/local/lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js';
  const logDir = '/tmp/telepty-broker-install-test';
  const plist = buildBrokerLaunchdPlist({ nodeBin, cliJs, logDir, env: BROKER_ENV });

  // runs `broker` not `daemon`, with absolute node + cli.js (reused #41 abs-path hardening)
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/usr\/local\/lib\/node_modules\/@dmsdc-ai\/aigentry-telepty\/cli\.js<\/string>\s*<string>broker<\/string>/);
  assert.doesNotMatch(plist, /<string>daemon<\/string>/);
  // distinct broker label
  assert.equal(BROKER_LAUNCHD_LABEL, 'com.aigentry.telepty-broker');
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.aigentry\.telepty-broker<\/string>/);
  // reused #41 EnvVars PATH hardening
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:/);
  // reused #41 StandardOut/Err hardening
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/tmp\/telepty-broker-install-test\/launchd\.out\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/tmp\/telepty-broker-install-test\/launchd\.err\.log<\/string>/);
  // broker env keys present (pass-through, secrets from install env)
  assert.match(plist, /<key>TELEPTY_BROKER_MODE<\/key>\s*<string>1<\/string>/);
  assert.match(plist, /<key>TELEPTY_TLS_CERT<\/key>\s*<string>\/etc\/telepty\/broker\.crt<\/string>/);
  assert.match(plist, /<key>TELEPTY_TLS_KEY<\/key>\s*<string>\/etc\/telepty\/broker\.key<\/string>/);
  assert.match(plist, /<key>TELEPTY_JWT_SECRET<\/key>\s*<string>jwt-secret-value<\/string>/);
  assert.match(plist, /<key>TELEPTY_ENROLL_SECRET<\/key>\s*<string>enroll-secret-value<\/string>/);
});

test('broker launchd plist passes plutil -lint (macOS only, TEST label, temp dir — no service load)', (t) => {
  if (os.platform() !== 'darwin') {
    t.skip('plutil -lint only available on macOS');
    return;
  }
  const plist = buildBrokerLaunchdPlist({
    label: 'com.aigentry.telepty-broker.TEST',
    nodeBin: '/opt/homebrew/bin/node',
    cliJs: '/tmp/cli.js',
    logDir: '/tmp/telepty-broker-install-test',
    env: BROKER_ENV,
  });
  const tmpFile = path.join(os.tmpdir(), `telepty-broker-test-${process.pid}.plist`);
  fs.writeFileSync(tmpFile, plist);
  try {
    const out = execFileSync('plutil', ['-lint', tmpFile], { encoding: 'utf8' });
    assert.match(out, /OK\s*$/);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('broker systemd unit runs cli.js broker with absolute paths + broker env, no literal PATH expansion', () => {
  const nodeBin = '/home/me/.nvm/versions/node/v22.1.0/bin/node';
  const cliJs = '/home/me/.npm-global/lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js';
  const service = buildBrokerSystemdService({ nodeBin, cliJs, user: 'me', env: BROKER_ENV });

  assert.match(service, /^ExecStart=\/home\/me\/\.nvm\/versions\/node\/v22\.1\.0\/bin\/node \/home\/me\/\.npm-global\/lib\/node_modules\/@dmsdc-ai\/aigentry-telepty\/cli\.js broker$/m);
  assert.doesNotMatch(service, /cli\.js daemon$/m);
  assert.doesNotMatch(service, /\$PATH/);
  assert.match(service, /^Environment=PATH=\/home\/me\/\.nvm\/versions\/node\/v22\.1\.0\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.match(service, /^Restart=always$/m);
  // distinct broker description
  assert.match(service, /^Description=Telepty Broker$/m);
  // broker env pass-through
  assert.match(service, /^Environment="TELEPTY_BROKER_MODE=1"$/m);
  assert.match(service, /^Environment="TELEPTY_TLS_CERT=\/etc\/telepty\/broker\.crt"$/m);
  assert.match(service, /^Environment="TELEPTY_JWT_SECRET=jwt-secret-value"$/m);
  assert.match(service, /^Environment="TELEPTY_ENROLL_SECRET=enroll-secret-value"$/m);
});

test('broker Windows task uses absolute node + cli.js broker, distinct task name', () => {
  const nodeBin = 'C:\\Program Files\\nodejs\\node.exe';
  const cliJs = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@dmsdc-ai\\aigentry-telepty\\cli.js';
  const command = buildBrokerWindowsAutostartCommand({ nodeBin, cliJs });

  assert.equal(BROKER_WINDOWS_TASK, 'telepty-broker');
  assert.match(command, /^schtasks \/create /);
  assert.match(command, /\/tn "telepty-broker"/);
  assert.match(command, new RegExp(`/tr "${escapeRegExp(`\\"${nodeBin}\\" \\"${cliJs}\\" broker`)}"`));
});

test('daemon install path is UNCHANGED — no broker command/env leaks into the daemon variant (#41 additive guard)', () => {
  const daemonPlist = buildLaunchdPlist({
    label: 'com.aigentry.telepty.TEST41',
    nodeBin: '/opt/homebrew/bin/node',
    cliJs: '/tmp/cli.js',
    logDir: '/tmp/telepty-install-test',
  });
  assert.match(daemonPlist, /<string>daemon<\/string>/);
  assert.doesNotMatch(daemonPlist, /<string>broker<\/string>/);
  assert.doesNotMatch(daemonPlist, /TELEPTY_BROKER_MODE/);
  assert.doesNotMatch(daemonPlist, /TELEPTY_JWT_SECRET/);

  const daemonService = buildSystemdService({ nodeBin: '/usr/bin/node', cliJs: '/tmp/cli.js' });
  assert.match(daemonService, /cli\.js daemon$/m);
  assert.doesNotMatch(daemonService, /cli\.js broker$/m);
  assert.doesNotMatch(daemonService, /TELEPTY_BROKER_MODE/);
  assert.match(daemonService, /^Description=Telepty Daemon$/m);

  const daemonWin = buildWindowsAutostartCommand({ nodeBin: 'C:\\node.exe', cliJs: 'C:\\cli.js' });
  assert.match(daemonWin, /daemon"$/);
  assert.match(daemonWin, /\/tn "telepty-daemon"/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
