#!/usr/bin/env bash
# pane-resolve.sh — Shared pane + harness resolution for all hooks.
#
# Source this file in any hook:
#   source "$HOME/.claude-ops/lib/pane-resolve.sh"
#
# Then call:
#   resolve_pane_and_harness "$SESSION_ID"
#   # → sets OWN_PANE_ID and HARNESS globals
#
# Or individually:
#   OWN_PANE_ID=$(resolve_own_pane)
#   HARNESS=$(resolve_harness "$pane_id" "$session_id")
#
# Replaces inline pane detection duplicated across 6+ hooks.

# Source the canonical paths and low-level functions
_PANE_RESOLVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$_PANE_RESOLVE_DIR/fleet-jq.sh"

# ── resolve_own_pane ──
# Walk process tree to find the tmux pane_id.
# Returns: pane_id (e.g. %42) on stdout, or "" if not in tmux.
resolve_own_pane() {
  hook_find_own_pane "$@"
}

# ── resolve_harness ──
# 3-tier lookup → harness name or "".
# Usage: resolve_harness "$pane_id" "$session_id"
resolve_harness() {
  local pane_id="$1" session_id="$2"
  hook_resolve_harness "$pane_id" "$session_id"
  echo "$HARNESS"
}

# ── resolve_pane_and_harness ──
# Convenience: resolves both and sets globals.
# Usage: resolve_pane_and_harness "$SESSION_ID"
# After call: $OWN_PANE_ID and $HARNESS are set.
resolve_pane_and_harness() {
  local session_id="$1"
  OWN_PANE_ID=$(resolve_own_pane)
  hook_resolve_harness "$OWN_PANE_ID" "$session_id"
  # HARNESS is now set by hook_resolve_harness
}

# ── resolve_project_root ──
# Determine project root from CWD or CLAUDE_PROJECT_ROOT.
# Returns: absolute path on stdout.
resolve_project_root() {
  if [ -n "${CLAUDE_PROJECT_ROOT:-}" ]; then
    echo "$CLAUDE_PROJECT_ROOT"
  elif [ -d ".claude" ]; then
    pwd
  else
    git rev-parse --show-toplevel 2>/dev/null || pwd
  fi
}

# ── resolve_harness_dir ──
# Get the harness directory for a named harness.
# Usage: resolve_harness_dir "$harness_name"
# Returns: absolute path to .claude/harness/$name/ or ""
resolve_harness_dir() {
  local name="$1"
  [ -z "$name" ] && return
  local root
  root=$(resolve_project_root)
  local dir="$root/.claude/harness/$name"
  [ -d "$dir" ] && echo "$dir"
}

# ── resolve_session_dir ──
# Get (and create) the session state directory.
# Usage: resolve_session_dir "$session_id"
resolve_session_dir() {
  harness_session_dir "$1"
}
