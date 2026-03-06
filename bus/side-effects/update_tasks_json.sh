#!/usr/bin/env bash
# update_tasks_json.sh — Bus side-effect: sync task status in tasks.json
#
# Fires on:  task.started  → sets status=in_progress
#            task.completed → sets status=completed, writes summary
#
# Payload (from bus event):
#   { "_event_type": "task.started", "harness": "mod-customer", "task_id": "t3" }
#   { "_event_type": "task.completed", "harness": "mod-customer", "task_id": "t3", "summary": "..." }
#
# Invoked by: bus_publish() side-effect runner.
# PROJECT_ROOT is set by the caller.

set -euo pipefail
source "${HOME}/.claude-ops/lib/fleet-jq.sh"

PAYLOAD=$(cat)
EVENT_TYPE=$(echo "$PAYLOAD" | jq -r '._event_type // empty')
HARNESS=$(echo "$PAYLOAD" | jq -r '.harness // empty')
TASK_ID=$(echo "$PAYLOAD" | jq -r '.task_id // empty')

# Require all three fields
[ -z "$EVENT_TYPE" ] && exit 0
[ -z "$HARNESS" ] && exit 0
[ -z "$TASK_ID" ] && exit 0

TASKS_FILE="${PROJECT_ROOT:-$(pwd)}/.claude/harness/${HARNESS}/tasks.json"
[ -f "$TASKS_FILE" ] || { echo "update_tasks_json: tasks.json not found at $TASKS_FILE" >&2; exit 0; }

case "$EVENT_TYPE" in
  task.started)
    # Idempotency: skip if task already in_progress
    CURRENT_STATUS=$(jq -r --arg tid "$TASK_ID" '.tasks[$tid].status // ""' "$TASKS_FILE" 2>/dev/null || echo "")
    [ "$CURRENT_STATUS" = "in_progress" ] && exit 0
    locked_jq_write "$TASKS_FILE" "update-tasks-$$" \
      'if .tasks[$tid] then (.tasks[$tid].status = "in_progress") else . end' \
      --arg tid "$TASK_ID"
    ;;
  task.completed)
    # Idempotency: skip if task already completed
    CURRENT_STATUS=$(jq -r --arg tid "$TASK_ID" '.tasks[$tid].status // ""' "$TASKS_FILE" 2>/dev/null || echo "")
    [ "$CURRENT_STATUS" = "completed" ] && exit 0
    SUMMARY=$(echo "$PAYLOAD" | jq -r '.summary // ""')
    locked_jq_write "$TASKS_FILE" "update-tasks-$$" \
      'if .tasks[$tid] then (.tasks[$tid] |= (.status = "completed" | .result = $sum)) else . end' \
      --arg tid "$TASK_ID" --arg sum "$SUMMARY"
    ;;
  *)
    exit 0
    ;;
esac
