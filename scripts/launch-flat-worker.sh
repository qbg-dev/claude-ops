#!/usr/bin/env bash
# launch-flat-worker.sh — Launch a flat worker agent in a tmux window (group or solo).
# Generic upstream version — works with any project that has .claude/workers/{name}/.
#
# Window groups: If permissions.json has "window": "<group>", the worker joins that
# named window (split + tiled). Otherwise it gets its own window named after itself.
#
# Reads config from: .claude/workers/registry.json + .claude/workers/{name}/permissions.json
# Writes pane info to: .claude/workers/registry.json
#
# Usage: bash launch-flat-worker.sh <WORKER> [--session <sess>] [--window <group>] [--project <root>]
# Example: bash launch-flat-worker.sh dashboard-fix
#          bash launch-flat-worker.sh bi-optimizer --window optimizers
#          bash launch-flat-worker.sh my-worker --session w2 --project /path/to/repo
set -euo pipefail

CLAUDE_OPS_DIR="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
source "$CLAUDE_OPS_DIR/lib/resolve-deps.sh"
check_deps bun jq tmux || { echo "ERROR: Missing dependencies. Install them first." >&2; exit 1; }

WORKER="${1:?WORKER name required (e.g. dashboard-fix, chief-of-staff)}"
shift

# Defaults
TARGET_SESSION="w"
PROJECT_ROOT="${PROJECT_ROOT:-}"
CLI_WINDOW=""
CUSTOM_WORKTREE=""
BOOTSTRAP_CMD_FILE=""
BESIDE_PANE=""

# Parse optional args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) TARGET_SESSION="$2"; shift 2 ;;
    --window)  CLI_WINDOW="$2"; shift 2 ;;
    --project) PROJECT_ROOT="$2"; shift 2 ;;
    --worktree) CUSTOM_WORKTREE="$2"; shift 2 ;;
    --bootstrap-cmd-file) BOOTSTRAP_CMD_FILE="$2"; shift 2 ;;
    --beside-pane) BESIDE_PANE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Auto-detect project root if not provided
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

PROJECT_NAME="$(basename "$PROJECT_ROOT")"
WORKER_DIR="$PROJECT_ROOT/.claude/workers/$WORKER"
REGISTRY="$PROJECT_ROOT/.claude/workers/registry.json"
BRANCH="worker/$WORKER"
WORKTREE_DIR="$PROJECT_ROOT/../${PROJECT_NAME}-w-$WORKER"
[ -n "$CUSTOM_WORKTREE" ] && WORKTREE_DIR="$CUSTOM_WORKTREE"

[ ! -d "$WORKER_DIR" ] && { echo "ERROR: worker dir not found: $WORKER_DIR"; exit 1; }
[ -n "$BOOTSTRAP_CMD_FILE" ] && [ ! -f "$BOOTSTRAP_CMD_FILE" ] && {
  echo "ERROR: bootstrap cmd file not found: $BOOTSTRAP_CMD_FILE"
  exit 1
}

# Read worker config — registry.json is the single source of truth for all runtime config.
# permissions.json is only used for disallowed_tools (deny-list).
PERMS="$WORKER_DIR/permissions.json"
MODEL="sonnet"
PERM_MODE="bypassPermissions"
WINDOW_GROUP=""

if [ -f "$REGISTRY" ]; then
  # Batch-read all needed fields in one jq call
  # Use "_" sentinel for null/empty fields to prevent bash IFS from collapsing consecutive tabs
  _REG_FIELDS=$(jq -r --arg n "$WORKER" '[
    (.[$n].model // "_"),
    (.[$n].permission_mode // "_"),
    (.[$n].window // "_"),
    (._config.tmux_session // "_"),
    (.[$n].custom.runtime // "_"),
    (.[$n].custom.reasoning_effort // "_")
  ] | join("\t")' "$REGISTRY" 2>/dev/null || echo "")
  if [ -n "$_REG_FIELDS" ]; then
    IFS=$'\t' read -r _REG_MODEL _REG_PERM _REG_WIN _REG_SESS _REG_RUNTIME _REG_EFFORT <<< "$_REG_FIELDS"
    [ "$_REG_MODEL" != "_" ] && [ -n "$_REG_MODEL" ] && MODEL="$_REG_MODEL"
    [ "$_REG_PERM" != "_" ] && [ -n "$_REG_PERM" ] && PERM_MODE="$_REG_PERM"
    [ "$_REG_WIN" != "_" ] && [ -n "$_REG_WIN" ] && WINDOW_GROUP="$_REG_WIN"
    [ "$_REG_SESS" != "_" ] && [ -n "$_REG_SESS" ] && TARGET_SESSION="$_REG_SESS"
    [ "$_REG_RUNTIME" != "_" ] && [ -n "$_REG_RUNTIME" ] && WORKER_RUNTIME="$_REG_RUNTIME"
    [ "$_REG_EFFORT" != "_" ] && [ -n "$_REG_EFFORT" ] && REASONING_EFFORT="$_REG_EFFORT"
  fi
fi

# WORKER_RUNTIME can be set via env var (from create_worker) or registry
WORKER_RUNTIME="${WORKER_RUNTIME:-claude}"
REASONING_EFFORT="${REASONING_EFFORT:-high}"

# CLI --window overrides registry
[ -n "$CLI_WINDOW" ] && WINDOW_GROUP="$CLI_WINDOW"

# Default: window name = worker name
[ -z "$WINDOW_GROUP" ] && WINDOW_GROUP="$WORKER"

# Ensure tmux session exists
if ! tmux has-session -t "$TARGET_SESSION" 2>/dev/null; then
  tmux new-session -d -s "$TARGET_SESSION" -n "$WORKER" -c "$PROJECT_ROOT"
  CREATED_SESSION=1
else
  CREATED_SESSION=0
fi

# Worktree
if [ -n "$CUSTOM_WORKTREE" ] && [ ! -d "$WORKTREE_DIR" ]; then
  echo "ERROR: custom worktree does not exist: $WORKTREE_DIR"
  exit 1
fi

if [ -n "$CUSTOM_WORKTREE" ]; then
  BRANCH="$(git -C "$WORKTREE_DIR" branch --show-current 2>/dev/null || echo "$BRANCH")"
elif [ ! -d "$WORKTREE_DIR" ]; then
  echo "Creating worktree at $WORKTREE_DIR on branch $BRANCH..."
  git -C "$PROJECT_ROOT" worktree add "$WORKTREE_DIR" "$BRANCH" 2>/dev/null || \
  git -C "$PROJECT_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" 2>/dev/null
fi

# Copy untracked config files that worktrees don't inherit from git
# Always overwrite .mcp.json so worktrees pick up fixes (e.g. absolute bun path)
for UNTRACKED_CFG in .mcp.json; do
  if [ -f "$PROJECT_ROOT/$UNTRACKED_CFG" ]; then
    SRC_CFG="$PROJECT_ROOT/$UNTRACKED_CFG"
    DST_CFG="$WORKTREE_DIR/$UNTRACKED_CFG"
    SRC_REAL="$(cd "$(dirname "$SRC_CFG")" && pwd -P)/$(basename "$SRC_CFG")"
    DST_REAL="$(cd "$(dirname "$DST_CFG")" && pwd -P 2>/dev/null || dirname "$DST_CFG")/$(basename "$DST_CFG")"
    if [ "$SRC_REAL" != "$DST_REAL" ]; then
      cp "$SRC_CFG" "$DST_CFG"
    fi
  fi
done

# Install post-merge hook in main repo (rebase notification after chief-of-staff merges)
# Try project-local hook first, then upstream generic
POST_MERGE_SRC="$PROJECT_ROOT/.claude/hooks/git/post-merge"
if [ ! -f "$POST_MERGE_SRC" ]; then
  POST_MERGE_SRC="${HOME}/.claude-ops/scripts/worker-post-merge-hook.sh"
fi
if [ -f "$POST_MERGE_SRC" ]; then
  POST_MERGE_DST="$PROJECT_ROOT/.git/hooks/post-merge"
  if [ ! -e "$POST_MERGE_DST" ]; then
    cp "$POST_MERGE_SRC" "$POST_MERGE_DST"
    chmod +x "$POST_MERGE_DST"
  fi
fi

# Install post-commit hook in worktree for auto-notification
# Try project-local hook first, then upstream generic
HOOK_SRC="$PROJECT_ROOT/.claude/scripts/worker-post-commit-hook.sh"
if [ ! -f "$HOOK_SRC" ]; then
  HOOK_SRC="${HOME}/.claude-ops/scripts/worker-post-commit-hook.sh"
fi
if [ -f "$HOOK_SRC" ]; then
  # Worktrees share the main repo's .git/hooks, so we need worktree-specific hooks
  WORKTREE_GIT_DIR=$(git -C "$WORKTREE_DIR" rev-parse --git-dir 2>/dev/null)
  HOOKS_DIR="$WORKTREE_GIT_DIR/hooks"
  mkdir -p "$HOOKS_DIR"
  cp "$HOOK_SRC" "$HOOKS_DIR/post-commit"
  chmod +x "$HOOKS_DIR/post-commit"
fi

# Install commit-msg hook for auto-trailers (Worker:, Cycle:)
COMMIT_MSG_SRC="$PROJECT_ROOT/.claude/scripts/worker-commit-msg-hook.sh"
if [ ! -f "$COMMIT_MSG_SRC" ]; then
  COMMIT_MSG_SRC="${HOME}/.claude-ops/scripts/worker-commit-msg-hook.sh"
fi
if [ -f "$COMMIT_MSG_SRC" ]; then
  WORKTREE_GIT_DIR=${WORKTREE_GIT_DIR:-$(git -C "$WORKTREE_DIR" rev-parse --git-dir 2>/dev/null)}
  HOOKS_DIR="${WORKTREE_GIT_DIR}/hooks"
  mkdir -p "$HOOKS_DIR"
  cp "$COMMIT_MSG_SRC" "$HOOKS_DIR/commit-msg"
  chmod +x "$HOOKS_DIR/commit-msg"
fi

# Seed file (generated via bun from TS single source of truth)
SEED_FILE="/tmp/worker-${WORKER}-seed.txt"
_CLAUDE_OPS="${HOME}/.claude-ops"
WORKER_NAME="$WORKER" PROJECT_ROOT="$PROJECT_ROOT" \
  "$BUN" -e "
    const { generateSeedContent } = await import('${_CLAUDE_OPS}/mcp/worker-fleet/index.ts');
    process.stdout.write(generateSeedContent());
  " > "$SEED_FILE" 2>/dev/null || {
  echo "You are worker $WORKER. Read mission.md, then start your next cycle." > "$SEED_FILE"
}

# Create or join tmux window based on WINDOW_GROUP
if [ -n "$BESIDE_PANE" ]; then
  WORKER_PANE=$(tmux split-window -h -t "$BESIDE_PANE" -c "$WORKTREE_DIR" -d -P -F '#{pane_id}')
  _BESIDE_TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}' \
    | awk -v p="$WORKER_PANE" '$1==p{print $2}' 2>/dev/null || echo "")
  [ -n "$_BESIDE_TARGET" ] && tmux select-layout -t "$_BESIDE_TARGET" tiled 2>/dev/null || true
elif [ "$CREATED_SESSION" -eq 1 ]; then
  # Session was just created with a default window — rename it to our window group
  WORKER_PANE=$(tmux list-panes -t "$TARGET_SESSION" -F '#{pane_id}' | head -1)
  tmux rename-window -t "$TARGET_SESSION" "$WINDOW_GROUP"
  tmux send-keys -t "$WORKER_PANE" "cd $WORKTREE_DIR"
  tmux send-keys -t "$WORKER_PANE" -H 0d
elif tmux list-windows -t "$TARGET_SESSION" -F '#{window_name}' 2>/dev/null | grep -qxF "$WINDOW_GROUP"; then
  # Window exists — split into it + re-tile
  WORKER_PANE=$(tmux split-window -t "$TARGET_SESSION:$WINDOW_GROUP" -c "$WORKTREE_DIR" -d -P -F '#{pane_id}')
  tmux select-layout -t "$TARGET_SESSION:$WINDOW_GROUP" tiled
else
  # Create new window with this group name
  WORKER_PANE=$(tmux new-window -t "$TARGET_SESSION" -n "$WINDOW_GROUP" -c "$WORKTREE_DIR" -d -P -F '#{pane_id}')
fi

tmux select-pane -T "$WORKER" -t "$WORKER_PANE"

# Register worker pane in registry.json
_PANE_TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
  | awk -v p="$WORKER_PANE" '$1==p{print $2}' 2>/dev/null || echo "")
_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ -f "$REGISTRY" ]; then
  _LOCK_DIR="${HARNESS_LOCK_DIR:-${HOME}/.claude-ops/state/locks}/worker-registry"
  mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
  _WAIT=0
  while ! mkdir "$_LOCK_DIR" 2>/dev/null; do
    sleep 0.5; _WAIT=$((_WAIT + 1))
    [ "$_WAIT" -ge 10 ] && break
  done
  # Update registry with runtime pane info (registry is source of truth for config)
  TMP_REG=$(mktemp)
  jq --arg name "$WORKER" --arg pid "$WORKER_PANE" --arg target "${_PANE_TARGET:-}" \
    --arg sess "$TARGET_SESSION" --arg branch "$BRANCH" \
    --arg wt "$WORKTREE_DIR" --arg now "$_NOW" --arg win "$WINDOW_GROUP" \
    --arg model "$MODEL" --arg perm "$PERM_MODE" \
    '.[$name] = (.[$name] // {}) |
     .[$name].pane_id = $pid |
     .[$name].pane_target = $target |
     .[$name].tmux_session = $sess |
     .[$name].branch = $branch |
     .[$name].worktree = $wt |
     .[$name].window = $win |
     .[$name].model = $model |
     .[$name].permission_mode = $perm |
     .[$name].status = "active" |
     .[$name].session_id = ""' \
    "$REGISTRY" > "$TMP_REG" 2>/dev/null && mv "$TMP_REG" "$REGISTRY" || rm -f "$TMP_REG"
  rmdir "$_LOCK_DIR" 2>/dev/null || true
fi

if [ -n "$BOOTSTRAP_CMD_FILE" ]; then
  tmux send-keys -t "$WORKER_PANE" "bash $BOOTSTRAP_CMD_FILE"
  tmux send-keys -t "$WORKER_PANE" -H 0d
  echo "Launched worker/$WORKER in pane $WORKER_PANE (session: $TARGET_SESSION, window: $WINDOW_GROUP, worktree: $WORKTREE_DIR, custom bootstrap)"
  exit 0
fi

# Read disallowed_tools — registry first, then permissions.json fallback
DISALLOWED_TOOLS=""
if [ -f "$REGISTRY" ]; then
  _DT=$(jq -r --arg n "$WORKER" '.[$n].disallowed_tools // [] | join(",")' "$REGISTRY" 2>/dev/null || echo "")
  [ -n "$_DT" ] && DISALLOWED_TOOLS="$_DT"
fi
if [ -z "$DISALLOWED_TOOLS" ] && [ -f "$PERMS" ]; then
  _DT=$(jq -r '.disallowed_tools // [] | join(",")' "$PERMS" 2>/dev/null || echo "")
  [ -n "$_DT" ] && DISALLOWED_TOOLS="$_DT"
fi

# Launch agent (Claude or Codex)
if [ "$WORKER_RUNTIME" = "codex" ]; then
  # Use resolved CODEX_BIN from resolve-deps.sh, or fall back to PATH
  CODEX_BIN="${CODEX_BIN:-codex}"
  if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
    echo "ERROR: codex CLI not found. Install with: npm install -g @openai/codex"
    exit 1
  fi
  # Permission mapping: Claude bypassPermissions → Codex --dangerously-bypass-approvals-and-sandbox
  # Otherwise: Codex uses sandbox modes (-s workspace-write) + approval (-a on-request)
  AGENT_CMD="WORKER_NAME=$WORKER WORKER_RUNTIME=codex PROJECT_ROOT=$PROJECT_ROOT $CODEX_BIN"
  AGENT_CMD+=" -C $WORKTREE_DIR"
  AGENT_CMD+=" -m $MODEL"
  # Map reasoning_effort: Codex uses model_reasoning_effort config key
  # extra_high is a valid Codex value (maps to extended thinking)
  AGENT_CMD+=" -c model_reasoning_effort=$REASONING_EFFORT"
  if [ "$PERM_MODE" = "bypassPermissions" ]; then
    AGENT_CMD+=" --dangerously-bypass-approvals-and-sandbox"
  else
    AGENT_CMD+=" -s workspace-write -a on-request"
  fi
  AGENT_CMD+=" --no-alt-screen"
  AGENT_CMD+=" --add-dir $PROJECT_ROOT/.claude/workers/$WORKER"
  # Note: Codex has no --disallowed-tools equivalent. denyList is not enforced for Codex workers.
  # The sandbox mode provides coarser-grained permission control instead.
  tmux send-keys -t "$WORKER_PANE" "$AGENT_CMD"
  tmux send-keys -t "$WORKER_PANE" -H 0d

  # Wait for Codex TUI to be ready (poll for prompt, max 60s)
  WAIT=0
  until tmux capture-pane -t "$WORKER_PANE" -p 2>/dev/null | grep -qE '>|❯|\$'; do
    sleep 2; WAIT=$((WAIT+2))
    [ "$WAIT" -ge 60 ] && { echo "WARNING: Codex TUI timeout after 60s, proceeding anyway"; break; }
  done
  sleep 2  # extra settle time after prompt appears
else
  # Claude launch
  CLAUDE_CMD="CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME=$WORKER claude --model $MODEL --effort $REASONING_EFFORT"
  if [ "$PERM_MODE" = "bypassPermissions" ]; then
    CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
  fi
  [ -n "$DISALLOWED_TOOLS" ] && CLAUDE_CMD="$CLAUDE_CMD --disallowed-tools \"$DISALLOWED_TOOLS\""
  CLAUDE_CMD="$CLAUDE_CMD --add-dir $PROJECT_ROOT/.claude/workers/$WORKER"
  tmux send-keys -t "$WORKER_PANE" "$CLAUDE_CMD"
  tmux send-keys -t "$WORKER_PANE" -H 0d

  # Wait for Claude TUI to be ready (poll for prompt, max 60s)
  WAIT=0
  until tmux capture-pane -t "$WORKER_PANE" -p 2>/dev/null | grep -qE '❯|> $'; do
    sleep 2; WAIT=$((WAIT+2))
    [ "$WAIT" -ge 60 ] && { echo "WARNING: TUI timeout after 60s, proceeding anyway"; break; }
  done
  sleep 2  # extra settle time after prompt appears
fi

# Inject seed
# Use a named buffer with PID to prevent stale buffer reuse across invocations
LAUNCH_BUFFER_NAME="launch-${WORKER}-$$"
tmux delete-buffer -b "$LAUNCH_BUFFER_NAME" 2>/dev/null || true
if ! tmux load-buffer -b "$LAUNCH_BUFFER_NAME" "$SEED_FILE"; then
  echo "ERROR: Failed to load seed into tmux buffer"
  exit 1
fi
tmux paste-buffer -b "$LAUNCH_BUFFER_NAME" -t "$WORKER_PANE" -d
sleep 4  # large seed pastes need more settle time in Claude TUI
tmux send-keys -t "$WORKER_PANE" -H 0d

# Retry: if TUI absorbed the Enter during paste processing, send again
sleep 3
# Check if prompt is still showing (seed not submitted)
if tmux capture-pane -t "$WORKER_PANE" -p 2>/dev/null | grep -qE '❯'; then
  tmux send-keys -t "$WORKER_PANE" -H 0d
  echo "(Retried Enter for $WORKER)"
fi

echo "Launched worker/$WORKER in pane $WORKER_PANE (session: $TARGET_SESSION, window: $WINDOW_GROUP, runtime: $WORKER_RUNTIME, worktree: $WORKTREE_DIR)"
