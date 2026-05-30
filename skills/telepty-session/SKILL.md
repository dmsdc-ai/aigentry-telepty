---
name: telepty-session
description: 'Multi-session orchestration — start multiple sessions at once and arrange terminal layouts. Covers session start and layout commands. 키워드: 멀티 세션 시작, 다중 세션, 세션 레이아웃, 세션 일괄 시작, 멀티 시작, layout'
---

# telepty-session — Multi-Session Orchestration

## session start — Launch multiple sessions

```bash
telepty session start [--launch]
```

Natural-language: "세션 여러 개 시작해줘", "start all sessions", "launch the ecosystem"

Starts pre-configured sessions (from aigentry ecosystem or custom config). With `--launch`, opens each session in a new terminal tab/window.

### Options

| Flag | Description |
|------|-------------|
| `--launch` | Open each session in a new kitty/ghostty tab |

### Examples

```bash
# Start sessions interactively
telepty session start

# Start and launch in terminal tabs
telepty session start --launch
```

## layout — Arrange terminal windows in a grid

```bash
telepty layout [columns]
```

Natural-language: "터미널 배치해줘", "arrange the windows", "layout the sessions"

Arranges all terminal windows in a grid layout on the screen. Defaults to auto-calculated columns based on session count.

### Examples

```bash
# Auto-layout
telepty layout

# Force 3-column grid
telepty layout 3
```

## session info — Detailed session metadata

```bash
telepty session info <session_id>
```

Shows comprehensive session details including:
- Session type, command, CWD
- Terminal detection (ghostty, kitty, aterm)
- Health status and reason
- Transport block (delivery endpoint, backend)
- Semantic state (phase, current task, blocker)
- Mailbox stats (pending, dead-letter count)

## deliberate — Start multi-session deliberation

```bash
telepty deliberate "<topic>"
```

Natural-language: "토론 시작해줘", "start a deliberation"

Initiates a structured multi-session deliberation thread on the given topic.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `No sessions configured` | No aigentry session config found | Configure sessions first |
| `Terminal not supported` | Layout requires kitty or ghostty | Use a supported terminal |
