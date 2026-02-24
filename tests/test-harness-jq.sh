#!/usr/bin/env bash
# test-harness-jq.sh — Tests for lib/harness-jq.sh functions.
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

FIXTURES="$(dirname "$0")/fixtures"
PROGRESS="$FIXTURES/sample-progress.json"

echo "── harness-jq.sh ──"

# ── current_task ──
RESULT=$(harness_current_task "$PROGRESS")
assert_equals "current_task returns in_progress task" "task-3" "$RESULT"

# ── current_task with no in_progress ──
TMP=$(mktemp)
jq '.tasks["task-3"].status = "pending"' "$PROGRESS" > "$TMP"
RESULT=$(harness_current_task "$TMP")
assert_equals "current_task falls back to first unblocked pending" "task-3" "$RESULT"
rm -f "$TMP"

# ── current_task ALL_DONE ──
TMP=$(mktemp)
jq '.tasks |= map_values(.status = "completed")' "$PROGRESS" > "$TMP"
RESULT=$(harness_current_task "$TMP")
assert_equals "current_task returns ALL_DONE when all completed" "ALL_DONE" "$RESULT"
rm -f "$TMP"

# ── next_task ──
RESULT=$(harness_next_task "$PROGRESS")
assert_equals "next_task returns first unblocked pending" "task-5" "$RESULT"

# ── next_task ALL_DONE ──
TMP=$(mktemp)
jq '.tasks["task-4"].status = "completed" | .tasks["task-5"].status = "completed"' "$PROGRESS" > "$TMP"
RESULT=$(harness_next_task "$TMP")
assert_equals "next_task returns ALL_DONE when none pending" "ALL_DONE" "$RESULT"
rm -f "$TMP"

# ── done_count ──
RESULT=$(harness_done_count "$PROGRESS")
assert_equals "done_count is 2" "2" "$RESULT"

# ── total_count ──
RESULT=$(harness_total_count "$PROGRESS")
assert_equals "total_count is 5" "5" "$RESULT"

# ── completed_names ──
RESULT=$(harness_completed_names "$PROGRESS")
assert "completed_names includes task-1" "task-1" "$RESULT"
assert "completed_names includes task-2" "task-2" "$RESULT"

# ── pending_names ──
RESULT=$(harness_pending_names "$PROGRESS")
assert "pending_names includes task-4" "task-4" "$RESULT"
assert "pending_names includes task-5" "task-5" "$RESULT"

# ── task_description ──
RESULT=$(harness_task_description "$PROGRESS" "task-3")
assert_equals "task_description correct" "Currently active task" "$RESULT"

# ── name ──
RESULT=$(harness_name "$PROGRESS")
assert_equals "harness_name correct" "test-harness" "$RESULT"

# ── mission ──
RESULT=$(harness_mission "$PROGRESS")
assert_equals "harness_mission correct" "Test mission for unit tests" "$RESULT"

# ── check_blocked (unblocked task) ──
RESULT=$(harness_check_blocked "$PROGRESS" "task-5")
assert_equals "check_blocked returns null for unblocked" "null" "$RESULT"

# ── check_blocked (blocked task) ──
RESULT=$(harness_check_blocked "$PROGRESS" "task-4")
assert "check_blocked returns blocker info for blocked task" "blocked" "$RESULT"
assert "check_blocked shows task-3 as blocker" "task-3" "$RESULT"

# ── set_in_progress (unblocked) ──
TMP=$(mktemp)
harness_set_in_progress "$PROGRESS" "task-5" > "$TMP"
STATUS=$(jq -r '.tasks["task-5"].status' "$TMP")
assert_equals "set_in_progress sets status" "in_progress" "$STATUS"
rm -f "$TMP"

# ── set_in_progress (blocked — should fail) ──
RESULT=$(harness_set_in_progress "$PROGRESS" "task-4" 2>&1 || true)
assert "set_in_progress fails for blocked task" "ERROR" "$RESULT"

# ── set_completed ──
TMP=$(mktemp)
harness_set_completed "$PROGRESS" "task-3" > "$TMP"
STATUS=$(jq -r '.tasks["task-3"].status' "$TMP")
assert_equals "set_completed sets status" "completed" "$STATUS"
rm -f "$TMP"

# ── would_unblock ──
RESULT=$(harness_would_unblock "$PROGRESS" "task-3")
assert "would_unblock shows task-4" "task-4" "$RESULT"

# ── harness_state ──
TMP=$(mktemp)
jq '.state = {"cycle_count": 5, "mode": "swarm"}' "$PROGRESS" > "$TMP"
RESULT=$(harness_state "$TMP" "cycle_count")
assert_equals "harness_state reads state field" "5" "$RESULT"
rm -f "$TMP"

# ── MANIFEST FUNCTIONS ──
echo ""
echo "── manifest functions ──"

# harness_manifest
RESULT=$(harness_manifest "test-manifest")
assert "harness_manifest returns expected path" ".claude-ops/harness/manifests/test-manifest/manifest.json" "$RESULT"

# harness_list_active (uses real manifests from Task 4)
RESULT=$(harness_list_active)
assert "harness_list_active finds eval-external" "eval-external" "$RESULT"
assert "harness_list_active finds chatbot-agent" "chatbot-agent" "$RESULT"

# harness_list_all
RESULT=$(harness_list_all)
assert "harness_list_all finds bi-opt" "bi-opt" "$RESULT"

# harness_project_root
RESULT=$(harness_project_root "eval-external")
assert "harness_project_root returns project path" "Wechat" "$RESULT"

# harness_progress_path
RESULT=$(harness_progress_path "eval-external")
assert "harness_progress_path returns absolute path" "eval-external-progress.json" "$RESULT"

test_summary
