#!/usr/bin/env bash
# harness-dispatch.sh — Unified stop hook dispatcher for multi-harness sessions.
#
# Routes each Claude session to its assigned harness based on a registry file.
# Sessions not registered in the registry fall through to stop-check.sh (general code review).
#
# Uses unified task graph schema (.tasks with blockedBy/owner) for ALL harnesses.
# Shared jq functions in harness-jq.sh.
#
# Registry: ~/.claude-ops/state/session-registry.json (via HARNESS_SESSION_REGISTRY)
#   { "session-abc": "tianding", "session-def": "chatbot-agent" }
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
# Source shared task graph functions (provides HARNESS_SESSION_REGISTRY)
source "$HOME/.claude-ops/lib/harness-jq.sh"
REGISTRY="$HARNESS_SESSION_REGISTRY"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
[ -z "$SESSION_ID" ] && { echo '{}'; exit 0; }

# Skip if echo chain is active
if [ -f "/tmp/claude_echo_state_${SESSION_ID}" ]; then
  echo '{}'
  exit 0
fi

# Escape hatch (per-session)
[ -f "/tmp/claude_allow_stop_${SESSION_ID}" ] && { echo '{}'; exit 0; }

# --- Portable file mtime (macOS + Linux) ---
_file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

# --- Find own tmux pane by walking process tree up to a pane_pid ---
# (Must be defined before first use at the OWN_PANE_ID assignment below)
find_own_pane() {
  local search_pid=$$
  local pane_map=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null)
  [ -z "$pane_map" ] && return
  while [ "$search_pid" -gt 1 ]; do
    local match=$(echo "$pane_map" | awk -v pid="$search_pid" '$1 == pid {print $2; exit}')
    [ -n "$match" ] && { echo "$match"; return; }
    search_pid=$(ps -o ppid= -p "$search_pid" 2>/dev/null | tr -d ' ')
  done
}

# --- Convert pane_id (%NNN) to human-readable target (h:3.1) ---
pane_id_to_target() {
  tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | awk -v id="$1" '$1 == id {print $2; exit}'
}

# Skip monitor sessions — they should never be registered or blocked.
# Detect by tmux pane title (set by monitor-agent.sh to "MONITOR→{target}").
OWN_PANE_ID=$(find_own_pane 2>/dev/null || echo "")
if [ -n "$OWN_PANE_ID" ]; then
  PANE_TITLE=$(tmux display-message -t "$OWN_PANE_ID" -p '#{pane_title}' 2>/dev/null || echo "")
  if [[ "$PANE_TITLE" == MONITOR* ]]; then
    # Also deregister if previously auto-registered by mistake
    if [ -f "$REGISTRY" ] && jq -e --arg sid "$SESSION_ID" 'has($sid)' "$REGISTRY" >/dev/null 2>&1; then
      locked_jq_write "$REGISTRY" "session-registry" 'del(.[$sid])' --arg sid "$SESSION_ID"
      echo "Deregistered monitor session $SESSION_ID from registry" >&2
    fi
    echo '{}'
    exit 0
  fi
fi

# --- Look up which harness this session belongs to ---
HARNESS=""
if [ -f "$REGISTRY" ]; then
  HARNESS=$(jq -r --arg sid "$SESSION_ID" '.[$sid] // ""' "$REGISTRY" 2>/dev/null || echo "")
fi

# --- Collect info about all active harnesses (for cross-harness awareness) ---
other_harnesses_info() {
  local my_harness="$1"
  local info=""
  while IFS= read -r pfile; do
    [ -f "$pfile" ] || continue
    local pstatus=$(jq -r '.status // "inactive"' "$pfile" 2>/dev/null || echo "inactive")
    [ "$pstatus" != "active" ] && continue
    local pname=$(jq -r '.harness // ""' "$pfile" 2>/dev/null)
    [ -z "$pname" ] && pname=$(basename "$pfile" | sed 's/-progress\.json//')
    [ "$pname" = "$my_harness" ] && continue
    local pcurrent=$(harness_current_task "$pfile" 2>/dev/null || echo "unknown")
    info="${info}\n  - ${pname}: working on ${pcurrent}"
  done < <(harness_all_progress_files "$PROJECT_ROOT")
  echo "$info"
}

# --- Update tmux pane border + metadata with harness status ---
update_pane_status() {
  local hname="$1" current="$2" done_count="$3" total="$4"
  local pane_id=$(find_own_pane)
  [ -z "$pane_id" ] && return
  local status_text="${hname}: ${current} (${done_count}/${total})"
  # Write display text (read by pane-border-format)
  echo "$status_text" > "/tmp/tmux_pane_status_${pane_id}"
  # Write structured metadata (read by discover_agent_panes)
  jq -n --compact-output \
    --arg harness "$hname" --arg task "$current" \
    --argjson done "$done_count" --argjson total "$total" \
    --arg display "$status_text" \
    '{harness:$harness,task:$task,done:$done,total:$total,display:$display}' \
    > "/tmp/tmux_pane_meta_${pane_id}"
  # Set pane title
  tmux select-pane -t "$pane_id" -T "$status_text" 2>/dev/null || true
}

# --- Discover other Claude Code sessions across tmux panes ---
discover_agent_panes() {
  local my_session="$1"
  local my_pane_id="${OWN_PANE_ID:-}"
  local agents="" count=0

  while IFS=$'\t' read -r ptarget ppid pane_id; do
    # Skip self by pane_id (reliable, not dependent on screen content)
    [ -n "$my_pane_id" ] && [ "$pane_id" = "$my_pane_id" ] && continue

    # Check children for claude process
    local is_claude=false
    for cpid in $(pgrep -P "$ppid" 2>/dev/null | head -5); do
      ps -o command= -p "$cpid" 2>/dev/null | grep -q "^claude " && is_claude=true && break
    done
    $is_claude || continue

    # Quick snapshot (last 8 non-empty lines) — use stable pane_id, not fragile index
    local snap=$(tmux capture-pane -t "$pane_id" -p 2>/dev/null | grep -v '^[[:space:]]*$' | tail -8)

    # Parse model from status bar
    local model=$(echo "$snap" | grep -oE '⚙️ [A-Za-z0-9. ]+' | tail -1 | sed 's/⚙️ //')
    # Detect busy vs idle
    local state="idle"
    echo "$snap" | grep -qE '(Thinking|Herding|Discombobulating|Processing|Reasoning|thought for)' && state="busy"
    # Read structured metadata (harness status + session info)
    local task="" session_name=""
    if [ -f "/tmp/tmux_pane_meta_${pane_id}" ]; then
      task=$(jq -r '.display // ""' "/tmp/tmux_pane_meta_${pane_id}" 2>/dev/null || echo "")
    else
      task=$(cat "/tmp/tmux_pane_status_${pane_id}" 2>/dev/null || echo "")
    fi
    # Check for session name/summary (written by session_namer.sh)
    if [ -f "/tmp/tmux_pane_session_${pane_id}" ]; then
      session_name=$(jq -r '"[\(.name)]" + (if .summary != "" then " " + .summary else "" end)' "/tmp/tmux_pane_session_${pane_id}" 2>/dev/null || echo "")
    fi

    local detail="${task:-no status}"
    [ -n "$session_name" ] && detail="${detail} ${session_name}"
    agents="${agents}\n  - ${ptarget} [${model:-?}] (${state}) ${detail}"
    count=$((count + 1))
  done < <(tmux list-panes -a -F $'#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_id}' 2>/dev/null)

  [ "$count" -eq 0 ] && return

  local my_pane_id=$(find_own_pane 2>/dev/null || echo "")
  local my_pane=$(pane_id_to_target "$my_pane_id" 2>/dev/null || echo "?")
  local my_name=""
  [ -n "$my_pane_id" ] && my_name=$(jq -r '.harness // empty' "/tmp/tmux_pane_meta_${my_pane_id}" 2>/dev/null || true)
  [ -z "$my_name" ] && [ -n "$my_pane_id" ] && my_name=$(jq -r '.name // empty' "/tmp/tmux_pane_session_${my_pane_id}" 2>/dev/null || true)
  local my_sig="${my_pane}${my_name:+ (${my_name})}"
  echo "**Nearby agents (${count}):** (you are ${my_sig})${agents}"
  echo "Send: \`tmux send-keys -t {pane} \"[from ${my_sig}] msg\" && tmux send-keys -t {pane} -H 0d\`"
  echo "Read: \`tmux capture-pane -t {pane} -p | tail -20\`"
  echo "If you receive a message from another agent, ALWAYS reply back (sign with [from ${my_sig}])."
}

# --- GC stale tmp files (throttled: at most once per 5 min) ---
_GC_STAMP="$HARNESS_STATE_DIR/.last_tmp_gc"
_GC_NOW=$(date +%s)
_GC_LAST=0
[ -f "$_GC_STAMP" ] && _GC_LAST=$(cat "$_GC_STAMP" 2>/dev/null || echo 0)
if [ $((_GC_NOW - _GC_LAST)) -gt 60 ]; then
  echo "$_GC_NOW" > "$_GC_STAMP"
  # Bug 3: Dead session cleanup — remove registry entries for harnesses with no live Claude
  # Uses pane metadata (written by stop hooks) as liveness signal, not screen scraping.
  if [ -f "$REGISTRY" ]; then
    _LIVE_HARNESSES=""
    while IFS=$'\t' read -r _pt _ppid _pid; do
      _has_claude=false
      for _cpid in $(pgrep -P "$_ppid" 2>/dev/null | head -5); do
        ps -o command= -p "$_cpid" 2>/dev/null | grep -q "^claude " && _has_claude=true && break
      done
      $_has_claude || continue
      # Read harness name from pane metadata (reliable, not dependent on scroll position)
      if [ -f "/tmp/tmux_pane_meta_${_pid}" ]; then
        _ph=$(jq -r '.harness // empty' "/tmp/tmux_pane_meta_${_pid}" 2>/dev/null || true)
        [ -n "$_ph" ] && _LIVE_HARNESSES="${_LIVE_HARNESSES} $_ph"
      fi
    done < <(tmux list-panes -a -F $'#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_id}' 2>/dev/null)
    # Remove sessions whose harness has no live pane
    _DEAD=$(jq -r --arg live "$_LIVE_HARNESSES" '
      ($live | split(" ") | map(select(. != ""))) as $live_h |
      [to_entries[] | select(.value as $h | $live_h | index($h) | not) | .key] | join(" ")
    ' "$REGISTRY" 2>/dev/null || echo "")
    for _dsid in $_DEAD; do
      locked_jq_write "$REGISTRY" "session-registry" 'del(.[$sid])' --arg sid "$_dsid"
      echo "GC: removed dead session $_dsid from registry" >&2
    done
  fi
  # Bug 4+5: Clean stale tmp files (>1 hour old)
  for _pattern in /tmp/claude_harness_rotate_* /tmp/claude_allow_stop_* /tmp/claude_harness_pending_*; do
    for _f in $_pattern; do
      [ -f "$_f" ] || continue
      _age=$(( _GC_NOW - $(_file_mtime "$_f" 2>/dev/null || echo "$_GC_NOW") ))
      [ "$_age" -gt 3600 ] && rm -f "$_f" && echo "GC: removed stale $(basename "$_f") (${_age}s old)" >&2
    done
  done
fi

# ═══════════════════════════════════════════════════════════════
# ROTATION: Context-aware session rotation
# ═══════════════════════════════════════════════════════════════
# Called at the top of block_generic. If thresholds exceeded,
# triggers handoff.sh --rotate and lets the current session exit cleanly.
# Returns 0 (should exit) or 1 (continue blocking normally).
check_rotation() {
  local HARNESS_NAME="$1"  # dispatch name
  local PROGRESS="$2"       # progress.json path
  local CANONICAL="$3"      # canonical name for seed script lookup

  local MODE=$(jq -r '.rotation.mode // "new_session"' "$PROGRESS" 2>/dev/null)
  [ "$MODE" = "none" ] && return 1

  local MAX_ROUNDS=$(jq -r '.rotation.max_rounds // 20' "$PROGRESS" 2>/dev/null)
  local MAX_FEATURES=$(jq -r '.rotation.max_features_per_session // 3' "$PROGRESS" 2>/dev/null)
  local ROUND_COUNT=$(jq -r '.current_session.round_count // 0' "$PROGRESS" 2>/dev/null)
  local FEATURES_DONE=$(jq -r '.current_session.tasks_completed // (.current_session.features_completed // 0)' "$PROGRESS" 2>/dev/null)

  local SHOULD_ROTATE=0

  # ── Primary: Monitor decision (K8s operator-driven scaling) ──
  # The monitor writes a rotation advisory that takes precedence over thresholds.
  # File: /tmp/claude_rotation_advisory_{harness}
  # Format: {"should_rotate": bool, "reason": "...", "decided_at": "ISO"}
  local ADVISORY="/tmp/claude_rotation_advisory_${CANONICAL}"
  if [ -f "$ADVISORY" ]; then
    local MONITOR_DECISION=$(jq -r '.should_rotate // false' "$ADVISORY" 2>/dev/null || echo "false")
    local MONITOR_REASON=$(jq -r '.reason // "monitor decided"' "$ADVISORY" 2>/dev/null || echo "")
    if [ "$MONITOR_DECISION" = "true" ]; then
      SHOULD_ROTATE=1
      echo "Rotation: monitor advisory — $MONITOR_REASON" >&2
      rm -f "$ADVISORY"  # consume the advisory
    elif [ "$MONITOR_DECISION" = "false" ]; then
      # Monitor explicitly says don't rotate — override thresholds
      echo "Rotation: monitor says hold — $MONITOR_REASON" >&2
      rm -f "$ADVISORY"  # consume
      # Still increment round counter
      locked_jq_write "$PROGRESS" "progress-$CANONICAL" \
        '.current_session.round_count = ((.current_session.round_count // 0) + 1)'
      return 1
    fi
  fi

  # ── Fallback: Algorithmic thresholds (only if no monitor advisory) ──
  if [ "$SHOULD_ROTATE" -eq 0 ]; then
    [ "$ROUND_COUNT" -ge "$MAX_ROUNDS" ] && SHOULD_ROTATE=1
    [ "$FEATURES_DONE" -ge "$MAX_FEATURES" ] && SHOULD_ROTATE=1
  fi

  if [ "$SHOULD_ROTATE" -eq 1 ]; then
    # Atomic rotation guard: only one stop hook can trigger handoff for a session.
    # mkdir is atomic—first caller wins, others skip.
    local ROTATE_LOCK="/tmp/claude_rotate_lock_${SESSION_ID}"
    if ! mkdir "$ROTATE_LOCK" 2>/dev/null; then
      echo "Rotation already in progress for $SESSION_ID — skipping" >&2
      echo '{}'
      exit 0
    fi
    touch "/tmp/claude_allow_stop_${SESSION_ID}"
    echo "{\"harness\":\"$CANONICAL\",\"session_id\":\"$SESSION_ID\"}" \
      > "/tmp/claude_harness_rotate_${SESSION_ID}"
    bash "$HOME/.claude-ops/lib/handoff.sh" --rotate "$SESSION_ID" &
    # Clean up lock after handoff daemon starts (background, short-lived)
    ( sleep 60; rmdir "$ROTATE_LOCK" 2>/dev/null || true ) &
    echo '{}'
    exit 0
  fi

  # Not rotating — increment round counter
  locked_jq_write "$PROGRESS" "progress-$CANONICAL" \
    '.current_session.round_count = ((.current_session.round_count // 0) + 1)'
  return 1
}

# ═══════════════════════════════════════════════════════════════
# GENERIC BLOCK — works for ALL harnesses using unified task graph
# ═══════════════════════════════════════════════════════════════
block_generic() {
  local PROGRESS="$1"
  [ ! -f "$PROGRESS" ] && { echo '{}'; exit 0; }

  local STATUS=$(jq -r '.status // "inactive"' "$PROGRESS")
  [ "$STATUS" != "active" ] && { echo '{}'; exit 0; }

  # Read harness identity from the file
  local HNAME=$(harness_name "$PROGRESS")
  local CANONICAL="$HNAME"

  check_rotation "$HNAME" "$PROGRESS" "$CANONICAL" && exit 0 || true

  # Compute task graph state
  local CURRENT=$(harness_current_task "$PROGRESS")
  local NEXT=$(harness_next_task "$PROGRESS")
  local DONE_COUNT=$(harness_done_count "$PROGRESS")
  local TOTAL=$(harness_total_count "$PROGRESS")
  local DESCRIPTION=$(harness_task_description "$PROGRESS" "$CURRENT")
  local MISSION=$(harness_mission "$PROGRESS")

  # Update tmux pane border with current status
  update_pane_status "$HNAME" "$CURRENT" "$DONE_COUNT" "$TOTAL"

  # ── Resolve harness.md path and extract mission vision ──
  local HARNESS_MD=""
  if [ -f "$PROJECT_ROOT/.claude/harness/$CANONICAL/harness.md" ]; then
    HARNESS_MD="$PROJECT_ROOT/.claude/harness/$CANONICAL/harness.md"
  elif [ -f "$PROJECT_ROOT/claude_files/${CANONICAL}-harness.md" ]; then
    HARNESS_MD="$PROJECT_ROOT/claude_files/${CANONICAL}-harness.md"
  fi

  local MISSION_VISION=""
  if [ -n "$HARNESS_MD" ] && [ -f "$HARNESS_MD" ]; then
    MISSION_VISION=$(sed -n '/^## The World We Want$/,/^## /{/^## The World We Want$/d;/^## /d;p;}' "$HARNESS_MD" 2>/dev/null | sed '/^[[:space:]]*$/d' | head -20)
  fi

  # ── Detect spec file (optional) ──
  local SPEC_FILE=""
  if [ -f "$PROJECT_ROOT/.claude/harness/$CANONICAL/spec.md" ]; then
    SPEC_FILE=".claude/harness/$CANONICAL/spec.md"
  elif [ -f "$PROJECT_ROOT/claude_files/${CANONICAL}-spec.md" ]; then
    SPEC_FILE="claude_files/${CANONICAL}-spec.md"
  fi

  # ── Phase 0 gate: Sketch must be approved before implementation ──
  local SKETCH_APPROVED=$(jq -r '.sketch_approved // false' "$PROGRESS" 2>/dev/null || echo "false")
  if [ "$SKETCH_APPROVED" != "true" ] && [ "$DONE_COUNT" -eq 0 ]; then
    local SKETCH_MSG="## ${HNAME}: Phase 0 — Sketch Required\n\n"
    SKETCH_MSG="${SKETCH_MSG}**Mission:** ${MISSION}\n\n"
    if [ -n "$MISSION_VISION" ]; then
      SKETCH_MSG="${SKETCH_MSG}**The World We Want:**\n${MISSION_VISION}\n\n"
    fi
    SKETCH_MSG="${SKETCH_MSG}You must create and get approval for an HTML sketch before implementing anything.\n"
    SKETCH_MSG="${SKETCH_MSG}Follow the Phase 0 instructions from your seed prompt. Key steps:\n"
    SKETCH_MSG="${SKETCH_MSG}1. Create \`claude_files/${CANONICAL}-vision.html\`\n"
    SKETCH_MSG="${SKETCH_MSG}2. Open it for review: \`open claude_files/${CANONICAL}-vision.html\`\n"
    SKETCH_MSG="${SKETCH_MSG}3. Wait for user approval, then set \`\"sketch_approved\": true\`\n\n"
    SKETCH_MSG="${SKETCH_MSG}Escape: touch /tmp/claude_allow_stop_${SESSION_ID}"

    python3 -c "
import json, sys
msg = sys.argv[1]
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$(echo -e "$SKETCH_MSG")"
    exit 0
  fi

  # ── Phase 0.5 gate: Generalizations must be approved before implementation ──
  local GEN_APPROVED=$(jq -r '.generalization_approved // false' "$PROGRESS" 2>/dev/null || echo "false")
  if [ "$SKETCH_APPROVED" = "true" ] && [ "$GEN_APPROVED" != "true" ] && [ "$DONE_COUNT" -eq 0 ]; then
    local GEN_FILE="$PROJECT_ROOT/claude_files/${CANONICAL}-generalizations.md"
    local GEN_MSG="## ${HNAME}: Phase 0.5 — Generalizations Required\n\n"
    GEN_MSG="${GEN_MSG}**Mission:** ${MISSION}\n\n"
    GEN_MSG="${GEN_MSG}Your sketch is approved. Before implementing, propose 3-5 improvements beyond\n"
    GEN_MSG="${GEN_MSG}the seed waypoints. Follow the Phase 0.5 instructions from your seed prompt.\n"
    if [ ! -f "$GEN_FILE" ]; then
      GEN_MSG="${GEN_MSG}1. Write to \`claude_files/${CANONICAL}-generalizations.md\`\n"
      GEN_MSG="${GEN_MSG}2. Open for review + notify Warren\n"
      GEN_MSG="${GEN_MSG}3. Wait for approval, then set \`\"generalization_approved\": true\`\n"
    else
      GEN_MSG="${GEN_MSG}File exists: \`claude_files/${CANONICAL}-generalizations.md\`\n"
      GEN_MSG="${GEN_MSG}Awaiting user approval. Revise if they give feedback.\n"
      GEN_MSG="${GEN_MSG}Once approved: add tasks to progress.json, set \`\"generalization_approved\": true\`\n"
    fi
    GEN_MSG="${GEN_MSG}\nEscape: touch /tmp/claude_allow_stop_${SESSION_ID}"

    python3 -c "
import json, sys
msg = sys.argv[1]
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$(echo -e "$GEN_MSG")"
    exit 0
  fi

  # ── Verification readiness check (K8s ReadinessProbe) ──
  # If the current task was just marked completed, run readiness gate
  local READINESS_WARN=""
  if [ -f "$HOME/.claude-ops/hooks/admission/task-readiness.sh" ]; then
    # Check ALL completed tasks without artifacts (not just current)
    for task_id in $(jq -r '.tasks | to_entries[] | select(.value.status == "completed" and .value.metadata.needs_e2e_verification == true and (.value.metadata.test_evidence == null or .value.metadata.test_evidence == "")) | .key' "$PROGRESS" 2>/dev/null); do
      local check_result=$(PROJECT_ROOT="$PROJECT_ROOT" HARNESS="$HNAME" bash "$HOME/.claude-ops/hooks/admission/task-readiness.sh" "$task_id" 2>/dev/null || true)
      [ -n "$check_result" ] && READINESS_WARN="${READINESS_WARN}\n${check_result}"
    done
  fi

  # ── Verification progress summary ──
  local VERIFIED_COUNT=0 NEEDS_VERIFY=0
  VERIFIED_COUNT=$(jq '[.tasks | to_entries[] | select(.value.metadata.test_evidence != null and .value.metadata.test_evidence != "")] | length' "$PROGRESS" 2>/dev/null || echo "0")
  NEEDS_VERIFY=$(jq '[.tasks | to_entries[] | select(.value.metadata.needs_e2e_verification == true and (.value.metadata.test_evidence == null or .value.metadata.test_evidence == ""))] | length' "$PROGRESS" 2>/dev/null || echo "0")

  local MSG="## ${HNAME}: ${DONE_COUNT}/${TOTAL} tasks complete"
  [ "$VERIFIED_COUNT" -gt 0 ] && MSG="${MSG} (${VERIFIED_COUNT} verified)"
  MSG="${MSG}.\n\n"
  [ "$NEEDS_VERIFY" -gt 0 ] && MSG="${MSG}**Awaiting verification:** ${NEEDS_VERIFY} tasks need e2e proof.\n"
  [ -n "$READINESS_WARN" ] && MSG="${MSG}\n${READINESS_WARN}\n"
  [ -n "$MISSION" ] && MSG="${MSG}**Mission:** ${MISSION}\n"
  if [ -n "$MISSION_VISION" ]; then
    MSG="${MSG}\n**The World We Want:**\n${MISSION_VISION}\n"
  fi
  MSG="${MSG}**Current:** ${CURRENT}\n"
  [ -n "$DESCRIPTION" ] && MSG="${MSG}**Description:** ${DESCRIPTION}\n"
  MSG="${MSG}**Next:** ${NEXT}\n"

  # Show what completing current task would unblock
  if [ "$CURRENT" != "ALL_DONE" ]; then
    local WOULD_UNBLOCK=$(harness_would_unblock "$PROGRESS" "$CURRENT" 2>/dev/null || echo "")
    [ -n "$WOULD_UNBLOCK" ] && MSG="${MSG}**Completing ${CURRENT} unblocks:** ${WOULD_UNBLOCK}\n"
  fi

  # Wave progress (if waves defined)
  local WAVE_INFO=$(harness_wave_progress "$PROGRESS" 2>/dev/null || echo "")
  [ -n "$WAVE_INFO" ] && MSG="${MSG}**Wave:** ${WAVE_INFO}\n"

  # ── Wave boundary + gate enforcement (consolidated) ──
  local WAVE_BOUNDARY=$(harness_is_wave_boundary "$PROGRESS" 2>/dev/null || echo "false")
  local ACTIONABLE_GATE=""
  ACTIONABLE_GATE=$(jq -r '
    . as $root |
    [.tasks | to_entries[] | select(
      .value.status == "pending" and
      (.value.metadata.wave_gate == true) and
      ((.value.blockedBy // []) as $deps |
       if ($deps | length) == 0 then true
       else [$deps[] as $dep | ($root.tasks[$dep].status // "missing")] | all(. == "completed")
       end)
    ) | .key] | first // ""
  ' "$PROGRESS" 2>/dev/null || echo "")

  if [ "$WAVE_BOUNDARY" = "true" ] || [ -n "$ACTIONABLE_GATE" ]; then
    # Resolve wave number from whichever source is available
    local WAVE_NUM="?" WAVE_NAME="" REPORT_PATH=""
    if [ -n "$ACTIONABLE_GATE" ]; then
      WAVE_NUM=$(jq -r --arg g "$ACTIONABLE_GATE" '.tasks[$g].metadata.wave_number // "?"' "$PROGRESS" 2>/dev/null || echo "?")
      WAVE_NAME=$(jq -r --arg g "$ACTIONABLE_GATE" '.tasks[$g].metadata.wave_name // ""' "$PROGRESS" 2>/dev/null || echo "")
    elif [ "$WAVE_BOUNDARY" = "true" ]; then
      local WAVE_JSON=$(harness_current_wave "$PROGRESS" 2>/dev/null || echo "null")
      WAVE_NUM=$(echo "$WAVE_JSON" | jq -r '.id // "?"' 2>/dev/null || echo "?")
    fi
    REPORT_PATH=$(harness_wave_report_path "$PROGRESS" "$WAVE_NUM" 2>/dev/null || echo "")

    MSG="${MSG}\n**WAVE ${WAVE_NUM} COMPLETE**${WAVE_NAME:+ (${WAVE_NAME})}\n"
    [ -n "$SPEC_FILE" ] && MSG="${MSG}**Spec check**: Re-read \`${SPEC_FILE}\` — did you miss anything? Document deviations.\n"
    MSG="${MSG}1. Re-read the mission. Does each task result serve it?\n"
    MSG="${MSG}2. Commit: \`feat(${HNAME}): wave ${WAVE_NUM} — <name>\`\n"
    MSG="${MSG}3. Deploy + inspect via Chrome + take screenshots\n"
    MSG="${MSG}4. Generate report: \`${REPORT_PATH:-~/.claude-ops/harness/reports/${HNAME}/wave-${WAVE_NUM}.html}\`\n"
    MSG="${MSG}5. Open + notify Warren, wait for confirmation\n"
    [ -n "$ACTIONABLE_GATE" ] && MSG="${MSG}6. Mark gate \`${ACTIONABLE_GATE}\` completed in progress.json\n"

    # Hard gate: block if report missing or lacks Mission Alignment
    if [ -n "$REPORT_PATH" ] && [ ! -f "$REPORT_PATH" ]; then
      MSG="${MSG}\n**WAVE GATE**: No report found at ${REPORT_PATH}.\n"
      MSG="${MSG}Report MUST include Mission Alignment + Gap Analysis. Cannot proceed without it.\n"
    elif [ -n "$REPORT_PATH" ] && [ -f "$REPORT_PATH" ]; then
      if ! grep -qi "mission alignment\|mission.alignment" "$REPORT_PATH" 2>/dev/null; then
        MSG="${MSG}\n**WAVE GATE**: Report missing Mission Alignment section.\n"
      fi
    fi
  fi

  # ── Phase 2: Seed tasks done but mission continues ──
  if [ "$CURRENT" = "ALL_DONE" ]; then
    local HAS_MISSION_COMPLETE=$(jq -r '
      [(.learnings // [])[] | select(. | test("mission.complete"; "i"))] | length
    ' "$PROGRESS" 2>/dev/null || echo "0")

    if [ "$HAS_MISSION_COMPLETE" -eq 0 ]; then
      MSG="${MSG}\n---\n## Phase 2: Seed Tasks Complete — The Real Work Begins\n\n"
      MSG="${MSG}All seed waypoints done. Follow Phase 2 from your seed prompt:\n"
      MSG="${MSG}1. Re-read the mission (scroll up, or re-read harness.md if context was compacted)\n"
      MSG="${MSG}2. Experience the system as a user\n"
      MSG="${MSG}3. Find at least 3 gaps, create a new wave\n"
      MSG="${MSG}4. Do NOT stop. The mission is the target, not the task list.\n"
    else
      MSG="${MSG}\n---\n"
      MSG="${MSG}**Mission verified.** You wrote a mission-complete learnings entry.\n"
      MSG="${MSG}Set status to \"done\" if the world matches the vision, or keep going.\n"
    fi
  fi

  # Show blocked tasks and their specific blockers
  local BLOCKED_INFO=$(jq -r '
    . as $root |
    [.tasks | to_entries[] | select(
      .value.status == "pending" and
      ((.value.blockedBy // []) | length) > 0 and
      ([(.value.blockedBy // [])[] as $dep | $root.tasks[$dep].status] | all(. == "completed") | not)
    ) |
      (.value.blockedBy // []) as $deps |
      [($deps[] | select($root.tasks[.].status != "completed"))] as $incomplete |
      "  \(.key) ← waiting on: \($incomplete | join(", "))"
    ] | if length > 0 then join("\n") else "" end
  ' "$PROGRESS" 2>/dev/null || echo "")
  [ -n "$BLOCKED_INFO" ] && MSG="${MSG}\n**Blocked tasks:**\n${BLOCKED_INFO}\n"

  # Swarm state (if present)
  local HAS_STATE=$(jq 'has("state")' "$PROGRESS" 2>/dev/null || echo "false")
  if [ "$HAS_STATE" = "true" ]; then
    # Swarm mode info
    local SWARM_MODE=$(jq -r '.state.mode // empty' "$PROGRESS" 2>/dev/null || true)
    if [ -n "$SWARM_MODE" ]; then
      local CYCLE=$(jq -r '.state.cycle_count // 0' "$PROGRESS" 2>/dev/null)
      local PHASE=$(jq -r '.state.current_phase // "test"' "$PROGRESS" 2>/dev/null)
      MSG="${MSG}\n**Swarm:** mode=${SWARM_MODE} | cycle=${CYCLE} | phase=${PHASE}\n"

      # Pass rate trend
      local RATE_TREND=$(jq -r '
        if (.state.pass_rate_history // [] | length) > 0 then
          .state.pass_rate_history | map("\(.rate)%") | join(" → ")
        else "no data" end' "$PROGRESS" 2>/dev/null)
      MSG="${MSG}**Pass rate:** ${RATE_TREND}\n"

      # Current cycle
      local CYC_FAILURES=$(jq -r '.state.current_cycle.failures | length // 0' "$PROGRESS" 2>/dev/null || echo "0")
      local CYC_FIXES=$(jq -r '.state.current_cycle.fixes_applied | length // 0' "$PROGRESS" 2>/dev/null || echo "0")
      local DEPLOY_STATUS=$(jq -r '.state.current_cycle.deploy_status // "pending"' "$PROGRESS" 2>/dev/null || echo "pending")
      MSG="${MSG}**Cycle:** ${CYC_FAILURES} failures, ${CYC_FIXES} fixes, deploy: ${DEPLOY_STATUS}\n"

      # Active agents
      local AGENTS_INFO=$(jq -r '
        if (.state.active_agents // [] | length) > 0 then
          .state.active_agents[] | "  \(.type): \(.description) [\(.status)]"
        else empty end' "$PROGRESS" 2>/dev/null || echo "")
      [ -n "$AGENTS_INFO" ] && MSG="${MSG}\n**Active agents:**\n${AGENTS_INFO}\n"

      # Pending merges
      local MERGES=$(jq -r '(.state.pending_merges // []) | if length > 0 then join(", ") else empty end' "$PROGRESS" 2>/dev/null || true)
      [ -n "$MERGES" ] && MSG="${MSG}**Pending merges:** ${MERGES}\n"
    fi
  fi

  MSG="${MSG}\nRead claude_files/${CANONICAL}-harness.md if context lost.\n"
  MSG="${MSG}Escape: touch /tmp/claude_allow_stop_${SESSION_ID}"

  # File overlaps (beads: cross-harness awareness)
  source "$HOME/.claude-ops/lib/beads.sh" 2>/dev/null || true
  if bead_is_enabled && [ "$BEAD_LAYER_STOP" = "true" ]; then
    local OVERLAPS=$(bead_cross_harness_overlaps "$HNAME" 2>/dev/null || true)
    if [ -n "$OVERLAPS" ]; then
      local _window_min=$(( BEAD_CONFLICT_WINDOW_SEC / 60 ))
      MSG="${MSG}\n**File overlaps (last ${_window_min}m):**\n${OVERLAPS}\n"
    fi
  fi

  # Other harnesses
  local OTHERS=$(other_harnesses_info "$HNAME")
  [ -n "$OTHERS" ] && MSG="${MSG}\n**Other active harnesses:**${OTHERS}\n"

  # Nearby Claude agents
  local AGENTS=$(discover_agent_panes "$SESSION_ID")
  [ -n "$AGENTS" ] && MSG="${MSG}\n${AGENTS}\n"

  # Control plane health status
  if [ -f "/tmp/harness_health.json" ]; then
    local MY_HEALTH=$(jq -r --arg h "$HNAME" '
      .harnesses[$h] // empty |
      if . then
        "worker=\(.worker.status // "unknown") monitor=\(.monitor.status // "unknown") restarts=\(.worker.restarts // 0)"
      else empty end
    ' /tmp/harness_health.json 2>/dev/null || echo "")
    [ -n "$MY_HEALTH" ] && MSG="${MSG}\n**Health:** ${MY_HEALTH}\n"
  fi

  # Emit status metric to control plane
  local ts_now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","type":"harness_status","harness":"%s","done":%s,"total":%s,"current":"%s"}\n' \
    "$ts_now" "$HNAME" "$DONE_COUNT" "$TOTAL" "$CURRENT" \
    >> /tmp/harness_metrics.jsonl 2>/dev/null || true

  python3 -c "
import json, sys
msg = sys.argv[1]
print(json.dumps({'decision': 'block', 'reason': msg}))
" "$(echo -e "$MSG")"
}

# ═══════════════════════════════════════════════════════════════
# PROGRESS FILE RESOLUTION
# ═══════════════════════════════════════════════════════════════
# Maps harness dispatch names to progress file paths.
# With the unified schema, each progress file has .harness field,
# so we can also discover by scanning.
resolve_progress_file() {
  local dispatch_name="$1"

  # Priority 1: manifest registry (canonical, auto-discovered)
  local manifest_path
  manifest_path=$(harness_progress_path "$dispatch_name" 2>/dev/null || echo "")
  if [ -n "$manifest_path" ] && [ -f "$manifest_path" ]; then
    echo "$manifest_path"
    return
  fi

  # Priority 2: hardcoded aliases (for harnesses with non-standard naming)
  case "$dispatch_name" in
    tianding|tianding-miniapp)
      echo "$PROJECT_ROOT/claude_files/tianding-miniapp-progress.json" ;;
    uifix|service-miniapp)
      echo "$PROJECT_ROOT/miniapps/service-miniapp/claude_files/uifix-progress.json" ;;
    chatbot-agent|chatbot-swarm)
      echo "$PROJECT_ROOT/claude_files/chatbot-agent-progress.json" ;;
    *)
      # Priority 3: convention — check new location first, then legacy
      if [ -f "$PROJECT_ROOT/.claude/harness/${dispatch_name}/progress.json" ]; then
        echo "$PROJECT_ROOT/.claude/harness/${dispatch_name}/progress.json"
      else
        echo "$PROJECT_ROOT/claude_files/${dispatch_name}-progress.json"
      fi ;;
  esac
}

# ═══════════════════════════════════════════════════════════════
# DISPATCH
# ═══════════════════════════════════════════════════════════════
case "$HARNESS" in
  "")
    # Check for pending rotation registration — only if this session's PANE
    # matches the pane recorded in the pending file (prevents wrong-session grabs).
    if [ -n "$OWN_PANE_ID" ]; then
      for pending_file in /tmp/claude_harness_pending_*; do
        [ -f "$pending_file" ] || continue
        # Format: line 1 = harness name, line 2 = target pane_id (optional, new format)
        PENDING_HARNESS=$(head -1 "$pending_file")
        PENDING_PANE=$(sed -n '2p' "$pending_file")
        # Only consume if pane matches (new format) or file is old format AND this is the only candidate
        if [ -n "$PENDING_PANE" ] && [ "$PENDING_PANE" = "$OWN_PANE_ID" ]; then
          # Atomic claim: mv fails if another process already consumed this file
          CLAIMED="/tmp/claude_harness_claimed_${SESSION_ID}"
          if ! mv "$pending_file" "$CLAIMED" 2>/dev/null; then
            continue  # Another session already claimed it
          fi
          locked_jq_write "$REGISTRY" "session-registry" '.[$sid] = $h' --arg sid "$SESSION_ID" --arg h "$PENDING_HARNESS"
          rm -f "$CLAIMED"
          echo "Rotation-registered session $SESSION_ID → $PENDING_HARNESS (pane $OWN_PANE_ID)" >&2
          PFILE=$(resolve_progress_file "$PENDING_HARNESS")
          block_generic "$PFILE"
          exit 0
        fi
        # Old format (no pane line) — expire after 5 min to avoid stale grabs
        if [ -z "$PENDING_PANE" ]; then
          FILE_AGE=$(( $(date +%s) - $(_file_mtime "$pending_file" 2>/dev/null || echo 0) ))
          if [ "$FILE_AGE" -gt 300 ]; then
            rm -f "$pending_file"
            echo "Expired stale pending file for $PENDING_HARNESS (${FILE_AGE}s old)" >&2
          fi
        fi
      done
    fi

    # No harness assigned — fall through to general stop-check.
    # (Removed auto-registration: it grabbed unrelated sessions.)
    echo "$INPUT" | bash "$HOME/.claude-ops/hooks/stop-check.sh"
    ;;
  none|skip)
    # Explicitly opted out of harness — fall through to general stop-check
    echo "$INPUT" | bash "$HOME/.claude-ops/hooks/stop-check.sh"
    ;;
  *)
    # Route any harness name to block_generic via progress file resolution
    PFILE=$(resolve_progress_file "$HARNESS")
    if [ -f "$PFILE" ]; then
      block_generic "$PFILE"
    else
      echo "WARNING: No progress file for harness '$HARNESS' at $PFILE" >&2
      echo '{}'
    fi
    ;;
esac
