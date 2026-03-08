#!/usr/bin/env bash
# post-tool-publisher.sh — PostToolUse trace publisher.
# Publishes tool.post events to the event bus. Never blocks.
set -uo pipefail
trap 'echo "{}"; exit 0' ERR
exec 2>/dev/null

INPUT=$(cat)

source "$HOME/.claude-ops/lib/pane-resolve.sh"
source "$HOME/.claude-ops/lib/event-bus.sh"

hook_parse_input "$INPUT"
SESSION_ID="$_HOOK_SESSION_ID"
TOOL_NAME="$_HOOK_TOOL_NAME"

[ -z "$SESSION_ID" ] && { echo '{}'; exit 0; }

# Resolve identity
HARNESS=""
OWN_PANE_ID=$(resolve_own_pane || true)
if [ -n "$OWN_PANE_ID" ] || [ -n "$SESSION_ID" ]; then
  hook_resolve_harness "${OWN_PANE_ID:-}" "${SESSION_ID:-}" 2>/dev/null || true
fi
BUS_AGENT="${HARNESS:-main}"

# Publish trace (includes subagent identity when present)
PAYLOAD=$(jq -n --compact-output \
  --arg a "$BUS_AGENT" \
  --arg sid "$SESSION_ID" \
  --arg tool "$TOOL_NAME" \
  --arg aid "${_HOOK_AGENT_ID:-}" \
  --arg atype "${_HOOK_AGENT_TYPE:-}" \
  '{agent: $a, session_id: $sid, tool_name: $tool,
   agent_id: (if $aid == "" then null else $aid end),
   agent_type: (if $atype == "" then null else $atype end)}' 2>/dev/null || true)

if [ -n "$PAYLOAD" ]; then
  bus_publish "tool.post" "$PAYLOAD" 2>/dev/null || true
fi

echo '{}'
exit 0
