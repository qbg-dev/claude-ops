#!/usr/bin/env bash
# Phase 0.5 Stop hook — bridges REVIEW.md improver → review workers.
# Called by hook-engine.ts when the improver session stops.
# Exit 0 = allow stop (workers launched), Exit 2 = block stop.
set -euo pipefail

FLEET_DIR="${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}"

# Resolve session dir
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_DIR_FILE="${SCRIPT_DIR}/session-dir.txt"
if [ ! -f "$SESSION_DIR_FILE" ]; then
  echo "ERROR: session-dir.txt not found next to stop hook script" >&2
  exit 0
fi
SESSION_DIR="$(cat "$SESSION_DIR_FILE")"

# Phase 0.5 output is optional — original REVIEW.md is fine as fallback
# No blocking needed even if output is missing

# Launch worker bridge (async)
nohup bun "$FLEET_DIR/cli/lib/deep-review/pipeline-bridge.ts" phase05-to-workers "$SESSION_DIR" \
  >> "$SESSION_DIR/bridge-phase05.log" 2>&1 &

exit 0  # allow stop
