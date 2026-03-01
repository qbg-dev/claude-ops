#!/usr/bin/env bash
# worker-bus-emit.sh — Emit structured worker messages to the event bus.
#
# Workers call this to send status updates, deploy requests, blockers, etc.
# Messages appear on the bus as `worker.message` events and get materialized
# into per-worker outbox files by worker-outbox-sync.sh.
#
# Usage:
#   bash worker-bus-emit.sh <msg_type> <message> [--severity info|warning|urgent]
#
# msg_type: task-complete | deploy-ready | blocked | status | error | info
#
# Examples:
#   bash worker-bus-emit.sh task-complete "Fixed R01 identity spoofing"
#   bash worker-bus-emit.sh deploy-ready "Need prod deploy for --service web"
#   bash worker-bus-emit.sh blocked "Can't access StarRocks - need 黄老师"
#   bash worker-bus-emit.sh status "Cycle 2 starting, 3/6 items done"
#   bash worker-bus-emit.sh task-complete "Fixed auth bug" --severity urgent
#
# Auto-detects worker name from git branch (worker/{name} or feature/{name}).
# Resolves worktree → main repo automatically via event-bus.sh.

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────
MSG_TYPE="${1:?Usage: worker-bus-emit.sh <msg_type> <message> [--severity info|warning|urgent]}"
MESSAGE="${2:?Usage: worker-bus-emit.sh <msg_type> <message> [--severity info|warning|urgent]}"
shift 2

SEVERITY="info"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --severity) SEVERITY="${2:-info}"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Resolve worker identity ──────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
# Strip common prefixes: worker/, feature/, harness/
WORKER_NAME="$BRANCH"
for prefix in "worker/" "feature/" "harness/"; do
  WORKER_NAME="${WORKER_NAME#$prefix}"
done

COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "")

# ── Source event bus (handles worktree → main repo resolution) ───
# Try ~/.claude-ops/lib first, then ~/.boring/lib (same place via symlink)
_LIB_DIR="${CLAUDE_OPS_DIR:-${BORING_DIR:-$HOME/.boring}}/lib"
if [ -f "$_LIB_DIR/event-bus.sh" ]; then
  source "$_LIB_DIR/event-bus.sh"
elif [ -f "$HOME/.claude-ops/lib/event-bus.sh" ]; then
  source "$HOME/.claude-ops/lib/event-bus.sh"
else
  echo "ERROR: event-bus.sh not found" >&2
  exit 1
fi

# ── Build payload and publish ────────────────────────────────────
PAYLOAD=$(jq -nc \
  --arg worker "$WORKER_NAME" \
  --arg msg_type "$MSG_TYPE" \
  --arg message "$MESSAGE" \
  --arg severity "$SEVERITY" \
  --arg branch "$BRANCH" \
  --arg sha "$COMMIT_SHA" \
  '{
    worker: $worker,
    msg_type: $msg_type,
    message: $message,
    severity: $severity,
    branch: $branch,
    commit_sha: $sha
  }')

bus_publish "worker.message" "$PAYLOAD"
