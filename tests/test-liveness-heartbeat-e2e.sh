#!/usr/bin/env bash
# test-liveness-heartbeat-e2e.sh — End-to-end tests for the liveness heartbeat system.
# Covers: hook execution, file creation, watchdog reads, epoch format, WORKER_NAME flow.
set -uo pipefail

source "$(dirname "$0")/helpers.sh"

TMPDIR_TEST=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

LIVENESS_SH="$HOME/.claude-ops/hooks/publishers/liveness-heartbeat.sh"
WATCHDOG_SH="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# ══════════════════════════════════════════════════════════════════════
# Hook execution — WORKER_NAME set
# ══════════════════════════════════════════════════════════════════════
echo "── liveness heartbeat: hook writes epoch ──"

FAKE_WORKER="test-heartbeat-worker"

# Run the hook with a fake HOME (exported) to isolate state
HOME="$TMPDIR_TEST" WORKER_NAME="$FAKE_WORKER" bash "$LIVENESS_SH"

LIVENESS_FILE="$TMPDIR_TEST/.claude-ops/state/watchdog-runtime/$FAKE_WORKER/liveness"
assert_file_exists "liveness file created" "$LIVENESS_FILE"

# Verify epoch format (10-digit integer)
LIVENESS_CONTENT=$(cat "$LIVENESS_FILE" 2>/dev/null || echo "")
TOTAL=$((TOTAL + 1))
if [[ "$LIVENESS_CONTENT" =~ ^[0-9]{10}$ ]]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} liveness file contains epoch timestamp"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} liveness file not epoch format: '$LIVENESS_CONTENT'"
fi

# Verify epoch is recent (within 5 seconds)
NOW_EPOCH=$(date +%s)
DIFF=$(( NOW_EPOCH - LIVENESS_CONTENT ))
TOTAL=$((TOTAL + 1))
if [ "$DIFF" -ge 0 ] && [ "$DIFF" -le 5 ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} liveness epoch is recent (${DIFF}s ago)"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} liveness epoch is not recent: ${DIFF}s ago"
fi

# ══════════════════════════════════════════════════════════════════════
# Hook execution — WORKER_NAME empty → no-op
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── liveness heartbeat: empty WORKER_NAME → no-op ──"

EMPTY_HOME="$TMPDIR_TEST/empty-test"
HOME="$EMPTY_HOME" WORKER_NAME="" bash "$LIVENESS_SH" 2>/dev/null || true

TOTAL=$((TOTAL + 1))
if [ ! -d "$EMPTY_HOME/.claude-ops" ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} no state dir created when WORKER_NAME empty"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} state dir created with empty WORKER_NAME"
fi

# ══════════════════════════════════════════════════════════════════════
# Hook execution — WORKER_NAME unset → no-op
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── liveness heartbeat: unset WORKER_NAME → no-op ──"

UNSET_HOME="$TMPDIR_TEST/unset-test"
env -u WORKER_NAME HOME="$UNSET_HOME" bash "$LIVENESS_SH" 2>/dev/null || true

TOTAL=$((TOTAL + 1))
if [ ! -d "$UNSET_HOME/.claude-ops" ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} no state dir created when WORKER_NAME unset"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} state dir created with unset WORKER_NAME"
fi

# ══════════════════════════════════════════════════════════════════════
# Liveness file update — overwrites old value
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── liveness heartbeat: overwrites on re-run ──"

FAKE_WORKER2="test-heartbeat-refresh"
REFRESH_DIR="$TMPDIR_TEST/.claude-ops/state/watchdog-runtime/$FAKE_WORKER2"
mkdir -p "$REFRESH_DIR"
OLD_EPOCH=$(( $(date +%s) - 600 ))  # 10 minutes ago
echo "$OLD_EPOCH" > "$REFRESH_DIR/liveness"

# Run the hook — should overwrite with current epoch
HOME="$TMPDIR_TEST" WORKER_NAME="$FAKE_WORKER2" bash "$LIVENESS_SH"

NEW_CONTENT=$(cat "$REFRESH_DIR/liveness" 2>/dev/null || echo "0")
TOTAL=$((TOTAL + 1))
if [ "$NEW_CONTENT" -gt "$OLD_EPOCH" ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} liveness file updated to newer epoch"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} liveness file not updated: old=$OLD_EPOCH, new=$NEW_CONTENT"
fi

# ══════════════════════════════════════════════════════════════════════
# Watchdog reads the liveness file correctly
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog: reads liveness epoch for detection ──"

assert_file_contains "watchdog reads from watchdog-runtime dir" \
  "$WATCHDOG_SH" "watchdog-runtime"

assert_file_contains "watchdog computes since_active from epoch" \
  "$WATCHDOG_SH" "since_active"

# Verify epoch subtraction (not date parsing)
TOTAL=$((TOTAL + 1))
HAS_EPOCH_MATH=$(grep -c 'now_ts - last_active' "$WATCHDOG_SH" || echo 0)
if [ "$HAS_EPOCH_MATH" -ge 1 ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} watchdog uses epoch subtraction (not date parsing)"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} watchdog not using epoch subtraction"
fi

# ══════════════════════════════════════════════════════════════════════
# Hook settings — registered on correct events (nested structure)
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── liveness heartbeat: hook registration ──"

SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  # Nested structure: .hooks.EventName[].hooks[].command
  # Check PostToolUse registration
  TOTAL=$((TOTAL + 1))
  if jq -e '[.hooks.PostToolUse[]?.hooks[]?.command // empty] | any(contains("liveness-heartbeat"))' "$SETTINGS" 2>/dev/null | grep -q true; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}PASS${RESET} liveness hook registered on PostToolUse"
  else
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}FAIL${RESET} liveness hook NOT registered on PostToolUse"
  fi

  # Check UserPromptSubmit registration
  TOTAL=$((TOTAL + 1))
  if jq -e '[.hooks.UserPromptSubmit[]?.hooks[]?.command // empty] | any(contains("liveness-heartbeat"))' "$SETTINGS" 2>/dev/null | grep -q true; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}PASS${RESET} liveness hook registered on UserPromptSubmit"
  else
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}FAIL${RESET} liveness hook NOT registered on UserPromptSubmit"
  fi
else
  echo -e "  ${YELLOW}SKIP${RESET} settings.json not found at $SETTINGS"
fi

# ══════════════════════════════════════════════════════════════════════
# Hook exit code — always 0
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── liveness heartbeat: always exits 0 ──"

# Run with valid WORKER_NAME
HOME="$TMPDIR_TEST" WORKER_NAME="exit-code-test" bash "$LIVENESS_SH"
assert_equals "hook exits 0 with valid WORKER_NAME" "0" "$?"

# Run with empty WORKER_NAME
HOME="$TMPDIR_TEST" WORKER_NAME="" bash "$LIVENESS_SH" 2>/dev/null
assert_equals "hook exits 0 with empty WORKER_NAME" "0" "$?"

# ══════════════════════════════════════════════════════════════════════
# Hook script properties
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── liveness heartbeat: script properties ──"

# Must be short and fast — check line count
TOTAL=$((TOTAL + 1))
LINE_COUNT=$(wc -l < "$LIVENESS_SH" | tr -d ' ')
if [ "$LINE_COUNT" -le 20 ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} hook is compact (${LINE_COUNT} lines)"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} hook is ${LINE_COUNT} lines (should be ≤20 for fast execution)"
fi

# No set -e (hook must never block Claude)
TOTAL=$((TOTAL + 1))
if grep -q 'set -e' "$LIVENESS_SH" 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} hook uses set -e (could block Claude on error)"
else
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} hook does not use set -e"
fi

# Always exits 0
assert_file_contains "hook ends with exit 0" "$LIVENESS_SH" "exit 0"

test_summary
