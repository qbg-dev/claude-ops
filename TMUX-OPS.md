# Tmux Agent Operations Reference

> Detailed operational patterns for spawning, monitoring, and recovering Claude agents in tmux.
> Moved from `~/.claude/CLAUDE.md` to reduce always-loaded context.

## Spawning a New Claude Agent

Do NOT use `cdo -p "prompt"`. Instead: launch `cdo` bare, wait for it to load,
then send the seed prompt via `tmux send-keys -l`. Why? `-p` causes shell escaping
issues with multi-line prompts and doesn't let the agent fully initialize first.

**IMPORTANT:** Always use `-d` flag with `tmux new-window` and `tmux split-window`
to avoid switching the user's focus to the new pane.

```bash
PANE="h:myagent.0"
PROJECT="/path/to/project"

# 1. Create pane — use -d to stay in current pane
tmux new-window -d -t h -n myagent -c "$PROJECT"

# 2. Launch claude with allowedTools from permissions.json (no bypass mode)
ALLOWED=$(jq -r '(.allowedTools // []) | join(",")' "$PERMS" 2>/dev/null || echo "")
CLAUDE_CMD="claude --model $(jq -r '.model // "sonnet"' "$PERMS" 2>/dev/null)"
[ -n "$ALLOWED" ] && CLAUDE_CMD="$CLAUDE_CMD --allowedTools \"$ALLOWED\""
tmux send-keys -t "$PANE" "$CLAUDE_CMD"
tmux send-keys -t "$PANE" -H 0d  # hex Enter — NEVER literal Enter

# 3. Wait for TUI to initialize (12s typical)
sleep 12
# Verify loaded:
tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -q "bypass permissions" || echo "WARN: TUI not ready"

# 4. Paste seed via load-buffer (handles multi-line safely)
bash .claude/scripts/my-harness-seed.sh > /tmp/my-seed.txt
tmux load-buffer /tmp/my-seed.txt
tmux paste-buffer -t "$PANE"
sleep 2
tmux send-keys -t "$PANE" -H 0d  # submit
```

## Recovery Patterns

### Agent stuck or unresponsive

```bash
PANE="h:myagent.0"
tmux capture-pane -t "$PANE" -p | grep -v '^$' | tail -10

# Try Escape first
tmux send-keys -t "$PANE" Escape

# If still stuck, kill claude process (keeps shell alive)
SHELL_PID=$(tmux display-message -t "$PANE" -p '#{pane_pid}')
CLAUDE_PID=$(pgrep -P "$SHELL_PID" | head -1)
[ -n "$CLAUDE_PID" ] && kill "$CLAUDE_PID"
sleep 3
# Relaunch cdo
```

### Pane dead / window closed

```bash
tmux new-window -d -t h -n myagent -c "$PROJECT"
# Start over from spawning step 1
```

### Agent doing the wrong thing

```bash
tmux send-keys -t "$PANE" Escape
sleep 2
tmux send-keys -t "$PANE" "Stop. Re-read the harness MD and resume from the current task."
tmux send-keys -t "$PANE" -H 0d
```

### Git index.lock from concurrent agents

Multiple agents sharing the same repo checkout can collide on `.git/index.lock`:

```bash
# Check if stale (no process holding it)
lsof .git/index.lock 2>/dev/null || rm .git/index.lock
```

**Prevention:** Workers should run in git worktrees (`../Wechat-{worker}/`) — each worktree has its own `.git` index, so no lock contention.

---

## Worker Worktree Launch Pattern

Module-managers launch workers in isolated git worktrees. This prevents git lock conflicts and ensures branch isolation.

```bash
WORKER="wo-fullchain"
MODULE="mod-ops"
BRANCH="${MODULE}/${WORKER}"
WORKTREE_DIR="${PROJECT_ROOT}/../Wechat-${WORKER}"

# 1. Create worktree (idempotent)
if [ ! -d "$WORKTREE_DIR" ]; then
  git -C "$PROJECT_ROOT" worktree add "$WORKTREE_DIR" "$BRANCH" 2>/dev/null || \
  git -C "$PROJECT_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" 2>/dev/null
fi

# 2. Read worker permissions
PERMS="$PROJECT_ROOT/.claude/harness/${MODULE}/agents/worker/${WORKER}/permissions.json"
MODEL=$(jq -r '.model // "sonnet"' "$PERMS")
ALLOWED=$(jq -r '(.allowedTools // []) | join(",")' "$PERMS")

# 3. Create pane IN the module manager's window — capture pane ID directly
WORKER_PANE=$(tmux split-window -P -F "#{pane_id}" -d -t "h:${MODULE}" -v -c "$WORKTREE_DIR")
[ -z "$WORKER_PANE" ] && echo "ERROR: split-window failed" && exit 1

# 4. Start Claude with worker permissions (no bypass — allowedTools enforces limits)
CLAUDE_CMD="claude --model $MODEL"
[ -n "$ALLOWED" ] && CLAUDE_CMD="$CLAUDE_CMD --allowedTools $ALLOWED"
CLAUDE_CMD="$CLAUDE_CMD --add-dir ${PROJECT_ROOT}/.claude/harness/${MODULE}"
tmux send-keys -t "$WORKER_PANE" "$CLAUDE_CMD"
tmux send-keys -t "$WORKER_PANE" -H 0d
sleep 10  # wait for TUI

# 5. Feed seed
SEED_FILE="/tmp/worker-${WORKER}-seed.txt"
cat > "$SEED_FILE" << WSEED
You are worker ${WORKER} for module ${MODULE}.
Working in worktree: ${WORKTREE_DIR} (branch: ${BRANCH})
Harness files at: ${PROJECT_ROOT}/.claude/harness/${MODULE}/
Read: mission.md, state.json, inbox.jsonl
Commit to YOUR branch. After each task: update state.json + save learnings to auto-memory.
WSEED
tmux load-buffer "$SEED_FILE"
tmux paste-buffer -t "$WORKER_PANE"
sleep 2
tmux send-keys -t "$WORKER_PANE" -H 0d
```

**Key points:**
- `-d` flag on `split-window` prevents focus switch
- `-c "$WORKTREE_DIR"` sets the pane's working directory
- `--add-dir` gives worker read access to harness files in the main repo
- Workers commit to their own branch, never to main

## Monitor Agent

```bash
bash ~/.claude-ops/scripts/monitor-agent.sh --pane <monitor-pane> <target-pane> [interval] [mission]
```

Launches a full Claude Code Opus session that polls the target pane every N seconds.
Detects idle/stuck agents, analyzes their output, sends signed nudges.
Every 6 captures, fires a REFLECT event for meta-reflection.
Sets pane titles: monitor shows `MONITOR→{target}`, target shows `MONITORED by {monitor}`.

Stop: `bash ~/.claude-ops/scripts/monitor-agent.sh --stop <target-pane>`

**CRITICAL: `--pane` must match where the monitor session actually runs.**
Always resolve the pane ID from within the monitor pane itself at launch time
(use the pane discovery script from `~/.claude/CLAUDE.md`).
