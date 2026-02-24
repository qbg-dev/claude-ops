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

# --- Stop mode ---
if [ "${1:-}" = "--stop" ]; then
  TARGET="${2:?Usage: monitor-agent.sh --stop <target-pane>}"

  # Resolve target to state dir: accept pane_id (%NNN), target (h:1.1), or slug (pidNNN)
  if [[ "$TARGET" == %* ]]; then
    # Direct pane_id
    SLUG="pid${TARGET#%}"
    DIR="/tmp/monitor-agent-${SLUG}"
  else
    # Target string — resolve to pane_id if pane exists
    PANE_ID=$(tmux display-message -t "$TARGET" -p '#{pane_id}' 2>/dev/null || echo "")
    if [ -n "$PANE_ID" ]; then
      SLUG="pid${PANE_ID#%}"
      DIR="/tmp/monitor-agent-${SLUG}"
    else
      # Pane gone — scan state dirs for matching worker-target
      DIR=""
      for wt in /tmp/monitor-agent-pid*/worker-target; do
        [ -f "$wt" ] || continue
        if [ "$(cat "$wt")" = "$TARGET" ]; then
          DIR=$(dirname "$wt"); break
        fi
      done
      # Last resort: old slug format (migration period)
      [ -z "$DIR" ] && DIR="/tmp/monitor-agent-$(echo "$TARGET" | tr ':.' '-')"
    fi
  fi

  if [ -f "$DIR/daemon.pid" ]; then
    DPID=$(cat "$DIR/daemon.pid")
    kill "$DPID" 2>/dev/null && echo "Daemon stopped (PID $DPID)" || echo "Daemon already gone"
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
INTERVAL="${2:-60}"
MISSION="${3:-Watch the target agent and nudge it if it goes off track or gets stuck.}"

# --- State directory (keyed by stable pane_id, not target) ---
WORKER_PANE_ID=$(tmux display-message -t "$TARGET_PANE" -p '#{pane_id}' 2>/dev/null || echo "")
[ -z "$WORKER_PANE_ID" ] && { echo "ERROR: Cannot resolve pane_id for $TARGET_PANE" >&2; exit 1; }
TARGET_SLUG="pid${WORKER_PANE_ID#%}"
STATE_DIR="/tmp/monitor-agent-${TARGET_SLUG}"
mkdir -p "$STATE_DIR"
echo "$WORKER_PANE_ID" > "$STATE_DIR/worker-pane-id"
echo "$TARGET_PANE" > "$STATE_DIR/worker-target"
PREV_CAPTURE="$STATE_DIR/prev-capture.txt"
touch "$PREV_CAPTURE"

# --- Debounce: minimum seconds between sends to monitor ---
MIN_INTERVAL=15
LAST_SEND_FILE="$STATE_DIR/last-send"
echo 0 > "$LAST_SEND_FILE"

# --- REFLECT: capture counter + receipt tracking ---
REFLECT_INTERVAL="${REFLECT_INTERVAL:-6}"  # captures between reflections
CAPTURE_COUNT_FILE="$STATE_DIR/capture_count"
echo 0 > "$CAPTURE_COUNT_FILE"
REFLECT_RECEIPT_FILE="/tmp/monitor_reflection_${TARGET_SLUG}_latest.json"
REFLECT_PENDING_FILE="$STATE_DIR/reflect_pending"
REFLECT_OVERDUE_POLLS=3  # polls without receipt before sending REFLECT_OVERDUE

# --- Helper: send event to monitor Claude session (with debounce) ---
send_to_monitor() {
  local event_type="$1"
  local context="$2"
  local monitor_pane
  monitor_pane=$(cat "$STATE_DIR/monitor-pane" 2>/dev/null || echo "")
  [ -z "$monitor_pane" ] && return

  # Check monitor pane still exists (prefer stable pane_id)
  local monitor_pane_id
  monitor_pane_id=$(cat "$STATE_DIR/monitor-pane-id" 2>/dev/null || echo "")
  local monitor_ref="${monitor_pane_id:-$monitor_pane}"
  tmux display-message -t "$monitor_ref" -p '#{pane_id}' >/dev/null 2>&1 || return

  # Debounce
  local now last
  now=$(date +%s)
  last=$(cat "$LAST_SEND_FILE" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$MIN_INTERVAL" ]; then
    return
  fi

  # Only send if Claude is idle (check last 8 lines — status bar pushes prompt up)
  local tail_content
  tail_content=$(tmux capture-pane -t "$monitor_ref" -p 2>/dev/null | tail -8)
  if ! echo "$tail_content" | grep -qE '(❯|>|bypass permissions)'; then
    return
  fi

  # Send the event (use stable pane_id ref)
  local msg="[${event_type}] ${context} — Capture target ${TARGET_PANE}, analyze, nudge if needed."
  tmux send-keys -t "$monitor_ref" "$msg" && tmux send-keys -t "$monitor_ref" -H 0d
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
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
if [ -f "$HARNESS_SESSION_REGISTRY" ]; then
  # Try to find harness for the target pane's session
  # We'll pass paths to the prompt so the monitor can update them
  for pf in ${PROJECT_ROOT:-/Users/wz/Desktop/zPersonalProjects/Wechat}/claude_files/*-progress.json; do
    [ -f "$pf" ] || continue
    h=$(jq -r '.harness // ""' "$pf" 2>/dev/null || true)
    s=$(jq -r '.status // ""' "$pf" 2>/dev/null || true)
    if [ "$s" = "active" ] && [ -n "$h" ]; then
      # Heuristic: if target pane name contains the harness name, match
      if echo "$TARGET_PANE" | grep -qi "$h"; then
        HARNESS_NAME="$h"
        PROGRESS_PATH="$pf"
        JOURNAL_PATH="${pf%-progress.json}-journal.md"
        break
      fi
    fi
  done
fi

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

get_session_digest_rich() {
  local jsonl_path
  jsonl_path=$(cat "$STATE_DIR/session-jsonl" 2>/dev/null || echo "")
  [ -z "$jsonl_path" ] || [ ! -f "$jsonl_path" ] && return
  echo "=== Session Summary ==="
  session_summary "$jsonl_path" 40 2>/dev/null || true
  echo ""
  echo "=== Recent Errors ==="
  session_errors "$jsonl_path" 40 2>/dev/null || true
  echo ""
  echo "=== Recent Tools ==="
  session_recent_tools "$jsonl_path" 40 2>/dev/null || true
}

# Build harness-specific paths for the prompt
HARNESS_PATHS_BLOCK=""
if [ -n "$HARNESS_NAME" ]; then
  HARNESS_PATHS_BLOCK="
**Harness:** \`${HARNESS_NAME}\`
**Progress:** \`${PROGRESS_PATH}\`
**Journal:** \`${JOURNAL_PATH}\`
**Receipt file:** \`${REFLECT_RECEIPT_FILE}\`
**Session transcript:** \`${SESSION_JSONL_PATH}\`
"
fi

## Stable pane reference for the target worker
## TARGET_PANE is the human-friendly label (h:3.1), WORKER_PANE_ID is the stable tmux pane_id (%NNN)
## All tmux commands in the prompt use WORKER_PANE_ID to survive window reorders.
STABLE_TARGET="${WORKER_PANE_ID}"

cat > "$PROMPT_FILE" <<PROMPT
You are a MONITOR AGENT. Your job is to watch the Claude Code agent running in tmux pane ${TARGET_PANE} (stable id: ${STABLE_TARGET}) and keep it on track.

**IMPORTANT:** Always use the stable pane id \`${STABLE_TARGET}\` for tmux commands (capture-pane, send-keys), not \`${TARGET_PANE}\`. Human-readable pane indices shift when windows are opened/closed/reordered.

**Your mission:** ${MISSION}
${HARNESS_PATHS_BLOCK}
**You receive events from a poller daemon:**
- \`POLL\` — periodic check (every ${INTERVAL}s), target pane changed since last check
- \`IDLE\` — target pane unchanged since last check, agent may be stuck
- \`REFLECT\` — every ${REFLECT_INTERVAL} captures, time for meta-reflection (see below)
- \`REFLECT_OVERDUE\` — you received a REFLECT but haven't written the receipt file yet

**On POLL / IDLE events, do this:**

1. Find your own pane ID and name (first time only, cache it):
   WARNING: Do NOT use \`tmux display-message -p\` — it returns the focused pane, not yours.
   Instead, walk the process tree to find which pane owns your shell:
   \`\`\`
   MY_PANE_ID=\$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' | while read pid id; do
     p=\$PPID; while [ "\$p" -gt 1 ]; do
       [ "\$p" = "\$pid" ] && echo "\$id" && break 2
       p=\$(ps -o ppid= -p "\$p" 2>/dev/null | tr -d ' ')
     done
   done)
   MY_PANE=\$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="\$MY_PANE_ID" '\$1 == id {print \$2; exit}')
   MY_NAME=\$(jq -r '.harness // empty' "/tmp/tmux_pane_meta_\${MY_PANE_ID}" 2>/dev/null || true)
   [ -z "\$MY_NAME" ] && MY_NAME="monitor"
   SIGNATURE="[from \$MY_PANE (\$MY_NAME)]"
   \`\`\`

2. Capture the target's recent output:
   \`tmux capture-pane -t ${STABLE_TARGET} -p | tail -30\`

3. **Detect the target's TUI state** from the capture:
   - \`❯\` visible at end → **IDLE** (at prompt, ready for input)
   - \`Waiting for task\` visible → **BLOCKED** (background task running, Enter is swallowed)
   - \`Generating\`/\`Considering\`/\`Noodling\`/\`Cooked\` → **THINKING** (actively working, don't interrupt)
   - \`Running…\` with timeout → **EXECUTING** (foreground command, wait unless very long)

4. Analyze: Is the agent on track? Stuck? Off-task? Making mistakes?

5. **Choose intervention based on state:**

   **If IDLE** — direct nudge works:
   \`\`\`
   tmux send-keys -t ${STABLE_TARGET} "\$SIGNATURE your nudge here"
   tmux send-keys -t ${STABLE_TARGET} -H 0d
   \`\`\`

   **If BLOCKED (Waiting for task)** — MUST Escape first, text nudges are useless:
   \`\`\`
   tmux send-keys -t ${STABLE_TARGET} Escape
   sleep 2
   tmux send-keys -t ${STABLE_TARGET} "\$SIGNATURE your nudge here"
   tmux send-keys -t ${STABLE_TARGET} -H 0d
   \`\`\`
   CRITICAL: In "Waiting for task" state, Enter is swallowed by the TUI. Text gets queued
   but never submitted. You MUST Escape to break out first. Do NOT waste polls sending
   text nudges to a blocked agent — go straight to Escape on first detection.

   **If THINKING** — BE PATIENT. Agents routinely think for 5-10+ minutes on complex tasks.
   Only intervene if the same "thinking" state persists across **5+ consecutive polls** (~5min).
   Even then, check if the token count is growing — if so, it's working, leave it alone.
   Only Escape if genuinely stalled (no token count change for 5+ polls).

   **If EXECUTING** — wait for completion. Commands can run 3-5 minutes (deploys, evals, SSH).
   Only flag if past 2x expected timeout (e.g., >10min for a deploy).

6. If on track (thinking, executing, or making progress), just say "on track" and wait for next event. **Default to patience.**

**On REFLECT events, do a full meta-reflection:**

A REFLECT event means you've accumulated ${REFLECT_INTERVAL} captures. Step back from moment-to-moment monitoring and synthesize what you've observed. Meta-reflection = pattern recognition across multiple observations, not just reacting to the latest capture.

Concretely, do these four things:

1. **Synthesize patterns.** Review the last ${REFLECT_INTERVAL} captures mentally. What patterns do you see? Is the agent making steady progress, circling, or drifting? Are there recurring errors or inefficiencies?

2. **Write findings to the handoff file.** This is how your observations become durable—the meta-reflect sweep reads this file and applies changes to harness policy files (best-practices.json, context-injections.json, progress.json learnings).

   \`\`\`bash
   cat > /tmp/monitor_findings_${HARNESS_NAME:-unknown}.json <<'FINDINGS_EOF'
   {
     "reflected_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
     "harness": "${HARNESS_NAME:-unknown}",
     "capture_count": N,
     "patterns": [
       "Pattern 1: describe what you observed across multiple captures",
       "Pattern 2: another recurring observation"
     ],
     "proposed_learnings": [
       "Terse learning bullet for progress.json"
     ],
     "proposed_best_practices": {
       "key": "value to add/update in best-practices.json (only if warranted by 3+ observations)"
     },
     "proposed_context_injections": {
       "file_context or command_context or tool_context key": "knowledge that would have prevented observed mistakes"
     },
     "proposed_tasks": [
       {"id": "new-task-id", "description": "Undiscovered work the agent should do", "blockedBy": []}
     ],
     "summary": "One-paragraph reflection summary for the journal"
   }
   FINDINGS_EOF
   \`\`\`

   Replace N with the capture count. Only include non-empty fields. Be conservative — only propose changes backed by 3+ observations.

3. **Write the receipt file** so the daemon knows you completed the reflection:
   \`\`\`bash
   echo '{"reflected_at":"'\$(date -u +%Y-%m-%dT%H:%M:%SZ)'","capture_count":N}' > ${REFLECT_RECEIPT_FILE}
   \`\`\`
   Replace N with the capture count from the REFLECT event. If you skip this, the daemon sends REFLECT_OVERDUE reminders.

4. **Message the agent** with your key finding — one actionable insight, not a data dump:
   \`\`\`bash
   tmux send-keys -t ${STABLE_TARGET} "\$SIGNATURE META-REFLECTION: your actionable insight"
   tmux send-keys -t ${STABLE_TARGET} -H 0d
   \`\`\`
   Good messages: course corrections, learnings to apply now, priority nudges, pattern warnings.
   Bad messages: status summaries, praise, restatements of what the agent already knows.

**On REFLECT_OVERDUE events:** You got a REFLECT but didn't write the receipt file. Complete steps 2-3 above now.

**Deep Analysis (when tmux capture isn't enough):**

Your target agent's session transcript is at: \`${SESSION_JSONL_PATH}\`
POLL/IDLE events include a \`session_digest\` JSON line with turn_count, last_tool, last_error, token_trend, and minutes_since_last_assistant. Use this to detect patterns invisible in the TUI.

For deeper investigation, read the transcript directly:
\`\`\`bash
# Last 50 assistant text outputs (truncated to 200 chars each)
tail -50 ${SESSION_JSONL_PATH} | jq -r 'select(.message.role == "assistant") | .message.content[] | select(.type == "text") | .text[:200]'

# Recent tool uses with targets
tail -50 ${SESSION_JSONL_PATH} | jq -r 'select(.message.role == "assistant") | .message.content[] | select(.type == "tool_use") | "\(.name) \(.input.file_path // .input.command // .input.pattern // "" | tostring | .[:80])"'

# Token usage trend (are turns getting bigger? Smaller? Stalled?)
tail -30 ${SESSION_JSONL_PATH} | jq -r 'select(.message.usage.output_tokens > 0) | "\(.message.usage.output_tokens) output tokens"'

# Errors from tool results
tail -50 ${SESSION_JSONL_PATH} | jq -r 'select(.message.role == "user") | .message.content[] | select(.type == "tool_result" and .is_error == true) | .content[:200]'
\`\`\`

Use deep analysis when: (a) session_digest shows errors but TUI looks normal, (b) agent appears stuck but TUI shows thinking, (c) REFLECT — always check token trends for meta-reflection.

**Rules:**
- **Default to NOT nudging.** Most of the time, the agent is fine. Only nudge when clearly stuck or off-track.
- Be concise in nudges — one sentence, actionable
- Don't nudge if the agent is clearly busy and on-task (thinking, executing, reading files)
- DO nudge if: idle at prompt >5min, wrong file/feature, stuck in a loop (same error 3x), deploying without tests
- **NEVER send text nudges to a BLOCKED agent** — always Escape first
- **NEVER interrupt THINKING** unless stuck 5+ polls with no token count change
- Always sign with \$SIGNATURE: \`[from {pane} ({name})]\`
- If the agent replies, acknowledge briefly
- After Escaping a blocked agent, wait 2s before sending your nudge
- **Patience thresholds**: THINKING=5+ polls, EXECUTING=10min, IDLE=5min before first nudge
- **Report issues** — If you discover infrastructure bugs, permission problems, or recurring failures, file a report: \`bash ~/.claude-ops/bin/report-issue.sh --title "..." --severity "..." --category "..." --description "..."\`

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
    >> /tmp/harness_metrics.jsonl 2>/dev/null || true
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

# Launch cdo
tmux send-keys -t "$MONITOR_PANE" "cdo" && tmux send-keys -t "$MONITOR_PANE" -H 0d

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
tmux load-buffer "$PROMPT_FILE"
tmux paste-buffer -t "$MONITOR_PANE"
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

  # Source session reader in subshell (functions aren't inherited)
  source "$HOME/.claude-ops/lib/session-reader.sh" 2>/dev/null || true

  trap 'exit 0' TERM INT

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

    # --- Check for REFLECT_OVERDUE (receipt missing after REFLECT sent) ---
    if [ -f "$REFLECT_PENDING_FILE" ]; then
      pending_polls=$(cat "$REFLECT_PENDING_FILE" 2>/dev/null || echo 0)
      pending_polls=$((pending_polls + 1))
      if [ "$pending_polls" -ge "$REFLECT_OVERDUE_POLLS" ] && [ ! -f "$REFLECT_RECEIPT_FILE" ]; then
        send_to_monitor "REFLECT_OVERDUE" "Meta-reflection was requested $pending_polls polls ago but no receipt found at ${REFLECT_RECEIPT_FILE}. Please complete your reflection and write the receipt file."
        emit_metric "reflect_overdue" ",\"polls_waiting\":$pending_polls"
        echo "$pending_polls" > "$REFLECT_PENDING_FILE"
      elif [ -f "$REFLECT_RECEIPT_FILE" ]; then
        # Receipt found — clear pending state
        rm -f "$REFLECT_PENDING_FILE"
        emit_metric "reflect_receipt" ",\"polls_waited\":$pending_polls"
      else
        echo "$pending_polls" > "$REFLECT_PENDING_FILE"
      fi
    fi

    # --- Decide event type: REFLECT every N captures, else POLL/IDLE ---
    if [ $((capture_count % REFLECT_INTERVAL)) -eq 0 ] && [ "$capture_count" -gt 0 ]; then
      # Time for a meta-reflection
      # Build activity digest from last N entries
      activity_digest=""
      if [ -n "${HARNESS_NAME:-}" ]; then
        activity_log="/tmp/claude_activity_${HARNESS_NAME}.jsonl"
        if [ -f "$activity_log" ]; then
          activity_digest=$(tail -20 "$activity_log" 2>/dev/null | jq -r '"\(.tool): \(.target // .command // "?")"' 2>/dev/null | tail -10 || true)
        fi
      fi

      # Clear old receipt before requesting new reflection
      rm -f "$REFLECT_RECEIPT_FILE"
      echo 0 > "$REFLECT_PENDING_FILE"

      # Get rich session digest for REFLECT (more data than POLL/IDLE)
      rich_digest=$(get_session_digest_rich 2>/dev/null || true)

      reflect_context="Capture #${capture_count} — time for META-REFLECTION. TUI state: ${tui_state}."
      [ -n "$activity_digest" ] && reflect_context="${reflect_context} Recent activity:\n${activity_digest}"
      [ -n "$rich_digest" ] && reflect_context="${reflect_context}\n${rich_digest}"

      send_to_monitor "REFLECT" "$reflect_context"
      emit_metric "reflect_sent" ",\"capture_count\":$capture_count"

    elif [ "$current" = "$prev" ]; then
      idle_context="Pane ${TARGET_PANE} unchanged for ${INTERVAL}s. TUI state: ${tui_state}. Agent may be stuck."
      [ -n "$session_digest" ] && idle_context="${idle_context} session_digest: ${session_digest}"
      send_to_monitor "IDLE" "$idle_context"
      emit_metric "poll" ",\"tui_state\":\"${tui_state}\",\"changed\":false"
    else
      poll_context="Pane ${TARGET_PANE} check (${INTERVAL}s). TUI state: ${tui_state}. Capture #${capture_count}."
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
