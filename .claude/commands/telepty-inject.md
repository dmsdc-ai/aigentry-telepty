# telepty-inject

Inject a prompt into a telepty session (spawned or wrapped).

## Instructions

Parse `$ARGUMENTS` to extract target session ID and prompt text.

### Format
```
<session_id> <prompt text>
```

### Step 1: Parse Arguments

If no arguments provided:
1. List available sessions: `telepty list`
2. Ask the user which session to target and what to inject

Extract `session_id` (first word) and `prompt` (rest of the arguments).

### Step 2: English-Only Enforcement

Check if the prompt body contains non-English text (Korean, Japanese, Chinese, etc.).

- If non-English text detected: Warn the user and auto-translate the prompt to English before proceeding.
- Exception: Technical terms (e.g., 'hangul', 'jamo', session IDs like 'aigentry-*') used alongside English are OK.
- The `--from` header and `[reply-to:]` metadata are exempt from this check.

### Step 3: Auto --ref for Long Content

Detect if the prompt is long (>500 characters OR >3 lines):

- **Long content**: Use `--ref` flag automatically. This writes the prompt to a shared file and sends a SHA reference instead of inline text. Tell the user: "Using --ref (content is X chars / Y lines)."
- **Short content**: Send inline as-is.

### Step 4: Pre-Send Confirmation

Before executing, show the user:
```
Target: <session_id>
Prompt: <first 100 chars of prompt>... (X chars total)
Flags: --ref (if applicable), --from (if set)
```

Then ask: "Send? (y/n)"

**Skip confirmation when:**
- User explicitly said "send it", "just send", "바로 보내", or similar
- The command was invoked with `--yes` or `-y` flag
- Context clearly implies immediate send (e.g., replying to an orchestrator request)

### Step 5: Execute

```bash
telepty inject [--ref] [--from <from_id>] <session_id> "<prompt>"
```

If `TELEPTY_SESSION_ID` env var is set, automatically add `--from $TELEPTY_SESSION_ID`.

### Multicast (multiple targets)
```bash
telepty multicast <id1>,<id2> "<prompt>"
```

### Broadcast (all sessions)
```bash
telepty broadcast "<prompt>"
```

## Arguments
- `$ARGUMENTS`: `<session_id> "<prompt>"` or empty for interactive mode
