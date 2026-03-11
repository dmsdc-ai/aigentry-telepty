# telepty

Use `telepty` to inspect active sessions, check the current telepty session ID, attach to sessions, inject commands, listen to the event bus, rename sessions, and update the daemon.

## When To Use

Use this skill when the user asks to:
- Check whether the current shell is running inside a telepty session
- List or inspect telepty sessions
- Attach to a telepty session
- Inject a prompt or command into another telepty session
- Listen to telepty bus events or publish a JSON payload
- Rename a session
- Update telepty

## Commands

1. Check the current telepty session:

```bash
echo "$TELEPTY_SESSION_ID"
```

2. List sessions:

```bash
telepty list
```

3. Attach to a session:

```bash
telepty attach <session_id>
```

4. Inject a prompt or command:

```bash
telepty inject <session_id> "<prompt text>"
```

5. Inject into multiple sessions:

```bash
telepty multicast <id1,id2,...> "<prompt text>"
```

6. Broadcast to all sessions:

```bash
telepty broadcast "<prompt text>"
```

7. Rename a session:

```bash
telepty rename <old_id> <new_id>
```

8. Listen to the event bus:

```bash
telepty listen
```

9. Publish a JSON payload to the bus:

```bash
TOKEN=$(grep authToken ~/.telepty/config.json | cut -d '"' -f 4)
curl -s -X POST http://127.0.0.1:3848/api/bus/publish \
  -H "Content-Type: application/json" \
  -H "x-telepty-token: $TOKEN" \
  -d '{"type":"bg_message","payload":"..."}'
```

10. Update telepty:

```bash
telepty update
```

## Notes

- `TELEPTY_SESSION_ID` is only set inside telepty-managed sessions.
- Use `telepty inject` when the target session should receive the command immediately.
- Use the JSON bus when the payload should be delivered without interrupting the target shell.
