# telepty-live-fleet.tape — LIVE capture of a real orchestration fleet (not a mockup)
# Recorded 2026-07-26 while an aigentry orchestrator was driving 6 concurrent AI worker
# sessions (Claude Opus 5 coders/architects) through telepty on ONE local machine:
# dispatch → inject → workers push REPORTs back → orchestrator reviews & merges.
# Read-only commands; the live workers are never touched. Render: vhs demo/telepty-live-fleet.tape

Output demo/telepty-live-fleet.gif

Set Shell "bash"
Set FontSize 16
Set Width 1100
Set Height 780
Set Padding 16
Set TypingSpeed 15ms
Set PlaybackSpeed 1.0

Hide
Type "export PS1='orchestrator$ '; clear"
Enter
Show
Sleep 400ms

# beat 1 — intro
Type "# LIVE capture — a real orchestrator is driving 6 AI worker sessions on this machine RIGHT NOW"
Enter
Sleep 900ms

# beat 2 — the fleet, one daemon
Type "telepty list | grep -E 'ID:|Status:' | head -16"
Enter
Sleep 2800ms

# beat 3 — a real worker REPORT that just arrived through telepty
Type "# a worker just finished its task — its REPORT arrived via telepty inject, payload below:"
Enter
Sleep 600ms
Type "head -6 ~/.telepty/shared/2053db22*.md"
Enter
Sleep 2600ms

# beat 4 — sessions talk to each other through telepty
Type "# workers report back to the orchestrator session with ONE command:"
Enter
Sleep 500ms
Type "#   telepty inject --ref REPORT.md --from <worker> orchestrator 'REPORT: ...'"
Enter
Sleep 900ms
Type "ls -lt ~/.telepty/shared/*.md | head -4   # REPORT payloads exchanged today"
Enter
Sleep 2200ms

# beat 5 — same primitive, demonstrated end-to-end on a scratch session
Type "# the same primitive, end-to-end (scratch echo session — real workers stay untouched):"
Enter
Sleep 600ms
Type '( telepty spawn --id demo-peer bash -c "while read l; do echo \"[demo-peer got] \$l\"; done" >/dev/null 2>&1 & )'
Enter
Sleep 1500ms
Type 'telepty inject demo-peer "hello from the orchestrator session"'
Enter
Sleep 1200ms
Type "telepty read-screen demo-peer --lines 2"
Enter
Sleep 2000ms
Type "telepty kill demo-peer --force >/dev/null 2>&1; echo cleaned"
Enter
Sleep 3000ms

# beat 6 — outro
Type "# one daemon · N sessions · any CLI (claude/codex/gemini) · cross-machine too → see relay demos"
Enter
Sleep 1800ms
