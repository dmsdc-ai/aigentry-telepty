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

## Reachability is not authentication (0.8.0, #820 / #823)

Until 0.8.0 the daemon's auth middleware answered the network's question instead of the caller's:
`if (isAllowedPeer(ip)) return next()`. `isAllowedPeer` returns true for loopback, for every address
when the allowlist is empty, **and for any address that matches a non-empty allowlist** — so three
populations reached every route with no credential at all: any process on the machine, every address
on a network-bound daemon, and (because #672's tailnet auto-bind populates that allowlist on the
default configuration) every device on the operator's tailnet. Session enumeration, PTY read, PTY
write, `DELETE`, and `POST /api/sessions/spawn` with a caller-chosen `command` and `cwd` were all
open on that path.

In 0.8.0 the two questions are separated and asked in order:

1. **Origin** (#806) — a request carrying a browser `Origin` must name an allowlisted one. Absolute:
   a valid credential cannot buy past it.
2. **Reachability** — `isAllowedPeer` can only NARROW. Outside the allowlist is `403 PEER_NOT_ALLOWED`.
   An empty allowlist still means *no IP restriction*, never *no authentication*; loopback is never
   narrowed away, so a local CLI cannot be locked out by an allowlist.
3. **Credential** — the daemon token, for **every** address including loopback. Otherwise `401`.

### What the boundary now is, precisely

The line moves from *"anyone who can open a socket to the port"* to *"anyone who can read
`~/.telepty/config.json`"* (mode `0600` inside a `0700` directory) — roughly the uid boundary, plus
root.

**It does not stop a same-uid process.** An agent's shell tool, a build script, an `npm postinstall`
runs as the user and can read that file. What the change does buy:

- The network surface is no longer *weaker* than the filesystem surface. Before, reaching the port
  beat owning the file: a process denied `$HOME` still had full PTY read/write. That inversion is
  what was closed.
- A real boundary against different-uid local processes, sandboxes with a different `HOME`,
  container/VM neighbours sharing host loopback, and any port-forward endpoint that is not this user.
- Against same-uid it raises the cost from *zero* (open a socket) to *a filesystem read that is
  auditable and blockable by OS sandboxing* (macOS TCC/sandbox profiles, Linux LSM) — a lever that
  did not exist before.

> Same-uid is not a boundary telepty can create; only the OS can, and this fix is the precondition
> for ever using it.

### `/api/health` is deliberately unauthenticated, and discloses the version

It is registered *before* the auth middleware, and it must stay that way: `daemon-control.js`'s
port-ownership probe, `cross-machine.js`'s `connect-http` discovery, and the aterm GUI's version
detection all depend on it. Note what that means beyond "unauthenticated": it is registered after
`cors()` (whose default is `Access-Control-Allow-Origin: *`) and *before* the browser origin guard,
so it is the one route that answers **200 with a readable body to a disallowed `Origin`**. On the
tailnet listener it therefore offers unauthenticated version fingerprinting to any device on the
tailnet. Accepted and written down rather than closed: dropping the `version` field would break the
GUI, and if it ever does need closing the answer is binding health to loopback only.

### Cross-host HTTP peers: a credential-distribution gap with no design yet

Each node mints its own random token, so a cross-host caller must present the **target's** token.
It is resolved by address: `TELEPTY_AUTH_TOKEN` → a `peers.json` entry matching that `host:port`
(written by `telepty connect-http <host> --token <that host's authToken>`) → the local token, and
that third step is reachable **only for this machine** (`isLocalHostname`). A non-local address with
neither of the first two is REFUSED before the socket opens, with a message naming both fixes.

The refusal replaced an unconditional local-token fallback (#844). The old reasoning was that a
*wrong* credential yields a diagnosable 401 while sending none yields an ambiguity — true, and
irrelevant to the actual choice, because the local token is not merely wrong at a peer: it is this
machine's master credential, and post-#820 it is the whole boundary here. Handing it to an arbitrary
address is a disclosure, not a diagnostic, and on a tailnet the auto-populated allowlist lets the
recipient use it against the daemon that sent it. A refusal that names `connect-http --token` costs
the operator one command; the send cost them the daemon, silently.

What does **not** exist: any discovery, rotation, revocation, or per-peer scoping of those tokens.
Step 2 only helps an operator who has already run `connect-http --token`, and addressing forms with
no `peers.json` entry (`<sid>@<tailnet-ip>`, `TELEPTY_HOST`) must use the env variable or are
refused. Note the consequence worth stating: addressing **your own** daemon by a non-loopback name —
its tailnet IP, its hostname — is refused as well, because `isLocalHostname` recognises loopback
literals and nothing else. That is a deliberate false positive. The predicate is a syntactic check on
the address, and widening it to "any address this host happens to answer on" would make the boundary
depend on interface enumeration at the moment of the call. `TELEPTY_AUTH_TOKEN` is the escape hatch.
This is a named limitation, not a solved problem.

### `TELEPTY_AUTH_TOKEN` must be set for BOTH ends or neither

The daemon (`daemon.js`), the CLI (`cli.js`) and the MCP server (`mcp-server/index.mjs`) all resolve
env-then-file, in that order. It is a **fleet-wide** token, applied to every daemon the process
talks to — not a per-target one; a CLI invocation that talks to two daemons (e.g. a cross-host
`inject`, which also probes the local daemon) needs the per-address `peers.json` path instead.

The hazard to know about: the production daemon runs under launchd, whose plist supplies only
`PATH`. An operator who exports this in a shell but not for the daemon gets a client sending a token
the daemon has never heard of — a 401 that reads like a credential bug. Set it for both, or for
neither.

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

## The inject audit log — what it records, and what it does not prove (0.8.0, #826)

`~/.telepty/logs/injects.jsonl` records **both** write paths into a PTY: `POST
/api/sessions/:id/inject` (`source: "inject"`) and a WebSocket viewer's `{type:'input'}` frame
forwarded to the session owner (`source: "ws-viewer"`). Until 0.8.0 the second wrote nothing at all,
so the log was silently incomplete — and it stops being merely untidy the moment every writer is
authenticated, because that is when the log starts being read as *the* record of who typed.

Read it with three limits in mind:

- **`delivery_result` says what was measured.** `success` (HTTP path) means the daemon's delivery
  machinery reported success. `forwarded` (WS path) means only that the frame was written to the
  owner socket. They are different measurements and deliberately do not share a word.
- **`claimed_from` is a claim; `verified_sender_sid` is the measurement.** On both paths the
  verified half comes from the `x-telepty-session-token` bearer (#815) — the request header on the
  HTTP path, the handshake header on the WS path — and never from the message body or frame.
- **`classifyPeerLaneInject` (#533) is a policy guardrail, not an authentication boundary.** It now
  applies to both write paths, but on both it is keyed on the *claimed* sender, so a caller that
  states no `from` is on the operator lane by construction. Do not read a clean peer-lane log as
  proof that no peer-to-peer delegation happened.

Volume note: the WS path records one line per `input` frame, and an interactive `telepty attach`
sends one frame per keystroke. The writer is bounded (drop-oldest with an `audit_overflow` bus
event, rotation at 50 MB × 5 files), but an operator sizing this log should expect interactive
attach sessions to dominate it.

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
