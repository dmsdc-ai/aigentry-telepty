# telepty-list

List all active telepty sessions with their types and status.

## Instructions

1. Run:
```bash
cd /Users/duckyoungkim/projects/aigentry-telepty && node cli.js list
```

2. If the daemon is not running, tell the user and suggest `/project:telepty-start`.

3. Format the output as a clear table showing:
   - Session ID
   - Type (spawned / wrapped)
   - Command
   - Active clients
   - Created time

## Arguments
- `$ARGUMENTS`: ignored
