#!/usr/bin/env bash
# harness-jq.sh — Shared shell functions for reading the unified task graph.
#
# Source this file in any harness script:
#   source "$(dirname "$0")/harness-jq.sh"
#
# All functions take a progress JSON file path as their first argument.

# ═══════════════════════════════════════════════════════════════
# CANONICAL PATHS — single source of truth
# ═══════════════════════════════════════════════════════════════
export HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
export HARNESS_SESSION_REGISTRY="${HARNESS_SESSION_REGISTRY:-$HARNESS_STATE_DIR/session-registry.json}"
export HARNESS_LOCK_DIR="${HARNESS_LOCK_DIR:-$HARNESS_STATE_DIR/locks}"
mkdir -p "$HARNESS_LOCK_DIR" 2>/dev/null || true

# ── Portable file mtime (macOS + Linux) ──
_file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

# ── Portable file locking via atomic mkdir (macOS + Linux) ──
_lock() {
  local lockdir="$1" attempts=0 sleep_time=0.05
  while ! mkdir "$lockdir" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 600 ]; then
      # Stale lock (>30s with backoff) — force break
      echo "WARN: Force-breaking stale lock after 600 attempts: $lockdir" >&2
      rm -rf "$lockdir" 2>/dev/null
      mkdir "$lockdir" 2>/dev/null || true
      break
    fi
    # Exponential backoff: 50ms → 100ms → 200ms (capped)
    if [ "$attempts" -eq 50 ]; then sleep_time=0.1; fi
    if [ "$attempts" -eq 150 ]; then sleep_time=0.2; fi
    sleep "$sleep_time"
  done
}
_unlock() { rmdir "$1" 2>/dev/null || true; }

# Atomically read-modify-write a JSON file under lock.
# Usage: locked_jq_write <file> <lockname> <jq_filter> [--arg name val ...]
locked_jq_write() {
  local file="$1" lockname="$2" filter="$3"
  shift 3
  local lockdir="$HARNESS_LOCK_DIR/$lockname"
  _lock "$lockdir"
  # Create file with empty object if missing
  [ ! -f "$file" ] && echo '{}' > "$file"
  local tmp
  tmp=$(mktemp) || { _unlock "$lockdir"; return 1; }
  if jq "$@" "$filter" "$file" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    # Validate output is valid JSON before overwriting
    if jq empty "$tmp" 2>/dev/null; then
      mv "$tmp" "$file"
    else
      echo "WARN: locked_jq_write produced invalid JSON for $file, skipping" >&2
      rm -f "$tmp"
    fi
  else
    rm -f "$tmp"
  fi
  _unlock "$lockdir"
}

# Current task: first in_progress, else first unblocked pending
harness_current_task() {
  local PROGRESS="$1"
  jq -r '
    . as $root |
    ([.tasks | to_entries[] | select(.value.status == "in_progress") | .key] | first) //
    ([.tasks | to_entries[] | select(
      .value.status == "pending" and
      ((.value.blockedBy // []) as $deps |
       if ($deps | length) == 0 then true
       else [$deps[] as $dep | ($root.tasks[$dep].status // "missing")] | all(. == "completed")
       end)
    ) | .key] | first) //
    "ALL_DONE"
  ' "$PROGRESS"
}

# Next unblocked pending task (skipping any in_progress)
harness_next_task() {
  local PROGRESS="$1"
  jq -r '
    . as $root |
    [.tasks | to_entries[] | select(
      .value.status == "pending" and
      ((.value.blockedBy // []) as $deps |
       if ($deps | length) == 0 then true
       else [$deps[] as $dep | $root.tasks[$dep].status] | all(. == "completed")
       end)
    ) | .key] | first // "ALL_DONE"
  ' "$PROGRESS"
}

# Count of completed tasks
harness_done_count() {
  local PROGRESS="$1"
  jq '[.tasks // {} | to_entries[] | select(.value.status == "completed")] | length' "$PROGRESS"
}

# Total task count
harness_total_count() {
  local PROGRESS="$1"
  jq '.tasks // {} | length' "$PROGRESS"
}

# Completed task names (comma-separated)
harness_completed_names() {
  local PROGRESS="$1"
  jq -r '[.tasks // {} | to_entries[] | select(.value.status == "completed") | .key] | join(", ")' "$PROGRESS"
}

# Pending task names (comma-separated)
harness_pending_names() {
  local PROGRESS="$1"
  jq -r '[.tasks // {} | to_entries[] | select(.value.status == "pending") | .key] | join(", ")' "$PROGRESS"
}

# Get task description
harness_task_description() {
  local PROGRESS="$1"
  local TASK="$2"
  jq -r --arg t "$TASK" '.tasks[$t].description // ""' "$PROGRESS"
}

# Get harness name from progress file
harness_name() {
  local PROGRESS="$1"
  jq -r '.harness // "unknown"' "$PROGRESS"
}

# Get harness mission
harness_mission() {
  local PROGRESS="$1"
  jq -r '.mission // ""' "$PROGRESS"
}

# Check if a task is blocked; returns JSON with blocker details or "null" if unblocked.
# Usage: BLOCKED=$(harness_check_blocked "$PROGRESS" "task-id")
#   "null" → task is runnable
#   Otherwise → JSON: {"blocked":true, "task":"task-id", "waiting_on": [{"task":"dep-id","status":"pending","owner":null},...]}
harness_check_blocked() {
  local PROGRESS="$1"
  local TASK="$2"
  jq -r --arg t "$TASK" '
    . as $root |
    (.tasks[$t].blockedBy // []) as $deps |
    if ($deps | length) == 0 then "null"
    else
      [$deps[] as $dep |
        # Treat missing tasks as incomplete (safe default)
        select(($root.tasks[$dep].status // "missing") != "completed") |
        {task: $dep, status: ($root.tasks[$dep].status // "missing"), owner: ($root.tasks[$dep].owner // null)}
      ] |
      if length == 0 then "null"
      else {blocked: true, task: $t, waiting_on: .} | tojson
      end
    end
  ' "$PROGRESS"
}

# Set a task to in_progress (outputs to stdout, caller must redirect).
# Validates dependencies — refuses if blockers remain and prints what's blocking to stderr.
# Check other agents' progress via /tmp/tmux_pane_meta_{pane_id} or tmux capture-pane.
harness_set_in_progress() {
  local PROGRESS="$1"
  local TASK="$2"
  local BLOCKED=$(harness_check_blocked "$PROGRESS" "$TASK")
  if [ "$BLOCKED" != "null" ]; then
    local BLOCKERS=$(echo "$BLOCKED" | jq -r '.waiting_on[] | "  - \(.task) [\(.status)] owner=\(.owner // "unassigned")"')
    echo "ERROR: Cannot start '$TASK' — blocked by incomplete dependencies:" >&2
    echo "$BLOCKERS" >&2
    echo "Tip: check other agents' task status via /tmp/tmux_pane_meta_{pane_id} or tmux capture-pane -t {pane} -p | tail -5" >&2
    return 1
  fi
  jq --arg t "$TASK" '.tasks[$t].status = "in_progress"' "$PROGRESS"
}

# Set a task to completed (outputs to stdout, caller must redirect)
harness_set_completed() {
  local PROGRESS="$1"
  local TASK="$2"
  jq --arg t "$TASK" '.tasks[$t].status = "completed"' "$PROGRESS"
}

# List tasks that would be unblocked if the given task were completed
harness_would_unblock() {
  local PROGRESS="$1"
  local TASK="$2"
  jq -r --arg t "$TASK" '
    . as $root |
    [.tasks | to_entries[] | select(
      .value.status == "pending" and
      (.value.blockedBy // [] | index($t)) and
      ((.value.blockedBy // []) as $deps |
       [$deps[] | select(. != $t) | $root.tasks[.].status] | all(. == "completed"))
    ) | .key] | join(", ")
  ' "$PROGRESS"
}

# Get state.* field (harness-specific state like pass_rate_history, cycle_count)
harness_state() {
  local PROGRESS="$1"
  local KEY="$2"
  # Validate key: only alphanumeric, dots, underscores, brackets (prevent jq injection)
  if [[ ! "$KEY" =~ ^[a-zA-Z0-9._\[\]]+$ ]]; then
    echo ""
    return 1
  fi
  jq -r ".state.${KEY} // empty" "$PROGRESS" 2>/dev/null
}

# ═══════════════════════════════════════════════════════════════
# MANIFEST REGISTRY FUNCTIONS
# ═══════════════════════════════════════════════════════════════

# Get manifest path for a harness
harness_manifest() {
  local name="$1"
  echo "$HOME/.claude-ops/harness/manifests/$name/manifest.json"
}

# Get project root for a harness (from manifest)
harness_project_root() {
  local name="$1"
  local manifest="$(harness_manifest "$name")"
  [ -f "$manifest" ] && jq -r '.project_root // ""' "$manifest" 2>/dev/null || echo ""
}

# Get progress file path for a harness (absolute, from manifest)
harness_progress_path() {
  local name="$1"
  local manifest="$(harness_manifest "$name")"
  [ ! -f "$manifest" ] && echo "" && return
  local project=$(jq -r '.project_root // ""' "$manifest" 2>/dev/null)
  # Support both new (.files.progress) and old (.progress_file) manifest schemas
  local rel=$(jq -r '.files.progress // .progress_file // ""' "$manifest" 2>/dev/null)
  [ -n "$project" ] && [ -n "$rel" ] && echo "$project/$rel" || echo ""
}

# Helper: extract relative progress path from a manifest (handles old + new schema)
_manifest_rel_progress() {
  jq -r '.files.progress // .progress_file // ""' "$1" 2>/dev/null
}

# List all active harnesses across all projects
# Output: name|project_root|progress_path (one per line)
harness_list_active() {
  for manifest in "$HOME"/.claude-ops/harness/manifests/*/manifest.json; do
    [ -f "$manifest" ] || continue
    local name=$(jq -r '.harness' "$manifest" 2>/dev/null)
    local project=$(jq -r '.project_root' "$manifest" 2>/dev/null)
    local rel_progress=$(_manifest_rel_progress "$manifest")
    [ -z "$rel_progress" ] && continue
    local progress="$project/$rel_progress"
    [ ! -f "$progress" ] && continue
    local hstatus=$(jq -r '.status // "unknown"' "$progress" 2>/dev/null || echo "unknown")
    [ "$hstatus" = "active" ] && echo "$name|$project|$progress"
  done
}

# List all registered harnesses (active and done)
# Output: name|status|project_root
harness_list_all() {
  for manifest in "$HOME"/.claude-ops/harness/manifests/*/manifest.json; do
    [ -f "$manifest" ] || continue
    local name=$(jq -r '.harness' "$manifest" 2>/dev/null)
    local project=$(jq -r '.project_root' "$manifest" 2>/dev/null)
    local rel_progress=$(_manifest_rel_progress "$manifest")
    local hstatus="unknown"
    if [ -n "$rel_progress" ]; then
      local progress="$project/$rel_progress"
      [ -f "$progress" ] && hstatus=$(jq -r '.status // "unknown"' "$progress" 2>/dev/null || echo "unknown")
    fi
    echo "$name|$hstatus|$project"
  done
}

# ══════════════════════════════════════════════════════════════════
# Deregistration
# ══════════════════════════════════════════════════════════════════

# Deregister a harness: set status=done in manifest+progress, clean tmp state
# Usage: harness_deregister <name> [--purge]
#   --purge: also delete the manifest directory (irreversible)
harness_deregister() {
  local name="$1"
  local purge=false
  [ "${2:-}" = "--purge" ] && purge=true

  local manifest_dir="$HOME/.claude-ops/harness/manifests/$name"
  local manifest="$manifest_dir/manifest.json"

  if [ ! -f "$manifest" ]; then
    echo "No manifest found for harness: $name" >&2
    return 1
  fi

  local project=$(jq -r '.project_root' "$manifest" 2>/dev/null)
  local rel_progress=$(_manifest_rel_progress "$manifest")
  local progress="$project/$rel_progress"

  # Set status=done in manifest
  locked_jq_write "$manifest" "manifest-$name" '.status = "done"'

  # Set status=done in progress file
  if [ -f "$progress" ]; then
    locked_jq_write "$progress" "progress-$name" '.status = "done"'
  fi

  # Clean tmp state files
  rm -f "/tmp/claude_rotation_advisory_$name"
  rm -f "/tmp/claude_activity_$name.jsonl"
  rm -f "/tmp/claude_harness_pending_$name"
  rm -f "/tmp/claude_harness_rotate_fallback_$name"

  # Remove from session registry
  if [ -f "$HARNESS_SESSION_REGISTRY" ]; then
    locked_jq_write "$HARNESS_SESSION_REGISTRY" "session-registry" \
      'with_entries(select(.value != $h))' --arg h "$name"
  fi

  if [ "$purge" = true ]; then
    rm -rf "$manifest_dir"
    echo "Purged harness: $name (manifest deleted)"
  else
    echo "Deregistered harness: $name (status=done, tmp cleaned)"
  fi
}

# Bulk deregister: clean tmp for done harnesses, purge test scaffolds
# Usage: harness_gc [--purge-tests]
harness_gc() {
  local purge_tests=false
  [ "${1:-}" = "--purge-tests" ] && purge_tests=true

  local count=0
  for manifest in "$HOME"/.claude-ops/harness/manifests/*/manifest.json; do
    [ -f "$manifest" ] || continue
    local name=$(jq -r '.harness' "$manifest" 2>/dev/null)
    local project=$(jq -r '.project_root' "$manifest" 2>/dev/null)
    local rel_progress=$(_manifest_rel_progress "$manifest")
    local progress="$project/$rel_progress"
    local hstatus="unknown"
    [ -n "$rel_progress" ] && [ -f "$progress" ] && hstatus=$(jq -r '.status // "unknown"' "$progress" 2>/dev/null || echo "unknown")

    # Purge test scaffolds (immediately if --purge-tests, otherwise after 24h)
    if [[ "$name" == test-scaffold-* ]]; then
      local manifest_age=$(( $(date +%s) - $(_file_mtime "$manifest" 2>/dev/null || echo 0) ))
      if [ "$purge_tests" = true ] || [ "$manifest_age" -gt 86400 ]; then
        rm -rf "$(dirname "$manifest")"
        echo "Purged test scaffold: $name (age: ${manifest_age}s)"
        ((count++))
      fi
      continue
    fi

    # Clean tmp for done harnesses, sync manifest status
    if [ "$hstatus" = "done" ]; then
      rm -f "/tmp/claude_rotation_advisory_$name"
      rm -f "/tmp/claude_activity_$name.jsonl"
      locked_jq_write "$manifest" "manifest-$name" '.status = "done"'
      echo "Cleaned: $name"
      ((count++))
    fi
  done
  echo "GC complete: $count harnesses processed"
}
