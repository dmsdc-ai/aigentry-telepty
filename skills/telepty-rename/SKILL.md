---
name: telepty-rename
description: Rename, delete, and clean up telepty sessions. Session lifecycle management. 키워드: 세션 이름 변경, 세션 삭제, 세션 정리, 세션 청소, rename, 라이프사이클
---

# telepty-rename — Session Lifecycle Management

## rename — Change a session's ID

```bash
telepty rename <old_id> <new_id>
```

Natural-language: "세션 이름 바꿔줘", "rename the session"

Renames a session while preserving all state, connections, and attached clients. Publishes a `session_rename` event on the bus.

### Examples

```bash
telepty rename temp-session analyst-claude
```

## delete — Remove a session

```bash
telepty delete <session_id>
```

Natural-language: "세션 삭제해줘", "kill that session", "remove the dead session"

Forcefully closes the session's PTY process, disconnects all clients, and removes it from the daemon registry.

### Examples

```bash
telepty delete stale-session
```

## clean — Remove ghost sessions

```bash
telepty clean
```

Natural-language: "고스트 세션 정리해줘", "clean up stale sessions"

Scans all sessions and removes those with `STALE` or `DISCONNECTED` health status. Safe to run periodically.

### Example output

```
  🗑  Removed ghost: old-brain-claude (STALE)
  🗑  Removed ghost: temp-test (DISCONNECTED)
✅ Cleaned 2 ghost session(s).
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Session not found` | Session doesn't exist or already removed | Check `telepty list` |
| `Session ID already active` | New name conflicts with existing session | Choose a different name |
