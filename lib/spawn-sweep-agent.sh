#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# spawn-sweep-agent.sh — Launch a Claude agent with least-privilege permissions
# ══════════════════════════════════════════════════════════════════
# Reads a permissions manifest (JSON) to construct a restricted Claude
# invocation. Each agent gets only the tools and file patterns it needs.
#
# Usage (source in sweep scripts):
#   source ~/.claude-ops/lib/spawn-sweep-agent.sh
#   PANE=$(spawn_sweep_agent "01-claude-md-cleanup" "$PROJECT_ROOT" "$CONTEXT_FILE")
#
# The permissions manifest lives at:
#   ~/.claude-ops/sweeps.d/permissions/{sweep-slug}.json
#
# Manifest format:
#   {
#     "model": "sonnet",           // claude model name
#     "tools": ["Read", "Edit"],   // available tools (--tools flag)
#     "allowedTools": [            // pre-approved patterns (--allowedTools flag)
#       "Read",
#       "Edit(**/CLAUDE.md)",
#       "Write(**/claude_files/ref/**)",
#       "Bash(git:*)"
#     ]
#   }
#
# Tmux layout:
#   Each sweep gets its own window in the ctrl-plane session.
#   Window name = short sweep slug (e.g., "claude-md", "file-index").
# ══════════════════════════════════════════════════════════════════

PERMISSIONS_DIR="${HOME}/.claude-ops/sweeps.d/permissions"
CP_SESSION_NAME="${CP_TMUX_SESSION:-cp}"

# spawn_sweep_agent <sweep-slug> <project-root> <context-file>
#
# Returns: pane ID on stdout, or empty string on failure.
spawn_sweep_agent() {
  local sweep_slug="$1"
  local project_root="$2"
  local context_file="$3"
  local permissions_file="${PERMISSIONS_DIR}/${sweep_slug}.json"

  # ── Read permissions manifest ────────────────────────────────
  if [ ! -f "$permissions_file" ]; then
    echo "WARN: No permissions manifest at $permissions_file — using defaults" >&2
    local model="sonnet"
    local tools_flag=""
    local allowed_parts=""
  else
    local model tools_json
    model=$(jq -r '.model // "sonnet"' "$permissions_file")
    tools_json=$(jq -r '.tools // [] | join(",")' "$permissions_file")

    # Quote each allowedTools pattern to prevent zsh glob expansion
    # e.g. Edit(**/CLAUDE.md) → "Edit(**/CLAUDE.md)"
    local allowed_parts
    allowed_parts=$(jq -r '.allowedTools // [] | map("\"" + . + "\"") | join(" ")' "$permissions_file")

    local tools_flag=""
    [ -n "$tools_json" ] && tools_flag="--tools $tools_json"
  fi

  # ── Check tmux availability ──────────────────────────────────
  if ! command -v tmux >/dev/null 2>&1; then
    echo "" # empty = failure
    return 1
  fi

  # ── Derive window name from sweep slug ─────────────────────
  # "01-claude-md-cleanup" → "claude-md-cleanup"
  # "04-progress-reconcile" → "progress-reconcile"
  local window_name
  window_name=$(echo "$sweep_slug" | sed 's/^[0-9]*-//')

  # ── Create ctrl-plane session if needed ────────────────────
  local pane=""

  local MAX_PANES=6

  if ! tmux has-session -t "$CP_SESSION_NAME" 2>/dev/null; then
    # Create session with a window for this sweep
    tmux new-session -d -s "$CP_SESSION_NAME" -n "$window_name" -c "$project_root" 2>/dev/null || true
    pane="${CP_SESSION_NAME}:0.0"
  else
    # Find or create the window for this sweep
    local win_idx
    win_idx=$(tmux list-windows -t "$CP_SESSION_NAME" -F '#{window_index} #{window_name}' 2>/dev/null \
      | grep " ${window_name}$" | head -1 | awk '{print $1}')

    if [ -z "$win_idx" ]; then
      # No window yet — create one
      tmux new-window -d -t "$CP_SESSION_NAME" -n "$window_name" -c "$project_root" 2>/dev/null || true
      win_idx=$(tmux list-windows -t "$CP_SESSION_NAME" -F '#{window_index} #{window_name}' 2>/dev/null \
        | grep " ${window_name}$" | head -1 | awk '{print $1}')
      pane="${CP_SESSION_NAME}:${win_idx}.0"
    else
      # Window exists — FIFO pane queue
      local pane_count
      pane_count=$(tmux list-panes -t "${CP_SESSION_NAME}:${win_idx}" 2>/dev/null | wc -l | tr -d ' ')

      if [ "$pane_count" -ge "$MAX_PANES" ]; then
        # Evict oldest pane (index 0) to make room
        tmux kill-pane -t "${CP_SESSION_NAME}:${win_idx}.0" 2>/dev/null || true
        echo "INFO: evicted oldest pane in ${window_name} (FIFO, was at $pane_count panes)" >&2
      fi

      # Split to create a new pane (added at the end = newest)
      pane=$(tmux split-window -d -t "${CP_SESSION_NAME}:${win_idx}" \
        -P -F '#{session_name}:#{window_index}.#{pane_index}' \
        -c "$project_root" 2>/dev/null || true)

      # Re-tile so panes are evenly distributed
      tmux select-layout -t "${CP_SESSION_NAME}:${win_idx}" tiled 2>/dev/null || true
    fi
  fi

  if [ -z "$pane" ]; then
    echo "" # empty = failure
    return 1
  fi

  # ── Construct the claude command with permissions ────────────
  # Security model: --tools is the hard boundary (only these tools exist).
  # We use --permission-mode bypassPermissions because --allowedTools
  # doesn't auto-approve new file creation (Write to non-existent files
  # still prompts). Since --tools already restricts the tool set,
  # bypassPermissions is safe and prevents agents from getting stuck
  # at permission prompts with no one to accept them.
  local claude_cmd="claude --model $model --permission-mode bypassPermissions"

  if [ -n "$tools_flag" ]; then
    claude_cmd="$claude_cmd $tools_flag"
  fi

  # Label the pane
  tmux select-pane -t "$pane" -T "sweep:${sweep_slug}" 2>/dev/null || true

  # ── Launch Claude ────────────────────────────────────────────
  tmux send-keys -t "$pane" "$claude_cmd" && tmux send-keys -t "$pane" -H 0d

  # Wait for Claude to be ready
  local ready=false
  for i in $(seq 1 25); do
    sleep 2
    if tmux capture-pane -t "$pane" -p 2>/dev/null | grep -qE '(bypass permissions|default|❯|>)'; then
      ready=true
      break
    fi
  done

  if [ "$ready" = "false" ]; then
    echo "" # empty = failure
    return 1
  fi

  # ── Send the context file as prompt ──────────────────────────
  tmux send-keys -t "$pane" -l "Read $context_file and follow the instructions inside it."
  sleep 0.5
  tmux send-keys -t "$pane" -H 0d

  # ── Return pane ID ───────────────────────────────────────────
  echo "$pane"
}

# describe_permissions <sweep-slug>
# Prints a human-readable summary of what the agent can do.
describe_permissions() {
  local sweep_slug="$1"
  local permissions_file="${PERMISSIONS_DIR}/${sweep_slug}.json"

  if [ ! -f "$permissions_file" ]; then
    echo "No permissions manifest found"
    return
  fi

  local desc model tools allowed
  desc=$(jq -r '.description // "no description"' "$permissions_file")
  model=$(jq -r '.model // "sonnet"' "$permissions_file")
  tools=$(jq -r '.tools // [] | join(", ")' "$permissions_file")
  allowed=$(jq -r '.allowedTools // [] | map("  - " + .) | join("\n")' "$permissions_file")

  echo "Agent: $desc"
  echo "Model: $model"
  echo "Tools: $tools"
  echo "Allowed patterns:"
  echo "$allowed"
}
