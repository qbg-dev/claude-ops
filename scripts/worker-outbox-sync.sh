#!/usr/bin/env bash
# worker-outbox-sync.sh — Catch-up materializer for worker.message/worker.commit bus events.
#
# The primary materializer is the `materialize_worker_outbox` bus side-effect,
# which fires in real-time after each bus_publish. This script is the catch-up
# mechanism for events that the side-effect might have missed (e.g., if the
# side-effect script wasn't installed when events were published).
#
# Uses bus consumer cursor system for idempotent reads. Each event is checked
# against the per-worker outbox by _seq before appending to prevent duplicates.
#
# Usage:
#   bash worker-outbox-sync.sh [--once|--daemon]
#   --once:   single pass, process new events since last sync (default)
#   --daemon: loop every 15s

set -euo pipefail

# ── Resolve project root (handle worktrees) ──────────────────────
_LIB_DIR="${CLAUDE_OPS_DIR:-${BORING_DIR:-$HOME/.boring}}/lib"
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
CONSUMER_ID="outbox-sync"

MODE="once"
[ "${1:-}" = "--daemon" ] && MODE="daemon"
[ "${1:-}" = "--once" ] && MODE="once"

mkdir -p "$WORKERS_DIR"

# ── Sync function ────────────────────────────────────────────────
sync_once() {
  [ ! -f "$BUS_STREAM" ] && return 0

  # Read unprocessed events from bus using consumer cursor
  # bus_read advances the cursor automatically
  local events
  events=$(bus_read "$CONSUMER_ID" --limit 200 2>/dev/null || echo "[]")

  # Filter for worker.message and worker.commit, then materialize
  echo "$events" | jq -c '.[] | select(._event_type == "worker.message" or ._event_type == "worker.commit")' 2>/dev/null | while IFS= read -r line; do
    [ -z "$line" ] && continue

    local worker_name seq_val
    worker_name=$(echo "$line" | jq -r '.worker // ""' 2>/dev/null || echo "")
    seq_val=$(echo "$line" | jq -r '._seq // ""' 2>/dev/null || echo "")
    [ -z "$worker_name" ] && continue

    mkdir -p "$WORKERS_DIR/$worker_name"
    local worker_outbox="$WORKERS_DIR/$worker_name/outbox.jsonl"

    # Dedup: skip if _seq already exists in per-worker outbox
    if [ -n "$seq_val" ] && [ -f "$worker_outbox" ]; then
      if grep -qF "\"_seq\":${seq_val}," "$worker_outbox" 2>/dev/null; then
        continue
      fi
    fi

    # Append to per-worker outbox
    echo "$line" >> "$worker_outbox"

    # Dedup for unified feed too
    if [ -n "$seq_val" ] && [ -f "$LATEST_FILE" ]; then
      if grep -qF "\"_seq\":${seq_val}," "$LATEST_FILE" 2>/dev/null; then
        continue
      fi
    fi

    echo "$line" >> "$LATEST_FILE"
  done
}

# ── Main ─────────────────────────────────────────────────────────
if [ "$MODE" = "once" ]; then
  sync_once
elif [ "$MODE" = "daemon" ]; then
  while true; do
    sync_once
    sleep 15
  done
fi
