---
name: telepty
description: Overview of telepty — PTY multiplexer for AI session orchestration. Use this when user asks "what is telepty" or needs a getting-started guide.
---

# telepty — Overview

telepty is a PTY multiplexer and session orchestrator. It creates, connects, and controls multiple AI CLI sessions (Claude, Gemini, Codex) from a single terminal.

## Quick Start

```bash
# Start daemon
telepty daemon

# Create a session wrapping Claude Code
telepty allow --id my-session claude

# Send a message to the session
telepty inject my-session "analyze the auth module"

# List all sessions
telepty list

# Attach to a session interactively
telepty attach my-session

# Open TUI dashboard
telepty tui
```

## Core Concepts

- **Session**: A PTY-wrapped CLI process managed by telepty (spawned or wrapped via `allow`)
- **Daemon**: Background HTTP/WS server on port 3848 managing all sessions
- **Inject**: Send text to a session's PTY input
- **Allow-bridge**: Wraps an existing CLI for remote control via telepty

## Environment

- `TELEPTY_SESSION_ID` — set inside telepty-managed sessions; use to identify yourself
- `TELEPTY_AVAILABLE=true` — set when running inside a telepty allow session

## Default Approach

- For humans: prefer natural-language examples and TUI, then raw CLI commands
- For AI agents: use raw `telepty` commands directly for execution
- When daemon is broken: repair first with `telepty cleanup-daemons && telepty daemon`

## Related Skills

Each telepty feature has its own detailed skill:
- `telepty-inject` — send messages to sessions
- `telepty-allow` — create and manage sessions
- `telepty-list` — discover sessions and check status
- `telepty-attach` — attach interactively to a session
- `telepty-broadcast` — send to multiple sessions
- `telepty-daemon` — daemon management, repair, update
- `telepty-rename` — rename, delete, clean sessions
- `telepty-listen` — monitor events and read screen
- `telepty-session` — multi-session start and layout
