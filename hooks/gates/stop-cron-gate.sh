#!/usr/bin/env bash
# stop-cron-gate.sh — Blocks session exit if worker has cron_schedule configured
# but hasn't called CronCreate with expected parameters.
#
# Reads tools.jsonl to verify CronCreate was called for each expected cron entry.
# Workers with cron_schedule in config.json must register all crons at session start;
# this gate enforces that before allowing idle/stop.
set -euo pipefail

source "$HOME/.claude-fleet/lib/fleet-jq.sh" 2>/dev/null || true

INPUT=$(cat)
hook_parse_input "$INPUT"

# Subagents: skip
if _is_subagent; then hook_pass; exit 0; fi

SESSION_ID="$_HOOK_SESSION_ID"
[ -z "$SESSION_ID" ] && { hook_pass; exit 0; }

_SESSION_DIR=$(harness_session_dir "$SESSION_ID")

# Escape hatch
[ -f "$_SESSION_DIR/allow-stop" ] && { hook_pass; exit 0; }
# Echo chain active
[ -f "$_SESSION_DIR/echo-state.json" ] && { hook_pass; exit 0; }

# Only check worker/* sessions
OWN_PANE_ID=$(hook_find_own_pane 2>/dev/null || echo "")
hook_resolve_harness "$OWN_PANE_ID" "$SESSION_ID" 2>/dev/null || true

if [[ "${CANONICAL:-$HARNESS}" != worker/* ]]; then
  hook_pass; exit 0
fi

_wname="${CANONICAL#worker/}"
_wname="${_wname:-${HARNESS#worker/}}"

# Resolve worker directory (handle worktree)
_wdir="$PROJECT_ROOT/.claude/workers/$_wname"
if [ ! -d "$_wdir" ]; then
  _main_root=$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')
  [ -n "$_main_root" ] && [ "$_main_root" != "$PROJECT_ROOT" ] && _wdir="$_main_root/.claude/workers/$_wname"
fi

# Read cron_schedule from config.json
_config="$_wdir/config.json"
[ ! -f "$_config" ] && { hook_pass; exit 0; }

_cron_schedule=$(jq -r '.cron_schedule // empty' "$_config" 2>/dev/null || echo "")
[ -z "$_cron_schedule" ] && { hook_pass; exit 0; }

_count=$(echo "$_cron_schedule" | jq -r 'length' 2>/dev/null || echo "0")
[ "$_count" = "0" ] && { hook_pass; exit 0; }

# Verify each expected cron was registered via CronCreate
_missing=""
_found=0
_total="$_count"

for i in $(seq 0 $((_count - 1))); do
  _cron=$(echo "$_cron_schedule" | jq -r ".[$i].cron" 2>/dev/null || echo "")
  [ -z "$_cron" ] && continue

  # Escape special regex chars in cron expression (*, /)
  _cron_escaped=$(printf '%s' "$_cron" | sed 's/[*./]/\\&/g')

  if hook_tool_log_has "$SESSION_ID" "CronCreate" "\"cron\":\"${_cron}\""; then
    _found=$((_found + 1))
  else
    _prompt=$(echo "$_cron_schedule" | jq -r ".[$i].prompt // \"\"" 2>/dev/null || echo "")
    _missing="${_missing}\n- \`CronCreate(cron=\"${_cron}\", prompt=\"${_prompt}\")\`"
  fi
done

if [ -n "$_missing" ]; then
  hook_block "$(echo -e "## ${_wname}: Missing CronCreate calls (${_found}/${_total} registered)\n\nYour \`cron_schedule\` config requires these CronCreate calls before stopping:\n${_missing}\n\nCall each CronCreate now, then try stopping again.\n\nEscape: touch ${_SESSION_DIR}/allow-stop")"
  exit 0
fi

hook_pass
exit 0
