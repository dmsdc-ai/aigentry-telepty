# #730 — codex 0.144.1 forced-submit regression: reproduction + diagnosis

**Phase:** FIXED — reproduce + diagnose, then the approved A+B+C(scoped) fix.
**Branch:** `fix/730-codex-submit-repro` · **Status:** DONE (not merged, not published).

Reproduce everything: `./scratchpad/repro-730.sh` (~6 min) or `./scratchpad/repro-730.sh quick` (~30 s).

---

## 1. Verdict

Not a new codex regression, and **not** a broken prompt matcher. #716's fix — wrap the
injected body in bracketed paste so the separately-written submit CR cannot be absorbed
into the paste burst — **still works correctly on codex 0.144.1**. It is simply **not
applied** to most real sessions, because the capability that gates it is inferred from a
**one-shot** byte sequence that is easy to miss and is **never persisted**.

When the envelope is missing, the force path writes the bare CR **~3 ms** after the body,
deep inside codex's paste-burst window — so the CR is absorbed as another newline and the
composer accumulates. The swallow is **probabilistic**, not a clean cutoff: near-certain at
a ~16 ms gap, rare by ~127 ms, unobserved from ~157 ms up. That probabilistic tail is why
the field saw it "sometimes" and 2-3× per session rather than every time.

---

## 2. Reproduction (deterministic, real codex 0.144.1)

`scratchpad/repro-730-tmux.js` spawns real codex under tmux and replays the exact byte
sequence the force path writes. **tmux `capture-pane` is the VT** — the repo's regex ANSI
stripper (`src/screen-ansi.js`) concatenates partial redraws, so "last `›` line in the byte
stream" is *not* the current composer row and silently reports the wrong verdict. An
earlier run of this investigation was misled by exactly that; every number below is from
real screen state.

Each run injects 2 messages. A run is counted as failing if a body was still parked in the
composer afterwards, i.e. its CR was swallowed. Aggregated over every run recorded in
`/tmp/c730-work/*.verdict.json`:

| envelope | body shape | text→CR gap (actual median) | runs with a swallowed CR |
|---|---|---|---|
| none | multi-line, 9 lines | 16 ms | **10/11** |
| none | multi-line, 9 lines | 57 ms | **2/2** |
| none | multi-line, 9 lines | 86 ms | **2/2** |
| none | multi-line, 9 lines | 107 ms | **1/2** |
| none | multi-line, 9 lines | 127 ms | **1/7** |
| none | multi-line, 9 lines | 157 ms | 0/2 |
| none | multi-line, 9 lines | 307 ms | 0/7 |
| none | multi-line, 9 lines | 607 ms | 0/2 |
| none | single-line, 600 chars | 17 ms | 0/5 |
| none | single-line, 600 chars | 312 ms | 0/1 |
| **bracketed paste** | multi-line, 9 lines | 16 ms | **0/9** |

**The swallow needs all three:** no bracketed-paste envelope **and** embedded newlines
**and** a short text→CR gap. Size alone does not do it — a 600-char *single-line* body at
16 ms submits every time (0/5).

**It is a probability, not a threshold.** The requested gap is accurate to ±2 ms
(measured: requested 10 ms → actual 16-17 ms across 18 injects), so the run-to-run
variation is codex-side, not harness jitter — consistent with a wall-clock burst heuristic
racing PTY read coalescing under varying render load. Do not treat "127 ms" as a safe
number: 1/7 runs still failed there. Only ≥157 ms was clean, and that is 6 runs of
evidence, not proof of a hard floor.

Two caveats on reading the table honestly:
- A failing run usually shows `parked=1`, not 2: msg 1's CR is swallowed, then msg 2's CR
  flushes the *combined* blob. Both injects failed to land as their own turn, but only one
  body is left visible. The per-run column above is the honest one.
- An earlier pass of this investigation reported a crisp "swallow ≤100 ms / safe ≥120 ms"
  boundary from single runs per cell. That was luck, not signal; the repeats above replace it.

Observed symptom matches the field report exactly (`/tmp/c730-work/*.screens.txt`): msg 1
parks in the composer, msg 2 is appended to the *same* composer, and one Enter flushes
both as a **single** message.

---

## 3. Byte-level evidence on the REAL telepty path

`scratchpad/e2e-730.js` boots a **harness daemon** (`PORT=0`, isolated `HOME`; production
3848 never touched), attaches a recording owner-WS bridge as a wrapped session, and runs
the real `telepty inject --submit --submit-force` CLI. Frames are what the daemon actually
delivers to the PTY owner:

```
PRE-FIX
  bridge RELAYED ESC[?2004h : BRACKETED-PASTE body len=121, then BARE CR   text->CR=2ms
  bridge MISSED  ESC[?2004h : RAW body len=109,             then BARE CR   text->CR=3ms  <-- swallowed

POST-FIX (A+B+C)
  bridge RELAYED ESC[?2004h : BRACKETED-PASTE body len=121, then BARE CR   text->CR=3ms  <-- no latency tax
  bridge MISSED  ESC[?2004h : RAW body len=109,             then BARE CR   text->CR=253ms <-- C floor fired
```

Body frame head/tail bytes, enveloped case: `1b5b3230307e…` / `…1b5b3230317e` —
`ESC[200~` … `ESC[201~`, with the CR as its own separate `0d` frame outside it.

Answering the brief's questions directly:

- **Is the CR written?** Yes, always, as a separate bare `0x0D` frame.
- **Inside or outside the envelope?** Always outside — #716's ordering is intact.
- **How long after the body?** **~3 ms** on the force path (one HTTP round-trip on loopback).
  (An earlier pass of this report said 0 ms. That was a harness artifact: the e2e driver ran
  the CLI via `execFileSync`, blocking its own event loop so every queued WS frame was
  timestamped after the CLI exited. Fixed to async `execFile`; the real figure is ~3 ms.)
- **Does codex 0.144.1 still emit `ESC[?2004h`?** Yes — but **exactly once**, inside its
  first ~1.4 KB of output, and never again for the life of the process
  (`scratchpad/probe-codex.js`).

`✅ Submitted via pty_cr [forced]` is, as the brief warned, only "bytes were written".

---

## 4. Root cause

The envelope is gated on `session.bracketedPasteCapable`
(`daemon.js:1904-1908`, `maybeBracketedPaste`), which is set in exactly one place:

- **`daemon.js:2041-2043`** (`appendToOutputRing`) — sets the flag when a captured output
  chunk contains `ESC[?2004h`.

Since codex emits that sequence **once at startup**, there is exactly one chance to observe
it. Two independent ways to lose it:

**Loss path A — the observation window is missed.**
`appendToOutputRing` is reached from only two places: the spawned-PTY `onData` handler
(`daemon.js:2343-2349`) and the owner-WS `output` frame handler
(`src/transport/websocket.js:158-161`). A **spawned** session wires `onData` before codex
starts, so it always catches the sequence. A **wrapped** session (cmux/aterm/tmux bridge —
what real orchestrator sessions are) only sees frames after its owner WS connects; if the
bridge attaches after codex has printed its banner, the flag is never set and stays unset
for the whole session lifetime.

**Loss path B — the capability is never persisted.**
`src/session-store/persistence.js:11-38` (`serializePersistedSessions`) does not write
`bracketedPasteCapable`, and `:55-81` (`buildRestoredWrappedSession`) does not restore it.
After any daemon restart, every restored wrapped session comes back without the flag — and
because codex already burned its only `ESC[?2004h`, it can **never** be re-learned. #716 is
permanently inert for that session from then on.

**Why the force path specifically.** With `--submit`, `cli.js:2462` sends the inject with
`noEnter: true`, so the deferred 300/500 ms CR (`daemon.js:1986-1996`) is skipped and the
separate `POST /submit` owns the Enter:

- `--submit-force` → `daemon.js:3045-3050`: `force` short-circuits straight to
  `terminalLevelSubmit` → `submitViaPty` → `write('\r')`. **No settle gate, no delay** —
  measured ~3 ms. Inside the ~120 ms burst window → swallowed.
- `--submit` (gated) → `gatedTerminalSubmit` (`daemon.js:1177-1191`) →
  `awaitInputSettled` (`src/submit-gate.js:346-391`), which requires the render tail to be
  unchanged for `quietWindowMs: 100` before returning. That spends ≥100 ms plus a poll
  interval, so it usually clears the window — but the measured failure rate is still
  1/2 at 107 ms and 1/7 at 127 ms. This path is **marginal, not safe by design**.
- plain `telepty inject` (no `--submit`) → deferred CR at 300/500 ms → comfortably safe.

That is exactly why `--submit-force` is the flag that fails while ordinary injects work.

### Why fresh sessions sometimes worked

- Fresh **spawned** session (daemon owns the PTY): `onData` is wired before codex runs →
  flag always set → envelope applied → works. Matches the `demo-codex5` observation.
- **Wrapped**/bridged session, or any session alive across a daemon restart: flag unset →
  raw body + 0 ms CR → accumulates. Matches `demo-codex3`/`codex4`, repeated 2-3× per session.
- Single-line injects submit fine even unwrapped, so a session's behavior also flips with
  the *shape* of the message — short one-liners work, multi-line REPORT blobs don't.

### Bonus finding (separate, real)

The user's `~/.codex/version.json` has `dismissed_version: 0.137.0` against
`latest_version: 0.145.0`, so a freshly spawned codex opens a **blocking** "Update
available … Press enter to continue" modal. The first inject's text lands in that modal and
its CR merely dismisses it — the message is lost. This is a plausible second cause of "one
local codex needed a manual enter for its FIRST inject, then behaved". The prompt-symbol
matcher does correctly treat it as not-ready (`codex_modal_ui`), so gated submits park; the
**force** path bypasses that check entirely.

---

## 5. Hypotheses killed

- **Stale codex prompt matcher (#719/#722).** Dead. `detectOutput('codex', screen)` against
  a real 0.144.1 `capture-pane` returns `{found: true, reason: 'codex_multi_signal'}`, and
  with the boot box scrolled out of the viewport the fallback still returns
  `{found: true, reason: 'codex_strict_line'}`. Both branches healthy. Also irrelevant to
  the reported symptom: the force path never consults the gate.
- **codex 0.144.1 changed bracketed-paste semantics.** Dead. Wrapped bodies submit 2/2 at a
  10 ms gap, both idle and mid-turn.
- **Arrival during a busy turn.** Dead as *the* cause. With the envelope applied, two
  injects delivered mid-turn (`BUSY=1`, stub holding the response 30 s) were both accepted
  and queued as separate user messages.
- **`ESC[?2004h` no longer emitted.** Dead — still emitted, just once at startup.

---

## 6. Test file

`test/codex-submit-0144-730.test.js` — registered in `package.json` (`test`, `test:watch`,
`test:ci`), alongside the sibling #716 suite.
Run: `node --test test/codex-submit-0144-730.test.js` (hard-kill after ~20 s; requiring
`daemon.js` leaves persisted-session poll timers armed and the runner never exits — known
sandbox quirk, not debugged per the brief).

The three RED assertions are now GREEN; the characterization tests still pin measured
codex behaviour. 11/11:

```
ok  1 A: a codex session that missed the one-shot ESC[?2004h still gets the paste envelope
ok  2 B: an OBSERVED bracketed-paste capability survives a daemon restart
ok  3 B: a restored codex session still gets the paste envelope
ok  4 characterization: un-enveloped multi-line body + immediate CR accumulates, never submits
ok  5 characterization: the paste envelope makes the CR land regardless of gap
ok  6 characterization: holding the CR past the burst window also lands it
ok  7 A: an observed ESC[?2004l disables the envelope even for a known CLI
ok  8 A: identity stays conservative — unknown CLIs are byte-identical
ok  9 A: claude is paste-capable by identity too
ok 10 C: force CR gap applies only to an un-enveloped multi-line body
ok 11 C: the floor is tunable via TELEPTY_FORCE_CR_GAP_MS
```

3 RED = the product invariants #730 breaks. 3 GREEN = characterization of measured codex
0.144.1 behavior, pinning the direction any fix must satisfy.

---

## 7. Fix as shipped (approved A+B+C-scoped)

**A — identity first, observation as override** (`src/prompt-symbol-registry.js`,
`daemon.js:maybeBracketedPaste`). `isPasteCapableCli()` holds a deliberately conservative
set — `codex`, `claude` only; gemini is excluded because it never advertised `?2004h`.
Resolution order:

| `session.bracketedPasteCapable` | meaning | result |
|---|---|---|
| `true` | observed `ESC[?2004h` | wrap (unchanged) |
| `false` | observed `ESC[?2004l` | do **not** wrap, even for a known CLI |
| `undefined` | never observed | wrap iff the CLI is known paste-capable |

Identity does not expire; the observation does. This is what kills both loss paths.

**B — persist the observed capability** (`src/session-store/persistence.js`). Written
**only when actually observed**, so a session that never saw the mode-set still serializes
byte-identically to the pre-#730 format (the legacy-bytes test stays green without editing
its fixture). On restore, absent/null stays `undefined` so the session falls back to
identity rather than being pinned to "not capable".

**C — scoped force-path CR floor** (`daemon.js:forceSubmitCrGapMs` + the `force` branch).
Waits `TELEPTY_FORCE_CR_GAP_MS` (default **250 ms**) before the CR **only** when the body
is un-enveloped **and** contains a newline — the one shape measured to fail. Enveloped
(0/9) and single-line (0/5) bodies are already immune and pay nothing. An unset or blank
env var falls back to the default rather than to 0 (`Number('')` is 0 — that footgun was
caught by a test, not by review).

Measured end-to-end: enveloped path 3 ms (unchanged), un-enveloped multi-line 253 ms.

**Explicitly out of scope** (orchestrator decision): `awaitInputSettled`'s 100 ms quiet
window is left as-is — note only that it sits inside the range where the swallow still
occurs, so gated `--submit` is narrowly safe. The `version.json` modal bug is filed
separately as **#737**. `[forced]` is still not treated as delivery evidence.

## 8. Safety notes

- Production daemon (3848, launchd) never restarted or contacted. No existing bridge touched.
- No `session-cleanup` run. Every session created here (`c730-*` tmux sessions, harness-daemon
  sessions) was created and torn down by these scripts.
- Real `~/.codex` untouched — the harness uses an isolated `CODEX_HOME` under `/tmp/c730-work`.
- codex turns cost nothing: a local stub provider answers with an immediate HTTP 400
  (an unreachable host instead triggers a multi-minute reconnect storm that poisons the
  next measurement).
