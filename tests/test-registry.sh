#!/usr/bin/env bash
# test-registry.sh — Tests for the manifest-based registry system.
# Uses a self-contained fixture harness to avoid coupling to real registered harnesses.
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

echo "── manifest registry ──"

# ── Fixture setup ────────────────────────────────────────────────────────────
FIXTURE_NAME="test-registry-fixture-$$"
FIXTURE_PROJECT=$(mktemp -d)
FIXTURE_MANIFEST_DIR="$HOME/.claude-ops/harness/manifests/$FIXTURE_NAME"

cleanup() {
  rm -rf "$FIXTURE_MANIFEST_DIR" "$FIXTURE_PROJECT"
}
trap cleanup EXIT

# Create a minimal progress file the active-list function can find
mkdir -p "$FIXTURE_PROJECT"
echo '{"status":"active","tasks":{}}' > "$FIXTURE_PROJECT/tasks.json"

# Create the manifest
mkdir -p "$FIXTURE_MANIFEST_DIR"
jq -n \
  --arg name "$FIXTURE_NAME" \
  --arg root "$FIXTURE_PROJECT" \
  '{harness: $name, project_root: $root, status: "active",
    files: {progress: "tasks.json"}}' \
  > "$FIXTURE_MANIFEST_DIR/manifest.json"

# ── Test 1: Manifest directory exists ────────────────────────────────────────
TOTAL=$((TOTAL + 1))
if [ -d "$HOME/.claude-ops/harness/manifests" ]; then
  echo -e "  ${GREEN}PASS${RESET} harnesses directory exists"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} harnesses directory missing"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: Fixture manifest exists and has required fields ──────────────────
assert_file_exists "fixture manifest exists" "$FIXTURE_MANIFEST_DIR/manifest.json"

TOTAL=$((TOTAL + 1))
if jq -e '.harness and .project_root and .files.progress' "$FIXTURE_MANIFEST_DIR/manifest.json" > /dev/null 2>&1; then
  echo -e "  ${GREEN}PASS${RESET} fixture manifest has required fields"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} fixture manifest missing required fields"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: harness_list_active returns fixture ───────────────────────────────
ACTIVE=$(harness_list_active)
TOTAL=$((TOTAL + 1))
if echo "$ACTIVE" | grep -q "^${FIXTURE_NAME}|"; then
  echo -e "  ${GREEN}PASS${RESET} harness_list_active includes fixture"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} harness_list_active missing fixture (got: $ACTIVE)"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: harness_list_all includes fixture ─────────────────────────────────
ALL=$(harness_list_all)
TOTAL=$((TOTAL + 1))
if echo "$ALL" | grep -q "^${FIXTURE_NAME}|"; then
  echo -e "  ${GREEN}PASS${RESET} harness_list_all includes fixture"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} harness_list_all missing fixture"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: active entries are a subset of list_all ──────────────────────────
TOTAL=$((TOTAL + 1))
MISMATCH=false
while IFS='|' read -r name _rest; do
  echo "$ALL" | grep -q "^${name}|" || MISMATCH=true
done <<< "$ACTIVE"
if [ "$MISMATCH" = false ]; then
  echo -e "  ${GREEN}PASS${RESET} all active harnesses present in list_all"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} active harness missing from list_all"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: harness_project_root resolves ────────────────────────────────────
RESULT=$(harness_project_root "$FIXTURE_NAME")
assert_not_empty "project_root is non-empty" "$RESULT"
assert "project_root matches fixture" "$FIXTURE_PROJECT" "$RESULT"

# ── Test 7: harness_progress_path resolves to absolute path ──────────────────
RESULT=$(harness_progress_path "$FIXTURE_NAME")
assert "progress_path is absolute" "/" "$RESULT"
assert "progress_path ends with tasks.json" "tasks.json" "$RESULT"

# ── Test 8: harness_manifest returns expected path format ────────────────────
RESULT=$(harness_manifest "my-test-harness")
assert_equals "manifest path format" "$HOME/.claude-ops/harness/manifests/my-test-harness/manifest.json" "$RESULT"

# ── Test 9: harness_project_root for nonexistent harness returns empty ────────
RESULT=$(harness_project_root "nonexistent-harness-xyz")
assert_equals "project_root empty for nonexistent" "" "$RESULT"

# ── Test 10: inactive harness not in list_active ─────────────────────────────
echo '{"status":"done","tasks":{}}' > "$FIXTURE_PROJECT/tasks.json"
ACTIVE2=$(harness_list_active)
TOTAL=$((TOTAL + 1))
if echo "$ACTIVE2" | grep -q "^${FIXTURE_NAME}|"; then
  echo -e "  ${RED}FAIL${RESET} done harness should not appear in list_active"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}PASS${RESET} done harness excluded from list_active"
  PASS=$((PASS + 1))
fi

test_summary
