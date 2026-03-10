#!/usr/bin/env bash
# stop-session.sh — Unified session-end gate hook.
#
# Merges two hooks into one sequential pipeline:
#   Phase A: Session naming state machine (from global-stop.sh)
#     - 3-phase: ask -> collect -> cooldown
#     - Auto-names harness-registered sessions from pane-registry
#     - Git commit check + memory/learnings check
#     - sessions.jsonl audit trail
#   Phase B: Code review checklist (from stop-check.sh)
#     - Reads .claude/repo-context.xml for checklist/stop-prompts/sensitive-paths
#     - Session-aware baseline (avoids false positives on pre-existing dirty state)
#     - Change categorization: TSX, CSS, test, frontend, backend, config, ontology, sensitive
#     - Deploy detection, sensitive path escalation, blast radius
#
# Integration order:
#   1. Run session naming state machine. If it blocks -> return block.
#   2. Run code review checklist. If it finds issues -> return block.
#   3. If everything passes, publish session-end event and return {}.
#
# This is a Gate hook: returns {"decision":"block","reason":"..."} or {}.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "$HOME/.claude-ops/lib/pane-resolve.sh"

HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
STOP_CHECK_BLAST_RADIUS_THRESHOLD="${STOP_CHECK_BLAST_RADIUS_THRESHOLD:-10}"
HARNESS_XML="$PROJECT_ROOT/.claude/repo-context.xml"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
# Parse subagent identity (available via hook_parse_input from fleet-jq.sh)
_HOOK_AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
_HOOK_AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null || echo "")

[ -z "$SESSION_ID" ] && { echo '{}'; exit 0; }

# Compute session dir once
_SESSION_DIR=$(harness_session_dir "$SESSION_ID" 2>/dev/null || echo "$HARNESS_STATE_DIR/sessions/$SESSION_ID")
mkdir -p "$_SESSION_DIR" 2>/dev/null

# Record session start timestamp if not already recorded (for MEMORY.md change detection)
_SESSION_START_TS_FILE="$_SESSION_DIR/session-start-ts"
[ ! -f "$_SESSION_START_TS_FILE" ] && date +%s > "$_SESSION_START_TS_FILE" 2>/dev/null || true

# Skip if echo chain is active
if [ -f "$_SESSION_DIR/echo-state.json" ]; then
  echo '{}'
  exit 0
fi

# Project from cwd
if [ -n "$CWD" ]; then
  PROJECT=$(basename "$CWD")
else
  PROJECT="_unknown"
fi

TOOL_LOG="$HOME/.claude/tool-logs/$PROJECT/tools.jsonl"
SESSIONS_LOG="$HOME/.claude/tool-logs/$PROJECT/sessions.jsonl"

# ═══════════════════════════════════════════════════════════════
# PHASE A: SESSION NAMING STATE MACHINE
# ═══════════════════════════════════════════════════════════════

ASKED_FLAG="$_SESSION_DIR/session-asked"
NAME_FILE="$_SESSION_DIR/session-name.json"
COOLDOWN_FLAG="$_SESSION_DIR/named-marker"

# Cleanup stale session dirs older than 24 hours
find "$HARNESS_STATE_DIR/sessions" -name "session-asked" -mmin +1440 -delete 2>/dev/null || true
find "$HARNESS_STATE_DIR/sessions" -name "session-name.json" -mmin +1440 -delete 2>/dev/null || true
find "$HARNESS_STATE_DIR/sessions" -name "named-marker" -mmin +1440 -delete 2>/dev/null || true

# Cooldown: skip naming if named less than 10 minutes ago
NAMING_COOLDOWN=false
if [ -f "$COOLDOWN_FLAG" ]; then
  COOLDOWN_AGE=$(( $(date +%s) - $(stat -f %m "$COOLDOWN_FLAG" 2>/dev/null || stat -c %Y "$COOLDOWN_FLAG" 2>/dev/null || echo 0) ))
  if [ "$COOLDOWN_AGE" -lt 600 ]; then
    NAMING_COOLDOWN=true
  else
    rm -f "$COOLDOWN_FLAG"
  fi
fi

# --- Auto-name: harness-registered sessions bypass the naming block ---
_AUTO_PANE_ID="${TMUX_PANE:-}"
if [ -z "$_AUTO_PANE_ID" ]; then
  _AUTO_PANE_ID=$(resolve_own_pane 2>/dev/null || echo "")
fi

if [ -n "$_AUTO_PANE_ID" ] && [ ! -f "$ASKED_FLAG" ] && [ ! -f "$NAME_FILE" ] && [ -f "$PANE_REGISTRY" ]; then
  _AUTO_HARNESS=$(jq -r --arg pid "$_AUTO_PANE_ID" '.[$pid].harness // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
  if [ -n "$_AUTO_HARNESS" ]; then
    _AUTO_TASK=$(jq -r --arg pid "$_AUTO_PANE_ID" '.[$pid].task // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
    _AUTO_SESSION_NAME=$(jq -r --arg pid "$_AUTO_PANE_ID" '.[$pid].session_name // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
    if [ -n "$_AUTO_SESSION_NAME" ]; then
      _AUTO_NAME="$_AUTO_SESSION_NAME"
    elif [ -n "$_AUTO_TASK" ]; then
      _AUTO_NAME="${_AUTO_HARNESS}: ${_AUTO_TASK}"
    else
      _AUTO_NAME="$_AUTO_HARNESS"
    fi
    _AUTO_NAME=$(echo "$_AUTO_NAME" | cut -c1-80)
    jq -n --arg name "$_AUTO_NAME" --arg summary "auto-named from harness registration (${_AUTO_HARNESS})" \
      '{name: $name, summary: $summary}' > "$NAME_FILE"
    touch "$ASKED_FLAG"
  fi
fi

# --- Phase A2: We already asked -- collect name and allow through naming ---
if [ "$NAMING_COOLDOWN" = "false" ] && [ -f "$ASKED_FLAG" ]; then
  if [ -f "$NAME_FILE" ]; then
    RAW_CONTENT=$(cat "$NAME_FILE")

    # Support both plain text and JSON format
    SESSION_NAME=$(echo "$RAW_CONTENT" | jq -r '.name // empty' 2>/dev/null)
    SESSION_SUMMARY=$(echo "$RAW_CONTENT" | jq -r '.summary // empty' 2>/dev/null)
    if [ -z "$SESSION_NAME" ]; then
      SESSION_NAME=$(echo "$RAW_CONTENT" | head -1 | tr -d '\n')
      SESSION_SUMMARY=""
    fi

    if [ -n "$SESSION_NAME" ]; then
      # Resolve pane for tmux title
      PANE_ID="${_AUTO_PANE_ID:-}"
      if [ -z "$PANE_ID" ]; then
        CLAUDE_PID=$(pgrep -f "session_id.*$SESSION_ID" 2>/dev/null | head -1)
        if [ -n "$CLAUDE_PID" ]; then
          PANE_ID=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read ppid pid; do
            if pgrep -P "$ppid" 2>/dev/null | grep -q "$CLAUDE_PID"; then echo "$pid"; break; fi
          done)
        fi
      fi

      if [ -n "$PANE_ID" ]; then
        tmux select-pane -t "$PANE_ID" -T "$SESSION_NAME" 2>/dev/null || true
        pane_registry_set_session "$PANE_ID" "$SESSION_NAME" "$SESSION_SUMMARY" 2>/dev/null || true
      fi

      mkdir -p "$(dirname "$SESSIONS_LOG")"
      TIMESTAMP=$(date -Iseconds)

      if [ -f "$TOOL_LOG" ]; then
        TOOL_COUNT=$(grep -c "\"session_id\":\"$SESSION_ID\"" "$TOOL_LOG" 2>/dev/null || echo "0")
      else
        TOOL_COUNT="0"
      fi
      # Ensure TOOL_COUNT is a valid number for --argjson
      case "$TOOL_COUNT" in
        ''|*[!0-9]*) TOOL_COUNT="0" ;;
      esac

      jq -n --compact-output \
        --arg ts "$TIMESTAMP" \
        --arg sid "$SESSION_ID" \
        --arg name "$SESSION_NAME" \
        --arg summary "$SESSION_SUMMARY" \
        --arg project "$PROJECT" \
        --argjson tools "$TOOL_COUNT" \
        '{timestamp: $ts, session_id: $sid, name: $name, summary: $summary, project: $project, tool_calls: $tools}' \
        >> "$SESSIONS_LOG"
    fi
  fi

  # Cooldown + cleanup for naming
  touch "$COOLDOWN_FLAG"
  rm -f "$NAME_FILE" "$ASKED_FLAG"
  # Naming done — fall through to Phase B (code review).
  # Do NOT exit here; we still want to check for code review items.

elif [ "$NAMING_COOLDOWN" = "false" ] && [ ! -f "$ASKED_FLAG" ]; then
  # --- Phase A1: First stop invocation — check for tool activity ---

  # Check if this session has any tool activity worth naming
  if [ -f "$TOOL_LOG" ] && grep -q "\"session_id\":\"$SESSION_ID\"" "$TOOL_LOG" 2>/dev/null; then
    TOOL_COUNT=$(grep -c "\"session_id\":\"$SESSION_ID\"" "$TOOL_LOG" 2>/dev/null || echo 0)

    if [ "$TOOL_COUNT" -ge 3 ]; then
      # Build combined naming block message
      PARTS=()

      # A. Session naming prompt
      PARTS+=("**Name this session** in 3-5 words. Run:")
      PARTS+=('```')
      PARTS+=("echo '{\"name\": \"your session name\", \"summary\": \"one sentence of what was done\"}' > ${_SESSION_DIR}/session-name.json")
      PARTS+=('```')

      # B. Git commit reminder — check for uncommitted changes after writes
      HAS_WRITES=$(grep "\"session_id\":\"$SESSION_ID\"" "$TOOL_LOG" 2>/dev/null | grep -c '"tool_name":"Write\|"tool_name":"Edit' || echo 0)
      if [ "$HAS_WRITES" -gt 0 ] && [ -n "$CWD" ]; then
        UNCOMMITTED=$(cd "$CWD" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
        if [ "$UNCOMMITTED" -gt 0 ]; then
          PARTS+=("")
          PARTS+=("**Git reminder:** $UNCOMMITTED uncommitted file(s). Consider committing before stopping.")
        fi
      fi

      # C. Memory/learnings prompt — uses Claude Code's native worktree-scoped auto-memory
      if [ "$TOOL_COUNT" -ge 3 ]; then
        PARTS+=("")
        PARTS+=("**Memory check:** Did you learn anything worth saving to your auto-memory MEMORY.md? (patterns, gotchas, API behaviors, file paths)")
      fi

      touch "$ASKED_FLAG"
      REASON=$(printf '%s\n' "${PARTS[@]}")
      hook_block "$REASON"
      exit 0
    fi
  fi
fi


# ═══════════════════════════════════════════════════════════════
# PHASE B: CODE REVIEW CHECKLIST (from stop-check.sh)
# ═══════════════════════════════════════════════════════════════

cd "$PROJECT_ROOT" 2>/dev/null || true

# Gate: fire only if Claude wrote files OR deployed this session
WRITE_FLAG="$_SESSION_DIR/write-flag"
DEPLOY_FLAG_CHECK="$_SESSION_DIR/deploy-flag"
if [ ! -f "$WRITE_FLAG" ] && [ ! -f "$DEPLOY_FLAG_CHECK" ]; then
  # No writes, no deploy — skip code review, proceed to allow stop
  _phase_b_triggered=false
else
  _phase_b_triggered=true

  # Clear the write flag so we don't re-trigger on the next stop without new writes
  rm -f "$WRITE_FLAG"

  BASELINE_FILE="$_SESSION_DIR/baseline.txt"

  # Current dirty files (staged + unstaged + untracked in src/)
  ALL_DIRTY=$(git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard src/ 2>/dev/null)
  ALL_DIRTY=$(echo "$ALL_DIRTY" | sort -u | grep -v '^$' || true)

  # Create baseline on first invocation
  if [ ! -f "$BASELINE_FILE" ]; then
    echo "$ALL_DIRTY" > "$BASELINE_FILE"
  fi

  # Only files NEW since baseline
  BASELINE=$(cat "$BASELINE_FILE" 2>/dev/null || true)
  CHANGED=$(comm -23 <(echo "$ALL_DIRTY") <(echo "$BASELINE" | sort -u) 2>/dev/null || true)
  CHANGED=$(echo "$CHANGED" | grep -v '^$' || true)

  # Allow deploy-only sessions (no file changes but deployed)
  if [ -z "$CHANGED" ] && [ ! -f "$DEPLOY_FLAG_CHECK" ]; then
    _phase_b_triggered=false
  fi
fi

if [ "$_phase_b_triggered" = "true" ]; then
  # Categorize
  HAS_TSX=$(echo "$CHANGED" | grep -c '\.tsx\?$' || true)
  HAS_CSS=$(echo "$CHANGED" | grep -c '\.css$' || true)
  HAS_TEST=$(echo "$CHANGED" | grep -c '\.test\.' || true)
  HAS_FRONTEND=$(echo "$CHANGED" | grep -c 'admin/app\|\.css$\|\.html$' || true)
  HAS_BACKEND=$(echo "$CHANGED" | grep -cE 'routes/|server\.ts|core/|db/|sql/' || true)
  HAS_CONFIG=$(echo "$CHANGED" | grep -c 'hooks\|settings\|\.json$' || true)
  HAS_ONTOLOGY=$(echo "$CHANGED" | grep -c 'ontology/' || true)
  FILE_COUNT=$(echo "$CHANGED" | wc -l | tr -d ' ')

  # --- Deploy detection (from deploy-flag.sh PostToolUse hook) ---
  DEPLOY_FLAG="$_SESSION_DIR/deploy-flag"
  HAS_DEPLOYED=0
  DEPLOY_TARGET=""
  DEPLOY_SERVICE=""
  DEPLOY_DOMAIN=""
  if [ -f "$DEPLOY_FLAG" ]; then
    HAS_DEPLOYED=1
    DEPLOY_TARGET=$(jq -r '.target // "unknown"' "$DEPLOY_FLAG" 2>/dev/null || echo "unknown")
    DEPLOY_SERVICE=$(jq -r '.service // "all"' "$DEPLOY_FLAG" 2>/dev/null || echo "all")
    if [ "$DEPLOY_TARGET" = "prod" ]; then
      DEPLOY_DOMAIN="${FLEET_PROD_DOMAIN:-}"
    else
      DEPLOY_DOMAIN="${FLEET_TEST_DOMAIN:-}"
    fi
    # Consume the flag
    rm -f "$DEPLOY_FLAG"
  fi

  # --- Sensitive path detection ---
  SENSITIVE_MATCHES=""
  if [ -f "$HARNESS_XML" ]; then
    PATTERNS=$(sed -n '/<sensitive-paths>/,/<\/sensitive-paths>/p' "$HARNESS_XML" \
      | grep '<path ' \
      | sed 's/.*pattern="\([^"]*\)".*/\1/' || true)

    if [ -n "$PATTERNS" ]; then
      while IFS= read -r pattern; do
        [ -z "$pattern" ] && continue
        MATCHES=$(echo "$CHANGED" | grep -E "$pattern" || true)
        if [ -n "$MATCHES" ]; then
          REASON=$(sed -n '/<sensitive-paths>/,/<\/sensitive-paths>/p' "$HARNESS_XML" \
            | grep "pattern=\"${pattern}\"" \
            | sed 's/.*reason="\([^"]*\)".*/\1/' || echo "sensitive area")
          if [ -z "$SENSITIVE_MATCHES" ]; then
            SENSITIVE_MATCHES="$pattern ($REASON)"
          else
            SENSITIVE_MATCHES="$SENSITIVE_MATCHES, $pattern ($REASON)"
          fi
        fi
      done <<< "$PATTERNS"
    fi
  fi

  HAS_SENSITIVE=0
  [ -n "$SENSITIVE_MATCHES" ] && HAS_SENSITIVE=1

  # --- Extract from XML ---
  extract_questions() {
    local section="$1"
    [ ! -f "$HARNESS_XML" ] && return
    sed -n "/<${section}>/,/<\/${section}>/p" "$HARNESS_XML" \
      | grep -E '<(prompt|question|advisory)' \
      | sed 's/.*<prompt[^>]*>//' | sed 's/<\/prompt>//' \
      | sed 's/.*<question[^>]*>//' | sed 's/<\/question>//' \
      | sed 's/.*<advisory[^>]*>//' | sed 's/<\/advisory>//' \
      | sed "s/{file_count}/${FILE_COUNT}/g" \
      | sed "s|{sensitive_matches}|${SENSITIVE_MATCHES}|g" \
      | sed 's/&lt;/</g' | sed 's/&gt;/>/g' | sed 's/&amp;/\&/g'
  }

  extract_checklist() {
    [ ! -f "$HARNESS_XML" ] && return
    sed -n '/<checklist>/,/<\/checklist>/p' "$HARNESS_XML" \
      | grep '<item' \
      | sed 's/.*<item[^>]*>/  [ ] /' | sed 's/<\/item>//'
  }

  # --- Build message ---
  MSG=""

  if [ "$HAS_TSX" -gt 0 ] || [ "$HAS_CSS" -gt 0 ] || [ "$HAS_BACKEND" -gt 0 ]; then
    LINES=$(extract_questions "code-changes")
    if [ -n "$LINES" ]; then
      MSG="$LINES"
      if [ "$HAS_FRONTEND" -eq 0 ]; then
        MSG=$(echo "$MSG" | grep -v 'UI changed' || echo "$MSG")
      fi
      if [ "$HAS_TEST" -gt 0 ] || [ "$HAS_TSX" -eq 0 ]; then
        MSG=$(echo "$MSG" | grep -v 'need tests' || echo "$MSG")
      fi
      MSG=$(echo "$MSG" | tr '\n' ' ' | sed 's/  */ /g')
    else
      MSG="You changed ${FILE_COUNT} file(s). Before finishing: 1) What does it do now? 2) How did you implement it? 3) How did you verify it works?"
    fi

  elif [ "$HAS_CONFIG" -gt 0 ]; then
    LINES=$(extract_questions "config-changes")
    if [ -n "$LINES" ]; then
      MSG=$(echo "$LINES" | sed "s/{file_count}/${FILE_COUNT}/g" | tr '\n' ' ')
    else
      MSG="Config/hook changes (${FILE_COUNT} files). Summarize what changed and verify it works."
    fi

  else
    LINES=$(extract_questions "uncommitted")
    if [ -n "$LINES" ]; then
      MSG=$(echo "$LINES" | sed "s/{file_count}/${FILE_COUNT}/g" | tr '\n' ' ')
    else
      MSG="Uncommitted changes (${FILE_COUNT} files). Ready to commit?"
    fi
  fi

  # Append sensitive path escalation
  if [ "$HAS_SENSITIVE" -eq 1 ]; then
    SENSITIVE_LINES=$(extract_questions "sensitive-escalation")
    if [ -n "$SENSITIVE_LINES" ]; then
      MSG="${MSG}

${SENSITIVE_LINES}"
    else
      MSG="${MSG}

CAUTION: You touched sensitive path(s): ${SENSITIVE_MATCHES}. What exactly changed, and what is the rollback plan?"
    fi
  fi

  # Deploy checklist
  if [ "$HAS_DEPLOYED" -eq 1 ]; then
    DEPLOY_LINES=$(extract_questions "deploy-changes")
    if [ -n "$DEPLOY_LINES" ]; then
      DEPLOY_LINES=$(echo "$DEPLOY_LINES" \
        | sed "s/{deploy_target}/${DEPLOY_TARGET}/g" \
        | sed "s/{deploy_service}/${DEPLOY_SERVICE}/g" \
        | sed "s/{deploy_domain}/${DEPLOY_DOMAIN}/g")
      if [ "$DEPLOY_TARGET" != "prod" ]; then
        DEPLOY_LINES=$(echo "$DEPLOY_LINES" | grep -v 'PROD deploy' || echo "$DEPLOY_LINES")
      fi
      MSG="${MSG}

${DEPLOY_LINES}"
    else
      MSG="${MSG}

You deployed to ${DEPLOY_TARGET} (service: ${DEPLOY_SERVICE}). Health check: curl -sf https://${DEPLOY_DOMAIN}/health"
    fi
  fi

  # Blast radius escalation
  if [ "$FILE_COUNT" -gt "$STOP_CHECK_BLAST_RADIUS_THRESHOLD" ]; then
    MSG="${MSG}

NOTE: ${FILE_COUNT} files changed -- this is a sweeping change. Consider running a cx audit or splitting into smaller commits."
  fi

  # Append checklist
  CHECKLIST=$(extract_checklist)
  if [ -n "$CHECKLIST" ]; then
    if [ "$HAS_SENSITIVE" -eq 0 ]; then
      # Normal mode: apply gates
      if [ "$HAS_FRONTEND" -eq 0 ]; then
        CHECKLIST=$(echo "$CHECKLIST" | grep -v 'UI changed\|built admin\|screenshots' || echo "$CHECKLIST")
      fi
      if [ "$HAS_BACKEND" -eq 0 ]; then
        CHECKLIST=$(echo "$CHECKLIST" | grep -v 'backend changed\|endpoints respond' || echo "$CHECKLIST")
      fi
      if [ "$HAS_TEST" -eq 0 ] && [ "$HAS_TSX" -eq 0 ]; then
        CHECKLIST=$(echo "$CHECKLIST" | grep -v 'Tests pass' || echo "$CHECKLIST")
      fi
      if [ "$HAS_TSX" -eq 0 ]; then
        CHECKLIST=$(echo "$CHECKLIST" | grep -v 'TypeScript errors' || echo "$CHECKLIST")
      fi
      if [ "$HAS_DEPLOYED" -eq 0 ]; then
        CHECKLIST=$(echo "$CHECKLIST" | grep -v 'Health check passes\|SQL library entries synced' || echo "$CHECKLIST")
      fi
      if [ "$HAS_ONTOLOGY" -eq 0 ]; then
        CHECKLIST=$(echo "$CHECKLIST" | grep -v 'actionSecurity entry' || echo "$CHECKLIST")
      fi
    fi
    # else: sensitive mode -- show all items unfiltered

    MSG="${MSG}

Checklist:
${CHECKLIST}"
  fi

  # If we have a message, block
  if [ -n "$MSG" ]; then
    hook_block "$MSG"
    exit 0
  fi
fi


# ═══════════════════════════════════════════════════════════════
# PHASE C: ALLOW STOP — detect memory changes + publish session-end event
# ═══════════════════════════════════════════════════════════════

# Resolve harness for the event payload
_END_HARNESS=""
_END_PANE="${_AUTO_PANE_ID:-}"
if [ -n "$_END_PANE" ] && [ -f "$PANE_REGISTRY" ]; then
  _END_HARNESS=$(jq -r --arg pid "$_END_PANE" '.[$pid].harness // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
fi

# Detect MEMORY.md changes during this session (post-hoc observability)
# Uses Claude Code's native worktree-scoped auto-memory path
_MEM_CWD="${CWD:-$(pwd)}"
_MEM_PROJ_KEY="${_MEM_CWD//\//-}"
_MEM_PROJ_KEY="-${_MEM_PROJ_KEY#-}"
_MEMORY_FILE="$HOME/.claude/projects/${_MEM_PROJ_KEY}/memory/MEMORY.md"
_SESSION_START_FILE="$_SESSION_DIR/session-start-ts"
if [ -f "$_MEMORY_FILE" ]; then
  _MEM_MTIME=$(_file_mtime "$_MEMORY_FILE")
  _START_TS=0
  [ -f "$_SESSION_START_FILE" ] && _START_TS=$(cat "$_SESSION_START_FILE" 2>/dev/null || echo "0")
  if [ "$_START_TS" = "0" ]; then
    date +%s > "$_SESSION_START_FILE" 2>/dev/null || true
  elif [ "$_MEM_MTIME" -gt "$_START_TS" ]; then
    # MEMORY.md was modified during this session — publish observability event
    if [ -f "$HOME/.claude-ops/lib/event-bus.sh" ]; then
      _mem_ev_payload=$(jq -nc --arg a "${_END_HARNESS:-unknown}" --arg src "agent" --arg sid "$SESSION_ID" \
        --arg aid "${_HOOK_AGENT_ID:-}" --arg atype "${_HOOK_AGENT_TYPE:-}" \
        '{agent:$a, source:$src, session_id:$sid,
         agent_id: (if $aid == "" then null else $aid end),
         agent_type: (if $atype == "" then null else $atype end)}' 2>/dev/null || true)
      if [ -n "$_mem_ev_payload" ]; then
        (source "$HOME/.claude-ops/lib/event-bus.sh" 2>/dev/null && \
          bus_publish "agent.memory-updated" "$_mem_ev_payload" 2>/dev/null || true) &
        disown 2>/dev/null || true
      fi
    fi
  fi
fi

if [ "${EVENT_BUS_ENABLED:-false}" = "true" ]; then
  source "$HOME/.claude-ops/lib/event-bus.sh" 2>/dev/null || true
  bus_publish "session-end" "$(jq -nc \
    --arg sid "$SESSION_ID" \
    --arg harness "${_END_HARNESS:-}" \
    --arg reason "${end_reason:-manual}" \
    --arg aid "${_HOOK_AGENT_ID:-}" \
    --arg atype "${_HOOK_AGENT_TYPE:-}" \
    '{session_id:$sid, harness:$harness, end_reason:$reason,
     agent_id: (if $aid == "" then null else $aid end),
     agent_type: (if $atype == "" then null else $atype end)}')" 2>/dev/null || true
fi

echo '{}'
exit 0
