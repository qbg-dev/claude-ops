#!/usr/bin/env bash
# check-flat-workers.sh — Auto-discover and report status of all flat workers.
# Generic upstream version — works with any project that has .claude/workers/{name}/.
#
# Reads from: .claude/workers/registry.json (unified registry)
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
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"
WORKERS_DIR="$PROJECT_ROOT/.claude/workers"

echo "=== Worker Fleet Status ($PROJECT_NAME) ==="
echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo

# Auto-discover workers from .claude/workers/
if [ ! -d "$WORKERS_DIR" ]; then
  echo "ERROR: No workers directory at $WORKERS_DIR"
  exit 1
fi

if [ ! -f "$REGISTRY" ]; then
  echo "WARNING: registry.json not found at $REGISTRY — run migrate-to-registry.sh first"
  echo
fi

printf "%-22s %-10s %-8s %-24s %-8s %-8s\n" "Worker" "Status" "Cycles" "Last Cycle" "Found" "Fixed"
printf "%-22s %-10s %-8s %-24s %-8s %-8s\n" "------" "------" "------" "----------" "-----" "-----"

for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  [ "$name" = "_archived" ] && continue

  # Read from registry.json
  if [ -f "$REGISTRY" ]; then
    _entry=$(jq -r --arg n "$name" '.[$n] // empty' "$REGISTRY" 2>/dev/null || echo "")
    if [ -n "$_entry" ] && [ "$_entry" != "null" ]; then
      _fields=$(echo "$_entry" | jq -r '[(.status // "unknown"), (.cycles_completed // 0 | tostring), (.last_cycle_at // "never"), (.issues_found // 0 | tostring), (.issues_fixed // 0 | tostring)] | join("\t")' 2>/dev/null || echo "")
      IFS=$'\t' read -r status cycles last found fixed <<< "$_fields"
    else
      printf "%-22s %-10s\n" "$name" "NOT IN REG"
      continue
    fi
  else
    printf "%-22s %-10s\n" "$name" "NO REGISTRY"
    continue
  fi

  printf "%-22s %-10s %-8s %-24s %-8s %-8s\n" "$name" "$status" "$cycles" "$last" "$found" "$fixed"
done

echo
echo "=== Pane Check ==="

for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  [ "$name" = "_archived" ] && continue

  pane=""

  # Read pane_id from registry.json
  if [ -f "$REGISTRY" ]; then
    pane=$(jq -r --arg n "$name" '.[$n].pane_id // empty' "$REGISTRY" 2>/dev/null || echo "")
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
    # Check if pane is alive
    alive=""
    if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${pane}$"; then
      alive="⚡"
    else
      alive="❌ dead"
    fi
    last_line=$(tmux capture-pane -t "$pane" -p 2>/dev/null | grep -E '✢|✶|✳|⏺|❯|Bash|Read|Edit|Write|Glob|Grep' | tail -1 | head -c 80 || echo "(empty)")
    loc=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
      | awk -v p="$pane" '$1==p{print $2}')
    echo "  $name ($pane $loc) $alive: $last_line"
  else
    echo "  $name: NO PANE (dead or not started)"
  fi
done

echo
echo "=== Pane Liveness (content delta) ==="

for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  [ "$name" = "_archived" ] && continue

  pane=""
  if [ -f "$REGISTRY" ]; then
    pane=$(jq -r --arg n "$name" '.[$n].pane_id // empty' "$REGISTRY" 2>/dev/null || echo "")
  fi
  [ -z "${pane:-}" ] && continue
  # Only check alive panes
  tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${pane}$" || continue

  PANE_CONTENT=$(tmux capture-pane -t "$pane" -p -S -20 2>/dev/null || echo "")
  HASH=$(echo "$PANE_CONTENT" | md5 2>/dev/null || echo "$PANE_CONTENT" | md5sum 2>/dev/null | awk '{print $1}')
  PREV_HASH_FILE="/tmp/worker-pane-${name}.hash"
  PREV_HASH=$(cat "$PREV_HASH_FILE" 2>/dev/null || echo "")
  echo "$HASH" > "$PREV_HASH_FILE"

  if [ "$HASH" = "$PREV_HASH" ] && [ -n "$PREV_HASH" ]; then
    STALE_COUNT_FILE="/tmp/worker-pane-${name}.stale"
    STALE_COUNT=$(( $(cat "$STALE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
    echo "$STALE_COUNT" > "$STALE_COUNT_FILE"
    if [ "$STALE_COUNT" -ge 5 ]; then
      echo "  STUCK? $name — pane unchanged for ${STALE_COUNT} consecutive checks"
    else
      echo "  $name — pane idle (${STALE_COUNT}/5 checks)"
    fi
  else
    echo "0" > "/tmp/worker-pane-${name}.stale" 2>/dev/null || true
    echo "  $name — pane active"
  fi
done

echo
echo "=== Stale Check (>45 min since last cycle) ==="
NOW=$(date +%s)
STALE_FOUND=0

for dir in "$WORKERS_DIR"/*/; do
  [ ! -d "$dir" ] && continue
  name=$(basename "$dir")
  [ "$name" = "_archived" ] && continue

  # Read last_cycle_at from registry
  last=""
  if [ -f "$REGISTRY" ]; then
    last=$(jq -r --arg n "$name" '.[$n].last_cycle_at // ""' "$REGISTRY" 2>/dev/null || echo "")
  fi
  if [ -z "$last" ] || [ "$last" = "null" ]; then continue; fi

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
  [ "$name" = "_archived" ] && continue
  branch="worker/$name"
  if ! git -C "$PROJECT_ROOT" rev-parse --verify "$branch" &>/dev/null; then
    continue
  fi
  # Check if branch shares history with main (post-v1.0 squash branches do)
  mb=$(git -C "$PROJECT_ROOT" merge-base main "$branch" 2>/dev/null || echo "")
  if [ -n "$mb" ]; then
    commits=$(git -C "$PROJECT_ROOT" log --oneline "main..$branch" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${commits:-0}" -gt 0 ]; then
      echo "  $name: $commits unmerged commits"
      BRANCH_FOUND=1
    fi
  else
    # Disconnected history (pre-v1.0 squash) — compare file trees
    diff_files=$(git -C "$PROJECT_ROOT" diff --name-only main "$branch" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${diff_files:-0}" -gt 0 ]; then
      echo "  $name: diverged (pre-v1.0), $diff_files files differ"
      BRANCH_FOUND=1
    fi
  fi
done
if [ "$BRANCH_FOUND" -eq 0 ]; then
  echo "  All worker branches up to date"
fi
