#!/usr/bin/env bash
# harness-watchdog.sh — Monitor flat workers via registry.json; detect crashes, respawn.
#
# Window-group aware: reads "window" from registry to place respawned workers
# into their correct tmux window (split + tiled layout).
#
# Runs as a background daemon (via launchd or cron).
# Every CHECK_INTERVAL seconds:
#   1. Read registry.json for all workers with pane_id set
#   2. For each: check pane alive
#   3. Classify: alive | dead (needs respawn)
#   4. Dead pane, window still exists → split-window into existing window + select-layout tiled
#   5. Dead pane, window gone → launch-flat-worker.sh (recreates everything)
#   6. Crash-loop guard: max MAX_CRASHES_PER_HR → stop retrying, notify
#
# Usage:
#   bash harness-watchdog.sh              # daemon mode (loops forever)
#   bash harness-watchdog.sh --once       # single-pass (for testing)
#   bash harness-watchdog.sh --status     # print current state table and exit
#
# Requirements:
#   - registry.json populated by launch-flat-worker.sh at startup

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────
CHECK_INTERVAL="${WATCHDOG_CHECK_INTERVAL:-30}"
MAX_CRASHES_PER_HR="${WATCHDOG_MAX_CRASHES:-3}"
LOG_FILE="${WATCHDOG_LOG:-${HOME}/.claude-ops/state/watchdog.log}"

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "/Users/wz/Desktop/zPersonalProjects/Wechat")}"
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"
CRASH_DIR="${HOME}/.claude-ops/state/watchdog-crashes"
LAUNCH_SCRIPT="${HOME}/.claude-ops/scripts/launch-flat-worker.sh"

MODE="daemon"
[ "${1:-}" = "--once" ]   && MODE="once"
[ "${1:-}" = "--status" ] && MODE="status"

# ── Logging ─────────────────────────────────────────────────────
mkdir -p "$(dirname "$LOG_FILE")" "$CRASH_DIR"
_log() { echo "[$(date -u +%FT%TZ)] watchdog: $*" | tee -a "$LOG_FILE" >&2; }

# ── Crash count management ────────────────────────────────────────
_crash_count_file() { echo "$CRASH_DIR/$1.json"; }

_increment_crash_count() {
  local worker="$1"
  local f; f=$(_crash_count_file "$worker")
  local now_ts; now_ts=$(date -u +%s)
  local hour_ago=$(( now_ts - 3600 ))

  local existing="[]"
  [ -f "$f" ] && existing=$(jq '.timestamps // []' "$f" 2>/dev/null || echo "[]")

  local updated
  updated=$(echo "$existing" | jq --argjson now "$now_ts" --argjson cutoff "$hour_ago" \
    '[.[] | select(. > $cutoff)] + [$now]')
  echo "{\"timestamps\":$updated}" > "$f"
  echo "$updated" | jq 'length'
}

_is_crash_looped() {
  local worker="$1"
  [ -f "$CRASH_DIR/${worker}.crash-loop" ]
}

# ── Check a single worker ──────────────────────────────────────────
check_worker() {
  local worker="$1"

  # Skip _config key
  [ "$worker" = "_config" ] && return

  # Read worker entry from registry
  local pane_id; pane_id=$(jq -r --arg n "$worker" '.[$n].pane_id // empty' "$REGISTRY" 2>/dev/null)
  [ -z "$pane_id" ] && return  # no pane registered

  # Skip crash-looped workers
  _is_crash_looped "$worker" && return

  # Check pane alive
  if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; then
    return  # alive, nothing to do
  fi

  # ── Pane is dead — respawn ──
  _log "DEAD: $worker (pane $pane_id)"

  # Crash-loop guard
  local crash_count; crash_count=$(_increment_crash_count "$worker")
  if [ "$crash_count" -ge "$MAX_CRASHES_PER_HR" ]; then
    touch "$CRASH_DIR/${worker}.crash-loop"
    _log "CRASH-LOOP: $worker — ${crash_count} crashes in last hour, stopping retries"
    notify "Crash loop: $worker (${crash_count} crashes/hr) — manual intervention needed" "Watchdog Alert" 2>/dev/null || true
    return
  fi

  # Read window and session from registry
  local window; window=$(jq -r --arg n "$worker" '.[$n].window // empty' "$REGISTRY" 2>/dev/null)
  local session; session=$(jq -r --arg n "$worker" '.[$n].tmux_session // "w"' "$REGISTRY" 2>/dev/null)
  local worktree; worktree=$(jq -r --arg n "$worker" '.[$n].worktree // empty' "$REGISTRY" 2>/dev/null)

  # Check if tmux session exists at all
  if ! tmux has-session -t "$session" 2>/dev/null; then
    _log "RESPAWN-FULL: $worker — session '$session' gone, using launch-flat-worker.sh"
    PROJECT_ROOT="$PROJECT_ROOT" bash "$LAUNCH_SCRIPT" "$worker" &
    return
  fi

  # Check if the window still exists
  if [ -n "$window" ] && tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$window"; then
    # Window exists — split into it + re-tile
    local new_pane
    local wt_dir="${worktree:-$PROJECT_ROOT}"
    new_pane=$(tmux split-window -t "$session:$window" -c "$wt_dir" -d -P -F '#{pane_id}')
    tmux select-layout -t "$session:$window" tiled
    tmux select-pane -T "$worker" -t "$new_pane"

    # Update registry with new pane info
    local new_target; new_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
      | awk -v p="$new_pane" '$1==p{print $2}' 2>/dev/null || echo "")
    _registry_update_pane "$worker" "$new_pane" "$new_target"

    # Re-launch Claude in the new pane
    _relaunch_claude "$worker" "$new_pane" "$wt_dir"

    _log "RESPAWN-SPLIT: $worker into window '$window' (pane $new_pane)"
  else
    # Window gone — full relaunch via launch-flat-worker.sh
    _log "RESPAWN-FULL: $worker — window '$window' gone, using launch-flat-worker.sh"
    PROJECT_ROOT="$PROJECT_ROOT" bash "$LAUNCH_SCRIPT" "$worker" &
  fi
}

# ── Registry update helper ────────────────────────────────────────
_registry_update_pane() {
  local worker="$1" pane_id="$2" pane_target="$3"
  local _LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.boring/state/locks}/worker-registry"
  mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
  local _WAIT=0
  while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
    sleep 0.5; _WAIT=$((_WAIT + 1))
    [ "$_WAIT" -ge 10 ] && break
  done
  local tmp; tmp=$(mktemp)
  jq --arg n "$worker" --arg pid "$pane_id" --arg target "$pane_target" \
    '.[$n].pane_id = $pid | .[$n].pane_target = $target' \
    "$REGISTRY" > "$tmp" 2>/dev/null && mv "$tmp" "$REGISTRY" || rm -f "$tmp"
  rmdir "$_LOCK_DIR" 2>/dev/null || true
}

# ── Re-launch Claude in a pane ────────────────────────────────────
_relaunch_claude() {
  local worker="$1" pane="$2" wt_dir="$3"

  # Read config from registry (cached from permissions.json at launch)
  local model; model=$(jq -r --arg n "$worker" '.[$n].model // "sonnet"' "$REGISTRY" 2>/dev/null)
  [ "$model" = "null" ] && model="sonnet"
  local perm_mode; perm_mode=$(jq -r --arg n "$worker" '.[$n].permission_mode // "bypassPermissions"' "$REGISTRY" 2>/dev/null)
  [ "$perm_mode" = "null" ] && perm_mode="bypassPermissions"
  local disallowed; disallowed=$(jq -r --arg n "$worker" '.[$n].disallowed_tools // [] | join(",")' "$REGISTRY" 2>/dev/null)

  local worker_dir="$PROJECT_ROOT/.claude/workers/$worker"

  # Build Claude command
  local claude_cmd="claude --model $model"
  [ "$perm_mode" = "bypassPermissions" ] && claude_cmd="$claude_cmd --dangerously-skip-permissions"
  [ -n "$disallowed" ] && claude_cmd="$claude_cmd --disallowed-tools \"$disallowed\""
  claude_cmd="$claude_cmd --add-dir $worker_dir"

  tmux send-keys -t "$pane" "cd $wt_dir"
  tmux send-keys -t "$pane" -H 0d
  sleep 1
  tmux send-keys -t "$pane" "$claude_cmd"
  tmux send-keys -t "$pane" -H 0d

  # Inject seed after Claude TUI starts
  (
    sleep 20  # wait for TUI
    if [ -f "${HOME}/.claude-ops/lib/worker-seed.sh" ]; then
      source "${HOME}/.claude-ops/lib/worker-seed.sh"
      local seed_file="/tmp/worker-${worker}-watchdog-seed.txt"
      local branch; branch=$(jq -r --arg n "$worker" '.[$n].branch // "worker/'"$worker"'"' "$REGISTRY" 2>/dev/null)
      generate_worker_seed "$worker" "$worker_dir" "$wt_dir" "$branch" "$PROJECT_ROOT" > "$seed_file"

      local buf="watchdog-${worker}-$$"
      tmux delete-buffer -b "$buf" 2>/dev/null || true
      tmux load-buffer -b "$buf" "$seed_file" 2>/dev/null || true
      tmux paste-buffer -b "$buf" -t "$pane" -d 2>/dev/null || true
      sleep 4
      tmux send-keys -t "$pane" -H 0d
      rm -f "$seed_file"
    fi
  ) &
}

# ── Status display ────────────────────────────────────────────────
print_status() {
  [ ! -f "$REGISTRY" ] && { echo "No registry found at $REGISTRY"; return; }

  printf "%-25s %-10s %-15s %-10s\n" "WORKER" "PANE" "WINDOW" "STATE"
  printf "%-25s %-10s %-15s %-10s\n" "------" "----" "------" "-----"

  while IFS= read -r worker; do
    [ "$worker" = "_config" ] && continue
    local pane_id; pane_id=$(jq -r --arg n "$worker" '.[$n].pane_id // "-"' "$REGISTRY" 2>/dev/null)
    local window; window=$(jq -r --arg n "$worker" '.[$n].window // "-"' "$REGISTRY" 2>/dev/null)

    local state="no-pane"
    if [ "$pane_id" != "-" ] && [ "$pane_id" != "null" ] && [ -n "$pane_id" ]; then
      if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; then
        state="alive"
      else
        state="dead"
      fi
    fi

    _is_crash_looped "$worker" && state="CRASH-LOOP"

    printf "%-25s %-10s %-15s %-10s\n" "$worker" "${pane_id:-n/a}" "${window:-n/a}" "$state"
  done < <(jq -r 'keys[]' "$REGISTRY" 2>/dev/null || true)
}

# ── Main loop ─────────────────────────────────────────────────────
_log "Watchdog starting (mode=$MODE, interval=${CHECK_INTERVAL}s)"

if [ "$MODE" = "status" ]; then
  print_status
  exit 0
fi

run_once() {
  [ ! -f "$REGISTRY" ] && return

  while IFS= read -r worker; do
    check_worker "$worker" 2>/dev/null || true
  done < <(jq -r 'keys[]' "$REGISTRY" 2>/dev/null || true)
}

if [ "$MODE" = "once" ]; then
  run_once
  _log "Single-pass complete"
  exit 0
fi

# Daemon mode
while true; do
  run_once
  sleep "$CHECK_INTERVAL"
done
