#!/usr/bin/env bash
# Choreography for telepty-claude-inject.tape — drives the tmux panes while vhs records.
# Left pane (0): a REAL Claude Code session wrapped by `telepty allow`.
# Right pane (1): the "orchestrator" shell typing telepty inject commands.
set -u
T="tmux -L gifdemo"

type_cmd() { # human-ish typing into the right pane, then Enter
  local s="$1" i
  for ((i = 0; i < ${#s}; i++)); do
    $T send-keys -t 1 -l "${s:$i:1}"
    sleep 0.022
  done
  sleep 0.4
  $T send-keys -t 1 Enter
}

sleep 7
$T send-keys -t 0 Enter   # dismiss trust/tips dialog if present (no-op otherwise)
sleep 7

type_cmd "telepty inject --submit demo-claude 'Hello from the orchestrator session. Confirm you received this injection, and tell me in one sentence which repo you are sitting in.'"
sleep 26

type_cmd "telepty inject --submit demo-claude 'Now in one sentence: why would an orchestrator want a fleet of AI sessions it can inject like this?'"
sleep 27
