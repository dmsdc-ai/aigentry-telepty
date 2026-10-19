# Agent CLI interaction core (partial)

This opt-in protocol implements action identity, durable receipts and the final-writer
boundary. **No live Codex observation adapter is enabled.** Observation returns
`available:false`, `observation_unavailable` and an empty supported-operation list.
No screen, input selection, composer readiness or task consumption is inferred from
the historical PTY ring. Existing inject/submit and manual Enter APIs retain their syntax.

## CLI and HTTP

```
telepty session interaction <sid> observe
telepty session interaction <sid> receipt <action-id>
telepty session interaction <sid> act '<JSON request>'
```

Commands use the configured daemon directly, emit JSON and exit nonzero for unavailable
observations, refusals and unknown effects. There is no SSH/discovery fallback. Actions
are bounded argv JSON, never evaluated. Unknown arguments fail. A receipt lookup is
not an action retry and does not imply success. HTTP equivalents are:

- `GET /api/sessions/:id/interaction`
- `GET /api/sessions/:id/interaction/receipts/:action`
- `POST /api/sessions/:id/interaction`

All three retain existing origin/network authentication checks and additionally require
the existing host token in `x-telepty-token`. JWT-only, query-token-only and worker
session credentials do not grant interaction authority. No new credential is issued.

Request schema version 1 includes `action_id`, `interaction_request_id`, `identity`,
`expected`, `operation`, string `value`, `authority` and integer `expires_at` (epoch
milliseconds, at most 60 seconds ahead). Optional `pending_inject_id` requires its
exact SHA256 `payload_digest`. Request size is at most 16 KiB; value size 4096 bytes.
Literal text rejects controls, including CR/LF. Multiline text is not supported yet.

`identity` distinguishes `kind:manual` with `sid` from `kind:task`, which additionally
requires `task_id`, `sandbox_attempt` and `dispatch_id`. The current daemon has no sealed
task binding provider: task actions refuse `wrong_attempt`. Epochs and PIDs never stand
in for an attempt. Manual binding requires an actually proved session credential epoch.

`expected` must carry sid, session_epoch, credential_generation, owner_generation,
input_generation, geometry_generation, prompt_revision, frame_digest, surface_id,
cols, rows and the observed question_id. Authority records carry provenance and a
reference. Only routine controller-policy operations are eligible at the provider
boundary. Claimed human decisions do not authenticate themselves; permission/trust,
authentication failures and non-routine surfaces refuse. Actual human decision
verification remains a separate integration requirement.

## Provider and writer contract

`createInteractionCore` takes local observation/binding/authorization/dispatch callbacks;
`createInteractionWriter` takes local observation/binding/encoding/write callbacks.
These are construction interfaces for production adapters and independent fixtures,
not HTTP parameters, environment switches or synthetic production observations.
The registry exports observeInteraction/encodeInteraction; both deliberately refuse
until measured live support is supplied. The known key table is not an advertised
terminal capability. Select/toggle encoding belongs to a measured adapter, not guesses
about numeric menu shortcuts.

A positive provider must supply a fresh complete current frame with `available:true`,
`current_frame:true`, provenance `measured-provider`, expiry, all fence fields,
question_id, supported_operations, option_ids and a routine-mode classification.
Changing content/selection/question must advance prompt_revision. The core validates
before dispatch; the synchronous final writer observes and validates again immediately
before encoding/writing. Owner generation, local input, viewer input, automated input,
output and resize invalidate candidates. One revision cannot be consumed twice.
Written receipts measure the PTY write call only, never selection or consumption.

Wrapped transport uses a distinct `interaction` frame and action-specific
`interaction_receipt`. It never inserts interaction answers in the ordinary inject
mailbox. Owner socket, action digest and stable ID bind the reply. A five-second
missing reply is outcome_unknown. Direct PTY, aterm and remote interaction remain
unsupported in this slice; a writer constructor alone does not claim their wiring.

## Persistence and recovery

The existing atomic tracked-injections ledger becomes schema v3; v2 migrates with empty
interaction maps and unchanged injection observations. Earlier/future/corrupt ledgers
fail closed. The private ledger holds action requests, stable SHA256 digests, monotonically
numbered receipts and retained original payloads. Public receipts omit text/authority
bodies. No public interaction bus notification is emitted in this slice.

Prepared is committed before dispatch; dispatched is committed before sending. Same ID
and exact content returns its stored receipt; changed content conflicts. Uncertain
effects never resend. Restart turns dispatched into outcome_unknown and prepared into
a zero-byte stale refusal; written remains written without fabricating a transition.
Storage failure prevents dispatch or returns unknown if a write might have happened.
The core bounds action count at 10,000 and retained payloads at 1 MiB each; reaching the
bound refuses admission rather than evicting dedup records.

An action referencing an existing, non-draining bootstrap inject retains the original
ID, UTF-8 payload/digest, submit intent, queue operation ID and FIFO index before
observation validation. This can leave a held task even when observation refuses.
The existing queue stays blocked; delayed submits and automated writes refuse while
held. Queue expiry cannot delete the ledger copy. Recovery preserves content for
review, and does not automatically reconstruct/replay a possibly written task.

**Automatic release/resume is not enabled.** A future measured ordinary empty composer,
sealed task binding and final-writer task/submit pairing are required before releasing
held content through the existing FIFO. No absence-of-modal heuristic releases it.
Current selection/transition receipts, semantic consumption, multi-question completion,
mouse, expanded keys, human decision verification, direct PTY support and actual1136
caller wiring remain open. No live/provider/installed acceptance follows from this core.

Independent942 should exercise the real constructors with its own provider and byte
journal: same/conflicting ID, stale owner/input/resize/revision, uncertain write, storage
failure, recovery and retained payload bytes. These are synthetic core results only.
Pinned syntax checks, exact-content security scan, independent runtime tests and a
measured Codex modal-to-empty-composer capture are separate gates.
