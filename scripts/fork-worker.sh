#!/usr/bin/env bash
# fork-worker.sh — Fork Claude into a new pane (child inherits parent conversation).
#
# Parent/child registration is handled by the caller (MCP spawn_child writes
# to registry.json directly). This script just execs Claude with --fork-session.
#
# Usage: fork-worker.sh <parent_pane_id> <parent_session_id> [extra-claude-flags...]
#
# Example (paste in new pane after C-x y):
#   bash ~/.claude-ops/scripts/fork-worker.sh %612 abc123def456 --dangerously-skip-permissions

set -uo pipefail

PARENT_PANE="${1:-}"
PARENT_SESSION="${2:-}"
shift 2 2>/dev/null || true

if [ -z "$PARENT_PANE" ] || [ -z "$PARENT_SESSION" ]; then
  echo "Usage: fork-worker.sh <parent_pane_id> <parent_session_id> [claude-flags...]" >&2
  exit 1
fi

echo "Forking session $PARENT_SESSION from parent pane $PARENT_PANE"

# Hand off to Claude — fork-session creates a new session ID branching from parent
exec claude --resume "$PARENT_SESSION" --fork-session "$@"
