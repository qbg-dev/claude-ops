#!/usr/bin/env bash
# test-watchdog-cpu-gate.sh — Unit tests for the watchdog's CPU-based activity gate,
# bare-shell detection patterns, liveness decision tree, and WORKER_NAME propagation.
#
# These tests verify that the watchdog correctly distinguishes between:
# 1. Active agent (CPU busy) → skip all heuristic checks
# 2. Idle agent with stale liveness → bare-shell/stuck detection
# 3. Fresh liveness → skip (agent recently used tools)
# 4. Agent cmd includes WORKER_NAME for hook integration
set -uo pipefail

source "$(dirname "$0")/helpers.sh"

WATCHDOG_SH="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# ══════════════════════════════════════════════════════════════════════
# _is_pane_process_busy — CPU gate function
# ══════════════════════════════════════════════════════════════════════
echo "── watchdog: _is_pane_process_busy function ──"

# Test: function exists in watchdog
assert_file_contains "CPU gate function exists" "$WATCHDOG_SH" "_is_pane_process_busy()"

# Test: function checks pane PID via tmux list-panes
assert_file_contains "CPU gate resolves pane PID" "$WATCHDOG_SH" 'tmux list-panes -a -F'

# Test: function uses ps to check CPU usage
assert_file_contains "CPU gate checks process CPU" "$WATCHDOG_SH" 'ps -o %cpu='

# Test: function aggregates CPU across process group (descendants)
assert_file_contains "CPU gate uses process group (-g)" "$WATCHDOG_SH" 'ps -o %cpu= -g'

# Test: function returns 1 (false) when no pane PID found
assert_file_contains "CPU gate returns 1 for missing pane" "$WATCHDOG_SH" '[ -z "$pane_pid" ] && return 1'

# Test: CPU threshold is >5%
assert_file_contains "CPU gate uses 5% threshold" "$WATCHDOG_SH" '"$total_cpu" -gt 5'

echo ""
echo "── watchdog: CPU gate wired into detection flow ──"

# Test: CPU gate is called before bare-shell detection
# The function must appear BEFORE the bare-shell grep check
CPU_LINE=$(grep -n '_is_pane_process_busy' "$WATCHDOG_SH" | grep -v '^#' | grep -v 'function' | head -1 | cut -d: -f1)
BARESHELL_LINE=$(grep -n 'BARE-SHELL' "$WATCHDOG_SH" | head -1 | cut -d: -f1)
if [ -n "$CPU_LINE" ] && [ -n "$BARESHELL_LINE" ] && [ "$CPU_LINE" -lt "$BARESHELL_LINE" ]; then
  TOTAL=$((TOTAL + 1)); PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} CPU gate called before bare-shell detection"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} CPU gate not called before bare-shell detection (CPU=$CPU_LINE, BARESHELL=$BARESHELL_LINE)"
fi

# Test: CPU gate clears stuck-candidate marker when agent is busy
assert_file_contains "CPU gate clears stuck-candidate" "$WATCHDOG_SH" 'rm -f "$(_worker_runtime "$worker")/stuck-candidate"'

# Test: CPU gate returns early (skips all heuristic checks)
# Should be "return" (no argument) or "return 0" after the CPU check
TOTAL=$((TOTAL + 1))
CPU_BLOCK=$(sed -n '/_is_pane_process_busy/,/^    fi/p' "$WATCHDOG_SH" | grep -c 'return')
if [ "$CPU_BLOCK" -gt 0 ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} CPU gate returns early when agent is busy"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} CPU gate doesn't return early"
fi

# ══════════════════════════════════════════════════════════════════════
# Bare-shell detection patterns
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog: bare-shell detection patterns ──"

# Extract the bare-shell grep pattern from the script
PATTERN=$(grep -E "grep -qiE" "$WATCHDOG_SH" | head -1 | sed "s/.*grep -qiE '//;s/'.*//" || true)

if [ -n "$PATTERN" ]; then
  # These should MATCH (Claude TUI is running — NOT bare shell)
  echo "bypass permissions mode" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'bypass permissions' matches TUI check" "match" "$STATUS"

  echo "Thinking..." | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Thinking' matches TUI check" "match" "$STATUS"

  echo "thinking hard about the problem" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: lowercase 'thinking' matches (case insensitive)" "match" "$STATUS"

  echo "Osmosing context..." | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Osmosing' spinner matches" "match" "$STATUS"

  echo "Booping the loop" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Booping' spinner matches" "match" "$STATUS"

  echo "Garnishing the output" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Garnishing' spinner matches" "match" "$STATUS"

  echo "Reading file.txt" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Reading' activity matches" "match" "$STATUS"

  echo "Writing to disk" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Writing' activity matches" "match" "$STATUS"

  echo "Running bun test" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Running' activity matches" "match" "$STATUS"

  echo "Worked for 5m23s" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'Worked for' matches" "match" "$STATUS"

  echo "❯ " | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: prompt (❯) matches" "match" "$STATUS"

  echo "Press esc to interrupt" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: 'esc to interrupt' matches" "match" "$STATUS"

  # These should NOT match (bare shell — Claude not running)
  echo "kevinster@Mac-Mini ~ %" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: zsh prompt is NOT TUI" "no-match" "$STATUS"

  echo "bash-5.2\$" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: bash prompt is NOT TUI" "no-match" "$STATUS"

  echo "Last login: Mon Mar 8 12:00:00" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: login message is NOT TUI" "no-match" "$STATUS"

  echo "" | grep -qiE "$PATTERN" && STATUS="match" || STATUS="no-match"
  assert_equals "bare-shell: empty line is NOT TUI" "no-match" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} Could not extract bare-shell grep pattern from watchdog"
fi

# ══════════════════════════════════════════════════════════════════════
# WORKER_NAME propagation in _build_agent_cmd
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog: WORKER_NAME in agent command ──"

# Test: _build_agent_cmd includes WORKER_NAME=$worker in the env
assert_file_contains "agent cmd sets WORKER_NAME" "$WATCHDOG_SH" 'WORKER_NAME=$worker claude'

# Test: liveness heartbeat uses WORKER_NAME
LIVENESS_SH="$HOME/.claude-ops/hooks/publishers/liveness-heartbeat.sh"
assert_file_contains "liveness hook reads WORKER_NAME" "$LIVENESS_SH" 'WORKER="${WORKER_NAME:-}"'
assert_file_contains "liveness hook exits on empty WORKER" "$LIVENESS_SH" '[ -z "$WORKER" ] && exit 0'
assert_file_contains "liveness hook writes epoch to file" "$LIVENESS_SH" 'date +%s > "$RUNTIME_DIR/liveness"'

# ══════════════════════════════════════════════════════════════════════
# Liveness decision tree
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog: liveness decision tree ──"

# Test: liveness threshold is 300s (5 min)
assert_file_contains "liveness threshold is 300s" "$WATCHDOG_SH" 'since_active" -lt 300'

# Test: liveness file seeding on first check
assert_file_contains "seeds liveness file on first check" "$WATCHDOG_SH" "LIVENESS-SEED"

# Test: liveness file corruption guard (non-numeric)
assert_file_contains "guards against non-numeric liveness" "$WATCHDOG_SH" 'last_active" =~ ^[0-9]+$'

# Test: relaunch cooldown (120s)
assert_file_contains "relaunch cooldown is 120s" "$WATCHDOG_SH" '"$_since_relaunch" -lt 120'

# ══════════════════════════════════════════════════════════════════════
# Stuck detection — _check_scrollback_stuck
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog: scrollback stuck detection ──"

# Test: _check_scrollback_stuck uses md5 hash for content comparison
TOTAL=$((TOTAL + 1))
HAS_HASH=$(grep -c 'scrollback-hash\|md5' "$WATCHDOG_SH" || echo 0)
if [ "$HAS_HASH" -ge 2 ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} scrollback stuck detection uses hash comparison"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} scrollback stuck detection missing hash comparison"
fi

# Test: stuck candidate marker file pattern
assert_file_contains "stuck-candidate marker used" "$WATCHDOG_SH" "stuck-candidate"

# Test: STUCK_THRESHOLD_SEC is configurable via env
assert_file_contains "STUCK_THRESHOLD_SEC is env-configurable" "$WATCHDOG_SH" 'WATCHDOG_STUCK_THRESHOLD:-'

# ══════════════════════════════════════════════════════════════════════
# Crash loop guard
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog: crash loop guard ──"

# Test: crash loop is detected
assert_file_contains "crash loop detection function exists" "$WATCHDOG_SH" "_is_crash_looped"

# Test: MAX_CRASHES_PER_HR configurable
assert_file_contains "max crashes per hour is configurable" "$WATCHDOG_SH" 'WATCHDOG_MAX_CRASHES:-'

# Test: crash count file path uses worker name
assert_file_contains "crash count scoped to worker" "$WATCHDOG_SH" '_crash_count_file()'

# ══════════════════════════════════════════════════════════════════════
# Registry locking
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── watchdog: registry locking ──"

assert_file_contains "registry lock uses mkdir (atomic)" "$WATCHDOG_SH" 'mkdir "$_REG_LOCK"'
assert_file_contains "registry unlock uses rmdir" "$WATCHDOG_SH" 'rmdir "$_REG_LOCK"'
assert_file_contains "lock wait timeout prevents deadlock" "$WATCHDOG_SH" '_w" -ge 10'

test_summary
