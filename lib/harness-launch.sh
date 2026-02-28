#!/usr/bin/env bash
# harness-launch.sh — Launch a harness worker + optional monitor in tmux.
#
# Provides harness_launch() which:
#   1. Creates a new tmux window named after the harness (in current tmux session)
#   2. Launches Claude (default: Opus + Chrome, permissions from JSON) in the left pane
#   3. Waits for Claude to be ready
#   4. Sends the seed prompt
#   5. Optionally splits and launches a monitor in the right pane
#
# Usage (source then call):
#   source ~/.boring/lib/harness-launch.sh
#   harness_launch <harness-name> <project-root> [--monitor] [--model opus|sonnet|haiku] [--session h]
#
# Environment:
#   TMUX_SESSION  — tmux session name (default: current session, fallback: "h")
#   CLAUDE_CMD    — claude command (default: full command with --model opus --chrome)
#   MONITOR_INTERVAL — poll interval in seconds (default: 120)
#
# The function exports:
#   WORKER_PANE   — pane ID of the worker (e.g. h:redteam.0)
#   MONITOR_PANE  — pane ID of the monitor (if --monitor), empty otherwise

set -euo pipefail

# Default to current tmux session if inside tmux, otherwise "h"
if [ -z "${TMUX_SESSION:-}" ]; then
  TMUX_SESSION=$(tmux display-message -t "${TMUX_PANE:-.}" -p '#{session_name}' 2>/dev/null || echo "h")
fi
CLAUDE_CMD="${CLAUDE_CMD:-claude --dangerously-skip-permissions --model opus --chrome}"
MONITOR_INTERVAL="${MONITOR_INTERVAL:-180}"

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
      --session)     TMUX_SESSION="$2"; shift 2 ;;
      *)             echo "Unknown option: $1" >&2; return 1 ;;
    esac
  done

  # ── Resolve permissions from permissions.json ────────────────
  # Reads sidecar permissions (self-sidecar agents use this too).
  # Fields: permission_mode, model, allowedTools[], disallowedTools[], tools[], addDirs[]
  # Check module-manager first (v3 harnesses), fall back to sidecar (v2 legacy)
  local perms_json="$project_root/.claude/harness/${harness}/agents/module-manager/permissions.json"
  [ ! -f "$perms_json" ] && perms_json="$project_root/.claude/harness/${harness}/agents/sidecar/permissions.json"
  local perm_mode="bypassPermissions"
  local perm_allowed_tools=""
  local perm_tools=""
  local perm_add_dirs=""

  if [ -f "$perms_json" ]; then
    perm_mode=$(jq -r '.permission_mode // "bypassPermissions"' "$perms_json")
    local _model; _model=$(jq -r '.model // empty' "$perms_json"); [ -n "$_model" ] && model="$_model"
    perm_allowed_tools=$(jq -r '(.allowedTools // []) | join(",")' "$perms_json")
    # disallowedTools enforced by tool-policy-gate.sh PreToolUse hook
    perm_tools=$(jq -r '(.tools // []) | join(",")' "$perms_json")
    perm_add_dirs=$(jq -r '(.addDirs // []) | join(",")' "$perms_json")
  fi

  # ── Also check identity.json for model override ────────────
  for _id_slot in sidecar coordinator; do
    local _identity="$project_root/.claude/harness/$harness/agents/$_id_slot/identity.json"
    if [ -f "$_identity" ]; then
      local id_model
      id_model=$(jq -r '.model // empty' "$_identity" 2>/dev/null)
      [ -n "$id_model" ] && model="$id_model"
      break
    fi
  done

  # Build CLI flags from parsed permissions
  local perm_flags=""
  case "$perm_mode" in
    bypassPermissions) perm_flags="--dangerously-skip-permissions" ;;
    acceptEdits)       perm_flags="--permission-mode acceptEdits" ;;
    default)           perm_flags="" ;;
    dontAsk)           perm_flags="--permission-mode dontAsk" ;;
    plan)              perm_flags="--permission-mode plan" ;;
    *)                 perm_flags="--dangerously-skip-permissions" ;;
  esac
  [ -n "$perm_allowed_tools" ]    && perm_flags="$perm_flags --allowedTools $perm_allowed_tools"
  # disallowedTools is now enforced by tool-policy-gate.sh PreToolUse hook — no CLI flag needed
  [ -n "$perm_tools" ]            && perm_flags="$perm_flags --tools $perm_tools"
  [ -n "$perm_add_dirs" ]         && perm_flags="$perm_flags --add-dir $perm_add_dirs"

  # Resolve claude command from model — but only if CLAUDE_CMD wasn't
  # explicitly set by the caller (e.g., from progress.json rotation.claude_command).
  # This allows harnesses to use custom commands like cdoc (Chrome-enabled).
  local default_cmd="claude --dangerously-skip-permissions --model opus --chrome"
  if [ "$CLAUDE_CMD" = "$default_cmd" ] || [ -z "$CLAUDE_CMD" ]; then
    CLAUDE_CMD="claude ${perm_flags} --model ${model} --chrome"
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
        # Idempotent mode: worker-dispatch callers expect silent success
        if [ "${WORKER_DISPATCH_IDEMPOTENT:-}" = "true" ]; then
          WORKER_PANE="$existing_pane"
          export WORKER_PANE
          return 0
        fi
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

  # Get the worker pane ID (both human-readable and stable pane_id)
  WORKER_PANE=$(tmux list-panes -t "${TMUX_SESSION}:${harness}" -F '#{session_name}:#{window_index}.#{pane_index}' | head -1)
  WORKER_PANE_ID=$(tmux display-message -t "$WORKER_PANE" -p '#{pane_id}' 2>/dev/null || echo "")
  echo "Worker pane: $WORKER_PANE ($WORKER_PANE_ID)"

  # ── Register worker pane in pane-registry ─────────────────────
  # Pane-registry.json is the sole source of truth (Tier 0 for all hooks).
  # Session-registry.json is deprecated — no new writes.
  if [ -n "$WORKER_PANE_ID" ]; then
    source "$HOME/.boring/lib/harness-jq.sh" 2>/dev/null || true

    # Primary: pane-registry.json (Tier 0 — all hooks read this)
    pane_registry_update "$WORKER_PANE_ID" "$harness" "launching" "0" "0" "${harness}: launching" "$WORKER_PANE"
  fi

  # ── Step 2: Update progress.json directly ─────────────────────
  # NOTE: Do NOT call start.sh here — start.sh calls harness_launch(),
  # so calling start.sh from here creates infinite recursion (caused
  # session_count to hit 566). Instead, update progress inline.
  # v3: pass tasks.json — harness_bump_session resolves state.json internally
  local progress="$project_root/.claude/harness/${harness}/tasks.json"
  if [ -f "$progress" ]; then
    harness_bump_session "$progress"
  fi

  # ── Step 3: Launch Claude in worker pane ──────────────────────
  # Use harness-loop.sh wrapper for ALL harnesses:
  #   - Bounded: runs Claude once, exits
  #   - Long-running: runs Claude, auto-resumes after 30min when agent stops
  # The loop script reads CLAUDE_CMD, HARNESS, PROJECT_ROOT from env.
  # First iteration's seed is sent by us (Step 4 below); subsequent seeds
  # are injected by the loop script itself.
  local loop_script="$HOME/.boring/lib/harness-loop.sh"
  if [ -f "$loop_script" ]; then
    tmux send-keys -t "$WORKER_PANE" "CLAUDE_CMD='$CLAUDE_CMD' HARNESS='$harness' PROJECT_ROOT='$project_root' bash $loop_script" Enter
  else
    # Fallback: launch directly if loop script missing
    tmux send-keys -t "$WORKER_PANE" "$CLAUDE_CMD" Enter
  fi

  echo "Waiting for Claude to load..."
  local loaded=false
  # Check for any Claude readiness indicator (works with all permission modes)
  for i in $(seq 1 45); do
    sleep 2
    local pane_text
    pane_text=$(tmux capture-pane -t "$WORKER_PANE" -p 2>/dev/null || true)
    if echo "$pane_text" | grep -qE "bypass permissions|permission mode|What can I help|Tips for|/help"; then
      echo "Claude loaded in ${WORKER_PANE} (~$((i*2))s)"
      loaded=true
      break
    fi
  done

  if [ "$loaded" = false ]; then
    echo "WARNING: Claude didn't show 'bypass permissions' in 90s — sending seed anyway" >&2
  fi

  # ── Step 4: Generate and send seed prompt ─────────────────────
  # HARNESS_LAUNCHED=1 tells the seed script it's safe to self-register
  # in pane-registry. Without this, interactive `bash seed.sh` would
  # poison the caller's pane with the harness name.
  local seed
  seed=$(HARNESS_LAUNCHED=1 bash "$seed_script" 2>/dev/null)
  if [ -z "$seed" ]; then
    echo "ERROR: Seed script produced empty output" >&2
    return 1
  fi

  # Send seed as literal text, then Enter
  tmux send-keys -t "$WORKER_PANE" -l "$seed"
  sleep 0.5
  tmux send-keys -t "$WORKER_PANE" Enter
  echo "Seed prompt sent ($(echo "$seed" | wc -c | tr -d ' ') bytes)"

  # ── Step 5: Optionally launch monitor ─────────────────────────
  MONITOR_PANE=""
  if [ "$with_monitor" = true ]; then
    # Split the worker window horizontally (worker left, monitor right)
    tmux split-window -d -t "$WORKER_PANE" -h -c "$project_root"

    # Get the new pane (the rightmost one)
    MONITOR_PANE=$(tmux list-panes -t "${TMUX_SESSION}:${harness}" -F '#{session_name}:#{window_index}.#{pane_index}' | tail -1)
    echo "Monitor pane: $MONITOR_PANE"

    # Launch monitor agent with explicit --pane to avoid active-pane confusion
    tmux send-keys -t "$MONITOR_PANE" \
      "bash ~/.boring/scripts/monitor-agent.sh --pane $MONITOR_PANE $WORKER_PANE $MONITOR_INTERVAL '$harness orchestrator'" \
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
