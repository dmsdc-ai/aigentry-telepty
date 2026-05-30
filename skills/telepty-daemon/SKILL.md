---
name: telepty-daemon
description: 'Manage the telepty daemon — start, stop, repair, update, and TUI dashboard. Use when daemon is broken or needs maintenance. 키워드: 데몬 시작, 데몬 재시작, 데몬 종료, TUI, 대시보드, 데몬 상태, daemon'
---

# telepty-daemon — Daemon Management

## daemon — Start the daemon

```bash
telepty daemon
```

Starts the telepty daemon on port 3848. The daemon manages all sessions, handles inject delivery, and serves the HTTP/WS API.

The daemon auto-starts when needed (e.g., `telepty allow` starts it automatically). Manual start is rarely needed.

## cleanup-daemons — Kill stale daemon processes

```bash
telepty cleanup-daemons
```

Natural-language: "데몬 복구해줘", "fix the broken daemon", "kill stale daemons"

Finds and kills ALL telepty daemon processes (by PID file and process scan), then clears the state file. Use this when:
- `Failed to connect to local daemon` errors
- Duplicate daemon processes running
- Version mismatch after update
- Port 3848 already in use

### Full recovery sequence

```bash
telepty cleanup-daemons
telepty daemon
```

## tui — Interactive dashboard

```bash
telepty tui
```

Natural-language: "대시보드 열어줘", "show the TUI", "open dashboard"

Opens a blessed-based TUI with session list, health status, and quick actions:
- `s` — start a new session
- `k` — kill selected session
- `p` — purge stale sessions
- `Enter` — attach to selected session

## update — Self-update telepty

```bash
telepty update
```

Runs `npm install -g @dmsdc-ai/aigentry-telepty@latest` and restarts the daemon with the new version.

## delete — Remove a session

```bash
telepty delete <session_id>
```

Forcefully removes a session from the daemon registry and kills its PTY process.

## clean — Remove ghost sessions

```bash
telepty clean
```

Finds and removes sessions with `STALE` or `DISCONNECTED` health status.

## API Health Check

```bash
curl http://127.0.0.1:3848/api/health
# → {"status":"ok","version":"0.1.96"}

curl http://127.0.0.1:3848/api/meta
# → {"name":"...","version":"...","capabilities":[...],"pid":...}
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Port 3848 already in use` | Another daemon or process on port | `telepty cleanup-daemons` |
| `Daemon version mismatch` | Old daemon after npm update | Auto-restarts; if stuck: `telepty cleanup-daemons && telepty daemon` |
| `ECONNREFUSED` | Daemon not running | `telepty daemon` |
| `Singleton lock held` | Another daemon owns the lock | `telepty cleanup-daemons` |
