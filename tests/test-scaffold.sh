#!/usr/bin/env bash
# test-scaffold.sh — Tests for scripts/scaffold.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

SCAFFOLD="$HOME/.claude-ops/scripts/scaffold.sh"
HARNESS_NAME="test-scaffold-$$"

# Setup temp project
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR"

cleanup() {
  rm -rf "$TMPDIR"
  rm -rf "$HOME/.claude-ops/harnesses/$HARNESS_NAME"
}
trap cleanup EXIT

echo "── scaffold.sh ──"

# Test 1: Scaffold creates progress.json
bash "$SCAFFOLD" "$HARNESS_NAME" "$TMPDIR"
assert_file_exists "creates progress.json" "$TMPDIR/claude_files/${HARNESS_NAME}-progress.json"

# Test 2: Creates harness.md
assert_file_exists "creates harness.md" "$TMPDIR/claude_files/${HARNESS_NAME}-harness.md"

# Test 3: Creates goal.md
assert_file_exists "creates goal.md" "$TMPDIR/claude_files/${HARNESS_NAME}-goal.md"

# Test 4: Creates best-practices.json
assert_file_exists "creates best-practices.json" "$TMPDIR/claude_files/${HARNESS_NAME}-best-practices.json"

# Test 5: Creates context-injections.json
assert_file_exists "creates context-injections.json" "$TMPDIR/claude_files/${HARNESS_NAME}-context-injections.json"

# Test 6: Creates start.sh (executable)
assert_file_exists "creates start.sh" "$TMPDIR/.claude/scripts/${HARNESS_NAME}-start.sh"
TOTAL=$((TOTAL + 1))
if [ -x "$TMPDIR/.claude/scripts/${HARNESS_NAME}-start.sh" ]; then
  echo -e "  ${GREEN}PASS${RESET} start.sh is executable"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} start.sh is not executable"
  FAIL=$((FAIL + 1))
fi

# Test 7: Creates manifest
assert_file_exists "creates manifest" "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json"

# Test 8: Manifest has correct harness name
MANIFEST_NAME=$(jq -r '.harness' "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json")
assert_equals "manifest has correct harness name" "$HARNESS_NAME" "$MANIFEST_NAME"

# Test 9: Manifest has correct project root
MANIFEST_ROOT=$(jq -r '.project_root' "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json")
assert_equals "manifest has correct project root" "$TMPDIR" "$MANIFEST_ROOT"

# Test 10: Templates properly substituted (no {{HARNESS}} left)
TOTAL=$((TOTAL + 1))
if grep -rq '{{HARNESS}}' "$TMPDIR/claude_files/${HARNESS_NAME}-"* 2>/dev/null; then
  echo -e "  ${RED}FAIL${RESET} templates not fully substituted"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} templates fully substituted"
  PASS=$((PASS + 1))
fi

# Test 11: Context-injections has proper structure
TOTAL=$((TOTAL + 1))
if jq -e '.file_context and .command_context and .tool_context' "$TMPDIR/claude_files/${HARNESS_NAME}-context-injections.json" > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} context-injections has proper structure"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} context-injections missing sections"
  FAIL=$((FAIL + 1))
fi

# Test 12: Fails with no args
assert_exit "fails with no args" 1 bash "$SCAFFOLD"

test_summary
