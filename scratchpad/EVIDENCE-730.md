# #730 — codex 0.144.1 forced-submit regression: reproduction + diagnosis

**Phase:** REPRODUCE + DIAGNOSE only. **No product code changed** (Rule 29).
**Branch:** `fix/730-codex-submit-repro` · **Status:** HOLD, awaiting orchestrator approval to fix.

Reproduce everything: `./scratchpad/repro-730.sh` (~6 min) or `./scratchpad/repro-730.sh quick` (~30 s).

---

## 1. Verdict

Not a new codex regression, and **not** a broken prompt matcher. #716's fix — wrap the
injected body in bracketed paste so the separately-written submit CR cannot be absorbed
into the paste burst — **still works correctly on codex 0.144.1**. It is simply **not
applied** to most real sessions, because the capability that gates it is inferred from a
**one-shot** byte sequence that is easy to miss and is **never persisted**.

When the envelope is missing, the force path writes the bare CR **0 ms** after the body,
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
bridge RELAYED codex's ESC[?2004h
  frame0 +0ms  BRACKETED-PASTE body len=121   head=1b5b3230307e…  tail=…1b5b3230317e
  frame1 +0ms  BARE CR (0x0d)
  => bodyWrapped=true  crSeparate=true  text->CR=0ms

bridge MISSED codex's ESC[?2004h
  frame0 +0ms  RAW body (no envelope) len=109  head=5245504f52543a20 …
  frame1 +0ms  BARE CR (0x0d)
  => bodyWrapped=false crSeparate=true text->CR=0ms
```

Answering the brief's questions directly:

- **Is the CR written?** Yes, always, as a separate bare `0x0D` frame.
- **Inside or outside the envelope?** Always outside — #716's ordering is intact.
- **How long after the body?** **0 ms** on the force path (sub-millisecond at the PTY owner).
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
  measured 0 ms. Inside the ~120 ms burst window → swallowed.
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

## 6. RED test

`test/codex-submit-0144-730.test.js` — **not registered in package.json** (repro phase).
Run: `node --test test/codex-submit-0144-730.test.js` (hard-kill after ~20 s; requiring
`daemon.js` leaves persisted-session poll timers armed and the runner never exits — known
sandbox quirk, not debugged per the brief).

```
not ok 1 - #730 RED: a codex session that missed the one-shot ESC[?2004h still needs the paste envelope
not ok 2 - #730 RED: bracketed-paste capability survives a daemon restart
not ok 3 - #730 RED: a restored codex session still gets the paste envelope
ok   4 - #730 characterization: un-enveloped multi-line body + 0ms CR accumulates, never submits
ok   5 - #730 characterization: the paste envelope makes the CR land regardless of gap
ok   6 - #730 characterization: holding the CR past the burst window also lands it
```

3 RED = the product invariants #730 breaks. 3 GREEN = characterization of measured codex
0.144.1 behavior, pinning the direction any fix must satisfy.

---

## 7. Fix directions — NOT implemented, for orchestrator decision

Ordered cheapest-first. Each is independently sufficient for the reported symptom; A+B
together are the durable pair.

- **A. Stop inferring what we already know.** Treat a known paste-capable CLI (codex, and
  claude — both advertise `?2004h`) as paste-capable by command, using the existing
  `src/prompt-symbol-registry.js` CLI identity, instead of racing a one-shot byte sequence.
  Keep the observed `?2004h`/`?2004l` as an override so a genuinely non-paste CLI still
  opts out. Smallest diff, kills both loss paths.
- **B. Persist the capability.** Add `bracketedPasteCapable` to
  `serializePersistedSessions` / `buildRestoredWrappedSession`. Two lines; closes the
  restart hole permanently. Without A this still leaves the late-attach race.
- **C. Floor the force-path text→CR gap.** Give `force` a minimum delay before
  `terminalLevelSubmit`. This is the #694-style fix the brief asked about — #694 turned out
  to be a busy-dispatch *state* fast-path, not a timing gap, and no gap fix exists on the
  force path today. Defense-in-depth for any CLI whose paste capability we misjudge. Note
  the sizing is a judgement call, not a measured constant: 127 ms still failed 1/7, and
  ≥157 ms was clean over 6 runs — so a 250-300 ms floor buys real margin, at that cost per
  forced submit.

Also worth deciding separately: `awaitInputSettled`'s 100 ms quiet window sits inside the
range where the swallow still occurs, so the *gated* `--submit` path is narrowly safe too.

**Not recommended:** trusting `submit_confirmed` / `[forced]` as delivery evidence (the
brief's listed failed approach — it only means bytes were written to the PTY).

---

## 8. Safety notes

- Production daemon (3848, launchd) never restarted or contacted. No existing bridge touched.
- No `session-cleanup` run. Every session created here (`c730-*` tmux sessions, harness-daemon
  sessions) was created and torn down by these scripts.
- Real `~/.codex` untouched — the harness uses an isolated `CODEX_HOME` under `/tmp/c730-work`.
- codex turns cost nothing: a local stub provider answers with an immediate HTTP 400
  (an unreachable host instead triggers a multi-minute reconnect storm that poisons the
  next measurement).
