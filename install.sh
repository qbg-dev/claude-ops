#!/usr/bin/env bash
# install.sh — Install claude-fleet
#
# curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-fleet/main/install.sh | bash
set -euo pipefail

REPO_URL="${CLAUDE_FLEET_REPO:-https://github.com/qbg-dev/claude-fleet.git}"
INSTALL_DIR="${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}"

GREEN='' YELLOW='' RED='' NC=''
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
fi
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

echo ""
echo "  claude-fleet installer"
echo ""

# ── Prerequisites ────────────────────────────────────────────────
missing=()
for cmd in git bun tmux; do
  command -v "$cmd" &>/dev/null || missing+=("$cmd")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  die "Missing: ${missing[*]}. Install them first."
fi

if ! command -v claude &>/dev/null; then
  warn "claude not found — install Claude Code: https://docs.anthropic.com/en/docs/claude-code"
fi
ok "Prerequisites OK"

# ── Clone or update ──────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "Could not fast-forward (local changes?)"
  ok "Updated $INSTALL_DIR"
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi
chmod -R +x "$INSTALL_DIR/bin" "$INSTALL_DIR/hooks" "$INSTALL_DIR/scripts" 2>/dev/null || true

# ── Run fleet setup (does everything else) ───────────────────────
ok "Running fleet setup..."
echo ""
exec bun run "$INSTALL_DIR/cli/index.ts" setup
