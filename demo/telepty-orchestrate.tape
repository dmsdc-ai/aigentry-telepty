# telepty-orchestrate.tape — reproducible vhs source for demo/telepty-orchestrate.gif
# Story: one telepty daemon, many sessions — spawn, then drive them all with ONE command.
# Targets are lightweight stand-in echo-REPLs (deterministic capture); the SAME flow
# wraps real CLIs (claude/codex/gemini). Render with:  vhs demo/telepty-orchestrate.tape

Output demo/telepty-orchestrate.gif

Set Shell "bash"
Set FontSize 18
Set Width 1000
Set Height 640
Set Padding 18
Set TypingSpeed 18ms
Set PlaybackSpeed 1.0

# --- hidden setup: clean prompt + define the stand-in REPL ---
Hide
Type "export PS1='demo$ '; clear"
Enter
Type `REPL='while read l; do echo "[$1] $l"; done'`
Enter
Show
Sleep 400ms

# beat 1 — intro
Type "# one daemon, many sessions — spawn, then drive them with ONE command"
Enter
Sleep 800ms

# honesty: stand-in REPLs, same flow as real CLIs
Type "# demo uses lightweight stand-in REPLs — same flow wraps claude/codex/gemini"
Enter
Sleep 700ms

# beat 2 — spawn 3 demo sessions wrapping the echo-REPL (backgrounded)
Type '( telepty spawn --id demo-a bash -c "$REPL" _ demo-a >/dev/null 2>&1 & )'
Enter
Sleep 250ms
Type '( telepty spawn --id demo-b bash -c "$REPL" _ demo-b >/dev/null 2>&1 & )'
Enter
Sleep 250ms
Type '( telepty spawn --id demo-c bash -c "$REPL" _ demo-c >/dev/null 2>&1 & )'
Enter
Sleep 1500ms

# beat 3 — list shows demo-a/b/c ready
Type "telepty list | grep -E 'demo-[abc]'"
Enter
Sleep 1500ms

# beat 4 — multicast ONE prompt to the three demo ids ONLY (never broadcast)
Type 'telepty multicast demo-a,demo-b,demo-c "ping from orchestrator"'
Enter
Sleep 1500ms

# beat 5 — read each screen: one prompt fanned out -> three replies
Type "for s in demo-a demo-b demo-c; do telepty read-screen $s --lines 2; done"
Enter
Sleep 2500ms

# beat 7 — cleanup (no demo session leaks)
Type "# cleanup"
Enter
Sleep 400ms
Type "for s in demo-a demo-b demo-c; do telepty kill $s --force; done"
Enter
Sleep 2000ms

Sleep 1200ms
