#!/usr/bin/env bash
# Choreography v2 for telepty-claude-inject.tape — injects prompts into the demo worker
# while vhs records a full-frame `telepty attach` of its REAL Claude TUI.
set -u
SID="${1:?sid}"
sleep 9
telepty inject --submit "$SID" "Orchestrator here 👋 — this prompt just landed in your composer via 'telepty inject', on camera. In one sentence, tell the viewers what they are watching." >/dev/null 2>&1
sleep 30
telepty inject --submit "$SID" "Last one: you are one of several worker sessions I am driving in parallel right now. Why does that beat one giant session? Two sentences, make it land." >/dev/null 2>&1
sleep 33
