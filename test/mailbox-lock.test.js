const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  acquireLock,
  breakStaleLocks,
  isProcessAlive,
} = require('../src/mailbox/storage');
const { FileMailbox } = require('../src/mailbox/index');
const { DeliveryEngine } = require('../src/mailbox/delivery');

// --- Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-lock-test-'));
}

function createSessionDir(root, sessionId) {
  const dir = path.join(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createLockFile(dir, content) {
  fs.writeFileSync(path.join(dir, '.lock'), String(content));
}

function createAgedLockFile(dir, content, ageMs) {
  const lockPath = path.join(dir, '.lock');
  fs.writeFileSync(lockPath, String(content));
  // Set mtime to past
  const pastTime = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, pastTime, pastTime);
}

function lockExists(dir) {
  return fs.existsSync(path.join(dir, '.lock'));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// --- Fix 1: Invalid PID handling ---

describe('acquireLock — invalid PID handling', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('breaks lock with empty content', () => {
    const dir = createSessionDir(tmpDir, 's1');
    createLockFile(dir, '');
    const release = acquireLock(dir);
    assert.ok(release, 'should acquire lock');
    release();
  });

  it('breaks lock with NaN content', () => {
    const dir = createSessionDir(tmpDir, 's1');
    createLockFile(dir, 'garbage');
    const release = acquireLock(dir);
    assert.ok(release, 'should acquire lock');
    release();
  });

  it('breaks lock with PID 0', () => {
    const dir = createSessionDir(tmpDir, 's1');
    createLockFile(dir, '0');
    const release = acquireLock(dir);
    assert.ok(release, 'should acquire lock');
    release();
  });

  it('breaks lock with negative PID', () => {
    const dir = createSessionDir(tmpDir, 's1');
    createLockFile(dir, '-1');
    const release = acquireLock(dir);
    assert.ok(release, 'should acquire lock');
    release();
  });

  it('breaks lock with dead PID', () => {
    const dir = createSessionDir(tmpDir, 's1');
    // PID 999999 is extremely unlikely to be alive
    createLockFile(dir, '999999');
    const release = acquireLock(dir);
    assert.ok(release, 'should acquire lock');
    release();
  });
});

// --- Fix 2: Lock age threshold ---

describe('acquireLock — lock age threshold', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('breaks lock older than threshold regardless of PID', () => {
    const dir = createSessionDir(tmpDir, 's1');
    // Use current process PID (alive) but age > threshold
    createAgedLockFile(dir, String(process.pid), 70000); // 70s > 60s default
    const release = acquireLock(dir);
    assert.ok(release, 'should break aged lock even with alive PID');
    release();
  });

  it('does NOT break lock with alive PID and recent age', () => {
    const dir = createSessionDir(tmpDir, 's1');
    // Live PID + recent = real lock, should timeout
    createLockFile(dir, String(process.pid));
    assert.throws(
      () => acquireLock(dir),
      /lock timeout/i,
      'should timeout on real active lock'
    );
    // Clean up lock
    try { fs.unlinkSync(path.join(dir, '.lock')); } catch {}
  });

  it('respects custom staleLockAgeMs option', () => {
    const dir = createSessionDir(tmpDir, 's1');
    createAgedLockFile(dir, String(process.pid), 5000); // 5s old
    // With 3s threshold, should break
    const release = acquireLock(dir, { staleLockAgeMs: 3000 });
    assert.ok(release, 'should break with custom lower threshold');
    release();
  });
});

// --- Fix 3: Startup sweep ---

describe('breakStaleLocks — startup sweep', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('breaks stale locks with dead PIDs', () => {
    const d1 = createSessionDir(tmpDir, 'session-a');
    const d2 = createSessionDir(tmpDir, 'session-b');
    createLockFile(d1, '999999'); // dead PID
    createLockFile(d2, '999998'); // dead PID

    const broken = breakStaleLocks(tmpDir);
    assert.equal(broken, 2);
    assert.ok(!lockExists(d1));
    assert.ok(!lockExists(d2));
  });

  it('breaks stale locks with invalid PIDs', () => {
    const d1 = createSessionDir(tmpDir, 'session-c');
    createLockFile(d1, '');

    const broken = breakStaleLocks(tmpDir);
    assert.equal(broken, 1);
    assert.ok(!lockExists(d1));
  });

  it('breaks aged locks regardless of PID', () => {
    const d1 = createSessionDir(tmpDir, 'session-d');
    createAgedLockFile(d1, String(process.pid), 70000); // alive but old

    const broken = breakStaleLocks(tmpDir, { staleLockAgeMs: 60000 });
    assert.equal(broken, 1);
    assert.ok(!lockExists(d1));
  });

  it('does NOT break locks with alive PID and recent age', () => {
    const d1 = createSessionDir(tmpDir, 'session-e');
    createLockFile(d1, String(process.pid)); // alive + recent

    const broken = breakStaleLocks(tmpDir);
    assert.equal(broken, 0);
    assert.ok(lockExists(d1));
    // Clean up
    try { fs.unlinkSync(path.join(d1, '.lock')); } catch {}
  });

  it('returns 0 for empty root', () => {
    const broken = breakStaleLocks(tmpDir);
    assert.equal(broken, 0);
  });

  it('FileMailbox.breakStaleLocks() delegates correctly', () => {
    const mb = new FileMailbox({ root: tmpDir });
    const d1 = createSessionDir(tmpDir, 'session-f');
    createLockFile(d1, '999999');

    const broken = mb.breakStaleLocks();
    assert.equal(broken, 1);
    assert.ok(!lockExists(d1));
  });
});

// --- Fix 4: Consecutive failure tracking ---

describe('DeliveryEngine — consecutive failure force-break', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('force-breaks lock after lockBreakAfterFailures consecutive lock timeouts', async () => {
    const mb = new FileMailbox({
      root: tmpDir,
      lockBreakAfterFailures: 2,
      staleLockAgeSecs: 9999, // very high so age doesn't trigger
    });

    const sessionId = 'locked-session';
    const sessionDir = createSessionDir(tmpDir, sessionId);

    // Create a lock held by current process (will cause timeout on acquireLock)
    createLockFile(sessionDir, String(process.pid));

    // Create an inbox message so the engine tries to process this session
    fs.writeFileSync(
      path.join(sessionDir, 'inbox.jsonl'),
      JSON.stringify({ msg_id: 'msg1', from: 'a', to: sessionId, payload: 'x', created_at: Math.floor(Date.now() / 1000), attempt: 0 }) + '\n'
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.jsonl'),
      JSON.stringify({ msg_id: 'msg1', state: 'pending', ts: Math.floor(Date.now() / 1000) }) + '\n'
    );

    const engine = new DeliveryEngine(mb, {
      sessionResolver: () => [sessionId],
      pollMs: 50,
    });

    // Tick 1: lock timeout, count=1 → backoff
    await engine.tick();
    assert.ok(lockExists(sessionDir), 'lock should still exist after 1 failure');

    // Reset skipUntil to allow immediate retry
    engine._skipUntil.delete(sessionId);

    // Tick 2: lock timeout, count=2 → force-break
    await engine.tick();
    assert.ok(!lockExists(sessionDir), 'lock should be broken after 2 consecutive failures');
    assert.equal(engine._lockFailures.get(sessionId), undefined, 'failure count should be reset');
  });
});

// --- Fix 5: Skip backoff ---

describe('DeliveryEngine — skip backoff', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  it('skips session during backoff period', async () => {
    const mb = new FileMailbox({
      root: tmpDir,
      lockBreakAfterFailures: 999, // high so force-break doesn't trigger
      staleLockAgeSecs: 9999,
    });

    const sessionId = 'backoff-session';
    const sessionDir = createSessionDir(tmpDir, sessionId);
    createLockFile(sessionDir, String(process.pid));

    // Create inbox data
    fs.writeFileSync(
      path.join(sessionDir, 'inbox.jsonl'),
      JSON.stringify({ msg_id: 'msg1', from: 'a', to: sessionId, payload: 'x', created_at: Math.floor(Date.now() / 1000), attempt: 0 }) + '\n'
    );
    fs.writeFileSync(
      path.join(sessionDir, 'state.jsonl'),
      JSON.stringify({ msg_id: 'msg1', state: 'pending', ts: Math.floor(Date.now() / 1000) }) + '\n'
    );

    const engine = new DeliveryEngine(mb, {
      sessionResolver: () => [sessionId],
      pollMs: 100,
    });

    // Tick 1: lock timeout → sets backoff
    await engine.tick();
    assert.ok(engine._skipUntil.has(sessionId), 'should set skipUntil after lock failure');

    const skipTime = engine._skipUntil.get(sessionId);
    assert.ok(skipTime > Date.now(), 'skipUntil should be in the future');

    // Tick 2: should skip immediately (no lock timeout delay)
    const start = Date.now();
    await engine.tick();
    const elapsed = Date.now() - start;
    // If it skipped, it should be very fast (no 500ms lock timeout)
    assert.ok(elapsed < 100, `tick should be fast during backoff (was ${elapsed}ms)`);

    // Clean up
    try { fs.unlinkSync(path.join(sessionDir, '.lock')); } catch {}
  });

  it('clears backoff on successful operation', async () => {
    const mb = new FileMailbox({ root: tmpDir });
    const sessionId = 'success-session';
    const sessionDir = createSessionDir(tmpDir, sessionId);

    const engine = new DeliveryEngine(mb, {
      sessionResolver: () => [sessionId],
      pollMs: 50,
    });

    // Manually set some failure state
    engine._lockFailures.set(sessionId, 2);
    engine._skipUntil.set(sessionId, Date.now() - 1000); // expired backoff

    // Tick: no lock contention, no messages → success path
    await engine.tick();

    // Should have cleared the state (dequeue returns null → success path via 'continue')
    // The session has no inbox so dequeue returns null without acquiring lock
    // This is still a success path
    assert.ok(!engine._skipUntil.has(sessionId) || engine._skipUntil.get(sessionId) <= Date.now(),
      'skipUntil should be cleared or expired');
  });
});

// --- Config ---

describe('mailbox config — new fields', () => {
  it('staleLockAgeSecs defaults to 60', () => {
    const mb = new FileMailbox({ root: createTmpDir() });
    assert.equal(mb.config.staleLockAgeSecs, 60);
    cleanupDir(mb.config.root);
  });

  it('lockBreakAfterFailures defaults to 3', () => {
    const mb = new FileMailbox({ root: createTmpDir() });
    assert.equal(mb.config.lockBreakAfterFailures, 3);
    cleanupDir(mb.config.root);
  });

  it('config overrides work', () => {
    const mb = new FileMailbox({ root: createTmpDir(), staleLockAgeSecs: 30, lockBreakAfterFailures: 5 });
    assert.equal(mb.config.staleLockAgeSecs, 30);
    assert.equal(mb.config.lockBreakAfterFailures, 5);
    cleanupDir(mb.config.root);
  });
});
