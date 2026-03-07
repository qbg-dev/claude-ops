#!/bin/bash
# subagent-lifecycle.sh — SubagentStart/Stop publisher.
# Writes marker files for concurrent subagent tracking AND publishes to event bus.
#
# SubagentStart: writes {session_dir}/subagent_{agent_id}, publishes subagent.start
# SubagentStop: removes marker, logs to sessions.jsonl, publishes subagent.stop

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

[ -z "$SESSION_ID" ] && exit 0

# Source path helpers
HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
_SESSION_DIR="$HARNESS_STATE_DIR/sessions/$SESSION_ID"
mkdir -p "$_SESSION_DIR" 2>/dev/null

MARKER="$_SESSION_DIR/subagent_${AGENT_ID}"

if [ -n "$CWD" ]; then
  PROJECT=$(basename "$CWD")
else
  PROJECT="_unknown"
fi

# Source bus + identity resolution
source "$HOME/.claude-ops/lib/event-bus.sh" 2>/dev/null || true
source "$HOME/.claude-ops/lib/pane-resolve.sh" 2>/dev/null || true
BUS_AGENT="main"
if type resolve_pane_and_harness &>/dev/null; then
  resolve_pane_and_harness "$SESSION_ID" 2>/dev/null || true
  [ -n "${HARNESS:-}" ] && BUS_AGENT="$HARNESS"
fi

case "$EVENT" in
  SubagentStart)
    # Write per-agent marker: agent_type|timestamp
    echo "${AGENT_TYPE}|$(date -Iseconds)" > "$MARKER"

    # Publish to bus
    if type bus_publish &>/dev/null; then
      PAYLOAD=$(jq -n --arg a "$BUS_AGENT" --arg sid "$SESSION_ID" \
        --arg aid "$AGENT_ID" --arg at "$AGENT_TYPE" \
        '{agent: $a, session_id: $sid, subagent_id: $aid, subagent_type: $at}')
      bus_publish "subagent.start" "$PAYLOAD" 2>/dev/null || true
    fi
    ;;

  SubagentStop)
    # Remove this agent's marker
    rm -f "$MARKER"
    # Invalidate tool_logger's agent cache only if NO other subagents remain
    remaining=$(ls "$_SESSION_DIR"/subagent_* 2>/dev/null | wc -l)
    if [ "$remaining" -eq 0 ]; then
      rm -f "$_SESSION_DIR/agent-id"
    fi

    # Log subagent session
    TRANSCRIPT=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""')
    LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')
    TIMESTAMP=$(date -Iseconds)

    SESSIONS_LOG="$HOME/.claude/tool-logs/$PROJECT/sessions.jsonl"
    mkdir -p "$(dirname "$SESSIONS_LOG")"

    # Count tool calls this subagent made
    TOOL_LOG="$HOME/.claude/tool-logs/$PROJECT/tools.jsonl"
    if [ -f "$TOOL_LOG" ]; then
      TOOL_COUNT=$(grep -c "${AGENT_TYPE}:${AGENT_ID}" "$TOOL_LOG" 2>/dev/null | tr -d '[:space:]' || echo 0)
    else
      TOOL_COUNT=0
    fi

    # Truncate last_assistant_message to 200 chars for the log
    LAST_MSG_SHORT=$(echo "$LAST_MSG" | cut -c1-200)

    jq -n --compact-output \
      --arg ts "$TIMESTAMP" \
      --arg sid "$SESSION_ID" \
      --arg aid "$AGENT_ID" \
      --arg atype "$AGENT_TYPE" \
      --arg project "$PROJECT" \
      --arg transcript "$TRANSCRIPT" \
      --arg summary "$LAST_MSG_SHORT" \
      --argjson tools "$TOOL_COUNT" \
      '{
        timestamp: $ts,
        session_id: $sid,
        agent_id: $aid,
        agent_type: $atype,
        project: $project,
        transcript: $transcript,
        summary: (if $summary == "" then null else $summary end),
        tool_calls: $tools
      }' >> "$SESSIONS_LOG"

    # Publish to bus
    if type bus_publish &>/dev/null; then
      PAYLOAD=$(jq -n --arg a "$BUS_AGENT" --arg sid "$SESSION_ID" \
        --arg aid "$AGENT_ID" --arg at "$AGENT_TYPE" --argjson tc "$TOOL_COUNT" \
        '{agent: $a, session_id: $sid, subagent_id: $aid, subagent_type: $at, tool_count: $tc}')
      bus_publish "subagent.stop" "$PAYLOAD" 2>/dev/null || true
    fi
    ;;
esac

# Cleanup stale markers older than 2 hours
if (( RANDOM % 20 == 0 )); then
  find "$HARNESS_STATE_DIR/sessions" -name "subagent_*" -mmin +120 -delete 2>/dev/null
fi

exit 0
