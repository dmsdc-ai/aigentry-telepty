# telepty-claude-inject.tape (v3) — full-frame LIVE Claude Code session, rendered via
# `telepty attach` (same technique as the relay demos). A real worker spawned by the
# aigentry orchestrator through the production dispatch path; prompts are injected by
# the orchestrator while we watch Claude's own UI receive and answer them.
# Render: vhs demo/telepty-claude-inject.tape   (choreo: demo/live-attach-choreo.sh <sid>)

Output demo/telepty-claude-inject.gif

Set Shell "bash"
Set FontSize 16
Set Width 1160
Set Height 780
Set Padding 14
Set TypingSpeed 16ms
Set PlaybackSpeed 1.0

Hide
Type "export PS1='orchestrator$ '; clear; ( bash ~/projects/aigentry-telepty/demo/live-attach-choreo.sh gifd1-gif-demo >/dev/null 2>&1 & )"
Enter
Show
Sleep 300ms

Type "# a REAL Claude Code worker, spawned by the orchestrator — attaching to its live session:"
Enter
Sleep 700ms
Type "telepty attach gifd1-gif-demo"
Enter

Sleep 76s

Hide
Ctrl+C
Sleep 1s
