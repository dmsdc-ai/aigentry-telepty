# #737 — codex update modal swallows the first inject

**Phase: FIXED (A+C approved, C shipped first). §§1–5 are the repro/diagnosis as
written at HOLD time and are left unedited; §7 is the fix and its verification.**

Branch `fix/737-update-modal-repro`. Measured 2026-07-26 against real codex-cli 0.144.1
on darwin 25.4.0, and against the real telepty daemon at `1425eee` (0.6.17).

---

## TL;DR

Reproduced deterministically — and the real signature is **worse than reported**.

A codex whose `$CODEX_HOME/version.json` has `dismissed_version` < `latest_version` boots
into a blocking modal whose **pre-selected** item is
`1. Update now (runs \`brew upgrade --cask codex\`)`.

telepty writes codex injects as a **bracketed-paste** body followed by a **separate bare
CR** (that is #716/#730's fix, and it is correct for a composer). Against this modal:

- the paste envelope moves **no** selection — the modal ignores it and the body vanishes;
- the following CR therefore **activates the default item**, so codex shell-executes
  `brew upgrade --cask codex` and **exits** with *"Update ran successfully! Please restart
  Codex."*

So the first inject is not merely lost: **the session dies and an unattended package
upgrade runs on the host.** 3/3 wrapped runs, no flake.

All three inject paths do this — `--submit-force`, gated `--submit`, and plain `inject`.
The `codex_modal_ui` detection the brief credits with protecting the non-force paths does
**not** protect them; on the delivery path it is effectively decorative (§3).

> Harness safety: `PATH` is prefixed with a stub `brew` that logs the invocation and exits 0,
> so the exec is *recorded*, never *performed*. The operator's real codex was never upgraded.
> Isolated `CODEX_HOME`, own tmux socket (`-L c737`), harness daemon on `PORT=0`.

---

## 1. Reproduction

`scratchpad/repro-737-tmux.js` — real codex under an isolated `CODEX_HOME`, tmux
`capture-pane` as the VT (regex ANSI-stripping was proven untrustworthy for codex
composers in #730), model provider pointed at a dead loopback port with retries disabled
so any turn that starts dies instantly on connection-refused (zero API cost).

```
node scratchpad/repro-737-tmux.js <tag>       # env: MODAL=1|0 PATHSHAPE=force|plain|gated WRAP=1|0
```

Boot screen with `dismissed_version=0.140.0 < latest_version=0.145.0`:

```
  ✨ Update available! 0.144.1 -> 0.145.0

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs `brew upgrade --cask codex`)
  2. Skip
  3. Skip until next version

  Press enter to continue
```

Note the `›` cursor: **option 1 is pre-selected**.

### Matrix

| tag | modal | body envelope | text→CR | body reached composer | CR outcome | codex survives |
|---|---|---|---|---|---|---|
| `modal-force` | yes | bracketed | 19ms | **no** — absorbed | activates **option 1** → `brew upgrade` | **no, exits** |
| `modal-plain` | yes | bracketed | 515ms | **no** — absorbed | activates **option 1** → `brew upgrade` | **no, exits** |
| `modal-gated` | yes | bracketed | 1523ms | **no** — absorbed | activates **option 1** → `brew upgrade` | **no, exits** |
| `modal-force-report` | yes | bracketed (3-line REPORT blob) | 18ms | **no** — absorbed | activates **option 1** → `brew upgrade` | **no, exits** |
| `modal-force-nowrap` | yes | raw | 18ms | **no** — eaten as keystrokes | selects a *Skip* item, modal dismissed | yes |
| `ctl-nomodal-force` | **no** | bracketed | 17ms | **yes, submitted** | normal submit | yes |

Raw artifacts: `/tmp/c737-work/<tag>.{verdict.json,screens.txt,log}`, brew-exec ledger at
`/tmp/c737-work/brew-invocations.log`.

### The exact loss signature (`modal-force`)

```json
{"modalAtBoot":true,"bodyVisibleAfterText":false,"bodyVisibleAfterCr":false,
 "composerAfterCr":"","modalStillShowing":false,"messageLost":true,
 "brewInvocations":["2026-07-26T00:43:34Z brew upgrade --cask codex"],"codexExited":true}
```

post-CR screen:

```
Updating Codex via `brew upgrade --cask codex`...
c737 stub brew: refused to run 'upgrade --cask codex'

🎉 Update ran successfully! Please restart Codex.
```

### Why the timing knob does not matter

#730's swallow was a *paste-burst race* — it decayed as the text→CR gap grew. #737 does
not: 19ms, 515ms and 1523ms are identical. The modal is a **state**, not a race window.
`TELEPTY_FORCE_CR_GAP_MS` (the #730 mitigation) cannot help here.

### Why the envelope inverts the damage

`raw` body → the modal reads the characters as **keystrokes**; a digit in the payload
lands on a *Skip* item, so the CR dismisses harmlessly and codex reaches the composer
(message still lost). `bracketed` body → the modal consumes the paste and moves **nothing**,
leaving the default `1. Update now` selected, which the CR then fires. Since #730 made the
envelope **identity-based** for codex (`PASTE_CAPABLE_CLIS`, `src/prompt-symbol-registry.js:163`),
**every** production codex inject is the destructive shape.

---

## 2. This is the historical "one codex needed a manual Enter first" report

Confirmed as the same defect, with a correction: the historical workaround only *looks*
like it worked. A manual Enter also lands on `1. Update now` and takes codex down the same
brew-and-exit path; what operators then saw as "behaved afterwards" was a **restarted**
codex whose `version.json` had been rewritten, so the modal no longer appeared. The first
message was gone in every case.

---

## 3. Bypass map — where `codex_modal_ui` is detected and who consults it

**Detection** — `src/prompt-symbol-registry.js:59-66`
`ENTRIES.codex.detect()` step 1 returns `{ found:false, reason:'codex_modal_ui' }` for
`Press enter to continue` (also resume-picker / trust-prompt). This works, and works on
**raw PTY bytes** — no cmux screen primitive required (pinned by an anchor test).

**The only production consumer of `detect()`** — `src/submit-gate.js:746`, inside
`awaitPromptSymbol`. (`cli.js:1780 observePromptReady` is the legacy `telepty bridge`
path and does not gate daemon delivery.)

`awaitPromptSymbol` has two callers, and neither turns the reason into a delivery decision:

| # | caller | guard | what the modal actually causes |
|---|---|---|---|
| 1 | `daemon.js:1506` bootstrap prompt poll | `daemon.js:1504`: **cmux only** | cmux: polls until `BOOTSTRAP_READY_TIMEOUT_MS`, returns `no_prompt_symbol_seen` → `failBootstrapQueueOnTimeout` (`daemon.js:1448`) errors the queued ops. Loud, not lost — but only ever reached on cmux. |
| 2 | `daemon.js:3180` Layer 3 render gate, gated `/submit` | none, but see below | **advisory only**: `daemon.js:3189-3190` logs "falling through to Layer 1" and submits anyway. Never blocks. |

**Four independent bypasses, in the order they bite:**

1. **Non-cmux hard skip** — `src/submit-gate.js:733-735` returns `no_screen_primitive` at
   0ms whenever `session.backend !== 'cmux'`. Every telepty `wrapped` session — the
   orchestrator dispatch shape — is non-cmux, so detection **never runs at all**. This is
   the widest bypass, and it is on the *gated* path too, not just force.
2. **Force skips both gates** — `daemon.js:3043` excludes force from the bootstrap gate
   (`!force && …`), and the force block at `daemon.js:3079-3129` **returns at 3117** before
   Layer 3 at `daemon.js:3180` is ever reached. Force therefore touches no prompt-symbol
   code on any backend.
3. **Layer 3 is advisory** — even on cmux + gated, `daemon.js:3189` treats a miss as
   "fall through", so a detected modal still gets a CR.
4. **Text delivery never asks** — `deliverInjectionToSession` (`daemon.js:1944-2068`)
   consults only the bootstrap-ready *boolean*; it has no prompt-symbol call on any path.
   `bootstrapReady` is routinely flipped by the **timer-based** optimistic floor
   (`daemon.js:1536-1541`, reason `owner_alive`) which never looks at the screen — so a
   session parked in the modal is marked ready and injectable.

### Product-level proof

`scratchpad/e2e-737.js` — harness daemon (`PORT=0`, isolated `HOME`; production 3848
untouched), recording owner-WS bridge relaying the captured modal boot screen, driven by
the **real CLI**:

| variant | cli | `registry.detectOutput` verdict | body written | CR written |
|---|---|---|---|---|
| force | `inject --submit --submit-force` | `codex_modal_ui` | yes | yes, +4ms |
| gated | `inject --submit` | `codex_modal_ui` | yes | yes, +7ms |
| plain | `inject` | `codex_modal_ui` | yes | yes, +525ms |
| control | `inject --submit --submit-force` | `codex_multi_signal` | yes | yes, +10ms |

The daemon's own matcher says *not ready* and the daemon delivers anyway — on **all three**
paths. The gated path's 7ms shows the render gate contributing exactly nothing here.

Worst combination, for completeness: cmux + modal + `--submit-force` → the **text** queues
behind the bootstrap gate while the **CR** force-bypasses it, so the bare CR fires option 1
alone and the queued text dies with the session.

---

## 4. RED test

`test/codex-modal-first-inject-737.test.js` — **unregistered** (not in package.json).

```
node --test test/codex-modal-first-inject-737.test.js
# 3 anchors pass, 5 RED fail
```

- **anchors (green, must never regress):** the captured modal screen classifies as
  `codex_modal_ui`; the composer control classifies ready; **the modal is detectable from
  raw PTY bytes** — this is what makes a backend-agnostic fix possible.
- **RED:** a session-level `isSurfaceBlockedByModal(session)` predicate exists and is true
  for a *wrapped, non-cmux* session whose outputRing holds the modal; and
  `modalDeliveryDecision(session, {force})` resolves to something other than `deliver` for
  force / gated / plain, while still resolving to `deliver` for a composer surface.
- **remedy is parameterized**, not decided: any of `hold` | `dismiss` | `reject` passes.
  `TELEPTY_MODAL_REMEDY=<one>` narrows it once the HOLD decision lands. Seam names mirror
  `isBootstrapGatedSession`/`isBootstrapReady`; rename freely, the contract is "not lost".

---

## 5. Fix-direction options, ranked

Shared prerequisite for **all** of them: a surface-state read that works on the **PTY
outputRing**, not on `cmux read-screen`. The detection already supports it (anchor 3); the
plumbing does not exist. Without this, any fix protects only cmux sessions and leaves the
production wrapped-session dispatch broken.

### A — Hold-and-retry at the shared delivery seam (recommended)

`deliverInjectionToSession` + the `/submit` force block both consult one predicate over the
outputRing tail. Modal showing → park the body in the mailbox (it is already mailbox-backed)
and re-arm on the next output chunk that clears the modal; deliver body + CR then.

- *for*: fixes all three paths at once because it sits where they converge; reuses the
  existing mailbox + `scheduleQueuedRedeliver` machinery (`daemon.js:3109`); nothing is ever
  written into the modal, so the brew-exec disappears as a side effect; the operator's
  dispatch eventually lands instead of erroring.
- *against*: needs a bound (the modal never clears by itself — it needs an Enter or a
  human), so it degrades to option C on timeout. Adds latency only on the modal path.
- *blast radius*: **the force path is production orchestrator dispatch — every dispatch
  routes through it.** The predicate must be false for every non-modal surface, or every
  dispatch stalls. Mitigation: the decision is a pure function over the ring tail, unit-
  testable (RED seam 2 already pins `deliver` for the composer control).

### B — Dismiss-then-redeliver

Detect the modal, send the dismissing keystroke, wait for the composer, then deliver.

- *for*: fully automatic; the message lands on the first inject with no operator action.
- *against*: **requires knowing which key is safe**, and for this modal the default is
  `1. Update now` → a bare Enter runs `brew upgrade` and exits codex (measured, §1). A
  correct dismissal must first move the selection (`2`/`3`, or arrow-down) — i.e. telepty
  would be *driving codex's update UI*, coupling us to per-version modal layouts. The
  registry's `codex_modal_ui` reason covers three different modals (resume picker, trust
  prompt, update) whose safe keys differ. High coupling, high regression surface.
- *verdict*: reject as the primary remedy. Possible later opt-in, never a default.

### C — Reject with an actionable error

Modal detected → `/inject` and `/submit` fail with a specific reason + hint ("target codex
is showing its update modal; dismiss it or run `codex --version` to clear"), like
`failBootstrapQueueOnTimeout` already does (`daemon.js:1454`).

- *for*: smallest diff, zero new state machine, no risk of stalling dispatch, and the
  orchestrator learns immediately instead of waiting on a session that is about to die.
- *against*: the operator must intervene; a fire-and-forget dispatch still does not land.
- *verdict*: strong on its own, and it is the natural timeout branch of A. **A + C is the
  smallest complete answer.**

### D — Prevent the modal instead of handling it

At session spawn for a codex command, ensure `$CODEX_HOME/version.json` has
`dismissed_version >= latest_version`.

- *for*: trivial; removes the failure class entirely for telepty-spawned sessions.
- *against*: telepty writing into another tool's config is a boundary violation
  (Article 17 / Rule 29 in spirit), racy against codex's own writer, and does nothing for
  sessions telepty attached to rather than spawned. Also silently suppresses a real update
  notice the operator may want.
- *verdict*: reject as a fix. Worth one line in the runbook as an operator workaround.

### E — Make Layer 3 blocking / extend it to non-cmux

Change `daemon.js:3189` from "fall through" to "fail", and drop the `backend !== 'cmux'`
skip in `src/submit-gate.js:733`.

- *for*: reuses the existing gate; no new seam.
- *against*: `no_prompt_symbol_seen` is a *timeout*, not a *modal* — making it blocking
  turns every slow/unrecognised surface into a hard failure across all CLIs. The blast
  radius is the entire submit path for claude and gemini too, for a codex-specific bug.
  And it still misses the force path (bypass #2) and the text-delivery path (bypass #4).
- *verdict*: reject. The distinction that matters is "detected modal" vs "saw nothing",
  and Layer 3 currently collapses both into one reason.

**Recommendation: A with C as its timeout branch, on a PTY-outputRing predicate shared by
`deliverInjectionToSession` and the force block.** Ship the predicate + the reject branch
first (small, safe, immediately stops the brew-exec-and-die), then add the hold/redeliver.

---

## 6. Scope / hygiene

- No product file modified. Only additions: `scratchpad/repro-737-tmux.js`,
  `scratchpad/e2e-737.js`, `scratchpad/EVIDENCE-737.md`, `test/codex-modal-first-inject-737.test.js`
  (unregistered).
- Never touched: production daemon (3848 / launchd), the `orchestrator` session, the real
  `~/.codex` (read-only copy of `auth.json` into the isolated home), the default tmux
  server (own socket `-L c737`). Every codex/daemon/tmux process spawned here was killed.
- Snyk: `snyk_code_scan` over `scratchpad/` and the new test — **0 findings in the files
  this branch adds**. No product code was generated; neither harness opens a listening
  socket (#730's stub provider is not needed here, since #737 fires before a turn can
  begin), and `repro-737-tmux.js` reuses #730's hardened `safeOutPath` tag sanitiser.
  The scan does report 8 **pre-existing** issues inherited from `main`, all in #730's
  harness — 1× Medium CWE-319 (`scratchpad/repro-730-tmux.js:71`, the accepted loopback
  stub-provider note) and 7× Low CWE-23 (`scratchpad/probe-codex.js`, unsanitised argv
  into `fs.write*`). Reported, not touched — Rule 29, separate cleanup task.
- Known sandbox quirk honoured: `require('../daemon')` arms persisted-session poll timers,
  so every node run here is timeout-wrapped.

---

## 7. The fix (2026-07-26, A+C approved — C shipped first)

Two commits, in the approved order: `71a1fc6` (C: predicate + refusal) then `6e8e208`
(A: hold, with C as its timeout branch).

### 7.1 Why the existing detector could not simply be reused

`detect()` answers *"is this screen ready?"* about a cmux `read-screen` **snapshot**, where
step 1's modal anti-pattern is exactly right — a dismissed modal is no longer on the screen.
The delivery path has no screen primitive, only the PTY `outputRing`: an **append-only byte
stream** in which the boot modal stays present for the whole session.

Measured on a real codex ring (`scratchpad/probe-737-ring.js`), `detectOutput()` over the
ring after the modal was dismissed and a message submitted:

| tail window | 2k | 8k | 32k | full |
|---|---|---|---|---|
| stage 1 — modal up | `codex_modal_ui` | `codex_modal_ui` | `codex_modal_ui` | `codex_modal_ui` |
| stage 2 — dismissed, composer live | not-found | **`codex_modal_ui`** | **`codex_modal_ui`** | **`codex_modal_ui`** |
| stage 3 — after a real submit | not-found | READY | **`codex_modal_ui`** | **`codex_modal_ui`** |

A presence-based predicate would therefore have parked **every** dispatch, forever, on any
codex session that ever showed the modal — the exact blast-radius failure flagged at HOLD.

**A per-chunk latch was tried and rejected** (`scratchpad/probe-737-latch.js`), mirroring the
`ESC[?2004h`/`?2004l` shape `appendToOutputRing` already uses: it arms correctly but never
clears, because only **1 of 74** chunks carries any signal — codex paints the composer banner
incrementally, so no single chunk holds both step-2 markers.

**Chosen: positional last-signal-wins.** Normalize the tail, take the last modal marker and
the last live-composer footer, later wins. Same session, same probe:

```
  [1 boot]          latch(A)=true   positional(B)=true    (modalAt=125 readyAt=-1)
  [2 dismissed]     latch(A)=true   positional(B)=false   (modalAt=125 readyAt=1633)
  [3 after submit]  latch(A)=true   positional(B)=false   (modalAt=125 readyAt=2067)
  tail windows 2k / 8k / 32k / 200k → blocked=false, all four
```

Window-insensitive, so the daemon's bounded ring read cannot flip the verdict. This is also
what this file's own header already claims its detectors do ("returns the LAST occurrence …
so transcript echoes earlier in the viewport do not produce false positives"); step 1 simply
never honoured it.

### 7.2 What changed

| file | change |
|---|---|
| `src/prompt-symbol-registry.js` | hoisted codex's step-1 patterns to `CODEX_MODAL_PATTERNS` (same regexes, same per-pattern flags — `detect()` behavior unchanged) so the new predicate cannot drift from it; added `CODEX_COMPOSER_FOOTER` and the exported `detectSurfaceModal()` |
| `daemon.js` | `readOutputRingTail` (bounded, newest-first); `isSurfaceBlockedByModal` (**fail-open**); `modalRemedy` / `modalHoldMs` env selectors; `modalDeliveryDecision`; `awaitSurfaceModalClear`; `resolveModalGate` — the one awaited gate consulted by `deliverInjectionToSession`, the force block, and the gated/gateOff path |
| `package.json` | `test/codex-modal-first-inject-737.test.js` registered in `test`, `test:watch`, `test:ci` |
| `README.md` / `README.tmpl.md` / `CHANGELOG.md` | `TELEPTY_MODAL_REMEDY`, `TELEPTY_MODAL_HOLD_MS` |

**Fail-open by construction** — the force path is production orchestrator dispatch, so only
*positive* modal evidence may block. No ring, no codex, no modal marker, or a composer footer
after the modal ⇒ `deliver`, byte-identical to before. Scoped to codex; claude/gemini always
get `not_applicable`. Pinned by a 7-case test.

### 7.3 RED → GREEN

`test/codex-modal-first-inject-737.test.js`: **15/15 pass** (3 anchors, 5 originally-RED,
7 added for blast radius, the positional rule, the hold, and the env levers).

| # | test | before | after |
|---|---|---|---|
| 1–3 | anchors: modal/composer classification, modal detectable from raw PTY bytes | pass | pass |
| 4 | `isSurfaceBlockedByModal` exists and is true for a wrapped non-cmux modal session | **RED** | pass |
| 5–7 | force / gated / plain must not resolve to `deliver` | **RED** | pass |
| 8 | a composer surface still resolves to `deliver` on every path | **RED** | pass |
| 9 | fails open on 7 non-modal surface shapes | — | pass |
| 10 | a dismissed modal still in the ring does **not** block | — | pass |
| 11–14 | hold releases on repaint; never-clearing hold degrades to reject; clear surface costs 0 polls; `TELEPTY_MODAL_HOLD_MS` bound + blank-value guard | — | pass |
| 15 | `TELEPTY_MODAL_REMEDY` selector, `off` restores pre-fix behavior | — | pass |

### 7.4 End-to-end on the real daemon (`scratchpad/e2e-737.js`)

| variant | before | after |
|---|---|---|
| force | body + CR (+4ms) | **nothing written**, refused |
| gated | body + CR (+7ms) | **nothing written**, refused |
| plain | body + CR (+525ms) | **nothing written**, refused |
| control (composer) | body + CR (+10ms) | body + CR (+3ms), elapsed 77ms — unchanged |
| holdRelease (dismissed at 1200ms) | n/a | **body + CR delivered at 1210ms** — delayed, not dropped |

Operator-facing:
`❌ [SURFACE_MODAL] codex_modal_ui — delivery refused: Target codex is showing a blocking
modal …; an Enter there would activate its default item, not submit your message. Dismiss it
on the surface, or clear it by setting dismissed_version to latest_version in
$CODEX_HOME/version.json and respawning.`

### 7.5 Live proof against real codex (`scratchpad/e2e-737-live.js`)

Real codex 0.144.1 under node-pty, behind the real daemon, driven by the real CLI. Both arms
run on the same build — the "before" arm is `TELEPTY_MODAL_REMEDY=off`, which *is* the
pre-#737 delivery path, so this is a same-harness RED→GREEN rather than a cross-build
comparison.

| arm | inject #1 (modal up) | brew execs | codex alive | inject #2 (after dismissal) |
|---|---|---|---|---|
| before — `REMEDY=off` | `✅ injected` (a lie) | **1** | **NO — exited** | n/a, session dead |
| after — default `hold` | `❌ SURFACE_MODAL`, actionable | **0** | **yes** | `✅` delivered, body on surface |

### 7.6 Suites, Snyk, scope

- **Full suite: 79 files, 859 assertions, 0 failures.** Run per-file and timeout-wrapped —
  10 files (all of which `require` daemon.js) complete their assertions but never exit, the
  known persisted-session poll-timer quirk; they contribute 114 of those assertions and are
  counted from their TAP `ok` lines. A plain `npm run test:ci` cannot finish for the same
  reason (SIGKILL at ~10min, no failures up to that point) — that is pre-existing, not new.
- **Snyk: 0 new.** `src/prompt-symbol-registry.js` 0 findings; `daemon.js` reports 15, and
  `main`'s `daemon.js` reports the **same 15 with identical fingerprints** — none in the
  changed regions. Pre-existing scratchpad findings from #730's harness remain untouched
  (Rule 29).
- **No merge, no publish.** Branch only.

### 7.7 Out of scope, found on the way (reported, not fixed — Rule 29)

1. **`cli.js` exits 0 on a refused inject.** Failures are `console.error` + `return`, with no
   non-zero exit code — true for `SURFACE_MODAL` and equally for the pre-existing `STALE` /
   `DISCONNECTED` paths. A shell doing `telepty inject … && next` treats a refusal as success.
   Pre-existing CLI contract; changing it affects every failure mode, not just #737.
2. **WS auto-register stamps `command: 'wrapped'`** (`src/transport/websocket.js`), not the
   real CLI. Any session that comes up through that reconnect path is unidentifiable as
   codex, so **every** CLI-identity feature silently degrades — #730's paste capability and
   #737's modal predicate alike. Sessions restored from the persisted store keep their real
   command, so this is scoped to the auto-register fallback. Worth its own issue.
