---
name: telepty-attach
description: Attach interactively to a telepty session to view output and send input in real-time. 키워드: 세션 접속, 세션 연결, 세션 들어가기, 어태치, attach, 실시간 보기
---

# telepty-attach — Interactive Session Attachment

## attach — Connect to a session

```bash
telepty attach <session_id>
```

Natural-language: "세션에 붙어줘", "attach to my claude session", "show me what's happening in that session"

Opens an interactive terminal connection to a running session. You see its output in real-time and can type input directly.

### Behavior

- Multiple viewers can attach to the same session simultaneously
- The session owner (allow-bridge) receives your input as inject
- Output is relayed from the session to all attached clients
- Press `Ctrl+C` to detach (session continues running)

### Examples

```bash
# Attach to a local session
telepty attach my-claude

# Attach to a remote session
telepty attach analyst-claude@remote-host

# Interactive selection (from TUI)
telepty tui
# Then select a session and press Enter
```

### Cross-host attach

When the session is on a remote host:

```bash
telepty attach session_id@user@hostname
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Session not found` | Session ID doesn't exist | Check `telepty list` |
| `Connection closed` | Session ended or daemon restarted | Re-attach after daemon recovers |
