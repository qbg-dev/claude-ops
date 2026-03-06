#!/usr/bin/env bash
# post-tool-publisher.sh — Tool telemetry publisher (PostToolUse hook).
# Publishes tool-call, file-edit, error, config-change events to the bus.
# Fires on ALL tools. Always returns {} on stdout.

set -uo pipefail

# ── Always return {} on stdout, even on error — exit 0 ensures no TUI "hook error" noise ──
trap 'echo "{}"; exit 0' EXIT
exec 2>/dev/null  # suppress stderr — Claude Code treats any stderr as hook error

# ── Read stdin ──
INPUT=$(cat)

# ── Extract common fields (use <<< to avoid echo+pipe control-char issues) ──
SESSION_ID=$(jq -r '.session_id // "unknown"' <<< "$INPUT" 2>/dev/null || echo "unknown")
TOOL_NAME=$(jq -r '.tool_name // empty' <<< "$INPUT" 2>/dev/null || echo "")
CWD=$(jq -r '.cwd // ""' <<< "$INPUT" 2>/dev/null || echo "")
TOOL_USE_ID=$(jq -r '.tool_use_id // ""' <<< "$INPUT" 2>/dev/null || echo "")
TOOL_RESULT=$(jq -r '.tool_result // ""' <<< "$INPUT" 2>/dev/null || echo "")

# Skip if no tool name
[ -z "$TOOL_NAME" ] && exit 0

# ── Project from cwd ──
if [ -n "$CWD" ]; then
  PROJECT=$(basename "$CWD")
else
  PROJECT="_unknown"
fi

TIMESTAMP=$(date -Iseconds)

# ── Source libraries ──
source "$HOME/.claude-ops/lib/pane-resolve.sh" 2>/dev/null || true
source "$HOME/.claude-ops/lib/event-bus.sh" 2>/dev/null || true
set +e  # event-bus.sh sets -euo pipefail; undo -e to avoid unexpected exits

# ── Resolve harness ──
HARNESS=""
resolve_pane_and_harness "$SESSION_ID" 2>/dev/null || true
# HARNESS is now set (or "" if not in a harness)

# ── Agent identification ──
# Base identity: "main" (PostToolUse session_id = top-level interactive session)
AGENT_NAME="main"

HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
_SESSION_DIR="$HARNESS_STATE_DIR/sessions/$SESSION_ID"

# Overlay: check active subagent marker files
ACTIVE_AGENTS=""
for sa_marker in "$_SESSION_DIR"/subagent_*; do
  [ -f "$sa_marker" ] || continue
  SA_ID="${sa_marker##*_}"
  IFS='|' read -r SA_TYPE SA_TS < "$sa_marker"
  if [ -n "$SA_ID" ] && [ -n "$SA_TYPE" ]; then
    if [ -n "$ACTIVE_AGENTS" ]; then
      ACTIVE_AGENTS="${ACTIVE_AGENTS},${SA_TYPE}:${SA_ID}"
    else
      ACTIVE_AGENTS="${SA_TYPE}:${SA_ID}"
    fi
  fi
done

if [ -n "$ACTIVE_AGENTS" ]; then
  AGENT_NAME="${AGENT_NAME}/${ACTIVE_AGENTS}"
fi

# Clean up stale caches (probabilistic, ~2% of calls)
if (( RANDOM % 50 == 0 )); then
  find "$HARNESS_STATE_DIR/sessions" -name "agent-id" -mmin +240 -delete 2>/dev/null || true
  find "$HARNESS_STATE_DIR/sessions" -name "subagent_*" -mmin +240 -delete 2>/dev/null || true
fi

# ── Extract tool-specific fields ──
FILE_PATH=""
INPUT_SUMMARY=""
SIZE_DELTA=0
EXIT_CODE=""

case "$TOOL_NAME" in
  Bash)
    COMMAND=$(jq -r '.tool_input.command // ""' <<< "$INPUT")
    DESCRIPTION=$(jq -r '.tool_input.description // ""' <<< "$INPUT")
    TIMEOUT=$(jq '.tool_input.timeout // null' <<< "$INPUT")
    BG=$(jq '.tool_input.run_in_background // false' <<< "$INPUT")
    INPUT_SUMMARY="$COMMAND"
    # Try to extract exit code from tool_result (often ends with "Exit code: N")
    EXIT_CODE=$(grep -oE 'Exit code: [0-9]+' <<< "$TOOL_RESULT" 2>/dev/null | tail -1 | grep -oE '[0-9]+' 2>/dev/null || echo "")
    ;;
  Write)
    FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "$INPUT")
    CONTENT_LEN=$(jq '.tool_input.content | length' <<< "$INPUT")
    INPUT_SUMMARY="write $FILE_PATH (${CONTENT_LEN}b)"
    SIZE_DELTA="$CONTENT_LEN"
    ;;
  Edit)
    FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "$INPUT")
    OLD_LEN=$(jq '.tool_input.old_string | length' <<< "$INPUT")
    NEW_LEN=$(jq '.tool_input.new_string | length' <<< "$INPUT")
    REPLACE_ALL=$(jq '.tool_input.replace_all // false' <<< "$INPUT")
    INPUT_SUMMARY="edit $FILE_PATH (+$((NEW_LEN - OLD_LEN)))"
    SIZE_DELTA=$((NEW_LEN - OLD_LEN))
    ;;
  Read)
    FILE_PATH=$(jq -r '.tool_input.file_path // ""' <<< "$INPUT")
    INPUT_SUMMARY="read $FILE_PATH"
    ;;
  Grep)
    PATTERN=$(jq -r '.tool_input.pattern // ""' <<< "$INPUT")
    GREP_PATH=$(jq -r '.tool_input.path // "."' <<< "$INPUT")
    INPUT_SUMMARY="grep '$PATTERN' $GREP_PATH"
    ;;
  Glob)
    PATTERN=$(jq -r '.tool_input.pattern // ""' <<< "$INPUT")
    INPUT_SUMMARY="glob $PATTERN"
    ;;
  WebFetch)
    URL=$(jq -r '.tool_input.url // ""' <<< "$INPUT")
    INPUT_SUMMARY="fetch $URL"
    ;;
  *)
    # Generic: try to produce a brief summary from tool_input
    INPUT_SUMMARY=$(jq -r '.tool_input | keys[:3] | join(",")' <<< "$INPUT" 2>/dev/null || echo "$TOOL_NAME")
    ;;
esac

# Truncate input_summary to 200 chars
INPUT_SUMMARY="${INPUT_SUMMARY:0:200}"

# ── Error detection ──
IS_ERROR="false"
ERROR_MSG=""

# Bash: non-zero exit code
if [ "$TOOL_NAME" = "Bash" ] && [ -n "$EXIT_CODE" ] && [ "$EXIT_CODE" != "0" ]; then
  IS_ERROR="true"
  ERROR_MSG="Exit code $EXIT_CODE"
fi

# Any tool: check for error patterns in result (limit scan to first 2000 chars)
RESULT_HEAD="${TOOL_RESULT:0:2000}"
if grep -qiE '(^Error:|ENOENT|Permission denied|failed|FATAL|panic|Traceback)' <<< "$RESULT_HEAD" 2>/dev/null; then
  IS_ERROR="true"
  if [ -z "$ERROR_MSG" ]; then
    ERROR_MSG=$(grep -oiE '(Error:.*|ENOENT.*|Permission denied.*|failed.*|FATAL.*|panic.*)' <<< "$RESULT_HEAD" 2>/dev/null | head -1 | cut -c1-150 || echo "unknown error")
  fi
fi

# ── Config change detection ──
IS_CONFIG_CHANGE="false"
if [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
  case "$FILE_PATH" in
    */data/config/*.json|*security-policies*)
      IS_CONFIG_CHANGE="true"
      ;;
  esac
fi

# ══════════════════════════════════════════════════════════════════
# 2. BUS EVENTS (ALL tools)
# ══════════════════════════════════════════════════════════════════

# 2a. tool-call event (every tool)
TOOL_CALL_PAYLOAD=$(jq -n --compact-output \
  --arg type "tool-call" \
  --arg sid "$SESSION_ID" \
  --arg harness "$HARNESS" \
  --arg agent "$AGENT_NAME" \
  --arg tool "$TOOL_NAME" \
  --arg summary "$INPUT_SUMMARY" \
  --arg project "$PROJECT" \
  '{
    type: $type,
    session_id: $sid,
    harness: (if $harness == "" then null else $harness end),
    agent: $agent,
    tool: $tool,
    input_summary: $summary,
    project: $project,
    duration_ms: null
  }')

bus_publish "tool-call" "$TOOL_CALL_PAYLOAD" 2>/dev/null || true

# 2b. file-edit event (Write|Edit only)
if [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ]; then
  FILE_EDIT_PAYLOAD=$(jq -n --compact-output \
    --arg type "file-edit" \
    --arg sid "$SESSION_ID" \
    --arg harness "$HARNESS" \
    --arg agent "$AGENT_NAME" \
    --arg file "$FILE_PATH" \
    --arg action "$TOOL_NAME" \
    --argjson delta "$SIZE_DELTA" \
    --arg project "$PROJECT" \
    '{
      type: $type,
      session_id: $sid,
      harness: (if $harness == "" then null else $harness end),
      agent: $agent,
      file: $file,
      action: $action,
      size_delta: $delta,
      project: $project
    }')

  bus_publish "file-edit" "$FILE_EDIT_PAYLOAD" 2>/dev/null || true
fi

# 2c. error event (when tool indicates failure)
if [ "$IS_ERROR" = "true" ]; then
  ERROR_PAYLOAD=$(jq -n --compact-output \
    --arg type "error" \
    --arg sid "$SESSION_ID" \
    --arg harness "$HARNESS" \
    --arg agent "$AGENT_NAME" \
    --arg error "$ERROR_MSG" \
    --arg context "$INPUT_SUMMARY" \
    --arg tool "$TOOL_NAME" \
    --arg project "$PROJECT" \
    '{
      type: $type,
      session_id: $sid,
      harness: (if $harness == "" then null else $harness end),
      agent: $agent,
      error: $error,
      context: $context,
      tool: $tool,
      project: $project
    }')

  bus_publish "error" "$ERROR_PAYLOAD" 2>/dev/null || true
fi

# 2d. config-change event (Write|Edit on config files)
if [ "$IS_CONFIG_CHANGE" = "true" ]; then
  CONFIG_CHANGE_PAYLOAD=$(jq -n --compact-output \
    --arg type "config-change" \
    --arg sid "$SESSION_ID" \
    --arg harness "$HARNESS" \
    --arg agent "$AGENT_NAME" \
    --arg file "$FILE_PATH" \
    --arg action "$TOOL_NAME" \
    --arg project "$PROJECT" \
    '{
      type: $type,
      session_id: $sid,
      harness: (if $harness == "" then null else $harness end),
      agent: $agent,
      file: $file,
      action: $action,
      project: $project
    }')

  bus_publish "config-change" "$CONFIG_CHANGE_PAYLOAD" 2>/dev/null || true
fi

# ── Done — trap handles stdout {} ──
exit 0
