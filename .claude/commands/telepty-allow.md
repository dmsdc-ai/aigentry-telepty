# telepty-allow

Allow inject on an LLM CLI (or any command) via telepty.

## Instructions

### Usage
```bash
telepty allow [--id <session_id>] -- <command> [args...]
```

### Examples
```bash
# Claude Code with custom session ID
telepty allow --id my-claude -- claude

# Codex with auto-generated ID
telepty allow -- codex

# Gemini with custom ID
telepty allow --id gemini-main -- gemini

# Any shell command
telepty allow --id dev-shell -- bash
```

### What it does
1. Registers the session with the telepty daemon
2. Spawns the command locally via `node-pty` (preserves isTTY, raw mode, colors)
3. Connects to daemon as WebSocket owner for inject reception
4. Sets `TELEPTY_SESSION_ID` env var inside the process

### Key behaviors
- **isTTY preserved**: TUI apps (claude, codex, gemini) work normally
- **Daemon fault-tolerant**: if daemon dies, the CLI keeps running (inject unavailable until reconnect)
- **Session auto-cleanup**: when the command exits, session is deregistered

### After allowing, from another terminal:
```bash
# List sessions
telepty list

# Inject into the session
telepty inject <session_id> "your prompt here"

# Attach to watch output
telepty attach <session_id>
```

## Execute
If the user provides arguments, run the allow command for them:

```bash
cd /Users/duckyoungkim/projects/aigentry-telepty
node cli.js allow $ARGUMENTS
```

If no arguments, show the usage guide above and ask what they want to run.
