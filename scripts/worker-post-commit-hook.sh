#!/usr/bin/env bash
# worker-post-commit-hook.sh — Installed as .git/hooks/post-commit in worker worktrees.
# Generic upstream version — works with any project that has .claude/workers/{name}/.
#
# After each commit:
# 1. Updates registry.json with latest commit info
# 2. Messages commit_notify targets via durable inbox
# 3. Sends desktop notification to Warren
# 4. Writes to shared commit log (.commit-log.jsonl)
# 5. Emits worker.commit bus event

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

REGISTRY="$MAIN_ROOT/.claude/workers/registry.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Update registry.json with last_commit info
if [ -f "$REGISTRY" ]; then
  _LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.claude-ops/state/locks}/worker-registry"
  mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
  # Simple spinlock (max 5s)
  _WAIT=0
  while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
    sleep 0.5; _WAIT=$((_WAIT + 1))
    [ "$_WAIT" -ge 10 ] && break
  done
  TMP=$(mktemp)
  IS_FIX=0
  echo "$COMMIT_MSG" | grep -qE '^fix\(' && IS_FIX=1
  if [ "$IS_FIX" -eq 1 ]; then
    jq --arg name "$WORKER_NAME" --arg sha "$COMMIT_SHA" --arg msg "$COMMIT_MSG" --arg ts "$NOW" \
      'if .[$name] then .[$name].last_commit_sha = $sha | .[$name].last_commit_msg = $msg | .[$name].last_commit_at = $ts | .[$name].issues_fixed = ((.[$name].issues_fixed // 0) + 1) else . end' \
      "$REGISTRY" > "$TMP" 2>/dev/null && mv "$TMP" "$REGISTRY" || rm -f "$TMP"
  else
    jq --arg name "$WORKER_NAME" --arg sha "$COMMIT_SHA" --arg msg "$COMMIT_MSG" --arg ts "$NOW" \
      'if .[$name] then .[$name].last_commit_sha = $sha | .[$name].last_commit_msg = $msg | .[$name].last_commit_at = $ts else . end' \
      "$REGISTRY" > "$TMP" 2>/dev/null && mv "$TMP" "$REGISTRY" || rm -f "$TMP"
  fi
  rmdir "$_LOCK_DIR" 2>/dev/null || true
fi

# Read commit_notify targets from registry _config (default: merger)
NOTIFY_TARGETS=""
if [ -f "$REGISTRY" ]; then
  NOTIFY_TARGETS=$(jq -r '._config.commit_notify[]' "$REGISTRY" 2>/dev/null || echo "")
fi
[ -z "$NOTIFY_TARGETS" ] && NOTIFY_TARGETS="merger"

# Notify each target via durable inbox
for TARGET in $NOTIFY_TARGETS; do
  INBOX="$MAIN_ROOT/.claude/workers/$TARGET/inbox.jsonl"
  [ -d "$MAIN_ROOT/.claude/workers/$TARGET" ] && \
    echo "{\"from\":\"$WORKER_NAME\",\"ts\":\"$NOW\",\"type\":\"commit\",\"branch\":\"$BRANCH\",\"commit\":\"$COMMIT_SHA\",\"message\":\"$COMMIT_MSG\"}" >> "$INBOX" 2>/dev/null || true
done

# Also send desktop notification via notify helper (if available)
if command -v notify &>/dev/null; then
  notify "[$WORKER_NAME] committed: $COMMIT_SHA — $COMMIT_MSG" "Worker Commit"
fi

# Write to shared commit log that chief-of-staff or any monitor can poll
COMMIT_LOG="$MAIN_ROOT/.claude/workers/.commit-log.jsonl"
echo "{\"worker\":\"$WORKER_NAME\",\"sha\":\"$COMMIT_SHA\",\"msg\":\"$COMMIT_MSG\",\"branch\":\"$BRANCH\",\"ts\":\"$NOW\"}" >> "$COMMIT_LOG" 2>/dev/null

# Emit worker.commit bus event (side-effects handle inbox + tmux delivery)
_BUS_LIB="${CLAUDE_OPS_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-ops}}/lib/event-bus.sh"
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

# ── How far ahead of main? ──────────────────────────────────────────────────
# Count commits this branch has that main doesn't, and advise worker to rebase.
AHEAD=$(git rev-list --count "origin/main..HEAD" 2>/dev/null || git rev-list --count "main..HEAD" 2>/dev/null || echo "?")
if [ "$AHEAD" != "?" ] && [ "$AHEAD" -gt 0 ] 2>/dev/null; then
  RECENT=$(git log --oneline "origin/main..HEAD" 2>/dev/null || git log --oneline "main..HEAD" 2>/dev/null)
  echo ""
  echo "┌─────────────────────────────────────────────────────────┐"
  echo "│  ${AHEAD} commit(s) ahead of main on branch: ${BRANCH}"
  echo "├─────────────────────────────────────────────────────────┤"
  echo "$RECENT" | sed 's/^/│  /'
  echo "├─────────────────────────────────────────────────────────┤"
  echo "│  Ready to merge? Run:                                   │"
  echo "│    git rebase origin/main                               │"
  echo "│  Then message merger (via inbox or request-merge.sh)    │"
  echo "│  to cherry-pick your commits into main.                 │"
  echo "└─────────────────────────────────────────────────────────┘"
  echo ""
fi

exit 0
