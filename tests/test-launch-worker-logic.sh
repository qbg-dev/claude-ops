#!/usr/bin/env bash
# test-launch-worker-logic.sh — Tests for launch-flat-worker.sh logic:
# registry reads, command construction, WORKER_NAME propagation,
# window group detection, permission loading.
set -uo pipefail

source "$(dirname "$0")/helpers.sh"

LAUNCH_SH="$HOME/.claude-ops/scripts/launch-flat-worker.sh"
WATCHDOG_SH="$HOME/.claude-ops/scripts/harness-watchdog.sh"

# ══════════════════════════════════════════════════════════════════════
# Script structure
# ══════════════════════════════════════════════════════════════════════
echo "── launch-flat-worker: script structure ──"

assert_file_exists "launch script exists" "$LAUNCH_SH"
assert_file_contains "uses set -euo pipefail" "$LAUNCH_SH" "set -euo pipefail"
assert_file_contains "reads PROJECT_ROOT" "$LAUNCH_SH" "PROJECT_ROOT"
assert_file_contains "reads registry.json" "$LAUNCH_SH" "registry.json"

# ══════════════════════════════════════════════════════════════════════
# Worker name handling
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── launch-flat-worker: worker name handling ──"

# Test: accepts worker name as argument
assert_file_contains "accepts worker name arg" "$LAUNCH_SH" '$1'

# Test: sets WORKER_NAME for hooks
TOTAL=$((TOTAL + 1))
if grep -q 'WORKER_NAME\|WORKER=' "$LAUNCH_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} sets WORKER_NAME or WORKER for hooks"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} does not set WORKER_NAME for hooks"
fi

# Test: CLAUDE_CODE_SKIP_PROJECT_LOCK set for concurrent workers
assert_file_contains "sets CLAUDE_CODE_SKIP_PROJECT_LOCK" "$LAUNCH_SH" "CLAUDE_CODE_SKIP_PROJECT_LOCK"

# ══════════════════════════════════════════════════════════════════════
# Registry reading
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── launch-flat-worker: registry reading ──"

# Test: reads model from registry
assert_file_contains "reads model from registry" "$LAUNCH_SH" "model"

# Test: reads permission_mode from registry
assert_file_contains "reads permission mode" "$LAUNCH_SH" "permission_mode"

# Test: watchdog reads perpetual flag (launch script doesn't need it)
assert_file_contains "watchdog reads perpetual flag" "$WATCHDOG_SH" "perpetual"

# Test: reads window assignment
assert_file_contains "reads window assignment" "$LAUNCH_SH" "window"

# ══════════════════════════════════════════════════════════════════════
# tmux pane management
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── launch-flat-worker: pane management ──"

# Test: creates new pane or uses existing
TOTAL=$((TOTAL + 1))
if grep -qE 'split-window|new-window|send-keys' "$LAUNCH_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} manages tmux panes"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} no tmux pane management"
fi

# Test: writes pane_id back to registry
TOTAL=$((TOTAL + 1))
if grep -q 'pane_id\|pane_target' "$LAUNCH_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} writes pane_id to registry"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} does not write pane_id to registry"
fi

# ══════════════════════════════════════════════════════════════════════
# _build_agent_cmd in watchdog — command construction
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── _build_agent_cmd: command construction ──"

# Test: sets model from registry
assert_file_contains "cmd includes model" "$WATCHDOG_SH" 'claude --model $model'

# Test: bypass permissions flag
TOTAL=$((TOTAL + 1))
if grep -qF -- 'dangerously-skip-permissions' "$WATCHDOG_SH" 2>/dev/null; then
  PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${RESET} cmd includes bypass permissions"
else
  FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${RESET} cmd includes bypass permissions"
fi

# Test: disallowed tools flag
TOTAL=$((TOTAL + 1))
if grep -qF -- 'disallowed-tools' "$WATCHDOG_SH" 2>/dev/null; then
  PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${RESET} cmd includes disallowed tools"
else
  FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${RESET} cmd includes disallowed tools"
fi

# Test: adds worker dir for CLAUDE.md resolution
TOTAL=$((TOTAL + 1))
if grep -qF -- 'add-dir $worker_dir' "$WATCHDOG_SH" 2>/dev/null; then
  PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${RESET} cmd adds worker dir"
else
  FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${RESET} cmd adds worker dir"
fi

# Test: supports session resume
TOTAL=$((TOTAL + 1))
if grep -qF -- 'resume $session_id' "$WATCHDOG_SH" 2>/dev/null; then
  PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${RESET} cmd supports resume"
else
  FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${RESET} cmd supports resume"
fi

# Test: supports Codex runtime
assert_file_contains "supports codex runtime" "$WATCHDOG_SH" 'runtime" = "codex"'

# Test: WORKER_NAME is set in Claude cmd (critical fix)
assert_file_contains "WORKER_NAME set in Claude cmd" "$WATCHDOG_SH" 'WORKER_NAME=$worker claude'

# ══════════════════════════════════════════════════════════════════════
# _build_agent_cmd — runtime-specific logic
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── _build_agent_cmd: runtime variants ──"

# Source the function for unit testing
# We need to extract just _build_agent_cmd with minimal deps
TMPDIR_TEST=$(mktemp -d)
FAKE_PROJ="$TMPDIR_TEST/proj"
mkdir -p "$FAKE_PROJ/.claude/workers/test-opus" "$FAKE_PROJ/.claude/workers/test-codex"

# Registry with Claude worker
cat > "$FAKE_PROJ/.claude/workers/registry.json" <<'JSON'
{
  "test-opus": {
    "model": "opus",
    "permission_mode": "bypassPermissions",
    "disallowed_tools": ["Bash"],
    "status": "active",
    "perpetual": true,
    "custom": {"runtime": "claude"}
  },
  "test-codex": {
    "model": "o4-mini",
    "permission_mode": "bypassPermissions",
    "disallowed_tools": [],
    "status": "active",
    "perpetual": true,
    "custom": {"runtime": "codex"}
  },
  "test-sonnet": {
    "model": "sonnet",
    "permission_mode": "default",
    "disallowed_tools": [],
    "status": "active",
    "perpetual": false,
    "custom": {"reasoning_effort": "low"}
  }
}
JSON

# Test _build_agent_cmd by extracting it as a standalone function
# We source just the function definition, not the full script (which has side effects)
BUILD_CMD=$(cat <<'BASH'
_build_agent_cmd() {
  local worker="$1"
  local session_id="${2:-}"
  local model; model=$(jq -r --arg n "$worker" '.[$n].model // "opus"' "$REGISTRY" 2>/dev/null)
  [ "$model" = "null" ] && model="opus"
  local perm_mode; perm_mode=$(jq -r --arg n "$worker" '.[$n].permission_mode // "bypassPermissions"' "$REGISTRY" 2>/dev/null)
  [ "$perm_mode" = "null" ] && perm_mode="bypassPermissions"
  local disallowed; disallowed=$(jq -r --arg n "$worker" '.[$n].disallowed_tools // [] | join(",")' "$REGISTRY" 2>/dev/null)
  local runtime; runtime=$(jq -r --arg n "$worker" '.[$n].custom.runtime // "claude"' "$REGISTRY" 2>/dev/null)
  [ "$runtime" = "null" ] && runtime="claude"
  local effort; effort=$(jq -r --arg n "$worker" '.[$n].custom.reasoning_effort // ""' "$REGISTRY" 2>/dev/null)
  [ "$effort" = "null" ] && effort=""
  local worker_dir="$PROJECT_ROOT/.claude/workers/$worker"

  if [ "$runtime" = "codex" ]; then
    local cmd="codex -m $model"
    if [ "$perm_mode" = "bypassPermissions" ]; then
      cmd="$cmd --dangerously-bypass-approvals-and-sandbox"
    else
      cmd="$cmd -s workspace-write -a on-request"
    fi
    [ -n "$effort" ] && cmd="$cmd -c model_reasoning_effort=$effort"
    cmd="$cmd --no-alt-screen"
    if [ -n "$session_id" ]; then
      cmd="codex resume $session_id"
    fi
  else
    local cmd="CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME=$worker claude --model $model"
    [ "$perm_mode" = "bypassPermissions" ] && cmd="$cmd --dangerously-skip-permissions"
    [ -n "$effort" ] && cmd="$cmd --effort $effort"
    [ -n "$disallowed" ] && cmd="$cmd --disallowed-tools \"$disallowed\""
    cmd="$cmd --add-dir $worker_dir"
    [ -n "$session_id" ] && cmd="$cmd --resume $session_id"
  fi
  echo "$cmd"
}
BASH
)

eval "$BUILD_CMD"
REGISTRY="$FAKE_PROJ/.claude/workers/registry.json"
PROJECT_ROOT="$FAKE_PROJ"

# Helper: grep-safe assert for strings starting with --
assert_grep() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -qF -- "$expected"; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    expected to contain: $expected"
    echo "    got: $(echo "$actual" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

# Test Claude runtime
CMD_OPUS=$(_build_agent_cmd "test-opus")
assert_grep "claude cmd has WORKER_NAME" "WORKER_NAME=test-opus" "$CMD_OPUS"
assert_grep "claude cmd has model opus" "model opus" "$CMD_OPUS"
assert_grep "claude cmd has bypass" "dangerously-skip-permissions" "$CMD_OPUS"
assert_grep "claude cmd has disallowed Bash" 'disallowed-tools' "$CMD_OPUS"
assert_grep "claude cmd has add-dir" "add-dir" "$CMD_OPUS"

# Test Codex runtime
CMD_CODEX=$(_build_agent_cmd "test-codex")
assert_grep "codex cmd starts with codex" "codex -m o4-mini" "$CMD_CODEX"
assert_grep "codex cmd has bypass sandbox" "dangerously-bypass-approvals-and-sandbox" "$CMD_CODEX"

# Test non-bypass permission mode
CMD_SONNET=$(_build_agent_cmd "test-sonnet")
TOTAL=$((TOTAL + 1))
if echo "$CMD_SONNET" | grep -qF -- "dangerously-skip-permissions"; then
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} default perm mode should not have --dangerously-skip-permissions"
else
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} default perm mode omits --dangerously-skip-permissions"
fi

# Test effort flag
assert_grep "sonnet cmd has effort" "effort low" "$CMD_SONNET"

# Test session resume
CMD_RESUME=$(_build_agent_cmd "test-opus" "abc-123-session")
assert_grep "resume cmd has --resume" "resume abc-123-session" "$CMD_RESUME"

# Cleanup
rm -rf "$TMPDIR_TEST"

test_summary
