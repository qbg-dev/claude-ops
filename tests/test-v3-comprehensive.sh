#!/usr/bin/env bash
# test-v3-comprehensive.sh — Deep coverage for v3 agent architecture
#
# Sections:
#   1. state.json lifecycle (creation, bump, concurrent, edge cases)
#   2. config.json validation (all harnesses)
#   3. tasks.json CRUD operations
#   4. worker_scaffold output validation
#   5. worker_send routing and bus publish
#   6. hq_send edge cases (missing args, priority)
#   7. MEMORY.md enforcement (size, mtime gate)
#   8. mission.md structure validation
#   9. pane-registry operations
#  10. bus side-effects (inbox/outbox materialization)
#  11. watchdog event types in schema
#  12. stop hook v3 file reads
#  13. seed template variable substitution
#  14. v3 file resolver edge cases
#  15. harness_bump_session concurrent safety
#
# Usage:
#   bash ~/.claude-ops/tests/test-v3-comprehensive.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

FIXTURES="$(dirname "$0")/fixtures"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# ════════════════════════════════════════════════════════════════
# 1. state.json lifecycle
# ════════════════════════════════════════════════════════════════
echo "── state.json lifecycle ──"

# 1a: Fresh state.json with all required fields
TMP=$(mktemp -d)
mkdir -p "$TMP/agents/sidecar"
echo '{}' > "$TMP/tasks.json"
echo '{}' > "$TMP/agents/sidecar/config.json"
echo '{"status":"active","cycles_completed":0}' > "$TMP/agents/sidecar/state.json"

harness_bump_session "$TMP/tasks.json" 2>/dev/null || true
CYCLES=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
assert_equals "fresh state: 0→1" "1" "$CYCLES"

harness_bump_session "$TMP/tasks.json" 2>/dev/null || true
CYCLES=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
assert_equals "double bump: 1→2" "2" "$CYCLES"

harness_bump_session "$TMP/tasks.json" 2>/dev/null || true
CYCLES=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
assert_equals "triple bump: 2→3" "3" "$CYCLES"

# 1b: last_cycle_at is ISO 8601
LAST=$(jq -r '.last_cycle_at' "$TMP/agents/sidecar/state.json")
echo "$LAST" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
assert_equals "last_cycle_at is ISO 8601" "0" "$?"

# 1c: state.json preserves extra fields
jq '.custom_field = "preserved"' "$TMP/agents/sidecar/state.json" > "$TMP/agents/sidecar/state.json.tmp"
mv "$TMP/agents/sidecar/state.json.tmp" "$TMP/agents/sidecar/state.json"
harness_bump_session "$TMP/tasks.json" 2>/dev/null || true
CUSTOM=$(jq -r '.custom_field' "$TMP/agents/sidecar/state.json")
assert_equals "bump preserves custom fields" "preserved" "$CUSTOM"

# 1d: Large cycles_completed (no integer overflow)
jq '.cycles_completed = 9999' "$TMP/agents/sidecar/state.json" > "$TMP/agents/sidecar/state.json.tmp"
mv "$TMP/agents/sidecar/state.json.tmp" "$TMP/agents/sidecar/state.json"
harness_bump_session "$TMP/tasks.json" 2>/dev/null || true
CYCLES=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
assert_equals "large cycle count: 9999→10000" "10000" "$CYCLES"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 2. config.json validation (all active harnesses)
# ════════════════════════════════════════════════════════════════
echo ""
echo "── config.json validation (active harnesses) ──"

ACTIVE_HARNESSES="hq-v2 mod-customer mod-depts mod-engineering mod-finance mod-infra mod-workorder red-team service-miniapp-ux"
for h in $ACTIVE_HARNESSES; do
  CONFIG="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/config.json"
  if [ -f "$CONFIG" ]; then
    jq -e '.' "$CONFIG" > /dev/null 2>&1
    assert_equals "$h: config.json is valid JSON" "0" "$?"
    NAME=$(jq -r '.name // empty' "$CONFIG")
    assert "config $h has name" "$h" "$NAME"
  else
    TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1))
    echo -e "  ${RED}FAIL${RESET} $h: config.json missing"
  fi
done

# ════════════════════════════════════════════════════════════════
# 3. tasks.json CRUD operations
# ════════════════════════════════════════════════════════════════
echo ""
echo "── tasks.json CRUD ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/agents/sidecar"
echo '{"name":"test"}' > "$TMP/agents/sidecar/config.json"
echo '{"status":"active"}' > "$TMP/agents/sidecar/state.json"
cat > "$TMP/tasks.json" <<'EOF'
{"tasks":{"t1":{"status":"pending","description":"Task 1"},"t2":{"status":"pending","description":"Task 2","blockedBy":["t1"]},"t3":{"status":"completed","description":"Task 3"}}}
EOF
ANCHOR="$TMP/fake-progress.json"
echo '{}' > "$ANCHOR"

# Read operations
CURRENT=$(harness_current_task "$ANCHOR" 2>/dev/null || echo "error")
assert_equals "current_task picks unblocked pending" "t1" "$CURRENT"

NEXT=$(harness_next_task "$ANCHOR" 2>/dev/null || echo "error")
assert_equals "next_task skips blocked tasks" "t1" "$NEXT"

DONE=$(harness_done_count "$ANCHOR" 2>/dev/null || echo "error")
assert_equals "done_count = 1 (t3)" "1" "$DONE"

TOTAL_T=$(harness_total_count "$ANCHOR" 2>/dev/null || echo "error")
assert_equals "total_count = 3" "3" "$TOTAL_T"

COMPLETED=$(harness_completed_names "$ANCHOR" 2>/dev/null || echo "error")
assert "completed_names includes t3" "t3" "$COMPLETED"

PENDING=$(harness_pending_names "$ANCHOR" 2>/dev/null || echo "error")
assert "pending_names includes t1" "t1" "$PENDING"
assert "pending_names includes t2" "t2" "$PENDING"

DESC=$(harness_task_description "$ANCHOR" "t1" 2>/dev/null || echo "error")
assert_equals "task_description for t1" "Task 1" "$DESC"

# Write operations
harness_set_in_progress "$ANCHOR" "t1" > /dev/null 2>&1 || true
STATUS=$(jq -r '.tasks.t1.status' "$TMP/tasks.json")
assert_equals "set_in_progress on t1" "in_progress" "$STATUS"

harness_set_completed "$ANCHOR" "t1" > /dev/null 2>&1 || true
STATUS=$(jq -r '.tasks.t1.status' "$TMP/tasks.json")
assert_equals "set_completed on t1" "completed" "$STATUS"

# After completing t1, t2 should be unblocked
BLOCKED=$(harness_check_blocked "$ANCHOR" "t2" 2>/dev/null)
assert_equals "t2 unblocked after t1 completed" "null" "$BLOCKED"

# Would-unblock
jq '.tasks.t1.status = "in_progress"' "$TMP/tasks.json" > "$TMP/tasks.json.tmp" && mv "$TMP/tasks.json.tmp" "$TMP/tasks.json"
UNBLOCKS=$(harness_would_unblock "$ANCHOR" "t1" 2>/dev/null)
assert "completing t1 would unblock t2" "t2" "$UNBLOCKS"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 4. worker_scaffold output validation
# ════════════════════════════════════════════════════════════════
echo ""
echo "── worker_scaffold deep validation ──"

TMP=$(mktemp -d)
worker_scaffold "test-mod" "deep-worker" "optimization" "Optimize perf" "P99 < 200ms" "warren" "$TMP" 2>/dev/null

BASE="$TMP/.claude/harness/test-mod/agents/worker/deep-worker"

# All 6 required files exist
for f in mission.md config.json state.json MEMORY.md inbox.jsonl outbox.jsonl; do
  assert_file_exists "scaffold creates $f" "$BASE/$f"
done

# Memory subdirs
for d in ref notes scripts; do
  if [ -d "$BASE/memory/$d" ]; then
    assert_equals "scaffold creates memory/$d" "0" "0"
  else
    assert_equals "scaffold creates memory/$d" "exists" "missing"
  fi
done

# mission.md has the right content (v3 spec: Goal + Constraints)
assert_file_contains "mission has goal" "$BASE/mission.md" "Optimize perf"
assert_file_contains "mission has constraints" "$BASE/mission.md" "P99 < 200ms"
assert_file_contains "mission has ## Goal" "$BASE/mission.md" "## Goal"
assert_file_contains "mission has ## Constraints" "$BASE/mission.md" "## Constraints"

# config.json structure (v3: type + parent)
CONFIG_TYPE=$(jq -r '.type // empty' "$BASE/config.json")
assert_equals "config type is optimization" "optimization" "$CONFIG_TYPE"
CONFIG_PARENT=$(jq -r '.parent // empty' "$BASE/config.json")
assert_equals "config parent is test-mod" "test-mod" "$CONFIG_PARENT"

# state.json structure (v3: cycles_completed, not loop_count)
STATE_TYPE=$(jq -r '.type // empty' "$BASE/state.json")
assert_equals "state type is optimization" "optimization" "$STATE_TYPE"
STATE_CYCLES=$(jq -r '.cycles_completed // 0' "$BASE/state.json")
assert_equals "state starts at 0 cycles" "0" "$STATE_CYCLES"

# inbox/outbox are empty (not invalid JSON)
INBOX_SIZE=$(wc -c < "$BASE/inbox.jsonl" | tr -d ' ')
assert_equals "inbox.jsonl starts empty" "0" "$INBOX_SIZE"

# MEMORY.md starts with # Memory header
assert_file_contains "MEMORY starts with header" "$BASE/MEMORY.md" "# Memory"

rm -rf "$TMP"

# Worker types: execution, optimization, monitoring
for wtype in execution optimization monitoring; do
  TMP=$(mktemp -d)
  worker_scaffold "mod-test" "w-$wtype" "$wtype" "Goal" "Constraint" "warren" "$TMP" 2>/dev/null
  TYPE=$(jq -r '.type' "$TMP/.claude/harness/mod-test/agents/worker/w-$wtype/state.json")
  assert_equals "scaffold type=$wtype" "$wtype" "$TYPE"
  rm -rf "$TMP"
done

# ════════════════════════════════════════════════════════════════
# 5. worker_send routing
# ════════════════════════════════════════════════════════════════
echo ""
echo "── worker_send routing ──"

# worker_send writes to outbox and returns QUEUED|target|type
WD="$HOME/.claude-ops/lib/worker-dispatch.sh"
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/bus" "$TMP/.claude/harness/test-harness/agents/sidecar"
echo '{"seq": 0}' > "$TMP/.claude/bus/seq.json"
echo '{"event_types": {}}' > "$TMP/.claude/bus/schema.json"
touch "$TMP/.claude/bus/stream.jsonl"
touch "$TMP/.claude/harness/test-harness/agents/sidecar/outbox.jsonl"

# worker_send context type
RESULT=$(PROJECT_ROOT="$TMP" HARNESS="test-harness" SIDECAR_NAME="test-sidecar" bash -c "
  source '$HOME/.claude-ops/lib/harness-jq.sh'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  source '$WD'
  worker_send 'my-worker' context 'test-key' 'test-value'
" 2>/dev/null || echo "ERROR")
assert "worker_send context returns QUEUED" "QUEUED" "$RESULT"

# worker_send task type
RESULT=$(PROJECT_ROOT="$TMP" HARNESS="test-harness" SIDECAR_NAME="test-sidecar" bash -c "
  source '$HOME/.claude-ops/lib/harness-jq.sh'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  source '$WD'
  worker_send 'my-worker' task 'task-1' 'do something' ''
" 2>/dev/null || echo "ERROR")
assert "worker_send task returns QUEUED" "QUEUED" "$RESULT"

# worker_send directive type
RESULT=$(PROJECT_ROOT="$TMP" HARNESS="test-harness" SIDECAR_NAME="test-sidecar" bash -c "
  source '$HOME/.claude-ops/lib/harness-jq.sh'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  source '$WD'
  worker_send 'my-worker' directive 'do this now'
" 2>/dev/null || echo "ERROR")
assert "worker_send directive returns QUEUED" "QUEUED" "$RESULT"

# Invalid type should fail
RESULT=$(PROJECT_ROOT="$TMP" HARNESS="test-harness" SIDECAR_NAME="test-sidecar" bash -c "
  source '$HOME/.claude-ops/lib/harness-jq.sh'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  source '$WD'
  worker_send 'my-worker' invalid_type 'data' 2>&1
  echo \"EXIT:\$?\"
" 2>/dev/null || echo "ERROR")
assert "worker_send rejects invalid type" "ERROR" "$RESULT"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 6. hq_send edge cases
# ════════════════════════════════════════════════════════════════
echo ""
echo "── hq_send edge cases ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/bus"
echo '{"seq": 0}' > "$TMP/.claude/bus/seq.json"
echo '{"event_types": {}}' > "$TMP/.claude/bus/schema.json"
touch "$TMP/.claude/bus/stream.jsonl"

# With explicit priority
RESULT=$(PROJECT_ROOT="$TMP" bash -c "
  source '$HOME/.claude-ops/lib/harness-jq.sh'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  hq_send 'hq-v2' 'mod-customer' 'task' 'urgent fix' 'urgent' 2>/dev/null
  tail -1 '$TMP/.claude/bus/stream.jsonl' 2>/dev/null
" 2>/dev/null || echo "{}")
PRIORITY=$(echo "$RESULT" | jq -r '.priority // empty' 2>/dev/null || echo "")
assert_equals "hq_send priority=urgent" "urgent" "$PRIORITY"

# Worker address with slash
RESULT=$(PROJECT_ROOT="$TMP" bash -c "
  source '$HOME/.claude-ops/lib/harness-jq.sh'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  hq_send 'mod-customer/kefu-latency' 'mod-customer' 'status' 'done' 2>/dev/null
  tail -1 '$TMP/.claude/bus/stream.jsonl' 2>/dev/null
" 2>/dev/null || echo "{}")
FROM=$(echo "$RESULT" | jq -r '.from // empty' 2>/dev/null || echo "")
assert_equals "hq_send from worker address" "mod-customer/kefu-latency" "$FROM"

# Default priority is normal
RESULT=$(PROJECT_ROOT="$TMP" bash -c "
  source '$HOME/.claude-ops/lib/harness-jq.sh'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  hq_send 'hq-v2' 'mod-infra' 'status' 'all ok' 2>/dev/null
  tail -1 '$TMP/.claude/bus/stream.jsonl' 2>/dev/null
" 2>/dev/null || echo "{}")
PRIORITY=$(echo "$RESULT" | jq -r '.priority // empty' 2>/dev/null || echo "")
assert_equals "hq_send default priority=normal" "normal" "$PRIORITY"

# Has timestamp
TS=$(echo "$RESULT" | jq -r '.ts // empty' 2>/dev/null || echo "")
echo "$TS" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
assert_equals "hq_send includes ISO timestamp" "0" "$?"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 7. MEMORY.md enforcement
# ════════════════════════════════════════════════════════════════
echo ""
echo "── MEMORY.md enforcement ──"

# All active harnesses have MEMORY.md
for h in $ACTIVE_HARNESSES; do
  MEM="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/MEMORY.md"
  assert_file_exists "$h has MEMORY.md" "$MEM"
done

# MEMORY.md files under 200 lines
for h in $ACTIVE_HARNESSES; do
  MEM="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/MEMORY.md"
  [ -f "$MEM" ] || continue
  LINES=$(wc -l < "$MEM" | tr -d ' ')
  [ "$LINES" -le 200 ]
  assert_equals "$h MEMORY.md ≤ 200 lines ($LINES)" "0" "$?"
done

# ════════════════════════════════════════════════════════════════
# 8. mission.md structure
# ════════════════════════════════════════════════════════════════
echo ""
echo "── mission.md structure ──"

for h in $ACTIVE_HARNESSES; do
  MISSION="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/mission.md"
  [ -f "$MISSION" ] || continue
  assert_file_contains "$h mission has ## Goal" "$MISSION" "## Goal"
  assert_file_contains "$h mission has ## Constraints" "$MISSION" "## Constraints"
done

# ════════════════════════════════════════════════════════════════
# 9. pane-registry operations
# ════════════════════════════════════════════════════════════════
echo ""
echo "── pane-registry operations ──"

# pane_registry_update function exists
assert "pane_registry_update defined" "pane_registry_update" "$(type pane_registry_update 2>/dev/null)"

# pane_registry_read function exists
assert "pane_registry_read defined" "pane_registry_read" "$(type pane_registry_read 2>/dev/null)"

# Functional test: write and read from pane-registry
# API: pane_registry_update PANE_ID HARNESS TASK DONE TOTAL DISPLAY [PANE_TARGET] [AGENT_ROLE]
TMP=$(mktemp -d)
PANE_REGISTRY="$TMP/pane-registry.json"
export PANE_REGISTRY
echo '{}' > "$PANE_REGISTRY"

pane_registry_update "%test123" "test-h" "test-t" "0" "3" "test-h: 0/3" 2>/dev/null || true
READ_RESULT=$(pane_registry_read "%test123" 2>/dev/null || echo "{}")
READ_HARNESS=$(echo "$READ_RESULT" | jq -r '.harness // empty')
assert_equals "pane_registry write+read harness" "test-h" "$READ_HARNESS"
READ_TASK=$(echo "$READ_RESULT" | jq -r '.task // empty')
assert_equals "pane_registry write+read task" "test-t" "$READ_TASK"

# Overwrite existing entry
pane_registry_update "%test123" "updated-h" "updated-t" "1" "5" "updated: 1/5" 2>/dev/null || true
READ_RESULT=$(pane_registry_read "%test123" 2>/dev/null || echo "{}")
READ_HARNESS=$(echo "$READ_RESULT" | jq -r '.harness // empty')
assert_equals "pane_registry overwrite works" "updated-h" "$READ_HARNESS"

unset PANE_REGISTRY
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 10. bus side-effects
# ════════════════════════════════════════════════════════════════
echo ""
echo "── bus side-effects ──"

# All side-effect scripts exist and have valid bash
SE_DIR="$HOME/.claude-ops/bus/side-effects"
if [ -d "$SE_DIR" ]; then
  SE_COUNT=0
  SE_VALID=0
  for f in "$SE_DIR"/*.sh; do
    [ -f "$f" ] || continue
    SE_COUNT=$((SE_COUNT+1))
    bash -n "$f" 2>/dev/null && SE_VALID=$((SE_VALID+1))
  done
  assert_equals "all $SE_COUNT side-effect scripts valid bash" "$SE_COUNT" "$SE_VALID"

  # Key side-effects exist
  assert_file_exists "sync_harness_inbox exists" "$SE_DIR/sync_harness_inbox.sh"
  assert_file_exists "update_tasks_json exists" "$SE_DIR/update_tasks_json.sh"
else
  TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1))
  echo -e "  ${RED}FAIL${RESET} side-effects directory missing"
fi

# ════════════════════════════════════════════════════════════════
# 11. watchdog event types in schema
# ════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog events in schema ──"

SCHEMA="$PROJECT_ROOT/.claude/bus/schema.json"
if [ -f "$SCHEMA" ]; then
  for evt in agent.stopped agent.respawned agent.crash agent.stuck agent.nudged agent.crash-loop; do
    if jq -e ".event_types[\"$evt\"]" "$SCHEMA" > /dev/null 2>&1; then
      assert_equals "schema has $evt" "yes" "yes"
    else
      assert_equals "schema has $evt" "yes" "no"
    fi
  done
else
  TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1))
  echo -e "  ${RED}FAIL${RESET} schema.json missing"
fi

# ════════════════════════════════════════════════════════════════
# 12. stop hook reads v3 files
# ════════════════════════════════════════════════════════════════
echo ""
echo "── stop hook v3 compat ──"

DISPATCH="$HOME/.claude-ops/hooks/gates/stop-harness-dispatch.sh"
if [ -f "$DISPATCH" ]; then
  bash -n "$DISPATCH" 2>/dev/null
  assert_equals "dispatch syntax OK" "0" "$?"

  # Reads from v3 files
  assert_file_contains "dispatch reads config.json" "$DISPATCH" "agents/sidecar/config.json"
  assert_file_contains "dispatch reads state.json" "$DISPATCH" "agents/sidecar/state.json"
  assert_file_contains "dispatch uses hook_pass" "$DISPATCH" "hook_pass"
  assert_file_contains "dispatch uses hook_block" "$DISPATCH" "hook_block"

  # Dispatch must reference v3 files (config.json/state.json) — progress.json may exist as v2 fallback
  assert_file_contains "dispatch references config.json" "$DISPATCH" "config.json"
  assert_file_contains "dispatch references state.json" "$DISPATCH" "state.json"
else
  TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1))
  echo -e "  ${RED}FAIL${RESET} stop-harness-dispatch.sh missing"
fi

# ════════════════════════════════════════════════════════════════
# 13. seed template substitution
# ════════════════════════════════════════════════════════════════
echo ""
echo "── seed template substitution ──"

TMPL="$HOME/.claude-ops/templates/seed.sh.tmpl"

# Test with various harness names (including hyphens)
for name in "mod-customer" "hq-v2" "service-miniapp-ux"; do
  TMP_SEED=$(mktemp)
  sed "s|{{HARNESS}}|$name|g; s|{{PROJECT_ROOT}}|/tmp/test-proj|g" "$TMPL" > "$TMP_SEED"

  # No unsubstituted placeholders
  PLACEHOLDERS=$(grep -c '{{' "$TMP_SEED" 2>/dev/null; true)
  assert_equals "no {{}} placeholders for $name" "0" "$PLACEHOLDERS"

  # Harness name appears in output
  assert_file_contains "seed contains $name" "$TMP_SEED" "$name"

  # PROJECT_ROOT substituted
  assert_file_contains "seed contains project root" "$TMP_SEED" "/tmp/test-proj"

  rm -f "$TMP_SEED"
done

# ════════════════════════════════════════════════════════════════
# 14. v3 file resolver edge cases
# ════════════════════════════════════════════════════════════════
echo ""
echo "── v3 file resolvers ──"

# _resolve_tasks_file with valid v3 layout
TMP=$(mktemp -d)
mkdir -p "$TMP/agents/sidecar"
echo '{"tasks":{}}' > "$TMP/tasks.json"
echo '{}' > "$TMP/agents/sidecar/config.json"
echo '{}' > "$TMP/agents/sidecar/state.json"
echo '{}' > "$TMP/anchor.json"

RESOLVED=$(_resolve_tasks_file "$TMP/anchor.json" 2>/dev/null || echo "ERROR")
assert "resolver finds tasks.json" "tasks.json" "$RESOLVED"

RESOLVED=$(_resolve_config_file "$TMP/anchor.json" 2>/dev/null || echo "ERROR")
assert "resolver finds config.json" "config.json" "$RESOLVED"

RESOLVED=$(_resolve_state_file "$TMP/anchor.json" 2>/dev/null || echo "ERROR")
assert "resolver finds state.json" "state.json" "$RESOLVED"

rm -rf "$TMP"

# Resolver errors on completely empty dir
TMP=$(mktemp -d)
echo '{}' > "$TMP/anchor.json"
RESULT=$(_resolve_tasks_file "$TMP/anchor.json" 2>&1 || true)
assert "resolver errors on missing tasks.json" "ERROR" "$RESULT"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 15. Concurrent bump_session safety
# ════════════════════════════════════════════════════════════════
echo ""
echo "── concurrent bump_session ──"

TMP=$(mktemp -d)
mkdir -p "$TMP/agents/sidecar"
echo '{"tasks":{}}' > "$TMP/tasks.json"
echo '{}' > "$TMP/agents/sidecar/config.json"
echo '{"status":"active","cycles_completed":0}' > "$TMP/agents/sidecar/state.json"

# Fire 5 concurrent bumps
for i in 1 2 3 4 5; do
  harness_bump_session "$TMP/tasks.json" 2>/dev/null &
done
wait

FINAL=$(jq -r '.cycles_completed' "$TMP/agents/sidecar/state.json")
# With locking, should be exactly 5. Without, could be less.
assert_equals "5 concurrent bumps → cycles=5" "5" "$FINAL"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 16. v3 files across ALL active harnesses (comprehensive)
# ════════════════════════════════════════════════════════════════
echo ""
echo "── all harnesses have v3 files ──"

for h in $ACTIVE_HARNESSES; do
  HDIR="$PROJECT_ROOT/.claude/harness/$h"
  SDIR="$HDIR/agents/sidecar"

  # Required files
  for f in config.json state.json mission.md MEMORY.md; do
    assert_file_exists "$h: agents/sidecar/$f" "$SDIR/$f"
  done

  # tasks.json at module level
  assert_file_exists "$h: tasks.json" "$HDIR/tasks.json"

  # state.json is valid JSON
  jq -e '.' "$SDIR/state.json" > /dev/null 2>&1
  assert_equals "$h: state.json valid JSON" "0" "$?"

  # config.json is valid JSON
  jq -e '.' "$SDIR/config.json" > /dev/null 2>&1
  assert_equals "$h: config.json valid JSON" "0" "$?"

  # tasks.json is valid JSON
  jq -e '.' "$HDIR/tasks.json" > /dev/null 2>&1
  assert_equals "$h: tasks.json valid JSON" "0" "$?"

  # No progress.json (deleted in phase 3)
  [ ! -f "$HDIR/progress.json" ]
  assert_equals "$h: no progress.json" "0" "$?"
done

# ════════════════════════════════════════════════════════════════
# 17. Infrastructure files: no unbound variables
# ════════════════════════════════════════════════════════════════
echo ""
echo "── no unbound variable traps ──"

# Key infrastructure files should not reference HARNESS_SESSION_REGISTRY
for f in "$HOME/.claude-ops/lib/handoff.sh" \
         "$HOME/.claude-ops/hooks/dispatch/harness-gc.sh" \
         "$HOME/.claude-ops/hooks/gates/stop-harness-dispatch.sh"; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")
  REFS=$(grep -c 'HARNESS_SESSION_REGISTRY' "$f" 2>/dev/null; true)
  assert_equals "$fname: no HARNESS_SESSION_REGISTRY" "0" "$REFS"
done

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════

test_summary
