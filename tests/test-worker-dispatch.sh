#!/usr/bin/env bash
# test-worker-dispatch.sh — Tests for lib/worker-dispatch.sh
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

# ── Setup ──────────────────────────────────────────────────────
TMPDIR=$(mktemp -d)
WORKER_NAME="test-worker-$$"
SIDECAR_NAME_TEST="test-sidecar-$$"
PROJECT_ROOT_TEST="$TMPDIR"

cleanup() {
  rm -rf "$TMPDIR"
  rm -rf "$HOME/.claude-ops/harness/manifests/$WORKER_NAME"
  rm -rf "$HOME/.claude-ops/harness/manifests/$SIDECAR_NAME_TEST"
}
trap cleanup EXIT

# Create sidecar agent dir (v3: agents/module-manager)
mkdir -p "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/module-manager"
cat > "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/module-manager/config.json" <<JSON
{
  "name": "$SIDECAR_NAME_TEST",
  "lifecycle": "long-running"
}
JSON
cat > "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/module-manager/permissions.json" <<'JSON'
{
  "model": "cds",
  "permission_mode": "bypassPermissions"
}
JSON

mkdir -p "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/worker/worker-alpha"
cat > "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/worker/worker-alpha/permissions.json" <<'JSON'
{
  "model": "cdo",
  "permission_mode": "default",
  "allowedTools": ["Read:**"]
}
JSON

mkdir -p "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/worker/worker-beta"
cat > "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/worker/worker-beta/permissions.json" <<'JSON'
{
  "model": "cds",
  "permission_mode": "bypassPermissions"
}
JSON

mkdir -p "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/worker/worker-gamma"
cat > "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/agents/worker/worker-gamma/permissions.json" <<'JSON'
{
  "model": "cdh",
  "permission_mode": "default"
}
JSON

# Create worker tasks.json (v3)
mkdir -p "$TMPDIR/.claude/harness/worker-alpha"
cat > "$TMPDIR/.claude/harness/worker-alpha/tasks.json" <<JSON
{
  "harness": "worker-alpha",
  "mission": "Test worker",
  "lifecycle": "bounded",
  "status": "active",
  "started_at": "2026-01-01T00:00:00Z",
  "session_count": 0,
  "cycles_completed": 0,
  "tasks": {
    "task-1": {
      "status": "completed",
      "description": "First task",
      "blockedBy": []
    },
    "task-2": {
      "status": "pending",
      "description": "Second task",
      "blockedBy": []
    }
  },
  "commits": [],
  "learnings": []
}
JSON

# Create worker policy.json
cat > "$TMPDIR/.claude/harness/worker-alpha/policy.json" <<JSON
{
  "rules": {},
  "inject": {
    "tool_context": {},
    "file_context": {},
    "command_context": {}
  }
}
JSON

# Create worker journal.md
cat > "$TMPDIR/.claude/harness/worker-alpha/journal.md" <<MD
# worker-alpha Journal

## Cycle 1 — 2026-01-01

Initial setup.
MD

# Create sidecar progress.json
cat > "$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/progress.json" <<JSON
{
  "harness": "$SIDECAR_NAME_TEST",
  "mission": "Test sidecar",
  "lifecycle": "long-running",
  "status": "active",
  "started_at": "2026-01-01T00:00:00Z",
  "session_count": 0,
  "cycles_completed": 0,
  "tasks": {},
  "state": {
    "workers": []
  },
  "commits": [],
  "learnings": []
}
JSON

# Create manifests for resolution
mkdir -p "$HOME/.claude-ops/harness/manifests/worker-alpha"
cat > "$HOME/.claude-ops/harness/manifests/worker-alpha/manifest.json" <<JSON
{
  "harness": "worker-alpha",
  "project_root": "$TMPDIR",
  "files": {
    "progress": ".claude/harness/worker-alpha/tasks.json"
  },
  "status": "active"
}
JSON

mkdir -p "$HOME/.claude-ops/harness/manifests/$SIDECAR_NAME_TEST"
cat > "$HOME/.claude-ops/harness/manifests/$SIDECAR_NAME_TEST/manifest.json" <<JSON
{
  "harness": "$SIDECAR_NAME_TEST",
  "project_root": "$TMPDIR",
  "files": {
    "progress": ".claude/harness/$SIDECAR_NAME_TEST/progress.json"
  },
  "status": "active"
}
JSON

# Source the library under test
export SIDECAR_NAME="$SIDECAR_NAME_TEST"
export PROJECT_ROOT="$TMPDIR"
source "$HOME/.claude-ops/lib/worker-dispatch.sh"

echo "── worker-dispatch.sh ──"

# ── Test 1: JSON parser extracts correct worker count ──────────
TOTAL=$((TOTAL + 1))
WORKER_COUNT=$(worker_discover | wc -l | tr -d ' ')
if [ "$WORKER_COUNT" -eq 3 ]; then
  echo -e "  ${GREEN}PASS${RESET} JSON parser: correct worker count (3)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} JSON parser: expected 3 workers, got $WORKER_COUNT"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: JSON parser extracts correct models ───────────────
TOTAL=$((TOTAL + 1))
ALPHA_MODEL=$(worker_discover | grep '^worker-alpha|' | cut -d'|' -f2)
BETA_MODEL=$(worker_discover | grep '^worker-beta|' | cut -d'|' -f2)
GAMMA_MODEL=$(worker_discover | grep '^worker-gamma|' | cut -d'|' -f2)
if [ "$ALPHA_MODEL" = "cdo" ] && [ "$BETA_MODEL" = "cds" ] && [ "$GAMMA_MODEL" = "cdh" ]; then
  echo -e "  ${GREEN}PASS${RESET} JSON parser: correct model extraction"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} JSON parser: models=$ALPHA_MODEL/$BETA_MODEL/$GAMMA_MODEL"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: JSON parser extracts correct modes ────────────────
TOTAL=$((TOTAL + 1))
BETA_MODE=$(worker_discover | grep '^worker-beta|' | cut -d'|' -f3)
if [ "$BETA_MODE" = "bypassPermissions" ]; then
  echo -e "  ${GREEN}PASS${RESET} JSON parser: correct mode extraction"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} JSON parser: expected bypassPermissions, got $BETA_MODE"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: State sync updates sidecar's workers[] ────────────
worker_sync_state "worker-alpha" "alive"

TOTAL=$((TOTAL + 1))
SIDECAR_PROGRESS="$TMPDIR/.claude/harness/$SIDECAR_NAME_TEST/progress.json"
WORKER_STATUS=$(jq -r '.state.workers[] | select(.name == "worker-alpha") | .status' "$SIDECAR_PROGRESS")
if [ "$WORKER_STATUS" = "alive" ]; then
  echo -e "  ${GREEN}PASS${RESET} State sync: sidecar's state.workers[] updated"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} State sync: worker status=$WORKER_STATUS, expected alive"
  FAIL=$((FAIL + 1))
fi

# ── Test 10: State sync adds new worker if not present ────────
worker_sync_state "worker-beta" "dead"

TOTAL=$((TOTAL + 1))
BETA_STATUS=$(jq -r '.state.workers[] | select(.name == "worker-beta") | .status' "$SIDECAR_PROGRESS")
if [ "$BETA_STATUS" = "dead" ]; then
  echo -e "  ${GREEN}PASS${RESET} State sync: new worker added to state.workers[]"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} State sync: worker-beta not found or wrong status"
  FAIL=$((FAIL + 1))
fi

# ── Test 11: Read progress returns correct summary ────────────
TOTAL=$((TOTAL + 1))
PROGRESS_SUMMARY=$(worker_read_progress "worker-alpha")
# Original: 1 completed (task-1), plus sidecar tasks pending
DONE=$(echo "$PROGRESS_SUMMARY" | cut -d'|' -f1)
TOTAL_TASKS=$(echo "$PROGRESS_SUMMARY" | cut -d'|' -f2)
if [ "$DONE" -ge 1 ] && [ "$TOTAL_TASKS" -ge 2 ]; then
  echo -e "  ${GREEN}PASS${RESET} Read progress: correct done/total counts"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Read progress: summary=$PROGRESS_SUMMARY"
  FAIL=$((FAIL + 1))
fi

# ── Test 12: Health check for missing pane ────────────────────
TOTAL=$((TOTAL + 1))
HEALTH=$(worker_health "nonexistent-worker-$$")
if echo "$HEALTH" | grep -q "^no_pane|"; then
  echo -e "  ${GREEN}PASS${RESET} Health check: returns no_pane for missing worker"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Health check: expected no_pane, got $HEALTH"
  FAIL=$((FAIL + 1))
fi

# ── Test 13: Health-all returns status for each worker ────────
TOTAL=$((TOTAL + 1))
HEALTH_ALL=$(worker_health_all)
HEALTH_COUNT=$(echo "$HEALTH_ALL" | wc -l | tr -d ' ')
if [ "$HEALTH_COUNT" -eq 3 ]; then
  echo -e "  ${GREEN}PASS${RESET} Health-all: returns status for all 3 workers"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Health-all: expected 3 lines, got $HEALTH_COUNT"
  FAIL=$((FAIL + 1))
fi

# ── Test 14: JSON parser handles single worker directory ──────
mkdir -p "$TMPDIR/nosidecar/agents/worker/solo-worker"
cat > "$TMPDIR/nosidecar/agents/worker/solo-worker/permissions.json" <<'JSON'
{
  "model": "cdo",
  "permission_mode": "default"
}
JSON

TOTAL=$((TOTAL + 1))
SOLO_COUNT=$(_parse_workers_json "$TMPDIR/nosidecar" | wc -l | tr -d ' ')
if [ "$SOLO_COUNT" -eq 1 ]; then
  echo -e "  ${GREEN}PASS${RESET} JSON parser: handles single worker directory"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} JSON parser: expected 1 worker, got $SOLO_COUNT"
  FAIL=$((FAIL + 1))
fi

# ── Summary ────────────────────────────────────────────────────
test_summary
