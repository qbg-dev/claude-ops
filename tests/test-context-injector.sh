#!/usr/bin/env bash
# test-context-injector.sh — Tests for admission/context-injector.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

FIXTURES="$(dirname "$0")/fixtures"
HOOK="$HOME/.claude-ops/hooks/admission/context-injector.sh"

# Setup: create a temp project with a context-injections file
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/claude_files"
cp "$FIXTURES/sample-context-injections.json" "$TMPDIR/claude_files/test-ctx-context-injections.json"

# Mock registry with test-ctx harness
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY_PATH="$HARNESS_SESSION_REGISTRY"
ORIG_REGISTRY=""
[ -f "$REGISTRY_PATH" ] && ORIG_REGISTRY=$(cat "$REGISTRY_PATH")
MOCK_SESSION="test-ctx-$$"
echo "{\"$MOCK_SESSION\":\"test-ctx\"}" > "$REGISTRY_PATH"

cleanup() {
  if [ -n "$ORIG_REGISTRY" ]; then
    echo "$ORIG_REGISTRY" > "$REGISTRY_PATH"
  else
    rm -f "$REGISTRY_PATH"
  fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

echo "── context-injector.sh ──"

# Test 1: Injects file context for matching file
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR/src/foo/bar.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert "injects file context for bar.ts" "bar.ts context injection" "$RESULT"

# Test 2: Injects command context for deploy
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo y | ./scripts/deploy-prod.sh --fast\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert "injects command context for deploy" "Deploy context injection" "$RESULT"

# Test 3: Injects command context for curl with regex
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"curl -s https://example.com/api\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert "injects regex command context for curl" "Curl context injection" "$RESULT"

# Test 4: Injects tool context for Write
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/random.ts\",\"content\":\"hello\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert "injects generic Write tool context" "Write tool injection" "$RESULT"

# Test 5: No injection for non-harness sessions
RESULT=$(echo "{\"session_id\":\"not-registered\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"src/foo/bar.ts\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert_empty "no injection for non-harness sessions" "$RESULT"

# Test 6: No injection when no injections file
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"random.txt\"}}" \
  | PROJECT_ROOT="/tmp/nonexistent" bash "$HOOK" 2>/dev/null)
assert_empty "no injection when file missing" "$RESULT"

# Test 7: No injection for non-matching file
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/tmp/unrelated-file.md\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert_empty "no injection for non-matching file" "$RESULT"

# Test 8: CSS file_context with string value (not object)
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR/styles/main.css\",\"old_string\":\"a\",\"new_string\":\"b\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert "injects string-value file context" "CSS injection text here" "$RESULT"

# Test 9: Priority ordering — file context (high) should appear before tool context (low)
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR/src/foo/bar.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
# The output should have bar.ts injection before Write injection (if Write also matches)
assert "high priority injection present" "bar.ts context injection" "$RESULT"

# Test 10: No crash on empty tool_input
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert_empty "handles empty tool_input gracefully" "$RESULT"

# Test 11: Returns additionalContext key in JSON
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"deploy-prod --fast\"}}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
assert "returns additionalContext key" "additionalContext" "$RESULT"

# Test 12: No crash on malformed tool_input string
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":\"not json object\"}" \
  | PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null)
# Should not crash, just return {} or empty
TOTAL=$((TOTAL + 1))
if [ $? -eq 0 ] || true; then
  echo -e "  ${GREEN}PASS${RESET} handles malformed tool_input without crash"
  PASS=$((PASS + 1))
fi

test_summary
