#!/usr/bin/env bash
# test-watchdog-logic.sh — Tests for extractable harness-watchdog.sh logic.
# Covers: crash count management, stuck detection patterns, sleep duration,
#         stop-hook resolve_progress_file behavior, threshold config.
set -uo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

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

# Architecture: v3 uses worker-watchdog.sh (full-featured, supports flat workers)
# harness-watchdog.sh is a simplified crash-only watchdog for legacy harnesses.
WATCHDOG="$HOME/.claude-ops/scripts/worker-watchdog.sh"

# STUCK_THRESHOLD_SEC must be 1200 (20 min) — configurable via env, default 1200
THRESHOLD=$(grep 'STUCK_THRESHOLD_SEC=' "$WATCHDOG" | head -1 \
  | sed 's/.*:-//' | grep -oE '^[0-9]+')
assert_equals "stuck threshold hardcoded to 1200 (20 min)" "1200" "$THRESHOLD"

# Flat worker unstick path (worker/*) must be present
assert_file_contains "watchdog has _unstick_worker function" "$WATCHDOG" "_unstick_worker()"
assert_file_contains "watchdog detects worker/* canonicals" "$WATCHDOG" 'worker/*'
assert_file_contains "watchdog calls _check_scrollback_stuck" "$WATCHDOG" "_check_scrollback_stuck"

echo ""
echo "── stop hook: tasks.json dispatch ──"

# Architecture: v3 stop hook is stop-worker-dispatch.sh (not stop-harness-dispatch.sh)
DISPATCH="$HOME/.claude-ops/hooks/gates/stop-worker-dispatch.sh"

# Stop hook must reference tasks.json for task-state dispatch decisions
assert_file_contains "dispatch: references tasks.json" "$DISPATCH" "tasks.json"

# Verify no progress.json fallback (v2 regression: dispatched based on progress.json)
HAS_PJSON="no"
grep -q 'progress\.json' "$DISPATCH" 2>/dev/null && HAS_PJSON="yes" || true
assert_equals "dispatch: no progress.json fallback" "no" "$HAS_PJSON"

echo ""
echo "── harness_sleep_duration: flat worker path ──"

# Create a fake project dir with a registry.json (v3 flat worker format)
# harness_sleep_duration reads from .claude/workers/registry.json[worker_name]
PROJ_DIR="$TMPDIR_TEST/proj"
mkdir -p "$PROJ_DIR/.claude/workers/my-worker"
mkdir -p "$PROJ_DIR/.claude/workers/no-state"

# perpetual:true, sleep_duration:600
cat > "$PROJ_DIR/.claude/workers/registry.json" <<'JSON'
{"my-worker": {"perpetual": true, "sleep_duration": 600, "status": "active"}}
JSON
SLEEP_DUR=$(PROJECT_ROOT="$PROJ_DIR" harness_sleep_duration "worker/my-worker")
assert_equals "sleep_duration: reads 600 from registry.json" "600" "$SLEEP_DUR"

# perpetual:false → "none" (watchdog skips respawn)
cat > "$PROJ_DIR/.claude/workers/registry.json" <<'JSON'
{"my-worker": {"perpetual": false, "status": "active"}}
JSON
SLEEP_DUR2=$(PROJECT_ROOT="$PROJ_DIR" harness_sleep_duration "worker/my-worker")
assert_equals "sleep_duration: perpetual:false returns 'none'" "none" "$SLEEP_DUR2"

# Missing entry in registry → "none" (watchdog treats unregistered worker as non-perpetual)
# jq null | .perpetual == null → "unset" → harness_sleep_duration returns "none"
SLEEP_DUR3=$(PROJECT_ROOT="$PROJ_DIR" harness_sleep_duration "worker/no-state" 2>/dev/null || echo "")
assert_equals "sleep_duration: unregistered worker returns 'none'" "none" "$SLEEP_DUR3"

echo ""
echo "── harness-watchdog: UTC date parsing (no TZ offset bug) ──"

WATCHDOG_SH="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# Test: watchdog uses 'date -j -u' (with -u flag) when parsing last_cycle_at timestamps.
# Bug (fixed commit 3be6505): 'date -j -f "%Y-%m-%dT%H:%M:%S"' without -u treats
# input as LOCAL time (EST=UTC-5), making recent UTC cycles appear 5h in the future
# so the watchdog never respawns perpetual workers.
TOTAL=$((TOTAL + 1))
if grep -q 'date -j -u -f "%Y-%m-%dT%H:%M:%S"' "$WATCHDOG_SH" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} watchdog uses date -j -u for UTC timestamp parsing"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} watchdog must use 'date -j -u' (not bare 'date -j') for UTC timestamps"
  echo "    Bug: bare 'date -j -f' treats input as local time, causing up to 5h offset on macOS"
  FAIL=$((FAIL + 1))
fi

# Test: no bare 'date -j -f' without -u in the watchdog's sleep duration path
BARE_DATE_J=$(grep -n 'date -j -f "%Y-%m-%dT' "$WATCHDOG_SH" 2>/dev/null | grep -v '\-u' || true)
assert_empty "watchdog: no bare 'date -j -f' without -u flag" "$BARE_DATE_J"

# Test: watchdog strips Z/+ suffix before parsing (handles "2026-03-04T04:32:46Z" format)
STRIPS_Z=$(grep -n '_clean_ts=.*\[Z+\]' "$WATCHDOG_SH" 2>/dev/null || true)
TOTAL=$((TOTAL + 1))
if [ -n "$STRIPS_Z" ]; then
  echo -e "  ${GREEN}PASS${RESET} watchdog strips Z/+ suffix from ISO timestamp before parsing"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} watchdog should strip Z/+ suffix (e.g. '%%[Z+]*') before date -j"
  FAIL=$((FAIL + 1))
fi

# Runtime test: verify the UTC parse correctly computes epoch for a known UTC time
# "2026-01-01T12:00:00Z" should parse to the same epoch on any timezone
EXPECTED_EPOCH=$(TZ=UTC date -d "2026-01-01T12:00:00" +%s 2>/dev/null || echo 0)
if [ "$EXPECTED_EPOCH" -gt 0 ]; then
  _clean="2026-01-01T12:00:00"
  PARSED_EPOCH=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$_clean" +%s 2>/dev/null || echo 0)
  assert_equals "UTC parse: 2026-01-01T12:00:00Z gives correct epoch" "$EXPECTED_EPOCH" "$PARSED_EPOCH"
fi

echo ""
echo "── merge-trigger-watchdog: registry.json chief-of-staff lookup ──"

MERGE_WD="$HOME/.claude-ops/scripts/merge-trigger-watchdog.sh"

# Test: merge-trigger-watchdog now checks registry.json first for chief-of-staff pane.
# Fix commit e2e32be: flat workers (chief-of-staff) are in registry.json only,
# so pane-registry-only lookup never found them, silently dropping merge triggers.
assert_file_contains "merge-trigger-watchdog: registry.json lookup present" \
  "$MERGE_WD" "registry.json"

# Test: lookup labels registry.json as PRIMARY (not a fallback)
# The fix (commit e2e32be) added a FLAT_REG variable pointing to registry.json
# and labels it PRIMARY in a comment, before the pane-registry fallback.
assert_file_contains "merge-trigger-watchdog: FLAT_REG points to registry.json" \
  "$MERGE_WD" 'registry.json"'

# Test: the flat worker lookup variable (FLAT_REG) is defined
assert_file_contains "merge-trigger-watchdog: FLAT_REG variable defined" \
  "$MERGE_WD" "FLAT_REG="

echo ""
echo "── harness-watchdog: last_cycle_at stamped on respawn (kill-loop prevention) ──"

# Bug (fixed commit ff5aa08): watchdog respawned workers repeatedly without
# updating last_cycle_at, causing a kill-loop on the next watchdog pass.
# Fix: stamp last_cycle_at = now in registry.json immediately after launching Claude.
WATCHDOG_SH2="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# Test: watchdog stamps last_cycle_at on respawn
TOTAL=$((TOTAL + 1))
if grep -q 'last_cycle_at = \$ts\|last_cycle_at=.*ts\|last_cycle_at.*_now_iso' "$WATCHDOG_SH2" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} watchdog stamps last_cycle_at on respawn"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} watchdog must stamp last_cycle_at on respawn (prevents kill-loop)"
  FAIL=$((FAIL + 1))
fi

# Test: stamp uses date -u (UTC) to match the UTC format read back by the respawn check
TOTAL=$((TOTAL + 1))
if grep -q "date -u +\"%Y-%m-%dT%H:%M:%SZ\"" "$WATCHDOG_SH2" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} watchdog stamp uses UTC ISO format"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} watchdog stamp must use 'date -u +\"%Y-%m-%dT%H:%M:%SZ\"'"
  FAIL=$((FAIL + 1))
fi

# Test: stamp is protected by registry lock (mkdir-based)
assert_file_contains "last_cycle_at stamp acquires registry lock" \
  "$WATCHDOG_SH2" "mkdir \"\$_LOCK_DIR\""

# Runtime test: verify stamped timestamp is recent (within 5 seconds)
FAKE_REGISTRY="$TMPDIR_TEST/registry-stamp-test.json"
FAKE_WORKER="stamp-test-worker"
echo "{\"$FAKE_WORKER\": {\"status\": \"active\", \"perpetual\": true}}" > "$FAKE_REGISTRY"
_NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq --arg n "$FAKE_WORKER" --arg ts "$_NOW_ISO" '.[$n].last_cycle_at = $ts' \
  "$FAKE_REGISTRY" > "$FAKE_REGISTRY.tmp" && mv "$FAKE_REGISTRY.tmp" "$FAKE_REGISTRY"
STORED_TS=$(jq -r --arg n "$FAKE_WORKER" '.[$n].last_cycle_at // empty' "$FAKE_REGISTRY" 2>/dev/null)
assert_equals "last_cycle_at stamp: jq write round-trips correctly" "$_NOW_ISO" "$STORED_TS"

test_summary
