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
PANE_REGISTRY="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/pane-registry.json"
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
  _V3_PROJECT=$(basename "$PROJECT_ROOT")
  _V3_REG="$HOME/.claude/fleet/${_V3_PROJECT}/registry.json"
  # Fallback to legacy path
  [ ! -f "$_V3_REG" ] && _V3_REG="$PROJECT_ROOT/.claude/workers/registry.json"
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

# Only fire for flat workers (branch: worker/* in a worktree).
# Use PROJECT_ROOT (already resolved via pane-registry above) rather than CWD-based is_worktree(),
# which would incorrectly return false when the hook fires from the main repo directory.
[[ "$BRANCH" == worker/* ]] && [ -f "$PROJECT_ROOT/.git" ] || exit 0

WORKER_NAME="${BRANCH#worker/}"
MAIN_ROOT=$(resolve_main_root)

# Fleet v2 path resolution: ~/.claude/fleet/{project}/{worker}/
# Project name = basename of main repo root (e.g., "Wechat")
_PROJECT_NAME=$(basename "$MAIN_ROOT")
_FLEET_DIR="$HOME/.claude/fleet/${_PROJECT_NAME}/${WORKER_NAME}"
_LEGACY_DIR="$MAIN_ROOT/.claude/workers/$WORKER_NAME"

# Prefer fleet v2 dir, fallback to legacy
if [ -d "$_FLEET_DIR" ]; then
  WORKER_DIR="$_FLEET_DIR"
else
  WORKER_DIR="$_LEGACY_DIR"
fi

# ── Auto-checkpoint before compaction ──────────────────────────────────────
CHECKPOINT_DIR="$WORKER_DIR/checkpoints"
mkdir -p "$CHECKPOINT_DIR"
_CP_TS=$(date -u +%Y%m%dT%H%M%SZ)
_CP_FILE="$CHECKPOINT_DIR/checkpoint-${_CP_TS}.json"

# Capture git state
_CP_BRANCH=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
_CP_SHA=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "")
_CP_PORCELAIN=$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null || echo "")
# grep -c outputs "0" even on no match (exit code 1), so || echo "0" would
# produce "0\n0". Use a subshell to suppress the error exit code instead.
_CP_DIRTY=$(echo "$_CP_PORCELAIN" | grep -c '^.[MADRC?]' 2>/dev/null; true)
_CP_STAGED=$(echo "$_CP_PORCELAIN" | grep -c '^[MADRC]' 2>/dev/null; true)

# Read dynamic hooks if available
_CP_HOOKS="[]"
_HOOKS_FILE="/tmp/claude-hooks-${WORKER_NAME}.json"
if [ -f "$_HOOKS_FILE" ]; then
  _CP_HOOKS=$(jq '[.[] | {id, event, description, blocking, completed}]' "$_HOOKS_FILE" 2>/dev/null || echo "[]")
fi

# Write checkpoint JSON — write to temp file first, then atomically move.
# Direct redirect creates an empty file on jq failure, which JSON.parse would throw on during seed generation.
jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg summary "Auto-checkpoint before context compaction" \
  --arg branch "$_CP_BRANCH" \
  --arg sha "$_CP_SHA" \
  --argjson dirty "${_CP_DIRTY:-0}" \
  --argjson staged "${_CP_STAGED:-0}" \
  --argjson hooks "$_CP_HOOKS" \
  '{
    timestamp: $ts,
    type: "pre-compact",
    summary: $summary,
    git_state: {branch: $branch, sha: $sha, dirty_count: $dirty, staged_count: $staged},
    dynamic_hooks: $hooks,
    key_facts: [],
    transcript_ref: ""
  }' > "${_CP_FILE}.tmp" 2>/dev/null && mv "${_CP_FILE}.tmp" "$_CP_FILE" 2>/dev/null || true

# Update latest symlink
ln -sf "checkpoint-${_CP_TS}.json" "$CHECKPOINT_DIR/latest.json" 2>/dev/null || true

# GC: keep last 5 checkpoints
# Note: latest.json is a symlink and does not match checkpoint-*.json glob — no filter needed.
_CP_ALL=$(ls -1 "$CHECKPOINT_DIR"/checkpoint-*.json 2>/dev/null | sort)
_CP_COUNT=$(echo "$_CP_ALL" | grep -c . 2>/dev/null; true)
if [ "$_CP_COUNT" -gt 5 ]; then
  echo "$_CP_ALL" | head -n $((_CP_COUNT - 5)) | while read -r f; do rm -f "$f" 2>/dev/null; done
fi

# ── Output ───────────────────────────────────────────────────────────────────

echo ""
echo "## Session Context (auto-injected on compaction)"
echo ""

echo "### Identity"
echo "You are worker **${WORKER_NAME}**. Worktree: \`$(pwd)\`. Branch: \`worker/${WORKER_NAME}\`."
echo "Worker config directory: \`${WORKER_DIR}/\`"
echo ""

# Last checkpoint summary
_LATEST_CP="$CHECKPOINT_DIR/latest.json"
if [ -f "$_LATEST_CP" ]; then
  _CP_SUMMARY=$(jq -r '.summary // "none"' "$_LATEST_CP" 2>/dev/null || echo "")
  _CP_GIT_BRANCH=$(jq -r '.git_state.branch // "?"' "$_LATEST_CP" 2>/dev/null || echo "?")
  _CP_GIT_SHA=$(jq -r '.git_state.sha // "?"' "$_LATEST_CP" 2>/dev/null || echo "?")
  _CP_GIT_DIRTY=$(jq -r '.git_state.dirty_count // 0' "$_LATEST_CP" 2>/dev/null || echo "0")
  _CP_GIT_STAGED=$(jq -r '.git_state.staged_count // 0' "$_LATEST_CP" 2>/dev/null || echo "0")
  if [ -n "$_CP_SUMMARY" ] && [ "$_CP_SUMMARY" != "none" ]; then
    echo "### Last Checkpoint"
    echo "Summary: \"${_CP_SUMMARY}\""
    echo "Git: ${_CP_GIT_BRANCH} @ ${_CP_GIT_SHA} (${_CP_GIT_DIRTY} dirty, ${_CP_GIT_STAGED} staged)"
    _CP_KEY_FACTS=$(jq -r '.key_facts[]? // empty' "$_LATEST_CP" 2>/dev/null || true)
    if [ -n "$_CP_KEY_FACTS" ]; then
      echo "Key facts:"
      echo "$_CP_KEY_FACTS" | while read -r fact; do echo "  - $fact"; done
    fi
    echo ""
  fi
fi

# State — registry.json only (state.json is deprecated)
# Fleet v2 registry at ~/.claude/fleet/{project}/registry.json, fallback to legacy
_FLEET_REGISTRY="$HOME/.claude/fleet/${_PROJECT_NAME}/registry.json"
_LEGACY_REGISTRY="$MAIN_ROOT/.claude/workers/registry.json"
if [ -f "$_FLEET_REGISTRY" ]; then
  REGISTRY_FILE="$_FLEET_REGISTRY"
elif [ -f "$_LEGACY_REGISTRY" ]; then
  REGISTRY_FILE="$_LEGACY_REGISTRY"
else
  REGISTRY_FILE=""
fi
if [ -n "$REGISTRY_FILE" ] && [ -f "$REGISTRY_FILE" ]; then
  REGISTRY_ENTRY=$(jq -r --arg name "$WORKER_NAME" '.[$name] // empty' "$REGISTRY_FILE" 2>/dev/null || true)
fi
if [ -n "${REGISTRY_ENTRY:-}" ] && [ "$REGISTRY_ENTRY" != "null" ]; then
  echo "### Current State"
  echo '```json'
  echo "$REGISTRY_ENTRY"
  echo '```'
  echo ""
fi

# Memory — project-level auto-memory subdirectory (primary), fallback to worker dir
PROJECT_SLUG=$(echo "$MAIN_ROOT" | tr '/' '-')
AUTO_MEMORY_DIR="$HOME/.claude/projects/$PROJECT_SLUG/memory/$WORKER_NAME"
MEMORY_FILE="$AUTO_MEMORY_DIR/MEMORY.md"
# Fallback to legacy location
[ ! -f "$MEMORY_FILE" ] && MEMORY_FILE="$WORKER_DIR/MEMORY.md"
if [ -f "$MEMORY_FILE" ] && [ -s "$MEMORY_FILE" ]; then
  echo "### Accumulated Knowledge"
  echo "This is YOUR persistent memory from previous cycles. Read it carefully:"
  echo "Memory path: \`$AUTO_MEMORY_DIR/\`"
  echo ""
  truncated_cat "$MEMORY_FILE" 150
  echo ""
fi

# Resolve mission authority for template interpolation
# Try fleet.json first (v2), then registry _config (v1)
_FLEET_JSON="$HOME/.claude/fleet/${_PROJECT_NAME}/fleet.json"
if [ -f "$_FLEET_JSON" ]; then
  _CONFIG_AUTH=$(jq -r '.mission_authority // "chief-of-staff"' "$_FLEET_JSON" 2>/dev/null || echo "chief-of-staff")
elif [ -n "$REGISTRY_FILE" ] && [ -f "$REGISTRY_FILE" ]; then
  _CONFIG_AUTH=$(jq -r '._config.mission_authority // "chief-of-staff"' "$REGISTRY_FILE" 2>/dev/null || echo "chief-of-staff")
else
  _CONFIG_AUTH="chief-of-staff"
fi

# Shared seed context (tool table + stop checks + rules) — single source of truth
_TMPL="${HOME}/.claude-ops/templates/seed-context.md"
if [ -f "$_TMPL" ]; then
  sed -e "s/{{WORKER_NAME}}/${WORKER_NAME}/g" \
      -e "s|{{BRANCH}}|worker/${WORKER_NAME}|g" \
      -e "s/{{MISSION_AUTHORITY}}/${_CONFIG_AUTH}/g" \
      "$_TMPL"
  echo ""
else
  echo "### Tools"
  echo "Use \`mcp__worker-fleet__*\` MCP tools. Call \`read_inbox()\` first. Report to ${_CONFIG_AUTH}."
  echo ""
fi

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

# Tasks are now LKML mail threads — check Fleet Mail for TASK-labeled messages
echo "### Tasks"
echo "Check your task backlog: \`mail_inbox(label=\"TASK\")\`"
echo ""

# Rules and perpetual mode are already in seed-context.md template above.
# Only add compaction-specific reminders not in the shared template.
echo "### Compaction Reminders"
echo "- Re-read CLAUDE.md and .claude/CLAUDE.md for project instructions and credentials"
echo "- Post-commit hook auto-notifies Warren"
echo "- **REBASE FIRST every round**: \`git fetch origin && git rebase origin/main\`"

exit 0
