# telepty

**Connect any terminal to any terminal, any machine.**

telepty is a lightweight PTY multiplexer and session bridge. It lets you spawn, attach to, and inject commands into terminal sessions — locally or across machines via Tailscale.

Built for AI CLI workflows (Claude Code, Codex, Gemini CLI), but works with any interactive terminal program.

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/dmsdc-ai/aigentry-telepty/main/install.sh | bash

# Windows (PowerShell as Admin)
iwr -useb https://raw.githubusercontent.com/dmsdc-ai/aigentry-telepty/main/install.ps1 | iex

# Or via npm
npm install -g @dmsdc-ai/aigentry-telepty
```

The installer sets up telepty as a background service (`launchd` on macOS, `systemd` on Linux, detached process on Windows).

## Quick Start

```bash
# 1. Start the daemon
telepty daemon

# 2. Wrap an existing CLI session for remote control
telepty allow --id my-session claude

# 3. List active sessions (local + Tailnet)
telepty list

# 4. Inject a prompt into a session
telepty inject my-session "explain this codebase"

# 5. Attach to a session interactively
telepty attach my-session

# 6. Broadcast to all sessions
telepty broadcast "status report"
```

## Core Commands

| Command | Description |
|---------|-------------|
| `telepty daemon` | Start the background daemon (port 3848) |
| `telepty allow --id <name> <cmd>` | Wrap a CLI for inject control |
| `telepty spawn --id <name> <cmd>` | Spawn a new background session |
| `telepty list [--json]` | List sessions across all discovered hosts |
| `telepty attach [id[@host]]` | Attach to a session (interactive picker if no ID) |
| `telepty inject <id[@host]> "text"` | Inject text into a session |
| `telepty enter <id[@host]>` | Send Enter/Return to a session |
| `telepty multicast <id1,id2> "text"` | Inject into multiple sessions |
| `telepty broadcast "text"` | Inject into ALL sessions |
| `telepty rename <old> <new>` | Rename a session |
| `telepty read-screen <id> [--lines N]` | Read session screen buffer |
| `telepty reply "text"` | Reply to the last injector |
| `telepty monitor` | Real-time event billboard |
| `telepty listen` | Stream event bus as JSON |
| `telepty tui` | Full TUI dashboard |
| `telepty layout [grid\|tall\|stack]` | Arrange kitty windows |
| `telepty update` | Update to latest version |

## Cross-Machine Sessions

telepty auto-discovers sessions across your Tailnet. All commands (`list`, `attach`, `inject`, `rename`, `multicast`, `broadcast`) work seamlessly across machines.

When the same session ID exists on multiple hosts, disambiguate with `session_id@host`:

```bash
telepty inject my-session@macbook "hello"
telepty attach worker@server-01
```

## How It Works

```
CLI (telepty) ──> HTTP/WS ──> Daemon (:3848)
                                 ├── Session WebSocket (/api/sessions/:id)
                                 ├── Event Bus WebSocket (/api/bus)
                                 └── REST API (/api/sessions/*)
```

- **`allow`** wraps a CLI process in a PTY bridge, enabling remote inject
- **`inject`** delivers text via the fastest available path: kitty terminal API, WebSocket, or UDS (Unix Domain Socket for embedded integrations)
- **`submit`** is handled separately from text injection for reliability across all AI CLIs

## Inject Delivery Paths

| Priority | Method | When |
|----------|--------|------|
| 1 | `kitty @ send-text` | Terminal supports kitty protocol |
| 2 | UDS (Unix Domain Socket) | Embedded IPC sessions (e.g. aterm) |
| 3 | WebSocket PTY write | Wrapped sessions via allow-bridge |

## AI CLI Integration

telepty works as a session bridge for AI CLIs. Use `allow` to wrap any CLI:

```bash
# Claude Code
telepty allow --id claude-main claude

# Codex
telepty allow --id codex-main codex

# Gemini CLI
telepty allow --id gemini-main gemini
```

Then inject prompts, read output, or attach from anywhere:

```bash
telepty inject claude-main "refactor the auth module"
telepty read-screen claude-main --lines 50
telepty attach claude-main
```

## Deliberation (Multi-Session Discussion)

Coordinate structured discussions across multiple AI sessions:

```bash
telepty deliberate --topic "API design for v2" --sessions claude-1,claude-2,codex-1
telepty deliberate status
telepty deliberate end <thread_id>
```

## Skill Installation

telepty ships with packaged skills for Claude Code, Codex, and Gemini CLI. Run the interactive installer:

```bash
telepty
# Choose "Install telepty skills"
```

## Testing

```bash
npm test              # 70 tests (node:test)
npm run test:watch    # Watch mode
```

## License

ISC
