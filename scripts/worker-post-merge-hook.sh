#!/usr/bin/env bash
# post-merge hook: notify worker to rebase after their branch is merged into main
# Only fires for worker/* branch merges. Finds the worker's tmux pane and sends a message.
#
# Installed by launch-flat-worker.sh into .git/hooks/post-merge (main repo).
# Projects can override with .claude/hooks/git/post-merge.

set -euo pipefail

# Only act on merges into main
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ "$CURRENT_BRANCH" != "main" ] && exit 0

# Extract the merged branch name from the merge commit message
MERGE_MSG=$(git log -1 --format='%s' HEAD)
WORKER_BRANCH=$(echo "$MERGE_MSG" | grep -oP "worker/[a-zA-Z0-9_-]+" | head -1) || true
[ -z "$WORKER_BRANCH" ] && exit 0

WORKER_NAME="${WORKER_BRANCH#worker/}"

# Find the worker's tmux pane by window name
WORKER_PANE=$(tmux list-panes -a -F '#{window_name} #{pane_id}' 2>/dev/null | awk -v w="$WORKER_NAME" '$1 == w {print $2; exit}') || true
[ -z "$WORKER_PANE" ] && exit 0

# Resolve sender identity
OWN_PANE_ID=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' | while read pid id; do
  p=$PPID; while [ "$p" -gt 1 ]; do
    [ "$p" = "$pid" ] && echo "$id" && break 2
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
done) || true
MY_PANE=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="$OWN_PANE_ID" '$1 == id {print $2; exit}') || true
SENDER="${MY_PANE:-post-merge-hook}"

tmux send-keys -t "$WORKER_PANE" "[from $SENDER (post-merge)] Your branch $WORKER_BRANCH was merged into main. Rebase before your next commit: git checkout $WORKER_BRANCH && git rebase main"
tmux send-keys -t "$WORKER_PANE" -H 0d
