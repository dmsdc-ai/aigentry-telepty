# Qualified REPL readiness (#22)

`telepty readiness <exact-id>[@host] --json` inspects one exact session on the configured or explicitly addressed daemon. `telepty wait-ready <exact-id>[@host] --timeout-ms 10000 --json` waits for its owner bridge to report a qualified composer. Neither command starts a daemon, discovers peers, matches aliases, writes input, approves a modal, changes settings, or creates missing credentials. HTTP peer credentials follow the existing target credential rules; SSH-only peers are unsupported by this HTTP interface.

The API is `GET /api/sessions/:id/handshake?timeout_ms=10000`. Omit timeout_ms or set it to zero for inspection. Waits are limited to 30,000 ms, sampled at most every 100 ms, with at most 32 outstanding waits per route. Clients may supply `session_epoch=<expected>` to refuse an already replaced instance. A wait also pins the initial record, epoch, owner socket and owner generation; a replacement returns `changed`, rather than silently waiting for a different agent. The route never applies fuzzy aliases; an absent/ambiguous prefix returns 404. Address a different host explicitly rather than relying on cross-host name selection.

`handshake` in session list/info metadata uses the same snapshot. Legacy `ready`, bootstrap-ready, and CONNECTED retain their compatibility/transport meanings. They do not qualify a composer. The handshake returns:

- `ready`: a qualified known-CLI composer observation from the current owner, with no subsequent output, input, resize, child lifecycle, owner or epoch invalidation.
- `unknown`: no current qualified evidence, including a bare legacy ready frame or evidence invalidated by later activity. Silence never upgrades this result.
- `unsupported`: spawned, external or generic-shell sessions without known-CLI composer evidence. `compatibility_ready` is exposed separately where applicable.
- `blocked`: the existing centralized modal detector sees a modal after the latest composer marker. No key is sent.
- `disconnected`, `not_found`, `changed`, or `timeout`: explicit failure/uncertainty states.

A result includes non-secret `session_epoch`, `owner_generation`, `machine_id`, observation/sample timestamps, detector/source when available, `waited_ms`, `completion_fact: null`, and `terminal: false`. It contains no screen content, credentials or prompts. `ready` means the bridge observed an input composer; it does not prove an eventual inject was written, consumed, answered, or completed. It is a snapshot: a subsequent inject must still use normal destination/admission checks.

A bridge emits readiness observations at its existing notification points. After activity invalidates an observation, this API remains unknown until another qualified owner frame arrives. It does not turn old bootstrap readiness into fresh evidence or scrape an independent caller-specific banner regex. Older bridges and generic prompts can therefore time out conservatively.

Inspection returns HTTP 200 for available metadata, including unknown/unsupported states. Missing exact sessions return 404; epoch/owner changes return 409; a wait that expires returns 408; a known non-ready blocker during a requested wait returns 422. Invalid bounds return 400 and capacity exhaustion returns 429. CLI `readiness` exits zero when inspection succeeds; `wait-ready` exits zero only for `ready: true`, otherwise nonzero. JSON mode emits a single JSON result on stdout. Default CLI wait is 10 seconds; default inspection is immediate.

# Sustained inactivity (#37 assessment)

The existing `session.idle` event remains an inactivity observation. The daemon health sweep emits it once when elapsed time since `lastActivityAt` reaches 60 seconds and rearms it after activity. That timestamp can be updated by delivery and transport events, so it is not strictly a last-output timestamp either.

The event does not classify an agent as free, finished, awaiting user approval, or hung. #37's proposed free/awaiting-input/stalled classifications remain unsupported: a composer observation is not task completion, a modal requires human-policy handling, and unchanged output cannot establish a hung process. No event was renamed or promoted to those claims in this change. Consumers may combine the inactivity timestamp with the separately qualified handshake and explicit task evidence while retaining uncertainty.
