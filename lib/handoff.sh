#!/usr/bin/env bash
# handoff.sh — Unified agent replacement in the same tmux pane.
#
# Two callers, one script:
#
#   1. Stop hook (rotation):
#      bash .claude/scripts/handoff.sh --rotate <session_id>
#      Reads signal file for harness name, progress.json for model.
#
#   2. Agent self-handoff:
#      bash .claude/scripts/handoff.sh --harness miniapp-chat --model opus --chrome
#      bash .claude/scripts/handoff.sh --prompt "seed text" --model sonnet
#      bash .claude/scripts/handoff.sh --prompt-file $(harness_tmp_dir)/seed.txt --model opus
#
# What happens:
#   1. Resolves seed prompt + claude command from args
#   2. Finds the current tmux pane (walks process tree)
#   3. Updates harness state if applicable (session_count, registry)
#   4. Backgrounds a daemon (survives parent death)
#   5. Daemon: /quit → wait → launch new Claude → paste seed
#   6. Returns immediately — caller should stop working
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "$HOME/.claude-ops/lib/fleet-jq.sh" 2>/dev/null || HARNESS_STATE_DIR="$HOME/.claude-ops/state"
DEBUG_LOG="$(harness_logs_dir 2>/dev/null || echo "$HARNESS_STATE_DIR/logs")/handoff.log"
HANDOFF_DEFAULT_DELAY_SEC="${HANDOFF_DEFAULT_DELAY_SEC:-3}"
HANDOFF_DEFAULT_MODEL="${HANDOFF_DEFAULT_MODEL:-opus}"
HANDOFF_DEFAULT_COMMAND="${HANDOFF_DEFAULT_COMMAND:-cdoc}"
HANDOFF_SKIP_PERMISSIONS="${HANDOFF_SKIP_PERMISSIONS:-true}"
HANDOFF_PANE_SEARCH_DEPTH="${HANDOFF_PANE_SEARCH_DEPTH:-15}"
HANDOFF_SEED_SIZE_WARN="${HANDOFF_SEED_SIZE_WARN:-60000}"
# fleet-jq.sh already sourced above (near DEBUG_LOG)

# ── Parse arguments ──────────────────────────────────────────────────
MODE=""           # "rotate" or "direct"
SESSION_ID=""
PROMPT=""
PROMPT_FILE=""
MODEL=""
CHROME=false
HARNESS=""
DELAY="$HANDOFF_DEFAULT_DELAY_SEC"
SKIP_PERMISSIONS="$HANDOFF_SKIP_PERMISSIONS"
APPEND_HARNESSUP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rotate)           MODE="rotate"; SESSION_ID="$2"; shift 2 ;;
    --prompt)           MODE="direct"; PROMPT="$2"; shift 2 ;;
    --prompt-file)      MODE="direct"; PROMPT_FILE="$2"; shift 2 ;;
    --harness)          HARNESS="$2"; shift 2 ;;
    --model)            MODEL="$2"; shift 2 ;;
    --chrome)           CHROME=true; shift ;;
    --delay)            DELAY="$2"; shift 2 ;;
    --with-permissions) SKIP_PERMISSIONS=false; shift ;;
    --harnessup)        APPEND_HARNESSUP=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[$(date '+%H:%M:%S')] handoff: $*" >> "$DEBUG_LOG"; }
log "=== Handoff started (mode=${MODE:-auto}, harness=${HARNESS:-none}) ==="

# ── Resolve from rotation signal file ────────────────────────────────
if [ "$MODE" = "rotate" ]; then
  SIGNAL_FILE="$(harness_session_dir "$SESSION_ID")/rotate-signal"
  if [ ! -f "$SIGNAL_FILE" ]; then
    log "ERROR: Signal file not found: $SIGNAL_FILE"
    exit 1
  fi
  HARNESS=$(jq -r '.harness' "$SIGNAL_FILE" 2>/dev/null)
  if [ -z "$HARNESS" ] || [ "$HARNESS" = "null" ]; then
    log "ERROR: Could not read harness name from signal file"
    exit 1
  fi
  APPEND_HARNESSUP=true
  log "Rotation mode: harness=$HARNESS, session=$SESSION_ID"
fi

# ── Resolve model + chrome from harness progress (if not explicit) ───
PROGRESS=""
if [ -n "$HARNESS" ]; then
  # v3: progress.json is gone — use tasks.json path (harness_bump_session resolves state.json)
  PROGRESS="$PROJECT_ROOT/.claude/harness/${HARNESS}/tasks.json"
  if [ ! -f "$PROGRESS" ]; then
    log "ERROR: tasks.json not found: $PROGRESS"
    exit 1
  fi

  if [ -z "$MODEL" ]; then
    # Read model from progress.json rotation config
    CLAUDE_ALIAS=$(jq -r ".rotation.claude_command // \"$HANDOFF_DEFAULT_COMMAND\"" "$PROGRESS" 2>/dev/null)
    # Handle both aliases (cdo/cds/cdh) and full command strings (claude --model opus ...)
    if echo "$CLAUDE_ALIAS" | grep -q "^claude "; then
      # Full command string — extract model and chrome flag
      if echo "$CLAUDE_ALIAS" | grep -q -- "--model opus"; then MODEL="opus"
      elif echo "$CLAUDE_ALIAS" | grep -q -- "--model sonnet"; then MODEL="sonnet"
      elif echo "$CLAUDE_ALIAS" | grep -q -- "--model haiku"; then MODEL="haiku"
      else MODEL="opus"; fi
      echo "$CLAUDE_ALIAS" | grep -q -- "--chrome" && CHROME=true
    else
      # Legacy alias format
      case "$CLAUDE_ALIAS" in
        cdo|cdo1m)  MODEL="opus" ;;
        cds|cds1m)  MODEL="sonnet" ;;
        cdh)        MODEL="haiku" ;;
        cdoc)       MODEL="opus"; CHROME=true ;;
        cdsc)       MODEL="sonnet"; CHROME=true ;;
        *)          MODEL="$HANDOFF_DEFAULT_MODEL" ;;
      esac
      # Check for long context
      case "$CLAUDE_ALIAS" in
        cdo1m) MODEL="'opus[1m]'" ;;
        cds1m) MODEL="'sonnet[1m]'" ;;
      esac
    fi
    log "Model from progress: $MODEL (command: $CLAUDE_ALIAS)"
  fi

  # Default mode to "direct" if not rotation
  [ -z "$MODE" ] && MODE="direct"
fi

# Defaults
[ -z "$MODEL" ] && MODEL="$HANDOFF_DEFAULT_MODEL"
[ -z "$MODE" ] && MODE="direct"

# ── Build claude command (respects permissions.json) ─────────────────
CLAUDE_CMD="claude"

# Read permissions.json if harness is known
if [ -n "$HARNESS" ]; then
  _perms_json="$PROJECT_ROOT/.claude/harness/${HARNESS}/agents/module-manager/permissions.json"
  [ ! -f "$_perms_json" ] && _perms_json="$PROJECT_ROOT/.claude/harness/${HARNESS}/agents/sidecar/permissions.json"
  if [ -f "$_perms_json" ]; then
    _perm_mode=$(jq -r '.permission_mode // "bypassPermissions"' "$_perms_json")
    _perm_allowed=$(jq -r '(.allowedTools // []) | join(",")' "$_perms_json")
    # denyList enforced by tool-policy-gate.sh PreToolUse hook
    _perm_tools=$(jq -r '(.tools // []) | join(",")' "$_perms_json")
    _perm_dirs=$(jq -r '(.addDirs // []) | join(",")' "$_perms_json")
    # Apply mode (overrides SKIP_PERMISSIONS)
    case "$_perm_mode" in
      bypassPermissions) CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions" ;;
      acceptEdits)       CLAUDE_CMD="$CLAUDE_CMD --permission-mode acceptEdits" ;;
      dontAsk)           CLAUDE_CMD="$CLAUDE_CMD --permission-mode dontAsk" ;;
      plan)              CLAUDE_CMD="$CLAUDE_CMD --permission-mode plan" ;;
      default)           ;;  # no flag
    esac
    [ -n "$_perm_allowed" ]    && CLAUDE_CMD="$CLAUDE_CMD --allowedTools $_perm_allowed"
    # denyList is now enforced by tool-policy-gate.sh PreToolUse hook — no CLI flag needed
    [ -n "$_perm_tools" ]      && CLAUDE_CMD="$CLAUDE_CMD --tools $_perm_tools"
    [ -n "$_perm_dirs" ]       && CLAUDE_CMD="$CLAUDE_CMD --add-dir $_perm_dirs"
  elif [ "$SKIP_PERMISSIONS" = true ]; then
    CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
  fi
else
  # No harness — fall back to SKIP_PERMISSIONS flag
  if [ "$SKIP_PERMISSIONS" = true ]; then
    CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
  fi
fi

CLAUDE_CMD="$CLAUDE_CMD --model $MODEL"
if [ "$CHROME" = true ]; then
  CLAUDE_CMD="$CLAUDE_CMD --chrome"
fi
log "Claude command: $CLAUDE_CMD"

# ── Resolve seed prompt ──────────────────────────────────────────────
SEED=""

if [ -n "$HARNESS" ]; then
  # Try harness seed script first
  SEED_SCRIPT="$PROJECT_ROOT/.claude/scripts/${HARNESS}-seed.sh"
  if [ -f "$SEED_SCRIPT" ]; then
    SEED=$(bash "$SEED_SCRIPT" 2>/dev/null || echo "")
    log "Generated seed from $SEED_SCRIPT (${#SEED} chars)"
  fi
  if [ -z "$SEED" ]; then
    # Fallback: minimal seed from progress (fleet-jq.sh already sourced at line 26)
    CURRENT=$(harness_current_task "$PROGRESS" 2>/dev/null || echo "unknown")
    DONE=$(harness_done_count "$PROGRESS" 2>/dev/null || echo "?")
    TOTAL=$(harness_total_count "$PROGRESS" 2>/dev/null || echo "?")
    SEED="Continue ${HARNESS} harness. Read .claude/harness/${HARNESS}/harness.md. Progress: ${DONE}/${TOTAL}. Current: ${CURRENT}."
  fi
elif [ -n "$PROMPT_FILE" ]; then
  SEED=$(cat "$PROMPT_FILE")
  log "Read seed from file: $PROMPT_FILE (${#SEED} chars)"
elif [ -n "$PROMPT" ]; then
  SEED="$PROMPT"
fi

if [ -z "$SEED" ]; then
  echo "ERROR: No prompt. Use --prompt, --prompt-file, or --harness." >&2
  exit 1
fi

if [ "$APPEND_HARNESSUP" = true ]; then
  SEED="${SEED}

After your first feature cycle, run HARNESSUP to evolve this harness."
fi

log "Seed prompt: ${#SEED} chars"

# ── Find current tmux pane (via shared hook_find_own_pane) ──────────
TMUX_PANE=$(hook_find_own_pane 2>/dev/null || echo "")
if [ -z "$TMUX_PANE" ]; then
  log "WARNING: No tmux pane found — falling back to /clear mode"
  if [ -n "$HARNESS" ]; then
    echo "$HARNESS" > "$(harness_runtime "$HARNESS")/rotate-fallback"
  fi
  [ -n "${SIGNAL_FILE:-}" ] && rm -f "$SIGNAL_FILE"
  echo "ERROR: Not in tmux. Cannot handoff." >&2
  exit 1
fi
log "Found pane: $TMUX_PANE"

# ── Update harness state ─────────────────────────────────────────────
if [ -n "$HARNESS" ] && [ -n "$PROGRESS" ] && [ -f "$PROGRESS" ]; then
  harness_bump_session "$PROGRESS"
  log "Progress: session_count bumped, current_session reset"

  # Write pending registration for new session (line 2 = pane_id for dispatch matching)
  printf '%s\n%s\n' "$HARNESS" "$TMUX_PANE" > "$(harness_runtime "$HARNESS")/pending-registration"
  log "Wrote pending registration for $HARNESS (pane $TMUX_PANE)"
fi

# ── Save seed to temp file ───────────────────────────────────────────
SEED_FILE=$(mktemp "$(harness_tmp_dir)/handoff_seed_XXXXXX.txt")
echo "$SEED" > "$SEED_FILE"

# ── Launch background daemon ─────────────────────────────────────────
# nohup + trap HUP + disown ensures survival after parent Claude process dies.
# (setsid is Linux-only; on macOS we use trap "" HUP instead)
HARNESS_FOR_RESULT="${HARNESS:-handoff}"

# Guard against duplicate rotation daemons (stop hook can fire twice)
ROTATION_LOCK="$(harness_runtime "$HARNESS_FOR_RESULT")/handoff.lock"
if ! mkdir "$ROTATION_LOCK" 2>/dev/null; then
  log "Rotation already in progress (lock exists: $ROTATION_LOCK). Skipping."
  exit 0
fi

nohup bash -c '
  # Ignore HUP so we survive parent death (macOS-compatible alternative to setsid)
  trap "" HUP
  HANDOFF_DEATH_WAIT_POLLS="${HANDOFF_DEATH_WAIT_POLLS:-15}"
  HANDOFF_DEATH_POLL_INTERVAL="${HANDOFF_DEATH_POLL_INTERVAL:-2}"
  HANDOFF_ESCALATE_CTRLC_AT="${HANDOFF_ESCALATE_CTRLC_AT:-5}"
  HANDOFF_ESCALATE_EXIT_AT="${HANDOFF_ESCALATE_EXIT_AT:-10}"
  HANDOFF_ESCALATE_KILL_AT="${HANDOFF_ESCALATE_KILL_AT:-14}"
  HANDOFF_LOAD_WAIT_POLLS="${HANDOFF_LOAD_WAIT_POLLS:-30}"
  HANDOFF_LOAD_POLL_INTERVAL="${HANDOFF_LOAD_POLL_INTERVAL:-2}"
  HANDOFF_READINESS_PATTERN="${HANDOFF_READINESS_PATTERN:-bypass permissions|permissions|Welcome|Tips}"
  HANDOFF_SEED_SIZE_WARN="${HANDOFF_SEED_SIZE_WARN:-60000}"
  PANE="$1"; CLAUDE_CMD="$2"; SEED_FILE="$3"; PROJECT="$4"; DLOG="$5"; DELAY="$6"; SIGNAL="$7"; HNAME="$8"; STATE_DIR="$9"; RLOCK="${10}"

  log() { echo "[$(date "+%H:%M:%S")] handoff-bg: $*" >> "$DLOG"; }
  write_result() {
    local status="$1" reason="${2:-}"
    local result_dir="$STATE_DIR/harness-runtime/$HNAME"
    mkdir -p "$result_dir"
    printf "{\"status\":\"%s\",\"reason\":\"%s\",\"ts\":\"%s\"}\n" "$status" "$reason" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$result_dir/handoff-result"
  }

  sleep "$DELAY"

  # ── Phase 1: Kill current Claude ──
  log "Sending Escape + /quit"
  tmux send-keys -t "$PANE" Escape
  sleep 1
  tmux send-keys -t "$PANE" "/quit" Enter

  # ── Phase 2: Wait for death (escalating) ──
  for i in $(seq 1 $HANDOFF_DEATH_WAIT_POLLS); do
    sleep $HANDOFF_DEATH_POLL_INTERVAL
    PANE_PID=$(tmux list-panes -t "$PANE" -F "#{pane_pid}" 2>/dev/null || echo "")
    if [ -z "$PANE_PID" ]; then
      log "Pane gone — aborting"
      write_result "failed" "pane_gone"
      rm -f "$SEED_FILE" "$SIGNAL"
      exit 1
    fi
    pgrep -P "$PANE_PID" -f "claude" > /dev/null 2>&1 || { log "Claude exited after $((i*2))s"; break; }
    case "$i" in
      $HANDOFF_ESCALATE_CTRLC_AT) log "Escalating: Ctrl+C"; tmux send-keys -t "$PANE" C-c ;;
      $HANDOFF_ESCALATE_EXIT_AT)  log "Escalating: exit";   tmux send-keys -t "$PANE" "exit" Enter ;;
      $HANDOFF_ESCALATE_KILL_AT)  CPID=$(pgrep -P "$PANE_PID" -f "claude" 2>/dev/null | head -1 || echo "")
          [ -n "$CPID" ] && { log "Last resort: kill $CPID"; kill "$CPID" 2>/dev/null || true; } ;;
    esac
  done

  # ── Phase 3: Launch new Claude ──
  sleep 1
  tmux send-keys -t "$PANE" "cd $PROJECT" Enter
  sleep 1
  tmux send-keys -t "$PANE" "$CLAUDE_CMD" Enter
  log "Launched: $CLAUDE_CMD"

  # ── Phase 4: Wait for Claude to load ──
  for i in $(seq 1 $HANDOFF_LOAD_WAIT_POLLS); do
    sleep $HANDOFF_LOAD_POLL_INTERVAL
    tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -qE "($HANDOFF_READINESS_PATTERN)" && {
      log "Claude loaded after $((i*2))s"; break
    }
    if [ "$i" = "$HANDOFF_LOAD_WAIT_POLLS" ]; then
      log "WARN: Claude may not have loaded — aborting seed paste"
      write_result "failed" "claude_load_timeout_60s"
      rm -f "$SEED_FILE" "$SIGNAL"
      exit 1
    fi
  done
  sleep 2

  # Verify pane is still alive before pasting
  if ! tmux display-message -t "$PANE" -p "#{pane_id}" >/dev/null 2>&1; then
    log "ERROR: Pane gone before seed paste"
    write_result "failed" "pane_gone_before_seed"
    rm -f "$SEED_FILE" "$SIGNAL"
    exit 1
  fi

  # ── Phase 5: Paste seed prompt ──
  # Guard: check seed size (tmux paste-buffer silently truncates at ~64KB)
  SEED_SIZE=$(wc -c < "$SEED_FILE" | tr -d " ")
  if [ "$SEED_SIZE" -gt "$HANDOFF_SEED_SIZE_WARN" ]; then
    log "WARN: Seed is ${SEED_SIZE} bytes (>${HANDOFF_SEED_SIZE_WARN}) — may be truncated by tmux"
  fi
  tmux load-buffer "$SEED_FILE"
  tmux paste-buffer -t "$PANE"
  sleep 1
  tmux send-keys -t "$PANE" Enter
  log "Seed pasted and submitted"

  # Write success result
  write_result "success" ""

  # Cleanup
  rm -f "$SEED_FILE" "$SIGNAL"
  rmdir "$RLOCK" 2>/dev/null || true
  log "=== Handoff complete ==="
' _ "$TMUX_PANE" "$CLAUDE_CMD" "$SEED_FILE" "$PROJECT_ROOT" "$DEBUG_LOG" "$DELAY" "${SIGNAL_FILE:-}" "$HARNESS_FOR_RESULT" "$HARNESS_STATE_DIR" "$ROTATION_LOCK" \
  >> "$DEBUG_LOG" 2>&1 &

DAEMON_PID=$!
disown "$DAEMON_PID" 2>/dev/null || true
log "Daemon launched (PID: $DAEMON_PID)"

echo "Handoff initiated. New $MODEL agent launching in ~$((DELAY + 10))s with ${#SEED} char seed."
echo "Debug: $DEBUG_LOG"
