# telepty

**Description:**
Help the user interact with the `telepty` daemon, check their current session ID, list active sessions, and inject commands or JSON events into remote or local PTY sessions. All operations are performed using standard CLI commands or `curl`.

**Trigger:**
When the user asks about their current session ID, wants to check active sessions, wants to inject a prompt/command into a specific session, wants to send a JSON event via the bus, wants to subscribe/listen to the bus, or wants to update telepty.

**Instructions:**
1. **To check the current session ID:**
   - Execute `run_shell_command` with `echo $TELEPTY_SESSION_ID`.
   - If the value is empty, inform the user that the current shell is *not* running inside a telepty spawned session.
   - If it has a value, output it clearly.
2. **To list all sessions:**
   - Run `telepty list`.
3. **To send a message/command to another agent, you must choose ONE of three methods depending on the user's intent:**
   
   **Method A: Prompt Injection (Active Interruption)**
   - Use this when you want the receiving AI to IMMEDIATELY read and execute the message as a prompt.
   - Run: `telepty inject <target_session_id> "<prompt text>"`
   - (For multiple: `telepty multicast <id1>,<id2> "<prompt>"`)

   **Method B: Log Injection (Visual Notification)**
   - Use this when you want the message to appear immediately on the receiving terminal's screen for the user to see, but WITHOUT forcing the AI to execute it as a prompt.
   - Run: `telepty inject <target_session_id> "echo '\x1b[33m[📬 Message from $TELEPTY_SESSION_ID]\x1b[0m <message text>'"`

   **Method C: Background JSON Bus (Passive/Silent)**
   - Use this for structured data transfer that the other AI will read later from its log file, without disturbing its current terminal screen.
   - Run: 
     ```bash
     TOKEN=$(cat ~/.telepty/config.json | grep authToken | cut -d '"' -f 4)
     curl -s -X POST http://127.0.0.1:3848/api/bus/publish -H "Content-Type: application/json" -H "x-telepty-token: $TOKEN" -d '{"type": "bg_message", "payload": "..."}'
     ```
4. **To subscribe to the Event Bus (Listen for JSON events):**
   - Run `nohup telepty listen > .telepty_bus_events.log 2>&1 &`
5. **To physically OPEN a new Terminal Window for the user (macOS):**
   - If the user asks you to "open a new telepty terminal" or "방 파줘", you can physically spawn a new Ghostty/Terminal window on their screen that is already attached to a telepty session.
   - Run this shell command (replace `<ID>` and `<CMD>`):
     ```bash
     cat << 'EOF' > /tmp/telepty-auto.command
     #!/bin/bash
     telepty spawn --id <ID> <CMD>
     EOF
     chmod +x /tmp/telepty-auto.command
     open -a Ghostty /tmp/telepty-auto.command || open /tmp/telepty-auto.command
     ```
6. **To rename a session:**
   - Run `telepty rename <old_id> <new_id>`
   - This updates the session key, Ghostty tab title, and broadcasts a `session_rename` event on the bus.
7. **Terminal Title Convention:**
   - Each telepty session displays its ID in the Ghostty tab title.
   - Local: `⚡ telepty :: {session_id}`
   - Remote: `⚡ telepty :: {session_id} @ {host}`
8. **To update telepty:**
   - Run `telepty update`.