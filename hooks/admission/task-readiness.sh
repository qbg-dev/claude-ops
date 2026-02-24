#!/usr/bin/env bash
# task-readiness.sh — Verification gate for task completion.
#
# K8s analogy: ReadinessProbe / ValidatingAdmissionWebhook
# Called by harness-dispatch.sh when it detects a task was marked "completed".
# Reads best-practices.json for verification requirements.
#
# Environment variables (set by caller):
#   PROJECT_ROOT — project root directory
#   HARNESS      — harness name (e.g. "miniapp-chat", "eval-external")
#
# Exit codes:
#   0 — task passes readiness (artifact exists with evidence)
#   1 — task fails readiness (outputs warning message to stdout)
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS="${HARNESS:-miniapp-chat}"

BP_FILE="$PROJECT_ROOT/claude_files/${HARNESS}-best-practices.json"
PROGRESS_FILE="$PROJECT_ROOT/claude_files/${HARNESS}-progress.json"

TASK_ID="${1:-}"
if [ -z "$TASK_ID" ]; then
  # Auto-detect: find tasks marked completed without test_evidence
  [ ! -f "$PROGRESS_FILE" ] && exit 0
  TASK_ID=$(python3 -c "
import json
with open('$PROGRESS_FILE') as f:
    data = json.load(f)
for tid, task in data.get('tasks', {}).items():
    if task.get('status') == 'completed':
        meta = task.get('metadata', {})
        if meta.get('needs_e2e_verification') and not meta.get('test_evidence'):
            print(tid)
            break
" 2>/dev/null || echo "")
fi

[ -z "$TASK_ID" ] && exit 0  # No unverified completed tasks

# Load verification config from best practices
ARTIFACT_DIR="claude_files/${HARNESS}-verify"
REQUIRED_SECTIONS=("Evidence" "Result")
MIN_CHARS=50

if [ -f "$BP_FILE" ]; then
  ARTIFACT_DIR=$(jq -r ".verification.artifact_dir // \"claude_files/${HARNESS}-verify\"" "$BP_FILE" 2>/dev/null)
  MIN_CHARS=$(jq -r '.verification.min_evidence_chars // 50' "$BP_FILE" 2>/dev/null)
fi

ARTIFACT="$PROJECT_ROOT/$ARTIFACT_DIR/${TASK_ID}.md"

# Check 1: Artifact file exists
if [ ! -f "$ARTIFACT" ]; then
  echo "READINESS FAIL [$TASK_ID]: No verification artifact at $ARTIFACT_DIR/${TASK_ID}.md"
  echo "Write the artifact with Steps performed, Evidence, and Result sections BEFORE marking complete."
  exit 1
fi

# Check 2: Required sections present
for section in "${REQUIRED_SECTIONS[@]}"; do
  if ! grep -q "^## ${section}" "$ARTIFACT" 2>/dev/null; then
    echo "READINESS FAIL [$TASK_ID]: Artifact missing '## ${section}' section."
    exit 1
  fi
done

# Check 3: Evidence section has substance (not empty or template-only)
EVIDENCE_CONTENT=$(sed -n '/^## Evidence/,/^## /p' "$ARTIFACT" | grep -v '^##' | tr -d '[:space:]')
EVIDENCE_LEN=${#EVIDENCE_CONTENT}

if [ "$EVIDENCE_LEN" -lt "$MIN_CHARS" ]; then
  echo "READINESS FAIL [$TASK_ID]: Evidence section too short (${EVIDENCE_LEN} chars, need ${MIN_CHARS}+). Add concrete proof."
  exit 1
fi

# Check 4: Result is PASS (not FAIL or missing)
RESULT_LINE=$(grep -A1 "^## Result" "$ARTIFACT" | tail -1)
if echo "$RESULT_LINE" | grep -qi "FAIL"; then
  echo "READINESS FAIL [$TASK_ID]: Result says FAIL. Fix the issue before marking complete."
  exit 1
fi

# All checks passed
exit 0
