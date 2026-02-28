#!/usr/bin/env bash
# test-scaffold.sh — Tests for scripts/scaffold.sh (v3 structure)
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

SCAFFOLD="$HOME/.claude-ops/scripts/scaffold.sh"
HARNESS_NAME="test-scaffold-$$"

# Setup temp project
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR"
HARNESS_DIR="$TMPDIR/.claude/harness/$HARNESS_NAME"
MM_DIR="$HARNESS_DIR/agents/module-manager"

cleanup() {
  rm -rf "$TMPDIR"
  rm -rf "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME"
  rm -rf "$HOME/.claude-ops/harness/manifests/${HARNESS_NAME}-lr"
  rm -rf "$HOME/.claude-ops/harness/manifests/${HARNESS_NAME}-desc"
  rm -rf "$HOME/.claude-ops/harness/reports/$HARNESS_NAME"
  rm -rf "$HOME/.claude-ops/state/playwright/$HARNESS_NAME"
}
trap cleanup EXIT

echo "── scaffold.sh (v3) ──"

# Scaffold baseline harness
bash "$SCAFFOLD" "$HARNESS_NAME" "$TMPDIR"

# ── Harness root files ────────────────────────────────────────────────

# Test 1: Creates tasks.json at root (not progress.json)
assert_file_exists "creates tasks.json" "$HARNESS_DIR/tasks.json"

# Test 2: tasks.json has correct structure
TOTAL=$((TOTAL + 1))
if jq -e '.tasks' "$HARNESS_DIR/tasks.json" > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} tasks.json has .tasks key"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} tasks.json missing .tasks key"
  FAIL=$((FAIL + 1))
fi

# Test 3: Creates harness.md
assert_file_exists "creates harness.md" "$HARNESS_DIR/harness.md"

# Test 4: Creates policy.json
assert_file_exists "creates policy.json" "$HARNESS_DIR/policy.json"

# Test 5: Creates spec.md
assert_file_exists "creates spec.md" "$HARNESS_DIR/spec.md"

# Test 6: Creates acceptance.md
assert_file_exists "creates acceptance.md" "$HARNESS_DIR/acceptance.md"

# ── agents/module-manager/ files ─────────────────────────────────────

# Test 7: Creates agents/module-manager/config.json
assert_file_exists "creates agents/module-manager/config.json" "$MM_DIR/config.json"

# Test 8: config.json has lifecycle=bounded by default
TOTAL=$((TOTAL + 1))
LIFECYCLE=$(jq -r '.lifecycle' "$MM_DIR/config.json" 2>/dev/null)
if [ "$LIFECYCLE" = "bounded" ]; then
  echo -e "  ${GREEN}PASS${RESET} config.json lifecycle=bounded by default"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} config.json lifecycle expected 'bounded', got '$LIFECYCLE'"
  FAIL=$((FAIL + 1))
fi

# Test 9: config.json has created_at timestamp
TOTAL=$((TOTAL + 1))
CREATED_AT=$(jq -r '.created_at' "$MM_DIR/config.json" 2>/dev/null)
if [ -n "$CREATED_AT" ] && [ "$CREATED_AT" != "null" ]; then
  echo -e "  ${GREEN}PASS${RESET} config.json has created_at ($CREATED_AT)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} config.json created_at is missing"
  FAIL=$((FAIL + 1))
fi

# Test 10: config.json has rotation block
TOTAL=$((TOTAL + 1))
CMD_VAL=$(jq -r '.rotation.claude_command' "$MM_DIR/config.json" 2>/dev/null)
if [ "$CMD_VAL" = "cdo" ]; then
  echo -e "  ${GREEN}PASS${RESET} config.json rotation.claude_command=cdo"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} rotation.claude_command expected 'cdo', got '$CMD_VAL'"
  FAIL=$((FAIL + 1))
fi

# Test 11: Creates state.json
assert_file_exists "creates agents/module-manager/state.json" "$MM_DIR/state.json"

# Test 12: state.json has cycles_completed=0
TOTAL=$((TOTAL + 1))
CYCLES=$(jq -r '.cycles_completed' "$MM_DIR/state.json" 2>/dev/null)
if [ "$CYCLES" = "0" ]; then
  echo -e "  ${GREEN}PASS${RESET} state.json cycles_completed=0"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} state.json cycles_completed expected '0', got '$CYCLES'"
  FAIL=$((FAIL + 1))
fi

# Test 13: Creates MEMORY.md
assert_file_exists "creates agents/module-manager/MEMORY.md" "$MM_DIR/MEMORY.md"

# Test 14: Creates inbox.jsonl and outbox.jsonl inside module-manager
assert_file_exists "creates module-manager/inbox.jsonl" "$MM_DIR/inbox.jsonl"
assert_file_exists "creates module-manager/outbox.jsonl" "$MM_DIR/outbox.jsonl"

# Test 15: Creates permissions.json
assert_file_exists "creates agents/module-manager/permissions.json" "$MM_DIR/permissions.json"

# Test 16: permissions.json uses bypassPermissions
TOTAL=$((TOTAL + 1))
PERM_MODE=$(jq -r '.permission_mode' "$MM_DIR/permissions.json" 2>/dev/null)
if [ "$PERM_MODE" = "bypassPermissions" ]; then
  echo -e "  ${GREEN}PASS${RESET} permissions.json uses bypassPermissions"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} permission_mode expected 'bypassPermissions', got '$PERM_MODE'"
  FAIL=$((FAIL + 1))
fi

# Test 17: permissions.json has disallowedTools (not empty)
TOTAL=$((TOTAL + 1))
DT_COUNT=$(jq '.disallowedTools | length' "$MM_DIR/permissions.json" 2>/dev/null)
if [ "$DT_COUNT" -gt 0 ]; then
  echo -e "  ${GREEN}PASS${RESET} permissions.json has $DT_COUNT disallowedTools"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} permissions.json disallowedTools is empty"
  FAIL=$((FAIL + 1))
fi

# Test 18: Creates mission.md
assert_file_exists "creates agents/module-manager/mission.md" "$MM_DIR/mission.md"

# ── Seed script ───────────────────────────────────────────────────────

# Test 19: Creates seed.sh (executable)
assert_file_exists "creates seed.sh" "$TMPDIR/.claude/scripts/${HARNESS_NAME}-seed.sh"
TOTAL=$((TOTAL + 1))
if [ -x "$TMPDIR/.claude/scripts/${HARNESS_NAME}-seed.sh" ]; then
  echo -e "  ${GREEN}PASS${RESET} seed.sh is executable"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} seed.sh is not executable"
  FAIL=$((FAIL + 1))
fi

# Test 20: Seed script generates non-empty output
TOTAL=$((TOTAL + 1))
SEED_OUTPUT=$(bash "$TMPDIR/.claude/scripts/${HARNESS_NAME}-seed.sh" 2>/dev/null || true)
if [ -n "$SEED_OUTPUT" ]; then
  echo -e "  ${GREEN}PASS${RESET} seed.sh generates non-empty output (${#SEED_OUTPUT} chars)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} seed.sh produced empty output"
  FAIL=$((FAIL + 1))
fi

# Test 21: Seed references agents/module-manager/ paths
TOTAL=$((TOTAL + 1))
if echo "$SEED_OUTPUT" | grep -q 'agents/module-manager'; then
  echo -e "  ${GREEN}PASS${RESET} seed references agents/module-manager paths"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} seed doesn't reference agents/module-manager"
  FAIL=$((FAIL + 1))
fi

# ── Manifest ──────────────────────────────────────────────────────────

# Test 22: Creates manifest
assert_file_exists "creates manifest" "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json"

# Test 23: Manifest has correct harness name
MANIFEST_NAME=$(jq -r '.harness' "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json")
assert_equals "manifest has correct harness name" "$HARNESS_NAME" "$MANIFEST_NAME"

# Test 24: Manifest has correct project root
MANIFEST_ROOT=$(jq -r '.project_root' "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json")
assert_equals "manifest has correct project root" "$TMPDIR" "$MANIFEST_ROOT"

# Test 25: Manifest has type=module-manager (not sidecar)
TOTAL=$((TOTAL + 1))
MANIFEST_TYPE=$(jq -r '.type' "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json")
MANIFEST_STATUS=$(jq -r '.status' "$HOME/.claude-ops/harness/manifests/$HARNESS_NAME/manifest.json")
if [ "$MANIFEST_TYPE" = "module-manager" ] && [ "$MANIFEST_STATUS" = "active" ]; then
  echo -e "  ${GREEN}PASS${RESET} manifest has type=module-manager and status=active"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} manifest type=$MANIFEST_TYPE status=$MANIFEST_STATUS"
  FAIL=$((FAIL + 1))
fi

# ── Template substitution ─────────────────────────────────────────────

# Test 26: Templates properly substituted (no {{HARNESS}} left)
TOTAL=$((TOTAL + 1))
if grep -rq '{{HARNESS}}' "$HARNESS_DIR/"* "$TMPDIR/.claude/scripts/${HARNESS_NAME}-"* 2>/dev/null; then
  echo -e "  ${RED}FAIL${RESET} templates not fully substituted"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} templates fully substituted"
  PASS=$((PASS + 1))
fi

# ── Idempotency ───────────────────────────────────────────────────────

# Test 27: Re-scaffold preserves existing spec.md
echo "custom spec content $$" > "$HARNESS_DIR/spec.md"
bash "$SCAFFOLD" "$HARNESS_NAME" "$TMPDIR"
TOTAL=$((TOTAL + 1))
if grep -qF "custom spec content $$" "$HARNESS_DIR/spec.md" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} re-scaffold preserves existing spec.md"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} re-scaffold overwrote spec.md"
  FAIL=$((FAIL + 1))
fi

# Test 28: Re-scaffold preserves existing inbox.jsonl
echo '{"ts":"2026-01-01","from":"test","type":"status","content":"preserved"}' > "$MM_DIR/inbox.jsonl"
bash "$SCAFFOLD" "$HARNESS_NAME" "$TMPDIR"
TOTAL=$((TOTAL + 1))
if grep -qF "preserved" "$MM_DIR/inbox.jsonl" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} re-scaffold preserves existing module-manager/inbox.jsonl"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} re-scaffold overwrote module-manager/inbox.jsonl"
  FAIL=$((FAIL + 1))
fi

# ── Flags ─────────────────────────────────────────────────────────────

# Test 29: --long-running flag sets lifecycle in config.json
HARNESS_LR="${HARNESS_NAME}-lr"
bash "$SCAFFOLD" --long-running "$HARNESS_LR" "$TMPDIR"
TOTAL=$((TOTAL + 1))
LR_LIFECYCLE=$(jq -r '.lifecycle' "$TMPDIR/.claude/harness/${HARNESS_LR}/agents/module-manager/config.json" 2>/dev/null)
if [ "$LR_LIFECYCLE" = "long-running" ]; then
  echo -e "  ${GREEN}PASS${RESET} --long-running sets lifecycle=long-running in config.json"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} --long-running lifecycle expected 'long-running', got '$LR_LIFECYCLE'"
  FAIL=$((FAIL + 1))
fi

# Test 30: --from-description sets mission in config.json and spec.md
HARNESS_DESC="${HARNESS_NAME}-desc"
bash "$SCAFFOLD" --from-description "Fix the slow login page" "$HARNESS_DESC" "$TMPDIR"
TOTAL=$((TOTAL + 1))
DESC_MISSION=$(jq -r '.mission' "$TMPDIR/.claude/harness/${HARNESS_DESC}/agents/module-manager/config.json")
if [ "$DESC_MISSION" = "Fix the slow login page" ]; then
  echo -e "  ${GREEN}PASS${RESET} --from-description sets mission in config.json"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} --from-description mission expected 'Fix the slow login page', got '$DESC_MISSION'"
  FAIL=$((FAIL + 1))
fi

# Test 31: --from-description populates spec.md Goal
TOTAL=$((TOTAL + 1))
if grep -qF "## Goal" "$TMPDIR/.claude/harness/${HARNESS_DESC}/spec.md" && \
   grep -qF "Fix the slow login page" "$TMPDIR/.claude/harness/${HARNESS_DESC}/spec.md"; then
  echo -e "  ${GREEN}PASS${RESET} --from-description populates spec.md goal"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} --from-description didn't populate spec.md"
  FAIL=$((FAIL + 1))
fi

# Test 32: Fails with no args
assert_exit "fails with no args" 1 bash "$SCAFFOLD"

# Test 33: No progress.json created (v2 artifact — must not exist)
TOTAL=$((TOTAL + 1))
if [ ! -f "$HARNESS_DIR/progress.json" ]; then
  echo -e "  ${GREEN}PASS${RESET} no progress.json created (v3 only)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} progress.json should not exist in v3 scaffolds"
  FAIL=$((FAIL + 1))
fi

# Test 34: No agents/sidecar/ directory created
TOTAL=$((TOTAL + 1))
if [ ! -d "$HARNESS_DIR/agents/sidecar" ]; then
  echo -e "  ${GREEN}PASS${RESET} no agents/sidecar/ created (module-manager only)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} agents/sidecar/ should not be created in v3"
  FAIL=$((FAIL + 1))
fi

test_summary
