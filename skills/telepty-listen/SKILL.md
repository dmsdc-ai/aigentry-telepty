---
name: telepty-listen
description: Monitor telepty events and read session screen output. Covers listen (event bus) and read-screen commands.
---

# telepty-listen — Event Monitoring and Screen Reading

## listen — Subscribe to event bus

```bash
telepty listen
telepty listen --json
```

Natural-language: "이벤트 보여줘", "listen to the bus", "monitor session events"

Connects to the daemon's WebSocket event bus and streams all events in real-time.

### Event types

| Event | Description |
|-------|-------------|
| `session_health` | Periodic health status for all sessions |
| `inject_written` | Message delivered to a session |
| `inject_failed` | Delivery failure with error code |
| `session_register` | New session registered |
| `session_rename` | Session ID changed |
| `session_stale` | Session disconnected beyond stale threshold |
| `session_cleanup` | Stale session auto-removed |
| `submit` | Enter keystroke sent |
| `mailbox_delivered` | Mailbox message successfully delivered |
| `mailbox_delivery_failed` | Mailbox delivery failed, will retry |

### Examples

```bash
# Human-readable event stream
telepty listen

# JSON format for scripting
telepty listen --json

# Filter specific events with jq
telepty listen --json | jq 'select(.type == "inject_written")'
```

## read-screen — Read session screen buffer

```bash
telepty read-screen <session_id> [--lines N] [--raw]
```

Natural-language: "세션 화면 읽어줘", "what's on the analyst's screen", "read screen output"

Reads the last N lines of a session's PTY output buffer (default: 50 lines).

### Options

| Flag | Description |
|------|-------------|
| `--lines N` | Number of lines to read (default: 50) |
| `--raw` | Return raw output with ANSI escape sequences |

### Examples

```bash
# Read last 50 lines (cleaned)
telepty read-screen my-claude

# Read last 100 lines
telepty read-screen my-claude --lines 100

# Raw output with escape sequences
telepty read-screen my-claude --raw

# Use in scripts
SCREEN=$(telepty read-screen my-claude --lines 10)
echo "$SCREEN" | grep "error"
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Session not found` | Session doesn't exist | Check `telepty list` |
| `(empty screen)` | No output captured yet | Wait for session to produce output |
