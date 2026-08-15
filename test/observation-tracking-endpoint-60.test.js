'use strict';

// telepty#60 Stage A — §8.3.1 `tracking_unknown_survives_restart`, §8.3.2 `missing_tracking_is_explicit`,
// §8.3.3 `tracking_persist_failure_prevents_delivery`, §8.1 `pending_overwrite_emits_superseded`,
// §8.1 `dead_reports_absence_to_source`, and the §8.3.9 endpoint totality property.
//
// This file runs against a REAL daemon subprocess, on purpose. The rest of this track's tests
// drive exported seams; these rows are about what an ORCHESTRATOR sees when it polls across a
// process boundary and a restart, and the defects they pin are all ordering or durability defects
// that a unit-level double would paper over:
//
//   * the tracking record used to be an in-memory assignment made AFTER delivery, so bytes reached
//     a worker and a restart left nothing anywhere that could answer for the dispatch;
//   * the poll answered 404, and a consumer read that 404 as a task-state signal — "the daemon has
//     no record of this" and "the work is finished" are different statements and a status code
//     cannot tell them apart;
//   * a second dispatch to the same session destructively overwrote the SID-keyed pending entry, so
//     the first inject_id became unqueryable, which is indistinguishable from never existing.
//
// Every daemon here binds PORT=0 with a temp HOME. Nothing touches the production daemon.
//
// NOT IN THIS FILE: §8.3.10 (owner_displaced_without_markdead_reports_absence) was reassigned to
// the track that owns src/transport/websocket.js — it needs a daemon seam that does not exist yet,
// and a RED test for a seam belongs with the seam.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestDaemon, createSessionId } = require('../test-support/daemon-harness');

let daemon;

before(async () => { daemon = await startTestDaemon(); });
after(async () => { if (daemon) await daemon.stop(); });

// A tracked dispatch: `from` present is what makes the daemon open a durable record.
async function dispatch(target, prompt, from = 'orchestrator') {
  const res = await daemon.request(`/api/sessions/${encodeURIComponent(target)}/inject`, {
    method: 'POST', body: { prompt, from },
  });
  return res;
}

function observations(injectId, d = daemon) {
  return d.request(`/api/inject-observations/${encodeURIComponent(injectId)}`);
}

// Shared assertions — every body this endpoint returns, on every arm, must satisfy these.
function assertDiscriminatedUnknown(res, label) {
  assert.equal(res.status, 200,
    `[${label}] expected 200 with a discriminated body, got ${res.status} — a status code is not a task-state signal`);
  const b = res.body;
  assert.equal(b.type, 'task_completion_unknown', `[${label}] type`);
  assert.equal(b.schema_version, 2, `[${label}] schema_version`);
  assert.equal(b.completion_fact, null, `[${label}] completion_fact must be null`);
  assert.equal(b.terminal, false, `[${label}] terminal must be false`);
  assert.equal(typeof b.observation, 'object', `[${label}] observation must always be an object`);
  assert.equal(typeof b.observation.kind, 'string', `[${label}] observation.kind must always be a string`);
  assert.ok(b.capability, `[${label}] the capability block must be present (§A4)`);
  assert.equal(b.capability.outcome_protocol, 'unavailable', `[${label}] outcome protocol is unavailable in 0.8.0`);
  return b;
}

// --- §8.3.2 missing_tracking_is_explicit -----------------------------------------------------

test('missing_tracking_is_explicit: an unknown inject_id is 200 unavailable with a named reason, never 404', () => {
  return (async () => {
    const res = await observations('inject-that-was-never-tracked');
    const body = assertDiscriminatedUnknown(res, 'unknown inject_id');
    assert.equal(body.tracking_state, 'unavailable');
    // §8.3.2 / the dispatch-tracker contract: `reason` is TOP-LEVEL, because bin/dispatch-tracker.sh
    // reads it there. Nesting it would be a silent break of the one consumer this endpoint exists for.
    assert.equal(body.reason, 'not_observed_by_daemon_epoch');
    assert.equal(body.observation.kind, 'tracking_unavailable');
    assert.equal(body.observation.trigger, 'not_observed_by_daemon_epoch');
    assert.equal(body.consumption.status, 'not_established');
  })();
});

test('missing_tracking_is_explicit: malformed and hostile inject_ids are unavailable, not crashes', () => {
  return (async () => {
    // A prototype-key probe is the shape that turns a lookup into an object-injection bug; the
    // ledger read rejects those names outright. Each must still answer with the same schema.
    for (const id of ['__proto__', 'constructor', 'prototype', 'a/b', ' ']) {
      const res = await observations(id);
      const body = assertDiscriminatedUnknown(res, `hostile id ${JSON.stringify(id)}`);
      assert.equal(body.tracking_state, 'unavailable');
      assert.equal(typeof body.reason, 'string');
    }
  })();
});

// --- §8.1 pending_overwrite_emits_superseded -------------------------------------------------

test('pending_overwrite_emits_superseded: a second dispatch retains the first inject_id and names the supersession', () => {
  return (async () => {
    const sid = createSessionId('supersede');
    await daemon.spawnSession(sid);

    const first = await dispatch(sid, 'first task');
    assert.equal(first.status, 200, `first inject failed: ${JSON.stringify(first.body)}`);
    const firstId = first.body.inject_id;
    assert.equal(typeof firstId, 'string');

    const second = await dispatch(sid, 'second task');
    assert.equal(second.status, 200);
    const secondId = second.body.inject_id;
    assert.notEqual(secondId, firstId);

    // The OLD inject is still queryable — that is the whole property. An inject_id nobody can
    // query is indistinguishable from one that never existed, and the orchestrator holds that id.
    const oldRes = await observations(firstId);
    const old = assertDiscriminatedUnknown(oldRes, 'superseded inject');
    assert.equal(old.tracking_state, 'superseded',
      `expected tracking_superseded for the old inject, got tracking_state=${old.tracking_state}`);
    assert.equal(old.inject_id, firstId);
    const kinds = (old.observations || []).map(o => o.kind);
    assert.ok(kinds.includes('tracking_superseded'),
      `the old record must carry a tracking_superseded observation, got [${kinds.join(', ')}]`);
    const supersededEntry = old.observations.find(o => o.kind === 'tracking_superseded');
    assert.equal(supersededEntry.superseded_by, secondId, 'the supersession must name its successor');
    // Superseded is not settled: the first dispatch's outcome is still unknown, not "replaced".
    assert.equal(old.completion_fact, null);

    // …and the new one is tracked in its own right.
    const newBody = assertDiscriminatedUnknown(await observations(secondId), 'successor inject');
    assert.equal(newBody.tracking_state, 'tracked');
  })();
});

// --- §8.3.1 tracking_unknown_survives_restart -------------------------------------------------

test('tracking_unknown_survives_restart: a record survives a daemon restart and gains daemon_restart_observed', () => {
  return (async () => {
    // A dedicated daemon whose HOME the test owns, so a second daemon can be started against the
    // same state directory. `kill()` rather than `stop()`: stop() DELETEs every session on the way
    // out, which would destroy the very state the restart is supposed to carry across.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty60-restart-'));
    const first = await startTestDaemon({ homeDir });
    let second = null;
    try {
      const sid = createSessionId('restart');
      await first.spawnSession(sid);
      const res = await first.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
        method: 'POST', body: { prompt: 'survive a restart', from: 'orchestrator' },
      });
      assert.equal(res.status, 200, `inject failed: ${JSON.stringify(res.body)}`);
      const injectId = res.body.inject_id;

      const before = await first.request(`/api/inject-observations/${encodeURIComponent(injectId)}`);
      assert.equal(before.status, 200);
      assert.equal(before.body.tracking_state, 'tracked');
      const seqBefore = before.body.observation_seq;

      await first.kill();
      second = await startTestDaemon({ homeDir });

      const after = await second.request(`/api/inject-observations/${encodeURIComponent(injectId)}`);
      const body = assertDiscriminatedUnknown(after, 'after restart');
      assert.equal(body.inject_id, injectId, 'the record must be queryable by the SAME inject_id');
      assert.equal(body.session_id, sid);
      // Still unknown. A restart is not evidence about the task, in either direction.
      assert.equal(body.completion_fact, null);
      assert.equal(body.terminal, false);
      // The restart itself is recorded as an observation, appended before readiness — so a poll
      // that lands right after a restart can SEE why the record looks the way it does.
      const kinds = (body.observations || []).map(o => o.kind);
      assert.ok(kinds.includes('tracking_started'),
        `the original transport observation must survive, got [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('daemon_restart_observed'),
        `expected daemon_restart_observed after restart, got [${kinds.join(', ')}]`);
      assert.ok(body.observation_seq > seqBefore, 'the restart appends rather than replaces');
    } finally {
      if (second) await second.stop();
      await first.kill().catch(() => {});
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })();
});

// --- §8.3.3 tracking_persist_failure_prevents_delivery ---------------------------------------

test('tracking_persist_failure_prevents_delivery: an unwritable ledger aborts the delivery, and no bytes reach the target', () => {
  return (async () => {
    // Make the ledger path unwritable in the one way that cannot be mistaken for anything else: its
    // parent directory is a FILE, so mkdirSync throws and the atomic write returns {ok:false}.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telepty60-nowrite-'));
    const blocker = path.join(home, 'blocked');
    fs.writeFileSync(blocker, 'not a directory');
    const ledgerPath = path.join(blocker, 'tracked-injections.json');

    const d = await startTestDaemon({ env: { TELEPTY_TRACKED_INJECTIONS_PATH: ledgerPath } });
    try {
      const sid = createSessionId('nowrite');
      await d.spawnSession(sid);
      // A marker that could only appear on the target's screen if the bytes were delivered.
      const marker = 'PERSIST_FAILURE_MARKER_9f3a';
      const res = await d.request(`/api/sessions/${encodeURIComponent(sid)}/inject`, {
        method: 'POST', body: { prompt: `echo ${marker}`, from: 'orchestrator' },
      });

      assert.equal(res.status, 500,
        `expected the delivery to be REFUSED when tracking cannot be persisted, got ${res.status}`);
      assert.equal(res.body.code || res.body.error, 'TRACKING_PERSISTENCE_FAILED');
      assert.equal(res.body.tracking_state, 'unavailable');
      assert.equal(res.body.reason, 'tracking_persistence_failed');

      // The load-bearing half: refusing to deliver is honest, delivering and then forgetting is not.
      const screen = await d.request(`/api/sessions/${encodeURIComponent(sid)}/screen`);
      const text = typeof screen.body === 'string' ? screen.body : JSON.stringify(screen.body);
      assert.equal(text.includes(marker), false,
        'task bytes reached the target even though the observation record could not be persisted');
    } finally {
      await d.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  })();
});

// --- §8.1 dead_reports_absence_to_source -----------------------------------------------------

test('dead_reports_absence_to_source: a process exit is reported as absence, and the record stays queryable', () => {
  return (async () => {
    // A real SOURCE session, so the source-facing half of the row is exercised and not just the
    // bus. Without it `deliverToSource` finds no session and silently does nothing — which would
    // leave the "reports absence TO SOURCE" half of this row untested while the test still passed.
    //
    // The id must be the literal `orchestrator`: the #533 peer-lane guardrail rejects a tracked
    // inject whose `from` is outside AIGENTRY_ORCHESTRATOR_SIDS with 403 PEER_INJECT_BLOCKED, so a
    // uniquely-named source session cannot dispatch at all. (This is a test-daemon on PORT=0 with
    // a temp HOME; the name collides with nothing outside it.)
    const source = 'orchestrator';
    await daemon.spawnSession(source);

    // A child that exits on its own is the entrance §8.1's row names: `ptyProcess.onExit` calls
    // `sessionStateManager.markDead` while the session record is still live (daemon.js:3079-3082),
    // so the transition listener sees it.
    //
    // NOT the DELETE path, deliberately — and the two are no longer interchangeable. That path
    // observes its ending too (the §A2 silence it once produced is fixed), but under
    // `session_termination_requested`: an operator asked for the teardown and no exit status was
    // observed at that instant. `session_process_exited` is now reserved for an exit that was
    // actually seen, and requires `exit_observed_at` to be stated at all (#843). This arm is the
    // entrance that genuinely observes one. See test/delete-death-observation-60.test.js.
    const sid = createSessionId('dying');
    await daemon.spawnSession(sid, { command: 'bash', args: ['-c', 'sleep 3'] });
    const res = await dispatch(sid, 'work this process will not survive', source);
    assert.equal(res.status, 200);
    const injectId = res.body.inject_id;

    const body = await daemon.waitFor(async () => {
      const poll = await observations(injectId);
      if (poll.status !== 200) return null;
      const kinds = (poll.body.observations || []).map(o => o.kind);
      return kinds.includes('session_process_exited') ? poll.body : null;
    }, { timeoutMs: 6000, description: 'session_process_exited observation' });

    // The pending entry is released on death; the LEDGER record is not. A poll after the process
    // is gone still gets a named observation instead of a 404.
    assert.equal(body.completion_fact, null,
      'a death is not a completion — the task outcome is still unknown');
    assert.equal(body.terminal, false);
    const exited = body.observations.find(o => o.kind === 'session_process_exited');
    assert.ok(exited, 'the exit must be recorded as its own literal observation');
    assert.equal(exited.trigger, 'process_exit');

    // …and the SOURCE is told, in the literal absence text. The old dead branch only broadcast on
    // the bus, so an orchestrator that was not subscribed learned nothing at all.
    const screen = await daemon.request(`/api/sessions/${encodeURIComponent(source)}/screen`);
    const text = typeof screen.body === 'string' ? screen.body : JSON.stringify(screen.body);
    assert.ok(text.includes('TASK_COMPLETION_UNKNOWN'),
      'expected the source to receive a completion-absence notification for the dead worker');
    assert.ok(!/\bTASK_COMPLETE\b|\bTASK_ERROR\b/.test(text),
      'the source must never be told the task completed or failed — neither was measured');
  })();
});

// --- §8.3.9 all_observation_entrypoints_return_decisions (endpoint half) ----------------------

test('all_observation_entrypoints_return_decisions: every endpoint arm answers 200 with the same schema', () => {
  return (async () => {
    // The totality property at the surface an orchestrator actually polls. Four states a record can
    // be in, one schema, no 404 anywhere — including the arm where nothing was ever tracked, which
    // is the one that used to be a 404 and the one a consumer misread as a task signal.
    const sid = createSessionId('total');
    await daemon.spawnSession(sid);

    const tracked = await dispatch(sid, 'arm: tracked');
    const trackedId = tracked.body.inject_id;
    const superseding = await dispatch(sid, 'arm: superseding');
    const supersedingId = superseding.body.inject_id;

    const arms = [
      ['tracked',     supersedingId,                 'tracked'],
      ['superseded',  trackedId,                     'superseded'],
      ['never tracked', 'no-such-inject-id',         'unavailable'],
      ['empty-ish id',  '%20',                       'unavailable'],
    ];
    for (const [label, id, expectedState] of arms) {
      const res = await observations(id);
      const body = assertDiscriminatedUnknown(res, label);
      assert.equal(body.tracking_state, expectedState, `[${label}] tracking_state`);
      // No arm may carry an outcome, and none may answer with a bare error shape.
      assert.equal(body.completion_fact, null, `[${label}] completion_fact`);
      assert.equal(body.error, undefined, `[${label}] the endpoint must not answer with an error envelope`);
    }
  })();
});

test('all_observation_entrypoints_return_decisions: the retired pendingReports view carries no authority bit', () => {
  return (async () => {
    // /api/pendingReports/:id survives as an inspection view, but `idle_notified` is GONE from it.
    // That bit was the PTY-derived false authority: a consumer reading it as "the worker finished"
    // was reading a debounce flag. What is exposed now is the ledger's own observation.
    const sid = createSessionId('pending');
    await daemon.spawnSession(sid);
    await dispatch(sid, 'inspect me');

    const res = await daemon.request(`/api/pendingReports/${encodeURIComponent(sid)}`);
    assert.equal(res.status, 200);
    assert.equal('idle_notified' in res.body, false,
      'idle_notified must not be exposed — it is a debounce bit, not a task fact');
    assert.equal(res.body.completion_fact, null);
    assert.equal(res.body.terminal, false);
    assert.equal(res.body.tracking_state, 'tracked');
  })();
});

// =============================================================================================
// #843 — the write-ahead record must be able to say the delivery did not happen
// =============================================================================================

test('#843 refused_delivery_aborts_the_write_ahead_record: zero bytes written is a measurement, not a gap', async () => {
  // The record is created BEFORE delivery on purpose (§3 item 1): a delivered task that no record
  // answers for is the silence this release removes. But the write-ahead has no ABORT. When the
  // delivery is then refused — a wrapped session with no owner socket, an aterm whose endpoint is
  // gone — the ledger keeps `tracking_state:"tracked"` with `inject_accepted` forever, and the
  // pendingReport entry leaks alongside it.
  //
  // That inverts the release's thesis. The daemon MEASURED that zero bytes were written, returned
  // that measurement to the HTTP caller as a 503, and then discarded it everywhere else — so an
  // orchestrator polling the ledger sees a dispatch that looks in-flight and will never move,
  // which is the "waiting forever on something that never started" failure the tracking exists to
  // prevent.
  const sid = createSessionId('undelivered');
  const reg = await daemon.request('/api/sessions/register', {
    method: 'POST', body: { session_id: sid, command: 'test-wrap', cwd: process.cwd() },
  });
  assert.ok([200, 201].includes(reg.status), `register: ${reg.status}`);

  // Registered but never connected: there is no owner socket, so nothing can receive the bytes.
  const res = await dispatch(sid, 'this dispatch has nowhere to land');
  assert.notEqual(res.status, 200, `expected a refusal, got ${res.status} ${JSON.stringify(res.body)}`);
  const injectId = res.body.inject_id;
  assert.ok(injectId, `the refusal must still name the inject it refused: ${JSON.stringify(res.body)}`);

  const poll = await observations(injectId);
  const body = assertDiscriminatedUnknown(poll, 'after a refused delivery');
  assert.equal(body.tracking_state, 'aborted',
    'a dispatch whose bytes were refused is not "tracked" — nothing is in flight to track');
  const kinds = (body.observations || []).map((o) => o.kind);
  assert.ok(kinds.includes('inject_delivery_refused'),
    `the refusal must be recorded as its own observation, got ${JSON.stringify(kinds)}`);
  const refused = body.observations.find((o) => o.kind === 'inject_delivery_refused');
  assert.ok(refused.delivery_code, 'and it must name WHY the delivery was refused');
  // Still not an outcome: a task that never started did not fail, it never started.
  assert.equal(body.completion_fact, null);
  assert.equal(body.terminal, false);

  // The pendingReport must not leak either — it is what makes the session look busy to every
  // later observation, and it belongs to an inject that was never delivered.
  const pending = await daemon.request(`/api/pendingReports/${encodeURIComponent(sid)}`);
  assert.equal(pending.status, 404,
    'a refused dispatch must not leave a pending report behind claiming the session is awaiting a turn');
});

test('#843 consumption_is_measured_for_the_inject_being_polled, never for whichever one is active', async () => {
  // The poll built its consumption block from `getPendingReport(record.session_id)` — whatever
  // inject currently owns that session's pending slot — with no check that it is the inject being
  // asked about. So `GET /api/inject-observations/A` silently changes its answer when an unrelated
  // inject B arrives, and becomes byte-identical to `GET B` while A is marked superseded. One
  // inject's evidence served under another inject's id is the same substitution this release
  // removes everywhere else, at the endpoint an orchestrator polls to decide what happened.
  const sid = createSessionId('crossinject');
  await daemon.spawnSession(sid);

  const first = await dispatch(sid, 'inject A');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await dispatch(sid, 'inject B');
  assert.equal(second.status, 200, JSON.stringify(second.body));

  const a = await observations(first.body.inject_id);
  const b = await observations(second.body.inject_id);
  assertDiscriminatedUnknown(a, 'superseded inject A');
  assertDiscriminatedUnknown(b, 'active inject B');

  assert.equal(a.body.tracking_state, 'superseded');
  assert.equal(b.body.tracking_state, 'tracked');
  assert.equal(a.body.consumption.basis, 'pending_report_belongs_to_other_inject',
    'A has no pending report of its own — that absence is the honest answer, not B\'s evidence');
  assert.notDeepEqual(a.body.consumption, b.body.consumption,
    'two different injects must not receive the same consumption block measured once, on one of them');
});
