'use strict';

// #844 — one rule, three places that broke it:
//
//   **A destructive action requires POSITIVE evidence of the condition it destroys on.**
//   Absence of evidence is not evidence of absence.
//
// ── `terminal-backend.js` isSurfaceAlive ────────────────────────────────────────────────
// The probe decided `'gone'` from `listing.split('\n').some(line => line.includes(uuid))`. A miss
// means the surface is gone — or that the listing was truncated, that the output format changed,
// that it was localised, or that `list-workspaces` half-succeeded and exited 0 with partial
// bytes. The INV-17 gate already handles the case where cmux *fails*; it does nothing for the
// case where cmux ANSWERS and the answer is not a listing. Only a successful, PARSED listing that
// demonstrably omits the id is evidence of absence — everything else is `'unknown'`, and
// `'unknown'` never authorises a teardown.
//
// One more shape of the same mistake: the listing is requested with `--id-format uuids`, so a
// session whose `cmuxWorkspaceId` is a short-ref (`workspace:2`) or an index could never match any
// line. That is an absence manufactured by the question, not observed in the answer.
//
// ── `daemon.js` surface GC — the ordering was backwards ─────────────────────────────────
// The GC block is entered ONLY for sessions where `isOpenWebSocket(session.ownerWs)` — so it used
// "a uuid did not appear in some CLI output" to override "this session has an open owner socket
// right now". The open socket is the stronger and far more direct measurement, and it is the one
// telepty makes itself rather than parsing out of another tool's stdout. It blocks the kill.
//
// What survives is the SIGNAL: `surface_orphaned` still goes out, once, and the orchestrator —
// which owns the surface and has the reconciler — actuates. That is already the stated division
// of labour for the surface itself (the 2026-05-30 verdict in this same block); this extends it
// to the session.
//
// ── `daemon-control.js` cleanupDaemonProcesses ──────────────────────────────────────────
// Three kill-set sources; two of them confirm identity before adding a pid (the port-owner source
// via `pidMatchesTeleptyCmdline`, with the comment "so we never SIGTERM an arbitrary process that
// happens to own the port"; the process-scan source via `isLikelyTeleptyDaemon`). The state-file
// source added `state.pid` with no probe at all — so a stale state file surviving a pid rollover
// targets whatever unrelated process now holds that number. Two of three already implemented the
// rule; the third was the exception, and `stopDaemon`'s comment claimed a surgical guarantee it
// never checked.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backend = require('../terminal-backend.js');
const { decideSurfaceGcAction } = require('../src/lifecycle');
const { cleanupDaemonProcesses } = require('../daemon-control');

// ── A fake `cmux` on PATH, so the real app is never invoked (same shape as
//    test/lifecycle-surface-acceptance.test.js). `workspaces` is the raw stdout to hand back. ──

let fakeDir;
let originalPath;

const FAKE_CMUX = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
let ctrl = {};
try { ctrl = JSON.parse(fs.readFileSync(path.join(__dirname, 'control.json'), 'utf8')); } catch {}
const args = process.argv.slice(2);
if (args.includes('ping')) process.exit(0);
if (args.includes('list-workspaces')) {
  process.stdout.write(ctrl.workspaces == null ? '' : String(ctrl.workspaces));
  process.exit(0);
}
process.exit(0);
`;

function setWorkspaces(text) {
  fs.writeFileSync(path.join(fakeDir, 'control.json'), JSON.stringify({ workspaces: text }));
}

before(() => {
  fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecmux-844-'));
  fs.writeFileSync(path.join(fakeDir, 'cmux'), FAKE_CMUX, { mode: 0o755 });
  fs.chmodSync(path.join(fakeDir, 'cmux'), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = fakeDir + path.delimiter + originalPath;
});

after(() => {
  process.env.PATH = originalPath;
  try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => { setWorkspaces(''); });

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const cmuxSession = (id = UUID_A) => ({ backend: 'cmux', cmuxWorkspaceId: id });

// ── isSurfaceAlive: only a parsed listing may say 'gone' ────────────────────────────────

test('an EMPTY listing is unknown, not gone — nothing was enumerated to be absent from', () => {
  setWorkspaces('');
  assert.equal(backend.isSurfaceAlive(cmuxSession()), 'unknown');
});

test('a listing with no ids in it is unknown — a message is not an enumeration', () => {
  // What a half-succeeded, localised, or format-changed `list-workspaces` looks like: exit 0,
  // some bytes, no ids. Every one of these read as `gone` before, at full confidence.
  for (const output of [
    'error: could not connect to the cmux app\n',
    '작업 공간이 없습니다\n',
    'NAME                      TITLE\n----                      -----\n',
    '\n\n\n'
  ]) {
    setWorkspaces(output);
    assert.equal(backend.isSurfaceAlive(cmuxSession()), 'unknown',
      `unparseable listing must be indeterminate: ${JSON.stringify(output)}`);
  }
});

test('a TRUNCATED listing that happens to cut before our id is unknown, not gone', () => {
  // The dangerous middle case: the output parses, it is just incomplete. There is no way to tell
  // a truncated listing from a complete one, which is exactly why a miss cannot be trusted on its
  // own — but a truncation that removed EVERY id at least stops claiming absence.
  setWorkspaces('workspace:1 ');
  assert.equal(backend.isSurfaceAlive(cmuxSession()), 'unknown');
});

test('a short-ref workspace id is unknown — it could never match a uuid listing', () => {
  // `--id-format uuids` is what the probe asks for, so only a uuid can be compared against the
  // answer. A `workspace:2` id missed every line and was declared gone, every sweep, forever.
  setWorkspaces(`workspace:1 ${UUID_A}\nworkspace:2 ${UUID_B}\n`);
  assert.equal(backend.isSurfaceAlive(cmuxSession('workspace:2')), 'unknown');
  assert.equal(backend.isSurfaceAlive(cmuxSession('7')), 'unknown');
});

test('a real listing that omits the id is still gone — the probe still works', () => {
  setWorkspaces(`workspace:1 ${UUID_B}\nworkspace:2 cccccccc-cccc-cccc-cccc-cccccccccccc\n`);
  assert.equal(backend.isSurfaceAlive(cmuxSession()), 'gone');
});

test('a real listing containing the id is alive, case-insensitively', () => {
  setWorkspaces(`workspace:1 ${UUID_A}\nworkspace:2 ${UUID_B}\n`);
  assert.equal(backend.isSurfaceAlive(cmuxSession()), 'alive');
  setWorkspaces(`workspace:1 ${UUID_A.toUpperCase()}\n`);
  assert.equal(backend.isSurfaceAlive(cmuxSession()), 'alive');
});

// ── decideSurfaceGcAction: an open owner socket blocks the kill ─────────────────────────

test('an open owner socket downgrades a reclaim to a signal — it never authorises the kill', () => {
  assert.equal(decideSurfaceGcAction('reclaim', { ownerConnected: true }), 'signal');
});

test('the signal is emitted once, not every sweep tick', () => {
  assert.equal(decideSurfaceGcAction('reclaim', { ownerConnected: true, alreadySignalled: true }), 'skip');
});

test('with no owner socket a reclaim is still a reclaim — the gate is the socket, not the verdict', () => {
  // Nothing else calls this today (the GC block is entered only for connected sessions), but the
  // rule has to be stated in terms of the evidence, not in terms of an unreachable branch.
  assert.equal(decideSurfaceGcAction('reclaim', { ownerConnected: false }), 'reclaim');
});

test('every non-reclaim verdict passes through untouched', () => {
  for (const verdict of ['mark', 'recover', 'skip']) {
    assert.equal(decideSurfaceGcAction(verdict, { ownerConnected: true }), verdict);
    assert.equal(decideSurfaceGcAction(verdict, { ownerConnected: false }), verdict);
  }
});

// ── cleanupDaemonProcesses: the state-file pid is a claim, not a measurement ────────────

function killerOk(captured) {
  return (pid) => { captured.push(pid); return true; };
}

test('an unconfirmed state-file pid is NOT killed — a stale file after a pid rollover is a stranger', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => ({ pid: 4242, host: '127.0.0.1', port: 3848, version: '0.3.5' }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: () => false,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(killed, [],
    'the state-file source signalled a pid it never confirmed was a telepty daemon — the same '
    + 'check the port-owner source has had all along');
  assert.equal(result.stopped.length, 0);
  assert.equal(result.failed.length, 0);
});

test('a CONFIRMED state-file pid is still killed, still attributed to state-file', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    port: 3848, // #902: name the addressed daemon — this fixture is about confirmation, not scoping
    readDaemonState: () => ({ pid: 4242, host: '127.0.0.1', port: 3848, version: '0.3.5' }),
    listDaemonProcesses: () => [],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: (pid) => pid === 4242,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(killed, [4242]);
  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].source, 'state-file');
});

test('the process-scan source is unaffected — it confirms with isLikelyTeleptyDaemon upstream', () => {
  const killed = [];
  const result = cleanupDaemonProcesses({
    readDaemonState: () => ({ pid: 4242 }),
    listDaemonProcesses: () => [{ pid: 5151, commandLine: 'node cli.js daemon' }],
    findPortOwnerPid: () => null,
    pidMatchesTeleptyCmdline: () => false,
    stopDaemonProcess: killerOk(killed)
  });

  assert.deepEqual(killed, [5151], 'only the source that carries its own evidence survives');
  assert.equal(result.stopped[0].source, 'process-scan');
});
