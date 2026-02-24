#!/usr/bin/env bash
# 03-stale-cleanup.sh — Garbage collector for harness temp files.
#
# Cleans up:
#   - /tmp/harness_* files older than 24h (preserving control plane files)
#   - Dead entries in session registry (HARNESS_SESSION_REGISTRY)
#   - Orphaned /tmp/tmux_pane_{meta,status,session}_* files
#   - /tmp/claude_activity_*.jsonl older than 48h
#   - /tmp/claude_rotation_advisory_* older than 24h
#   - /tmp/claude_allow_stop_* older than 24h
#   - Expired beads (wisps and claims) in harness-beads.json
#
# Contract:
#   --interval         Print interval in seconds and exit
#   --check            Dry-run, print what would change as JSON lines
#   --run              Execute and print JSON lines to stdout
#   --project <path>   Target a specific project
set -euo pipefail

SWEEP_NAME="stale-cleanup"
source "$HOME/.claude-ops/lib/sweep-config.sh"
load_sweep_config "$SWEEP_NAME"

PROJECT_ROOT=""
DRY_RUN=false
MODE=""

HARNESS_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) echo "$SWEEP_INTERVAL"; exit 0 ;;
    --scope)    echo "$SWEEP_SCOPE"; exit 0 ;;
    --check)    DRY_RUN=true; MODE="check"; shift ;;
    --run)      MODE="run"; shift ;;
    --project)  PROJECT_ROOT="$2"; shift 2 ;;
    --harness)  HARNESS_NAME="$2"; shift 2 ;;
    *)          echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "Usage: $0 --interval | --check | --run [--harness <name>|--project <path>]" >&2
  exit 1
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

emit() {
  local action="$1" target="$2" reason="$3"
  printf '{"ts":"%s","type":"sweep","name":"%s","action":"%s","target":"%s","reason":"%s"}\n' \
    "$(ts)" "$SWEEP_NAME" "$action" "$target" "$reason"
}

source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY="$HARNESS_SESSION_REGISTRY"
NOW=$(now_epoch)
TWENTY_FOUR_H=$(( NOW - 86400 ))
FORTY_EIGHT_H=$(( NOW - 172800 ))

# Protected files that should never be cleaned
PROTECTED_FILES="harness_health.json harness_metrics.jsonl harness_control_plane.pid harness_sweep_state.json"

is_protected() {
  local basename
  basename=$(basename "$1")
  for pf in $PROTECTED_FILES; do
    [ "$basename" = "$pf" ] && return 0
  done
  return 1
}

# ── 1. Clean /tmp/harness_* older than 24h ──────────────────────────────
for f in /tmp/harness_*; do
  [ -e "$f" ] || continue
  is_protected "$f" && continue

  # Get file modification time as epoch
  if [[ "$(uname)" == "Darwin" ]]; then
    file_mtime=$(stat -f %m "$f" 2>/dev/null || echo "$NOW")
  else
    file_mtime=$(stat -c %Y "$f" 2>/dev/null || echo "$NOW")
  fi

  if [ "$file_mtime" -lt "$TWENTY_FOUR_H" ]; then
    if [ "$DRY_RUN" = true ]; then
      emit "would_remove" "$f" "older than 24h"
    else
      rm -f "$f"
      emit "removed" "$f" "older than 24h"
    fi
  fi
done

# ── 2. Prune dead entries from registry ──────────────────────────────────
if [ -f "$REGISTRY" ]; then
  # Read all session IDs
  SESSION_IDS=$(jq -r 'keys[]' "$REGISTRY" 2>/dev/null || echo "")

  DEAD_SESSIONS=()
  for sid in $SESSION_IDS; do
    [ -z "$sid" ] && continue

    # Check if any tmux pane has a /tmp/tmux_pane_session_* file referencing this session
    FOUND=false
    for sf in /tmp/tmux_pane_session_*; do
      [ -e "$sf" ] || continue
      if jq -e --arg sid "$sid" 'select(.session_id == $sid)' "$sf" >/dev/null 2>&1; then
        # Found a session file, check if the pane exists
        PANE_ID=$(basename "$sf" | sed 's/^tmux_pane_session_//')
        if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qF "$PANE_ID"; then
          FOUND=true
          break
        fi
      fi
    done

    # Also check: scan tmux panes for the session_id in their content (fallback)
    if [ "$FOUND" = false ]; then
      ALL_PANES=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || echo "")
      for pane in $ALL_PANES; do
        [ -z "$pane" ] && continue
        if tmux capture-pane -t "$pane" -p 2>/dev/null | grep -qF "$sid"; then
          FOUND=true
          break
        fi
      done
    fi

    if [ "$FOUND" = false ]; then
      DEAD_SESSIONS+=("$sid")
      if [ "$DRY_RUN" = true ]; then
        emit "would_prune_registry" "$sid" "pane gone"
      else
        emit "pruned_registry" "$sid" "pane gone"
      fi
    fi
  done

  # Actually remove dead sessions from registry
  if [ "$DRY_RUN" = false ] && [ "${#DEAD_SESSIONS[@]}" -gt 0 ]; then
    TMP=$(mktemp)
    JQ_FILTER="."
    for sid in "${DEAD_SESSIONS[@]}"; do
      JQ_FILTER="$JQ_FILTER | del(.[\"$sid\"])"
    done
    jq "$JQ_FILTER" "$REGISTRY" > "$TMP" && mv "$TMP" "$REGISTRY"
  fi
fi

# ── 3. Clean orphaned tmux pane files ────────────────────────────────────
ALL_PANE_IDS=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || echo "")

for prefix in tmux_pane_meta tmux_pane_status tmux_pane_session; do
  for f in /tmp/${prefix}_*; do
    [ -e "$f" ] || continue
    PANE_ID=$(basename "$f" | sed "s/^${prefix}_//")
    if ! echo "$ALL_PANE_IDS" | grep -qF "$PANE_ID"; then
      if [ "$DRY_RUN" = true ]; then
        emit "would_remove" "$f" "pane $PANE_ID gone"
      else
        rm -f "$f"
        emit "removed" "$f" "pane $PANE_ID gone"
      fi
    fi
  done
done

# ── 4. Clean /tmp/claude_activity_*.jsonl older than 48h ─────────────────
for f in /tmp/claude_activity_*.jsonl; do
  [ -e "$f" ] || continue
  if [[ "$(uname)" == "Darwin" ]]; then
    file_mtime=$(stat -f %m "$f" 2>/dev/null || echo "$NOW")
  else
    file_mtime=$(stat -c %Y "$f" 2>/dev/null || echo "$NOW")
  fi
  if [ "$file_mtime" -lt "$FORTY_EIGHT_H" ]; then
    if [ "$DRY_RUN" = true ]; then
      emit "would_remove" "$f" "older than 48h"
    else
      rm -f "$f"
      emit "removed" "$f" "older than 48h"
    fi
  fi
done

# ── 5. Clean /tmp/claude_rotation_advisory_* older than 24h ──────────────
for f in /tmp/claude_rotation_advisory_*; do
  [ -e "$f" ] || continue
  if [[ "$(uname)" == "Darwin" ]]; then
    file_mtime=$(stat -f %m "$f" 2>/dev/null || echo "$NOW")
  else
    file_mtime=$(stat -c %Y "$f" 2>/dev/null || echo "$NOW")
  fi
  if [ "$file_mtime" -lt "$TWENTY_FOUR_H" ]; then
    if [ "$DRY_RUN" = true ]; then
      emit "would_remove" "$f" "older than 24h"
    else
      rm -f "$f"
      emit "removed" "$f" "older than 24h"
    fi
  fi
done

# ── 6. Clean /tmp/claude_allow_stop_* older than 24h ─────────────────────
for f in /tmp/claude_allow_stop_*; do
  [ -e "$f" ] || continue
  if [[ "$(uname)" == "Darwin" ]]; then
    file_mtime=$(stat -f %m "$f" 2>/dev/null || echo "$NOW")
  else
    file_mtime=$(stat -c %Y "$f" 2>/dev/null || echo "$NOW")
  fi
  if [ "$file_mtime" -lt "$TWENTY_FOUR_H" ]; then
    if [ "$DRY_RUN" = true ]; then
      emit "would_remove" "$f" "older than 24h"
    else
      rm -f "$f"
      emit "removed" "$f" "older than 24h"
    fi
  fi
done

# ── 7. Clean expired beads ───────────────────────────────────────────────
if [ -n "$PROJECT_ROOT" ]; then
  BEADS="$PROJECT_ROOT/claude_files/harness-beads.json"
else
  # Default project
  BEADS="/Users/wz/Desktop/zPersonalProjects/Wechat/claude_files/harness-beads.json"
fi

if [ -f "$BEADS" ]; then
  # Count expired wisps and claims before cleanup
  EXPIRED_WISPS=$(jq --argjson now "$NOW" \
    '[.wisps // [] | .[] | select(.expires < $now)] | length' "$BEADS" 2>/dev/null || echo "0")
  EXPIRED_CLAIMS=$(jq --argjson now "$NOW" \
    '[.claims // {} | to_entries[] | select(.value.expires < $now)] | length' "$BEADS" 2>/dev/null || echo "0")

  if [ "$EXPIRED_WISPS" -gt 0 ] || [ "$EXPIRED_CLAIMS" -gt 0 ]; then
    if [ "$DRY_RUN" = true ]; then
      emit "would_gc_beads" "$BEADS" "expired wisps=$EXPIRED_WISPS claims=$EXPIRED_CLAIMS"
    else
      TMP=$(mktemp)
      jq --argjson now "$NOW" '
        .wisps = [(.wisps // [])[] | select(.expires >= $now)] |
        .claims = ((.claims // {}) | with_entries(select(.value.expires >= $now)))
      ' "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"
      emit "gc_beads" "$BEADS" "removed wisps=$EXPIRED_WISPS claims=$EXPIRED_CLAIMS"
    fi
  fi
fi

# ── 8. Clean dead panes in cp:sweeps ─────────────────────────────────
if tmux has-session -t cp 2>/dev/null; then
  CP_PANES=$(tmux list-panes -t cp:sweeps -F '#{pane_id} #{pane_pid}' 2>/dev/null || echo "")
  while IFS=' ' read -r pane_id pid; do
    [ -z "$pane_id" ] && continue
    [ -z "$pid" ] && continue
    if ! kill -0 "$pid" 2>/dev/null; then
      if [ "$DRY_RUN" = true ]; then
        emit "would_kill_pane" "$pane_id" "dead shell pid=$pid in cp:sweeps"
      else
        tmux kill-pane -t "$pane_id" 2>/dev/null || true
        emit "killed_pane" "$pane_id" "dead shell pid=$pid in cp:sweeps"
      fi
    fi
  done <<< "$CP_PANES"
fi

# ── 9. Clean orphaned /tmp/monitor-agent-* directories ───────────────────
ALL_PANE_IDS_FOR_MONITOR=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || echo "")
for d in /tmp/monitor-agent-*/; do
  [ -d "$d" ] || continue
  ORPHANED=false
  if [ -f "$d/worker-pane-id" ]; then
    # New format: check worker pane_id still exists
    WID=$(cat "$d/worker-pane-id" 2>/dev/null || echo "")
    if [ -n "$WID" ]; then
      echo "$ALL_PANE_IDS_FOR_MONITOR" | grep -qF "$WID" || ORPHANED=true
    else
      ORPHANED=true
    fi
  elif [ -f "$d/daemon.pid" ]; then
    # Old format or no worker-pane-id: check daemon process + age
    DPID=$(cat "$d/daemon.pid" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$DPID" ] && ! kill -0 "$DPID" 2>/dev/null; then
      # Daemon dead — check age before cleaning
      if [[ "$(uname)" == "Darwin" ]]; then
        file_mtime=$(stat -f %m "$d/daemon.pid" 2>/dev/null || echo "$NOW")
      else
        file_mtime=$(stat -c %Y "$d/daemon.pid" 2>/dev/null || echo "$NOW")
      fi
      [ "$file_mtime" -lt "$TWENTY_FOUR_H" ] && ORPHANED=true
    fi
  else
    # No worker-pane-id and no daemon.pid — orphaned
    ORPHANED=true
  fi
  if [ "$ORPHANED" = true ]; then
    # Kill daemon if still alive, then remove dir
    if [ -f "$d/daemon.pid" ]; then
      DPID=$(cat "$d/daemon.pid" 2>/dev/null | tr -d '[:space:]')
      [ -n "$DPID" ] && kill "$DPID" 2>/dev/null || true
    fi
    if [ "$DRY_RUN" = true ]; then
      emit "would_remove" "$d" "orphaned monitor state"
    else
      rm -rf "$d"
      emit "removed" "$d" "orphaned monitor state"
    fi
  fi
done

exit 0
