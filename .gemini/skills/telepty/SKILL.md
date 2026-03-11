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
3. **To inject a command into another session:**
   - For a single session: Run `telepty inject <target_session_id> "<message or command>"`.
   - For broadcasting to ALL active sessions: Run `telepty broadcast "<message or command>"`.
   - For multicasting to multiple specific sessions: Run `telepty multicast <id1>,<id2> "<message or command>"`.
4. **To update telepty:**
   - Run `telepty update`.
5. **To publish a JSON event to the Event Bus (/api/bus):**
   - Use `curl` to post directly to the local daemon (it will relay to all active clients).
   - First, get the token: `TOKEN=$(cat ~/.telepty/config.json | grep authToken | cut -d '"' -f 4)`
   - Then run:
     ```bash
     curl -X POST http://127.0.0.1:3848/api/bus/publish \
       -H "Content-Type: application/json" \
       -H "x-telepty-token: $TOKEN" \
       -d '{"type": "my_event", "payload": "data"}'
     ```
   - (Modify the JSON payload structure according to the user's specific request.)
6. **To subscribe to the Event Bus (Listen for JSON events):**
   - If the user wants to wait for and listen to messages from other agents, you can spawn a background listener using `wscat`.
   - First, ensure `wscat` is installed globally: `npm install -g wscat`
   - Get the token: `TOKEN=$(cat ~/.telepty/config.json | grep authToken | cut -d '"' -f 4)`
   - Run `wscat` in a loop and append outputs to a log file, so the AI can periodically check it, or just run it in the background:
     ```bash
     nohup wscat -c "ws://127.0.0.1:3848/api/bus?token=$TOKEN" > .telepty_bus_events.log 2>&1 &
     ```
   - Inform the user that the agent is now listening, and any received JSON messages will be saved to `.telepty_bus_events.log` in the current directory. (You can read this file using `read_file` to see what messages arrived).