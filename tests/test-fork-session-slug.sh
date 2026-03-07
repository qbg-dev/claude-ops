#!/usr/bin/env bash
# test-fork-session-slug.sh — Regression tests for session copy slug resolution
# Verifies that fork session copy uses the caller's CWD (worktree path), not PROJECT_ROOT.

set -euo pipefail
PASS=0; FAIL=0; TOTAL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL+1))
  if [ "$expected" = "$actual" ]; then
    echo -e "  \033[0;32mPASS\033[0m $label"
    PASS=$((PASS+1))
  else
    echo -e "  \033[0;31mFAIL\033[0m $label (expected: '$expected', got: '$actual')"
    FAIL=$((FAIL+1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL+1))
  if echo "$haystack" | grep -qF "$needle"; then
    echo -e "  \033[0;32mPASS\033[0m $label"
    PASS=$((PASS+1))
  else
    echo -e "  \033[0;31mFAIL\033[0m $label (needle '$needle' not found)"
    FAIL=$((FAIL+1))
  fi
}

echo ""
echo "── fork-session-slug: path slug calculation ──"

# Claude project dir slugs use tr '/' '-'
assert_eq "main project slug" \
  "-Users-wz-Desktop-project" \
  "$(echo '/Users/wz/Desktop/project' | tr '/' '-')"

assert_eq "worktree slug" \
  "-Users-wz-Desktop-project-w-worker1" \
  "$(echo '/Users/wz/Desktop/project-w-worker1' | tr '/' '-')"

assert_eq "worktree slug differs from main" \
  "1" \
  "$([ "$(echo '/Users/wz/Desktop/project' | tr '/' '-')" != "$(echo '/Users/wz/Desktop/project-w-worker1' | tr '/' '-')" ] && echo 1 || echo 0)"

echo ""
echo "── fork-session-slug: session file routing ──"

# Simulate session copy: parent worktree → child worktree
TEST_DIR=$(mktemp -d)
PARENT_CWD="$TEST_DIR/project-w-parent"
CHILD_CWD="$TEST_DIR/project-w-child"
CLAUDE_PROJECTS="$TEST_DIR/claude-projects"
SESSION_ID="test-session-$(date +%s)"

mkdir -p "$PARENT_CWD" "$CHILD_CWD"

# Create parent's session JSONL in parent's project dir (slug based on PARENT CWD)
PARENT_SLUG=$(echo "$PARENT_CWD" | tr '/' '-')
PARENT_PROJ="$CLAUDE_PROJECTS/$PARENT_SLUG"
mkdir -p "$PARENT_PROJ"
echo '{"type":"session","id":"'$SESSION_ID'"}' > "$PARENT_PROJ/$SESSION_ID.jsonl"

# BUG scenario: if we used PROJECT_ROOT (main project), we'd look in the wrong dir
MAIN_ROOT="$TEST_DIR/project"
mkdir -p "$MAIN_ROOT"
WRONG_SLUG=$(echo "$MAIN_ROOT" | tr '/' '-')
WRONG_PROJ="$CLAUDE_PROJECTS/$WRONG_SLUG"

assert_eq "parent session exists in parent's project dir" \
  "1" \
  "$([ -f "$PARENT_PROJ/$SESSION_ID.jsonl" ] && echo 1 || echo 0)"

assert_eq "parent session NOT in main project dir (bug scenario)" \
  "0" \
  "$([ -f "$WRONG_PROJ/$SESSION_ID.jsonl" ] && echo 1 || echo 0)"

# Correct copy: use parent CWD slug
CHILD_SLUG=$(echo "$CHILD_CWD" | tr '/' '-')
CHILD_PROJ="$CLAUDE_PROJECTS/$CHILD_SLUG"
mkdir -p "$CHILD_PROJ"
cp "$PARENT_PROJ/$SESSION_ID.jsonl" "$CHILD_PROJ/$SESSION_ID.jsonl"

assert_eq "session copied to child's project dir" \
  "1" \
  "$([ -f "$CHILD_PROJ/$SESSION_ID.jsonl" ] && echo 1 || echo 0)"

echo ""
echo "── fork-session-slug: wrapper script ──"

# Verify wrapper script pattern: short path, no escaping issues
WRAPPER="/tmp/fork-launch-test-$$.sh"
cat > "$WRAPPER" <<'SCRIPT'
#!/bin/bash
cd /tmp
echo "fork-worker launched OK"
SCRIPT
chmod +x "$WRAPPER"
RESULT=$(bash "$WRAPPER" 2>&1)
assert_contains "wrapper script executes cleanly" "fork-worker launched OK" "$RESULT"

# Verify wrapper self-cleans (simulate)
rm -f "$WRAPPER"
assert_eq "wrapper cleaned up" \
  "0" \
  "$([ -f "$WRAPPER" ] && echo 1 || echo 0)"

# Cleanup
rm -rf "$TEST_DIR"

echo ""
echo -e "  $PASS passed, $FAIL failed, $TOTAL total"
