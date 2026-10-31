'use strict';

// #1207 — support for in-process suites that assert WHAT THE SOURCE IS TOLD through the real
// fireAutoReport → recordObservation path (deps DI seam). Under #1207 the source is notified only
// after the observation's fsynced ACK on a DURABLY BEGUN tracked record (durable before delivery);
// the 0.9.1 bodies of these suites passed an inject id the ledger had never seen, so the real path
// correctly delivered nothing. This module supplies that precondition and the waiting the async path
// needs. It changes no assertion and no product seam:
//   • trackedInjectId(base) — a fresh id per fixture. The #914 once-per-inject source notification
//     is keyed on the durable record, so one id reused across tests would dedup a later test's
//     genuine first delivery. The id keeps `base` as its prefix.
//   • beginTracked(daemon, …) — awaits the daemon's own ledger open, then the REAL begin.
//   • settle(progress, { busy }) — waits until no ledger submission is in flight (`busy`) AND the
//     observable state has not changed for `quietMs` (bounded by `maxMs`), so an arm that emits
//     nothing is measured after the async path had time to emit, never before.
//   • settleTracked(daemon, progress) — settle with `busy` = the daemon ledger client's inflight set.
//   • fireAndSettle(daemon, fire, progress) — awaits the decision a fire returns (a promise on the emit
//     path, a named string on the deferral / duplicate arms), then settles.

let counter = 0;
function trackedInjectId(base) { return `${base}-${process.pid}-${++counter}`; }

const opened = new WeakMap();
function ledgerOpen(daemon) {
  if (!opened.has(daemon)) {
    opened.set(daemon, Promise.resolve(daemon.ledgerReady).then((r) => {
      if (!r || r.ok !== true) throw new Error(`the in-process daemon ledger must open first: ${JSON.stringify(r)}`);
      return r;
    }));
  }
  return opened.get(daemon);
}

async function beginTracked(daemon, { injectId, sessionId, source = 'orch', session }) {
  await ledgerOpen(daemon);
  const begun = await daemon.beginTrackedInjection({ injectId, sessionId, source, session: session || { id: sessionId } });
  if (!begun || begun.ok !== true) throw new Error(`the tracked begin for ${injectId} must be durable first: ${JSON.stringify(begun)}`);
  return begun;
}

// Started eagerly by a synchronous fixture factory; awaited by the first fire. The no-op catch only
// keeps a fixture that is never fired from raising an unhandled rejection — the awaited copy still
// rejects into the test that uses it.
function beginTrackedEager(daemon, args) {
  const p = beginTracked(daemon, args);
  p.catch(() => {});
  return p;
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(progress, { quietMs = 150, maxMs = 10000, busy = null } = {}) {
  const t0 = Date.now();
  let last = progress();
  let changedAt = Date.now();
  for (;;) {
    await tick(5);
    const now = progress();
    if (now !== last || (busy && busy())) { last = now; changedAt = Date.now(); }
    if (Date.now() - changedAt >= quietMs || Date.now() - t0 >= maxMs) return;
  }
}
function settleTracked(daemon, progress, opts = {}) {
  return settle(progress, { ...opts, busy: () => daemon.ledgerClient.status().inflight > 0 });
}

async function fireAndSettle(daemon, fire, progress, opts) {
  let decision = fire();
  if (decision && typeof decision.then === 'function') decision = await decision;
  await settleTracked(daemon, progress, opts);
  return decision;
}

module.exports = { trackedInjectId, ledgerOpen, beginTracked, beginTrackedEager, settle, settleTracked, fireAndSettle };
