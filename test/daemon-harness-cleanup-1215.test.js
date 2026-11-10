'use strict';

// Task 1215 CI612 U3 (Windows only): stop()'s private-HOME removal against a REAL handle that denies Delete sharing
// (FileShare.None; FileShare.Delete would ALLOW the delete). Holder: fixed powershell.exe, literal script below (no double
// quotes, no interpolation; inputs only via fixed TELEPTY_HOLD612_* env). It opens a HOME file with FileShare.None, prints
// epoch-ms READY, waits for the entry signal (ENTERED), releases after 300 ms ('short') or on a release file
// ('until_release'), self-bounds at 20 s, prints RELEASED. Precondition proof: READY, then a real unlink is refused
// (EBUSY/EPERM) and the file remains. Entry sync: t.mock.method(fs, 'rmSync') records entry, writes the signal
// synchronously, then delegates to the REAL rmSync unchanged. GREEN: all pass. RED (old line, no retry): only 'short' fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startTestDaemon } = require('../test-support/daemon-harness');

const SKIP = process.platform === 'win32' ? false : 'Windows-only: FileShare.None delete-denial is a Windows handle semantic';
const READY_BOUND_MS = 30000;      // a cold hosted-runner powershell.exe start has been measured at 4-13 s
const HOLDER_EXIT_BOUND_MS = 25000; // the holder's own 20 s lifetime plus margin
const PERMANENT_BOUND_MS = 5000;   // declared bound for a retry-exhausted removal (600 ms documented backoff + work)
const SHORT_WINDOW_MS = 600;       // control630: Node 26 RmSync's last attempt starts >= 100+200+300 ms after entry (node_file.cc)
const HOLDER_PS = "$ErrorActionPreference='Stop';$n={[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()};"
  + "$h=[IO.File]::Open($env:TELEPTY_HOLD612_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);"
  + "$e=Join-Path $env:TELEPTY_HOLD612_CTL 'entered';$r=Join-Path $env:TELEPTY_HOLD612_CTL 'release';$null=Test-Path -LiteralPath $e;Start-Sleep -Milliseconds 0;"
  + "[Console]::Out.WriteLine('READY '+(& $n));[Console]::Out.Flush();$end=(& $n)+20000;"
  + "while(-not(Test-Path -LiteralPath $e) -and (& $n) -lt $end){Start-Sleep -Milliseconds 5};"
  + "[Console]::Out.WriteLine('ENTERED '+(& $n)+' '+(Test-Path -LiteralPath $e));[Console]::Out.Flush();"
  + "if($env:TELEPTY_HOLD612_MODE -eq 'short'){Start-Sleep -Milliseconds 300}"
  + "else{while(-not(Test-Path -LiteralPath $r) -and (& $n) -lt $end){Start-Sleep -Milliseconds 5}};"
  + "$h.Dispose();[Console]::Out.WriteLine('RELEASED '+(& $n));[Console]::Out.Flush()";

const bounded = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ bound: ms }), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); });
});

function startHolder(file, ctl, mode) {
  const events = {}, tail = { out: '', err: '' };
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', HOLDER_PS], {
    shell: false, windowsHide: true, cwd: ctl, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TELEPTY_HOLD612_FILE: file, TELEPTY_HOLD612_CTL: ctl, TELEPTY_HOLD612_MODE: mode } });
  let onReady;
  const ready = new Promise((resolve) => { onReady = resolve; });
  child.stdout.on('data', (chunk) => {
    tail.out = (tail.out + chunk.toString()).slice(-4096);
    for (const m of tail.out.matchAll(/^(READY|ENTERED|RELEASED) (\d{10,16})(?: (True|False))?\r?$/gm)) {
      const key = m[1].toLowerCase();
      if (events[key] === undefined) events[key] = Number(m[2]);
      if (key === 'entered' && events.entered_signal === undefined) events.entered_signal = m[3] === 'True';
    }
    if (events.ready !== undefined) onReady(true);
  });
  child.stderr.on('data', (chunk) => { tail.err = (tail.err + chunk.toString()).slice(-2048); });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { onReady(false); resolve({ code: null, error: error && error.code }); });
    child.once('exit', (code, signal) => { onReady(false); resolve({ code, signal }); });
  });
  return { child, events, tail, ready, exited };
}

// One stop() of a real harness daemon; mode 'none' (no holder), 'short' or 'until_release'.
async function stopWithHolder(t, mode) {
  const daemon = await startTestDaemon();
  const home = daemon.homeDir, ctl = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty-hold612-'));
  const realRmSync = fs.rmSync, rm = { entered: null, returned: null, threw: null, code: null };
  t.mock.method(fs, 'rmSync', function rmSyncEntry(target, options) {
    if (target !== home) return realRmSync.call(fs, target, options);
    rm.entered = Date.now();
    fs.writeFileSync(path.join(ctl, 'entered'), '');
    try { const value = realRmSync.call(fs, target, options); rm.returned = Date.now(); return value; }
    catch (error) { rm.threw = Date.now(); rm.code = error && error.code; throw error; }
  });
  let holder = null;
  try {
    if (mode !== 'none') {
      const file = path.join(home, 'hold612.bin');
      fs.writeFileSync(file, 'held');
      holder = startHolder(file, ctl, mode);
      assert.equal(await bounded(holder.ready, READY_BOUND_MS), true, `PRECONDITION: holder READY (stderr: ${holder.tail.err.slice(-300)})`);
      let refusal = null;
      try { fs.unlinkSync(file); } catch (error) { refusal = error && error.code; }
      assert.ok((refusal === 'EBUSY' || refusal === 'EPERM') && fs.existsSync(file), `PRECONDITION: a real delete is refused (${refusal})`);
    }
    const t0 = Date.now();
    const stopped = await daemon.stop().then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    const r = { stopped, stop_ms: Date.now() - t0, rm, home_exists: fs.existsSync(home), daemon_alive: daemon.isAlive(), holder: null };
    if (holder) {
      if (mode === 'until_release') fs.writeFileSync(path.join(ctl, 'release'), '');
      r.holder = { events: holder.events, exit: await bounded(holder.exited, HOLDER_EXIT_BOUND_MS) };
    }
    t.diagnostic(`CI612 U3 ${mode}: ${JSON.stringify({ stop_ms: r.stop_ms, rm, holder: r.holder, stop_error: stopped.ok ? null : stopped.error.code })}`);
    return r;
  } finally {
    if (daemon.isAlive()) await daemon.kill().catch(() => {});
    if (holder && holder.child.exitCode === null && holder.child.signalCode === null) {
      try { fs.writeFileSync(path.join(ctl, 'release'), ''); } catch { /* the kill below still ends it */ }
      holder.child.kill();
      await bounded(holder.exited, HOLDER_EXIT_BOUND_MS);
    }
    // Test-owned leftovers only (the permanent case leaves the HOME by design), after the holder is gone.
    for (const dir of [home, ctl]) realRmSync.call(fs, dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test('[CI612 U3] no holder: stop() removes the private HOME', { skip: SKIP, timeout: 90000 }, async (t) => {
  const r = await stopWithHolder(t, 'none');
  assert.equal(r.stopped.ok, true, `stop() resolved: ${r.stopped.error && r.stopped.error.code}`);
  assert.ok(!r.home_exists && !r.daemon_alive && r.rm.returned !== null && r.rm.threw === null, JSON.stringify(r.rm));
});

test('[CI612 U3] a FileShare.None handle released ~300 ms after removal began: stop() still removes the private HOME',
  { skip: SKIP, timeout: 90000 }, async (t) => {
    const r = await stopWithHolder(t, 'short');
    const ev = r.holder.events, shown = JSON.stringify({ rm: r.rm, holder: r.holder });
    assert.ok(ev.entered_signal === true && ev.ready < r.rm.entered && ev.released > r.rm.entered, `the real hold spanned the removal entry: ${shown}`);
    assert.ok(ev.released - r.rm.entered < SHORT_WINDOW_MS, `INVALID FIXTURE (not a result): release reached the last-attempt window: ${shown}`);
    assert.equal(r.stopped.ok, true, `stop() resolved, not ${r.stopped.error && r.stopped.error.code}: ${shown}`);
    assert.ok(!r.home_exists && r.rm.returned >= ev.released, `removed only after the measured release: ${shown}`);
    assert.ok(r.holder.exit.code === 0 && !r.daemon_alive, `every own child closed: ${shown}`);
  });

test('[CI612 U3] a permanently held handle: stop() still fails, within the declared bound, and every own child closes',
  { skip: SKIP, timeout: 90000 }, async (t) => {
    const r = await stopWithHolder(t, 'until_release');
    const ev = r.holder.events, shown = JSON.stringify({ rm: r.rm, holder: r.holder });
    assert.equal(ev.entered_signal, true, `the holder saw the removal entry: ${shown}`);
    assert.equal(r.stopped.ok, false, `a persistent refusal is not swallowed: ${shown}`);
    // The code is recorded, not presumed: Node 20 removes through the JS implementation, Node 26 through a native binding.
    assert.ok(typeof r.rm.code === 'string' && r.rm.code === r.stopped.error.code, `stop() threw the removal's own error: ${shown}`);
    assert.ok(r.rm.threw - r.rm.entered <= PERMANENT_BOUND_MS && ev.released > r.rm.threw, `gave up within the bound, while held: ${shown}`);
    assert.ok(r.home_exists && r.holder.exit.code === 0 && !r.daemon_alive, `HOME left for test cleanup; every own child closed: ${shown}`);
  });
