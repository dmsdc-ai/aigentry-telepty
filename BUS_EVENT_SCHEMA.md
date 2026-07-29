# Telepty Bus Event Schema Standard

Version: 2.0 (2026-03-15)
Agreed by: telepty, deliberation, devkit, brain, orchestrator

## Transport

- **HTTP**: `POST /api/bus/publish` with JSON body
- **WebSocket**: `ws://HOST:3848/api/bus` send JSON message
- Both paths trigger bus auto-router for routable events

## Envelope Structure (All Events)

```json
{
  "version": 1,
  "message_id": "string (UUID or prefixed ID)",
  "kind": "string (event type)",
  "source": "string (sender identifier)",
  "source_host": "string (machine_id of sender, e.g. hostname or Tailscale IP)",
  "target": "string | null (target session ID, optional @host suffix)",
  "ts": "ISO 8601 timestamp"
}
```

### Canonical Field Names

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Envelope schema version (currently 1) |
| `kind` | string | Event type (NOT `type` — `kind` is canonical) |
| `target` | string | Target telepty session ID. May include `@host` suffix for remote |
| `source` | string | Sender identifier (format: `project:session_id`) |
| `source_host` | string | Machine ID of sender (hostname or TELEPTY_MACHINE_ID) |
| `message_id` | string | Unique message identifier |
| `ts` | string | ISO 8601 timestamp |

## Cross-Machine Addressing

### Session Locator
Every session is uniquely identified by a locator triple:
```json
{ "machine_id": "hostname", "session_id": "aigentry-devkit-001", "project_id": "aigentry-devkit" }
```

### Remote Target Format
`target` field supports `@host` suffix: `aigentry-devkit-001@100.100.100.5`
- Router strips suffix, resolves session on local daemon
- For cross-machine relay (P3), daemon forwards to target host

### Machine ID
- Default: `os.hostname()`
- Override: `TELEPTY_MACHINE_ID` env var
- Exposed in: `GET /api/meta` (`machine_id` field), session `locator` object, bus event `source_host`

### Global Session ID Uniqueness (P4)
- Convention: `{project}-{NNN}` (e.g. `aigentry-devkit-001`)
- Cross-machine uniqueness: guaranteed by `locator.machine_id` prefix in bus events
- Collision resolution: `resolveSessionAlias` returns local session only; remote sessions discovered via `source_host` field
- If two machines have `aigentry-devkit-001`, inject uses `target@host` to disambiguate
- Short form `aigentry-devkit-001` resolves to LOCAL session; remote requires explicit `@host`

### Peer Auth
- Localhost: always trusted
- Tailscale (100.x.y.z): trusted by default
- Custom peers: `TELEPTY_PEER_ALLOWLIST=ip1,ip2` env var
- All others: require `x-telepty-token` header

## Routable Events (Auto-Router)

### `turn_request`

Published by deliberation to request a turn from a session. Telepty daemon auto-routes to target session PTY.

```json
{
  "message_id": "turn_request-<uuid>",
  "session_id": "<deliberation_session_id>",
  "project": "<project_name>",
  "kind": "turn_request",
  "source": "deliberation:<deliberation_session_id>",
  "target": "<telepty_session_id>[@<host>]",
  "reply_to": "<deliberation_session_id>",
  "trace": ["project:<name>", "speaker:<id>", "turn:<turn_id>"],
  "payload": {
    "turn_id": "string",
    "round": "number",
    "max_rounds": "number",
    "speaker": "string (target telepty session ID)",
    "role": "string | null",
    "prompt": "string (full prompt text — inject as-is to PTY)",
    "prompt_sha1": "string (40-char SHA1)",
    "history_entries": "number",
    "transport_timeout_ms": "number",
    "semantic_timeout_ms": "number"
  },
  "ts": "ISO 8601"
}
```

**Important Notes:**
- `session_id` is the DELIBERATION session ID, NOT the target telepty session
- `target` is the telepty session ID to inject into
- `payload.prompt` is the full text to write to PTY (no further processing needed)
- `@host` suffix on target: strip before resolving, use for remote routing

**Auto-Router Behavior:**
1. Daemon receives turn_request via HTTP POST or WS
2. Extracts `target` field, strips `@host` suffix
3. Resolves session via `resolveSessionAlias()`
4. Delivers `payload.prompt` to session PTY (kitty primary, WS fallback)
5. Emits `inject_written` ack on bus

### `inject_written` (ACK)

Emitted by telepty after successful auto-route delivery.

```json
{
  "type": "inject_written",
  "inject_id": "UUID",
  "sender": "daemon",
  "target_agent": "<session_id>",
  "source_type": "bus_auto_route",
  "delivered": true,
  "timestamp": "ISO 8601"
}
```

## Session Lifecycle Events

### `session_register`
```json
{ "type": "session_register", "sender": "daemon", "session_id": "string", "command": "string", "cwd": "string", "timestamp": "ISO 8601" }
```

### `session.replaced`
```json
{ "type": "session.replaced", "sender": "daemon", "old_id": "string", "new_id": "string", "alias": "string", "timestamp": "ISO 8601" }
```

### `session_owner_replaced` (0.8.0, #815)
```json
{ "type": "session_owner_replaced", "sender": "daemon", "session_id": "string", "reason": "owner_claim_displaced_live_owner", "displaced_owner_pid": "number|null", "claimant_owner_pid": "number|null", "claim_was_credentialed": "boolean", "timestamp": "ISO 8601" }
```
A `?owner=1` claim displaced an owner whose socket was **still open**. The displaced bridge reads
close 4001 and exits its session, so **the agent assigned to this session may no longer exist.**

Emitted because this case previously produced *no event at all*: `session_reconnect` fires only
when the prior owner was already disconnected, so a live takeover left the record looking healthy
under a new socket while its assignee was gone. Silence read as continuity.

- This is **not** interchangeable with `session_reconnect`, which asserts a continuity that did
  not happen here. A consumer must not treat a replaced owner as a recovered one.
- The daemon asserts only what it observed: that a live owner was replaced. It does **not** know
  whether the displaced process then died — no process-exit observation is implied.
- `claim_was_credentialed: false` means the session held no credential to check the claim against
  (the WS auto-register path, or a record restored from a pre-#815 daemon). That is the residual
  case in which displacement remains possible at all.

### `session.idle`
```json
{ "type": "session.idle", "session_id": "string", "idleSeconds": "number", "lastActivityAt": "ISO 8601", "timestamp": "ISO 8601" }
```

### `session_health` (periodic, every 10s)
```json
{ "type": "session_health", "session_id": "string", "payload": { "alive": true, "pid": "number|null", "type": "string", "clients": "number", "idleSeconds": "number|null" }, "timestamp": "ISO 8601" }
```

## Inject Events

### `inject_written`
```json
{ "type": "inject_written", "inject_id": "UUID", "sender": "daemon", "target_agent": "string", "content_sha256": "string", "content_length": "number", "from": "string|null", "verified_sender_sid": "string|null", "verified_sender_epoch": "string|null", "verified_sender_generation": "number|null", "spoof_suspected": "boolean", "origin": "trusted-local|untrusted-remote", "reply_to": "string|null", "thread_id": "string|null", "reply_expected": "boolean", "timestamp": "ISO 8601" }
```
- **BREAKING (0.8.0, #815): `content` is gone.** The prompt is no longer rebroadcast verbatim.
  Any local process may subscribe to `/api/bus` with no token and no `Origin`, so publishing the
  full text of every dispatch there was a disclosure in its own right — and the harvest that hands
  an adversary the correlation identifiers carried inside dispatches. `content_sha256` +
  `content_length` replace it: enough to correlate a delivery and to verify integrity against a
  payload you already hold, and nothing to read if you do not. A subscriber that needs the text
  must be a party to the inject; the bus is not an authorization boundary.
- `verified_sender_epoch` / `verified_sender_generation` complete the principal
  `(canonical_sid, session_epoch, credential_generation)` — see `verified_sender_sid` below. Both
  are `null` whenever the sender is unverified, so an absent epoch never reads as
  "verified, epoch unknown".
- `from` is the **claimed** sender (`body.from`, spoofable). `verified_sender_sid` is the
  **daemon-verified** identity (mapped from the per-session token presented as
  `x-telepty-session-token`), or `null` when unverifiable (operator/human shell). `spoof_suspected`
  = `from && verified_sender_sid && from !== verified_sender_sid`. (telepty #43 P2.)

### `audit_overflow` (telepty #43)
```json
{ "type": "audit_overflow", "sender": "daemon", "dropped": "number", "queue_max": "number", "timestamp": "ISO 8601" }
```
- Emitted when the bounded inject-audit queue overflows and drops the oldest record(s). The audit
  log never silently truncates: a gap is always surfaced (spec §8 T4).

### Inject audit log — `~/.telepty/logs/injects.jsonl` (telepty #43)
Append-only, one compact JSON line **per delivery** (multicast/broadcast = one line **per target**,
sharing `inject_id`). File mode `0600`, dir `0700`. Schema v1:
```jsonc
{ "v": 1, "ts": "ISO 8601", "inject_id": "UUID", "kind": "inject|multicast|broadcast|reply",
  "source": "inject|multicast|broadcast|mailbox", "claimed_from": "string|null",
  "verified_sender_sid": "string|null", "spoof_suspected": "boolean", "to": "string",
  "to_alias": "string|null", "origin": "trusted-local|untrusted-remote", "origin_host": "string|null",
  "ref_path": "string|null", "payload_sha256": "hex", "payload_bytes": "number",
  "payload_preview": "null (hash-only default) | string (truncated, opt-in TELEPTY_AUDIT_PREVIEW=1)",
  "delivery_result": "success | failed:<CODE> | blocked:<reason>" }
```
Query via `GET /api/injects?since=&until=&to=&from=&spoof=&limit=&cursor=` (token-gated) or
`telepty injects [--tail] [--since] [--to] [--from] [--spoof] [--json]`. See
`docs/specs/2026-06-09-inject-audit-provenance.md`.

### `message_routed`
```json
{ "type": "message_routed", "message_id": "UUID", "from": "string", "to": "string", "reply_to": "string", "inject_id": "UUID", "deliberation_session_id": "string|null", "thread_id": "string|null", "timestamp": "ISO 8601" }
```

## Handoff Events

### `handoff.created` / `handoff.claimed` / `handoff.executing` / `handoff.completed`
```json
{ "type": "handoff.<status>", "handoff_id": "UUID", "source_session_id": "string|null", "deliberation_id": "string|null", "auto_execute": "boolean", "task_count": "number", "timestamp": "ISO 8601" }
```

## Thread Events

### `thread.opened`
```json
{ "type": "thread.opened", "thread_id": "UUID", "topic": "string", "orchestrator_session_id": "string|null", "participant_session_ids": ["string"], "timestamp": "ISO 8601" }
```

### `thread.closed`
```json
{ "type": "thread.closed", "thread_id": "UUID", "topic": "string", "message_count": "number", "timestamp": "ISO 8601" }
```

## Termination Signal Detection

Messages containing these strings suppress auto-reply guide footer:
- `no further reply needed`
- `thread closed` / `closed on X side`
- `ack received` / `ack-only`
- `회신 불필요` / `스레드 종료`

## Inject API Reference

### `POST /api/sessions/:id/inject`

```json
{
  "prompt": "string (REQUIRED — canonical body field)",
  "from": "string (sender session ID)",
  "reply_to": "string (defaults to from if omitted)",
  "thread_id": "string (optional)",
  "reply_expected": "boolean (optional)",
  "no_enter": "boolean (skip Enter after inject)"
}
```

**Note:** The canonical body field is `prompt`, NOT `text`, `content`, or `message`.
