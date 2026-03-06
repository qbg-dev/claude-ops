#!/usr/bin/env bash
# move-to-bg.sh — Move a tmux pane to "bg" session
#
# From keybinding:  bind b run-shell "bash ~/.claude-ops/scripts/move-to-bg.sh '#{pane_id}'"
# From CLI:         bash ~/.claude-ops/scripts/move-to-bg.sh %40
#                   bash ~/.claude-ops/scripts/move-to-bg.sh h:3.2
set -euo pipefail

PANE="${1:?Usage: move-to-bg.sh <pane-id>}"
BG_CREATED=false

# Ensure bg session exists
if ! tmux has-session -t bg 2>/dev/null; then
  tmux new-session -d -s bg
  BG_CREATED=true
fi

# Break the target pane into its own window (stays in original session)
NEWWIN=$(tmux break-pane -d -s "$PANE" -P -F '#{session_name}:#{window_index}')

# Move that window to bg session
tmux move-window -s "$NEWWIN" -t bg:

# If we just created bg, kill the default empty window (window 0)
if $BG_CREATED; then
  tmux kill-window -t bg:0 2>/dev/null || true
fi

tmux display-message "Pane $PANE → bg session"
