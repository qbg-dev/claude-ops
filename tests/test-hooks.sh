#!/usr/bin/env bash
# test-hooks.sh — Integration tests for the hook system.
# Run: bash ~/.claude-ops/tests/test-hooks.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
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
  rm -f "${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/activity/claude_activity_miniapp-chat.jsonl.test"
  rm -f "${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/logs/deploy-mutations.log"
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
curl -s https://example.com/api/v1/test returned {"status":"ok","data":[...]}
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

ACTIVITY_DIR="${HARNESS_ACTIVITY_DIR:-$HOME/.claude-ops/state/activity}"
ACTIVITY_LOG_MC="$ACTIVITY_DIR/claude_activity_miniapp-chat.jsonl"
rm -f "$ACTIVITY_LOG_MC"

# Test 15: Logs a Bash command
echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -la\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
assert_file_contains "logs Bash events" "$ACTIVITY_LOG_MC" "\"tool\": \"Bash\""

# Test 16: Logs an Edit with file path
echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PROJECT_ROOT/src/foo.ts\",\"old_string\":\"a\",\"new_string\":\"bb\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
assert_file_contains "logs Edit with file" "$ACTIVITY_LOG_MC" "src/foo.ts"

# Test 17: Doesn't log non-harness sessions
LINES_BEFORE=$(wc -l < "$ACTIVITY_LOG_MC" 2>/dev/null || echo 0)
echo "{\"session_id\":\"unregistered\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"echo hi\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
LINES_AFTER=$(wc -l < "$ACTIVITY_LOG_MC" 2>/dev/null || echo 0)
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
RESULT=$(FILE_PATH="$TEMP_TSX" bash "$HOME/.claude-ops/hooks/operators/checks.d/no-inline-styles.sh" 2>/dev/null || true)
assert "catches inline styles" "inline style" "$RESULT"
rm -f "$TEMP_TSX"

# Test 19: Inline styles check ignores clean files
TEMP_TSX=$(mktemp /tmp/test_XXXXXX.tsx)
echo 'const Foo = () => <div className="card">hi</div>' > "$TEMP_TSX"
RESULT=$(FILE_PATH="$TEMP_TSX" bash "$HOME/.claude-ops/hooks/operators/checks.d/no-inline-styles.sh" 2>/dev/null || true)
assert_empty "ignores clean tsx" "$RESULT"
rm -f "$TEMP_TSX"

# Test 20: Mock data check catches placeholder
TEMP_TS=$(mktemp /tmp/test_XXXXXX.ts)
echo 'const data = "placeholder value"' > "$TEMP_TS"
RESULT=$(FILE_PATH="$TEMP_TS" bash "$HOME/.claude-ops/hooks/operators/checks.d/no-mock-data.sh" 2>/dev/null || true)
assert "catches mock data" "mock/placeholder" "$RESULT"
rm -f "$TEMP_TS"

# Test 21: Ignores non-ts files
RESULT=$(FILE_PATH="/tmp/readme.md" bash "$HOME/.claude-ops/hooks/operators/checks.d/no-inline-styles.sh" 2>/dev/null || true)
assert_empty "ignores non-tsx files" "$RESULT"

# ═════════════════════════════════════════════════════════════════════
# progress-validator.sh
# ═════════════════════════════════════════════════════════════════════

# Test 22: No verification artifact warnings on clean progress state
# (substep warnings are advisory and may appear if tasks have incomplete steps)
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION\",\"tool_input\":{\"file_path\":\"$PROJECT_ROOT/claude_files/miniapp-chat-progress.json\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/progress-validator.sh" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if echo "$RESULT" | grep -q "no artifact at"; then
  echo -e "  ${RED}FAIL${RESET} no verification artifact warnings"
  echo "    unexpected artifact warning: $(echo "$RESULT" | head -2)"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} no verification artifact warnings"
  PASS=$((PASS + 1))
fi

# ═════════════════════════════════════════════════════════════════════
# rotation advisory
# ═════════════════════════════════════════════════════════════════════

# Test 23: Rotation advisory file format is valid JSON
_RUNTIME_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/harness-runtime/miniapp-chat"
mkdir -p "$_RUNTIME_DIR" 2>/dev/null
echo '{"should_rotate":true,"reason":"test rotation","decided_at":"2026-02-23T12:00:00Z"}' \
  > "$_RUNTIME_DIR/rotation-advisory"
TOTAL=$((TOTAL + 1))
if jq -e '.should_rotate' "$_RUNTIME_DIR/rotation-advisory" > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} rotation advisory format is valid JSON"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} rotation advisory format invalid"
  FAIL=$((FAIL + 1))
fi
rm -f "$_RUNTIME_DIR/rotation-advisory"

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
ACTIVITY_LOG_BI="$ACTIVITY_DIR/claude_activity_bi-opt.jsonl"
rm -f "$ACTIVITY_LOG_BI"
echo "{\"session_id\":\"$MOCK_SESSION_BI\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"bun test\"}}" \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/operators/activity-logger.sh" 2>/dev/null
assert_file_contains "activity logger logs for bi-opt" "$ACTIVITY_LOG_BI" "\"tool\": \"Bash\""
rm -f "$ACTIVITY_LOG_BI"

# ═════════════════════════════════════════════════════════════════════
# cycle gate enforcement (long-running harness artifact checks)
# ═════════════════════════════════════════════════════════════════════

# Setup: create a temp long-running harness for cycle gate tests
CYCLE_TEST_DIR=$(mktemp -d /tmp/test-cycle-gate-XXXXXX)
CYCLE_HARNESS_DIR="$CYCLE_TEST_DIR/.claude/harness/test-cycle"
mkdir -p "$CYCLE_HARNESS_DIR"

# Base progress: long-running, ALL_DONE, last_cycle_at set (not first cycle)
cat > "$CYCLE_HARNESS_DIR/progress.json" << 'CEOF'
{
  "harness": "test-cycle",
  "mission": "test cycle gate",
  "lifecycle": "long-running",
  "status": "active",
  "cycles_completed": 1,
  "last_cycle_at": "2026-02-25T10:00:00Z",
  "sketch_approved": true,
  "generalization_approved": true,
  "tasks": {},
  "waves": [],
  "current_session": {"round_count": 0, "tasks_completed": 0},
  "rotation": {"mode": "none"},
  "commits": [],
  "learnings": []
}
CEOF

# Register the test harness
MOCK_SESSION_CYCLE="test-hooks-cycle-$$"
locked_jq_write "$MOCK_REGISTRY" "session-registry" '. + {($s): "test-cycle"}' --arg s "$MOCK_SESSION_CYCLE"

# Test 31: Both artifacts missing → block message contains "CYCLE GATE BLOCKED"
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_CYCLE\"}" \
  | PROJECT_ROOT="$CYCLE_TEST_DIR" CYCLE_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
assert "cycle gate blocks when both missing" "CYCLE GATE BLOCKED" "$RESULT"

# Test 32: Both present → no CYCLE GATE BLOCKED
echo "## Cycle 1 — test entry" > "$CYCLE_HARNESS_DIR/journal.md"
# Touch acceptance.md with future mtime (after last_cycle_at)
echo "Updated acceptance" > "$CYCLE_HARNESS_DIR/acceptance.md"
touch -t 202602251200 "$CYCLE_HARNESS_DIR/acceptance.md"
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_CYCLE\"}" \
  | PROJECT_ROOT="$CYCLE_TEST_DIR" CYCLE_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$RESULT" | grep -q "CYCLE GATE BLOCKED"; then
  echo -e "  ${RED}FAIL${RESET} cycle gate passes when both present (still blocked)"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} cycle gate passes when both present"
  PASS=$((PASS + 1))
fi

# Test 33: Only journal missing → WARNING, not BLOCKED
rm -f "$CYCLE_HARNESS_DIR/journal.md"
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_CYCLE\"}" \
  | PROJECT_ROOT="$CYCLE_TEST_DIR" CYCLE_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
assert "cycle gate warns when journal missing" "CYCLE GATE WARNING" "$RESULT"
TOTAL=$((TOTAL + 1))
if echo "$RESULT" | grep -q "CYCLE GATE BLOCKED"; then
  echo -e "  ${RED}FAIL${RESET} cycle gate should warn not block for one missing"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} cycle gate warns not blocks for one missing"
  PASS=$((PASS + 1))
fi

# Test 34: Bounded harness → never triggers cycle gate
cat > "$CYCLE_HARNESS_DIR/progress.json" << 'CEOF2'
{
  "harness": "test-cycle",
  "mission": "test cycle gate",
  "lifecycle": "bounded",
  "status": "active",
  "cycles_completed": 1,
  "last_cycle_at": "2026-02-25T10:00:00Z",
  "sketch_approved": true,
  "generalization_approved": true,
  "tasks": {},
  "waves": [],
  "rotation": {"mode": "none"},
  "current_session": {"round_count": 0, "tasks_completed": 0},
  "commits": [],
  "learnings": []
}
CEOF2
rm -f "$CYCLE_HARNESS_DIR/journal.md" "$CYCLE_HARNESS_DIR/acceptance.md"
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_CYCLE\"}" \
  | PROJECT_ROOT="$CYCLE_TEST_DIR" CYCLE_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$RESULT" | grep -q "CYCLE GATE"; then
  echo -e "  ${RED}FAIL${RESET} cycle gate should not trigger on bounded harness"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} cycle gate skips bounded harness"
  PASS=$((PASS + 1))
fi

# Test 35: First cycle (null last_cycle_at) → skip gate
cat > "$CYCLE_HARNESS_DIR/progress.json" << 'CEOF3'
{
  "harness": "test-cycle",
  "mission": "test cycle gate",
  "lifecycle": "long-running",
  "status": "active",
  "cycles_completed": 0,
  "last_cycle_at": null,
  "sketch_approved": true,
  "generalization_approved": true,
  "tasks": {},
  "waves": [],
  "rotation": {"mode": "none"},
  "current_session": {"round_count": 0, "tasks_completed": 0},
  "commits": [],
  "learnings": []
}
CEOF3
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_CYCLE\"}" \
  | PROJECT_ROOT="$CYCLE_TEST_DIR" CYCLE_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$RESULT" | grep -q "CYCLE GATE"; then
  echo -e "  ${RED}FAIL${RESET} cycle gate should skip first cycle (null last_cycle_at)"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} cycle gate skips first cycle"
  PASS=$((PASS + 1))
fi

# Cleanup cycle gate test state
rm -rf "$CYCLE_TEST_DIR"

# ═════════════════════════════════════════════════════════════════════
# phase gate dispatch (block_generic)
# ═════════════════════════════════════════════════════════════════════

# Setup: create a temp harness for phase gate tests
PHASE_TEST_DIR=$(mktemp -d /tmp/test-phase-gate-XXXXXX)
PHASE_HARNESS_DIR="$PHASE_TEST_DIR/.claude/harness/test-phase"
mkdir -p "$PHASE_HARNESS_DIR"

# Register the phase test harness
MOCK_SESSION_PHASE="test-hooks-phase-$$"
locked_jq_write "$MOCK_REGISTRY" "session-registry" '. + {($s): "test-phase"}' --arg s "$MOCK_SESSION_PHASE"

# Base progress: active, no tasks done, sketch not approved
cat > "$PHASE_HARNESS_DIR/progress.json" << 'PEOF'
{
  "harness": "test-phase",
  "mission": "test phase gates",
  "lifecycle": "bounded",
  "status": "active",
  "cycles_completed": 0,
  "last_cycle_at": null,
  "sketch_approved": false,
  "generalization_approved": false,
  "tasks": {},
  "waves": [],
  "rotation": {"mode": "none"},
  "current_session": {"round_count": 0, "tasks_completed": 0},
  "commits": [],
  "learnings": []
}
PEOF

# Test 36: Phase 0 blocks when sketch_approved=false, done=0
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_PHASE\"}" \
  | PROJECT_ROOT="$PHASE_TEST_DIR" PHASE_SKETCH_GATE_ENABLED=true PHASE_GENERALIZATION_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
assert "phase 0 blocks when sketch not approved" "decision" "$RESULT"
assert "phase 0 block mentions Phase 0" "Phase 0" "$RESULT"

# Test 37: Phase 0 passes when sketch_approved=true
tmp=$(mktemp)
jq '.sketch_approved = true' "$PHASE_HARNESS_DIR/progress.json" > "$tmp" && mv "$tmp" "$PHASE_HARNESS_DIR/progress.json"
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_PHASE\"}" \
  | PROJECT_ROOT="$PHASE_TEST_DIR" PHASE_SKETCH_GATE_ENABLED=true PHASE_GENERALIZATION_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$RESULT" | grep -q "Phase 0 "; then
  # Phase 0 (with trailing space) to avoid matching "Phase 0.5"
  echo -e "  ${RED}FAIL${RESET} phase 0 should pass when sketch approved"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} phase 0 passes when sketch approved"
  PASS=$((PASS + 1))
fi

# Test 38: Phase 0.5 blocks when sketch=true, gen=false, done=0
assert "phase 0.5 blocks when gen not approved" "Phase 0.5" "$RESULT"

# Test 39: Both approved: no phase block
tmp=$(mktemp)
jq '.sketch_approved = true | .generalization_approved = true' "$PHASE_HARNESS_DIR/progress.json" > "$tmp" && mv "$tmp" "$PHASE_HARNESS_DIR/progress.json"
RESULT=$(echo "{\"session_id\":\"$MOCK_SESSION_PHASE\"}" \
  | PROJECT_ROOT="$PHASE_TEST_DIR" PHASE_SKETCH_GATE_ENABLED=true PHASE_GENERALIZATION_GATE_ENABLED=true AGENT_DISCOVERY_ENABLED=false \
    bash "$HOME/.claude-ops/hooks/harness-dispatch.sh" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$RESULT" | grep -q "Phase 0"; then
  echo -e "  ${RED}FAIL${RESET} both approved but still found phase gate"
  echo "    got: $(echo "$RESULT" | head -2)"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} no phase gate when both approved"
  PASS=$((PASS + 1))
fi

# Cleanup phase gate test state
rm -rf "$PHASE_TEST_DIR"

# ═════════════════════════════════════════════════════════════════════
# Cleanup
# ═════════════════════════════════════════════════════════════════════
rm -f claude_files/miniapp-chat-verify/_test-task.md
rm -f "${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/activity/claude_activity_miniapp-chat.jsonl"

test_summary
