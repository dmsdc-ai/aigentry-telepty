---
name: telepty-allow
description: Create telepty sessions by wrapping CLI processes. Covers the allow/enable/wrap command for session creation and PTY management. 키워드: 세션 생성, 세션 래핑, CLI 래핑, allow, 세션 만들기, PTY
---

# telepty-allow — Create and Manage Sessions

## allow — Wrap a CLI for remote control

```bash
telepty allow --id <session_id> <command> [args...]
```

Natural-language: "세션 만들어줘", "create a new Claude session", "wrap this CLI"

Wraps a CLI process (Claude, Gemini, Codex, or any command) so telepty can inject messages, monitor output, and manage it remotely.

### Options

| Flag | Description |
|------|-------------|
| `--id <name>` | Session identifier (required) |
| `--auto-restart` | Automatically restart if the CLI crashes (up to 3 times) |

### Examples

```bash
# Wrap Claude Code
telepty allow --id my-claude claude

# Wrap Gemini CLI
telepty allow --id my-gemini gemini

# Wrap Codex with auto-restart
telepty allow --id my-codex --auto-restart codex

# Wrap any command
telepty allow --id my-shell bash

# Non-interactive (headless) — set terminal dimensions
COLUMNS=120 LINES=40 telepty allow --id headless-session claude
```

### What happens

1. Daemon auto-starts if not running
2. Session registers with daemon via WebSocket
3. Child process spawns in a PTY (preserves isTTY, env, shell config)
4. Allow-bridge relays: daemon WS inject → child PTY write
5. Output streams back to daemon for monitoring
6. Prompt-ready detection gates inject delivery (safe idle-aware injection)

### Environment inside the session

| Variable | Value |
|----------|-------|
| `TELEPTY_SESSION_ID` | The session ID you specified |
| `TELEPTY_AVAILABLE` | `true` |

### Aliases

`telepty enable` and `telepty wrap` are aliases for `telepty allow`.

## spawn — Create a daemon-managed PTY session

```bash
telepty spawn --id <session_id> --command <cmd>
```

Creates a session managed entirely by the daemon (no allow-bridge). Useful for background processes.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to start daemon` | Port 3848 in use or permission issue | `telepty cleanup-daemons` then retry |
| `Session ID already active` | Duplicate ID | Use a different ID or delete the existing session |
| `Terminal input interrupted` | PTY EIO error | Session auto-recovers; restart if persistent |
