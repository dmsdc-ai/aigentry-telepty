# telepty-inject

Inject a prompt into a telepty session (spawned or wrapped).

## Instructions

Parse `$ARGUMENTS` to extract target session ID and prompt text.

### Format
```
<session_id> <prompt text>
```

### Execute
```bash
cd /Users/duckyoungkim/projects/aigentry-telepty && node cli.js inject $ARGUMENTS
```

### If no arguments
1. List available sessions: `node cli.js list`
2. Ask the user which session to target and what to inject

### Multicast (multiple targets)
```bash
node cli.js multicast <id1>,<id2> "<prompt>"
```

### Broadcast (all sessions)
```bash
node cli.js broadcast "<prompt>"
```

## Arguments
- `$ARGUMENTS`: `<session_id> "<prompt>"` or empty for interactive mode
