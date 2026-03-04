---
description: "Register current pane with watchdog as a named worker"
argument-hint: "<worker-name>"
allowed-tools: Bash, Read
---

# Register Pane with Watchdog

Register the current tmux pane in `registry.json` so the watchdog can manage it (respawn on crash, cycle tracking).

## What this does

1. Detects current tmux pane ID
2. Updates the worker's entry in `$PROJECT_ROOT/.claude/workers/registry.json` with `pane_id` and `pane_target`
3. Auto-detects worker name from worktree branch if not provided

## Execute

If `$ARGUMENTS` is provided, use it as the worker name. Otherwise, try to auto-detect from the worktree branch name or ask.

```bash
# Auto-detect worker name from git branch if not provided
WORKER_NAME="$ARGUMENTS"
if [ -z "$WORKER_NAME" ]; then
  WORKER_NAME=$(git branch --show-current 2>/dev/null | sed 's|^worker/||')
fi

if [ -z "$WORKER_NAME" ]; then
  echo "ERROR: Could not detect worker name. Provide it as argument: /boring:register <name>"
  exit 1
fi
```

If worker name is detected, register using the MCP `register_pane` tool if available, otherwise inline:

```bash
WORKER="$WORKER_NAME"
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"

# Find own pane via process-tree walk (not tmux display-message which returns focused pane)
OWN_PANE=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read -r pid id; do
  p=$PPID
  while [ "$p" -gt 1 ]; do
    [ "$p" = "$pid" ] && echo "$id" && break 2
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
done)
PANE_TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
  | awk -v p="$OWN_PANE" '$1==p{print $2}')

[ ! -f "$REGISTRY" ] && { echo "ERROR: registry.json not found at $REGISTRY"; exit 1; }

_LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.boring/state/locks}/worker-registry"
mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
_WAIT=0
while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
  sleep 0.5; _WAIT=$((_WAIT + 1))
  [ "$_WAIT" -ge 10 ] && break
done

TMP=$(mktemp)
jq --arg name "$WORKER" --arg pid "$OWN_PANE" --arg target "$PANE_TARGET" \
  '.[$name].pane_id = $pid | .[$name].pane_target = $target' \
  "$REGISTRY" > "$TMP" 2>/dev/null && mv "$TMP" "$REGISTRY" || rm -f "$TMP"

rmdir "$_LOCK_DIR" 2>/dev/null || true

echo "Registered $WORKER in pane $OWN_PANE ($PANE_TARGET)"
echo "  Registry: $REGISTRY"
echo "  Watchdog will now manage this pane"
```

After registration, confirm to the user what was registered and that the watchdog will now manage this pane.
