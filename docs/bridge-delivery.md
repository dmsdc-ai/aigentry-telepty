# Bridge delivery contract (`bridge-stage-receipts-v1`)

Applies to `telepty allow` bridges and the daemon from Telepty 0.10.0 (task 1215, #136/#137).
This page describes what the bridge does with daemon `inject` frames it cannot write at once, and
what it reports back. Nothing here establishes that a model read, accepted or completed anything.

## Readiness (F1)

> **0.10.1:** a ready or idle frame, output quiet, VT availability and the settle timer no longer
> hold an inject. The bridge writes at once. Only a real modal, local typing, an exited child, a
> handoff or a closed session hold it. This section describes 0.10.0 and still describes how the
> first-ready fields of `bridge_queue` are computed. See *Immediate delivery and a single Enter* below.

> Task 1215 repair: everything in this section is the **guarded worker's per-delivery interaction
> guard** (withhold while busy, modal, permission prompt, composer not observed, or user typing).
> It is not spawn readiness. Spawn readiness for every role is the authenticated transport
> handshake in *Spawn readiness milestones* below; `bridge_queue.first_ready_observed` and
> `ready_source` describe this guard only.

For a known AI CLI (codex, claude, gemini) on a local PTY, the bridge keeps a bounded VT grid
(`src/vt/session-screen.js`) fed with the child's actual output and resizes. While records are
pending, the 500 ms tick reads the rendered frame after 750 ms of output quiet
(`TELEPTY_BRIDGE_READY_SETTLE_MS`). A frame is ready only when it is a complete, current `vt_grid`,
no busy marker is in its bottom 6 rows, no modal owns it, and the user has not typed within the
idle threshold. A ready frame uses the same `onReady` route as the raw-tail detector.

There is no blind timer for a known AI CLI. This covers the first write and every write after the
first ready (the old 5 s fallback ignored busy and modal frames). If the VT library is unavailable,
or `TELEPTY_BRIDGE_VT_READY=0` is set, the raw-tail detector is the only ready source. Without a
ready, nothing is written.

## Bounded, visible wait (F2)

- **15 s** (`TELEPTY_BRIDGE_STALL_MS`): a pending record gets one `withheld` receipt per reason
  change. The reason is one of `first_ready_unobserved`, `ready_unobserved`, `busy_indicator`,
  `modal_ui`, `user_input_recent`, `handoff_pending` or `vt_unavailable`. Nothing is written.
- **600 s** (`TELEPTY_BRIDGE_INJECT_TTL_SECS`): the tick moves the record to dead letter as
  `expired_unwritten`, with its payload kept in `dead-letter.jsonl`. The receipt is `quarantined`
  with certainty `not_written`.
- A submit CR paired with an expired body is withdrawn in the same tick as `pair_unwritten`.
  A CR that arrives later for a quarantined body is `refused`. It is never written alone.

`bridge_queue` summaries (pending, in-flight, oldest age, phase `open|waiting|stalled|draining`,
reason, ready source, `vt`, `bridge_version`, `bridge_code_digest`) are sent on change, at most
once per second, and also ride the heartbeat. They are computed from an in-memory record index;
the tick never re-reads queue history. `vt` is `available`, `unavailable:<reason>`, `disabled`,
`awaiting_output` or `not_applicable`.

## Stage receipts (F3)

Every daemon inject frame carries `daemon_msg_id`, `inject_id`, `part` (`body`/`submit`), `pair`
(the body id, on a submit) and `owner_generation` when the daemon knows them. Old bridges ignore
these fields. The bridge sends payload-free `bridge_receipt` frames of at most 512 B. Each stage
allows only certain certainties:

| stage | certainty | meaning |
|---|---|---|
| `queued` | `not_written` | durably appended to the bridge mailbox |
| `withheld` | `not_written` | still pending; `reason` says why |
| `pty_written` | `written` | `child.write()` returned for this record. **A PTY master write only.** |
| `quarantined` | `not_written` / `unknown` | moved to dead letter with its payload; never written afterwards |
| `refused` | `not_written` | refused before any write |
| `unknown` | `unknown` | the write threw. Do not retry blindly. |

`consumed`, `turn_accepted` and `completed` are never emitted. The daemon refuses them.

The daemon advertises `bridge-stage-receipts-v1` in `/api/meta`. It accepts `bridge_receipt` and
`bridge_queue` only from the current owner socket, with the current `owner_generation`, and also
through the strict-owner transport. Shape and size are validated before any effect. A receipt is
filed on a tracked inject only when that record belongs to the same session, epoch and owner
generation. Diagnostics derive `input_written` and `submit_written` from `pty_written`, and
`queue` and `rejection` from the other stages. Consumption is never derived from a receipt.

A session whose bridge has not reported in the current owner generation shows
`bridge_receipts: unsupported_by_bridge`. That is an old bridge, not a delivered one.

## No relabel, no replay (F4)

- Flush drops (TTL, consecutive duplicate) are dead-lettered (`expired_unwritten`,
  `bridge_duplicate`), never acked.
- On start, records left by a previous bridge are quarantined, never replayed. Pending records
  become `recovered_previous_bridge` (`not_written`). In-flight records become
  `recovered_in_flight_unknown` (`unknown`).
- On a destroying exit (child exit, SIGTERM, daemon close 1000/4001), every record still pending
  or in flight is dead-lettered with its payload before the live queue files are cleared
  (`bridge_exit_unwritten` / `bridge_exit_in_flight_unknown`). If any record cannot be moved,
  nothing is purged. A refused claim (4003) touches nothing.
- Daemon ids are kept in the bridge's in-memory record index and in the dead-letter row. They are
  not written to `inbox.jsonl`/`state.jsonl`, whose strict custody schema does not admit them.

## Immediate delivery and a single Enter (`immediate-submit-v1`, 0.10.1)

**Bridge admission.** An authorized inject into a live, writable wrapped child is written at once,
in order and exactly once. This holds while the CLI is working, thinking, streaming, loading or
showing a frame no detector recognizes. Output, a busy marker, a missing composer, an unobserved
first ready, VT being unavailable and the settle timer are not reasons to hold it. Queueing a
message while the CLI is busy is left to the CLI's own input handling. These conditions still hold
an inject, each with a `withheld` or `refused` receipt:

- a real modal or permission prompt (`modal_ui`, guarded owners only)
- the local user typing within 2 s (`user_input_recent`)
- an exited child during restart (`child_restarting` / `child_exited`)
- a pending handoff
- a closed session
- an unwritable child or owner transport.

The TTL and dead-letter custody are unchanged.

**Capability.** A 0.10.1 bridge adds `immediate-submit-v1` to the authenticated owner-claim header
`x-telepty-bridge-capabilities`, alongside `input-transport-ready-v1`. The daemon binds it at the
single place an owner generation is minted, so every claim resets it. It is honoured only for that
generation and only with that generation's negotiated input-transport handshake. It is never
inferred from a receipt or from timing. View: `GET /api/sessions/<sid>` → `transport.immediate_submit`
(`supported` | `unsupported_by_bridge` | `not_applicable`).

**`POST /api/sessions/<sid>/submit` on a supported session.** The request keeps every real fence:

- closing session
- protected input or external approval or handoff
- ssh
- the input-transport/bootstrap queue: an unwired child, plus FIFO behind parked work. This queue is bounded by `gate_timeout_ms` and then cancelled, so a cancelled op is never written later.
- the modal gate (hold, park or refuse)
- held interaction, the open owner socket and the current owner generation (re-checked at the write)

Then it sends **exactly one** CR frame, stamped with the owner generation and, for a named inject, the `inject_id`
and the `pair` of the body this daemon handed to the same generation (required since hotfix480, see below). These are skipped on this path: the prompt-symbol
wait (8 s), the REPL-ready/busy-settle wait (10 s), the input-settle wait (1.2 s), the confirm retry
loop, the queued redeliver, gate-off retries and the force CR gap. `force: true` takes the same
single-attempt path and does **not** bypass the input-transport fence. Response:

| `submit_stage` | HTTP | meaning |
|---|---|---|
| `sent_to_bridge` | 200 | the CR frame was handed to the current owner bridge. `pty_write: reported_by_bridge_receipt`, `consumption: unknown`, `submit_confirmed: false` |
| `queued` | 200 | parked behind a real fence (`parked: surface_modal`); written once, in order, when it clears, or dropped with a recorded outcome |
| `not_written` | 409/503/504 | refused, cancelled or flushed before any CR frame was sent |
| `unknown` | 5xx | a queued op failed or timed out after its single write had started. Do not retry blindly. |

`telepty inject --submit` prints that stage. It exits 0 for `sent_to_bridge` and `queued` and 1 for
`not_written` and `unknown`. It never prints "gated-timeout" for this path and never suggests a forced Enter.

**One Enter per message at the bridge.** The bridge admits at most one submit CR per `inject_id` and
per `pair` in each owner generation. This covers repeated `/submit` calls, an older daemon's retries, and a
paired CR followed by a terminal-level CR. The admitted CR's state is recorded before the write
(`admitted` → `attempted` → `written`, or `unknown` if `child.write` threw, or `not_written` if it
was refused or quarantined unwritten). A later CR for the same key is refused, not written, with
reason `duplicate_submit:<that state>`. That receipt names only the later frame's own
`daemon_msg_id`. It never relabels the earlier CR, so a written or unknown Enter is never reported as not
written. A direct write that throws is receipted `unknown`/`write_threw` and is never retried. Id-less
legacy CRs are never deduped and keep the adjacency refusals. Body→CR FIFO is unchanged.

**Body custody before the Enter (hotfix480).** `inject --submit` can reach `/submit` while its body is
still in the daemon mailbox: the delivery tick was already running, or an earlier message was ahead,
because each tick dequeues one message per session. The daemon tracks every wrapped body from the
moment it is queued until it leaves its custody. A named immediate CR whose body is still held is queued
behind that exact body. It is released once, on that body's actual handoff to the owner, and the
owner instance, the admitting generation and the pair are checked again. This is an event, not
a poll, dwell, output or ready wait. It is bounded by `gate_timeout_ms`:

- **Timeout.** The response is `not_written`/`body_custody_pending`, and the CR is never written later.
- **Body leaves without a handoff.** If the body is withdrawn, dead-lettered, has an unknown outcome, or its session or owner
  changed, the response is `not_written`/`body_not_handed`.

An id-less immediate CR, such as a manual or legacy caller,
waits the same way behind every body still held for the session, and it stays id-less. The same attempt
runs on the direct path, forced or not, and on the queued/parked drain.

**Terminal mailbox transitions end custody (hotfix492).** When the delivery engine's own TTL expiry
(`expireStale`) or in-flight recovery (`recoverInflight`) moves messages of a session to a terminal state,
every body still held for that session whose message is now terminal leaves custody at once:

- `expired` was never handed, so a waiting named CR gets `not_written`/`body_not_handed`.
- A `dead_letter` or purged message may be a recovered, fenced attempt whose write is unknown, so it gets
  `not_written`/`body_outcome_unknown`. It is never reported as never written, and it is never replayed.
- Bodies that are pending, in flight or retrying stay held.

A manual id-less Enter is therefore not blocked by a body that can no longer be handed. No age, output or polling rule
is involved, and the dead letter keeps its payload.

**Modal re-check after the wait (hotfix492).** If the CR actually waited on its body, the modal decision that applies
to this owner is asked again right before the single write. It keeps the owner policy: a user-supervised owner
is never gated by the surface classifier, and `TELEPTY_MODAL_REMEDY=off` stays off.
- On the `/submit` route, `park` parks the CR behind the modal (pinned, `queued`), and `hold`/`reject` answer 409
  `SURFACE_MODAL` `not_written`.
- A queued drain refuses `not_written` with the modal reason.

**Pinned queued ops (hotfix480).** An op that `/submit` queues or parks on the immediate path records the
owner generation and capability that admitted it. At drain, it is refused before any effect if
the owner instance, generation or capability changed (`not_written`/`owner_generation_changed`). It never
falls back to the legacy settle/confirm/retry branch. The stage of a failed queued op comes from its own
progress: `not_written` while its single write has not started (cancelled, flushed, refused), and `unknown` once it has.
A 504 alone is never read as "no Enter". A cancelled op is never written later.

**A named inject never gets an id-less Enter (hotfix480, fail-closed).** An immediate CR for an
`inject_id` is sent only together with the pair of a body that this daemon handed to the current owner
generation. If that body went to another generation, the response is `not_written`/`owner_generation_changed`.
If the daemon has no pair for it (never handed, or retired from the bounded history), the response is
`not_written`/`submit_pair_unavailable` with `prior_submit: unknown`. That refusal covers this request
only. It says nothing about an earlier Enter for the same inject, and nothing is replayed. Manual calls
without an `inject_id` keep their own guards.

**Lifetime and capacity (exact).**

| state | where | bound | lifetime | on overflow |
|---|---|---|---|---|
| body custody | daemon, per session, in memory | 256 entries | from enqueue until the body is handed, leaves custody, or its mailbox message turns terminal | never evicted (hotfix492): a NEW wrapped inject is refused before it is queued, 503 `BODY_CUSTODY_FULL`, `bytes_written: 0`; accepted bodies keep their Enter |
| pair history | daemon, per session, in memory | 256 entries | owner generation of the handoff | the oldest is dropped; a later named /submit for it is refused `submit_pair_unavailable` |
| single-CR guard | bridge process, in memory | 4096 keys, 2 per message | the body's keys are entered as `open` when it arrives; the CR moves them to admitted/…/written | the oldest key is dropped, and its owner generation is marked; a named CR with no keys in a marked generation is refused `submit_guard_evicted` |

Nothing is persisted. A daemon or bridge restart starts empty: there is no guarantee across a restart,
and restart custody applies instead. The bridge remembers the marks of the 64 most recent generations.
An old (0.10.0) daemon is not covered: its id-less CRs were never deduped.

**Dropped duplicates are quiet.** At the bridge flush, a consecutive duplicate that is dropped prints no
warning. It is still dead-lettered with its payload (`bridge_duplicate`/`not_written`) and receipted
exactly as before. Stale/expired drops and write errors still warn and report.

**Compatibility.**
- New daemon with an old (0.10.0) bridge: `immediate_submit: unsupported_by_bridge`, and `/submit` keeps the
legacy gated path and wording. That bridge still holds injects until it sees a ready prompt.
- Old daemon with a new bridge: the bridge writes at once and dedupes, and the old daemon's `/submit` waits and retries as before. Its extra CRs for the same `inject_id` are refused at the bridge.
- ssh, spawned, aterm and other unwrapped sessions are `not_applicable` and unchanged.

**Records already queued before the upgrade (custody, no auto-replay).** A running bridge keeps
the code it was started with. Records that a 0.10.0 bridge holds (for example `pending 2 / stalled /
ready_unobserved`) stay in that bridge's queue until the user or controller restarts it. Restarting a
bridge is an explicit operator act; this release does not do it. When a 0.10.1 bridge starts on that
queue, it dead-letters every leftover record with its payload and `msg_id`. Pending records become
`recovered_previous_bridge`/`not_written`, and in-flight ones become `recovered_in_flight_unknown`/`unknown`.
They are never replayed, purged or acked. To reconcile, use the existing read-only views only:

- `GET /api/sessions/<sid>` → `transport.bridge_queue` (current owner generation) and `transport.immediate_submit`
- `telepty diagnose <sid> --inject-id <id>` → `messaging.input_written` / `submit_written`
- the bridge's own `~/.aigentry/mailbox/bridge/<sid>/dead-letter.jsonl`, read only
- the controller's custody record of the original instruction.

Re-issuing is a new inject with a new `inject_id`. Never send a bare Enter for a record whose outcome
is unknown. Do not hand-edit or purge a queue directory.

## Recipient input policy: user-supervised orchestrator vs guarded worker

Workers can show interaction and permission prompts, so they keep every screen gate above. The
orchestrator is watched and controlled by the user, so its input is not gated on screen
inspection. The authority is `src/mailbox/input-policy.js`.

| | `user-supervised` (orchestrator) | `guarded` (workers, unknown, default) |
|---|---|---|
| Daemon admission | Authenticated current owner, live owner WebSocket and that owner's `input_transport_ready` milestone. No screen ready gate (`isBootstrapGatedSession` is false), no modal classifier or park (`modalDeliveryDecision` delivers). Items queued before the handshake drain FIFO when it arrives. | `input_transport_ready` (never a screen `ready`) releases the bootstrap gate; then modal hold/park/refuse as before. |
| Bridge admission | Live child plus the user's own typing quiet (`IDLE_THRESHOLD`). No tail detector, no VT grid, no busy/modal/glyph/model/case matching. TEXT, paired CR, flush and own-record re-admission all use this rule. | Unchanged: tail or VT-frame ready; busy, modal, recent input, VT-unavailable and kill switch fail closed; no blind timer. |
| Always kept | Receipts, duplicate suppression, TTL/pair quarantine, previous-bridge quarantine (no blind replay), payload preservation, body-before-submit order. | Same. |

The policy is never inferred: not from a process or command name, SID text, `--from`, payload text,
inject-frame fields, bridge-reported fields, environment variables or the screen.

### Authority: a verified operator principal, in one of two configurations

`user-supervised` is granted only to a request authenticated by a server-verified Ed25519
**operator** principal (trust entry `authority: "operator"` with a `session.register` grant for the
orchestrator's session id). The daemon token is never authority for it: every wrapped child inherits
that token (child environment, shared HOME configuration), so a token match, an omitted session
header, SID/role text or a client-side environment check does not qualify.

| | Combined mode (ordinary transport + scoped operator proof) | Explicit strict mode |
|---|---|---|
| Daemon | `TELEPTY_SUPERVISION_TRUST_FILE=<trust file>`, or persistently `"supervisionTrustFile": "<absolute trust file path>"` in `~/.telepty/config.json` (a non-empty env value wins) | `TELEPTY_PRINCIPAL_MODE=strict` + `TELEPTY_PRINCIPAL_TRUST_FILE=<trust file>` |
| Bridge | `TELEPTY_SUPERVISION_CLIENT_FILE=<operator client config>` | `TELEPTY_PRINCIPAL_CLIENT_FILE=<operator client config>` |
| Ordinary requests | Daemon token / session bearer / JWT peers exactly as without supervision | Every request must carry a principal assertion; no token fallback |
| Operator proof | Only on `POST /api/sessions/register` asking for `user-supervised` (and its reconnect re-registration) | On every request |
| Owner WebSocket | Ordinary owner claim (bearer + capability) | Strict owner transport |

Both use the same `telepty.principals/v1` trust format, the same verifier (method, target, body
digest, action, audience, challenge, expiry, nonce replay, grant, operator-only, persisted owner and
current epoch on an existing record) and the same challenge endpoint `GET /api/auth/challenge`.

Fail-closed configuration:
- Neither strict mode nor `TELEPTY_SUPERVISION_TRUST_FILE` configured ⇒ supervision is off; every
  `user-supervised` request is registered guarded with
  `input_policy_refused: "INPUT_POLICY_OPERATOR_REQUIRED"`.
- Trust file set but unreadable or invalid ⇒ the daemon does not start (verification is never
  silently disabled). Set together with strict mode ⇒ `SUPERVISION_MODE_CONFLICT`, the daemon does
  not start.

Persistent setting (`supervisionTrustFile`):
- A service manager (launchd, systemd `--user`), a detached `telepty daemon start`, the CLI's automatic
  restart and the npm-upgrade respawn do not inherit your shell, and service descriptors carry a fixed
  environment that every install regenerates. Put the path in `~/.telepty/config.json` instead; every
  daemon boot path reads it. Only the path is stored — never trust or key bytes. Service descriptors are
  unchanged.
- Precedence: a non-empty `TELEPTY_SUPERVISION_TRUST_FILE` wins; otherwise the config key; neither ⇒ off
  (guarded, exactly as before). A missing config file is "not set".
- The value must be a non-empty, absolute, normalized path of at most 4096 bytes with no control
  characters. Anything else is `SUPERVISION_CONFIG_INVALID` and the daemon does not start. An existing
  config that cannot be read or parsed is not "not set": lifecycle commands refuse with
  `SUPERVISION_CONFIG_UNREADABLE`. The daemon itself only boots through it when `TELEPTY_AUTH_TOKEN` supplied
  the secret (the recovery path), and then boots guarded and logs `[SUPERVISION] … UNAVAILABLE`.
- Preflight: `telepty service install|start|restart`, `telepty daemon start|restart`, the menu's daemon
  start, `telepty update`/repair, the CLI's automatic upgrade restart, the npm postinstall upgrade and
  `install.js` check the setting BEFORE stopping, unloading or replacing anything, using the same trust
  loader the daemon uses. A refusal prints only its code (`SUPERVISION_CONFIG_INVALID`,
  `SUPERVISION_CONFIG_UNREADABLE`, `SUPERVISION_MODE_CONFLICT`, `SUPERVISION_UNSUPPORTED_PLATFORM`,
  `PRINCIPAL_TRUST_UNAVAILABLE`), and the running daemon keeps running.
- Preflight checks two local views, at that moment:
  - **this process:** its environment first, then the config, with its `TELEPTY_MACHINE_ID`/hostname
    audience. This is what a detached or inherited start receives.
  - **the persistent setting a service-managed replacement reads:** launchd, systemd `--user` and schtasks
    descriptors carry no `TELEPTY_*` variable, so that daemon resolves the config key alone, with the hostname
    audience.

  A `TELEPTY_SUPERVISION_TRUST_FILE` exported in your shell therefore decides only the first view. Whenever
  it does, the persistent key is checked too, with the same rules. A valid override plus an invalid or
  unreadable persistent setting is refused before anything is stopped. A valid override with NO persistent
  key proceeds, and a service-managed replacement then runs guarded. The daemon's own rule (env wins) is
  unchanged. Refusal lines still print only the code. Which view failed (`calling_process` or
  `service_persistence`) is reported as `failed_scope` by `telepty service status --json`.
- Preflight is not the running daemon's effective policy. `telepty service status` reports
  `supervision: {configured, source, preflight}` (`--json` adds `failed_scope` and `service_persistence`) and
  marks the daemon's effective policy as unmeasured. Only `GET /api/auth/challenge` (200 = supervision on) on that daemon shows
  the effective policy.
- Windows: the trust-file reader has no Windows backend, so a configured setting is refused
  (`SUPERVISION_UNSUPPORTED_PLATFORM` in preflight; the daemon does not start).
- `telepty uninstall` keeps `~/.telepty` and the key; `--purge` deletes `~/.telepty`, so keep the trust file
  itself outside it. Remove the key and restart to return to guarded.

Local admission check (`telepty allow-check --input-policy user-supervised`):
- Runs the SAME parse and the same admission as `telepty allow --input-policy user-supervised`
  (`src/cli/allow-admission.js`). That covers the nested-session refusal, the strict, handoff and
  cooperative rules, and the operator client checks: loading `TELEPTY_SUPERVISION_CLIENT_FILE` and its
  key through the private-file reader, and the local origin. Then it stops.
- It is local and non-mutating. It creates no credential channel, starts or ensures no daemon, makes no
  network request, does no registration, opens no listener, and writes no config or file. The client and key
  are only read into memory.
- Exit `0` comes only with exactly one JSON line (at most 1 KiB):
  `{"schema":"telepty.allow-admission/v1","ok":true,"telepty_version":…,"input_policy":"user-supervised","supervision_client":"loaded","daemon_origin":…}`.
- Exit `1` means refused. An admission refusal prints a code-only line
  `{"schema":"telepty.allow-admission/v1","ok":false,"code":…}`; a parse refusal (nested session) keeps its
  stderr text. Checker-only codes: `ALLOW_CHECK_CREDENTIAL_REFRESH_UNSUPPORTED` (the check never creates the
  refresh channel) and `ALLOW_CHECK_SUPERVISION_CLIENT_REQUIRED` (no operator client configured).
- Exit `2` means any other argv, including `--help`, and prints usage.
- No path, key material or stack is printed.
- An older telepty answers this unknown command with help and exit 0, so a caller must accept ONLY the
  schema-valid success line.
- It proves admission in THIS environment at THIS moment. It says nothing about a running daemon, its trust or
  challenge audience, the network, or whether a later registration will be granted.
- A real `telepty allow` now runs the same admission BEFORE creating the credential-refresh channel, so a
  refused allow creates no channel. Its refusal texts are unchanged.
- Combined mode: a presented operator proof that fails verification ⇒ the request is refused
  (`SUPERVISION_PROOF_INVALID`, `detail` = verifier code); no proof ⇒ registered guarded with the
  explicit refusal. Any other request ignores the header.
- Bridge: `TELEPTY_SUPERVISION_CLIENT_FILE` combined with `TELEPTY_PRINCIPAL_CLIENT_FILE`, used without
  `--input-policy user-supervised`, invalid, targeting a different daemon, or used with an SSH child
  ⇒ refused before anything starts. It never switches the bridge to strict owner transport.

### Grant lifecycle

1. *Request (registration).* `POST /api/sessions/register` takes
   `input_policy: "user-supervised" | "guarded"`. `user-supervised` is refused — the session stays
   guarded and the response names `input_policy_refused` — when:
   - another session's `x-telepty-session-token` is presented, or a new registration presents any
     session bearer (`INPUT_POLICY_SESSION_BEARER`);
   - an existing instance is re-registered without the instance's current bearer
     (`SESSION_CREDENTIAL_REQUIRED`; this also applies to `guarded`, so an uncredentialed caller
     cannot downgrade it either);
   - an existing instance is re-registered without a verifiable input-policy capability and does not
     meet the restored-owner rule below (`INPUT_POLICY_CAPABILITY_REQUIRED`) — the session's own
     bearer is never enough, because the bridge exports it to the child;
   - no verified operator principal authenticated the request (`INPUT_POLICY_OPERATOR_REQUIRED`);
   - the record has no credential (`INPUT_POLICY_CREDENTIAL_REQUIRED`);
   - the session is SSH, mailbox/aterm or external-approval protected (`INPUT_POLICY_UNSUPPORTED`).

   A granted request is only **pending** (`input_policy_pending: true`).
2. *Capability.* An input-policy capability is returned in exactly two responses:
   - the **201** of a granted new registration (with the session bearer, once);
   - the **200** of a re-registration by the **restored persisted owner** (below), once, as a fresh
     capability.

   No other response carries it. The bridge keeps it in memory only — never in `process.env`, the
   child's environment, logs or any view. The daemon keeps only its SHA-256, bound to the instance
   epoch, credential generation and grant attempt, in memory (never in `sessions.json`).
3. *Bind (owner claim).* The next bearer-proved owner claim that also presents
   `x-telepty-input-policy-capability` mints a new `owner_generation` and binds the pending policy to
   exactly that generation. A claim without the capability (for example a child holding the exported
   bearer) leaves the pending request for its rightful owner and is guarded. A later claim without a
   fresh pending request is guarded. A live reconnect re-registers with its operator proof, current
   epoch, bearer and held capability, then claims again.
4. *Daemon restart / restore.* The capability is memory-only, so after a restore the bridge's held
   capability no longer verifies. The persisted owner obtains a **fresh** capability (200, above) by
   re-registering with `input_policy: "user-supervised"` when all of these hold: the operator assertion
   is verified for `session.register` on that session id and bound to the record's current epoch; the
   principal equals the persisted `owningPrincipal` (id, source, audience); the presented session
   bearer verifies to that session id, epoch and current credential generation; and no live grant
   exists, and the record was restored from disk with supervision still granted. The old capability is
   never accepted again. Other operators, workers, stale epochs, and missing or failed bearers are
   refused and stay guarded.
   *Restart versus revocation.* An explicit downgrade (`input_policy: "guarded"`) revokes supervision
   durably: the daemon records only the non-secret fact "supervision granted and not revoked", removes
   it on downgrade, and a re-request carrying the old capability is refused
   (`INPUT_POLICY_CAPABILITY_REQUIRED`) whether or not the daemon restarted in between. A lost grant
   without a restart (for example after credential rotation) is not a restore either. Returning to
   supervision after a downgrade needs a fresh launch.
5. *Not promoted (migration limitation).* A record registered without an operator owner (no
   `owningPrincipal`, e.g. a legacy token registration), or a bridge relaunched without the
   instance's bearer, cannot become supervised. There is no automatic takeover and no credential
   reset; the supported path is a new instance launched by the approved boot helper.
6. *Bridge.* The bridge is supervised only when it was launched with `--input-policy user-supervised`
   **and** the daemon's `owner_token` for the current generation says `user-supervised`. On disconnect
   it is guarded. A launch from inside a telepty session (`TELEPTY_SESSION_ID`/`TELEPTY_SESSION_TOKEN`
   inherited) is refused. A refused grant prints `input_policy user-supervised was not granted (...);
   this session runs GUARDED` (or `was not re-granted` on reconnect). If supervision is lost mid-child,
   VT readiness reports `unavailable:mid_stream_after_supervision` and fails closed.

Effective state: `GET /api/sessions/<sid>` → `transport.input_policy` (`user-supervised` or
`guarded`) and `transport.input_policy_source` (`operator_principal_registration`).

### Environment scrubbing is not key isolation

The daemon removes `TELEPTY_SUPERVISION_TRUST_FILE` and `TELEPTY_SUPERVISION_CLIENT_FILE` from its own
environment, so spawned sessions do not inherit them; the bridge removes both (and, in strict mode,
`TELEPTY_PRINCIPAL_CLIENT_FILE`) from its child's environment. That only hides the paths. The operator
private key is isolated only when guarded workers cannot read it — confined workers, a separate uid,
or a sandbox that denies the key path. A guarded worker running as the operator's uid can read a
`0600` key. Key isolation is a deployment requirement this package does not provide or verify.

### Platform support for trust and key files

Trust and client files are read through `readAuthorityFile`, whose backend follows the actual host
platform (a `platform` option that disagrees fails closed with `platform_mismatch`).
- Linux: descriptor-relative reads via `/proc/self/fd`.
- macOS: a bundled first-party Node-API reader (`src/principal/native/authority-darwin.c`, one export
  `readVerified(path, maximum, privateFile)`). It pins every directory with
  `openat(…, O_EVTONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)` relative to the previous descriptor, applies
  the Linux owner/mode/root-sticky rules, opens the leaf with `O_NOFOLLOW|O_NONBLOCK`, requires a
  regular file owned by root or the user with `nlink == 1`, size within `maximum` and no group/other
  bits when private, reads with a bounded loop and re-checks dev/ino/size/mtime/ctime; an extended-ACL
  ALLOW entry granting write/delete/security/owner rights, or an unreadable ACL, is unsafe. Every
  descriptor is closed and the buffer zeroed on all paths; pathnames are never re-read and there is no
  pathname or `O_RDONLY` fallback. `src/principal/authority-file-darwin.js` loads only
  `src/principal/native/prebuilt/darwin/authority-darwin.node` (fixed package path, no override, no
  runtime compile or download); absent or malformed ⇒ `darwin_native_reader_unavailable`.
- macOS build (release/CI only): `node scripts/build-authority-darwin.mjs --cc <clang> --sdk <MacOSX SDK>
  --node-headers <dir with node_api.h>` → universal arm64+x86_64 bundle, `-mmacosx-version-min=11.0`,
  `NAPI_VERSION=8`, plus `authority-darwin.node.provenance.json` (source/header/compiler hashes, argv,
  archs, output sha256). Every compiler/lipo child gets only PATH, ZERO_AR_DATE, SOURCE_DATE_EPOCH,
  LANG and a private HOME/TMPDIR/TMP/TEMP inside a fresh 0700 `.build-*` directory beside the output
  (verified before any spawn, removed on success and failure). Not hooked to any npm lifecycle script;
  the binary is not committed and ships through `files: ["src/"]`. CI macOS legs build it before the
  suite; the release job checks `lipo -archs`, runs the native tests with zero skips, and `publish`
  re-verifies its sha256 and fails unless the tarball contains it and its provenance.
- Under a sandbox that denies reads of an ancestor directory (for example a home directory) while
  allowing a subtree below it, the macOS reader is expected to refuse files in that subtree: it must
  open every ancestor as a descriptor, while a plain path-based read only needs the final file. This
  follows from the sandbox profile rules; the exact kernel denial has not been observed. Place
  authority files where the reading process may open every ancestor directory.
- Windows: unsupported (fails closed).

### Verification status

Independent unchanged regression runs passed for the restore lifecycle (4/4) and combined
authentication (9/9), and the native macOS reader passed its frozen tests on darwin arm64 with a
fixture outside the home directory (7 pass, 1 Linux-only skip). Not covered by those runs: an
installed package, a live daemon/bridge/network, x86_64 or Windows, files under a sandbox-denied home
directory, operator-key isolation, and real prompt delivery or ACK.

Earlier fixtures that obtained supervision with the daemon token now observe a refusal by design.
Already-installed or running sessions are not changed: they need the upgraded package and a relaunch
through the approved boot helper.

## Spawn readiness milestones (`input-transport-ready-v1`, every role)

A current bridge declares `x-telepty-bridge-capabilities: input-transport-ready-v1` on its owner
claim. `owner_token` then carries `transport_readiness: "input-transport-ready-v1"` and a fresh
per-generation `readiness_nonce`. The bridge sends two frames on the owner socket:

```
{"type":"process_started","schema":1,"session_id":"<sid>","session_epoch":"<epoch>","owner_generation":"<gen>",
 "readiness_nonce":"<nonce>","child_seq":1,"pid":12345,"exec":"unverified"}
{"type":"input_transport_ready","schema":1,"session_id":"<sid>","session_epoch":"<epoch>","owner_generation":"<gen>",
 "readiness_nonce":"<nonce>","child_seq":1,"input_loop":"attached"}
```

- `process_started`: node-pty returned the child. `exec: "unverified"` — a PID is not execution or
  application readiness.
- `input_transport_ready`: that child exists, its output/exit subscription is attached and the
  owner inject loop is live. Sent after start, after a restart, and re-sent to each new owner
  generation for a live child.
- The daemon accepts them only from the current owner socket with the exact sid, epoch, owner
  generation, nonce and an increasing `child_seq`; out-of-order, replayed, stale or wrong-owner
  frames are ignored. Readiness clears on child exit/restart, owner disconnect and owner replacement.
- For a negotiated owner, `input_transport_ready` is the ONLY release of the bootstrap gate for
  every role. Screen `ready` frames, the cmux prompt-symbol poll, the owner-alive floor and startup
  restore do not release it. If the handshake does not arrive within the bootstrap timeout, queued
  deliveries fail with `input_transport_ready_timeout` (never a blind write).
- An owner that does not declare the capability is LEGACY: pre-1215 behavior, milestones reported
  `unknown` with `legacy_bridge_no_handshake`.
- View: `GET /api/sessions/<sid>` → `transport.readiness` (`capability`, `process_started`,
  `input_transport_ready` each `observed|not_observed|unknown`, `meaning:
  "transport_only_not_instruction_receipt"`); diagnostics `layers.spawn_readiness`; bus events
  `session_process_started` / `session_input_transport_ready`.

Milestones are session facts, not message receipts. `instruction_received` needs a message-bound
application/provider acknowledgement; none exists today, so `transport.instruction_received` and
`diagnose --inject-id` → `messaging.instruction_received` are `unknown`
(`no_message_bound_provider_acknowledgement`). PTY write, Enter and the handshake never set it. The
real Telepty prompt+nonce ACK remains the final delivery gate.

## Consumer integration API for orchestrator-boot / dispatch

This repository does not contain or change the orchestrator consumer. Installed consumer
integration is NOT claimed. What the consumer needs:

1. **Launch** through the consumer's approved boot helper, from a host shell, never inside a telepty
   session. The helper must pass `--input-policy user-supervised` **and** the correctly enrolled
   operator client configuration for the daemon's mode (combined:
   `TELEPTY_SUPERVISION_CLIENT_FILE=<config> telepty allow --id <orch-sid> --input-policy user-supervised <cli> [args...]`;
   strict: `TELEPTY_PRINCIPAL_CLIENT_FILE=<config>` with the same arguments). Package support does not
   mean an external helper already does this — verify the helper itself. Workers: no flag (or
   `--input-policy guarded`) and no operator configuration.
   Cleaning up or restarting an existing live orchestrator is the user's operation and must go
   through that approved helper. Do not bypass it with a bare restart or by deleting current
   credentials; a credentialless or unowned instance is not promoted (see *Grant lifecycle*).
2. **Confirm policy**: poll `GET /api/sessions/<orch-sid>` (host token) until
   `transport.input_policy == "user-supervised"`; treat stderr `this session runs GUARDED` or
   `guarded` as a failed launch (relaunch; do not fall back silently).
3. **Spawn readiness** (orchestrator and every worker): wait until
   `transport.readiness.input_transport_ready.status == "observed"` (or the bus event
   `session_input_transport_ready` for that sid and `owner_generation`). Do not wait on screen text,
   `transport.ready` or `bridge_queue.first_ready_observed`. `capability ==
   "legacy_bridge_no_handshake"` means an old bridge: keep the consumer's previous wait and flag it.
4. **Dispatch**: `POST /api/sessions/<sid>/inject` with the prompt. `bootstrap_queued: true` is
   accepted-and-waiting, not written. Per-message evidence:
   `telepty diagnose <sid> --inject-id <id>` → `messaging.input_written` / `submit_written`
   (`pty_master_write_only`), `instruction_received: unknown`.
5. **Receipt**: completion of a dispatched instruction is only the worker's own prompt+nonce ACK
   (real Telepty route). The consumer must keep that gate.

Compatibility transition: new daemon + old bridge = legacy behavior; old daemon + new bridge = the
bridge sends nothing (no `readiness_nonce`), and the `input_policy_capability` field is simply
absent, so a new bridge on an old daemon is guarded.

**Result semantics.** The inject response's `success` means accepted (and `bootstrap_queued` means
queued). It never means PTY-written or consumed. A force or terminal submit is reported as
"handed to the session transport; PTY write and consumption unconfirmed". A body still queued in
the bridge keeps its forced CR behind it. `pty_written` receipts (`diagnose --inject-id`) are the
PTY-write evidence. Consumption stays unknown.

## Limits

Synthetic fixtures and loopback tests show the mechanism only. They do not show native CLI frame
efficacy, the CPU and memory cost of the bridge VT, or actual Mac↔Linux model input and semantic
nonce ACK. Those are separate, measured prepublication gates.
