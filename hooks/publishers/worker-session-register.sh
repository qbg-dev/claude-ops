#!/usr/bin/env bash
# worker-session-register.sh — Register flat worker session_id in registry.json.
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

WORKER_NAME="${BRANCH#worker/}"

# Resolve project root from worktree
_PROJ_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
# Worktree paths are like /path/ProjectName-w-worker — resolve real project root
if [[ "$_PROJ_ROOT" == *-w-* ]]; then
  _PROJ_ROOT=$(echo "$_PROJ_ROOT" | sed 's|-w-[^/]*$||')
fi
[ -z "$_PROJ_ROOT" ] && exit 0

REGISTRY="$_PROJ_ROOT/.claude/workers/registry.json"
[ -f "$REGISTRY" ] || exit 0

# Idempotent: skip if session_id already set
EXISTING=$(jq -r --arg n "$WORKER_NAME" '.[$n].session_id // ""' "$REGISTRY" 2>/dev/null)
[ -n "$EXISTING" ] && [ "$EXISTING" != "null" ] && [ "$EXISTING" != "" ] && exit 0

# Write session_id to registry.json
_LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.claude-ops/state/locks}/worker-registry"
mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
_WAIT=0
while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
  sleep 0.3; _WAIT=$((_WAIT + 1))
  [ "$_WAIT" -ge 6 ] && exit 0  # Timeout: skip write rather than proceed without lock
done

TMP=$(mktemp)
jq --arg n "$WORKER_NAME" --arg sid "$SESSION_ID" \
  '.[$n].session_id = $sid' \
  "$REGISTRY" > "$TMP" \
  && mv "$TMP" "$REGISTRY" \
  || rm -f "$TMP"

rmdir "$_LOCK_DIR" 2>/dev/null || true

exit 0
