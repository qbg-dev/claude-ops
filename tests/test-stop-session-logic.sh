#!/usr/bin/env bash
# test-stop-session-logic.sh — Tests for stop-session.sh gate hook logic:
# session naming, code review checklist, state cleanup, error handling.
# Also covers stop-inbox-drain.sh and stop-worker-dispatch.sh coordination.
set -uo pipefail

source "$(dirname "$0")/helpers.sh"

STOP_SH="$HOME/.claude-ops/hooks/gates/stop-session.sh"
DRAIN_SH="$HOME/.claude-ops/hooks/gates/stop-inbox-drain.sh"
DISPATCH_SH="$HOME/.claude-ops/hooks/gates/stop-worker-dispatch.sh"

# ══════════════════════════════════════════════════════════════════════
# Script structure
# ══════════════════════════════════════════════════════════════════════
echo "── stop-session: script structure ──"

assert_file_exists "stop-session hook exists" "$STOP_SH"
assert_file_contains "uses set -euo pipefail" "$STOP_SH" "set -euo pipefail"

# ══════════════════════════════════════════════════════════════════════
# Session naming state machine
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── stop-session: session naming ──"

# Test: has session naming phases
assert_file_contains "has session naming state machine" "$STOP_SH" "session"

# Test: reads from pane-registry for harness identification
TOTAL=$((TOTAL + 1))
if grep -qE 'pane.registry|harness|pane_id' "$STOP_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} resolves harness from pane registry"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} does not resolve harness from pane registry"
fi

# Test: publishes session-end event
TOTAL=$((TOTAL + 1))
if grep -qE 'session.end|session_end|bus_publish' "$STOP_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} publishes session end event"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} does not publish session end event"
fi

# ══════════════════════════════════════════════════════════════════════
# Code review checklist
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── stop-session: code review checklist ──"

# Test: reads repo-context.xml for checklist
TOTAL=$((TOTAL + 1))
if grep -qE 'repo-context|checklist|stop.prompt' "$STOP_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} reads repo-context for checklist/stop-prompts"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} does not read repo-context"
fi

# Test: change categorization
TOTAL=$((TOTAL + 1))
if grep -qE 'tsx|frontend|backend|sensitive|deploy' "$STOP_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} categorizes changes (frontend/backend/sensitive)"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} does not categorize changes"
fi

# ══════════════════════════════════════════════════════════════════════
# Graceful-stop sentinel (prompt-publisher coordination)
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── stop system: graceful-stop sentinel coordination ──"

PUBLISHER_SH="$HOME/.claude-ops/hooks/publishers/prompt-publisher.sh"
assert_file_contains "prompt-publisher checks graceful-stop" "$PUBLISHER_SH" "graceful-stop"
assert_file_contains "prompt-publisher removes sentinel on new input" "$PUBLISHER_SH" 'rm -f "$_GS_FILE"'

# ══════════════════════════════════════════════════════════════════════
# stop-inbox-drain.sh
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── stop-inbox-drain: inbox coordination ──"

if [ -f "$DRAIN_SH" ]; then
  assert_file_exists "stop-inbox-drain hook exists" "$DRAIN_SH"
  assert_file_contains "drain gate references inbox" "$DRAIN_SH" "inbox"

  TOTAL=$((TOTAL + 1))
  if grep -qE 'pending|messages|drain' "$DRAIN_SH" 2>/dev/null; then
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}PASS${RESET} drain gate checks for pending messages"
  else
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}FAIL${RESET} drain gate doesn't check messages"
  fi
else
  echo -e "  ${YELLOW}SKIP${RESET} stop-inbox-drain.sh not found"
fi

# ══════════════════════════════════════════════════════════════════════
# stop-worker-dispatch.sh
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── stop-worker-dispatch: task dispatch ──"

if [ -f "$DISPATCH_SH" ]; then
  assert_file_exists "stop-worker-dispatch hook exists" "$DISPATCH_SH"
  assert_file_contains "dispatch references tasks.json" "$DISPATCH_SH" "tasks.json"

  # Verify no progress.json fallback (v2 regression)
  TOTAL=$((TOTAL + 1))
  if grep -q 'progress\.json' "$DISPATCH_SH" 2>/dev/null; then
    FAIL=$((FAIL + 1))
    echo -e "  ${RED}FAIL${RESET} dispatch references progress.json (v2 regression)"
  else
    PASS=$((PASS + 1))
    echo -e "  ${GREEN}PASS${RESET} dispatch has no progress.json fallback"
  fi
else
  echo -e "  ${YELLOW}SKIP${RESET} stop-worker-dispatch.sh not found"
fi

# ══════════════════════════════════════════════════════════════════════
# Error handling in stop hook
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── stop-session: error handling ──"

# Test: stop hook outputs {} at some point (doesn't block indefinitely)
TOTAL=$((TOTAL + 1))
RETURNS_JSON=$(grep -c 'echo.*{}' "$STOP_SH" || echo 0)
if [ "$RETURNS_JSON" -ge 1 ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} stop hook returns {} (doesn't block Claude exit)"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} stop hook doesn't return {}"
fi

test_summary
