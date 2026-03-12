---
name: telepty
description: Use telepty primarily through LLM CLI prompts and natural-language requests, with raw telepty commands as a secondary path for execution, repair, and session management.
---

# telepty

Use this skill when the user wants help operating `telepty`, recovering a broken local daemon, or managing telepty sessions through an LLM CLI prompt.

`telepty` is primarily a prompt-driven tool inside LLM CLIs. Raw `telepty ...` commands are the execution layer, not the primary user surface.

## Default approach

- For interactive human guidance, prefer LLM CLI prompt examples first, then the `telepty` TUI, and only then raw commands.
- When explaining telepty usage to a user, always lead with a skill-style or natural-language example first.
- Only show raw CLI commands after the skill-style example, as the secondary option.
- For agent execution inside a CLI session, run the underlying `telepty` command directly.
- When the request is about a broken or duplicated local daemon, repair the daemon before doing session work.

## User-facing response order

When the user asks how to do something with telepty, respond in this order:

1. Show a plain-language or skill-style example first.
2. Then show the matching CLI command.
3. Keep maintenance commands behind the user-facing flow unless the user is clearly operating as a CLI power user.

Example:

- Skill-style example: "telepty에서 해당 세션에 붙어줘" 또는 "telepty에서 로컬 데몬 복구해줘"
- CLI follow-up: `telepty attach <session_id>` 또는 `telepty cleanup-daemons`

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

When the same session ID exists on multiple hosts, use `session_id@host`.

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
