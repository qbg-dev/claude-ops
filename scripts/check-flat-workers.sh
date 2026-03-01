#!/usr/bin/env bash
# check-flat-workers.sh — Auto-discover and report status of all flat workers.
# Generic upstream version — works with any project that has .claude/workers/{name}/.
#
# Usage: bash check-flat-workers.sh [--project <root>]
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-}"

# Parse optional args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

PROJECT_NAME="$(basename "$PROJECT_ROOT")"
PANE_REG="${HOME}/.claude-ops/state/pane-registry.json"
WORKERS_DIR="$PROJECT_ROOT/.claude/workers"

echo "=== Worker Fleet Status ($PROJECT_NAME) ==="
echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo

# Auto-discover workers from .claude/workers/
if [ ! -d "$WORKERS_DIR" ]; then
  echo "ERROR: No workers directory at $WORKERS_DIR"
  exit 1
fi

printf "%-22s %-10s %-8s %-24s %-8s %-8s\n" "Worker" "Status" "Cycles" "Last Cycle" "Found" "Fixed"
printf "%-22s %-10s %-8s %-24s %-8s %-8s\n" "------" "------" "------" "----------" "-----" "-----"

for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  state_file="$dir/state.json"

  if [ ! -f "$state_file" ]; then
    printf "%-22s %-10s\n" "$name" "NO STATE"
    continue
  fi

  status=$(jq -r '.status // "unknown"' "$state_file" 2>/dev/null || echo "error")
  cycles=$(jq -r '.cycles_completed // 0' "$state_file" 2>/dev/null || echo "?")
  last=$(jq -r '.last_cycle_at // "never"' "$state_file" 2>/dev/null || echo "?")
  found=$(jq -r '.issues_found // 0' "$state_file" 2>/dev/null || echo "?")
  fixed=$(jq -r '.issues_fixed // 0' "$state_file" 2>/dev/null || echo "?")

  printf "%-22s %-10s %-8s %-24s %-8s %-8s\n" "$name" "$status" "$cycles" "$last" "$found" "$fixed"
done

echo
echo "=== Pane Check ==="

for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  pane=""

  # Search pane-registry
  if [ -f "$PANE_REG" ]; then
    pane=$(jq -r --arg w "$name" \
      'to_entries[] | select(.value.session_name == $w) | .key' \
      "$PANE_REG" 2>/dev/null | head -1)
  fi

  # Fallback: search worktree paths in pane list
  if [ -z "${pane:-}" ]; then
    wt_name="${PROJECT_NAME}-w-${name}"
    pane=$(tmux list-panes -a -F '#{pane_id} #{pane_current_path}' 2>/dev/null \
      | grep "$wt_name" | head -1 | awk '{print $1}' || true)
  fi

  # Fallback: search by window name in session 'w'
  if [ -z "${pane:-}" ]; then
    pane=$(tmux list-windows -t w -F '#{window_name} #{pane_id}' 2>/dev/null \
      | awk -v n="$name" '$1==n{print $2}' | head -1 || true)
  fi

  if [ -n "${pane:-}" ]; then
    last_line=$(tmux capture-pane -t "$pane" -p 2>/dev/null | grep -E '✢|✶|✳|⏺|❯|Bash|Read|Edit|Write|Glob|Grep' | tail -1 | head -c 80 || echo "(empty)")
    loc=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
      | awk -v p="$pane" '$1==p{print $2}')
    echo "  $name ($pane $loc): $last_line"
  else
    echo "  $name: NO PANE (dead or not started)"
  fi
done

echo
echo "=== Stale Check (>45 min since last cycle) ==="
NOW=$(date +%s)
STALE_FOUND=0

for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  state_file="$dir/state.json"
  [ ! -f "$state_file" ] && continue

  last=$(jq -r '.last_cycle_at // ""' "$state_file" 2>/dev/null || echo "")
  [ -z "$last" ] || [ "$last" = "null" ] && continue

  # Parse ISO date to epoch (macOS date -j, Linux date -d)
  last_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last" +%s 2>/dev/null || \
               date -j -f "%Y-%m-%dT%H:%M:%S" "${last%Z}" +%s 2>/dev/null || \
               date -d "$last" +%s 2>/dev/null || echo 0)
  diff=$(( NOW - last_epoch ))
  if [ "$diff" -gt 2700 ]; then
    mins=$(( diff / 60 ))
    echo "  STALE: $name — last cycle ${mins}m ago"
    STALE_FOUND=1
  fi
done

if [ "$STALE_FOUND" -eq 0 ]; then
  echo "  All workers cycling normally (or no cycles recorded yet)"
fi

echo
echo "=== Branch Status ==="
BRANCH_FOUND=0
for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  branch="worker/$name"
  # Check branch exists first
  if git -C "$PROJECT_ROOT" rev-parse --verify "$branch" &>/dev/null; then
    commits=$(git -C "$PROJECT_ROOT" log --oneline "main..$branch" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$commits" -gt 0 ]; then
      echo "  $name: $commits unmerged commits on $branch"
      BRANCH_FOUND=1
    fi
  fi
done
if [ "$BRANCH_FOUND" -eq 0 ]; then
  echo "  No worker branches with unmerged commits"
fi
