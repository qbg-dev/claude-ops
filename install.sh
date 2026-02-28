#!/usr/bin/env bash
# install.sh — Install boring to ~/.boring and register hooks.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/qbg-dev/boring/main/install.sh | bash
#   bash install.sh
#
# What it does:
#   1. Clones (or updates) the repo to ~/.boring
#   2. Adds ~/.boring/bin to PATH in your shell rc file
#   3. Registers Claude Code hooks in ~/.claude/settings.json
#   4. Verifies the installation by running a quick sanity check
set -euo pipefail

REPO_URL="${BORING_REPO:-${CLAUDE_OPS_REPO:-https://github.com/qbg-dev/boring.git}}"
# Prefer BORING_DIR, fall back to legacy CLAUDE_OPS_DIR, default to ~/.boring
INSTALL_DIR="${BORING_DIR:-${CLAUDE_OPS_DIR:-$HOME/.boring}}"
SETTINGS_FILE="$HOME/.claude/settings.json"

# ── Colors ──────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; NC=''
fi

info()    { echo -e "${GREEN}[boring]${NC} $*"; }
warn()    { echo -e "${YELLOW}[boring]${NC} $*"; }
err()     { echo -e "${RED}[boring]${NC} $*" >&2; }
die()     { err "$*"; exit 1; }

# ── Prerequisite check ───────────────────────────────────────────
check_prereqs() {
  local missing=()
  for cmd in git jq tmux bash; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required tools: ${missing[*]}. Install them and retry."
  fi
  info "Prerequisites OK (git, jq, tmux, bash)"
}

# ── Clone or update ──────────────────────────────────────────────
install_repo() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Updating existing installation at $INSTALL_DIR ..."
    git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || {
      warn "Could not fast-forward; skipping update (local changes present?)"
    }
  else
    info "Cloning boring to $INSTALL_DIR ..."
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
}

# ── PATH setup ───────────────────────────────────────────────────
setup_path() {
  local bin_dir="$INSTALL_DIR/bin"
  local path_line='export PATH="$HOME/.boring/bin:$PATH"'

  # Detect shell rc
  local rc_file=""
  if [[ -n "${BASH_VERSION:-}" ]] || [[ "${SHELL:-}" == *bash* ]]; then
    rc_file="$HOME/.bashrc"
    [[ "$OSTYPE" == darwin* ]] && rc_file="$HOME/.bash_profile"
  elif [[ -n "${ZSH_VERSION:-}" ]] || [[ "${SHELL:-}" == *zsh* ]]; then
    rc_file="$HOME/.zshrc"
  fi

  if [[ -z "$rc_file" ]]; then
    warn "Could not detect shell rc file. Add this to your shell manually:"
    warn "  $path_line"
    return
  fi

  if grep -qF ".boring/bin" "$rc_file" 2>/dev/null; then
    info "PATH already configured in $rc_file"
  else
    echo "$path_line" >> "$rc_file"
    info "Added $bin_dir to PATH in $rc_file"
    info "Run: source $rc_file  (or open a new terminal)"
  fi

  # Export for the current session
  export PATH="$bin_dir:$PATH"
}

# ── Backwards-compat symlink ─────────────────────────────────────
# ~/.claude-ops → ~/.boring so existing hook paths and scripts continue working
setup_compat_symlink() {
  local legacy="$HOME/.claude-ops"
  if [[ "$INSTALL_DIR" == "$HOME/.boring" ]]; then
    if [[ -L "$legacy" ]] && [[ "$(readlink "$legacy")" == "$INSTALL_DIR" ]]; then
      info "Compat symlink already in place ($legacy → $INSTALL_DIR)"
    elif [[ -d "$legacy" ]] && [[ ! -L "$legacy" ]]; then
      warn "$legacy exists as a real directory — not replacing with symlink."
      warn "Existing Claude Code hooks pointing to ~/.claude-ops will still work."
    else
      ln -sfn "$INSTALL_DIR" "$legacy"
      info "Created compat symlink: $legacy → $INSTALL_DIR"
    fi
  fi
}

# ── Hook registration ────────────────────────────────────────────
register_hooks() {
  local settings="$SETTINGS_FILE"
  mkdir -p "$(dirname "$settings")"

  # Read existing settings or start fresh
  local current='{}'
  [[ -f "$settings" ]] && current=$(cat "$settings")

  # Check if hooks are already registered (idempotent)
  if echo "$current" | jq -e '.hooks.Stop' &>/dev/null; then
    info "Hooks already registered in $settings"
    return
  fi

  info "Registering Claude Code hooks in $settings ..."

  # Merge hooks into existing settings (preserves other settings)
  local updated
  updated=$(echo "$current" | jq '. + {
    "hooks": {
      "PreToolUse": [{"hooks": [{"type": "command", "command": "bash ~/.boring/hooks/interceptors/pre-tool-context-injector.sh"}]}],
      "PostToolUse": [{"hooks": [{"type": "command", "command": "bash ~/.boring/hooks/publishers/post-tool-publisher.sh"}]}],
      "Stop": [{"hooks": [{"type": "command", "command": "bash ~/.boring/hooks/gates/stop-harness-dispatch.sh"}]}],
      "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "bash ~/.boring/hooks/publishers/prompt-publisher.sh"}]}]
    }
  }')

  echo "$updated" > "$settings"
  info "Hooks registered"
}

# ── Verification ─────────────────────────────────────────────────
verify_install() {
  info "Verifying installation ..."

  # Check key files exist
  local required=(
    "$INSTALL_DIR/lib/harness-jq.sh"
    "$INSTALL_DIR/lib/event-bus.sh"
    "$INSTALL_DIR/scripts/scaffold.sh"
    "$INSTALL_DIR/scripts/harness-watchdog.sh"
    "$INSTALL_DIR/hooks/interceptors/pre-tool-context-injector.sh"
    "$INSTALL_DIR/hooks/gates/stop-harness-dispatch.sh"
  )
  local ok=true
  for f in "${required[@]}"; do
    if [[ ! -f "$f" ]]; then
      err "Missing: $f"
      ok=false
    fi
  done

  # Quick source check
  if bash -c "source $INSTALL_DIR/lib/harness-jq.sh 2>/dev/null && echo ok" | grep -q ok; then
    info "lib/harness-jq.sh: OK"
  else
    warn "lib/harness-jq.sh: source check failed (non-fatal)"
  fi

  if [[ "$ok" == "true" ]]; then
    info "Installation verified"
  else
    die "Some files are missing. Try: rm -rf $INSTALL_DIR && bash install.sh"
  fi
}

# ── Main ─────────────────────────────────────────────────────────
main() {
  echo ""
  echo "  boring installer"
  echo "  ─────────────────────"
  echo ""

  check_prereqs
  install_repo
  setup_path
  setup_compat_symlink
  register_hooks
  verify_install

  echo ""
  info "Done! boring is installed at $INSTALL_DIR"
  echo ""
  echo "  Next steps:"
  echo "    scaffold:  bash ~/.boring/scripts/scaffold.sh <name> /path/to/project"
  echo "    launch:    bash ~/.boring/scripts/harness-launch.sh <name>"
  echo "    status:    bash ~/.boring/scripts/harness-watchdog.sh --status"
  echo "    docs:      https://github.com/qbg-dev/boring/blob/main/docs/getting-started.md"
  echo ""
}

main "$@"
