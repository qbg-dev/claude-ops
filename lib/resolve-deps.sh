#!/usr/bin/env bash
# resolve-deps.sh — Resolve paths to runtime dependencies (bun, node, jq, tmux).
# Source this from any script that needs bun or other tools.
#
# Usage:
#   source "$(dirname "$0")/../lib/resolve-deps.sh"   # from scripts/
#   source "$HOME/.claude-ops/lib/resolve-deps.sh"     # absolute
#
# After sourcing:
#   $BUN          — path to bun binary
#   $NODE         — path to node binary
#   $JQ           — path to jq binary
#   $TMUX_BIN     — path to tmux binary
#
# Also exports resolve_project_root() which finds project root without hardcoded fallbacks.

_resolve_bin() {
  local name="$1"
  shift
  # Check each candidate path
  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  # Fall back to PATH lookup
  command -v "$name" 2>/dev/null && return 0
  return 1
}

BUN=$(_resolve_bin bun "$HOME/.bun/bin/bun" "/usr/local/bin/bun" "/opt/homebrew/bin/bun") || BUN=""
NODE=$(_resolve_bin node "$HOME/.nvm/versions/node/*/bin/node" "/usr/local/bin/node" "/opt/homebrew/bin/node") || NODE=""
JQ=$(_resolve_bin jq "/usr/local/bin/jq" "/opt/homebrew/bin/jq") || JQ=""
TMUX_BIN=$(_resolve_bin tmux "/usr/local/bin/tmux" "/opt/homebrew/bin/tmux") || TMUX_BIN=""
CODEX_BIN=$(_resolve_bin codex "$HOME/.local/bin/codex-wrapper" "$HOME/.local/bin/codex" "/usr/local/bin/codex") || CODEX_BIN=""

# resolve_project_root — Find the git root. No hardcoded fallback.
# Usage: PROJECT_ROOT=$(resolve_project_root) or PROJECT_ROOT="${PROJECT_ROOT:-$(resolve_project_root)}"
resolve_project_root() {
  if [ -n "${PROJECT_ROOT:-}" ]; then
    echo "$PROJECT_ROOT"
    return 0
  fi
  git rev-parse --show-toplevel 2>/dev/null && return 0
  echo "ERROR: Cannot determine PROJECT_ROOT. Set PROJECT_ROOT env var or run from a git repo." >&2
  return 1
}

# check_deps — Validate required dependencies are available.
# Usage: check_deps bun jq tmux
check_deps() {
  local missing=0
  for dep in "$@"; do
    local var_name
    case "$dep" in
      bun)   var_name="BUN" ;;
      node)  var_name="NODE" ;;
      jq)    var_name="JQ" ;;
      tmux)  var_name="TMUX_BIN" ;;
      codex) var_name="CODEX_BIN" ;;
      *)
        if ! command -v "$dep" >/dev/null 2>&1; then
          echo "MISSING: $dep — install with: brew install $dep" >&2
          missing=$((missing + 1))
        fi
        continue
        ;;
    esac
    eval "local val=\${$var_name:-}"
    if [ -z "$val" ]; then
      local install_hint
      case "$dep" in
        bun)   install_hint="curl -fsSL https://bun.sh/install | bash" ;;
        node)  install_hint="brew install node" ;;
        jq)    install_hint="brew install jq" ;;
        tmux)  install_hint="brew install tmux" ;;
        codex) install_hint="npm install -g @openai/codex (optional — only needed for runtime=codex workers)" ;;
      esac
      echo "MISSING: $dep — install with: $install_hint" >&2
      missing=$((missing + 1))
    fi
  done
  return $missing
}
