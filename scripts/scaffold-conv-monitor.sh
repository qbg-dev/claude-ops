#!/usr/bin/env bash
# scaffold-conv-monitor.sh — Scaffold a conv-monitor worker for any project.
#
# Reads templates from ~/.claude-ops/templates/conv-monitor/, replaces
# {{PLACEHOLDER}} values with provided arguments, and writes customized
# files to .claude/workers/{name}/ in the current project.
#
# Usage:
#   bash ~/.claude-ops/scripts/scaffold-conv-monitor.sh \
#     --name conv-monitor \
#     --host 120.77.216.196 \
#     --ssh-pass 'password' \
#     --db-path '/opt/app/data/chatbot.db' \
#     --domain 'wx.example.com' \
#     --projects '80 (ProjectA), 73 (ProjectB)'
#
# All arguments are required except --name (defaults to "conv-monitor").
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────
WORKER_NAME="conv-monitor"
PROD_HOST=""
PROD_SSH_PASS=""
DB_PATH=""
DOMAIN=""
PROJECTS=""

TEMPLATE_DIR="${CLAUDE_OPS_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-ops}}/templates/conv-monitor"
if [ ! -d "$TEMPLATE_DIR" ] && [ -d "$HOME/.claude-ops/templates/conv-monitor" ]; then
  TEMPLATE_DIR="$HOME/.claude-ops/templates/conv-monitor"
fi

# ── Parse arguments ───────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)      WORKER_NAME="$2"; shift 2 ;;
    --host)      PROD_HOST="$2"; shift 2 ;;
    --ssh-pass)  PROD_SSH_PASS="$2"; shift 2 ;;
    --db-path)   DB_PATH="$2"; shift 2 ;;
    --domain)    DOMAIN="$2"; shift 2 ;;
    --projects)  PROJECTS="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: scaffold-conv-monitor.sh --host IP --ssh-pass PASS --db-path PATH --domain DOMAIN --projects 'LIST'"
      echo ""
      echo "Options:"
      echo "  --name       Worker name (default: conv-monitor)"
      echo "  --host       Production server IP address"
      echo "  --ssh-pass   SSH password for root@host"
      echo "  --db-path    Absolute path to SQLite database on prod"
      echo "  --domain     Production domain (e.g., wx.example.com)"
      echo "  --projects   Project list (e.g., '80 (ProjectA), 73 (ProjectB)')"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────
MISSING=()
[ -z "$PROD_HOST" ]     && MISSING+=("--host")
[ -z "$PROD_SSH_PASS" ] && MISSING+=("--ssh-pass")
[ -z "$DB_PATH" ]       && MISSING+=("--db-path")
[ -z "$DOMAIN" ]        && MISSING+=("--domain")
[ -z "$PROJECTS" ]      && MISSING+=("--projects")

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "ERROR: Missing required arguments: ${MISSING[*]}"
  echo "Run with --help for usage."
  exit 1
fi

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "ERROR: Template directory not found: $TEMPLATE_DIR"
  echo "Install claude-ops/claude-ops or check CLAUDE_OPS_DIR."
  exit 1
fi

# ── Resolve project root ─────────────────────────────────────────
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
WORKER_DIR="$PROJECT_ROOT/.claude/workers/$WORKER_NAME"

if [ -d "$WORKER_DIR" ]; then
  echo "WARNING: Worker directory already exists: $WORKER_DIR"
  read -rp "Overwrite? (y/n): " CONFIRM
  [ "$CONFIRM" != "y" ] && { echo "Aborted."; exit 1; }
fi

mkdir -p "$WORKER_DIR"

# ── Template replacement function ─────────────────────────────────
replace_placeholders() {
  local input="$1"
  local output="$2"

  sed \
    -e "s|{{PROD_HOST}}|${PROD_HOST}|g" \
    -e "s|{{PROD_SSH_PASS}}|${PROD_SSH_PASS}|g" \
    -e "s|{{DB_PATH}}|${DB_PATH}|g" \
    -e "s|{{DOMAIN}}|${DOMAIN}|g" \
    -e "s|{{PROJECTS}}|${PROJECTS}|g" \
    "$input" > "$output"
}

# ── Generate files ────────────────────────────────────────────────
echo "Scaffolding conv-monitor worker: $WORKER_NAME"
echo "  Template: $TEMPLATE_DIR"
echo "  Output:   $WORKER_DIR"
echo ""

# mission.md (from template)
replace_placeholders "$TEMPLATE_DIR/mission-template.md" "$WORKER_DIR/mission.md"
echo "  Created: mission.md"

# permissions.json (copy as-is — no placeholders)
cp "$TEMPLATE_DIR/permissions.json" "$WORKER_DIR/permissions.json"
echo "  Created: permissions.json"

# state.json (copy as-is — no placeholders)
cp "$TEMPLATE_DIR/state.json" "$WORKER_DIR/state.json"
echo "  Created: state.json"

# MEMORY.md (from template)
replace_placeholders "$TEMPLATE_DIR/MEMORY.md" "$WORKER_DIR/MEMORY.md"
echo "  Created: MEMORY.md"

# ── Symlink shared scripts if not already present ─────────────────
SCRIPTS_DIR="$PROJECT_ROOT/.claude/scripts"
mkdir -p "$SCRIPTS_DIR"

OPS_SCRIPTS_DIR="${CLAUDE_OPS_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-ops}}/scripts"
if [ ! -d "$OPS_SCRIPTS_DIR" ] && [ -d "$HOME/.claude-ops/scripts" ]; then
  OPS_SCRIPTS_DIR="$HOME/.claude-ops/scripts"
fi

for script in worker-bus-emit.sh worker-outbox-sync.sh worker-inbox.sh; do
  if [ -f "$OPS_SCRIPTS_DIR/$script" ] && [ ! -f "$SCRIPTS_DIR/$script" ]; then
    ln -s "$OPS_SCRIPTS_DIR/$script" "$SCRIPTS_DIR/$script"
    echo "  Symlinked: .claude/scripts/$script"
  fi
done

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "Conv-monitor worker scaffolded successfully!"
echo ""
echo "To launch:"
echo "  bash ~/.claude-ops/scripts/launch-flat-worker.sh $WORKER_NAME"
echo ""
echo "To customize:"
echo "  - Edit $WORKER_DIR/mission.md to add project-specific queries"
echo "  - Adjust thresholds (e.g., message counts, response times)"
echo "  - Add custom anomaly categories for your domain"
echo ""
echo "The worker will:"
echo "  1. SSH to $PROD_HOST every 30 minutes"
echo "  2. Run 6 categories of anomaly detection queries"
echo "  3. Report findings in MEMORY.md and via bus events"
echo "  4. Never modify production data (read-only permissions enforced)"
