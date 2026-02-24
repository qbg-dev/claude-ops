#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# control-plane.sh — K8s-inspired harness control plane daemon
# ══════════════════════════════════════════════════════════════════
#
# Single process with three subsystems running on different intervals:
#   1. Liveness — are worker/monitor/daemon processes alive?
#   2. Readiness + Stuck — is the worker productive?
#   3. Sweeps — modular maintenance tasks (sweeps.d/*.sh)
#   4. Reconciliation — desired state vs actual state
#
# Usage:
#   bash ~/.claude-ops/control-plane.sh                  # start daemon (discovers harnesses from manifests)
#   bash ~/.claude-ops/control-plane.sh --dry-run        # one tick, print actions, exit
#   bash ~/.claude-ops/control-plane.sh --project /path  # optional: limit to one project
#   bash ~/.claude-ops/control-plane.sh --stop           # kill running daemon
#
# Config: ~/.claude-ops/control-plane.conf (sourced every tick)
# PID file: /tmp/harness_control_plane.pid
# Health: /tmp/harness_health.json
# Metrics: /tmp/harness_metrics.jsonl
# Sweep state: /tmp/harness_sweep_state.json
set -euo pipefail

# ══════════════════════════════════════════════════════════════════
# Parse arguments
# ══════════════════════════════════════════════════════════════════
DRY_RUN=false
PROJECT_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=true; shift ;;
    --project)    PROJECT_OVERRIDE="$2"; shift 2 ;;
    --stop)
      if [ -f /tmp/harness_control_plane.pid ]; then
        PID=$(cat /tmp/harness_control_plane.pid)
        if kill -0 "$PID" 2>/dev/null; then
          kill "$PID"
          echo "Control plane stopped (PID $PID)"
        else
          echo "Control plane not running (stale PID $PID)"
        fi
        rm -f /tmp/harness_control_plane.pid
      else
        echo "No PID file found at /tmp/harness_control_plane.pid"
      fi
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ══════════════════════════════════════════════════════════════════
# Constants
# ══════════════════════════════════════════════════════════════════
CONF="$HOME/.claude-ops/control-plane.conf"
PID_FILE="/tmp/harness_control_plane.pid"
SWEEP_STATE="/tmp/harness_sweep_state.json"
HEALTH_FILE="/tmp/harness_health.json"
METRICS_FILE="/tmp/harness_metrics.jsonl"
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY="$HARNESS_SESSION_REGISTRY"
HEALTH_TICK_DIR="/tmp/harness_health_tick"
CP_TMUX_SESSION="cp"             # dedicated tmux session for control plane
CP_DASHBOARD_WINDOW="cp:dashboard"  # daemon runs here
CP_SWEEPS_WINDOW="cp:sweeps"       # sweep-spawned agents go here

# ══════════════════════════════════════════════════════════════════
# Ensure single instance
# ══════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" = false ]; then
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Control plane already running (PID $OLD_PID). Use --stop first." >&2
      exit 1
    fi
    rm -f "$PID_FILE"
  fi
  echo $$ > "$PID_FILE"

  # Create dedicated cp: tmux session for control plane operations.
  # Layout: cp:dashboard (daemon status), cp:sweeps (sweep-spawned agents)
  # Workers + monitors stay in h: session.
  local_project="${PROJECT_OVERRIDE:-$HOME}"
  if ! tmux has-session -t "$CP_TMUX_SESSION" 2>/dev/null; then
    tmux new-session -d -s "$CP_TMUX_SESSION" -n dashboard -c "$local_project" 2>/dev/null || true
    if tmux has-session -t "$CP_TMUX_SESSION" 2>/dev/null; then
      # Create sweeps window for spawn targets
      tmux new-window -d -t "$CP_TMUX_SESSION" -n sweeps -c "$local_project" 2>/dev/null || true
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] control-plane: Created tmux session cp: (dashboard + sweeps)" >&2
    fi
  fi
  # Export so sweep scripts know where to spawn agents
  export CP_TMUX_SESSION CP_SWEEPS_WINDOW
fi

# ══════════════════════════════════════════════════════════════════
# Clean shutdown
# ══════════════════════════════════════════════════════════════════
cleanup() {
  log "Shutting down (PID $$)"
  rm -f "$PID_FILE"
  rm -rf "$HEALTH_TICK_DIR"
  # Kill the cp: session if we created it and it's empty (no Claude agents running)
  if tmux has-session -t "$CP_TMUX_SESSION" 2>/dev/null; then
    local has_claude=false
    while IFS=$'\t' read -r ptarget ppid; do
      for cpid in $(pgrep -P "$ppid" 2>/dev/null | head -3); do
        ps -o command= -p "$cpid" 2>/dev/null | grep -q "^claude " && has_claude=true
      done
    done < <(tmux list-panes -t "$CP_TMUX_SESSION" -a -F $'#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}' 2>/dev/null)
    if [ "$has_claude" = false ]; then
      tmux kill-session -t "$CP_TMUX_SESSION" 2>/dev/null || true
      log "Cleaned up cp: tmux session"
    else
      log "cp: session has running Claude agents — leaving it alive"
    fi
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT

# ══════════════════════════════════════════════════════════════════
# Core utilities
# ══════════════════════════════════════════════════════════════════

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] control-plane: $*" >&2
}

emit_metric() {
  local type="$1"; shift
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Build JSON from positional key=value pairs
  local json="{\"ts\":\"$ts\",\"type\":\"$type\""
  local kv key val
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    # Auto-detect numbers vs strings
    if [[ "$val" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
      json="$json,\"$key\":$val"
    elif [[ "$val" == "true" || "$val" == "false" ]]; then
      json="$json,\"$key\":$val"
    else
      json="$json,\"$key\":\"$val\""
    fi
  done
  json="$json}"
  echo "$json" >> "$METRICS_FILE"
}

# ══════════════════════════════════════════════════════════════════
# File-backed health state (bash 3.2 compatible — no associative arrays)
# ══════════════════════════════════════════════════════════════════
# Each tick, per-harness health data is written to files:
#   /tmp/harness_health_tick/{harness}.worker.json
#   /tmp/harness_health_tick/{harness}.monitor.json
#   /tmp/harness_health_tick/{harness}.daemon.json

reset_health_tick() {
  rm -rf "$HEALTH_TICK_DIR"
  mkdir -p "$HEALTH_TICK_DIR"
}

set_health() {
  local harness="$1" component="$2" json="$3"
  echo "$json" > "$HEALTH_TICK_DIR/${harness}.${component}.json"
}

get_health() {
  local harness="$1" component="$2" default="$3"
  local file="$HEALTH_TICK_DIR/${harness}.${component}.json"
  if [ -f "$file" ]; then
    cat "$file"
  else
    echo "$default"
  fi
}

# ══════════════════════════════════════════════════════════════════
# Scheduler: should_run / record_last_run
# ══════════════════════════════════════════════════════════════════
# Tracks last-run times in /tmp/harness_sweep_state.json

init_sweep_state() {
  if [ ! -f "$SWEEP_STATE" ]; then
    echo '{}' > "$SWEEP_STATE"
  fi
}

should_run() {
  local name="$1"
  local interval="$2"
  local now
  now=$(date +%s)

  init_sweep_state

  local last_run
  last_run=$(jq -r --arg n "$name" '.[$n] // 0' "$SWEEP_STATE" 2>/dev/null || echo "0")
  local elapsed=$(( now - last_run ))

  if [ "$elapsed" -ge "$interval" ]; then
    return 0  # yes, should run
  else
    return 1  # not yet
  fi
}

record_last_run() {
  local name="$1"
  local now
  now=$(date +%s)

  init_sweep_state

  local tmp
  tmp=$(mktemp)
  jq --arg n "$name" --argjson t "$now" '.[$n] = $t' "$SWEEP_STATE" > "$tmp" && mv "$tmp" "$SWEEP_STATE"
}

# ══════════════════════════════════════════════════════════════════
# Harness discovery
# ══════════════════════════════════════════════════════════════════

# active_harness_names — prints names of active harnesses (one per line)
# Uses manifest registry for multi-project discovery. Falls back to single project if --project given.
active_harness_names() {
  if [ -n "${PROJECT_OVERRIDE:-}" ]; then
    # Legacy single-project mode
    local pfile pstatus hname
    for pfile in "$PROJECT_OVERRIDE"/claude_files/*-progress.json; do
      [ -f "$pfile" ] || continue
      pstatus=$(jq -r '.status // "inactive"' "$pfile" 2>/dev/null || echo "inactive")
      [ "$pstatus" != "active" ] && continue
      hname=$(jq -r '.harness // ""' "$pfile" 2>/dev/null)
      [ -z "$hname" ] && hname=$(basename "$pfile" | sed 's/-progress\.json//')
      echo "$hname"
    done
  else
    # Registry-native: discover from manifests
    harness_list_active | cut -d'|' -f1
  fi
}

# active_harness_project — get project_root for a harness (from manifest)
active_harness_project() {
  local hname="$1"
  if [ -n "${PROJECT_OVERRIDE:-}" ]; then
    echo "$PROJECT_OVERRIDE"
  else
    harness_project_root "$hname"
  fi
}

# active_harness_progress — get progress file path for a harness
active_harness_progress() {
  local hname="$1"
  if [ -n "${PROJECT_OVERRIDE:-}" ]; then
    echo "$PROJECT_OVERRIDE/claude_files/${hname}-progress.json"
  else
    harness_progress_path "$hname"
  fi
}

# Find the worker pane for a harness by scanning the registry + tmux
# Returns compound string: "pane_id|target" (e.g. "%413|h:1.1")
find_worker_pane() {
  local harness="$1"
  [ ! -f "$REGISTRY" ] && return 1

  # Get session ID for this harness
  local session_id
  session_id=$(jq -r "to_entries[] | select(.value == \"$harness\") | .key" "$REGISTRY" 2>/dev/null | head -1)
  [ -z "$session_id" ] && return 1

  # Walk all tmux panes to find one running claude with this harness
  local ptarget ppid pane_id cpid meta_harness
  while IFS=$'\t' read -r ptarget ppid pane_id; do
    # Check children for claude process
    for cpid in $(pgrep -P "$ppid" 2>/dev/null | head -5); do
      if ps -o command= -p "$cpid" 2>/dev/null | grep -q "^claude "; then
        # Verify via pane metadata
        if [ -f "/tmp/tmux_pane_meta_${pane_id}" ]; then
          meta_harness=$(jq -r '.harness // ""' "/tmp/tmux_pane_meta_${pane_id}" 2>/dev/null || echo "")
          if [ "$meta_harness" = "$harness" ]; then
            echo "${pane_id}|${ptarget}"
            return 0
          fi
        fi
        # Fallback: capture pane and look for session ID
        if tmux capture-pane -t "$ptarget" -p 2>/dev/null | grep -q "$session_id"; then
          echo "${pane_id}|${ptarget}"
          return 0
        fi
      fi
    done
  done < <(tmux list-panes -a -F $'#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_id}' 2>/dev/null)

  return 1
}

# Find the monitor pane for a harness
# Args: harness worker_pane_id [worker_pane_target]
find_monitor_pane() {
  local harness="$1" worker_pane_id="$2" worker_pane="${3:-}"
  local slug state_dir mpane

  # Primary: pane_id-keyed state dir
  slug="pid${worker_pane_id#%}"
  state_dir="/tmp/monitor-agent-${slug}"
  if [ -f "$state_dir/monitor-pane" ]; then
    mpane=$(cat "$state_dir/monitor-pane")
    echo "$mpane"
    return 0
  fi

  # Fallback: old target-keyed state dir (migration period)
  if [ -n "$worker_pane" ]; then
    slug=$(echo "$worker_pane" | tr ':.' '-')
    state_dir="/tmp/monitor-agent-${slug}"
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

  # Primary: pane_id-keyed state dir
  slug="pid${worker_pane_id#%}"
  state_dir="/tmp/monitor-agent-${slug}"
  if [ -f "$state_dir/daemon.pid" ]; then
    cat "$state_dir/daemon.pid"
    return 0
  fi

  # Fallback: old target-keyed state dir (migration period)
  if [ -n "$worker_pane" ]; then
    slug=$(echo "$worker_pane" | tr ':.' '-')
    state_dir="/tmp/monitor-agent-${slug}"
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

# ══════════════════════════════════════════════════════════════════
# Health check functions
# ══════════════════════════════════════════════════════════════════

# Per-harness restart counters: /tmp/harness_restarts_{harness}_{component}.count
get_restart_count() {
  local harness="$1" component="$2"
  local file="/tmp/harness_restarts_${harness}_${component}.count"
  if [ -f "$file" ]; then
    cat "$file"
  else
    echo "0"
  fi
}

increment_restart_count() {
  local harness="$1" component="$2"
  local file="/tmp/harness_restarts_${harness}_${component}.count"
  local count
  count=$(get_restart_count "$harness" "$component")
  echo $(( count + 1 )) > "$file"
}

reset_restart_count() {
  local harness="$1" component="$2"
  rm -f "/tmp/harness_restarts_${harness}_${component}.count"
}

check_worker_alive() {
  local harness="$1"
  local worker_result worker_pane_id worker_pane restarts

  worker_result=$(find_worker_pane "$harness" 2>/dev/null || echo "")

  if [ -z "$worker_result" ]; then
    log "WARN [$harness] worker: no pane found in registry"
    emit_metric "liveness" "harness=$harness" "component=worker" "status=missing"
    set_health "$harness" "worker" '{"pane":"unknown","alive":false,"status":"missing","restarts":'$(get_restart_count "$harness" "worker")'}'
    return
  fi

  worker_pane_id="${worker_result%%|*}"
  worker_pane="${worker_result#*|}"

  if is_claude_alive_in_pane "$worker_pane"; then
    set_health "$harness" "worker" '{"pane":"'"$worker_pane"'","alive":true,"status":"healthy","restarts":'$(get_restart_count "$harness" "worker")'}'
    reset_restart_count "$harness" "worker"
    return
  fi

  # Worker is dead
  restarts=$(get_restart_count "$harness" "worker")
  log "DEAD [$harness] worker in $worker_pane (restarts: $restarts/$LIVENESS_MAX_RESTARTS)"
  emit_metric "liveness" "harness=$harness" "component=worker" "status=dead" "restarts=$restarts"

  if [ "$LIVENESS_NOTIFY" = true ]; then
    notify "[$harness] Worker died in $worker_pane (restart $restarts/$LIVENESS_MAX_RESTARTS)" "Harness Liveness" 2>/dev/null || true
  fi

  if [ "$LIVENESS_AUTO_RESTART" = true ] && [ "$restarts" -lt "$LIVENESS_MAX_RESTARTS" ]; then
    if [ "$DRY_RUN" = true ]; then
      log "DRY-RUN: would restart worker for $harness via handoff.sh"
    else
      log "Restarting worker for $harness via handoff.sh"
      bash "$HOME/.claude-ops/lib/handoff.sh" --harness "$harness" 2>/dev/null &
      increment_restart_count "$harness" "worker"
    fi
  elif [ "$restarts" -ge "$LIVENESS_MAX_RESTARTS" ]; then
    log "GIVE UP [$harness] worker: exceeded max restarts ($LIVENESS_MAX_RESTARTS)"
    if [ "$LIVENESS_NOTIFY" = true ]; then
      notify "[$harness] Worker exceeded max restarts ($LIVENESS_MAX_RESTARTS). Manual intervention needed." "Harness CRITICAL" 2>/dev/null || true
    fi
  fi

  set_health "$harness" "worker" '{"pane":"'"$worker_pane"'","alive":false,"status":"dead","restarts":'"$restarts"'}'
}

check_monitor_alive() {
  local harness="$1"
  local worker_result worker_pane_id worker_pane monitor_pane restarts slug state_dir

  worker_result=$(find_worker_pane "$harness" 2>/dev/null || echo "")
  [ -z "$worker_result" ] && return
  worker_pane_id="${worker_result%%|*}"
  worker_pane="${worker_result#*|}"

  monitor_pane=$(find_monitor_pane "$harness" "$worker_pane_id" "$worker_pane" 2>/dev/null || echo "")

  if [ -z "$monitor_pane" ]; then
    set_health "$harness" "monitor" '{"pane":"none","alive":false,"status":"not_deployed","restarts":0}'
    return
  fi

  if is_claude_alive_in_pane "$monitor_pane"; then
    set_health "$harness" "monitor" '{"pane":"'"$monitor_pane"'","alive":true,"status":"healthy","restarts":'$(get_restart_count "$harness" "monitor")'}'
    reset_restart_count "$harness" "monitor"
    return
  fi

  # Monitor is dead
  restarts=$(get_restart_count "$harness" "monitor")
  log "DEAD [$harness] monitor in $monitor_pane (restarts: $restarts/$LIVENESS_MAX_RESTARTS)"
  emit_metric "liveness" "harness=$harness" "component=monitor" "status=dead" "restarts=$restarts"

  if [ "$LIVENESS_AUTO_RESTART" = true ] && [ "$restarts" -lt "$LIVENESS_MAX_RESTARTS" ]; then
    if [ "$DRY_RUN" = true ]; then
      log "DRY-RUN: would restart monitor for $harness ($worker_pane)"
    else
      log "Restarting monitor for $harness ($worker_pane)"
      slug="pid${worker_pane_id#%}"
      state_dir="/tmp/monitor-agent-${slug}"
      # Reuse existing pane if it still exists, otherwise monitor-agent.sh will create one
      if [ -f "$state_dir/reused-pane" ] && tmux list-panes -t "$monitor_pane" >/dev/null 2>&1; then
        bash "$HOME/.claude/scripts/monitor-agent.sh" --pane "$monitor_pane" "$worker_pane" &
      else
        bash "$HOME/.claude/scripts/monitor-agent.sh" "$worker_pane" &
      fi
      increment_restart_count "$harness" "monitor"
    fi
  fi

  set_health "$harness" "monitor" '{"pane":"'"$monitor_pane"'","alive":false,"status":"dead","restarts":'"$restarts"'}'
}

check_daemon_alive() {
  local harness="$1"
  local worker_result worker_pane_id worker_pane daemon_pid

  worker_result=$(find_worker_pane "$harness" 2>/dev/null || echo "")
  [ -z "$worker_result" ] && return
  worker_pane_id="${worker_result%%|*}"
  worker_pane="${worker_result#*|}"

  daemon_pid=$(find_daemon_pid "$worker_pane_id" "$worker_pane" 2>/dev/null || echo "")

  if [ -z "$daemon_pid" ]; then
    set_health "$harness" "daemon" '{"pid":0,"alive":false,"restarts":0}'
    return
  fi

  if kill -0 "$daemon_pid" 2>/dev/null; then
    set_health "$harness" "daemon" '{"pid":'"$daemon_pid"',"alive":true,"restarts":0}'
  else
    log "WARN [$harness] daemon PID $daemon_pid is dead"
    emit_metric "liveness" "harness=$harness" "component=daemon" "status=dead" "pid=$daemon_pid"
    set_health "$harness" "daemon" '{"pid":'"$daemon_pid"',"alive":false,"restarts":0}'
  fi
}

write_health_json() {
  local now harness worker monitor daemon current_task last_activity
  local activity_log pfile harnesses_json first

  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Build harnesses object
  harnesses_json="{"
  first=true

  for harness in $(active_harness_names); do
    worker=$(get_health "$harness" "worker" '{"pane":"unknown","alive":false,"status":"unknown","restarts":0}')
    monitor=$(get_health "$harness" "monitor" '{"pane":"none","alive":false,"status":"not_deployed","restarts":0}')
    daemon=$(get_health "$harness" "daemon" '{"pid":0,"alive":false,"restarts":0}')

    # Current task from progress file
    pfile=$(active_harness_progress "$harness")
    current_task="unknown"
    if [ -f "$pfile" ]; then
      current_task=$(source "$HOME/.claude-ops/lib/harness-jq.sh" && harness_current_task "$pfile" 2>/dev/null || echo "unknown")
    fi

    # Last activity from activity log
    last_activity=""
    activity_log="/tmp/claude_activity_${harness}.jsonl"
    if [ -f "$activity_log" ]; then
      last_activity=$(tail -1 "$activity_log" 2>/dev/null | jq -r '.ts // ""' 2>/dev/null || echo "")
    fi

    if [ "$first" = true ]; then
      first=false
    else
      harnesses_json="$harnesses_json,"
    fi

    harnesses_json="$harnesses_json\"$harness\":{\"worker\":$worker,\"monitor\":$monitor,\"daemon\":$daemon,\"current_task\":\"$current_task\",\"last_activity\":\"$last_activity\"}"
  done

  harnesses_json="$harnesses_json}"

  jq -n --argjson harnesses "$harnesses_json" --arg updated "$now" \
    '{harnesses: $harnesses, updated_at: $updated}' > "$HEALTH_FILE"
}

# ══════════════════════════════════════════════════════════════════
# Readiness checks
# ══════════════════════════════════════════════════════════════════

check_worker_readiness() {
  local harness="$1"
  local activity_log="/tmp/claude_activity_${harness}.jsonl"
  local last_ts last_epoch now idle_seconds advisory

  if [ ! -f "$activity_log" ]; then
    log "[$harness] readiness: no activity log"
    emit_metric "readiness" "harness=$harness" "status=no_log"
    return
  fi

  last_ts=$(tail -1 "$activity_log" 2>/dev/null | jq -r '.ts // ""' 2>/dev/null || echo "")
  if [ -z "$last_ts" ]; then
    log "[$harness] readiness: empty activity log"
    return
  fi

  # Convert ISO timestamp to epoch (macOS date)
  last_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_ts" +%s 2>/dev/null || \
               date -j -f "%Y-%m-%dT%H:%M:%S" "${last_ts%Z}" +%s 2>/dev/null || echo "0")
  now=$(date +%s)
  idle_seconds=$(( now - last_epoch ))

  if [ "$idle_seconds" -ge "$READINESS_ROTATE_AFTER" ]; then
    log "ROTATE [$harness] idle for ${idle_seconds}s (threshold: ${READINESS_ROTATE_AFTER}s)"
    emit_metric "readiness" "harness=$harness" "status=rotate" "idle_seconds=$idle_seconds"
    if [ "$DRY_RUN" = true ]; then
      log "DRY-RUN: would write rotation advisory for $harness"
    else
      advisory="/tmp/claude_rotation_advisory_${harness}"
      jq -n --arg reason "Idle for ${idle_seconds}s (>${READINESS_ROTATE_AFTER}s)" \
        '{"should_rotate":true,"reason":$reason,"decided_at":(now | todate)}' > "$advisory"
    fi
  elif [ "$idle_seconds" -ge "$READINESS_DEGRADED_AFTER" ]; then
    log "DEGRADED [$harness] idle for ${idle_seconds}s (threshold: ${READINESS_DEGRADED_AFTER}s)"
    emit_metric "readiness" "harness=$harness" "status=degraded" "idle_seconds=$idle_seconds"
    if [ "$READINESS_NOTIFY_ON_DEGRADED" = true ]; then
      notify "[$harness] Worker degraded: idle for $((idle_seconds / 60))min" "Harness Readiness" 2>/dev/null || true
    fi
  else
    emit_metric "readiness" "harness=$harness" "status=healthy" "idle_seconds=$idle_seconds"
  fi
}

# ══════════════════════════════════════════════════════════════════
# Stuck detection
# ══════════════════════════════════════════════════════════════════

check_stuck() {
  local harness="$1"
  local counter_file="/tmp/harness_stuck_${harness}"
  local nudge_file="/tmp/harness_stuck_nudges_${harness}"
  local pfile current_task worker_result worker_pane_id worker_pane capture last_line
  local idle_count nudge_count nudge_msg monitor_pane advisory

  # Check if harness has remaining tasks
  pfile=$(active_harness_progress "$harness")
  if [ ! -f "$pfile" ]; then
    return
  fi

  current_task=$(source "$HOME/.claude-ops/lib/harness-jq.sh" && harness_current_task "$pfile" 2>/dev/null || echo "ALL_DONE")
  if [ "$current_task" = "ALL_DONE" ]; then
    rm -f "$counter_file" "$nudge_file"
    return
  fi

  # Find worker pane and check if at prompt
  worker_result=$(find_worker_pane "$harness" 2>/dev/null || echo "")
  [ -z "$worker_result" ] && return
  worker_pane_id="${worker_result%%|*}"
  worker_pane="${worker_result#*|}"

  capture=$(tmux capture-pane -t "$worker_pane_id" -p 2>/dev/null || echo "")
  last_line=$(echo "$capture" | grep -v '^[[:space:]]*$' | tail -1)

  # Check for idle prompt (the Unicode prompt character or > at end of line)
  if echo "$last_line" | grep -qE '(❯|>)\s*$'; then
    # Worker is at prompt — increment idle counter
    idle_count=0
    if [ -f "$counter_file" ]; then
      idle_count=$(cat "$counter_file")
    fi
    idle_count=$(( idle_count + 1 ))
    echo "$idle_count" > "$counter_file"

    emit_metric "stuck" "harness=$harness" "idle_polls=$idle_count" "task=$current_task"

    if [ "$idle_count" -ge "$STUCK_IDLE_POLLS_THRESHOLD" ]; then
      nudge_count=0
      if [ -f "$nudge_file" ]; then
        nudge_count=$(cat "$nudge_file")
      fi

      if [ "$nudge_count" -ge "$STUCK_NUDGE_MAX" ]; then
        log "FORCE ROTATE [$harness] stuck after $STUCK_NUDGE_MAX nudges, rotating"
        emit_metric "stuck" "harness=$harness" "action=force_rotate" "nudges=$nudge_count"
        if [ "$DRY_RUN" = false ]; then
          advisory="/tmp/claude_rotation_advisory_${harness}"
          jq -n --arg reason "Stuck at prompt after $nudge_count nudges" \
            '{"should_rotate":true,"reason":$reason,"decided_at":(now | todate)}' > "$advisory"
          rm -f "$counter_file" "$nudge_file"
        fi
        return
      fi

      # Send nudge
      log "NUDGE [$harness] idle for $idle_count polls, nudging (attempt $((nudge_count + 1))/$STUCK_NUDGE_MAX)"
      emit_metric "stuck" "harness=$harness" "action=nudge" "nudge_count=$((nudge_count + 1))"

      if [ "$DRY_RUN" = false ]; then
        nudge_msg="[control-plane] You appear idle at the prompt. Current task: $current_task. Please continue working on it, or if stuck, explain what's blocking you."

        if [ "$STUCK_NUDGE_VIA" = "direct" ]; then
          # Send directly to worker pane (prefer stable pane_id)
          tmux send-keys -t "$worker_pane_id" -l "$nudge_msg" 2>/dev/null || true
          sleep 0.3
          tmux send-keys -t "$worker_pane_id" Enter 2>/dev/null || true
        else
          # Send to monitor pane (preferred — monitor decides how to handle)
          monitor_pane=$(find_monitor_pane "$harness" "$worker_pane_id" "$worker_pane" 2>/dev/null || echo "")
          if [ -n "$monitor_pane" ]; then
            tmux send-keys -t "$monitor_pane" -l "[control-plane] Worker $harness stuck at prompt for $idle_count polls. Task: $current_task. Please investigate." 2>/dev/null || true
            sleep 0.3
            tmux send-keys -t "$monitor_pane" Enter 2>/dev/null || true
          else
            # No monitor — fall back to direct nudge (prefer stable pane_id)
            tmux send-keys -t "$worker_pane_id" -l "$nudge_msg" 2>/dev/null || true
            sleep 0.3
            tmux send-keys -t "$worker_pane_id" Enter 2>/dev/null || true
          fi
        fi

        nudge_count=$(( nudge_count + 1 ))
        echo "$nudge_count" > "$nudge_file"
        echo "0" > "$counter_file"  # reset idle counter after nudge
      fi
    fi
  else
    # Worker is busy — reset counters
    if [ -f "$counter_file" ]; then
      rm -f "$counter_file" "$nudge_file"
    fi
  fi
}

# ══════════════════════════════════════════════════════════════════
# Reconciliation
# ══════════════════════════════════════════════════════════════════

reconcile_state() {
  local harness="$1"
  local pfile
  pfile=$(active_harness_progress "$harness")
  local current_task done_count total has_evolve tmp worker_pane

  [ ! -f "$pfile" ] && return

  source "$HOME/.claude-ops/lib/harness-jq.sh"

  current_task=$(harness_current_task "$pfile" 2>/dev/null || echo "ALL_DONE")
  done_count=$(harness_done_count "$pfile" 2>/dev/null || echo "0")
  total=$(harness_total_count "$pfile" 2>/dev/null || echo "0")

  emit_metric "reconcile" "harness=$harness" "current=$current_task" "done=$done_count" "total=$total"

  if [ "$current_task" = "ALL_DONE" ]; then
    log "[$harness] ALL_DONE ($done_count/$total tasks complete)"

    case "$RECONCILE_ALL_DONE_ACTION" in
      evolve)
        # Check if there's an evolve-harness task
        has_evolve=$(jq -r '.tasks["evolve-harness"] // empty' "$pfile" 2>/dev/null)
        if [ -n "$has_evolve" ]; then
          log "[$harness] Triggering evolve-harness"
          if [ "$DRY_RUN" = false ]; then
            notify "[$harness] All tasks complete. evolve-harness should run next cycle." "Harness Reconcile" 2>/dev/null || true
          fi
        else
          log "[$harness] All done, no evolve-harness task. Deactivating."
          if [ "$DRY_RUN" = false ]; then
            tmp=$(mktemp)
            jq '.status = "done"' "$pfile" > "$tmp" && mv "$tmp" "$pfile"
            notify "[$harness] Harness complete. All $total tasks done. Deactivated." "Harness Complete" 2>/dev/null || true
          fi
        fi
        ;;
      deactivate)
        log "[$harness] Deactivating (all done)"
        if [ "$DRY_RUN" = false ]; then
          tmp=$(mktemp)
          jq '.status = "done"' "$pfile" > "$tmp" && mv "$tmp" "$pfile"
          notify "[$harness] Harness complete. All $total tasks done." "Harness Complete" 2>/dev/null || true
        fi
        ;;
      notify)
        if [ "$DRY_RUN" = false ]; then
          notify "[$harness] All $total tasks complete. Awaiting instructions." "Harness Done" 2>/dev/null || true
        fi
        ;;
    esac
    return
  fi

  # Check if worker is idle but tasks remain
  local reconcile_worker_result
  reconcile_worker_result=$(find_worker_pane "$harness" 2>/dev/null || echo "")
  if [ -z "$reconcile_worker_result" ] && [ "$RECONCILE_IDLE_ACTION" = "nudge" ]; then
    log "RECONCILE [$harness] no worker found but $((total - done_count)) tasks remain"
    emit_metric "reconcile" "harness=$harness" "issue=no_worker" "remaining=$((total - done_count))"
  fi
}

# ══════════════════════════════════════════════════════════════════
# Main loop
# ══════════════════════════════════════════════════════════════════

log "Control plane starting (PID $$, dry_run=$DRY_RUN)"
init_sweep_state

TICK=0
while true; do
  # Source config every tick (changes take effect immediately)
  if [ -f "$CONF" ]; then
    source "$CONF"
  else
    log "WARN: Config not found at $CONF, using defaults"
    TICK_INTERVAL=30
    LIVENESS_INTERVAL=120
    READINESS_INTERVAL=300
    STUCK_INTERVAL=300
    RECONCILE_INTERVAL=600
  fi

  TICK=$((TICK + 1))

  # ── Skip tick if no active harnesses ──
  ACTIVE_LIST=$(active_harness_names 2>/dev/null || true)
  if [ -z "$ACTIVE_LIST" ]; then
    [ $((TICK % 20)) -eq 0 ] && log "No active harnesses (tick $TICK), sleeping"
    sleep "$TICK_INTERVAL"
    continue
  fi

  # ── Reset per-tick health state ──
  reset_health_tick

  # ── 1. Liveness checks ──
  if should_run "liveness" "$LIVENESS_INTERVAL"; then
    log "Running liveness checks (tick $TICK)"
    for harness in $(active_harness_names); do
      check_worker_alive "$harness"
      check_monitor_alive "$harness"
      check_daemon_alive "$harness"
    done
    write_health_json
    record_last_run "liveness"
  fi

  # ── 2. Readiness checks ──
  if should_run "readiness" "$READINESS_INTERVAL"; then
    log "Running readiness checks (tick $TICK)"
    for harness in $(active_harness_names); do
      check_worker_readiness "$harness"
    done
    record_last_run "readiness"
  fi

  # ── 2b. Stuck detection ──
  if should_run "stuck" "$STUCK_INTERVAL"; then
    log "Running stuck detection (tick $TICK)"
    for harness in $(active_harness_names); do
      check_stuck "$harness"
    done
    record_last_run "stuck"
  fi

  # ── 3. Sweeps (modular, each has its own interval) ──
  if [ -d "$HOME/.claude-ops/sweeps.d" ]; then
    for sweep in "$HOME/.claude-ops/sweeps.d"/*.sh; do
      [ -f "$sweep" ] || continue
      sweep_name=$(basename "$sweep" .sh)

      # Map sweep name to SWEEP_ENABLED var
      # e.g. claude-md-cleanup -> SWEEP_ENABLED_CLAUDE_MD_CLEANUP
      enabled_var="SWEEP_ENABLED_$(echo "$sweep_name" | tr '[:lower:]-' '[:upper:]_')"
      if eval "[ \"\${$enabled_var:-true}\" != true ]"; then
        continue
      fi

      # Get interval from sweep script
      sweep_interval=$(bash "$sweep" --interval 2>/dev/null || echo "600")

      if should_run "sweep_${sweep_name}" "$sweep_interval"; then
        log "Running sweep: $sweep_name"
        # Check sweep scope: "global" runs once, "per-harness" runs per harness
        sweep_scope=$(bash "$sweep" --scope 2>/dev/null || echo "per-harness")
        if [ "$DRY_RUN" = true ]; then
          if [ "$sweep_scope" = "global" ]; then
            log "DRY-RUN: would run $sweep --run once (global scope)"
          else
            log "DRY-RUN: would run $sweep --run for each active harness (per-harness scope)"
          fi
        else
          if [ "$sweep_scope" = "global" ]; then
            # Global sweeps run once with --project pointing to the first active harness's project
            first_project=$(harness_project_root "$(active_harness_names | head -1)" 2>/dev/null || echo "")
            if [ -n "$first_project" ]; then
              bash "$sweep" --run --project "$first_project" >> "$METRICS_FILE" 2>&1 || true
            fi
          else
            # Per-harness sweeps run once per active harness
            for harness in $(active_harness_names); do
              bash "$sweep" --run --harness "$harness" >> "$METRICS_FILE" 2>&1 || true
            done
          fi
        fi
        record_last_run "sweep_${sweep_name}"
      fi
    done
  fi

  # ── 4. Reconciliation ──
  if should_run "reconcile" "$RECONCILE_INTERVAL"; then
    log "Running reconciliation (tick $TICK)"
    for harness in $(active_harness_names); do
      reconcile_state "$harness"
    done
    record_last_run "reconcile"
  fi

  # ── Dry run: exit after one tick ──
  if [ "$DRY_RUN" = true ]; then
    log "Dry run complete. Exiting."
    rm -f "$PID_FILE"
    exit 0
  fi

  sleep "$TICK_INTERVAL"
done
