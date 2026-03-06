#!/usr/bin/env bash
# register-pane.sh — Self-register the current pane into registry.json
#
# Usage (from within a tmux pane running Claude):
#   bash .claude/scripts/register-pane.sh <worker-name> [session-id]
#
# What it does:
#   1. Detects current tmux pane ID via process-tree walk
#   2. Updates the worker's entry in registry.json with pane_id + pane_target
#   3. Watchdog will then manage this pane (respawn on crash)

set -euo pipefail

WORKER="${1:-}"
SESSION_ID="${2:-}"
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"

if [ -z "$WORKER" ]; then
  echo "Usage: bash .claude/scripts/register-pane.sh <worker-name> [session-id]"
  echo ""
  echo "Examples:"
  echo "  bash .claude/scripts/register-pane.sh chatbot-tools"
  echo "  bash .claude/scripts/register-pane.sh chief-of-staff abc123-def456"
  exit 1
fi

[ ! -f "$REGISTRY" ] && { echo "ERROR: registry.json not found at $REGISTRY"; exit 1; }

# Detect current pane via process-tree walk (not tmux display-message which returns focused pane)
OWN_PANE=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read -r pid id; do
  p=$PPID
  while [ "$p" -gt 1 ]; do
    [ "$p" = "$pid" ] && echo "$id" && break 2
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
done)

if [ -z "$OWN_PANE" ]; then
  # Fallback to TMUX_PANE env var
  OWN_PANE="${TMUX_PANE:-}"
fi

if [ -z "$OWN_PANE" ]; then
  echo "ERROR: Could not detect pane ID (not in tmux?)"
  exit 1
fi

PANE_TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
  | awk -v p="$OWN_PANE" '$1==p{print $2}')

# Auto-detect session ID from scrollback if not provided
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(tmux capture-pane -t "$OWN_PANE" -p 2>/dev/null \
    | grep -oE '[a-f0-9-]{36}\.jsonl' | tail -1 | sed 's/\.jsonl//' || echo "")
fi

# Lock + write to registry.json
_LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.claude-ops/state/locks}/worker-registry"
mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
_WAIT=0
while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
  sleep 0.5; _WAIT=$((_WAIT + 1))
  [ "$_WAIT" -ge 10 ] && break
done

TMP=$(mktemp)
jq --arg name "$WORKER" --arg pid "$OWN_PANE" --arg target "${PANE_TARGET:-}" \
   --arg sid "${SESSION_ID:-}" \
  '
  .[$name].pane_id = $pid |
  .[$name].pane_target = $target |
  if $sid != "" then .[$name].session_id = $sid else . end
  ' "$REGISTRY" > "$TMP" 2>/dev/null && mv "$TMP" "$REGISTRY" || rm -f "$TMP"

rmdir "$_LOCK_DIR" 2>/dev/null || true

echo "Registered $WORKER in pane $OWN_PANE ($PANE_TARGET)"
[ -n "$SESSION_ID" ] && echo "  session_id: $SESSION_ID"
echo "  Registry: $REGISTRY"
echo "  Watchdog will now manage this pane (respawn on crash)"
