#!/usr/bin/env bash
# Setup for telepty-claude-inject.tape: build the tmux stage, boot the real Claude
# session in the left pane, arm the choreography, leave attach to the tape.
set -u
T="tmux -L gifdemo"
$T kill-server 2>/dev/null
telepty kill demo-claude --force >/dev/null 2>&1
sleep 1
$T new-session -d -s demo -x 250 -y 52
$T split-window -h -l '42%' -t demo:0
$T send-keys -t demo:0.1 "PS1='orchestrator\$ '; clear" Enter
$T send-keys -t demo:0.0 "cd ~/projects/aigentry-telepty && telepty allow --id demo-claude claude --permission-mode bypassPermissions" Enter
nohup bash ~/projects/aigentry-telepty/demo/live-claude-choreo.sh >/dev/null 2>&1 &
