'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLaunchdPlist,
  buildSystemdService,
  buildWindowsAutostartCommand,
} = require('../install');

test('macOS launchd plist uses absolute node and cli.js, with daemon PATH and logs', () => {
  const nodeBin = '/opt/homebrew/bin/node';
  const cliJs = '/usr/local/lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js';
  const logDir = '/tmp/telepty-install-test';
  const plist = buildLaunchdPlist({
    label: 'com.aigentry.telepty.TEST41',
    nodeBin,
    cliJs,
    logDir,
  });

  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/usr\/local\/lib\/node_modules\/@dmsdc-ai\/aigentry-telepty\/cli\.js<\/string>\s*<string>daemon<\/string>/);
  assert.doesNotMatch(plist, /<string>telepty<\/string>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/tmp\/telepty-install-test\/launchd\.out\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/tmp\/telepty-install-test\/launchd\.err\.log<\/string>/);
});

test('systemd unit uses absolute node and cli.js without literal PATH expansion', () => {
  const nodeBin = '/home/me/.nvm/versions/node/v22.1.0/bin/node';
  const cliJs = '/home/me/.npm-global/lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js';
  const service = buildSystemdService({
    nodeBin,
    cliJs,
    user: 'me',
  });

  assert.match(service, /^ExecStart=\/home\/me\/\.nvm\/versions\/node\/v22\.1\.0\/bin\/node \/home\/me\/\.npm-global\/lib\/node_modules\/@dmsdc-ai\/aigentry-telepty\/cli\.js daemon$/m);
  assert.doesNotMatch(service, /\$PATH/);
  assert.match(service, /^Environment=PATH=\/home\/me\/\.nvm\/versions\/node\/v22\.1\.0\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.match(service, /^Restart=always$/m);
});

test('Windows install registers a real logon task with absolute node and cli.js', () => {
  const nodeBin = 'C:\\Program Files\\nodejs\\node.exe';
  const cliJs = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@dmsdc-ai\\aigentry-telepty\\cli.js';
  const command = buildWindowsAutostartCommand({
    nodeBin,
    cliJs,
    taskName: 'telepty-daemon',
  });

  assert.match(command, /^schtasks \/create /);
  assert.match(command, /\/tn "telepty-daemon"/);
  assert.match(command, /\/sc onlogon/);
  assert.match(command, /\/rl LIMITED/);
  assert.match(command, /\/f/);
  assert.match(command, new RegExp(`/tr "${escapeRegExp(`\\"${nodeBin}\\" \\"${cliJs}\\" daemon`)}"`));
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
