#!/usr/bin/env bash
# stop-push-gate.sh — Blocks session exit if worker branch has unpushed commits.
#
# Workers must push their work before stopping to preserve it across crashes/recycles.
# round_stop() does git commit+push automatically, but this gate catches cases where
# the worker tries to /exit without calling round_stop() first.
set -euo pipefail

source "$HOME/.claude-fleet/lib/fleet-jq.sh" 2>/dev/null || true

INPUT=$(cat)
hook_parse_input "$INPUT"

# Subagents: skip
if _is_subagent; then hook_pass; exit 0; fi

SESSION_ID="$_HOOK_SESSION_ID"
[ -z "$SESSION_ID" ] && { hook_pass; exit 0; }

_SESSION_DIR=$(harness_session_dir "$SESSION_ID")

# Escape hatch
[ -f "$_SESSION_DIR/allow-stop" ] && { hook_pass; exit 0; }
# Echo chain active
[ -f "$_SESSION_DIR/echo-state.json" ] && { hook_pass; exit 0; }

# Only check worker/* sessions
OWN_PANE_ID=$(hook_find_own_pane 2>/dev/null || echo "")
hook_resolve_harness "$OWN_PANE_ID" "$SESSION_ID" 2>/dev/null || true

if [[ "${CANONICAL:-$HARNESS}" != worker/* ]]; then
  hook_pass; exit 0
fi

_wname="${CANONICAL#worker/}"
_wname="${_wname:-${HARNESS#worker/}}"

# Check if we're in a git repo with a remote
_cwd="${PROJECT_ROOT:-$(pwd)}"
if ! git -C "$_cwd" rev-parse --git-dir >/dev/null 2>&1; then
  hook_pass; exit 0
fi

# Check for unpushed commits
_branch=$(git -C "$_cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
[ -z "$_branch" ] && { hook_pass; exit 0; }

# Check if remote tracking branch exists
_remote_ref=$(git -C "$_cwd" rev-parse --verify "origin/$_branch" 2>/dev/null || echo "")

if [ -z "$_remote_ref" ]; then
  # No remote tracking — check if there are any commits to push
  _local_commits=$(git -C "$_cwd" rev-list HEAD 2>/dev/null | head -1 || echo "")
  if [ -n "$_local_commits" ]; then
    hook_block "$(echo -e "## ${_wname}: Branch not pushed to remote\n\nBranch \`${_branch}\` has no remote tracking branch.\nPush before stopping to preserve your work:\n\n\`\`\`bash\ngit push -u origin ${_branch}\n\`\`\`\n\nOr call \`round_stop()\` which handles this automatically.\n\nEscape: touch ${_SESSION_DIR}/allow-stop")"
    exit 0
  fi
else
  # Remote exists — check for unpushed commits
  _unpushed=$(git -C "$_cwd" rev-list "origin/$_branch..HEAD" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$_unpushed" -gt 0 ]; then
    # Also check for uncommitted changes
    _dirty=$(git -C "$_cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    _msg="## ${_wname}: ${_unpushed} unpushed commit(s) on \`${_branch}\`"
    [ "$_dirty" -gt 0 ] && _msg="${_msg}\nPlus ${_dirty} uncommitted change(s)."
    _msg="${_msg}\n\nPush before stopping:\n\n\`\`\`bash\ngit push origin ${_branch}\n\`\`\`\n\nOr call \`round_stop()\` which handles commit+push automatically.\n\nEscape: touch ${_SESSION_DIR}/allow-stop"
    hook_block "$(echo -e "$_msg")"
    exit 0
  fi

  # Check for uncommitted changes (staged or unstaged)
  _dirty=$(git -C "$_cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$_dirty" -gt 0 ]; then
    hook_block "$(echo -e "## ${_wname}: ${_dirty} uncommitted change(s)\n\nCommit and push before stopping:\n\n\`\`\`bash\ngit add -A && git commit -m 'checkpoint: ${_wname}' && git push origin ${_branch}\n\`\`\`\n\nOr call \`round_stop()\` which handles this automatically.\n\nEscape: touch ${_SESSION_DIR}/allow-stop")"
    exit 0
  fi
fi

hook_pass
exit 0
