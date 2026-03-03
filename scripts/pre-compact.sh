#!/usr/bin/env bash
# pre-compact.sh — Universal PreCompact hook.
# Detects session type (flat worker, harness agent, main session) and outputs
# contextual re-orientation content that gets injected into Claude's context
# after compaction. This helps ANY session recover critical state.
#
# Output goes to stdout. Exit 0 always. Fast (<2s, no network).
set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)

# ── Helpers ──────────────────────────────────────────────────────────────────

# Truncate a file to last N lines with a header note
truncated_cat() {
  local file="$1" max_lines="${2:-150}"
  [ ! -f "$file" ] && return
  local total
  total=$(wc -l < "$file" 2>/dev/null | tr -d ' ')
  if [ "$total" -gt "$max_lines" ]; then
    echo "(Truncated: showing last $max_lines of $total lines)"
    tail -n "$max_lines" "$file"
  else
    cat "$file"
  fi
}

# Get current git branch name
current_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""
}

# Check if CWD is a git worktree (not the main repo)
is_worktree() {
  [ -f "$(git rev-parse --show-toplevel 2>/dev/null)/.git" ] 2>/dev/null
}

# Resolve main repo root from a worktree's .git file
resolve_main_root() {
  local toplevel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || return
  if [ -f "$toplevel/.git" ]; then
    # .git is a file → worktree. Parse: "gitdir: /path/to/main/.git/worktrees/name"
    local gitdir
    gitdir=$(sed 's/gitdir: //' "$toplevel/.git" 2>/dev/null)
    echo "$gitdir" | sed 's|/.git/worktrees/.*||'
  else
    echo "$toplevel"
  fi
}

# ── Detection ────────────────────────────────────────────────────────────────

BRANCH=$(current_branch)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SESSION_TYPE=""
WORKER_NAME=""
MAIN_ROOT=""
HARNESS_NAME=""

# Priority (a): Flat worker — branch is worker/* AND in a worktree
if [[ "$BRANCH" == worker/* ]] && is_worktree 2>/dev/null; then
  SESSION_TYPE="flat-worker"
  WORKER_NAME="${BRANCH#worker/}"
  MAIN_ROOT=$(resolve_main_root)
fi

# Priority (b): Old harness agent — check pane-registry
if [ -z "$SESSION_TYPE" ]; then
  PANE_REG="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/pane-registry.json"
  if [ -f "$PANE_REG" ]; then
    # Resolve own pane via process tree walk
    OWN_PANE=""
    PANE_MAP=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null || true)
    if [ -n "$PANE_MAP" ]; then
      SEARCH_PID=$$
      while [ "$SEARCH_PID" -gt 1 ]; do
        MATCH=$(echo "$PANE_MAP" | awk -v pid="$SEARCH_PID" '$1 == pid {print $2; exit}')
        if [ -n "$MATCH" ]; then
          OWN_PANE="$MATCH"
          break
        fi
        SEARCH_PID=$(ps -o ppid= -p "$SEARCH_PID" 2>/dev/null | tr -d ' ')
      done
    fi
    if [ -n "$OWN_PANE" ]; then
      HARNESS_NAME=$(jq -r --arg pid "$OWN_PANE" '.[$pid].harness // ""' "$PANE_REG" 2>/dev/null || true)
      if [ -n "$HARNESS_NAME" ]; then
        SESSION_TYPE="harness-agent"
        MAIN_ROOT="$PROJECT_ROOT"
      fi
    fi
  fi
fi

# Priority (c): Main session (default)
if [ -z "$SESSION_TYPE" ]; then
  SESSION_TYPE="main"
  MAIN_ROOT="$PROJECT_ROOT"
fi

# ── Output ───────────────────────────────────────────────────────────────────

echo ""
echo "## Session Context (auto-injected on compaction)"
echo ""

case "$SESSION_TYPE" in

  flat-worker)
    WORKER_DIR="$MAIN_ROOT/.claude/workers/$WORKER_NAME"

    echo "### Identity"
    echo "You are worker **${WORKER_NAME}**. Worktree: \`$(pwd)\`. Branch: \`worker/${WORKER_NAME}\`."
    echo "Worker config directory: \`${WORKER_DIR}/\`"
    echo ""

    # State
    STATE_FILE="$WORKER_DIR/state.json"
    if [ -f "$STATE_FILE" ] && [ -s "$STATE_FILE" ]; then
      echo "### Current State"
      echo '```json'
      cat "$STATE_FILE"
      echo '```'
      echo ""
    fi

    # Memory
    MEMORY_FILE="$WORKER_DIR/MEMORY.md"
    if [ -f "$MEMORY_FILE" ] && [ -s "$MEMORY_FILE" ]; then
      echo "### Accumulated Knowledge"
      echo "This is YOUR persistent memory from previous cycles. Read it carefully:"
      echo ""
      truncated_cat "$MEMORY_FILE" 150
      echo ""
    fi

    # Tools reminder — MCP handles messaging, tasks, inbox, commits, state
    echo "### Tools"
    echo "Use \`mcp__worker-fleet__*\` MCP tools for messaging, tasks, inbox, commits, state, and deploy signals."
    echo "Deploy: \`./scripts/deploy.sh --skip-langfuse --service static|web\` (test). Never \`--service core\` without Warren approval."
    echo ""

    # Mission reminder
    MISSION_FILE="$WORKER_DIR/mission.md"
    echo "### Key Reminders"
    if [ -f "$MISSION_FILE" ]; then
      echo "- Re-read your full mission: \`${MISSION_FILE}\`"
    fi
    echo "- Re-read MEMORY.md for discoveries and progress: \`${MEMORY_FILE}\`"
    echo "- Update MEMORY.md with new discoveries before context fills up again"
    echo "- Update state.json after each cycle (cycles_completed++, issues_found/fixed)"
    echo "- NEVER checkout main. Stay on branch \`worker/${WORKER_NAME}\`"
    echo "- Stage only specific files (never \`git add -A\`)"
    echo "- Post-commit hook auto-notifies Warren"
    echo "- Re-read CLAUDE.md and .claude/CLAUDE.md for project instructions and credentials"
    ;;

  harness-agent)
    HARNESS_DIR="$MAIN_ROOT/.claude/harness/$HARNESS_NAME"

    echo "### Identity"
    echo "You are a harness agent: **${HARNESS_NAME}**. CWD: \`$(pwd)\`."
    if [ -d "$HARNESS_DIR" ]; then
      echo "Harness directory: \`${HARNESS_DIR}/\`"
    fi
    echo ""

    # Try to find agent-specific MEMORY.md (module-manager or worker)
    MEMORY_FILE=""
    if [ -d "$HARNESS_DIR/agents/module-manager" ] && [ -f "$HARNESS_DIR/agents/module-manager/MEMORY.md" ]; then
      MEMORY_FILE="$HARNESS_DIR/agents/module-manager/MEMORY.md"
    fi
    # Check pane registry for worker-specific path
    if [ -n "${OWN_PANE:-}" ] && [ -f "${PANE_REG:-}" ]; then
      AGENT_ROLE=$(jq -r --arg pid "$OWN_PANE" '.[$pid].agent_role // ""' "$PANE_REG" 2>/dev/null || true)
      TASK_NAME=$(jq -r --arg pid "$OWN_PANE" '.[$pid].task // ""' "$PANE_REG" 2>/dev/null || true)
      if [ -n "$AGENT_ROLE" ]; then
        echo "Agent role: **${AGENT_ROLE}**"
      fi
      if [ -n "$TASK_NAME" ]; then
        echo "Current task: ${TASK_NAME}"
      fi
      # Worker MEMORY.md might be under agents/worker/{name}/
      if [ -n "$TASK_NAME" ] && [ -f "$HARNESS_DIR/agents/worker/$TASK_NAME/MEMORY.md" ]; then
        MEMORY_FILE="$HARNESS_DIR/agents/worker/$TASK_NAME/MEMORY.md"
      fi
    fi
    echo ""

    # Harness tasks
    TASKS_FILE="$HARNESS_DIR/tasks.json"
    if [ -f "$TASKS_FILE" ] && [ -s "$TASKS_FILE" ]; then
      echo "### Tasks Summary"
      echo '```json'
      # Show just status counts, not full task dump
      jq -c '[.tasks[]? | .status] | group_by(.) | map({(.[0]): length}) | add // {}' "$TASKS_FILE" 2>/dev/null || cat "$TASKS_FILE" | head -20
      echo '```'
      echo ""
    fi

    # Memory
    if [ -n "$MEMORY_FILE" ] && [ -f "$MEMORY_FILE" ] && [ -s "$MEMORY_FILE" ]; then
      echo "### Accumulated Knowledge"
      echo "This is your persistent memory. Read it carefully:"
      echo ""
      truncated_cat "$MEMORY_FILE" 150
      echo ""
    fi

    echo "### Key Reminders"
    echo "- Re-read harness files: \`${HARNESS_DIR}/harness.md\` and \`${HARNESS_DIR}/acceptance.md\`"
    if [ -n "$MEMORY_FILE" ]; then
      echo "- Re-read MEMORY.md: \`${MEMORY_FILE}\`"
    fi
    echo "- Re-read CLAUDE.md and .claude/CLAUDE.md for project instructions and credentials"
    echo "- Update MEMORY.md with new discoveries before context fills up again"
    echo "- Check inbox.jsonl for any new messages"
    ;;

  main)
    PROJECT_NAME=$(basename "$MAIN_ROOT")

    echo "You are Warren's main Claude session."
    echo "Project: **${PROJECT_NAME}** (\`${MAIN_ROOT}\`)"
    echo ""

    # Compute the project slug for auto-memory path
    # Claude Code uses path with / → - and keeps the leading dash
    PROJECT_SLUG=$(echo "$MAIN_ROOT" | sed 's|/|-|g')
    MEMORY_PATH="$HOME/.claude/projects/${PROJECT_SLUG}/memory/MEMORY.md"

    echo "### Key Files to Re-read"
    echo "- \`${MAIN_ROOT}/CLAUDE.md\` -- project instructions"
    echo "- \`${MAIN_ROOT}/.claude/CLAUDE.md\` -- credentials and infrastructure"
    if [ -f "$MEMORY_PATH" ]; then
      echo "- \`${MEMORY_PATH}\` -- auto-memory (persistent across sessions)"
    fi
    echo ""

    # Show last few lines of auto-memory as quick context
    if [ -f "$MEMORY_PATH" ] && [ -s "$MEMORY_PATH" ]; then
      echo "### Recent Memory (last 50 lines)"
      echo ""
      tail -n 50 "$MEMORY_PATH" 2>/dev/null || true
      echo ""
    fi

    echo "### Reminders"
    echo "- Check these files to recover any context lost during compaction"
    echo "- If workers are running, check their status: \`bash .claude/scripts/check-workers.sh\` (if available)"
    echo "- Git branch: \`${BRANCH}\`, CWD: \`$(pwd)\`"
    ;;
esac

exit 0
