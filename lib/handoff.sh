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
#      bash .claude/scripts/handoff.sh --prompt-file /tmp/seed.txt --model opus
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
DEBUG_LOG="/tmp/handoff_debug.log"
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY="$HARNESS_SESSION_REGISTRY"

# ── Parse arguments ──────────────────────────────────────────────────
MODE=""           # "rotate" or "direct"
SESSION_ID=""
PROMPT=""
PROMPT_FILE=""
MODEL=""
CHROME=false
HARNESS=""
DELAY=3
SKIP_PERMISSIONS=true
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
  SIGNAL_FILE="/tmp/claude_harness_rotate_${SESSION_ID}"
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
  # Try manifest first, then convention
  PROGRESS=$(harness_progress_path "$HARNESS" 2>/dev/null || echo "")
  [ -z "$PROGRESS" ] || [ ! -f "$PROGRESS" ] && PROGRESS="$PROJECT_ROOT/claude_files/${HARNESS}-progress.json"
  if [ ! -f "$PROGRESS" ]; then
    log "ERROR: Progress file not found: $PROGRESS"
    exit 1
  fi

  if [ -z "$MODEL" ]; then
    # Read model from progress.json rotation config
    CLAUDE_ALIAS=$(jq -r '.rotation.claude_command // "cdo"' "$PROGRESS" 2>/dev/null)
    case "$CLAUDE_ALIAS" in
      cdo|cdo1m)  MODEL="opus" ;;
      cds|cds1m)  MODEL="sonnet" ;;
      cdh)        MODEL="haiku" ;;
      cdoc)       MODEL="opus"; CHROME=true ;;
      cdsc)       MODEL="sonnet"; CHROME=true ;;
      *)          MODEL="opus" ;;
    esac
    # Check for long context
    case "$CLAUDE_ALIAS" in
      cdo1m) MODEL="'opus[1m]'" ;;
      cds1m) MODEL="'sonnet[1m]'" ;;
    esac
    log "Model from progress: $MODEL (alias: $CLAUDE_ALIAS)"
  fi

  # Default mode to "direct" if not rotation
  [ -z "$MODE" ] && MODE="direct"
fi

# Defaults
[ -z "$MODEL" ] && MODEL="opus"
[ -z "$MODE" ] && MODE="direct"

# ── Build claude command ─────────────────────────────────────────────
CLAUDE_CMD="claude"
if [ "$SKIP_PERMISSIONS" = true ]; then
  CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
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
    # Fallback: minimal seed from progress (harness-jq.sh already sourced at line 26)
    CURRENT=$(harness_current_task "$PROGRESS" 2>/dev/null || echo "unknown")
    DONE=$(harness_done_count "$PROGRESS" 2>/dev/null || echo "?")
    TOTAL=$(harness_total_count "$PROGRESS" 2>/dev/null || echo "?")
    SEED="Continue ${HARNESS} harness. Read claude_files/${HARNESS}-harness.md. Progress: ${DONE}/${TOTAL}. Current: ${CURRENT}."
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

# ── Find current tmux pane ───────────────────────────────────────────
find_own_pane() {
  local panes
  panes=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null) || return 1

  local check_pid=$$
  for _ in $(seq 1 15); do
    local parent
    parent=$(ps -o ppid= -p "$check_pid" 2>/dev/null | tr -d ' ') || break
    [ -z "$parent" ] || [ "$parent" = "1" ] && break

    local match
    match=$(echo "$panes" | awk -v pid="$parent" '$2 == pid { print $1; exit }')
    if [ -n "$match" ]; then
      echo "$match"
      return 0
    fi
    check_pid="$parent"
  done

  # No fallback — better to fail loudly than grab the wrong pane
  return 1
}

TMUX_PANE=$(find_own_pane 2>/dev/null || echo "")
if [ -z "$TMUX_PANE" ]; then
  log "WARNING: No tmux pane found — falling back to /clear mode"
  if [ -n "$HARNESS" ]; then
    echo "$HARNESS" > "/tmp/claude_harness_rotate_fallback_${HARNESS}"
  fi
  [ -n "${SIGNAL_FILE:-}" ] && rm -f "$SIGNAL_FILE"
  echo "ERROR: Not in tmux. Cannot handoff." >&2
  exit 1
fi
log "Found pane: $TMUX_PANE"

# ── Update harness state ─────────────────────────────────────────────
if [ -n "$HARNESS" ] && [ -n "$PROGRESS" ] && [ -f "$PROGRESS" ]; then
  locked_jq_write "$PROGRESS" "progress-$HARNESS" \
    '.session_count = ((.session_count // 0) + 1) |
     .current_session = {
       "round_count": 0,
       "tasks_completed": 0,
       "started_at": (now | todate)
     }'
  log "Progress: session_count bumped, current_session reset"

  # Deregister old session
  if [ -n "$SESSION_ID" ] && [ -f "$REGISTRY" ]; then
    locked_jq_write "$REGISTRY" "session-registry" 'del(.[$sid])' --arg sid "$SESSION_ID"
    log "Deregistered session $SESSION_ID"
  elif [ -f "$REGISTRY" ]; then
    # Try to find session registered to this harness
    OLD_SID=$(jq -r --arg h "$HARNESS" 'to_entries[] | select(.value == $h) | .key' "$REGISTRY" 2>/dev/null | head -1)
    if [ -n "$OLD_SID" ]; then
      locked_jq_write "$REGISTRY" "session-registry" 'del(.[$sid])' --arg sid "$OLD_SID"
      log "Deregistered session $OLD_SID (found by harness name)"
    fi
  fi

  # Write pending registration for new session (line 2 = pane_id for dispatch matching)
  printf '%s\n%s\n' "$HARNESS" "$TMUX_PANE" > "/tmp/claude_harness_pending_${HARNESS}"
  log "Wrote pending registration for $HARNESS (pane $TMUX_PANE)"
fi

# ── Save seed to temp file ───────────────────────────────────────────
SEED_FILE=$(mktemp /tmp/handoff_seed_XXXXXX.txt)
echo "$SEED" > "$SEED_FILE"

# ── Launch background daemon ─────────────────────────────────────────
# nohup + trap HUP + disown ensures survival after parent Claude process dies.
# (setsid is Linux-only; on macOS we use trap "" HUP instead)
HARNESS_FOR_RESULT="${HARNESS:-handoff}"
nohup bash -c '
  # Ignore HUP so we survive parent death (macOS-compatible alternative to setsid)
  trap "" HUP
  PANE="$1"; CLAUDE_CMD="$2"; SEED_FILE="$3"; PROJECT="$4"; DLOG="$5"; DELAY="$6"; SIGNAL="$7"; HNAME="$8"

  log() { echo "[$(date "+%H:%M:%S")] handoff-bg: $*" >> "$DLOG"; }
  write_result() {
    local status="$1" reason="${2:-}"
    printf "{\"status\":\"%s\",\"reason\":\"%s\",\"ts\":\"%s\"}\n" "$status" "$reason" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "/tmp/handoff_result_${HNAME}"
  }

  sleep "$DELAY"

  # ── Phase 1: Kill current Claude ──
  log "Sending Escape + /quit"
  tmux send-keys -t "$PANE" Escape
  sleep 1
  tmux send-keys -t "$PANE" "/quit" Enter

  # ── Phase 2: Wait for death (up to 30s, escalating) ──
  for i in $(seq 1 15); do
    sleep 2
    PANE_PID=$(tmux list-panes -t "$PANE" -F "#{pane_pid}" 2>/dev/null || echo "")
    if [ -z "$PANE_PID" ]; then
      log "Pane gone — aborting"
      write_result "failed" "pane_gone"
      rm -f "$SEED_FILE" "$SIGNAL"
      exit 1
    fi
    pgrep -P "$PANE_PID" -f "claude" > /dev/null 2>&1 || { log "Claude exited after $((i*2))s"; break; }
    case "$i" in
      5)  log "Escalating: Ctrl+C"; tmux send-keys -t "$PANE" C-c ;;
      10) log "Escalating: exit";   tmux send-keys -t "$PANE" "exit" Enter ;;
      14) CPID=$(pgrep -P "$PANE_PID" -f "claude" 2>/dev/null | head -1 || echo "")
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
  for i in $(seq 1 30); do
    sleep 2
    tmux capture-pane -t "$PANE" -p 2>/dev/null | grep -qE "(bypass permissions|permissions|Welcome|Tips)" && {
      log "Claude loaded after $((i*2))s"; break
    }
    if [ "$i" = "30" ]; then
      log "WARN: Claude may not have loaded in 60s — aborting seed paste"
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
  if [ "$SEED_SIZE" -gt 60000 ]; then
    log "WARN: Seed is ${SEED_SIZE} bytes (>60KB) — may be truncated by tmux"
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
  log "=== Handoff complete ==="
' _ "$TMUX_PANE" "$CLAUDE_CMD" "$SEED_FILE" "$PROJECT_ROOT" "$DEBUG_LOG" "$DELAY" "${SIGNAL_FILE:-}" "$HARNESS_FOR_RESULT" \
  >> "$DEBUG_LOG" 2>&1 &

DAEMON_PID=$!
disown "$DAEMON_PID" 2>/dev/null || true
log "Daemon launched (PID: $DAEMON_PID)"

echo "Handoff initiated. New $MODEL agent launching in ~$((DELAY + 10))s with ${#SEED} char seed."
echo "Debug: $DEBUG_LOG"
