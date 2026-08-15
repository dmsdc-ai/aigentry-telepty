# Changelog

All notable changes to `@dmsdc-ai/aigentry-telepty` are documented here.

## 0.8.0 — unreleased

### Changed — BREAKING: telepty no longer asserts task completion (#60 Stage A)

**The daemon used to state that a task was finished, from signals that cannot measure it.** Silence,
elapsed time, a prompt glyph, a submit flag and an unqualified bridge `ready` frame were each
sufficient to emit `TASK_COMPLETE`. This happened four times in one day on this project's own
workers, every one verified false; in one case the classifier read the line
`⏵⏵ bypass permissions on · 3 shells`, called the session idle at confidence 0.6, and the daemon
turned that into a 100%-confidence sentence saying the work was done.

Transport, activity and inject-consumption are measurable. **Task outcome is not**, and nothing in
this release can produce one. `0.8.0` emits honest absence instead, and completion stays explicitly
unknown until an authenticated, correlated report exists — that is Stage B / `0.9.0`, blocked on
#816 (a private capability/report channel) and #817 (cross-machine sender identity).

- **Removed every terminal producer.** `TASK_COMPLETE`, `TASK_COMPLETE_WITH_REPORT`,
  `TASK_IDLE_UNCONFIRMED`, `TASK_ERROR`, `TASK_IDLE_NO_REPORT` and `TASK_DEAD_NO_REPORT` are gone.
  One `task_completion_unknown` observation replaces them, carrying `completion_fact: null`,
  `terminal: false`, the measured observation, a consumption verdict and an explicit capability
  block.
- **Removed the reverse-text report path.** Every payload a session routed back to whoever tasked
  it was mapped to `report_complete` — a clarifying question was recorded as that worker reporting
  its task complete, and `CHANGELOG.md` (0.2.x) recorded the mislabel as accepted. **`0.8.0` no
  longer classifies report-shaped text at all**: `classifyReportPrompt`, `REPORT_PREFIX_RE`,
  `REPORT_STATUS_*_RE` and `resolveOutboundReportStatus` are deleted. No text can authenticate its
  sender or correlate itself to a dispatch, so no text may settle one. A reverse-routed inject is
  an ordinary message.
- **Absence is now durable, and committed before delivery.** A tracked inject writes a versioned
  `tracked_injections` ledger record (temp → `fsync` → atomic rename → directory `fsync`) *before*
  bytes reach the target, and a failed commit **aborts the delivery** (`TRACKING_PERSISTENCE_FAILED`)
  rather than delivering and forgetting. The ledger survives restart, gains
  `daemon_restart_observed`, and contains no outcome field at all.
- **Added `GET /api/inject-observations/:inject_id`.** Always HTTP 200 with a discriminated
  schema-v2 body; an absent, pre-v2 or corrupt record is `tracking_state: "unavailable"` with a
  named top-level `reason`. **Schema v2 never uses 404 as a task-state signal** — "no record" and
  "finished" are different statements and a status code cannot tell them apart. An unauthenticated
  caller gets 401 from the auth middleware, which means "prove who you are", not "absent".
- **`telepty inject` now prints the transport `inject_id`** (own line, `inject_id: ` prefix). It
  previously existed only inside the daemon, so no consumer could correlate a dispatch to anything.
- **Every observation entry point is total.** The transition handler, ready frame, ready dwell,
  settle and CPU re-arms, the consumption branch, session death, supersession, cancellation and
  restore each return a *named* result (`observation_emitted`, `observation_duplicate`,
  `unmapped_transition_cause`, `tracking_superseded`, `tracking_unavailable`,
  `observation_deferred`, `tracking_persistence_failed`). The `#52` consumption gate — a bare
  `return` that emitted nothing and set nothing — is deleted: consumption is a *field* on the
  observation, never a gate in front of one.
- **Retired the `idleNotified` latch.** A one-way "already spoke" bit was burned by a wrong-label
  emission and then dropped the later genuine observation. Duplicate suppression is now keyed on
  observation identity in the ledger, where it cannot become an authority gate; a *different*
  measurement on the same inject is still emitted. `idle_notified` is gone from
  `GET /api/pendingReports/:id`.
- **External activity vocabulary is measurement-cause-based (§2.3).** Names are selected from
  `(destination, normalized cause, required evidence)` and fail closed to
  `unmapped_transition_cause` — never to a state-name fallback. Producer triggers that used to
  collapse several measurements into one name are split: `osc_133_prompt` into
  `osc_133_a_or_b_received` / `quiet_after_recent_osc_133_a_or_b`, `lifecycle` into
  `lifecycle_starting` / `lifecycle_restarting` / `process_exit`, and the shared `pattern` into
  `input_request_pattern` / `busy_indicator_pattern`. `markIdle` can no longer let caller detail
  overwrite the normalized cause. The internal 8-state FSM is unchanged — submit and readiness
  code branches on it.
- **Consumption admission is strict, with rejection precedence.** `consumption.status: "observed"`
  requires a fresh post-submit `idle|waiting → working|thinking` edge **and** an accepted,
  non-ambiguous, *screen-derived* submit confirmation (`body_consumed`, `state_working`,
  `state_thinking`). A positive submit rejection is evaluated **before** any durable field, so a
  stale `injectConsumedAt` cannot override it. `force`, `gate_off`, `redelivered` and `empty_body`
  accepts measure no screen and no longer count. The `#721` launcher watermark keeps its whole
  calculation but is now `submit_accepted_and_output_advanced` telemetry with consumption
  `not_established` — it never measured consumption, and a never-started worker can satisfy it.
- **Breaking for consumers:** `autoState.state` is replaced by `activityObservation` (named by
  cause, neutrally styled — quiet is never green/done) plus a separate `completion` block;
  `/api/sessions/:id/state` renames `auto` to `activity_observation`; the bus event
  `session_auto_state` becomes `session_activity_observation`.

Stage A deliberately adds **no new fact detector**. OSC 9;4 is real but in-band and unattributed —
a child's progress clear closes the parent's bracket — so it stays telemetry and is never promoted.
The `#32/#48/#52/#537/#545/#619/#721` compensation stack is retained (Stage D removes it
separately); the settle window now only debounces *follow-up* observations, which is not silence
because the durable `tracking_started` record already exists and is pollable.

### Security — BREAKING: reachability is no longer authentication (#820, #823)

- **Every caller must now present the daemon token — including callers on loopback (#820).** The
  daemon has always minted a token in `~/.telepty/config.json`, and the `telepty` CLI has always
  sent it. But the auth middleware answered the network's question instead of the caller's: if the
  peer-address policy said "allowed", it returned early and the credential was never consulted. On
  a default install that meant any process on the machine could list sessions (with their `command`
  and `cwd`), read and write any PTY, `DELETE` sessions, and `POST /api/sessions/spawn` with a
  `command` and `cwd` of its choosing. The WebSocket upgrade — the attach viewer and `/api/bus`
  alike — had the identical shape.

  The two questions are now separated and asked in order: **origin guard → peer reachability →
  credential → route.** #806's property is unchanged (a valid credential still cannot buy a
  disallowed browser origin).

- **The peer allowlist narrows reachability and no longer grants authentication (#823).** An
  address outside `TELEPTY_PEER_ALLOWLIST` gets `403 PEER_NOT_ALLOWED`; an address inside it still
  has to present the token. This branch was the one that read as safe and was not: a *matching*
  allowlist entry returned "allowed" exactly as completely as an empty list did, and #672's tailnet
  auto-bind puts the tailnet CIDR into that list **on the default configuration** — so every device
  on an operator's tailnet reached every route uncredentialed. An empty allowlist still means *no
  IP restriction* (turning it into deny-all would break tailnet reachability for no gain), and
  loopback is never narrowed away, so a local CLI cannot be locked out by an allowlist.

  Operators who worked around this with `TELEPTY_NO_TAILNET_AUTO=1` no longer need it: the tailnet
  listener can be left on, because it now requires a credential like every other address.

- **A refused WebSocket upgrade is now distinguishable from a daemon that is not there.** The
  refusal used to be a bare `HTTP/1.1 401` immediately followed by `destroy()`, which raced the
  write — clients frequently saw ECONNRESET, i.e. an `error` event and close **1006**, byte-identical
  to a dead daemon, so a bridge reconnected forever in silence against a daemon that was answering
  and declining. Refusals are now complete HTTP responses (`Connection: close`, JSON body with the
  same `code` the HTTP middleware uses, `X-Telepty-Refusal` header) flushed before the FIN, so `ws`
  clients get `unexpected-response` with a readable status. `telepty attach` no longer crashes with
  an unhandled `error` event on a refused handshake; it prints which fault it was.

- **Cross-host callers must present the TARGET's token, resolved by address — and a target with no
  credential of its own is REFUSED, never handed the local one (#844).** Each node mints its own
  token, so the local one is not valid at a peer. Resolution order is `TELEPTY_AUTH_TOKEN` → a
  `peers.json` entry matching that `host:port` → the local token **for this machine only**; a
  *wrong* token still yields a diagnosable 401, and no path we do dial sends none. A non-local
  address with neither of the first two is refused before the socket opens, with a message naming
  `connect-http --token` and `TELEPTY_AUTH_TOKEN`.

  The refusal replaces a silent send that this release is precisely what made dangerous. The
  resolver ended in an unconditional `getAuthToken()`, so any command aimed at an address with no
  stored entry put **this machine's daemon master token** on the wire in cleartext, to whoever
  answered. That was inert in 0.7.1 because the target trusted every caller and never read the
  credential. Now that token is the whole boundary on the *sending* side, and on a tailnet #672's
  auto-populated allowlist lets the recipient turn it straight back on the daemon that sent it —
  one mistyped host, `telepty inject sess@10.0.0.5`, was enough, with no output at all.

  `telepty connect-http <host> --token <that host's authToken>` has always stored `entry.token` and
  nothing ever read it, because the lookup was keyed on a peer name the dial sites had already
  dropped — that stored credential is now reachable, and it is what a non-local target must have.

  What the refusal measures: whether the hostname in the URL is a loopback literal (`127.0.0.1`,
  `localhost`, `::1`, `[::1]`). What it does **not** measure: whether a non-loopback address is in
  fact this same host. Addressing your own daemon by its tailnet IP or its hostname is refused too —
  a deliberate false positive, because the alternative is a credential boundary that depends on
  interface enumeration at the moment of the call. `TELEPTY_AUTH_TOKEN` is the way through. It also
  distributes no credentials and revokes none; `BOUNDARY.md` still records that gap as open.

  **Migration, and it is the only user-visible one:** run `telepty connect-http <host> --token
  <that host's authToken>` once per HTTP peer. This is now required rather than advisable: without
  it, a cross-host command is refused instead of quietly failing a 401. `TELEPTY_AUTH_TOKEN` is
  honoured by the daemon, the
  CLI and the MCP server (env-then-file at all three); it is a fleet-wide token and must be set for
  the daemon too, or the client sends one the daemon has never heard of.

- **Rotating the shared daemon token requires a daemon restart, by design.** The daemon reads
  `~/.telepty/config.json` once, at boot, and never looks at it again. An operator who edits the
  config under a running daemon gets 401s from every caller until it is restarted — that is correct
  behaviour, not a bug, and it is the first thing this release's refusal message says. Re-reading
  per request would widen the boundary from *"whoever can **read** this file can drive the daemon"*
  to *"whoever can **write** it owns the running daemon"*, turning a file write into a silent
  credential takeover of the process that parents every live session, with nothing in any log. The
  freeze is what keeps rotation an explicit, observable act. Recorded in `BOUNDARY.md`; stated here
  because the 401s are what an operator actually hits.

- **Who must act:** anyone with a hand-rolled `curl 127.0.0.1:3848/api/...`. Add
  `-H "x-telepty-token: $(jq -r .authToken ~/.telepty/config.json)"`. `telepty` CLI users are
  unaffected. `/api/health` stays unauthenticated, so liveness probes, `connect-http` discovery and
  GUI version detection are unaffected. Mixed fleets are safe in both directions: an old client
  against a new daemon fails closed with 401; a new client against an old daemon works (the extra
  header is ignored, and #844 below is what makes the *CLI* side of that true — the version probe
  used to declare an old daemon broken before the header ever mattered). No credential is minted,
  rotated or migrated.

- **What this does NOT fix, stated plainly:** the boundary moves from *"anyone who can open a socket
  to the port"* to *"anyone who can read `~/.telepty/config.json"`* — roughly the uid boundary. It
  does **not** stop a same-uid process, which is the adversary most worth naming here: an agent's
  shell tool, a build script, an `npm postinstall`. What it does buy is that the network surface is
  no longer weaker than the filesystem surface, and that OS sandboxing now has something to bite on.
  See `BOUNDARY.md`, which also records the cross-host credential-distribution gap and the
  deliberate `/api/health` exposure.

- **The WebSocket viewer write path is now audited and policy-checked (#826).** A viewer's
  `{type:'input'}` frame is forwarded to the session owner as an inject — a write into somebody's
  terminal with exactly the authority of `POST /api/sessions/:id/inject`, and until now with none of
  its accountability: no audit line, no #533 peer-lane check, no provenance labelling. It is
  included in this release rather than deferred precisely *because* of the fixes above: while
  anything on the box could write uncredentialed the audit log was obviously incomplete, but the
  moment a credential is required of writers an operator will reasonably read that log as the record
  of who typed. That door now produces a schema-v1 line with `source: "ws-viewer"` and
  `delivery_result: "forwarded"` — deliberately not `"success"`, because all that path measures is
  that the frame was written to the owner socket. `classifyPeerLaneInject` (#533) runs on it too,
  keyed on a *claimed* sender, so it remains a policy guardrail and not an authentication boundary.

  **What is written to a PTY and still is not logged**, because a count is not an enumeration and
  the log is about to be trusted: a viewer's `{type:'input'}` frame on the **spawned** branch (it
  writes straight to `ptyProcess`, so `ws-viewer` lines do not mean every viewer write is recorded),
  `busAutoRoute` → `deliverInjectionToSession` (the `source: "inject"` audit lines live in the HTTP
  route handler, not in the delivery function the bus path calls), and `POST
  /api/sessions/:id/submit`, which writes a bare `\r`. `BOUNDARY.md` carries the full table of
  recorded doors (`inject`, `multicast`, `broadcast`, `ws-viewer`) beside that list, and states that
  it is a measurement rather than a proven ceiling. An interactive `telepty attach` produces one
  audit line per keystroke.

### Security
- **Session sender identity is now bound to a session instance rather than to a session name
  (#815).** The daemon's per-session token — the thing that makes `verified_sender_sid` mean
  anything — was issued against a session *id*, re-issued on demand to any local caller that named
  an already-registered id, and never revoked. The identity a caller could obtain therefore did not
  depend on being that session, and an id that was cleaned up and respawned inherited its
  predecessor's authority for the lifetime of the daemon. The same held for the per-session
  provenance nonce (#47 P4), which is what an agent checks before trusting a delivery's origin
  banner.

  The principal is now `(canonical_sid, session_epoch, credential_generation)`. A credential is
  minted exactly once, at the first registration of an id the daemon does not already hold; a
  re-registration returns no credential material to anyone, including the legitimate holder; and
  every destroy path — `DELETE`, kill, forced cleanup, TTL/GC — revokes the epoch before the id can
  be reused, so a recreated id can never resolve to its predecessor. Verification fails closed: an
  unparseable, unknown, stale or revoked credential yields no verified sender, never a fallback to
  the name the caller claimed.

  The daemon stores only `sha256(bearer)` and persists **that verifier**, never the bearer. This is
  what lets a session survive a daemon restart without reissuing anything — the wrapped child holds
  its credential in a spawn-time environment that cannot be updated from outside, so a reissued
  credential could never reach it. `sessions.json` consequently became owner-only (`0600`), and is
  chmod'ed on read as well as on write so a file left world-readable by an older daemon is
  tightened in place rather than at the next write.

- **Taking ownership of a live session now requires proving you own it (#815).** A `?owner=1`
  WebSocket claim was authenticated by nothing but knowledge of the session id, and the daemon
  trusted loopback before any credential check (closed by #820 above), so the claim was open to any
  local process. Because
  ownership is last-writer-wins, a claim also displaced the incumbent bridge with close 4001 — and
  a displaced bridge exits its session. A session that holds a credential now requires the matching
  bearer on the handshake or the claim is refused with close `4003`, loudly, rather than downgraded
  to a viewer. Sessions with no credential (the WS auto-register reconnect path, records restored
  from an older daemon) claim as before, so reconnect is unaffected.

- **`inject_written` no longer rebroadcasts the prompt (#815).** Any local process could subscribe
  to `/api/bus` with no token and no `Origin` (the token half is closed by #820 above), so the event
  published the full text of every delivery to every local subscriber. It now carries `content_sha256` + `content_length` instead of
  `content` — enough to correlate a delivery and verify integrity against a payload you already
  hold, and nothing to read if you do not. **Breaking for any bus subscriber reading
  `inject_written.content`.**

- **A re-registration can no longer redirect where a session's injects are delivered (#815).**
  `delivery` / `delivery_endpoint` are mutable only by a caller holding the session's current
  credential. Sessions with no credential are unaffected.

### Fixed — a refusal is not a licence to destroy, and absence of evidence is not evidence of absence (#844)

#835 established that a daemon which ANSWERS and declines is not a daemon that is absent, because
the "absent" verdict is what authorises SIGTERM/SIGKILL against the process that parents live PTY
sessions. Two independent reviews of this release found the rule broken in five further places,
listed below — including, twice, in code this release itself added. Five is what those reviews
found, not a proven ceiling; the rule is what to check against, not the count. They are grouped here
because they are one rule: **a destructive action requires positive evidence of the condition it
destroys on.**

- **A REFUSED owner claim no longer tears down the incumbent it was refused against.** `telepty
  allow --id X` against an id the daemon already holds is a re-registration, so #815 correctly
  issues it no credential and the daemon refuses its `?owner=1` claim with close `4003`. The
  bridge's 4003 handler then ran the ordinary exit path — which issues `DELETE /api/sessions/X`,
  carrying an `owner_token` only if it has one. It never had one. So the DELETE went out bare, the
  #536 owner-token guard had nothing to compare, and the healthy incumbent was destroyed by the one
  process the daemon had just told it does not own that id. The dup-id/respawn race that produces
  this is routine. The refused bridge now exits without the teardown DELETE and without purging the
  bridge mailbox; the session and its queued deliveries belong to the owner, not to it.

- **A `404` on `/api/meta` is an old daemon, not a broken one.** The version probe classified every
  non-2xx as "the daemon answered", and aborted with *"running, but not serving"* — a cause it had
  not determined. `/api/meta` was added 2026-03-12, so a daemon predating it answers 404 for exactly
  the reason it answers 200 on `/api/sessions`. `telepty list` against such a daemon died on that
  message, which killed the legacy-upgrade path and falsified this release's own claim above that a
  new client against an old daemon works. Scoped to that route: 401/403/5xx from it still abort, and
  a 404 from anywhere else is not the same statement.

- **A daemon the supervisor brought back REFUSING is no longer reported as never having come back.**
  `getDaemonMeta` has three consumers; #835 taught two of them that a non-200 is an answer and left
  `deferToSupervisor` accepting only a version. A live daemon returning 401 was therefore reported
  as *"the supervisor did not restore it in time"*, and that verdict routes into
  `cleanupDaemonProcesses()`. It now hands the answer back to the policy, and the policy's `abort`
  is honoured on that path too — it was previously checked only *before* the supervisor wait, so a
  refusal discovered during the wait fell straight through to the restart.

- **The cmux surface GC signals instead of killing, and can no longer read a non-listing as an
  absence.** `isSurfaceAlive` decided `gone` from a substring scan of `cmux list-workspaces` output,
  so a truncated, localised, half-succeeded or reformatted listing produced `gone` with exactly the
  confidence of a real answer — and a session whose workspace id is a short-ref rather than a uuid
  could never match the uuid-formatted listing at all. Only a listing that parses as an enumeration
  and demonstrably omits the id is now `gone`; everything else is `unknown`, which GCs nothing.
  Beyond that, the GC block runs **only** for sessions whose owner socket is open, so it was using a
  uuid's absence from another tool's stdout to override this daemon's own present-tense measurement
  that the session is alive. That ordering is reversed: the open socket blocks the reclaim, and what
  remains is the `surface_orphaned` signal — emitted once, carrying `ownerSocketOpen: true` and
  `reclaimed: false`. The `INV-17` comment there claimed a guarantee broader than the measurement
  provided and has been rewritten to what the code establishes.

  **Nothing downstream reclaims the session today, and you should not read this note as saying it
  does.** telepty emits `surface_orphaned` on the WebSocket bus. What the orchestrator runs
  always-on is a different path — its `wh_alive` sweep — and that closes the **surface**, not the
  session. Its event-driven consumer for this signal reads a `state/surface-orphaned.jsonl` file
  that nothing currently writes: there is no bus→file bridge, so the consumer is dormant (tracked as
  orchestrator task #847). **Net effect for an operator: a wrapped cmux session whose workspace is
  gone while its owner socket stays open now persists until the disconnect-GC or an explicit
  cleanup, instead of being reclaimed here.** That is still the better trade — the previous
  behaviour destroyed such a session on a measurement weaker than the open socket it was overriding
  — but it is a real gap and it is stated rather than left to be discovered.

- **The daemon state-file pid is confirmed before it is signalled.** `cleanupDaemonProcesses` builds
  its kill set from three sources. Two confirmed identity first — the port-owner source via
  `pidMatchesTeleptyCmdline` ("so we never SIGTERM an arbitrary process that happens to own the
  port"), the process-scan source via `isLikelyTeleptyDaemon` — and the state-file source added its
  pid with no check at all, even though that is a pid telepty *wrote* rather than one it measured. A
  stale state file surviving a pid rollover named a stranger, and `stopDaemon` documented a surgical
  guarantee it never verified. The state-file source, the process-scan source and the port-owner
  source now each confirm identity before contributing a pid.

- **The release artifact no longer lies about which release it is.** `package.json` `version`, and
  `package-lock.json`'s `version` and `packages[""].version`, still said `0.7.1` — the version
  already published on npm — while the notes above describe 0.8.0. `/api/meta` reports that string,
  and a version-equal daemon is treated as healthy, so a 0.8.0 CLI meeting a running 0.7.1 daemon
  would have accepted it and kept talking across wire semantics this release changed. The suite
  checked only that the version was semver-shaped, which `0.7.1` satisfies perfectly.

  What the new release invariant measures: those three manifest fields agree with each other; the
  newest `## ` section in this file names exactly that version and is a version heading rather than
  a placeholder; no version has two sections; and no section below it names a higher version. What
  it does **not** measure: whether the version is free on npm, whether a git tag exists, and whether
  the prose under the heading describes the code — it compares declarations to declarations.

### Added
- `session_owner_replaced` bus event (#815): a `?owner=1` claim that displaced a **live** owner
  previously emitted no event at all, leaving the session record looking healthy under the new
  socket while its assignee had exited. The daemon now states the fact it actually observed. It is
  not interchangeable with `session_reconnect` and implies no process-exit observation. See
  `BUS_EVENT_SCHEMA.md`.
- `verified_sender_epoch` / `verified_sender_generation` on inject audit lines and on
  `inject_written`, completing the principal so a consumer can tell which *instance* of a session
  id sent something.

### Notes
- Sessions that are live across the upgrade lose sender attribution once, at the restart that
  installs it: they have no persisted verifier, and their in-memory credentials did not survive a
  restart before this change either. Not a regression, but visible outside a maintenance window.
- What sender authentication does and does not prove — including a measured platform split on
  whether a same-uid process can read a bearer out of another process's environment, and the
  first-claim residual — is documented in `BOUNDARY.md`.

## 0.7.1 — 2026-07-26

### Security
- **Any website the user visited could drive their AI CLI sessions.** The daemon listens on
  loopback and `isAllowedPeer` trusted `127.0.0.1`/`::1` unconditionally and *first*, before any
  token check, so a page in the user's browser could `fetch('http://127.0.0.1:3848/api/sessions/
  <sid>/inject', {method:'POST', …})` and type into a live session with no token and no
  interaction — the response is CORS-gated, but the request executes, which is the whole attack.
  A WebSocket handshake is not CORS-gated at all, so `new WebSocket('ws://127.0.0.1:3848/api/
  sessions/<sid>')` was unauthenticated read/write on somebody's terminal. Loopback trust is not
  authentication against a browser. Fix: browsers always attach `Origin` to a cross-origin fetch
  and to every WS handshake, while curl, the telepty CLI, and SSH-tunnelled peers never do — so a
  request that *carries* `Origin` must now name an explicitly allowlisted origin
  (`TELEPTY_ALLOWED_ORIGINS`, comma-separated, **empty by default** = no web page may call the
  API) or it is refused 403 before the loopback/token branches. The guard is checked first, so a
  leaked token cannot buy a disallowed origin past it, and `Origin: null` (sandboxed iframe,
  `file://`) is a value rather than an absence and stays blocked. Reads are guarded as well as
  writes: `GET /api/sessions` discloses session ids and cwd paths, `/screen` discloses the
  terminal itself, and the daemon answers `Access-Control-Allow-Origin: *`, so a page really
  could read those bodies back. Origin-less callers take exactly the path they took before, so
  every existing CLI, tunnel, and peer flow is byte-identical. No new auth scheme, token file, or
  config format.

### Fixed
- **#801** a wrapped AI-CLI session that dies on an API/transport error is no longer reported to
  its dispatcher as a completion. The dead session goes quiet, so the idle detector fires and the
  auto-report used to emit `TASK_COMPLETE: <sid> is now idle after processing inject` — observed
  6× on 2026-07-26 (claude `API Error: 529 Overloaded` ×5 at 204–330s, codex
  `invalid_request_error` ×1 at 10.8s), indistinguishable from a real completion without reading
  the screen. `src/prompt-symbol-registry.js` gains a per-CLI terminal-turn-failure marker table
  (`detectSurfaceError`) alongside #737/#760's modal table, measured against real PTY bytes from
  claude 2.1.220 and codex 0.145.0 (`scratchpad/capture-801-api-error.js`); the auto-report path
  consults it over the ring slice appended past the inject watermark and emits a distinct
  `TASK_ERROR: <sid> went idle after an API/transport error (<detail>)` instead. Unlike the modal
  predicate there is no composer counter-signal — both CLIs repaint the composer *after* the
  error banner, which is the symptom, not recovery — so the turn watermark is what scopes the
  verdict. Fail-open throughout: an unmeasured CLI (gemini, shells), a missing watermark, or an
  unrecognised screen keeps today's emission byte-for-byte, and `TASK_IDLE_UNCONFIRMED` /
  `TASK_IDLE_NO_REPORT` semantics are untouched — the check only runs where the daemon was about
  to assert the inject had been processed. No new daemon, no new state file, no new config knob.
- **#757** supervised version-change restarts no longer create a first-pass orphan outside launchd/systemd/schtasks. Reproduced with a scratch launchd label and port: a detached `telepty-daemon` owning the port made `launchctl kickstart -k` exit the managed job with code 0 while the detached pid kept serving; killing that pid and kicking again recovered. Fix: supervised `restartDaemonGraceful` now restarts through the detected OS supervisor and never falls back to `detached + unref` for supervisor-managed installs, while unsupervised hosts keep the existing detached restart path. Global `postinstall` uses the same supervisor-owned restart rule, so upgrades no longer preempt launchd with a detached replacement.

## 0.7.0 — 2026-07-26

### Removed — BREAKING (over-engineering cuts, ecosystem cleanup audit 2026-07-26)

Dormant surfaces with zero observed adopters across the ecosystem are gone. Every
removal below was verified by repo + cross-repo grep (`aigentry-*`, excluding
`node_modules`/`dist`) before being applied.

- **Broker relay (#42)** — `telepty broker`, `telepty connect-broker`, and
  `telepty install --broker` are removed, along with `src/transport/broker-{server,client,protocol}.js`,
  the daemon's `TELEPTY_BROKER_*` wiring (broker-mode HTTPS listener, node-mode
  broker-client), and the broker-host service variant in `install.js`. Activation
  always required operator-provisioned `TELEPTY_JWT_SECRET` + `TELEPTY_ENROLL_SECRET`
  + TLS cert/key and was never switched on. Cross-machine traffic continues on the
  wired SSH/HTTP peer path (`cross-machine.js` + `src/transport/websocket.js`).
  `BUS_EVENT_SCHEMA.md` §Broker Relay Events is removed with it.
- **TUI dashboard** — `telepty tui` / `telepty dashboard` and `tui.js` are removed;
  this also drops the `blessed` dependency (unmaintained since 2015). `telepty list`
  + `telepty listen` cover observation, and the terminal multiplexer is the dashboard.
- **Kitty surface orchestration** — `telepty session start` and `telepty layout` are
  removed. Terminal-surface lifecycle belongs to the Workspace Host adapter per
  `BOUNDARY.md`; the daemon stopped foregrounding surfaces on 2026-05-30.
- **Rust supervisor sidecar (Phase 1 spike)** — `crates/` (telepty-supervisor-core,
  telepty-supervisor-bin, telepty-cross-machine), the cargo workspace
  (`Cargo.toml`/`Cargo.lock`/`rust-toolchain.toml`), `src/bridge/`
  (j3-shim, supervisor-ipc, supervisor-launcher), the two lazy bridge call sites in
  `cli.js`, the `scripts/{bridge-phase1.js,m2-smoke.sh,m3-smoke.sh,measure-rss.sh}`
  harness, and `.github/workflows/phase1-spike-ci.yml` are removed. `daemon.js` PTY
  ownership is the live implementation; the crates never shipped in the npm package.
  Resurrect from git history if the L2 supervisor migration ever resumes.
- **Bus-event peer relay** — `src/transport/peer-relay.js` and the
  `TELEPTY_RELAY_PEERS` env knob are removed (the knob was set nowhere).

### Changed

- `auth.js` token generation uses Node's stdlib `crypto.randomUUID()`; the `uuid`
  dependency is dropped.
- The `update-notifier` dependency (~80 transitive packages) is dropped along with its
  `NO_UPDATE_NOTIFIER` / `TELEPTY_DISABLE_UPDATE_NOTIFIER` opt-outs. Version-drift
  detection already runs in `src/version-handshake.js` on every daemon contact, and
  `telepty update` owns the upgrade path.
- Repo-root hygiene: the committed `aigentry-telepty-0.0.4.tgz` release tarball,
  `.deliberation_request{2,3}.json`, `test-pty.js`, and `URGENT_ISSUES.resolved.md`
  are untracked.

## 0.6.19 — 2026-07-26

### Fixed
- **#752** an ad-hoc `telepty allow --id P claude` session accepted injects, reported `✅ Submitted via pty_cr`, and delivered NOTHING — for the life of the session. Reproduced 3/3 against the real Claude Code 2.1.220 binary on a harness daemon (`scratchpad/repro-752-real.js`): +0 pane bytes for 35s, and both messages sitting `pending` in the bridge's own FileMailbox (`~/.aigentry/mailbox/bridge/<sid>/state.jsonl` — the body, and the CR queued behind it for order). Root cause is a detector that cannot see a real claude composer: `ENTRIES.claude.detect` required an EMPTY caret row (`/^([❯>])\s*$/`), but a fresh claude paints a placeholder hint INSIDE the empty composer (captured verbatim: `❯ Try"refactordaemon.test.js"`), so `detectOutput` answered `found:false` forever. `telepty allow` gates delivery on exactly that signal for a KNOWN AI CLI (`observePromptReady`), so `promptReady`/`firstReadyObserved` never flipped: `isIdle()` stayed false, every inject queued in the bridge mailbox, and `scheduleIdleFlush()` deliberately withholds its 5s safety flush from a known AI CLI that has never been ready — the same never-true flag. Nothing ever drained the queue, and the daemon could not tell: for a wrapped session `writeDataToSession` means "handed to the owner WebSocket", so `/inject` and `/submit` both answer success. Launcher-wrapped production sessions were unaffected precisely because their `command` is a wrapper `.sh` path — not a known CLI — so they take the permissive legacy prompt regex AND get the 5s fallback flush; naming the CLI directly is what turned the strict gate on. Fix: `claude.detect` now decides POSITIONALLY first (last modal marker vs last live-composer marker — the same #737 rule `detectSurfaceModal` uses, correct on both a rendered snapshot and the bridge's append-only byte stream), keeping the strict empty-caret scan ahead of the marker fallback so `line_index`/`col` geometry and the #679 `> markdown blockquote` rejection are unchanged. The marker lists are #760's, measured against real 2.1.220 PTY bytes; the composer-box form used for a positive READY verdict is tightened to the `❯` caret (the ASCII-`>` arm stays in the modal counter-signal, where fail-open is the safe direction). Verified end to end: `[READY]` at 1.15s, body delivered, claude replied, bridge mailbox drained empty.
- **#754** a bridge reconnect could silently strip a session's CLI identity — the registry ended up holding the literal string `wrapped` as `command`, and every identity-gated feature switched itself off with nothing logged: the bootstrap readiness gate (`isBootstrapGatedSession`), the #737/#760 modal gates (`detectSurfaceModal`/`modalRemedy`), the #730/#716 bracketed-paste envelope, and the submit render-gate's registry lookup — `isKnownAiCli('wrapped')` is simply false. Source: the WS `connection` handler FABRICATES a session record when the URL names a session the daemon does not know (`src/transport/websocket.js`), hard-coding `command: 'wrapped'`. `telepty allow` does re-register before reconnecting, but that POST is fire-and-forget behind a bare `catch {}` — when it loses the race (daemon still coming up) the fabricated record is what survives. Fix: the bridge states its identity on the owner-claim URL (which already carries `owner=1` and `owner_pid`) and the auto-register uses it; absent param keeps the old `wrapped` fallback, so a pre-fix bridge is byte-identical. A record the daemon already has is never restamped (unchanged).
- **#760** Claude Code modals swallowed injects the same way #737's codex update modal did. Observed twice on 2026-07-26 on the production orchestrator: (a) a worker REPORT's text was SPLICED into the middle of the user's in-progress `AskUserQuestion` answer; (b) 3 REPORT injects were silently lost across one plan-mode approval window (#743). #737 shipped the whole mechanism — positional `detectSurfaceModal`, a fail-open `isSurfaceBlockedByModal` gate on all three write paths, a remedy selector — but scoped detection to codex, so every other CLI kept pre-#737 behavior. Fix: (A) claude modal/composer marker lists in `src/prompt-symbol-registry.js`, behind the same positional last-signal-wins rule (`SURFACE_MODAL_RULES` is now a per-CLI table; codex's entry is unchanged). Every claude pattern is whitespace-TOLERANT because claude renders through Ink, which paints differentially — runs of spaces are emitted as `ESC[<n>C` cursor jumps, so after ANSI-stripping the byte stream reads `Entertoselect·Esctocancel`; measured `grep -F "Enter to select"` over the captured ring = 0 hits while the screen shows it plainly, so a literal-space pattern matches a rendered snapshot and misses the stream the delivery path reads. (B) a new `park` remedy, the per-CLI default for claude: `hold` keeps the HTTP request open, which fits codex's transient machine-owned modal but not a plan approval that waits on a human for minutes — `telepty inject` is a plain undici fetch whose 300s headers timeout would hand the caller a network error while the daemon delivered anyway. `park` acks immediately, queues the op on the EXISTING per-session bootstrap FIFO, and drains it in order once the surface clears (bounded by `TELEPTY_MODAL_PARK_TTL_MS`, default 600s to match `TELEPTY_BRIDGE_INJECT_TTL_SECS`, then flushed with an actionable `modal_park_timeout` event). Both halves of `inject --submit-force` — the body and the CR, two separate requests — park on the same queue, and anything arriving behind a backlog parks too, so a dispatch cannot overtake a parked one while the drain catches up. `drainBootstrapQueue` now consults the modal gate itself, since the boot path reaches it without one. Measured on real Claude Code 2.1.220: a surface sitting on a modal emits **+0 bytes over 45s**, so the positional verdict cannot drift while a modal is parked and polling is the only way to notice the clear. `TELEPTY_MODAL_REMEDY=off` restores the previous behavior.
- **#760 (adjacent)** `executeBootstrapInject` was the one inject path that wrote the body un-enveloped — the mailbox path has wrapped it in bracketed paste since #716/#730, and #730 measured that the un-enveloped MULTI-LINE shape is exactly what swallows the following CR (1/7 even at a 127ms gap; the envelope was 0/9). Harmless while that queue only carried boot-time injects; load-bearing once a modal park routes worker REPORTs — multi-line by definition — through it. Fixed in the shared function so the boot caller stops rolling the same dice.

## 0.6.18 — 2026-07-26

### Fixed
- **#732** bridge→daemon output pipe could die silently while injects kept working — a wrapped session's upstream leg (PTY → bridge → owner-WS `output` frames → ring/screen) has no liveness signal of its own: node-pty builds the read and write sides as separate objects over one master fd, and an in-tree path (`unixTerminal.js` swallowed `EAGAIN`) kills the read side with no `exit`, no `close`, and no WS teardown. Health kept reporting CONNECTED (it only checked `isOpenWebSocket(ownerWs)`), `lastActivityAt` was self-poisoned by the daemon's own inject path, and the one true upstream watermark (`outputRingTotalBytes`) had zero readers. Live signature (2026-07-13 demo-codex4): injects processed for hours while read-screen/attach served stale bytes. Fix: (1) dead-upstream detection over the ring watermark — health now distinguishes socket-alive/pipe-dead as `UPSTREAM_STALLED`; (2) inject into an upstream-stalled session returns 503 `UPSTREAM_STALLED` instead of a plain success into an unobservable session; (3) bridge-side liveness frame plus PTY read-side self-defense (re-arms the reader; recoverable stalls now recover, unrecoverable ones are detected); (4) owner `output` frames route through the live session record instead of a connect-time snapshot, closing a latent silent-drop after session-object replacement.
- **#738** ensure-daemon-running vs supervisor kickstart race — any telepty CLI that ran inside the few-hundred-ms `launchctl kickstart` gap decided "no daemon" (~600ms probe budget vs 1s+ supervisor relaunch), spawned a detached daemon that grabbed the port, and forced the supervisor instance into a silent `exit 0` loop: an orphan outside launchd with unwired logs (the #733 mechanism; 3 recurrences, one with no operator command at all). Fix: supervisor-aware defer — before auto-spawning, the CLI detects an installed supervisor (macOS LaunchAgent plist / Linux systemd unit / Windows `schtasks`, lazily and memoized per process) and, if present, waits up to `TELEPTY_SUPERVISOR_WAIT_MS` (default 10s) for the supervisor's daemon, then re-decides against the delivered daemon (a stale/incapable one still takes the normal restart path). No supervisor installed ⇒ byte-identical pre-#738 auto-spawn. Broken-supervisor verdicts cache 5min in `~/.telepty/supervisor-defer.json`; kill-switch `TELEPTY_NO_SUPERVISOR_DEFER=1`.
- **#737** codex update modal swallowed the first inject — and ran an unattended upgrade. A codex whose `$CODEX_HOME/version.json` has `dismissed_version` < `latest_version` boots into a blocking modal whose PRE-SELECTED item is `1. Update now (runs \`brew upgrade --cask codex\`)`. telepty's inject shape — bracketed-paste body (#716/#730) + a separately-written CR — moves no selection, so the CR ACTIVATED that default: codex shell-exec'd brew and exited. The message was lost AND the session died. Deterministic on real codex 0.144.1 at 19/515/1523ms text→CR, i.e. a surface STATE, not #730's paste-burst race. The registry already classified the screen as `codex_modal_ui`, but nothing on the delivery path consulted it: its only consumer (`submit-gate.awaitPromptSymbol`) is cmux-only AND advisory, the force path returns before Layer 3 runs, and `deliverInjectionToSession` never asked at all. Fix: (A) `detectSurfaceModal` in the CLI registry decides by POSITION — last modal marker vs last live-composer marker — because the PTY output ring is an append-only byte stream where a presence check reports `codex_modal_ui` forever after a dismissal; (B) a fail-open `isSurfaceBlockedByModal` predicate over that ring, consulted by all three write paths (plain inject, gated submit, forced submit) through one shared `resolveModalGate`; (C) the default remedy holds the body until the surface clears (`TELEPTY_MODAL_REMEDY=hold`, bounded by `TELEPTY_MODAL_HOLD_MS`, default 30s) and falls back to an actionable `SURFACE_MODAL` refusal instead of ever writing into a modal. `TELEPTY_MODAL_REMEDY=off` restores the previous behavior.

### Rollout
- #732 needs BOTH a daemon restart and bridge respawns to get the liveness frame + read-side self-defense (old bridges keep working; they just lack the new upstream signals until respawned). #737/#738 are daemon/CLI-side — daemon restart + new CLI binary. Non-codex CLIs and non-modal codex surfaces are byte- and timing-identical.
- #752 is bridge-side: existing `telepty allow` bridges keep the old detector until respawned. #754 needs both (the daemon reads the new URL param; the bridge sends it) — an old bridge against a new daemon behaves exactly as before, never worse.

## 0.6.17 — 2026-07-26

### Fixed
- **#730** codex 0.144.1 forced-submit swallow — not a codex regression: the #716 bracketed-paste envelope was healthy but not APPLIED, because `bracketedPasteCapable` was learned only from a one-shot `ESC[?2004h` (emitted once in codex's first ~1.4KB) that wrapped sessions miss on late owner-WS attach and that never survived a daemon restart. Un-enveloped multi-line bodies with a near-0ms text→CR gap were then swallowed probabilistically. Fix: (A) paste capability is now identity-based via the CLI registry (`isPasteCapableCli`: codex, claude), with observed `?2004h`/`?2004l` as positive/negative overrides; (B) observed capability persists across daemon restarts (serialized only when actually observed — legacy session bytes unchanged); (C) defense-in-depth: the force path floors the text→CR gap (`TELEPTY_FORCE_CR_GAP_MS`, default 250ms) only for un-enveloped multi-line bodies — enveloped bodies keep ~0ms.

### Rollout
- Daemon-side (daemon restart). No bridge changes.

## 0.6.16 — 2026-07-25

### Fixed
- **#721** `TASK_IDLE_UNCONFIRMED` false-negatives (cry-wolf) on genuinely-completed worker turns, two root causes. **(b, primary)** worker-launcher (`telepty allow --auto-restart …`) sessions never produce a clean `idle→working` edge — their continuously-active child stays `working`, so the CR yields only `starting→working` / `working↔thinking` flips, all excluded by the #619 recorder's fromState guard. The durable consumption fact was therefore never recorded (0 `consumed_recorded` suppressions in production) and every long launcher completion decayed to the weak-idle signal and cried wolf. A new idle-gate path (`maybeRecordLauncherConsumption`) re-derives the verdict from decay-proof signals — **scoped to wrapped sessions** so non-wrapped keep strict #619/#545 semantics — gated on submit-accepted + real post-CR output + an elapsed floor (`TELEPTY_LAUNCHER_CONSUMPTION_MIN_SECONDS`, default 30s) an order of magnitude above the ~4.5s claude startup-settle, preserving the #537/BUG-B never-false-complete invariant. **(c, secondary / #579)** the clear-on-REPORT reverse-match only fired for `REPORT_PREFIX_RE`-shaped payloads, so a `--ref`/enveloped REPORT (file body with a leading markdown title) left the pending report stale and the honest post-report idle cried wolf. The reverse-match now treats any outbound inject a worker routes back to its pending-report source as completion evidence (`resolveOutboundReportStatus` fallback; `REPORT_PREFIX_RE` itself unchanged). Cosmetic consequence: any such outbound — including a mid-task clarifying question — now clears the entry and reports `TASK_COMPLETE_WITH_REPORT`; since the source already has the worker's message in hand, the cleared enforcement is intended and the completion label on a question is an accepted mislabel.

### Rollout
- Daemon-side (daemon restart). FIX 1 is inert for non-wrapped sessions; `TELEPTY_LAUNCHER_CONSUMPTION_MIN_SECONDS` tunes the launcher-completion elapsed floor (default 30).

## 0.6.15 — 2026-07-12

### Fixed
- **#724** Cross-host `telepty attach <sid>@<host>` failed with `Unexpected server response: 200` while local attach worked. On the AUTO_TAILNET path the daemon opens two sockets on the API port (loopback primary + additive tailnet IP), but the WS `upgrade` handler was bound to the loopback listener only — a cross-host handshake hit the tailnet socket, fell through to Express `GET /api/sessions/:id`, and got HTTP 200 instead of 101. The shared upgrade handler is now attached to both listeners. Auth unchanged (`isAllowedPeer || token || jwt`, identical to inject/read-screen); a new regression test asserts both listeners upgrade to 101 and an unauthorized cross-host upgrade still rejects (401).
- **#720** Bridge mailbox flush now drops stale parked injects (TTL, default 600s, env `TELEPTY_BRIDGE_INJECT_TTL_SECS`) and collapses consecutive duplicate payloads before delivery, with `[BRIDGE] dropped <reason>` logs. Previously every parked inject flushed on gate-open regardless of age or repetition.

### Rollout
- Both daemon-side. #724 requires a daemon restart on the **owning** node (the one hosting the session being attached); the requesting node needs no change.

## 0.6.14 — 2026-07-12

### Fixed
- codex prompt matcher broke again on suffixed model names (`gpt-5.6-sol`): the multi-signal pattern assumed `gpt-<digits>` followed by whitespace. Now matches any `gpt-<token>` (`gpt-\S+`), so cosmetic model renames no longer close the `promptReady` gate and park injects (follow-up to 0.6.13's #719).

## 0.6.13 — 2026-07-07

### Fixed
- **#719** The codex prompt matcher required the literal `fast` token in the status row and a leading space before `›`, both stale against codex v0.142.5 (non-fast footer `gpt-5.5 xhigh · <cwd>`, line-leading `›`). The bridge `promptReady` gate therefore never opened and injected messages parked in the mailbox indefinitely. Multi-signal now accepts the `·` separator tail and the strict scan's leading space is optional; modal anti-patterns unchanged.

## 0.6.12 — 2026-07-07

### Fixed
- **#715** `read-screen` leaked modern escape sequences (kitty keyboard protocol, DECSCUSR, colon sub-parameter SGR, DECRQM) as literal text — codex/claude screens showed `0 q`/`<u>1u`/`4:2m` garbage. The screen ANSI stripper now consumes the full ECMA-48 CSI grammar (params `0x30–0x3F`, intermediates `0x20–0x2F`, final `0x40–0x7E`), extracted to `src/screen-ansi.js` with a regression suite.
- **#716** `inject --submit` into codex never registered: codex's composer paste-burst detection swallowed a CR coalesced with the injected text. Paste-capable CLIs (detected via `ESC[?2004h`) now receive the text wrapped in bracketed paste (`ESC[200~ … ESC[201~`) with the submit CR written separately outside the envelope — submission is timing-independent. Non-paste CLIs are byte-identical. Live-validated on codex 0.142.5.
- **#713 (partial)** The same ECMA-48 gap in `session-state.js` / `prompt-symbol-registry.js` broke prompt/consumption detection for claude v2.1.198 (which emits kitty-protocol sequences every render). Both matchers aligned to the corrected CSI form. Note: fresh claude v2.1.198 sessions still gate on bridge `promptReady` prompt-symbol detection over the raw stream, which the new absolute-positioning composer defeats — full fix tracked separately.

### Rollout
- #715/#716 are daemon-side (daemon restart only). #713's bridge-side detection improvement additionally applies to newly started `telepty allow` bridges.


## [0.6.11] - 2026-07-05

### Fixed
- **#679 M1 (PRIMARY):** claude prompt-symbol matcher now accepts the Windows/ConPTY ASCII `>` caret (0x3E) in addition to `❯` (U+276F). On Windows the caret renders as `>` (live hexdump: `❯` 0×), so the `❯`-only matcher never fired → `bootstrap_ready` never flipped → gated injects parked in the mailbox `pending` forever and never reached the PTY. The `─`-adjacency guard is preserved (a `> markdown blockquote` is still rejected). Fixes gated cross-machine inject to Windows.

## [0.6.10] - 2026-07-05

### Added — seamless cross-machine on Tailscale (auto bind + auto trust) (#672)

- **On a Tailscale host, a fresh install is cross-machine-ready with zero manual env.** At
  startup the daemon detects its tailnet interface (a `100.64.0.0/10` address, via a pure
  live scan of `os.networkInterfaces()` — no subprocess, no `tailscale` CLI dependency) and
  **binds :3848 to the tailnet IP only, plus loopback**. LAN/public interfaces stay closed,
  so the inject/control API is reachable **only from your Tailnet** — this does **not**
  reopen the telepty#50 / audit hole (it never binds `0.0.0.0`). Tailnet peers are trusted
  automatically (Tailscale ACLs already gate tailnet membership), so no token/allowlist is
  needed. The tailnet IP is **discovered live every start, never persisted** — a
  Tailscale-reassigned IP is followed automatically.
- **Preserved safe defaults & overrides.** No tailnet detected ⇒ loopback-only (telepty#50
  unchanged). Manual `TELEPTY_BIND` / `HOST` / `TELEPTY_PEER_ALLOWLIST` always win over
  auto-detect. New `TELEPTY_NO_TAILNET_AUTO=1` forces loopback even on a tailnet.
- **Detection hardened against ISP-CGNAT.** `100.64.0.0/10` is also the shared ISP-CGNAT
  range; detection prefers a Tailscale-named interface (`tailscale*` / `utun*` / a
  `Tailscale` adapter) and, when it can only match by range, flags it in the banner so an
  operator on ISP-CGNAT can opt out.
- **`TELEPTY_PEER_ALLOWLIST` now supports CIDRs** (via native `net.BlockList`) as the
  `:170` comment always documented; exact-IP entries keep exact-match semantics.
- **Windows:** on the auto path the daemon adds the inbound firewall allow-rule
  automatically when elevated, otherwise prints the exact one-time `netsh` command.
- **Trust boundary (docs):** a Tailscale host auto-exposes :3848 to the *entire* tailnet;
  restrict with `TELEPTY_PEER_ALLOWLIST` or disable with `TELEPTY_NO_TAILNET_AUTO=1`.
  Zero-config cross-machine is Tailscale-specific; other topologies use the manual
  `TELEPTY_BIND` path. Addressing stays IP-free — use MagicDNS names with `<id>@<host>`.

### Fixed — busy-target `--submit` latency (busy-dispatch fast-path) (#694)

- **A gated `--submit` to a BUSY (mid-turn) recipient no longer burns the full gate timeout.**
  A busy claude sits in `working`/`thinking` — neither is a ready state — so the render-gate
  (`awaitReplReady`) could never pass mid-turn and waited out the entire `gate_timeout_ms`
  (default 10s) before dispatching best-effort. A new busy-dispatch fast-path detects a
  **genuine ongoing turn** (`working`/`thinking` held ≥ `TELEPTY_SUBMIT_BUSY_GRACE_MS`, default
  250ms — which excludes the transient `working` a target emits while echoing our own
  just-injected text) and dispatches after only the existing echo+micro-quiet settle
  (`awaitInputSettled`), cutting the busy path from ~10s to **sub-second**.
- **Never fires blindly, idle path unchanged.** The downstream `gatedTerminalSubmit` still
  runs its own echo+quiet gate before the `\r`; a CR into a busy composer merely queues and the
  #617 hold-and-redeliver loop re-fires it on idle (delivery reliability unchanged). `idle`/
  `waiting` targets never match the fast-path, so the proven idle behavior is byte-for-byte
  identical. Rollback via `TELEPTY_SUBMIT_BUSY_DISPATCH=off`.

## [0.6.6] - 2026-06-14

### Fixed — duplicate same-id `allow` flap loop + `kill` doesn't stick (#56)

- **A second `telepty allow --id <X>` no longer makes the session undeliverable-to.** Previously a
  duplicate wrap-owner caused the daemon to oscillate between owners (`Total: 1 ↔ 2`, repeated
  "Replacing stale ownerWs"), so the session never stayed `ready for inject` and **injects were
  silently dropped**. The daemon now does a **durable last-writer-wins Replace**: the displaced
  owner is closed with a dedicated **`4001 'Owner replaced'`** code (reason-independent — a bare
  terminate delivered an empty reason that the bridge mis-read as a reconnect), and the CLI treats
  `4001` as a clean exit with **no reconnect**. The `1000 'Session destroyed'` path is untouched;
  the `#536` owner-token guard still suppresses the displaced bridge's stale-token DELETE (no
  shared-fate cascade). Total settles at 1.
- **`telepty kill --force` now sticks.** The owning wrap-owner PID is captured at `?owner=1` claim
  time (previously only set on reconnect-register, so a first-connect owner had a null pid and could
  re-register after a kill). Combined with the durable Replace, a killed session no longer respawns.
  Cross-platform (`taskkill /T /F` on Windows).

### Added — daemon lifecycle: `daemon start` (detached) / `stop` / `restart` (#55)

- **`telepty daemon` is no longer foreground-only.** Previously the `daemon` command ignored its
  subcommand argument and always started a foreground daemon (so `daemon stop` actually *started*
  one, and there was no `restart`). Now:
  - **`telepty daemon start`** — starts the daemon **detached/background** and returns control to the
    shell immediately (prints pid + listen URL). Fixes one-command install/automation flows.
  - **`telepty daemon stop`** — terminates the daemon process (SIGTERM → SIGKILL) and frees the port.
    **Surgical**: it targets only the state-file pid / configured-port owner and force-disables the
    system-wide process scan, so it can **never reap an unrelated telepty daemon**.
  - **`telepty daemon restart`** — stop + detached start (a cross-platform restart; replaces the
    mac-only `launchctl kickstart` and gives Windows a restart it never had).
  - Bare `telepty daemon` keeps its foreground behavior (install/launchd flows depend on it); the
    internal version-mismatch auto-restart (`ensureDaemonRunning`) is unchanged. `telepty allow`
    (session bridges) stays foreground by design.

## [0.6.5] - 2026-06-13

### Fixed — orchestrator REPORT loss: hold-and-redeliver queued injects until idle (#617)

- **A REPORT injected into a busy orchestrator TUI is no longer lost.** When `inject --submit`
  is classified `queued` (consumed=false, recipient busy), the daemon now watches the
  recipient's auto-state and **re-fires the CR when it transitions to idle** — bounded
  (`MAX_REDELIVER=3` + total-time deadline; never an unbounded loop), and never-double-deliver
  (re-fires only while the body is still parked, gated by the #615 consumption check before
  AND after idle). Detached fire-and-forget; kill-switch `TELEPTY_REDELIVER=off`. Closes the
  "`Submitted via pty_cr` succeeds but the busy recipient never starts a new turn" gap that
  forced manual pull-fallback in every orchestration wave.

### Fixed — TASK_IDLE_UNCONFIRMED cry-wolf on long-running Claude turns (#619, telepty#54)

- **A genuinely-completed long Claude TUI turn no longer reports `TASK_IDLE_UNCONFIRMED`.**
  Consumption is an EARLY event (the turn fires ~T+2s after inject) but the #52/#545 idle-gate
  evaluated it LATE (at idle, often 13–23 min later) by re-deriving from the output-ring /
  OSC133 marks — by then a long turn's injected body has scrolled off and no fresh REPL-done
  mark remains, so the gate fell back to UNCONFIRMED on every long completion (cry-wolf, which
  trains the orchestrator to ignore the signal and defeats #52's own safety purpose). The
  daemon now **persists the consumption fact at consumption-time** (`maybeRecordInjectConsumption()`
  records `injectConsumedAt` on the first genuine non-busy→working/thinking turn after the CR,
  reusing the #615 consumed signal) and the idle-gate reads that **decay-proof stored fact**
  instead of re-deriving from a stale screen. **#52 guarantee preserved — never a false
  COMPLETE**: the fact is only recorded for a real turn AFTER the CR (startup / sub-state flips
  and busy-park excluded), so a never-consumed inject still yields UNCONFIRMED.

## [0.6.4] - 2026-06-13

### Added — inject consumption-evidence: consumed | queued | unknown (#53)

- **`telepty inject` now distinguishes "delivered" from "consumed".** After the CR
  (`pty_cr`), the daemon captures an output-ring watermark and `classifyInjectConsumption()`
  / `verifyBodyConsumed()` (reusing the #52 echo-watermark technique) classify the result:
  **consumed** (composer cleared + new turn rendered), **queued** (injected text persists
  in a busy TUI composer), or **unknown** (conservative). The `/submit` response and CLI
  output now carry this status; a `queued` result on a busy orchestrator TUI prints a
  pull-fallback hint. Closes the "`Submitted` reads as success but the busy recipient never
  consumed it" gap (observed 3+ times in a single orchestration wave). Backward-compatible
  (accepted/retryable semantics and exit codes unchanged; response is a superset).

## [0.6.3] - 2026-06-13

### ⚠️ BREAKING — daemon binds 127.0.0.1 by default (#50)

- **The daemon (and broker host) now binds `127.0.0.1` instead of `0.0.0.0`.** A fresh install no
  longer exposes the inject/control API to the local network. **Cross-machine setups where a peer
  dials this daemon directly over LAN will stop working after the daemon restarts** — opt back in
  explicitly on the daemon host with `TELEPTY_BIND=0.0.0.0` (the legacy `HOST` env override is
  still honored; `TELEPTY_BIND` wins when both are set). The startup banner now prints the bind
  address and a one-line exposure hint. SSH-tunnel peers (`telepty connect`) and the #42 broker
  node mode (outbound-only) are unaffected.

### Added — `telepty uninstall` + npm preuninstall hook (#49)

- **`telepty uninstall [--purge] [--dry-run]`**: stops running daemons (full discovery chain),
  unloads **and removes** the launchd plists (`com.aigentry.telepty`, `com.aigentry.telepty-broker`)
  on macOS, and reports the 3 state directories (`~/.telepty`, `~/.aigentry`,
  `~/.config/aigentry-telepty`). **User data is kept by default** — the paths are printed; deletion
  requires the explicit `--purge`. `--dry-run` reports without touching anything.
- **npm `preuninstall` hook**: daemon stop + plist unload only, quietly; it can never fail (a broken
  hook would break `npm rm` itself). Note: npm 7+ no longer executes uninstall lifecycle scripts —
  the reliable path is running `telepty uninstall` before `npm rm -g`.

### Fixed — blocked daemon restarts: actionable diagnostic, no per-command noise (#15)

- When the running daemon cannot be stopped (no `daemon-state.json`, owned by a parent app such as
  an aterm bundle, EPERM), the CLI used to retry the restart **3 times with backoff and repeat the
  full mismatch + failure banner on every command**, even though sessions kept working. Now: the
  discovery chain (state file → process-title scan → port-owner via `lsof`/`Get-NetTCPConnection`)
  is checked once — if the port owner survives cleanup, the restart **fails fast** with one
  actionable diagnostic naming the parent process (`Daemon (PID X) is owned by parent Y (pid Z) —
  restart that app … or run: kill X && telepty daemon`), discovered via new
  `findParentProcessInfo` (PPID lookup). An identical blocked state (same versions + blocking pid)
  warns **once** and is then silent (`~/.telepty/restart-failure.json` marker) until the state
  changes or a restart succeeds.

### Fixed — `--help` is now always safe on payload subcommands (#51)

- `telepty broadcast --help` used to **broadcast the literal string `--help` to every active
  session**, and `telepty allow --help` spawned a junk `<dir>---help` session. A bare `-h`/`--help`
  before an explicit `--` separator now always prints the subcommand usage with zero network or
  fan-out side effects (broadcast/multicast/inject/allow + aliases). Sending the literal text
  requires the explicit separator: `telepty broadcast -- --help`. Defense-in-depth: broadcast and
  multicast refuse a payload that is exactly a help flag unless `--` was used.

## [0.6.2] - 2026-06-10

### Fixed — TASK_IDLE_UNCONFIRMED false positives (#48)

- **`TASK_IDLE_UNCONFIRMED` fired ~0–0.5s after nearly every inject** even when the inject was
  processed, destroying the signal's value. Two proven causes: (a) the bridge re-sends `ready` on
  every TUI prompt-glyph redraw after an inject, and "working" evidence was only recorded on a
  transition *into* working — so an inject landing on an already-working session left zero evidence
  and the notifier fired on the first weak snapshot; (b) codex's spinner-less TUI (5s silence +
  `›` prompt glyph) flips the real-idle classifier mid-work.
- **Fix: settle-and-recheck.** A would-be `TASK_IDLE_UNCONFIRMED` is held for
  `TELEPTY_IDLE_UNCONFIRMED_SETTLE_SECONDS` (default 5) and re-checked against the **live** session
  state: working/thinking → suppressed; output advanced while idle-classified → bounded re-settle
  (`TELEPTY_IDLE_UNCONFIRMED_SETTLE_MAX_REARMS`, default 3); still idle and stalled → notify, so the
  genuine "inject not consumed" signal is preserved. The report label is pinned at arm time, so the
  settle window can never promote a stale idle snapshot to `TASK_COMPLETE` (the never-false-complete
  invariant is kept). Message format is unchanged.

## [0.6.1] - 2026-06-09

### Added — delivery provenance wrapper + audit seams (#47, P4+P5)

- **`src/audit/provenance.js`**: a nonce-gated, tamper-**evident** provenance banner around
  delivered bytes (NOT a signature — strength = secrecy of the per-session nonce; the authoritative
  provenance path remains the out-of-band `GET /api/injects`). Capability-gated in
  `deliverInjectionToSession`, **opt-in via `TELEPTY_PROVENANCE=1`, default-OFF**; legacy/byte-exact
  sessions receive raw bytes unchanged. Per-session nonce minted at `/api/sessions/register`.
- Broker `onInjectAudit` seam emits the shared `injects.jsonl` schema for cross-machine deliveries
  (`origin=untrusted-remote`, `verified_sender_sid=node:<sub>`).
- #45 blocked `broadcast`/`multicast` now also writes `delivery_result:blocked:<reason>` audit lines.

### Changed — daemon reports its bound port under `PORT=0` (#576)

- When launched with `PORT=0`, the daemon now reports the OS-assigned bound port via `/api/meta` and
  the startup banner (address-null-safe). This enables race-free ephemeral-port test harnesses (the
  root cause of CI flake). The default port (3848) and normal startup are unchanged.

### Fixed (CI / test harness) — #576 / #577

- The test daemon harness now uses an OS-assigned port instead of an unchecked random one, eliminating
  the `EADDRINUSE`/`EACCES` port races that made the CI "Regression Tests" suite flaky/red on
  ubuntu+windows. Snippet fixtures are pinned to LF (`.gitattributes`), and win32-incompatible UDS
  tests are OS-gated. ubuntu + macOS are now green; windows-latest is temporarily quarantined as
  non-blocking (windows-specific reds tracked in #577). (CI-only — not shipped in the package.)

## [0.6.0] - 2026-06-09

### Added — inject audit log + verified sender identity (#43, P1–P3)

- **Append-only inject audit log** (`src/audit/inject-log.js`): every delivery is
  recorded to `~/.telepty/logs/injects.jsonl` (schema v1, one line per delivery —
  one line per target for multicast/broadcast), file `0600` / dir `0700`. Default
  is **hash-only** (`payload_sha256` always; no payload content on disk) — opt into
  a truncated preview with `TELEPTY_AUDIT_PREVIEW=1`. Bounded async writer with
  size+age rotation (`TELEPTY_AUDIT_*` env, default 30 days / 50 MB × 5); never
  blocks the delivery hot path.
- **Verified sender identity**: a per-session token is minted at
  `/api/sessions/register` and carried in the parent-hijack-protected env beside
  `TELEPTY_SESSION_ID`; the daemon maps it to a `verified_sender_sid` and flags
  `spoof_suspected` when the caller-supplied `--from` disagrees with the verified
  identity. Both `claimed_from` and `verified_sender_sid` are logged.
- **Read API + CLI**: token-gated `GET /api/injects` (filter by `since`/`until`/
  `to`/`from`/`spoof`, with cursor pagination) and a `telepty injects
  [--tail --since --to --from --spoof --json]` subcommand for incident response.
- The delivery provenance wrapper (P4) and broker/#45 audit seams (P5) are tracked
  separately in #47 (deferred).

### Security — operator-only fan-out (#45)

- **`broadcast` / `multicast` now go through the peer-lane guardrail.** Previously
  these handlers called delivery directly, bypassing `classifyPeerLaneInject` — a
  fan-out escape past the peer-inject policy. **Behavior change:** fan-out
  (`broadcast`/`multicast`) is now **operator/orchestrator-only**; a peer-lane
  sender is rejected with `403 PEER_INJECT_BLOCKED` reaching **zero** sessions
  (gate is by lane, not envelope). Per-target `peer_inject_blocked` bus events and
  a `TELEPTY_FANOUT_MAX_TARGETS` (default 100) blast-radius cap were added.

### Fixed

- **Daemon restart never stopped the running daemon on macOS/Linux (#44).** The
  daemon's `process.title = 'telepty-daemon'` defeated the `isLikelyTeleptyDaemon`
  command-line heuristic, so the restart path could not find the old daemon to
  stop. Recognize the title token (additive; the `aigentry-telepty` path is
  preserved) and name the surviving state-file PID / port-3848 owner in the restart
  failure message. Windows (`Win32_Process.CommandLine`) is unaffected.
- **`[Windows] resolveWindowsExecutable` picked the extensionless npm shim (#46).**
  The bare-name `PATH × PATHEXT` walk tried `''` first and matched npm's
  extensionless `/bin/sh` shim before `.CMD`, crashing `CreateProcessW` with
  `ERROR_BAD_EXE_FORMAT (193)`. The bare-name walk now tries real `PATHEXT`
  extensions first (`''` last); the absolute/relative-path case is unchanged.
- **Spurious daemon restart on a transient health-probe timeout (#567)** — ships
  the previously-unreleased fix (meta-primary decision + bounded retry; restart
  only on a real version/capability mismatch).
- **`--submit` PTY 0x0D Enter intermittently not consumed (#568)** — ships the
  previously-unreleased fix (render-gate input-ready before each CR +
  state-transition-primary confirm + adaptive retry; telepty-PTY only).

### Experimental (opt-in, default-OFF, not GA)

- **Cross-machine relay/broker (hub) mode (#42)** is included in the package but is
  **disabled by default** and opt-in only (enable via `AIGENTRY_BROKER_*` env). It
  is not yet generally available or supported for general use; the code is dormant
  unless explicitly enabled. GA gating remains pending a real-topology validation.

## [0.5.9] - 2026-06-08

### Fixed — managed service install never started the daemon (#41)

- **The launchd/systemd/Windows service install generated an `env: node`
  invocation that exited 127** under a minimal service-manager PATH (the daemon
  never started when managed by launchd/systemd). **Fix:** `install.js` now uses
  the absolute `process.execPath` + `cli.js` path for launchd/systemd/Windows
  service generation, sets the daemon `PATH` via EnvironmentVariables, and adds
  managed-instance live assertions so a managed daemon actually starts. Landed on
  `main` at commit `7b2ab92`.

### Changed — CI test wiring

- Wired `test/install-service-generation.test.js` (the #41 regression test) into
  the `test`, `test:ci`, and `test:watch` script file lists so CI's
  `npm run test:ci` actually exercises the service-install generation.

### Docs

- Landed the #42 cross-machine relay/broker (hub) mode ADR and MVP
  implementation spec.

## [0.5.2] - 2026-06-06

### Fixed — submit handshake confirmation (#507-B / #508)

- **`--submit` Enter sometimes did not register in a CLI's TUI** (the recurring
  "Enter 안눌림" bug). `inject --submit` wrote the carriage return but did not
  confirm the target actually consumed it, so under timing pressure the submit
  could be dropped and the injected prompt left sitting unsubmitted. **Fix:** a
  submit-gate handshake in `src/submit-gate.js` confirms the submit landed, with
  `cli.js` / `daemon.js` wiring the gate into the inject path. Landed on `main`
  at commit `2a21265`. This release ships that already-tested fix (npm 0.5.1
  still served the pre-fix code; the running daemon must be restarted separately
  to pick it up). (telepty#512)

## [0.5.1] - 2026-05-30

### Fixed — daemon never started (CRITICAL, regresses 0.5.0)

- **The daemon failed to start for all users on 0.5.0.** `daemon.js` guarded
  `app.listen()` behind `require.main === module` (added in 0.5.0 for test
  isolation so `require('./daemon.js')` is side-effect-free). But the production
  CLI launches the daemon via `require('./daemon.js')` (`telepty daemon`, and the
  auto-start spawns `node cli.js daemon`), so `require.main` is always `cli.js` —
  `app.listen` never ran, the process exited 0 right after `[PERSIST] Restored
  session … (awaiting reconnect)`, and every CLI reported `Daemon restart failed
  after 3 attempts` / `fetch failed`. **Fix:** `cli.js` sets
  `AIGENTRY_TELEPTY_DAEMON_MAIN=1` before requiring `daemon.js`; the guard is now
  `require.main === module || process.env.AIGENTRY_TELEPTY_DAEMON_MAIN === '1'`.
  Tests that `require()` daemon.js without the env stay side-effect-free. (telepty#15)
- Follow-up (tracked): a daemon-launch integration smoke test — assert the HTTP
  endpoint responds when the daemon is launched via the real CLI path. The unit-test
  guard masked this regression; an integration test would have caught it.

## [0.5.0] - 2026-05-30

### Changed — Surface-ownership boundary (ADR 2026-05-30)

- **Orchestrator Workspace Host now owns surface close/focus; telepty no longer
  actuates them.** Daemon focus actuation and `focusSurface` are removed
  (focus moves to the orchestrator `wh_focus` path). `closeSurface` is gated
  behind `AIGENTRY_TELEPTY_SELF_CLOSE_SURFACE` — a no-op on the managed path,
  opt-in for standalone use. The `isSurfaceAlive` cmux liveness probe,
  `decideSurfaceGc`, and session-side zombie reclaim are retained; telepty now
  emits a `surface_orphaned` bus event for the orchestrator reconciler to
  actuate the close. INV-17 / #486 preserved (probe unknown → skip gate intact).

### Fixed — Lifecycle / bootstrap / skill-loading (tasks #35 #20 #32 #17 #29 #31 #19)

- **#35 / #20 — Codex skill loading.** Single-quote the `description` YAML
  scalars in the bundled `SKILL.md` files so a Korean `키워드:` colon is no
  longer parsed as a nested mapping; Codex now loads all bundled skills.
- **#32 — auto-report consolidation.** Three byte-identical auto-report
  builders are consolidated into one provenance-tagged `fireAutoReport`;
  sub-1s elapsed is relabelled `TASK_IDLE_UNCONFIRMED` so a stuck target is
  never reported as `TASK_COMPLETE`.
- **#17 — surface-liveness GC.** New cmux surface-liveness probe
  (`isSurfaceAlive`, INV-17 unknown-on-unreachable gate) plus `decideSurfaceGc`
  and session-side SURFACE-GC reclaim of the headless zombie; the cli.js bridge
  terminates (no reconnect) on a 1000 `Session destroyed` close.
- **#29 — Warp bootstrap.** Non-cmux (Warp) owner-alive optimistic bootstrap
  floor (mirrors `runStartupBootstrapRestore`) plus `TERM_PROGRAM=WarpTerminal`
  backend classification — fixes inject-queues-forever on Warp.
- **#31 — bootstrap timeout.** Actionable bootstrap-timeout
  (`failBootstrapQueueOnTimeout` flushes the queue instead of hanging).
- **#19 — Windows codex PATH.** Verified already-fixed by `874d14a`
  (no code change).

### Security — Snyk cli.js posture (task #26)

- **Fixed — 3 path-traversal findings** (`fs.readFileSync`/`fs.readdirSync` on the
  `--config=` / `--dir=` (`telepty session start`) and `--context` (`telepty
  deliberate`) CLI path arguments). A new `sanitizePathArg()` rejects empty input,
  null-byte injection, and `..` traversal segments, then normalizes via
  `path.resolve()`; applied at each `fs.*` call site. Snyk path-traversal count is
  now **0**.
- **Hardened — self-update default** (`runUpdateInstall`): the default
  `npm install -g` now runs via `execFileSync` with a fixed argument array (no
  shell), removing the default-path command-injection surface.
- **By-design waivers (operator-trusted, no privilege boundary; pre-existing
  baseline, not introduced by this work):** two `IndirectCommandInjection`
  findings remain and are accepted by design — (1) `pty.spawn` of the
  operator/user-chosen CLI, which *is* the `telepty allow` feature; and (2) the
  explicit `TELEPTY_UPDATE_COMMAND` self-update override, an operator-set env var
  (setting it already implies shell control, so no boundary is crossed). Both are
  annotated in code so they are not mistaken for an oversight. **Net: 0
  newly-introduced and 0 non-by-design findings.**

## [0.4.5] - 2026-05-26

### Fixed — Stale-daemon, restart-recovery, force-bypass, codex matcher (tasks #469 #470 #471 #472)

- **#469 — npm postinstall hook restarts a stale daemon (`scripts/postinstall.js`).**
  `npm install -g @dmsdc-ai/aigentry-telepty@X` previously overwrote files but
  never signalled the running `telepty-daemon`, so the daemon kept executing
  the previously-loaded code (observed: PID 3222 ran 22 days through 4
  upgrades). The new postinstall script reads `~/.telepty/daemon-state.json`,
  compares the running daemon's reported version to the just-installed
  `package.json` version, and on mismatch invokes the existing
  `cleanupDaemonProcesses()` primitive plus a detached respawn. Skips on
  `TELEPTY_SKIP_POSTINSTALL=1` and on non-global installs
  (`npm_config_global!=='true'`).
- **#470 — daemon restart re-bootstraps existing sessions
  (`daemon.js` `runStartupBootstrapRestore()`).** After a daemon restart,
  persisted-and-restored sessions remained `ready:false` indefinitely because
  the bootstrap prompt-symbol probe only fired on owner-WebSocket reconnect.
  On startup, each restored gated session whose `ownerPid` is still alive is
  now actively probed (cmux path) or optimistically marked ready (non-cmux
  path), with the chosen reason recorded for log attribution. Sessions whose
  owner process is dead remain unready, matching the prior unready semantics.
- **#471 — `force: true` bypasses the bootstrap gate (`daemon.js:1969`).**
  The per-request `force` escape hatch (`cli.js --submit-force`,
  `TELEPTY_SUBMIT_FORCE_DEFAULT=1` from 0.4.4) was parsed correctly but the
  bootstrap gate enqueued it and returned 504 long before the force-bypass
  block at L1998 could run. Surgical 1-line condition edit: gate fires only
  when `!force`. The force-bypass code path is now exercisable as documented.
- **#472 — codex prompt-symbol matcher normalized across environments
  (`src/prompt-symbol-registry.js`).** On real cmux captures the codex `›`
  glyph tail-renders on the same row as the model-status footer and DECRQM /
  cursor-position-query fragments (`>4;0m>7u`, `0 q`) leak into the screen
  buffer, so the prior strict line-leading scan permanently missed and the
  session stuck at `ready:false`. New tolerant detector: (1) modal-UI
  anti-pattern guard for resume picker, first-run directory-trust prompt and
  generic press-enter-to-continue modals (treated as NOT ready); (2)
  multi-signal match on `"OpenAI Codex (v"` plus `/gpt-[0-9.]+\s+\w+\s+fast/`
  anywhere on the screen; (3) legacy strict line-leading scan preserved as a
  back-compat fallback. `awaitPromptSymbol` now emits a single
  `[bootstrap] <cli> ready via: <reason>` log line on stabilize, paired with
  the #470 optimistic-ready logging for unified debuggability.

### Notes — 0.4.5

- **Tests** — `npm test` passes 416 / 416 (was 411 / 411 in 0.4.4; +5 new
  cases in `test/release-0.4.5-bugfixes.test.js` covering #469/#470/#471/#472
  including env-resistance regression guard on the existing noforce test).
- **Snyk Code SAST** — all newly authored or modified JS files
  (`scripts/postinstall.js`, `src/prompt-symbol-registry.js`,
  `src/submit-gate.js`, new `daemon.js` line ranges, and
  `test/release-0.4.5-bugfixes.test.js`) report 0 findings. The 55
  pre-existing repo-wide findings in unchanged code are tracked separately as
  task #474 (security cleanup track) and are not part of this release.
- **Out of scope, tracked separately** — task #473 (session-ID reuse → stale
  command metadata) is queued for a 0.4.6 dispatch and is not addressed here.

## [0.4.4] - 2026-05-25

### Added — TELEPTY_SUBMIT_FORCE_DEFAULT env var (task #453)

- **Environment default for forced submit** —
  `TELEPTY_SUBMIT_FORCE_DEFAULT=1` makes `telepty inject --submit` behave as
  if `--submit-force` was passed, without changing behavior for users who leave
  the env var unset. Accepted truthy values are `1`, `true`, `yes`, and `on`
  after whitespace trimming and case normalization.
- **Per-call opt-out** — `telepty inject --submit --no-submit-force ...`
  restores the normal gated submit behavior even when the environment default
  is enabled. Explicit `--submit-force` remains valid and wins when supplied.
- **Automation caveat** — this is intended for orchestrators that already know
  their targets are real, initialized REPLs. It bypasses the safety gate that
  prevents submit during target boot, avoiding the transient 504
  `bootstrap_not_ready` path where text lands in the input box but Enter is not
  sent.
- **Observability** — env-driven calls emit
  `[telepty inject] submit-force=env-default (TELEPTY_SUBMIT_FORCE_DEFAULT=1)`
  to stderr before posting `/submit`.

### Notes — TELEPTY_SUBMIT_FORCE_DEFAULT env var

- **Test suite** — `npm test --silent` passes 403 / 403, including the new
  `test/inject-submit-force-env.test.js` coverage for env-off, env-on,
  `--no-submit-force`, explicit `--submit-force`, and value normalization.
- **Snyk SAST** — the requested `snyk_code_scan` MCP tool was not available in
  this session, so the installed Snyk CLI was used. After replacing the new
  localhost HTTP fixture with a loopback `net` test server and generating the
  test auth token at runtime, `test/inject-submit-force-env.test.js` has 0
  findings and the changed `cli.js` line ranges have 0 findings. The full repo
  CLI scan still reports the pre-existing baseline findings in legacy `cli.js`,
  `daemon.js`, existing HTTP test fixtures, and `scripts/bridge-phase1.js`. No
  suppressions were added.

### Added — Idle session cleanup (issue #34)

- **Idle visibility in `telepty list`** — session rows now append
  `💤 idle (Xh Ym)` when `lastActivityAt` is more than 60 seconds old.
  `telepty list --json` preserves `lastActivityAt` and adds
  `idle_seconds` for machine consumers.
- **Transport-agnostic lifecycle helpers** — `src/lifecycle.js` centralizes
  duration parsing, idle-victim selection, older-than cleanup selection, and
  PTY/process-level teardown. It uses native POSIX signals and the existing
  Windows `taskkill` helper; it does not call cmux or any workspace-host API.
- **`telepty kill <id> [--force] [--timeout <sec>]`** — graceful teardown
  sends SIGTERM, waits up to the configured timeout, then escalates to
  SIGKILL. `--force` sends SIGKILL immediately. Successful teardown removes
  the daemon registry entry and session socket artifacts.
- **Opt-in idle TTL** — daemon config loads `~/.telepty/config.json` or a
  simple `config.yaml` / `config.yml` with `idle_ttl_default` (`off` by
  default). `telepty allow --idle-ttl <duration|off>` stores a per-session
  override. The daemon reaper emits a `tracing` event with
  `action: "idle_ttl_auto_kill"` before auto-teardown.
- **`telepty clean --older-than <duration> [--idle] [--dry-run]`** — default
  ghost-only cleanup remains unchanged. The new opt-in path removes sessions
  older than the threshold by `createdAt`, or by `lastActivityAt` when
  `--idle` is set; `--dry-run` reports targets without deleting them.

### Notes — Idle session cleanup

- **Test suite** — `npm test` passes 397 / 397, including transport-agnostic
  lifecycle coverage for headless and cmux-backed fixtures.
- **Snyk SAST** — the requested `snyk_code_scan` MCP tool was not available in
  this session, so the installed Snyk CLI was used. New standalone files
  (`src/lifecycle.js`, `src/config-file.js`, and the new lifecycle tests)
  scan with 0 findings. Scanning changed legacy entrypoints (`daemon.js` and
  `cli.js`) still reports the repo's pre-existing baseline findings
  previously noted for Phase 2: CLI path-traversal / command-injection flows
  and daemon route-level prototype-pollution / throttling / command-execution
  warnings. No suppressions were added.

### Added — Phase 5a-prime (task #430 P5a-prime)

- **`crates/telepty-cross-machine/`** — standalone Rust library plus
  `telepty-cross-machine-bin` for manual HTTP peer operations only. Scope is
  deliberately reduced from the two rejected Phase 5 drafts: no JS bridge, no
  subprocess envelope contract, no outbox queue, no npm distribution, no SSH
  transport, and no `cli.js` / `daemon.js` / `cross-machine.js` changes. This
  follows the review basis in
  `docs/reports/2026-05-24-phase5-spec-codex-review.md` and
  `docs/reports/2026-05-24-phase5a-spec-codex-rereview.md`, which identified
  bridge-consumed binary contracts as the unstable surface.
- **Manual HTTP subcommands** — `connect-http`, `list-peer-sessions`,
  `inject-peer`, `list-peers`, and `remove-peer`. `connect-http` probes
  `/api/health`, treats `/api/meta` as non-fatal, persists token-backed HTTP
  peers to `~/.telepty/peers.json`, and prints human-friendly status. List
  commands support free-form `--json` output without an envelope contract.
  `inject-peer` fails fast on unreachable peers; there is no queueing.
- **Backward-compatible `peers.json` handling** — missing `transport` defaults
  to SSH and round-trips without injecting a `transport` field, preserving the
  JS-era legacy schema used by the SSH path. HTTP operations on SSH peers exit
  4 with the explicit JS-path diagnostic required by Phase 5a-prime.
- **Addressing and atomic-write parity** — Rust host parsing mirrors
  `host-spec.js` URL stripping, embedded-port, and IPv6 behavior. Peer updates
  use the fsync-backed `tmp + fsync(tmp) + rename + fsync(parent_dir)` pattern
  copied from `crates/telepty-supervisor-core/src/manifest.rs`.
- **Build metadata** — `build.rs` embeds git hash, dirty flag, and build
  timestamp. `telepty-cross-machine-bin --version` prints
  `telepty-cross-machine 0.0.1 (<git-hash>[, dirty])`.

### Added — Phase 2 Node↔Rust IPC bridge (task #430 P2)

- **`src/bridge/supervisor-ipc.js`** — Node `BridgeClient` speaking NDJSON
  over the per-session UDS (`~/.telepty/sessions/<sid>/supervisor.sock`).
  Surface: `connect(socketPath)` → client; `send(frame)` fire-and-forget;
  `request(frame, {timeoutMs})` with trace_id correlation (resolves on
  matching `pong`, rejects on matching `error` with the supervisor's
  `ERR_*` code preserved, rejects `ERR_TIMEOUT` on drift); `subscribe({sid,
  signal})` returning an `AsyncIterator<Frame>` that respects `AbortSignal`
  and `iterator.return()` for clean unsubscribe; `close()` idempotent and
  rejects any pending requests with `ERR_SUPERVISOR_GONE`. Per synthesis
  ADR §6.2 (B3), `trace_id` is auto-filled for kinds the supervisor
  mandates it on (`inject`/`output`/`signal`/`kill`/`delete`); pong
  reflects ping `trace_id` so correlation works without server-side
  per-client state. Malformed inbound lines surface as synthetic
  `ERR_BAD_FRAME` to subscribers — the connection survives garbage so a
  later-good frame still flows.
- **`src/bridge/j3-shim.js`** — 0.3.x→NDJSON translator covering the P2
  subset (`inject` / `output` stream / `list`). `inject(sid, prompt, opts)`
  opens a one-shot connection, sends an inject frame, watches 150 ms for a
  trace_id-correlated `error` frame (catches B3 / `ERR_DUPLICATE_OP` /
  `ERR_SHUTTING_DOWN`), and returns `{ success, trace_id, code?, error?
  }`. `output(sid, {fromSeq, signal})` is an async generator yielding
  `{ data, seq }` per `Frame::output` and a final `{ exit, ... }` on
  `shutdown_drain`; consumer-driven cancellation via `AbortSignal` or
  `break`. `list()` scans `~/.telepty/sessions/*/manifest.json` and
  surfaces only `ready` / `draining` sessions (tombstones excluded — they
  lack a usable socket; operators still see them via
  `telepty-supervisor-bin --list`). Sessions root is resolved lazily so
  `TELEPTY_SESSIONS_DIR` redirects work without re-requiring the module.
- **`src/bridge/supervisor-launcher.js`** — per-session Rust supervisor
  process lifecycle. `resolveBinary({env})` chains
  `TELEPTY_SUPERVISOR_BIN` (env override) → `./target/release/telepty-
  supervisor-bin` (repo-relative) → `./target/debug/...` → `which
  telepty-supervisor-bin` (PATH) and throws `ERR_BIN_NOT_FOUND` otherwise.
  `spawn({sid, argv, cwd?, binary?, env?, stdio?})` shells out to the
  binary with `stdio: ['ignore', 'ignore', 'pipe']` (default) so the
  supervisor's M1/M2 stdout PTY-mirror doesn't bleed into the parent.
  `waitReady(sid, {timeoutMs, pollMs})` gates on BOTH manifest status
  (`ready`/`draining`) AND `fs.existsSync(socket)` — supervisor.rs writes
  the manifest *before* `ipc::bind_socket`, so a manifest-only gate races
  the bind; checking both closes the window without touching the
  supervisor crate. `isAlive(sid)` cross-checks manifest pid via
  `process.kill(pid, 0)`.
- **`cli.js` minimal-touch wiring** (Rule 29 surgical, +27 LOC, no
  refactor of adjacent code):
  - `cmd === 'list'` (L915): merges `bridgeShim.list()` into the daemon-
    discovered session set, de-duplicated by `id`. Daemon entries remain
    source-of-truth when both surfaces report the same session; bridge
    entries fill the gap when daemon is down. Wrapped in a defensive
    `try/catch` so any bridge failure leaves the daemon list intact.
  - `cmd === 'inject'` LOCAL path (L1755): bridge-first attempt when
    `!useSubmit && bridgeShim.findSupervisorManifest(target.id)` is
    truthy. On bridge success, prints the existing
    `✅ Context injected successfully into '...' (bridge).` line and
    returns; on bridge failure, falls through to the unchanged daemon
    HTTP path so caller-visible behavior never degrades. The gated
    `--submit` semantics (render-gate / retry / `--submit-force`) stay
    on `daemon.js` for the migration window — P2 wire does not carry
    render-gate yet.
- **`cross-machine.js` UNTOUCHED** — P2 scope is local bridge only;
  remote SSH / HTTP transport stays on the existing path. P3+ owns the
  remote→bridge story.

### E2E acceptance — `telepty spawn → inject → output` works with daemon.js stopped

- `test/bridge-e2e.test.js` drives the supervisor binary directly through
  `supervisor-launcher` + `j3-shim` in an isolated `HOME` so the live
  daemon (if any) is never touched. The headline test launches a real
  `cat -u` under the supervisor, subscribes to the output stream, injects
  `ping-echo\n`, and asserts the echo arrives — proving the bridge alone
  is sufficient for the primary three operations per dispatch §2.4. The
  test self-skips with a clear hint when
  `target/release/telepty-supervisor-bin` is absent (binary not built
  yet), keeping CI without Rust toolchain green.

### Notes — Phase 2 bridge

- **No new npm dependencies** (Constitution §17 무의존). NDJSON parsing
  via `readline.createInterface` from the Node stdlib; UDS connection via
  `net.createConnection({ path })`; UUIDs via `crypto.randomUUID()`. Adds
  zero packages to `package.json` `dependencies`.
- **Test suite** — `npm test` 375 / 375 pass in ~24 s (343 baseline
  preserved per Rule 29 + 32 new bridge tests: 14 `BridgeClient` units,
  14 `j3-shim` units, 4 E2E). Test file ratio is ~1:1 with prod LOC
  (~787 prod / ~797 tests).
- **Snyk SAST** — `snyk_code_scan` on `src/bridge/` + new test files →
  **0 findings**. Pre-existing `cli.js` findings (3× path-traversal on
  CLI arg → `fs.readFileSync` / `fs.readdirSync` at L2345/L2347/L2656;
  2× command-injection on CLI arg → `execSync` / `node-pty.spawn` at
  L471/L1116) are unchanged by this work — they live in dataflows
  unrelated to the L915/L1755 bridge insertions and are tracked
  separately (consistent with the v0.4.3 baseline). No new Snyk findings
  attributable to this phase.
- **Path budget** — bridge prod 787 LOC + bridge tests 797 LOC =
  ~1.6 kLOC, well within the dispatch envelope (bridge ~400-700 + shim
  ~200-400 + tests ~300-500). cli.js delta is +27 LOC pure additions
  with no edits to existing lines, satisfying the minimal-touch
  directive.
- **Cross-platform** — UDS path is POSIX-only in P2 (Windows native
  pipe = P4 per dispatch §2). Bridge unit tests and E2E gracefully
  skip on `process.platform === 'win32'`; the launcher still resolves
  the binary path on Windows so the eventual P4 wiring has a stub to
  extend.

### Carry-overs — Phase 2

1. **`telepty spawn` cli command bridge wiring** — out of P2 scope per
   dispatch §Goal item 4 ("inject / output / list paths"). P3 owns the
   refactor that lets `telepty spawn` route through
   `supervisor-launcher.spawn` for supervisor-managed sessions.
2. **Render-gated `--submit` over bridge** — daemon.js stays as the
   submit gate for the migration window. Bridge inject currently
   appends a literal `\r` to the data (matching the legacy
   `no_enter: false` default) without REPL readiness detection.
3. **Single-binary `telepty supervisor` mode** — P2 still spawns the
   `telepty-supervisor-bin` standalone bin. The `telepty supervisor`
   subcommand mode per orchestrator decision §6.6 A is post-P2.

### Added — Phase 1 supervisor-core-finish (task #430 P1)

- **A5 detach/reattach via UDS reconnection + log offset replay** —
  `wire::Kind::Resume` frame with optional `from_seq: u64` lets a
  reconnecting client request replay of `Output` frames whose `seq` is
  greater than `from_seq` from `~/.telepty/sessions/<sid>/log.jsonl`
  before subscribing to the live broadcast. Replay is per-connection
  sequential (handler-local) — no broadcast race. Seq-less audit
  frames (`shutdown_drain`) are forwarded unconditionally so a late
  reattach observes terminal state.
- **A7 list discovery via filesystem manifest scan** —
  `manifest::scan_sessions()` walks `~/.telepty/sessions/*/manifest.json`
  with atomic per-file reads; missing / unparseable manifests are
  skipped (never panics). New `telepty-supervisor-bin --list` flat
  flag emits a JSON array of `Manifest` to stdout. Output shape is
  the **supervisor-owned** view; the legacy `telepty list --json`
  daemon view will be reconciled by the P3 cli refactor (per dispatch
  §6.1). `--list` is mutually exclusive with run-mode argv.
- **A8 delete graceful drain integration test** —
  `tests/delete_drain.rs` end-to-end (no goldens): graceful (SIGTERM)
  and forced (SIGKILL) variants both assert manifest unlinked + socket
  unlinked + `log.jsonl` contains `shutdown_drain` with correct
  `exit_reason` + supervisor exits within 3 s. Production code already
  existed in `supervisor::run` (kill_outcome → unlink_clean branch).
- **B3 trace_id enforcement extended to signal/kill/delete** —
  `wire::validate_incoming` now rejects `Kind::Signal`, `Kind::Kill`,
  `Kind::Delete` lacking `trace_id` with explicit error codes
  (`signal_missing_trace_id`, `kill_missing_trace_id`,
  `delete_missing_trace_id`) per C3 spec §1002 audit linkage
  (`kind:"signal"` event matches originating injector trace_id;
  `kind:"shutdown_drain"` carries parent_trace_id). Rejection reason
  is ALSO appended to `log.jsonl` so the audit trail captures *why* a
  frame was rejected even if the client disconnects before reading
  the error response.
- **F3 atomic manifest write contract test** —
  `tests/atomic_manifest.rs` (5 tests). Headline test
  `concurrent_readers_never_observe_partial_json` runs 1 writer thread
  + 6 reader threads × 800 ms; readers always see a complete-old or
  complete-new manifest, never partial JSON (the rename-atomicity
  guarantee). Plus golden tests for `.json.tmp` cleanup, missing-
  parent-dir creation, `unlink_clean` idempotency, and tombstone
  audit-field roundtrip.
- **G3 audit trail expansion** — `dispatch_ingest` now logs each
  validated ingest event (`Inject` / `Signal` / `Kill` / `Delete`) to
  `log.jsonl` right after `validate_incoming` passes. Ping is
  intentionally skipped (heartbeat noise). Validation rejections are
  also logged (closes the silent-drop gap from earlier milestones).
  `audit.rs` was extended (single module per Constitution §1
  lightweight) rather than fragmenting into a new audit/ submodule.
  R4 TelemetryEvent translation deferred to the P3 cli bridge per
  orchestrator Phase 4 decision.
- **§8.A1 Normal termination contract test** —
  `tests/normal_termination.rs` (2 tests). Covers child exits 0
  (assert `exit_reason: normal`, `exit_code: 0`, escalated false,
  manifest unlinked) and nonzero-but-natural exit (`sh -c 'exit 7'`
  — assert exit_code propagated; `Normal` is the exit *mechanism*,
  not the exit *code*).

### Performance — E1 local-inject latency bench

- New `crates/telepty-supervisor-core/benches/inject_e1.rs` custom
  harness (no criterion — Constitution §17 no new Rust deps).
  `[[bench]] harness = false`. Run with `cargo bench --bench inject_e1`.
  100 warmup + 1000 measured roundtrips through real supervisor
  wrapping `cat`.
- **E1-p50: 0.025 ms** (p90 0.057 ms, p99 0.091 ms) on
  macos/aarch64 / Mac16,8 / Apple M4 Pro — **40× under the 1 ms
  target**.
- Exit code 0 iff p50 < 1 ms (CI-gateable).

### Notes — Phase 1 supervisor-core-finish

- **No new Rust deps** (Constitution §17). `tokio` `fs` feature
  enabled in workspace deps (feature flag only). `serde_json` added
  to `telepty-supervisor-bin` (was already a workspace dep).
- **Rule 29 surgical** — changes scoped to
  `crates/telepty-supervisor-core/` (src + tests + benches) and
  `crates/telepty-supervisor-bin/`. No daemon.js / cli.js changes
  (those land in P2/P3). No Windows code paths (P4 scope; cargo
  features can gate but no implementation in this phase).
- **Tests** — 42 / 42 pass (23 baseline preserved + 19 new):
  - Unit: +4 wire B3 (signal/kill/delete trace_id), +2 audit, +1
    scan_sessions
  - Integration: +3 reattach_replay (A5), +2 delete_drain (A8), +5
    atomic_manifest (F3), +2 normal_termination (§8.A1)
- **Snyk SAST** — `snyk_code_scan` on `crates/` → 0 findings across
  both crates. Run at each phase boundary (Phase 4+).
- **§8.A contract test parity** (per C3 spec
  `docs/specs/2026-05-10-supervisor-c3-kill-gate-spec.md` §8.A): 7
  of 13 Bucket-A scenarios covered + 2 extras (A5 reattach, F3
  atomic) + 4 correctly deferred (Windows = P4 / Bucket B =
  controlled-host out of Phase 1 spike scope). **2 follow-up
  carry-overs documented**: §8.A3-tree (grandchild-cascade
  killpg semantics — code already correct; explicit fixture
  needed) and §8.A-reactor-stall (single-thread reactor
  non-blocking invariant — code-review-only invariant; runtime
  probe optional).
- **Sources of truth** — the synthesis ADR referenced in dispatch
  (`docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md`)
  and 6-phase plan (`docs/reports/2026-05-23-telepty-l2-supervisor-plan.md`)
  live in the orchestrator repo, not visible from this repo.
  Per Phase 1 CLDR + orchestrator hybrid (b)+(c) decision, this
  work derives §19.2 contract requirements from the local
  `docs/specs/2026-05-10-supervisor-c3-kill-gate-spec.md` (which
  the code already cited as `SPEC-C3-r1`) plus the dispatch text
  itself.

## [0.4.3] - 2026-05-23

### Fixed

- **telepty#15** — Daemon version mismatch auto-restart + port-owner
  fallback + banner-to-stderr (root-cause fix for task #400).
  - All five daemon-related banners in `cli.js` (lines 429, 585, 592,
    594, 600) now emit to `process.stderr` instead of `process.stdout`.
    Closes task #400 (banner contaminated `telepty list --json | jq`
    stdin → `Invalid numeric literal`). A new lint-style regression
    test (`test/banner-stderr-jq-safety.test.js`) statically scans
    `cli.js` and fails CI if any "⚙️/⚠️ Daemon…" banner regresses
    back to `process.stdout.write`.
  - New pure-functional `src/version-handshake.js` exposes
    `decideVersionAction({ daemonVersion, cliVersion })` returning a
    stable action enum (`START` / `RESTART` / `NOOP`) plus reason.
    Six-cell decision matrix: daemon unreachable, CLI-version missing,
    versions equal, daemon older (newer-wins → restart), daemon newer
    (preserve newer daemon → noop), non-semver (string compare).
    Wired into `cli.js` `ensureDaemonRunning` so the previously-inline
    `meta.version !== pkg.version` check now delegates to the module.
  - New port-owner fallback in `daemon-control.js`:
    `findPortOwnerPid(port)` uses `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`
    on POSIX and `Get-NetTCPConnection -State Listen -LocalPort <port>`
    on Windows. `cleanupDaemonProcesses` now treats the listener as a
    third kill candidate (`source: 'port-owner'`) — but only after
    confirming the PID is actually a telepty daemon via
    `pidMatchesTeleptyCmdline`. Unconfirmed port-owners are never
    killed (zero-arbitrary-kill safety). `probeTeleptyOnPort` (HTTP
    `/api/health`) is exported for future async-aware callers.
  - SIGTERM → SIGKILL grace period bumped from 1500 ms to 5000 ms
    (POSIX). Configurable via `TELEPTY_DAEMON_KILL_GRACE_MS` env.
  - New `src/win-kill-process.js` (parallel to existing
    `src/win-resolve-executable.js`) provides `buildTaskkillArgs(pid)`
    and `killWindowsProcess(pid, opts)`. Unit-testable taskkill args
    generator with injectable `execFileSync`. `daemon-control.js`
    Windows branch now delegates to this module.
  - `cleanupDaemonProcesses(opts)` accepts injectors
    (`readDaemonState`, `listDaemonProcesses`, `findPortOwnerPid`,
    `pidMatchesTeleptyCmdline`, `stopDaemonProcess`, `includePortOwner`,
    `port`) for unit-testable source attribution.
  - **Tests**: 343 / 343 pass (301 baseline preserved + 42 new across
    four files: `test/version-handshake.test.js` (16),
    `test/win-kill-process.test.js` (10),
    `test/daemon-control-port-owner.test.js` (10),
    `test/banner-stderr-jq-safety.test.js` (6)).

### Notes

- No new npm dependencies (Constitution §17 무의존).
- No drive-by refactors (Rule 29 surgical); changes limited to
  `cli.js`, `daemon-control.js`, `src/version-handshake.js` (NEW),
  `src/win-kill-process.js` (NEW), and four new test files.
- **Snyk SAST scan on changed files** — `daemon-control.js` +
  `src/version-handshake.js` + `src/win-kill-process.js` +
  `test/version-handshake.test.js` +
  `test/win-kill-process.test.js` +
  `test/daemon-control-port-owner.test.js` +
  `test/banner-stderr-jq-safety.test.js` = **0 findings**
  (At-Inception clean). `cli.js` shows the same **5 pre-existing
  findings** carried from v0.4.2 (2 Medium Command Injection at
  `execSync` (was L469 → now L471) and `pty.spawn` (was L1096 → now
  L1100); 3 Low Path Traversal at `fs.readFileSync`/`fs.readdirSync`
  (was L2308/L2310/L2619 → now L2312/L2314/L2623)) with **identical
  fingerprints** vs HEAD~1 (5/5 verified by direct rescan of HEAD~1
  `cli.js`: fingerprint leading hashes `6eb481d6`, `24799351`,
  `11a45176`, `11a45176`, `e0fda459` all match). Line numbers
  downstream of `cli.js:21` shifted +2/+4 due to the new
  `version-handshake` require + the expanded
  `restartDaemonGraceful` banner/comment paths; logical
  source→sink unchanged, no new sink call sites added. Out of
  telepty#15 surgical scope. Tracked in
  **dmsdc-ai/aigentry-telepty#26** (task #408) for follow-up PR.

## [0.4.2] - 2026-05-17

### Fixed

- **#28** — SSH-peer routing for `telepty inject` / `list` / `enter`
  cross-machine: file-backed `peers.json` fallback resolves the prior
  `fetch failed` against SSH peers in fresh CLI subprocesses. Previously
  `cross-machine.js` consulted only the in-memory `activePeers` Map, which
  is process-local and empty for every CLI subprocess spawned after
  `telepty connect`. New: `listSshPeers` + `getSshPeerHandle` helpers
  (`cross-machine.js`) make SSH-peer discovery/inject symmetric with the
  existing HTTP-peer path; `pickSessionTarget` (`session-routing.js`)
  matches `<id>@<peerName>` against the peer alias; `resolveSessionTarget`
  (`cli.js`) enriches synthetic targets with `peerName` when the host
  matches a known SSH peer. 7 new unit tests
  (`test/cross-machine-ssh-routing.test.js`) + 1 new peer-alias test
  (`test/session-routing.test.js`). Scope: `inject` / `list` / `enter`;
  `attach` / `read-screen` / `rename` / `destroy` / `state` /
  `session info` share the same gap but are deferred to v0.4.3+.

### Notes

- **Snyk SAST scan on changed files** — `cross-machine.js` +
  `session-routing.js` + `test/cross-machine-ssh-routing.test.js` +
  `test/session-routing.test.js` = **0 findings** (At-Inception clean).
  `cli.js` shows **5 pre-existing findings** (2 Medium Command Injection
  at `execSync` L469 + `pty.spawn` L1096, 3 Low Path Traversal at
  L2308/L2310/L2619) with **identical fingerprints** vs HEAD~1 (5/5
  verified). Line numbers for sinks below L543 shifted +21 from the
  `resolveSessionTarget` enrichment block (cli.js L543–L566) — logical
  source→sink unchanged; no new sink call sites added. Out of #28
  surgical scope. Tracked in **dmsdc-ai/aigentry-telepty#26** for
  follow-up PR.

## [0.4.1] - 2026-05-17

### Fixed

- **#25** — Windows PATHEXT resolution for `telepty allow`. npm-global CLIs
  (`claude`, `codex`, `gemini`) now spawn correctly with bare names on
  Windows. Previously `telepty allow … claude` failed with
  `Cannot create process, error code: 2` (ERROR_FILE_NOT_FOUND) because
  node-pty's `CreateProcessW` does not walk `%PATHEXT%` the way `cmd.exe`
  does, so the npm-global `claude.cmd` shim was unreachable from the bare
  name. New: `src/win-resolve-executable.js` resolver (Windows-only branch
  walks `PATH` × `PATHEXT`; POSIX no-op) + 14 unit tests. macOS/Linux
  behavior unchanged.

### Notes

- **Snyk SAST scan on changed files** — `src/win-resolve-executable.js`
  + `test/win-resolve-executable.test.js` = **0 findings** (At-Inception
  clean). `cli.js` shows **5 pre-existing findings** (2 Medium Command
  Injection at `execSync` L469 + `pty.spawn` L1075, 3 Low Path Traversal
  at L2287/L2289/L2598) verified identical fingerprint vs HEAD~1 — out
  of #25 surgical scope. Tracked in **dmsdc-ai/aigentry-telepty#26** for
  follow-up PR.

## [0.4.0] — 2026-05-15

### Added — Phase 1 sidecar supervisor spike (M1–M5)

Out-of-process Rust supervisor (`crates/telepty-supervisor-{core,bin}`)
incubating the future spawn/kill/IPC backend for `daemon.js`. Five
milestones complete; **incubating only — not on the request path** in
0.4.0. Daemon (`daemon.js`) and CLI (`cli.js`) routing is unchanged.

- **M1** — spawn + observe (commit `07cd2e7`).
- **M2** — graceful + forced kill gate, manifest cleanup invariant A8
  (commit `ec00412`).
- **M3** — IPC + wire contract conformance, NDJSON UDS frames + golden
  fixtures (commit `76cde35`).
- **M4** — cross-OS POSIX parity + reproducible RSS measurement, GitHub
  Actions matrix (`.github/workflows/phase1-spike-ci.yml`); RSS PASS at
  2.9–3.0 MiB / supervisor on macOS arm64 (commit `eb04c73`).
- **M5** — manual integration bridge (`scripts/bridge-phase1.js`, 194
  LOC Node stdlib only) — four parity scenarios A/B/C/D, exit 0 iff all
  PASS; one-line Rust correctness fix (emit `shutdown_drain` before IPC
  shutdown so connected clients receive the frame) (commit `be091e0`).

Phase 1 LOC ceiling 1500 honored (Rust src/ tokei = 1240, 260 LOC
headroom unused). Test suite: 23/23 (lib unit 12 + wire_golden 6 +
ipc_protocol 5). Spec: `docs/specs/2026-05-10-supervisor-c3-kill-gate-spec.md`.
Plan: `docs/plans/2026-05-12-phase1-sidecar-spike-plan.md`.

### Fixed

- **#18** — Bootstrap inject queue race. Welcome-banner bypass via
  positive-override `is_ready` so queued injects flush in the correct
  order without colliding with the banner (commit `744ad6a`).
- **#16** — REPORT-based idle status detection. Replaces heuristic
  prompt-symbol detection with explicit REPORT-frame anchoring
  (commit `3ed1e83`).

### Build

- `package.json` — added `files` whitelist (22 entries) to constrain
  npm-published surface to actual runtime distribution. Tarball
  reduction: 228 MB → 123 kB (1850×). The Rust spike artifacts
  (`target/`, `crates/`, `Cargo.lock/Cargo.toml`, `rust-toolchain.toml`)
  ship in git but **not** to npm (commit `a0baf84`).

### Docs

- MD audit wave-2 fix: `CLAUDE.md` converted to `@AGENTS.md` stub
  (101 → 27 lines), `AGENTS.md` gained Session Environment section
  (`$TELEPTY_SESSION_ID`, `$TELEPTY_AVAILABLE`) and disclosed
  cross-repo ADR location for `2026-05-05-telepty-devkit-boundary §6.2.1`.
  Score delta `AGENTS.md` 80 → 87, `CLAUDE.md` 66 → 87 (commit `74a6374`,
  full report `docs/reports/2026-05-14-md-audit.md`).

### Notes

- **Snyk SAST deferred for this release** — see follow-up task #130.
  Waiver basis (Rule 32-A track B):
  - M1–M5 spike code is Rust and is **excluded from the npm tarball** by
    the new `files` whitelist — first-party code shipped to consumers is
    JS only.
  - The shipped JS files are unchanged or only minimally changed since
    `0.3.5` (cli.js +51 / daemon.js +360 / src/prompt-symbol-registry.js
    +44 / new session-state.js — additive, no breaks per Phase 1 audit).
  - Dependency-side coverage exists via `npm audit` (10 pre-existing
    vulns documented; not introduced by this release).
  - Per CLAUDE.md user-instruction "Snyk At Inception" scope = *new
    first-party code shipped* — 0 net-new shipped JS code in this
    release, so the at-inception rule does not bind here. Follow-up
    task #130 will land the standing SAST gate as a release-script
    primitive (so future releases scan automatically without per-run
    auth steps).

## [0.3.5] — 2026-05-05

### Added — `telepty init --print-snippet` (Issue #8)

New subcommand that emits the canonical telepty-baseline snippet to stdout for
graceful integration into per-CLI agent files. **Mechanism only** — telepty
emits the versioned snippet text; downstream tooling (`aigentry-devkit
scaffold --integrate-telepty`) owns idempotent insertion into
`~/CLAUDE.md` / `~/AGENTS.md` / `~/GEMINI.md`. Boundary contract per ADR
`2026-05-05-telepty-devkit-boundary` (commit `e4b072b`).

```
telepty init --print-snippet [--target {claude|agents|gemini|all}] [--format {markdown|json}]
```

- **argv-only**: never consumes stdin (safe in scripted pipelines).
- **zero file I/O**: pure stdout emission; nothing read from or written to disk.
- **deterministic**: byte-identical output for a given (target, format) pair —
  fixtures can be hashed for verification.
- **LF-only bodies**: no CRLF leakage on cross-platform consumers.
- **stderr clean**: success path emits no warnings.

Spec: `docs/specs/2026-05-05-issue-8-telepty-init.md` (commit `8d2dc94`).
Implementation: `f5c6bad`. Protocol SSOT: `aigentry-ssot/contracts/telepty-snippet-v1.md`
(commit `f4ff0cd`). 15 conformance fixtures shipped at `tests/snippet-protocol/v1/`
covering markdown envelopes (claude, agents, gemini, all), JSON records,
shell-hazard guards, deterministic LF output, default targeting, unsupported-target
rejection, internal-failure exit codes, stdin-pipe ignore, devkit-free invocation,
and the snippet golden fixtures themselves.

### Docs — G7/G8/G9 M0 audit gate closure (commit `d7b8b21`)

Per ADR `2026-05-05-telepty-devkit-boundary` §3.1.2 (devkit owns content
placement; telepty owns mechanism), three gates closed:

- **G7 — `README.md`**: removed reference to the rejected `telepty install
  hooks` subcommand. Per ADR §3.1.2, that responsibility lives in devkit.
- **G8 — `AGENTS.md`**: added Legacy exception subsection documenting the
  remaining devkit-shaped legacy surface.
- **G9 — `skill-installer.js`**: top-of-file LEGACY header per ADR §6.2.1
  marking the module as legacy-track (devkit migration pending).

### Internal

- Cross-LLM review pattern applied: Codex implemented the `init` subcommand
  + fixtures; Claude reviewed and ACCEPTed (commit `d06e1e9`).
- `test/enforce-report.test.js` version assertion bumped to track release
  (commit `d0f4495`).

### Tests

- `test/init.test.js` — full coverage of the new subcommand (snippet
  emission, target/format permutations, stdin-ignore, error exits, devkit-free
  invocation).
- `tests/snippet-protocol/v1/` — golden fixtures for protocol conformance;
  `npm test` runs `git diff --exit-code` against them so any drift fails CI.

### Invariants preserved

- Daemon code unchanged. No new dependencies. No `bin` field changes.
- Existing CLI subcommands (`allow`, `inject`, `list`, `tui`, `daemon`, …)
  unchanged.
- Cross-host inject path (0.3.4) unchanged.

## [0.3.4] — 2026-05-05

### Added — Cross-host inject (`<id>@<host>` syntax)

Enables `telepty inject <id>@<host> "msg"` to deliver to a remote daemon
without SSH wrapping, by resolving `<host>` against the peer registry and
issuing direct HTTP `POST /api/sessions/<id>/inject`. Closes the gap that
forced operators to either pre-shell into the host or pipe through SSH.

- **`connect-http` peer mode** (commit `a92cacc`) — new HTTP-only peer
  registration path that does not require a reverse PTY tunnel; suitable
  for daemons reachable via Tailscale / private DNS.
- **`TELEPTY_HOST` env parser fix** (commit `a92cacc`) — `<id>@<host>` now
  parses correctly when the host segment contains a port or non-default
  scheme; prior parser dropped the host portion silently.
- **Peer registry HTTP-only mode** — registry entries can be marked
  HTTP-only so the daemon does not attempt PTY fan-out for them.

### Added — Skill installer auto-detect (`486bc1e`)

`telepty install` now auto-detects which AI CLIs are present
(`claude`, `codex`, `gemini`) and only installs the corresponding skill
files. Reduces noisy "skipped" log lines and prevents stub installs
on machines that don't have the target CLI yet.

### Fixed — Node 18 ESM regression (`fc7ff9a`)

Pinned `uuid@9` (was floating to v10, which is ESM-only and caused
`ERR_REQUIRE_ESM` under Node 18 CommonJS consumers).

### Docs

- Cross-host inject `<id>@<host>` syntax documented (commit `c8b9bbb`).
- `[context-ref]` inject protocol standardized across docs (commit `8986a96`).
- REPORT pattern + orchestrator-id runtime resolution documented in skills
  (commit `658f712`).
- Korean trigger keywords added to skill `SKILL.md` descriptions for
  cross-locale activation (commit `57f46e1`).

### Note — never published to npm

`0.3.4` was version-bumped locally but never reached the registry; this
entry is added retrospectively alongside the `0.3.5` publish so the
changelog history matches the git log. Registry consumers go directly
from `0.3.3` → `0.3.5`.

## [0.3.3] — 2026-05-02

### Added — `inject --submit-force` + idempotent client retry (spec: `docs/superpowers/specs/2026-05-02-submit-force-and-retry.md`)

Closes task #347. Two opt-in CLI knobs on `telepty inject` for cases where
the 0.3.2 prompt-symbol gate has a transient render mismatch (autocomplete
dropdown open, cursor moved, mid-paste race) and the 504 fall-through
forces the human user to press Enter manually.

- **`--submit-force`** — passes `force: true` to `POST /submit`. Skips
  both Layer 3 (prompt-symbol) and Layer 1 (state-gate) and dispatches
  Enter once via the existing `terminalLevelSubmit` chain (kitty → cmux
  → PTY). Daemon-side `force` semantics already shipped in 0.3.1 for
  `telepty send-key`; this just plumbs the flag through inject.
- **`--submit-retry N`** (default 1, clamp [0, 3]) — on a 504 response
  with a retry-safe reason, wait 300 ms and retry the same `/submit`
  request up to N times. Retry-safe reasons (idempotent re-fire is
  guaranteed because the body is verifiably still in the input box):

  | Reason | Source |
  |---|---|
  | `gated_dispatch_unconsumed` | `daemon.js:1680` (verify said body still visible after best-effort dispatch) |
  | `gate_timeout` | reserved (Layer 1 plain timeout — falls through to dispatch in 0.3.1+, not currently a 504 source) |
  | `no_prompt_symbol_seen` | reserved (Layer 3 timeout — currently never emits 504) |

  Hard-fail reasons (`session_dead`, `session_error`, `session_restarting`,
  `no_state`, `no_state_manager`) and any non-504 status (4xx) **never**
  trigger client-side retry — re-firing won't recover.

- **Default behavior preserved**: a bare `telepty inject --submit ...`
  call now retries once on a retry-safe 504. This is a strict improvement
  over 0.3.2 (which surfaced a warning and required manual `send-key`)
  and remains backward-compatible because retry only fires when the
  server tells the client the dispatch demonstrably did not land.

### Tests

- `test/inject-submit-flags.test.js` (NEW, 9 tests) — mock-daemon
  coverage:
  - `--submit-force` adds `force:true` to `/submit` body; success line
    renders `[forced]` tag.
  - bare `--submit` does NOT add `force` to body.
  - default `--submit-retry 1` retries once on `gated_dispatch_unconsumed`
    504 then succeeds; output contains `[retry 1/1]`.
  - `--submit-retry 2` exhausts to 3 calls then prints
    `Submit gated-timeout … after 3 attempts`.
  - `--submit-retry 0` makes exactly 1 call, no `[retry`.
  - `session_dead` 504 → no retry even with `--submit-retry 3`.
  - `no_state` 504 → no retry even with `--submit-retry 3`.
  - `--submit-force --submit-retry 2` preserves `force:true` across retries.
  - 500 error → no retry, prints to stderr.
- `test/enforce-report.test.js` — version assertion 0.2.0 → 0.3.3.
- All 174 existing tests pass unchanged.

### Invariants preserved

- Daemon code unchanged. `force:true` and the gate layers behave exactly
  as in 0.3.2.
- `telepty send-key` unchanged.
- `telepty enter` unchanged.
- `telepty inject --ref` (no `--submit`) unchanged.
- Cross-machine remote inject path unchanged (the SSH branch in `cli.js`
  bypasses the new flags by design — remote daemons handle their own
  submit semantics).
- Exit code on soft failure (504) remains 0; orchestrator scripts that
  check for non-zero exits are unaffected.

## [0.3.2] — 2026-04-26

### Added — Layer 3 prompt-symbol render gate (spec: `docs/superpowers/specs/2026-04-26-prompt-symbol-render-gate.md`)

Strictly additive layer above the 0.3.1 `sessionStateManager` gate. Closes
the recurring "Enter not applied on freshly-spawned `claude`/`codex`" trap
by directly observing the rendered terminal screen for a per-CLI prompt
symbol — the only deterministic ready-signal these TUIs expose to external
automation (no OSC 133, no exit-on-prompt, no socket signal).

- **`src/prompt-symbol-registry.js`** (NEW) — per-CLI prompt-symbol catalog:

  | CLI | Symbol | Codepoint | UTF-8 | Geometry sanity |
  |---|---|---|---|---|
  | `claude` | `❯` | U+276F | `E2 9D AF` | sandwiched between U+2500 (`─`) horizontal-rule borders |
  | `codex` | `›` | U+203A | `E2 80 BA` | model footer (`gpt-N…`) within 2 lines below |
  | `gemini` | `*` | U+002A | `2A` | bracketed by U+2580 (`▀`) above / U+2584 (`▄`) below |

  `lookup(command)` normalizes path + args (`/usr/local/bin/claude --resume`
  → claude entry; `codex resume` → codex entry). Unknown CLIs return `null`,
  causing the gate to skip cleanly via `unknown_cli`.

- **`src/submit-gate.js` `awaitPromptSymbol(session, opts)`** (NEW) — polls
  `cmux read-screen --workspace <id> --lines <n>` (default 30) every
  `pollIntervalMs` (default 150 ms) and resolves only when the symbol has
  been stably detected for ≥ `stabilityMs` (default 200 ms). Bounded by
  `timeoutMs` (default 8000 ms; clamp [500, 30000]). Resolves cleanly with
  one of:
  - `{ ready: true, last_seen_at, waited_ms }`
  - `{ ready: false, reason: 'no_screen_primitive', waited_ms: 0 }` (non-cmux backend)
  - `{ ready: false, reason: 'unknown_cli', waited_ms: 0 }`
  - `{ ready: false, reason: 'no_prompt_symbol_seen', waited_ms }` (timeout, fall through)
  Pure helper: `now`/`sleep`/`readScreen`/`registry` are all injectable for
  deterministic tests (fakeClock harness from `verifyBodyConsumed`).

- **`daemon.js` POST /submit** — Layer 3 runs immediately before Layer 1
  on the gated path. Result threaded into success and 504 response bodies
  as optional `prompt_symbol: { found, waited_ms, [reason], [last_seen_at] }`.
  **Never emits its own 504** — best-effort fall-through to Layer 1, which
  retains all existing 0.3.1 outcomes (success / `gated_dispatch_unconsumed`
  / hard-fail). Per-request bypass via `{ "prompt_symbol_gate": false }`
  (Layer 3 only); `force:true` and `TELEPTY_SUBMIT_GATE=off` continue to
  bypass BOTH layers.

### Tests

- `test/prompt-symbol-registry.test.js` (NEW) — registry coverage with
  inline cmux read-screen fixtures: claude/codex/gemini detect on idle
  screens, banner-stage rejection (no border geometry), history-echo
  disambiguation (LAST occurrence anchored), `lookup()` path/args
  normalization + case-insensitivity + unknown/null inputs, `byteSeq`
  matches `Buffer.from(symbol, 'utf8')`.
- `test/submit-gate.test.js` (extended) — `awaitPromptSymbol` covers:
  non-cmux → `no_screen_primitive`; missing workspace → same; unknown CLI
  → `unknown_cli`; stable claude/codex screen → ready after `stabilityMs`;
  empty `readScreen` returns → `no_prompt_symbol_seen` after `timeoutMs`;
  symbol-then-disappear → stability streak resets; injected registry
  override is honored; `readScreen` receives `(workspaceId, tailLines)`.

### Invariants preserved

- All 32 existing `test/submit-gate.test.js` tests pass unchanged.
- `force: true` and `TELEPTY_SUBMIT_GATE=off` bypass BOTH layers.
- Layer 1 hard-fail short-circuits (`session_dead`/`error`/`restarting`/
  `no_state`/`no_state_manager`) still emit 504; Layer 3 never adds a new
  504 source.
- `inject --ref` (no `--submit`) path unchanged.
- aterm / non-cmux backends skip Layer 3 cleanly via `no_screen_primitive`.
- Cross-machine remote inject unchanged: Layer 3 runs only on the daemon
  with cmux access; remote daemons fall through.
- Response shape additive — `prompt_symbol` is an optional field; existing
  callers ignore unknown JSON keys.

## [0.3.1] — 2026-04-26

### Fixed — submit-gate regression cluster (spec: `docs/superpowers/specs/2026-04-26-submit-gate-fixes-v2.md`)

Three regressions surfaced post-`0.3.0` against fresh-spawned `claude`/`codex`
sessions where the gate's strict thresholds and timeout-abandon path made the
new `/submit` endpoint less reliable than the pre-`0.3.0` blind retry on cold
REPLs. All three fixes ship in this single patch.

- **δ-fix-2 — `send-key` bypass (P0).** `POST /api/sessions/:id/submit` now
  accepts `{ "force": true }` to skip the render-readiness gate and verify
  step, dispatching once via the existing kitty/cmux/PTY chain. `cli.js`
  `send-key` always sets `force:true`, restoring the manual Enter override.
  Response shape additive (`forced:true`); existing callers unaffected.
- **δ-fix-3 — gate threshold relaxed 0.85 → 0.5 (P1).** `sessionStateManager`
  emits IDLE `confidence=0.6` when neither OSC 133 nor a shell-prompt pattern
  matches (`session-state.js:380`) — the dominant case for AI-CLI TUIs whose
  Unicode-box input line bypasses `PROMPT_PATTERNS`. Default `minConfidence`
  lowered to `0.5` (below the 0.6 silence-fallback with margin); per-request
  override `min_confidence` body field accepted (clamped `[0, 1]`).
- **δ-fix-4 — timeout extension + best-effort dispatch on timeout (P1).**
  Default `gate_timeout_ms` raised `5000 → 10000` (upper clamp `15000 →
  30000`) to cover empirical `claude` ready window (3-6 s on fresh spawn).
  On a plain `timeout` reason, `/submit` now dispatches anyway and verifies
  body consumption — the pre-`0.3.0` blind dispatch is restored as a fallback
  while keeping the new honesty signal: 504 only fires when
  `verifyBodyConsumed` confirms the body is still in the input box (new
  `reason: 'gated_dispatch_unconsumed'`). Dispatch-on-timeout success path
  adds `gated_dispatch_after_timeout: true` (additive).
  Hard-fail reasons (`session_dead`/`error`/`restarting`/`no_state`) still
  short-circuit to 504 immediately.

### Invariants preserved

- `inject --submit` warm-session reliability ≥99% target (gate short-circuits
  at conf≥0.85 still passes after default drops to 0.5).
- 504 still emitted in true-fail case (after best-effort dispatch + verify
  reports `still_visible`).
- `TELEPTY_SUBMIT_GATE=off` daemon-wide escape hatch preserved.
- `inject --ref` (no `--submit`) path unchanged.
- 22/23 existing `test/submit-gate.test.js` tests pass unchanged; one test
  (line 185-193) updated to preserve the below-threshold-rejection semantic
  with literals shifted away from the new 0.5 default.

## [0.3.0] — 2026-04-26

### Added — render-gated submit (specs: `docs/superpowers/specs/2026-04-26-inject-submit-enter-reliability.md`)

- **`src/submit-gate.js`** — pure helpers exported for unit tests:
  - `awaitReplReady(sessionId, stateManager, opts)` — waits for the target REPL
    to reach an input-ready state (`idle` or `waiting`) with confidence ≥ 0.85
    before Enter is fired. Bounded by `timeoutMs` (default 5000).
  - `verifyBodyConsumed(session, bodyText, opts)` — polls the session's
    `outputRing` for the inject body to disappear from the input box,
    confirming Enter was actually consumed by the REPL (default 1500 ms,
    200 ms interval). Optimistic when body never visible (ANSI/wrap edge).
  - `isReady`, `isFailed`, `READY_STATES`, `FAIL_STATES` — test surface.
- **POST `/api/sessions/:id/submit`** rewritten to use the gate by default.
  Flow: gate on REPL readiness → dispatch via existing kitty/cmux/PTY chain →
  verify consumption (when caller passes `injected_body`) → bounded retry.
  Response now includes `gated`, `gate_wait_ms`, `verify` (when applicable).
- **HTTP `504 gate_timeout` response** on `/api/sessions/:id/submit` when the
  REPL never readies for input within `gate_timeout_ms` (default 5000).
  This is **why this is a minor bump** — consumers may need to handle the new
  status code. 504 (Gateway Timeout) is the correct semantic versus 408 or
  reused 503 — the daemon acted as a gateway to the upstream REPL and the
  upstream did not respond in time.
- **CLI `inject --submit`** now passes `injected_body` to the daemon for
  consumption verification, removed the legacy 500 ms blind sleep
  (gate handles timing), and treats 504 as a soft failure (logs a clear
  remediation hint, exits 0 — orchestrator scripts depend on exit 0 for
  recoverable conditions).
- New body fields accepted by `/submit`: `injected_body`, `gate_timeout_ms`,
  `verify_timeout_ms`. Existing `pre_delay_ms` / `retries` / `retry_delay_ms`
  remain accepted for back-compat.
- **`TELEPTY_SUBMIT_GATE=off`** env var — escape hatch to revert to the 0.2.x
  blind retry path for parity testing or rollback.

### Changed

- POST `/api/sessions/:id/submit` is no longer open-loop. Default behavior
  is gated; legacy blind retry preserved only behind `TELEPTY_SUBMIT_GATE=off`.
- CLI `✅ Submitted via <strategy>` line now optionally appends
  `[gate <N>ms]` when the gate had to wait. Default-on; pre-existing
  format preserved when gate fast-paths (warm sessions).
- `bus` event `submit` now carries optional fields `gated`, `gate_wait_ms`,
  `verify` (additive — consumers ignore unknown fields).

### Fixed

- Root cause: `/submit` previously fired Enter open-loop with a ~2.1 s
  blind retry budget while a fresh `claude` REPL needed 3–6 s to render
  (welcome banner, trust dialog, prompt setup). The legacy retry loop
  also discarded `terminalLevelSubmit`'s return value, so the reported
  `(N attempts)` count did not reflect verified dispatches. The new
  gate observes the existing `sessionStateManager` (`idle` / `waiting`
  with confidence ≥ 0.85) before dispatch, eliminating the race.
- Recurring orchestrator UX trap (parallel to #329 Track E27) where
  every `inject --submit` required a manual `sleep N && telepty send-key
  <id> enter` follow-up. Spec target: ≥ 99% on a 100× spawn-and-inject
  E2E harness (current baseline ~0%); E2E harness execution is dispatched
  to the builder (out of scope for this commit).

### Tests

- `test/submit-gate.test.js` — 23 new unit tests (all pass) covering
  `awaitReplReady` fast-paths, transition resolution, timeout, fail-state
  short-circuits; `verifyBodyConsumed` happy-path / optimistic / timeout /
  empty / no-ring / whitespace normalization / ANSI strip / injectable
  clock for deterministic timing.
- Pre-existing test suite is unmodified; integration coverage of the new
  endpoint behavior is delegated to the builder per SAWP scope.

### Compatibility / migration

- **Default behavior changes** for callers of `/api/sessions/:id/submit`:
  responses now succeed only when the REPL reaches readiness within
  `gate_timeout_ms`. Most callers will see equivalent or better behavior;
  callers that depended on "best effort fire-and-forget" can opt out via
  `TELEPTY_SUBMIT_GATE=off`.
- `inject --ref` (without `--submit`), `telepty allow`, `telepty list`,
  and `telepty send-key` semantics unchanged.
- Aterm sessions unaffected (gate is bypassed via existing
  `session.type === 'aterm'` guards).
- No new external dependencies (Rule 17). No schema, persistence, or
  state-machine changes (gate is read-only on `sessionStateManager`).

## [0.2.0] — 2026-04-15

### Added — REPORT enforcement (specs/enforce-report-spec.md)

- **New bus event types** for observable REPORT lifecycle:
  - `TASK_IDLE_NO_REPORT` — fires once on idle transition for inject-driven sessions
  - `TASK_COMPLETE_WITH_REPORT` — fires when matching REPORT inject detected via reverse-match
  - `TASK_BLOCKED_WITH_REASON` — fires on `STATUS: blocked` reply inject
  - `TASK_DISMISSED` — fires on `STATUS: dismissed` inject OR via DELETE endpoint
  - `TASK_DEAD_NO_REPORT` — fires when session dies with pending report (attaches `auto_summary`)
- **New HTTP endpoints** on daemon:
  - `GET /api/pendingReports/:id` — inspect pending report entry + optional auto_summary
  - `DELETE /api/pendingReports/:id` — orchestrator-side dismissal; fires `TASK_DISMISSED`
- **New module** `src/report-enforcement.js` exports pure helpers:
  - `classifyReportPrompt(prompt)` — classify inject prompt by prefix
  - `buildAutoSummary(session, opts)` — scrape last N non-blank lines from outputRing with ANSI stripping and secret redaction
- **REPORT detection via reverse-match** in POST `/api/sessions/:id/inject`:
  - An inject with `from=X` whose prompt starts with a REPORT prefix (`REPORT:`, `STATUS:`, `SPEC:`, `OWNER-DIAGNOSIS:`, `ENFORCE-SPEC:`, `ENFORCE-IMPLEMENTED:`, `LOG-FIX-SPEC:`, `LOG-FIX-IMPLEMENTED:`, `FIX-SPEC:`, `FIX-IMPLEMENTED:`, `SPEC-SYNC:`, `DIAGNOSIS:`) and whose recipient matches `pendingReports[X].source` fires the matching enforcement event.
  - Prevents false positives: prefix alone is NOT enough; reverse-match to originating inject required.
- **Auto-summary with secret redaction**:
  - Strips ANSI via shared regex
  - Filters blank lines
  - Caps at `DELIBERATION_REPORT_AUTO_SUMMARY_LINES` (default 40) + `DELIBERATION_REPORT_AUTO_SUMMARY_MAX_BYTES` (default 4096)
  - Redacts `api_key`, `password`, `token`, `secret` assignment patterns → `[REDACTED]`
  - Attached to `TASK_DEAD_NO_REPORT` events and GET query responses

### Changed

- `sessionStateManager.onTransition` handler now fires the enforcement events above. Legacy `TASK_COMPLETE:` text-inject to source session is preserved during 0.2.x grandfather period.
- Legacy auto-report paths (health-poll idle threshold + ready-WS signal) now coordinate via `pendingReports[id].idleNotified` flag to prevent double-fire.
- `pendingReports[id]` schema extended with `awaitingReport: true`, `idleNotified: bool`, `idleAt: ISO8601`. Entry is now cleared only when REPORT arrives, session dies, or orchestrator dismisses.
- Duplicate pendingReports overwrite now emits `[AUTO-REPORT] overwritten pending` warning.

### Configuration (new env vars)

- `DELIBERATION_REPORT_AUTO_SUMMARY_ON_QUERY` — bool, default `true`. Gates auto_summary on GET pendingReports.
- `DELIBERATION_REPORT_AUTO_SUMMARY_LINES` — int, default 40. Max lines in auto_summary.
- `DELIBERATION_REPORT_AUTO_SUMMARY_MAX_BYTES` — int, default 4096. Byte cap on auto_summary.

### Deprecated

- `reportTimeoutSecs` env var — emits deprecation warning if set. Removed in 0.3.x. Evidence (7.5s–649s task range) showed a default timer is arbitrary and prone to false timeouts; replaced with event-driven detection (idle + dead + explicit query).

### Tests

- `test/report-enforcement.test.js` — 28 new unit tests for `classifyReportPrompt`, `buildAutoSummary`, regex exports
- `test/enforce-report.test.js` — 11 new integration tests for bus events and endpoints
- Full suite: **170/170 passing** (131 pre-existing + 39 new)

### Migration notes

- **No orchestrator-side changes required** to benefit. New bus events flow passively; legacy `TASK_COMPLETE:` text-inject still fires.
- Consumers that subscribe to the bus now see richer event types — optional to consume.
- Orchestrators wanting to dismiss a pending report can use `DELETE /api/pendingReports/{id}`.
- Orchestrators wanting on-demand summary can use `GET /api/pendingReports/{id}` (honors `DELIBERATION_REPORT_AUTO_SUMMARY_ON_QUERY`).
