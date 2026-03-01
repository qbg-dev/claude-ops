#!/usr/bin/env bash
# worker-session-register.sh — Register flat worker session_id in pane-registry.
#
# Runs as a UserPromptSubmit hook. Fires on every prompt but is fast and idempotent:
# does nothing if not in a flat-worker worktree, or if session_id already registered.
#
# This solves the chicken-and-egg problem: session_id isn't known at launch time,
# so launch-flat-worker.sh can't register it. We register it on first prompt instead.
set -uo pipefail
trap 'exit 0' ERR

# Fast-path: only run in worktrees with worker/* branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[[ "$BRANCH" == worker/* ]] || exit 0

GIT_FILE=$(git rev-parse --git-dir 2>/dev/null || echo "")
[ -f "$GIT_FILE" ] || exit 0  # flat workers are worktrees — .git is a FILE, not a dir

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

PANE_REG="${HARNESS_STATE_DIR:-$HOME/.boring/state}/pane-registry.json"
[ -f "$PANE_REG" ] || exit 0

WORKER_NAME="${BRANCH#worker/}"
CANONICAL="worker/$WORKER_NAME"

# Find pane_id for this worker by canonical name
PANE_ID=$(jq -r --arg c "$CANONICAL" \
  'to_entries[] | select(.value.harness == $c) | .key' \
  "$PANE_REG" 2>/dev/null | head -1)
[ -z "$PANE_ID" ] && exit 0

# Idempotent: skip if session_id already set
EXISTING=$(jq -r --arg p "$PANE_ID" '.[$p].session_id // empty' "$PANE_REG" 2>/dev/null)
[ -n "$EXISTING" ] && exit 0

# Write session_id into registry entry
TMP=$(mktemp)
jq --arg p "$PANE_ID" --arg sid "$SESSION_ID" \
  '.[$p].session_id = $sid' "$PANE_REG" > "$TMP" \
  && mv "$TMP" "$PANE_REG" \
  || rm -f "$TMP"

exit 0
