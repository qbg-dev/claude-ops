#!/usr/bin/env bash
# Phase 0 Stop hook — bridges role designer → REVIEW.md improver.
# Called by hook-engine.ts when the role designer session stops.
# Exit 0 = allow stop (bridge launched), Exit 2 = block stop (output missing).
set -euo pipefail

FLEET_DIR="${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}"

# Resolve session dir from hook environment
# The bridge script path encodes the session dir
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Session dir is written to a sidecar file next to this script
SESSION_DIR_FILE="${SCRIPT_DIR}/session-dir.txt"
if [ ! -f "$SESSION_DIR_FILE" ]; then
  echo "ERROR: session-dir.txt not found next to stop hook script" >&2
  exit 0  # allow stop — can't block without context
fi
SESSION_DIR="$(cat "$SESSION_DIR_FILE")"

# Validate Phase 0 output
if [ ! -f "$SESSION_DIR/roles.json" ]; then
  # Check if the role designer produced anything at all
  echo "Role designer did not produce roles.json — will use v1 fallback" >&2
  # Write a marker so the bridge knows to use fallback
  touch "$SESSION_DIR/roles-fallback"
fi

# Launch Phase 0.5 bridge (async — don't block the stop)
nohup bun "$FLEET_DIR/cli/lib/deep-review/pipeline-bridge.ts" phase0-to-05 "$SESSION_DIR" \
  >> "$SESSION_DIR/bridge-phase0.log" 2>&1 &

exit 0  # allow stop
