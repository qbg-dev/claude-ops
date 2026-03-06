#!/usr/bin/env bash
# spawn-sweep-agent.sh — Launch a sweep agent with permission-manifest enforcement.
#
# Usage (sourced): spawn_sweep_agent <sweep-name> <project-root> <seed-file>
#
# Permission manifest: $SPAWN_SWEEP_PERMISSIONS_DIR/{sweep-name}.json
#   Required fields: model, tools[], allowedTools[]
#
# NEVER falls back to bypassPermissions — if the manifest is missing, the
# agent does not launch and an error is returned.
set -uo pipefail

SPAWN_SWEEP_PERMISSIONS_DIR="${SPAWN_SWEEP_PERMISSIONS_DIR:-$HOME/.claude-ops/harness/permissions}"

spawn_sweep_agent() {
  local sweep_name="${1:?Usage: spawn_sweep_agent <sweep> <project-root> <seed-file>}"
  local project_root="${2:?Usage: spawn_sweep_agent <sweep> <project-root> <seed-file>}"
  local seed_file="${3:?Usage: spawn_sweep_agent <sweep> <project-root> <seed-file>}"

  local manifest="$SPAWN_SWEEP_PERMISSIONS_DIR/$sweep_name.json"

  if [ ! -f "$manifest" ]; then
    echo "ERROR: No permission manifest for sweep '$sweep_name' at $manifest" >&2
    echo "ERROR: Create $manifest with model, tools, and allowedTools before launching." >&2
    return 1
  fi

  local model allowed_csv
  model=$(jq -r '.model // "sonnet"' "$manifest" 2>/dev/null)
  allowed_csv=$(jq -r '.allowedTools // [] | join(",")' "$manifest" 2>/dev/null)

  local claude_args=(--model "$model" --dangerously-skip-permissions)
  [ -n "$allowed_csv" ] && claude_args+=(--allowedTools "$allowed_csv")

  cat "$seed_file" | claude "${claude_args[@]}"
}
