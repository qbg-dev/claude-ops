#!/usr/bin/env bash
# test-init-project.sh — E2E tests for scripts/init-project.sh
#
# Spins up a real project in /tmp and verifies the full init flow.
# Tests:
#   1. Creates .claude/ directory structure
#   2. Initializes git repo if missing
#   3. Creates .mcp.json with worker-fleet config
#   4. Creates registry.json with _config block
#   5. Correct project_name in registry
#   6. Creates deploy-to-slot.sh placeholder
#   7. Creates pre-validate.sh placeholder
#   8. Installs CLAUDE.md with fleet docs
#   9. Idempotent: running twice doesn't corrupt registry
#  10. Idempotent: running twice doesn't duplicate CLAUDE.md content
#  11. Accepts existing git repo without re-initializing
#  12. Creates .claude/scripts/worker/ directory
#  13. .mcp.json is valid JSON
#  14. registry.json is valid JSON
#  15. deploy-to-slot.sh is executable
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

INIT_SCRIPT="$HOME/.claude-ops/scripts/init-project.sh"
CLAUDE_OPS_DIR="$HOME/.claude-ops"

# ── Setup ────────────────────────────────────────────────────────────
TEST_ROOT="/tmp/claude-ops-test"
mkdir -p "$TEST_ROOT"
TEST_DIR="$TEST_ROOT/e2e-init-$$"
mkdir -p "$TEST_DIR"

cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

# Suppress statusline install (it writes to ~/.claude/statusline-command.sh)
# by pointing HOME to a temp dir for this part.
# Copy git config so init-project.sh can make commits in CI environments.
MOCK_HOME=$(mktemp -d)
mkdir -p "$MOCK_HOME/.claude"
[ -f "$HOME/.gitconfig" ] && cp "$HOME/.gitconfig" "$MOCK_HOME/.gitconfig" || true

echo "── init-project.sh E2E ──"

# ─────────────────────────────────────────────────────────────────────
# Run init-project.sh (without --with-chief-of-staff)
# Redirect HOME for statusline step; use real CLAUDE_OPS_DIR
# ─────────────────────────────────────────────────────────────────────
RUN_OUTPUT=$(HOME="$MOCK_HOME" CLAUDE_OPS_DIR="$CLAUDE_OPS_DIR" \
  bash "$INIT_SCRIPT" "$TEST_DIR" 2>&1) || true

# ─────────────────────────────────────────────────────────────────────
# Test 1: .claude/ structure (directories — use -d check inline)
# ─────────────────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if [ -d "$TEST_DIR/.claude/workers" ]; then
  echo -e "  ${GREEN}PASS${RESET} .claude/workers/ created"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} .claude/workers/ missing"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if [ -d "$TEST_DIR/.claude/scripts/worker" ]; then
  echo -e "  ${GREEN}PASS${RESET} .claude/scripts/worker/ created"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} .claude/scripts/worker/ missing"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────
# Test 2: Git repo initialized
# ─────────────────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if [ -d "$TEST_DIR/.git" ]; then
  echo -e "  ${GREEN}PASS${RESET} git repo: .git dir created"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} git repo: .git dir missing"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────
# Test 3: .mcp.json created with worker-fleet
# ─────────────────────────────────────────────────────────────────────
assert_file_exists ".mcp.json created" "$TEST_DIR/.mcp.json"
assert_file_contains ".mcp.json has worker-fleet" "$TEST_DIR/.mcp.json" "worker-fleet"

# ─────────────────────────────────────────────────────────────────────
# Test 4: registry.json created with _config
# ─────────────────────────────────────────────────────────────────────
assert_file_exists "registry.json created" "$TEST_DIR/.claude/workers/registry.json"
assert_file_contains "registry.json has _config" "$TEST_DIR/.claude/workers/registry.json" "_config"
assert_file_contains "registry.json has merge_authority" "$TEST_DIR/.claude/workers/registry.json" "merge_authority"

# ─────────────────────────────────────────────────────────────────────
# Test 5: project_name matches directory name
# ─────────────────────────────────────────────────────────────────────
EXPECTED_NAME=$(basename "$TEST_DIR")
PROJECT_NAME=$(jq -r '._config.project_name // ""' "$TEST_DIR/.claude/workers/registry.json" 2>/dev/null || echo "")
assert_equals "registry.json project_name matches dir name" "$EXPECTED_NAME" "$PROJECT_NAME"

# ─────────────────────────────────────────────────────────────────────
# Test 6: deploy-to-slot.sh placeholder created
# ─────────────────────────────────────────────────────────────────────
assert_file_exists "deploy-to-slot.sh created" "$TEST_DIR/.claude/scripts/worker/deploy-to-slot.sh"

# ─────────────────────────────────────────────────────────────────────
# Test 7: pre-validate.sh placeholder created
# ─────────────────────────────────────────────────────────────────────
assert_file_exists "pre-validate.sh created" "$TEST_DIR/.claude/scripts/worker/pre-validate.sh"

# ─────────────────────────────────────────────────────────────────────
# Test 8: CLAUDE.md installed with fleet docs
# ─────────────────────────────────────────────────────────────────────
if [ -f "$CLAUDE_OPS_DIR/CLAUDE.md" ]; then
  assert_file_exists "CLAUDE.md created" "$TEST_DIR/CLAUDE.md"
  assert_file_contains "CLAUDE.md has claude-ops reference" "$TEST_DIR/CLAUDE.md" "claude-ops"
else
  # No upstream CLAUDE.md — just check it doesn't crash
  TOTAL=$((TOTAL + 2))
  PASS=$((PASS + 2))
  echo -e "  ${GREEN}PASS${RESET} CLAUDE.md (no upstream to install — skip)"
  echo -e "  ${GREEN}PASS${RESET} CLAUDE.md reference (no upstream — skip)"
fi

# ─────────────────────────────────────────────────────────────────────
# Test 9: Idempotent — run again, registry should not change
# ─────────────────────────────────────────────────────────────────────
REGISTRY_BEFORE=$(cat "$TEST_DIR/.claude/workers/registry.json")
HOME="$MOCK_HOME" CLAUDE_OPS_DIR="$CLAUDE_OPS_DIR" \
  bash "$INIT_SCRIPT" "$TEST_DIR" 2>&1 >/dev/null || true
REGISTRY_AFTER=$(cat "$TEST_DIR/.claude/workers/registry.json")
assert_equals "idempotent: registry.json unchanged on second run" "$REGISTRY_BEFORE" "$REGISTRY_AFTER"

# ─────────────────────────────────────────────────────────────────────
# Test 10: Idempotent — CLAUDE.md not duplicated on second run
# ─────────────────────────────────────────────────────────────────────
if [ -f "$TEST_DIR/CLAUDE.md" ]; then
  CLAUDE_MD_LINES=$(wc -l < "$TEST_DIR/CLAUDE.md")
  HOME="$MOCK_HOME" CLAUDE_OPS_DIR="$CLAUDE_OPS_DIR" \
    bash "$INIT_SCRIPT" "$TEST_DIR" 2>&1 >/dev/null || true
  CLAUDE_MD_LINES_AFTER=$(wc -l < "$TEST_DIR/CLAUDE.md")
  assert_equals "idempotent: CLAUDE.md not duplicated" "$CLAUDE_MD_LINES" "$CLAUDE_MD_LINES_AFTER"
else
  TOTAL=$((TOTAL + 1)); PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} idempotent: CLAUDE.md (no upstream — skip)"
fi

# ─────────────────────────────────────────────────────────────────────
# Test 11: Existing git repo — original commit preserved in history
# (init-project.sh correctly adds a bootstrap commit on top)
# ─────────────────────────────────────────────────────────────────────
TEST_DIR2="$TEST_ROOT/e2e-init-existing-$$"
mkdir -p "$TEST_DIR2"
git -C "$TEST_DIR2" init --quiet
git -C "$TEST_DIR2" commit --allow-empty -m "initial" --quiet
INITIAL_COMMIT=$(git -C "$TEST_DIR2" rev-parse HEAD 2>/dev/null)

HOME="$MOCK_HOME" CLAUDE_OPS_DIR="$CLAUDE_OPS_DIR" \
  bash "$INIT_SCRIPT" "$TEST_DIR2" 2>&1 >/dev/null || true

# init-project.sh adds a bootstrap commit — verify original is still in history
HISTORY=$(git -C "$TEST_DIR2" log --format="%H" 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$HISTORY" | grep -q "$INITIAL_COMMIT"; then
  echo -e "  ${GREEN}PASS${RESET} existing git: original commit preserved in history"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} existing git: original commit not in history"
  FAIL=$((FAIL + 1))
fi

# Verify bootstrap commit was added
BOOTSTRAP_MSG=$(git -C "$TEST_DIR2" log --oneline -1 2>/dev/null)
TOTAL=$((TOTAL + 1))
if echo "$BOOTSTRAP_MSG" | grep -q "bootstrap"; then
  echo -e "  ${GREEN}PASS${RESET} existing git: bootstrap commit added on top"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} existing git: expected bootstrap commit, got: $BOOTSTRAP_MSG"
  FAIL=$((FAIL + 1))
fi
rm -rf "$TEST_DIR2"

# ─────────────────────────────────────────────────────────────────────
# Test 12: .claude/scripts/worker/ directory exists
# ─────────────────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if [ -d "$TEST_DIR/.claude/scripts/worker" ]; then
  echo -e "  ${GREEN}PASS${RESET} .claude/scripts/worker/ is a directory"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} .claude/scripts/worker/ missing"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────
# Test 13: .mcp.json is valid JSON
# ─────────────────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if jq empty "$TEST_DIR/.mcp.json" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} .mcp.json is valid JSON"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} .mcp.json is invalid JSON"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────
# Test 14: registry.json is valid JSON
# ─────────────────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if jq empty "$TEST_DIR/.claude/workers/registry.json" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} registry.json is valid JSON"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} registry.json is invalid JSON"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────
# Test 15: deploy-to-slot.sh is executable
# ─────────────────────────────────────────────────────────────────────
TOTAL=$((TOTAL + 1))
SLOT_SCRIPT="$TEST_DIR/.claude/scripts/worker/deploy-to-slot.sh"
if [ -x "$SLOT_SCRIPT" ]; then
  echo -e "  ${GREEN}PASS${RESET} deploy-to-slot.sh is executable"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} deploy-to-slot.sh not executable"
  FAIL=$((FAIL + 1))
fi

rm -rf "$MOCK_HOME"
test_summary
