#!/usr/bin/env bash
# test-waves.sh — Tests for wave-based execution functions in harness-jq.sh (v2).
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

FIXTURES="$(dirname "$0")/fixtures"
# Wave test uses its own v2 fixture directory
WAVE_DIR="$FIXTURES/wave-test"
# Functions take a "progress path" — resolvers use its directory to find tasks.json/config.json
WAVE_PROGRESS="$WAVE_DIR/anchor.json"
echo '{}' > "$WAVE_PROGRESS"  # dummy anchor file — resolvers derive from its directory

# No-wave fixture uses the main fixtures dir (which has config.json with empty waves)
NO_WAVE_PROGRESS="$FIXTURES/sample-progress.json"

echo "── wave functions (harness-jq.sh v2) ──"

# ══════════════════════════════════════════════════════
# No waves defined (empty waves array in config.json)
# ══════════════════════════════════════════════════════

RESULT=$(harness_current_wave "$NO_WAVE_PROGRESS")
assert_equals "current_wave returns null when no waves" "null" "$RESULT"

RESULT=$(harness_wave_progress "$NO_WAVE_PROGRESS")
assert_equals "wave_progress returns empty when no waves" "" "$RESULT"

RESULT=$(harness_wave_tasks "$NO_WAVE_PROGRESS")
assert_equals "wave_tasks returns empty when no waves" "" "$RESULT"

RESULT=$(harness_is_wave_boundary "$NO_WAVE_PROGRESS")
assert_equals "is_wave_boundary returns false when no waves" "false" "$RESULT"

# ══════════════════════════════════════════════════════
# Wave with active data
# ══════════════════════════════════════════════════════

# current_wave should return the in_progress wave (wave 2)
RESULT=$(harness_current_wave "$WAVE_PROGRESS")
assert "current_wave returns in_progress wave" '"id":2' "$RESULT"
assert "current_wave has correct name" '"name":"Features"' "$RESULT"

# wave_progress should show "Wave 2/3: Features (0/2 tasks)"
RESULT=$(harness_wave_progress "$WAVE_PROGRESS")
assert "wave_progress shows wave number" "Wave 2/3" "$RESULT"
assert "wave_progress shows wave name" "Features" "$RESULT"
assert "wave_progress shows task count" "tasks)" "$RESULT"

# wave_tasks should return w2-a and w2-b
RESULT=$(harness_wave_tasks "$WAVE_PROGRESS")
assert "wave_tasks contains w2-a" "w2-a" "$RESULT"
assert "wave_tasks contains w2-b" "w2-b" "$RESULT"

# is_wave_boundary should be false (w2-a is in_progress, w2-b is pending)
RESULT=$(harness_is_wave_boundary "$WAVE_PROGRESS")
assert_equals "is_wave_boundary false when tasks remain" "false" "$RESULT"

# ══════════════════════════════════════════════════════
# Wave boundary detection
# ══════════════════════════════════════════════════════

# Complete all tasks in wave 2 (modify tasks.json in a temp dir)
TMP_DIR=$(mktemp -d)
cp -r "$WAVE_DIR"/* "$TMP_DIR/"
cp -r "$WAVE_DIR"/agents "$TMP_DIR/"
TMP_ANCHOR="$TMP_DIR/anchor.json"
echo '{}' > "$TMP_ANCHOR"
jq '.tasks["w2-a"].status = "completed" | .tasks["w2-b"].status = "completed"' "$TMP_DIR/tasks.json" > "$TMP_DIR/tasks.json.tmp" && mv "$TMP_DIR/tasks.json.tmp" "$TMP_DIR/tasks.json"

RESULT=$(harness_is_wave_boundary "$TMP_ANCHOR")
assert_equals "is_wave_boundary true when all wave tasks completed" "true" "$RESULT"
rm -rf "$TMP_DIR"

# ══════════════════════════════════════════════════════
# All waves completed
# ══════════════════════════════════════════════════════

TMP_DIR=$(mktemp -d)
cp -r "$WAVE_DIR"/* "$TMP_DIR/"
cp -r "$WAVE_DIR"/agents "$TMP_DIR/"
TMP_ANCHOR="$TMP_DIR/anchor.json"
echo '{}' > "$TMP_ANCHOR"
# Complete all tasks
jq '.tasks |= map_values(.status = "completed")' "$TMP_DIR/tasks.json" > "$TMP_DIR/tasks.json.tmp" && mv "$TMP_DIR/tasks.json.tmp" "$TMP_DIR/tasks.json"
# Complete all waves
jq '.waves |= map(.status = "completed")' "$TMP_DIR/agents/sidecar/config.json" > "$TMP_DIR/agents/sidecar/config.json.tmp" && mv "$TMP_DIR/agents/sidecar/config.json.tmp" "$TMP_DIR/agents/sidecar/config.json"

RESULT=$(harness_wave_progress "$TMP_ANCHOR")
assert "wave_progress shows all complete" "All 3 waves complete" "$RESULT"

RESULT=$(harness_current_wave "$TMP_ANCHOR")
assert_equals "current_wave returns null when all done" "null" "$RESULT"
rm -rf "$TMP_DIR"

# ══════════════════════════════════════════════════════
# Wave report path
# ══════════════════════════════════════════════════════

RESULT=$(harness_wave_report_path "$WAVE_PROGRESS" 2)
assert "wave_report_path contains wave number" "wave-2.html" "$RESULT"
assert "wave_report_path is under reports dir" ".claude-ops/harness/reports/" "$RESULT"

# ══════════════════════════════════════════════════════
# Wave report + final report templates exist
# ══════════════════════════════════════════════════════

assert_file_exists "wave-report.html.tmpl exists" "$HOME/.claude-ops/templates/wave-report.html.tmpl"
assert_file_exists "report.css exists" "$HOME/.claude-ops/templates/report.css"

# ══════════════════════════════════════════════════════
# Seed template has Wave Protocol section
# ══════════════════════════════════════════════════════

assert_file_contains "seed.sh template has Wave Protocol" "$HOME/.claude-ops/templates/seed.sh.tmpl" "Wave protocol"

# Cleanup
rm -f "$WAVE_PROGRESS"

test_summary
