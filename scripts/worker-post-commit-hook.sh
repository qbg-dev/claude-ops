#!/usr/bin/env bash
# worker-post-commit-hook.sh — Installed as .git/hooks/post-commit in worker worktrees.
# Generic upstream version — works with any project that has .claude/workers/{name}/.
#
# After each commit, notifies the operator via:
# 1. Updates worker state.json with latest commit info
# 2. Sends a tmux notification to the operator's pane
# 3. Writes to shared commit log

# Resolve which worker this is from the branch name
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
WORKER_NAME="${BRANCH#worker/}"
COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null)
COMMIT_MSG=$(git log -1 --format='%s' 2>/dev/null)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

# Find the main repo root (worktree parent)
MAIN_ROOT="${PROJECT_ROOT}"
if [ -f "$PROJECT_ROOT/.git" ]; then
  # This is a worktree — .git is a file pointing to main repo
  MAIN_ROOT=$(grep gitdir "$PROJECT_ROOT/.git" | sed 's/gitdir: //' | sed 's|/.git/worktrees/.*||')
fi

STATE_FILE="$MAIN_ROOT/.claude/workers/$WORKER_NAME/state.json"

# Update state.json with last_commit info
if [ -f "$STATE_FILE" ]; then
  TMP=$(mktemp)
  jq --arg sha "$COMMIT_SHA" --arg msg "$COMMIT_MSG" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.last_commit_sha = $sha | .last_commit_msg = $msg | .last_commit_at = $ts' \
    "$STATE_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$STATE_FILE" || rm -f "$TMP"
fi

# Notify operator via tmux message
# Find operator's pane from pane-registry (look for the main session lead)
PANE_REG="$HOME/.claude-ops/state/pane-registry.json"
OPERATOR_PANE=""
if [ -f "$PANE_REG" ]; then
  # Operator's main agent is typically flagged as "warren", "lead", or a known pane
  OPERATOR_PANE=$(jq -r 'to_entries[] | select(.value.display == "warren" or .value.task == "lead") | .key' "$PANE_REG" 2>/dev/null | head -1)
fi
# Fallback: look for session h:1.0 pane
if [ -z "$OPERATOR_PANE" ]; then
  OPERATOR_PANE=$(tmux list-panes -t h:1 -F '#{pane_id}' 2>/dev/null | head -1)
fi
if [ -n "$OPERATOR_PANE" ]; then
  MSG="[from $WORKER_NAME] committed $COMMIT_SHA: $COMMIT_MSG"
  tmux send-keys -t "$OPERATOR_PANE" "$MSG"
  tmux send-keys -t "$OPERATOR_PANE" -H 0d
fi

# Also send desktop notification via notify helper (if available)
if command -v notify &>/dev/null; then
  notify "[$WORKER_NAME] committed: $COMMIT_SHA — $COMMIT_MSG" "Worker Commit"
fi

# Write to shared commit log that chief-of-staff or any monitor can poll
COMMIT_LOG="$MAIN_ROOT/.claude/workers/.commit-log.jsonl"
echo "{\"worker\":\"$WORKER_NAME\",\"sha\":\"$COMMIT_SHA\",\"msg\":\"$COMMIT_MSG\",\"branch\":\"$BRANCH\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> "$COMMIT_LOG" 2>/dev/null

# Emit worker.commit bus event (materialized to outbox by side-effect)
_BUS_LIB="${CLAUDE_OPS_DIR:-${BORING_DIR:-$HOME/.boring}}/lib/event-bus.sh"
if [ -f "$_BUS_LIB" ]; then
  export PROJECT_ROOT="$MAIN_ROOT"
  source "$_BUS_LIB" 2>/dev/null || true
  PAYLOAD=$(jq -nc \
    --arg worker "$WORKER_NAME" \
    --arg sha "$COMMIT_SHA" \
    --arg msg "$COMMIT_MSG" \
    --arg branch "$BRANCH" \
    '{worker: $worker, commit_sha: $sha, message: $msg, branch: $branch, msg_type: "commit", severity: "info"}' 2>/dev/null || echo "")
  if [ -n "$PAYLOAD" ]; then
    bus_publish "worker.commit" "$PAYLOAD" 2>/dev/null || true
  fi
fi

exit 0
