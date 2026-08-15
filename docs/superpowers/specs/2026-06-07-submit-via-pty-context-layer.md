# Implementation spec — Submit via PTY/context layer (pty-only + PTY-native confirm)

> **⚠️ HISTORICAL — DO NOT IMPLEMENT. The code is not held; it shipped, and part of it has since
> been removed.** Changes 1/2/4 landed: `terminalLevelSubmit` is `submitViaPty` only (daemon.js),
> which is current. **Change 3 and test-plan items 5/6 are superseded by #60 Stage A** — they
> gate, assert and preserve `TASK_IDLE_UNCONFIRMED` and `TASK_COMPLETE`, and Stage A deleted every
> terminal label along with `fireAutoReport`'s ability to emit one. `fireAutoReport` now emits a
> single `task_completion_unknown` observation and nothing else; the daemon cannot measure task
> outcome and no longer claims it (`src/completion-observation.js`,
> `GET /api/inject-observations/:inject_id`; `CHANGELOG.md` → *0.8.0 — unreleased* → "BREAKING: telepty no
> longer asserts task completion (#60 Stage A)"). Do not resurrect a "never-started worker locks
> to `TASK_IDLE_UNCONFIRMED`" regression test — that label is gone by design.

- **ADR:** `docs/adr/2026-06-07-submit-via-pty-context-layer.md`
- **Status:** HISTORICAL — was "SPEC FIRST — code HELD until orchestrator injects `APPROVED`";
  the submit-path changes shipped, and Change 3 was later superseded by #60 Stage A
- **Tasks:** #544, #537 / BUG B
- **Files touched:** `daemon.js`, `src/submit-gate.js`, `test/` (new regression file)
- **Out of scope (Rule 29):** removing `submitViaCmux` / `sendViaKitty`
  *definitions*; the text-delivery render-gate (decision #4 KEEP); aterm
  (decision #5 EXCLUDE).

All line numbers are anchors at 0.5.4; the edits are exact-string matches.

---

## Change 1 — `terminalLevelSubmit` → single PTY path (daemon.js ~1188-1196)

**Before**
```js
function terminalLevelSubmit(id, session) {
  // Priority 1: kitty send-text (terminal-level, bypasses PTY raw mode quirks)
  if (session.type === 'wrapped' && sendViaKitty(id, '\r')) return 'kitty';
  // Priority 2: cmux send-key
  if (session.backend === 'cmux' && session.cmuxWorkspaceId && submitViaCmux(id)) return 'cmux';
  // Priority 3: PTY \r
  if (submitViaPty(session)) return 'pty_cr';
  return null;
}
```

**After**
```js
// Submit is a CONTEXT operation (telepty-owned), not a SURFACE operation
// (cmux/kitty adaptor-owned). Deliver the submit Enter via the PTY only — a
// bare 0x0D into the CLI's innermost node-pty. The kitty `send-text` (P1) and
// `cmux send-key` (P2) branches were SURFACE ops on the flaky side channel
// (75× "Failed to write to socket" vs 0× for pty_cr in a 222k-line run; live
// 2026-06-07 confirmed pty-only works 3/3). See
// docs/adr/2026-06-07-submit-via-pty-context-layer.md.
function terminalLevelSubmit(id, session) {
  if (submitViaPty(session)) return 'pty_cr';
  return null;
}
```

`submitViaPty` (daemon.js ~1973-1984) is **unchanged**: wrapped →
`ownerWs.send({type:'inject', data:'\r'})`; spawned → `session.ptyProcess.write('\r')`.
aterm never reaches here (it has no `ptyProcess` and its inject path skips submit
via the ~1267/~1295 guards) — and `submitViaPty` is only called from the submit
flow, which is already aterm-guarded upstream.

---

## Change 2 — Confirmation → PTY-native (daemon.js + src/submit-gate.js)

### 2a. `forceSubmitDeliveredToSurface` → trust `pty_cr` (daemon.js ~1203-1209)

The false-negative for `pty_cr`-on-cmux was the BUG B trigger. With PTY-only
submit, `pty_cr` is the *only* strategy and is the reliable one; honest
confirmation now comes from the PTY-derived `confirmSubmitAccepted` (state +
outputRing), not from the strategy name.

**Before**
```js
function forceSubmitDeliveredToSurface(session, strategy) {
  if (!strategy) return false;
  if (session && session.backend === 'cmux' && session.cmuxWorkspaceId && strategy === 'pty_cr') {
    return false;
  }
  return true;
}
```

**After**
```js
// PTY-native delivery: a successful pty_cr is real delivery on every backend.
// The honest "was it accepted?" signal is the PTY-derived confirm
// (confirmSubmitAccepted: state∈{working,thinking} since≥submittedAt, or body
// consumed from outputRing) — NOT the strategy name. We no longer special-case
// pty_cr-on-cmux as undelivered (that false-negative drove the BUG B bogus
// UNCONFIRMED reports). See docs/adr/2026-06-07-submit-via-pty-context-layer.md.
function forceSubmitDeliveredToSurface(session, strategy) {
  return !!strategy;
}
```

Call site (daemon.js ~2220, the `force` branch): the force path emits a single
bare `\r` with no `injected_body` confirm loop, so trusting a successful
`pty_cr` here is the intended behavior. The `markPendingReportSubmitUnconfirmed`
`'cmux_send_failed'` branch at ~2225 becomes unreachable for a successful
strategy (only `strategy === null` → ~2232 `'strategy_failed'` remains, which is
correct). No edit to the call site is required; the helper change is sufficient.

### 2b. `readCurrentScreen` → drop `cmux read-screen` first-preference (src/submit-gate.js ~311-321)

Confirmation must read the PTY-fed `outputRing`, not shell out to `cmux
read-screen`. `observeBodyVisibility` (~281-309) already falls through to
`session.outputRing` when `readCurrentScreen` returns null/empty — so dropping the
default cmux reader makes `outputRing` the source for wrapped/cmux sessions while
preserving an explicit `opts.readScreen` injection seam for tests.

**Before**
```js
function readCurrentScreen(session, opts = {}) {
  const readScreen = typeof opts.readScreen === 'function'
    ? opts.readScreen
    : (session && session.backend === 'cmux' && session.cmuxWorkspaceId ? defaultReadScreen : null);
  if (!readScreen || !session || !session.cmuxWorkspaceId) return null;
  const tailLines = Number.isFinite(opts.tailLines) ? opts.tailLines : 30;
  try {
    return readScreen(session.cmuxWorkspaceId, tailLines);
  } catch (_err) {
    return null;
  }
}
```

**After**
```js
// PTY-native confirm: do NOT shell to `cmux read-screen` for the submit confirm.
// The body-visibility source is the PTY-fed outputRing (observeBodyVisibility
// falls through to it when this returns null). An explicit opts.readScreen seam
// is still honored (tests / future surface adaptors); the cmux default is
// dropped. See docs/adr/2026-06-07-submit-via-pty-context-layer.md.
function readCurrentScreen(session, opts = {}) {
  const readScreen = typeof opts.readScreen === 'function' ? opts.readScreen : null;
  if (!readScreen || !session) return null;
  const workspaceId = session.cmuxWorkspaceId;
  if (!workspaceId) return null;
  const tailLines = Number.isFinite(opts.tailLines) ? opts.tailLines : 30;
  try {
    return readScreen(workspaceId, tailLines);
  } catch (_err) {
    return null;
  }
}
```

> Note: `awaitPromptSymbol` (Layer-3 *readiness* gate, submit-gate.js ~356) keeps
> its own `defaultReadScreen` — that is a pre-submit readiness probe, a separate
> concern from the post-submit confirm, and is **out of scope** for this change.
> `defaultReadScreen` stays exported/defined.

---

## Change 3 — Gate `TASK_IDLE_UNCONFIRMED` on RELIABLE PTY evidence only (daemon.js fireAutoReport ~242-321)

> **Revised per orchestrator APPROVED condition (2026-06-07).** The original draft
> added `|| hasSubmitEvidence` to the `submitExpected` accept branch. That is
> **rejected**: `hasSubmitEvidence` includes `sawWorkingAfterInject`, which is
> **startup-spinner-polluted** — a never-started worker's startup `working`
> transition would falsely flip `TASK_IDLE_UNCONFIRMED` → `TASK_COMPLETE`,
> reintroducing #537 / BUG B. The accept signal MUST stay reliable-only.

**Problem (live-observed):** the idle→auto-report can fire ~1.0s post-inject,
ahead of submit confirmation, labeling a delivered submit `TASK_IDLE_UNCONFIRMED`
and triggering worker re-send loops. Root cause for the *force* path: before
Change 2a, a `pty_cr`-on-cmux force submit marked the pending report
**UNCONFIRMED** (`forceSubmitDeliveredToSurface` returned `false`), so
`strongSubmitConfirmed` never became true → the label was UNCONFIRMED even though
Enter was delivered.

**Fix = Change 2a, not a weaker accept signal.** With
`forceSubmitDeliveredToSurface → !!strategy` (Change 2a), a successful `pty_cr`
sets `markPendingReportSubmitConfirmed` **at submit time**, so
`strongSubmitConfirmed` registers reliably and the *existing* `confirmed` gate
(which already uses `strongSubmitConfirmed` for the `submitExpected` branch) stops
emitting the false UNCONFIRMED. The wrapped-session auto-report is the
`ready-signal` trigger (`src/transport/websocket.js:169`), which **already defers**
while `submitInProgress === true` (fireAutoReport ~255-280) — so it cannot label
before the gated-path confirm loop registers either.

**Edit — the `confirmed` decision (daemon.js ~310-314): NONE.** The line already
reads exactly what the condition requires — `strongSubmitConfirmed` for the
`submitExpected` branch, with no weak signal:

```js
  const confirmed = trigger === 'ready-signal' && pendingReport.submitExpected
    ? false
    : pendingReport.submitExpected
      ? strongSubmitConfirmed          // reliable-only: pty_cr success → submitConfirmedAt
      : (elapsedNum >= AUTO_REPORT_MIN_REAL_SECONDS || hasSubmitEvidence);
```

So Change 3 is **"do not weaken this line"** (drop the originally-proposed
`|| hasSubmitEvidence`). `strongSubmitConfirmed` already subsumes
*outputRing body-consumed*: `confirmSubmitAccepted` returns `accepted:true` with
`reason:'body_consumed'` → `markPendingReportSubmitConfirmed` → `submitConfirmedAt`.
The `non`-submitExpected legacy branch keeps `hasSubmitEvidence` (unchanged — that
path has no submit to confirm and its semantics are out of scope).

**Net code change for Change 3: zero edits to `daemon.js`.** It is fully delivered
by Change 2a (force path now sets `strongSubmitConfirmed` for `pty_cr`) plus the
existing `ready-signal` `submitInProgress` defer. A **regression test** locks the
contract so no future edit can re-add a weak accept signal (see test plan #5/#8).

**Residual (flagged, NOT in scope):** a wrapped session that spuriously reports
`idle` *during* the gated confirm window would still be `ready-signal`-deferred
(submitInProgress true), so no fix is needed. If post-deploy live data shows a
real-idle leak on spawned/cmux sessions mid-confirm, the follow-up is a
`submitInProgress` dwell on `real-idle`/`silence-timeout` mirroring `ready-signal`
— flagged for the orchestrator, not done here (out of approved scope, Rule 29).

---

## Change 4 — KEEP (no edit)

Text and `\r` stay **separate writes** with the render-gate (daemon.js
~1240-1278; cli.js bridge ~1329-1369 keeps CR un-coalesced). Explicitly **not**
modified. A negative regression test (below) asserts a coalesced `text+\r` does
NOT submit.

## Change 5 — aterm EXCLUDED (no edit)

`type === 'aterm'` keeps its UDS-Inject path and the submit-skip guards (daemon.js
~1267, ~1295). `submitViaPty` is never reached for aterm. A regression test
asserts submit is SKIPPED for aterm.

---

## Test surface additions (daemon.js exports)

`terminalLevelSubmit` and `submitViaPty` are **not currently exported**. Add them
to the test-only `module.exports` (daemon.js ~3519-3529), alongside the existing
`forceSubmitDeliveredToSurface` / `fireAutoReport`. No logic change — internal/test
surface only, matching the existing convention comment.

```js
module.exports = {
  fireAutoReport,
  forceSubmitDeliveredToSurface,
  terminalLevelSubmit,            // pty-only submit path (#544)
  submitViaPty,                   // bare-0x0D PTY submit (#544)
  // …existing…
};
```

---

## Test plan

New file: `test/submit-via-pty.test.js` (node:test), plus assertions folded into
the existing `test/enforce-submit-gate.test.js` where the seam already exists.

1. **pty-only path** — stub a session with `type:'wrapped'`, a fake `ownerWs`
   (`readyState===1`) capturing every `send`. Assert:
   - `terminalLevelSubmit(id, session) === 'pty_cr'`.
   - exactly **one** inject write; its `data` is `'\r'`, `Buffer.from(data)`
     length `1`, byte `=== 0x0D` (and `!== 0x0A`, `!== '\r\n'`).
   - `sendViaKitty` / `submitViaCmux` are **never** invoked (assert via a guard:
     the stub session has no `cmuxWorkspaceId`/kitty window, and we assert no
     `execSync`/`cmux`/`kitty` shell-out — using an injected spy or by asserting
     the single-write count).
   - spawned variant: `type:'pty'` with a fake `ptyProcess.write` spy → single
     `'\r'`, byte `=== 0x0D`.

2. **PTY-native confirm** — `confirmSubmitAccepted(session, body, {getState, ...})`
   on a cmux-backed session (`backend:'cmux', cmuxWorkspaceId:'w1'`) with **no**
   `opts.readScreen`: assert it resolves `accepted:true` via state
   (working/thinking, since≥submittedAt) or `outputRing` body-consumed, and that
   `defaultReadScreen` / `cmux read-screen` is **never** called (spy on
   `child_process.execSync` or assert `visibility.source !== 'screen'`).

3. **`forceSubmitDeliveredToSurface`** — update the existing
   `enforce-submit-gate.test.js` expectations: `pty_cr` on cmux now → `true`
   (was `false`); `null` → `false`; `'pty_cr'` on a non-cmux pty → `true`
   (unchanged). This is the one **intentional** existing-test change (the asserted
   behavior is the BUG B fix).

4. **bracketed-paste guard (negative)** — assert the inject path issues text and
   `\r` as two separate `writeDataToSession`/bridge writes; a coalesced single
   write of `text+'\r'` is asserted NOT to be produced by the delivery path
   (mirrors the existing render-gate intent; reuse the bridge harness in
   `test/bridge-e2e.test.js` if a live PTY is needed, else a unit assert on the
   two-write sequence).

5. **`fireAutoReport` reliable-evidence gate** — with a pending report where
   `submitExpected:true` and `submitConfirmedAt` set (the post-Change-2a state for a
   delivered `pty_cr`), assert `real-idle` fires **TASK_COMPLETE**. Uses the
   existing `fireAutoReport` deps-DI seam (`now`/`deliverInjectionToSession`
   capture).

8. **#537 / BUG B regression (CONDITION-mandated)** — a **never-started worker**:
   `submitExpected:true`, `submitConfirmedAt` **unset**, `submitConfirm.accepted`
   **false/unset** (submit failed → no body-consumed), but `sawWorkingAfterInject:true`
   (startup spinner produced a `working` transition). Assert `fireAutoReport`
   (`real-idle`) emits **`TASK_IDLE_UNCONFIRMED`**, **never** `TASK_COMPLETE`. This
   pins the accept signal to reliable evidence only and guarantees no future
   re-introduction of the weak `sawWorkingAfterInject` OR.

6. **per-backend matrix** — cmux: live-proven (covered by 1+2). warp/tmux: design
   hooks only — a table-driven case asserting `terminalLevelSubmit` returns
   `'pty_cr'` for `backend:'warp'|'tmux'` wrapped sessions (PTY path is
   backend-agnostic), explicitly `log`/comment that surface-level warp/tmux is
   NOT live-validated and `cmux send-key` removal stays gated on it. aterm: assert
   the inject path SKIPS submit (no `\r` write) for `type:'aterm'`.

7. **existing suite** — `npm test` (full ~451) plus the submit subset (61 green
   baseline) → **no new reds**, except the one intentional
   `forceSubmitDeliveredToSurface` expectation flip in #3 (which encodes the fix).

## Verification gate (post-APPROVED)

`node --check daemon.js && node --check src/submit-gate.js && node --check
test/submit-via-pty.test.js` → clean; full `npm test` → no new reds;
`snyk_code_scan` on changed `.js` → 0 newly-introduced; commit small on `main`
(**NO push** — orchestrator lands per Rule 32).
