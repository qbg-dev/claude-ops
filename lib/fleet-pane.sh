#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# fleet-pane.sh — Shared pane discovery utilities
# ══════════════════════════════════════════════════════════════════
# Usage:
#   source ~/.claude-ops/lib/fleet-pane.sh
#
# Requires:
#   - tmux available
#   - pane-registry.json (sole source of truth)
# ══════════════════════════════════════════════════════════════════

HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
PANE_REGISTRY="${PANE_REGISTRY:-$HARNESS_STATE_DIR/pane-registry.json}"

# Find the worker pane for a harness.
# Returns compound string: "pane_id|target" (e.g. "%413|h:1.0")
#
# Single source of truth: registry.panes maps pane_id -> harness.
# Reverse lookup: find the pane_id registered for this harness, verify it's alive.
# Uses PROJECT_ROOT env var for project-scoped lookup (prevents cross-project matches).
find_worker_pane() {
  local harness="$1"
  local pane_id ptarget ppid cpid
  local _proj="${PROJECT_ROOT:-}"
  local _wn="${harness#worker/}"

  # PRIMARY: registry.json (flat workers — new system)
  local _flat_reg="${_proj:+$_proj/.claude/workers/registry.json}"
  if [ -n "${_flat_reg:-}" ] && [ -f "$_flat_reg" ]; then
    pane_id=$(jq -r --arg n "$_wn" '.[$n].pane_id // ""' "$_flat_reg" 2>/dev/null || echo "")
  fi

  # FALLBACK: Look up pane_id from pane-registry.json (legacy harness workers)
  # Priority: panes section (unified) → flat entries (compat)
  if [ -z "${pane_id:-}" ] && [ -f "$PANE_REGISTRY" ]; then
    # Try panes section first
    pane_id=$(jq -r --arg wn "$_wn" \
      '[.panes | to_entries[] | select(.value.worker == $wn and .value.role == "worker") | .key] | first // ""' \
      "$PANE_REGISTRY" 2>/dev/null || echo "")
    # Flat entry fallback (project-scoped when PROJECT_ROOT is set)
    if [ -z "${pane_id:-}" ] && [ -n "$_proj" ]; then
      pane_id=$(jq -r --arg h "$harness" --arg proj "$_proj" \
        '[to_entries[] | select(.key | startswith("%")) | select(.value.harness == $h and (.value.project_root // "") == $proj) | .key] | first // ""' \
        "$PANE_REGISTRY" 2>/dev/null || echo "")
    fi
    # Last resort: unscoped flat entry (single-project environments)
    if [ -z "${pane_id:-}" ] && [ -z "$_proj" ]; then
      pane_id=$(jq -r --arg h "$harness" '[to_entries[] | select(.key | startswith("%")) | select(.value.harness == $h) | .key] | first // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
    fi
  fi

  if [ -n "$pane_id" ]; then
    # Verify pane still exists
    ptarget=$(tmux list-panes -a -F $'#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
      | awk -F'\t' -v id="$pane_id" '$1 == id {print $2; exit}')
    if [ -n "$ptarget" ]; then
      # Verify it has a claude process
      ppid=$(tmux display-message -t "$pane_id" -p '#{pane_pid}' 2>/dev/null || echo "")
      if [ -n "$ppid" ]; then
        for cpid in $(pgrep -P "$ppid" 2>/dev/null | head -5); do
          if ps -o command= -p "$cpid" 2>/dev/null | grep -q "^claude "; then
            echo "${pane_id}|${ptarget}"
            return 0
          fi
        done
      fi
    fi
  fi

  return 1
}

# Find the monitor pane for a harness
# Args: harness worker_pane_id [worker_pane_target]
find_monitor_pane() {
  local harness="$1" worker_pane_id="$2" worker_pane="${3:-}"
  local slug state_dir mpane

  # Primary: pane_id-keyed state dir (new structured path)
  slug="pid${worker_pane_id#%}"
  state_dir="$(harness_monitor_dir "$slug" 2>/dev/null || echo "$HARNESS_STATE_DIR/monitors/$slug")"
  if [ -f "$state_dir/monitor-pane" ]; then
    mpane=$(cat "$state_dir/monitor-pane")
    echo "$mpane"
    return 0
  fi

  # Fallback: old target-keyed state dir (migration period)
  if [ -n "$worker_pane" ]; then
    slug=$(echo "$worker_pane" | tr ':.' '-')
    state_dir="$(harness_monitor_dir "$slug" 2>/dev/null || echo "$HARNESS_STATE_DIR/monitors/$slug")"
    if [ -f "$state_dir/monitor-pane" ]; then
      mpane=$(cat "$state_dir/monitor-pane")
      echo "$mpane"
      return 0
    fi
  fi

  return 1
}

# Find monitor daemon PID for a harness
# Args: worker_pane_id [worker_pane_target]
find_daemon_pid() {
  local worker_pane_id="$1" worker_pane="${2:-}"
  local slug state_dir

  # Primary: pane_id-keyed state dir (new structured path)
  slug="pid${worker_pane_id#%}"
  state_dir="$(harness_monitor_dir "$slug" 2>/dev/null || echo "$HARNESS_STATE_DIR/monitors/$slug")"
  if [ -f "$state_dir/daemon.pid" ]; then
    cat "$state_dir/daemon.pid"
    return 0
  fi

  # Fallback: old target-keyed state dir (migration period)
  if [ -n "$worker_pane" ]; then
    slug=$(echo "$worker_pane" | tr ':.' '-')
    state_dir="$(harness_monitor_dir "$slug" 2>/dev/null || echo "$HARNESS_STATE_DIR/monitors/$slug")"
    if [ -f "$state_dir/daemon.pid" ]; then
      cat "$state_dir/daemon.pid"
      return 0
    fi
  fi

  return 1
}

# Check if a Claude process is alive in a tmux pane
is_claude_alive_in_pane() {
  local pane="$1"
  local pane_pid cpid
  pane_pid=$(tmux display-message -t "$pane" -p '#{pane_pid}' 2>/dev/null || echo "")
  [ -z "$pane_pid" ] && return 1
  for cpid in $(pgrep -P "$pane_pid" 2>/dev/null | head -5); do
    if ps -o command= -p "$cpid" 2>/dev/null | grep -q "^claude "; then
      return 0
    fi
  done
  return 1
}
