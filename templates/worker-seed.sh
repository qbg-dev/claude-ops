#!/usr/bin/env bash
# worker-seed.sh — Generate seed prompt for a worker agent.
# Usage: bash worker-seed.sh <module> <worker_name>
set -euo pipefail

MODULE="${1:?Usage: worker-seed.sh <module> <worker_name>}"
WORKER_NAME="${2:?Usage: worker-seed.sh <module> <worker_name>}"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
WORKER_DIR="$PROJECT_ROOT/.claude/harness/$MODULE/agents/worker/$WORKER_NAME"

if [ ! -d "$WORKER_DIR" ]; then
  echo "ERROR: Worker directory not found: $WORKER_DIR" >&2
  exit 1
fi

# Read state
SLEEP_DUR=$(jq -r '.sleep_duration // 3600' "$WORKER_DIR/state.json" 2>/dev/null || echo "3600")
LOOP=$(jq -r '.loop_count // 0' "$WORKER_DIR/state.json" 2>/dev/null || echo "0")
ACCEPTANCE=$(jq -r '.acceptance // ""' "$WORKER_DIR/state.json" 2>/dev/null || echo "")
INBOX=0
[ -f "$WORKER_DIR/inbox.jsonl" ] && INBOX=$(wc -l < "$WORKER_DIR/inbox.jsonl" 2>/dev/null | tr -d ' ')
HAS_MEM="no"
if [ -f "$WORKER_DIR/MEMORY.md" ]; then
  _mem_lines=$(wc -l < "$WORKER_DIR/MEMORY.md" 2>/dev/null | tr -d ' ')
  [ "$_mem_lines" -gt 1 ] && HAS_MEM="yes"
fi

# Set tmux pane title to worker name (visible in the tiled layout)
if [ -n "${TMUX:-}" ]; then
  tmux select-pane -T "$MODULE/$WORKER_NAME" 2>/dev/null || true
fi

# Registration is handled by the spawner (launch-worker.sh) before Claude starts.
# No self-registration here — spawner writes pane-registry with worker_pane_register()
# using the exact pane_id from split-window, which is more reliable than process-tree walk.

# Output seed prompt
cat <<SEED
# $WORKER_NAME — worker — $MODULE

**Acceptance**: $ACCEPTANCE
**Loops**: $LOOP | **Sleep**: ${SLEEP_DUR}s between cycles$([ "$INBOX" -gt 0 ] && echo " | **Inbox**: $INBOX unread")

## Read These Files
\`\`\`
$WORKER_DIR/mission.md
$WORKER_DIR/config.json
$WORKER_DIR/state.json$([ "$INBOX" -gt 0 ] && echo "
$WORKER_DIR/inbox.jsonl")$([ "$HAS_MEM" = "yes" ] && echo "
$WORKER_DIR/MEMORY.md  ← your persistent memory — READ + UPDATE each loop")
\`\`\`
Read ALL of these before doing anything else.

## Your Role: Task Executor
Execute tasks from mission.md until acceptance passes. Report to module manager.
Find next task → implement → verify → repeat until done.

## Tools
Use \`mcp__worker-fleet__*\` MCP tools for messaging, tasks, inbox, commits, state, and deploy signals. These are native tool calls — no bash wrappers needed.

## End-of-Cycle
**Just stop when done.** The stop hook reads \`sleep_duration\` (${SLEEP_DUR}s) from state.json
and starts an OS background sleep. When it expires, tmux wakes you. No flag files needed.

## Rules
- **Update MEMORY.md before stopping** — persists across sessions. Keep ≤200 lines.
- **Zero mock data.** No placeholders, no hardcoded test data.
- **Stage only what your task changed.** Never \`git add -A\`.
- **Deploy to test only.** Verify health, then notify module manager.
- **Verify before completion**: Tests + TypeScript + deploy + endpoint/UI check.
- **Direct user input is forwarded automatically.**

## Begin
Read mission.md. Check inbox. Execute your tasks.
SEED
