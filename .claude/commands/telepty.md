# telepty

Help the user interact with the `telepty` daemon — check session IDs, list active sessions, inject commands, send bus events, and manage terminal windows.

## Trigger

When the user asks about their current session ID, wants to check/list active sessions, inject a prompt into a session, send a JSON event via the bus, subscribe to the bus, rename a session, or update telepty.

## Instructions

### 1. Check Current Session ID
- Run: `echo $TELEPTY_SESSION_ID`
- If empty: this shell is NOT inside a telepty session.
- If set: display it. This is the ID other agents use to target this session.

### 2. List All Sessions
- Run: `telepty list`

### 3. Send a Message to Another Agent
Choose ONE of three methods based on intent:

**Method A: Prompt Injection (Active Interruption)**
The receiving AI will IMMEDIATELY read and execute the message as a prompt.
```bash
telepty inject <target_session_id> "<prompt text>"
```
For multiple targets: `telepty multicast <id1>,<id2> "<prompt>"`

**Method B: Log Injection (Visual Notification)**
The message appears on the receiving terminal screen for the user to see, but the AI does NOT execute it as a prompt.
```bash
telepty inject <target_session_id> "echo '\x1b[33m[Message from $TELEPTY_SESSION_ID]\x1b[0m <message text>'"
```

**Method C: Background JSON Bus (Passive/Silent)**
Structured data transfer that won't disturb the receiving terminal screen.
```bash
TOKEN=$(cat ~/.telepty/config.json | grep authToken | cut -d '"' -f 4)
curl -s -X POST http://127.0.0.1:3848/api/bus/publish \
  -H "Content-Type: application/json" \
  -H "x-telepty-token: $TOKEN" \
  -d '{"type": "bg_message", "payload": "..."}'
```

### 4. Subscribe to the Event Bus
```bash
nohup telepty listen > .telepty_bus_events.log 2>&1 &
```

### 5. Open a New Ghostty Terminal Window
Physically spawn a new terminal window already attached to a telepty session:
```bash
cat << 'EOF' > /tmp/telepty-auto.command
#!/bin/bash
telepty spawn --id <ID> <CMD>
EOF
chmod +x /tmp/telepty-auto.command
open -a Ghostty /tmp/telepty-auto.command || open /tmp/telepty-auto.command
```

### 6. Terminal Title Convention
Each telepty session displays its ID in the Ghostty tab title:
- Local: `⚡ telepty :: {session_id}`
- Remote: `⚡ telepty :: {session_id} @ {host}`

### 7. Update
```bash
telepty update
```
