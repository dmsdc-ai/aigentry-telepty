# EVIDENCE-760 — Claude Code modal inject gate

Extends #737's codex-scoped modal gate to Claude Code's blocking modal surfaces.
Branch `fix/760-claude-modal-gate`, worktree `~/.aigentry/worktrees/c760`.

## 0. The report

Live, 2026-07-26, production orchestrator session:

- **(a) splice** — a worker REPORT's text landed in the MIDDLE of the user's
  in-progress `AskUserQuestion` answer.
- **(b) silent loss** — 3 REPORT injects vanished during a plan-mode approval
  window (task #743).

Same failure family as #737 (codex update modal), whose fix shipped in 0.6.18.

## 1. Why #737 did not already cover it

#737 shipped the whole mechanism and then scoped the *detection* to codex:

```js
// 0.6.18 src/prompt-symbol-registry.js
function detectSurfaceModal(command, output) {
  if (commandKey(command) !== 'codex') return { blocked: false, reason: 'not_applicable' };
```

`isSurfaceBlockedByModal` → `detectSurfaceModal` → `not_applicable` → `false` →
deliver. All three write paths asked the gate and were told "fine" every time.
So claude kept byte-identical pre-#737 behavior on every surface.

## 2. Fixture capture — real Claude Code 2.1.220

`scratchpad/capture-760-claude-modals.js`. tmux on its OWN socket (`-L c760`,
never the operator's default server — #524), 120×40, `capture-pane -p` for the
rendered screen and `pipe-pane -O` for the raw PTY byte stream. The raw stream is
the artefact that matters: it is what `daemon.js`'s `outputRing` accumulates and
therefore what the predicate actually runs on.

| shape | how | cost |
|---|---|---|
| `composer` | boot to the composer, no modal | free |
| `ask` | prompt haiku to call `AskUserQuestion` | 1 turn |
| `plan` | `--permission-mode plan`, prompt haiku to call `ExitPlanMode` | 1 turn |

Never sent Enter into any of them. The plan modal's pre-selected item is
`1. Yes, auto-accept edits` — activating it drops a real claude into
auto-accept-edits and starts executing, the same destructive-default family as
#737's `1. Update now (runs \`brew upgrade --cask codex\`)`.

**Not captured live: the folder-trust dialog.** This host has already accepted
it, and it is per-project state in `~/.claude.json` that a fresh dir did not
re-trigger (tried `/tmp` and `$HOME` subdirs). An isolated `CLAUDE_CONFIG_DIR`
reaches first-run onboarding instead (theme picker → login-method picker), which
is itself a blocking modal and *is* covered. The trust pattern
(`Yes,\s*I\s*trust\s*this\s*folder`) is verified against the 2.1.220 binary's
`confirmLabel` string, not against a screen capture. Flagged as the one
pattern in this change with weaker provenance than the rest.

## 3. The finding that shaped the patterns — Ink paints differentially

The modal text is in the byte stream, but **not as contiguous words**:

```
$ grep -acF "Enter to select" /tmp/c760-work/ask.raw.bin
0
```

…while the rendered screen shows `Enter to select · ↑/↓ to navigate · Esc to cancel`
plainly. claude renders through Ink, which emits `ESC[<n>C` cursor-forward jumps
instead of runs of spaces. After `stripAnsi` the words abut:

```
"…\n❯ 1. Red\n   A warm, boldcolor\n2. Blue\n…\nEntertoselect·↑/↓tonavigate·Esctocancel\n"
"…\nClaudehaswrittenupaplanandisreadytoexecute.Wouldyouliketoproceed?\n❯1.Yes,auto-acceptedits\n…"
"…\ntrusted | Haiku 4.5 | [░░░░░░░░░░░░░░░] 0% 0/200.0K\n⏸manualmodeon·←foragents\n"
```

So every claude pattern is written whitespace-TOLERANT (`\s*` between tokens,
never a literal space). A literal-space pattern matches a `cmux read-screen`
snapshot and **misses the stream the delivery path reads** — it would have looked
correct in every screen-based test and protected nothing in production. codex
needed none of this; its TUI repaints whole lines. Note the composer footer above
appears in BOTH forms (full repaint with real spaces, differential repaint glued),
so the counter-signals have to match both.

## 4. The measurement that chose the remedy — a parked modal is silent

`capture-760-claude-modals.js` holds each modal up for 45s and diffs the raw
byte count:

| shape | bytes at modal | bytes after 45s hold | delta | still up |
|---|---|---|---|---|
| `ask` | 11305 | 11305 | **+0** | yes |
| `plan` | 26508 | 26508 | **+0** | yes |

Two consequences:

1. The positional verdict **cannot drift** while a modal sits, for any duration.
   A modal parked for ten minutes reads exactly as it did at second one.
2. There is **no output event to re-arm on**. Polling is the only way to notice
   the clear — which is why `scheduleModalParkDrain` is a timer, not a hook on
   `appendToOutputRing`.

## 5. Positional detection, verified window-insensitive

`scratchpad/probe-760-signals.js`, last-index of every candidate marker over the
real streams, at several tail windows (the delivery path reads a bounded
`MODAL_RING_TAIL_BYTES` = 64KB tail):

```
## composer  raw=3014B
  win=  8192  NO-MODAL  modalAt=    -1 composerAt=  1183
  win= 65536  NO-MODAL  modalAt=    -1 composerAt=  1183
      composer hits : ctx_meter@1151 ctx_tokens@1174 mode_line@1183 composer_frame@753

## ask  raw=8741B
  win=  8192  BLOCKED   modalAt=  2754 composerAt=  2274
  win= 65536  BLOCKED   modalAt=  2965 composerAt=  2485
      modal hits    : select_footer@2937 esc_to_cancel@2965
      composer hits : ctx_meter@2197 ctx_tokens@2485 mode_line@2226 composer_frame@1936

## plan  raw=21481B
  win=  8192  BLOCKED   modalAt=  2377 composerAt=   919
  win= 65536  BLOCKED   modalAt=  6185 composerAt=  4727
      modal hits    : plan_ready@5201 plan_header@5217 plan_proceed@6159 plan_accept@6185
      composer hits : ctx_meter@4630 ctx_tokens@4654 mode_line@4727 composer_frame@4363
```

Same rule as #737 and for the same reason: the ring is append-only, so a
*dismissed* modal stays in it for the rest of the session. Presence would park
every dispatch on a healthy session forever; position decides. The composer
counter-signal is a UNION of four independent markers — every extra one makes the
predicate MORE fail-open, which is the safe direction for a gate sitting in front
of all production dispatch.

## 6. Remedy: `park`, not a longer `hold`

#737's default is `hold` — keep the HTTP request open until the surface clears,
bounded by `TELEPTY_MODAL_HOLD_MS` (30s), degrading to `reject`. Three reasons it
does not transfer to claude:

1. **Duration.** codex's modal is machine-owned and transient. A plan approval or
   an `AskUserQuestion` waits on a **human** and routinely stays up for minutes —
   #743 was one such window.
2. **The client dies first.** `telepty inject` is a plain `fetch` (`cli.js`
   `fetchWithAuth`, no explicit timeout), so undici's 300s `headersTimeout`
   applies. A hold longer than that hands the caller a network error while the
   daemon delivers the body anyway: a lost ack AND a probable duplicate re-inject.
3. **Order.** Two concurrent holds poll independently and race. `hold` never
   promised order; the #760 contract requires it.

`park` acks immediately, queues, and drains in order. It reuses
`session.bootstrapQueue` — this daemon's existing per-session FIFO of "ops that
may not touch the surface yet", with a drain that replays in order and bus events
for depth/failure. Boot uses it while the CLI is still starting; a modal is the
same predicate with a different cause. Notably it already handles the two-request
shape `telepty inject --submit-force` has (`POST /inject` with `noEnter:true`,
then `POST /submit`) — both halves land on one queue and replay in sequence, which
is precisely what a bespoke queue would have had to re-derive.

`dismiss` was considered and rejected for the same reason as #737: a bare Enter
IS the destructive key here.

### Ordering guard

The FIFO alone does not close one race: if the modal clears *between* two
dispatches, the second sees a clear surface, takes the mailbox path, and overtakes
the first while it is still in the queue. So anything arriving while a backlog
exists (or a drain is in flight) parks too — the same guard the gated `/submit`
path already applies to the bootstrap queue.

### TTL

600s (`TELEPTY_MODAL_PARK_TTL_MS`), matching the bridge mailbox park budget
(`TELEPTY_BRIDGE_INJECT_TTL_SECS`, #720) so the two places that hold a message
share one number. On expiry: flush with an actionable `modal_park_timeout` event
carrying the dropped count and a hint. Never silent accumulation — silence is the
#760 bug itself.

## 7. Adjacent fix: parked bodies were delivered un-enveloped

`executeBootstrapInject` wrote `writeDataToSession(prompt)` raw. Every other
inject path has wrapped the body in bracketed paste since #716/#730, and #730
measured that the un-enveloped **multi-line** shape is exactly what swallows the
following CR (1/7 even at a 127ms gap; the envelope was 0/9). That was harmless
while the queue only carried boot-time injects. It stops being harmless the
moment a modal park routes worker REPORTs — multi-line by definition — through
it. Fixed in the shared function rather than in the park branch, so the boot
caller stops rolling the same dice. Visible in the e2e frames: `RAW body` before,
`BRACKETED-PASTE body` after.

Three assertions across two files pinned the old un-enveloped bytes byte-exactly
and had to be re-pinned to the envelope — updated, not loosened, so the new shape
is still asserted exactly:

| file | test | was | now |
|---|---|---|---|
| `test/daemon.test.js` | queues inject until bootstrap ready | `'bootstrap-task'` | `'\x1b[200~bootstrap-task\x1b[201~'` |
| `test/daemon.test.js` | drains multiple bootstrap injects in FIFO order | `['first','second','third']` | the same three, each enveloped |
| `test/cli.test.js` | `telepty allow` queues first fake-claude inject | `SUBMIT:dispatch-token` | `SUBMIT:[200~dispatch-token[201~` |

The `cli.test.js` one is worth naming: its stub echoes back whatever bytes it
receives (a real claude interprets the markers instead), and the harness
`stripAnsi` only strips SGR (`\[[0-9;]*m`) — so the paste markers survive
into the assertion. That is a property of the stub, not a defect in the change.

The third bootstrap test in `daemon.test.js` uses `gemini`, which is not
paste-capable, and is untouched — a useful implicit control that the identity
gate in `maybeBracketedPaste` still decides correctly.

## 7b. The rollback lever has to cover the new drain guard

First cut of the drain guard asked `isSurfaceBlockedByModal` directly. That would
have made `TELEPTY_MODAL_REMEDY=off` an INCOMPLETE rollback: with the gate off,
boot-queued ops would still have been held behind a modal — a new failure mode
reachable only through the escape hatch, which is the worst possible place to put
one. The guard now asks `modalDeliveryDecision(session)`, the same seam every
write path uses, so `off` restores the pre-#760 drain exactly. Pinned by test 15.

## 8. Files

| file | change |
|---|---|
| `src/prompt-symbol-registry.js` | `CLAUDE_MODAL_PATTERNS` + `CLAUDE_COMPOSER_MARKERS`; `SURFACE_MODAL_RULES` per-CLI table; `detectSurfaceModal` reads the table (codex's row is #737's two lists verbatim — its behavior is unchanged) |
| `daemon.js` | `park` remedy + per-CLI default (`MODAL_REMEDY_BY_CLI`) and per-CLI hint; `modalParkTtlMs`; `flushModalParkQueue`; `awaitModalParkDrain` / `scheduleModalParkDrain` / `cancelModalParkPoll`; `parkOperationOnModal` + `modalParkResponse`; modal guard inside `drainBootstrapQueue`; park branches on all three write paths + the gated-submit bootstrap branch; ordering guard in `deliverInjectionToSession`; bracketed-paste envelope in `executeBootstrapInject`; park-poll cancel on session destroy |
| `test/claude-modal-inject-760.test.js` | 23 tests, real captured rings as fixtures |
| `test/daemon.test.js` | 2 assertions re-pinned to the bracketed-paste envelope (§7) |
| `package.json` | registered in `test` / `test:watch` / `test:ci` |
| `README.tmpl.md` / `README.md` / `CHANGELOG.md` | `park`, `TELEPTY_MODAL_PARK_TTL_MS`, per-CLI defaults |

`README.md` also picked up an unrelated one-line regeneration artefact
(ecosystem table `0.6.17` → `0.6.18`): the committed README was stale against
`package.json`, and `scripts/gen-readme.mjs` — which must be run to update the
env-var table — syncs it. Noted rather than hand-reverted in generated output.

## 9. RED → GREEN

`test/claude-modal-inject-760.test.js`, written against shipped 0.6.18 first.

```
RED   (0.6.18):  # tests 22  # pass 5   # fail 16
GREEN (fix):     # tests 23  # pass 22  # fail 0
```

(A file-level `not ok` appears in both runs under the plain `npm test` invocation
— the daemon-require quirk: requiring `daemon.js` starts a server, the process
never exits, and the runner reports the FILE as timed out while every assertion in
it passed. The shipped `test/codex-modal-first-inject-737.test.js` behaves
identically.

RETIRED 2026-08-01 (#829): this used to recommend `--test-force-exit`. Do not use it.
The flag truncates runs non-deterministically — it drops tests without failing them,
so a run still prints `fail 0` — and the underlying quirk is now FIXED at its cause:
`test-support/setup-env.js` gives every test process an isolated `HOME`, so requiring
`daemon.js` no longer restores and supervises the real `~/.telepty` sessions, and the
process exits on its own. This file runs clean flagless.)

| # | assertion | before | after |
|---|---|---|---|
| 1 | real `AskUserQuestion` ring → `claude_modal_ui` | **RED** | pass |
| 2 | real `ExitPlanMode` ring → `claude_modal_ui` | **RED** | pass |
| 3 | composer control ring → not blocked | pass | pass |
| 4 | markers match the glued Ink form AND the spaced form | **RED** | pass |
| 5 | `isSurfaceBlockedByModal` true for both claude modals, false for composer | **RED** | pass |
| 6–8 | force / gated / plain must not resolve to `deliver` | **RED** | pass |
| 9 | fail-open on 8 non-modal surfaces (null, no ring, empty ring, composer, boot banner, transcript prose, unknown cli, gemini) | pass | pass |
| 10 | dismissed modal still in ring does NOT block — position decides | **RED** | pass |
| 11 | verdict window-insensitive (1/4/16 × 4KB pads) | **RED** | pass |
| 12 | codex detection unchanged; neither CLI picks up the other's markers | pass | pass |
| 13 | codex keeps `hold`, claude gets `park`, `modalRemedy(env)` still answers `hold` | **RED** | pass |
| 14 | `TELEPTY_MODAL_REMEDY=off` restores pre-fix behavior for claude | pass | pass |
| 15 | a parked inject is queued and ACKED, not written and not refused | **RED** | pass |
| 16 | park drains in FIFO order, bracketed-paste enveloped | **RED** | pass |
| 17 | a dispatch arriving after the modal clears still parks behind the backlog | **RED** | pass |
| 18 | `drainBootstrapQueue` never writes into a still-modal surface | **RED** | pass |
| 19 | park TTL flushes with an actionable event, queue emptied | **RED** | pass |
| 20 | `TELEPTY_MODAL_PARK_TTL_MS` bound; blank ≠ 0 | **RED** | pass |
| 21 | clear surface resolves to plain delivery on every path | pass | pass |
| 22 | clear surface pays zero polls | **RED** | pass |

## 9b. Full suite — and how to actually get a verdict from it

`npm test` hands all 86 files to one `node --test` process and **never exits**:
several files `require('../daemon')`, which starts a server. On a busy machine it
also stalls outright — observed hanging after `broker-server.test.js` at 101
assertions, with `broker-client.test.js` passing cleanly in isolation on both
`main` and this branch. (An earlier apparent `bridge-output-pipe-732` failure was
traced to a zombie suite process from a previous run racing the live one for
ports; killed by explicit PID, and the file passes on both branches in isolation.)

RETIRED 2026-08-01 (#829). This section used to instruct running with
`--test-force-exit`. **Do not.** The flag drops tests without failing them, so a
truncated run still prints `fail 0` — the counts below were measured under it and
should be read with that in mind. The quirk it worked around is fixed at its cause:
`test-support/setup-env.js` now isolates `HOME`, so requiring `daemon.js` no longer
restores and supervises the real `~/.telepty` sessions and the process exits by
itself. Run flagless:

```
node --require ./test-support/setup-env.js --test --test-timeout=120000 <the package.json file list>
```

| build | tests | pass | fail | skipped | exit |
|---|---|---|---|---|---|
| `main` @ db78a5f (same runner, minus the new file) | 879 | 878 | **0** | 1 | 0 |
| `fix/760-claude-modal-gate` | 905 | 903 | **0** | 2 | 0 |

`package.json` is deliberately NOT changed to add the flag — that is a CI-workflow
decision outside #760. Worth raising separately: it turns an unprovable suite into
a provable one.

**One flaky test, not caused by this change.** `#732 REPRO + DETECT: an
unrecoverable upstream death is caught` (`test/bridge-output-pipe-732.test.js`)
failed with `Timed out waiting for first PTY output in ring` in two of four
whole-suite runs and passed in the other two, including the final one. It spawns a
real PTY bridge and waits 10s for first output, so it starves under full-suite
parallelism. Isolated: 3/3 pass on this branch, pass on `main`. Nothing in #760
touches the bridge output leg. Flagged as a pre-existing load-sensitive test.

## 10. End-to-end on the real daemon

`scratchpad/e2e-760.js` — harness daemon per arm (`PORT=0`, `mkdtemp` HOME;
production 3848 never touched), a recording owner-WS bridge relaying the VERBATIM
captured PTY bytes as that session's output, and the real `cli.js` driving each
inject path. `before-off` is `TELEPTY_MODAL_REMEDY=off`, the documented rollback
lever — so before/after are measured on ONE build.

```
arm         cli-args                surface     blocked ack     ms bodies  order INTO-MODAL afterClear
before-off  --submit --submit-force plan-modal  true    true   116      1  A     true       -
force       --submit --submit-force plan-modal  true    true   103      0  -     false      -
gated       --submit                ask-modal   true    true   103      0  -     false      -
plain       (none)                  ask-modal   true    true   108      0  -     false      -
control     --submit --submit-force composer    false   true   104      1  A     false      -
park        --submit --submit-force plan-modal  true    true   103      1  A     false      83ms
order       (none)                  ask-modal   true    true   108      2  AB    false      85ms
orderRace   (none)                  ask-modal   true    true   103      2  AB    false      175ms
ttl         (none)                  ask-modal   true    true   107      0  -     false      -
```

- `before-off` is the bug, reproduced end-to-end: bracketed-paste body at +0ms and
  a **bare CR at +3ms**, both into the plan-approval modal whose highlighted item
  is `1. Yes, auto-accept edits`.
- `force`/`gated`/`plain`: zero bytes into the modal, and the CLI still acks in
  ~105ms — no hang, so no client-side timeout and no re-inject.
- `control`: the composer path is unchanged — same body shape, same +3ms CR.
- `park`: delivered 83ms after the surface cleared, CR behind it.
- `order` / `orderRace`: A then B. `orderRace` clears the modal BETWEEN the two
  dispatches, which is the race the FIFO alone does not close.
- `ttl`: nobody answers; nothing delivered; park flushed
  (`[MODAL] c760-e2e-ttl park TTL expired after 6000ms — flushed 1 op(s)`).

## 11. Blast radius

- Predicate is **fail-open** by construction: no ring, no rule row, or no
  positive modal evidence ⇒ `false` ⇒ deliver. 8 control surfaces pinned (test 9).
- **codex unchanged**: its rule row is #737's lists verbatim, its remedy stays
  `hold`, and #737's own suite is green (`# pass 15 # fail 0`). Cross-checked that
  neither CLI matches the other's markers.
- **gemini and any unknown CLI** have no rule row ⇒ `not_applicable` ⇒
  byte-identical delivery.
- **Non-modal claude is byte-identical** — pinned by the `control` e2e arm and
  test 21.
- `TELEPTY_MODAL_REMEDY=off` is the one-env rollback for both CLIs.

## 12. Known ceilings

- The trust-dialog pattern is binary-verified, not screen-captured (§2).
- A parked op is drained by `executeBootstrapInject` / `executeBootstrapSubmit`,
  i.e. it re-enters the surface through the boot path rather than the mailbox
  path — so it does not carry the #47 provenance banner that a non-parked inject
  gets. Pre-existing property of that queue; called out rather than changed,
  since widening it is outside #760.
- `scheduleModalParkDrain` polls at 500ms, so worst-case delivery latency after a
  modal clears is one poll interval (measured 83–175ms in practice). Cheap enough
  that it is only ever paid while a modal is genuinely up.
