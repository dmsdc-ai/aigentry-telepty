---
name: telepty-list
description: Discover telepty sessions, check status and health. Covers list, session info, and status commands. 키워드: 세션 목록, 활성 세션, 세션 조회, 세션 상태, 세션 확인, 리스트
---

# telepty-list — Discover Sessions and Check Status

## list — Show all active sessions

```bash
telepty list
telepty list --json
```

Natural-language: "세션 목록 보여줘", "what sessions are running", "show active sessions"

### Output fields

| Field | Description |
|-------|-------------|
| ID | Session identifier |
| Host | `Local` or remote hostname |
| Command | The wrapped CLI command |
| Status | `CONNECTED`, `DISCONNECTED`, `STALE` |
| Terminal | `ghostty`, `kitty`, `aterm`, `daemon-pty` |
| Clients | Number of attached viewers |
| CWD | Working directory |

### Examples

```bash
# Human-readable list
telepty list

# JSON output (for scripting)
telepty list --json

# Pipe to jq for filtering
telepty list --json | jq '.[] | select(.healthStatus == "CONNECTED")'
```

## session info — Detailed session information

```bash
telepty session info <session_id>
```

Shows detailed metadata including terminal type, delivery endpoint, semantic state, and transport info.

## status — Quick health check

```bash
telepty status <session_id>
```

Returns session health status: `CONNECTED`, `DISCONNECTED`, or `STALE` with reason codes.

### Health Status Reference

| Status | Reason | Meaning |
|--------|--------|---------|
| `CONNECTED` | `OWNER_CONNECTED` | Allow-bridge active |
| `CONNECTED` | `DELIVERY_ENDPOINT_AVAILABLE` | aterm UDS socket reachable |
| `CONNECTED` | `PTY_RUNNING` | Daemon-managed PTY alive |
| `DISCONNECTED` | `OWNER_DISCONNECTED` | Allow-bridge lost connection |
| `STALE` | `OWNER_DISCONNECTED_STALE` | Disconnected > 60s |

## status-report — Publish semantic self-report

```bash
telepty status-report --phase <phase> [--task "<task>"] [--blocker "<blocker>"]
```

Publishes a semantic state report for the current session to the event bus.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `No active sessions found` | Daemon not running or no sessions | Start daemon: `telepty daemon` |
| `Failed to discover sessions` | Network/daemon issue | Check `telepty cleanup-daemons` |
