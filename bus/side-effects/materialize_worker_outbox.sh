#!/usr/bin/env bash
# materialize_worker_outbox.sh — Side-effect script for worker.message and worker.commit events.
#
# Called by the event bus after publishing worker.message or worker.commit events.
# Reads the event payload from stdin and appends it to:
#   1. .claude/workers/{worker_name}/outbox.jsonl  (per-worker)
#   2. .claude/workers/.outbox-latest.jsonl         (unified feed)
#
# This is the real-time materializer (fires per-event).
# worker-outbox-sync.sh is the batch catch-up materializer (cursor-based).

set -euo pipefail

payload=$(cat)

# Extract worker name from payload
worker=$(echo "$payload" | jq -r '.worker // ""' 2>/dev/null || echo "")
[ -z "$worker" ] && exit 0

# Resolve project root from PROJECT_ROOT env (set by bus side-effect runner)
pr="${PROJECT_ROOT:-.}"
workers_dir="$pr/.claude/workers"

# Ensure directories exist
mkdir -p "$workers_dir/$worker" 2>/dev/null || true

# Append to per-worker outbox
echo "$payload" >> "$workers_dir/$worker/outbox.jsonl"

# Append to unified latest feed
echo "$payload" >> "$workers_dir/.outbox-latest.jsonl"

# Desktop notification for urgent messages
severity=$(echo "$payload" | jq -r '.severity // "info"' 2>/dev/null || echo "info")
if [ "$severity" = "urgent" ]; then
  msg_type=$(echo "$payload" | jq -r '.msg_type // "message"' 2>/dev/null || echo "message")
  message=$(echo "$payload" | jq -r '.message // ""' 2>/dev/null || echo "")
  if command -v notify &>/dev/null; then
    notify "[$worker] $msg_type: $message" "Worker Alert" 2>/dev/null || true
  fi
fi
