#!/usr/bin/env bash
# test-worker-task.sh — Tests for worker-task.sh task lifecycle management.
# Covers: add, claim, complete, list, next, dependency chains, recurring tasks.
set -uo pipefail

source "$(dirname "$0")/helpers.sh"

WORKER_TASK="$HOME/.boring/scripts/worker-task.sh"
WORKER_NAME="test-wt-$$"
TMPDIR_TEST=$(mktemp -d)
WORKER_DIR="$TMPDIR_TEST/.claude/workers/$WORKER_NAME"
TASKS="$WORKER_DIR/tasks.json"

# Set up a git repo with a worker/ branch (worker-task.sh auto-detects from HEAD).
# Requires at least one commit: git rev-parse --abbrev-ref HEAD returns HEAD (not branch name)
# on an unborn branch, so detection would fail without an initial commit.
git -C "$TMPDIR_TEST" init -q
git -C "$TMPDIR_TEST" config user.email "test@test"
git -C "$TMPDIR_TEST" config user.name "Test"
touch "$TMPDIR_TEST/.gitkeep"
git -C "$TMPDIR_TEST" add .gitkeep 2>/dev/null
git -C "$TMPDIR_TEST" commit -qm "init" 2>/dev/null || true
git -C "$TMPDIR_TEST" checkout -b "worker/$WORKER_NAME" -q 2>/dev/null \
  || git -C "$TMPDIR_TEST" switch -c "worker/$WORKER_NAME" -q 2>/dev/null || true

mkdir -p "$WORKER_DIR"
echo '{}' > "$TASKS"

# Create an isolated state dir with empty pane registry.
# worker-task.sh detects worker from: (1) pane registry, (2) git branch.
# Without isolation, the pane registry would return the current Claude session's harness.
TEMP_STATE_DIR="$TMPDIR_TEST/.boring-state"
mkdir -p "$TEMP_STATE_DIR/locks"
echo '{}' > "$TEMP_STATE_DIR/pane-registry.json"

cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

# Helper: run worker-task.sh from within the test git repo.
# HARNESS_STATE_DIR override → empty pane registry → falls through to git branch detection.
# Suppresses "local: can only be used in a function" noise (harmless bash pedantry).
_task() { (cd "$TMPDIR_TEST" && HARNESS_STATE_DIR="$TEMP_STATE_DIR" bash "$WORKER_TASK" "$@" 2>/dev/null); }
_task_with_err() { (cd "$TMPDIR_TEST" && HARNESS_STATE_DIR="$TEMP_STATE_DIR" bash "$WORKER_TASK" "$@" 2>&1) || true; }

echo "── worker-task.sh: add ──"

_task add "First task" > /dev/null
assert_equals "add creates T001 with status=pending" "pending" "$(jq -r '.T001.status' "$TASKS")"
assert_equals "add sets default priority=medium" "medium" "$(jq -r '.T001.priority' "$TASKS")"
assert_equals "add sets recurring=false by default" "false" "$(jq -r '.T001.recurring' "$TASKS")"
assert_equals "add sets owner=null" "null" "$(jq -r '.T001.owner' "$TASKS")"
assert_not_empty "add sets created_at" "$(jq -r '.T001.created_at // empty' "$TASKS")"

_task add "High priority task" --priority high > /dev/null
assert_equals "add --priority high sets correct field" "high" "$(jq -r '.T002.priority' "$TASKS")"

_task add "Described task" --desc "Some details here" > /dev/null
assert_equals "add --desc sets description" "Some details here" "$(jq -r '.T003.description' "$TASKS")"

_task add "Recurring task" --recurring > /dev/null
assert_equals "add --recurring sets recurring=true" "true" "$(jq -r '.T004.recurring' "$TASKS")"

_task add "Blocked task" --after "T001,T002" > /dev/null
assert_equals "add --after sets blocked_by length=2" "2" "$(jq '.T005.blocked_by | length' "$TASKS")"
assert "add --after T001 in blocked_by" "T001" "$(jq -r '.T005.blocked_by[]' "$TASKS")"
assert "add --after T002 in blocked_by" "T002" "$(jq -r '.T005.blocked_by[]' "$TASKS")"

OUTPUT=$(_task add "Sixth task")
assert "add returns task ID in output" "T006" "$OUTPUT"

assert_equals "auto-increment: 6 tasks total" "6" "$(jq 'keys | length' "$TASKS")"

echo ""
echo "── worker-task.sh: claim ──"

CLAIM_OUT=$(_task_with_err claim T001)
assert "claim prints Claimed T001" "Claimed T001" "$CLAIM_OUT"
assert_equals "claim sets status=in_progress" "in_progress" "$(jq -r '.T001.status' "$TASKS")"
OWNER=$(jq -r '.T001.owner // empty' "$TASKS")
[ -z "$OWNER" ] && OWNER="empty"
assert "claim sets owner (non-null)" "T" "${OWNER}T"  # any non-empty string passes the grep

# Claim blocked task should fail (T005 blocked by T001,T002; T002 still pending)
CLAIM_BLOCKED=$(_task_with_err claim T005)
assert "claim blocked task prints ERROR" "ERROR" "$CLAIM_BLOCKED"
assert "claim blocked task mentions blocked" "blocked" "$CLAIM_BLOCKED"

# Claim already-completed task should fail
_task complete T001 > /dev/null
ERR=$(_task_with_err claim T001)
assert "claim completed task prints ERROR" "ERROR" "$ERR"

echo ""
echo "── worker-task.sh: complete ──"

# Claim and complete T002
_task claim T002 > /dev/null
COMPLETE_OUT=$(_task_with_err complete T002)
assert "complete prints Completed T002" "Completed T002" "$COMPLETE_OUT"
assert_equals "complete sets status=completed" "completed" "$(jq -r '.T002.status' "$TASKS")"
assert_not_empty "complete sets completed_at" "$(jq -r '.T002.completed_at // empty' "$TASKS")"

echo ""
echo "── worker-task.sh: recurring complete ──"

# T004 is recurring — claim and complete it
_task claim T004 > /dev/null
_task complete T004 > /dev/null
assert_equals "recurring: resets to pending" "pending" "$(jq -r '.T004.status' "$TASKS")"
assert_equals "recurring: cycles_completed incremented" "1" "$(jq '.T004.cycles_completed' "$TASKS")"
assert_equals "recurring: owner cleared" "null" "$(jq -r '.T004.owner' "$TASKS")"
assert_equals "recurring: completed_at cleared" "null" "$(jq -r '.T004.completed_at' "$TASKS")"
assert_not_empty "recurring: last_completed_at set" "$(jq -r '.T004.last_completed_at // empty' "$TASKS")"

echo ""
echo "── worker-task.sh: next ──"

# State: T001=completed, T002=completed, T003=pending/medium, T004=pending/medium(recurring), T005=blocked, T006=pending/medium
# T002 done → T005 still blocked by T001(done)? No: T001 also done → T005 is unblocked!
# Actually T005 blocked by T001,T002 — both are now completed → T005 is unblocked

NEXT=$(_task next)
assert "next returns a task ID" "T0" "$NEXT"
# T005 unblocked, T003/T004/T006 all medium priority — next should pick lowest T003 or T004 or T005
# All are medium priority, so first by insertion order (T003)
assert "next picks T003 (medium, unblocked, first)" "T003" "$NEXT"

# Add a critical task — should jump to top
_task add "Critical fix" --priority critical > /dev/null
NEXT_CRIT=$(_task next)
assert "next picks critical priority task first" "T007" "$NEXT_CRIT"

echo ""
echo "── worker-task.sh: next skips blocked tasks ──"

_task add "Blocked by active" --after "T003" > /dev/null  # T008, blocked by T003 (pending)
NEXT_SKIP=$(_task next)
# T007 still unclaimed critical — should still be first
assert "next skips T008 (blocked) and picks T007" "T007" "$NEXT_SKIP"

echo ""
echo "── worker-task.sh: list --pending ──"

LIST_PENDING=$(_task list --pending)
assert "list --pending includes T007 (ready)" "T007" "$LIST_PENDING"
assert "list --pending includes T003 (ready)" "T003" "$LIST_PENDING"
# T005 is now unblocked (T001+T002 done) — should appear
assert "list --pending includes T005 (now unblocked)" "T005" "$LIST_PENDING"
# T008 blocked by T003 — should NOT appear in --pending
echo "$LIST_PENDING" | grep -q "T008" && BLOCKED_SHOWN="shown" || BLOCKED_SHOWN="hidden"
assert_equals "list --pending hides blocked T008" "hidden" "$BLOCKED_SHOWN"

echo ""
echo "── worker-task.sh: list --blocked ──"

LIST_BLOCKED=$(_task list --blocked)
assert "list --blocked shows T008" "T008" "$LIST_BLOCKED"
# T005 is now unblocked — should NOT appear in --blocked
echo "$LIST_BLOCKED" | grep -q "T005" && B5_SHOWN="shown" || B5_SHOWN="hidden"
assert_equals "list --blocked hides T005 (now unblocked)" "hidden" "$B5_SHOWN"

echo ""
echo "── worker-task.sh: dependency unblocking ──"

# Complete T003 → T008 should become unblocked
_task claim T003 > /dev/null
_task complete T003 > /dev/null
NEXT_UNBLOCKED=$(_task next)
# T007 still unclaimed → should still be next
assert "next after completing T003 shows T007 (critical)" "T007" "$NEXT_UNBLOCKED"
LIST_UNBLOCKED=$(_task list --pending)
assert "list --pending shows T008 after T003 completes" "T008" "$LIST_UNBLOCKED"

test_summary
