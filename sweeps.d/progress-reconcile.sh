#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# 04-progress-reconcile.sh — Task state reconciliation sweep
# ══════════════════════════════════════════════════════════════════
# Architecture: bash gathers task states + activity data, Claude agent
# analyzes whether reality matches the plan. No hardcoded staleness
# thresholds — the LLM decides what's concerning.
#
# Contract:
#   --interval            Print interval (600s) and exit
#   --check               Gather context only, print what agent would see
#   --run                 Gather context + spawn agent
#   --project <path>      Target a specific project root
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SWEEP_NAME="progress-reconcile"
source "$HOME/.claude-ops/lib/sweep-config.sh"
load_sweep_config "$SWEEP_NAME"

CONF="${HOME}/.claude-ops/control-plane.conf"
CONTEXT_FILE="/tmp/harness_sweep_04_context.md"

# ── Load control-plane config (for non-sweep vars) ──────────────
if [ -f "$CONF" ]; then
  source "$CONF"
fi

# ── Shared infrastructure ────────────────────────────────────────
source "${HOME}/.claude-ops/lib/spawn-sweep-agent.sh"

# ── Helpers ──────────────────────────────────────────────────────
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Source harness-jq for task graph queries
HARNESS_LIB="${HOME}/.claude-ops/lib/harness-jq.sh"
[ -f "$HARNESS_LIB" ] && source "$HARNESS_LIB"

# ── CLI parsing ──────────────────────────────────────────────────
MODE=""
PROJECT_ROOT_ARG=""
HARNESS_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) echo "$SWEEP_INTERVAL"; exit 0 ;;
    --scope)    echo "$SWEEP_SCOPE"; exit 0 ;;
    --check)    MODE="check"; shift ;;
    --run)      MODE="run"; shift ;;
    --project)  PROJECT_ROOT_ARG="$2"; shift 2 ;;
    --harness)  HARNESS_NAME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$MODE" ] && { echo "Usage: $0 [--interval|--check|--run] [--harness <name>|--project <path>]" >&2; exit 1; }

if [ -n "$HARNESS_NAME" ]; then
  PROJECT_ROOT=$(harness_project_root "$HARNESS_NAME" 2>/dev/null)
elif [ -n "$PROJECT_ROOT_ARG" ]; then
  PROJECT_ROOT="$PROJECT_ROOT_ARG"
else
  PROJECT_ROOT="${PROJECT_ROOT:-}"
fi
[ -z "$PROJECT_ROOT" ] && { echo "ERROR: No project root." >&2; exit 1; }

# ══════════════════════════════════════════════════════════════════
# PHASE 1: Gather raw context
# ══════════════════════════════════════════════════════════════════

{
cat <<'HEADER'
# Progress Reconciliation — Context for Agent

You are a progress reconciliation agent spawned by the harness control plane.
Your job is to compare desired state (task graphs) against actual state (activity, git).

## Your Mission

Analyze each active harness below and determine:

1. **Is the agent working?** Check activity logs — is there recent tool use?
2. **Is it working on the right thing?** Compare current task in progress.json vs what
   files the agent is actually touching in the activity log.
3. **Are completed tasks really done?** Check if "completed" tasks have corresponding
   git changes or test evidence.
4. **Is anything stuck?** Tasks that have been in_progress for a long time with no progress.
5. **Are all tasks done?** If so, should the harness evolve or deactivate?

## Actions You Can Take

For any issues found, write **wisps** (notifications) to the beads file:

```bash
# Read the beads file
cat claude_files/harness-beads.json

# Add a wisp (use Edit tool to append to the wisps array):
# {"id":"reconcile-{harness}-{timestamp}","from":"control-plane","to":"{harness}",
#  "msg":"your message","read":false,"expires":{now+1800}}
```

- **Stale tasks** → wisp to that harness: "Task X has been in_progress with no activity"
- **Idle harness** → wisp: "No agent activity detected but N tasks remain"
- **All done** → wisp: "All tasks completed — consider evolving or deactivating"
- **Everything OK** → no action needed, just note it in your report

## Triage

Not every harness needs attention. Skip harnesses where:
- Status is "done" and all tasks completed
- Recent activity (<5 min) and current task aligns with activity
- No concerning patterns

Only act on harnesses with real issues. If nothing needs attention,
write "All harnesses healthy" to the report and /quit.

## Rules

- **Only use Read, Edit, Glob, Grep tools.** Do NOT use Bash except for `date` or `report-issue`.
- **Never modify progress.json** — you observe and notify, you don't change task states.
- **Report issues you encounter** — If you hit permission errors, config problems, or discover bugs, run: `bash ~/.claude-ops/bin/report-issue.sh --title "..." --severity "..." --category "..." --description "..."`
- Write a brief summary to `claude_files/sweep-reports/reconcile-report.md` then `/quit`.

## IMPORTANT: Exit When Done
When finished, type `/quit` to exit. Do not wait for further input.

## Raw Data

HEADER

echo "### Current Time"
echo "$(now_iso)"
echo ""

# Git status summary
echo "### Git Status (uncommitted work)"
echo '```'
git -C "$PROJECT_ROOT" diff --stat 2>/dev/null | tail -5 || echo "(no git repo)"
echo '```'
echo ""

last_commit=$(git -C "$PROJECT_ROOT" log -1 --format="%ci — %s" 2>/dev/null || echo "unknown")
echo "**Last commit:** $last_commit"
echo ""

# Per-harness data
echo "### Active Harnesses"
echo ""

for progress_file in "$PROJECT_ROOT"/claude_files/*-progress.json; do
  [ -f "$progress_file" ] || continue
  status=$(jq -r '.status // "unknown"' "$progress_file" 2>/dev/null)
  [ "$status" != "active" ] && continue

  harness=$(jq -r '.harness // "unknown"' "$progress_file" 2>/dev/null)
  current=$(harness_current_task "$progress_file" 2>/dev/null || echo "unknown")
  done_count=$(harness_done_count "$progress_file" 2>/dev/null || echo "?")
  total_count=$(harness_total_count "$progress_file" 2>/dev/null || echo "?")
  mission=$(jq -r '.mission // ""' "$progress_file" 2>/dev/null)

  echo "#### $harness ($done_count/$total_count tasks)"
  echo "**Mission:** $mission"
  echo "**Current task:** $current"
  echo "**Progress file:** ${progress_file#"$PROJECT_ROOT/"}"
  echo ""

  # Task summary
  echo "Tasks:"
  echo '```json'
  jq -c '.tasks | to_entries[] | {id:.key, status:.value.status, desc:(.value.description // "")[:60]}' "$progress_file" 2>/dev/null || echo "{}"
  echo '```'
  echo ""

  # Activity log (last 10 events)
  activity_log="/tmp/claude_activity_${harness}.jsonl"
  if [ -f "$activity_log" ] && [ -s "$activity_log" ]; then
    event_count=$(wc -l < "$activity_log" | tr -d ' ')
    last_event=$(tail -1 "$activity_log" | jq -r '.ts // "unknown"' 2>/dev/null)
    echo "**Activity log:** $event_count events, last at $last_event"
    echo ""
    echo "Last 10 events:"
    echo '```json'
    tail -10 "$activity_log"
    echo '```'
  else
    echo "**Activity log:** (none — no /tmp/claude_activity_${harness}.jsonl found)"
  fi
  echo ""
  echo "---"
  echo ""
done

# Beads file (current wisps/claims)
BEADS="$PROJECT_ROOT/claude_files/harness-beads.json"
echo "### Current Beads State"
if [ -f "$BEADS" ]; then
  echo '```json'
  jq '.' "$BEADS" 2>/dev/null || echo "{}"
  echo '```'
else
  echo "(no beads file — create it at claude_files/harness-beads.json if you need to write wisps)"
  echo '```json'
  echo '{"wisps":[],"claims":{},"gates":{}}'
  echo '```'
fi

} > "$CONTEXT_FILE"

context_lines=$(wc -l < "$CONTEXT_FILE" | tr -d ' ')

# ── Check mode ───────────────────────────────────────────────────
if [ "$MODE" = "check" ]; then
  echo "Context file: $CONTEXT_FILE ($context_lines lines)"
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "check" --argjson context_lines "$context_lines" \
    '{ts:$ts, type:$type, name:$name, action:$action, context_lines:$context_lines}'
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# PHASE 2: Spawn Claude agent
# ══════════════════════════════════════════════════════════════════

PANE=$(spawn_sweep_agent "$SWEEP_NAME" "$PROJECT_ROOT" "$CONTEXT_FILE")

if [ -z "$PANE" ]; then
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "agent_fail" --arg reason "spawn_sweep_agent returned empty" \
    '{ts:$ts, type:$type, name:$name, action:$action, reason:$reason}'
  exit 0
fi

jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
  --arg action "agent_spawned" --arg pane "$PANE" \
  '{ts:$ts, type:$type, name:$name, action:$action, pane:$pane}'
