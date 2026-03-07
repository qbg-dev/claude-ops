#!/usr/bin/env bash
# commit-msg hook for worker worktrees.
# Auto-appends git trailers to every commit message.
# Workers just write "fix(scope): description" — trailers are added automatically.
#
# Installed by launch-flat-worker.sh into each worktree's .git/hooks/commit-msg

MSG_FILE="$1"

# Get worker context from branch name and registry.json
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
WORKER_NAME="${BRANCH#worker/}"
[ -z "$WORKER_NAME" ] && exit 0

# Find main repo root (worktree parent)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -f "$PROJECT_ROOT/.git" ]; then
  MAIN_ROOT=$(grep gitdir "$PROJECT_ROOT/.git" | sed 's/gitdir: //' | sed 's|/.git/worktrees/.*||')
else
  MAIN_ROOT="$PROJECT_ROOT"
fi

REGISTRY="$MAIN_ROOT/.claude/workers/registry.json"

# Read cycle count from registry.json
CYCLE=""
if [ -f "$REGISTRY" ]; then
  CYCLE=$(jq -r --arg n "$WORKER_NAME" '.[$n].cycles_completed // ""' "$REGISTRY" 2>/dev/null || true)
fi

# Don't add trailers if they're already present (e.g., amend)
if grep -q '^Worker:' "$MSG_FILE" 2>/dev/null; then
  exit 0
fi

# Append trailers
{
  echo ""
  echo "Worker: $WORKER_NAME"
  [ -n "$CYCLE" ] && echo "Cycle: $CYCLE"
} >> "$MSG_FILE"

exit 0
