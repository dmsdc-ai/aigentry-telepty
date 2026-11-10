'use strict';

// Task 1215 CI612 U1 (MEASUREMENT ONLY, opt-in TELEPTY_CI_OBSERVE607=1; unset it SKIPS, the default aborts at 1 ms): a
// positive control for the CI609 failure-only request_timeout record. One real tracked inject POST, per-call timeoutMs
// LOWERED to 1 ms (the fixture-level requestTimeoutMs would also lower readiness/spawn/probes). Stage fact: the harness's
// pendingReports probe leaves ~1 ms after begin, but the daemon sets that entry only after its fsynced begin commit, so 1 ms
// alone cannot reliably see THIS inject's record. Test-only sequencing (the globalThis.fetch seam the observe148 fixtures
// use): every request goes to the REAL daemon unchanged; only that probe is HELD until this inject's real answer arrived
// (the answer follows the commit), within the probe's own 2 s bound. Limit: this proves the M1/M3 extraction executes on
// real answers; it does not time a natural failure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestDaemon, createSessionId, OBSERVE607, observe607 } = require('../test-support/daemon-harness');

const LOWER_MS = 1;
const EVENTUAL_BOUND_MS = 12000; // the harness's unchanged OBS_EVENTUAL_MS
const RECORD_FILE = path.join(__dirname, '..', 'ci-observe607', `harness-${process.pid}.jsonl`);

function readRecords(sid) {
  let text = '';
  try { text = fs.readFileSync(RECORD_FILE, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((r) => r && r.stage === 'request_timeout' && r.session === sid);
}

test('[CI612 U1] observe607 positive control: a 1 ms lowered tracked inject POST yields one complete request_timeout record',
  { skip: OBSERVE607 ? false : 'opt-in only (TELEPTY_CI_OBSERVE607=1); unset, the unchanged default aborts at 1 ms', timeout: 60000 },
  async () => {
    const daemon = await startTestDaemon();
    const realFetch = globalThis.fetch;
    try {
      await daemon.waitFor(async () => {
        const r = await daemon.request('/api/ledger/status');
        return r.status === 200 && r.body && r.body.client && r.body.client.store === 'available';
      }, { timeoutMs: 20000, description: 'ledger store available' });
      const sid = createSessionId('pc612');
      const spawned = await daemon.spawnSession(sid);
      assert.ok(spawned.status >= 200 && spawned.status < 300, `PRECONDITION: real session spawned (${spawned.status})`);

      const origin = `http://${daemon.host}:${daemon.port}`;
      const injectPath = `/api/sessions/${encodeURIComponent(sid)}/inject`, probePath = `/api/pendingReports/${encodeURIComponent(sid)}`;
      const seen = { inject: 0, probe_held: 0 };
      let markAnswered;
      const answered = new Promise((resolve) => { markAnswered = resolve; });
      globalThis.fetch = (input, init = {}) => {
        let url = null;
        try { url = new URL(String(input)); } catch { url = null; }
        if (url && url.origin === origin && url.pathname === injectPath && init.method === 'POST') {
          seen.inject++;
          const p = realFetch(input, init);
          p.then(markAnswered, markAnswered);
          return p;
        }
        if (url && url.origin === origin && url.pathname === probePath) { seen.probe_held++; return answered.then(() => realFetch(input, init)); }
        return realFetch(input, init);
      };

      observe607('test', { stage: 'positive_control_612', session: sid, lower_ms: LOWER_MS });
      const begun = Date.now();
      const outcome = await daemon.request(injectPath, { method: 'POST', body: { prompt: 'CI612 positive control', from: 'orchestrator' },
        timeoutMs: LOWER_MS }).then((value) => ({ value }), (error) => ({ error }));
      const settledMs = Date.now() - begun;
      globalThis.fetch = realFetch;

      assert.ok(outcome.error, `GAP: the inject answered (${outcome.value && outcome.value.status}) before the 1 ms decision (no retry)`);
      const error = outcome.error;
      assert.deepEqual([error.code, error.budget_ms, error.stage], ['HARNESS_REQUEST_TIMEOUT', LOWER_MS, 'headers'], error.message);
      assert.deepEqual(seen, { inject: 1, probe_held: 1 }, 'one real inject; the pendingReports probe was held until its answer');
      assert.ok(settledMs <= EVENTUAL_BOUND_MS + 5000, `the original error was thrown after a bounded observation (${settledMs} ms)`);

      const records = readRecords(sid);
      assert.equal(records.length, 1, `exactly one request_timeout record for ${sid} in ${path.basename(RECORD_FILE)}`);
      const r = records[0], shown = JSON.stringify(r);
      assert.deepEqual([r.method, r.route, r.budget_ms, r.http_stage], ['POST', '/api/sessions/:id/inject', LOWER_MS, 'headers'], shown);
      assert.ok(r.decided_ms >= LOWER_MS && Number.isInteger(r.timer_late_ms) && r.timer_late_ms >= 0, shown);
      // M1: /api/meta event_loop through the existing picker
      assert.ok(r.meta && r.meta.http_status === 200 && r.meta.event_loop && typeof r.meta.event_loop === 'object', `M1 meta.event_loop: ${shown}`);
      // the ORIGINAL request, observed within the bound
      const ev = r.eventual || {};
      assert.ok(ev.outcome === 'answered' && ev.http_status === 200 && ev.at_ms >= r.decided_ms && ev.at_ms <= EVENTUAL_BOUND_MS + r.decided_ms,
        `eventual: ${shown}`);
      // M3: THIS inject's committed begin (0 <= injected_at_ms <= its answer)
      const p = r.pending || {};
      assert.ok(p.http_status === 200 && p.present === true && p.tracking_state === 'tracked', `M3 pending: ${shown}`);
      assert.ok(Number.isFinite(p.injected_at_ms) && p.injected_at_ms >= 0 && p.injected_at_ms <= ev.at_ms, `M3 injected_at_ms: ${shown}`);
    } finally {
      globalThis.fetch = realFetch;
      await daemon.stop();
    }
  });
