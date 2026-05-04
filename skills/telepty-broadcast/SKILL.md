---
name: telepty-broadcast
description: Send messages to multiple telepty sessions at once. Covers broadcast (all sessions) and multicast (selected targets). 키워드: 전체 공지, 모든 세션에, 일괄 전송, 브로드캐스트, 멀티캐스트, 다중 주입
---

# telepty-broadcast — Multi-Target Messaging

## broadcast — Send to ALL sessions

```bash
telepty broadcast "<message>"
telepty broadcast --ref "<message>"
```

Natural-language: "모든 세션에 보내줘", "broadcast to all sessions", "tell everyone to stop"

Sends a message to every active local session simultaneously.

### Options

| Flag | Description |
|------|-------------|
| `--from <id>` | Set sender session ID |
| `--ref` | Store payload in shared file (one file reused for all sessions) |
| `--ref <file>` | Store file contents in shared reference |

### Examples

```bash
# Broadcast a message to all sessions
telepty broadcast "context window 높아지면 /compact 실행해"

# Broadcast with shared reference (efficient for large payloads)
telepty broadcast --ref "review the updated spec at the shared path"

# Broadcast file contents
telepty broadcast --ref ./updated-spec.md "review this updated spec"
```

## multicast — Send to selected sessions

```bash
telepty multicast --targets <id1>,<id2>,... "<message>"
```

Natural-language: "이 세션들에만 보내줘", "send to analyst and brain only"

### Examples

```bash
# Send to specific sessions
telepty multicast --targets analyst-claude,brain-claude "coordinate on the auth refactor"

# With return address
telepty multicast --targets analyst-claude,brain-claude "report status" --from orchestrator-claude
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `No active sessions` | No sessions running | Start sessions first |
| `Partial failure` | Some targets unreachable | Check individual session status |
