#!/usr/bin/env bash
# harness-dispatch.sh — Pane identity resolution and agent discovery.
#
# Provides safe pane detection via process-tree traversal.
# Do NOT use tmux display-message without -t: it returns the FOCUSED pane (cross-agent bug).
#
# Public API:
#   find_own_pane()              — returns pane_id (%NNN) for the calling process
#   pane_id_to_target()          — converts %NNN to session:window.pane
#   discover_agent_panes()       — lists pane targets of all running agents
#   check_harness_stop_flag()    — returns 0 if stop-flag set for HARNESS
#
# WARNING: Do NOT use `tmux display-message -p` here — it returns the focused
# pane, not the pane belonging to this process. Use find_own_pane() instead.
set -uo pipefail

source "${HOME}/.boring/lib/harness-jq.sh" 2>/dev/null || true

# ── find_own_pane ────────────────────────────────────────────────────────────
# Walk the process tree from PPID upward, matching PIDs against tmux pane PIDs.
# Returns the pane_id (%NNN) of the pane that owns this process, or "" if not
# running inside tmux.
find_own_pane() {
  local p=$PPID
  while [ "$p" -gt 1 ]; do
    local match
    match=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null \
      | awk -v pid="$p" '$1 == pid { print $2; exit }')
    if [ -n "$match" ]; then
      echo "$match"
      return 0
    fi
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -z "$p" ] && break
  done
  echo ""
}

# ── pane_id_to_target ────────────────────────────────────────────────────────
# Convert a pane_id (%NNN) to a tmux target string (session:window.pane).
# Usage: pane_id_to_target "%3"
pane_id_to_target() {
  local pane_id="${1:-}"
  [ -z "$pane_id" ] && { echo ""; return 1; }
  tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | awk -v id="$pane_id" '$1 == id { print $2; exit }'
}

# ── discover_agent_panes ─────────────────────────────────────────────────────
# List the tmux target (session:window.pane) for every pane that has a live
# claude process, excluding the caller's own pane.
discover_agent_panes() {
  local own
  own=$(find_own_pane)

  tmux list-panes -a -F '#{pane_id} #{pane_pid} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | while read -r pane_id pane_pid target; do
        [ "$pane_id" = "$own" ] && continue
        if pgrep -P "$pane_pid" -x claude &>/dev/null 2>&1; then
          echo "$target"
        fi
      done
}

# ── check_harness_stop_flag ──────────────────────────────────────────────────
# Return 0 (true) if a stop-flag has been written for this harness, then
# consume it (rm -f). Called by stop-harness-dispatch.sh on each Stop hook.
check_harness_stop_flag() {
  local harness="${HARNESS:-}"
  [ -z "$harness" ] && return 1

  local flag_file
  flag_file="${HARNESS_STATE_DIR:-$HOME/.boring/state}/harness-runtime/$harness/stop-flag"

  if [ -f "$flag_file" ]; then
    rm -f "${HARNESS_STATE_DIR:-$HOME/.boring/state}/harness-runtime/$harness/stop-flag"
    return 0
  fi
  return 1
}
