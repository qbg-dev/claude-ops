#!/usr/bin/env bash
# test-tool-policy-gate.sh — Unit tests for hooks/gates/tool-policy-gate.sh
#
# Tests:
#   1. Passes (allows) when no permissions.json
#   2. Passes when denyList is empty
#   3. Blocks exact tool name (no arg pattern)
#   4. Blocks Bash glob pattern (git push*)
#   5. Allows non-matching Bash command
#   6. Blocks chained command via ; or &&
#   7. Blocks env/command prefix bypass attempt
#   8. Blocks bash -c inner command
#   9. Blocks Edit file glob
#  10. Blocks Write file glob
#  11. Allows Read not in denyList
#  12. Blocks direct prod IP from worktree
#  13. Blocks deploy-prod.sh glob pattern
#  14. Whitelist: notify command always allowed
#  15. Flat worker harness path resolution (worker/name)
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

HOOK="$HOME/.claude-ops/hooks/gates/tool-policy-gate.sh"

# ── Setup: temp project dir + state dir ──────────────────────────────
TMPDIR=$(mktemp -d)
MOCK_STATE_DIR=$(mktemp -d)

cleanup() { rm -rf "$TMPDIR" "$MOCK_STATE_DIR"; }
trap cleanup EXIT

# Override HARNESS_STATE_DIR so fleet-jq.sh sets PANE_REGISTRY to our temp file
export HARNESS_STATE_DIR="$MOCK_STATE_DIR"
MOCK_PANE_REGISTRY="$MOCK_STATE_DIR/pane-registry.json"

# Find our own tmux pane (we're in tmux — needed to inject HARNESS)
_OWN_PANE=""
if [ -n "${TMUX:-}" ]; then
  source "$HOME/.claude-ops/lib/fleet-jq.sh" 2>/dev/null || true
  _OWN_PANE=$(hook_find_own_pane 2>/dev/null || echo "")
fi

# Register pane → test worker harness in mock pane registry
_WORKER_NAME="test-gate-worker"
_HARNESS_KEY="worker/$_WORKER_NAME"
mkdir -p "$TMPDIR/.claude/workers/$_WORKER_NAME"
if [ -n "$_OWN_PANE" ]; then
  echo "{\"$_OWN_PANE\":{\"harness\":\"$_HARNESS_KEY\"}}" > "$MOCK_PANE_REGISTRY"
else
  echo '{}' > "$MOCK_PANE_REGISTRY"
fi

# Helper: run hook with given tool + input JSON
# Usage: run_gate <tool_name> <tool_input_json>
run_gate() {
  local tool="$1" input="$2"
  echo "{\"session_id\":\"test-$$\",\"tool_name\":\"$tool\",\"tool_input\":$input}" \
    | HARNESS_STATE_DIR="$MOCK_STATE_DIR" PROJECT_ROOT="$TMPDIR" bash "$HOOK" 2>/dev/null
}

# ─────────────────────────────────────────────────────────────────────
# Helper: write a permissions.json for test worker
# Usage: write_perms '<json>'
write_perms() {
  echo "$1" > "$TMPDIR/.claude/workers/$_WORKER_NAME/permissions.json"
}

# Tear down permissions.json
rm_perms() {
  rm -f "$TMPDIR/.claude/workers/$_WORKER_NAME/permissions.json"
}

echo "── tool-policy-gate.sh ──"

# ─────────────────────────────────────────────────────────────────────
# Test 1: No permissions.json → pass (return {})
# ─────────────────────────────────────────────────────────────────────
rm_perms
RESULT=$(run_gate "Bash" '{"command":"git push origin main"}')
assert_empty "no permissions.json: allows all tools" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 2: Empty denyList → pass
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":[]}'
RESULT=$(run_gate "Bash" '{"command":"git push origin main"}')
assert_empty "empty denyList: allows all tools" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 3: Block exact tool name (no arg pattern)
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["WebFetch"]}'
RESULT=$(run_gate "WebFetch" '{"url":"https://example.com"}')
assert "exact tool block: WebFetch blocked" "block" "$RESULT"

# Confirm other tools still pass
RESULT2=$(run_gate "Read" '{"file_path":"/tmp/foo.txt"}')
assert_empty "exact tool block: Read still allowed" "$RESULT2"

# ─────────────────────────────────────────────────────────────────────
# Test 4: Block Bash glob pattern
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["Bash(git push*)"]}'

RESULT=$(run_gate "Bash" '{"command":"git push origin main"}')
assert "bash glob: blocks git push" "block" "$RESULT"

RESULT=$(run_gate "Bash" '{"command":"git push --force"}')
assert "bash glob: blocks git push --force" "block" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 5: Allow non-matching Bash command
# ─────────────────────────────────────────────────────────────────────
RESULT=$(run_gate "Bash" '{"command":"git status"}')
assert_empty "bash glob: git status allowed" "$RESULT"

RESULT=$(run_gate "Bash" '{"command":"ls -la"}')
assert_empty "bash glob: ls allowed" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 6: Block chained command (; or &&)
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["Bash(git push*)"]}'
RESULT=$(run_gate "Bash" '{"command":"git status && git push origin main"}')
assert "chained &&: blocks git push after &&" "block" "$RESULT"

RESULT=$(run_gate "Bash" '{"command":"echo hello; git push origin main"}')
assert "chained ;: blocks git push after ;" "block" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 7: env prefix bypass attempt
# ─────────────────────────────────────────────────────────────────────
RESULT=$(run_gate "Bash" '{"command":"env git push origin main"}')
assert "env prefix: still blocks git push" "block" "$RESULT"

RESULT=$(run_gate "Bash" '{"command":"/usr/bin/env git push origin main"}')
assert "/usr/bin/env prefix: still blocks git push" "block" "$RESULT"

RESULT=$(run_gate "Bash" '{"command":"command git push origin main"}')
assert "command prefix: still blocks git push" "block" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 8: bash -c inner command bypass attempt
# ─────────────────────────────────────────────────────────────────────
RESULT=$(run_gate "Bash" '{"command":"bash -c \"git push origin main\""}')
assert "bash -c: blocks inner git push" "block" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 9: Block Edit file glob
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["Edit(data/**)"]}'

RESULT=$(run_gate "Edit" "{\"file_path\":\"$TMPDIR/data/config/settings.json\",\"old_string\":\"a\",\"new_string\":\"b\"}")
assert "edit glob: blocks edit in data/**" "block" "$RESULT"

RESULT=$(run_gate "Edit" "{\"file_path\":\"$TMPDIR/src/main.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}")
assert_empty "edit glob: allows edit outside data/" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 10: Block Write file glob
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["Write(data/**)"]}'

RESULT=$(run_gate "Write" "{\"file_path\":\"$TMPDIR/data/users.json\",\"content\":\"{}\"}")
assert "write glob: blocks write in data/**" "block" "$RESULT"

RESULT=$(run_gate "Write" "{\"file_path\":\"$TMPDIR/src/utils.ts\",\"content\":\"export {}\"}")
assert_empty "write glob: allows write outside data/" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 11: Read tool not in denyList → allowed
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["Edit(data/**)","Write(data/**)"]}'

RESULT=$(run_gate "Read" "{\"file_path\":\"$TMPDIR/data/secret.json\"}")
assert_empty "read not in denyList: allowed even for data/**" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 12: Direct prod IP blocked from worktrees
# Set up a real worktree structure: MAIN_REPO with permissions.json,
# WORKTREE with a .git file pointing at MAIN_REPO.
# After worktree detection, PROJECT_ROOT becomes MAIN_REPO where perms exist.
# ─────────────────────────────────────────────────────────────────────
_MAIN_REPO=$(mktemp -d)
_WORKTREE=$(mktemp -d)

# Create permissions.json in the main repo (non-empty denyList required to pass
# the early-exit gate, so IP check is reachable)
mkdir -p "$_MAIN_REPO/.claude/workers/$_WORKER_NAME"
echo '{"permission_mode":"bypassPermissions","denyList":["Bash(never-match-xyz*)"]}' \
  > "$_MAIN_REPO/.claude/workers/$_WORKER_NAME/permissions.json"

# Create worktree .git file pointing to main repo (no /worktrees/ suffix here)
echo "gitdir: $_MAIN_REPO" > "$_WORKTREE/.git"

# Helper for worktree tests
run_gate_wt() {
  local tool="$1" input="$2"
  echo "{\"session_id\":\"test-$$\",\"tool_name\":\"$tool\",\"tool_input\":$input}" \
    | HARNESS_STATE_DIR="$MOCK_STATE_DIR" PROJECT_ROOT="$_WORKTREE" bash "$HOOK" 2>/dev/null
}

RESULT=$(run_gate_wt "Bash" '{"command":"sshpass -p secret ssh root@120.77.216.196 ls"}')
assert "prod IP gate: blocks direct prod ssh from worktree" "block" "$RESULT"

RESULT=$(run_gate_wt "Bash" '{"command":"rsync -av dist/ root@120.77.216.196:/opt/app/"}')
assert "prod IP gate: blocks rsync to prod from worktree" "block" "$RESULT"

# Non-prod IP should still be allowed (denied pattern is never-match-xyz*)
RESULT=$(run_gate_wt "Bash" '{"command":"ssh root@8.129.82.75 ls"}')
assert_empty "prod IP gate: non-prod IP allowed from worktree" "$RESULT"

rm -rf "$_MAIN_REPO" "$_WORKTREE"

# ─────────────────────────────────────────────────────────────────────
# Test 13: Deploy-prod glob
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["Bash(*deploy-prod.sh*)"]}'

RESULT=$(run_gate "Bash" '{"command":"echo y | ./scripts/deploy-prod.sh --fast"}')
assert "deploy glob: blocks deploy-prod.sh" "block" "$RESULT"

RESULT=$(run_gate "Bash" '{"command":"./scripts/deploy.sh --service static"}')
assert_empty "deploy glob: deploy.sh (test server) allowed" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 14: Whitelist — notify command always passes
# ─────────────────────────────────────────────────────────────────────
write_perms '{"permission_mode":"bypassPermissions","denyList":["Bash(notify*)"]}'

RESULT=$(run_gate "Bash" '{"command":"notify \"task done\""}')
assert_empty "whitelist: notify always allowed even in denyList" "$RESULT"

write_perms '{"permission_mode":"bypassPermissions","denyList":["Bash(*worker-message.sh*)"]}'
RESULT=$(run_gate "Bash" '{"command":"bash ~/.claude-ops/scripts/worker-message.sh chief-of-staff \"done\""}')
assert_empty "whitelist: worker-message.sh always allowed" "$RESULT"

# ─────────────────────────────────────────────────────────────────────
# Test 15: Worker permissions.json path resolution
# ─────────────────────────────────────────────────────────────────────
# Verify permissions.json at .claude/workers/{name}/ is found
write_perms '{"permission_mode":"bypassPermissions","denyList":["WebSearch"]}'
RESULT=$(run_gate "WebSearch" '{"query":"test"}')
assert "path resolution: .claude/workers/ perms found" "block" "$RESULT"

test_summary
