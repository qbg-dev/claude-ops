#!/usr/bin/env bash
# child-exit.sh — Notify parent worker of completed work, then kill own tmux pane.
#
# Looks up parent from registry.json (via parent field on child entry).
# Notifies parent via worker-message.sh or direct tmux send-keys.
# Removes child from registry.json (parent's children array + child entry).
# Then kills own pane.
#
# Usage:
#   child-exit.sh "summary of what was accomplished"
#
# Called by: /child-exit slash command
set -uo pipefail
trap 'exit 0' EXIT

MESSAGE="${*:-Work complete. No summary provided.}"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || { echo "ERROR: PROJECT_ROOT not set and not in a git repo" >&2; exit 1; })}"
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"

# ── 1. Find own pane ID (process-tree walk) ──────────────────────────────────
OWN_PANE_ID=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read -r pid id; do
  p=$PPID
  while [ "$p" -gt 1 ]; do
    [ "$p" = "$pid" ] && echo "$id" && break 2
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
done)

if [ -z "$OWN_PANE_ID" ]; then
  echo "child-exit: not running inside tmux — nothing to do." >&2
  exit 0
fi

# ── 2. Find own worker name + parent from registry ───────────────────────────
OWN_NAME=""
PARENT_NAME=""
if [ -f "$REGISTRY" ]; then
  # Find entry where pane_id matches our pane
  OWN_NAME=$(jq -r --arg pid "$OWN_PANE_ID" '
    to_entries[] | select(.value.pane_id? == $pid) | .key
  ' "$REGISTRY" 2>/dev/null | head -1)

  if [ -n "$OWN_NAME" ]; then
    PARENT_NAME=$(jq -r --arg n "$OWN_NAME" '.[$n].report_to // .[$n].assigned_by // .[$n].parent // ""' "$REGISTRY" 2>/dev/null)
  fi
fi

# ── 3. Notify parent ─────────────────────────────────────────────────────────
NOTIFIED=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "$PARENT_NAME" ]; then
  # Try worker-message.sh first (durable inbox)
  if bash "$SCRIPT_DIR/worker-message.sh" send "$PARENT_NAME" "$MESSAGE" 2>/dev/null; then
    echo "child-exit: notified $PARENT_NAME via bus — ${MESSAGE}"
    NOTIFIED=true
  fi

  # Fallback: direct tmux send-keys to parent pane
  if [ "$NOTIFIED" = "false" ] && [ -f "$REGISTRY" ]; then
    _parent_fields=$(jq -r --arg n "$PARENT_NAME" '[(.[$n].pane_id // ""), (.[$n].pane_target // "")] | join("\t")' "$REGISTRY" 2>/dev/null || echo "")
    PARENT_PANE=$(printf '%s' "$_parent_fields" | cut -d$'\t' -f1)
    PARENT_TARGET=$(printf '%s' "$_parent_fields" | cut -d$'\t' -f2)
    TARGET="${PARENT_TARGET:-$PARENT_PANE}"

    if [ -n "$TARGET" ]; then
      SIG="[from ${OWN_NAME:-child}]"
      tmux send-keys -t "$TARGET" "$SIG $MESSAGE"
      tmux send-keys -t "$TARGET" -H 0d
      echo "child-exit: notified $PARENT_NAME via tmux ($TARGET) — ${MESSAGE}"
      NOTIFIED=true
    fi
  fi
fi

if [ "$NOTIFIED" = "false" ]; then
  echo "child-exit: could not notify parent (${PARENT_NAME:-unknown})." >&2
fi

# ── 4. Remove child from registry ────────────────────────────────────────────
if [ -n "$OWN_NAME" ] && [ -f "$REGISTRY" ]; then
  _LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.claude-ops/state/locks}/worker-registry"
  mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
  _WAIT=0
  while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
    sleep 0.5; _WAIT=$((_WAIT + 1))
    [ "$_WAIT" -ge 10 ] && break
  done

  TMP=$(mktemp)
  jq --arg child "$OWN_NAME" --arg parent "${PARENT_NAME:-}" '
    # Remove child from parent children array
    if $parent != "" then
      .[$parent].children = ((.[$parent].children // []) - [$child])
    else . end |
    # Delete child entry
    del(.[$child])
  ' "$REGISTRY" > "$TMP" 2>/dev/null && mv "$TMP" "$REGISTRY" || rm -f "$TMP"

  rmdir "$_LOCK_DIR" 2>/dev/null || true
fi

# ── 5. Kill own pane ─────────────────────────────────────────────────────────
echo "child-exit: killing pane ${OWN_PANE_ID}"
tmux kill-pane -t "$OWN_PANE_ID"
exit 0
