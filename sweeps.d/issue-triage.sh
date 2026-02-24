#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# issue-triage.sh — Triage agent-reported issues
# ══════════════════════════════════════════════════════════════════
# Architecture: bash gathers open issues + context, Claude agent
# triages each issue (auto-fix, defer, or mark stale/duplicate).
#
# Contract:
#   --interval            Print interval (900s) and exit
#   --check               Gather context only, print what agent would see
#   --run                 Gather context + spawn agent
#   --project <path>      Target a specific project root
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SWEEP_NAME="issue-triage"
source "$HOME/.claude-ops/lib/sweep-config.sh"
load_sweep_config "$SWEEP_NAME"

CONF="${HOME}/.claude-ops/control-plane.conf"
CONTEXT_FILE="/tmp/harness_sweep_issue_triage_context.md"

# ── Load control-plane config ──────────────────────────────────
if [ -f "$CONF" ]; then
  source "$CONF"
fi

# ── Shared infrastructure ────────────────────────────────────────
source "${HOME}/.claude-ops/lib/spawn-sweep-agent.sh"

# ── Helpers ──────────────────────────────────────────────────────
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── CLI parsing ──────────────────────────────────────────────────
MODE=""
PROJECT_ROOT_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) echo "$SWEEP_INTERVAL"; exit 0 ;;
    --scope)    echo "$SWEEP_SCOPE"; exit 0 ;;
    --check)    MODE="check"; shift ;;
    --run)      MODE="run"; shift ;;
    --project)  PROJECT_ROOT_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$MODE" ] && { echo "Usage: $0 [--interval|--check|--run] [--project <path>]" >&2; exit 1; }

source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true
if [ -n "$PROJECT_ROOT_ARG" ]; then
  PROJECT_ROOT="$PROJECT_ROOT_ARG"
else
  PROJECT_ROOT="${PROJECT_ROOT:-}"
fi
[ -z "$PROJECT_ROOT" ] && { echo "ERROR: No project root." >&2; exit 1; }

# ── Locate issues file ────────────────────────────────────────
ISSUES_FILE="$PROJECT_ROOT/claude_files/agent-issues.jsonl"
if [ ! -f "$ISSUES_FILE" ]; then
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "skip" --arg reason "no issues file" \
    '{ts:$ts, type:$type, name:$name, action:$action, reason:$reason}'
  exit 0
fi

# ── Count open issues ─────────────────────────────────────────
open_count=$(grep -c '"status":"open"' "$ISSUES_FILE" 2>/dev/null || true)
open_count="${open_count//[[:space:]]/}"
[ -z "$open_count" ] && open_count=0

if [ "$open_count" -eq 0 ]; then
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "skip" --arg reason "no open issues" \
    '{ts:$ts, type:$type, name:$name, action:$action, reason:$reason}'
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# PHASE 1: Gather context
# ══════════════════════════════════════════════════════════════════

{
cat <<'HEADER'
# Issue Triage Sweep — Context for Agent

You are an ISSUE TRIAGE agent. Agents in the system have reported problems via `report-issue`. Your job is to triage each open issue.

## Your Mission

For each open issue below, decide ONE of these actions:

### 1. Auto-fix (immediate bugs in config/permissions/templates)
If you can fix the issue directly:
- Fix the root cause (edit the config file, fix the permission pattern, etc.)
- Update the issue status to `"resolved"` in agent-issues.jsonl with a `resolution` description
- Example: "Permission pattern wrong in sweep config" -> edit the JSON file

### 2. Defer to Warren (design choices, ambiguous, risky)
If the issue needs a human decision:
- Run `notify "Issue: <title> — <one-line summary of what needs deciding>"` to alert Warren
- Update the issue status to `"deferred"` in agent-issues.jsonl
- Example: "Should monitors use opus or sonnet?" -> notify Warren

### 3. Mark as duplicate/stale
If the issue is already fixed or a repeat:
- Update the issue status to `"duplicate"` or `"stale"` in agent-issues.jsonl with a resolution note

## Rules

- **Only auto-fix issues in `~/.claude-ops/` (infrastructure) or `claude_files/` (harness state)**
- **NEVER auto-fix issues in source code (`src/`)**
- **NEVER auto-fix security-related issues**
- **For `suggestion` category: ALWAYS defer** (suggestions are ideas, not bugs)
- **For `critical` severity: ALWAYS notify immediately** (even if auto-fixable, Warren should know)
- **Be conservative.** If unsure whether a fix is safe, defer.

## How to Update Issues

The issues file is JSONL (one JSON object per line). To update an issue's status:
1. Read the file
2. Find the line with matching `id`
3. Use Edit to replace that line with the updated JSON (change `status` and add `resolution`)

## How to Notify Warren

```bash
notify "Issue: <title> — <summary>"
```

## IMPORTANT: Exit When Done

When finished triaging all issues, type `/quit` to exit. Do not wait for further input.

## Open Issues

HEADER

# ── Dump all open issues ──────────────────────────────────────
echo '```jsonl'
grep '"status":"open"' "$ISSUES_FILE" 2>/dev/null || true
echo '```'
echo ""

# ── Recent activity logs for context ──────────────────────────
echo "## Recent Agent Activity (last 20 events per harness)"
echo ""
for activity_log in /tmp/claude_activity_*.jsonl; do
  [ -f "$activity_log" ] || continue
  harness_slug=$(basename "$activity_log" .jsonl | sed 's/claude_activity_//')
  echo "### $harness_slug"
  echo '```jsonl'
  tail -20 "$activity_log" 2>/dev/null || echo "(empty)"
  echo '```'
  echo ""
done

# ── Current harness states ────────────────────────────────────
echo "## Active Harness States"
echo ""
for progress_file in "$PROJECT_ROOT"/claude_files/*-progress.json; do
  [ -f "$progress_file" ] || continue
  harness_name=$(jq -r '.harness // empty' "$progress_file" 2>/dev/null)
  [ -z "$harness_name" ] && continue
  harness_status=$(jq -r '.status // "unknown"' "$progress_file" 2>/dev/null)
  [ "$harness_status" != "active" ] && continue

  echo "### $harness_name ($harness_status)"
  echo '```json'
  jq '{harness, mission, status, tasks: (.tasks | to_entries | map({key: .key, status: .value.status}) | from_entries)}' "$progress_file" 2>/dev/null || echo "{}"
  echo '```'
  echo ""
done

# ── Infrastructure file listing for context ───────────────────
echo "## Infrastructure Files (for reference when fixing)"
echo ""
echo "### Sweep Permissions"
echo '```'
ls "$HOME/.claude-ops/sweeps.d/permissions/" 2>/dev/null || echo "(none)"
echo '```'
echo ""
echo "### Checks.d Scripts"
echo '```'
ls "$HOME/.claude-ops/hooks/operators/checks.d/" 2>/dev/null || echo "(none)"
echo '```'
echo ""

# ── Previously resolved issues (for duplicate detection) ──────
resolved_count=$(grep -cE '"status":"(resolved|duplicate|stale|deferred)"' "$ISSUES_FILE" 2>/dev/null || true)
resolved_count="${resolved_count//[[:space:]]/}"
[ -z "$resolved_count" ] && resolved_count=0
if [ "$resolved_count" -gt 0 ]; then
  echo "## Previously Resolved Issues (last 10, for duplicate detection)"
  echo ""
  echo '```jsonl'
  grep -E '"status":"(resolved|duplicate|stale|deferred)"' "$ISSUES_FILE" 2>/dev/null | tail -10
  echo '```'
  echo ""
fi

} > "$CONTEXT_FILE"

context_lines=$(wc -l < "$CONTEXT_FILE" | tr -d ' ')

# ── Check mode: just show the context ────────────────────────────
if [ "$MODE" = "check" ]; then
  echo "Context file: $CONTEXT_FILE ($context_lines lines, $open_count open issues)"
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "check" --argjson context_lines "$context_lines" \
    --argjson open_issues "$open_count" \
    '{ts:$ts, type:$type, name:$name, action:$action, context_lines:$context_lines, open_issues:$open_issues}'
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# PHASE 2: Spawn Claude agent
# ══════════════════════════════════════════════════════════════════

notify "Issue-triage sweep: $open_count open issue(s) to triage" 2>/dev/null || true

PANE=$(spawn_sweep_agent "$SWEEP_NAME" "$PROJECT_ROOT" "$CONTEXT_FILE")

if [ -z "$PANE" ]; then
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "agent_fail" --arg reason "spawn_sweep_agent returned empty" \
    '{ts:$ts, type:$type, name:$name, action:$action, reason:$reason}'
  exit 0
fi

jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
  --arg action "agent_spawned" --arg pane "$PANE" \
  --argjson context_lines "$context_lines" \
  --argjson open_issues "$open_count" \
  '{ts:$ts, type:$type, name:$name, action:$action, pane:$pane, context_lines:$context_lines, open_issues:$open_issues}'
