#!/usr/bin/env bash
# install.sh — Install claude-ops to ~/.claude-ops and register hooks.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-ops/main/install.sh | bash
#   bash install.sh
#
# What it does:
#   1. Clones (or updates) the repo to ~/.claude-ops
#   2. Adds ~/.claude-ops/bin to PATH in your shell rc file
#   3. Registers Claude Code hooks in ~/.claude/settings.json
#   4. Verifies the installation by running a quick sanity check
set -euo pipefail

REPO_URL="${CLAUDE_OPS_REPO:-https://github.com/qbg-dev/claude-ops.git}"
INSTALL_DIR="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
SETTINGS_FILE="$HOME/.claude/settings.json"

# ── Colors ──────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; NC=''
fi

info()    { echo -e "${GREEN}[claude-ops]${NC} $*"; }
warn()    { echo -e "${YELLOW}[claude-ops]${NC} $*"; }
err()     { echo -e "${RED}[claude-ops]${NC} $*" >&2; }
die()     { err "$*"; exit 1; }

# ── Prerequisite check ───────────────────────────────────────────
check_prereqs() {
  local missing=() optional_missing=()
  for cmd in git jq tmux bash python3; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required tools: ${missing[*]}. Install them and retry."
  fi
  # Optional but recommended
  for cmd in bun curl; do
    command -v "$cmd" &>/dev/null || optional_missing+=("$cmd")
  done
  if [[ ${#optional_missing[@]} -gt 0 ]]; then
    warn "Optional tools not found: ${optional_missing[*]} (needed for MCP servers, google-auth)"
  fi
  info "Prerequisites OK (git, jq, tmux, bash, python3)"
}

# ── Clone or update ──────────────────────────────────────────────
install_repo() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Updating existing installation at $INSTALL_DIR ..."
    git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || {
      warn "Could not fast-forward; skipping update (local changes present?)"
    }
  else
    info "Cloning claude-ops to $INSTALL_DIR ..."
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  # Ensure all hook scripts and bin/ are executable
  find "$INSTALL_DIR/hooks" -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
  find "$INSTALL_DIR/scripts" -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
  find "$INSTALL_DIR/bin" -type f -exec chmod +x {} + 2>/dev/null || true
  info "Ensured scripts are executable"
}

# ── PATH setup ───────────────────────────────────────────────────
setup_path() {
  local bin_dir="$INSTALL_DIR/bin"
  local path_line='export PATH="$HOME/.claude-ops/bin:$PATH"'

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

  if grep -qF ".claude-ops/bin" "$rc_file" 2>/dev/null; then
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
# When installed to a custom dir, symlink ~/.claude-ops → $INSTALL_DIR
# so existing hook paths and scripts continue working.
setup_compat_symlink() {
  local legacy="$HOME/.claude-ops"
  if [[ "$INSTALL_DIR" != "$HOME/.claude-ops" ]]; then
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

# ── Slash commands (claude-ops:*) ─────────────────────────────────
setup_commands() {
  local cmds_src="$INSTALL_DIR/commands"
  local cmds_dst="$HOME/.claude/commands/claude-ops"

  if [[ ! -d "$cmds_src" ]]; then
    info "No commands/ directory — skipping"
    return
  fi

  mkdir -p "$HOME/.claude/commands"
  if [[ -L "$cmds_dst" ]] && [[ "$(readlink "$cmds_dst")" == "$cmds_src" ]]; then
    info "Slash commands symlink already in place"
  else
    ln -sfn "$cmds_src" "$cmds_dst"
    info "Linked slash commands: $cmds_dst → $cmds_src"
  fi
}

# ── Hook registration ────────────────────────────────────────────
register_hooks() {
  info "Installing hooks from manifest..."

  if [[ -f "$INSTALL_DIR/scripts/setup-hooks.sh" ]]; then
    bash "$INSTALL_DIR/scripts/setup-hooks.sh" --core-only || {
      warn "Hook setup had issues — run 'bash ~/.claude-ops/scripts/lint-hooks.sh' to diagnose"
    }
  else
    warn "setup-hooks.sh not found — skipping hook registration"
  fi
}

# ── MCP server registration ────────────────────────────────────────
register_mcp_servers() {
  [[ ! -f "$SETTINGS_FILE" ]] && return

  local mcp_servers=(
    "worker-fleet:$INSTALL_DIR/mcp/worker-fleet/index.js"
    "check-your-work:$INSTALL_DIR/mcp/check-your-work/dist/index.js"
  )

  for entry in "${mcp_servers[@]}"; do
    local name="${entry%%:*}"
    local script="${entry#*:}"
    [[ ! -f "$script" ]] && continue

    # Detect runtime (bun for .ts, node for .js)
    local runtime="node"
    [[ "$script" == *.ts ]] && runtime="bun"

    # Check if already registered
    if jq -e ".mcpServers.\"$name\"" "$SETTINGS_FILE" &>/dev/null; then
      info "MCP server '$name' already registered"
      continue
    fi

    # Register
    local tmp
    tmp=$(mktemp)
    jq --arg name "$name" --arg cmd "$runtime" --arg script "$script" \
      '.mcpServers[$name] = {command: $cmd, args: [$script]}' "$SETTINGS_FILE" > "$tmp" \
      && mv "$tmp" "$SETTINGS_FILE"
    info "Registered MCP server: $name ($runtime $script)"
  done
}

# ── Verification ─────────────────────────────────────────────────
verify_install() {
  info "Verifying installation ..."

  # Check key files exist
  local required=(
    "$INSTALL_DIR/lib/fleet-jq.sh"
    "$INSTALL_DIR/lib/event-bus.sh"
    "$INSTALL_DIR/scripts/scaffold.sh"
    "$INSTALL_DIR/scripts/worker-watchdog.sh"
    "$INSTALL_DIR/scripts/setup-hooks.sh"
    "$INSTALL_DIR/scripts/lint-hooks.sh"
    "$INSTALL_DIR/hooks/manifest.json"
    "$INSTALL_DIR/hooks/interceptors/pre-tool-context-injector.sh"
    "$INSTALL_DIR/hooks/gates/stop-worker-dispatch.sh"
    "$INSTALL_DIR/hooks/gates/stop-inbox-drain.sh"
  )
  local ok=true
  for f in "${required[@]}"; do
    if [[ ! -f "$f" ]]; then
      err "Missing: $f"
      ok=false
    fi
  done

  # Quick source check
  if bash -c "source $INSTALL_DIR/lib/fleet-jq.sh 2>/dev/null && echo ok" | grep -q ok; then
    info "lib/fleet-jq.sh: OK"
  else
    warn "lib/fleet-jq.sh: source check failed (non-fatal)"
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
  echo "  claude-ops installer"
  echo "  ─────────────────────"
  echo ""

  check_prereqs
  install_repo
  setup_path
  setup_compat_symlink
  register_hooks
  register_mcp_servers
  setup_commands
  verify_install

  # ── tmux setup ─────────────────────────────────────────────────
  if [[ -f "$INSTALL_DIR/tmux/setup-tmux.sh" ]]; then
    info "Setting up tmux bindings..."
    bash "$INSTALL_DIR/tmux/setup-tmux.sh" --auto || {
      warn "tmux setup had issues — run 'bash ~/.claude-ops/tmux/setup-tmux.sh' manually"
    }
  fi

  echo ""
  info "Done! claude-ops is installed at $INSTALL_DIR"
  echo ""
  echo "  Next steps:"
  echo "    scaffold:  bash ~/.claude-ops/scripts/scaffold.sh <name> /path/to/project"
  echo "    launch:    bash ~/.claude-ops/scripts/harness-launch.sh <name>"
  echo "    status:    bash ~/.claude-ops/scripts/worker-watchdog.sh --status"
  echo "    tmux:      bash ~/.claude-ops/tmux/setup-tmux.sh --guide   (if new to tmux)"
  echo "    tmux:      bash ~/.claude-ops/tmux/setup-tmux.sh --check   (review merge plan)"
  echo "    docs:      https://github.com/qbg-dev/claude-ops/blob/main/docs/getting-started.md"
  echo ""
}

main "$@"
