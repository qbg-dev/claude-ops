#!/usr/bin/env bash
# test-hooks.sh — Integration tests for the hook system.
# Run: bash ~/.claude-ops/tests/test-hooks.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

PROJECT_ROOT="/Users/wz/Desktop/zPersonalProjects/Wechat"
cd "$PROJECT_ROOT"

# ── Setup: mock harness session (isolated — never touches real registry) ──
MOCK_SESSION="test-hooks-$$"
TEST_STATE_DIR=$(mktemp -d /tmp/test-hooks-state-XXXXXX)
export HARNESS_STATE_DIR="$TEST_STATE_DIR"
export HARNESS_SESSION_REGISTRY="$TEST_STATE_DIR/session-registry.json"
export HARNESS_LOCK_DIR="$TEST_STATE_DIR/locks"
mkdir -p "$HARNESS_LOCK_DIR"
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true
MOCK_REGISTRY="$HARNESS_SESSION_REGISTRY"

# Register a mock miniapp-chat session
echo "{\"$MOCK_SESSION\":\"miniapp-chat\"}" > "$MOCK_REGISTRY"

cleanup() {
  rm -rf "$TEST_STATE_DIR"
  rm -f /tmp/claude_activity_miniapp-chat.jsonl.test
  rm -f /tmp/deploy-mutations.log
  rm -f "$PROJECT_ROOT/claude_files/miniapp-chat-verify/_test-task.md"
}
trap cleanup EXIT

echo "── hooks integration ──"

# ═════════════════════════════════════════════════════════════════════
# deploy-mutator.sh
# ═════════════════════════════════════════════════════════════════════

# Test 1: Injects --fast into bare deploy-prod.sh
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo y | ./scripts/deploy-prod.sh\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/deploy-mutator.sh" 2>/dev/null)
assert "injects --fast into deploy-prod" "deploy-prod.sh --fast" "$RESULT"
assert "injects --skip-langfuse" "skip-langfuse" "$RESULT"

# Test 2: Doesn't double-inject if flags already present
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo y | ./scripts/deploy-prod.sh --fast --skip-langfuse\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/deploy-mutator.sh" 2>/dev/null)
assert_empty "no mutation when flags present" "$RESULT"

# Test 3: Blocks deploy to test server
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"./scripts/deploy.sh --skip-langfuse\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/deploy-mutator.sh" 2>/dev/null)
assert "blocks deploy to test" "block" "$RESULT"

# Test 4: Ignores non-deploy commands
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/deploy-mutator.sh" 2>/dev/null)
assert_empty "ignores non-deploy" "$RESULT"

# Test 5: Ignores non-harness sessions
RESULT=$(echo "{\"session_id\":\"unregistered-session\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"./scripts/deploy-prod.sh\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/deploy-mutator.sh" 2>/dev/null)
assert_empty "ignores non-harness session" "$RESULT"

# ═════════════════════════════════════════════════════════════════════
# task-readiness.sh
# ═════════════════════════════════════════════════════════════════════

# Test 6: Fails when no artifact exists
RESULT=$(PROJECT_ROOT="$PROJECT_ROOT" HARNESS="miniapp-chat" bash "$HOME/.claude-ops/hooks/admission/task-readiness.sh" "fix-send-button" 2>/dev/null || true)
assert "fails without artifact" "READINESS FAIL" "$RESULT"

# Test 7: Fails with empty artifact
mkdir -p claude_files/miniapp-chat-verify
echo "" > claude_files/miniapp-chat-verify/_test-task.md
RESULT=$(PROJECT_ROOT="$PROJECT_ROOT" HARNESS="miniapp-chat" bash "$HOME/.claude-ops/hooks/admission/task-readiness.sh" "_test-task" 2>/dev/null || true)
assert "fails with empty artifact" "READINESS FAIL" "$RESULT"

# Test 8: Fails with artifact missing Evidence section
cat > claude_files/miniapp-chat-verify/_test-task.md << 'EOF'
# _test-task — Verification
## Steps performed
1. Did something
## Result
PASS
EOF
RESULT=$(PROJECT_ROOT="$PROJECT_ROOT" HARNESS="miniapp-chat" bash "$HOME/.claude-ops/hooks/admission/task-readiness.sh" "_test-task" 2>/dev/null || true)
assert "fails without Evidence section" "READINESS FAIL" "$RESULT"

# Test 9: Fails with artifact that has FAIL result
cat > claude_files/miniapp-chat-verify/_test-task.md << 'EOF'
# _test-task — Verification
## Steps performed
1. Did something
## Evidence
Checked the endpoint and it returned 500 error consistently across three attempts.
## Result
FAIL — endpoint returns 500
EOF
RESULT=$(PROJECT_ROOT="$PROJECT_ROOT" HARNESS="miniapp-chat" bash "$HOME/.claude-ops/hooks/admission/task-readiness.sh" "_test-task" 2>/dev/null || true)
assert "fails when Result is FAIL" "READINESS FAIL" "$RESULT"

# Test 10: Passes with complete, passing artifact
cat > claude_files/miniapp-chat-verify/_test-task.md << 'EOF'
# _test-task — Verification
## Steps performed
1. Opened the page
2. Clicked the button
## Evidence
curl -s https://wx.baoyuansmartlife.com/api/v1/test returned {"status":"ok","data":[...]}
Response time: 245ms. Verified the response includes all expected fields.
## Result
PASS — endpoint returns expected data with correct structure
EOF
assert_exit "passes with complete artifact" 0 env PROJECT_ROOT="$PROJECT_ROOT" HARNESS="miniapp-chat" bash "$HOME/.claude-ops/hooks/admission/task-readiness.sh" "_test-task"

# ═════════════════════════════════════════════════════════════════════
# context-injector.sh
# ═════════════════════════════════════════════════════════════════════

# Test 11: Injects context when editing a known file
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PROJECT_ROOT/src/miniapp/styles/chat.css\",\"old_string\":\"a\",\"new_string\":\"b\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/context-injector.sh" 2>/dev/null)
assert "injects context for chat.css" "inline styles" "$RESULT"

# Test 12: Injects context for deploy commands
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo y | ./scripts/deploy-prod.sh --fast\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/context-injector.sh" 2>/dev/null)
assert "injects context for deploy" "static" "$RESULT"

# Test 13: Injects generic Write context
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/tmp/some-random-file.ts\",\"content\":\"hello\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/context-injector.sh" 2>/dev/null)
assert "injects generic Write context" "inline styles" "$RESULT"

# Test 14: No injection for non-harness sessions
RESULT=$(echo "{\"session_id\":\"not-registered\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PROJECT_ROOT/src/miniapp/styles/chat.css\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/context-injector.sh" 2>/dev/null)
assert_empty "no injection for non-harness" "$RESULT"

# ═════════════════════════════════════════════════════════════════════
# activity-logger.sh
# ═════════════════════════════════════════════════════════════════════

rm -f /tmp/claude_activity_miniapp-chat.jsonl

# Test 15: Logs a Bash command
echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
assert_file_contains "logs Bash events" "/tmp/claude_activity_miniapp-chat.jsonl" "\"tool\": \"Bash\""

# Test 16: Logs an Edit with file path
echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PROJECT_ROOT/src/foo.ts\",\"old_string\":\"a\",\"new_string\":\"bb\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
assert_file_contains "logs Edit with file" "/tmp/claude_activity_miniapp-chat.jsonl" "src/foo.ts"

# Test 17: Doesn't log non-harness sessions
LINES_BEFORE=$(wc -l < /tmp/claude_activity_miniapp-chat.jsonl 2>/dev/null || echo 0)
echo "{\"session_id\":\"unregistered\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo hi\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
LINES_AFTER=$(wc -l < /tmp/claude_activity_miniapp-chat.jsonl 2>/dev/null || echo 0)
TOTAL=$((TOTAL + 1))
if [ "$LINES_BEFORE" -eq "$LINES_AFTER" ]; then
  echo -e "  ${GREEN}PASS${RESET} skips non-harness sessions"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} skips non-harness sessions (logged when it shouldn't)"
  FAIL=$((FAIL + 1))
fi

# ═════════════════════════════════════════════════════════════════════
# checks.d/ modules
# ═════════════════════════════════════════════════════════════════════

# Test 18: Inline styles check catches style={{
TEMP_TSX=$(mktemp /tmp/test_XXXXXX.tsx)
echo 'const Foo = () => <div style={{ color: "red" }}>hi</div>' > "$TEMP_TSX"
RESULT=$(FILE_PATH="$TEMP_TSX" bash "$HOME/.claude-ops/hooks/operators/checks.d/01-no-inline-styles.sh" 2>/dev/null || true)
assert "catches inline styles" "inline style" "$RESULT"
rm -f "$TEMP_TSX"

# Test 19: Inline styles check ignores clean files
TEMP_TSX=$(mktemp /tmp/test_XXXXXX.tsx)
echo 'const Foo = () => <div className="card">hi</div>' > "$TEMP_TSX"
RESULT=$(FILE_PATH="$TEMP_TSX" bash "$HOME/.claude-ops/hooks/operators/checks.d/01-no-inline-styles.sh" 2>/dev/null || true)
assert_empty "ignores clean tsx" "$RESULT"
rm -f "$TEMP_TSX"

# Test 20: Mock data check catches placeholder
TEMP_TS=$(mktemp /tmp/test_XXXXXX.ts)
echo 'const data = "placeholder value"' > "$TEMP_TS"
RESULT=$(FILE_PATH="$TEMP_TS" bash "$HOME/.claude-ops/hooks/operators/checks.d/02-no-mock-data.sh" 2>/dev/null || true)
assert "catches mock data" "mock/placeholder" "$RESULT"
rm -f "$TEMP_TS"

# Test 21: Ignores non-ts files
RESULT=$(FILE_PATH="/tmp/readme.md" bash "$HOME/.claude-ops/hooks/operators/checks.d/01-no-inline-styles.sh" 2>/dev/null || true)
assert_empty "ignores non-tsx files" "$RESULT"

# ═════════════════════════════════════════════════════════════════════
# progress-validator.sh
# ═════════════════════════════════════════════════════════════════════

# Test 22: No warnings on clean progress state
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_input\":{\"file_path\":\"$PROJECT_ROOT/claude_files/miniapp-chat-progress.json\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/progress-validator.sh" 2>/dev/null || true)
assert_empty "no warnings when no tasks completed" "$RESULT"

# ═════════════════════════════════════════════════════════════════════
# rotation advisory
# ═════════════════════════════════════════════════════════════════════

# Test 23: Rotation advisory file format is valid JSON
echo '{"should_rotate":true,"reason":"test rotation","decided_at":"2026-02-23T12:00:00Z"}' \
  > /tmp/claude_rotation_advisory_miniapp-chat
TOTAL=$((TOTAL + 1))
if jq -e '.should_rotate' /tmp/claude_rotation_advisory_miniapp-chat > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} rotation advisory format is valid JSON"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} rotation advisory format invalid"
  FAIL=$((FAIL + 1))
fi
rm -f /tmp/claude_rotation_advisory_miniapp-chat

# ═════════════════════════════════════════════════════════════════════
# symlink verification (project hooks → ~/.claude-ops/hooks/)
# ═════════════════════════════════════════════════════════════════════

HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"

# Test 24: harness-dispatch.sh is symlinked
assert_symlink "harness-dispatch.sh symlink" \
  "$HOOKS_DIR/harness-dispatch.sh" \
  "$HOME/.claude-ops/hooks/harness-dispatch.sh"

# Test 25: stop-check.sh is symlinked
assert_symlink "stop-check.sh symlink" \
  "$HOOKS_DIR/stop-check.sh" \
  "$HOME/.claude-ops/hooks/stop-check.sh"

# Test 26: context-injector.sh is symlinked
assert_symlink "context-injector.sh symlink" \
  "$HOOKS_DIR/admission/context-injector.sh" \
  "$HOME/.claude-ops/hooks/admission/context-injector.sh"

# Test 27: deploy-mutator.sh is symlinked
assert_symlink "deploy-mutator.sh symlink" \
  "$HOOKS_DIR/admission/deploy-mutator.sh" \
  "$HOME/.claude-ops/hooks/admission/deploy-mutator.sh"

# Test 28: progress-validator.sh is symlinked
assert_symlink "progress-validator.sh symlink" \
  "$HOOKS_DIR/operators/progress-validator.sh" \
  "$HOME/.claude-ops/hooks/operators/progress-validator.sh"

# ═════════════════════════════════════════════════════════════════════
# multi-harness support
# ═════════════════════════════════════════════════════════════════════

# Test 29: deploy-mutator works with a different harness
MOCK_SESSION_BI="test-hooks-bi-$$"
locked_jq_write "$MOCK_REGISTRY" "session-registry" '. + {($s): "bi-opt"}' --arg s "$MOCK_SESSION_BI"
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_BI\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo y | ./scripts/deploy-prod.sh\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/deploy-mutator.sh" 2>/dev/null)
assert "deploy-mutator works for bi-opt harness" "deploy-prod.sh --fast" "$RESULT"

# Test 30: activity-logger works with bi-opt
rm -f /tmp/claude_activity_bi-opt.jsonl
echo "{\"session_id\":\"$MOCK_SESSION_BI\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"bun test\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
assert_file_contains "activity logger logs for bi-opt" "/tmp/claude_activity_bi-opt.jsonl" "\"tool\": \"Bash\""
rm -f /tmp/claude_activity_bi-opt.jsonl

# ═════════════════════════════════════════════════════════════════════
# Cleanup
# ═════════════════════════════════════════════════════════════════════
rm -f claude_files/miniapp-chat-verify/_test-task.md
rm -f /tmp/claude_activity_miniapp-chat.jsonl

test_summary
