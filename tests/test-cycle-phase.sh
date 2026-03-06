#!/usr/bin/env bash
# test-cycle-phase.sh — Tests for cycle phase enforcement (two-mode sidecar system).
set -euo pipefail

source "$(dirname "$0")/helpers.sh"
source "$HOME/.claude-ops/lib/harness-jq.sh"

echo "── cycle-phase enforcement ──"

# ── Setup temp dirs ──
TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Helper: create a minimal long-running progress file
make_progress() {
  local dir="$1" harness="$2" phase="${3:-unknown}"
  mkdir -p "$dir/.claude/harness/$harness/agents/sidecar"
  # v3: config.json + state.json required
  cat > "$dir/.claude/harness/$harness/agents/sidecar/config.json" <<EOCFG
{
  "name": "$harness",
  "mission": "Test mission",
  "model": "sonnet",
  "lifecycle": "long-running"
}
EOCFG
  cat > "$dir/.claude/harness/$harness/agents/sidecar/state.json" <<EOSTATE
{
  "type": "execution",
  "cycles_completed": 1,
  "current_session": {
    "cycle_phase": "$phase",
    "cycle_phase_entered_at": "$(date +%s)",
    "phase_artifacts": {
      "reconcile": { "gaps_documented": false },
      "act": { "tasks_created": 0, "files_changed": 0 }
    }
  }
}
EOSTATE
  cat > "$dir/.claude/harness/$harness/progress.json" <<EOJSON
{
  "harness": "$harness",
  "mission": "Test mission",
  "lifecycle": "long-running",
  "status": "active",
  "cycles_completed": 1,
  "last_cycle_at": "2026-02-26T10:00:00Z",
  "current_session": {
    "cycle_phase": "$phase",
    "cycle_phase_entered_at": "$(date +%s)",
    "phase_artifacts": {
      "reconcile": { "gaps_documented": false },
      "act": { "tasks_created": 0, "files_changed": 0 }
    }
  },
  "tasks": {
    "t1": { "status": "completed", "description": "done", "blockedBy": [] }
  }
}
EOJSON
  echo "$dir/.claude/harness/$harness/progress.json"
}

# Helper: create worker directories (for mode detection)
make_worker_dirs() {
  local dir="$1" harness="$2"
  shift 2
  for worker in "$@"; do
    mkdir -p "$dir/.claude/harness/$harness/agents/worker/$worker"
    echo '{"model":"cds","permission_mode":"default"}' > "$dir/.claude/harness/$harness/agents/worker/$worker/permissions.json"
  done
}

# ══════════════════════════════════════
# MODE DETECTION TESTS
# ══════════════════════════════════════

# Test 1: self-sidecar (no worker directory)
DIR1="$TMPDIR_TEST/test1"
PROG1=$(make_progress "$DIR1" "test-self")
RESULT=$(harness_operating_mode "$PROG1" "$DIR1")
assert_equals "mode: self-sidecar with no worker dir" "self-sidecar" "$RESULT"

# Test 2: sidecar-executor (worker directories present)
DIR2="$TMPDIR_TEST/test2"
PROG2=$(make_progress "$DIR2" "test-exec")
make_worker_dirs "$DIR2" "test-exec" "kefu-impl" "corpus-reindex"
RESULT=$(harness_operating_mode "$PROG2" "$DIR2")
assert_equals "mode: sidecar-executor with worker dirs" "sidecar-executor" "$RESULT"

# Test 3: self-sidecar (no worker dir at all)
DIR3="$TMPDIR_TEST/test3"
PROG3=$(make_progress "$DIR3" "test-nofile")
RESULT=$(harness_operating_mode "$PROG3" "$DIR3")
assert_equals "mode: self-sidecar without worker dir" "self-sidecar" "$RESULT"

# Test 4: self-sidecar (empty worker directory)
DIR4="$TMPDIR_TEST/test4"
PROG4=$(make_progress "$DIR4" "test-empty")
mkdir -p "$DIR4/.claude/harness/test-empty/agents/worker"
RESULT=$(harness_operating_mode "$PROG4" "$DIR4")
assert_equals "mode: self-sidecar with empty worker dir" "self-sidecar" "$RESULT"

# ══════════════════════════════════════
# PHASE GATE TESTS
# ══════════════════════════════════════

# Test 11: PROBE without acceptance.md update → warning
DIR11="$TMPDIR_TEST/test11"
PROG11=$(make_progress "$DIR11" "test-probe" "probe")
# Set phase_entered_at to past (so acceptance.md is stale) — write to state.json (v3)
STATE11="$DIR11/.claude/harness/test-probe/agents/sidecar/state.json"
jq '.current_session.cycle_phase_entered_at = "1000000000"' "$STATE11" > "$STATE11.tmp" && mv "$STATE11.tmp" "$STATE11"
# Create acceptance.md with old mtime
echo "old content" > "$DIR11/.claude/harness/test-probe/acceptance.md"
touch -t 200001010000 "$DIR11/.claude/harness/test-probe/acceptance.md"
# Run the phase gate check via dispatch (simulate by sourcing and calling)
RESULT=$(
  export PROJECT_ROOT="$DIR11"
  export CYCLE_PHASE_ENFORCEMENT=true
  export CYCLE_PHASE_MIN_PROBE_SEC=60
  source "$HOME/.claude-ops/lib/harness-jq.sh"
  CUR_PHASE=$(harness_cycle_phase "$PROG11")
  PHASE_ENTERED=$(harness_phase_entered_at "$PROG11")
  ACC_FILE="$DIR11/.claude/harness/test-probe/acceptance.md"
  ACC_MT=$(_file_mtime "$ACC_FILE")
  PE_EPOCH="$PHASE_ENTERED"
  if [ "$ACC_MT" -le "$PE_EPOCH" ] 2>/dev/null; then
    echo "PHASE GATE warning"
  else
    echo "no warning"
  fi
)
assert "PROBE: stale acceptance.md triggers warning" "PHASE GATE warning" "$RESULT"

# Test 12: RECONCILE without gaps_documented → warning
DIR12="$TMPDIR_TEST/test12"
PROG12=$(make_progress "$DIR12" "test-recon" "reconcile")
RESULT=$(jq -r '.current_session.phase_artifacts.reconcile.gaps_documented // false' "$PROG12")
assert_equals "RECONCILE: gaps_documented defaults to false" "false" "$RESULT"

# Test 13: ACT without work recorded → warning
DIR13="$TMPDIR_TEST/test13"
PROG13=$(make_progress "$DIR13" "test-act" "act")
TC=$(jq -r '.current_session.phase_artifacts.act.tasks_created // 0' "$PROG13")
FC=$(jq -r '.current_session.phase_artifacts.act.files_changed // 0' "$PROG13")
RESULT="no_work"
[ "$TC" -eq 0 ] && [ "$FC" -eq 0 ] && RESULT="no_work_recorded"
assert_equals "ACT: no work triggers warning condition" "no_work_recorded" "$RESULT"

# Test 14: PERSIST without journal entry → warning
DIR14="$TMPDIR_TEST/test14"
PROG14=$(make_progress "$DIR14" "test-persist" "persist")
mkdir -p "$DIR14/.claude/harness/test-persist"
echo "# Journal" > "$DIR14/.claude/harness/test-persist/journal.md"
CYCLE_N=$(harness_cycle_count "$PROG14")
RESULT="no_entry"
grep -q "## Cycle ${CYCLE_N}" "$DIR14/.claude/harness/test-persist/journal.md" 2>/dev/null || RESULT="missing_entry"
assert_equals "PERSIST: missing cycle entry detected" "missing_entry" "$RESULT"

# Test 15: Full cycle — all artifacts present → no warnings
DIR15="$TMPDIR_TEST/test15"
PROG15=$(make_progress "$DIR15" "test-full" "probe")
# Update acceptance.md AFTER phase_entered_at
sleep 1
echo "updated probes" > "$DIR15/.claude/harness/test-full/acceptance.md"
ACC_MT=$(_file_mtime "$DIR15/.claude/harness/test-full/acceptance.md")
PE=$(harness_phase_entered_at "$PROG15")
RESULT="stale"
[ "$ACC_MT" -gt "$PE" ] 2>/dev/null && RESULT="fresh"
assert_equals "PROBE: fresh acceptance.md passes" "fresh" "$RESULT"

# Test 16: Bounded harness → never phase-enforced
DIR16="$TMPDIR_TEST/test16"
mkdir -p "$DIR16/.claude/harness/test-bounded/agents/sidecar"
cat > "$DIR16/.claude/harness/test-bounded/agents/sidecar/config.json" <<'EOCFG'
{"name":"test-bounded","mission":"Test","model":"sonnet","lifecycle":"bounded"}
EOCFG
echo '{"type":"execution","cycles_completed":0,"current_session":{"cycle_phase":"probe"}}' > "$DIR16/.claude/harness/test-bounded/agents/sidecar/state.json"
cat > "$DIR16/.claude/harness/test-bounded/progress.json" <<'EOJSON'
{
  "harness": "test-bounded",
  "lifecycle": "bounded",
  "status": "active",
  "current_session": { "cycle_phase": "probe" },
  "tasks": {}
}
EOJSON
LIFECYCLE=$(harness_lifecycle "$DIR16/.claude/harness/test-bounded/progress.json")
RESULT="enforced"
[ "$LIFECYCLE" != "long-running" ] && RESULT="skipped"
assert_equals "bounded harness: phase enforcement skipped" "skipped" "$RESULT"

# Test 17: Phase enforcement disabled → no gate
RESULT="active"
CYCLE_PHASE_ENFORCEMENT=false
[ "$CYCLE_PHASE_ENFORCEMENT" != "true" ] && RESULT="disabled"
assert_equals "disabled enforcement: no gate" "disabled" "$RESULT"
CYCLE_PHASE_ENFORCEMENT=true

# Test 18: harness_phase_entered_at reads correctly (v3: from state.json)
DIR18="$TMPDIR_TEST/test18"
PROG18=$(make_progress "$DIR18" "test-entered" "probe")
STATE18="$DIR18/.claude/harness/test-entered/agents/sidecar/state.json"
jq '.current_session.cycle_phase_entered_at = "1709000000"' "$STATE18" > "$STATE18.tmp" && mv "$STATE18.tmp" "$STATE18"
RESULT=$(harness_phase_entered_at "$PROG18")
assert_equals "phase_entered_at reads epoch" "1709000000" "$RESULT"

# Test 19: harness_cycle_phase reads correctly (v3: from state.json)
DIR19="$TMPDIR_TEST/test19"
PROG19=$(make_progress "$DIR19" "test-phase-read" "reconcile")
RESULT=$(harness_cycle_phase "$PROG19")
assert_equals "cycle_phase reads reconcile" "reconcile" "$RESULT"

test_summary
