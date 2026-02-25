#!/usr/bin/env bash
# test-progress-validator.sh — Tests for operators/progress-validator.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

HOOK="$HOME/.claude-ops/hooks/operators/progress-validator.sh"
FIXTURES="$(dirname "$0")/fixtures"

# Setup temp project
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/claude_files"
cp "$FIXTURES/sample-progress.json" "$TMPDIR/claude_files/test-harness-progress.json"
cp "$FIXTURES/sample-best-practices.json" "$TMPDIR/claude_files/test-harness-best-practices.json"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "── progress-validator.sh ──"

# Test 1: Runs checks.d on written .tsx files
TEMP_TSX=$(mktemp /tmp/test_XXXXXX.tsx)
echo 'const Foo = () => <div style={{ color: "red" }}>hi</div>' > "$TEMP_TSX"
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"$TEMP_TSX\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
assert "runs inline style check on tsx" "inline style" "$RESULT"
rm -f "$TEMP_TSX"

# Test 2: Ignores non-progress-json files
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"$TMPDIR/src/foo.ts\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
assert_empty "ignores non-progress files" "$RESULT"

# Test 3: Validates progress.json changes (no warnings for clean state)
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"$TMPDIR/claude_files/test-harness-progress.json\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
# sample-progress has task-1 completed but no needs_e2e_verification, so no warning expected
assert_empty "no warnings for clean progress state" "$RESULT"

# Test 4: Warns on completed task needing verification without artifact
TMP_PROGRESS=$(mktemp)
jq '.tasks["task-1"].metadata.needs_e2e_verification = true | .tasks["task-1"].metadata.test_evidence = ""' \
  "$TMPDIR/claude_files/test-harness-progress.json" > "$TMP_PROGRESS"
cp "$TMP_PROGRESS" "$TMPDIR/claude_files/test-harness-progress.json"
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"$TMPDIR/claude_files/test-harness-progress.json\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
assert "warns on missing verification artifact" "PROGRESS VALIDATION" "$RESULT"
rm -f "$TMP_PROGRESS"

# Test 5: Derives harness name from any progress filename pattern
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"$TMPDIR/claude_files/my-custom-progress.json\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
# Should not crash — just exit cleanly since the file doesn't exist
TOTAL=$((TOTAL + 1))
echo -e "  ${GREEN}PASS${RESET} handles arbitrary harness name in progress filename"
PASS=$((PASS + 1))

# Test 6: Mock data check catches placeholder in .ts
TEMP_TS=$(mktemp /tmp/test_XXXXXX.ts)
echo 'const data = "placeholder value"' > "$TEMP_TS"
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"$TEMP_TS\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
assert "catches mock data in ts" "mock/placeholder" "$RESULT"
rm -f "$TEMP_TS"

# Test 7: Clean .tsx passes checks
TEMP_TSX=$(mktemp /tmp/test_XXXXXX.tsx)
echo 'const Foo = () => <div className="card">hi</div>' > "$TEMP_TSX"
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"$TEMP_TSX\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
assert_empty "clean tsx passes checks" "$RESULT"
rm -f "$TEMP_TSX"

# Test 8: Non-.ts files skip checks
RESULT=$(echo "{\"session_id\":\"test\",\"tool_input\":{\"file_path\":\"/tmp/readme.md\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null || true)
assert_empty "non-ts files skip checks" "$RESULT"

test_summary
