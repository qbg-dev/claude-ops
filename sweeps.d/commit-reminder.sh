#!/usr/bin/env bash
# 05-commit-reminder.sh — Checks for uncommitted work piling up.
#
# If modified files exceed COMMIT_REMINDER_FILE_THRESHOLD (default 20) and
# last commit was more than COMMIT_REMINDER_STALE_MIN (default 30) minutes ago,
# sends a wisp to all active harnesses via the beads file.
#
# Contract:
#   --interval         Print interval in seconds and exit
#   --check            Dry-run, print what would change as JSON lines
#   --run              Execute and print JSON lines to stdout
#   --project <path>   Target a specific project
set -euo pipefail

SWEEP_NAME="commit-reminder"
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

# Resolve PROJECT_ROOT: --harness (via manifest) > --project > default
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true
if [ -n "$HARNESS_NAME" ] && [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT=$(harness_project_root "$HARNESS_NAME" 2>/dev/null)
fi
if [ -z "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="/Users/wz/Desktop/zPersonalProjects/Wechat"
fi

if [ ! -d "$PROJECT_ROOT/.git" ]; then
  echo "ERROR: $PROJECT_ROOT is not a git repository" >&2
  exit 1
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

# ── Load config ──────────────────────────────────────────────────────────
COMMIT_REMINDER_FILE_THRESHOLD=20
COMMIT_REMINDER_STALE_MIN=30

CONFIG="$HOME/.claude-ops/control-plane.conf"
if [ -f "$CONFIG" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG"
fi

# ── Check git state ──────────────────────────────────────────────────────
MODIFIED_FILES=$(git -C "$PROJECT_ROOT" diff --stat 2>/dev/null | wc -l | tr -d ' ')
# Also count untracked files
UNTRACKED=$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
TOTAL_CHANGED=$((MODIFIED_FILES + UNTRACKED))

NOW=$(now_epoch)

# Get last commit time
LAST_COMMIT_TS=$(git -C "$PROJECT_ROOT" log -1 --format=%ct 2>/dev/null || echo "0")
if [ "$LAST_COMMIT_TS" = "0" ]; then
  # No commits yet
  MINUTES_SINCE_COMMIT=9999
else
  MINUTES_SINCE_COMMIT=$(( (NOW - LAST_COMMIT_TS) / 60 ))
fi

# ── Evaluate thresholds ─────────────────────────────────────────────────
if [ "$TOTAL_CHANGED" -gt "$COMMIT_REMINDER_FILE_THRESHOLD" ] && \
   [ "$MINUTES_SINCE_COMMIT" -gt "$COMMIT_REMINDER_STALE_MIN" ]; then

  BEADS="$PROJECT_ROOT/claude_files/harness-beads.json"

  # Initialize beads file if missing
  if [ ! -f "$BEADS" ]; then
    echo '{"wisps":[],"claims":{},"gates":{}}' > "$BEADS"
  fi

  MSG="${TOTAL_CHANGED} uncommitted files, last commit ${MINUTES_SINCE_COMMIT}m ago. Consider committing."
  WISP_ID="commit-reminder-${NOW}"
  EXPIRES=$(( NOW + 3600 ))

  if [ "$DRY_RUN" = true ]; then
    printf '{"ts":"%s","type":"sweep","name":"%s","action":"would_send_wisp","modified_files":%d,"last_commit_min_ago":%d,"msg":"%s"}\n' \
      "$(ts)" "$SWEEP_NAME" "$TOTAL_CHANGED" "$MINUTES_SINCE_COMMIT" "$MSG"
  else
    # Write wisp to beads file atomically
    TMP=$(mktemp)
    jq --arg id "$WISP_ID" \
       --arg msg "$MSG" \
       --arg ts_val "$(ts)" \
       --argjson exp "$EXPIRES" \
      '.wisps += [{"id":$id,"from":"control-plane","to":"all","msg":$msg,"ts":$ts_val,"expires":$exp,"read":false}]' \
      "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"

    printf '{"ts":"%s","type":"sweep","name":"%s","action":"wisp_sent","modified_files":%d,"last_commit_min_ago":%d}\n' \
      "$(ts)" "$SWEEP_NAME" "$TOTAL_CHANGED" "$MINUTES_SINCE_COMMIT"
  fi
else
  printf '{"ts":"%s","type":"sweep","name":"%s","action":"ok","modified_files":%d}\n' \
    "$(ts)" "$SWEEP_NAME" "$TOTAL_CHANGED"
fi

exit 0
