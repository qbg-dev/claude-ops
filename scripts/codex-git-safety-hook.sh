#!/usr/bin/env bash
# codex-git-safety-hook.sh — Pre-tool-use safety gate for codex workers.
#
# Placed in .codex/hooks/ in codex worker worktrees.
# Blocks dangerous git operations that fleet workers should not perform.
#
# Input: JSON on stdin (codex PreToolUse hook format, TBD when codex exposes hook API)
# Output: JSON stdout — {} to allow, {"error": "reason"} to block (exit 2)
set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // ""' 2>/dev/null || echo "")
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // .command // ""' 2>/dev/null || echo "")

# Only fire for shell/bash tool calls
[[ "$TOOL_NAME" == "shell" || "$TOOL_NAME" == "Bash" ]] || { echo '{}'; exit 0; }
[ -z "$COMMAND" ] && { echo '{}'; exit 0; }

block() {
  local reason="$1"
  echo "{\"error\": \"$reason\"}" >&1
  exit 2
}

# Block: git commit --amend
if echo "$COMMAND" | grep -qE '\bgit\s+commit\s+.*--amend'; then
  block "Blocked: git commit --amend is not allowed. Create a new commit instead."
fi

# Block: git push
if echo "$COMMAND" | grep -qE '\bgit\s+push\b'; then
  block "Blocked: git push is not allowed for workers. Send a merge request to the merger."
fi

# Block: git checkout main/master
if echo "$COMMAND" | grep -qE '\bgit\s+checkout\s+(main|master)\b'; then
  block "Blocked: Cannot checkout main/master. Work on your worker/* branch only."
fi

# Block: git reset --hard
if echo "$COMMAND" | grep -qE '\bgit\s+reset\s+--hard\b'; then
  block "Blocked: git reset --hard is not allowed. Use git revert instead."
fi

# Block: git branch -D
if echo "$COMMAND" | grep -qE '\bgit\s+branch\s+-D\b'; then
  block "Blocked: git branch -D is not allowed. Ask the merger to clean up branches."
fi

# Block: git stash drop / git stash clear
if echo "$COMMAND" | grep -qE '\bgit\s+stash\s+(drop|clear)\b'; then
  block "Blocked: git stash drop/clear is not allowed. Use git stash pop instead."
fi

# Allow
echo '{}'
exit 0
