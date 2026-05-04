---
name: telepty-inject
description: Send messages, commands, and keystrokes to telepty sessions. Covers inject, enter, send-key, and reply commands. 키워드: 세션에 메시지, 메시지 보내기, 전달, 주입, inject, 응답, 답장, 키 입력
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

### Cross-host inject — `<id>@<host>` syntax

To inject into a session running on a different machine, append `@<host>` to
the session ID. `<host>` can be a hostname, LAN IP, or Tailnet name.

```bash
# Hostname
telepty inject session_id@worker-01 "message"

# LAN IP (daemon must be reachable on port 3848)
telepty inject orchestrator-claude@172.28.4.165 "PING from build server"

# With return address (recommended for cross-host)
telepty inject orchestrator-claude@192.168.1.10 "task done" \
  --from "$TELEPTY_SESSION_ID"
```

**Requirements**:
- The remote daemon must be reachable on port `3848` from the calling host
  (firewall / LAN routing / Tailscale).
- No SSH or sshd is required on either side — the call hits the remote
  daemon's HTTP API directly.
- Use the same `<id>@<host>` syntax for `attach`, `read-screen`, `enter`,
  and `multicast` targets.

Use this when the same session ID exists on multiple hosts, or when the
calling host has no local daemon discovery (no Tailnet, mixed LAN, etc.).

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

## Report Convention (REPORT to orchestrator)

When a sub-session finishes a task or needs to escalate state, it reports to the
**orchestrator** session using the `REPORT:` prefix.

### Hard rule: NEVER hardcode the orchestrator session ID

Session IDs are volatile runtime identifiers — they may change across hosts,
restarts, or topology shifts. Resolve the orchestrator ID at runtime from
`telepty list --json` instead.

### Standard pattern (telepty 0.3.3+)

```bash
# 1. Resolve orchestrator session ID at runtime (filter out role-suffixed peers)
ORCH_ID=$(telepty list --json | python3 -c "import json,sys; \
  print(next(s['id'] for s in json.load(sys.stdin) \
    if 'orchestrator' in s['id'] \
    and not any(x in s['id'] for x in ('coder','reviewer','architect','runner','tester','analyst','builder'))))")

# 2. Inject the REPORT (retry-safe submit; --ref keeps payload short)
telepty inject --ref --submit --submit-retry 2 \
  --from "$TELEPTY_SESSION_ID" "$ORCH_ID" \
  "REPORT: <one-line summary> | evidence: <commit/test/etc> | next: <handoff>"
```

### Convention rules

- **Prefix**: messages MUST start with `REPORT:` so the orchestrator's event
  classifier can route them.
- **Return address**: include `--from "$TELEPTY_SESSION_ID"` so the orchestrator
  knows which sub-session reported.
- **Retry**: pass `--submit-retry 2` (telepty 0.3.3+). The retry is idempotent
  on safe gate-timeout 504s (`gated_dispatch_unconsumed`, `gate_timeout`,
  `no_prompt_symbol_seen`); hard-fail reasons (`session_dead`, `error`,
  `restarting`, `no_state`) are not retried.
- **Long payloads**: store the full body in a file and use `--ref <file>` so the
  inject prompt itself stays short.
- **Self-report (idempotent)**: a session reporting on its own behalf may use
  `--submit-force` to bypass the render gate. Do NOT use `--submit-force` for
  general inject — it can clobber in-flight user input.

### Anti-patterns (DO NOT)

- `telepty inject orchestrator-claude "..."` — hardcoded session ID; breaks the
  moment the orchestrator is renamed or runs under a different CLI (codex,
  gemini).
- Embedding `aigentry-orchestrator-claude` in spec templates, scripts, or
  docs as a literal target.
- Reporting without the `REPORT:` prefix — the orchestrator cannot distinguish
  a status report from a peer-to-peer message.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Session not found` | Target session doesn't exist | Check `telepty list` |
| `Session owner is disconnected` | allow-bridge not running | Restart the target session |
| `STALE` | Session idle too long | Restart or clean: `telepty clean` |
| `DELIVERY_REJECTED` | Target rejected the payload | Check target session logs |
