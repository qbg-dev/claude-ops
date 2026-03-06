#!/usr/bin/env bash
# prompt-publisher.sh — UserPromptSubmit publisher hook.
# Publishes prompt events to the event bus. Side-effects handle persistence.
# Always returns {} (never blocks).
set -uo pipefail
# Always return {} on stdout, even on error — exit 0 ensures no TUI "hook error" noise
trap 'echo "{}"; exit 0' ERR

source "$HOME/.claude-ops/lib/pane-resolve.sh"
source "$HOME/.claude-ops/lib/event-bus.sh"

# ── Read hook input from stdin ─────────────────────────────────────────
INPUT=$(cat)

# Parse core fields
hook_parse_input "$INPUT"
SESSION_ID="$_HOOK_SESSION_ID"
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)

# Skip if no prompt
if [ -z "$PROMPT" ]; then
  echo '{}'
  exit 0
fi

# ── Dedup by MD5 hash (same prompt twice in a row → skip) ─────────────
if [ -n "$CWD" ]; then
  PROJECT=$(basename "$CWD")
else
  PROJECT="_unknown"
fi

DEDUP_DIR="$HOME/.claude/prompts/$PROJECT"
DEDUP_HASH=$(echo "$PROMPT" | md5 -q 2>/dev/null || echo "$PROMPT" | md5sum | cut -d' ' -f1)
DEDUP_FILE="$DEDUP_DIR/.last_hash"
if [ -f "$DEDUP_FILE" ] && [ "$(cat "$DEDUP_FILE" 2>/dev/null)" = "$DEDUP_HASH" ]; then
  echo '{}'
  exit 0
fi
mkdir -p "$DEDUP_DIR"
echo "$DEDUP_HASH" > "$DEDUP_FILE"

# ── Cancel graceful-stop sentinel if activity resumes ──────────────────
# If the stop hook fired but the agent gets new input (operator typing, bus message),
# remove the sentinel so the watchdog does NOT rotate this agent.
_GS_FILE="$HOME/.claude-ops/state/sessions/$SESSION_ID/graceful-stop"
if [ -f "$_GS_FILE" ]; then
  rm -f "$_GS_FILE" 2>/dev/null || true
fi

# ── Publish session.start on first prompt ──────────────────────────────
SESSION_STARTED_MARKER="$HOME/.claude-ops/state/sessions/$SESSION_ID/session-started"
if [ ! -f "$SESSION_STARTED_MARKER" ]; then
  mkdir -p "$(dirname "$SESSION_STARTED_MARKER")"
  touch "$SESSION_STARTED_MARKER"
  # Resolve identity for the event
  _START_AGENT="main"
  if [ -n "${HARNESS:-}" ]; then
    _START_AGENT="$HARNESS"
  fi
  _START_PAYLOAD=$(jq -n --arg a "$_START_AGENT" --arg sid "$SESSION_ID" \
    --arg h "${HARNESS:-}" --arg m "${CLAUDE_MODEL:-unknown}" \
    '{agent: $a, session_id: $sid, harness: $h, model: $m}' 2>/dev/null || true)
  if [ -n "$_START_PAYLOAD" ]; then
    bus_publish "session.start" "$_START_PAYLOAD" 2>/dev/null || true
  fi
fi

# ── Collect metrics ────────────────────────────────────────────────────
CHAR_COUNT=${#PROMPT}
WORD_COUNT=$(echo "$PROMPT" | wc -w | tr -d ' ')
LINE_COUNT=$(echo "$PROMPT" | wc -l | tr -d ' ')

# ── Content flags ──────────────────────────────────────────────────────
HAS_CODE_BLOCK=false
echo "$PROMPT" | grep -q '```' && HAS_CODE_BLOCK=true

HAS_URL=false
echo "$PROMPT" | grep -qE 'https?://' && HAS_URL=true

HAS_FILE_PATH=false
echo "$PROMPT" | grep -qE '(^|[[:space:]])(\/[a-zA-Z0-9_./-]+|~\/[a-zA-Z0-9_./-]+|\.\/[a-zA-Z0-9_./-]+)' && HAS_FILE_PATH=true

IS_SLASH_COMMAND=false
SLASH_COMMAND=""
if echo "$PROMPT" | grep -qE '^/[a-zA-Z]'; then
  IS_SLASH_COMMAND=true
  SLASH_COMMAND=$(echo "$PROMPT" | grep -oE '^/[a-zA-Z0-9_-]+' | head -1)
fi

IS_QUESTION=false
echo "$PROMPT" | grep -q '?' && IS_QUESTION=true

# ── Git context ────────────────────────────────────────────────────────
GIT_BRANCH=""
GIT_REPO=""
if [ -n "$CWD" ] && { [ -d "$CWD/.git" ] || git -C "$CWD" rev-parse --git-dir >/dev/null 2>&1; }; then
  GIT_BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || echo "")
  GIT_REPO=$(basename "$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "")
fi

# ── System context ─────────────────────────────────────────────────────
HOSTNAME=$(hostname -s 2>/dev/null || hostname)
USERNAME=$(whoami)

# ── Time context ───────────────────────────────────────────────────────
TIMESTAMP=$(date -Iseconds)
DAY_OF_WEEK=$(date +%A)
HOUR=$(date +%H)
TIMEZONE=$(date +%Z)

# ── Harness resolution ────────────────────────────────────────────────
HARNESS=""
PROJECT_ROOT=""
OWN_PANE_ID=$(resolve_own_pane || true)
if [ -n "$OWN_PANE_ID" ] || [ -n "$SESSION_ID" ]; then
  hook_resolve_harness "${OWN_PANE_ID:-}" "${SESSION_ID:-}"
fi
if [ -n "$HARNESS" ]; then
  PROJECT_ROOT=$(harness_project_root "$HARNESS" 2>/dev/null || echo "")
  [ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

# ══════════════════════════════════════════════════════════════════════
# BUS PUBLISH
# ══════════════════════════════════════════════════════════════════════

# Build the bus event payload with all collected metadata
BUS_PAYLOAD=$(jq -n --compact-output \
  --arg type "prompt" \
  --arg sid "$SESSION_ID" \
  --arg harness "${HARNESS:-}" \
  --arg prompt "$PROMPT" \
  --arg hash "$DEDUP_HASH" \
  --arg cwd "$CWD" \
  --arg project "$PROJECT" \
  --arg ts "$TIMESTAMP" \
  --argjson char_count "$CHAR_COUNT" \
  --argjson word_count "$WORD_COUNT" \
  --argjson line_count "$LINE_COUNT" \
  --argjson has_code_block "$HAS_CODE_BLOCK" \
  --argjson has_url "$HAS_URL" \
  --argjson has_file_path "$HAS_FILE_PATH" \
  --argjson is_question "$IS_QUESTION" \
  --argjson is_slash_command "$IS_SLASH_COMMAND" \
  --arg slash_command "$SLASH_COMMAND" \
  --arg git_branch "$GIT_BRANCH" \
  --arg git_repo "$GIT_REPO" \
  --arg hostname "$HOSTNAME" \
  --arg username "$USERNAME" \
  --arg tz "$TIMEZONE" \
  --arg dow "$DAY_OF_WEEK" \
  --argjson hour "$HOUR" \
  '{
    type: $type,
    session_id: $sid,
    harness: (if $harness == "" then null else $harness end),
    prompt: $prompt,
    prompt_hash: $hash,
    metadata: {
      cwd: $cwd,
      project: $project,
      timestamp: $ts,
      timezone: $tz,
      day_of_week: $dow,
      hour: $hour,
      char_count: $char_count,
      word_count: $word_count,
      line_count: $line_count
    },
    content_flags: {
      has_code_block: $has_code_block,
      has_url: $has_url,
      has_file_path: $has_file_path,
      is_question: $is_question,
      is_slash_command: $is_slash_command,
      slash_command: (if $slash_command == "" then null else $slash_command end)
    },
    git: {
      branch: (if $git_branch == "" then null else $git_branch end),
      repo: (if $git_repo == "" then null else $git_repo end)
    },
    system: {
      hostname: $hostname,
      username: $username
    }
  }' 2>/dev/null) || true

# Publish to bus (non-fatal)
if [ -n "$BUS_PAYLOAD" ]; then
  bus_publish "prompt" "$BUS_PAYLOAD" 2>/dev/null || {
    echo "WARN: bus_publish failed for prompt event (session=$SESSION_ID)" >&2
  }
fi

# ── Worker → coordinator notification handled by bus side-effect ───────
# worker-prompt-notify.sh is registered in schema.json for the "prompt" event type.
# It fires automatically when the harness field in the bus event is a worker canonical
# (contains "/"), e.g. "hq-v3/ui-patrol". No inline code needed here.

# ── Always return pass-through ─────────────────────────────────────────
echo '{}'
exit 0
