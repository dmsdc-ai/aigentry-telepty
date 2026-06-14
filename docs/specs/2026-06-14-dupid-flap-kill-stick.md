# Spec — telepty#56: duplicate-`--id` owner flap loop + `kill --force` doesn't stick

- **Date:** 2026-06-14
- **Status:** SPEC FIRST (Rule 24) — **awaiting orchestrator approval; NO impl past the HOLD (§13)**
- **Author:** coder (`tp56-tp56-coder`)
- **Worktree:** `/private/tmp/wt-tp56`, branch `wt/56-dupid-flap`, base `36f399a` (0.6.5). NO push — orchestrator lands.
- **Issue:** telepty#56 (observed 0.6.5 Windows/Warp; mechanism is platform-agnostic).
- **Upstream link:** telepty-side ROOT of orchestrator #618 (stale duplicate `--id orchestrator` bridge captured all inject routing). Daemon-side deterministic counterpart to the already-shipped mitigation `bin/orchestrator-boot.sh` (#539 singleton-at-boot) + reconcile detect-warn (#620).

---

## 1. Problem

Two coupled defects make a wrapped session both **undeliverable-to** and **un-killable** when a
second wrap-owner attaches to a live session id (e.g. a duplicate `telepty allow --id <X>`).

1. **Duplicate-`--id` owner flap loop.** Two wrap-owner bridges on one id oscillate forever; the
   session never stays `ready for inject` and **injects are silently dropped**. Daemon log loops
   `Replacing stale ownerWs` / `Wrap owner re-connected (Total: 2)` / `Client detached (Total: 1)`.
2. **`kill --force` doesn't stick.** `telepty kill <X> --force` prints `killed`, but a surviving
   wrap-owner process re-registers a fresh session record; `telepty list` still shows it.

---

## 2. Reproduce (Phase 2 — DONE, deterministic, hermetic)

A throwaway harness (`test-support/daemon-harness.js`, `PORT=0`, two mock owner WS with `?owner=1`,
each reconnecting on any non-`1000` close — exactly mimicking the `cli.js` bridge reconnect policy)
produced, against **current 0.6.5 code**:

```
displaced-owner close = {"code":1006,"reason":""}
flap over ~1.5s: "Replacing stale ownerWs" x 65 | owner (re)connects x 66
```

**Structural proof of root cause:** the displaced owner receives close **`1006`** (abnormal,
from `ownerWs.terminate()` at `src/transport/websocket.js:108`) with an empty reason — **not** the
terminal `1000 'Session destroyed'` signal. The bridge's close handler
(`cli.js:1879-1893`, `isDaemonDestroyClose`) treats only `1000 'Session destroyed'` as terminal;
**`1006` → `scheduleReconnect()`**. So the displaced bridge reconnects with `?owner=1`, reclaims,
terminates the incumbent, and the incumbent does the same → unbounded oscillation (65 replacements
in 1.5s). **Injects-dropped is the corollary:** the HTTP inject path delivers to
`session.ownerWs` (`daemon.js:1678-1681`); during the flap that socket is a soon-`terminate()`d
connection or `null` between claims, so the frame is lost.

---

## 3. Root cause (single, shared by both defects)

> **The daemon can sever a wrap-owner's WebSocket, but has no deterministic way to tell that
> owner's PROCESS to stop and stay stopped — except `1000 'Session destroyed'`, which is sent
> only to the *current* ownerWs AND also destroys the session record (so it cannot be reused for a
> REPLACE, where the record must survive under the new owner).**

- Defect #1: WS-layer REPLACE already exists (`terminate()` the prior ownerWs, `websocket.js:103-110`)
  but is **not durable** — `terminate()` = `1006` = "transient, reconnect" to the displaced bridge.
- Defect #2: in the dup-owner state, `kill --force` tears down the record + the *current* ownerWs,
  but the *other* (displaced, mid-reconnect) bridge is not the current ownerWs, never receives the
  `1000` close, and re-registers — **a direct consequence of #1.** Single-owner `kill --force`
  already sticks today (the lone bridge obeys the `1000` close and exits; `teardownSessionById` also
  `SIGKILL`s `ownerPid` via `lifecycle.killSessionProcess`).

---

## 4. Decision A — Owner policy: **(P) Replace-deterministically (last-writer-wins)** — RECOMMENDED

**Reject (R) Reject-2nd.** It fights the existing design (the codebase already chose REPLACE) and
**breaks `orchestrator-boot.sh`'s REPLACE intent**: boot does kill-9-stale-then-`exec` (a deliberate
takeover). If the kill-9 races and the stale bridge's WS is briefly still open, (R) would bounce the
*legitimate* new owner. (P) is the only policy compatible with that mitigation.

**Adopt (P), made durable.** When a new `?owner=1` connect displaces a live ownerWs, replace the
bare `terminate()` (→ `1006` → reconnect) with a **graceful terminal close that means "you have been
replaced — exit, do NOT reconnect," while the session RECORD survives under the new owner**:

- Daemon side (`websocket.js`): on displacement, `oldOwnerWs.close(<CODE>, 'Owner replaced')`
  (then a short fallback `terminate()` only if it doesn't close — belt). Session record, clients,
  ready-state, and the *new* owner are untouched. Fresh `ownerToken` is already minted on the new
  claim (`websocket.js:116`).
- Bridge side (`cli.js`): extend the terminal-close test so `'Owner replaced'` joins
  `'Session destroyed'` as a no-reconnect, clean-exit reason → `closeAllowSession()` + exit.
- **No shared-fate cascade.** The displaced bridge's teardown `DELETE` carries its now-**stale**
  `ownerToken`; the existing #536 guard (`daemon.js:3543-3548`: token-mismatch + live ownerWs →
  `stale-detached` no-op) already suppresses it. (Belt: have the `'Owner replaced'` exit skip the
  `DELETE` entirely.)

**Result:** Total deterministically settles at **1**; the session stays `ready for inject`; no
oscillation; no inject drop. Compatible with `orchestrator-boot.sh` REPLACE and #536 `owner_token`.

**Open choice (close code):** WebSocket app codes must be `1000` or `3000–4999`. Two options:

- **A1 — `1000` + reason `'Owner replaced'`** (reason-string discriminator, mirrors the existing
  `'Session destroyed'` convention). Simplest, consistent with current code. **Recommended.**
- **A2 — a dedicated app code** (e.g. `4001`) + reason. More explicit, but adds a new constant and a
  second discriminator dimension for no functional gain over A1.

---

## 5. Decision B — kill-stick mechanism (cross-platform)

Two layers, both reuse existing infrastructure (no new deps — Article 17):

1. **Primary (falls out of §4):** with durable REPLACE, **no displaced duplicate survives** to
   re-register after a kill. This removes the *actual observed* #2 mechanism. The lone legitimate
   owner already obeys the `1000 'Session destroyed'` close and exits.
2. **Belt — PID-kill, harden existing path:** `teardownSessionById --force` already
   `SIGKILL`s the owner via `lifecycle.killSessionProcess` →
   `getSessionPid` (includes `ownerPid`) → cross-platform `sendSignal` (POSIX `process.kill`;
   Windows `taskkill /T /F` via `src/win-kill-process.js`). **Gap:** `ownerPid` is only populated by
   the register-POST (`applyProcessMetadata`), which the bridge sends **only on reconnect**
   (`cli.js:1786 if (reconnectAttempts > 0)`) — so a first-connect owner can have `ownerPid === null`
   → `killSessionProcess` returns `NO_PROCESS` and the process is not signalled.
   **Fix:** capture the owner PID **at owner-claim time** — bridge passes `owner_pid=<pid>` on the
   `?owner=1` WS URL (`cli.js`), daemon stores it on claim (`websocket.js`, next to the
   `ownerToken` mint). Then `kill --force` always has a PID to `SIGKILL`, independent of register
   timing or platform.

**Resurrection guard — considered & deferred (Article 1 lightweight).** The WS auto-register path
(`websocket.js:60-93`) lets *any* reconnecting bridge re-create a deleted session. A short post-kill
**tombstone** would harden this, but with §4 there is no surviving bridge to resurrect, and the lone
owner exits on the `1000` close. We therefore **do not** add a tombstone now; flagged here so the
reviewer can require it if the post-approval TDD shows a residual resurrection race.

---

## 6. Scope / invariants

- **Surgical (Rule 29):** edits confined to `src/transport/websocket.js` (displace close),
  `cli.js` (terminal-close test + `owner_pid` on owner URL). `lifecycle.js` / `win-kill-process.js`
  already do PID-kill — no change unless TDD proves a gap.
- **Back-compat:** single-owner (normal) path unchanged — first owner with no incumbent still just
  claims; the displace branch only fires when an incumbent ownerWs is live.
- **Cross-platform:** WS close semantics + PID-kill helper are platform-agnostic (Windows path via
  existing `taskkill`).
- **No workaround (Rule 27):** the fix is a deterministic policy (terminal "replaced" signal), not
  oscillation-suppression/debouncing.
- **Hermetic only:** never touch live daemon 98164; `PORT=0` + mock WS only.

---

## 7. Post-approval plan (TDD — only after orchestrator approves)

1. Failing test — **flap:** two `?owner=1` reconnecting mock owners on one id → assert displaced owner
   receives terminal `close('Owner replaced')` (no `1006`), `Replacing stale ownerWs` count ≤ 1, and
   an inject mid-claim is delivered to the surviving owner (no drop).
2. Failing test — **kill-stick:** dup-owner state → `kill --force` → assert no re-register, record
   gone, and (belt) `ownerPid` was captured at claim so `SIGKILL` is issued.
3. Implement §4 + §5 belt. Green.
4. Full suite + #536 / #548 / #617 / #619 regression GREEN.
5. **Skill-doc no-drift:** update `skills/telepty-allow/SKILL.md` (dup-id + kill-sticks behavior) and
   `skills/telepty/SKILL.md` if it documents allow/kill — part of THIS change set.
6. Snyk `snyk_code_scan` (JS change) → 0-new. Commit (no push). REPORT `--ref`.

---

## 8. HOLD — questions for the orchestrator

1. **Approve owner policy (P) Replace-deterministically** over (R) Reject-2nd? (Recommended: P — only
   policy compatible with `orchestrator-boot.sh` kill-9-then-exec REPLACE.)
2. **Close-code A1 (`1000` + `'Owner replaced'` reason) vs A2 (dedicated `4001` code)?**
   (Recommended: A1, mirrors existing `'Session destroyed'` convention.)
3. **Tombstone resurrection-guard:** accept deferral (Article 1), or require it now?
4. Any compat concern with #536 `owner_token` / `orchestrator-boot.sh` I've missed?
