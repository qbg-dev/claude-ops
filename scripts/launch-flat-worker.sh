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
1. $WORKER_DIR/mission.md — your mission
2. $WORKER_DIR/state.json — current state
3. $WORKER_DIR/MEMORY.md — accumulated knowledge

Then begin your mission loop immediately.

## CRITICAL: FIX EVERYTHING
**Never just report issues — FIX THEM.** If you find a bug, broken endpoint, missing data, or any issue:
1. Investigate root cause immediately
2. Write the fix
3. Deploy to test -> verify -> deploy to prod
4. Document what you fixed in MEMORY.md
Reporting without fixing is FAILURE. You have full deploy access. Use it.

## Git discipline
- Stage only the specific files you changed: \`git add src/foo.ts src/bar.ts\`
- NEVER \`git add -A\` or \`git add .\` — catches unrelated/config/temp files
- Commit to branch **$BRANCH** only. Never \`git checkout main\` or merge.
- After each cycle: update state.json (cycles_completed++, last_cycle_at, issues_found/fixed)
- **Auto-notification**: A post-commit hook is installed — Warren is automatically notified when you commit. No manual notification needed.

## Respawn control
Your \`state.json\` controls watchdog respawn behavior:
- \`perpetual: true\` + \`sleep_duration: N\` → watchdog waits N seconds after you stop, then respawns you
- \`perpetual: false\` → watchdog NEVER respawns you (one-shot mode)

When updating state.json at end of each cycle, reconsider \`sleep_duration\` based on urgency:
- Monitoring / critical fixes: 1800 (30 min)
- Active bug-fix cycles: 3600–7200 (1–2h)
- Optimization / periodic review: 10800–14400 (3–4h)
- Task fully complete, no follow-up needed: set \`perpetual: false\`

You can update \`sleep_duration\` mid-mission as task urgency evolves.

## Deploy protocol (MANDATORY)
- Deploy to TEST first: \`./scripts/deploy.sh --skip-langfuse [--service static|web]\`
- Verify on test, THEN deploy to PROD: \`echo y | ./scripts/deploy-prod.sh --skip-langfuse --service <static|web>\`
- NEVER use \`--service core\` or \`--service all\` without Warren approval
- Use \`--service static\` for UI-only changes (zero downtime)
- Use \`--service web\` for backend API changes (chatbot stays up)

## End-to-end verification (REQUIRED before marking any task done)
1. **Tests**: \`bun test\` (or targeted test file)
2. **TypeScript**: \`bunx tsc --noEmit\` on changed files
3. **Deploy to test**: \`./scripts/deploy.sh --service <static|web> --skip-langfuse\`
4. **Verify endpoint** (backend): \`curl -sf https://test.<domain>/api/v1/<endpoint> | jq .\`
5. **Autologin + verify** (UI): use the project's autologin flow
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
    '.[$pid] = {"harness": ("worker/" + $name), "session_name": $name, "display": $name, "task": "worker", "done": 0, "total": 0, "pane_target": $target}' \
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
