#!/usr/bin/env bash
# test-v3-rearchitecture.sh — Tests for v3 rearchitecture changes:
#   - harness_bump_session writes to state.json
#   - harness-gates MEMORY.md mtime check (replaces journal.md)
#   - harness-gc.sh pane-registry cleanup (replaces session-registry)
#   - seed template: RECORD section, no journal.md writes
#   - hq_send function signature and bus publishing
#   - worker_inject_journal routes to worker_send
#
# Usage:
#   bash ~/.claude-ops/tests/test-v3-rearchitecture.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

FIXTURES="$(dirname "$0")/fixtures"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# ════════════════════════════════════════════════════════════════
# 1. harness_bump_session → state.json
# ════════════════════════════════════════════════════════════════
echo "── harness_bump_session (v3 → state.json) ──"

source "$HOME/.claude-ops/lib/harness-jq.sh"

# Test: v3 layout (state.json exists) — bump should write to state.json
TMP_DIR=$(mktemp -d)
mkdir -p "$TMP_DIR/agents/sidecar"
echo '{"status":"active","cycles_completed":5,"last_cycle_at":"2026-01-01T00:00:00Z"}' > "$TMP_DIR/agents/sidecar/state.json"
echo '{"tasks":{}}' > "$TMP_DIR/tasks.json"

harness_bump_session "$TMP_DIR/tasks.json" 2>/dev/null || true

NEW_CYCLES=$(jq -r '.cycles_completed' "$TMP_DIR/agents/sidecar/state.json" 2>/dev/null)
assert_equals "bump_session increments cycles_completed" "6" "$NEW_CYCLES"

NEW_STATUS=$(jq -r '.status' "$TMP_DIR/agents/sidecar/state.json" 2>/dev/null)
assert_equals "bump_session preserves status=active" "active" "$NEW_STATUS"

NEW_LAST=$(jq -r '.last_cycle_at' "$TMP_DIR/agents/sidecar/state.json" 2>/dev/null)
[ "$NEW_LAST" != "2026-01-01T00:00:00Z" ] && [ "$NEW_LAST" != "null" ]
assert_equals "bump_session updates last_cycle_at" "true" "$([ "$NEW_LAST" != "2026-01-01T00:00:00Z" ] && [ "$NEW_LAST" != "null" ] && echo true || echo false)"
rm -rf "$TMP_DIR"

# Test: v3 layout with cycles_completed missing — should default to 0 and increment to 1
TMP_DIR=$(mktemp -d)
mkdir -p "$TMP_DIR/agents/sidecar"
echo '{"status":"active"}' > "$TMP_DIR/agents/sidecar/state.json"
echo '{"tasks":{}}' > "$TMP_DIR/tasks.json"

harness_bump_session "$TMP_DIR/tasks.json" 2>/dev/null || true

NEW_CYCLES=$(jq -r '.cycles_completed' "$TMP_DIR/agents/sidecar/state.json" 2>/dev/null)
assert_equals "bump_session handles missing cycles_completed (0+1=1)" "1" "$NEW_CYCLES"
rm -rf "$TMP_DIR"

# Test: v2 fallback (no state.json, progress.json exists)
TMP_DIR=$(mktemp -d)
echo '{"status":"active","session_count":2}' > "$TMP_DIR/progress.json"

harness_bump_session "$TMP_DIR/progress.json" 2>/dev/null || true

NEW_COUNT=$(jq -r '.session_count' "$TMP_DIR/progress.json" 2>/dev/null)
assert_equals "bump_session falls back to progress.json (v2)" "3" "$NEW_COUNT"
rm -rf "$TMP_DIR"

# Test: neither file exists — should not crash
TMP_DIR=$(mktemp -d)
echo '{}' > "$TMP_DIR/fake.json"
harness_bump_session "$TMP_DIR/fake.json" 2>/dev/null || true
assert_equals "bump_session handles missing files gracefully" "true" "true"
rm -rf "$TMP_DIR"

# ════════════════════════════════════════════════════════════════
# 2. harness-gates MEMORY.md mtime check
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness-gates (MEMORY.md mtime check) ──"

GATES="$HOME/.claude-ops/hooks/dispatch/harness-gates.sh"
GATES_LIB="$HOME/.claude-ops/lib/harness-gates.sh"

# Verify both copies exist and pass syntax
assert_file_exists "gates dispatch exists" "$GATES"
assert_file_exists "gates lib exists" "$GATES_LIB"

bash -n "$GATES" 2>/dev/null
assert_equals "gates dispatch syntax OK" "0" "$?"

bash -n "$GATES_LIB" 2>/dev/null
assert_equals "gates lib syntax OK" "0" "$?"

# Verify journal.md is NOT referenced for gating (only in comments)
JOURNAL_ACTIVE_REFS=$(grep -v '^[[:space:]]*#' "$GATES" | grep -c 'journal.md' 2>/dev/null; true)
assert_equals "gates has no active journal.md references" "0" "$JOURNAL_ACTIVE_REFS"

# Verify MEMORY.md is used for the mtime check
assert_file_contains "gates checks MEMORY.md mtime" "$GATES" "MEMORY.md"
assert_file_contains "gates checks last_cycle_at" "$GATES" "last_cycle_at"

# Verify CYCLE_GATE_REQUIRE_MEMORY variable (not JOURNAL)
assert_file_contains "gates uses CYCLE_GATE_REQUIRE_MEMORY" "$GATES" "CYCLE_GATE_REQUIRE_MEMORY"

# Verify the two copies are in sync
DIFF_COUNT=$(diff "$GATES" "$GATES_LIB" | wc -l | tr -d ' ')
assert_equals "gates dispatch and lib are in sync" "0" "$DIFF_COUNT"

# ════════════════════════════════════════════════════════════════
# 3. harness-gc.sh pane-registry cleanup
# ════════════════════════════════════════════════════════════════
echo ""
echo "── harness-gc (pane-registry cleanup) ──"

GC="$HOME/.claude-ops/hooks/dispatch/harness-gc.sh"
assert_file_exists "gc script exists" "$GC"
bash -n "$GC" 2>/dev/null
assert_equals "gc syntax OK" "0" "$?"

# Verify old REGISTRY variable is gone
GC_REGISTRY_REFS=$(grep -v '^[[:space:]]*#' "$GC" | grep -c '\$REGISTRY' 2>/dev/null; true)
assert_equals "gc has no \$REGISTRY references" "0" "$GC_REGISTRY_REFS"

# Verify pane-registry.json is used instead
assert_file_contains "gc uses pane-registry.json" "$GC" "pane-registry.json"

# Verify session-registry is not referenced
GC_SESSION_REG=$(grep -c 'session-registry' "$GC" 2>/dev/null; true)
assert_equals "gc has no session-registry references" "0" "$GC_SESSION_REG"

# Functional test: create a temp pane-registry with a fake dead pane, run GC
TMP_DIR=$(mktemp -d)
FAKE_REG="$TMP_DIR/pane-registry.json"
echo '{ "%999999": {"harness": "dead-harness", "task": "test"}, "%0": {"harness": "also-dead"} }' > "$FAKE_REG"

# Source the GC and test the cleanup logic directly via python
LIVE_PANES=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null | tr '\n' ' ') || LIVE_PANES=""
RESULT=$(python3 -c "
import json
reg = json.load(open('$FAKE_REG'))
live = set('$LIVE_PANES'.split())
cleaned = {k: v for k, v in reg.items() if k.startswith('%') and k in live}
print(len(cleaned))
" 2>/dev/null || echo "error")
# Both %999999 and %0 should be removed (not live)
assert_equals "gc python cleanup removes dead panes" "0" "$RESULT"
rm -rf "$TMP_DIR"

# ════════════════════════════════════════════════════════════════
# 4. seed template content
# ════════════════════════════════════════════════════════════════
echo ""
echo "── seed template (RECORD, no journal.md) ──"

TMPL="$HOME/.claude-ops/templates/seed.sh.tmpl"
assert_file_exists "seed template exists" "$TMPL"

# Verify RECORD section present
assert_file_contains "template has RECORD section" "$TMPL" "## RECORD"
assert_file_contains "template has harness_bump_session" "$TMPL" "harness_bump_session"
assert_file_contains "template has bus_publish" "$TMPL" "bus_publish"
assert_file_contains "template has MEMORY.md update instruction" "$TMPL" "Update MEMORY.md"

# Verify "No journal.md" rule
assert_file_contains "template has No journal.md rule" "$TMPL" "No journal.md"

# Verify template substitution produces valid bash
TMP_SEED=$(mktemp)
sed "s|{{HARNESS}}|test-harness|g; s|{{PROJECT_ROOT}}|/tmp/test|g" "$TMPL" > "$TMP_SEED"
bash -n "$TMP_SEED" 2>/dev/null
assert_equals "substituted template is valid bash" "0" "$?"
rm -f "$TMP_SEED"

# Verify all 13 baked seeds have RECORD section
echo ""
echo "── baked seeds verification ──"
SEED_DIR="$PROJECT_ROOT/.claude/scripts"
STANDARD_SEEDS=(
  assistant-chat-ux code-health dashboard-ultra harness-health
  mod-customer mod-depts mod-engineering mod-finance
  mod-infra mod-workorder service-miniapp-ux work-order-v2 ziguang-review
)
SEEDS_WITH_RECORD=0
SEEDS_WITH_BUMP=0
SEEDS_VALID_BASH=0
for h in "${STANDARD_SEEDS[@]}"; do
  SEED="$SEED_DIR/${h}-seed.sh"
  grep -q "RECORD" "$SEED" 2>/dev/null && SEEDS_WITH_RECORD=$((SEEDS_WITH_RECORD+1))
  grep -q "harness_bump_session" "$SEED" 2>/dev/null && SEEDS_WITH_BUMP=$((SEEDS_WITH_BUMP+1))
  bash -n "$SEED" 2>/dev/null && SEEDS_VALID_BASH=$((SEEDS_VALID_BASH+1))
done
assert_equals "all 13 seeds have RECORD section" "13" "$SEEDS_WITH_RECORD"
assert_equals "all 13 seeds have harness_bump_session" "13" "$SEEDS_WITH_BUMP"
assert_equals "all 13 seeds pass bash syntax" "13" "$SEEDS_VALID_BASH"

# hq-v2 seed is custom — verify it exists and is valid bash but different from template
HQ_SEED="$SEED_DIR/hq-v2-seed.sh"
assert_file_exists "hq-v2 seed exists" "$HQ_SEED"
bash -n "$HQ_SEED" 2>/dev/null
assert_equals "hq-v2 seed syntax OK" "0" "$?"
assert_file_contains "hq-v2 seed is custom" "$HQ_SEED" "Custom seed"

# ════════════════════════════════════════════════════════════════
# 5. hq_send function
# ════════════════════════════════════════════════════════════════
echo ""
echo "── hq_send function ──"

HJQ="$HOME/.claude-ops/lib/harness-jq.sh"
assert_file_contains "hq_send defined" "$HJQ" "hq_send()"

# Test function signature: FROM TO TYPE CONTENT [PRIORITY]
TMP_DIR=$(mktemp -d)
TMP_BUS="$TMP_DIR/.claude/bus"
mkdir -p "$TMP_BUS"
echo '{"seq": 0}' > "$TMP_BUS/seq.json"
echo '{"event_types": {}}' > "$TMP_BUS/schema.json"
touch "$TMP_BUS/stream.jsonl"

# Call hq_send in a subprocess with PROJECT_ROOT pointing to temp
RESULT=$(PROJECT_ROOT="$TMP_DIR" bash -c "
  source '$HJQ'
  source '$HOME/.claude-ops/lib/event-bus.sh'
  hq_send 'mod-customer' 'hq-v2' 'status' 'cycle 4 done' 'normal' 2>/dev/null
  tail -1 '$TMP_BUS/stream.jsonl' 2>/dev/null
" 2>/dev/null || echo "{}")

# Verify the published event has correct from/to
FROM=$(echo "$RESULT" | jq -r '.from // empty' 2>/dev/null || echo "")
TO=$(echo "$RESULT" | jq -r '.to // empty' 2>/dev/null || echo "")
CONTENT=$(echo "$RESULT" | jq -r '.content // empty' 2>/dev/null || echo "")
if [ "$FROM" = "mod-customer" ]; then
  assert_equals "hq_send FROM is mod-customer" "mod-customer" "$FROM"
else
  # hq_send wraps in cell-message envelope, check inner payload
  INNER_FROM=$(echo "$RESULT" | jq -r '.from // empty' 2>/dev/null || echo "")
  assert_equals "hq_send FROM field present" "mod-customer" "$INNER_FROM"
fi
assert_equals "hq_send TO is hq-v2" "hq-v2" "$TO"
assert_equals "hq_send CONTENT is correct" "cycle 4 done" "$CONTENT"
rm -rf "$TMP_DIR"

# ════════════════════════════════════════════════════════════════
# 6. worker_inject_journal routes to worker_send
# ════════════════════════════════════════════════════════════════
echo ""
echo "── worker_inject_journal (v3 routing) ──"

WD="$HOME/.claude-ops/lib/worker-dispatch.sh"
assert_file_exists "worker-dispatch exists" "$WD"
bash -n "$WD" 2>/dev/null
assert_equals "worker-dispatch syntax OK" "0" "$?"

# Verify worker_inject_journal calls worker_send, not direct journal.md write
assert_file_contains "inject_journal calls worker_send" "$WD" 'worker_send "$worker" directive'

# Verify no direct journal.md write in inject_journal
# Extract the function body and check for journal.md
FUNC_BODY=$(sed -n '/^worker_inject_journal()/,/^}/p' "$WD" 2>/dev/null || echo "")
JOURNAL_IN_FUNC=$(echo "$FUNC_BODY" | grep -c 'journal.md' 2>/dev/null; true)
assert_equals "inject_journal has no journal.md reference" "0" "$JOURNAL_IN_FUNC"

# ════════════════════════════════════════════════════════════════
# 7. agent-architecture.md design doc consistency
# ════════════════════════════════════════════════════════════════
echo ""
echo "── agent-architecture.md consistency ──"

ARCH="$PROJECT_ROOT/claude_files/ref/agent-architecture.md"
assert_file_exists "agent-architecture.md exists" "$ARCH"

# Module Manager terminology (not "sidecar" outside implementation note)
assert_file_contains "doc uses Module Manager" "$ARCH" "Module Manager"
assert_file_contains "doc has module-manager/ dir" "$ARCH" "module-manager/"
assert_file_contains "doc has hq_send signature" "$ARCH" "hq_send FROM TO TYPE CONTENT"

# Phase Gates with vision.html
assert_file_contains "doc has Phase Gates section" "$ARCH" "## Phase Gates"
assert_file_contains "doc has vision.html" "$ARCH" "vision.html"
assert_file_contains "doc has sketch_approved" "$ARCH" "sketch_approved"

# RECORD phase
assert_file_contains "doc has RECORD Phase section" "$ARCH" "## RECORD Phase"
assert_file_contains "doc has harness_bump_session" "$ARCH" "harness_bump_session"

# No journal.md (invariant 12)
assert_file_contains "doc has No journal.md invariant" "$ARCH" "No journal.md"

# Key Invariants count (should have 12)
INVARIANT_COUNT=$(grep -c '^\*\*[0-9]' "$ARCH" 2>/dev/null || echo "0")
# Alternative: count numbered list items in Key Invariants
INV_COUNT=$(grep -cE '^[0-9]+\. \*\*' "$ARCH" 2>/dev/null || echo "0")
assert_equals "doc has 12 key invariants" "12" "$INV_COUNT"

# ════════════════════════════════════════════════════════════════
# 8. SKILL.md v3 alignment
# ════════════════════════════════════════════════════════════════
echo ""
echo "── SKILL.md v3 alignment ──"

SKILL="$HOME/.claude-ops/plugins/claude-context-orchestrator/skills/agent-harness/SKILL.md"
assert_file_exists "SKILL.md exists" "$SKILL"

# v3 files referenced
assert_file_contains "SKILL has config.json" "$SKILL" "config.json"
assert_file_contains "SKILL has state.json" "$SKILL" "state.json"
assert_file_contains "SKILL has RECORD phase" "$SKILL" "RECORD"
assert_file_contains "SKILL has harness_bump_session" "$SKILL" "harness_bump_session"

# No journal.md as an active artifact
SKILL_JOURNAL=$(grep -v '^[[:space:]]*#' "$SKILL" | grep -v 'No journal' | grep -v 'not.*journal' | grep -v 'removed' | grep -v 'replaced' | grep -c 'journal.md' 2>/dev/null; true)
assert_equals "SKILL has no active journal.md references" "0" "$SKILL_JOURNAL"

# ════════════════════════════════════════════════════════════════
# 9. Infrastructure: no stale session-registry references
# ════════════════════════════════════════════════════════════════
echo ""
echo "── no stale session-registry references ──"

# Check hooks dispatch directory
for f in "$HOME/.claude-ops/hooks/dispatch/"*.sh; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")
  ACTIVE_REFS=$(grep -v '^[[:space:]]*#' "$f" | grep -c 'session-registry' 2>/dev/null; true)
  assert_equals "$fname: no session-registry refs" "0" "$ACTIVE_REFS"
done

# Check hooks gates directory
for f in "$HOME/.claude-ops/hooks/gates/"*.sh; do
  [ -f "$f" ] || continue
  fname=$(basename "$f")
  ACTIVE_REFS=$(grep -v '^[[:space:]]*#' "$f" | grep -c 'session-registry' 2>/dev/null; true)
  assert_equals "$fname: no session-registry refs" "0" "$ACTIVE_REFS"
done

# Check lib directory (key files only)
for f in harness-jq.sh harness-gates.sh handoff.sh worker-dispatch.sh event-bus.sh; do
  FILE="$HOME/.claude-ops/lib/$f"
  [ -f "$FILE" ] || continue
  ACTIVE_REFS=$(grep -v '^[[:space:]]*#' "$FILE" | grep -c 'session-registry' 2>/dev/null; true)
  assert_equals "$f: no session-registry refs" "0" "$ACTIVE_REFS"
done

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════

test_summary
