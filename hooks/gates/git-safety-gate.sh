#!/usr/bin/env bash
# git-safety-gate.sh — PreToolUse gate that blocks dangerous git operations.
#
# Blocks:
#   - git commit --amend (use git revert or new commit instead)
#   - git checkout -b / git switch -c with non-worker/* branch names (subagents exempt)
# Audits:
#   - git cherry-pick (emits bus event, does not block)
#
# Hook-enforced (defense-in-depth alongside denyList).
set -uo pipefail
trap 'echo "{}"; exit 0' ERR
exec 2>/dev/null  # suppress stderr — Claude Code treats any stderr as hook error

source "$HOME/.claude-ops/lib/pane-resolve.sh"

# Source event bus if available
[ -f "$HOME/.claude-ops/lib/event-bus.sh" ] && source "$HOME/.claude-ops/lib/event-bus.sh"

INPUT=$(cat)
hook_parse_input "$INPUT"
SESSION_ID="$_HOOK_SESSION_ID"
TOOL_NAME="$_HOOK_TOOL_NAME"
TOOL_INPUT="$_HOOK_TOOL_INPUT"

# Only fire for Bash tools
[ "$TOOL_NAME" != "Bash" ] && { echo '{}'; exit 0; }

# Resolve harness context
resolve_pane_and_harness "$SESSION_ID"
[ -z "$HARNESS" ] && { echo '{}'; exit 0; }

# Extract command
COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""' 2>/dev/null || echo "")
[ -z "$COMMAND" ] && { echo '{}'; exit 0; }

# Normalize: strip common prefix wrappers
_NORM="$COMMAND"
_NORM="${_NORM#env }"
_NORM="${_NORM#/usr/bin/env }"
_NORM="${_NORM#command }"
# Unwrap shell -c "..." wrappers — loop to handle double-nesting (e.g. bash -c 'bash -c "..."').
# Without the loop, a double-nested command leaves the inner git preceded by '"' which bypasses regex checks.
# Handles: bash, sh, zsh, dash.
_UNWRAP_LIMIT=3
_UNWRAP_COUNT=0
while [[ "$_NORM" == bash\ -c\ * || "$_NORM" == sh\ -c\ * || "$_NORM" == zsh\ -c\ * || "$_NORM" == dash\ -c\ * ]] && [ "$_UNWRAP_COUNT" -lt "$_UNWRAP_LIMIT" ]; do
  _INNER="${_NORM#*-c }"
  _INNER="${_INNER#\"}" ; _INNER="${_INNER%\"}"
  _INNER="${_INNER#\'}" ; _INNER="${_INNER%\'}"
  _NORM="$_INNER"
  _UNWRAP_COUNT=$((_UNWRAP_COUNT + 1))
done
COMMAND_NORM="$_NORM"

# ── Check: git commit --amend ──
if echo "$COMMAND_NORM" | grep -qE '(^|\s|&&|;|\|)\s*git\s+commit\s+.*--amend'; then
  hook_block "Blocked: \`git commit --amend\` is not allowed. Use \`git revert\` to undo a commit, or create a new commit instead."
  exit 0
fi

# ── Check: git checkout -b / git switch -c with non-worker/* branch name ──
# Subagents are exempt (they create their own branches)
if ! _is_subagent; then
  BRANCH_NAME=""

  # git checkout -b <branch>
  if echo "$COMMAND_NORM" | grep -qE '(^|\s|&&|;|\|)\s*git\s+checkout\s+-b\s+'; then
    # Extract branch name: word after -b
    BRANCH_NAME=$(echo "$COMMAND_NORM" | sed -n 's/.*git[[:space:]]\{1,\}checkout[[:space:]]\{1,\}-b[[:space:]]\{1,\}\([^ ;|&]*\).*/\1/p')
  fi

  # git checkout --branch <branch>  (long form of -b)
  if [ -z "$BRANCH_NAME" ] && echo "$COMMAND_NORM" | grep -qE '(^|\s|&&|;|\|)\s*git\s+checkout\s+--branch\s+'; then
    BRANCH_NAME=$(echo "$COMMAND_NORM" | sed -n 's/.*git[[:space:]]\{1,\}checkout[[:space:]]\{1,\}--branch[[:space:]]\{1,\}\([^ ;|&]*\).*/\1/p')
  fi

  # git switch -c <branch>
  if [ -z "$BRANCH_NAME" ] && echo "$COMMAND_NORM" | grep -qE '(^|\s|&&|;|\|)\s*git\s+switch\s+-c\s+'; then
    BRANCH_NAME=$(echo "$COMMAND_NORM" | sed -n 's/.*git[[:space:]]\{1,\}switch[[:space:]]\{1,\}-c[[:space:]]\{1,\}\([^ ;|&]*\).*/\1/p')
  fi

  # git switch --create <branch>  (long form of -c)
  if [ -z "$BRANCH_NAME" ] && echo "$COMMAND_NORM" | grep -qE '(^|\s|&&|;|\|)\s*git\s+switch\s+--create\s+'; then
    BRANCH_NAME=$(echo "$COMMAND_NORM" | sed -n 's/.*git[[:space:]]\{1,\}switch[[:space:]]\{1,\}--create[[:space:]]\{1,\}\([^ ;|&]*\).*/\1/p')
  fi

  # If a branch name was found, check it matches worker/*
  if [ -n "$BRANCH_NAME" ] && [[ "$BRANCH_NAME" != worker/* ]]; then
    hook_block "Blocked: Branch names must match \`worker/*\` pattern. Use \`git checkout -b worker/your-name\`."
    exit 0
  fi
fi

# ── Audit: git cherry-pick ──
if echo "$COMMAND_NORM" | grep -qE '(^|\s|&&|;|\|)\s*git\s+cherry-pick\s+'; then
  # Emit audit event but don't block
  if type bus_publish &>/dev/null; then
    _WORKER="${HARNESS#worker/}"
    _CHERRY_SHA=$(echo "$COMMAND_NORM" | sed -n 's/.*git[[:space:]]\{1,\}cherry-pick[[:space:]]\{1,\}\([^ ;|&]*\).*/\1/p')
    bus_publish "git.cherry-pick" "$(jq -n --arg w "$_WORKER" --arg sha "$_CHERRY_SHA" --arg cmd "$COMMAND" '{worker: $w, sha: $sha, command: $cmd}')" 2>/dev/null || true
  fi
  echo '{}'
  exit 0
fi

# No match — allow
echo '{}'
