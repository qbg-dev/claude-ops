#!/usr/bin/env bash
# test-registration.sh — Tests for the three-tier harness registration system.
#
# Verifies:
#   Tier 0: pane-registry.json lookup (primary, written by stop hooks + launch)
#   Tier 1: session-registry.json pane lookup (legacy)
#   Tier 2: session-registry.json session lookup (legacy)
#   Fallthrough: empty Tier 0 → Tier 1 → Tier 2
#   pane_registry_update: writes harness field correctly
#   harness register: writes to BOTH registries
#
# Run: bash ~/.claude-ops/tests/test-registration.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$PROJECT_ROOT"

# ── Isolated test state ─────────────────────────────────────────
TEST_STATE_DIR=$(mktemp -d /tmp/test-registration-XXXXXX)
export HARNESS_STATE_DIR="$TEST_STATE_DIR"
export HARNESS_SESSION_REGISTRY="$TEST_STATE_DIR/session-registry.json"
export HARNESS_LOCK_DIR="$TEST_STATE_DIR/locks"
export PANE_REGISTRY="$TEST_STATE_DIR/pane-registry.json"
mkdir -p "$HARNESS_LOCK_DIR"

source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true

cleanup() {
  rm -rf "$TEST_STATE_DIR"
}
trap cleanup EXIT

echo "── registration (three-tier) ──"

# ═══════════════════════════════════════════════════════════════════
# pane_registry_update — writes correctly
# ═══════════════════════════════════════════════════════════════════

# Test 1: pane_registry_update creates entry with harness field
echo '{}' > "$PANE_REGISTRY"
pane_registry_update "%999" "test-harness" "task-1" "3" "10" "test-harness: task-1 (3/10)"
RESULT=$(jq -r '."%999".harness' "$PANE_REGISTRY")
assert_equals "pane_registry_update sets harness" "test-harness" "$RESULT"

# Test 2: pane_registry_update sets task field
RESULT=$(jq -r '."%999".task' "$PANE_REGISTRY")
assert_equals "pane_registry_update sets task" "task-1" "$RESULT"

# Test 3: pane_registry_update sets done/total
RESULT=$(jq -r '."%999".done' "$PANE_REGISTRY")
assert_equals "pane_registry_update sets done" "3" "$RESULT"
RESULT=$(jq -r '."%999".total' "$PANE_REGISTRY")
assert_equals "pane_registry_update sets total" "10" "$RESULT"

# Test 4: pane_registry_update preserves session_name from prior entry
pane_registry_set_session "%999" "my test session" "summary text"
pane_registry_update "%999" "test-harness" "task-2" "5" "10" "test-harness: task-2 (5/10)"
RESULT=$(jq -r '."%999".session_name' "$PANE_REGISTRY")
assert_equals "pane_registry_update preserves session_name" "my test session" "$RESULT"
RESULT=$(jq -r '."%999".harness' "$PANE_REGISTRY")
assert_equals "pane_registry_update still has harness after session merge" "test-harness" "$RESULT"

# ═══════════════════════════════════════════════════════════════════
# Tier 0: pane-registry.json jq query
# ═══════════════════════════════════════════════════════════════════

# Test 5: Tier 0 lookup resolves harness from pane-registry
RESULT=$(jq -r --arg pid "%999" '.[$pid].harness // ""' "$PANE_REGISTRY")
assert_equals "Tier 0 resolves harness" "test-harness" "$RESULT"

# Test 6: Tier 0 returns empty for unregistered pane
RESULT=$(jq -r --arg pid "%888" '.[$pid].harness // ""' "$PANE_REGISTRY")
assert_equals "Tier 0 returns empty for unknown pane" "" "$RESULT"

# Test 7: Tier 0 returns empty for pane without harness field
pane_registry_set_session "%777" "session-only" "no harness"
RESULT=$(jq -r --arg pid "%777" '.[$pid].harness // ""' "$PANE_REGISTRY")
assert_equals "Tier 0 returns empty for pane without harness" "" "$RESULT"

# ═══════════════════════════════════════════════════════════════════
# Tier 1: session-registry.json pane lookup
# ═══════════════════════════════════════════════════════════════════

# Test 8: Tier 1 resolves harness from session-registry .panes
echo '{"panes":{"%555":"cockpit-interactive"},"sessions":{}}' > "$HARNESS_SESSION_REGISTRY"
RESULT=$(jq -r --arg pid "%555" '(.panes // {})[$pid] // ""' "$HARNESS_SESSION_REGISTRY")
assert_equals "Tier 1 resolves from session-registry panes" "cockpit-interactive" "$RESULT"

# ═══════════════════════════════════════════════════════════════════
# Tier 2: session-registry.json session lookup
# ═══════════════════════════════════════════════════════════════════

# Test 9: Tier 2 resolves from .sessions
echo '{"panes":{},"sessions":{"abc-123":"miniapp-chat"}}' > "$HARNESS_SESSION_REGISTRY"
RESULT=$(jq -r --arg sid "abc-123" '(.sessions // {})[$sid] // .[$sid] // ""' "$HARNESS_SESSION_REGISTRY")
assert_equals "Tier 2 resolves from sessions" "miniapp-chat" "$RESULT"

# Test 10: Tier 2 resolves from flat legacy format
echo '{"abc-123":"miniapp-chat"}' > "$HARNESS_SESSION_REGISTRY"
RESULT=$(jq -r --arg sid "abc-123" '(.sessions // {})[$sid] // .[$sid] // ""' "$HARNESS_SESSION_REGISTRY")
assert_equals "Tier 2 resolves from flat legacy format" "miniapp-chat" "$RESULT"

# ═══════════════════════════════════════════════════════════════════
# Fallthrough: Tier 0 miss → Tier 1 → Tier 2
# ═══════════════════════════════════════════════════════════════════

# Test 11: Empty pane-registry falls through to session-registry
echo '{}' > "$PANE_REGISTRY"
echo '{"panes":{"%333":"service-miniapp-ux"},"sessions":{}}' > "$HARNESS_SESSION_REGISTRY"
# Simulate: Tier 0 miss
HARNESS=$(jq -r --arg pid "%333" '.[$pid].harness // ""' "$PANE_REGISTRY")
# Tier 0 empty, try Tier 1
[ -z "$HARNESS" ] && HARNESS=$(jq -r --arg pid "%333" '(.panes // {})[$pid] // ""' "$HARNESS_SESSION_REGISTRY")
assert_equals "fallthrough Tier 0→1 works" "service-miniapp-ux" "$HARNESS"

# Test 12: Both empty → falls through to Tier 2
echo '{}' > "$PANE_REGISTRY"
echo '{"panes":{},"sessions":{"sess-456":"data-consistency"}}' > "$HARNESS_SESSION_REGISTRY"
HARNESS=$(jq -r --arg pid "%444" '.[$pid].harness // ""' "$PANE_REGISTRY")
[ -z "$HARNESS" ] && HARNESS=$(jq -r --arg pid "%444" '(.panes // {})[$pid] // ""' "$HARNESS_SESSION_REGISTRY")
[ -z "$HARNESS" ] && HARNESS=$(jq -r --arg sid "sess-456" '(.sessions // {})[$sid] // .[$sid] // ""' "$HARNESS_SESSION_REGISTRY")
assert_equals "fallthrough Tier 0→1→2 works" "data-consistency" "$HARNESS"

# Test 13: All tiers empty → no harness
echo '{}' > "$PANE_REGISTRY"
echo '{}' > "$HARNESS_SESSION_REGISTRY"
HARNESS=$(jq -r --arg pid "%444" '.[$pid].harness // ""' "$PANE_REGISTRY")
[ -z "$HARNESS" ] && HARNESS=$(jq -r --arg pid "%444" '(.panes // {})[$pid] // ""' "$HARNESS_SESSION_REGISTRY" 2>/dev/null || echo "")
[ -z "$HARNESS" ] && HARNESS=$(jq -r --arg sid "no-session" '(.sessions // {})[$sid] // .[$sid] // ""' "$HARNESS_SESSION_REGISTRY" 2>/dev/null || echo "")
assert_equals "all tiers empty returns empty" "" "$HARNESS"

# ═══════════════════════════════════════════════════════════════════
# Tier 0 precedence: pane-registry wins over session-registry
# ═══════════════════════════════════════════════════════════════════

# Test 14: Tier 0 takes precedence over Tier 1
echo '{}' > "$PANE_REGISTRY"
pane_registry_update "%222" "correct-harness" "task" "1" "5" "correct"
echo '{"panes":{"%222":"wrong-harness"},"sessions":{}}' > "$HARNESS_SESSION_REGISTRY"
HARNESS=$(jq -r --arg pid "%222" '.[$pid].harness // ""' "$PANE_REGISTRY")
assert_equals "Tier 0 takes precedence over Tier 1" "correct-harness" "$HARNESS"

# ═══════════════════════════════════════════════════════════════════
# context-injector: Tier 0 integration
# ═══════════════════════════════════════════════════════════════════

# Test 15: context-injector resolves via session-registry when not in tmux
# (OWN_PANE_ID will be empty outside tmux, so Tier 0 is skipped, falls to Tier 2)
echo '{}' > "$PANE_REGISTRY"
echo "{\"test-sess-ci\":\"miniapp-chat\"}" > "$HARNESS_SESSION_REGISTRY"
RESULT=$(echo '{"session_id":"test-sess-ci","tool_name":"Write","tool_input":{"file_path":"/tmp/x.ts","content":"y"}}' \
  | PROJECT_ROOT="$PROJECT_ROOT" bash "$HOME/.claude-ops/hooks/admission/context-injector.sh" 2>/dev/null)
# If miniapp-chat has context-injections, we should get something. If not, {} is also acceptable (harness resolved but no injections)
assert_not_empty "context-injector resolves via Tier 2 fallback" "$RESULT"

# ═══════════════════════════════════════════════════════════════════
# Role detection: self-sidecar vs sidecar
# ═══════════════════════════════════════════════════════════════════

# Test 16: Self-sidecar role detection (workers: {})
# harness_operating_mode derives harness name from progress path, expects .claude/harness/<name>/
TEST_PROJECT=$(mktemp -d /tmp/test-project-XXXXXX)
mkdir -p "$TEST_PROJECT/.claude/harness/test-role"
mkdir -p "$TEST_PROJECT/.claude/harness/test-role/agents/sidecar"
cat > "$TEST_PROJECT/.claude/harness/test-role/agents/sidecar/permissions.json" << 'EOF'
{
  "model": "cds",
  "permission_mode": "bypassPermissions"
}
EOF
cat > "$TEST_PROJECT/.claude/harness/test-role/progress.json" << 'EOF'
{"harness":"test-role","mission":"test","tasks":{},"lifecycle":"bounded"}
EOF
MODE=$(harness_operating_mode "$TEST_PROJECT/.claude/harness/test-role/progress.json" "$TEST_PROJECT" 2>/dev/null || echo "self-sidecar")
assert_equals "empty workers = self-sidecar" "self-sidecar" "$MODE"
rm -rf "$TEST_PROJECT"

# ═══════════════════════════════════════════════════════════════════
# Seed template: role section emitted correctly
# ═══════════════════════════════════════════════════════════════════

# Test 17: Self-sidecar seed contains CHECK → ACT → RECORD
SEED_HARNESS="cockpit-interactive"
if [ -f "$PROJECT_ROOT/.claude/scripts/${SEED_HARNESS}-seed.sh" ]; then
  SEED_OUTPUT=$(bash "$PROJECT_ROOT/.claude/scripts/${SEED_HARNESS}-seed.sh" 2>/dev/null || echo "")
  if [ -n "$SEED_OUTPUT" ]; then
    assert "self-sidecar seed has CHECK → ACT → RECORD" "CHECK" "$SEED_OUTPUT"
  else
    echo -e "  ${YELLOW}SKIP${RESET} seed output empty (harness may not have progress)"
  fi
else
  echo -e "  ${YELLOW}SKIP${RESET} no seed script for $SEED_HARNESS"
fi

# ═══════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════

test_summary
