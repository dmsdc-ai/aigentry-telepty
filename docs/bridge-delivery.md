# Bridge delivery contract (`bridge-stage-receipts-v1`)

Applies to `telepty allow` bridges and the daemon from Telepty 0.10.0 (task 1215, #136/#137).
This page describes what the bridge does with daemon `inject` frames it cannot write at once, and
what it reports back. Nothing here establishes that a model read, accepted or completed anything.

## Readiness (F1)

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
| Daemon | `TELEPTY_SUPERVISION_TRUST_FILE=<trust file>` | `TELEPTY_PRINCIPAL_MODE=strict` + `TELEPTY_PRINCIPAL_TRUST_FILE=<trust file>` |
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
   exists. The old capability is never accepted again. Other operators, workers, stale epochs, and
   missing or failed bearers are refused and stay guarded.
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
