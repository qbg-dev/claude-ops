#!/usr/bin/env bash
# harness-launch.sh — Respawn a harness module-manager in a new tmux window.
# Called by harness-watchdog.sh after graceful sleep window expires or crash detected.
# Usage: bash harness-launch.sh <harness-name> [<seed-script>]
set -euo pipefail

HARNESS="${1:?Usage: harness-launch.sh <harness-name> [<seed-script>]}"
SEED_SCRIPT="${2:-}"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
TMUX_SESSION="${TMUX_SESSION:-h}"

_log() { echo "[$(date -u +%FT%TZ)] harness-launch: $*" >> "${HOME}/.claude-ops/state/watchdog.log" 2>/dev/null || true; }

# Resolve seed script if not provided
[ -z "$SEED_SCRIPT" ] && SEED_SCRIPT="$PROJECT_ROOT/.claude/scripts/${HARNESS}-seed.sh"

if [ ! -f "$SEED_SCRIPT" ]; then
  _log "ERROR $HARNESS — seed script not found: $SEED_SCRIPT"
  echo "ERROR: seed script not found: $SEED_SCRIPT" >&2
  exit 1
fi

# Read model from config.json (authoritative), fallback to permissions.json (legacy)
CONFIG="$PROJECT_ROOT/.claude/harness/$HARNESS/agents/module-manager/config.json"
PERMS="$PROJECT_ROOT/.claude/harness/$HARNESS/agents/module-manager/permissions.json"
MODEL="sonnet"
if [ -f "$CONFIG" ]; then
  MODEL=$(jq -r '.model // "sonnet"' "$CONFIG" 2>/dev/null || echo "sonnet")
elif [ -f "$PERMS" ]; then
  MODEL=$(jq -r '.model // "sonnet"' "$PERMS" 2>/dev/null || echo "sonnet")
fi

# Create a new tmux window named after the harness (-d = don't switch focus)
# If the window already exists, reuse it (the stale session is gone)
if ! tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$HARNESS"; then
  tmux new-window -d -t "${TMUX_SESSION}:" -n "$HARNESS" 2>/dev/null || true
fi

# Find the window index by name
WIN_IDX=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_name} #{window_index}' \
  | awk -v h="$HARNESS" '$1==h{print $2}' | tail -1)
if [ -z "$WIN_IDX" ]; then
  _log "ERROR $HARNESS — could not find window named '$HARNESS' in session '$TMUX_SESSION'"
  echo "ERROR: could not find tmux window named '$HARNESS'" >&2
  exit 1
fi

# Get the first pane in the window
PANE_ID=$(tmux list-panes -t "$TMUX_SESSION:$WIN_IDX" -F '#{pane_id}' | head -1)
if [ -z "$PANE_ID" ]; then
  _log "ERROR $HARNESS — no pane in $TMUX_SESSION:$WIN_IDX"
  echo "ERROR: no pane in $TMUX_SESSION:$WIN_IDX" >&2
  exit 1
fi

_log "Launching $HARNESS in $TMUX_SESSION:$WIN_IDX ($PANE_ID) model=$MODEL"

# Set pane title
tmux select-pane -T "${HARNESS}/module-manager" -t "$PANE_ID" 2>/dev/null || true

# Register pane in pane-registry BEFORE injecting seed (harness-launch knows the exact pane ID)
HARNESS_JQ="$HOME/.claude-ops/lib/harness-jq.sh"
if [ -f "$HARNESS_JQ" ]; then
  source "$HARNESS_JQ"
  _PANE_TARGET=$(tmux list-panes -t "$TMUX_SESSION:$WIN_IDX" -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
    | awk -v p="$PANE_ID" '$1==p{print $2}' 2>/dev/null || echo "")
  pane_registry_update "$PANE_ID" "$HARNESS" "launching" 0 0 "${HARNESS} — launching" "$_PANE_TARGET" "module-manager" 2>/dev/null || true
  _log "Registered $HARNESS pane $PANE_ID in pane-registry"
fi

# ── Kill any existing Claude process in this pane ──────────────────
# Always start fresh — never inject a seed into a stale session.
# Stale sessions have old context, wrong model, outdated tool policies.
PANE_PID=$(tmux list-panes -t "$TMUX_SESSION:$WIN_IDX" -F '#{pane_id} #{pane_pid}' \
  | awk -v p="$PANE_ID" '$1==p{print $2}' || echo "")
if [ -n "$PANE_PID" ]; then
  CHILD_PID=$(pgrep -P "$PANE_PID" 2>/dev/null | head -1 || true)
  if [ -n "$CHILD_PID" ]; then
    CHILD_CMD=$(ps -o command= -p "$CHILD_PID" 2>/dev/null | head -c 40 || true)
    _log "$HARNESS: killing existing process ($CHILD_CMD) in pane before fresh launch"
    kill "$CHILD_PID" 2>/dev/null || true
    sleep 3
    # Force kill if still alive
    kill -0 "$CHILD_PID" 2>/dev/null && kill -9 "$CHILD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# ── Start fresh Claude session ──────────────────
CLAUDE_CMD="claude --model $MODEL --dangerously-skip-permissions"
CLAUDE_CMD="$CLAUDE_CMD --add-dir $PROJECT_ROOT/.claude/harness/$HARNESS"

tmux send-keys -t "$PANE_ID" "cd $PROJECT_ROOT"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 0.5

tmux send-keys -t "$PANE_ID" "$CLAUDE_CMD"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for Claude TUI to be ready (poll for ❯ prompt, max 60s)
_WAIT=0
until tmux capture-pane -t "$PANE_ID" -p 2>/dev/null | grep -qE '❯|> $'; do
  sleep 2; _WAIT=$((_WAIT+2))
  [ "$_WAIT" -ge 60 ] && { _log "WARNING: TUI timeout after 60s for $HARNESS, proceeding anyway"; break; }
done
sleep 2  # extra settle time

# Generate seed prompt and inject it
SEED_FILE="/tmp/${HARNESS}-launch-seed.txt"
if TMUX="" bash "$SEED_SCRIPT" > "$SEED_FILE" 2>/dev/null; then
  _log "$HARNESS seed generated ($(wc -c < "$SEED_FILE") bytes)"
else
  _log "WARNING $HARNESS — seed script failed, using fallback"
  echo "You are the module-manager for $HARNESS. Read your harness files and begin your cycle." > "$SEED_FILE"
fi

tmux load-buffer "$SEED_FILE"
tmux paste-buffer -t "$PANE_ID"
sleep 2
tmux send-keys -t "$PANE_ID" -H 0d

_log "Done: $HARNESS launched in $TMUX_SESSION:$WIN_IDX ($PANE_ID)"
echo "Launched $HARNESS in $TMUX_SESSION:$WIN_IDX ($PANE_ID)"
