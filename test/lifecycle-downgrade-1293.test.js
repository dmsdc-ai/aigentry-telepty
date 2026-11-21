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
      stopRecordedDaemon: target => { calls.push(target.pid); return { startReplacement: true }; },
      waitForDaemonVersion: async () => ({ version: pkg.version, pid: 333 }),
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
    restartSupervisorDaemon({ kind, present: true }, { getuid: () => 501,
      execFileSync: (_, args) => { command = args; } }, { startOnly: true });
    assert.ok(command.includes(kind === 'launchd' ? 'kickstart' : 'start'));
    assert.ok(!command.includes('-k') && !command.includes('restart'));
  }
  assert.equal(ownsLifecycleTarget({ kind: 'schtasks' }, state, { execFileSync: () => '{}' }), false);
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
        return { startReplacement: true };
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

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function fixtureHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('both package locations resolve through a symlinked npm prefix', t => {
  const dir = fixtureHome(t);
  const prefix = path.join(dir, 'physical');
  const alias = path.join(dir, 'alias');
  const modules = process.platform === 'win32' ? 'node_modules' : 'lib/node_modules';
  const installed = path.join(prefix, modules, pkg.name);
  fs.mkdirSync(installed, { recursive: true });
  fs.symlinkSync(prefix, alias, 'junction');
  const config = { ...env, npm_config_prefix: alias, npm_package_json: path.join(alias, modules, pkg.name, 'package.json') };
  assert.equal(post.installScope(config, fs.realpathSync(installed)), null);
  const nested = path.join(prefix, modules, 'parent/node_modules', pkg.name);
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.symlinkSync(installed, nested, 'junction');
  assert.ok(post.installScope({ ...config, npm_package_json: path.join(nested, 'package.json') }, installed));
});

test('installed launchd and systemd commands accept both installer argv forms', () => {
  const cli = '/opt/my prefix/lib/node_modules/' + pkg.name + '/cli.js';
  const entry = '/opt/my prefix/bin/telepty';
  const node = '/opt/old node/bin/node';
  const pid = 789;
  for (const kind of ['launchd', 'systemd', 'systemd-user']) {
    for (const args of [[entry, 'daemon'], [node, cli, 'daemon']]) {
      const owns = ownsLifecycleTarget({ kind }, { pid }, {
        cli, getuid: () => 501, realpathSync: name => name === entry ? cli : name,
        execFileSync(tool, command) {
          if (kind === 'launchd') return '\tprogram = ' + args[0] + '\n\targuments = {\n' +
            args.map(a => '\t\t' + a + '\n').join('') + '\t}\n\tpid = ' + pid;
          assert.equal(command.includes('--user'), kind === 'systemd-user');
          if (tool === 'busctl') return JSON.stringify({ data: [[args[0], args, false, 0, 0, 0, 0, pid, 0, 0]] });
          assert.equal(tool, 'systemctl');
          return 'MainPID=' + pid + '\nExecStart={ path=' + args[0] + ' ; argv[]=' + args.join(' ') + ' ; ignore_errors=no ; }';
        }
      });
      assert.equal(owns, true, kind + ' ' + args.length);
    }
  }
});

test('scheduled task action must name this CLI and own the recorded worker', () => {
  const cli = 'C:\\npm dir\\cli.js';
  const program = 'C:\\old node\\node.exe';
  const task = { program, image: program, line: '"' + program + '" "' + cli + '" daemon', arguments: '"' + cli + '" daemon', pid: 13, parent: 7, engine: 7 };
  for (const [change, owned] of [[{}, true], [{ engine: 13 }, true], [{ engine: 2 }, false], [{ line: 'node other.js daemon' }, false],
    [{ arguments: '"C:\\other\\cli.js" daemon' }, false], [{ pid: 20 }, false]]) {
    assert.equal(ownsLifecycleTarget({ kind: 'schtasks' }, { pid: 13 }, {
      cli, realpathSync: s => s, execFileSync: () => JSON.stringify({ ...task, ...change })
    }), owned);
  }
});

test('recorded stop reports incomplete shutdown and recovers only on positive absence', async t => {
  const shutdown = require('../src/daemon-shutdown');
  const home = fixtureHome(t);
  fs.mkdirSync(path.join(home, '.telepty'));
  const file = path.join(home, '.telepty', 'daemon-state.json');
  const state = { pid: 481, port: 4481, host: '127.0.0.1', version: '0.11.2' };
  fs.writeFileSync(file, JSON.stringify(state));
  let result;
  const request = t.mock.method(shutdown, 'requestGracefulStop', async options => {
    assert.equal(options.expectedState.pid, state.pid);
    if (!result.error) return result;
    return requestGracefulStop({ ...options, token: 'fixture', signRequest: null,
      fetchImpl: async () => { throw Object.assign(new Error(), { code: result.error }); } });
  });
  for (const [injected, message, starts] of [
    [{ status: 'stopped', pid: state.pid, lockRetained: true }, /exited.*ledger lock/, 0],
    [{ status: 'timeout', pid: state.pid, exited: true }, /exited.*port still answered/, 0],
    [{ status: 'timeout', pid: state.pid, exited: false }, /present at the stop deadline/, 0],
    [{ status: 'unknown', reason: 'stop_request_failed' }, /stop request returned no response/, 0],
    [{ error: 'ETIMEDOUT' }, /presence unknown/, 0],
    [{ error: 'ECONNREFUSED' }, /Confirmed.*daemon/, 1]
  ]) {
    await t.test(injected.error || [injected.status, injected.exited].join(' '), async () => {
      result = injected;
      const lines = [];
      let spawned = 0;
      await post.main({ env, homeDir: home, platform: 'linux', packageRoot: root,
        detectSupervisor: () => ({ present: false }), diagnoseBinOwnership: () => null,
        logger: { log: line => lines.push(line), warn: line => lines.push(line) },
        spawnDetachedDaemon: (_, options) => { assert.equal(options.port, state.port); spawned++; },
        waitForDaemonVersion: async () => ({ pid: 482, version: pkg.version }) });
      assert.equal(spawned, starts);
      assert.match(lines.join('\n'), message);
      if (!starts) assert.match(lines.join('\n'), /TELEPTY_PORT=4481 telepty daemon restart/);
    });
  }
  const count = request.mock.callCount();
  assert.equal(count, 6);
  fs.writeFileSync(file, JSON.stringify({ ...state, pid: 482 }));
  assert.equal((await post.stopRecordedDaemon(state, false, home)).startReplacement, false);
  assert.equal(request.mock.callCount(), count);
});

test('post-stop start and version failures report recovery for the recorded port', async () => {
  for (const mode of ['manager-error', 'spawn-error', 'version-timeout']) {
    const lines = [];
    const supervised = mode === 'manager-error';
    await post.main({ env, packageRoot: root, platform: 'linux', diagnoseBinOwnership: () => null,
      readDaemonState: () => ({ pid: 481, port: 4481, version: '0.11.2' }),
      detectSupervisor: () => ({ present: supervised, kind: supervised ? 'systemd' : null,
        detail: supervised ? null : 'disabled-by-env' }),
      ownsLifecycleTarget: () => true, stopRecordedDaemon: () => ({ startReplacement: true }),
      restartSupervisorDaemon: () => ({ success: false, error: 'manager unavailable' }),
      spawnDetachedDaemon: () => { if (mode === 'spawn-error') throw new Error('spawn denied'); },
      waitForDaemonVersion: async () => null,
      logger: { log: line => lines.push(line), warn: line => lines.push(line) } });
    assert.match(lines.join('\n'), /TELEPTY_PORT=4481 telepty daemon restart/);
    assert.match(lines.join('\n'), {
      'manager-error': /manager unavailable/, 'spawn-error': /spawn denied/, 'version-timeout': /did not report/
    }[mode]);
  }
});

test('preuninstall exits successfully with its package dependencies missing', t => {
  const script = path.join(fixtureHome(t), 'preuninstall.js');
  fs.copyFileSync(require.resolve('../scripts/preuninstall'), script);
  const result = require('node:child_process').spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('missing capabilities preserve newer daemon and missing version preserves the liveness diagnostic', () => {
  const { decideDaemonAction } = require('../cli');
  const decision = decideDaemonAction({ meta: { version: '99.0.0', capabilities: [] },
    requiredCapabilities: ['new-feature'], cliVersion: pkg.version });
  assert.deepEqual(decision, { action: 'noop', reason: 'daemon-newer' });
  assert.deepEqual(decideDaemonAction({ meta: {}, healthOk: true, cliVersion: pkg.version }),
    { action: 'noop', reason: 'alive-but-slow' });
});

test('recorded graceful stop distinguishes a refused port from a timeout without a census', async t => {
  const { gracefulWindowsStop } = require('../cli');
  const state = { pid: 481, port: 4481, host: '127.0.0.1', version: '0.11.2' };
  let code;
  t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error(), { code }); });
  for (const [error, startReplacement] of [['ECONNREFUSED', true], ['ETIMEDOUT', false]]) {
    code = error;
    const outcome = await gracefulWindowsStop(state.port, state);
    assert.equal(outcome.startReplacement, startReplacement);
    assert.deepEqual(outcome.stopped, []);
  }
});

test('older daemon without an instance ID defers before posting a stop', async () => {
  const state = { pid: 481, port: 4481, host: '127.0.0.1', version: '0.8.5' };
  const result = await requestGracefulStop({ expectedState: state, port: state.port, token: 'fixture',
    confirmCmdline: forbidden, fetchImpl: async url => {
      assert.ok(url.endsWith('/api/meta'));
      return { status: 200, json: async () => state };
    } });
  assert.equal(result.reason, 'daemon_without_graceful_stop');
});
