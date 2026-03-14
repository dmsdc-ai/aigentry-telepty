# Telepty Bus Event Schema Standard

Version: 1.0 (2026-03-15)
Agreed by: telepty, deliberation, devkit, brain, orchestrator

## Transport

- **HTTP**: `POST /api/bus/publish` with JSON body
- **WebSocket**: `ws://HOST:3848/api/bus` send JSON message
- Both paths trigger bus auto-router for routable events

## Envelope Structure (All Events)

```json
{
  "message_id": "string (UUID or prefixed ID)",
  "kind": "string (event type)",
  "source": "string (sender identifier)",
  "target": "string | null (target session ID, optional @host suffix)",
  "ts": "ISO 8601 timestamp"
}
```

### Canonical Field Names

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | Event type (NOT `type` — `kind` is canonical) |
| `target` | string | Target telepty session ID. May include `@host` suffix for remote |
| `source` | string | Sender identifier (format: `project:session_id`) |
| `message_id` | string | Unique message identifier |
| `ts` | string | ISO 8601 timestamp |

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
{ "type": "inject_written", "inject_id": "UUID", "sender": "daemon", "target_agent": "string", "content": "string", "from": "string|null", "reply_to": "string|null", "thread_id": "string|null", "reply_expected": "boolean", "timestamp": "ISO 8601" }
```

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
