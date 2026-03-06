#!/usr/bin/env bash
# worker-inbox.sh — Quick summary of worker outbox messages for the operator.
#
# Reads .claude/workers/.outbox-latest.jsonl (unified feed) and prints
# a human-readable summary filtered by time and type.
#
# Usage:
#   bash worker-inbox.sh                        # default: last 1h
#   bash worker-inbox.sh --since 30m            # last 30 minutes
#   bash worker-inbox.sh --since 1h             # last 1 hour
#   bash worker-inbox.sh --since 2h             # last 2 hours
#   bash worker-inbox.sh --since today          # since midnight UTC
#   bash worker-inbox.sh --type deploy-ready    # filter by msg_type
#   bash worker-inbox.sh --type blocked         # only blocked messages
#   bash worker-inbox.sh --worker chatbot-tools # filter by worker name
#   bash worker-inbox.sh --all                  # show all, no time filter

set -euo pipefail

# ── Resolve project root ─────────────────────────────────────────
_LIB_DIR="${CLAUDE_OPS_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-ops}}/lib"
if [ -f "$_LIB_DIR/event-bus.sh" ]; then
  source "$_LIB_DIR/event-bus.sh"
elif [ -f "$HOME/.claude-ops/lib/event-bus.sh" ]; then
  source "$HOME/.claude-ops/lib/event-bus.sh"
else
  echo "ERROR: event-bus.sh not found" >&2
  exit 1
fi

PROJECT_ROOT="${BUS_DIR%/.claude/bus}"
WORKERS_DIR="$PROJECT_ROOT/.claude/workers"
LATEST_FILE="$WORKERS_DIR/.outbox-latest.jsonl"

# Also run a sync pass first to catch any new events
SYNC_SCRIPT="${CLAUDE_OPS_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-ops}}/scripts/worker-outbox-sync.sh"
[ -f "$SYNC_SCRIPT" ] && bash "$SYNC_SCRIPT" --once 2>/dev/null || true

# ── Parse args ────────────────────────────────────────────────────
SINCE="1h"
TYPE_FILTER=""
WORKER_FILTER=""
SHOW_ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --type)  TYPE_FILTER="$2"; shift 2 ;;
    --worker) WORKER_FILTER="$2"; shift 2 ;;
    --all)   SHOW_ALL=true; shift ;;
    *) shift ;;
  esac
done

# ── Compute cutoff timestamp ─────────────────────────────────────
if $SHOW_ALL; then
  CUTOFF_ISO="1970-01-01T00:00:00Z"
else
  local_now=$(date -u +%s)
  case "$SINCE" in
    *m)
      minutes="${SINCE%m}"
      cutoff_epoch=$(( local_now - minutes * 60 ))
      ;;
    *h)
      hours="${SINCE%h}"
      cutoff_epoch=$(( local_now - hours * 3600 ))
      ;;
    today)
      cutoff_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "$(date -u +%Y-%m-%dT00:00:00)" "+%s" 2>/dev/null \
        || date -u -d "$(date -u +%Y-%m-%d)" "+%s" 2>/dev/null || echo "$local_now")
      ;;
    *)
      # Default 1h
      cutoff_epoch=$(( local_now - 3600 ))
      ;;
  esac
  CUTOFF_ISO=$(date -u -j -f "%s" "$cutoff_epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u -d "@$cutoff_epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")
fi

# ── Check for data ───────────────────────────────────────────────
if [ ! -f "$LATEST_FILE" ] || [ ! -s "$LATEST_FILE" ]; then
  echo "=== Worker Inbox (no messages) ==="
  echo "(No worker messages found. Workers can emit messages with: bash worker-bus-emit.sh <type> <message>)"
  exit 0
fi

# ── Build jq filter ──────────────────────────────────────────────
JQ_ARGS=(--arg cutoff "$CUTOFF_ISO")
JQ_FILTER='select(._ts >= $cutoff or .ts >= $cutoff)'

if [ -n "$TYPE_FILTER" ]; then
  JQ_ARGS+=(--arg mtype "$TYPE_FILTER")
  JQ_FILTER="$JQ_FILTER | select(.msg_type == \$mtype)"
fi

if [ -n "$WORKER_FILTER" ]; then
  JQ_ARGS+=(--arg wname "$WORKER_FILTER")
  JQ_FILTER="$JQ_FILTER | select(.worker == \$wname)"
fi

# ── Format output ────────────────────────────────────────────────
LABEL="last $SINCE"
$SHOW_ALL && LABEL="all time"

# Count matching events
COUNT=$(jq -c "${JQ_ARGS[@]}" "$JQ_FILTER" "$LATEST_FILE" 2>/dev/null | wc -l | tr -d '[:space:]')

echo "=== Worker Inbox ($LABEL) ==="

if [ "$COUNT" = "0" ]; then
  echo "(no messages)"
  exit 0
fi

# Print formatted lines, most recent last
jq -c "${JQ_ARGS[@]}" "$JQ_FILTER" "$LATEST_FILE" 2>/dev/null | while IFS= read -r line; do
  ts=$(echo "$line" | jq -r '._ts // .ts // ""' 2>/dev/null | sed 's/.*T//; s/Z$//')
  # Trim to HH:MM
  ts="${ts%:*}"
  worker=$(echo "$line" | jq -r '.worker // "?"' 2>/dev/null)
  severity=$(echo "$line" | jq -r '.severity // "info"' 2>/dev/null)
  msg_type=$(echo "$line" | jq -r '.msg_type // ._event_type // "?"' 2>/dev/null)
  message=$(echo "$line" | jq -r '.message // .msg // ""' 2>/dev/null)
  sha=$(echo "$line" | jq -r '.commit_sha // .sha // ""' 2>/dev/null)

  # Format: [HH:MM] worker (severity): msg_type — message [sha]
  suffix=""
  [ -n "$sha" ] && [ "$sha" != "" ] && suffix=", commit $sha"
  printf "[%s] %s (%s): %s — %s%s\n" "$ts" "$worker" "$severity" "$msg_type" "$message" "$suffix"
done

echo "---"
echo "$COUNT message(s)"
