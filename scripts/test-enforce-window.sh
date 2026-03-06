#!/usr/bin/env bash
# test-enforce-window.sh — Test the enforce_window logic by creating test panes,
# putting them in wrong windows, then running enforcement.
set -euo pipefail

SESSION="test-enforce"
PASS=0
FAIL=0

_assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

_pane_window() {
  tmux list-panes -a -F '#{pane_id} #{window_name}' 2>/dev/null \
    | awk -v p="$1" '$1==p{print $2}'
}

_cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}
trap _cleanup EXIT

echo "=== Test: enforce_window logic ==="
echo ""

# Create test session with 3 windows: alpha, beta, gamma
tmux new-session -d -s "$SESSION" -n "alpha" -x 120 -y 30
PANE_A=$(tmux list-panes -t "$SESSION:alpha" -F '#{pane_id}' | head -1)
tmux select-pane -T "worker-a" -t "$PANE_A"

PANE_B=$(tmux new-window -t "$SESSION" -n "beta" -d -P -F '#{pane_id}')
tmux select-pane -T "worker-b" -t "$PANE_B"

PANE_C=$(tmux split-window -t "$SESSION:alpha" -d -P -F '#{pane_id}')
tmux select-pane -T "worker-c" -t "$PANE_C"

echo "Setup: PANE_A=$PANE_A (alpha), PANE_B=$PANE_B (beta), PANE_C=$PANE_C (alpha)"
echo ""

# ── Test 1: Pane already in correct window → no-op ──
echo "Test 1: Pane in correct window (no-op)"
_assert "PANE_A in alpha" "alpha" "$(_pane_window "$PANE_A")"

# ── Test 2: Move PANE_A to beta (wrong), then enforce back to alpha ──
echo ""
echo "Test 2: Move pane to wrong window, then enforce"
# Move PANE_A to beta
tmux join-pane -s "$PANE_A" -t "$SESSION:beta" -d 2>/dev/null
tmux select-layout -t "$SESSION:beta" tiled 2>/dev/null || true
_assert "PANE_A moved to beta" "beta" "$(_pane_window "$PANE_A")"

# Enforce: PANE_A should be in alpha
TARGET_WIN="alpha"
ACTUAL_WIN=$(_pane_window "$PANE_A")
if [ "$ACTUAL_WIN" != "$TARGET_WIN" ]; then
  # Ensure target window exists
  if ! tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qxF "$TARGET_WIN"; then
    tmux new-window -t "$SESSION" -n "$TARGET_WIN" -d
  fi
  tmux join-pane -s "$PANE_A" -t "$SESSION:$TARGET_WIN" -d 2>/dev/null
  tmux select-layout -t "$SESSION:$TARGET_WIN" tiled 2>/dev/null || true
fi
_assert "PANE_A enforced back to alpha" "alpha" "$(_pane_window "$PANE_A")"

# ── Test 3: Enforce to a window that doesn't exist yet → create + move ──
echo ""
echo "Test 3: Enforce to non-existent window (creates it)"
TARGET_WIN="newgroup"
ACTUAL_WIN=$(_pane_window "$PANE_B")
if [ "$ACTUAL_WIN" != "$TARGET_WIN" ]; then
  if ! tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qxF "$TARGET_WIN"; then
    tmux new-window -t "$SESSION" -n "$TARGET_WIN" -d
  fi
  tmux join-pane -s "$PANE_B" -t "$SESSION:$TARGET_WIN" -d 2>/dev/null
  tmux select-layout -t "$SESSION:$TARGET_WIN" tiled 2>/dev/null || true
fi
_assert "PANE_B moved to newgroup" "newgroup" "$(_pane_window "$PANE_B")"
# Verify window was created
HAS_NEWGROUP=$(tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -cxF "newgroup")
_assert "newgroup window exists" "1" "$HAS_NEWGROUP"

# ── Test 4: Multiple panes enforced to same window → tiled ──
echo ""
echo "Test 4: Multiple panes to same window"
# Move PANE_C to newgroup too
tmux join-pane -s "$PANE_C" -t "$SESSION:newgroup" -d 2>/dev/null
tmux select-layout -t "$SESSION:newgroup" tiled 2>/dev/null || true
_assert "PANE_C moved to newgroup" "newgroup" "$(_pane_window "$PANE_C")"
PANE_COUNT=$(tmux list-panes -t "$SESSION:newgroup" -F '#{pane_id}' | wc -l | tr -d ' ')
_assert "newgroup has 2+ panes" "1" "$([ "$PANE_COUNT" -ge 2 ] && echo 1 || echo 0)"

# ── Test 5: Pane is the only one in a window → move leaves empty window (auto-deleted by tmux) ──
echo ""
echo "Test 5: Last pane in window auto-deletes the window"
# Create a solo window
PANE_SOLO=$(tmux new-window -t "$SESSION" -n "solo" -d -P -F '#{pane_id}')
_assert "solo window exists before" "1" "$(tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -cxF "solo")"
# Move it away
tmux join-pane -s "$PANE_SOLO" -t "$SESSION:alpha" -d 2>/dev/null
tmux select-layout -t "$SESSION:alpha" tiled 2>/dev/null || true
SOLO_EXISTS=$(tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -cxF "solo" || true)
_assert "solo window auto-deleted" "0" "${SOLO_EXISTS:-0}"

# Kill the extra pane we just moved
tmux kill-pane -t "$PANE_SOLO" 2>/dev/null || true

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"

[ "$FAIL" -gt 0 ] && exit 1
exit 0
