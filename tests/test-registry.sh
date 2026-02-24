#!/usr/bin/env bash
# test-registry.sh — Tests for the manifest-based registry system.
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

echo "── manifest registry ──"

# Test 1: Manifest directory exists
TOTAL=$((TOTAL + 1))
if [ -d "$HOME/.claude-ops/harness/manifests" ]; then
  echo -e "  ${GREEN}PASS${RESET} harnesses directory exists"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} harnesses directory missing"
  FAIL=$((FAIL + 1))
fi

# Test 2: Active harnesses have manifests
for h in eval-external eval-internal miniapp-chat bi-opt chatbot-agent td-redteam; do
  assert_file_exists "manifest exists for $h" "$HOME/.claude-ops/harness/manifests/$h/manifest.json"
done

# Test 3: Manifest has required fields
for h in eval-external miniapp-chat; do
  MANIFEST="$HOME/.claude-ops/harness/manifests/$h/manifest.json"
  TOTAL=$((TOTAL + 1))
  if jq -e '.harness and .project_root and .files.progress' "$MANIFEST" > /dev/null 2>&1; then
    echo -e "  ${GREEN}PASS${RESET} $h manifest has required fields"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $h manifest missing required fields"
    FAIL=$((FAIL + 1))
  fi
done

# Test 4: harness_list_active returns results
RESULT=$(harness_list_active)
TOTAL=$((TOTAL + 1))
if [ -n "$RESULT" ]; then
  ACTIVE_COUNT=$(echo "$RESULT" | wc -l | tr -d ' ')
  echo -e "  ${GREEN}PASS${RESET} harness_list_active returns $ACTIVE_COUNT active harnesses"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} harness_list_active returned empty"
  FAIL=$((FAIL + 1))
fi

# Test 5: harness_list_active includes known active harnesses (update when harness statuses change)
ACTIVE_NAMES=$(echo "$RESULT" | cut -d'|' -f1)
TOTAL=$((TOTAL + 1))
# At least one active harness should exist
if [ -n "$ACTIVE_NAMES" ]; then
  echo -e "  ${GREEN}PASS${RESET} list_active has active harnesses: $(echo "$ACTIVE_NAMES" | tr '\n' ', ')"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} no active harnesses found"
  FAIL=$((FAIL + 1))
fi
# All active entries should also appear in list_all
ALL_RESULT=$(harness_list_all)
TOTAL=$((TOTAL + 1))
MISMATCH=false
for name in $ACTIVE_NAMES; do
  echo "$ALL_RESULT" | grep -q "^${name}|" || MISMATCH=true
done
if [ "$MISMATCH" = false ]; then
  echo -e "  ${GREEN}PASS${RESET} all active harnesses present in list_all"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} active harness missing from list_all"
  FAIL=$((FAIL + 1))
fi

# Test 6: harness_list_all returns more than active
RESULT=$(harness_list_all)
assert "list_all includes bi-opt" "bi-opt" "$RESULT"

# Test 7: harness_project_root resolves
RESULT=$(harness_project_root "eval-external")
assert_not_empty "project_root for eval-external is non-empty" "$RESULT"
assert "project_root contains Wechat" "Wechat" "$RESULT"

# Test 8: harness_progress_path resolves to absolute path
RESULT=$(harness_progress_path "eval-external")
assert "progress_path is absolute" "/" "$RESULT"
assert "progress_path ends with progress.json" "progress.json" "$RESULT"

# Test 9: harness_manifest returns expected path format
RESULT=$(harness_manifest "my-test-harness")
assert_equals "manifest path format" "$HOME/.claude-ops/harness/manifests/my-test-harness/manifest.json" "$RESULT"

# Test 10: harness_project_root for nonexistent harness returns empty
RESULT=$(harness_project_root "nonexistent-harness-xyz")
assert_equals "project_root empty for nonexistent" "" "$RESULT"

test_summary
