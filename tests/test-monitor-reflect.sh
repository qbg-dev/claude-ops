#!/usr/bin/env bash
# test-monitor-reflect.sh — Tests for the REFLECT event system in monitor-agent.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

MONITOR_SCRIPT="$HOME/.claude-ops/scripts/monitor-agent.sh"
FIXTURES="$(dirname "$0")/fixtures"

echo "── monitor-agent.sh REFLECT ──"

# Test 1: Monitor script exists
assert_file_exists "monitor-agent.sh exists" "$MONITOR_SCRIPT"

# Test 2: Monitor script contains REFLECT handling
TOTAL=$((TOTAL + 1))
if grep -q "REFLECT" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor script references REFLECT"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor script missing REFLECT references"
  FAIL=$((FAIL + 1))
fi

# Test 3: Monitor script has capture counter
TOTAL=$((TOTAL + 1))
if grep -q "capture_count\|CAPTURE_COUNT\|capture-count" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor script has capture counter"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor script missing capture counter"
  FAIL=$((FAIL + 1))
fi

# Test 4: Monitor script references receipt file
TOTAL=$((TOTAL + 1))
if grep -q "monitor_reflection\|REFLECT_RECEIPT\|reflect_receipt" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor script references receipt tracking"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor script missing receipt tracking"
  FAIL=$((FAIL + 1))
fi

# Test 5: Monitor script has --stop mode
TOTAL=$((TOTAL + 1))
if grep -q "\-\-stop" "$MONITOR_SCRIPT"; then
  echo -e "  ${GREEN}PASS${RESET} monitor script has --stop mode"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor script missing --stop mode"
  FAIL=$((FAIL + 1))
fi

# Test 6: REFLECT threshold is configurable
TOTAL=$((TOTAL + 1))
if grep -qE 'REFLECT_INTERVAL|reflect_interval|REFLECT_THRESHOLD|6' "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} REFLECT threshold is present"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} REFLECT threshold missing"
  FAIL=$((FAIL + 1))
fi

# Test 7: Monitor seed prompt includes meta-reflection instructions inline
TOTAL=$((TOTAL + 1))
if grep -qi "meta-reflection" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor prompt includes meta-reflection instructions"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor prompt missing meta-reflection instructions"
  FAIL=$((FAIL + 1))
fi

# Test 8: Receipt validation logic present
TOTAL=$((TOTAL + 1))
if grep -qE 'REFLECT_OVERDUE|overdue|receipt.*missing|missing.*receipt' "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} receipt validation logic present"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} receipt validation logic missing"
  FAIL=$((FAIL + 1))
fi

# ─── Session Transcript Integration Tests ─────────────────

# Test 9: Monitor sources session-reader.sh
TOTAL=$((TOTAL + 1))
if grep -q "session-reader.sh" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor sources session-reader.sh"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor doesn't source session-reader.sh"
  FAIL=$((FAIL + 1))
fi

# Test 10: Monitor calls session_find
TOTAL=$((TOTAL + 1))
if grep -q "session_find" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor calls session_find"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor missing session_find call"
  FAIL=$((FAIL + 1))
fi

# Test 11: Monitor stores session JSONL path in state dir
TOTAL=$((TOTAL + 1))
if grep -q "session-jsonl" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor stores session-jsonl path"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor missing session-jsonl storage"
  FAIL=$((FAIL + 1))
fi

# Test 12: Monitor includes session_summary in POLL/IDLE
TOTAL=$((TOTAL + 1))
if grep -q "session_digest" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor includes session_digest in events"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor missing session_digest in events"
  FAIL=$((FAIL + 1))
fi

# Test 13: Monitor has get_session_digest helper
TOTAL=$((TOTAL + 1))
if grep -q "get_session_digest\b" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor has get_session_digest helper"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor missing get_session_digest helper"
  FAIL=$((FAIL + 1))
fi

# Test 14: Monitor has get_session_digest_rich for REFLECT
TOTAL=$((TOTAL + 1))
if grep -q "get_session_digest_rich" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor has get_session_digest_rich for REFLECT"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor missing get_session_digest_rich"
  FAIL=$((FAIL + 1))
fi

# Test 15: Monitor re-resolves session file periodically
TOTAL=$((TOTAL + 1))
if grep -q 'capture_count % 10' "$MONITOR_SCRIPT" 2>/dev/null && grep -q 'new_jsonl.*session_find\|session_find.*new_jsonl' "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor re-resolves session file periodically"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor missing periodic session re-resolution"
  FAIL=$((FAIL + 1))
fi

# Test 16: Monitor prompt includes deep analysis instructions
TOTAL=$((TOTAL + 1))
if grep -qi "Deep Analysis" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor prompt includes Deep Analysis section"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor prompt missing Deep Analysis section"
  FAIL=$((FAIL + 1))
fi

# Test 17: Monitor prompt references session transcript path
TOTAL=$((TOTAL + 1))
if grep -q "SESSION_JSONL_PATH" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} monitor prompt references SESSION_JSONL_PATH"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} monitor prompt missing SESSION_JSONL_PATH"
  FAIL=$((FAIL + 1))
fi

# Test 18: Monitor sources session-reader.sh in daemon subshell
TOTAL=$((TOTAL + 1))
# The daemon subshell (between the ( and ) &) should also source session-reader.sh
if awk '/^\($/,/^\) &$/' "$MONITOR_SCRIPT" | grep -q "session-reader.sh" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} daemon subshell sources session-reader.sh"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} daemon subshell missing session-reader.sh source"
  FAIL=$((FAIL + 1))
fi

# Test 19: Monitor includes rich_digest in REFLECT events
TOTAL=$((TOTAL + 1))
if grep -q "rich_digest" "$MONITOR_SCRIPT" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} REFLECT events include rich_digest"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} REFLECT events missing rich_digest"
  FAIL=$((FAIL + 1))
fi

test_summary
