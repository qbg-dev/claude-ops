#!/bin/bash
# tmux-harness-summary.sh — Generates harness status for tmux status bar.
#
# Called every 5s by tmux via #() in status-left.
# Shows: harness name, task progress, round, session cost.
#
# Output format examples:
#   redteam R3 10/17            (single harness, round 3, 10 of 17 tasks)
#   redteam R3 10/17 bi-opt 5/8 (multiple harnesses)
set -euo pipefail

PROJECT_ROOT="${1:-/Users/wz/Desktop/zPersonalProjects/Wechat}"
OUT="/tmp/tmux_harness_summary"

# Source harness-jq for task graph queries + canonical paths
HARNESS_LIB="${HOME}/.claude-ops/lib/harness-jq.sh"
[ -f "$HARNESS_LIB" ] && source "$HARNESS_LIB"
REGISTRY="${HARNESS_SESSION_REGISTRY:-$HOME/.claude-ops/state/session-registry.json}"

harness_count=0
details=""

for pfile in "$PROJECT_ROOT"/claude_files/*-progress.json; do
  [ -f "$pfile" ] || continue
  status=$(jq -r '.status // "unknown"' "$pfile" 2>/dev/null)
  [ "$status" != "active" ] && continue

  name=$(jq -r '.harness // empty' "$pfile" 2>/dev/null)
  [ -z "$name" ] && name=$(basename "$pfile" | sed 's/-progress\.json//')

  # Task counts
  done=$(jq '[.tasks | to_entries[] | select(.value.status == "completed")] | length' "$pfile" 2>/dev/null || echo 0)
  total=$(jq '[.tasks | to_entries[]] | length' "$pfile" 2>/dev/null || echo 0)

  # Round info (from state.current_round or session_count as fallback)
  round=$(jq -r '.state.current_round // .current_session.round_count // .session_count // 0' "$pfile" 2>/dev/null || echo 0)

  # Only show harnesses with live workers registered
  has_worker=false
  if [ -f "$REGISTRY" ]; then
    session_id=$(jq -r "to_entries[] | select(.value == \"$name\") | .key" "$REGISTRY" 2>/dev/null | head -1)
    [ -n "$session_id" ] && has_worker=true
  fi
  $has_worker || continue

  harness_count=$((harness_count + 1))

  # Format: name R{round} done/total
  if [ "$round" -gt 0 ] 2>/dev/null; then
    details="${details}${name} R${round} ${done}/${total} "
  else
    details="${details}${name} ${done}/${total} "
  fi
done

# Trim trailing space
details=$(echo -n "$details" | sed 's/ $//')

if [ "$harness_count" -eq 0 ]; then
  echo -n "" > "$OUT"
else
  echo -n "$details" > "$OUT"
fi

# Also print to stdout (for tmux #() direct invocation)
cat "$OUT"
