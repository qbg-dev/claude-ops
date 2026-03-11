#!/usr/bin/env bash
# session-logger.sh — Unified logging to ~/.claude/ops/logs/{project}/
# Registered on ALL events. Pure side-effect, never blocks or injects.
#
# Always returns {}
set -uo pipefail
trap 'echo "{}"; exit 0' ERR

INPUT=$(cat)

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
[ -z "$EVENT" ] || [ -z "$SESSION_ID" ] && { echo '{}'; exit 0; }

CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
MODEL=$(echo "$INPUT" | jq -r '.model // ""' 2>/dev/null || echo "")
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null || echo "")

# ── Project name derivation ─────────────────────────────────────
if [ -n "$CWD" ]; then
  _raw=$(basename "$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "$CWD")")
else
  _raw="_global"
fi
PROJECT_NAME=$(echo "$_raw" | sed 's/-w-[^/]*$//')

# ── Paths ───────────────────────────────────────────────────────
LOGS_BASE="$HOME/.claude/ops/logs"
EVENTS_DIR="$LOGS_BASE/$PROJECT_NAME/events"
SESSIONS_DIR="$LOGS_BASE/$PROJECT_NAME/sessions"
SESSION_BREADCRUMBS="$LOGS_BASE/.sessions"
mkdir -p "$EVENTS_DIR" "$SESSIONS_DIR" "$SESSION_BREADCRUMBS" 2>/dev/null || true

TODAY=$(date +%Y-%m-%d)
EVENTS_FILE="$EVENTS_DIR/$TODAY.jsonl"
TS=$(date -Iseconds)
WORKER="${WORKER_NAME:-}"

# ── Base event fields ───────────────────────────────────────────
BASE_ARGS=(--arg ts "$TS" --arg sid "$SESSION_ID" --arg ev "$EVENT"
  --arg model "$MODEL" --arg worker "$WORKER" --arg project "$PROJECT_NAME"
  --arg cwd "$CWD")

# ── Event-specific logging ──────────────────────────────────────
case "$EVENT" in
  UserPromptSubmit)
    PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null || echo "")
    PROMPT_LEN=${#PROMPT}
    PROMPT_HASH=$(echo "$PROMPT" | md5 -q 2>/dev/null || echo "$PROMPT" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "")
    WORD_COUNT=$(echo "$PROMPT" | wc -w | tr -d ' ')
    HAS_CODE=false; echo "$PROMPT" | grep -q '```' && HAS_CODE=true
    HAS_URL=false; echo "$PROMPT" | grep -qE 'https?://' && HAS_URL=true
    IS_SLASH=false; echo "$PROMPT" | grep -qE '^/' && IS_SLASH=true
    GIT_BRANCH=""
    [ -n "$CWD" ] && GIT_BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || echo "")

    # Session duration: record start time on first prompt
    START_FILE="$SESSION_BREADCRUMBS/${SESSION_ID}.start"
    [ ! -f "$START_FILE" ] && date +%s > "$START_FILE"

    jq -n -c "${BASE_ARGS[@]}" \
      --argjson prompt_length "$PROMPT_LEN" \
      --arg prompt_hash "$PROMPT_HASH" \
      --argjson word_count "$WORD_COUNT" \
      --argjson has_code_block "$HAS_CODE" \
      --argjson has_url "$HAS_URL" \
      --argjson is_slash_command "$IS_SLASH" \
      --arg git_branch "$GIT_BRANCH" \
      '{ts:$ts, session_id:$sid, event:$ev, model:$model, worker:$worker, project:$project, cwd:$cwd,
        prompt_length:$prompt_length, prompt_hash:$prompt_hash, word_count:$word_count,
        has_code_block:$has_code_block, has_url:$has_url, is_slash_command:$is_slash_command,
        git_branch:$git_branch}' >> "$EVENTS_FILE" 2>/dev/null
    ;;

  PreToolUse|PostToolUse)
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
    # Build a 200-char summary from tool_input
    TOOL_SUMMARY=$(echo "$INPUT" | jq -r '.tool_input | if type == "object" then ((.command // .file_path // .pattern // .prompt // .description // (keys[0] + ": " + (.[keys[0]] | tostring))) // "") else tostring end' 2>/dev/null | head -c 200 || echo "")

    jq -n -c "${BASE_ARGS[@]}" \
      --arg tool_name "$TOOL_NAME" \
      --arg tool_summary "$TOOL_SUMMARY" \
      --arg agent_id "$AGENT_ID" \
      --arg agent_type "$AGENT_TYPE" \
      '{ts:$ts, session_id:$sid, event:$ev, model:$model, worker:$worker, project:$project, cwd:$cwd,
        tool_name:$tool_name, tool_summary:$tool_summary,
        agent_id:(if $agent_id == "" then null else $agent_id end),
        agent_type:(if $agent_type == "" then null else $agent_type end)}' >> "$EVENTS_FILE" 2>/dev/null
    ;;

  SubagentStart)
    jq -n -c "${BASE_ARGS[@]}" \
      --arg agent_id "$AGENT_ID" \
      --arg agent_type "$AGENT_TYPE" \
      '{ts:$ts, session_id:$sid, event:$ev, model:$model, worker:$worker, project:$project, cwd:$cwd,
        agent_id:$agent_id, agent_type:$agent_type}' >> "$EVENTS_FILE" 2>/dev/null
    ;;

  SubagentStop)
    LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null | head -c 200 || echo "")
    TRANSCRIPT=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || echo "")

    jq -n -c "${BASE_ARGS[@]}" \
      --arg agent_id "$AGENT_ID" \
      --arg agent_type "$AGENT_TYPE" \
      --arg last_message "$LAST_MSG" \
      --arg transcript_path "$TRANSCRIPT" \
      '{ts:$ts, session_id:$sid, event:$ev, model:$model, worker:$worker, project:$project, cwd:$cwd,
        agent_id:$agent_id, agent_type:$agent_type,
        last_message:(if $last_message == "" then null else $last_message end),
        transcript_path:(if $transcript_path == "" then null else $transcript_path end)}' >> "$EVENTS_FILE" 2>/dev/null
    ;;

  Stop)
    # Compute session duration
    START_FILE="$SESSION_BREADCRUMBS/${SESSION_ID}.start"
    DURATION=0
    if [ -f "$START_FILE" ]; then
      START_EPOCH=$(cat "$START_FILE" 2>/dev/null || echo "0")
      NOW_EPOCH=$(date +%s)
      DURATION=$((NOW_EPOCH - START_EPOCH))
      rm -f "$START_FILE" 2>/dev/null || true
    fi

    jq -n -c "${BASE_ARGS[@]}" \
      --argjson duration_sec "$DURATION" \
      '{ts:$ts, session_id:$sid, event:$ev, model:$model, worker:$worker, project:$project, cwd:$cwd,
        duration_sec:$duration_sec}' >> "$EVENTS_FILE" 2>/dev/null

    # Archive session transcript
    _archive_transcript() {
      # Find transcript: ~/.claude/projects/{url-encoded-path}/{session-id}.jsonl
      local projects_dir="$HOME/.claude/projects"
      [ ! -d "$projects_dir" ] && return
      local transcript_file=""
      # Search for the session transcript
      for d in "$projects_dir"/*/; do
        local candidate="${d}${SESSION_ID}.jsonl"
        if [ -f "$candidate" ]; then
          transcript_file="$candidate"
          break
        fi
      done
      [ -z "$transcript_file" ] && return

      # Copy to archive
      cp "$transcript_file" "$SESSIONS_DIR/${SESSION_ID}.jsonl" 2>/dev/null || true

      # Append session summary to index
      jq -n -c --arg ts "$TS" --arg sid "$SESSION_ID" --arg project "$PROJECT_NAME" \
        --arg worker "$WORKER" --argjson duration "$DURATION" --arg model "$MODEL" \
        '{ts:$ts, session_id:$sid, project:$project, worker:$worker, duration_sec:$duration, model:$model}' \
        >> "$LOGS_BASE/$PROJECT_NAME/sessions.jsonl" 2>/dev/null || true
    }
    _archive_transcript
    ;;

  PreCompact)
    jq -n -c "${BASE_ARGS[@]}" \
      '{ts:$ts, session_id:$sid, event:$ev, model:$model, worker:$worker, project:$project, cwd:$cwd}' \
      >> "$EVENTS_FILE" 2>/dev/null
    ;;

  *)
    # Catch-all for any future events
    jq -n -c "${BASE_ARGS[@]}" \
      '{ts:$ts, session_id:$sid, event:$ev, model:$model, worker:$worker, project:$project, cwd:$cwd}' \
      >> "$EVENTS_FILE" 2>/dev/null
    ;;
esac

echo '{}'
exit 0
