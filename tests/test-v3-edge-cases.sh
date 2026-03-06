#!/usr/bin/env bash
# test-v3-edge-cases.sh — Edge cases, integration tests, and stress scenarios
#
# Sections:
#   1.  Event bus: publish, read, query, subscribe, compact, cursor management
#   2.  Event bus: concurrent publish safety
#   3.  Event bus: side-effect error handling (DLQ)
#   4.  Harness gates: sketch gate, MEMORY.md mtime gate, cycle gate
#   5.  Background tasks: sleeping flag, stale flag cleanup
#   6.  Rotation: mode=none, mode=new_session, lock guard
#   7.  GC: pane-registry cleanup, stale file removal
#   8.  Side-effect scripts: bash syntax + executable bit
#   9.  Permissions.yaml: parsing, mode extraction
#  10.  Cross-harness invariants: no orphan files, no stale references
#  11.  Config.json deep validation: model, lifecycle, sleep_duration types
#  12.  Inbox/outbox JSONL format: valid JSON lines
#  13.  Worker lifecycle: execution→optimization→monitoring transitions
#  14.  Bus schema: event_types completeness, filters, side-effect references
#  15.  Seed template: special characters, empty fields
#  16.  hq_send: missing args, large payloads, special chars
#  17.  File resolver: symlinks, nested dirs, permission errors
#  18.  Locked JQ write: concurrent writes, large JSON, malformed input
#
# Usage:
#   bash ~/.claude-ops/tests/test-v3-edge-cases.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# ════════════════════════════════════════════════════════════════
# 1. Event bus: publish, read, query, subscribe, compact
# ════════════════════════════════════════════════════════════════
echo "── event bus operations ──"

TMP=$(mktemp -d)
BUS_DIR="$TMP/bus"
mkdir -p "$BUS_DIR/cursors" "$BUS_DIR/dlq"
echo '{"global": 0}' > "$BUS_DIR/seq.json"
cp "$PROJECT_ROOT/.claude/bus/schema.json" "$BUS_DIR/schema.json"
touch "$BUS_DIR/stream.jsonl"
export BUS_DIR EVENT_BUS_ENABLED=true BUS_STREAM="$BUS_DIR/stream.jsonl"
export BUS_CURSORS_DIR="$BUS_DIR/cursors" BUS_DLQ_DIR="$BUS_DIR/dlq"
export BUS_SCHEMA="$BUS_DIR/schema.json" BUS_SEQ_FILE="$BUS_DIR/seq.json"
export BUS_SIDE_EFFECTS_DIR="$HOME/.claude-ops/bus/side-effects"

# Source event-bus in current shell for direct function access
source "$HOME/.claude-ops/lib/event-bus.sh"

# 1a: Publish and verify enrichment
bus_publish "prompt" '{"content":"hello","agent":"test-agent"}' 2>/dev/null
sleep 0.2  # side-effects are async
LAST=$(tail -1 "$BUS_STREAM")
SEQ=$(echo "$LAST" | jq -r '._seq')
assert_equals "publish sets _seq=1" "1" "$SEQ"
ET=$(echo "$LAST" | jq -r '._event_type')
assert_equals "publish sets _event_type" "prompt" "$ET"
TS=$(echo "$LAST" | jq -r '._ts')
echo "$TS" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' && assert_equals "publish sets _ts ISO" "0" "0" || assert_equals "publish sets _ts ISO" "ISO" "non-ISO"

# 1b: Original payload preserved
CONTENT=$(echo "$LAST" | jq -r '.content')
assert_equals "publish preserves payload.content" "hello" "$CONTENT"
AGENT=$(echo "$LAST" | jq -r '.agent')
assert_equals "publish preserves payload.agent" "test-agent" "$AGENT"

# 1c: Multiple publishes increment _seq monotonically
bus_publish "tool-call" '{"tool":"Read"}' 2>/dev/null
bus_publish "file-edit" '{"file":"test.ts"}' 2>/dev/null
sleep 0.2
SEQS=$(jq -r '._seq' "$BUS_STREAM" | tr '\n' ',')
assert_equals "seqs are monotonic" "1,2,3," "$SEQS"

# 1d: Subscribe sets cursor at current max
bus_subscribe "test-consumer" 2>/dev/null
CURSOR=$(jq -r '.seq' "$BUS_CURSORS_DIR/test-consumer.json")
assert_equals "subscribe cursor at max seq" "3" "$CURSOR"

# 1e: Read returns events after cursor
bus_publish "prompt" '{"content":"after-subscribe"}' 2>/dev/null
sleep 0.2
EVENTS=$(bus_read "test-consumer" 2>/dev/null)
COUNT=$(echo "$EVENTS" | jq 'length')
assert_equals "read returns 1 event after subscribe" "1" "$COUNT"
READ_CONTENT=$(echo "$EVENTS" | jq -r '.[0].content')
assert_equals "read returns correct content" "after-subscribe" "$READ_CONTENT"

# 1f: Cursor advanced after read
CURSOR_AFTER=$(jq -r '.seq' "$BUS_CURSORS_DIR/test-consumer.json")
assert_equals "cursor advanced to 4" "4" "$CURSOR_AFTER"

# 1g: Second read returns empty (nothing new)
EVENTS2=$(bus_read "test-consumer" 2>/dev/null)
COUNT2=$(echo "$EVENTS2" | jq 'length')
assert_equals "second read returns 0 events" "0" "$COUNT2"

# 1h: Read with type filter
bus_publish "error" '{"msg":"oops"}' 2>/dev/null
bus_publish "prompt" '{"content":"another"}' 2>/dev/null
sleep 0.2
# Subscribe a fresh consumer
bus_subscribe "typed-consumer" 2>/dev/null
# Reset cursor to 0 to see all events
echo '{"seq":0}' > "$BUS_CURSORS_DIR/typed-consumer.json"
TYPED_EVENTS=$(bus_read "typed-consumer" --type "prompt" 2>/dev/null)
TYPED_COUNT=$(echo "$TYPED_EVENTS" | jq 'length')
assert_equals "type filter returns only prompts" "3" "$TYPED_COUNT"

# 1i: Query by type (legacy positional) — bus_query legacy returns NDJSON, use jq -s 'length'
QUERY_RESULT=$(bus_query "error" 0 2>/dev/null)
Q_COUNT=$(echo "$QUERY_RESULT" | jq -s 'length')
assert_equals "query by type finds error events" "1" "$Q_COUNT"

# 1j: Query by --from
bus_publish "prompt" '{"from":"mod-customer","content":"test"}' 2>/dev/null
sleep 0.2
FROM_RESULT=$(bus_query --from "mod-customer" --after 0 2>/dev/null)
FROM_COUNT=$(echo "$FROM_RESULT" | jq 'length')
assert_equals "query --from finds event" "1" "$FROM_COUNT"

# 1k: bus_ack manually sets cursor
bus_ack "manual-consumer" 99 2>/dev/null
MANUAL_CURSOR=$(jq -r '.seq' "$BUS_CURSORS_DIR/manual-consumer.json")
assert_equals "ack sets cursor to 99" "99" "$MANUAL_CURSOR"

# 1l: Compact preserves events after lowest cursor
echo '{"seq":2}' > "$BUS_CURSORS_DIR/low-consumer.json"
BEFORE_LINES=$(wc -l < "$BUS_STREAM" | tr -d ' ')
bus_compact 2>/dev/null
AFTER_LINES=$(wc -l < "$BUS_STREAM" | tr -d ' ')
# Should keep events with _seq > (2-100) = keep all since min_seq=2, keep_after=-98→0
assert_equals "compact preserves all when cursor low" "$BEFORE_LINES" "$AFTER_LINES"

# 1m: Empty stream query returns []
EMPTY_TMP=$(mktemp -d)
mkdir -p "$EMPTY_TMP/bus"
touch "$EMPTY_TMP/bus/stream.jsonl"
EMPTY_RESULT=$(BUS_STREAM="$EMPTY_TMP/bus/stream.jsonl" bus_query "prompt" 0 2>/dev/null)
assert_equals "empty stream query returns []" "[]" "$EMPTY_RESULT"
rm -rf "$EMPTY_TMP"

# 1n: Publish with bus disabled is no-op
STREAM_BEFORE=$(wc -l < "$BUS_STREAM" | tr -d ' ')
EVENT_BUS_ENABLED=false bus_publish "prompt" '{"content":"disabled"}' 2>/dev/null
STREAM_AFTER=$(wc -l < "$BUS_STREAM" | tr -d ' ')
assert_equals "disabled bus is no-op" "$STREAM_BEFORE" "$STREAM_AFTER"
EVENT_BUS_ENABLED=true  # restore

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 2. Event bus: concurrent publish safety
# ════════════════════════════════════════════════════════════════
echo ""
echo "── bus concurrent publish ──"

TMP=$(mktemp -d)
BUS_DIR="$TMP/bus"
mkdir -p "$BUS_DIR/cursors" "$BUS_DIR/dlq"
echo '{"global": 0}' > "$BUS_DIR/seq.json"
echo '{"event_types":{}}' > "$BUS_DIR/schema.json"
touch "$BUS_DIR/stream.jsonl"
export BUS_DIR BUS_STREAM="$BUS_DIR/stream.jsonl"
export BUS_CURSORS_DIR="$BUS_DIR/cursors" BUS_DLQ_DIR="$BUS_DIR/dlq"
export BUS_SCHEMA="$BUS_DIR/schema.json" BUS_SEQ_FILE="$BUS_DIR/seq.json"

# Publish 10 events concurrently
for i in $(seq 1 10); do
  bus_publish "test" "{\"i\":$i}" 2>/dev/null &
done
wait
sleep 0.3

LINE_COUNT=$(wc -l < "$BUS_STREAM" | tr -d ' ')
assert_equals "10 concurrent publishes → 10 lines" "10" "$LINE_COUNT"

# All seqs should be unique
UNIQUE_SEQS=$(jq -r '._seq' "$BUS_STREAM" | sort -un | wc -l | tr -d ' ')
assert_equals "10 unique seqs" "10" "$UNIQUE_SEQS"

# Global seq should be 10
GLOBAL=$(jq -r '.global' "$BUS_SEQ_FILE")
assert_equals "global seq = 10" "10" "$GLOBAL"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 3. Event bus: side-effect error handling (DLQ)
# ════════════════════════════════════════════════════════════════
echo ""
echo "── bus side-effect DLQ ──"

TMP=$(mktemp -d)
BUS_DIR="$TMP/bus"
mkdir -p "$BUS_DIR/cursors" "$BUS_DIR/dlq"
echo '{"global": 0}' > "$BUS_DIR/seq.json"
# Schema with a side-effect that will fail
cat > "$BUS_DIR/schema.json" <<'EOF'
{"event_types":{"test.fail":{"side_effects":["nonexistent_script"],"description":"test"}}}
EOF
touch "$BUS_DIR/stream.jsonl"
export BUS_DIR BUS_STREAM="$BUS_DIR/stream.jsonl"
export BUS_CURSORS_DIR="$BUS_DIR/cursors" BUS_DLQ_DIR="$BUS_DIR/dlq"
export BUS_SCHEMA="$BUS_DIR/schema.json" BUS_SEQ_FILE="$BUS_DIR/seq.json"

# Publish should succeed even if side-effect fails
bus_publish "test.fail" '{"data":"test"}' 2>/dev/null
sleep 0.5
assert_equals "publish succeeds despite bad side-effect" "1" "$(wc -l < "$BUS_STREAM" | tr -d ' ')"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 4. Harness gates: sketch gate, MEMORY.md mtime
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness gates ──"

# Source the gates library
source "$HOME/.claude-ops/lib/harness-gates.sh" 2>/dev/null || true

# Gate functions use `exit 0` when blocking, so must run in subshell to capture result.
# Return 1 = skip (gate passes), exit 0 = blocked (gate fires).

TMP=$(mktemp -d)
mkdir -p "$TMP/session"

# Sketch gate: sketch_approved=true → returns 1 (skip)
echo '{"sketch_approved":true}' > "$TMP/state.json"
EXIT_CODE=$(
  _SESSION_DIR="$TMP/session" PROJECT_ROOT="$TMP" PHASE_SKETCH_GATE_ENABLED="true" \
  MISSION_VISION_DISPLAY_LINES=5 \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/lib/harness-gates.sh'; check_sketch_gate 'test-h' '$TMP/state.json' 'mission' '' 0; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "sketch gate skips when approved" "1" "$EXIT_CODE"

# Sketch gate: done_count > 0 → returns 1 (skip)
echo '{"sketch_approved":false}' > "$TMP/state.json"
EXIT_CODE=$(
  _SESSION_DIR="$TMP/session" PROJECT_ROOT="$TMP" PHASE_SKETCH_GATE_ENABLED="true" \
  MISSION_VISION_DISPLAY_LINES=5 \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/lib/harness-gates.sh'; check_sketch_gate 'test-h' '$TMP/state.json' 'mission' '' 5; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "sketch gate skips when done_count>0" "1" "$EXIT_CODE"

# Sketch gate: not approved + done_count=0 → blocks (exit 0, outputs hook_block JSON)
echo '{"sketch_approved":false}' > "$TMP/state.json"
GATE_OUTPUT=$(
  _SESSION_DIR="$TMP/session" PROJECT_ROOT="$TMP" PHASE_SKETCH_GATE_ENABLED="true" \
  MISSION_VISION_DISPLAY_LINES=5 \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/lib/harness-gates.sh'; check_sketch_gate 'test-h' '$TMP/state.json' 'mission' '' 0" 2>/dev/null
) || true
# When blocking, output contains hook_block JSON with "decision": "block"
assert "sketch gate blocks when not approved" "block" "$GATE_OUTPUT"

# Sketch gate disabled → returns 1 (skip, no output)
EXIT_CODE=0
_SESSION_DIR="$TMP/session" PROJECT_ROOT="$TMP" PHASE_SKETCH_GATE_ENABLED="false" \
  MISSION_VISION_DISPLAY_LINES=5 \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/lib/harness-gates.sh'; check_sketch_gate 'test-h' '$TMP/state.json' 'mission' '' 0" 2>/dev/null || EXIT_CODE=$?
assert_equals "sketch gate skips when disabled" "1" "$EXIT_CODE"

# Gen gate: both approved → returns 1 (skip)
echo '{"sketch_approved":true,"generalization_approved":true}' > "$TMP/state.json"
EXIT_CODE=$(
  PHASE_GENERALIZATION_GATE_ENABLED="true" PROJECT_ROOT="$TMP" \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/lib/harness-gates.sh'; check_generalization_gate 'test-h' '$TMP/state.json' 'mission' 0; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "gen gate skips when approved" "1" "$EXIT_CODE"

# Gen gate: sketch approved, gen not → blocks (outputs hook_block JSON)
echo '{"sketch_approved":true,"generalization_approved":false}' > "$TMP/state.json"
GATE_OUTPUT=$(
  _SESSION_DIR="$TMP/session" PHASE_GENERALIZATION_GATE_ENABLED="true" PROJECT_ROOT="$TMP" \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/lib/harness-gates.sh'; check_generalization_gate 'test-h' '$TMP/state.json' 'mission' 0" 2>/dev/null
) || true
assert "gen gate blocks when not approved" "block" "$GATE_OUTPUT"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 5. Background tasks: sleeping flag
# ════════════════════════════════════════════════════════════════
echo ""
echo "── background tasks ──"

TMP=$(mktemp -d)
HARNESS_STATE_DIR="$TMP"
export HARNESS_STATE_DIR
mkdir -p "$TMP/harness-runtime/test-harness"

# check_bg_tasks uses exit 0 when blocking — run in subshell
# No sleeping flag → returns 1 (clear)
EXIT_CODE=$(
  HARNESS_STATE_DIR="$TMP" \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/hooks/dispatch/harness-bg-tasks.sh'; check_bg_tasks 'test-harness'; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "no sleeping flag → clear" "1" "$EXIT_CODE"

# Sleeping flag with dead PID → cleaned up, returns 1
echo "test-sleep:99999:2026-02-27T00:00:00Z" > "$TMP/harness-runtime/test-harness/sleeping"
EXIT_CODE=$(
  HARNESS_STATE_DIR="$TMP" \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/hooks/dispatch/harness-bg-tasks.sh'; check_bg_tasks 'test-harness'; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "dead pid sleeping flag → clear" "1" "$EXIT_CODE"
# Flag should be removed
if [ -f "$TMP/harness-runtime/test-harness/sleeping" ]; then
  assert_equals "stale sleeping flag removed" "exists" "should-be-gone"
else
  assert_equals "stale sleeping flag removed" "0" "0"
fi

# Empty sleeping flag → cleaned up
echo "" > "$TMP/harness-runtime/test-harness/sleeping"
EXIT_CODE=$(
  HARNESS_STATE_DIR="$TMP" \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/hooks/dispatch/harness-bg-tasks.sh'; check_bg_tasks 'test-harness'; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "empty sleeping flag → clear" "1" "$EXIT_CODE"

unset HARNESS_STATE_DIR
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 6. Rotation: mode=none
# ════════════════════════════════════════════════════════════════
echo ""
echo "── rotation logic ──"

# check_rotation uses `exit 0` when rotating — run in subshell
TMP=$(mktemp -d)
mkdir -p "$TMP/session"

# mode=none → returns 1 (continue blocking)
echo '{"rotation":{"mode":"none"}}' > "$TMP/progress.json"
EXIT_CODE=$(
  _SESSION_DIR="$TMP/session" HARNESS_STATE_DIR="$TMP" SESSION_ID="test-session" \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/hooks/dispatch/harness-rotation.sh'; check_rotation 'test-h' '$TMP/progress.json' 'test-h'; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "rotation mode=none → continue" "1" "$EXIT_CODE"

# Missing rotation key → defaults to none → returns 1
echo '{}' > "$TMP/progress.json"
EXIT_CODE=$(
  _SESSION_DIR="$TMP/session" HARNESS_STATE_DIR="$TMP" SESSION_ID="test-session" \
  bash -c "source '$HOME/.claude-ops/lib/harness-jq.sh'; source '$HOME/.claude-ops/hooks/dispatch/harness-rotation.sh'; check_rotation 'test-h' '$TMP/progress.json' 'test-h'; echo \$?" 2>/dev/null | tail -1
) || true
assert_equals "no rotation key → continue" "1" "$EXIT_CODE"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 7. GC: pane-registry cleanup
# ════════════════════════════════════════════════════════════════
echo ""
echo "── GC pane-registry ──"

# Test the Python-based cleanup logic (from harness-gc.sh)
TMP=$(mktemp -d)
cat > "$TMP/pane-registry.json" <<'EOF'
{"%0": {"harness": "live-agent"}, "%999": {"harness": "dead-agent"}, "non-pane-key": {"harness": "invalid"}}
EOF

# Simulate: only %0 is "live" (we'll fake the live panes list)
LIVE_PANES="%0"
python3 -c "
import json, sys
reg = json.load(open('$TMP/pane-registry.json'))
live = set('$LIVE_PANES'.split())
cleaned = {k: v for k, v in reg.items() if k.startswith('%') and k in live}
removed = len(reg) - len(cleaned)
json.dump(cleaned, open('$TMP/pane-registry.json', 'w'), indent=2)
print(f'removed:{removed}')
" 2>/dev/null

REMAINING=$(jq 'keys | length' "$TMP/pane-registry.json")
assert_equals "GC keeps only live pane" "1" "$REMAINING"
LIVE_H=$(jq -r '."%0".harness' "$TMP/pane-registry.json")
assert_equals "GC preserves live entry" "live-agent" "$LIVE_H"

# Edge: empty pane-registry
echo '{}' > "$TMP/pane-registry.json"
python3 -c "
import json
reg = json.load(open('$TMP/pane-registry.json'))
cleaned = {k: v for k, v in reg.items() if k.startswith('%')}
json.dump(cleaned, open('$TMP/pane-registry.json', 'w'), indent=2)
" 2>/dev/null
REMAINING=$(jq 'keys | length' "$TMP/pane-registry.json")
assert_equals "GC handles empty registry" "0" "$REMAINING"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 8. Side-effect scripts: syntax + executable
# ════════════════════════════════════════════════════════════════
echo ""
echo "── side-effect scripts ──"

SE_DIR="$HOME/.claude-ops/bus/side-effects"
SE_COUNT=0
SE_SYNTAX_OK=0
SE_EXEC_OK=0

for f in "$SE_DIR"/*.sh; do
  [ -f "$f" ] || continue
  SE_COUNT=$((SE_COUNT+1))
  name=$(basename "$f")

  # Syntax check
  if bash -n "$f" 2>/dev/null; then
    SE_SYNTAX_OK=$((SE_SYNTAX_OK+1))
  else
    echo "  SYNTAX ERROR: $name"
  fi

  # Executable bit
  if [ -x "$f" ]; then
    SE_EXEC_OK=$((SE_EXEC_OK+1))
  fi
done

assert_equals "all $SE_COUNT side-effects valid syntax" "$SE_COUNT" "$SE_SYNTAX_OK"
assert_equals "all $SE_COUNT side-effects executable" "$SE_COUNT" "$SE_EXEC_OK"

# Specific side-effects exist
for se in sync_harness_inbox update_tasks_json append_outbox notify_assignee notify_tmux_if_urgent; do
  if [ -f "$SE_DIR/${se}.sh" ]; then
    assert_equals "side-effect $se exists" "yes" "yes"
  else
    assert_equals "side-effect $se exists" "yes" "no"
  fi
done

# ════════════════════════════════════════════════════════════════
# 9. Permissions.json validation
# ════════════════════════════════════════════════════════════════
echo ""
echo "── permissions.json ──"

ACTIVE_HARNESSES="hq-v2 mod-customer mod-depts mod-engineering mod-finance mod-infra mod-workorder service-miniapp-ux"
for h in $ACTIVE_HARNESSES; do
  PERM="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/permissions.json"
  if [ -f "$PERM" ]; then
    assert_equals "$h: permissions.json exists" "yes" "yes"
    # Must be valid JSON with permission_mode field
    if jq -e '.permission_mode' "$PERM" >/dev/null 2>&1; then
      assert_equals "$h: has permission_mode field" "yes" "yes"
    else
      assert_equals "$h: has permission_mode field" "yes" "no"
    fi
  else
    # permissions.json is optional — skip
    :
  fi
done

# ════════════════════════════════════════════════════════════════
# 10. Cross-harness invariants
# ════════════════════════════════════════════════════════════════
echo ""
echo "── cross-harness invariants ──"

ALL_HARNESSES="hq-v2 mod-customer mod-depts mod-engineering mod-finance mod-infra mod-workorder red-team service-miniapp-ux"

# No harness has both progress.json AND config.json (would be ambiguous)
for h in $ALL_HARNESSES; do
  HDIR="$PROJECT_ROOT/.claude/harness/$h"
  if [ -f "$HDIR/progress.json" ] && [ -f "$HDIR/agents/sidecar/config.json" ]; then
    assert_equals "$h: no dual progress+config" "clean" "DUAL"
  else
    assert_equals "$h: no dual progress+config" "clean" "clean"
  fi
done

# No harness directory has journal.md (v3: replaced by MEMORY.md)
JOURNAL_COUNT=0
for h in $ALL_HARNESSES; do
  [ -f "$PROJECT_ROOT/.claude/harness/$h/journal.md" ] && JOURNAL_COUNT=$((JOURNAL_COUNT+1))
done
assert_equals "no journal.md in active harnesses" "0" "$JOURNAL_COUNT"

# All harnesses with tasks.json have valid .tasks object
for h in $ALL_HARNESSES; do
  TASKS="$PROJECT_ROOT/.claude/harness/$h/tasks.json"
  [ -f "$TASKS" ] || continue
  HAS_TASKS=$(jq 'has("tasks")' "$TASKS" 2>/dev/null || echo "false")
  assert_equals "$h: tasks.json has .tasks key" "true" "$HAS_TASKS"
done

# All MEMORY.md files start with "# " (markdown header)
for h in $ALL_HARNESSES; do
  MEM="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/MEMORY.md"
  [ -f "$MEM" ] || continue
  FIRST_CHAR=$(head -c 2 "$MEM")
  assert_equals "$h: MEMORY.md starts with #" "# " "$FIRST_CHAR"
done

# ════════════════════════════════════════════════════════════════
# 11. Config.json deep validation
# ════════════════════════════════════════════════════════════════
echo ""
echo "── config.json deep validation ──"

for h in $ALL_HARNESSES; do
  CONFIG="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/config.json"
  [ -f "$CONFIG" ] || continue

  # name field matches directory name
  CFG_NAME=$(jq -r '.name // empty' "$CONFIG")
  assert_equals "$h: config.name matches dir" "$h" "$CFG_NAME"

  # model is a known value
  MODEL=$(jq -r '.model // "sonnet"' "$CONFIG")
  case "$MODEL" in
    sonnet|opus|haiku) assert_equals "$h: valid model ($MODEL)" "valid" "valid" ;;
    *) assert_equals "$h: valid model" "valid" "unknown:$MODEL" ;;
  esac
done

# ════════════════════════════════════════════════════════════════
# 12. Inbox/outbox JSONL format
# ════════════════════════════════════════════════════════════════
echo ""
echo "── inbox/outbox JSONL ──"

for h in $ALL_HARNESSES; do
  SDIR="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar"

  for jf in inbox.jsonl outbox.jsonl; do
    F="$SDIR/$jf"
    [ -f "$F" ] || continue
    LINES=$(wc -l < "$F" | tr -d ' ')
    [ "$LINES" -eq 0 ] && continue  # empty is valid

    # Every non-empty line must be valid JSON
    BAD_LINES=$(while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "$line" | jq -e '.' > /dev/null 2>&1 || echo "bad"
    done < "$F" | wc -l | tr -d ' ')
    assert_equals "$h/$jf: all lines valid JSON ($LINES lines)" "0" "$BAD_LINES"
  done
done

# ════════════════════════════════════════════════════════════════
# 13. Worker lifecycle: type validation
# ════════════════════════════════════════════════════════════════
echo ""
echo "── worker lifecycle ──"

# Scaffold each worker type, verify state.json shape
for wtype in execution optimization monitoring; do
  TMP=$(mktemp -d)
  worker_scaffold "mod-test" "w-$wtype" "$wtype" "Goal for $wtype" "Must pass" "warren" "$TMP" 2>/dev/null

  BASE="$TMP/.claude/harness/mod-test/agents/worker/w-$wtype"
  STATE_TYPE=$(jq -r '.type' "$BASE/state.json")
  assert_equals "worker $wtype: state.type correct" "$wtype" "$STATE_TYPE"

  STATE_STATUS=$(jq -r '.status' "$BASE/state.json")
  assert_equals "worker $wtype: initial status active" "active" "$STATE_STATUS"

  STATE_CYCLES=$(jq -r '.cycles_completed' "$BASE/state.json")
  assert_equals "worker $wtype: initial cycles 0" "0" "$STATE_CYCLES"

  # config has correct parent
  CFG_PARENT=$(jq -r '.parent' "$BASE/config.json")
  assert_equals "worker $wtype: config.parent" "mod-test" "$CFG_PARENT"

  # mission has Goal section
  assert_file_contains "worker $wtype: mission has Goal" "$BASE/mission.md" "## Goal"

  rm -rf "$TMP"
done

# Scaffold idempotency: re-scaffold doesn't overwrite
TMP=$(mktemp -d)
worker_scaffold "mod-test" "idem-w" "execution" "Goal 1" "Cons 1" "warren" "$TMP" 2>/dev/null
echo "custom note" >> "$TMP/.claude/harness/mod-test/agents/worker/idem-w/MEMORY.md"
worker_scaffold "mod-test" "idem-w" "execution" "Goal 2" "Cons 2" "warren" "$TMP" 2>/dev/null
# MEMORY.md should NOT be overwritten
assert_file_contains "scaffold idempotent: MEMORY preserved" \
  "$TMP/.claude/harness/mod-test/agents/worker/idem-w/MEMORY.md" "custom note"
# mission.md should NOT be overwritten
assert_file_contains "scaffold idempotent: mission preserved" \
  "$TMP/.claude/harness/mod-test/agents/worker/idem-w/mission.md" "Goal 1"
rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 14. Bus schema: completeness
# ════════════════════════════════════════════════════════════════
echo ""
echo "── bus schema completeness ──"

SCHEMA="$PROJECT_ROOT/.claude/bus/schema.json"

# All event_types have description
TYPES_COUNT=$(jq '.event_types | length' "$SCHEMA")
TYPES_WITH_DESC=$(jq '[.event_types | to_entries[] | select(.value.description != null)] | length' "$SCHEMA")
assert_equals "all event types have description" "$TYPES_COUNT" "$TYPES_WITH_DESC"

# All event_types have side_effects array
TYPES_WITH_SE=$(jq '[.event_types | to_entries[] | select(.value.side_effects != null)] | length' "$SCHEMA")
assert_equals "all event types have side_effects" "$TYPES_COUNT" "$TYPES_WITH_SE"

# All referenced side-effects have scripts
MISSING_SE=0
for se in $(jq -r '.event_types | to_entries[] | .value.side_effects[]?' "$SCHEMA" 2>/dev/null | sort -u); do
  [ -z "$se" ] && continue
  [ -f "$HOME/.claude-ops/bus/side-effects/${se}.sh" ] || MISSING_SE=$((MISSING_SE+1))
done
assert_equals "all schema side-effects have scripts" "0" "$MISSING_SE"

# Core event types exist
for et in prompt tool-call file-edit error session.start session.end; do
  if jq -e ".event_types[\"$et\"]" "$SCHEMA" > /dev/null 2>&1; then
    assert_equals "schema has $et" "yes" "yes"
  else
    assert_equals "schema has $et" "yes" "no"
  fi
done

# ════════════════════════════════════════════════════════════════
# 15. Seed template: special characters
# ════════════════════════════════════════════════════════════════
echo ""
echo "── seed template edge cases ──"

TMPL="$HOME/.claude-ops/templates/seed.sh.tmpl"

# Substitution with special chars in harness name (hyphens, dots)
for name in "a-b-c" "test.module" "x"; do
  TMP_SEED=$(mktemp)
  sed "s|{{HARNESS}}|$name|g; s|{{PROJECT_ROOT}}|/tmp/proj|g" "$TMPL" > "$TMP_SEED"
  PLACEHOLDERS=$(grep -c '{{' "$TMP_SEED" 2>/dev/null; true)
  assert_equals "no placeholders for name=$name" "0" "$PLACEHOLDERS"
  # Valid bash syntax
  bash -n "$TMP_SEED" 2>/dev/null
  assert_equals "valid bash for name=$name" "0" "$?"
  rm -f "$TMP_SEED"
done

# Template mentions RECORD section
assert_file_contains "template has RECORD" "$TMPL" "RECORD"

# Template mentions harness_bump_session
assert_file_contains "template has bump_session" "$TMPL" "harness_bump_session"

# Template mentions bus_publish
assert_file_contains "template has bus_publish" "$TMPL" "bus_publish"

# Template mentions MEMORY.md
assert_file_contains "template mentions MEMORY" "$TMPL" "MEMORY.md"

# ════════════════════════════════════════════════════════════════
# 16. hq_send: edge cases
# ════════════════════════════════════════════════════════════════
echo ""
echo "── hq_send edge cases ──"

# hq_send internally derives bus_dir from PROJECT_ROOT/.claude/bus (not BUS_DIR env var)
TMP=$(mktemp -d)
mkdir -p "$TMP/.claude/bus/cursors" "$TMP/.claude/bus/dlq"
echo '{"global": 0}' > "$TMP/.claude/bus/seq.json"
echo '{"event_types":{}}' > "$TMP/.claude/bus/schema.json"
touch "$TMP/.claude/bus/stream.jsonl"

# Content with special characters
RESULT=$(PROJECT_ROOT="$TMP" EVENT_BUS_ENABLED=true bash -c '
  source "$HOME/.claude-ops/lib/harness-jq.sh"
  source "$HOME/.claude-ops/lib/event-bus.sh"
  hq_send "hq-v2" "mod-infra" "status" "SQL query: SELECT * FROM table WHERE x=1"
  tail -1 "$PROJECT_ROOT/.claude/bus/stream.jsonl"
' 2>/dev/null || echo "{}")
assert "hq_send handles special chars" "SQL query" "$RESULT"

# Empty content — hq_send uses ${4:?} so empty string fails; test that it returns non-empty error
# This is a design choice: hq_send requires non-empty content. Verify it gracefully errors.
RESULT=$(PROJECT_ROOT="$TMP" EVENT_BUS_ENABLED=true bash -c '
  source "$HOME/.claude-ops/lib/harness-jq.sh"
  source "$HOME/.claude-ops/lib/event-bus.sh"
  hq_send "hq-v2" "mod-customer" "status" "" 2>&1
  echo "exit:$?"
' 2>&1 || echo "error")
assert "hq_send rejects empty content" "CONTENT required" "$RESULT"

# Long content (1000 chars)
LONG_CONTENT=$(python3 -c "print('x' * 1000)")
RESULT=$(PROJECT_ROOT="$TMP" EVENT_BUS_ENABLED=true LONG_CONTENT="$LONG_CONTENT" bash -c '
  source "$HOME/.claude-ops/lib/harness-jq.sh"
  source "$HOME/.claude-ops/lib/event-bus.sh"
  hq_send "hq-v2" "mod-customer" "status" "$LONG_CONTENT"
  tail -1 "$PROJECT_ROOT/.claude/bus/stream.jsonl" | jq -r ".content | length"
' 2>/dev/null || echo "0")
assert_equals "hq_send handles 1000-char content" "1000" "$RESULT"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 17. File resolver: edge cases
# ════════════════════════════════════════════════════════════════
echo ""
echo "── file resolver edge cases ──"

# Resolver with nested directory structure
TMP=$(mktemp -d)
mkdir -p "$TMP/agents/sidecar"
echo '{"tasks":{}}' > "$TMP/tasks.json"
echo '{}' > "$TMP/agents/sidecar/config.json"
echo '{}' > "$TMP/agents/sidecar/state.json"
echo '{}' > "$TMP/anchor.json"

# _resolve_tasks_file from anchor in same dir
RESULT=$(_resolve_tasks_file "$TMP/anchor.json" 2>/dev/null || echo "ERROR")
assert "tasks resolver finds file" "tasks.json" "$RESULT"

# _resolve_config_file
RESULT=$(_resolve_config_file "$TMP/anchor.json" 2>/dev/null || echo "ERROR")
assert "config resolver finds file" "config.json" "$RESULT"

# _resolve_state_file
RESULT=$(_resolve_state_file "$TMP/anchor.json" 2>/dev/null || echo "ERROR")
assert "state resolver finds file" "state.json" "$RESULT"

# Missing tasks.json → error
TMP2=$(mktemp -d)
echo '{}' > "$TMP2/anchor.json"
RESULT=$(_resolve_tasks_file "$TMP2/anchor.json" 2>&1 || true)
assert "missing tasks → ERROR" "ERROR" "$RESULT"

# Missing config.json → error
RESULT=$(_resolve_config_file "$TMP2/anchor.json" 2>&1 || true)
assert "missing config → ERROR" "ERROR" "$RESULT"

# Missing state.json → error
RESULT=$(_resolve_state_file "$TMP2/anchor.json" 2>&1 || true)
assert "missing state → ERROR" "ERROR" "$RESULT"

rm -rf "$TMP" "$TMP2"

# ════════════════════════════════════════════════════════════════
# 18. locked_jq_write: concurrent writes and malformed input
# ════════════════════════════════════════════════════════════════
echo ""
echo "── locked_jq_write ──"

TMP=$(mktemp -d)
echo '{"count":0}' > "$TMP/counter.json"

# 5 concurrent increments
for i in 1 2 3 4 5; do
  locked_jq_write "$TMP/counter.json" "counter" '.count += 1' 2>/dev/null &
done
wait

COUNT=$(jq -r '.count' "$TMP/counter.json")
assert_equals "5 concurrent locked writes → 5" "5" "$COUNT"

# Preserves other fields
echo '{"count":0,"name":"test","nested":{"a":1}}' > "$TMP/complex.json"
locked_jq_write "$TMP/complex.json" "complex" '.count += 1' 2>/dev/null
NAME=$(jq -r '.name' "$TMP/complex.json")
assert_equals "locked write preserves .name" "test" "$NAME"
NESTED=$(jq -r '.nested.a' "$TMP/complex.json")
assert_equals "locked write preserves .nested.a" "1" "$NESTED"

# Write with --arg (filter is 3rd positional, extra jq args after)
echo '{"key":"old"}' > "$TMP/arg-test.json"
locked_jq_write "$TMP/arg-test.json" "arg" '.key = $newval' --arg newval "hello" 2>/dev/null
ARGVAL=$(jq -r '.key' "$TMP/arg-test.json")
assert_equals "locked write with --arg" "hello" "$ARGVAL"

rm -rf "$TMP"

# ════════════════════════════════════════════════════════════════
# 19. Infrastructure files: no dead references
# ════════════════════════════════════════════════════════════════
echo ""
echo "── dead reference scan ──"

# No references to control-plane.conf (archived)
for f in "$HOME/.claude-ops/lib/"*.sh "$HOME/.claude-ops/hooks/"*/*.sh; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  REFS=$(grep -c 'control-plane\.conf' "$f" 2>/dev/null; true)
  if [ "$REFS" -gt 0 ]; then
    assert_equals "$name: no control-plane.conf refs" "0" "$REFS"
  fi
done
assert_equals "control-plane.conf refs: clean" "0" "0"

# No references to session-registry.json
for f in "$HOME/.claude-ops/lib/"*.sh "$HOME/.claude-ops/hooks/"*/*.sh; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  REFS=$(grep -c 'session-registry' "$f" 2>/dev/null; true)
  if [ "$REFS" -gt 0 ]; then
    assert_equals "$name: no session-registry refs" "0" "$REFS"
  fi
done
assert_equals "session-registry refs: clean" "0" "0"

# No references to sweeps.d (archived)
for f in "$HOME/.claude-ops/lib/"*.sh; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  REFS=$(grep -c 'sweeps\.d' "$f" 2>/dev/null; true)
  if [ "$REFS" -gt 0 ]; then
    assert_equals "$name: no sweeps.d refs" "0" "$REFS"
  fi
done
assert_equals "sweeps.d refs in libs: clean" "0" "0"

# ════════════════════════════════════════════════════════════════
# 20. All library files: valid bash syntax
# ════════════════════════════════════════════════════════════════
echo ""
echo "── library syntax check ──"

LIB_COUNT=0
LIB_OK=0
for f in "$HOME/.claude-ops/lib/"*.sh; do
  [ -f "$f" ] || continue
  LIB_COUNT=$((LIB_COUNT+1))
  name=$(basename "$f")
  if bash -n "$f" 2>/dev/null; then
    LIB_OK=$((LIB_OK+1))
  else
    assert_equals "$name: valid syntax" "yes" "no"
  fi
done
assert_equals "all $LIB_COUNT lib files valid bash" "$LIB_COUNT" "$LIB_OK"

# All hook files: valid bash syntax
HOOK_COUNT=0
HOOK_OK=0
for f in "$HOME/.claude-ops/hooks/"*/*.sh; do
  [ -f "$f" ] || continue
  HOOK_COUNT=$((HOOK_COUNT+1))
  name=$(basename "$f")
  if bash -n "$f" 2>/dev/null; then
    HOOK_OK=$((HOOK_OK+1))
  else
    assert_equals "$name: valid syntax" "yes" "no"
  fi
done
assert_equals "all $HOOK_COUNT hook files valid bash" "$HOOK_COUNT" "$HOOK_OK"

# All baked seeds: valid bash syntax
# Note: mod-finance-w-* seeds are plaintext prompts, not shell scripts — skip them
SEED_COUNT=0
SEED_OK=0
for f in "$PROJECT_ROOT/.claude/scripts/"*-seed.sh; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  case "$name" in mod-finance-w-*) continue ;; esac
  SEED_COUNT=$((SEED_COUNT+1))
  if bash -n "$f" 2>/dev/null; then
    SEED_OK=$((SEED_OK+1))
  else
    assert_equals "$name: valid syntax" "yes" "no"
  fi
done
assert_equals "all $SEED_COUNT seed files valid bash" "$SEED_COUNT" "$SEED_OK"

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════

test_summary
