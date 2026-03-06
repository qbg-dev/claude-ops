#!/usr/bin/env bash
# test-session-hooks.sh — Regression tests for session registration and pre-compact hooks.
#
# Covers:
#   - worker-session-register.sh: lock timeout must use exit 0 (not break)
#   - pre-compact.sh: v3 fallback reads session_id from registry.json, not pane-registry.json
#
# Bug 1 (TOCTOU): 'break' exited the lock loop but continued writing without holding the lock.
#   Fix: 'exit 0' skips the write on timeout (safe: registration is idempotent, retried next prompt).
# Bug 2 (v3 mismatch): pane-registry.json doesn't store session_id for v3 flat workers.
#   Fix: added fallback that scans $PROJECT_ROOT/.claude/workers/registry.json.
#
# Run: bash ~/.claude-ops/tests/test-session-hooks.sh
set -uo pipefail

source "$(dirname "$0")/helpers.sh"

TMPDIR_TEST=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

REGISTER_SH="$HOME/.claude-ops/hooks/publishers/worker-session-register.sh"
PRECOMPACT_SH="$HOME/.claude-ops/scripts/pre-compact.sh"

# ═══════════════════════════════════════════════════════════════════════
# PART 1: worker-session-register.sh lock timeout safety
# ═══════════════════════════════════════════════════════════════════════

echo "── session-register: lock timeout safety ──"

# Test 1: no bare 'break' after lock loop — would write without holding the lock
BARE_BREAK=$(grep -n '\] && break' "$REGISTER_SH" 2>/dev/null || true)
assert_empty "no bare 'break' after lock loop (TOCTOU anti-pattern)" "$BARE_BREAK"

# Test 2: uses 'exit 0' on timeout to skip write safely
TOTAL=$((TOTAL + 1))
if grep -q '\] && exit 0' "$REGISTER_SH" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} lock timeout uses exit 0 (skips write safely)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} lock timeout must use 'exit 0' to skip write — not 'break'"
  echo "    File: $REGISTER_SH"
  FAIL=$((FAIL + 1))
fi

# Test 3: lock release still present (rmdir after successful write)
assert_file_contains "lock is released after write" "$REGISTER_SH" "rmdir \"\$_LOCK_DIR\""

echo ""
echo "── pre-compact: v3 registry.json identity fallback ──"

# Test 4: pre-compact.sh has the v3 registry.json fallback block
assert_file_contains "pre-compact has v3 registry.json fallback" \
  "$PRECOMPACT_SH" "_V3_REG="

# Test 5: v3 fallback — finds worker by session_id in registry.json
PROJ_DIR="$TMPDIR_TEST/proj-v3"
mkdir -p "$PROJ_DIR/.claude/workers"
SESSION_TEST="test-session-abc123"
WORKER_TEST="my-test-worker"
cat > "$PROJ_DIR/.claude/workers/registry.json" <<JSON
{"$WORKER_TEST": {"session_id": "$SESSION_TEST", "status": "active", "perpetual": false}}
JSON

BRANCH="main"
_V3_REG="$PROJ_DIR/.claude/workers/registry.json"
if [ -n "$SESSION_TEST" ] && [[ "$BRANCH" != worker/* ]]; then
  if [ -f "$_V3_REG" ]; then
    _V3_NAME=$(jq -r --arg sid "$SESSION_TEST" \
      'to_entries[] | select(.value.session_id == $sid) | .key' \
      "$_V3_REG" 2>/dev/null | head -1)
    [ -n "$_V3_NAME" ] && [ "$_V3_NAME" != "null" ] && BRANCH="worker/$_V3_NAME"
  fi
fi
assert_equals "v3 fallback: finds worker by session_id" "worker/$WORKER_TEST" "$BRANCH"

# Test 6: v3 fallback — unknown session_id returns no match (branch unchanged)
BRANCH_UNK="main"
_V3_UNK=$(jq -r --arg sid "unknown-session-xyz" \
  'to_entries[] | select(.value.session_id == $sid) | .key' \
  "$_V3_REG" 2>/dev/null | head -1)
[ -n "$_V3_UNK" ] && [ "$_V3_UNK" != "null" ] && BRANCH_UNK="worker/$_V3_UNK" || true
assert_equals "v3 fallback: unknown session leaves branch unchanged" "main" "$BRANCH_UNK"

# Test 7: v3 fallback — 3-worker registry returns only the correct match
cat > "$PROJ_DIR/.claude/workers/registry.json" <<JSON
{
  "worker-a": {"session_id": "session-aaa", "status": "active"},
  "worker-b": {"session_id": "session-bbb", "status": "active"},
  "worker-c": {"session_id": "session-ccc", "status": "active"}
}
JSON
BRANCH_B="main"
_V3_B=$(jq -r --arg sid "session-bbb" \
  'to_entries[] | select(.value.session_id == $sid) | .key' \
  "$PROJ_DIR/.claude/workers/registry.json" 2>/dev/null | head -1)
[ -n "$_V3_B" ] && [ "$_V3_B" != "null" ] && BRANCH_B="worker/$_V3_B" || true
assert_equals "v3 fallback: 3-worker registry returns only correct match" "worker/worker-b" "$BRANCH_B"

# Test 8: v3 fallback — missing registry.json is handled gracefully (no crash)
BRANCH_MISS="main"
_V3_MISS="$PROJ_DIR/.claude/workers/nonexistent.json"
if [ -f "$_V3_MISS" ]; then
  _V3_MISS_NAME=$(jq -r --arg sid "$SESSION_TEST" \
    'to_entries[] | select(.value.session_id == $sid) | .key' \
    "$_V3_MISS" 2>/dev/null | head -1)
  [ -n "$_V3_MISS_NAME" ] && [ "$_V3_MISS_NAME" != "null" ] && BRANCH_MISS="worker/$_V3_MISS_NAME" || true
fi
assert_equals "v3 fallback: missing registry.json leaves branch unchanged" "main" "$BRANCH_MISS"

# Test 9: v3 fallback — worker already on worker/* branch skips registry scan
# (Simulates correct-CWD scenario — no unnecessary registry read)
BRANCH_CORRECT="worker/already-correct"
_SCANNED="no"
if [ -n "$SESSION_TEST" ] && [[ "$BRANCH_CORRECT" != worker/* ]]; then
  _SCANNED="yes"
fi
assert_equals "v3 fallback: correct-branch session skips registry scan" "no" "$_SCANNED"

echo ""
echo "── pre-compact: structural checks ──"

# Test 10: pre-compact has v3 fallback conditioned on BRANCH not being worker/*
assert_file_contains "v3 fallback guarded by BRANCH check" \
  "$PRECOMPACT_SH" '"$BRANCH" != worker/*'

# Test 11: v3 fallback sources PROJECT_ROOT (not hardcoded path)
assert_file_contains "v3 fallback uses PROJECT_ROOT variable" \
  "$PRECOMPACT_SH" '"$PROJECT_ROOT/.claude/workers/registry.json"'

echo ""
echo "── fork-worker: registry.json branch field ──"

FORK_SH="$HOME/.claude-ops/scripts/fork-worker.sh"

# Test 12: fork-worker creates new entries with correct branch (not hardcoded chief-of-staff)
# Bug: was hardcoded "worker/chief-of-staff" regardless of --name argument
TOTAL=$((TOTAL + 1))
if grep -q '"worker/" + \$name' "$FORK_SH" 2>/dev/null; then
  echo -e "  ${GREEN}PASS${RESET} fork-worker: new entries use dynamic branch (\"worker/\" + \$name)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} fork-worker: new entries must use dynamic branch — not hardcoded 'chief-of-staff'"
  echo "    File: $FORK_SH line with branch field in new-entry jq block"
  FAIL=$((FAIL + 1))
fi

# Test 13: fork-worker: existing entry update path does NOT overwrite branch
HITS=$(grep -n 'branch.*worker/chief-of-staff' "$FORK_SH" 2>/dev/null | grep -v '^#' | grep -v 'example' || true)
assert_empty "fork-worker: no hardcoded 'worker/chief-of-staff' branch in registration code" "$HITS"

# Test 14: fork-worker: runtime test — jq new-entry produces correct branch field
FAKE_REG="$TMPDIR_TEST/registry.json"
echo '{}' > "$FAKE_REG"
FAKE_PANE="%42"
FAKE_TARGET="test:1.0"
CHILD_NAME_TEST="my-custom-worker"
jq --arg name "$CHILD_NAME_TEST" \
   --arg pane_id "$FAKE_PANE" \
   --arg pane_target "$FAKE_TARGET" \
   --arg tmux_session "test" \
   --arg parent "chief-of-staff" \
   'if .[$name] then
      .[$name].pane_id = $pane_id |
      .[$name].pane_target = $pane_target |
      .[$name].tmux_session = $tmux_session |
      (if $parent != "" then .[$name].parent = $parent else . end)
    else
      .[$name] = {pane_id: $pane_id, pane_target: $pane_target,
                  tmux_session: $tmux_session, status: "active",
                  parent: $parent, branch: ("worker/" + $name)}
    end' "$FAKE_REG" > "$FAKE_REG.tmp" && mv "$FAKE_REG.tmp" "$FAKE_REG"
BRANCH_RESULT=$(jq -r --arg n "$CHILD_NAME_TEST" '.[$n].branch' "$FAKE_REG" 2>/dev/null)
assert_equals "fork-worker: new entry branch = worker/<name>" "worker/$CHILD_NAME_TEST" "$BRANCH_RESULT"

echo ""
echo "── send_message: registry.json direct delivery ──"

MCP_TS="$HOME/.claude-ops/mcp/worker-fleet/index.ts"

# Test 15: send_message reads pane_id from registry before falling back to worker-message.sh
assert_file_contains "send_message: registry lookup before worker-message.sh fallback" \
  "$MCP_TS" "const paneId = entry?.pane_id"

# Test 16: send_message: falls back to worker-message.sh when no pane_id
assert_file_contains "send_message: fallback to WORKER_MESSAGE_SH" \
  "$MCP_TS" "WORKER_MESSAGE_SH"

echo ""
echo "── MCP tmux: send-keys uses -H 0d not embedded \\n ──"

# Test 17: tmuxSendMessage uses -H 0d as a SEPARATE call (not \n in JSON string)
# Bug (fixed commit ccc9ef9): JSON.stringify of strings with \n produced literal
# backslash-n characters in tmux, not Enter keystrokes.
# Fix: tmuxSendMessage() sends text, then -H 0d as a separate execSync call.
assert_file_contains "tmuxSendMessage: defined as two-call helper" \
  "$MCP_TS" "function tmuxSendMessage"

# Test 18: the helper sends -H 0d on a separate line (not embedded in the text)
TOTAL=$((TOTAL + 1))
SEND_0D_LINE=$(grep -n '\-H 0d' "$MCP_TS" | head -1)
SEND_TEXT_LINE=$(grep -n 'function tmuxSendMessage' "$MCP_TS" | head -1)
if [ -n "$SEND_0D_LINE" ] && [ -n "$SEND_TEXT_LINE" ]; then
  echo -e "  ${GREEN}PASS${RESET} tmuxSendMessage: -H 0d present as separate tmux call"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} tmuxSendMessage: must send -H 0d as separate execSync call"
  FAIL=$((FAIL + 1))
fi

# Test 19: no bare \n embedded in send-keys text (the old bug pattern)
# Should NOT find: execSync(`tmux send-keys ... \n ...`)
BAD_PATTERN=$(grep -n 'send-keys.*\\\\n' "$MCP_TS" 2>/dev/null | grep -v '0d\|#\|\/\/' || true)
assert_empty "MCP: no bare \\n embedded in send-keys text" "$BAD_PATTERN"

echo ""
echo "── worker-session-register: session_id written to registry.json ──"

REGISTER_SH="$HOME/.claude-ops/hooks/publishers/worker-session-register.sh"

# Test 20: writes session_id field (not pane-registry.json — v3 invariant)
assert_file_contains "register: writes .session_id to registry.json" \
  "$REGISTER_SH" 'session_id = $sid'

# Test 21: reads from registry.json (not pane-registry.json)
assert_file_contains "register: reads registry.json (not pane-registry)" \
  "$REGISTER_SH" "registry.json"
grep -q 'pane-registry' "$REGISTER_SH" 2>/dev/null && HAS_PANEREG="yes" || HAS_PANEREG="no"
assert_equals "register: no pane-registry.json references" "no" "$HAS_PANEREG"

# Test 22: idempotent — skips write if session_id already set
assert_file_contains "register: idempotent skip if session_id already set" \
  "$REGISTER_SH" 'EXISTING'

# Test 23: runtime — jq write produces correct session_id in registry
FAKE_REGISTRY2="$TMPDIR_TEST/session-reg-test.json"
FAKE_WORKER2="reg-test-worker"
FAKE_SID="session-abc-123"
echo "{\"$FAKE_WORKER2\": {\"status\": \"active\", \"session_id\": \"\"}}" > "$FAKE_REGISTRY2"
TMP_OUT=$(mktemp)
jq --arg n "$FAKE_WORKER2" --arg sid "$FAKE_SID" \
  '.[$n].session_id = $sid' "$FAKE_REGISTRY2" > "$TMP_OUT" \
  && mv "$TMP_OUT" "$FAKE_REGISTRY2" || rm -f "$TMP_OUT"
STORED_SID=$(jq -r --arg n "$FAKE_WORKER2" '.[$n].session_id // ""' "$FAKE_REGISTRY2" 2>/dev/null)
assert_equals "register: jq write round-trips session_id correctly" "$FAKE_SID" "$STORED_SID"

# Test 24: worktree path resolver strips -w-<worker> suffix to find project root
# e.g. /path/Wechat-w-harness-optimizer → /path/Wechat
assert_file_contains "register: worktree path resolver strips -w-<worker> suffix" \
  "$REGISTER_SH" "sed 's|-w-[^/]*\$||'"

test_summary
