'use strict';

// Task 1215 W3 (R1/R2) — every ORDINARY stop/restart/uninstall caller reaches the production stop selector
// (cli.js selectNormalStop) and the code main() actually dispatches to. Only IMPLEMENTATION seams are injected
// (graceful stop, signal stop, start, service runner, runUninstall); none of them changes the selected mode, so a
// caller that bypassed the graceful gate on win32, used a forced stop on uncertainty or started a replacement
// before a confirmed stop fails here. Nothing is killed, spawned, scheduled or contacted: every effect is a recorder.
// The final cases pin, from source, that main(), the interactive menu and the npm hook call these exact functions.
// Native Windows behaviour (an installed task, a real exit and lock release) is NOT measured here.
// "PRECONDITION:" assertions validate setup (failure = INVALID, not product RED).

process.env.TELEPTY_DISABLE_UPDATE_NOTIFIER = '1';
process.env.NO_UPDATE_NOTIFIER = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cli = require('../cli');
const { DEFAULT_PORT } = require('../daemon-control');
const { decideStopOutcome } = require('../src/daemon-shutdown');
const { SERVICE_EXIT } = require('../src/service');

const PID = 4242;
const CONFIRMED = { stopped: decideStopOutcome({ status: 'stopped', pid: PID, lockRetained: false }), none: decideStopOutcome({ status: 'no_answer' }, []) };
const UNCONFIRMED = {
  timeout: decideStopOutcome({ status: 'timeout', pid: PID, exited: false }),
  refused: decideStopOutcome({ status: 'refused', pid: PID, code: 'STOP_AUTH_REQUIRED', httpStatus: 401 }),
  unknown: decideStopOutcome({ status: 'unknown', pid: PID, reason: 'stop_request_failed' }),
  lockRetained: decideStopOutcome({ status: 'stopped', pid: PID, lockRetained: true }),
  silentButPresent: decideStopOutcome({ status: 'no_answer' }, [{ pid: PID }]),
};

function recorder() {
  const events = [];
  const fn = (name, ret) => (...args) => { events.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };
  return { events, fn, names: () => events.map((e) => e[0]) };
}
// Console silenced and process.exitCode restored: the dispatchers set it exactly as main() does.
async function quiet(fn) {
  const log = console.log; const error = console.error; const exitCode = process.exitCode;
  console.log = () => {}; console.error = () => {};
  try { const value = await fn(); return { value, exitCode: process.exitCode }; } finally { console.log = log; console.error = error; process.exitCode = exitCode; }
}
const RUN = ['schtasks', '/run', '/tn', 'telepty-daemon'];
function serviceSeam(r) {
  return r.fn('service', async (verb, opts) => (opts && opts.dryRun)
    ? { ok: true, verb, exitCode: SERVICE_EXIT.OK, reason: 'dry-run', steps: [], status: null, plan: { kind: 'schtasks', commands: verb === 'restart' ? [['schtasks', '/end', '/tn', 'telepty-daemon'], RUN] : [['schtasks', '/end', '/tn', 'telepty-daemon']] }, manualCommands: [] }
    : { ok: true, verb, exitCode: SERVICE_EXIT.OK, reason: null, verified: null, steps: [], status: null, plan: { kind: 'schtasks', commands: [RUN] }, manualCommands: [] });
}
const calls = (r) => r.events.map(([name, a, b]) => (name === 'service' ? `service:${a}:${b && b.dryRun ? 'dry' : 'live'}` : (name === 'graceful' ? `graceful:${a}` : name)));

test('R2 selector: the platform decides graceful vs signal; only a legacy whole-step seam overrides it', () => {
  const rows = [];
  for (const platform of ['win32', 'linux', 'darwin']) for (const legacyStopSeam of [false, true]) rows.push([platform, legacyStopSeam, cli.selectNormalStop({ platform, legacyStopSeam })]);
  assert.deepEqual(rows, [['win32', false, 'graceful'], ['win32', true, 'seam'], ['linux', false, 'signal'], ['linux', true, 'seam'], ['darwin', false, 'signal'], ['darwin', true, 'seam']]);
});

function localDeps(r, platform, outcome) {
  return { platform, port: 51841, detectSupervisor: () => ({ present: false }), logDaemonRestartEvent: () => {},
    gracefulStop: r.fn('graceful', async () => outcome), signalStop: r.fn('signal-stop', { stopped: [], failed: [] }), startDetachedDaemon: r.fn('start', { pid: 777 }) };
}

test('R2 main `daemon stop|restart` (local): win32 = graceful only; a replacement starts only after a confirmed stop; never a signal stop', async () => {
  for (const [k, outcome] of Object.entries(CONFIRMED)) {
    const stop = recorder(); const s = await quiet(() => cli.runDaemonStopRestart('stop', localDeps(stop, 'win32', outcome)));
    const restart = recorder(); const re = await quiet(() => cli.runDaemonStopRestart('restart', localDeps(restart, 'win32', outcome)));
    assert.deepEqual({ k, stop: [calls(stop), s.exitCode], restart: [calls(restart), re.exitCode] },
      { k, stop: [['graceful:51841'], undefined], restart: [['graceful:51841', 'start'], undefined] });
  }
  for (const [k, outcome] of Object.entries(UNCONFIRMED)) {
    const stop = recorder(); const s = await quiet(() => cli.runDaemonStopRestart('stop', localDeps(stop, 'win32', outcome)));
    const restart = recorder(); const re = await quiet(() => cli.runDaemonStopRestart('restart', localDeps(restart, 'win32', outcome)));
    assert.deepEqual({ k, stop: [calls(stop), s.exitCode], restart: [calls(restart), re.exitCode] },
      { k, stop: [['graceful:51841'], 1], restart: [['graceful:51841'], 1] });
  }
});

test('R2 main `daemon stop|restart` (local): POSIX keeps the signal stop and never asks the graceful gate', async () => {
  for (const platform of ['linux', 'darwin']) {
    const stop = recorder(); await quiet(() => cli.runDaemonStopRestart('stop', localDeps(stop, platform, CONFIRMED.stopped)));
    const restart = recorder(); await quiet(() => cli.runDaemonStopRestart('restart', localDeps(restart, platform, CONFIRMED.stopped)));
    assert.deepEqual({ platform, stop: calls(stop), restart: calls(restart) }, { platform, stop: ['signal-stop'], restart: ['signal-stop', 'start'] });
  }
});

test('R2 main `daemon stop|restart` (schtasks-supervised route): graceful first, `schtasks /run` only after a confirmed stop, no local stop or start', async () => {
  const deps = (r, outcome) => ({ platform: 'win32', port: DEFAULT_PORT, detectSupervisor: () => ({ present: true, kind: 'schtasks', detail: 'telepty-daemon' }),
    runServiceVerb: serviceSeam(r), serviceDeps: {}, gracefulStop: r.fn('graceful', async () => outcome),
    signalStop: r.fn('signal-stop', { stopped: [], failed: [] }), startDetachedDaemon: r.fn('start', { pid: 777 }), logDaemonRestartEvent: () => {} });
  const stop = recorder(); await quiet(() => cli.runDaemonStopRestart('stop', deps(stop, CONFIRMED.stopped)));
  const restart = recorder(); await quiet(() => cli.runDaemonStopRestart('restart', deps(restart, CONFIRMED.stopped)));
  assert.deepEqual({ stop: calls(stop), restart: calls(restart) },
    { stop: ['service:stop:dry', `graceful:${DEFAULT_PORT}`], restart: ['service:restart:dry', `graceful:${DEFAULT_PORT}`, 'service:start:live'] });
  for (const [k, outcome] of Object.entries(UNCONFIRMED)) {
    const r = recorder(); const re = await quiet(() => cli.runDaemonStopRestart('restart', deps(r, outcome)));
    assert.deepEqual({ k, calls: calls(r), exitCode: re.exitCode }, { k, calls: ['service:restart:dry', `graceful:${DEFAULT_PORT}`], exitCode: SERVICE_EXIT.FAILED });
  }
});

test('R2 main `service <verb>`: win32 stop|restart graceful-first; POSIX unchanged; uninstall goes to the service verb whose own gate uses serviceDeps().gracefulStop', async () => {
  const flags = { yes: true, dryRun: false, isTTY: false };
  const win = recorder(); const w = await cli.runServiceCommandVerb('stop', flags, { platform: 'win32', serviceDeps: {}, runServiceVerb: serviceSeam(win), gracefulStop: win.fn('graceful', async () => UNCONFIRMED.timeout) });
  const posix = recorder(); await cli.runServiceCommandVerb('stop', flags, { platform: 'linux', serviceDeps: {}, runServiceVerb: serviceSeam(posix), gracefulStop: posix.fn('graceful', async () => CONFIRMED.stopped) });
  const sdeps = { marker: 'service-deps' };
  const un = recorder(); await cli.runServiceCommandVerb('uninstall', flags, { platform: 'win32', serviceDeps: sdeps, runServiceVerb: serviceSeam(un), gracefulStop: un.fn('graceful', async () => CONFIRMED.stopped) });
  assert.deepEqual({ win: [calls(win), w.exitCode], posix: calls(posix), uninstall: [calls(un), un.events[0][3] === sdeps] },
    { win: [['service:stop:dry', `graceful:${DEFAULT_PORT}`], SERVICE_EXIT.FAILED], posix: ['service:stop:live'], uninstall: [['service:uninstall:live'], true] });
  assert.equal(typeof cli.serviceDeps().gracefulStop, 'function', 'production service deps carry the graceful gate the scheduled-task uninstall requires');
});

test('R1 main `uninstall`: win32 awaits the graceful gate BEFORE the synchronous uninstall and passes its outcome; dry run and POSIX never ask it', async () => {
  const run = (r, platform, extra = {}) => cli.runUninstallCommand({ purge: false, dryRun: extra.dryRun === true }, { platform,
    gracefulStop: r.fn('graceful', extra.throws ? async () => { throw new Error('gate failed'); } : async () => CONFIRMED.stopped),
    runUninstall: r.fn('uninstall', (opts) => ({ opts })) });
  const win = recorder(); const w = await run(win, 'win32');
  const thrown = recorder(); const t = await run(thrown, 'win32', { throws: true });
  const dry = recorder(); await run(dry, 'win32', { dryRun: true });
  const posix = recorder(); const p = await run(posix, 'linux');
  assert.deepEqual({ win: [calls(win), w.opts.windowsStop === CONFIRMED.stopped], thrown: [calls(thrown), Object.hasOwn(t.opts, 'windowsStop')],
    dry: calls(dry), posix: [calls(posix), Object.hasOwn(p.opts, 'windowsStop')] },
  { win: [[`graceful:${DEFAULT_PORT}`, 'uninstall'], true], thrown: [[`graceful:${DEFAULT_PORT}`, 'uninstall'], false], dry: ['uninstall'], posix: [['uninstall'], false] });
});

test('R2 interactive menu `daemon`: win32 starts only after a confirmed graceful stop; POSIX keeps sweep + start', async () => {
  const deps = (r, platform, outcome) => ({ platform, logDaemonRestartEvent: () => {}, gracefulStop: r.fn('graceful', async () => outcome),
    cleanupDaemonProcesses: r.fn('sweep', { stopped: [], failed: [] }), startDetachedDaemon: r.fn('start', { pid: 777 }) });
  const ok = recorder(); const o = await quiet(() => cli.interactiveDaemonStart(deps(ok, 'win32', CONFIRMED.stopped)));
  const bad = recorder(); const b = await quiet(() => cli.interactiveDaemonStart(deps(bad, 'win32', UNCONFIRMED.unknown)));
  const posix = recorder(); const p = await quiet(() => cli.interactiveDaemonStart(deps(posix, 'linux', CONFIRMED.stopped)));
  assert.deepEqual({ ok: [o.value, ok.names()], bad: [b.value, bad.names()], posix: [p.value, posix.names()] },
    { ok: [true, ['graceful', 'start']], bad: [false, ['graceful']], posix: [true, ['sweep', 'start']] });
});

test('R1/R2 source: main(), the interactive menu and the npm hook call exactly these dispatchers (a re-inlined bypass fails here)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
  const daemonBranch = src.slice(src.indexOf("  if (cmd === 'daemon') {"), src.indexOf("  if (cmd === 'list') {"));
  assert.ok(daemonBranch.length > 0, 'PRECONDITION: located main()\'s daemon branch');
  assert.deepEqual({
    daemon: daemonBranch.includes("if (sub === 'stop' || sub === 'restart') return runDaemonStopRestart(sub);"),
    daemonNoDirectStop: !/gracefulWindowsStop\(|stopDaemon\(|process\.platform === 'win32'/.test(daemonBranch),
    service: src.includes('    const result = await runServiceCommandVerb(sub, {'),
    uninstall: src.includes('    const result = await runUninstallCommand({ purge, dryRun });'),
    menu: src.includes('      if (!(await interactiveDaemonStart())) continue;'),
  }, { daemon: true, daemonNoDirectStop: true, service: true, uninstall: true, menu: true });
  const hook = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'preuninstall.js'), 'utf8');
  assert.deepEqual({ awaitsGate: /await require\('\.\.\/cli'\)\.gracefulWindowsStop\(/.test(hook), win32Only: hook.includes("if (process.platform === 'win32')"),
    passesOutcome: hook.includes('runPreuninstall(windowsStop ? { windowsStop } : {})'), exitsZero: hook.includes('process.exit(0);') },
  { awaitsGate: true, win32Only: true, passesOutcome: true, exitsZero: true });
});
