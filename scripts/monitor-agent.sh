#!/usr/bin/env bash
# monitor-agent.sh — Polling monitor daemon + full Claude Code Opus session.
#
# Usage: bash ~/.claude/scripts/monitor-agent.sh [--pane <pane-id>] <target-pane> [interval] [mission]
#
# Options:
#   --pane <pane-id>  Reuse an existing tmux pane instead of creating a new one.
#                     The pane should be at a shell prompt (no Claude running yet).
#                     On --stop, Claude in a reused pane is killed but the pane is preserved.
#
# Examples:
#   bash ~/.claude/scripts/monitor-agent.sh h:3.2 45 "Keep it focused"
#   bash ~/.claude/scripts/monitor-agent.sh --pane h:bi-opt.1 h:bi-opt.0 120 "Meta-monitor"
#
# Architecture:
#   ┌──────────────────────────────┐
#   │  Claude Code (Opus) session  │  ← tmux pane (the brain)
#   │  Full tools: bash, read, etc │
#   └──────────┬───────────────────┘
#              │ prompts via send-keys
#   ┌──────────┴───────────────────┐
#   │  Poller daemon (background)  │  ← bash, PID tracked
#   │  capture-pane every Ns       │
#   │  diff → POLL or IDLE event   │
#   └──────────────────────────────┘
#
# Stop:
#   bash ~/.claude/scripts/monitor-agent.sh --stop <target-pane>

set -euo pipefail

# --- State directory base ---
HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
MONITORS_DIR="$HARNESS_STATE_DIR/monitors"

# --- Stop mode ---
if [ "${1:-}" = "--stop" ]; then
  TARGET="${2:?Usage: monitor-agent.sh --stop <target-pane>}"

  # Resolve target to state dir: accept pane_id (%NNN), target (h:1.1), or slug (pidNNN)
  if [[ "$TARGET" == %* ]]; then
    # Direct pane_id
    SLUG="pid${TARGET#%}"
    DIR="$MONITORS_DIR/${SLUG}"
  else
    # Target string — resolve to pane_id if pane exists
    PANE_ID=$(tmux display-message -t "$TARGET" -p '#{pane_id}' 2>/dev/null || echo "")
    if [ -n "$PANE_ID" ]; then
      SLUG="pid${PANE_ID#%}"
      DIR="$MONITORS_DIR/${SLUG}"
    else
      # Pane gone — scan state dirs for matching worker-target
      DIR=""
      for wt in "$MONITORS_DIR"/pid*/worker-target; do
        [ -f "$wt" ] || continue
        if [ "$(cat "$wt")" = "$TARGET" ]; then
          DIR=$(dirname "$wt"); break
        fi
      done
      # Last resort: old slug format (migration period)
      [ -z "$DIR" ] && DIR="$MONITORS_DIR/$(echo "$TARGET" | tr ':.' '-')"
    fi
  fi

  if [ -f "$DIR/daemon.pid" ]; then
    DPID=$(cat "$DIR/daemon.pid")
    kill "$DPID" 2>/dev/null && echo "Daemon stopped (PID $DPID)" || echo "Daemon already gone"
  fi
  # Archive reflection receipt before cleanup
  if [ -f "$DIR/harness-name" ] && [ -f "$DIR/reflect-receipt.json" ]; then
    source "$HOME/.claude-ops/lib/fleet-jq.sh" 2>/dev/null || true
    _HNAME=$(cat "$DIR/harness-name" 2>/dev/null || echo "")
    if [ -n "$_HNAME" ]; then
      harness_archive_reflection "$_HNAME" "$DIR/reflect-receipt.json" 2>/dev/null || true
    fi
  fi
  if [ -f "$DIR/monitor-pane" ]; then
    MPANE=$(cat "$DIR/monitor-pane")
    # Prefer pane_id for tmux operations (stable across window reorders)
    MPANE_ID=$(cat "$DIR/monitor-pane-id" 2>/dev/null || echo "")
    MPANE_REF="${MPANE_ID:-$MPANE}"
    if [ -f "$DIR/reused-pane" ]; then
      # Don't kill reused panes — just kill the Claude process inside
      MPANE_PID=$(tmux display-message -t "$MPANE_REF" -p '#{pane_pid}' 2>/dev/null || echo "")
      if [ -n "$MPANE_PID" ]; then
        CLAUDE_PID=$(pgrep -P "$MPANE_PID" 2>/dev/null | head -1)
        [ -n "$CLAUDE_PID" ] && kill "$CLAUDE_PID" 2>/dev/null && echo "Claude killed in reused pane $MPANE" || echo "Claude already gone in $MPANE"
      fi
    else
      tmux kill-pane -t "$MPANE_REF" 2>/dev/null && echo "Monitor pane $MPANE closed" || echo "Pane already gone"
    fi
  fi
  rm -rf "$DIR"
  echo "Cleaned up $DIR"
  exit 0
fi

# --- Parse --pane option ---
REUSE_PANE=""
if [ "${1:-}" = "--pane" ]; then
  REUSE_PANE="${2:?Usage: monitor-agent.sh --pane <pane-id> <target-pane> [interval] [mission]}"
  shift 2
fi

# --- Args ---
TARGET_PANE="${1:?Usage: monitor-agent.sh [--pane <pane-id>] <target-pane> [interval] [mission]}"
INTERVAL="${2:-300}"
MISSION="${3:-Watch the target agent and nudge it if it goes off track or gets stuck.}"

# --- State directory (keyed by stable pane_id, not target) ---
WORKER_PANE_ID=$(tmux display-message -t "$TARGET_PANE" -p '#{pane_id}' 2>/dev/null || echo "")
[ -z "$WORKER_PANE_ID" ] && { echo "ERROR: Cannot resolve pane_id for $TARGET_PANE" >&2; exit 1; }
TARGET_SLUG="pid${WORKER_PANE_ID#%}"
STATE_DIR="$MONITORS_DIR/${TARGET_SLUG}"
mkdir -p "$STATE_DIR"
echo "$WORKER_PANE_ID" > "$STATE_DIR/worker-pane-id"
echo "$TARGET_PANE" > "$STATE_DIR/worker-target"
PREV_CAPTURE="$STATE_DIR/prev-capture.txt"
touch "$PREV_CAPTURE"

# --- Debounce: minimum seconds between sends to monitor ---
MIN_INTERVAL=15
LAST_SEND_FILE="$STATE_DIR/last-send"
echo 0 > "$LAST_SEND_FILE"

# --- Capture counter ---
CAPTURE_COUNT_FILE="$STATE_DIR/capture_count"
echo 0 > "$CAPTURE_COUNT_FILE"

# --- Debug log helper ---
daemon_log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$STATE_DIR/debug.log"
}

# --- Helper: send event to monitor Claude session (with debounce) ---
send_to_monitor() {
  local event_type="$1"
  local context="$2"
  local monitor_pane
  monitor_pane=$(cat "$STATE_DIR/monitor-pane" 2>/dev/null || echo "")
  if [ -z "$monitor_pane" ]; then
    daemon_log "SKIP[$event_type]: monitor-pane file empty"
    return
  fi

  # Check monitor pane still exists (prefer stable pane_id)
  local monitor_pane_id
  monitor_pane_id=$(cat "$STATE_DIR/monitor-pane-id" 2>/dev/null || echo "")
  local monitor_ref="${monitor_pane_id:-$monitor_pane}"

  # Verify the resolved pane_id matches what we expect
  local actual_pane_id
  actual_pane_id=$(tmux display-message -t "$monitor_ref" -p '#{pane_id}' 2>/dev/null || echo "GONE")
  if [ "$actual_pane_id" = "GONE" ]; then
    daemon_log "SKIP[$event_type]: monitor pane $monitor_ref no longer exists"
    return
  fi

  # Debounce
  local now last
  now=$(date +%s)
  last=$(cat "$LAST_SEND_FILE" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$MIN_INTERVAL" ]; then
    daemon_log "SKIP[$event_type]: debounce (${now}-${last}=$((now-last))s < ${MIN_INTERVAL}s)"
    return
  fi

  # Only send if Claude is idle (check last 8 lines — status bar pushes prompt up)
  local tail_content
  tail_content=$(tmux capture-pane -t "$monitor_ref" -p 2>/dev/null | tail -8)
  if ! echo "$tail_content" | grep -qE '(❯|>|bypass permissions)'; then
    daemon_log "SKIP[$event_type]: monitor not idle (no prompt detected in $monitor_ref)"
    return
  fi

  # Safety: NEVER send to the worker pane (prevents daemon→worker leaks)
  if [ "$monitor_ref" = "$WORKER_PANE_ID" ]; then
    daemon_log "SAFETY[$event_type]: monitor_ref=$monitor_ref == WORKER_PANE_ID=$WORKER_PANE_ID — BLOCKED"
    return
  fi

  # Double-check: resolve both to pane_ids and compare
  local worker_actual
  worker_actual=$(tmux display-message -t "$WORKER_PANE_ID" -p '#{pane_id}' 2>/dev/null || echo "GONE")
  if [ "$actual_pane_id" = "$worker_actual" ]; then
    daemon_log "SAFETY[$event_type]: resolved monitor pane $monitor_ref ($actual_pane_id) == worker pane $WORKER_PANE_ID ($worker_actual) — BLOCKED"
    return
  fi

  # Send the event (use -l for literal text to avoid tmux key interpretation)
  local msg="[${event_type}] ${context} — Capture target ${TARGET_PANE}, analyze, nudge if needed."
  daemon_log "SEND[$event_type]: target=$monitor_ref (pane_id=$actual_pane_id) worker=$WORKER_PANE_ID ($worker_actual) msg_len=${#msg}"
  tmux send-keys -t "$monitor_ref" -l "$msg" && tmux send-keys -t "$monitor_ref" -H 0d
  echo "$now" > "$LAST_SEND_FILE"
}

# ═══════════════════════════════════════════════════════════════
# WRITE PROMPT
# ═══════════════════════════════════════════════════════════════
PROMPT_FILE="$STATE_DIR/prompt.txt"

# Detect harness from registry (for meta-reflection actions)
HARNESS_NAME=""
PROGRESS_PATH=""
JOURNAL_PATH=""
source "$HOME/.claude-ops/lib/fleet-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
if [ -f "$HARNESS_SESSION_REGISTRY" ]; then
  # Try to find harness for the target pane's session
  search_root="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  while IFS= read -r pf; do
    [ -f "$pf" ] || continue
    h=$(jq -r '.harness // ""' "$pf" 2>/dev/null || true)
    s=$(jq -r '.status // ""' "$pf" 2>/dev/null || true)
    if [ "$s" = "active" ] && [ -n "$h" ]; then
      # Heuristic: if target pane name contains the harness name, match
      if echo "$TARGET_PANE" | grep -qi "$h"; then
        HARNESS_NAME="$h"
        PROGRESS_PATH="$pf"
        # Journal: same dir for new convention, same prefix for legacy
        pf_dir=$(dirname "$pf")
        if [ "$(basename "$pf")" = "progress.json" ]; then
          JOURNAL_PATH="$pf_dir/journal.md"
        else
          JOURNAL_PATH="${pf%-progress.json}-journal.md"
        fi
        break
      fi
    fi
  done < <(harness_all_progress_files "$search_root")
fi

# Store harness name in state dir for --stop handler
[ -n "$HARNESS_NAME" ] && echo "$HARNESS_NAME" > "$STATE_DIR/harness-name"

# --- Session transcript discovery ---
SESSION_JSONL_PATH=""
source "$HOME/.claude-ops/lib/session-reader.sh" 2>/dev/null || true
if [ -n "$HARNESS_NAME" ]; then
  SESSION_JSONL_PATH=$(session_find "$HARNESS_NAME" 2>/dev/null || true)
fi
echo "$SESSION_JSONL_PATH" > "$STATE_DIR/session-jsonl"

# --- Helper: get session digest for event enrichment ---
get_session_digest() {
  local jsonl_path
  jsonl_path=$(cat "$STATE_DIR/session-jsonl" 2>/dev/null || echo "")
  [ -z "$jsonl_path" ] || [ ! -f "$jsonl_path" ] && return
  session_summary "$jsonl_path" 20 2>/dev/null || true
}


# Build harness-specific paths for the prompt
HARNESS_PATHS_BLOCK=""
if [ -n "$HARNESS_NAME" ]; then
  HARNESS_PATHS_BLOCK="
**Harness:** \`${HARNESS_NAME}\`
**Progress:** \`${PROGRESS_PATH}\`
**Journal:** \`${JOURNAL_PATH}\`
**Session transcript:** \`${SESSION_JSONL_PATH}\`
"
fi

## Stable pane reference for the target worker
## TARGET_PANE is the human-friendly label (h:3.1), WORKER_PANE_ID is the stable tmux pane_id (%NNN)
## All tmux commands in the prompt use WORKER_PANE_ID to survive window reorders.
STABLE_TARGET="${WORKER_PANE_ID}"

cat > "$PROMPT_FILE" <<PROMPT
You are a MONITOR AGENT with three roles: **Guardian**, **Wave Enforcer**, and **Evolver**.
You watch the Claude Code agent in tmux pane ${TARGET_PANE} (stable id: ${STABLE_TARGET}).

**IMPORTANT:** Always use stable pane id \`${STABLE_TARGET}\` for tmux commands, not \`${TARGET_PANE}\`.

**Mission:** ${MISSION}
${HARNESS_PATHS_BLOCK}
**Events from poller daemon:**
- \`POLL\` — periodic check (every ${INTERVAL}s), target pane changed since last check
- \`IDLE\` — target pane unchanged since last check

---

## Role 1: Guardian — Mission Advancer

Your stance is **proactive silence**: quiet when the agent is productive, but ACTIVE when it's idle.

On every event:

1. Read progress.json — is the agent on the right task?
2. Does the approach align with the mission spirit (not just letter)?
3. **Intervene when:**
   - **IDLE at prompt** — this is your PRIMARY trigger. Read the mission, check pending tasks,
     and nudge with a SPECIFIC next action: "Start task X" or "The mission says Y but we haven't
     addressed Z — investigate that." Don't just say "continue" — tell it WHAT to do.
   - Working on wrong task (not the current one in progress.json)
   - Same error repeated 3+ times (stuck in a loop)
   - Deploying without testing
   - Skipping a wave gate (see Role 2)
4. **When agent completes a task** — check if there are unblocked pending tasks and nudge it
   to pick up the next one. Don't let it sit idle between tasks.

**If the agent is THINKING or EXECUTING, stay silent.** But if it's IDLE, always check if
there's mission-advancing work it could be doing.

## Role 2: Wave Enforcer — Protocol Compliance

Events include wave state (wave_progress, is_wave_boundary, current_task). Check:

1. **Wave gate tasks (\`wave-N-report\`)** — these are structural gates in progress.json with \`metadata.wave_gate: true\`. They block the next wave's tasks via \`blockedBy\`.
2. If agent is working on wave N+1 tasks while \`wave-N-report\` is still pending → **INTERVENE IMMEDIATELY**. Send: "STOP — wave-N-report gate is pending. Complete the gate steps before proceeding."
3. Gate steps: commit, deploy, inspect Chrome, screenshot, report HTML, open, notify, wait for the operator.
4. Report file location: \`~/.claude-ops/harness/reports/${HARNESS_NAME:-unknown}/wave-{N}.html\`
5. Only after the report exists AND the operator confirms → gate can be marked completed.

## Role 3: Evolver — Harness Maintenance

You can **read AND write** the harness. Use these exact commands:

\`\`\`bash
# Source harness functions
source ~/.claude-ops/lib/fleet-jq.sh

# Add a new task
locked_jq_write "${PROGRESS_PATH}" "progress-${HARNESS_NAME}" \
  '.tasks["new-task-id"] = {"status":"pending","description":"...","blockedBy":[],"metadata":{}}'

# Fix task status
locked_jq_write "${PROGRESS_PATH}" "progress-${HARNESS_NAME}" \
  '.tasks["task-id"].status = "completed"'

# Create a new wave and inject gates
locked_jq_write "${PROGRESS_PATH}" "progress-${HARNESS_NAME}" \
  '.waves += [{"id":(.waves|length)+1,"name":"Phase 2","tasks":["new-t1","new-t2"],"status":"pending"}]'
harness_inject_wave_gates "${PROGRESS_PATH}"
\`\`\`

**When to evolve:** When all seed tasks are done, re-read the harness.md, identify gaps between reality and vision, create Phase 2 waves with new tasks.

---

## TUI State Detection

From \`tmux capture-pane -t ${STABLE_TARGET} -p | tail -30\`:
- \`❯\` at end → **IDLE** (direct nudge works)
- \`Waiting for task\` → **BLOCKED** (MUST Escape first, then nudge)
- \`Generating\`/\`Considering\`/\`Noodling\`/\`Cooked\` → **THINKING** (DO NOT interrupt unless 5+ polls with no token change)
- \`Running…\` → **EXECUTING** (wait unless >10min)

**Nudge mechanics:**
\`\`\`bash
# Find own pane (first time only):
MY_PANE_ID=\$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' | while read pid id; do
  p=\$PPID; while [ "\$p" -gt 1 ]; do
    [ "\$p" = "\$pid" ] && echo "\$id" && break 2
    p=\$(ps -o ppid= -p "\$p" 2>/dev/null | tr -d ' ')
  done
done)
MY_PANE=\$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="\$MY_PANE_ID" '\$1 == id {print \$2; exit}')
SIGNATURE="[from \$MY_PANE (monitor)]"

# IDLE → direct nudge:
tmux send-keys -t ${STABLE_TARGET} "\$SIGNATURE nudge" && tmux send-keys -t ${STABLE_TARGET} -H 0d

# BLOCKED → Escape first:
tmux send-keys -t ${STABLE_TARGET} Escape; sleep 2
tmux send-keys -t ${STABLE_TARGET} "\$SIGNATURE nudge" && tmux send-keys -t ${STABLE_TARGET} -H 0d
\`\`\`

---

## Completion Detection + Notification

On every event, check progress for milestones. Notify the operator exactly ONCE per milestone:

\`\`\`bash
NOTIFIED_FILE="${STATE_DIR}/notified_milestones"
touch "\$NOTIFIED_FILE"

# Wave gate actionable (all blockers done, gate pending)
source ~/.claude-ops/lib/fleet-jq.sh 2>/dev/null
WAVE_BOUNDARY=\$(harness_is_wave_boundary "${PROGRESS_PATH}" 2>/dev/null || echo "false")
if [ "\$WAVE_BOUNDARY" = "true" ]; then
  WAVE_INFO=\$(harness_wave_progress "${PROGRESS_PATH}")
  if ! grep -q "boundary-\$WAVE_INFO" "\$NOTIFIED_FILE" 2>/dev/null; then
    notify "${HARNESS_NAME:-harness} wave boundary reached — \$WAVE_INFO"
    echo "boundary-\$WAVE_INFO" >> "\$NOTIFIED_FILE"
  fi
fi

# All tasks complete
ALL_DONE=\$(jq '[.tasks[] | select(.status != "completed")] | length == 0' "${PROGRESS_PATH}" 2>/dev/null || echo "false")
if [ "\$ALL_DONE" = "true" ] && ! grep -q "all-done" "\$NOTIFIED_FILE" 2>/dev/null; then
  notify "${HARNESS_NAME:-harness} all tasks complete — needs Phase 2 review"
  echo "all-done" >> "\$NOTIFIED_FILE"
fi
\`\`\`

**Report generation:** Use the same pattern from before — generate HTML, open, notify.

## Deep Analysis

Session transcript: \`${SESSION_JSONL_PATH}\`
\`\`\`bash
tail -50 ${SESSION_JSONL_PATH} | jq -r 'select(.message.role == "assistant") | .message.content[] | select(.type == "text") | .text[:200]'
tail -50 ${SESSION_JSONL_PATH} | jq -r 'select(.message.role == "assistant") | .message.content[] | select(.type == "tool_use") | "\(.name) \(.input.file_path // .input.command // .input.pattern // "" | tostring | .[:80])"'
\`\`\`

## Meta-Reflection (REFLECT Events)

Every 6 captures, the daemon fires a \`[REFLECT]\` event. This is your meta-reflection moment.
When you receive a REFLECT event, you MUST write a receipt file with substantive content.
Do NOT write just \`{"reflected_at": "...", "capture_count": N}\`.

**Required receipt format** at \`${STATE_DIR}/reflect-receipt.json\`:
\`\`\`json
{
  "reflected_at": "ISO timestamp",
  "capture_count": N,
  "patterns": ["1-sentence observation", "max 3"],
  "context_injection": {"trigger": "file_or_tool_pattern", "content": "knowledge to inject"} or null,
  "best_practice_update": {"key.path": "new_value"} or null,
  "assessment": "1 sentence: is the agent on track toward the mission?"
}
\`\`\`

- **\`patterns\`** is MANDATORY — read the last 20 activity log entries and identify what the
  agent has been doing. If you can't find patterns, say "Agent idle/blocked — no activity to analyze."
- **\`assessment\`** is MANDATORY — read the harness mission and compare to current progress.
- **\`context_injection\`** — if you discover knowledge the agent should receive before certain
  tool calls, write it here. It feeds the pre-tool-context-injector.
- **\`best_practice_update\`** — if you notice a threshold or rule that should be tuned,
  write the jq path and new value here.

## Rules Summary
- **Default: do NOT nudge.** Silence is correct most of the time.
- Wave gate violations get immediate intervention.
- Patience: THINKING=5+ polls, EXECUTING=10min, IDLE=5min.
- NEVER send text to BLOCKED agent without Escaping first.
- ALWAYS notify on milestones. File issues for infra bugs.
- Sign all nudges: \`[from {pane} (monitor)]\`

Start your first check now.
PROMPT

# ═══════════════════════════════════════════════════════════════
# METRICS EMISSION
# ═══════════════════════════════════════════════════════════════
emit_metric() {
  local type="$1" extra="$2"
  local ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local harness_name="${HARNESS_NAME:-unknown}"
  printf '{"ts":"%s","type":"%s","agent":"%s","harness":"%s"%s}\n' \
    "$ts" "$type" "$TARGET_PANE" "$harness_name" "$extra" \
    >> "${HARNESS_METRICS_FILE:-$HOME/.claude-ops/state/metrics.jsonl}" 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════
# LAUNCH CLAUDE CODE SESSION
# ═══════════════════════════════════════════════════════════════
if [ -n "$REUSE_PANE" ]; then
  # Reuse existing pane — verify it exists
  if ! tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null | grep -q "^${REUSE_PANE}$"; then
    # Try with window name format (e.g. h:bi-opt.1)
    if ! tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}' 2>/dev/null | grep -q "^${REUSE_PANE}$"; then
      echo "ERROR: Pane ${REUSE_PANE} not found" >&2; exit 1
    fi
  fi
  MONITOR_PANE="$REUSE_PANE"
  MONITOR_PANE_ID=$(tmux display-message -t "$REUSE_PANE" -p '#{pane_id}' 2>/dev/null || echo "")
else
  MONITOR_PANE=$(tmux split-window -v -l 30% -P -F '#{session_name}:#{window_index}.#{pane_index}')
  MONITOR_PANE_ID=$(tmux display-message -t "$MONITOR_PANE" -p '#{pane_id}' 2>/dev/null || echo "")
fi
echo "$MONITOR_PANE" > "$STATE_DIR/monitor-pane"
echo "$MONITOR_PANE_ID" > "$STATE_DIR/monitor-pane-id"
echo "$MONITOR_PANE" > "$STATE_DIR/monitor-target"
[ -n "$REUSE_PANE" ] && touch "$STATE_DIR/reused-pane"
echo "Monitor pane: ${MONITOR_PANE}"

# Label both panes for easy identification in borders
tmux select-pane -t "$MONITOR_PANE" -T "MONITOR→${TARGET_PANE}"
tmux select-pane -t "$TARGET_PANE" -T "MONITORED by ${MONITOR_PANE}" 2>/dev/null || true

# Launch Claude (full command, not alias — aliases don't resolve in non-interactive shells)
tmux send-keys -t "$MONITOR_PANE" "claude --dangerously-skip-permissions --model opus" && tmux send-keys -t "$MONITOR_PANE" -H 0d

# Wait for Claude to start
echo "Waiting for Claude to start..."
for i in $(seq 1 30); do
  sleep 2
  PANE_CONTENT=$(tmux capture-pane -t "$MONITOR_PANE" -p 2>/dev/null || echo "")
  if echo "$PANE_CONTENT" | grep -qE '(❯|>)'; then
    echo "Claude ready (~$((i*2))s)"
    break
  fi
done

# Send initial prompt
tmux load-buffer -b "mon-$$" "$PROMPT_FILE"
tmux paste-buffer -b "mon-$$" -t "$MONITOR_PANE" -d
sleep 0.5
tmux send-keys -t "$MONITOR_PANE" -H 0d

# ═══════════════════════════════════════════════════════════════
# START POLLER DAEMON
# ═══════════════════════════════════════════════════════════════
(
  # Disable set -e and pipefail in daemon subshell:
  # - grep -v returns 1 on empty input → kills daemon under set -e + pipefail
  # - Various tmux commands can fail transiently
  set +e +o pipefail

  # Source shared libraries in subshell (functions aren't inherited)
  source "$HOME/.claude-ops/lib/session-reader.sh" 2>/dev/null || true
  source "$HOME/.claude-ops/lib/fleet-jq.sh" 2>/dev/null || true

  trap 'exit 0' TERM INT

  # Log daemon startup with all pane refs for debugging
  daemon_log "DAEMON_START: worker=$TARGET_PANE ($WORKER_PANE_ID) monitor=$MONITOR_PANE ($MONITOR_PANE_ID) interval=$INTERVAL state=$STATE_DIR"
  daemon_log "STATE_FILES: monitor-pane=$(cat "$STATE_DIR/monitor-pane" 2>/dev/null) monitor-pane-id=$(cat "$STATE_DIR/monitor-pane-id" 2>/dev/null)"

  # Track consecutive ALL_DONE IDLE captures for auto-shutdown
  ALL_DONE_IDLE_COUNT_FILE="$STATE_DIR/all-done-idle-count"
  echo 0 > "$ALL_DONE_IDLE_COUNT_FILE"

  sleep 30  # Let first check from prompt complete

  while true; do
    sleep "$INTERVAL"

    # Check monitor pane still exists (prefer stable pane_id)
    daemon_monitor_ref="${MONITOR_PANE_ID:-$MONITOR_PANE}"
    if ! tmux display-message -t "$daemon_monitor_ref" -p '#{pane_id}' >/dev/null 2>&1; then
      rm -f "$STATE_DIR/daemon.pid"
      exit 0
    fi

    # Check target pane still exists — exit daemon if target is gone
    if ! tmux display-message -t "$WORKER_PANE_ID" -p '#{pane_id}' >/dev/null 2>&1; then
      # Target pane is dead — send final notice to monitor and exit
      send_to_monitor "IDLE" "Target pane ${TARGET_PANE} (${WORKER_PANE_ID}) is gone. Agent may have exited or pane was closed. Daemon stopping."
      emit_metric "target_gone" ""
      rm -f "$STATE_DIR/daemon.pid"
      exit 0
    fi

    # Capture current state using stable pane_id (|| true guards against grep/pipefail failures)
    current=$(tmux capture-pane -t "$WORKER_PANE_ID" -p 2>/dev/null | grep -v '^[[:space:]]*$' | tail -20 || true)
    [ -z "$current" ] && continue

    prev=$(cat "$PREV_CAPTURE" 2>/dev/null || echo "")
    echo "$current" > "$PREV_CAPTURE"

    # Detect target TUI state for richer context
    tui_state="unknown"
    if echo "$current" | grep -q "Waiting for task"; then
      tui_state="BLOCKED(waiting-for-task)"
    elif echo "$current" | grep -qE '(Generating|Considering|Noodling|Cooked|thinking|Hatching)'; then
      tui_state="THINKING"
    elif echo "$current" | grep -qE 'Running.*timeout'; then
      tui_state="EXECUTING"
    elif echo "$current" | grep -q '❯'; then
      tui_state="IDLE(at-prompt)"
    fi

    # --- Increment capture counter ---
    capture_count=$(cat "$CAPTURE_COUNT_FILE" 2>/dev/null || echo 0)
    capture_count=$((capture_count + 1))
    echo "$capture_count" > "$CAPTURE_COUNT_FILE"

    # --- Re-resolve session JSONL every 10 captures (handles session rotation) ---
    if [ $((capture_count % 10)) -eq 0 ] && [ -n "${HARNESS_NAME:-}" ]; then
      new_jsonl=$(session_find "$HARNESS_NAME" 2>/dev/null || true)
      [ -n "$new_jsonl" ] && echo "$new_jsonl" > "$STATE_DIR/session-jsonl"
    fi

    # --- Get session digest for event enrichment ---
    session_digest=$(get_session_digest 2>/dev/null || true)

    # --- Mission + task enrichment (appended to every event) ---
    wave_state=""
    mission_context=""
    if [ -n "${HARNESS_NAME:-}" ] && [ -n "${PROGRESS_PATH:-}" ] && [ -f "${PROGRESS_PATH}" ]; then
      wp=$(harness_wave_progress "$PROGRESS_PATH" 2>/dev/null || echo "")
      wb=$(harness_is_wave_boundary "$PROGRESS_PATH" 2>/dev/null || echo "false")
      dc=$(harness_done_count "$PROGRESS_PATH" 2>/dev/null || echo "0")
      tc=$(harness_total_count "$PROGRESS_PATH" 2>/dev/null || echo "0")
      ct=$(harness_current_task "$PROGRESS_PATH" 2>/dev/null || echo "unknown")
      wave_state=" | wave_progress: ${wp:-none} | is_wave_boundary: ${wb} | progress: ${dc}/${tc} | current_task: ${ct}"

      # Extract mission + pending tasks for proactive nudging
      _mission=$(jq -r '.mission // ""' "$PROGRESS_PATH" 2>/dev/null | head -c 200 || true)
      _pending=$(jq -r '[.tasks | to_entries[] | select(.value.status == "pending") | .key] | join(", ")' "$PROGRESS_PATH" 2>/dev/null | head -c 200 || true)
      _in_progress=$(jq -r '[.tasks | to_entries[] | select(.value.status == "in_progress") | .key] | join(", ")' "$PROGRESS_PATH" 2>/dev/null | head -c 200 || true)
      [ -n "$_mission" ] && mission_context=" | mission: ${_mission}"
      [ -n "$_pending" ] && mission_context="${mission_context} | pending_tasks: ${_pending}"
      [ -n "$_in_progress" ] && mission_context="${mission_context} | in_progress: ${_in_progress}"

      # --- AUTO-SHUTDOWN: detect 5 consecutive ALL_DONE IDLE captures ---
      all_done_idle_count=$(cat "$ALL_DONE_IDLE_COUNT_FILE" 2>/dev/null || echo 0)
      if [ "$dc" != "0" ] && [ "$dc" = "$tc" ] && [ "$tui_state" = "IDLE(at-prompt)" ]; then
        # All tasks done AND agent is idle
        all_done_idle_count=$((all_done_idle_count + 1))
        daemon_log "ALL_DONE_IDLE: count=$all_done_idle_count (capture #$capture_count, tui=$tui_state, progress=$dc/$tc)"
        echo "$all_done_idle_count" > "$ALL_DONE_IDLE_COUNT_FILE"

        # After 5 consecutive ALL_DONE IDLE captures, notify the operator and exit
        if [ "$all_done_idle_count" -ge 5 ]; then
          notify "${HARNESS_NAME:-unknown} harness completed (${dc}/${tc} tasks done). Monitor auto-shutdown after 5 consecutive idle captures." "Monitor Complete"
          daemon_log "AUTO_SHUTDOWN: harness complete, monitor exiting after 5 consecutive ALL_DONE IDLE captures"
          emit_metric "auto_shutdown" ",\"harness\":\"${HARNESS_NAME}\",\"total_captures\":$capture_count,\"all_done_idle_count\":$all_done_idle_count"
          rm -f "$STATE_DIR/daemon.pid"
          exit 0
        fi
      else
        # Reset counter if not in ALL_DONE IDLE state
        if [ "$all_done_idle_count" -gt 0 ]; then
          daemon_log "ALL_DONE_IDLE_RESET: was $all_done_idle_count, now resetting (tui=$tui_state, progress=$dc/$tc)"
        fi
        echo 0 > "$ALL_DONE_IDLE_COUNT_FILE"
      fi
    fi

    # --- REFLECT event every 6 captures ---
    if [ $((capture_count % 6)) -eq 0 ] && [ "$capture_count" -gt 0 ]; then
      reflect_context="[REFLECT] Capture #${capture_count}. TUI state: ${tui_state}.${wave_state}${mission_context}"
      [ -n "$session_digest" ] && reflect_context="${reflect_context} session_digest: ${session_digest}"
      reflect_context="${reflect_context} — Read the mission, compare to progress. Is the agent advancing? If idle, what specific task could move the mission forward? Write receipt to ${STATE_DIR}/reflect-receipt.json with patterns + assessment + actionable next step."
      send_to_monitor "REFLECT" "$reflect_context"
      emit_metric "reflect" ",\"capture_count\":$capture_count"
    fi

    # --- Archive new reflection receipts (check after REFLECT events) ---
    if [ $((capture_count % 6)) -eq 1 ] && [ "$capture_count" -gt 1 ] && [ -n "${HARNESS_NAME:-}" ]; then
      receipt="$STATE_DIR/reflect-receipt.json"
      last_mtime_file="$STATE_DIR/.last-archived-receipt-mtime"
      if [ -f "$receipt" ]; then
        receipt_mtime=$(_file_mtime "$receipt" 2>/dev/null || echo 0)
        last_archived=$(cat "$last_mtime_file" 2>/dev/null || echo 0)
        if [ "$receipt_mtime" -gt "$last_archived" ]; then
          harness_archive_reflection "$HARNESS_NAME" "$receipt" 2>/dev/null || true
          echo "$receipt_mtime" > "$last_mtime_file"
          daemon_log "ARCHIVED reflection receipt (mtime=$receipt_mtime)"
        fi
      fi
    fi

    # --- Decide event type: POLL vs IDLE ---
    if [ "$current" = "$prev" ]; then
      idle_context="Pane ${TARGET_PANE} unchanged for ${INTERVAL}s. TUI state: ${tui_state}.${wave_state}${mission_context}"
      [ -n "$session_digest" ] && idle_context="${idle_context} session_digest: ${session_digest}"
      # If agent is idle at prompt, add mission-advancing guidance
      if [ "$tui_state" = "IDLE(at-prompt)" ]; then
        idle_context="${idle_context} — Agent is IDLE. Check if there are pending tasks it could start, or if the mission has unaddressed gaps. If so, nudge with a specific next action."
      fi
      send_to_monitor "IDLE" "$idle_context"
      emit_metric "poll" ",\"tui_state\":\"${tui_state}\",\"changed\":false"
    else
      poll_context="Pane ${TARGET_PANE} check (${INTERVAL}s). TUI state: ${tui_state}. Capture #${capture_count}.${wave_state}${mission_context}"
      [ -n "$session_digest" ] && poll_context="${poll_context} session_digest: ${session_digest}"
      send_to_monitor "POLL" "$poll_context"
      emit_metric "poll" ",\"tui_state\":\"${tui_state}\",\"changed\":true,\"capture_count\":$capture_count"
    fi
  done
) &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$STATE_DIR/daemon.pid"
disown "$DAEMON_PID" 2>/dev/null || disown

sleep 1

echo ""
echo "=== Monitor Agent ==="
echo "  Monitor pane:  ${MONITOR_PANE} (${MONITOR_PANE_ID})"
echo "  Target pane:   ${TARGET_PANE} (${WORKER_PANE_ID})"
echo "  Poll interval: ${INTERVAL}s"
echo "  State dir:     ${STATE_DIR}"
echo "  Daemon PID:    ${DAEMON_PID}"
echo ""
echo "  Stop: bash ~/.claude/scripts/monitor-agent.sh --stop ${TARGET_PANE}"
echo "    or: bash ~/.claude/scripts/monitor-agent.sh --stop ${WORKER_PANE_ID}"
