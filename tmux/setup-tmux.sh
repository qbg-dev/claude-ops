#!/usr/bin/env bash
# setup-tmux.sh — Merge claude-ops tmux bindings into the user's tmux config.
#
# This script is designed to be run by Claude Code (headful) during install,
# or manually by the user. It:
#   1. Detects whether tmux is installed and whether we're in a tmux session
#   2. Reads the user's existing .tmux.conf (if any)
#   3. Writes a merge-plan showing conflicts and new bindings
#   4. Applies the merge (source-file approach — non-destructive)
#
# Usage:
#   bash ~/.claude-ops/tmux/setup-tmux.sh              # interactive (for Claude)
#   bash ~/.claude-ops/tmux/setup-tmux.sh --auto        # non-interactive
#   bash ~/.claude-ops/tmux/setup-tmux.sh --check       # dry-run: show plan only
#   bash ~/.claude-ops/tmux/setup-tmux.sh --guide       # tmux beginner walkthrough
set -eo pipefail

CLAUDE_OPS_DIR="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
CLAUDE_OPS_TMUX_CONF="$CLAUDE_OPS_DIR/tmux/claude-ops.tmux.conf"
USER_TMUX_CONF="${TMUX_CONF:-$HOME/.tmux.conf}"
MERGE_REPORT="/tmp/claude-ops-tmux-merge-report.txt"

# ── Colors ──────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; CYAN=''; BOLD=''; NC=''
fi

info()  { echo -e "${GREEN}[tmux-setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[tmux-setup]${NC} $*"; }
err()   { echo -e "${RED}[tmux-setup]${NC} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}$*${NC}"; }

# ── Detect environment ─────────────────────────────────────────
detect_environment() {
  local report=""

  # tmux installed?
  if ! command -v tmux &>/dev/null; then
    report+="tmux_installed=false\n"
    echo -e "$report"
    return
  fi
  report+="tmux_installed=true\n"
  report+="tmux_version=$(tmux -V 2>/dev/null | cut -d' ' -f2)\n"

  # In a tmux session?
  if [[ -n "${TMUX:-}" ]]; then
    report+="in_tmux=true\n"
    report+="tmux_session=$(tmux display-message -p '#{session_name}' 2>/dev/null)\n"
  else
    report+="in_tmux=false\n"
  fi

  # Existing config?
  if [[ -f "$USER_TMUX_CONF" ]]; then
    report+="has_config=true\n"
    report+="config_path=$USER_TMUX_CONF\n"
    report+="config_lines=$(wc -l < "$USER_TMUX_CONF")\n"
  else
    report+="has_config=false\n"
  fi

  # Already sourcing claude-ops?
  if [[ -f "$USER_TMUX_CONF" ]] && grep -qF "claude-ops" "$USER_TMUX_CONF" 2>/dev/null; then
    report+="already_sourced=true\n"
  else
    report+="already_sourced=false\n"
  fi

  # Prefix key
  if [[ -f "$USER_TMUX_CONF" ]]; then
    local prefix
    prefix=$(grep -E '^\s*set\s+(-g\s+)?prefix\s+' "$USER_TMUX_CONF" 2>/dev/null | tail -1 | awk '{print $NF}')
    if [[ -n "$prefix" ]]; then
      report+="prefix_key=$prefix\n"
    else
      report+="prefix_key=C-b\n"
    fi
  else
    report+="prefix_key=C-b\n"
  fi

  echo -e "$report"
}

# ── Extract bindings from a tmux conf ──────────────────────────
# Returns lines like: "h|bind-key h select-pane -L"
# Only extracts prefix-table bindings (skips -T root, -T copy-mode-vi, -n)
extract_bindings() {
  local conf="$1"
  [[ -f "$conf" ]] || return 0
  grep -E '^\s*bind(-key)?\s+' "$conf" 2>/dev/null | while IFS= read -r line; do
    # Skip comments
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    # Skip non-prefix bindings (-n = root table, -T = explicit table)
    [[ "$line" =~ -n[[:space:]] ]] && continue
    [[ "$line" =~ -T[[:space:]] ]] && continue
    # Strip leading whitespace and bind/bind-key
    local rest
    rest=$(echo "$line" | sed 's/^[[:space:]]*//' | sed 's/^bind-key[[:space:]]*//' | sed 's/^bind[[:space:]]*//')
    # Strip -r flag if present
    rest=$(echo "$rest" | sed 's/^-r[[:space:]]*//')
    # First token is the key
    local key
    key=$(echo "$rest" | awk '{print $1}')
    # Clean quotes from key
    key=$(echo "$key" | tr -d "'\"")
    if [[ -n "$key" ]]; then
      echo "${key}|${line}"
    fi
  done
}

# ── Build merge plan ───────────────────────────────────────────
build_merge_plan() {
  local user_bindings ops_bindings
  user_bindings=$(extract_bindings "$USER_TMUX_CONF")
  ops_bindings=$(extract_bindings "$CLAUDE_OPS_TMUX_CONF")

  local user_keys=""
  if [[ -n "$user_bindings" ]]; then
    user_keys=$(echo "$user_bindings" | cut -d'|' -f1 | sort -u)
  fi

  local conflicts=() new_bindings=() kept=()

  while IFS= read -r ops_entry; do
    [[ -z "$ops_entry" ]] && continue
    local ops_key ops_line
    ops_key=$(echo "$ops_entry" | cut -d'|' -f1)
    ops_line=$(echo "$ops_entry" | cut -d'|' -f2-)

    if echo "$user_keys" | grep -qxF "$ops_key" 2>/dev/null; then
      local user_line
      user_line=$(echo "$user_bindings" | grep "^${ops_key}|" | head -1 | cut -d'|' -f2-)
      if [[ "$user_line" == "$ops_line" ]]; then
        kept+=("$ops_key: identical in both configs")
      else
        conflicts+=("$ops_key|USER: $user_line|OPS:  $ops_line")
      fi
    else
      new_bindings+=("$ops_key: $ops_line")
    fi
  done <<< "$ops_bindings"

  # Write report
  {
    echo "═══════════════════════════════════════════════════"
    echo "  claude-ops tmux merge plan"
    echo "═══════════════════════════════════════════════════"
    echo ""

    if [[ ${#conflicts[@]} -gt 0 ]]; then
      echo "CONFLICTS (${#conflicts[@]}) — your binding wins, ops functionality added alongside:"
      for c in "${conflicts[@]}"; do
        IFS='|' read -r key user ops <<< "$c"
        echo "  Key '$key':"
        echo "    $user"
        echo "    $ops"
        echo ""
      done
    else
      echo "CONFLICTS: None"
      echo ""
    fi

    echo "NEW BINDINGS (${#new_bindings[@]}) — will be added:"
    for b in "${new_bindings[@]}"; do
      echo "  $b"
    done
    echo ""

    if [[ ${#kept[@]} -gt 0 ]]; then
      echo "IDENTICAL (${#kept[@]}) — already in your config:"
      for k in "${kept[@]}"; do
        echo "  $k"
      done
      echo ""
    fi

    echo "SETTINGS (non-binding) — these will be set:"
    echo "  pane-border-status, pane-border-format, history-limit,"
    echo "  escape-time, mouse, focus-events, mode-keys vi,"
    echo "  monitor-activity, aggressive-resize, set-clipboard"
    echo ""
    echo "APPROACH: source-file (non-destructive)"
    echo "  A single line is added to your .tmux.conf:"
    echo "    source-file ~/.claude-ops/tmux/claude-ops.tmux.conf"
    echo "  Your existing bindings take priority (loaded first)."
    echo "  To override: move the source-file line above your bindings."
  } > "$MERGE_REPORT"

  cat "$MERGE_REPORT"
}

# ── Apply merge ────────────────────────────────────────────────
apply_merge() {
  local source_line='source-file ~/.claude-ops/tmux/claude-ops.tmux.conf'

  if [[ ! -f "$USER_TMUX_CONF" ]]; then
    info "No existing .tmux.conf — creating one with claude-ops bindings."
    cat > "$USER_TMUX_CONF" << 'TMUX_CONF'
# tmux configuration
# Generated by claude-ops setup. Customize freely — claude-ops bindings
# are loaded via source-file at the bottom and won't override your settings.

# Prefix key (default: C-b. Many devs prefer C-x or C-a)
# set -g prefix C-x
# bind C-x send-prefix

# Your custom bindings go here...


TMUX_CONF
    echo "# claude-ops bindings (auto-managed — do not edit this line)" >> "$USER_TMUX_CONF"
    echo "$source_line" >> "$USER_TMUX_CONF"
    info "Created $USER_TMUX_CONF with claude-ops bindings."
    return 0
  fi

  # Already sourced?
  if grep -qF "claude-ops/tmux/claude-ops.tmux.conf" "$USER_TMUX_CONF" 2>/dev/null; then
    info "claude-ops bindings already sourced in $USER_TMUX_CONF"
    return 0
  fi

  # Backup
  local backup="${USER_TMUX_CONF}.pre-claude-ops.bak"
  if [[ ! -f "$backup" ]]; then
    cp "$USER_TMUX_CONF" "$backup"
    info "Backed up existing config to $backup"
  fi

  # Append source-file at the end (user bindings loaded first = higher priority)
  echo "" >> "$USER_TMUX_CONF"
  echo "# claude-ops bindings (auto-managed — do not edit this line)" >> "$USER_TMUX_CONF"
  echo "$source_line" >> "$USER_TMUX_CONF"
  info "Added source-file line to $USER_TMUX_CONF"
  info "Your existing bindings take priority (loaded first)."

  # Reload if in tmux
  if [[ -n "${TMUX:-}" ]]; then
    tmux source-file "$USER_TMUX_CONF" 2>/dev/null && info "Config reloaded in current session." || warn "Could not reload — run: tmux source-file ~/.tmux.conf"
  else
    info "Not in tmux — bindings will apply on next tmux start."
  fi
}

# ── Beginner guide ─────────────────────────────────────────────
print_guide() {
  cat << 'GUIDE'
═══════════════════════════════════════════════════
  tmux Quick Start for Claude Code
═══════════════════════════════════════════════════

tmux is a terminal multiplexer — it lets you run multiple terminal
sessions inside one window, and they persist even if you disconnect.

This is essential for Claude Code multi-agent development because
each agent runs in its own pane, and tmux lets you:
  - See all agents at once (split panes)
  - Switch between agents instantly (keyboard shortcuts)
  - Keep agents running when you close your terminal
  - Resume sessions after disconnection

GETTING STARTED:

  1. Start tmux:
     $ tmux new -s dev

  2. You're now inside tmux. Everything looks the same, but you
     have superpowers. The prefix key is how you tell tmux
     "the next key is a tmux command, not terminal input."

     Default prefix: Ctrl+B (many devs change to Ctrl+X or Ctrl+A)

  3. Essential commands (press prefix, then the key):

     PANES (splits within a window):
       prefix + v     Split vertically (side by side)
       prefix + s     Split horizontally (top/bottom)
       prefix + h/j/k/l  Move between panes (vim-style)
       prefix + K     Kill current pane
       prefix + z     Zoom/unzoom current pane (fullscreen toggle)
       prefix + n     Next pane (keeps zoom)

     WINDOWS (tabs):
       prefix + c     New window
       prefix + space Next window
       prefix + bspace Previous window
       prefix + 1-9   Jump to window by number

     SESSIONS:
       prefix + d     Detach (tmux keeps running in background)
       $ tmux attach  Reattach to your session
       $ tmux ls      List all sessions

     COPY MODE (scrolling):
       prefix + x     Enter copy mode (scroll with j/k or mouse)
       q              Exit copy mode

  4. Claude Code agent shortcuts (after claude-ops setup):

       prefix + y     Copy resume command (paste in new pane to resume)
       prefix + Y     Copy fork command (paste to fork an agent)
       prefix + X     Fork agent into new pane (one keypress)
       prefix + a     Cycle through active agent panes
       prefix + i     Show harness status popup
       prefix + P     Copy pane target to clipboard

  5. When you're done:
       prefix + d     Detach (agents keep running)
       $ tmux kill-session -t dev   Kill everything

TIP: Use the mouse! Click panes to focus, drag borders to resize,
scroll with your trackpad. Mouse support is enabled by default.
GUIDE
}

# ── Main ───────────────────────────────────────────────────────
main() {
  local mode="${1:-}"

  case "$mode" in
    --guide)
      print_guide
      exit 0
      ;;
    --check)
      header "Environment Detection"
      detect_environment
      echo ""
      header "Merge Plan"
      build_merge_plan
      exit 0
      ;;
    --auto)
      info "Auto-applying claude-ops tmux bindings..."
      apply_merge
      exit 0
      ;;
    *)
      # Interactive mode — output everything for Claude to present
      header "Environment"
      local env_info
      env_info=$(detect_environment)
      echo "$env_info"

      local in_tmux
      in_tmux=$(echo "$env_info" | grep "in_tmux=" | cut -d= -f2)
      local has_config
      has_config=$(echo "$env_info" | grep "has_config=" | cut -d= -f2)
      local tmux_installed
      tmux_installed=$(echo "$env_info" | grep "tmux_installed=" | cut -d= -f2)

      if [[ "$tmux_installed" == "false" ]]; then
        err "tmux is not installed. Install it first:"
        echo "  macOS:  brew install tmux"
        echo "  Ubuntu: sudo apt install tmux"
        echo "  Fedora: sudo dnf install tmux"
        exit 1
      fi

      if [[ "$in_tmux" == "false" ]]; then
        warn "You're not in a tmux session."
        echo "  Start one with: tmux new -s dev"
        echo "  Or run with --guide for a tmux tutorial."
      fi

      echo ""
      if [[ "$has_config" == "true" ]]; then
        header "Merge Plan"
        build_merge_plan
      else
        info "No existing .tmux.conf found — will create one with claude-ops defaults."
      fi

      echo ""
      header "Ready to Apply"
      echo "This will add a source-file line to your .tmux.conf."
      echo "Your existing bindings are preserved and take priority."
      read -rp "Apply? [Y/n] " answer
      if [[ "${answer:-Y}" =~ ^[Yy]?$ ]]; then
        apply_merge
        info "Done! Press prefix + R to reload, or restart tmux."
      else
        info "Skipped. Run again with --auto to apply non-interactively."
      fi
      ;;
  esac
}

main "$@"
