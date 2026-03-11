#!/usr/bin/env bash
# liveness-heartbeat.sh — Touch a timestamp file on every hook fire.
# Registered on PostToolUse + UserPromptSubmit so the watchdog has a
# reliable "last activity" signal without parsing scrollback.
#
# File: ~/.claude-ops/state/watchdog-runtime/{worker}/liveness
# Contains: epoch timestamp of last activity

WORKER="${WORKER_NAME:-}"
[ -z "$WORKER" ] && exit 0

RUNTIME_DIR="${HOME}/.claude-ops/state/watchdog-runtime/${WORKER}"
mkdir -p "$RUNTIME_DIR" 2>/dev/null || true

# Write epoch + optional subagent identity
INPUT=$(cat)
_AID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
_ATYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null || echo "")
if [ -n "$_AID" ]; then
  printf '%s %s:%s\n' "$(date +%s)" "$_ATYPE" "$_AID" > "$RUNTIME_DIR/liveness"
else
  date +%s > "$RUNTIME_DIR/liveness"
fi
echo '{}'
exit 0
