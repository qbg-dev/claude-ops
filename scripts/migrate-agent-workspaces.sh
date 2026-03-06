#!/usr/bin/env bash
# migrate-agent-workspaces.sh — Bootstrap agents/ directories from existing progress.json.
#
# Extracts identity fields from progress.json into agents/{role}/identity.json.
# Safe to run multiple times (idempotent — skips existing identity.json).
#
# Usage: bash ~/.claude-ops/scripts/migrate-agent-workspaces.sh [project_root]
set -euo pipefail

PROJECT_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_BASE="$PROJECT_ROOT/.claude/harness"

if [ ! -d "$HARNESS_BASE" ]; then
  echo "ERROR: No harness directory at $HARNESS_BASE" >&2
  exit 1
fi

migrated=0
skipped=0

for progress_file in "$HARNESS_BASE"/*/progress.json; do
  [ ! -f "$progress_file" ] && continue
  harness_dir=$(dirname "$progress_file")
  harness=$(basename "$harness_dir")

  # Determine role
  role="sidecar"
  parent=$(jq -r '.parent // empty' "$progress_file" 2>/dev/null || true)
  lifecycle=$(jq -r '.lifecycle // "bounded"' "$progress_file" 2>/dev/null || echo "bounded")
  if [ -n "$parent" ] && [ "$lifecycle" = "bounded" ]; then
    role="worker"
  fi
  [ "$harness" = "hq" ] && role="coordinator"
  [ "$harness" = "mod-coordinator" ] && role="coordinator"

  agents_dir="$harness_dir/agents/$role"

  # Skip if identity.json already exists
  if [ -f "$agents_dir/identity.json" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  mkdir -p "$agents_dir"

  # Extract identity fields from progress.json
  # Handle rotation.claude_command alias → model name mapping
  jq --arg role "$role" '{
    name: .harness,
    role: $role,
    model: (
      (.rotation.claude_command // "sonnet") |
      if . == "cdo" then "opus"
      elif . == "cds" then "sonnet"
      elif . == "cdh" then "haiku"
      elif . == "cdoc" then "opus"
      elif . == "cdsc" then "sonnet"
      elif startswith("claude") then "opus"
      else .
      end
    ),
    lifecycle: (.lifecycle // "bounded"),
    max_rounds: (.rotation.max_rounds // 20),
    parent: (.parent // null),
    created_at: (.started_at // (now | todate)),
    total_sessions: (.session_count // 0)
  }' "$progress_file" > "$agents_dir/identity.json"

  # Create memory/sessions/scratchpad
  if [ ! -f "$agents_dir/memory.md" ]; then
    echo "# Agent Memory — $harness/$role" > "$agents_dir/memory.md"
    echo "" >> "$agents_dir/memory.md"
    echo "<!-- Persistent memory across sessions. Update before stopping. -->" >> "$agents_dir/memory.md"
  fi
  touch "$agents_dir/sessions.jsonl" "$agents_dir/scratchpad.md" 2>/dev/null

  echo "  Migrated: $harness → agents/$role/"
  migrated=$((migrated + 1))
done

echo ""
echo "Migration complete: $migrated migrated, $skipped already existed."
