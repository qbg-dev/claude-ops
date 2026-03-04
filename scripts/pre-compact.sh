#!/usr/bin/env bash
# pre-compact.sh — PreCompact hook for flat workers.
# Detects if session is a flat worker (branch: worker/* in a worktree) and injects
# contextual re-orientation content into Claude's context after compaction.
#
# Non-worker sessions: exits silently (no output).
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

# Override: resolve identity from pane-registry using SESSION_ID.
# Authoritative when Claude Code runs the hook from a wrong CWD.
PANE_REGISTRY="${HARNESS_STATE_DIR:-$HOME/.boring/state}/pane-registry.json"
if [ -n "$SESSION_ID" ] && [ -f "$PANE_REGISTRY" ]; then
  _REG_WORKER_NAME=$(jq -r --arg sid "$SESSION_ID" \
    '[.panes | to_entries[] | select(.value.session_id == $sid)] | first | .value.worker // ""' \
    "$PANE_REGISTRY" 2>/dev/null || echo "")
  _REG_PROJECT_ROOT=""
  if [ -n "$_REG_WORKER_NAME" ]; then
    _REG_PROJECT_ROOT=$(jq -r --arg wn "$_REG_WORKER_NAME" \
      '[.workers | to_entries[] | select(.key | endswith(":" + $wn))] | first | .value.project_root // ""' \
      "$PANE_REGISTRY" 2>/dev/null || echo "")
  fi
  # Fallback: flat entries
  if [ -z "$_REG_WORKER_NAME" ]; then
    _REG_HARNESS=$(jq -r --arg sid "$SESSION_ID" \
      '[to_entries[] | select(.key | startswith("%")) | select(.value.session_id == $sid)] | first | .value.harness // ""' \
      "$PANE_REGISTRY" 2>/dev/null || echo "")
    [ -z "$_REG_PROJECT_ROOT" ] && _REG_PROJECT_ROOT=$(jq -r --arg sid "$SESSION_ID" \
      '[to_entries[] | select(.key | startswith("%")) | select(.value.session_id == $sid)] | first | .value.project_root // ""' \
      "$PANE_REGISTRY" 2>/dev/null || echo "")
    if [[ "${_REG_HARNESS:-}" == worker/* ]]; then
      _REG_WORKER_NAME="${_REG_HARNESS#worker/}"
    fi
  fi
  if [ -n "$_REG_WORKER_NAME" ]; then
    _PARENT=$(dirname "${_REG_PROJECT_ROOT:-.}")
    _BASE=$(basename "${_REG_PROJECT_ROOT:-.}")
    _WT="${_PARENT}/${_BASE}-w-${_REG_WORKER_NAME}"
    if [ -d "$_WT" ]; then
      PROJECT_ROOT="$_WT"
      BRANCH=$(git -C "$_WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "worker/$_REG_WORKER_NAME")
    else
      BRANCH="worker/$_REG_WORKER_NAME"
    fi
  fi
fi

# v3 flat worker fallback: pane-registry.json doesn't store session_id for v3 workers.
# If identity wasn't resolved above, scan $PROJECT_ROOT/.claude/workers/registry.json.
if [ -n "$SESSION_ID" ] && [[ "$BRANCH" != worker/* ]]; then
  _V3_REG="$PROJECT_ROOT/.claude/workers/registry.json"
  if [ -f "$_V3_REG" ]; then
    _V3_NAME=$(jq -r --arg sid "$SESSION_ID" \
      'to_entries[] | select(.value.session_id == $sid) | .key' \
      "$_V3_REG" 2>/dev/null | head -1)
    if [ -n "$_V3_NAME" ] && [ "$_V3_NAME" != "null" ]; then
      _PARENT=$(dirname "$PROJECT_ROOT")
      _BASE=$(basename "$PROJECT_ROOT")
      _WT="${_PARENT}/${_BASE}-w-${_V3_NAME}"
      if [ -d "$_WT" ]; then
        PROJECT_ROOT="$_WT"
        BRANCH=$(git -C "$_WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "worker/$_V3_NAME")
      else
        BRANCH="worker/$_V3_NAME"
      fi
    fi
  fi
fi

# Only fire for flat workers (branch: worker/* in a worktree)
[[ "$BRANCH" == worker/* ]] && is_worktree 2>/dev/null || exit 0

WORKER_NAME="${BRANCH#worker/}"
MAIN_ROOT=$(resolve_main_root)
WORKER_DIR="$MAIN_ROOT/.claude/workers/$WORKER_NAME"

# ── Output ───────────────────────────────────────────────────────────────────

echo ""
echo "## Session Context (auto-injected on compaction)"
echo ""

echo "### Identity"
echo "You are worker **${WORKER_NAME}**. Worktree: \`$(pwd)\`. Branch: \`worker/${WORKER_NAME}\`."
echo "Worker config directory: \`${WORKER_DIR}/\`"
echo ""

# State — prefer registry.json (v3 workers), fall back to state.json (legacy)
REGISTRY_FILE="$MAIN_ROOT/.claude/workers/registry.json"
if [ -f "$REGISTRY_FILE" ]; then
  REGISTRY_ENTRY=$(jq -r --arg name "$WORKER_NAME" '.[$name] // empty' "$REGISTRY_FILE" 2>/dev/null || true)
fi
if [ -n "${REGISTRY_ENTRY:-}" ] && [ "$REGISTRY_ENTRY" != "null" ]; then
  echo "### Current State (from registry.json)"
  echo '```json'
  echo "$REGISTRY_ENTRY"
  echo '```'
  echo ""
else
  STATE_FILE="$WORKER_DIR/state.json"
  if [ -f "$STATE_FILE" ] && [ -s "$STATE_FILE" ]; then
    echo "### Current State (from state.json)"
    echo '```json'
    cat "$STATE_FILE"
    echo '```'
    echo ""
  fi
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

# Tools reminder
echo "### Tools"
echo "Use \`mcp__worker-fleet__*\` MCP tools for messaging, tasks, inbox, commits, state, and deploy signals."
echo "Deploy: \`./scripts/deploy.sh --skip-langfuse --service static|web\` (test). Never \`--service core\` without Warren approval."
echo ""

# Mission — show CURRENT PRIORITY section if present, else first 60 lines
MISSION_FILE="$WORKER_DIR/mission.md"
if [ -f "$MISSION_FILE" ] && [ -s "$MISSION_FILE" ]; then
  echo "### Mission (compact)"
  echo "Re-read full mission: \`${MISSION_FILE}\`"
  echo ""
  # Try to extract CURRENT PRIORITY section
  CURRENT_PRIORITY=$(awk '/^## CURRENT PRIORITY/{found=1} found{print} found && /^## / && !/^## CURRENT PRIORITY/{exit}' "$MISSION_FILE" 2>/dev/null | head -30)
  if [ -n "$CURRENT_PRIORITY" ]; then
    echo "$CURRENT_PRIORITY"
    echo ""
    echo "(Showing CURRENT PRIORITY section. Read full mission for complete context.)"
  else
    head -60 "$MISSION_FILE"
    echo ""
    echo "(Truncated. Read full file for complete mission.)"
  fi
  echo ""
fi

# In-progress tasks
TASKS_FILE="$WORKER_DIR/tasks.json"
if [ -f "$TASKS_FILE" ] && [ -s "$TASKS_FILE" ]; then
  IN_PROGRESS=$(jq -r 'to_entries[] | select(.value.status == "in_progress") | "  [\(.key)] \(.value.subject)"' "$TASKS_FILE" 2>/dev/null || true)
  PENDING=$(jq -r '[to_entries[] | select(.value.status == "pending")] | length' "$TASKS_FILE" 2>/dev/null || echo "0")
  if [ -n "$IN_PROGRESS" ]; then
    echo "### In-Progress Tasks (resume these first)"
    echo "$IN_PROGRESS"
    echo "($PENDING pending tasks also queued)"
    echo ""
  fi
fi

echo "### Key Reminders"
echo "- Drain inbox first: \`read_inbox(clear=true)\`"
echo "- Update memory: \`write_memory(mode='replace_section', section='...', content='...')\` or edit \`${MEMORY_FILE}\`"
echo "- Update state: \`update_state('cycles_completed', N)\` — NOT state.json (deprecated)"
echo "- NEVER checkout main. Stay on branch \`worker/${WORKER_NAME}\`"
echo "- Stage only specific files (never \`git add -A\`)"
echo "- Post-commit hook auto-notifies Warren"
echo "- Re-read CLAUDE.md and .claude/CLAUDE.md for project instructions and credentials"

exit 0
