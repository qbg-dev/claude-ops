#!/usr/bin/env bash
# progress-validator.sh — PostToolUse operator for Write|Edit.
#
# Two jobs:
# 1. Run checks.d/ modules on the written file (modular, monitor can add/remove)
# 2. Validate progress.json changes (no completed tasks without artifacts)
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CHECKS_DIR="${CHECKS_DIR:-$HOME/.claude-ops/hooks/operators/checks.d}"

INPUT=$(cat)

# Extract file path
FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
ti = data.get('tool_input', {})
if isinstance(ti, str):
    ti = json.loads(ti)
print(ti.get('file_path', ''))
" 2>/dev/null || echo "")

# ── Run checks.d/ modules on any written file ────────────────────────
if [ -n "$FILE_PATH" ] && [ -d "$CHECKS_DIR" ]; then
  export FILE_PATH
  for check in "$CHECKS_DIR"/*.sh; do
    [ -f "$check" ] || continue
    bash "$check" 2>/dev/null || true
  done
fi

# ── Validate progress.json changes ───────────────────────────────────
# Match any harness progress file pattern
case "$FILE_PATH" in
  *-progress.json) ;;
  *) exit 0 ;;
esac

# Derive harness name from the progress file
HARNESS_NAME=$(basename "$FILE_PATH" | sed 's/-progress\.json$//')
PROGRESS="$FILE_PATH"
[ ! -f "$PROGRESS" ] && exit 0

# Load best practices from the harness-specific file
BP_FILE="$PROJECT_ROOT/claude_files/${HARNESS_NAME}-best-practices.json"

# Check for completed tasks without artifacts
python3 -c "
import json, os

progress_path = '$PROGRESS'
bp_path = '$BP_FILE'
harness_name = '$HARNESS_NAME'
project_root = '$PROJECT_ROOT'

with open(progress_path) as f:
    data = json.load(f)

bp_dir = f'claude_files/{harness_name}-verify'
try:
    with open(bp_path) as f:
        bp = json.load(f)
    bp_dir = bp.get('verification', {}).get('artifact_dir', bp_dir)
except: pass

warnings = []
for tid, task in data.get('tasks', {}).items():
    if task.get('status') == 'completed':
        meta = task.get('metadata', {})
        if meta.get('needs_e2e_verification') and not meta.get('test_evidence'):
            artifact = os.path.join(project_root, bp_dir, f'{tid}.md')
            if not os.path.exists(artifact):
                warnings.append(f'  {tid}: completed but no artifact at {bp_dir}/{tid}.md')
if warnings:
    print('VERIFICATION GAP:')
    print('\n'.join(warnings))
    print('Write artifact FIRST, then set test_evidence, then mark completed.')
" 2>/dev/null || true

exit 0
