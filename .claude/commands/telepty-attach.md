# telepty-attach

Attach to an active telepty session to observe its output in real-time.

## Instructions

### Execute
```bash
cd /Users/duckyoungkim/projects/aigentry-telepty && node cli.js attach $ARGUMENTS
```

### If no arguments
1. List available sessions: `node cli.js list`
2. Ask the user which session to attach to

### Notes
- For **spawned** sessions: you can both view output and send input
- For **wrapped** sessions: input from attached clients is forwarded to the owner as inject
- Press `Ctrl+C` to detach without killing the session

## Arguments
- `$ARGUMENTS`: session ID to attach to
