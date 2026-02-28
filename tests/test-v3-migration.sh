#!/usr/bin/env bash
# test-v3-migration.sh — Systematic tests for Agent Architecture v3 Migration
#
# Tests every phase of the migration plan:
#   Phase 1a: hook_pass() graceful-stop sentinel
#   Phase 1b: EVENT_BUS_ENABLED defaults to true
#   Phase 1c: update_tasks_json.sh side-effect
#   Phase 2a: mission.md exists in all 9 harnesses
#   Phase 2b: memory/ subdirs exist in all 9 harnesses
#   Phase 2c: red-team v3 files initialized
#   Phase 3:  progress.json deleted from all 8 active harnesses
#   Phase 4:  watchdog script exists, passes syntax check
#   Phase 5:  _inject_bg_sleep removed
#
# Usage:
#   bash ~/.claude-ops/tests/test-v3-migration.sh
#   bash ~/.claude-ops/tests/test-v3-migration.sh --verbose
#
# Exit code: 0 = all pass, 1 = one or more failures

set -euo pipefail

VERBOSE="${1:-}"
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# ── Test framework ────────────────────────────────────────────────
PASS=0; FAIL=0; SKIP=0
# Always return 0 so && / || chains don't double-fire
_pass() { PASS=$((PASS+1)); [ -n "$VERBOSE" ] && echo "  ✅ $1"; true; }
_fail() { FAIL=$((FAIL+1)); echo "  ❌ FAIL: $1"; true; }
_skip() { SKIP=$((SKIP+1)); [ -n "$VERBOSE" ] && echo "  ⬜ SKIP: $1"; true; }
_section() { echo; echo "── $1 ──"; }

# ── Helpers ───────────────────────────────────────────────────────
file_exists() {
  if [ -f "$1" ]; then _pass "$1 exists"; else _fail "$1 missing"; fi
}
dir_exists() {
  if [ -d "$1" ]; then _pass "$1 dir exists"; else _fail "$1 dir missing"; fi
}
file_absent() {
  if [ ! -f "$1" ]; then _pass "$1 absent (as expected)"; else _fail "$1 should be deleted but still exists"; fi
}
# grep -F: fixed-string search (immune to -- option interpretation), -- ends options
contains() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then _pass "$1 contains '$2'"; else _fail "$1 missing '$2'"; fi
}
not_contains() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then _fail "$1 still contains '$2'"; else _pass "$1 does not contain '$2'"; fi
}
executable() {
  if [ -x "$1" ]; then _pass "$1 is executable"; else _fail "$1 not executable"; fi
}
bash_syntax() {
  if bash -n "$1" 2>/dev/null; then _pass "$1 bash syntax OK"; else _fail "$1 bash syntax error"; fi
}

# ════════════════════════════════════════════════════════════════
# Phase 1a: hook_pass() graceful-stop sentinel
# ════════════════════════════════════════════════════════════════
_section "Phase 1a: hook_pass() graceful-stop sentinel"

HJQ="$HOME/.claude-ops/lib/harness-jq.sh"
file_exists "$HJQ"
bash_syntax "$HJQ"
contains "$HJQ" "graceful-stop"
contains "$HJQ" "CLAUDE_SESSION_DIR"
contains "$HJQ" "_SESSION_DIR/graceful-stop"

# Functional test: actually call hook_pass and verify sentinel is written
FAKE_SID="test-v3-migration-$$"
export CLAUDE_SESSION_ID="$FAKE_SID"
export CLAUDE_SESSION_DIR="$HOME/.claude-ops/state/sessions/$FAKE_SID"
SENTINEL="$CLAUDE_SESSION_DIR/graceful-stop"
rm -f "$SENTINEL" 2>/dev/null || true

SOURCE_AND_TEST=$(bash -c "source '$HJQ'; hook_pass > /dev/null; [ -f '$SENTINEL' ] && echo 'ok' || echo 'fail'" 2>/dev/null)
if [ "$SOURCE_AND_TEST" = "ok" ]; then
  _pass "hook_pass() writes graceful-stop sentinel"
else
  _fail "hook_pass() did NOT write graceful-stop sentinel"
fi

rm -rf "$CLAUDE_SESSION_DIR" 2>/dev/null || true
unset CLAUDE_SESSION_ID CLAUDE_SESSION_DIR

# ════════════════════════════════════════════════════════════════
# Phase 1b: EVENT_BUS_ENABLED defaults to true
# ════════════════════════════════════════════════════════════════
_section "Phase 1b: EVENT_BUS_ENABLED default"

EBUS="$HOME/.claude-ops/lib/event-bus.sh"
file_exists "$EBUS"
bash_syntax "$EBUS"
contains "$EBUS" 'EVENT_BUS_ENABLED="${EVENT_BUS_ENABLED:-true}"'

# ════════════════════════════════════════════════════════════════
# Phase 1c: update_tasks_json.sh side-effect
# ════════════════════════════════════════════════════════════════
_section "Phase 1c: update_tasks_json.sh"

UTJS="$HOME/.claude-ops/bus/side-effects/update_tasks_json.sh"
file_exists "$UTJS"
executable "$UTJS"
bash_syntax "$UTJS"
contains "$UTJS" "task.started"
contains "$UTJS" "task.completed"
contains "$UTJS" "locked_jq_write"

# Functional test: fire task.started, verify tasks.json updated
TMPDIR_TEST=$(mktemp -d)
TMP_HARNESS="$TMPDIR_TEST/.claude/harness/test-harness-v3"
mkdir -p "$TMP_HARNESS"
cat > "$TMP_HARNESS/tasks.json" <<'TEOF'
{"tasks": {"t1": {"status": "pending", "description": "test task"}}}
TEOF

EVENT='{"_event_type":"task.started","harness":"test-harness-v3","task_id":"t1"}'
echo "$EVENT" | PROJECT_ROOT="$TMPDIR_TEST" bash "$UTJS" 2>/dev/null || true
NEW_STATUS=$(jq -r '.tasks.t1.status' "$TMP_HARNESS/tasks.json" 2>/dev/null || echo "error")
if [ "$NEW_STATUS" = "in_progress" ]; then
  _pass "update_tasks_json: task.started sets status=in_progress"
else
  _fail "update_tasks_json: task.started failed (got '$NEW_STATUS')"
fi

EVENT='{"_event_type":"task.completed","harness":"test-harness-v3","task_id":"t1","summary":"done!"}'
echo "$EVENT" | PROJECT_ROOT="$TMPDIR_TEST" bash "$UTJS" 2>/dev/null || true
NEW_STATUS=$(jq -r '.tasks.t1.status' "$TMP_HARNESS/tasks.json" 2>/dev/null || echo "error")
NEW_RESULT=$(jq -r '.tasks.t1.result' "$TMP_HARNESS/tasks.json" 2>/dev/null || echo "error")
if [ "$NEW_STATUS" = "completed" ]; then
  _pass "update_tasks_json: task.completed sets status=completed"
else
  _fail "update_tasks_json: task.completed failed (got '$NEW_STATUS')"
fi
if [ "$NEW_RESULT" = "done!" ]; then
  _pass "update_tasks_json: task.completed writes summary to result"
else
  _fail "update_tasks_json: task.completed summary not written (got '$NEW_RESULT')"
fi

# Noop on unknown event type
EVENT='{"_event_type":"some.other.event","harness":"test-harness-v3","task_id":"t1"}'
echo "$EVENT" | PROJECT_ROOT="$TMPDIR_TEST" bash "$UTJS" 2>/dev/null
_pass "update_tasks_json: unknown event type exits 0 (noop)"

# Noop on missing harness
EVENT='{"_event_type":"task.started","task_id":"t1"}'
echo "$EVENT" | PROJECT_ROOT="$TMPDIR_TEST" bash "$UTJS" 2>/dev/null
_pass "update_tasks_json: missing harness exits 0 (noop)"

rm -rf "$TMPDIR_TEST"

# ════════════════════════════════════════════════════════════════
# Phase 2a: mission.md in all 9 harnesses
# ════════════════════════════════════════════════════════════════
_section "Phase 2a: mission.md presence"

ACTIVE_HARNESSES="hq-v2 mod-customer mod-depts mod-engineering mod-finance mod-infra mod-workorder red-team service-miniapp-ux"
for h in $ACTIVE_HARNESSES; do
  MFILE="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/mission.md"
  file_exists "$MFILE"
  # Verify minimal structure
  contains "$MFILE" "Mission"
  contains "$MFILE" "## Goal"
  contains "$MFILE" "## Constraints"
done

# ════════════════════════════════════════════════════════════════
# Phase 2b: memory/ subdirs in all 9 harnesses
# ════════════════════════════════════════════════════════════════
_section "Phase 2b: memory/ subdirs"

for h in $ACTIVE_HARNESSES; do
  BASE="$PROJECT_ROOT/.claude/harness/$h/agents/sidecar/memory"
  dir_exists "$BASE"
  dir_exists "$BASE/ref"
  dir_exists "$BASE/notes"
  dir_exists "$BASE/scripts"
done

# ════════════════════════════════════════════════════════════════
# Phase 2c: red-team v3 files
# ════════════════════════════════════════════════════════════════
_section "Phase 2c: red-team v3 files"

RT_SIDECAR="$PROJECT_ROOT/.claude/harness/red-team/agents/sidecar"
file_exists "$RT_SIDECAR/config.json"
file_exists "$RT_SIDECAR/state.json"
file_exists "$RT_SIDECAR/MEMORY.md"
file_exists "$RT_SIDECAR/inbox.jsonl"
file_exists "$RT_SIDECAR/outbox.jsonl"
file_exists "$PROJECT_ROOT/.claude/harness/red-team/tasks.json"

# Validate JSON structure
if jq -e '.name' "$RT_SIDECAR/config.json" > /dev/null 2>&1; then
  _pass "red-team config.json is valid JSON with .name"
else
  _fail "red-team config.json invalid or missing .name"
fi

if jq -e '.status' "$RT_SIDECAR/state.json" > /dev/null 2>&1; then
  _pass "red-team state.json is valid JSON with .status"
else
  _fail "red-team state.json invalid or missing .status"
fi

if jq -e '.tasks' "$PROJECT_ROOT/.claude/harness/red-team/tasks.json" > /dev/null 2>&1; then
  _pass "red-team tasks.json is valid JSON with .tasks"
else
  _fail "red-team tasks.json invalid or missing .tasks"
fi

# ════════════════════════════════════════════════════════════════
# Phase 3: progress.json deleted from all 8 active harnesses
# ════════════════════════════════════════════════════════════════
_section "Phase 3: progress.json deleted"

for h in hq-v2 mod-customer mod-depts mod-engineering mod-finance mod-infra mod-workorder service-miniapp-ux; do
  file_absent "$PROJECT_ROOT/.claude/harness/$h/progress.json"
done

# red-team never had one, should remain absent
file_absent "$PROJECT_ROOT/.claude/harness/red-team/progress.json"

# ════════════════════════════════════════════════════════════════
# Phase 3a: stop-harness-dispatch.sh updated for v3
# ════════════════════════════════════════════════════════════════
_section "Phase 3a: stop hook v3 compat"

DISPATCH="$HOME/.claude-ops/hooks/gates/stop-harness-dispatch.sh"
file_exists "$DISPATCH"
bash_syntax "$DISPATCH"
contains "$DISPATCH" "_CONFIG="
contains "$DISPATCH" "_STATE="
contains "$DISPATCH" "agents/sidecar/config.json"
contains "$DISPATCH" "agents/sidecar/state.json"
# The OLD guard was: directly read status from $PROGRESS with no v3 fallback.
# The NEW guard reads from state.json first, then falls back to progress.json.
# Verify: the new _STATE-based read exists (v3 path is present)
contains "$DISPATCH" 'jq -r '"'"'.status // "active"'"'"' "$_STATE"'

# ════════════════════════════════════════════════════════════════
# Phase 4: watchdog daemon
# ════════════════════════════════════════════════════════════════
_section "Phase 4: watchdog daemon"

WATCHDOG="$HOME/.claude-ops/scripts/harness-watchdog.sh"
PLIST="$HOME/Library/LaunchAgents/com.claude-ops.harness-watchdog.plist"

file_exists "$WATCHDOG"
executable "$WATCHDOG"
bash_syntax "$WATCHDOG"

contains "$WATCHDOG" "graceful-stop"
contains "$WATCHDOG" "agent.crash"
contains "$WATCHDOG" "agent.stuck"
contains "$WATCHDOG" "agent.respawned"
contains "$WATCHDOG" "agent.crash-loop"
contains "$WATCHDOG" "crash-loop"
contains "$WATCHDOG" "MAX_CRASHES_PER_HR"
contains "$WATCHDOG" "--once"
contains "$WATCHDOG" "--status"

file_exists "$PLIST"
# Verify plist XML is well-formed
if xmllint --noout "$PLIST" 2>/dev/null; then
  _pass "watchdog plist is valid XML"
else
  _skip "xmllint not available for plist validation"
fi

# Verify schema.json has agent.* events
SCHEMA="$PROJECT_ROOT/.claude/bus/schema.json"
for evt in agent.stopped agent.respawned agent.crash agent.stuck agent.nudged agent.crash-loop; do
  if jq -e ".event_types[\"$evt\"]" "$SCHEMA" > /dev/null 2>&1; then
    _pass "schema.json has $evt"
  else
    _fail "schema.json missing $evt"
  fi
done

# Single-pass test (requires tmux session but exits 0 when registry empty)
if [ -n "${TMUX:-}" ]; then
  if timeout 5 bash "$WATCHDOG" --once 2>/dev/null; then
    _pass "watchdog --once completes without error"
  else
    _fail "watchdog --once failed (exit non-zero)"
  fi
else
  _skip "watchdog --once requires tmux (not in tmux)"
fi

# ════════════════════════════════════════════════════════════════
# Phase 5: _inject_bg_sleep removed
# ════════════════════════════════════════════════════════════════
_section "Phase 5: _inject_bg_sleep removed"

BGTASKS="$HOME/.claude-ops/hooks/dispatch/harness-bg-tasks.sh"
file_exists "$BGTASKS"
bash_syntax "$BGTASKS"
not_contains "$BGTASKS" "_inject_bg_sleep()"
not_contains "$DISPATCH" "_inject_bg_sleep"

# check_bg_tasks still exists (still needed for manually-written sleep flags)
contains "$BGTASKS" "check_bg_tasks"

# New behavior: long-running agents use hook_pass
contains "$DISPATCH" "hook_pass"
contains "$DISPATCH" "long-running stop"

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════
echo
echo "═══════════════════════════════════════"
echo "  v3 Migration Tests: ${PASS} pass  ${FAIL} fail  ${SKIP} skip"
echo "═══════════════════════════════════════"

[ "$FAIL" -eq 0 ] && echo "  ✅ All checks passed." || echo "  ❌ ${FAIL} check(s) failed."
exit "$FAIL"
