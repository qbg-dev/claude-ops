#!/usr/bin/env bash
# 07-dead-agent-detector.sh — Liveness probe for all registered harness agents.
#
# Checks all registered sessions for liveness by verifying tmux pane
# existence and Claude process health. Dead agents can be auto-restarted
# via handoff.sh. Also checks monitor daemon health.
#
# Contract:
#   --interval         Print interval in seconds and exit
#   --check            Dry-run, print what would change as JSON lines
#   --run              Execute and print JSON lines to stdout
#   --project <path>   Target a specific project
set -euo pipefail

SWEEP_NAME="dead-agent-detector"
source "$HOME/.claude-ops/lib/sweep-config.sh"
load_sweep_config "$SWEEP_NAME"

PROJECT_ROOT=""
DRY_RUN=false
MODE=""

HARNESS_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) echo "$SWEEP_INTERVAL"; exit 0 ;;
    --scope)    echo "$SWEEP_SCOPE"; exit 0 ;;
    --check)    DRY_RUN=true; MODE="check"; shift ;;
    --run)      MODE="run"; shift ;;
    --project)  PROJECT_ROOT="$2"; shift 2 ;;
    --harness)  HARNESS_NAME="$2"; shift 2 ;;
    *)          echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "Usage: $0 --interval | --check | --run [--harness <name>|--project <path>]" >&2
  exit 1
fi

# Resolve PROJECT_ROOT: --harness (via manifest) > --project > default
if [ -n "$HARNESS_NAME" ] && [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT=$(harness_project_root "$HARNESS_NAME" 2>/dev/null)
fi
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="/Users/wz/Desktop/zPersonalProjects/Wechat"
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── Load config ──────────────────────────────────────────────────────────
LIVENESS_AUTO_RESTART=false
LIVENESS_NOTIFY=true
LIVENESS_MAX_RESTARTS=3

CONFIG="$HOME/.claude-ops/control-plane.conf"
if [ -f "$CONFIG" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG"
fi

source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY="$HARNESS_SESSION_REGISTRY"

if [ ! -f "$REGISTRY" ]; then
  printf '{"ts":"%s","type":"sweep","name":"%s","action":"skip","reason":"no registry"}\n' \
    "$(ts)" "$SWEEP_NAME"
  exit 0
fi

if ! tmux list-sessions >/dev/null 2>&1; then
  printf '{"ts":"%s","type":"sweep","name":"%s","action":"skip","reason":"no tmux server"}\n' \
    "$(ts)" "$SWEEP_NAME"
  exit 0
fi

# Cache all pane info once
ALL_PANES=$(tmux list-panes -a -F '#{pane_id} #{pane_pid} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || echo "")
ALL_PANE_IDS=$(echo "$ALL_PANES" | awk '{print $1}')

# ── Helper: find pane for a session ID ───────────────────────────────────
find_pane_for_session() {
  local sid="$1"

  # Method 1: Check /tmp/tmux_pane_session_* files
  for sf in /tmp/tmux_pane_session_*; do
    [ -e "$sf" ] || continue
    if jq -e --arg sid "$sid" 'select(.session_id == $sid)' "$sf" >/dev/null 2>&1; then
      local pane_id
      pane_id=$(basename "$sf" | sed 's/^tmux_pane_session_//')
      # Verify pane still exists
      if echo "$ALL_PANE_IDS" | grep -qF "$pane_id"; then
        echo "$pane_id"
        return 0
      fi
    fi
  done

  # Method 2: Scan pane content for session ID (expensive, last resort)
  while IFS=' ' read -r pane_id pane_pid pane_target; do
    [ -z "$pane_id" ] && continue
    if tmux capture-pane -t "$pane_id" -p -S -20 2>/dev/null | grep -qF "$sid"; then
      echo "$pane_id"
      return 0
    fi
  done <<< "$ALL_PANES"

  return 1
}

# ── Helper: check if Claude process is running in a pane ─────────────────
pane_has_claude() {
  local pane_id="$1"
  local pane_pid
  pane_pid=$(echo "$ALL_PANES" | awk -v pid="$pane_id" '$1 == pid {print $2; exit}')
  [ -z "$pane_pid" ] && return 1

  # Check for claude or node (Claude Code runs as node) child processes
  if pgrep -P "$pane_pid" -f "claude" >/dev/null 2>&1; then
    return 0
  fi
  # Also check grandchildren (claude may be child of shell which is child of pane)
  for child in $(pgrep -P "$pane_pid" 2>/dev/null || true); do
    if pgrep -P "$child" -f "claude" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# ── Helper: get human-readable pane target ───────────────────────────────
pane_target() {
  local pane_id="$1"
  echo "$ALL_PANES" | awk -v pid="$pane_id" '$1 == pid {print $3; exit}'
}

# ── Helper: get/increment restart count ──────────────────────────────────
get_restart_count() {
  local harness="$1"
  local count_file="/tmp/harness_restarts_${harness}.count"
  if [ -f "$count_file" ]; then
    cat "$count_file" | tr -d '[:space:]'
  else
    echo "0"
  fi
}

increment_restart_count() {
  local harness="$1"
  local count_file="/tmp/harness_restarts_${harness}.count"
  local current
  current=$(get_restart_count "$harness")
  echo $(( current + 1 )) > "$count_file"
}

# ── 0. Registry rebuild fallback ────────────────────────────────────────
# If registry is empty but pane metadata files exist with harness info, rebuild
REGISTRY_COUNT=$(jq 'length' "$REGISTRY" 2>/dev/null || echo "0")
if [ "$REGISTRY_COUNT" = "0" ]; then
  REBUILT=0
  for meta_file in /tmp/tmux_pane_meta_*; do
    [ -e "$meta_file" ] || continue
    META_HARNESS=$(jq -r '.harness // empty' "$meta_file" 2>/dev/null || true)
    [ -z "$META_HARNESS" ] && continue
    PANE_ID=$(basename "$meta_file" | sed 's/^tmux_pane_meta_//')
    if echo "$ALL_PANE_IDS" | grep -qF "$PANE_ID"; then
      SESSION_FILE="/tmp/tmux_pane_session_${PANE_ID}"
      if [ -f "$SESSION_FILE" ]; then
        SID=$(jq -r '.session_id // empty' "$SESSION_FILE" 2>/dev/null || true)
        if [ -n "$SID" ]; then
          if [ "$DRY_RUN" = true ]; then
            printf '{"ts":"%s","type":"sweep","name":"%s","action":"would_rebuild_registry","session":"%s","harness":"%s"}\n' \
              "$(ts)" "$SWEEP_NAME" "$SID" "$META_HARNESS"
          else
            TMP=$(mktemp)
            jq --arg sid "$SID" --arg harness "$META_HARNESS" \
              '. + {($sid): $harness}' "$REGISTRY" > "$TMP" && mv "$TMP" "$REGISTRY"
            printf '{"ts":"%s","type":"sweep","name":"%s","action":"rebuilt_registry","session":"%s","harness":"%s"}\n' \
              "$(ts)" "$SWEEP_NAME" "$SID" "$META_HARNESS"
            REBUILT=$((REBUILT + 1))
          fi
        fi
      fi
    fi
  done
  [ "$REBUILT" -gt 0 ] && printf '{"ts":"%s","type":"sweep","name":"%s","action":"registry_rebuilt","count":%d}\n' \
    "$(ts)" "$SWEEP_NAME" "$REBUILT"
fi

# ── 1. Check registered sessions ────────────────────────────────────────
SESSION_IDS=$(jq -r 'to_entries[] | "\(.key) \(.value)"' "$REGISTRY" 2>/dev/null || echo "")

while IFS=' ' read -r sid harness; do
  [ -z "$sid" ] && continue
  [ -z "$harness" ] && harness="unknown"

  # Find pane
  PANE_ID=$(find_pane_for_session "$sid" 2>/dev/null || echo "")
  TARGET=$([ -n "$PANE_ID" ] && pane_target "$PANE_ID" || echo "none")

  if [ -z "$PANE_ID" ]; then
    # Pane not found at all
    RESTART_COUNT=$(get_restart_count "$harness")

    if [ "$DRY_RUN" = true ]; then
      printf '{"ts":"%s","type":"health","harness":"%s","component":"worker","status":"dead","reason":"pane_not_found","session":"%s","action":"would_restart","restart_count":%s}\n' \
        "$(ts)" "$harness" "$sid" "$RESTART_COUNT"
    else
      printf '{"ts":"%s","type":"health","harness":"%s","component":"worker","status":"dead","reason":"pane_not_found","session":"%s"}\n' \
        "$(ts)" "$harness" "$sid"

      # Notify
      if [ "$LIVENESS_NOTIFY" = true ] && command -v notify >/dev/null 2>&1; then
        if [ "$RESTART_COUNT" -lt "$LIVENESS_MAX_RESTARTS" ] && [ "$LIVENESS_AUTO_RESTART" = true ]; then
          notify "Dead agent: ${harness} -- restarting (attempt $((RESTART_COUNT + 1)))" "Agent Health" 2>/dev/null || true
        else
          notify "Dead agent: ${harness} -- max restarts reached ($RESTART_COUNT/$LIVENESS_MAX_RESTARTS)" "Agent Health" 2>/dev/null || true
        fi
      fi

      # Auto-restart if enabled and under limit
      if [ "$LIVENESS_AUTO_RESTART" = true ] && [ "$RESTART_COUNT" -lt "$LIVENESS_MAX_RESTARTS" ]; then
        # Guard: skip if handoff is already in progress for this harness
        # (handoff writes a pending file; rotation lock is per-session)
        if ls /tmp/claude_harness_pending_${harness} >/dev/null 2>&1 || ls /tmp/claude_harness_rotate_* 2>/dev/null | xargs grep -l "\"$harness\"" >/dev/null 2>&1; then
          printf '{"ts":"%s","type":"restart","harness":"%s","component":"worker","reason":"pane_not_found","action":"skipped_handoff_in_progress"}\n' \
            "$(ts)" "$harness"
        else
          increment_restart_count "$harness"
          printf '{"ts":"%s","type":"restart","harness":"%s","component":"worker","reason":"pane_not_found","attempt":%d}\n' \
            "$(ts)" "$harness" "$((RESTART_COUNT + 1))"

          # Launch restart in background
          if [ -f "$HOME/.claude-ops/lib/handoff.sh" ]; then
            bash "$HOME/.claude-ops/lib/handoff.sh" --harness "$harness" &
            disown $! 2>/dev/null || true
          fi
        fi
      fi
    fi
    continue
  fi

  # Pane exists — check if Claude is running
  if pane_has_claude "$PANE_ID"; then
    printf '{"ts":"%s","type":"health","harness":"%s","component":"worker","status":"alive","pane":"%s"}\n' \
      "$(ts)" "$harness" "$TARGET"
  else
    # Pane exists but no Claude process
    RESTART_COUNT=$(get_restart_count "$harness")

    if [ "$DRY_RUN" = true ]; then
      printf '{"ts":"%s","type":"health","harness":"%s","component":"worker","status":"dead","reason":"dead_process","pane":"%s","action":"would_restart","restart_count":%s}\n' \
        "$(ts)" "$harness" "$TARGET" "$RESTART_COUNT"
    else
      printf '{"ts":"%s","type":"health","harness":"%s","component":"worker","status":"dead","reason":"dead_process","pane":"%s"}\n' \
        "$(ts)" "$harness" "$TARGET"

      # Notify
      if [ "$LIVENESS_NOTIFY" = true ] && command -v notify >/dev/null 2>&1; then
        if [ "$RESTART_COUNT" -lt "$LIVENESS_MAX_RESTARTS" ] && [ "$LIVENESS_AUTO_RESTART" = true ]; then
          notify "Dead agent: ${harness} in ${TARGET} -- restarting (attempt $((RESTART_COUNT + 1)))" "Agent Health" 2>/dev/null || true
        else
          notify "Dead agent: ${harness} in ${TARGET} -- max restarts reached" "Agent Health" 2>/dev/null || true
        fi
      fi

      # Auto-restart
      if [ "$LIVENESS_AUTO_RESTART" = true ] && [ "$RESTART_COUNT" -lt "$LIVENESS_MAX_RESTARTS" ]; then
        # Guard: skip if handoff is already in progress for this harness
        if ls /tmp/claude_harness_pending_${harness} >/dev/null 2>&1 || ls /tmp/claude_harness_rotate_* 2>/dev/null | xargs grep -l "\"$harness\"" >/dev/null 2>&1; then
          printf '{"ts":"%s","type":"restart","harness":"%s","component":"worker","reason":"dead_process","action":"skipped_handoff_in_progress","pane":"%s"}\n' \
            "$(ts)" "$harness" "$TARGET"
        else
          increment_restart_count "$harness"
          printf '{"ts":"%s","type":"restart","harness":"%s","component":"worker","reason":"dead_process","attempt":%d,"pane":"%s"}\n' \
            "$(ts)" "$harness" "$((RESTART_COUNT + 1))" "$TARGET"

          # Launch restart in background using handoff
          if [ -f "$HOME/.claude-ops/lib/handoff.sh" ]; then
            bash "$HOME/.claude-ops/lib/handoff.sh" --harness "$harness" &
            disown $! 2>/dev/null || true
          fi
        fi
      fi
    fi
  fi
done <<< "$SESSION_IDS"

# ── 2. Check monitor daemons ────────────────────────────────────────────
for pid_file in /tmp/monitor-agent-*/daemon.pid; do
  [ -e "$pid_file" ] || continue

  MONITOR_DIR=$(dirname "$pid_file")
  MONITOR_NAME=$(basename "$MONITOR_DIR")
  # Enrich display: include worker target if available
  if [ -f "$MONITOR_DIR/worker-target" ]; then
    MONITOR_NAME="${MONITOR_NAME}($(cat "$MONITOR_DIR/worker-target" 2>/dev/null))"
  fi
  MONITOR_PID=$(cat "$pid_file" 2>/dev/null | tr -d '[:space:]')

  if [ -z "$MONITOR_PID" ]; then
    printf '{"ts":"%s","type":"health","harness":"%s","component":"monitor","status":"dead","reason":"empty_pid_file"}\n' \
      "$(ts)" "$MONITOR_NAME"
    continue
  fi

  if kill -0 "$MONITOR_PID" 2>/dev/null; then
    printf '{"ts":"%s","type":"health","harness":"%s","component":"monitor","status":"alive","pid":%s}\n' \
      "$(ts)" "$MONITOR_NAME" "$MONITOR_PID"
  else
    if [ "$DRY_RUN" = true ]; then
      printf '{"ts":"%s","type":"health","harness":"%s","component":"monitor","status":"dead","reason":"process_gone","pid":%s,"action":"would_warn"}\n' \
        "$(ts)" "$MONITOR_NAME" "$MONITOR_PID"
    else
      printf '{"ts":"%s","type":"health","harness":"%s","component":"monitor","status":"dead","reason":"process_gone","pid":%s}\n' \
        "$(ts)" "$MONITOR_NAME" "$MONITOR_PID"

      if [ "$LIVENESS_NOTIFY" = true ] && command -v notify >/dev/null 2>&1; then
        notify "Dead monitor: ${MONITOR_NAME} (PID ${MONITOR_PID} gone)" "Monitor Health" 2>/dev/null || true
      fi
    fi
  fi
done

exit 0
