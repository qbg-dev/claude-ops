#!/usr/bin/env bash
# init-project.sh — Bootstrap a project for claude-ops worker fleet.
#
# Usage:
#   bash ~/.claude-ops/scripts/init-project.sh [/path/to/project]
#   bash ~/.claude-ops/scripts/init-project.sh --with-chief-of-staff
#   bash ~/.claude-ops/scripts/init-project.sh .  # current directory
#
# What it does:
#   1. Ensures the directory is a git repo (git init if not)
#   2. Creates .claude/ directory structure (workers, scripts, hooks)
#   3. Creates .mcp.json wiring worker-fleet MCP server
#   4. Creates initial registry.json with _config
#   5. Sets up shared worker scripts
#   6. Installs fleet CLAUDE.md
#   7. Verifies hooks installation
#   8. Sets up statusline (session tracking, spending, worker display)
#   9. Optionally launches chief-of-staff worker
set -euo pipefail

CLAUDE_OPS_DIR="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"

# Colors
if [[ -t 1 ]]; then
  G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;34m'; N='\033[0m'
else
  G=''; Y=''; R=''; B=''; N=''
fi
info()  { echo -e "${G}[init]${N} $*"; }
warn()  { echo -e "${Y}[init]${N} $*"; }
err()   { echo -e "${R}[init]${N} $*" >&2; }
step()  { echo -e "${B}[init]${N} $*"; }

LAUNCH_COS=false
PROJECT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --with-chief-of-staff|--cos) LAUNCH_COS=true ;;
    --help|-h)
      echo "Usage: init-project.sh [/path/to/project] [--with-chief-of-staff]"
      echo ""
      echo "Options:"
      echo "  --with-chief-of-staff  Also create and launch a chief-of-staff worker"
      echo "  /path/to/project       Target directory (default: current directory)"
      exit 0
      ;;
    *)
      if [ -d "$arg" ]; then
        PROJECT_DIR="$arg"
      else
        err "Not a directory: $arg"
        exit 1
      fi
      ;;
  esac
done

[ -z "$PROJECT_DIR" ] && PROJECT_DIR="$(pwd)"
PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)  # absolute path
PROJECT_NAME=$(basename "$PROJECT_DIR")

echo ""
echo "  claude-ops project init"
echo "  ───────────────────────"
echo "  Project: $PROJECT_NAME"
echo "  Path:    $PROJECT_DIR"
echo ""

# ── Step 1: Git repo ──
step "1/9 Checking git repo..."
if [ -d "$PROJECT_DIR/.git" ]; then
  info "Already a git repo"
else
  info "Initializing git repo..."
  git -C "$PROJECT_DIR" init
  git -C "$PROJECT_DIR" add -A
  git -C "$PROJECT_DIR" commit -m "initial commit" --allow-empty
  info "Git repo initialized"
fi

MAIN_BRANCH=$(git -C "$PROJECT_DIR" branch --show-current)
info "Main branch: $MAIN_BRANCH"

# ── Step 2: .claude/ directory structure ──
step "2/9 Creating .claude/ structure..."
mkdir -p "$PROJECT_DIR/.claude/workers"
mkdir -p "$PROJECT_DIR/.claude/scripts/worker"
mkdir -p "$PROJECT_DIR/.claude/hooks"
info ".claude/ structure created"

# ── Step 3: .mcp.json ──
step "3/9 Setting up MCP configuration..."
MCP_FILE="$PROJECT_DIR/.mcp.json"
if [ -f "$MCP_FILE" ]; then
  # Check if worker-fleet is already configured
  if jq -e '.mcpServers["worker-fleet"]' "$MCP_FILE" >/dev/null 2>&1; then
    info ".mcp.json already has worker-fleet configured"
  else
    # Add worker-fleet to existing .mcp.json
    jq --arg ops "$CLAUDE_OPS_DIR" '.mcpServers["worker-fleet"] = {
      "type": "stdio",
      "command": "node",
      "args": [($ops + "/mcp/worker-fleet/index.js")],
      "env": {
        "PROJECT_ROOT": "'"$PROJECT_DIR"'",
        "WORKER_FLEET_LOG": "/tmp/worker-fleet.log"
      }
    }' "$MCP_FILE" > "$MCP_FILE.tmp" && mv "$MCP_FILE.tmp" "$MCP_FILE"
    info "Added worker-fleet to existing .mcp.json"
  fi
else
  cat > "$MCP_FILE" << MCPEOF
{
  "mcpServers": {
    "worker-fleet": {
      "type": "stdio",
      "command": "node",
      "args": ["$CLAUDE_OPS_DIR/mcp/worker-fleet/index.js"],
      "env": {
        "PROJECT_ROOT": "$PROJECT_DIR",
        "WORKER_FLEET_LOG": "/tmp/worker-fleet.log"
      }
    }
  }
}
MCPEOF
  info "Created .mcp.json"
fi

# ── Step 4: Registry ──
step "4/9 Creating worker registry..."
REGISTRY="$PROJECT_DIR/.claude/workers/registry.json"
if [ -f "$REGISTRY" ]; then
  info "Registry already exists"
else
  cat > "$REGISTRY" << REGEOF
{
  "_config": {
    "merge_authority": "merger",
    "deploy_authority": "merger",
    "mission_authority": "chief-of-staff",
    "tmux_session": "",
    "project_name": "$PROJECT_NAME"
  }
}
REGEOF
  info "Created registry.json"
fi

# ── Step 5: Shared scripts ──
step "5/9 Setting up shared worker scripts..."

# Copy shared worker scripts from claude-ops templates if they exist
SHARED_SCRIPTS_SRC="$CLAUDE_OPS_DIR/templates/flat-worker/scripts"
SHARED_SCRIPTS_DST="$PROJECT_DIR/.claude/scripts/worker"

# Create deploy-to-slot placeholder if not exists
if [ ! -f "$SHARED_SCRIPTS_DST/deploy-to-slot.sh" ]; then
  cat > "$SHARED_SCRIPTS_DST/deploy-to-slot.sh" << 'SLOTEOF'
#!/usr/bin/env bash
# deploy-to-slot.sh — Deploy worker branch to isolated test slot.
# Override this with project-specific deployment logic.
echo "[deploy-to-slot] Not configured for this project."
echo "Edit .claude/scripts/worker/deploy-to-slot.sh to add deployment."
exit 1
SLOTEOF
  chmod +x "$SHARED_SCRIPTS_DST/deploy-to-slot.sh"
  info "Created placeholder deploy-to-slot.sh"
fi

# Create pre-validate placeholder if not exists
if [ ! -f "$SHARED_SCRIPTS_DST/pre-validate.sh" ]; then
  cat > "$SHARED_SCRIPTS_DST/pre-validate.sh" << 'VALEOF'
#!/usr/bin/env bash
# pre-validate.sh — Run before merge requests to catch issues.
# Override with project-specific validation (tsc, tests, lint).
set -euo pipefail
echo "[pre-validate] Running basic checks..."

# TypeScript check (if tsconfig exists)
if [ -f "tsconfig.json" ]; then
  echo "  TypeScript..."
  npx tsc --noEmit || { echo "TypeScript errors found"; exit 1; }
fi

# Test (if test script exists)
if grep -q '"test"' package.json 2>/dev/null; then
  echo "  Tests..."
  npm test || { echo "Tests failed"; exit 1; }
fi

echo "[pre-validate] All checks passed"
VALEOF
  chmod +x "$SHARED_SCRIPTS_DST/pre-validate.sh"
  info "Created placeholder pre-validate.sh"
fi

# ── Step 6: CLAUDE.md fleet docs ──
step "6/9 Installing fleet CLAUDE.md..."
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
UPSTREAM_CLAUDE_MD="$CLAUDE_OPS_DIR/CLAUDE.md"

if [ -f "$CLAUDE_MD" ] && grep -qF "claude-ops" "$CLAUDE_MD"; then
  info "CLAUDE.md already has fleet docs"
else
  if [ -f "$UPSTREAM_CLAUDE_MD" ]; then
    # Append upstream fleet docs to existing CLAUDE.md (or create if none)
    if [ -f "$CLAUDE_MD" ]; then
      echo "" >> "$CLAUDE_MD"
      cat "$UPSTREAM_CLAUDE_MD" >> "$CLAUDE_MD"
      info "Appended fleet docs from upstream CLAUDE.md"
    else
      cp "$UPSTREAM_CLAUDE_MD" "$CLAUDE_MD"
      info "Installed fleet CLAUDE.md"
    fi
  else
    warn "No upstream CLAUDE.md found at $UPSTREAM_CLAUDE_MD"
  fi
fi

# ── Step 7: Verify hooks ──
step "7/9 Verifying hooks installation..."
if bash "$CLAUDE_OPS_DIR/scripts/lint-hooks.sh" --quiet 2>/dev/null; then
  info "Hooks OK"
else
  warn "Some hooks may be missing — run: bash ~/.claude-ops/scripts/setup-hooks.sh"
fi

# ── Step 8: Statusline ──
step "8/9 Setting up statusline..."
STATUSLINE_SRC="$CLAUDE_OPS_DIR/scripts/statusline-command.sh"
STATUSLINE_DST="$HOME/.claude/statusline-command.sh"
if [ -f "$STATUSLINE_SRC" ]; then
  if [ -L "$STATUSLINE_DST" ]; then
    LINK_TARGET=$(readlink "$STATUSLINE_DST")
    if [ "$LINK_TARGET" = "$STATUSLINE_SRC" ]; then
      info "Statusline already symlinked to claude-ops"
    else
      warn "Statusline symlinked to: $LINK_TARGET (not claude-ops)"
      warn "To use the claude-ops statusline: ln -sf $STATUSLINE_SRC $STATUSLINE_DST"
    fi
  elif [ -f "$STATUSLINE_DST" ]; then
    warn "Existing statusline found at $STATUSLINE_DST (not managed by claude-ops)"
    warn "claude-ops statusline: $STATUSLINE_SRC"
    warn "Features: session ID tracking, spending tracker, worker registry display"
    warn "To merge: launch a Claude Code session and ask it to merge the two scripts"
    warn "To replace: ln -sf $STATUSLINE_SRC $STATUSLINE_DST"
  else
    ln -s "$STATUSLINE_SRC" "$STATUSLINE_DST"
    info "Statusline symlinked: $STATUSLINE_DST → $STATUSLINE_SRC"
  fi
else
  warn "No statusline script found at $STATUSLINE_SRC"
fi

# ── Step 9: Chief of Staff ──
if [ "$LAUNCH_COS" = true ]; then
  step "9/9 Setting up chief-of-staff worker..."

  COS_DIR="$PROJECT_DIR/.claude/workers/chief-of-staff"
  mkdir -p "$COS_DIR"

  if [ ! -f "$COS_DIR/mission.md" ]; then
    cp "$CLAUDE_OPS_DIR/templates/flat-worker/types/chief-of-staff/mission.md" "$COS_DIR/mission.md" 2>/dev/null || {
      # Inline fallback if template doesn't exist
      cat > "$COS_DIR/mission.md" << 'COSEOF'
# chief-of-staff — Fleet Coordinator

## Mission

Process worker messages, relay priorities, optimize worker missions, and monitor fleet health.

## Cycle Protocol (every 15 minutes)

1. Drain inbox — act on all messages before anything else
2. Fleet health check — identify stuck/crashed/drifting workers
3. Review 1-2 workers — read state, recent commits, assess productivity
4. Relay priorities — when directed, update relevant worker missions
5. Sleep 15 minutes

## Rules

- NEVER merge branches or deploy
- NEVER edit source code
- Forward merge requests to merger
COSEOF
      info "Created chief-of-staff mission"
    }
  fi

  # Add to registry
  if ! jq -e '."chief-of-staff"' "$REGISTRY" >/dev/null 2>&1; then
    jq '. + {"chief-of-staff": {
      "model": "opus",
      "permission_mode": "bypassPermissions",
      "disallowed_tools": ["Bash(git reset --hard*)", "Bash(git clean*)", "Bash(rm -rf*)", "Bash(sudo *)"],
      "status": "idle",
      "perpetual": true,
      "sleep_duration": 900,
      "cycles_completed": 0,
      "report_to": null,
      "custom": {}
    }}' "$REGISTRY" > "$REGISTRY.tmp" && mv "$REGISTRY.tmp" "$REGISTRY"
    info "Added chief-of-staff to registry"
  fi

  info "Chief of staff configured. Launch with:"
  echo ""
  echo "    bash ~/.claude-ops/scripts/launch-flat-worker.sh chief-of-staff"
  echo ""
else
  step "9/9 Skipping chief-of-staff (use --with-chief-of-staff to create)"
fi

# ── Initial commit ──
cd "$PROJECT_DIR"
if ! git diff --quiet --cached 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard .claude/ .mcp.json CLAUDE.md)" ]; then
  git add .claude/ .mcp.json CLAUDE.md
  git commit -m "chore: bootstrap claude-ops worker fleet infrastructure" 2>/dev/null || true
  info "Committed initial fleet config"
fi

echo ""
info "Project initialized for claude-ops!"
echo ""
echo "  Next steps:"
echo "    1. Review .claude/workers/registry.json"
echo "    2. Create workers: bash ~/.claude-ops/scripts/launch-flat-worker.sh <name>"
echo "    3. Monitor: use fleet_status() MCP tool in any Claude session"
echo ""
echo "  Docs: cat ~/.claude-ops/CLAUDE.md"
echo ""
