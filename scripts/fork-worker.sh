#!/usr/bin/env bash
# fork-worker.sh — Fork Claude into a new pane (child inherits parent conversation).
#
# Copies the parent session data (JSONL + subdir) to the new worktree's project dir,
# then launches claude from WITHIN the worktree via --resume --fork-session.
# The worktree is created here (default) or by spawn_child (--no-worktree + --cwd).
#
# Usage: fork-worker.sh <parent_pane_id> <parent_session_id> --name WORKER_NAME [--assigned-by NAME] [--model MODEL] [--no-worktree] [--cwd DIR] [extra-claude-flags...]
#
# Options:
#   --name NAME         REQUIRED. Meaningful kebab-case name (e.g. 'swagger-audit').
#                       Error if name already exists in registry — choose a unique purpose name.
#   --assigned-by NAME  Who assigned this worker (default: parent pane's worker)
#   --model MODEL       Claude model to use (default: opus)
#   --no-worktree       Skip worktree creation (used by spawn_child which pre-creates it)
#   --cwd DIR           Launch claude from this directory (used with --no-worktree when spawn_child pre-creates worktree + copies session)
#
# Example:
#   bash ~/.claude-ops/scripts/fork-worker.sh %612 abc123def456 --name swagger-audit --assigned-by chief-of-staff --model opus --dangerously-skip-permissions

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_OPS_DIR="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"

PARENT_PANE="${1:-}"
PARENT_SESSION="${2:-}"
shift 2 2>/dev/null || true

if [ -z "$PARENT_PANE" ] || [ -z "$PARENT_SESSION" ]; then
  echo "Usage: fork-worker.sh <parent_pane_id> <parent_session_id> [--name WORKER_NAME] [--parent PARENT_NAME] [claude-flags...]" >&2
  exit 1
fi

# Parse optional flags (consume them before passing remaining to claude)
CHILD_NAME=""
CHILD_ASSIGNED_BY=""
CHILD_MODEL=""
NO_WORKTREE=false
LAUNCH_CWD=""
CLAUDE_FLAGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)         CHILD_NAME="$2"; shift 2 ;;
    --assigned-by)  CHILD_ASSIGNED_BY="$2"; shift 2 ;;
    --parent)       CHILD_ASSIGNED_BY="$2"; shift 2 ;;  # backward compat alias
    --model)        CHILD_MODEL="$2"; shift 2 ;;
    --no-worktree)  NO_WORKTREE=true; shift ;;
    --cwd)          LAUNCH_CWD="$2"; shift 2 ;;
    *)              CLAUDE_FLAGS+=("$1"); shift ;;
  esac
done

# ── Require --name (prompt interactively if missing or lazy) ──
_prompt_name() {
  echo "" >&2
  echo "  What will this worker do? Choose a meaningful kebab-case name." >&2
  echo "  Good: swagger-audit, finance-fix, wo-dashboard-v2" >&2
  echo "  Bad:  chief-of-staff-fork, sso-fix-fork-fork" >&2
  echo "" >&2
  printf "  Worker name: " >&2
  read -r CHILD_NAME
}

if [ -z "$CHILD_NAME" ]; then
  _prompt_name
fi

# Reject lazy fork-style names
while [[ "$CHILD_NAME" =~ -fork(-|$) ]] || [[ "$CHILD_NAME" =~ ^child- ]] || [ -z "$CHILD_NAME" ]; do
  echo "" >&2
  echo "  ✗ '$CHILD_NAME' is not a useful name. Describe what this worker DOES." >&2
  _prompt_name
done

echo "Forking session $PARENT_SESSION from parent pane $PARENT_PANE (child: $CHILD_NAME)"

# ── Self-register in registry.json ──
if [ -n "${TMUX_PANE:-}" ]; then
  # Find the registry.json for the current working directory
  _cwd="$(pwd)"
  _main_project="$_cwd"
  if [ -f "$_cwd/.git" ]; then
    _main_project=$(sed 's|gitdir: ||; s|/\.git/worktrees/.*||' "$_cwd/.git" 2>/dev/null || echo "$_cwd")
  fi
  _REGISTRY="$_main_project/.claude/workers/registry.json"

  # Auto-derive assigned_by from parent pane if not given
  if [ -z "$CHILD_ASSIGNED_BY" ] && [ -n "$PARENT_PANE" ] && [ -f "$_REGISTRY" ]; then
    CHILD_ASSIGNED_BY=$(jq -r --arg p "$PARENT_PANE" \
      'to_entries[] | select(.value.pane_id == $p) | .key' \
      "$_REGISTRY" 2>/dev/null | head -1 || echo "")
  fi
  [ -z "$CHILD_ASSIGNED_BY" ] && CHILD_ASSIGNED_BY="chief-of-staff"

  if [ -f "$_REGISTRY" ]; then
    _pane_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
      | awk -v id="$TMUX_PANE" '$1 == id {print $2; exit}')
    _tmux_session=$(tmux list-panes -a -F '#{pane_id} #{session_name}' 2>/dev/null \
      | awk -v id="$TMUX_PANE" '$1 == id {print $2; exit}')

    # Check if already registered (MCP spawn_child may have done it)
    _existing=$(jq -r --arg name "$CHILD_NAME" '.[$name].pane_id // empty' "$_REGISTRY" 2>/dev/null)
    if [ "$_existing" != "$TMUX_PANE" ]; then
      _tmp="${_REGISTRY}.fork.$$"
      jq --arg name "$CHILD_NAME" \
         --arg pane_id "$TMUX_PANE" \
         --arg pane_target "${_pane_target:-}" \
         --arg tmux_session "${_tmux_session:-}" \
         --arg assigned_by "${CHILD_ASSIGNED_BY}" \
         --arg parent_pane "$PARENT_PANE" \
         'if .[$name] then
            .[$name].pane_id = $pane_id |
            .[$name].pane_target = $pane_target |
            .[$name].tmux_session = $tmux_session |
            .[$name].parent_pane = $parent_pane |
            .[$name].assigned_by = $assigned_by
          else
            .[$name] = {pane_id: $pane_id, pane_target: $pane_target,
                        tmux_session: $tmux_session, status: "active",
                        assigned_by: $assigned_by, parent_pane: $parent_pane,
                        model: "opus", branch: ("worker/" + $name)}
          end' "$_REGISTRY" > "$_tmp" 2>/dev/null && mv "$_tmp" "$_REGISTRY"
      echo "Registered $CHILD_NAME (pane $TMUX_PANE, assigned_by: $CHILD_ASSIGNED_BY) in registry.json"
    fi
  fi

  # Export WORKER_NAME so Claude's MCP server knows its identity
  export WORKER_NAME="$CHILD_NAME"
fi

# ── Create git worktree for isolated code (default unless --no-worktree) ──
# Session data is copied to the new worktree's project dir so claude can launch from there.
if [ "$NO_WORKTREE" = false ] && [ -n "${_main_project:-}" ]; then
  _main_basename=$(basename "$_main_project")
  _parent_dir=$(dirname "$_main_project")
  _worktree_dir="${_parent_dir}/${_main_basename}-w-${CHILD_NAME}"
  _branch="worker/${CHILD_NAME}"

  if [ -d "$_worktree_dir" ]; then
    echo "Worktree already exists: $_worktree_dir"
  else
    echo "Creating worktree: $_worktree_dir (branch: $_branch)"
    if ! git -C "$_main_project" rev-parse --verify "$_branch" >/dev/null 2>&1; then
      git -C "$_main_project" branch "$_branch" HEAD 2>/dev/null || true
    fi
    git -C "$_main_project" worktree add "$_worktree_dir" "$_branch" 2>&1 || {
      echo "Warning: worktree creation failed" >&2
      _worktree_dir=""
    }
  fi

  if [ -n "${_worktree_dir:-}" ] && [ -d "$_worktree_dir" ]; then
    echo "Worktree ready: $_worktree_dir"

    # Update registry with worktree_dir
    if [ -f "$_REGISTRY" ]; then
      _tmp="${_REGISTRY}.wt.$$"
      jq --arg name "$CHILD_NAME" --arg wt "$_worktree_dir" \
        '.[$name].worktree_dir = $wt' "$_REGISTRY" > "$_tmp" 2>/dev/null && mv "$_tmp" "$_REGISTRY"
    fi

    # Symlink untracked files that worktrees don't inherit
    for _f in .env; do
      if [ -f "$_main_project/$_f" ] && [ ! -e "$_worktree_dir/$_f" ]; then
        ln -s "$_main_project/$_f" "$_worktree_dir/$_f"
        echo "Symlinked $_f → main project"
      fi
    done

    # Create worker dir if missing
    _worker_dir="${_main_project}/.claude/workers/${CHILD_NAME}"
    if [ ! -d "$_worker_dir" ]; then
      mkdir -p "$_worker_dir"
      echo "Created worker dir: $_worker_dir"
    fi
  fi
fi

# ── Copy session data to new project dir + cd to launch directory ──
# Claude stores sessions at ~/.claude/projects/{path-slug}/{session-id}.jsonl
# Path slug = CWD path with / replaced by -. Different worktree = different slug.
_LAUNCH_DIR=""
if [ -n "$LAUNCH_CWD" ] && [ -d "$LAUNCH_CWD" ]; then
  # spawn_child already copied session data; just cd there
  _LAUNCH_DIR="$LAUNCH_CWD"
elif [ -n "${_worktree_dir:-}" ] && [ -d "$_worktree_dir" ]; then
  # Copy session JSONL + subdir from parent project dir to new worktree's project dir
  _PARENT_PROJ="$HOME/.claude/projects/$(echo "$(pwd)" | tr '/' '-')"
  _NEW_PROJ="$HOME/.claude/projects/$(echo "$_worktree_dir" | tr '/' '-')"
  if [ -f "$_PARENT_PROJ/$PARENT_SESSION.jsonl" ]; then
    mkdir -p "$_NEW_PROJ"
    cp "$_PARENT_PROJ/$PARENT_SESSION.jsonl" "$_NEW_PROJ/$PARENT_SESSION.jsonl" 2>/dev/null || true
    [ -d "$_PARENT_PROJ/$PARENT_SESSION" ] && cp -r "$_PARENT_PROJ/$PARENT_SESSION" "$_NEW_PROJ/$PARENT_SESSION" 2>/dev/null || true
    echo "Copied session data to $_NEW_PROJ"
  fi
  _LAUNCH_DIR="$_worktree_dir"
fi

if [ -n "$_LAUNCH_DIR" ]; then
  cd "$_LAUNCH_DIR"
  echo "Working directory: $(pwd)"
else
  echo "Working directory: $(pwd)  (no worktree — launching from parent dir)"
fi

# ── Add --model flag if specified ──
if [ -n "$CHILD_MODEL" ]; then
  CLAUDE_FLAGS+=("--model" "$CHILD_MODEL")
fi

# ── Add --add-dir for worker config in main project ──
if [ -n "${_main_project:-}" ]; then
  _worker_dir="${_main_project}/.claude/workers/${CHILD_NAME}"
  if [ -d "$_worker_dir" ]; then
    CLAUDE_FLAGS+=("--add-dir" "$_worker_dir")
  fi
fi

# ── Write setup prompt to temp file and pipe into Claude's stdin ──
_SETUP_FILE="/tmp/fork-setup-${CHILD_NAME}-$$.txt"
if [ -n "${_worktree_dir:-}" ] && [ -d "$_worktree_dir" ]; then
  cat > "$_SETUP_FILE" <<SETUP
You have just been forked as worker '${CHILD_NAME}'. You are in your worktree at: $(pwd). Read your mission file if it exists (.claude/workers/${CHILD_NAME}/mission.md in the main project), rebase on origin/main, and begin work.
SETUP
else
  cat > "$_SETUP_FILE" <<SETUP
You have just been forked as worker '${CHILD_NAME}'. No worktree was created. Check your mission file if it exists (.claude/workers/${CHILD_NAME}/mission.md) and begin work.
SETUP
fi

# Hand off to Claude — pipe setup prompt into stdin
cat "$_SETUP_FILE" | claude --resume "$PARENT_SESSION" --fork-session "${CLAUDE_FLAGS[@]+"${CLAUDE_FLAGS[@]}"}"; rm -f "$_SETUP_FILE"
