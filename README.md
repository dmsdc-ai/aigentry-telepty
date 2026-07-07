# telepty

**Connect any terminal to any terminal, any machine.**

![telepty demo — one Mac terminal injecting prompts into live AI CLI sessions on macOS (agy), Linux (codex), and Windows (claude) — all three answer in real time](docs/demo.gif)

telepty is a PTY orchestration daemon and session bridge for AI CLI workflows. It lets you spawn, attach to, and inject commands into terminal sessions — locally or across machines via Tailscale.

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

## What telepty is — and what it is not

telepty is a **PTY orchestration daemon for AI CLI workflows**.
It is **not** a terminal multiplexer and does not replace tmux.

> **tmux is better at being a terminal. telepty is better at letting
> software operate many terminals.**

tmux owns terminal *fidelity*: panes, windows, full VT emulation, scrollback,
copy-mode, capture-pane, local Unix-socket operation, zero runtime deps.
telepty owns *automation*: HTTP/WS APIs, authenticated remote access,
readiness-aware inject/submit, event streams, cross-machine session control.

## telepty vs tmux

| Area | tmux | telepty |
|---|---|---|
| Core layer | terminal multiplexer + emulator | PTY orchestration daemon |
| Primary user | a human at a keyboard | software / an orchestrator |
| Terminal fidelity | full VT/grid/scrollback/copy-mode | output stream + heuristic state |
| IPC | local Unix socket | HTTP/WS/REST daemon (:3848) |
| Input model | open-loop `send-keys` | readiness-gated inject/submit |
| Multi-session fan-out | `synchronize-panes` (1 window, 1 host) | broadcast/multicast (cross-machine) |
| Remote | via SSH | native daemon HTTP, no sshd |
| Dependencies | zero runtime deps (C) | Node daemon + deps |

## When to use which
- **Use tmux** for panes, scrollback, copy-mode, capture-pane, and local
  human terminal work — telepty does none of this and doesn't try to.
- **Use telepty** when software needs to spawn, inspect, inject into, and
  track many AI-CLI sessions over an API — across machines.

## Limitations (honest)
- No terminal emulation: no cell grid, cursor model, or copy-mode. Screen
  reads are buffered bytes + heuristic state, not a ground-truth screen.
- Requires a background daemon and a network port (:3848, auth-gated).

## Core Commands

| Command | Description |
|---------|-------------|
| `telepty daemon` | Start the background daemon (port 3848) |
| `telepty allow --id <name> <cmd>` | Wrap a CLI for inject control |
| `telepty spawn --id <name> <cmd>` | Spawn a new background session |
| `telepty list [--json]` | List sessions across all discovered hosts |
| `telepty attach [id[@host]]` | Attach to a session (interactive picker if no ID) |
| `telepty inject <id[@host]> "text"` | Inject text into a session |
| `telepty inject --submit <id> "text"` | Inject text and press Enter (render-gated, retries once on safe gate-timeout) |
| `telepty inject --submit --submit-force <id> "text"` | As above, but bypass the gate (skip Layer 1/3 detection — opt-in escape hatch) |
| `telepty inject --submit --submit-retry N <id> "text"` | Override retry count [0–3] on safe 504 (default 1) |
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

## Environment variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `TELEPTY_SUBMIT_FORCE_DEFAULT` | `1`, `true`, `yes`, `on` to enable; unset, `0`, or `off` to disable | unset | Makes `telepty inject --submit <id> "text"` behave as if `--submit-force` was passed. |

`TELEPTY_SUBMIT_FORCE_DEFAULT=1` is for orchestrators and automation that
already know their targets are real, initialized REPLs. It avoids the transient
504 `bootstrap_not_ready` path where injected text lands in the target input box
but the render-gated submit refuses to press Enter while the target session is in
a temporary working state.

This bypasses the safety gate that protects sessions still booting. Set it only
when you understand that trade-off. Use `--no-submit-force` on a specific
`telepty inject --submit` call to restore the gated behavior even when the
environment default is enabled.

## Cross-Machine Sessions

telepty auto-discovers sessions across your Tailnet. All commands (`list`, `attach`, `inject`, `rename`, `multicast`, `broadcast`) work seamlessly across machines.

### Zero-config on Tailscale (auto bind + auto trust)

On a host that is on a **Tailscale tailnet**, a fresh install is cross-machine-ready with
**no manual env**. At startup the daemon detects its tailnet interface (a `100.64.0.0/10`
address) and:

- **binds :3848 to the tailnet IP only** (plus loopback) — LAN/public interfaces stay
  closed, so the control API is reachable **only from your Tailnet**, never the flat LAN;
- **trusts tailnet peers automatically** — Tailscale's own ACLs already gate who is on the
  tailnet, so a tailnet peer needs no token or manual allowlist.

> **Trust boundary:** on a Tailscale host, telepty auto-exposes :3848 to your **entire
> tailnet** (every peer Tailscale's ACLs let onto it). If you share your tailnet with
> machines you don't fully trust, set `TELEPTY_PEER_ALLOWLIST` to restrict to specific
> peers/CIDRs, or `TELEPTY_NO_TAILNET_AUTO=1` to stay loopback-only.

**Zero-config cross-machine is Tailscale-specific.** On a non-Tailscale host (plain LAN,
other mesh VPNs) the daemon stays **loopback-only** (the safe default) — set `TELEPTY_BIND`
+ `TELEPTY_PEER_ALLOWLIST` manually to expose it. Manual `TELEPTY_BIND` / `HOST` /
`TELEPTY_PEER_ALLOWLIST` always win over auto-detect.

**Windows:** Defender Firewall blocks inbound on the tailnet interface by default. On the
auto path the daemon adds the inbound allow-rule automatically when run elevated, otherwise
it prints the exact one-time `netsh` command in the startup banner.

Addressing stays **IP-free**: use MagicDNS / hostnames with `<id>@<host>` (below) — you
never need to type a `100.x.y.z` address.

### `<id>@<host>` syntax

To target a specific host (when the same session ID exists on multiple hosts,
or when there is no Tailnet auto-discovery), append `@<host>` to the session
ID. `<host>` can be a hostname, LAN IP, or Tailnet name.

```bash
# Hostname / Tailnet name
telepty inject my-session@macbook "hello"
telepty attach worker@server-01

# LAN IP — useful when no Tailnet is configured
telepty inject orchestrator-claude@172.28.4.165 "ping"
telepty read-screen build-runner@10.0.0.42 --lines 50
```

**Requirements**:
- The remote daemon must be reachable on port **3848** from the calling host
  (LAN routing, firewall rules, or Tailscale).
- No SSH or `sshd` is required on either side — the call hits the remote
  daemon's HTTP API directly. This is the recommended path for laptop
  daemons that don't run sshd.
- The `@<host>` qualifier works for `inject`, `attach`, `read-screen`,
  `enter`, `multicast`, and `rename`.

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

## `[context-ref]` Protocol — long payloads via shared file

When a sender uses `telepty inject --ref <file> <target> "<message>"`, telepty
stores the payload in a shared file under `~/.telepty/shared/<sha256>.md` and
injects only a short pointer prompt of the form:

```
[context-ref] Read ~/.telepty/shared/<sha256>.md and use it as the source of truth for this task.
<inline message>
```

This avoids prompt rot in the receiving session (and in the orchestrator's
window when the reply is small).

### Receiver contract

The receiving AI session is expected to:
1. Detect the `[context-ref]` prefix on the first line.
2. Read the file at the absolute path.
3. Treat the file contents as the **authoritative payload** for the task — the
   inline message is supplementary (topic / hint), not the source of truth.

### Storage location

- File path: `~/.telepty/shared/<sha256>.md` (sha256 of payload body)
- Created with mode `0600`; readable only by the local user
- Persists across sessions; not garbage-collected automatically (run
  `telepty clean --shared` to prune)

### When to use `--ref`

- Payload exceeds ~1KB or contains structured content (code, logs, tables).
- You want the receiver to load the payload deterministically rather than
  paraphrase it from the inject prompt.
- You're orchestrating a multi-hop conversation where the orchestrator should
  not see the full payload in its own context window.

### Integration scope

Per-agent receiver integrations (auto-loading the file via Claude Code
`UserPromptSubmit` hooks, Codex `AGENTS.md` directives, etc.) are **out of
scope for telepty core** — they live in the agent's own configuration.
Per-CLI hook installation lives in devkit: run `aigentry scaffold
install-hooks {claude|codex|gemini}` after installing
`@dmsdc-ai/aigentry-devkit`. (Older drafts proposed a receiver-side
`telepty install` subcommand for this; that direction is rejected per ADR
2026-05-05-telepty-devkit-boundary §3.1.2 / §3.4 row 2.)

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

## Ecosystem

telepty runs **standalone** — it needs none of the other aigentry modules and installs with the single command above. It is also the transport layer of the broader **aigentry** ecosystem, whose modules are each independently published and independently useful:

| Module | Package | Version | Role | Maturity |
| --- | --- | --- | --- | --- |
| **telepty** | `@dmsdc-ai/aigentry-telepty` | 0.6.13 | Cross-terminal / cross-machine prompt transport (PTY daemon) | Shipping |
| **brain** | `@dmsdc-ai/aigentry-brain` | 0.2.8 | Persistent cross-session memory (MCP server) | Early |
| **deliberation** | `@dmsdc-ai/aigentry-deliberation` | 0.0.47 | Multi-AI structured debate + synthesis (MCP server) | Early |
| **devkit** | `@dmsdc-ai/aigentry-devkit` | 0.0.22 | Installer/scaffold for the AI dev environment | Early |
| **aterm** | `@dmsdc-ai/aterm` | 0.2.14 | Terminal launcher with native session IPC | Early |
| **orchestrator** | *(unpublished)* | — | Control tower that drives sessions via telepty | Internal |

> Licenses: all MIT except `@dmsdc-ai/aterm` (UNLICENSED).

## License

MIT
