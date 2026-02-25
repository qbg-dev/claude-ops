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

# Export SESSION_ID so checks.d scripts can resolve harness name
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
export SESSION_ID

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

# Resolve rules file (policy.json → best-practices.json, new → legacy)
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true
BP_FILE=$(harness_rules_file "$HARNESS_NAME" "$PROJECT_ROOT" 2>/dev/null || echo "")
RULES_PREFIX=$([ -n "$BP_FILE" ] && harness_rules_jq_prefix "$BP_FILE" 2>/dev/null || echo "")

# Check for completed tasks without artifacts + substep completeness + wave report validation
python3 -c "
import json, os, glob

progress_path = '$PROGRESS'
bp_path = '$BP_FILE'
harness_name = '$HARNESS_NAME'
project_root = '$PROJECT_ROOT'
rules_prefix = '$RULES_PREFIX'

with open(progress_path) as f:
    data = json.load(f)

bp_dir = f'claude_files/{harness_name}-verify'
try:
    with open(bp_path) as f:
        bp = json.load(f)
    rules = bp.get('rules', bp) if rules_prefix == '.rules' else bp
    bp_dir = rules.get('verification', {}).get('artifact_dir', bp_dir)
except: pass

warnings = []

for tid, task in data.get('tasks', {}).items():
    if task.get('status') == 'completed':
        meta = task.get('metadata', {})
        # Check verification artifacts
        if meta.get('needs_e2e_verification') and not meta.get('test_evidence'):
            artifact = os.path.join(project_root, bp_dir, f'{tid}.md')
            if not os.path.exists(artifact):
                warnings.append(f'  {tid}: completed but no artifact at {bp_dir}/{tid}.md')

        # Check substep completeness (Part 2.1)
        steps = task.get('steps', [])
        completed_steps = task.get('completed_steps', [])
        if steps and len(completed_steps) < len(steps):
            missing = [s for s in steps if s not in completed_steps]
            warnings.append(
                f'  {tid}: {len(completed_steps)}/{len(steps)} steps completed. '
                f'Missing: {missing}'
            )

# Check wave report validation (Part 1.5)
waves = data.get('waves', [])
hname = data.get('harness', harness_name)
report_dir = os.path.expanduser(f'~/.claude-ops/harness/reports/{hname}')
for wave in waves:
    if wave.get('status') == 'completed':
        wave_id = wave.get('id', '?')
        report_path = os.path.join(report_dir, f'wave-{wave_id}.html')
        if not os.path.exists(report_path):
            warnings.append(
                f'  wave-{wave_id}: marked completed but no report at {report_path}'
            )
        else:
            with open(report_path) as rf:
                content = rf.read().lower()
            if 'mission alignment' not in content and 'mission-alignment' not in content:
                warnings.append(
                    f'  wave-{wave_id}: report exists but missing Mission Alignment section'
                )
            if 'gap analysis' not in content and 'gap-analysis' not in content:
                warnings.append(
                    f'  wave-{wave_id}: report exists but missing Gap Analysis section'
                )

if warnings:
    print('PROGRESS VALIDATION:')
    print('\n'.join(warnings))
" 2>/dev/null || true

exit 0
