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
