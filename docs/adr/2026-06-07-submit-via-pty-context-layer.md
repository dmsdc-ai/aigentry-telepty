# ADR 2026-06-07 — Telepty submit via the PTY/context layer (drop `cmux send-key` from the submit path)

- **Status:** Accepted (orchestrator-approved 2026-06-07, user-approved, with the
  reliable-evidence condition on Decision 3 folded in) — **Decisions 1/2/4/5 still hold;
  Decision 3 is SUPERSEDED by #60 Stage A**, which deleted `TASK_IDLE_UNCONFIRMED`,
  `TASK_COMPLETE` and every other terminal label rather than gating them. The daemon now emits
  one `task_completion_unknown` observation and asserts no task outcome
  (`src/completion-observation.js`; `CHANGELOG.md` → *Unreleased* → "BREAKING: telepty no longer
  asserts task completion (#60 Stage A)"). Decision 3's premise — that a *reliable* signal could
  license the label — is the premise Stage A rejects. The record below is unchanged.
- **Date:** 2026-06-07
- **Repo:** `aigentry-telepty` (branch `main`)
- **Tasks:** #544 (submit-race), #537 / "BUG B" (bogus `TASK_IDLE_UNCONFIRMED` reports)
- **Author role:** coder (`submit-pty-coder`)
- **Implementation spec:** `docs/superpowers/specs/2026-06-07-submit-via-pty-context-layer.md`

## Context

Telepty injects a prompt into a wrapped/spawned CLI in two writes: the **text**
(mailbox payload) and the **submit Enter** (a bare `\r`), kept separate so the
`\r` lands *outside* the terminal's bracketed-paste window (a coalesced `text+\r`
is read as a literal newline, not a submit — see daemon.js ~1240-1278).

The submit Enter is currently delivered through a 3-strategy chain in
`terminalLevelSubmit` (daemon.js ~1188-1196):

1. **P1 `sendViaKitty`** — kitty `@ send-text` (a *terminal-surface* op).
2. **P2 `submitViaCmux`** — `cmux send-key --workspace … return` (a *surface* op).
3. **P3 `submitViaPty`** — bare `0x0D` written into the CLI's innermost node-pty
   (wrapped → `ownerWs {type:'inject', data:'\r'}` → bridge `child.write('\r')`;
   spawned → `ptyProcess.write('\r')`).

This conflates two domains. Per the orchestrator's **2026-05-30 surface-ownership
ADR**, the SESSION/SURFACE domain (windows, panes, `send-key`, `read-screen`)
belongs to the cmux/terminal **adaptor**; the CONTEXT domain (the injected TEXT
**and** the submit Enter) belongs to **telepty**. Telepty reaching into
`cmux send-key` / kitty `send-text` to deliver Enter is telepty doing the
adaptor's job through a flaky side channel.

### Evidence (why PTY-only is correct *and* safe)

- **Telepty already submits via PTY** (`submitViaPty`) — it just *distrusts* it,
  falling back to it only after P1/P2, and then
  `forceSubmitDeliveredToSurface` (daemon.js ~1203-1209) marks a `pty_cr`-on-cmux
  result as **not delivered** (returns `false`), which is the direct cause of the
  bogus "undelivered/UNCONFIRMED" reports in BUG B.
- **Production run (222k-line log):** `cmux send-key` failed **75×**
  ("Failed to write to socket" on fresh workspaces); `pty_cr` failed **0×**
  ("Submit failed via all strategies" = 0). `[KITTY] Sent` appeared **0×** in the
  whole log — P1 never fired in practice.
- **Live controlled test (2026-06-07, daemon 0.5.4):** a probe whose
  `cmux send-key` FAILED still received the prompt, executed, and reported via
  `pty_cr` — 3/3 inject cycles. **PTY-only submit works end-to-end.**

So `cmux send-key` is the *flaky* path and `pty_cr` (bare `0x0D` to the PTY) is
the *reliable* one. The chain is inverted relative to reliability.

### Why bare `0x0D` is the correct byte

Ink maps `\r` → `'return'` (SUBMIT) and `\n` → `'enter'` (newline). The kitty
keyboard protocol **exempts plain Enter** (it stays `0x0D`). A raw-mode PTY does
**no** CR→LF translation. So the submit must be exactly `0x0D` — never `0x0A`,
never `\r\n`. (`tmux send-keys Enter` is itself a `0x0D` PTY write, confirming the
equivalence.)

## Decision

1. **Collapse `terminalLevelSubmit` to a single PTY path** for all wrapped/spawned
   backends: try `submitViaPty`; return `'pty_cr'` on success, `null` on failure.
   Drop the P1 (kitty `send-text`) and P2 (`submitViaCmux`) branches from the
   submit path.

2. **Switch the force-submit confirmation to PTY-native.** Replace the cmux-only
   `forceSubmitDeliveredToSurface` false-negative with the PTY-derived confirm
   telepty already computes in `confirmSubmitAccepted` (src/submit-gate.js
   ~190-261): (a) `isAcceptedSubmitState` — sessionStateManager state ∈
   {working, thinking} with `since ≥ submittedAt`, fed from PTY output
   (screen-free); (b) `observeBodyVisibility` — body consumed via
   `session.outputRing`. In `readCurrentScreen` (submit-gate.js ~311-321) drop the
   `cmux read-screen` first-preference so the confirm source is `outputRing`, not a
   shell-out to cmux.

3. **Keep the `TASK_IDLE_UNCONFIRMED` accept gate on RELIABLE PTY evidence only.**
   The eager false-UNCONFIRMED (fired ~1.0s post-inject, ahead of confirmation) is
   caused by the force path marking a delivered `pty_cr` as undelivered — which
   Decision 2 fixes directly: a successful `pty_cr` now sets
   `strongSubmitConfirmed` at submit time, so the *existing* auto-report gate
   (already `strongSubmitConfirmed` for submit-expecting reports) stops emitting the
   false label. **Per the orchestrator's APPROVED condition (2026-06-07): the accept
   signal MUST NOT include `sawWorkingAfterInject`** — it is startup-spinner-polluted
   and #537/BUG B explicitly excluded it (a never-started worker's startup `working`
   transition would falsely become `TASK_COMPLETE`). The fix is reliable evidence
   (`strongSubmitConfirmed`, which subsumes outputRing body-consumed), not a weaker
   accept signal. A regression test locks a never-started worker to
   `TASK_IDLE_UNCONFIRMED`.

4. **KEEP** text and `\r` as **separate writes** with the render-gate (daemon.js
   ~1240-1278). Do **not** collapse them — a coalesced `\r` lands inside the
   bracketed-paste window = literal newline, not submit.

5. **EXCLUDE aterm.** `type === 'aterm'` uses UDS Inject and intentionally skips
   submit (daemon.js guards ~1267, ~1295). Never route `\r` there; aterm is left
   untouched.

### Scope guard on `cmux send-key` removal (Rule 29)

`submitViaCmux` is **removed only from the submit path** (`terminalLevelSubmit`).
The function definition (daemon.js ~2105-2119) and any non-submit callers
(`submit-all`, manual `telepty send-key`) **stay** until the per-backend
regression matrix (warp/tmux) proves PTY-only there too. The dead-from-submit
branch is flagged, not deleted (separate cleanup task). `sendViaKitty` likewise
stays defined (used for text delivery elsewhere); only its submit branch is
dropped.

## Consequences

**Positive**
- Submit no longer fails when `cmux send-key` can't reach a fresh workspace
  socket — the 75× failure mode is eliminated for the proven backend (cmux).
- `pty_cr`-on-cmux stops being mislabeled "undelivered"; BUG B bogus
  `TASK_IDLE_UNCONFIRMED` reports and the worker re-send loops they trigger go
  away.
- Domain boundary is restored: telepty owns context+submit; the adaptor owns the
  surface (aligns with the 2026-05-30 surface-ownership ADR).
- One submit path → simpler, screen-free confirmation; no shelling to `cmux`
  per submit.

**Negative / Risks**
- **Bracketed-paste regression** — if the text/`\r` separation or render-gate is
  weakened, the `\r` coalesces and submits a literal newline. *Mitigation:* keep
  the two writes separate (decision #4); add a negative regression test asserting
  coalesced `text+\r` does NOT submit.
- **Cold-REPL timing** — PTY `\r` written before the REPL consumes the text is a
  no-op submit. *Mitigation:* unchanged — the existing render-gate + readiness
  gate + bounded confirm-retry already cover this; confirm now reads `outputRing`
  state instead of cmux screen.
- **Warp/tmux unexercised** — only cmux is live-proven. *Mitigation:* PTY-only is
  applied universally (it is the existing P3 for all backends), but
  `cmux send-key` removal from the codebase is gated on the warp/tmux matrix;
  design hooks for those backends are added to the test plan, not asserted green.

## Alternatives considered

- **Keep the 3-strategy chain, only fix the confirm.** Rejected: leaves the flaky
  `cmux send-key` as P2 ahead of the reliable PTY path, so the 75× failure mode and
  domain-boundary violation persist. This is Rule 27 (no workaround) — the root fix
  is to stop using the surface op for a context operation.
- **Make `forceSubmitDeliveredToSurface` trust `pty_cr` on cmux without the
  PTY-native confirm.** Rejected: that would blindly trust submit with no
  evidence, re-opening the open-loop that #537 closed. The PTY-native confirm
  (state + outputRing) preserves honest confirmation without the cmux dependency.

## Test plan (codifies the validation)

See the implementation spec for exact assertions. Summary:
- **pty-only submit unit test:** with kitty/cmux stubbed unavailable,
  `terminalLevelSubmit` returns `'pty_cr'` and writes a **single** byte `=== 0x0D`
  (not `0x0A`, not `\r\n`) as a **separate** write from the text; confirm passes via
  state/`outputRing` with **no** `cmux read-screen` call.
- **bracketed-paste guard:** text and `\r` are two writes; negative (coalesced)
  test does **not** submit.
- **per-backend matrix:** cmux (live-proven) + design hooks for warp/tmux; aterm
  asserts submit **SKIPPED**.
- **existing suite:** no new reds (current submit suite 61 green; full suite
  ~451).
