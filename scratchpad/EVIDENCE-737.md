# #737 — codex update modal swallows the first inject

**Phase: REPRODUCE + DIAGNOSE. No product code changed. HOLD for fix approval.**

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
composers in #730), loopback stub provider answering any turn with an immediate 400.

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
- Snyk: N/A this phase (no first-party product code generated). Both harness scripts bind
  loopback-only HTTP by design, carrying the same accepted CWE-319 note as #730's harness.
- Known sandbox quirk honoured: `require('../daemon')` arms persisted-session poll timers,
  so every node run here is timeout-wrapped.
