#!/usr/bin/env bash
# session-start-config-seed.sh — SessionStart interceptor that injects config-driven
# seed fragments into the session context.
#
# Convention: templates/seed-fragments/{config_field}.md is injected if the worker's
# config.json has that field set (non-null, non-empty). This makes seed injection
# modular — add a new fragment file to extend the system, no hook code changes needed.
#
# Example: worker has cron_schedule in config → injects seed-fragments/cron_schedule.md
set -uo pipefail
trap 'echo "{}"; exit 0' ERR
exec 2>/dev/null  # suppress stderr

source "$HOME/.claude-fleet/lib/pane-resolve.sh"

INPUT=$(cat)
hook_parse_input "$INPUT"
SESSION_ID="$_HOOK_SESSION_ID"

# Skip subagents
_is_subagent && { echo '{}'; exit 0; }

# Resolve harness
resolve_pane_and_harness "$SESSION_ID"

# Only inject for worker sessions
[[ "$HARNESS" != worker/* ]] && { echo '{}'; exit 0; }

_wname="${HARNESS#worker/}"

# Resolve worker directory (handle worktree)
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
_wdir="$PROJECT_ROOT/.claude/workers/$_wname"
if [ ! -d "$_wdir" ]; then
  _main_root=$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')
  [ -n "$_main_root" ] && [ "$_main_root" != "$PROJECT_ROOT" ] && _wdir="$_main_root/.claude/workers/$_wname"
fi

_config="$_wdir/config.json"
[ ! -f "$_config" ] && { echo '{}'; exit 0; }

# Resolve seed-fragments directory (relative to fleet install)
_FLEET_ROOT="${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}"
_FRAGMENTS_DIR="$_FLEET_ROOT/templates/seed-fragments"
[ ! -d "$_FRAGMENTS_DIR" ] && { echo '{}'; exit 0; }

# Scan fragments directory — each file maps to a config field
_context=""
for _frag in "$_FRAGMENTS_DIR"/*.md; do
  [ -f "$_frag" ] || continue
  _field=$(basename "$_frag" .md)

  # Check if the config field exists, is non-null, and non-empty
  _val=$(jq -r --arg f "$_field" '.[$f] // empty' "$_config" 2>/dev/null || echo "")
  [ -z "$_val" ] && continue

  # For arrays, skip if empty
  if echo "$_val" | jq -e 'if type == "array" then length == 0 else false end' >/dev/null 2>&1; then
    continue
  fi

  # Append fragment content
  _content=$(<"$_frag")
  _context="${_context}${_content}\n\n"

  # Special handling: cron_schedule — generate specific CronCreate calls
  if [ "$_field" = "cron_schedule" ]; then
    _count=$(echo "$_val" | jq -r 'length' 2>/dev/null || echo "0")
    if [ "$_count" -gt 0 ]; then
      _context="${_context}**Call these now:**\n\`\`\`\n"
      for _i in $(seq 0 $((_count - 1))); do
        _cron=$(echo "$_val" | jq -r ".[$_i].cron" 2>/dev/null || echo "")
        _prompt=$(echo "$_val" | jq -r ".[$_i].prompt // empty" 2>/dev/null || echo "")
        # Default prompt: re-read seed context + check mail
        if [ -z "$_prompt" ]; then
          _prompt="Wake up. Re-read your mission (fleet get ${_wname}). Check mail_inbox(). Continue working."
        fi
        _context="${_context}CronCreate(cron: \"${_cron}\", prompt: \"${_prompt}\")\n"
      done
      _context="${_context}\`\`\`\n\n"
    fi
  fi
done

[ -z "$_context" ] && { echo '{}'; exit 0; }

# Return as additionalContext
jq -n --arg ctx "$(echo -e "$_context")" '{"additionalContext":$ctx}'
