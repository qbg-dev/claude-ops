#!/bin/bash
# ECHO Stop Hook v2 — chain + repeat support
# Reads JSON state, pops next chain item, injects as block reason

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
log() { echo "[$(date -Iseconds)] STOP: $1" >> "$DEBUG_LOG"; }

INPUT=$(cat)
# Subagents don't participate in echo chains
echo "$INPUT" | jq -e '.agent_id // empty' &>/dev/null && exit 0
log "Stop hook started"
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
if [[ -z "$SESSION_ID" ]]; then
  log "ERROR: session_id missing"
  exit 0
fi
_SESSION_DIR=$(_echo_session_dir "$SESSION_ID")
STATE_FILE="$_SESSION_DIR/echo-state.json"

# No stop_hook_active check — loop prevention via state depletion + max_iterations

if [[ ! -f "$STATE_FILE" ]]; then
  log "No state file, allowing stop"
  exit 0
fi

STATE=$(<"$STATE_FILE")
if ! echo "$STATE" | jq -e '.chain' >/dev/null 2>&1; then
  log "ERROR: invalid JSON, cleaning up"
  rm -f "$STATE_FILE"
  exit 0
fi

CHAIN_LEN=$(echo "$STATE" | jq '.chain | length')
ITERATION=$(echo "$STATE" | jq '.iteration')
MAX=$(echo "$STATE" | jq '.max')

if (( ITERATION >= MAX )); then
  log "Max iterations ($ITERATION >= $MAX), allowing stop"
  rm -f "$STATE_FILE"
  exit 0
fi

if (( CHAIN_LEN == 0 )); then
  log "Chain empty, allowing stop"
  rm -f "$STATE_FILE"
  exit 0
fi

# Pop first item
ITEM=$(echo "$STATE" | jq -r '.chain[0]')
log "Pop [$ITERATION]: '$ITEM' ($CHAIN_LEN remaining)"

# Update state
UPDATED=$(echo "$STATE" | jq '{chain: .chain[1:], iteration: (.iteration + 1), max: .max}')
NEW_LEN=$(echo "$UPDATED" | jq '.chain | length')

if (( NEW_LEN == 0 )); then
  rm -f "$STATE_FILE"
  log "Last item, state file removed"
else
  temp_file="${STATE_FILE}.$$"
  echo "$UPDATED" > "$temp_file"
  mv "$temp_file" "$STATE_FILE"
  log "State updated: $NEW_LEN items remaining"
fi

# Enrich via snippet_injector.py
INJECTOR="/Users/wz/.claude-ops/plugins/claude-context-orchestrator/scripts/snippets/snippet_injector.py"
if [[ -f "$INJECTOR" ]]; then
  ENRICHMENT=$(printf '{"prompt": %s, "session_id": "%s"}' \
    "$(printf '%s' "$ITEM" | jq -Rs .)" "$SESSION_ID" \
    | python3 "$INJECTOR" 2>/dev/null)
  if [[ -n "$ENRICHMENT" ]]; then
    ITEM="${ENRICHMENT}

${ITEM}"
    log "Enriched (${#ENRICHMENT} chars)"
  fi
fi

jq -n --arg reason "$ITEM" '{"decision": "block", "reason": $reason}'
exit 0
