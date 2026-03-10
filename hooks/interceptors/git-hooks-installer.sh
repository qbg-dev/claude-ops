#!/usr/bin/env bash
# git-hooks-installer.sh — SessionStart interceptor that auto-installs git hooks from manifest.
#
# Reads ~/.claude-ops/templates/git-hooks-manifest.json and installs hooks into
# the worktree or main repo's .git/hooks/ directory. Idempotent (skips if md5 matches).
set -uo pipefail
trap 'echo "{}"; exit 0' ERR
exec 2>/dev/null  # suppress stderr

source "$HOME/.claude-ops/lib/pane-resolve.sh"

INPUT=$(cat)
hook_parse_input "$INPUT"
SESSION_ID="$_HOOK_SESSION_ID"

# Resolve harness
resolve_pane_and_harness "$SESSION_ID"

# Skip if not a worker session
[[ "$HARNESS" != worker/* ]] && { echo '{}'; exit 0; }

# Resolve PROJECT_ROOT — follow worktree .git file to main repo
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
WORKTREE_ROOT="$PROJECT_ROOT"
MAIN_REPO_ROOT="$PROJECT_ROOT"
WORKTREE_GIT_DIR=""

if [ -f "$PROJECT_ROOT/.git" ]; then
  # We're in a worktree: .git is a file pointing to main repo's .git/worktrees/<name>
  WORKTREE_GIT_DIR=$(cat "$PROJECT_ROOT/.git" | sed 's/gitdir: //')
  # Resolve to absolute path if relative
  if [[ "$WORKTREE_GIT_DIR" != /* ]]; then
    WORKTREE_GIT_DIR="$PROJECT_ROOT/$WORKTREE_GIT_DIR"
  fi
  WORKTREE_GIT_DIR=$(cd "$WORKTREE_GIT_DIR" && pwd)
  # Main repo root: strip /.git/worktrees/<name> from the gitdir path
  MAIN_REPO_ROOT=$(echo "$WORKTREE_GIT_DIR" | sed 's|/\.git/worktrees/.*||')
fi

MANIFEST="$HOME/.claude-ops/templates/git-hooks-manifest.json"
[ ! -f "$MANIFEST" ] && { echo '{}'; exit 0; }

# Parse manifest and install each hook
HOOK_COUNT=$(jq -r '.hooks | length' "$MANIFEST" 2>/dev/null || echo "0")
[ "$HOOK_COUNT" = "0" ] && { echo '{}'; exit 0; }

for i in $(seq 0 $(( HOOK_COUNT - 1 ))); do
  HOOK_NAME=$(jq -r ".hooks[$i].name" "$MANIFEST")
  HOOK_SOURCE=$(jq -r ".hooks[$i].source" "$MANIFEST")
  HOOK_OVERRIDE=$(jq -r ".hooks[$i].project_override // \"\"" "$MANIFEST")
  HOOK_TARGET=$(jq -r ".hooks[$i].target // \"worktree\"" "$MANIFEST")

  # Expand ~ in source path
  HOOK_SOURCE="${HOOK_SOURCE/#\~/$HOME}"

  # Determine actual source: project override first, then global
  ACTUAL_SOURCE=""
  if [ -n "$HOOK_OVERRIDE" ]; then
    # Check worktree root first (current project), then main repo
    if [ -f "$WORKTREE_ROOT/$HOOK_OVERRIDE" ]; then
      ACTUAL_SOURCE="$WORKTREE_ROOT/$HOOK_OVERRIDE"
    elif [ -f "$MAIN_REPO_ROOT/$HOOK_OVERRIDE" ]; then
      ACTUAL_SOURCE="$MAIN_REPO_ROOT/$HOOK_OVERRIDE"
    fi
  fi
  [ -z "$ACTUAL_SOURCE" ] && ACTUAL_SOURCE="$HOOK_SOURCE"

  # Skip if source doesn't exist
  [ ! -f "$ACTUAL_SOURCE" ] && continue

  # Determine target hooks directory
  TARGET_HOOKS_DIR=""
  if [ "$HOOK_TARGET" = "worktree" ] && [ -n "$WORKTREE_GIT_DIR" ]; then
    # Worktree: hooks dir is inside the worktree's gitdir
    TARGET_HOOKS_DIR="$WORKTREE_GIT_DIR/hooks"
  elif [ "$HOOK_TARGET" = "worktree" ]; then
    # Not a worktree, use main repo
    TARGET_HOOKS_DIR="$MAIN_REPO_ROOT/.git/hooks"
  elif [ "$HOOK_TARGET" = "main" ]; then
    TARGET_HOOKS_DIR="$MAIN_REPO_ROOT/.git/hooks"
  fi

  [ -z "$TARGET_HOOKS_DIR" ] && continue

  # Create hooks dir if needed
  mkdir -p "$TARGET_HOOKS_DIR"

  TARGET_FILE="$TARGET_HOOKS_DIR/$HOOK_NAME"

  # Idempotent: skip if target exists and md5 matches.
  # Guard: if md5 is unavailable (both commands fail), force reinstall rather than silently skipping.
  if [ -f "$TARGET_FILE" ]; then
    SOURCE_MD5=$(md5 -q "$ACTUAL_SOURCE" 2>/dev/null || md5sum "$ACTUAL_SOURCE" 2>/dev/null | cut -d' ' -f1)
    TARGET_MD5=$(md5 -q "$TARGET_FILE" 2>/dev/null || md5sum "$TARGET_FILE" 2>/dev/null | cut -d' ' -f1)
    # Only skip if both hashes are non-empty and equal (avoids silent skip when md5 unavailable)
    [ -n "$SOURCE_MD5" ] && [ -n "$TARGET_MD5" ] && [ "$SOURCE_MD5" = "$TARGET_MD5" ] && continue
  fi

  # Install: copy and make executable
  cp "$ACTUAL_SOURCE" "$TARGET_FILE"
  chmod +x "$TARGET_FILE"
done

echo '{}'
