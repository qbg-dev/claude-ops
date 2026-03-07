#!/usr/bin/env bash
# test-event-bus.sh — Tests for the event bus library v3 (single stream, no topics).
#
# Tests:
#   1. bus_publish writes to stream with _seq
#   2. bus_read returns events and advances cursor (_seq-based)
#   3. bus_query without cursor doesn't advance consumer state
#   4. bus_ack manually advances cursor to _seq
#   5. Cursor isolation between consumers
#   6. bus_query filters by event type
#   7. Convenience aliases (bus_publish_deploy, bus_publish_announcement)
#   8. bus_query_filter uses named filters from schema
#   9. Monotonic _seq across event types (global uniqueness)
#  10. bus_query_advanced multi-filter query
#  11. bus_compact removes old events
#  12. Project-scoped bus directory resolution
#  13. Seq counter persistence
#  14. Core functions exist
#  15. bus_read --type filters by event type
set -euo pipefail

# ── Setup ────────────────────────────────────────────────────────────
TEST_BUS_DIR=$(mktemp -d)
TEST_PROJECT_DIR=$(mktemp -d)
mkdir -p "$TEST_PROJECT_DIR/.claude/bus"

export BUS_DIR="$TEST_BUS_DIR"
export EVENT_BUS_ENABLED="true"
export PROJECT_ROOT="$TEST_PROJECT_DIR"

# Copy schema.json for filter resolution
cp "$(dirname "$0")/fixtures/bus-schema.json" "$TEST_BUS_DIR/schema.json"

# Initialize seq.json
echo '{"global": 0}' > "$TEST_BUS_DIR/seq.json"

source "$HOME/.claude-ops/lib/event-bus.sh"

# Re-export after sourcing (library sets these from BUS_DIR)
BUS_STREAM="$TEST_BUS_DIR/stream.jsonl"
BUS_CURSORS_DIR="$TEST_BUS_DIR/cursors"
BUS_DLQ_DIR="$TEST_BUS_DIR/dlq"
BUS_SCHEMA="$TEST_BUS_DIR/schema.json"
BUS_SEQ_FILE="$TEST_BUS_DIR/seq.json"

PASS=0
FAIL=0
TOTAL=0

assert() {
  local desc="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_gt() {
  local desc="$1" min="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" -gt "$min" ] 2>/dev/null; then
    echo "  ✓ $desc (got $actual > $min)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    expected > $min, got: $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    expected to contain: $needle"
    echo "    actual: ${haystack:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Event Bus v3 Tests (single stream) ==="
echo "Test bus dir: $TEST_BUS_DIR"
echo ""

# ── Test 1: bus_publish writes to single stream with _seq ─────────────
echo "--- Test 1: bus_publish writes to stream with _seq ---"
bus_publish "file-edit" '{"agent":"test-agent","file":"src/main.ts","tool":"Edit"}'
sleep 0.2

assert "stream.jsonl exists" "true" "$([ -f "$BUS_STREAM" ] && echo true || echo false)"
LINE_COUNT=$(wc -l < "$BUS_STREAM" 2>/dev/null | tr -d ' ')
assert "stream has 1 line" "1" "$LINE_COUNT"
EVENT_TYPE=$(jq -r '._event_type' "$BUS_STREAM" 2>/dev/null)
assert "event type is file-edit" "file-edit" "$EVENT_TYPE"
AGENT=$(jq -r '.agent' "$BUS_STREAM" 2>/dev/null)
assert "agent is test-agent" "test-agent" "$AGENT"
HAS_TS=$(jq -r '._ts' "$BUS_STREAM" 2>/dev/null)
assert "has _ts metadata" "true" "$([ -n "$HAS_TS" ] && [ "$HAS_TS" != "null" ] && echo true || echo false)"
SEQ_VAL=$(jq -r '._seq' "$BUS_STREAM" 2>/dev/null)
assert "has _seq = 1" "1" "$SEQ_VAL"

echo ""

# ── Test 2: bus_read returns events and advances cursor (_seq-based) ──
echo "--- Test 2: bus_read returns events and advances _seq cursor ---"
bus_publish "file-edit" '{"agent":"a1","file":"f1.ts","tool":"Edit"}'
bus_publish "file-edit" '{"agent":"a2","file":"f2.ts","tool":"Write"}'
bus_publish "file-edit" '{"agent":"a3","file":"f3.ts","tool":"Edit"}'
sleep 0.2

EVENTS=$(bus_read "consumer-1" --limit 10)
COUNT=$(echo "$EVENTS" | jq 'length' 2>/dev/null || echo "0")
assert "read returns 4 events (all in stream)" "4" "$COUNT"

# Verify cursor stored as _seq value
CURSOR_VAL=$(jq -r '.seq' "$BUS_CURSORS_DIR/consumer-1.json" 2>/dev/null)
assert "cursor stores _seq value (4)" "4" "$CURSOR_VAL"

# Read again — should return empty (cursor advanced past all events)
EVENTS2=$(bus_read "consumer-1" --limit 10)
COUNT2=$(echo "$EVENTS2" | jq 'length' 2>/dev/null || echo "0")
assert "second read returns 0 (cursor advanced)" "0" "$COUNT2"

echo ""

# ── Test 3: bus_query doesn't advance consumer cursor ─────────────────
echo "--- Test 3: bus_query doesn't advance consumer cursor ---"
bus_publish "file-edit" '{"agent":"query-noadvance","file":"qa.ts","tool":"Edit"}'
sleep 0.1

# bus_query uses type+seq, not consumer cursors — verify consumer-1 cursor unchanged
CURSOR_BEFORE=$(jq -r '.seq' "$BUS_CURSORS_DIR/consumer-1.json" 2>/dev/null)
QUERY1=$(bus_query "file-edit" "$CURSOR_BEFORE")
Q_COUNT=$(echo "$QUERY1" | jq -cs '. | length' 2>/dev/null || echo "0")
assert_gt "query returns events after cursor" "0" "$Q_COUNT"

CURSOR_AFTER=$(jq -r '.seq' "$BUS_CURSORS_DIR/consumer-1.json" 2>/dev/null)
assert "cursor unchanged after query" "$CURSOR_BEFORE" "$CURSOR_AFTER"

# Now read to advance past the new event
bus_read "consumer-1" --limit 10 > /dev/null

echo ""

# ── Test 4: bus_ack manually advances cursor to _seq ─────────────────
echo "--- Test 4: bus_ack manually advances cursor to _seq ---"
bus_publish "file-edit" '{"agent":"ack-test","file":"ack1.ts","tool":"Edit"}'
bus_publish "file-edit" '{"agent":"ack-test","file":"ack2.ts","tool":"Edit"}'
sleep 0.1

# Get the max _seq from the stream
MAX_SEQ=$(jq -s '[.[]._seq] | max' "$BUS_STREAM" 2>/dev/null || echo "0")
bus_ack "consumer-ack" "$MAX_SEQ"

EVENTS_AFTER=$(bus_read "consumer-ack" --limit 10)
COUNT_AFTER=$(echo "$EVENTS_AFTER" | jq 'length' 2>/dev/null || echo "0")
assert "after ack to max _seq, read returns 0" "0" "$COUNT_AFTER"

echo ""

# ── Test 5: Cursor isolation between consumers ───────────────────────
echo "--- Test 5: Cursor isolation between consumers ---"
bus_publish "announcement" '{"from":"test","body":"hello world","priority":"normal"}'
bus_publish "announcement" '{"from":"test","body":"second msg","priority":"normal"}'
sleep 0.1

C1=$(bus_read "iso-consumer-1" --type announcement --limit 10)
C1_COUNT=$(echo "$C1" | jq 'length' 2>/dev/null || echo "0")
assert "consumer-1 sees 2 announcements" "2" "$C1_COUNT"

C2=$(bus_read "iso-consumer-2" --type announcement --limit 10)
C2_COUNT=$(echo "$C2" | jq 'length' 2>/dev/null || echo "0")
assert "consumer-2 also sees 2 (independent cursor)" "2" "$C2_COUNT"

bus_publish "announcement" '{"from":"test","body":"third msg","priority":"urgent"}'
sleep 0.1

C1_NEW=$(bus_read "iso-consumer-1" --type announcement --limit 10)
C1_NEW_COUNT=$(echo "$C1_NEW" | jq 'length' 2>/dev/null || echo "0")
assert "consumer-1 sees 1 new" "1" "$C1_NEW_COUNT"

C2_NEW=$(bus_read "iso-consumer-2" --type announcement --limit 10)
C2_NEW_COUNT=$(echo "$C2_NEW" | jq 'length' 2>/dev/null || echo "0")
assert "consumer-2 sees 1 new (independent)" "1" "$C2_NEW_COUNT"

echo ""

# ── Test 6: bus_query filters by event type ──────────────────────────
echo "--- Test 6: bus_query filters by event type ---"
ALL=$(bus_query "file-edit" | jq -cs '.')
ALL_COUNT=$(echo "$ALL" | jq 'length' 2>/dev/null || echo "0")
assert_gt "query file-edit returns events" "5" "$ALL_COUNT"

ANN_ALL=$(bus_query "announcement" | jq -cs '.')
ANN_COUNT=$(echo "$ANN_ALL" | jq 'length' 2>/dev/null || echo "0")
assert "query announcement returns 3" "3" "$ANN_COUNT"

# Query with after_seq
AFTER_SEQ=$(bus_query "file-edit" 3 | jq -cs '.')
AFTER_SEQ_COUNT=$(echo "$AFTER_SEQ" | jq 'length' 2>/dev/null || echo "0")
assert_gt "query after_seq 3 returns events after seq 3" "0" "$AFTER_SEQ_COUNT"
FIRST_SEQ=$(echo "$AFTER_SEQ" | jq '.[0]._seq' 2>/dev/null || echo "0")
assert_gt "first event after seq 3 has _seq > 3" "3" "$FIRST_SEQ"

echo ""

# ── Test 7: Convenience aliases ──────────────────────────────────────
echo "--- Test 7: Convenience aliases ---"
bus_publish_deploy "alias-agent" "static" "test"
sleep 0.1
LAST=$(tail -1 "$BUS_STREAM")
ALIAS_AGENT=$(echo "$LAST" | jq -r '.agent' 2>/dev/null)
assert "bus_publish_deploy sets agent" "alias-agent" "$ALIAS_AGENT"
ALIAS_SEQ=$(echo "$LAST" | jq -r '._seq' 2>/dev/null)
assert "alias event has _seq" "true" "$([ "$ALIAS_SEQ" -gt 0 ] 2>/dev/null && echo true || echo false)"

bus_publish_announcement "bot" "test announcement" "urgent"
sleep 0.1
ANN_LAST=$(tail -1 "$BUS_STREAM")
ANN_PRIO=$(echo "$ANN_LAST" | jq -r '.priority' 2>/dev/null)
assert "bus_publish_announcement sets priority" "urgent" "$ANN_PRIO"

echo ""

# ── Test 8: bus_query_filter uses named filters from schema ──────────
echo "--- Test 8: bus_query_filter uses named filters ---"
# Schema should have "telemetry" filter matching file-edit|tool-call|deploy|error|prompt|config-change
TELEMETRY=$(bus_query_filter "telemetry" | jq -cs '.')
T_COUNT=$(echo "$TELEMETRY" | jq 'length' 2>/dev/null || echo "0")
assert_gt "telemetry filter returns events" "5" "$T_COUNT"

# Verify all events match telemetry pattern
BAD_TYPES=$(echo "$TELEMETRY" | jq '[.[] | ._event_type] | map(select(test("file-edit|tool-call|deploy|error|prompt|config-change") | not)) | length' 2>/dev/null || echo "999")
assert "all telemetry events match filter pattern" "0" "$BAD_TYPES"

echo ""

# ── Test 9: Monotonic _seq across event types (global uniqueness) ────
echo "--- Test 9: Monotonic _seq across event types ---"
bus_publish "deploy" '{"agent":"seq-test","service":"static","target":"test"}'
sleep 0.1
DEPLOY_SEQ=$(tail -1 "$BUS_STREAM" | jq -r '._seq' 2>/dev/null)

bus_publish "file-edit" '{"agent":"seq-test","file":"seq.ts","tool":"Edit"}'
sleep 0.1
EDIT_SEQ=$(tail -1 "$BUS_STREAM" | jq -r '._seq' 2>/dev/null)

assert "deploy _seq and file-edit _seq are different" "true" "$([ "$DEPLOY_SEQ" != "$EDIT_SEQ" ] && echo true || echo false)"
assert_gt "file-edit _seq > deploy _seq (published later)" "$DEPLOY_SEQ" "$EDIT_SEQ"

# Verify seq counter file
SEQ_COUNTER=$(jq -r '.global' "$BUS_SEQ_FILE" 2>/dev/null)
assert "seq.json global matches last _seq" "$EDIT_SEQ" "$SEQ_COUNTER"

echo ""

# ── Test 10: bus_query_advanced multi-filter query ───────────────────
echo "--- Test 10: bus_query_advanced multi-filter query ---"
ALL_EVENTS=$(bus_query_advanced --after-seq 0 --limit 100)
ALL_EVENTS_COUNT=$(echo "$ALL_EVENTS" | jq 'length' 2>/dev/null || echo "0")
assert_gt "query_advanced returns events" "5" "$ALL_EVENTS_COUNT"

# Filter by --from
FROM_EVENTS=$(bus_query_advanced --from "a1")
FROM_COUNT=$(echo "$FROM_EVENTS" | jq 'length' 2>/dev/null || echo "0")
assert "query_advanced --from a1 returns 1" "1" "$FROM_COUNT"

# Filter by --type
TYPE_EVENTS=$(bus_query_advanced --type "deploy")
TYPE_COUNT=$(echo "$TYPE_EVENTS" | jq 'length' 2>/dev/null || echo "0")
assert "query_advanced --type deploy returns 2" "2" "$TYPE_COUNT"

echo ""

# ── Test 11: bus_compact removes old events ──────────────────────────
echo "--- Test 11: bus_compact removes old events ---"
# Publish 200 events (need >100 to overcome safety margin)
for i in $(seq 1 200); do
  bus_publish "tool-call" "{\"agent\":\"compact-test\",\"tool\":\"Read\",\"duration_ms\":$i}"
done
sleep 0.3

PRE_COMPACT=$(wc -l < "$BUS_STREAM" | tr -d ' ')
assert_gt "pre-compact has >200 events" "199" "$PRE_COMPACT"

# Advance ALL existing consumer cursors to a high _seq so compact can trim.
# compact uses the MINIMUM cursor across all consumers, so stale cursors from
# earlier tests would prevent any compaction.
HIGH_SEQ=$(jq -s '.[- 21]._seq' "$BUS_STREAM" 2>/dev/null || echo "0")
for cursor_file in "$BUS_CURSORS_DIR"/*.json; do
  [ -f "$cursor_file" ] || continue
  consumer_name=$(basename "$cursor_file" .json)
  _bus_set_cursor "$consumer_name" "$HIGH_SEQ"
done

# Compact — should remove events with _seq <= (HIGH_SEQ - 100)
bus_compact

POST_COMPACT=$(wc -l < "$BUS_STREAM" | tr -d ' ')
assert_gt "post-compact has fewer events than pre-compact" "0" "$((PRE_COMPACT - POST_COMPACT))"

# Verify events after cursor are preserved
REMAINING=$(jq -c --argjson seq "$HIGH_SEQ" 'select(._seq > $seq)' "$BUS_STREAM" 2>/dev/null | wc -l | tr -d ' ')
assert_gt "events after cursor still present" "0" "$REMAINING"

echo ""

# ── Test 12: Project-scoped bus directory resolution ────────────────
echo "--- Test 12: Project-scoped bus directory resolution ---"
MOCK_PROJECT=$(mktemp -d)
mkdir -p "$MOCK_PROJECT/.claude/bus"
echo '{"global":0}' > "$MOCK_PROJECT/.claude/bus/seq.json"

# Test resolution (save/restore)
OLD_BUS_DIR="$BUS_DIR"
OLD_PROJECT_ROOT="$PROJECT_ROOT"
unset BUS_DIR
export PROJECT_ROOT="$MOCK_PROJECT"
RESOLVED=$(_bus_resolve_dir)
assert "resolves to project .claude/bus" "$MOCK_PROJECT/.claude/bus" "$RESOLVED"

# Restore
export BUS_DIR="$OLD_BUS_DIR"
export PROJECT_ROOT="$OLD_PROJECT_ROOT"
rm -rf "$MOCK_PROJECT"

echo ""

# ── Test 13: Seq counter persistence ────────────────────────────────
echo "--- Test 13: Seq counter persistence ---"
SEQ_BEFORE=$(jq -r '.global' "$BUS_SEQ_FILE")
bus_publish "file-edit" '{"agent":"persist-test","file":"p.ts","tool":"Edit"}'
sleep 0.1
SEQ_AFTER=$(jq -r '.global' "$BUS_SEQ_FILE")
assert "seq counter incremented by 1" "$((SEQ_BEFORE + 1))" "$SEQ_AFTER"

echo ""

# ── Test 14: Core functions exist ───────────────────────────────────
echo "--- Test 14: Core functions exist ---"
assert "bus_git_checkpoint is a function" "true" "$(type bus_git_checkpoint 2>/dev/null | head -1 | grep -q 'function' && echo true || echo false)"
assert "bus_compact is a function" "true" "$(type bus_compact 2>/dev/null | head -1 | grep -q 'function' && echo true || echo false)"
assert "bus_query_filter is a function" "true" "$(type bus_query_filter 2>/dev/null | head -1 | grep -q 'function' && echo true || echo false)"
assert "bus_query_advanced is a function" "true" "$(type bus_query_advanced 2>/dev/null | head -1 | grep -q 'function' && echo true || echo false)"
assert "bus_subscribe is a function" "true" "$(type bus_subscribe 2>/dev/null | head -1 | grep -q 'function' && echo true || echo false)"

echo ""

# ── Test 15: bus_read --type filters by event type ──────────────────
echo "--- Test 15: bus_read --type filters by event type ---"
# Create a fresh consumer
bus_publish "file-edit" '{"agent":"type-test","file":"x.ts","tool":"Edit"}'
bus_publish "deploy" '{"agent":"type-test","service":"web","target":"test"}'
bus_publish "file-edit" '{"agent":"type-test","file":"y.ts","tool":"Write"}'
sleep 0.1

# Read only file-edit events with a fresh consumer
TYPED=$(bus_read "type-filter-consumer" --type "file-edit" --limit 100)
TYPED_COUNT=$(echo "$TYPED" | jq 'length' 2>/dev/null || echo "0")
assert_gt "type-filtered read returns file-edit events" "0" "$TYPED_COUNT"

# Verify no deploy events leaked through
DEPLOY_IN_TYPED=$(echo "$TYPED" | jq '[.[] | select(._event_type == "deploy")] | length' 2>/dev/null || echo "0")
assert "no deploy events in file-edit filter" "0" "$DEPLOY_IN_TYPED"

echo ""

# ── Cleanup ──────────────────────────────────────────────────────────
rm -rf "$TEST_BUS_DIR" "$TEST_PROJECT_DIR"

echo ""
echo -e "  $PASS passed, $FAIL failed, $TOTAL total"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
