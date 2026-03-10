#!/usr/bin/env bash
# tool-policy-gate.sh — PreToolUse gate that blocks tools per agent permissions.json
#
# Reads denyList from the calling agent's permissions.json and blocks
# matching tool calls. Pattern format:
#   "ToolName"              — blocks all uses of ToolName
#   "Bash(git push*)"      — blocks Bash commands matching glob (also catches env/command/bash -c wrappers)
#   "Edit(src/**)"          — blocks Edit on files matching glob (resolves symlinks)
#   "Write(data/**)"        — blocks Write on files matching glob (resolves symlinks)
#   "Read(/secret/**)"      — blocks Read on files matching glob (resolves symlinks)
#
# Hook-enforced (not the CLI --disallowedTools flag).
set -uo pipefail
trap 'echo "{}"; exit 0' ERR
exec 2>/dev/null  # suppress stderr — Claude Code treats any stderr as hook error

source "$HOME/.claude-ops/lib/pane-resolve.sh"

INPUT=$(cat)
hook_parse_input "$INPUT"
SESSION_ID="$_HOOK_SESSION_ID"
TOOL_NAME="$_HOOK_TOOL_NAME"
TOOL_INPUT="$_HOOK_TOOL_INPUT"

# Resolve which agent is calling
resolve_pane_and_harness "$SESSION_ID"

# Resolve PROJECT_ROOT — must follow worktrees back to main repo
# Do this BEFORE any reference to $PROJECT_ROOT (set -u would kill us)
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
_IS_WORKTREE=false
if [ -f "$PROJECT_ROOT/.git" ]; then
  # Worktree: .git is a file pointing to main repo
  _IS_WORKTREE=true
  _MAIN_GIT_DIR=$(sed 's/gitdir: //' "$PROJECT_ROOT/.git" | sed 's|/\.git/worktrees/.*||')
  PROJECT_ROOT="$_MAIN_GIT_DIR"
fi

[ -z "$HARNESS" ] && { echo '{}'; exit 0; }

# Derive permissions.json path from harness field in pane registry.
# Three patterns:
#   "worker/{name}"       → flat worker: .claude/workers/{name}/permissions.json
#   "mod-ops/wo-fullchain" → old harness worker: .claude/harness/{parent}/agents/worker/{name}/permissions.json
#   "mod-ops"              → old harness MM: .claude/harness/{name}/agents/module-manager/permissions.json
if [[ "$HARNESS" == worker/* ]]; then
  # Flat worker: "worker/{name}" → .claude/workers/{name}/permissions.json
  _WORKER="${HARNESS#worker/}"
  PERMS="$PROJECT_ROOT/.claude/workers/$_WORKER/permissions.json"
elif [[ "$HARNESS" == */* ]]; then
  # Old harness worker: "parent/worker-name"
  _PARENT="${HARNESS%/*}"
  _WORKER="${HARNESS##*/}"
  PERMS="$PROJECT_ROOT/.claude/harness/$_PARENT/agents/worker/$_WORKER/permissions.json"
else
  # Old harness module manager
  PERMS="$PROJECT_ROOT/.claude/harness/$HARNESS/agents/module-manager/permissions.json"
fi

[ ! -f "$PERMS" ] && { echo '{}'; exit 0; }

# ── Extract Bash command (needed by universal gates and denyList matching) ──
COMMAND=""
COMMAND_NORM=""
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""' 2>/dev/null || echo "")
  # Normalize: strip common prefix wrappers that bypass start-of-string matching
  # env, command, bash -c, /usr/bin/env — all used to evade "git push*" style rules
  _NORM="$COMMAND"
  _NORM="${_NORM#env }"
  _NORM="${_NORM#/usr/bin/env }"
  _NORM="${_NORM#command }"
  # bash -c "..." / bash -c '...' — extract the inner command
  if [[ "$_NORM" == bash\ -c\ * ]]; then
    _INNER="${_NORM#bash -c }"
    _INNER="${_INNER#\"}" ; _INNER="${_INNER%\"}"
    _INNER="${_INNER#\'}" ; _INNER="${_INNER%\'}"
    _NORM="$_INNER"
  fi
  COMMAND_NORM="$_NORM"

  # Whitelist: messaging/notification tools — content should never trigger policy blocks
  case "$COMMAND_NORM" in
    *worker-message.sh*|*worker-bus-emit.sh*|notify\ *) echo '{}'; exit 0 ;;
  esac

  # ── Universal gates (run regardless of denyList) ──────────────────

  # Block tmux kill-session — agents must never destroy tmux sessions
  if echo "$COMMAND_NORM" | grep -qE 'tmux\s+kill-ses(sion)?'; then
    hook_block "tmux kill-session is blocked fleet-wide. Sessions are managed by the orchestrator, not individual agents."
    exit 0
  fi

  # Block tmux kill-window on own window — agents must not destroy their own pane context
  if echo "$COMMAND_NORM" | grep -qE 'tmux\s+kill-window'; then
    hook_block "tmux kill-window is blocked fleet-wide. Use recycle() to cleanly shut down instead of killing windows."
    exit 0
  fi

  # Block direct prod access from worktrees — workers cannot deploy to prod
  if [ "$_IS_WORKTREE" = true ]; then
    _PROD_IP="120.77.216.196"
    if echo "$COMMAND" | grep -qF "$_PROD_IP" || echo "$COMMAND_NORM" | grep -qF "$_PROD_IP"; then
      hook_block "Direct prod access ($_PROD_IP) blocked from worktree. Workers cannot deploy to prod — notify Warren's main session."
      exit 0
    fi
  fi

fi

# Read denyList array (after universal gates so they always run)
DISALLOWED=$(jq -r '.denyList // [] | .[]' "$PERMS" 2>/dev/null || true)
[ -z "$DISALLOWED" ] && { echo '{}'; exit 0; }
FILE_PATH=""
case "$TOOL_NAME" in
  Edit|Write|Read) FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""' 2>/dev/null || echo "") ;;
esac
# Resolve symlinks to prevent symlink-based path bypass
[ -n "$FILE_PATH" ] && FILE_PATH=$(realpath "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

while IFS= read -r pattern; do
  [ -z "$pattern" ] && continue

  # Extract tool name and optional argument pattern
  PATTERN_TOOL="${pattern%%(*}"
  if [[ "$pattern" == *"("* ]]; then
    PATTERN_ARG="${pattern#*(}"
    PATTERN_ARG="${PATTERN_ARG%)}"
  else
    PATTERN_ARG=""
  fi

  # Check tool name match
  [ "$TOOL_NAME" != "$PATTERN_TOOL" ] && continue

  # If no arg pattern, block all uses of this tool
  if [ -z "$PATTERN_ARG" ]; then
    hook_block "Tool '$TOOL_NAME' blocked by policy for agent ${CANONICAL:-$HARNESS}"
    exit 0
  fi

  # Match argument pattern (glob-style)
  case "$TOOL_NAME" in
    Bash)
      # Convert glob to regex: escape dots, * → .*, ? → .
      REGEX=$(echo "$PATTERN_ARG" | sed 's/[.[\^$+{}|]/\\&/g; s/\*/.*/g; s/?/./g')
      # Check both raw command AND normalized (prefix-stripped) form
      if echo "$COMMAND" | grep -qE "^${REGEX}" || echo "$COMMAND_NORM" | grep -qE "^${REGEX}"; then
        hook_block "Command blocked by policy for agent ${CANONICAL:-$HARNESS}: $(echo "$COMMAND" | head -c 100)"
        exit 0
      fi
      # Also check if the pattern appears as a substring (catches piped/chained commands)
      if echo "$COMMAND" | grep -qE "(;|&&|\|\||\| )\s*${REGEX}"; then
        hook_block "Chained command blocked by policy for agent ${CANONICAL:-$HARNESS}: $(echo "$COMMAND" | head -c 100)"
        exit 0
      fi
      ;;
    Edit|Write|Read)
      # Convert glob to regex: ** = any path, * = single segment
      REGEX=$(echo "$PATTERN_ARG" | sed 's/[.[\^$+{}|]/\\&/g; s/\*\*/.*/g; s/\*/[^\/]*/g')
      if echo "$FILE_PATH" | grep -qE "(^|/)${REGEX}"; then
        hook_block "File path blocked by policy for agent ${CANONICAL:-$HARNESS}: $(basename "$FILE_PATH")"
        exit 0
      fi
      ;;
  esac
done <<< "$DISALLOWED"

# No match — allow
echo '{}'
