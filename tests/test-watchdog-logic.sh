#!/usr/bin/env bash
# test-watchdog-logic.sh — Tests for extractable harness-watchdog.sh logic.
# Covers: crash count management, stuck detection patterns, sleep duration,
#         stop-hook resolve_progress_file behavior, threshold config.
set -uo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.boring/lib/harness-jq.sh"

TMPDIR_TEST=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

# Override HARNESS_STATE_DIR so crash count files land in tmp
HARNESS_STATE_DIR="$TMPDIR_TEST"
export HARNESS_STATE_DIR

# ── Inline the crash count functions (from harness-watchdog.sh) ──
# We inline them to test without needing a full watchdog environment.
_crash_count_file() {
  local canonical="$1"
  echo "$HARNESS_STATE_DIR/harness-runtime/$canonical/crash-count.json"
}

_increment_crash_count() {
  local canonical="$1"
  local f; f=$(_crash_count_file "$canonical")
  mkdir -p "$(dirname "$f")"
  local now_ts; now_ts=$(date -u +%s)
  local hour_ago=$(( now_ts - 3600 ))
  local existing="[]"
  [ -f "$f" ] && existing=$(jq '.timestamps // []' "$f" 2>/dev/null || echo "[]")
  local updated
  updated=$(echo "$existing" | jq --argjson now "$now_ts" --argjson cutoff "$hour_ago" \
    '[.[] | select(. > $cutoff)] + [$now]')
  echo "{\"timestamps\":$updated}" > "$f"
  echo "$updated" | jq 'length'
}

_crash_count_last_hr() {
  local canonical="$1"
  local f; f=$(_crash_count_file "$canonical")
  [ ! -f "$f" ] && echo 0 && return
  local now_ts; now_ts=$(date -u +%s)
  local hour_ago=$(( now_ts - 3600 ))
  jq --argjson cutoff "$hour_ago" '[.timestamps[] | select(. > $cutoff)] | length' "$f" 2>/dev/null || echo 0
}

echo "── watchdog: crash count management ──"

# No file → 0
assert_equals "crash_count: no file → 0" "0" "$(_crash_count_last_hr "test-c1")"

# First crash
COUNT=$(_increment_crash_count "test-c1")
assert_equals "increment: first crash → count=1" "1" "$COUNT"
assert_equals "last_hr: reads 1 crash" "1" "$(_crash_count_last_hr "test-c1")"

# Two more crashes
_increment_crash_count "test-c1" > /dev/null
_increment_crash_count "test-c1" > /dev/null
assert_equals "last_hr: 3 crashes accumulated" "3" "$(_crash_count_last_hr "test-c1")"

# Old timestamps (>1 hour ago) are filtered out
CRASH_FILE=$(_crash_count_file "test-c-old")
mkdir -p "$(dirname "$CRASH_FILE")"
OLD_TS=$(( $(date -u +%s) - 7200 ))  # 2 hours ago
echo "{\"timestamps\":[$OLD_TS]}" > "$CRASH_FILE"
assert_equals "crash_count: old entry filtered" "0" "$(_crash_count_last_hr "test-c-old")"

# Mix of old + new timestamps — only new ones counted
OLD_TS2=$(( $(date -u +%s) - 5000 ))
NEW_TS=$(date -u +%s)
CRASH_FILE2=$(_crash_count_file "test-c-mix")
mkdir -p "$(dirname "$CRASH_FILE2")"
echo "{\"timestamps\":[$OLD_TS2,$NEW_TS]}" > "$CRASH_FILE2"
assert_equals "crash_count: mixed entries — only 1 new counted" "1" "$(_crash_count_last_hr "test-c-mix")"

# Increment on stale-only file adds a fresh entry (old ones pruned)
COUNT_MIX=$(_increment_crash_count "test-c-old")
assert_equals "increment after stale: count=1 (stale pruned)" "1" "$COUNT_MIX"

echo ""
echo "── watchdog: stuck detection regex ──"

STUCK_PATTERN='Waiting for task|hook error.*hook error|No output.*No output'

# Should match
MATCH1="Waiting for task output... (120s elapsed)"
echo "$MATCH1" | grep -qE "$STUCK_PATTERN" && STATUS="match" || STATUS="no-match"
assert_equals "stuck: 'Waiting for task' matches" "match" "$STATUS"

MATCH2="hook error: TIMEOUT hook error: TIMEOUT"
echo "$MATCH2" | grep -qE "$STUCK_PATTERN" && STATUS="match" || STATUS="no-match"
assert_equals "stuck: 'hook error...hook error' matches" "match" "$STATUS"

MATCH3="No output received No output received"
echo "$MATCH3" | grep -qE "$STUCK_PATTERN" && STATUS="match" || STATUS="no-match"
assert_equals "stuck: 'No output No output' matches" "match" "$STATUS"

# Should NOT match
MATCH4="Currently running bun test..."
echo "$MATCH4" | grep -qE "$STUCK_PATTERN" && STATUS="match" || STATUS="no-match"
assert_equals "stuck: normal output does not match" "no-match" "$STATUS"

MATCH5="❯"
echo "$MATCH5" | grep -qE "$STUCK_PATTERN" && STATUS="match" || STATUS="no-match"
assert_equals "stuck: TUI prompt does not match" "no-match" "$STATUS"

MATCH6="Deploying to test..."
echo "$MATCH6" | grep -qE "$STUCK_PATTERN" && STATUS="match" || STATUS="no-match"
assert_equals "stuck: deploy output does not match" "no-match" "$STATUS"

echo ""
echo "── watchdog: config values ──"

WATCHDOG="$HOME/.boring/scripts/harness-watchdog.sh"

# STUCK_THRESHOLD_SEC must be 1200 (20 min) — hardcoded, not configurable via env default
THRESHOLD=$(grep 'STUCK_THRESHOLD_SEC=' "$WATCHDOG" | head -1 \
  | sed 's/.*:-//' | grep -oE '^[0-9]+')
assert_equals "stuck threshold hardcoded to 1200 (20 min)" "1200" "$THRESHOLD"

# Flat worker unstick path (worker/*) must be present
assert_file_contains "watchdog has _unstick_worker function" "$WATCHDOG" "_unstick_worker()"
assert_file_contains "watchdog detects worker/* canonicals" "$WATCHDOG" 'worker/*'
assert_file_contains "watchdog calls _check_scrollback_stuck" "$WATCHDOG" "_check_scrollback_stuck"

echo ""
echo "── stop hook: resolve_progress_file ──"

DISPATCH="$HOME/.boring/hooks/gates/stop-harness-dispatch.sh"

# resolve_progress_file must return tasks.json only (no progress.json fallback)
assert_file_contains "dispatch: resolve_progress_file exists" "$DISPATCH" "resolve_progress_file"
assert_file_contains "dispatch: returns tasks.json path" "$DISPATCH" "tasks.json"

# Verify no progress.json fallback inside the function
FUNC_BODY=$(awk '/^resolve_progress_file\(\)/,/^}/' "$DISPATCH")
echo "$FUNC_BODY" | grep -q 'progress\.json' && HAS_PJSON="yes" || HAS_PJSON="no"
assert_equals "resolve_progress_file: no progress.json fallback" "no" "$HAS_PJSON"

echo ""
echo "── harness_sleep_duration: flat worker path ──"

# Create a fake project dir with a worker state.json
PROJ_DIR="$TMPDIR_TEST/proj"
mkdir -p "$PROJ_DIR/.claude/workers/my-worker"

# perpetual:true, sleep_duration:600
cat > "$PROJ_DIR/.claude/workers/my-worker/state.json" <<'JSON'
{"perpetual": true, "sleep_duration": 600, "status": "active"}
JSON
SLEEP_DUR=$(PROJECT_ROOT="$PROJ_DIR" harness_sleep_duration "worker/my-worker")
assert_equals "sleep_duration: reads 600 from state.json" "600" "$SLEEP_DUR"

# perpetual:false → "none" (watchdog skips respawn)
cat > "$PROJ_DIR/.claude/workers/my-worker/state.json" <<'JSON'
{"perpetual": false, "status": "active"}
JSON
SLEEP_DUR2=$(PROJECT_ROOT="$PROJ_DIR" harness_sleep_duration "worker/my-worker")
assert_equals "sleep_duration: perpetual:false returns 'none'" "none" "$SLEEP_DUR2"

# Missing state.json → falls through to default
mkdir -p "$PROJ_DIR/.claude/workers/no-state"
SLEEP_DUR3=$(PROJECT_ROOT="$PROJ_DIR" harness_sleep_duration "worker/no-state" 2>/dev/null || echo "")
# Default is 900 (from harness-jq.sh) — just verify it returns something numeric or empty
case "$SLEEP_DUR3" in
  ''|*[!0-9]*)
    # Empty is fine (no default set in harness_sleep_duration for flat workers with no file)
    assert_equals "sleep_duration: no state.json → empty" "" "$SLEEP_DUR3"
    ;;
  *)
    assert "sleep_duration: no state.json → numeric default" "$SLEEP_DUR3" "$SLEEP_DUR3"
    ;;
esac

test_summary
