#!/bin/bash
# ECHO UserPromptSubmit Hook v4 — XML-style parsing
# Patterns: <echo> content </echo>, <echo3> content </echo>
# Multiple <echo> tags in one prompt are all collected into a single chain.
# Repeat: <echo{N}> repeats content N times (max 10). <echo0> is a no-op.

# Source path helpers (inline if fleet-jq.sh not available)
HARNESS_STATE_DIR="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
_echo_session_dir() {
  local dir="$HARNESS_STATE_DIR/sessions/$1"
  mkdir -p "$dir" 2>/dev/null
  echo "$dir"
}
_echo_logs_dir() {
  local dir="$HARNESS_STATE_DIR/logs"
  mkdir -p "$dir" 2>/dev/null
  echo "$dir"
}

DEBUG_LOG="$(_echo_logs_dir)/echo-hooks.log"
log() { echo "[$(date -Iseconds)] SUBMIT: $1" >> "$DEBUG_LOG"; }

INPUT=$(cat)
# Subagents don't participate in echo chains
echo "$INPUT" | jq -e '.agent_id // empty' &>/dev/null && exit 0
log "Hook started"
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
if [[ -z "$SESSION_ID" ]]; then
  log "ERROR: session_id missing"
  exit 0
fi
_SESSION_DIR=$(_echo_session_dir "$SESSION_ID")
STATE_FILE="$_SESSION_DIR/echo-state.json"
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

# Persist session ID so migration scripts can find it
echo "$SESSION_ID" > "$HARNESS_STATE_DIR/current-session-id"

# Cleanup stale echo state files older than 2 hours
find "$HARNESS_STATE_DIR/sessions" -name "echo-state.json" -mmin +120 -delete 2>/dev/null

# Collect all <echo{n}> content </echo> patterns from the prompt
# Uses perl for non-greedy XML-style matching (bash regex can't do this reliably)
FULL_CHAIN=()

# Use null-delimited output so multi-line content stays as one item
while IFS= read -r -d '' line; do
  [[ -z "$line" ]] && continue
  REPEAT=$(printf '%s' "$line" | head -1 | cut -d$'\t' -f1)
  CONTENT=$(printf '%s' "$line" | head -1 | cut -d$'\t' -f2-)
  # Re-attach remaining lines (content after the first line)
  REST=$(printf '%s' "$line" | tail -n +2)
  if [[ -n "$REST" ]]; then
    CONTENT="${CONTENT}
${REST}"
  fi
  [[ -z "$REPEAT" ]] && REPEAT=1
  (( REPEAT > 10 )) && REPEAT=10

  if (( REPEAT == 0 )); then
    log "ECHO0 detected, skipping"
    continue
  fi

  for ((r=0; r<REPEAT; r++)); do
    FULL_CHAIN+=("$CONTENT")
  done

  log "ECHO: repeat=$REPEAT, content='${CONTENT:0:80}'"
done < <(printf '%s' "$PROMPT" | perl -0777 -ne 'while (/<echo(\d*)>\s*(.*?)\s*<\/echo\d*>/gsi) { print(($1 eq "" ? 1 : $1) . "\t" . $2 . "\0"); }')

# Build JSON array from FULL_CHAIN preserving newlines within items
# Uses null-delimited printf + jq -Rs to avoid splitting on newlines
chain_to_json() {
  local arr=("$@")
  local json="["
  local first=true
  for item in "${arr[@]}"; do
    if $first; then first=false; else json+=","; fi
    json+=$(printf '%s' "$item" | jq -Rs .)
  done
  json+="]"
  echo "$json"
}

# If we found any ECHO patterns, write/update the state file
if [[ ${#FULL_CHAIN[@]} -gt 0 ]]; then
  NEW_ITEMS=$(chain_to_json "${FULL_CHAIN[@]}")

  if [[ -f "$STATE_FILE" ]]; then
    EXISTING=$(<"$STATE_FILE")
    if echo "$EXISTING" | jq -e '.chain' >/dev/null 2>&1; then
      EXISTING_CHAIN=$(echo "$EXISTING" | jq '.chain')
      EXISTING_ITER=$(echo "$EXISTING" | jq '.iteration')
      EXISTING_MAX=$(echo "$EXISTING" | jq '.max')
      MERGED_CHAIN=$(jq -n --argjson a "$EXISTING_CHAIN" --argjson b "$NEW_ITEMS" '$a + $b')
      NEW_MAX=$(( EXISTING_MAX + ${#FULL_CHAIN[@]} ))
      (( NEW_MAX > 20 )) && NEW_MAX=20
      STATE_JSON=$(jq -n \
        --argjson chain "$MERGED_CHAIN" \
        --argjson iteration "$EXISTING_ITER" \
        --argjson max "$NEW_MAX" \
        '{chain: $chain, iteration: $iteration, max: $max}')
      log "ECHO: APPENDED ${#FULL_CHAIN[@]} items to existing chain (now $NEW_MAX max)"
    else
      MAX_ITER=${#FULL_CHAIN[@]}
      (( MAX_ITER > 20 )) && MAX_ITER=20
      STATE_JSON=$(jq -n \
        --argjson chain "$NEW_ITEMS" \
        --argjson iteration 0 \
        --argjson max "$MAX_ITER" \
        '{chain: $chain, iteration: $iteration, max: $max}')
      log "ECHO: total=${#FULL_CHAIN[@]}, max=$MAX_ITER (replaced corrupt state)"
    fi
  else
    MAX_ITER=${#FULL_CHAIN[@]}
    (( MAX_ITER > 20 )) && MAX_ITER=20
    STATE_JSON=$(jq -n \
      --argjson chain "$NEW_ITEMS" \
      --argjson iteration 0 \
      --argjson max "$MAX_ITER" \
      '{chain: $chain, iteration: $iteration, max: $max}')
    log "ECHO: total=${#FULL_CHAIN[@]}, max=$MAX_ITER (new state)"
  fi

  temp_file="${STATE_FILE}.$$"
  echo "$STATE_JSON" > "$temp_file"
  mv "$temp_file" "$STATE_FILE"
fi

log "Hook complete"
exit 0
