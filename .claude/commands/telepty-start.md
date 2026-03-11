# telepty-start

Start the telepty daemon process.

## Instructions

1. Check if daemon is already running:
```bash
curl -s http://127.0.0.1:3848/api/sessions 2>/dev/null && echo "RUNNING" || echo "NOT RUNNING"
```

2. If not running, start it:
```bash
cd /Users/duckyoungkim/projects/aigentry-telepty && node daemon.js &
```

3. Verify it started:
```bash
sleep 1 && curl -s http://127.0.0.1:3848/api/sessions
```

4. Report status.

## Arguments
- `$ARGUMENTS`: optional port override (e.g., "3849")
