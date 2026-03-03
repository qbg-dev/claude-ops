#!/usr/bin/env bash
# launch-flat-worker.sh — Launch a flat worker agent in its own tmux window.
# Generic upstream version — works with any project that has .claude/workers/{name}/.
#
# Usage: bash launch-flat-worker.sh <WORKER> [--window <win>] [--project <root>]
# Example: bash launch-flat-worker.sh dashboard-fix
#          bash launch-flat-worker.sh my-worker --project /path/to/repo
set -euo pipefail

WORKER="${1:?WORKER name required (e.g. dashboard-fix, chief-of-staff)}"
shift

# Defaults
TARGET_SESSION="w"
PROJECT_ROOT="${PROJECT_ROOT:-}"

# Parse optional args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) TARGET_SESSION="$2"; shift 2 ;;
    --project) PROJECT_ROOT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Auto-detect project root if not provided
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

PROJECT_NAME="$(basename "$PROJECT_ROOT")"
WORKER_DIR="$PROJECT_ROOT/.claude/workers/$WORKER"
PERMS="$WORKER_DIR/permissions.json"
BRANCH="worker/$WORKER"
WORKTREE_DIR="$PROJECT_ROOT/../${PROJECT_NAME}-w-$WORKER"

[ ! -d "$WORKER_DIR" ] && { echo "ERROR: worker dir not found: $WORKER_DIR"; exit 1; }

# Read permissions
MODEL=$(jq -r '.model // "sonnet"' "$PERMS" 2>/dev/null || echo "sonnet")

# Ensure tmux session exists
if ! tmux has-session -t "$TARGET_SESSION" 2>/dev/null; then
  tmux new-session -d -s "$TARGET_SESSION" -n "$WORKER" -c "$PROJECT_ROOT"
  CREATED_SESSION=1
else
  CREATED_SESSION=0
fi

# Worktree
if [ ! -d "$WORKTREE_DIR" ]; then
  echo "Creating worktree at $WORKTREE_DIR on branch $BRANCH..."
  git -C "$PROJECT_ROOT" worktree add "$WORKTREE_DIR" "$BRANCH" 2>/dev/null || \
  git -C "$PROJECT_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" 2>/dev/null
fi

# Copy untracked config files that worktrees don't inherit from git
for UNTRACKED_CFG in .mcp.json; do
  if [ -f "$PROJECT_ROOT/$UNTRACKED_CFG" ] && [ ! -f "$WORKTREE_DIR/$UNTRACKED_CFG" ]; then
    cp "$PROJECT_ROOT/$UNTRACKED_CFG" "$WORKTREE_DIR/$UNTRACKED_CFG"
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

# Seed file
SEED_FILE="/tmp/worker-${WORKER}-seed.txt"
cat > "$SEED_FILE" << WSEED
You are worker **$WORKER**.
Worktree: $WORKTREE_DIR (branch: $BRANCH)
Worker config: $PROJECT_ROOT/.claude/workers/$WORKER/

Read these files NOW in this order:
1. $WORKER_DIR/mission.md — your goals and tasks
2. $WORKER_DIR/state.json — current cycle count and status
3. $WORKER_DIR/MEMORY.md — what you learned in previous cycles

Then begin your cycle immediately.

## Cycle Pattern

Every cycle follows this sequence:

1. **Drain inbox** — \`read_inbox(clear=true)\` — act on messages before anything else
2. **Check tasks** — \`list_tasks(filter="pending")\` — find highest-priority unblocked work
3. **Claim** — \`claim_task("T00N")\` — mark what you're working on
4. **Do the work** — investigate, fix, test, commit, deploy, verify
5. **Complete** — \`complete_task("T00N")\` — only after fully verified
6. **Update state** — \`update_state("cycles_completed", N+1)\` then \`update_state("last_cycle_at", ISO)\`
7. **Perpetual?** — if \`perpetual: true\`, sleep for \`sleep_duration\` seconds, then loop

If your inbox has a message from Warren or chief-of-staff, prioritize it over your current task list.

## MCP Tools (\`mcp__worker-fleet__*\`)

| Tool | What it does |
|------|-------------|
| \`send_message(to, content, summary)\` | Send to a worker, "parent", or raw pane ID "%NN" |
| \`broadcast(content, summary)\` | Send to ALL workers (use sparingly) |
| \`read_inbox(limit?, since?, clear?)\` | Read your inbox; \`clear=true\` truncates after reading |
| \`create_task(subject, priority?, ...)\` | Add a task to your task list |
| \`claim_task(task_id)\` | Assign a task to yourself, set in_progress |
| \`complete_task(task_id)\` | Mark done (recurring tasks auto-reset) |
| \`list_tasks(filter?, worker?)\` | List tasks; \`worker="all"\` for cross-worker view |
| \`get_worker_state(name?)\` | Read any worker's state.json |
| \`update_state(key, value)\` | Update your state.json + emit bus event |
| \`fleet_status()\` | Full fleet overview (all workers) |
| \`deploy(service?)\` | Deploy to TEST server + auto health check. \`static\` (default), \`web\`, or \`all\` |
| \`health_check(target?)\` | Check server health: \`test\` (default), \`prod\`, or \`both\` |
| \`smart_commit(message, files?, ...)\` | Commit with format validation; \`merge_request=true\` to signal chief-of-staff |
| \`post_to_nexus(message, room?)\` | Post to Nexus chat (prefixed with your name) |
| \`recycle(message?)\` | Self-recycle: write handoff, restart fresh with new context |
| \`spawn_child(task?)\` | Fork yourself into a new pane to the right |
| \`register_pane()\` | Register this pane in pane-registry (after recycle/manual launch) |
| \`check_config()\` | Run diagnostics on worker config — fix issues it reports |

These are native MCP tool calls — no bash wrappers needed.

## Rules
- **Fix everything.** Never just report issues — investigate, fix, deploy, document in MEMORY.md.
- **Git discipline**: Stage only specific files (\`git add src/foo.ts\`). NEVER \`git add -A\`. Commit to branch **$BRANCH** only. Never checkout main.
- **Deploy**: TEST only. \`smart_commit\` then \`deploy(service="static")\`. The deploy tool auto-checks health. Never \`core\` without Warren approval.
- **Verify before completing**: Tests pass + TypeScript clean + deploy succeeds + endpoint/UI verified.
- **Perpetual workers**: Read $PROJECT_ROOT/.claude/workers/PERPETUAL-PROTOCOL.md on your first cycle for self-optimization guidance.
WSEED

# Create tmux window for this worker (or reuse if session was just created)
if [ "$CREATED_SESSION" -eq 1 ]; then
  # Session was just created with a default window — rename it
  WORKER_PANE=$(tmux list-panes -t "$TARGET_SESSION" -F '#{pane_id}' | head -1)
  tmux rename-window -t "$TARGET_SESSION" "$WORKER"
  tmux send-keys -t "$WORKER_PANE" "cd $WORKTREE_DIR"
  tmux send-keys -t "$WORKER_PANE" -H 0d
else
  # Create new window in existing session
  WORKER_PANE=$(tmux new-window -t "$TARGET_SESSION" -n "$WORKER" -c "$WORKTREE_DIR" -d -P -F '#{pane_id}')
fi

tmux select-pane -T "$WORKER" -t "$WORKER_PANE"

# Register worker pane in pane-registry
PANE_REG="${HOME}/.claude-ops/state/pane-registry.json"
if [ -f "$PANE_REG" ]; then
  _PANE_TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
    | awk -v p="$WORKER_PANE" '$1==p{print $2}' 2>/dev/null || echo "")
  # Update pane registry with worker info
  TMP_REG=$(mktemp)
  jq --arg pid "$WORKER_PANE" --arg name "$WORKER" --arg target "${_PANE_TARGET:-}" \
    --arg proj "$PROJECT_ROOT" --arg sess "$TARGET_SESSION" \
    '.[$pid] = {"harness": ("worker/" + $name), "session_name": $name, "display": $name, "task": "worker", "done": 0, "total": 0, "pane_target": $target, "project_root": $proj, "tmux_session": $sess}' \
    "$PANE_REG" > "$TMP_REG" 2>/dev/null && mv "$TMP_REG" "$PANE_REG" || rm -f "$TMP_REG"
fi

# Launch Claude
CLAUDE_CMD="claude --model $MODEL --dangerously-skip-permissions"
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

# Inject seed
tmux load-buffer "$SEED_FILE"
tmux paste-buffer -t "$WORKER_PANE"
sleep 2
tmux send-keys -t "$WORKER_PANE" -H 0d

echo "Launched worker/$WORKER in pane $WORKER_PANE (session: $TARGET_SESSION, worktree: $WORKTREE_DIR)"
