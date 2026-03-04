#!/usr/bin/env bash
# worker-register-child.sh — Register a child pane in registry.json with parent link.
#
# Usage: worker-register-child.sh <child_pane_id> <parent_worker_name> [--project <root>]
#
# Writes to registry.json:
#   - Creates a child entry with parent field
#   - Adds child to parent's children array
#
# Example:
#   bash worker-register-child.sh %650 chatbot-tools
#   bash worker-register-child.sh %650 chatbot-tools --project /path/to/repo
set -uo pipefail

CHILD_PANE="${1:-}"
PARENT_NAME="${2:-}"
shift 2 2>/dev/null || true

[ -z "$CHILD_PANE" ] || [ -z "$PARENT_NAME" ] && {
  echo "Usage: worker-register-child.sh <child_pane_id> <parent_worker_name> [--project <root>]" >&2
  exit 1
}

# Parse optional args
PROJECT_ROOT="${PROJECT_ROOT:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ROOT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

[ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "/Users/wz/Desktop/zPersonalProjects/Wechat")"
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"

[ ! -f "$REGISTRY" ] && { echo "ERROR: registry not found: $REGISTRY" >&2; exit 1; }

# Verify parent exists in registry
PARENT_EXISTS=$(jq -r --arg n "$PARENT_NAME" 'has($n)' "$REGISTRY" 2>/dev/null)
[ "$PARENT_EXISTS" != "true" ] && { echo "ERROR: parent '$PARENT_NAME' not found in registry" >&2; exit 1; }

# Compute pane_target for child
PANE_TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
  | awk -v p="$CHILD_PANE" '$1==p{print $2}')

# Generate child name
CHILD_NAME="${PARENT_NAME}-child-$(date +%s)"

# Lock + write
_LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.boring/state/locks}/worker-registry"
mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
_WAIT=0
while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
  sleep 0.5; _WAIT=$((_WAIT + 1))
  [ "$_WAIT" -ge 10 ] && break
done

TMP=$(mktemp)
jq --arg child "$CHILD_NAME" --arg parent "$PARENT_NAME" \
   --arg pane "$CHILD_PANE" --arg target "${PANE_TARGET:-}" \
  '
  # Create child entry
  .[$child] = {
    model: (.[$parent].model // "sonnet"),
    permission_mode: (.[$parent].permission_mode // "bypassPermissions"),
    disallowed_tools: (.[$parent].disallowed_tools // []),
    status: "active",
    perpetual: false,
    parent: $parent,
    pane_id: $pane,
    pane_target: $target,
    tmux_session: (.[$parent].tmux_session // "w"),
    branch: (.[$parent].branch // ""),
    worktree: (.[$parent].worktree // null),
    window: (.[$parent].window // null)
  } |
  # Add to parent children array
  .[$parent].children = ((.[$parent].children // []) | if index($child) then . else . + [$child] end)
  ' "$REGISTRY" > "$TMP" 2>/dev/null && mv "$TMP" "$REGISTRY" || rm -f "$TMP"

rmdir "$_LOCK_DIR" 2>/dev/null || true

echo "Registered $CHILD_PANE as child '$CHILD_NAME' of '$PARENT_NAME'"
