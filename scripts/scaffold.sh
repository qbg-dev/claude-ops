#!/usr/bin/env bash
# scaffold.sh — Create a new harness from templates.
# Usage: bash ~/.claude-ops/scripts/scaffold.sh <harness-name> [project-root]
#
# Creates all harness files (progress, harness MD, start/seed/continue scripts,
# best-practices, context-injections, manifest) with {{HARNESS}} and {{PROJECT_ROOT}} replaced.
set -euo pipefail

HARNESS="${1:-}"
PROJECT_ROOT="${2:-$(pwd)}"

if [ -z "$HARNESS" ]; then
  echo "Usage: bash ~/.claude-ops/scripts/scaffold.sh <harness-name> [project-root]"
  echo ""
  echo "Creates:"
  echo "  claude_files/\${HARNESS}-progress.json"
  echo "  claude_files/\${HARNESS}-harness.md"
  echo "  claude_files/\${HARNESS}-goal.md"
  echo "  claude_files/\${HARNESS}-best-practices.json"
  echo "  claude_files/\${HARNESS}-context-injections.json"
  echo "  .claude/scripts/\${HARNESS}-start.sh"
  echo "  .claude/scripts/\${HARNESS}-seed.sh"
  echo "  .claude/scripts/\${HARNESS}-continue.sh"
  echo "  ~/.claude-ops/harness/manifests/\${HARNESS}/manifest.json"
  exit 1
fi

TEMPLATE_DIR="$HOME/.claude-ops/templates"

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "ERROR: ~/.claude-ops/templates not found" >&2
  exit 1
fi

mkdir -p "$PROJECT_ROOT/claude_files" "$PROJECT_ROOT/.claude/scripts"

replace() {
  sed "s|{{HARNESS}}|$HARNESS|g; s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" "$1"
}

# Generate files from templates
replace "$TEMPLATE_DIR/progress.json.tmpl" > "$PROJECT_ROOT/claude_files/${HARNESS}-progress.json"
replace "$TEMPLATE_DIR/harness.md.tmpl"    > "$PROJECT_ROOT/claude_files/${HARNESS}-harness.md"
replace "$TEMPLATE_DIR/goal.md.tmpl"       > "$PROJECT_ROOT/claude_files/${HARNESS}-goal.md"
replace "$TEMPLATE_DIR/best-practices.json.tmpl" > "$PROJECT_ROOT/claude_files/${HARNESS}-best-practices.json"
replace "$TEMPLATE_DIR/start.sh.tmpl"      > "$PROJECT_ROOT/.claude/scripts/${HARNESS}-start.sh"
replace "$TEMPLATE_DIR/seed.sh.tmpl"       > "$PROJECT_ROOT/.claude/scripts/${HARNESS}-seed.sh"
replace "$TEMPLATE_DIR/continue.sh.tmpl"   > "$PROJECT_ROOT/.claude/scripts/${HARNESS}-continue.sh"

chmod +x "$PROJECT_ROOT/.claude/scripts/${HARNESS}-start.sh"
chmod +x "$PROJECT_ROOT/.claude/scripts/${HARNESS}-seed.sh"
chmod +x "$PROJECT_ROOT/.claude/scripts/${HARNESS}-continue.sh"

# Create context-injections starter (not from template — always empty sections)
cat > "$PROJECT_ROOT/claude_files/${HARNESS}-context-injections.json" <<EOF
{
  "_meta": {
    "version": 1,
    "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "updated_by": "scaffold",
    "purpose": "Context injected into worker agent via PreToolUse hooks. Monitor evolves this file.",
    "changelog": ["v1: Initial empty knowledge base"]
  },
  "file_context": {},
  "command_context": {},
  "tool_context": {}
}
EOF

# Create manifest
mkdir -p "$HOME/.claude-ops/harness/manifests/$HARNESS"
cat > "$HOME/.claude-ops/harness/manifests/$HARNESS/manifest.json" <<EOF
{
  "harness": "$HARNESS",
  "project_root": "$PROJECT_ROOT",
  "status": "active",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "files": {
    "progress": "claude_files/${HARNESS}-progress.json",
    "harness_md": "claude_files/${HARNESS}-harness.md",
    "best_practices": "claude_files/${HARNESS}-best-practices.json",
    "context_injections": "claude_files/${HARNESS}-context-injections.json"
  }
}
EOF

echo "Scaffolded harness: $HARNESS"
echo ""
echo "Files created:"
echo "  claude_files/${HARNESS}-progress.json   <- Add your tasks here"
echo "  claude_files/${HARNESS}-harness.md      <- Write mission + key files"
echo "  claude_files/${HARNESS}-goal.md         <- Set north star metric"
echo "  claude_files/${HARNESS}-best-practices.json"
echo "  claude_files/${HARNESS}-context-injections.json"
echo "  .claude/scripts/${HARNESS}-start.sh"
echo "  .claude/scripts/${HARNESS}-seed.sh"
echo "  .claude/scripts/${HARNESS}-continue.sh"
echo "  ~/.claude-ops/harness/manifests/${HARNESS}/manifest.json"
echo ""
echo "Next steps:"
echo "  1. Edit claude_files/${HARNESS}-progress.json — add real tasks"
echo "  2. Edit claude_files/${HARNESS}-harness.md — write mission + instructions"
echo "  3. Launch:  bash .claude/scripts/${HARNESS}-start.sh"
echo "     w/ mon:  bash .claude/scripts/${HARNESS}-start.sh --monitor"
echo "     status:  bash .claude/scripts/${HARNESS}-start.sh --status"
