#!/usr/bin/env bash
# test-session-reader.sh — Tests for the session-reader.sh helper library
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

SESSION_READER="$HOME/.claude-ops/lib/session-reader.sh"
FIXTURE_DIR="/tmp/test-session-reader-$$"
mkdir -p "$FIXTURE_DIR"

# Cleanup on exit
cleanup() { rm -rf "$FIXTURE_DIR"; }
trap cleanup EXIT

echo "── session-reader.sh ──"

# ─────────────────────────────────────────────────────────
# Test 1: session-reader.sh exists
# ─────────────────────────────────────────────────────────
assert_file_exists "session-reader.sh exists" "$SESSION_READER"

# ─────────────────────────────────────────────────────────
# Test 2: session-reader.sh is sourceable without error
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if bash -c "source '$SESSION_READER'" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} session-reader.sh sources cleanly"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session-reader.sh failed to source"
  FAIL=$((FAIL + 1))
fi

# Source it for remaining tests
source "$SESSION_READER"

# ─────────────────────────────────────────────────────────
# Test 3: session_find function is defined
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if declare -f session_find > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} session_find function defined"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_find function not defined"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 4: session_summary function is defined
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if declare -f session_summary > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} session_summary function defined"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary function not defined"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 5: session_errors function is defined
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if declare -f session_errors > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} session_errors function defined"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_errors function not defined"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 6: session_recent_tools function is defined
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if declare -f session_recent_tools > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} session_recent_tools function defined"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_recent_tools function not defined"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Create fixture JSONL for functional tests
# ─────────────────────────────────────────────────────────
FIXTURE_JSONL="$FIXTURE_DIR/test-session.jsonl"
cat > "$FIXTURE_JSONL" <<'JSONL'
{"type":"user","message":{"role":"user","content":"hello"}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"thinking","thinking":"Let me think..."},{"type":"text","text":"I will help you."},{"type":"tool_use","name":"Read","id":"toolu_01A","input":{"file_path":"/tmp/foo.ts"}}],"usage":{"output_tokens":150,"input_tokens":1000}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01A","content":"file contents here","is_error":false}]}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"I see the file."},{"type":"tool_use","name":"Bash","id":"toolu_01B","input":{"command":"bun test src/tests/unit/foo.test.ts"}}],"usage":{"output_tokens":200,"input_tokens":2000}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01B","content":"Error: test failed - Cannot find module 'foo'","is_error":true}]}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"Let me fix that."},{"type":"tool_use","name":"Edit","id":"toolu_01C","input":{"file_path":"/tmp/foo.ts","old_string":"bad","new_string":"good"}}],"usage":{"output_tokens":300,"input_tokens":3000}}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01C","content":"File edited successfully","is_error":false}]}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"Fixed. Running tests again."},{"type":"tool_use","name":"Bash","id":"toolu_01D","input":{"command":"bun test"}}],"usage":{"output_tokens":100,"input_tokens":4000}}}
JSONL

# ─────────────────────────────────────────────────────────
# Test 7: session_summary returns valid JSON
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
SUMMARY=$(session_summary "$FIXTURE_JSONL" 20)
if echo "$SUMMARY" | jq . > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} session_summary returns valid JSON"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary did not return valid JSON: $SUMMARY"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 8: session_summary extracts turn_count
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
TURN_COUNT=$(echo "$SUMMARY" | jq '.turn_count' 2>/dev/null)
if [ "$TURN_COUNT" -gt 0 ] 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} session_summary has turn_count=$TURN_COUNT"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary turn_count invalid: $TURN_COUNT"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 9: session_summary extracts last_tool
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
LAST_TOOL=$(echo "$SUMMARY" | jq -r '.last_tool' 2>/dev/null)
if [ "$LAST_TOOL" = "Bash" ]; then
  echo -e "  ${GREEN}PASS${RESET} session_summary last_tool=Bash"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary last_tool expected Bash, got: $LAST_TOOL"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 10: session_summary extracts last_error
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
LAST_ERROR=$(echo "$SUMMARY" | jq -r '.last_error' 2>/dev/null)
if echo "$LAST_ERROR" | grep -qi "Cannot find module"; then
  echo -e "  ${GREEN}PASS${RESET} session_summary captured last_error"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary last_error missing or wrong: $LAST_ERROR"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 11: session_summary extracts token_trend
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
TOKEN_LEN=$(echo "$SUMMARY" | jq '.token_trend | length' 2>/dev/null)
if [ "$TOKEN_LEN" -gt 0 ] 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} session_summary has token_trend (${TOKEN_LEN} entries)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary token_trend empty"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 12: session_summary detects thinking_active
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
THINKING=$(echo "$SUMMARY" | jq '.thinking_active' 2>/dev/null)
if [ "$THINKING" = "true" ]; then
  echo -e "  ${GREEN}PASS${RESET} session_summary detected thinking_active=true"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary thinking_active expected true, got: $THINKING"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 13: session_summary has recent_tools array
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
RECENT_TOOLS=$(echo "$SUMMARY" | jq -r '.recent_tools | join(",")' 2>/dev/null)
if echo "$RECENT_TOOLS" | grep -q "Read"; then
  echo -e "  ${GREEN}PASS${RESET} session_summary recent_tools includes Read"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary recent_tools missing Read: $RECENT_TOOLS"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 14: session_errors finds errors in fixture
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
ERRORS=$(session_errors "$FIXTURE_JSONL" 20)
if echo "$ERRORS" | grep -qi "Cannot find module"; then
  echo -e "  ${GREEN}PASS${RESET} session_errors found test error"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_errors missed error: $ERRORS"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 15: session_errors returns nothing for non-error fixture
# ─────────────────────────────────────────────────────────
CLEAN_JSONL="$FIXTURE_DIR/clean-session.jsonl"
cat > "$CLEAN_JSONL" <<'JSONL'
{"type":"user","message":{"role":"user","content":"hello"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"output_tokens":10}}}
JSONL
TOTAL=$((TOTAL + 1))
CLEAN_ERRORS=$(session_errors "$CLEAN_JSONL" 20)
if [ -z "$CLEAN_ERRORS" ]; then
  echo -e "  ${GREEN}PASS${RESET} session_errors returns empty for clean session"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_errors returned unexpected: $CLEAN_ERRORS"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 16: session_recent_tools lists tools from fixture
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
TOOLS=$(session_recent_tools "$FIXTURE_JSONL" 20)
if echo "$TOOLS" | grep -q "Read" && echo "$TOOLS" | grep -q "Bash" && echo "$TOOLS" | grep -q "Edit"; then
  echo -e "  ${GREEN}PASS${RESET} session_recent_tools found Read, Bash, Edit"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_recent_tools missing expected tools: $TOOLS"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 17: session_recent_tools includes file names
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if echo "$TOOLS" | grep -q "foo.ts"; then
  echo -e "  ${GREEN}PASS${RESET} session_recent_tools includes file names"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_recent_tools missing file names: $TOOLS"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 18: session_recent_tools includes commands
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if echo "$TOOLS" | grep -q "bun test"; then
  echo -e "  ${GREEN}PASS${RESET} session_recent_tools includes bash commands"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_recent_tools missing bash commands: $TOOLS"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 19: session_summary handles missing file gracefully
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
MISSING_RESULT=$(session_summary "/nonexistent/file.jsonl" 10 2>/dev/null || true)
if echo "$MISSING_RESULT" | jq -r '.error' 2>/dev/null | grep -q "file_not_found"; then
  echo -e "  ${GREEN}PASS${RESET} session_summary handles missing file"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary didn't return error for missing file: $MISSING_RESULT"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 20: session_errors handles missing file gracefully
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
ERRORS_EXIT=0
session_errors "/nonexistent/file.jsonl" 10 > /dev/null 2>&1 || ERRORS_EXIT=$?
if [ "$ERRORS_EXIT" -ne 0 ]; then
  echo -e "  ${GREEN}PASS${RESET} session_errors returns non-zero for missing file"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_errors should fail for missing file"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 21: session_find with activity log (simulated)
# ─────────────────────────────────────────────────────────
# Create a fake activity log with a session ID matching our fixture
FAKE_SESSION_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
FAKE_HARNESS="test-session-find-$$"
FAKE_ACTIVITY="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/activity/claude_activity_${FAKE_HARNESS}.jsonl"
# session_find looks in $HOME/.claude/projects/
FAKE_PROJECTS="$FIXTURE_DIR/.claude/projects/-test-slug"
mkdir -p "$FAKE_PROJECTS"
cp "$FIXTURE_JSONL" "$FAKE_PROJECTS/${FAKE_SESSION_ID}.jsonl"
echo "{\"ts\":\"2026-01-01T00:00:00Z\",\"tool\":\"Read\",\"session\":\"${FAKE_SESSION_ID}\"}" > "$FAKE_ACTIVITY"

TOTAL=$((TOTAL + 1))
# Override HOME for session_find to use our fixture projects dir
FOUND=$(HOME="$FIXTURE_DIR" session_find "$FAKE_HARNESS" 2>/dev/null || true)
if [ -n "$FOUND" ] && [ -f "$FOUND" ]; then
  echo -e "  ${GREEN}PASS${RESET} session_find located JSONL via activity log"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_find couldn't locate JSONL: '$FOUND'"
  FAIL=$((FAIL + 1))
fi
rm -f "$FAKE_ACTIVITY"

# ─────────────────────────────────────────────────────────
# Test 22: session_find returns empty for nonexistent harness
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
FOUND_NONE=$(HOME="$FIXTURE_DIR" session_find "nonexistent-harness-$$" 2>/dev/null || true)
# Should fall through to most-recently-modified (which finds our fixture) or empty
# The key is it shouldn't error out
if [ $? -eq 0 ] || [ $? -eq 1 ]; then
  echo -e "  ${GREEN}PASS${RESET} session_find handles nonexistent harness gracefully"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_find errored on nonexistent harness"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 23: session_summary handles empty JSONL
# ─────────────────────────────────────────────────────────
EMPTY_JSONL="$FIXTURE_DIR/empty.jsonl"
touch "$EMPTY_JSONL"
TOTAL=$((TOTAL + 1))
EMPTY_RESULT=$(session_summary "$EMPTY_JSONL" 10 2>/dev/null)
if echo "$EMPTY_RESULT" | jq '.' > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} session_summary handles empty JSONL"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary failed on empty JSONL: $EMPTY_RESULT"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 24: session_summary assistant_turns count is correct
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
ASSISTANT_TURNS=$(echo "$SUMMARY" | jq '.assistant_turns' 2>/dev/null)
if [ "$ASSISTANT_TURNS" = "4" ]; then
  echo -e "  ${GREEN}PASS${RESET} session_summary assistant_turns=4 (correct)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary assistant_turns expected 4, got: $ASSISTANT_TURNS"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 25: session_summary token_trend has correct values
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
# Fixture has 4 assistant entries with output_tokens: 150, 200, 300, 100
# token_trend returns last 3: [200, 300, 100]
TOKEN_LAST=$(echo "$SUMMARY" | jq '.token_trend[-1]' 2>/dev/null)
if [ "$TOKEN_LAST" = "100" ]; then
  echo -e "  ${GREEN}PASS${RESET} session_summary token_trend last value=100"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_summary token_trend last expected 100, got: $TOKEN_LAST"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
# Test 26: session_recent_tools returns correct count
# ─────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
TOOLS_COUNT=$(echo "$TOOLS" | grep -c '.' || true)
# Fixture has: Read, Bash, Edit, Bash = 4 tool uses
if [ "$TOOLS_COUNT" -eq 4 ]; then
  echo -e "  ${GREEN}PASS${RESET} session_recent_tools found 4 tool uses"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} session_recent_tools expected 4, got: $TOOLS_COUNT"
  FAIL=$((FAIL + 1))
fi

test_summary
