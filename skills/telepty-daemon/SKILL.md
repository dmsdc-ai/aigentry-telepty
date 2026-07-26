---
name: telepty-daemon
description: 'Manage the telepty daemon — start (detached), stop, restart, repair, update, and the live monitor dashboard. Use when daemon is broken or needs maintenance. 키워드: 데몬 시작, 데몬 재시작, 데몬 종료, 백그라운드, 모니터, 대시보드, 데몬 상태, daemon'
---

# telepty-daemon — Daemon Management

## daemon — Start the daemon (foreground)

```bash
telepty daemon
```

Starts the telepty daemon on port 3848 **in the foreground** (blocks the shell). The daemon manages all sessions, handles inject delivery, and serves the HTTP/WS API. This is the form install/launchd flows use; for interactive/automation use, prefer `telepty daemon start` below.

The daemon auto-starts when needed (e.g., `telepty allow` starts it automatically). Manual start is rarely needed.

## daemon start | stop | restart — Background lifecycle

```bash
telepty daemon start      # start DETACHED in the background, return the shell immediately
telepty daemon stop       # gracefully stop the running daemon (SIGTERM → SIGKILL), free the port
telepty daemon restart    # stop, then start detached (clean cross-platform restart)
```

Cross-platform (macOS / Linux / Windows):

- **`start`** spawns the daemon detached (`stdio` ignored, unref'd) and returns control to the shell at once, printing the pid and listen URL. Use this for one-command install/automation instead of the blocking foreground `telepty daemon`.
- **`stop`** is surgical — it terminates only the daemon this CLI is configured for (the state-file pid and/or the owner of the configured port, default 3848). It does **not** sweep the whole process table (that is `cleanup-daemons`), so it never reaps an unrelated telepty daemon.
- **`restart`** = `stop` then detached `start`. Replaces the macOS-only `launchctl kickstart` and gives Windows a restart it never had.

Natural-language: "데몬 백그라운드로 시작", "데몬 종료해줘", "데몬 재시작", "start the daemon in the background", "stop/restart the daemon".

> Internal auto-restart (version-mismatch recovery) is unaffected — these are user-facing controls layered on top.

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

## monitor — Live event dashboard

```bash
telepty monitor
```

Natural-language: "대시보드 열어줘", "show the dashboard", "watch the sessions"

Streams a real-time billboard of session lifecycle and inject events. For a one-shot snapshot
instead, use `telepty list`; to attach to one of the sessions, `telepty attach` (picker if no ID).

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
