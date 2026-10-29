'use strict';

// #1227 (telepty#93) — `telepty service` cross-platform lifecycle.
//
// SAFETY: this suite NEVER touches a real service manager. Every launchctl,
// systemctl, schtasks and loginctl call goes through an injected recorder, the
// filesystem is an in-memory map, and the daemon probe is an injected function.
// No daemon is started, no socket is opened, no descriptor under the real $HOME
// is read or written. A platform branch exercised here is evidence about the
// COMMANDS and EXIT CODES we would issue — it is explicitly not native
// acceptance for that OS (facts F-1..F-12 stay controller-owned).
//
// ONE exception, and it is the point of the R-1 section: those cases exercise the
// probe cli.js REALLY injects, so "does asking this question create a credential?"
// is asked against a real filesystem — a private HOME whose emptiness IS the
// assertion. `globalThis.fetch` is stubbed there, so still no socket and no daemon.

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fsReal = require('fs');
const path = require('path');

// #1227 R-1: a private HOME for the probe cases, created INSIDE the per-process
// temp HOME that test-support/setup-env.js already installed (so it is removed
// when this process exits). Set BEFORE any `require('../cli')` in this file:
// auth.js captures CONFIG_DIR from os.homedir() at require time, so a later
// override would measure a different directory than the product would mint into.
const PROBE_HOME = fsReal.mkdtempSync(path.join(process.env.HOME, 'probe-home-'));
process.env.HOME = PROBE_HOME;

const {
  SERVICE_EXIT,
  classifyDescriptor,
  getServiceStatus,
  planInstall,
  planUninstall,
  probeLinger,
  resolveServiceTarget,
  runServiceVerb
} = require('../src/service');
const {
  buildLaunchdPlist,
  buildSystemdService,
  buildWindowsAutostartCommand
} = require('../install');

const HOME = '/home/tester';
const MAC_HOME = '/Users/tester';
const PKG_ROOT = '/opt/prefix/lib/node_modules/@dmsdc-ai/aigentry-telepty';
const NODE_BIN = '/opt/prefix/bin/node';
const CLI_JS = path.join(PKG_ROOT, 'cli.js');
const UID = 501;
const PKG_VERSION = require('../package.json').version;

const PLIST_PATH = path.join(MAC_HOME, 'Library', 'LaunchAgents', 'com.aigentry.telepty.plist');
const UNIT_PATH = path.join(HOME, '.config', 'systemd', 'user', 'telepty.service');
const SYSTEM_UNIT_PATH = '/etc/systemd/system/telepty.service';
const TARGET = `gui/${UID}/com.aigentry.telepty`;

// The exact bytes the shipped builders produce for this fixture — the `managed`
// oracle. Reusing the product builders is deliberate: a descriptor this suite
// hand-wrote would stop proving "equal to what install would write today".
function expectedPlist(overrides = {}) {
  return buildLaunchdPlist({
    label: 'com.aigentry.telepty',
    nodeBin: NODE_BIN,
    cliJs: CLI_JS,
    logDir: path.join(MAC_HOME, '.telepty', 'logs'),
    command: 'daemon',
    extraEnv: {},
    ...overrides
  });
}

function expectedUnit(overrides = {}) {
  return buildSystemdService({
    nodeBin: NODE_BIN,
    cliJs: CLI_JS,
    wantedBy: 'default.target',
    command: 'daemon',
    description: 'Telepty Daemon',
    extraEnv: {},
    ...overrides
  });
}

// ── injected world ────────────────────────────────────────────────────────────

// `exec` entries are matched by longest command prefix, so a case only has to
// name the calls it cares about. An unmatched call is a FAILURE, not a silent
// default: a verb that shells out to something the fixture never declared is
// exactly the regression this suite exists to catch.
function fakeWorld(options = {}) {
  const files = new Map(Object.entries(options.files || {}));
  const calls = {
    exec: [],        // [cmd, ...argv] argv-based execFileSync
    shell: [],       // raw execSync strings
    writes: [],      // [path, contents, mode]
    mkdirs: [],
    removals: []
  };

  const responses = options.exec || {};

  function respond(key, record) {
    const names = Object.keys(responses)
      .filter((prefix) => key === prefix || key.startsWith(`${prefix} `))
      .sort((a, b) => b.length - a.length);
    if (names.length === 0) {
      throw new Error(`fixture did not declare a response for: ${key}`);
    }
    const value = responses[names[0]];
    const result = typeof value === 'function' ? value(record) : value;
    if (result instanceof Error) throw result;
    return typeof result === 'string' ? result : '';
  }

  const deps = {
    platform: options.platform || 'linux',
    homedir: options.homedir || HOME,
    uid: UID,
    user: 'tester',
    env: options.env || {},
    packageRoot: PKG_ROOT,
    nodeBin: NODE_BIN,
    port: 3848,
    sleep: async () => {},
    waitMs: 0,
    fs: {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => {
        if (!files.has(p)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        return files.get(p);
      },
      writeFileSync: (p, contents, opts) => {
        calls.writes.push([p, String(contents), opts && opts.mode]);
        files.set(p, String(contents));
      },
      mkdirSync: (p) => { calls.mkdirs.push(p); },
      rmSync: (p) => { calls.removals.push(p); files.delete(p); }
    },
    execFileSync: (cmd, argv) => {
      const record = [cmd, ...(argv || [])];
      calls.exec.push(record);
      return respond(record.join(' '), record);
    },
    execSync: (cmd) => {
      calls.shell.push(cmd);
      return respond(cmd, [cmd]);
    },
    ...(options.deps || {})
  };

  return { deps, calls, files };
}

const launchctlLoaded = (pid = 9100) => `com.aigentry.telepty = {\n\tstate = running\n\tpid = ${pid}\n}`;
const launchctlMissing = () => Object.assign(new Error('Could not find service'), { status: 113 });

const systemctlShow = (fields) => Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n');

function schtasksXml({ command = NODE_BIN, args = `"${CLI_JS}" daemon` } = {}) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2"><Actions><Exec>
<Command>${command}</Command>
<Arguments>${args}</Arguments>
</Exec></Actions></Task>`;
}

// macOS fixtures reuse one shape: a loaded-or-not launchd with a declared plist.
function macWorld({ plist, loaded = false, files = {}, ...rest } = {}) {
  return fakeWorld({
    platform: 'darwin',
    homedir: MAC_HOME,
    files: plist === undefined ? files : { [PLIST_PATH]: plist, ...files },
    exec: {
      [`launchctl print ${TARGET}`]: loaded ? launchctlLoaded() : launchctlMissing(),
      [`launchctl bootout ${TARGET}`]: '',
      [`launchctl bootstrap gui/${UID} ${PLIST_PATH}`]: '',
      [`launchctl kickstart ${TARGET}`]: '',
      [`launchctl kickstart -k ${TARGET}`]: ''
    },
    ...rest
  });
}

function linuxWorld({ unit, reachable = true, linger = 'yes', files = {}, state = {}, ...rest } = {}) {
  return fakeWorld({
    platform: 'linux',
    homedir: HOME,
    files: unit === undefined ? files : { [UNIT_PATH]: unit, ...files },
    exec: {
      'systemctl --user show-environment': reachable ? 'LANG=C' : Object.assign(new Error('Failed to connect to bus'), { status: 1 }),
      'systemctl --user show telepty': systemctlShow({
        LoadState: 'loaded',
        ActiveState: 'active',
        SubState: 'running',
        UnitFileState: 'enabled',
        MainPID: '7777',
        ...state
      }),
      'systemctl --user daemon-reload': '',
      'systemctl --user enable telepty': '',
      'systemctl --user disable --now telepty': '',
      'systemctl --user reset-failed telepty': '',
      'systemctl --user start telepty': '',
      'systemctl --user stop telepty': '',
      'systemctl --user restart telepty': '',
      'loginctl show-user tester -p Linger --value': linger instanceof Error ? linger : linger
    },
    ...rest
  });
}

function winWorld({ registered = true, xml, createResult = '', ...rest } = {}) {
  return fakeWorld({
    platform: 'win32',
    homedir: 'C:\\Users\\tester',
    exec: {
      'schtasks /query /tn telepty-daemon /xml': registered
        ? (xml || schtasksXml())
        : Object.assign(new Error('The system cannot find the file specified.'), { status: 1 }),
      'schtasks /run /tn telepty-daemon': '',
      'schtasks /end /tn telepty-daemon': '',
      'schtasks /delete /tn telepty-daemon /f': ''
    },
    ...rest
  });
}

const answering = (over = {}) => async () => ({ answered: true, version: PKG_VERSION, pid: 4242, ...over });
const silent = () => async () => null;

const CONSENTED = { yes: true, isTTY: false };

// ── A-U1 / A-U19: status on a clean macOS host ────────────────────────────────

test('A-U1: darwin with no plist reports not-installed, exit 3, boot-without-login unsupported', async () => {
  const { deps, calls } = macWorld({ files: {} });
  const status = await getServiceStatus(deps);

  assert.equal(status.kind, 'launchd');
  assert.equal(status.installed, false);
  assert.equal(status.loaded, false);
  assert.equal(status.descriptor.ownership, 'absent');
  assert.equal(status.exitCode, SERVICE_EXIT.NOT_INSTALLED);
  assert.equal(status.startup.atLogin, 'no');
  assert.equal(status.startup.bootWithoutLogin, 'unsupported-requires-admin');
  assert.deepEqual(status.remedies, ['telepty service install']);
  // A read-only status must never mutate.
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.removals, []);
});

test('A-U19: status --json carries the v1 schema and no token or config content', async () => {
  const { deps } = macWorld({
    plist: expectedPlist(),
    loaded: true,
    deps: { getDaemonMeta: answering(), readDaemonState: () => ({ pid: 4242, port: 3848, version: PKG_VERSION }) }
  });
  const status = await getServiceStatus(deps);

  assert.equal(status.schema, 'telepty.service-status/v1');
  for (const key of ['platform', 'kind', 'installed', 'loaded', 'active', 'descriptor', 'daemon', 'startup', 'conflicts', 'remedies']) {
    assert.ok(Object.hasOwn(status, key), `status is missing ${key}`);
  }
  for (const key of ['atLogin', 'bootWithoutLogin', 'linger', 'reason', 'hint']) {
    assert.ok(Object.hasOwn(status.startup, key), `status.startup is missing ${key}`);
  }
  assert.deepEqual(Object.keys(status.descriptor).sort(), ['drift', 'ownership', 'path']);
  assert.equal(status.descriptor.ownership, 'managed');
  assert.equal(status.daemon.answering, true);
  assert.equal(status.daemon.matchesPackage, true);
  assert.equal(status.exitCode, SERVICE_EXIT.OK);

  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /token|secret|password|TELEPTY_AUTH/i);
  JSON.parse(serialized); // valid JSON by construction
});

test('status: loaded plist whose daemon never answers is DEGRADED, not OK', async () => {
  const { deps } = macWorld({
    plist: expectedPlist(),
    loaded: true,
    deps: { getDaemonMeta: silent() }
  });
  const status = await getServiceStatus(deps);
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(status.daemon.answering, false);
  assert.equal(status.exitCode, SERVICE_EXIT.DEGRADED);
});

test('status: with no probe injected, answering is null — unmeasured is not false', async () => {
  const { deps } = macWorld({ plist: expectedPlist(), loaded: true });
  const status = await getServiceStatus(deps);
  assert.equal(status.daemon.answering, null);
});

// ── A-U2: descriptor classification ───────────────────────────────────────────

test('A-U2: classifyDescriptor separates managed, drifted (nodeBin / install.sh style) and foreign', () => {
  const expected = { nodeBin: NODE_BIN, cliJs: CLI_JS, text: expectedPlist() };

  assert.equal(classifyDescriptor(expectedPlist(), 'launchd', expected), 'managed');

  const otherNode = expectedPlist({ nodeBin: '/Users/tester/.nvm/versions/node/v22.1.0/bin/node' });
  assert.equal(classifyDescriptor(otherNode, 'launchd', expected), 'drifted');

  // install.sh:96-99 writes [<prefix>/bin/telepty, daemon] — ours, older shape.
  const installShPlist = expectedPlist({ nodeBin: '/usr/local/bin/telepty', cliJs: 'daemon', command: 'daemon' });
  assert.equal(classifyDescriptor(installShPlist, 'launchd', expected), 'drifted');

  const foreign = `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.example.other</string>
<key>ProgramArguments</key><array><string>/usr/bin/sleep</string><string>99</string></array></dict></plist>`;
  assert.equal(classifyDescriptor(foreign, 'launchd', expected), 'foreign');

  const unitExpected = { nodeBin: NODE_BIN, cliJs: CLI_JS, text: expectedUnit() };
  assert.equal(classifyDescriptor(expectedUnit(), 'systemd-user', unitExpected), 'managed');
  assert.equal(classifyDescriptor(expectedUnit({ nodeBin: '/usr/bin/node' }), 'systemd-user', unitExpected), 'drifted');
  assert.equal(classifyDescriptor('[Service]\nExecStart=/usr/bin/redis-server\n', 'systemd-user', unitExpected), 'foreign');
});

test('status: a drifted node path is reported with drift=[nodeBin] and an install remedy', async () => {
  const { deps } = macWorld({
    plist: expectedPlist({ nodeBin: '/usr/local/bin/node' }),
    loaded: true,
    deps: { getDaemonMeta: answering() }
  });
  const status = await getServiceStatus(deps);
  assert.equal(status.descriptor.ownership, 'drifted');
  assert.deepEqual(status.descriptor.drift, ['nodeBin']);
  assert.equal(status.exitCode, SERVICE_EXIT.DEGRADED);
  assert.ok(status.remedies.includes('telepty service install'));
});

// ── A-U3 / A-U4: macOS plan and verbs ─────────────────────────────────────────

test('A-U3: darwin planInstall writes the plist 0644 and bootstraps, with no bootout when unloaded', () => {
  const { deps } = macWorld({ files: {} });
  const plan = planInstall(deps);

  assert.equal(plan.kind, 'launchd');
  assert.deepEqual(plan.writes, [{ path: PLIST_PATH, mode: 0o644 }]);
  assert.deepEqual(plan.commands, [['launchctl', 'bootstrap', `gui/${UID}`, PLIST_PATH]]);
  assert.equal(plan.refusal, null);
  const flat = JSON.stringify(plan);
  assert.doesNotMatch(flat, /sudo/);
  assert.doesNotMatch(flat, /LaunchDaemons|\/etc\/systemd/);
});

test('A-U3: darwin planInstall boots out first when the agent is already loaded', () => {
  const { deps } = macWorld({ plist: expectedPlist(), loaded: true });
  const plan = planInstall(deps);
  assert.deepEqual(plan.commands, [
    ['launchctl', 'bootout', TARGET],
    ['launchctl', 'bootstrap', `gui/${UID}`, PLIST_PATH]
  ]);
});

test('A-U4: darwin stop=bootout, start=bootstrap when unloaded, restart=kickstart -k', async () => {
  const stopWorld = macWorld({ plist: expectedPlist(), loaded: true });
  const stop = await runServiceVerb('stop', CONSENTED, stopWorld.deps);
  assert.equal(stop.exitCode, SERVICE_EXIT.OK);
  assert.deepEqual(stopWorld.calls.exec.filter(([, verb]) => verb !== 'print'), [['launchctl', 'bootout', TARGET]]);
  assert.deepEqual(stopWorld.calls.removals, [], 'stop must never delete the plist');

  const coldWorld = macWorld({ plist: expectedPlist(), loaded: false });
  await runServiceVerb('start', CONSENTED, coldWorld.deps);
  assert.deepEqual(coldWorld.calls.exec.filter(([, verb]) => verb !== 'print'), [
    ['launchctl', 'bootstrap', `gui/${UID}`, PLIST_PATH]
  ]);

  const warmWorld = macWorld({ plist: expectedPlist(), loaded: true });
  await runServiceVerb('start', CONSENTED, warmWorld.deps);
  assert.deepEqual(warmWorld.calls.exec.filter(([, verb]) => verb !== 'print'), [
    ['launchctl', 'kickstart', TARGET]
  ], 'a loaded agent is kickstarted without -k');

  const restartWorld = macWorld({ plist: expectedPlist(), loaded: true });
  await runServiceVerb('restart', CONSENTED, restartWorld.deps);
  assert.deepEqual(restartWorld.calls.exec.filter(([, verb]) => verb !== 'print'), [
    ['launchctl', 'kickstart', '-k', TARGET]
  ]);
});

test('darwin install writes exactly the shipped builder bytes and verifies afterwards', async () => {
  const world = macWorld({ files: {}, deps: { getDaemonMeta: answering() } });
  world.deps.execFileSync = ((inner) => (cmd, argv) => {
    // After bootstrap, `print` must report loaded — the verification step.
    if (argv && argv[0] === 'print' && world.calls.exec.some(([, v]) => v === 'bootstrap')) {
      world.calls.exec.push([cmd, ...argv]);
      return launchctlLoaded();
    }
    return inner(cmd, argv);
  })(world.deps.execFileSync);

  const result = await runServiceVerb('install', CONSENTED, world.deps);

  assert.equal(result.exitCode, SERVICE_EXIT.OK, JSON.stringify(result.steps));
  assert.equal(world.calls.writes.length, 1);
  const [writtenPath, contents, mode] = world.calls.writes[0];
  assert.equal(writtenPath, PLIST_PATH);
  assert.equal(contents, expectedPlist(), 'install must write exactly what buildLaunchdPlist produces');
  assert.equal(mode, 0o644);
  assert.ok(world.calls.mkdirs.includes(path.dirname(PLIST_PATH)));
  assert.ok(world.calls.mkdirs.includes(path.join(MAC_HOME, '.telepty', 'logs')));
  assert.equal(result.status.descriptor.ownership, 'managed');
});

test('darwin install reports gui-session-required instead of falling back to a detached daemon', async () => {
  const world = macWorld({ files: {} });
  world.deps.execFileSync = ((inner) => (cmd, argv) => {
    if (argv && argv[0] === 'bootstrap') {
      world.calls.exec.push([cmd, ...argv]);
      throw Object.assign(new Error('Bootstrap failed: 5: Input/output error'), { status: 5 });
    }
    return inner(cmd, argv);
  })(world.deps.execFileSync);

  const result = await runServiceVerb('install', CONSENTED, world.deps);
  assert.equal(result.exitCode, SERVICE_EXIT.FAILED);
  assert.equal(result.reason, 'gui-session-required');
  assert.match(JSON.stringify(result.steps), /launchctl bootstrap/);
  assert.doesNotMatch(JSON.stringify(result), /detach/i);
});

// ── A-U5 / A-U6: linux user manager ───────────────────────────────────────────

test('A-U5: linux with an unreachable user manager is kind=none and install changes nothing', async () => {
  const { deps, calls } = linuxWorld({ files: {}, reachable: false });

  const target = resolveServiceTarget(deps);
  assert.equal(target.kind, 'none');
  assert.equal(target.reason, 'user-manager-unreachable');

  const status = await getServiceStatus(deps);
  assert.equal(status.kind, 'none');
  assert.equal(status.startup.reason, 'user-manager-unreachable');
  assert.equal(status.startup.atLogin, 'unsupported');
  assert.equal(status.startup.bootWithoutLogin, 'unsupported');

  const result = await runServiceVerb('install', CONSENTED, deps);
  assert.equal(result.exitCode, SERVICE_EXIT.NEEDS_ADMIN);
  assert.equal(result.reason, 'user-manager-unreachable');
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.mkdirs, []);
});

test('A-U6: linux planInstall writes the default.target user unit and enables it with --user', () => {
  const { deps } = linuxWorld({ files: {} });
  const plan = planInstall(deps);

  assert.equal(plan.kind, 'systemd-user');
  assert.deepEqual(plan.writes, [{ path: UNIT_PATH, mode: 0o644 }]);
  assert.equal(plan.contents, expectedUnit());
  assert.match(plan.contents, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(plan.contents, /^User=/m);
  assert.deepEqual(plan.commands, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', 'telepty'],
    ['systemctl', '--user', 'restart', 'telepty']
  ]);
});

test('linux install writes the unit, then reload/enable/restart in that order', async () => {
  const world = linuxWorld({ files: {}, deps: { getDaemonMeta: answering() } });
  const result = await runServiceVerb('install', CONSENTED, world.deps);

  assert.equal(result.exitCode, SERVICE_EXIT.OK, JSON.stringify(result.steps));
  assert.deepEqual(world.calls.writes, [[UNIT_PATH, expectedUnit(), 0o644]]);
  const mutating = world.calls.exec.filter(([, , verb]) => ['daemon-reload', 'enable', 'restart'].includes(verb));
  assert.deepEqual(mutating, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', 'telepty'],
    ['systemctl', '--user', 'restart', 'telepty']
  ]);
  assert.deepEqual(world.calls.shell, [], 'no shell string is ever built on linux');
});

test('linux uninstall disables, removes the unit and reloads', async () => {
  const world = linuxWorld({ unit: expectedUnit() });
  const result = await runServiceVerb('uninstall', CONSENTED, world.deps);

  assert.equal(result.exitCode, SERVICE_EXIT.OK, JSON.stringify(result.steps));
  assert.deepEqual(world.calls.removals, [UNIT_PATH]);
  const issued = world.calls.exec.map((c) => c.join(' '));
  assert.ok(issued.includes('systemctl --user disable --now telepty'));
  assert.ok(issued.includes('systemctl --user daemon-reload'));
});

// ── A-U7: a system unit is read-only and never competes ───────────────────────

test('A-U7: linux with a system unit reports the conflict and refuses every mutating verb with exit 5', async () => {
  for (const verb of ['install', 'start', 'stop', 'restart', 'uninstall']) {
    const world = linuxWorld({ files: { [SYSTEM_UNIT_PATH]: expectedUnit({ wantedBy: 'multi-user.target', user: 'tester' }) } });
    const result = await runServiceVerb(verb, CONSENTED, world.deps);

    assert.equal(result.exitCode, SERVICE_EXIT.NEEDS_ADMIN, `${verb} must exit 5`);
    assert.ok(
      result.manualCommands.some((c) => /^sudo systemctl /.test(c)),
      `${verb} must print the exact sudo commands, got ${JSON.stringify(result.manualCommands)}`
    );
    assert.deepEqual(world.calls.writes, [], `${verb} must not write a user unit`);
    assert.deepEqual(world.calls.removals, []);
    // No systemctl invocation without --user may be issued at all: not even a
    // read, so a mutating system-scope call cannot hide behind a status probe.
    const systemScope = world.calls.exec.filter(([cmd, first]) => cmd === 'systemctl' && first !== '--user');
    assert.deepEqual(systemScope, [], `${verb} issued a system-scope systemctl call`);
  }
});

test('A-U7: status on a host with a system unit lists it in conflicts and stays readable', async () => {
  const { deps } = linuxWorld({
    files: { [SYSTEM_UNIT_PATH]: expectedUnit({ wantedBy: 'multi-user.target' }) }
  });
  const status = await getServiceStatus(deps);
  assert.equal(status.kind, 'systemd');
  assert.deepEqual(status.conflicts, [{ kind: 'systemd', path: SYSTEM_UNIT_PATH }]);
  assert.equal(status.startup.bootWithoutLogin, 'yes');
  assert.ok(status.remedies.some((r) => /^sudo systemctl /.test(r)));
});

// ── A-U8: linger is probed, never enabled ─────────────────────────────────────

test('A-U8: linger yes/no/failing maps to bootWithoutLogin yes/no/unknown and only hints', async () => {
  const cases = [
    ['yes\n', 'yes', false],
    ['no\n', 'no', true],
    [Object.assign(new Error('Failed to connect to bus'), { status: 1 }), 'unknown', false]
  ];

  for (const [response, expected, expectHint] of cases) {
    const { deps, calls } = linuxWorld({ unit: expectedUnit(), linger: response });
    assert.equal(probeLinger(deps), expected);

    const status = await getServiceStatus(deps);
    assert.equal(status.startup.linger, expected);
    assert.equal(status.startup.bootWithoutLogin, expected);
    if (expectHint) {
      assert.match(status.startup.hint, /loginctl enable-linger tester/);
      assert.ok(status.remedies.some((r) => /loginctl enable-linger tester/.test(r)));
    } else {
      assert.ok(!status.startup.hint || !/enable-linger/.test(status.startup.hint));
    }

    const loginctl = calls.exec.filter(([cmd]) => cmd === 'loginctl');
    assert.ok(loginctl.length > 0, 'linger must actually be probed');
    for (const call of loginctl) {
      assert.ok(!call.includes('enable-linger'), `loginctl was called with enable-linger: ${call.join(' ')}`);
    }
  }
});

test('A-U8: a missing loginctl falls back to the linger marker file, read-only', () => {
  const { deps, calls } = linuxWorld({
    unit: expectedUnit(),
    linger: Object.assign(new Error('loginctl: not found'), { status: 127 }),
    files: { [UNIT_PATH]: expectedUnit(), '/var/lib/systemd/linger/tester': '' }
  });
  assert.equal(probeLinger(deps), 'yes');
  assert.deepEqual(calls.writes, []);
});

// ── A-U9 / A-U10 / A-U11: Windows ─────────────────────────────────────────────

test('A-U9: win32 with no registered task is not-installed, exit 3, boot-without-login unsupported', async () => {
  const { deps } = winWorld({ registered: false });
  const status = await getServiceStatus(deps);

  assert.equal(status.kind, 'schtasks');
  assert.equal(status.installed, false);
  assert.equal(status.descriptor.path, 'telepty-daemon');
  assert.equal(status.exitCode, SERVICE_EXIT.NOT_INSTALLED);
  assert.equal(status.startup.bootWithoutLogin, 'unsupported-requires-admin');
  assert.equal(status.startup.linger, 'n/a');
});

test('A-U9: win32 install reuses the shipped /create string verbatim, then /run', async () => {
  const world = winWorld({ registered: false, deps: { getDaemonMeta: answering() } });
  const expectedCreate = buildWindowsAutostartCommand({ nodeBin: NODE_BIN, cliJs: CLI_JS, taskName: 'telepty-daemon', command: 'daemon' });
  world.deps.execSync = (cmd) => { world.calls.shell.push(cmd); return ''; };
  // After /create the task exists, so the verification query must answer.
  world.deps.execFileSync = ((inner) => (cmd, argv) => {
    const record = [cmd, ...(argv || [])];
    if (argv && argv[0] === '/query' && world.calls.shell.length > 0) {
      world.calls.exec.push(record);
      return schtasksXml();
    }
    return inner(cmd, argv);
  })(world.deps.execFileSync);

  const result = await runServiceVerb('install', CONSENTED, world.deps);

  assert.equal(result.exitCode, SERVICE_EXIT.OK, JSON.stringify(result.steps));
  assert.deepEqual(world.calls.shell, [expectedCreate], 'the /create string must be the shipped builder output, unmodified');
  assert.match(world.calls.shell[0], /\/sc onlogon/);
  assert.match(world.calls.shell[0], /\/rl LIMITED/);
  assert.ok(
    world.calls.exec.some((c) => c.join(' ') === 'schtasks /run /tn telepty-daemon'),
    'the task must be started with an argv-based /run'
  );
  assert.deepEqual(world.calls.writes, [], 'win32 writes no descriptor file');
});

test('A-U10: win32 /create access-denied exits 5 requires-admin and never runs the task', async () => {
  const world = winWorld({ registered: false });
  world.deps.execSync = (cmd) => {
    world.calls.shell.push(cmd);
    throw Object.assign(new Error('ERROR: Access is denied.'), { status: 1, stderr: 'ERROR: Access is denied.' });
  };

  const result = await runServiceVerb('install', CONSENTED, world.deps);

  assert.equal(result.exitCode, SERVICE_EXIT.NEEDS_ADMIN);
  assert.equal(result.reason, 'requires-admin');
  assert.equal(world.calls.shell.length, 1);
  assert.ok(
    !world.calls.exec.some((c) => c.includes('/run')),
    '/run must not be executed after a denied /create'
  );
  assert.deepEqual(world.calls.writes, []);
  assert.deepEqual(world.calls.removals, []);
});

test('A-U11: win32 task pointing at another cli.js is drifted, and liveness comes from the probe', async () => {
  const { deps } = winWorld({
    xml: schtasksXml({ args: '"C:\\other\\pkg\\cli.js" daemon' }),
    deps: { getDaemonMeta: answering({ version: PKG_VERSION }) }
  });
  const status = await getServiceStatus(deps);

  assert.equal(status.installed, true);
  assert.equal(status.descriptor.ownership, 'drifted');
  assert.deepEqual(status.descriptor.drift, ['cliJs']);
  assert.equal(status.active, true, 'active comes from the daemon probe');
  assert.equal(status.exitCode, SERVICE_EXIT.DEGRADED);
});

test('A-U11: a localized schtasks Status line is never the liveness oracle', async () => {
  const { deps } = winWorld({ xml: schtasksXml(), deps: { getDaemonMeta: silent() } });
  const status = await getServiceStatus(deps);
  assert.equal(status.installed, true);
  assert.equal(status.active, false, 'no answer from the daemon means not active');
  assert.doesNotMatch(JSON.stringify(status), /Status:/);
});

test('win32 verbs use argv for run/end/delete and build no shell string', async () => {
  for (const [verb, expected] of [
    ['start', ['schtasks /run /tn telepty-daemon']],
    ['stop', ['schtasks /end /tn telepty-daemon']],
    ['restart', ['schtasks /end /tn telepty-daemon', 'schtasks /run /tn telepty-daemon']],
    ['uninstall', ['schtasks /end /tn telepty-daemon', 'schtasks /delete /tn telepty-daemon /f']]
  ]) {
    const world = winWorld({});
    const result = await runServiceVerb(verb, CONSENTED, world.deps);
    assert.equal(result.exitCode, SERVICE_EXIT.OK, `${verb}: ${JSON.stringify(result.steps)}`);
    const issued = world.calls.exec.filter(([, flag]) => flag !== '/query').map((c) => c.join(' '));
    assert.deepEqual(issued, expected, verb);
    assert.deepEqual(world.calls.shell, [], `${verb} must not build a shell string`);
  }
});

// ── §4: the one shell boundary is validated before it is built ────────────────

test('the /create shell string is refused, not built, when a descriptor path is unsafe', async () => {
  const world = fakeWorld({
    platform: 'win32',
    homedir: 'C:\\Users\\tester',
    packageRoot: 'C:\\evil" & calc.exe & "\\pkg',
    exec: {
      'schtasks /query /tn telepty-daemon /xml': Object.assign(new Error('not found'), { status: 1 })
    },
    deps: { packageRoot: 'C:\\evil" & calc.exe & "\\pkg' }
  });

  const result = await runServiceVerb('install', CONSENTED, world.deps);
  assert.equal(result.exitCode, SERVICE_EXIT.FAILED);
  assert.equal(result.reason, 'unsafe-descriptor-argument');
  assert.deepEqual(world.calls.shell, [], 'nothing may be handed to a shell after validation fails');
});

// ── A-U12 / A-U13: consent and dry-run ────────────────────────────────────────

test('A-U12: non-TTY without --yes exits 2 with zero fs writes and zero exec calls', async () => {
  for (const verb of ['install', 'uninstall']) {
    for (const world of [macWorld({ plist: expectedPlist() }), linuxWorld({ unit: expectedUnit() }), winWorld({})]) {
      const result = await runServiceVerb(verb, { yes: false, isTTY: false }, world.deps);
      assert.equal(result.exitCode, SERVICE_EXIT.CONSENT, `${verb} on ${world.deps.platform}`);
      assert.equal(result.reason, 'consent-required');
      assert.deepEqual(world.calls.writes, []);
      assert.deepEqual(world.calls.removals, []);
      assert.deepEqual(world.calls.exec, [], 'consent is decided before anything is executed');
      assert.deepEqual(world.calls.shell, []);
    }
  }
});

test('A-U12: a declined TTY prompt changes nothing', async () => {
  const world = macWorld({ files: {} });
  let asked = 0;
  const result = await runServiceVerb('install', {
    yes: false,
    isTTY: true,
    confirm: async () => { asked += 1; return false; }
  }, world.deps);

  assert.equal(asked, 1);
  assert.equal(result.exitCode, SERVICE_EXIT.CONSENT);
  assert.equal(result.reason, 'declined');
  assert.deepEqual(world.calls.writes, []);
  assert.ok(!world.calls.exec.some(([, verb]) => verb === 'bootstrap'));
});

test('A-U13: --dry-run prints a plan, exits 0, and performs no write or mutating exec', async () => {
  for (const [verb, world] of [
    ['install', macWorld({ files: {} })],
    ['uninstall', macWorld({ plist: expectedPlist(), loaded: true })],
    ['install', linuxWorld({ files: {} })],
    ['uninstall', linuxWorld({ unit: expectedUnit() })],
    ['install', winWorld({ registered: false })],
    ['uninstall', winWorld({})]
  ]) {
    const result = await runServiceVerb(verb, { yes: false, isTTY: false, dryRun: true }, world.deps);
    assert.equal(result.exitCode, SERVICE_EXIT.OK, `${verb}/${world.deps.platform}: ${JSON.stringify(result)}`);
    assert.ok(result.plan, 'a dry run must return the plan it would have executed');
    assert.deepEqual(world.calls.writes, [], `${verb}/${world.deps.platform} wrote a file`);
    assert.deepEqual(world.calls.removals, []);
    assert.deepEqual(world.calls.mkdirs, []);
    assert.deepEqual(world.calls.shell, []);
    const mutating = world.calls.exec.filter((c) => !/(^| )(print|\/query|show|show-environment|show-user)( |$)/.test(c.join(' ')));
    assert.deepEqual(mutating, [], `${verb}/${world.deps.platform} issued a mutating command: ${JSON.stringify(mutating)}`);
  }
});

// ── A-U14: a foreign descriptor is never overwritten or deleted ───────────────

test('A-U14: install refuses a foreign descriptor without --replace and writes nothing', async () => {
  const foreign = '<?xml version="1.0"?><plist><dict><key>Label</key><string>com.example.other</string></dict></plist>';
  const world = macWorld({ plist: foreign });

  const result = await runServiceVerb('install', CONSENTED, world.deps);
  assert.equal(result.exitCode, SERVICE_EXIT.CONSENT);
  assert.equal(result.reason, 'foreign-descriptor');
  assert.deepEqual(world.calls.writes, []);
  assert.equal(world.files.get(PLIST_PATH), foreign, 'the foreign descriptor must survive byte-for-byte');
});

test('A-U14: --replace overwrites a foreign descriptor; uninstall never deletes one', async () => {
  const foreign = '<?xml version="1.0"?><plist><dict><key>Label</key><string>com.example.other</string></dict></plist>';

  const replaceWorld = macWorld({ plist: foreign, deps: { getDaemonMeta: answering() } });
  replaceWorld.deps.execFileSync = ((inner) => (cmd, argv) => {
    if (argv && argv[0] === 'print' && replaceWorld.calls.exec.some(([, v]) => v === 'bootstrap')) {
      replaceWorld.calls.exec.push([cmd, ...argv]);
      return launchctlLoaded();
    }
    return inner(cmd, argv);
  })(replaceWorld.deps.execFileSync);
  const replaced = await runServiceVerb('install', { yes: true, isTTY: false, replace: true }, replaceWorld.deps);
  assert.equal(replaced.exitCode, SERVICE_EXIT.OK, JSON.stringify(replaced.steps));
  assert.equal(replaceWorld.files.get(PLIST_PATH), expectedPlist());

  const uninstallWorld = macWorld({ plist: foreign, loaded: true });
  const removed = await runServiceVerb('uninstall', CONSENTED, uninstallWorld.deps);
  assert.deepEqual(uninstallWorld.calls.removals, [], 'a foreign descriptor is never deleted');
  assert.equal(uninstallWorld.files.get(PLIST_PATH), foreign);
  assert.equal(removed.status.descriptor.ownership, 'foreign');
});

// ── A-U18: `telepty uninstall` reaches the non-launchd services ───────────────

test('A-U18: planUninstall exposes the systemd-user unit and the schtasks task as services', () => {
  const linux = planUninstall(linuxWorld({ unit: expectedUnit() }).deps);
  assert.equal(linux.kind, 'systemd-user');
  assert.deepEqual(linux.removals, [UNIT_PATH]);

  const win = planUninstall(winWorld({}).deps);
  assert.equal(win.kind, 'schtasks');
  assert.deepEqual(win.removals, []);
  assert.ok(win.commands.some((c) => c.join(' ') === 'schtasks /delete /tn telepty-daemon /f'));
});

test('A-U18: src/uninstall runUninstall drives the systemd-user service; preuninstall never does', () => {
  const { planUninstall: planFullUninstall, runPreuninstall, runUninstall } = require('../src/uninstall');

  const execFile = [];
  const removed = [];
  const base = {
    platform: 'linux',
    homedir: HOME,
    cleanupDaemonProcesses: () => ({ stopped: [], failed: [] }),
    execFileSync: (cmd, argv) => { execFile.push([cmd, ...(argv || [])].join(' ')); return ''; },
    fs: {
      existsSync: (p) => p === UNIT_PATH,
      readFileSync: () => expectedUnit(),
      rmSync: (p) => { removed.push(p); },
      writeFileSync: () => { throw new Error('uninstall must never write'); },
      mkdirSync: () => { throw new Error('uninstall must never mkdir'); }
    },
    serviceDeps: { platform: 'linux', homedir: HOME, packageRoot: PKG_ROOT, nodeBin: NODE_BIN, uid: UID, user: 'tester' }
  };

  const plan = planFullUninstall(base);
  assert.ok(plan.services, 'planUninstall must report the generated non-launchd services');
  assert.equal(plan.services.kind, 'systemd-user');

  const result = runUninstall(base);
  assert.ok(execFile.some((c) => c === 'systemctl --user disable --now telepty'), execFile.join(' | '));
  assert.deepEqual(removed, [UNIT_PATH]);
  assert.ok(result.services, 'runUninstall must report what it did to the service');

  // The npm preuninstall pass keeps its exact pre-#1227 scope.
  execFile.length = 0;
  removed.length = 0;
  const quiet = runPreuninstall(base);
  assert.deepEqual(execFile, [], 'preuninstall must not touch systemd');
  assert.deepEqual(removed, []);
  assert.ok(quiet !== null);
});

test('A-U18: a dry-run uninstall reports the service without touching it', () => {
  const { runUninstall } = require('../src/uninstall');
  const execFile = [];
  const result = runUninstall({
    platform: 'linux',
    homedir: HOME,
    dryRun: true,
    cleanupDaemonProcesses: () => { throw new Error('dry run must not stop daemons'); },
    execFileSync: (cmd, argv) => { execFile.push([cmd, ...(argv || [])].join(' ')); return ''; },
    fs: {
      existsSync: (p) => p === UNIT_PATH,
      readFileSync: () => expectedUnit(),
      rmSync: () => { throw new Error('dry run must not delete'); }
    },
    serviceDeps: { platform: 'linux', homedir: HOME, packageRoot: PKG_ROOT, nodeBin: NODE_BIN, uid: UID, user: 'tester' }
  });
  assert.deepEqual(execFile, []);
  assert.ok(result.services);
});

// ── A-U15: the daemon verbs route to the supervisor, not to a detached spawn ──

test('A-U15: decideDaemonVerbRoute sends supervised verbs to the service and keeps the local path otherwise', () => {
  const { decideDaemonVerbRoute } = require('../cli');

  for (const kind of ['launchd', 'systemd-user', 'schtasks']) {
    for (const sub of ['start', 'stop', 'restart']) {
      const route = decideDaemonVerbRoute({ present: true, kind }, sub);
      assert.equal(route.route, 'service', `${kind}/${sub}`);
      assert.equal(route.kind, kind);
    }
  }

  // The root-owned system unit is the one supervised kind this CLI must not drive.
  const system = decideDaemonVerbRoute({ present: true, kind: 'systemd' }, 'restart');
  assert.equal(system.route, 'manual');
  assert.equal(system.exitCode, SERVICE_EXIT.NEEDS_ADMIN);
  assert.match(system.command, /^sudo systemctl restart telepty$/);

  for (const supervisor of [{ present: false }, null, { present: false, kind: null, detail: 'disabled-by-env' }]) {
    assert.equal(decideDaemonVerbRoute(supervisor, 'start').route, 'local');
  }
});

// ── R-1: the probe cli.js actually injects must never mint a credential ───────

// The seam under test is the SHIPPED one: `serviceDeps()` is exactly what
// cli.js hands to getServiceStatus for `telepty service status`, so the token
// resolution and the HTTP call below are real product code, not a mock. Only the
// OS seams stay faked, and `globalThis.fetch` is stubbed — nothing opens a socket.
function listTree(root, prefix = '') {
  const found = [];
  for (const entry of fsReal.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    found.push(rel);
    if (entry.isDirectory()) found.push(...listTree(path.join(root, entry.name), rel));
  }
  return found.sort();
}

async function probeThroughCli(world, respond) {
  const { serviceDeps } = require('../cli');
  const fetches = [];
  const realFetch = globalThis.fetch;
  const ambientToken = process.env.TELEPTY_AUTH_TOKEN;
  // An ambient token would answer the question without reading any config, which
  // would make this case pass for the wrong reason.
  delete process.env.TELEPTY_AUTH_TOKEN;
  globalThis.fetch = async (url, options = {}) => {
    fetches.push({ url: String(url), headers: { ...(options.headers || {}) } });
    return respond();
  };
  try {
    return { status: await getServiceStatus(serviceDeps(world.deps)), fetches };
  } finally {
    globalThis.fetch = realFetch;
    if (ambientToken !== undefined) process.env.TELEPTY_AUTH_TOKEN = ambientToken;
  }
}

test('R-1: status through the real CLI probe mints no config on a host that has none', async () => {
  assert.deepEqual(listTree(PROBE_HOME), [], 'the private HOME must start empty');

  const world = macWorld({ plist: expectedPlist(), loaded: true });
  // A refusal is an ANSWER (#835/#844): the daemon is there, it just declined.
  const { status, fetches } = await probeThroughCli(world, () => ({ ok: false, status: 401 }));

  // THE assertion: asking a read-only question left nothing behind.
  assert.deepEqual(
    listTree(PROBE_HOME), [],
    'telepty service status created something under a config-less HOME (R-1: a read-only question must not mint a credential)'
  );

  assert.equal(fetches.length, 1, 'the real CLI probe must have been traced, not a mock');
  assert.equal(fetches[0].url, 'http://127.0.0.1:3848/api/meta');
  assert.equal(
    Object.hasOwn(fetches[0].headers, 'x-telepty-token'), false,
    'with no config on disk there is no credential to present — and none may be invented'
  );

  assert.equal(status.daemon.answering, true, 'an HTTP refusal is evidence of an answering daemon');
  assert.equal(status.daemon.version, null, 'no version may be fabricated from a refusal');
  assert.equal(status.daemon.matchesPackage, null);
});

test('R-1: an existing config is used read-only — exact token sent, bytes unchanged', async () => {
  const pkgVersion = require('../package.json').version;
  const configDir = path.join(PROBE_HOME, '.telepty');
  const configFile = path.join(configDir, 'config.json');
  // Generated per run, never a literal: a checked-in token-shaped string is a
  // hardcoded-secret finding, and these assertions only ever need THIS run's
  // value to be the one that reached the wire. Still entirely synthetic — no
  // real token or config is read, written or consulted anywhere in this file.
  const syntheticToken = `synthetic-${randomUUID()}`;
  const synthetic = `${JSON.stringify({ authToken: syntheticToken, clientRestart: 'auto' }, null, 2)}\n`;
  fsReal.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fsReal.writeFileSync(configFile, synthetic, { mode: 0o600 });

  try {
    const world = macWorld({ plist: expectedPlist(), loaded: true });
    const { status, fetches } = await probeThroughCli(world, () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: pkgVersion, pid: 4242 })
    }));

    assert.equal(fetches[0].headers['x-telepty-token'], syntheticToken,
      'an existing credential is presented as-is');
    assert.equal(fsReal.readFileSync(configFile, 'utf8'), synthetic,
      'the probe must not rewrite, rotate or re-mint an existing config');
    assert.deepEqual(listTree(PROBE_HOME), ['.telepty', path.join('.telepty', 'config.json')],
      'nothing beyond the pre-existing config may appear');

    assert.equal(status.daemon.answering, true);
    assert.equal(status.daemon.version, pkgVersion);
    assert.equal(status.daemon.matchesPackage, true);
    assert.equal(status.exitCode, SERVICE_EXIT.OK);
  } finally {
    fsReal.rmSync(configDir, { recursive: true, force: true });
  }
});

// ── R-2: `tolerate` is a list of step indices, not a boolean ──────────────────

test('R-2: a tolerated first step may fail, but a denied final delete is exit 1 and never completed', async () => {
  // win32 uninstall plans `/end` (tolerate: [0]) and then `/delete … /f`.
  const toleratedWorld = winWorld({});
  toleratedWorld.deps.execFileSync = ((inner) => (cmd, argv) => {
    const record = [cmd, ...(argv || [])];
    if (record.join(' ') === 'schtasks /end /tn telepty-daemon') {
      toleratedWorld.calls.exec.push(record);
      throw Object.assign(new Error('ERROR: The system cannot find the task specified.'), {
        status: 1, stderr: 'ERROR: The system cannot find the task specified.'
      });
    }
    return inner(cmd, argv);
  })(toleratedWorld.deps.execFileSync);

  const tolerated = await runServiceVerb('uninstall', CONSENTED, toleratedWorld.deps);
  assert.equal(tolerated.exitCode, SERVICE_EXIT.OK, 'a not-running task is exactly what step 0 tolerates');
  assert.equal(tolerated.ok, true);
  assert.ok(
    toleratedWorld.calls.exec.some((c) => c.join(' ') === 'schtasks /delete /tn telepty-daemon /f'),
    'a tolerated failure must not stop the plan'
  );
  assert.equal(tolerated.steps.find((s) => s.ok === false).command, 'schtasks /end /tn telepty-daemon',
    'a tolerated failure is still reported');

  const deniedWorld = winWorld({});
  deniedWorld.deps.execFileSync = ((inner) => (cmd, argv) => {
    const record = [cmd, ...(argv || [])];
    if (record.join(' ') === 'schtasks /delete /tn telepty-daemon /f') {
      deniedWorld.calls.exec.push(record);
      throw Object.assign(new Error('ERROR: Access is denied.'), { status: 1, stderr: 'ERROR: Access is denied.' });
    }
    return inner(cmd, argv);
  })(deniedWorld.deps.execFileSync);

  const denied = await runServiceVerb('uninstall', CONSENTED, deniedWorld.deps);
  assert.equal(denied.exitCode, SERVICE_EXIT.FAILED,
    'the logon task still exists, so the uninstall did NOT complete (R-2)');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'step-failed');
  assert.equal(denied.steps.find((s) => s.ok === false).command, 'schtasks /delete /tn telepty-daemon /f');
  assert.notEqual(denied.exitCode, tolerated.exitCode,
    'a tolerated step failure and a non-tolerated one must not be the same result');
});

// ── R-3: a foreign descriptor is never driven as if it were ours ──────────────

const FOREIGN_PLIST = `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.example.other</string>
<key>ProgramArguments</key><array><string>/usr/bin/sleep</string><string>99</string></array></dict></plist>`;

function mutatingCalls(calls) {
  return calls.exec.filter((c) => !/(^| )(print|\/query|show|show-environment|show-user)( |$)/.test(c.join(' ')));
}

test('R-3: foreign start/stop/restart/uninstall refuse with zero mutating exec and zero removals', async () => {
  for (const verb of ['start', 'stop', 'restart', 'uninstall']) {
    const world = macWorld({ plist: FOREIGN_PLIST, loaded: true });
    const result = await runServiceVerb(verb, CONSENTED, world.deps);

    assert.equal(result.exitCode, SERVICE_EXIT.CONSENT, `${verb} must refuse a foreign descriptor`);
    assert.equal(result.reason, 'foreign-descriptor', verb);
    assert.deepEqual(mutatingCalls(world.calls), [],
      `${verb} drove a job it does not own: ${JSON.stringify(mutatingCalls(world.calls))}`);
    assert.deepEqual(world.calls.removals, [], `${verb} removed a foreign descriptor`);
    assert.equal(world.files.get(PLIST_PATH), FOREIGN_PLIST, `${verb} altered the foreign descriptor`);
    // The refusal still explains the host it refused on.
    assert.equal(result.status.descriptor.ownership, 'foreign', verb);
  }
});

test('R-3: --replace stays install-only, and owned descriptors are still driven', async () => {
  for (const verb of ['start', 'stop', 'restart', 'uninstall']) {
    const world = macWorld({ plist: FOREIGN_PLIST, loaded: true });
    const result = await runServiceVerb(verb, { yes: true, isTTY: false, replace: true }, world.deps);
    assert.equal(result.exitCode, SERVICE_EXIT.CONSENT,
      `--replace must not become permission to ${verb} an unrelated job`);
    assert.deepEqual(mutatingCalls(world.calls), [], `${verb} --replace drove a foreign job`);
    assert.deepEqual(world.calls.removals, []);
  }

  // Positive controls: ownership gating must not have disarmed the owned paths.
  const stopWorld = macWorld({ plist: expectedPlist(), loaded: true });
  const stopped = await runServiceVerb('stop', CONSENTED, stopWorld.deps);
  assert.equal(stopped.exitCode, SERVICE_EXIT.OK);
  assert.deepEqual(mutatingCalls(stopWorld.calls), [['launchctl', 'bootout', TARGET]]);

  const uninstallWorld = macWorld({ plist: expectedPlist(), loaded: true });
  const uninstalled = await runServiceVerb('uninstall', CONSENTED, uninstallWorld.deps);
  assert.equal(uninstalled.exitCode, SERVICE_EXIT.OK);
  assert.deepEqual(uninstallWorld.calls.removals, [PLIST_PATH]);
});

// ── R-4: `installed` is a boolean in v1, always ───────────────────────────────

test('R-4: linux status with a reachable manager and no unit reports installed === false', async () => {
  const shapes = [
    ['empty UnitFileState', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nMainPID=0'],
    ['absent UnitFileState', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0']
  ];

  for (const [label, shown] of shapes) {
    // No unit file on disk, but the user manager answers — the common fresh host.
    const world = linuxWorld({ files: {} });
    world.deps.execFileSync = ((inner) => (cmd, argv) => {
      const record = [cmd, ...(argv || [])];
      if (record.join(' ').startsWith('systemctl --user show telepty')) {
        world.calls.exec.push(record);
        return shown;
      }
      return inner(cmd, argv);
    })(world.deps.execFileSync);

    const status = await getServiceStatus(world.deps);
    assert.equal(status.kind, 'systemd-user', label);
    assert.strictEqual(status.installed, false, `${label}: installed must be exactly false, not '' or undefined`);
    assert.equal(status.exitCode, SERVICE_EXIT.NOT_INSTALLED, label);

    const roundTripped = JSON.parse(JSON.stringify(status));
    assert.ok(Object.hasOwn(roundTripped, 'installed'), `${label}: JSON.stringify dropped the installed key`);
    assert.strictEqual(roundTripped.installed, false, label);
  }
});

// ── R-5: one rule for null — unmeasured is neither success nor failure ────────

test('R-5: an unmeasured observation degrades identically on every platform and is named', async () => {
  const mac = macWorld({ plist: expectedPlist(), loaded: true });
  const macStatus = await getServiceStatus(mac.deps);
  assert.equal(macStatus.daemon.answering, null, 'no probe injected ⇒ unmeasured');
  assert.deepEqual(macStatus.inconclusive, ['daemon.answering']);
  assert.equal(macStatus.exitCode, SERVICE_EXIT.DEGRADED,
    'exit 0 means installed+loaded+active+answering; an unmeasured daemon is not that');

  const win = winWorld({});
  const winStatus = await getServiceStatus(win.deps);
  assert.equal(winStatus.active, null);
  assert.deepEqual(winStatus.inconclusive, ['active', 'daemon.answering']);
  assert.equal(winStatus.exitCode, SERVICE_EXIT.DEGRADED,
    'the same unmeasured state must not read as success on one platform and drift on another');

  const measured = macWorld({ plist: expectedPlist(), loaded: true, deps: { getDaemonMeta: answering() } });
  const measuredStatus = await getServiceStatus(measured.deps);
  assert.deepEqual(measuredStatus.inconclusive, [], 'a measured status is conclusive');
  assert.equal(measuredStatus.exitCode, SERVICE_EXIT.OK);
});

test('R-5: install separates the command result from an unmeasured post-state', async () => {
  // These three cases differ ONLY in the injected daemon probe.
  const unmeasured = linuxWorld({ files: {} });
  const u = await runServiceVerb('install', CONSENTED, unmeasured.deps);
  assert.equal(u.exitCode, SERVICE_EXIT.OK, 'every command the plan issued did succeed');
  assert.equal(u.verified, false, 'an unmeasured post-state is never a verified success');
  assert.equal(u.reason, 'unverified-post-state');
  assert.deepEqual(u.status.inconclusive, ['daemon.answering']);

  const measuredDead = linuxWorld({ files: {}, deps: { getDaemonMeta: silent() } });
  const d = await runServiceVerb('install', CONSENTED, measuredDead.deps);
  assert.equal(d.exitCode, SERVICE_EXIT.FAILED, 'a daemon measured as dead after install is a failed install');
  assert.equal(d.verified, false);
  assert.notEqual(d.exitCode, u.exitCode, 'unmeasured and measured-dead must not be the same result');

  const measuredLive = linuxWorld({ files: {}, deps: { getDaemonMeta: answering() } });
  const l = await runServiceVerb('install', CONSENTED, measuredLive.deps);
  assert.equal(l.exitCode, SERVICE_EXIT.OK);
  assert.equal(l.verified, true, 'a measured, answering daemon is the only verified success');
});

// ── invariants ────────────────────────────────────────────────────────────────

test('INV: src/service.js never calls process.exit, npm, sudo or enable-linger as a command', () => {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'service.js'), 'utf8');
  assert.doesNotMatch(source, /process\.exit\s*\(/);
  assert.doesNotMatch(source, /execFileSync\(\s*['"`](npm|sudo)/);
  assert.doesNotMatch(source, /execSync\(\s*['"`](npm|sudo)/);
  // `enable-linger` may appear only inside a hint string, never in an argv array.
  assert.doesNotMatch(source, /\[\s*['"`]enable-linger/);
  assert.doesNotMatch(source, /'enable-linger'\s*,/);
});

test('INV-4: no service verb reads, writes or deletes config, credentials or state dirs', async () => {
  const touched = [];
  const world = macWorld({ plist: expectedPlist(), loaded: true, deps: { getDaemonMeta: answering() } });
  const innerExists = world.deps.fs.existsSync;
  const innerRead = world.deps.fs.readFileSync;
  world.deps.fs.existsSync = (p) => { touched.push(p); return innerExists(p); };
  world.deps.fs.readFileSync = (p) => { touched.push(p); return innerRead(p); };

  for (const verb of ['start', 'stop', 'restart', 'uninstall']) {
    await runServiceVerb(verb, CONSENTED, world.deps);
  }
  await getServiceStatus(world.deps);

  for (const p of touched) {
    assert.doesNotMatch(p, /config\.json|credentials|auth|\.telepty\/(?!logs)/, `a service verb touched ${p}`);
  }
  assert.ok(world.calls.writes.every(([p]) => p === PLIST_PATH));
});

test('INV: default descriptors stay port-less, so the daemon keeps reading its own config', () => {
  const macPlan = planInstall(macWorld({ files: {} }).deps);
  assert.doesNotMatch(macPlan.contents, /<key>(?:TELEPTY_)?PORT<\/key>/);
  const linuxPlan = planInstall(linuxWorld({ files: {} }).deps);
  assert.doesNotMatch(linuxPlan.contents, /Environment="?(?:TELEPTY_)?PORT=/);
});

test('INV: an unknown verb is a usage error, not an action', async () => {
  const world = macWorld({ plist: expectedPlist() });
  const result = await runServiceVerb('nuke', CONSENTED, world.deps);
  assert.equal(result.exitCode, SERVICE_EXIT.CONSENT);
  assert.equal(result.reason, 'usage');
  assert.deepEqual(world.calls.exec, []);
  assert.deepEqual(world.calls.writes, []);
});

test('INV: a failing mutating step reports exit 1 and names the exact command', async () => {
  const world = linuxWorld({ unit: expectedUnit(), files: {} });
  world.deps.execFileSync = ((inner) => (cmd, argv) => {
    const record = [cmd, ...(argv || [])];
    if (record.join(' ') === 'systemctl --user enable telepty') {
      world.calls.exec.push(record);
      throw Object.assign(new Error('Failed to enable unit'), { status: 1, stderr: 'Failed to enable unit: Permission denied' });
    }
    return inner(cmd, argv);
  })(world.deps.execFileSync);

  const result = await runServiceVerb('install', CONSENTED, world.deps);
  assert.equal(result.exitCode, SERVICE_EXIT.FAILED);
  const failed = result.steps.find((s) => s.ok === false);
  assert.equal(failed.command, 'systemctl --user enable telepty');
  assert.match(failed.stderr, /Permission denied/);
});
