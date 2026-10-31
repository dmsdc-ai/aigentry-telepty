'use strict';

// #1207 — real_daemon gate: daemon.js with AIGENTRY_TELEPTY_DAEMON_MAIN=1 under a private HOME and
// an OS-assigned port (test-support/daemon-harness). Covers M1 (migration happy path), D1 (inject,
// poll, restart with the restart fact overlaid), D2 (daemon listens while recovering; status route),
// W2 (SIGTERM drain: MANIFEST clean_close, lock released, state cleared), M4 (export-v3 loads with
// the frozen 0.9.1 loader) and the daemon half of E1 (a foreign lock ⇒ ledger lock_present with the
// control plane up; operator unlock refuses while the daemon is alive).
//
// Prerequisites: a real daemon process (node-pty for spawned sessions), loopback TCP, POSIX signals
// (W2/E1 skipped on win32), writable temp HOME. M3 (128/256 MiB imports) is opt-in via
// TELEPTY_LEDGER_1207_M3=1 and REPORTS peak heap; it asserts no bound. Author-written.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startTestDaemon, createSessionId } = require('../../test-support/daemon-harness');
const { writeLegacyLedger } = require('../fixtures/ledger-1207/legacy-fixture');

const projectRoot = path.resolve(__dirname, '..', '..');
const POSIX = process.platform !== 'win32';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ledgerDir = (home) => path.join(home, '.config', 'aigentry-telepty', 'tracked-injections.json');
const lockPath = (home) => path.join(home, '.config', 'aigentry-telepty', 'tracked-injections.lock');
const manifestOf = (home) => JSON.parse(fs.readFileSync(path.join(ledgerDir(home), 'MANIFEST.json'), 'utf8'));

async function waitForLedger(d, states = ['available'], timeoutMs = 20000) {
  return d.waitFor(async () => {
    const r = await d.request('/api/ledger/status');
    return r.status === 200 && r.body && r.body.client && states.includes(r.body.client.store) ? r.body : null;
  }, { timeoutMs, description: `ledger ${states.join('|')}` });
}

test('M1 / D2: a 0.9.1 legacy file is migrated by the daemon at start while /api/health answers; aside sha == legacy sha == MANIFEST.legacy; historical ids poll deepEqual (+ the restart fact at the NEXT open only)', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-m1-'));
  const legacyPath = ledgerDir(homeDir);
  const legacy = writeLegacyLedger(legacyPath, { targetBytes: 8 * 1048576, obsPerRecord: 12 });
  let d = null;
  try {
    d = await startTestDaemon({ homeDir });
    // the control plane is up during the migration (readiness waited on /api/health, not the ledger)
    const meta = await d.request('/api/meta');
    assert.equal(meta.status, 200);
    const status = await waitForLedger(d);
    assert.equal(status.healthy, true);
    assert.equal(status.owner.counts.cold, legacy.count);
    assert.equal(fs.statSync(legacyPath).isDirectory(), true);
    const manifest = manifestOf(homeDir);
    assert.equal(manifest.published, true); assert.equal(manifest.legacy.sha256, legacy.sha256);
    assert.equal(sha256(fs.readFileSync(path.join(legacyPath, 'legacy', 'tracked-injections.v3.json'))), legacy.sha256);
    const aside = fs.readdirSync(path.dirname(legacyPath)).find((n) => n.startsWith('tracked-injections.json.pre-0.10.'));
    assert.ok(aside); assert.equal(sha256(fs.readFileSync(path.join(path.dirname(legacyPath), aside))), legacy.sha256);
    // historical polls: the record as it was (the first open after a migration appends NO restart fact)
    const id = legacy.ids[3];
    const poll = await d.request(`/api/inject-observations/${encodeURIComponent(id)}`);
    assert.equal(poll.status, 200); assert.equal(poll.body.tracking_state, 'tracked');
    assert.deepEqual(poll.body.observations, legacy.ledger.injections[id].observations);
    assert.equal(poll.body.observation_seq, 12);
    await d.kill(); d = null;
    // next open: the restart fact overlays every record lazily
    d = await startTestDaemon({ homeDir });
    await waitForLedger(d);
    const again = await d.request(`/api/inject-observations/${encodeURIComponent(id)}`);
    assert.equal(again.body.observation_seq, 13);
    assert.equal(again.body.observations[12].kind, 'daemon_restart_observed');
    assert.equal(again.body.observations[12].seq, 13);
  } finally {
    if (d) await d.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('D1 / W2: real inject → 200 after the ACK; poll shows seq 1; SIGTERM drains (MANIFEST clean_close:true, lock released, daemon-state cleared); restart shows the restart fact; never a 404', { skip: !POSIX && 'POSIX signal semantics' }, async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-d1-'));
  let d = null;
  try {
    d = await startTestDaemon({ homeDir });
    await waitForLedger(d);
    assert.equal(fs.existsSync(lockPath(homeDir)), true, 'the daemon holds the lock while running');
    const source = 'orchestrator';
    await d.spawnSession(source);
    const sid = createSessionId('target');
    await d.spawnSession(sid);
    const res = await d.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body: { prompt: 'echo LEDGER_1207', from: source } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const injectId = res.body.inject_id;
    const poll = await d.request(`/api/inject-observations/${encodeURIComponent(injectId)}`);
    assert.equal(poll.status, 200); assert.equal(poll.body.tracking_state, 'tracked'); assert.ok(poll.body.observation_seq >= 1);
    assert.equal(poll.body.observations[0].kind, 'tracking_started');
    // the begin is on disk in a commit-framed group
    const segs = fs.readdirSync(path.join(ledgerDir(homeDir), 'segments'));
    assert.ok(segs.length >= 1);
    const status = await d.request('/api/ledger/status');
    assert.equal(status.body.client.lock.held, true);
    // W2: SIGTERM → shutdown drains the owner
    await d.kill();
    assert.equal(manifestOf(homeDir).clean_close, true, 'close wrote MANIFEST clean_close:true');
    assert.equal(fs.existsSync(lockPath(homeDir)), false, 'the lock is released only by the holder with matching contents');
    assert.equal(fs.existsSync(path.join(homeDir, '.telepty', 'daemon-state.json')), false, 'daemon-state cleared (#916)');
    d = null;
    d = await startTestDaemon({ homeDir });
    await waitForLedger(d);
    const after = await d.request(`/api/inject-observations/${encodeURIComponent(injectId)}`);
    assert.equal(after.status, 200, 'never a 404');
    assert.equal(after.body.inject_id, injectId);
    const kinds = after.body.observations.map((o) => o.kind);
    assert.ok(kinds.includes('tracking_started') && kinds.includes('daemon_restart_observed'), kinds.join(','));
    assert.equal(after.body.completion_fact, null); assert.equal(after.body.terminal, false);
  } finally {
    if (d) await d.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('M4: ledger export-v3 (route + CLI) writes a schema-3 file under the daemon HOME that loads with the frozen 0.9.1 loader; an arbitrary path is refused', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-m4-'));
  writeLegacyLedger(ledgerDir(homeDir), { count: 25, obsPerRecord: 5 });
  let d = null;
  try {
    d = await startTestDaemon({ homeDir });
    await waitForLedger(d);
    const refused = await d.request('/api/ledger/export', { method: 'POST', body: { out: '/tmp/anywhere.json' } });
    assert.equal(refused.status, 400); assert.equal(refused.body.code, 'EXPORT_PATH_REFUSED');
    const ok = await d.request('/api/ledger/export', { method: 'POST', body: { out: 'downgrade.json' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.records, 25);
    const out = path.join(homeDir, '.config', 'aigentry-telepty', 'exports', 'downgrade.json');
    const installed = require('../fixtures/0.9.1/src/session-store/persistence');
    const loaded = installed.loadTrackedInjections(out);
    assert.equal(loaded.ok, true); assert.equal(Object.keys(loaded.ledger.injections).length, 25);
    // the CLI surface (host token resolved from the daemon's private config)
    const cfg = JSON.parse(fs.readFileSync(path.join(homeDir, '.telepty', 'config.json'), 'utf8'));
    const cli = spawnSync(process.execPath, [path.join(projectRoot, 'cli.js'), 'ledger', 'status'], { cwd: projectRoot, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, TELEPTY_AUTH_TOKEN: cfg.authToken, TELEPTY_PORT: String(d.port), PORT: String(d.port), TELEPTY_NO_TAILNET_AUTO: '1' } });
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    assert.equal(parsed.healthy, true); assert.equal(parsed.client.store, 'available');
    // unlock refuses while this daemon is alive (daemon-state names a live pid / health answers)
    const unlock = spawnSync(process.execPath, [path.join(projectRoot, 'cli.js'), 'ledger', 'unlock', '--confirm'], { cwd: projectRoot, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, TELEPTY_PORT: String(d.port), PORT: String(d.port), TELEPTY_NO_TAILNET_AUTO: '1' } });
    assert.notEqual(unlock.status, 0);
    assert.ok(/daemon_state_pid_alive|health_answers|lock_pid_alive/.test(unlock.stdout), unlock.stdout + unlock.stderr);
    assert.equal(fs.existsSync(lockPath(homeDir)), true, 'the lock survived the refused unlock');
  } finally {
    if (d) await d.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('E1 (daemon half): a foreign lock makes the ledger unavailable: lock_present — control plane up, inject 503, poll unavailable, lock byte-identical, no lock.stale.*; after the operator unlock the next daemon acquires', { skip: !POSIX && 'POSIX only' }, async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-ledger-e1-'));
  const parent = path.join(homeDir, '.config', 'aigentry-telepty'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const foreign = Buffer.from(JSON.stringify({ pid: 999999, token: 'dead-daemon', started_at: '2026-01-01T00:00:00.000Z' }) + '\n');
  fs.writeFileSync(lockPath(homeDir), foreign, { mode: 0o600 });
  let d = null;
  try {
    d = await startTestDaemon({ homeDir });
    const st = await d.request('/api/ledger/status');
    assert.equal(st.status, 200); assert.equal(st.body.client.store, 'lock_present'); assert.equal(st.body.unavailable_reason, 'lock_present');
    assert.ok(fs.readFileSync(lockPath(homeDir)).equals(foreign), 'lock untouched');
    assert.deepEqual(fs.readdirSync(parent).filter((n) => n.includes('stale')), []);
    const sid = createSessionId('e1'); await d.spawnSession('orchestrator'); await d.spawnSession(sid);
    const res = await d.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, { method: 'POST', body: { prompt: 'must not deliver', from: 'orchestrator' } });
    assert.equal(res.status, 503); assert.equal(res.body.code, 'TRACKING_CAPACITY'); assert.equal(res.body.reason, 'lock_present');
    const screen = await d.request(`/api/sessions/${encodeURIComponent(sid)}/screen`);
    assert.equal(JSON.stringify(screen.body).includes('must not deliver'), false, 'no task bytes reached the target');
    const poll = await d.request(`/api/inject-observations/${encodeURIComponent(res.body.inject_id)}`);
    assert.equal(poll.body.tracking_state, 'unavailable'); assert.equal(poll.body.reason, 'lock_present');
    await d.stop(); d = null;
    assert.ok(fs.readFileSync(lockPath(homeDir)).equals(foreign), 'a daemon that never held the lock never releases it');
    // operator unlock with no daemon alive, then exactly one daemon acquires
    const { operatorUnlock } = require('../../src/session-store/ledger-lock');
    const unlocked = await operatorUnlock(lockPath(homeDir), { confirm: true, daemonState: null, isProcessRunning: () => false, probeHealth: async () => false });
    assert.equal(unlocked.unlocked, true);
    d = await startTestDaemon({ homeDir });
    const ok = await waitForLedger(d);
    assert.equal(ok.client.lock.held, true);
  } finally {
    if (d) await d.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('M3 (opt-in): large legacy imports report peak worker heap or stop with migration_failed_resource; legacy untouched either way', { skip: process.env.TELEPTY_LEDGER_1207_M3 !== '1' && 'set TELEPTY_LEDGER_1207_M3=1 (128 MiB / 256 MiB fixtures; minutes)' }, async () => {
  for (const mib of [128, 256]) {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `telepty-ledger-m3-${mib}-`));
    const legacy = writeLegacyLedger(ledgerDir(homeDir), { targetBytes: mib * 1048576, obsPerRecord: 12 });
    let d = null;
    try {
      d = await startTestDaemon({ homeDir });
      const outcome = await d.waitFor(async () => {
        const r = await d.request('/api/ledger/status');
        const s = r.body && r.body.client && r.body.client.store;
        return s && s !== 'recovering' ? r.body : null;
      }, { timeoutMs: 600000, description: `M3 ${mib} MiB` });
      console.log(`[ledger-1207] M3 ${mib} MiB: store=${outcome.client.store} reason=${outcome.client.reason} records=${legacy.count} (reported, not asserted)`);
      if (outcome.client.store !== 'available') {
        assert.equal(fs.statSync(ledgerDir(homeDir)).isFile(), true, 'legacy untouched on a failed import');
        assert.equal(sha256(fs.readFileSync(ledgerDir(homeDir))), legacy.sha256);
      } else {
        assert.equal(outcome.owner.counts.cold, legacy.count);
      }
    } finally {
      if (d) await d.stop();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }
});
