#!/usr/bin/env bash
# harness-launch.sh — Launch a harness worker + optional monitor in tmux.
#
# Provides harness_launch() which:
#   1. Creates a new tmux window named after the harness (in session h:)
#   2. Launches cdo (Claude Opus, bypass permissions) in the left pane
#   3. Waits for Claude to be ready
#   4. Sends the seed prompt
#   5. Optionally splits and launches a monitor in the right pane
#
# Usage (source then call):
#   source ~/.claude-ops/lib/harness-launch.sh
#   harness_launch <harness-name> <project-root> [--monitor] [--model opus|sonnet|haiku]
#
# Environment:
#   TMUX_SESSION  — tmux session name (default: "h")
#   CLAUDE_CMD    — claude command (default: "cdo")
#   MONITOR_INTERVAL — poll interval in seconds (default: 120)
#
# The function exports:
#   WORKER_PANE   — pane ID of the worker (e.g. h:redteam.0)
#   MONITOR_PANE  — pane ID of the monitor (if --monitor), empty otherwise

set -euo pipefail

TMUX_SESSION="${TMUX_SESSION:-h}"
CLAUDE_CMD="${CLAUDE_CMD:-cdo}"
MONITOR_INTERVAL="${MONITOR_INTERVAL:-120}"

harness_launch() {
  local harness="${1:?Usage: harness_launch <harness-name> <project-root> [--monitor] [--model opus|sonnet|haiku]}"
  local project_root="${2:?Usage: harness_launch <harness-name> <project-root> [--monitor] [--model opus|sonnet|haiku]}"
  shift 2

  local with_monitor=false
  local model="opus"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --monitor)     with_monitor=true; shift ;;
      --model)       model="$2"; shift 2 ;;
      *)             echo "Unknown option: $1" >&2; return 1 ;;
    esac
  done

  # Resolve claude command from model — but only if CLAUDE_CMD wasn't
  # explicitly set by the caller (e.g., from progress.json rotation.claude_command).
  # This allows harnesses to use custom commands like cdoc (Chrome-enabled).
  if [ "$CLAUDE_CMD" = "cdo" ] || [ -z "$CLAUDE_CMD" ]; then
    case "$model" in
      opus)   CLAUDE_CMD="cdo" ;;
      sonnet) CLAUDE_CMD="cds" ;;
      haiku)  CLAUDE_CMD="cdh" ;;
    esac
  fi

  local seed_script="$project_root/.claude/scripts/${harness}-seed.sh"
  local start_script="$project_root/.claude/scripts/${harness}-start.sh"

  if [ ! -f "$seed_script" ]; then
    echo "ERROR: Seed script not found: $seed_script" >&2
    return 1
  fi

  # ── Step 1: Create tmux window ────────────────────────────────
  # Kill existing window with same name (if present and empty)
  if tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -q "^${harness}$"; then
    local existing_pane
    existing_pane=$(tmux list-panes -t "${TMUX_SESSION}:${harness}" -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null | head -1)
    if [ -n "$existing_pane" ]; then
      local existing_pid
      existing_pid=$(tmux display-message -t "$existing_pane" -p '#{pane_pid}' 2>/dev/null || echo "")
      local has_claude=false
      if [ -n "$existing_pid" ]; then
        for cpid in $(pgrep -P "$existing_pid" 2>/dev/null | head -3); do
          if ps -o command= -p "$cpid" 2>/dev/null | grep -q "claude"; then
            has_claude=true
          fi
        done
      fi
      if [ "$has_claude" = true ]; then
        echo "ERROR: Window '${harness}' already has a running Claude session." >&2
        echo "  Pane: $existing_pane" >&2
        echo "  Kill it first or use a different name." >&2
        return 1
      fi
    fi
    # Window exists but no Claude — kill and recreate
    tmux kill-window -t "${TMUX_SESSION}:${harness}" 2>/dev/null || true
  fi

  # Create fresh window (-d to not steal focus)
  tmux new-window -d -t "$TMUX_SESSION" -n "$harness" -c "$project_root"
  echo "Created tmux window: ${TMUX_SESSION}:${harness}"

  # Get the worker pane ID
  WORKER_PANE=$(tmux list-panes -t "${TMUX_SESSION}:${harness}" -F '#{session_name}:#{window_index}.#{pane_index}' | head -1)
  echo "Worker pane: $WORKER_PANE"

  # ── Step 2: Update progress.json directly ─────────────────────
  # NOTE: Do NOT call start.sh here — start.sh calls harness_launch(),
  # so calling start.sh from here creates infinite recursion (caused
  # session_count to hit 566). Instead, update progress inline.
  local progress="$project_root/claude_files/${harness}-progress.json"
  if [ -f "$progress" ]; then
    local tmp
    tmp=$(mktemp)
    jq '
      .status = "active" |
      .session_count = (.session_count // 0) + 1 |
      .current_session.started_at = now |
      .current_session.round_count = 0 |
      .current_session.tasks_completed = 0
    ' "$progress" > "$tmp" && mv "$tmp" "$progress"
  fi

  # ── Step 3: Launch Claude in worker pane ──────────────────────
  tmux send-keys -t "$WORKER_PANE" "$CLAUDE_CMD" Enter

  echo "Waiting for Claude to load..."
  local loaded=false
  for i in $(seq 1 45); do
    sleep 2
    if tmux capture-pane -t "$WORKER_PANE" -p 2>/dev/null | grep -q "bypass permissions"; then
      echo "Claude loaded in ${WORKER_PANE} (~$((i*2))s)"
      loaded=true
      break
    fi
  done

  if [ "$loaded" = false ]; then
    echo "WARNING: Claude didn't show 'bypass permissions' in 90s — sending seed anyway" >&2
  fi

  # ── Step 4: Generate and send seed prompt ─────────────────────
  local seed
  seed=$(bash "$seed_script" 2>/dev/null)
  if [ -z "$seed" ]; then
    echo "ERROR: Seed script produced empty output" >&2
    return 1
  fi

  # Send seed as literal text, then Enter
  tmux send-keys -t "$WORKER_PANE" -l "$seed"
  sleep 0.5
  tmux send-keys -t "$WORKER_PANE" Enter
  echo "Seed prompt sent ($(echo "$seed" | wc -c | tr -d ' ') bytes)"

  # ── Step 5: Register session ──────────────────────────────────
  # Wait a moment for Claude to create its session file, then register
  (
    sleep 15
    local session_id
    session_id=$(tmux capture-pane -t "$WORKER_PANE" -p 2>/dev/null | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    if [ -n "$session_id" ]; then
      source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
      local registry="$HARNESS_SESSION_REGISTRY"
      [ ! -f "$registry" ] && echo '{}' > "$registry"
      local tmp
      tmp=$(mktemp)
      jq --arg s "$session_id" --arg h "$harness" '.[$s] = $h' "$registry" > "$tmp" && mv "$tmp" "$registry"
    fi
  ) &

  # ── Step 6: Optionally launch monitor ─────────────────────────
  MONITOR_PANE=""
  if [ "$with_monitor" = true ]; then
    # Split the worker window horizontally (worker left, monitor right)
    tmux split-window -d -t "$WORKER_PANE" -h -c "$project_root"

    # Get the new pane (the rightmost one)
    MONITOR_PANE=$(tmux list-panes -t "${TMUX_SESSION}:${harness}" -F '#{session_name}:#{window_index}.#{pane_index}' | tail -1)
    echo "Monitor pane: $MONITOR_PANE"

    # Launch monitor agent with explicit --pane to avoid active-pane confusion
    tmux send-keys -t "$MONITOR_PANE" \
      "bash ~/.claude-ops/scripts/monitor-agent.sh --pane $MONITOR_PANE $WORKER_PANE $MONITOR_INTERVAL '$harness orchestrator'" \
      Enter

    echo "Monitor launched in $MONITOR_PANE targeting $WORKER_PANE (${MONITOR_INTERVAL}s interval)"
  fi

  # ── Step 7: Verify ────────────────────────────────────────────
  sleep 5
  local worker_status
  worker_status=$(tmux capture-pane -t "$WORKER_PANE" -p 2>/dev/null | grep -c '⏺\|Razzle\|Booping\|thinking\|Reading' || true)
  if [ "$worker_status" -gt 0 ]; then
    echo ""
    echo "=== $harness harness launched successfully ==="
    echo "  Worker: $WORKER_PANE"
    [ -n "$MONITOR_PANE" ] && echo "  Monitor: $MONITOR_PANE"
  else
    echo ""
    echo "=== $harness harness launched (verify manually) ==="
    echo "  Worker: $WORKER_PANE (check: tmux capture-pane -t $WORKER_PANE -p | tail -10)"
    [ -n "$MONITOR_PANE" ] && echo "  Monitor: $MONITOR_PANE"
  fi

  # Export for caller
  export WORKER_PANE MONITOR_PANE
}

# Also provide a quick status check function
harness_status() {
  local harness="${1:?Usage: harness_status <harness-name>}"

  echo "=== $harness status ==="

  # Find window
  if ! tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -q "^${harness}$"; then
    echo "  No tmux window found for $harness"
    return 1
  fi

  # List panes
  local panes
  panes=$(tmux list-panes -t "${TMUX_SESSION}:${harness}" -F '#{session_name}:#{window_index}.#{pane_index} #{pane_title}')
  echo "$panes" | while IFS=' ' read -r pane title; do
    local cost
    cost=$(tmux capture-pane -t "$pane" -p 2>/dev/null | grep -oE '\$[0-9]+\.[0-9]+' | tail -1 || echo "?")
    local activity
    activity=$(tmux capture-pane -t "$pane" -p 2>/dev/null | grep -cE '⏺|Razzle|Booping|thinking|Reading|Running' || true)
    local state="idle"
    [ "$activity" -gt 0 ] && state="active"
    echo "  $pane ($title): $state, cost: $cost"
  done
}
