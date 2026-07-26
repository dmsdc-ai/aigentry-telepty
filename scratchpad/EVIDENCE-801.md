# EVIDENCE-801 — error-death vs genuine completion

A wrapped AI-CLI session that dies on an API error is reported to its dispatcher
as a completion. Branch `fix/801-error-vs-complete`, worktree
`~/.aigentry/worktrees/t801e`.

## 0. The report

Live, 2026-07-26, production orchestrator — 6 occurrences in one day:

| session | idle-at | screen at that moment |
|---|---|---|
| c757s-supervisor-orphan | 204.5s / 213.8s / 209.4s (3 injects) | `⏺ API Error: 529 Overloaded. This is a server-side issue…` then the `❯` prompt |
| ar795r-adr-r2 | 329.5s / 211.3s | same 529 banner |
| r795cs-adr-review-sol | **10.8s** | `■ {"type":"error","status":400,"error":{"type":"invalid_request_error",…}}` (codex) |
| w795c-w1c-freshness | 366.6s | CONTROL — a real REPORT inject arrived first |

Each emitted:

```
TASK_COMPLETE: <sid> is now idle after processing inject (204.5s, via real-idle inject=<uuid>)
```

The worker processed nothing. It errored, printed a banner, and returned to its
prompt. The orchestrator cannot tell that apart from a real completion without
reading the screen — which is the one thing the signal exists to spare it.

## 1. Why the existing gates do not catch it

The idle gate's job (#537 / #545 / #48 / #52 / #619 / #721) is *"was the inject
consumed?"*, and here it correctly answers **yes**: the body was submitted, the
CR was accepted, the ring advanced, a real turn started. The turn then died. No
existing predicate asks *"how did the turn end?"* — so the confirmed branch fires
and the report is a lie about outcome, not about delivery.

Concretely, in the reproduced production shape (`#721` worker-launcher):
`maybeRecordLauncherConsumption` records `injectConsumedAt`, which makes
`strongSubmitConfirmed` true and clears the `#545` `idleEvidenceUnreliable`
downgrade, so `confirmed === true`.

## 2. Fixture capture — real binaries

`scratchpad/capture-801-api-error.js`. tmux on its OWN socket (`-L c801`, never
the operator's default server — #524), 120×40, `capture-pane -p` for the rendered
screen and `pipe-pane -O` for the raw PTY byte stream. The raw stream is the
artefact that matters: it is what `daemon.js`'s `outputRing` accumulates and
therefore what the predicate actually runs on.

| shape | how | cost |
|---|---|---|
| `claude-529` | claude 2.1.220, `ANTHROPIC_BASE_URL` → a local stub answering 529 `overloaded_error` on every route | free, reproducible on demand |
| `codex-400` | codex 0.145.0, `--model gpt-5.6` against the real API | one rejected request |
| `claude-ok` | CONTROL — one real haiku turn | one turn |
| `codex-ok` | CONTROL — one real turn | one turn |

codex ignores `OPENAI_BASE_URL` under ChatGPT auth, so the stub was unusable for
it — but the real API's rejection is **byte-identical to the r795cs incident**,
which is a better fixture than a stub would have been.

The 529 stub also reproduced claude's full retry ladder, which turned out to be
load-bearing (§3.2).

## 3. What the bytes say

### 3.1 The composer cannot be the counter-signal

The obvious move was to copy `detectSurfaceModal`'s positional shape: last error
marker vs last live-composer marker, later wins. **It does not work.** Measured
tail of `claude-529.raw.bin`, after `normalizeOutputForDetection`:

```
⏺API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it
  persists, check your inference gateway (127.0.0.1:55310).
✻ Sautéed for 3m 4s
❯
────────────────────────────────────────────────────────────────────────────────
trusted|Haiku4.5|[░░░░░░░░░░░░░░░]0%0/200.0K
⏸manualmodeon·←foragents
```

The composer AND both status-footer watermarks repaint *after* the error banner.
Same in `codex-400.raw.bin` (`›Summarize recent commits` + `gpt-5.6 xhigh · …`
trail the `■` line). That repaint is not recovery — it **is** the symptom, the
worker back at its prompt with nothing to show. A composer counter-signal would
veto every real error.

So the scoping moved to the **turn**: only ring bytes appended past
`pendingReport.ringBytesAtInject` are scanned, reusing the split
`submitGate.observeInjectEcho` already does. An error from an earlier turn was
reported when it happened and cannot poison this one.

### 3.2 The #760 whitespace lesson bites again, in both directions

The rendered screen reads `⏺ API Error: 529` and `attempt 8/10`. The captured
bytes read:

```
⏺API Error: 529 Overloaded…          ← the glyph/text space is GONE
9s · atempt 10/10                     ← a whole letter dropped
```

Ink paints differentially (space runs become `ESC[<n>C` cursor jumps, partial
line rewrites drop characters mid-word), so a literal-space pattern matches a
`read-screen` snapshot and misses the stream the predicate runs on. Every pattern
uses `\s*`. It also rules out keying on the retry line at all — `atempt` is not a
string anyone would have written.

### 3.3 Retries are not failures

claude retried 10× over ~3 minutes, repainting
`✻ 529 Overloaded · Retrying in 8s · atempt 5/10` throughout, and printed the
`⏺` bullet only once the turn was actually dead. So the `⏺` anchor means *turn
over*, not *a request failed*.

### 3.4 codex's `•` is unusable; `■` is not

codex marks assistant output with `•` — but so does its spinner
(`(0s • esc to interrupt)`), and differential paint smears those bullets across
the reflowing line:

```
•Working (0s • esc to interrupt)Wor•WorkWorki•Workin•Working1•WorkingWorking•…
```

18 `•` in a 2.3 KB stream, nearly all spinner debris. `■` appears exactly once,
on the error. The patterns anchor on `■` — which also stops a worker that `cat`s
a JSON fixture containing `"type":"error"` from being declared dead.

### 3.5 Detector output on all four captures

```
claude-529   {errored:true,  reason:'claude_api_error', detail:'API Error: 529 Overloaded. This is a server-side issue…'}
claude-ok    {errored:false, reason:'no_error_seen'}
codex-400    {errored:true,  reason:'codex_api_error',  detail:'{"type":"error","status":400,…invalid_request_error…'}
codex-ok     {errored:false, reason:'no_error_seen'}
gemini/bash  {errored:false, reason:'not_applicable'}
```

## 4. The fix

- `src/prompt-symbol-registry.js` — `SURFACE_ERROR_RULES` (a per-CLI marker table
  beside #737/#760's `SURFACE_MODAL_RULES`) + `detectSurfaceError`, positional
  last-one-wins, capped single-line `detail`.
- `daemon.js` — `detectIdleAfterError(session, pendingReport)` slices the ring at
  the inject watermark and asks the registry; `fireAutoReport` consults it **only
  on the confirmed branch** and emits `TASK_ERROR: <sid> went idle after an
  API/transport error (<detail>) — <elapsed>s, via <trigger> inject=<id>; the
  inject was NOT processed`. The bus event carries `error_marker` /
  `error_detail`.

No new daemon, no new state file, no new config knob (제1조). Rule 29 surgical:
49 lines in `daemon.js`, 62 in the registry.

**Fail-open in five places** — unknown/unmeasured CLI, no ring, no watermark, no
ring advance, no marker. Any one of them returns today's emission byte-for-byte.
`TASK_IDLE_UNCONFIRMED` / `TASK_IDLE_NO_REPORT` are never touched: an already-
honest warning has nothing to correct, so the check only runs where the daemon
was about to assert the inject had been *processed*.

## 5. RED → GREEN on the real daemon

`scratchpad/e2e-801.js` — harness daemon (`PORT=0`, mkdtemp `HOME`; production
3848 never touched, never kickstarted, never killed), a recording orchestrator
bridge and a worker bridge, one real `cli.js inject --submit --submit-force`, and
the captured PTY bytes relayed as the worker's output. before/after is measured
on two real builds (`before-*` arms spawn `daemon.js` from the pristine main
checkout) rather than by adding a rollback knob.

```
ok  claude-529            fix      want=TASK_ERROR       got=TASK_ERROR
ok  before-claude-529     pre-fix  want=TASK_COMPLETE    got=TASK_COMPLETE   ← the RED
ok  codex-400             fix      want=TASK_ERROR       got=TASK_ERROR
ok  before-codex-400      pre-fix  want=TASK_COMPLETE    got=TASK_COMPLETE   ← the RED
ok  control-claude        fix      want=TASK_COMPLETE    got=TASK_COMPLETE
ok  before-control-claude pre-fix  want=TASK_COMPLETE    got=TASK_COMPLETE
ok  control-codex         fix      want=TASK_COMPLETE    got=TASK_COMPLETE
```

Verbatim RED, pre-fix main, `claude-529` bytes:

```
TASK_COMPLETE: w801-before-claude-529 is now idle after processing inject (6.0s, via real-idle inject=71b20e87-…)
```

Verbatim GREEN, same bytes:

```
TASK_ERROR: w801-claude-529 went idle after an API/transport error (API Error: 529 Overloaded. This is a
server-side issue, usually temporary — try again in a moment. If it) — 5.9s, via real-idle inject=…;
the inject was NOT processed
```

## 6. Verification

- `test/idle-error-vs-complete-801.test.js` — 18 tests, registered in
  `package.json`. Detector over the captured tails, turn-scoping (including the
  proof that the same ring *unscoped* would have fired), five fail-open shapes,
  and the emission through `fireAutoReport`'s DI seam.
- Anchors green: `claude-modal-inject-760`, `codex-modal-first-inject-737`,
  `prompt-symbol-registry`, `idle-unconfirmed-{settle,consumption,decayed-619,
  false-negative-721}`, `enforce-report`, `report-enforcement` — 132/132.
- Full suite: **814 pass / 1 fail** — `bridge-output-pipe-732` under full-suite
  load, the documented pre-existing flake; 2/2 in isolation.
- `tsc --noEmit` clean.
- Snyk `snyk_code_scan`: `src/prompt-symbol-registry.js` 0, the new test file 0,
  `daemon.js` 15 — **the identical 15 fingerprints the pre-fix `daemon.js` on
  main reports**, so 0 new.
- Harness cleanup (#524): no `c801` tmux server, no stray `daemon.js` processes,
  no `c801-home-*` temp HOMEs. Production 3848 answers 200; its launchd job is
  untouched.

## 7. Known bounded risk

`detectSurfaceError` reads *chrome*, and chrome changes. A claude release that
restyles the `⏺ API Error:` bullet, or a codex release that drops the `■` glyph,
silently returns the affected CLI to pre-#801 behaviour — a false TASK_COMPLETE,
not a false TASK_ERROR. That is the correct direction to fail, and it is the same
exposure #737/#760's modal tables already carry; the fixture-capture script is
committed so re-measuring after a CLI upgrade is one command per shape.

gemini has no row: its error surface is not measured yet.
