---
name: telepty-inject
description: Send messages, commands, and keystrokes to telepty sessions. Covers inject, enter, send-key, and reply commands.
---

# telepty-inject — Send Messages to Sessions

## inject — Send text to a session

```bash
telepty inject <session_id> "<prompt text>"
```

Natural-language: "이 세션에 메시지 보내줘", "send this to the analyst session"

### Options

| Flag | Description |
|------|-------------|
| `--from <id>` | Set sender session ID (auto-set inside telepty sessions via `$TELEPTY_SESSION_ID`) |
| `--reply-to <id>` | Set reply-to address (defaults to `--from`) |
| `--submit` | Use terminal-level Enter (osascript/cmux) instead of PTY CR |
| `--ref` | Store payload in shared file, inject only a pointer prompt |
| `--ref <file>` | Store file contents + message in shared file |
| `--reply-expected` | Mark that you expect a reply from the target |

### Examples

```bash
# Basic inject
telepty inject my-claude "analyze the auth module"

# With return address (so target knows where to reply)
telepty inject analyst-claude "review this PR. 응답은 telepty inject orchestrator-claude 로 보내줘." --from orchestrator-claude

# Large payload via shared reference file
telepty inject brain-claude --ref "analyze this codebase for security issues"

# Inject file contents
telepty inject analyst-claude --ref ./report.md "summarize this report"

# Inject with terminal-level submit (for CLIs that need it)
telepty inject codex-session "fix the build" --submit
```

### Return Address Rule

If you expect a reply, ALWAYS include `--from` so the target knows where to respond:

```bash
telepty inject <target> "your message" --from $(echo $TELEPTY_SESSION_ID)
```

### Cross-host inject

When the same session ID exists on multiple hosts:

```bash
telepty inject session_id@remote-host "message"
```

## enter — Send Enter keystroke only

```bash
telepty enter <session_id>
```

Sends a bare Enter to the session. Useful when text was injected with `no_enter` and you need to submit separately.

## send-key — Send terminal-level keystroke

```bash
telepty send-key <session_id> [key]
```

Sends a terminal-level keystroke (default: Enter) via osascript or cmux backend. Bypasses PTY entirely.

## reply — Reply to the last inject sender

```bash
telepty reply "<message>"
```

Automatically targets the session that last injected into yours (uses stored `lastInjectFrom`).

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Session not found` | Target session doesn't exist | Check `telepty list` |
| `Session owner is disconnected` | allow-bridge not running | Restart the target session |
| `STALE` | Session idle too long | Restart or clean: `telepty clean` |
| `DELIVERY_REJECTED` | Target rejected the payload | Check target session logs |
