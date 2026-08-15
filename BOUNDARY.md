# telepty Responsibility Boundary

## What telepty owns

- **PTY lifecycle**: spawn, resize, kill PTY processes; emit session_spawn / session_register / session_rename events
- **Raw stdin write**: accept inject requests and write bytes to the PTY fd (best-effort, fire-and-forget)
- **stdout streaming**: pipe PTY output to connected WebSocket clients in real time
- **Bus event broadcast**: publish structured events to all `/api/bus` subscribers
- **Session lifecycle**: track active *sessions*, clean up sessions on exit or owner disconnect (the in-memory session record + PTY — **not** the terminal surface; see "does NOT own" below)
- **Liveness heartbeat**: emit `session_health` every 10 seconds per active session

## What telepty does NOT own

- **CLI state management**: the caller owns its own state machine; telepty does not know what state an agent is in
- **Inject processing confirmation**: telepty emits `inject_written` when bytes are handed to the OS; it cannot confirm the process consumed or acted on them
- **Output parsing / interpretation**: telepty streams raw bytes; callers parse meaning
- **Message guarantee / retry / ordering**: no retry logic, no queue, no ordering guarantees across multiple injects
- **Session recovery / persistence**: sessions are in-memory; a daemon restart loses all sessions
- **Cross-session routing**: routing logic (which session gets which message) belongs to the caller or an orchestration layer above telepty
- **Terminal-surface lifecycle**: open/close/focus of cmux/warp workspaces belongs to the Workspace Host adapter in the orchestration layer. telepty probes surface liveness (read-only) and emits `surface_orphaned`; it does **not** close or focus surfaces. (Standalone-only fallback: `AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE=1` re-enables self tab-close, default off.)

## PTY limitations

- `inject_written` is **best-effort**: it confirms the write syscall to the OS PTY fd succeeded, not that the running process read or processed the input
- The OS buffers stdin asynchronously; a process blocked, sleeping, or not reading stdin will silently queue the bytes
- There is no read-back or echo confirmation; callers must observe stdout via the WebSocket stream to infer processing

## Sender authentication — what `verified_sender_sid` proves (0.8.0, #815)

The daemon issues a per-session bearer once, at the first registration of a session id it does not
already hold, and keeps only `sha256(bearer)` as a **verifier**. The verifier is persisted; the
bearer never is. The principal is `(canonical_sid, session_epoch, credential_generation)`.

**What it proves.** `verified_sender_sid == X` with `verified_sender_epoch == E` means: the caller
presented a bearer that this daemon issued exactly once to the instance `(X, E)`, that has not been
revoked, and whose verifier is on disk. It survives a daemon restart, and a later session that
reuses the textual id `X` gets a different epoch and can never inherit it.

**What it does NOT prove.** It is authentication against *confused-deputy*, *remote-over-tunnel*,
and *stale-instance* senders — **not** against a local process that can read the owner's bearer out
of its memory or environment. Consumers building on this (notably completion signalling, where
"did session X really send this report?" is load-bearing) must not over-read it.

Platform detail, measured rather than assumed:

- **macOS** (verified on Darwin 25.4.0): a same-uid, non-self process does **not** get the
  environment block. `ps eww -p <other-pid>` returns the command line with no environ; the same
  command against the caller's own pid does return it. `ps` reads `sysctl KERN_PROCARGS2`, and XNU
  withholds the environment for a process other than the caller. So `TELEPTY_SESSION_TOKEN` is not
  trivially readable from a sibling process here.
- **Linux**: `/proc/<pid>/environ` is mode 0400 owned by the process uid, so a same-uid process is
  expected to be able to read it. **UNVERIFIED — no Linux host was available to measure.** Treat
  the bearer as same-uid-readable on Linux until someone runs the check.

### Residual: the first-claim race

Issuance binds to the *first registrant* of an id. Between the daemon learning an id and the real
wrapper claiming its PTY, a local process that wins the race becomes the credentialed instance. The
window is milliseconds, and the real wrapper then fails **loudly** — its owner claim is refused with
close 4003 because a verifier now exists that it cannot match — rather than silently proceeding.
Fail-closed and detectable, but not prevented.

Closing it fully requires a secret the wrapper holds *before* it first talks to the daemon: the
launcher that spawns `telepty allow` generates a one-time value, passes it in the spawn environment
and to the daemon in an authenticated pre-registration, and the daemon issues only against it. That
is a consumer-side spawn change, deliberately not built here. **Documented so the next person does
not have to rediscover it.**

## The shared daemon secret — read boundary, and why rotation needs a restart

`~/.telepty/config.json` holds the token every caller presents to the daemon. Two properties are
deliberate, and both are load-bearing:

**The daemon freezes the token at boot and never re-reads it.** So rotating it requires a deliberate
daemon restart. An operator who edits the config under a running daemon will get 401s until the
daemon is restarted — that is correct behaviour, not a bug. The boundary the token buys is *"whoever
can **read** this file can drive the daemon"* — real against a different uid, a sandbox with a
different `HOME`, or a container neighbour. Re-reading per request would quietly widen it to
*"whoever can **write** this file owns the running daemon"*, making a file write a silent credential
takeover of the process that parents every live session, with no restart and nothing in any log. The
freeze is what keeps rotation an explicit, observable act.

**A config that cannot be read is never replaced.** `getConfig()` mints a token only when there is no
config at all; a file that will not parse, or that carries no usable `authToken`, is a refusal
(`err.code === 'TELEPTY_CONFIG_UNREADABLE'`) with the bytes on disk left exactly as found. The daemon
refuses to boot on one rather than serving on a secret nobody else has. Minting over an unreadable
config would destroy a secret that is still recoverable, and — given the freeze above — desync a
long-lived daemon from every subsequent call, permanently.

Consequence worth stating once: a running daemon is *immune* to the config changing underneath it,
because it never looks again. The failure surfaces on the caller side, named, not as a silent re-key.

## Design principle

> **telepty = stateless dumb pipe**

telepty moves bytes. It does not interpret, retry, sequence, or guarantee delivery beyond the OS write call. All higher-level semantics (acknowledgement, ordering, state machines, recovery) are the responsibility of the layer above.

## KNOWN DIVERGENCE (2026-06-10 — honest record; resolution pending)

The declaration above **no longer describes the shipped code**. The 2026-06-10 structure audit
(`docs/reports/2026-06-10-structure-audit.md`, RISK 1) found the implementation contradicts five of
this document's own "does NOT own" bullets:

| This doc says telepty does NOT own | What the tree actually ships | Evidence |
|---|---|---|
| "no retry logic, no queue, no ordering guarantees" | File-backed mailbox: enqueue/dequeue/ack/nack, exponential-backoff retry, TTL expiry, dead-letter queue, FIFO ordering | `src/mailbox/` (~1,000 LOC), `protocol/mailbox.md` |
| "sessions are in-memory; a daemon restart loses all sessions" | Sessions persisted to disk and restored on daemon startup | `src/session-store/persistence.js`; restore loop + 9 persist callsites in `daemon.js` |
| "telepty streams raw bytes; callers parse meaning" | Prompt-glyph detection per CLI, REPL-readiness gating, echo/settle detection, output→state FSM | `src/prompt-symbol-registry.js`, `src/submit-gate.js`, `session-state.js` |
| "cross-session routing … belongs to the caller or an orchestration layer above" | Reverse-match REPORT classification routing, peer-lane fan-out blocking | `daemon.js` reverse-match + peer-lane blocks |
| (implied: no orchestration policy) | pendingReports registry, auto-report firing on idle/dead transitions, idle-TTL reaper | `daemon.js` report-enforcement cluster, `src/report-enforcement.js` |

**Status of this divergence:** recorded, not resolved. The resolution — either (a) formally amend
this boundary declaration to match the code ("session transport + delivery-assurance layer"), or
(b) extract the stateful features (mailbox / session-store / report-enforcement) up into the
orchestration layer — is a **constitutional decision (D1) owned by the orchestrator**, pending per
the consolidated governance report (#586). **This section intentionally does NOT rewrite the
declaration above**; until D1 is decided, the declaration stands as the *intended* boundary and
this section stands as the honest record that the implementation has diverged from it. Do not cite
the "stateless dumb pipe" principle as if it described current behavior, and do not land new
features that widen this divergence without referencing D1.

(Housekeeping note: this file existed only as an untracked working file until 2026-06-10; it was
first committed as part of the same honesty pass — task #588.)
