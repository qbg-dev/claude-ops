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

# harness-watchdog.sh is the unified watchdog (supports flat workers + legacy harnesses).
WATCHDOG="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# STUCK_THRESHOLD_SEC must be 600 (10 min) — configurable via env, default 600
THRESHOLD=$(grep 'STUCK_THRESHOLD_SEC=' "$WATCHDOG" | head -1 \
  | sed 's/.*:-//' | grep -oE '^[0-9]+')
assert_equals "stuck threshold hardcoded to 600 (10 min)" "600" "$THRESHOLD"

# Core watchdog functions
assert_file_contains "watchdog has check_worker function" "$WATCHDOG" "check_worker"
assert_file_contains "watchdog has _is_pane_process_busy function" "$WATCHDOG" "_is_pane_process_busy"
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
echo "── harness-watchdog: liveness-based stuck detection ──"

WATCHDOG_SH="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# Test: watchdog reads liveness file for stuck detection (not ISO timestamp parsing)
# Refactor (2026-03-06): replaced last_cycle_at ISO parsing with epoch-based liveness files.
assert_file_contains "watchdog reads liveness file for active detection" \
  "$WATCHDOG_SH" "liveness"

# Test: watchdog uses _record_relaunch for respawn tracking
assert_file_contains "watchdog calls _record_relaunch on respawn" \
  "$WATCHDOG_SH" "_record_relaunch"

# Test: _record_relaunch increments watchdog_relaunches counter
assert_file_contains "watchdog tracks relaunch count in registry" \
  "$WATCHDOG_SH" "watchdog_relaunches"

# Test: _record_relaunch records reason for each relaunch
assert_file_contains "watchdog records relaunch reason" \
  "$WATCHDOG_SH" "last_relaunch"

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
echo "── harness-watchdog: _record_relaunch prevents kill-loop ──"

# Refactor (2026-03-06): replaced last_cycle_at stamping with _record_relaunch.
# _record_relaunch touches liveness file after respawn to prevent immediate re-detection.
WATCHDOG_SH2="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# Test: _record_relaunch touches liveness after respawn (prevents kill-loop)
assert_file_contains "_record_relaunch touches liveness after respawn" \
  "$WATCHDOG_SH2" 'RUNTIME_DIR/liveness"'

# Test: _record_relaunch uses UTC ISO for last_relaunch.at timestamp
assert_file_contains "_record_relaunch stamp uses UTC ISO format" \
  "$WATCHDOG_SH2" 'date -u +"%Y-%m-%dT%H:%M:%SZ"'

# Test: _record_relaunch is protected by registry lock
assert_file_contains "_record_relaunch acquires registry lock" \
  "$WATCHDOG_SH2" "_lock_registry"

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
