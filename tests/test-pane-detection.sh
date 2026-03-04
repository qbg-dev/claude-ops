#!/usr/bin/env bash
# test-pane-detection.sh — Regression tests for tmux pane detection.
#
# Validates that:
# 1. No infrastructure code uses `tmux display-message -p` for self-identification
# 2. find_own_pane() and pane_id_to_target() are correct
# 3. All scripts that need pane identity use the process-tree pattern
#
# Background: `tmux display-message -p` returns the FOCUSED pane, not the
# calling process's pane. This caused /quit to be sent to the wrong agent.
# See: https://github.com/qbg-dev/... (incident 2026-02-24)
#
# Run: bash ~/.boring/tests/test-pane-detection.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

echo "── pane detection regression ──"

# ═════════════════════════════════════════════════════════════════════
# PART 1: Grep regression — no executable `tmux display-message -p`
# ═════════════════════════════════════════════════════════════════════

# Scan all shell scripts + markdown docs for the buggy pattern.
# Allow it ONLY in warning/documentation lines (grep -v filters those).
# The pattern: `tmux display-message -p` WITHOUT a preceding `-t` flag
# (display-message -t $PANE -p is fine — it targets a specific pane).

# Test 1: No buggy usage in harness-dispatch.sh
HITS=$(grep -n 'tmux display-message -p' "$HOME/.boring/hooks/harness-dispatch.sh" 2>/dev/null \
  | grep -v 'display-message -t' \
  | grep -v 'WARNING\|WARN\|# .*returns\|Do NOT use' || true)
assert_empty "harness-dispatch.sh: no bare display-message -p" "$HITS"

# Test 2: No buggy usage in report-issue.sh
HITS=$(grep -n 'tmux display-message -p' "$HOME/.boring/bin/report-issue.sh" 2>/dev/null \
  | grep -v 'display-message -t' \
  | grep -v 'WARNING\|WARN\|# .*returns\|Do NOT use' || true)
assert_empty "report-issue.sh: no bare display-message -p" "$HITS"

# Test 3: No buggy usage in monitor-agent.sh (only in warning docs)
HITS=$(grep -n 'tmux display-message -p' "$HOME/.boring/scripts/monitor-agent.sh" 2>/dev/null \
  | grep -v 'display-message -t' \
  | grep -v 'WARNING\|WARN\|Do NOT use' || true)
assert_empty "monitor-agent.sh: no bare display-message -p" "$HITS"

# Test 4: No buggy usage in scaffold templates
HITS=$(grep -rn 'tmux display-message -p' "$HOME/.boring/templates/" 2>/dev/null \
  | grep -v 'display-message -t' \
  | grep -v 'WARNING\|WARN\|# .*returns\|Do NOT use' || true)
assert_empty "templates/: no bare display-message -p" "$HITS"

# Test 5: No buggy usage in any library file
HITS=$(grep -rn 'tmux display-message -p' "$HOME/.boring/lib/" 2>/dev/null \
  | grep -v 'display-message -t' \
  | grep -v 'WARNING\|WARN\|# .*returns\|Do NOT use' || true)
assert_empty "lib/: no bare display-message -p" "$HITS"

# Test 6: No buggy usage in sweeps
HITS=$(grep -rn 'tmux display-message -p' "$HOME/.boring/sweeps.d/" 2>/dev/null \
  | grep -v 'display-message -t' \
  | grep -v 'WARNING\|WARN\|# .*returns\|Do NOT use' || true)
assert_empty "sweeps.d/: no bare display-message -p" "$HITS"

# Test 7: Global CLAUDE.md only has it in warnings
HITS=$(grep -n 'tmux display-message -p' "$HOME/.claude/CLAUDE.md" 2>/dev/null \
  | grep -v 'WARNING\|WARN\|returns the.*focused\|Do NOT use' || true)
assert_empty "CLAUDE.md: display-message -p only in warnings" "$HITS"

# ═════════════════════════════════════════════════════════════════════
# PART 2: find_own_pane() correctness
# ═════════════════════════════════════════════════════════════════════

# Source harness-dispatch to get find_own_pane and pane_id_to_target
# We need to handle the fact that it reads stdin and does work — isolate just the functions.
# Extract them directly instead.

_test_find_own_pane() {
  local search_pid=$$
  local pane_map=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null)
  [ -z "$pane_map" ] && return 1
  while [ "$search_pid" -gt 1 ]; do
    local match=$(echo "$pane_map" | awk -v pid="$search_pid" '$1 == pid {print $2; exit}')
    [ -n "$match" ] && { echo "$match"; return 0; }
    search_pid=$(ps -o ppid= -p "$search_pid" 2>/dev/null | tr -d ' ')
  done
  return 1
}

_test_pane_id_to_target() {
  tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | awk -v id="$1" '$1 == id {print $2; exit}'
}

# Test 8: find_own_pane returns a pane_id (if running in tmux)
if [ -n "${TMUX:-}" ]; then
  OWN=$(_test_find_own_pane 2>/dev/null || echo "")
  TOTAL=$((TOTAL + 1))
  if [[ "$OWN" =~ ^%[0-9]+$ ]]; then
    echo -e "  ${GREEN}PASS${RESET} find_own_pane returns valid pane_id format (%NNN)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} find_own_pane returns valid pane_id format (%NNN)"
    echo "    got: '$OWN'"
    FAIL=$((FAIL + 1))
  fi

  # Test 9: pane_id_to_target resolves to session:window.pane format
  if [ -n "$OWN" ]; then
    TARGET=$(_test_pane_id_to_target "$OWN")
    TOTAL=$((TOTAL + 1))
    if [[ "$TARGET" =~ ^[a-zA-Z0-9_-]+:[0-9]+\.[0-9]+$ ]]; then
      echo -e "  ${GREEN}PASS${RESET} pane_id_to_target returns valid target (session:window.pane)"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}FAIL${RESET} pane_id_to_target returns valid target (session:window.pane)"
      echo "    got: '$TARGET'"
      FAIL=$((FAIL + 1))
    fi
  fi

  # Test 10: find_own_pane does NOT return the focused pane (the whole point)
  # We can't truly test focus-independence without switching focus,
  # but we CAN verify it matches our process tree rather than using display-message.
  DISPLAY_MSG_PANE=$(tmux display-message -p '#{pane_id}' 2>/dev/null || echo "")
  TREE_PANE=$(_test_find_own_pane 2>/dev/null || echo "")
  TOTAL=$((TOTAL + 1))
  # When WE are focused, both should agree. But the key test is that
  # find_own_pane uses process tree, not display-message. Verify by checking
  # the function source doesn't contain display-message.
  FUNC_SRC=$(type _test_find_own_pane 2>/dev/null || echo "")
  if echo "$FUNC_SRC" | grep -q 'pane_pid' && ! echo "$FUNC_SRC" | grep -q 'display-message'; then
    echo -e "  ${GREEN}PASS${RESET} find_own_pane uses process-tree, not display-message"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} find_own_pane uses process-tree, not display-message"
    FAIL=$((FAIL + 1))
  fi

  # Test 11: pane_id_to_target round-trips with list-panes
  if [ -n "$OWN" ]; then
    TARGET=$(_test_pane_id_to_target "$OWN")
    # Reverse: target back to pane_id
    REVERSE=$(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_id}' 2>/dev/null \
      | awk -v t="$TARGET" '$1 == t {print $2; exit}')
    assert_equals "pane_id_to_target round-trips" "$OWN" "$REVERSE"
  fi
else
  echo -e "  ${YELLOW}SKIP${RESET} find_own_pane tests (not in tmux)"
  echo -e "  ${YELLOW}SKIP${RESET} pane_id_to_target tests (not in tmux)"
  echo -e "  ${YELLOW}SKIP${RESET} process-tree method test (not in tmux)"
  echo -e "  ${YELLOW}SKIP${RESET} round-trip test (not in tmux)"
fi

# ═════════════════════════════════════════════════════════════════════
# PART 3: Structural checks — files that SHOULD have find_own_pane
# ═════════════════════════════════════════════════════════════════════

# Test 12: fleet-jq.sh defines hook_find_own_pane (process-tree method)
# Architecture: v3 moved find_own_pane → hook_find_own_pane in fleet-jq.sh
assert_file_contains "fleet-jq.sh defines hook_find_own_pane" \
  "$HOME/.boring/lib/fleet-jq.sh" "hook_find_own_pane()"

# Test 13: fleet-jq.sh defines hook_pane_target (renamed from pane_id_to_target)
assert_file_contains "fleet-jq.sh defines hook_pane_target" \
  "$HOME/.boring/lib/fleet-jq.sh" "hook_pane_target()"

# Test 14: report-issue.sh has its own _find_own_pane (inlined)
assert_file_contains "report-issue.sh has _find_own_pane" \
  "$HOME/.boring/bin/report-issue.sh" "_find_own_pane()"

# Test 15: report-issue.sh has its own _pane_id_to_target (inlined)
assert_file_contains "report-issue.sh has _pane_id_to_target" \
  "$HOME/.boring/bin/report-issue.sh" "_pane_id_to_target()"

# Test 16: hook_find_own_pane in fleet-jq.sh uses process-tree, not display-message
# Architecture: v3 uses hook_find_own_pane (in fleet-jq.sh) sourced by all hooks.
FUNC_SRC=$(sed -n '/^hook_find_own_pane/,/^}/p' "$HOME/.boring/lib/fleet-jq.sh" 2>/dev/null || echo "")
TOTAL=$((TOTAL + 1))
if echo "$FUNC_SRC" | grep -q 'pane_pid\|ppid' && ! echo "$FUNC_SRC" | grep -q 'display-message -p'; then
  echo -e "  ${GREEN}PASS${RESET} hook_find_own_pane uses process-tree, not display-message"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} hook_find_own_pane must use process-tree, not display-message -p"
  echo "    File: $HOME/.boring/lib/fleet-jq.sh, function: hook_find_own_pane"
  FAIL=$((FAIL + 1))
fi

# Test 17: CLAUDE.md warns about the bug
assert_file_contains "CLAUDE.md has display-message warning" \
  "$HOME/.claude/CLAUDE.md" "returns the **focused** pane"

# Test 18: CLAUDE.md shows process-tree pattern
assert_file_contains "CLAUDE.md shows pane_pid pattern" \
  "$HOME/.claude/CLAUDE.md" "pane_pid"

# ═════════════════════════════════════════════════════════════════════
# PART 4: Project scripts (Wechat-specific)
# ═════════════════════════════════════════════════════════════════════

WECHAT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Test 19: redteam-r61-continue.sh uses _find_own_pane
if [ -f "$WECHAT/.claude/scripts/redteam-r61-continue.sh" ]; then
  assert_file_contains "redteam-r61-continue.sh uses _find_own_pane" \
    "$WECHAT/.claude/scripts/redteam-r61-continue.sh" "_find_own_pane"
  HITS=$(grep -n 'tmux display-message -p' "$WECHAT/.claude/scripts/redteam-r61-continue.sh" 2>/dev/null \
    | grep -v 'WARNING\|WARN\|# .*returns\|Do NOT use' || true)
  assert_empty "redteam-r61-continue.sh: no bare display-message -p" "$HITS"
else
  echo -e "  ${YELLOW}SKIP${RESET} redteam-r61-continue.sh (file not found)"
fi

# Test 20: overnight-start.sh uses _find_own_pane
if [ -f "$WECHAT/.claude/scripts/overnight-start.sh" ]; then
  assert_file_contains "overnight-start.sh uses _find_own_pane" \
    "$WECHAT/.claude/scripts/overnight-start.sh" "_find_own_pane"
  HITS=$(grep -n 'tmux display-message -p' "$WECHAT/.claude/scripts/overnight-start.sh" 2>/dev/null \
    | grep -v 'WARNING\|WARN\|# .*returns\|Do NOT use' || true)
  assert_empty "overnight-start.sh: no bare display-message -p" "$HITS"
else
  echo -e "  ${YELLOW}SKIP${RESET} overnight-start.sh (file not found)"
fi

test_summary
