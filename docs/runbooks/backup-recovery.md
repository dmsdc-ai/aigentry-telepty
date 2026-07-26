# Backup & Recovery Runbook — telepty (+ brain)

> Verified against `@dmsdc-ai/aigentry-telepty@0.6.2` and `@dmsdc-ai/aigentry-brain@0.2.7`
> (clean-machine smoke test, 2026-06-10: tar backup → delete → restore → daemon restart, byte-identical state).
> Applies to macOS and Linux. Windows paths differ and are not covered here yet.

## What state exists (and where)

| Directory | Owner | Contains |
|---|---|---|
| `~/.telepty` | telepty | daemon auth token, `sessions.json` (session registry), shared context refs, logs (incl. `injects.jsonl` audit) |
| `~/.aigentry` | telepty / brain | session sandboxes, dispatch helper marks, brain data (memory/mailbox), telemetry |
| `~/.config/aigentry-telepty` | telepty | daemon state file (pid/port/version claim) |

Everything is plain files — **local-first**: backing these up is a complete backup of your agent-workflow state.

## 1. Backup

### Cold backup (recommended — consistent snapshot)

```bash
# 1) stop the daemon (sessions will end; see "Limits" below)
kill "$(lsof -nP -iTCP:3848 -sTCP:LISTEN -t 2>/dev/null)" 2>/dev/null || true
# macOS, if installed as a service:
launchctl unload ~/Library/LaunchAgents/com.aigentry.telepty.plist 2>/dev/null || true

# 2) snapshot all three state dirs
tar -czf aigentry-backup-$(date +%Y%m%d-%H%M).tgz \
  -C "$HOME" .telepty .aigentry .config/aigentry-telepty
```

### Warm backup (daemon running)

The same `tar` while the daemon is running generally works (state is small, mostly append-only),
but an in-flight write can land mid-snapshot. Use warm backups for routine scheduled copies,
and a cold backup before migrations/uninstalls/risky upgrades.

Keep at least the **au