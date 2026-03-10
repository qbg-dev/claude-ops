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
  # These block commands that NO agent should ever run, regardless of role.

  # ── Tmux destruction ──
  if echo "$COMMAND_NORM" | grep -qE 'tmux\s+kill-ses(sion)?'; then
    hook_block "tmux kill-session is blocked fleet-wide. Sessions are managed by the orchestrator, not individual agents."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'tmux\s+kill-window'; then
    hook_block "tmux kill-window is blocked fleet-wide. Use recycle() to cleanly shut down instead of killing windows."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'tmux\s+kill-server'; then
    hook_block "tmux kill-server is blocked fleet-wide. This would destroy ALL tmux sessions across the entire fleet."
    exit 0
  fi

  # ── Git destruction ──
  if echo "$COMMAND_NORM" | grep -qE 'git\s+push\s+.*(-f\b|--force)'; then
    hook_block "git push --force is blocked fleet-wide. Force push destroys remote history. Use the merger for push operations."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'git\s+reset\s+--hard'; then
    hook_block "git reset --hard is blocked fleet-wide. This destroys uncommitted work. Use git stash or git checkout <file> for targeted reverts."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'git\s+clean\s+.*-[a-zA-Z]*f'; then
    hook_block "git clean -f is blocked fleet-wide. This permanently deletes untracked files. Use rm on specific files instead."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'git\s+(checkout|restore)\s+\.'; then
    hook_block "git checkout/restore . is blocked fleet-wide. This discards ALL uncommitted changes. Use git checkout <specific-file> instead."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'git\s+branch\s+.*-D'; then
    hook_block "git branch -D is blocked fleet-wide. Force-deleting branches can lose unmerged work. Use git branch -d (lowercase) for safe deletion."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'git\s+filter-branch'; then
    hook_block "git filter-branch is blocked fleet-wide. History rewriting is destructive and irreversible."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'git\s+remote\s+(set-url|add)'; then
    hook_block "git remote set-url/add is blocked fleet-wide. Repo remotes are managed by the orchestrator."
    exit 0
  fi
  # git config (except user.name and user.email which are needed in worktrees)
  if echo "$COMMAND_NORM" | grep -qE 'git\s+config\s+' && ! echo "$COMMAND_NORM" | grep -qE 'git\s+config\s+(--global\s+)?user\.(name|email)'; then
    hook_block "git config is blocked fleet-wide (except user.name/email). Git configuration is managed by the orchestrator."
    exit 0
  fi

  # ── File destruction ──
  if echo "$COMMAND_NORM" | grep -qE 'rm\s+.*-[a-zA-Z]*r[a-zA-Z]*f|rm\s+.*-[a-zA-Z]*f[a-zA-Z]*r'; then
    hook_block "rm -rf is blocked fleet-wide. Use more targeted file removal (rm <specific-file>) or ask the orchestrator."
    exit 0
  fi

  # ── Cross-agent process killing ──
  if echo "$COMMAND_NORM" | grep -qE '(^|\s)(kill|pkill|killall)\s+.*claude'; then
    hook_block "Killing claude processes is blocked fleet-wide. Agents must not terminate other agents. Use recycle() for self, or notify the orchestrator."
    exit 0
  fi

  # ── System-level ──
  if echo "$COMMAND_NORM" | grep -qE 'launchctl\s+(unload|bootout)'; then
    hook_block "launchctl unload/bootout is blocked fleet-wide. System services are managed by the orchestrator."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE '(^|\s)osascript(\s|$)'; then
    hook_block "osascript is blocked fleet-wide. AppleScript execution is too powerful and unpredictable for agent use."
    exit 0
  fi
  if echo "$COMMAND_NORM" | grep -qE 'crontab\s+-r'; then
    hook_block "crontab -r is blocked fleet-wide. This deletes ALL cron jobs. Edit specific entries with crontab -e instead."
    exit 0
  fi

  # ── Orphan processes ──
  if echo "$COMMAND_NORM" | grep -qE '(^|\s)nohup\s+'; then
    hook_block "nohup is blocked fleet-wide. Background processes must be managed through the fleet orchestrator, not spawned as orphans."
    exit 0
  fi

  # ── Worktree-specific: prod access ──
  if [ "$_IS_WORKTREE" = true ]; then
    _PROD_IP="${FLEET_PROD_IP:-}"
    if [ -n "$_PROD_IP" ]; then
      if echo "$COMMAND" | grep -qF "$_PROD_IP" || echo "$COMMAND_NORM" | grep -qF "$_PROD_IP"; then
        hook_block "Direct prod access ($_PROD_IP) blocked from worktree. Workers cannot deploy to prod — notify Warren's main session."
        exit 0
      fi
    fi
  fi

fi

# ── Write/Edit universal gates ──────────────────────────────────
# These block file modifications that NO agent should make, regardless of role.
if [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
  _FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""' 2>/dev/null || echo "")
  [ -n "$_FILE_PATH" ] && _FILE_PATH=$(realpath "$_FILE_PATH" 2>/dev/null || echo "$_FILE_PATH")

  # Block editing own permissions.json — privilege escalation
  if [ -n "${PERMS:-}" ] && [ -n "$_FILE_PATH" ]; then
    _PERMS_REAL=$(realpath "$PERMS" 2>/dev/null || echo "$PERMS")
    if [ "$_FILE_PATH" = "$_PERMS_REAL" ]; then
      hook_block "Editing own permissions.json is blocked fleet-wide — this would be privilege escalation."
      exit 0
    fi
  fi

  # Block editing git hooks — safety hooks are managed by the orchestrator
  case "$_FILE_PATH" in
    */.git/hooks/*)
      hook_block "Editing git hooks is blocked fleet-wide. Safety hooks are managed by the orchestrator."
      exit 0
      ;;
  esac

  # Block editing shell profiles — environment poisoning
  case "$_FILE_PATH" in
    */.zshrc|*/.bashrc|*/.profile|*/.bash_profile)
      hook_block "Editing shell profiles is blocked fleet-wide — environment poisoning risk."
      exit 0
      ;;
  esac
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
