#!/usr/bin/env bash
# resolve-registry.sh — Find the canonical registry.json path.
# Usage: source ~/.claude-ops/lib/resolve-registry.sh
#        REGISTRY=$(resolve_registry "$PROJECT_ROOT")

resolve_registry() {
  local project_root="$1"
  local project_name
  project_name="$(basename "$project_root" | sed 's/-w-.*$//')"

  local new_path="$HOME/.claude/fleet/$project_name/registry.json"
  local old_path="$project_root/.claude/workers/registry.json"

  # Prefer new fleet-global location
  if [ -f "$new_path" ]; then
    echo "$new_path"
    return
  fi

  # Fallback to old per-worktree location (follow symlinks)
  if [ -f "$old_path" ]; then
    echo "$old_path"
    return
  fi

  # Default to new location (will be created on first write)
  echo "$new_path"
}
