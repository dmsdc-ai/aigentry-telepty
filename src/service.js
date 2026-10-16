// src/service.js — #1227: the consented, verb-complete OS service lifecycle.
//
// Before this, the only path that could write a service descriptor was
// install.js main(), which also runs `npm install -g`, sweeps daemons and loads
// a service with NO consent prompt and no linger visibility. There was no
// status (src/supervisor.js treats a descriptor FILE as "supervised", so an
// unloaded plist or a disabled unit read as present), and `telepty daemon
// start|stop|restart` bypassed the supervisor entirely — contradicting the
// #738/#757/#82 policy that a supervisor owns its daemon.
//
// Boundaries this module keeps (ACCEPTANCE INV-1..INV-7):
//   • user scope only — never sudo, a system unit write, `loginctl
//     enable-linger`, Set-ExecutionPolicy or `schtasks /ru SYSTEM`. An
//     unsupported scope is REPORTED (exit 5), never silently skipped.
//   • argv-based execFileSync everywhere. The ONE exception is the Windows
//     `/create` string, which reuses install.js's tested builder; its arguments
//     are validated before the string is built (see windowsCreateCommand).
//   • never reads, writes or deletes ~/.telepty/config.json, state dirs or
//     credentials, and descriptors stay port-less, so the daemon keeps reading
//     its own config exactly as today.
//   • no process.exit: every path returns a plain result object with an exit
//     code, so the caller owns the process.
//
// §17 무의존: fs/os/path/child_process plus install.js's existing builders and
// src/supervisor.js's constants. Every OS seam is injectable.

'use strict';

const fsDefault = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync: execFileSyncDefault, execSync: execSyncDefault } = require('child_process');

const {
  buildLaunchdPlist,
  buildSystemdService,
  buildWindowsAutostartCommand,
  resolveDaemonLaunchOptions,
  resolveServiceProfile
} = require('../install');
const {
  SYSTEMD_SERVICE_NAME,
  SYSTEMD_UNIT_PATH,
  SYSTEMD_USER_UNIT_NAME
} = require('./supervisor');
const { DEFAULT_PORT } = require('../daemon-control');
const pkg = require('../package.json');

const SCHEMA = 'telepty.service-status/v1';
const VERBS = ['install', 'uninstall', 'start', 'stop', 'restart'];
const DEFAULT_WAIT_MS = Number(process.env.TELEPTY_SUPERVISOR_WAIT_MS) > 0
  ? Number(process.env.TELEPTY_SUPERVISOR_WAIT_MS)
  : 10000;

const SERVICE_EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  CONSENT: 2,
  NOT_INSTALLED: 3,
  DEGRADED: 4,
  NEEDS_ADMIN: 5
});

function resolve(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  let user = deps.user || env.USER || env.USERNAME || null;
  if (!user) {
    try { user = os.userInfo().username; } catch { user = 'unknown'; }
  }
  return {
    platform,
    env,
    user,
    homedir: deps.homedir || os.homedir(),
    uid: deps.uid != null ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : null),
    fs: deps.fs || fsDefault,
    packageRoot: deps.packageRoot || path.resolve(__dirname, '..'),
    nodeBin: deps.nodeBin || process.execPath,
    port: deps.port || DEFAULT_PORT,
    execFileSync: deps.execFileSync || execFileSyncDefault,
    execSync: deps.execSync || execSyncDefault,
    getDaemonMeta: typeof deps.getDaemonMeta === 'function' ? deps.getDaemonMeta : null,
    readDaemonState: typeof deps.readDaemonState === 'function' ? deps.readDaemonState : null,
    probe: deps.probe !== false,
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    waitMs: deps.waitMs != null ? deps.waitMs : DEFAULT_WAIT_MS,
    now: deps.now || Date.now
  };
}

function ctxOf(deps) {
  return (deps && deps.__ctx) || resolve(deps);
}

function stderrOf(err) {
  return String((err && (err.stderr || err.message)) || '').trim();
}

// Every OS call funnels through here so a step is always reportable as
// { command, ok, stderr } — a failure names the exact command, never "failed".
function run(ctx, cmd, argv, options = {}) {
  const command = [cmd, ...argv].join(' ');
  try {
    const stdout = ctx.execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { command, ok: true, stdout: typeof stdout === 'string' ? stdout : '', stderr: '' };
  } catch (err) {
    return { command, ok: false, stdout: '', stderr: stderrOf(err), tolerate: Boolean(options.tolerate) };
  }
}

function readIfPresent(ctx, filePath) {
  try {
    return ctx.fs.existsSync(filePath) ? String(ctx.fs.readFileSync(filePath, 'utf8')) : null;
  } catch {
    return null;
  }
}

function launchOptions(ctx) {
  // Reuse install.js's resolver, but name logDir explicitly: its default reads
  // the real os.homedir(), which a test (or a --prefix install) must not hit.
  return resolveDaemonLaunchOptions({
    packageRoot: ctx.packageRoot,
    nodeBin: ctx.nodeBin,
    logDir: path.join(ctx.homedir, '.telepty', 'logs')
  });
}

// ── descriptor recognition ────────────────────────────────────────────────────

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function plistProgramArguments(text) {
  const block = String(text).match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return [];
  return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]));
}

function xmlTag(text, tag) {
  const match = String(text).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1]).trim() : null;
}

function systemdExecParts(text) {
  const match = String(text).match(/^ExecStart=(.*)$/m);
  if (!match) return [];
  // The builder quotes an argument only when it has to; both shapes split here.
  return (match[1].match(/"[^"]*"|\S+/g) || []).map((part) => part.replace(/^"|"$/g, ''));
}

// Is this descriptor a telepty daemon at all? `drifted` (ours, but different)
// and `foreign` (someone else's) must never be collapsed: install overwrites
// the first and refuses the second.
function recognizesTelepty(text, kind) {
  if (kind === 'launchd') {
    const args = plistProgramArguments(text);
    const ours = args.some((a) => /cli\.js$/.test(a) || path.basename(a) === 'telepty');
    return ours && args.includes('daemon');
  }
  if (kind === 'systemd' || kind === 'systemd-user') {
    return /^ExecStart=.*(cli\.js|[\\/]telepty)\s+daemon\b/m.test(String(text));
  }
  if (kind === 'schtasks') {
    const body = `${xmlTag(text, 'Command') || ''} ${xmlTag(text, 'Arguments') || ''}`;
    return /cli\.js/.test(body) && /\bdaemon\b/.test(body);
  }
  return false;
}

function classifyDescriptor(text, kind, expected = {}) {
  if (text == null) return 'absent';
  const body = String(text);
  if (expected.text != null && body === String(expected.text)) return 'managed';
  return recognizesTelepty(body, kind) ? 'drifted' : 'foreign';
}

// WHICH part drifted, so `status` can say "your node moved" instead of "broken".
function descriptorDrift(text, kind, expected = {}) {
  const drift = [];
  if (text == null) return drift;
  let parts = [];
  if (kind === 'launchd') parts = plistProgramArguments(text);
  else if (kind === 'systemd' || kind === 'systemd-user') parts = systemdExecParts(text);
  else if (kind === 'schtasks') {
    const args = xmlTag(text, 'Arguments') || '';
    if (xmlTag(text, 'Command') !== expected.nodeBin) drift.push('nodeBin');
    if (!expected.cliJs || !args.includes(expected.cliJs)) drift.push('cliJs');
    return drift;
  }
  if (parts[0] !== expected.nodeBin) drift.push('nodeBin');
  if (parts[1] !== expected.cliJs) drift.push('cliJs');
  return drift;
}

// ── target resolution ─────────────────────────────────────────────────────────

function userUnitPath(ctx) {
  return path.join(ctx.homedir, '.config', 'systemd', 'user', SYSTEMD_USER_UNIT_NAME);
}

function resolveServiceTarget(deps = {}) {
  const ctx = ctxOf(deps);
  const profile = resolveServiceProfile();
  const launch = launchOptions(ctx);
  const common = {
    platform: ctx.platform,
    nodeBin: launch.nodeBin,
    cliJs: launch.cliJs,
    logDir: launch.logDir,
    conflicts: [],
    reason: null
  };

  if (ctx.platform === 'darwin') {
    return {
      ...common,
      kind: 'launchd',
      label: profile.launchdLabel,
      target: `gui/${ctx.uid}/${profile.launchdLabel}`,
      descriptorPath: path.join(ctx.homedir, 'Library', 'LaunchAgents', profile.launchdPlistName),
      contents: buildLaunchdPlist({
        ...launch,
        label: profile.launchdLabel,
        command: profile.command,
        extraEnv: profile.extraEnv
      })
    };
  }

  if (ctx.platform === 'win32') {
    return {
      ...common,
      kind: 'schtasks',
      taskName: profile.windowsTask,
      descriptorPath: profile.windowsTask,
      contents: null
    };
  }

  // A root-owned system unit wins: two supervisors would compete for :3848.
  // It is surfaced read-only — not one systemctl call without --user is issued.
  if (ctx.fs.existsSync(SYSTEMD_UNIT_PATH)) {
    return {
      ...common,
      kind: 'systemd',
      unit: profile.systemdService,
      descriptorPath: SYSTEMD_UNIT_PATH,
      contents: null,
      conflicts: [{ kind: 'systemd', path: SYSTEMD_UNIT_PATH }]
    };
  }

  const unitPath = userUnitPath(ctx);
  const userUnit = {
    ...common,
    kind: 'systemd-user',
    unit: profile.systemdService,
    descriptorPath: unitPath,
    contents: buildSystemdService({
      ...launch,
      wantedBy: 'default.target',
      command: profile.command,
      description: profile.description,
      extraEnv: profile.extraEnv
    })
  };

  // An existing unit answers the question without a probe, and callers that
  // only need the descriptor (src/uninstall.js) opt out of probing entirely —
  // a plan must not shell out to systemctl on a host that has none.
  if (ctx.fs.existsSync(unitPath)) return userUnit;
  if (!ctx.probe) {
    return { ...common, kind: 'none', descriptorPath: unitPath, contents: null, reason: 'not-installed' };
  }

  const reachable = run(ctx, 'systemctl', ['--user', 'show-environment']);
  if (!reachable.ok) {
    // No systemd, Termux, WSL without systemd, container, SSH without
    // XDG_RUNTIME_DIR: unsupported, with the reason named.
    return { ...common, kind: 'none', descriptorPath: unitPath, contents: null, reason: 'user-manager-unreachable' };
  }
  return userUnit;
}

// ── probes ────────────────────────────────────────────────────────────────────

function probeLinger(deps = {}) {
  const ctx = ctxOf(deps);
  if (ctx.platform === 'darwin' || ctx.platform === 'win32') return 'n/a';

  if (ctx.probe) {
    const result = run(ctx, 'loginctl', ['show-user', ctx.user, '-p', 'Linger', '--value']);
    if (result.ok) {
      const value = String(result.stdout).trim().toLowerCase();
      if (value === 'yes') return 'yes';
      if (value === 'no') return 'no';
    }
  }
  try {
    if (ctx.fs.existsSync(`/var/lib/systemd/linger/${ctx.user}`)) return 'yes';
  } catch { /* inconclusive */ }
  return 'unknown'; // never "no": an unmeasured linger is not a disabled one
}

// An answer — INCLUDING a refusal (#835/#844) — proves a daemon is there. With
// no probe injected, `answering` stays null: unmeasured is not false.
async function probeDaemon(ctx) {
  const out = { answering: null, version: null, pid: null, port: ctx.port, matchesPackage: null };

  if (ctx.readDaemonState) {
    try {
      const state = ctx.readDaemonState();
      if (state && Number.isInteger(state.pid) && state.pid > 0) out.pid = state.pid;
    } catch { /* state file is a hint, never a requirement */ }
  }
  if (!ctx.getDaemonMeta) return out;

  try {
    const meta = await ctx.getDaemonMeta('127.0.0.1');
    if (meta && (meta.version || meta.answered || meta.refused)) {
      out.answering = true;
      out.version = meta.version || null;
      if (Number.isInteger(meta.pid) && meta.pid > 0) out.pid = meta.pid;
      out.matchesPackage = meta.version ? meta.version === pkg.version : null;
    } else {
      out.answering = false;
    }
  } catch {
    out.answering = false;
  }
  return out;
}

// What the supervisor itself says. `installed` is the descriptor; `loaded` and
// `active` are the manager's own answer — the gap #1227 exists to close.
function observe(ctx, target) {
  const out = { installed: false, loaded: false, active: null, pid: null, text: null, unitFileState: null };

  // Descriptor-only mode (`probe: false`): the caller wants a PLAN, not a
  // measurement. It must issue no command at all — src/uninstall.js builds a
  // plan inside the npm preuninstall hook, where shelling out to systemctl or
  // launchctl would add subprocesses to `npm rm` for no decision.
  if (!ctx.probe) {
    out.text = target.kind === 'schtasks' ? null : readIfPresent(ctx, target.descriptorPath);
    out.installed = target.kind === 'schtasks' ? false : out.text != null;
    out.loaded = null;
    out.active = null;
    return out;
  }

  if (target.kind === 'launchd') {
    out.text = readIfPresent(ctx, target.descriptorPath);
    out.installed = out.text != null;
    const printed = run(ctx, 'launchctl', ['print', target.target]);
    out.loaded = printed.ok;
    if (printed.ok) {
      out.active = /state\s*=\s*running/.test(printed.stdout);
      const pid = printed.stdout.match(/pid\s*=\s*(\d+)/);
      if (pid) out.pid = Number(pid[1]);
    } else {
      out.active = false;
    }
    return out;
  }

  if (target.kind === 'schtasks') {
    const queried = run(ctx, 'schtasks', ['/query', '/tn', target.taskName, '/xml']);
    out.installed = queried.ok;
    out.loaded = queried.ok;
    out.text = queried.ok ? queried.stdout : null;
    // Liveness comes from the daemon probe: `/fo LIST`'s `Status:` label is
    // localized (F-8), so it is never the oracle.
    return out;
  }

  if (target.kind === 'systemd-user') {
    out.text = readIfPresent(ctx, target.descriptorPath);
    const shown = run(ctx, 'systemctl', [
      '--user', 'show', target.unit,
      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'MainPID'
    ]);
    const fields = {};
    for (const line of String(shown.stdout).split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    // Boolean(): `A && B` yields A when A is falsy, so an empty UnitFileState (a
    // reachable manager with no unit — the common fresh host) used to emit
    // `"installed": ""`, and an absent property made JSON.stringify drop the key
    // altogether. `installed` is a boolean in telepty.service-status/v1, always.
    out.installed = Boolean(out.text != null || (fields.UnitFileState && fields.UnitFileState !== 'not-found'));
    out.loaded = fields.LoadState === 'loaded';
    out.active = fields.ActiveState === 'active';
    out.unitFileState = fields.UnitFileState || null;
    if (/^\d+$/.test(fields.MainPID || '') && Number(fields.MainPID) > 0) out.pid = Number(fields.MainPID);
    return out;
  }

  if (target.kind === 'systemd') {
    // Read-only by contract: the file is the only thing we may look at.
    out.text = readIfPresent(ctx, target.descriptorPath);
    out.installed = out.text != null;
    out.loaded = null;   // root-managed; not measurable without a system call
    out.active = null;
    return out;
  }

  return out; // kind 'none'
}

function describeStartup(ctx, target, observed) {
  const startup = { atLogin: 'no', bootWithoutLogin: 'unknown', linger: 'n/a', reason: target.reason, hint: null };

  if (target.kind === 'launchd') {
    startup.atLogin = observed.installed && observed.loaded ? 'yes' : 'no';
    startup.bootWithoutLogin = 'unsupported-requires-admin';
    return startup;
  }
  if (target.kind === 'schtasks') {
    startup.atLogin = observed.installed ? 'yes' : 'no';
    startup.bootWithoutLogin = 'unsupported-requires-admin';
    return startup;
  }
  if (target.kind === 'systemd') {
    startup.atLogin = 'n/a';
    startup.bootWithoutLogin = 'yes';
    return startup;
  }
  if (target.kind === 'systemd-user') {
    startup.atLogin = observed.unitFileState === 'enabled' || observed.installed ? 'yes' : 'no';
    const linger = probeLinger({ __ctx: ctx });
    startup.linger = linger;
    startup.bootWithoutLogin = linger;
    if (linger === 'no') {
      startup.hint = `boot without login also needs: loginctl enable-linger ${ctx.user}`;
    }
    return startup;
  }

  startup.atLogin = 'unsupported';
  startup.bootWithoutLogin = 'unsupported';
  return startup;
}

function sudoCommands(verb) {
  if (verb === 'uninstall') {
    return [
      `sudo systemctl disable --now ${SYSTEMD_SERVICE_NAME}`,
      `sudo rm ${SYSTEMD_UNIT_PATH}`,
      'sudo systemctl daemon-reload'
    ];
  }
  if (verb === 'install') {
    return [`sudo systemctl enable --now ${SYSTEMD_SERVICE_NAME}`];
  }
  return [`sudo systemctl ${verb} ${SYSTEMD_SERVICE_NAME}`];
}

function remediesFor(status, target, ctx) {
  const remedies = [];
  if (target.kind === 'systemd') return sudoCommands('restart');
  if (target.kind === 'none') return remedies;
  if (!status.installed) return ['telepty service install'];
  if (status.loaded === false || status.active === false || status.daemon.answering === false) {
    remedies.push('telepty service restart');
  }
  if (status.descriptor.ownership === 'drifted') remedies.push('telepty service install');
  // The user name comes from the structured ctx — the same value describeStartup
  // built the hint from. Parsing it back out of a human-readable sentence was
  // correct only as long as that sentence never changed wording.
  if (status.startup.linger === 'no') remedies.push(`loginctl enable-linger ${ctx.user}`);
  return remedies;
}

// Which observations could not be made. `null` is UNMEASURED everywhere in this
// module, so naming the gaps is what keeps "we could not look" from reading as
// "it is broken" — without inventing an observation no OS gave us.
function inconclusiveFields(status) {
  const unmeasured = [];
  if (status.loaded === null) unmeasured.push('loaded');
  if (status.active === null) unmeasured.push('active');
  if (status.daemon.answering === null) unmeasured.push('daemon.answering');
  return unmeasured;
}

// ONE rule for null (R-5): unmeasured is never success and never failure. Exit 0
// is documented as "installed + loaded + active + daemon answering", so an
// unmeasured field cannot produce it — and it degrades the same way on every
// platform, instead of reading as success on darwin and as drift on win32.
function statusExitCode(status, target) {
  if (target.kind === 'none') return SERVICE_EXIT.NEEDS_ADMIN;
  if (!status.installed) return SERVICE_EXIT.NOT_INSTALLED;
  if (status.conflicts.length > 0) return SERVICE_EXIT.DEGRADED;
  if (status.descriptor.ownership !== 'managed') return SERVICE_EXIT.DEGRADED;
  if (status.loaded !== true || status.active !== true) return SERVICE_EXIT.DEGRADED;
  if (status.daemon.answering !== true) return SERVICE_EXIT.DEGRADED;
  return SERVICE_EXIT.OK;
}

async function getServiceStatus(deps = {}) {
  const ctx = ctxOf(deps);
  const target = resolveServiceTarget({ ...deps, __ctx: ctx });
  const observed = observe(ctx, target);
  const expected = { nodeBin: target.nodeBin, cliJs: target.cliJs, text: target.contents };
  const ownership = observed.installed
    ? classifyDescriptor(observed.text, target.kind, expected)
    : 'absent';

  const daemon = await probeDaemon(ctx);
  if (observed.pid && !daemon.pid) daemon.pid = observed.pid;

  const status = {
    schema: SCHEMA,
    platform: ctx.platform,
    kind: target.kind,
    installed: observed.installed,
    loaded: observed.loaded,
    active: target.kind === 'schtasks' ? daemon.answering : observed.active,
    descriptor: {
      path: target.descriptorPath,
      ownership,
      drift: ownership === 'drifted' ? descriptorDrift(observed.text, target.kind, expected) : []
    },
    daemon,
    startup: describeStartup(ctx, target, observed),
    conflicts: target.conflicts,
    remedies: [],
    inconclusive: []
  };

  status.remedies = remediesFor(status, target, ctx);
  status.inconclusive = inconclusiveFields(status);
  if (deps.binOwnership) status.binOwnership = deps.binOwnership;
  status.exitCode = statusExitCode(status, target);
  return status;
}

// ── the single shell-string boundary (CONTROLLER.md) ──────────────────────────

const SAFE_TASK_NAME = /^[A-Za-z0-9._-]+$/;
const UNSAFE_SHELL_ARG = /["&|<>^%\r\n]/;

// install.js's builder produces a cmd.exe string whose `/tr` quoting is already
// covered by test/install-service-generation.test.js. Everything dynamic in it
// is validated HERE, before the string exists, so no descriptor path can ever
// become a second command. A violation builds nothing and refuses.
function windowsCreateCommand(target) {
  if (!SAFE_TASK_NAME.test(String(target.taskName))) return null;
  if (UNSAFE_SHELL_ARG.test(String(target.nodeBin)) || UNSAFE_SHELL_ARG.test(String(target.cliJs))) return null;
  return buildWindowsAutostartCommand({
    nodeBin: target.nodeBin,
    cliJs: target.cliJs,
    taskName: target.taskName,
    command: 'daemon'
  });
}

// ── plans ─────────────────────────────────────────────────────────────────────

function refusalFor(verb, target, ownership, opts) {
  if (target.kind === 'none') {
    return { exitCode: SERVICE_EXIT.NEEDS_ADMIN, reason: target.reason || 'unsupported' };
  }
  if (target.kind === 'systemd') {
    return { exitCode: SERVICE_EXIT.NEEDS_ADMIN, reason: 'requires-owner' };
  }
  // A descriptor at OUR label that is not ours belongs to another product, and
  // every verb here is a mutation of it: `start` would bootstrap and RUN that
  // job, `stop`/`restart` would bootout/kickstart it, `uninstall` would unload
  // it. Refused with exit 2 (nothing changed) for all of them. `--replace` is
  // install-time REPLACEMENT only — it is not permission to drive someone
  // else's job, so it unblocks `install` and nothing else.
  if (ownership === 'foreign' && !(verb === 'install' && opts.replace)) {
    return { exitCode: SERVICE_EXIT.CONSENT, reason: 'foreign-descriptor' };
  }
  if (verb === 'install' && target.kind === 'schtasks' && windowsCreateCommand(target) === null) {
    return { exitCode: SERVICE_EXIT.FAILED, reason: 'unsafe-descriptor-argument' };
  }
  return null;
}

function planShell(verb, deps, opts) {
  const ctx = ctxOf(deps);
  const target = resolveServiceTarget({ ...deps, __ctx: ctx });
  const observed = observe(ctx, target);
  const expected = { nodeBin: target.nodeBin, cliJs: target.cliJs, text: target.contents };
  const ownership = observed.installed ? classifyDescriptor(observed.text, target.kind, expected) : 'absent';

  return {
    verb,
    ctx,
    target,
    observed,
    ownership,
    base: {
      kind: target.kind,
      descriptorPath: target.descriptorPath,
      contents: target.contents,
      ownership,
      drift: ownership === 'drifted' ? descriptorDrift(observed.text, target.kind, expected) : [],
      conflicts: target.conflicts,
      startup: describeStartup(ctx, target, observed),
      writes: [],
      removals: [],
      commands: [],
      post: [],
      manualCommands: [],
      refusal: refusalFor(verb, target, ownership, opts || {})
    }
  };
}

function planInstall(deps = {}, opts = {}) {
  const { ctx, target, observed, base } = planShell('install', deps, opts);
  if (base.refusal) {
    if (target.kind === 'systemd') base.manualCommands = sudoCommands('install');
    return base;
  }

  if (target.kind === 'launchd') {
    base.writes = [{ path: target.descriptorPath, mode: 0o644 }];
    base.mkdirs = [path.dirname(target.descriptorPath), target.logDir];
    if (observed.loaded) base.commands.push(['launchctl', 'bootout', target.target]);
    base.commands.push(['launchctl', 'bootstrap', `gui/${ctx.uid}`, target.descriptorPath]);
    return base;
  }

  if (target.kind === 'systemd-user') {
    base.writes = [{ path: target.descriptorPath, mode: 0o644 }];
    base.mkdirs = [path.dirname(target.descriptorPath), target.logDir];
    base.commands.push(['systemctl', '--user', 'daemon-reload']);
    base.commands.push(['systemctl', '--user', 'enable', target.unit]);
    base.commands.push(['systemctl', '--user', 'restart', target.unit]);
    return base;
  }

  // win32: the one shell string, already validated by refusalFor.
  base.shell = windowsCreateCommand(target);
  base.commands.push(['schtasks', '/run', '/tn', target.taskName]);
  return base;
}

function planUninstall(deps = {}, opts = {}) {
  const { target, observed, ownership, base } = planShell('uninstall', deps, opts);
  if (base.refusal) {
    if (target.kind === 'systemd') base.manualCommands = sudoCommands('uninstall');
    return base;
  }

  // A foreign descriptor is never deleted — only our own commands are undone.
  const removable = observed.installed && ownership !== 'foreign';

  if (target.kind === 'launchd') {
    base.commands.push(['launchctl', 'bootout', target.target]);
    base.tolerate = [0];
    if (removable) base.removals = [target.descriptorPath];
    return base;
  }

  if (target.kind === 'systemd-user') {
    base.commands.push(['systemctl', '--user', 'disable', '--now', target.unit]);
    base.tolerate = [0];
    if (removable) base.removals = [target.descriptorPath];
    base.post = [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'reset-failed', target.unit]
    ];
    return base;
  }

  base.commands.push(['schtasks', '/end', '/tn', target.taskName]);
  base.commands.push(['schtasks', '/delete', '/tn', target.taskName, '/f']);
  base.tolerate = [0];
  return base;
}

function planVerb(verb, deps = {}, opts = {}) {
  const { ctx, target, observed, base } = planShell(verb, deps, opts);
  if (base.refusal) {
    if (target.kind === 'systemd') base.manualCommands = sudoCommands(verb);
    return base;
  }

  if (target.kind === 'launchd') {
    if (verb === 'stop') {
      // A kill would be undone by KeepAlive; bootout leaves the plist in place,
      // so the agent returns at next login and `status` can still say so.
      base.commands.push(['launchctl', 'bootout', target.target]);
    } else if (verb === 'restart') {
      base.commands.push(['launchctl', 'kickstart', '-k', target.target]);
    } else if (observed.loaded) {
      base.commands.push(['launchctl', 'kickstart', target.target]);
    } else {
      base.commands.push(['launchctl', 'bootstrap', `gui/${ctx.uid}`, target.descriptorPath]);
    }
    return base;
  }

  if (target.kind === 'systemd-user') {
    base.commands.push(['systemctl', '--user', verb, target.unit]);
    return base;
  }

  if (verb === 'restart') {
    base.commands.push(['schtasks', '/end', '/tn', target.taskName]);
    base.commands.push(['schtasks', '/run', '/tn', target.taskName]);
  } else {
    base.commands.push(['schtasks', verb === 'stop' ? '/end' : '/run', '/tn', target.taskName]);
  }
  return base;
}

function planFor(verb, deps, opts) {
  if (verb === 'install') return planInstall(deps, opts);
  if (verb === 'uninstall') return planUninstall(deps, opts);
  return planVerb(verb, deps, opts);
}

// ── execution ─────────────────────────────────────────────────────────────────

function failureReason(step, kind) {
  if (kind === 'launchd' && /launchctl bootstrap/.test(step.command)
      && /input\/output error|bootstrap failed/i.test(step.stderr)) {
    // No GUI login session (SSH-only). Reported, never worked around with a
    // detached daemon — that is the orphan #757 exists to prevent.
    return 'gui-session-required';
  }
  return 'step-failed';
}

// Sync core: writes, then commands, then post-commands. Used directly by
// src/uninstall.js, which must stay synchronous for `telepty uninstall`.
function executePlan(ctx, plan, verb) {
  const steps = [];
  let exitCode = SERVICE_EXIT.OK;
  let reason = null;

  for (const dir of plan.mkdirs || []) {
    try {
      ctx.fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      steps.push({ command: `mkdir -p ${dir}`, ok: false, stderr: stderrOf(err) });
      return { steps, exitCode: SERVICE_EXIT.FAILED, reason: 'step-failed' };
    }
  }

  for (const write of plan.writes || []) {
    try {
      ctx.fs.writeFileSync(write.path, plan.contents, { mode: write.mode });
      steps.push({ command: `write ${write.path}`, ok: true, stderr: '' });
    } catch (err) {
      steps.push({ command: `write ${write.path}`, ok: false, stderr: stderrOf(err) });
      return { steps, exitCode: SERVICE_EXIT.FAILED, reason: 'step-failed' };
    }
  }

  if (plan.shell) {
    try {
      ctx.execSync(plan.shell, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      steps.push({ command: plan.shell, ok: true, stderr: '' });
    } catch (err) {
      const stderr = stderrOf(err);
      steps.push({ command: plan.shell, ok: false, stderr });
      // A non-elevated /create denial is an unsupported scope, not a failure to
      // retry — and nothing after it may run (F-5).
      const denied = /access is denied|requires elevation|administrator/i.test(stderr);
      return {
        steps,
        exitCode: denied ? SERVICE_EXIT.NEEDS_ADMIN : SERVICE_EXIT.FAILED,
        reason: denied ? 'requires-admin' : 'step-failed'
      };
    }
  }

  // The plans encode WHICH step may fail (`tolerate: [0]` — the leading
  // unload/stop that is expected to fail when nothing is loaded). `Boolean([0])`
  // is true, so every command in a tolerated plan used to be tolerated: a denied
  // `schtasks /delete /tn telepty-daemon /f` still reported "uninstall completed"
  // and exit 0 while the logon task survived. Honor the indices.
  const tolerated = new Set(Array.isArray(plan.tolerate) ? plan.tolerate : []);
  for (const [index, argv] of (plan.commands || []).entries()) {
    const step = run(ctx, argv[0], argv.slice(1));
    steps.push({ command: step.command, ok: step.ok, stderr: step.stderr });
    if (!step.ok && !tolerated.has(index)) {
      return { steps, exitCode: SERVICE_EXIT.FAILED, reason: failureReason(step, plan.kind) };
    }
  }

  for (const removal of plan.removals || []) {
    try {
      ctx.fs.rmSync(removal, { force: true });
      steps.push({ command: `rm ${removal}`, ok: true, stderr: '' });
    } catch (err) {
      steps.push({ command: `rm ${removal}`, ok: false, stderr: stderrOf(err) });
      exitCode = SERVICE_EXIT.FAILED;
      reason = 'step-failed';
    }
  }

  for (const argv of plan.post || []) {
    const step = run(ctx, argv[0], argv.slice(1));
    steps.push({ command: step.command, ok: step.ok, stderr: step.stderr, tolerated: true });
  }

  return { steps, exitCode, reason };
}

function consentGate(verb, opts) {
  if (verb !== 'install' && verb !== 'uninstall') return null;
  if (opts.yes || opts.dryRun) return null;
  if (opts.isTTY && typeof opts.confirm === 'function') return null;
  // Decided BEFORE any plan, probe, fs or exec call: "nothing changed" has to
  // include "nothing was even looked at".
  return { exitCode: SERVICE_EXIT.CONSENT, reason: 'consent-required' };
}

// A refusal carries the measured status when one is available, so "I will not
// touch this" can still say what it found. Read-only: no mutating command and no
// system-scope call is issued to produce it. The sync door passes none (it cannot
// await, and src/uninstall.js does not read it).
function refusedResult(verb, plan, status = null) {
  return {
    ok: false,
    verb,
    exitCode: plan.refusal.exitCode,
    reason: plan.refusal.reason,
    steps: [],
    status,
    verified: null,
    plan,
    manualCommands: plan.manualCommands || []
  };
}

// Verify the supervisor actually took the job, then that a daemon answers.
// "I asked" is not "it is running" — that conflation is the #1227 status gap.
async function verifyInstalled(ctx, deps) {
  const deadline = ctx.now() + ctx.waitMs;
  let status = await getServiceStatus(deps);
  while (status.exitCode !== SERVICE_EXIT.OK && ctx.now() < deadline) {
    await ctx.sleep(300);
    status = await getServiceStatus(deps);
  }
  return status;
}

async function runServiceVerb(verb, opts = {}, deps = {}) {
  if (!VERBS.includes(verb)) {
    return { ok: false, verb, exitCode: SERVICE_EXIT.CONSENT, reason: 'usage', steps: [], status: null, plan: null, manualCommands: [] };
  }

  const gate = consentGate(verb, opts);
  if (gate) {
    return { ok: false, verb, exitCode: gate.exitCode, reason: gate.reason, steps: [], status: null, plan: null, manualCommands: [] };
  }

  const ctx = resolve(deps);
  const scoped = { ...deps, __ctx: ctx };
  const plan = planFor(verb, scoped, opts);

  if (plan.refusal) return refusedResult(verb, plan, await getServiceStatus(scoped));

  if (opts.dryRun) {
    return { ok: true, verb, exitCode: SERVICE_EXIT.OK, reason: 'dry-run', steps: [], status: null, plan, manualCommands: plan.manualCommands || [] };
  }

  if ((verb === 'install' || verb === 'uninstall') && !opts.yes) {
    const approved = await opts.confirm(plan);
    if (!approved) {
      return { ok: false, verb, exitCode: SERVICE_EXIT.CONSENT, reason: 'declined', steps: [], status: null, plan, manualCommands: [] };
    }
  }

  const executed = executePlan(ctx, plan, verb);
  let status = null;
  let exitCode = executed.exitCode;
  // The command result and the post-state measurement stay SEPARATE (R-5):
  // `exitCode` says what the commands did, `verified` says whether the service
  // was then observed to be up. `null` = no post-state oracle for this verb.
  let verified = null;
  let reason = executed.reason;

  if (exitCode === SERVICE_EXIT.OK && verb === 'install') {
    status = await verifyInstalled(ctx, scoped);
    verified = status.exitCode === SERVICE_EXIT.OK;
    // Only a MEASURED negative is a failed install. An unmeasured post-state
    // (no probe injected, nothing the OS would tell us) keeps the result the
    // commands earned — but it is never reported as a verified success.
    const measuredDown = status.daemon.answering === false
      || status.loaded === false
      || status.active === false;
    if (!verified && measuredDown) {
      exitCode = SERVICE_EXIT.FAILED;
      reason = reason || 'post-state-failed';
    } else if (!verified) {
      reason = reason || 'unverified-post-state';
    }
  } else {
    status = await getServiceStatus(scoped);
  }

  return {
    ok: exitCode === SERVICE_EXIT.OK,
    verb,
    exitCode,
    reason,
    verified,
    steps: executed.steps,
    status,
    plan,
    manualCommands: plan.manualCommands || []
  };
}

// The synchronous door, for `telepty uninstall` (src/uninstall.js stays sync so
// its #49 purge/dry-run/preuninstall guards keep their exact shape). Consent
// came from the parent command, so no prompt and no daemon wait happen here.
function runServiceVerbSync(verb, opts = {}, deps = {}) {
  if (!VERBS.includes(verb) || !opts.yes) {
    return { ok: false, verb, exitCode: SERVICE_EXIT.CONSENT, reason: 'usage', steps: [], plan: null, manualCommands: [] };
  }
  const ctx = resolve(deps);
  const plan = planFor(verb, { ...deps, __ctx: ctx }, opts);
  if (plan.refusal) return refusedResult(verb, plan);
  if (opts.dryRun) {
    return { ok: true, verb, exitCode: SERVICE_EXIT.OK, reason: 'dry-run', steps: [], plan, manualCommands: plan.manualCommands || [] };
  }
  const executed = executePlan(ctx, plan, verb);
  return {
    ok: executed.exitCode === SERVICE_EXIT.OK,
    verb,
    exitCode: executed.exitCode,
    reason: executed.reason,
    steps: executed.steps,
    plan,
    manualCommands: plan.manualCommands || []
  };
}

// One formatter for both the consent plan and `telepty uninstall`'s report, so
// a user is never shown two different accounts of the same operation.
function formatPlan(plan, { dryRun = false, startup = true } = {}) {
  const would = dryRun ? 'Would ' : '';
  const lines = [];
  if (plan.kind === 'none') {
    lines.push(`No supported OS service manager for this host (${plan.refusal ? plan.refusal.reason : 'unsupported'}).`);
    return lines;
  }
  for (const write of plan.writes || []) lines.push(`${would}write ${write.path} (mode ${write.mode.toString(8)})`);
  for (const removal of plan.removals || []) lines.push(`${would}remove ${removal}`);
  if (plan.shell) lines.push(`${would}run ${plan.shell}`);
  for (const argv of [...(plan.commands || []), ...(plan.post || [])]) lines.push(`${would}run ${argv.join(' ')}`);
  for (const manual of plan.manualCommands || []) lines.push(`manual step (needs admin): ${manual}`);
  if (startup && plan.startup) {
    lines.push(`startup: at login = ${plan.startup.atLogin}, boot without login = ${plan.startup.bootWithoutLogin}, linger = ${plan.startup.linger}`);
    if (plan.startup.hint) lines.push(`note: ${plan.startup.hint}`);
  }
  return lines;
}

module.exports = {
  SERVICE_EXIT,
  classifyDescriptor,
  formatPlan,
  getServiceStatus,
  planInstall,
  planUninstall,
  planVerb,
  probeLinger,
  resolveServiceTarget,
  runServiceVerb,
  runServiceVerbSync
};
