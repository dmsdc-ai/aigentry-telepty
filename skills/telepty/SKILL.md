---
name: telepty
description: Use telepty to inspect sessions, attach or inject into rooms, repair local daemon issues, and guide users through the TUI-first workflow when telepty is installed.
---

# telepty

Use this skill when the user wants help operating `telepty`, recovering a broken local daemon, or managing telepty sessions in natural language.

## Default approach

- For interactive human guidance, prefer the `telepty` TUI and point the user to the relevant menu action.
- For agent execution inside a CLI session, run the underlying `telepty` command directly.
- When the request is about a broken or duplicated local daemon, repair the daemon before doing session work.

## Common actions

1. Check whether the current shell is already inside a telepty session:

```bash
echo "$TELEPTY_SESSION_ID"
```

2. Inspect active sessions:

```bash
telepty list
```

3. Attach to a room:

```bash
telepty attach <session_id>
```

4. Inject a command or prompt:

```bash
telepty inject <session_id> "<prompt text>"
```

5. Allow inject on a local CLI:

```bash
telepty allow --id <session_id> <command> [args...]
```

6. Rename a room:

```bash
telepty rename <old_id> <new_id>
```

7. Listen to the event bus:

```bash
telepty listen
```

8. Update telepty:

```bash
telepty update
```

## Local daemon recovery

When the user reports any of these symptoms, repair the local daemon first:

- `Failed to connect to local daemon`
- local sessions do not appear but remote sessions do
- duplicate or stale daemon processes
- install/update completed but `spawn` or `allow` still fails locally

### Human-facing path

Tell the user to run `telepty` and choose `Repair local daemon`.

### Agent execution path

Use the maintenance command directly:

```bash
telepty cleanup-daemons
telepty daemon
```

If the daemon still does not come up, rerun the installer.

## Notes

- `TELEPTY_SESSION_ID` is only set inside telepty-managed sessions.
- For non-interactive `telepty allow` use cases, set terminal dimensions if the environment does not provide them:

```bash
COLUMNS=120 LINES=40 telepty allow --id <session_id> <command>
```

- For interactive users, keep explanations centered on TUI actions instead of raw maintenance commands whenever possible.
