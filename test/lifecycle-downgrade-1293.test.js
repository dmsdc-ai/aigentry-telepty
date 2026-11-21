'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const post = require('../scripts/postinstall');
const pre = require('../scripts/preuninstall');
const { ownsLifecycleTarget, restartSupervisorDaemon } = require('../src/supervisor');
const { requestGracefulStop } = require('../src/daemon-shutdown');
const pkg = require('../package.json');
const root = '/usr/local/lib/node_modules/' + pkg.name;
const env = { npm_config_global: 'true' };
const forbidden = () => assert.fail('unexpected lifecycle effect');

test('both hooks reject nested package paths before inspecting the host', async () => {
  for (const prefix of ['/usr/local/lib', '/opt/homebrew/lib', 'C:\\npm']) {
    const sep = prefix.startsWith('C:') ? '\\' : '/';
    const packagePath = pkg.name.replace('/', sep);
    const direct = [prefix, 'node_modules', packagePath].join(sep);
    const nested = [prefix, 'node_modules', '@other', 'parent', 'node_modules', packagePath].join(sep);
    assert.equal(post.shouldSkip(env, direct), null);
    for (const [physical, manifest] of [[nested, direct], [direct, nested], [nested, nested]]) {
      for (const hook of [post, pre]) {
        const lines = [];
        await hook.main({ packageRoot: physical,
          env: { ...env, npm_package_json: manifest + sep + 'package.json', TELEPTY_ALLOW_DAEMON_DOWNGRADE: '1' },
          logger: { log: line => lines.push(line) }, detectSupervisor: forbidden, readDaemonState: forbidden });
        assert.equal(lines.length, 1);
        assert.match(lines[0], /daemon left alone/);
      }
    }
  }
  assert.ok(post.shouldSkip({ ...env, npm_config_prefix: '/different' }, root));
  assert.ok(post.shouldSkip({ ...env, npm_command: 'run-script' }, root));
  assert.ok(post.shouldSkip({}, root));
  assert.ok(post.shouldSkip(env, '/src/telepty'));
});

test('only a known older daemon or a deliberate downgrade reaches the recorded stop', async () => {
  for (const [version, override, replace] of [
    ['99.0.0', '', false], ['99.0.0', 'true', false], ['99.0.0', '1', true],
    [pkg.version, '1', false], [pkg.version + '+local', '', false],
    [pkg.version + '-rc.1', '', true], ['0.1.0', '', true], [null, '1', false], ['1.0.0?', '1', false]
  ]) {
    const state = { pid: 22, host: '127.0.0.1', port: 4522, version };
    const calls = [];
    await post.main({ packageRoot: root, env: { ...env, TELEPTY_ALLOW_DAEMON_DOWNGRADE: override },
      readDaemonState: () => state, detectSupervisor: () => ({ present: false }), diagnoseBinOwnership: () => null,
      logger: { log() {}, warn() {} },
      stopRecordedDaemon: target => { calls.push(target.pid); return true; },
      spawnDetachedDaemon: (_, opts) => calls.push(opts.port) });
    assert.deepEqual(calls, replace ? [22, 4522] : []);
  }
});

test('supervisor identity must match before any stop or start', async () => {
  const messages = [];
  await post.main({ packageRoot: root, env, diagnoseBinOwnership: () => null,
    readDaemonState: () => ({ pid: 22, port: 4522, version: '0.1.0' }),
    detectSupervisor: () => ({ present: true, kind: 'systemd' }),
    ownsLifecycleTarget: () => false, stopRecordedDaemon: forbidden, restartSupervisorDaemon: forbidden,
    logger: { log() {}, warn: line => messages.push(line) } });
  assert.match(messages.join('\n'), /deferred.*telepty daemon restart/);
});

test('service lookup binds the loaded PID and entrypoint; subsequent start cannot stop a raced replacement', () => {
  const cli = '/npm/cli.js';
  const state = { pid: 123 };
  for (const kind of ['launchd', 'systemd', 'systemd-user']) {
    for (const [pid, entry, owned] of [[123, cli, true], [124, cli, false], [123, '/else/cli.js', false]]) {
      const info = kind === 'launchd'
        ? '\tprogram = ' + process.execPath + '\n\targuments = {\n\t\t' + process.execPath + '\n\t\t' + entry + '\n\t\tdaemon\n\t}\n\tpid = ' + pid
        : 'MainPID=' + pid + '\nExecStart={ path=' + entry + ' ; argv[]=' + entry + ' daemon ; ignore_errors=no ; }';
      assert.equal(ownsLifecycleTarget({ kind }, state, { cli, realpathSync: s => s, getuid: () => 501,
        execFileSync: () => info }), owned);
    }
    let command;
    restartSupervisorDaemon({ kind, present: true }, { startOnly: true, getuid: () => 501,
      execFileSync: (_, args) => { command = args; } });
    assert.ok(command.includes(kind === 'launchd' ? 'kickstart' : 'start'));
    assert.ok(!command.includes('-k') && !command.includes('restart'));
  }
  assert.equal(ownsLifecycleTarget({ kind: 'schtasks' }, state), false);
});

test('a different live PID, version, host or port never receives the stop request', async () => {
  const state = { pid: 123, port: 4522, host: '127.0.0.1', version: '0.1.0', instanceId: 'original' };
  for (const change of [{ pid: 124 }, { version: '99.0.0' }, { host: 'other' }, { port: 4523 }, { instance_id: 'replacement' }]) {
    const requests = [];
    const result = await requestGracefulStop({ expectedState: state, port: state.port, token: 'fixture',
      confirmCmdline: forbidden, fetchImpl: async url => {
        requests.push(url);
        return { status: 200, json: async () => ({ ...state, instance_id: state.instanceId, ...change }) };
      } });
    assert.equal(result.reason, 'state_changed');
    assert.deepEqual(requests, ['http://127.0.0.1:4522/api/meta']);
  }
});

test('preuninstall stops only a matching standalone daemon via the recorded-instance gate', async () => {
  for (const [version, present, expected] of [[pkg.version, false, 1], [pkg.version, true, 0],
    ['99.0.0', false, 0], ['unknown', false, 0]]) {
    const calls = [];
    const state = { pid: 22, port: 4522, host: '127.0.0.1', version };
    await pre.main({ env, packageRoot: root, logger: { log() {} }, readDaemonState: () => state,
      detectSupervisor: () => ({ present }), stopRecordedDaemon: (target, supervised) => {
        assert.deepEqual(target, state);
        assert.equal(supervised, false);
        calls.push(target.pid);
        return true;
      } });
    assert.equal(calls.length, expected);
  }
});

test('a verified upgrade requests exactly one instance stop and confirms its exit', async () => {
  const pid = 23;
  const state = { pid, port: 4523, host: '127.0.0.1', version: '0.11.2', supervised: true };
  const instance = require('../src/daemon-shutdown').newInstanceId();
  const stops = [];
  const outcome = await requestGracefulStop({ port: state.port, expectedState: state, token: 'fixture',
    isProcessRunning: target => { assert.equal(target, pid); return false; }, confirmCmdline: target => target === pid,
    readLockPid: () => null, probeHealth: forbidden,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/meta')) return { status: 200, json: async () => ({ ...state, instance_id: instance }) };
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      stops.push(body);
      return { status: 202, json: async () => ({ ...body, accepted: true }) };
    } });
  assert.deepEqual(stops, [{ pid, instance_id: instance }]);
  assert.deepEqual(outcome, { status: 'stopped', pid, lockRetained: false });
});
