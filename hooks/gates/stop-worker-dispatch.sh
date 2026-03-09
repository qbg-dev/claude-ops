#!/usr/bin/env bash
# stop-worker-dispatch.sh — Stop hook for flat workers.
#
# Routes flat worker sessions (worker/*) to block until tasks complete.
# Non-worker sessions pass through.
# Shared functions: lib/fleet-jq.sh
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "$HOME/.claude-ops/lib/fleet-jq.sh"
source "$HOME/.claude-ops/lib/event-bus.sh" 2>/dev/null || true

_log() {
  local _aid_tag=""
  [ -n "${_HOOK_AGENT_ID:-}" ] && _aid_tag=" agent=${_HOOK_AGENT_TYPE:-}:${_HOOK_AGENT_ID}"
  echo "[$(date -u +%FT%TZ)] stop-hook:${_aid_tag} $*" >> "${HOME}/.claude-ops/state/watchdog.log" 2>/dev/null || true
}

INPUT=$(cat)

# Parse session ID
hook_parse_input "$INPUT"
# Subagents: skip task/inbox/pane checks (blocking hooks handled by hook-engine.sh)
if _is_subagent; then
  hook_pass; exit 0
fi
SESSION_ID="$_HOOK_SESSION_ID"
[ -z "$SESSION_ID" ] && { hook_pass; exit 0; }

_SESSION_DIR=$(harness_session_dir "$SESSION_ID")

# Skip if echo chain is active
[ -f "$_SESSION_DIR/echo-state.json" ] && { hook_pass; exit 0; }

# Escape hatch (per-session)
[ -f "$_SESSION_DIR/allow-stop" ] && { hook_pass; exit 0; }

# Find own pane + skip monitor sessions
OWN_PANE_ID=$(hook_find_own_pane 2>/dev/null || echo "")
if [ -n "$OWN_PANE_ID" ]; then
  PANE_TITLE=$(tmux display-message -t "$OWN_PANE_ID" -p '#{pane_title}' 2>/dev/null || echo "")
  if [[ "$PANE_TITLE" == MONITOR* ]]; then
    hook_pass; exit 0
  fi
fi

# Resolve worker identity
hook_resolve_harness "$OWN_PANE_ID" "$SESSION_ID"

# Patch session_id into pane-registry
if [ -n "${OWN_PANE_ID:-}" ] && [ -n "${SESSION_ID:-}" ] && [ -f "$PANE_REGISTRY" ]; then
  PANE_REGISTRY="$PANE_REGISTRY" OWN_PANE_ID="$OWN_PANE_ID" SESSION_ID="$SESSION_ID" \
  python3 -c "import json, os
try:
    reg_path = os.environ['PANE_REGISTRY']
    pane_id = os.environ['OWN_PANE_ID']
    sess_id = os.environ['SESSION_ID']
    reg = json.load(open(reg_path))
    if pane_id in reg:
        reg[pane_id]['session_id'] = sess_id
        json.dump(reg, open(reg_path, 'w'), indent=2)
except: pass
" 2>/dev/null || true
fi
export CLAUDE_SESSION_ID="${SESSION_ID:-}"

# ── Child pane parent notification ──
_check_child_parent_notification() {
  [ -z "$OWN_PANE_ID" ] && return
  [ ! -f "$PANE_REGISTRY" ] && return

  local _parent_pane _parent_name _child_target _tool_count
  _parent_pane=$(jq -r --arg p "$OWN_PANE_ID" '.[$p].parent_pane // empty' "$PANE_REGISTRY" 2>/dev/null || echo "")
  [ -z "$_parent_pane" ] && return

  _parent_name=$(jq -r --arg p "$_parent_pane" '.[$p].harness // ""' "$PANE_REGISTRY" 2>/dev/null | sed 's|^worker/||')
  _child_target=$(jq -r --arg p "$OWN_PANE_ID" '.[$p].pane_target // "unknown"' "$PANE_REGISTRY" 2>/dev/null || echo "unknown")
  local _tool_log="$HOME/.claude/tool-logs/$(basename "$PROJECT_ROOT")/tools.jsonl"
  _tool_count=0
  [ -f "$_tool_log" ] && \
    _tool_count=$(grep -c "\"session_id\":\"$SESSION_ID\"" "$_tool_log" 2>/dev/null || true)
  [ -z "$_tool_count" ] && _tool_count=0

  if [ -f "$_SESSION_DIR/parent-notified" ]; then
    if [ -n "$_parent_name" ] && [ "$_tool_count" -ge 3 ]; then
      local _payload
      _payload=$(jq -nc \
        --arg sid "$SESSION_ID" \
        --arg child_pane "$OWN_PANE_ID" \
        --arg child_target "$_child_target" \
        --arg parent_pane "$_parent_pane" \
        --arg parent_name "$_parent_name" \
        --argjson tool_count "$_tool_count" \
        '{session_id:$sid, child_pane:$child_pane, child_target:$child_target,
          parent_pane:$parent_pane, parent_name:$parent_name, tool_count:$tool_count}' 2>/dev/null || true)
      [ -n "$_payload" ] && _harness_bus_publish "child.session-ended" "$_payload" 2>/dev/null || true
    fi
    return
  fi

  [ "$_tool_count" -lt 3 ] && return
  [ -z "$_parent_name" ] && return

  hook_block "$(echo -e "## Forked child — notify parent before stopping\n\nYou are a child pane of **${_parent_name}** (${_child_target}, ${_tool_count} tool calls).\n\n1. Send a summary to your parent:\n\n   bash ~/.claude-ops/scripts/worker-message.sh send ${_parent_name} \\\\\n     \"Child session ${SESSION_ID} (${_child_target}): <2-3 sentence summary of what you found/fixed/decided>\"\n\n2. Mark done:\n   touch ${_SESSION_DIR}/parent-notified\n\nEscape: touch ${_SESSION_DIR}/allow-stop")"
  exit 0
}

_check_child_parent_notification

# ── Only handle flat workers ──
if [[ "${CANONICAL:-$HARNESS}" != worker/* ]]; then
  hook_pass
  exit 0
fi

_wname="${CANONICAL#worker/}"
_wname="${_wname:-${HARNESS#worker/}}"
_wdir="$PROJECT_ROOT/.claude/workers/$_wname"

# Worktree fallback: resolve main repo root
if [ ! -d "$_wdir" ]; then
  _main_root=$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')
  [ -n "$_main_root" ] && [ "$_main_root" != "$PROJECT_ROOT" ] && _wdir="$_main_root/.claude/workers/$_wname"
fi

_wstate="$_wdir/state.json"
TASKS_FILE="$_wdir/tasks.json"

# Status check
_status=$(jq -r '.status // "running"' "$_wstate" 2>/dev/null || echo "running")
[ "$_status" = "stopped" ] && { hook_pass; exit 0; }

# NOTE: Dynamic hooks gate (blocking Stop hooks) is handled by dynamic-hook-dispatcher.sh
# which is registered as a separate hook for ALL events. No duplication here.

# Perpetual workers: pass through (watchdog handles respawn cycle)
_perpetual=$(jq -r '.perpetual // false' "$_wstate" 2>/dev/null || echo "false")
if [ "$_perpetual" = "true" ]; then
  _sleep_dur=$(jq -r '.sleep_duration // 3600' "$_wstate" 2>/dev/null || echo "3600")
  _log "flat-worker stop: $_wname (perpetual, sleep=${_sleep_dur}s)"
  hook_pass; exit 0
fi

# One-shot workers: block until tasks done
[ ! -f "$TASKS_FILE" ] && { hook_pass; exit 0; }

_total=$(jq '[.[] | select(.status != "deleted")] | length' "$TASKS_FILE" 2>/dev/null || echo "0")
_done=$(jq '[.[] | select(.status == "completed")] | length' "$TASKS_FILE" 2>/dev/null || echo "0")
_pending=$(jq '[.[] | select(.status == "pending")] | length' "$TASKS_FILE" 2>/dev/null || echo "0")
_in_prog=$(jq '[.[] | select(.status == "in_progress")] | length' "$TASKS_FILE" 2>/dev/null || echo "0")

if [ "$_done" -ge "$_total" ] && [ "$_total" -gt 0 ]; then
  hook_block "$(echo -e "## ${_wname}: All ${_total} tasks complete\n\n1. Update MEMORY.md with key learnings\n2. Update state.json (status: done, cycles_completed++)\n\nThen stop.\nEscape: touch ${_SESSION_DIR}/allow-stop")"
  exit 0
fi

_current=$(jq -r '[to_entries[] | select(.value.status == "in_progress")] | first | .key // "none"' "$TASKS_FILE" 2>/dev/null || echo "none")
hook_block "$(echo -e "## ${_wname}: ${_done}/${_total} tasks complete\n\nCurrent: ${_current} | Pending: ${_pending} | In Progress: ${_in_prog}\n\nEscape: touch ${_SESSION_DIR}/allow-stop")"
exit 0
