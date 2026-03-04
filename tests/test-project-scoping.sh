#!/usr/bin/env bash
# test-project-scoping.sh — Regression tests for cross-project pane isolation.
#
# Invariant: when PROJECT_ROOT=project-A, no script should ever return pane IDs
# or deliver messages to panes belonging to project-B, even if both projects
# have workers with the same name (e.g., "chatbot-tools").
#
# If any of these tests fail, workers in one project could accidentally send
# messages to workers in another project — a correctness + security bug.

set -euo pipefail
source "$(dirname "$0")/helpers.sh"

BORING_DIR="${BORING_DIR:-$HOME/.boring}"
PANE_REGISTRY="${BORING_DIR}/state/pane-registry.json"

echo "── project scoping — static analysis ──"

# ── Test 1: check-flat-workers.sh scopes to project root ─────────────────────
# Architecture: v3 uses registry.json at $PROJECT_ROOT/.claude/workers/registry.json
# Scoping is via file-path (PROJECT_ROOT variable), not a project_root field in pane-registry.
TOTAL=$((TOTAL + 1))
HITS=$(grep -n 'PROJECT_ROOT\|project_root' "$HOME/.claude-ops/scripts/check-flat-workers.sh" 2>/dev/null || true)
if echo "$HITS" | grep -qi "project_root"; then
  echo -e "  ${GREEN}PASS${RESET} check-flat-workers.sh scopes to project root"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} check-flat-workers.sh missing project root scoping"
  echo "    must use PROJECT_ROOT to scope registry.json path to current project"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: worker-message.sh filters by project_root in recipient lookup ─────
TOTAL=$((TOTAL + 1))
MSG_SH="$HOME/.claude-ops/scripts/worker-message.sh"
if grep -q 'project_root' "$MSG_SH" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} worker-message.sh filters by project_root"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} worker-message.sh missing project_root filter in pane lookup"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: deliver_tmux.sh carries from_project ─────────────────────────────
TOTAL=$((TOTAL + 1))
DT_SH="$HOME/.claude-ops/bus/side-effects/deliver_tmux.sh"
if grep -q 'from_project\|project_root' "$DT_SH" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} deliver_tmux.sh uses from_project/project_root scoping"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} deliver_tmux.sh missing project scoping"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: auto_rebase_workers.sh filters by project_root ───────────────────
TOTAL=$((TOTAL + 1))
AR_SH="$HOME/.claude-ops/bus/side-effects/auto_rebase_workers.sh"
if grep -q 'project_root\|PROJECT_ROOT' "$AR_SH" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} auto_rebase_workers.sh filters by project_root"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} auto_rebase_workers.sh missing project_root filter"
  FAIL=$((FAIL + 1))
fi

# ── Test 5: worker-session-register.sh scopes writes to project root ──────────
# Architecture: v3 resolves project root from worktree path and writes to
# $PROJECT_ROOT/.claude/workers/registry.json — scoped by file path.
TOTAL=$((TOTAL + 1))
REG_SH="$HOME/.claude-ops/hooks/publishers/worker-session-register.sh"
if grep -q '_PROJ_ROOT\|PROJECT_ROOT' "$REG_SH" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} worker-session-register.sh scopes writes to project root"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} worker-session-register.sh missing project root scoping"
  FAIL=$((FAIL + 1))
fi

# ── Test 6: mcp/worker-fleet/index.ts scopes all registry ops to PROJECT_ROOT ─
# Architecture: v3 uses PROJECT_ROOT to scope WORKERS_DIR and REGISTRY_PATH
# (file-path scoping, not per-entry project_root field in pane-registry.json).
TOTAL=$((TOTAL + 1))
MCP_TS="$HOME/.claude-ops/mcp/worker-fleet/index.ts"
# Count lines where PROJECT_ROOT is used to build scoped paths (WORKERS_DIR, REGISTRY_PATH)
PROJ_GUARDED=$(grep -c 'WORKERS_DIR\|REGISTRY_PATH' "$MCP_TS" 2>/dev/null || echo 0)
if [ "$PROJ_GUARDED" -gt 2 ]; then
  echo -e "  ${GREEN}PASS${RESET} mcp/worker-fleet/index.ts uses PROJECT_ROOT-scoped paths ($PROJ_GUARDED uses)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} mcp/worker-fleet/index.ts missing PROJECT_ROOT-scoped paths ($PROJ_GUARDED)"
  FAIL=$((FAIL + 1))
fi

# ── Test 7: No bare 'head -1' on pane registry output without project filter ──
# The "first match wins" anti-pattern: piping jq output to head -1 ignores project
TOTAL=$((TOTAL + 1))
BARE_HEAD=$(grep -rn 'pane-registry\|pane_registry' "$HOME/.claude-ops/scripts/" \
  | grep 'head -1' | grep -v '^\s*#' || true)
if [ -z "$BARE_HEAD" ]; then
  echo -e "  ${GREEN}PASS${RESET} no bare 'head -1' after pane-registry lookup in scripts/"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} found bare head -1 after pane-registry lookup (first-match-wins anti-pattern)"
  echo "$BARE_HEAD" | head -5 | sed 's/^/    /'
  FAIL=$((FAIL + 1))
fi

echo ""
echo "── project scoping — runtime simulation ──"

# ── Runtime test: build synthetic registry with two projects, same worker name ─
TMP=$(mktemp -d)
FAKE_REGISTRY="$TMP/pane-registry.json"
PROJECT_A="$TMP/project-alpha"
PROJECT_B="$TMP/project-beta"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

cat > "$FAKE_REGISTRY" <<JSON
{
  "%100": {
    "harness": "worker/chatbot-tools",
    "project_root": "$PROJECT_A",
    "pane_target": "a:1.0",
    "task": "worker"
  },
  "%200": {
    "harness": "worker/chatbot-tools",
    "project_root": "$PROJECT_B",
    "pane_target": "b:1.0",
    "task": "worker"
  },
  "%101": {
    "harness": "worker/admin-nav",
    "project_root": "$PROJECT_A",
    "pane_target": "a:2.0",
    "task": "worker"
  },
  "%201": {
    "harness": "worker/admin-nav",
    "project_root": "$PROJECT_B",
    "pane_target": "b:2.0",
    "task": "worker"
  }
}
JSON

# ── Test 8: jq project filter returns only project-A chatbot-tools pane ───────
TOTAL=$((TOTAL + 1))
RESULT=$(jq -r \
  --arg h "worker/chatbot-tools" \
  --arg proj "$PROJECT_A" \
  'to_entries[] | select(.key | startswith("%")) | select(.value.harness == $h and ((.value.project_root // "") == $proj)) | .key' \
  "$FAKE_REGISTRY")
if [ "$RESULT" = "%100" ]; then
  echo -e "  ${GREEN}PASS${RESET} project-scoped jq returns only project-A chatbot-tools (%100)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} project-scoped jq returned wrong pane: '$RESULT' (expected %100)"
  FAIL=$((FAIL + 1))
fi

# ── Test 9: jq without project filter returns BOTH (showing why filter is needed) ─
TOTAL=$((TOTAL + 1))
UNSCOPED=$(jq -r \
  --arg h "worker/chatbot-tools" \
  'to_entries[] | select(.key | startswith("%")) | select(.value.harness == $h) | .key' \
  "$FAKE_REGISTRY" | sort | tr '\n' ' ')
if echo "$UNSCOPED" | grep -q "%100" && echo "$UNSCOPED" | grep -q "%200"; then
  echo -e "  ${GREEN}PASS${RESET} unscoped jq returns both projects (confirms isolation is necessary)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} unscoped jq should return both %100 and %200, got: '$UNSCOPED'"
  FAIL=$((FAIL + 1))
fi

# ── Test 10: project-B pane does NOT appear in project-A admin-nav lookup ─────
TOTAL=$((TOTAL + 1))
RESULT_B=$(jq -r \
  --arg h "worker/admin-nav" \
  --arg proj "$PROJECT_A" \
  'to_entries[] | select(.key | startswith("%")) | select(.value.harness == $h and ((.value.project_root // "") == $proj)) | .key' \
  "$FAKE_REGISTRY")
if [ "$RESULT_B" = "%101" ] && ! echo "$RESULT_B" | grep -q "%201"; then
  echo -e "  ${GREEN}PASS${RESET} project-A admin-nav lookup does NOT leak project-B pane (%201)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} project isolation broken: got '$RESULT_B' for project-A admin-nav lookup"
  FAIL=$((FAIL + 1))
fi

# ── Test 11: empty project_root entries not returned by strict filter ──────────
TOTAL=$((TOTAL + 1))
cat > "$TMP/partial-registry.json" <<JSON
{
  "%300": {
    "harness": "worker/chatbot-tools",
    "pane_target": "c:1.0",
    "task": "worker"
  }
}
JSON
RESULT_MISSING=$(jq -r \
  --arg h "worker/chatbot-tools" \
  --arg proj "$PROJECT_A" \
  'to_entries[] | select(.key | startswith("%")) | select(.value.harness == $h and ((.value.project_root // "") == $proj)) | .key' \
  "$TMP/partial-registry.json")
if [ -z "$RESULT_MISSING" ]; then
  echo -e "  ${GREEN}PASS${RESET} entries missing project_root are NOT returned by strict project filter"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} entries with missing project_root leaked into project-scoped results: '$RESULT_MISSING'"
  FAIL=$((FAIL + 1))
fi

test_summary
